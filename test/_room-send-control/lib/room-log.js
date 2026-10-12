/**
 * 房间时间线的**持久化**存储。
 *
 * ## 为什么需要它
 *
 * 2026-10-09 用户报：「我们的聊天室的聊天记录要进行持久化。不然我第二次进去
 * 以后，我之前的聊天记录就消失了」。
 *
 * 改版前这套日志只活在宿主内存里（`Map`），DSH 一重启就空 —— 而成员窗口里的
 * 历史却都在（那是官方会话日志）。两边表现不一致，用户当然觉得是坏的。
 *
 * ## 文件形状
 *
 * `<数据目录>/room-timeline.json`：
 *
 * ```json
 * { "version": 1, "rooms": { "<房间键>": [ {id, senderName, ...}, ... ] } }
 * ```
 *
 * 房间键 = **工作区目录**（见 `roomKeyOf`），所以同一工作室的窗口共用一条。
 * 目录可能很长且含中文 —— JSON 顶层键正好无所谓。
 *
 * ## 三条不变量
 *
 * 1. **原子写**（先写 `.tmp` 再 rename）：断电/崩溃不留半个文件。
 * 2. **永远不抛错**：读坏了当空库（下次写就覆盖回去），写失败只记 `lastError`。
 *    聊天室读不出历史是遗憾，插件起不来是事故。
 * 3. ⭐ **条目 id 是幂等的**：同一个 `id` 只认第一条。
 *    这一条是 2026-10-09「一条回复变成两个气泡」的修法 ——
 *    与其去猜宿主为什么把同一个事件派发两次，不如让「记一次」本身幂等。
 *    调用方要用**事件自身的身份**做 id（`session.id` + `event.seq` / `turn`），
 *    而不是 `randomUUID()`。
 */

import fs from "node:fs/promises";
import path from "node:path";

/** 落盘格式版本。形状变了就递增，老文件按空库处理。 */
export const ROOM_LOG_VERSION = 1;

/** 单个房间最多保留多少条。500 条 × 几十字节 ≈ 几十 KB，够用且不会长胖。 */
export const MAX_ENTRIES_PER_ROOM = 500;

/**
 * 最多保留多少个房间。
 *
 * 房间键是工作区目录 —— 用户可能开过很多目录，无限留着会让文件慢慢长胖。
 * 超了按「最后一条消息的时间」丢最旧的。
 */
export const MAX_ROOMS = 50;

/** 落盘防抖间隔：连着来一串消息时不要每来一条写一次盘。 */
const SAVE_DEBOUNCE_MS = 600;

/**
 * 把一条来路不明的条目规范化成可渲染的形状；不合规返回 `null`。
 *
 * 只做**结构**校验，不做业务校验 —— 读的是自己写的文件，但仍然要防
 * 「手工改坏了 / 上个版本写的」这类情况把渲染体拖垮。
 *
 * @param value - 待规范化的值。
 * @returns 规范化后的条目，或 null。
 */
function normalizeEntry(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const id = typeof value.id === "string" && value.id !== "" ? value.id : null;
  if (id === null) return null;
  const blocks = (Array.isArray(value.blocks) ? value.blocks : []).filter(
    (block) => block !== null && typeof block === "object" && typeof block.type === "string",
  );
  // 没有任何可用内容块的条目直接丢掉 —— 它只会渲染成一个空气泡。
  // 本项目自建的条目**必有正文**（三个调用点都会先判空再记），
  // 所以正常数据走不到这一支；能走到就说明文件被改坏了。
  if (blocks.length === 0) return null;
  const targetNames = Array.isArray(value.targetNames)
    ? value.targetNames.filter((name) => typeof name === "string")
    : [];
  return {
    id,
    senderName: typeof value.senderName === "string" ? value.senderName : "unknown",
    targetName: typeof value.targetName === "string" ? value.targetName : null,
    targetNames,
    blocks,
    at: typeof value.at === "string" ? value.at : null,
    delivered: value.delivered === true,
  };
}

/**
 * 一个房间最后一条消息的时间（用来挑最旧的那些房间丢掉）。
 *
 * 解析不出时间就当作 0 —— 「先丢没有时间的」，比随机丢更可预期。
 *
 * @param entries - 条目数组。
 * @returns 毫秒时间戳。
 */
function lastAt(entries) {
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const value = Date.parse(entries[at]?.at ?? "");
    if (!Number.isNaN(value)) return value;
  }
  return 0;
}

export class RoomLog {
  /**
   * @param dataDir - 插件数据目录（与 members.json 同处）。
   */
  constructor(dataDir) {
    this.file = path.join(dataDir, "room-timeline.json");
    /** 房间键 -> 条目数组。数组是**原地**增长的，读方拿到的是活引用。 */
    this.rooms = new Map();
    this.loaded = false;
    /** 最近一次失败原因，供诊断路由读取。 */
    this.lastError = null;
    this.timer = null;
  }

  /**
   * 某个房间的条目。**返回活引用**（与改版前的 `Map.get(...) ?? []` 行为一致，
   * 调用方只读）。
   *
   * @param roomKey - 房间键。
   * @returns 条目数组（可能是空数组）。
   */
  entriesOf(roomKey) {
    return this.rooms.get(roomKey) ?? [];
  }

  /**
   * 这个房间里已经有这个 id 了吗。
   *
   * @param roomKey - 房间键。
   * @param id - 条目 id。
   * @returns 是否存在。
   */
  has(roomKey, id) {
    return this.entriesOf(roomKey).some((row) => row.id === id);
  }

  /**
   * 追加一条。**同 id 幂等**：已经有就直接返回 false。
   *
   * @param roomKey - 房间键。
   * @param entry - 条目；`at` 缺省补当前时间。
   * @returns 是否真的新增了。
   */
  append(roomKey, entry) {
    if (typeof roomKey !== "string" || roomKey === "") return false;
    const normalized = normalizeEntry(entry);
    if (normalized === null) return false;
    const list = this.rooms.get(roomKey) ?? [];
    // ⭐ 幂等：同一个事件被派发两次、或投递与回复各记一遍时，只留第一条。
    if (list.some((row) => row.id === normalized.id)) return false;
    list.push({ ...normalized, at: normalized.at ?? new Date().toISOString() });
    if (list.length > MAX_ENTRIES_PER_ROOM) {
      // 超上限从**头部**截断，并保证不切断「一坨连续消息」——
      // 直接把 slice 出来的第一条也丢掉，避免留下半坨。
      list.splice(0, list.length - MAX_ENTRIES_PER_ROOM);
    }
    this.rooms.set(roomKey, list);
    this.schedule();
    return true;
  }

  /**
   * 就地改一条已存在的条目。
   *
   * 为什么需要：投递是**异步**的，而「我说的这句话」必须**立刻**出现在聊天室里。
   * 所以先记一笔 `delivered:false`，等投递结果回来再把「发给了谁」补上。
   *
   * @param roomKey - 房间键。
   * @param id - 条目 id。
   * @param patch - 要合并的字段。
   * @returns 是否改动了。
   */
  patch(roomKey, id, patch) {
    const list = this.rooms.get(roomKey);
    if (list === undefined) return false;
    const at = list.findIndex((row) => row.id === id);
    if (at === -1) return false;
    list[at] = { ...list[at], ...patch };
    this.schedule();
    return true;
  }

  /**
   * 把新的正文段并进已有条目 —— 「一个 turn 走多步」时用。
   *
   * ## 为什么合并而不是新增一条
   *
   * 官方每**步**追加一条 `assistant/message`（`dsh-agent-loop/lib/index.js:1144`），
   * 而用户在成员窗口里看到的是**一个 turn 一坨**。不合并就会出现
   * 「对话里一个收到、聊天室里两个」（2026-10-09 用户报的第 1 条）。
   *
   * ⚠ 完全相同的段直接丢掉：那是「同一个事件被派发两次」，
   *   合并进去会在一个气泡里印两遍同样的话。
   *
   * @param roomKey - 房间键。
   * @param id - 条目 id。
   * @param blocks - 新的内容块。
   * @returns 是否改动了。
   */
  mergeBlocks(roomKey, id, blocks) {
    const list = this.rooms.get(roomKey);
    if (list === undefined) return false;
    const at = list.findIndex((row) => row.id === id);
    if (at === -1) return false;
    const existing = list[at];
    const merged = [...existing.blocks];
    let changed = false;
    for (const block of blocks) {
      const duplicated = merged.some(
        (row) => row.type === block.type && row.text === block.text,
      );
      if (duplicated) continue;
      merged.push(block);
      changed = true;
    }
    if (!changed) return false;
    list[at] = { ...existing, blocks: merged };
    this.schedule();
    return true;
  }

  /**
   * 内存态快照（落盘用）。
   *
   * @returns `{version, rooms}`。
   */
  snapshot() {
    const rooms = {};
    for (const [roomKey, entries] of this.rooms) {
      if (typeof roomKey !== "string" || roomKey === "" || entries.length === 0) continue;
      rooms[roomKey] = entries;
    }
    return { version: ROOM_LOG_VERSION, rooms };
  }

  /**
   * 从磁盘加载。**不抛错**：坏了当空库并记下原因。
   *
   * @returns 加载是否成功（文件不存在也算"正常首次运行"，返回 true）。
   */
  async load() {
    try {
      const text = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || typeof parsed.rooms !== "object") {
        throw new Error("形状不对：缺 rooms");
      }
      if (parsed.version !== ROOM_LOG_VERSION) {
        throw new Error(`版本不支持：${String(parsed.version)}`);
      }
      const rooms = new Map();
      for (const [roomKey, entries] of Object.entries(parsed.rooms ?? {})) {
        if (typeof roomKey !== "string" || roomKey === "" || !Array.isArray(entries)) continue;
        const kept = entries.map(normalizeEntry).filter((row) => row !== null);
        if (kept.length === 0) continue;
        // 老文件里可能有重复 id（旧版本没有幂等）—— 读回来时顺手去重。
        const seen = new Set();
        rooms.set(
          roomKey,
          kept.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true))),
        );
      }
      this.rooms = rooms;
      this.loaded = true;
      this.lastError = null;
      return true;
    } catch (error) {
      // ENOENT = 首次运行，不是错误。
      if (error?.code !== "ENOENT") {
        this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
      }
      this.rooms = new Map();
      this.loaded = true;
      return error?.code === "ENOENT";
    }
  }

  /**
   * 安排一次落盘（防抖）。
   *
   * 定时器 `unref` —— 不该拖住宿主退出。
   */
  schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /**
   * 立刻落盘（原子写）。**不抛错**，失败只记 `lastError`。
   *
   * @returns `{ok, error?}`。
   */
  async flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      this.prune();
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const text = JSON.stringify(this.snapshot(), null, 2) + "\n";
      await fs.writeFile(tmp, text, "utf8");
      await fs.rename(tmp, this.file);
      this.lastError = null;
      return { ok: true };
    } catch (error) {
      try {
        await fs.rm(tmp, { force: true });
      } catch {
        /* 清理失败无所谓 */
      }
      this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
      return { ok: false, error: this.lastError };
    }
  }

  /**
   * 房间数超上限时丢掉最旧的几个。
   *
   * 只在落盘前调用 —— 内存里多留几个无所谓，文件别长胖就行。
   */
  prune() {
    if (this.rooms.size <= MAX_ROOMS) return;
    const ordered = [...this.rooms.entries()].sort((a, b) => lastAt(a[1]) - lastAt(b[1]));
    for (const [roomKey] of ordered.slice(0, this.rooms.size - MAX_ROOMS)) {
      this.rooms.delete(roomKey);
    }
  }

  /**
   * 诊断信息（`/__teamchat/config` 用）。
   *
   * @returns 文件、房间数、条目数、最近错误。
   */
  describe() {
    let entries = 0;
    for (const list of this.rooms.values()) entries += list.length;
    return {
      file: this.file,
      rooms: this.rooms.size,
      entries,
      loaded: this.loaded,
      error: this.lastError,
    };
  }
}
