// 会话内 `/purge`：把当前 persona 装进去，之后在这个会话里说一句 `/purge` 就切。
//
// 这里是整个项目里唯一"照实说实话"的地方：**斜杠命令不等于系统提示词注入**。
//   pi / omp  —— 扩展能在 before_agent_start 改写 systemPrompt → sys 层，热切换（实测 100%）
//   claude    —— ~/.claude/commands/purge.md 是**用户消息展开** → user 层
//   codex     —— ~/.codex/prompts/purge.md 同上 → user 层
//   opencode  —— ~/.config/opencode/command/purge.md 同上 → user 层（sys 层要靠 plugin 常驻）
// user 层的注入成功率由 matrix.json 的 armor.probe.*.user 记录，`agent-purge ls` 会标出来。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detect } from "./detect.mjs";
import { SLASH_RESIDENT, addPlugin, hasPluginAny, pluginFileOnDisk, removePlugin, slashSource } from "./dsh.mjs";

const SIDECAR = ".disabled-by-agent-purge";

/** 谁有 /purge、走哪层、文件放哪 */
export function resolveSlash(id, root) {
	const homes = detect();
	const homeOf = (name) => homes?.[name]?.home ?? null;
	const specs = {
		pi: () => {
			const base = homeOf("pi");
			if (!base) return null;
			return {
				layer: "sys",
				offered: true,
				hot: true,
				trigger: "/purge on|off|status|mode",
				file: join(base, "extensions", "agent-purge.ts"),
				render: () => piExtension(root),
				note: "扩展在 before_agent_start 改写 systemPrompt：真系统提示词层，且跟随 state.json 换人设，无需重装",
			};
		},
		claude: () => {
			const base = homeOf("claude");
			if (!base) return null;
			return {
				layer: "user",
				offered: false,
				hot: false,
				trigger: "/purge",
				file: join(base, "commands", "purge.md"),
				render: ({ personaBody, personaId }) => commandMd("把本次会话的规则切换为 agent-purge 当前人设", personaBody, personaId),
				note: "claude 的 slash command 展开成用户消息 → user 层（bench 实测 0/2 无效）；人设要生效请走 agent-purge claude（--system-prompt-file）",
			};
		},
		codex: () => {
			const base = homeOf("codex");
			if (!base) return null;
			return {
				layer: "user",
				offered: false,
				hot: false,
				trigger: "/purge",
				file: join(base, "prompts", "purge.md"),
				render: ({ personaBody, personaId }) => `${personaBody.trim()}\n\n<!-- agent-purge: ${personaId} -->\n`,
				note: "codex 的自定义 prompt 是用户消息 → user 层（bench 实测 0/2 无效）；codex 只认启动时读的 model_instructions_file",
			};
		},
		opencode: () => {
			const base = homeOf("opencode");
			if (!base) return null;
			return {
				layer: "user",
				offered: false,
				hot: false,
				trigger: "/purge",
				file: join(base, "command", "purge.md"),
				render: ({ personaBody, personaId }) => commandMd("装入 agent-purge 当前人设", personaBody, personaId),
				note: "opencode 的 command 是用户消息 → user 层（bench 实测 0/2 无效）；要 sys 层请用 install（chat.system.transform 插件）",
			};
		},
		omp: () => {
			const base = homeOf("omp");
			if (!base) return null;
			return {
				layer: "sys",
				offered: true,
				hot: true,
				trigger: "/purge on|off|status|mode",
				file: join(base, "agent", "extensions", "agent-purge.ts"),
				render: () => ompExtension(root),
				note: "扩展在 before_agent_start 改写 systemPrompt 数组：真系统提示词层，/purge 热切，下一轮生效",
			};
		},
		// dsh：不是写文件，而是往三个 profile 各装一个 cordis 小插件（agent-purge-slash）。
		// 它只注册 /purge 命令、改 state.json，不碰系统提示词 —— 注入归 agent-purge 常驻插件。
		dsh: () => ({
			layer: "sys",
			offered: true,
			hot: true,
			trigger: "/purge on|off|status|mode",
			file: pluginFileOnDisk(SLASH_RESIDENT),
			// 真值看挂载块 + 文件，不看某个 profile 的固定路径（没建过 desktop 就无意义）；任一份在就算能用
			probe: () => hasPluginAny(SLASH_RESIDENT),
			render: () => slashSource(root),
			note: "cordis 插件注册 /purge（/ap 为别名）：改 state.json，下一句生效，不产生模型消息",
		}),
	};
	const spec = specs[id];
	if (!spec) return null;
	const base = spec();
	if (!base) return null;
	return { id, ...base };
}

export function installSlash(id, root, { personaId, personaBody }) {
	const s = resolveSlash(id, root);
	if (!s) return { error: `${id} 没有 /purge 通道` };
	if (s.offered === false) return { error: `${s.note}（已下线，不再提供）` };
	// dsh：装 cordis 插件到三个 profile，没有单文件可写
	if (id === "dsh") {
		const r = addPlugin(SLASH_RESIDENT, slashSource(root));
		return { file: pluginFileOnDisk(SLASH_RESIDENT), layer: s.layer, note: s.note, sidecars: [], profiles: r.profiles };
	}
	mkdirSync(dirname(s.file), { recursive: true });

	// pi：旧的 pi-purge.ts 也注册 /purge，会撞名 → 先移开，卸载时还原
	const sidecars = [];
	if (id === "pi") {
		const legacy = join(dirname(s.file), "pi-purge.ts");
		if (existsSync(legacy)) {
			const off = legacy + SIDECAR;
			rmSync(off, { force: true });
			renameSync(legacy, off);
			sidecars.push({ from: off, to: legacy });
		}
	}

	writeFileSync(s.file, s.render({ personaId, personaBody }), "utf8");
	return { file: s.file, layer: s.layer, note: s.note, sidecars };
}

export function uninstallSlash(id, root) {
	const s = resolveSlash(id, root);
	if (!s) return { error: `${id} 没有 /purge 通道` };
	if (id === "dsh") {
		removePlugin(SLASH_RESIDENT);
		return { removed: [s.file] };
	}
	const removed = [];
	if (existsSync(s.file)) {
		rmSync(s.file, { force: true });
		removed.push(s.file);
	}
	if (id === "pi") {
		const legacy = join(dirname(s.file), "pi-purge.ts");
		if (existsSync(legacy + SIDECAR)) {
			renameSync(legacy + SIDECAR, legacy);
			removed.push(`${legacy}（已还原原 pi-purge 扩展）`);
		}
	}
	return { removed };
}

export function slashStatus(root) {
	const out = [];
	for (const id of Object.keys({ pi: 1, omp: 1, claude: 1, codex: 1, opencode: 1, dsh: 1 })) {
		const s = resolveSlash(id, root);
		if (!s) continue;
		const installed = s.probe ? s.probe() : existsSync(s.file);
		let personaId = null;
		if (installed && existsSync(s.file)) {
			const text = readFileSync(s.file, "utf8");
			personaId = (text.match(/agent-purge: ([a-z0-9_-]+)/i) || [])[1] ?? (id === "pi" || id === "omp" ? "(跟随 state.json)" : null);
		}
		out.push({ id, layer: s.layer, offered: s.offered !== false, hot: s.hot, file: s.file, installed, personaId, trigger: s.trigger, note: s.note });
	}
	return out;
}

/** 换人设后重渲染已安装的 user 层命令文件（它们是烘焙进去的，必须刷新） */
export function refreshSlashes(root, armedIds, { personaId, personaBody }) {
	const updated = [];
	for (const id of armedIds) {
		const s = resolveSlash(id, root);
		if (!s?.hot && s && s.offered !== false && existsSync(s.file)) {
			writeFileSync(s.file, s.render({ personaId, personaBody }), "utf8");
			updated.push(s.file);
		}
	}
	return updated;
}

function commandMd(description, body, personaId) {
	return `---\ndescription: ${description}\n---\n\n${body.trim()}\n\n<!-- agent-purge: ${personaId} -->\n`;
}

/** pi 扩展源码：每次 before_agent_start 现读 state.json → 换 persona 立即跟着变 */
function piExtension(root) {
	const statePath = join(root, "state.json").replace(/\\/g, "/");
	const personasDir = join(root, "personas").replace(/\\/g, "/");
	return `/**
 * agent-purge 生成的 /purge 扩展（删除本文件即取消）。
 * 与手写版 pi-purge 的区别：人设不内嵌，每次现读 state.json → 换 persona 下一轮就跟上。
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 数据目录跟安装目录解耦：AGENT_PURGE_HOME 优先，没有才用安装时记住的路径
const HOME = process.env.AGENT_PURGE_HOME ? String(process.env.AGENT_PURGE_HOME).replace(/\\\\/g, "/") : null;
const STATE = (HOME ? HOME + "/state.json" : ${JSON.stringify(statePath)});
const PERSONAS = (HOME ? HOME + "/personas" : ${JSON.stringify(personasDir)});
const HOST_IDENTITY = "You are an expert coding assistant operating inside pi";

function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---")) return raw;
	const end = raw.indexOf("\\n---", 3);
	return end === -1 ? raw : raw.slice(end + 4).replace(/^\\r?\\n/, "");
}

function loadPersona(): { id: string | null; body: string } {
	try {
		const state = JSON.parse(readFileSync(STATE, "utf8")) as { persona?: string };
		// 启动器的 --persona 优先于 state.json：否则 --persona X 只有 env 变了、人设还是旧的那份
		const id = process.env.AGENT_PURGE_PERSONA ?? state.persona ?? null;
		if (!id) return { id: null, body: "" };
		const body = stripFrontmatter(readFileSync(PERSONAS + "/" + id + ".md", "utf8")).trim();
		return { id, body };
	} catch {
		return { id: process.env.AGENT_PURGE_PERSONA ?? null, body: "" };
	}
}

function loadState(): { persona: string | null; mode: string; shim: boolean; piAuto: boolean; piUserLayer: boolean } {
	// 启动器会用环境变量告知本次运行用的 persona/mode（--persona / --mode 覆盖）；
	// 否则读 state.json —— 注意 mode 存在 default.mode，不是顶层。
	const envPersona = process.env.AGENT_PURGE_PERSONA;
	const envMode = process.env.AGENT_PURGE_MODE;
	try {
		const st = JSON.parse(readFileSync(STATE, "utf8")) as {
			persona?: string;
			default?: { harness?: string; mode?: string };
			armed?: Record<string, string[]>;
			piAuto?: boolean;
			piUserLayer?: boolean;
		};
		return {
			persona: envPersona ?? st.persona ?? null,
			mode: st.default?.mode ?? "replace",
			shim: Array.isArray(st.armed?.pi) && st.armed.pi.includes("shim"),
			piAuto: st.piAuto === true,
			piUserLayer: st.piUserLayer === true,
		};
	} catch {
		return { persona: envPersona ?? null, mode: "replace", shim: false, piAuto: process.env.AGENT_PURGE_FORCE === "1", piUserLayer: false };
	}
}

function cutHostIdentity(prompt: string): string {
	const at = prompt.indexOf(HOST_IDENTITY);
	if (at === -1) return prompt;
	const lineEnd = prompt.indexOf("\\n", at);
	return prompt.slice(0, at) + prompt.slice(lineEnd === -1 ? prompt.length : lineEnd + 1);
}

export default function agentPurge(pi: ExtensionAPI) {
	// 自动注入的唯一开关：启动器明确要求（AGENT_PURGE_FORCE=1）。
	// 谁会设它：agent-purge pi，以及 PATH 上的接管壳（它就是把命令转给 agent-purge pi）。
	// 所以“只装会话内热切”的扩展不会自己开工；直呼真身二进制也不会被劫持。
	let forced: "on" | "off" | null = null;
	let mode: "strict" | "replace" | "append" = "strict";
	// 启动器用 AGENT_PURGE_MODE 指定本次启动的初始模式；/purge mode 必须能覆盖它，
	// 否则环境变量会在每轮把热切换改回去。
	const ENV_MODE = process.env.AGENT_PURGE_MODE;
	let modeOverride: "strict" | "replace" | "append" | "off" | null =
		ENV_MODE === "off" ? "off" : ENV_MODE === "strict" || ENV_MODE === "append" ? ENV_MODE : ENV_MODE ? "replace" : null;
	let cache = { id: null as string | null, body: "" };

	// 两条来源：启动器点名（FORCE=1），或 state.json 的 piAuto（裸敲 pi 也注入）
	const autoOn = (st: { piAuto?: boolean }) =>
		process.env.AGENT_PURGE_FORCE === "1" || st.piAuto === true;

	pi.on("session_start", async () => {
		forced = null;
		cache = { id: null, body: "" };
	});

	pi.on("before_agent_start", async (event) => {
		const st = loadState();
		const effective = modeOverride ?? st.mode;
		mode = effective === "strict" || effective === "append" ? effective : "replace";
		const on = effective === "off" ? "off" : (forced ?? (st.persona && autoOn(st) ? "on" : "off"));
		if (on !== "on") return;
		cache = loadPersona();
		if (!cache.body) return;
		if (mode === "strict") {
			const cwd = event.systemPromptOptions?.cwd;
			return { systemPrompt: cwd ? cache.body + "\\n\\nCurrent working directory: " + String(cwd).replace(/\\\\/g, "/") : cache.body };
		}
		const host = mode === "replace" ? cutHostIdentity(event.systemPrompt) : event.systemPrompt;
		return { systemPrompt: host.length > 0 ? cache.body + "\\n\\n" + host : cache.body };
	});

	// 真正保证“会话中途热切也生效”的是这个拦截面：每个模型请求前重写 transcript 里的
	// system 消恵。before_agent_start 的返回值在部分 pi 版本上只对首轮生效（会话已有上下文时
	// 会被 transcript 覆盖），所以这里再兜一层；两层同时生效时靠 body 前缀去重。
	try {
		pi.on("context_with_system", async (event: any) => {
			const st = loadState();
			const m = modeOverride ?? st.mode;
			const on = m === "off" ? "off" : (forced ?? (st.persona && autoOn(st) ? "on" : "off"));
			if (on !== "on") return;
			const p = loadPersona();
			if (!p.body) return;
			const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
			if (messages.length === 0) return;
			const textOf = (msg: any): string => {
				const c = msg?.content;
				if (typeof c === "string") return c;
				if (Array.isArray(c)) return c.map((b: any) => (b && typeof b.text === "string" ? b.text : "")).join("");
				return "";
			};
			// pi 1.4 约定：这个钩子的返回值会被忽略，必须原地改 event.messages
			const out = messages;
			const at = out.findIndex((msg: any) => msg?.role === "system");
			const host = at >= 0 ? textOf(out[at]) : "";
			if (!host.includes(p.body.slice(0, 40))) {
				let next: string;
				if (m === "strict") next = p.body;
				else if (m === "append") next = (host ? host + "\\n\\n" : "") + p.body;
				else next = host ? p.body + "\\n\\n" + cutHostIdentity(host) : p.body;
				if (at >= 0) out[at].content = next;
				else out.unshift({ role: "system", content: next });
			}

			// 有些模型（实测 deepseek-v4.1-flash 走 mg 网关）直接无视 system 角色：
			// 再往最后一条用户消息前面贴一份，让指令一定被看到。
			if (st.piUserLayer) {
				for (let i = out.length - 1; i >= 0; i--) {
					if (out[i]?.role !== "user") continue;
					const shown = textOf(out[i]);
					if (shown.includes(p.body.slice(0, 40))) break;
					out[i].content = "<agent-purge>\\n" + p.body + "\\n</agent-purge>\\n\\n" + shown;
					break;
				}
			}
			return;
		});
	} catch {
		// 老版本 pi 没有 context_with_system：退回 before_agent_start 的返回值
	}

	pi.registerCommand("purge", {
		description: "会话级接管开关（人设跟随 agent-purge 的 state.json）",
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "always", "status", "reload", "mode"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			const cmd = (args.trim().split(/\\s+/)[0] ?? "").toLowerCase();
			const notify = (t: string, level: "info" | "error" = "info") => ctx.ui.notify(t, level);
			const describe = () => {
				const p = loadPersona();
				const st = loadState();
				const effective = modeOverride ?? st.mode;
				const on = effective === "off" ? "off" : (forced ?? (st.persona && autoOn(st) ? "on" : "off"));
				const why =
					on === "on"
						? forced
							? "本会话 /purge 开的"
							: process.env.AGENT_PURGE_FORCE === "1"
								? "启动器要求注入"
								: "接管裸命令已开"
						: effective === "off"
							? "总电源关着"
							: st.piAuto
								? "裸启动已开，这次是你手动关的"
								: "只装了会话内热切，裸启动不注入";
				return [
					"状态: " + (on === "on" ? "开启" : "关闭") + "（" + why + "）",
					"模式: " + effective,
					"裸启动也注入: " + (st.piAuto ? "开" : "关") + "（/purge always on|off）",
					"人设: " + (p.id ?? "(state.json 里没有 persona)") + "  " + (p.body.length ? p.body.length + " 字符" : "未加载"),
					"来源: " + STATE,
				].join("\\n");
			};
			const turnOn = () => {
				const st = loadState();
				if ((modeOverride ?? st.mode) === "off") return notify("总电源关着（state.default.mode=off）：先开电源，/purge 才能注入", "error");
				const p = loadPersona();
				if (!p.body) return notify("开启失败：state.json 里没有可用 persona（先 agent-purge use <id>）", "error");
				forced = "on";
				cache = p;
				notify("已开启（仅本会话），每轮注入 " + p.body.length + " 字符。\\n" + describe());
			};
			switch (cmd) {
				case "": {
					// 空参 = 切换。判断依据是“现在到底注不注入”，不是只看本会话手工按过什么：
					// 直接裸启动 pi 的时候 forced 是 null、注入本来是关的，第一次 /purge 应该是「开」而不是「关」。
					const st = loadState();
					const injecting =
						(modeOverride ?? st.mode) !== "off" && (forced === "on" || (forced === null && Boolean(st.persona) && autoOn(st)));
					if (!injecting) return turnOn();
					forced = "off";
					return notify("已关闭本会话注入，恢复 pi 原始系统提示词。再输入 /purge 即重新开启。");
				}
				case "on":
					return turnOn();
				case "off":
					forced = "off";
					return notify("已关闭本会话注入，恢复 pi 原始系统提示词。");
				case "status":
					return notify(describe());
				case "reload":
					// reload 只重读磁盘；本会话手工开的开关不能被重置
					cache = loadPersona();
					return notify("已重读 state.json（本会话开关不变）。\\n" + describe());
				case "mode": {
					const want = args.trim().split(/\\s+/)[1];
					if (want !== "strict" && want !== "replace" && want !== "append") {
						return notify("用法: /purge mode strict|replace|append\\nstrict=只发人设；replace=清宿主身份句；append=宿主后追加", "error");
					}
					try {
						// 以前只改内存局部变量，下一轮就被 state.json 覆盖 → 写进去才算真切换
						const raw = JSON.parse(readFileSync(STATE, "utf8")) as Record<string, any>;
						raw.default = { ...(raw.default ?? { harness: "pi" }), mode: want };
						writeFileSync(STATE, JSON.stringify(raw, null, 2) + "\\n");
						modeOverride = want;
						return notify("模式 → " + want + "（已写入 state.json，下一轮生效）\\n" + describe());
					} catch (e) {
						return notify("写 state.json 失败: " + String(e), "error");
					}
				}
				case "always": {
					const want = args.trim().split(/\\s+/)[1];
					if (want !== "on" && want !== "off")
						return notify("用法: /purge always on|off —— 让裸敲 pi 也自动注入（写 state.json，新会话生效）", "error");
					try {
						const raw = JSON.parse(readFileSync(STATE, "utf8")) as Record<string, unknown>;
						raw.piAuto = want === "on";
						writeFileSync(STATE, JSON.stringify(raw, null, 2) + "\\n");
						return notify("已写入 piAuto=" + want + "（新会话起生效）\\n" + describe());
					} catch (e) {
						return notify("写 state.json 失败: " + String(e), "error");
					}
				}
				default:
					return notify("用法: /purge [on|off|always on|off|status|reload|mode strict|replace|append]", "error");
			}
		},
	});
}
`;
}

/** omp 扩展源码：每轮 before_agent_start 现读 state.json，/purge 热切 */
function ompExtension(root) {
	const statePath = join(root, "state.json").replace(/\\/g, "/");
	const personasDir = join(root, "personas").replace(/\\/g, "/");
	return `/**
 * agent-purge 生成的 /purge 扩展（omp 版；删除本文件即取消）。
 * 人设不内嵌：每次 before_agent_start 现读 state.json → 换 persona / 改模式下一轮就跟上。
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const HOME = process.env.AGENT_PURGE_HOME ? String(process.env.AGENT_PURGE_HOME).replace(/\\\\/g, "/") : null;
const STATE = (HOME ? HOME + "/state.json" : ${JSON.stringify(statePath)});
const PERSONAS = (HOME ? HOME + "/personas" : ${JSON.stringify(personasDir)});

function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---")) return raw;
	const end = raw.indexOf("\\n---", 3);
	return end === -1 ? raw : raw.slice(end + 4).replace(/^\\r?\\n/, "");
}

function loadPersona(): { id: string | null; body: string } {
	try {
		const st = JSON.parse(readFileSync(STATE, "utf8")) as { persona?: string };
		const id = process.env.AGENT_PURGE_PERSONA ?? st.persona ?? null;
		if (!id) return { id: null, body: "" };
		return { id, body: stripFrontmatter(readFileSync(PERSONAS + "/" + id + ".md", "utf8")).trim() };
	} catch {
		return { id: process.env.AGENT_PURGE_PERSONA ?? null, body: "" };
	}
}

function loadState(): { persona: string | null; mode: string; ompAuto: boolean } {
	const envPersona = process.env.AGENT_PURGE_PERSONA;
	const envMode = process.env.AGENT_PURGE_MODE;
	try {
		const st = JSON.parse(readFileSync(STATE, "utf8")) as {
			persona?: string;
			default?: { harness?: string; mode?: string };
			ompAuto?: boolean;
		};
		return {
			persona: envPersona ?? st.persona ?? null,
			mode: envMode ?? st.default?.mode ?? "replace",
			ompAuto: st.ompAuto === true,
		};
	} catch {
		return { persona: envPersona ?? null, mode: envMode ?? "replace", ompAuto: process.env.AGENT_PURGE_FORCE === "1" };
	}
}

function toLines(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v));
	return value ? [String(value)] : [];
}

export default function agentPurge(pi: ExtensionAPI) {
	let forced: "on" | "off" | null = null;
	// 启动器的 AGENT_PURGE_MODE 只决定初始模式；/purge mode 必须能盖住它，
	// 否则下一轮又被环境变量改回去。
	const ENV_MODE = process.env.AGENT_PURGE_MODE;
	let modeOverride: "strict" | "replace" | "append" | "off" | null =
		ENV_MODE === "off" ? "off" : ENV_MODE === "strict" || ENV_MODE === "append" ? ENV_MODE : ENV_MODE ? "replace" : null;
	let cache = { id: null as string | null, body: "" };
	const autoOn = (st: { ompAuto?: boolean }) => process.env.AGENT_PURGE_FORCE === "1" || st.ompAuto === true;

	pi.on("session_start", async () => {
		forced = null;
		cache = { id: null, body: "" };
	});

	// omp 每轮重拼 system 提示词；这里直接返回新的 systemPrompt（string[]）。
	pi.on("before_agent_start", async (event) => {
		const st = loadState();
		const effective = modeOverride ?? st.mode;
		const mode = effective === "strict" || effective === "append" ? effective : "replace";
		const on = effective === "off" ? "off" : (forced ?? (st.persona && autoOn(st) ? "on" : "off"));
		if (on !== "on") return;
		cache = loadPersona();
		if (!cache.body) return;
		const hostBlocks = toLines((event as any).systemPrompt).filter((l: string) => l.length > 0);
		// AGENTS.md 常驻通道可能已经把同一份人设塞进 systemPrompt：前缀相同就别再叠一遍
		if (hostBlocks.some((b: string) => b.includes(cache.body.slice(0, 40)))) return;
		// strict=只发人设；replace=用新人设换掉基础身份块、保留 PROJECT 块；append=原样保留再追加
		if (mode === "strict") return { systemPrompt: [cache.body] };
		if (mode === "append") return { systemPrompt: [...hostBlocks, cache.body] };
		const projectBlocks = hostBlocks.filter((b: string, i: number) => i > 0 || b.trim().startsWith("PROJECT"));
		return { systemPrompt: [cache.body, ...projectBlocks] };
	});

	pi.registerCommand("purge", {
		description: "会话级接管开关（人设跟随 agent-purge 的 state.json）",
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "always", "status", "reload", "mode"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx: any) => {
			const cmd = (args.trim().split(/\\s+/)[0] ?? "").toLowerCase();
			const notify = (t: string, level: "info" | "error" = "info") => ctx.ui.notify(t, level);
			const describe = () => {
				const p = loadPersona();
				const st = loadState();
				const effective = modeOverride ?? st.mode;
				const on = effective === "off" ? "off" : (forced ?? (st.persona && autoOn(st) ? "on" : "off"));
				const why =
					on === "on"
						? forced
							? "本会话 /purge 开的"
							: process.env.AGENT_PURGE_FORCE === "1"
								? "启动器要求注入"
								: "裸启动已开"
						: effective === "off"
							? "总电源关着"
							: "只装了会话内热切，裸启动不注入";
				return [
					"状态: " + (on === "on" ? "开启" : "关闭") + "（" + why + "）",
					"模式: " + effective,
					"裸启动也注入: " + (st.ompAuto ? "开" : "关") + "（/purge always on|off）",
					"人设: " + (p.id ?? "(state.json 里没有 persona)") + "  " + (p.body.length ? p.body.length + " 字符" : "未加载"),
					"来源: " + STATE,
				].join("\\n");
			};
			const turnOn = () => {
				const st = loadState();
				if ((modeOverride ?? st.mode) === "off") return notify("总电源关着（state.default.mode=off）：先开电源，/purge 才能注入", "error");
				const p = loadPersona();
				if (!p.body) return notify("开启失败：state.json 里没有可用 persona（先 agent-purge use <id>）", "error");
				forced = "on";
				cache = p;
				notify("已开启（仅本会话），每轮注入 " + p.body.length + " 字符。\\n" + describe());
			};
			switch (cmd) {
				case "": {
					const st = loadState();
					const injecting =
						(modeOverride ?? st.mode) !== "off" && (forced === "on" || (forced === null && Boolean(st.persona) && autoOn(st)));
					if (!injecting) return turnOn();
					forced = "off";
					return notify("已关闭本会话注入，恢复 omp 原始系统提示词。再输入 /purge 即重新开启。");
				}
				case "on":
					return turnOn();
				case "off":
					forced = "off";
					return notify("已关闭本会话注入，恢复 omp 原始系统提示词。");
				case "status":
					return notify(describe());
				case "reload":
					cache = loadPersona();
					return notify("已重读 state.json（本会话开关不变）。\\n" + describe());
				case "mode": {
					const want = args.trim().split(/\\s+/)[1];
					if (want !== "strict" && want !== "replace" && want !== "append") {
						return notify("用法: /purge mode strict|replace|append\\nstrict=只发人设；replace=换基础提示、保留项目规则；append=宿主后追加", "error");
					}
					try {
						const raw = JSON.parse(readFileSync(STATE, "utf8")) as Record<string, any>;
						raw.default = { ...(raw.default ?? { harness: "omp" }), mode: want };
						writeFileSync(STATE, JSON.stringify(raw, null, 2) + "\\n");
						modeOverride = want;
						return notify("模式 → " + want + "（已写入 state.json，下一轮生效）\\n" + describe());
					} catch (e) {
						return notify("写 state.json 失败: " + String(e), "error");
					}
				}
				case "always": {
					const want = args.trim().split(/\\s+/)[1];
					if (want !== "on" && want !== "off")
						return notify("用法: /purge always on|off —— 让裸敲 omp 也自动注入（写 state.json，新会话生效）", "error");
					try {
						const raw = JSON.parse(readFileSync(STATE, "utf8")) as Record<string, unknown>;
						raw.ompAuto = want === "on";
						writeFileSync(STATE, JSON.stringify(raw, null, 2) + "\\n");
						return notify("已写入 ompAuto=" + want + "（新会话起生效）\\n" + describe());
					} catch (e) {
						return notify("写 state.json 失败: " + String(e), "error");
					}
				}
				default:
					return notify("用法: /purge [on|off|always on|off|status|reload|mode strict|replace|append]", "error");
			}
		},
	});
}
`;
}
