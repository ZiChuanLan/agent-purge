// 证据链：跑真二进制 → 本机假 provider → 看它到底把什么发给了模型。
// 这里不信任 harness 的自述、也不信 matrix.json 的常量表，只认抓到的请求体。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnBin, resolveBin } from "./spawn.mjs";
import { isolatedEnv } from "./environment.mjs";
import { isCompiled } from "./root.mjs";
import { antigravityBin } from "./antigravity.mjs";
export { isolatedEnv } from "./environment.mjs";
import { inspectRequest, requestKind, startCaptureProvider } from "../bench/capture-provider.mjs";
import { writeVerification } from "../bench/capture-report.mjs";

// goose 用 winget 装，二进制不在 PATH 里；按固定落点找，找不到再退回 PATH。
export function gooseBin() {
	if (process.platform !== "win32") return resolveBin("goose");
	const base = join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
	try {
		for (const dir of readdirSync(base)) {
			if (!dir.toLowerCase().startsWith("agenticai")) continue;
			const hit = findFile(join(base, dir), "goose.exe");
			if (hit) return hit;
		}
	} catch {
		/* 没有 winget 目录就退回 PATH */
	}
	return resolveBin("goose");
}

function findFile(dir, name, depth = 0) {
	if (depth > 4) return null;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name) return join(dir, e.name);
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const hit = findFile(join(dir, e.name), name, depth + 1);
		if (hit) return hit;
	}
	return null;
}

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-purge.mjs");

// 隔离 HOME 是临时脚手架：证据落在 out/，临时树不能越攒越多。
const ISOLATED_ROOTS = [];
export function trackRoot(root) {
	ISOLATED_ROOTS.push(root);
	return root;
}

export function cleanupRoots() {
	if (process.env.AP_KEEP_ROOTS || process.argv.includes("--keep-roots")) return;
	for (const root of ISOLATED_ROOTS.splice(0)) {
		// 不用 rm -rf：Windows 没有；node 自己的重试删除两边都可靠
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch {
			/* 临时目录删不掉不影响证据 */
		}
	}
}

export function agentCommand(args) { return { cmd: process.execPath, args: isCompiled() ? args : [CLI, ...args] }; }

export function captureOutcome(result, requests, mode) {
	const detail = String(result.error || result.stderr || result.stdout || "").trim().slice(-1800);
	if (result.timedOut) return { status: "error", reason: `执行器超时${detail ? `：${detail}` : ""}` };
	if (!requests.length) {
		if (result.error || result.code !== 0) return { status: "error", reason: `执行器未正常结束（退出码 ${result.code ?? "未知"}）${detail ? `：${detail}` : ""}` };
		return { status: "no-request", reason: "执行器已退出，但没有捕获到主请求；不能据此判断人设是否生效。" };
	}
	// 判定看所有主请求：宿主可能先发辅助主请求（gemini 的复杂度分类器、qwen 的记忆抽取），
	// 那些请求带宿主自己的 system，不该让人设注入判定失败；只要有一个主请求正好带一次人设即可。
	const hits = requests.filter((request) => request.markerCount === 1).length;
	// 「注了两遍」是真 bug，任何主请求都不许出现重复注入。
	if (requests.some((request) => request.markerCount > 1))
		return { status: "mismatch", reason: "主请求里人设出现了不止一次，可能被重复注入。" };
	if (mode === "off") {
		if (hits > 0) return { status: "mismatch", reason: "off 模式下主请求里仍出现人设，说明没有真正旁路。" };
	} else if (hits === 0) {
		return { status: "mismatch", reason: "没有任何主请求带人设，注入没生效。" };
	}
	// 请求体已经拿到、人设位置也对，但进程退出码非零：这是宿主自己的收尾问题
	// （qwen / gemini 在 Windows + Node 24 上会撞 libuv 的 UV_HANDLE_CLOSING 断言），
	// 不影响「请求体里有什么」这条证据。如实记下来，不伪装成干净退出。
	if (result.error || result.code !== 0) {
		return {
			status: "captured",
			teardown: `退出码 ${result.code ?? "未知"}（宿主收尾崩溃，请求体已完整捕获）`,
			reason: null,
		};
	}
	return { status: "captured", reason: null };
}

async function prepareCapture(harness, bin, env, cwd, out, timeout, mode = "off") {
	if (harness === "crush" && mode !== "off") {
		// crush 的人设只走 install 通道（写 CRUSH.md 托管块），不安装就不会出现在请求里。
		// 隔离 HOME 用完即删，不需要卸载。
		const command = agentCommand(["install", harness]);
		const r = await runProcess(command.cmd, command.args, { env, cwd, timeout });
		if (out) put(join(out, harness, "prepare.process.json"), r);
		if (r.error || r.timedOut || r.code !== 0)
			throw new Error("无法在隔离 HOME 里安装 crush 托管块：" + (r.error || r.stderr || `exit ${r.code}`));
		// 安装器只写了一处；crush 实际读哪一处随平台而定，四个候选目录都补一份。
		const source = join(env.XDG_CONFIG_HOME, "crush", "CRUSH.md");
		if (existsSync(source)) {
			const body = readFileSync(source, "utf8");
			for (const dir of [join(env.USERPROFILE, ".config"), env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.APPDATA]) {
				if (dir) put(join(dir, "crush", "CRUSH.md"), body);
			}
		}
	}
	if (harness !== "dsh") return;
	// Single-mode verification used to fail in a fresh HOME: only the first
	// `off` run in the four-mode benchmark happened to initialize this profile.
	const result = await runProcess(bin, ["--profile", "headless", "--dump-config"], { env, cwd, timeout });
	if (out) put(join(out, harness, "prepare.process.json"), result);
	if (result.error || result.timedOut || result.code !== 0)
		throw new Error("无法初始化隔离 DSH headless profile：" + (result.error || result.stderr || `exit ${result.code}`));
}

export function runProcess(cmd, args, { env, cwd, timeout = 35000, input } = {}) {
	return new Promise((done) => {
		let child;
		try {
			child = spawnBin(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
		} catch (e) {
			done({ code: null, error: e.message, stdout: "", stderr: "" });
			return;
		}
		let stdout = "",
			stderr = "",
			timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			else child.kill("SIGKILL");
		}, timeout);
		child.stdout.on("data", (b) => (stdout = (stdout + b).slice(-100000)));
		child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-100000)));
		child.on("error", (e) => {
			clearTimeout(timer);
			done({ code: null, error: e.message, stdout, stderr });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code, timedOut, stdout, stderr });
		});
		// 只有真的要喂 stdin 时才关它。无脑 end() 会让 qwen / gemini 这类 Node CLI 在
		// 退出时撞上 libuv 的 UV_HANDLE_CLOSING 断言（Windows + Node 24），把已经跑完的
		// 抓包判成失败。没有输入就让它自己读完 EOF。
		if (input !== undefined) child.stdin.end(input);
		else child.stdin.on("error", () => {});
	});
}

export function put(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

export function seed(env, harness, mode, body) {
	const root = env.AGENT_PURGE_HOME;
	put(join(root, "personas", "capture-a.md"), body);
	put(join(root, "personas", "active.md"), body);
	put(join(root, "state.json"), { v: 1, persona: "capture-a", default: { harness, mode }, armed: {}, piAuto: false, ompAuto: false });
}

export function configure(h, env, url, cwd) {
	// 常规代理变量也被同一个 loopback 服务器接住，避免子进程偷偷走真网络。
	Object.assign(env, {
		HTTP_PROXY: url,
		HTTPS_PROXY: url,
		ALL_PROXY: url,
		NO_PROXY: "127.0.0.1,localhost",
		ANTHROPIC_BASE_URL: url,
		ANTHROPIC_API_KEY: "capture-fixture-key",
		OPENAI_BASE_URL: url + "/v1",
		OPENAI_API_KEY: "capture-fixture-key",
	});
	const model = {
		id: "capture",
		name: "Capture fixture",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 2048,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const providers = { capture: { baseUrl: url + "/v1", api: "openai-completions", apiKey: "capture-fixture-key", models: [model] } };
	if (h === "pi") {
		put(join(env.PI_CODING_AGENT_DIR, "models.json"), { providers });
		put(join(env.PI_CODING_AGENT_DIR, "settings.json"), { packages: [], mcp: { servers: {} } });
		return ["--provider", "capture", "--model", "capture", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session"];
	}
	if (h === "omp") {
		env.PI_CODING_AGENT_DIR = join(env.OMP_HOME, "agent");
		put(join(env.PI_CODING_AGENT_DIR, "models.yml"), JSON.stringify({ providers }));
		return ["--provider", "capture", "--model", "capture", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--no-session"];
	}
	if (h === "claude") return ["--model", "claude-sonnet-4-5", "--max-turns", "1", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--setting-sources", ""];
	if (h === "codex") {
		put(
			join(env.CODEX_HOME, "config.toml"),
			`model = "gpt-5.4"\nmodel_provider = "capture"\n[model_providers.capture]\nname = "Capture"\nbase_url = "${url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
		);
		return ["--skip-git-repo-check", "--ephemeral"];
	}
	if (h === "opencode") {
		put(join(cwd, "opencode.json"), {
			model: "capture/capture",
			small_model: "capture/capture",
			provider: { capture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: url + "/v1", apiKey: "capture-fixture-key" }, models: { capture: { name: "Capture", limit: { context: 128000, output: 2048 } } } } },
		});
		return ["--model", "capture/capture"];
	}
	if (h === "antigravity") {
		// agy 只有在 settings.json 写 modelProvider=gemini 时才认真实 GEMINI_API_KEY；
		// 否则会走账号 OAuth（抓包环境没有凭据）。端点用 GOOGLE_GEMINI_BASE_URL 指向 loopback。
		put(join(env.USERPROFILE, ".gemini", "antigravity-cli", "settings.json"), { modelProvider: "gemini" });
		Object.assign(env, { GEMINI_API_KEY: "capture-fixture-key", GOOGLE_GEMINI_BASE_URL: url, AGY_CLI_DISABLE_AUTO_UPDATE: "1" });
		// 不给 --model：内建模型表是按区域拉取的，隔离 HOME 里拿不到；默认档位会自己挑一个已知模型
		return [];
	}
	if (h === "kilo") {
		put(join(cwd, "kilo.json"), {
			model: "capture/capture",
			provider: { capture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: url + "/v1", apiKey: "capture-fixture-key" }, models: { capture: { name: "Capture" } } } },
		});
		return ["--model", "capture/capture", "--format", "json"];
	}
	if (h === "dsh") {
		Object.assign(env, { DEEPSEEK_BASE_URL: url, DEEPSEEK_API_KEY: "capture-fixture-key", DSH_TELEMETRY_MODE: "DISABLED", DSH_TELEMETRY_OTLP_URL: url + "/telemetry" });
		return [];
	}
	if (h === "codebuddy") {
		Object.assign(env, {
			CODEBUDDY_BASE_URL: url,
			CODEBUDDY_API_KEY: "capture-fixture-key",
			CODEBUDDY_MODEL: "capture",
			CODEBUDDY_SMALL_FAST_MODEL: "capture",
			CODEBUDDY_BIG_SLOW_MODEL: "capture",
		});
		return ["--model", "capture", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--setting-sources", ""];
	}
	if (h === "grok") {
		Object.assign(env, { XAI_API_KEY: "capture-fixture-key", GROK_XAI_API_BASE_URL: url + "/v1", GROK_MODELS_BASE_URL: url + "/v1", GROK_DISABLE_AUTOUPDATER: "1" });
		put(
			join(env.GROK_HOME, "config.toml"),
			`[model.capture]\nmodel = "capture"\nbase_url = "${url}/v1"\nenv_key = "XAI_API_KEY"\napi_backend = "chat_completions"\n[models]\ndefault = "capture"\n`,
		);
		return ["--model", "capture", "--max-turns", "1", "--disable-web-search", "--no-subagents"];
	}
	if (h === "opencode2") {
		put(join(cwd, "opencode.json"), {
			model: "capture/capture",
			providers: { capture: { package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: url + "/v1", apiKey: "capture-fixture-key" }, models: { capture: { name: "Capture" } } } },
		});
		return ["--standalone", "--model", "capture/capture"];
	}
	// Qwen Code：官方 --openai-base-url / --auth-type openai，模型名随便给，只要 provider 认得。
	if (h === "qwen") {
		Object.assign(env, { OPENAI_API_KEY: "capture-fixture-key", OPENAI_BASE_URL: url + "/v1", OPENAI_MODEL: "capture" });
		return ["--auth-type", "openai", "--openai-api-key", "capture-fixture-key", "--openai-base-url", url + "/v1", "--model", "capture"];
	}
	// Kimi Code：config.toml 里手写一个 openai 型 provider，default_model 指向它。
	if (h === "kimi") {
		put(
			join(env.USERPROFILE, ".kimi-code", "config.toml"),
			`default_model = "capture/capture"\n\n[providers.capture]\nbase_url = "${url}/v1"\ntype = "openai"\napi_key = "capture-fixture-key"\n\n[models."capture/capture"]\nprovider = "capture"\nmodel = "capture"\nmax_context_size = 128000\nmax_output_size = 2048\ncapabilities = [ "tool_use" ]\ndisplay_name = "Capture"\n`,
		);
		return [];
	}
	// Qoder CLI：settings.json 的 providers 支持 openai-compatible；useExternal 跳过账号登录。
	// schema 三个坑：models[] 用 model 字段（不是 id）、默认模型在顶层 model.name、
	// 顶层多写一个未知键会让整份设置被拒（于是又退回「未登录」）。
	if (h === "qoder") {
		put(join(env.USERPROFILE, ".qoder", "settings.json"), {
			security: { auth: { useExternal: true } },
			model: { name: "capture/capture" },
			providers: {
				capture: {
					type: "openai-compatible",
					protocol: "openai",
					authType: "api-key",
					baseUrl: url + "/v1",
					apiKey: "capture-fixture-key",
					models: [{ model: "capture", displayName: "Capture" }],
				},
			},
		});
		return [];
	}
	// Continue CLI：CONTINUE_GLOBAL_DIR 决定配置目录，config.yaml 里给一个 openai 兼容模型。
	if (h === "continue") {
		env.CONTINUE_GLOBAL_DIR = join(env.USERPROFILE, ".continue");
		put(
			join(env.CONTINUE_GLOBAL_DIR, "config.yaml"),
			`name: capture\nversion: 1.0.0\nschema: v1\nmodels:\n  - name: capture\n    provider: openai\n    model: capture\n    apiBase: ${url}/v1\n    apiKey: capture-fixture-key\n    roles: [chat, edit, apply]\n`,
		);
		return [];
	}
	// Goose：GOOSE_PROVIDER=openai + OPENAI_HOST 指向 loopback；二进制在 WinGet 目录里，不在 PATH。
	if (h === "goose") {
		const dir = dirname(gooseBin());
		env.PATH = dir + (process.platform === "win32" ? ";" : ":") + env.PATH;
		Object.assign(env, {
			GOOSE_PROVIDER: "openai",
			GOOSE_MODEL: "capture",
			OPENAI_HOST: url,
			OPENAI_BASE_PATH: "v1/chat/completions",
			OPENAI_API_KEY: "capture-fixture-key",
			GOOSE_DISABLE_KEYRING: "1",
			GOOSE_MODE: "auto",
		});
		return [];
	}
	// Auggie：没有 base-url 参数，但登录态就是 {accessToken, tenantURL, scopes} 的 JSON，
	// AUGMENT_SESSION_AUTH 直接吃这份数据；tenantURL 指向 loopback 就不需要 OAuth。
	// scopes 必须是数组，空数组会被判成无效会话。
	if (h === "auggie") {
		Object.assign(env, {
			AUGMENT_SESSION_AUTH: JSON.stringify({ accessToken: "capture-fixture-token", tenantURL: url, scopes: ["read"] }),
			AUGMENT_DISABLE_AUTO_UPDATE: "1",
		});
		// tenantURL 已经指向 loopback，再叠一层 HTTP_PROXY 会让 undici 把请求当成「经代理访问真域名」，
		// 反而被 loopback 的 403 拦掉 —— 这家必须清掉代理变量。
		for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
		return [];
	}
// Crush：JSON 配置叫 crush.json（crushrc 是 shell 风格的另一种配置，写 JSON 进去会解析失败）。
	// 它按 $XDG_CONFIG_HOME/crush/crush.json 与 $XDG_DATA_HOME/crush/crush.json 找。
	if (h === "crush") {
		// Bubble Tea 在没有 TERM 时会去问终端尺寸，非 TTY 下就卡住；显式给 dumb + CI。
		// Crush 是 Go 写的，会读 HTTP_PROXY；base_url 已经指向 loopback，
		// 再叠代理就变成「经代理访问真域名」，被 loopback 的 403 挡掉（0 请求就是这么来的）。
		for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
		// Bubble Tea 在没有 TERM 时会去问终端尺寸，非 TTY 下就卡住；显式给 dumb + CI。
		Object.assign(env, { TERM: "dumb", CI: "1" });
		const config = {
			$schema: "https://charm.land/crush.json",
			providers: { capture: { type: "openai", name: "Capture", base_url: url + "/v1", api_key: "capture-fixture-key", models: [{ id: "capture", name: "capture" }] } },
			models: { large: { provider: "capture", model: "capture" }, small: { provider: "capture", model: "capture" } },
		};
		// Windows 上它实际读的是 %USERPROFILE%\.config\crush\crush.json（XDG 只是文档里的写法），
		// 四个候选目录都写一遍，省得再猜。
		for (const dir of [join(env.USERPROFILE, ".config"), env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.APPDATA]) {
			if (dir) put(join(dir, "crush", "crush.json"), config);
		}
		return [];
	}
	return null;
}


/** 一次抓包：装好种子人设 → 跑一条真请求 → 分析请求体里的 marker 落在哪一层。 */
// harness 名和可执行文件名不一致的家（antigravity 的 CLI 叫 agy）在这里映射
function resolveHarnessBin(h) {
	if (h === "antigravity") {
		const bin = antigravityBin();
		return bin && bin !== "agy" ? bin : resolveBin("agy");
	}
	if (h === "goose") return gooseBin();
	// harness 名与可执行文件名不一致的家
	if (h === "qoder") return resolveBin("qodercli");
	if (h === "continue") return resolveBin("cn");
	return resolveBin(h);
}

export async function captureMode(h, { out, mode = "replace", timeout = 45000 } = {}) {
	const bin = resolveHarnessBin(h);
	if (!bin) return { harness: h, mode, status: "missing", reason: "Executable not found" };
	const root = trackRoot(mkdtempSync(join(tmpdir(), `ap-capture-${h}-`)));
	const env = isolatedEnv(root);
	const cwd = join(root, "work");
	mkdirSync(cwd);
	env.AGENT_PURGE_REAL_BIN = bin;
	const version = await runProcess(bin, ["--version"], { env, cwd, timeout: 12000 });
	const base = { harness: h, mode, executable: bin, version: version.stdout.trim(),
		scope: { kind: "isolated-cli", profile: h === "dsh" ? "headless" : null, syntheticPersona: true, currentSession: false } };
	if (h === "hermes") return { ...base, status: "blocked", reason: (version.stderr || version.stdout).trim() || "No isolated provider adapter" };

	const provider = await startCaptureProvider(join(out ?? root, h, "requests"));
	let flags;
	try {
		flags = configure(h, env, provider.url, cwd);
		if (flags) await prepareCapture(h, bin, env, cwd, out, timeout, mode);
	} catch (e) {
		await provider.close();
		return { ...base, status: "error", reason: e.message };
	}
	if (!flags) {
		await provider.close();
		return { ...base, status: "blocked", reason: "Provider/isolation adapter not yet verified for this executable" };
	}
	try {
		const marker = `AP_CAPTURE_${h}_${mode}_${randomUUID()}`;
		const body = `Capture-only neutral persona. Marker: ${marker}. Reply briefly.`;
		seed(env, h, mode, body);
		const start = provider.captures.length;
		const command = agentCommand([h, "--ask", "Reply CAPTURE_OK.", "--", ...flags]);
		// crush 在非 TTY 下会一直等 stdin；给它一个空输入等于立刻 EOF。
		const result = await runProcess(command.cmd, command.args, { env, cwd, timeout, input: h === "crush" ? "" : undefined });
		const processFile = join(out ?? root, h, mode + ".process.json");
		put(processFile, result);
		const analyses = provider.captures.slice(start).map((r) => ({ id: r.id, protocol: r.protocol, kind: requestKind(r.body), ...inspectRequest(r.body, marker) }));
		// 未知/辅助请求仍是证据，但不能替代主回合。
		const checks = analyses.filter((a) => a.kind === "main");
		const hit = checks.find((a) => a.markerCount > 0);
		return {
			...base,
			...captureOutcome(result, checks, mode),
			processFile,
			exitCode: result.code,
			timedOut: result.timedOut,
			marker,
			// 注入层：inspectRequest 的 text/markerCount 只算特权角色（system/developer），
			// 用户消息里的命中由 userMarkerCount 单独给，两个合起来才是「注到哪层」。
			injected: { sys: Boolean(hit), user: checks.some(request => request.userMarkerCount > 0) },
			chars: hit?.chars ?? 0,
			head: (hit?.text ?? "").slice(0, 200),
			requests: analyses.map(({ text: _text, ...a }) => a),
		};
	} finally {
		await provider.close();
	}
}

/** verify：只抓「当前模式」一次，写 web 读的那份 verification/latest.json。
 * 不写原始提示词文本（那是本地抓包目录的事）：摘要只有角色、字数、marker 命中数。 */
export async function verifyHarnesses(harnesses, { root, timeout, mode = "replace" } = {}) {
	const at = new Date().toISOString();
	const out = join(root, "verification", at.replace(/[:.]/g, "-"));
	const report = {
		schema: 1,
		at,
		kind: "loopback-real-binary",
		out,
		limitations: ["只证明请求体里有人设：不代表模型行为质量", "loopback 假 provider 不是 OS 级网络沙箱"],
		harnesses: [],
	};
	for (const h of harnesses) {
		let r;
		try {
			r = await captureMode(h, { out, mode, timeout });
		} catch (e) {
			r = { harness: h, status: "error", reason: e.message };
		}
		report.harnesses.push({
			harness: h,
			executable: r.executable ?? null,
			version: r.version ?? "",
			scope: r.scope ?? null,
			processFile: r.processFile ?? null,
			status: r.status,
			reason: r.reason ?? null,
			modes: r.requests
				? [{ mode: r.mode, status: r.status, exitCode: r.exitCode, timedOut: r.timedOut, marker: r.marker, injected: r.injected, chars: r.chars, requests: r.requests }]
				: [],
			hotSwitch: { status: "not-tested" },
		});
	}
	writeVerification(join(root, "verification", "latest.json"), report);
	return report;
}

export async function captureHarness(h, out) {
	const bin = resolveHarnessBin(h);
	if (!bin) return { harness: h, status: "unavailable", reason: "Executable not found" };
	const root = trackRoot(mkdtempSync(join(tmpdir(), `ap-capture-${h}-`)));
	const env = isolatedEnv(root);
	const cwd = join(root, "work");
	mkdirSync(cwd);
	env.AGENT_PURGE_REAL_BIN = bin;
	const version = await runProcess(bin, ["--version"], { env, cwd, timeout: 12000 });
	put(join(out, h, "version.json"), version);
	const report = { harness: h, executable: bin, version: version.stdout.trim(), isolation: root,
		scope: { kind: "isolated-cli", profile: h === "dsh" ? "headless" : null, syntheticPersona: true, currentSession: false },
		modes: [], hotSwitch: { status: "not-tested", reason: "Startup capture does not prove same-session switching" } };
	if (h === "hermes") {
		report.status = "blocked";
		report.reason = (version.stderr || version.stdout).trim() || "No isolated provider adapter";
		return report;
	}
	const provider = await startCaptureProvider(join(out, h, "requests"));
	const flags = configure(h, env, provider.url, cwd);
	if (!flags) {
		await provider.close();
		return { ...report, status: "blocked", reason: "Provider/isolation adapter not yet verified for this executable" };
	}
	try {
		await prepareCapture(h, bin, env, cwd, out, 35000, "off");
		for (const mode of ["off", "strict", "replace", "append"]) {
			const marker = `AP_CAPTURE_${h}_${mode}_${randomUUID()}`;
			const body = `Capture-only neutral persona. Marker: ${marker}. Reply briefly.`;
			seed(env, h, mode, body);
			const start = provider.captures.length;
			const command = agentCommand([h, "--ask", "Reply CAPTURE_OK.", "--", ...flags]);
			const result = await runProcess(command.cmd, command.args, { env, cwd });
			put(join(out, h, mode + ".process.json"), result);
			const requests = provider.captures.slice(start);
			const analyses = requests.map((r) => ({ id: r.id, protocol: r.protocol, kind: requestKind(r.body), ...inspectRequest(r.body, marker) }));
			const checks = analyses.filter((a) => a.kind === "main");
			report.modes.push({ mode, ...captureOutcome(result, checks, mode), exitCode: result.code, timedOut: result.timedOut, marker, requests: analyses.map(({ text: _text, ...a }) => a) });
			console.log(`${h} ${mode}: ${report.modes.at(-1).status} (${checks.length} request, exit ${result.code})`);
		}
		report.status = report.modes.every((r) => r.status === "captured") ? "captured" : "partial";
		return report;
	} finally {
		await provider.close();
	}
}
