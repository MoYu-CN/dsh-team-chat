/**
 * 团队协作层 —— 让 AI 成员之间（以及成员 ⇄ 主智能体）能**互相通信**。
 *
 * ## 为什么必须由宿主当邮局
 *
 * 成员是**独立的顶层根会话**（见 `member-runtime.js`），这意味着官方那套
 * 成员间通信完全用不了。实测（2026-09-27，读
 * `@deepseek-ai/dsh-subagent/lib/types/continuation.js` 的 `sendMessage()`）：
 *
 * ```js
 * async sendMessage(sender, targetId, content, options) {
 *   if (this.ctx.agents.get(sender.id) !== sender) throw UNAUTHORIZED;
 *   ...
 *   if (sender.session.header.parentSession === targetId) { ... 发给 parent ... }
 *   return this.deliverToChild(sender, targetId, content, { delivery: 'steer' });
 * }
 * ```
 *
 * `deliverToChild` → `activations.holdOwnership(parent, childId)` ——
 * **只认「直接父子」的相邻关系**。官方的 `send_message` 工具说明也写死了
 * 「your **direct continuable child**, or your **direct parent**」。
 *
 * 独立的根会话**没有 parent**，成员之间也没有任何血缘关系 →
 * **官方通道一条都走不通**。所以我们自己搭一个。
 *
 * ## 怎么搭：文件信箱 + 宿主轮询
 *
 * 成员是模型，它唯一能主动产生副作用的方式是**用工具**（写文件）。
 * 所以我们给每个成员一个**信箱目录**，约定一套极简协议：
 *
 * ```
 * <数据目录>/mailbox/<成员名>/        ← 这个成员的**发件箱**
 *   0001-bob-<uuid>.json     ← 待投递（宿主读走就删）
 * ```
 *
 * ⚠ 语义是**发件箱**：成员把要发的消息写进**自己**的目录，`to` 写收件人。
 *   宿主轮询每个成员的目录，把里面的消息投递给 `to` 指定的人。
 *   （协议文本一度写反成「写进收件人的目录」，与宿主实现矛盾 —— 那样
 *   每条消息都会被当成「发给自己」丢进 failed/。2026-10-09 守卫驱动时抓出。）
 *
 * 消息文件形状：
 * ```json
 * { "to": "carol", "text": "任务做完了，请你验收", "at": "...", "kind": "report" }
 * ```
 *
 * 成员的**开场消息**里会教它这套协议（见 `buildMemberPrompt`），
 * 宿主侧由一个定时器轮询所有信箱，读到就：
 * 1. 记进房间时间线（聊天室里看得见「A → B」）
 * 2. 投递给目标成员（`steer`），唤醒它继续干活
 *
 * ## 这个方案的成本与边界
 *
 * - **轮询间隔**：默认 1500ms。信箱是本地小文件，代价可忽略。
 * - **不保证投递顺序**：按文件名字典序，文件名带零填充序号，够用。
 * - **失败会留下痕迹**：投递失败的条目移到 `failed/` 子目录，不静默吞掉。
 * - **成员必须被教会**：它不知道这套协议就不会用。所以协议文本必须进
 *   开场消息，且在收到任何消息时**重复提醒**（实现见 `index.js` 的 `deliverToMembers`）。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 单条成员间消息的正文上限（字符）。 */
export const MAX_BUS_MESSAGE = 4_000;

/**
 * 信箱根目录名（在插件数据目录之下）。
 *
 * 注意是**数据目录之下**，不是成员的 cwd —— 成员的 cwd 是用户的工作区，
 * 往里丢 `.dsh-team-chat/` 之类的目录会污染用户项目。
 */
export const MAILBOX_DIR = "mailbox";

/**
 * 成员名 → 文件系统安全的名字。
 *
 * 成员名本身的规则是 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（见 `index.js` 的 `MEMBER_NAME`），
 * 已经是安全的。这里再兜一层是为了**兼容历史数据**里可能存在的怪名字，
 * 以及防止将来放宽规则时忘了这里。
 *
 * @param name - 成员名。
 * @returns 只能含 `[a-z0-9_-]` 的目录名；无法安全化时返回空串。
 */
export function safeMailboxName(name) {
  const raw = String(name ?? "").trim().toLowerCase();
  if (raw === "") return "";
  const cleaned = raw.replace(/[^a-z0-9_-]/gu, "-").replace(/-{2,}/gu, "-").replace(/^-|-$/gu, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "";
  return cleaned.slice(0, 64);
}

/**
 * 一个成员的信箱目录。
 *
 * @param rootDir - 插件数据目录。
 * @param memberKey - 成员名。
 * @returns 绝对路径；成员名不合法时返回 null。
 */
export function mailboxOf(rootDir, memberKey) {
  const safe = safeMailboxName(memberKey);
  if (safe === "") return null;
  return path.join(rootDir, MAILBOX_DIR, safe);
}

/**
 * 教成员「怎么给别的成员发消息」的那段协议文本。
 *
 * ## 为什么要写这么啰嗦
 *
 * 成员看不到这套宿主代码 —— 它只知道自己是某个工作区里的一个会话。
 * 不给它明确的路径、文件名规则、JSON 形状，它**不可能猜对**。
 * 实测过一次含糊的写法（只说"写个文件到信箱目录"），结果它写了个
 * `message.txt`、内容是自由文本，宿主解析不了。
 *
 * 所以这里给的是**可以照抄的完整形状**，包括一个具体的例子。
 *
 * @param rootDir - 插件数据目录（信箱的根）。
 * @param memberKey - 这个成员自己的名字（用来算它自己的信箱）。
 * @param roster - 同房间其他成员的名字列表（用来告诉它能发给谁）。
 * @returns 协议说明文本；`rootDir` 为空时返回空串。
 */
export function buildBusProtocol(rootDir, memberKey, roster = [], options = {}) {
  if (typeof rootDir !== "string" || rootDir === "") return "";
  const mine = safeMailboxName(memberKey);
  if (mine === "") return "";

  /**
   * 名册条目：允许传纯字符串（标识）或 `{key, displayName}`。
   *
   * ⚠ 文件信箱那条路**必须**用标识（那是目录名），而**给人看/给模型看**的应该是
   *   显示名（用户取的中文名）。所以这里两者都留着。
   */
  const rows = roster
    .map((row) => (typeof row === "string" ? { key: row, displayName: "" } : row))
    .filter((row) => row !== null && typeof row?.key === "string" && safeMailboxName(row.key) !== mine);
  const labelOf = (row) =>
    typeof row.displayName === "string" && row.displayName !== "" ? row.displayName : row.key;

  const others = rows.map((row) => `\`${row.key}\`（${labelOf(row)}）`);

  const targets = others.length === 0 ? "（目前这个聊天室里只有你一个成员）" : others.join("、");

  const dir = path.join(rootDir, MAILBOX_DIR);
  const myBox = path.join(dir, mine);
  const hasTools = options.tools === true;

  const head = [
    "<team-bus>",
    "你可以**主动给团队里其他成员发消息**（也可以发给主智能体）。这不是官方的子智能体通道 ——",
    "你们各自是独立的会话，所以通信靠聊天室 + 一个**文件信箱**。",
  ];

  // 工具有没有，是两条完全不同的说明书。**没有就绝不提** ——
  // 让模型去找一个不存在的工具，比不给工具更糟。
  const preferTools = hasTools
    ? [
        "",
        "**首选：用工具（推荐）**",
        "",
        "  · 想**发给谁**（= @ 它）→ 调 `chatroom_send`：",
        `    - \`to\` 写成员名或标识都行；汇报给主智能体写 \`lead\`；要广播写 \`all\`。`,
        "    - 正文里说清：你做了什么、结果在哪、需要它做什么。",
        "  · 想**看看聊天室刚才发生了什么、有没有人点名叫你** → 调 `chatroom_read`。",
        "    （只读快照；点名给你的消息会标出来，也可以用 `only_mentions: true` 只看这些。）",
        "",
        "这条路上的失败会**明确告诉你原因和可选收件人**，所以优先用它。",
        "",
        "── 下面是备用通道（工具不可用时才用）──",
      ]
    : [];

  return [
    ...head,
    ...preferTools,
    "",
    `信箱根目录：${dir}`,
    `你自己的发件箱（你要发的消息写在这里；宿主读走后投递给对方，你不用去读它）：${myBox}`,
    "",
    "**要发消息给某人，就在你自己的发件箱里写一个文件**，路径形状固定：",
    "",
    `  ${myBox}\\<序号>-${mine}-<随机串>.json`,
    "",
    "文件内容必须是这个 JSON 形状：",
    "",
    '  { "to": "<收件人标识>", "text": "<消息正文>" }',
    "",
    `可选再加一个 "kind" 字段表示消息类型：\`"report"\`（完成汇报）/ \`"check"\`（请验收）/`,
    '`"task"\`（派活）/ `"note"\`（普通留言）。',
    "",
    "一个**能直接照抄**的例子：",
    "",
    `  用写文件工具往 \`${myBox}\\0001-${mine}-${"a1b2c3"}.json\` 写入：`,
    '  {"to":"<收件人标识>","kind":"report","text":"第 3 项已完成，结果已写入 report.md，请验收。"}',
    "",
    `当前可以发给（**这里要写标识**，不是中文名）：${targets}`,
    "",
    "**规则**：",
    "1. 写完文件就结束当前回合，宿主会在 1～2 秒内投递出去，不需要你自己去确认。",
    "2. `to` 必须是上面列出的**标识**之一，写错了这条消息会被丢弃并记进失败目录。",
    "3. 一次只写一个文件；要发多条就写多个文件，序号递增。",
    "4. **不要**把消息写进别人的信箱目录（写了会被当成别人发的），也不要自己创建目录（你的发件箱宿主会建）。",
    "5. 正文写清楚：你做了什么、结果在哪、需要对方做什么。它看不到你的上下文。",
    "</team-bus>",
  ].join("\n");
}

/**
 * 读取一个成员的待投递消息。
 *
 * ## 读完就删，语义是「至多一次」
 *
 * 不删的话同一条消息会被每轮轮询重复投递 —— 成员会被同一句话反复唤醒。
 * 所以约定：**投递成功或永久失败之后才删**；投递过程本身抛错时保留文件，
 * 下一轮重试（成员此刻可能正好不在线，`memberAgent` 会把它叫醒）。
 *
 * ⚠ 只认 `.json` 结尾、且能解析出 `to` 与 `text` 的文件。成员手滑写出来的
 * 其他文件（`.txt` / `.md`）**原地保留不删** —— 那是它的工作产物，
 * 我们没有理由替它清理工作目录。这是个刻意的宽容。
 *
 * @param rootDir - 插件数据目录。
 * @param memberKey - 收件成员名（= 信箱目录名）。
 * @param limit - 单轮最多取几条，防止成员一口气写几百个文件把宿主卡住。
 * @returns `[{file, message?, error?}]`，按文件名字典序（= 序号序）。
 */
export async function drainMailbox(rootDir, memberKey, limit = 20) {
  const box = mailboxOf(rootDir, memberKey);
  if (box === null) return [];

  let names;
  try {
    names = await fs.readdir(box);
  } catch (error) {
    // 目录不存在是**正常状态**（这个成员还没发过消息）。
    if (error?.code === "ENOENT") return [];
    return [];
  }

  const files = names
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort()
    .slice(0, limit);

  const out = [];
  for (const name of files) {
    const full = path.join(box, name);
    let raw;
    try {
      raw = await fs.readFile(full, "utf8");
    } catch {
      continue; // 读不到就当它不存在，下轮再看。
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      out.push({ file: full, error: { code: "BUS_BAD_JSON", message: error?.message ?? String(error) } });
      continue;
    }

    const to = typeof parsed?.to === "string" ? parsed.to.trim() : "";
    const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
    if (to === "" || text === "") {
      out.push({ file: full, error: { code: "BUS_BAD_SHAPE", message: "缺少 to 或 text 字段。" } });
      continue;
    }

    out.push({
      file: full,
      message: {
        to,
        text: text.slice(0, MAX_BUS_MESSAGE),
        kind: typeof parsed?.kind === "string" ? parsed.kind.trim().slice(0, 32) : "",
        at: typeof parsed?.at === "string" ? parsed.at : new Date().toISOString(),
      },
    });
  }
  return out;
}

/**
 * 删掉一条已处理的消息文件。
 *
 * @param file - `drainMailbox` 给出的绝对路径。
 */
export async function ackMailboxFile(file) {
  try {
    await fs.unlink(file);
  } catch {
    /* 已经不在就算了 —— 目的达成。 */
  }
}

/**
 * 把一条处理不了的消息挪进 `failed/`。
 *
 * **不删**：删了就只能靠日志查，用户看不到「为什么我发的消息没到」。
 * 挪到失败目录既让信箱干净，又留下物证。
 *
 * @param rootDir - 插件数据目录。
 * @param file - 消息文件绝对路径。
 * @param reason - 失败原因，写进同名的 `.reason.txt`。
 */
export async function failMailboxFile(rootDir, file, reason) {
  const failedDir = path.join(rootDir, MAILBOX_DIR, "failed");
  const base = `${Date.now()}-${path.basename(file)}`;
  try {
    await fs.mkdir(failedDir, { recursive: true });
    await fs.rename(file, path.join(failedDir, base));
    await fs.writeFile(path.join(failedDir, `${base}.reason.txt`), String(reason ?? ""), "utf8");
  } catch {
    // 挪不动就删掉，至少不占着轮询。
    await ackMailboxFile(file);
  }
}

/**
 * 确保所有成员的信箱目录存在。
 *
 * 宿主写不了别人的信箱（那是成员自己写的），但**目录必须先建好** ——
 * 成员用写文件工具时父目录不存在就失败了。
 *
 * @param rootDir - 插件数据目录。
 * @param memberKeys - 成员名列表。
 */
export async function ensureMailboxes(rootDir, memberKeys) {
  const created = [];
  for (const key of memberKeys) {
    const box = mailboxOf(rootDir, key);
    if (box === null) continue;
    try {
      await fs.mkdir(box, { recursive: true });
      created.push(box);
    } catch {
      /* 建不出来不致命：成员发消息时会自己失败并看到错误。 */
    }
  }
  return created;
}

/**
 * 让成员**直接给宿主（主智能体）**发消息用的收件人名。
 *
 * 成员写 `"to": "lead"` 就是这个 —— 宿主会把它当成「向主智能体汇报」，
 * 转而投递给当前聊天室的主智能体会话（如果有的话）。
 */
export const BUS_LEAD = "lead";

/**
 * 生成一个建议的消息文件名。
 *
 * @param memberKey - 发件成员名。
 * @returns 形如 `0001-bob-a1b2c3d4.json`。
 */
export function suggestBusFileName(memberKey) {
  const safe = safeMailboxName(memberKey) || "member";
  return `-${safe}-${randomUUID().slice(0, 8)}.json`;
}
