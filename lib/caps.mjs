// 通道能力表：这家 harness 到底能不能用这条通道，不能用是为什么。
//
// 为什么要有这张表：UI 上给一个能点的开关、点了却什么都没发生，比不给开关更糟
// （实测踩过：zcode 是闭源桌面，双击启动根本不经过 PATH，裸命令接管对它永远无效）。
// 真相只有一处：矩阵（matrix.json）+ 持久化后端表（persist.mjs）+ /purge 支持表（slashes.mjs）。
import { liveProfiles } from "./dsh.mjs";
import { backends } from "../backends/index.mjs";
import { targets as persistTargets } from "./persist.mjs";
import { projectTargets, PROJECT_NOTE } from "./project.mjs";
import { resolveReal } from "./shim.mjs";
import { readResource } from "./root.mjs";

/** 通道存在、但本机没能真跑一次的（模型白名单 / 没有 CLI）：UI 标「文档」，不标「实测」 */
const NOT_LIVE_TESTED = new Set(["claude", "zcode"]);
/**
 * 点名启动（`agent-purge <h>`）也是真注入通道：启动参数 / 临时 agent 文件 / 临时环境变量。
 * 它一直存在于 backends/ 与 matrix.launcher，但曾经漏在这张表外面——于是 launch-arg 型的家
 * （qwen/kimi/kiro/goose/auggie/continue/qoder/gemini…）四条通道全不命中，UI 只能落到
 * 「仅支持项目级规则文件」的兜底文案，把明明在注入的工具说成注入不进去。
 * 判据用 backends 的实际实现，而不是再抄一份名单。
 */
const LAUNCH_IDS = new Set(Object.keys(backends));
const matrix = readMatrix();

function readMatrix() {
	try {
		return JSON.parse(readResource("matrix.json").toString("utf8"));
	} catch (e) {
		throw new Error(`matrix.json 读不了：${e.message}`);
	}
}

/** 后端在、但 off 之外的模式拿不到注入的（人工核过） */
const LAUNCH_WHY = {
	zcode: "zcode 的后端只给人工配方（CLI 拿不到 customSystemPrompt），点名启动不注入",
};
/** 点名启动具体怎么注入：一句话说清，UI 直接展示给用户 */
const LAUNCH_HOW = {
	qwen: "qwen --system-prompt <人设>（或 --append-system-prompt）",
	qoder: "qodercli --system-prompt <人设>（或 --append-system-prompt）",
	continue: "cn --rule <人设文件>，作为规则/上下文追加",
	kimi: "kimi --agent-file <临时 agent.md>，正文即会话 system prompt",
	auggie: "auggie --rules <人设文件>，作为规则/上下文追加",
	goose: "goose session --system <人设>，作为 additional system instructions",
	kiro: "kiro-cli chat --agent agent-purge（临时写 ~/.kiro/agents/agent-purge.json 的 prompt）",
	claude: "claude --system-prompt-file <人设>",
	grok: "grok --system-prompt-override <人设>",
	codex: "codex -c model_instructions_file=<人设>",
	codebuddy: "codebuddy --system-prompt <人设>",
	omp: "omp --system-prompt <人设>（装扩展后走 /purge）",
	opencode: "临时插件文件原地 splice output.system",
	opencode2: "临时 v2 插件改 event.system",
	dsh: "临时 cordis 会话插件",
	kilo: "临时写 code agent prompt，退出还原",
	hermes: "HERMES_HOME=<tmp> 下替换 SOUL.md",
	pi: "扩展钩子改写 systemPrompt",
	"pi-desktop": "~/.pi/agent/SYSTEM.md 替换 persona 块",
	crush: "写入 CRUSH.md 托管块（走 install 通道）",
};
/** 有注入后端、且后端在 off 之外真的会注入吗？zcode 只有人工配方，不算 */
const launchOk = (id) => LAUNCH_IDS.has(id) && !LAUNCH_WHY[id];
const launchHow = (id) => LAUNCH_HOW[id] ?? null;

/** 有 /purge 机制的 harness —— **只算能把内容写进系统提示词的**（pi/omp 的扩展钩子、dsh 的 cordis 插件） */
export const SLASH_IDS = new Set(["pi", "pi-desktop", "dsh", "omp"]);
/** 有可写配置文件/插件的 harness（其余家只能点名启动或打补丁） */
export const PERSIST_IDS = new Set(Object.keys(persistTargets));
/** 能把内容真的送进 system 数组的层；user 层（上下文块/用户消息）一律不对外提供 */
const SYS_LAYER = "sys";
/** 被隐藏的落点叫什么（给 UI 写一行实话用）；只有“曾经真有过落点”的才写 */
const HIDDEN_LABEL = {
	claude: { install: "~/.claude/CLAUDE.md（<system-reminder> 块）", slash: "~/.claude/commands/purge.md" },
	codex: { slash: "~/.codex/prompts/purge.md" },
	opencode: { slash: "~/.opencode/command/purge.md" },
};

/** 桌面形态优先、终端只是附带的：双击启动绕开 PATH，shim 注定拦不到 */
const DESKTOP_FIRST = new Set(["zcode", "antigravity", "workbuddy", "workbuddy-ai", "pi-desktop"]);
/** 裸命令接管的落点名必须等于 harness 名；CLI 叫别的名字的家（antigravity 的 agy）翻不回来 */
const NO_SHIM = new Set(["antigravity"]);
/** 命令名和 harness id 不一致的：shim 探测要按真实二进制名走 */
const BIN_ALIAS = { kiro: "kiro-cli", continue: "cn", qoder: "qodercli" };

/** 人工核过的特例原因（写不出通用条件的那种） */const WHY = {
	antigravity: {
		shim: "CLI 命令名是 agy（不是 antigravity），裸命令接管按 harness 名找二进制找错了；桌面版双击启动也绕开 PATH",
		install: null,
	},
	workbuddy: {
		shim: "WorkBuddy 是桌面客户端，双击启动绕开 PATH；走 settings.json 身份上下文（install）",
	},
	"workbuddy-ai": {
		shim: "WorkBuddy 国际版是桌面客户端，双击启动绕开 PATH；走 settings.json 身份上下文（install）",
	},
	// dsh 的 CLI 只能起 headless：接管裸命令会把桌面/网页入口静默改道
	dsh: { shim: "dsh 命令行只能起 headless：接管裸命令会让双击/网页入口变成终端会话；要三形态就装常驻插件（install）" },
	codebuddy: {
		install: "只有 settings.json（插件开关/模型），没有能把文本塞进提示的词条；实测只能走启动参数或壳",
	},
};

/** 整家不可注入时的统一说明（matrix.reason 没有覆盖到的人工补） */
const BLOCKED = {};

/**
 * 会话内热切 = 进程每轮重拼 system。触发面分两种：
 *  command —— 会话里打 /purge（只有 pi 的扩展钩子能做到）
 *  state   —— 改设置/换人设，下一轮就生效（插件每轮读 state.json）
 */
const HOT = {
	"pi-desktop": { kind: "command", needs: "slash", how: "imported 插件贡献 ExtensionAPI：before_agent_start 每轮读 state.json 并改写 systemPrompt，/purge 与换人设都即时生效（首次安装需重启一次）" },
	pi: { kind: "command", needs: "slash", how: "扩展钩子 before_agent_start：/purge 或改设置，下一轮生效" },
	omp: { kind: "command", needs: "slash", how: "扩展钩子 before_agent_start 改写 systemPrompt 数组：/purge 或改设置，下一轮生效" },
	opencode: { kind: "state", needs: "install", how: "插件钩子 chat.system.transform 每轮读 state.json + active.md：改设置下一轮生效" },
	dsh: { kind: "command", needs: "slash", how: "cordis 插件注册 /purge：改 state.json，下一句生效，不产生模型消息" },
	opencode2: { kind: "state", needs: "install", how: "v2 插件 ctx.session.hook('context') 每轮读 state.json + active.md：改设置下一轮生效" },
};

/** 没有每轮拼装点的：说明为什么只能重启 */
const NOT_HOT = {
	claude: "system 只在启动时拼一次；会话内只能往 user 消息里塞（实测 0/2）",
	codex: "config.toml 启动时读；会话内没有能重拼 system 的钩子",
	grok: "AGENTS.md 启动时读一次",
	hermes: "SOUL.md 只在会话首次/重建时读；续会话沿用 session DB 里的 system 提示词，改文件不当场生效（agent/conversation_loop.py::_restore_or_build_system_prompt）",
	zcode: "桌面版闭源，没有插件与命令钩子",
	codebuddy: "只有启动参数",
	kilo: "code agent prompt 启动时读；AGENTS.md 会话启动时读",
	antigravity: "全局 AGENTS.md 只在会话启动时读；改了要新会话（<identity> 段仍在，靠规则段压住）",
};

function reason(id, channel) {
	return WHY[id]?.[channel] ?? null;
}

/**
 * 单家能力。ctx 可传 { bin, found }（来自 detect，省一次 PATH 扫描）；不传就现查。
 * 返回 { injectable, shim:{ok,why}, install:{ok,why}, slash:{ok,why} }
 */
export function capsFor(id, ctx = {}) {
	const spec = matrix.harnesses[id] ?? {};
	const injectable = spec.inject === false || spec.class === "unsupported" ? false : true;
	const blocked = !injectable
		? `这个工具注入不进去${spec.reason ? "：" + spec.reason : BLOCKED[id] ? "：" + BLOCKED[id] : typeof spec.override === "string" ? "：" + spec.override : ""}`
		: null;

	const cliPath = ctx.bin ?? null;
	const hasCli = Object.hasOwn(ctx, "bin") ? Boolean(cliPath) : Boolean(resolveReal(BIN_ALIAS[id] ?? id));
	const desktop = DESKTOP_FIRST.has(id);

	// 名字对不上的家（antigravity 的 CLI 叫 agy）先说清原因：PATH 探不到它，装好了也接管不到
	const shimWhy = blocked
		? blocked
		: NO_SHIM.has(id)
			? reason(id, "shim")
			: !hasCli
				? desktop
					? "本机没有命令行入口；桌面版双击/开始菜单启动也不经过 PATH —— 裸命令接管对它无效"
					: `本机 PATH 里找不到 ${id}（先把它装到 PATH 上）`
				: desktop
					? `只对终端里敲 \`${id}\` 生效；桌面图标启动绕开 PATH`
					: reason(id, "shim");

	const t = persistTargets[id];
	// dsh 的插件只能装进已经存在的 profile；没跑过 dsh 时按钮不该显示“可用”。
	const noProfilesWhy =
		id === "dsh" && liveProfiles().length === 0
			? "找不到任何 dsh profile（~/.dsh/profiles/*/package.json）—— 先启动一次 dsh，让它把 profile 建好"
			: null;
	// user 层不算能力：写下去也压不住 harness 自己的身份，装了等于白装
	const layerWhy =
		t && t.layer && t.layer !== SYS_LAYER
			? `${id} 的常驻文件只落到 ${t.layer} 层（${t.note ?? "上下文块"}）——压不住系统提示词；要 sys 层只能启动时换（agent-purge ${id}）`
			: null;
	const installWhy = blocked ? blocked : !PERSIST_IDS.has(id) ? (reason(id, "install") ?? "没有可写的配置文件") : (noProfilesWhy ?? layerWhy);

	const slashWhy = blocked
		? blocked
		: !SLASH_IDS.has(id)
			? `${id} 没有能改系统提示词的 /purge（/purge 展开成用户消息，实测无效；只有 pi/omp 的扩展和 dsh 的 cordis 插件能做到）`
			: noProfilesWhy;

	// 项目级通道：写进当前目录的 AGENTS.md / CLAUDE.md，没有该文件的家不摆开关
	const projectName = projectTargets[id] ?? null;
	// 有 md 但只进用户上下文的：不摆开关（摆了也改不了身份），但必须把原因说对
	const PROJECT_USER_ONLY = {
		workbuddy:
			"WorkBuddy 只把 CODEBUDDY.md / AGENTS.md 当首轮「用户上下文」（<project_context>，8000 字符上限，前者盖住后者），压不住系统身份——身份走 settings.json 的 customPrompt",
		"workbuddy-ai":
			"WorkBuddy 国际版只把 CODEBUDDY.md / AGENTS.md 当首轮「用户上下文」（<project_context>，8000 字符上限，前者盖住后者），压不住系统身份——身份走 settings.json 的 customPrompt",
	};
	const projectWhy =
		blocked ?? (projectName ? null : (PROJECT_USER_ONLY[id] ?? `${id} 没有项目级规则文件（AGENTS.md/CLAUDE.md）可写`));

	return {
		injectable,
		shim: { ok: !shimWhy || (desktop && hasCli && !NO_SHIM.has(id)), why: shimWhy },
		install: {
			ok: !installWhy,
			why: installWhy,
			// 有落点、但落点压不住系统提示词 → 不当作可选项给出去（UI 也不显示）
			hidden: Boolean(layerWhy),
			hiddenLabel: layerWhy ? (HIDDEN_LABEL[id]?.install ?? t?.file?.()) : null,
			layer: t?.layer ?? null,
			note: t?.note ?? null,
			verified: NOT_LIVE_TESTED.has(id) ? false : true,
		},
		hot: (() => {
			const h = HOT[id];
			if (!h) return { ok: false, kind: null, why: NOT_HOT[id] ?? `${id} 的 system 提示只在启动时拼一次`, how: null, needs: null };
			// 热切靠哪个通道：那个通道不可用就不算热切能力
			const dependent = h.needs === "slash" ? !slashWhy : !installWhy;
			return {
				ok: Boolean(dependent),
				kind: h.kind,
				why: dependent ? null : h.needs === "slash" ? slashWhy : installWhy,
				how: h.how,
				needs: h.needs,
			};
		})(),
		slash: {
			ok: !slashWhy,
			why: slashWhy,
			// 不能改系统提示词的 /purge 一律不摆出来：一个点了没反应的按钮比没有更糟
			hidden: Boolean(slashWhy),
			hiddenLabel: HIDDEN_LABEL[id]?.slash ?? null,
		},
		project: {
			ok: !projectWhy,
			why: projectWhy,
			file: projectName,
			note: projectName ? PROJECT_NOTE : null,
		},
		// 点名启动：`agent-purge <h>` 是 sys 层注入，不进 PATH、不改配置、不依赖 /purge。
		// 它是 launch-arg 型 harness 唯一的真通道，所以必须参与「这家到底能不能注入」的判定。
		launch: {
			// backend：后端到底有没有这条注入实现（跟本机装没装无关）
			backend: !blocked && launchOk(id),
			// ok：现在真能用（后端在 + 本机有这个命令）
			ok: !blocked && launchOk(id) && hasCli,
			// 后端在但本机没命令：说“先装 CLI”，而不是含糊地说注入不进去
			why: blocked ?? (launchOk(id)
				? (hasCli ? null : `本机 PATH 里找不到 ${BIN_ALIAS[id] ?? id}（装好后 agent-purge ${id} 才会带人设启动）`)
				: LAUNCH_WHY[id] ?? `${id} 没有可用的启动注入后端（agent-purge ${id} 只能原样启动）`),
			how: launchHow(id),
		},
	};
}

/** 一次算全部（CLI --all / Web 首屏用） */
export function capsAll(ids, detectMap = {}) {
	return Object.fromEntries(ids.map((id) => [id, capsFor(id, detectMap[id] ?? {})]));
}

/** 至少有一条通道能用吗？全不能用 = 这家只能「原样启动」 */
export function anyChannel(id, ctx) {
	const c = capsFor(id, ctx);
	return c.shim.ok || c.install.ok || c.slash.ok || c.launch.ok;
}
