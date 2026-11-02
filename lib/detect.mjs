// 自动探测：这台机器上装了哪些 harness、装在哪、配置目录是哪个。
// 只读文件系统与 PATH，不执行 harness（版本号要 --versions 才去 spawn）。
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { captureBin, which } from "./spawn.mjs";
import { configHome } from "./paths.mjs";

const home = process.env.USERPROFILE || process.env.HOME;
const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
const win = process.platform === "win32";

// 每家的"长什么样"：可执行文件、配置根（含环境变量覆盖）、版本命令
export const specs = {
	codex: { bins: ["codex"], homes: [["CODEX_HOME", ".codex"]], version: ["--version"], marker: "config.toml" },
	codebuddy: { bins: ["codebuddy"], homes: [["CODEBUDDY_HOME", ".codebuddy"]], version: ["--version"], marker: "history.jsonl" },
	claude: { bins: ["claude"], homes: [["CLAUDE_CONFIG_DIR", ".claude"]], version: ["--version"], marker: "settings.json" },
	opencode: { bins: ["opencode"], homes: [["XDG_CONFIG_HOME", ".config/opencode"]], version: ["--version"], marker: "opencode.json" },
	opencode2: { bins: ["opencode2"], homes: [["XDG_CONFIG_HOME", ".config/opencode"]], version: ["--version"], marker: "opencode.json" },
	dsh: { bins: ["dsh"], homes: [["DSH_HOME", ".dsh"]], version: ["--version"], marker: "profiles" },
	grok: { bins: ["grok"], homes: [["GROK_HOME", ".grok"]], version: ["--version"], marker: "config.toml" },
	omp: { bins: ["omp"], homes: [["OMP_HOME", ".omp"]], version: ["--version"], marker: "agent/config.yml" },
	hermes: { bins: ["hermes"], homes: [["HERMES_HOME", "AppData/Local/hermes"]], version: ["--version"], marker: "hermes-agent" },
	pi: { bins: ["pi"], homes: [["PI_HOME", ".pi/agent"]], version: ["--version"], marker: "extensions" },
	zcode: {
		bins: ["zcode"],
		homes: [["ZCODE_HOME", ".zcode"]],
		version: ["--version"],
		marker: "v2/provider_config.json",
		extra: ["Programs/zcode", "..\\zcode"],
	},
	workbuddy: {
		bins: ["WorkBuddy", "workbuddy"],
		homes: [["WORKBUDDY_TEMPLATES_DIR", "AppData/Local/Programs/WorkBuddy"]],
		version: null,
		marker: "resources/app.asar.unpacked/resources/templates/workbuddy-prompt.tpl",
		extra: ["D:/WorkBuddy", "C:/Program Files/WorkBuddy"],
	},
	antigravity: { bins: ["antigravity"], homes: [["", "Programs/antigravity"]], version: null, marker: "resources/bin/language_server.exe" },
};

export function detect({ versions = false } = {}) {
	const path = process.env.PATH || "";
	const out = {};
	for (const [id, spec] of Object.entries(specs)) {
		const bin = which(spec.bins, path);
		const roots = configHome(id) ? [configHome(id)] : spec.homes.map(([env, rel]) => {
			const raw = env && process.env[env] ? process.env[env] : rel;
			// 显式环境变量可能是任意平台的绝对路径：不能靠 ":" 判断（POSIX 路径没有冒号）
			return raw.startsWith(".") || raw.startsWith("AppData")
				? join(home, raw)
				: isAbsolute(raw)
					? raw
					: join(local, raw);
		});
		const found = roots.map((r) => ({ path: r, exists: existsSync(join(r, spec.marker)) })).filter((r) => r.exists);
		out[id] = {
			id,
			bin,
			version: versions && bin && spec.version ? probe(bin, spec.version) : null,
			home: found[0]?.path ?? roots[0],
			homeExists: found.length > 0,
			found: Boolean(bin || found.length),
		};
	}
	return out;
}

export function probe(bin, args) {
	// 走 spawn 桥接：.cmd/.ps1 shim 才能启动（execFileSync 直接打 .cmd 在 Windows 上必失败）
	const out = captureBin(bin, args);
	return out ? out.trim().split("\n")[0].slice(0, 60) : null;
}

// 已安装的常驻配置（由 persist 层告知，这里只做展示用的存在性判断）
export function readJsonSafe(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}
