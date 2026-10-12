/**
 * chan-member-frame.test.mjs —— 「成员面板边框包不住内容」这条缺陷的**静态**回归断言。
 *
 * ## 它测的是什么缺陷
 * 用户原话：「添加 AI 群员那里，它的外框没有完全；包括编辑框；
 * 在「设为主智能体」到「返回列表」那一栏，没有被边框包住。」
 *
 * 拆成两个可静态判定的问题：
 *   A. **结构**：「设为主智能体」那一行与「返回列表」那个按钮，
 *      在不在带边框的容器（`.tc-panel`）的**子树**里？
 *      若它们是旁支（渲染在容器之外），那是 DOM 层级错，改 CSS 没用。
 *   B. **CSS**：带边框的容器（`.tc-panel`，`max-height: min(70vh, 520px)`）
 *      有没有**滚动/裁剪**机制（`overflow(-y)`）？
 *      没有的话内容会**画出边框之外** —— `overflow` 初始值是 `visible`，
 *      内容高于 `max-height` 时不裁剪、不滚、不缩，直接盖到面板外面，
 *      肉眼看就是「外框没把内容包住」。
 *
 * ## 为什么是**源码级**而不是渲染级
 * 本机拿不到 `react-dom`（安装目录 `resources/app/node_modules` 里只有 `react`，
 * `react-dom` 只存在于 Electron 主包里，取不到），而 `AddMemberForm` /
 * `MemberEditor` / `MembersPanel` **都不在导出面**上 —— 没法像
 * `client-test.mjs` 调用 `Bubble()` 那样把它们的元素树渲染出来。
 * 所以退一步：对**真源码**做词法级配平括号解析，取出这两个表单的
 * `react.createElement` 调用块，再断言这一块**覆盖了**哪些元素。
 * 断言对象是「构建这一层元素树的源代码」，不是「已求值的 React 元素」。
 *
 * ⚠ 诚实标注：这**证明不了像素**。溢出与否还取决于真实字号与换行，
 *   最终只有用户肉眼能判。这里只证明「结构包含」+「CSS 有滚动机制」。
 *
 * ## 这条测试**能失败**（不是空转）
 * 断言 ④「max-height 容器有滚动机制」在**未修复**的 client.js 上实测为 FAIL
 * （见报告 ④ 的两次原始输出）。对照组做法：把候选补丁写进一份**副本**再跑一遍。
 *
 * ## 用法
 *   <node|"DSH Desktop.exe"> chan-member-frame.test.mjs [被测 client.js 路径]
 *   不给参数时按 `import.meta.url` 反推：`<本文件目录>/../lib/client.js`
 *   （放进插件 `test/` 后即自动指向本插件自己的 lib）。
 *
 * 输出落盘：`DSH_TEST_OUT_DIR` 设了就写那儿，否则写系统临时目录（绝不往仓库里写）。
 * 退出码：0 = 全部断言通过；1 = 有断言失败（含 EXCEPTION）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ───────────────────────── 被测文件 ─────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(process.argv[2] ?? path.join(here, "..", "lib", "client.js"));

const outDir = (() => {
  const given = process.env.DSH_TEST_OUT_DIR;
  if (given !== undefined && given.trim() !== "") return path.resolve(given);
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-frame-test-out-"));
})();
fs.mkdirSync(outDir, { recursive: true });
const OUT_FILE = path.join(outDir, "chan-member-frame-output.txt");

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

// ───────────────────────── 词法层：跳过字符串 / 注释 / 模板串 ─────────────────────────
//
// 不做这一步会踩坑：源码注释里含成对的 `（ ）`，正则字面量里也有括号。
// 朴素地「数到第一个配平括号」会被提前收尾，取出的块不含真正子节点，
// 于是断言恒真（假绿）。所以先做一层真词法。

/** 跳过字符串字面量（含转义）；返回闭引号下标。 */
function skipQuoted(src, i, q) {
  for (i += 1; i < src.length; i += 1) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (src[i] === q) return i;
  }
  return src.length - 1;
}

/** 跳过模板串，含 `${}` 内嵌套。 */
function skipTemplate(src, i) {
  for (i += 1; i < src.length; i += 1) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (src[i] === "`") return i;
    if (src[i] === "$" && src[i + 1] === "{") {
      const inner = readBalanced(src, i + 1, "{", "}");
      if (inner !== null) i = inner.end - 1;
    }
  }
  return src.length - 1;
}

/**
 * 斜杠后面是正则字面量还是除号？用「上一个有意义字符」判：
 * 前一字符是 标识符/数字/`)`/`]`/`}`/引号 ⇒ 除号；否则（`=`、`(`、`,`、`:`…）⇒ 正则。
 */
function slashStartsRegex(src, i) {
  for (let j = i - 1; j >= 0; j -= 1) {
    const c = src[j];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") continue;
    return !/[A-Za-z0-9_$)\]}"'`]/u.test(c);
  }
  return true;
}

/** 跳过正则字面量（含字符类与转义）。 */
function skipRegex(src, i) {
  let inClass = false;
  for (i += 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "\n") return i - 1; // 正则不跨行 ⇒ 这不是正则
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
  }
  for (i += 1; i < src.length; i += 1) {
    if (!/[a-z]/iu.test(src[i])) break;
  }
  return i - 1;
}

/**
 * 从 `src[i]` 读一对配平括号，返回 `{ inner, end }`（`end` 指向闭括号之后）。
 * 字符串 / 注释 / 模板串 / 正则一律跳过。
 */
function readBalanced(src, i, open, close) {
  if (src[i] !== open) return null;
  let depth = 0;
  const start = i + 1;
  for (; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === "/" && next === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? src.length : e;
      continue;
    }
    if (c === "/" && next === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    if (c === "/" && slashStartsRegex(src, i)) {
      i = skipRegex(src, i);
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return { inner: src.slice(start, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * 取 `function <name>(...) { ... }` 的**函数体**大括号块。
 *
 * ⚠ 必须**先跳过形参表**：本插件这几个组件都写成 `function X({ a, b }) {`，
 *   形参里的 `{` 也是大括号 —— 直接 `indexOf("{")` 会取到**形参表**，
 *   块里只有 `sessionId,\n t,…`（实测：体长 104 字符），后续断言全部假绿。
 */
function functionBody(src, name) {
  const head = src.indexOf(`function ${name}(`);
  if (head < 0) return null;
  const parenOpen = src.indexOf("(", head);
  if (parenOpen < 0) return null;
  const params = readBalanced(src, parenOpen, "(", ")");
  if (params === null) return null;
  const braceOpen = src.indexOf("{", params.end);
  if (braceOpen < 0) return null;
  const body = readBalanced(src, braceOpen, "{", "}");
  if (body === null) return null;
  return { inner: body.inner, end: body.end, braceOpen, paramsEnd: params.end };
}

/**
 * 取函数体里 `.className = "值"` 那个元素的外层 `react.createElement(...)` 实参块。
 * 返回 `{ inner, relStart, relEnd }`（偏移相对函数体开头）。
 */
function elementBlock(body, classNameValue) {
  const needle = `className: "${classNameValue}"`;
  const at = body.indexOf(needle);
  if (at < 0) return null;
  const callAt = body.lastIndexOf("react.createElement(", at);
  if (callAt < 0) return null;
  const parenOpen = body.indexOf("(", callAt);
  const block = readBalanced(body, parenOpen, "(", ")");
  if (block === null) return null;
  return { inner: block.inner, relStart: callAt, relEnd: block.end };
}

/** `t("key")` 在块里出现几次。 */
const keyCount = (block, key) => block.split(`t("${key}")`).length - 1;

/** 块里 `createElement("tag"` / 多行形态 `createElement(\n "tag"` 各出现几次。 */
const tagCount = (block, tag) =>
  [...block.matchAll(/createElement\(\s*"(\w+)"/gu)].filter((m) => m[1] === tag).length;

/** 块里 `className: "值"` 出现几次。 */
const classCount = (block, value) => block.split(`className: "${value}"`).length - 1;

/** 块里的标签名清单（去重、保持出现顺序）。 */
const tagList = (block) => [...new Set([...block.matchAll(/createElement\(\s*"(\w+)"/gu)].map((m) => m[1]))];

/** 从 CSS 模板串里取一条规则的声明体。 */
function cssRule(css, selector) {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  const block = readBalanced(css, open, "{", "}");
  return block === null ? null : block.inner;
}

// ───────────────────────── 跑 ─────────────────────────

try {
  say(`被测 client.js：${CLIENT}`);
  const src = fs.readFileSync(CLIENT, "utf8");
  say(`源码长度：${src.length} 字符 / ${src.split("\n").length} 行`);

  // ══════════════════════════════════════════════════════════
  // ① 结构：AddMemberForm（「添加 AI 成员」的收编表单）
  //    它和用户说的三件事一一对上：编辑框 / 设为主智能体 / 返回列表
  // ══════════════════════════════════════════════════════════
  const addFn = functionBody(src, "AddMemberForm");
  const editFn = functionBody(src, "MemberEditor");
  const panelFn = functionBody(src, "MembersPanel");

  if (addFn === null || editFn === null || panelFn === null) {
    failures += 1;
    say(`FAIL 三个组件没找齐：AddMemberForm=${addFn !== null} MemberEditor=${editFn !== null} MembersPanel=${panelFn !== null}`);
  } else {
    const editor = elementBlock(addFn.inner, "tc-editor");
    say("");
    say("① AddMemberForm（「添加 AI 成员」表单）：");
    say(`   函数体范围 = [${addFn.braceOpen}, ${addFn.end}]（${addFn.inner.length} 字符）`);
    say(`   .tc-editor 元素块 = [${addFn.braceOpen + editor.relStart}, ${addFn.braceOpen + editor.relEnd}]（块长 ${editor.inner.length} 字符）`);
    say(`   块内标签清单 = ${tagList(editor.inner).join(", ")}`);
    say(`   块内关键子节点：`);
    say(`     members.isLead（设为主智能体）  × ${keyCount(editor.inner, "members.isLead")}`);
    say(`     members.addBack（返回列表）      × ${keyCount(editor.inner, "members.addBack")}`);
    say(`     members.adoptSubmit（收编）      × ${keyCount(editor.inner, "members.adoptSubmit")}`);
    say(`     tc-input（输入框 / 编辑框）      × ${classCount(editor.inner, "tc-input")}`);
    say(`     tc-field（字段行）               × ${classCount(editor.inner, "tc-field")}`);
    say(`     tc-editor-actions（按钮栏）      × ${classCount(editor.inner, "tc-editor-actions")}`);

    check("① AddMemberForm 里能找到 .tc-editor 元素块", editor !== null, true);
    check(
      "① .tc-editor 子树覆盖「设为主智能体」行（members.isLead）",
      keyCount(editor.inner, "members.isLead") >= 1,
      true,
    );
    check(
      "① .tc-editor 子树覆盖「返回列表」按钮（members.addBack）",
      keyCount(editor.inner, "members.addBack") >= 1,
      true,
    );
    check(
      "① .tc-editor 子树覆盖提交按钮（members.adoptSubmit）",
      keyCount(editor.inner, "members.adoptSubmit") >= 1,
      true,
    );
    check(
      "① .tc-editor 子树覆盖输入框（tc-input ≥ 4）与按钮栏（tc-editor-actions = 1）",
      [classCount(editor.inner, "tc-input") >= 4, classCount(editor.inner, "tc-editor-actions")],
      [true, 1],
    );
    check(
      "① 三种 form 控件齐全：input / select / span（label 元素）",
      [tagCount(editor.inner, "input") >= 4, tagCount(editor.inner, "select") >= 1, tagCount(editor.inner, "label") >= 3],
      [true, true, true],
    );
    check(
      "① 「返回列表」出现在块内（不是块外旁支）",
      editor.inner.lastIndexOf('t("members.addBack")') >= 0,
      true,
    );

    // ══════════════════════════════════════════════════════════
    // ② 结构：MemberEditor（「编辑资料」表单 —— 用户说的「编辑框」）
    // ══════════════════════════════════════════════════════════
    const editor2 = elementBlock(editFn.inner, "tc-editor");
    say("");
    say("② MemberEditor（「编辑资料」表单）：");
    say(`   函数体范围 = [${editFn.braceOpen}, ${editFn.end}]（${editFn.inner.length} 字符）`);
    say(`   .tc-editor 元素块 = [${editFn.braceOpen + editor2.relStart}, ${editFn.braceOpen + editor2.relEnd}]（块长 ${editor2.inner.length} 字符）`);
    say(`   块内标签清单 = ${tagList(editor2.inner).join(", ")}`);
    say(`   块内关键子节点：`);
    say(`     members.isLead（设为主智能体）   × ${keyCount(editor2.inner, "members.isLead")}`);
    say(`     members.save（保存）             × ${keyCount(editor2.inner, "members.save")}`);
    say(`     members.cancel（取消）           × ${keyCount(editor2.inner, "members.cancel")}`);
    say(`     members.delete（删除资料）       × ${keyCount(editor2.inner, "members.delete")}`);
    say(`     members.successionTitle（交替）  × ${keyCount(editor2.inner, "members.successionTitle")}`);
    say(`     tc-input × ${classCount(editor2.inner, "tc-input")}   tc-textarea × ${classCount(editor2.inner, "tc-textarea")}   tc-editor-actions × ${classCount(editor2.inner, "tc-editor-actions")}`);

    check("② MemberEditor 里能找到 .tc-editor 元素块", editor2 !== null, true);
    check(
      "② .tc-editor 子树覆盖「设为主智能体」行（members.isLead）",
      keyCount(editor2.inner, "members.isLead") >= 1,
      true,
    );
    check(
      "② .tc-editor 子树覆盖底部动作栏（保存 / 取消 / 删除 三个按钮都在块内）",
      [
        keyCount(editor2.inner, "members.save") >= 1,
        keyCount(editor2.inner, "members.cancel") >= 1,
        keyCount(editor2.inner, "members.delete") >= 1,
        classCount(editor2.inner, "tc-editor-actions") >= 1,
      ],
      [true, true, true, true],
    );
    check(
      "② .tc-editor 子树覆盖编辑控件（input ≥ 2 且 textarea ≥ 1）",
      [tagCount(editor2.inner, "input") >= 2, tagCount(editor2.inner, "textarea") >= 1],
      [true, true],
    );

    // ══════════════════════════════════════════════════════════
    // ③ 结构：MembersPanel —— 带边框的外壳，自渲染的直接子节点就三个
    //     （头部 / 提示 / body()），两个表单是 body() 返回的**子组件**。
    // ══════════════════════════════════════════════════════════
    const inner = panelFn.inner;
    const idxHead = inner.indexOf('className: "tc-panel-head"');
    const idxCount = inner.indexOf('className: "tc-panel-count"');
    const idxOpen = inner.indexOf('className: "tc-panel-open"');
    const idxAdd = inner.indexOf('className: "tc-panel-add"');
    const idxNotice = inner.indexOf('"data-kind": "ok", role: "status"');
    const idxBody = inner.indexOf("body(),");
    say("");
    say("③ MembersPanel（带边框的外壳）：");
    say(`   函数体 ${inner.length} 字符；自渲染的直接子节点顺序（源码偏移）：`);
    say(`     tc-panel-head 头部容器 @ ${idxHead}`);
    say(`       ├─ tc-panel-count（计数）@ ${idxCount}`);
    say(`       ├─ tc-panel-open（在右栏打开）@ ${idxOpen}`);
    say(`       └─ tc-panel-add（添加 AI 成员）@ ${idxAdd}`);
    say(`     提示条 notice @ ${idxNotice}（可空）`);
    say(`     body() @ ${idxBody}  ⇒ AddMemberForm / MemberEditor 都在它返回的子树里`);
    say(`   本函数体内自带 .tc-editor 元素块：${inner.indexOf('className: "tc-editor"') >= 0 ? "有" : "无（表单在子组件里）"}`);
    say(`   外壳类名形态：${/className: embedded \? "([^"]+)" : "([^"]+)"/u.exec(src)?.slice(1).join("  /  ") ?? "?"}`);

    check(
      "③ 外壳直接子节点顺序正确：head → notice → body()",
      [idxHead >= 0, idxCount > idxHead, idxOpen > idxCount, idxAdd > idxOpen, idxNotice > idxAdd, idxBody > idxNotice],
      [true, true, true, true, true, true],
    );
    check("③ 外壳自己不内联渲染表单（.tc-editor 只在子组件里）", inner.indexOf('className: "tc-editor"'), -1);
    check(
      "③ 带边框的外壳类名 = 浮层 tc-panel / 右栏 tc-panel tc-panel-embedded",
      /className: embedded \? "tc-panel tc-panel-embedded" : "tc-panel"/u.test(src),
      true,
    );

    // ══════════════════════════════════════════════════════════
    // ④ CSS：外壳自带 max-height 与 border，缺的是**滚动/裁剪机制**
    // ══════════════════════════════════════════════════════════
    const css = (() => {
      const at = src.indexOf("const TEAM_CHAT_CSS");
      if (at < 0) return null;
      const tick = src.indexOf("`", at);
      if (tick < 0) return null;
      return src.slice(tick + 1, skipTemplate(src, tick));
    })();

    if (css === null) {
      failures += 1;
      say("FAIL ④ 找不到 TEAM_CHAT_CSS 模板串 —— 拿不到样式原文");
    } else {
      const panelRule = cssRule(css, ".tc-panel");
      const embeddedRule = cssRule(css, ".tc-panel-embedded");
      const editorRule = cssRule(css, ".tc-editor");
      say("");
      say("④ CSS 原文（.tc-panel）:");
      say(`   .tc-panel { ${panelRule} }`);
      say("④ CSS 原文（.tc-panel-embedded）:");
      say(`   .tc-panel-embedded { ${embeddedRule} }`);
      say("④ CSS 原文（.tc-editor）:");
      say(`   .tc-editor { ${editorRule} }`);

      check("④ 外壳规则有 max-height（内容高了会被压）", /max-height:\s*min\(70vh,\s*520px\)/u.test(panelRule ?? ""), true);
      check("④ 外壳规则有 border（这就是用户说的「外框」）", /border:\s*\.5px solid/u.test(panelRule ?? ""), true);
      check(
        "④ 外壳是 flex 列容器",
        /display:\s*flex/u.test(panelRule ?? "") && /flex-direction:\s*column/u.test(panelRule ?? ""),
        true,
      );
      check(
        "④ 右栏形态不设 max-height（不参与这次修复）",
        /max-height:\s*none/u.test(embeddedRule ?? ""),
        true,
      );
      // 这一条就是本次修复的**验收条件**：滚动机制必须落在 .tc-panel 自己身上。
      // 写成「panel 自己滚，或面板内有滚动区」会假绿 —— 样式表里别的组件
      // （.tc-md-pre 的 overflow-x: auto）就能满足它，与外壳无关。
      check(
        "④ .tc-panel 自己有 overflow/overflow-y（内容溢出时留在边框内，而不是画出框外）",
        /(^|;)\s*overflow(-y)?\s*:\s*(auto|scroll|hidden)/u.test(panelRule ?? ""),
        true,
      );
      check(
        "④ .tc-editor 自己不裁剪（内容别在里层被藏掉）",
        /(^|;)\s*overflow/u.test(editorRule ?? ""),
        false,
      );
    }
  }

  // ══════════════════════════════════════════════════════════
  // ⑤ 文案：中英双语都在（本次修复不改文案，但边界要素得如实带上）
  // ══════════════════════════════════════════════════════════
  check(
    "⑤ 文案 members.addBack 中英各一条（zh=1 / en=1）",
    [src.split('"members.addBack": "返回列表"').length - 1, src.split('"members.addBack": "Back to list"').length - 1],
    [1, 1],
  );
  check(
    "⑤ 文案 members.isLead 中英各一条（zh=1 / en=1）",
    [
      src.split('"members.isLead": "设为主智能体"').length - 1,
      src.split('"members.isLead": "Make it the lead agent"').length - 1,
    ],
    [1, 1],
  );
} catch (error) {
  failures += 1;
  say(`EXCEPTION ${error?.stack ?? String(error)}`);
}

say("");
say(`== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ==`);
say(failures === 0 ? "OK — 全部断言通过" : `FAIL — ${failures} 项断言失败`);
fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");
console.log(lines.join("\n"));
console.log(`\n[输出已落盘] ${OUT_FILE}`);
process.exit(failures === 0 ? 0 : 1);
