// 项目级人设：写进当前项目根的 AGENTS.md / CLAUDE.md 托管块。
//
// 为什么要有这条通道：全局配置一改就是全机器生效，改坏了也只能回滚配置；项目块只影响
// 当前目录，删块即还原，比全局配置更局部也更好解释。撤销走 persist.revertFile（stash 字节还原）。
import { spawnSync } from "node:child_process";
import { withControlLock } from "./control.mjs";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { basename } from "node:path";
import { antigravityAgentsFile } from "./antigravity.mjs";
import { kiloAgentsFile } from "./kilocode.mjs";
import { configHome } from "./paths.mjs";
import { cancel, listLedger, record } from "./footprints.mjs";
import { readStash, revertFile, stripBlock, upsertBlock, writeStash } from "./persist.mjs";
import { loadState, patchState } from "./state.mjs";
import { dataHome } from "./home.mjs";
/** 各家的项目规则文件。没列的家（codebuddy/dsh）没有这个落点，不摆开关。 */
const PROJECT_FILES = {
	pi: "AGENTS.md",
	"pi-desktop": "AGENTS.md",
	omp: "AGENTS.md",
	grok: "AGENTS.md",
	zcode: "AGENTS.md",
	codex: "AGENTS.md",
	opencode: "AGENTS.md",
	opencode2: "AGENTS.md",
	kilo: "AGENTS.md",
	antigravity: "AGENTS.md",
	qwen: "QWEN.md",
	cursor: "AGENTS.md",
	devin: "AGENTS.md",
	gemini: "GEMINI.md",
	crush: "AGENTS.md",
	copilot: "AGENTS.md",
	amp: "AGENT.md",
	cline: ".clinerules",
	roo: ".roorules",
	claude: "CLAUDE.md",
};

export const projectTargets = PROJECT_FILES;
export const projectFilePath = (id, dir = process.cwd()) => (PROJECT_FILES[id] ? resolve(dir, PROJECT_FILES[id]) : null);
const pathKey = path => process.platform === "win32" ? path.toLowerCase() : path;

/** 暂停会撤销磁盘块，因此目录选择单独保存在 state；旧安装只从账本恢复，不猜 cwd。 */
export function projectDirectories(root, id) {
	const { state } = loadState(root);
	const saved = Array.isArray(state.projectDirs?.[id]) ? state.projectDirs[id] : [];
	const recorded = listLedger(root)
		.filter(e => e.harness === id && e.channel === "project" && typeof e.path === "string" && isAbsolute(e.path))
		.map(e => dirname(e.path));
	const dirs = new Map();
	for (const path of [...saved, ...recorded]) {
		if (typeof path !== "string" || !isAbsolute(path)) continue;
		const dir = resolve(path);
		dirs.set(pathKey(dir), dir);
	}
	return [...dirs.values()];
}

function saveDirectories(root, id, dirs) {
	const { state } = loadState(root);
	const projectDirs = { ...state.projectDirs };
	if (dirs.length) projectDirs[id] = dirs;
	else delete projectDirs[id];
	patchState(root, { projectDirs });
}

function rememberDirectory(root, id, dir) {
	const dirs = projectDirectories(root, id);
	if (!dirs.some(path => pathKey(path) === pathKey(dir))) dirs.push(dir);
	saveDirectories(root, id, dirs);
}

/** 项目块优先于全局块（harness 把项目规则放前面），所以两块同时开会两份都进。 */
export const PROJECT_NOTE = "同一个规则文件会被多家工具共同读取；写入一次，所有读取方都生效";

const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const fileSha = file => (existsSync(file) && lstatSync(file).isFile() ? sha256(file) : null);
const isSymlink = file => existsSync(file) && lstatSync(file).isSymbolicLink();

export function projectInstall(id, options = {}) {
	return withControlLock(options.root ?? dataHome(), () => projectInstallUnlocked(id, options));
}

function projectInstallUnlocked(id, { root, active, dir = process.cwd(), paused = false, expectSha, persona } = {}) {
	const file = projectFilePath(id, dir);
	if (!file) return { error: `${id} 没有项目级规则文件（可用: ${Object.keys(PROJECT_FILES).join(", ")}）` };
	if (isSymlink(file)) return { error: `拒绝写入符号链接文件：${file}`, file };
	if (existsSync(file) && !lstatSync(file).isFile()) return { error: `目标路径不是普通文件：${file}`, file };
	if (paused) {
		rememberDirectory(root, id, dirname(file));
		return { file, action: "selected-while-paused" };
	}
	const body = String(active ?? "").trim();
	if (!body) return { error: "没有可用人设" };
	mkdirSync(dirname(file), { recursive: true });
	const old = existsSync(file) ? readFileSync(file, "utf8") : null;
	const currentSha = fileSha(file);
	if (expectSha !== undefined && expectSha !== currentSha) {
		return { error: "项目文件在预览后被外部修改，请刷新后再操作", action: "conflict", file, sha: currentSha };
	}
	if (/^(?:\s*)# (?:>>>|<<<) agent-purge/m.test(body)) return { error: `${id}: persona 正文包含 agent-purge 托管标记，拒绝写入` };
	const next = upsertBlock(old ?? "", body);
	// 多次同步沿用最初的还原基线；块外被用户编辑时，只移除旧托管块再保存。
	const previous = readStash(file, root);
	let before = previous && previous.after === old ? previous.before : old;
	if (before !== null) before = stripBlock(before);
	writeStash(file, { file, before, after: next }, root);
	const tmp = `${file}.agent-purge-${process.pid}-${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, next);
		renameSync(tmp, file);
	} finally {
		if (existsSync(tmp)) {
			try { unlinkSync(tmp); } catch { /* 临时文件清理失败不覆盖真实错误 */ }
		}
	}
	record(root, { kind: "block", harness: id, channel: "project", path: file, ...(persona ? { persona } : {}), undo: { type: "block-revert" } });
	rememberDirectory(root, id, dirname(file));
	return { file, action: old === null ? "created" : stripBlock(old) !== old ? "replaced-block" : "appended-block", note: PROJECT_NOTE };
}

export function projectUninstall(id, options = {}) {
	return withControlLock(options.root ?? dataHome(), () => projectUninstallUnlocked(id, options));
}

function projectUninstallUnlocked(id, { dir = process.cwd(), root = dataHome(), keepSelection = false, expectSha } = {}) {
	const file = projectFilePath(id, dir);
	if (!file) return { error: `${id} 没有项目级规则文件` };
	const currentSha = fileSha(file);
	if (expectSha !== undefined && expectSha !== currentSha) {
		return { error: "项目文件在预览后被外部修改，请刷新后再操作", action: "conflict", file, sha: currentSha };
	}
	const ledger = listLedger(root).filter(e => e.channel === "project" && pathKey(e.path) === pathKey(file));
	const ownLedger = ledger.filter(e => e.harness === id);
	const selected = projectDirectories(root, id).some(path => pathKey(path) === pathKey(dirname(file)));
	if (!ownLedger.length && !selected && ledger.length) {
		return { file, action: "not-owner", owners: [...new Set(ledger.map(entry => entry.harness))] };
	}
	const others = ledger.filter(e => e.harness !== id).map(e => e.harness);
	if (others.length) {
		for (const entry of ledger.filter(e => e.harness === id)) cancel(root, { id: entry.id });
		if (keepSelection) rememberDirectory(root, id, dirname(file));
		else saveDirectories(root, id, projectDirectories(root, id).filter(path => pathKey(path) !== pathKey(dirname(file))));
		return { file, action: "detached", owners: [...new Set(others)] };
	}
	// 在撤销账本前保存旧安装的目录，暂停后仍可恢复到同一位置。
	if (root && keepSelection) rememberDirectory(root, id, dirname(file));
	const r = revertFile(file, { root });
	if (root && !r.error) {
		cancel(root, { kind: "block", path: file });
		if (!keepSelection) saveDirectories(root, id, projectDirectories(root, id).filter(path => pathKey(path) !== pathKey(dirname(file))));
	}
	return r;
}

/**
 * 现场状态。同一个 AGENTS.md 可能被好几家共用，所以「开着」必须靠账本归属到具体 harness：
 * 块在文件里、账本又有这条记录才算开着（账本丢了就说不知道，不自作主张）。
 */
export function projectStatus(dir = process.cwd(), root) {
	const entries = root ? listLedger(root).filter((e) => e.channel === "project") : null;
	return Object.entries(PROJECT_FILES).map(([id, name]) => {
		const file = resolve(dir, name);
		let text = null;
		try {
			if (existsSync(file) && lstatSync(file).isFile()) text = readFileSync(file, "utf8");
		} catch { /* 读不了就按未知处理，不能让状态页崩掉 */ }
		const hasBlock = text !== null && stripBlock(text) !== text;
		const mine = entries ? entries.some((e) => e.harness === id && typeof e.path === "string" && pathKey(e.path) === pathKey(file)) : hasBlock;
		const selected = root ? projectDirectories(root, id).some(path => pathKey(path) === pathKey(dirname(file))) : hasBlock;
		return { id, file, hasBlock, on: hasBlock && mine, selected, sha: text !== null ? sha256(file) : null };
	});
}

/** 所有登记过的项目目录及其规则文件覆盖情况；用于项目切换和总览。 */
export function projectOverview(root, current = process.cwd()) {
	const dirs = new Map();
	for (const id of Object.keys(PROJECT_FILES)) {
		for (const dir of projectDirectories(root, id)) dirs.set(pathKey(dir), resolve(dir));
	}
	dirs.set(pathKey(current), resolve(current));
	return [...dirs.values()].map(dir => {
		const groups = new Map();
		for (const row of projectStatus(dir, root)) {
			const file = PROJECT_FILES[row.id];
			if (!file) continue;
			const group = groups.get(file) ?? { on: false, selected: false, hasBlock: false };
			group.on ||= row.on;
			group.selected ||= row.selected;
			group.hasBlock ||= row.hasBlock;
			groups.set(file, group);
		}
		const rows = [...groups.values()];
		return {
			dir,
			current: pathKey(dir) === pathKey(current),
			files: rows.length,
			written: rows.filter(row => row.on).length,
			selected: rows.filter(row => row.selected).length,
		};
	}).sort((a, b) => Number(b.current) - Number(a.current) || b.written - a.written || a.dir.localeCompare(b.dir, "zh-CN"));
}

/** 取文件里的 agent-purge 托管块正文，只用于只读预览。 */
export function projectPreview(dir = process.cwd(), id, limit = 8000) {
	const file = projectFilePath(id, dir);
	if (!file || !existsSync(file)) return null;
	const text = readFileSync(file, "utf8");
	const match = text.match(/(?:^|\r?\n)# >>> agent-purge[^\S\r\n]*\r?\n([\s\S]*?)\r?\n# <<< agent-purge[^\S\r\n]*(?=\r?\n|$)/);
	if (!match) return null;
	const body = match[1];
	return { text: body.slice(0, limit), chars: body.length, truncated: body.length > limit };
}

/** 只读预览一次写入/移除会产生的文件差异；不写盘，用于页面确认。 */
function lineDiff(before, after, limit = 240) {
	const toLines = text => String(text ?? "").split(/\r?\n/);
	const a = before ? toLines(before) : [];
	const b = after ? toLines(after) : [];
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length - 1, endB = b.length - 1;
	while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
	const removed = a.slice(start, endA + 1);
	const added = b.slice(start, endB + 1);
	if (!removed.length && !added.length) return { text: "没有变化", added: 0, removed: 0, truncated: false };
	const lines = [`@@ 第 ${start + 1} 行 · -${removed.length} +${added.length} @@`];
	for (const line of removed.slice(0, limit)) lines.push(`- ${line}`);
	if (removed.length > limit) lines.push(`- …（还有 ${removed.length - limit} 行）`);
	for (const line of added.slice(0, limit)) lines.push(`+ ${line}`);
	if (added.length > limit) lines.push(`+ …（还有 ${added.length - limit} 行）`);
	return { text: lines.join("\n"), added: added.length, removed: removed.length, truncated: removed.length > limit || added.length > limit };
}

export function projectChangePreview(id, { dir = process.cwd(), active = "", action = "on" } = {}) {
	const file = projectFilePath(id, dir);
	if (!file) return { error: `${id} 没有项目级规则文件` };
	if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) {
		return { error: `目标路径不是普通文件：${file}`, file };
	}
	const before = existsSync(file) ? readFileSync(file, "utf8") : "";
	const body = String(active ?? "").trim();
	const after = action === "off" ? stripBlock(before) : body ? upsertBlock(before, body) : null;
	if (after === null) return { error: "没有可用人设", file };
	return {
		file,
		sha: fileSha(file),
		action,
		beforeChars: before.length,
		afterChars: after.length,
		diff: lineDiff(before, after),
		after: after.slice(0, 8000),
		truncated: after.length > 8000,
	};
}

/**
 * git 仓库里没被跟踪的规则文件，改完容易意外进提交。只提示，不替用户改 .gitignore。
 * 返回 null = 不需要提示（不是 git 仓库 / 文件已被跟踪 / 没有 git）。
 */
const formatGitHint = name => `${name} 还没被 git 跟踪：不想提交这份人设就 git update-index --skip-worktree ${name} 或写进 .gitignore（不自动改）`;

export function gitHint(id, dir = process.cwd()) {
	const name = PROJECT_FILES[id];
	if (!name || !existsSync(join(dir, ".git"))) return null;
	const run = spawnSync("git", ["-C", dir, "ls-files", "--error-unmatch", "--", name], { encoding: "utf8", timeout: 2000, windowsHide: true });
	if (run.error || run.status === 0) return null;
	return formatGitHint(name);
}

/** 一次 git ls-files 批量查完整张页的规则文件，避免每张卡片单独起子进程。 */
export function gitHints(dir = process.cwd(), files = []) {
	const list = [...new Set(files.filter(Boolean))];
	const out = new Map(list.map(name => [name, null]));
	if (!list.length || !existsSync(join(dir, ".git"))) return out;
	const run = spawnSync("git", ["-C", dir, "ls-files", "--", ...list], { encoding: "utf8", timeout: 2000, windowsHide: true });
	if (run.error || run.status !== 0) return out;
	const tracked = new Set(String(run.stdout ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean));
	for (const name of list) {
		if (!tracked.has(name)) out.set(name, formatGitHint(name));
	}
	return out;
}


/** 已实测的全局规则文件落点（与各家个人主目录配置对齐，不做未经验证的猜测）。 */
const GLOBAL_RULE_SPECS = [
	{ id: "pi", label: "AGENTS.md (Pi)", tools: ["pi", "pi-desktop"], file: () => join(configHome("pi"), "AGENTS.md") },
	{ id: "claude", label: "CLAUDE.md (Claude Code)", tools: ["claude"], file: () => join(configHome("claude"), "CLAUDE.md") },
	{ id: "omp", label: "AGENTS.md (omp)", tools: ["omp"], file: () => join(configHome("omp"), "agent", "AGENTS.md") },
	{ id: "grok", label: "AGENTS.md (Grok)", tools: ["grok"], file: () => join(configHome("grok"), "AGENTS.md") },
	{ id: "zcode", label: "AGENTS.md (ZCode)", tools: ["zcode"], file: () => join(configHome("zcode"), "AGENTS.md") },
	{ id: "antigravity", label: "AGENTS.md (Antigravity)", tools: ["antigravity"], file: () => antigravityAgentsFile() },
	{ id: "kilo", label: "AGENTS.md (Kilo Code)", tools: ["kilo"], file: () => kiloAgentsFile() },
	{ id: "crush", label: "CRUSH.md (Crush)", tools: ["crush"], file: () => join(configHome("crush"), "CRUSH.md") },
];

function extractManagedBlock(text, limit = 8000) {
	const match = String(text ?? "").match(/(?:^|\r?\n)# >>> agent-purge[^\S\r\n]*\r?\n([\s\S]*?)\r?\n# <<< agent-purge[^\S\r\n]*(?=\r?\n|$)/);
	if (!match) return null;
	const body = match[1];
	return { text: body.slice(0, limit), chars: body.length, truncated: body.length > limit };
}

export function globalRuleTargets() {
	return GLOBAL_RULE_SPECS.map(spec => {
		const path = resolve(spec.file());
		return { id: spec.id, label: spec.label, file: basename(path), path, tools: [...spec.tools] };
	});
}

export function globalRuleStatus(root = dataHome()) {
	const entries = root ? listLedger(root) : [];
	return globalRuleTargets().map(spec => {
		let text = null;
		try {
			if (existsSync(spec.path) && lstatSync(spec.path).isFile()) text = readFileSync(spec.path, "utf8");
		} catch { /* 读不了按未写入处理 */ }
		const hasBlock = text !== null && stripBlock(text) !== text;
		const matchingEntries = entries.filter(e => typeof e.path === "string" && pathKey(e.path) === pathKey(spec.path));
		const stash = root ? readStash(spec.path, root) : null;
		const owned = matchingEntries.length > 0 || Boolean(stash && text !== null && stash.after === text);
		const ledgerPersona = [...matchingEntries].reverse().find(e => e.persona)?.persona ?? null;
		return {
			...spec,
			hasBlock,
			on: hasBlock && owned,
			sha: text !== null ? sha256(spec.path) : null,
			preview: hasBlock ? extractManagedBlock(text) : null,
			ledgerPersona,
		};
	});
}

export function globalRuleChangePreview(id, { active = "", action = "on" } = {}) {
	const spec = globalRuleTargets().find(t => t.id === id);
	if (!spec) return { error: `${id} 没有已验证的全局规则文件` };
	if (existsSync(spec.path) && (!lstatSync(spec.path).isFile() || lstatSync(spec.path).isSymbolicLink())) {
		return { error: `目标路径不是普通文件：${spec.path}`, file: spec.path };
	}
	const before = existsSync(spec.path) ? readFileSync(spec.path, "utf8") : "";
	const body = String(active ?? "").trim();
	const after = action === "off" ? stripBlock(before) : body ? upsertBlock(before, body) : null;
	if (after === null) return { error: "没有可用人设", file: spec.path };
	return {
		file: spec.path,
		sha: fileSha(spec.path),
		action,
		beforeChars: before.length,
		afterChars: after.length,
		diff: lineDiff(before, after),
		after: after.slice(0, 8000),
		truncated: after.length > 8000,
	};
}

export function globalRuleInstall(id, options = {}) {
	return withControlLock(options.root ?? dataHome(), () => {
		const { root = dataHome(), active, expectSha, persona } = options;
		const spec = globalRuleTargets().find(t => t.id === id);
		if (!spec) return { error: `${id} 没有已验证的全局规则文件` };
		const file = spec.path;
		if (isSymlink(file)) return { error: `拒绝写入符号链接文件：${file}`, file };
		if (existsSync(file) && !lstatSync(file).isFile()) return { error: `目标路径不是普通文件：${file}`, file };
		const body = String(active ?? "").trim();
		if (!body) return { error: "没有可用人设" };
		if (/^(?:\s*)# (?:>>>|<<<) agent-purge/m.test(body)) return { error: `${id}: persona 正文包含 agent-purge 托管标记，拒绝写入` };
		mkdirSync(dirname(file), { recursive: true });
		const old = existsSync(file) ? readFileSync(file, "utf8") : null;
		const currentSha = fileSha(file);
		if (expectSha !== undefined && expectSha !== currentSha) {
			return { error: "全局规则文件在预览后被外部修改，请刷新后再操作", action: "conflict", file, sha: currentSha };
		}
		const next = upsertBlock(old ?? "", body);
		const previous = readStash(file, root);
		let before = previous && previous.after === old ? previous.before : old;
		if (before !== null) before = stripBlock(before);
		writeStash(file, { file, before, after: next }, root);
		const tmp = `${file}.agent-purge-${process.pid}-${Date.now()}.tmp`;
		try {
			writeFileSync(tmp, next);
			renameSync(tmp, file);
		} finally {
			if (existsSync(tmp)) {
				try { unlinkSync(tmp); } catch { /* ignore */ }
			}
		}
		record(root, { kind: "block", harness: id, channel: "global-rule", path: file, ...(persona ? { persona } : {}), undo: { type: "block-revert" } });
		return { file, action: old === null ? "created" : stripBlock(old) !== old ? "replaced-block" : "appended-block" };
	});
}

export function globalRuleUninstall(id, options = {}) {
	return withControlLock(options.root ?? dataHome(), () => {
		const { root = dataHome(), expectSha } = options;
		const spec = globalRuleTargets().find(t => t.id === id);
		if (!spec) return { error: `${id} 没有已验证的全局规则文件` };
		const file = spec.path;
		const currentSha = fileSha(file);
		if (expectSha !== undefined && expectSha !== currentSha) {
			return { error: "全局规则文件在预览后被外部修改，请刷新后再操作", action: "conflict", file, sha: currentSha };
		}
		const r = revertFile(file, { root });
		if (root && !r.error) cancel(root, { kind: "block", path: file });
		return r;
	});
}
