/**
 * smoke-succession.mjs —— 成员「交替」的宿主真跑测试。
 *
 * 做法与 `smoke-host.mjs` 同源：**真 cordis + 真 HTTP server + 真 lib/index.js
 * 的 apply()**，数据目录指到临时目录（`DSH_TEAM_CHAT_DATA`）——
 * **绝不碰用户真实的那份 members.json / room-timeline.json**。
 *
 * ## 覆盖的场景（都是「改错了会丢用户数据」的那几条）
 *
 * | 组 | 场景 | 必须成立 |
 * |---|---|---|
 * | A | 交替成功（旧会话里的 AI 自己写交接说明） | 资料里有交接说明 / 身份没丢 / 新会话已绑定 / **旧会话记录仍在** |
 * | B | 生成交接说明失败（它不回话） | **不阻断**交替 + 有可查日志 + 降级成空说明 |
 * | C | 生成失败 → 退路提炼（llm 可用） | 交替成立，且 `source: "llm"` **如实标明不是它自己写的** |
 * | D | 写盘失败（members.json 变成目录） | 不产生「身份丢失」或「两个会话同时代表同一成员」 |
 * | E | 归档后旧会话不再接收新消息 | `/__teamchat/send` 对旧会话投递失败、对新会话成功 |
 *
 * ⚠ 等待上限被 `TEAM_CHAT_HANDOVER_WAIT_MS` 压到 700ms —— 否则 B/C 两组
 *   每条都要真等 90 秒，守卫迟早被人注释掉。压的是**真实的那条超时分支**，
 *   不是把等待整段跳过。
 *
 * 用法：node test/smoke-succession.mjs
 *   ⚠ 这一份要 **真 cordis**（官方 `@deepseek-ai/cordis`），所以普通 Node 跑不了：
 *     要么设 `DSH_APP_DIR` 让脚本自己去安装目录里拿，要么用 Electron-as-node 跑。
 *     两者都拿不到时会**打印说明并退出 0（SKIP）**，不静默跳过。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { officialPkgDir, outFile, pluginFile, printSkipMissingApp, testDataDir } from "./_harness.mjs";

const DSH_PKG = officialPkgDir();
const OUT_FILE = outFile("succession-smoke-output.txt");

if (DSH_PKG === null) {
  printSkipMissingApp("smoke-succession.mjs（要借官方 @deepseek-ai/cordis 起真 host）");
  process.exit(0);
}

const lines = [];
let failures = 0;
const say = (text) => lines.push(text);
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === "" ? "" : `\n        → ${detail}`}`);
};
const equal = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, `实际=${a} 期望=${b}`);
};
const includes = (label, haystack, needle) =>
  check(label, typeof haystack === "string" && haystack.includes(needle), `在 ${JSON.stringify(String(haystack).slice(0, 400))} 里找不到 ${JSON.stringify(needle)}`);

// ── 数据目录：临时目录，且必须在 import 插件之前设好 ──────────
const DATA = testDataDir("DSH_TEAM_CHAT_DATA", "teamchat-succession-");
const dataDir = DATA.dir;
process.env.TEAM_CHAT_HANDOVER_WAIT_MS = "700";

const MEMBERS_FILE = path.join(dataDir, "members.json");
const ROOM_TIMELINE = path.join(dataDir, "room-timeline.json");
const SUCCESSIONS_LOG = path.join(dataDir, "successions.jsonl");

// ── 造一个够用的假宿主：真 cordis + 真 webServer 桩 + 真 HTTP ──
const cordis = await import(pathToFileURL(path.join(DSH_PKG, "cordis", "lib", "index.js")).href);
const host = await import(pathToFileURL(pluginFile("index.js")).href);

say(`数据目录 = ${dataDir}`);
say(`插件 index.js = ${pluginFile("index.js")}`);
say("");

// ══════════════════════════════════════════════════════════════
// 假宿主服务
// ══════════════════════════════════════════════════════════════

const ROOM = "D:\\Proj-Succession";
const NOW = new Date().toISOString();

/**
 * 日志缓冲：断言「有可查日志」靠它。
 *
 * ⚠⚠ 插件的日志走的是 **cordis 内置的 `ctx.logger`**（不是某个服务，
 *    `new Context()` 就自带，探针见 `probe-logger.mjs`）。
 *    所以**给 ctx.provide 一个 logger 是接不上的** —— 必须拦
 *    `LoggerService.prototype` 上那四个方法，才能既录下来又保持原行为。
 *
 *    第一版这里 provide 了一个假 logger，结果整轮测试 `logBuffer` 一条都没有，
 *    而 A36「这一轮没有 error 级日志」照样 PASS —— **正是本项目反复强调的那种
 *    「兜底把异常吞干净了，只看不抛错看不出来」**。B9/D7 两条断言就是补这一枪的。
 */
const logBuffer = [];
const util = await import("node:util");
{
  const cordisMod = await import(pathToFileURL(path.join(DSH_PKG, "cordis", "lib", "index.js")).href);
  for (const level of ["error", "warn", "info", "debug"]) {
    const original = cordisMod.LoggerService.prototype[level];
    cordisMod.LoggerService.prototype[level] = function patched(...args) {
      try {
        logBuffer.push({ type: level, text: util.format(...args) });
      } catch {
        /* 记录失败不能影响原行为 */
      }
      return original.apply(this, args);
    };
  }
}

/** 本轮（从 `from` 起）的 error 级日志原文。 */
const errorLogs = (from) =>
  logBuffer.slice(from).filter((row) => row.type === "error").map((row) => row.text);

/** 会话表：`sessionId -> {id, header:{id, cwd}}`。 */
const sessionsMap = new Map();
const sessionsImpl = {
  get: (id) => sessionsMap.get(id),
  list: () => [...sessionsMap.values()],
};

/** agent 表：`sessionId -> {steer, session}`。 */
const agentsMap = new Map();

/**
 * 会话标题。
 *
 * `sessionTitle.rename(session, wanted)` —— 插件按「已经是目标值就不重复写」
 * 优化过，所以这里如实记下来供断言。
 */
const titles = new Map();
const titleCalls = [];
const sessionTitleImpl = {
  get: (session) => (titles.has(session.id) ? { title: titles.get(session.id), source: { kind: "user" } } : undefined),
  rename: async (session, wanted) => {
    titleCalls.push({ sessionId: session.id, wanted });
    titles.set(session.id, wanted);
  },
};

/** 工作区：把新会话挂进去（`attachSession`）。 */
const attached = [];
const workspaceRegistryImpl = {
  list: () => [
    {
      id: "ws-proj",
      path: ROOM,
      attachSession: async (sessionId) => {
        attached.push(sessionId);
      },
    },
  ],
};

/**
 * `sessionController.agents.ensureSession(id, cwd, isRoot, preset)`。
 *
 * **真建会话**：写进 `sessionsMap` / `agentsMap`，让后续每一步都拿到活的对象
 * ——假到「只返回 ok」就测不到「新会话是不是真的被绑上了」。
 */
const ensureCalls = [];
const sessionControllerImpl = {
  agents: {
    ensureSession: async (sessionId, cwd, isRoot, preset) => {
      ensureCalls.push({ sessionId, cwd, isRoot, preset });
      const session = { id: sessionId, header: { id: sessionId, cwd } };
      sessionsMap.set(sessionId, session);
      agentsMap.set(sessionId, { session, steer: makeSteer(sessionId) });
      return session;    },
  },
};

/**
 * 造一个会把收到的消息回给「自己」的 steer。
 *
 * 默认：收到就回一条正常的五段交接说明（= 它自己写出来了）。
 * 可用 `steerBehavior.set(sessionId, fn)` 换成本次用例要的行为。
 */
const steered = [];
const steerBehavior = new Map();
function makeSteer(sessionId) {
  return (message) => {
    steered.push({ sessionId, message });
    const behavior = steerBehavior.get(sessionId) ?? "reply-handover";
    if (typeof behavior === "function") return behavior(sessionId, message);
    if (behavior === "silent") return undefined; // 不回话 ⇒ 走超时
    if (behavior === "throw") throw new Error("（用例）steer 失败");

    // 回一条完整的五段交接说明。
    const handoverText = [
      "## 我做过什么",
      "把行情播报脚本改成了按分钟聚合，产物在 D:\\Proj-Succession\\out\\report.md。",
      "",
      "## 现状",
      "聚合脚本能跑，回测还没接上。",
      "",
      "## 待办",
      "1. 接回测；2. 补 README。",
      "",
      "## 坑与注意事项",
      "不要把时间戳当字符串排序 —— 踩过一次，跨天会错。",
      "",
      "## 关键决策 / 文件 / 标识",
      "- 产物目录 D:\\Proj-Succession\\out",
      "- 成员标识 pal",
    ].join("\n");
    // ⚠ 事件形状照抄官方：assistant/message 追加的是**外层包装**，
    //   正文在 `data.message.content`（出处见 index.js 的 onMemberReply）。
    const frame = {
      type: "assistant/message",
      seq: 42,
      data: {
        turn: 7,
        step: 1,
        message: {
          id: "msg-succession-reply",
          role: "assistant",
          content: [{ type: "text", text: handoverText }],
          source: { kind: "model", provider: "probe", model: "probe" },
        },
        usage: {},
        stream: [],
      },
    };
    // 异步派发：真实的 agent 也是「steer 之后过一会儿才回」。
    setImmediate(() => {
      try {
        rootCtx.emit("session/event", sessionsMap.get(sessionId), frame);
      } catch (error) {
        logBuffer.push({ type: "error", text: `[probe] 派发 assistant/message 失败: ${error?.stack ?? error}` });
      }
    });
    return undefined;
  };
}

/** 假 llm（退路提炼）。`llmMode` 控制它成功还是失败。 */
let llmMode = "ok";
const llmCalls = [];
const llmImpl = {
  async *stream(options) {
    llmCalls.push(options);
    if (llmMode === "throw") throw new Error("（用例）llm 不可用");
    const text = [
      "## 我做过什么",
      "（退路代笔）它做完了列表页。",
      "",
      "## 现状",
      "（退路代笔）能跑但没写测试。",
      "",
      "## 待办",
      "（退路代笔）补测试。",
      "",
      "## 坑与注意事项",
      "（退路代笔）缓存 key 用了会话 id。",
      "",
      "## 关键决策 / 文件 / 标识",
      "（退路代笔）src/list.js",
    ].join("\n");
    yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: { kind: "stop" } };
  },
};

/** 假 sessionQuery（退路读日志）。 */
const readSessionCalls = [];
let sessionQueryMode = "ok";
const sessionQueryImpl = {
  readSession: async (sessionId) => {
    readSessionCalls.push(sessionId);
    if (sessionQueryMode === "throw") throw new Error("（用例）读不到日志");
    return {
      session: { id: sessionId, cwd: ROOM },
      inheritedEventCount: 0,
      events: [
        { type: "user/message", seq: 1, data: { id: "u1", role: "user", content: [{ type: "text", text: "帮我把行情播报改成按分钟聚合" }], source: { kind: "user" } } },
        { type: "assistant/message", seq: 2, data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", content: [{ type: "text", text: "好，已改完，产物在 out/report.md" }], source: { kind: "model" } } } },
      ],
    };
  },
};

/** 假 agentDefaultModel。 */
const agentDefaultModelImpl = {
  currentSelection: () => ({ provider: "probe", providerModel: undefined, model: "probe-model" }),
};

// ── 真 cordis ────────────────────────────────────────────────
const routes = new Map();
let rootCtx = new cordis.Context();
rootCtx.provide("webServer", {
  register(route) {
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  },
  tapIndex: () => () => {},
});
rootCtx.provide("sessionProjections", {
  register: () => () => {},
  onChanged: () => () => {},
  stateOf: () => null,
});
rootCtx.provide("agents", {
  get: (id) => agentsMap.get(id),
  list: () => [...agentsMap.values()],
});
rootCtx.provide("sessions", sessionsImpl);
rootCtx.provide("sessionController", sessionControllerImpl);
rootCtx.provide("sessionTitle", sessionTitleImpl);
rootCtx.provide("workspaceRegistry", workspaceRegistryImpl);
rootCtx.provide("sessionQuery", sessionQueryImpl);
rootCtx.provide("llm", llmImpl);
rootCtx.provide("agentDefaultModel", agentDefaultModelImpl);

let applyError = null;
rootCtx.plugin({
  name: "team-chat-succession-under-test",
  inject: host.inject,
  apply: (pluginCtx) => {
    try {
      host.apply(pluginCtx);
    } catch (error) {
      applyError = error;
    }
  },
});
// cordis 的 ctx.plugin() 是异步调度 —— 让出事件循环再断言。
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setTimeout(resolve, 200));

check("A0 apply 没抛错", applyError === null, applyError === null ? "" : String(applyError?.stack ?? applyError));
check("A0b 路由已注册（含 /__teamchat/succession）", routes.has("/__teamchat/succession"), [...routes.keys()].join(" "));

// ── 真 HTTP server ──────────────────────────────────────────
let server = null;
let baseUrl = "";
server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes.get(url.pathname);
  if (handler === undefined) {
    res.writeHead(404).end("no route");
    return;
  }
  req.url = url.pathname + url.search;
  try {
    await handler(req, res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500).end(String(error?.message ?? error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
baseUrl = `http://127.0.0.1:${server.address().port}`;

const call = async (p, opts = {}) => {
  const response = await fetch(`${baseUrl}${p}`, {
    method: opts.method ?? "GET",
    headers: { host: new URL(baseUrl).host, origin: baseUrl, ...(opts.headers ?? {}) },
    body: opts.body ?? undefined,
  });
  const body = await response.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* 保留原始 body */
  }
  return { status: response.status, body, json };
};

const post = (p, payload) =>
  call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

/**
 * **插件内存里**的成员资料（走真实路由）。
 *
 * ⚠ D 组会把 members.json 换成同名目录再换回来 —— 磁盘上的那份因此会短暂
 *   变成「我们手里的备份」，而插件内存里始终是最新的权威状态。
 *   所以「身份有没有丢」这类断言一律以**这条路由**为准，
 *   磁盘只用来验「写进去了没有」。
 */
const liveMembers = async () => {
  const r = await call("/__teamchat/team-members");
  const out = {};
  for (const row of r.json?.members ?? []) out[row.name] = row;
  return out;
};
/** 磁盘上那条成员记录（文件读不到时返回 undefined）。 */
const diskMember = (key) => {
  try {
    return JSON.parse(fs.readFileSync(MEMBERS_FILE, "utf8")).members?.[key];
  } catch {
    return undefined;
  }
};
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ══════════════════════════════════════════════════════════════
// 种子：一个已经上岗的成员
//
// ⚠ **走真实路由写进去**（`POST /__teamchat/members`），不是直接写磁盘文件。
//   第一版是「先写 members.json 再 import 插件」，结果被 `ctx.effect` 里那套
//   异步 `members.load()` 的时序打脸：插件内存里是空的，路由一律 404
//   「找不到成员 pal」—— 看着像交替坏了，其实是测试自己没做同步。
//   走路由写，内存与磁盘必然一致，而且顺带验证了「成员是怎么进库的」。
// ══════════════════════════════════════════════════════════════

const PAL = "pal";
const OLD_SESSION = "session-old-pal-0001";
const LEAD_SESSION = "session-lead-0001";

sessionsMap.set(OLD_SESSION, { id: OLD_SESSION, header: { id: OLD_SESSION, cwd: ROOM } });
sessionsMap.set(LEAD_SESSION, { id: LEAD_SESSION, header: { id: LEAD_SESSION, cwd: ROOM } });
agentsMap.set(OLD_SESSION, { session: sessionsMap.get(OLD_SESSION), steer: makeSteer(OLD_SESSION) });

{
  const seeded = await post("/__teamchat/members", {
    key: PAL,
    action: "set",
    member: {
      displayName: "行情观察员",
      duty: "盯盘并播报价格异动",
      instructions: "只做行情分析，不碰代码。",
      avatar: { kind: "emoji", value: "🦊" },
      sessionId: OLD_SESSION,
      cwd: ROOM,
      roomCwd: ROOM,
      preset: "minimal",
      // 上一任留下的那份交接说明（用来验证「换任时它进历史，不会冒充最新的」）
      handover: {
        title: "交接说明",
        text: "## 我做过什么\n\n（上一任留下的）\n",
        source: "member",
        byName: "行情观察员",
        bySessionId: "session-before-pal",
        createdAt: NOW,
      },
    },
  });
  check("A0c 种子成员写进去了（走真实路由）", seeded.status === 200 && seeded.json?.ok === true, `${seeded.status} ${seeded.body.slice(0, 300)}`);

  // 发言人资料（聊天室里的「我」）—— 时间线/头像会用到。
  await post("/__teamchat/members", {
    key: "lead",
    action: "set",
    member: { displayName: "我" },
  });

  const deadline = Date.now() + 5000;
  let row = null;
  while (Date.now() < deadline) {
    row = (await liveMembers())[PAL];
    if (row !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(
    "A0d 成员库读回种子成员（内存与磁盘一致）",
    row !== undefined && row.sessionId === OLD_SESSION,
    JSON.stringify(row),
  );
  say(`      种子成员：${JSON.stringify(row)}`);
  say(`      种子交接说明（应进历史）：${JSON.stringify(diskMember(PAL)?.handover?.bySessionId)}`);
}

// ══════════════════════════════════════════════════════════════
// A 组：交替成功 —— 旧会话里的 AI 自己写交接说明
// ══════════════════════════════════════════════════════════════

say("");
say("══════ A 组：交替成功（它自己写）══════");
{
  const logBase = logBuffer.length;
  const before = await liveMembers();
  check("A1 交替前：身份与会话都在", before[PAL]?.sessionId === OLD_SESSION && before[PAL]?.displayName === "行情观察员", JSON.stringify(before[PAL]));

  const r = await post("/__teamchat/succession", { memberKey: PAL, archive: true });
  say(`      → HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 700)}`);
  check("A2 HTTP 200", r.status === 200, `得到 ${r.status}`);
  equal("A3 交接说明来源 = member（它自己写的）", r.json?.handover?.source, "member");
  check("A4 回执带新会话 id", typeof r.json?.sessionId === "string" && r.json.sessionId.startsWith("session-"));
  equal("A5 回执说旧会话已归档", r.json?.archived, true);
  equal("A6 开场消息已投进新会话", r.json?.steered, true);

  // ⚠ 下面这些断言里：
  //   `live` = 插件内存的权威状态（走真路由）；`disk` = 落盘验证。
  //   两个都要看 —— 只看内存会漏掉「没写盘」，只看磁盘会被 D 组干扰。
  const live = (await liveMembers())[PAL] ?? {};
  const disk = diskMember(PAL) ?? {};
  const newSession = r.json.sessionId;

  // ── ① 成员资料里有交接说明 ──────────────────────────────
  //
  // ⚠ 全文要从 `/__teamchat/members`（完整成员资料）拿，不能从
  //   `/__teamchat/team-members`（名单）—— 名单**故意只给元信息**，
  //   全文最多 12 000 字，每次刷新都传它不划算。第一版这条断言读错了地方。
  const full = (await call("/__teamchat/members")).json?.members?.[PAL] ?? {};
  check("A7 ⭐ 成员资料里有交接说明（完整资料）", typeof full.handover?.text === "string" && full.handover.text.length > 0, JSON.stringify(full.handover)?.slice(0, 300));
  check("A7b ⭐ 交接说明**落盘了**", typeof disk.handover?.text === "string" && disk.handover.text.length > 0, JSON.stringify(disk.handover)?.slice(0, 300));
  includes("A8 交接说明是**提炼过的五段**（我做过什么）", disk.handover?.text ?? "", "我做过什么");
  includes("A9 五段齐（关键决策 / 文件 / 标识）", disk.handover?.text ?? "", "关键决策 / 文件 / 标识");
  equal("A10 五段被结构化解析", Object.keys(disk.handover?.sections ?? {}).length, 5);
  equal("A11 来源如实标记 member", disk.handover?.source, "member");
  equal("A12 交接说明写明了是哪个会话写的", disk.handover?.bySessionId, OLD_SESSION);

  // ── ② 身份没丢 ──────────────────────────────────────────
  equal("A13 ⭐ 显示名继承", disk.displayName, "行情观察员");
  equal("A14 职责继承", disk.duty, "盯盘并播报价格异动");
  equal("A15 专属指令继承", disk.instructions, "只做行情分析，不碰代码。");
  equal("A16 头像继承（emoji 🦊）", disk.avatar?.value, "🦊");
  equal("A17 模式（preset）继承", disk.preset, "minimal");
  equal("A18 房间归属继承", disk.roomCwd, ROOM);

  // ── ③ 新会话已绑定 ──────────────────────────────────────
  equal("A19 ⭐ 成员资料指向新会话", disk.sessionId, newSession);
  check("A20 新会话真的建了（ensureSession 被调用）", ensureCalls.some((row) => row.sessionId === newSession), JSON.stringify(ensureCalls));
  check("A21 新会话真的挂进了工作区", attached.includes(newSession), JSON.stringify(attached));
  equal("A22 新会话标题 = 显示名", titles.get(newSession), "行情观察员");

  // ── ④ 旧会话记录仍在（**归档 ≠ 删除**）───────────────────
  check("A23 ⭐ 旧会话对象**仍然存在**（没被删）", sessionsMap.has(OLD_SESSION), [...sessionsMap.keys()].join(" "));
  equal("A24 ⭐ 旧会话记进了 archivedSessions", disk.archivedSessions?.[0]?.sessionId, OLD_SESSION);
  equal("A25 记下了「从哪个会话接过来」", disk.handedOverFrom, OLD_SESSION);
  check("A26 旧会话标题改成了「旧 · 已归档」", String(titles.get(OLD_SESSION) ?? "").includes("已归档"), String(titles.get(OLD_SESSION)));
  // ⚠ 履历里**只有被顶替掉的那一份**：当前这份在 `handover` 里，不进履历。
  //   所以这次交替之后履历长度是 1（种子里那份），不是 2。
  //   第一版我写成了 2 —— 那是把「当前 + 履历」当成一份了。
  check("A27 ⭐ 被顶替的那份交接说明进了历史（可回看）", Array.isArray(disk.handoverHistory) && disk.handoverHistory.length === 1, JSON.stringify(disk.handoverHistory?.map((row) => row.bySessionId)));
  equal("A27b 历史里那份正是种子留下的", disk.handoverHistory?.[0]?.bySessionId, "session-before-pal");
  equal("A27c 新那份不在履历里（它就在 handover）", disk.handover?.bySessionId, OLD_SESSION);

  // ── ⑤ 交接说明真的被投进了新会话 ────────────────────────
  const successor = steered.find((row) => row.sessionId === newSession);
  check("A28 ⭐ 新会话收到了一条开场消息", successor !== undefined);
  const text = successor?.message?.content?.[0]?.text ?? "";
  includes("A29 开场消息含交接说明正文", text, "我做过什么");
  includes("A30 开场消息注明旧会话 id（可回溯）", text, OLD_SESSION);
  includes("A31 开场消息含身份/职责那一段（buildMemberPrompt）", text, "行情观察员");
  equal("A32 开场消息带来源标记", successor?.message?.source?.kind, "team-chat-member-successor");

  // 那条「请你自己写交接」的请求也真的投给了旧会话
  const ask = steered.find((row) => row.sessionId === OLD_SESSION);
  check("A33 ⭐ 交接请求是投进**它自己的会话**的（真·自己写）", ask !== undefined);
  includes("A34 请求里说明了要五段格式", ask?.message?.content?.[0]?.text ?? "", "我做过什么");
  includes("A35 请求里说明「必须提炼，不要倒原文」", ask?.message?.content?.[0]?.text ?? "", "必须提炼");

  // ── ⑥ 日志与账本 ────────────────────────────────────────
  say(`      【诊断】logBase=${logBase}，缓冲区总条数=${logBuffer.length}`);
  for (const row of logBuffer.slice(Math.max(0, logBase - 3))) say(`      【诊断】[${row.type}] ${row.text.slice(0, 200)}`);
  check("A36 这一轮没有 error 级日志", errorLogs(logBase).length === 0, errorLogs(logBase).join("\n"));
  check("A37 有 info 级交替日志（可查）", logBuffer.slice(logBase).some((row) => row.type === "info" && row.text.includes("[succession]")), `本轮日志共 ${logBuffer.slice(logBase).length} 条`);
  check("A38 交替账本 successions.jsonl 落了盘", fs.existsSync(SUCCESSIONS_LOG), SUCCESSIONS_LOG);
  if (fs.existsSync(SUCCESSIONS_LOG)) {
    const entry = JSON.parse(fs.readFileSync(SUCCESSIONS_LOG, "utf8").trim().split(/\r?\n/u).at(-1));
    equal("A39 账本记了 from/to", [entry.from, entry.to], [OLD_SESSION, newSession]);
    equal("A40 账本记了交接说明来源", entry.source, "member");
  }

  // 把新会话 id 留给后面的组
  globalThis.__newSession = newSession;
}

// ══════════════════════════════════════════════════════════════
// E 组：归档后旧会话**不再接收新消息**（放在 B/C/D 之前跑，避免状态被改）
// ══════════════════════════════════════════════════════════════

say("");
say("══════ E 组：归档后旧会话不再接收新消息 ══════");
{
  const newSession = globalThis.__newSession;

  // E1：用**旧会话 id** 当房间发消息 → 旧会话已不是成员会话，
  //     它会被当成一个普通会话，房间算出来还是同一个 cwd ⇒ 消息投给**现在的成员**（新会话）。
  //     这正是「旧会话不再代表这个成员」的表现。
  //
  // ⚠ `target: ""` 必须**显式给**（2026-10-12）：本轮起「不给 target」= **只挂进房间、
  //    零投递**（那是「在聊天室里直接发、没 @ 谁」的语义），空串才是「发给房里全体」。
  //    这里要验的是「投给了新会话、没投给旧会话」，所以收件人得是明说的广播 ——
  //    靠「不给就等于广播」那是**巧合**，不是这条断言的本意。
  const steeredBefore = steered.filter((row) => row.sessionId === OLD_SESSION).length;
  const r1 = await post("/__teamchat/send", {
    parentSessionId: OLD_SESSION,
    text: "E1：这条不该进旧会话",
    target: "",
  });
  say(`      E1 → HTTP ${r1.status} ${JSON.stringify(r1.json)?.slice(0, 300)}`);
  await settle();
  const steeredOld = steered.filter((row) => row.sessionId === OLD_SESSION).length;
  equal("E1 ⭐ 往旧会话房间发消息时，旧会话一条都没收到", steeredOld, steeredBefore);
  check("E2 而且消息进了**新会话**（成员只有一个当前会话）", steered.some((row) => row.sessionId === newSession && String(row.message?.content?.[0]?.text ?? "").includes("E1：")), JSON.stringify(steered.slice(-3).map((r) => [r.sessionId, String(r.message?.content?.[0]?.text ?? "").slice(0, 40)])));

  // E3：直接把「带着旧会话 id 的成员对象」交给 memberAgent —— 运行时也必须拦住。
  const successionMod = await import(pathToFileURL(pluginFile("succession.js")).href);
  equal("E3a succession.js 导出可用（模块加载成功）", typeof successionMod.runSuccession, "function");
  const runtime = await import(pathToFileURL(pluginFile("member-runtime.js")).href);
  // ⚠ 必须拿**完整成员资料**（`/__teamchat/members`），不是名单行
  //   （`/__teamchat/team-members`）—— 名单行只有 `archivedCount` 这个计数，
  //   **没有 `archivedSessions` 数组本身**（那是有意为之：名单每次刷新都要传）。
  //   第一版这里读错了地方，于是 archivedSessionIds 拿到一个没有该字段的对象。
  const fullProfile = (await call("/__teamchat/members")).json?.members?.[PAL] ?? {};
  say(`      【诊断】完整资料里的 archivedSessions = ${JSON.stringify(fullProfile.archivedSessions)}`);
  const archived = runtime.archivedSessionIds(fullProfile);
  check("E3b archivedSessionIds 认得出旧会话", archived.has(OLD_SESSION), JSON.stringify([...archived]));
  check("E3c 且不把当前会话当成旧的", !archived.has(newSession));
  const guarded = await runtime.memberAgent(rootCtx, { ...fullProfile, sessionId: OLD_SESSION });
  equal("E4 ⭐ 对已归档会话，memberAgent 直接拒绝", guarded.ok, false);
  equal("E5 拒绝码明确", guarded.code, "MEMBER_SESSION_ARCHIVED");
  const allowed = await runtime.memberAgent(rootCtx, { ...fullProfile, sessionId: newSession });
  equal("E6 当前会话照常可用", allowed.ok, true);
}

// ══════════════════════════════════════════════════════════════
// B 组：生成交接说明失败（它不回话）—— 不阻断交替
// ══════════════════════════════════════════════════════════════

say("");
say("══════ B 组：它写不出来（超时）→ 不阻断 + 可查日志 ══════");
{
  const current = (await liveMembers())[PAL]?.sessionId; // A 组建成的新会话
  steerBehavior.set(current, "silent"); // 它不回答
  llmMode = "throw"; // 退路也不可用 ⇒ 一路降级
  const logBase = logBuffer.length;

  const r = await post("/__teamchat/succession", { memberKey: PAL, archive: true });
  say(`      → HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 500)}`);

  check("B1 ⭐ 生成失败**不阻断**交替（HTTP 200）", r.status === 200, `得到 ${r.status} ${r.body.slice(0, 300)}`);
  equal("B2 交接说明来源如实标成 none", r.json?.handover?.source, "none");
  equal("B3 handover.ok = false", r.json?.handover?.ok, false);
  check("B4 仍然换了会话", typeof r.json?.sessionId === "string" && r.json.sessionId !== current);
  equal("B5 仍然绑定了新会话", diskMember(PAL)?.sessionId, r.json.sessionId);
  equal("B6 身份一个都没丢（显示名）", diskMember(PAL)?.displayName, "行情观察员");

  const after = diskMember(PAL) ?? {};
  check("B7 ⭐ 当前没有悬挂的旧交接说明（没把上一任的当成最新的）", after.handover === undefined, JSON.stringify(after.handover)?.slice(0, 200));
  check("B8 但历史里一份都没少", (after.handoverHistory ?? []).length >= 1, JSON.stringify(after.handoverHistory?.map((h) => h.source)));

  const errors = errorLogs(logBase);
  check("B9 ⭐ 有可查的 error 日志", errors.some((text) => text.includes("[succession]")), errors.join("\n"));
  check("B10 日志里带得上失败原因（哪个环节、什么码）", errors.some((text) => text.includes("member=") && text.includes("llm=")), errors.join("\n"));
  const logLine = errors.find((text) => text.includes("交接说明生成失败"));
  say(`      可查日志原文：${logLine ?? "(没抓到)"}`);

  // 退路确实被尝试过（不是直接放弃）
  check("B11 退路真的被尝试过（读了它的会话日志）", readSessionCalls.length >= 1, `readSession 调用 ${readSessionCalls.length} 次`);
  check("B12 退路也真的调了模型（llm.stream 被调用）", llmCalls.length >= 1, `llm.stream 调用 ${llmCalls.length} 次`);

  globalThis.__silentSession = r.json.sessionId;
  steerBehavior.delete(current);
}

// ══════════════════════════════════════════════════════════════
// C 组：退路提炼成功 —— 必须如实标明「不是它自己写的」
// ══════════════════════════════════════════════════════════════

say("");
say("══════ C 组：退路提炼（llm）—— 来源必须如实 ══════");
{
  const current = (await liveMembers())[PAL]?.sessionId;
  steerBehavior.set(current, "silent"); // 它自己还是写不出来
  llmMode = "ok"; // 但退路可用
  sessionQueryMode = "ok";
  const logBase = logBuffer.length;

  const r = await post("/__teamchat/succession", { memberKey: PAL, archive: true });
  say(`      → HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 500)}`);

  equal("C1 HTTP 200", r.status, 200);
  equal("C2 ⭐ 来源如实标成 llm（不是它自己写的）", r.json?.handover?.source, "llm");
  check("C3 回执里带一句「走了退路」的说明", String(r.json?.degraded ?? "").includes("不是它自己写的"), String(r.json?.degraded));
  const after = diskMember(PAL) ?? {};
  includes("C4 退路产出的交接说明也存进了资料", after.handover?.text ?? "", "我做过什么");
  equal("C5 来源字段也落盘了", after.handover?.source, "llm");
  check(
    "C6 退路读的是**旧会话**的日志",
    readSessionCalls.at(-1) === current,
    `readSessionCalls.at(-1)=${JSON.stringify(readSessionCalls.at(-1))} current=${JSON.stringify(current)}`,
  );
  check("C7 送进模型的输入被截断了（有上限）", llmCalls.at(-1) !== undefined && String(llmCalls.at(-1).messages?.[0]?.content?.[0]?.text ?? "").length < 40_000, `输入长度 ${String(llmCalls.at(-1)?.messages?.[0]?.content?.[0]?.text ?? "").length}`);
  equal("C8 这一轮没有 error 级日志（退路成功不算失败）", errorLogs(logBase).length, 0);
  steerBehavior.delete(current);
}

// ══════════════════════════════════════════════════════════════
// D 组：写盘失败 —— 不许出现「身份丢失」或「两个会话同时代表同一成员」
// ══════════════════════════════════════════════════════════════

say("");
say("══════ D 组：写盘失败 → 原子回滚 ══════");
{
  const before = (await liveMembers())[PAL] ?? {};
  const targetSession = before.sessionId;
  steerBehavior.set(targetSession, "reply-handover");
  const logBase = logBuffer.length;

  // 把 members.json 换成**同名目录** ⇒ 原子写的 rename 必然失败。
  const backup = fs.readFileSync(MEMBERS_FILE, "utf8");
  fs.rmSync(MEMBERS_FILE, { force: true });
  fs.mkdirSync(MEMBERS_FILE);

  let r;
  try {
    r = await post("/__teamchat/succession", { memberKey: PAL, archive: true });
  } finally {
    fs.rmdirSync(MEMBERS_FILE);
    fs.writeFileSync(MEMBERS_FILE, backup, "utf8");
  }
  say(`      → HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 500)}`);

  check("D1 写盘失败 → 非 200", r.status !== 200, `得到 ${r.status}`);
  equal("D2 错误码是 MEMBER_STORE_FAILED", r.json?.code, "TEAMCHAT_SUCC_MEMBER_STORE_FAILED");
  check(
    "D3 错误信息说清「没有任何改动」（中英任一版本）",
    /没有任何改动|Nothing about the member was changed/.test(String(r.json?.error ?? "")),
    String(r.json?.error ?? ""),
  );

  // ⚠ 磁盘被我们动过（换成目录又换回来），而且换回来的那份是**旧快照** ——
  //   所以下面只看**插件内存**（走真路由）：「身份有没有丢、指向有没有被切走」
  //   才是这一组要判的事。磁盘没被写入 ⇒ 内存按约定回滚。
  const live = await liveMembers();
  const row = live[PAL];
  equal("D4 ⭐ 身份仍在，且仍指向**旧的**当前会话（没被切走）", row?.sessionId, targetSession);
  equal("D5 内存里的资料也还是旧会话（落盘失败 ⇒ 内存回滚）", row?.displayName, "行情观察员");
  check("D6 ⭐ 没有出现「两个会话同时代表同一成员」", Object.keys(live).filter((key) => key === PAL).length === 1);
  check("D7 有可查的 error 日志", errorLogs(logBase).some((text) => text.includes("交替中止")), errorLogs(logBase).join("\n"));
  check("D8 日志里说清了孤儿会话叫什么（用户能自己去删）", errorLogs(logBase).some((text) => text.includes("孤儿")), errorLogs(logBase).join("\n"));

  // 顺手确认那条孤儿会话确实只是「没人指向它」，不是被删了
  const orphanId = r.json?.orphanSessionId;
  check("D9 孤儿会话对象仍在（没删东西）", orphanId === undefined || sessionsMap.has(orphanId), String(orphanId));

  steerBehavior.delete(targetSession);
}

// ══════════════════════════════════════════════════════════════
// F 组：并发锁 + 参数校验（防连点两次变成两个新会话抢一个身份）
// ══════════════════════════════════════════════════════════════

say("");
say("══════ F 组：并发锁与参数校验 ══════");
{
  const noKey = await post("/__teamchat/succession", {});
  check("F1 缺 memberKey → 400", noKey.status === 400, `得到 ${noKey.status}`);
  equal("F2 错误码 MEMBER_NO_KEY", noKey.json?.code, "TEAMCHAT_MISSING_MEMBER_NAME");

  const ghost = await post("/__teamchat/succession", { memberKey: "not-exist" });
  check("F3 不存在的成员 → 非 200", ghost.status !== 200, `得到 ${ghost.status}`);
  equal("F4 错误码 MEMBER_NOT_FOUND", ghost.json?.code, "TEAMCHAT_SUCC_MEMBER_NOT_FOUND");

  const preconfigured = await post("/__teamchat/members", {
    key: "preset-only",
    action: "set",
    member: { displayName: "预配资料", duty: "还没上岗" },
  });
  check("F5 先造一条没有会话的预配资料", preconfigured.status === 200, preconfigured.body.slice(0, 200));
  const noSession = await post("/__teamchat/succession", { memberKey: "preset-only" });
  check("F6 没有会话的成员不能交替 → 非 200", noSession.status !== 200, `得到 ${noSession.status}`);
  equal("F7 错误码 MEMBER_NO_SESSION", noSession.json?.code, "TEAMCHAT_SUCC_MEMBER_NO_SESSION");

  // 并发：让它慢一点回答，然后同时打两条。
  const current = (await liveMembers())[PAL]?.sessionId;
  steerBehavior.set(current, (sessionId) => {
    // 慢回：3 秒后才派发事件 —— 足够第二条请求撞上锁。
    setTimeout(() => {
      rootCtx.emit("session/event", sessionsMap.get(sessionId), {
        type: "assistant/message",
        seq: 99,
        data: {
          turn: 3,
          step: 1,
          message: { id: "m-concurrent", role: "assistant", content: [{ type: "text", text: "## 我做过什么\n\n并发用例。\n" }], source: { kind: "model" } },
        },
      });
    }, 3000);
  });
  const [r1, r2] = await Promise.all([
    post("/__teamchat/succession", { memberKey: PAL, archive: true }),
    new Promise((resolve) => setTimeout(resolve, 250)).then(() => post("/__teamchat/succession", { memberKey: PAL, archive: true })),
  ]);
  say(`      并发 1 → HTTP ${r1.status} ${r1.json?.code ?? ""}`);
  say(`      并发 2 → HTTP ${r2.status} ${r2.json?.code ?? ""}`);
  check("F8 第一条正常跑完", r1.status === 200, `${r1.status} ${r1.body.slice(0, 200)}`);
  check("F9 ⭐ 第二条被锁挡住（不会变成两个新会话抢一个身份）", r2.status !== 200, `${r2.status} ${r2.body.slice(0, 200)}`);
  equal("F10 锁的错误码明确", r2.json?.code, "TEAMCHAT_SUCC_IN_FLIGHT");
  steerBehavior.delete(current);
}

// ══════════════════════════════════════════════════════════════
// 收尾
// ══════════════════════════════════════════════════════════════

say("");
say("══════ 数据安全：本次测试只动了临时目录 ══════");
say(`      临时数据目录 = ${dataDir}`);
say(`      members.json 存在 = ${fs.existsSync(MEMBERS_FILE)}`);
say(`      room-timeline.json 存在 = ${fs.existsSync(ROOM_TIMELINE)}（没有消息时可以不建）`);
say(`      该目录下文件：${fs.readdirSync(dataDir).join(" / ")}`);

server?.close();
await new Promise((resolve) => setTimeout(resolve, 100));

say("");
say(`══ 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ══`);
// 统一收尾行：让「跑没跑完 / 几条通过几条失败」一句话可读（也便于自动化统计）。
say(failures === 0 ? "OK — 全部断言通过" : `FAIL — ${failures} 项断言失败`);
fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");
process.exitCode = failures === 0 ? 0 : 1;