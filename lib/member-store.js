/**
 * 成员资料持久化（名字 + 头像 + 职责 + 它那个独立会话的身份）。
 *
 * 存储位置：`<数据目录>/members.json`，**不是** profile、不是 $DSH_HOME，
 * 卸载重装插件、切 profile 都不丢。
 *
 * 数据结构：
 * ```json
 * {
 *   "version": 1,
 *   "members": {
 *     "<memberKey>": {
 *       "displayName": "小柯",
 *       "duty": "负责行情播报",
 *       "avatar": { "kind": "emoji", "value": "🦊" },
 *       "sessionId": "session-<uuid>",
 *       "cwd": "D:\\\\Projects\\\\demo",
 *       "preset": "minimal",
 *       "updatedAt": "2026-09-27T00:00:00.000Z"
 *     }
 *   }
 * }
 * ```
 *
 * `memberKey` 用**成员名**（稳定标识），不用展示名 —— 改名字不能让资料丢失。
 *
 * ## 2026-09-27 起：成员 = 一个**独立的根会话**
 *
 * 之前成员是官方 Agent Teams 的 teammate（= Lead 的子会话），
 * 官方的 `sessionVisible()` 明确写着 `origin === "subagent"` 的会话
 * **永远不进左侧栏工作区树** —— 结果是用户能看见、却删不掉、管不了。
 * 现在改成我们自己起一个**顶层根会话**（`sessionId` / `cwd` / `preset` 三个字段），
 * 它就是一个普通对话：能在左栏看到、随时能删。
 *
 * ⚠ **本文件仍然是纯展示层 + 身份记录。** 不再往官方 Team 协议层写任何东西。
 *
 * 设计约束：
 * - **永不抛错**：读失败返回空库，写失败返回 ok:false，调用方自己决定怎么提示。
 *   一个存储故障不能让聊天室整个不可用。
 * - **原子写**：先写 `.tmp` 再 rename，避免断电/崩溃留下半个文件。
 * - **大小上限**：头像走内联数据时容易被塞进大图。data URL 的 base64
 *   相对原始字节有约 33% 膨胀，所以上限按「1 MiB 原图 → ~1.37 MiB base64」再留余量定。
 * - **合并写入**：只改职责时不能把头像抹掉，`set()` 走 `{...旧, ...新}`。
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * 头像原图上限：1 MiB。
 *
 * 与客户端 `client.js` 的 `AVATAR_MAX_BYTES` 对齐 —— 改一边必须改另一边，
 * 否则会出现「前端放过了、后端拒了」（或反之）的诡异体验。
 *
 * **客户端不做压缩**：超过 1 MiB 在选文件那一步就拒了，所以走到这里的
 * data URL 必然来自 ≤1 MiB 的原图。
 */
const AVATAR_MAX_BYTES = 1024 * 1024;

/**
 * 头像 value（data URL 字符串）的长度上限。
 *
 * ⚠ **base64 相对原始字节膨胀约 1/3**：1 MiB 原图编码后是
 * `ceil(1 MiB / 3) * 4` ≈ 1.33 MiB 的 base64，加上 `data:image/jpeg;base64,`
 * 前缀约 1.34 MiB。按 1.5 MiB 留余量，够放 1 MiB 的原图且不会误拒。
 */
const MAX_AVATAR_VALUE = Math.ceil(AVATAR_MAX_BYTES * 1.5);

/** 成员「专属指令」的长度上限。 */
const MAX_INSTRUCTIONS_LENGTH = 4_000;

/**
 * 交接说明（`handover`）的长度上限。
 *
 * ## 为什么是 12_000 字
 *
 * 交接说明要装下「做过什么 / 现状 / 待办 / 坑 / 关键锚点」五段 ——
 * 这是**提炼**而不是会话原文（原文动辄几十万字）。12_000 个字符
 * （中文约 36 KB UTF-8）足够写满五段、每段 2_400 字，
 * 又小到能整个塞进下一个会话的开场消息里。
 *
 * ⚠ 这里是**字符数**上限，字节上限由 `MAX_MEMBER_BYTES` 兜底
 *   （见下面那个常量的注释：已经把这 12_000 字按最坏情况 3 倍算进去了）。
 */
const MAX_HANDOVER_LENGTH = 12_000;

/** 交接说明里单个分段的长度上限（五段 × 2_400 ≈ 12_000）。 */
const MAX_HANDOVER_SECTION_LENGTH = 2_400;

/**
 * 「历史交接说明」最多留几条。
 *
 * 每一次「交替」都会产生一份新的交接说明。留全部的话，一个被交替过二十次的
 * 成员光这一项就有二十多万字 —— 而用户真正要看的是**最近那份**。
 * 旧的不是丢掉了：旧会话本身的完整日志一直在左侧栏，那才是历史的正本。
 */
const MAX_HANDOVER_HISTORY = 5;

/**
 * 一个成员最多记多少个「已归档会话」。
 *
 * 同理：只留最近的若干条，防一条成员资料无限膨胀。
 * ⚠ 被挤出这个列表**不等于**会话被删 —— 那个对话窗口还在左侧栏，
 *   一份日志都没少。这个列表的用途只有两个：界面上显示「它有过哪些旧会话」、
 *   以及诊断时能查。**它不作为「这条会话是不是已归档」的唯一依据**：
 *   真正的判据是「它不等于当前 `sessionId`」。
 */
const MAX_ARCHIVED_SESSIONS = 20;

/**
 * 单条成员资料允许的最大字节数。
 *
 * 头像是大头；专属指令与交接说明按**字节**算要乘 3（中文字符 UTF-8 一字 3 字节），
 * 留 4 倍余量兜住最坏情况，否则「存了 4000 字中文指令」会被这里误拒。
 *
 * ⚠ 2026-10-10 加上交接说明这一项：`MAX_HANDOVER_LENGTH` 同样是**字符**上限，
 *   所以和 `instructions` 走同一条乘 4 的算法。不加这一项的话，
 *   「写满 12_000 字中文交接说明」的成员会在保存时被拒 ——
 *   而那时新会话已经建好了（交替做到一半）。两边必须对齐。
 */
const MAX_MEMBER_BYTES =
  MAX_AVATAR_VALUE + 1024 + (MAX_INSTRUCTIONS_LENGTH + MAX_HANDOVER_LENGTH) * 4;

/** 展示名长度上限。 */
const MAX_NAME_LENGTH = 32;

/** 职责长度上限。官方 roster 的 `description` 上限是 200，本地覆写放宽到同量级。 */
const MAX_DUTY_LENGTH = 200;


/** 头像允许的形态。 */
const AVATAR_KINDS = new Set(["emoji", "text", "image"]);

/**
 * 交接说明的五个分段键。
 *
 * 顺序就是界面上的顺序，也是给上一个 AI 的写作顺序：
 * 做完的 → 现在的 → 还没做的 → 别踩的 → 去哪找。
 */
const HANDOVER_SECTIONS = ["done", "now", "todo", "pitfalls", "anchors"];

/** 图片头像只接受 data URL，别的形态（外链）一律丢弃。 */
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/u;

/**
 * 空资料库。
 *
 * @returns 全新的空库对象。
 */
function emptyStore() {
  return { version: 1, members: {} };
}

/**
 * 规范化一条「交接说明」。
 *
 * 交接说明由**被替代的那个 AI 成员自己写**（见 `lib/succession.js`），
 * 然后原样存进成员资料。这里的职责只有两条：
 *
 * 1. **截断**：任何字段都不能让一条成员资料无限膨胀（上限见文件头的常量）。
 * 2. **剔除空壳**：五段全空、正文也空的记录直接返回 null —— 存一条
 *    「看起来有交接、点开什么都没有」的记录比不存更糟。
 *
 * @param input - 调用方传来的原始对象。
 * @returns 规范化后的交接说明，或 null（完全没有内容）。
 */
function normalizeHandover(input) {
  if (input === null || typeof input !== "object") return null;
  const out = {};

  for (const field of ["bySessionId", "byName", "source", "createdAt", "acceptedAt", "title"]) {
    if (typeof input[field] === "string" && input[field].trim() !== "") {
      out[field] = input[field].trim().slice(0, 400);
    }
  }

  if (typeof input.text === "string") {
    const text = input.text.trim().slice(0, MAX_HANDOVER_LENGTH);
    if (text !== "") out.text = text;
  }

  // 五段结构化内容。键名固定（客户端与下一个会话都按这套键读）。
  if (input.sections !== null && typeof input.sections === "object") {
    const sections = {};
    for (const key of HANDOVER_SECTIONS) {
      const value = input.sections[key];
      if (typeof value !== "string") continue;
      const text = value.trim().slice(0, MAX_HANDOVER_SECTION_LENGTH);
      if (text !== "") sections[key] = text;
    }
    if (Object.keys(sections).length > 0) out.sections = sections;
  }

  // 「能不能用」——五段全空 / 没有正文 = 这就是一份空交接说明。
  // 只在**没有正文**时才算空：有正文（模型没按格式写）仍然是有用的东西。
  const sectionCount = out.sections === undefined ? 0 : Object.keys(out.sections).length;
  if (out.text === undefined && sectionCount === 0) {
    // 连正文带分段都没有 —— 但仍然要保住「谁写的、什么时候写的」这类元信息？
    // 不。那正是上面说的空壳记录：写着「已交接」却什么都没有，只会误导人。
    return null;
  }
  out.structured = sectionCount > 0;
  out.truncated = input.truncated === true;
  return out;
}

/**
 * 规范化「已归档会话」列表。
 *
 * ⚠ 列表本身**不是**「是否已归档」的判据（那个判据是「不等于当前 sessionId」）：
 *   它只是给人看的履历。所以要容忍它被截断、被写坏，不能因为这里出问题
 *   就把整条成员资料判为无效 —— 那才是真的会丢身份。
 *
 * @param input - 调用方传来的数组。
 * @returns 规范化后的列表（可能为空）。
 */
function normalizeArchived(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const row of input) {
    if (row === null || typeof row !== "object") continue;
    const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim().slice(0, 200) : "";
    if (sessionId === "") continue;
    const entry = { sessionId };
    if (typeof row.archivedAt === "string") entry.archivedAt = row.archivedAt.trim().slice(0, 40);
    // 同一条会话只留第一次出现的那一笔（幂等：重复交替不该堆重复项）。
    if (out.some((item) => item.sessionId === sessionId)) continue;
    out.push(entry);
    if (out.length >= MAX_ARCHIVED_SESSIONS) break;
  }
  return out;
}

/**
 * 规范化一条成员资料。非法字段被丢弃而不是让整次写入失败。
 *
 * @param input - 调用方传来的原始对象。
 * @returns 规范化后的资料，或 null（完全不可用时）。
 */
export function normalizeMember(input) {
  if (input === null || typeof input !== "object") return null;

  const out = {};

  if (typeof input.displayName === "string") {
    const name = input.displayName.trim().slice(0, MAX_NAME_LENGTH);
    if (name !== "") out.displayName = name;
  }

  if (typeof input.duty === "string") {
    const duty = input.duty.trim().slice(0, MAX_DUTY_LENGTH);
    // 空串是合法输入 —— 表示"清掉覆写，回退官方 description"。
    out.duty = duty;
  }

  // ── 专属指令（成员级「技能 / 规则」文本）─────────────────────
  //
  // 官方 `spawnTeammate` 只透传 `{prompt, parent}` 给 `subagents.startContinuable`，
  // **不支持**成员级的 model / toolFilter / persona（那些要直接调 startContinuable）。
  // 所以「让不同的 AI 用不同的技能」在当前官方 API 下**只能通过创建时的 prompt**
  // 落地 —— 这里存的这段文本会在 spawn 时拼进 teammate 的第一条消息。
  //
  // ⚠ 因此它是**创建期配置**：改了已存在成员的指令，得重建该成员才生效。
  // 这一点必须在界面上讲清楚，不能让用户以为改完立刻有效。
  if (typeof input.instructions === "string") {
    // 空串同样是合法输入 —— 语义是「清掉这条指令」。
    out.instructions = input.instructions.trim().slice(0, MAX_INSTRUCTIONS_LENGTH);
  }

  const avatar = input.avatar;
  if (avatar === null) {
    // 显式清空头像（回到首字母兜底）。`set()` 会把这个信号摘出来单独处理。
    out.avatar = null;
  } else if (typeof avatar === "object") {
    const kind = typeof avatar.kind === "string" ? avatar.kind : "";
    const value = typeof avatar.value === "string" ? avatar.value : "";

    // 超限是**调用方的错**，必须报错而不是静默丢 ——
    // 静默丢会出现「保存成功但头像没了」这种最难查的体验：
    // 服务端返回 ok，用户以为存上了，实际落库时那一项被丢掉了。
    if (value !== "" && value.length > MAX_AVATAR_VALUE) {
      // ⚠ 三个字段都要给（`code` / `params` / `error`）：
      //   - `code` 是**稳定码**，客户端拿它查自己的 zh / en 字典 —— host 拿不到
      //     界面语言（`ctx.locale` 是客户端半的服务），所以文案的真正来源在那边；
      //   - `params` 让**具体原因不丢**：尺寸与上限必须进界面，不能被一句
      //     「保存失败」替掉。上一轮就是在这里退化的（用户只看到
      //     「保存成员失败」，看不见「3.2 MB > 2.0 MB」）；
      //   - `error` 是**英文兜底**，老字段照旧保留：老客户端 / 日志 / `curl`
      //     以及「客户端还没有这个码的字典项」时都要靠它。
      return {
        code: "TEAMCHAT_AVATAR_TOO_LARGE",
        params: {
          size: (value.length / 1024 / 1024).toFixed(2),
          max: (MAX_AVATAR_VALUE / 1024 / 1024).toFixed(1),
        },
        error: `Avatar data is too large (${(value.length / 1024 / 1024).toFixed(2)} MB > ${(MAX_AVATAR_VALUE / 1024 / 1024).toFixed(1)} MB).`,
      };
    }

    const okValue =
      value !== "" &&
      value.length <= MAX_AVATAR_VALUE &&
      (kind !== "image" || IMAGE_DATA_URL.test(value));
    // 形态不受支持（比如 image 传了个外链）→ 丢弃这一项而不是留坏值给 <img> 炸掉。
    // 这与上面的"超限报错"是两回事：形态错是噪声，超限是信号。
    if (AVATAR_KINDS.has(kind) && okValue) {
      out.avatar = { kind, value };
    }
  }

  // ── 独立会话身份（2026-09-27 起）───────────────────────────
  //
  // 成员不再是 Lead 的子会话，而是**一个独立的根会话**：
  //   `sessionId`  那个会话的 id（`session-<uuid>`），删/开/发消息全靠它
  //   `cwd`        它挂在哪个工作目录下 —— 成员按工作区归属，不跨区串
  //   `preset`     创建时选的「模式」（官方 Agent 预设 id），恢复会话时要用同一个
  //
  // ⚠ 这三个字段由**宿主侧**写入（`set()` 的调用点），不是用户编辑的。
  //    但它们必须走同一条规范化路径，否则重新加载时会被 `normalizeMember` 丢掉
  //    —— 那会让成员"失忆"成一条没有会话的孤儿资料。
  if (typeof input.sessionId === "string") {
    const sessionId = input.sessionId.trim().slice(0, 200);
    if (sessionId !== "") out.sessionId = sessionId;
  }
  if (typeof input.cwd === "string") {
    const cwd = input.cwd.trim().slice(0, 1_000);
    if (cwd !== "") out.cwd = cwd;
  }
  if (typeof input.preset === "string") {
    const preset = input.preset.trim().slice(0, 100);
    // 空串是合法输入 —— 表示「跟随」
    out.preset = preset;
  }
  // 这个成员属于**哪个聊天室**（= 创建它的那个会话）。聊天室的成员名单按它筛。
  if (typeof input.roomSessionId === "string") {
    const room = input.roomSessionId.trim().slice(0, 200);
    if (room !== "") out.roomSessionId = room;
  }

  // ── 房间归属：**工作区目录**（2026-10-08 语义修正）─────────────
  //
  // 用户的心智是「同一个工作区（工作室）里的窗口共享一个聊天室」。
  // 之前房间标识用的是**会话 id**，而且 spawn 里还写反了（用被收编的窗口
  // 当房间），于是「在 A 里收编 B」会把 B 记进 B 自己的房间 ——
  // A 的成员面板永远看不到它。
  //
  // 现在按 cwd 归房。`roomSessionId` 保留（诊断 + 兼容旧记录）。
  if (typeof input.roomCwd === "string") {
    const roomCwd = input.roomCwd.trim().slice(0, 400);
    if (roomCwd !== "") out.roomCwd = roomCwd;
  }

  // ── 主智能体标记（2026-09-27 起）────────────────────────────
  //
  // 用户的协作语义：**一个主智能体坐镇指挥 + 若干执行成员**。
  // 主智能体负责分配任务、接收汇报、检查产出；执行成员干完活回报给它。
  //
  // 一个聊天室**只允许一个**主智能体（否则汇报没有唯一去处）。
  // 唯一性由宿主在 spawn 路由里保证，这里只负责如实存取这个布尔。
  //
  // ⚠ 只有**显式**传了布尔才写。不写 `Boolean(input.isLead)` ——
  //    那样任何一次不带该字段的 `set()`（比如改头像）都会把主智能体降级掉。
  if (typeof input.isLead === "boolean") out.isLead = input.isLead;

  // ── 交接（succession，2026-10-10）────────────────────────────
  //
  // 「交替」= 给这个成员换一个全新的会话，身份/职责/指令原样继承，
  // 并且把**上一个会话里的那个 AI 自己写的交接说明**带过去。
  //
  //   handover          当前生效的那份交接说明（新会话开场消息的来源）
  //   handoverHistory   之前几份（可回看；上限 MAX_HANDOVER_HISTORY）
  //   archivedSessions  被交替掉的旧会话（**归档 ≠ 删除**：会话本体一个都没少）
  //   handedOverFrom    这一任是从哪个会话接过来的（可追溯）
  //
  // ⚠ 这四个字段一律由宿主侧写入（`/__teamchat/succession`），界面不直接编辑。
  //   名称里带 "Handover" 的那个走 normalizeHandover 的截断；
  //   列表类字段走 normalizeArchived / 数组截断 —— 都不能让一条资料无限膨胀。
  if (typeof input.handedOverFrom === "string") {
    const from = input.handedOverFrom.trim().slice(0, 200);
    if (from !== "") out.handedOverFrom = from;
  }
  {
    // ⚠⚠ `handover: null` 必须在**规范化这一层**就认出来并保留，
    //    否则它会被当成「没有这个字段」丢掉 —— 而 `set()` 里那条
    //    `clearHandover` 判据是看 `member.handover === null`，
    //    信号在中途丢了，`set()` 永远等不到它。
    //
    //    这正是 `avatar: null` 的处理方式（见上面 avatar 那一段：
    //    先 `out.avatar = null`，再由 `set()` 摘出来）。
    //    第一版这里只写 `if (handover !== null) out.handover = handover`
    //    —— 于是「这次没写出交接说明」被静默吞掉，
    //    磁盘上留着**上一任**的那份，下一个会话会把它当成最新的。
    //    这个 bug 是被 smoke-succession 的 B7 抓出来的。
    if (input.handover === null) {
      out.handover = null;
    } else {
      const handover = normalizeHandover(input.handover);
      if (handover !== null) out.handover = handover;
    }
  }
  if (input.handoverHistory !== undefined) {
    const history = Array.isArray(input.handoverHistory)
      ? input.handoverHistory
          .map((row) => normalizeHandover(row))
          .filter((row) => row !== null)
          .slice(0, MAX_HANDOVER_HISTORY)
      : [];
    // 空数组是**合法输入**（显式清空履历），所以照写不误。
    out.handoverHistory = history;
  }
  if (input.archivedSessions !== undefined) {
    out.archivedSessions = normalizeArchived(input.archivedSessions);
  }

  if (Object.keys(out).length === 0) return null;
  out.updatedAt = new Date().toISOString();
  return out;
}

/**
 * 成员资料库。
 *
 * 一次性读入内存，写时整体落盘。成员数量是个位数，
 * 不值得为增量写引入复杂度。
 */
export class MemberStore {
  /**
   * @param dataDir - 数据目录（由 host 侧解析后传入）。
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "members.json");
    /** @type {{version: number, members: Record<string, object>}} */
    this.state = emptyStore();
    this.loaded = false;
    /** 最近一次失败原因，供诊断路由读取。 */
    this.lastError = null;
  }

  /**
   * 从磁盘加载。**不抛错**：失败时保留空库并记下原因。
   *
   * @returns 加载是否成功。
   */
  async load() {
    try {
      const text = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.members === "object") {
        const members = {};
        for (const [key, value] of Object.entries(parsed.members)) {
          if (typeof key !== "string" || key === "") continue;
          const member = normalizeMember(value);
          if (member !== null) members[key] = member;
        }
        this.state = { version: 1, members };
      } else {
        this.state = emptyStore();
      }
      this.loaded = true;
      this.lastError = null;
      return true;
    } catch (error) {
      // ENOENT 是首次运行的正常情况，不算错误。
      if (error?.code !== "ENOENT") {
        this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
      }
      this.state = emptyStore();
      this.loaded = true;
      return error?.code === "ENOENT";
    }
  }

  /**
   * 原子写盘。
   *
   * @returns {{ok: boolean, code?: string, params?: object, error?: string}}
   */
  async save() {
    const tmp = `${this.file}.tmp`;
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const text = JSON.stringify(this.state, null, 2) + "\n";
      await fs.writeFile(tmp, text, "utf8");
      await fs.rename(tmp, this.file);
      this.lastError = null;
      return { ok: true };
    } catch (error) {
      // 清理临时文件，失败也无所谓。
      try {
        await fs.rm(tmp, { force: true });
      } catch {
        /* ignore */
      }
      this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
      // 落盘失败也走「码 + params + 英文兜底」：`detail` 是**运行时原文**
      // （`ENOSPC: no space left on device` 这种），它不是给人读的操作引导，
      // 但不能丢 —— 丢了用户就没法判断是磁盘满、没权限还是路径不对。
      return {
        ok: false,
        code: "TEAMCHAT_MEMBER_WRITE_FAILED",
        params: { detail: this.lastError },
        error: `Could not write the member file: ${this.lastError}`,
      };
    }
  }

  /**
   * 读取全部成员资料。
   *
   * @returns 成员映射的浅拷贝。
   */
  all() {
    return { ...this.state.members };
  }

  /**
   * 取单条。
   *
   * @param key - 成员键。
   * @returns 资料或 undefined。
   */
  get(key) {
    return this.state.members[key];
  }

  /**
   * 写入/更新一条成员资料。
   *
   * @param key - 成员键（稳定标识）。
   * @param input - 原始资料。
   * @returns {{ok: boolean, member?: object, code?: string, params?: object, error?: string}}
   */
  async set(key, input) {
    if (typeof key !== "string" || key.trim() === "") {
      return { ok: false, code: "TEAMCHAT_MEMBER_KEY_EMPTY", error: "The member key is empty." };
    }
    const cleanKey = key.trim().slice(0, 200);

    const member = normalizeMember(input);
    if (member === null) {
      return { ok: false, code: "TEAMCHAT_MEMBER_NO_FIELDS", error: "There are no fields to save." };
    }
    // `normalizeMember` 对**超限**这类「调用方错误」返回 `{code, params, error}`，
    // 而不是静默丢弃那一项 —— 静默丢会变成「保存成功但头像没了」。
    // ⚠ `params` 必须一起透传：只说「保存失败」等于把「哪里超了、超了多少」
    //   这条信息抹掉（上一轮就是这么退化的）。
    if (typeof member.error === "string") {
      return {
        ok: false,
        code: member.code ?? "TEAMCHAT_MEMBER_NO_FIELDS",
        params: member.params,
        error: member.error,
      };
    }

    // `avatar: null` 是显式清空信号。先摘出来，否则 `{...previous, ...member}`
    // 会把它当成一个真值属性塞进记录里，落盘后再读回就成了 `avatar: null` 脏数据。
    const clearAvatar = member.avatar === null;
    if (clearAvatar) delete member.avatar;

    // `handover: null` 同理 —— 是「显式清掉当前这份交接说明」的信号，
    // 与 `avatar: null` 走完全一样的一条路（摘出来 → 合并后 delete）。
    //
    // ⚠ 什么时候会用到它：一次交替**没能生成**新的交接说明（两条路都失败）。
    //   那时如果留着上一份不动，下一个会话的开场消息里就会出现一份
    //   **上一任的**交接说明被当成最新的 —— 那是实打实的误导。
    //   所以「这一次没写出来」要如实落成「当前没有交接说明」，
    //   而旧的那一份已经进了 `handoverHistory`（历史不丢）。
    const clearHandover = member.handover === null;
    if (clearHandover) delete member.handover;

    if (Object.keys(member).length === 0 && !clearAvatar && !clearHandover) {
      return { ok: false, code: "TEAMCHAT_MEMBER_NO_FIELDS", error: "There are no fields to save." };
    }

    const size = Buffer.byteLength(JSON.stringify(member), "utf8");
    if (size > MAX_MEMBER_BYTES) {
      // 同上面那条：码 + params（上限必须进界面）+ 英文兜底，三条一起给。
      // ⚠ 这条是**兜底**，平时先被 `MAX_AVATAR_VALUE` 那条拦下；只有
      //   头像没超而其它字段（指令 / 交接说明 / 归档履历）撑爆时才轮到它，
      //   所以文案里要把「含头像 base64 膨胀」这个口径一起说出来。
      return {
        ok: false,
        code: "TEAMCHAT_MEMBER_TOO_LARGE",
        params: { max: (MAX_MEMBER_BYTES / (1024 * 1024)).toFixed(1) },
        error: `This member profile exceeds ${(MAX_MEMBER_BYTES / (1024 * 1024)).toFixed(1)} MB (including the avatar's base64 expansion).`,
      };
    }

    // 合并而不是替换：只改名字时不该把头像抹掉。
    const previous = this.state.members[cleanKey];
    const merged = { ...(previous ?? {}), ...member };
    if (clearAvatar) delete merged.avatar;
    if (clearHandover) delete merged.handover;

    // 合并后只剩 `updatedAt` 说明这次请求没有产生任何可保留的字段
    // （典型情形：对一个还没有资料的成员发 `{avatar: null}`）。
    // 这种记录落盘只会在磁盘上留一条垃圾，直接当无效输入拒掉。
    if (Object.keys(merged).filter((field) => field !== "updatedAt").length === 0) {
      return { ok: false, code: "TEAMCHAT_MEMBER_NO_FIELDS", error: "There are no fields to save." };
    }

    this.state.members[cleanKey] = merged;

    const saved = await this.save();
    if (!saved.ok) {
      // 落盘失败就回滚内存，避免内存与磁盘不一致。
      if (previous === undefined) delete this.state.members[cleanKey];
      else this.state.members[cleanKey] = previous;
      // `code` / `params` 一起往上带：路由层要拿它们进响应体。
      return {
        ok: false,
        code: saved.code ?? "TEAMCHAT_MEMBER_WRITE_FAILED",
        params: saved.params,
        error: saved.error,
      };
    }
    return { ok: true, member: merged };
  }

  /**
   * 删除一条成员资料。
   *
   * @param key - 成员键。
   * @returns {{ok: boolean, code?: string, params?: object, error?: string}}
   */
  async remove(key) {
    if (typeof key !== "string" || !(key in this.state.members)) {
      return { ok: true };
    }
    const previous = this.state.members[key];
    delete this.state.members[key];
    const saved = await this.save();
    if (!saved.ok) {
      this.state.members[key] = previous;
      // 同 `set()`：码与 params 一起带上去（路由层据此让界面说清原因）。
      return {
        ok: false,
        code: saved.code ?? "TEAMCHAT_MEMBER_WRITE_FAILED",
        params: saved.params,
        error: saved.error,
      };
    }
    return { ok: true };
  }

  /**
   * 列出**已经有自己会话**的成员（= 真正的 AI 成员）。
   *
   * 只有资料、还没建会话的条目（`sessionId` 缺失）是「预配的成员资料」，
   * 不算成员 —— 它们在设置页里可以配，但名单/投递都不该带上它们
   * （没有会话就没地方投消息）。
   *
   * @param filter - `{room?, cwd?}`：按所属聊天室会话 / 工作目录筛；缺省不筛。
   * @returns `[{key, ...profile}]`。
   */
  listActive(filter = {}) {
    const room = typeof filter.room === "string" && filter.room !== "" ? filter.room : null;
    const cwd = typeof filter.cwd === "string" && filter.cwd !== "" ? filter.cwd.toLowerCase() : null;
    const out = [];
    for (const [key, profile] of Object.entries(this.state.members)) {
      if (typeof profile?.sessionId !== "string" || profile.sessionId === "") continue;
      if (room !== null) {
        // 兼容两代记录：新记录按 `roomCwd`（工作区）归房；
        // 旧记录没有它 → 用**成员自己的工作区**兜底（老语义下
        // 「房间 = 被收编的窗口自己」，两者 cwd 通常一致，不需要迁移脚本）；
        // 再兜一层 `roomSessionId`，让「按会话 id 筛」的旧调用方也能命中。
        const byCwd =
          typeof profile.roomCwd === "string" && profile.roomCwd !== ""
            ? profile.roomCwd
            : String(profile.cwd ?? "");
        const bySession = typeof profile.roomSessionId === "string" ? profile.roomSessionId : "";
        if (byCwd.toLowerCase() !== room.toLowerCase() && bySession !== room) continue;
      }
      if (cwd !== null && String(profile.cwd ?? "").toLowerCase() !== cwd) continue;
      out.push({ key, ...profile });
    }
    return out;
  }

  /**
   * 诊断用：数据目录、文件路径、条数、最近错误。
   *
   * @returns 诊断信息。
   */
  describe() {
    return {
      dataDir: this.dataDir,
      file: this.file,
      memberCount: Object.keys(this.state.members).length,
      activeCount: this.listActive().length,
      lastError: this.lastError,
    };
  }
}

export {
  MAX_MEMBER_BYTES,
  MAX_NAME_LENGTH,
  MAX_DUTY_LENGTH,
  MAX_HANDOVER_LENGTH,
  MAX_HANDOVER_SECTION_LENGTH,
  MAX_HANDOVER_HISTORY,
  HANDOVER_SECTIONS,
};
