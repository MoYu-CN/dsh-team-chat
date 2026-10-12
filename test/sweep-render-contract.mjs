// ═══════════════════════════════════════════════════════════════════════════
//  dsh render 契约全量扫描器
// ═══════════════════════════════════════════════════════════════════════════
//
// 【它查什么】
//   工具定义的 `output.render` 是否违反宿主契约。两类错法互相独立：
//     [SIG*]  签名不对 —— 宿主调的是 `render(exec.arguments, value)`。
//             写成 `(value)` 会让**唯一的参数实际接到 args**，结果值丢失。
//             合法形态：0 参（文案是常量）或 ≥2 参。1 参才可疑。
//     [SHAPE] 返回裸字符串，而契约要**内容块数组** `[{ type:"text", text }]`。
//             宿主 `dsh-tools:1384` 会执行 `result.content.some(...)`，
//             字符串没有 `.some` ⇒ `TypeError: content.some is not a function`，
//             **该工具每次调用必失败**。
//
// 【真实案例】dsh-knowledge 的 7 个工具全部因此不可用（连 kb_init 都跑不了，
//   知识库永远建不起来），症状只有一句 TypeError、指向插件之外，极难定位。
//
// ───────────────────────────────────────────────────────────────────────────
// 【怎么用】
//     node sweep-render-contract.mjs <根1> [根2 …]          默认：排除客户端产物
//     node sweep-render-contract.mjs --all <根1> [根2 …]     全量（慢，仅排查特例时用）
//
// 【退出码】（三个都实测触发过）
//     0  扫描完成且自检通过
//     2  **自检未通过** —— 扫描器自己不成立，拒绝输出任何结论
//     3  某个扫描根得到 **0 个 .js** —— 遍历失败或路径为空，拒绝报「干净」
//
// ───────────────────────────────────────────────────────────────────────────
// 【三条保证】谁拿去都能自证
//
//   ① 自检内建（20 个控制样本）。开跑先验证提取器，判错就 exit 2。
//      样本按**合法/非法的全部形态**铺，不是铺几种 —— 因为
//      「自检通过」只证明它覆盖到的形态。曾经 7/7 通过却仍产生 3 个误报，
//      原因就是样本缺了「0 参合法」那一类。
//
//   ② 遍历跟随 Junction，且对「0 个文件」失败关闭（exit 3）。
//      Windows 上 Node 的 `Dirent.isDirectory()` 对 Junction 返回 **false**
//      （只有 `isSymbolicLink()` 为 true）。profile 里本地 bundle 全是 Junction，
//      早先版本因此把 4 个包全跳过，输出「0 个文件 / 0 个问题 / ✅ 干净」——
//      **扫了 0 个文件却报干净**，是最危险的假干净。
//      现在：链接用 statSync 跟随 + realpath 去重防环 + 深度上限，
//      并打印前 3 个真实扫到的路径做「存活证明」。
//
//   ③ 召回率门禁。控制样本守的是**精确率**（会不会误报），守不住
//      **召回率**（提取器会不会漏）。故独立数一遍代码里的 `render:`
//      （用词法器跳过字符串/注释里的假匹配），与提取器解析条数对照；
//      不一致就逐条列出来人工看。
//
// ───────────────────────────────────────────────────────────────────────────
// 【扫描面为什么排除客户端产物】
//   客户端 `client.js` / `client.*.js` / `…/client/…` 里的 `render:` 是 React 组件的
//   render prop（或 PDF.js 之类库的内部方法），**不是工具输出契约**，扫它只有噪音，
//   而且极慢（对上千个 bundle 逐字符做两遍词法分析，>10 分钟跑不完）。
//   ⚠ **不要改用「文件含 `defineTool(`」当判据**：dsh-knowledge 用本地 `reg()` 包装
//   注册工具，文件里没有 `defineTool(` 字样 —— 这么滤会让 profile 扫描报
//   「render 定义 0 / ✅ 干净」，**又一个假干净**。按路径排除才对。
//   排除数量会打印出来，让读者看见过滤器确实动了手。
//
// ───────────────────────────────────────────────────────────────────────────
// 【本文件编码的五个坑 —— 别把它们改回去】
//   1. `Dirent.isDirectory()` 不认 Junction ⇒ 假干净。必须 statSync 跟随。
//   2. `lineOf(source, index)` 是**两参**调用；写成单参 `(idx)` 会让 idx 收到
//      整个源码字符串、比较全变 NaN、二分永远退到 0 ⇒ **行号恒为 1**。
//      纯静默（不抛错），靠 `wantLine` 控制样本才抓到。
//   3. 召回门禁不能用朴素正则数 `render:`：`"…failed to render: "` 这类
//      **字符串里的假匹配**会被算进去，噪音淹没真缺口。必须走词法器。
//   4. 方法语法 `render(a, b) { … }` **不要**纳入计数（曾经纳过，已撤）。原因：
//      词法器不处理**正则字面量**，`render(a.replace(/)/, ''))` 里的 `)` 会被当成
//      闭括号、配平错位后误判成方法定义 ⇒ 假阳性（实测 dsh-cordis-host-runner 与
//      dsh-tools 被误报，而那两个文件 `render:` 出现 0 次，ripgrep 与 .NET 双向确认）。
//      加上 React 类 `render() {}` 的噪音。代价：真有插件用方法语法时门禁看不到。
//   5. 过滤掉文件后必须**显式报告「读了几个、查出几个」**：本文件曾在
//      「读了 20 个文件、render 定义 0」时输出 ✅ 干净 —— 与坑 1 是同一种假干净。
//      现在对「读过文件但 render 数为 0」显式告警。
//
// ───────────────────────────────────────────────────────────────────────────
// 【检测边界 · 如实标注】
//   · 只扫 `.js`，含嵌套 `node_modules`；默认排除客户端产物（见上）。
//   · `SHAPE` 判不出「三元里一支数组一支字符串」这种混合分支。
//   · `render: someSharedFn` 这种**函数引用**静态判不了（无法确定其返回值）——
//     会被召回门禁列为提示，需人工去读该函数的定义。
//     （实测 `dsh-schedule` 的 4 处 `render: renderValue` 就是这种；已人工读过
//       `renderValue`，它是正确的 `(_args, value) => [{ type:'text', … }]`。）
//   · **方法语法 `render(a,b){…}` 不在覆盖范围内**（见坑 4）。
//
// ───────────────────────────────────────────────────────────────────────────
// 【实测基线】（2026-10-09，Windows 11 / Node 22.22.2）
//   · 自检 **20/20** 通过；exit 2 / 3 / 0 三个分支均实测触发过。
//   · profile 本地 4 个 bundle（Junction）：20 个 .js → 排除 4 → 分析 7
//     → **10 个 render → 0 违规**，召回提示 0 条。
//   · `@deepseek-ai`（harness + 全部随发行版出货插件）：1514 个 .js → 排除 133
//     → 分析 160 → **51 个 render → 0 违规**；召回提示 2 条，均落在 `dsh-schedule`
//     且已人工验证为良性（函数引用形态）。耗时 0.2s。
//   · 校准：本扫描器在 dsh-knowledge 上报 **7** 个 render，与手工 `grep` 数出的
//     7 个一致；四个包合计 10 个，与逐包 grep 的 7+2+0+1 吻合。
//     **阳性对照成立**（在已知有病的地方报了病），它在别处报「没病」才可信。
// ═══════════════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pluginRoot } from './_harness.mjs';

// ───────────────────────── 提取器 ─────────────────────────

/** 跳过空白与注释，返回新下标。 */
function skipTrivia(src, i) {
  for (;;) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.length; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    return i;
  }
}

/** 从 opener 处读一对配平括号，返回 { inner, end }（end 指向闭括号之后）。 */
function readBalanced(src, i, open, close) {
  if (src[i] !== open) return null;
  let depth = 0;
  const start = i + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return { inner: src.slice(start, i), end: i + 1 }; }
  }
  return null;
}

function skipQuoted(src, i, q) {
  for (i++; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === q) return i;
  }
  return src.length - 1;
}

/** 跳过模板字符串，含 `${}` 内的嵌套。 */
function skipTemplate(src, i) {
  for (i++; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') return i;
    if (src[i] === '$' && src[i + 1] === '{') {
      const inner = readBalanced(src, i + 1, '{', '}');
      if (inner) i = inner.end - 1;
    }
  }
  return src.length - 1;
}

/** 从 `=>` 之后读函数体：块体 {…} 或表达式（到顶层 , 或 } 为止）。 */
function readArrowBody(src, i) {
  i = skipTrivia(src, i);
  if (src[i] === '{') {
    const b = readBalanced(src, i, '{', '}');
    return b ? { kind: 'block', text: b.inner, end: b.end } : null;
  }
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '}') { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return { kind: 'expr', text: src.slice(start, i), end: i };
}

/** 块体内顶层的 return 表达式列表。 */
function topLevelReturns(inner) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '`') { i = skipTemplate(inner, i); continue; }
    if (c === '"' || c === "'") { i = skipQuoted(inner, i, c); continue; }
    if (c === '/' && inner[i + 1] === '/') { const e = inner.indexOf('\n', i); i = e < 0 ? inner.length : e; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth === 0 && inner.startsWith('return', i) && !/[\w$]/.test(inner[i - 1] ?? ' ')) {
      let j = skipTrivia(inner, i + 6);
      const start = j;
      let d2 = 0;
      for (; j < inner.length; j++) {
        const ch = inner[j];
        if (ch === '`') { j = skipTemplate(inner, j); continue; }
        if (ch === '"' || ch === "'") { j = skipQuoted(inner, j, ch); continue; }
        if (ch === '(' || ch === '[' || ch === '{') { d2++; continue; }
        if (ch === ')' || ch === ']') { d2--; continue; }
        if (ch === '}') { if (d2 === 0) break; d2--; continue; }
        if (ch === ';' && d2 === 0) break;
      }
      out.push(inner.slice(start, j).trim());
    }
  }
  return out;
}

const isStringStart = (expr) => /^[`'"]/.test(expr.trim());

/** 扫描一段源码，返回每条 render 的分类结果。 */
export function analyze(source, file, lineOf) {
  const found = [];
  const re = /(?<![\w$.])render\s*:/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    let i = skipTrivia(source, m.index + m[0].length);
    const params = readBalanced(source, i, '(', ')');
    if (!params) continue;
    const paramList = params.inner.trim();
    i = skipTrivia(source, params.end);
    if (source[i] !== '=' || source[i + 1] !== '>') continue;
    const body = readArrowBody(source, i + 2);
    if (!body) continue;

    const paramCount = paramList === '' ? 0 : paramList.split(',').length;
    const returns = body.kind === 'block' ? topLevelReturns(body.text) : [body.text];
    const stringish = returns.filter((r) => isStringStart(r));
    const arrayish = returns.filter((r) => /^\s*\[/.test(r));
    const hasBracket = body.text.includes('[');

    // 契约是 render(args, value)。合法形态有：
    //   0 参 —— 文案是常量，两个入参都不需要。
    //          实例：dsh-plan-mode `render: () => [{ type:"text", text:"Plan approved …" }]`。
    //          早期版本写成「参数数 ≠ 2 就报 SIG」，把这些**合法的常量渲染**误报成缺陷
    //          （实测 @deepseek-ai 全量扫出 3 个误报，全是这种）。所以 0 参不报。
    //   2 参及以上 —— 正常。
    //   1 参 —— **可疑**：宿主调的是 `render(exec.arguments, value)`，所以唯一的参数
    //          实际接到的是 **args**。若参数名叫 value/result 之类，基本可断定作者
    //          想拿结果值却拿错了 → 高置信缺陷（dsh-knowledge 原本就是这种）。
    const flags = [];
    if (paramCount === 1) {
      flags.push(/^(value|val|v|result|res|data|output|payload)$/i.test(paramList.trim()) ? 'SIG1!' : 'SIG1?');
    } else if (paramCount > 2) {
      flags.push('SIGn?');
    }
    if (returns.length > 0 && stringish.length === returns.length) flags.push('SHAPE');
    else if (!hasBracket && stringish.length > 0) flags.push('SHAPE?');

    found.push({
      file, line: lineOf(source, m.index),
      params: paramList, paramCount,
      bodyKind: body.kind,
      returnCount: returns.length,
      stringReturns: stringish.length,
      arrayReturns: arrayish.length,
      hasBracket,
      flags,
      preview: body.text.replace(/\s+/g, ' ').trim().slice(0, 78),
    });
  }
  return found;
}

// ───────────────────────── 自检（可证伪性）─────────────────────────

/**
 * 只数**代码里**的 `render:`，跳过字符串与注释里的假匹配。
 *
 * 为什么不能直接用正则数：`"…failed to render: "` 这种字符串会被正则算进去
 * （实测 `dsh-agent-profiles/lib/client.js:288` 正是这种假匹配）。假匹配会把召回率
 * 提示变成噪音，进而让人忽略**真的**召回缺口。
 *
 * 与 {@link analyze} 的差别正在于此：analyze 只认 `render: (…) => …` 这一种写法；
 * 本函数把**任何**代码形态的 `render:` 都数上（含 `render(a, b) { … }` 方法语法）。
 * 两者相减 ⇒ 提取器漏掉的条数，这才是真正的召回率门禁。
 */
function countCodeRenders(src) {
  // 只数**属性形态** `render:` —— 与 {@link analyze} 覆盖同一语法类。
  //
  // 为什么不数方法语法 `render(a, b) { … }`（曾经数过，已撤）：
  //   ① 词法器不处理**正则字面量**。`render(a.replace(/)/, ''))` 里的 `)` 会被
  //      当成闭括号，配平错位后后续 `{` 被误判成方法定义 ⇒ 假阳性
  //      （实测 dsh-cordis-host-runner / dsh-tools 等文件被误报，而那些文件里
  //      `render:` 出现 **0 次**，ripgrep 与 .NET 双向确认）。
  //   ② 客户端打包产物里的 React 类 `render() { … }` 也会被计入 ⇒ 噪音。
  //   ③ 工具定义的通行写法就是属性形态，方法形态目前唯一实例是宿主
  //      `defineTool` 自己的归一化包装 `render(args, value) { … }`。
  //   代价：真有插件用方法语法写 render 时，本门禁看不到。这条写在文件头的边界里。
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (!src.startsWith('render', i) || /[\w$.]/.test(src[i - 1] ?? ' ')) continue;
    let j = i + 6;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === ':') { n++; i = j; }
  }
  return n;
}

/**
 * 由源码建「字节下标 → 行号」查询函数（自带二分，供自检与真实扫描共用）。
 *
 * ⚠ 返回的函数必须与 `analyze` 的调用约定一致：`lineOf(source, index)` —— **两个参数**。
 *   早先写成 `(idx)` 单参，而 analyze 传的是 `(source, index)`，于是 `idx` 实际收到
 *   整个源码字符串，比较全变 NaN、二分永远退到 lo=0 ⇒ **行号恒为 1**。
 *   这是纯静默错误（不抛错、只是每行都报 1），靠 `wantLine` 控制样本才抓到。
 */
const lineIndex = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (_source, idx) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};

// 控制样本。**覆盖不到 = 证明不了**：早先这组样本全是 1 参或 2 参，
// 缺「0 参合法」那一类，于是自检 7/7 通过、真实扫描却吐出 3 个误报。
// 教训：自检只能证明它覆盖到的形态，所以样本要按**合法/非法的全部形态**铺，
// 而不是只铺几种。`wantLine` 用来一并验证行号计算。
const CONTROLS = [
  { name: '坏：签名漏 args + 返回裸字符串',
    src: 'x = { render: (value) => "abc" }',
    want: ['SIG1!', 'SHAPE'] },
  { name: '坏：签名漏 args + 模板串',
    src: 'x = { render: (value) => `共 ${v} 条` }',
    want: ['SIG1!', 'SHAPE'] },
  { name: '坏：块体内 return 裸字符串',
    src: 'x = { render: (_args, value) => {\n if (a) return "x";\n return `y`;\n} }',
    want: ['SHAPE'] },
  { name: '坏：直接返回字符串字面量（双参）',
    src: 'x = { render: (_args, value) => "ok" }',
    want: ['SHAPE'] },
  { name: '可疑：单参但名字不像 value（可能是有意只取 args）',
    src: 'x = { render: (args) => [{ type: "text", text: String(args) }] }',
    want: ['SIG1?'] },
  { name: '合法：0 参常量渲染（曾被误报，必须不报）',
    src: 'x = { render: () => [{ type: "text", text: "fixed" }] }',
    want: [] },
  { name: '合法：0 参块体常量',
    src: 'x = { render: () => {\n return [{ type: "text", text: "fixed" }];\n} }',
    want: [] },
  { name: '好：块数组 + 双参',
    src: 'x = { render: (_args, value) => [{ type: "text", text: String(value) }] }',
    want: [] },
  { name: '好：块体全数组 + 双参',
    src: 'x = { render: (_args, value) => {\n if (a) return [{ type: "text", text: "x" }];\n return [{ type: "text", text: `y${v}` }];\n} }',
    want: [] },
  { name: '好：三元每支都是数组',
    src: 'x = { render: (_args, value) =>\n  value?.ok ? [{ type: "text", text: "a" }] : [{ type: "text", text: "b" }],\n}',
    want: [] },
  { name: '行号：render 在第 5 行，必须报 5',
    src: 'a\nb\nc\nd\nx = { render: (_args, value) => [{ type: "text", text: "z" }] }',
    want: [], wantLine: 5 },
];

console.log('══════ 自检：扫描器必须先能在坏样本上失败 ══════');
let controlFailed = 0;
for (const c of CONTROLS) {
  const lineOf = lineIndex(c.src);
  const got = analyze(c.src, '<control>', lineOf);
  const flags = got.length === 1 ? [...got[0].flags].sort() : ['<提取失败>'];
  const want = [...c.want].sort();
  const flagsOk = JSON.stringify(flags) === JSON.stringify(want);
  const lineOk = c.wantLine === undefined || (got.length === 1 && got[0].line === c.wantLine);
  const pass = flagsOk && lineOk;
  if (!pass) controlFailed++;
  console.log(`${pass ? '✅' : '❌'}  ${c.name}`);
  console.log(`      期望 flags=${JSON.stringify(want)}  实际=${JSON.stringify(flags)}`);
  if (!lineOk) console.log(`      期望 行=${c.wantLine}  实际=${got.length === 1 ? got[0].line : '<提取失败>'}`);
}

// 召回率门禁的自检：`countCodeRenders`（数代码里的 render）必须与 `analyze`
// （只认箭头函数写法）**形成可观测的差值**，否则召回率提示等于没有。
// 最后一条样本特意用方法语法 `render(a, b) { … }` —— analyze 认不出，
// countCodeRenders 认得，两者差 1 ⇒ 门禁确实能抓到「提取器漏了」。
const RECALL_CONTROLS = [
  { name: '召回：字符串里的 render 不算数', src: 'const s = "failed to render: x";', want: 0 },
  { name: '召回：行注释里的 render 不算数', src: '// render: nope\n', want: 0 },
  { name: '召回：块注释里的 render 不算数', src: '/* render: nope */\n', want: 0 },
  { name: '召回：renderKey 不算数', src: 'x = { renderKey: 1 }', want: 0 },
  { name: '召回：箭头式算 1', src: 'x = { render: (a, b) => [] }', want: 1 },
  { name: '召回：函数引用算 1（analyze 认不出，正是门禁要抓的）',
    src: 'x = { output: { schema: S, render: renderValue } }', want: 1 },
  { name: '召回：方法语法**不计**（已撤出范围，避免正则字面量导致假阳性）',
    src: 'defineTool({ render(a, b) { return [] } })', want: 0 },
  { name: '召回：非工具文件里的 render() 方法（React 类）不计',
    src: 'class X { clear() {}\n render() { return 1 } }', want: 0 },
];
console.log('');
console.log('══════ 自检：召回率门禁本身要能被触发 ══════');
let totalControls = CONTROLS.length;
for (const c of RECALL_CONTROLS) {
  totalControls++;
  const got = countCodeRenders(c.src);
  const pass = got === c.want;
  if (!pass) controlFailed++;
  console.log(`${pass ? '✅' : '❌'}  ${c.name}`);
  console.log(`      期望 countCodeRenders=${c.want}  实际=${got}`);
}
// 关键性质：**函数引用**形态让 analyze 漏、让 countCodeRenders 抓到 ⇒ 门禁有效。
// （这是实测出现过的一类：dsh-schedule 的 `render: renderValue`。）
{
  totalControls++;
  const refForm = 'x = { output: { schema: S, render: renderValue } }';
  const parsed = analyze(refForm, '<control>', lineIndex(refForm)).length;
  const counted = countCodeRenders(refForm);
  const pass = parsed === 0 && counted === 1;
  if (!pass) controlFailed++;
  console.log(`${pass ? '✅' : '❌'}  召回：函数引用必须造成「解析 0 / 计数 1」的可观测差`);
  console.log(`      analyze=${parsed}  countCodeRenders=${counted}`);
}

console.log('');
if (controlFailed > 0) {
  console.error(`自检未通过（${controlFailed}/${totalControls} 失败）—— 扫描结果不可信，已中止。`);
  process.exit(2);
}
console.log(`自检全部通过（${totalControls}/${totalControls}）—— 扫描器可证伪，继续。`);
console.log('');

// ───────────────────────── 真实扫描 ─────────────────────────

const ARGV = process.argv.slice(2);
const SCAN_ALL = ARGV.includes('--all');
// 不给扫描根就**默认扫本插件自己**（由 `import.meta.url` 反推）——
// 原来必须由外部脚本传一长串写死的安装路径，那样这个扫描器在别人的机器上根本没法用。
// 要给别的根就照旧：`node test/sweep-render-contract.mjs <根1> [根2 …]`。
const ROOTS = ARGV.filter((a) => a !== '--all');
if (ROOTS.length === 0) {
  ROOTS.push(pluginRoot);
  console.log(`未给扫描根 → 默认扫本插件：${pluginRoot}`);
  console.log('（要给别的根：node test/sweep-render-contract.mjs <根1> [根2 …]）');
  console.log('');
}

// 【扫描面界定】这个缺陷类只可能出现在**宿主侧的工具定义**里；客户端打包产物中的
//   `render:` 是 React 组件的 render prop（或是 PDF.js 之类库的内部方法），
//   不是工具输出契约，扫它只有噪音、还极慢（逐字符词法分析上千个 bundle）。
//
//   ⚠ 这里**不能用「文件含 `defineTool(`」当判据**：dsh-knowledge 用本地 `reg()`
//     包装注册工具，文件里根本没有 `defineTool(` 字样 —— 早先这么滤，profile 扫描
//     直接报「render 定义总数 0 / ✅ 干净」，**又一个假干净**。故改用**按路径排除**
//     客户端产物（`client.js` / `client.*.js` / `…/client/…`），宿主文件一律保留。
//
//   排除数量会被打印出来，让读者能看见过滤器确实动了手、而不是"什么都没扫"。
const isClientBundle = (p) =>
  /(^|[\\/])client(\.[\w-]+)?\.js$/i.test(p) || /[\\/]client[\\/]/i.test(p);
console.log(`扫描面：${SCAN_ALL ? '全量（--all，含客户端产物，慢）' : '排除客户端产物（client.js / client.*.js / …/client/…）'}`);
console.log('');

// 【必须跟随 Junction】profile 里的本地 bundle 全是 Junction（`node_modules/dsh-knowledge`
// → 源码目录）。Node 的 `Dirent.isDirectory()` 对 Junction 返回 **false**、只有
// `isSymbolicLink()` 为 true —— 早先的版本只看 isDirectory()，于是把 4 个 bundle
// 全跳过，扫出「0 个文件、0 个问题、一切干净」。那是最危险的假干净，所以这里：
//   ① 链接用 statSync（跟随）判断是否目录；
//   ② realpath 去重 + 深度上限，防链接成环；
//   ③ 调用方对「0 个文件」**失败关闭**，绝不报干净。
function walk(dir, acc = [], seen = new Set(), depth = 0) {
  if (depth > 12) return acc;
  let real;
  try { real = realpathSync(dir); } catch { return acc; }
  if (seen.has(real)) return acc;
  seen.add(real);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e.name);
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try { isDir = statSync(p).isDirectory(); } catch { isDir = false; }
    }
    if (isDir) walk(p, acc, seen, depth + 1);
    else if (e.isFile() && e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

let totalRenders = 0;
let totalFiles = 0;
let totalAnalyzed = 0;
let skippedByFilter = 0;
const findings = [];
const emptyRoots = [];
const recallNotes = [];

for (const root of ROOTS) {
  const files = walk(root);
  totalFiles += files.length;
  console.log(`── 扫描 ${root}  （${files.length} 个 .js）`);
  if (files.length === 0) {
    emptyRoots.push(root);
    console.log('   ⚠ 该根下 0 个 .js —— 遍历失败或路径为空。');
  } else {
    // 存活证明：打印前 3 个真实扫到的文件，让「它确实看了东西」可审计。
    for (const f of files.slice(0, 3)) console.log(`     · ${f}`);
    if (files.length > 3) console.log(`     · …另有 ${files.length - 3} 个`);
  }
  for (const f of files) {
    if (!SCAN_ALL && isClientBundle(f)) { skippedByFilter++; continue; }
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    if (!src.includes('render')) continue;
    totalAnalyzed++;
    const res = analyze(src, f, lineIndex(src));
    totalRenders += res.length;
    // 【召回率交叉核对】上面那套控制样本守的是**精确率**（会不会误报），
    //   守不住**召回率**（提取器会不会漏掉某个 render）。这里用最朴素的正则
    //   独立数一遍 `render:` 出现次数，与提取器实际解析出的条数对照：
    // 正则数 > 解析数 ⇒ 有 render 是提取器没认出来的（形状怪、不是我覆盖的写法），
    //   必须报出来人工看，而不是静默少算。
    //   这里用 countCodeRenders（跳过字符串/注释）而不是朴素正则 —— 否则
    //   `"…failed to render: "` 这类字符串假匹配会把提示变成噪音。
    const codeCount = countCodeRenders(src);
    if (codeCount !== res.length) recallNotes.push({ file: f, raw: codeCount, parsed: res.length });
    for (const r of res) if (r.flags.length > 0) findings.push(r);
  }
}

console.log('');
if (emptyRoots.length > 0) {
  console.error(`⛔ 有 ${emptyRoots.length} 个扫描根得到 0 个 .js —— 结果不可信，拒绝输出「干净」结论：`);
  for (const r of emptyRoots) console.error(`     ${r}`);
  process.exit(3);
}

console.log('══════ 结果 ══════');
console.log(`  扫到 .js 文件总数    : ${totalFiles}`);
console.log(`  按范围排除（客户端） : ${skippedByFilter}`);
console.log(`  实际读取分析的文件   : ${totalAnalyzed}   ← 含 render 且未被排除`);
console.log(`  扫到 render 定义总数 : ${totalRenders}`);
console.log(`  有问题的             : ${findings.length}`);
console.log('');
// 「读了文件但一个 render 都没找到」要么是真的没有，要么是提取器整体失灵。
// 两种可能必须能被区分开，故显式提示（不报错：确实可能 0 个）。
if (totalAnalyzed > 0 && totalRenders === 0) {
  console.log(`  ⚠ ${totalAnalyzed} 个文件含 "render" 字样，但**一个 render 定义都没解析出来**。`);
  console.log('     要么该范围内确实没有工具，要么提取器整体失灵 —— 请人工确认后再采信「干净」。');
  console.log('');
}
if (recallNotes.length > 0) {
  console.log(`  ⚠ 召回率提示：${recallNotes.length} 个文件里「正则数」与「解析数」不一致 ——`);
  console.log('     代表有 render 没被提取器认出来（或是注释/字符串里的假匹配）。逐条人工看一眼：');
  for (const n of recallNotes) console.log(`      正则 ${n.raw} / 解析 ${n.parsed}   ${n.file}`);
  console.log('');
}
if (findings.length === 0) {
  console.log('  ✅ 未发现签名/返回形状违规。');
} else {
  console.log('  文件                                                      行   签名            flags    returns(串/数组)');
  console.log('  ' + '─'.repeat(118));
  for (const r of findings) {
    const short = r.file.length > 56 ? '…' + r.file.slice(-55) : r.file;
    console.log(`  ${short.padEnd(56)} ${String(r.line).padStart(5)}  ${r.params.padEnd(14)} ${r.flags.join(',').padEnd(8)} ${r.returnCount}(${r.stringReturns}/${r.arrayReturns})`);
    console.log(`      ${r.preview}`);
  }
}
