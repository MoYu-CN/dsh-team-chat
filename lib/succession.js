/**
 * 成员「交替」（交接 / succession）。
 *
 * ## 这个功能解决什么
 *
 * 一个 AI 成员聊久了，它那个会话的上下文会越来越长 —— 又慢又贵，
 * 而且早期的细节还在不停地占位置。用户要的是：
 *
 * > 「我想要换一个会话……我希望我这个会话的一些提示词还有一些东西
 * >   能够继承到下一个新的会话里面，它的这个 AI 成员的身份也继承到下一个会话里面。
 * >   **我们需要让被继承的 AI 自己写一份交接说明给下一个会话里面的 AI 智能体，
 * >   并且将身份移交给它。**」
 *
 * 所以「交替」= 三件事，缺一不可：
 *
 * 1. **旧会话里的那个 AI 自己写一份交接说明**（提炼过，不是原文倒出）
 * 2. **给这个成员开一个全新的会话**，身份 / 职责 / 专属指令 / 头像原样继承，
 *    并且把那份交接说明当作它的**开场消息**投进去
 * 3. **旧会话归档**（不是删除：会话本体、完整日志一个都不动）
 *
 * ## 交接说明是**真·他自己写的**
 *
 * 走的不是「读日志再调一次模型」那条路，而是：
 *
 * ```js
 * const woken = await memberAgent(ctx, member);   // 拿到它自己那个 live agent
 * woken.agent.steer(userMessage(请求, …));         // 把请求投进**它自己的会话**
 * // 然后监听它自己会话里的 assistant/message —— 那条回复就是交接说明
 * ```
 *
 * 依据（都是本项目已有的、跑通过的机制）：
 * - `agent.steer()` 是本插件投递消息的既有姿势（`member-runtime.js`，
 *   移植自官方 `dsh-cordis-host-runner` / `dsh-plan-mode`）；
 * - `ctx.on("session/event")` 上已经有本插件的回复钩子
 *   （`index.js` 的 `onMemberReply`），形状出处也在那里：
 *   **`assistant/message` 的正文在 `event.data.message.content`**。
 *
 * 退路（只在它自己写不出来的时候才走，而且**必须在回执里明说**）：
 * 用 `sessionQuery.readSession()` 读它自己的日志 + 调一次模型提炼。
 * 哪条路成的，结果里带 `source`：`"member"` / `"llm"` / `"none"`。
 *
 * ## 上限意识
 *
 * 会话日志动辄几十万字，任何送进模型的东西都必须先截断
 * （`MAX_LOG_CHARS` 只取**尾部**：最近发生的事才是交接要用的），
 * 所有等待都有上限（`HANDOVER_WAIT_MS`），所有循环都有界。
 *
 * ## 绝不丢数据
 *
 * 归档 = 只改**成员资料里的指向**，一个会话都不删。
 * 详见 `runSuccession()` 里那段「做到一半失败怎么办」。
 */

import { randomUUID } from "node:crypto";
import {
  HANDOVER_SECTIONS,
  MAX_HANDOVER_LENGTH,
  MAX_HANDOVER_SECTION_LENGTH,
} from "./member-store.js";
import {
  MEMBER_SUCCESSOR_SOURCE,
  archivedSessionIds,
  attachWorkspace,
  memberAgent,
  newSessionId,
  renameTitle,
  runtimeServices,
  userMessage,
} from "./member-runtime.js";

/**
 * 交接说明的**正文**上限（字符）。
 *
 * ⚠ 这是给模型的硬约束，不是事后截断了事：超了会被**整段丢掉**重来一次，
 *   所以数值要落在「模型一次能写得出、而且信息量足够」的位置。
 *   12 000 字 ≈ 中文 36 KB，五段每段 2 400 字 —— 足够写清做过什么、
 *   卡在哪、下一步干什么、有什么坑、关键文件在哪。
 *   与会话原文（动辄几十万字）相比，这就是「提炼」的量化定义。
 */
const HANDOVER_CHAR_LIMIT = 12_000;

/** 等它自己写出来的上限。超时走退路，退路再失败就降级成空说明。 */
const HANDOVER_WAIT_MS = 90_000;

/**
 * 实际使用的等待上限。
 *
 * 可以用环境变量 `TEAM_CHAT_HANDOVER_WAIT_MS` 覆盖 —— 唯一用途是**让守卫
 * 能在几秒内真的跑一遍超时分支**（否则验一次要等 90 秒，守卫迟早被人注释掉）。
 *
 * ⚠ 只认**正整数**，其余一律回落到默认值：一个写错的环境变量不该让
 *   「等它写交接说明」变成「立刻超时」——那样每次交替都会静默降级成空说明。
 *
 * @returns 等待毫秒数。
 */
export function handoverWaitMs() {
  const raw = Number.parseInt(process.env?.TEAM_CHAT_HANDOVER_WAIT_MS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0 && raw <= HANDOVER_WAIT_MS) return raw;
  return HANDOVER_WAIT_MS;
}

/**
 * 退路提炼时最多读多少**字符**的会话日志。
 *
 * 只取**尾部**：交接要的是「最近在干什么」，而日志尾部就是最近。
 * 28 000 字约等于 8.4 万 UTF-8 字节 —— 对任何模型的输入预算都是安全量级。
 */
const MAX_LOG_CHARS = 28_000;

/** 退路提炼的模型超时。 */
const LLM_TIMEOUT_MS = 60_000;
/** 退路提炼要求模型输出的最大 token 数。 */
const LLM_MAX_TOKENS = 4_096;

/** 同一进程里最多同时跑几场交替（同一成员另有锁，见 `inFlight`）。 */
const MAX_INFLIGHT = 4;

/** 五个分段的**中文小标题**：既给提示词用，也用来从回答里抽分段。 */
const SECTION_TITLES = {
  done: "我做过什么",
  now: "现状",
  todo: "待办",
  pitfalls: "坑与注意事项",
  anchors: "关键决策 / 文件 / 标识",
};

/** 一份「空交接说明」的固定正文。写不出东西时用它，好过留一个空字段。 */
const EMPTY_NOTE = "（本次交替没能生成交接说明。原因已写进宿主日志，可搜 team-chat: [succession]。）";

// ══════════════════════════════════════════════════════════════
// 提示词
// ══════════════════════════════════════════════════════════════

/**
 * 组装给**上一个 AI 自己**的那条请求。
 *
 * 刻意不叫「请写一份总结」而是「你要被替换了，写交接」——
 * 模型对后者的产出结构化得多，而且它知道这东西要给一个**接手的人**看。
 *
 * @param input - `{displayName, duty, newSessionId, successorFirst}`。
 * @returns 请求正文。
 */
export function buildHandoverRequest(input) {
  const name = typeof input?.displayName === "string" && input.displayName.trim() !== ""
    ? input.displayName.trim()
    : "你";
  const duty = typeof input?.duty === "string" && input.duty.trim() !== "" ? input.duty.trim() : "（未填）";

  return [
    `【交接通知 · 请你自己来写】`,
    ``,
    `你是这个团队里的 AI 成员「${name}」，职责：${duty}。`,
    `现在要给你**换一个全新的会话**继续这份工作 —— 原因是你当前会话的上下文太长了。`,
    ``,
    `你的身份、名字、职责、专属指令都会被原样继承到下一个会话里，`,
    `**唯一需要你现在产出的**，是一份交给下一个会话里那个 AI 的交接说明。`,
    `它会把这份说明当作上岗时的第一封邮件来读，然后接着往下干。`,
    ``,
    `## 硬要求`,
    ``,
    `1. **只写交接说明本身**，不要寒暄、不要复述本通知、不要问问题、不要调工具。`,
    `2. **必须提炼**，不要把我的会话原文倒出来 —— 那等于没写。`,
    `   写「结论、状态、位置」，不写「我们刚才聊了什么」。`,
    `3. 严格按下面五段的标题和顺序写 Markdown 二级标题（##）。`,
    `   每段不超过 ${MAX_HANDOVER_SECTION_LENGTH} 字；全文不超过 ${HANDOVER_CHAR_LIMIT} 字。`,
    `   某一项确实没有内容，就写「（无）」，不要省略标题。`,
    `4. 具体优先：文件名、路径、命令、ID、参数、结论、数字，能写就写。`,
    `   这些是下一个 AI 唯一能抓住的锚点。`,
    ``,
    `## 输出格式`,
    ``,
    `## ${SECTION_TITLES.done}`,
    `（已完成的事 + 结果在哪：文件、产出、结论）`,
    ``,
    `## ${SECTION_TITLES.now}`,
    `（当前处于什么状态：跑到哪一步、什么能用、什么是坏的）`,
    ``,
    `## ${SECTION_TITLES.todo}`,
    `（没做完的、下一步该做什么，按优先级排）`,
    ``,
    `## ${SECTION_TITLES.pitfalls}`,
    `（你踩过的坑、试过但走不通的路、别人别重踩的地方）`,
    ``,
    `## ${SECTION_TITLES.anchors}`,
    `（关键决策 / 关键文件路径 / 标识符 / 约定 —— 下一个 AI 必须知道的那些）`,
    ``,
    `现在开始写。`,
  ].join("\n");
}

/**
 * 组装**新会话**的开场消息。
 *
 * ## 注入方式：新会话的第一条消息（不是系统提示段落）
 *
 * 选它的理由：
 *
 * 1. **本项目的既有做法就是「开场消息」**：`buildMemberPrompt()` 那一套
 *    （自我介绍 + 职责 + 专属指令 + 通信协议）本来就走 `agent.steer()`
 *    投成成员会话的第一条消息。交接说明跟它是同一类东西 —— 换个位置注入
 *    会出现「一半在系统提示、一半在开场消息」的两套语义。
 * 2. **成员会话是一个普通根会话，没有独立的系统提示段落可写**。
 *    要改系统提示就得碰官方 `agent/persona` 之类的东西 ——
 *    那是官方内部面，不是本插件该伸手的地方（也是本项目"只走公开面"的规矩）。
 * 3. **可回看**：开场消息落在那个会话的日志里，用户打开新窗口就看得见
 *    「这个 AI 上岗时拿到了什么」，而不是藏在不可见的提示里。
 *
 * @param input - `{handover, basePrompt, previousSessionId}`。
 *   `basePrompt` = 身份那段（由宿主的 `buildMemberPrompt` 生成）。
 * @returns 开场消息正文。
 */
export function buildSuccessorPrompt(input) {
  const note = typeof input?.handover === "string" && input.handover.trim() !== ""
    ? input.handover.trim()
    : EMPTY_NOTE;
  const base = typeof input?.basePrompt === "string" ? input.basePrompt.trim() : "";
  const previous =
    typeof input?.previousSessionId === "string" && input.previousSessionId !== ""
      ? input.previousSessionId
      : "（未知）";

  return [
    base,
    ``,
    `---`,
    ``,
    `## 交接说明（上一任写的）`,
    ``,
    `你不是从零开始接手这份工作。上一任 AI 刚把它的经验写成了下面这份交接说明 ——`,
    `**先读完它再动手**。里面「待办」那一段就是你上岗后的第一件事。`,
    ``,
    `它来自的旧会话是 \`${previous}\`（已归档，需要翻原始记录时可以去左侧栏打开它）。`,
    ``,
    note,
  ].join("\n");
}

// ══════════════════════════════════════════════════════════════
// 从模型的回答里抽五段
// ══════════════════════════════════════════════════════════════

/**
 * 把模型写的 Markdown 拆成五个分段。
 *
 * **抽不到就整段不要**（返回 null），由调用方退化成「只有正文」——
 * 硬凑一份分段会让界面显示成「已提炼」而实际是散文，那是在骗人。
 *
 * @param text - 模型回答。
 * @returns `{done?, now?, todo?, pitfalls?, anchors?}` 或 null。
 */
export function parseHandoverSections(text) {
  if (typeof text !== "string" || text.trim() === "") return null;

  // 按「## 标题」切块。标题允许带序号 / 前后空白（模型常见写法）。
  const blocks = [];
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^\s{0,3}#{1,6}\s*(.+?)\s*$/u.exec(line);
    if (heading !== null) {
      current = { title: heading[1], body: [] };
      blocks.push(current);
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  if (blocks.length === 0) return null;

  const sections = {};
  for (const key of HANDOVER_SECTIONS) {
    const wanted = SECTION_TITLES[key];
    // 标题匹配：去掉序号与标点后**包含**关键词即可
    //（「一、我做过什么」「## 1. 我做过什么」都要认出来）。
    const hit = blocks.find((block) => {
      const clean = block.title.replace(/^[\s\d.、,，)）(（:：-]+/u, "");
      return clean.includes(wanted) || block.title.includes(wanted);
    });
    if (hit === undefined) continue;
    const body = hit.body.join("\n").trim().slice(0, MAX_HANDOVER_SECTION_LENGTH);
    if (body !== "") sections[key] = body;
  }
  return Object.keys(sections).length > 0 ? sections : null;
}

/**
 * 把「五段」重新拼成一份可读的 Markdown 交接说明。
 *
 * 存进成员资料的是**这一份**（而不是模型原始输出）：它带着统一的标题、
 * 顺序固定、长度已截断。原始输出留作 `text` 的来源，但也要过同一个上限。
 *
 * @param sections - `parseHandoverSections` 的结果。
 * @returns Markdown 文本。
 */
export function renderHandover(sections) {
  const parts = [];
  for (const key of HANDOVER_SECTIONS) {
    const body = typeof sections?.[key] === "string" ? sections[key].trim() : "";
    if (body === "") continue;
    parts.push(`## ${SECTION_TITLES[key]}\n\n${body}`);
  }
  return parts.join("\n\n");
}

// ══════════════════════════════════════════════════════════════
// 主路径：让它自己写
// ══════════════════════════════════════════════════════════════

/**
 * 每个会话一个「在等它回话」的登记处。
 *
 * ## 为什么是模块级而不是每次调用自己 `ctx.on`
 *
 * 单测/宿主里要能**不依赖真实事件总线**地注入回答，而且登记必须
 * **先于 steer** 完成 —— 否则一个跑得飞快的 agent 可能在登记之前就回了，
 * 那条回复会被漏掉（然后就白等到超时）。
 *
 * 监听器本身是**一份**（`ensureHandoverListener`），挂在宿主 ctx 上。
 */
const waiters = new Map();

/** 监听器是否已经挂上（每个 ctx 只挂一次）。 */
let listenerCtx = null;

/**
 * 挂上「等它自己写」的监听器（幂等）。
 *
 * ⚠ 监听器**永不主动摘除**：一次交替只挂一个，且 `resolveWaiter` 在
 *   没有等待者时直接返回。为它配一套「没人等就摘、有人等再挂」的
 *   注册/注销时序，只会制造「摘挂之间漏掉一条回复」的窗口 ——
 *   而那个窗口的代价是白等 90 秒。
 *
 * @param ctx - 宿主上下文。
 */
function ensureHandoverListener(ctx) {
  if (listenerCtx === ctx) return;
  listenerCtx = ctx;
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "assistant/message") return;
    // ⚠ 形状：`assistant/message` 追加的是一个**外层包装**，正文在
    //   `event.data.message.content`（出处见 `index.js` 的 `onMemberReply`）。
    const blocks = event.data?.message?.content;
    if (!Array.isArray(blocks)) return;
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
    if (text === "") return; // 只有工具调用的一步，不算回答
    resolveWaiter(session?.id, text);
  });
}

/**
 * 把一条回答交给正在等它的那个交替流程。
 *
 * @param sessionId - 说话的会话。
 * @param text - 正文。
 */
function resolveWaiter(sessionId, text) {
  const waiter = waiters.get(sessionId);
  if (waiter === undefined) return;
  waiters.delete(sessionId);
  waiter.resolve(text);
}

/**
 * 往这个成员**自己的会话**里投一条请求，并等它自己产出回答。
 *
 * @param ctx - 宿主上下文。
 * @param member - 成员资料（含 `sessionId`）。
 * @param request - 请求正文。
 * @returns `{ok, text?, code?, error?}` —— **永不抛错**。
 */
async function askMemberItself(ctx, member, request) {
  let release = null;
  try {
    const woken = await memberAgent(ctx, member);
    if (!woken.ok) return { ok: false, code: woken.code, error: woken.error };
    if (typeof woken.agent.steer !== "function") {
      return { ok: false, code: "TEAMCHAT_SUCC_NOT_STEERABLE", error: "This session's agent does not accept deliveries." };
    }

    // ⚠ 登记**先于** steer —— 见 `waiters` 的注释。
    let resolveWaiterFn = null;
    const replied = new Promise((resolve) => {
      resolveWaiterFn = resolve;
    });
    waiters.set(member.sessionId, { resolve: resolveWaiterFn });
    release = () => waiters.delete(member.sessionId);

    try {
      woken.agent.steer(
        userMessage(request, { kind: MEMBER_SUCCESSOR_SOURCE, member: member.key, intent: "handover" }),
      );
    } catch (error) {
      // 这条是「投递动作本身抛了」——码给稳定的那一个，**异常原文一个字不丢**
      // 地放进 `params.detail`（它是排障线索，不是给人读的引导语）。
      return {
        ok: false,
        code: typeof error?.code === "string" ? error.code : "TEAMCHAT_SUCC_STEER_FAILED",
        params: { detail: String(error?.message ?? error) },
        error: `The hand-over request could not be delivered: ${error?.message ?? String(error)}`,
      };
    }

    const wait = handoverWaitMs();
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), wait);
      // 定时器不该拖住宿主退出。
      timer.unref?.();
    });
    const text = await Promise.race([replied, timeout]);
    if (typeof text !== "string" || text.trim() === "") {
      return {
        ok: false,
        code: "TEAMCHAT_SUCC_HANDOVER_TIMEOUT",
        params: { seconds: Math.round(wait / 1000) },
        error: `Waited ${Math.round(wait / 1000)} seconds and it did not produce a hand-over note.`,
      };
    }
    return { ok: true, text: text.trim().slice(0, HANDOVER_CHAR_LIMIT) };
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === "string" ? error.code : "HANDOVER_ASK_FAILED",
      error: error?.message ?? String(error),
    };
  } finally {
    // 无论怎么结束都清掉登记 —— 留着一个永远没人 resolve 的等待者，
    // 下一条回复会被投给一个已经没人看的 Promise。
    release?.();
  }
}

// ══════════════════════════════════════════════════════════════
// 退路：读它自己的日志 + 调一次模型提炼
// ══════════════════════════════════════════════════════════════

/**
 * 从会话日志里抽出「能喂给模型的那点正文」，**只取尾部**。
 *
 * @param events - 原始事件数组。
 * @returns 正文（已截断到 `MAX_LOG_CHARS`）。
 */
export function extractLogDigest(events) {
  if (!Array.isArray(events)) return "";
  const roles = [];
  for (const event of events) {
    if (event?.type === "user/message") {
      // `user/message` 追加的就是消息对象本身 ⇒ 正文在 `data.content`。
      const text = textOfBlocks(event.data?.content);
      if (text !== "") roles.push(`【人】${text}`);
    } else if (event?.type === "assistant/message") {
      // `assistant/message` 追加的是外层包装 ⇒ 正文在 `data.message.content`。
      const text = textOfBlocks(event.data?.message?.content);
      if (text !== "") roles.push(`【AI】${text}`);
    }
  }
  const joined = roles.join("\n\n");
  // ⚠ 只取尾部：交接要的是「最近在干什么」，而日志尾部就是最近。
  return joined.length > MAX_LOG_CHARS ? joined.slice(joined.length - MAX_LOG_CHARS) : joined;
}

/**
 * 取文本块拼起来（非文本块一律忽略）。
 *
 * @param blocks - 内容块数组。
 * @returns 正文。
 */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * 退路：读它自己的会话日志 + 调一次模型提炼。
 *
 * **这个结果必须在回执里标明 `source: "llm"`** —— 它不是「他自己写的」。
 * 用户明确要求过：走了退路就必须说清楚，不许含糊成「他自己写的」。
 *
 * @param ctx - 宿主上下文。
 * @param member - 成员资料。
 * @param reason - 为什么走了退路（写进日志与回执）。
 * @returns `{ok, text?, code?, error?}`。
 */
async function summarizeItsLog(ctx, member, reason) {
  const log = await readItsLog(ctx, member);
  if (!log.ok) return log;

  const llm = ctx.get?.("llm") ?? null;
  if (llm === null || typeof llm.stream !== "function") {
    return { ok: false, code: "TEAMCHAT_SUCC_LLM_UNAVAILABLE", error: "This host has no usable llm service." };
  }
  const selection = readDefaultModel(ctx);
  if (selection === null) {
    return {
      ok: false,
      code: "TEAMCHAT_SUCC_MODEL_UNAVAILABLE",
      error: "Could not read the default model (agentDefaultModel.currentSelection).",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  timer.unref?.();
  try {
    const chunks = [];
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      system: HANDOVER_SYSTEM,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: [
            {
              type: "text",
              // ⚠ 上限意识：这里的 `digest` 已经在 `extractLogDigest` 里被截到
              //   MAX_LOG_CHARS（尾部），所以这条请求的输入是有界的。
              text: `【为什么需要你代笔】${reason}\n\n【它的会话日志摘录（可能是尾部截断）】\n\n${log.digest}`,
            },
          ],
          source: { kind: "team-chat-succession" },
        },
      ],
      maxTokens: LLM_MAX_TOKENS,
      purpose: "team-chat-succession",
      signal: controller.signal,
    })) {
      if (chunk?.type === "text-delta" && typeof chunk.text === "string") chunks.push(chunk.text);
    }
    const text = chunks.join("").trim();
    if (text === "") {
      return { ok: false, code: "TEAMCHAT_SUCC_LLM_EMPTY", error: "The fallback distillation produced no text at all." };
    }
    return { ok: true, text: text.slice(0, HANDOVER_CHAR_LIMIT) };
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === "string" ? error.code : "LLM_FAILED",
      error: error?.message ?? String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 退路提炼用的系统提示（与主路径同一套输出格式要求）。 */
const HANDOVER_SYSTEM = [
  "你在为一个 AI 成员团队做交接。上一个 AI 的会话要被替换掉，",
  "它自己没能写出交接说明，所以你根据它的会话日志替它提炼一份。",
  "只输出交接说明本身，严格按用户给的五段 Markdown 二级标题格式写，",
  "内容必须是提炼（结论、状态、位置），不是日志复述。",
].join("");

/**
 * 读它自己的会话日志（软探测 `sessionQuery`，拿不到就用 live agent 的会话）。
 *
 * @param ctx - 宿主上下文。
 * @param member - 成员资料。
 * @returns `{ok, digest?, code?, error?}`。
 */
async function readItsLog(ctx, member) {
  const sessionId = typeof member?.sessionId === "string" ? member.sessionId : "";
  if (sessionId === "") {
    // ⚠⚠ **命名冲突**（2026-10-12 拆开）：这里原来叫 `MEMBER_NO_SESSION`，
    //   而 `/__teamchat/spawn` 那条路由也有一个 `MEMBER_NO_SESSION`
    //   （现已改叫 `TEAMCHAT_MEMBER_NO_SESSION`）—— **同码不同义**：
    //     · `/spawn`：**请求里缺**要收编的会话 id（调用方没给，4xx，改一下就能过）；
    //     · 这里：**成员资料里没有**会话 id（数据状态如此，204/502，重试也没用）。
    //   同一个码必然把其中一句文案说错。两个都进 `TEAMCHAT_` 命名空间
    //   （客户端字典键是 `err.<code>`），但**名字完全不同**：
    //   交替这条路一律 `TEAMCHAT_SUCC_*` 前缀（SUCC = succession），
    //   与 `/spawn` 的码不可能再撞。
    return { ok: false, code: "TEAMCHAT_SUCC_MEMBER_NO_SESSION", error: "This member has no session." };
  }

  // ① 首选官方 sessionQuery.readSession —— 它连**已回收**的会话日志也能读。
  const query = ctx.get?.("sessionQuery") ?? null;
  if (query !== null && typeof query.readSession === "function") {
    try {
      const read = await query.readSession(sessionId);
      const digest = extractLogDigest(read?.events);
      if (digest !== "") return { ok: true, digest };
      return { ok: false, code: "TEAMCHAT_SUCC_LOG_EMPTY", error: "The session log has no usable text." };
    } catch (error) {
      // 读不到就往下走 live agent 那条路，不直接判死。
      ctx.logger?.warn?.(`team-chat: [succession] sessionQuery 读取 ${sessionId} 失败：${error?.message ?? error}`);
    }
  }

  // ② 退一步：live agent 身上的会话对象（`session.events` 不一定有，探测着读）。
  try {
    const agent = runtimeServices(ctx).agents?.get?.(sessionId);
    const events = agent?.session?.events;
    const digest = extractLogDigest(typeof events === "function" ? events.call(agent.session) : events);
    if (digest !== "") return { ok: true, digest };
  } catch (error) {
    ctx.logger?.warn?.(`team-chat: [succession] 读 live agent 日志失败：${error?.message ?? error}`);
  }
  return {
    ok: false,
    code: "TEAMCHAT_SUCC_LOG_UNAVAILABLE",
    error: "Could not get its session log (neither sessionQuery nor the live session would give it up).",
  };
}

/**
 * 读默认模型选择（软探测 `agentDefaultModel`）。
 *
 * @param ctx - 宿主上下文。
 * @returns `{provider, model, reasoningEffort?}` 或 null。
 */
function readDefaultModel(ctx) {
  try {
    const service = ctx.get?.("agentDefaultModel") ?? null;
    if (service === null || typeof service.currentSelection !== "function") return null;
    const selection = service.currentSelection();
    if (selection === null || typeof selection !== "object") return null;
    if (typeof selection.provider !== "string" || typeof selection.model !== "string") return null;
    return selection;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// 对外：生成一份交接说明
// ══════════════════════════════════════════════════════════════

/**
 * 生成一份交接说明。**永不抛错**，也**永不阻断交替**。
 *
 * 顺序：
 * 1. 让它自己写（主路径，`source: "member"`）
 * 2. 读日志 + 调模型提炼（退路，`source: "llm"`）
 * 3. 都失败 → 空说明 + 一条可查的日志（`source: "none"`）
 *
 * @param ctx - 宿主上下文。
 * @param member - 成员资料。
 * @returns `{source, handover|null, error?, attempts}`。
 */
export async function generateHandover(ctx, member) {
  const attempts = [];
  // ⚠ `member` 是 `MemberStore.get(key)` 给的那份 —— **它里面没有 `key` 字段**
  //   （键是 Map 的键，不在值里）。所以标识必须由调用方带进来，
  //   否则日志会打成「undefined 的交接说明生成失败」——一条查不出是谁的记录。
  const label = typeof member?.key === "string" && member.key !== ""
    ? member.key
    : typeof member?.displayName === "string" && member.displayName !== ""
      ? member.displayName
      : "(未知成员)";
  const name = typeof member?.displayName === "string" && member.displayName !== ""
    ? member.displayName
    : label;
  ensureHandoverListener(ctx);

  // ── ① 主路径：它自己写 ────────────────────────────────────
  try {
    const request = buildHandoverRequest({ displayName: name, duty: member?.duty });
    const asked = await askMemberItself(ctx, member, request);
    if (asked.ok) {
      return {
        source: "member",
        handover: makeNote(asked.text, { member, source: "member" }),
        attempts,
      };
    }
    attempts.push({ stage: "member", code: asked.code, error: asked.error });
    ctx.logger?.warn?.(
      `team-chat: [succession] ${label} 自己没能写出交接说明（${asked.code}）：${asked.error} —— 走退路提炼`,
    );
  } catch (error) {
    // `askMemberItself` 自己已经兜住了，这里只是第二层保险 ——
    // 交接生成失败**绝不能**把异常带回会话。
    attempts.push({ stage: "member", code: "THROWN", error: error?.message ?? String(error) });
    ctx.logger?.error?.(`team-chat: [succession] 主路径抛错：${error?.stack ?? String(error)}`);
  }

  // ── ② 退路：读日志 + 调模型 ──────────────────────────────
  try {
    const reason =
      `它自己没能写出交接说明（${attempts.at(-1)?.code ?? "未知"}）。` +
      `请读下面的会话日志摘录，替它提炼一份。`;
    const summarized = await summarizeItsLog(ctx, member, reason);
    if (summarized.ok) {
      return {
        source: "llm",
        handover: makeNote(summarized.text, { member, source: "llm" }),
        attempts,
        degraded: "退路：这份交接说明是**读它的会话日志 + 调模型提炼**出来的，不是它自己写的。",
      };
    }
    attempts.push({ stage: "llm", code: summarized.code, error: summarized.error });
    ctx.logger?.warn?.(
      `team-chat: [succession] ${label} 的退路提炼也失败（${summarized.code}）：${summarized.error}`,
    );
  } catch (error) {
    attempts.push({ stage: "llm", code: "THROWN", error: error?.message ?? String(error) });
    ctx.logger?.error?.(`team-chat: [succession] 退路抛错：${error?.stack ?? String(error)}`);
  }

  // ── ③ 降级：空说明 + 一条可查的日志 ──────────────────────
  //
  // ⚠ 只记日志、**不抛错**、**不阻断交替**：交接说明是锦上添花，
  //   而「上下文太长了」这个问题是用户真正要解决的 ——
  //   为了说明写不出来就不让换会话，是本末倒置。
  ctx.logger?.error?.(
    `team-chat: [succession] ${label} 的交接说明生成失败，降级为空说明：` +
      attempts.map((row) => `${row.stage}=${row.code}(${row.error})`).join(" | "),
  );
  return { source: "none", handover: null, attempts };
}

/**
 * 把模型回答整理成成员资料里的那条 `handover`。
 *
 * @param text - 模型回答。
 * @param options - `{member, source}`。
 * @returns 交接说明对象。
 */
function makeNote(text, options) {
  const raw = typeof text === "string" ? text.trim() : "";
  const truncated = raw.length > HANDOVER_CHAR_LIMIT;
  const capped = truncated ? raw.slice(0, HANDOVER_CHAR_LIMIT) : raw;
  const sections = parseHandoverSections(capped);
  // 能抽出分段就用重新排版的那一份（标题统一、顺序固定）；
  // 抽不出来就**如实存原始输出** —— 硬凑分段等于骗人。
  const rendered = sections === null ? capped : renderHandover(sections);
  return {
    title: "交接说明",
    text: rendered.slice(0, HANDOVER_CHAR_LIMIT),
    ...(sections === null ? {} : { sections }),
    structured: sections !== null,
    truncated,
    source: options.source,
    byName: typeof options.member?.displayName === "string" ? options.member.displayName : "",
    bySessionId: typeof options.member?.sessionId === "string" ? options.member.sessionId : "",
    createdAt: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
// 对外：跑一场交替
// ══════════════════════════════════════════════════════════════

/** 同一进程内正在跑的交替：成员键 -> {startedAt, promise}。 */
const inFlight = new Map();

/**
 * 跑一场「交替」。**永不抛错**，永远返回一个可读的回执。
 *
 * ## 做到一半失败怎么办（这一段是设计，不是注释）
 *
 * 全程只有**一次**会改动持久化状态的操作，就是最后那次 `store.set()`。
 * 它之前的每一步都是**可失败、可放弃**的准备动作：
 *
 * | 步骤 | 失败时 | 磁盘状态 |
 * |---|---|---|
 * | 生成交接说明 | **不阻断**，降级成空说明 | 未改动 |
 * | `ensureSession` 建新会话 | 中止，返回错误 | **未改动**（新会话是个孤儿，无害） |
 * | 新会话没变成 live | 中止，返回错误 | **未改动** |
 * | `attachWorkspace` | 只记日志，继续 | 未改动 |
 * | `store.set()` 一次写入全部字段 | 中止，返回错误 | **未改动**（`MemberStore` 落盘失败会回滚内存） |
 * | `renameTitle` / 投开场消息 | 只记日志，继续（交替已成立） | 已改动，但功能完整 |
 *
 * 所以不存在「身份丢了」或「两个会话同时代表同一成员」这两种状态：
 * **`sessionId` 是一个指针，要么指旧的、要么指新的，`store.set()` 是唯一的切换点**。
 * 切换之前，新会话谁也不知道；切换之后，旧会话只是不再被指向。
 *
 * 另外：**一个成员同时只允许跑一场交替**（`inFlight` 锁）——
 * 连点两次按钮会变成两个新会话抢同一个身份，那是最难查的一种坏状态。
 *
 * @param ctx - 宿主上下文。
 * @param store - MemberStore 实例。
 * @param input - `{memberKey, archive, buildBasePrompt, dataDir}`。
 *   `buildBasePrompt(member)` 由宿主注入（`index.js` 的 `buildMemberPrompt`），
 *   用来生成新会话开场消息里「身份 + 职责 + 指令 + 通信协议」那一段；
 *   `dataDir` 是交替账本 `successions.jsonl` 的落点。
 * @returns 回执对象（带 `ok`，**不抛错**）。
 */
export async function runSuccession(ctx, store, input) {
  const memberKey = typeof input?.memberKey === "string" ? input.memberKey.trim() : "";
  // 默认归档（用户拍板）：旧会话默认归档，界面上允许选「保留」。
  // 两种模式的**磁盘结果完全一样**（都不删任何会话），差别只在界面怎么解释。
  const archive = input?.archive !== "keep";

  if (memberKey === "") {
    return { ok: false, code: "TEAMCHAT_SUCC_MEMBER_NO_KEY", error: "Missing member name." };
  }
  const member = store?.get?.(memberKey);
  if (member === undefined || member === null) {
    return {
      ok: false,
      code: "TEAMCHAT_SUCC_MEMBER_NOT_FOUND",
      params: { name: memberKey },
      error: `No profile found for the member "${memberKey}".`,
    };
  }
  const previousSessionId = typeof member.sessionId === "string" ? member.sessionId : "";
  if (previousSessionId === "") {
    return {
      ok: false,
      code: "TEAMCHAT_SUCC_MEMBER_NO_SESSION",
      error: "This member has no session of its own yet (profile only), so there is nothing to succeed.",
    };
  }

  // ── 并发锁 ────────────────────────────────────────────────
  const running = inFlight.get(memberKey);
  if (running !== undefined) {
    return {
      ok: false,
      code: "TEAMCHAT_SUCC_IN_FLIGHT",
      params: { name: memberKey, since: String(running.startedAt) },
      error: `A succession for "${memberKey}" is already running (started at ${running.startedAt}); wait for it to finish.`,
    };
  }
  if (inFlight.size >= MAX_INFLIGHT) {
    return {
      ok: false,
      code: "TEAMCHAT_SUCC_BUSY",
      params: { max: MAX_INFLIGHT },
      error: `Too many successions at once (limit ${MAX_INFLIGHT}); try again shortly.`,
    };
  }

  const services = runtimeServices(ctx);
  if (services.agents === null || services.controller === null) {
    return {
      ok: false,
      code: "TEAMCHAT_SUCC_RUNTIME_UNAVAILABLE",
      error: "This host is missing the agents / sessionController service.",
    };
  }

  const newSession = newSessionId();
  const startedAt = new Date().toISOString();
  inFlight.set(memberKey, { startedAt });
  try {
    // ── ① 交接说明（**不阻断**：写不出来也照样换会话）────────
    // `memberKey` 显式带进去：成员记录里**没有 key 字段**（键是 Map 的键），
    // 不带的话日志会打成「undefined 的交接说明生成失败」——查不出是谁。
    const generated = await generateHandover(ctx, { ...member, key: memberKey });
    const note = generated.handover;
    const handoverText = note === null ? "" : note.text;

    // ── ② 建新会话 ──────────────────────────────────────────
    const cwd = typeof member.cwd === "string" && member.cwd !== "" ? member.cwd : "";
    const preset = typeof member.preset === "string" && member.preset !== "" ? member.preset : undefined;
    try {
      await services.controller.agents.ensureSession(newSession, cwd === "" ? undefined : cwd, true, preset);
    } catch (error) {
      // ⚠ 到这一步为止**磁盘一个字节都没改** —— 原样返回，成员照常工作。
      safeLog(ctx, "error", `建新会话失败，交替中止（成员状态未改动）：${error?.message ?? error}`);
      return {
        ok: false,
        code: typeof error?.code === "string" ? error.code : "TEAMCHAT_SUCC_SESSION_FAILED",
        params: { detail: String(error?.message ?? error) },
        error: `Could not create the new session: ${error?.message ?? String(error)}. Nothing about the member was changed.`,
        handover: { source: generated.source, ok: note !== null, attempts: generated.attempts },
      };
    }
    const agent = services.agents.get?.(newSession);
    if (agent === undefined) {
      safeLog(ctx, "error", `新会话 ${newSession} 建了但没变成活动会话，交替中止（成员状态未改动）。`);
      return {
        ok: false,
        code: "TEAMCHAT_SUCC_SESSION_NOT_LIVE",
        params: { session: String(newSession) },
        error: `The new session ${newSession} was registered but never became a live session. Nothing about the member was changed.`,
        sessionId: newSession,
        handover: { source: generated.source, ok: note !== null, attempts: generated.attempts },
      };
    }

    // ── ③ 一次写入：身份 + 交接说明 + 归档记录 ──────────────
    //
    // ⚠⚠ **这是全程唯一改动持久化状态的地方，也是唯一的切换点。**
    //    成功之前，`sessionId` 仍然指旧会话；成功之后指新会话。
    //    所以不存在「两个会话同时代表同一成员」的中间态。
    //
    // ⚠ 版本快照：清单**原样按倒序**保留（最近的在前）。
    //   `MemberStore.normalizeArchived` 会去重并截到 MAX_ARCHIVED_SESSIONS。
    const archivedAt = new Date().toISOString();
    const previousArchived = Array.isArray(member.archivedSessions) ? member.archivedSessions : [];
    const nextArchived = [{ sessionId: previousSessionId, archivedAt }, ...previousArchived];

    // ⚠ 交接履历：**当前那一份**要移到历史里去（它代表的是刚被交替掉的那个会话）。
    //   截断交给 `MemberStore.normalizeMember`（MAX_HANDOVER_HISTORY）——
    //   这里不自己 slice，免得两边各截一次、哪天上限改了只改一边。
    const history = Array.isArray(member.handoverHistory) ? member.handoverHistory : [];
    const previousNote = member.handover;
    const nextHistory =
      previousNote === undefined || previousNote === null ? history : [previousNote, ...history];

    const patch = {
      // 身份 / 配置原样继承（这些字段在资料里本来就有，显式写一遍是为了
      // 让「继承」这件事在 diff 里看得见，而不是靠 `{...旧, ...新}` 的巧合）。
      displayName: typeof member.displayName === "string" ? member.displayName : "",
      duty: typeof member.duty === "string" ? member.duty : "",
      instructions: typeof member.instructions === "string" ? member.instructions : "",
      sessionId: newSession,
      cwd,
      preset: typeof member.preset === "string" ? member.preset : "",
      ...(typeof member.roomSessionId === "string" && member.roomSessionId !== ""
        ? { roomSessionId: member.roomSessionId }
        : {}),
      ...(typeof member.roomCwd === "string" && member.roomCwd !== "" ? { roomCwd: member.roomCwd } : {}),
      archivedSessions: nextArchived,
      handedOverFrom: previousSessionId,
      // ⚠ `null` = **显式清空**当前交接说明（`MemberStore.set` 里那条信号，
      //   与 `avatar: null` 同一套）。一次交替没写出说明时，绝不能留着
      //   上一份不动 —— 下一个会话会把上一任的说明当成最新的。
      //   旧的那一份已经在 `handoverHistory` 里，历史不会丢。
      handover: note === null ? null : { ...note, acceptedAt: archivedAt },
      handoverHistory: nextHistory,
    };

    const saved = await store.set(memberKey, patch);
    if (!saved.ok) {
      // ⚠ 落盘失败：`MemberStore.set()` 自己已经把内存回滚了，磁盘也没变。
      //   唯一残留是一个**孤儿新会话** —— 它不属于任何成员，无害；
      //   记一条日志说明它叫什么，用户可以自己去左栏删掉。
      safeLog(
        ctx,
        "error",
        `写成员资料失败，交替中止（成员状态未改动）：${saved.error}；` +
          `新会话 ${newSession} 已成为孤儿，可在左侧栏自行删除。`,
      );
      return {
        ok: false,
        code: "TEAMCHAT_SUCC_MEMBER_STORE_FAILED",
        params: { detail: String(saved.error) },
        error: `Could not write the member profile: ${saved.error}. Nothing about the member was changed.`,
        sessionId: newSession,
        orphanSessionId: newSession,
        handover: { source: generated.source, ok: note !== null, attempts: generated.attempts },
      };
    }

    // ── ④ 以下都是**锦上添花**：失败只记日志，不回退 ─────────
    //
    // 到这里交替已经成立（指针已经指向新会话）。再从功能上回退反而危险 ——
    // 那会把「已经属于新会话的身份」退回给一个可能已经被改过的旧会话。
    const attached = await attachWorkspace(ctx, cwd, newSession);

    const previousDisplay = typeof member.displayName === "string" && member.displayName !== ""
      ? member.displayName
      : memberKey;
    const renamedNew = await renameTitle(ctx, newSession, previousDisplay, memberKey, true);
    if (!renamedNew) safeLog(ctx, "warn", `新会话 ${newSession} 的标题没能对齐到「${previousDisplay}」。`);

    // 旧会话改名 + 显式归档标记。
    //
    // ⚠ 这两件事都是**为了人**：改名是为了左栏里能一眼分清「哪一行是已经交出去的旧会话」——
    //   两个同名窗口并排摆着，用户迟早会往旧的那个发消息，而它已经不收成员消息了。
    //   不改成「旧 · 已归档」的话，那种"发了没反应"的行为会被当成 bug。
    let renamedOld = false;
    if (archive) {
      renamedOld = await renameTitle(
        ctx,
        previousSessionId,
        `${previousDisplay}（旧 · 已归档 ${archivedAt.slice(0, 10)}）`,
        previousSessionId,
        true,
      );
      if (!renamedOld) {
        safeLog(
          ctx,
          "warn",
          `旧会话 ${previousSessionId} 的标题没能改成「已归档」—— 左栏里可能有两行同名窗口，` +
            `请在确认旧会话后再操作（它已经不作为成员接收消息了）。`,
        );
      }
    }

    // 新会话的开场消息：把交接说明投进去（**注入方式的落点在 `buildSuccessorPrompt`**）。
    let steered = false;
    if (typeof agent.steer === "function") {
      try {
        agent.steer(
          userMessage(
            buildSuccessorPrompt({
              handover: handoverText,
              basePrompt: basePromptOf({
                member,
                store,
                ctx,
                buildBasePrompt: input.buildBasePrompt,
                roomSessionId: member.roomCwd,
              }),
              previousSessionId,
            }),
            { kind: MEMBER_SUCCESSOR_SOURCE, member: memberKey, intent: "successor-open" },
          ),
        );
        steered = true;
      } catch (error) {
        safeLog(
          ctx,
          "error",
          `新会话 ${newSession} 的开场消息没投出去（交替已成立）：${error?.message ?? error}`,
        );
      }
    }

    safeLog(
      ctx,
      "info",
      `[succession] ${memberKey}：${previousSessionId} → ${newSession}` +
        `（交接说明=${generated.source}，旧会话=${archive ? "已归档" : "保留"}）`,
    );
    recordSuccessionLog(ctx, input.dataDir, {
      at: startedAt,
      memberKey,
      from: previousSessionId,
      to: newSession,
      source: generated.source,
      archive,
      handoverOk: note !== null,
      attempts: generated.attempts,
    });

    return {
      ok: true,
      memberKey,
      previousSessionId,
      sessionId: newSession,
      archived: archive,
      // 界面据此如实说明来源：`member` = 它自己写的；`llm` = 退路提炼；`none` = 降级。
      handover: {
        source: generated.source,
        ok: note !== null,
        chars: handoverText.length,
        structured: note?.structured === true,
        truncated: note?.truncated === true,
        attempts: generated.attempts,
      },
      degraded: generated.degraded ?? null,
      attached,
      title: { ok: renamedNew, previousKept: false },
      steered,
      startedAt,
    };
  } catch (error) {
    // ⚠⚠ 这个函数的调用方是一条 HTTP 路由，而这条路径**绝不能让异常冒出去**
    //    （2026-10-09 那场「插件抛错杀宿主」的事故就是这么来的）。
    safeLog(ctx, "error", `[succession] 未预期的异常（交替已中止）：${error?.stack ?? String(error)}`);
    return {
      ok: false,
      code: typeof error?.code === "string" ? error.code : "TEAMCHAT_SUCC_FAILED",
      params: { detail: String(error?.message ?? error) },
      error: `Succession failed: ${error?.message ?? String(error)}. Nothing about the member was changed.`,
    };
  } finally {
    inFlight.delete(memberKey);
  }
}

/**
 * 记一行日志 —— 包了 try：日志服务本身出问题也绝不能把异常带回来。
 *
 * @param ctx - 宿主上下文。
 * @param level - `info` / `warn` / `error`。
 * @param message - 正文。
 */
function safeLog(ctx, level, message) {
  try {
    const logger = ctx?.logger?.[level] ?? ctx?.logger?.info;
    logger?.(`team-chat: ${message}`);
  } catch {
    /* 日志都写不出去的时候，什么也做不了 —— 但绝不能因此抛错。 */
  }
}

/**
 * 把一次交替追加进数据目录下的账本 `successions.jsonl`。
 *
 * ## 为什么还要落一份盘
 *
 * 「生成失败降级成空说明」必须留下**可查的证据**。日志会被轮转、
 * 会被别的输出淹没；而这份账本是交接这件事自己的流水，
 * 用户说「这次交替怎么没带说明过来」时，打开它就能看到原因。
 *
 * ⚠ 只追加、不读回、**永不抛错**：写不进去也不影响交替结果。
 *
 * @param ctx - 宿主上下文。
 * @param dataDir - 数据目录（宿主的 `resolveDataDir()`）。
 * @param entry - 一行记录。
 */
function recordSuccessionLog(ctx, dataDir, entry) {
  if (typeof dataDir !== "string" || dataDir === "") return;
  // 动态 import：这个模块只在真正发生交替时才需要，不该拖慢插件加载。
  void (async () => {
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const file = path.join(dataDir, "successions.jsonl");
      await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      safeLog(ctx, "warn", `[succession] 账本写入失败（不影响交替）：${error?.message ?? error}`);
    }
  })();
}

/**
 * 组装新会话开场消息里那一段「身份 + 职责 + 指令 + 通信协议」。
 *
 * ⚠ 复用宿主注入进来的 `buildBasePrompt`（就是 `index.js` 里那套
 *   `buildMemberPrompt`）。**不在这里 import 它** ——
 *   `index.js` 会 import 本文件，反向 import 会成环。
 *
 * @param input - `{member, store, ctx, roomSessionId}`。
 * @returns 基础开场消息（构建器不可用时退回一段最小自我介绍）。
 */
function basePromptOf(input) {
  const member = input.member;
  const builder = typeof input.buildBasePrompt === "function" ? input.buildBasePrompt : null;
  if (builder !== null) {
    return builder(member);
  }
  // 退路：至少别让新会话不知道自己在团队里的位置。
  const name = typeof member.displayName === "string" && member.displayName !== "" ? member.displayName : member.key;
  const duty = typeof member.duty === "string" ? member.duty : "";
  return [
    `你是这个团队里的 AI 成员「${name}」，职责：${duty || "（未填）"}。`,
    `你的身份、职责与专属指令与上一任完全相同 —— 你只是换了一个更干净的会话。`,
  ].join("\n");
}
