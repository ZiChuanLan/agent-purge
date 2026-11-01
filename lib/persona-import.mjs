// 从外部来源（GitHub 仓库或本地目录）拉取/导入人设并存入本地人设库
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { createStore, isReservedId } from "./personas.mjs";

const IGNORED_NAMES = new Set([
	"readme.md",
	"readme_zh.md",
	"readme.zh.md",
	"readme.zh-cn.md",
	"license.md",
	"licence.md",
	"changelog.md",
	"contributing.md",
	"security.md",
	"active.md",
]);

/** 解析源字符串：判断是本地目录还是 GitHub 仓库 */
export function parseSource(source) {
	const raw = String(source ?? "").trim();
	if (!raw) throw new Error("导入源不能为空");

	// 1. 本地目录判断：绝对路径、相对路径前缀、或本地已存在该目录
	if (
		raw.startsWith("file://") ||
		raw.startsWith(".") ||
		raw.startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(raw) ||
		existsSync(raw)
	) {
		let cleanPath = raw;
		if (raw.startsWith("file://")) {
			try {
				cleanPath = new URL(raw).pathname;
			} catch {
				cleanPath = raw.slice(7);
			}
		}
		const localDir = resolve(process.cwd(), cleanPath);
		if (!existsSync(localDir) || !statSync(localDir).isDirectory()) {
			throw new Error(`本地目录不存在: ${localDir}`);
		}
		return { kind: "local", path: localDir };
	}

	// 2. GitHub URL 或 owner/repo 格式
	let owner = "";
	let repo = "";
	let ref = "main";
	let subpath = "";

	if (raw.startsWith("http://") || raw.startsWith("https://")) {
		try {
			const u = new URL(raw);
			if (!u.hostname.includes("github.com")) {
				throw new Error("目前外部拉取仅支持 GitHub 仓库或本地目录");
			}
			const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
			if (parts.length < 2) throw new Error("无效的 GitHub 仓库 URL");
			owner = parts[0];
			repo = parts[1].replace(/\.git$/i, "");
			if (parts[2] === "tree" && parts[3]) {
				ref = parts[3];
				subpath = parts.slice(4).join("/");
			}
		} catch (e) {
			throw new Error(`无法解析 GitHub URL: ${e.message}`);
		}
	} else {
		// 可能是 "owner/repo" 或 "owner/repo@ref" 或 "owner/repo/subpath"
		const clean = raw.replace(/\.git$/i, "");
		const [repoPart, refPart] = clean.split("@");
		if (refPart) ref = refPart;

		const parts = repoPart.split("/");
		if (parts.length >= 2) {
			owner = parts[0];
			repo = parts[1];
			if (parts.length > 2) subpath = parts.slice(2).join("/");
		} else {
			throw new Error(`无法识别导入源: ${raw}（请指定 owner/repo 或本地目录路径）`);
		}
	}

	return { kind: "github", owner, repo, ref, subpath };
}

/** 规范化从文件名或 frontmatter 得出的 persona id */
export function sanitizeId(rawId, fallbackName = "persona") {
	let s = String(rawId || "").trim().toLowerCase();
	// 移除非法字符，替换为空格或连字符
	s = s.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!s || isReservedId(s)) {
		let fb = String(fallbackName || "persona").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
		s = fb && !isReservedId(fb) ? fb : `p-${Date.now().toString(36)}`;
	}
	return s.slice(0, 64);
}

/** 解析 markdown 中的 frontmatter 与提示词正文 */
export function parsePersonaDoc(raw, fallbackId = "") {
	let meta = {};
	let body = raw;

	if (raw.startsWith("---")) {
		const end = raw.indexOf("\n---", 3);
		if (end !== -1) {
			const head = raw.slice(3, end).trim();
			body = raw.slice(end + 4).replace(/^\r?\n/, "");
			meta = parseFrontmatter(head);
		}
	}

	const id = sanitizeId(meta.id || fallbackId, fallbackId);
	const name = meta.name || meta.title || fallbackId || id;
	const description = meta.description || meta.desc || "";
	const harness = Array.isArray(meta.harness) ? meta.harness : ["*"];
	const model = Array.isArray(meta.model) ? meta.model : ["*"];
	const order = typeof meta.order === "number" ? meta.order : 50;

	return {
		id,
		meta: {
			...meta,
			id,
			name,
			description,
			harness,
			model,
			order,
		},
		body: body.trim(),
	};
}

function parseFrontmatter(head) {
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
		} else {
			meta[key] = coerce(v);
		}
	}
	return meta;
}

const unquote = (s) => s.replace(/^["']|["']$/g, "");
const coerce = (v) => {
	if (v === "true") return true;
	if (v === "false") return false;
	const n = Number(v);
	return Number.isFinite(n) && !Number.isNaN(n) && String(n) === v ? n : unquote(v);
};

/** 从本地目录导入人设 */
export function importFromDirectory(dirPath, root, { overwrite = true } = {}) {
	const resolvedDir = resolve(dirPath);
	if (!existsSync(resolvedDir)) throw new Error(`目录不存在: ${resolvedDir}`);

	const entries = readdirSync(resolvedDir, { withFileTypes: true });
	const store = createStore(root);
	const imported = [];
	const skipped = [];
	const errors = [];

	for (const entry of entries) {
		if (entry.isDirectory()) continue;
		const name = entry.name;
		const lower = name.toLowerCase();
		if (!lower.endsWith(".md") && !lower.endsWith(".markdown")) continue;
		if (IGNORED_NAMES.has(lower) || lower.startsWith(".")) {
			skipped.push({ file: name, reason: "忽略的文件名（文档或隐藏文件）" });
			continue;
		}

		try {
			const filePath = join(resolvedDir, name);
			const raw = readFileSync(filePath, "utf8");
			const fallbackId = basename(name, extname(name));
			const parsed = parsePersonaDoc(raw, fallbackId);

			if (!parsed.body) {
				skipped.push({ file: name, reason: "提示词正文为空" });
				continue;
			}

			const existing = store.read(parsed.id);
			if (existing && !overwrite) {
				skipped.push({ id: parsed.id, name: parsed.meta.name, file: name, reason: "已存在且未开启覆盖" });
				continue;
			}

			const saved = store.save(parsed.id, { meta: parsed.meta, body: parsed.body });
			imported.push({
				id: saved.id,
				name: saved.meta.name,
				chars: saved.body.length,
				action: existing ? "updated" : "created",
			});
		} catch (e) {
			errors.push({ file: name, error: e.message });
		}
	}

	return {
		success: errors.length === 0,
		source: { kind: "local", path: resolvedDir },
		imported,
		skipped,
		errors,
		total: imported.length,
	};
}

/** 从 GitHub 仓库拉取人设 */
export async function pullFromGitHub(
	{ owner, repo, ref = "main", subpath = "" },
	root,
	{ overwrite = true, token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN } = {}
) {
	const store = createStore(root);
	const headers = {
		"User-Agent": "agent-purge-client",
		Accept: "application/vnd.github.v3+json",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const apiPath = subpath ? `contents/${encodeURIComponent(subpath).replace(/%2F/g, "/")}` : "contents";
	const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${apiPath}?ref=${encodeURIComponent(ref)}`;

	let res;
	try {
		res = await fetch(url, { headers });
	} catch (e) {
		throw new Error(`连接 GitHub 失败: ${e.message}`);
	}

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub API 响应 ${res.status}: ${text.slice(0, 200)}`);
	}

	const list = await res.json();
	if (!Array.isArray(list)) {
		throw new Error("GitHub 仓库指定路径不是文件列表");
	}

	const imported = [];
	const skipped = [];
	const errors = [];

	for (const item of list) {
		if (item.type !== "file") continue;
		const name = item.name;
		const lower = name.toLowerCase();
		if (!lower.endsWith(".md") && !lower.endsWith(".markdown")) continue;
		if (IGNORED_NAMES.has(lower) || lower.startsWith(".")) {
			skipped.push({ file: name, reason: "忽略的文件名（文档或隐藏文件）" });
			continue;
		}

		try {
			let content = "";
			// 优先使用 download_url（raw），失败时回退到 git_url 获取 base64 blob
			if (item.download_url) {
				try {
					const r = await fetch(item.download_url, { headers: { "User-Agent": "agent-purge-client" } });
					if (r.ok) content = await r.text();
				} catch {
					// 忽略 raw 失败，走 blob 降级
				}
			}

			if (!content && item.git_url) {
				const blobRes = await fetch(item.git_url, { headers });
				if (blobRes.ok) {
					const blobData = await blobRes.json();
					if (blobData.content && blobData.encoding === "base64") {
						content = Buffer.from(blobData.content, "base64").toString("utf8");
					}
				}
			}

			if (!content) throw new Error("无法读取文件内容");

			const fallbackId = basename(name, extname(name));
			const parsed = parsePersonaDoc(content, fallbackId);

			if (!parsed.body) {
				skipped.push({ file: name, reason: "提示词正文为空" });
				continue;
			}

			const existing = store.read(parsed.id);
			if (existing && !overwrite) {
				skipped.push({ id: parsed.id, name: parsed.meta.name, file: name, reason: "已存在且未开启覆盖" });
				continue;
			}

			const saved = store.save(parsed.id, { meta: parsed.meta, body: parsed.body });
			imported.push({
				id: saved.id,
				name: saved.meta.name,
				chars: saved.body.length,
				action: existing ? "updated" : "created",
			});
		} catch (e) {
			errors.push({ file: name, error: e.message });
		}
	}

	return {
		success: errors.length === 0,
		source: { kind: "github", owner, repo, ref, subpath },
		imported,
		skipped,
		errors,
		total: imported.length,
	};
}

/** 统一入口：根据来源自动分流导入 */
export async function importPersonas(sourceStr, root, options = {}) {
	const parsed = parseSource(sourceStr);
	if (parsed.kind === "local") {
		return importFromDirectory(parsed.path, root, options);
	}
	return pullFromGitHub(parsed, root, options);
}
