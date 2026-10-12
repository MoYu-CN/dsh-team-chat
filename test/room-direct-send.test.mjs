/**
 * room-direct-send.test.mjs —— 真跑验证：「在聊天室里直接发消息，没 @ 谁」到底去了哪。
 *
 * ## 用户报的现象（2026-10-12 原话）
 *   「如果我没艾特某一个成员，**直接在聊天室发消息**的话，它**直接就发到私信窗口里了，
 *     而不是在聊天室展示**。」
 *
 * ## 要的最终行为
 *   聊天室是**视图**，输入框属于它所在的那个会话。用户在房间视图里打字、**没 @ 谁**，
 *   意图是「发到房间」⇒ 这条应当**只挂进房间**：
 *     · 显示在房间时间线上 ✓
 *     · **不投递给任何成员的私信窗口** ✗（= `chatroom_send` 的 `to:"room"` 那套语义）
 *
 * ## 做法
 * 抄 `priv-timeline-test.mjs` / `route-test.mjs`：真 `apply()` + 假 ctx（只实现插件用到
 * 的那几个面）+ 数据目录指向**临时目录**（`DSH_TEAM_CHAT_DATA`，没设就自建并清理）。
 *
 * ⚠ 投递侧的证据是**真的 `agent.steer` 调用记录**（`steered`），不是「看条目字段猜」：
 *   「没投递」必须表现为**一次 steer 都没有**，外加 mailbox 目录里没有任何待处理消息。
 *
 * ## 被测模块可换（这就是对照实验的接口）
 *   `[0] <plugin lib/index.js>` —— 默认 = 本插件自己的 `lib/index.js`
 *   `[1] <out file>`            —— 默认走 `DSH_TEST_OUT_DIR` / 系统临时目录
 * 对照（把修复拆掉的那份）由 `test/make-roomsend-control.mjs` 生成到
 * `test/_room-send-control/lib/index.js`。
 *
 * ## 用法
 *   node test/room-direct-send.test.mjs
 *   node test/room-direct-send.test.mjs <实装目录>/lib/index.js <out.txt>
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { filesUnder, outFile, pluginFile, testDataDir } from "./_harness.mjs";

const PLUGIN_INDEX = path.resolve(process.argv[2] ?? pluginFile("index.js"));
const OUT_FILE = process.argv[3] ?? outFile("room-direct-send-output.txt");

const DATA = testDataDir("DSH_TEAM_CHAT_DATA", "dsh-team-chat-roomsend-");
const DATA_DIR = DATA.dir;

// 与 `lib/index.js` 里的哨兵必须**逐字符相同** —— 这是客户端与宿主的协议值。
const ROOM_ONLY_TARGET = "__room__";

/**
 * 数据目录绝不许落在插件目录里（会把测试数据写进检出，`git status` 立刻脏）。
 * ⚠ 与 `priv-timeline-test.mjs` 同一道闸：它在两台机器上都成立。
 */
{
  const given = path.resolve(DATA_DIR);
  const pluginRoot = path.resolve(path.dirname(PLUGIN_INDEX), "..");
  if (given === pluginRoot || given.startsWith(pluginRoot + path.sep)) {
    fs.writeSync(1, `REFUSE: 数据目录落在插件目录里：${given}\n`);
    process.exit(2);
  }
}
process.env.DSH_TEAM_CHAT_DATA = DATA_DIR;

const ROOM_KEY = path.join(DATA_DIR, "proj");
const MAIN_SESSION = "session-main-1";
const LEAD_SESSION = "session-lead-1";
const BETA_SESSION = "session-beta-1";
const GAMMA_SESSION = "session-gamma-1";

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

async function seed() {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const now = new Date().toISOString();
  const members = {
    // 「我」在聊天室里叫什么 —— 不是可投递的成员（没有 sessionId）。
    speaker: { displayName: "我", duty: "", updatedAt: now },
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
  // 预置一条**存量**房间历史。
  //
  // ⚠ 它有两个用处，都不是装饰：
  //   ① 让宿主真的打一行「聊天记录已恢复」—— 本测试靠那行日志确认**读盘已完成**，
  //      否则第一次 append 可能落在 `roomLog.load()` 之前，被「整份替换」冲掉；
  //   ② 顺手验证这轮改动**没破坏存量条目**。
  await fsp.writeFile(
    path.join(DATA_DIR, "room-timeline.json"),
    JSON.stringify(
      {
        version: 1,
        rooms: {
          [ROOM_KEY]: [
            {
              id: "legacy-1",
              senderName: "lead",
              targetName: null,
              targetNames: ["beta"],
              blocks: [{ type: "text", text: "（存量）升级前就在房间里的那句" }],
              at: "2026-10-01T10:00:00.000Z",
              delivered: true,
            },
          ],
        },
      },
      null,
      2,
    ) + "\n",
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
          /* 注释/心跳帧忽略 */
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

/** 房间条目压成便于对比的形状（含 `roomOnly` 的判据：无收件人但「不是排队中」）。 */
const shape = (entry) => ({
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

/** mailbox 目录里还有没有**待处理**的消息文件（`.json`）。 */
const pendingMailbox = () =>
  filesUnder(path.join(DATA_DIR, "mailbox")).filter((name) => name.toLowerCase().endsWith(".json"));

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
  for (const sessionId of [LEAD_SESSION, BETA_SESSION, GAMMA_SESSION]) {
    liveAgents.set(sessionId, {
      id: sessionId,
      steer(message) {
        steered.push({ sessionId, message });
        return { ok: true };
      },
    });
  }

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
      if (name === "agents") return { get: (sessionId) => liveAgents.get(sessionId) };
      if (name === "sessions") {
        return { get: (sessionId) => ({ header: { id: sessionId, cwd: ROOM_KEY } }) };
      }
      if (name === "sessionController") {
        return { agents: { ensureSession: async () => undefined } };
      }
      if (name === "tools") return { register: (definition) => tools.push(definition) };
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

  const timeline = async () => {
    const result = await call("/__teamchat/timeline", {
      url: `/__teamchat/timeline?sessionId=${encodeURIComponent(MAIN_SESSION)}`,
    });
    return result.payload?.view?.entries ?? [];
  };
  const find = (entries, id) => entries.find((row) => row.id === id);
  const byText = (entries, text) => entries.filter((row) => shape(row).text === text);

  const fireUserMessage = (sessionId, text, { seq = 1 } = {}) => {
    const event = {
      type: "user/message",
      seq,
      data: { source: { kind: "user" }, content: [{ type: "text", text }] },
    };
    for (const hook of hooks) {
      hook.fn({ id: sessionId, header: { id: sessionId, cwd: ROOM_KEY } }, event);
    }
  };
  const fireAssistantMessage = (sessionId, text, { seq = 1, turn = 1 } = {}) => {
    const event = {
      type: "assistant/message",
      seq,
      data: { turn, message: { source: { kind: "model" }, content: [{ type: "text", text }] } },
    };
    for (const hook of hooks) {
      hook.fn({ id: sessionId, header: { id: sessionId, cwd: ROOM_KEY } }, event);
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 120));
  /** 客户端的动作：装填「只发到房间」的范围（= 房间视图挂载时干的）。 */
  const armRoomView = (sessionId) =>
    call("/__teamchat/scope", { method: "POST", body: { parentSessionId: sessionId, target: ROOM_ONLY_TARGET } });

  const newSteers = (from) => steered.slice(from).map((row) => row.sessionId);

  say(`被测模块：${PLUGIN_INDEX}`);
  say(`插件目录：${path.dirname(path.dirname(PLUGIN_INDEX))}`);
  say(`数据目录：${DATA_DIR}（临时）`);
  say("");
  say("投递侧证据的口径：`steer` 调用次数（宿主真的去唤醒成员才会多一次）+ mailbox 待处理文件数。");

  // ── S0 私聊基线：**没装填**范围 = 不在房间视图 ──────────────────
  //
  // ⚠ 这一条同时是**改前现象的复现**：修好之前客户端从不装填任何范围，
  //   所以「在聊天室里直接发消息」走的**就是**这条路 —— 房间时间线里没有它，
  //   那句话留在它所在会话的对话里（用户看到的就是「发到私信窗口里了」）。
  say("");
  say("== S0 私聊基线（房间视图没装填 / 用户不在房间视图）⇒ 不进房间、零投递 ==");
  const s0Before = steered.length;
  fireUserMessage(MAIN_SESSION, "（直发·没装填）这句只落在会话里", { seq: 10 });
  await settle();
  let entries = await timeline();
  checkFalse(
    "S0 没装填时这句不进房间（私密闸门照旧）",
    entries.some((row) => row.id === `send-${MAIN_SESSION}-10`),
    JSON.stringify(entries.map((r) => r.id)),
  );
  check("S0 也不投递", newSteers(s0Before), []);

  // ── S1 房间视图里直发、没 @ 谁 ⇒ 只挂进房间 ─────────────────────
  say("");
  say("== S1 房间视图装填「只发到房间」+ 没 @ 谁 ⇒ 进房间、零投递 ==");
  const s1Before = steered.length;
  await armRoomView(MAIN_SESSION);
  fireUserMessage(MAIN_SESSION, "（直发）开会了", { seq: 11 });
  await settle();
  entries = await timeline();
  const s1 = find(entries, `send-${MAIN_SESSION}-11`);
  check(`S1 这句进了房间时间线`, s1 !== undefined, true);
  check("S1 收件人是空的（没投给任何人）", shape(s1 ?? {}).targets, []);
  checkTrue("S1 不是「排队中」（只挂房间 ⇒ delivered 视为 true）", shape(s1 ?? {}).delivered === true, JSON.stringify(shape(s1 ?? {})));
  check("S1 一次 steer 都没发生", newSteers(s1Before), []);

  // ── S2 第二条（没再装填）⇒ 仍然只挂房间 ─────────────────────────
  //
  // ⚠ 这一条是「范围不能是一次性」的钉子：装填被第一条消费掉的话，
  //   第二条又变回私聊（不进房间），用户报的来回就还在。
  say("");
  say("== S2 紧接着第二条（没有再装填）⇒ 仍然进房间、零投递 ==");
  const s2Before = steered.length;
  fireUserMessage(MAIN_SESSION, "（直发）第二句", { seq: 12 });
  await settle();
  entries = await timeline();
  const s2 = find(entries, `send-${MAIN_SESSION}-12`);
  check(`S2 第二条也进了房间时间线`, s2 !== undefined, true);
  checkTrue("S2 也是「只挂房间」", shape(s2 ?? {}).delivered === true, JSON.stringify(shape(s2 ?? {})));
  check("S2 一次 steer 都没发生", newSteers(s2Before), []);

  // ── S3 `/__teamchat/send` **不给 target** ⇒ 只挂房间（不是广播）──
  say("");
  say("== S3 /__teamchat/send 不带 target ⇒ 只挂房间（旧行为：广播给全员）==");
  const s3Before = steered.length;
  const direct = await call("/__teamchat/send", {
    method: "POST",
    body: { parentSessionId: MAIN_SESSION, text: "（直发）没选收件人" },
  });
  await settle();
  entries = await timeline();
  const s3 = byText(entries, "（直发）没选收件人");
  checkTrue("S3 路由返回 ok", direct.payload?.ok === true, JSON.stringify(direct.payload));
  check("S3 回执里 delivered 是空的", Array.isArray(direct.payload?.delivered) ? direct.payload.delivered.length : -1, 0);
  check("S3 这句进了房间时间线", s3.length, 1);
  check("S3 收件人是空的", s3.length === 1 ? shape(s3[0]).targets : null, []);
  check("S3 一个成员都没被投递", newSteers(s3Before), []);

  // ── S4 既有能力：@某个成员 ─────────────────────────────────────
  say("");
  say("== S4 既有能力：@某个成员 ⇒ 进房间 + 只投给他 ==");
  const s4Before = steered.length;
  await call("/__teamchat/scope", { method: "POST", body: { parentSessionId: MAIN_SESSION, target: "beta" } });
  fireUserMessage(MAIN_SESSION, "（点名）贝塔你干这个", { seq: 21 });
  await settle();
  entries = await timeline();
  const s4 = find(entries, `send-${MAIN_SESSION}-21`);
  check("S4 收件人就是 beta", shape(s4 ?? {}).targets, ["beta"]);
  checkTrue("S4 已投递", shape(s4 ?? {}).delivered === true);
  check("S4 只 steer 了 beta", newSteers(s4Before), [BETA_SESSION]);

  // ── S5 既有能力：发给全体 ──────────────────────────────────────
  say("");
  say("== S5 既有能力：发给全体 ⇒ 进房间 + 逐个投递 ==");
  const s5Before = steered.length;
  await call("/__teamchat/scope", { method: "POST", body: { parentSessionId: MAIN_SESSION, target: "" } });
  fireUserMessage(MAIN_SESSION, "（全体）大家都看一下", { seq: 22 });
  await settle();
  entries = await timeline();
  const s5 = find(entries, `send-${MAIN_SESSION}-22`);
  check("S5 收件人是房里全体成员", shape(s5 ?? {}).targets, ["lead", "beta", "gamma"]);
  check("S5 steer 了 3 个人", newSteers(s5Before).sort(), [BETA_SESSION, GAMMA_SESSION, LEAD_SESSION]);

  // ── S6 既有能力：`/send` 显式给空串 = 全体（语义不变）────────────
  say("");
  say("== S6 既有能力：/send 显式 target:\"\" ⇒ 仍然广播（不能改成只挂房间）==");
  const s6Before = steered.length;
  const bcast = await call("/__teamchat/send", {
    method: "POST",
    body: { parentSessionId: MAIN_SESSION, text: "（全体·路由）都看一下", target: "" },
  });
  await settle();
  check("S6 delivered 有 3 条", Array.isArray(bcast.payload?.delivered) ? bcast.payload.delivered.length : -1, 3);
  check("S6 steer 了 3 个人", newSteers(s6Before).sort(), [BETA_SESSION, GAMMA_SESSION, LEAD_SESSION]);

  // ── S7 既有能力：`chatroom_send(to:"room")` ────────────────────
  say("");
  say("== S7 既有能力：chatroom_send(to:\"room\") ⇒ 只挂房间、零投递 ==");
  const tool = tools.find((row) => row.name === "chatroom_send");
  checkTrue("S7 chatroom_send 工具已登记", tool !== undefined, `已登记=${tools.map((r) => r.name).join(",")}`);
  const s7Before = steered.length;
  const roomOnly = await tool.execute({ to: "room", text: "（工具）只挂房间" }, { agent: { id: BETA_SESSION } });
  await settle();
  entries = await timeline();
  const s7 = byText(entries, "（工具）只挂房间");
  checkTrue("S7 工具返回 ok", roomOnly?.ok === true, JSON.stringify(roomOnly));
  check("S7 进了房间", s7.length, 1);
  check("S7 收件人是空的", s7.length === 1 ? shape(s7[0]).targets : null, []);
  check("S7 零投递", newSteers(s7Before), []);

  // ── S8 既有能力：`chatroom_send(to:"all")` ─────────────────────
  say("");
  say("== S8 既有能力：chatroom_send(to:\"all\") ⇒ 逐个投递 ==");
  const s8Before = steered.length;
  const all = await tool.execute({ to: "all", text: "（工具）通知全员" }, { agent: { id: BETA_SESSION } });
  await settle();
  checkTrue("S8 工具返回 ok", all?.ok === true, JSON.stringify(all));
  check("S8 steer 了 3 个人（含发送者自己）", newSteers(s8Before).sort(), [BETA_SESSION, GAMMA_SESSION, LEAD_SESSION]);

  // ── S9 私密闸门没被拆掉：没装填 + 没范围 = 私聊 ─────────────────
  say("");
  say("== S9 私密闸门照旧：成员窗口里没装填、没范围 ⇒ 不进房间、不投递 ==");
  await call("/__teamchat/scope", { method: "POST", body: { parentSessionId: BETA_SESSION, target: null } });
  const s9Before = steered.length;
  fireUserMessage(BETA_SESSION, "（私聊）你私下跟我说说", { seq: 31 });
  fireAssistantMessage(BETA_SESSION, "（私聊）这是我的私下回答", { seq: 32, turn: 9 });
  await settle();
  entries = await timeline();
  checkFalse("S9 成员窗口里那句没进房间", entries.some((row) => row.id === `send-${BETA_SESSION}-31`), JSON.stringify(entries.map((r) => r.id)));
  checkFalse("S9 它的回复也没进房间", entries.some((row) => row.id.startsWith("reply-")), JSON.stringify(entries.map((r) => r.id)));
  check("S9 私聊不投递给任何成员", newSteers(s9Before), []);

  // ── S10 离开房间视图 ⇒ 范围被清掉 ⇒ 回到私聊语义 ────────────────
  say("");
  say("== S10 离开房间视图（清范围）⇒ 没 @ 谁的消息不再进房间 ==");
  await call("/__teamchat/scope", { method: "POST", body: { parentSessionId: MAIN_SESSION, target: null } });
  const s10Before = steered.length;
  fireUserMessage(MAIN_SESSION, "（私下）这句不发给房间", { seq: 41 });
  await settle();
  entries = await timeline();
  checkFalse(
    "S10 清掉范围后不进房间",
    entries.some((row) => row.id === `send-${MAIN_SESSION}-41`),
    JSON.stringify(entries.map((r) => r.id)),
  );
  check("S10 也不投递", newSteers(s10Before), []);

  // ── S11 投递侧的第二份证据：mailbox 是空的 ─────────────────────
  say("");
  say("== S11 mailbox（团队信箱）待处理文件 ==");
  const pending = pendingMailbox();
  check("S11 mailbox 里没有待处理消息", pending, []);
  say(`   mailbox 全量：${JSON.stringify(filesUnder(path.join(DATA_DIR, "mailbox")))}`);

  // ── S12 落盘：房间直发的条目真的写进了 room-timeline.json ───────
  say("");
  say("== S12 落盘的房间历史 ==");
  await new Promise((r) => setTimeout(r, 1200));
  const onDisk = JSON.parse(await fsp.readFile(path.join(DATA_DIR, "room-timeline.json"), "utf8"));
  const diskIds = (onDisk.rooms[ROOM_KEY] ?? []).map((row) => row.id);
  checkTrue("S12 落盘里有房间直发的那条", diskIds.includes(`send-${MAIN_SESSION}-11`), JSON.stringify(diskIds));
  checkTrue("S12 落盘里也有第二条", diskIds.includes(`send-${MAIN_SESSION}-12`), JSON.stringify(diskIds));
  checkTrue("S12 存量条目没被动", diskIds.includes("legacy-1"), JSON.stringify(diskIds));
  say(`   落盘 id 一览：${JSON.stringify(diskIds)}`);

  say("");
  say(`累计 steer 调用：${steered.length} 次`);
  for (const row of steered) say(`   → ${row.sessionId}`);
  say("");
  say("宿主日志：");
  for (const line of logs) say("   " + line);
}

try {
  await main();
} catch (error) {
  failures += 1;
  say(`EXCEPTION ${error?.stack ?? String(error)}`);
}

say("");
say(`== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ==`);
say(failures === 0 ? "OK — 全部断言通过" : `FAIL — ${failures} 项断言失败`);

// 同步写到 stdout **和**产物文件：`process.exit` 会跟异步刷写抢，
// 所以两边都用同步 API（`fs.writeSync` / `fs.writeFileSync`）。
const report = lines.join("\n") + "\n";
fs.mkdirSync(path.dirname(path.resolve(OUT_FILE)), { recursive: true });
fs.writeFileSync(OUT_FILE, report, "utf8");
fs.writeSync(1, report);
process.exit(failures === 0 ? 0 : 1);
