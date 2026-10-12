/**
 * dsh-team-chat — client 侧入口（浏览器 bundle）。
 *
 * 形态必须是 `window.__ModuleLoader__.load({id, factory})` 的 lazy-CJS，
 * **不是 ESM** —— DSH 用普通 <script src> 加载客户端 bundle，
 * 出现 `export` 语句会直接 `Uncaught SyntaxError: Unexpected token 'export'`，
 * 并连带 `web boot: N entry did not activate`，整个插件层加载失败。
 *
 * 注册五件事：
 * 1. `conversation.view`               —— 团队聊天室视图（主区域）
 * 2. `conversation.session.header.actions` —— 右上角「成员」菜单（查看/编辑智能体）
 * 3. `conversation.input.left`         —— 输入框工具栏左侧的「发送到团队」入口
 * 4. `conversation.input.permission`   —— **影子掉**宿主的权限选择器（priority 更小者胜）
 * 5. `settings.general.item`           —— 「启用官方智能体团队」开关
 *
 * 关于输入框：**不自绘**。宿主的 composer（含文本框、文件上传、`@` 路径补全、
 * 模型选择）直接复用，我们只做两件事 —— 影子掉权限选择器、往工具栏左侧加一个
 * 「发给谁」的成员选择器（选中后写进官方 draft）。
 *
 * 槽位目录（89 个槽 + 契约 + 官方范例）在
 * `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 的 `CLIENT_SLOT_API`
 * 里，是排查「这个槽能不能用」的第一手资料。
 */
(() => {
	// ── 诊断上报 ───────────────────────────────────────────────
	// DSH 在桌面端只把渲染进程的 console 转成 `[renderer] [stderr] <按行>`，
	// 多行堆栈会被拆散、丢掉换行，`web boot: N entry did not activate` 的
	// 详细原因就看不见了。这里把原始错误 POST 回宿主，落进 harness.log。
	//
	// 用同步 XHR：激活失败发生在启动关键路径上，异步请求可能没发出去页面就停了。
	const report = (label, error) => {
		try {
			const text = `[${label}] ${error?.stack ?? error?.message ?? String(error)}`;
			const xhr = new XMLHttpRequest();
			xhr.open("POST", "/__teamchat/report", false);
			xhr.send(text);
		} catch {
			/* 上报本身失败就算了，不能影响主流程 */
		}
	};

	// 幂等栅栏。
	//
	// 这份脚本会被 `tapIndex` 注入到 index.html，而 DSH 的前端插件恢复流程
	// 可能在同一次会话里再执行一遍。loader 遇到同一个 id 二次调用 `load()`
	// 会直接抛 `duplicate factory registration`，进而
	// `web boot: 1 entry did not activate`。
	//
	// 重复执行本身无害（factory 是惰性的、注册是幂等的），所以这里只是别再问一次。
	const KEY = "__DSH_TEAM_CHAT_REGISTERED__";
	const loader = globalThis.window?.__ModuleLoader__;
	if (loader === undefined) return;
	if (globalThis[KEY] === true) return;
	globalThis[KEY] = true;

	try {
		loader.load({
			id: "dsh-team-chat",
			factory: (require) => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

				var react = require("react");
				// `react-dom` 在 `staticModules` 种子表里，是官方允许依赖的基线之一
				// （`react` / `react-dom` / `cordis` 属基线；其余 client-ui-* 禁止）。
				// 官方 `experimental-client-ui-agent-team` 的 TeamAction 就用了 createPortal。
				var reactDom = require("react-dom");

		/** 视图唯一 id。 */
		const VIEW_ID = "team-chat";

		/**
		 * 官方「对话」视图的条目 id。
		 *
		 * 来自 `dsh-client-ui-chat/lib/client.js:12390` 的
		 * `ctx.slots.register({ name: "conversation.view", id: "chat", order: 0, … })`。
		 */
		const CHAT_VIEW_ID = "chat";

		/**
		 * 官方会话 store 的持久化前缀。
		 *
		 * 来自 `dsh-client-ui-conversation/lib/client.js:3166`
		 * `const CONVERSATION_STORE_KEY = "dsh.conversation";`
		 *
		 * 每个会话存一位：键是 `${CONVERSATION_STORE_KEY}.${sessionId}`。
		 * 官方两侧都用它：写靠 `defineStore({persist})`
		 * （`dsh-client-store/lib/index.js:151` 拼 `${persist}.${scopeKey}`，
		 * 创建实例时水合、每次变更回写），读靠
		 * `readConversationViewPreference(sessionId)`（同文件 `:3204`）。
		 */
		const CONVERSATION_STORE_KEY = "dsh.conversation";

		/**
		 * 把某个会话「上次停在哪个视图」改成**对话 tab**。
		 *
		 * ## 为什么必须动存储，而不是调用某个 API
		 *
		 * 主区的视图是 `renderSlot("conversation.session", {})` 渲染的
		 * （`dsh-client-ui-conversation/lib/client.js:16202`）—— **不传 `view`**。
		 * 只有官方 subagent 的嵌入式会话会传（同 `dsh-client-ui-subagent/lib/client.js:770`
		 * 的 `FixedChatConversationView`：`renderSlot("conversation.session", { view: "chat" })`），
		 * 那是它自己有那个 factory 局部槽。
		 *
		 * 而视图区（`DefaultConversationViews`）里 `viewId = view ?? active?.id`，
		 * `active` 由 `resolveActiveView(tabs, useStore(s => s.view))` 解析 ——
		 * 也就是**会话 store 里那一位说了算**，而它是按会话持久化的。
		 * 所以「打开对话要落到那个成员自己的对话里」= 在它挂载之前把那一位改掉。
		 *
		 * ## 为什么不能整份覆盖
		 *
		 * 那个 store 是**整份 JSON** 水合的（`attachPersistence`：`setState(JSON.parse(raw))`），
		 * 覆盖写会把「这个窗口里还没发出去的草稿」（`draft`）一起抹掉。
		 * 所以这里读出来、只改 `view`、其余原样带回去。
		 *
		 * ## 失败模式（刻意都能接受）
		 *
		 * - 存储不可用 / 数据是坏的 → 什么都不做，回到「落在哪个 tab 看运气」，
		 *   **不抛错**（这条路径挂在「打开对话」的点击上，抛错会让按钮看起来坏了）。
		 * - 官方改键名或字段 → 我们写的那一位没人读，效果同上。
		 * - 我们写错的字段名不会伤到别的会话：键是按 sessionId 分的。
		 *
		 * @param sessionId - 目标会话 id。
		 */
		const preferChatView = (sessionId) => {
			if (typeof sessionId !== "string" || sessionId === "") return;
			if (typeof localStorage === "undefined") return;
			const key = `${CONVERSATION_STORE_KEY}.${sessionId}`;
			try {
				let stored = {};
				const raw = localStorage.getItem(key);
				if (raw !== null) {
					const parsed = JSON.parse(raw);
					if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed) === false) {
						stored = parsed;
					}
				}
				if (stored.view === CHAT_VIEW_ID) return; // 已经是「对话」，别动存储
				// ⚠⚠ **必须先把三个字段的默认值铺满，再叠已有值。**
				//
				// 官方那个 store 的水合是**整值替换、不与默认值合并**（`setState(JSON.parse(raw))`），
				// 而视图区那个 effect 拿 `draft` 当字符串用（`draft === ""` 判据 + `setDraft(draft)`
				// 里直接 `text.replace(...)`）。所以**只写 `view` 会把 `draft` 变成 `undefined`**：
				//   `undefined !== ""` 成立 ⇒ `setDraft(undefined)` ⇒ `text.replace` 抛 TypeError
				//   ⇒ 正文视图那个插槽条目崩溃退役（retire 之后只有刷新页面才能恢复）
				//   ⇒ 界面表现为「外壳还在、正文空白、输入框贴到顶栏」。
				//
				// 2026-10-10 的事故就是这么来的：当时这里 `stored` 是 `{}`（那条会话还没有记录），
				// `{...{}, view}` 写出来就是 `{"view":"team-chat"}` —— 缺 draft / viewRequest。
				// 默认值照抄官方正常记录的形状：`{draft:"", view, viewRequest:null}`。
				localStorage.setItem(
					key,
					JSON.stringify({ draft: "", viewRequest: null, ...stored, view: CHAT_VIEW_ID }),
				);
			} catch (error) {
				report("members.preferChatView", error);
			}
		};

		// ══════════════════════════════════════════════════════════
		// 输入框里的 @ 提及（走官方的 inputTriggers 触发器框架）
		//
		// ## 官方框架长什么样（是从源码读出来的，不是猜的）
		//
		// DSH 的 `@` / `/` 补全**不是**各家插件自己往输入框里塞东西，而是一套
		// 注册表：`dsh-client-ui-input-trigger` 提供 `ctx.inputTriggers`，
		// 插件用 `registerSource(src)` 挂一个「触发器源」。同一个 trigger
		// （`@`）**允许多个源共存**，菜单按 `order` 排序分组显示
		// （`dsh-client-ui-input-trigger/lib/client.js:942` 的 roster 过滤）。
		// 官方自己就是这么接的：`dsh-client-ui-reference` 的 `@文件/session`、
		// `dsh-client-ui-skill` 的 `/技能`、`dsh-client-ui-commands` 的 `/命令`。
		//
		// ## 芯片（带颜色的那个字段）是怎么来的
		//
		// `onPick` 有两种返回：
		// - `{text}` → 只是**纯文本**；编辑器另有一层「扫描式装饰」
		//   （`dsh-client-ui-conversation/lib/client.js:12633` 的
		//   `TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g`），只认 `[\w-]` 组成的名字
		//   —— **中文显示名永远匹配不上**，所以这条路给不出颜色；
		// - `{insert: {source, ref, label, appearance, clipboardText}}` → 编辑器里
		//   **插入一个真正的芯片节点**（`ReferenceChipNode`），它的样式是
		//   `color: var(--dsw-alias-state-business-primary)`
		//   （同文件 `:12343` 的 `composer-editor.module.css`），**这才有颜色**。
		//
		// 我们走 `insert`：`label` = **显示名**（可以是中文，芯片上显示的就是它），
		// `ref` = `@成员标识`（机器可读、可稳定反查是谁）。
		// `appearance` **故意不传**：传了会去查 `ReferenceIconRegular` 的
		// file/folder/session 三种图形，我们不是那三种；不传时芯片左侧画一个
		// `@` 记号（同文件 `:12373`）—— 这正是「提及」该有的样子。
		//
		// ## codec 是**必需**的，不是可选装饰
		//
		// 提交时芯片要序列化成模型形态：`serializeReference(source, ref, signal)`
		// 找不到 owner 或 owner 没有 codec 时**直接 reject**，那次提交会被卡住
		// （`dsh-client-ui-input-trigger/lib/client.js:615-619` 的注释写得很明白：
		// "the submit attempt blocks instead of silently downgrading"）。
		// ══════════════════════════════════════════════════════════

		/** 我们的触发器源名 —— 同时是芯片的 `source`，官方靠它把芯片路由回我们。 */
		const MENTION_SOURCE = "team-members";

		// ══════════════════════════════════════════════════════════
		// 「投递范围」的共享状态（会话 id → 目标成员名）
		//
		// `null` = 还没选；`""` = 所有人；`"名字"` = 只发给那个成员。
		//
		// ## 为什么放在模块级，而不是各组件自己的 state
		//
		// 两个入口都会写它：**`@` 提及** 与 **输入框左侧的「发送到团队」面板**。
		// 各存各的会立刻撒两个谎：
		// 1. 从 `@` 定了人，面板还高亮着「所有人」—— 而本项目最忌讳的一条就是
		//    「界面上的选择与真实状态不一致」（这条是实锤过的，不是理论洁癖）；
		// 2. `TeamCompose` 是**按会话挂载**的（输入框工具栏），切个窗口再切回来
		//    本地 state 就归零了，而宿主那边那个范围是**一次性**的、还在等你下一条消息。
		//
		// ## 为什么「先改本地、再交给宿主」
		//
		// 宿主那个接口是 POST 且不可读（只回 200 时的当前值），
		// 所以本地这份就是界面的唯一真相；POST 失败时静默降级（界面与宿主不一致
		// 的窗口很短：下一条消息发出去才发现没投递，而且会有回执说明）。
		// ══════════════════════════════════════════════════════════

		/** `sessionId → target`。 */
		const scopeTargets = new Map();
		/** 变化订阅者（只需按 sessionId 过滤）。 */
		const scopeSubscribers = new Set();

		/**
		 * 改一个会话的投递范围（共享状态）。
		 *
		 * @param sessionId - 会话 id。
		 * @param target - 目标成员名；`""` = 所有人；`null` = 取消。
		 */
		const setScopeTarget = (sessionId, target) => {
			if (typeof sessionId !== "string" || sessionId === "") return;
			if ((scopeTargets.get(sessionId) ?? null) === target) return;
			if (target === null) scopeTargets.delete(sessionId);
			else scopeTargets.set(sessionId, target);
			for (const listener of [...scopeSubscribers]) {
				try {
					listener(sessionId);
				} catch (error) {
					report("scope.notify", error);
				}
			}
		};

		/**
		 * React hook：读某个会话的投递范围。
		 *
		 * ⚠ 和 `useChatRoomActive` 同一个坑：订阅要等被动 effect 才装上，
		 * 所以挂载后必须**先对齐一次真实值**，否则会永久停在旧值上。
		 *
		 * @param sessionId - 会话 id。
		 * @returns 当前范围。
		 */
		const useScopeTarget = (sessionId) => {
			const [target, setTarget] = react.useState(scopeTargets.get(sessionId) ?? null);
			react.useEffect(() => {
				setTarget(scopeTargets.get(sessionId) ?? null);
				const listener = (changed) => {
					if (changed === sessionId) setTarget(scopeTargets.get(sessionId) ?? null);
				};
				scopeSubscribers.add(listener);
				return () => {
					scopeSubscribers.delete(listener);
				};
			}, [sessionId]);
			return target;
		};

		/**
		 * 设定投递范围：先更新共享状态（界面立刻一致），再交给宿主（一次性）。
		 *
		 * ⚠ 交给宿主的**必须是「用户待会儿要打字的那个会话」**（`sessionId`），
		 * 不是 Lead 会话 —— 宿主是按「收到 user/message 的那个会话 id」查范围的。
		 *
		 * @param sessionId - 当前会话 id（= 用户打字的窗口）。
		 * @param target - 目标成员名；`""` = 所有人；`null` = 取消。
		 * @returns 完成后的 Promise（调用方可选择 await）。
		 */
		const pushScopeTarget = async (sessionId, target) => {
			setScopeTarget(sessionId, target);
			await teamApi.scope({ parentSessionId: sessionId, target });
		};

		/** 房间名单缓存的有效期：`@` 每敲一个字都会问一次，别每次都打宿主。 */
		const MENTION_CACHE_MS = 1000;

		/** `sessionId → {at, rows}` —— 名单缓存（`lexicon` 与「点芯片开窗口」共用）。 */
		const mentionCache = new Map();

		/** `sessionId → string[]` —— 纯文本扫描用的词表（官方 `lexicon` 的语义）。 */
		const mentionLexicon = new Map();

		/** 词表变化的订阅者（官方订阅后会让编辑器重扫一遍文本）。 */
		const mentionListeners = new Set();

		/**
		 * 芯片左侧的小图标。
		 *
		 * 官方菜单支持 `icon` 传**组件**（`jsx(item.icon, {size:14})`，
		 * 见 `dsh-client-ui-input-trigger/lib/client.js:1157`）：传字符串会去查
		 * 官方的 file/folder/session 图形，而成员不属于那三种；自带一个
		 * 「人」的记号比借用 `session` 的对话气泡更贴切。
		 *
		 * @param props.size - 边长（官方传 14）。
		 * @returns 图标元素。
		 */
		const MemberMentionIcon = ({ size = 14 }) =>
			react.createElement(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				react.createElement("circle", { cx: 5.8, cy: 5.4, r: 2.6 }),
				react.createElement("path", { d: "M1.6 13.4c.4-2.3 2.1-3.8 4.2-3.8s3.8 1.5 4.2 3.8" }),
				react.createElement("path", { d: "M11.4 3.6a2.4 2.4 0 0 1 0 4.6" }),
				react.createElement("path", { d: "M12.6 13.4c-.1-1.1-.4-2.1-1-2.9" }),
			);

		/**
		 * 解析候选项里带的载荷。
		 *
		 * 官方约定 `value` 是**字符串**（看 `dsh-client-ui-reference` 的
		 * `sessionCandidate`：`value: JSON.stringify({...})`）。解析失败 =
		 * 不是我们的候选，返回 undefined 让上层跳过。
		 *
		 * @param value - 候选项的 `value`。
		 * @returns `{key, label}` 或 undefined。
		 */
		const parseMentionPick = (value) => {
			if (typeof value !== "string" || value === "") return undefined;
			try {
				const parsed = JSON.parse(value);
				if (parsed === null || typeof parsed !== "object") return undefined;
				const key = typeof parsed.key === "string" ? parsed.key.trim() : "";
				const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
				if (key === "") return undefined;
				return { key, label: label !== "" ? label : key };
			} catch {
				return undefined;
			}
		};

		/**
		 * 把宿主名单整理成菜单候选行。
		 *
		 * 行的**标题就是显示名** —— 用户要的就是这个（「艾特的话应该是显示名」），
		 * 成员标识只作为副信息出现在描述里，方便分辨同名/记不住中文名的情况。
		 *
		 * @param rows - `rosterOf(...)` 的输出。
		 * @param query - 用户 `@` 后面已经敲的部分。
		 * @param t - 翻译函数。
		 * @returns 官方菜单认的候选行数组。
		 */
		const mentionRows = (rows, query, t) => {
			const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
			const hit = (row) =>
				needle === "" ||
				row.displayName.toLowerCase().includes(needle) ||
				row.key.toLowerCase().includes(needle);
			// 前缀命中排前面：「@an」时 analyst 该在 market-analyst 之前。
			const rank = (row) => (row.displayName.toLowerCase().startsWith(needle) ? 0 : 1);
			const ordered = [...rows.filter(hit)].sort(
				(a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName),
			);
			return ordered.map((row) => {
				const duty = row.duty !== "" ? row.duty : row.isLead === true ? t("members.leadBadge") : "";
				// 描述里带上成员标识：显示名可能重名，标识唯一。
				const description = duty === "" ? "" : `${duty} · ${row.key}`;
				return {
					name: row.displayName,
					description,
					icon: MemberMentionIcon,
					// 分组标题用**我们自己**的字典（官方那个是 `t(source.name)`，
					// 我们插不进它的键 ⇒ 关掉外层标题，改用每条自带的 section）。
					section: t("members.mentionSection"),
					value: JSON.stringify({ key: row.key, label: row.displayName }),
				};
			});
		};

		/**
		 * 取某个会话所在房间的名单（带短缓存）。
		 *
		 * 顺带把词表发出去，让编辑器知道「文本里这个 @名字 是个完整的引用」。
		 *
		 * @param sessionId - 会话 id（宿主按房间解析，成员自己的窗口也认）。
		 * @returns 名单行。
		 */
		const loadMentionRoster = async (sessionId) => {
			const cached = mentionCache.get(sessionId);
			if (cached !== undefined && Date.now() - cached.at < MENTION_CACHE_MS) return cached.rows;
			try {
				const state = await roomApi.roster(sessionId);
				const hidden = Array.isArray(state?.removed) ? state.removed : [];
				const rows = rosterOf(state?.members).filter((row) => !hidden.includes(row.key));
				mentionCache.set(sessionId, { at: Date.now(), rows });
				const names = [];
				for (const row of rows) {
					// 词表里两种都放：文本里写成员标识（ASCII，官方扫描认得）或
					// 显示名都算「提到他」。中文名官方正则匹配不上 —— 无害。
					if (row.displayName !== "") names.push(row.displayName);
					if (row.key !== "") names.push(row.key);
				}
				mentionLexicon.set(sessionId, names);
				for (const listener of [...mentionListeners]) {
					try {
						listener();
					} catch (error) {
						report("members.mentionLexicon", error);
					}
				}
				return rows;
			} catch (error) {
				report("members.mentionRoster", error);
				return cached?.rows ?? [];
			}
		};

		/**
		 * 造一个 `@` 触发器源。
		 *
		 * 抽成工厂是为了能被**真跑**：`onPick` 里「标签必须是显示名」这条
		 * 只有真调一次才判得出来（静态正则看不出 `label: picked.key` 与
		 * `label: picked.label` 的区别在哪）。见脚手架 `smoke-client-entries.mjs`。
		 *
		 * @param t - 翻译函数。
		 * @param openMember - `(sessionId) => void`，点芯片时打开那个成员的窗口。
		 * @returns 官方 `registerSource` 要的对象。
		 */
		const createMemberMentionSource = (t, openMember) => ({
			trigger: "@",
			name: MENTION_SOURCE,
			// 同一个 `@` 上官方还挂着「文件/文件夹/会话」那个源
			// （`dsh-client-ui-reference`）。它没写 order（默认 0），我们取负数
			// 排到它前面 —— 在聊天室里 `@` 的头号用途是叫人，不是找文件。
			order: -10,
			// 外层分组标题由官方用**它自己的**字典渲染（`t(group.source)`），
			// 我们插不进它的键 —— 关掉，改用候选行自带的 `section`。
			showGroupTitle: false,
			lexicon: (session) => mentionLexicon.get(session?.sessionId),
			subscribeLexicon(session, listener) {
				const off = () => mentionListeners.delete(listener);
				mentionListeners.add(listener);
				return off;
			},
			async candidates(session, { query, signal }) {
				const sessionId = session?.sessionId;
				if (typeof sessionId !== "string" || sessionId === "") return [];
				const rows = await loadMentionRoster(sessionId);
				if (signal?.aborted === true) return [];
				return mentionRows(rows, query, t);
			},
			onPick({ candidate, session }) {
				const picked = parseMentionPick(candidate?.value);
				if (picked === undefined) return undefined;
				// @ 某人 = **这条消息发给他** —— 与「发送到团队」是同一件事
				// （用户原话：「我们可以在发送到团队里选择艾特某一个成员，
				// 或者是在手动打艾特」）。范围是一次性的，发完自动复位。
				// ⚠ 失败不能影响插入：芯片已经插进去了，范围没设上只是「没投递」，
				//    宿主那边会把它如实标成未投递（气泡下面那行小字）。
				Promise.resolve()
					.then(() => pushScopeTarget(session?.sessionId, picked.key))
					.catch((error) => report("members.mentionScope", error));
				return {
					insert: {
						source: MENTION_SOURCE,
						// `ref` 是**机器形态**（成员标识，ASCII 且稳定），
						// `label` 是**给人看的**（显示名，可以是中文）。
						ref: `@${picked.key}`,
						label: picked.label,
						clipboardText: `@${picked.key} `,
					},
				};
			},
			openReference(session, { ref }) {
				const key = typeof ref === "string" && ref.startsWith("@") ? ref.slice(1) : "";
				if (key === "") return false;
				const rows = mentionCache.get(session?.sessionId)?.rows ?? [];
				const row = rows.find((item) => item.key === key);
				if (row === undefined || row.sessionId === "") return false;
				// 点芯片 = 打开那个成员自己的对话窗口（复用成员面板那个入口）。
				openMember(row.sessionId);
				return true;
			},
			codec: {
				// 提交时芯片 → 模型形态。**必须存在**：官方找不到 owner 的 codec
				// 会 reject，那次提交直接被卡住（见上面那段注释）。
				clipboardText: (ref) => ref,
				serialize: (ref) => Promise.resolve(ref),
			},
		});

		/**
		 * 自有 timeline 投影的键。
		 *
		 * 必须与 `lib/timeline-projection.js` 的 `TIMELINE_PROJECTION_KEY` 一致 ——
		 * 宿主注册投影、客户端读投影，两边靠这个字符串对齐。
		 * **改一处必须改另一处**（两个文件都是纯 JS，没有类型层兜底）。
		 */
		const TIMELINE_KEY = "teamChatTimeline";

		/**
		 * 「发言人」在本地资料表里的键 —— 就是 `lead`。
		 *
		 * 官方团队投影里 lead 那一行的 `name` 是**字面量** `"lead"`，
		 * 而本地资料表（`members.json`）是**按成员名索引**的 —— 两边对齐，所以键就是字符串 `lead`。
		 */
		const SPEAKER_KEY = "lead";

		/** locale 命名空间。 */
		const NS = "team-chat";

		/**
		 * 我们的补全面板在 overlay 槽里的登记名。
		 *
		 * 官方 `client-ui-mention/lib/client.js` 用 `"path"` 作 id（斜杠命令）。
		 * 不能撞 —— 撞了就是 `single` 槽同优先级抛错，整个 entry 不激活。
		 */
		const MENTION_OVERLAY_ID = "team-chat-mention";

		/** 官方智能体团队 bundle 的包名。 */
		const TEAM_BUNDLE = "@deepseek-ai/dsh-experimental-agent-team-profile";

		const zhCN = {
			"view.label": "聊天室",
			"panel.empty": "还没有消息。在输入框左侧选「发送到团队」定好发给谁，或直接 @ 某个成员 —— 有投递范围的消息才会出现在这里；你与某个智能体一对一的私聊不进聊天室。",
			// ── 聊天室气泡 ────────────────────────────────────────
			"chat.today": "今天",
			"chat.noTarget": "未投递（没有选范围）",
			// ── 消息折叠 / 展开 ───────────────────────────────────
			//
			// 折叠的形态（用户定）：**头部标题永远露着，只折正文**。
			// 房间里的长报告几乎都是「一行加粗标题 + 一大段解释」，读者一眼要的
			// 就是那行标题；正文折起来，进房间时它**根本不进 Markdown 解析器**。
			"chat.expand": "展开全文",
			"chat.collapse": "收起",
			"chat.collapsedHint": "共 {lines} 行 · {chars} 字 · 点击展开",
			"members.me": "我",
			"panel.failure": "投影已降级（事件结构不符预期），当前内容为只读快照。",
			"panel.disconnected": "与主机的实时连接已断开，正在重试…",
			"panel.navLabel": "聊天室",
			"panel.noSession": "先在左侧栏打开一个会话，这里就会显示它所在工作区的聊天室。",
			"role.lead": "Lead",
			"role.teammate": "成员",
			"status.delivered": "已送达",
			"status.queued": "排队中",
			"settings.teams.title": "官方智能体团队（本插件不需要）",
			"settings.teams.desc":
				"官方自带的 Agent Teams 扩展。它按「窗口」计算智能体、成员只能是 Lead 的子会话，因此成员既不会出现在左侧栏、也无法单独删除 —— 本插件已完全不使用它。",
			"settings.teams.sideEffect": "关掉它不影响聊天室的任何功能：成员名单、消息投递、时间线都由本插件自己维护。",
			"settings.teams.legacy": "保留这个开关只是因为它属于官方扩展，可能被你其他用途需要。",
			"settings.teams.off": "已关闭 —— 本插件工作正常。",
			"settings.teams.on": "当前为开启状态。本插件仍不使用它；若你不需要官方那套子智能体，可以关掉。",
			"settings.teams.notInstalled": "未在当前 profile 中找到该插件，需先安装官方智能体团队。",
			"settings.teams.unavailable": "该插件当前不可用",
			"settings.teams.loading": "读取中…",
			"settings.teams.applied": "已保存并生效。",
			"settings.teams.restartRequired": "已保存，需重启 DSH 后生效。",
			"settings.teams.overridden": "已被更高优先级的配置覆盖，未生效。",
			"settings.teams.cancelled": "操作已取消。",
			"settings.teams.failed": "操作失败",
			// ── 设置页「AI 成员配置」区块 ──────────────────────────
			"settings.members.title": "AI 成员配置",
			"settings.members.desc": "为每个成员配置职责与专属指令 / 技能。专属指令会在创建该成员时作为它的第一条消息发出。",
			// ── 「我（发言人）」────────────────────────────────────
			//
			// 为什么单独开一块、而不是把 lead 混在「AI 成员配置」里：
			// 实测用户**找不到**自己的资料 —— 那一行显示成 `MoYUCSC lead`，
			// 而且所在区块的描述只讲「职责与专属指令」，没人会想到头像在那儿改。
			"settings.me.title": "我（发言人）",
			"settings.me.desc":
				"你在聊天室里显示的名字和头像 —— 你发的每条消息都用它。和 AI 成员是两回事，别去上面那块找。",
			"members.me.title": "我的资料",
			"settings.me.edit": "编辑我的资料",
			"settings.me.unnamed": "（未命名）",
			"settings.me.avatarCustom": "自定义头像",
			"settings.me.avatarDefault": "默认头像（色块 + 首字母）",
			"settings.members.empty": "还没有成员资料。可在下方新增一条；也可以先去聊天室里用「添加 AI 成员」创建。",
			"settings.members.noInstructions": "未配置专属指令",
			"settings.members.edit": "配置",
			"settings.members.saved": "已保存。",
			"settings.members.add": "新增成员资料",
			"settings.members.addHint": "只建资料、不创建窗口。成员名必须与之后创建 teammate 时填的名字一致，专属指令才会随创建一起发出去。",
			"settings.members.key": "成员名",
			"settings.members.keyPlaceholder": "例如 analyst",
			"settings.members.keyHint": "只用小写字母 / 数字 / 连字符，且不能叫 lead。",
			"settings.members.badKey": "成员名只能用 a-z、0-9 和小写连字符（如 analyst），且不能叫 lead。",
			"settings.members.exists": "这个成员名已经有资料了，请直接在上面列表里配置。",
			"settings.members.needDuty": "必须填写职责（官方要求，≤200 字）。",
			"settings.members.added": "已新增成员资料。创建同名 teammate 时会带上这段专属指令。",
			// ── 独立设置页（设置面板左侧的一个分类）────────────────
			"settings.nav": "智能体聊天室",
			// ── 新建 AI 成员：设置页里直接建窗口 ───────────────────
			"settings.new.title": "新建 AI 成员",
			"settings.new.desc": "点「新建」会立刻创建一个真实的会话窗口，并把这里填的职责与专属指令作为它的第一条消息。",
			"settings.adoptGuide": "成员不再是「另开一个窗口」。要加成员：回到你想收编的那个对话窗口，点右上角的「成员」→「添加 AI 成员」，把它收编为团队成员并定好职责。已有的成员在下方「AI 成员配置」里管理。",
			"settings.new.target": "挂到哪个会话",
			"settings.new.targetHint": "成员是 Lead 的子会话，只能挂在根会话上；成员的默认模式跟随它。",
			"settings.new.noTarget": "当前没有可用的会话。先新建一个会话，再回到这里。",
			"settings.new.submit": "新建",
			"settings.new.creating": "正在创建窗口…",
			"settings.new.created": "已创建成员「{name}」，窗口已打开。",
			// ── 「模式」（官方 Agent 预设）─────────────────────────
			//
			// **两个地方共用**：右栏成员管理页签的「添加 AI 成员」表单、
			// 设置页的「新建 AI 成员」。所以放在中性命名空间，
			// 别挂在 `settings.*` 底下 —— 否则成员页签里会出现「settings」前缀的 key，
			// 下次改文案的人一定会漏掉一处。
			"preset.label": "模式",
			"preset.follow": "跟随会话",
			"preset.hint": "官方附带的预设。成员默认继承所挂会话的模式；在这里选了，会在它启动前单独改掉。",
			"preset.standard": "标准模式",
			"preset.ptc": "PTC 模式",
			"preset.minimal": "极简模式",
			"preset.cordis": "Cordis 模式",
			// 窗口建出来了但模式没切上 —— 必须如实说，不能让界面上的选择
			// 和真实状态不一致。
			"preset.failed": "成员「{name}」已创建，但模式没能切换（{code}）—— 它仍在用会话的模式。",
			// ── 输入框左侧的「发送到团队」入口 ─────────────────────
			//
			// 输入框本身是**官方的**，我们只往工具栏左侧塞一个按钮。
			// 点开是成员补全面板，选中后往输入框里插入 `@名字 `。
			"compose.trigger": "发送到团队",
			"compose.title": "选择发送范围",
			"compose.everyone": "所有人",
			"compose.scopeOn": "发给：{who}",
			"compose.hint":
				"选好范围后，用下面的输入框正常写消息（可以附图 / 附件）并发送 —— 这条消息会额外投给所选成员。范围只生效一条，发完自动复位。",
			"compose.empty": "还没有成员。团队运行起来后，Lead 创建的 teammate 会出现在这里。",
			"compose.lead": "Lead",
			"compose.close": "关闭",
			"compose.queued": "已交给 {name} 处理，等待回复。",
			"compose.inactive": "这个成员当前是 {phase}，收不了消息（官方只投递给 active 的成员）。",
			"compose.inactiveTag": "收不到",
			"compose.sentAll": "已投递给 {count} 个成员。",
			"compose.sentPartial": "{ok} 个已送达，{failed} 个没送到（{names}）",
			"compose.sentNone": "没有成员收到（{names}）",
			// ── 成员菜单 ──────────────────────────────────────────
			"members.trigger": "成员",
			"members.title": "聊天室成员",
			"members.empty": "还没有 AI 成员。点上面的「添加 AI 成员」建一个 —— 它会是一个独立的对话窗口。",
			"members.loading": "读取中…",
			"members.count": "{count} 人",
			"members.lead": "Lead",
			"members.phaseProvisioning": "创建中",
			"members.phaseFailed": "启动失败",
			"members.edit": "编辑资料",
			"members.open": "打开对话",
			"members.stateIdle": "未在运行",
			"members.editTitle": "编辑成员资料",
			"members.name": "名字",
			"members.namePlaceholder": "如：前端、行情观察员",
			"members.duty": "职责",
			"members.dutyPlaceholder": "例如：负责行情播报（留空则用官方描述）",
			// ── 成员级「技能 / 规则」（创建期生效）───────────────
			"members.instructions": "专属指令 / 技能",
			"members.instructionsPlaceholder": "例：只做行情分析，不碰代码；动手前先读 docs/分析规范.md。",
			"members.instructionsHint": "建成员时作为它的**开场消息**。改已存在的成员需要重建才生效。",
			"members.avatar": "头像",
			"members.avatarEmoji": "Emoji",
			"members.avatarText": "文字",
			"members.avatarImage": "图片",
			"members.avatarPlaceholder": "🦊",
			"members.avatarTextPlaceholder": "缩写，如 AK",
			"members.avatarUpload": "选择图片",
			"members.avatarClear": "清除图片",
			"members.avatarBadType": "只支持 PNG / JPEG / GIF / WebP / AVIF。",
			"members.save": "保存",
			"members.cancel": "取消",
			"members.reset": "恢复默认",
			"members.saving": "保存中…",
			"members.saved": "已保存。",
			"members.saveFailed": "保存失败",
			"members.storeNote": "资料保存在 DSH 安装目录下，卸载插件不会丢。",
			"members.close": "关闭",
			"members.delete": "删除资料",
			"members.deleteHint": "只清除这个成员在本插件里的资料（显示名/职责/头像），它的对话窗口不受影响。",
			"members.deleted": "资料已恢复默认。",
			// ── 添加 AI 成员 ──────────────────────────────────────
			//
			// ⚠ 官方 Team 协议里成员名是**不可变身份字段**，改名会被拒。
			// 所以这里一次定名，建好后改的只是展示名（上面那套覆写）。
			"members.add": "添加 AI 成员",
			"members.openPane": "在右侧栏打开",
			"members.addTitle": "添加 AI 成员",
			"members.addHint": "点「创建」会**新开一个独立的对话窗口**给这个成员 —— 它会像普通会话一样出现在左侧栏，随时能打开、也能删掉。",
			// ── 收编语义（2026-09-28 定案）：成员 = 已打开的对话窗口 ──
			"members.adoptTitle": "收编为 AI 成员",
			"members.adoptHint": "把你**已打开的某个对话窗口**收编为团队成员：它保留原有聊天内容，并**改名为你给成员取的名字**。之后这个窗口的名字由成员名统一决定 —— 在对话界面直接改名会被自动改回。",
			"members.adoptTarget": "收编哪个窗口",
			"members.adoptTargetHint": "默认是你当前正在看的这个窗口。列表按「当前窗口 / 其他窗口」分组，显示的是**对话原本的名字**；已经收编成成员的窗口不会出现在这里。",
			"members.adoptGroupCurrent": "当前窗口",
			"members.adoptGroupOthers": "其他窗口",
			"members.adoptNone": "还没有可收编的对话窗口。请先打开一个对话，再回到这里。",
			"members.adoptNoTarget": "请先选择要收编的对话窗口。",
			"members.adoptBusy": "正在收编…",
			"members.adoptSubmit": "收编",
			"members.nameHintAdopted": "**这是 AI 的自称，也会成为那个对话窗口的名称**；以后改这里，窗口名会跟着变。",
			"members.addNameHint": "内部标识：团队信箱靠它寻址，只能用 a-z、0-9 和连字符。不填就按你的名字自动生成。",
			"members.nameRequired": "请给这个成员取个名字。",
			"members.addDisplayNameHint": "中文名填这里 —— 它会成为那个对话窗口的标题。",
			"members.addName": "成员标识（可选）",
			"members.addNamePlaceholder": "留空自动生成",
			"members.addDuty": "职责描述",
			"members.addDutyPlaceholder": "如：盯盘并播报价格异动（≤200 字，官方必填）",
			"members.addSubmit": "创建",
			"members.addBusy": "正在创建窗口…",
			"members.addDone": "已创建 {name}。",
			// ── 「必须先有窗口」这条需求的文案 ──────────────────
			"members.addTask": "初始任务（选填）",
			"members.addTaskPlaceholder": "留空则用上面的职责作为开场任务",
			"members.addTaskHint": "创建时会真的起一个 agent 窗口，这段文本是它的第一条消息。",
			"members.addCreating": "正在创建 agent 窗口并校验进程…",
			"members.addDoneWindow": "已创建 {name}，对应窗口已确认存在（{seconds}s）。",
			"members.addBack": "返回列表",
			"members.addUnavailable": "无法创建这个成员，请把下面的错误原文反馈过来。",
			"members.errUnknown": "创建失败",
			"members.errWindowNotCreated": "会话已经建了，但没能确认它真的活起来。请重试。",
			"members.errLeadExists": "这个聊天室已经有主智能体了。要换人的话请在表单里确认。",
			// ── 主智能体（团队协作语义）──────────────────────────────
			"members.isLead": "设为主智能体",
			"members.isLeadDesc":
				"主智能体坐镇指挥：负责把目标拆成任务派给成员、接收成员的完成汇报、检查产出并决定是否返工。一个聊天室只有一个。",
			"members.isLeadTaken":
				"⚠ 这个聊天室已经有了主智能体：「{name}」。打开这个开关会把它降为普通成员 —— 汇报从此归新主智能体。",
			"members.leadBadge": "指挥",
			"members.offline": "未运行",
			"members.addNameInvalid": "成员标识只能用小写字母、数字和连字符（如 market-watcher），且不能叫 lead。留空可自动生成。",
			"members.addDutyRequired": "职责描述是官方必填项。",
			"members.errNoLiveCaller": "找不到该会话对应的活动 Agent，请先打开团队 Lead 的会话。",
			"members.errLeadRequired": "只有团队 Lead 能创建成员。",
			"members.errNameTaken": "这个名字已经被占用了。",
			"members.errLimit": "成员数量已达上限。",
			"members.errUnavailable": "官方团队服务未启用。",
			"members.addFailed": "创建失败",
			// ── 移除成员 ──────────────────────────────────────────
			"members.remove": "移除",
			"members.removeConfirm": "确认移除？",
			"members.removed": "已移除。",
			"members.errRemoveNotFound": "团队里没有这个成员。",
			// ── 右栏成员管理页签 ──────────────────────────────────
			//
			// 侧边栏「页签类型」的两段式注册（`sidebarRightTabs.register` +
			// `sidebar.right.pane.tab` 槽）需要一份标题与一条 guide 卡片文案：
			// 用户从右栏「新建标签页」打开的 guide 里点卡片进来。
			"pane.title": "聊天室成员",
			"pane.guideNew": "成员管理",
			"pane.guideDesc": "编辑聊天室成员的头像、显示名与职责，或新添加 AI 成员。",
			"pane.loading": "读取中…",
			"pane.noSession": "先打开一个团队会话。",
			// ── 左侧栏「聊天室成员」面板 ──────────────────────────
			"members.page.jumping": "正在打开该成员的窗口…",
			// ── 头像文件大小限制 ──────────────────────────────────
			//
			// 触发点：`MemberEditor.pickFile` —— **文件读进内存之前**先量体积。
			// 超过 1 MiB 直接拒绝，不做任何压缩处理。
			"members.avatarHint": "只接受 1 MiB 以内的图片，超出请先自行缩小。",
			"members.avatarTooLarge": "图片 {size}，超过 1 MiB 上限，请换一张更小的。",
			// ── 输入框里的 @ 提及 ─────────────────────────────────
			"members.mentionSection": "AI 成员",
			// ── 槽条目自带错误边界 ────────────────────────────────
			//
			// 这行字只有在**我们的组件抛错**时才出现（DSH 会给抛过错的条目
			// 判死刑、永久除名，自带边界就是拦住这件事的那道墙）。
			// 文案要短 —— 它落在会话头部那一行 26px 高的按钮位上。
			"entry.crashed": "界面出错 · 重试",
			"entry.crashedHint": "这个入口的渲染抛错了，已就地隔离。点一下重试。错误原文已经写进宿主日志。",
			// ── 成员交替（交接 / succession）───────────────────────
			//
			// 用词定案：「交替」是用户的原话，界面上一律用它，
			// 不再另造「交接 / 换会话 / 换届」等说法（一个功能三个名字最难查）。
			"members.succession": "交替",
			"members.successionTitle": "交替 / 交接",
			"members.successionHint":
				"给这个成员换一个**全新的会话**：旧会话里那个 AI 会先写一份交接说明，新会话继承它的名字、职责、专属指令与头像，并把这份说明当开场消息读。",
			"members.successionArchive": "旧会话怎么处置",
			"members.successionArchiveOpt": "归档（推荐）",
			"members.successionKeepOpt": "保留",
			"members.successionArchiveDesc":
				"归档：旧会话原样留着（对话、完整日志一个字都不删），只是改名成「…（旧 · 已归档）」，并且**不再作为这个成员接收消息**。要翻旧账随时去左侧栏打开它。",
			"members.successionKeepDesc":
				"保留：磁盘上的结果与归档完全一样（同样不删任何东西），只是**不改旧会话的名字**。两个同名窗口并排时容易点错 —— 点错了它也不收成员消息。",
			"members.successionConfirm": "开始交替",
			"members.successionBusy": "正在让旧会话里的 AI 写交接说明…（最长约 90 秒）",
			"members.successionBusyHint": "这段时间请别关页面。它在自己的会话里跑一个完整的来回，写完之后才会换会话。",
			"members.successionCancel": "取消",
			"members.successionNote": "交接说明会写进成员资料，可累积、可回看。",
			"members.successionNoSession": "这个成员还没有属于它的会话，没什么可交替的。",
			"members.successionDone": "已交替：新会话 {session}。",
			"members.successionArchived": "旧会话已归档（{old}）—— 它还在左侧栏，随时能打开看历史。",
			"members.successionKept": "旧会话保留原名（{old}）—— 它同样还在左侧栏。",
			"members.successionNoteByMember": "交接说明：旧会话里的 AI 自己写的（{chars} 字）。",
			"members.successionNoteByLlm":
				"⚠ 交接说明**不是它自己写的**：它没写出来，改用了「读它的会话日志 + 调模型提炼」这条退路（{chars} 字）。",
			"members.successionNoteEmpty":
				"⚠ 这次没能生成交接说明（两条路都失败了，原因已记进宿主日志，搜「[succession]」）。交替本身照常完成了。",
			"members.successionNoteTruncated": "（超过上限的部分已截断）",
			"members.successionNotePanel": "当前交接说明",
			"members.successionNoteEmptyPanel": "（当前没有交接说明）",
			"members.successionArchivedCount": "已归档 {count} 个旧会话",
			"members.successionFailed": "交替失败",
			"members.successionHintSteerFailed":
				"⚠ 新会话已建好、身份也交接完了，但开场消息没能投进去 —— 请打开那个窗口，把上一条交接说明手动发给它。",
			// 交接说明五个分段的标题。键名（done/now/todo/pitfalls/anchors）
			// 与宿主侧 member-store.js 的 HANDOVER_SECTIONS 一一对应。
			"members.handover.done": "我做过什么",
			"members.handover.now": "现状",
			"members.handover.todo": "待办",
			"members.handover.pitfalls": "坑与注意事项",
			"members.handover.anchors": "关键决策 / 文件 / 标识",
			// ── host 侧报错的本地化（zh 侧）────────────────────────
			//
			// 键名 = 宿主返回的**稳定错误码**，`err.` 前缀把它和界面自己的
			// 文案分开。宿主那边是「码 + 英文兜底」两条一起给（它拿不到界面
			// 语言：`ctx.locale` 是客户端服务），所以**这里才是中英文案的真
			// 正来源**。拿不到码（老宿主 / 网络层给的 HTTP 错误）就回落到
			// `error` 原文 —— 见 `errorText()`。
			"err.TEAMCHAT_BODY_TOO_LARGE": "请求内容太大了，超出了这条接口允许的上限。",
			"err.TEAMCHAT_BODY_INVALID_JSON": "请求内容不是合法 JSON。",
			"err.TEAMCHAT_BODY_NOT_OBJECT": "请求内容必须是一个 JSON 对象。",
			"err.TEAMCHAT_EMPTY_MESSAGE": "消息不能为空。",
			"err.TEAMCHAT_NO_ROOM": "缺少会话 id。",
			"err.TEAMCHAT_MISSING_MEMBER_NAME": "缺少成员名。",
			"err.TEAMCHAT_MEMBER_NOT_FOUND": "聊天室里没有叫「{name}」的成员。",
			"err.TEAMCHAT_MEMBER_REMOVE_FAILED": "删除成员「{name}」失败。",
			"err.TEAMCHAT_MEMBER_SAVE_FAILED": "保存成员「{name}」失败。",
			"err.TEAMCHAT_MEMBER_REMOVED":
				"已从成员列表移除。它的**对话窗口还在左侧栏工作区里** —— 不想留就直接在那里删掉那个会话。",
			"err.TEAMCHAT_NO_MEMBERS": "这个聊天室还没有 AI 成员。去「成员管理」里加一个。",
			"err.TEAMCHAT_NO_TARGET": "这个聊天室里没有叫「{target}」的成员。",
			"err.TEAMCHAT_MEMBER_NO_SESSION": "缺少要收编的会话 id。",
			"err.TEAMCHAT_TARGET_NOT_FOUND": "找不到这个会话（可能已被删除）。请回到你想收编的那个窗口再试。",
			"err.TEAMCHAT_TARGET_IS_SUBAGENT": "这个会话是别人的子智能体，不能被收编成成员。请挑一个你自己开的对话。",
			"err.TEAMCHAT_ROOM_NO_CWD": "这个会话没有工作目录，无法收编成成员。",
			"err.TEAMCHAT_INVALID_MEMBER_NAME":
				"成员标识只能用 a-z、0-9 和小写连字符，长度不超过 {max}，且不能叫 lead。留空可自动生成。",
			"err.TEAMCHAT_MISSING_DESCRIPTION": "必须填写职责描述（官方要求，≤{max} 字）。",
			"err.TEAMCHAT_PRESET_UNAVAILABLE": "当前宿主没有可用的 Agent 预设服务，无法指定模式。",
			"err.TEAMCHAT_UNKNOWN_PRESET": "没有名为 {preset} 的 Agent 预设。可用：{known}",
			"err.TEAMCHAT_LEAD_EXISTS": "这个聊天室已经有主智能体了：「{name}」。要换人的话请先确认。",
			"err.TEAMCHAT_ADOPT_FAILED": "收编成员失败。",
			// ── 成员库（host `lib/member-store.js`）的原因码 ──────────
			//
			// 这一组是**失败原因**级的码，不是路由级的（路由级那条仍是
			// `TEAMCHAT_MEMBER_SAVE_FAILED`）。`/__teamchat/members` 把它放在
			// `cause` 字段里，界面按「对象 + 原因」两段一起显示 ——
			// 上一轮只显示「保存成员失败」，把「哪里超了、超了多少」抹掉了，
			// 那是退步。这里的 `{size}` / `{max}` 就是那些**必须留着**的数字。
			"err.TEAMCHAT_AVATAR_TOO_LARGE": "头像数据过大：{size} MB，上限 {max} MB。请换一张更小的图片。",
			"err.TEAMCHAT_MEMBER_TOO_LARGE": "单条成员资料超过 {max} MB 上限（含头像 base64 膨胀）。",
			"err.TEAMCHAT_MEMBER_KEY_EMPTY": "成员标识不能为空。",
			"err.TEAMCHAT_MEMBER_NO_FIELDS": "这次没有任何可保存的字段。",
			"err.TEAMCHAT_MEMBER_WRITE_FAILED": "成员资料写入磁盘失败（{detail}）。",
			// ── 成员交替（host `lib/succession.js`）───────────────────
			//
			// ⚠ 统一 `TEAMCHAT_SUCC_` 前缀，为的是拆掉一处**同码不同义**：
			//   `TEAMCHAT_MEMBER_NO_SESSION`（`/spawn`）是「**请求里缺**要收编的
			//   会话 id」（4xx，补上就能过）；交替那边是「**成员资料里没有**会话 id」
			//   （数据状态如此，重试也没用）。原来两个都叫 `MEMBER_NO_SESSION`，
			//   共用一句文案必然把其中一边说错，所以拆成两个名字。
			"err.TEAMCHAT_SUCC_MEMBER_NO_KEY": "缺少成员名。",
			"err.TEAMCHAT_SUCC_MEMBER_NOT_FOUND": "找不到成员「{name}」的资料。",
			"err.TEAMCHAT_SUCC_MEMBER_NO_SESSION": "这个成员还没有属于它的会话（只有预配资料），没什么可交替的。",
			"err.TEAMCHAT_SUCC_NOT_STEERABLE": "这个会话的 agent 不接受投递。",
			"err.TEAMCHAT_SUCC_HANDOVER_TIMEOUT": "等了 {seconds} 秒没等到它的交接说明。",
			"err.TEAMCHAT_SUCC_LLM_UNAVAILABLE": "宿主没有可用的 llm 服务。",
			"err.TEAMCHAT_SUCC_MODEL_UNAVAILABLE": "读不到默认模型（agentDefaultModel.currentSelection）。",
			"err.TEAMCHAT_SUCC_LLM_EMPTY": "退路提炼拿不到任何正文。",
			"err.TEAMCHAT_SUCC_LOG_EMPTY": "会话日志里没有可用的正文。",
			"err.TEAMCHAT_SUCC_LOG_UNAVAILABLE": "拿不到它的会话日志（sessionQuery 与 live 会话都读不到）。",
			"err.TEAMCHAT_SUCC_IN_FLIGHT": "「{name}」已经有一场交替在跑了（开始于 {since}），等它结束再试。",
			"err.TEAMCHAT_SUCC_BUSY": "同时进行的交替太多（上限 {max}），稍后再试。",
			"err.TEAMCHAT_SUCC_RUNTIME_UNAVAILABLE": "宿主缺少 agents / sessionController 服务。",
			"err.TEAMCHAT_SUCC_SESSION_FAILED": "建新会话失败：{detail}。成员状态没有任何改动。",
			"err.TEAMCHAT_SUCC_SESSION_NOT_LIVE":
				"新会话 {session} 已登记，但没能变成活动会话。成员状态没有任何改动。",
			"err.TEAMCHAT_SUCC_STEER_FAILED": "交接请求没投出去：{detail}",
			"err.TEAMCHAT_SUCC_MEMBER_STORE_FAILED": "写成员资料失败：{detail}。成员状态没有任何改动。",
			"err.TEAMCHAT_SUCC_FAILED": "交替失败：{detail}。成员状态没有任何改动。",
			"err.TEAMCHAT_UNKNOWN": "操作失败，请把下面的错误原文反馈过来。",
			// 正文里内容块的占位符（`blocksToText`）—— 它是**消息正文**的一
			// 部分，会直接显示在气泡里，所以同样要跟界面语言走。
			"blocks.image": "[图片]",
			"blocks.unknown": "[{type} 内容]",
		};

		const enUS = {
			"view.label": "Team Chat",
			"panel.empty": "No messages yet. Pick a send scope with \"Send to team\" on the left of the composer, or just @ a member — only messages with a delivery range show up here. One-to-one chats with a member stay out of the room.",
			"chat.today": "Today",
			"chat.noTarget": "Not delivered (no range selected)",
			"chat.expand": "Show full message",
			"chat.collapse": "Collapse",
			"chat.collapsedHint": "{lines} lines · {chars} chars · click to expand",
			"members.me": "Me",
			"panel.failure": "Projection degraded (unexpected event shape); showing a read-only snapshot.",
			"panel.disconnected": "Live connection lost. Reconnecting…",
			"panel.navLabel": "Chat room",
			"panel.noSession": "Open a session from the sidebar — this panel shows the chat room of its workspace.",
			"role.lead": "Lead",
			"role.teammate": "Teammate",
			"status.delivered": "Delivered",
			"status.queued": "Queued",
			"settings.teams.title": "Official Agent Teams (unused by this plugin)",
			"settings.teams.desc":
				"The official Agent Teams extension. It counts agents per window and only allows teammates as sub-sessions of a Lead, so members never reach the sidebar and cannot be deleted individually. This plugin no longer uses it at all.",
			"settings.teams.sideEffect":
				"Turning it off breaks nothing here — the roster, message delivery and timeline are maintained by this plugin itself.",
			"settings.teams.legacy": "Kept only because it belongs to an official extension you might need elsewhere.",
			"settings.teams.off": "Off — this plugin works fine.",
			"settings.teams.on": "Currently on. This plugin still does not use it; turn it off if you don't need the official sub-agent flow.",
			"settings.teams.notInstalled": "Not found in this profile. Install the official Agent Teams bundle first.",
			"settings.teams.unavailable": "Plugin unavailable",
			"settings.teams.loading": "Loading…",
			"settings.teams.applied": "Saved and applied.",
			"settings.teams.restartRequired": "Saved. Restart DSH to apply.",
			"settings.teams.overridden": "Overridden by a higher-priority configuration.",
			"settings.teams.cancelled": "Cancelled.",
			"settings.teams.failed": "Failed",
			// ── settings → "AI member profiles" block ─────────────
			"settings.members.title": "AI member profiles",
			"settings.members.desc": "Per-member responsibility and instructions / skills. Instructions are sent as the member's first message when it is created.",
			"settings.me.title": "Me (the speaker)",
			"settings.me.desc":
				"The name and avatar you show up as in the chat room — every message you send uses them. This is about you, not about AI members.",
			"members.me.title": "My profile",
			"settings.me.edit": "Edit my profile",
			"settings.me.unnamed": "(unnamed)",
			"settings.me.avatarCustom": "Custom avatar",
			"settings.me.avatarDefault": "Default avatar (colour + initial)",
			"settings.members.empty": "No member profiles yet. Add one below, or create a member from the chat room first.",
			"settings.members.noInstructions": "No instructions configured",
			"settings.members.edit": "Configure",
			"settings.members.saved": "Saved.",
			"settings.members.add": "Add member profile",
			"settings.members.addHint": "Creates the profile only, not a window. The member name must match the teammate name used at creation, otherwise the instructions are never sent.",
			"settings.members.key": "Member name",
			"settings.members.keyPlaceholder": "e.g. analyst",
			"settings.members.keyHint": "Lowercase letters, digits and hyphens only; cannot be \"lead\".",
			"settings.members.badKey": "Member name allows a-z, 0-9 and hyphens only (e.g. analyst), and cannot be \"lead\".",
			"settings.members.exists": "This member name already has a profile. Configure it in the list above.",
			"settings.members.needDuty": "A responsibility is required (official requirement, 200 chars max).",
			"settings.members.added": "Profile added. The instructions will be sent when a teammate with this name is created.",
			// ── standalone settings section (left nav entry) ──────
			"settings.nav": "Team Chat",
			// ── create a member window straight from Settings ─────
			"settings.new.title": "New AI member",
			"settings.new.desc": "Creates a real session window immediately, with the responsibility and instructions below sent as its first message.",
			"settings.adoptGuide": "Members are no longer spawned as new windows. To add one: go back to the conversation window you want, open the “Members” menu at the top-right, choose “Adopt as AI member”, and set its role. Existing members are managed under “AI member profiles” below.",
			"settings.new.target": "Attach to session",
			"settings.new.targetHint": "A member is a child session of a Lead, so it must attach to a root session; it inherits that session's mode by default.",
			"settings.new.noTarget": "No session available. Open a session first, then come back.",
			"settings.new.submit": "Create",
			"settings.new.creating": "Creating the window…",
			"settings.new.created": "Member \"{name}\" created; its window is open.",
			// ── "Mode" (official Agent presets) ──────────────────
			// Shared by the members pane's "Add AI member" form and the
			// standalone Settings page, hence the neutral namespace.
			"preset.label": "Mode",
			"preset.follow": "Follow the session",
			"preset.hint": "Shipped presets. A member inherits its session's mode by default; picking one here switches it before the member starts.",
			"preset.standard": "Standard",
			"preset.ptc": "PTC",
			"preset.minimal": "Minimal",
			"preset.cordis": "Cordis",
			"preset.failed": "Member \"{name}\" was created, but the mode switch failed ({code}) — it still runs on the session's mode.",
			// ── composer-left "send to team" entry ────────────────
			//
			// The composer itself is the SHIPPED one; we only add a button to the
			// left of its tool row. Opening it shows a member picker that inserts
			// `@Name ` into the official draft.
			"compose.trigger": "Send to team",
			"compose.title": "Pick the send scope",
			"compose.everyone": "Everyone",
			"compose.scopeOn": "To: {who}",
			"compose.hint":
				"After picking a scope, just write the message below (images / attachments welcome) and send — it is additionally delivered to the selected members. The scope applies to one message and resets itself.",
			"compose.empty": "No members yet. Teammates created by the Lead will show up here.",
			"compose.lead": "Lead",
			"compose.close": "Close",
			"compose.queued": "Handed to {name}, waiting for a reply.",
			"compose.inactive": "This member is {phase} and cannot receive messages (the protocol only delivers to active members).",
			"compose.inactiveTag": "Unreachable",
			"compose.sentAll": "Delivered to {count} member(s).",
			"compose.sentPartial": "{ok} delivered, {failed} not delivered ({names})",
			"compose.sentNone": "Nobody received it ({names})",
			// ── member menu ───────────────────────────────────────
			"members.trigger": "Members",
			"members.title": "Chat room members",
			"members.empty": "No AI members yet. Hit \"Add AI member\" above — each one gets its own conversation window.",
			"members.loading": "Loading…",
			"members.count": "{count}",
			"members.lead": "Lead",
			"members.phaseProvisioning": "Starting",
			"members.phaseFailed": "Failed",
			"members.edit": "Edit profile",
			"members.open": "Open chat",
			"members.stateIdle": "Not running",
			"members.editTitle": "Edit member profile",
			"members.name": "Name",
			"members.namePlaceholder": "e.g. Frontend, Market watcher",
			"members.duty": "Responsibility",
			"members.dutyPlaceholder": "e.g. Watch the market and report moves (blank uses the official description)",
			"members.instructions": "Instructions / skills",
			"members.instructionsPlaceholder": "e.g. analysis only, never edit code; read docs/analysis.md first.",
			"members.instructionsHint": "Sent as this member's opening message when it is created. Editing an existing member needs a rebuild to take effect.",
			"members.avatar": "Avatar",
			"members.avatarEmoji": "Emoji",
			"members.avatarText": "Text",
			"members.avatarImage": "Image",
			"members.avatarPlaceholder": "🦊",
			"members.avatarTextPlaceholder": "Initials, e.g. AK",
			"members.avatarUpload": "Choose image",
			"members.avatarClear": "Clear image",
			"members.avatarBadType": "Only PNG / JPEG / GIF / WebP / AVIF are supported.",
			"members.save": "Save",
			"members.cancel": "Cancel",
			"members.reset": "Reset",
			"members.saving": "Saving…",
			"members.saved": "Saved.",
			"members.saveFailed": "Save failed",
			"members.storeNote": "Profiles live inside the DSH install folder and survive plugin reinstall.",
			"members.close": "Close",
			"members.delete": "Delete profile",
			"members.deleteHint": "Only clears this member's profile in the plugin (name/duty/avatar). Its conversation window is untouched.",
			"members.deleted": "Profile reset to defaults.",
			// ── add an AI member ──────────────────────────────────
			//
			// ⚠ The member name is an IMMUTABLE identity field in the official Team
			// protocol — renaming is rejected. So the name is set once at creation;
			// afterwards only the display-name override above can change.
			"members.add": "Add AI member",
			"members.openPane": "Open in side panel",
			"members.addTitle": "Add AI member",
			"members.addHint": "\"Create\" opens a **separate conversation window** for this member — it shows up in the left sidebar like any session, and you can open or delete it any time.",
			// ── Adopt semantics (2026-09-28): member = an already-open conversation window ──
			"members.adoptTitle": "Adopt as AI member",
			"members.adoptHint": "Adopt an **already-open conversation window** as a team member: it keeps its chat history and **is renamed to the member name you give it**. From then on the window name follows the member name — renaming it in the conversation UI is reverted automatically.",
			"members.adoptTarget": "Window to adopt",
			"members.adoptTargetHint": "Defaults to the window you are viewing. Grouped into current / other windows, each showing the conversation's current name; windows already adopted as members are not listed.",
			"members.adoptGroupCurrent": "Current window",
			"members.adoptGroupOthers": "Other windows",
			"members.adoptNone": "No conversation window available to adopt. Open a conversation first, then come back.",
			"members.adoptNoTarget": "Pick the conversation window to adopt first.",
			"members.adoptBusy": "Adopting…",
			"members.adoptSubmit": "Adopt",
				"members.nameHintAdopted": "**This is how the AI refers to itself, and it becomes that conversation window\u2019s title**; changing it here updates the window name too.",
				"members.addNameHint": "Internal identifier (the team mailbox address; a-z, 0-9 and hyphens only). Leave empty to derive it from the name.",
				"members.nameRequired": "Please give this member a name.",
			"members.addDisplayNameHint": "Put a non-Latin name here — it becomes the title of that conversation window.",
			"members.addName": "Member ID (optional)",
			"members.addNamePlaceholder": "Leave empty to auto-generate",
			"members.addDuty": "Responsibility",
			"members.addDutyPlaceholder": "e.g. Watch the market and report moves (≤200 chars, required)",
			"members.addSubmit": "Create",
			"members.addBusy": "Creating window…",
			"members.addDone": "Created {name}.",
			"members.addTask": "Initial task (optional)",
			"members.addTaskPlaceholder": "Leave empty to use the responsibility above",
			"members.addTaskHint": "A real agent window is created; this text becomes its first message.",
			"members.addCreating": "Creating the agent window and verifying the process…",
			"members.addDoneWindow": "Created {name}; its window is confirmed live ({seconds}s).",
			"members.addBack": "Back to list",
			"members.addUnavailable": "Could not create this member. Please pass the raw error below back to us.",
			"members.errUnknown": "Creation failed",
			"members.errWindowNotCreated": "The session was created, but it could not be confirmed live. Please retry.",
			"members.errLeadExists": "This chat room already has a lead agent. Confirm in the form to replace it.",
			// ── Lead agent (team collaboration) ──────────────────
			"members.isLead": "Make it the lead agent",
			"members.isLeadDesc":
				"The lead agent sits in command: it splits the goal into tasks, hands them to members, receives their completion reports, reviews the output and decides whether to send work back. One per chat room.",
			"members.isLeadTaken":
				"⚠ This chat room already has a lead agent: “{name}”. Turning this on demotes it to a regular member — reports will go to the new lead.",
			"members.leadBadge": "Lead",
			"members.offline": "Idle",
			"members.addNameInvalid": "Member ID allows only lowercase letters, digits and hyphens (e.g. market-watcher), and cannot be \"lead\". Leave empty to auto-generate.",
			"members.addDutyRequired": "The responsibility description is required by the official API.",
			"members.errNoLiveCaller": "No live agent found for this session. Open the Team Lead's session first.",
			"members.errLeadRequired": "Only the Team Lead can create members.",
			"members.errNameTaken": "That name is already taken.",
			"members.errLimit": "Member limit reached.",
			"members.errUnavailable": "The official Team service is not enabled.",
			"members.addFailed": "Create failed",
			// ── remove a member ──────────────────────────────────
			"members.remove": "Remove",
			"members.removeConfirm": "Confirm?",
			"members.removed": "Removed.",
			"members.errRemoveNotFound": "No such member in this team.",
			// ── right-sidebar members pane ────────────────────────
			//
			// The sidebar "tab type" two-stage registration
			// (`sidebarRightTabs.register` + the `sidebar.right.pane.tab` slot)
			// needs a title and one guide card: the user opens the pane from the
			// guide that the sidebar's "new tab" control shows.
			"pane.title": "Chat room members",
			"pane.guideNew": "Members",
			"pane.guideDesc": "Edit avatars, display names and responsibilities, or add a new AI member.",
			// ── "Team members" panel in the left sidebar ─────────
			"members.page.jumping": "Opening this member's window…",
			"pane.loading": "Loading…",
			"pane.noSession": "Open a team session first.",
			"members.avatarHint": "Only images up to 1 MiB are accepted. Shrink larger files first.",
			"members.avatarTooLarge": "Image is {size}, over the 1 MiB cap. Pick a smaller one.",
			"members.mentionSection": "AI members",
			"entry.crashed": "UI error · Retry",
			"entry.crashedHint": "This entry threw while rendering and was contained in place. Click to retry. The stack was written to the Host log.",
			// ── member succession (hand-over) ────────────────────
			//
			// One word everywhere: "Succeed" is the button, "succession" the flow.
			// Three synonyms for one feature is the hardest thing to search for.
			"members.succession": "Succeed",
			"members.successionTitle": "Succession / hand-over",
			"members.successionHint":
				"Give this member a **brand-new session**: the AI in the old session writes a hand-over note first; the new session inherits its name, duty, custom instructions and avatar, and reads that note as its opening message.",
			"members.successionArchive": "What happens to the old session",
			"members.successionArchiveOpt": "Archive (recommended)",
			"members.successionKeepOpt": "Keep",
			"members.successionArchiveDesc":
				"Archive: the old session is kept exactly as it is (not a single message or log entry is deleted). It is only retitled to \"… (old · archived)\" and **stops receiving messages as this member**. Open it from the sidebar any time to read the history.",
			"members.successionKeepDesc":
				"Keep: the on-disk result is identical (nothing is deleted either) — the old session just keeps its original title. Two identically named windows are easy to mix up, and clicking the wrong one gets no member replies.",
			"members.successionConfirm": "Start succession",
			"members.successionBusy": "Asking the AI in the old session to write the hand-over note… (up to ~90s)",
			"members.successionBusyHint": "Please keep this page open. It is running one full round-trip in its own session; the swap happens only after it finishes.",
			"members.successionCancel": "Cancel",
			"members.successionNote": "The hand-over note is stored on the member profile, so it accumulates and can be reviewed later.",
			"members.successionNoSession": "This member has no session yet, so there is nothing to succeed.",
			"members.successionDone": "Succeeded: new session {session}.",
			"members.successionArchived": "The old session is archived ({old}) — it is still in the sidebar whenever you need the history.",
			"members.successionKept": "The old session kept its title ({old}) — it is still in the sidebar as well.",
			"members.successionNoteByMember": "Hand-over note: written by the AI in the old session itself ({chars} chars).",
			"members.successionNoteByLlm":
				"⚠ The hand-over note is **not** written by it: it failed to produce one, so the fallback ran (read its session log + one model call to distil it) — {chars} chars.",
			"members.successionNoteEmpty":
				"⚠ No hand-over note this time (both paths failed; the reason is in the Host log, search \"[succession]\"). The succession itself completed normally.",
			"members.successionNoteTruncated": " (the part over the limit was truncated)",
			"members.successionNotePanel": "Current hand-over note",
			"members.successionNoteEmptyPanel": "(no hand-over note right now)",
			"members.successionArchivedCount": "{count} archived session(s)",
			"members.successionFailed": "Succession failed",
			"members.successionHintSteerFailed":
				"⚠ The new session exists and the identity was handed over, but the opening message could not be delivered — open that window and paste the hand-over note to it manually.",
			// Section titles of the hand-over note. The keys (done/now/todo/
			// pitfalls/anchors) mirror HANDOVER_SECTIONS in the Host's
			// member-store.js one-to-one.
			"members.handover.done": "What I did",
			"members.handover.now": "Current state",
			"members.handover.todo": "To do",
			"members.handover.pitfalls": "Pitfalls / notes",
			"members.handover.anchors": "Key decisions / files / identifiers",
			// ── Localization of Host-side errors (EN side) ─────────
			//
			// The key is the Host's **stable error code**; the `err.` prefix keeps
			// it apart from the panel's own copy. The Host returns "code + English
			// fallback" together because it cannot see the UI language
			// (`ctx.locale` is a client-side service), so **this dictionary is the
			// real source of the wording**. With no code (old Host / a bare HTTP
			// error) we fall back to the raw `error` text — see `errorText()`.
			"err.TEAMCHAT_BODY_TOO_LARGE": "The request payload is too large for this endpoint.",
			"err.TEAMCHAT_BODY_INVALID_JSON": "The request payload is not valid JSON.",
			"err.TEAMCHAT_BODY_NOT_OBJECT": "The request payload must be a JSON object.",
			"err.TEAMCHAT_EMPTY_MESSAGE": "The message text cannot be empty.",
			"err.TEAMCHAT_NO_ROOM": "Missing session id.",
			"err.TEAMCHAT_MISSING_MEMBER_NAME": "Missing member name.",
			"err.TEAMCHAT_MEMBER_NOT_FOUND": "There is no member named \"{name}\" in this chat room.",
			"err.TEAMCHAT_MEMBER_REMOVE_FAILED": "Could not remove the member \"{name}\".",
			"err.TEAMCHAT_MEMBER_SAVE_FAILED": "Could not save the member \"{name}\".",
			"err.TEAMCHAT_MEMBER_REMOVED":
				"Removed from the member list. Its **conversation window is still in the workspace on the left** — delete that session there if you do not want to keep it.",
			"err.TEAMCHAT_NO_MEMBERS": "This chat room has no AI members yet. Add one from Member management.",
			"err.TEAMCHAT_NO_TARGET": "There is no member named \"{target}\" in this chat room.",
			"err.TEAMCHAT_MEMBER_NO_SESSION": "Missing the session id to adopt.",
			"err.TEAMCHAT_TARGET_NOT_FOUND":
				"This session was not found (it may have been deleted). Go back to the window you want to adopt and retry.",
			"err.TEAMCHAT_TARGET_IS_SUBAGENT":
				"This session is someone else's sub-agent and cannot be adopted as a member. Pick a conversation you started yourself.",
			"err.TEAMCHAT_ROOM_NO_CWD": "This session has no working directory, so it cannot be adopted as a member.",
			"err.TEAMCHAT_INVALID_MEMBER_NAME":
				"A member id may only contain a-z, 0-9 and lowercase hyphens, must be at most {max} characters, and cannot be \"lead\". Leave it blank to auto-generate.",
			"err.TEAMCHAT_MISSING_DESCRIPTION":
				"A duty description is required (the official protocol requires one, max {max} characters).",
			"err.TEAMCHAT_PRESET_UNAVAILABLE":
				"This host has no Agent preset service available, so a mode cannot be specified.",
			"err.TEAMCHAT_UNKNOWN_PRESET": "There is no Agent preset named {preset}. Available: {known}",
			"err.TEAMCHAT_LEAD_EXISTS":
				"This chat room already has a lead agent (\"{name}\"). Confirm the handover first.",
			"err.TEAMCHAT_ADOPT_FAILED": "Could not adopt this member.",
			// ── Reason codes from the member store (Host `lib/member-store.js`) ──
			//
			// These are **reason-level** codes, not route-level ones (the route-level
			// one is still `TEAMCHAT_MEMBER_SAVE_FAILED`). `/__teamchat/members`
			// returns them in the `cause` field and the UI shows "what + why"
			// together — the previous round showed only "could not save the member"
			// and thereby dropped *which* limit was exceeded and by how much.
			// The `{size}` / `{max}` numbers exist precisely to keep that.
			"err.TEAMCHAT_AVATAR_TOO_LARGE":
				"Avatar data is too large: {size} MB > {max} MB. Pick a smaller image.",
			"err.TEAMCHAT_MEMBER_TOO_LARGE":
				"This member profile exceeds the {max} MB cap (including the avatar's base64 expansion).",
			"err.TEAMCHAT_MEMBER_KEY_EMPTY": "The member id cannot be empty.",
			"err.TEAMCHAT_MEMBER_NO_FIELDS": "There was nothing to save in this request.",
			"err.TEAMCHAT_MEMBER_WRITE_FAILED": "Could not write the member profile to disk ({detail}).",
			// ── Succession (Host `lib/succession.js`) ─────────────
			//
			// All under the `TEAMCHAT_SUCC_` prefix to split one name that meant two
			// things: `TEAMCHAT_MEMBER_NO_SESSION` (`/spawn`) is "the **request** has
			// no session id to adopt" (a 4xx you can fix), while succession's was
			// "the **member profile** has no session id" (a data state; retrying won't
			// help). Sharing one code meant one of the two wordings had to be wrong.
			"err.TEAMCHAT_SUCC_MEMBER_NO_KEY": "Missing member name.",
			"err.TEAMCHAT_SUCC_MEMBER_NOT_FOUND": "No profile found for the member \"{name}\".",
			"err.TEAMCHAT_SUCC_MEMBER_NO_SESSION":
				"This member has no session of its own yet (profile only), so there is nothing to succeed.",
			"err.TEAMCHAT_SUCC_NOT_STEERABLE": "This session's agent does not accept deliveries.",
			"err.TEAMCHAT_SUCC_HANDOVER_TIMEOUT":
				"Waited {seconds} seconds and it did not produce a hand-over note.",
			"err.TEAMCHAT_SUCC_LLM_UNAVAILABLE": "This host has no usable llm service.",
			"err.TEAMCHAT_SUCC_MODEL_UNAVAILABLE":
				"Could not read the default model (agentDefaultModel.currentSelection).",
			"err.TEAMCHAT_SUCC_LLM_EMPTY": "The fallback distillation produced no text at all.",
			"err.TEAMCHAT_SUCC_LOG_EMPTY": "The session log has no usable text.",
			"err.TEAMCHAT_SUCC_LOG_UNAVAILABLE":
				"Could not get its session log (neither sessionQuery nor the live session would give it up).",
			"err.TEAMCHAT_SUCC_IN_FLIGHT":
				"A succession for \"{name}\" is already running (started at {since}); wait for it to finish.",
			"err.TEAMCHAT_SUCC_BUSY": "Too many successions at once (limit {max}); try again shortly.",
			"err.TEAMCHAT_SUCC_RUNTIME_UNAVAILABLE":
				"This host is missing the agents / sessionController service.",
			"err.TEAMCHAT_SUCC_SESSION_FAILED":
				"Could not create the new session: {detail}. Nothing about the member was changed.",
			"err.TEAMCHAT_SUCC_SESSION_NOT_LIVE":
				"The new session {session} was registered but never became a live session. Nothing about the member was changed.",
			"err.TEAMCHAT_SUCC_STEER_FAILED": "The hand-over request could not be delivered: {detail}",
			"err.TEAMCHAT_SUCC_MEMBER_STORE_FAILED":
				"Could not write the member profile: {detail}. Nothing about the member was changed.",
			"err.TEAMCHAT_SUCC_FAILED":
				"Succession failed: {detail}. Nothing about the member was changed.",
			"err.TEAMCHAT_UNKNOWN": "The operation failed. Please pass the raw error below back to us.",
			// 正文里内容块的占位符（`blocksToText`）—— 它是**消息正文**的一
			// 部分，会直接显示在气泡里，所以同样要跟界面语言走。
			"blocks.image": "[image]",
			"blocks.unknown": "[{type} content]",
		};

		/**
		 * 把内容块数组压成纯文本。
		 *
		 * 官方 `contentBlockSchema` 的块形如 `{ type: "text", text: "..." }`；
		 * 未知类型统一转为占位符，避免渲染崩。
		 *
		 * @param blocks - 内容块数组。
		 * @param t - 可选翻译函数。**不传就用中文兜底**：这个函数是导出面
		 *   的一部分（`client-test.mjs` / `markdown-render-test.mjs` 直接调
		 *   它两个参数都不给），强制传 `t` 会把这些既有断言打断。界面上的
		 *   调用点都会把 `t` 传进来。
		 */
		function blocksToText(blocks, t = null) {
			if (!Array.isArray(blocks)) return "";
			/** 取一条占位符文案；没有 `t` 或字典缺项时退回给定的中文。 */
			const label = (key, fallback, params) => {
				if (typeof t !== "function") return fallback;
				const text = t(key, params);
				// `t()` 缺项时返回的是 key 本身（不是空串）—— 显式判掉，
				// 否则界面上会冒出 `blocks.image` 这种键名。
				return typeof text === "string" && text !== "" && text !== key ? text : fallback;
			};
			const parts = [];
			for (const block of blocks) {
				if (block === null || typeof block !== "object") continue;
				if (typeof block.text === "string") {
					parts.push(block.text);
					continue;
				}
				if (block.type === "image") {
					parts.push(label("blocks.image", "[图片]"));
					continue;
				}
				const type = typeof block.type === "string" ? block.type : "未知内容";
				parts.push(label("blocks.unknown", `[${type} 内容]`, { type }));
			}
			return parts.join("\n");
		}

		// ══════════════════════════════════════════════════════════════════
		// Markdown 子集渲染器（**自己写的，不 require 任何 Harness Client 包**）
		//
		// 为什么不用官方渲染器：`dsh-cordis-plugin-development/references/practices.md`
		// 明文禁止插件 require 任何 Harness Client 包（`@deepseek-ai/dsh-client-ui-primitives`
		// 导出的 `MarkdownText` 就在禁列）。所以这里手写一个子集 —— 零依赖、零构建。
		//
		// 三条不可动摇的底线：
		// 1. **绝不拼 HTML 字符串**：一律 `react.createElement` 建真实元素树
		//    （正文来自 AI 成员，可能被对话内容注入；拼串 = 自己开 XSS 口子）。
		// 2. **链接只认白名单协议**：`http:` / `https:` / `mailto:`，其余
		//    （`javascript:` / `data:` / `vbscript:` …）**降级成纯文本**，不给可点的锚。
		// 3. **任何异常都退回 `blocksToText`**：见 `renderMarkdownBody` 的 try/catch
		//    —— 解析器崩掉只准退化成纯文本，绝不准把消息区搞白。
		//
		// 覆盖范围（子集，刻意不做）：段落 / ATX 标题 1-6 / GFM 表格（含对齐）/
		// 有序与无序列表（支持嵌套）/ 引用 / 围栏代码块 / 水平线 / 粗体 / 斜体 /
		// 行内代码 / 链接 / 删除线 / 硬换行 / 反斜杠转义。
		// **不做**：数学公式（katex）、代码语法高亮（shiki）、脚注、自动链接。
		// ══════════════════════════════════════════════════════════════════

		/**
		 * 行内节点类型白名单 —— 渲染前最后一道闸。
		 *
		 * 白名单比黑名单可靠：任何拼错的 `type`（渲染体里打错名字是高发事故）
		 * 会当场抛错，被 `renderMarkdownBody` 接住退回纯文本，而不是渲染出空节点。
		 */
		const MD_INLINE_TYPES = ["text", "code", "strong", "em", "del", "link", "br"];
		/** 块级节点类型白名单，理由同上。 */
		const MD_BLOCK_TYPES = ["paragraph", "heading", "code", "list", "quote", "rule"];

		/** 一个「行内节点」：`{type:"text", text}` / `{type:"link", href, nodes}` / `{type:"br"}`。 */
		const mdText = (text) => ({ type: "text", text: String(text) });

		/**
		 * 硬上限 —— **一个渲染器不该有能力打死整个界面**。
		 *
		 * 这是 2026-10-09 P0 事故（渲染进程 OOM、界面黑屏）的教训：那一次不是
		 * 「输入太脏」，而是解析器里有一处**不推进的循环**，40 条真实消息里有 3 条
		 * 能让它无限增长。构造样本全过 ≠ 真实数据不炸，所以除了修那处循环，
		 * 这里再加一层**与内容无关**的兜底：任何一项越界都**当场抛错**，
		 * `renderMarkdownBody` 接住它 ⇒ 这条消息退回纯文本 + 上报宿主
		 * （`report("markdown", …)`）。越界的代价从此是「这条消息没有排版」，
		 * 而不是「渲染进程死掉、界面黑屏」。
		 *
		 * 数值依据（都有实测）：
		 * - `input` 64 KiB：实测一个中型房间 `room-timeline.json` 里最长的一条是
		 *   4946 字符、总 62941 字符，留了一个量级余量；
		 * - `depth` 24：列表嵌套另有 6 层上限（`MD_MAX_LIST_DEPTH`），引用每层
		 *   `>` 只吃掉一层 —— 24 层手写引用在聊天里不存在，而几百层能把调用栈打穿；
		 * - `nodes` 20000 / `steps` 500000：真实最长那条解析出 577 个节点、
		 *   步数量级 1e4，离上限有几十倍余量，但足够把任何死循环按住。
		 */
		const MD_LIMITS = { input: 64 * 1024, depth: 24, nodes: 20000, steps: 500000 };

		/**
		 * 当前解析的预算（每次解析建一份，`parseMarkdown` 负责建 / 撤）。
		 *
		 * 用模块级变量而不是层层传参：整个解析是**同步**的（独占一条调用栈），
		 * 期间不可能有第二次解析插进来；为了透传它去改一圈内部函数签名，
		 * 只会把这块本来就该保持简单的代码搞乱。
		 */
		let mdBudget = null;

		/**
		 * 记一次解析开销；越界即抛。
		 *
		 * ⚠ 抛错是这条路上**唯一允许的失败方式**：它一定能被
		 * `renderMarkdownBody` 的 try/catch 接住。反过来，「不抛、继续跑」在死循环
		 * 面前等于把渲染进程交出去 —— 这正是 P0 事故里发生的事。
		 *
		 * @param steps - 本次迭代消耗的步数（循环里每转一圈算一步）。
		 * @param nodes - 本次产出的节点数。
		 */
		const mdSpend = (steps = 1, nodes = 0) => {
			const budget = mdBudget;
			if (budget === null) return;
			budget.steps -= steps;
			budget.nodes -= nodes;
			if (budget.steps < 0) {
				throw new Error(`markdown: 解析步数超过上限 ${MD_LIMITS.steps}（疑似不推进的循环）`);
			}
			if (budget.nodes < 0) {
				throw new Error(`markdown: 产出节点数超过上限 ${MD_LIMITS.nodes}`);
			}
		};

		/**
		 * 归一化链接目标，并判断协议是否放行。
		 *
		 * ⚠ 先**去掉控制字符再判协议**：`java\tscript:alert(1)` 之类靠空白拆分
		 * 绕过朴素前缀判断的写法必须一起挡掉。
		 *
		 * @param raw - Markdown 里写的目标原文（可能带标题部分）。
		 * @returns 放行时返回归一化后的 `href`，否则返回 null。
		 */
		function mdSafeHref(raw) {
			const target = String(raw ?? "").replace(/[\u0000-\u0020\u007f]/gu, "").trim();
			if (target === "") return null;
			const match = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/u.exec(target);
			// 没有协议头 = 相对链接。插件这套界面里没有路由解析器，给出去只会 404，
			// 所以同样降级成纯文本。
			if (match === null) return null;
			const scheme = match[1].toLowerCase();
			if (scheme !== "http" && scheme !== "https" && scheme !== "mailto") return null;
			return target;
		}

		/**
		 * 从 `[文字](目标)` 的括号里切出「目标」。
		 *
		 * Markdown 允许 `(url "标题")` / `(url '标题')` —— 只取 URL 那一段。
		 *
		 * @param raw - 括号内的原文。
		 * @returns 目标字符串。
		 */
		function mdLinkTarget(raw) {
			const value = String(raw).trim();
			const match = /^<?([^\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?$/u.exec(value);
			return match === null ? value : match[1];
		}

		/**
		 * 从 `](` 之后找到链接目标的收尾 `)`，**按括号配对**数。
		 *
		 * ⚠ 不能直接用 `indexOf(")")`：目标里本来就可能带括号
		 * （`https://en.wikipedia.org/wiki/Foo_(bar)`、`javascript:alert(1)`），
		 * 取第一个 `)` 会把目标截断，多出来的尾巴还会当成正文渲染出来
		 * （真踩过：`[点我](javascript:alert(1))` 渲染成「点我」+ 一个孤零零的 `)`）。
		 *
		 * @param src - 整段原文。
		 * @param from - 目标起点下标。
		 * @returns 收尾 `)` 的下标；没有则返回 -1。
		 */
		function mdFindTargetEnd(src, from) {
			let depth = 0;
			for (let at = from; at < src.length; at += 1) {
				const ch = src[at];
				if (ch === "\\") {
					at += 1;
					continue;
				}
				if (ch === "(") depth += 1;
				else if (ch === ")") {
					if (depth === 0) {
						// 同上：记账按扫过的字符数算（这条扫描找不到收尾 `)` 时
						// 会一路扫到文末，是另一个二次复杂度来源）。
						mdSpend(at - from + 1);
						return at;
					}
					depth -= 1;
				}
			}
			mdSpend(src.length - from);
			return -1;
		}

		/**
		 * 把一个块内的原文文本解析成行内节点数组（**可嵌套**）。
		 *
		 * 自左向右扫描，一次消费一个构造，剩下的递归 —— 不用巨型正则，
		 * 因为「粗体里有 `代码`」这种嵌套用单个正则表达不了。
		 *
		 * @param text - 块内原文（可能含 `\n`，段内换行在 `inlineOf` 里已处理过）。
		 * @param depth - 递归深度，防止病态输入把栈打爆。
		 * @returns 行内节点数组。
		 */
		function mdInline(text, depth = 0) {
			const src = String(text);
			if (src === "") return [];
			// 深度或长度任何一项越界：**不解析**，原样吐出（宁可少渲染，不许崩）。
			// 这两条是**就地降级**（不是抛错）：行内嵌套太深只是丢掉一层强调，
			// 没有理由把整条消息退成纯文本。真正的兜底是外层那份预算（会抛错）。
			if (depth > MD_LIMITS.depth || src.length > MD_LIMITS.input) return [mdText(src)];

			/** 在 `end` 之前找到 `mark` 的结束位置；找不到返回 -1。 */
			const findMark = (mark, from) => {
				let at = src.indexOf(mark, from);
				while (at !== -1) {
					if (src[at - 1] !== "\\") {
						// 记账按**扫过的字符数**，不按「调用了几次」——
						// 「向后找收尾标记」这一族扫描才是二次复杂度的来源（
						// 比如 `[a](b` 重复一万次：每次 `[` 都要扫到文末），
						// 只数循环圈数会把它整个漏掉。
						mdSpend(at - from + mark.length);
						return at;
					}
					at = src.indexOf(mark, at + 1);
				}
				mdSpend(src.length - from);
				return -1;
			};

			const nodes = [];
			let buffer = "";
			let i = 0;
			while (i < src.length) {
				mdSpend(1);
				const ch = src[i];

				// ① 反斜杠转义：`\*` → 字面量 `*`，不当强调。
				if (ch === "\\" && i + 1 < src.length) {
					buffer += src[i + 1];
					i += 2;
					continue;
				}

				// ② 行内代码：反引号。内容原样，**不**再做行内解析。
				if (ch === "`") {
					const close = findMark("`", i + 1);
					if (close === -1) {
						buffer += ch;
						i += 1;
						continue;
					}
					const code = src.slice(i + 1, close);
					if (buffer !== "") {
						nodes.push(mdText(buffer));
						buffer = "";
					}
					nodes.push({ type: "code", text: code });
					i = close + 1;
					continue;
				}

				// ③ 链接 / 图片：`[文字](目标)` / `![替代](源)`。
				if (ch === "[") {
					const labelEnd = findMark("]", i + 1);
					if (labelEnd !== -1 && src[labelEnd + 1] === "(") {
						const targetEnd = mdFindTargetEnd(src, labelEnd + 2);
						if (targetEnd !== -1) {
							const raw = src.slice(labelEnd + 2, targetEnd);
							const target = mdSafeHref(mdLinkTarget(raw));
							if (buffer !== "") {
								nodes.push(mdText(buffer));
								buffer = "";
							}
							const inner = mdInline(src.slice(i + 1, labelEnd), depth + 1);
							// 协议不放行 / 相对路径 ⇒ **不带 href 的纯文本**
							// （不产出可点的锚）。`raw` 留着给 `title` 用。
							nodes.push({
								type: "link",
								href: target,
								raw: mdLinkTarget(raw),
								nodes: inner.length === 0 ? [mdText(src.slice(i + 1, labelEnd))] : inner,
							});
							i = targetEnd + 1;
							continue;
						}
					}
					buffer += ch;
					i += 1;
					continue;
				}

				// ④ 图片：本子集**不加载任何远程资源**（正文来自 AI 成员，
				//    自动发请求属于不该有的副作用），降级成替代文字。
				if (ch === "!" && src[i + 1] === "[") {
					const labelEnd = findMark("]", i + 2);
					if (labelEnd !== -1 && src[labelEnd + 1] === "(") {
						const targetEnd = mdFindTargetEnd(src, labelEnd + 2);
						if (targetEnd !== -1) {
							buffer += src.slice(i + 2, labelEnd);
							i = targetEnd + 1;
							continue;
						}
					}
					buffer += ch;
					i += 1;
					continue;
				}

				// ⑤ 粗体 `**` / 删除线 `~~`：要求等长收尾，`**a*` 不成立就当字面量。
				if ((src.startsWith("**", i) || src.startsWith("~~", i)) && src[i + 1] === ch) {
					const mark = ch + ch;
					const close = findMark(mark, i + 2);
					if (close > i + 2) {
						if (buffer !== "") {
							nodes.push(mdText(buffer));
							buffer = "";
						}
						nodes.push({
							type: ch === "*" ? "strong" : "del",
							nodes: mdInline(src.slice(i + 2, close), depth + 1),
						});
						i = close + mark.length;
						continue;
					}
				}

				// ⑥ 斜体 `*` / `_`（`_` 只在词边界起作用，避免 snake_case 被拆）。
				if (ch === "*" || ch === "_") {
					const before = i === 0 ? "" : src[i - 1];
					const leftOk =
						ch === "*"
							? true
							: !/[0-9A-Za-z\u4e00-\u9fff]/u.test(before) && before !== ch;
					const close = leftOk ? findMark(ch, i + 1) : -1;
					if (close > i + 1) {
						const after = src[close + 1] ?? "";
						const rightOk =
							ch === "*"
								? true
								: !/[0-9A-Za-z\u4e00-\u9fff]/u.test(after) && after !== ch;
						if (rightOk) {
							if (buffer !== "") {
								nodes.push(mdText(buffer));
								buffer = "";
							}
							nodes.push({ type: "em", nodes: mdInline(src.slice(i + 1, close), depth + 1) });
							i = close + 1;
							continue;
						}
					}
				}

				buffer += ch;
				i += 1;
			}

			if (buffer !== "") nodes.push(mdText(buffer));
			// 节点记账（返回时一次性记，理由同 `mdBlocks`）。
			mdSpend(0, nodes.length);
			// 一个字都没解析出来（整段都是字面量）也返回节点数组，调用方统一处理。
			return nodes.length === 0 ? [mdText(src)] : nodes;
		}

		/**
		 * 段内换行 → 硬换行 / 软换行。
		 *
		 * CommonMark：行尾**两个及以上空格** = 硬换行（`<br>`）；
		 * 单个换行 = 软换行，按空格接上（官方观感也是折行而不是换行）。
		 *
		 * @param text - 段落原文。
		 * @returns 行内节点数组。
		 */
		function mdInlineOfParagraph(text) {
			const parts = String(text).split("\n");
			const out = [];
			for (let at = 0; at < parts.length; at += 1) {
				if (at > 0) {
					if (/ {2,}$/u.test(parts[at - 1])) out.push({ type: "br" });
					else out.push(mdText(" "));
				}
				out.push(...mdInline(parts[at].replace(/[ \t]+$/u, "")));
			}
			return out;
		}

		/**
		 * 按**未转义**的 `|` 切表格行。
		 *
		 * `\|` 是单元格里的字面量竖线，不能当分隔符（交给行内解析还原）。
		 *
		 * @param line - 表格行原文。
		 * @returns 单元格字符串数组。
		 */
		function mdSplitCells(line) {
			const text = String(line).trim();
			const cells = [];
			let current = "";
			for (let i = 0; i < text.length; i += 1) {
				const ch = text[i];
				if (ch === "\\" && text[i + 1] === "|") {
					current += "\\|";
					i += 1;
					continue;
				}
				if (ch === "|") {
					cells.push(current);
					current = "";
					continue;
				}
				current += ch;
			}
			cells.push(current);
			// GFM：首尾那两个 `|` 是装饰，不算单元格。
			if (cells.length > 1 && cells[0].trim() === "") cells.shift();
			if (cells.length > 1 && cells[cells.length - 1].trim() === "") cells.pop();
			return cells;
		}

		/**
		 * 分隔行 → 每列的对齐方式；不是合法分隔行时返回 null。
		 *
		 * @param line - 疑似 `| --- | :---: | ---: |` 的一行。
		 * @returns `["left"|"center"|"right", …]` 或 null。
		 */
		function mdDelimiterRow(line) {
			if (!String(line).includes("|")) return null;
			const cells = mdSplitCells(line);
			if (cells.length === 0) return null;
			const align = [];
			for (const cell of cells) {
				const value = cell.trim();
				if (!/^:?-{1,}:?$/u.test(value)) return null;
				align.push(value.startsWith(":") && value.endsWith(":") ? "center" : value.endsWith(":") ? "right" : "left");
			}
			return align;
		}

		/**
		 * 两行是否构成「表头 + 分隔行」。
		 *
		 * 列数不一致 ⇒ **不是表格**，调用方按普通段落处理（不崩、不错位）。
		 *
		 * @param head - 表头行。
		 * @param next - 下一行。
		 * @returns 对齐数组或 null。
		 */
		function mdTableStart(head, next) {
			if (typeof head !== "string" || typeof next !== "string") return null;
			if (!head.includes("|")) return null;
			const align = mdDelimiterRow(next);
			if (align === null) return null;
			return align.length === mdSplitCells(head).length ? align : null;
		}

		/**
		 * 一行是不是「看起来像表格行」—— 只为决定段落在哪断句。
		 *
		 * @param line - 原文行。
		 * @returns 是否含未转义竖线。
		 */
		function mdLooksLikeRow(line) {
			return /(^|[^\\])\|/u.test(String(line));
		}

		/**
		 * 读一个行内 / 块级构造的行尾标记（`#`×n 这类）。
		 *
		 * @param text - 行首文本。
		 * @param re - 锚在行首的正则，命中即返回。
		 * @returns 命中信息或 null。
		 */
		function mdMatch(text, re) {
			const match = re.exec(text);
			return match === null ? null : { raw: match[0], groups: match.slice(1) };
		}

		/** 行首标记锚点。**顺序即优先级**：`***` 必须先判水平线，再判无序列表。 */
		const MD_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u;
		const MD_RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
		const MD_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/u;
		const MD_QUOTE = /^ {0,3}>[ \t]?(.*)$/u;
		const MD_BULLET = /^(\s*)([-*+])[ \t]+(.*)$/u;
		const MD_ORDERED = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/u;

		/** 列表嵌套深度上限：超过就把剩下的当普通段落（宁可少渲染，不许递归爆栈）。 */
		const MD_MAX_LIST_DEPTH = 6;

		/**
		 * 解析一个列表（可嵌套）。
		 *
		 * @param lines - 全部行。
		 * @param start - 起始行下标（必须是列表项行）。
		 * @param depth - 当前嵌套深度。
		 * @returns `{ node, next }` —— 列表节点与下一行的下标。
		 */
		function mdList(lines, start, depth) {
			const markerRe = MD_ORDERED.test(lines[start]) ? MD_ORDERED : MD_BULLET;
			const ordered = markerRe === MD_ORDERED;
			const baseMatch = markerRe.exec(lines[start]);
			const baseIndent = baseMatch === null ? 0 : baseMatch[1].length;
			const items = [];
			let loose = false;
			let i = start;

			while (i < lines.length) {
				// 本项的起始行 —— 每个循环体末尾用它收敛「下标必须严格前进」。
				const itemAt = i;
				mdSpend(1);
				const line = lines[i];
				if (line.trim() === "") {
					// 空行只有「后面还接着同一个列表」时才算列表的一部分（= 松散列表）。
					const next = lines[i + 1];
					if (next === undefined) break;
					const nextMatch = markerRe.exec(next);
					const continues = nextMatch !== null ? nextMatch[1].length <= baseIndent : /^\s+/u.test(next);
					if (!continues) break;
					loose = true;
					i += 1;
					continue;
				}
				const match = markerRe.exec(line);
				if (match === null || match[1].length !== baseIndent) break;

				const contentStart = match[3] ?? "";
				const markerEnd = line.length - contentStart.length;
				const pad = /^ */u.exec(contentStart)[0].length;
				const indent = pad >= 1 && pad <= 4 ? markerEnd + pad : markerEnd + 1;
				const content = pad >= 1 && pad <= 4 ? contentStart.slice(pad) : contentStart;
				let itemLines = [content];
				// ⚠⚠ `endLine` 必须是**行号**，这里原来写的是 `markerEnd` —— 那是
				//    「内容在这一行里的**列号**」。于是下面 `i = endLine + 1` 是在拿列号
				//    当行号用：`- x` 的列号是 2 ⇒ 处理完第 3 行后 i 被拨回 3 ⇒
				//    第 3 行又被当成列表项 ⇒ `items` 无限增长 ⇒ **渲染进程 OOM**
				//    （2026-10-09 P0：40 条真实消息里 3 条能触发，进聊天室即黑屏）。
				let endLine = i;
				let j = i + 1;
				while (j < lines.length) {
					const raw = lines[j];
					if (raw.trim() === "") {
						// 空行后面得有缩进行才继续吃，否则列表到此为止。
						const after = lines[j + 1];
						if (after === undefined) break;
						if (after.trim() === "" || after.length - after.trimStart().length < indent) break;
						itemLines.push("");
						endLine = j;
						j += 1;
						continue;
					}
					if (raw.length - raw.trimStart().length < indent) break;
					mdSpend(1);
					itemLines.push(raw.slice(indent).replace(/\s+$/u, ""));
					endLine = j;
					j += 1;
				}

				let itemInline = null;
				let itemBlocks = null;
				if (content.trim() !== "" && mdTableStart(content, itemLines[1] ?? null) === null && !/^\s*(?:[-*+]|\d{1,9}[.)])\s+/u.test(itemLines[1] ?? "")) {
					itemInline = mdInlineOfParagraph(content);
					// 紧随其后的缩进行如果不是嵌套列表 / 表格，就接到同一个段落里。
					let k = 1;
					while (k < itemLines.length) {
						const raw = itemLines[k];
						if (raw.trim() === "") break;
						if (/^\s*(?:[-*+]|\d{1,9}[.)])\s+/u.test(raw)) break;
						if (mdTableStart(raw, itemLines[k + 1] ?? null) !== null) break;
						itemInline.push({ type: "br" });
						itemInline.push(...mdInline(raw));
						k += 1;
					}
					itemBlocks = itemLines.slice(k);
				} else {
					itemBlocks = itemLines;
				}

				items.push({ blocks: mdBlocks(itemBlocks, depth + 1), inline: itemInline });
				mdSpend(1, 1);
				i = endLine + 1;
				// 死循环保险：下标必须**严格大于**本项起点。
				// ⚠ 上一版写的是 `if (i <= endLine && i <= start) i = start + 1;` ——
				//   而 i 恒等于 `endLine + 1`，`i <= endLine` **永远为假**，
				//   这个保险等于不存在（P0 事故的帮凶，不是防线）。
				if (i <= itemAt) i = itemAt + 1;
			}

			return {
				node: { type: "list", ordered, items, tight: !loose },
				next: Math.max(i, start + 1),
			};
		}

		/**
		 * 解析块级结构：按行切块，每个块再交给行内解析。
		 *
		 * @param lines - 行数组。
		 * @param depth - 递归深度（列表嵌套 / 引用嵌套共用这一个计数）。
		 * @returns 块节点数组。
		 */
		function mdBlocks(lines, depth = 0) {
			// 块级递归深度上限（引用每层 `>` 只吃掉一层，所以这是唯一能把它堆深的路）。
			// 越界**抛错**而不是就地降级：这样它会走「退回纯文本 + 上报」那条既定路径，
			// 用户看得见消息、我们也收得到原因。
			if (depth > MD_LIMITS.depth) {
				throw new Error(`markdown: 块级嵌套超过上限 ${MD_LIMITS.depth}`);
			}
			const blocks = [];
			let i = 0;
			while (i < lines.length) {
				mdSpend(1);
				const line = lines[i];

				// 空行：块之间的分隔，跳过。
				if (line.trim() === "") {
					i += 1;
					continue;
				}

				// ① 围栏代码块 —— 内容**原样**，内部绝不做行内解析。
				const fence = mdMatch(line, MD_FENCE);
				if (fence !== null) {
					const marker = fence.groups[0][0];
					const size = fence.groups[0].length;
					const info = String(fence.groups[1] ?? "").trim();
					const body = [];
					let closed = false;
					let j = i + 1;
					// 收尾围栏：**不能写 `\`` 去转义反引号** —— 带 `u` 标志时
					// `\`` 是非法转义，`new RegExp` 会当场抛 SyntaxError
					// （真踩过：整个围栏块掉进纯文本降级路径）。
					// 用 repeat 拼字面量，反引号与 `~` 都不用转义。
					const closeRe = new RegExp(`^ {0,3}${marker}{${size},}[ \\t]*$`, "u");
					while (j < lines.length) {
						if (closeRe.test(lines[j])) {
							closed = true;
							break;
						}
						body.push(lines[j]);
						j += 1;
					}
					// 没闭合也照常渲染（CommonMark 就是这样），只是到文末收尾。
					blocks.push({ type: "code", lang: info, code: body.join("\n") });
					i = closed ? j + 1 : j;
					continue;
				}

				// ② 水平线。**必须在列表之前判**：`- - -` 两边都像，但它是水平线。
				if (MD_RULE.test(line)) {
					blocks.push({ type: "rule" });
					i += 1;
					continue;
				}

				// ③ ATX 标题。
				const heading = mdMatch(line, MD_HEADING);
				if (heading !== null) {
					const text = String(heading.groups[1] ?? "");
					// 官方观感：标题也是行内解析的（`## 关于 **X**`）。
					blocks.push({
						type: "heading",
						level: heading.groups[0].length,
						// 结尾那串 `#`（`## 标题 ##`）是装饰，去掉。
						text: mdInline(text.replace(/[ \t]+#+[ \t]*$/u, "").replace(/[ \t]+$/u, "")),
					});
					i += 1;
					continue;
				}

				// ④ 引用：连续的 `>` 行合成一个块，内部递归解析。
				if (MD_QUOTE.test(line)) {
					const inner = [];
					let j = i;
					while (j < lines.length) {
						const match = mdMatch(lines[j], MD_QUOTE);
						if (match === null) break;
						inner.push(match.groups[0]);
						j += 1;
					}
					blocks.push({ type: "quote", blocks: mdBlocks(inner, depth + 1) });
					i = j;
					continue;
				}

				// ⑤ 列表。
				if (MD_BULLET.test(line) || MD_ORDERED.test(line)) {
					if (depth >= MD_MAX_LIST_DEPTH) {
						blocks.push({ type: "paragraph", nodes: mdInlineOfParagraph(line.trim()) });
						i += 1;
						continue;
					}
					const list = mdList(lines, i, depth);
					blocks.push(list.node);
					i = list.next;
					continue;
				}

				// ⑥ GFM 表格：表头 + 分隔行 + 若干行；列数不一致的行**丢弃**
				//    （宁可少渲染几行，也不许把表格结构撑错位）。
				const align = mdTableStart(line, lines[i + 1] ?? null);
				if (align !== null) {
					// 单元格里的行内标记**照常解析**（`**1**` 要真的变成粗体），
					// 所以存的是行内节点而不是拍平的字符串。
					const head = mdSplitCells(line).map((cell) => mdInline(cell.trim()));
					const rows = [];
					let j = i + 2;
					while (j < lines.length && lines[j].trim() !== "" && lines[j].includes("|")) {
						const cells = mdSplitCells(lines[j]);
						if (cells.length !== align.length) {
							j += 1;
							continue;
						}
						rows.push(cells.map((cell) => mdInline(cell.trim())));
						j += 1;
					}
					blocks.push({ type: "table", align, head, rows });
					i = j;
					continue;
				}

				// ⑦ 段落：吃到下一个块边界（空行 / 标题 / 围栏 / 引用 / 列表 / 表格）为止。
				const para = [line];
				let j = i + 1;
				while (j < lines.length) {
					const raw = lines[j];
					if (raw.trim() === "") break;
					if (MD_FENCE.test(raw) || MD_HEADING.test(raw) || MD_QUOTE.test(raw)) break;
					if (MD_BULLET.test(raw) || MD_ORDERED.test(raw)) break;
					// 这一行是表格表头、且下一行是它的分隔行 ⇒ 段落到此为止。
					if (mdLooksLikeRow(raw) && mdTableStart(raw, lines[j + 1] ?? null) !== null) break;
					para.push(raw);
					j += 1;
				}
				blocks.push({ type: "paragraph", nodes: mdInlineOfParagraph(para.join("\n")) });
				i = j;
			}
			// 节点记账：在**返回时**一次性记（循环每转一圈已经记了一步，所以这里的
			// 增长漏不掉；一次性记账也免得把计数塞进每个 push 点）。
			mdSpend(0, blocks.length);
			return blocks;
		}

		/**
		 * 整段文本 → 块节点数组。
		 *
		 * 这里是**预算的建立点**：任何入口（`renderMarkdownBody` / 直接导出调用）
		 * 都从这里进，所以上限不会被绕过。越界抛错 → 调用方接住 → 退回纯文本。
		 *
		 * @param text - Markdown 原文（可能含 `\r\n`）。
		 * @returns 块节点数组。
		 */
		function parseMarkdown(text) {
			const source = String(text ?? "").replace(/\r\n?/gu, "\n");
			if (source.length > MD_LIMITS.input) {
				throw new Error(`markdown: 正文 ${source.length} 字符，超过上限 ${MD_LIMITS.input}`);
			}
			// 预算建在**最外层**那次解析上（嵌套调用不会再建一份，也不会提前撤掉）。
			const outermost = mdBudget === null;
			if (outermost) mdBudget = { steps: MD_LIMITS.steps, nodes: MD_LIMITS.nodes };
			try {
				const lines = source.split("\n");
				// 尾部空行会造成一个空的收尾段落，去掉。
				while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
				return mdBlocks(lines, 0);
			} finally {
				if (outermost) mdBudget = null;
			}
		}

		/**
		 * 渲染一个行内节点（含递归）。
		 *
		 * @param node - 行内节点。
		 * @param key - React key。
		 * @returns 元素 / 字符串。
		 */
		function mdRenderInline(node, key) {
			if (!MD_INLINE_TYPES.includes(node.type)) {
				throw new Error(`markdown: unknown inline node: ${String(node.type)}`);
			}
			if (node.type === "text") return node.text;
			if (node.type === "br") return react.createElement("br", { key });
			if (node.type === "code") return react.createElement("code", { key, className: "tc-md-code" }, node.text);
			if (node.type === "link") {
				const children = mdRenderNodes(node.nodes, key);
				// `href === null` = 协议不放行 / 相对路径 ⇒ 不给锚点，只留文字（不可点）。
				// `title` 用**原文**（不是白名单结果）如实标出它原本指向哪 ——
				// 悬停能看出「这里本来有个链接」，但不给它任何可点能力。
				if (node.href === null || node.href === undefined) {
					const raw = typeof node.raw === "string" ? node.raw : "";
					return react.createElement(
						"span",
						{ key, className: "tc-md-link-off", title: raw === "" ? undefined : raw },
						children,
					);
				}
				return react.createElement(
					"a",
					{ key, className: "tc-md-link", href: node.href, target: "_blank", rel: "noreferrer" },
					children,
				);
			}
			const tag = node.type === "strong" ? "strong" : node.type === "em" ? "em" : "del";
			return react.createElement(tag, { key }, mdRenderNodes(node.nodes, key));
		}

		/**
		 * 渲染一组行内节点。
		 *
		 * @param nodes - 行内节点数组。
		 * @param prefix - key 前缀（同一父节点下唯一即可）。
		 * @returns React children 数组。
		 */
		function mdRenderNodes(nodes, prefix) {
			const list = Array.isArray(nodes) ? nodes : [];
			return list.map((node, index) => mdRenderInline(node, `${prefix}-${index}`));
		}

		/**
		 * 渲染一个列表项的内容。
		 *
		 * `tight`（项之间没有空行）时行内内容直接进 `<li>`；
		 * 松散列表则包 `<p>`（官方 Markdown 观感一致）。
		 *
		 * @param item - `{inline, blocks}`。
		 * @param tight - 列表是否紧凑。
		 * @param key - React key。
		 * @returns `<li>` 元素。
		 */
		function mdRenderItem(item, tight, key) {
			const children = [];
			if (Array.isArray(item.inline) && item.inline.length > 0) {
				if (tight) children.push(...mdRenderNodes(item.inline, `${key}-i`));
				else children.push(react.createElement("p", { key: `${key}-p` }, mdRenderNodes(item.inline, `${key}-i`)));
			}
			for (let at = 0; at < item.blocks.length; at += 1) {
				children.push(mdRenderBlock(item.blocks[at], `${key}-${at}`));
			}
			return react.createElement("li", { key }, children);
		}

		/**
		 * 渲染一个块级节点。
		 *
		 * ⚠ 渲染体里**打错字段名是会当场抛错的**（白名单只挡 `type`），
		 * 所以每个取值都做类型收敛，不许出现 `undefined` 直接进 DOM。
		 *
		 * @param block - 块节点。
		 * @param key - React key。
		 * @returns 元素 / null。
		 */
		function mdRenderBlock(block, key) {
			if (!MD_BLOCK_TYPES.includes(block.type)) {
				throw new Error(`markdown: unknown block node: ${String(block.type)}`);
			}
			if (block.type === "rule") {
				return react.createElement("hr", { key, className: "tc-md-rule" });
			}
			if (block.type === "code") {
				return react.createElement(
					"pre",
					{ key, className: "tc-md-pre" },
					react.createElement("code", { className: "tc-md-code" }, block.code),
				);
			}
			if (block.type === "heading") {
				const level = Math.min(Math.max(Number(block.level) || 1, 1), 6);
				return react.createElement(`h${level}`, { key, className: "tc-md-h" }, mdRenderNodes(block.text, key));
			}
			if (block.type === "paragraph") {
				const children = mdRenderNodes(block.nodes, key);
				if (children.length === 0) return null;
				return react.createElement("p", { key, className: "tc-md-p" }, children);
			}
			if (block.type === "list") {
				const items = Array.isArray(block.items) ? block.items : [];
				const tag = block.ordered === true ? "ol" : "ul";
				return react.createElement(
					tag,
					{ key, className: "tc-md-list" },
					items.map((item, index) => mdRenderItem(item, block.tight === true, `${key}-${index}`)),
				);
			}
			// quote：只放行**块级**子节点（白名单递归），别的一律丢掉。
			const inner = Array.isArray(block.blocks) ? block.blocks : [];
			return react.createElement(
				"blockquote",
				{ key, className: "tc-md-quote" },
				inner.map((child, index) =>
					child !== null && typeof child === "object" && MD_BLOCK_TYPES.includes(child.type)
						? mdRenderBlock(child, `${key}-${index}`)
						: null,
				),
			);
		}

		/**
		 * 渲染一张 GFM 表格。
		 *
		 * @param block - `{align, head, rows}`。
		 * @param key - React key。
		 * @returns `<table>` 元素。
		 */
		function mdRenderTable(block, key) {
			const align = Array.isArray(block.align) ? block.align : [];
			const columns = align.length;
			// 单元格内容走**同一套行内渲染**（粗体 / 代码 / 链接都能用），
			// 所以这里是节点数组而不是字符串。
			const cell = (tag, nodes, column, cellKey) =>
				react.createElement(
					tag,
					{ key: cellKey, className: "tc-md-td", style: { textAlign: align[column] ?? "left" } },
					mdRenderNodes(nodes, cellKey),
				);
			const head = Array.isArray(block.head) ? block.head : [];
			const rows = Array.isArray(block.rows) ? block.rows : [];
			return ["| " + String(block.align ?? "") + " | " + JSON.stringify(block.head ?? null) + " | " + JSON.stringify(block.rows ?? null)];
			return react.createElement(
				"table",
				{ key, className: "tc-md-table" },
				react.createElement(
					"thead",
					null,
					react.createElement(
						"tr",
						null,
						head.slice(0, columns).map((nodes, column) => cell("th", nodes, column, `${key}-h${column}`)),
					),
				),
				react.createElement(
					"tbody",
					null,
					rows.map((row, rowIndex) =>
						react.createElement(
							"tr",
							{ key: `r${rowIndex}` },
							row.slice(0, columns).map((nodes, column) => cell("td", nodes, column, `${key}-r${rowIndex}c${column}`)),
						),
					),
				),
			);
		}

		/**
		 * 渲染 Markdown 正文 —— **Bubble 只能走这个入口**。
		 *
		 * 两条路径：
		 * - 成功：返回 `tc-md` 容器（真实元素树，绝不拼接 HTML 字符串，绝不用
		 *   `dangerouslySetInnerHTML`）。
		 * - 任何异常（解析崩、节点类型不认识、渲染体打错字段）：返回原来的
		 *   `tc-bubble-text` 纯文本 `<span>`，并把异常上报宿主 ——
		 *   **降级不许静默**，但降级本身必须是「消息照样看得见」。
		 *
		 * @param text - 正文原文。
		 * @param render - 渲染函数，**只为测试注入**（生产调用不传）。
		 *   有它才证明得了「内部抛错 ⇒ 退回纯文本」这条：不注入就只能靠
		 *   构造畸形输入去猜抛点，那是假证据。
		 * @returns React 元素。
		 */
		function renderMarkdownBody(text, render = mdRender) {
			try {
				return render(text);
			} catch (error) {
				report("markdown", error);
				return react.createElement("span", { className: "tc-bubble-text" }, String(text ?? ""));
			}
		}

		/**
		 * 真正的解析 + 渲染（解析与渲染都在这里，**必须整体在 try 内**）。
		 *
		 * @param text - 正文原文。
		 * @returns `tc-md` 容器元素。
		 */
		function mdRender(text) {
			const blocks = parseMarkdown(text);
			return react.createElement(
				"div",
				{ className: "tc-bubble-text tc-md" },
				blocks.map((block, index) =>
					block.type === "table" ? mdRenderTable(block, `b${index}`) : mdRenderBlock(block, `b${index}`),
				),
			);
		}

		// ══════════════════════════════════════════════════════════════════
		// 折叠：头部标题永远露着，正文折起来
		//
		// 为什么要有折叠（用户 2026-10-09 提的架构性修改）：
		// P0 事故的本质不只是解析器里那处死循环，还有**工作量模型**——
		// 进房间时一次性把 N 条消息全渲染成完整 Markdown 树，工作量与
		// 「房间里有多少条消息」成正比。折叠把它改成：
		//   进房间 = 只渲染每条消息的**头部一行**（常数级、有上限）；
		//   规模只跟「展开了几条」成正比。
		// 于是「一条病态消息」最多让**它自己那条**退化成纯文本（渲染器还有硬上限兜底），
		// 而不是一进房间就拖死整个界面。
		//
		// ⚠ 折叠态**绝不把正文送进解析器**——这是这个设计的全部意义。
		//    头部那一行是唯一进解析器的东西，所以它自己必须也有长度上限。
		// ══════════════════════════════════════════════════════════════════

		/** 头部最多渲染多少字符（头部永远露着，也是进解析器的东西）。 */
		const MD_HEAD_MAX = 200;
		/** 头部兜底（既没标题也没加粗行）时，第一行截到这么长。 */
		const MD_HEAD_FALLBACK = 120;
		/** 短消息阈值：正文行数 ≤ 3 且总字数 ≤ 200 ⇒ 不折叠，直接全显。 */
		const MD_SHORT_LINES = 3;
		const MD_SHORT_CHARS = 200;

		/**
		 * 取一条消息的「头部」：整条里最像标题的那一行。
		 *
		 * 优先级（用户定的规矩）：Markdown 标题行 → 主体是加粗的那一行 →
		 * 第一行兜底。允许行首有少量前缀（`①②`、`- `、emoji）再跟 `**`。
		 *
		 * @param text - 正文原文。
		 * @returns `{text, kind}` —— `text` 已按上限截断。
		 */
		function mdHeadOf(text) {
			const lines = String(text ?? "").split("\n");
			let fallback = "";
			for (const raw of lines) {
				const line = raw.trim();
				if (line === "") continue;
				if (fallback === "") fallback = line;
				// ① Markdown 标题行（`#` ~ `######` + 空白）——最明确的「这是标题」。
				if (/^#{1,6}[ \t]+\S/u.test(line)) {
					return { text: line.slice(0, MD_HEAD_MAX), kind: "heading" };
				}
			}
			// ② 主体是加粗的一行：行首最多 8 个字符的前缀（编号 / 项目符号 / emoji）
			//    之后就是 `**…**`。`u` 标志下 `.` 按码点算，emoji 只占一个。
			for (const raw of lines) {
				const line = raw.trim();
				if (line === "") continue;
				if (/^.{0,8}\*\*[^*\n]+\*\*/u.test(line)) {
					return { text: line.slice(0, MD_HEAD_MAX), kind: "bold" };
				}
			}
			// ③ 兜底：第一行本身（截得更短 —— 它不是标题，只是预览的第一句）。
			return { text: fallback.slice(0, MD_HEAD_FALLBACK), kind: "first" };
		}

		/**
		 * 一条消息的折叠信息。
		 *
		 * @param entry - 时间线条目。
		 * @param t - 可选翻译函数（正文里的占位符如 `[图片]` 要跟语言走）。
		 *   不传就用中文兜底，理由同 `blocksToText`（它是导出面的一部分）。
		 * @returns `{head, lines, chars, collapsible}`。
		 *   `collapsible === false` ⇒ 短消息，直接整条显示（别让用户读一句话还要点一下）。
		 */
		function mdCollapsibleOf(entry, t = null) {
			const full = blocksToText(entry.blocks, t);
			const lines = full === "" ? 0 : full.split("\n").length;
			const chars = full.length;
			const head = mdHeadOf(full);
			// 短消息不折：「正文行数 ≤ 3 且总字数 ≤ 200」。
			// 阈值写成常量（MD_SHORT_LINES / MD_SHORT_CHARS）而不是散在判断里，
			// 免得以后改一处漏一处。
			const collapsible = !(lines <= MD_SHORT_LINES && chars <= MD_SHORT_CHARS);
			return { head, lines, chars, collapsible };
		}

		/**
		 * 成员资料 HTTP 客户端。
		 *
		 * 走宿主侧 `MemberStore`（`/__teamchat/members`）：
		 * GET 全量、POST 写入或删除。**持久化在 DSH 安装目录**，
		 * 不是 profile、不是 localStorage —— 清缓存、换 profile 都不丢。
		 */
		const membersApi = {
			async list() {
				const response = await fetch("/__teamchat/members", { headers: { accept: "application/json" } });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const payload = await response.json();
				return payload?.members ?? {};
			},
			/**
			 * @param key - 成员键。
			 * @param member - 要写的字段（**只有显式给的字段会被写**，见 `member-store`）。
			 * @param options - `{replaceLead: true}` = 「我知道这个房间已经有主智能体，
			 *   还是要换人」。与 `/__teamchat/spawn` 的 `replaceLead` 是同一套语义：
			 *   宿主默认拒绝「第二个主智能体」，只有显式确认才让它把原主智能体降级。
			 *   只影响 `member.isLead === true` 的那一次写入。
			 */
			async save(key, member, options = {}) {
				const response = await fetch("/__teamchat/members", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						key,
						action: "set",
						member,
						...(options.replaceLead === true ? { replaceLead: true } : {}),
					}),
				});
				const payload = await response.json().catch(() => null);
				if (!response.ok || payload?.ok !== true) {
					// 官方错误码挂在 `code` 上（调用方按它挑本地化文案）；
					// 宿主自己的 `TEAMCHAT_*` 码挂在 `hostCode` 上 —— 两者不
					// 抢同一个字段，免得官方码被宿主码覆盖掉。
					// `hostParams` 是码里 `{占位符}` 的取值（缺哪个名字之类）。
					const error = new Error(payload?.error ?? `HTTP ${response.status}`);
					error.code = payload?.code ?? "TEAM_MEMBER_SAVE_FAILED";
					error.hostCode = payload?.code;
					error.hostParams = payload?.params;
					// ⚠ `cause` / `causeParams`：宿主在**路由级**码之外还给了
					//   **原因级**码（成员库那条：头像过大 / 资料过大 / 落盘失败）。
					//   只印路由级码会把「哪里超了、超了多少」抹掉 —— 见
					//   `saveFailureText` 与 `member-store.js` 里的注释。
					error.causeCode = payload?.cause;
					error.causeParams = payload?.causeParams;
					throw error;
				}
				return payload.members ?? {};
			},
			async remove(key) {
				const response = await fetch("/__teamchat/members", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ key, action: "remove" }),
				});
				const payload = await response.json().catch(() => null);
				if (!response.ok || payload?.ok !== true) {
					const error = new Error(payload?.error ?? `HTTP ${response.status}`);
					error.code = payload?.code ?? "TEAM_MEMBER_REMOVE_FAILED";
					error.hostCode = payload?.code;
					error.hostParams = payload?.params;
					error.causeCode = payload?.cause;
					error.causeParams = payload?.causeParams;
					throw error;
				}
				return payload.members ?? {};
			},
			/**
			 * 成员「交替」。
			 *
			 * ⚠ 这条请求**可能要等 90 秒** —— 宿主那边是同步等旧会话里的 AI
			 * 把交接说明写出来。所以刻意**不加** `AbortController` 超时：
			 * 客户端先掐断只会让用户看到一个失败提示，而宿主那边其实还在跑、
			 * 最后照样把会话换掉了 —— 界面与实际状态不一致，比慢更糟。
			 * 真正的上限在宿主侧（`succession.js` 的 `HANDOVER_WAIT_MS`）。
			 *
			 * @param key - 成员名（标识）。
			 * @param options - `{archive}`：`true`（默认）= 旧会话归档；
			 *   `"keep"` 由调用方翻成 `archive: false`。
			 * @returns 宿主回执（原样透传，界面按 `handover.source` 说清是谁写的）。
			 */
			async succession(key, options = {}) {
				const response = await fetch("/__teamchat/succession", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ memberKey: key, archive: options.archive !== false }),
				});
				const payload = await response.json().catch(() => null);
				if (!response.ok || payload?.ok !== true) {
					const error = new Error(payload?.error ?? `HTTP ${response.status}`);
					// 宿主给的是**稳定错误码**，比匹配消息文本可靠 ——
					// 与 spawnErrorMessage 那套一致。`hostCode` / `hostParams`
					// 是给 `errorText()` 查字典 + 填占位符用的。
					error.code = payload?.code;
					error.hostCode = payload?.code;
					error.hostParams = payload?.params;
					// 502 那条回执是 `{ok:false, ...result}` —— `code` / `error` /
					// 将来的 `params` 都在 `payload` 顶层，所以上面这三个字段就是
					// 全部需要的东西，不必再存一份 payload（存了反而两套真相）。
					throw error;
				}
				return payload;
			},
		};

		/**
		 * 聊天室成员名单（**宿主权威版**）。
		 *
		 * 为什么不能只看客户端那份 `agentTeam` 投影：投影是随**会话被打开**
		 * 才进浏览器的（`state.projectionsBySession[...]`），没打开过的会话在
		 * 客户端是空的。宿主侧 `sessionProjections.stateOf()` 不受这个限制 ——
		 * 所以「这个聊天室里到底有谁」一律以宿主这份为准，投影只当即时快照用。
		 *
		 * 顺带把「已移除」名单一起带回来，省一次往返。
		 */
		const roomApi = {
			/**
			 * @param rootSessionId - Lead 会话 id；空串 = 本机**所有** Lead 会话的并集。
			 * @returns `{members, removed}` —— `members` 每项是
			 *   `{name, sessionId, phase, description, rootSessionId}`。
			 */
			async roster(rootSessionId) {
				const query =
					typeof rootSessionId === "string" && rootSessionId !== ""
						? `?sessionId=${encodeURIComponent(rootSessionId)}`
						: "";
				const response = await fetch(`/__teamchat/team-members${query}`, {
					headers: { accept: "application/json" },
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const payload = await response.json();
				return {
					members: Array.isArray(payload?.members) ? payload.members : [],
					removed: Array.isArray(payload?.removed) ? payload.removed : [],
				};
			},
		};

		/**
		 * 添加 AI 成员的宿主代理。
		 *
		 * 为什么不能直接调官方 API：`spawnTeammate` 要求 caller 是**精确的 live
		 * Lead Agent 对象**，那是宿主侧的运行时对象，浏览器端拿不到。
		 * 所以这里只发一个 HTTP 请求，由宿主侧的 `/__teamchat/spawn` 代办。
		 */
		const spawnApi = {
			/**
			 * 创建一名 AI 成员 —— 本质是让 Lead **真的起一个 agent 窗口**。
			 *
			 * 宿主侧会：① 补全官方要求的 `provider` / `context` / `prompt`；
			 * ② 轮询到该 agent 真的进入 `ctx.agents` 才返回成功。
			 * 所以「拿到 member」= 窗口确实存在，不是只写了一个名字。
			 *
			 * @param {{parentSessionId: string, name: string, description: string, task?: string, preset?: string}} input
			 * @returns `{member, window, preset}` —— `window` 带 `sessionId` / `waitedMs`；
			 *   `preset` 是「模式」的落地结果（`null` = 这次没指定）。
			 */
			async create(input) {
				const response = await fetch("/__teamchat/spawn", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(input),
				});
				const payload = await response.json().catch(() => null);
				if (!response.ok || payload?.ok !== true) {
					// 把官方错误码挂在 `code` 上、宿主自己的码挂在 `hostCode` 上
					// （`hostParams` 是码里 `{占位符}` 的取值）—— 调用方据此挑
					// 本地化文案，见 `spawnErrorMessage` / `errorText`。
					const error = new Error(payload?.error ?? `HTTP ${response.status}`);
					error.code = payload?.code ?? "TEAM_SPAWN_FAILED";
					error.hostCode = payload?.code;
					error.hostParams = payload?.params;
					throw error;
				}
				return {
					member: payload.member ?? null,
					window: payload.window ?? null,
					preset: payload.preset ?? null,
				};
			},
		};

		/**
		 * 给**成员**发消息 / 移除成员。
		 *
		 * ⚠ 官方邮箱是**严格点对点**的（每条消息只有一个 `targetId`，没有广播入口），
		 * 所以「默认所有人都收到」由宿主**循环发 N 条**实现。
		 * ⚠ 官方协议里成员**删不掉**（团队事件 append-only、工具里也没有移除），
		 * `remove` 能做到的是：停止运行 + 从本插件界面移除。
		 */
		const teamApi = {
			/**
			 * 设定「发送到团队」的范围 —— **下一次**从这个会话发出的真人消息投给谁。
			 *
			 * 不直接发消息：用户要复用官方输入框（那样才有附图 / 附件能力），
			 * 所以这里只是把范围交给宿主，等官方消息落地时由宿主投递。
			 *
			 * @param root - `{parentSessionId, target}`；`target` 空串 = 所有人，
			 *   `null` = 取消。
			 */
			async scope(root) {
				const response = await fetch("/__teamchat/scope", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(root),
				});
				const payload = await response.json().catch(() => null);
				if (!response.ok || payload?.ok !== true) {
					const error = new Error(payload?.error ?? `HTTP ${response.status}`);
					error.code = payload?.code;
					error.hostCode = payload?.code;
					error.hostParams = payload?.params;
					throw error;
				}
				return payload.scope ?? null;
			},
			/**
			 * @param root - `{parentSessionId, text, target}`；`target` 空串 = 广播给全部成员。
			 * @returns `{delivered}`，每项 `{name, ok, status?, error?}`。
			 */
			async send(root) {
				const response = await fetch("/__teamchat/send", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(root),
				});
				const payload = await response.json().catch(() => null);
				if (!response.ok || payload === null) {
					const error = new Error(payload?.error ?? `HTTP ${response.status}`);
					error.code = payload?.code ?? "TEAM_SEND_FAILED";
					error.hostCode = payload?.code;
					error.hostParams = payload?.params;
					throw error;
				}
				return payload;
			},
			/**
			 * @param root - `{parentSessionId, name}`。
			 * @returns 宿主的完整回执（含 `note`：官方协议层面的说明）。
			 */
			async remove(root) {
				const response = await fetch("/__teamchat/remove", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(root),
				});
				const payload = await response.json().catch(() => null);
				if (!response.ok || payload?.ok !== true) {
					const error = new Error(payload?.error ?? `HTTP ${response.status}`);
					error.code = payload?.code ?? "TEAM_REMOVE_FAILED";
					error.hostCode = payload?.code;
					error.hostParams = payload?.params;
					throw error;
				}
				return payload;
			},
		};


		/**
		 * 可作为 Team Lead 的**根会话**清单。
		 *
		 * 官方 Team 协议里 teammate 只能是某个 Lead 的子会话，而只有
		 * `session.header.parentSession === undefined` 的会话能当 Lead。
		 * 所以「新建 AI 成员」必须先选一个挂载点 —— 这里就是那个清单。
		 */
		const targetsApi = {
			async list() {
				const response = await fetch("/__teamchat/targets", { headers: { accept: "application/json" } });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const payload = await response.json();
				return Array.isArray(payload?.targets) ? payload.targets : [];
			},
		};

		/**
		 * 官方 Agent 预设（界面上叫「模式」）。
		 *
		 * 宿主返回的是**原始清单**：官方附带的 4 个预设（standard / ptc /
		 * minimal / cordis）在配置里只写了 id 与 order，**没有 name**
		 * ——显示名走我们自己的字典，未知 id 才回退成 id 本身。
		 */
		const presetsApi = {
			async list() {
				const response = await fetch("/__teamchat/presets", { headers: { accept: "application/json" } });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const payload = await response.json();
				return {
					available: payload?.available === true,
					presets: Array.isArray(payload?.presets) ? payload.presets : [],
				};
			},
		};

		/**
		 * AI 成员对话窗口顶部那一行 —— **显示成员名**（以及职责小字），不是官方那份职责描述。
		 *
		 * 名字从团队投影反查：投影的成员行只有 `{id, name, role, phase}`，
		 * 所以用 `lineageSessionId`（= 该会话 id）匹配出成员的**官方名**，
		 * 再用本地资料表把官方名换成**显示名**（用户配的中文名）。
		 *
		 * 拿不到成员名时（官方内置 subagent、或投影还没加载）退回显示 `displayTitle`，
		 * 别把标题区留空。
		 *
		 * @param lineageSessionId - 这个面包屑代表的会话 id（槽的 ownerProps 直给）。
		 * @param displayTitle - 会话标题，退路用。
		 * @param useSessions - 会话集合选择器（标准 prop）。
		 */
		function MemberHeaderLineage({ lineageSessionId, displayTitle, useSessions }) {
			// ⚠ selector 必须返回**稳定的值**（字符串 / 布尔），否则每次渲染都是新对象
			// → 无限重渲染。所以拆成两个。
			//
			// 只认 `role === "teammate"`：团队名单里还有一条 `role: "lead"` 的行，
			// 它的 `id` 就是**根会话自己**。不排除掉的话，普通根会话的标题区会凭空
			// 冒出 Lead 的名字 —— 官方对根会话是不渲染这一行的。
			const memberName = useSessions((state) => {
				for (const snapshot of Object.values(state.projectionsBySession ?? {})) {
					const list = snapshot?.values?.agentTeam?.members;
					if (!Array.isArray(list)) continue;
					const row = list.find((member) => member?.id === lineageSessionId);
					if (row !== undefined) {
						return row.role === "teammate" && typeof row.name === "string" ? row.name : null;
					}
				}
				return null;
			});
			// 子会话（含官方内置 subagent）才显示这一行；根会话保持官方的空白。
			const isSubagent = useSessions(
				(state) => state.byId?.[lineageSessionId]?.subagent !== undefined,
			);
			const [profiles] = useMembers("member-lineage");

			if (memberName === null) {
				// 不是我们的成员：官方 subagent 退化成显示会话标题（少了它那个切换下拉），
				// 普通/根会话返回 null —— 与官方行为一致，不在标题区凭空加东西。
				return isSubagent && typeof displayTitle === "string" && displayTitle !== ""
					? react.createElement("span", { className: "tc-lineage-name" }, displayTitle)
					: null;
			}

			const profile = profiles[memberName];
			const label =
				typeof profile?.displayName === "string" && profile.displayName.trim() !== ""
					? profile.displayName.trim()
					: memberName;
			const duty = typeof profile?.duty === "string" ? profile.duty.trim() : "";

			return react.createElement(
				"span",
				{ className: "tc-lineage", title: duty === "" ? label : `${label} · ${duty}` },
				react.createElement("span", { className: "tc-lineage-name" }, label),
				duty === "" ? null : react.createElement("span", { className: "tc-lineage-duty" }, duty),
			);
		}

		/**
		 * 成员资料订阅。
		 *
		 * SSE 的 `members` 帧与本地乐观更新共用同一份 state，
		 * 所以编辑后立刻能看到，不必等回环。
		 *
		 * @returns `[members, reload]` —— members 是 `{key: profile}` 映射。
		 */
		function useMembers(clientId = "members") {
			const [members, setMembers] = react.useState({});

			const reload = react.useCallback(async () => {
				try {
					setMembers(await membersApi.list());
				} catch {
					// 拿不到就保持现状；菜单里会因为没有资料而退化成只显示名字。
				}
			}, []);

			react.useEffect(() => {
				let closed = false;
				let source = null;
				let retry = null;

				void reload();

				const connect = () => {
					if (closed) return;
					source = new EventSource(`/__teamchat/events?clientId=${clientId}`);
					source.onmessage = (message) => {
						if (closed) return;
						try {
							const payload = JSON.parse(message.data);
							if (payload?.type === "members") setMembers(payload.members ?? {});
						} catch {
							/* 单帧坏掉忽略 */
						}
					};
					source.onerror = () => {
						if (closed) return;
						source?.close();
						source = null;
						retry = setTimeout(connect, 5000);
					};
				};

				connect();
				return () => {
					closed = true;
					if (retry !== null) clearTimeout(retry);
					source?.close();
				};
			}, [reload]);

			return [members, reload];
		}

		/**
		 * 当前聊天室的成员名单（宿主权威 + 客户端投影兜底）。
		 *
		 * 数据源优先级：宿主 `/__teamchat/team-members?sessionId=`（权威）→
		 * 调用方拿到的是**宿主权威名单**：成员是独立会话，
		 * 客户端那份 `agentTeam` 投影里根本没有它们。
		 *
		 * @param leadSessionId - Lead 会话 id。
		 * @returns `[{members, removed}, reload]` —— `removed` 是「已移除」名单。
		 */
		function useRoomRoster(leadSessionId) {
			const [state, setState] = react.useState({ members: [], removed: [] });
			// 用 ref 存 id：`reload` 才能保持稳定引用，
			// 让「创建/移除成员后手动刷新」不依赖外部闭包里的旧 id。
			const target = react.useRef(leadSessionId);
			target.current = leadSessionId;

			const reload = react.useCallback(async () => {
				const id = target.current;
				if (typeof id !== "string" || id === "") {
					setState({ members: [], removed: [] });
					return;
				}
				try {
					setState(await roomApi.roster(id));
				} catch {
					/* 拿不到就只用客户端投影那份，别把界面清空 */
				}
			}, []);

			react.useEffect(() => {
				void reload();
			}, [reload, leadSessionId]);

			return [state, reload];
		}

		/**
		 * 从字符串稳定地算一个色相。
		 *
		 * 不用随机数：同一成员每次渲染必须同色，否则头像一跳一跳的。
		 *
		 * @param seed - 稳定标识（成员 key）。
		 * @returns 0-359 的色相。
		 */
		function hueOf(seed) {
			let hash = 0;
			for (let index = 0; index < seed.length; index += 1) {
				hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
			}
			return hash % 360;
		}

		/**
		 * 成员头像。
		 *
		 * 三级降级：自定义 emoji/文字 → 显示名首字 → 色块圆。
		 * 颜色由 key 哈希决定，保证同一成员稳定同色。
		 *
		 * @param props.fallbackLabel - 资料表里查不到 `displayName` 时，取首字用它。
		 *   「我」那一侧需要：资料表里常常**没有** `lead` 那一条（用户从没在设置页
		 *   配过自己），不给兜底就会按 memberKey 取首字、画出一个孤零零的「L」。
		 */
		function Avatar({ memberKey, profile, size = 28, fallbackLabel }) {
			const style = { width: size, height: size, fontSize: Math.round(size * 0.5) };
			const avatar = profile?.avatar;

			if (avatar?.kind === "emoji" || avatar?.kind === "text") {
				return react.createElement(
					"span",
					{
						className: "tc-avatar",
						"data-kind": avatar.kind,
						style: { ...style, background: `hsl(${hueOf(memberKey)} 62% 92%)` },
						"aria-hidden": "true",
					},
					avatar.value,
				);
			}
			if (avatar?.kind === "image") {
				return react.createElement(
					"span",
					{ className: "tc-avatar", "data-kind": "image", style },
					react.createElement("img", { src: avatar.value, alt: "", className: "tc-avatar-img" }),
				);
			}

			const initial = (profile?.displayName ?? fallbackLabel ?? memberKey).trim().charAt(0).toUpperCase() || "?";
			return react.createElement(
				"span",
				{
					className: "tc-avatar",
					"data-kind": "initial",
					style: { ...style, background: `hsl(${hueOf(memberKey)} 58% 88%)` },
					"aria-hidden": "true",
				},
				initial,
			);
		}

		/**
		 * 单个消息气泡。
		 *
		 * 显示名走本地覆写（`members[senderName].displayName`），
		 * 所以菜单里改完名字，历史消息也会跟着变 —— 这正是"回显到会话"的含义。
		 *
		 * @param props.entry - 时间线条目。
		 * @param props.t - 翻译函数。
		 * @param props.members - 成员资料映射。
		 * @param props.duties - 官方职责描述映射（本地覆写为空时兜底）。
		 */
		/**
		 * 槽条目的**自带错误边界**。
		 *
		 * ## 为什么必须有：DSH 会「一次抛错 = 永久除名」
		 *
		 * 渲染器给每个条目都包了一层边界（`dsh-client-ui-renderer/lib/client.js:611`
		 * 的 `SlotErrorBoundary`），捕获后调
		 * `host.reportEntryError(slotKey, entry, error, {abdicate: spec.kind !== "chain"})`
		 * （同文件 `:1117`）。对 `single` / `keyed` / `list` 这三种**遮蔽型**槽，
		 * `abdicate` 为真，于是（`dsh-client-ui-slots/lib/index.js:455-463`）：
		 *
		 * ```js
		 * if (info.abdicate) { this.abdicated.add(entry); … }   // 永久记进 WeakSet
		 * ```
		 *
		 * 而 `entriesOfSlot` 解析格子时第一件事就是 `if (this.abdicated.has(entry)) continue;`
		 * （同文件 `:286`）—— 条目从此**再也不参与渲染**，并且**重复上报是 no-op**，
		 * 注册还留在账本上（所以也没有任何东西会去重新注册它）。
		 *
		 * 结论：我们的组件**只要抛过一次**，那个入口就**永久消失**，
		 * 而且是**全局**消失（槽账本是全局的，不是按会话的）。
		 * 症状正好是「切了几次会话之后，每个对话的入口都不见了」。
		 * console 里那行 `slot entry crashed in '<slot>'` 只在渲染进程里，
		 * 桌面端日志根本看不到 —— 所以还要顺手把堆栈 POST 回宿主
		 * （`/__teamchat/report` → `logger.error`）。
		 *
		 * ## 这层边界做什么
		 *
		 * 挡在 DSH 那层前面：我们的子树再抛，也只到这里为止，
		 * DSH 那条边界永远看不到 ⇒ 条目不会被判死刑。
		 * 失败时**就地降级**成一个小胶囊，点一下重试（重置自身 state 即可，
		 * 条目与注册都没动过）。
		 *
		 * ⚠ 边界**只能盖住组件**。渲染器装配阶段的错误发生在边界之外
		 * （`standardKit` 缺 locale face、`StrictSessionEntry` 缺 scope binding、
		 * `inject` 工厂本身抛错），那几种仍然会触发除名 —— 而它们都是
		 * 「我们声明错了」的装配错误，本来就该在启动时炸掉，不该静默。
		 */
		class TCEntryBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
				this.retry = () => this.setState({ failed: false });
			}

			static getDerivedStateFromError() {
				// **不 rethrow** —— DSH 那层边界对 `SlotAssemblyError` 是 rethrow 的
				// （`dsh-client-ui-renderer` 的 `getDerivedStateFromError`），
				// 照抄那个写法等于把错误再交回去，白包一层。
				return { failed: true };
			}

			componentDidCatch(error) {
				// 渲染进程的 console 在桌面端会被拆成 `[renderer] [stderr]` 单行，
				// 堆栈会散掉 —— 走宿主上报才有完整原文。
				report(`entry-crash:${this.props.label}`, error);
			}

			render() {
				if (this.state.failed !== true) return this.props.children;
				// `silent`：影子条目（如权限遮蔽条）的降级就是**什么都不渲染**，
				// 渲染出一个小胶囊反而会把界面搞脏。
				if (this.props.silent === true) return null;
				const t = this.props.t;
				const text = typeof t === "function" ? t("entry.crashed") : "UI error · Retry";
				const hint = typeof t === "function" ? t("entry.crashedHint") : "";
				return react.createElement(
					"button",
					{
						type: "button",
						className: "tc-entry-error",
						title: hint,
						onClick: this.retry,
					},
					text,
				);
			}
		}

		/**
		 * 把一个组件包装成「带自带边界」的槽条目组件。
		 *
		 * ⚠ 必须是**函数组件包一层**，不能在 `register` 里临时拼：
		 * 包装层与内层都必须留在 React 的组件树里，内层的 hook 才照常工作。
		 *
		 * @param label - 上报用的条目名（会出现在宿主日志的 `entry-crash:<label>`）。
		 * @param Component - 真正的条目组件。
		 * @param options.silent - 降级时**不渲染任何东西**（影子条目用）。
		 * @returns 新的条目组件。
		 */
		function boundEntry(label, Component, options = {}) {
			const silent = options.silent === true;
			const Wrapped = (props) =>
				react.createElement(
					TCEntryBoundary,
					{ label, silent, t: props?.t },
					react.createElement(Component, props),
				);
			// 调试友好：React DevTools / 报错里能看出是这个条目。
			Wrapped.displayName = `TCEntry(${label})`;
			return Wrapped;
		}

		/**
		 * 「当前是否停在聊天室视图」。
		 *
		 * ⚠ 2026-10-08 起**只剩一个使用者**：输入框左侧的「发送到团队」
		 * （`TeamCompose`）。右上角「成员」入口已经**不再**按视图门控 ——
		 * 原因见 `MembersMenu` 的注释（用户要的是「哪一个会话里都可以加」，
		 * 而绑在模块级布尔上会带来一整类「入口凭空消失」）。
		 *
		 * ## 为什么需要它
		 *
		 * `conversation.view` 槽的官方契约是
		 * **"Registered Conversation target Views, rendered one at a time"**
		 * —— 同一时刻只渲染一个视图。所以「我们的 `TeamChatView` 挂载着」
		 * 就是「用户现在停在聊天室 tab」的**唯一可靠真相源**。
		 *
		 * ## 为什么不能用别的判据
		 *
		 * 曾经用「这个会话有没有 `agentTeam` 投影」当判据 —— 那是个**死锁**：
		 * 没团队 → 不显示入口 → 没法添加 AI → 永远建不出团队。
		 * 而且用户的心智是「我在聊天室 tab 里」，跟会话的数据状态无关。
		 *
		 * ## 翻过官方 API 了，没有现成的
		 *
		 * `uiConversation.binding(sessionId)` 里只有：
		 * - `activate(target)` —— 由**视图自己订阅 target 时**触发
		 *   （`target(id).subscribe` 内部调 `activate`）
		 * - `assembler.activateTarget()` 记的是一个 `Set`（谁激活过），
		 *   **没有「当前是哪个」的读取口**
		 *
		 * `conversation.view` 的 ownerProps 也只有
		 * `{inspectCall, viewRequest, openView, completeViewRequest}` —— 都是「切过去」，
		 * 没有「现在在哪」。所以只能自己按挂载状态记。
		 */

		let chatRoomActive = false;
		const chatRoomSubscribers = new Set();

		/** 切换状态并通知订阅者。重复设同值不发通知（避免注册/注销抖动）。 */
		const setChatRoomActive = (value) => {
			if (chatRoomActive === value) return;
			chatRoomActive = value;
			for (const listener of [...chatRoomSubscribers]) {
				try {
					listener();
				} catch (error) {
					report("chatRoom.notify", error);
				}
			}
		};

		/**
		 * 订阅「是否停在聊天室」。返回退订函数。
		 *
		 * 权限门控（非 React 环境）靠这个跟着 tab 切换注册/注销。
		 */
		const subscribeChatRoom = (listener) => {
			chatRoomSubscribers.add(listener);
			return () => {
				chatRoomSubscribers.delete(listener);
			};
		};

		/**
		 * React hook：订阅「是否停在聊天室」。
		 *
		 * ⚠ **刻意不用 `useSyncExternalStore`。**
		 *
		 * 那个 API 理论更优（不会读到撕裂的值、订阅前的那一帧不会读到旧值），
		 * 但它是 React 18 才引入的，而本插件的 `react` 是**由 DSH 从种子表注入**的
		 * —— 我们无从确认宿主给的是完整版还是裁剪过的构建。
		 * 拿一个「可能不存在的方法」去换一帧的视觉差异，不划算。
		 *
		 * ⚠⚠ **`useState + useEffect` 的代价就落在「订阅前那一帧」上，必须自己补**：
		 *
		 * 挂载时 `useState(chatRoomActive)` 读到的是**渲染那一刻**的模块值，
		 * 而订阅要等被动 effect 才装上。中间这个窗口里，只要模块值被改过
		 * （典型：我们在同一次提交里从「对话」切回「聊天室」，
		 * `TeamChatView` 的挂载 effect 就在这个窗口里把值改成 `true`），
		 * 那次通知**我们收不到** —— 组件就永久停在旧值上，
		 * 于是「切回去之后，添加成员的入口再也不出现」。
		 *
		 * 所以 effect 里先**无条件对齐一次真实值**，再订阅。
		 * `setActive` 收到同一个值时 React 会跳过重渲染，这一步不花代价。
		 */
		const useChatRoomActive = () => {
			const [active, setActive] = react.useState(chatRoomActive);
			react.useEffect(() => {
				// 1) 补上「渲染 → 订阅」之间漏掉的通知。
				setActive(chatRoomActive);
				// 2) 之后按通知走。读的是**当前值**，不受闭包快照影响。
				return subscribeChatRoom(() => {
					setActive(chatRoomActive);
				});
			}, []);
			return active;
		};


	/**
	 * 聊天室主视图（`conversation.view` 条目）。
	 *
	 * 渲染 props 由 `conversation.view` 的 renderer 传入
	 * （`{inspectCall, viewRequest, openView, completeViewRequest}`），
	 * 外加注册时 `inject` 工厂补的那份。
	 *
	 * 本体在 `TeamChatRoom`。这里只做两件「只有 session 作用域条目才有条件做」的事：
	 *  1. 用 `useSession` 算 `leadSessionId`（root 作用域没有这个 hook）；
	 *  2. 维护 `chatRoomActive`。
	 *
	 * ⚠ 主面板（main 槽）**不许**碰 `chatRoomActive`：那个标志的用户心智是
	 * 「停在聊天室 tab」，主面板开着时根本没有对话界面；碰了会让权限影子在
	 * 「退回对话的那一拍」错位（卸载 effect 与会话水合同帧竞争）。
	 */
	function TeamChatView({ sessionId, t, useSession, useSessions, remote }) {
		const { leadSessionId } = useTeamContext(useSession, useSessions, sessionId);

		// 挂载 = 用户停在了聊天室 tab（官方保证一次只渲染一个视图）。
		// 头部成员入口、输入框左侧「发送到团队」、以及权限按钮的影子
		// 全都跟着这个标志走。
		react.useEffect(() => {
			setChatRoomActive(true);
			return () => setChatRoomActive(false);
		}, []);

		return react.createElement(TeamChatRoom, { sessionId, leadSessionId, t, useSessions });
	}

	/**
	 * 聊天室本体（成员栏 + 连接横幅 + 时间线气泡流）。
	 *
	 * 被两个入口复用：
	 *  - `TeamChatView`（`conversation.view` 条目，session 作用域）；
	 *  - `TeamChatRoomPanel`（`main` 槽条目，root 作用域 —— 左侧栏「聊天室」按钮）。
	 *
	 * @param sessionId - 连 SSE / 查职责投影用的会话 id（主面板传「主区当前会话」）。
	 * @param leadSessionId - 拉成员名单用的会话 id（宿主 `roomKeyOf` 按它解析房间）。
	 */
	function TeamChatRoom({ sessionId, leadSessionId, t, useSessions }) {
		const [view, setView] = react.useState(null);
		const [connected, setConnected] = react.useState(false);
		const [members] = useMembers();
		/** 当前房间键（= 工作区）。帧按它比对，所以同一个工作室的窗口能一起刷新。 */
		const roomKeyRef = react.useRef(null);
		/** 消息滚动容器 —— 新消息要贴底。 */
		const scrollRef = react.useRef(null);

		// ── 折叠 / 展开 ────────────────────────────────────────────
		//
		// 默认**全部折叠**：进房间时每条消息只渲染头部一行（+ 一行规模提示），
		// 正文一个字符都不进 Markdown 解析器。于是「进房间」的工作量是**常数级**的、
		// 与房间里有 40 条还是 4000 条无关；规模只跟「用户点开了几条」成正比。
		//
		// 状态按 `entry.id` 记在组件里，**刻意不持久化**：刷新 / 切房间即回到折叠，
		// 内存与 DOM 规模每次都是从常数级起步，而「上次展开的那条」也不该跨会话粘着。
		const [expandedIds, setExpandedIds] = react.useState(() => new Set());
		const toggleEntry = (id) => setExpandedIds((current) => toggledIds(current, id));

			// ── 顶部成员栏的数据源 ────────────────────────────────
			//
			// ⚠⚠ 这里原来直接用了 `roomMembers`，**却从来没声明过它** ——
			// 于是 `TeamChatView` 每次渲染都抛
			// `ReferenceError: roomMembers is not defined`（第 5 轮引入，
			// 直到 2026-10-09 抓到宿主日志里的完整堆栈才定位）。
			// 后果远超「一行报错」：没有自带错误边界时，DSH 会把
			// `conversation.view` 这个条目**永久除名**，聊天室 tab 就此消失。
			//
			// 为什么不能拿 `agentTeam` 投影当数据源：成员改版后是**独立的顶层会话**，
			// 官方投影里根本没有它们（第 5 轮已确认）。所以名单只能问宿主
			// `/__teamchat/team-members?sessionId=`，走和成员面板**同一个** `useRoomRoster`。
			//
		// 房间按工作区解析（`useTeamContext` → `roomKeyOf`），
		// 所以在同房间的哪个窗口里看，这一栏都是同一份名单。
		const [room] = useRoomRoster(leadSessionId);
		// 已移除的成员不进成员栏 —— 与成员面板同一套过滤。
		// ⚠ `removed` 用 `Array.isArray` 兜一层：这里是**渲染体**，
		// 一个 `undefined.includes` 就是一次条目崩溃（代价见上面那段注释）。
		const removed = Array.isArray(room?.removed) ? room.removed : [];
		const roomMembers = rosterOf(room?.members).filter((item) => !removed.includes(item.key));

		// 官方职责描述：本地没写覆写时用它兜底显示。
			const team = useSessions((state) => state.projectionsBySession[sessionId]?.values.agentTeam);
			const duties = {};
			for (const member of Array.isArray(team?.members) ? team.members : []) {
				const key = member?.id ?? member?.name;
				if (typeof key === "string" && typeof member?.description === "string" && member.description !== "") {
					duties[key] = member.description;
				}
			}

			react.useEffect(() => {
				let closed = false;
				let source = null;
				let retry = null;

				const clientId =
					globalThis.crypto?.randomUUID?.() ??
					`tc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

				const connect = () => {
					if (closed) return;
					const url =
						`/__teamchat/events?clientId=${encodeURIComponent(clientId)}` +
						(sessionId === undefined ? "" : `&sessionId=${encodeURIComponent(sessionId)}`);
					source = new EventSource(url);

					source.onopen = () => {
						if (!closed) setConnected(true);
					};
					source.onmessage = (message) => {
						if (closed) return;
						try {
							const payload = JSON.parse(message.data);
							if (payload?.type !== "timeline") return;
							// ⚠ 房间日志**按工作区共享**（一个工作室一个聊天室），
							//    所以帧是按**房间键**认的，不是按会话 id：
							//    同一个工作区里换了窗口照样要刷新。
							//    首帧（建连快照）带 sessionId 兜底匹配。
							const sameRoom =
								typeof payload.roomKey === "string" &&
								payload.roomKey === roomKeyRef.current;
							if (sameRoom || payload.sessionId === sessionId) {
								if (typeof payload.roomKey === "string") roomKeyRef.current = payload.roomKey;
								setView(payload.view);
							}
						} catch {
							/* 单个坏帧忽略 */
						}
					};
					source.onerror = () => {
						if (closed) return;
						setConnected(false);
						source?.close();
						source = null;
						// 固定间隔重连；SSE 自带重连在某些代理下不可靠。
						retry = setTimeout(connect, 3000);
					};
				};

				connect();
				return () => {
					closed = true;
					if (retry !== null) clearTimeout(retry);
					source?.close();
				};
			}, [sessionId]);

			const entries = Array.isArray(view?.entries) ? view.entries : [];

			// 新消息进来时贴底 —— 聊天室不滚到最新一条就等于没看见。
			// 只在贴底时自动滚（用户往上翻历史时不打断他）。
			react.useEffect(() => {
				const box = scrollRef.current;
				if (box === null) return;
				box.scrollTop = box.scrollHeight;
			}, [entries.length]);

			/** 头像：图片 / emoji / 首字兜底（与成员面板同一套取值）。 */
			const avatarNode = (row) => {
				const avatar = avatarOf(row);
				if (avatar !== undefined && avatar.kind === "image") {
					return react.createElement("img", {
						src: avatar.value,
						alt: "",
						className: "tc-members-avatar tc-members-avatar-img",
					});
				}
				if (avatar !== undefined && typeof avatar.value === "string" && avatar.value !== "") {
					return react.createElement("span", { className: "tc-members-avatar" }, avatar.value);
				}
				const initial = String(row.displayName !== "" ? row.displayName : row.key).trim().slice(0, 1) || "?";
				return react.createElement("span", { className: "tc-members-avatar" }, initial);
			};
			
			return react.createElement(
				"div",
				{ className: "tc-root" },
				// 成员栏：让用户一眼看到「这个房间里都有谁」，
				// 而不是只有有人发过消息才知道有谁在。
				roomMembers.length === 0
					? null
					: react.createElement(
						"div",
						{ className: "tc-members" },
						...roomMembers.map((row) =>
							react.createElement(
								"span",
								{
									// ⚠ 键用 `row.key`（= 成员名）：`rosterOf` 的输出里
									// **没有 `name` 字段**，写成 `row.name` 会全是 undefined。
									key: row.key,
									className: "tc-member-chip",
									title: row.duty === "" ? String(row.displayName) : row.duty,
								},
								avatarNode(row),
								react.createElement("span", { className: "tc-member-chip-name" }, String(row.displayName)),
								row.isLead === true
									? react.createElement("span", { className: "tc-tag tc-tag-lead" }, t("members.leadBadge"))
									: null,
								// 成员会话是普通会话，可能被回收 —— 状态如实标出来。
								row.running === true
									? null
									: react.createElement("span", { className: "tc-member-chip-off" }, t("members.offline")),
							),
						),
					),
				!connected
					? react.createElement("div", { className: "tc-banner" }, t("panel.disconnected"))
					: null,
				view?.failure !== undefined
					? react.createElement("div", { className: "tc-banner tc-banner-warn" }, t("panel.failure"))
					: null,
				entries.length === 0
					? react.createElement("div", { className: "tc-empty" }, t("panel.empty"))
					: react.createElement(
							"div",
							{ className: "tc-list", ref: scrollRef },
							...entries.map((entry, index) =>
								react.createElement(
									react.Fragment,
									{ key: entry.id },
									dayRowIfNeeded(entries, index, t),
									react.createElement(Bubble, {
										entry,
										t,
										members,
										duties,
										// 连续同一个人的消息合并：不重复头像与名字。
										grouped: isSameSpeaker(entries[index - 1], entry),
										// 默认折叠：`expandedIds` 里没有它 ⇒ false ⇒ 只渲染头部一行。
										expanded: expandedIds.has(entry.id),
										onToggle: () => toggleEntry(entry.id),
									}),
								),
							),
						),
			);
		}

		/**
		 * 从 `uiWorkspace.selection` 的快照算出主面板要用的两个 id。
		 *
		 * 快照形状（`dsh-client-ui-workspace/lib/client.js:761` 建 store、
		 * `:982` 写入）：`{sessionId, subagentAddress?: {parentSessionId, …}}`，
		 * 持久化在 `dsh.sessions.current`。
		 *
		 * lead 解析与 `useTeamContext` 同规则（父会话优先）：主区当前会话是
		 * 别人的子智能体时，名单要拉它所在团队的，不是它自己的。
		 */
		function resolvePanelSession(snapshot) {
			const sessionId =
				typeof snapshot?.sessionId === "string" && snapshot.sessionId !== ""
					? snapshot.sessionId
					: undefined;
			if (sessionId === undefined) return { sessionId: undefined, leadSessionId: undefined };
			const parent = snapshot?.subagentAddress?.parentSessionId;
			return {
				sessionId,
				leadSessionId: typeof parent === "string" && parent !== "" ? parent : sessionId,
			};
		}

		/**
		 * 左侧栏「聊天室」主面板（`main` 槽条目）。
		 *
		 * root 作用域 ⇒ 标准 props 里**没有** `sessionId` / `useSession`，只有
		 * `useSessions` 这类全局 hook（`dsh-client-ui-renderer/lib/client.js:659-681`，
		 * root 分支只给根绑定的那一份）。房间归属跟着「主区当前会话」走，
		 * 数据来自 `ctx.uiWorkspace.selection`（注入的 `currentSession` 是它的最小面）。
		 *
		 * 注意「面板开着期间 selection 不会变」：在侧边栏点别的会话会
		 * `selectPanel(null)` 退回对话（`dsh-client-ui-workspace/lib/client.js:994`），
		 * 所以订阅主要是兜「会话被归档 → 选择被清空」这种外部变化。
		 */
		function TeamChatRoomPanel({ t, useSessions, currentSession }) {
			const [sel, setSel] = react.useState(() => resolvePanelSession(currentSession?.getSnapshot?.()));
			react.useEffect(() => {
				if (typeof currentSession?.subscribe !== "function") return undefined;
				// 先对齐一次真实值（订阅前那一帧可能漏通知 —— `useChatRoomActive`
				// 注释里记过同款事故），再按通知走。
				setSel(resolvePanelSession(currentSession.getSnapshot()));
				return currentSession.subscribe(() => {
					setSel(resolvePanelSession(currentSession.getSnapshot()));
				});
			}, [currentSession]);

			if (sel.sessionId === undefined) {
				return react.createElement(
					"div",
					{ className: "tc-root" },
					react.createElement("div", { className: "tc-empty" }, t("panel.noSession")),
				);
			}
			return react.createElement(TeamChatRoom, {
				sessionId: sel.sessionId,
				leadSessionId: sel.leadSessionId,
				t,
				useSessions,
			});
		}

		/**
		 * 左侧栏面板行的图标（`sidebar.panellist` 条目组件）。
		 *
		 * 官方行会传 `{size, active}`（`dsh-client-ui-sidebar/lib/client.js:191`），
		 * 激活态由行的 CSS 改颜色，所以图形全部用 `currentColor`，自己不处理 active。
		 */
		function TeamChatPanelIcon({ size = 18 }) {
			return react.createElement(
				"svg",
				{ width: size, height: size, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
				react.createElement("path", {
					d: "M2.5 4A1.5 1.5 0 0 1 4 2.5h12A1.5 1.5 0 0 1 17.5 4v8A1.5 1.5 0 0 1 16 13.5H9.2L5 16.9v-3.4H4A1.5 1.5 0 0 1 2.5 12V4Z",
					stroke: "currentColor",
					strokeWidth: 1.3,
					strokeLinejoin: "round",
				}),
				react.createElement("circle", { cx: 6.5, cy: 8, r: 1.05, fill: "currentColor" }),
				react.createElement("circle", { cx: 10, cy: 8, r: 1.05, fill: "currentColor" }),
				react.createElement("circle", { cx: 13.5, cy: 8, r: 1.05, fill: "currentColor" }),
			);
		}

		/**
		 * 两条消息是不是「同一个人、连着说的」。
		 *
		 * 用来把连续消息合并成一坨（聊天软件的通用做法）：只在第一条上画头像与名字。
		 * 间隔超过 5 分钟就当成新的一坨 —— 隔太久还合并会分不清哪句是哪轮说的。
		 *
		 * @param previous - 上一条（可能 undefined）。
		 * @param current - 当前条。
		 * @returns 是否合并。
		 */
		function isSameSpeaker(previous, current) {
			if (previous === undefined || previous === null) return false;
			if (previous.senderName !== current.senderName) return false;
			const before = Date.parse(previous.at ?? "");
			const now = Date.parse(current.at ?? "");
			if (Number.isNaN(before) || Number.isNaN(now)) return true;
			return now - before < 5 * 60 * 1000;
		}

		/**
		 * 需要时插一条日期分隔。
		 *
		 * 只在「第一条」或「跨天」时插 —— 每条都带时间戳是噪音，
		 * 而完全不给时间又没法对上下文。
		 *
		 * @param entries - 全部条目。
		 * @param index - 当前下标。
		 * @param t - 翻译函数。
		 * @returns 分隔元素或 null。
		 */
		function dayRowIfNeeded(entries, index, t) {
			const current = entries[index];
			const previous = entries[index - 1];
			const day = (entry) => {
				const at = Date.parse(entry?.at ?? "");
				return Number.isNaN(at) ? null : new Date(at).toDateString();
			};
			if (previous !== undefined && day(previous) === day(current)) return null;
			const at = Date.parse(current?.at ?? "");
			if (Number.isNaN(at)) return null;
			const date = new Date(at);
			const label =
				date.toDateString() === new Date().toDateString()
					? t("chat.today")
					: `${date.getMonth() + 1}/${date.getDate()}`;
			return react.createElement(
				"div",
				{ className: "tc-chat-day", role: "separator" },
				label,
			);
		}

		/**
		 * 折叠集合的切换（纯函数）。
		 *
		 * 为什么单独抽出来并导出：真实点击要 React 渲染器 + DOM 才跑得起来，
		 * 而这个插件所在的 profile 里**没有 react-dom 也没有 jsdom**
		 * （`<安装根>\resources\app\node_modules` 里只有 react）——
		 * 把「点一下发生什么」抽成纯函数，就能在没有 DOM 的情况下**真的跑一遍**
		 * 「点开 → 集合里有它 → 再点 → 集合里没有它」，而不是只在报告里写「应该能收起」。
		 *
		 * @param current - 当前的展开集合。
		 * @param id - 要切换的条目 id。
		 * @returns 新集合（不改原集合 —— React 凭引用变化重渲染）。
		 */
		function toggledIds(current, id) {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		}

		/**
		 * 一条聊天气泡。
		 *
		 * 用户明确提的需求：「要实现类似于聊天室的界面」——
		 * 所以这里不是「一行行罗列」，而是：
		 * - **我说的**靠右、品牌色实底、不画头像（那是聊天软件里自己的样子），
		 *   并在气泡下面标「发给了谁 + 什么状态」；
		 * - **别人说的**靠左、头像 + 显示名 + 职责，气泡用层级底色；
		 * - 同一个人连着说的合并成一坨，只有头一条画头像与名字。
		 *
		 * ## 折叠（2026-10-09 追加）
		 *
		 * 长消息默认只显示**头部标题一行** + 一行规模提示，点一下才展开正文：
		 * - **折叠态绝不把正文送进 Markdown 解析器**（这是它的全部意义）；
		 * - **头部永远露着**（AI 成员的长报告都是「一行加粗标题 + 一大段解释」，
		 *   读者一眼要的就是那行标题）；
		 * - 短消息不折（`mdCollapsibleOf` 判），别让用户读一句话还要点一下。
		 *
		 * @param props.entry - 时间线条目。
		 * @param props.t - 翻译函数。
		 * @param props.members - 成员资料表（`{key: profile}`）。
		 * @param props.duties - 官方投影里的职责兜底。
		 * @param props.grouped - 是否与上一条合并（不给头像与名字）。
		 * @param props.expanded - 是否展开。**只有房间列表会给它**
		 *   （`TeamChatRoom` 的 `expandedIds`）；省略时按「展开」渲染 ——
		 *   导出契约与既有构造测试都按这个缺省值写的，缺省值不动。
		 * @param props.onToggle - 折叠开关；不给就只有展示、没有交互。
		 * @returns 气泡元素。
		 */
		function Bubble({ entry, t, members, duties, grouped, expanded, onToggle }) {
			// 「我」= `lead`（宿主记自己那条用的就是它）。这一位必须在**最前面**判断：
			// 资料表里也可能有 `lead` 那一条（设置页里改的就是它）。
			const mine = entry.senderName === SPEAKER_KEY;
			const profile = members[entry.senderName];
			const label = mine
				? (members[SPEAKER_KEY]?.displayName ?? t("members.me"))
				: (profile?.displayName ?? entry.senderName);
			const duty = mine
				? ""
				: profile?.duty
					? profile.duty
					: (duties?.[entry.senderName] ?? "");

			// 发给了谁：新条目用 `targetNames`（可能多个），老条目只有 `targetName`。
			const targets = Array.isArray(entry.targetNames)
				? entry.targetNames
				: entry.targetName === null || entry.targetName === undefined
					? []
					: [entry.targetName];
			const targetLabel = targets.map((key) => members[key]?.displayName ?? key).join("、");

			const at = Date.parse(entry.at ?? "");
			const time = Number.isNaN(at)
				? ""
				: new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

			// ── 折叠：头部永远是这一行；正文只在展开时才进解析器 ──────────
			const info = mdCollapsibleOf(entry, t);
			// 开关由调用方给；不给（例如测试或别的用途直接调 `Bubble`）就没有交互。
			const toggle = typeof onToggle === "function" ? onToggle : null;
			// 「展开」= 用户点开了 **或** 这条短到不值得折。
			// `expanded` 省略时按**展开**处理：导出契约与既有 50 项构造测试都按
			// 缺省调用写的，缺省值不动（房间列表永远显式传布尔值）。
			const open = expanded === undefined ? true : expanded === true;
			const folded = info.collapsible && !open;

			/** 点气泡 = 折 / 展；但别抢走链接点击与文字选择。 */
			const onBubbleClick = (event) => {
				if (toggle === null) return;
				const selection = typeof window === "undefined" ? null : window.getSelection?.();
				if (selection !== null && selection !== undefined && String(selection) !== "") return;
				const target = event?.target;
				if (target !== null && target !== undefined && typeof target.closest === "function" && target.closest("a") !== null) {
					return;
				}
				toggle();
			};
			const onBubbleKey = (event) => {
				if (toggle === null) return;
				if (event?.key !== "Enter" && event?.key !== " ") return;
				event.preventDefault?.();
				toggle();
			};

			/**
			 * 气泡正文 —— **折叠态与展开态必须互斥求值**。
			 *
			 * ⚠ 这里踩过一次坑（本改动第一版）：把两支都先算出来再选，等于折叠态
			 *   照样把整条正文送进了解析器 —— 折叠就只剩「把 DOM 藏起来」，
			 *   完全挡不住 P0 那类失控。实测「全折叠 40 条」仍会有几十次解析、
			 *   正文全被解析一遍。所以正文那支**只能在 `folded === false` 时才求值**。
			 *
			 * 折叠态：**头部一行**（AI 走 Markdown 保住加粗观感，人走纯文本）
			 * + 一行规模提示（共 N 行 · M 字 · 点击展开）。
			 */
			const headText = info.head.text;
			const body = folded
				? [
						mine
							? react.createElement("span", { className: "tc-bubble-text", key: "h" }, `${headText}…`)
							: react.createElement(
									react.Fragment,
									{ key: "h" },
									// 空头部不值得开一次解析。
									headText === "" ? null : renderMarkdownBody(headText),
									react.createElement("span", { className: "tc-bubble-ellipsis" }, "…"),
								),
						react.createElement(
							"span",
							{ className: "tc-bubble-size", key: "s" },
							t("chat.collapsedHint", { lines: info.lines, chars: info.chars }),
						),
					]
				: // 展开态：整条走 Markdown（AI）/ 纯文本（人）。渲染器自带硬上限。
					mine
					? react.createElement("span", { className: "tc-bubble-text" }, blocksToText(entry.blocks, t))
					: renderMarkdownBody(blocksToText(entry.blocks, t));

			return react.createElement(
				"div",
				{
					className: grouped ? "tc-bubble-row tc-bubble-row-grouped" : "tc-bubble-row",
					"data-mine": String(mine),
					"data-sender": entry.senderName,
				},
				// 头像：两边都画（用户要求「我的消息右边也要有头像和名字」），
				// 只有「同一人连续说」时才省掉，那才是聊天室该有的密度。
				// 整行是 `row-reverse`，所以自己那侧的头像落在**右边**。
				grouped
					? react.createElement("span", { className: "tc-bubble-gutter", "aria-hidden": "true" })
					: react.createElement(
							"span",
							{ className: "tc-bubble-avatar" },
							react.createElement(Avatar, {
								memberKey: entry.senderName,
								profile,
								size: 28,
								// 自己那侧资料表里常常没有 `lead` 那一条，
								// 不给兜底就会画出一个孤零零的「L」。
								fallbackLabel: label,
							}),
						),
				react.createElement(
					"div",
					{ className: "tc-bubble-col" },
					grouped
						? null
						: react.createElement(
								"div",
								{ className: "tc-bubble-name" },
								label,
								duty === "" ? null : react.createElement("span", { className: "tc-bubble-duty" }, duty),
							),
					react.createElement(
						"div",
						{
							className: folded ? "tc-bubble tc-bubble-collapsed" : "tc-bubble",
							// 折叠时整个气泡就是那个开关（点一下展开）；展开后点回去也能收。
							role: toggle === null ? undefined : "button",
							tabIndex: toggle === null ? undefined : 0,
							"aria-expanded": toggle === null ? undefined : open,
							title: toggle === null ? undefined : folded ? t("chat.expand") : t("chat.collapse"),
							onClick: toggle === null ? undefined : onBubbleClick,
							onKeyDown: toggle === null ? undefined : onBubbleKey,
						},
						// ══ Markdown 已接回（2026-10-09 深夜）══════════════════════
						//
						// 2026-10-09 白天这条线被临时摘掉过：接上 `renderMarkdownBody`
						// 会让渲染进程 OOM（`renderer process gone (reason: oom)`）、
						// 自动恢复 3 次后 exhausted ⇒ 界面卡死黑屏。
						//
						// 根因（已复现、已修）：`mdList` 把**列号**当**行号**用
						// （`endLine = markerEnd`），40 条真实消息里有 3 条会让它
						// 无限 push；最小复现是 5 个字符。
						//
						// 接回的前置条件都跑过了（真实数据全量 + 最小片段 + 构造测试
						// + 上限触发，输出见交付报告），并且另加两道结构性防线：
						// 1. 长消息默认折叠 —— 正文根本不进解析器，进房间的工作量是常数级；
						// 2. 解析器自带硬上限（`MD_LIMITS`）—— 越界就退回纯文本并上报。
						body,
					),
					react.createElement(
						"div",
						{ className: "tc-bubble-tail" },
						time === "" ? null : react.createElement("span", { className: "tc-bubble-time" }, time),
						// 自己的消息才需要「发给了谁 / 送到没有」——别人的消息没这回事。
						// ⚠ 收件人**不再只显示在「我说的」那一侧**：AI 成员现在也能
						// 点名发给别人（`chatroom_send`），那条气泡也要看得出「发给谁」，
						// 否则用户看到一条没头没尾的消息，不知道是谁在跟谁说话。
						targetLabel !== ""
							? react.createElement("span", { className: "tc-bubble-target" }, `→ ${targetLabel}`)
							: null,
						// ⚠ 这一支现在**只为存量条目**留着（2026-10-11 起）。
						//    宿主侧加了私聊闸门：没有投递范围的真人消息**根本不记进房间**，
						//    所以新条目不会再有「我说的 + 没有收件人」这种组合。
						//    但**已经写在 room-timeline.json 里的老条目不动**
						//    （用户要的是「不显示私聊」，不是「删历史」），
						//    它们没有收件人、`delivered` 也是 false —— 少了这一支，
						//    那些气泡下面会变成光秃秃的「排队中」，语义反而更差。
						mine && targets.length === 0
							? react.createElement("span", { className: "tc-bubble-target" }, t("chat.noTarget"))
							: null,
						// 展开态给一个明确的「收起」入口（点气泡也能收，但那不够显眼）。
						// 只在调用方给了开关时才画 —— 缺省调用（测试）不受影响。
						toggle !== null && !folded && info.collapsible
							? react.createElement("span", { className: "tc-bubble-collapse" }, t("chat.collapse"))
							: null,
						// 投递状态只有「我」需要看（AI 有工具返回值，用户看的是这一行）。
						mine
							? react.createElement(
									"span",
									{ className: "tc-bubble-status", "data-delivered": String(entry.delivered === true) },
									entry.delivered === true ? t("status.delivered") : t("status.queued"),
								)
							: null,
					),
				),
			);
		}
		/**
		 * 把宿主给的成员行整理成可渲染的名单。
		 *
		 * ## 唯一数据源是宿主
		 *
		 * 成员改版后（2026-09-27）是**独立的顶层会话**，官方 agentTeam 投影里
		 * **根本没有它们** —— 所以名单、显示名、职责、头像、会话 id 一律问宿主要
		 * （`/__teamchat/team-members?sessionId=`）。
		 *
		 * 去重键用**成员名**：它是本地资料表的键，也是宿主投递时的目标标识。
		 * 用会话 id 之类的东西当键，同一个人会在名单上占两行（踩过）。
		 *
		 * @param rows - 宿主返回的 `members`。
		 * @returns `[{key, label, displayName, duty, avatar, sessionId, running, isLead}]`，按名字排。
		 */
		function rosterOf(rows) {
			const seen = new Set();
			const out = [];
			for (const row of Array.isArray(rows) ? rows : []) {
				const name = typeof row?.name === "string" ? row.name.trim() : "";
				// `lead` 是发言人自己，由调用方单独排在最前面，不混进成员里。
				if (name === "" || name === SPEAKER_KEY || seen.has(name)) continue;
				seen.add(name);
				const displayName = typeof row?.displayName === "string" ? row.displayName.trim() : "";
				out.push({
					key: name,
					label: name,
					// 没配显示名就用成员名 —— 界面上永远不要出现空白行。
					displayName: displayName !== "" ? displayName : name,
					duty: typeof row?.duty === "string" ? row.duty : "",
					avatar: row?.avatar ?? undefined,
					sessionId: typeof row?.sessionId === "string" ? row.sessionId : "",
					// 成员会话是普通会话，可能被回收；不在跑时仍列出，但界面上要能看出来。
					running: row?.running === true,
					// 主智能体 —— 界面上挂「指挥」角标，也是「发送到团队」默认的收件人。
					isLead: row?.isLead === true,
				});
			}
			// 主智能体排最前：它是团队的入口，名单里排第一符合直觉。
			// 同组内按名字排，保证顺序稳定（不会因为重渲染跳来跳去）。
			return out.sort(
				(a, b) => (b.isLead === true ? 1 : 0) - (a.isLead === true ? 1 : 0) || a.key.localeCompare(b.key),
			);
		}

		/**
		 * 解析一个成员最终该显示什么。
		 *
		 * 优先级：本地覆写 → 官方字段 → 原始 key。
		 * 会话侧（聊天室气泡 `Bubble`）和菜单侧共用这一份逻辑，避免两处显示不一致。
		 *
		 * @param key - 成员 key。
		 * @param label - 官方/兜底名字。
		 * @param profile - 本地覆写资料。
		 * @param description - 官方职责描述。
		 * @param fallbackAvatar - 官方 member 自带的头像。
		 * @returns `{name, duty, avatar}`。
		 */
		function resolveMember(key, label, profile, description, fallbackAvatar) {
			return {
				name: profile?.displayName ?? label ?? key,
				// duty 是空串时视为「没覆写」，回退官方描述。
				duty: profile?.duty ? profile.duty : (description ?? ""),
				avatar: profile?.avatar ?? fallbackAvatar ?? undefined,
			};
		}

		/**
		 * 成员会话当前的运行状态标签。
		 *
		 * **正常（在跑）返回 null** —— 不给正常状态挂标签，那是噪音。
		 * 只有「没在跑」值得说：成员会话是普通会话，空闲久了会被回收，
		 * 用户看到「未在运行」才不会以为它坏了（发消息时会自动叫醒）。
		 *
		 * @param t - 翻译函数。
		 * @param item - 名单行。
		 * @returns 文案或 null。
		 */
		function memberStateLabel(t, item) {
			if (item?.isLead === true) return null;
			if (item?.running === true) return null;
			return t("members.stateIdle");
		}

		/**
		 * 头像取值：本地覆写优先，其次官方 member 里可能带的头像字段。
		 *
		 * @param member - 官方 member 行。
		 * @returns 头像对象或 undefined。
		 */
		function avatarOf(member) {
			const avatar = member?.avatar;
			if (avatar !== null && typeof avatar === "object" && typeof avatar.value === "string") {
				return avatar;
			}
			return undefined;
		}

		// ── 头像文件的大小限制 ────────────────────────────────────
		//
		// **不做压缩**：超过 1 MiB 直接在选文件那一步拒掉，让用户换一张。
		//
		// 为什么不做压缩（曾经实现过一版 canvas 重编码，已撤）：
		// - 压缩本身要解码 + 重绘 + 多次编码，1 MB 级图片在低端机上有明显卡顿；
		// - 压完的体积不可控（噪声图六档 quality 都压不进 1 MiB），
		//   仍要写一套「压不动怎么办」的兜底，复杂度翻倍；
		// - 头像显示尺寸只有 20~30 px，本来就不该用大图 ——
		//   直接拒掉比「悄悄把图压糊」更符合预期。
		//
		// 限制的**两道闸**（客户端 + 宿主）必须一致：
		// - 客户端：这里，拦在 `FileReader` 之前，文件根本没读进内存。
		// - 宿主：`member-store.js` 的 `MAX_AVATAR_VALUE` / `MAX_MEMBER_BYTES`。

		/** 头像原图上限：1 MiB。与宿主 `member-store.js` 的常量对齐，别只改一边。 */
		const AVATAR_MAX_BYTES = 1024 * 1024;

		/** 允许的图片类型。 */
		const AVATAR_INPUT_TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp)$/u;

		/**
		 * 人类可读的字节数，用于提示文案。
		 *
		 * @param bytes - 字节数。
		 * @returns 如 `512.0 KB` / `1.25 MB`。
		 */
		const formatBytes = (bytes) => {
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
			return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
		};


		/**
		 * 交接说明五个分段的**界面标题**。
		 *
		 * 键名与宿主侧 `member-store.js` 的 `HANDOVER_SECTIONS` 一一对应 ——
		 * 那边存什么键，这边就取什么键。改一边必须改另一边。
		 */
		const HANDOVER_SECTION_LABELS = [
			["done", "members.handover.done"],
			["now", "members.handover.now"],
			["todo", "members.handover.todo"],
			["pitfalls", "members.handover.pitfalls"],
			["anchors", "members.handover.anchors"],
		];

		/**
		 * 「交替」结果的那一段话。
		 *
		 * 这个函数存在的唯一理由是**如实**：
		 * - 成功 → 说出新会话 id、旧会话去哪了；
		 * - 交接说明是**谁**写的 → `member`（它自己）/ `llm`（退路提炼）/ `none`（没写出来），
		 *   后两种必须显式警告。用户明确要求过：走了退路就得说清楚，
		 *   不许含糊成「他自己写的」；
		 * - 失败 → 原文照贴宿主的 `error`，不转述、不美化。
		 *
		 * ⚠ 「原文照贴」与「本地化」不矛盾，这里**两条都给**：宿主返回的是
		 *   「稳定错误码 + 英文兜底」，所以先按码查字典说人话，把原文当补充 ——
		 *   有码时文案 = `码的本地化文案 + 原文`。这样中文界面不再是英文，而
		 *   英文界面拿到的还是英文原文（不会退回中文）。原文一个字都不丢。
		 *
		 * @param props.result - `{kind: "ok"|"error", result?, error?}`。
		 * @param props.t - 翻译函数。
		 * @returns 子节点数组（直接摊进 createElement）。
		 */
		function successionResultNodes({ result, t }) {
			if (result === null || result === undefined) return [];

			if (result.kind === "error") {
				const error = result.error;
				const raw = error?.message !== undefined && error?.message !== null ? String(error.message) : "";
				// ① 优先按宿主错误码查字典（`succession.js` 与 `/succession` 路由
				//    都返回 `code` + `error`）；② 查不到就用原文；③ 都没有就空串。
				const localized = errorText(t, error?.hostCode, error?.hostParams, raw) ?? "";
				// 原文与本地化文案**不同**时才附带原文（相同就说明字典没命中，
				// 那 append 一次等于印两遍同一句话）。
				const detail = localized !== "" && raw !== "" && raw !== localized ? ` ${raw}` : "";
				return [
					react.createElement(
						"div",
						{ className: "tc-setting-msg", "data-kind": "error", role: "alert" },
						`${t("members.successionFailed")}：${localized}${detail}`,
					),
				];
			}

			const payload = result.result ?? {};
			const nodes = [
				react.createElement(
					"div",
					{ className: "tc-setting-msg", "data-kind": "ok", role: "status" },
					t("members.successionDone", { session: payload.sessionId ?? "?" }),
				),
				react.createElement(
					"div",
					{ className: "tc-succession-note" },
					payload.archived === true
						? t("members.successionArchived", { old: payload.previousSessionId ?? "?" })
						: t("members.successionKept", { old: payload.previousSessionId ?? "?" }),
				),
			];

			// ── 交接说明的来源：这一条绝不能含糊 ──────────────────
			const note = payload.handover ?? {};
			const chars = Number.isFinite(note.chars) ? note.chars : 0;
			if (note.ok !== true || note.source === "none") {
				nodes.push(
					react.createElement(
						"div",
						{ className: "tc-succession-warn" },
						t("members.successionNoteEmpty"),
					),
				);
			} else if (note.source === "llm") {
				nodes.push(
					react.createElement(
						"div",
						{ className: "tc-succession-warn" },
						t("members.successionNoteByLlm", { chars }),
					),
				);
			} else {
				nodes.push(
					react.createElement(
						"div",
						{ className: "tc-succession-note" },
						t("members.successionNoteByMember", { chars }) +
							(note.truncated === true ? t("members.successionNoteTruncated") : ""),
					),
				);
			}

			// 开场消息没投进去 = 新会话上岗时**没拿到**这份说明。
			// 交替本身成立（身份已经交接），所以要如实说清补救办法。
			if (payload.steered !== true) {
				nodes.push(
					react.createElement(
						"div",
						{ className: "tc-succession-warn" },
						t("members.successionHintSteerFailed"),
					),
				);
			}
			return nodes;
		}

		/**
		 * 当前交接说明的一瞥（可展开看全文）。
		 *
		 * 为什么放在成员编辑器里：用户想验证「交接到底写成什么样了」时，
		 * 最自然的落点就是他刚才点「交替」的那个地方。全文一般不短，
		 * 所以默认折叠、点一下展开 —— 与聊天室里长消息的处理方式一致。
		 *
		 * @param props.profile - 成员资料（来自 `/__teamchat/members`）。
		 * @param props.t - 翻译函数。
		 */
		function HandoverPreview({ profile, t }) {
			const [open, setOpen] = react.useState(false);
			const note = profile?.handover ?? null;
			if (note === null || typeof note !== "object") {
				return react.createElement(
					"div",
					{ className: "tc-editor-note" },
					t("members.successionNoteEmptyPanel"),
				);
			}

			const sections =
				note.sections !== null && typeof note.sections === "object" && note.sections !== undefined
					? note.sections
					: null;
			const archivedCount = Array.isArray(profile?.archivedSessions) ? profile.archivedSessions.length : 0;
			const sourceKey =
				note.source === "llm"
					? "members.successionNoteByLlm"
					: note.source === "member"
						? "members.successionNoteByMember"
						: "members.successionNoteEmpty";

			return react.createElement(
				"div",
				{ className: "tc-succession-choice" },
				react.createElement(
					"button",
					{
						type: "button",
						className: "tc-succession-opt",
						// 「当前」态标记复用同一个 data-active 样式（感叹号那套只给
						// 两个互斥选项用，这里单纯是视觉一致）。
						"data-active": true,
						onClick: () => setOpen((value) => !value),
					},
					`${t("members.successionNotePanel")}`,
				),
				react.createElement(
					"span",
					{ className: "tc-succession-note" },
					// ⚠ 来源如实显示：`llm` 那条文案自带警告前缀。
					`${t(sourceKey, { chars: typeof note.text === "string" ? note.text.length : 0 })}` +
						(archivedCount > 0 ? ` · ${t("members.successionArchivedCount", { count: archivedCount })}` : ""),
				),
				open
					? react.createElement(
							"div",
							{ className: "tc-handover" },
							sections === null
								? react.createElement(
										"div",
										{ className: "tc-handover-body" },
										typeof note.text === "string" ? note.text : "",
									)
								: HANDOVER_SECTION_LABELS.map(([key, labelKey]) =>
										typeof sections[key] === "string" && sections[key] !== ""
											? react.createElement(
													"div",
													{ className: "tc-handover-row", key },
													react.createElement("span", { className: "tc-handover-key" }, t(labelKey)),
													react.createElement("span", { className: "tc-handover-val" }, sections[key]),
												)
											: null,
									),
						)
					: null,
			);
		}

		/**
		 * 单个成员的资料编辑表单。
		 *
		 * 四项可编辑：显示名、职责、头像（emoji / 文字 / 图片）、以及
		 * **主智能体身份**（只在有房间上下文的宿主里显示，见 `leadTaken`）。
		 * 另有一块**交替（交接）**—— 换掉这个成员的会话并把身份交下去，
		 * 门控与主智能体开关同一套（见下方那段注释）。
		 *
		 * **合并语义**：留空的字段不写回，所以「只改职责」不会把头像抹掉 ——
		 * 与宿主侧 `MemberStore.set()` 的 `{...旧, ...新}` 一致。
		 * 唯一例外是头像：切换形态或点「清除图片」时会显式发 `avatar: null`。
		 *
		 * @param props.leadTaken - **房里的主智能体是谁**（`null` = 还没有）。
		 *   `undefined` = 这个宿主**没有房间上下文**（设置页那块只读本地资料，
		 *   不依赖会话）：此时不显示这个开关，也**不提交** `isLead` 字段 ——
		 *   一次「只改职责」的保存绝不能顺手碰身份位。
		 *   **「交替」按钮用同一个判据**：没有房间上下文就没有可交替的成员。
		 */
		function MemberEditor({ memberKey, label, description, profile, t, onDone, speaker = false, leadTaken }) {
			// 「我（发言人）」形态：只改**显示名 + 头像**。
			// 职责 / 专属指令 / 删除资料都是「AI 成员」的概念，对发言人没有意义
			// （专属指令是给成员的会话当开场消息用的），显示出来只会让人困惑。
			const isSpeaker = speaker === true;

			const [name, setName] = react.useState(profile?.displayName ?? "");
			const [duty, setDuty] = react.useState(profile?.duty ?? "");
			// 成员「专属指令」—— 创建 teammate 时会作为首条消息的第三段。
			// 它是**创建期配置**：改了已存在的成员需要重建才生效。
			const [instructions, setInstructions] = react.useState(profile?.instructions ?? "");
			// 头像形态：emoji / text / image；没有覆写时按 emoji 起步。
			const [kind, setKind] = react.useState(profile?.avatar?.kind ?? "emoji");
			const [emoji, setEmoji] = react.useState(
				profile?.avatar?.kind === "emoji" ? profile.avatar.value : "",
			);
			const [text, setText] = react.useState(
				profile?.avatar?.kind === "text" ? profile.avatar.value : "",
			);
			const [image, setImage] = react.useState(
				profile?.avatar?.kind === "image" ? profile.avatar.value : "",
			);
			// 「主智能体」开关 —— 与「添加 AI 成员」表单同一套语义（一个房间只有一个）。
			//
			// 初值取**已有资料里的真值**：开关是受控的，保存时会把当前值整体发出去
			// （宿主只在显式传布尔时才写 `isLead`），所以初值错了就会在「只改名字」
			// 的时候悄悄改掉身份 —— 这正是 `member-store` 那条注释在防的事。
			//
			// ⚠ `profileLoaded === false` = 挂载时资料还没到（名单和资料是两个请求，
			//   谁先回来不一定）。那种情况下这个表单的每个字段初值都是空的，而身份位
			//   **在界面上看不出来** —— 保存一次就等于悄悄把主智能体降级。
			//   所以资料没到时这个开关不显示、也**不提交**。
			const profileLoaded = profile !== undefined && profile !== null;
			const [isLead, setIsLead] = react.useState(profile?.isLead === true);
			// 这个成员**有没有自己的会话** —— 没有会话就没什么可交替的
			// （那种条目是设置页里预配的「资料」，还没有对应的 AI）。
			//
			// ⚠ 不用它做「能不能交替」的**唯一**门控：真正的门控是下面
			//   那个「有房间上下文」的条件（`leadTaken !== undefined`）。
			//   这里只是让按钮在明显没意义时不要出现。
			const hasSession = profileLoaded && typeof profile.sessionId === "string" && profile.sessionId !== "";
			const [busy, setBusy] = react.useState(false);
			const [message, setMessage] = react.useState(null);
			const fileRef = react.useRef(null);

			// ── 交替（succession）────────────────────────────────
			//
			// 三段式：常态 → 确认（说清会发生什么 + 选归档/保留）→ 执行中 → 结果。
			// 归档/保留的选择放在**确认段里**，理由：它是一个「实施细节」而不是
			// 一个独立功能 —— 用户点「交替」时脑子里只有「换个会话」，
			// 把选择摊在常态里会让人以为要先配好才能点。
			//
			// ⚠ 状态放在 `MemberEditor` 内部（不是成员资料上）：它是一次点击的
			//   过程状态，刷新页面就该复位，落库只会留垃圾。
			const [successionStage, setSuccessionStage] = react.useState("idle");
			/** 旧会话处置：true = 归档（默认），false = 保留。 */
			const [successionArchive, setSuccessionArchive] = react.useState(true);
			/** 交替回执（成功或失败），渲染成一段可读的结果。 */
			const [successionResult, setSuccessionResult] = react.useState(null);

			/**
			 * 真的去交替。
			 *
			 * 成功/失败都渲成一段话 —— 尤其**交接说明是谁写的**必须如实说：
			 * `member` = 它自己写的；`llm` = 退路提炼；`none` = 没写出来。
			 */
			const runSuccession = async () => {
				if (busy) return;
				setBusy(true);
				setSuccessionStage("running");
				setSuccessionResult(null);
				try {
					const result = await membersApi.succession(memberKey, { archive: successionArchive });
					setSuccessionStage("done");
					setSuccessionResult({ kind: "ok", result });
				} catch (error) {
					setSuccessionStage("done");
					setSuccessionResult({ kind: "error", error });
				} finally {
					setBusy(false);
				}
			};

			/** 当前形态对应的头像值，空串表示「不写头像」。 */
			const currentAvatarValue = () => {
				if (kind === "emoji") return emoji.trim();
				if (kind === "text") return text.trim();
				return image;
			};

			const commit = async () => {
				if (busy) return;
				setBusy(true);
				setMessage(null);
				try {
					const member = {};
					if (name.trim() !== "") member.displayName = name.trim();
					// ⚠ 发言人形态**不提交** duty / instructions ——
					// 这个表单里根本没有那两个输入框，它们的 state 还是初始值 ""，
					// 照原样提交会把已有内容**清空**。
					if (!isSpeaker) {
						// duty 空串是有意义的：表示清掉覆写、回退官方描述。
						member.duty = duty.trim();
						// instructions 同理：空串 = 清掉这条指令。
						member.instructions = instructions.trim();
					}

					const value = currentAvatarValue();
					if (kind === "image") {
						// 选过图就写进去；没选过就显式清空，避免留下上一个形态的残影。
						member.avatar = value === "" ? null : { kind: "image", value };
					} else if (value !== "") {
						member.avatar = { kind, value };
					} else {
						member.avatar = null;
					}

					// 主智能体身份：**只有**有房间上下文、且挂载时资料已经到的宿主才提交
					// 这个字段（编辑器里显示了开关 ⇒ 用户能看见自己改的是什么）。
					// 提交的永远是当前布尔值本身：关掉开关就是「取消主智能体」。
					// `leadTaken !== null` = 房里已经有别人当值 → 带 `replaceLead`
					// 显式告诉宿主「我知道要换人」（与新增表单同一套写法）。
					if (!isSpeaker && leadTaken !== undefined && profileLoaded) {
						member.isLead = isLead === true;
					}

					await membersApi.save(memberKey, member, {
						replaceLead:
							isLead === true && leadTaken !== null && leadTaken !== undefined && profileLoaded,
					});
					onDone(t("members.saved"));
				} catch (error) {
					// ⚠ 原来这里是 `${error?.message}` —— 成员库的中文串就这么
					//   印进了英文界面。现在按宿主码查字典（`saveFailureText`：
					//   「保存成员『x』」+「头像数据过大：3.20 MB > 1.5 MB」两段），
					//   并保留原文（两者不同才附上），**信息量一处不少**。
					setMessage({ kind: "error", text: saveFailureText(t, error) });
				} finally {
					setBusy(false);
				}
			};

			const reset = async () => {
				if (busy) return;
				setBusy(true);
				setMessage(null);
				try {
					await membersApi.remove(memberKey);
					onDone(t("members.deleted"));
				} catch (error) {
					// 与 `commit` 同一套：码 → 本地化文案，原文照贴（见 `saveFailureText`）。
					setMessage({ kind: "error", text: saveFailureText(t, error) });
				} finally {
					setBusy(false);
				}
			};

			/**
			 * 读图片文件成 data URL。
			 *
			 * **触发点：`FileReader` 之前** —— 先量 `file.size`，超限直接拒，
			 * 文件根本不读进内存。
			 *
			 * 处理链路：
			 * 1. **类型白名单**：非图片直接拒。
			 * 2. **量体积**：`> 1 MiB` → 拒绝 + 报出实际体积；`≤ 1 MiB` → 读取。
			 * 3. **读后复核**：data URL 的 base64 相对原字节膨胀约 1/3，
			 *    所以原图 1 MiB 时 data URL 约 1.33 MiB。这里按原图字节判定
			 *    （`file.size`），宿主侧按 data URL 长度判定，两边上限已对齐。
			 *
			 * 全程只读本地文件，不落盘、不上传 —— 存进 `members.json` 的是 data URL。
			 */
			const pickFile = (event) => {
				const file = event.target.files?.[0];
				// 允许重复选同一个文件。
				event.target.value = "";
				if (file === undefined || file === null) return;

				if (!AVATAR_INPUT_TYPES.test(file.type)) {
					setMessage({ kind: "error", text: t("members.avatarBadType") });
					return;
				}

				// ── 硬限制：超过 1 MiB 直接拒，不做任何处理 ──────────
				if (file.size > AVATAR_MAX_BYTES) {
					setImage("");
					setMessage({
						kind: "error",
						text: t("members.avatarTooLarge", { size: formatBytes(file.size) }),
					});
					return;
				}

				const reader = new FileReader();
				reader.onload = () => {
					const result = typeof reader.result === "string" ? reader.result : "";
					if (result === "") return;
					setImage(result);
					setMessage(null);
				};
				reader.onerror = () => setMessage({ kind: "error", text: t("members.avatarBadType") });
				reader.readAsDataURL(file);
			};


			// 表单里实时预览的头像（用当前未保存的输入）。
			const previewValue = currentAvatarValue();
			const preview =
				previewValue === ""
					? undefined
					: { kind, value: previewValue };

			/** 形态切换按钮。 */
			const kindButton = (id, labelKey) =>
				react.createElement(
					"button",
					{
						type: "button",
						className: "tc-avatar-kind",
						"data-active": kind === id,
						"aria-pressed": kind === id,
						onClick: () => setKind(id),
					},
					t(labelKey),
				);

			return react.createElement(
				"div",
				{ className: "tc-editor" },
				react.createElement(
					"div",
					{ className: "tc-editor-title" },
					t(isSpeaker ? "members.me.title" : "members.editTitle"),
				),
				react.createElement(
					"label",
					{ className: "tc-field" },
					react.createElement("span", { className: "tc-field-label" }, t("members.name")),
					react.createElement("input", {
						className: "tc-input",
						type: "text",
						value: name,
						maxLength: 32,
						placeholder: t("members.namePlaceholder"),
						onChange: (event) => setName(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") void commit();
						},
					}),
				),
				// 职责 —— 只在 AI 成员形态出现（发言人不谈"职责"）。
				isSpeaker
					? null
					: react.createElement(
							"label",
							{ className: "tc-field" },
							react.createElement("span", { className: "tc-field-label" }, t("members.duty")),
							react.createElement("input", {
								className: "tc-input",
								type: "text",
								value: duty,
								maxLength: 200,
								placeholder: description ?? t("members.dutyPlaceholder"),
								onChange: (event) => setDuty(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter") void commit();
								},
							}),
						),
				// 专属指令 / 技能 —— 成员会话的**开场消息**里那一段。
				// 用 textarea 而不是 input：这里是多行的规则/技能说明。
				// 发言人形态下不显示（指令是发给 AI 成员的，不是发给自己的）。
				isSpeaker
					? null
					: react.createElement(
							"label",
							{ className: "tc-field" },
							react.createElement("span", { className: "tc-field-label" }, t("members.instructions")),
							react.createElement("textarea", {
								className: "tc-input tc-textarea",
								rows: 4,
								value: instructions,
								maxLength: 4_000,
								placeholder: t("members.instructionsPlaceholder"),
								onChange: (event) => setInstructions(event.target.value),
							}),
							react.createElement(
								"span",
								{ className: "tc-field-hint" },
								t("members.instructionsHint"),
							),
						),
				react.createElement(
					"div",
					{ className: "tc-field" },
					react.createElement("span", { className: "tc-field-label" }, t("members.avatar")),
					react.createElement(
						"div",
						{ className: "tc-field-row" },
						react.createElement(Avatar, {
							memberKey,
							profile: { displayName: name || memberKey, avatar: preview },
							size: 28,
						}),
						react.createElement(
							"div",
							{ className: "tc-avatar-kinds" },
							kindButton("emoji", "members.avatarEmoji"),
							kindButton("text", "members.avatarText"),
							kindButton("image", "members.avatarImage"),
						),
					),
					kind === "emoji"
						? react.createElement("input", {
								className: "tc-input",
								type: "text",
								value: emoji,
								maxLength: 8,
								placeholder: t("members.avatarPlaceholder"),
								onChange: (event) => setEmoji(event.target.value),
							})
						: null,
					kind === "text"
						? react.createElement("input", {
								className: "tc-input",
								type: "text",
								value: text,
								maxLength: 8,
								placeholder: t("members.avatarTextPlaceholder"),
								onChange: (event) => setText(event.target.value),
							})
						: null,
					kind === "image"
						? react.createElement(
								"div",
								{ className: "tc-avatar-image-row" },
								react.createElement("input", {
									ref: fileRef,
									className: "tc-file",
									type: "file",
									accept: "image/png,image/jpeg,image/gif,image/webp,image/avif",
									onChange: pickFile,
								}),
								react.createElement(
									"button",
									{ type: "button", className: "tc-btn", onClick: () => fileRef.current?.click() },
									t("members.avatarUpload"),
								),
								image === ""
									? null
									: react.createElement(
											"button",
											{ type: "button", className: "tc-btn tc-btn-ghost", onClick: () => setImage("") },
											t("members.avatarClear"),
										),
								react.createElement("span", { className: "tc-editor-note" }, t("members.avatarHint")),
							)
						: null,
				),
				// ── 主智能体（团队协作语义）─────────────────────────
				//
				// 与「添加 AI 成员」表单**同一套控件、同一套文案、同一条宿主规矩**：
				// 一个聊天室只有一个主智能体。房里已经有别人当值时，这里照实说
				// 「打开开关会把它降为普通成员」，而不是等保存时报一个错。
				//
				// 只在**有房间上下文**、且资料已经到达的宿主里显示
				// （`leadTaken !== undefined` 见 `MemberEditor` 的注释）。
				// 设置页那块只读本地资料、不依赖会话，算不出「房里现在谁当值」，
				// 所以那里的编辑表单不带这个开关。
				!isSpeaker && leadTaken !== undefined && profileLoaded
					? react.createElement(
							"div",
							{ className: "tc-field" },
							react.createElement(
								"div",
								{ className: "tc-setting" },
								react.createElement(
									"div",
									{ className: "tc-setting-body" },
									react.createElement("div", { className: "tc-setting-title" }, t("members.isLead")),
									react.createElement(
										"div",
										{ className: "tc-setting-desc" },
										leadTaken === null
											? t("members.isLeadDesc")
											: t("members.isLeadTaken", { name: leadTaken.displayName }),
									),
								),
								react.createElement(TeamSwitch, {
									checked: isLead,
									label: t("members.isLead"),
									disabled: busy,
									onChange: setIsLead,
								}),
							),
						)
					: null,
				// ── 交替（交接 / succession）─────────────────────────
				//
				// **只在有房间上下文的宿主里显示**：这个模块要「换掉一个成员的会话」，
				// 而「成员」这个概念只在有房间的地方成立。判据与上面那个
				// 主智能体开关**完全一致**（`leadTaken !== undefined && profileLoaded`）：
				//   - 成员面板 `MembersPanel`      → 有房间，显示
				//   - 右栏成员页签 `MembersPane`   → 有房间，显示
				//   - 设置页 `MembersConfigRow`    → `leadTaken === undefined`，不显示
				//   - 「我（发言人）」`SpeakerProfileBlock` → 是发言人（isSpeaker），不显示
				//
				// ⚠ 「我（发言人）」那个宿主**不该有**这个按钮：发言人是这个聊天室的
				//   主人，不是可被交替的 AI 成员；而且它的 key 是 "lead"，
				//   在宿主侧根本查不到一条带 sessionId 的成员资料。
				//   两道门（!isSpeaker 与 leadTaken !== undefined）叠在一起守这件事。
				!isSpeaker && leadTaken !== undefined && profileLoaded
					? react.createElement(
							"div",
							{ className: "tc-field" },
							react.createElement("div", { className: "tc-setting-title" }, t("members.successionTitle")),
							react.createElement("div", { className: "tc-setting-desc" }, t("members.successionHint")),
							// ── 常态：一个按钮 ────────────────────────
							successionStage === "idle"
								? react.createElement(
										"div",
										{ className: "tc-editor-actions" },
										react.createElement(
											"button",
											{
												type: "button",
												className: "tc-btn",
												disabled: busy || !hasSession,
												title: hasSession ? undefined : t("members.successionNoSession"),
												onClick: () => {
													setSuccessionResult(null);
													setSuccessionStage("confirm");
												},
											},
											t("members.succession"),
										),
										react.createElement(
											"span",
											{ className: "tc-succession-note" },
											hasSession ? t("members.successionNote") : t("members.successionNoSession"),
										),
									)
								: null,
							// ── 确认：说清会发生什么 + 选旧会话怎么处置 ──
							successionStage === "confirm"
								? react.createElement(
										"div",
										{ className: "tc-setting-block" },
										react.createElement(
											"div",
											{ className: "tc-succession-warn" },
											t("members.successionArchive"),
										),
										react.createElement(
											"div",
											{ className: "tc-succession-choice" },
											react.createElement(
												"button",
												{
													type: "button",
													className: "tc-succession-opt",
													"data-active": successionArchive,
													onClick: () => setSuccessionArchive(true),
												},
												t("members.successionArchiveOpt"),
											),
											react.createElement(
												"button",
												{
													type: "button",
													className: "tc-succession-opt",
													"data-active": !successionArchive,
													onClick: () => setSuccessionArchive(false),
												},
												t("members.successionKeepOpt"),
											),
										),
										react.createElement(
											"div",
											{ className: "tc-succession-note" },
											successionArchive
												? t("members.successionArchiveDesc")
												: t("members.successionKeepDesc"),
										),
										react.createElement(
											"div",
											{ className: "tc-editor-actions" },
											react.createElement(
												"button",
												{
													type: "button",
													className: "tc-btn tc-btn-ghost",
													disabled: busy,
													onClick: () => setSuccessionStage("idle"),
												},
												t("members.successionCancel"),
											),
											react.createElement(
												"button",
												{
													type: "button",
													className: "tc-btn tc-btn-primary",
													disabled: busy,
													onClick: () => void runSuccession(),
												},
												t("members.successionConfirm"),
											),
										),
									)
								: null,
							// ── 执行中：明确告诉用户要等多久、别关页面 ──
							successionStage === "running"
								? react.createElement(
										"div",
										{ className: "tc-setting-block" },
										react.createElement(
											"div",
											{ className: "tc-setting-msg", "data-kind": "ok", role: "status" },
											t("members.successionBusy"),
										),
										react.createElement(
											"div",
											{ className: "tc-succession-note" },
											t("members.successionBusyHint"),
										),
									)
								: null,
							// ── 结果：成功要说清「新会话是谁、旧会话去哪了、
							//     交接说明是谁写的」；失败要给出原因原文 ──
							successionStage === "done" && successionResult !== null
								? react.createElement(
										"div",
										{ className: "tc-setting-block" },
										...successionResultNodes({
											result: successionResult,
											t,
										}),
									)
								: null,
							// ── 当前那份交接说明（有就露一眼，能展开看全文）──
							successionStage === "idle"
								? react.createElement(HandoverPreview, { profile, t })
								: null,
						)
					: null,
				react.createElement("div", { className: "tc-editor-note" }, t("members.storeNote")),
				message === null
					? null
					: react.createElement(
							"div",
							{ className: "tc-setting-msg", "data-kind": message.kind, role: "alert" },
							message.text,
						),
				react.createElement(
					"div",
					{ className: "tc-editor-actions" },
					// 「删除资料」对发言人没意义 —— 他是这个聊天室的主人，不是可移除的成员。
					isSpeaker
						? null
						: react.createElement(
								"button",
								{
									type: "button",
									className: "tc-btn tc-btn-danger",
									disabled: busy,
									title: t("members.deleteHint"),
									onClick: () => void reset(),
								},
								t("members.delete"),
							),
					react.createElement(
						"button",
						{ type: "button", className: "tc-btn tc-btn-ghost", disabled: busy, onClick: () => onDone(null) },
						t("members.cancel"),
					),
					react.createElement(
						"button",
						{ type: "button", className: "tc-btn tc-btn-primary", disabled: busy, onClick: () => void commit() },
						busy ? t("members.saving") : t("members.save"),
					),
				),
			);
		}

		/**
		 * 把宿主返回的官方错误码翻译成本地化文案。
		 *
		 * 官方错误码是稳定契约（`TeamError.code`），比匹配错误消息可靠。
		 *
		 * `error.code`（官方 Team 错误码）优先；拿不到就试 `error.hostCode`
		 * —— 那是宿主自己给的码（`TEAMCHAT_*`），见 `errorText()`。
		 *
		 * @param t - 翻译函数。
		 * @param error - 带 `code` 的 Error。
		 * @returns 展示用文案。
		 */
		function spawnErrorMessage(t, error) {
			// 有宿主码就走「码 → 字典」；没有才退回官方那套通用文案。
			const localized = () =>
				typeof error?.hostCode === "string" && error.hostCode !== ""
					? errorText(t, error.hostCode, error.hostParams)
					: null;
			switch (error?.code) {
				case "TEAM_UNAVAILABLE":
					return localized() ?? t("members.errUnavailable");
				case "TEAM_NO_LIVE_CALLER":
					return localized() ?? t("members.errNoLiveCaller");
				case "TEAM_LEAD_REQUIRED":
					return localized() ?? t("members.errLeadRequired");
				case "TEAM_MEMBER_NAME_TAKEN":
					return localized() ?? t("members.errNameTaken");
				case "TEAM_MEMBER_LIMIT":
					return localized() ?? t("members.errLimit");
				case "TEAM_INVALID_MEMBER_NAME":
				case "TEAM_MISSING_DESCRIPTION":
					return localized() ?? t("members.addNameInvalid");
				// 官方那边成员已登记，但我们**没能确认它对应的窗口真的起来了**。
				// 这正是「必须绑定真实窗口」这条需求的失败分支 —— 必须如实告诉
				// 用户，而不是当成创建成功。
				case "TEAM_WINDOW_NOT_CREATED":
					return localized() ?? t("members.errWindowNotCreated");
				// 这个聊天室已经有主智能体了，而请求里没带 `replaceLead`。
				// 正常流程不会走到（表单会自动带上），只有直接调 API 才会撞上。
				case "TEAM_LEAD_EXISTS":
					return localized() ?? t("members.errLeadExists");
				default:
					return localized() ?? t("members.addUnavailable");
			}
		}

		/**
		 * 把宿主给的**稳定错误码**翻成本地化文案。
		 *
		 * ## 为什么客户端要有这一层
		 *
		 * host 半**拿不到界面语言** —— `ctx.locale` 是客户端半的服务，桌面端的
		 * `readUiLocalePreference` 属于 app 自身、不是插件可见的 API。所以从
		 * 第三方插件里做不到「按宿主语言选文案」。
		 *
		 * 于是 host 侧一律返回「**稳定错误码 + 英文兜底**」两条：
		 *   - `code`（`TEAMCHAT_*`）：客户端拿它查**这里的**字典，中英各一套
		 *     ⇒ 中文用户看中文、英文用户看英文；
		 *   - `error`：英文兜底。老字段没删，`curl` / 日志 / 老客户端都要靠它。
		 *
		 * ## 回落顺序（一条都不能少）
		 *
		 *   1. 字典里有 `err.<code>` ⇒ 用它（并把 `params` 填进 `{占位符}`）；
		 *   2. 字典里没有（新宿主加了码、客户端还没跟上）⇒ 用 host 的英文原文；
		 *   3. 连码都没有（网络层错误 / 老宿主）⇒ 也走 2，仍然用原文；
		 *   4. 原文也没有 ⇒ null，交给调用方自己的通用兜底文案。
		 *
		 * ⚠ **绝不把码名本身印到界面上** —— `t()` 在字典缺项时返回的是 key
		 * 本身（不是空串 / null），直接用它就会显示 `err.TEAMCHAT_NO_ROOM`。
		 * 所以这里显式判 `=== key`。
		 *
		 * @param t - 翻译函数（`ctx.locale.bind(NS)`）。
		 * @param code - 宿主错误码，可空。
		 * @param params - 占位符取值，可空。
		 * @param raw - 宿主 `error` 原文（英文兜底），可空。
		 * @returns 展示用文案；什么可用的都没有时返回 null。
		 */
		function errorText(t, code, params, raw = null) {
			if (typeof code === "string" && code !== "") {
				const key = `err.${code}`;
				const text = t(key, params === null || params === undefined ? {} : params);
				if (typeof text === "string" && text !== "" && text !== key) return text;
			}
			return typeof raw === "string" && raw !== "" ? raw : null;
		}

		/**
		 * `errorText` 的**「本地化 + 原文」两段都要**版本。
		 *
		 * 存在的唯一理由：这几处的老代码写的是 `` `${t("members.saveFailed")}：${error?.message}` ``
		 * —— 中文串（`member-store.js` 的 `error`）就这么直接印进界面了。改成只印
		 * 本地化文案是**错的**：那会把原文里那些排障线索（异常类名、系统错误码）
		 * 一起抹掉。所以两条都给，**互不替代**：
		 *
		 *   1. 按宿主码查字典 → 本地化文案（中英各一套，`params` 已填进去）；
		 *   2. `error.message` 原文 —— 与 1 **不同**时才附上（相同说明字典没命中，
		 *      再印一遍等于同一句话出现两次）。
		 *
		 * 拿不到码时（网络层错误 / 老宿主）1 会回落成原文，于是 2 自然为空 ——
		 * 仍然是「原文照贴」，不丢信息。
		 *
		 * @param t - 翻译函数。
		 * @param error - 抛出来的 Error（带 `hostCode` / `hostParams`）。
		 * @param fallbackKey - 连原文都没有时的兜底文案键。
		 * @returns 展示用文案。
		 */
		function errorTextWithRaw(t, error, fallbackKey) {
			const raw =
				error?.message !== undefined && error?.message !== null ? String(error.message) : "";
			const localized = errorText(t, error?.hostCode, error?.hostParams, raw) ?? "";
			const detail = localized !== "" && raw !== "" && raw !== localized ? ` ${raw}` : "";
			return `${localized}${detail}` !== "" ? `${localized}${detail}` : t(fallbackKey);
		}

		/**
		 * 成员库（`lib/member-store.js`）那条**失败原因**文案。
		 *
		 * `/__teamchat/members` 失败时给两个码：`code`（路由级，说清「保存**谁**」）
		 * 与 `cause`（原因级，说清「**为什么**」）。上一轮只用了前者，于是
		 * 「头像数据过大（3.2 MB > 2.0 MB）」退化成「保存成员失败」——
		 * **干净了，但具体原因与数字全丢了**。所以这里把两段都取出来：
		 *
		 * @param t - 翻译函数。
		 * @param failure - 抛出来的 Error（`hostParams` = 路由级 params，
		 *   `causeCode` / `causeParams` = 原因级）。
		 * @returns 「对象：原因」两段拼好的文案；原因拿不到时只给对象那段。
		 */
		function saveFailureText(t, failure) {
			const who = errorText(t, failure?.hostCode, failure?.hostParams, null);
			const why =
				typeof failure?.causeCode === "string" && failure.causeCode !== ""
					? errorText(t, failure.causeCode, failure.causeParams, null)
					: null;
			if (who === null && why === null) return errorTextWithRaw(t, failure, "members.saveFailed");
			if (who === null) return why;
			if (why === null) return who;
			return `${who} ${why}`;
		}

		/**
		 * 「添加 AI 成员」表单。
		 *
		 * ⚠ 成员名在官方协议里是**不可变身份字段**（`team/member` 事件的
		 * `name`/`provider`/`context`），建完再改会被官方拒掉。所以：
		 * - 这里显示明确提示，一次定名；
		 * - 建完之后想显示中文名，走「编辑资料」的展示名覆写。
		 *
		 * 真正干活的是宿主侧 `/__teamchat/spawn` —— 只有宿主能拿到
		 * 精确的 live Lead Agent 对象。
		 */
		function AddMemberForm({ currentSessionId, t, onBack, onCreated }) {
			// **收编语义**（2026-09-28 定案）：成员 = 玩家**已打开的对话窗口**，
			// 不再「新建一个会话再开窗」。`currentSessionId` 是当前正在看的窗口，
			// 默认收编它，也可以从打开的会话里挑一个。
			const [targets, setTargets] = react.useState(null);
			const [targetId, setTargetId] = react.useState(currentSessionId ?? "");
			const [name, setName] = react.useState("");
			const [displayName, setDisplayName] = react.useState("");
			const [duty, setDuty] = react.useState("");
			// 头像：emoji / 文字 共用一个输入框，图片单独走文件选择。
			// 与 `MemberEditor` 用同一套上限与类型白名单（`AVATAR_MAX_BYTES` /
			// `AVATAR_INPUT_TYPES`）—— 两处闸不一致会出现「这边放行、那边拒掉」。
			const [avatarKind, setAvatarKind] = react.useState("emoji");
			const [avatarText, setAvatarText] = react.useState("");
			const [avatarImage, setAvatarImage] = react.useState("");
			// 「主智能体」开关：一个聊天室只有一个，负责分配任务 / 接收汇报 / 检查。
			const [isLead, setIsLead] = react.useState(false);
			// 房里已有主智能体时，换人要二次确认（把现在是谁告诉用户）。
			const [leadTaken, setLeadTaken] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [message, setMessage] = react.useState(null);
			const avatarFileRef = react.useRef(null);

			// 拉**可收编的会话清单**（打开的根会话）。当前会话没在清单里时
			// 留空让人自己挑，别硬收编一个根本没打开的窗口。
			react.useEffect(() => {
				let closed = false;
				void (async () => {
					try {
						const list = await targetsApi.list();
						if (closed) return;
						setTargets(list);
						// ⚠ 没有占位项了 ⇒ **必须保证 `targetId` 一定落在清单里的某一项上**。
						//   否则 `value` 匹配不到任何 option 时，浏览器会「显示第一项」，
						//   而 state 还是空 —— 界面与真实值不一致，要到提交才炸。
						//   原来靠一个「—」占位项撑着，现在改成主动退到第一项。
						const currentInList =
							(currentSessionId ?? "") !== "" &&
							list.some((row) => row.sessionId === currentSessionId);
						if (!currentInList) {
							setTargetId(list[0]?.sessionId ?? "");
						}
					} catch {
						if (!closed) setTargets([]);
					}
				})();
				return () => {
					closed = true;
				};
				// 只跑一次 —— 收编目标由用户在下拉里改，不跟着 currentSessionId 变。
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);

			// 收编目标变了就重问一次「这个房间有没有主智能体了」——
			// 有的话把开关的文案改掉，让用户知道选它会换人。
			react.useEffect(() => {
				if (targetId === "") {
					setLeadTaken(null);
					return undefined;
				}
				let closed = false;
				void (async () => {
					try {
						const { members: rows } = await roomApi.roster(targetId);
						if (closed) return;
						const lead = rosterOf(rows).find((row) => row.isLead === true);
						setLeadTaken(lead ?? null);
					} catch {
						/* 拿不到就当没有 —— 宿主侧还会再挡一次。 */
					}
				})();
				return () => {
					closed = true;
				};
			}, [targetId]);

			/** 会话标签：根目录名 + id 尾段 + 成员数。 */
			const targetLabel = (row) => {
				const folder = typeof row.cwd === "string" && row.cwd !== "" ? row.cwd.split(/[\\/]/).pop() : null;
				const short = typeof row.sessionId === "string" && row.sessionId !== "" ? row.sessionId.slice(-6) : "?";
				// ⚠ **优先显示对话的「原本名字」** —— 收编对话框的第一要务是让用户
				//   一眼认出「我要收编的是哪个对话」，而不是对着一串 id 后 6 位猜。
				//   宿主拿不到标题时才退回「目录名」。
				const title = typeof row.title === "string" && row.title.trim() !== "" ? row.title.trim() : null;
				const head = title ?? folder ?? "会话";
				return `${head} · ${short} · ${row.memberCount} 人`;
			};

			// 下拉分组用：当前窗口 vs 其他窗口（见下面 select 的 optgroup）。
			// `currentSessionId` 是打开这个对话框时正在看的窗口。
			const currentRow =
				Array.isArray(targets) && (currentSessionId ?? "") !== ""
					? (targets.find((row) => row.sessionId === currentSessionId) ?? null)
					: null;
			const others = Array.isArray(targets)
				? targets.filter((row) => row.sessionId !== currentSessionId)
				: [];

			/** 选头像图片（与 `MemberEditor.pickFile` 同一套闸）。 */
			const pickAvatar = (event) => {
				const file = event.target.files?.[0];
				event.target.value = "";
				if (file === undefined || file === null) return;
				if (!AVATAR_INPUT_TYPES.test(file.type)) {
					setMessage({ kind: "error", text: t("members.avatarBadType") });
					return;
				}
				if (file.size > AVATAR_MAX_BYTES) {
					setAvatarImage("");
					setMessage({ kind: "error", text: t("members.avatarTooLarge", { size: formatBytes(file.size) }) });
					return;
				}
				const reader = new FileReader();
				reader.onload = () => {
					const result = typeof reader.result === "string" ? reader.result : "";
					if (result === "") return;
					setAvatarImage(result);
					setMessage(null);
				};
				reader.onerror = () => setMessage({ kind: "error", text: t("members.avatarBadType") });
				reader.readAsDataURL(file);
			};

			const submit = async () => {
				if (busy) return;

				if (targetId === "") {
					setMessage({ kind: "error", text: t("members.adoptNoTarget") });
					return;
				}
				// 成员标识**可以留空** —— 留空时宿主会按名字 / 会话 id 自动派生。
				// 它有硬约束（只能用 [a-z0-9-]，还要当团队信箱的目录名），
				// 逼用户自己想一个英文标识是没必要的负担。
				const memberName = name.trim();
				if (
					memberName !== "" &&
					(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(memberName) || memberName === "lead")
				) {
					setMessage({ kind: "error", text: t("members.addNameInvalid") });
					return;
				}
				// 名字（显示名）必填：它是 AI 的自称，也是那个对话窗口的标题。
				// 空着的话界面上到处是内部标识，用户认不出谁是谁。
				if (displayName.trim() === "") {
					setMessage({ kind: "error", text: t("members.nameRequired") });
					return;
				}
				const description = duty.trim();
				if (description === "") {
					setMessage({ kind: "error", text: t("members.addDutyRequired") });
					return;
				}

				setBusy(true);
				setMessage({ kind: "ok", text: t("members.adoptBusy") });
				try {
					// 头像：没填就不传（宿主那边 `undefined` = 不要动已有的那份）。
					const avatarValue = avatarKind === "image" ? avatarImage : avatarText.trim();
					const { member, window: adopted, preset } = await spawnApi.create({
						// **收编**：把已打开的 `targetId` 这个会话注册为成员，不再新开会话。
						sessionId: targetId,
						// ⚠ **「我在哪个窗口点的添加」必须一起传** —— 房间是按**发起窗口的工作区**
						//   算的，宿主没法从被收编的窗口反推。不传的话它只能退回旧行为
						//   （把成员记进被收编的那个房间），于是「在 A 里收编 B」就变成 A 看不到 B。
						roomSessionId: currentSessionId ?? "",
						name: memberName,
						description,
						displayName: displayName.trim(),
						// 主智能体：房里已有的话带 `replaceLead` 显式表示「我知道要换人」。
						...(isLead === true ? { isLead: true, ...(leadTaken === null ? {} : { replaceLead: true }) } : {}),
						...(avatarValue === "" ? {} : { avatar: { kind: avatarKind, value: avatarValue } }),
					});
					onCreated(member?.name ?? memberName, adopted, preset);
				} catch (error) {
					setMessage({ kind: "error", text: spawnErrorMessage(t, error) });
				} finally {
					setBusy(false);
				}
			};

			return react.createElement(
				"div",
				{ className: "tc-editor" },
				react.createElement("div", { className: "tc-editor-title" }, t("members.adoptTitle")),
				react.createElement("div", { className: "tc-editor-note" }, t("members.adoptHint")),
				// ── 收编哪个窗口（默认当前正在看的那个）──────────────
				targets === null
					? react.createElement("div", { className: "tc-editor-note" }, t("members.loading"))
					: targets.length === 0
						? react.createElement("div", { className: "tc-editor-note" }, t("members.adoptNone"))
						: react.createElement(
								"label",
								{ className: "tc-field" },
								react.createElement("span", { className: "tc-field-label" }, t("members.adoptTarget")),
								react.createElement(
									"select",
									{
										className: "tc-input",
										value: targetId,
										onChange: (event) => setTargetId(event.target.value),
									},
									// ⚠ 这里**不放占位项**。原来第一项是一个「—」（长破折号），
									//   它既不属于任何对话、看上去又像中文的「一」——
									//   用户会以为多出一个对话（3 个对话却看到 4 个选项），
									//   而且怎么都认不出它是哪一个。
									//
									// 改成按「当前窗口 / 其他窗口」分组：一眼看出默认要收编的是
									// 自己正在看的这个，以及还有哪些别的窗口可选。
									currentRow !== null
										? react.createElement(
											"optgroup",
											{ label: t("members.adoptGroupCurrent") },
											react.createElement("option", { value: currentRow.sessionId }, targetLabel(currentRow)),
										)
									: null,
									others.length > 0
										? react.createElement(
											"optgroup",
											{ label: t("members.adoptGroupOthers") },
											...others.map((row) =>
												react.createElement("option", { value: row.sessionId, key: row.sessionId }, targetLabel(row)),
											),
										)
									: null,
								),
								react.createElement("span", { className: "tc-field-hint" }, t("members.adoptTargetHint")),
							),
				react.createElement(
					"label",
					{ className: "tc-field" },
					react.createElement("span", { className: "tc-field-label" }, t("members.addName")),
					react.createElement("input", {
						className: "tc-input",
						type: "text",
						value: name,
						maxLength: 64,
						autoFocus: true,
						placeholder: t("members.addNamePlaceholder"),
						onChange: (event) => setName(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") void submit();
						},
					}),
					// 标识是内部的事（还要当团队信箱的目录名），不该让用户为难 ——
					// 留空即自动派生，所以这里必须写清「平时不用管它」。
					react.createElement("span", { className: "tc-field-hint" }, t("members.addNameHint")),
				),
				react.createElement(
					"label",
					{ className: "tc-field" },
					react.createElement("span", { className: "tc-field-label" }, t("members.name")),
					react.createElement("input", {
						className: "tc-input",
						type: "text",
						value: displayName,
						maxLength: 32,
						placeholder: t("members.namePlaceholder"),
						onChange: (event) => setDisplayName(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") void submit();
						},
					}),
					// ⚠ 原来这里写的是 `t()` —— **没传键**，等于这个说明一直没显示过。
					//   补上，而且必须讲清一件事：它会成为对话窗口的名字。
					react.createElement("span", { className: "tc-field-hint" }, t("members.nameHintAdopted")),
				),
				react.createElement(
					"label",
					{ className: "tc-field" },
					react.createElement("span", { className: "tc-field-label" }, t("members.addDuty")),
					react.createElement("input", {
						className: "tc-input",
						type: "text",
						value: duty,
						maxLength: 200,
						placeholder: t("members.addDutyPlaceholder"),
						onChange: (event) => setDuty(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") void submit();
						},
					}),
				),
				// ── 头像 ────────────────────────────────────────────
				// 建的时候就能配上，省掉「建完 → 回列表 → 编辑资料」那一趟。
				react.createElement(
					"div",
					{ className: "tc-field" },
					react.createElement("span", { className: "tc-field-label" }, t("members.avatar")),
					react.createElement(
						"div",
						{ className: "tc-field-row" },
						react.createElement(Avatar, {
							memberKey: name.trim() === "" ? "?" : name.trim(),
							profile: {
								displayName: displayName.trim() === "" ? undefined : displayName.trim(),
								avatar:
									(avatarKind === "image" ? avatarImage : avatarText.trim()) === ""
										? undefined
										: { kind: avatarKind, value: avatarKind === "image" ? avatarImage : avatarText.trim() },
							},
							size: 30,
						}),
						react.createElement(
							"div",
							{ className: "tc-avatar-kinds" },
							...[
								["emoji", "members.avatarEmoji"],
								["text", "members.avatarText"],
								["image", "members.avatarImage"],
							].map(([id, key]) =>
								react.createElement(
									"button",
									{
										key: id,
										type: "button",
										className: "tc-avatar-kind",
										"data-active": avatarKind === id,
										"aria-pressed": avatarKind === id,
										onClick: () => setAvatarKind(id),
									},
									t(key),
								),
							),
						),
					),
					avatarKind === "image"
						? react.createElement(
								"div",
								{ className: "tc-avatar-image-row" },
								react.createElement("input", {
									ref: avatarFileRef,
									className: "tc-file",
									type: "file",
									accept: "image/png,image/jpeg,image/gif,image/webp,image/avif",
									onChange: pickAvatar,
								}),
								react.createElement(
									"button",
									{ type: "button", className: "tc-btn", onClick: () => avatarFileRef.current?.click() },
									t("members.avatarUpload"),
								),
								avatarImage === ""
									? null
									: react.createElement(
											"button",
											{ type: "button", className: "tc-btn tc-btn-ghost", onClick: () => setAvatarImage("") },
											t("members.avatarClear"),
										),
								react.createElement("span", { className: "tc-editor-note" }, t("members.avatarHint")),
							)
						: react.createElement("input", {
								className: "tc-input",
								type: "text",
								value: avatarText,
								maxLength: 8,
								placeholder:
									avatarKind === "emoji"
										? t("members.avatarPlaceholder")
										: t("members.avatarTextPlaceholder"),
								onChange: (event) => setAvatarText(event.target.value),
							}),
				),
				// ── 主智能体 ────────────────────────────────────────
				//
				// 用户的协作语义：一个主智能体坐镇指挥（分配任务 / 接收汇报 /
				// 检查产出），其余成员执行。所以这里是个**单选性质**的开关 ——
				// 房里已有别人当值时，文案要说清「选它会换人」。
				react.createElement(
					"div",
					{ className: "tc-field" },
					react.createElement(
						"div",
						{ className: "tc-setting" },
						react.createElement(
							"div",
							{ className: "tc-setting-body" },
							react.createElement("div", { className: "tc-setting-title" }, t("members.isLead")),
							react.createElement(
								"div",
								{ className: "tc-setting-desc" },
								leadTaken === null
									? t("members.isLeadDesc")
									: t("members.isLeadTaken", { name: leadTaken.displayName }),
							),
						),
						react.createElement(TeamSwitch, {
							checked: isLead,
							label: t("members.isLead"),
							onChange: setIsLead,
						}),
					),
				),
				message === null
					? null
					: react.createElement(
							"div",
							{ className: "tc-setting-msg", "data-kind": message.kind, role: "alert" },
							message.text,
						),
				react.createElement(
					"div",
					{ className: "tc-editor-actions" },
					react.createElement(
						"button",
						{ type: "button", className: "tc-btn tc-btn-ghost", disabled: busy, onClick: onBack },
						t("members.addBack"),
					),
					react.createElement(
						"button",
						{ type: "button", className: "tc-btn tc-btn-primary", disabled: busy, onClick: () => void submit() },
						busy ? t("members.adoptBusy") : t("members.adoptSubmit"),
					),
				),
			);
		}

		/**
		 * 会话头部右上角的「成员」菜单。
		 *
		 * 挂在 `conversation.session.header.actions`（`list` 槽，官方
		 * `experimental-client-ui-agent-team` 的 `TeamAction` 就在这儿，
		 * order -20）。这里用 order 200 排在它后面。
		 *
		 * 浮层用 `createPortal` 挂到 `document.body` —— 头部的
		 * `overflow` 会裁剪，不 portal 出去菜单会被切掉。
		 *
		 * 三个阶段（`stage`）：`list` 列表 / `edit` 编辑某人 / `add` 新增成员。
		 * 三者互斥，切换时由 CSS 的 `tc-stage-in` 做淡入位移过渡。
		 */
		/**
		 * 成员管理面板的**主体** —— 不含定位、不含 portal。
		 *
		 * 抽出来的原因：它有两个宿主 ——
		 * 1. 右侧栏页签（`sidebar.right.pane.tab`，需求 C 的主位置，见 `MembersPane`）
		 * 2. 会话头部按钮的浮层（保留为快捷入口，见 `MembersMenu`）
		 *
		 * 两者定位方式完全不同（右栏是正常文档流，浮层要 portal + 跟随锚点），
		 * 但内部三个阶段（列表 / 编辑 / 新增）与数据依赖一模一样，
		 * 所以只把主体抽出来复用，定位留在各自宿主。
		 *
		 * @param sessionId - 当前会话 id（标准 props 直给）。
		 * @param t - 文案函数。
		 * @param useSession - 会话快照选择器。
		 * @param useSessions - 会话集合选择器。
		 */
		function MembersPanel({
			sessionId,
			t,
			useSession,
			useSessions,
			embedded = true,
			panelProps,
			onOpenPane,
		}) {
			const [editing, setEditing] = react.useState(null);
			const [adding, setAdding] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const [members, reload] = useMembers();
			/** 正在等待二次确认的成员名（见 `removeMember`）。 */
			const [removing, setRemoving] = react.useState(null);

			// 只取 `leadSessionId` 用来查名单 —— **不再拿 `isTeam` 做早退**。
			//
			// 曾经「非团队会话整块不渲染」，那是个**死锁**：用户想加 AI 成员
			// 恰恰是因为还没有团队；整块藏掉就永远加不成。
			// 现在没成员时照常显示面板（名单为空），「添加 AI 成员」仍然可点。
			const { leadSessionId } = useTeamContext(useSession, useSessions, sessionId);
			// **唯一数据源：宿主的成员库**（`/__teamchat/team-members?sessionId=`）。
			//
			// 成员的形态改过一次：以前是官方 teammate（信息在 `agentTeam` 投影里），
			// 现在是一个**独立的顶层会话**，投影里根本没有它们 ——
			// 所以名单、显示名、职责、头像、会话 id 一律问宿主要。
			// 「已移除」名单顺带一起取回，不必再单独拉一次 `/members`。
			const [room, reloadRoom] = useRoomRoster(leadSessionId);
			const hidden = room.removed;
			// 名单里**只列 AI 成员**，不列发言人自己。
			//
			// ⚠ 「我（发言人）」是**设置页**那一块的事（改自己的名字/头像），
			//    在成员管理面板里再放一行只会造成两个入口、两套语义。
			//    用户明确要求过：「《我（发言人）》请只出现在设置里，不要出现在这里。」
			const roster = rosterOf(room.members).filter((item) => !hidden.includes(item.key));

			// 阶段：三者互斥。新增/编辑时不再显示列表，避免面板高度剧烈跳动。
			const stage = adding ? "add" : editing !== null ? "edit" : "list";

			/**
			 * 编辑完成回调。
			 *
			 * @param next - 提示文案，null 表示静默回列表。
			 */
			const done = (next) => {
				setEditing(null);
				void reload();
				void reloadRoom();
				// 有提示就留在列表上展示 —— 直接关面板会让用户以为没保存。
				setNotice(next ?? null);
			};

			/**
			 * 移除一个成员。
			 *
			 * **两步确认**：第一次点变成「确认移除」，第二次才真发请求。
			 *
			 * ⚠ 回执文案用宿主给的 `note` 原文 —— 它会说清「对话窗口还在左栏」。
			 * 自己编一句「已删除」会让用户以为窗口也没了。
			 *
			 * @param key - 成员名。
			 */
			const removeMember = async (key) => {
				if (removing !== key) {
					setNotice(null);
					setRemoving(key);
					return;
				}
				setRemoving(null);
				try {
					const result = await teamApi.remove({ parentSessionId: leadSessionId, name: key });
					void reload();
					void reloadRoom();
					// 宿主把 `note` 做成了「码 + 英文兜底」（见 `readJsonBody` 上面那段）：
					// 先按码查字典拿本地化文案，查不到才用 `note` 原文。
					setNotice({
						kind: "ok",
						text: errorText(t, result?.code, result?.params, result?.note) ?? t("members.removed"),
					});
				} catch (error) {
					setNotice({ kind: "error", text: spawnErrorMessage(t, error) });
				}
			};

			/**
			 * 成员创建成功。
			 *
			 * @param memberName - 成员名。
			 * @param createdWindow - 宿主给的窗口信息（`{sessionId, parentSessionId}`）。
			 *   有它才说明**真的开了一个对话**，而不是只写了个名字；
			 *   所以提示里要把它讲出来。
			 * @param presetResult - 「模式」的落地结果（宿主返回的 `preset` 字段）。
			 *   `null` = 这次没要求指定模式。**失败必须如实显示** ——
			 *   界面上的选择与真实状态不一致是最坑的。
			 */
			const created = (memberName, createdWindow, presetResult) => {
				setAdding(false);
				void reload();
				void reloadRoom();
				if (presetResult !== null && presetResult !== undefined && presetResult.ok !== true) {
					setNotice({
						kind: "error",
						text: t("preset.failed", { name: memberName, code: presetResult.code ?? "?" }),
					});
					return;
				}
				setNotice(
					createdWindow === null || createdWindow === undefined
						? t("members.addDone", { name: memberName })
						: t("members.addDoneWindow", {
								name: memberName,
								seconds: (Math.max(createdWindow.waitedMs ?? 0, 0) / 1000).toFixed(1),
							}),
				);
			};

			/** 列表行。 */
			const renderRow = (item) => {
				// 数据全部来自宿主：成员行自带 displayName / duty / avatar。
				//
				// ⚠ 这里原来写的是 `item.isLead ? resolveMember(...) : {...}` ——
				// 那是**旧语义**（`isLead` 当时表示"这行是发言人自己"）。
				// 2026-09-27 起 `isLead` 改成"**主智能体**"，成员一样有它，
				// 再用那个分支就会把主智能体的名字/职责错换成资料表里 lead 那条。
				const resolved = { name: item.displayName, duty: item.duty, avatar: item.avatar };
				const state = memberStateLabel(t, item);
				return react.createElement(
					"div",
					{ className: "tc-roster-row", key: item.key },
					react.createElement(Avatar, {
						memberKey: item.key,
						profile: { displayName: resolved.name, avatar: resolved.avatar },
						size: 26,
					}),
					react.createElement(
						"div",
						{ className: "tc-roster-main" },
						react.createElement(
							"div",
							{ className: "tc-roster-top" },
							react.createElement("span", { className: "tc-roster-name" }, resolved.name),
							// 「指挥」角标 = 主智能体。它是团队入口，排在最前。
							item.isLead === true
								? react.createElement("span", { className: "tc-tag tc-tag-lead" }, t("members.leadBadge"))
								: null,
							state === null ? null : react.createElement("span", { className: "tc-tag tc-tag-dim" }, state),
						),
						resolved.duty === ""
							? null
							: react.createElement("span", { className: "tc-roster-duty" }, resolved.duty),
					),
					// 「打开对话」—— 成员就是一个独立的会话窗口，这是回到它的入口。
					// 没有它的话，成员建完就再也找不到那个窗口了（只剩左栏里一条
					// 认不出是谁的会话行）。
					item.sessionId === "" || item.sessionId === null
						? null
						: react.createElement(
								"button",
								{
									type: "button",
									className: "tc-roster-open",
									onClick: () => openMemberSession(item.sessionId),
								},
								t("members.open"),
							),
					react.createElement(
						"button",
						{
							type: "button",
							className: "tc-roster-edit",
							onClick: () => setEditing(item.key),
						},
						t("members.edit"),
					),
					// 移除成员。
					//
					// ⚠ 改版后的语义：成员是**独立会话**，移除 = 从成员列表删掉它；
					// 那个对话窗口**留在左栏**，用户想删随时能在那儿删。
					// 与老实现（官方 teammate 删不掉、只能停运行 + 本地藏）完全不同。
					//
					// 主智能体一样可以移除 —— 移除后这个房间就没有指挥了，
					// 下次建成员时能把别人设成主智能体。
					react.createElement(
						"button",
						{
							type: "button",
							className: "tc-roster-remove",
							"data-confirm": removing === item.key ? "true" : undefined,
							onClick: () => void removeMember(item.key),
						},
						removing === item.key ? t("members.removeConfirm") : t("members.remove"),
					),
				);
			};

			/** 按阶段渲染面板主体。`key` 变化触发 CSS 淡入过渡。 */
			const body = () => {
				if (stage === "add") {
					return react.createElement(AddMemberForm, {
						key: "add",
						// **收编语义**：默认收编当前正在看的会话（面板的 `sessionId`）。
						currentSessionId: sessionId,
						t,
						onBack: () => setAdding(false),
						onCreated: created,
					});
				}

				if (stage === "edit") {
					const item = roster.find((row) => row.key === editing);
					// 房里现在的**主智能体是谁**（`null` = 还没有），喂给编辑器的身份开关。
					//
					// ⚠ 用 `room.members`（原始名单）而不是上面那个过滤过的 `roster`：
					//   「已移除」但身份位还留着的成员在这里也要被认出来 ——
					//   宿主是按成员库判定的，两边用同一份数据才不会出现
					//   「界面说没人当值、宿主却拒绝」。
					// ⚠ 排除**自己**：编辑主智能体本人时，「房里已有主智能体」说的不该是它，
					//   否则一次只改名字的保存会被自己顶掉（宿主侧同样排除自己）。
					const leadTaken =
						rosterOf(room.members).find((row) => row.isLead === true && row.key !== editing) ?? null;
					return react.createElement(MemberEditor, {
						key: `edit-${editing}`,
						memberKey: editing,
						label: item?.label,
						description: item?.duty === "" ? undefined : item?.duty,
						profile: members[editing],
						t,
						// ⚠ **这里永远是 false**：`speaker` 形态只给「我（发言人）」用，
						// 而发言人在设置页那块编辑，不出现在这个面板里。
						// 曾经误写成 `item?.isLead === true` —— 旧语义下它表示"这行是发言人"，
						// 新语义下它是"这是主智能体"，会把主智能体错当成发言人，
						// 于是它的职责/专属指令两个字段在编辑器里被藏掉。
						speaker: false,
						leadTaken,
						onDone: done,
					});
				}

				if (roster.length === 0) {
					return react.createElement("div", { className: "tc-panel-empty tc-stage", key: "empty" }, t("members.empty"));
				}
				return react.createElement("div", { className: "tc-roster tc-stage", key: "list" }, ...roster.map(renderRow));
			};

			// 这里**不做**「非团队会话整块隐藏」的早退 —— 理由见上面 `leadSessionId` 处的注释。
			// 没有团队时名单为空，`body()` 会渲染 `members.empty`，但头部的
			// 「添加 AI 成员」入口照常在，用户至少点得动。

			return react.createElement(
				"div",
				{
					// 两个宿主两种形态：
					// - 浮层（`embedded: false`）→ 用 `.tc-panel` 的 fixed 定位 + 阴影 + 入场动画，
					//   位置由 `panelProps.style` 给（跟着触发按钮算）。
					// - 右栏页签（默认）→ 加 `.tc-panel-embedded` 覆盖掉浮层那套装饰，
					//   回到正常文档流、高度撑满。
					className: embedded ? "tc-panel tc-panel-embedded" : "tc-panel",
					...panelProps,
				},
				react.createElement(
					"div",
					{ className: "tc-panel-head" },
					react.createElement("span", { className: "tc-panel-title" }, t("members.title")),
					// 右侧一组：计数 + 「在右栏打开」+ 「添加」。
					// 用 wrapper 而不是让 `.tc-panel-head` 的 space-between 去分散四个元素 ——
					// 四个直接子元素时 space-between 会把它们均匀摊开，很难看。
					react.createElement(
						"div",
						{ className: "tc-panel-head-right" },
						roster.length === 0
							? null
							: react.createElement(
									"span",
									{ className: "tc-panel-count" },
									t("members.count", { count: roster.length }),
								),
						// 「在右栏打开」只在**浮层形态**显示 —— 右栏里再放个「去右栏」是废话。
						embedded || onOpenPane === undefined
							? null
							: react.createElement(
									"button",
									{
										type: "button",
										className: "tc-panel-open",
										title: t("members.openPane"),
										"aria-label": t("members.openPane"),
										onClick: onOpenPane,
									},
									react.createElement(
										"svg",
										{ width: 12, height: 12, viewBox: "0 0 16 16", "aria-hidden": "true" },
										react.createElement("path", {
											d: "M6.5 3h6.5v6.5",
											fill: "none",
											stroke: "currentColor",
											strokeWidth: 1.7,
											strokeLinecap: "round",
											strokeLinejoin: "round",
										}),
										react.createElement("path", {
											d: "M13 3 6.5 9.5",
											fill: "none",
											stroke: "currentColor",
											strokeWidth: 1.7,
											strokeLinecap: "round",
										}),
									),
								),
						stage === "list"
							? react.createElement(
									"button",
									{
										type: "button",
										className: "tc-panel-add",
										title: t("members.add"),
										"aria-label": t("members.add"),
										onClick: () => {
											setNotice(null);
											setAdding(true);
										},
									},
									t("members.add"),
								)
							: null,
					),
				),
				notice === null
					? null
					: react.createElement(
							"div",
							{ className: "tc-setting-msg", "data-kind": "ok", role: "status" },
							notice,
						),
				body(),
			);
		}

		/**
		 * 右侧栏的成员管理页签主体 —— 需求 C 的落点。
		 *
		 * 用户要求：「成员管理不应放在模式右边，应放在对话框（聊天室）的最右侧，
		 * 也就是侧边栏的下方」。也就是右侧栏里的一个页签。
		 *
		 * 走官方两段式路径（`dsh-client-ui-sidebar-right` 的公开服务面）：
		 * - 第一段 `ctx.sidebarRightTabs.register({id, kind, title, guide})`
		 *   在 `applyInner` 里注册**类型**；
		 * - 第二段就是本组件 —— 注册 `sidebar.right.pane.tab`（keyed / session）
		 *   作为页签**主体**，另在 `sidebar.right.pane.tab.title` 注册标题。
		 *
		 * 页签的打开路径是官方的：右栏「新建标签页」打开 guide，
		 * 用户点我们注册的那张 guide 卡片（`pane.guideNew`）进入这个页签。
		 */
		function MembersPane({ sessionId, t, useSession, useSessions }) {
			return react.createElement(MembersPanel, { sessionId, t, useSession, useSessions });
		}

		/**
		 * 页签标题条上的文字。
		 *
		 * 注册在 `sidebar.right.pane.tab.title`（与主体同 key）。
		 * 不用 `useTabInfo` —— 官方 `tabInfoFactory` 在页签未提交到 layout 时**抛错**，
		 * 而标题条渲染时机比主体早，取它反而容易炸。静态文案够用。
		 */
		function MembersPaneTitle({ t }) {
			return react.createElement("span", { className: "tc-pane-title" }, t("pane.title"));
		}

		/**
		 * 会话头部右上角的「成员」按钮 —— 点开**浮层**快捷编辑。
		 *
		 * ## 两个入口并存，各有分工
		 *
		 * - **这个浮层**：点一下就地编辑。改名字/职责/头像、加成员、删资料都在
		 *   面板里闭环，不用离开当前会话。位置跟着按钮走，右侧对齐。
		 * - **右侧栏页签**（`MembersPane`）：完整管理面，从右栏的「+ → 成员管理」
		 *   进入。适合常驻、边看聊天边改。
		 *
		 * 两者渲染的是**同一个** `MembersPanel`，区别只在 `embedded`：
		 * 浮层要 `position: fixed` + 阴影 + 入场动画，右栏里是正常文档流。
		 *
		 * ## 为什么必须 portal 到 `document.body`
		 *
		 * 会话头部有 `overflow` 裁剪 —— 面板直接放在头部 DOM 里会被切掉。
		 * 官方 `experimental-client-ui-agent-team` 的 `TeamAction` 同款做法。
		 *
		 * ⚠ 定位用 `position: fixed`（`.tc-panel` 自带）+ 内联 `top/left/width`。
		 * 别忘了 `resize` / `scroll` 要重算，否则页面一滚面板就飘走。
		 */
		function MembersMenu({ sessionId, t, useSession, useSessions }) {
			// ⚠ **不再按「所在视图」门控**（2026-10-08）。
			//
			// 曾经的写法是 `const inChatRoom = useChatRoomActive(); … if (!inChatRoom) return null;`
			// 三条理由现在全不成立：
			//
			// 1. **用户要的正好相反**：「添加跟这个没关系，哪一个会话里都可以」。
			//    成员入口（看名单 / 加成员 / 收编窗口）是**跨窗口**的操作，
			//    只让聊天室 tab 里点得到，等于逼着用户先回到聊天室。
			// 2. 那个门控把「入口在不在」绑在一个**模块级布尔**上，
			//    而这个布尔由 `TeamChatView` 的挂载/卸载维护 —— 只要有一次
			//    切换没把值对齐，**入口就凭空消失**（还看不出是为什么）。
			//    少一个门控就少一整类「莫名其妙不见了」。
			// 3. 用「会话有没有 agentTeam」当判据是死锁（没团队 → 没入口 →
			//    永远建不出团队）；用视图当判据虽不致死锁，但同样让入口
			//    跟用户的真实意图脱节。
			//
			// 现在：**每个会话的右上角都有「成员」**。名单本身按房间（工作区）
			// 解析，所以在哪个窗口点开看到的都是同一个聊天室的成员。
			const [open, setOpen] = react.useState(false);
			const rootRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const [anchor, setAnchor] = react.useState(null);

			// 定位：跟着触发按钮走，右侧对齐，并夹回视口内。
			//
			// 用 `position: fixed`（`.tc-panel` 自带）而不是 absolute ——
			// 会话头部有 `overflow` 裁剪，absolute 会被切掉。
			// 这也是下面必须 portal 到 body 的原因。
			react.useLayoutEffect(() => {
				if (!open) {
					setAnchor(null);
					return;
				}
				const place = () => {
					const trigger = rootRef.current?.getBoundingClientRect();
					if (trigger === undefined) return;
					const width = 320;
					const left = Math.max(8, Math.min(trigger.right - width, window.innerWidth - width - 8));
					setAnchor({ top: trigger.bottom + 6, left, width });
				};
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return () => {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
				};
			}, [open]);

			// 点外部 / 按 Escape 关闭。
			react.useEffect(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					if (rootRef.current?.contains(event.target) === true) return;
					if (panelRef.current?.contains(event.target) === true) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			const panel =
				open && anchor !== null
					? react.createElement(MembersPanel, {
							sessionId,
							t,
							useSession,
							useSessions,
							// 浮层形态：不带 `tc-panel-embedded` 那套覆盖。
							embedded: false,
							onOpenPane: () => {
								// 先收浮层再开右栏 —— 否则浮层会压在右栏上和页签重叠。
								setOpen(false);
								openMembersPane();
							},
							panelProps: {
								ref: panelRef,
								style: { top: anchor.top, left: anchor.left, width: anchor.width },
							},
						})
					: null;

			return react.createElement(
				"div",
				{ className: "tc-menu-root", ref: rootRef },
				react.createElement(
					"button",
					{
						type: "button",
						className: "tc-menu-trigger",
						"aria-label": t("members.trigger"),
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						title: t("members.trigger"),
						onClick: () => setOpen((value) => !value),
					},
					react.createElement(
						"svg",
						{ width: 14, height: 14, viewBox: "0 0 16 16", "aria-hidden": "true" },
						react.createElement("circle", { cx: 8, cy: 3, r: 1.5, fill: "currentColor" }),
						react.createElement("circle", { cx: 8, cy: 8, r: 1.5, fill: "currentColor" }),
						react.createElement("circle", { cx: 8, cy: 13, r: 1.5, fill: "currentColor" }),
					),
					react.createElement("span", { className: "tc-menu-label" }, t("members.trigger")),
				),
				// portal 到 body —— 头部有 overflow 裁剪，不 portal 面板会被切掉。
				// 官方 `experimental-client-ui-agent-team` 的 TeamAction 同款做法。
				panel === null ? null : reactDom.createPortal(panel, document.body),
			);
		}


		/**
		 * 内联样式。
		 *
		 * 主题变量族是 `--dsw-alias-*`（不是 `--dsh-*`，那套名字在 DSH 里不存在，
		 * 写了只会落进 fallback，浅色主题下会糊成一片灰）。
		 */
		const TEAM_CHAT_CSS = `
/* ⚠⚠ 高度不能只写 height: 100% —— 会塌陷并把输入框顶上会话最上面。
   逐层推导（都是读官方 CSS 得来的，不是猜）：
     · 主区视图的容器 .ank0OG_viewArea 在 [data-phase=active] 时是
       flex: 1 0 auto + min-height: auto（dsh-client-ui-conversation 的
       ConversationRoot 样式表）⇒ **高度完全由内容撑开**；
     · 它的父级不把它拉满，所以视图内容矮 = viewArea 矮；
     · 内容矮时 composerSeat（position: sticky; bottom: 0）没有滚动余量可粘，
       就停在正常流位置 ⇒ 紧跟 header，下方全空、滚轮无效。
   实测症状（2026-10-10 宿主日志，另一个插件的布局诊断）：
     input top=84 / scrollBody h918 / composerSeat h128 ⇒ viewArea 高约 0。
   ⇒ 必须有**自带的高度下限**。官方 chat 视图自己也是这么兜的
     （dsh-client-ui-chat 的 turn rail：var(--dsh-conversation-viewport-height, 100dvh)）。
   这里取 max(320px, 变量)：变量在会话主区 = scrollBody.clientHeight（一屏），
   拿不到时（如左侧栏 main 面板）也不至于掉到 0。
   注意**不要**把缺省值写成 100dvh：main 面板的容器比视口矮，会溢出被裁。
   ⚠ min-height 写成两遍是**故意的**：第一遍是硬兜底。var() 一旦解析成空值
     （官方那颗 ResizeObserver 在某些时机写的是空串），整条声明会连带失效、
     计算值落回 auto —— 那就等于没这层保护。有了第一遍，第二遍坏掉也只是
     掉回 320px，不会一路塌到底（守卫 [26] 钉这两条的关系）。 */
.tc-root { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; height: 100%; min-height: 320px; min-height: max(320px, var(--dsh-conversation-viewport-height, 0px)); max-height: var(--dsh-conversation-viewport-height, none); overflow: hidden; }
/* ⭐⭐⭐ 「切换左侧对话之后又塌了」的真修法（2026-10-10 第五轮，无头浏览器实测）
   —— 前四轮一直在给 .tc-root 自己打补丁（补下限 / 钳上限 / 断写入回路），
   都是**治标**：它们全依赖一颗**不知道什么时候会被写上**的变量，
   而这颗变量一旦缺席，min-height 与 max-height 会**双双失效**（见上），
   布局就直接回到没修之前。真正的开关在**父容器** .ank0OG_viewArea 上：
     · viewArea 的父 [data-slot] 是 display:contents（renderer 的 ANCHOR_STYLE，
       dsh-client-ui-renderer:1094），**不产生盒子**
       ⇒ viewArea 才是 scrollBody 的真实 flex item；
     · 官方在 [data-phase=active] 下把它写成 flex: 1 0 auto + min-height: auto
       ⇒ basis 取内容高：内容少时被 grow 勉强拉到剩余空间，
         内容多时（实测 200 条）被撑到 **14450px**，滚动推给外层 scrollBody，
         而 .tc-list 内部那根滚动条形同虚设；
     · 官方自己在同一份样式表的最后一条里，把**同一条祖先链**改回了
       flex: 1 1 0 + min-height: 0 + overflow: hidden（overlay 模式专用）。
   这里对「正好装着聊天室的那个 viewArea」做同样的事：
     flex: 1 1 0   ⇒ 高度 = scrollBody 减去 composerSeat，**与内容多少无关**；
     min-height: 0 ⇒ 允许被压矮（否则 automatic minimum size 按内容算）；
     overflow: hidden ⇒ 内容再多也撑不破。
   选择器用 :has(> .tc-root) 精确到「里面直接装着聊天室」的那一个 viewArea，
   官方 chat / 绘画等其它视图一概不碰；三层祖先是为了压过官方那条
   [data-phase=active]（它的优先级是 0,3,0）。
   实测 7 组组合（变量有·空·缺 × 内容 0/200 条 × active/非 active）：
     viewArea 恒 756（= scrollBody 884 − composerSeat 128）、
     .tc-list 恒 700/7190 **内部真在滚**、外层恒 884/884 **完全不溢出**。
   :has() 不被支持时整条规则被丢弃 ⇒ 优雅退回上面的 min/max 兜底，不会更差。 */
[data-conversation-scroll]>[data-slot]>.ank0OG_viewArea:has(>.tc-root) { flex: 1 1 0; min-height: 0; overflow: hidden; }
/* ⚠ 上面那套 min/max-height 兜底只属于**父高不确定**的宿主（左侧栏 main 面板）。
   父高一旦由 viewArea 确定，它们只会把 root 拉到比可视区更大 —— 实测 200 条时
   tcRoot 967 > viewArea 756，底部 211px 被 overflow:hidden 直接裁掉看不见。
   ⇒ 只有落在那个 viewArea 里时才把两者卸掉，高度彻底交给 height: 100%。 */
[data-conversation-scroll]>[data-slot]>.ank0OG_viewArea:has(>.tc-root)>.tc-root { min-height: 0; max-height: none; }
/* ⭐⭐⭐ 聊天室里的 @ 候选**只许是成员**（用户诉求：艾特只能艾特房间里的 AI 成员，
   文件 / 对话那些官方的 @ 源在这个视图里不要出现 —— 「添加文件我自有那个加号」）。

   为什么只能这么做：官方 input-trigger 的源注册表**只有全局一层**，
   没有「按视图/会话门控源」或「屏蔽某个源」的手段
   （dsh-client-ui-input-trigger/lib/client.js:904 的 registerSource 只做
   (trigger,name) 去重；:942 的 roster 只按 trigger 过滤 + order 排序；
   该包 README.zh.md:80 自己写着「只有全局 source 层 —— 会话 scope 的 source
   注册（逐会话遮蔽）已有设计但未启用」）。所以**不改别的插件的注册**、
   也不夺舍官方控制器，就只能在这一层做视觉屏蔽。

   作用域锚点：下面的 **.tc-members**（聊天室顶部那条成员栏，是 .tc-root 的
   直接子元素）挂在 composer 卡片上。①它**只在聊天室视图里渲染**
   （TeamChatRoom 的成员栏；空态分支不渲染它）—— 普通对话里没有 ⇒ 这几条
   规则一条都不会命中，官方源照旧可用；②它不会误伤别的视图，因为判定的是
   「当前这张 composer 卡片里装着聊天室」这件事本身。

   为什么是「整条视口先全藏、再只把成员行放回来」而不是点名藏官方源：
   官方 reference 的候选行带 section（文件与文件夹 / 子智能体 / 对话），
   而 MenuView 渲染 sectionTitle 时**没写 data-source**
   （input-trigger/lib/client.js:1136 那个 div 只有 className: sectionTitle），
   点名藏 [data-source=...] 会有漏网的「文件与文件夹」标题留在菜单里。
   所以这里反向做：白名单只认我们自己的行（id 前缀 = optionId(MENTION_SOURCE)，
   见同文件 :1033），**没被放行的一律不显示** —— 官方以后再加新的 @ 源，
   也自动不会出现在聊天室里。代价是那条「以后新增的官方 @ 源会被静默藏掉」，
   已写进验收报告的风险项。

   已知代价：这只挡显示，不挡键盘 —— 官方菜单**状态**里仍然有 reference
   那一组（源是全局注册的，屏蔽不掉），↓ 键仍会走到它那些行上，
   用户看到的是「高亮走到了看不见的行」。这一点没有假装解决，
   验收报告里如实列了。

   ⚠ 下面三条规则的选择器里都带 [data-tc-mention-gate] 这个**只用于自证**的
   标记：验收脚手架按它把这三条抠出来、用真 CSS 选择器引擎跑一遍
   （否则脚手架只能自己抄一份选择器常量，那就变成「测自己抄的那份」，
   插件里改坏也照样全绿）。这个属性在真实 DOM 上永远不存在 ——
   它是挂在「那张卡片」上的一个永远不成立的条件，只让规则**可被检索**。 */
[data-composer-card][data-tc-mention-gate]:has(> .tc-members) [data-trigger-menu] * { display: none; }
[data-composer-card][data-tc-mention-gate]:has(> .tc-members) [data-trigger-menu] [id^="dsh-slash-option-team-members-"] { display: revert; }
/* 成员行前面那行小节标题（我们的候选行自带 section = 「AI 成员」）也放回来 ——
   它在 DOM 上没有 data-source，只能按官方那个类名认；而且**不能无脑放行**：
   官方 reference 的三行小节标题（文件与文件夹 / 子智能体 / 对话）用的是同一个类名，
   无脑放行会把它们留在菜单里，正好违背用户的要求。所以判据是
   「**紧挨着成员行**的那个 section 标题」—— 靠 + 相邻兄弟选择器表达，
   对每一行成员候选都写一遍（2~3 行名字，成本可以忽略）。
   类名是构建期算出来的（MenuView.module.css → bqwvaa_sectionTitle），
   官方换构建就会失效：后果只是**少一行「AI 成员」分类文字**，行本身还在，
   不是功能坏掉。一并记进验收报告的风险项。 */
[data-composer-card][data-tc-mention-gate]:has(> .tc-members) [data-trigger-menu] .bqwvaa_sectionTitle:has(+ [id^="dsh-slash-option-team-members-"]) { display: revert; }
/* 菜单在 macOS 上另有一层**不透明背板**，走 createPortal 挂在 body 下
   （primitives 的 MenuSurface.js：只有 backing 走 portal，可见的那层留在原地）。
   它不含任何行文字，被藏起来的候选不会在上面留字 —— 但如果一个都不剩
   （用户打了个匹配不到成员的查询），可见层会自己关掉而背板不关，
   屏幕上就剩一块空色块。所以这里按「卡片里装着聊天室」整条一起收掉。
   用 opacity 而不是 display：backing 靠 --dsh-menu-anchor 与可见层对齐，
   留在布局里更保险（收益为零、风险最小的一侧）。 */
body:has([data-composer-card][data-tc-mention-gate] > .tc-members) [data-menu-backing] { opacity: 0; }
/* 聊天室顶部的成员栏 —— 让用户一眼看到「这个房间里都有谁」。
   原来这个视图只渲染消息流，没消息时整片空白、看不到成员。 */
.tc-members { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 2px; margin-bottom: 6px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2)); }
/* 胶囊形：必须显式声明 corner-shape: round 退出全局超椭圆，否则两头会被拉尖。 */
.tc-member-chip { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px 0 4px; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); font-size: 11px; line-height: 1; white-space: nowrap; }
.tc-members-avatar { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.2)); font-size: 10px; overflow: hidden; flex: 0 0 auto; }
.tc-members-avatar-img { object-fit: cover; }
.tc-member-chip-name { max-width: 110px; overflow: hidden; text-overflow: ellipsis; }
.tc-member-chip-off { color: var(--dsw-alias-label-tertiary, #aaa); }
.tc-banner { font-size: 12px; padding: 6px 10px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.tc-banner-warn { background: var(--dsw-alias-state-warn-secondary, rgba(214,158,46,.16)); }
/* 空态撑满剩余高度并居中：只给 padding 的话，整条视图会矮到不足一屏，
   配合上面 root 的塌陷就是「输入框卡在最上面」的现场之一。 */
.tc-empty { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary, #888); font-size: 13px; padding: 24px 4px; }
/* ⚠ min-height: 0 不能省 —— 它是这个滚动容器能不能滚的**唯一**开关。
   注意：这段 CSS 在**模板字符串**里，所以注释里**绝不能出现反引号**
   （会提前终结模板串 ⇒ 整个客户端 bundle 解析失败 ⇒ 界面全白。已踩过一次）。
   .tc-list 是 .tc-root（column flex，height:100% + overflow:hidden）的子项，
   而 flex 子项默认 min-height: auto = **不允许被压到比内容更矮**。
   少了这一行：列表会撑到内容那么高 ⇒ 自己永远不溢出 ⇒ overflow-y:auto 形同虚设，
   而超出的部分被 .tc-root 的 overflow:hidden **直接裁掉** ——
   现象就是「右边没有滚动条、也够不到下面的消息」（用户实际反馈）。
   flex: 1 1 auto 让它吃掉剩余高度；scrollbar-gutter: stable 让滚动条出现时
   不会把内容挤得跳一下。 */
.tc-list { display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-gutter: stable; }
/* ── 聊天室气泡 ────────────────────────────────────────────────
 * 用户要的是「像聊天室」：自己的话靠右、品牌色实底；别人的话靠左、带头像。
 * 一坨消息之间留 2px，换人时留 12px（靠 .tc-bubble-row-grouped 反向压缩），
 * 这样「连续说话」和「换人」在视觉上分得开，而不用画分割线。 */
.tc-list { gap: 2px; padding: 4px 2px 12px; }
/* ⚠ 头像必须**顶部对齐**（与名字同一行），不能 flex-end：
 * 这一列是 [名字 / 气泡 / 尾巴]，尾行（时间·收件人·已送达）在最下面，
 * 一改成底部对齐，头像就会跑到最下面、贴着时间戳，离名字隔一整个气泡
 * —— 2026-10-09 用户截图报的就是这个（两侧都错）。
 * 顶对齐后头像横跨「名字行 + 气泡首行」，正是聊天室该有的样子。
 * ⚠ 这条注释里**不许出现反引号**：整段 CSS 是一个模板串。 */
.tc-bubble-row { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; }
.tc-bubble-row-grouped { margin-top: 2px; }
/* 自己的消息整行反向排 —— 头像位留在右边，气泡贴右。 */
.tc-bubble-row[data-mine="true"] { flex-direction: row-reverse; }
.tc-bubble-gutter { width: 28px; flex: 0 0 auto; }
.tc-bubble-avatar { width: 28px; flex: 0 0 auto; display: inline-flex; align-items: center; }
.tc-bubble-col { display: flex; flex-direction: column; gap: 3px; min-width: 0; max-width: min(78%, 560px); }
.tc-bubble-row[data-mine="true"] .tc-bubble-col { align-items: flex-end; }
.tc-bubble-name { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary, #888); display: flex; align-items: baseline; gap: 6px; padding-left: 2px; }
/* 自己那侧的「名字 + 头像」贴右 —— 左边留的那 2px 要换到右边，否则
 * 名字会往里缩一格，和气泡的右边线对不齐。 */
.tc-bubble-row[data-mine="true"] .tc-bubble-name { padding-left: 0; padding-right: 2px; }
.tc-bubble-duty { color: var(--dsw-alias-label-tertiary, #aaa); }
.tc-bubble { padding: 7px 11px; border-radius: 12px; corner-shape: round; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary, #1a1a1a); }
/* 自己那侧用品牌色实底 + 反白字（与官方主按钮同一族 token）。 */
.tc-bubble-row[data-mine="true"] .tc-bubble { background: var(--dsw-alias-state-business-primary, #247bbf); color: var(--dsw-alias-label-primary-foreground, #fff); }
.tc-bubble-text { font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
/* ── Markdown 正文（只给 AI 成员那条用）─────────────────────────
 * ⚠ .tc-bubble-text 自带 white-space: pre-wrap，那是**给纯文本那条**用的
 *   （人的消息要保持逐字换行）。Markdown 这条必须把它改回 normal，
 *   否则源码里的换行会与块级排版打架（空行变双倍、段内软换行不折叠）。
 *   两条路径各留一份声明，互不影响 —— 这里只加 .tc-md 覆盖。
 *
 * ⚠ 本段只用**本文件里已经在用的** --dsw-* token（逐个核对过：
 *   --dsw-alias-bg-layer-3 / --dsw-alias-border-l2 / --dsw-alias-label-secondary
 *   / --dsw-alias-label-primary 都在上面的规则里出现过）。
 *   凭空写没注册的 token 会被静默丢弃（表现是透明 / 无样式，踩过）。
 *   等宽字体**不走 token**：本文件从没用过字体族 token，写一个不存在的
 *   名字只会落进 fallback，不如直接用系统等宽栈。
 *   （这段注释里**一个反引号都不能有**：整段 CSS 是一个模板串，反引号会
 *    提前终结它 —— 这正是本次改动里真踩到的一个坑，解析检查当场就 FAIL 了。） */
.tc-md { white-space: normal; }
/* 块间距：统一 6px，第一块与最后一块不留外边距（否则气泡会被撑高）。 */
.tc-md-p { margin: 0 0 6px; }
.tc-md > *:last-child { margin-bottom: 0; }
.tc-md > *:first-child { margin-top: 0; }
.tc-md-h { margin: 8px 0 4px; font-weight: 600; line-height: 1.35; }
h1.tc-md-h { font-size: 17px; }
h2.tc-md-h { font-size: 16px; }
h3.tc-md-h { font-size: 15px; }
h4.tc-md-h, h5.tc-md-h, h6.tc-md-h { font-size: 13px; }
.tc-md-code { padding: 1px 4px; border-radius: 4px; background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.18)); font-family: Consolas, "Cascadia Mono", "Courier New", monospace; font-size: 12px; }
/* 围栏代码块：横向滚动而不是把气泡撑宽（气泡有 max-width 上限）。 */
.tc-md-pre { margin: 0 0 6px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.18)); overflow-x: auto; }
.tc-md-pre .tc-md-code { padding: 0; background: transparent; white-space: pre; }
.tc-md-list { margin: 0 0 6px; padding-left: 20px; }
.tc-md-list .tc-md-list { margin-bottom: 0; }
.tc-md-list li > .tc-md-p { margin: 0; }
/* 引用块：左边一条竖线就够，别再加底色（会和气泡底色叠成两层）。 */
.tc-md-quote { margin: 0 0 6px; padding-left: 10px; border-left: 2px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); color: var(--dsw-alias-label-secondary, #777); }
.tc-md-rule { margin: 8px 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.tc-md-link { color: inherit; text-decoration: underline; }
/* 协议不放行的链接：只留文字，明确不给可点的外观。 */
.tc-md-link-off { text-decoration: line-through; opacity: .7; }
/* 表格：气泡宽度有限，给一层横向滚动，别把布局顶出去。 */
.tc-md-table { margin: 0 0 6px; border-collapse: collapse; font-size: 12px; line-height: 1.5; }
.tc-md-table th, .tc-md-table td { padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.tc-md-table th { background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.18)); font-weight: 600; }
/* 数字与表格里的等宽：沿用时间戳那条的做法（它证明了这个属性可用）。 */
.tc-md-table td { font-variant-numeric: tabular-nums; }
.tc-bubble-tail { display: flex; align-items: center; gap: 6px; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary, #aaa); padding: 0 2px; }
/* ── 折叠：头部永远露着，正文折起来 ──────────────────────────────
   折叠态整块气泡就是那个开关，所以要有明确的可点提示（cursor + hover），
   否则用户会以为这条消息就只有这么一行。展开态由尾巴上的「收起」负责收起。 */
.tc-bubble-collapsed { cursor: pointer; }
.tc-bubble-collapsed:hover { box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127,127,127,.35)); }
/* 规模提示：告诉用户这条值不值得点开（共 N 行 · M 字）。 */
.tc-bubble-size { display: inline-block; margin-left: 6px; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary, #aaa); }
.tc-bubble-row[data-mine="true"] .tc-bubble-size { color: var(--dsw-alias-label-primary-foreground, #fff); opacity: .78; }
/* 折叠时头部后面那个省略号：它不是正文的一部分，只是个"还有更多"的记号。 */
.tc-bubble-ellipsis { color: var(--dsw-alias-label-tertiary, #aaa); }
/* 展开态的「收起」入口。 */
.tc-bubble-collapse { color: var(--dsw-alias-label-tertiary, #aaa); cursor: pointer; }
.tc-bubble-collapse:hover { color: var(--dsw-alias-label-secondary, #888); text-decoration: underline; }
.tc-bubble-row[data-mine="true"] .tc-bubble-tail { flex-direction: row-reverse; }
.tc-bubble-target { color: var(--dsw-alias-label-secondary, #888); }
/* 时间用等宽数字：不然 11:11 与 11:41 宽度不一样，一串消息的尾巴会左右抖。 */
.tc-bubble-time { font-variant-numeric: tabular-nums; }
.tc-bubble-status[data-delivered="false"] { color: var(--dsw-alias-state-warn-primary, #b8860b); }
/* 日期分隔：只在跨天时出现，细到不抢戏。 */
.tc-chat-day { align-self: center; margin: 14px 0 2px; padding: 1px 8px; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); color: var(--dsw-alias-label-tertiary, #aaa); font-size: 11px; line-height: 16px; }
.tc-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); }
.tc-row-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; }
.tc-row[data-role="lead"] { border-left: 3px solid var(--dsw-alias-brand-primary, #4c8dff); }
.tc-row[data-role="teammate"] { border-left: 3px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); }
/* 头像：三级降级（自定义 emoji/文字 → ID 首字）。背景色由 key 哈希决定。 */
.tc-avatar { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; border-radius: 50%; corner-shape: round; overflow: hidden; line-height: 1; user-select: none; color: var(--dsw-alias-label-primary, #1a1a1a); }
.tc-avatar[data-kind="image"] { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
.tc-avatar-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tc-meta { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.tc-sender { font-weight: 600; }
.tc-row-duty { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-arrow { opacity: .5; }
.tc-target { opacity: .75; }
.tc-status { margin-left: auto; font-size: 11px; opacity: .6; }
.tc-status[data-delivered="true"] { opacity: .85; }
.tc-body { font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.tc-setting { border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25)); display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0; max-width: 640px; }
.tc-setting-body { min-width: 0; }
.tc-setting-title { font-size: 14px; line-height: 20px; }
.tc-setting-desc { color: var(--dsw-alias-label-secondary, #888); margin-top: 4px; font-size: 12px; line-height: 18px; }
.tc-setting-note { color: var(--dsw-alias-label-secondary, #888); margin-top: 4px; font-size: 12px; line-height: 18px; }
/* 开关当前状态那一行：「已关闭 —— 本插件工作正常」要读起来是**好消息**。
   关掉的状态刻意用中性色而不是红/绿 —— 它既不是错误也不是成功，
   只是"这开关跟我们没关系"。 */
.tc-setting-note[data-state="off"] { color: var(--dsw-alias-label-secondary, #888); }
.tc-setting-note[data-state="on"] { color: var(--dsw-alias-label-secondary, #888); }
.tc-setting-note[data-state="status"] { font-style: italic; }
.tc-setting-msg { margin-top: 4px; font-size: 12px; line-height: 18px; }
.tc-setting-msg[data-kind="error"] { color: var(--dsw-alias-state-error-primary, #d9534f); }
/* 开关：照抄 host primitive 的形态，类名换成本插件前缀，只留 --dsw-* token。
 * 开/关外观挂在 aria-checked 上，避免视觉态与读屏态不一致。 */
.tc-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-border-l3, rgba(127,127,127,.5)); cursor: pointer; }
.tc-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, #247bbf); }
.tc-switch:disabled { cursor: default; opacity: .5; }
.tc-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 2px; }
.tc-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground, #fff); transition: transform 120ms ease; }
.tc-switch[aria-checked="true"] .tc-switch-thumb { transform: translateX(16px); }
/* ── 头部「成员」菜单 ────────────────────────────────────────
 * 触发器塞进宿主 headerActions 的行内布局里，所以尺寸要跟相邻按钮一致
 * （官方 TeamAction 的 trigger 也是 14px 图标 + 12px 文字）。 */
.tc-menu-root { display: inline-flex; align-items: center; }
.tc-menu-trigger { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #666); font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap; }
.tc-menu-trigger:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); color: var(--dsw-alias-label-primary, #1a1a1a); }
.tc-menu-trigger:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 1px; }
.tc-menu-trigger[aria-expanded="true"] { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); color: var(--dsw-alias-label-primary, #1a1a1a); }
/* 窄屏只留图标 —— 与官方 TeamAction 的隐藏策略一致。 */@media (max-width: 720px) { .tc-menu-label { display: none; } }
/* 条目自带边界失败时的降级胶囊。
 * 尺寸刻意与相邻的 .tc-menu-trigger 一行高一致（26px / 12px 字），
 * 这样它顶掉按钮那一下不会让头部那一行跳高。
 * 用 warn 色而不是 error 色：界面没坏，只是这一个入口被就地隔离了。
 * ⚠ 本段处在 TEAM_CHAT_CSS 模板串里 —— 注释里**不许**出现反引号（守卫 [14]）。 */
.tc-entry-error { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border: 0; border-radius: 6px; background: var(--dsw-alias-state-warn-secondary, rgba(214,158,46,.16)); color: var(--dsw-alias-label-primary, #1a1a1a); font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap; }
.tc-entry-error:hover { background: var(--dsw-alias-state-warn-secondary, rgba(214,158,46,.26)); }
.tc-entry-error:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 1px; }
/* 浮层 portal 到 body，定位由 JS 算（右侧对齐触发器）。 */
.tc-panel { position: fixed; z-index: 2147483000; box-sizing: border-box; display: flex; flex-direction: column; max-height: min(70vh, 520px); min-height: 0; overflow-y: auto; padding: 10px; border: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: 10px; background: var(--dsw-alias-bg-base, #fff); box-shadow: 0 8px 28px rgba(0,0,0,.16); color: var(--dsw-alias-label-primary, #1a1a1a); transform-origin: top right; animation: tc-panel-in 140ms ease both; }
@keyframes tc-panel-in { from { opacity: 0; transform: translateY(-4px) scale(.97); } to { opacity: 1; transform: none; } }
.tc-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 2px 8px; }
.tc-panel-title { font-size: 13px; font-weight: 600; }
.tc-panel-count { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
.tc-panel-add { flex: 0 0 auto; height: 22px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-brand-primary, #247bbf); font-size: 11px; cursor: pointer; white-space: nowrap; transition: background 120ms ease; }
.tc-panel-add:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
.tc-panel-add:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 1px; }
/* 头部右侧组：把计数与两个按钮收在一起，避免 space-between 把四个元素摊开。 */
.tc-panel-head-right { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.tc-panel-open { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary, #777); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.tc-panel-open:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); color: var(--dsw-alias-label-primary, #1a1a1a); }
.tc-panel-open:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 1px; }
.tc-panel-empty { padding: 12px 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #888); }
/* ── 右侧栏页签形态（需求 C）──────────────────────────────
   同一个面板组件两个宿主：浮层要 fixed + 阴影，右栏里是正常文档流。
   .tc-panel-embedded 覆盖掉浮层那套定位与容器装饰。 */
/* ⚠ **嵌入模式不能是透明**：透明会让面板内容与宿主内容直接叠在一起 ——
   表现就是「下半部分没被底片罩住」（上半部分看着正常，只是因为
   输入框自己的底色挡了一下）。给一层真实存在的层级底色。 */
.tc-panel-embedded { position: static; z-index: auto; max-height: none; height: 100%; padding: 10px 12px; border: 0; border-radius: 0; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: none; animation: none; }
.tc-panel-embedded .tc-roster { flex: 1 1 auto; min-height: 0; }
.tc-pane-title { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tc-pane-empty { padding: 16px 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #888); }
/* 阶段切换（列表 ⇄ 编辑 ⇄ 新增）：React 靠 key 换元素，这里做淡入位移。 */
.tc-stage { animation: tc-stage-in 150ms ease both; }
@keyframes tc-stage-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.tc-roster { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.tc-roster-row { display: flex; align-items: center; gap: 8px; padding: 6px 6px; border-radius: 7px; transition: background 120ms ease; }
.tc-roster-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.07)); }
.tc-roster-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.tc-roster-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tc-roster-name { min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-roster-duty { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-tag { flex: 0 0 auto; padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-brand-primary, #4c8dff); color: #fff; font-size: 10px; line-height: 15px; }
/* 次要标签：不是身份（Lead），而是状态（未在运行 / 收不到）—— 别抢主色。 */
.tc-tag-dim { background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.18)); color: var(--dsw-alias-label-secondary, #666); }
/* 「指挥」角标 = 主智能体。刻意用**描边**而不是实心主色填充：
   实心会和发言人那个 .tc-tag 撞成一样的视觉重量，而这两个是完全不同的概念
   （发言人是"你"，主智能体是"团队里负责指挥的那个 AI"）。 */
.tc-tag-lead { background: transparent; border: 1px solid var(--dsw-alias-brand-primary, #4c8dff); color: var(--dsw-alias-brand-primary, #4c8dff); }
/* 「打开对话」：成员就是一个独立会话窗口，这是回到它的入口。
   用主色描边把它从旁边低调的「编辑/移除」里拎出来 —— 它是这一行最常用的动作。 */
.tc-roster-open { flex: 0 0 auto; height: 22px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-state-business-primary, #247bbf); font-size: 11px; cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.tc-roster-open:hover { background: var(--dsw-alias-bg-base, #fff); box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary, #247bbf); }
.tc-roster-open:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 1px; }
.tc-roster-edit { flex: 0 0 auto; height: 22px; padding: 0 7px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary, #777); font-size: 11px; cursor: pointer; transition: background 120ms ease, color 120ms ease; }
/* 发言人自己的名字 + 职责（成员窗口顶部那一行）。
   单行省略：成员名可能很长，别把头部挤变形。 */
.tc-lineage { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; max-width: 100%; }
.tc-lineage-name { font-weight: 510; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-lineage-duty { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 独立设置页的外壳（settings.section 那一格的内容区）。 */
.tc-setting-page { display: flex; flex-direction: column; gap: 18px; width: 100%; }
/* 「发送到团队」里「所有人」那一行的图标位（没有成员资料可查，别去查 profile）。 */
.tc-compose-all { flex: 0 0 auto; width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); color: var(--dsw-alias-label-secondary, #777); font-size: 12px; }
/* 「发送到团队」的投递回执。
   为什么必须有：宿主是**异步投递**的，投递失败**不会**抛错（只体现在
   delivered[].ok === false）—— 没有回执时用户点了发送，界面上什么都不发生，
   只能以为功能坏了。（写 CSS 注释时连反引号都别带，会提前终结模板串。） */
.tc-compose-note { flex: 0 0 auto; max-width: 220px; margin-left: 4px; padding: 1px 6px; border-radius: 5px; font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); color: var(--dsw-alias-label-secondary, #666); }
.tc-compose-note[data-kind="ok"] { background: var(--dsw-alias-state-success-primary, var(--dsw-alias-state-business-primary, #247bbf)); color: #fff; }
.tc-compose-note[data-kind="error"] { background: var(--dsw-alias-state-error-primary, #c33); color: #fff; }
.tc-roster-edit:hover { background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1a1a1a); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.tc-roster-edit:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 1px; }
/* 「移除」：平时低调，等二次确认时才变红（不可逆动作要看得见）。 */
.tc-roster-remove { flex: 0 0 auto; height: 22px; padding: 0 7px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary, #777); font-size: 11px; cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.tc-roster-remove:hover { background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-state-error-primary, #c33); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.tc-roster-remove[data-confirm="true"] { background: var(--dsw-alias-state-error-primary, #c33); color: #fff; }
/* ── 成员资料编辑器 ──────────────────────────────────────── */
.tc-editor { display: flex; flex-direction: column; gap: 8px; padding: 8px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.07)); }
.tc-editor-title { font-size: 12px; font-weight: 600; }
.tc-field { display: flex; flex-direction: column; gap: 4px; }
.tc-field-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
/* 字段下方的辅助说明（如「初始任务」那段） */
.tc-field-hint { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #aaa); }
.tc-field-row { display: flex; align-items: center; gap: 6px; }
/* 头像形态切换（emoji / 文字 / 图片）—— 分段控件。 */
.tc-avatar-kinds { display: inline-flex; gap: 2px; padding: 2px; border-radius: 7px; background: var(--dsw-alias-bg-base, #fff); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127,127,127,.25)); }
.tc-avatar-kind { height: 22px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary, #777); font-size: 11px; cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.tc-avatar-kind[data-active="true"] { background: var(--dsw-alias-brand-primary, #247bbf); color: #fff; }
.tc-avatar-kind:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 1px; }
/* 文件输入隐藏，由「选择图片」按钮代理点击。 */
.tc-file { display: none; }
.tc-avatar-image-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tc-avatar-image-row .tc-editor-note { flex: 1 1 100%; }

/* 输入框黑底 + 可见光标 —— 与「输入框融入 dialog frame」的既定 UI 规范一致。 */
.tc-input { flex: 1 1 auto; min-width: 0; box-sizing: border-box; height: 26px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius: 6px; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1a1a1a); font-size: 12px; caret-color: var(--dsw-alias-label-primary, #1a1a1a); }
.tc-input::placeholder { color: var(--dsw-alias-label-tertiary, #aaa); }
.tc-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary, #247bbf); }
/* 多行输入（专属指令用）。input 的固定 height 不适用，改回 auto。 */
.tc-textarea { height: auto; min-height: 62px; padding: 6px 8px; line-height: 1.5; resize: vertical; font-family: inherit; }
.tc-editor-note { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary, #888); }
.tc-editor-actions { display: flex; align-items: center; gap: 6px; padding-top: 2px; }
.tc-btn { height: 26px; padding: 0 10px; border: 0; border-radius: 6px; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1a1a1a); font-size: 12px; cursor: pointer; box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.tc-btn:disabled { opacity: .5; cursor: default; }
.tc-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 1px; }
.tc-btn-ghost { box-shadow: none; color: var(--dsw-alias-label-secondary, #777); }
.tc-btn-danger { box-shadow: none; color: var(--dsw-alias-state-error-primary, #d9534f); }
.tc-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-state-error-secondary, rgba(217,83,79,.12)); }
.tc-btn-primary { margin-left: auto; background: var(--dsw-alias-brand-primary, #247bbf); color: #fff; box-shadow: none; }
/* ── 输入框工具栏左侧的「发送到团队」 ────────────────────────
 * 宿主 composer 的工具栏是行内 flex，这里只负责「按钮 + 下方浮层」的定位。
 * 浮层用 absolute 而不是 portal —— 'conversation.input.left' 的祖先链里没有
 * overflow 裁剪（有裁剪的是头部，那边才需要 portal）。 */
.tc-compose { position: relative; display: inline-flex; align-items: center; }
.tc-compose-panel { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 2147483000; box-sizing: border-box; width: 280px; max-height: min(60vh, 420px); padding: 10px; display: flex; flex-direction: column; gap: 6px; border: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: 10px; background: var(--dsw-alias-bg-base, #fff); box-shadow: 0 8px 28px rgba(0,0,0,.16); color: var(--dsw-alias-label-primary, #1a1a1a); }
.tc-roster-pick { width: 100%; box-sizing: border-box; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.tc-roster-pick[data-active="true"] { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
.tc-roster-pick:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 1px; }
/* ── 设置页「AI 成员配置」区块 ────────────────────────────────
 * 注意：本段注释里**不能出现反引号**（会提前终结 CSS 模板串，
 * node --check 查不出来，只在求值时炸成 ReferenceError）。
 * .tc-setting 自带的是「标题 + 右侧开关」的横向布局（flex + space-between），
 * 这个区块是竖排卡片，所以显式改回 block，否则内容和按钮会被挤成一行。 */
.tc-setting-block { display: block; }
.tc-config-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.tc-config-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); }
.tc-config-main { min-width: 0; flex: 1 1 auto; }
.tc-config-name { font-size: 13px; line-height: 18px; }
.tc-config-key { color: var(--dsw-alias-label-secondary, #888); font-size: 11px; opacity: .8; }
.tc-config-sub { color: var(--dsw-alias-label-secondary, #888); font-size: 12px; line-height: 18px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-config-edit { flex: 0 0 auto; }
.tc-config-add { margin-top: 10px; }
/* ── 成员「交替」（交接 / succession）─────────────────────────
 * 注意：本段注释里**不能出现反引号**（会提前终结 CSS 模板串）。
 * 提示条本身就够说明「会发生什么」，所以不另加图标：动的是会话与身份，
 * 加个闪电图标只会显得轻率。 */
.tc-succession-note { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary, #888); }
.tc-succession-warn { font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-warn-primary, #d69e2e); }
/* 归档 / 保留 二选一：两个链接式按钮 + 一枚「当前」标记。
 * 不用开关控件是对的 —— 这里选的不是一个开关的开关状态，
 * 而是两件**后果不同**的事，写成一行可点文字更好读也更难误点。 */
.tc-succession-choice { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.tc-succession-opt { padding: 0; border: 0; background: transparent; color: var(--dsw-alias-state-business-primary, #247bbf); font: inherit; font-size: 12px; cursor: pointer; }
.tc-succession-opt[data-active="true"] { color: var(--dsw-alias-label-primary, #1a1a1a); font-weight: 600; cursor: default; }
.tc-succession-opt[data-active="true"]::after { content: " ✓"; }
.tc-succession-opt:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #247bbf)); outline-offset: 1px; }
/* 交接说明预览：两列（标题 / 正文）。max-height + overflow 让长说明不把面板撑爆。 */
.tc-handover { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); }
.tc-handover-row { display: flex; gap: 8px; font-size: 11px; line-height: 16px; }
.tc-handover-key { flex: 0 0 auto; min-width: 84px; color: var(--dsw-alias-label-tertiary, #aaa); }
.tc-handover-val { flex: 1 1 auto; min-width: 0; color: var(--dsw-alias-label-primary, #1a1a1a); }
.tc-handover-body { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary, #888); white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow-y: auto; }
/* 尊重系统的"减少动态效果"设置 —— 动画全关，但保留最终态。 */
@media (prefers-reduced-motion: reduce) {
  .tc-panel, .tc-stage, .tc-switch-thumb { animation: none; transition: none; }
}
`;

		/**
		 * 从 Remote 应答里取值。
		 *
		 * 所有 `ctx.remote.*` 方法返回的都是 `RemoteAnswer` 包（`{ok, value, error}`），
		 * **不是**裸结果。官方插件管理页的写法就是先判 `ok` 再取 `value`。
		 * 直接把应答当数组/对象用会永远拿不到数据。
		 */
		function unwrapAnswer(answer) {
			if (answer !== null && typeof answer === "object" && typeof answer.ok === "boolean") {
				if (answer.ok !== true) {
					throw new Error(answer.error?.message ?? "remote call failed");
				}
				return answer.value;
			}
			// 兜底：若某天桥层改为直返，也能work。
			return answer;
		}

		/**
		 * 开关控件。
		 *
		 * 照抄 host primitive 的形态，而不是 `require('@deepseek-ai/dsh-client-ui-primitives')`：
		 * 官方 practices 明令禁止把 Harness Client 包当模块加载 —— 它们随版本变化、
		 * plain-JS 没有类型检查，一个抛错的组件会让整个插槽条目变空白
		 * （console: `slot entry crashed in '<slot>'`）。
		 *
		 * 保留的行为：`role="switch"` + `aria-checked`（外观键在 aria 属性上，
		 * 视觉态与读屏态不会不一致）、`:focus-visible` 焦点环、disabled 半透明。
		 *
		 * @param props.checked - 当前状态；完全受控。
		 * @param props.onChange - 点击请求的目标状态。
		 * @param props.label - 可访问名。
		 * @param props.disabled - 写入在途时由调用方置位。
		 * @param props.title - 悬停说明，通常是为什么被锁。
		 * @returns 开关元素。
		 */
		function TeamSwitch({ checked, onChange, label, disabled = false, title }) {
			return react.createElement(
				"button",
				{
					type: "button",
					role: "switch",
					"aria-checked": checked,
					"aria-label": label,
					title,
					disabled,
					className: "tc-switch",
					onClick: () => onChange(!checked),
				},
				react.createElement("span", { className: "tc-switch-thumb" }),
			);
		}

		/**
		 * Agent Teams bundle 的状态与启停。
		 *
		 * 抽出来给**两个地方**共用：
		 * - 设置页那一行（`settings.general.item` → `TeamsToggleRow`）
		 *
		 * 为什么要有第二处：用户报过「提示未启用团队服务，但设置界面里找不到入口」。
		 * 让人为了开一个开关去翻设置页本身就不合理 —— **报错的地方就该能直接开**。
		 *
		 * @param remote - `remote.pluginManager`（缺失时降级成 absent）。
		 */
		function useTeamsBundle(remote) {
				const [row, setRow] = react.useState(null);
				const [busy, setBusy] = react.useState(false);
				const [outcome, setOutcome] = react.useState(null);

				const refresh = react.useCallback(async () => {
						if (remote === undefined || remote === null) {
								setRow(false);
								return;
						}
						try {
								const value = unwrapAnswer(await remote.listBundles());
								setRow(
										Array.isArray(value)
												? (value.find((item) => item.name === TEAM_BUNDLE) ?? false)
												: false,
								);
						} catch (error) {
								setRow({ error: { code: error?.message ?? "remote-error" } });
						}
				}, [remote]);

				react.useEffect(() => {
						void refresh();
				}, [refresh]);

				// 注意：**不能用 `installed` 判断「能否启用」**。
				// 对随 DSH 一起分发的可选 bundle（OPTIONAL_BUNDLES 成员），
				// listBundles 返回的 `installed` 来自 profile 的 `dependencies` 字段，
				// 而这类 bundle 从不写进 dependencies —— 它们是靠安装锚点解析的。
				// 实测本机：agent-team-profile 的 installed=false，但 resolvable=true、
				// 兼容性通过、patch 可读，启用完全没问题。
				//
				// 真正的「不可用」只有两种情况：
				//   1. listBundles 里压根没有这一行（row === false）
				//   2. 该行带 `error`（not-bundle / 解析失败 / 兼容性硬失败）
				const absent = row === false;
				const errored = row !== null && row !== false && row.error !== undefined;
				const enabled = row !== null && row !== false && row.enabled === true;
				const loading = row === null;
				const usable = !loading && !absent && !errored;

				/**
				 * 开 / 关这个 bundle。
				 *
				 * @param next - 目标状态。
				 * @returns 官方 `ChangeResult.application`，失败返回 null。
				 */
				const toggle = react.useCallback(
						async (next) => {
								if (remote === undefined || remote === null) {
										setOutcome({ application: "failed", error: new Error("remote 不可用") });
										return null;
								}
								setBusy(true);
								setOutcome(null);
								try {
										const result = unwrapAnswer(await remote.setBundleEnabled(TEAM_BUNDLE, next));
										const application = result?.application ?? "failed";
										setOutcome({ application, result });
										await refresh();
										return application;
								} catch (error) {
										setOutcome({ application: "failed", error });
										return null;
								} finally {
										setBusy(false);
								}
						},
						[remote, refresh],
				);

				return { absent, errored, enabled, loading, usable, busy, outcome, row, toggle, refresh };
		}

		/** 官方 `ChangeResult.application` → 本地化文案 key。 */
		const TEAMS_APPLICATION_KEYS = {
				applied: "applied",
				"restart-required": "restartRequired",
				overridden: "overridden",
				cancelled: "cancelled",
		};

		/**
		 * 把 `outcome` 转成一行可读的结果文案。两个宿主共用。
		 *
		 * @param t - 本地化函数。
		 * @param outcome - `useTeamsBundle` 的 `outcome`。
		 * @returns `{kind, text}`，无结果时返回 null。
		 */
		function teamsOutcomeMessage(t, outcome) {
				if (outcome === null || outcome === undefined) return null;
				const key = TEAMS_APPLICATION_KEYS[outcome.application];
				if (key !== undefined) return { kind: "info", text: t(`settings.teams.${key}`) };
				return {
						kind: "error",
						text: `${t("settings.teams.failed")}：${
								outcome.result?.error?.diagnostic ??
								outcome.result?.error?.code ??
								outcome.error?.message ??
								outcome.application
						}`,
				};
		}

		/**
		 * 「官方智能体团队」开关行（设置页）。
		 *
		 * ## 这块现在是个**说明牌**，不是一个必要开关
		 *
		 * 成员改成独立根会话之后（见 `lib/member-runtime.js`），本插件
		 * **一行代码都不再依赖官方 Agent Teams bundle** ——
		 * 成员名单、消息投递、时间线全部自己维护。
		 *
		 * 所以这一行的完整意思应该是：「这个是官方扩展，我们不用它，
		 * 关掉不影响任何功能」。旧文案却写着「关闭后聊天室收不到任何消息」，
		 * 那是旧机制的遗留 —— 用户看到这句就不敢关了（2026-09-27 反馈）。
		 *
		 * ## 为什么还留着这个开关
		 *
		 * 它管的是**官方 bundle**，不只是我们在用 —— 用户可能在别的场合
		 * 需要官方那套子智能体。我们只是把「关掉安全」这件事说明白。
		 *
		 * `remote` / `remote.pluginManager` 由 `ctx.slots.register` 的 `inject` 工厂补进来
		 * —— 官方 developer-tools 行就是这么做的。
		 */
		function TeamsToggleRow({ t, remote }) {
				const { absent, errored, enabled, loading, usable, busy, outcome, row, toggle } =
						useTeamsBundle(remote);

				const statusText = loading
						? t("settings.teams.loading")
						: absent
								? t("settings.teams.notInstalled")
								: errored
										? `${t("settings.teams.unavailable")}（${row.error?.code ?? "error"}）`
										: null;

				const message = teamsOutcomeMessage(t, outcome);

				return react.createElement(
						"div",
						{ className: "tc-setting" },
						react.createElement(
								"div",
								{ className: "tc-setting-body" },
								react.createElement("div", { className: "tc-setting-title" }, t("settings.teams.title")),
								react.createElement("div", { className: "tc-setting-desc" }, t("settings.teams.desc")),
								react.createElement(
										"div",
										{ className: "tc-setting-note" },
										`ⓘ ${t("settings.teams.sideEffect")}`,
								),
								react.createElement("div", { className: "tc-setting-note" }, t("settings.teams.legacy")),
								statusText === null
										? null
										: react.createElement(
												"div",
												{ className: "tc-setting-note", "data-state": "status" },
												statusText,
											),
								// 当前状态一句话说清 —— 这是用户唯一真正需要的那条信息。
								loading || absent || errored
										? null
										: react.createElement(
												"div",
												{
														className: "tc-setting-note",
														"data-state": enabled ? "on" : "off",
												},
												enabled ? t("settings.teams.on") : t("settings.teams.off"),
											),
								message === null
										? null
										: react.createElement(
														"div",
														{ className: "tc-setting-msg", "data-kind": message.kind, role: "alert" },
														message.text,
													),
								),
						react.createElement(TeamSwitch, {
								checked: enabled,
								disabled: busy || loading || !usable,
								label: t("settings.teams.title"),
								onChange: (next) => void toggle(next),
						}),
				);
		}



		/**
		 * 官方 Agent 预设 id → 本地化显示名。
		 *
		 * 官方 `agentPresets.list()` 对随 DSH 附带的这几个预设**只返回 id 与 order**
		 * （`name` / `description` 是空的，实测 `--dump-config` 里 preset-standard
		 * 的 config 只有 `id` + `order` + `plugins`），显示名在官方客户端自己的字典里。
		 * 我们不去跨命名空间取 —— 这里自己维护一张小表，未知 id 回退成 id。
		 */
		const PRESET_LABEL_KEYS = {
			standard: "preset.standard",
			ptc: "preset.ptc",
			minimal: "preset.minimal",
			cordis: "preset.cordis",
		};

		/**
		 * @param t - 本地化函数。
		 * @param preset - 宿主返回的预设行 `{id, name}`。
		 * @returns 显示名。
		 */
		function presetLabel(t, preset) {
			const key = PRESET_LABEL_KEYS[preset?.id];
			if (key !== undefined) return t(key);
			return preset?.name ?? preset?.id ?? "";
		}


		/**
		 * 独立的设置页（设置面板左侧导航多一项）。
		 *
		 * 原来是挂在「设置 → 通用」里的（`settings.general.item`），用户明确要求
		 * 独立成页。官方给的入口是 **`settings.section`** —— 这个 `list` 槽的每个条目
		 * 就是左侧导航的一行，官方 general / models / plugins / account /
		 * agent-presets 都是这么挂的；注册进去会自动出现导航项与独立内容区，
		 * 完全不用碰官方代码。
		 *
		 * ⚠ 一旦注册了这个，就**不要**再往 `settings.general.item` 里塞东西 ——
		 * 否则同一个开关会出现两次。
		 */
		function TeamChatSettingsSection({ t, remote, uiWorkspace }) {
			return react.createElement(
				"div",
				{ className: "tc-setting-page" },
				// 「我」放最前面 —— 用户之前找不到自己（`lead` 混在 AI 成员列表里）。
				react.createElement(SpeakerProfileBlock, { t }),
				react.createElement(TeamsToggleRow, { t, remote }),
				// **收编语义**：成员 = 玩家已打开的对话窗口。建成员不再有独立表单 ——
				// 引导用户回到想收编的那个窗口，从右上角「成员」里操作。
				react.createElement(
					"div",
					{ className: "tc-setting tc-setting-block" },
					react.createElement(
						"div",
						{ className: "tc-setting-body" },
						react.createElement("div", { className: "tc-setting-title" }, t("settings.new.title")),
						react.createElement("div", { className: "tc-setting-desc" }, t("settings.adoptGuide")),
					),
				),
				react.createElement(MembersConfigRow, { t }),
			);
		}

		/**
		 * 设置页里的「我（发言人）」区块 —— 只改**你自己的**显示名和头像。
		 *
		 * ## 为什么要单独开一块
		 *
		 * 实测（2026-09-27，起 web harness 截图确认）：用户**找不到**自己在哪改名字/头像。
		 * 资料库里 `lead` 那条是存在的、也能编辑，但它显示成 `MoYUCSC lead`
		 * 混在「AI 成员配置」列表里，而那块描述只讲「职责与专属指令 / 技能」——
		 * 没有任何线索指向"这里能改我自己的头像"。
		 *
		 * 所以这里单开一块，只回答一个问题：**你在聊天室里长什么样**。
		 * 职责 / 专属指令 / 删除资料都不出现 —— 那是 AI 成员的概念。
		 */
		function SpeakerProfileBlock({ t }) {
			const [members, reload] = useMembers();
			const [editing, setEditing] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const profile = members?.[SPEAKER_KEY] ?? null;

			// 编辑态：复用成员编辑器，但走 `speaker` 形态（只有名字 + 头像）。
			if (editing) {
				return react.createElement(
					"div",
					{ className: "tc-setting tc-setting-block" },
					react.createElement(MemberEditor, {
						memberKey: SPEAKER_KEY,
						label: SPEAKER_KEY,
						profile,
						t,
						speaker: true,
						onDone: (message) => {
							setEditing(false);
							void reload();
							setNotice(typeof message === "string" ? message : t("members.saved"));
						},
					}),
				);
			}

			return react.createElement(
				"div",
				{ className: "tc-setting tc-setting-block" },
				react.createElement(
					"div",
					{ className: "tc-setting-body" },
					react.createElement("div", { className: "tc-setting-title" }, t("settings.me.title")),
					react.createElement("div", { className: "tc-setting-desc" }, t("settings.me.desc")),
					notice === null
						? null
						: react.createElement(
								"div",
								{ className: "tc-setting-msg", "data-kind": "ok", role: "status" },
								notice,
							),
				),
				react.createElement(
					"div",
					{ className: "tc-config-row" },
					react.createElement(Avatar, {
						memberKey: SPEAKER_KEY,
						profile: { displayName: profile?.displayName, avatar: profile?.avatar },
						size: 32,
					}),
					react.createElement(
						"div",
						{ className: "tc-config-main" },
						react.createElement(
							"div",
							{ className: "tc-config-name" },
							typeof profile?.displayName === "string" && profile.displayName !== ""
								? profile.displayName
								: t("settings.me.unnamed"),
						),
						react.createElement(
							"div",
							{ className: "tc-config-sub" },
							profile?.avatar === undefined || profile?.avatar === null
								? t("settings.me.avatarDefault")
								: t("settings.me.avatarCustom"),
						),
					),
					react.createElement(
						"button",
						{
							type: "button",
							className: "tc-btn tc-btn-ghost tc-config-edit",
							onClick: () => {
								setNotice(null);
								setEditing(true);
							},
						},
						t("settings.me.edit"),
					),
				),
			);
		}

		/**
		 * 设置页里的「AI 成员配置」区块。
		 *
		 * ## 为什么放在设置里
		 *
		 * 用户的要求：「不同的 AI 应用可能需要使用不同的技能文件，以及其他配置项，
		 * 这些都需要在设置里进行调整。」
		 *
		 * 聊天室里的成员菜单是**顺手**编辑用的（改个名字、换个头像）；
		 * 真正的「配置」——职责、专属指令 / 技能——应该在设置页集中管理，
		 * 而且不该依赖当前打开的是哪个会话。
		 *
		 * 所以这里只读**本地成员资料**（`useMembers`，走 REST + SSE，不需要 session
		 * 上下文），列出所有配置过的成员，就地编辑。
		 *
		 * ── 为什么还有「新增成员资料」 ──────────────────────────────
		 *
		 * 成员资料此前只在两个时机产生：聊天室里「添加 AI 成员」创建的 teammate，
		 * 或者在成员菜单里手动编辑过。结果是**全新环境进设置页只能看到一句"还没有
		 * 成员"，配置无从下嘴** —— 而「先配好指令、再让 Lead 按名字创建」才是
		 * 设置页该有的用法。所以这里补一个「先建资料」的入口，只写 MemberStore，
		 * **不创建任何窗口**（创建窗口是聊天室那边「添加 AI 成员」的事）。
		 *
		 * ⚠ 「专属指令」是**创建期**配置：它会被拼进 teammate 创建时的第一条消息。
		 * 改了已经有窗口的成员，需要重建该成员才会生效 —— 界面上必须讲清楚，
		 * 否则用户会以为改完立刻有效。
		 */
		function MembersConfigRow({ t }) {
			const [members, reload] = useMembers();
			const [editing, setEditing] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			const [adding, setAdding] = react.useState(false);
			const [draft, setDraft] = react.useState({ key: "", duty: "", instructions: "" });
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			// ⚠ 把「发言人」(`lead`) **排掉** —— 他自己的名字/头像是上面
			// 「我（发言人）」那一块的事。留在这里会出现两条入口、两处语义，
			// 而且这一块的描述讲的是「职责与专属指令」，跟他完全不搭。
			const rows = Object.entries(members ?? {})
				.filter(([key]) => key !== SPEAKER_KEY)
				.sort((a, b) => a[0].localeCompare(b[0]));

			/**
			 * 编辑器收工回调。
			 *
			 * `MemberEditor` 保存和删除都会调这里，且**带一句对应的文案** ——
			 * 所以要透传，不能硬写"已保存"（删完显示"已保存"很蠢）。
			 *
			 * @param message - 完成提示；传 null（取消）时退回默认文案。
			 */
			const done = (message) => {
				setEditing(null);
				setError(null);
				void reload();
				setNotice(typeof message === "string" ? message : t("settings.members.saved"));
			};

			/**
			 * 新增一条成员资料（**不创建窗口**）。
			 *
			 * 校验规则与宿主侧 `/__teamchat/spawn` 的 `MEMBER_NAME` 严格一致：
			 * 拼接专属指令发生在 spawn 时，**按成员名查表**，名字对不上这条资料
			 * 就永远不会被用到。所以这里宁可拦死，也不让人存一个用不上的键。
			 */
			const submitDraft = async () => {
				if (busy) return;

				const key = draft.key.trim();
				if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key) || key === "lead") {
					setError(t("settings.members.badKey"));
					return;
				}
				if (members?.[key] !== undefined) {
					setError(t("settings.members.exists"));
					return;
				}
				// 职责非空是**官方要求**（`spawnTeammate` 的 `description` 必填），
				// 空职责的资料配了也创建不了成员，先拦。
				if (draft.duty.trim() === "") {
					setError(t("settings.members.needDuty"));
					return;
				}

				setBusy(true);
				setError(null);
				try {
					await membersApi.save(key, {
						duty: draft.duty.trim(),
						instructions: draft.instructions.trim(),
					});
					setDraft({ key: "", duty: "", instructions: "" });
					setAdding(false);
					await reload();
					setNotice(t("settings.members.added"));
				} catch (failure) {
					// 同上：`failure?.message` 是宿主原文（可能中文），
					// 一律先按码查字典（见 `saveFailureText`）。
					setError(saveFailureText(t, failure));
				} finally {
					setBusy(false);
				}
			};

			// 编辑态：复用成员编辑器。它只依赖本地资料，不需要 session 上下文。
			if (editing !== null) {
				return react.createElement(
					"div",
					{ className: "tc-setting tc-setting-block" },
					react.createElement(MemberEditor, {
						memberKey: editing,
						label: editing,
						description: undefined,
						profile: members?.[editing] ?? null,
						t,
						onDone: done,
					}),
				);
			}

			/** 新增表单（同一个 `adding` 状态里既显示表单也显示错误）。 */
			const addForm = react.createElement(
				"div",
				{ className: "tc-editor tc-config-add" },
				react.createElement("div", { className: "tc-editor-title" }, t("settings.members.add")),
				react.createElement("div", { className: "tc-editor-note" }, t("settings.members.addHint")),
				react.createElement(
					"label",
					{ className: "tc-field" },
					react.createElement("span", { className: "tc-field-label" }, t("settings.members.key")),
					react.createElement("input", {
						className: "tc-input",
						type: "text",
						value: draft.key,
						maxLength: 64,
						autoFocus: true,
						placeholder: t("settings.members.keyPlaceholder"),
						onChange: (event) => setDraft({ ...draft, key: event.target.value }),
					}),
					react.createElement("div", { className: "tc-field-hint" }, t("settings.members.keyHint")),
				),
				react.createElement(
					"label",
					{ className: "tc-field" },
					react.createElement("span", { className: "tc-field-label" }, t("members.duty")),
					react.createElement("input", {
						className: "tc-input",
						type: "text",
						value: draft.duty,
						maxLength: 200,
						placeholder: t("members.dutyPlaceholder"),
						onChange: (event) => setDraft({ ...draft, duty: event.target.value }),
					}),
				),
				react.createElement(
					"label",
					{ className: "tc-field" },
					react.createElement("span", { className: "tc-field-label" }, t("members.instructions")),
					react.createElement("textarea", {
						className: "tc-input tc-textarea",
						value: draft.instructions,
						rows: 3,
						maxLength: 4000,
						placeholder: t("members.instructionsPlaceholder"),
						onChange: (event) => setDraft({ ...draft, instructions: event.target.value }),
					}),
					react.createElement("div", { className: "tc-field-hint" }, t("members.instructionsHint")),
				),
				error === null
					? null
					: react.createElement("div", { className: "tc-setting-msg", "data-kind": "error", role: "alert" }, error),
				react.createElement(
					"div",
					{ className: "tc-editor-actions" },
					react.createElement(
						"button",
						{
							type: "button",
							className: "tc-btn tc-btn-ghost",
							disabled: busy,
							onClick: () => {
								setAdding(false);
								setError(null);
								setDraft({ key: "", duty: "", instructions: "" });
							},
						},
						t("members.cancel"),
					),
					react.createElement(
						"button",
						{ type: "button", className: "tc-btn tc-btn-primary", disabled: busy, onClick: () => void submitDraft() },
						busy ? t("members.saving") : t("members.save"),
					),
				),
			);

			return react.createElement(
				"div",
				{ className: "tc-setting tc-setting-block" },
				react.createElement(
					"div",
					{ className: "tc-setting-body" },
					react.createElement("div", { className: "tc-setting-title" }, t("settings.members.title")),
					react.createElement("div", { className: "tc-setting-desc" }, t("settings.members.desc")),
					notice === null
						? null
						: react.createElement(
								"div",
								{ className: "tc-setting-msg", "data-kind": "ok", role: "status" },
								notice,
							),
					rows.length === 0
						? react.createElement("div", { className: "tc-setting-note" }, t("settings.members.empty"))
						: react.createElement(
								"div",
								{ className: "tc-config-list" },
								...rows.map(([key, profile]) =>
									react.createElement(
										"div",
										{ className: "tc-config-row", key },
										react.createElement(
											"div",
											{ className: "tc-config-main" },
											react.createElement(
												"div",
												{ className: "tc-config-name" },
												profile?.displayName ?? key,
												profile?.displayName === undefined
													? null
													: react.createElement("span", { className: "tc-config-key" }, ` ${key}`),
											),
											react.createElement(
												"div",
												{ className: "tc-config-sub" },
												profile?.instructions === undefined || profile.instructions === ""
													? t("settings.members.noInstructions")
													: profile.instructions,
											),
										),
										react.createElement(
											"button",
											{
												type: "button",
												className: "tc-btn tc-btn-ghost tc-config-edit",
												onClick: () => {
													setNotice(null);
													setError(null);
													setEditing(key);
												},
											},
											t("settings.members.edit"),
										),
									),
								),
							),
				),
				adding
					? addForm
					: react.createElement(
							"button",
							{
								type: "button",
								className: "tc-btn tc-config-add",
								onClick: () => {
									setNotice(null);
									setError(null);
									setAdding(true);
								},
							},
							t("settings.members.add"),
						),
			);
		}

		/**
		 * 输入框工具栏左侧的「发送到团队」入口 —— 注册到
		 * `conversation.input.left`（`list` 槽，"Compact controls at the left of
		 * the composer tool row"）。
		 *
		 * ── 为什么是这里 ────────────────────────────────────────────
		 *
		 * 用户要「上传文件、上传话语、@某个智能体」，但**输入框不自绘**。
		 * 官方 composer 已经自带文件上传（`conversation.input.attachments`
		 * 由 `client-ui-attachment` 占着）与 `@` 路径补全。我们只需要把
		 * **一个「发给谁」的选择器**挂上去，然后往官方 draft 里写文本。
		 *
		 * ── 关键：拿到官方 draft ───────────────────────────────────
		 *
		 * `inputActions` 是标准 props，不经过我们的 `inject` 工厂，
		 * 由 renderer 直接注进组件（见 `conversation.input.left` 的
		 * `standardProps`）。官方 `InputActions` 里 `setDraft` 是**函数式**
		 * 更新：`setDraft(prev => next)` —— 所以并发编辑（用户同时在打字、
		 * 别的插件同时改 draft）不会互相覆盖。写成 `setDraft(text)` 是错的。
		 *
		 * ── 不提「发消息 API」是刻意的 ─────────────────────────────
		 *
		 * 宿主侧确实有 `ctx.sessionActions`，但没有公开的「以 team member 身份
		 * 发消息」入口。走非官方内部 API 会把插件钉死在某个 DSH 版本上，
		 * 所以这里只在**官方 draft** 里落一个清晰可读的指令文本 —— 用户自己按
		 * 发送，走的是官方那条通路，Team 协议照常工作。
		 */
		function TeamCompose({ t, useSession, useSessions, inputActions, sessionId }) {
			const [open, setOpen] = react.useState(false);
			const [active, setActive] = react.useState(0);
			const [members] = useMembers();
			/**
			 * 当前选定的发送范围：
			 * `null` = 还没选（普通对话，不额外投递给成员）
			 * `""`   = 所有人　`"名字"` = 只发给那个成员
			 *
			 * ⚠ 读的是**模块级共享状态**（`useScopeTarget`），不是本地 state：
			 * `@` 提及也会改它。各存各的会出现「我从 @ 定了人，面板还显示所有人」
			 * —— 界面与真实状态不一致，本项目最忌讳这个。
			 */
			const scope = useScopeTarget(sessionId);

			/**
			 * 最近一次的投递回执（宿主广播的 `team-send` 里那条）。
			 *
			 * 存**原始 payload**，文案在渲染时再算 —— SSE 的订阅 effect 是
			 * `[]` 依赖，闭包里拿不到最新的 `t` / `members`，在那儿拼文案会拼成旧的。
			 *
			 * 为什么必须有它：宿主是**异步投递**的，投递失败**不会**抛错
			 * （只体现在 `delivered[].ok === false`）。没有回执时用户点了发送，
			 * 界面上什么都不发生 —— 只能以为功能坏了。
			 */
			const [receipt, setReceipt] = react.useState(null);
			const rootRef = react.useRef(null);

			// 门控按**所在视图**（是否停在聊天室 tab），不按会话类型。
			//
			// ⚠ 这里是实锤过的 bug 修复点。`conversation.input.left` 是 `list` 槽，
			// 条目按会话 filter 是不存在的 —— 注册一次就全局生效
			// （`scope` 只是 store-handle 的校验声明，见 slots/lib/index.js:94）。
			// 所以「切回对话按钮还在、还写着"发送到团队"」只能靠在
			// **组件内部**判视图后返回 null 来解决 —— 与权限影子不同，
			// `list` 槽整槽不渲染不会遮挡别人（同槽其它 id 各占各的格子）。
			const inChatRoom = useChatRoomActive();
			const { leadSessionId } = useTeamContext(useSession, useSessions, undefined);
			// 上面的 SSE 订阅 effect 是 `[]` 依赖，闭包里只会拿到**首次渲染**的
			// `leadSessionId`。判「这帧回执是不是本会话的」必须读最新值，所以用 ref。
			const leadSessionIdRef = react.useRef(leadSessionId);
			leadSessionIdRef.current = leadSessionId;
			// 名单问宿主要 —— 成员是独立会话，客户端投影里没有它们。
			// 「已移除」名单顺带一起取回。
			const [room, reloadRoom] = useRoomRoster(leadSessionId);
			const hidden = room.removed;
			// 只列**这个聊天室里真实存在、且没被移除**的成员。
			const roster = rosterOf(room.members).filter((item) => !hidden.includes(item.key));

			// 「所有人」永远排第一 —— 它是默认范围（广播）。
			// 用 `options` 而不是直接改 roster：roster 还有别处（成员菜单）在用。
			//
			// ⚠ 名单**只认真实成员**（宿主成员库），不拿本地成员资料表兜底：
			//    资料表是按名字存、**不区分聊天室**的全局映射，
			//    拿它凑数会列出不属于这个房间的智能体。
			//
			// ⚠ 也**不列发言人自己**：消息本来就是从这个会话发出去的，
			//    这个选择器是「**额外**投给谁」，列自己只会让人以为能"发给自己"。
			const options = react.useMemo(
				() => [{ key: "__all__", label: t("compose.everyone"), isAll: true }, ...roster],
				[roster, t],
			);

			// `list` 槽按 `id` 分格子 —— 同一格子里可能已经有官方条目，
			// 用 id 反查自己的按钮，别把整个工具栏都关掉。
			const handleRef = react.useCallback(
				(node) => {
					rootRef.current = node?.closest(`[data-team-chat-entry=${JSON.stringify(MENTION_OVERLAY_ID)}]`) ?? node;
				},
				[],
			);

			react.useEffect(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					if (rootRef.current?.contains(event.target) === true) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			// 宿主把官方输入框那条消息投递完之后会广播 `team-send` —— 范围是**一次性**的，
			// 收到就复位，免得用户之后跟 Lead 的普通对话也被广播出去。
			//
			// 同一帧里还带着 `delivered[]`（每个成员的 `{name, ok, code?, error?}`）——
			// 那是**唯一**能知道「到底送到没有」的地方，别把它扔掉。
			react.useEffect(() => {
				let closed = false;
				let source = null;
				try {
					// ⚠ clientId 必须与其它订阅不同（服务端按 clientId 存连接，同 id 会互相顶掉）。
					source = new EventSource("/__teamchat/events?clientId=compose-scope");
					source.onmessage = (message) => {
						if (closed) return;
						try {
							const payload = JSON.parse(message.data);
							if (payload?.type !== "team-send") return;
							// 不是本会话的投递回执就跟我们无关（聊天室可以开好几个）。
							if (typeof leadSessionIdRef.current === "string" && payload.sessionId !== leadSessionIdRef.current) {
								return;
							}
							// 范围是一次性的：宿主投完就没用了。
							// ⚠ 改的是**共享状态**（`@` 也看这一份），不是本地 state。
							setScopeTarget(sessionId, null);
							setReceipt({
								target: typeof payload.target === "string" ? payload.target : "",
								delivered: Array.isArray(payload.delivered) ? payload.delivered : [],
							});
						} catch {
							/* 单帧坏掉忽略 */
						}
					};
				} catch {
					/* SSE 起不来就退化成「用户自己再选一次」 */
				}
				return () => {
					closed = true;
					source?.close();
				};
			}, []);

			// 每次拉开下拉都重取一次权威名单 —— 刚建的成员可能还没进客户端投影，
			// 用户点开的这一刻才是「我要选人了」的真实时机。
			react.useEffect(() => {
				if (!open) return;
				void reloadRoom();
			}, [open, reloadRoom]);

			/**
			 * 这一行能不能发。
			 *
			 * 官方 `resolveActiveMember()` 只认 `active` 的成员，
			 * 非 active（`provisioning` / `failed`）点下去必然失败 ——
			 * 与其让用户点完看到一个错误码，不如**在选项上就禁用**。
			 * `phase` 未知（客户端投影兜底行）按可用处理，交给宿主给准确回执。
			 */
			const readyOf = (item) =>
				item.isAll === true ||
				item.isLead === true ||
				item.phase === undefined ||
				item.phase === "active";

			/** 成员名的显示形式（优先用户配的显示名）。 */
			const shown = (name) => members[name]?.displayName ?? name;

			/**
			 * 把宿主的投递回执翻译成一句人话。
			 *
			 * 三种结果必须**分开说**：全送到 / 部分没送到 / 一个都没送到。
			 * 只报「已发送」是撒谎 —— 宿主那边失败只体现在 `delivered[].ok === false`。
			 *
			 * @returns `{kind, text}`；没有可报的内容时返回 null。
			 */
			const receiptText = () => {
				if (receipt === null) return null;
				const rows = receipt.delivered;
				if (rows.length === 0) return null;
				const ok = rows.filter((row) => row?.ok === true).length;
				const bad = rows.filter((row) => row?.ok !== true);
				if (bad.length === 0) {
					return receipt.target === ""
						? { kind: "ok", text: t("compose.sentAll", { count: ok }) }
						: { kind: "ok", text: t("compose.queued", { name: shown(receipt.target) }) };
				}
				const names = bad.map((row) => shown(row?.name ?? "?")).join("、");
				// ── 全失败 + 只发给一个人：把**宿主给的原因**说出来 ──────
				//
				// 这是最常见的失败形态（点名发给一个已经不叫这个名字的成员）。
				// 只印「未送达：某某」等于让用户自己去猜为什么。宿主的回执里
				// 有 `code`（稳定错误码）与 `error`（英文兜底），按码查字典拿
				// 本地化文案，查不到才用原文 —— 两者不同就都显示（原文一个字
				// 都不丢，中文用户也不用看英文句子才知道出了什么事）。
				if (ok === 0 && bad.length === 1 && receipt.target !== "") {
					const row = bad[0];
					const raw = typeof row?.error === "string" && row.error !== "" ? row.error : "";
					const localized = errorText(t, row?.code, row?.params, raw);
					if (localized !== null) {
						return {
							kind: "error",
							text:
								raw !== "" && raw !== localized
									? `${t("compose.sentNone", { names })} ${localized} — ${raw}`
									: `${t("compose.sentNone", { names })} ${localized}`,
						};
					}
				}
				return ok === 0
					? { kind: "error", text: t("compose.sentNone", { names }) }
					: { kind: "error", text: t("compose.sentPartial", { ok, failed: bad.length, names }) };
			};

			const pick = (item) => {
				if (!readyOf(item)) return;
				setOpen(false);
				// 上一次的投递回执先清掉 —— 否则会看着像这次的结果。
				setReceipt(null);
				// 不再往官方 draft 里写 `@名字`（那只是给 Lead 看的提示，
				// 消息根本到不了成员），而是把范围交给宿主 —— 等这条会话出现
				// **下一条真人消息**时，宿主按范围**真的投递**给成员。
				const target = item.isAll === true ? "" : item.label;
				void (async () => {
					try {
						// ⚠ 交给宿主的必须是**当前会话**（用户待会儿打字的那个窗口），
						// 不是 Lead —— 宿主按「收到 user/message 的会话 id」查范围。
						// 顺带把共享状态一起改掉（`@` 提及与这个面板是同一件事）。
						await pushScopeTarget(sessionId, target);
					} catch (error) {
						report("compose.setScope", error);
					}
				})();
			};

			const onKeyDownOnRoot = (event) => {
				if (!open) return;
				if (event.key === "ArrowDown") {
					event.preventDefault();
					setActive((current) => (options.length === 0 ? 0 : (current + 1) % options.length));
					return;
				}
				if (event.key === "ArrowUp") {
					event.preventDefault();
					setActive((current) =>
						options.length === 0 ? 0 : (current - 1 + options.length) % options.length,
					);
					return;
				}
				if (event.key === "Enter" && options[active] !== undefined) {
					event.preventDefault();
					// 禁用的行不响应回车 —— 与点击行为保持一致。
					if (readyOf(options[active])) pick(options[active]);
				}
			};

			// 非团队会话：整块不渲染。
			//
			// 注意 `hooks` 必须在这之前全部调用完 —— 早退必须发生在所有
			// `useXxx` 之后，否则视图切换时 hook 数量变化会让 React 抛
			// "Rendered fewer hooks than expected"。
			// 上面的 `useEffect` 依赖 `open`，`open` 为 false 时是空转，安全。
			if (!inChatRoom) return null;

			const receiptView = receiptText();

			return react.createElement(
				"div",
				{ className: "tc-compose", ref: handleRef, onKeyDown: onKeyDownOnRoot },
				react.createElement(
					"button",
					{
						type: "button",
						className: "tc-menu-trigger",
						"data-team-chat-entry": MENTION_OVERLAY_ID,
						"aria-label": t("compose.trigger"),
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						onClick: () => setOpen((current) => !current),
					},
					react.createElement(
						"svg",
						{ width: 14, height: 14, viewBox: "0 0 16 16", "aria-hidden": "true" },
						react.createElement("path", {
							d: "M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 2.2v-2.2H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z",
							fill: "none",
							stroke: "currentColor",
							"stroke-width": "1.2",
							"stroke-linejoin": "round",
						}),
					),
					react.createElement(
						"span",
						{ className: "tc-menu-label" },
						// 选完范围后按钮直接显示「发给：XXX」—— 让用户看得见这条消息会去哪。
						scope === null
							? t("compose.trigger")
							: t("compose.scopeOn", {
									who:
										scope === ""
											? t("compose.everyone")
											: (members[scope]?.displayName ?? scope),
								}),
					),
				),

				// 投递回执：贴在按钮右边的一枚小胶囊。
				// 宿主异步投递，失败不抛错 —— 没有它用户点了发送就什么都看不到。
				receiptView === null
					? null
					: react.createElement(
							"span",
							{
								className: "tc-compose-note",
								"data-kind": receiptView.kind,
								role: "status",
								title: receiptView.text,
							},
							receiptView.text,
						),

				open
					? react.createElement(
							"div",
							{
								className: "tc-compose-panel",
								role: "dialog",
								"aria-label": t("compose.title"),
							},
							react.createElement("div", { className: "tc-editor-title" }, t("compose.title")),
							options.length === 0
								? react.createElement("div", { className: "tc-panel-empty" }, t("compose.empty"))
								: react.createElement(
										"div",
										{ className: "tc-roster" },
										...options.map((item, index) => {
											const ready = readyOf(item);
											return react.createElement(
												"button",
												{
													type: "button",
													key: item.label,
													className: "tc-roster-row tc-roster-pick",
													"data-active": String(index === active),
													// 当前生效的范围高亮出来 —— 不然用户不知道自己选没选上。
													"data-selected": String(
														scope !== null && (item.isAll === true ? scope === "" : scope === item.label),
													),
													// 非 active 的成员点不动，也别让它看起来能点。
													"data-inactive": ready ? undefined : "true",
													disabled: !ready,
													title:
														ready || typeof item.phase !== "string"
															? undefined
															: t("compose.inactive", { phase: item.phase }),
													onMouseEnter: () => setActive(index),
													onClick: () => pick(item),
												},
												// 「所有人」没有成员资料，用一个喇叭图标占位，别去查 profile。
												item.isAll === true
													? react.createElement(
															"span",
															{ className: "tc-compose-all", "aria-hidden": "true" },
															"@",
														)
													: react.createElement(Avatar, {
															memberKey: item.label,
															profile: { displayName: item.displayName, avatar: item.avatar },
															size: 22,
														}),
												react.createElement(
													"span",
													{ className: "tc-roster-name" },
													item.isAll === true
														? item.label
														: item.displayName,
												),
												item.isLead
													? react.createElement("span", { className: "tc-tag" }, t("compose.lead"))
													: null,
												// 状态标签：只有**发不出去**的才标，active 不标（噪音）。
												ready || item.isAll === true || item.isLead === true
													? null
													: react.createElement(
															"span",
															{ className: "tc-tag tc-tag-dim" },
															t("compose.inactiveTag"),
														),
											);
										}),
									),
							react.createElement("div", { className: "tc-editor-note" }, t("compose.hint")),
						)
					: null,
			);
		}

		/**
		 * 判定当前会话是不是「团队会话」，并给出该团队的 Lead 会话 id。
		 *
		 * 为什么必须判定：本插件的三个注入点（权限影子、发送入口、成员菜单）
		 * 都是**全局注册**的 —— 槽注册一旦生效就对所有会话生效。
		 * 如果不做判定，「切回普通对话」时权限按钮仍然被影子掉、
		 * 「发送到团队」仍然显示 —— 这是实锤过的 bug。
		 *
		 * 判定依据（任一成立即为团队会话）：
		 * 1. 当前会话是某个 Lead 的子会话（`snapshot.subagent.address.parentSessionId`）
		 * 2. 当前会话自己带着 `agentTeam` 投影（它是 Lead）
		 *
		 * @param useSession - 标准 props 里的会话快照选择器。
		 * @param useSessions - 标准 props 里的会话集合选择器。
		 * @param fallbackSessionId - 兜底会话 id。
		 * @returns `{isTeam, leadSessionId, sessionId}`。
		 */
		function useTeamContext(useSession, useSessions, fallbackSessionId) {
			const sessionId = useSession((snapshot) => snapshot.id) ?? fallbackSessionId;
			const parentSessionId = useSession((snapshot) => snapshot.subagent?.address.parentSessionId);
			// leadSessionId：子会话看父，Lead 看自己。
			const leadSessionId = parentSessionId ?? sessionId;

			const team = useSessions(
				(state) =>
					state.projectionsBySession[leadSessionId]?.values.agentTeam ??
					state.projectionsBySession[sessionId]?.values.agentTeam,
			);

			// 有 parentSessionId（是别人的子会话）或有 agentTeam 投影（是 Lead）
			// 才算团队会话。两个都没有 → 普通对话。
			const isTeam = parentSessionId !== undefined || team !== undefined;

			return { isTeam, leadSessionId, sessionId, team };
		}

		/**
		 * 权限选择器的占位实现 —— 返回 `null`，即「这个槽什么都不渲染」。
		 *
		 * 为什么这么做而不是别的手段：
		 *
		 * `conversation.input.permission` 是 **`single`** 槽。single 槽的语义是
		 * 「一个格子一个占位者」，按 `priority` **升序**取第一个
		 * （`entriesOfSlot` 的 `seenCells` 去重，见 slots/lib/index.js:278-293）。
		 * 宿主的 `dsh-client-ui-permission-presets` 注册时**没写 priority**
		 * （lib/client.js:815-822），也就是默认 0。
		 *
		 * 所以只要我们在**更小的 priority** 上注册，就能把它挡在后面。
		 * 注意不能注册在 priority 0 —— 同优先级会直接抛
		 * `single slot "..." already has a registration at priority 0`。
		 *
		 * 为什么不用 CSS 隐藏：那条路要依赖宿主内部类名（`InputBar_module_css_default.modes`），
		 * 宿主一改就失效，而且 `display:none` 的元素仍占 DOM、仍有焦点序。
		 * 槽的影子是官方机制，宿主静态类型层面就支持。
		 *
		 * ⚠ **只对团队会话生效**：非团队会话必须把权限选择器还给宿主，
		 * 否则「切回普通对话权限控制消失」—— 这是实锤过的 bug。
		 *
		 * 为什么判定不能写在组件内部：`entriesOfSlot`（lib/index.js:278-293）
		 * 对 single 槽取 `cell = undefined` 去重，也就是**第一个条目永远胜出**，
		 * 组件返回 `null` 只会得到一块空白，不会让宿主那条"复活"。
		 * 所以只能**条件注册**：跟随当前会话动态 register / dispose。
		 * 见 `applyInner` 里的 `syncPermission`。
		 */
		function HiddenPermission() {
			return null;
		}

		/**
		 * 运行时服务依赖。
		 *
		 * **必须**把 `remote` / `remote.pluginManager` 写进来。
		 *
		 * 曾经的错误做法是「不在 inject 里声明，靠运行时 `ctx.get("remote")?.pluginManager` 探测」，
		 * 理由是「服务缺失会拖垮整个插件」。实测这个权衡是反的：
		 *
		 * - 不声明 → `ctx.remote` 拿到的是 getTraceable 包过的 Proxy，
		 *   读 `.pluginManager` 会走 associate 分支解析 `ctx.reflect.props["remote.pluginManager"]`，
		 *   当前 fiber 没 inject 就直接抛
		 *   `cannot get property "remote.pluginManager" without inject`。
		 *   `?.` 挡不住 —— 抛错发生在**读属性**这一步，不是读到 undefined。
		 *   apply 抛错 → fiber FAILED → `web boot: 1 entry did not activate`，整个插件不加载。
		 * - 声明 → 服务在时正常；服务不在时 fiber 停在 pending，
		 *   日志会明确写 `pending (waiting for services: ...)`，可诊断、可修。
		 *
		 * 官方 `dsh-client-ui-plugin-manager` 的 inject 里就是这么写的。
		 *
		 * 打包解析依赖在 `package.json` 的 `dsh.client.inject` 里 —— 两件事，别混。
		 */
		const inject = [
			"slots",
			"sessions",
			"uiConversation",
			"locale",
			"configForms",
			"remote",
			"remote.pluginManager",
			// 需求 C：把成员管理做成右侧栏页签。
			// 这两个是官方 `dsh-client-ui-sidebar-right` / `dsh-client-ui-layout`
			// 用 `ctx.reflect.provide` 暴露的公开服务面，第三方注册页签类型是官方支持的正路
			// （官方 `dsh-client-ui-sidebar-terminal` 的 inject 里就有 `sidebarRightTabs`）。
			"sidebarRight",
			"sidebarRightTabs",
			"layout",
			// 「新建 AI 成员」建成后要把那个成员的会话**打开**（新建完就该看见它）。
			// `openSession(sessionId)` 是官方 ui-workspace 暴露的公开服务面，
			// 官方 dsh-client-ui-subagent 打开子会话走的也是它。
			"uiWorkspace",
		];

		/**
		 * 成员页签的注册身份。
		 *
		 * \`kind\` 是类型判别符，必须与官方已有 kind 不冲突。官方占用的有：
		 * \`guide\` / \`terminal\` / \`files\` / \`browser\` / \`text\` / \`plan\` /
		 * \`schedule\` / \`review\`。这里用带插件前缀的自定义值。
		 *
		 * \`id\` 也必须全局唯一（\`SidebarRightTabRegistry.register\` 第一件事就是查重）。
		 */
		const PANE_KIND = "team-chat-members";
		const PANE_ID = "dsh-team-chat/members";

		/**
		 * 左侧栏「聊天室」面板的登记身份。
		 *
		 * ⚠ `sidebar.panellist` 条目的 `id` 与 `main` 条目的 `key` 必须**同值**：
		 * 点面板行走 `layout.selectPanel(id)`，它对没注册 main 面板的 id **直接抛**
		 * （`dsh-client-ui-layout/lib/client.js:462-466`）；主区则按
		 * `entryKey = activePanelId` 取 main 槽条目（同文件 `:118`）。
		 * 两边各写各的字符串 = 一点就炸。守卫（smoke-client-entries [11]）钉的就是这个同值。
		 */
		const PANEL_ID = "dsh-team-chat/room";

		/**
		 * 打开右栏的成员页签。
		 *
		 * \`ctx\` 拿不到（本函数在组件里被调用，组件只有标准 props），
		 * 所以由 \`applyInner\` 把需要的两个服务挂到这个模块级闭包里。
		 */
		let openMembersPane = () => {};

		/**
		 * 打开某个成员的**对话窗口**。
		 *
		 * 成员就是一个独立的顶层会话 —— 这就是「回到那个窗口」的入口。
		 * 与 `openMembersPane` 同理：`ctx` 在组件里拿不到，
		 * 由 `applyInner` 把这个能力挂到模块级闭包上。
		 *
		 * @param sessionId - 成员会话 id。
		 */
		let openMemberSession = () => {};

		/**
		 * 把一个槽注册绑到「当前停在聊天室视图」这个条件上。
		 *
		 * ## 为什么需要动态注册
		 *
		 * 槽注册是**全局账本**，注册一次对所有会话、所有视图生效。
		 * 而本插件的权限影子（`conversation.input.permission`，single 槽）
		 * 一旦生效就是永久的 —— `entriesOfSlot` 对 single 槽取 `cell = undefined`
		 * 去重，**第一个条目永远胜出**，让组件返回 `null` 也只得到空白。
		 * 所以只能跟着视图切换注销 / 重注册。
		 *
		 * ## 判据是「视图」不是「会话类型」（踩过）
		 *
		 * 曾经用「会话有没有 `agentTeam` 投影」判 —— 症状是：
		 * 任何**还没建团队**的会话里，「完全权限」都照常显示，
		 * 用户在聊天室里看到它，以为隐藏改动丢了。
		 * 用户的心智是「我在哪个 tab」，跟会话的数据状态无关。
		 *
		 * 现在的判据 `chatRoomActive` 由 `TeamChatView` 的挂载状态维护
		 * （官方契约：`conversation.view` 一次只渲染一个视图）。
		 *
		 * 顺带：换成订阅模块级状态之后，`ctx.uiSession` 这条按会话跟踪的路
		 * 就整个不需要了 —— 少一个软探测点。
		 *
		 * @param register - 返回 disposer 的注册函数。
		 * @returns `{dispose}` —— 卸载门控与已生效的注册。
		 */
		function gateOnChatRoom(register) {
			/** 当前已生效的注册 disposer（未生效时为 null）。 */
			let active = null;

			const sync = () => {
				const want = chatRoomActive;
				if (want === (active !== null)) return;
				if (want) {
					active = register();
				} else {
					const dispose = active;
					active = null;
					try {
						dispose?.();
					} catch (error) {
						report("gate.dispose", error);
					}
				}
			};

			const unsubscribe = subscribeChatRoom(sync);
			sync();

			return {
				dispose() {
					unsubscribe();
					if (active !== null) {
						const dispose = active;
						active = null;
						dispose?.();
					}
				},
			};
		}

		/**
		 * 把样式挂进 <head> 一次。
		 *
		 * CSS 文字源类字段（`plainText` / `rawText`）都是惰性求值的 ——
		 * 我们把注入写在 IIFE 里并在模块求值时执行，正好避开 TDZ。
		 */
		const installCss = () => {
			const tagId = "dsh-team-chat/team-chat.css";
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-team-chat";
				tag.dataset.pluginCss = tagId;
				tag.textContent = TEAM_CHAT_CSS;
				document.head.appendChild(tag);
			}
		};
		/**
		 * 布局现场取证（诊断用，2026-10-10 第五轮）。
		 *
		 * ⚠ 这是**取证**，不是修复。前五轮都在改 CSS/写入时机，改完用户照样复现，
		 *   而我们在本机看不到 Electron 里的真实数值 —— 只能从**另一个插件**
		 *   的诊断日志里反推（input top=116 这种二手数据）。
		 *
		 * 关键待证问题：**「在左侧切到另一个对话」的那一刻，viewArea 到底在不在**。
		 *   · 在 ⇒ 是高度/滚动问题 ⇒ 由上面的 anchor CSS 兜住；
		 *   · 不在 ⇒ 官方 `DefaultConversationViews` 在 `session.blank &&
		 *     conversationPhase === "blank"` 时 `return null`
		 *     （dsh-client-ui-conversation:16412）⇒ composerSeat 成了 scrollBody 的
		 *     唯一子元素 ⇒ 紧跟 header ⇒ 输入框顶在最上面。
		 *     那种情形是**官方自己的空白态**，本插件既改不动也不该改。
		 *
		 * 上报策略刻意压得很轻：首帧一条基线（看正常时长什么样），之后**只在异常时**
		 * 报（composer 没贴底 / viewArea 不在），一进程最多 8 条 —— 不刷日志。
		 * 数据走已有的 `/__teamchat/report`，落进 harness.log（`logger.error`）。
		 */
		function startLayoutProbe() {
			if (typeof document === "undefined") return;
			const MAX_REPORTS = 8;
			const INTERVAL_MS = 2_000;
			const MAX_TICKS = 60;
			let ticks = 0;
			let sent = 0;
			const send = (line) => {
				sent += 1;
				try {
					void fetch("/__teamchat/report", { method: "POST", body: `[layout-probe] ${line}` });
				} catch {
					/* 取证失败不许影响主流程 */
				}
			};
			const tick = () => {
				ticks += 1;
				if (sent >= MAX_REPORTS) return;
				try {
					const scroller = document.querySelector("[data-conversation-scroll]");
					if (scroller === null) {
						if (ticks < MAX_TICKS) setTimeout(tick, INTERVAL_MS);
						return;
					}
					const root = document.querySelector(".ank0OG_root");
					const viewArea = scroller.querySelector(":scope > [data-slot] > .ank0OG_viewArea");
					const seat = scroller.querySelector(":scope > [data-composer-seat]");
					const input = seat === null ? null : seat.querySelector("input, textarea, [contenteditable]");
					const tcRoot = document.querySelector(".tc-root");
					const box = scroller.getBoundingClientRect();
					const inputRect = input === null ? null : input.getBoundingClientRect();
					// 贴底判据：输入框底边距 scrollBody 可视底部不超过 40px。
					const stuck = inputRect !== null && inputRect.bottom < box.bottom - 40;
					const line = [
						`phase=${root?.getAttribute("data-phase") ?? "-"}`,
						viewArea === null ? "viewArea=NONE" : `viewArea=${Math.round(viewArea.getBoundingClientRect().height)}`,
						tcRoot === null ? "tcRoot=NONE" : `tcRoot=${Math.round(tcRoot.getBoundingClientRect().height)}`,
						`scrollBody=${scroller.clientHeight}/${scroller.scrollHeight}`,
						inputRect === null ? "input=NONE" : `inputTop=${Math.round(inputRect.top)}`,
						stuck ? "composer=NORMAL_BOTTOM_MISS" : "composer=bottom",
					].join(" ");
					// 首帧当基线报一条，其余只在「异常」时报。
					if (sent === 0 || stuck || viewArea === null) send(line);
				} catch {
					/* 采样本身不许抛 */
				}
				if (ticks < MAX_TICKS) setTimeout(tick, INTERVAL_MS);
			};
			setTimeout(tick, 1_200);
		}

		installCss();
		// 布局现场取证见 `startLayoutProbe()` —— 紧跟着 CSS 注入启动。
		startLayoutProbe();

		/** 注册视图、设置项与文案。 */
		function apply(ctx) {
			try {
				return applyInner(ctx);
			} catch (error) {
				// apply 抛错 = fiber FAILED = `web boot: N entry did not activate`。
				// 桌面端日志会把堆栈吃掉，所以自己上报一份完整的。
				report("apply", error);
				throw error;
			}
		}

		function applyInner(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh: zhCN, en: enUS }), "team-chat: dictionaries");
			// `locale` 上**没有** `t(ns, key)` 这个方法，只有
			// `bind(ns) -> (key, params) => translate(ns, key, params)`。
			// 写成 `ctx.locale.t(NS, key)` 会直接抛 "ctx.locale.t is not a function"，
			// 连带把 locale 订阅者一起打崩。
			const t = ctx.locale.bind(NS);

			// ── 1. 主视图 ─────────────────────────────────────────
			//
			// `sessionId` / `useSessions` 都是该槽的**标准 props**，由 renderer
			// 直接注入组件，不走下面这个 `inject` 工厂（工厂只补 `t`）。
			// 用 `useSessions` 读官方 `agentTeam` 投影里的职责描述（description），
			// 本地没写覆写时拿它兜底回显。
			const disposeView = ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{
						name: "conversation.view",
						id: VIEW_ID,
						order: 20,
						locale: NS,
						label: () => t("view.label"),
						inject: () => ({ t }),
					},
					boundEntry("conversation.view", TeamChatView),
				),
			);

			// ── 2. 右侧栏「成员管理」页签（需求 C）──────────────────
			//
			// 官方两段式路径的第二段在这里，第一段是下面那个
			// `ctx.sidebarRightTabs.register(...)`。
			//
			// 为什么不直接把成员面板塞进 `conversation.session.header.actions`
			// 旁边（也就是用户说的「模式右边」）：那是**头部工具栏**，会跟官方
			// 的 TeamAction / 权限 / 模型选择挤一行，面板宽度只有几百像素，
			// 列表一长就得滚动。右栏是官方的「常驻侧栏」，宽度、滚动、
			// 多页签管理都是现成的。
			//
			// `sidebar.right.pane.tab` 是 **keyed / session** 槽：
			// - `key` 必须等于我们在注册表里登记的 `id`（官方 terminal 同款写法）；
			// - 标准 props 由 renderer 注入（`sessionId` / `useSession` /
			//   `useSessions` / `useTabInfo` 等），工厂只补 `t`。
			const disposePaneType = ctx.effect(
				() =>
					ctx.sidebarRightTabs.register({
						id: PANE_ID,
						kind: PANE_KIND,
						// `multiple: false`（缺省）：同一会话里这个页签只开一个，
						// 反复点「成员」不会堆出一串重复页签。
						priority: "extension",
						title: () => t("pane.title"),
						// guide 卡片 —— 用户从右栏「新建标签页」打开的入口。
						// 没有它，页签类型注册了也没有任何 UI 能打开它。
						guide: [
							{
								id: "members",
								order: 40,
								title: () => t("pane.guideNew"),
								description: () => t("pane.guideDesc"),
							},
						],
					}),
				"team-chat: sidebar tab type",
			);

			const disposePaneBody = ctx.slots.inject("sidebar.right.pane.tab", () =>
				ctx.slots.register(
					{
						name: "sidebar.right.pane.tab",
						key: PANE_ID,
						locale: NS,
						inject: () => ({ t }),
					},
					boundEntry("sidebar.right.pane.tab", MembersPane),
				),
			);

			const disposePaneTitle = ctx.slots.inject("sidebar.right.pane.tab.title", () =>
				ctx.slots.register(
					{
						name: "sidebar.right.pane.tab.title",
						key: PANE_ID,
						locale: NS,
						inject: () => ({ t }),
					},
					boundEntry("sidebar.right.pane.tab.title", MembersPaneTitle),
				),
			);

			// 「成员」按钮 → 开右栏页签。
			//
			// ⚠ 顺序不能反：`sidebarRight.openTab` 内部走 `this.require()`，
			// 右栏没挂载时它**直接抛**（`no session surface is mounted`），
			// 所以必须先用 `layout.openRightbar()` 把栏展开，等 React 挂载完
			// 再开页签。挂载发生在下一帧，所以这里 rAF + 一次重试兜住。
			openMembersPane = () => {
				const open = () => ctx.sidebarRight.openTab(PANE_KIND, { revealIfOpened: true });
				try {
					ctx.layout.openRightbar();
				} catch (error) {
					report("members.openRightbar", error);
				}
				try {
					open();
					return;
				} catch (error) {
					// 右栏刚展开、seat 还没挂上：下一帧再试一次。
					if (typeof requestAnimationFrame !== "function") {
						report("members.openTab", error);
						return;
					}
					requestAnimationFrame(() => {
						try {
							open();
						} catch (retryError) {
							report("members.openTab.retry", retryError);
						}
					});
				}
			};

			// 点成员那一行的「打开对话」→ 把那个会话开到主区。
			//
			// `openSession(sessionId)` 是官方 ui-workspace 的公开面；
			// 官方 Agent Teams 客户端包里的 `openChild` 也是这么调的。
			//
			// ⚠ 光 `openSession` 不够（2026-10-09 用户反馈）：主区落在**哪个 tab**
			// 不在这条调用链上 —— 见 `preferChatView` 的注释。用户的心智是
			// 「打开对话 = 进它自己那个对话」，落到聊天室 tab 上是错的
			// （房间里所有窗口看到的聊天室本来就是同一份，等于没跳）。
			openMemberSession = (sessionId) => {
				if (typeof sessionId !== "string" || sessionId === "") return;
				// 先改「上次停在哪个视图」，再开窗口 —— 顺序不能反：
				// 会话 store 是在**挂载那一刻**从存储里水合的。
				preferChatView(sessionId);
				try {
					ctx.uiWorkspace.openSession(sessionId);
				} catch (error) {
					report("members.openSession", error);
				}
			};

			// ── 2.5 左侧栏「聊天室」入口（sidebar.panellist + main）───────
			//
			// 两段式（官方 schedule 同款，`dsh-client-ui-schedule/lib/client.js:6793-6810`）：
			//  ① `main` 槽按 key 登记面板本体 —— 主区按 activePanelId 取它渲染；
			//  ② `sidebar.panellist` 槽登记侧边栏那一行（图标 + 文案）。
			// 两段缺一不可：只有 ① 侧边栏没有入口；只有 ② 点下去
			// `layout.selectPanel` 直接抛（main 面板没注册）。
			//
			// 递给组件的是 `selection` 的**最小面**（只读）——
			// 整个 store 递进去等于把 `set/update` 的写权力也给了它。
			const currentSession = {
				getSnapshot: () => ctx.uiWorkspace.selection.getSnapshot(),
				subscribe: (listener) => ctx.uiWorkspace.selection.subscribe(listener),
			};

			const disposeMainPanel = ctx.slots.inject("main", () =>
				ctx.slots.register(
					{
						name: "main",
						key: PANEL_ID,
						locale: NS,
						inject: () => ({ t, currentSession }),
					},
					boundEntry("main", TeamChatRoomPanel),
				),
			);

			const disposePanelButton = ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						// 官方占了 0（插件管理）与 10（任务计划），跟在后面。
						order: 20,
						locale: NS,
						label: () => t("panel.navLabel"),
					},
					boundEntry("sidebar.panellist", TeamChatPanelIcon),
				),
			);

			// ── 3. 去掉权限按钮（**仅团队会话**）──────────────────────
			//
			// `priority: -100` 是刻意的负数：宿主默认 0，官方 `agent-team` 的
			// header action 用 -20，我们取更小值留出插入空间。
			// 见 HiddenPermission 的注释。
			//
			// ⚠ 必须**条件注册**：槽的 entries 是全局账本，不按会话/视图过滤
			// （`scope` 只是 store-handle 的校验声明，见 slots/lib/index.js:94）。
			// 一旦无条件注册，切回「对话」tab 时权限按钮就会永久消失。
			// 判定逻辑见 `gateOnChatRoom` —— 判据是**所在视图**，不是会话类型。
			const permissionGate = gateOnChatRoom(() =>
				ctx.slots.inject("conversation.input.permission", () =>
					ctx.slots.register(
						{
							name: "conversation.input.permission",
							id: "team-chat-hide-permission",
							priority: -100,
							inject: () => ({}),
						},
						// 影子条目的降级就是「什么都别渲染」——
						// 抛错时若渲染出一个胶囊，反而会在输入框工具栏里冒出一个怪东西。
						// 最坏情况只是权限选择器重新露出来，那是可接受的降级。
						boundEntry("conversation.input.permission", HiddenPermission, {
							silent: true,
						}),
					),
				),
			);
			const disposePermission = permissionGate.dispose;

			// ── 4. 头部「成员」按钮（一键开右栏页签）─────────────────
			//
			// `inject` 工厂拿到的是**槽的 ownerProps**（官方签名
			// `inject: (...args: InjectParams<K, H>) => I`），
			// 而 `conversation.session.header.actions` 的 ownerProps 是
			// `children?: never` —— 不吃任何参数。
			//
			// 我们需要的 `useSession` / `useSessions` 是**标准 props**（standardProps），
			// 由 renderer 直接注进组件，不走这个工厂。
			const disposeMembers = ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.actions",
						id: "team-chat-members",
						order: 200,
						locale: NS,
						inject: () => ({ t }),
					},
					boundEntry("conversation.session.header.actions", MembersMenu),
				),
			);

			// ── 5. 输入框工具栏左侧：「发送到团队」 ────────────────
			//
			// `conversation.input.left` 是 `list` 槽（"Compact controls at the left
			// of the composer tool row"）。`inputActions` 等标准 props 由 renderer
			// 直接注入，不走下面的 `inject` 工厂 —— 工厂只补 `t`。
			const disposeCompose = ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: MENTION_OVERLAY_ID,
						order: 50,
						locale: NS,
						label: () => t("compose.trigger"),
						inject: () => ({ t }),
					},
					boundEntry("conversation.input.left", TeamCompose),
				),
			);

			// ── 6. 独立设置页 ─────────────────────────────────────
			//
			// 用 **`settings.section`**（设置面板左侧导航的一行），而不是原来的
			// `settings.general.item`（塞在「通用」里）。官方 general / models /
			// plugins / account / agent-presets 都是这么挂的：注册进去，
			// 导航项与独立内容区由外壳自动生成，完全不用碰官方代码。
			//
			// `remote.pluginManager` 已在 inject 里声明，能走到这里就说明它已经在位
			// —— 用 `ctx.get` 取值（不走属性访问，避免再触发一次解析）。
			// 万一真缺失，fiber 会停在 pending，而不是在这里抛。
			const pluginManager = ctx.get("remote.pluginManager");
			const uiWorkspace = ctx.get("uiWorkspace");
			let disposeSection = () => {};
			disposeSection = ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "team-chat",
						// 官方几个 section 的 order 是 0 / 10 / …，排到后面去，别插中间。
						order: 60,
						label: () => t("settings.nav"),
						locale: NS,
						inject: () => ({ t, remote: pluginManager, uiWorkspace }),
					},
					boundEntry("settings.section", TeamChatSettingsSection),
				),
			);

			// ── 7. 左侧栏不放成员列表（明确决定，别再往回加）─────────
			//
			// 曾经在 `sidebar.panellist`（官方「插件」「任务」那一排）给每个成员注册过一行。
			// 用户的反馈是：「我要去找成员，我不就在聊天室里去找了吗？我为什么要在这上面找？」
			// —— 左侧栏只负责**会话**；成员的身份与入口在聊天室 / 成员管理面板里。
			//
			// 成员**对话窗口**不能进左侧栏那棵树，是官方设计：
			//   `sessionVisible()` 里 `if (session.origin === "subagent") return false`
			// 注释写着 *"Subagent children use their parent header catalog"*。
			// 那棵树所在的 `sidebar.workspaces` 是 single 槽、被官方组件独占，四路绕过全堵死
			// （包一层 / 代渲染 / 改 origin / 重写整棵树），详见项目记忆。

			// ── 8. AI 成员对话窗口的标题行 ─────────────────────────
			//
			// 打开一个成员的对话窗口时，顶部那一行现在显示的是官方给它的
			// **职责描述**（`SubagentHeaderLineage` 显示 `currentEntry.label`，
			// 而 label 溯源到建成员时传给官方 `spawnTeammate` 的 `description`）
			// —— 那是**创建期字段**，`team/member` / `subagent/catalog` 都是
			// append-only 且按 childId **追加不覆盖**，事后改不了。
			//
			// 所以只能把这一行**接管过来自己渲染**，显示成员名。
			// `priority: -100`（宿主默认 0）赢下这个 single 槽 ——
			// 与 `conversation.input.permission` 用的是同一套影子机制。
			//
			// ⚠ 代价：官方那个组件自带一个「切换子智能体」下拉，被顶掉了。
			//    但**切换能力没丢** —— 右上角官方 `SubagentCatalogAction` 的
			//    「N 个子智能体」目录仍然在，点开就能换。
			const disposeLineage = ctx.slots.inject("conversation.session.header.lineage", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.lineage",
						priority: -100,
					},
					boundEntry("conversation.session.header.lineage", MemberHeaderLineage),
				),
			);


			// ── 9. 条目自愈：被判过死刑的注册点，当场重新注册 ──────────
			//
			// `TCEntryBoundary` 已经挡住了「我们的组件抛错」这条路，
			// 但除名机制还有别的入口（装配期抛错：`standardKit` 找不到 locale face、
			// `StrictSessionEntry` 拿不到 scope binding、`inject` 工厂本身抛错……）。
			// 那些一旦发生，条目就**永久消失**，而用户唯一的解法是重启 DSH。
			//
			// 官方给了监督通道：`slots.onEntryError(fn)`（`SlotRegistry.onEntryError`）
			// 在任何「条目被除名」的变更之后**同步**触发，回调拿得到
			// `(slotKey, entry, error, {abdicated})`。
			//
			// 自愈的关键点是**换一个 entry 对象**：DSH 的 `abdicated` 是一张
			// WeakSet，它认的是对象身份而不是 id —— 同一个对象再注册也没用，
			// 而**新对象**能正常参与渲染。配方不用另存一份，直接照崩掉那个条目
			// 自己的字段重建即可（`options` 里有 id/key/order/label/priority，
			// 条目上还有 `locale` / `inject` / `component`）。
			//
			// 为什么可以放心重注册：除名**不会**把旧条目从账本里摘掉，
			// 但列表槽按 `options.id` 去重，新条目一进来就顶掉那一行占位
			// （否则界面里会留一个 `x<id>` 的报错小块），
			// 单槽/键槽更是只看 `entriesOfSlot` 的第一个存活者。
			//
			// ⚠ 必须**防死循环**：若某个条目每次渲染都炸，自愈就会变成
			// 无限注册。所以每个槽最多自愈 `HEAL_LIMIT` 次，超了就停手并上报
			// —— 那种情况下真正该修的是源码，不是继续重试。
			const healCounts = new Map();
			const HEAL_LIMIT = 3;

			/** 是不是我们自己的条目 —— 认 `boundEntry` 盖的那个标签。 */
			const isOurEntry = (entry) =>
				typeof entry?.component?.displayName === "string" &&
				entry.component.displayName.startsWith("TCEntry(");

			/**
			 * 自愈用的重注册入口。
			 *
			 * ⚠ 刻意**不直接写** `ctx.slots.register(...)`：守卫（verify-client [15]）
			 * 逐个注册点检查「第二参是 `boundEntry(...)`」，用来保证每个注册点都包了
			 * 自带边界。自愈这条不是新注册点 —— 它重注册的正是已经包过边界的那一个
			 * —— 形参特意就叫 `boundComponent`，守卫认这个名字把它放行。
			 * 混进去当新注册点会让那条守卫失去意义。
			 */
			const reRegister = (options, boundComponent) => ctx.slots.register(options, boundComponent);

			/** 照崩掉那个条目自己的字段重注册一次。 */
			const remount = (slotKey, entry) => {
				const options = entry?.options ?? {};
				const rebuilt = { name: slotKey };
				// 只带上**原条目真有**的字段：多塞一个 `key: undefined` 在键槽上
				// 会让 `register` 把它当成「指定了键但键无效」。
				if (options.key !== undefined) rebuilt.key = options.key;
				if (options.id !== undefined) rebuilt.id = options.id;
				if (options.order !== undefined) rebuilt.order = options.order;
				if (options.label !== undefined) rebuilt.label = options.label;
				if (options.priority !== undefined) rebuilt.priority = options.priority;
				if (entry.locale !== undefined) rebuilt.locale = entry.locale;
				if (entry.inject !== undefined) rebuilt.inject = entry.inject;
				return reRegister(rebuilt, entry.component);
			};

			ctx.effect(() => {
				// ⚠ 服务面探测放**内部**：`onEntryError` 是 2.x 才公开的监督口，
				// 老版本没有。这里直接属性访问会抛，而 apply 抛错 = 整个插件不加载
				// —— 少一层自愈远没有整个插件装不上严重。
				if (typeof ctx.slots.onEntryError !== "function") return () => {};
				const unsubscribe = ctx.slots.onEntryError((slotKey, entry, error, info) => {
					if (info?.abdicated !== true || !isOurEntry(entry)) return;
					const used = healCounts.get(slotKey) ?? 0;
					if (used >= HEAL_LIMIT) {
						report(
							`entry-heal-limit:${slotKey}`,
							error ?? new Error(`条目连续 ${HEAL_LIMIT} 次被除名，停止自愈`),
						);
						return;
					}
					healCounts.set(slotKey, used + 1);
					// 推迟一个微任务：不要在这个「错误上报」同步栈里再改账本。
					Promise.resolve().then(() => {
						try {
							remount(slotKey, entry);
						} catch (remountError) {
							report(`entry-heal:${slotKey}`, remountError);
						}
					});
				});
				return () => unsubscribe();
			}, "team-chat: entry self-heal");

			// ── 10. 输入框里的 @ 提及（官方 inputTriggers 框架）─────────
			//
			// 用户要的是：在输入框里打 `@` 就能选人，选完留一个**带颜色的完整字段**，
			// 而且那个字段里写的是**显示名**（可以中英文）。
			//
			// ⚠ 用 `ctx.inject(["inputTriggers"], …)` 而**不是**写进 `inject` 数组：
			// 写进 inject 意味着「没有这个服务就别激活本插件」—— 一个补全功能
			// 不该有这种权力。`ctx.inject` 是官方惯用法（`dsh-client-ui-chat`
			// 的 `ctx.inject(["sidebarRightTabs"], …)` 同款）：服务在就接上，
			// 不在就静静地不接，插件其余部分照常工作。
			ctx.inject(["inputTriggers"], (scope) => {
				const source = createMemberMentionSource(t, (sessionId) => openMemberSession(sessionId));
				scope.effect(
					() => scope.inputTriggers.registerSource(source),
					"team-chat: @ 成员源",
				);
			});

			return () => {
				// 拆掉按钮到服务的连线，避免插件卸载后闭包里还握着 ctx。
				openMembersPane = () => {};
				openMemberSession = () => {};
				disposeSection();
				disposeLineage();
				disposeCompose();
				disposeMembers();
				disposePermission();
				disposePaneTitle();
				disposePaneBody();
				disposePaneType();
				disposeView();
				disposeMainPanel();
				disposePanelButton();
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.blocksToText = blocksToText;
		// Markdown 子集渲染器。导出同样是为了能**真渲染**一遍：
		// 「表格 → 真 `<table>`」「`javascript:` 不给 href」「异常退回纯文本」
		// 这三条只有跑一次渲染树才证明得了，静态字符串匹配证明不了。
		exports.renderMarkdownBody = renderMarkdownBody;
		exports.parseMarkdown = parseMarkdown;
		// 折叠那两件 + 硬上限，导出理由同上：**只有真跑一遍才证明得了**
		// 「折叠态不把正文送进解析器」「短消息不折」「超上限退回纯文本」。
		// 上限本身也导出 —— 测试要断言的是「超过这个数才退」，数字必须来自同一处。
		exports.mdHeadOf = mdHeadOf;
		exports.mdCollapsibleOf = mdCollapsibleOf;
		exports.MD_LIMITS = MD_LIMITS;
		// 折叠集合的切换逻辑（导出理由见函数注释：本机没有 DOM 测试环境）。
		exports.toggledIds = toggledIds;
		exports.rosterOf = rosterOf;
		exports.hueOf = hueOf;
		exports.VIEW_ID = VIEW_ID;
		exports.TEAM_BUNDLE = TEAM_BUNDLE;
		// 槽条目自带边界 —— 导出是为了让它能被真跑：
		// 「DSH 那条边界会永久除名条目」这条链只能靠一个**运行时**断言钉住
		// （`getDerivedStateFromError` 不能 rethrow、失败态必须降级成胶囊），
		// 静态字符串匹配证明不了行为。见脚手架 `smoke-client-entries.mjs`。
		exports.TCEntryBoundary = TCEntryBoundary;
		exports.boundEntry = boundEntry;
		// 「打开对话 = 进它自己那个对话」的那一步（改会话的视图偏好）。
		// 导出理由同上：它对 localStorage 是**合并写**，合并语义只有真跑一次
		// 才证明得了（脚手架会断言「草稿没被抹掉」）。
		exports.preferChatView = preferChatView;
		// `@` 提及源的工厂 —— 导出同样是为了能真跑：
		// 「芯片上写的是显示名而不是成员标识」只有调一次 `onPick` 才判得出来。
		exports.createMemberMentionSource = createMemberMentionSource;
		exports.MENTION_SOURCE = MENTION_SOURCE;
		// 左侧栏「聊天室」面板的三件套 —— 导出理由同上：
		// 「main 的 key 与 panellist 的 id 同值」（点错了 layout.selectPanel 直接抛）、
		// 「子智能体的 lead 解析取父会话」都只有真跑/真渲染一遍才钉得住。
		exports.resolvePanelSession = resolvePanelSession;
		exports.TeamChatRoomPanel = TeamChatRoomPanel;
		exports.TeamChatPanelIcon = TeamChatPanelIcon;
		exports.PANEL_ID = PANEL_ID;
		// 聊天室气泡的三个纯函数 —— 导出同样是为了能真渲染一遍。
		// `[7]` 那组只把 TeamChatView 渲染到「空列表」分支，气泡那段根本跑不到；
		// 而气泡里有一堆字段取值（`targetNames` / `at` / 资料表命中）——
		// 正是「渲染体里打错名字」这类事故的高发区。见脚手架 `[10]`。
		exports.Bubble = Bubble;
		exports.dayRowIfNeeded = dayRowIfNeeded;
		exports.isSameSpeaker = isSameSpeaker;
		// 成员编辑器与它的三个宿主 —— 导出理由同上：**「交替」按钮只该出现在
		// 有房间上下文的宿主里**这件事，是一个渲染树级的事实
		// （设置页 `MembersConfigRow` 传 `leadTaken === undefined`、
		//  「我（发言人）」`SpeakerProfileBlock` 传 `speaker: true`），
		// 静态字符串匹配证明不了。见脚手架 `smoke-succession-client.mjs`。
		exports.MemberEditor = MemberEditor;
		exports.MembersPanel = MembersPanel;
		exports.MembersConfigRow = MembersConfigRow;
		exports.SpeakerProfileBlock = SpeakerProfileBlock;
		exports.HandoverPreview = HandoverPreview;
		exports.successionResultNodes = successionResultNodes;
		exports.HANDOVER_SECTION_LABELS = HANDOVER_SECTION_LABELS;
		// ── 国际化：宿主报错的「码 → 文案」这条链，导出是为了能**真的断言** ──
		//
		// 不导出就只能靠 `smoke-*.mjs` 那种静态字符串匹配，而静态匹配证明
		// 不了「渲染出来的东西里没有中文」。测试脚本用这两个函数把
		// `err.<CODE>` 真的翻一遍（见 `test/host-error-i18n.test.mjs`）。
		exports.errorText = errorText;
		exports.spawnErrorMessage = spawnErrorMessage;
		// 这两个也必须导出：它们才是**成员保存失败**在界面上真正走的那条路
		// （`code` + `cause` 两段）。只导出 `errorText` 的话，「原因码有没有被
		// 用上」就只剩静态匹配可查 —— 那证明不了渲染结果。
		exports.errorTextWithRaw = errorTextWithRaw;
		exports.saveFailureText = saveFailureText;
		return module.exports;
			},
		});
	} catch (error) {
		// load 抛错 = 整个 entry 不会 activate。原样上报，别让细节消失在日志转义里。
		report("loader.load", error);
		throw error;
	}
})();

//# sourceURL=dsh-team-chat/client.js
