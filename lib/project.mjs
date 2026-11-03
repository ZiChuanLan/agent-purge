// 项目级人设：写进当前项目根的 AGENTS.md / CLAUDE.md 托管块。
//
// 为什么要有这条通道：全局配置一改就是全机器生效，改坏了也只能回滚配置；项目块只影响
// 当前目录，删块即还原，比全局配置更局部也更好解释。撤销走 persist.revertFile（stash 字节还原）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cancel, listLedger, record } from "./footprints.mjs";
import { readStash, revertFile, stripBlock, upsertBlock, writeStash } from "./persist.mjs";
import { loadState, patchState } from "./state.mjs";
import { dataHome } from "./home.mjs";

/** 各家的项目规则文件。没列的家（codebuddy/dsh/antigravity）没有这个落点，不摆开关。 */
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
export const PROJECT_NOTE = "原生 harness 会共同读取同名规则文件；单文件只登记一个管理归属，同时开全局会有两份";

function ownersOf(root, file) {
	return Object.keys(PROJECT_FILES).filter(id => projectDirectories(root, id).some(dir => pathKey(projectFilePath(id, dir)) === pathKey(file)));
}

export function projectInstall(id, { root, active, dir = process.cwd(), paused = false }) {
	const file = projectFilePath(id, dir);
	if (!file) return { error: `${id} 没有项目级规则文件（可用: ${Object.keys(PROJECT_FILES).join(", ")}）` };
	const owners = ownersOf(root, file).filter(owner => owner !== id);
	if (owners.length) return { error: `项目文件归属冲突：${file} 已登记给 ${owners.join(", ")}，请先撤销原选择`, file, owners };
	if (paused) {
		rememberDirectory(root, id, dirname(file));
		return { file, action: "selected-while-paused" };
	}
	const body = String(active ?? "").trim();
	if (!body) return { error: "没有可用人设" };
	mkdirSync(dirname(file), { recursive: true });
	const old = existsSync(file) ? readFileSync(file, "utf8") : null;
	if (/^(?:\s*)# (?:>>>|<<<) agent-purge/m.test(body)) return { error: `${id}: persona 正文包含 agent-purge 托管标记，拒绝写入` };
	const next = upsertBlock(old ?? "", body);
	// 多次同步沿用最初的还原基线；块外被用户编辑时，只移除旧托管块再保存。
	const previous = readStash(file, root);
	let before = previous && previous.after === old ? previous.before : old;
	if (before !== null) before = stripBlock(before);
	writeStash(file, { file, before, after: next }, root);
	writeFileSync(file, next);
	record(root, { kind: "block", harness: id, channel: "project", path: file, undo: { type: "block-revert" } });
	rememberDirectory(root, id, dirname(file));
	return { file, action: old === null ? "created" : stripBlock(old) !== old ? "replaced-block" : "appended-block", note: PROJECT_NOTE };
}

export function projectUninstall(id, { dir = process.cwd(), root = dataHome(), keepSelection = false } = {}) {
	const file = projectFilePath(id, dir);
	if (!file) return { error: `${id} 没有项目级规则文件` };
	const owners = ownersOf(root, file);
	if (owners.length && !owners.includes(id)) return { file, action: "not-owner", owners };
	if (owners.length > 1) return { error: `旧项目归属冲突：${file} (${owners.join(", ")})，请先核对账本`, file };
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
		const text = existsSync(file) ? readFileSync(file, "utf8") : null;
		const hasBlock = text !== null && stripBlock(text) !== text;
		const mine = entries ? entries.some((e) => e.harness === id && typeof e.path === "string" && pathKey(e.path) === pathKey(file)) : hasBlock;
		const selected = root ? projectDirectories(root, id).some(path => pathKey(path) === pathKey(dirname(file))) : hasBlock;
		return { id, file, hasBlock, on: hasBlock && mine, selected };
	});
}

/**
 * git 仓库里没被跟踪的规则文件，改完容易意外进提交。只提示，不替用户改 .gitignore。
 * 返回 null = 不需要提示（不是 git 仓库 / 文件已被跟踪 / 没有 git）。
 */
export function gitHint(id, dir = process.cwd()) {
	const name = PROJECT_FILES[id];
	if (!name || !existsSync(join(dir, ".git"))) return null;
	const run = spawnSync("git", ["-C", dir, "ls-files", "--error-unmatch", "--", name], { encoding: "utf8" });
	if (run.error || run.status === 0) return null;
	return `${name} 还没被 git 跟踪：不想提交这份人设就 git update-index --skip-worktree ${name} 或写进 .gitignore（不自动改）`;
}
