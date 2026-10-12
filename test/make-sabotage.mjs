/**
 * make-sabotage.mjs —— 造「故意改坏」的 bundle 副本，用来证明 client-test.mjs
 * 的断言**会失败**（不失败就说明判据是空转的）。
 *
 * 它是 `test/_sabotage-*.js` 那 5 份对照副本的**生成者** ——
 * 有它才说得清那些副本是怎么来的、改的是哪一处、为什么这么改。
 *
 * ⚠ **只往本 test/ 目录里写副本，插件源码一个字节都不动。**
 *   （原来写死在某个工作区目录下；现在用 `import.meta.url` 定位，
 *    跑完就在 `test/` 里看到那 5 个文件。）
 *
 * 用法：node test/make-sabotage.mjs
 *       ⚠ 它**会覆盖** test/_sabotage-*.js。若你正要拿这些副本做对照实验，
 *         先跑对照、再重新生成。
 */
import fs from "node:fs";
import path from "node:path";
import { here, pluginFile } from "./_harness.mjs";

const SRC = pluginFile("client.js");
const origin = fs.readFileSync(SRC, "utf8");

const sabotage = (name, from, to) => {
  const at = origin.indexOf(from);
  if (at < 0) throw new Error(`${name}: 找不到要替换的片段`);
  if (origin.indexOf(from, at + 1) >= 0) throw new Error(`${name}: 片段不唯一`);
  const out = path.join(here, `_sabotage-${name}.js`);
  fs.writeFileSync(out, origin.slice(0, at) + to + origin.slice(at + from.length), "utf8");
  console.log(`WROTE ${out}`);
};

// ① 表格不再渲染成元素树，退回「源码字符串」——旧行为复现。
sabotage(
  "table-as-text",
  '			return react.createElement(\n				"table",\n				{ key, className: "tc-md-table" },',
  '			return ["| " + String(block.align ?? "") + " | " + JSON.stringify(block.head ?? null) + " | " + JSON.stringify(block.rows ?? null)];\n			return react.createElement(\n				"table",\n				{ key, className: "tc-md-table" },',
);

// ② HTML 源码直接进 DOM（注入真的成立），安全断言必须红。
sabotage(
  "raw-html",
  '{ className: "tc-bubble-text tc-md" },',
  '{ className: "tc-bubble-text tc-md", dangerouslySetInnerHTML: { __html: String(text ?? "") } },',
);

// ③ 粗体改回纯文本（不再产生 <strong>）。
sabotage(
  "bold-as-text",
  '			const tag = node.type === "strong" ? "strong" : node.type === "em" ? "em" : "del";\n			return react.createElement(tag, { key }, mdRenderNodes(node.nodes, key));',
  '			if (node.type === "strong") return node.text ?? "";\n			const tag = node.type === "em" ? "em" : "del";\n			return react.createElement(tag, { key }, mdRenderNodes(node.nodes, key));',
);

// ④ javascript: 目标照给 href（协议白名单被拆掉）。
sabotage(
  "unsafe-href",
  '			if (scheme !== "http" && scheme !== "https" && scheme !== "mailto") return null;',
  '			if (scheme !== "http" && scheme !== "https" && scheme !== "mailto") return target;',
);

// ⑤ 渲染器抛错后不再退回纯文本（降级路径被拆掉）。
sabotage(
  "no-fallback",
  '			return react.createElement("span", { className: "tc-bubble-text" }, String(text ?? ""));',
  '			throw error;',
);

// ⑥ 宿主报错的「码 → 文案」翻译整条拆掉（`errorText` 永远直接返回原文）。
//    对照组对象：`test/host-error-i18n.test.mjs`。
//    为什么这样改最能说明问题：拆掉翻译之后，英文界面拿到的还是英文兜底
//    （`raw`），表面上看不出异样 —— 但「中文界面拿到的是中文」这条断言
//    立刻红。如果那条断言不会红，说明它只是碰巧用对了语言，不是真的在测
//    「码有没有被翻成对应语言」。
sabotage(
  "no-error-lookup",
  '			if (typeof code === "string" && code !== "") {\n				const key = `err.${code}`;',
  '			if (false) {\n				const key = `err.${code}`;',
);
