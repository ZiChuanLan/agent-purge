// 会话内 `/purge`：把当前 persona 装进去，之后在这个会话里说一句 `/purge` 就切。
//
// 这里是整个项目里唯一"照实说实话"的地方：**斜杠命令不等于系统提示词注入**。
//   pi / omp  —— 扩展能在 before_agent_start 改写 systemPrompt → sys 层，热切换（实测 100%）
//   claude    —— ~/.claude/commands/purge.md 是**用户消息展开** → user 层
//   codex     —— ~/.codex/prompts/purge.md 同上 → user 层
//   opencode  —— ~/.config/opencode/command/purge.md 同上 → user 层（sys 层要靠 plugin 常驻）
// user 层的注入成功率由 matrix.json 的 armor.probe.*.user 记录，`agent-purge ls` 会标出来。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configHome } from "./paths.mjs";
import { extensionSource } from "./extension.mjs";
import { installPlugin, probePlugin, pluginDir, uninstallPlugin } from "./pi-desktop.mjs";
import { SLASH_RESIDENT, addPlugin, hasPluginAny, pluginFileOnDisk, removePlugin, slashSource } from "./dsh.mjs";
import { record } from "./footprints.mjs";
import { readStash, removeOwnedFile, writeStash, looksOwned, preserveEdited, unusedBackup } from "./persist.mjs";
import { cancel, forgetHarness } from "./footprints.mjs";

const SIDECAR = ".disabled-by-agent-purge";

/** 谁有 /purge、走哪层、文件放哪 */
export function resolveSlash(id, root) {
	const homeOf = configHome;
	const specs = {
		"pi-desktop": () => ({
			layer: "sys",
			offered: true,
			hot: true,
			trigger: "/purge on|off|status|mode",
			file: join(pluginDir(), "src", "agent-purge.ts"),
			render: () => extensionSource(root, "pi"),
			probe: probePlugin,
			note: "以 imported 插件贡献 ExtensionAPI：before_agent_start 每轮改写 systemPrompt，/purge 与换人设都不用重启（首次安装要重启一次 PI-Desktop）",
		}),
		pi: () => {
			const base = homeOf("pi");
			if (!base) return null;
			return {
				layer: "sys",
				offered: true,
				hot: true,
				trigger: "/purge on|off|status|mode",
				file: join(base, "extensions", "agent-purge.ts"),
				render: () => extensionSource(root, "pi"),
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
				render: () => extensionSource(root, "omp"),
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
			note: "cordis 插件注册 /purge（/ap 为别名）：改 state.json，下一句生效，不产生模型消息；注入靠常驻插件，两样都要启用",
		}),
	};
	const spec = specs[id];
	if (!spec) return null;
	const base = spec();
	if (!base) return null;
	return { id, ...base };
}

export function installSlash(id, root, { personaId, personaBody } = {}) {
	const s = resolveSlash(id, root);
	if (!s) return { error: `${id} 没有 /purge 通道` };
	if (s.offered === false) return { error: `${s.note}（已下线，不再提供）` };
	// dsh：装 cordis 插件到三个 profile，没有单文件可写。
	// 没跑过 dsh 时 addPlugin 会抛；这里必须转成 {error}，否则 arm --all 会半途崩掉。
	if (id === "pi-desktop") {
		const r = installPlugin(root);
		if (r.error) return { error: r.error };
		return { file: r.file, layer: s.layer, note: r.note };
	}
	if (id === "dsh") {
		try {
			const r = addPlugin(SLASH_RESIDENT, slashSource(root));
			return { file: pluginFileOnDisk(SLASH_RESIDENT), layer: s.layer, note: s.note, sidecars: [], profiles: r.profiles };
		} catch (e) {
			return { error: e.message };
		}
	}
	mkdirSync(dirname(s.file), { recursive: true });

	// pi：旧的 pi-purge.ts 也注册 /purge，会撞名 → 先移开，卸载时还原
	const sidecars = [];
	if (id === "pi") {
		const legacy = join(dirname(s.file), "pi-purge.ts");
		if (existsSync(legacy)) {
			const off = unusedBackup(legacy);
			renameSync(legacy, off);
			sidecars.push({ from: off, to: legacy });
		}
	}

	// 扩展文件会整份覆盖用户的同名文件：写之前存原字节，卸载时才能还回去
	const old = existsSync(s.file) ? readFileSync(s.file, "utf8") : null;
	const content = s.render({ personaId, personaBody });
	const previous = readStash(s.file, root);
	if (previous && old !== previous.after && looksOwned(old)) preserveEdited(s.file, old);
	writeStash(s.file, { file: s.file, before: previous ? previous.before : looksOwned(old) ? null : old, after: content }, root);
	writeFileSync(s.file, content, "utf8");
	record(root, {
		kind: "file",
		harness: id,
		channel: "slash",
		path: s.file,
		undo: { type: "file-delete" },
		createdByUs: old === null,
	});
	return { file: s.file, layer: s.layer, note: s.note, sidecars, replaced: old !== null };
}

export function uninstallSlash(id, root) {
	const s = resolveSlash(id, root);
	if (!s) return { error: `${id} 没有 /purge 通道` };
	if (id === "pi-desktop") {
		const r = uninstallPlugin();
		forgetHarness(root, id, "slash");
		return { removed: r.removed.length ? r.removed : [s.file] };
	}
	if (id === "dsh") {
		const result = removePlugin(SLASH_RESIDENT);
		forgetHarness(root, id, "slash");
		return { removed: [s.file], ...result };
	}
	const removed = [];
	const notes = [];
	if (existsSync(s.file)) {
		const r = removeOwnedFile(s.file, { root });
		if (r.action === "skipped-foreign") {
			// 不是我们写的：不删。账本留着不动，clean 的 leftovers 会把这条报出来
			notes.push(`${s.file} 不是 agent-purge 写的，未删除（要 /purge 消失请手工处理）`);
		} else if (r.action === "restored-file") {
			removed.push(s.file);
			notes.push(`${s.file} 已还原为安装前的内容`);
		} else if (r.action === "disabled-edited-file") {
			removed.push(s.file);
			notes.push(`${s.file} 已被改过，改名为 ${r.moved} 停用（原字节保留）`);
		} else if (r.action !== "already-gone") {
			removed.push(s.file);
		}
	}
	if (id === "pi") {
		const legacy = join(dirname(s.file), "pi-purge.ts");
		if (!existsSync(legacy) && existsSync(legacy + SIDECAR)) {
			renameSync(legacy + SIDECAR, legacy);
			removed.push(`${legacy}（已还原原 pi-purge 扩展）`);
		}
	}
	if (!existsSync(s.file)) cancel(root, { kind: "file", path: s.file });
	return { removed, ...(notes.length ? { notes } : {}) };
}

export function slashStatus(root) {
	const out = [];
	for (const id of Object.keys({ pi: 1, "pi-desktop": 1, omp: 1, claude: 1, codex: 1, opencode: 1, dsh: 1 })) {
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
			const old = readFileSync(s.file, "utf8");
			const content = s.render({ personaId, personaBody });
			// 刷新只改 after，before 沿用上一份：否则卸载时还原成的是上一次的人设，不是用户原文
			const prev = readStash(s.file, root);
			writeStash(s.file, { file: s.file, before: prev ? prev.before : old, after: content }, root);
			writeFileSync(s.file, content, "utf8");
			updated.push(s.file);
		}
	}
	return updated;
}

function commandMd(description, body, personaId) {
	return `---\ndescription: ${description}\n---\n\n${body.trim()}\n\n<!-- agent-purge: ${personaId} -->\n`;
}
