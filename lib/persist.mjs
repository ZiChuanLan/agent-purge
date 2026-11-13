// 持久化层：把 persona 写进 harness 自己的配置，这样用户在自己终端敲 codex 也生效。
// 分两类：托管块（文本文件，带标记，可精确删除）与插件文件（可删）。
// 不动二进制——这里只做可逆的配置改动。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RESIDENT as DSH_RESIDENT, SESSION as DSH_SESSION, addPlugin, hasPluginAny, pluginFileOnDisk, residentSource, removePlugin } from "./dsh.mjs";
import { dataHome } from "./home.mjs";
import { cancel, forgetHarness, record } from "./footprints.mjs";
import { opencodeSource } from "./opencode.mjs";
import { configHome } from "./paths.mjs";
import { installWorkbuddyPrompt, uninstallWorkbuddyPrompt, workbuddyActiveFile, workbuddyPromptBlocked } from "./workbuddy.mjs";
import { installKilocode, kiloBuildAgentFile, probeKilocode, uninstallKilocode } from "./kilocode.mjs";
import { antigravityAgentsFile, installAntigravity, probeAntigravity, uninstallAntigravity } from "./antigravity.mjs";


const BEGIN = "# >>> agent-purge";
const END = "# <<< agent-purge";
const home = process.env.USERPROFILE || process.env.HOME;
// opencode 认 XDG_CONFIG_HOME（lib/detect.mjs 也是这么探测的）：两处必须同一个落点，否则装了白装
export const opencodePlugins = () => join(configHome("opencode"), "plugins");

// 托管块的原字节备份。只靠 stripBlock 无法还原 install 前文件前后的空行，
// 所以把 before/after 记到数据目录；卸载时若文件仍是上次写入的样子就按原字节还原。
const stashDir = (root = dataHome()) => join(root, "stash");
const stashPath = (file, root = dataHome()) => {
	const full = resolve(file);
	return join(stashDir(root), createHash("sha256").update(process.platform === "win32" ? full.toLowerCase() : full).digest("hex").slice(0, 24) + ".json");
};
function readStash(file, root = dataHome()) {
	try {
		return JSON.parse(readFileSync(stashPath(file, root), "utf8"));
	} catch {
		return null;
	}
}
export function writeStash(file, record, root = dataHome()) {
	mkdirSync(stashDir(root), { recursive: true });
	writeFileSync(stashPath(file, root), JSON.stringify(record, null, 2) + "\n");
}
function clearStash(file, root = dataHome()) {
	rmSync(stashPath(file, root), { force: true });
}
/** 撤销链路对外暴露的只读接口（slashes 刷新命令文件时要接着上一份 before） */
export { readStash };
export function unusedBackup(file) {
	let path = `${file}.disabled-by-agent-purge`, n = 0;
	while (existsSync(path)) path = `${file}.disabled-by-agent-purge-${++n}`;
	return path;
}
export function preserveEdited(file, content) { const path = unusedBackup(file); writeFileSync(path, content, { flag: "wx" }); return path; }
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * 这个文件是不是我们写的？—— 旧账本没有 stash/指纹时的唯一依据。
 * 三个生成器都会留下固定标记：托管注释、托管块 marker、shim 头。
 */
export function looksOwned(text) {
	const s = String(text ?? "");
	return /agent-purge 托管|agent-purge shim|# >>> agent-purge|<!-- agent-purge:/.test(s);
}

/** 不是我们的文件就一个字节都别动——这是卸载路径的总闸门 */
const FOREIGN = "skipped-foreign";

/**
 * 撤掉一个「整份文件」类的落点（插件文件、命令文件、shim）。
 * 顺序：stash 原字节还原 > 账本指纹 > 内容标记；三条都对不上就当别人的文件，不碰。
 *
 * 为什么不能直接 rm：install 会把用户原有的同名文件整份覆盖（比如手改过的扩展），
 * 只记一个「文件路径」根本还原不回去。这里靠 stash.before 把原字节写回去。
 */
export function removeOwnedFile(file, { root = dataHome(), expectedSha = null } = {}) {
	if (!existsSync(file)) {
		clearStash(file, root);
		cancel(root, { kind: "file", path: file });
		return { file, action: "already-gone" };
	}
	const now = readFileSync(file, "utf8");
	const stash = readStash(file, root);

	// 1) 还是我们上次写进去的原字节：按 stash 还原（当初没有这个文件就删掉）
	if (stash && typeof stash.after === "string" && stash.after === now) {
		if (stash.before === null || stash.before === undefined) rmSync(file, { force: true });
		else writeFileSync(file, stash.before);
		clearStash(file, root);
		cancel(root, { kind: "file", path: file });
		return {
			file,
			action: stash.before == null ? "deleted-file" : "restored-file",
			exact: true,
		};
	}

	// 2) 没有 stash 的老安装：只认托管标记；有账本指纹的再确认一次是我们写的
	const ours = Boolean(expectedSha) && expectedSha === sha256(now);
	if (!stash && (ours || looksOwned(now))) {
		rmSync(file, { force: true });
		clearStash(file, root);
		cancel(root, { kind: "file", path: file });
		return { file, action: "deleted-file", exact: true };
	}

	// 3) 我们写的、但已被改过：删了会吃掉用户的字节 → 改名停用（宿主不再加载它，字节全留着）
	if (looksOwned(now)) {
		const off = unusedBackup(file);
		renameSync(file, off);
		if (stash?.before != null) writeFileSync(file, stash.before);
		clearStash(file, root);
		cancel(root, { kind: "file", path: file });
		return { file, action: "disabled-edited-file", moved: off };
	}

	// 4) 不是我们的文件：不删、不销账，交给 leftovers 报出来
	return { file, action: FOREIGN };
}
/** persona 正文里出现托管 marker 会让卸载定位错乱：install 前直接拒绝，而不是事后猜。 */
const hasMarker = (text) => /^(?:\s*)# (?:>>>|<<<) agent-purge/m.test(String(text ?? ""));

export const targets = {
	pi: {
		// pi 每次启动都读全局 AGENTS.md（“Global Agent Rules”），它就是 pi 唯一的 sys 层常驻口
		// 代价：正文是快照，换 persona 要重新 install
		file: () => join(configHome("pi"), "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "全局 AGENTS.md，每次启动重读；正文是快照，换人设要重装",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	claude: {
		// 用户级 CLAUDE.md：每次都读，但进入的是 <system-reminder> 的上下文块（USER 层），不是 system 数组
		file: () => join(configHome("claude"), "CLAUDE.md"),
		kind: "block",
		layer: "user",
		note: "CLAUDE.md 进的是 <system-reminder> 上下文块（用户消息），不是 system 数组",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	grok: {
		// grok 把全局 AGENTS.md 的内容 append 到系统提示；单文件上限 10000 字符，超了会被截
		file: () => join(configHome("grok"), "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "内容 append 进系统提示；单文件上限 10000 字符，超了会自动截断",
		body: (active) => clamp(readFileSync(active, "utf8").trim(), 9600),
	},
	zcode: {
		// 官方文档：~/.zcode/AGENTS.md 是“every workspace 的默认 instructions”（桌面闭源，无法抓包复核）
		file: () => join(configHome("zcode"), "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "官方文档写的默认 instructions 文件；桌面版闭源无法抓包复核，armor 实测 sys 层没捕获到这段内容，是否真落 system 未证实",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	omp: {
		// Oh My Pi 血统：~/.omp/agent/AGENTS.md 就是它的 rules 文件（--no-rules 关的就是它）
		file: () => join(configHome("omp"), "agent", "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "就是它的 rules 文件（--no-rules 关的就是这个）",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	hermes: {
		// SOUL.md 是身份槽位 #1；只在会话首次/重建时读，续会话用 session DB 里的 system 提示词
		file: () => join(configHome("hermes"), "SOUL.md"),
		kind: "block",
		layer: "sys",
		note: "SOUL.md 是身份槽位 #1，新会话才读（续会话沿用 session DB 的提示词）",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	codex: {
		file: () => join(configHome("codex"), "config.toml"),
		kind: "block",
		// TOML 顶层键必须写在第一个 [table] 之前：追加到文件尾会被解析成上一个表里的键
		position: "top",
		layer: "sys",
		note: "model_instructions_file 直接换掉它的指令文件（连 GUI/子进程启动都生效）",
		body: (active) => `model_instructions_file = "${active.replace(/\\/g, "/")}"`,
	},
	opencode: {
		// 写入用全局单一位置；读取/删除要扫全部历史位置，否则老版本留下的项目级插件会继续注入
		file: () => join(opencodePlugins(), "agent-purge.ts"),
		files: () => [
			join(opencodePlugins(), "agent-purge.ts"),
			// 旧落点：设了 XDG 的机器上，老版本写在 home/.config 的那份也得能被扫到并清掉
			join(home, ".config", "opencode", "plugins", "agent-purge.ts"),
			join(home, ".config", "opencode", "plugin", "agent-purge.ts"),
			join(process.cwd(), ".opencode", "plugin", "agent-purge.ts"),
		],
		kind: "file",
		layer: "sys",
		note: "插件改 chat.system（SYS 层真改）；每轮读 state.json + active.md，人设与模式（off/replace/append）全部热切",
		// 每轮请求都重拼一次 system：人设、模式都从 state.json 现读 → 真热切，不用重启
		body: (active, root) => opencodeSource(root, "opencode", { active }),
	},
	dsh: {
		// cordis 插件挂 systemPrompt 层；三个 profile 各一份（desktop 由 Electron 独占，装完要重启一次）
		file: () => pluginFileOnDisk(DSH_RESIDENT),
		kind: "file",
		layer: "sys",
		note: "cordis 插件包；运行时每轮读 state.json，开关 / 切模式 / 换人设都即时生效；只有首次安装要重启一次",
		probe: () => hasPluginAny(DSH_RESIDENT),
		install: ({ root, active }) => {
			const r = addPlugin(DSH_RESIDENT, residentSource(root, active));
			return { file: pluginFileOnDisk(DSH_RESIDENT), profiles: r.profiles, note: `实际 profile：${r.profiles.join("/")}；重启一次 DeepSeek Harness 后插件开始工作（之后热切换）` };
		},
		uninstall: () => {
			const file = pluginFileOnDisk(DSH_RESIDENT);
			const resident = removePlugin(DSH_RESIDENT);
			// 一次性插件被 SIGKILL 时不会自己清，一并扫掉
			const session = removePlugin(DSH_SESSION);
			return { file, profiles: [...new Set([...resident.profiles, ...session.profiles])], preserved: [...resident.preserved, ...session.preserved] };
		},
	},
	opencode2: {
		// v2 新版插件 API（V1 的 experimental.chat.system.transform 在 2.x 已废），与 V1 插件文件物理分开
		file: () => join(opencodePlugins(), "agent-purge-v2.ts"),
		files: () => [join(opencodePlugins(), "agent-purge-v2.ts"), join(opencodePlugins(), "agent-purge-v2-session.ts")],
		kind: "file",
		layer: "sys",
		note: "v2 插件 ctx.session.hook(\"context\")；运行时读 state.json，热切",
		body: (active, root) => opencodeSource(root, "opencode2", { active }),
	},
	workbuddy: {
		// WorkBuddy 的原生身份槽位：personalization.customPrompt，
		// 进入 identity_context / user_custom_instructions，而不是改 app.asar 模板。
		// 国际版把 personalization 存 <home>/app/app-config.json（AppConfigService 主路径），
		// 老版本存 settings.json；file() 报「当前生效的那份」。
		file: () => workbuddyActiveFile("workbuddy"),
		kind: "custom",
		layer: "sys",
		note: "personalization.customPrompt（身份上下文，app-config.json 或 settings.json）；原字段 stash 可逆还原；名字/人设设定是云端个人配置，不在此通道",
		probe: () => workbuddyPromptBlocked("workbuddy"),
		install: ({ root, active, mode = "replace" } = {}) => {
			const personaText = active && existsSync(active) ? readFileSync(active, "utf8") : "";
			const r = installWorkbuddyPrompt(root, { personaText, mode, harness: "workbuddy" });
			return { ...r, file: r.file ?? workbuddyActiveFile("workbuddy") };
		},
		uninstall: ({ root } = {}) => {
			const r = uninstallWorkbuddyPrompt(root, { harness: "workbuddy" });
			return { ...r, file: r.file ?? workbuddyActiveFile("workbuddy") };
		},
	},
	"workbuddy-ai": {
		// WorkBuddy AI 国际版：同样是 personalization.customPrompt，
		// 但 5.9.4 实测以 ~/.workbuddy-ai/app/app-config.json 为准，settings.json 只作 legacy 回落。
		file: () => workbuddyActiveFile("workbuddy-ai"),
		kind: "custom",
		layer: "sys",
		note: "personalization.customPrompt（国际版身份上下文，app-config.json 或 settings.json）；原字段 stash 可逆还原；名字/人设设定是云端个人配置，不在此通道",
		probe: () => workbuddyPromptBlocked("workbuddy-ai"),
		install: ({ root, active, mode = "replace" } = {}) => {
			const personaText = active && existsSync(active) ? readFileSync(active, "utf8") : "";
			const r = installWorkbuddyPrompt(root, { personaText, mode, harness: "workbuddy-ai" });
			return { ...r, file: r.file ?? workbuddyActiveFile("workbuddy-ai") };
		},
		uninstall: ({ root } = {}) => {
			const r = uninstallWorkbuddyPrompt(root, { harness: "workbuddy-ai" });
			return { ...r, file: r.file ?? workbuddyActiveFile("workbuddy-ai") };
		},
	},
	"pi-desktop": {
		// PI-Desktop 用 pi 的 agentDir（~/.pi/agent）：SYSTEM.md 是它唯一能「换掉产品 persona 块」的常驻口
		file: () => join(configHome("pi"), "SYSTEM.md"),
		kind: "block",
		layer: "sys",
		note: "SYSTEM.md 直接替换产品 persona 块（工具/操作规则保留）；与 pi CLI 共用 ~/.pi/agent，装了两边都变",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	kilo: {
		// Kilo Code CLI：~/.config/kilo/agent/code.md 覆盖 code agent prompt；
		// append 走 ~/.config/kilo/AGENTS.md 的托管块（系统上下文）。
		file: () => kiloBuildAgentFile(),
		kind: "custom",
		layer: "sys",
		note: "code agent Markdown（replace/strict）；AGENTS.md 托管块（append）；均按原字节 stash 可逆",
		probe: () => probeKilocode(),
		install: ({ root, active, mode = "replace" } = {}) => {
			const personaText = active && existsSync(active) ? readFileSync(active, "utf8") : "";
			return installKilocode(root, { personaText, mode });
		},
		uninstall: ({ root } = {}) => uninstallKilocode(root),
	},
	crush: {
		// Crush 的全局上下文文件：README 明确 CRUSH.md 是 system prompt 的
		// personal additions，宿主每次启动读取；没有整份替换入口。
		file: () => join(configHome("crush"), "CRUSH.md"),
		kind: "block",
		layer: "sys",
		note: "全局 CRUSH.md 托管块（append）；启动时读取，改完重开生效",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	antigravity: {
		// Antigravity App + CLI(agy) 共用 ~/.gemini/config：无 frontmatter 的 AGENTS.md 是 always_on，
		// 宿主自己把它塞进 systemInstruction 的 <user_rules>，不需要任何手动选择。
		// strict 会先插一句「取代上方身份」，因为 <identity> 段仍在提示词里。
		file: () => antigravityAgentsFile(),
		kind: "custom",
		layer: "sys",
		note: "全局 AGENTS.md 的托管块（App 与 CLI 都自动读，落 <user_rules>）；按原字节 stash 可逆",
		probe: () => probeAntigravity(),
		install: ({ root, active, mode = "replace" } = {}) => {
			const personaText = active && existsSync(active) ? readFileSync(active, "utf8") : "";
			return installAntigravity(root, { personaText, mode });
		},
		uninstall: ({ root } = {}) => uninstallAntigravity(root),
	},
};

export function status(_root) {
	return Object.entries(targets).map(([name, t]) => {
		const file = t.file();
		// 自定义探针（多文件目标用），优先于默认的存在性判断
		if (t.probe) return { name, installed: t.probe(), file };
		const candidates = t.files ? t.files() : [file];
		const present = candidates.filter((f) => existsSync(f));
		if (!present.length) return { name, installed: false, file };
		// 文件类目标：只要还存在任意一份托管文件就算“已安装”（内容可能是旧版本写的）
		const installed =
			t.kind === "block"
				? present.some((f) => {
						const text = readFileSync(f, "utf8");
						return stripBlock(text) !== text;
					})
				: present.some(f => looksOwned(readFileSync(f, "utf8")));
		return { name, installed, file: present[0], files: present };
	});
}

export function install(name, { root, active, mode = "replace" }) {
	const t = targets[name];
	if (!t) return { error: `${name} 没有持久化后端（可用: ${Object.keys(targets).join(", ")}）` };
	// 多文件/自定义布局的 harness 自带安装函数（dsh 三个 profile、opencode2 v2 插件）
	// 它们的失败信号是异常（同名外来目录拒绝覆盖等），这里转成调用方约好的 {error}
	if (t.install) {
		try {
			const r = t.install({ root, active, mode });
			// 账本按「实际落点」登记：撤销时不再重新推导 profile 目录
			record(root, { kind: "custom", harness: name, channel: "install", path: r.file, undo: { type: "custom", harness: name, op: "install" } });
			return { ...r, action: "custom" };
		} catch (e) {
			return { error: e.message };
		}
	}
	const file = t.file();
	mkdirSync(dirname(file), { recursive: true });
	if (t.kind === "file") {
		// 和托管块同等安全：写之前把原字节存进 stash，撤销时才知道该还原成什么
		const old = existsSync(file) ? readFileSync(file, "utf8") : null;
		const content = t.body(active, root);
		const previous = readStash(file, root);
		const before = previous ? previous.before : looksOwned(old) ? null : old;
		if (previous && old !== previous.after && looksOwned(old)) preserveEdited(file, old);
		writeStash(file, { file, before, after: content }, root);
		writeFileSync(file, content);
		record(root, {
			kind: "file",
			harness: name,
			channel: "install",
			path: file,
			undo: { type: "file-delete" },
			createdByUs: old === null,
		});
		return { file, action: "wrote-whole-file", replaced: old !== null };
	}
	const old = existsSync(file) ? readFileSync(file, "utf8") : null;
	const body = t.body(active);
	if (hasMarker(body)) return { error: `${name}: persona 正文包含 agent-purge 托管标记，拒绝写入` };
	const next = upsertBlock(old ?? "", body, t.position);
	const prev = readStash(file, root);
	// 无 stash 的旧安装、或块外被用户编辑后，基线必须先去掉旧托管块。
	// 否则下一次卸载会把上一版人设重新写回来。
	let before = prev && prev.after === old ? prev.before : old;
	if (before !== null) before = stripBlock(before);
	// 顶层覆盖键的原值不应因为块外编辑而丢失；用户已自行写了新值则优先保留。
	if (t.position === "top" && prev && prev.after !== old && before !== null) {
		const key = body.split("=")[0].trim();
		const keyRe = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
		const topLines = (text) => {
			const lines = String(text ?? "").split(/\r?\n/);
			const at = lines.findIndex((line) => /^\s*\[/.test(line));
			return at < 0 ? lines : lines.slice(0, at);
		};
		const originalKey = topLines(stripBlock(prev.before ?? "")).find((l) => keyRe.test(l));
		if (originalKey && !topLines(before).some((l) => keyRe.test(l))) before = originalKey + (before.includes("\r\n") ? "\r\n" : "\n") + before;
	}
	writeStash(file, { file, before, after: next }, root);
	writeFileSync(file, next);
	record(root, {
		kind: "block",
		harness: name,
		channel: "install",
		path: file,
		undo: { type: "block-revert" },
		createdByUs: before === null,
	});
	return { file, action: old && stripBlock(old) !== old ? "replaced-block" : "appended-block" };
}

export function uninstall(name, { root = dataHome() } = {}) {
	const t = targets[name];
	if (!t) return { error: `${name} 没有持久化后端` };
	if (t.uninstall) {
		try {
			const r = t.uninstall();
			forgetHarness(root, name, "install");
			return { ...r, action: "custom" };
		} catch (e) {
			return { error: e.message };
		}
	}
	if (t.kind === "file") {
		// 清掉所有历史位置，保证“关掉”之后没有任何残留插件还在注入。
		// 但每份都要先确认是自己写的——历史位置里可能有用户自己的同名文件。
		const candidates = t.files ? t.files() : [t.file()];
		const present = candidates.filter((f) => existsSync(f));
		if (!present.length) return { file: t.file(), action: "already-gone" };
		const results = present.map((f) => removeOwnedFile(f, { root }));
		const removed = results.filter((r) => r.action === "deleted-file" || r.action === "restored-file" || r.action === "disabled-edited-file");
		const skipped = results.filter((r) => r.action === FOREIGN).map((r) => r.file);
		return {
			file: (removed[0] ?? results[0]).file,
			files: present,
			results,
			action: removed.length ? (removed[0].action === "deleted-file" ? "deleted-file" : removed[0].action) : FOREIGN,
			...(skipped.length ? { skipped } : {}),
		};
	}
	return revertFile(t.file(), { root });
}

/**
 * 按绝对路径撤销一个托管块（账本执行器用：路径来自账本，不来自 targets 推导）。
 * 有 stash 且文件仍是上次写入的样子 → 按原字节还原；否则按 marker 剥块。
 */
export function revertFile(file, { root = dataHome() } = {}) {
	if (!existsSync(file)) {
		clearStash(file, root);
		cancel(root, { kind: "block", path: file });
		return { file, action: "already-gone" };
	}
	const old = readFileSync(file, "utf8");
	const stash = readStash(file, root);
	// 原字节还原：只有文件仍是上次 install 写入的 after 才敢整份写回。
	if (stash && stash.after === old) {
		if (stash.before === null) rmSync(file, { force: true });
		else writeFileSync(file, stripBlock(stash.before));
		clearStash(file, root);
		cancel(root, { kind: "block", path: file });
		return {
			file,
			action: stash.before === null ? "deleted-empty-file" : "removed-block",
			exact: true,
		};
	}
	if (stripBlock(old) === old) {
		clearStash(file, root);
		cancel(root, { kind: "block", path: file });
		return { file, action: "no-block" };
	}
	const stripped = stripBlock(old);
	// 只剩空白说明这文件本来就是给我们用的，直接删掉别留空壳
	if (!stripped.trim()) {
		rmSync(file, { force: true });
		clearStash(file, root);
		cancel(root, { kind: "block", path: file });
		return { file, action: "deleted-empty-file" };
	}
	writeFileSync(file, stripped);
	clearStash(file, root);
	cancel(root, { kind: "block", path: file });
	return { file, action: "removed-block" };
}

// 按标记替换或追加，幂等。position="top" 用于 TOML：块必须落在第一个 [table] 之前。
export function upsertBlock(text, body, position = "bottom") {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const block = `${BEGIN}\n${body}\n${END}`;
	const stripped = stripBlock(text) !== text ? stripBlock(text) : text;
	if (position === "top") {
		let lines = stripped.split(/\r?\n/);
		const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
		const end = firstTable === -1 ? lines.length : firstTable;
		// 已有的顶层同名键先删掉，否则 TOML 会报 duplicate key
		const key = body.split("=")[0].trim();
		const keyRe = key ? new RegExp(`^\\s*${escapeRe(key)}\\s*=`) : null;
		if (keyRe) lines = lines.filter((l, i) => !(i < end && keyRe.test(l)));
		// 插在开头连续的注释/空行之后：顶层键必须早于第一个 [table]，但不该淹没 #:schema 这类头注释
		let at = 0;
		while (at < lines.length && (/^\s*#/.test(lines[at]) || lines[at].trim() === "")) at++;
		lines.splice(at, 0, ...block.split("\n"));
		return lines.join(eol).replace(/\s*$/, eol);
	}
	return `${stripped.replace(/\s*$/, "")}${eol}${eol}${block.split("\n").join(eol)}${eol}`;
}

const markerLine = (line, marker) => String(line).replace(/\r?\n$/, "").trim() === marker;

/**
 * 按整行 marker 删块。旧实现用不锚行的正则，persona 里出现 `# >>> agent-purge`
 * 就会从行中间开始吞内容；这里只认独立成行的 BEGIN/END，且不改动块外一个字节。
 * 精确字节还原由 install 的 stash 负责，这个函数只做兜底清理。
 */
export function stripBlock(text) {
	const src = String(text ?? "");
	const lines = src.split(/(?<=\n)/);
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		if (markerLine(lines[i], BEGIN)) {
			let end = i + 1;
			while (end < lines.length && !markerLine(lines[end], END)) end++;
			if (end < lines.length) { i = end; continue; }
		}
		out.push(lines[i]);
	}
	return out.join("");
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 有些 harness 对单文件有硬上限（grok：10000 字符），超了直接截断并留一行明说 */
function clamp(text, max) {
	if (text.length <= max) return text;
	return text.slice(0, max) + "\n\n（agent-purge：超出该 harness 的文件上限，此处被截断）";
}
