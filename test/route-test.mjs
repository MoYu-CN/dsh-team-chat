/**
 * route-test.mjs —— 真跑测试：用**真的** `lib/index.js`（`apply()` + 真的
 * `/__teamchat/members` 路由）验证「编辑已有成员时改主智能体身份」这条路径。
 *
 * 做法：给一个够用的假 ctx（只实现插件用到的那几个面），把路由 handler 抓出来，
 * 再喂假的 req/res。数据目录走 `DSH_TEAM_CHAT_DATA` ——
 * **没设就自建临时目录并在结束时删掉**，绝不碰任何真实成员表。
 *
 * 输出同时写文件（路径由 `_harness.mjs` 的 `outFile()` 决定：`DSH_TEST_OUT_DIR`
 * 设了写那儿、没设写系统临时目录）——**绝不往仓库里写**。
 *
 * 场景：
 *   S1 房里已有主智能体，不带 replaceLead 就想升另一个 → 必须 409 且不落盘
 *   S2 带 replaceLead 再升 → 原主智能体被降级，全房只剩一个主智能体
 *   S3 只改显示名（不带 isLead）→ 身份位必须原样保留
 *   S4 显式 isLead:false → 取消主智能体
 *   S5 没有会话的「预配资料」升主智能体：不该误伤任何房间
 *   S6 被降级过的成员可以重新升回来
 *
 * 用法：node test/route-test.mjs
 */
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { outFile, pluginFile, testDataDir } from "./_harness.mjs";

const DATA = testDataDir("DSH_TEAM_CHAT_DATA", "dsh-team-chat-route-");
const DATA_DIR = DATA.dir;
const MEMBERS_FILE = path.join(DATA_DIR, "members.json");
const OUT_FILE = outFile("route-test-output.txt");
const PLUGIN_INDEX = pluginFile("index.js");

const lines = [];
const say = (text = "") => {
  lines.push(text);
};

const now = new Date().toISOString();
const session = (id) => `session-${id}`;

async function seed() {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const members = {
    alpha: {
      displayName: "阿尔法", duty: "d", sessionId: session("aaa"),
      cwd: "D:\\Proj", roomCwd: "D:\\Proj", isLead: true, updatedAt: now,
    },
    beta: {
      displayName: "贝塔", duty: "d", sessionId: session("bbb"),
      cwd: "D:\\Proj", roomCwd: "D:\\Proj", isLead: false, updatedAt: now,
    },
    gamma: {
      displayName: "伽马", duty: "d", sessionId: session("ccc"),
      cwd: "D:\\Other", roomCwd: "D:\\Other", isLead: true, updatedAt: now,
    },
    // 「预配资料」：没有会话 ⇒ 不属于任何房间
    ghost: { displayName: "幽灵", duty: "d", updatedAt: now },
  };
  await fsp.writeFile(MEMBERS_FILE, JSON.stringify({ version: 1, members }, null, 2) + "\n", "utf8");
}

async function onDisk() {
  const parsed = JSON.parse(await fsp.readFile(MEMBERS_FILE, "utf8"));
  const out = {};
  for (const [key, row] of Object.entries(parsed.members)) out[key] = row.isLead === true;
  return out;
}

function makeReq(body) {
  async function* gen() {
    yield JSON.stringify(body);
  }
  const iterator = gen();
  return {
    method: "POST",
    headers: { host: "127.0.0.1:43120" },
    [Symbol.asyncIterator]: () => iterator,
  };
}

/**
 * 发**原始文本**请求体（不经过 `JSON.stringify`）。
 *
 * 存在理由：`readJsonBody` 那三条错误（超限 / 非法 JSON / 不是对象）只有喂进
 * 不合法的字节才走得到 —— 用 `makeReq` 永远构造不出「不是合法 JSON」。
 */
function makeRawReq(text) {
  async function* gen() {
    yield text;
  }
  const iterator = gen();
  return {
    method: "POST",
    headers: { host: "127.0.0.1:43120" },
    [Symbol.asyncIterator]: () => iterator,
  };
}

function makeRes() {
  const out = { status: 0, body: "" };
  return {
    out,
    writeHead(status) {
      out.status = status;
      return this;
    },
    end(text) {
      if (text !== undefined && text !== null) out.body = String(text);
    },
  };
}

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"} ${label}`);
  say(`     实际=${brief(actual)}`);
  say(`     期望=${brief(expected)}`);
};

/**
 * 打印用：把超长值截断。
 *
 * ⚠ 必须截断，而且是**函数声明**（会被提升）：S11 那条用例故意塞了一个
 *   160 万字符的头像，`post()` 的**请求体回显**会把整串打进日志 ——
 *   输出文件 1.6 MB，结论被淹掉。截断只影响**打印**，不影响任何断言。
 */
function brief(value, max = 200) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return String(text);
  return text.length > max ? `${text.slice(0, max)}…(共 ${text.length} 字符)` : text;
}

async function main() {
  await seed();

  const mod = await import(pathToFileURL(PLUGIN_INDEX).href);
  const handlers = new Map();
  const logs = [];
  let markLoaded = () => {};
  const loaded = new Promise((resolve) => {
    markLoaded = resolve;
  });

  const ctx = {
    logger: {
      info: (m) => {
        logs.push(String(m));
        if (String(m).includes("成员资料已加载")) markLoaded();
      },
      warn: (m) => logs.push(`[warn] ${String(m)}`),
      error: (m) => logs.push(`[error] ${String(m)}`),
    },
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    // 所有宿主服务都缺席：renameTitle 直接返回 false，工具不登记 —— 与本测试无关
    get: () => null,
    sessionProjections: {
      register: () => () => {},
      onChanged: () => () => {},
      stateOf: () => undefined,
    },
    webServer: {
      register: (route) => {
        handlers.set(route.path, route);
      },
      tapIndex: () => () => {},
    },
  };

  mod.apply(ctx);
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))]);

  const route = handlers.get("/__teamchat/members");
  if (route === undefined) {
    say("FAIL 没有注册 /__teamchat/members 路由");
    failures += 1;
    return;
  }

  const post = async (body) => {
    const res = makeRes();
    await route.handler(makeReq(body), res);
    let parsed = null;
    try {
      parsed = JSON.parse(res.out.body);
    } catch {
      parsed = res.out.body;
    }
    say(`   POST ${brief(JSON.stringify(body))}`);
    say(`   -> HTTP ${res.out.status} ${brief(parsed)}`);
    return { status: res.out.status, payload: parsed };
  };

  /** 同 `post`，但请求体是**原始文本**（走 `makeRawReq`）。 */
  const postRaw = async (text) => {
    const res = makeRes();
    await route.handler(makeRawReq(text), res);
    let parsed = null;
    try {
      parsed = JSON.parse(res.out.body);
    } catch {
      parsed = res.out.body;
    }
    say(`   POST (raw) ${JSON.stringify(String(text).slice(0, 60))}${String(text).length > 60 ? "…" : ""}`);
    say(`   -> HTTP ${res.out.status} ${JSON.stringify(parsed)}`);
    return { status: res.out.status, payload: parsed };
  };

  say("== 种子（磁盘）==");
  check("初始身份位", await onDisk(), { alpha: true, beta: false, gamma: true, ghost: false });

  say("");
  say("== S1 不带 replaceLead 就想换主智能体 ==");
  const s1 = await post({ key: "beta", action: "set", member: { isLead: true } });
  check("S1 HTTP 409", s1.status, 409);
  // ⚠ 码从 `TEAM_LEAD_EXISTS` 改成 `TEAMCHAT_LEAD_EXISTS`（2026-10-12 国际化）：
  //   原来的名字与**官方** `TeamError.code` 撞了同一个命名空间 —— 官方那边
  //   真返回 `TEAM_LEAD_EXISTS` 时会被 `spawnErrorMessage` 当成我们自己这条，
  //   文案就错了。宿主自造的码一律 `TEAMCHAT_` 前缀，官方码原样透传。
  check("S1 错误码", s1.payload?.code, "TEAMCHAT_LEAD_EXISTS");
  // 顺带钉住「码在客户端字典里有对应文案」——只断言码名的话，将来改了码
  // 而忘了补字典，这里照样绿，界面却会回落成英文兜底。
  const clientSrc = fs.readFileSync(path.join(path.dirname(PLUGIN_INDEX), "client.js"), "utf8");
  check("S1 的错误码在客户端字典里有文案", clientSrc.includes(`"err.${s1.payload?.code}"`), true);
  // 老字段不许删：`error` 必须仍然是英文兜底（不是空串）。
  check("S1 仍带 error 兜底", typeof s1.payload?.error === "string" && s1.payload.error.length > 0, true);
  // ⚠ 这里**不能**直接断言「error 里没有汉字」：这条响应里出现的中文是
  //   **用户自己取的成员名**（`params.name = "阿尔法"`），它出现在英文句子里
  //   是**正确的** —— 那是数据，不是界面文案。（第一版断言就是这么写的，
  //   结果红了一条假失败：把数据当成文案了。）
  //   正确的判据：把 `params` 里各个值从模板里剔掉之后，剩下的**模板本身**
  //   不许再有汉字。
  const stripParamValues = (text, params) => {
    let out = String(text ?? "");
    for (const value of Object.values(params ?? {})) {
      if (typeof value === "string" && value !== "") out = out.split(value).join("\u0000");
    }
    return out;
  };
  const errorTemplate = stripParamValues(s1.payload?.error, s1.payload?.params);
  check("S1 的 error 兜底（剔掉数据后）不会有中文", /[\u4e00-\u9fff]/u.test(errorTemplate), false);
  check("S1 带上了 params.name（界面要说清现在是谁当值）", typeof s1.payload?.params?.name, "string");
  check("S1 没落盘（房里还是阿尔法当值）", await onDisk(), { alpha: true, beta: false, gamma: true, ghost: false });

  say("");
  say("== S2 带 replaceLead 换人 ==");
  const s2 = await post({ key: "beta", action: "set", member: { isLead: true }, replaceLead: true });
  check("S2 HTTP 200", s2.status, 200);
  check("S2 换人成功 + 别的房间不受影响", await onDisk(), {
    alpha: false, beta: true, gamma: true, ghost: false,
  });

  say("");
  say("== S3 只改显示名（不带 isLead）—— 身份位不能被清掉 ==");
  const s3 = await post({ key: "beta", action: "set", member: { displayName: "贝塔二号" } });
  check("S3 HTTP 200", s3.status, 200);
  check("S3 仍是主智能体", await onDisk(), { alpha: false, beta: true, gamma: true, ghost: false });

  say("");
  say("== S4 取消主智能体 ==");
  const s4 = await post({ key: "beta", action: "set", member: { isLead: false } });
  check("S4 HTTP 200", s4.status, 200);
  check("S4 已取消", await onDisk(), { alpha: false, beta: false, gamma: true, ghost: false });

  say("");
  say("== S5 没有会话的「预配资料」升主智能体：不该误伤任何房间 ==");
  const s5 = await post({ key: "ghost", action: "set", member: { isLead: true } });
  check("S5 HTTP 200", s5.status, 200);
  check("S5 只动它自己", await onDisk(), { alpha: false, beta: false, gamma: true, ghost: true });

  say("");
  say("== S6 之前被降级的 alpha 可以重新升回来 ==");
  const s6 = await post({ key: "alpha", action: "set", member: { isLead: true } });
  check("S6 HTTP 200", s6.status, 200);
  check("S6 重新当值", await onDisk(), { alpha: true, beta: false, gamma: true, ghost: true });

  // ══════════════════════════════════════════════════════════════════
  // S7-S10：`readJsonBody` 那三条 + `/send` 的 `TEAMCHAT_NO_ROOM`
  //
  // 为什么这几条要在这里真跑一遍：它们**原样进界面**（客户端
  // `new Error(payload?.error ?? …)` → `spawnErrorMessage`），而国际化的做法
  // 是「稳定错误码 + 英文兜底 + `params`」，三个字段一个都不能少 ——
  // 少一个的后果都不是报错，而是**界面悄悄显示错的语言**，静态看代码看不出来。
  // ══════════════════════════════════════════════════════════════════
  say("");
  say("== S7 请求体不是合法 JSON（走 readJsonBody）==");
  const s7 = await postRaw("{ 这不是 JSON");
  check("S7 HTTP 400", s7.status, 400);
  check("S7 错误码", s7.payload?.code, "TEAMCHAT_BODY_INVALID_JSON");
  check("S7 error 是英文兜底", s7.payload?.error, "Request body is not valid JSON.");

  say("");
  say("== S8 请求体是合法 JSON 但不是对象（走 readJsonBody）==");
  const s8 = await postRaw("[1,2,3]");
  check("S8 HTTP 400", s8.status, 400);
  check("S8 错误码", s8.payload?.code, "TEAMCHAT_BODY_NOT_OBJECT");
  check("S8 error 是英文兜底", s8.payload?.error, "Request body must be a JSON object.");

  say("");
  say("== S9 请求体太大 ==");
  // ⚠ 这条在**真 HTTP 服务端**上可能先被 node 自己的 body 上限掐掉（那样响应
  //   不是我们的 JSON）；本桩直接调 handler，所以能确定地走到我们那个 413。
  //   换句话说：这里证明的是「我们的 413 + 码 + 英文兜底」这一支是对的，
  //   **没有**证明「真实网络路径下用户一定看到我们的 413」—— 那要起真服务器
  //   才验得了，本测试没做。
  say("   注意：本桩直接调 handler ⇒ 只证明我们那一支；真实网络路径未覆盖");
  const huge = await postRaw("A".repeat(5 * 1024 * 1024));
  check("S9 HTTP 413", huge.status, 413);
  check("S9 错误码", huge.payload?.code, "TEAMCHAT_BODY_TOO_LARGE");
  check("S9 error 是英文兜底", huge.payload?.error, "Request body is too large.");

  say("");
  say("== S10 /send 的三种入参错误 ==");
  const sendRoute = handlers.get("/__teamchat/send");
  if (sendRoute === undefined) {
    say("FAIL 没有注册 /__teamchat/send 路由");
    failures += 1;
  } else {
    const postSend = async (body) => {
      const res = makeRes();
      await sendRoute.handler(makeReq(body), res);
      let parsed = null;
      try {
        parsed = JSON.parse(res.out.body);
      } catch {
        parsed = res.out.body;
      }
      say(`   POST ${JSON.stringify(body)}`);
      say(`   -> HTTP ${res.out.status} ${JSON.stringify(parsed)}`);
      return { status: res.out.status, payload: parsed };
    };
    const empty10 = await postSend({ parentSessionId: "session-aaa", text: "   " });
    check("S10a 空正文 → 400", empty10.status, 400);
    check("S10a 错误码", empty10.payload?.code, "TEAMCHAT_EMPTY_MESSAGE");
    check("S10a error 是英文兜底", empty10.payload?.error, "Message text cannot be empty.");

    const noRoom10 = await postSend({ parentSessionId: "", text: "hi" });
    check("S10b 缺会话 id → 400", noRoom10.status, 400);
    check("S10b 错误码", noRoom10.payload?.code, "TEAMCHAT_NO_ROOM");
    check("S10b error 是英文兜底", noRoom10.payload?.error, "Missing session id.");

    // 房里没有这个收件人 —— 这是**真实用户最常撞上**的一条：
    // 点名发一个已经不叫这个名字的成员。响应的 `delivered[]` 里必须带上
    // 稳定码与 params（客户端据此说人话），否则界面只剩「未送达 某某」。
    const noTarget10 = await postSend({ parentSessionId: "session-aaa", text: "hi", target: "不存在的名字" });
    check("S10c HTTP 200（/send 一律 200，失败在 delivered[] 里）", noTarget10.status, 200);
    const badRow = (noTarget10.payload?.delivered ?? []).find((row) => row?.ok !== true);
    check("S10c 失败行带稳定码", badRow?.code, "TEAMCHAT_NO_TARGET");
    check("S10c 失败行带 params.target", badRow?.params?.target, "不存在的名字");
    check(
      "S10c 失败行的 error 是英文兜底",
      badRow?.error,
      'No member named "不存在的名字" in this chat room.',
    );
    // ⚠ 「空房间广播」那条（`TEAMCHAT_NO_MEMBERS`）在这里**构造不出来**：
    //   本桩 `ctx.get()` 全返回 null，成员表按会话 id 归房，而 `session-zzz-empty`
    //   解析不出工作区就会退回它自己当房间键 —— 但没有成员的房间确实存在
    //   （`roomKey` 就是它），只是本桩里 `pollMailboxes` 已经把四个成员都
    //   填进了各自的房间…… 与其写一条会撞成假绿的断言，不如**不写**并说明，
    //   那一条由 `host-error-i18n.test.mjs` 的字典覆盖保证文案存在。
  }

  // ── S11：头像超限 —— 本轮「信息量不许丢」的**端到端**那条 ────────
  //
  // 为什么这条必须走真路由而不是只测模块：第二轮的退步正是在**路由到界面**
  // 这一段发生的 —— `member-store` 给了具体原因，路由把它压成了一句话，
  // 界面就只剩「保存成员失败」。所以这里断言的是**响应体里那两个数字在不在**。
  say("");
  say("== S11 头像超限：原因与数字必须一路带到响应体里 ==");
  {
    // ⚠⚠ 尺寸要**算准**，否则这条用例会撞在别的分支上、看着红却不是本轮的事：
    //   · 路由层 `MEMBERS_BODY_LIMIT = MAX_MEMBER_BYTES(1_637_888) + 4096` = 1_641_984；
    //     请求体超过它会被 **413 `TEAMCHAT_BODY_TOO_LARGE`** 拦下 —— 根本到不了
    //     `member-store`。（第一版就是塞了 3.2 MB，红的是 413，与本轮无关。）
    //   · `member-store` 的头像上限判的是 **value.length（字符数）** > 1_572_864。
    //   所以要撞的是「**字符数**过 1_572_864 而 **JSON 体**不过 1_641_984」：
    //     纯 ASCII 时两者相等 ⇒ 取 1_600_000 字符 = 1_600_000 字节，
    //     中间那 40 KB 正好是路由余量。这样才真的走到头像那条。
    const hugeAvatar = "A".repeat(1_600_000);
    const s11 = await post({
      key: "gamma",
      action: "set",
      member: { displayName: "gamma", avatar: { kind: "text", value: hugeAvatar } },
    });
    // 打印要截断 —— 不截断的话这 160 万字符会整个进日志，把结论淹掉。
    check("S11 HTTP 400（不是 413：走到了成员库，不是被请求体上限拦下）", s11.status, 400);
    check("S11 路由级码仍是 TEAMCHAT_MEMBER_SAVE_FAILED", s11.payload?.code, "TEAMCHAT_MEMBER_SAVE_FAILED");
    check("S11 params.name 带上了是谁", s11.payload?.params?.name, "gamma");
    // ⚠⚠ 本轮的核心：**原因码**与**原因参数**必须都在。没有这两项，
    //   界面就只能说「保存成员失败」—— 那正是上一轮的退步。
    check("S11 带上了**原因码**（不是只有路由级码）", s11.payload?.cause, "TEAMCHAT_AVATAR_TOO_LARGE");
    // 1_600_000 / 1024 / 1024 = 1.5259… ⇒ toFixed(2) = "1.53"；
    // 上限 1_572_864 / 1024 / 1024 = 1.5 ⇒ toFixed(1) = "1.5"。
    check("S11 带上了原因的参数：实际大小", s11.payload?.causeParams?.size, "1.53");
    check("S11 带上了原因的参数：上限", s11.payload?.causeParams?.max, "1.5");
    // 老字段不许删：`error` 仍是**英文**兜底，且同样带着那两个数字。
    check(
      "S11 error 兜底是英文且带着数字（老客户端只看 error 也不丢信息）",
      s11.payload?.error,
      "Avatar data is too large (1.53 MB > 1.5 MB).",
    );
    check("S11 的 cause 码在客户端字典里有文案", clientSrc.includes(`"err.${s11.payload?.cause}"`), true);
    // ⚠ 期望值取**上一条磁盘断言（S6）的终态**，不照抄开头那个：
    //   `ghost` 在种子里就是 `isLead: true`，S5 之后一直如此。
    //   （第一版照抄了 `ghost: false`，红的是我写错的期望，不是产品。）
    check("S11 没落盘（头像被拒，磁盘上没多出脏记录）", await onDisk(), { alpha: true, beta: false, gamma: true, ghost: true });
  }

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
// 统一收尾行：让「跑没跑完 / 几条通过几条失败」一句话可读（也便于自动化统计）。
say(failures === 0 ? "OK — 全部断言通过" : `FAIL — ${failures} 项断言失败`);
fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");
process.exit(failures === 0 ? 0 : 1);
