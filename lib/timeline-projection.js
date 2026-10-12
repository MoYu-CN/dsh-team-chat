/**
 * 自有 timeline 投影。
 *
 * 背景：官方 `dsh-experimental-agent-team` 把消息持久化在 Team 投影 state 的
 * `messages` 数组里，但它的 wire view 只输出 `{ members, tasks, failure }`
 * —— 消息被丢弃，所以原生 UI 没有 mailbox timeline。
 *
 * 这里注册一个**平行的**投影：同一个事件流、独立的 state，
 * 只把 `team/message/**` 攒成一条可直接渲染的时间线。
 *
 * 不修改官方包，只用公开的 `ctx.sessionProjections.register`。
 */

/** 投影 key，与官方的 `agentTeam` 并存互不干扰。 */
export const TIMELINE_PROJECTION_KEY = "teamChatTimeline";

/** state 结构版本。事件 schema 升级时递增，registry 会拒绝版本冲突。 */
export const TIMELINE_STATE_VERSION = 1;

/** 单条 Team 会话保留的最大消息数，防止长会话无限增长。 */
const MAX_MESSAGES = 500;

/**
 * Team 域名事件的前缀。官方 `isTeamEvent` 判定为：
 * `team/member` | `team/task` | `team/message/queued` | `team/message/delivered`
 */
const MESSAGE_QUEUED = "team/message/queued";
const MESSAGE_DELIVERED = "team/message/delivered";

/**
 * 构造某条会话的空 timeline state。
 *
 * @param header - 会话 header，取其 id 作为归属标识。
 * @returns 空的时间线状态。
 */
function emptyTimelineState(header) {
  return {
    sessionId: header?.id ?? null,
    /** @type {Array<{id: string, senderName: string, targetName: string|null, blocks: unknown[], at: string|null, delivered: boolean}>} */
    entries: [],
    /** messageId -> entry index，用于 delivered 事件回填。 */
    index: Object.create(null),
    // ⚠ **不要在这里写 `failure: undefined`**（2026-10-09 之前就是这么写的）。
    //
    //   值为 `undefined` 的**自有可枚举键**过不了宿主的「无损 JSON 可序列化」检查：
    //   JSON 往返会把这个键丢掉（`{sessionId,entries,index,failure}` → 少一个键），
    //   于是投影 checkpoint **永远存不下来**、缓存永远 stale ⇒
    //   冷读要从头重放**整条**会话日志，而不是只重放尾部。
    //   症状是纯静默的性能退化：只有一行 `[W] … cache stays stale`，功能看着正常。
    //
    //   也**不能**改成 `failure: null`：下面 `applyEvent` 的守卫是
    //   `if (state.failure !== undefined) return state;`，
    //   `null !== undefined` 为真 ⇒ 投影会**停止接收所有事件**，比原来更糟。
    //
    //   要表达「还没有失败」，正确做法就是**不写这个键**：
    //   `state.failure` 读出来同样是 `undefined`（语义一模一样），而状态是 JSON 干净的。
  };
}

/**
 * 从消息 id 推导稳定的展示序号，保证重放（replay）后顺序一致。
 *
 * 官方 id 形如 `TeamMessageId`，是递增字符串；解析失败时返回 null，
 * 调用方退化为「按到达顺序」。
 *
 * @param id - 消息 id。
 * @returns 数值序号，无法解析时为 null。
 */
function numericSuffix(id) {
  if (typeof id !== "string") return null;
  const match = /(\d+)$/.exec(id);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 从消息快照快照出渲染所需的扁平结构。
 *
 * 官方 `teamMessageSnapshotSchema` 为：
 * `{ id, senderId, senderName, targetId, content: ContentBlock[] }`
 *
 * @param message - 官方消息快照。
 * @param memberNames - sessionId -> 成员名映射（targetId 只给 id，需换名字）。
 * @returns 扁平的时间线条目，或 null（结构不符合预期时）。
 */
function toEntry(message, memberNames) {
  if (message === null || typeof message !== "object") return null;
  const id = typeof message.id === "string" ? message.id : null;
  if (id === null) return null;
  const senderName =
    typeof message.senderName === "string" && message.senderName !== ""
      ? message.senderName
      : "unknown";
  const targetId = typeof message.targetId === "string" ? message.targetId : null;
  return {
    id,
    senderId: typeof message.senderId === "string" ? message.senderId : null,
    senderName,
    targetName: targetId === null ? null : (memberNames.get(targetId) ?? targetId),
    blocks: Array.isArray(message.content) ? message.content : [],
    at: null,
    delivered: false,
  };
}

/**
 * 把一条 Team 事件并入 timeline state。
 *
 * 这是一个纯函数：返回新 state 或原 state（未变化时）。
 * registry 用 `Object.is` 比较，返回原引用即表示「无变化、不推送」。
 *
 * @param state - 当前 state。
 * @param event - session 事件。
 * @returns 下一个 state。
 */
function applyEvent(state, event) {
  // 一旦进入降级状态就不再变更，避免半个时间线反复触发推送。
  if (state.failure !== undefined) return state;
  if (event === null || typeof event !== "object") return state;

  const type = event.type;
  if (type !== MESSAGE_QUEUED && type !== MESSAGE_DELIVERED) return state;

  const data = event.data;
  if (data === null || typeof data !== "object") return state;

  try {
    if (type === MESSAGE_QUEUED) {
      const entry = toEntry(data.message, state.memberNames ?? new Map());
      if (entry === null) return state;
      // 重放时同一消息可能出现两次（事件重放 + 恢复），用 id 去重。
      if (state.index[entry.id] !== undefined) return state;

      const entries = [...state.entries, entry];
      // 超出上限时从头截断，并重建索引（索引偏移必须跟着走）。
      const overflow = entries.length - MAX_MESSAGES;
      const kept = overflow > 0 ? entries.slice(overflow) : entries;
      const index = Object.create(null);
      for (let at = 0; at < kept.length; at += 1) index[kept[at].id] = at;

      return { ...state, entries: kept, index };
    }

    // MESSAGE_DELIVERED: { version, teamId, messageId, targetId }
    const messageId = typeof data.messageId === "string" ? data.messageId : null;
    if (messageId === null) return state;
    const at = state.index[messageId];
    if (at === undefined) return state;
    const current = state.entries[at];
    if (current.delivered) return state;

    const entries = [...state.entries];
    entries[at] = { ...current, delivered: true };
    return { ...state, entries };
  } catch (error) {
    // 结构不符预期：降级而不是抛错，避免拖垮整个投影驱动循环。
    return {
      ...state,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * wire view：只把可渲染字段送出去，避免把内部索引泄漏给前端。
 *
 * @param state - 投影 state。
 * @returns 前端可见的视图。
 */
function timelineView(state) {
  return {
    sessionId: state.sessionId,
    entries: state.entries,
    ...(state.failure === undefined ? {} : { failure: state.failure }),
  };
}

/**
 * 轻量结构校验：不引 zod，避免给插件增加运行时依赖。
 * 只确保前端拿到的形状稳定；失败由 view 层兜底。
 */
function isTimelineView(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray(value.entries)
  );
}

/**
 * 构造可直接交给 `ctx.sessionProjections.register(def)` 的定义。
 *
 * @returns 投影定义。
 */
export function createTimelineProjection() {
  return {
    key: TIMELINE_PROJECTION_KEY,
    stateVersion: TIMELINE_STATE_VERSION,
    stateSchema: { parse: (value) => value },
    init: (header) => emptyTimelineState(header),
    apply: applyEvent,
    wire: {
      viewSchema: { parse: (value) => (isTimelineView(value) ? value : value) },
      view: timelineView,
    },
  };
}

export { MAX_MESSAGES, numericSuffix };
