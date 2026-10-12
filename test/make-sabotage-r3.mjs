/**
 * make-sabotage-r3.mjs —— 第三轮 i18n 的**对照组**生成者。
 *
 * 第三轮补的是 `lib/member-store.js` 与 `lib/succession.js` 的「码 + params」，
 * 核心验收项是**信息量不许丢**：英文文案里必须还看得见「avatar too large:
 * 3.15 MB > 1.5 MB」这种具体原因与数字。要证明这条判据不是空转，就得造出一个
 * **故意把信息量抹掉**的副本，看它是不是真的会红。
 *
 * 生成两份，各打一条路：
 *
 * ① `_sabotage-raw-params.js` —— 拆掉「`params` 交给本地化那一层」这一步。
 *    改的是 `errorText` 里那一行：
 *      `t(key, params === null || params === undefined ? {} : params)`
 *    → `t(key, {})`
 *    即：**码照查、字典照命中、只是占位符永远是空的**。于是刻意保留的
 *    `{size}` / `{max}` / `{detail}` 原样留在界面上 —— 界面上**恰好就是上一轮
 *    那种退化形态**（干净了，但原因与数字没了）。这一对照上：
 *      · 「英文文案里一个汉字都没有」——**照样绿**（参数没了不影响汉字判定）
 *        ⇒ 这就是"只断言英文侧会空转"的实证；
 *      · 「占位符全部被填掉」——**必须红**；
 *      · 「英文界面带上了 3.15 / 1.5」——**必须红**；
 *      · 「中文侧有中文」——**也红**（中文案里一样留着 `{size}`，汉字判定
 *        那一项其实仍然成立…… 所以这一组**不单独断言**它红，见下）。
 *
 *    ⚠ 为什么改这里而不是改 `t()`：占位符替换是**宿主 locale 服务**干的
 *      （测试里的桩与真宿主同契约），插件源码里根本没有那个循环。要造一个
 *      「参数没进文案」的副本，唯一诚实的改法就是改**插件调用它的那一行** ——
 *      症状与上一轮完全一样（用户看见的就是 `{size}` 或一句没有数字的话）。
 *
 * ② `_sabotage-no-error-lookup.js` —— 第二轮的对照组（由 `make-sabotage.mjs`
 *    第 ⑥ 项生成，本轮已**重新生成**，所以它带上了本轮的新码）。它说明另一件事：
 *    把「码 → 字典」整条拆掉之后，
 *      · 英文侧**照样绿**（回落到的本来就是英文兜底）；
 *      · 中文侧**必须红**（新码也一起回落成英文）。
 *
 * ⚠ **只往本 test/ 目录里写副本，插件源码一个字节都不动。**
 * ⚠ 它会**覆盖** `test/_sabotage-raw-params.js`。若你正要拿它做对照实验，
 *    先跑对照、再重新生成。
 *
 * 用法：node test/make-sabotage-r3.mjs
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

// ① 把「params 交给本地化层」这一步拆掉 —— 见文件头。
sabotage(
  "raw-params",
  "\t\t\t\tconst text = t(key, params === null || params === undefined ? {} : params);",
  "\t\t\t\tconst text = t(key, {});",
);

// ② 第二轮的对照组：只**核对**它还在、还是那个形态（它是 `make-sabotage.mjs` 生成的）。
const NO_LOOKUP = path.join(here, "_sabotage-no-error-lookup.js");
if (!fs.existsSync(NO_LOOKUP)) {
  console.log(
    `MISSING ${NO_LOOKUP}\n` +
      `        它是第二轮的对照组（由 test/make-sabotage.mjs 第 ⑥ 项生成）。\n` +
      `        先跑 \`node test/make-sabotage.mjs\` 再造第三轮的对照实验。`,
  );
} else {
  const text = fs.readFileSync(NO_LOOKUP, "utf8");
  const probe = /if \(false\) \{\s*\n\s*const key = `err\.\$\{code\}`;/u.test(text);
  // 它是不是从**当前** client.js 生成的：拿本轮才有的码比对。
  const fresh = text.includes('"err.TEAMCHAT_AVATAR_TOO_LARGE"');
  console.log(`CHECK ${NO_LOOKUP}`);
  console.log(`      形态仍然是「跳过字典查表」：${probe ? "是" : "否 ← 需要重新生成"}`);
  console.log(`      含本轮的新码（= 重新生成过）：${fresh ? "是" : "否 ← 请先跑 make-sabotage.mjs"}`);
  if (!probe || !fresh) process.exitCode = 1;
}
