/**
 * make-roomsend-control.mjs —— 生成「**把这次修复拆掉**」的对照副本。
 *
 * ## 为什么要有它
 *
 * 「修复有效」这句话只有在**同一套断言**跑在「没修的那份」上会变红时才算证据。
 * 否则那些断言可能只是空转（跑在什么代码上都通过）。
 *
 * ## 对照怎么拆
 *
 * 只动**这次改动的那两处判据**，不碰别的东西 —— 拆法就是「把 `roomOnly` 恒为 false」，
 * 等于把代码恢复成改前的行为：
 *   ① `onTeamSend`：哨兵不再被认作「只挂房间」⇒ 没 @ 谁的消息按旧的私聊/投递语义走；
 *   ② `/__teamchat/send`：`target` 缺失时又折成空串 ⇒ 在 `deliverToMembers` 里变成**广播**。
 *
 * ⚠ 生成完必须**逐条核对改写真的发生了**：一个静默 no-op 的生成器会产出一份
 *   「跟正本一模一样」的对照，于是它当然全绿 —— 那是假证据。
 *   （2026-10-09 那轮就吃过这个：改写次数 0 却没人发现。）
 *
 * ## 用法
 *   node test/make-roomsend-control.mjs                 # 从本插件 lib/ 生成
 *   node test/make-roomsend-control.mjs <lib 目录> <输出目录>
 * 退出码：0 = 生成并核对通过；1 = 有改写没发生（**拒绝**产出一份假对照）。
 */
import fs from "node:fs";
import path from "node:path";
import { srcDir } from "./_harness.mjs";

const SOURCE_LIB = path.resolve(process.argv[2] ?? srcDir);
const OUT_ROOT = path.resolve(process.argv[3] ?? path.join(srcDir, "..", "test", "_room-send-control"));
const OUT_LIB = path.join(OUT_ROOT, "lib");

/** 要同步过去的模块 —— `index.js` 的相对 import 全在里面。 */
const FILES = [
  "index.js",
  "member-runtime.js",
  "member-store.js",
  "room-log.js",
  "room-tools.js",
  "succession.js",
  "team-bus.js",
  "timeline-projection.js",
  // 客户端 bundle 不是 `index.js` 的依赖，但**这轮改动有一半在它里面**，
  // 所以对照副本也要有一份（`test/room-send-wiring.test.mjs` 拿它当对照）。
  "client.js",
];

/**
 * 三处改写：把这次的判据拆掉。
 *
 * `from` 必须**恰好出现一次** —— 这正是「生成器没空转」的判据。
 */
const SABOTAGE = [
  {
    label: "① 哨兵不再被认作「只挂房间」（输入框那条路）",
    from: "        const roomOnly = target === ROOM_ONLY_TARGET;\n"
      + "        if (!roomOnly) sendScope.delete(session.id); // 一次性",
    to: "        const roomOnly = false; // ← 对照：拆掉修复\n"
      + "        sendScope.delete(session.id); // 一次性",
  },
  {
    label: "①b 「只挂房间」那一支整块拿掉（不 return、不补 delivered）",
    from: "        if (roomOnly) {\n"
      + "          patchRoomEntry(roomKey, entryId, { delivered: true, targetNames: [], targetName: null });\n"
      + "          pushRoom(roomKey);\n"
      + "          // 客户端收到这一帧会把「发送到团队」的显示复位（范围已消费）。\n"
      + '          broadcast({ type: "team-send", sessionId: session.id, target: ROOM_ONLY_TARGET, delivered: [] });\n'
      + "          return;\n"
      + "        }",
    to: "        // ← 对照：拆掉修复（只挂房间那一支整块拿掉）",
  },
  {
    label: "② `target` 缺失时又折成空串（= 在 deliverToMembers 里变成广播）",
    from: '          const explicitTarget = typeof rawTarget === "string" ? rawTarget.trim() : null;',
    to: '          const explicitTarget = typeof rawTarget === "string" ? rawTarget.trim() : ""; // ← 对照',
  },
  {
    label: "③ `/send` 也不再走「只挂房间」那一支",
    from: "          const roomOnly = explicitTarget === null || explicitTarget === ROOM_ONLY_TARGET;",
    to: "          const roomOnly = false; // ← 对照：拆掉修复",
  },
  {
    label: "④ 客户端不再在房间视图里装填「只发到房间」",
    file: "client.js",
    from: "\t\t\t\tvoid pushScopeTarget(sessionId, inChatRoom ? ROOM_ONLY_TARGET : null).catch((error) =>\n"
      + '\t\t\t\t\treport("compose.arm", error),\n'
      + "\t\t\t\t);",
    to: "\t\t\t\t// ← 对照：拆掉修复（房间视图里不再装填「只发到房间」）\n"
      + "\t\t\t\tvoid 0;",
  },
];

const problems = [];
fs.mkdirSync(OUT_LIB, { recursive: true });

const rewriteCount = { "index.js": 0, "client.js": 0 };

for (const name of FILES) {
  const from = path.join(SOURCE_LIB, name);
  if (!fs.existsSync(from)) {
    problems.push(`缺模块：${from}`);
    continue;
  }
  let text = fs.readFileSync(from, "utf8");
  for (const rule of SABOTAGE) {
    if ((rule.file ?? "index.js") !== name) continue;
    const hits = text.split(rule.from).length - 1;
    if (hits !== 1) {
      problems.push(`改写「${rule.label}」命中 ${hits} 次（必须恰好 1 次）—— 生成器与源码脱节了`);
      continue;
    }
    text = text.replace(rule.from, rule.to);
    rewriteCount[name] += 1;
    console.log(`OK   改写[${name}]：${rule.label}`);
  }
  if (rewriteCount[name] === 0) {
    problems.push(`${name} 一处改写都没发生 —— 产出会是一份假对照`);
  }
  fs.writeFileSync(path.join(OUT_LIB, name), text, "utf8");
  console.log(`     写出：${path.join(OUT_LIB, name)}`);
}

// 逐条核对落盘结果：光看内存里的字符串不算（写失败也会让上面全绿）。
const expectMarkers = { "index.js": 4, "client.js": 1 };
for (const [name, want] of Object.entries(expectMarkers)) {
  const written = fs.readFileSync(path.join(OUT_LIB, name), "utf8");
  const markers = (written.match(/\/\/ ← 对照/g) ?? []).length;
  console.log(`落盘核对[${name}]：对照标记 ${markers} 处（期望 ${want}）`);
  if (markers !== want) problems.push(`${name} 落盘的对照标记只有 ${markers} 处，期望 ${want} 处`);

  // 正本必须**没有**这些标记（否则说明改写打在了正本上）。
  const original = fs.readFileSync(path.join(SOURCE_LIB, name), "utf8");
  const originalMarkers = (original.match(/\/\/ ← 对照/g) ?? []).length;
  console.log(`正本核对[${name}]：正本里的对照标记 ${originalMarkers} 处（期望 0）`);
  if (originalMarkers !== 0) problems.push(`正本 ${name} 被打上了对照标记（${originalMarkers} 处）—— 这次生成污染了源码`);
}

if (problems.length > 0) {
  console.log("");
  for (const p of problems) console.log(`★ ${p}`);
  console.log("生成失败：拒绝产出一份看起来像对照、其实是空转的副本。");
  process.exit(1);
}
console.log("");
console.log(`对照副本就绪：${OUT_LIB}`);
console.log("跑它：node test/room-direct-send.test.mjs test/_room-send-control/lib/index.js");
