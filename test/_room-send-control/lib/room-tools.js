/**
 * 聊天室工具：**给 AI 成员用的**两个模型面工具。
 *
 * ## 为什么要有这个文件
 *
 * 2026-10-09 用户问：「我们的 AI 是否能看到聊天室、能否在聊天室里艾特其他智能体、
 * 我们是否写了相应的工具给它」。核实结果是三个「没有」：
 *
 * - 成员**看不到聊天室** —— 房间日志（`roomLog`）只喂给前端，没有任何一条路喂给成员；
 * - 成员**不能 @** —— `@` 是客户端 UI 概念（输入框里的芯片），宿主侧没有「@ → 路由」；
 * - 也没有专门的工具 —— 只有一段写在开场消息里的「写文件到信箱」协议。
 *
 * 所以这里补上两个**真正的工具**（走官方 `ctx.tools.register`，
 * 不再靠「教它写文件」）：
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `chatroom_read` | 读聊天室最近的消息（可以只看点名给自己的） |
 * | `chatroom_send` | 在聊天室里**点名发给**某个成员（= @ 它，同时投递给它） |
 *
 * ## 设计要点（每一条都是踩过的坑或明确的产品判断）
 *
 * 1. **不 import 官方包。** `ctx.tools.register` 只校验
 *    `name` / `output{schema,render}` / `parameters`，普通插件直接给**裸 JSON Schema**
 *    就能注册（`defineTool` 只是把 DSL 编译成它）。我们的插件目录下没有
 *    `@deepseek-ai/*`，import 会 MODULE_NOT_FOUND ⇒ 一律手写定义。
 * 2. **收件人可以用「标识」也可以用「显示名」。** 用户给成员取的是中文名，
 *    而信箱目录名必须是 ASCII 标识 —— 旧协议只认标识，中文名写进去会被丢弃。
 * 3. **收件人写错要说清楚。** 旧路径把失败文件挪进 `mailbox/failed/` 就完了，
 *    发送方**永远以为发出去了**。工具的返回值里必须带上「可以发给谁」。
 * 4. **正文要能被独立读懂。** 收件方看不到发送方的会话上下文，
 *    所以描述里明确要求写清「我做了什么 / 结果在哪 / 需要你做什么」。
 * 5. **返回 `{ok, text}` 而不是抛错**（收件人写错这种是**可修正的用户错误**）：
 *    结果里带一行「改成 X 再发一次」比抛异常更容易让模型自我纠正。
 *
 * ## 纯函数 + 依赖注入
 *
 * 本文件不碰 ctx、不碰文件系统 —— 所有宿主能力由 `deps` 注入，
 * 所以能在脚手架里用假 deps 真跑一遍（见 `smoke-room-tools.mjs`）。
 */

/** 一次能读到多少条消息的默认值 / 上限。 */
export const READ_DEFAULT_LIMIT = 30;
export const READ_MAX_LIMIT = 200;

/** `kind` 的取值 —— 与信箱协议保持一致（老路径写的文件也认这几个）。 */
export const MESSAGE_KINDS = ["note", "report", "check", "task"];

/** 广播收件人的写法（谁都认）。 */
const BROADCAST_ALIASES = ["all", "*", "全部", "所有人", "大家"];

/**
 * 「只挂进房间、不投递给任何人」的写法。
 *
 * 与 `all` 的区别就是这个数组存在的理由：`all` 是**逐个投递 + 唤醒**，
 * 而这里一条都不投 —— 消息只落在房间时间线上给人看。
 */
const ROOM_ONLY_ALIASES = ["room", "房间", "仅房间"];

/** 主智能体的别名 —— 与 `index.js` 里信箱路径的判定保持一致。 */
const LEAD_ALIASES = ["lead", "main", "主智能体", "main-agent"];

/**
 * 把时间戳格式化成 `HH:MM`（模型不关心秒，且在正文里越短越好）。
 *
 * @param at - ISO 时间串。
 * @returns `HH:MM`；解析不出时返回空串。
 */
function clock(at) {
  const value = Date.parse(at ?? "");
  if (Number.isNaN(value)) return "";
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 一条消息的正文（多个 text 块拼起来）。
 *
 * @param entry - 房间条目。
 * @returns 拼好的正文。
 */
function bodyOf(entry) {
  return (Array.isArray(entry?.blocks) ? entry.blocks : [])
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * 一条条目点名了谁（`targetNames` 新的、`targetName` 老的）。
 *
 * @param entry - 房间条目。
 * @returns 收件人标识数组。
 */
function targetsOf(entry) {
  if (Array.isArray(entry?.targetNames) && entry.targetNames.length > 0) return entry.targetNames;
  return typeof entry?.targetName === "string" && entry.targetName !== "" ? [entry.targetName] : [];
}

/**
 * 名册里找一个收件人：**标识优先，显示名其次**（大小写不敏感）。
 *
 * @param roster - 成员行数组。
 * @param wanted - 用户/模型给的收件人写法。
 * @returns 命中的成员行，或 undefined。
 */
function findMember(roster, wanted) {
  const needle = String(wanted ?? "").trim().toLowerCase();
  if (needle === "") return undefined;
  return (
    roster.find((row) => String(row.key ?? "").toLowerCase() === needle) ??
    roster.find((row) => String(row.displayName ?? "").trim().toLowerCase() === needle) ??
    roster.find(
      // 显示名带空格/后缀时的宽松兜底（「分析师小张（盯盘）」也认「分析师小张」）。
      (row) => String(row.displayName ?? "").toLowerCase().startsWith(needle) && needle.length >= 2,
    )
  );
}

/**
 * 名册渲染成一行文字（标识 + 显示名 + 职责 + 主智能体标记）。
 *
 * @param roster - 成员行数组。
 * @param selfKey - 「我」的标识（标记出来，省得它自己给自己发）。
 * @returns 一行文字。
 */
function rosterLine(roster, selfKey) {
  if (roster.length === 0) return "（这个聊天室里目前只有你）";
  return roster
    .map((row) => {
      const name = row.displayName === "" || row.displayName === undefined ? row.key : row.displayName;
      const tags = [];
      // ⚠ **标识一定要给出来**：它是成员的正名 ——
      //   文件信箱那条路（`to` 写目录名）只认它，而显示名是用户随手取的中文名。
      //   只给显示名的话，模型在降级路径上必然写错收件人。
      if (row.key !== name) tags.push(`标识 ${row.key}`);
      if (row.key === selfKey) tags.push("就是你");
      if (row.isLead === true) tags.push("主智能体");
      if (typeof row.duty === "string" && row.duty !== "") tags.push(row.duty);
      return tags.length === 0 ? name : `${name}（${tags.join(" / ")}）`;
    })
    .join("、");
}

/**
 * 把房间条目渲染成给模型看的聊天记录。
 *
 * 每条一行、`[时间] 谁 → 谁：正文`。**点名给自己的那条要一眼看出来** ——
 * 用户明确要求「能够看到艾特他的智能体的信息」。
 *
 * @param options - `{roomKey, selfKey, roster, entries}`。
 * @returns 纯文本聊天记录。
 */
export function formatRoomText({ roomKey, selfKey, roster, entries }) {
  const byKey = new Map(roster.map((row) => [row.key, row]));
  const nameOf = (key) =>
    key === null || key === undefined
      ? ""
      : (byKey.get(key)?.displayName ?? (key === selfKey ? "你" : key));

  const lines = entries.map((entry) => {
    const when = clock(entry.at);
    const from = nameOf(entry.senderName);
    const targets = targetsOf(entry);
    const mentionsMe = targets.includes(selfKey);
    const arrow =
      targets.length === 0
        ? ""
        : ` → ${targets.map((key) => (key === selfKey ? "**你**" : nameOf(key))).join("、")}`;
    const mark = mentionsMe ? " ⬅点名给你" : "";
    const body = bodyOf(entry);
    const status = entry.delivered === false && targets.length > 0 ? "（未投递）" : "";
    return `${when === "" ? "" : `[${when}] `}${from}${arrow}：${body}${status}${mark}`;
  });

  return [
    `聊天室（房间 ${roomKey}）最近 ${entries.length} 条消息：`,
    "",
    ...(lines.length === 0 ? ["（这里还没有消息）"] : lines),
    "",
    `成员：${rosterLine(roster, selfKey)}`,
  ].join("\n");
}

/**
 * 造出两个模型面工具的**定义**（形状与官方 `ctx.tools.register` 要求的完全一致）。
 *
 * ⚠ 刻意不 import `@deepseek-ai/dsh-tools`：`register` 只要
 *   `{name, description, parameters, output:{schema,render}, execute}`，
 *   `defineTool` 的作用只是把 DSL 编译成这个形状。我们的插件目录下没有官方包，
 *   import 会 MODULE_NOT_FOUND（整个插件加载失败）——**少一个 import 少一类事故**。
 *
 * @param deps - 宿主能力注入：
 *   - `resolveCaller(sessionId)` → `{memberKey, displayName, roomKey}` 或 `null`
 *   - `rosterOf(roomKey)` → `[{key, displayName, duty, isLead}]`（**不含调用者自己**也行，渲染时按 key 标记）
 *   - `readEntries(roomKey, limit)` → 房间条目数组（旧的在前）
 *   - `send({fromKey, displayName, roomKey, keys, broadcast, roomOnly, text, kind})` → `Promise<{ok, error?}>`
 *     （`roomOnly: true` = 只记进房间时间线、**不投递给任何会话**；此时 `keys` 为空）
 *   - `logger(message)` → 可选，登记失败之类
 * @returns 工具定义数组。
 */
export function createRoomTools(deps) {
  /** 通用的「调用者是谁」解析 + 教学式报错文案。 */
  const identify = (exec) => {
    const sessionId = exec?.agent?.id;
    const caller = typeof sessionId === "string" ? deps.resolveCaller(sessionId) : null;
    if (caller === null || caller === undefined) {
      return {
        error:
          "这个工具只在「聊天室的 AI 成员会话」里可用，当前会话不是这个聊天室的成员。"
          + "如果你是主智能体或执行成员，请在用户把你加入聊天室之后再调用。",
      };
    }
    return { caller };
  };

  const chatroomRead = {
    name: "chatroom_read",
    description: [
      "读取当前聊天室最近的消息（只读）。",
      "",
      "什么时候用：",
      "- 你想知道「聊天室里刚才发生了什么」「有没有人点名叫我」时；",
      "- 你写完了东西、准备汇报之前，想确认一下上下文时。",
      "",
      "要点：",
      "- 你自己窗口里的对话**不在**这个聊天室里 —— 聊天室是团队共用的那块地方；",
      "- 点名给你的消息会标 `⬅点名给你`，用 `only_mentions: true` 可以只看这些；",
      "- 你无法靠这个工具「等」别人的回复：它返回的是**此刻的快照**。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: `最多返回多少条（默认 ${READ_DEFAULT_LIMIT}，上限 ${READ_MAX_LIMIT}）。`,
        },
        only_mentions: {
          type: "boolean",
          description: "只返回点名给你的消息（以及你自己发的）。默认 false = 全部。",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean", description: "读取是否成功。" },
          text: { type: "string", description: "渲染好的聊天记录（给模型读的就是它）。" },
        },
        required: ["ok", "text"],
      },
      // ⚠ 渲染成 text block —— 与官方 `GOAL_OUTPUT` 同一套写法。
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    async execute(args, exec) {
      const identified = identify(exec);
      if (identified.error !== undefined) return { ok: false, text: identified.error };
      const { caller } = identified;

      const rawLimit = typeof args?.limit === "number" && Number.isFinite(args.limit) ? args.limit : READ_DEFAULT_LIMIT;
      const limit = Math.max(1, Math.min(READ_MAX_LIMIT, Math.floor(rawLimit)));
      const onlyMentions = args?.only_mentions === true;

      const roster = deps.rosterOf(caller.roomKey);
      let entries = deps.readEntries(caller.roomKey, limit * 4);
      if (onlyMentions) {
        entries = entries.filter(
          (entry) => targetsOf(entry).includes(caller.memberKey) || entry.senderName === caller.memberKey,
        );
      }
      entries = entries.slice(-limit);

      return {
        ok: true,
        text: formatRoomText({ roomKey: caller.roomKey, selfKey: caller.memberKey, roster, entries }),
      };
    },
  };

  const chatroomSend = {
    name: "chatroom_send",
    description: [
      "把一条消息发进**聊天室**（公开区域）。在聊天室里定向发给某个人 = @ 它，那条消息会投递给它、唤醒它。",
      "Post a message into the **room** (the public area). Addressing a member delivers it to that member and wakes it up.",
      "",
      "**默认：留在自己的会话里直接回复用户**（私聊）—— 不进聊天室、不需要这个工具。",
      "**Default: reply to the user inside your own session** (private) — not into the room, and no tool needed.",
      "",
      "只有这些情况才发进聊天室 / Use the room only when:",
      "- 别的成员需要知道这件事 · other members need to know it",
      "- 要协同、派活 · coordination or assigning work",
      "- 要主智能体裁决 · you need the lead to decide",
      "- 汇报进度或结论 · reporting progress or a conclusion",
      "- 向全体广播 · broadcasting to everyone",
      "",
      "发进聊天室 = **公开**（用户与所有成员都看得到）—— 只该给用户看的内容别发进来。",
      "Anything posted here is **public** to the user and every member — keep user-only content out.",
      "",
      "`kind`（默认 note）/ `kind` values (default note):",
      "- `note` 普通留言 · a plain note",
      "- `report` 完成汇报 · finished work",
      "- `check` 请人验收 · asking for review",
      "- `task` 派活 · assigning work",
      "",
      "收件人 / Recipient:",
      "- 定向给某个成员：`to` 写**成员标识**（如 `painter`）或**显示名**（如 `画师小张`）；",
      "  To address one member, set `to` to its key (`painter`) or display name.",
      "- `to: \"lead\"` = 主智能体（汇报用）；`to: \"all\"` = 投递给房里**每个成员**；",
      "- ⚠ `to: \"all\"` 的收件人**包含发送者你自己** —— 它是「房里所有成员」而**不排除你**，",
      "  所以你会收到自己刚发的那条；不想收到自己那条就改用 `to: \"room\"`。",
      "  (⚠ With `to: \"all\"` the recipients **include the sender** — it means every member of the room, you included —",
      "  so you will receive your own message back; use `to: \"room\"` if you do not want that.)",
      "- `to: \"room\"`（或缺省）= 只挂进聊天室，**不投递给任何人、不唤醒任何人**。",
      "",
      "正文里写 `@某某`：**没有路由效果** —— 只有 `to` 决定这条消息投给谁。",
      "`@name` inside `text` does **not** route anything: only `to` decides the recipient.",
      "",
      "要点 / Notes:",
      "- **对方看不到你的会话上下文**，正文要写清：你做了什么、结果在哪、需要它做什么；",
      "- 一次一条，要发多条就多调几次；返回 `ok:false` 时**别用同样的写法重试**，按返回里的提示换收件人。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "收件人：成员标识或显示名；`lead` = 主智能体（汇报用）；"
            + "`all` = 投递给房里**每个成员（含发送者你自己）**（会唤醒他们）；"
            + "`room` 或缺省 = 只挂进聊天室，不投递给任何人。",
        },
        text: {
          type: "string",
          description: "消息正文。对方看不到你的上下文，写清楚「做了什么 / 结果在哪 / 需要它做什么」。",
        },
        kind: {
          type: "string",
          enum: MESSAGE_KINDS,
          description: `可选的消息类型：${MESSAGE_KINDS.join(" / ")}。默认 note。`,
        },
      },
      required: ["text"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean", description: "是否真的发出去了。" },
          text: { type: "string", description: "结果说明（成功说投给了谁；失败说原因与可选收件人）。" },
        },
        required: ["ok", "text"],
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
    },
    async execute(args, exec) {
      const identified = identify(exec);
      if (identified.error !== undefined) return { ok: false, text: identified.error };
      const { caller } = identified;

      const text = typeof args?.text === "string" ? args.text.trim() : "";
      if (text === "") return { ok: false, text: "正文是空的。请把要说的话写进 `text`。" };
      if (text.length > 4000) {
        return { ok: false, text: `正文 ${text.length} 字，超过 4000 字上限。请拆成几条发。` };
      }
      const kind = MESSAGE_KINDS.includes(args?.kind) ? args.kind : "note";

      const roster = deps.rosterOf(caller.roomKey).filter((row) => row.key !== caller.memberKey);
      const wanted = String(args?.to ?? "").trim();

      /** 失败时统一给「可以发给谁」—— 这一句就是旧路径「静默丢消息」的修法。 */
      const noTarget = (headline) =>
        [
          headline,
          "",
          `当前可以发给：${rosterLine(roster, caller.memberKey)}`,
          "（写 `lead` 汇报给主智能体，写 `all` 投递给所有人；"
            + "`to: \"room\"` 或**不写 `to`** 只挂进聊天室、不打扰任何人。）",
        ].join("\n");

      let keys = [];
      let broadcast = false;
      // 显式布尔，不用 `keys.length === 0` 反推 —— 那是**推论**：现在只有这一支
      // 会留空 keys，但将来多一条「本该报错」的分支就会悄悄变成「静默只挂房间」。
      let roomOnly = false;
      if (wanted === "" || ROOM_ONLY_ALIASES.includes(wanted.toLowerCase())) {
        // ① 只进房间时间线，**不投递给任何会话**（`all` 才逐个投递 + 唤醒）。
        keys = [];
        broadcast = false;
        roomOnly = true;
      } else if (BROADCAST_ALIASES.includes(wanted.toLowerCase())) {
        broadcast = true;
        keys = roster.map((row) => row.key);
      } else if (LEAD_ALIASES.includes(wanted.toLowerCase())) {
        const lead = roster.find((row) => row.isLead === true);
        if (lead === undefined) {
          // ② 没有主智能体时**别只说「没指定」** —— 把可选收件人与指定办法一并给出，
          //    这样模型能自己换条路（发给某个成员 / 只挂房间 / 直接回用户），不会卡死。
          return {
            ok: false,
            text: noTarget(
              "这个聊天室还没有指定主智能体，所以 `to: \"lead\"` 现在没人收 —— 这条**没有发出去**。"
              + "（No member is designated as the lead right now, so `lead` is unroutable.）",
            )
            + "\n"
            + "要指定主智能体：在「成员」编辑界面勾上「设为主智能体」（一个聊天室只有一个）。\n"
            + "想现在就把话发出去：`to` 改成上面某个成员，或写 `to: \"room\"` 只挂进聊天室，"
            + "或者干脆留在自己的会话里直接回复用户。",
          };
        }
        keys = [lead.key];
      } else if (wanted.toLowerCase() === caller.memberKey.toLowerCase()) {
        return { ok: false, text: "收件人是你自己。要留给自己的笔记直接写在自己的会话里就行，不用发到聊天室。" };
      } else {
        const hit = findMember(roster, wanted);
        if (hit === undefined) {
          return { ok: false, text: noTarget(`聊天室里没有叫「${wanted}」的成员，这条**没有发出去**。`) };
        }
        keys = [hit.key];
      }

      // ⚠ 只有「定向 + 广播」需要收件人；`room` 那条路本来就**不投递**，
      //   所以不能拿 `keys.length === 0` 当失败（那样等于把 ① 又堵回去）。
      if (!roomOnly && keys.length === 0) {
        return { ok: false, text: noTarget("这个聊天室里还没有别的成员，没有收件人。") };
      }

      try {
        const result = await deps.send({
          fromKey: caller.memberKey,
          displayName: caller.displayName,
          roomKey: caller.roomKey,
          keys,
          broadcast,
          roomOnly,
          text,
          kind,
        });
        if (result?.ok !== true) {
          return {
            ok: false,
            text: [
              `投递失败：${result?.error ?? "未知原因"}。`,
              "",
              `当前可以发给：${rosterLine(roster, caller.memberKey)}`,
            ].join("\n"),
          };
        }
        const names = keys.map((key) => roster.find((row) => row.key === key)?.displayName ?? key);
        return {
          ok: true,
          text: broadcast
            ? `已广播给聊天室里的 ${names.length} 个成员：${names.join("、")}。（他们会各自收到，聊天室里也会显示这条。）`
            : names.length === 0
              ? "已挂进聊天室（只进房间时间线，**没有投递给任何会话**）。"
              : `已发给「${names[0]}」。它会收到这条消息，聊天室里也会显示「你 → ${names[0]}」。`,
        };
      } catch (error) {
        return { ok: false, text: `投递时出错：${error?.message ?? String(error)}` };
      }
    },
  };

  return [chatroomRead, chatroomSend];
}
