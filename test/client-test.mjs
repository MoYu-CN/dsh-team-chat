/**
 * 客户端 bundle 的真跑冒烟测试（**只读**，不动插件）。
 *
 * 做法：把 `lib/client.js` 当经典脚本丢进一个 vm 上下文，给它一个假的
 * `window.__ModuleLoader__` 把 factory 截下来，再用**真的 react 18.3.1**
 * （取自 DSH 安装目录）执行 factory。
 *
 * 证明了什么：
 *   1. 这份 browser bundle 能加载、能注册、能求值（不是只有语法对）
 *   2. 导出的纯函数真的能跑（`rosterOf` 主智能体排第一 / `blocksToText`）
 *   3. `Bubble` 真的能渲染，且正文的 Markdown 渲染结构 = 真元素树
 *      （表格 → `tc-md-table`，粗体 → `<strong>`，行内代码 → `tc-md-code`）
 *   4. 正文里的 HTML 源码**不进 DOM**（只以字符串形式存在），
 *      `javascript:` 不给 `href`，渲染器抛错时退回纯文本 `<span>`
 *
 * 没证明什么：新加的那个「设为主智能体」开关**没有**被渲染验证
 * （`MemberEditor` 不在导出面里，见报告「没做/做不到的」）。
 *
 * ── 退役记录（2026-10-12）────────────────────────────────────────────
 * 退役两条断言：
 *   「消息正文是**纯文本**（表格源码原样输出）」
 *   「标点没被解析成 DOM（仍是源码）」
 * 退役理由：这两条的基准已经过期。它们断言 `className === "tc-bubble-text"`
 *   的节点 children 是**字符串**、且逐字等于 Markdown 源码；而正文自
 *   Markdown 渲染落地起，同一个节点的 className 就是
 *   `"tc-bubble-text tc-md"`，children 是元素数组。按字符串全等找节点
 *   直接找不到 → 拿到 `undefined` → 两条永久红。
 *   **不是产品缺陷**（表格确实渲染成了 `tc-md-table`），是断言基准没跟着改；
 *   长期红着会掩盖真信号，所以退役，换成下面这组按**当前真实行为**写的断言
 *   （见 `renderMarkdownBody` → `mdRender` / `mdRenderTable`）。
 * 被退役断言的原位置：旧版 127~128 行。
 * 替代物不是「删掉」：新断言每一组都用**故意改坏 bundle 的对照组**证明过会红
 *   （见报告「新断言能失败」）。
 *
 * 用法：node test/client-test.mjs [要测的 client.js 路径]
 *   默认测**本插件自己的** client.js（由 `import.meta.url` 反推，不写死路径）。
 *   传第 1 个参数可指向**故意改坏的副本** —— 用来证明断言不是空转，例如：
 *     node test/client-test.mjs test/_sabotage-raw-html.js
 *
 * ## 需要什么
 * 这一份要借 DSH 安装目录里的**真 react 18.3.1**（客户端 bundle 的 factory
 * 只有喂了真 react 才跑得起来）。安装根按 `DSH_APP_DIR` → `DSH_INSTALL_DIR` →
 * 由 `process.execPath` 反推 → 常见默认位置 的顺序找；**全都拿不到时打印说明并退出 0
 * （标成 SKIP），不静默跳过。**
 * 输出落盘位置由 `DSH_TEST_OUT_DIR` 决定（不设就写系统临时目录，**绝不往仓库里写**）。
 */
import fs from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { outFile, pluginFile, printSkipMissingApp, reactFile } from "./_harness.mjs";

const CLIENT = process.argv[2] ?? pluginFile("client.js");
const REACT = reactFile();
const OUT_FILE = outFile("client-test-output.txt");

if (REACT === null) {
  printSkipMissingApp("client-test.mjs（要借安装目录里的真 react 执行客户端 bundle 的 factory）");
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

/** 把 React 元素树摊平成元素数组（元素本身 + 全部后代）。元素是**真对象**，
 *  保留 type / props / children，断言才拿得到 `props.children`。 */
const walk = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return out;
  }
  if (node.props !== undefined) {
    out.push(node);
    walk(node.props.children, out);
  }
  return out;
};

/** 取 className（字符串形式，子串匹配对单类名和组合类名都成立）。 */
const cls = (node) => (typeof node?.props?.className === "string" ? node.props.className : "");

/** 只在元素里递归收集**字符串**叶子（= 真正会落进 DOM 的文本）。 */
const texts = (node, out = []) => {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) texts(item, out);
    return out;
  }
  if (node.props !== undefined) texts(node.props.children, out);
  return out;
};

/** 一个元素里的全部文本拼起来 —— 行内渲染有时给字符串、有时给数组。 */
const plainText = (node) => texts(node).join("");

/**
 * 递归收集任何「会把字符串当 HTML 解释」的 prop 名。
 *
 * ⚠ 这一条是必需的，不是锦上添花：用 `dangerouslySetInnerHTML` 塞进去的
 * HTML **不会**在元素树里变成子元素（React 只在真渲染时展开它），
 * 所以光数 `<script>` 元素是**测不出来的** —— 对照组
 * `_sabotage-raw-html.js` 就曾经让「安全」断言全绿。必须直接查 prop。
 */
const htmlSinks = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) htmlSinks(item, out);
    return out;
  }
  if (node.props !== undefined) {
    for (const key of Object.keys(node.props)) {
      if (/dangerouslySetInnerHTML|innerHTML|outerHTML|__html|srcdoc/iu.test(key)) out.push(key);
      htmlSinks(node.props[key], out);
    }
    htmlSinks(node.props.children, out);
  }
  return out;
};

/** 取 Bubble 渲染树里那个**正文容器**：className 正好含 tc-md 的那个 div。 */
const bodyOf = (tree) =>
  walk(tree).find((node) => node.type === "div" && cls(node).split(/\s+/u).includes("tc-md"));

const bubbleOf = (exportsObj, text) =>
  exportsObj.Bubble({
    entry: {
      id: "e1",
      senderName: "alpha",
      blocks: [{ type: "text", text }],
      at: "2026-10-09T00:00:00.000Z",
      targetNames: ["lead"],
      delivered: true,
    },
    t: (key) => key,
    members: { alpha: { displayName: "阿尔法" } },
    duties: {},
    grouped: false,
  });

try {
  const react = (await import(pathToFileURL(REACT).href)).default;
  say(`react 版本：${react.version}`);
  say(`被测 client.js：${CLIENT}`);

  const src = fs.readFileSync(CLIENT, "utf8");
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
  vm.runInContext(src, sandbox, { filename: CLIENT });

  if (captured === null) {
    say("FAIL factory 没有注册（__ModuleLoader__.load 没被调用）");
    failures += 1;
  } else {
    say(`注册 id = ${captured.id}`);
    const exportsObj = captured.factory((spec) => {
      if (spec === "react") return react;
      if (spec === "react-dom") return { createPortal: () => null };
      throw new Error(`测试没准备这个模块：${spec}`);
    });

    check("VIEW_ID", exportsObj.VIEW_ID, "team-chat");
    check("apply 是函数", typeof exportsObj.apply, "function");
    check("Bubble 是函数", typeof exportsObj.Bubble, "function");

    // ── 导出的纯函数真跑一次 ────────────────────────────────
    const roster = exportsObj.rosterOf([
      { name: "beta", displayName: "贝塔" },
      { name: "alpha", displayName: "阿尔法", isLead: true },
    ]);
    check("rosterOf：主智能体排第一", roster.map((row) => row.key), ["alpha", "beta"]);
    check("rosterOf：isLead 如实带出", roster.map((row) => row.isLead), [true, false]);
    check("blocksToText", exportsObj.blocksToText([{ type: "text", text: "hi" }]), "hi");

    // ══════════════════════════════════════════════════════════
    // ① 正文容器：Markdown 走**真元素树**那条路
    // ══════════════════════════════════════════════════════════
    const tableSource = "| 名称 | 值 |\n| --- | --- |\n| a | **1** |";
    const tableTree = bubbleOf(exportsObj, tableSource);
    const body = bodyOf(tableTree);
    const nodes = walk(tableTree);

    say("");
    say("Bubble 渲染树里那个正文容器：");
    say(`   tag = ${body?.type}   className = ${JSON.stringify(cls(body))}`);
    say(`   props.children 类型 = ${typeof body?.props?.children}（${Array.isArray(body?.props?.children) ? "数组" : "单个值"}）`);

    check("正文容器是 div 且带 tc-bubble-text + tc-md", cls(body), "tc-bubble-text tc-md");
    check("正文容器 children 是元素数组（不是源码字符串）", Array.isArray(body?.props?.children), true);
    // 反向断言：旧基准要的「纯文本 span」不许再出现 —— 这一条就是退役旧断言的替代。
    check("正文容器不是「纯文本字符串」那条退化路径", typeof body?.props?.children === "string", false);

    // ══════════════════════════════════════════════════════════
    // ② GFM 表格 → 真 <table> 结构（不是源码）
    // ══════════════════════════════════════════════════════════
    const countOf = (list, predicate) => list.filter(predicate).length;
    const cells = nodes.filter((node) => cls(node) === "tc-md-td");
    check("表格渲染成 tc-md-table", countOf(nodes, (node) => cls(node) === "tc-md-table"), 1);
    check("表格里有 thead/tbody 各一", [
      countOf(nodes, (node) => node.type === "thead"),
      countOf(nodes, (node) => node.type === "tbody"),
    ], [1, 1]);
    check("单元格数 = 表头 2 + 数据 2", cells.length, 4);
    check("表头单元格是 <th>", countOf(cells, (node) => node.type === "th"), 2);
    check("数据单元格是 <td>", countOf(cells, (node) => node.type === "td"), 2);
    check("表头文字 = 名称/值", cells.filter((node) => node.type === "th").map(plainText), ["名称", "值"]);
    check("表格源码没有被当成普通段落", countOf(nodes, (node) => node.type === "p"), 0);

    // ══════════════════════════════════════════════════════════
    // ③ 行内：粗体 → <strong>，行内代码 → tc-md-code
    // ══════════════════════════════════════════════════════════
    const boldText = "重点1";
    const codeText = "npm run build";
    const inlineTree = bubbleOf(exportsObj, `**${boldText}** 和 \`${codeText}\``);
    const inlineNodes = walk(inlineTree);
    const strong = inlineNodes.find((node) => node.type === "strong");
    const code = inlineNodes.find((node) => cls(node) === "tc-md-code");
    check("粗体渲染成 <strong>", strong !== undefined, true);
    check("粗体文字落在 <strong> 里", plainText(strong), boldText);
    check("行内代码渲染成 <code class=tc-md-code>", code?.type, "code");
    check("行内代码文字落在 <code> 里", code?.props?.children, codeText);

    // ══════════════════════════════════════════════════════════
    // ④ 安全：源码里的 HTML **没被解析成 DOM**
    //    正文是「动态文本」，React 只会把它当字符串塞进文本节点；
    //    这里断言的就是这件事（不是靠肉眼看着像）。
    // ══════════════════════════════════════════════════════════
    const injection =
      'HTML 源码：<script>alert("xss")</script> 和 <img src=x onerror="alert(2)"> 以及 <b>粗体源码</b>';
    const injectTree = bubbleOf(exportsObj, injection);
    const injectNodes = walk(injectTree);
    check("注入串里没有任何 <script> 元素", countOf(injectNodes, (node) => node.type === "script"), 0);
    check("注入串里没有任何 <img> 元素（onerror 无从触发）", countOf(injectNodes, (node) => node.type === "img"), 0);
    check("注入串里的 <b> 源码没变成 <b> 元素", countOf(injectNodes, (node) => node.type === "b"), 0);
    check("注入串整串以**字符串**形式存在（React 会转义）", texts(injectTree).includes(injection), true);
    // 上面 4 条只证明「元素树里没有注入出来的元素」；下面这条才是真闸门：
    // 树里根本不许有把字符串当 HTML 解释的 prop。
    check("整棵树里没有任何 dangerouslySetInnerHTML / innerHTML 之类的 HTML 通道", htmlSinks(injectTree), []);

    // ══════════════════════════════════════════════════════════
    // ⑤ 安全：javascript: 目标不给 href
    // ══════════════════════════════════════════════════════════
    const jsTree = bubbleOf(exportsObj, "[点我](javascript:alert(1))");
    const jsNodes = walk(jsTree);
    check("javascript: 链接不给 <a>", jsNodes.find((node) => node.type === "a"), undefined);
    check("整棵树里没有任何 href", countOf(jsNodes, (node) => node.props?.href !== undefined), 0);

    // ══════════════════════════════════════════════════════════
    // ⑥ 降级路径还在：渲染器抛错 ⇒ 退回纯文本，且异常要上报
    // ══════════════════════════════════════════════════════════
    const degraded = exportsObj.renderMarkdownBody("| a |\n| --- |\n| b |", () => {
      throw new Error("测试故意让渲染器抛错");
    });
    check("降级产物是 span", degraded?.type, "span");
    check("降级产物是纯文本 tc-bubble-text", degraded?.props?.className, "tc-bubble-text");
    check("降级产物里放着原文（消息照样看得见）", degraded?.props?.children, "| a |\n| --- |\n| b |");
    check("降级产物里没有元素子节点（没把正文当结构）", walk(degraded).length, 1);

    say("");
    say(`Bubble 一共渲染出 ${nodes.length} 个带 props 的节点，类名依次是：`);
    say("   " + nodes.map((node) => cls(node)).join(", "));
  }
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
