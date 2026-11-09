// 自动探测：这台机器上装了哪些 harness、装在哪、配置目录是哪个。
// 只读文件系统与 PATH，不执行 harness（版本号要 --versions 才去 spawn）。
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { locate, registerScanTargets } from "./locate.mjs";
import { captureBin, which } from "./spawn.mjs";
import { configHome } from "./paths.mjs";

/**
 * 每家的"长什么样"：可执行文件、配置根（含环境变量覆盖）、版本命令。
 *
 * - bins       PATH 上的命令名
 * - binPaths   PATH 里找不到时再看这些常见落点（GUI 启动继承的 PATH 常缺 shell 里的目录）
 * - homes      配置根候选；marker=null 表示「目录存在就算装上」
 * - marker     字符串 / 数组，命中任意一个即算装上
 * - configs    与安装目录分开的用户配置根（桌面端），用于判定「跑过这个 App」
 * - configMarker 配置根里的标志文件
 * - apps      桌面端安装目录定位线索（快捷方式/注册表/盘符扫描）；装在任何盘都能认出来
 *
 * 每次调用都重新读环境变量：测试与「用户刚装完就刷新」都要看到最新值。
 */
export function harnessSpecs() {
	const home = process.env.USERPROFILE || process.env.HOME;
	const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
	const roaming = process.env.APPDATA || join(home, "AppData", "Roaming");
	const win = process.platform === "win32";
	const exe = (name) => (win ? `${name}.exe` : name);

	// 通用兜底：npm/bun/scoop 全局装的 CLI，这些目录常常不在 GUI 进程继承到的 PATH 里。
	// 只列包管理器落点，不列 Programs\<名字>：那里的同名 exe 大概率是桌面版，--version 会把 App 拉起来。
	const commonBins = (names) =>
		names.flatMap((name) => [
			join(roaming, "npm", win ? `${name}.cmd` : name),
			join(home, ".bun", "bin", exe(name)),
			join(home, ".local", "bin", exe(name)),
			join(home, "scoop", "shims", exe(name)),
		]);

	// opencode 的几种装法：官方安装器（~/.opencode/bin）、bun 全局（~/.bun/bin）、npm 全局、scoop。
	// 这些目录常常不在 GUI 进程继承到的 PATH 里，只看 PATH 会误报「未安装」。
	const opencodeBinPaths = [
		join(home, ".opencode", "bin", exe("opencode")),
		join(home, ".bun", "bin", exe("opencode")),
		join(roaming, "npm", win ? "opencode.cmd" : "opencode"),
		join(local, "Programs", "opencode", exe("opencode")),
		join(home, "scoop", "shims", exe("opencode")),
	];

	return {
		codex: { bins: ["codex"], binPaths: commonBins(["codex"]), homes: [["CODEX_HOME", ".codex"]], version: ["--version"], marker: "config.toml" },
		codebuddy: { bins: ["codebuddy"], binPaths: commonBins(["codebuddy"]), homes: [["CODEBUDDY_HOME", ".codebuddy"]], version: ["--version"], marker: "history.jsonl" },
		claude: { bins: ["claude"], binPaths: commonBins(["claude"]), homes: [["CLAUDE_CONFIG_DIR", ".claude"]], version: ["--version"], marker: "settings.json" },
		opencode: {
			bins: ["opencode"],
			binPaths: opencodeBinPaths,
			homes: [["XDG_CONFIG_HOME", ".config/opencode"]],
			version: ["--version"],
			// 用 opencode.json 单文件当判据会把只用 jsonc / 只登录过 / 只装了插件的用户判成没装
			marker: ["opencode.json", "opencode.jsonc", "config.json", "auth.json", "plugins", "node_modules"],
		},
		opencode2: {
			bins: ["opencode2"],
			binPaths: opencodeBinPaths,
			homes: [["XDG_CONFIG_HOME", ".config/opencode"]],
			version: ["--version"],
			marker: ["opencode.json", "opencode.jsonc", "config.json", "auth.json", "plugins", "node_modules"],
		},
		dsh: {
			bins: ["dsh"],
			binPaths: commonBins(["dsh"]),
			homes: [["DSH_HOME", ".dsh"]],
			version: ["--version"],
			marker: "profiles",
			// 桌面版常装在 D:/DSH 这类自定义目录，双击启动不经过 PATH
			apps: { names: ["DeepSeek Harness", "DSH"], exe: ["DeepSeek Harness.exe"], folder: ["DSH", "DeepSeek Harness"] },
		},
		grok: { bins: ["grok"], binPaths: commonBins(["grok"]), homes: [["GROK_HOME", ".grok"]], version: ["--version"], marker: "config.toml" },
		omp: { bins: ["omp"], binPaths: commonBins(["omp"]), homes: [["OMP_HOME", ".omp"]], version: ["--version"], marker: "agent/config.yml" },
		hermes: { bins: ["hermes"], binPaths: commonBins(["hermes"]), homes: [["HERMES_HOME", "AppData/Local/hermes"]], version: ["--version"], marker: "hermes-agent" },
		pi: { bins: ["pi"], binPaths: [...commonBins(["pi"]), join(home, ".pi", "agent", "bin", exe("pi"))], homes: [["PI_HOME", ".pi/agent"]], version: ["--version"], marker: "extensions" },
		zcode: {
			bins: ["zcode"],
			binPaths: [join(local, "Programs", "zcode", exe("ZCode")), join(local, "Programs", "zcode", exe("zcode"))],
			homes: [["ZCODE_HOME", ".zcode"]],
			version: ["--version"],
			marker: "v2/provider_config.json",
			// 闭源桌面：装在哪都有可能（以前写死了 D:/zcode）
			apps: { names: ["ZCode"], exe: ["ZCode.exe"], folder: ["zcode"] },
		},
		kilo: {
			bins: ["kilo", "kilocode"],
			binPaths: commonBins(["kilo", "kilocode"]),
			homes: [["KILO_CONFIG_DIR", ".config/kilo"]],
			version: ["--version"],
			marker: "agent",
		},
		workbuddy: {
			bins: ["WorkBuddy", "workbuddy"],
			homes: [
				["WORKBUDDY_TEMPLATES_DIR", "AppData/Local/Programs/WorkBuddy"],
				["", join(local, "Programs", "WorkBuddy")],
				["", "%ProgramFiles%/WorkBuddy"],
				["", "%ProgramFiles(x86)%/WorkBuddy"],
			],
			// 用户配置目录：App 跑过一次就会建出来。装在哪都能认出来，不依赖安装目录布局。
			configs: [["WORKBUDDY_CONFIG_DIR", ".workbuddy"]],
			configMarker: null,
			version: null,
			// 旧判据是「安装包里必须还有 workbuddy-prompt.tpl」——那是模板补丁时代的东西，
			// 版本一改布局就误报未安装。安装目录存在本身就够了。
			marker: ["WorkBuddy.exe", "resources/app.asar", "resources/app.asar.unpacked"],
			apps: { names: ["WorkBuddy"], exe: ["WorkBuddy.exe"], folder: ["WorkBuddy", "workbuddy"] },
		},
		"workbuddy-ai": {
			bins: ["WorkBuddyAI", "workbuddy-ai", "workbuddyai", "WorkBuddy AI"],
			homes: [
				["WORKBUDDY_AI_TEMPLATES_DIR", "AppData/Local/Programs/WorkBuddyAI"],
				["", join(local, "Programs", "WorkBuddyAI")],
				["", join(local, "Programs", "WorkBuddy AI")],
				["", "%ProgramFiles%/WorkBuddyAI"],
				["", "%ProgramFiles%/WorkBuddy AI"],
				["", "%ProgramFiles(x86)%/WorkBuddyAI"],
				["", "%ProgramFiles(x86)%/WorkBuddy AI"],
			],
			configs: [["WORKBUDDY_AI_CONFIG_DIR", ".workbuddy-ai"]],
			configMarker: null,
			version: null,
			marker: ["WorkBuddyAI.exe", "WorkBuddy AI.exe", "resources/app.asar", "resources/app.asar.unpacked"],
			apps: { names: ["WorkBuddy AI", "WorkBuddyAI"], exe: ["WorkBuddyAI.exe", "WorkBuddy AI.exe"], folder: ["WorkBuddyAI", "WorkBuddy AI", "workbuddy-ai", "workbuddyai"] },
		},
		"pi-desktop": {
			// 桌面端没有命令行入口；数据根是 ~/.pi-desktop（dev 版是 ~/.pi-desktop-dev）。
			// 不能拿 ~/.pi/agent 当判据：那是 pi CLI 的目录，装了 pi 不等于装了 PI-Desktop。
			bins: [],
			homes: [["PI_DESKTOP_DATA_DIR", ".pi-desktop"]],
			version: null,
			marker: ["plugins", "pi.sqlite", "secrets"],
			apps: { names: ["PI-Desktop", "PI Desktop"], exe: ["PI-Desktop.exe", "PI-Desktop-Portable*.exe"], folder: ["PI-Desktop", "pi-desktop"] },
		},
		antigravity: {
			// 桌面 App 与 CLI(agy) 是两个独立产物：App 在 Programs/Antigravity，CLI 装在
			// %LOCALAPPDATA%\agy\bin\agy.exe。CLI 有 --version，App 没有。
			bins: ["agy", "antigravity"],
			binPaths: [join(local, "agy", "bin", exe("agy")), join(home, ".local", "bin", exe("agy"))],
			homes: [["", "Programs/antigravity"]],
			configs: [["AGY_CONFIG_DIR", ".gemini/config"]],
			configMarker: null,
			version: ["--version"],
			marker: ["resources/bin/language_server.exe", "AGENTS.md", "agents", "rules", "skills"],
			apps: { names: ["Antigravity"], exe: ["Antigravity.exe"], folder: ["antigravity"] },
		},
	};
}

function isDir(p) {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function markerList(value) {
	if (value == null) return [null];
	return Array.isArray(value) ? value : [value];
}

function expandRoot([env, rel], home, local) {
	const raw = env && process.env[env] ? process.env[env] : rel;
	// 安装目录常写成 %ProgramFiles% 这种形式；变量没定义就当作根目录下的普通名字
	const expanded = raw.replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all);
	// 显式环境变量可能是任意平台的绝对路径：不能靠 ":" 判断（POSIX 路径没有冒号）
	if (expanded.startsWith(".") || expanded.startsWith("AppData")) return join(home, expanded);
	return isAbsolute(expanded) ? expanded : join(local, expanded);
}

export function detect({ versions = false } = {}) {
	const path = process.env.PATH || "";
	const home = process.env.USERPROFILE || process.env.HOME;
	const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
	const specs = harnessSpecs();
	// 先把所有桌面端的 exe 名登记给盘内浅扫：一次遍历服务全部 harness，别一家扫一遍
	registerScanTargets(Object.values(specs).flatMap((spec) => spec.apps?.exe ?? []));
	const out = {};
	for (const [id, spec] of Object.entries(specs)) {
		const bin = which(spec.bins, path) || (spec.binPaths ?? []).find((p) => existsSync(p)) || null;
		const markers = markerList(spec.marker);
		const hit = (root) => markers.some((m) => existsSync(m ? join(root, m) : root));

		const roots = configHome(id) ? [configHome(id)] : spec.homes.map((h) => expandRoot(h, home, local));
		const found = roots.filter(hit);
		// 配置根本身就代表「跑过」：新装还没写 marker（claude 没设过 settings.json、grok 没改过 config.toml）不该算没装
		const existing = roots.filter(isDir);

		// 桌面端：安装目录和用户配置目录分开算，任一命中都算「装过这台机器」
		const cfgRoots = (spec.configs ?? []).map((h) => expandRoot(h, home, local));
		const cfgMarkers = markerList(spec.configMarker);
		const cfgFound = cfgRoots.filter((r) => cfgMarkers.some((m) => existsSync(m ? join(r, m) : r)));

		// 桌面端装在别的盘（F:\workbuddy）时，配置根也可能不在默认位置：问快捷方式/注册表/盘符
		const app = spec.apps ? locate(spec.apps) : null;

		out[id] = {
			id,
			bin,
			version: versions && bin && spec.version ? probe(bin, spec.version) : null,
			home: cfgFound[0] ?? found[0] ?? existing[0] ?? cfgRoots[0] ?? roots[0],
			install: app?.dir ?? null,
			installSource: app?.source ?? null,
			homeExists: found.length > 0 || existing.length > 0 || cfgFound.length > 0,
			found: Boolean(bin || found.length || existing.length || cfgFound.length || app),
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
