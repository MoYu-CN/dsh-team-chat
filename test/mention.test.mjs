/**
 * mention.test.mjs —— round5「聊天室里的 @ 只列成员」真跑验证（**只读插件源码**，不改插件）。
 * （原 `_r5-mention.mjs`，归位进 dsh-team-chat 的 `test/` 并参数化。）
 *
 * 用法：$env:ELECTRON_RUN_AS_NODE=1; $env:NODE_OPTIONS="--experimental-vm-modules"
 *       $env:DSH_APP_DIR="<安装根>/resources/app"
 *       & "<安装根>\DSH Desktop.exe" test/mention.test.mjs [client.js 路径]
 *
 * 不设 `DSH_APP_DIR` 时会试着自己反推安装根；全都拿不到就**打印说明并跳过**
 * （这一项要借安装目录里的官方 bundle 与 react，没有它们跑不了 —— 但不静默跳过）。
 * `[client.js 路径]` 不传就用本插件自己的 `lib/client.js`。
 *
 * 跑的是**官方真组件**，不是我的复述：
 *   · 官方 `@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js` 的
 *     `InputTriggerService` + `InputTriggerController`（真注册表、真菜单状态机）；
 *   · 插件真 `createMemberMentionSource`（真 onPick / 真 codec）；
 *   · 官方 `@deepseek-ai/dsh-client-ui-reference` 的**真 source 对象**——
 *     做法是把它当 `apply(ctx)` 跑一遍，从假的 ctx.effect 里把注册进
 *     注册表的那个对象截下来。于是候选行的形状（section / icon / id）
 *     全部来自官方代码本身，不是我照抄的。
 *
 * 六项：
 *   [解析] 待测文件解析通过（另见 parse-check 的对照组）
 *   [1] 房间视图：@ 的候选分组 = 只有成员源
 *   [2] 普通对话视图：官方源仍在（同一条流水线的对照）
 *   [3] 成员源照旧能选人，插进去的是**显示名**
 *   [4] 有病对照：不隐藏时官方源会露出来（证明判据会失败）
 *   [5] 有病对照：把菜单挂到别处 / 选择器写错时判据同样失败
 */
import fs from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { officialPkgDir, outFile, pluginFile, printSkipMissingApp, reactFile } from "./_harness.mjs";

/** 门控规则故意带的**自证标记** —— 插件侧与脚手架侧必须一致。 */
const GATE_MARKER = "[data-tc-mention-gate]";

/**
 * 从**被测文件自己的 CSS 模板串**里抠出带 GATE_MARKER 的三条规则。
 *
 * ⚠ 这一步是这套验证的要害：选择器**必须来自被测文件**，不能是 harness 自己
 * 抄一份常量 —— 抄常量的话，把插件里的选择器改坏、harness 照样全 PASS
 * （第一版就是这么写的，拿 `_r5-broken-client-nogate.js` 一跑就露馅了）。
 *
 * 抠法：先把整段 CSS 里的块注释（斜杠星号 … 星号斜杠）去掉 —— **不能按行过滤**：
 * 这个项目里的块注释常常以「星号斜杠 + 选择器 {」的形式收尾（同一行里
 * 注释和规则挨着），按行过滤会连选择器一起吃掉。
 * 再去掉注释后的 CSS 里按 marker 找规则，按 body 分三类。
 *
 * @param src - client.js 的源码。
 * @returns `{hide, show, backing}` —— 选择器数组；抠不到就是空数组（断言会红）。
 */
function parseGatingRules(src) {
  const m = /const TEAM_CHAT_CSS = `([\s\S]*?)`;/u.exec(src);
  if (m === null) return { hide: [], show: [], backing: [] };
  const css = m[1].replace(/\/\*[\s\S]*?\*\//gu, "");
  const hide = [];
  const show = [];
  const backing = [];
  for (const chunk of css.split("}")) {
    if (!chunk.includes(GATE_MARKER)) continue;
    const at = chunk.indexOf("{");
    if (at < 0) continue;
    const selector = chunk.slice(0, at).trim().replace(/\s+/gu, " ");
    const body = chunk.slice(at + 1).trim();
    if (selector === "" || body === "") continue;
    if (selector.includes("[data-menu-backing]")) backing.push(selector);
    else if (body.startsWith("display: none")) hide.push(selector);
    else show.push(selector);
  }
  return { hide, show, backing };
}

/**
 * `@deepseek-ai/dsh-client-store` 的**微替身**。
 *
 * 为什么不用真的那份：它是 ESM（`import { createStore } from "zustand/vanilla"`），
 * 而 zustand / immer 在本机 `node_modules` 里**根本没装**（它们是该包的
 * devDependencies）—— 直接 `import()` 会 ERR_MODULE_NOT_FOUND（已实测）。
 *
 * 替身覆盖的是官方 `createSnapshotStore` 的**整份公开面**
 * （store/lib/index.js:90-101）：getSnapshot / subscribe / set / update。
 * 输入触发流水线只用到四个快照 store 的 getSnapshot + set + subscribe
 * （`input-trigger/lib/client.js:347/353/360/371`）—— 语义（同步回声、
 * set 整值替换）与官方一致。**它不是被测对象**：被测的是注册表的过滤逻辑。
 */
function createSnapshotStore(init) {
  let state = init;
  const listeners = new Set();
  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set: (next) => {
      state = next;
      for (const fn of [...listeners]) fn(state);
    },
    update: (mutator) => {
      const draft = { ...state };
      mutator(draft);
      state = draft;
      for (const fn of [...listeners]) fn(state);
    },
  };
}

const APP = officialPkgDir();
const REACT = reactFile();
const CLIENT = process.argv[2] ?? pluginFile("client.js");
const OUT_FILE = outFile("r5-mention-output.txt");

if (APP === null || REACT === null) {
  printSkipMissingApp("「@ 只列成员」这一组（要借安装目录里的官方 input-trigger / reference bundle 与 react）");
  process.exit(0);
}

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
const checkTrue = (label, actual) => check(label, actual === true, true);

// ══════════════════════════════════════════════════════════════════
// 一、真模块加载：自定义 bundle 在沙箱里 require 到什么，由这里决定
// ══════════════════════════════════════════════════════════════════

/** 官方 bundle 里 `require(spec)` 的解析表。只放真货，缺什么就报出来。 */
function makeRequire(react, store, uiPrimitives, cordis) {
  return (spec) => {
    if (spec === "react") return react;
    if (spec === "react-dom") return { createPortal: () => null, createRoot: () => ({ render() {} }) };
    if (spec === "react/jsx-runtime" || spec === "react/jsx-dev-runtime") return makeJsxRuntime(react);
    if (spec === "@deepseek-ai/dsh-client-store") return store;
    if (spec === "@deepseek-ai/dsh-client-ui-primitives") return uiPrimitives;
    if (spec === "@deepseek-ai/cordis") return cordis;
    if (spec === "@deepseek-ai/dsh-client-locale") return { NS: "test" };
    throw new Error(`harness 没准备这个模块：${spec}`);
  };
}

/** jsx/jsxs 的真身：造出与 React 同形的元素对象（type/props/key）。 */
function makeJsxRuntime(react) {
  const el = (type, props, key) => react.createElement(type, props, ...childArgs(props));
  return { jsx: el, jsxs: el, Fragment: react.Fragment };
}
const childArgs = (props) => {
  const kids = props?.children;
  if (kids === undefined) return [];
  return Array.isArray(kids) ? kids : [kids];
};

/** 把一份 `window.__ModuleLoader__.load({id, factory})` 形态的 bundle 求值，返回 factory。 */
function loadBundle(file, requireFn, extraGlobals = {}) {
  const src = fs.readFileSync(file, "utf8");
  let captured = null;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    JSON,
    Math,
    Date,
    Promise,
    Error,
    TypeError,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Symbol,
    AbortController,
    ...extraGlobals,
    window: {
      __ModuleLoader__: {
        load(definition) {
          captured = definition;
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  if (captured === null) throw new Error(`bundle 没注册：${file}`);
  return { id: captured.id, factory: captured.factory, requireFn };
}

/** 取 bundle 的 exports。 */
function evaluate(file, requireFn, extraGlobals) {
  const { id, factory } = loadBundle(file, requireFn, extraGlobals);
  return { id, exports: factory(requireFn) };
}

// ══════════════════════════════════════════════════════════════════
// 二、迷你 CSS 选择器引擎（朴素右到左匹配，只实现报告里用到的那几种语法）
// ══════════════════════════════════════════════════════════════════

/** 解析一条选择器：按逗号切，每条切成 [{compound, combinator}]。 */
function parseSelector(text) {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      // 先按「组合器」切；组合器是 > 或空白。`:has(...)` 里的内容要先挖掉，
      // 免得它内部的 > 被当成分隔符 —— 用深度计扫。
      const pieces = [];
      let current = "";
      let depth = 0;
      for (let i = 0; i < part.length; i += 1) {
        const ch = part[i];
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        if (depth === 0 && (ch === ">" || ch === "+")) {
          // 先把前面的空白收掉：不收的话 current 是空串，
          // 会多出一个空复合片段，组合器的语义就丢了（harness 自己踩过）。
          if (current.trim() !== "") pieces.push({ compound: current.trim(), comb: ch === ">" ? "child" : "next" });
          current = "";
          continue;
        }
        if (depth === 0 && /\s/u.test(ch)) {
          if (current.trim() !== "") pieces.push({ compound: current.trim(), comb: "desc" });
          current = "";
          continue;
        }
        current += ch;
      }
      if (current.trim() !== "") pieces.push({ compound: current.trim(), comb: "desc" });
      return pieces;
    });
}

/** 把一个复合选择器拆成逐个简单选择器的判定函数。 */
function parseCompound(text) {
  const tests = [];
  let rest = text;
  let guard = 0;
  while (rest !== "" && guard < 64) {
    guard += 1;
    // ⚠ :has() 必须先判 —— 放在 tag 之后的话，「body:has(...)」会被 tag 正则
    // 先啃掉 "body"，剩下 ":has(...)" 再也匹配不上任何分支（harness 自己踩过）。
    const has = /^:has\((.*)\)/u.exec(rest);
    if (has !== null && rest.startsWith(":has(")) {
      // `:has()` 的相对选择器可以以 >（子）、+（紧邻兄弟）、~（后续兄弟）或
      // 什么都不写（后代）开头。三种都要支持 —— 只做前两种的话，
      // 「:has(+ X)」会静默返回 false（harness 自己踩过，表现是白名单整条失效）。
      const inner = has[1].trim();
      const direct = inner.startsWith(">");
      const nextSibling = inner.startsWith("+");
      const laterSibling = inner.startsWith("~");
      const sel = parseSelector(direct || nextSibling || laterSibling ? inner.slice(1).trim() : inner);
      tests.push((el) => {
        let pool;
        if (direct) pool = el.children;
        else if (nextSibling) {
          const at = el.parent?.children.indexOf(el) ?? -1;
          pool = at < 0 || el.parent.children[at + 1] === undefined ? [] : [el.parent.children[at + 1]];
        } else if (laterSibling) {
          const at = el.parent?.children.indexOf(el) ?? -1;
          pool = at < 0 ? [] : el.parent.children.slice(at + 1);
        } else pool = descendants(el);
        return pool.some((candidate) => sel.some((seq) => matchesSeq(candidate, seq)));
      });
      rest = rest.slice(has[0].length);
      continue;
    }
    const attr = /^\[([\w-]+)(?:([~^|*$]?=)"([^"]*)"|([~^|*$]?=)'([^']*)')?\]/u.exec(rest);
    if (attr !== null) {
      const name = attr[1];
      const op = attr[2] ?? attr[4];
      const value = attr[3] ?? attr[5];
      tests.push((el) => {
        const actual = el.attrs[name];
        if (actual === undefined) return false;
        if (op === undefined) return true;
        if (op === "=") return actual === value;
        if (op === "^=") return actual.startsWith(value);
        if (op === "*=") return actual.includes(value);
        if (op === "$=") return actual.endsWith(value);
        return false;
      });
      rest = rest.slice(attr[0].length);
      continue;
    }
    const cls = /^\.([\w-]+)/u.exec(rest);
    if (cls !== null) {
      const name = cls[1];
      tests.push((el) => el.classNames.includes(name));
      rest = rest.slice(cls[0].length);
      continue;
    }
    const tag = /^[A-Za-z][\w-]*/u.exec(rest);
    if (tag !== null) {
      const name = tag[0].toLowerCase();
      tests.push((el) => el.tag === name);
      rest = rest.slice(tag[0].length);
      continue;
    }
    if (rest.startsWith("*")) {
      tests.push(() => true);
      rest = rest.slice(1);
      continue;
    }
    throw new Error(`选择器片段解析不了：${rest}`);
  }
  return tests;
}

const descendants = (el) => {
  const out = [];
  const stack = [...el.children];
  while (stack.length > 0) {
    const node = stack.pop();
    out.push(node);
    stack.push(...node.children);
  }
  return out;
};

/** 一个复合选择器是否命中这个元素。 */
const matchesCompound = (el, text) => parseCompound(text).every((test) => test(el));

/** 一条序列（右到左）是否命中。 */
function matchesSeq(el, seq) {
  const last = seq[seq.length - 1];
  if (!matchesCompound(el, last.compound)) return false;
  let node = el;
  for (let i = seq.length - 2; i >= 0; i -= 1) {
    const step = seq[i + 1];
    const want = seq[i].compound;
    if (step.comb === "child") {
      node = node.parent;
      if (node === null || !matchesCompound(node, want)) return false;
    } else if (step.comb === "next") {
      const at = node.parent?.children.indexOf(node) ?? -1;
      node = at < 0 ? null : node.parent.children[at + 1];
      if (node === null || node === undefined || !matchesCompound(node, want)) return false;
    } else {
      let cursor = node.parent;
      let found = null;
      while (cursor !== null) {
        if (matchesCompound(cursor, want)) {
          found = cursor;
          break;
        }
        cursor = cursor.parent;
      }
      if (found === null) return false;
      node = found;
    }
  }
  return true;
}

/** `selector` 命中的全部元素。空选择器返回空数组（不许变成「匹配一切」）。 */
const queryAll = (root, selector) =>
  selector.trim() === "" ? [] : descendants(root).filter((el) => parseSelector(selector).some((seq) => matchesSeq(el, seq)));

// ══════════════════════════════════════════════════════════════════
// 三、迷你 DOM：从**真 React 元素树**（jsx 的产品）造出来
// ══════════════════════════════════════════════════════════════════

const DOM_TAGS = new Set([
  "div", "nav", "span", "button", "header", "main", "section", "ul", "li", "p", "aside", "body", "html", "style",
]);

function createEl(tag, props = {}) {
  const attrs = {};
  const classNames = [];
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") {
      String(value ?? "")
        .split(/\s+/u)
        .filter((name) => name !== "")
        .forEach((name) => classNames.push(name));
      continue;
    }
    if (key === "children") continue;
    if (typeof value === "string" || typeof value === "number") {
      const name = key === "htmlFor" ? "for" : key;
      if (/^(data-|aria-|id$|role$|style$)/u.test(name) || name.includes("-")) attrs[name] = String(value);
    }
  }
  return { tag: tag.toLowerCase(), attrs, classNames, children: [], parent: null, text: "" };
}

function append(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

/**
 * 把 React 元素树挂进真 DOM 形态。
 *
 * 元素（有 props.type）按 tag/attrs 建节点；**函数组件**当成透传
 * （本用例里只有图标组件，不产生布局节点）；字符串 = 文本，挂到最近元素的 text 上。
 */
function mount(parent, node) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) {
    for (const item of node) mount(parent, item);
    return;
  }
  if (typeof node === "string" || typeof node === "number") {
    parent.text += String(node);
    return;
  }
  if (typeof node !== "object") return;
  const type = node.type;
  if (typeof type === "function") {
    // 函数组件：真调一次拿它的产物（图标组件会返回 svg；真 html tag 不是函数）。
    mount(parent, type(node.props ?? {}));
    return;
  }
  if (typeof type !== "string") return;
  const tag = type.toLowerCase();
  if (!DOM_TAGS.has(tag)) {
    // 非 HTML 元素（如 Fragment / React.Fragment 的 symbol）→ 透传。
    mount(parent, node.props?.children);
    return;
  }
  const el = append(parent, createEl(tag, node.props ?? {}));
  mount(el, node.props?.children);
}

// ══════════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════════
try {
  const reactModule = await import(pathToFileURL(REACT).href);
  const react = reactModule.default ?? reactModule;
  const store = { createSnapshotStore };
  // 官方 ui-primitives 里的 relativeTime：官方 reference 源生成会话行时**真调**它，
  // 自己重写一份就等于「测自己的替身」。整个包 import 不了（它 import 一堆
  // .module.css，Node 不认那个扩展名），所以**把它那段源码抠出来求值** ——
  // 逻辑仍然是官方那一份，只是绕开了它进不来的那句 import。
  const primSource = fs.readFileSync(`${APP}/dsh-client-ui-primitives/lib/index.js`, "utf8");
  const relMatch = /function relativeTime\(at, now\) \{[\s\S]*?\n\}/u.exec(primSource);
  if (relMatch === null) throw new Error("抠不到官方 relativeTime 源码 —— 它改名/改形了，harness 需要跟着改");
  const primitives = {
    relativeTime: vm.runInNewContext(`(${relMatch[0]})`, { Math }, { filename: "ui-primitives:relativeTime" }),
    ReferenceIconRegular: () => null,
    IconChevronRightOutlineRegular: () => null,
    IconChevronLeftOutlineRegular: () => null,
    FileTypeIcon: () => null,
    MenuSurface: "div",
  };

  // 官方 cordis（真货）：先当 ESM 导进来，再翻译成自定义 bundle 的 require 形态。
  const cosmokitModule = await import(pathToFileURL(`${APP}/cosmokit/lib/index.js`).href);
  const cordisModule = await import(pathToFileURL(`${APP}/cordis/lib/index.js`).href);
  const cordis = { ...cordisModule, ...cosmokitModule };

  say(`react 版本：${react.version}`);
  say(`被测 client.js：${CLIENT}`);
  say(`createSnapshotStore：harness 微替身（真包 import 不到 zustand/immer，见文件头注释）`);
  say(`cordis.Service = ${typeof cordis.Service}`);
  say("");

  const requireFn = makeRequire(react, store, primitives, cordis);

  // ── ① 官方 input-trigger：真服务 + 真控制器 ────────────────────
  const triggerBundle = evaluate(`${APP}/dsh-client-ui-input-trigger/lib/client.js`, requireFn);
  say(`input-trigger bundle id = ${triggerBundle.id}`);
  const { InputTriggerService } = triggerBundle.exports;

  const sessionId = "sess-room-1";
  const sessionProjection = { sessionId };
  const sessionCtx = { effect: () => () => {}, on: () => () => {}, bail: () => false };
  const binding = { sessionId, session: sessionProjection, ctx: sessionCtx };
  /** 官方 reference 源在 `sessions.using(...)` 里读的那一份会话状态。 */
  const openSessionHandle = { binding: { session: { getSnapshot: () => ({ openState: "open" }) } } };
  const sessions = {
    sessionOf: () => sessionProjection,
    binding: () => binding,
    scope: () => sessionCtx,
    list: { getSnapshot: () => ({ byId: {} }) },
    using: async (id, req, fn) => fn(openSessionHandle),
  };
  const rootCtx = {
    on: () => () => {},
    get: (name) => (name === "sessions" ? sessions : undefined),
    reflect: { provide: () => {} },
    effect: () => () => {},
  };
  const service = new InputTriggerService(rootCtx, "inputTriggers");
  say(`InputTriggerService 就绪，name = ${service.name}`);

  // ── ② 插件真相：真 source 工厂 ────────────────────────────────
  const fetchCalls = [];
  const fakeFetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).startsWith("/__teamchat/team-members")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            members: [
              { name: "analyst", displayName: "数据员", sessionId: "sess-a", phase: "active", description: "看数据" },
              { name: "贝塔", sessionId: "sess-b", phase: "active", description: "写文案" },
            ],            removed: [],
          };
        },
      };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };

  const pluginBundle = loadBundle(CLIENT, requireFn, {
    fetch: fakeFetch,
    EventSource: class { close() {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: undefined,
  });
  say(`team-chat bundle id = ${pluginBundle.id}`);
  const plugin = pluginBundle.factory((spec) => {
    if (spec === "react") return react;
    if (spec === "react-dom") return { createPortal: () => null };
    throw new Error(`team-chat 要了没准备的模块：${spec}`);
  });
  say(`导出 createMemberMentionSource = ${typeof plugin.createMemberMentionSource}`);
  say(`导出 MENTION_SOURCE = ${plugin.MENTION_SOURCE}`);

  const t = (key) => (key === "members.mentionSection" ? "AI 成员" : key);
  const memberSource = plugin.createMemberMentionSource(t, () => {});
  say(`成员源：trigger=${memberSource.trigger} name=${memberSource.name} order=${memberSource.order} showGroupTitle=${memberSource.showGroupTitle}`);

  const offMember = service.registerSource(memberSource);

  // ── ③ 官方 reference 源：真 apply，截注册对象 ──────────────────
  let officialSource = null;
  const officialCtx = {
    effect: (fn) => {
      const disposer = fn();
      return () => disposer?.();
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    get: (name) => (name === "inputTriggers" ? service : name === "sessions" ? sessions : undefined),
    remote: {
      $host: { home: "C:/Users/x" },
      $on: () => () => {},
      fileReferences: { list: async () => ({ ok: true, value: [{ path: "src/app.ts", kind: "file" }, { path: "docs", kind: "directory" }] }) },
      sessionReferenceResolver: { candidates: async () => ({ ok: true, value: [{ sessionId: "sess-other", label: "别的对话", mention: "@别的对话", createdAt: Date.now(), sameWorkspace: true }] }) },
    },
    sidebarRight: { openResource: () => {} },
  };
  const originalRegister = service.registerSource.bind(service);
  service.registerSource = (src) => {
    officialSource = src;
    return originalRegister(src);
  };
  const refBundle = evaluate(`${APP}/dsh-client-ui-reference/lib/client.js`, requireFn);
  say(`ui-reference bundle id = ${refBundle.id}`);
  refBundle.exports.apply(officialCtx);
  service.registerSource = originalRegister;
  say(`官方源截获：trigger=${officialSource?.trigger} name=${officialSource?.name} order=${officialSource?.order ?? "(未写=0)"} showGroupTitle=${officialSource?.showGroupTitle}`);
  say(`注册表里的源：${service.live.sources.map((s) => `${s.trigger}${s.name}@${s.order ?? 0}`).join(" | ")}`);
  say("");

  // ── [1] 房间视图：@ 的候选分组 ────────────────────────────────
  //
  // ⚠ 这一条**必须**先如实报出「源是全局的、屏蔽不掉」这个前提：
  //   流水线的 roster 里 reference 一直在（这正是「官方没有按视图门控」的证据），
  //   真正把官方行挡在聊天室外面的只有下面那层 CSS。如果这里断言成
  //   「只有成员源」，那是在撒谎 —— 上一版 harness 就是这么写错的。
  const controller = service.sessionOf(sessionCtx);
  controller.track("@", 1, { tier: "open" }, 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const snapshot = controller.menu.getSnapshot();
  const groups = snapshot.groups.map((g) => ({ source: g.source, status: g.status, items: g.items.length }));
  say(`@ 菜单分组（流水线真实状态）：${JSON.stringify(groups)}`);
  check("[1] 前提：源是全局注册的，roster 里 reference 一直在（屏蔽不掉）", snapshot.groups.map((g) => g.source), [plugin.MENTION_SOURCE, "reference"]);
  check("[1] 成员源排在官方源前面（order -10 < 0）", snapshot.groups[0].source, plugin.MENTION_SOURCE);
  check("[1] 成员源那一组是真有行（不是空组关闭）", snapshot.groups[0]?.items.length > 0, true);
  checkTrue("[1] 菜单是开着的", snapshot.open);
  say(`     成员源那些行：${JSON.stringify(snapshot.groups[0]?.items.map((i) => i.name))}`);
  say(`     section 文案：${JSON.stringify([...new Set(snapshot.groups[0]?.items.map((i) => i.section))])}`);
  say(`     官方源那些行：${JSON.stringify(snapshot.groups[1]?.items.map((i) => i.name))}`);
  check("[1] 列名单只问宿主一次（同一会话有短缓存）", fetchCalls.filter((u) => u.startsWith("/__teamchat/team-members")).length, 1);
  say("");

  // ── [3] 成员源照旧能选人；插进去的是显示名 ────────────────────
  const picked = snapshot.groups[0].items.find((item) => item.name === "贝塔");
  const outcome = memberSource.onPick({ candidate: picked, session: sessionProjection, action: "pick", via: "menu" });
  say(`onPick(贝塔) → ${JSON.stringify(outcome)}`);
  check("[3] 芯片 label 是显示名", outcome?.insert?.label, "贝塔");
  check("[3] 芯片 ref 是 @成员标识", outcome?.insert?.ref, "@贝塔");
  check("[3] 芯片 source 是本插件", outcome?.insert?.source, plugin.MENTION_SOURCE);
  check("[3] codec.serialize 兜得住（官方提交时要用）", await memberSource.codec.serialize(outcome.insert.ref), "@贝塔");
  // 显示名 ≠ 成员标识的那一条：证明插进去的**不是** key
  const pickedAscii = snapshot.groups[0].items.find((item) => item.name === "数据员");
  const outcome2 = memberSource.onPick({ candidate: pickedAscii, session: sessionProjection, action: "pick", via: "menu" });
  say(`onPick(数据员) → ${JSON.stringify(outcome2)}`);
  check("[3] 显示名≠标识时，label 是显示名", outcome2?.insert?.label, "数据员");
  check("[3] 显示名≠标识时，ref 才是标识", outcome2?.insert?.ref, "@analyst");
  check("[3] 词典里显示名与标识都在（文本 @ 也认）", [...new Set(memberSource.lexicon(sessionProjection))].sort(), ["analyst", "数据员", "贝塔"]);
  say(`     词典 = ${JSON.stringify(memberSource.lexicon(sessionProjection))}`);
  say("");

  // ── [2]+[4] 视图判据：真菜单 DOM + 真选择器 ───────────────────
  const openState = snapshot;

  // 真 MenuView 不好直接调（没导出），所以按官方 MenuView 的**渲染契约**造 DOM：
  // 分组容器 [data-trigger-menu]，组标题/骨架 [data-source=...]，
  // 候选行 id=dsh-slash-option-<source>-<index>，section 标题 div。
  // 这些契约都在 input-trigger/lib/client.js 里逐行核过（见报告 ②）。
  const buildMenuDom = () => {
    const root = createEl("body");
    // ⚠ 这里**故意把自证标记补上**：插件里的选择器都带 [data-tc-mention-gate]，
    //   它存在的唯一目的就是让本脚手架能按标记把规则抠出来跑（生产 DOM 里没有它，
    //   所以那条附加条件永远不成立、规则也不会真的命中）。补上它，
    //   抠出来的选择器才能在这个假 DOM 上生效。
    const card = append(root, createEl("div", { "data-composer-card": "true", "data-tc-mention-gate": "" }));
    const anchor = append(card, createEl("div", { className: "uWtHQG_overlayAnchor" }));
    const menu = append(anchor, createEl("div", { className: "bqwvaa_menu", "data-trigger-menu": "" }));
    const viewport = append(menu, createEl("div", { className: "bqwvaa_viewport", role: "listbox" }));
    const backing = append(root, createEl("div", { "data-menu-backing": "" }));
    for (const group of openState.groups) {
      if (group.status === "ready" && group.items.length === 0) continue;
      if (group.showGroupTitle !== false && !group.items.some((item) => item.section !== undefined)) {
        append(viewport, createEl("div", { className: "bqwvaa_groupTitle", "data-source": group.source })).text = group.source;
      }
      group.items.forEach((item, index) => {
        if (item.section !== undefined && item.section !== group.items[index - 1]?.section) {
          append(viewport, createEl("div", { className: "bqwvaa_sectionTitle" })).text = item.section;
        }
        append(viewport, createEl("button", {
          id: `dsh-slash-option-${group.source}-${index}`,
          role: "option",
          className: "bqwvaa_item",
        })).text = item.label ?? item.name;
      });
    }
    return { root, card, menu, viewport, backing };
  };

  // ⚠ 选择器**从被测文件里抠**，不是 harness 自己抄一份常量。
  //   抄常量的话，把插件选择器改坏、harness 照样全 PASS（第一版就是这么翻车的）。
  const gating = parseGatingRules(fs.readFileSync(CLIENT, "utf8"));
  say(`从被测文件抠出的门控规则：`);
  say(`  hide  = ${JSON.stringify(gating.hide)}`);
  say(`  show  = ${JSON.stringify(gating.show)}`);
  say(`  backing = ${JSON.stringify(gating.backing)}`);
  const HIDE_SEL = gating.hide.join(", ");
  const SHOW_SEL = gating.show.join(", ");
  const BACKING_SEL = gating.backing.join(", ");
  checkTrue("[判据来源] 从文件里抠到了 hide 规则", gating.hide.length > 0);
  checkTrue("[判据来源] 从文件里抠到了 show 规则", gating.show.length > 0);
  checkTrue("[判据来源] 从文件里抠到了背板规则", gating.backing.length > 0);
  // 结构自检：门控必须**作用在「那张卡片里装着成员栏」**这个条件上。
  // 少了这组，把锚点从 .tc-members 改成别的类名时，抠出来的规则会只剩
  // 一个空壳选择器（或空数组），而空数组被 queryAll 当成「匹配 0 个」⇒
  // 那几条「官方行被藏住」的断言会**因为谁都匹配不上而误绿**。
  checkTrue("[判据结构] hide 规则带 > .tc-members 锚点", gating.hide.some((sel) => sel.includes(":has(> .tc-members)")));
  checkTrue("[判据结构] show 规则都带 > .tc-members 锚点", gating.show.length > 0 && gating.show.every((sel) => sel.includes(":has(> .tc-members)")));
  checkTrue("[判据结构] backing 规则带 > .tc-members 锚点", gating.backing.length > 0 && gating.backing.every((sel) => sel.includes("> .tc-members")));
  check("[判据结构] 门控规则共 4 条（1 藏 + 2 放行 + 1 背板）", gating.hide.length + gating.show.length + gating.backing.length, 4);

  /** 把「先全藏、再放行成员行」两条规则叠起来，算出一个节点最终是否可见。 */
  const visibleIn = (root) => {
    const hidden = new Set(queryAll(root, HIDE_SEL));
    for (const el of queryAll(root, SHOW_SEL)) hidden.delete(el);
    return (el) => !hidden.has(el);
  };

  // 场景 A：停在聊天室 —— composer 卡片里直接装着成员栏（.tc-members，带一个成员胶囊）
  const roomDom = buildMenuDom();
  const roomBody = roomDom.root;
  append(roomDom.card, createEl("div", { className: "tc-root" }));
  const memberBar = append(roomDom.card, createEl("div", { className: "tc-members" }));
  append(memberBar, createEl("span", { className: "tc-member-chip" })).text = "数据员";
  const roomHidden = queryAll(roomBody, HIDE_SEL).filter((el) => !queryAll(roomBody, SHOW_SEL).includes(el));
  const roomBacking = queryAll(roomBody, BACKING_SEL);
  const roomVisibleRows = descendants(roomDom.viewport)
    .filter((el) => el.attrs.role === "option")
    .filter(visibleIn(roomBody))
    .map((el) => el.text);
  say(`[场景A 聊天室] 菜单里全部节点 = ${descendants(roomDom.viewport).length}`);
  say(`[场景A 聊天室] 被藏起来的节点 = ${JSON.stringify(roomHidden.map((el) => el.attrs.id ?? el.classNames.join(".")))}`);
  say(`[场景A 聊天室] 仍然可见的节点 = ${JSON.stringify(descendants(roomDom.viewport).filter(visibleIn(roomBody)).map((el) => el.attrs.id ?? el.classNames.join(".")))}`);
  say(`[场景A 聊天室] 仍然可见的候选行 = ${JSON.stringify(roomVisibleRows)}`);
  say(`[场景A 聊天室] 背板命中 = ${roomBacking.length}`);
  check("[1] 官方 reference 那 3 行全被藏住", roomHidden.filter((el) => (el.attrs.id ?? "").startsWith("dsh-slash-option-reference-")).length, 3);
  // 菜单里一共 3 个 sectionTitle：1 个是我们的（在成员行前），2 个是官方的（在官方行前）。
  check("[1] 官方那 2 个 section 标题（子智能体 / 对话）也被藏住", roomHidden.filter((el) => el.classNames.includes("bqwvaa_sectionTitle")).length, 2);
  check("[1] 白名单没放行官方源的行", queryAll(roomBody, SHOW_SEL).filter((el) => !((el.attrs.id ?? "").startsWith("dsh-slash-option-team-members-") || el.classNames.includes("bqwvaa_sectionTitle"))).length, 0);
  check("[1] 成员行的 section 标题（AI 成员）被放回来", queryAll(roomBody, SHOW_SEL).filter((el) => el.classNames.includes("bqwvaa_sectionTitle")).length, 1);
  check("[1] 房间视图里剩下的可见行**全是成员**", [...roomVisibleRows].sort(), ["数据员", "贝塔"].sort());
  check("[1] 背板也一起收掉（不会留一块空色块）", roomBacking.length, 1);

  // 场景 B：普通对话 —— 同一个卡片里没有成员栏
  const plainDom = buildMenuDom();
  const plainHidden = queryAll(plainDom.root, HIDE_SEL);
  const plainBacking = queryAll(plainDom.root, BACKING_SEL);
  const plainVisibleRows = descendants(plainDom.viewport).filter((el) => el.attrs.role === "option").map((el) => el.text);
  say(`[场景B 普通对话] 被隐藏的节点 = ${plainHidden.length}`);
  say(`[场景B 普通对话] 可见候选行 = ${JSON.stringify(plainVisibleRows)}`);
  check("[2] 普通对话视图：一条隐藏规则都没命中", plainHidden.length, 0);
  check("[2] 普通对话视图：官方文件/对话行仍在", [...plainVisibleRows].sort(), ["数据员", "贝塔", "app.ts", "docs/", "别的对话"].sort());
  check("[2] 普通对话视图：背板不动", plainBacking.length, 0);

  // ── [4][5] 有病对照：判据必须会失败 ───────────────────────────
  say("");
  say("── 有病对照（证明上面这些 PASS 不是空转）──");
  // 对照 1：把门控去掉（= 没实现门控时的状态）→ 房间视图里官方行必须露出来
  const noGate = descendants(roomDom.viewport).filter((el) => el.attrs.role === "option").map((el) => el.text);
  check("[4] 不门控时房间视图里官方行会露出来（5 行）", noGate.length, 5);
  checkTrue("[4] 不门控时官方行确实在（含 app.ts）", noGate.includes("app.ts") && noGate.includes("别的对话"));
  // 对照 2：把作用域锚点写错（.tc-memberss）→ 官方行一行都藏不住
  const typoVisible = descendants(roomDom.viewport)
    .filter((el) => el.attrs.role === "option")
    .filter((el) => !queryAll(roomBody, '[data-composer-card]:has(> .tc-memberss) [data-trigger-menu] *').includes(el))
    .map((el) => el.text);
  check("[5] 锚点写错时可见行又变回 5 行（判据会失败）", typoVisible.length, 5);
  // 对照 3：成员栏不在 composer 卡片里（挂到 body 上）→ 也一行都藏不住
  const outsideDom = buildMenuDom();
  append(outsideDom.root, createEl("div", { className: "tc-root" }));
  const outsideHost = append(outsideDom.root, createEl("div", { className: "tc-members" }));
  checkTrue("[5] 成员栏不在卡片里（挂 body 上）", outsideHost.parent === outsideDom.root);
  check("[5] 那么一条隐藏规则都不命中", queryAll(outsideDom.root, HIDE_SEL).length, 0);
  // 对照 4：把白名单**整条写坏**（作用域锚点写错）→ 可见行必须变回 5 行
  // （「白名单前缀写错」不构成失败：全藏规则仍生效，可见 2 行 —— 那是对的，不是判据失效）
  const brokenWhitelist = descendants(roomDom.viewport)
    .filter((el) => el.attrs.role === "option")
    .filter((el) => !queryAll(roomBody, '[data-composer-card]:has(> .tc-memberz) [data-trigger-menu] [id^="dsh-slash-option-team-members-"]').includes(el))
    .filter((el) => !queryAll(roomBody, '[data-composer-card]:has(> .tc-memberz) [data-trigger-menu] *').includes(el))
    .map((el) => el.text);
  check("[5] 白名单整条写坏时官方行会露出来（判据会失败）", brokenWhitelist.length, 5);
  say("");

  // ── 副作用检查：成员源能正常注销 ──────────────────────────────
  offMember();
  check("成员源注销后注册表只剩官方源", service.live.sources.map((s) => s.name), ["reference"]);
  say(`列名单请求过宿主：${JSON.stringify(fetchCalls)}`);

  // ── 解析检查（同一条命令的另一半在 parse-check.mjs） ──────────
  say("");
  const src = fs.readFileSync(CLIENT, "utf8");
  let parseOk = true;
  try {
    new vm.Script(src, { filename: CLIENT });
  } catch (error) {
    parseOk = false;
    say(`script 解析失败：${error.message}`);
  }
  if (typeof vm.SourceTextModule === "function") {
    try {
      new vm.SourceTextModule(src, { identifier: CLIENT });
    } catch (error) {
      parseOk = false;
      say(`module 解析失败：${error.message}`);
    }
  }
  checkTrue("解析：待测 client.js 通过", parseOk);
  // CSS 模板串完整性（反引号提前终结那条坑）
  const m = /const TEAM_CHAT_CSS = `([\s\S]*?)`;/u.exec(src);
  check("CSS 模板串里没有裸反引号", m === null ? "找不到模板" : (m[1].match(/`/gu) ?? []).length, 0);
  checkTrue("CSS 模板串里含新的隐藏规则", m !== null && m[1].includes('dsh-slash-option-team-members-'));
  checkTrue("CSS 模板串里含「先全藏」那条", m !== null && m[1].includes("[data-trigger-menu] * { display: none; }"));
  checkTrue("CSS 模板串里含作用域锚点 > .tc-members", m !== null && m[1].includes(":has(> .tc-members)"));
  checkTrue("CSS 模板串里含背板规则", m !== null && m[1].includes("[data-menu-backing]"));
} catch (error) {
  failures += 1;
  say("");
  say(`!! 跑挂了：${error?.stack ?? error}`);
}

say("");
say(failures === 0 ? "全部 PASS" : `有 ${failures} 项 FAIL`);
fs.writeFileSync(OUT_FILE, `${lines.join("\n")}\n`, "utf8");
console.log(lines.join("\n"));
process.exit(failures === 0 ? 0 : 1);
