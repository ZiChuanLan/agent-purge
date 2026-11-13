// WebDAV 备份：把数据目录里的人设与设置序列化成一个 JSON 包，PUT 到远端；恢复时下载、校验、再写回。
//
// 三条设计约束：
//   1. 备份内容固定为「人设 + 设置」，不带运行期日志、锁文件、缓存和浏览器 profile；
//   2. 恢复前先把当前数据目录快照到本地 backups/，误点「恢复」也有退路；
//   3. 只支持 WebDAV 的三种方法（PROPFIND / PUT / GET），不引入依赖。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";


export const MANIFEST = "agent-purge-backup.json";
const FORMAT = 1;
const MAX_DOWNLOAD = 32 * 1024 * 1024;
const TIMEOUT = 20000;

/** 备份里带哪些文件（相对数据目录）：人设库 + 配置文件本身。 */
function backupFiles(root) {
	const files = [];
	const personas = join(root, "personas");
	if (existsSync(personas)) {
		for (const name of readdirSync(personas)) {
			// .build/ 是派生产物，active.md 由 state.json 的 persona 字段生成，都不带
			if (!name.endsWith(".md") || name === "active.md") continue;
			files.push({ path: `personas/${name}`, bytes: readFileSync(join(personas, name)) });
		}
	}
	const stateFile = join(root, "state.json");
	if (existsSync(stateFile) && statSync(stateFile).isFile()) {
		files.push({ path: "state.json", bytes: Buffer.from(sanitizedState(readFileSync(stateFile, "utf8"))) });
	}
	const ledger = join(root, "footprints.json");
	if (existsSync(ledger) && statSync(ledger).isFile()) files.push({ path: "footprints.json", bytes: readFileSync(ledger) });
	return files;
}

/**
 * 备份里的 state.json 去掉 WebDAV 密码：备份文件会离开这台机器，
 * 账号密码是「这台机器怎么连远端」的属性，不该跟着人设到处漂。
 */
function sanitizedState(raw) {
	let state;
	try { state = JSON.parse(raw); } catch { return raw; }
	if (state?.settings?.webdav?.password) {
		const webdav = { ...state.settings.webdav };
		delete webdav.password;
		state = { ...state, settings: { ...state.settings, webdav } };
	}
	return JSON.stringify(state, null, 2) + "\n";
}

/** 拼接远端 URL：base + 若干路径段，空段丢掉。 */
function joinRemote(baseUrl, ...parts) {
	const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
	const segments = parts
		.flatMap(part => String(part ?? "").split("/"))
		.map(s => s.trim())
		.filter(Boolean);
	return [base, ...segments].filter(Boolean).join("/");
}

/** 远端 URL：base + 目录 + 文件名，目录里的空段丢掉。 */
export function remoteUrl({ url, dir }, file) {
	return joinRemote(url, dir, file);
}

function authHeader({ username, password }) {
	if (!username && !password) return {};
	return { authorization: `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}` };
}

async function requestUrl(settings, method, target, { body, headers = {}, timeout = TIMEOUT } = {}) {
	let response;
	try {
		response = await fetch(target, {
			method,
			headers: { ...authHeader(settings), ...headers },
			body,
			signal: AbortSignal.timeout(timeout),
		});
	} catch (error) {
		const reason = error?.cause?.code || error?.name || "network";
		throw new Error(`连不上 WebDAV（${reason}）：${target}`);
	}
	return response;
}

async function request(settings, method, file, opts = {}) {
	return requestUrl(settings, method, remoteUrl(settings, file), opts);
}

/** 逐段确保远端集合目录存在（WebDAV 的 MKCOL 不递归）；405 表示目录本来就在。 */
async function ensureCollection(settings, subDir = "") {
	const segments = [settings.dir, subDir]
		.flatMap(part => String(part ?? "").split("/"))
		.map(s => s.trim())
		.filter(Boolean);
	const built = [];
	for (const seg of segments) {
		built.push(seg);
		const target = `${joinRemote(settings.url, ...built)}/`;
		const res = await requestUrl(settings, "MKCOL", target).catch(() => null);
		if (res?.status === 401 || res?.status === 403) {
			throw new Error("WebDAV 拒绝了这组账号密码（401/403）");
		}
	}
}

/** 只读探测：能读到远端目录就算连通，顺便确认凭据有效。 */
export async function testConnection(rawSettings) {
	const settings = rawSettings.webdav ?? rawSettings;
	if (!settings.url) throw new Error("还没有填 WebDAV 地址");
	const dirUrl = remoteUrl(settings, "");
	const response = await requestUrl(settings, "PROPFIND", `${dirUrl}/`, { headers: { depth: "0" }, timeout: 15000 });
	if (response.status === 401 || response.status === 403) throw new Error("WebDAV 拒绝了这组账号密码（401/403）");
	// 首次配置时子目录还没建好：改探 base 地址，能连通说明地址与账号都没问题
	if (response.status === 404 && String(settings.dir ?? "").trim()) {
		const baseRes = await requestUrl(settings, "PROPFIND", `${joinRemote(settings.url)}/`, { headers: { depth: "0" }, timeout: 15000 });
		if (baseRes.status === 401 || baseRes.status === 403) throw new Error("WebDAV 拒绝了这组账号密码（401/403）");
		if (baseRes.ok || baseRes.status === 207) return { ok: true, url: dirUrl, willCreateDir: true };
	}
	if (!response.ok && response.status !== 207) throw new Error(`WebDAV 返回 ${response.status}，检查地址是否正确`);
	return { ok: true, url: dirUrl };
}

/**
 * 打包并上传。远端文件名固定，最新的永远覆盖旧的；同时留一份带时间戳的，
 * 免得一次误备份把唯一的历史冲掉。
 */
export async function backup(root, rawSettings) {
	const settings = rawSettings.webdav ?? rawSettings;
	if (!settings.url) throw new Error("还没有填 WebDAV 地址");
	const files = backupFiles(root);
	if (!files.length) throw new Error("数据目录里没有人设或配置可备份");
	const entries = files.map(file => ({
		path: file.path,
		size: file.bytes.length,
		sha256: createHash("sha256").update(file.bytes).digest("hex"),
		base64: file.bytes.toString("base64"),
	}));
	const createdAt = new Date().toISOString();
	const archive = {
		format: FORMAT,
		createdAt,
		version: (() => { try { return JSON.parse(readFileSync(join(root, "state.json"), "utf8")).version ?? null; } catch { return null; } })(),
		entries,
	};
	const body = Buffer.from(JSON.stringify(archive));
	const stamp = createdAt.replace(/[:.]/g, "-");
	const names = [`${MANIFEST}`, `history/agent-purge-${stamp}.json`];

	for (const name of names) {
		let response = await request(settings, "PUT", name, {
			body,
			headers: { "content-type": "application/json" },
		});
		// 目录还没建：从 settings.dir 到 history 逐段 MKCOL 后重试一次
		if (response.status === 404 || response.status === 409) {
			const slash = name.lastIndexOf("/");
			const subDir = slash > 0 ? name.slice(0, slash) : "";
			await ensureCollection(settings, subDir);
			response = await request(settings, "PUT", name, { body, headers: { "content-type": "application/json" } });
		}
		if (!response.ok) throw new Error(`上传 ${name} 失败：HTTP ${response.status}`);
	}
	return { ok: true, files: entries.length, bytes: body.length, at: createdAt, remote: remoteUrl(settings, MANIFEST) };
}

/** 下载并校验：哈希对不上一律拒绝写入，避免半截文件覆盖本地人设。 */
export async function download(rawSettings) {
	const settings = rawSettings.webdav ?? rawSettings;
	if (!settings.url) throw new Error("还没有填 WebDAV 地址");
	const response = await request(settings, "GET", MANIFEST);
	if (response.status === 401 || response.status === 403) throw new Error("WebDAV 拒绝了这组账号密码（401/403）");
	if (response.status === 404) throw new Error("远端没有找到 agent-purge 备份");
	if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
	const length = Number(response.headers.get("content-length") ?? 0);
	if (length > MAX_DOWNLOAD) throw new Error(`备份超过 ${MAX_DOWNLOAD / 1024 / 1024} MiB，拒绝下载`);
	const text = await response.text();
	if (Buffer.byteLength(text) > MAX_DOWNLOAD) throw new Error("备份体积异常，拒绝写入");
	let archive;
	try { archive = JSON.parse(text); } catch { throw new Error("远端备份不是有效的 JSON"); }
	if (archive?.format !== FORMAT || !Array.isArray(archive.entries)) throw new Error("远端备份格式不认识（可能来自更新的版本）");
	return { archive, entries: verifiedEntries(archive) };
}

/**
 * 校验条目并把 base64 还原成 bytes。
 * 单独抽出来，是因为「只接受人设与两个配置文件」这条约束在备份、下载、写回三条路径上都要生效。
 */
function verifiedEntries(archive) {
	const verified = [];
	for (const entry of archive.entries) {
		const path = assertBackupPath(entry?.path);
		const bytes = Buffer.from(String(entry.base64 ?? ""), "base64");
		const sha = createHash("sha256").update(bytes).digest("hex");
		if (sha !== entry.sha256) throw new Error(`${path} 校验失败（文件可能损坏）`);
		verified.push({ path, bytes });
	}
	return verified;
}

/** 只允许人设与两个配置文件：备份来自远端，路径不能跳出数据目录。 */
function assertBackupPath(path) {
	const value = String(path ?? "");
	if (!/^(personas\/[^/\\]+\.md|state\.json|footprints\.json)$/.test(value) || value.includes("..")) {
		throw new Error(`备份里有不认识的路径：${value}`);
	}
	return value;
}

/** 恢复前先给当前数据目录拍个快照，放在 backups/ 下；失败也要能继续恢复。 */
function snapshot(root) {
	const dir = join(root, "backups");
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const target = join(dir, `pre-restore-${stamp}.json`);
	const files = backupFiles(root).map(file => ({ path: file.path, base64: file.bytes.toString("base64") }));
	writeFileSync(target, JSON.stringify({ format: FORMAT, createdAt: new Date().toISOString(), entries: files }, null, 2));
	return target;
}

/**
 * 把下载校验过的备份写回数据目录。写回是同步的：调用方要把它放进配置锁里，
 * 免得和「保存人设 / 应用配置」交叉写同一个文件。
 * 只碰备份里带的文件，不动其余人设。
 */
export function applyArchive(root, downloaded, { snapshotBefore = true } = {}) {
	// 条目可能是 download() 还原好的 bytes，也可能是原始 base64：统一在这里再校验一次
	const entries = downloaded.entries.map(entry => {
		const path = assertBackupPath(entry?.path);
		if (Buffer.isBuffer(entry.bytes)) return { path, bytes: entry.bytes };
		const bytes = Buffer.from(String(entry.base64 ?? ""), "base64");
		if (entry.sha256 && createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
			throw new Error(`${path} 校验失败（文件可能损坏）`);
		}
		return { path, bytes };
	});
	const archive = downloaded.archive ?? {};
	const snapshotPath = snapshotBefore ? snapshot(root) : null;
	const before = (() => { try { return JSON.parse(readFileSync(join(root, "state.json"), "utf8")); } catch { return null; } })();
	const keepWebdav = before?.settings?.webdav ?? null;
	mkdirSync(join(root, "personas"), { recursive: true });
	const written = [];
	for (const entry of entries) {
		writeFileSync(join(root, entry.path), entry.bytes, { mode: entry.path === "state.json" ? 0o600 : 0o644 });
		written.push(entry.path);
	}
	// 备份里的 state.json 刻意不带密码：本机的 WebDAV 账号是「这台机器」的属性，恢复后要保留
	if (keepWebdav && written.includes("state.json")) {
		const after = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
		after.settings = { ...(after.settings ?? {}), webdav: { ...keepWebdav } };
		writeFileSync(join(root, "state.json"), `${JSON.stringify(after, null, 2)}\n`, { mode: 0o600 });
	}
	return { ok: true, written, at: archive.createdAt ?? null, snapshot: snapshotPath };
}

/** 一步恢复（下载 + 写回）；需要放进配置锁的场景请用 download + applyArchive。 */
export async function restore(root, rawSettings, options = {}) {
	const settings = rawSettings.webdav ?? rawSettings;
	const downloaded = await download(settings);
	return applyArchive(root, downloaded, options);
}

/** 清掉本地 backups/ 里过期的快照，只留最近若干份。 */
export function pruneSnapshots(root, keep = 10) {
	const dir = join(root, "backups");
	if (!existsSync(dir)) return 0;
	const files = readdirSync(dir).filter(name => name.startsWith("pre-restore-") && name.endsWith(".json")).sort();
	const drop = files.slice(0, Math.max(0, files.length - keep));
	for (const name of drop) rmSync(join(dir, name), { force: true });
	return drop.length;
}


