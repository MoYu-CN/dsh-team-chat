import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  TIMELINE_PROJECTION_KEY,
  createTimelineProjection,
} from "./timeline-projection.js";
import { MemberStore, MAX_MEMBER_BYTES } from "./member-store.js";
import { RoomLog } from "./room-log.js";
import { createRoomTools } from "./room-tools.js";
import {
  adoptMember,
  deliverToMember,
  renameTitle,
} from "./member-runtime.js";
import { runSuccession } from "./succession.js";
import {
  BUS_LEAD,
  MAILBOX_DIR,
  ackMailboxFile,
  buildBusProtocol,
  drainMailbox,
  ensureMailboxes,
  failMailboxFile,
  safeMailboxName,
} from "./team-bus.js";

/**
 * dsh-team-chat — host 侧入口。
 *
 * 职责：
 * 1. 注册自有 timeline 投影，接住官方丢弃的 mailbox 消息事件
 * 2. 通过 webServer 暴露 SSE，把时间线实时推给浏览器
 * 3. tapIndex 注入客户端 bundle
 * 4. 成员资料（展示名/职责/头像）读写，以及「添加 AI 成员」的 spawn 代理
 *
 * 安全模型：
 * - `webServer.register` 的路由本身没有内置鉴权，全靠自己。
 * - 三个浏览器面路由（client.js / events / timeline）统一要求**同源**；
 *   DSH 面板本来就跑在同源页面里，足以挡住任何跨站页面。
 * - 客户端脚本走 `<script src>`、事件流走 `EventSource` ——
 *   两者都**无法携带自定义请求头**，所以这里**不能**用 Bearer token 卡它们，
 *   否则实际效果是浏览器 401、面板永远空白。token 只用于非浏览器调用方。
 *
 * 关于 `agentTeams` 依赖：
 * 官方 Team 服务的 `spawnTeammate` 只能在**宿主侧**调，且要求 caller 是
 * **精确的 live Lead Agent 对象**（`ctx.agents.get(agent.id) !== agent` 会直接拒）。
 * 客户端跨端拿不到这个对象，所以「添加 AI 成员」必须由这里代理。
 * 该服务不是本插件的硬依赖 —— 声明在 `inject` 里但**允许缺失**，
 * 缺失时 `/__teamchat/spawn` 返回 `TEAM_UNAVAILABLE`，客户端降级为引导提示。
 */

export const name = "team-chat";
export const inject = ["webServer", "sessionProjections"];

const here = path.dirname(fileURLToPath(import.meta.url));

/** 数据目录名（放在 DSH 安装目录下）。 */
const DATA_DIR_NAME = ".dsh-team-chat-data";

/**
 * 持久化数据目录。
 *
 * 目标位置：**DSH 安装目录**下的独立数据文件夹，
 * 即 `<DSH 安装目录>/.dsh-team-chat-data/`。
 * 放这里而不是 $DSH_HOME / profile，是为了卸载重装插件、切换 profile 都不丢数据。
 *
 * 推导顺序（逐个探测，第一个命中的胜出）：
 * 1. 环境变量 `DSH_TEAM_CHAT_DATA` —— 显式覆盖，测试/多实例用
 * 2. 从 `process.argv[1]` / `process.execPath` 推导安装根：
 *    主程序形态 `<install>\DSH Desktop.exe`
 *    子进程形态 `<install>\resources\app.asar.unpacked\node_modules\node\bin\node.exe`
 * 3. 环境变量 `DSH_INSTALL_DIR` —— 若 DSH 后续提供
 * 4. 兜底：插件包目录的上级
 *
 * **不抛错**：任何一步不命中都往下走，兜底一定可写。
 *
 * @returns 数据目录绝对路径。
 */
function resolveDataDir() {
  const explicit = process.env.DSH_TEAM_CHAT_DATA;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return path.resolve(explicit.trim());
  }

  for (const candidate of [process.argv[1], process.execPath]) {
    if (typeof candidate !== "string" || candidate === "") continue;
    const dir = path.dirname(path.resolve(candidate));
    // 子进程形态：截到 `<install>` 为止
    const marker = `${path.sep}resources${path.sep}`;
    const at = dir.indexOf(marker);
    if (at > 0) return path.join(dir.slice(0, at), DATA_DIR_NAME);
    // 主程序形态：exe 与安装根同级
    const exeName = path.basename(candidate).toLowerCase();
    if (exeName.startsWith("dsh")) return path.join(dir, DATA_DIR_NAME);
  }

  const installDir = process.env.DSH_INSTALL_DIR;
  if (typeof installDir === "string" && installDir.trim() !== "") {
    return path.join(path.resolve(installDir.trim()), DATA_DIR_NAME);
  }

  return path.resolve(here, "..", "..", DATA_DIR_NAME);
}

/** 成员资料文件名。 */
const MEMBERS_FILE = "members.json";

/** 客户端脚本的挂载路径。 */
const CLIENT_SCRIPT_PATH = "/__teamchat/client.js";
/** 事件流的挂载路径。 */
const EVENTS_PATH = "/__teamchat/events";
/** 时间线快照（非流）路径，供面板初次加载。 */
const TIMELINE_PATH = "/__teamchat/timeline";
/** 配置握手路径：把 bundle 名交给宿主，避免浏览器侧硬编码。 */
const CONFIG_PATH = "/__teamchat/config";

/** 客户端错误上报路径（诊断用；默认静默，只在真出错时打日志）。 */
const REPORT_PATH = "/__teamchat/report";

/** 成员资料（名字 + 职责 + 头像）读写路径。GET 全量，POST 写入/删除。 */
const MEMBERS_PATH = "/__teamchat/members";

/**
 * members 路由的请求体上限。
 *
 * ⚠ **必须由 `MAX_MEMBER_BYTES` 推导，不能另写一个数字。**
 *
 * 这里踩过一次实锤：头像上限从 60 KiB 提到 1 MiB 时改了 `member-store.js`，
 * 但路由层这句还是老的 `131_072`（128 KiB）没动 —— 结果客户端明明放行
 * 600 KB 的图，编码成 base64（≈800 KB）发过来被这里 413 掐掉，
 * 用户看到「请求体过大」，而两边的常量各自看着都"对"。
 *
 * 单一真相源在 `member-store.js`，这边只加 JSON 包装余量。
 */
const MEMBERS_BODY_LIMIT = MAX_MEMBER_BYTES + 4096;

/**
 * 「添加 AI 成员」路径。
 *
 * 官方只允许宿主侧用**精确 live Lead Agent 对象**调 `spawnTeammate`，
 * 客户端拿不到这个对象，所以必须经这里代理。
 * 失败一律返回结构化 `code`，客户端据此决定是报错还是降级成引导提示。
 */
const SPAWN_PATH = "/__teamchat/spawn";
/** 【临时探针】独立根会话可行性验证用；只在 `TEAM_CHAT_SPIKE=1` 时注册。验完删。 */
const SPIKE_PATH = "/__teamchat/spike";

/**
 * 可作为 Team Lead 的会话清单（客户端「新建 AI 成员」的挂载点选择器用）。
 *
 * 官方只允许 **root 会话**（`session.header.parentSession === undefined`）当 Lead，
 * 子会话不能再生子会话当 Lead 用。所以这里只回 root。
 */
const TARGETS_PATH = "/__teamchat/targets";

/**
 * 官方 Agent 预设清单（「模式」选择器用）。
 *
 * 本机实测官方附带 4 个：`standard`(标准模式) / `ptc` / `minimal`(极简模式) / `cordis`。
 * 名字走客户端字典（宿主 `list()` 返回的 `name` 通常是空的）。
 */
const PRESETS_PATH = "/__teamchat/presets";

/**
 * 同一对「会话 / 目标标题」的最短重写间隔。
 *
 * ⚠ 为什么非要有这道闸门：`rename` **每次**都会往会话日志里追加一条
 *   `session/title` 事件，而我们又在 `session/event` 里监听这条事件、再改一次。
 *   官方提供的幂等判据是「读快照比对」（`titles.get()?.title === wanted`），
 *   可一旦快照有延迟或读回来是别的值，这条链就是**永动机**：
 *       rename → session/title 事件 → rename → 事件 → ……
 *   表象：会话被几百毫秒一次地反复写入 ⇒ 会话 store 反复失效 ⇒ 视图重挂载，
 *   视图区在重挂载那几帧里是空的 ⇒ 输入框塌到最上面（2026-10-10 用户报的现象，
 *   日志里每次 top=910 变成 top=116 都紧跟在「修正了 N 个成员的窗口标题」之后）。
 *
 *   冷却期内**直接跳过**（既不写事件，也不再读快照比对），把回路切断。
 *   目标标题真变了（用户改了成员名）则不受冷却限制，立刻写。
 */
const TITLE_WRITE_COOLDOWN_MS = 10_000;

/** `sessionId -> {wanted, at}`：最近一次我们**主动**写入的目标标题。 */
const recentTitleWrites = new Map();

/**
 * 「把成员会话标题同步到成员名」的**唯一入口**。
 *
 * 所有改标题的地方（后台批量刷新、`session/title` 事件的即时纠正）
 * 都必须走这里，否则闸门就是摆设。
 *
 * @param ctx - 宿主上下文。
 * @param sessionId - 成员会话。
 * @param displayName - 成员显示名（可空，空则退到 fallback）。
 * @param fallback - 成员标识。
 * @param force - 是否覆盖手动改过的标题。
 * @returns 是否真的改了（Promise<boolean>）。
 */
function syncMemberTitle(ctx, sessionId, displayName, fallback, force = false) {
  const trimmed = typeof displayName === "string" ? displayName.trim() : "";
  const wanted = trimmed !== "" ? trimmed : fallback;
  if (typeof wanted !== "string" || wanted === "" || typeof sessionId !== "string") {
    return Promise.resolve(false);
  }
  const now = Date.now();
  const prev = recentTitleWrites.get(sessionId);
  if (prev !== undefined && prev.wanted === wanted && now - prev.at < TITLE_WRITE_COOLDOWN_MS) {
    return Promise.resolve(false); // 冷却中 —— 这一跳就是永动机的断点
  }
  recentTitleWrites.set(sessionId, { wanted, at: now });
  return renameTitle(ctx, sessionId, displayName, fallback, force);
}

/**
 * 批量修正成员会话标题（把官方自动生成的「首条消息截断」换成成员名）。
 *
 * `GET` / `POST` 都收 —— 方便直接 curl 验证，也方便以后接一个「修复」按钮。
 */
const REFRESH_TITLES_PATH = "/__teamchat/refresh-titles";

/**
 * 团队里**真实存在的成员名**清单（左侧栏「每个成员一行」用的第二个数据源）。
 *
 * 为什么需要：本地成员资料表是「用户配过的」，不是「真实存在的」——
 * 没配过资料的成员（比如直接在会话里用「添加 AI 成员」建的）不会出现在里面。
 * 这里从 live 的根会话团队名单里捞，两边的并集才是用户心里的「我的 AI 成员」。
 *
 * ⚠ 没有 live 会话时返回空数组 —— 客户端会退回只用资料表，不会把列表清空。
 */
const TEAM_MEMBERS_PATH = "/__teamchat/team-members";

/**
 * 给**成员**发消息（默认广播 / @ 定向）。
 *
 * ⚠ 官方 mailbox 是**严格点对点**的：`sendAdmitted` 里每条消息只带一个
 * `targetId`（`resolveActiveMember(root, state, request.target)`），**没有广播入口**。
 * 所以「默认所有成员都收到」只能在这边**循环发 N 条**。
 *
 * ⚠ 还要知道成本：官方的投递对**正在跑的**成员是 `steer`（立刻唤醒跑一轮），
 * 对**没在跑的**只是进队列等它下次被唤醒。所以广播一条 = 最多 N 个成员各跑一轮。
 */
const SEND_PATH = "/__teamchat/send";

/** 单条团队消息的请求体上限。 */
const SEND_BODY_LIMIT = 64 * 1024;

/**
 * 「发送到团队」的当前范围 —— **官方输入框发出去的那条消息额外投给谁**。
 *
 * 用户在官方输入框左侧点「发送到团队」选完范围后，客户端 POST 到这里；
 * 宿主记住（`sessionId -> 成员名`，空串 = 所有人），等该会话出现**下一条真人消息**
 * （`source.kind === "user"`）时按范围投递，投完**立即清除**（一次性）。
 *
 * ⚠ **消息同时也会进 Lead 的 inbox** —— 官方输入框发出的消息我们拦不住。
 * 所以准确语义是「这条消息**额外**投给这些成员」，Lead 照样会看到。
 * （换成自绘输入框能避开这点，但那样就没有附图 / 附件能力了 —— 用户明确选了这一条。）
 */
const SCOPE_PATH = "/__teamchat/scope";

/**
 * 移除成员。
 *
 * ⚠ 官方协议里**删不掉**：团队事件只有 `team/member`，成员状态只能在
 * `provisioning → active / failed` 之间走，**没有删除事件**；
 * 官方给 Lead 的工具也只有 spawn / send / interrupt / list / wait / task_*，没有 remove。
 *
 * 所以这里做的是能做到的那部分：`stopTeammates` 释放它的运行 + 记进本地的
 * 「已移除」名单（本插件所有界面不再列出它）。**官方那两处仍会列着它**
 * （头部「N 个子智能体」目录、Lead 的 `list_agents`）—— 它们读的是父会话日志里
 * append-only 的事件，改不了。
 */
const REMOVE_PATH = "/__teamchat/remove";

/**
 * 成员「交替」（交接 / succession）。
 *
 * 给一个成员**换一个全新的会话**：旧会话里那个 AI 自己写一份交接说明，
 * 新会话继承它的身份 / 职责 / 专属指令并把交接说明当开场消息读，
 * 旧会话归档（**不是删除**）。
 *
 * 实现全在 `lib/succession.js`；这条路由只负责「解析请求 → 调它 → 回执」。
 * 回执里 `handover.source` 如实标明那份说明是**谁**写的：
 *   `member` = 旧会话里的 AI 自己写的（主路径）
 *   `llm`    = 退路：读它的会话日志 + 调一次模型提炼
 *   `none`   = 两条路都失败，降级成空说明（交替照样成立）
 */
const SUCCESSION_PATH = "/__teamchat/succession";

/** 交替请求体上限。请求只有成员名与一个开关，给足余量。 */
const SUCCESSION_BODY_LIMIT = 4 * 1024;

/**
 * 「已移除」的成员名。
 *
 * 官方协议里成员删不掉（见 `REMOVE_PATH` 的说明），所以「移除」在本插件层面就是
 * **停止运行 + 记在这份名单里**。带持久化，重启之后照样不列出。
 *
 * 文件故意做得很小 —— 就一个名字数组，不值得上 MemberStore 那套校验/上限。
 * 但**原子写照抄**（先写 `.tmp` 再 rename），别留半个文件。
 */
class RemovedMembers {
  /**
   * @param dataDir - 插件数据目录。
   */
  constructor(dataDir) {
    this.file = path.join(dataDir, "removed-members.json");
    this.names = new Set();
  }

  /** @returns 名单快照（数组）。 */
  all() {
    return [...this.names];
  }

  /**
   * @param name - 成员名。
   * @returns 是否在这份名单里。
   */
  has(name) {
    return this.names.has(name);
  }

  /** 读盘。坏文件一律当空名单 —— 移除名单坏了不该让插件起不来。 */
  async load() {
    try {
      const text = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : parsed?.names;
      this.names = new Set((Array.isArray(rows) ? rows : []).filter((v) => typeof v === "string"));

      const entries = await fs.readdir(path.dirname(this.file)).catch(() => []);
      return entries.length > 0;
    } catch {
      this.names = new Set();
      return false;
    }
  }

  /**
   * 把成员加进名单并落盘。
   *
   * @param name - 成员名。
   * @returns 是否写成功（写失败不影响调用方，只是重启后会重现）。
   */
  async add(name) {
    this.names.add(name);
    const tmp = `${this.file}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify({ names: this.all() }, null, 2), "utf8");
      await fs.rename(tmp, this.file);
      return true;
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
      return false;
    }
  }

  /**
   * 把成员移出名单（以后又建了同名成员时用）。
   *
   * @param name - 成员名。
   * @returns 是否写成功。
   */
  async remove(name) {
    this.names.delete(name);
    const tmp = `${this.file}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify({ names: this.all() }, null, 2), "utf8");
      await fs.rename(tmp, this.file);
      return true;
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
      return false;
    }
  }
}

/**
 * 把一条文本投递给聊天室里的 AI 成员。
 *
 * - `target` 为空串 → **广播**：给名单里每个成员各发一条
 * - `target` 有值 → 只发给那一个，其他成员收不到、不会被唤醒
 *
 * ## 改版后（2026-09-27）：不再经过官方团队邮箱
 *
 * 成员现在是**独立的根会话**，投递 = 对那个会话的 agent `steer()` 一条消息
 * （见 `lib/member-runtime.js`）。两个直接好处：
 * 1. **不再需要 live 的 Lead agent** —— 老实现要求 caller 是精确的 live Lead，
 *    于是「Lead 会话没打开就发不出去」。
 * 2. 成员不在线时会被 `ensureSession` 叫醒，消息不会石沉大海。
 *
 * @param ctx - 宿主上下文。
 * @param store - MemberStore 实例。
 * @param roomId - 房间（= 当前会话）id，用来筛成员、也用来记时间线。
 * @param text - 消息正文。
 * @param target - 目标成员名；空串表示全部。
 * @param exclude - 要排除的成员名（= 「已移除」名单）。
 * @param onEntry - 每成功投出一条时回调，用于往房间时间线记一笔。
 * @returns `[{name, ok, status?, code?, error?}]`。
 */
/**
 * 把「会话 id」解析成**房间键**（= 工作区目录）。
 *
 * 用户的心智是「同一个工作区（工作室）里的窗口共享一个聊天室」，所以房间以 cwd
 * 为单位；调用方仍然传会话 id，由这里统一转换 —— 这样所有「按房间筛成员」的
 * 地方只要换一行，不必把会话 id 语义改成 cwd 而漏掉某处。
 *
 * ⚠ 解析不出来时**退回传进来的原值**（旧语义）：宁可暂时显示不出成员
 *   （还有日志可查），也不要静默退化成「不过滤」而把别的房间的成员混进来。
 *
 * ⚠ **先看「这个会话本身是不是某个成员的会话」** —— 是就返回**它所属的房间**。
 *   用户在 AI 成员自己的对话窗口里点成员列表时，看到的必须和房间里一样
 *   （他的要求：「在这个工作室的 AI 成员的对话里，点开列表会显示我们所有的
 *   AI 成员」）。而成员可能是从**别的工作区**收编进来的 —— 那种情况下它的
 *   cwd 与房间的 cwd 不同，只看 cwd 会把它指到另一个工作区去、什么都看不到。
 *
 * @param {object} ctx 宿主上下文。
 * @param {string} sessionId 会话 id。
 * @param {object} [members] 成员表（有就先查「它归哪个房间」，查不到再退回 cwd）。
 * @returns {string} 房间键（cwd，或退化的 sessionId）。
 */
function roomKeyOf(ctx, sessionId, members = null) {
  if (typeof sessionId !== "string" || sessionId === "") return sessionId;

  // ① 它本身是某个成员的会话吗？是 → 用**它所属的房间**。
  if (members !== null && typeof members.listActive === "function") {
    try {
      const own = members.listActive().find((row) => row.sessionId === sessionId);
      if (own !== undefined) {
        if (typeof own.roomCwd === "string" && own.roomCwd !== "") return own.roomCwd;
        if (typeof own.cwd === "string" && own.cwd !== "") return own.cwd;
      }
    } catch {
      /* 查不到就往下走 cwd 那条路 */
    }
  }

  // ② 否则按它的**工作目录**算（同目录下的窗口共享一个聊天室）
  let session = null;
  try {
    const sessions = ctx.get?.("sessions") ?? null;
    session = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
  } catch {
    /* 服务缺失 → 走下面 agents 那条路 */
  }
  if (session === undefined || session === null) {
    try {
      session = findLiveAgent(ctx.get?.("agents") ?? null, sessionId)?.session ?? null;
    } catch {
      session = null;
    }
  }
  const cwd = session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : sessionId;
}

async function deliverToMembers(ctx, store, roomId, text, target, exclude = [], onEntry = null) {
  // 房间 = 工作区（同目录下的窗口共享成员表）
  const roomKey = roomKeyOf(ctx, roomId, store);
  const roster = store
    .listActive({ room: roomKey })
    .filter((row) => !exclude.includes(row.key));
  const recipients = target === "" ? roster : roster.filter((row) => row.key === target);

  if (recipients.length === 0) {
    return [
      {
        name: target === "" ? "(全部)" : target,
        ok: false,
        code: "TEAM_NO_TARGET",
        error:
          target === ""
            ? "这个聊天室还没有 AI 成员。去「成员管理」里加一个。"
            : `这个聊天室里没有叫「${target}」的成员。`,
      },
    ];
  }

  const delivered = [];
  for (const member of recipients) {
    const result = await deliverToMember(ctx, member, text, "lead");
    if (result.ok && typeof onEntry === "function") {
      // ⚠ 「这个成员最近被哪个房间叫过」的记账**不在这里做**，交给调用方。
      //
      //    `memberRoom` 声明在 `apply()` 里面，而本函数是**模块级**的 ——
      //    在这里引用它就是一个越作用域的 `ReferenceError`。
      //    （2026-10-09 实测：这行原来写的就是 `memberRoom.set(...)`，
      //    于是**每一次投递成功**都会抛异常。以前没人发现是因为它藏在
      //    `void (async () => …)()` 里 —— 未处理的 rejection 同样是
      //    「静默 + 杀进程」，且没有任何守卫真的驱动过投递路径。）
      //    调用方在同一作用域里，顺手就把它做了，也就不可能再写错。
      onEntry(member);
    }
    delivered.push(
      result.ok
        ? { name: member.key, ok: true, status: "accepted" }
        : { name: member.key, ok: false, code: result.code ?? "TEAM_SEND_FAILED", error: result.error },
    );
  }
  return delivered;
}

/**
 * 聊天室里「我」发出去的消息用什么名字排。
 *
 * 必须与本地资料表的 `lead` 键一致 —— 客户端拿 `senderName` 去资料表查显示名/头像。
 */
const SPEAKER_SENDER = "lead";

/**
 * 从一条成员资料里算「它属于哪个房间」的**查找键**。
 *
 * 直接 `roomKeyOf` 需要的是一个会话 id，而这里手上只有一条成员资料 ——
 * 所以先按「房间归属 = 工作区目录」的语义取一个可用的键：
 *
 * ```
 * roomCwd（新语义，工作区） > roomSessionId（旧语义，会话） > cwd（它自己的工作区） > sessionId（末路）
 * ```
 *
 * ⚠ 这条链**必须与 `roomKeyOf` / `listActive({room})` 的兜底顺序一致** ——
 *   不一致的话，「交替」生成的新会话开场消息里那份成员名单
 *   会与房间实际成员对不上（新会话一上岗就拿到一份错的通讯录）。
 *
 * @param member - 成员资料。
 * @returns 可以交给 `roomKeyOf` 的键。
 */
function resolveRoomId(member) {
  for (const field of ["roomCwd", "roomSessionId", "cwd", "sessionId"]) {
    const value = member?.[field];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/**
 * 反查：这个会话是哪个成员的。
 *
 * 成员数量是个位数，直接扫一遍比维护一张需要同步的表更省心。
 *
 * @param store - MemberStore 实例。
 * @param sessionId - 会话 id。
 * @returns 成员名，或 null。
 */
function memberKeyOfSession(store, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  for (const [key, profile] of Object.entries(store.all())) {
    if (profile?.sessionId === sessionId) return key;
  }
  return null;
}

/** 官方智能体团队 bundle 的包名。改这里前先用 `listBundles()` 核对一次。 */
const TEAM_BUNDLE = "@deepseek-ai/dsh-experimental-agent-team-profile";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{8,80}$/;
/** SSE 心跳间隔，防止中间层掐掉空闲连接。 */
const HEARTBEAT_MS = 25_000;

/**
 * 剥出 `host:port` 形式的主机名，兼容 `http://` / `https://` 前缀。
 *
 * @param value - 形如 `http://127.0.0.1:43129` 的 URL 或裸 host。
 * @returns 主机名，解析失败返回 null。
 */
function hostOf(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).host;
  } catch {
    return null;
  }
}

/**
 * 同源校验：浏览器面路由只接受同源请求。
 *
 * 判定采取「先抓硬证据，再逐级兜底」：
 *
 * 1. `Sec-Fetch-Site: cross-site` 是浏览器明示的跨源 —— 直接拒。
 * 2. `Origin` 存在则必须与 `Host` 对齐。
 * 3. `Referer` 存在则必须与 `Host` 对齐。
 *
 * **不把「没有 Origin」等同于跨源**：`<script src>` 发起的同源 GET
 * 本来就不带 `Origin`（只有 CORS / 表单 / SSE 才带），若此处判死，
 * client.js 会拿到 403，聊天室直接空白。反过来，
 * `Sec-Fetch-Site` 属于 Chromium 专属头，经中间层转发可能丢失，
 * 因此它只用于「否决」，不用于「放行」。
 *
 * @param req - node 请求对象。
 * @returns 是否同源。
 */
function isSameOrigin(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;

  const host = hostOf(req.headers.host);
  if (host === null) return false;

  const origin = hostOf(req.headers.origin);
  if (origin !== null) return origin === host;

  const referer = hostOf(req.headers.referer);
  if (referer !== null) return referer === host;

  // 既无 Origin 也无 Referer：非浏览器上下文（curl / 探活），放行交给路由自身处理。
  return true;
}

/**
 * 浏览器面路由的统一前置守卫。
 *
 * 只放行同源请求，且**不**用 Bearer token ——
 * `<script src>` 与 `EventSource` 都带不了自定义头。
 *
 * @param req - node 请求对象。
 * @param res - node 响应对象。
 * @returns 是否已放行（false 表示已经写过响应）。
 */
function passSameOrigin(req, res) {
  if (isSameOrigin(req)) return true;
  res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
  res.end("仅接受同源请求。");
  return false;
}

/**
 * 写 JSON 响应。
 */
function sendJson(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

/**
 * 读一个 JSON 请求体，带上限。
 *
 * @param req - node 请求对象。
 * @param limit - 字节上限。
 * @returns `{ok: true, value}` 或 `{ok: false, status, error}`。
 */
async function readJsonBody(req, limit) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) {
      return { ok: false, status: 413, error: "请求体过大。" };
    }
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: "请求体不是合法 JSON。" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, error: "请求体必须是对象。" };
  }
  return { ok: true, value };
}

/**
 * 在 `ctx.agents` 里找出与给定 sessionId 对应的**精确 live Agent 对象**。
 *
 * 为什么必须做这一步：官方 `TeamRoster.tryMembership(agent)` 的判定是
 * `if (this.ctx.agents.get(agent.id) !== agent) return undefined;` ——
 * 身份靠**对象同一性**，任何重建/缓存的副本都会被当成过期引用拒掉。
 *
 * @param agents - `ctx.agents` 服务（可能不存在）。
 * @param sessionId - 目标会话 id。
 * @returns live Agent 对象，找不到返回 null。
 */
function findLiveAgent(agents, sessionId) {
  if (!agents || typeof sessionId !== "string" || sessionId === "") return null;

  // 路径一：agents 自带按 session 查的入口（不同版本形态不一，逐个试）。
  for (const method of ["getBySession", "bySession", "getBySessionId"]) {
    if (typeof agents[method] === "function") {
      try {
        const found = agents[method].call(agents, sessionId);
        if (found && typeof found === "object" && typeof found.id === "string") return found;
      } catch {
        /* 形态不符，继续试下一个 */
      }
    }
  }

  // 路径二：遍历所有 live agent，比对它的 session id。
  if (typeof agents.list !== "function") return null;
  let all;
  try {
    all = agents.list();
  } catch {
    return null;
  }
  if (!all || typeof all[Symbol.iterator] !== "function") return null;

  for (const agent of all) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") continue;
    // 再过一遍 `agents.get()`，确保拿到的是同一性成立的那个对象。
    const live = typeof agents.get === "function" ? agents.get(agent.id) : agent;
    if (live !== agent) continue;
    const found =
      agent.session?.id ??
      agent.sessionId ??
      agent.session?.header?.id ??
      agent.session?.header?.sessionId;
    if (found === sessionId) return agent;
  }
  return null;
}

/**
 * 把成员会话的标题刷成它的显示名。
 *
 * ## 为什么需要
 *
 * 左侧栏那棵树里，一行的文字就是**会话标题**；会话没标题时官方会**回退显示
 * 项目文件夹名**（cwd 的 basename），同一个工作区下几个会话全叫「DSHwork」。
 * 成员会话的标题必须是成员名，否则用户在左栏认不出谁是谁。
 *
 * ## 什么时候能刷
 *
 * `sessionTitle.rename()` 要求会话是 live 的 —— 只能刷「当前真的在跑」的成员。
 * 所以这里先按 `sessionId` 查一遍 `ctx.agents`，不在跑的直接跳过并计数。
 *
 * @param ctx - 宿主上下文。
 * @param store - MemberStore 实例。
 * @param force - true = 连「有人手动改过」的标题也盖掉。
 *   界面上显式点「修正标题」时传 true；后台自动补的时候传 false，
 *   免得把用户自己在标题栏改的名字冲掉。
 * @returns `{changed, members, live}` —— 没改动时能看出卡在哪一步。
 */
async function refreshMemberTitles(ctx, store, force = false) {
  const report = { changed: 0, members: 0, live: 0 };
  const agents = ctx.get?.("agents") ?? null;
  if (agents === null || typeof agents.get !== "function") return report;

  for (const member of store.listActive()) {
    report.members += 1;
    let live;
    try {
      live = agents.get(member.sessionId);
    } catch {
      live = undefined;
    }
    if (live === undefined) continue;
    report.live += 1;

    const display = typeof member.displayName === "string" ? member.displayName.trim() : "";
    // ⚠⭐ `renameTitle` 是 async —— **必须 await**。
    //   2026-10-10 抓到的真 bug：老写法 `if (renameTitle(...))` 判断的是
    //   Promise 对象，**恒为真** ⇒ `changed` 永远等于「尝试过的 live 成员数」，
    //   于是每次刷新都打印「修正了 N 个成员的窗口标题」，
    //   看起来像幂等失效、像永远改不完，其实根本不知道自己有没有改成功。
    //   现在拿到的才是 `renameTitle` 真正返回的是否改动。
    if (await syncMemberTitle(ctx, member.sessionId, display, member.key, force)) {
      report.changed += 1;
    }
  }
  return report;
}

/**
 * 构造 AI 成员那条**开场消息**。
 *
 * ## 为什么是"开场消息"而不是"协议 prompt"
 *
 * 成员现在是一个**独立的普通会话**（见 `lib/member-runtime.js`），
 * 不再走官方 teammate 协议 —— 所以这里不再需要照抄官方那份
 * `<system-reminder> You are teammate ...` 的协议文本，
 * 那句话在独立会话里是**错的**（它会以为自己是某个 Team 的子 agent，
 * 然后去调 `send_message` 这类根本不存在的工具）。
 *
 * 取而代之的是一段**自我介绍 + 职责 + 专属指令 + 第一件事**，
 * 读起来就像一个新同事到岗时看到的第一封邮件。
 *
 * ## 为什么「成员级技能」只能走这里
 *
 * 官方 `Session` 层面能配的东西（model / persona / toolFilter）都要在
 * **建会话时**给，而我们的创建表单只有名字/职责/模式/任务/专属指令。
 * 所以「让不同的 AI 用不同的技能」在当前 API 下最直接的落点就是这条开场消息。
 * 它是**创建期配置**：改了要重建成员才生效。
 *
 * ## 「主智能体」与「团队信箱」
 *
 * 2026-09-27 加了团队协作语义。两件事必须在这条消息里讲清楚，
 * 因为成员**没有别的途径知道**：
 *
 * 1. **谁是主智能体** —— 用户拍板：主智能体坐镇指挥、分配任务、
 *    接收汇报并检查。成员需要知道「干完活要回报给谁」。
 * 2. **怎么跟队友通信** —— 成员之间没有任何官方通道（独立根会话，
 *    官方 `sendMessage` 只认直接父子），只能走我们自己搭的文件信箱。
 *    协议全文由 `buildBusProtocol()` 生成。
 *
 * @param name - 成员名。
 * @param duty - 职责描述。
 * @param task - 用户填的初始任务（可为空，则用职责兜底）。
 * @param instructions - 该成员的专属指令 / 技能说明（可为空）。
 * @param options - `{dataDir, roster, isLead, tools, displayName}`。
 *   `dataDir` 给信箱协议用；`roster` 是同房间其他成员（`[{key, displayName}]`）；
 *   `tools` 为 true 时说明书里会**优先推荐 `chatroom_send` / `chatroom_read` 工具**
 *   （工具没登记成功就绝不提它 —— 让模型去找一个不存在的工具比不给工具更糟）；
 *   `isLead` 为 true 时这条消息是给**主智能体**的（用另一套措辞）。
 * @returns 开场消息正文。
 */
export function buildMemberPrompt(name, duty, task, instructions = "", options = {}) {
  const first = task.trim() === "" ? duty : task.trim();
  const isLead = options.isLead === true;
  // ⚠ **自我介绍用「显示名」（用户给的名字），不是成员标识。**
  //
  // 成员标识是内部用的（还是团队信箱的目录名），只能是 `[a-z0-9-]`；
  // 用户给的名字可能是中文。之前这里直接用标识，于是 AI 在对话里
  // 自称 `market-watcher`，而用户明明给它取的是中文名 ——
  // 「我给他的名字，你用的却是成员名」说的就是这一处。
  //
  // `name` 仍然保留原义（信箱地址要用它），只是不再拿去当自称。
  const shown =
    typeof options.displayName === "string" && options.displayName.trim() !== ""
      ? options.displayName.trim()
      : name;
  const parts = [
    `你是这个工作区里的一个 AI 成员，名字是「${shown}」。`,
    "",
    `你的职责：${duty}`,
    "",
    "你运行在**自己的会话窗口**里，随时可以在左侧栏找到并继续对话。",
    "用户会直接在这个窗口给你派活；需要澄清就直接问，不要自己猜。",
  ];

  // ── 团队协作：身份说明 ──────────────────────────────
  //
  // 两种角色的措辞必须**明显不同** —— 主智能体看到的是「你要指挥」，
  // 执行成员看到的是「你要汇报」。含混过去的话，两边都不知道自己该干嘛。
  if (isLead) {
    parts.push(
      "",
      "<team-role>",
      "**你是这个团队的主智能体（坐镇指挥）。**",
      "",
      "你的工作方式：",
      "1. **分配任务** —— 把用户的目标拆成可执行的小项，逐条用消息派给对应的执行成员。",
      "2. **接收汇报** —— 执行成员完成任务后会给你发消息。你要**真的去看它的产出**，",
      "   不要只看它说「做完了」就放行。",
      "3. **检查** —— 产出不合格就说明问题所在并让它返工；合格就推进到下一项。",
      "4. **汇总** —— 全部完成后，向用户汇报整体结果（做了什么、结果在哪、还有什么没做完）。",
      "",
      "派活时说清楚：做什么、验收标准是什么、结果放哪里。",
      "执行成员看不到你的上下文，只有你发给它的那条消息。",
      "</team-role>",
    );
  } else {
    parts.push(
      "",
      "<team-role>",
      "**这个团队有一个主智能体负责指挥。** 你负责执行具体任务。",
      "",
      "你的工作方式：",
      "1. 收到任务后直接干；有歧义就问派活的那一方，不要自己猜。",
      "2. **任务完成（或卡住）时，主动给主智能体发一条消息**说明：",
      "   你做了什么、结果在哪、需要它做什么。",
      "3. 主智能体检查后可能让你返工 —— 那就改，改完再汇报一次。",
      "4. 不要替别的成员干活，也不要等别人来催；干完就报。",
      "</team-role>",
    );
  }

  // ── 团队协作：通信协议 ──────────────────────────────
  //
  // ⚠ 只在**两个及以上成员**时才值得教。只有一个成员的话它没有通信对象，
  //    写了反而诱导它去写无意义的消息文件。
  const roster = Array.isArray(options.roster) ? options.roster : [];
  if (roster.length >= 2 && typeof options.dataDir === "string" && options.dataDir !== "") {
    // `roster` 是 `[{key, displayName}]`：文件信箱要**标识**（目录名），
    // 而给人看的是**显示名** —— 两者都要传下去（详见 `buildBusProtocol`）。
    // `tools` 决定说明书里提不提 `chatroom_send` / `chatroom_read`。
    parts.push("", buildBusProtocol(options.dataDir, name, roster, { tools: options.tools === true }));
  }

  const extra = typeof instructions === "string" ? instructions.trim() : "";
  if (extra !== "") {
    // 单独成段而不是拼进上一段：模型对「规则/技能」与「任务」的边界更清楚。
    parts.push(
      "",
      "<member-instructions>",
      "以下是你的专属职责与工作规范，优先级高于上面的一般描述：",
      "",
      extra,
      "</member-instructions>",
    );
  }

  parts.push("", `第一件事：${first}`);
  return parts.join("\n");
}

/**
 * 成员名规则。
 *
 * 与官方 `TeamRoster.memberName` 的规则对齐（小写字母 / 数字 / 连字符，不能叫 lead）——
 * 保留了这条是为了**兼容已经在用的成员名**，本地先校验一次，
 * 好给出比官方错误码更具体的中文提示。
 */
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_MEMBER_NAME = 64;

/** 短 hash（撞名 / 无法 slug 时当后缀）。 */
function shortHash(text) {
  return createHash("sha1").update(String(text)).digest("hex").slice(0, 8);
}

/**
 * 给「没填成员标识」的成员派生一个内部标识。
 *
 * ## 为什么需要它
 * 用户要的是「**给 AI 取个名字**」这一件事 —— 名字可能是中文。
 * 而成员标识有两个硬约束，注定不能直接拿名字来用：
 * 1. `MEMBER_NAME` 只允许 `[a-z0-9-]`；
 * 2. 它还会被当作**团队信箱的目录名**（见 `team-bus.js` 的 `mailboxOf`），
 *    中文 / 空格 / 特殊字符都不能进目录名。
 * 逼用户自己想一个英文标识是很差的体验，所以这里替他派生。
 *
 * ## 规则
 * - 名字里能捞出可读 slug（`Frontend Engineer` → `frontend-engineer`）→ 用它
 * - 捞不出来（纯中文名）→ `m-<sessionId 的 8 位 hash>`
 *
 * ⚠ **从 sessionId 派生，不是从名字派生** —— 名字以后会改，
 *   而标识一旦定了就代表这个成员（`members.json` 的键、信箱目录名），
 *   改名字不该让资料失联。
 *
 * ⚠ 撞名只错开「**不同会话**」：同一个会话重复收编必须拿到同一个标识，
 *   否则同一份资料会分裂成两条。
 *
 * @param {string} sessionId 会话 id（稳定标识）。
 * @param {string} displayName 用户给的名字（可中英文）。
 * @param {{get?: Function}} [store] 成员表，用于撞名时错开。
 * @returns {string} 合法的成员标识。
 */
export function deriveMemberKey(sessionId, displayName, store = null) {
  const slug = String(displayName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_MEMBER_NAME);
  let key =
    slug !== "" && slug !== "lead" && MEMBER_NAME.test(slug)
      ? slug
      : `m-${shortHash(sessionId)}`;

  const existing = typeof store?.get === "function" ? store.get(key) : undefined;
  if (existing !== undefined && existing !== null && existing.sessionId !== sessionId) {
    key = `${key.slice(0, MAX_MEMBER_NAME - 9)}-${shortHash(sessionId)}`;
  }
  return key;
}
const MAX_DESCRIPTION = 200;

/**
 * 初始任务的长度上限。
 *
 * 这段文本会作为 teammate 的**第一条消息**（`prompt` 的第二段）发给子 agent，
 * 官方那边没有硬上限，这里限一下只是为了别让一次请求把 body 撑爆
 * （spawn 路由的请求体上限是 8 KiB）。
 */
const MAX_INITIAL_TASK = 2_000;

/**
 * 创建成员的请求体上限。
 *
 * 大头是**头像**（data URL base64 上限 ~1.35 MB，见 `member-store.js`），
 * 再加名字 / 职责 / 任务 / JSON 包装的余量。
 *
 * ⚠ 按 `MAX_MEMBER_BYTES` 推导，**不写死数字** ——
 *    头像上限提过一次，写死的那个 16 KiB 没跟着提，带图的创建直接被 413 掐。
 */
const SPAWN_BODY_LIMIT = MAX_MEMBER_BYTES + 32_768;

/**
 * 插件主体。
 *
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx) {
  /** 连接的浏览器客户端：clientId -> SSE response。 */
  const clients = new Map();
  /** sessionId -> 最新 timeline view，作为新客户端的初始快照。 */
  const latest = new Map();
  let disposed = false;

  /**
   * 把「插件自己的回调」包一层兜底。
   *
   * ## 为什么这是必须的，而不是「加固」
   *
   * 2026-10-09 实测：本插件一个事件回调里引用了一个**拼错的变量名**
   * （`roomKey` 没声明），于是每次 AI 回复都抛 `ReferenceError`。
   * 宿主**没有**兜住事件回调里的异常 ⇒ Node 按默认行为**终止进程** ⇒
   * 用户看到「运行会话的后台服务已停止（退出码 1）」，而且**日志里一条都没有**
   * （进程在写日志之前就没了）。
   *
   * 一个字的笔误换来整个 IDE 崩掉 —— 这个代价结构是错的。插件是住客，
   * 住客把自己的屋子点着了，不该把整栋楼带走。
   *
   * 所以此后**所有** `ctx.on(...)` 的回调都过这里：异常就地转成日志
   * （带 `[host-hook:<名字>]` 前缀，方便 grep —— 与客户端那套
   * `[entry-crash:<槽名>]` 同一个思路：**先把错误变得可见**），
   * 宿主照常继续跑。
   *
   * @param label - 钩子名（日志里用来定位）。
   * @param fn - 真正的回调。
   * @returns 包好的回调（返回值原样透传，cordis 的 `serial` 派发要靠它）。
   */
  const guardHook = (label, fn) => (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      ctx.logger?.error?.(`team-chat: [host-hook:${label}] ${error?.stack ?? String(error)}`);
      return undefined;
    }
  };

  /**
   * 游离 Promise 的兜底 —— 和上面同一个问题的另一半。
   *
   * 未处理的 Promise rejection 在 Node 上的默认行为同样是**终止进程**，
   * 而这条路径比同步抛错更隐蔽（`void (async () => …)()` 看起来人畜无害）。
   * 宿主里所有「发起就不管」的异步任务都从这里走。
   *
   * @param label - 任务名（日志里用来定位）。
   * @param promise - 那个没人接管的 Promise。
   */
  const guardTask = (label, promise) => {
    void Promise.resolve(promise).catch((error) => {
      ctx.logger?.error?.(`team-chat: [host-task:${label}] ${error?.stack ?? String(error)}`);
    });
  };

  /** 成员资料库（名字 + 头像 + 它的独立会话身份）。加载在下面的 effect 里异步完成。 */
  const members = new MemberStore(resolveDataDir());

  /**
   * 我们自己的聊天室时间线：`房间会话 id -> 条目[]`。
   *
   * ## 为什么不再靠投影
   *
   * 改版前时间线由 `createTimelineProjection()` 从**官方 team mailbox 事件**攒出来。
   * 成员改成独立会话之后，消息不再经过官方邮箱：
   * - 我们**投出去**的每条消息（`steer`）要自己记一笔；
   * - 成员**回复**发生在**它自己的会话**里，而投影是按会话注册的 ——
   *   房间会话的投影看不到别人会话里的事件。
   *
   * 所以改成宿主自己攒，走 SSE 推给前端（帧形状与原来一致：`{type:"timeline", sessionId, view}`）。
   * 原来那份投影**保留**，它的条目（改版前的老消息）会并进视图里，历史不丢。
   */
  const roomLog = new RoomLog(resolveDataDir());

  /**
   * 成员最近被**哪个房间**点名：`成员名 -> 房间会话 id`。
   *
   * 成员的回复要送回"它被叫话的那个房间"。只在内存里，重启后退化成
   * 「下次谁给它发消息，回复就归谁」—— 刻意**不落盘**：
   * 成员资料里带着头像（可能 800 KB+），每发一条消息重写一次盘不划算。
   */
  const memberRoom = new Map();

  /** 「已移除」成员名单（官方删不掉，只能在我们自己的界面里藏起来）。 */
  const hiddenMembers = new RemovedMembers(resolveDataDir());

  /**
   * 「发送到团队」的当前范围：`sessionId -> 成员名`（空串 = 所有人）。
   *
   * 不在表里 = 这条会话按普通对话处理（不投递给任何成员）。用完即删（一次性）。
   */
  const sendScope = new Map();


  /**
   * 成员会话标题的防抖刷新。
   *
   * 触发点：插件加载后、`agent/created`（成员会话被恢复时）——
   * `agent/created` 对**每个** agent 都会响，不能每条都全量扫一遍。
   *
   * ⚠ 后台这条走 `force: false`：只补「从没被改过」的标题，
   *    绝不覆盖用户自己在标题栏改的名字。显式点「修正标题」才传 true。
   *
   * @param delayMs - 延迟；默认 1500ms。
   */
  /**
   * ⭐ 成员会话标题的**单向绑定**（2026-10-08 用户要求）。
   *
   * 语义：**对话窗口的名字 = 成员的名字**。
   *   - 收编时：把你给成员取的名字设成对话名（`member-runtime.js` 里做）
   *   - 改成员名时：自动同步到对话名（`/members` 那条路由里做）
   *   - **用户不能在对话界面自行改名** —— 改了会被这里立刻改回；
   *     要改就改成员名，那样会自动同步过来。
   *
   * ## 为什么用事件而不是轮询
   * 官方在标题变更时会写一条 `session/title` 的 session event
   * （见 `@deepseek-ai/dsh-session-title` 的 `ctx.on("session/event", …)`），
   * 所以监听它就能做到**即时且零轮询**。
   *
   * ## 为什么不会死循环
   * 我们自己 rename 之后也会收到这条事件，但那时
   * `renameTitle` 会因为「标题已经是目标值」直接返回 false、不再写事件，
   * 链条自然终止。
   */
  ctx.on(
    "session/event",
    guardHook("session/title", (session, event) => {
      if (event?.type !== "session/title") return;
      const sessionId = session?.header?.id ?? session?.id ?? event?.sessionId ?? null;
      if (typeof sessionId !== "string" || sessionId === "") return;

      const member = members.listActive().find((row) => row.sessionId === sessionId);
      if (member === undefined) return; // 不是成员会话，一律不干预

      const display = typeof member.displayName === "string" ? member.displayName.trim() : "";
      const wanted = display !== "" ? display : member.key;
      guardTask("session/title.rename", syncMemberTitle(ctx, sessionId, wanted, member.key, true));
    }),
  );

  let titleRefreshTimer = null;
  const scheduleTitleRefresh = (delayMs = 1500) => {
    if (titleRefreshTimer !== null) clearTimeout(titleRefreshTimer);
    titleRefreshTimer = setTimeout(() => {
      titleRefreshTimer = null;
      // ⚠ `refreshMemberTitles` 现在返回 Promise —— 定时器回调不是 async 函数，
      //   所以这里用 async IIFE 包一层，并用 `guardTask` 兜住游离的 Promise
      //   （不然一次 rejection 就是「后台服务已停止（退出码 1）」）。
      guardTask(
        "titles.refresh",
        (async () => {
          try {
            // ⚠ 2026-10-08 改动：`force` 从 false 改成 **true**。
            //   产品语义变了 —— 成员会话的窗口标题**由成员名唯一决定**，
            //   用户在对话界面自行改名不再被尊重，会被改回
            //   （即时的那一刀见下面的 `session/title` 监听）。
            //   原来 false 的意思是「只补从没被改过的标题」，与现在的语义正好相反。
            const report = await refreshMemberTitles(ctx, members, true);
            if (report.changed > 0) {
              ctx.logger?.info?.(`team-chat: 修正了 ${report.changed} 个成员的窗口标题`);
            }
          } catch (error) {
            ctx.logger?.warn?.(`team-chat: 成员标题刷新失败: ${error?.message ?? error}`);
          }
        })(),
      );
    }, delayMs);
    // 定时器不该拖住宿主退出。
    titleRefreshTimer.unref?.();
  };

  /**
   * 向所有客户端广播一个事件帧。
   *
   * @param payload - 可 JSON 序列化的负载。
   */
  const broadcast = (payload) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const response of clients.values()) {
      try {
        response.write(frame);
      } catch {
        // 单个坏连接不能影响其余客户端。
      }
    }
  };

  /**
   * 给某个房间追加一条我们自建的时间线条目。
   *
   * ⚠ **第一个参数是房间键**（= 工作区目录，`roomKeyOf` 的输出），
   *   **不是会话 id**。同一个工作区里的所有窗口共用一份日志 ——
   *   用户的心智是「一个工作室一个聊天室」，从哪个窗口说话都该出现在同一个地方。
   *
   * ⚠ **条目 id 必须用事件自身的身份**（`session.id` + `event.seq` / `turn`），
   *   **不要用 `randomUUID()`**：`RoomLog.append` 靠 id 做幂等，
   *   同一个事件被派发两次时只会记一条（2026-10-09「一条回复变两个气泡」的修法）。
   *
   * 条目形状与老投影**完全一致**（`{id, senderName, targetName, blocks, at, delivered}`），
   * 这样前端一行都不用改 —— 它只认这个形状。
   *
   * @param roomKey - 房间键（工作区目录）。
   * @param entry - 条目；`at` 缺省补当前时间。
   * @returns 是否真的新增了（同 id 已存在时为 false）。
   */
  const appendRoomEntry = (roomKey, entry) => roomLog.append(roomKey, entry);

  /**
   * 就地改一条已存在的条目。
   *
   * 为什么需要：投递是**异步**的，而「我说的这句话」必须**立刻**出现在聊天室里
   * （用户打完字一抬头就该看见）。所以先记一笔 `delivered:false / targets:[]`，
   * 等投递结果回来再把「发给了谁」补上 —— 而不是等投递完才记
   * （旧实现就是那样，于是「@ 了但没选范围」时聊天室里什么都看不到）。
   *
   * @param roomKey - 房间键。
   * @param id - 条目 id。
   * @param patch - 要合并的字段。
   */
  const patchRoomEntry = (roomKey, id, patch) => roomLog.patch(roomKey, id, patch);

  /**
   * 房间 → 最近一次见到的会话 id。
   *
   * 只为一件事：老投影（`latest`）是**按会话**存的，而房间日志是按工作区存的 ——
   * 合成视图时要挑一个会话去取那段老条目。新体系下老投影基本是空的，
   * 但没有它就丢掉历史，所以留一个提示位。
   */
  const roomSessionHint = new Map();

  /**
   * 组装某个房间对外的时间线视图。
   *
   * **老投影的条目排在前面** —— 它们是改版前的官方邮箱消息，时间上更早，
   * 而且没有自己的时间戳，只能靠位置表示先后。
   *
   * @param sessionId - 请求方所在的会话 id（用来取那段老投影，并换算房间键）。
   * @returns `{sessionId, roomKey, entries}`。
   */
  const roomView = (sessionId) => {
    const roomKey = roomKeyOf(ctx, sessionId, members);
    if (typeof sessionId === "string" && sessionId !== "") roomSessionHint.set(roomKey, sessionId);
    const legacy = latest.get(sessionId)?.entries ?? [];
    const mine = roomLog.entriesOf(roomKey);
    return {
      sessionId,
      roomKey,
      entries: [...legacy, ...mine],
      ...(latest.get(sessionId)?.failure === undefined ? {} : { failure: latest.get(sessionId).failure }),
    };
  };

  /**
   * 把某个房间的最新时间线推给前端。
   *
   * 帧里**带房间键**：客户端按房间键比对，所以同一个工作区里的每个窗口
   * （包括 AI 成员自己的窗口）都会刷新 —— 这正是「聊天室」该有的样子。
   *
   * @param roomKey - 房间键（工作区目录）。
   */
  const pushRoom = (roomKey) => {
    const hint = roomSessionHint.get(roomKey);
    const view =
      hint === undefined
        ? { roomKey, entries: roomLog.entriesOf(roomKey) }
        : roomView(hint);
    broadcast({ type: "timeline", sessionId: hint ?? null, roomKey, view });
  };

  ctx.effect(() => {
    // 0) 加载成员资料库。**不能 await** —— effect 回调必须同步返回 disposer。
    //    读盘失败也不影响插件可用性（MemberStore 内部吞掉错误）。
    guardTask(
      "members.load",
      members.load().then((ok) => {
        if (ok) ctx.logger?.info?.(`team-chat: 成员资料已加载 ${Object.keys(members.all()).length} 条`);
      }),
    );
    guardTask("hiddenMembers.load", hiddenMembers.load());
    // ⚠ 聊天记录也要**读回来** —— 不然 DSH 一重启，聊天室就空了，
    //    而成员窗口里的历史还在（那是官方会话日志），两边表现不一致。
    guardTask(
      "roomLog.load",
      roomLog.load().then((ok) => {
        const stats = roomLog.describe();
        if (stats.error !== null) {
          ctx.logger?.warn?.(`team-chat: 聊天记录读盘失败（当空库继续）：${stats.error}`);
        } else if (ok && stats.entries > 0) {
          ctx.logger?.info?.(`team-chat: 聊天记录已恢复 ${stats.rooms} 个房间 / ${stats.entries} 条`);
        }
      }),
    );

    // 0.5) 修历史遗留：早期建的成员，会话标题还是官方自动生成的那条垃圾
    //      （`"<system-reminder> You are teammate "prob"`）。给宿主一点时间
    //      让会话都恢复出来，再批量刷一遍。
    scheduleTitleRefresh(3000);

    // 1) 注册自有投影 —— 这是整个插件的核心。
    //    官方 wire view 丢弃了 messages，这里把它们接回来。
    const disposeProjection = ctx.sessionProjections.register(createTimelineProjection());

    // 2) 订阅投影变更。onChanged 每个已提交事件触发一次，
    //    且只在 view 按 Object.is 变化时才回调，天然去重。
    const disposeChanged = ctx.sessionProjections.onChanged(
      guardHook("projection.onChanged", (session, key, value) => {
        if (key !== TIMELINE_PROJECTION_KEY) return;
        latest.set(session.id, value);
        // 推**合并后**的视图：投影只是其中的"老消息"那一段。
        // ⚠ 房间键 ≠ 会话 id：同一个工作区的窗口共用一份日志，所以这里要换算。
        pushRoom(roomKeyOf(ctx, session.id, members));
      }),
    );

    // 2.5) 成员会话被恢复时，顺手把它的窗口标题刷一遍（防抖）。
    //
    //      ⚠ **「模式」不再需要这个钩子。** 老实现走的是「先 spawnTeammate、
    //      再抢在第一个 turn 之前 `agentPresets.select()`」——那是整套代码里
    //      最脆的一环（跑过 turn 就抛 `agent-preset/locked`，只能靠
    //      `ctx.serial` 的时序保证抢得住）。现在建会话时直接把 preset
    //      传给 `ensureSession`，预设落盘就是创建的一部分，没有竞态。
    const disposeTitleHook = (() => {
      const off = ctx.on(
        "agent/created",
        guardHook("agent/created", () => {
          scheduleTitleRefresh();
        }),
      );
      return typeof off === "function" ? off : () => {};
    })();

    // 2.6) 「发送到团队」：把**官方输入框**发出的真人消息按选定范围投给成员。
    //
    //    为什么盯 `session/event` 而不是自己画输入框 —— 用户明确要复用官方输入框
    //    （那样才有附图 / 附件能力）。代价是消息**也会进 Lead 的 inbox**，我们拦不住；
    //    所以语义是「额外投给这些成员」。
    //
    //    ⚠ **只认 `source.kind === "user"`。** 实测这个会话日志里 user/message 的
    //    source 取值有：`user`(真人 13 条) / `team-message`(成员发来 3 条) /
    //    `subagent-settled`(成员结束通知 3 条) / `runtime-context` / `skill-catalog` /
    //    `user-approval`。**只处理 `user`，其余全跳过** —— 否则成员的回复会被再广播
    //    一次，直接成环。
    //
    // ── ⭐ 私密语义所需的一份**短期状态**（2026-10-10 用户要求）──────────
    //
    //    `privateTurns` = 正在跟用户**单独私聊**的成员标识集合。
    //
    //    为什么需要：光拦住「用户说的话不进聊天室」只堵了一半 ——
    //    成员在这一轮里的**回复**照样会被 2.7 的回流钩子写进房间。
    //    你在某个成员窗口里单独交代的话若是连它的答复都公开在聊天室里，
    //    等于没私密可言。
    //
    //    进出规则（只在内存里，重启即空 —— 空 = 走「记进房间」的默认行为，安全侧）：
    //      · 进：本钩子判定为「在成员自己的窗口里说话、且没点发送到团队」；
    //      · 出：任何一次**房间发起**的投递（聊天室 @ / `chatroom_send` 工具）；
    //      · 读：2.7 的回流钩子按它决定这条回复要不要进聊天室。
    const privateTurns = new Set();

    /**
     * 记「这个成员是被**这个房间**叫话的」，并顺带结束它的私聊回合。
     *
     * ⚠ 所有房间发起的投递（聊天室 @ / 「发送到团队」/ `chatroom_send` 工具 /
     *   团队信箱）**都必须走这里**写 `memberRoom`，不能绕过它直接 SET ——
     *   否则「私聊回合」解除不掉，成员之后的回复就再也不会回流聊天室了。
     *   （2026-10-10 引入；这里刻意做成一个函数而不是两个动作，就是为了让人没法只写一半。）
     *
     * @param memberKey - 成员标识（`memberRoom` 的键）。
     * @param roomKey - 房间键。
     */
    const markRoomTurn = (memberKey, roomKey) => {
      memberRoom.set(memberKey, roomKey);
      privateTurns.delete(memberKey);
    };
    const disposeScopeHook = (() => {
      // 钩子体抽成具名常量，只为让下面 `guardHook` 那一层读起来不绕。
      const onTeamSend = (session, event) => {
        if (event?.type !== "user/message") return;
        if (event.data?.source?.kind !== "user") return;

        const text = (Array.isArray(event.data.content) ? event.data.content : [])
          .map((block) => (typeof block?.text === "string" ? block.text : ""))
          .join("")
          .trim();
        if (text === "") return;

        // ── ⭐⭐ 私密性闸门（2026-10-10 用户要求）────────────────────
        //
        //    **在某个成员自己的对话窗口里说的话 = 私聊，不进聊天室。**
        //
        //    为什么必须剔除：聊天室日志是**按工作区共享**的（`roomKeyOf` 把
        //    同一个工作室里所有会话都算成同一个房间），所以一旦写进去，
        //    **团队里每一个人、以及你在别的窗口里看的聊天室**都会看到这句话 ——
        //    跟成员单独交代的一句话被打招呼，计划就乱了。
        //
        //    两种情形才算「对着房间说话」，予以记录：
        //      ① 主会话（Lead）—— 聊天室的本座就在那里；
        //      ② 成员会话里**显式点过「发送到团队」**（`sendScope` 里有记录）——
        //         这是用户主动要广播，不是误写，尊重他的意图。
        //
        //    ⚠ 判据用会话 id：成员是**独立根会话**，
        //      `members.listActive()` 里的 `sessionId` 就是唯一的身份。
        const self = members.listActive().find((row) => row.sessionId === session.id);
        if (self !== undefined && !sendScope.has(session.id)) {
          // ⭐ 私聊回合开始：它**接下来的回复**也不该出现在聊天室里
          //   （判据见 2.7 那边的 `privateTurns`）。
          privateTurns.add(self.key);
          return;
        }
        // 走到这里说明：这是主会话，或成员会话里**显式点过「发送到团队」**
        // ⇒ 这一轮是公开的，私聊回合结束（它随后的回复可以回流聊天室）。
        if (self !== undefined) privateTurns.delete(self.key);

        const roomKey = roomKeyOf(ctx, session.id, members);

        // ── 先记「我说的这句话」，**与投递无关** ────────────────────
        //
        // ⚠⚠ 2026-10-09 用户报「我在聊天室里看不到我发出的消息」。
        //    真因就在这一行的位置上：旧实现把「记一笔」写在**投递成功**的回调
        //    （`deliverToMembers` 的 `onEntry`）里，于是
        //      · 没有投递范围（比如只 @ 了人、没去「发送到团队」选范围）→ 一条不记；
        //      · 投递失败（成员被回收 / 名字打错）→ 一条不记。
        //    结果：成员那边收得到（或我去成员窗口里看得见），**聊天室里却是空的**。
        //    说得更直白些：**「我说过什么」不该取决于「投递成功了没」**。
        //    所以现在立刻记一笔 `delivered:false / targetNames:[]`，
        //    等投递结果回来再补「发给了谁」。
        //
        //    ⚠ id 用**事件自身的身份**（会话 id + `event.seq`），不用 randomUUID：
        //      `seq` 是这条会话日志条目的序号，天然唯一；同一个事件万一被派发两次，
        //      第二次会因为 id 已存在而被 `RoomLog.append` 丢掉
        //      （2026-10-09 用户报「一条消息在聊天室里出现两个气泡」）。
        const entryId = `send-${session.id}-${event.seq ?? randomUUID()}`;
        appendRoomEntry(roomKey, {
          id: entryId,
          senderName: SPEAKER_SENDER,
          targetName: null,
          targetNames: [],
          blocks: [{ type: "text", text }],
          delivered: false,
        });
        pushRoom(roomKey);

        const target = sendScope.get(session.id);
        if (target === undefined) return;
        sendScope.delete(session.id); // 一次性

        guardTask("team-send.deliver", (async () => {
          const targets = [];
          const delivered = await deliverToMembers(
            ctx,
            members,
            session.id,
            // 带上来源：成员会话里只看到这一条 user 消息，
            // 说清「这是聊天室里有人点名给我」，它才知道该怎么回应。
            roomDeliveryText(speakerLabel(), text),
            target,
            hiddenMembers.all(),
            (member) => {
              // 只收集「发给了谁」——条目在上面已经记过了，
              // 这里再记一次会让同一句话在聊天室里出现两遍。
              targets.push(member.key);
              // 记下「这个成员最近被哪个房间叫过」：它的回复要送回这个房间。
              // `memberRoom` 的键是**成员标识**（回复钩子也按这个键查）。
              markRoomTurn(member.key, roomKey);
            },
          );
          patchRoomEntry(roomKey, entryId, {
            targetNames: targets,
            targetName: targets.length === 1 ? targets[0] : null,
            delivered: targets.length > 0,
          });
          pushRoom(roomKey);
          // 广播回去 → 客户端把「发送到团队」按钮复位（一次性已消费）。
          broadcast({ type: "team-send", sessionId: session.id, target, delivered });
        })());
      };
      const off = ctx.on("session/event", guardHook("team-send", onTeamSend));
      return typeof off === "function" ? off : () => {};
    })();

    // 2.7) 成员回复回流到聊天室。
    //
    //      成员是**独立会话**，它的回复写在**它自己的**会话日志里 ——
    //      房间会话看不到。所以这里监听所有会话的 `assistant/message`，
    //      凡是「属于某个成员的那个会话」产出的回复，就记进它被叫话的那个房间。
    //
    //      ⚠ 只在内存里记「最近被哪个房间叫过」（`memberRoom`），
    //        重启后退化成「下次谁发消息，回复归谁」—— 不落盘的理由见 `memberRoom`。
    //      ⚠ 不认 `memberAgent()` 的恢复流程：只有**真的产出回复**才记，
    //        避免把工具调用之类的中间消息灌进聊天室。
    const disposeReplyHook = (() => {
      const onMemberReply = (session, event) => {
        if (event?.type !== "assistant/message") return;
        // ⚠⚠ 2026-10-09 宿主进程整个被杀（exit 1）的真凶就在下面几行。
        //
        //    房间日志从「按会话分键」改成「按工作区（房间键）」时，这一处
        //    只改了 `appendRoomEntry` / `pushRoom` 的**用法**，没改那行**声明** ——
        //    于是 `roomKey` 成了一个从未声明的标识符：每次 AI 回复都会
        //    抛 `ReferenceError`，而宿主没有兜住事件回调里的异常，
        //    Node 按默认行为终止进程 ⇒ DSH 弹「运行会话的后台服务已停止（退出码 1）」，
        //    且**日志里一条都没有**（进程在写日志之前就没了）。
        //
        //    ⚠ 顺带查出**第二个**、与崩溃无关的老 bug：`memberRoom` 的键是
        //    **成员标识**（写入侧一律 `memberRoom.set(member.key, …)`），
        //    而这里过去拿**会话 id** 去查 —— 键不一致 ⇒ 本钩子**从来没命中过**，
        //    「成员回复回流到聊天室」自打写出来就是死代码。
        //    所以先按会话反查成员标识，再拿它查房间。
        const memberKey = memberKeyOfSession(members, session.id);
        if (memberKey === null) return; // 不是成员的会话

        // ── ⭐ 私密回合（2026-10-10 用户要求）──────────────────────
        //
        //    用户正在这个成员**自己的窗口**里跟它单独说话（上一次 user 消息
        //    是私聊，见 2.6 那边 `privateTurns.add`）：这条回复是私聊的一部分，
        //    **不进聊天室** —— 否则「嘴上说不记录」而答复照样公开，等于没私密。
        if (privateTurns.has(memberKey)) return;

        const roomKey = memberRoom.get(memberKey);
        if (roomKey === undefined) return; // 这个成员最近没被任何房间叫过

        // ⚠⚠ **两个消息事件的数据形状不一样，别想当然。**
        //
        //   `user/message`  —— 追加的就是消息对象本身：
        //       `session.append("user/message", message, …)`
        //       （`dsh-agent-loop/lib/index.js:1061`）
        //       ⇒ 所以正文在 `event.data.content`、来源在 `event.data.source`。
        //
        //   `assistant/message` —— 追加的是一个**外层包装**：
        //       `session.append("assistant/message", { turn, step, message, usage, stream }, …)`
        //       （同文件 `:1144`）
        //       ⇒ 正文在 `event.data.message.content`、来源在 `event.data.message.source`。
        //
        //   这里原来按 user 的形状读 `event.data.source` / `event.data.content`
        //   —— 恒为 undefined ⇒ `kind !== "model"` 永远成立 ⇒
        //   **成员回复一条都进不了聊天室**（用户 2026-10-09 报的第 1 条）。
        //   官方自己的读法可对照 `dsh-api-session-controller/lib/index.js:1107`
        //   （`case "assistant/message": imageBlockIn(data.message?.content, …)`）。
        const message = event.data?.message;
        if (message === null || typeof message !== "object") return;
        if (message.source?.kind !== "model") return;

        const blocks = (Array.isArray(message.content) ? message.content : [])
          // 只留正文：`reasoning` 是模型的思考过程，聊天室里不该刷屏。
          .filter((block) => block?.type === "text" && typeof block.text === "string" && block.text !== "");
        if (blocks.length === 0) return;

        // ⚠⚠ **一个 turn 一条气泡**，按 `session.id + turn` 做 id。
        //
        //   为什么不是「一个事件一条气泡」：官方每**步**追加一条
        //   `assistant/message`（`dsh-agent-loop/lib/index.js:1144`，
        //   一整个 turn 里模型每说一次话就是一步）—— 而用户在成员窗口里看到的
        //   是**一个 turn 一坨**。所以一个走了两步的 turn 会在聊天室里变成两个
        //   一样的气泡，用户看到的就是「对话里只回了一个收到，聊天室里两个」
        //   （2026-10-09 报的第 1 条）。
        //
        //   两条保证叠在一起：
        //   ① `append` 按 id 幂等 —— 同一个事件被派发两次只记一条；
        //   ② 已经有这个 turn 的条目时走 `mergeBlocks` —— 该步新出的正文
        //      并进同一条气泡（与成员窗口的观感一致），
        //      而**完全相同的段落会被丢掉**（那就是同一个事件被派发两次）。
        const turn = typeof event.data?.turn === "number" ? event.data.turn : null;
        const entryId =
          turn === null
            ? `reply-${session.id}-${event.seq ?? randomUUID()}`
            : `reply-${session.id}-t${turn}`;

        if (roomLog.has(roomKey, entryId)) {
          roomLog.mergeBlocks(roomKey, entryId, blocks);
        } else {
          appendRoomEntry(roomKey, {
            id: entryId,
            senderName: memberKey,
            targetName: null,
            targetNames: [],
            blocks,
            delivered: true,
          });
        }
        pushRoom(roomKey);
      };
      // ⚠ 这一层兜底就是为了上面那个 ReferenceError：**插件抛错不该杀宿主**。
      const off = ctx.on("session/event", guardHook("member-reply", onMemberReply));
      return typeof off === "function" ? off : () => {};
    })();

    // 2.8) 团队信箱轮询 —— **成员之间互相通信的唯一通道**。
    //
    //      为什么非要有这个：成员是独立的根会话，官方 `sendMessage()` 只认
    //      「直接父子」相邻关系（实测 `dsh-subagent/lib/types/continuation.js`），
    //      独立根会话**没有 parent**、成员之间也没有血缘 → 官方通道一条都走不通。
    //
    //      所以宿主当邮局：每个成员有一个信箱目录，成员用**写文件**来发消息
    //      （那是它唯一能主动产生副作用的手段）。这里定时扫、投递、记时间线。
    //
    //      ⚠ 投递用的是 `deliverToMember`（= `agent.steer`），所以**目标成员
    //        不在线也会被叫醒** —— 它可能被回收过，但消息不会石沉大海。
    //
    //      ⚠ 顺序：先投递、成功了才删文件。投递抛错时保留文件，下轮重试。
    //        失败太多次（比如 `to` 写了个不存在的名字）就挪进 `failed/`，
    //        不能无限重试，也不能静默吞掉。
    const BUS_POLL_MS = 1500;

    /**
     * 把信箱里的消息投递给目标成员。
     *
     * @param roomId - 归属房间（信箱里没有房间信息，用「发件人的房间」兜底）。
     * @param fromKey - 发件成员名。
     * @returns 处理条数。
     */
    const pumpMailbox = async (roomId, fromKey) => {
      const dataDir = resolveDataDir();
      const pending = await drainMailbox(dataDir, fromKey, 20);
      if (pending.length === 0) return 0;

      // ⚠ 传进来的可能是**会话 id**（`row.roomSessionId`）也可能是**房间键**
      //   （`memberRoom` 里存的就是房间键）。这里统一换算成房间键再往下用 ——
      //   否则同一份房间日志会被拆成「按会话」和「按工作区」两半。
      //   `roomKeyOf` 对房间键是幂等的（解析不出来就退回原值）。
      const roomKey = roomKeyOf(ctx, roomId, members);

      // 收件人必须是**同房间的活跃成员**，或主智能体（`lead`）。
      const roster = members.listActive({ room: roomKey });
      const byName = new Map(roster.map((row) => [row.key, row]));

      let handled = 0;
      for (const item of pending) {
        if (item.error !== undefined) {
          // 形状不对（不是合法 JSON / 缺字段）→ 留证据再删，重试也没用。
          await failMailboxFile(dataDir, item.file, `${item.error.code}: ${item.error.message}`);
          continue;
        }

        const msg = item.message;
        const target = msg.to.trim().toLowerCase();

        // 写给主智能体（`lead`）：投给房里那个真主智能体。
        if (target === BUS_LEAD || target === "main" || target === "主智能体") {
          const leadMember = roster.find((row) => row.isLead === true);
          if (leadMember === undefined) {
            // 没有主智能体 → 记进时间线当普通留言，别丢。
            appendRoomEntry(roomKey, {
              id: `bus-${randomUUID()}`,
              senderName: fromKey,
              targetName: null,
              targetNames: [],
              blocks: [{ type: "text", text: `（想汇报给主智能体，但这个聊天室还没指定主智能体）\n\n${msg.text}` }],
              delivered: true,
            });
            await ackMailboxFile(item.file);
            handled += 1;
            continue;
          }
          const sent = await deliverToMember(
            ctx,
            leadMember,
            // 与工具路径同一套来源前缀 —— 收件方一眼看出这是聊天室里的点名。
            roomDeliveryText(labelOf(fromKey), msg.text, msg.kind),
            fromKey,
          );
          if (sent.ok) {
            markRoomTurn(leadMember.key, roomKey);
            appendRoomEntry(roomKey, {
              id: `bus-${randomUUID()}`,
              senderName: fromKey,
              targetName: leadMember.key,
              targetNames: [leadMember.key],
              blocks: [{ type: "text", text: msg.text }],
              delivered: true,
            });
            await ackMailboxFile(item.file);
          } else {
            // 投不进去 → 留文件下次重试（成员可能正在被回收/重启）。
            ctx.logger?.warn?.(`team-chat: 信箱投递给主智能体失败（${sent.code}）：${sent.error}`);
          }
          handled += 1;
          continue;
        }

        // 写给普通成员。
        const targetMember = byName.get(target);
        if (targetMember === undefined) {
          await failMailboxFile(
            dataDir,
            item.file,
            `收件人「${msg.to}」不在这个聊天室的成员名单里。当前成员：${roster.map((r) => r.key).join(" / ") || "（无）"}`,
          );
          continue;
        }
        if (targetMember.key === fromKey) {
          // 写给自己 = 没意义的循环，丢掉并留证据。
          await failMailboxFile(dataDir, item.file, "收件人是发件人自己。");
          continue;
        }

        const sent = await deliverToMember(ctx, targetMember, roomDeliveryText(labelOf(fromKey), msg.text, msg.kind), fromKey);
        if (sent.ok) {
          markRoomTurn(targetMember.key, roomKey);
          appendRoomEntry(roomKey, {
            id: `bus-${randomUUID()}`,
            senderName: fromKey,
            targetName: targetMember.key,
            targetNames: [targetMember.key],
            blocks: [{ type: "text", text: msg.text }],
            delivered: true,
          });
          await ackMailboxFile(item.file);
        } else {
          ctx.logger?.warn?.(`team-chat: 信箱投递给 ${targetMember.key} 失败（${sent.code}）：${sent.error}`);
        }
        handled += 1;
      }

      if (handled > 0) pushRoom(roomKey);
      return handled;
    };

    /**
     * 扫**所有**成员的信箱。
     *
     * 房间归属：用 `memberRoom` 里记的「这个成员最近被哪个房间叫过」；
     * 没有记录就退化成「它自己的 roomSessionId」。两条都没有就跳过 ——
     * 宁可晚一轮投递，也不要把消息记进错误的房间。
     */
    const pollMailboxes = async () => {
      const dataDir = resolveDataDir();
      const roster = members.listActive({});
      if (roster.length === 0) return;

      await ensureMailboxes(
        dataDir,
        roster.map((row) => row.key),
      );

      for (const row of roster) {
        const roomId = memberRoom.get(row.key) ?? row.roomSessionId ?? "";
        if (typeof roomId !== "string" || roomId === "") continue;
        try {
          await pumpMailbox(roomId, row.key);
        } catch (error) {
          ctx.logger?.warn?.(`team-chat: 处理 ${row.key} 的信箱失败: ${error?.message ?? error}`);
        }
      }
    };

    const busTimer = setInterval(() => {
      guardTask("pollMailboxes", pollMailboxes());
    }, BUS_POLL_MS);
    // 定时器不该拖住宿主退出。
    busTimer.unref?.();

    // 2.9) **模型面工具**：让 AI 成员能看聊天室、能 @ 别人。
    //
    // 2026-10-09 之前只有「教它往信箱写文件」这一条路，于是：
    //   · 它看不见聊天室（房间日志只喂给前端）；
    //   · 收件人必须写 ASCII 标识，用户给的中文显示名会被丢弃；
    //   · 写错收件人的消息被挪进 `mailbox/failed/` 就完了，**发送方永远不知道**。
    //
    // 现在补两个真工具（`chatroom_read` / `chatroom_send`），走官方
    // `ctx.tools.register`。工具定义与文案在 `lib/room-tools.js`，这里只负责
    // 把宿主能力注入进去（**谁在调用、发进哪个房间、怎么投递**）。
    /**
     * 投给成员时的正文前缀。
     *
     * 收件方在自己的会话里只会看到**一条 user 消息** —— 不说明来源，
     * 它没法知道这是「聊天室里有人点名给我」。用户明确要求它能分辨这个
     * （「也能够看到艾特他的智能体的信息」）。
     *
     * @param fromLabel - 发送方的显示名。
     * @param text - 原始正文。
     * @param kind - 消息类型；`note`（默认）不加尾巴。
     * @returns 投递正文。
     */
    const roomDeliveryText = (fromLabel, text, kind = "") =>
      `【聊天室 · 来自 ${fromLabel}】\n\n${text}${kind === "" || kind === "note" ? "" : `\n\n（类型：${kind}）`}`;

    /** 「我」（用户本人）在聊天室里显示的名字 —— 资料表里 `lead` 那条，没配就是「我」。 */
    const speakerLabel = () => {
      const row = members.all()[SPEAKER_SENDER];
      return typeof row?.displayName === "string" && row.displayName !== "" ? row.displayName : "我";
    };

    /**
     * 成员标识 → 显示名（没配显示名就用标识本身）。
     *
     * ⚠ 一律用**显示名**跟成员说话：给 AI 看的是标识（`market-watcher`）时，
     *   它在对话里会自称标识，而用户明明取的是中文名 —— 这个坑踩过一次。
     *
     * @param key - 成员标识。
     * @returns 显示名。
     */
    const labelOf = (key) => {
      const row = members.all()[key];
      return typeof row?.displayName === "string" && row.displayName !== "" ? row.displayName : key;
    };

    const resolveToolCaller = (sessionId) => {
      const memberKey = memberKeyOfSession(members, sessionId);
      if (memberKey === null) return null;
      const row = members.all()[memberKey];
      return {
        memberKey,
        displayName:
          typeof row?.displayName === "string" && row.displayName !== "" ? row.displayName : memberKey,
        roomKey: roomKeyOf(ctx, sessionId, members),
      };
    };

    /**
     * 把一条工具发出的消息**记进房间**并**投递给收件人**。
     *
     * ⚠ 记与投都必须在同一个函数里做完：`memberRoom` 要一并写上，
     *   否则收件人的回复回不到这个房间（2026-10-09 修过一次同类缺口）。
     */
    const sendIntoRoom = async ({ fromKey, displayName, roomKey, keys, broadcast, text, kind }) => {
      const entryId = `tool-${fromKey}-${randomUUID()}`;
      appendRoomEntry(roomKey, {
        id: entryId,
        senderName: fromKey,
        targetName: keys.length === 1 ? keys[0] : null,
        targetNames: broadcast ? [] : [...keys],
        blocks: [{ type: "text", text }],
        delivered: false,
      });
      pushRoom(roomKey);

      const roster = members.listActive({ room: roomKey }).filter((row) => row.key !== fromKey);
      const recipients = broadcast ? roster : roster.filter((row) => keys.includes(row.key));
      if (recipients.length === 0) {
        // 一个都没投出去 —— 补上状态再如实回报（前端会显示「未投递」）。
        patchRoomEntry(roomKey, entryId, { delivered: false, targetNames: [] });
        pushRoom(roomKey);
        return { ok: false, error: "这个聊天室里没有可投递的成员。" };
      }

      // 正文前面带上来源：收件方的会话里只会看到这一条 user 消息，
      // 不说明白它不知道这是「聊天室里有人点名给我」。
      const delivered = await deliverToMembers(
        ctx,
        members,
        roomKey,
        roomDeliveryText(displayName, text, kind),
        broadcast ? "" : keys.length === 1 ? keys[0] : "",
        hiddenMembers.all(),
        (member) => markRoomTurn(member.key, roomKey),
      );

      const ok = delivered.filter((row) => row.ok);
      patchRoomEntry(roomKey, entryId, {
        targetNames: ok.map((row) => row.name),
        targetName: ok.length === 1 ? ok[0].name : null,
        delivered: ok.length > 0,
      });
      pushRoom(roomKey);

      if (ok.length === 0) {
        return { ok: false, error: delivered.map((row) => `${row.name}：${row.error ?? row.code}`).join("；") };
      }
      return { ok: true };
    };

    /**
     * 登记工具。
     *
     * ⚠ **软接入**：`tools` 服务走 `ctx.get()` 探测，缺了只记一行日志。
     *   写进 `inject` 的话，「宿主没有这个服务」会升级成「整个插件不加载」——
     *   一个聊天室功能不该有那种权力。
     * ⚠ 登记本身也包在 try 里：万一官方改了 `register` 的签名，
     *   我们要的是「工具没了」而不是「插件没了」。
     */
    let toolsRegistered = false;
    // 反射式取一次，后面复用：`ctx.get(name)` 是宿主允许的**软探测**形式，
    // 属性式 `ctx.<name>` 要求先声明 inject（本插件刻意不声明，见下方注释）。
    const toolsViaGet = ctx.get?.("tools") ?? null;
    if (toolsViaGet !== null && typeof toolsViaGet.register === "function") {
      try {
        const definitions = createRoomTools({
          resolveCaller: resolveToolCaller,
          rosterOf: (roomKey) =>
            members.listActive({ room: roomKey }).map((row) => ({
              key: row.key,
              displayName:
                typeof row.displayName === "string" && row.displayName !== "" ? row.displayName : row.key,
              duty: typeof row.duty === "string" ? row.duty : "",
              isLead: row.isLead === true,
            })),
          // 房间日志的**尾部**若干条（旧的在前面）—— 给多读一点再在工具里裁，
          // 因为「只看点名的那些」需要先有足够候选。
          readEntries: (roomKey, limit) => roomLog.entriesOf(roomKey).slice(-Math.max(1, limit)),
          send: sendIntoRoom,
          logger: (message) => ctx.logger?.warn?.(`team-chat: ${message}`),
        });
        for (const definition of definitions) {
          // ⚠ 必须走 `ctx.get("tools")`（和上面那行探测**同一种写法**），
          //   不能写 `ctx.tools.register(...)`：本插件没有把 `tools` 声明进 `inject`
          //   （刻意的 —— 见上面注释：缺服务只该降级，不该让整个插件不加载），
          //   而**属性式**访问会被宿主的 inject 检查直接拦下并抛
          //   `cannot get property "tools" without inject`。
          //   那个异常又被本段 try 接住 ⇒ 只留一行 warn 就降级，现象是
          //   「聊天室功能看着正常，但 AI 成员根本没有 chatroom_read / chatroom_send 工具」。
          toolsViaGet.register(definition);
        }
        toolsRegistered = true;
        ctx.logger?.info?.(`team-chat: 已登记 ${definitions.length} 个聊天室工具（chatroom_read / chatroom_send）`);
      } catch (error) {
        ctx.logger?.warn?.(`team-chat: 聊天室工具登记失败（功能降级，插件照常跑）：${error?.message ?? error}`);
      }
    } else {
      ctx.logger?.info?.("team-chat: 宿主没有 tools 服务，聊天室工具未登记（成员仍可用文件信箱通信）");
    }

    // 3) 路由与客户端注入。
    const disposers = [
      ctx.webServer.register({
        kind: "exact",
        path: CLIENT_SCRIPT_PATH,
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405).end();
            return;
          }
          if (!passSameOrigin(req, res)) return;
          let source;
          try {
            source = await fs.readFile(path.join(here, "client.js"));
          } catch {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
            "content-length": source.byteLength,
          });
          res.end(req.method === "HEAD" ? undefined : source);
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: REPORT_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }
          if (!passSameOrigin(req, res)) return;
          // 浏览器侧的激活失败在 Electron 日志里会被截断/转义，
          // 这里把原始堆栈原样落进 harness.log，否则只能猜。
          let body = "";
          for await (const chunk of req) body += chunk;
          if (body.length > 32_768) body = body.slice(0, 32_768);
          ctx.logger.error(`team-chat[client]: ${body}`);
          sendJson(res, 200, { ok: true });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: CONFIG_PATH,
        handler: (req, res) => {
          if (req.method !== "GET") {
            res.writeHead(405).end();
            return;
          }
          if (!passSameOrigin(req, res)) return;
          sendJson(res, 200, {
            ok: true,
            /** 官方智能体团队 bundle 的真实包名，客户端不写死。 */
            teamBundle: TEAM_BUNDLE,
            /** 客户端脚本路径，供将来多入口复用。 */
            clientScript: CLIENT_SCRIPT_PATH,
            /**
             * 聊天记录的持久化状态 —— 用户报「重启后记录没了」时先看这里：
             * `rooms/entries` 是**已经读回来**的量，`error` 非空说明这次没读到盘。
             */
            roomLog: roomLog.describe(),
          });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: TIMELINE_PATH,
        handler: async (req, res) => {
          if (req.method !== "GET") {
            res.writeHead(405).end();
            return;
          }
          if (!passSameOrigin(req, res)) return;
          const url = new URL(req.url || "/", `http://${req.headers.host}`);
          const sessionId = url.searchParams.get("sessionId");
          // ⚠ 给的是**合并后**的视图（老投影条目 + 我们自建的条目），
          //    不是 `latest` 里那份裸投影 —— 成员是新体系的，
          //    它们的消息只会出现在房间日志里。
          sendJson(res, 200, {
            ok: true,
            sessionId,
            view: sessionId === null ? null : roomView(sessionId),
          });
        },
      }),
      // ── 【临时探针】独立根会话：能不能建、能不能投消息 ────────────
      //
      // ⚠ **默认不注册**，只在 `TEAM_CHAT_SPIKE=1` 时挂上。验证完就删。
      //
      // 它回答的问题：「AI 成员 = 顶层独立会话」这条路走不走得通 ——
      //   `ctx.sessionController.agents.ensureSession(id, cwd, true, preset)`
      //   → 拿到 live 的**根** agent（不是谁的子会话）
      //   → `agent.steer(一条 user 消息)` 把首条消息投进去
      //   → `ctx.workspaceRegistry.get(id).attachSession(sessionId)` 挂到工作区
      // 实测结论（2026-09-27）：三步全通 —— 会话出现在左侧栏工作区树里、
      // 那个 agent 真的跑了一个完整 turn 并回了话。
      //
      // 为什么默认关：它会**建会话**，是个有副作用的写入口，没有理由常开。
      ...(process.env.TEAM_CHAT_SPIKE === "1"
        ? [
            ctx.webServer.register({
              kind: "exact",
              path: SPIKE_PATH,
              handler: async (req, res) => {
                if (!passSameOrigin(req, res)) return;
                let params;
                try {
                  params = new URL(req.url || "/", `http://${req.headers.host}`).searchParams;
                } catch {
                  params = new URLSearchParams();
                }
                const leadId = params.get("leadSessionId") ?? "";
                const text = params.get("text") ?? "（探针）收到请只回四个字：探针成功";
                const preset = params.get("preset") ?? "";
                const sessionId = `session-${randomUUID()}`;
                const steps = [];
                try {
                  const agents = ctx.get?.("agents") ?? null;
                  const controller = ctx.get?.("sessionController") ?? null;
                  const registry = ctx.get?.("workspaceRegistry") ?? null;
                  steps.push(
                    `agents=${agents === null ? "null" : "ok"} sessionController=${controller === null ? "null" : "ok"} workspaceRegistry=${registry === null ? "null" : "ok"}`,
                  );
                  const lead = agents?.get?.(leadId);
                  if (lead === undefined) {
                    sendJson(res, 400, { ok: false, code: "SPIKE_NO_LEAD", sessionId, steps, error: `找不到 lead ${leadId}` });
                    return;
                  }
                  const cwd = lead.session.header.cwd;
                  steps.push(`cwd=${cwd}`);
                  const handle = await controller.agents.ensureSession(
                    sessionId,
                    cwd,
                    true,
                    preset === "" ? undefined : preset,
                  );
                  steps.push(`ensureSession ok handle=${typeof handle}`);
                  // 挂到工作区 —— 不挂的话会话会落在左侧栏的「未分组」里。
                  const list = registry?.list?.() ?? [];
                  const home = list.find((row) => String(row?.path ?? "").toLowerCase() === String(cwd).toLowerCase());
                  steps.push(`workspace=${home === undefined ? "未匹配" : home.id}`);
                  if (home !== undefined && typeof home.attachSession === "function") {
                    await home.attachSession(sessionId);
                    steps.push("attached");
                  }
                  const created = agents.get?.(sessionId);
                  steps.push(`root agent=${created === undefined ? "undefined" : "ok"} steer=${typeof created?.steer}`);
                  if (created !== undefined && typeof created.steer === "function") {
                    // 刻意**不** import `createUserMessage`：`@deepseek-ai/dsh-llm`
                    // 从插件目录解析不到（link: 安装不带上游 node_modules）。
                    // 而它本体就是 `deepFreeze(structuredClone({...input, id: randomUUID()}))` ——
                    // 手搓一个同形状的对象即可。
                    created.steer({
                      id: randomUUID(),
                      role: "user",
                      content: [{ type: "text", text }],
                      source: { kind: "team-chat-spike" },
                    });
                    steps.push("steered");
                  }
                  sendJson(res, 200, { ok: true, sessionId, cwd, steps });
                } catch (error) {
                  sendJson(res, 500, {
                    ok: false,
                    code: typeof error?.code === "string" ? error.code : "SPIKE_FAILED",
                    sessionId,
                    steps,
                    error: error?.message ?? String(error),
                  });
                }
              },
            }),
          ]
        : []),
      ctx.webServer.register({
        kind: "exact",
        path: MEMBERS_PATH,
        handler: async (req, res) => {
          if (!passSameOrigin(req, res)) return;

          if (req.method === "GET") {
            sendJson(res, 200, {
              ok: true,
              members: members.all(),
              store: members.describe(),
              // 「已移除」名单 —— 客户端据此在各处不列出这些成员。
              // ⚠ 别只加在 POST 的返回上（我第一次就加错了地方，GET 一直不返回它）。
              removed: hiddenMembers.all(),
            });
            return;
          }

          if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }

          let body = "";
          for await (const chunk of req) {
            body += chunk;
            // 上限由 `MAX_MEMBER_BYTES` 推导 —— 别再写死数字，
            // 写死过一次（128 KiB），头像上限提了它没提，600 KB 的图直接被 413 掐。
            if (body.length > MEMBERS_BODY_LIMIT) {
              sendJson(res, 413, { ok: false, error: "请求体过大。" });
              return;
            }
          }

          let payload;
          try {
            payload = JSON.parse(body);
          } catch {
            sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON。" });
            return;
          }

          if (payload === null || typeof payload !== "object") {
            sendJson(res, 400, { ok: false, error: "请求体必须是对象。" });
            return;
          }

          const key = typeof payload.key === "string" ? payload.key : "";
          const action = typeof payload.action === "string" ? payload.action : "set";

          if (action === "remove") {
            const removed = await members.remove(key);
            if (!removed.ok) {
              sendJson(res, 500, { ok: false, error: removed.error });
              return;
            }
            broadcast({ type: "members", members: members.all() });
            // `removed` 是「已移除」名单 —— 客户端据此在各处不列出这些成员。
            sendJson(res, 200, { ok: true, members: members.all(), removed: hiddenMembers.all() });
            return;
          }

          // ── 主智能体唯一性：**编辑已有成员**这条路径也要守 ──────────
          //
          // 这条路由原来直接落库，于是只有「添加成员」能指定主智能体 ——
          // 已建好的成员既升不上去（编辑表单保存时压根不带 `isLead` 这个字段），
          // 也降不下来。这里补上那个洞，规矩与 `/__teamchat/spawn` **完全一致**：
          // 房里有别人当值 → 客户端要显式传 `replaceLead: true` 才让换人，
          // 没传就拒绝（把现在是谁告诉界面）。
          //
          // ⚠ 只在**显式要求升为主智能体**（`isLead === true`）时才检查：
          //   不传 / 传 `false` 一律直接写。这正是 `member-store` 那条
          //   「只有显式传布尔才写」在防的事 —— 改个头像不该把身份位动掉。
          // ⚠ 也排除**自己**：已经是主智能体的成员再保存一次（改名字）不该被自己挡住。
          const rawMember = payload.member;
          if (rawMember !== null && typeof rawMember === "object" && rawMember.isLead === true) {
            // 房间键 = 这个成员所在的工作区（与 `listActive({room})` 的筛法同一套）。
            // 还没有会话的「预配资料」算不出房间 —— 那种条目不属于任何房间，
            // 唯一性等它被收编时由 spawn 路由定夺，这里不拦（也不误伤别的房间）。
            const existing = members.get(key) ?? {};
            const roomKey = roomKeyOf(
              ctx,
              typeof existing.sessionId === "string" ? existing.sessionId : "",
              members,
            );
            if (roomKey !== "") {
              const currentLead = members
                .listActive({ room: roomKey })
                .find((row) => row.isLead === true && row.key !== key);
              if (currentLead !== undefined && payload.replaceLead !== true) {
                sendJson(res, 409, {
                  ok: false,
                  code: "TEAM_LEAD_EXISTS",
                  error: `这个聊天室已经有主智能体了：「${currentLead.displayName || currentLead.key}」。要换人的话请先确认。`,
                  currentLead: { name: currentLead.key, displayName: currentLead.displayName || "" },
                });
                return;
              }
              // 先降级原来那个，再写新的 —— 与 spawn 路由同序。
              // 先写新的会短暂存在两个主智能体（汇报没有唯一去处）。
              if (currentLead !== undefined) {
                await members.set(currentLead.key, { isLead: false });
              }
            }
          }

          const written = await members.set(key, payload.member);
          if (!written.ok) {
            sendJson(res, 400, { ok: false, error: written.error });
            return;
          }
          // 显示名改了 → 把**已经在跑的**那个成员会话的标题一起改掉。
          // 不改的话界面上的名字和左侧栏那一行会一直不一致 —— 这正是用户
          // 最容易觉得「改了没反应」的地方。会话不在跑时静默跳过。
          //
          // `force: true`：我们自己设的标题写进去也是 `source.kind === "user"`，
          // 不强制就改不动自己上一次设的标题。
          const renamed = await renameTitle(
            ctx,
            written.member.sessionId,
            written.member.displayName,
            written.member.key,
            true,
          );
          broadcast({ type: "members", members: members.all() });
          sendJson(res, 200, {
            ok: true,
            member: written.member,
            members: members.all(),
            rename: { ok: renamed },
          });
        },
      }),
      // ── 可挂载的 Lead 会话 ──────────────────────────────────
      //
      // 「新建 AI 成员」必须挂到某个 root 会话上（官方 Team 协议里
      // teammate 只能是某个 Lead 的子会话）。客户端要能选，所以这里把
      // **live 的 root agent** 列出来。
      ctx.webServer.register({
        kind: "exact",
        path: TARGETS_PATH,
        handler: async (req, res) => {
          if (!passSameOrigin(req, res)) return;
          if (req.method !== "GET") {
            res.writeHead(405).end();
            return;
          }

          const agents = ctx.get?.("agents") ?? null;
          const live = typeof agents?.list === "function" ? agents.list() : [];

          // ── 候选会话：**以会话为准**，不能只看 live agent ──────────
          //
          // ⚠ 用户反馈「很多时候只显示当前窗口，其他窗口不显示」。
          //   原因就是这里原来只用 `agents.list()` —— 它只持有**已实例化的
          //   live agent**：用户打开了三个对话，但只有被唤醒过的那些才有 agent，
          //   「打开着但没跑过」的窗口会整个从清单里消失。
          //
          //   而收编本身**不要求目标已经是 live agent** —— `adoptMember` 里
          //   会 `ensureSession` 把它唤醒（见 member-runtime.js 的 memberAgent）。
          //   所以清单必须以**会话**为准。
          //
          // 两个来源合并去重：`sessions.list()` 是全量已加载会话，
          // `agents.list()` 兜住「会话存储里还没登记但 agent 已起」的边角情况。
          const storedSessions = (() => {
            try {
              const list = ctx.get?.("sessions")?.list?.();
              return Array.isArray(list) ? list : [];
            } catch {
              // 服务缺失/契约变了都当成「没有这个来源」，不影响另一个来源
              return [];
            }
          })();

          const candidates = new Map();
          for (const one of storedSessions) {
            const id = one?.header?.id;
            if (typeof id === "string" && id !== "") candidates.set(id, one);
          }
          for (const agent of live) {
            const one = agent?.session;
            const id = one?.header?.id;
            if (typeof id === "string" && id !== "" && !candidates.has(id)) {
              candidates.set(id, one);
            }
          }


          // **已经被收编成成员的会话要从清单里去掉** ——
          // 留着它只会诱导用户对同一个窗口再收编一次；
          // 要改成员就去成员面板改（名字 / 头像 / 职责都在那儿）。
          //
          // ⚠ 判据用 `sessionId` 而不是成员键：成员键是**名字**、会改名，sessionId 不会。
          const taken = new Set();
          for (const one of Object.values(members.all())) {
            if (typeof one?.sessionId === "string" && one.sessionId !== "") taken.add(one.sessionId);
          }

          const targets = [];
          for (const target of candidates.values()) {
            const header = target?.header;
            // 只收 root：有 parentSession 的是别人的子会话，不能当 Lead。
            // ⚠ 两种判据都看：`header.parentSession` 是我们一直在用的；
            //   官方在客户端侧判可见性用的是 `session.origin === "subagent"`
            //   （见 dsh-client-ui-workspace 的 sessionVisible）——
            //   存在能过前者、却被后者认成子会话的会话。
            if (header === undefined || header.parentSession !== undefined) continue;
            if (target.origin === "subagent") continue;
            // 已经是某个成员了 → 跳过（见上面 taken 的说明）
            if (taken.has(header.id)) continue;
            let memberCount = 0;
            try {
              const view = ctx.sessionProjections.stateOf(target, "agentTeam");
              memberCount = Array.isArray(view?.members) ? view.members.length : 0;
            } catch {
              /* 投影还没起来就当 0 */
            }
            // 对话的**原本名字** —— 收编对话框要让用户一眼认出
            // 「我要收编的是哪个对话」，而不是对着一串 id 后 6 位猜。
            // 拿不到就交给前端退回「目录名 · id 后 6 位」。
            let title = null;
            try {
              title = ctx.get?.("sessionTitle")?.get?.(target)?.title ?? null;
            } catch {
              /* 读不到标题不影响收编 */
            }
            targets.push({
              sessionId: header.id,
              cwd: typeof header.cwd === "string" ? header.cwd : null,
              running: target.running === true,
              memberCount,
              title: typeof title === "string" && title.trim() !== "" ? title.trim() : null,
            });
          }
          // `sources` 只用于诊断「为什么某个窗口没出现」——
          // 界面上不显示，但出问题时一眼能看出是哪个来源漏了。
          sendJson(res, 200, {
            ok: true,
            targets,
            sources: { stored: storedSessions.length, live: live.length },
          });
        },
      }),
      // ── 官方 Agent 预设（「模式」）──────────────────────────
      ctx.webServer.register({
        kind: "exact",
        path: PRESETS_PATH,
        handler: async (req, res) => {
          if (!passSameOrigin(req, res)) return;
          if (req.method !== "GET") {
            res.writeHead(405).end();
            return;
          }

          const presets = ctx.get?.("agentPresets") ?? null;
          if (presets === null || typeof presets.list !== "function") {
            // 不算错误：没装/没启用预设服务时不显示「模式」板块即可。
            sendJson(res, 200, { ok: true, available: false, presets: [] });
            return;
          }
          try {
            const rows = await presets.list();
            sendJson(res, 200, {
              ok: true,
              available: true,
              presets: (rows ?? []).map((row) => ({
                id: row.id,
                name: typeof row.name === "string" ? row.name : null,
                description: typeof row.description === "string" ? row.description : null,
                order: typeof row.order === "number" ? row.order : null,
                broken: row.broken === undefined ? null : row.broken,
              })),
            });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
          }
        },
      }),
      // ── 聊天室的成员名单 ────────────────────────────────────
      //
      // **来源是我们自己的成员库**（`members.json` 里带 `sessionId` 的条目），
      // 不再读官方 `agentTeam` 投影 —— 成员已经不是官方 teammate 了。
      //
      // `?sessionId=<房间>` 只返回**属于这个聊天室**的成员（建的时候记了
      // `roomSessionId`）；不带参数返回全部。
      //
      // 行里把显示名 / 职责 / 头像一起给出去，前端不用再查资料表 ——
      // 一份数据一个来源，少一处不一致。
      ctx.webServer.register({
        kind: "exact",
        path: TEAM_MEMBERS_PATH,
        handler: async (req, res) => {
          if (!passSameOrigin(req, res)) return;
          if (req.method !== "GET") {
            res.writeHead(405).end();
            return;
          }

          let only = "";
          try {
            only = new URL(req.url || "/", `http://${req.headers.host}`).searchParams.get("sessionId")?.trim() ?? "";
          } catch {
            only = "";
          }

          const agents = ctx.get?.("agents") ?? null;
          // `only` 是会话 id —— 房间按工作区算，交给 roomKeyOf 转换
          const roomKey = only === "" ? "" : roomKeyOf(ctx, only, members);
          const rows = members.listActive(roomKey === "" ? {} : { room: roomKey }).map((row) => ({
            name: row.key,
            displayName: typeof row.displayName === "string" ? row.displayName : "",
            duty: typeof row.duty === "string" ? row.duty : "",
            avatar: row.avatar ?? null,
            sessionId: row.sessionId,
            cwd: typeof row.cwd === "string" ? row.cwd : "",
            preset: typeof row.preset === "string" ? row.preset : "",
            // 主智能体标记 —— 界面据此在名字旁边挂一个「指挥」角标。
            isLead: row.isLead === true,
            // 成员会话是普通会话，可能被回收 —— 这里如实报告它现在在不在跑。
            running: agents?.get?.(row.sessionId) !== undefined,
            // ── 交替（succession）留下的痕迹 ────────────────────
            //
            // ⚠ 只给**元信息**，不给交接说明全文：名单每次刷新都要传，
            //   而一份交接说明最多 12 000 字。要看全文的界面走 `/__teamchat/members`
            //   （那里给的是成员资料的完整内容）。
            //
            // `handover.source` 必须一路带到界面：`llm` / `none` 这两种
            // **不是它自己写的**，用户有权知道（这是用户明确要求过的）。
            handover: row.handover === undefined
              ? null
              : {
                  source: typeof row.handover.source === "string" ? row.handover.source : "unknown",
                  createdAt: typeof row.handover.createdAt === "string" ? row.handover.createdAt : "",
                  chars: typeof row.handover.text === "string" ? row.handover.text.length : 0,
                  structured: row.handover.structured === true,
                  truncated: row.handover.truncated === true,
                },
            // 被交替掉过几任（归档 ≠ 删除：那些会话都还在左侧栏里）。
            archivedCount: Array.isArray(row.archivedSessions) ? row.archivedSessions.length : 0,
            handedOverFrom: typeof row.handedOverFrom === "string" ? row.handedOverFrom : "",
          }));

          sendJson(res, 200, { ok: true, members: rows, removed: hiddenMembers.all() });
        },
      }),
      // ── 修正成员窗口标题 ────────────────────────────────────
      //
      // 成员的窗口就是它的会话，左栏那一行显示的是**会话标题**。
      // 标题是在创建时设成显示名的，但可能有几种情况需要补一刀：
      // 早期版本建的、会话被回收后又恢复的、或者显示名改过但标题没跟上。
      //
      // `force: true` —— 这是**显式**的修正动作，可以把我们自己之前设的
      // 标题也盖掉（我们自己设的 `source.kind` 也是 "user"，不 force 就改不动）。
      // 后台自动刷的那条走 `force: false`，不动用户手动改过的名字。
      //
      // 返回 `{changed, members, live}` —— 没改动时能看出卡在哪一步
      //（比如成员会话当前没在跑，而 `rename` 要求会话 live）。
      ctx.webServer.register({
        kind: "exact",
        path: REFRESH_TITLES_PATH,
        handler: async (req, res) => {
          if (!passSameOrigin(req, res)) return;
          if (req.method !== "GET" && req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }
          try {
            sendJson(res, 200, { ok: true, titles: await refreshMemberTitles(ctx, members, true) });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
          }
        },
      }),
      // ── 给成员发消息（默认广播 / @ 定向）──────────────────────
      ctx.webServer.register({
        kind: "exact",
        path: SEND_PATH,
        handler: async (req, res) => {
          if (!passSameOrigin(req, res)) return;
          if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }

          const parsed = await readJsonBody(req, SEND_BODY_LIMIT);
          if (!parsed.ok) {
            sendJson(res, parsed.status, { ok: false, error: parsed.error });
            return;
          }

          const parentSessionId =
            typeof parsed.value?.parentSessionId === "string" ? parsed.value.parentSessionId.trim() : "";
          const text = typeof parsed.value?.text === "string" ? parsed.value.text.trim() : "";
          const target = typeof parsed.value?.target === "string" ? parsed.value.target.trim() : "";
          if (text === "") {
            sendJson(res, 400, { ok: false, code: "TEAM_EMPTY_MESSAGE", error: "消息不能为空。" });
            return;
          }
          if (parentSessionId === "") {
            sendJson(res, 400, { ok: false, code: "TEAM_NO_ROOM", error: "缺少会话 id。" });
            return;
          }

          // ⚠ 不再需要 live 的 Lead agent —— 成员是独立会话，投递靠 `steer`。
          //    老实现里「Lead 会话没打开就发不出去」这个坑随之消失。
          const roomKey = roomKeyOf(ctx, parentSessionId, members);
          const delivered = await deliverToMembers(
            ctx,
            members,
            parentSessionId,
            text,
            target,
            hiddenMembers.all(),
            // ⚠ 这条路径原来**完全没记**房间归属 ⇒ 从 /send 发出去的消息，
            //    成员的回复永远回不到这个房间。与输入框那条路补齐。
            (member) => {
              markRoomTurn(member.key, roomKey);
            },
          );
          appendRoomEntry(roomKey, {
            id: `send-${randomUUID()}`,
            senderName: SPEAKER_SENDER,
            targetName: delivered.length === 1 ? delivered[0].name : null,
            targetNames: delivered.filter((row) => row.ok).map((row) => row.name),
            blocks: [{ type: "text", text }],
            delivered: delivered.some((row) => row.ok),
          });
          pushRoom(roomKey);
          sendJson(res, 200, { ok: delivered.some((row) => row.ok), delivered });
        },
      }),
      // ── 设定「发送到团队」的范围 ────────────────────────────
      //
      // 客户端在官方输入框左侧的「发送到团队」里选完范围后调这里。
      // `target: null` = 取消（回到普通对话）。
      ctx.webServer.register({
        kind: "exact",
        path: SCOPE_PATH,
        handler: async (req, res) => {
          if (!passSameOrigin(req, res)) return;
          if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }
          const parsed = await readJsonBody(req, SEND_BODY_LIMIT);
          if (!parsed.ok) {
            sendJson(res, parsed.status, { ok: false, error: parsed.error });
            return;
          }
          const parentSessionId =
            typeof parsed.value?.parentSessionId === "string" ? parsed.value.parentSessionId.trim() : "";
          if (parentSessionId === "") {
            sendJson(res, 400, { ok: false, error: "缺少会话 id。" });
            return;
          }
          if (parsed.value?.target === null) {
            sendScope.delete(parentSessionId);
          } else {
            const target = typeof parsed.value?.target === "string" ? parsed.value.target.trim() : "";
            sendScope.set(parentSessionId, target);
          }
          sendJson(res, 200, { ok: true, scope: sendScope.get(parentSessionId) ?? null });
        },
      }),
      // ── 移除成员（停止 + 从本插件界面隐藏）──────────────────
      ctx.webServer.register({
        kind: "exact",
        path: REMOVE_PATH,
        handler: async (req, res) => {
          if (!passSameOrigin(req, res)) return;
          if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }

          const parsed = await readJsonBody(req, SEND_BODY_LIMIT);
          if (!parsed.ok) {
            sendJson(res, parsed.status, { ok: false, error: parsed.error });
            return;
          }

          const parentSessionId =
            typeof parsed.value?.parentSessionId === 'string' ? parsed.value.parentSessionId.trim() : '';
          const memberName = typeof parsed.value?.name === 'string' ? parsed.value.name.trim() : '';
          if (memberName === '') {
            sendJson(res, 400, { ok: false, code: 'TEAM_INVALID_MEMBER_NAME', error: '缺少成员名。' });
            return;
          }

          const profile = members.get(memberName);
          if (profile === undefined) {
            sendJson(res, 404, {
              ok: false,
              code: 'TEAM_MEMBER_NOT_FOUND',
              error: `聊天室里没有叫「${memberName}」的成员。`,
            });
            return;
          }

          // ── 移除 = 从我们的成员列表里删掉 ──────────────────────
          //
          // ⚠ 和改版前完全相反：那时成员是官方 teammate，协议 append-only、
          //    **根本删不掉**，只能「停运行 + 本地藏起来」。
          //    现在成员是**独立的普通会话**，从列表删掉就真的不再是成员了，
          //    而它那个对话窗口**留在左侧栏** —— 用户想删随时能在那儿删掉。
          //    这正是用户要的：「对话我随时可以删掉，但子智能体我无法管理。」
          const removed = await members.remove(memberName);
          if (!removed.ok) {
            sendJson(res, 500, { ok: false, error: removed.error ?? '删除成员失败。' });
            return;
          }

          // 顺带把「已移除」名单里可能残留的同名记录清掉 —— 免得以后重建同名成员时被它藏起来。
          await hiddenMembers.remove(memberName);
          broadcast({ type: 'members', members: members.all(), hidden: hiddenMembers.all() });

          sendJson(res, 200, {
            ok: true,
            // 客户端据此提示「那个对话窗口还在左栏」。
            sessionId: typeof profile.sessionId === 'string' ? profile.sessionId : null,
            parentSessionId,
            note:
              '已从成员列表移除。它的**对话窗口还在左侧栏工作区里** —— ' +
              '不想留就直接在那里删掉那个会话。',
          });
        },
      }),
      // ── 成员交替（交接 / succession）────────────────────────
      //
      // 「这个会话上下文太长了，换一个」——但身份与上下文继承过去。
      //
      // ⚠⚠ 这条路由是**同步等待**的：它要等旧会话里那个 AI 自己把交接说明写出来
      //     （上限见 `succession.js` 的 HANDOVER_WAIT_MS，90 秒）。
      //     用户点的是「交替」按钮、界面上有进度提示，所以等待是产品行为，
      //     不是「发起就不管的后台任务」—— 后者才必须走 `guardTask`。
      //
      // ⚠ 但**异常绝不许冒出去**：`runSuccession` 内部层层 try/catch、
      //    永不抛错；这里再加一层，保证任何情况下都有一条可读的 JSON 回执
      //    （2026-10-09 那场「插件抛错杀宿主」的教训：插件是住客）。
      ctx.webServer.register({
        kind: "exact",
        path: SUCCESSION_PATH,
        handler: async (req, res) => {
          try {
            if (!passSameOrigin(req, res)) return;
            if (req.method !== "POST") {
              res.writeHead(405).end();
              return;
            }

            const parsed = await readJsonBody(req, SUCCESSION_BODY_LIMIT);
            if (!parsed.ok) {
              sendJson(res, parsed.status, { ok: false, code: "BAD_REQUEST", error: parsed.error });
              return;
            }

            const memberKey = typeof parsed.value?.memberKey === "string" ? parsed.value.memberKey.trim() : "";
            if (memberKey === "") {
              sendJson(res, 400, { ok: false, code: "MEMBER_NO_KEY", error: "缺少成员名。" });
              return;
            }

            // 「旧会话归档」是默认（用户拍板），界面可以选「保留」。
            // ⚠ 两种模式**都不删任何会话**，差别只在界面怎么解释与旧会话要不要改名。
            const archive = parsed.value?.archive !== "keep";

            const result = await runSuccession(ctx, members, {
              memberKey,
              archive,
              dataDir: resolveDataDir(),
              // 新会话开场消息的「身份 + 职责 + 专属指令 + 通信协议」那一段，
              // 复用与「收编成员」**同一套措辞**（buildMemberPrompt），
              // 免得新会话拿到的团队协议与别的成员不一样。
              buildBasePrompt: (member) =>
                buildMemberPrompt(
                  memberKey,
                  typeof member.duty === "string" ? member.duty : "",
                  "",
                  typeof member.instructions === "string" ? member.instructions : "",
                  {
                    displayName: typeof member.displayName === "string" ? member.displayName : "",
                    dataDir: resolveDataDir(),
                    roster: members.listActive({ room: roomKeyOf(ctx, resolveRoomId(member), members) }).map((row) => ({
                      key: row.key,
                      displayName: row.displayName,
                    })),
                    tools: toolsRegistered,
                    isLead: member.isLead === true,
                  },
                ),
            });

            if (result.ok !== true) {
              // 失败一律 409/500 之外的明确状态码：这里用 502 —— 「宿主没做成交替」，
              // 与「请求不合法（4xx）」区分开，客户端按 code 挑文案。
              sendJson(res, 502, { ok: false, ...result });
              return;
            }

            // 身份/资料变了 → 让所有界面刷新（名单、头像、显示名都会立刻对上）。
            broadcast({ type: "members", members: members.all() });
            sendJson(res, 200, { ok: true, ...result, members: members.all() });
          } catch (error) {
            // 最后一道防线：连回执都写不出去时也不能抛（见上面那段注释）。
            try {
              ctx.logger?.error?.(`team-chat: [succession-route] ${error?.stack ?? String(error)}`);
            } catch {
              /* ignore */
            }
            try {
              sendJson(res, 500, {
                ok: false,
                code: typeof error?.code === "string" ? error.code : "SUCCESSION_ROUTE_FAILED",
                error: `交替路由异常：${error?.message ?? String(error)}`,
              });
            } catch {
              /* 响应已经发出去了，什么也做不了 */
            }
          }
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: SPAWN_PATH,
        handler: async (req, res) => {
          if (!passSameOrigin(req, res)) return;
          if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }

          // ⚠ **收编语义**（第 21 轮定案）：成员 = 用户**已打开的对话窗口**，
          //    不再 `ensureSession` 另开一个。所以这里：
          //    - 不收 `parentSessionId`（房间由被收编会话自己的工作区决定）；
          //    - 收 `sessionId`（要收编的那个已有窗口）。
          const agents = ctx.get?.("agents") ?? null;
          const sessions = ctx.get?.("sessions") ?? null;

          const parsed = await readJsonBody(req, SPAWN_BODY_LIMIT);
          if (!parsed.ok) {
            sendJson(res, parsed.status, { ok: false, code: "BAD_REQUEST", error: parsed.error });
            return;
          }

          const { sessionId: rawSessionId, name, description, preset, displayName, avatar, isLead } =
            parsed.value;

          // ── 目标会话：要收编的那个已有窗口 ─────────────────────
          const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
          if (sessionId === "") {
            sendJson(res, 400, {
              ok: false,
              code: "MEMBER_NO_SESSION",
              error: "缺少要收编的会话 id。",
            });
            return;
          }
          const targetSession =
            typeof sessions?.get === "function"
              ? sessions.get(sessionId)
              : (findLiveAgent(agents, sessionId)?.session ?? undefined);
          if (targetSession === undefined || targetSession === null) {
            sendJson(res, 404, {
              ok: false,
              code: "MEMBER_TARGET_NOT_FOUND",
              error: "找不到这个会话（可能已被删除）。请回到你想收编的那个窗口再试。",
            });
            return;
          }
          // 子会话不收 —— 那是别人的子智能体，收编它等于让两个系统抢着管同一个 agent。
          if (targetSession.header?.parentSession !== undefined) {
            sendJson(res, 409, {
              ok: false,
              code: "MEMBER_TARGET_IS_SUBAGENT",
              error: "这个会话是别人的子智能体，不能被收编成成员。请挑一个你自己开的对话。",
            });
            return;
          }
          const cwd = typeof targetSession.header?.cwd === "string" ? targetSession.header.cwd : "";
          if (cwd === "") {
            sendJson(res, 409, {
              ok: false,
              code: "MEMBER_NO_ROOM",
              error: "这个会话没有工作目录，无法收编成成员。",
            });
            return;
          }

          // ── 房间：**发起收编的那个窗口所在的工作区** ──────────────
          //
          // ⚠⚠ 原来写的是 `const roomSessionId = sessionId;` —— 而 `sessionId`
          //   是**被收编**的那个窗口（客户端选中的 targetId）。于是
          //   「在 A 里收编 B」会把 B 记进 **B 自己的房间**：
          //   A 的成员面板（房间 = A）永远看不到 B —— 这正是用户报的
          //   「我把 AI 成员加进来了，成员列表里却没有」。
          //
          // 现在以**发起窗口**为准，再按**工作区**归房：同一个项目目录下的
          // 所有窗口共享一个聊天室（用户的要求：「如果他们是同一个工作区的，
          // 他们的聊天室应该共享」）。
          const rawRoomSessionId =
            typeof parsed.value.roomSessionId === "string" ? parsed.value.roomSessionId.trim() : "";
          // 客户端没传就退回被收编的窗口（旧行为，至少不会算进别的房间）
          const roomSessionId = rawRoomSessionId !== "" ? rawRoomSessionId : sessionId;
          // 房间键 = 发起窗口的工作区；解析不出来就退回被收编会话的工作区
          const resolvedRoom = roomKeyOf(ctx, roomSessionId, members);
          const roomCwd = resolvedRoom === roomSessionId ? cwd : resolvedRoom;

          // ── 成员标识（内部）──────────────────────────────────
          //
          // ⚠ **用户只需要给一个「名字」**（显示名，可中英文）；标识是内部的事。
          //   它有两个硬约束（`[a-z0-9-]` + 要当信箱目录名），
          //   逼用户自己想一个英文标识体验很差 —— 没填就自动派生。
          let memberName = typeof name === "string" ? name.trim() : "";
          if (memberName === "") {
            memberName = deriveMemberKey(
              sessionId,
              typeof displayName === "string" ? displayName.trim() : "",
              members,
            );
          }
          if (!MEMBER_NAME.test(memberName) || memberName.length > MAX_MEMBER_NAME || memberName === "lead") {
            sendJson(res, 400, {
              ok: false,
              code: "TEAM_INVALID_MEMBER_NAME",
              error: "成员标识只能用 a-z、0-9 和小写连字符，长度不超过 64，且不能叫 lead。留空可自动生成。",
            });
            return;
          }

          // 「主智能体」标记：一个聊天室**只允许一个**。
          //
          // 用户拍板的协作语义是「主智能体坐镇指挥、接收汇报并检查」——
          // 两个主智能体的话汇报就不止一个去处，职责会打架。所以：
          // ① 已有主智能体 → 客户端要显式传 `replaceLead: true` 才让换人；
          //    没传就拒绝，让界面先把话说清楚。
          // ② 建新成员时如果房里的主智能体已经不在了（被移除），允许重新指定。
          const isLeadMember = isLead === true;

          const detail = typeof description === "string" ? description.trim().slice(0, MAX_DESCRIPTION) : "";
          if (detail === "") {
            sendJson(res, 400, {
              ok: false,
              code: "TEAM_MISSING_DESCRIPTION",
              error: "必须填写职责描述（官方要求，≤200 字）。",
            });
            return;
          }

          // ── 「模式」= 官方 Agent 预设 ───────────────────────────
          //
          // 空串 = 不指定（保留该会话当前用的预设 —— 它已经在跑了，不强行换）。
          // 指定了就必须先确认它真的存在。
          const presetId = typeof preset === "string" ? preset.trim() : "";
          if (presetId !== "") {
            const registry = ctx.get?.("agentPresets") ?? null;
            if (registry === null || typeof registry.list !== "function") {
              sendJson(res, 503, {
                ok: false,
                code: "TEAM_PRESET_UNAVAILABLE",
                error: "当前宿主没有可用的 Agent 预设服务，无法指定模式。",
              });
              return;
            }
            let known = [];
            try {
              known = (await registry.list()).map((row) => row.id);
            } catch (error) {
              sendJson(res, 500, { ok: false, code: "TEAM_PRESET_LIST_FAILED", error: error?.message ?? String(error) });
              return;
            }
            if (!known.includes(presetId)) {
              sendJson(res, 400, {
                ok: false,
                code: "TEAM_UNKNOWN_PRESET",
                error: `没有名为 ${presetId} 的 Agent 预设。可用：${known.join(" / ") || "（无）"}`,
              });
              return;
            }
          }

          // 设置页里配过的资料：专属指令沿用那份。
          const own = members.get(memberName) ?? {};

          // ── 主智能体唯一性 ────────────────────────────────────
          //
          // 一个聊天室只能有一个主智能体。已经有别人当着的时候：
          // - 客户端没传 `replaceLead` → 拒绝，并把它现在是谁告诉界面。
          // - 传了 → 把原来那个降级成普通成员，再把这个升上去。
          //
          // ⚠ 降级只改我们自己的资料表。官方的 team 投影早就不参与了，
          //    所以这里不存在「两边状态不同步」的问题。
          if (isLeadMember) {
            const currentLead = members
              .listActive({ room: roomCwd })
              .find((row) => row.isLead === true && row.key !== memberName);
            if (currentLead !== undefined && parsed.value?.replaceLead !== true) {
              sendJson(res, 409, {
                ok: false,
                code: "TEAM_LEAD_EXISTS",
                error: `这个聊天室已经有主智能体了：「${currentLead.displayName || currentLead.key}」。要换人的话请先确认。`,
                currentLead: { name: currentLead.key, displayName: currentLead.displayName || "" },
              });
              return;
            }
            if (currentLead !== undefined) {
              await members.set(currentLead.key, { isLead: false });
            }
          }

          const wantedDisplayName = typeof displayName === "string" ? displayName.trim() : "";
          const finalDisplayName =
            wantedDisplayName !== ""
              ? wantedDisplayName
              : typeof own.displayName === "string"
                ? own.displayName
                : "";

          const adopted = await adoptMember(ctx, members, {
            name: memberName,
            displayName: finalDisplayName,
            duty: detail,
            instructions: typeof own.instructions === "string" ? own.instructions : "",
            // `undefined` = 这次没传头像，**不要动**已有的那份。
            avatar: avatar === undefined ? undefined : avatar,
            preset: presetId,
            sessionId,
            cwd,
            roomSessionId,
            roomCwd,
            prompt: buildMemberPrompt(memberName, detail, "", own.instructions, {
              // 自称用显示名（见 buildMemberPrompt 的注释）
              displayName: finalDisplayName,
              dataDir: resolveDataDir(),
              // 同房间此刻已有的成员（含正在收编的自己）—— 通信协议要知道能发给谁。
              // ⚠ 带**显示名**：用户取的是中文名，而信箱目录/收件人字段用的是标识，
              //   协议里两个都给（工具认显示名，文件路径认标识）。
              roster: [
                ...members.listActive({ room: roomCwd }).map((row) => ({
                  key: row.key,
                  displayName: row.displayName,
                })),
                ...(members.all()[memberName] === undefined
                  ? [{ key: memberName, displayName: finalDisplayName }]
                  : []),
              ],
              // 工具登记成功才在说明书里提它。
              tools: toolsRegistered,
              isLead: isLeadMember,
            }),
          });
          if (adopted.ok !== true) {
            sendJson(res, 502, {
              ok: false,
              code: typeof adopted.code === "string" ? adopted.code : "TEAM_SPAWN_FAILED",
              error: adopted.error ?? "收编成员失败。",
              sessionId: adopted.sessionId ?? null,
            });
            return;
          }

          // 崩了又重建同名成员：把它从「已移除」名单里放出来，别再被藏起来。
          await hiddenMembers.remove(memberName);

          // 主智能体标记**在收编之后写** —— `adoptMember` 内部的 `store.set`
          // 会把资料整体覆盖一遍，提前写会被冲掉。
          if (isLeadMember) {
            await members.set(memberName, { isLead: true });
          }

          // 信箱目录：同房间所有成员各建一个 —— 成员用写文件工具发消息时
          // 父目录必须已经存在，否则它会失败。
          //
          // ⚠ **必须 await，不能用 `void`。** 这里踩过一次：先前写成 fire-and-forget，
          //    于是「刚建好成员 → 它立刻发消息」时目录可能还没落盘 → 成员那侧的
          //    写文件直接 ENOENT 失败，而界面一切正常，极难排查。
          //    mkdir 是本地调用，几十微秒，不值得为它省这点时间。
          await ensureMailboxes(
            resolveDataDir(),
            members.listActive({ room: roomCwd }).map((row) => row.key),
          );

          // ── 会话标题与显示名对齐（2026-10-08 用户要求）──────────────
          //
          // ⚠ 原来这里**写死不动标题**（注释还留着「收编不覆盖玩家自己会话的名字」），
          //   那是成员还有「自己新建一个窗口」时的语义。
          //   现在成员 = 用户自己的一个对话窗口，产品语义是**单向绑定**：
          //   窗口名 = 显示名，改显示名会同步过来，在对话界面直接改会被改回。
          //
          //   为什么不能只靠后台刷新：`refreshMemberTitles` 只在
          //   `session/title` 事件或显式路由里跑，而**收编本身不改标题** ⇒
          //   不会触发那个事件 ⇒ 标题要一直等到别的原因触发刷新才会对齐。
          //   所以收编当刻必须自己对齐一次。
          const renamed = await renameTitle(ctx, sessionId, finalDisplayName, memberName, true);

          sendJson(res, 200, {
            ok: true,
            member: { name: memberName, id: adopted.sessionId, isLead: isLeadMember },
            // 被收编的就是这个已有会话 —— 客户端据此告诉用户「已收编」，
            // 而不是「建了新窗口」。
            window: { sessionId: adopted.sessionId, parentSessionId: roomSessionId, waitedMs: 0 },
            // 标题按显示名对齐了；显示名为空时保持原样（kept: true）。
            title: { ok: renamed, kept: finalDisplayName.trim() === "" },
            preset: presetId === "" ? null : { ok: true, presetId, requested: presetId },
          });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: EVENTS_PATH,
        handler: (req, res) => {
          if (req.method !== "GET") {
            res.writeHead(405).end();
            return;
          }
          if (!passSameOrigin(req, res)) return;
          const url = new URL(req.url || "/", `http://${req.headers.host}`);
          const clientId = url.searchParams.get("clientId");
          if (clientId === null || !CLIENT_ID_PATTERN.test(clientId)) {
            res.writeHead(400).end();
            return;
          }
          const sessionId = url.searchParams.get("sessionId");

          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");

          // 替换同 id 的旧连接（页面刷新场景）。
          clients.get(clientId)?.destroy?.();
          clients.set(clientId, res);

          // 首次快照：让面板打开即有内容，不必等下一次事件。
          // 给的是**合并后**的视图（老投影 + 我们自建的条目）。
          //
          // ⚠ 帧里要**带上房间键**：客户端是按房间键比对后续帧的，
          //   不给的话它只能靠 `sessionId` 兜底匹配，而且第一帧过后
          //   `roomKeyRef` 仍是空的 —— 同一个工作区里换窗口就会出现
          //   「另一边发了消息，这边不刷新」。
          if (sessionId !== null) {
            const snapshot = roomView(sessionId);
            res.write(
              `data: ${JSON.stringify({
                type: "timeline",
                sessionId,
                roomKey: snapshot.roomKey,
                view: snapshot,
              })}\n\n`,
            );
          }

          const heartbeat = setInterval(() => {
            try {
              res.write(": ping\n\n");
            } catch {
              /* closed */
            }
          }, HEARTBEAT_MS);

          res.on("close", () => {
            clearInterval(heartbeat);
            if (clients.get(clientId) === res) clients.delete(clientId);
          });
        },
      }),
      ctx.webServer.tapIndex((html) => {
        if (html.includes("data-team-chat-bridge")) return html;
        const script = `<script defer src="${CLIENT_SCRIPT_PATH}" data-team-chat-bridge></script>`;
        return html.includes("</body>")
          ? html.replace("</body>", `${script}</body>`)
          : `${html}${script}`;
      }),
    ];

    return () => {
      disposed = true;
      if (titleRefreshTimer !== null) clearTimeout(titleRefreshTimer);
      titleRefreshTimer = null;
      // 团队信箱轮询也必须停 —— 不停的话插件卸载后它还在 steer 别人的会话。
      clearInterval(busTimer);
      disposeScopeHook();
      disposeReplyHook();
      sendScope.clear();
      for (const dispose of disposers) dispose();
      disposeTitleHook();
      disposeChanged();
      disposeProjection();
      // ⚠ 卸载时**落盘**（而不是丢掉）：防抖窗口里最后那几条消息不能丢 ——
      //    插件热重载（`link:` 开发态）时用户看不出区别，一旦真丢了就是
      //    「聊天记录莫名少了一条」。清内存没意义，实例马上就没了。
      guardTask("roomLog.flush", roomLog.flush());
      memberRoom.clear();
      for (const response of clients.values()) response.destroy?.();
      clients.clear();
    };
  }, "team-chat.setup()");
}

export { TIMELINE_PROJECTION_KEY };
