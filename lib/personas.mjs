// persona 管理：一个 markdown 文件 = 元数据(frontmatter) + 系统提示词正文。
// 正文是唯一喂给 harness 的东西；元数据只用来做选择。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, saveState } from "./state.mjs";

const WILD = "*";
// active.md 是派生物，不是状态：install 指向它、opencode 插件运行时读它 → 真热切。
// 真正的指针在 state.json 的 persona 字段（旧布局的 personas/.active 在 loadState 里已迁移）。
const ACTIVE_BODY = "active.md";
const RESERVED_IDS = new Set([ACTIVE_BODY.slice(0, -3), ".active"]); // "active" / ".active"

export function createStore(root) {
	const dir = join(root, "personas");
	const build = join(dir, ".build");
	mkdirSync(build, { recursive: true });

	// 首次运行（或 npm 安装后的空目录）：从 lib/templates/personas 拷一份中性的起步 persona。
	{
		const has = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".md") && f !== "active.md");
		const tpl = join(dirname(fileURLToPath(import.meta.url)), "templates", "personas");
		if (!has && existsSync(tpl)) {
			for (const f of readdirSync(tpl)) writeFileSync(join(dir, f), readFileSync(join(tpl, f), "utf8"));
		}
	}

	const listFiles = () =>
		(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".") && f !== "active.md") : []);

	function read(id) {
		if (!isValidId(id)) return null;
		const file = join(dir, `${id}.md`);
		if (!existsSync(file)) return null;
		const raw = readFileSync(file, "utf8");
		const { meta, body } = parse(raw);
		return { id, file, meta: normalizeMeta(meta), body, raw };
	}

	function list() {
		return listFiles()
			.map((f) => read(f.slice(0, -3)))
			.filter(Boolean)
			.sort((a, b) => (a.meta.order ?? 99) - (b.meta.order ?? 99) || a.id.localeCompare(b.id));
	}

	function save(id, { meta = {}, body }) {
		if (isReservedId(id)) throw new Error(`${id} 是保留名（active 指针专用），换个 id`);
		if (!isValidId(id)) throw new Error(`非法 persona id: ${id}（不能含路径分隔符或 ..，最长 64 字符）`);
		const file = join(dir, `${id}.md`);
		writeFileSync(file, serialize({ id, meta, body }));
		return read(id);
	}

	function remove(id) {
		if (!isValidId(id)) return false;
		rmSync(join(dir, `${id}.md`), { force: true });
		rmSync(join(build, `${id}.md`), { force: true });
		// 删的就是 active 时必须改道：否则下次无参启动直接 “没有 persona”。
		// 落点不抓 list()[0]（那是顺序序，等于静默换人），优先落到 neutral。
		if (activeId() === id) {
			const all = list();
			const next = all.find((p) => p.id === "neutral") ?? all[0] ?? null;
			if (next) setActive(next.id);
			else writeFileSync(join(dir, ACTIVE_BODY), "You are a helpful coding assistant.\n");
		}
		return true;
	}

	// 把正文落到 .build，给需要文件路径的 harness 用（frontmatter 绝不能进 prompt）
	function materialize(id) {
		const p = read(id);
		if (!p) return null;
		const out = join(build, `${id}.md`);
		writeFileSync(out, p.body.trim() + "\n");
		return out;
	}

	function activeId() {
		const { state } = loadState(root);
		if (state.persona && read(state.persona)) return state.persona;
		return list()[0]?.id ?? null;
	}

	function setActive(id) {
		const p = read(id);
		if (!p) throw new Error(`no such persona: ${id}`);
		// 先写正文快照，再写指针：中途被杀也只会多一份一致的快照
		writeFileSync(join(dir, ACTIVE_BODY), p.body.trim() + "\n");
		const { state } = loadState(root);
		saveState(root, { ...state, persona: id });
	}

	// install 前调用：保证 active.md 是最新正文，返回它的路径（落盘型后端指向它）
	function refreshActive() {
		const id = activeId();
		if (id) setActive(id);
		return join(dir, ACTIVE_BODY);
	}

	// 选中的 persona：harness+model 精确度优先，其次 active，其次第一个
	function resolve({ harness, model } = {}) {
		const all = list();
		const scored = all.map((p) => {
			const h = asArray(p.meta.harness);
			const m = asArray(p.meta.model);
			const hHit = h.includes(WILD) ? 1 : h.some((g) => globHit(g, harness));
			const mHit = m.includes(WILD) ? 1 : m.some((g) => globHit(g, model));
			const explicitH = hHit && !h.includes(WILD) ? 1 : 0;
			const explicitM = mHit && !m.includes(WILD) ? 1 : 0;
			return { p, hit: hHit && mHit, score: explicitH * 2 + explicitM * 4 };
		});
		const eligible = scored.filter((s) => s.hit).sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
		const active = activeId();
		const fallback = all.find((p) => p.id === active) ?? all[0] ?? null;
		return { persona: eligible[0]?.p ?? fallback, matched: Boolean(eligible[0]), score: eligible[0]?.score ?? 0 };
	}

	return { dir, build, list, read, save, remove, materialize, activeId, setActive, refreshActive, resolve };
}

/** 保留 id：会被当成 persona 文件名，与 active 双文件冲突 */
export function isReservedId(id) {
	return RESERVED_IDS.has(String(id || ""));
}

/** persona id 会直接拼进文件名：挡掉路径分隔符与 ..，避免读/删到数据目录之外 */
export function isValidId(id) {
	const s = String(id ?? "").trim();
	return Boolean(s) && s.length <= 64 && !s.includes("..") && !/[\\/:*?"<>|\0]/.test(s) && !isReservedId(s);
}

function parse(raw) {
	if (!raw.startsWith("---")) return { meta: {}, body: raw };
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return { meta: {}, body: raw };
	const head = raw.slice(3, end).trim();
	const body = raw.slice(end + 4).replace(/^\r?\n/, "");
	return { meta: parseMeta(head), body };
}

function parseMeta(head) {
	const meta = {};
	let key = null;
	for (const line of head.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const arr = line.match(/^\s*-\s+(.*)$/);
		if (arr && key) {
			if (!Array.isArray(meta[key])) meta[key] = [];
			meta[key].push(unquote(arr[1]));
			continue;
		}
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) continue;
		key = kv[1];
		const v = kv[2].trim();
		if (!v) {
			meta[key] = [];
			continue;
		}
		if (v.startsWith("[")) {
			meta[key] = v
				.replace(/^\[|\]$/g, "")
				.split(",")
				.map((s) => unquote(s.trim()))
				.filter(Boolean);
		} else meta[key] = coerce(v);
	}
	return meta;
}

function serialize({ id, meta, body }) {
	const lines = ["---", `id: ${meta.id ?? id}`];
	const seen = new Set(["id"]);
	for (const [k, v] of Object.entries(meta)) {
		// desc 是早期 UI 的键名，README/模板写的是 description：写回时只留 description，避免同名两行
		const key = k === "desc" ? "description" : k;
		if (seen.has(key)) continue;
		if (Array.isArray(v)) {
			seen.add(key);
			lines.push(`${key}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]`);
		} else if (v !== undefined && v !== null && v !== "") {
			seen.add(key);
			// 数字/布尔裸写（`order: 1`、`enabled: true`），字符串才引号包——否则一次保存就把类型改成字符串
			lines.push(`${key}: ${typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v))}`);
		}
	}
	lines.push("---", "", body.trim(), "");
	return lines.join("\n");
}

/**
 * 键名归一：磁盘上有两套写法（README/模板 `description`，0.2.x UI `desc`）。
 * 统一按 description 存，读的时候把 desc 当别名补上 —— CLI 列表、Web 表单都能直接读到。
 */
function normalizeMeta(meta) {
	if (meta.description !== undefined && meta.desc === undefined) meta.desc = meta.description;
	if (meta.desc !== undefined && meta.description === undefined) meta.description = meta.desc;
	return meta;
}

const unquote = (s) => s.replace(/^["']|["']$/g, "");
/** 标量取值：数字/布尔还原成真类型，其余保持字符串（只收干净的写法，`01` 这种不动） */
function coerce(v) {
	const s = unquote(v);
	if (s === "true") return true;
	if (s === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(s) && String(Number(s)) === s) return Number(s);
	return s;
}
const asArray = (v) => (Array.isArray(v) ? v : v ? [String(v)] : [WILD]);

function globHit(pattern, value) {
	if (!value) return pattern === WILD;
	const re = new RegExp("^" + String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
	return re.test(value);
}
