// 桌面端「装在哪」的定位：开始菜单快捷方式 → 用户级安装目录 → 各盘常见根 → 注册表卸载项。
// CLI 靠 PATH 就能找到；Electron 这类桌面端可能装在任何盘、任何目录（F:\workbuddy），
// 双击启动又不经过 PATH，所以只看 PATH 和几个写死的默认目录必然误报「未安装」。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import { execFileSync } from "node:child_process";

const WIN = process.platform === "win32";

// 快捷方式/注册表里拿到的是 Windows 路径，但测试可能在 Linux 上跑；
// 按「路径长得像不像 Windows」选方言，保证同一份断言在两边都成立。
const isWinPath = (p) => p.length > 2 && p[1] === ":" && (p.charCodeAt(2) === 92 || p.charCodeAt(2) === 47);
const baseOf = (p) => (isWinPath(p) ? win32.basename(p) : basename(p));
const dirOf = (p) => (isWinPath(p) ? win32.dirname(p) : dirname(p));
const hasWildcard = (p) => p.includes("*");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * exe 名匹配：支持 `PI-Desktop-Portable*.exe` 这种带版本号的便携版命名。
 * 只对显式写了 `*` 的模式生效，避免「Antigravity.exe」误吃「antigravity-tools.exe」。
 */
export function matchExeName(name, pattern) {
	const n = lower(name);
	const p = lower(pattern);
	if (!hasWildcard(p)) return n === p;
	return new RegExp(`^${p.split("*").map(escapeRe).join(".*")}$`).test(n);
}

// ---------- .lnk 解析（LinkInfo.LocalBasePath；解析失败再扫盘符路径） ----------

export function readShortcutTarget(file) {
	let buf;
	try {
		buf = readFileSync(file);
	} catch {
		return null;
	}
	if (buf.length < 0x4c || buf.readUInt32LE(0) !== 0x4c) return null;
	const flags = buf.readUInt32LE(0x14);
	let at = 0x4c;
	if (flags & 1) at += 2 + (buf.readUInt16LE(at) || 0);
	if (flags & 2 && at + 0x1c <= buf.length) {
		const base = at;
		const size = buf.readUInt32LE(base);
		const headerSize = buf.readUInt32LE(base + 4);
		const infoFlags = buf.readUInt32LE(base + 8);
		if (size && headerSize >= 0x1c && base + size <= buf.length) {
			const ansi = (field) => {
				const off = buf.readUInt32LE(base + field);
				return off && base + off < buf.length ? cstr(buf, base + off) : "";
			};
			const unicode = (field) => {
				const off = buf.readUInt32LE(base + field);
				return off && base + off < buf.length ? cstr16(buf, base + off) : "";
			};
			const wide = headerSize >= 0x24;
			let path = "";
			if (infoFlags & 1) path = wide ? unicode(0x1c) : ansi(16);
			const suffix = wide ? unicode(0x20) : ansi(0x18);
			if (!path) path = ansi(16);
			if (path) return trimExe(path + (suffix || ""));
		}
	}
	return scanExePath(buf);
}

/** .lnk 的 LocalBasePath 是系统 ANSI 码页（中文机是 GBK），不是 latin1：
 *  `D:\WorkBuddy国际版\...` 用 latin1 解出来是 `D:\WorkBuddy¹ú¼Ê°æ\...`，路径直接不存在。
 *  按码页解码；不认识的码页/非法字节退回 latin1，保持旧行为。 */
const ansiDecoder = (() => {
	let label = "";
	try {
		const cp = execFileSync("reg", ["query", String.raw`HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage`, "/v", "ACP"], {
			encoding: "utf8",
			timeout: 2000,
			windowsHide: true,
		});
		const m = cp.match(/ACP\s+REG_SZ\s+([0-9]+)/);
		if (m) label = m[1] === "936" ? "gbk" : m[1] === "950" ? "big5" : m[1] === "932" ? "shift_jis" : m[1] === "949" ? "euc-kr" : m[1] === "1252" ? "windows-1252" : `windows-${m[1]}`;
	} catch {
		// 取不到就用平台默认（Windows 中文机 Node 的 TextDecoder("gbk") 也能用）
		label = "";
	}
	const candidates = [label, "gbk", "big5", "windows-1252"].filter(Boolean);
	for (const enc of candidates) {
		try {
			return new TextDecoder(enc, { fatal: true });
		} catch {}
	}
	return null;
})();

function decodeAnsi(buf, start, end) {
	const bytes = buf.subarray(start, end);
	if (!ansiDecoder) return buf.toString("latin1", start, end);
	try {
		return ansiDecoder.decode(bytes);
	} catch {
		return buf.toString("latin1", start, end);
	}
}

function cstr(buf, start) {
	let end = start;
	while (end < buf.length && buf[end] !== 0) end++;
	return decodeAnsi(buf, start, end);
}

function cstr16(buf, start) {
	let end = start;
	while (end + 1 < buf.length && buf.readUInt16LE(end) !== 0) end += 2;
	return buf.toString("utf16le", start, end);
}

/** 兜底：从二进制里捞出第一个形如 `X:\...\xxx.exe` 的可打印串 */
function scanExePath(buf) {
	for (const enc of ["latin1", "utf16le"]) {
		const m = buf.toString(enc).match(/[A-Za-z]:[\\/][^\0<>|*?"\r\n]{1,240}?\.exe/i);
		if (m) return m[0];
	}
	return null;
}

function trimExe(p) {
	const s = String(p).replace(/\0.*$/, "").trim();
	const m = s.match(/^[A-Za-z]:[\\/][\s\S]*?\.exe/i);
	return m ? m[0] : s || null;
}

// ---------- 数据源 ----------

function startMenuRoots(home) {
	const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
	const programData = process.env.ProgramData || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
	return [
		join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
		join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
		join(home, "Desktop"),
		join(process.env.PUBLIC || "C:\\Users\\Public", "Desktop"),
	];
}

function walkShortcuts(dir, out, depth = 0) {
	if (depth > 4) return out;
	let items;
	try {
		items = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const item of items) {
		const full = join(dir, item.name);
		if (item.isDirectory()) walkShortcuts(full, out, depth + 1);
		else if (/\.lnk$/i.test(item.name)) out.push(full);
	}
	return out;
}

/** 快捷方式索引：lnk 文件名（小写、去扩展名）+ 目标 exe 名 → 目标路径 */
export function shortcutIndex(home = process.env.USERPROFILE || process.env.HOME) {
	const index = new Map();
	for (const root of startMenuRoots(home)) {
		for (const lnk of walkShortcuts(root, [])) {
			const target = readShortcutTarget(lnk);
			if (!target) continue;
			index.set(basename(lnk, ".lnk").toLowerCase(), target);
			index.set(baseOf(target).toLowerCase(), target);
		}
	}
	return index;
}

/** 注册表卸载项：按显示名做定向搜索（全量 /s 在 HKLM 上要 3 秒以上，不能每次开机都跑） */
export function uninstallEntries(match) {
	if (!WIN || !match) return [];
	const roots = [
		String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
		String.raw`HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
		String.raw`HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
	];
	const out = [];
	for (const root of roots) {
		let text = "";
		try {
			text = execFileSync("reg", ["query", root, "/s", "/f", match, "/d"], {
				encoding: "latin1",
				timeout: 4000,
				windowsHide: true,
			});
		} catch {
			continue;
		}
		let cur = null;
		for (const line of text.split(/\r?\n/)) {
			if (/^HKEY_/i.test(line)) {
				if (cur) out.push(cur);
				cur = { name: "", location: "", icon: "" };
				continue;
			}
			const m = line.match(/^\s{4}(\S+)\s+REG_[A-Z_]+\s+(.*)$/);
			if (!m || !cur) continue;
			const value = m[2].trim().replace(/^"|"$/g, "");
			if (m[1] === "DisplayName") cur.name = value;
			else if (m[1] === "InstallLocation") cur.location = value;
			else if (m[1] === "DisplayIcon") cur.icon = value.replace(/,\d+$/, "");
		}
		if (cur) out.push(cur);
	}
	return out.filter((e) => e.name);
}

/** 本机盘符（只用于最后兜底，结果缓存 60 秒） */
let driveCache = { at: 0, list: [] };
export function fixedDrives() {
	// 测试与「盘符扫描太慢/有断线网络盘」的场景可以直接指定要扫的根（任何平台都认）
	const override = process.env.AGENT_PURGE_DRIVES;
	if (override) return override.split(";").map((s) => s.trim()).filter(Boolean);
	if (!WIN) return [];
	if (Date.now() - driveCache.at < 60_000) return driveCache.list;
	const list = [];
	for (let i = 67; i <= 90; i++) {
		const root = `${String.fromCharCode(i)}:\\`;
		try {
			if (existsSync(root)) list.push(root);
		} catch {}
	}
	driveCache = { at: Date.now(), list };
	return list;
}

export function defaultSources(home = process.env.USERPROFILE || process.env.HOME) {
	return {
		home,
		local: process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
		roaming: process.env.APPDATA || join(home, "AppData", "Roaming"),
		drives: fixedDrives(),
	};
}

// ---------- 盘内浅扫（没有快捷方式、目录名也不标准时兜底） ----------
// 每块盘只走一遍（深度 3、跳过系统目录、带时间预算），把「所有桌面端的 exe 名」一次收进索引；
// 之后各家 locate 只是查表。装在 F:\Green\WorkBuddy2 这种地方也能找到，又不会整盘翻。
const SCAN_SKIP = new Set([
	"windows",
	"$recycle.bin",
	"system volume information",
	"programdata",
	"node_modules",
	"appdata",
	"perflogs",
	"recovery",
	"$windows.~bt",
	"$windows.~ws",
	".git",
]);
const scanTargets = new Set();
let scanWildcards = [];
const driveIndex = new Map();
const SCAN_TTL = 10 * 60_000;
const SCAN_BUDGET = 600;
let targetsVersion = 0;

/** detect 一开始把全部桌面端 exe 名登记进来，保证每块盘只扫一次就能服务所有 harness */
export function registerScanTargets(names) {
	let changed = false;
	for (const name of names) {
		const key = lower(name);
		if (key && !scanTargets.has(key)) {
			scanTargets.add(key);
			changed = true;
		}
	}
	if (changed) {
		scanWildcards = [...scanTargets].filter(hasWildcard);
		targetsVersion++;
	}
}

function indexDrive(root) {
	const hit = driveIndex.get(root);
	if (hit && hit.version === targetsVersion && Date.now() - hit.at < SCAN_TTL) return hit.found;
	const found = new Map();
	const started = Date.now();
	const stack = [{ dir: root, depth: 0 }];
	while (stack.length) {
		if (Date.now() - started > SCAN_BUDGET) break;
		const { dir, depth } = stack.pop();
		let items;
		try {
			items = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const it of items) {
			if (!it.isFile()) continue;
			const key = lower(it.name);
			const matched = scanTargets.has(key) || scanWildcards.some((p) => matchExeName(key, p));
			if (matched && !found.has(key)) found.set(key, join(dir, it.name));
		}
		if (depth >= 3) continue;
		for (const it of items) {
			if (!it.isDirectory()) continue; // 符号链接/联接点不跟，避免绕圈
			if (SCAN_SKIP.has(lower(it.name))) continue;
			stack.push({ dir: join(dir, it.name), depth: depth + 1 });
		}
	}
	driveIndex.set(root, { at: Date.now(), found, version: targetsVersion });
	return found;
}

/** 在给定盘根里找这些 exe（走共享索引；找不到返回空数组） */
export function scanDrives(exesRaw, roots) {
	registerScanTargets(exesRaw);
	const out = [];
	for (const root of roots ?? []) {
		const found = indexDrive(root);
		for (const exe of exesRaw) {
			const want = lower(exe);
			if (!hasWildcard(want)) {
				const path = found.get(want);
				if (path) out.push(path);
				continue;
			}
			for (const [name, path] of found) {
				if (matchExeName(name, want)) {
					out.push(path);
					break;
				}
			}
		}
	}
	return out;
}

// 进程内缓存：一次刷新里 4 个桌面端不该各扫一遍开始菜单
const shortcutCache = new Map();
const registryCache = new Map();
function shortcutsOf(sources) {
	if (sources.shortcuts) return sources.shortcuts;
	const key = sources.home || "";
	if (!shortcutCache.has(key)) shortcutCache.set(key, shortcutIndex(sources.home));
	return shortcutCache.get(key);
}
function entriesOf(sources, name) {
	if (sources.entries) return sources.entries;
	const key = lower(name);
	if (!registryCache.has(key)) registryCache.set(key, uninstallEntries(name));
	return registryCache.get(key);
}

// ---------- 定位 ----------

const lower = (s) => String(s).toLowerCase();

/**
 * @param spec {{ names?: string[], exe?: string[], folder?: string[] }}
 *   names  产品名（注册表显示名、快捷方式名）
 *   exe    可执行文件名，如 WorkBuddy.exe
 *   folder 安装目录名，如 WorkBuddy
 */
export function locate(spec, sources = defaultSources()) {
	const namesRaw = spec.names ?? [];
	const exesRaw = spec.exe ?? [];
	const foldersRaw = spec.folder ?? spec.names ?? [];
	const names = namesRaw.map(lower);
	const exes = exesRaw.map(lower);
	const folders = foldersRaw.map(lower);
	const isExe = (p) => exes.some((e) => matchExeName(baseOf(p), e));

	const findExeIn = (dir) => {
		for (const pattern of exesRaw) {
			if (!hasWildcard(pattern)) {
				const full = join(dir, pattern);
				if (existsSync(full)) return full;
				continue;
			}
			let items = [];
			try {
				items = readdirSync(dir);
			} catch {
				continue;
			}
			const hit = items.find((name) => matchExeName(name, pattern));
			if (hit) return join(dir, hit);
		}
		return null;
	};

	// 1) 开始菜单/桌面快捷方式：装在任何盘都能指对。先按 exe 名全表匹配，
	//    免得「Antigravity Tools」这种同名前缀的另一个程序把 antigravity 抢走。
	for (const target of shortcutsOf(sources).values()) {
		if (exes.length && isExe(target)) return { dir: dirOf(target), exe: target, source: "shortcut" };
	}
	for (const [key, target] of shortcutsOf(sources)) {
		if (folders.includes(key) || names.includes(key)) return { dir: dirOf(target), exe: target, source: "shortcut" };
	}

	// 2) 用户级安装目录 + 每盘常见根：<盘>:、Program Files、Programs、Apps
	for (const folder of foldersRaw) {
		const guesses = [
			join(sources.roaming, folder),
			join(sources.local, folder),
			join(sources.local, "Programs", folder),
			...(sources.drives ?? []).flatMap((root) => [
				join(root, folder),
				join(root, "Program Files", folder),
				join(root, "Program Files (x86)", folder),
				join(root, "Programs", folder),
				join(root, "Apps", folder),
			]),
		];
		for (const dir of guesses) {
			if (!existsSync(dir) || !isDir(dir)) continue;
			const exe = findExeIn(dir);
			if (exes.length && !exe) continue;
			return { dir, exe, source: "guess" };
		}
	}

	// 3) 注册表卸载项：安装器写了 InstallLocation / DisplayIcon 的（最慢，放最后）
	for (const name of spec.names ?? []) {
		for (const e of entriesOf(sources, name)) {
			const icon = e.icon && existsSync(e.icon) && isExe(e.icon) ? e.icon : null;
			const dir = (e.location && existsSync(e.location) && e.location) || (icon ? dirOf(icon) : null);
			if (dir) return { dir, exe: icon, source: "registry" };
		}
	}
	// 4) 每块盘浅扫三层：目录名不叫 WorkBuddy、也没建快捷方式的绿色版/换名安装
	if (exes.length && sources.drives?.length) {
		for (const exe of scanDrives(exesRaw, sources.drives)) {
			return { dir: dirOf(exe), exe, source: "scan" };
		}
	}
	return null;
}

function isDir(p) {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}
