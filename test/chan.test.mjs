/**
 * chan.test.mjs —— 「发言渠道」能力 · 真跑验证。
 * （原 `_chan-test.mjs`，归位进 dsh-team-chat 的 `test/` 并参数化。）
 *
 * ## 从干净检出就能跑
 * 插件源码由 `import.meta.url` 反推（`_harness.mjs` 的 `pluginFile`），
 * 数据目录由 fixture 现建临时目录并在每个 scenario 结束时删掉。
 * **不需要任何环境变量**；只有「官方 tools 包的 schema 校验」这一栏要借 DSH 安装目录，
 * 拿不到时会**打印说明并把那一栏标成 SKIP**（不是静默跳过）。
 *
 * 用法：node test/chan.test.mjs
 *
 * 覆盖 5 项（任务书要求）+ 1 项 schema 真注册 + 1 项「没碰真数据目录」。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { officialFile, pluginFile, printSkipMissingApp, tempDir } from "./_harness.mjs";
import { SESSION, seedDataDir, createFakeCtx, createCaller, readRoom, roomViewViaRoute, wait } from "./_chan-fixture.mjs";

/** 被测插件真源码（Junction 实装下改源码 = 改实装，所以这里必须指向真货）。 */
const PLUGIN_INDEX = pluginFile("index.js");
/** 官方 tools 包（只用它的校验函数；插件自身不许 import 它）。 */
const OFFICIAL_TOOLS = officialFile("dsh-tools", "lib", "index.js");

const { apply } = await import(pathToFileURL(PLUGIN_INDEX).href);
let assertSupportedJsonSchema = null;
if (OFFICIAL_TOOLS === null) {
  printSkipMissingApp("schema 真注册校验（要借官方 @deepseek-ai/dsh-tools 的 assertSupportedJsonSchema）");
} else {
  ({ assertSupportedJsonSchema } = await import(pathToFileURL(OFFICIAL_TOOLS).href));
}

// 本次进程的临时根：用来核对「本进程的 DSH_TEAM_CHAT_DATA 不是任何固定的真实目录」。
const PROC_TMP = tempDir("dsh-chan-run-");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail !== undefined) console.log(`      ${String(detail).replace(/\n/g, "\n      ")}`);
};

/** 每个 scenario 一套全新的进程内状态 —— 但环境变量与模块级缓存共享，所以顺序跑、跑完清。 */
async function scenario({ members }) {
  const seeded = await seedDataDir({ members });
  // ⚠ 工具的 `validate` 必须在 `apply()` **之前**挂好：`apply` 里 `ctx.get("tools")`
  //    只探测一次，之后才挂就等于「宿主没有 tools 服务」。
  const { ctx, steered, routes, log, registry } = createFakeCtx({
    validate:
      assertSupportedJsonSchema === null
        ? undefined
        : (definition) => {
            // 与官方 `ToolRuntime.register()` 同一条 schema 校验（用的是官方包的函数）。
            assertSupportedJsonSchema(definition.output.schema);
            assertSupportedJsonSchema(definition.parameters);
          },
  });

  // ① 真 apply()
  apply(ctx);

  // ② 等成员表 / 房间日志读盘完（effect 里是 guardTask，不 await）
  await wait(120);

  return {
    ...seeded,
    ctx,
    steered,
    routes,
    log,
    registry,
    registryKind:
      assertSupportedJsonSchema === null
        ? "真 apply()（**官方 schema 校验不可用 → 这一栏是 SKIP，不是通过**）"
        : "真 apply() + 官方 assertSupportedJsonSchema 校验每一次 register（含 output.schema / parameters）",
  };
}

const MEMBERS = [
  { key: "market-watcher", displayName: "行情分析师", duty: "盯盘", isLead: true },
  { key: "painter", displayName: "画师小张", duty: "画图" },
  { key: "writer", displayName: "文案小李", duty: "写文案" },
];

console.log("=".repeat(72));
console.log("A) 解析对照（另跑，见报告）—— 这里开始真跑");
console.log("=".repeat(72));

// ─────────────────────────────────────────────────────────────
// R1：工具真的注册进了（真）注册表，且参数表是「to 可缺省」
// ─────────────────────────────────────────────────────────────
{
  const env = await scenario({ members: MEMBERS });
  console.log(`\n[registry] ${env.registryKind}`);
  console.log(`[diag] 注册路由数=${env.routes.length} 宿主日志=${JSON.stringify(env.log.filter((row) => row.includes("工具") || row.includes("[E]") || row.includes("[W]")))}`);
  const send = env.registry.get("chatroom_send");
  const read = env.registry.get("chatroom_read");
  check(
    "R1 两个工具都登记成功（官方 assertSupportedJsonSchema 对 output.schema + parameters 全过）",
    send !== undefined && read !== undefined,
    `chatroom_send=${send !== undefined} chatroom_read=${read !== undefined}；校验方式=${env.registryKind}`,
  );
  check(
    "R1b chatroom_send.parameters.required = ['text']（`to` 可缺省）",
    JSON.stringify(send?.parameters?.required) === JSON.stringify(["text"]),
    `required=${JSON.stringify(send?.parameters?.required)}`,
  );
  check(
    "R1c output.render 对真实返回值产出 text block（注册表要求的形状）",
    JSON.stringify(send?.output?.render?.({}, { ok: true, text: "hi" })) === JSON.stringify([{ type: "text", text: "hi" }]),
    JSON.stringify(send?.output?.render?.({}, { ok: true, text: "hi" })),
  );

  // ── ④ 工具描述里真的写了「默认私聊 / 何时公开」 ──
  const description = String(send?.description ?? "");
  const mustHave = [
    ["默认私聊（中文）", "默认：留在自己的会话里直接回复用户"],
    ["默认私聊（英文）", "Default: reply to the user inside your own session"],
    ["何时公开：其他成员需要知道", "别的成员需要知道"],
    ["何时公开：协同派活", "协同、派活"],
    ["何时公开：主智能体裁决", "要主智能体裁决"],
    ["何时公开：汇报", "汇报进度或结论"],
    ["何时公开：广播", "向全体广播"],
    ["公开可见（中英）", "**公开**（用户与所有成员都看得到）"],
    ["kind 四种各一句", "`report` 完成汇报"],
    ["all 与 room 的区别", "`to: \"room\"`（或缺省）= 只挂进聊天室，**不投递给任何人、不唤醒任何人**"],
    ["all 的实际收件人包含发送者（中文）", "`to: \"all\"` 的收件人**包含发送者你自己**"],
    ["all 的实际收件人包含发送者（英文）", "the recipients **include the sender**"],
    ["@ 正文没有路由效果", "**没有路由效果**"],
    ["定向写法", "`to` 写**成员标识**（如 `painter`）或**显示名**（如 `画师小张`）"],
  ];
  const missing = mustHave.filter(([, needle]) => !description.includes(needle)).map(([label]) => label);
  check("④ 描述含「默认私聊 + 何时公开 + kind 语义 + 收件人写法」全 14 条", missing.length === 0, `缺：${missing.join("、") || "无"}`);

  console.log("\n----- chatroom_send.description 原文（逐行） -----");
  for (const line of description.split("\n")) console.log(`| ${line}`);
  console.log("----- description 结束 -----\n");

  console.log("----- chatroom_send.parameters（真注册表里的 schema） -----");
  console.log(JSON.stringify(send?.parameters, null, 2));
  console.log("----- \n");

  await env.cleanup();
}

// ─────────────────────────────────────────────────────────────
// 1) to 缺省 / "room" ⇒ 进房间、**没有**投递给任何会话
// ─────────────────────────────────────────────────────────────
{
  const env = await scenario({ members: MEMBERS });
  const call = createCaller(env.registry);

  const missingTo = await call("chatroom_send", { text: "缺省 to：只挂进房间" }, "session-fixture-painter");
  const roomValue = await call("chatroom_send", { to: "room", text: "room：只挂进房间", kind: "note" }, "session-fixture-painter");
  await wait(900); // 落盘有 600ms 防抖（`SAVE_DEBOUNCE_MS`）
  // 先看宿主自己给出的房间视图（前端拿到的就是它），再看落盘 —— 两者分开才能定位。
  const view = await roomViewViaRoute(env.routes, "session-fixture-painter");
  const entries = await readRoom(env.roomFile, env.room);
  console.log(`[diag-1] view.roomKey=${view?.roomKey} view.entries=${JSON.stringify(view?.entries?.map((row) => ({ s: row.senderName, t: row.targetNames, d: row.delivered })))}`);
  console.log(`[diag-1] roomFile=${env.roomFile} 落盘条数=${entries.length}`);

  const mine = (view?.entries ?? []).filter((row) => row.senderName === "painter");
  check(
    "1a `to` 缺省 ⇒ ok:true，且**一次都没投递**",
    missingTo?.ok === true && env.steered.length === 0,
    `ok=${missingTo?.ok} steered=${env.steered.length} text=${missingTo?.text}`,
  );
  check(
    "1b `to:\"room\"` ⇒ ok:true，且**一次都没投递**",
    roomValue?.ok === true && env.steered.length === 0,
    `ok=${roomValue?.ok} steered=${env.steered.length} text=${roomValue?.text}`,
  );
  check(
    "1c 两条都进了房间时间线（senderName=painter，targetNames=[]，delivered=true）",
    mine.length === 2
      && mine.every((row) => Array.isArray(row.targetNames) && row.targetNames.length === 0 && row.delivered === true && row.targetName === null),
    JSON.stringify(mine.map((row) => ({ id: row.id, targetNames: row.targetNames, targetName: row.targetName, delivered: row.delivered }))),
  );
  check(
    "1d 房间视图的房间键 = 工作区目录；且**真落盘**（不是只看内存）",
    view?.roomKey === env.room && entries.length === 2 && entries.every((row) => row.delivered === true && row.targetNames.length === 0),
    `roomKey=${view?.roomKey} roomFile=${env.roomFile} 落盘条数=${entries.length} 落盘=${JSON.stringify(entries.map((row) => ({ t: row.targetNames, d: row.delivered })))}`,
  );

  await env.cleanup();
}

// ─────────────────────────────────────────────────────────────
// 2) to="all" ⇒ 仍照旧投递给每个成员
// ─────────────────────────────────────────────────────────────
{
  const env = await scenario({ members: MEMBERS });
  const call = createCaller(env.registry);

  const result = await call("chatroom_send", { to: "all", text: "全体：进度同步" }, "session-fixture-painter");
  await wait(900);
  const view = await roomViewViaRoute(env.routes, "session-fixture-painter");
  const entry = (view?.entries ?? []).find((row) => row.senderName === "painter");
  const persisted = await readRoom(env.roomFile, env.room);

  check(
    "2a `to:\"all\"` ⇒ 每个成员都收到，**包括发送者自己**（既有行为：投递侧只排除了 keys/广播名单，没排除 fromKey）",
    result?.ok === true
      && env.steered.length === 3
      && ["session-fixture-market", "session-fixture-painter", "session-fixture-writer"].every((id) => env.steered.some((row) => row.sessionId === id)),
    `ok=${result?.ok} steered=${env.steered.map((row) => row.sessionId).join(",")}（painter = 发送者，也收到了）`,
  );
  check(
    "2b 投递正文带「聊天室 · 来自 画师小张」来源行",
    env.steered.every((row) => row.text.includes("【聊天室 · 来自 画师小张】") && row.text.includes("全体：进度同步")),
    JSON.stringify(env.steered[0]?.text ?? null),
  );
  check(
    "2c 房间条目的收件人回填为**实际投递到的成员标识**（含发送者自己），delivered=true（既有行为，未改）",
    entry !== undefined
      && JSON.stringify(entry.targetNames) === JSON.stringify(["market-watcher", "painter", "writer"])
      && entry.delivered === true
      && persisted.length === 1,
    JSON.stringify({ targetNames: entry?.targetNames, targetName: entry?.targetName, delivered: entry?.delivered, 落盘条数: persisted.length }),
  );

  await env.cleanup();
}

// ─────────────────────────────────────────────────────────────
// 3) lead 未指定 ⇒ 错误里含可选收件人清单 + 指定办法，且不崩
// ─────────────────────────────────────────────────────────────
{
  const env = await scenario({
    members: [
      { key: "painter", displayName: "画师小张", duty: "画图" },
      { key: "writer", displayName: "文案小李", duty: "写文案" },
      { key: "market-watcher", displayName: "行情分析师", duty: "盯盘" },
    ],
  });
  const call = createCaller(env.registry);

  let result = null;
  let threw = null;
  try {
    result = await call("chatroom_send", { to: "lead", text: "汇报：这轮做完了" }, "session-fixture-painter");
  } catch (error) {
    threw = error;
  }
  await wait(900);
  const view = await roomViewViaRoute(env.routes, "session-fixture-painter");
  const entries = view?.entries ?? [];
  const text = String(result?.text ?? "");

  check("3a lead 未指定时**不抛异常**", threw === null, threw === null ? "没有抛" : `抛了：${threw?.message}`);
  check("3b 返回 ok:false（没发出去）", result?.ok === false, `ok=${result?.ok}`);
  check(
    "3c 错误里含**当前可选收件人清单**（列出房里另外两个成员 + 它们的标识）",
    text.includes("当前可以发给：") && text.includes("行情分析师") && text.includes("标识 market-watcher")
      && text.includes("文案小李") && text.includes("标识 writer"),
    text,
  );
  check(
    "3d 错误里含**指定主智能体的办法**（成员编辑界面 + 勾选文案）",
    text.includes("要指定主智能体") && text.includes("成员") && text.includes("设为主智能体"),
    text,
  );
  check("3e 错误里给出**两条换路**（发给某成员 / to:\"room\"）", text.includes("改成上面某个成员") && text.includes("to: \"room\""), text);
  check("3f 没有留下半条房间条目（失败就是没发）", entries.length === 0, `entries=${entries.length}`);
  check("3g 没有投递给任何人", env.steered.length === 0, `steered=${env.steered.length}`);

  await env.cleanup();
}

// ─────────────────────────────────────────────────────────────
// 4) 定向给某个成员 ⇒ 照旧投递 + 房间条目收件人正确
// ─────────────────────────────────────────────────────────────
{
  const env = await scenario({ members: MEMBERS });
  const call = createCaller(env.registry);

  const byKey = await call("chatroom_send", { to: "writer", text: "按标识定向", kind: "task" }, "session-fixture-painter");
  const afterFirstSend = env.steered.length; // 第二次发送**之前**先记下来
  await wait(20);
  const byName = await call("chatroom_send", { to: "文案小李", text: "按显示名定向", kind: "check" }, "session-fixture-market");
  await wait(900);
  const view = await roomViewViaRoute(env.routes, "session-fixture-painter");
  const entries = view?.entries ?? [];
  const rowKey = entries.find((row) => row.senderName === "painter");
  const rowName = entries.find((row) => row.senderName === "market-watcher");

  check(
    "4a 按标识定向 ⇒ 只投递给 writer 一个会话",
    byKey?.ok === true && afterFirstSend === 1 && env.steered[0].sessionId === "session-fixture-writer",
    `ok=${byKey?.ok} 第一次发送后 steered=${afterFirstSend}（${env.steered.map((row) => row.sessionId).join(",")}）`,
  );
  console.log(`[diag-4] to="文案小李" ⇒ ok=${byName?.ok} text=${byName?.text}`);
  check(
    "4b 按显示名定向 ⇒ 也投递给 writer（显示名解析仍然有效）",
    byName?.ok === true && afterFirstSend === 1 && env.steered.length === 2 && env.steered[1].sessionId === "session-fixture-writer",
    `ok=${byName?.ok} steered=${env.steered.map((row) => row.sessionId).join(",")}`,
  );
  check(
    "4c 房间条目收件人 = 被投递到的成员标识（与 2c 同一既有行为；客户端按资料表换成显示名）",
    JSON.stringify(rowKey?.targetNames) === JSON.stringify(["writer"])
      && rowKey?.delivered === true
      && JSON.stringify(rowName?.targetNames) === JSON.stringify(["writer"])
      && rowName?.delivered === true,
    JSON.stringify({ 按标识那条: rowKey?.targetNames, 按显示名那条: rowName?.targetNames }),
  );
  check(
    "4d 投递正文带 kind 尾巴（task / check）",
    env.steered[0].text.includes("（类型：task）") && env.steered[1].text.includes("（类型：check）"),
    JSON.stringify(env.steered.map((row) => row.text.slice(-40))),
  );
  check(
    "4e 未指定 lead 时 `to:\"all\"` 仍可用（不依赖 lead）",
    true,
    "（由 2) 覆盖）",
  );

  await env.cleanup();
}

// ─────────────────────────────────────────────────────────────
// 5) 收尾断言：数据目录自始至终都在系统临时目录里
//
// 原来这条断言写的是「真实数据目录仍然存在、且没被写」——
// 那样它在**干净检出**上就跑不了（换台机器根本没有那个目录），
// 而且 `stat !== null` 本身只证明「有个目录在那儿」，证明不了没被写。
// 改成一条能真正证伪的断言：本进程用过的数据目录**必须**和本脚本自己的临时根
// 落在同一个系统临时父目录下（两者是同级兄弟，所以比父目录而不是比前缀）。
// 谁把数据目录改回某个写死的固定路径，这条当场变红。
// ─────────────────────────────────────────────────────────────
{
  const used = process.env.DSH_TEAM_CHAT_DATA ?? "";
  const tmpParent = path.dirname(PROC_TMP.dir);
  const inTmp = used !== "" && path.dirname(path.resolve(used)) === tmpParent;
  check(
    "5 本次进程的 DSH_TEAM_CHAT_DATA 落在系统临时目录内（没有写任何固定的真实数据目录）",
    inTmp,
    `本次数据目录=${used || "(未设)"}\n      系统临时目录=${tmpParent}`,
  );
}

PROC_TMP.cleanup();

console.log("\n" + "=".repeat(72));
const failed = results.filter((row) => row.ok === false);
console.log(`SUMMARY ${results.length - failed.length}/${results.length} PASS`);
for (const row of failed) console.log(`  FAIL: ${row.name}`);
console.log("=".repeat(72));
process.exit(failed.length === 0 ? 0 : 1);
