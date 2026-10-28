// Windows 安全的进程启动。
// 为什么需要它：npm 全局 shim 不是 .exe，而 CreateProcess 只认 .exe ——
// spawn("codex", { shell: false }) 在 Windows 上必 ENOENT
// （实测：codex / pi / opencode / codebuddy 全中；claude / grok / omp / hermes 有真 .exe 才没事）。
// 也不用 shell: true：那会把 persona 文本交给 cmd.exe 解析，%VAR% 展开、^ 被吃，全是注入面。
// 做法：先把名字解析成磁盘全路径，再按扩展名分流，优先级：
//   .exe      → 直接启动（真二进制；Unix 一切照旧）
//   .ps1      → powershell -File（npm>=7 与 pi 安装器都生成；$args 数组传参，实测
//               引号/空格/%VAR%/^/&| 全部字节级保真）
//   .cmd/.bat → ComSpec /d /s /c 兜底（老 npm 或手写 shim；仍有 cmd 展开风险，故排最后）
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";

const WIN = process.platform === "win32";

/** 我们自己的裸命令目录：扫 PATH 时必须跳过它，否则 spawn 会绕回 wrapper 套娃 */
const OWN_SHIM_DIR = join(process.env.USERPROFILE || process.env.HOME || homedir(), ".agent-purge", "bin");

/** 在 PATH 上按扩展名优先级找可执行文件；找不到返回 null。 */
export function which(names, path, exts = WIN ? [".exe", ".cmd", ".bat", ".ps1"] : [""]) {
	const own = resolve(OWN_SHIM_DIR).toLowerCase();
	for (const name of names) {
		for (const dir of path.split(delimiter)) {
			if (!dir) continue;
			if (resolve(dir).toLowerCase() === own) continue;
			for (const ext of exts) {
				const p = join(dir, name + ext);
				if (existsSync(p)) return p;
			}
		}
	}
	return null;
}

// 启动解析优先级：真二进制 > .ps1（保真）> .cmd/.bat（兜底）
const SPAWN_EXTS = [".exe", ".ps1", ".cmd", ".bat"];

/** 把命令名解析成磁盘全路径；找不到返回 null。 */
export function resolveBin(name) {
	if (!name) return null;
	if (name.includes("/") || name.includes("\\")) return existsSync(name) ? name : null;
	// shim 接管：wrapper 会把自己的真身写进 AGENT_PURGE_REAL_BIN，优先用它，
	// 否则 PATH 里排第一的是我们自己的 wrapper，会无限套娃。
	const real = process.env.AGENT_PURGE_REAL_BIN;
	if (real && existsSync(real)) {
		const base = real.trim().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
		if (base === String(name).toLowerCase()) return real.trim();
	}
	return which([name], process.env.PATH || "", WIN ? SPAWN_EXTS : [""]);
}

/** cmd.exe 侧的单参加引号：含空格或引号时整体包起来，内嵌引号转成 \"（msvcrt argv 认识它） */
const winQuote = (a) => {
	const s = String(a);
	return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
};

/**
 * cmd.exe 的命令行上限是 8191 字符（真·硬限）。npm 全局 shim 都是 .cmd，
 * 一旦参数里夹了整段人设（9K+），裸命令就会报“The command line is too long.”，
 * 而 agent-purge <h> 没这条限制 —— 同一个 harness 两种入口行为不一致。
 * 解：找出 .cmd 里真正启动的 node 脚本，直接 node 启，绕开 cmd.exe。
 * 只认 npm 的 `"%dp0%...node_modules..."` 形态，认不出就老实走 ComSpec。
 */
const CMD_LINE_LIMIT = 7000;
function cmdShimNodeTarget(file) {
	try {
		const txt = readFileSync(file, "utf8");
		const m = txt.match(/"%dp0%\\?([^"]*node_modules[^"]*)"/i);
		if (!m) return null;
		const p = join(dirname(file), m[1].replace(/\\/g, "\\"));
		return existsSync(p) ? p : null;
	} catch {
		return null;
	}
}

function dispatch(name, args, opts) {
	// 非 Windows 也要解析成真实路径：否则 shim 目录里的同名壳转回 agent-purge 时，
	// spawn("pi") 又会命中最前面的壳，无限套娃。
	if (!WIN) return { cmd: resolveBin(name) ?? name, args, opts: { ...opts, shell: false } };
	const full = resolveBin(name) ?? name;
	const ext = extname(full).toLowerCase();
	if (ext === ".ps1") {
		return {
			cmd: "powershell.exe",
			args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", full, ...args],
			opts: { ...opts, shell: false },
		};
	}
	if (ext === ".cmd" || ext === ".bat") {
		const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
		// /s：首尾成对的引号由 cmd 自己剥掉一层，剩下的就是干净的命令行
		const line = [`"${full}"`, ...args.map(winQuote)].join(" ");
		// 参数太长就不要过 cmd.exe（8191 上限）：直接 node 启 .cmd 里那个脚本
		if (line.length > CMD_LINE_LIMIT) {
			const js = cmdShimNodeTarget(full);
			if (js) return { cmd: process.execPath, args: [js, ...args], opts: { ...opts, shell: false } };
		}
		return {
			cmd: comspec,
			args: ["/d", "/s", "/c", `"${line}"`],
			opts: { ...opts, shell: false, windowsVerbatimArguments: true },
		};
	}
	return { cmd: full, args, opts: { ...opts, shell: false } };
}

/** 跨平台启动。返回 ChildProcess；调用方照常用 on("error")/on("close")。 */
export function spawnBin(name, args = [], opts = {}) {
	const d = dispatch(name, args, opts);
	return spawn(d.cmd, d.args, d.opts);
}

/** 抓一次 stdout（版本探测之类用）。失败/超时返回 null，不抛。 */
export function captureBin(name, args = [], opts = {}) {
	const d = dispatch(name, args, { timeout: 4000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts });
	try {
		const r = spawnSync(d.cmd, d.args, d.opts);
		return r.error ? null : (r.stdout ?? null);
	} catch {
		return null;
	}
}
