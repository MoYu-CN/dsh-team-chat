/**
 * 「AI 成员」运行时 —— 成员 = 一个**独立的顶层会话**。
 *
 * ## 为什么不用官方 Agent Teams
 *
 * 官方协议下 teammate **必须**是 Lead 的子会话（`tryMembership()` 只认有
 * `parentSession` 的 agent），而官方侧栏的 `sessionVisible()` 第一行就是
 * `if (session.origin === "subagent") return false;` ——
 * **子会话按设计永远不进左侧栏工作区树**。
 *
 * 结果：用户看得见成员、却删不掉、管不了。
 * 用户 2026-09-27 拍板原话：
 * 「添加的新成员是单独再开一个对话……**对话我随时可以删掉，但子智能体我无法管理**。」
 *
 * 所以这里改成：成员 = 我们自己起的一个**顶层根会话**，
 * 它就是一个普通对话 —— 能在左栏看到、能打开、随时能删。
 *
 * ## 三个原语（都是官方公开面，实测跑通过）
 *
 * ```js
 * // ① 建/恢复一个 live 的**根** agent（presetId 可指定「模式」）
 * await ctx.sessionController.agents.ensureSession(`session-${randomUUID()}`, cwd, true, presetId);
 * // ② 挂到工作区 —— 不挂的话它落在左栏的「未分组」里
 * const ws = ctx.workspaceRegistry.list().find((w) => w.path === cwd);
 * await ws.attachSession(sessionId);
 * // ③ 投消息并唤醒它
 * agent.steer({ id: randomUUID(), role: "user", content: [{ type: "text", text }], source });
 * ```
 *
 * ⚠ `agent.steer()` 是官方多个插件（`dsh-cordis-host-runner` / `dsh-plan-mode` /
 * `dsh-hooks-*`）往 live agent 投消息的通用姿势。
 *
 * ⚠ **不 import `createUserMessage`**：`@deepseek-ai/dsh-llm` 从插件目录
 * **解析不到**（`link:` 安装不带上游 node_modules，实测 MODULE_NOT_FOUND）。
 * 而它本体就是 `deepFreeze(structuredClone({...input, id: randomUUID()}))` ——
 * 手搓一个同形状的对象即可。见 `userMessage()`。
 */

import { randomUUID } from "node:crypto";

/** 创建成员时那条首条消息的 `source.kind`。 */
export const MEMBER_INIT_SOURCE = "team-chat-member-init";

/** 「发送到团队」投递出去的每条消息的 `source.kind`。 */
export const MEMBER_DELIVERY_SOURCE = "team-chat-message";

/**
 * 「交替上岗」那条开场消息的 `source.kind`。
 *
 * 与 `MEMBER_INIT_SOURCE` 分开，是为了在会话日志里能区分
 * 「一个新成员到岗」和「同一个成员换了一任」——排查交接问题时
 * 一眼看出这条消息是谁、为什么投进去的。
 */
export const MEMBER_SUCCESSOR_SOURCE = "team-chat-member-successor";

/**
 * 新会话 id。
 *
 * 形状必须与官方一致（`session-<uuid>`）—— 官方按这个前缀区分根会话与子会话，
 * 左栏的会话目录名也是它。
 *
 * @returns 新的根会话 id。
 */
export function newSessionId() {
  return `session-${randomUUID()}`;
}

/**
 * 手搓一条 user 消息。
 *
 * 等价于官方 `createUserMessage({content, source})`（= `createMessage` 加 `role:"user"`），
 * 照抄形状是为了不依赖 `@deepseek-ai/dsh-llm`（见文件头注释）。
 *
 * @param text - 正文。
 * @param source - 来源标记（`{kind, ...}`）。
 * @returns 可直接交给 `agent.steer()` 的消息对象。
 */
export function userMessage(text, source) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source,
  };
}

/**
 * 取运行时要用的宿主服务。
 *
 * 全部走 `ctx.get()` 软探测 —— 服务缺失时给出可读错误，
 * 而不是让 `ctx.xxx` 访问未 inject 的服务直接抛。
 *
 * @param ctx - 宿主上下文。
 * @returns `{agents, controller, registry, titles}`，缺哪个是 null。
 */
export function runtimeServices(ctx) {
  return {
    agents: ctx.get?.("agents") ?? null,
    controller: ctx.get?.("sessionController") ?? null,
    registry: ctx.get?.("workspaceRegistry") ?? null,
    titles: ctx.get?.("sessionTitle") ?? null,
  };
}

/**
 * 找到某个工作目录对应的工作区实体。
 *
 * ⚠ 找不到时**不算失败** —— 只是那个会话会落在左栏的「未分组」里。
 *
 * @param registry - workspaceRegistry 服务（可 null）。
 * @param cwd - 工作目录。
 * @returns 工作区实体或 null。
 */
export function findWorkspace(registry, cwd) {
  if (registry === null || typeof registry.list !== "function") return null;
  const wanted = String(cwd ?? "").toLowerCase();
  if (wanted === "") return null;
  let list = [];
  try {
    list = registry.list() ?? [];
  } catch {
    return null;
  }
  return list.find((row) => String(row?.path ?? "").toLowerCase() === wanted) ?? null;
}

/**
 * 把一个会话挂到它 cwd 对应的工作区（否则它会落在左栏的「未分组」里）。
 *
 * **失败不算致命**：成员会话建出来了、消息也投得进去，只是分组不对。
 * 所以这里只记一行日志、返回 false，让调用方如实告诉用户。
 *
 * @param ctx - 宿主上下文。
 * @param cwd - 工作目录。
 * @param sessionId - 要挂的会话 id。
 * @returns 是否真的挂上了。
 */
export async function attachWorkspace(ctx, cwd, sessionId) {
  try {
    const workspace = findWorkspace(runtimeServices(ctx).registry, cwd);
    if (workspace === null || typeof workspace.attachSession !== "function") return false;
    await workspace.attachSession(sessionId);
    return true;
  } catch (error) {
    ctx.logger?.warn?.(`team-chat: 会话 ${sessionId} 挂工作区失败: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * 这条成员资料记录的那些**旧会话**（被交替掉的）。
 *
 * ⚠ **判据是「不等于当前 `sessionId`」**，不是「在不在这个列表里。」
 *   列表只有 20 个位置，挤出界面之外的旧会话仍然是旧会话 ——
 *   拿它当判据的话，挤出列表那天旧会话就会重新开始收消息。
 *
 * @param member - 成员资料记录。
 * @returns 已归档的会话 id 集合。
 */
export function archivedSessionIds(member) {
  const out = new Set();
  const rows = Array.isArray(member?.archivedSessions) ? member.archivedSessions : [];
  for (const row of rows) {
    if (typeof row?.sessionId === "string" && row.sessionId !== "") out.add(row.sessionId);
  }
  return out;
}

/**
 * 拿会话对应的 live agent；**已归档的旧会话不叫醒、也拿不到**。
 *
 * ## 为什么必须在运行时就拦住（而不是只靠成员资料里的指向）
 *
 * 交替之后，旧会话**还在**（归档 ≠ 删除，右侧栏里随时能打开看历史）。
 * 它已经有一个「已归档」标记，但那只是一个标记 —— 真正决定
 * 「这条会话还代不代表这个成员」的是成员资料里的 `sessionId` 指向。
 *
 * 两处都要拦：
 * 1. 指向（`sessionId` 只指新会话）—— 正常路径走这里，旧会话根本不会被枚举到；
 * 2. 运行时（本函数）—— 交给我们的成员对象可能是**交替之前**取到的快照
 *    （投递范围、信箱轮询都可能拿着旧快照跨过交替那一瞬间），
 *    只靠指向的话，那一瞬间的消息仍然会投进旧会话，
 *    于是**两个会话同时代表同一个身份**。
 *
 * @param ctx - 宿主上下文。
 * @param member - 成员记录（需要 `sessionId` / `cwd` / `preset`）。
 * @returns `{ok, agent?, code?, error?}`。
 */
export async function memberAgent(ctx, member) {
  const services = runtimeServices(ctx);
  const sessionId = typeof member?.sessionId === "string" ? member.sessionId : "";
  if (sessionId === "") {
    return { ok: false, code: "MEMBER_NO_SESSION", error: "这个成员还没有属于它的会话。" };
  }
  // ⚠ 先看**归档记录的名单**，再看指向 —— 见上面注释第 2 条。
  if (archivedSessionIds(member).has(sessionId)) {
    return {
      ok: false,
      code: "MEMBER_SESSION_ARCHIVED",
      error: `会话 ${sessionId} 已被交替归档，不再接收新消息。`,
    };
  }
  if (services.agents === null || services.controller === null) {
    return { ok: false, code: "MEMBER_RUNTIME_UNAVAILABLE", error: "宿主缺少 agents / sessionController 服务。" };
  }

  const existing = services.agents.get?.(sessionId);
  if (existing !== undefined) return { ok: true, agent: existing };

  const cwd = typeof member.cwd === "string" && member.cwd !== "" ? member.cwd : undefined;
  try {
    await services.controller.agents.ensureSession(
      sessionId,
      cwd,
      true,
      typeof member.preset === "string" && member.preset !== "" ? member.preset : undefined,
    );
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === "string" ? error.code : "MEMBER_RESUME_FAILED",
      error: `恢复成员会话失败：${error?.message ?? String(error)}`,
    };
  }
  const resumed = services.agents.get?.(sessionId);
  if (resumed === undefined) {
    return { ok: false, code: "MEMBER_SESSION_NOT_LIVE", error: `成员会话 ${sessionId} 没能恢复成活动会话。` };
  }
  return { ok: true, agent: resumed };
}

/**
 * 建一个 AI 成员 —— **独立开一个对话**。
 *
 * 步骤（顺序不能换）：
 * 1. `ensureSession` 起一个 live 的**根** agent（带模式）
 * 2. `attachSession` 挂到 cwd 对应的工作区（否则落「未分组」）
 * 3. 把会话标题改成成员的显示名（左栏那一行显示的就是标题）
 * 4. 身份写进 MemberStore（**必须在投消息之前** —— 投递会用到它）
 * 5. `steer` 首条消息，把职责 / 专属指令发过去
 *
 * @param ctx - 宿主上下文。
 * @param store - MemberStore 实例。
 * @param input - `{name, displayName, duty, instructions, avatar, preset, cwd, prompt}`。
 * @returns `{ok, sessionId?, member?, code?, error?}`。
 */
export async function createMember(ctx, store, input) {
  const services = runtimeServices(ctx);
  if (services.agents === null || services.controller === null) {
    return { ok: false, code: "MEMBER_RUNTIME_UNAVAILABLE", error: "宿主缺少 agents / sessionController 服务。" };
  }

  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  if (cwd === "") {
    return { ok: false, code: "MEMBER_NO_CWD", error: "缺少工作目录：成员会话必须挂在一个工作区里。" };
  }

  const sessionId = newSessionId();
  const preset = typeof input.preset === "string" && input.preset !== "" ? input.preset : undefined;

  // ① 起会话
  try {
    await services.controller.agents.ensureSession(sessionId, cwd, true, preset);
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === "string" ? error.code : "MEMBER_CREATE_FAILED",
      error: `创建会话失败：${error?.message ?? String(error)}`,
    };
  }
  const agent = services.agents.get?.(sessionId);
  if (agent === undefined) {
    return {
      ok: false,
      code: "MEMBER_SESSION_NOT_LIVE",
      error: `会话 ${sessionId} 已登记，但没能变成活动会话。`,
    };
  }

  // ② 挂工作区。失败不算致命（只是会落「未分组」），但要说出来。
  const attached = await attachWorkspace(ctx, cwd, sessionId);

  // ③ 标题 = 显示名（左栏那行显示的就是它；没标题时官方会回退成文件夹名）
  //
  // `force: true` —— 这是我们自己建的会话，成员名就是它的身份，
  // 不该被官方那个「从首条消息截一段」的自动标题盖住。
  await renameTitle(ctx, sessionId, input.displayName, input.name, true);

  // ④ 身份落库。**必须在 steer 之前** —— 投递与时间线都按会话 id 查这条记录。
  const saved = await store.set(input.name, {
    displayName: input.displayName,
    duty: input.duty,
    instructions: input.instructions,
    ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
    sessionId,
    cwd,
    preset: preset ?? "",
    ...(typeof input.roomSessionId === "string" && input.roomSessionId !== ""
      ? { roomSessionId: input.roomSessionId }
      : {}),
    // 房间归属 = 工作区目录（见 member-store 里 roomCwd 的说明）
    ...(typeof input.roomCwd === "string" && input.roomCwd !== ""
      ? { roomCwd: input.roomCwd }
      : {}),
  });
  if (!saved.ok) {
    return { ok: false, code: "MEMBER_STORE_FAILED", error: `成员资料保存失败：${saved.error}`, sessionId };
  }

  // ⑤ 首条消息
  let steered = false;
  if (typeof input.prompt === "string" && input.prompt !== "" && typeof agent.steer === "function") {
    try {
      agent.steer(userMessage(input.prompt, { kind: MEMBER_INIT_SOURCE, member: input.name }));
      steered = true;
    } catch (error) {
      return {
        ok: false,
        code: "MEMBER_PROMPT_FAILED",
        sessionId,
        error: `会话已建好，但首条消息没投出去：${error?.message ?? String(error)}`,
      };
    }
  }

  return { ok: true, sessionId, attached, steered, member: saved.member };
}

/**
 * **收编**：把用户**已打开的对话窗口**注册为 AI 成员（不再新开会话）。
 *
 * 与 `createMember` 的根本区别：
 * - 不 `ensureSession` —— 会话**本来就在**（玩家自己开的、聊了半天的那个）。
 * - 保留原有对话内容，**叠加**一层成员身份：它从此能收到任务、向主智能体汇报。
 * - 管理权**部分归主智能体**：主智能体可通过团队信箱给它派活；
 *   会话本体仍是玩家的普通对话（左栏可见、可删）—— 这正是用户要的可管理性。
 *
 * 步骤（顺序不能换）：
 * 1. 校验目标会话**真实存在且是根会话**（子会话不收 —— 那是别人的子智能体，
 *    收编它会让两个系统抢着管同一个 agent）。
 * 2. 把它叫醒（`memberAgent`）拿到 live agent —— 收编确认消息要能立刻投进去。
 * 3. 身份落库（**必须在 steer 之前**：投递与时间线都按会话 id 查这条记录）。
 * 4. 发一条「收编确认」消息：你被收编为成员 X、职责是 Y、以及团队信箱协议
 *    （`buildMemberPrompt` 生成，与新建成员同一套措辞）。
 *
 * ⚠ 会话标题**不动**：那是玩家自己聊出来的会话，它的名字可能正被玩家用着。
 *    成员名只影响聊天室名单与面包屑，不去覆盖左栏那个会话标题。
 *
 * @param ctx - 宿主上下文。
 * @param store - MemberStore 实例。
 * @param input - `{name, displayName, duty, instructions, avatar, sessionId, cwd, roomSessionId, prompt}`。
 * @returns `{ok, sessionId?, member?, code?, error?}`。
 */
export async function adoptMember(ctx, store, input) {
  const services = runtimeServices(ctx);
  if (services.agents === null || services.controller === null) {
    return { ok: false, code: "MEMBER_RUNTIME_UNAVAILABLE", error: "宿主缺少 agents / sessionController 服务。" };
  }

  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  if (sessionId === "") {
    return { ok: false, code: "MEMBER_NO_SESSION", error: "缺少要收编的会话 id。" };
  }

  // ① 必须是真实存在的**根会话**。
  const session =
    ctx.get?.("sessions")?.get?.(sessionId) ?? services.agents.get?.(sessionId)?.session ?? null;
  if (session === null || session === undefined) {
    return { ok: false, code: "MEMBER_TARGET_NOT_FOUND", error: `找不到会话 ${sessionId}。` };
  }
  if (session.header?.parentSession !== undefined) {
    return {
      ok: false,
      code: "MEMBER_TARGET_IS_SUBAGENT",
      error: "这个会话是别人的子智能体，不能被收编成成员。",
    };
  }

  const cwd =
    typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : session.header?.cwd ?? "";

  // ② 叫醒它（拿不到 live agent 就没法投收编确认）。
  const woken = await memberAgent(ctx, {
    sessionId,
    cwd,
    preset: typeof input.preset === "string" ? input.preset : "",
  });
  if (!woken.ok) {
    return { ok: false, code: woken.code, error: `收编前没能把这个会话叫醒：${woken.error}` };
  }

  // ③ 身份落库（**必须在 steer 之前**）。
  const saved = await store.set(input.name, {
    displayName: input.displayName,
    duty: input.duty,
    instructions: input.instructions,
    ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
    sessionId,
    cwd,
    preset: typeof input.preset === "string" ? input.preset : "",
    ...(typeof input.roomSessionId === "string" && input.roomSessionId !== ""
      ? { roomSessionId: input.roomSessionId }
      : {}),
    // 房间归属 = 工作区目录（见 member-store 里 roomCwd 的说明）
    ...(typeof input.roomCwd === "string" && input.roomCwd !== ""
      ? { roomCwd: input.roomCwd }
      : {}),
  });
  if (!saved.ok) {
    return { ok: false, code: "MEMBER_STORE_FAILED", error: `成员资料保存失败：${saved.error}`, sessionId };
  }

  // ④ 收编确认消息（职责 + 团队信箱协议）。
  let steered = false;
  if (typeof input.prompt === "string" && input.prompt !== "" && typeof woken.agent.steer === "function") {
    try {
      woken.agent.steer(userMessage(input.prompt, { kind: MEMBER_INIT_SOURCE, member: input.name }));
      steered = true;
    } catch (error) {
      return {
        ok: false,
        code: "MEMBER_PROMPT_FAILED",
        sessionId,
        error: `身份已登记，但收编确认消息没投出去：${error?.message ?? String(error)}`,
      };
    }
  }

  return { ok: true, sessionId, steered, member: saved.member };
}

/**
 * 把成员会话的标题改成它的显示名。
 *
 * ⚠ 只改**我们自己建的那些**会话。调用方负责保证 `sessionId` 是成员的。
 * ⚠ 用户手动改过的标题不许覆盖 —— 与 `index.js` 里那条规矩一致。
 *
 * @param ctx - 宿主上下文。
 * @param sessionId - 会话 id。
 * @param displayName - 想用的标题。
 * @param fallback - 没有显示名时的回退（成员名）。
 * @param force - true = 连「有人手动改过」的标题也盖掉。
 *   ⚠ 默认 false。而**我们自己**设的标题写进去也是 `source.kind === "user"`，
 *   所以在自己这条链路上，改显示名之后想同步标题**必须**显式传 force。
 * @returns 是否改了。
 */
export async function renameTitle(ctx, sessionId, displayName, fallback, force = false) {
  const { agents, titles } = runtimeServices(ctx);
  if (titles === null || typeof titles.rename !== "function") return false;
  const wanted = typeof displayName === "string" && displayName.trim() !== "" ? displayName.trim() : fallback;
  if (typeof wanted !== "string" || wanted === "") return false;

  const agent = agents?.get?.(sessionId);
  const session = agent?.session ?? ctx.get?.("sessions")?.get?.(sessionId);
  if (session === undefined || session === null) return false;

  // 没让强制覆盖时，尊重手动改过的标题。
  if (!force) {
    try {
      const snapshot = titles.get?.(session);
      if (snapshot?.source?.kind === "user") return false;
      if (snapshot?.title === wanted) return false;
    } catch {
      /* 读不到快照就按「没改过」处理 */
    }
  } else {
    // 强制时也跳过「已经是目标值」的情况 —— `rename` 每次都写一条事件，
    // 无脑重复写会把会话日志刷爆。
    try {
      if (titles.get?.(session)?.title === wanted) return false;
    } catch {
      /* 读不到就照改 */
    }
  }

  try {
    await titles.rename(session, wanted);
    return true;
  } catch (error) {
    ctx.logger?.warn?.(`team-chat: 成员会话 ${sessionId} 改标题失败: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * 把一条消息投给一个成员。
 *
 * @param ctx - 宿主上下文。
 * @param member - 成员记录。
 * @param text - 正文。
 * @param senderName - 发送者显示名（写进 `source`，供成员侧识别来源）。
 * @returns `{ok, code?, error?}`。
 */
export async function deliverToMember(ctx, member, text, senderName = "lead") {
  const found = await memberAgent(ctx, member);
  if (!found.ok) return { ok: false, code: found.code, error: found.error };
  if (typeof found.agent.steer !== "function") {
    return { ok: false, code: "MEMBER_NOT_STEERABLE", error: "这个会话的 agent 不接受投递。" };
  }
  try {
    found.agent.steer(
      userMessage(text, {
        kind: MEMBER_DELIVERY_SOURCE,
        sender: senderName,
        member: member.key,
      }),
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === "string" ? error.code : "MEMBER_DELIVER_FAILED",
      error: error?.message ?? String(error),
    };
  }
}
