/**
 * room-send-wiring.test.mjs —— 「房间直发」这条链的**跨文件接线**核对。
 *
 * ## 为什么需要它（以及它**不是**什么）
 *
 * 宿主那半有真跑用例（`room-direct-send.test.mjs`：真 `apply()` + 真路由 + 真
 * `agent.steer` 计数）。但这条链还有**另一半在客户端 bundle 里** ——
 * 「用户在房间视图里打字时，把 `ROOM_ONLY_TARGET` 装填成该会话的范围」。
 * 少了那一半，宿主的修复根本不会被触发：消息仍然按私聊处理。
 *
 * ⚠ 本文件是**源码契约扫描，不是渲染测试**。它证明的是「接线在那儿、两边的
 *   哨兵逐字符相同、中英文案都齐」；它**不**证明组件在真 DOM 里跑起来的样子。
 *   渲染级验证需要真 DOM / 测试渲染器，本仓库当前没有（`client-test.mjs` 只
 *   在**无 DOM**下直接调无 hook 的组件）。所以最终验收仍然是用户刷新页面实测。
 *
 * 之所以还能拿它当证据，是因为它**带对照**：`make-roomsend-control.mjs` 生成的
 * 那份副本把装填拆掉了 —— 同一套断言跑在它身上必须变红（见运行器 :EXPECT-FAIL）。
 *
 * ## 用法
 *   node test/room-send-wiring.test.mjs                       # 本插件 lib/
 *   node test/room-send-wiring.test.mjs test/_room-send-control/lib
 * 退出码：0 = 全部接线在位；1 = 有缺失。
 */
import fs from "node:fs";
import path from "node:path";
import { pluginFile } from "./_harness.mjs";

const LIB = path.resolve(process.argv[2] ?? path.dirname(pluginFile("client.js")));
const CLIENT = path.join(LIB, "client.js");
const HOST = path.join(LIB, "index.js");

const lines = [];
const say = (text = "") => lines.push(text);
let failures = 0;

const checkTrue = (label, actual, note = "") => {
  const ok = actual === true;
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"} ${label}${note === "" ? "" : ` :: ${note}`}`);
};
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  say(`${ok ? "PASS" : "FAIL"} ${label}`);
  say(`     实际=${JSON.stringify(actual)}`);
  say(`     期望=${JSON.stringify(expected)}`);
};

const readOr = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    return `__READ_FAIL__ ${error?.message ?? error}`;
  }
};

/** 从源码里抽出某个常量的字面量：`const NAME = "…";`。抽不到返回 null。 */
const literalOf = (text, name) => {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*"([^"]*)"`, "u").exec(text);
  return m === null ? null : m[1];
};

const countOf = (text, needle) => text.split(needle).length - 1;

const client = readOr(CLIENT);
const host = readOr(HOST);

say(`被测 lib：${LIB}`);
say("");
say("── ① 哨兵：客户端与宿主必须**逐字符相同** ──────────────────");
const clientSentinel = literalOf(client, "ROOM_ONLY_TARGET");
const hostSentinel = literalOf(host, "ROOM_ONLY_TARGET");
check("客户端抽到了 ROOM_ONLY_TARGET", typeof clientSentinel === "string", true);
check("宿主抽到了 ROOM_ONLY_TARGET", typeof hostSentinel === "string", true);
check("两边逐字符相同（不同 = 协议对不上，静默失效）", clientSentinel, hostSentinel);
checkTrue(
  "哨兵的字符集不可能与真实成员名撞（成员名只允许 a-z 0-9 -）",
  clientSentinel !== null && !/^[a-z0-9-]+$/u.test(clientSentinel),
  String(clientSentinel),
);

say("");
say("── ② 客户端：房间视图里装填、离开时清掉 ────────────────────");
check(
  "装填那一句在（inChatRoom ⇒ 哨兵；否则 null）",
  countOf(client, "void pushScopeTarget(sessionId, inChatRoom ? ROOM_ONLY_TARGET : null).catch((error) =>"),
  1,
);
check(
  "cleanup 会清掉（切视图/切会话/卸载都覆盖）",
  countOf(client, "void pushScopeTarget(sessionId, null).catch(() => {});"),
  1,
);
check(
  "依赖里有 inChatRoom（否则视图切换不重跑）",
  countOf(client, "}, [inChatRoom, sessionId]);"),
  1,
);

say("");
say("── ③ 客户端：一次性范围被消费后要**重新装填** ──────────────");
check(
  "`team-send` 回执里按仍在房间视图重新装填",
  countOf(client, "if (inChatRoomRef.current === true) {"),
  1,
);
check(
  "重新装填用的还是同一个哨兵",
  countOf(client, "void pushScopeTarget(sessionId, ROOM_ONLY_TARGET).catch((error) =>"),
  1,
);

say("");
say("── ④ 客户端：默认值要说人话（中英双语）────────────────────");
check("按钮文案分支认哨兵", countOf(client, '? t("compose.roomOnly")'), 1);
check("气泡分支认「只挂房间」", countOf(client, 'entry.delivered === true ? t("chat.roomOnly")'), 1);
for (const key of ["compose.roomOnly", "chat.roomOnly"]) {
  check(`字典里有 ${key}（zh + en 各一份）`, countOf(client, `"${key}":`), 2);
}
checkTrue("zh 侧：只发到房间", client.includes('"compose.roomOnly": "只发到房间"'));
checkTrue("en 侧：Room only", client.includes('"compose.roomOnly": "Room only"'));
checkTrue("zh 侧：只挂进聊天室", client.includes('"chat.roomOnly": "只挂进聊天室（没有投递给任何人）"'));
checkTrue("en 侧：Room only (delivered to nobody)", client.includes('"chat.roomOnly": "Room only (delivered to nobody)"'));

say("");
say("── ⑤ 宿主：哨兵 ⇒ 只挂房间、且**不删**哨兵 ─────────────────");
check("onTeamSend 认哨兵", countOf(host, "const roomOnly = target === ROOM_ONLY_TARGET;"), 1);
check(
  "哨兵不被当成一次性消费掉",
  countOf(host, "if (!roomOnly) sendScope.delete(session.id); // 一次性"),
  1,
);
check(
  "只挂房间的分支在两处都在（输入框那条路 + `chatroom_send` 那条路）",
  countOf(host, "if (roomOnly) {"),
  2,
);
check(
  "只挂房间的条目：delivered 补成 true（「本来就没人要收」口径）—— 两条路同一写法",
  countOf(host, "patchRoomEntry(roomKey, entryId, { delivered: true, targetNames: [], targetName: null });"),
  2,
);
check(
  "只挂房间时也要广播复位帧（客户端据此把「发送到团队」复位）",
  countOf(host, 'broadcast({ type: "team-send", sessionId: session.id, target: ROOM_ONLY_TARGET, delivered: [] });'),
  1,
);

say("");
say("── ⑥ 宿主：`/__teamchat/send` 收件人三态 ───────────────────");
check(
  "没给 target ⇒ null（不能再折成空串 = 广播）",
  countOf(host, 'const explicitTarget = typeof rawTarget === "string" ? rawTarget.trim() : null;'),
  1,
);
check(
  "三态判据在",
  countOf(host, "const roomOnly = explicitTarget === null || explicitTarget === ROOM_ONLY_TARGET;"),
  1,
);
check("只挂房间时不投递", countOf(host, "const delivered = roomOnly\n            ? []\n            : await deliverToMembers("), 1);

say("");
say(`== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ==`);
say(failures === 0 ? "OK — 接线全部在位" : `FAIL — ${failures} 项接线缺失`);
const report = lines.join("\n") + "\n";
fs.writeSync(1, report);
process.exit(failures === 0 ? 0 : 1);
