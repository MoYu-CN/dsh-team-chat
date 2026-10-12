/**
 * host-error-i18n.test.mjs —— 宿主报错的**本地化链路**真跑测试。
 *
 * ## 这条链是什么
 *
 * host 半**拿不到界面语言**（`ctx.locale` 是客户端半的服务；桌面端的
 * `readUiLocalePreference` 属于 app 自身，不是插件可见的 API），所以从第三方
 * 插件里做不到「按宿主语言选文案」。正确做法是两段：
 *
 *   host：中文串 → **稳定错误码**（`TEAMCHAT_*`）+ `params`，同时保留
 *         `error` 字段作**英文兜底**（老字段不许删）；
 *   client：拿 `code` 查自己的内联字典（zh / en 两套），拿不到就回落原文。
 *
 * 本脚本证明的就是第二段 + 第一段的契约。
 *
 * ## 为什么不能只靠静态字符串匹配
 *
 * 「源码里没有中文字面量」证明不了「英文界面不会显示中文」——
 * `blocksToText` 那种兜底、字典缺项时 `t()` 返回的 key 本身，都能让静态扫描
 * 全绿而界面照旧出中文。所以这里**把 bundle 真的求值、真的调翻译函数**，
 * 再把渲染出来的每个字检查一遍。
 *
 * ## 对照组（必须有，否则判据是空转的）
 *
 * `test/_sabotage-no-error-lookup.js` 是 `make-sabotage.mjs` 生成的副本，
 * 它把「码 → 字典」这条查找整条拆掉（`errorText` 永远直接返回原文）。
 * 那个副本上：
 *   - 英文那一组**照样通过**（回落到的本来就是英文原文）；
 *   - 中文那一组**必须红**。
 * 这正好证明「按码翻成对应语言」是真的在起作用，不是碰巧用对了语言。
 * 用法：
 *   node test/make-sabotage.mjs      # 先造副本
 *   node test/host-error-i18n.test.mjs test/_sabotage-no-error-lookup.js
 *
 * ## 需要什么
 * 要借 DSH 安装目录里的**真 react 18.3.1** 来执行客户端 bundle 的 factory。
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
const OUT_FILE = outFile("host-error-i18n-output.txt");
// 这一份测试**不读也不写**成员库，但数据目录仍要显式指到临时目录 ——
// 万一将来有人在这里加了「真跑路由」的断言，也不会误伤真实数据。
testDataDir("DSH_TEAM_CHAT_DATA", "dsh-team-chat-i18n-");

if (REACT === null) {
  printSkipMissingApp("host-error-i18n.test.mjs（要借安装目录里的真 react 执行客户端 bundle 的 factory）");
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
  say(`     实际=${JSON.stringify(actual)}`);
  say(`     期望=${JSON.stringify(expected)}`);
};

/** 中文（CJK 统一表意文字）判定 —— 断言「英文界面不含中文」用的就是它。 */
const HAN = /[\u4e00-\u9fff]/u;
/** 逐个列出原文里的汉字，失败信息里直接看得到是哪个字漏了。 */
const hanIn = (text) => [...String(text)].filter((ch) => HAN.test(ch));

const readSource = (file) => fs.readFileSync(file, "utf8");
const CLIENT_SRC = readSource(CLIENT);
// 码是**宿主**给的，字典在**客户端** —— 两边文件都要读：
// 从宿主侧抠出「今天真的会返回哪些码」，再从客户端侧核对「每个码都有两套文案」。
// 只读客户端那份的话，这条断言会因为「客户端源码里没有 TEAMCHAT_」而空转。
//
// ⚠⚠ 2026-10-12 第三轮：宿主侧的码**不只在 `index.js` 里**了。
//   `lib/member-store.js`（成员库的原因码）与 `lib/succession.js`（交替）也会
//   把码送到响应体里（`cause` 字段 / `502` 那条 `{...result}`）。只扫
//   `index.js` 的话，本轮新加的 21 个码**一个都不会进这张表**，于是
//   「每个码都有中英文案」那组断言看着全绿、实际只覆盖了旧码 —— 那是空转。
//   所以四个会进响应体的模块一起扫。
const HOST_FILES = ["index.js", "member-store.js", "succession.js"].map((name) => ({
  name,
  src: readSource(pluginFile(name)),
}));
const HOST_SRC = HOST_FILES.map((row) => row.src).join("\n");

// ══════════════════════════════════════════════════════════════════
// 1) 求值客户端 bundle，拿到导出面 + 注册进去的真字典
// ══════════════════════════════════════════════════════════════════
const react = (await import(pathToFileURL(REACT).href)).default;

/** 各命名空间的字典：`{ns: {zh, en}}`，由 bundle 自己 `register` 填进来。 */
const dicts = new Map();
let activeLang = "zh";

const locale = {
  register(namespace, bundle) {
    dicts.set(namespace, bundle);
    return () => dicts.delete(namespace);
  },
  /** `bind(ns) -> (key, params) => string`（与宿主 `dsh-client-locale` 同一个契约）。 */
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

say(`react 版本：${react.version}`);
say(`被测 client.js：${CLIENT}`);
say(`（对照组副本：${path.basename(CLIENT)}）`);
say("");

if (exportsObj !== null) {
  // ── 1a) 导出面 ────────────────────────────────────────────────
  check("errorText 已导出（没有它就只能静态匹配，证明不了渲染）", typeof exportsObj.errorText, "function");
  check("spawnErrorMessage 已导出", typeof exportsObj.spawnErrorMessage, "function");
  check("apply 是函数", typeof exportsObj.apply, "function");

  // ── 1b) 注册进 `ctx.locale`，拿真字典 ─────────────────────────
  //
  // 只给 `apply` 供应它真正用到的那几个面（下面这些方法与真宿主同名同契约）。
  // 官方**服务**一律 `get() -> null`：工具 / 预设 / agents 全缺席 ⇒ 按插件
  // 自己的设计只降级、不抛错。日志与槽位都记下来，顺便当"apply 真跑到底了"
  // 的证据 —— 只把字典捞到手、`apply` 半路炸掉，那就证明不了注册链路是通的。
  const slotRegistrations = [];
  const injectedSlots = [];
  const injectionErrors = [];
  const sidebarTabTypes = [];
  const logs = [];
  const applyCtx = {
    logger: {
      info: (m) => logs.push(`[info] ${String(m)}`),
      warn: (m) => logs.push(`[warn] ${String(m)}`),
      error: (m) => logs.push(`[error] ${String(m)}`),
    },
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    get: () => null,
    locale,
    // 插件里 `applyInner` 用到的槽位面。真宿主的 `inject(slotName, factory)`
    // 是「这个槽位可用时才调工厂」；本测试的桩**立刻调**（本测试的目的不是
    // 复现槽位可用性，而是让 `apply` 真的跑到底 + 看它注册了哪些槽）。
    // `inject` 自己返回 disposer，所以工厂返回什么都不影响收尾。
    slots: {
      inject: (slotName, factory) => {
        injectedSlots.push(slotName);
        try {
          factory?.();
        } catch (error) {
          // 槽位注册里抛错也要如实记录 —— 静默吞掉就成了「测试替插件掩盖缺陷」。
          injectionErrors.push(`${slotName}: ${error?.message ?? String(error)}`);
        }
        return () => {};
      },
      register: (options) => {
        slotRegistrations.push(options?.name ?? "?");
        return () => {};
      },
      onEntryError: () => () => {},
    },
    // `ctx.inject([...], cb)`：服务缺席时真宿主会**静静地不调 cb**，
    // 所以这里直接不调 —— 正好复现「没有 inputTriggers 的宿主」那种情形。
    // 代价说清：`@` 提及源那一段因此**没有被本测试覆盖**（它和本地化无关）。
    inject: () => {},
    // 右栏页签类型注册（`applyInner` 第 2 步）。缺席会抛，所以要给。
    sidebarRightTabs: {
      register: (options) => {
        sidebarTabTypes.push(options?.id ?? "?");
        return () => {};
      },
    },
    sessionProjections: {
      register: () => () => {},
      onChanged: () => () => {},
      stateOf: () => undefined,
    },
    webServer: { register: () => {}, tapIndex: () => () => {} },
  };
  let applyError = null;
  try {
    exportsObj.apply(applyCtx);
  } catch (error) {
    applyError = error;
  }
  // `apply` 里凡是"宿主没这个服务就降级"的地方都会走 try/catch；
  // 真抛出来就是缺陷，如实记 FAIL 而不是吞掉。
  check("apply 没抛错", applyError === null ? null : String(applyError?.message ?? applyError), null);
  // 「apply 半路炸掉」的判据用**注入过的槽位清单**（`inject` 是 applyInner 每
  // 一步的入口），不用 `register` 的条数。清单写全并逐项比对 —— 少一项多半
  // 是早期 return，多一项则说明有人加了新槽位而这里没跟上。
  //
  // ⚠ 只有 9 项、不是 10 项：`conversation.input.permission` 那个槽位是**条件
  //   注册**的（`gateOnChatRoom`，见 `HiddenPermission` 的注释 —— 无条件注册
  //   会让权限按钮在切回对话页签时永久消失）。没有 DOM 就没有 `gate` 的判定，
  //   所以那一条在这里**跑不到**。这是**没被本测试覆盖**的一处，如实列出来。
  const EXPECTED_SLOTS = [
    "conversation.view",
    "sidebar.right.pane.tab",
    "sidebar.right.pane.tab.title",
    "main",
    "sidebar.panellist",
    "conversation.session.header.actions",
    "conversation.input.left",
    "settings.section",
    "conversation.session.header.lineage",
  ];
  check("apply 真的跑到底（inject 的槽位清单完全对上）", injectedSlots, EXPECTED_SLOTS);
  check("apply 也登记了右栏页签类型", sidebarTabTypes.length > 0, true);
  // 槽位注册里抛错一律记 FAIL —— 静默吞掉就等于测试替插件掩盖缺陷。
  check("槽位注册里没抛错", injectionErrors, []);
  say("");
  say(`apply inject 过的槽位（${injectedSlots.length} 个，已与预期清单逐项比对）：`);
  for (const name of injectedSlots) say(`   ${name}`);
  say(`⚠ 未覆盖：conversation.input.permission（条件注册，需要 DOM 里的 gate 判定）`);
  say(`apply 里 slots.register 的 name：${JSON.stringify(slotRegistrations)}`);
  say(`apply 登记的右栏页签类型：${JSON.stringify(sidebarTabTypes)}`);

  const ns = [...dicts.keys()];
  say("");
  say(`apply 之后注册进 ctx.locale 的命名空间：${JSON.stringify(ns)}`);
  const bundle = dicts.get(ns[0]);
  check("至少注册了一个命名空间的字典", ns.length >= 1, true);
  const zh = bundle?.zh ?? {};
  const en = bundle?.en ?? {};

  // ── 1c) 从**宿主源码**里抠出全部 `TEAMCHAT_*` 码 ───────────────
  //
  // 为什么从源码里抠而不是手写一张清单：手写的清单会跟 host 漂移，
  // 而这里要证明的恰恰是「host 今天返回的每个码，客户端今天都有两套文案」。
  //
  // ⚠ 正则**必须以字母数字结尾**（`[A-Z0-9_]*[A-Z0-9]`）：写法是 `TEAMCHAT_BODY_*`
  //   的注释里那个词会长这样，用 `\w+` 会把它当成一个真的码（`TEAMCHAT_BODY_`）
  //   抠出来，于是"每个码都有字典项"那组永远红 —— 那是**扫描器的假阳性**，
  //   不是产品缺陷。假阳性比没有断言更坏：红久了就没人看红了。
  const hostCodes = [
    ...new Set([...HOST_SRC.matchAll(/\b(TEAMCHAT_[A-Z0-9_]*[A-Z0-9])\b/gu)].map((m) => m[1])),
  ].sort();
  check("从宿主源码里抠到了 TEAMCHAT_* 码（不是空集）", hostCodes.length > 0, true);
  say("");
  say(`宿主 lib/index.js 里的 TEAMCHAT_* 码：${hostCodes.length} 个`);
  for (const code of hostCodes) say(`   ${code}`);
  say("");

  // ── 1d) 「宿主码 → 客户端字典」这条链一行行核对 ────────────────
  //
  // 上面那组只数了字典有没有键；这一组核对**码是不是同时出现在两边**：
  // 宿主支了个码而客户端没有对应键 ⇒ 中文界面会看到英文兜底（真缺口）；
  // 反之字典里躺着一个宿主从不返回的键 ⇒ 死文案（也是缺口，只是没症状）。
  const clientKeys = new Set(
    [...CLIENT_SRC.matchAll(/"err\.(TEAMCHAT_[A-Z0-9_]*[A-Z0-9])"/gu)].map((m) => m[1]),
  );
  const hostSet = new Set(hostCodes);
  // `TEAMCHAT_UNKNOWN` 是 `errorText` 的**通用兜底键**（留着备用、客户端里
  // 也确实用它），不是"宿主该返回的码"，所以从这组里排除掉并说明原因。
  const GENERIC_FALLBACK = new Set(["TEAMCHAT_UNKNOWN"]);
  // `TEAMCHAT_ADOPT_FAILED` 是 `/spawn` 的**兜底**码：只有 `adopted.code` 不是
  // 字符串时才用得上。它确实会返回，只是构造不出来，所以也算"活的"。
  const codeWithoutDict = hostCodes.filter((code) => !clientKeys.has(code));
  const dictWithoutCode = [...clientKeys]
    .filter((code) => !hostSet.has(code) && !GENERIC_FALLBACK.has(code))
    .sort();
  check("宿主每个码都有客户端字典项", codeWithoutDict, []);
  check("客户端字典里没有宿主从不返回的死键", dictWithoutCode, []);

  // ── 2) 每个码都必须有 zh / en 两套，且两套不同 ─────────────────
  say("== 断言组 1：字典覆盖率（每个宿主码都有 zh + en）==");
  const missingZh = [];
  const missingEn = [];
  const identical = [];
  for (const code of hostCodes) {
    const key = `err.${code}`;
    const zhText = zh[key];
    const enText = en[key];
    if (typeof zhText !== "string" || zhText === "") missingZh.push(key);
    if (typeof enText !== "string" || enText === "") missingEn.push(key);
    // 两套一样 ⇒ 十有八九是把中文抄进了 en，或反过来。必须显式报出来，
    // 否则「英文界面不含中文」那条断言可能只是因为这个码压根没进模板。
    if (zhText === enText && typeof zhText === "string" && zhText !== "") identical.push(key);
  }
  check("zh 侧一个不缺", missingZh, []);
  check("en 侧一个不缺", missingEn, []);
  check("zh / en 两套互不相同", identical, []);

  // ── 3) 渲染断言：英文界面下这些提示**不含中文** ───────────────
  //
  // 每个码给一份**真的会从 host 支出来的参数**（与 `lib/index.js` 里
  // `params:` 那些字面量一一对应）。缺参数时 `{name}` 会原样留着，
  // 那本身就是缺陷，所以下面还断言"没有残留的 {}"。
  const samples = {
    TEAMCHAT_BODY_TOO_LARGE: {},
    TEAMCHAT_BODY_INVALID_JSON: {},
    TEAMCHAT_BODY_NOT_OBJECT: {},
    TEAMCHAT_EMPTY_MESSAGE: {},
    TEAMCHAT_NO_ROOM: {},
    TEAMCHAT_MISSING_MEMBER_NAME: {},
    TEAMCHAT_MEMBER_NOT_FOUND: { name: "market-watcher" },
    TEAMCHAT_MEMBER_REMOVE_FAILED: { name: "market-watcher" },
    TEAMCHAT_MEMBER_SAVE_FAILED: { name: "market-watcher" },
    TEAMCHAT_MEMBER_REMOVED: {},
    TEAMCHAT_NO_MEMBERS: {},
    TEAMCHAT_NO_TARGET: { target: "market-watcher" },
    TEAMCHAT_MEMBER_NO_SESSION: {},
    TEAMCHAT_TARGET_NOT_FOUND: {},
    TEAMCHAT_TARGET_IS_SUBAGENT: {},
    TEAMCHAT_ROOM_NO_CWD: {},
    TEAMCHAT_INVALID_MEMBER_NAME: { max: 64 },
    TEAMCHAT_MISSING_DESCRIPTION: { max: 200 },
    TEAMCHAT_PRESET_UNAVAILABLE: {},
    TEAMCHAT_UNKNOWN_PRESET: { preset: "researcher", known: "engineer / writer" },
    TEAMCHAT_LEAD_EXISTS: { name: "阿尔法" }, // 值本身是中文（用户取的名字）—— 允许的部分
    TEAMCHAT_ADOPT_FAILED: {},
    // ── 第三轮新增：成员库（`lib/member-store.js`）的原因码 ──────
    TEAMCHAT_AVATAR_TOO_LARGE: { size: "3.15", max: "1.5" },
    TEAMCHAT_MEMBER_TOO_LARGE: { max: "1.6" },
    TEAMCHAT_MEMBER_KEY_EMPTY: {},
    TEAMCHAT_MEMBER_NO_FIELDS: {},
    TEAMCHAT_MEMBER_WRITE_FAILED: { detail: "EPERM: operation not permitted, rename" },
    // ── 第三轮新增：交替（`lib/succession.js`）────────────────────
    TEAMCHAT_SUCC_MEMBER_NO_KEY: {},
    TEAMCHAT_SUCC_MEMBER_NOT_FOUND: { name: "pal" },
    TEAMCHAT_SUCC_MEMBER_NO_SESSION: {},
    TEAMCHAT_SUCC_NOT_STEERABLE: {},
    TEAMCHAT_SUCC_HANDOVER_TIMEOUT: { seconds: 90 },
    TEAMCHAT_SUCC_LLM_UNAVAILABLE: {},
    TEAMCHAT_SUCC_MODEL_UNAVAILABLE: {},
    TEAMCHAT_SUCC_LLM_EMPTY: {},
    TEAMCHAT_SUCC_LOG_EMPTY: {},
    TEAMCHAT_SUCC_LOG_UNAVAILABLE: {},
    TEAMCHAT_SUCC_IN_FLIGHT: { name: "pal", since: "2026-10-12T00:00:00.000Z" },
    TEAMCHAT_SUCC_BUSY: { max: 4 },
    TEAMCHAT_SUCC_RUNTIME_UNAVAILABLE: {},
    TEAMCHAT_SUCC_SESSION_FAILED: { detail: "boom" },
    TEAMCHAT_SUCC_SESSION_NOT_LIVE: { session: "session-new-0001" },
    TEAMCHAT_SUCC_STEER_FAILED: { detail: "boom" },
    TEAMCHAT_SUCC_MEMBER_STORE_FAILED: { detail: "boom" },
    TEAMCHAT_SUCC_FAILED: { detail: "boom" },
    TEAMCHAT_UNKNOWN: {},
  };

  /** 把所有占位符填成"值与参数名同名"的形式，便于看出有没有残留 `{x}`。 */
  const fillAll = (text, params) => {
    let out = text;
    for (const [name, value] of Object.entries(params)) out = out.split(`{${name}}`).join(String(value));
    return out;
  };

  const t = (key, params) => locale.bind(ns[0])(key, params);

  say("");
  say("== 断言组 2：英文界面下这些提示不含中文（渲染级）==");
  const enWithHan = [];
  const zhWithHan = [];
  const leftovers = [];
  const keyLeaked = [];
  for (const code of hostCodes) {
    const params = samples[code] ?? {};

    activeLang = "en";
    const enText = exportsObj.errorText(t, code, params, `(raw) ${code}`);
    activeLang = "zh";
    const zhText = exportsObj.errorText(t, code, params, `(raw) ${code}`);

    // 英文侧：把参数里的中文值剔掉再查 —— 「用户取的成员名叫『阿尔法』」
    // 出现在英文句子里是**正确**的（那是数据，不是界面文案）。
    const enForCheck = Object.values(params).reduce(
      (acc, value) => (typeof value === "string" ? acc.split(value).join("") : acc),
      enText ?? "",
    );
    if (hanIn(enForCheck).length > 0) enWithHan.push({ code, text: enText, han: hanIn(enForCheck) });
    // 中文侧：本地化文案必须**带中文**（否则说明它根本没被翻，用的还是英文兜底）。
    if (hanIn(zhText ?? "").length === 0) zhWithHan.push({ code, text: zhText });
    // 占位符必须被填掉。
    if (typeof enText === "string" && /\{[a-z]+\}/u.test(enText)) leftovers.push({ code, text: enText });
    if (typeof zhText === "string" && /\{[a-z]+\}/u.test(zhText)) leftovers.push({ code, text: zhText });
    // 键名本身绝不许漏到界面上。
    if (enText === `err.${code}` || zhText === `err.${code}`) keyLeaked.push(code);
  }
  check("英文文案里一个汉字都没有", enWithHan, []);
  check("中文文案里确实有中文（不是回落成英文）", zhWithHan, []);
  check("占位符全部被填掉（没有残留的 {x}）", leftovers, []);
  check("键名没有漏到界面上", keyLeaked, []);

  // 逐条把渲染出来的样子打出来 —— 光看 PASS 看不出文案长什么样。
  say("");
  say("每个码的两套渲染结果（en / zh）：");
  for (const code of hostCodes) {
    const params = samples[code] ?? {};
    activeLang = "en";
    const enText = exportsObj.errorText(t, code, params, null);
    activeLang = "zh";
    const zhText = exportsObj.errorText(t, code, params, null);
    say(`   ${code}`);
    say(`      en: ${enText}`);
    say(`      zh: ${zhText}`);
  }

  // ── 4) 回落链：拿不到码时必须用 `error` 原文 ───────────────────
  say("");
  say("== 断言组 3：回落（拿不到码 → 用 error 原文；都没 → null）==");
  activeLang = "en";
  check("未知码 → 回落原文", exportsObj.errorText(t, "TEAMCHAT_NOT_A_REAL_CODE", {}, "raw fallback"), "raw fallback");
  check("没有码 → 回落原文", exportsObj.errorText(t, undefined, undefined, "raw fallback"), "raw fallback");
  check("没有码也没有原文 → null（交给调用方自己的兜底）", exportsObj.errorText(t, undefined, undefined, null), null);
  check("空码 → 回落原文", exportsObj.errorText(t, "", undefined, "raw fallback"), "raw fallback");

  // ── 5) `spawnErrorMessage`：这些码真的走了「码 → 字典」这条路 ─────
  //
  // 这些码是 `/__teamchat/spawn` 与 `/__teamchat/members` 支出来的，
  // 客户端从 `payload.code` 抄进 `error.hostCode`（见 `spawnApi.create`
  // 与 `membersApi.save/remove`），最后经 `spawnErrorMessage` 上屏。
  const chain = [
    ["TEAMCHAT_MEMBER_NO_SESSION", {}],
    ["TEAMCHAT_TARGET_NOT_FOUND", {}],
    ["TEAMCHAT_TARGET_IS_SUBAGENT", {}],
    ["TEAMCHAT_ROOM_NO_CWD", {}],
    ["TEAMCHAT_INVALID_MEMBER_NAME", { max: 64 }],
    ["TEAMCHAT_MISSING_DESCRIPTION", { max: 200 }],
    ["TEAMCHAT_PRESET_UNAVAILABLE", {}],
    ["TEAMCHAT_UNKNOWN_PRESET", { preset: "researcher", known: "engineer / writer" }],
    ["TEAMCHAT_LEAD_EXISTS", { name: "alpha" }],
    ["TEAMCHAT_ADOPT_FAILED", {}],
  ];
  say("");
  say(`== 断言组 4：spawnErrorMessage 的 ${chain.length} 条链路（英文界面）==`);
  const chainWithHan = [];
  const chainEmpty = [];
  for (const [code, params] of chain) {
    activeLang = "en";
    const text = exportsObj.spawnErrorMessage(t, { hostCode: code, hostParams: params, code });
    if (typeof text !== "string" || text === "") chainEmpty.push(code);
    else if (hanIn(text).length > 0) chainWithHan.push({ code, text, han: hanIn(text) });
    say(`   ${code} → ${text}`);
  }
  check("英文界面上每条链路都有文案", chainEmpty, []);
  check("英文界面上每条链路都不含中文", chainWithHan, []);

  // 官方 `TeamError` 码没有本字典项时，仍然要落到原来那句通用文案上
  // （不是空白、不是 key 名）。这条是「新旧两套码别互相打断」的回归闸。
  activeLang = "en";
  const officialUnknown = exportsObj.spawnErrorMessage(t, { code: "TEAM_SOMETHING_NEW" });
  check("官方新码 → 通用兜底文案（非空、非 key）", officialUnknown !== "" && officialUnknown !== "members.addUnavailable", true);
  say(`   TEAM_SOMETHING_NEW → ${officialUnknown}`);

  // ── 6) `blocksToText` 的正文占位符也要跟语言走 ────────────────
  say("");
  say("== 断言组 5：正文占位符（blocksToText）==");
  const blocks = [{ type: "image", source: {} }, { type: "text", text: "hello" }];
  activeLang = "en";
  const enBlocks = exportsObj.blocksToText(blocks, t);
  activeLang = "zh";
  const zhBlocks = exportsObj.blocksToText(blocks, t);
  check("英文：图片占位符不含中文", hanIn(enBlocks), []);
  check("中文：图片占位符是中文", zhBlocks.includes("图片"), true);
  // 不给 `t` 时退回中文兜底（既有测试就是这么调的，不能把它们打断）。
  check("不给 t → 中文兜底（既有契约不变）", exportsObj.blocksToText(blocks), `[图片]\nhello`);

  // ── 7) 对照组判定 ─────────────────────────────────────────────
  //
  // 两个对照，各打一条路：
  //   · `_sabotage-no-error-lookup.js`：拆掉「按码翻成对应语言」⇒ 中文组必须红；
  //   · `_sabotage-raw-params.js`：拆掉「params 交给本地化层」⇒ 占位符组必须红
  //     （中文组**也**会红，因为中文案里同样留着 `{size}`，所以只判定占位符那条 ——
  //      用一个"本来就会红"的组去证明判据不空转是没有说服力的）。
  // 没红就说明本测试的判据是空转的，要在这里如实报出来。
  say("");
  const baseName = path.basename(CLIENT);
  const isNoLookup = /_sabotage-no-error-lookup/u.test(baseName);
  const isRawParams = /_sabotage-raw-params/u.test(baseName);
  const isControl = isNoLookup || isRawParams;
  say(
    `== 对照组模式：${isNoLookup ? "是（_sabotage-no-error-lookup.js）" : isRawParams ? "是（_sabotage-raw-params.js）" : "否（被测的是真 bundle）"} ==`,
  );
  if (isNoLookup) {
    if (zhWithHan.length === 0) {
      failures += 1;
      say("FAIL 对照组上「中文文案里确实有中文」竟然还是绿的 —— 判据空转，这条测试证明不了任何事");
    } else {
      say(`PASS 对照组上中文那一组如期变红（${zhWithHan.length} 个码回落成了英文兜底）—— 判据不是空转`);
      for (const row of zhWithHan.slice(0, 5)) say(`     ${row.code} → ${row.text}`);
    }
  }
  if (isRawParams) {
    if (leftovers.length === 0) {
      failures += 1;
      say("FAIL 对照组上「占位符全部被填掉」竟然还是绿的 —— 判据空转");
    } else {
      say(`PASS 对照组上「占位符全部被填掉」如期变红（${leftovers.length} 处残留 {x}）—— 判据不是空转`);
      for (const row of leftovers.slice(0, 5)) say(`     [${row.code}] ${row.text}`);
    }
    // 同一对照上「英文无中文」**照样绿** ⇒ 只断言英文侧什么都证明不了。
    if (enWithHan.length === 0) {
      say(`PASS 对照组上「英文文案里一个汉字都没有」**照样是绿的**（${hostCodes.length} 个码全绿）`);
      say("     ⇒ 只断言英文侧不含中文会空转：拆掉参数填充它也不会红。");
    }
  }
  if (!isControl) {
    say("（对照副本：test/_sabotage-no-error-lookup.js 与 test/_sabotage-raw-params.js，见 test/make-sabotage*.mjs）");
  }
}

say("");
say(`== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ==`);
say(failures === 0 ? "OK — 全部断言通过" : `FAIL — ${failures} 项断言失败`);
fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");
process.exit(failures === 0 ? 0 : 1);
