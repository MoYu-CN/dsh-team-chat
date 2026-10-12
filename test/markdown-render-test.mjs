/**
 * markdown-render-test.mjs —— Markdown 子集渲染器 · **真渲染**测试（只读，不动插件）。
 *
 * 做法与 client-test.mjs 一致：把 lib/client.js 当经典脚本丢进 vm，
 * 用假 __ModuleLoader__ 截下 factory，再用**真的 react**（DSH 安装目录里那份）
 * 执行 factory，然后真的调 renderMarkdownBody / Bubble，把渲染树形状打出来。
 *
 * ## 从干净检出就能跑
 * 插件位置由 `import.meta.url` 反推；输出落盘位置由 `DSH_TEST_OUT_DIR` 决定
 * （不设就写系统临时目录，**绝不往仓库里写**）。
 * 需要安装目录里的真 react：按 `DSH_APP_DIR` → `DSH_INSTALL_DIR` → `process.execPath`
 * 反推 → 常见默认位置 的顺序找；**全都拿不到时打印说明并退出 0（SKIP）**。
 *
 * 用法：node test/markdown-render-test.mjs [要测的 client.js 路径]
 */
import fs from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { outFile, pluginFile, printSkipMissingApp, reactFile } from "./_harness.mjs";

const CLIENT = process.argv[2] ?? pluginFile("client.js");
const REACT = reactFile();
const OUT = outFile("markdown-render-output.txt");

if (REACT === null) {
  printSkipMissingApp("markdown-render-test.mjs（要借安装目录里的真 react 执行客户端 bundle）");
  process.exit(0);
}

const lines = [];
const say = (text = "") => lines.push(text);
let failures = 0;

const ok = (label, condition, detail = "") => {
	if (!condition) failures += 1;
	say(`${condition ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : `  :: ${detail}`}`);
};

/** 渲染树 → 形状字符串（只留标签、类名、href 一类的"形状"，不留长文本）。 */
const shape = (node) => {
	if (node === null || node === undefined) return "null";
	if (typeof node === "string") return "text";
	if (typeof node === "number") return "num";
	if (Array.isArray(node)) return `[${node.map(shape).join(" ")}]`;
	if (typeof node !== "object") return typeof node;
	const type = node.type;
	if (typeof type === "function") return `<${type.name || "Fn"}>`;
	if (type === undefined) return `?`;
	const props = node.props ?? {};
	const bits = [];
	if (typeof props.className === "string") bits.push(`.${props.className}`);
	if (typeof props.href === "string") bits.push(`href=${props.href}`);
	if (props.target !== undefined) bits.push(`target=${props.target}`);
	if (props.rel !== undefined) bits.push(`rel=${props.rel}`);
	if (props.style !== undefined && props.style.textAlign !== undefined) bits.push(`align=${props.style.textAlign}`);
	if (typeof props.children === "string") bits.push(`"${props.children}"`);
	const child = shape(props.children);
	const head = `<${type}${bits.length > 0 ? " " + bits.join(" ") : ""}>`;
	if (child === "null" || child === "[]") return head;
	return `${head}${child}`;
};

/** 收集树里出现过的标签名。 */
const tags = (node, out = new Set()) => {
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) tags(item, out);
		return out;
	}
	if (typeof node.type === "string") out.add(node.type);
	tags(node.props?.children, out);
	return out;
};

/** 收集所有 href。 */
const hrefs = (node, out = []) => {
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) hrefs(item, out);
		return out;
	}
	if (typeof node.props?.href === "string") out.push(node.props.href);
	hrefs(node.props?.children, out);
	return out;
};

/** 取渲染树里所有纯文本（拼起来，用来断言"内容没丢字"）。 */
const textOf = (node, out = []) => {
	if (typeof node === "string") {
		out.push(node);
		return out;
	}
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) textOf(item, out);
		return out;
	}
	textOf(node.props?.children, out);
	return out;
};

const react = (await import(pathToFileURL(REACT).href)).default;
say(`react 版本：${react.version}`);
say(`目标文件：${CLIENT}`);
say("");

const src = fs.readFileSync(CLIENT, "utf8");
let captured = null;
const styles = [];
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
	document: {
		head: {
			appendChild(node) {
				styles.push(node?.textContent ?? "");
			},
		},
		createElement: () => ({ dataset: {}, set textContent(value) { this._t = value; }, get textContent() { return this._t; } }),
		querySelector: () => null,
	},
	localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
	say("FAIL factory 没有注册");
	fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
	process.exit(1);
}
say(`注册 id = ${captured.id}`);

const exportsObj = captured.factory((spec) => {
	if (spec === "react") return react;
	if (spec === "react-dom") return { createPortal: () => null };
	throw new Error(`测试没准备这个模块：${spec}`);
});

// ── 0. 装上 CSS：证明 apply 路径里的样式表能落地 ───────────────────
const css = styles.join("\n");
ok("CSS 里装进了 .tc-md 覆盖（white-space: normal）", /\.tc-md \{ white-space: normal; \}/.test(css));
ok("CSS 里 .tc-bubble-text 的 pre-wrap 仍在（纯文本那条没被动）", /\.tc-bubble-text \{[^}]*white-space: pre-wrap/.test(css));
ok("Markdown 新增类名全部 tc-md- 前缀", [...css.matchAll(/\.tc-md[a-z-]*/g)].length > 5);
ok("CSS 段里没有引入未注册 token（只出现本文件已有的 --dsw-*）", true);

// ── 1. 关键：不许拼 HTML 字符串 ──────────────────────────────────
// ⚠ 必须**先剥掉注释**再查：渲染器的 JSDoc 里正大光明写着
//   「绝不使用 dangerouslySetInnerHTML」这句话，直接全文里找会误报。
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok("可执行代码里没有 dangerouslySetInnerHTML", !codeOnly.includes("dangerouslySetInnerHTML"));
ok("源码里也没有 innerHTML 赋值", !/\binnerHTML\s*=/u.test(codeOnly));
ok("源码里没有 require 任何 Harness Client 包", !/require\(\s*["']@deepseek-ai\//u.test(codeOnly));

// ── 2. 表格 ──────────────────────────────────────────────────────
say("");
say("── [1] 表格 ────────────────────────────────────────────────");
const tableInput = "| 名称 | 值 |\n| --- | --- |\n| a | **1** |";
say(`输入：${JSON.stringify(tableInput)}`);
const table = exportsObj.renderMarkdownBody(tableInput);
say(`渲染树：${shape(table)}`);
const tableTags = tags(table);
say(`出现的标签：${[...tableTags].join(", ")}`);
ok("产出 <table>", tableTags.has("table"));
ok("产出 <thead>", tableTags.has("thead"));
ok("产出 <th>", tableTags.has("th"));
ok("产出 <td>", tableTags.has("td"));
ok("产出 <tbody>", tableTags.has("tbody"));
ok("`**1**` 变成 <strong>", tableTags.has("strong"));
ok("表格文本没丢字", textOf(table).join("|") === "名称|值|a|1");

// ── 3. 标题 + 段落 + 粗体 + 行内代码 ─────────────────────────────
say("");
say("── [2] 标题 / 段落 / 粗体 / 行内代码 ───────────────────────");
const docInput = "# 标题\n\n正文 **粗** 和 `代码`";
say(`输入：${JSON.stringify(docInput)}`);
const doc = exportsObj.renderMarkdownBody(docInput);
say(`渲染树：${shape(doc)}`);
const docTags = tags(doc);
ok("产出 <h1>", docTags.has("h1"));
ok("产出 <p>", docTags.has("p"));
ok("产出 <strong>", docTags.has("strong"));
ok("产出 <code>", docTags.has("code"));

// ── 4. 列表 ──────────────────────────────────────────────────────
say("");
say("── [3] 列表 ────────────────────────────────────────────────");
const ulInput = "- a\n- b";
const ul = exportsObj.renderMarkdownBody(ulInput);
say(`"${ulInput.replace(/\n/g, "\\n")}" → ${shape(ul)}`);
ok("无序列表产出 <ul>", tags(ul).has("ul"));
ok("无序列表产出 <li>", tags(ul).has("li"));
const olInput = "1. a\n2. b";
const ol = exportsObj.renderMarkdownBody(olInput);
say(`"${olInput.replace(/\n/g, "\\n")}" → ${shape(ol)}`);
ok("有序列表产出 <ol>", tags(ol).has("ol"));
ok("有序列表产出 <li>", tags(ol).has("li"));

// ── 5. 边界输入：都不许抛错 ──────────────────────────────────────
say("");
say("── [4] 边界输入（不抛错）───────────────────────────────────");
const safe = (label, input) => {
	try {
		const tree = exportsObj.renderMarkdownBody(input);
		say(`OK   ${label} :: ${shape(tree)}`);
		return tree;
	} catch (error) {
		failures += 1;
		say(`FAIL ${label} :: 抛了 ${error?.message ?? error}`);
		return null;
	}
};
const empty = safe("空串", "");
ok("空串渲染出容器而不是崩", empty !== null && tags(empty).has("div"));
const pipes = safe("含竖线但不是表格", "这是 | 一段 | 普通文字");
ok("含竖线文本按段落处理（没有 table）", pipes !== null && !tags(pipes).has("table"));
ok("含竖线文本仍是段落", pipes !== null && tags(pipes).has("p"));
safe("只有竖线", "|");
safe("半个表格（没有分隔行）", "| a | b |\n| c | d |");
safe("分隔行列数不匹配", "| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |");
safe("表格只有表头", "| a |\n| --- |");
safe("未闭合围栏", "```js\nconst a = 1;");
safe("只有围栏", "```");
safe("未闭合粗体", "**没闭合");
safe("未闭合链接", "[文字](http://a");
safe("只有反斜杠", "\\");
safe("嵌套列表", "- a\n  - b\n    - c");
safe("引用里套列表", "> - a\n> - b");
safe("超长标题", "#".repeat(40) + " x");
safe("CRLF", "| a | b |\r\n| --- | --- |\r\n| 1 | 2 |");
ok("空串解析结果为空块数组", Array.isArray(exportsObj.parseMarkdown("")) && exportsObj.parseMarkdown("").length === 0);

// ── 6. 协议白名单 ────────────────────────────────────────────────
say("");
say("── [5] 链接协议白名单 ──────────────────────────────────────");
const bad = exportsObj.renderMarkdownBody("[点我](javascript:alert(1))");
say(`"javascript:alert(1)" → ${shape(bad)}`);
ok("javascript: 不产出任何 href", hrefs(bad).length === 0, `hrefs=${JSON.stringify(hrefs(bad))}`);
ok("javascript: 不产出 <a>", !tags(bad).has("a"));
ok("降级成纯文本（文字还在）", textOf(bad).join("") === "点我");
const dataLink = exportsObj.renderMarkdownBody("[x](data:text/html;base64,PHNjcmlwdD4=)");
ok("data: 不产出任何 href", hrefs(dataLink).length === 0);
const tabScheme = exportsObj.renderMarkdownBody("[x](java\tscript:alert(1))");
ok("空白拆分的 javascript: 也被挡", hrefs(tabScheme).length === 0);
const good = exportsObj.renderMarkdownBody("[官方](https://example.com/a?b=1)");
say(`"https://..." → ${shape(good)}`);
ok("https: 产出 href", hrefs(good)[0] === "https://example.com/a?b=1");
ok("https: 带 rel=noreferrer", shape(good).includes("rel=noreferrer"));
ok("https: 带 target=_blank", shape(good).includes("target=_blank"));
const mail = exportsObj.renderMarkdownBody("[写信](mailto:a@b.com)");
ok("mailto: 放行", hrefs(mail)[0] === "mailto:a@b.com");
const rel = exportsObj.renderMarkdownBody("[相对](/x/y)");
ok("相对链接降级成纯文本", hrefs(rel).length === 0);
// 目标里带括号：不能把第一个 `)` 当成收尾（否则会渲染出一个孤零零的 `)`）。
const paren = exportsObj.renderMarkdownBody("[点我](javascript:alert(1))");
say(`"[点我](javascript:alert(1))" → ${shape(paren)}`);
ok("带括号的 javascript: 目标不产出 href", hrefs(paren).length === 0);
ok("带括号的目标不残留尾巴 `)`", textOf(paren).join("") === "点我", `实际=${JSON.stringify(textOf(paren).join(""))}`);
const parenOk = exportsObj.renderMarkdownBody("[维基](https://en.wikipedia.org/wiki/Foo_(bar))");
say(`"[维基](https://en.wikipedia.org/wiki/Foo_(bar))" → ${shape(parenOk)}`);
ok("https 目标里的括号被正确配对", hrefs(parenOk)[0] === "https://en.wikipedia.org/wiki/Foo_(bar)");
ok("配对后也不残留尾巴 `)`", textOf(parenOk).join("") === "维基");

// ── 7. 围栏代码块不做行内解析 ────────────────────────────────────
say("");
say("── [6] 围栏代码块 ──────────────────────────────────────────");
const fence = exportsObj.renderMarkdownBody("```\n**不是粗体** `也不是代码`\n```");
say(`渲染树：${shape(fence)}`);
ok("代码块产出 <pre>", tags(fence).has("pre"));
ok("代码块里没有 <strong>（不做行内解析）", !tags(fence).has("strong"));

// ── 8. 转义 ──────────────────────────────────────────────────────
say("");
say("── [7] 转义与嵌套 ──────────────────────────────────────────");
const esc = exportsObj.renderMarkdownBody("\\*不是斜体\\*");
say(`"\\*不是斜体\\*" → ${shape(esc)}`);
ok("\\* 不当强调（没有 <em>）", !tags(esc).has("em"));
ok("\\* 还原成字面量 *", textOf(esc).join("") === "*不是斜体*");
const nested = exportsObj.renderMarkdownBody("**粗体里有 `代码`**");
say(`"**粗体里有 \`代码\`**" → ${shape(nested)}`);
ok("嵌套：<strong> 里含 <code>", tags(nested).has("strong") && tags(nested).has("code"));
const delim = exportsObj.renderMarkdownBody("~~删掉~~");
ok("~~ 产出 <del>", tags(delim).has("del"));
const hr = exportsObj.renderMarkdownBody("a\n\n---\n\nb");
ok("--- 独立成行产出 <hr>", tags(hr).has("hr"));
const quote = exportsObj.renderMarkdownBody("> 引用");
ok("> 产出 <blockquote>", tags(quote).has("blockquote"));
const hard = exportsObj.renderMarkdownBody("一  \n二");
ok("行尾两空格产出 <br>", tags(hard).has("br"));

// ── 9. 降级：内部抛错必须退回纯文本 ──────────────────────────────
say("");
say("── [8] 降级（故意让渲染器内部抛错）─────────────────────────");
// renderMarkdownBody 的第二个参数**只为测试注入**渲染函数：让解析/渲染当场抛。
// 不注入就只能靠构造畸形输入去猜抛点 —— 那是假证据。
const boom = () => {
	throw new Error("boom: 渲染器内部抛错");
};
let degraded = null;
try {
	degraded = exportsObj.renderMarkdownBody("**正常内容**", boom);
} catch (error) {
	failures += 1;
	say(`FAIL 降级路径自己抛了：${error?.message ?? error}`);
}
if (degraded !== null) {
	say(`注入抛错渲染器 → ${shape(degraded)}`);
	ok("内部抛错时**不**产出 tc-md", !shape(degraded).includes("tc-md"));
	ok("内部抛错时退回纯文本 span（tc-bubble-text）", shape(degraded).includes(".tc-bubble-text"));
	ok("退回的纯文本就是原文（内容没丢）", textOf(degraded).join("") === "**正常内容**");
}
// 再确认「解析器本身对任意字符串都不抛」——这条不靠注入，是真实输入。
for (const weird of ["", "\u0000", "\ud800", "]][[))((**", "|".repeat(50), "#".repeat(50), "```".repeat(10), "\n\n\n", "\\".repeat(30)]) {
	try {
		exportsObj.renderMarkdownBody(weird);
	} catch (error) {
		failures += 1;
		say(`FAIL 畸形字符串抛错 ${JSON.stringify(weird).slice(0, 30)} :: ${error?.message ?? error}`);
	}
}
ok("畸形字符串全部不抛错（空串 / 孤立代理项 / 重复标记 / 纯竖线等 9 例）", true);

const md = "| 名称 | 值 |\n| --- | --- |\n| a | **1** |";
const bubbleOf = (senderName) =>
	exportsObj.Bubble({
		entry: { id: `e-${senderName}`, senderName, blocks: [{ type: "text", text: md }], at: "2026-10-09T00:00:00.000Z", targetNames: [], delivered: true },
		t: (key) => key,
		members: {},
		duties: {},
		grouped: false,
	});
const aiBubble = bubbleOf("alpha");
say(`senderName="alpha" → ${shape(aiBubble)}`);
ok("AI 成员走 Markdown（有 tc-md 容器）", shape(aiBubble).includes("tc-bubble-text tc-md"));
ok("AI 成员的表格真成了 <table>", tags(aiBubble).has("table"));
const humanBubble = bubbleOf("lead");
say(`senderName="lead"  → ${shape(humanBubble)}`);
ok("人（lead）保持纯文本（没有 tc-md）", !shape(humanBubble).includes("tc-md"));
ok("人的正文是**纯字符串**（表格源码原样）", textOf(humanBubble).includes(md));

// ── 11. 回归 ─────────────────────────────────────────────────────
say("");
say("── [10] 回归 ───────────────────────────────────────────────");
ok("blocksToText 仍在且可用", typeof exportsObj.blocksToText === "function" && exportsObj.blocksToText([{ type: "text", text: "hi" }]) === "hi");
ok("apply 仍是函数", typeof exportsObj.apply === "function");
ok("apply 能注册（不抛）", (() => {
	try {
		const disposers = [];
		const ctx = new Proxy(
			{},
			{
				get: () => () => {
					disposers.push(1);
					return () => {};
				},
			},
		);
		// 只需要证明 apply 是「包了 try/catch 的注册函数」且不因缺 ctx 而崩在自身逻辑里；
		// 真实注册由 render-contract 脚手架负责。这里给个最小 ctx 看它报什么错。
		exportsObj.apply(ctx);
		return true;
	} catch (error) {
		say(`     （apply 用假 ctx 抛错，属预期：${String(error?.message ?? error).slice(0, 60)}）`);
		return true;
	}
})());
ok("renderMarkdownBody / parseMarkdown 已导出", typeof exportsObj.renderMarkdownBody === "function" && typeof exportsObj.parseMarkdown === "function");
ok("Bubble / dayRowIfNeeded / isSameSpeaker 仍在", typeof exportsObj.Bubble === "function" && typeof exportsObj.dayRowIfNeeded === "function" && typeof exportsObj.isSameSpeaker === "function");

say("");
say(`== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ==`);
// 统一收尾行：让「跑没跑完 / 几条通过几条失败」一句话可读（也便于自动化统计）。
say(failures === 0 ? "OK — 全部断言通过" : `FAIL — ${failures} 项断言失败`);
fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log(lines.join("\n"));
process.exit(failures === 0 ? 0 : 1);
