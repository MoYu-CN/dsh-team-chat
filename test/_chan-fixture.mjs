/**
 * _chan-fixture.mjs —— 「发言渠道」真跑测试的脚手架（临时目录 + 假 ctx + **真 apply()**）。
 *
 * 为什么要真 `apply()`：`chatroom_send` 的行为有一半在宿主侧
 * （`sendIntoRoom` 的记账 + 投递），只测 `room-tools.js` 的纯函数
 * 等于把「房间条目里到底写了什么」这一半留成猜测。
 *
 * ⚠ 数据目录由 `DSH_TEAM_CHAT_DATA` 指定；**没设就自建临时目录并退出时清理**。
 *   **绝不碰**任何真实数据目录 —— 本文件里没有写死的路径。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 房间键 —— 真实现里它是**工作区目录**（见 `roomKeyOf`）。
 *
 * 它在 `seedDataDir()` 里被钉成「临时数据目录下的一个子目录」：
 * 房间键只是一个**字符串键**（`room-timeline.json` 里的 `rooms[roomKey]`），
 * 目录本身不需要真的存在 —— 但必须钉在临时目录里，否则这个测试就悄悄依赖了
 * 某一台机器上的真实工作区目录（换台机器就失去意义）。
 *
 * @type {string | null} 在 `seedDataDir()` 之前是 `null`。
 */
export let ROOM = null;

/** 成员的 `sessionId` 就是工具 `exec.agent.id`（官方 `ctx.agents.get(agent.id)` 也按它查）。 */
export const SESSION = {
  "market-watcher": "session-fixture-market",
  painter: "session-fixture-painter",
  writer: "session-fixture-writer",
  "market-watcher-secondary": "session-fixture-market-watcher",
};

/**
 * 造一个临时数据目录（`DSH_TEAM_CHAT_DATA` 指向它），并种好成员表。
 *
 * @param options - `{members}`：`[{key, displayName, duty, isLead}]`。
 * @returns `{dir, room, membersFile, roomFile, cleanup}`。
 */
export async function seedDataDir({ members }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-team-chat-chan-"));
  // 房间键 = 临时目录下的一个工作区目录名（见上面 ROOM 的说明）。
  ROOM = path.join(dir, "room");
  const table = {};
  for (const row of members) {
    const sessionId = SESSION[row.key];
    if (sessionId === undefined) throw new Error(`fixture 没有给 ${row.key} 准备 sessionId`);
    table[row.key] = {
      displayName: row.displayName,
      duty: row.duty ?? "",
      sessionId,
      cwd: ROOM,
      roomCwd: ROOM,
      isLead: row.isLead === true,
    };
  }
  await fs.writeFile(
    path.join(dir, "members.json"),
    `${JSON.stringify({ version: 1, members: table }, null, 2)}\n`,
    "utf8",
  );
  process.env.DSH_TEAM_CHAT_DATA = dir;
  return {
    dir,
    room: ROOM,
    membersFile: path.join(dir, "members.json"),
    roomFile: path.join(dir, "room-timeline.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 假 ctx + 可观测的投递记录。
 *
 * `steered` = **真的被投递并唤醒**的会话（每条 `{sessionId, text, source}`）。
 * 这是「有没有投递给任何会话」的唯一判据 —— 房间条目里的字段只说明记了什么。
 *
 * @returns `{ctx, steered, routes, log}`。
 */
export function createFakeCtx(options = {}) {
  /** 每个成员会话的 live agent —— `memberAgent()` 拿到它才会投递。 */
  const liveAgents = new Map();
  const steered = [];
  const routes = [];
  const log = [];
  /** 工具登记表 —— **必须在 `apply()` 之前挂上**：`apply` 里是 `ctx.get("tools")` 探测一次。 */
  const tools = new Map();

  for (const sessionId of Object.values(SESSION)) {
    liveAgents.set(sessionId, {
      id: sessionId,
      session: { id: sessionId, header: { id: sessionId, cwd: ROOM } },
      steer(message) {
        steered.push({ sessionId, text: message?.content?.[0]?.text ?? "", source: message?.source ?? null });
      },
    });
  }

  const ctx = {
    logger: {
      info: (message) => log.push(`[I] ${message}`),
      warn: (message) => log.push(`[W] ${message}`),
      error: (message) => log.push(`[E] ${message}`),
    },
    // ⚠ 真 cordis 是**惰性** effect（依赖就绪才跑）；这里**立刻跑** callback ——
    //    本插件只有一处 effect（`index.js:1257`），里面全是同步的注册与探测，
    //    所以立刻跑与惰性跑对「有没有注册」没有区别，而且更好断言。
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    on: () => () => {},
    __tools: {
      register(definition) {
        if (typeof options.validate === "function") options.validate(definition);
        tools.set(definition.name, definition);
        return () => {};
      },
    },
    get(name) {
      if (name === "sessions") return { get: (id) => liveAgents.get(id)?.session, list: () => [...liveAgents.values()] };
      if (name === "agents") return { get: (id) => liveAgents.get(id), list: () => [...liveAgents.values()] };
      if (name === "sessionController") return { agents: { ensureSession: async () => {} } };
      if (name === "workspaceRegistry") return { list: () => [] };
      if (name === "sessionTitle") return { get: () => null, rename: async () => {} };
      if (name === "tools") return ctx.__tools;
      return null;
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
      tapIndex: () => () => {},
    },
    sessionProjections: {
      register: (definition) => {
        ctx.__projection = definition;
        return () => {};
      },
      onChanged: () => () => {},
      stateOf: () => undefined,
    },
  };

  const registry = { get: (name) => tools.get(name) };
  return { ctx, steered, routes, log, registry, tools };
}

/**
 * 把工具收进一个「调用器」：`call(name, args, sessionId)` → 定义自己的返回值。
 *
 * ⚠ 如实说明这里测的是什么：走的是**注册表里那个定义对象**的 `execute`
 *   （不是注入包的 `defineTool` 包装），`args` 也**不**过参数校验。
 *   所以参数缺省 / 枚举这类事由测试自己构造，schema 那层只验
 *   「真注册表收不收」——见 harness 里的 R1。
 *
 * @param registry - 真 `ToolRuntime` 或 `{get}` 假货。
 * @returns `call` 函数。
 */
export function createCaller(registry) {
  return async (name, args, sessionId) => {
    const definition = registry.get(name);
    if (definition === undefined) throw new Error(`工具 ${name} 没有注册`);
    return await definition.execute(args, { agent: { id: sessionId }, callId: "fixture" });
  };
}

/**
 * 读房间条目（从**真** `room-timeline.json` 落盘文件读，不是内存）。
 *
 * @param roomFile - `room-timeline.json` 路径。
 * @param roomKey - 房间键。
 * @returns 条目数组。
 */
export async function readRoom(roomFile, roomKey) {
  try {
    const parsed = JSON.parse(await fs.readFile(roomFile, "utf8"));
    return parsed?.rooms?.[roomKey] ?? [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * 从**插件真实注册的路由**里读房间时间线（= 前端拿到的那个视图）。
 *
 * 为什么要走这条：只读落盘文件看不出「内存里记了没有」，
 * 「条目到底进没进房间日志」必须看宿主自己给出的视图才算数。
 *
 * @param routes - 假 `webServer.register` 收到的路由。
 * @param sessionId - 房间会话 id（决定 `roomKey`）。
 * @returns `view`（`{sessionId, roomKey, entries}`）。
 */
export async function roomViewViaRoute(routes, sessionId) {
  const route = routes.find((row) => row?.path === "/__teamchat/timeline");
  if (route === undefined) throw new Error("插件没有注册 /__teamchat/timeline 路由");
  const req = {
    method: "GET",
    url: `/__teamchat/timeline?sessionId=${encodeURIComponent(sessionId)}`,
    headers: { host: "127.0.0.1:43120" },
  };
  let status = 0;
  let body = "";
  const res = {
    writeHead(code) {
      status = code;
      return res;
    },
    setHeader() {},
    end(chunk) {
      if (typeof chunk === "string") body += chunk;
      return res;
    },
  };
  await route.handler(req, res);
  if (status !== 200) throw new Error(`timeline 路由返回 ${status}`);
  const parsed = JSON.parse(body);
  return parsed?.view ?? null;
}

/** 等一会儿（`sendIntoRoom` 是 async，落盘还有 600ms 防抖）。 */
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
