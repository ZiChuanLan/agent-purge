// 通道能力表：这家 harness 到底能不能用这条通道，不能用是为什么。
//
// 为什么要有这张表：UI 上给一个能点的开关、点了却什么都没发生，比不给开关更糟
// （实测踩过：zcode 是闭源桌面，双击启动根本不经过 PATH，裸命令接管对它永远无效）。
// 真相只有一处：矩阵（matrix.json）+ 持久化后端表（persist.mjs）+ /purge 支持表（slashes.mjs）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { targets as persistTargets } from "./persist.mjs";
import { resolveReal } from "./shim.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 通道存在、但本机没能真跑一次的（模型白名单 / 没有 CLI）：UI 标「文档」，不标「实测」 */
const NOT_LIVE_TESTED = new Set(["claude", "zcode"]);
const matrix = readMatrix();

function readMatrix() {
	try {
		return JSON.parse(readFileSync(join(ROOT, "matrix.json"), "utf8"));
	} catch (e) {
		throw new Error(`matrix.json 读不了：${e.message}`);
	}
}

/** 有 /purge 机制的 harness —— **只算能把内容写进系统提示词的**（pi/omp 的扩展钩子、dsh 的 cordis 插件） */
export const SLASH_IDS = new Set(["pi", "dsh", "omp"]);
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
const DESKTOP_FIRST = new Set(["zcode", "antigravity", "qoder", "workbuddy"]);

/** 人工核过的特例原因（写不出通用条件的那种） */const WHY = {
	antigravity: {
		shim: "桌面版按二进制启动，PATH 那条路拦不到；只有 binary patch 路线",
		install: "只有二进制补丁（notes/），没有配置可写",
	},
	qoder: { shim: "提示词在服务端，本地拦不到" },
	workbuddy: { shim: "提示词在服务端，本地拦不到" },
	// dsh 的 CLI 只能起 headless：接管裸命令会把桌面/网页入口静默改道
	dsh: { shim: "dsh 命令行只能起 headless：接管裸命令会让双击/网页入口变成终端会话；要三形态就装常驻插件（install）" },
	codebuddy: {
		install: "只有 settings.json（插件开关/模型），没有能把文本塞进提示的词条；实测只能走启动参数或壳",
	},
};

/** 整家不可注入时的统一说明（matrix.reason 没有覆盖到的人工补） */
const BLOCKED = { antigravity: "二进制补丁才能改它的系统提示，配置层没有可写入口" };

/**
 * 会话内热切 = 进程每轮重拼 system。触发面分两种：
 *  command —— 会话里打 /purge（只有 pi 的扩展钩子能做到）
 *  state   —— 改设置/换人设，下一轮就生效（插件每轮读 state.json）
 */
const HOT = {
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
	hermes: "SOUL.md 虽然是每轮重读，但没有会话内命令面，只能改文件",
	zcode: "桌面版闭源，没有插件与命令钩子",
	codebuddy: "只有启动参数",
	antigravity: "客户端常量，只能二进制补丁",
	qoder: "提示词在服务端",
	workbuddy: "提示词在服务端",
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
	const hasCli = Boolean(cliPath) || Boolean(resolveReal(id));
	const desktop = DESKTOP_FIRST.has(id);

	const shimWhy = blocked
		? blocked
		: !hasCli
			? desktop
				? "本机没有命令行入口；桌面版双击/开始菜单启动也不经过 PATH —— 裸命令接管对它无效"
				: `本机 PATH 里找不到 ${id}（先把它装到 PATH 上）`
			: desktop
				? `只对终端里敲 \`${id}\` 生效；桌面图标启动绕开 PATH`
				: reason(id, "shim");

	const t = persistTargets[id];
	// user 层不算能力：写下去也压不住 harness 自己的身份，装了等于白装
	const layerWhy =
		t && t.layer && t.layer !== SYS_LAYER
			? `${id} 的常驻文件只落到 ${t.layer} 层（${t.note ?? "上下文块"}）——压不住系统提示词；要 sys 层只能启动时换（agent-purge ${id}）`
			: null;
	const installWhy = blocked ? blocked : !PERSIST_IDS.has(id) ? (reason(id, "install") ?? "没有可写的配置文件") : layerWhy;

	const slashWhy = blocked
		? blocked
		: !SLASH_IDS.has(id)
			? `${id} 没有能改系统提示词的 /purge（/purge 展开成用户消息，实测无效；只有 pi/omp 的扩展和 dsh 的 cordis 插件能做到）`
			: null;

	return {
		injectable,
		shim: { ok: !shimWhy || (desktop && hasCli), why: shimWhy },
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
	};
}

/** 一次算全部（CLI --all / Web 首屏用） */
export function capsAll(ids, detectMap = {}) {
	return Object.fromEntries(ids.map((id) => [id, capsFor(id, detectMap[id] ?? {})]));
}

/** 至少有一条通道能用吗？全不能用 = 这家只能「原样启动」 */
export function anyChannel(id, ctx) {
	const c = capsFor(id, ctx);
	return c.shim.ok || c.install.ok || c.slash.ok;
}
