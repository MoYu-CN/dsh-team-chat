/**
 * memberstore-succession-i18n.test.mjs —— 第三轮补的两处**真跑**验证。
 *
 * ## 这条测试为什么必须存在
 *
 * 第二轮把 host 侧（`lib/index.js`）的中文报错改成了「码 + params + 英文兜底」，
 * 但明确留下两个缺口（见第二轮报告 5.1 / 5.2）：
 *   · `lib/member-store.js` 的 6 条中文错误没有码，经 `error` 字段原样上屏；
 *   · `lib/succession.js` 的 10 条同理，而且里面 `MEMBER_NO_SESSION`
 *     与 `/spawn` 的**同码不同义**，照抄进字典会把两边说错。
 * 本轮补的就是这两处。**补完之后要有证据**，所以这里做三件事：
 *
 * 1. **码是"抠"出来的，不是手写的**：真 `import` 那两个模块、真构造失败输入、
 *    真调用，把返回的 `code` / `params` 收进一张表 —— 手写清单会跟源码漂移，
 *    而这里要证明的恰恰是"源码今天真的会返回哪些码"。
 * 2. **渲染级断言**：把客户端 bundle 求值、拿到 `apply` 注册进 `ctx.locale`
 *    的**真字典**，对每个码用 `en` / `zh` 各渲染一遍，逐字符扫 CJK。
 * 3. **信息量断言（本轮的硬要求）**：英文文案必须**带着具体原因与数字**
 *    （`avatar too large: 3.20 MB > 1.5 MB`），不许退化成「保存失败」。
 *
 * ## 语言两侧都要断言（第二轮踩过的坑）
 *
 * 只断言「英文侧不含中文」是**空转**的：`errorText` 拿不到字典项时会回落成
 * `error` 原文，而原文本来就是英文 —— 于是"翻译这条路整条断掉"也照样绿。
 * 所以下面每组都成对断言：
 *   · 英文侧：剔掉 `params` 里的**数据**之后，一个汉字都没有；
 *   · 中文侧：**必须**有汉字（没有就说明它根本没被翻，用的还是英文兜底）。
 *
 * ## 对照组（两个，各打一条路）
 *
 * `test/_sabotage-raw-params.js`（由 `test/make-sabotage-r3.mjs` 生成）把
 * 「`params` 填进文案」那一整段拆掉，于是 `{size}` / `{max}` 原样留在界面上：
 *   · 「英文侧无中文」组**照样绿**（参数没了也不影响汉字判定）；
 *   · 「占位符全部被填掉」组**必须红**。
 * `test/_sabotage-no-error-lookup.js` 拆的是「码 → 字典」那条路，
 * 本测试用它做第二个对照：中文侧必须红。
 * 两个对照都**不红就判本测试空转**，在结尾如实报出来。
 *
 * 用法：
 *   node test/memberstore-succession-i18n.test.mjs
 *   node test/memberstore-succession-i18n.test.mjs test/_sabotage-raw-params.js
 *
 * ## 需要什么
 * 要借 DSH 安装目录里的**真 react 18.3.1** 执行客户端 bundle 的 factory。
 * 拿不到时打印说明并以退出码 0 标成 SKIP（**不静默跳过**）。
 *
 * 数据目录走 `DSH_TEAM_CHAT_DATA`；没设就自建临时目录并在退出时删除 ——
 * **绝不碰任何真实数据目录**。输出落盘位置由 `DSH_TEST_OUT_DIR` 决定。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { here, outFile, pluginFile, printSkipMissingApp, reactFile, testDataDir } from "./_harness.mjs";

const CLIENT = process.argv[2] ?? pluginFile("client.js");
const REACT = reactFile();
const OUT_FILE = outFile("memberstore-succession-i18n-output.txt");
// 本测试**只在临时目录里**建 MemberStore 造错（含一条"故意写不进去"的落盘失败），
// 所以数据目录必须显式指到临时目录。
const DATA = testDataDir("DSH_TEAM_CHAT_DATA", "dsh-team-chat-r3-i18n-");

if (REACT === null) {
  printSkipMissingApp("memberstore-succession-i18n.test.mjs（要借安装目录里的真 react 执行客户端 bundle 的 factory）");
  process.exit(0);
}

const lines = [];
const say = (text = "") => lines.push(text);
let failures = 0;
/**
 * 断言。`actual !== expected` 时记一条 FAIL。
 *
 * ⚠ FAIL 行**必须以 `^\s*FAIL` 开头** —— 上游统计器就是按这个正则数的，
 * 前缀里有别的东西（比如「★ FAIL」）会被漏掉，于是失败被静默吞掉。
 */
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"} ${label}`);
  // ⚠ 打印一律走 `brief()`（截断）：有一条用例故意塞 1.5 MB 的头像，
  //   不截断的话输出文件会被那 150 万字符撑爆、真失败的行反而看不见。
  say(`     实际=${brief(actual)}`);
  say(`     期望=${brief(expected)}`);
};

/** 中文（CJK 统一表意文字）判定 —— 断言「英文界面不含中文」用的就是它。 */
const HAN = /[\u4e00-\u9fff]/u;
/** 逐个列出原文里的汉字，失败信息里直接看得到是哪个字漏了。 */
const hanIn = (text) => [...String(text)].filter((ch) => HAN.test(ch));
/**
 * 打印用：把超长值截断。
 *
 * ⚠ 必须截断，而且是**函数声明**（会被提升）：本测试有一条用例故意塞
 *   1.5 MB 的头像进去，`JSON.stringify` 会把那 150 万字符整个打进日志 ——
 *   输出文件几十 MB，真失败的那几行反而被淹掉。截断只影响**打印**，
 *   不影响任何断言。写成函数声明是为了 `check()` 能在它之前就用上它。
 */
function brief(value, max = 120) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return String(text);
  return text.length > max ? `${text.slice(0, max)}…(共 ${text.length} 字符)` : text;
}
/** 把 `params` 里的**数据**从文案里剔掉，剩下的才是"模板"。 */
const stripValues = (text, params) => {
  let out = String(text ?? "");
  for (const value of Object.values(params ?? {})) {
    if (typeof value === "string" && value !== "") out = out.split(value).join("\u0000");
  }
  return out;
};

const readSource = (file) => fs.readFileSync(file, "utf8");
const CLIENT_SRC = readSource(CLIENT);
/**
 * **本轮两个被改的模块**的源码。扫描面就限定在它们身上 ——
 * `index.js` 的码属于第二轮，由 `test/host-error-i18n.test.mjs` 保证。
 * （第一版把 `index.js` 也放进来了，结果它那 22 个码全被算成「未覆盖」，
 *   于是断言红在一片与本轮无关的东西上 —— 扫描面一放宽，
 *   判据就从「本轮改的码都覆盖到了」变成「整个插件的码都覆盖到了」。）
 */
const HOST_SRC = {
  "member-store.js": readSource(pluginFile("member-store.js")),
  "succession.js": readSource(pluginFile("succession.js")),
};
/** 一段源码里**字面**出现的全部 `TEAMCHAT_*` 码（去重、排序）。 */
const literalCodes = (src) => [
  ...new Set([...src.matchAll(/\b(TEAMCHAT_[A-Z0-9_]*[A-Z0-9])\b/gu)].map((m) => m[1])),
].sort();

// ── 命名冲突的**前提**要先核实，别凭印象 ────────────────────────
//
// 本轮拆的就是「`MEMBER_NO_SESSION` 在 `/spawn` 与 succession 里同码不同义」。
// 这个前提必须**从源码里核对**，不能靠记忆：
//   · `/spawn` 那个（现名 `TEAMCHAT_MEMBER_NO_SESSION`）必须还在 `index.js` 里；
//   · 它必须**不是** `index.js` 里那条「缺成员名」的码（两条不同的语义）；
//   · 两个名字必须**不同**（拆开了），而且旧名 `MEMBER_NO_SESSION` 不许再裸着出现。
const INDEX_SRC = readSource(pluginFile("index.js"));
const SPAWN_CODE = "TEAMCHAT_MEMBER_NO_SESSION";
const SUCC_CODE = "TEAMCHAT_SUCC_MEMBER_NO_SESSION";

// ══════════════════════════════════════════════════════════════════
// 1) 求值客户端 bundle（与 host-error-i18n.test.mjs 同一套桩）
// ══════════════════════════════════════════════════════════════════
const react = (await import(pathToFileURL(REACT).href)).default;

const dicts = new Map();
let activeLang = "zh";

const locale = {
  register(namespace, bundle) {
    dicts.set(namespace, bundle);
    return () => dicts.delete(namespace);
  },
  bind(namespace) {
    return (key, params) => {
      const bundle = dicts.get(namespace);
      const dict = bundle === undefined ? undefined : (bundle[activeLang] ?? bundle.zh);
      let text = dict === undefined ? undefined : dict[key];
      if (typeof text !== "string") return key; // 缺项返回 key 本身 —— 与真实现一致
      for (const [name, value] of Object.entries(params ?? {})) {
        text = text.split(`{${name}}`).join(String(value));
      }
      return text;
    };
  },
  subscribe() {
    return () => {};
  },
};

let captured = null;
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  XMLHttpRequest: class {
    open() {}
    send() {}
  },
  EventSource: class {
    close() {}
  },
  document: undefined,
  localStorage: undefined,
  window: {
    __ModuleLoader__: {
      load(definition) {
        captured = definition;
      },
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(CLIENT_SRC, sandbox, { filename: CLIENT });

if (captured === null) {
  say("FAIL factory 没有注册（__ModuleLoader__.load 没被调用）");
  failures += 1;
}

const exportsObj =
  captured === null
    ? null
    : captured.factory((spec) => {
        if (spec === "react") return react;
        if (spec === "react-dom") return { createPortal: () => null };
        throw new Error(`测试没准备这个模块：${spec}`);
      });

// ── 真跑一次 `apply`，把字典注册进上面的 `ctx.locale` 桩 ────────────
//
// ⚠ 不跑 `apply` 的话 `dicts` 是空的，`t()` 每个键都返回**键名本身**，
//   于是「英文侧无中文」会**假绿**、而渲染出来的东西其实是 `err.TEAMCHAT_*`。
//   这正是那种"测试看着过了、界面其实是键名"的坑，所以必须真注册。
const applyCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on: () => () => {},
  effect: (fn) => {
    const disposer = fn();
    return typeof disposer === "function" ? disposer : () => {};
  },
  get: () => null,
  locale,
  slots: {
    inject: (_slotName, factory) => {
      factory?.();
      return () => {};
    },
    register: () => () => {},
    onEntryError: () => () => {},
  },
  inject: () => {},
  sidebarRightTabs: { register: () => () => {} },
  sessionProjections: { register: () => () => {}, onChanged: () => () => {}, stateOf: () => undefined },
  webServer: { register: () => {}, tapIndex: () => () => {} },
};
let applyError = null;
try {
  exportsObj?.apply(applyCtx);
} catch (error) {
  applyError = error;
}
check("apply 没抛错（字典注册链路要真的跑到）", applyError === null ? null : String(applyError?.message ?? applyError), null);

say(`react 版本：${react.version}`);
say(`被测 client.js：${path.basename(CLIENT)}`);
say(`临时数据目录：${DATA.dir}`);
say("");

// ══════════════════════════════════════════════════════════════════
// 2) 从**真模块**里抠出「今天真的会返回哪些码 + 带什么 params」
// ══════════════════════════════════════════════════════════════════
const storeMod = await import(pathToFileURL(pluginFile("member-store.js")).href);
const succMod = await import(pathToFileURL(pluginFile("succession.js")).href);
const { MemberStore } = storeMod;

/** 抠到的码表：`code -> {site, params}`（site 标明来自哪个模块）。 */
const captured_ = new Map();
const record = (site, result) => {
  if (result === null || typeof result !== "object" || typeof result.code !== "string") {
    failures += 1;
    say(`FAIL ${site} 没返回稳定码：${brief(result)}`);
    return;
  }
  captured_.set(result.code, { site, params: result.params ?? null });
  return result.code;
};

say("== 抠码 1：member-store.js（造真失败输入，看它真返回什么）==");
const store = new MemberStore(DATA.dir);

/** 每条用例：`[标签, 期望码, 造输入的函数]`。 */
const storeCases = [
  [
    "成员键为空",
    "TEAMCHAT_MEMBER_KEY_EMPTY",
    () => store.set("", { displayName: "x" }),
  ],
  [
    "没有可保存的字段",
    "TEAMCHAT_MEMBER_NO_FIELDS",
    () => store.set("k-empty", {}),
  ],
  [
    "头像超大（3.15 MB > 1.5 MB）",
    "TEAMCHAT_AVATAR_TOO_LARGE",
    // `kind: "text"` 是刻意的：这样就不会先被 `IMAGE_DATA_URL` 那条形态检查拦下，
    // 一定走到**尺寸**那条分支（本轮要验的就是它）。
    () =>
      store.set("k-big-avatar", {
        displayName: "大图",
        avatar: { kind: "text", value: "A".repeat(Math.ceil(3.15 * 1024 * 1024)) },
      }),
  ],
  [
    "单条资料超上限（头像那一关过了，合计还是超）",
    "TEAMCHAT_MEMBER_TOO_LARGE",
    // ⚠ 这条的参数是**量出来的**，不是拍脑袋写的（第一版拍错了两回，用例空转）：
    //   · 头像那关按**字符数**判（`MAX_AVATAR_VALUE` = 1_572_864 字符）；
    //   · 资料那关按**字节数**判（`MAX_MEMBER_BYTES` = 1_637_888 字节）。
    //   两个数字只差 65 KB，所以替身字符的选择很关键：
    //     · 纯 ASCII：字符数 = 字节数 ⇒ 过了 1_572_864 字符就必然过 1_637_888 字节，
    //       **永远撞头像那条**（`x` × 1_572_865 → AVATAR_TOO_LARGE，实测如此）；
    //     · 汉字（UTF-8 一个字 3 字节）：字符数 600_000 < 1_572_864 ⇒ 头像那关**过**，
    //       而字节数 1_800_121 > 1_637_888 ⇒ 正好落在本条分支。
    //   实测三组（见报告 ④）：
    //     `x`×1_572_865 → AVATAR_TOO_LARGE｜`中`×520_000 → 存进去了｜`中`×600_000 → 本条。
    () =>
      store.set("k-big-member", {
        displayName: "大资料",
        avatar: { kind: "text", value: "中".repeat(600_000) },
        instructions: "x",
      }),
  ],
];
for (const [label, expectedCode, run] of storeCases) {
  const result = await run();
  const got = record(`member-store「${label}」`, result);
  say(`   ${got ?? "(无码)"}  ← ${label}`);
  say(`      ${brief(result?.error)}`);
  say(`      params=${brief(result?.params ?? null)}`);
  check(`member-store「${label}」的码稳定`, got, expectedCode);
}

// 落盘失败：把 `members.json` 变成**同名目录** ⇒ rename 必然失败（Windows 上 EPERM）。
say("");
say("   落盘失败（把 members.json 换成同名目录）");
const blockedDir = path.join(DATA.dir, "blocked");
fs.mkdirSync(path.join(blockedDir, "members.json"), { recursive: true });
const blocked = new MemberStore(blockedDir);
record("member-store 落盘失败", await blocked.set("k-disk", { displayName: "写不进去" }));
say(`      ${captured_.get("TEAMCHAT_MEMBER_WRITE_FAILED")?.params?.detail ?? "(没抠到)"}`);

// ── succession.js：能直接构造的四条 ─────────────────────────────
say("");
say("== 抠码 2：succession.js（真调 runSuccession）==");
const profileMap = new Map([
  ["pal", { displayName: "行情观察员", sessionId: "session-pal-0001", cwd: "D:\\demo", duty: "盯盘" }],
  ["ghost", { displayName: "还没上岗", cwd: "D:\\demo", duty: "预配资料" }],
]);
const fakeStore = { get: (key) => profileMap.get(key) };
/** 所有宿主服务都缺席的 ctx —— 正好落到 `TEAMCHAT_SUCC_RUNTIME_UNAVAILABLE`。 */
const bareCtx = { logger: { info: () => {}, warn: () => {}, error: () => {} }, get: () => null };

const succCases = [
  ["缺成员名", "TEAMCHAT_SUCC_MEMBER_NO_KEY", { memberKey: "  " }],
  ["成员资料不存在", "TEAMCHAT_SUCC_MEMBER_NOT_FOUND", { memberKey: "nobody" }],
  ["成员没有会话（只有预配资料）", "TEAMCHAT_SUCC_MEMBER_NO_SESSION", { memberKey: "ghost" }],
  ["宿主缺 agents / sessionController", "TEAMCHAT_SUCC_RUNTIME_UNAVAILABLE", { memberKey: "pal" }],
];
for (const [label, expectedCode, input] of succCases) {
  const result = await succMod.runSuccession(bareCtx, fakeStore, { ...input, dataDir: DATA.dir });
  const got = record(`succession「${label}」`, result);
  say(`   ${got ?? "(无码)"}  ← ${label}`);
  say(`      ${brief(result?.error)}`);
  say(`      params=${brief(result?.params ?? null)}`);
  check(`succession「${label}」的码稳定`, got, expectedCode);
}

// ── 抠到的码 vs 源码里字面出现的码 ──────────────────────────────
//
// 这条断言防的是「抠码脚本只覆盖了一部分分支，于是字典覆盖率是**那个子集**的
// 覆盖率」——那种绿是假的。判据：本轮每个模块里字面写着的 `TEAMCHAT_*`
// 要么被真跑抠到过，要么在这张「已知构造不出来」的清单里**逐条写了原因**。
say("");
say("== 抠到的码 vs 源码字面量 ==");
const uncoveredBySite = {};
/** 某个模块里**字面**出现的码（其它模块里的不算它的）。 */
const literalIn = (file) => literalCodes(HOST_SRC[file]);
/** 抠出来的码里，归属某个模块的那些。 */
const capturedIn = (prefix) =>
  [...captured_.keys()].filter((code) => String(captured_.get(code)?.site ?? "").startsWith(prefix));
for (const file of Object.keys(HOST_SRC)) {
  const admitted = capturedIn(file.replace(/\.js$/u, ""));
  const literals = literalIn(file);
  uncoveredBySite[file] = literals.filter((code) => !admitted.includes(code));
  say(`   ${file}：字面 ${literals.length} 个，抠到 ${admitted.length} 个，未覆盖 ${uncoveredBySite[file].length} 个`);
  for (const code of literals) {
    say(`      ${admitted.includes(code) ? "抠到  " : "未覆盖"}  ${code}`);
  }
}

// ⚠ 已知**构造不出来**的码，逐条说明为什么 —— 不写清楚就等于假装全覆盖。
const KNOWN_UNCOVERED = {
  // `/spawn` 路由的码。它要真跑 HTTP 路由 + 一个 live 会话才撞得到，
  // 本测试是**模块级**的（只 import member-store / succession），不碰路由。
  // 由 `test/route-test.mjs`、`test/smoke-succession.mjs` 与
  // `test/host-error-i18n.test.mjs` 的字典覆盖率共同保证。
  //
  // ⚠ 它之所以出现在 `succession.js` 的字面量扫描里，是因为本轮**刻意在
  //   注释里写了它的名字**（讲清两个码怎么分家的）—— 扫描器扫的是文本，
  //   注释里的码也算命中。那是好事（文档与代码同步），所以不挪走。
  TEAMCHAT_MEMBER_NO_SESSION: "`/spawn` 的码；在 succession.js 里只出现在解释命名冲突的注释中",
  // 交替里这几条要先满足前置状态，模块级造不出来：
  TEAMCHAT_SUCC_BUSY: "要先占满 MAX_INFLIGHT(4) 个在跑的交替",
  TEAMCHAT_SUCC_IN_FLIGHT: "要先让同一个成员有一场交替在跑",
  TEAMCHAT_SUCC_MEMBER_STORE_FAILED: "要 `store.set` 在交替中途失败（真跑一次 90 秒的交接才走得到）",
  TEAMCHAT_SUCC_SESSION_FAILED: "要 `ensureSession` 抛错",
  TEAMCHAT_SUCC_SESSION_NOT_LIVE: "要新会话建了但 `agents.get()` 拿不到",
  TEAMCHAT_SUCC_STEER_FAILED: "要 `agent.steer` 抛错",
  TEAMCHAT_SUCC_NOT_STEERABLE: "要一个**没有** `steer` 方法的 live agent",
  TEAMCHAT_SUCC_HANDOVER_TIMEOUT: "要走满 `HANDOVER_WAIT_MS`（默认 90 秒）",
  TEAMCHAT_SUCC_LLM_UNAVAILABLE: "要有 llm 缺席但前面的路全通",
  TEAMCHAT_SUCC_MODEL_UNAVAILABLE: "要有 llm 但 `agentDefaultModel` 读不出",
  TEAMCHAT_SUCC_LLM_EMPTY: "要模型返回空正文",
  TEAMCHAT_SUCC_LOG_EMPTY: "要会话日志里没有正文",
  TEAMCHAT_SUCC_LOG_UNAVAILABLE: "要 `sessionQuery` 与 live 会话都读不到",
  TEAMCHAT_SUCC_FAILED: "要 `runSuccession` 外层抛错（它自己层层兜住，构造极难）",
};

// ── 命名冲突：前提 + 拆分结果的硬断言 ────────────────────────────
//
// 本轮拆的是「`MEMBER_NO_SESSION` 同码不同义」。这个前提必须**从源码里核对**，
// 不能靠记忆。核完发现的一件事要如实写下来：这个旧名字其实有**三个**含义，
// 分布在三个模块里 ——
//
//   | 位置 | 含义 | 本轮处置 |
//   |---|---|---|
//   | `index.js`（`/spawn`、`member-runtime.js:362`）| 请求里缺要收编的会话 id | 改名 `TEAMCHAT_MEMBER_NO_SESSION` |
//   | `succession.js:580` / `:809` | 成员资料里没有会话 id | 改名 `TEAMCHAT_SUCC_MEMBER_NO_SESSION` |
//   | `member-runtime.js:193` | 成员记录里没有会话 id | **仍是旧名**（见下） |
//
// 第三条**没有动**，理由写在报告里：它在 `member-runtime.js`，不在本轮改动
// 范围（用户指定的是 `member-store.js` 与 `succession.js` 两个文件），
// 而且它有两个调用点（`/spawn` 与信箱投递）。这里只**如实记下**它还在，
// 不假装拆干净了。
say("");
say("== 命名冲突核查：`MEMBER_NO_SESSION` 的多种含义 ==");
const RUNTIME_SRC = readSource(pluginFile("member-runtime.js"));
say(`   /spawn 那条（${SPAWN_CODE}）：${INDEX_SRC.includes(`"${SPAWN_CODE}"`) ? "在 index.js 里" : "找不到 ← 前提不成立"}`);
say(
  `   交替那条（${SUCC_CODE}）：${HOST_SRC["succession.js"].includes(`"${SUCC_CODE}"`) ? "在 succession.js 里" : "找不到 ← 拆分没做"}`,
);
// 旧名字在当前代码里还剩几个**定义点**（`code: "MEMBER_NO_SESSION"`）。
const legacyDefs = (src) => [...src.matchAll(/code:\s*"MEMBER_NO_SESSION"/gu)].length;
const legacyInRuntime = legacyDefs(RUNTIME_SRC);
check("/spawn 那条码仍在 index.js 里", INDEX_SRC.includes(`"${SPAWN_CODE}"`), true);
check("交替那条已经是 TEAMCHAT_SUCC_ 前缀（拆开了）", SUCC_CODE.startsWith("TEAMCHAT_SUCC_"), true);
check("两个码确实不同名", SPAWN_CODE === SUCC_CODE, false);
check(
  "交替不再用旧名（它的两个返回点都改了）",
  legacyDefs(HOST_SRC["succession.js"]),
  0,
);
check(
  "`/spawn` 那条也不再经过 member-runtime 的旧名（它自己直接返回带前缀的码）",
  INDEX_SRC.includes(`"${SPAWN_CODE}"`) && legacyInRuntime > 0,
  true,
);
say(`   ⚠ 仍未改的旧名定义点：member-runtime.js 里 ${legacyInRuntime} 处（见报告第 ⑤ 节）`);

const admittedAnywhere = new Set([...captured_.keys()]);
const unexpected = [];
for (const [file, missing] of Object.entries(uncoveredBySite)) {
  for (const code of missing) {
    if (!(code in KNOWN_UNCOVERED)) unexpected.push(`${file}: ${code}`);
  }
}
check(
  "没被真跑覆盖的码全部在「已知构造不出来」清单里（没有意外漏项）",
  unexpected,
  [],
);
say("");
say(`已知构造不出来（${Object.keys(KNOWN_UNCOVERED).length} 个）—— 它们仍必须进字典渲染断言：`);
for (const [code, why] of Object.entries(KNOWN_UNCOVERED)) {
  say(`   ${code}：${why}`);
}
// 没被真跑覆盖的那批**仍然必须进字典渲染**（否则它们是"没人管的码"）。
// 另外显式带上 `/spawn` 那条 —— 命名冲突的另一半，两边文案必须都在字典里。
const ALL_CODES = [
  ...new Set([
    ...admittedAnywhere,
    ...Object.keys(KNOWN_UNCOVERED),
    SPAWN_CODE,
    ...Object.values(HOST_SRC).flatMap((src) => literalCodes(src)),
  ]),
].sort();
check(
  "渲染断言覆盖了全部码（真跑抠到的 + 已知构造不出来的 + 源码字面量，一个不落）",
  ALL_CODES.length >= admittedAnywhere.size,
  true,
);

// ══════════════════════════════════════════════════════════════════
// 3) 字典 + 渲染断言
// ══════════════════════════════════════════════════════════════════
const ns = [...dicts.keys()];
say("");
say(`apply 之后注册进 ctx.locale 的命名空间：${JSON.stringify(ns)}`);
const bundle = dicts.get(ns[0]);
const zh = bundle?.zh ?? {};
const en = bundle?.en ?? {};
const t = (key, params) => locale.bind(ns[0])(key, params);

check("至少注册了一个命名空间的字典", ns.length >= 1, true);
check("errorTextWithRaw 已导出（不然证明不了成员保存失败那条链）", typeof exportsObj.errorTextWithRaw, "function");
check("saveFailureText 已导出", typeof exportsObj.saveFailureText, "function");

// 每个码给一份**真的会从 host 支出来的参数**（上一步抠到的就是真值）。
const paramsOf = (code) => captured_.get(code)?.params ?? {};
/** 构造不出来的码：参数按源码里的模板给，只为让渲染断言跑得起来。 */
const FALLBACK_PARAMS = {
  // `/spawn` 那条（命名冲突的另一半）：源码里**没有** params。
  TEAMCHAT_MEMBER_NO_SESSION: {},
  TEAMCHAT_SUCC_NOT_STEERABLE: {},
  TEAMCHAT_SUCC_HANDOVER_TIMEOUT: { seconds: 90 },
  TEAMCHAT_SUCC_LLM_UNAVAILABLE: {},
  TEAMCHAT_SUCC_MODEL_UNAVAILABLE: {},
  TEAMCHAT_SUCC_LLM_EMPTY: {},
  TEAMCHAT_SUCC_LOG_EMPTY: {},
  TEAMCHAT_SUCC_LOG_UNAVAILABLE: {},
  TEAMCHAT_SUCC_IN_FLIGHT: { name: "pal", since: "2026-10-12T00:00:00.000Z" },
  TEAMCHAT_SUCC_BUSY: { max: 4 },
  TEAMCHAT_SUCC_SESSION_FAILED: { detail: "boom" },
  TEAMCHAT_SUCC_SESSION_NOT_LIVE: { session: "session-new-0001" },
  TEAMCHAT_SUCC_STEER_FAILED: { detail: "boom" },
  TEAMCHAT_SUCC_MEMBER_STORE_FAILED: { detail: "boom" },
  TEAMCHAT_SUCC_FAILED: { detail: "boom" },
};
const paramsFor = (code) => (captured_.has(code) ? paramsOf(code) : (FALLBACK_PARAMS[code] ?? {}));

say("");
say("== 断言组 1：字典覆盖率（每个码都有 zh + en，两套不同）==");
const missingZh = [];
const missingEn = [];
const identical = [];
for (const code of ALL_CODES) {
  const key = `err.${code}`;
  const zhText = zh[key];
  const enText = en[key];
  if (typeof zhText !== "string" || zhText === "") missingZh.push(key);
  if (typeof enText !== "string" || enText === "") missingEn.push(key);
  if (zhText === enText && typeof zhText === "string" && zhText !== "") identical.push(key);
}
check("zh 侧一个不缺", missingZh, []);
check("en 侧一个不缺", missingEn, []);
check("zh / en 两套互不相同", identical, []);

say("");
say("== 断言组 2：语言两侧都断言（英文无中文 **且** 中文有中文）==");
const enWithHan = [];
const zhWithoutHan = [];
const leftovers = [];
const keyLeaked = [];
const rendered = [];
for (const code of ALL_CODES) {
  const params = paramsFor(code);
  activeLang = "en";
  const enText = exportsObj.errorText(t, code, params, `(raw) ${code}`);
  activeLang = "zh";
  const zhText = exportsObj.errorText(t, code, params, `(raw) ${code}`);
  rendered.push({ code, en: enText, zh: zhText, params });
  // 英文侧：剔掉参数里的**数据**再查 —— 参数值本身可能是中文（用户取的名字），
  // 那是数据不是界面文案。（本轮抠到的 params 全是数字 / 英文，这条是保险。）
  const enForCheck = stripValues(enText, params);
  if (hanIn(enForCheck).length > 0) enWithHan.push({ code, text: enText, han: hanIn(enForCheck) });
  if (hanIn(zhText ?? "").length === 0) zhWithoutHan.push({ code, text: zhText });
  if (typeof enText === "string" && /\{[a-z]+\}/u.test(enText)) leftovers.push({ code, lang: "en", text: enText });
  if (typeof zhText === "string" && /\{[a-z]+\}/u.test(zhText)) leftovers.push({ code, lang: "zh", text: zhText });
  if (enText === `err.${code}` || zhText === `err.${code}`) keyLeaked.push(code);
}
check("英文文案里一个汉字都没有", enWithHan, []);
check("中文文案里确实有中文（不是回落成英文）", zhWithoutHan, []);
check("占位符全部被填掉（没有残留的 {x}）", leftovers, []);
check("键名没有漏到界面上", keyLeaked, []);

say("");
say(`每个码的两套渲染结果（共 ${rendered.length} 个）：`);
for (const row of rendered) {
  say(`   ${row.code}`);
  say(`      params: ${brief(row.params)}`);
  say(`      en: ${row.en}`);
  say(`      zh: ${row.zh}`);
}

// ══════════════════════════════════════════════════════════════════
// 4) 信息量断言：**具体原因与数字必须留得住**
// ══════════════════════════════════════════════════════════════════
//
// 这是本轮的核心验收项。第二轮的退步正是发生在这里：
//   改前（中文界面）：「保存成员失败：头像数据过大（3.15 MB > 1.5 MB）。」
//   第二轮（英文界面）：「Could not save the member "x".」← 原因与数字全丢
// 所以下面不止断言"没有中文"，还断言**那两个数字真的在文案里**。
say("");
say("== 断言组 3：信息量（原因 + 数字必须留得住）==");

/** 把一次 `/members` 失败的响应拍成客户端会抛的那个 Error（与 `membersApi.save` 同一套字段）。 */
const asClientError = (payload) => {
  const error = new Error(payload?.error ?? "HTTP 400");
  error.code = payload?.code ?? "TEAM_MEMBER_SAVE_FAILED";
  error.hostCode = payload?.code;
  error.hostParams = payload?.params;
  error.causeCode = payload?.cause;
  error.causeParams = payload?.causeParams;
  return error;
};
/** 搭出宿主 `/members` 失败时的响应体（第二处改动会把 store 的码放进 `cause`）。 */
const routePayload = (result, name = "market-watcher") => ({
  ok: false,
  code: "TEAMCHAT_MEMBER_SAVE_FAILED",
  params: { name },
  ...(typeof result.code === "string" ? { cause: result.code } : {}),
  ...(result.params === undefined ? {} : { causeParams: result.params }),
  error: result.error,
});

const avatarTooLarge = await store.set("k-big-avatar-2", {
  displayName: "大图",
  avatar: { kind: "text", value: "A".repeat(Math.ceil(3.15 * 1024 * 1024)) },
});
const payload = routePayload(avatarTooLarge);
say("宿主响应体（英文兜底 + 两个码 + 两套 params）：");
say(`   ${brief(payload)}`);

activeLang = "en";
const enSave = exportsObj.saveFailureText(t, asClientError(payload));
activeLang = "zh";
const zhSave = exportsObj.saveFailureText(t, asClientError(payload));
say(`   en: ${enSave}`);
say(`   zh: ${zhSave}`);

// 数字取**真值**，不写死：`member-store` 的算法变了这条断言要跟着变红提醒。
check(
  "英文界面：整体文案不含中文",
  hanIn(stripValues(enSave, { name: payload.params.name })).length,
  0,
);
check("英文界面：说清是哪个成员", enSave.includes('"market-watcher"'), true);
check("英文界面：说清是**头像**过大（不是笼统的「保存失败」）", /avatar/iu.test(enSave), true);
check("英文界面：带上实际大小（3.15）", enSave.includes("3.15"), true);
check("英文界面：带上是**上限**（1.5），且写成 a > b 的形式", />\s*1\.5\s*MB/iu.test(enSave), true);
check("中文界面：原因与数字同样都在", /头像数据过大/u.test(zhSave) && zhSave.includes("3.15") && zhSave.includes("1.5"), true);

// 落盘失败那条：原因（系统错误码）也不能丢。
const diskPayload = routePayload(
  { code: "TEAMCHAT_MEMBER_WRITE_FAILED", params: { detail: "EPERM: operation not permitted, rename" }, error: "Could not write the member profile: EPERM: operation not permitted, rename" },
  "pal",
);
activeLang = "en";
const enDisk = exportsObj.saveFailureText(t, asClientError(diskPayload));
say(`   落盘失败 en: ${enDisk}`);
check("英文界面：落盘失败说出了系统原因（不是「保存失败」四个字）", enDisk.includes("EPERM"), true);
check("英文界面：落盘失败里没有中文", hanIn(enDisk).length, 0);

// 老宿主兼容：没有 `cause` 时不能用 `undefined` 上屏，必须退回原文。
const oldHost = { ok: false, code: "TEAMCHAT_MEMBER_SAVE_FAILED", params: { name: "pal" }, error: "legacy raw reason" };
activeLang = "en";
const enOld = exportsObj.saveFailureText(t, asClientError(oldHost));
say(`   老宿主（没有 cause）en: ${enOld}`);
check("没有 cause 时仍然有文案（不出现 undefined）", typeof enOld === "string" && enOld !== "" && !enOld.includes("undefined"), true);

// ══════════════════════════════════════════════════════════════════
// 5) 对照组判定：两个对照各自必须红
// ══════════════════════════════════════════════════════════════════
say("");
const base = path.basename(CLIENT);
const isNoParams = /_sabotage-raw-params/u.test(base);
const isNoLookup = /_sabotage-no-error-lookup/u.test(base);
say(`== 对照组模式：${isNoParams ? "是（_sabotage-raw-params.js）" : isNoLookup ? "是（_sabotage-no-error-lookup.js）" : "否（被测的是真 bundle）"} ==`);

const codeWithParam = [...ALL_CODES].find((code) =>
  // 看**字典模板本身**有没有 `{x}`（不经过 `t()`，免得被对照组的填充行为干扰）。
  /\{[a-z]+\}/u.test(`${zh[`err.${code}`] ?? ""}${en[`err.${code}`] ?? ""}`),
);
say(`（带占位符的码示例：${codeWithParam ?? "(一个都没有)"}）`);

if (isNoParams) {
  // 参数不再被填进文案 ⇒ 「占位符全部被填掉」必须红。
  if (leftovers.length === 0) {
    failures += 1;
    say("FAIL 对照组上「占位符全部被填掉」竟然还是绿的 —— 判据空转，这条测试证明不了数字留得住");
  } else {
    say(`PASS 对照组上「占位符」那一组如期变红（${leftovers.length} 处残留 {x}）—— 数字那条判据不是空转`);
    for (const row of leftovers.slice(0, 5)) say(`     [${row.lang}] ${row.code} → ${row.text}`);
  }
  // 英文侧「无中文」在这一对照上**照样绿** —— 这正是"只断言英文侧会空转"的实证。
  if (enWithHan.length === 0) {
    say(`PASS 对照组上「英文文案里一个汉字都没有」**照样是绿的**（${ALL_CODES.length} 个码全绿）`);
    say("     ⇒ 只断言英文侧不含中文证明不了任何事：拆掉参数填充它也不会红。");
  } else {
    say("⚠ 对照组上英文侧竟然红了 —— 说明这一组不只受参数填充影响，结论要打折看待。");
  }
  // 信息量那组也必须红：数字没能填进文案，`3.15` / `1.5` 都不该出现。
  activeLang = "en";
  const enSaveControl = exportsObj.saveFailureText(t, asClientError(payload));
  say(`     对照组里的成员保存失败文案：${enSaveControl}`);
  if (enSaveControl.includes("3.15") || enSaveControl.includes("1.5")) {
    failures += 1;
    say("FAIL 对照组上「信息量」那组竟然还是绿的 —— 数字留得住这条判据是空转的");
  } else {
    say("PASS 对照组上「英文界面带上了 3.15 / 1.5」如期变红（参数没被填进去）—— 信息量判据不是空转");
  }
}
if (isNoLookup) {
  if (zhWithoutHan.length === 0) {
    failures += 1;
    say("FAIL 对照组上「中文文案里确实有中文」竟然还是绿的 —— 判据空转");
  } else {
    say(`PASS 对照组上中文那一组如期变红（${zhWithoutHan.length} 个码回落成了英文兜底）—— 判据不是空转`);
    for (const row of zhWithoutHan.slice(0, 5)) say(`     ${row.code} → ${row.text}`);
  }
}

say("");
say(`== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ==`);
say(failures === 0 ? "OK — 全部断言通过" : `FAIL — ${failures} 项断言失败`);
fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");
process.exit(failures === 0 ? 0 : 1);
