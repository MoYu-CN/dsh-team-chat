/**
 * priv-timeline-test.mjs —— 真跑验证：「私聊往来不进聊天室」这条过滤。
 *
 * 做法抄 `route-test.mjs` / `smoke-succession.mjs`：
 *   真 `apply()` + 假 ctx（只实现插件用到的那几个面）+ 数据目录指向**临时目录**。
 *
 * 被测模块由参数给（都**可以不给**，不给就用默认值 —— 这样一条 `node` 命令就能跑）：
 *   `[0] <plugin lib/index.js>` —— 生产源码（带过滤），默认 = 本插件自己的 `lib/index.js`
 *   `[1] <out file>`            —— 原始输出落盘位置，默认走 `DSH_TEST_OUT_DIR` / 系统临时目录
 *   控制组（**不带**过滤的那份）在 `test/_priv-timeline-control/lib/index.js`。
 * 同一份脚手架跑两边，输出进两个文件，直接对比 —— 这就是本测试的对照实验。
 *
 * 覆盖（用户点名的 4 项）：
 *   A 私聊往来（无范围）不进房间：人发的 + AI 回的
 *   B 有范围/目标的照常进：发给全体 / @某个成员 / 在房间直接发（/__teamchat/send）
 *   C AI 用 `chatroom_send` 的汇报照常进
 *   D 既有房间历史不被破坏（预置 room-timeline.json，投影前后逐条对比）
 *
 * 用法：
 *   node test/priv-timeline-test.mjs
 *   node test/priv-timeline-test.mjs test/_priv-timeline-control/lib/index.js   # 对照组
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { outFile, pluginFile, testDataDir } from "./_harness.mjs";

const PLUGIN_INDEX = process.argv[2] ?? pluginFile("index.js");
const OUT_FILE = process.argv[3] ?? outFile("priv-timeline-output.txt");

const DATA = testDataDir("DSH_TEAM_CHAT_DATA", "dsh-team-chat-priv-");
const DATA_DIR = DATA.dir;
const ROOM_KEY = path.join(DATA_DIR, "proj");
/**
 * 房间主会话（= 用户跟主智能体一对一说话的那个窗口）。
 *
 * ⚠ 它**不是任何成员**（`members.listActive()` 里没有它的 sessionId）——
 *   这正是用户实测的那个场景：主智能体坐镇的窗口就是聊天室本座，
 *   你在那里说的每句话都不是「发给某个成员的」，而是私聊。
 */
const MAIN_SESSION = "session-main-1";
const LEAD_SESSION = "session-lead-1";
const BETA_SESSION = "session-beta-1";
const GAMMA_SESSION = "session-gamma-1";

// ⚠ 上一版这里有一条「数据目录不许等于真实数据目录」的守卫 —— 那要靠写死的真实路径，
//   本身就是不可移植的。现在数据目录由 `testDataDir()` 现建，那条守卫没有意义了。
//   换成一条**真的能被证伪**的检查：数据目录绝不许落在插件/仓库自己的目录里 ——
//   那会把测试数据写进检出，跑一次 `git status` 就脏，而且会被误当成插件文件提交。
{
  const given = path.resolve(DATA_DIR);
  const pluginRoot = path.resolve(path.dirname(PLUGIN_INDEX), "..");
  if (given === pluginRoot || given.startsWith(pluginRoot + path.sep)) {
    console.log(`REFUSE: 数据目录落在插件目录里（会把测试数据写进检出）：${given}`);
    process.exit(2);
  }
}
process.env.DSH_TEAM_CHAT_DATA = DATA_DIR;

const lines = [];
const say = (text = "") => lines.push(text);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"} ${label}`);
  say(`     实际=${JSON.stringify(actual)}`);
  say(`     期望=${JSON.stringify(expected)}`);
};
const checkTrue = (label, actual, note = "") => {
  const ok = actual === true;
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"} ${label}${note === "" ? "" : ` :: ${note}`}`);
};
const checkFalse = (label, actual, note = "") => {
  const ok = actual === false;
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"} ${label}${note === "" ? "" : ` :: ${note}`}`);
};

// ── 一份**已经存在**的房间历史（存量样本）──────────────────────────
// 两条：一条是旧版写下的「私聊 + 未投递」（targetNames 空、delivered false），
// 一条是正常的已投递消息。用来验证过滤**不破坏**存量。
const LEGACY_ENTRIES = [
  {
    id: "legacy-private-1",
    senderName: "lead",
    targetName: null,
    targetNames: [],
    blocks: [{ type: "text", text: "（存量）私聊时我说的一句话" }],
    at: "2026-10-01T10:00:00.000Z",
    delivered: false,
  },
  {
    id: "legacy-public-1",
    senderName: "lead",
    targetName: null,
    targetNames: ["beta"],
    blocks: [{ type: "text", text: "（存量）发给贝塔的一句话" }],
    at: "2026-10-01T10:05:00.000Z",
    delivered: true,
  },
];

async function seed() {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const now = new Date().toISOString();
  const members = {
    // ① 「我（发言人）」的资料 —— **故意不给 sessionId**：它是资料表里的一条
    //    记录（改显示名/头像用），不是一个可投递的成员。
    speaker: { displayName: "我", duty: "", updatedAt: now },
    // ② 坐镇这个房间的主智能体（一个**真的** AI 成员）—— 与上一条是两回事：
    //    上一条是「我」在聊天室里叫什么名字，这一条是 AI 成员名单里的主智能体。
    lead: {
      displayName: "主智能体", duty: "指挥", sessionId: LEAD_SESSION,
      cwd: ROOM_KEY, roomCwd: ROOM_KEY, isLead: true, updatedAt: now,
    },
    beta: {
      displayName: "贝塔", duty: "盯盘", sessionId: BETA_SESSION,
      cwd: ROOM_KEY, roomCwd: ROOM_KEY, isLead: false, updatedAt: now,
    },
    gamma: {
      displayName: "伽马", duty: "写稿", sessionId: GAMMA_SESSION,
      cwd: ROOM_KEY, roomCwd: ROOM_KEY, isLead: false, updatedAt: now,
    },
  };
  await fsp.writeFile(
    path.join(DATA_DIR, "members.json"),
    JSON.stringify({ version: 1, members }, null, 2) + "\n",
    "utf8",
  );
  // 房间历史：一份**已经有内容**的文件（模拟用户升级前就在用的数据）
  await fsp.writeFile(
    path.join(DATA_DIR, "room-timeline.json"),
    JSON.stringify({ version: 1, rooms: { [ROOM_KEY]: LEGACY_ENTRIES } }, null, 2) + "\n",
    "utf8",
  );
}

function makeReq({ method = "GET", url = "/", body = null } = {}) {
  const text = body === null ? "" : JSON.stringify(body);
  async function* gen() {
    if (text !== "") yield text;
  }
  const iterator = gen();
  return {
    method,
    url,
    headers: { host: "127.0.0.1:43120" },
    [Symbol.asyncIterator]: () => iterator,
  };
}

function makeRes() {
  const out = { status: 0, body: "", frames: [] };
  return {
    out,
    writeHead(status) {
      out.status = status;
      return this;
    },
    write(chunk) {
      const text = String(chunk);
      out.body += text;
      for (const block of text.split("\n\n")) {
        const line = block.split("\n").find((row) => row.startsWith("data: "));
        if (line === undefined) continue;
        try {
          out.frames.push(JSON.parse(line.slice(6)));
        } catch {
          /* 非 JSON 的帧（注释/心跳）忽略 */
        }
      }
      return true;
    },
    end(text) {
      if (text !== undefined && text !== null) out.body += String(text);
    },
    on() {},
    destroy() {},
  };
}

/** 房间时间线里一条条目压成便于对比的形状。 */
const shape = (entry) => ({
  id: entry.id,
  sender: entry.senderName,
  targets: Array.isArray(entry.targetNames)
    ? entry.targetNames
    : entry.targetName === null || entry.targetName === undefined
      ? []
      : [entry.targetName],
  delivered: entry.delivered === true,
  text: (Array.isArray(entry.blocks) ? entry.blocks : [])
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join(""),
});

const ids = (entries) => entries.map((row) => row.id);

async function main() {
  await seed();

  const mod = await import(pathToFileURL(PLUGIN_INDEX).href);
  const routes = new Map();
  const hooks = [];
  const logs = [];
  const steered = [];
  let tools = [];
  let markLoaded = () => {};
  const loaded = new Promise((resolve) => {
    markLoaded = resolve;
  });
  let markLogReady = () => {};
  const logReady = new Promise((resolve) => {
    markLogReady = resolve;
  });

  const liveAgents = new Map();
  // 三个成员会话都是「活的」—— 含主智能体那条：它是 chatroom_send 汇报的
  // 收件人，投递要走 `agent.steer`。
  for (const sessionId of [LEAD_SESSION, BETA_SESSION, GAMMA_SESSION]) {
    liveAgents.set(sessionId, {
      id: sessionId,
      steer(message) {
        steered.push({ sessionId, message });
        return { ok: true };
      },
    });
  }

  // 假 agents 服务：只认成员会话；房间主会话（MAIN_SESSION）不在里面 ——
  // 它不需要被投递，用户就在那儿说话。
  const agents = { get: (sessionId) => liveAgents.get(sessionId) };

  /**
   * 假 sessions 服务 —— 只为一件事：给 `roomKeyOf` 一个 `header.cwd`。
   *
   * 不给它的话，房间键会退化成**会话 id**（`roomKeyOf` 的兜底），
   * 于是成员（`roomCwd = D:\Proj`）筛不出来 —— 房间里会是空的，
   * 那是脚手架的毛病，不是被测代码的毛病。
   */
  const sessions = {
    get: (sessionId) => ({ header: { id: sessionId, cwd: ROOM_KEY } }),
  };

  const ctx = {
    logger: {
      info: (m) => {
        logs.push(`[info] ${String(m)}`);
        if (String(m).includes("成员资料已加载")) markLoaded();
        if (String(m).includes("聊天记录已恢复")) markLogReady();
      },
      warn: (m) => logs.push(`[warn] ${String(m)}`),
      error: (m) => logs.push(`[error] ${String(m)}`),
    },
    on: (name, fn) => {
      hooks.push({ name, fn });
      return () => {};
    },
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    get: (name) => {
      if (name === "agents") return agents;
      if (name === "sessions") return sessions;
      if (name === "sessionController") {
        return { agents: { ensureSession: async () => undefined } };
      }
      if (name === "tools") {
        return { register: (definition) => tools.push(definition) };
      }
      return null;
    },
    sessionProjections: {
      register: () => () => {},
      onChanged: () => () => {},
      stateOf: () => undefined,
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route);
      },
      tapIndex: () => () => {},
    },
  };

  mod.apply(ctx);
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))]);
  // ⚠ 房间日志的读盘是**另一个** guardTask（`roomLog.load`）。不等它，
  //    预置的存量条目还没进内存 ⇒ 「投影前可见」会假失败。
  await Promise.race([logReady, new Promise((r) => setTimeout(r, 5000))]);

  const call = async (routePath, { method = "GET", url = routePath, body = null } = {}) => {
    const route = routes.get(routePath);
    if (route === undefined) throw new Error(`路由没注册：${routePath}`);
    const res = makeRes();
    await route.handler(makeReq({ method, url, body }), res);
    let parsed = null;
    try {
      parsed = JSON.parse(res.out.body);
    } catch {
      parsed = res.out.body;
    }
    return { status: res.out.status, payload: parsed, frames: res.out.frames };
  };

  const timeline = async (sessionId) => {
    const result = await call("/__teamchat/timeline", {
      url: `/__teamchat/timeline?sessionId=${encodeURIComponent(sessionId)}`,
    });
    return result.payload?.view?.entries ?? [];
  };

  /** 投一条真人消息事件；`sourceKind` 默认 user。 */
  const fireUserMessage = (sessionId, text, { seq = 1, sourceKind = "user" } = {}) => {
    const event = {
      type: "user/message",
      seq,
      data: { source: { kind: sourceKind }, content: [{ type: "text", text }] },
    };
    for (const hook of hooks) hook.fn({ id: sessionId, header: { id: sessionId, cwd: ROOM_KEY } }, event);
  };

  /** 投一条成员回复事件。 */
  const fireAssistantMessage = (sessionId, text, { seq = 1, turn = 1 } = {}) => {
    const event = {
      type: "assistant/message",
      seq,
      data: { turn, message: { source: { kind: "model" }, content: [{ type: "text", text }] } },
    };
    for (const hook of hooks) hook.fn({ id: sessionId, header: { id: sessionId, cwd: ROOM_KEY } }, event);
  };

  say(`被测模块：${PLUGIN_INDEX}`);
  say(`数据目录：${DATA_DIR}（临时）`);
  say("");
  say("== 预置：存量房间历史（room-timeline.json 里已有 2 条）==");
  const before = await timeline(MAIN_SESSION);
  check("存量条目投影前可见", ids(before), ["legacy-private-1", "legacy-public-1"]);

  // ── A1 私聊：人在**房间主会话**里说的话（没有选范围）──────────────
  say("");
  say("== A1 私聊（人发的·无范围·主会话）→ 不该进房间 ==");
  fireUserMessage(MAIN_SESSION, "（私聊）这句只跟你说，别记进聊天室", { seq: 11 });
  let entries = await timeline(MAIN_SESSION);
  checkFalse("A1 私聊消息没有进房间时间线", ids(entries).includes("send-session-main-1-11"), `当前=${JSON.stringify(ids(entries))}`);

  // ── A2 私聊：AI 在成员窗口里的回复（该成员还没被房间叫过）────────
  //
  // ⚠ 「AI 回的」在**宿主侧有两条不同的路**，本项测的是第一条：
  //   · 成员会话的回复 → 只有「它最近被这个房间叫过」才会回流（`memberRoom`），
  //     这里 gamma 从没被叫过 ⇒ 不回流。
  //   · 主会话的回复 → 宿主侧**根本没有记录它的代码**（只记 `lead` 自己发的那句），
  //     所以无从删起 —— 见报告的「现状证据」。
  say("");
  say("== A2 私聊（AI 回的·无范围·成员没被叫过）→ 不该进房间 ==");
  fireAssistantMessage(GAMMA_SESSION, "（私聊）只跟你说的回复", { seq: 12, turn: 7 });
  entries = await timeline(MAIN_SESSION);
  checkFalse("A2 私聊回复没有进房间时间线", ids(entries).some((id) => id.startsWith("reply-session-gamma-1")), `当前=${JSON.stringify(ids(entries))}`);

  // ── B1 发给全体（scope=""）──────────────────────────────────────
  say("");
  say("== B1 发给全体（有范围）→ 照常进 ==");
  await call("/__teamchat/scope", { method: "POST", body: { parentSessionId: MAIN_SESSION, target: "" } });
  fireUserMessage(MAIN_SESSION, "（全体）大家都看一下", { seq: 21 });
  await new Promise((r) => setTimeout(r, 80));
  entries = await timeline(MAIN_SESSION);
  const allEntry = entries.find((row) => row.id === "send-session-main-1-21");
  checkTrue("B1 发给全体的消息进了房间", allEntry !== undefined);
  check("B1 收件人是房里全体成员", shape(allEntry ?? {}).targets, ["lead", "beta", "gamma"]);
  checkTrue("B1 已投递", shape(allEntry ?? {}).delivered);

  // ── B2 @某个成员（scope="beta"）─────────────────────────────────
  say("");
  say("== B2 @ 某个成员（有范围）→ 照常进 ==");
  await call("/__teamchat/scope", { method: "POST", body: { parentSessionId: MAIN_SESSION, target: "beta" } });
  fireUserMessage(MAIN_SESSION, "（点名）贝塔你干这个", { seq: 22 });
  await new Promise((r) => setTimeout(r, 80));
  entries = await timeline(MAIN_SESSION);
  const oneEntry = entries.find((row) => row.id === "send-session-main-1-22");
  checkTrue("B2 @某个成员的消息进了房间", oneEntry !== undefined);
  check("B2 收件人就是他", shape(oneEntry ?? {}).targets, ["beta"]);

  // ── B2b 被房间叫过的那个成员回复 → 照常进 ───────────────────────
  say("");
  say("== B2b 被房间叫过的成员回复 → 照常进 ==");
  fireAssistantMessage(BETA_SESSION, "（回房间）收到，我这就去做", { seq: 23, turn: 3 });
  entries = await timeline(MAIN_SESSION);
  const replyEntry = entries.find((row) => row.id === "reply-session-beta-1-t3");
  checkTrue("B2b 成员回复进了房间", replyEntry !== undefined);
  check("B2b 发言人是他自己", shape(replyEntry ?? {}).sender, "beta");

  // ── A3 私聊回合：在成员窗口里 @ 之后再单独说话 ───────────────────
  //
  // 这一项才是**私聊回复过滤**的真正考验：beta 刚被房间叫过
  // （`memberRoom` 里有它），所以单靠「最近被哪个房间叫过」拦不住 ——
  // 靠的是 2.6 判定「这是私聊回合」后打的 `privateTurns` 标记。
  // 顺序**必须在 B2b 之后**：成员没被房间叫过时它本来就不回流，测不出东西。
  say("");
  say("== A3 私聊回合（成员已被房间叫过）→ 用户在成员窗口说话 + 它的回复都不进 ==");
  fireUserMessage(BETA_SESSION, "（私聊）你私下跟我说说", { seq: 24 });
  fireAssistantMessage(BETA_SESSION, "（私聊）这是我的私下回答", { seq: 25, turn: 9 });
  entries = await timeline(MAIN_SESSION);
  checkFalse("A3 私聊回合没进房间", ids(entries).includes("reply-session-beta-1-t9"), `当前=${JSON.stringify(ids(entries))}`);
  checkFalse("A3 成员窗口里那句也没进房间", ids(entries).includes("send-session-beta-1-24"), `当前=${JSON.stringify(ids(entries))}`);

  // ── B3 在房间直接发（/__teamchat/send）──────────────────────────
  say("");
  say("== B3 在聊天室直接发（/__teamchat/send）→ 照常进 ==");
  const send = await call("/__teamchat/send", {
    method: "POST",
    body: { parentSessionId: MAIN_SESSION, text: "（房间直发）开会了", target: "" },
  });
  checkTrue("B3 /send 返回 ok", send.payload?.ok === true, JSON.stringify(send.payload));
  entries = await timeline(MAIN_SESSION);
  const direct = entries.filter((row) => row.id.startsWith("send-") && shape(row).text === "（房间直发）开会了");
  check("B3 房间直发的消息进了房间", direct.length, 1);
  check("B3 收件人是房里全体成员", shape(direct[0] ?? {}).targets, ["lead", "beta", "gamma"]);

  // ── C AI 用 chatroom_send 的汇报 ────────────────────────────────
  say("");
  say("== C AI 用 chatroom_send 的汇报 → 照常进 ==");
  const tool = tools.find((row) => row.name === "chatroom_send");
  checkTrue("C chatroom_send 工具已登记", tool !== undefined, `已登记=${tools.map((r) => r.name).join(",")}`);
  const report = await tool.execute(
    { to: "lead", text: "（汇报）我这边的活干完了", kind: "report" },
    { agent: { id: BETA_SESSION } },
  );
  checkTrue("C 工具返回 ok", report?.ok === true, JSON.stringify(report));
  entries = await timeline(MAIN_SESSION);
  const reported = entries.filter((row) => shape(row).text === "（汇报）我这边的活干完了");
  check("C 汇报进了房间", reported.length, 1);
  check("C 汇报是发给主智能体的", shape(reported[0] ?? {}).targets, ["lead"]);

  // ── D 存量历史不被破坏 ─────────────────────────────────────────
  say("");
  say("== D 既有房间历史（存量）不被破坏 ==");
  const after = await timeline(MAIN_SESSION);
  const legacyAfter = after.filter((row) => row.id.startsWith("legacy-"));
  check("D 存量条目还在（条数）", legacyAfter.length, 2);
  check("D 存量条目逐字段未变", legacyAfter.map(shape), LEGACY_ENTRIES.map(shape));
  say(`   投影前后：前 ${ids(before).length} 条 → 后 ${ids(after).length} 条`);
  say(`   新增：${JSON.stringify(ids(after).filter((id) => !ids(before).includes(id)))}`);

  // ── 落盘快照：文件里也不含私聊条目 ──────────────────────────────
  say("");
  say("== D2 落盘的房间历史（room-timeline.json）==");
  await new Promise((r) => setTimeout(r, 1200));
  const onDisk = JSON.parse(await fsp.readFile(path.join(DATA_DIR, "room-timeline.json"), "utf8"));
  const diskIds = (onDisk.rooms[ROOM_KEY] ?? []).map((row) => row.id);
  checkFalse("D2 落盘里没有私聊消息", diskIds.includes("send-session-main-1-11"), JSON.stringify(diskIds));
  checkFalse("D2 落盘里没有私聊回复", diskIds.some((id) => id.startsWith("reply-session-gamma")), JSON.stringify(diskIds));
  checkTrue("D2 落盘里保留了存量条目", diskIds.includes("legacy-private-1") && diskIds.includes("legacy-public-1"), JSON.stringify(diskIds));
  checkTrue("D2 落盘里保留了房间直发", diskIds.length >= 5, JSON.stringify(diskIds));
  say(`   落盘 id 一览：${JSON.stringify(diskIds)}`);

  say("");
  say("宿主日志：");
  for (const line of logs) say("   " + line);
  say("");
  say(`投递次数（steer 调用）：${steered.length}`);
}

try {
  await main();
} catch (error) {
  failures += 1;
  say(`EXCEPTION ${error?.stack ?? String(error)}`);
}

say("");
say(`== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ==`);
// 统一收尾行：让「跑没跑完 / 几条通过几条失败」一句话可读（也便于自动化统计）。
say(failures === 0 ? "OK — 全部断言通过" : `FAIL — ${failures} 项断言失败`);
// 传进来的输出路径可能落在一个还不存在的目录里 —— 先建出来，别让整趟白跑。
fs.mkdirSync(path.dirname(path.resolve(OUT_FILE)), { recursive: true });
fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");
process.exit(failures === 0 ? 0 : 1);
