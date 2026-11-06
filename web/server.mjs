// 零依赖 Web 服务：配置台。选默认 harness/mode、管理 persona、常驻安装、探测。
// 刻意不做"运行"：交互式 harness 属于终端/桌面，Web 只负责选（见 ARCHITECTURE.md）。
import { createServer } from "node:http";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detect } from "../lib/detect.mjs";
import { oneshots } from "../backends/index.mjs";
import { createStore, isValidId } from "../lib/personas.mjs";
import { MODES, ARMS, armedOf, dshProfilesOf, loadState, resolveFor, resolveActivation, setPiAuto, setOmpAuto, setDshProfile } from "../lib/state.mjs";
import { withControlLock } from "../lib/control.mjs";
import { status as persistStatus } from "../lib/persist.mjs";
import { projectStatus, projectDirectories } from "../lib/project.mjs";
import { plans } from "../lib/armor.mjs";
import { shimStatus } from "../lib/shim.mjs";
import { slashStatus } from "../lib/slashes.mjs";
import { reconcileArmed } from "../lib/armed.mjs";
import { capsFor } from "../lib/caps.mjs";
import { dataHome, ensureDataHome } from "../lib/home.mjs";
import { DSH_PROFILES } from "../lib/dsh.mjs";
import { applyConfiguration, changeChannel, configureHarness, disableHarness } from "../lib/apply.mjs";
import { ROOT, isCompiled, readResource } from "../lib/root.mjs";
import { currentVersion } from "../lib/update.mjs";
import { verificationEvidence } from "../lib/evidence.mjs";

// 数据（state.json + personas/）在用户目录，不在安装目录
const DATA = dataHome();
// 运行期真正被改写的层（≠ bench 能测到的层）：每家只有它自己暴露的那一个写入点。
// sys = 系统提示/配置文件/插件 splice；user = 只落在用户消息里（zcode 的 hook）。
const LAYER = {
	pi: "sys", codex: "sys", codebuddy: "sys", claude: "sys", grok: "sys",
	omp: "sys", opencode: "sys", hermes: "sys", antigravity: "sys", workbuddy: "sys", "workbuddy-ai": "sys", kilo: "sys",
	"pi-desktop": "sys",
	// zcode 的内核 bundle 已核对：读取 ~/.zcode/AGENTS.md，且支持 customSystemPrompt
	zcode: "sys",
};
const matrix = (() => {
	try {
		return JSON.parse(readResource("matrix.json").toString("utf8"));
	} catch (error) {
		throw new Error(`无法加载执行器矩阵 matrix.json：${error.message}`, { cause: error });
	}
})();
let store = null;
// 同一次实测会拉起真 harness 子进程：同一家同时只能跑一份。
const verifying = new Set();

export function serveWeb(port = 7788, opts = {}) {
	const { autoExit = false, heartbeatTimeout = 8000, initialConnectTimeout = 30000, onExit = null, onError = null } = opts;
	ensureDataHome(isCompiled() ? null : ROOT);
	store ??= createStore(DATA);

	const heartbeatState = {
		lastHeartbeat: Date.now(),
		hasConnected: false,
	};

	// gen：每次发出页面 HTML 都 +1。页面卸载时带着自己那份 gen 上报，
	// 过期的（上一个页面）一律忽略——否则旧页面的 beacon 晚到，会把刚刷出来的新页面一起带走。
	const ctx = { heartbeatState, autoExit, gen: 0, leaveTimer: null };

	let autoExitTimer = null;
	const shutdown = (code = 0) => {
		clearLeave(ctx);
		if (autoExitTimer) { clearInterval(autoExitTimer); autoExitTimer = null; }
		const doExit = () => {
			if (typeof onExit === "function") onExit(code);
			else process.exit(code);
		};
		if (server.listening) {
			server.close(() => doExit());
			setTimeout(doExit, 1000).unref();
		} else {
			doExit();
		}
	};

	if (autoExit) {
		const startTime = Date.now();
		autoExitTimer = setInterval(() => {
			const now = Date.now();
			if (!heartbeatState.hasConnected) {
				if (now - startTime > initialConnectTimeout) {
					shutdown(0);
				}
			} else if (now - heartbeatState.lastHeartbeat > heartbeatTimeout) {
				shutdown(0);
			}
		}, 2000);
		autoExitTimer.unref();
	}

	ctx.shutdown = shutdown;

	// handle 是 async：任何异常都在这里收口，否则请求会挂着不响应
	const server = createServer((req, res) => {
		handle(req, res, ctx).catch((e) => {
			try {
				send(res, e.statusCode ?? (/另一个配置操作|锁/.test(e.message) ? 409 : 500), { error: e.message });
			} catch {}
		});
	});
	server.on("error", async (e) => {
		if (typeof onError === "function") {
			try { await onError(e); return; } catch {}
		}
		// 端口被旧实例占着的时候，--detach 是静默的 → 这里必须说人话，否则用户看到的是旧 UI
		if (e.code === "EADDRINUSE") {
			console.error(`${port} 已被占用：老实例还在跑（可能是改动前的版本，UI 会是旧的）。`);
			console.error(`清掉再启：Get-NetTCPConnection -LocalPort ${port} -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`);
		} else {
			console.error(`web 启动失败：${e.message}`);
		}
		process.exit(1);
	});
	server.listen(port, "127.0.0.1", () => {
		console.log(`agent-purge web → http://127.0.0.1:${server.address().port}`);
	});
	return server;
}

async function handle(req, res, ctx = {}) {
	if (!localHost(req)) return send(res, 403, { error: "只接受本机 Host" });
	const url = new URL(req.url, "http://127.0.0.1");
	const p = url.pathname;

	// 有请求就说明还有页面活着（刷新、重开、资源加载都算）：撤掉上一个页面留下的退出倒计时。
	// 关键：刷新时 pagehide 先发、新页面请求随后到，这里负责把"刷新"和"关窗口"分开。
	clearLeave(ctx);

	// 防 CSRF：本机 Web 页面能 POST 就能写配置/改人设；跨站页面用 text/plain 也能发“简单请求”。
	// 只放同源：Origin 的 host 必须和本次请求的 Host 完全一致（端口不同也挡住）。
	if (isMutating(req.method) && !sameOrigin(req)) return send(res, 403, { error: "只接受本机同源请求" });

	if (req.method === "GET" && (p === "/" || p === "/index.html")) return html(res, ctx);
	const assets = { '/app.js': 'text/javascript', '/model.mjs': 'text/javascript', '/evidence.mjs': 'text/javascript', '/styles.css': 'text/css' };
	if (req.method === "GET" && Object.hasOwn(assets, p)) {
		res.writeHead(200, { 'content-type': `${assets[p]}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
		return res.end(readResource(p === '/evidence.mjs' ? 'lib/evidence.mjs' : `web/${p.slice(1)}`));
	}
	// web/assets/ 下的真实品牌图标（png/jpg/webp/ico），固定白名单后缀 + 只认单层文件名，不走路径拼接。
	if (req.method === "GET" && p.startsWith("/assets/")) {
		const name = p.slice("/assets/".length);
		const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
		const ext = name.slice(name.lastIndexOf('.'));
		if (!name.includes('/') && !name.includes('..') && Object.hasOwn(mime, ext)) {
			try {
				// 图标会被换（官方图源改了/我改错了），一律 no-store：本地工具不值得为 24h 缓存换来“改了看不到”。
				res.writeHead(200, { 'content-type': mime[ext], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
				return res.end(readResource(`web/assets/${name}`));
			} catch { /* 落到 404 */ }
		}
		return send(res, 404, { error: "not found" });
	}
	if (req.method === "GET" && p === "/api/verification") {
		const file = join(DATA, 'verification', 'latest.json');
		try {
			if (!existsSync(file)) return send(res, 200, { report: null });
			const report = JSON.parse(readFileSync(file, 'utf8'));
			if (!report || !Array.isArray(report.results)) throw new Error('缺少 results 数组');
			return send(res, 200, { report });
		} catch (error) {
			return send(res, 500, { error: `验证报告读取失败：${error.message}` });
		}
	}
	if (req.method === "POST" && p === "/api/heartbeat") {
		if (ctx.heartbeatState) {
			ctx.heartbeatState.lastHeartbeat = Date.now();
			ctx.heartbeatState.hasConnected = true;
		}
		return send(res, 200, { ok: true, now: Date.now(), autoExit: Boolean(ctx.autoExit) });
	}
	if (req.method === "POST" && p === "/api/exit") {
		send(res, 200, { ok: true, message: "服务正在退出" });
		if (typeof ctx.shutdown === "function") {
			setTimeout(() => ctx.shutdown(0), 100);
		} else {
			setTimeout(() => process.exit(0), 100);
		}
		return;
	}
	if (req.method === "POST" && p === "/api/leave") {
		// 页面卸载（刷新/关标签/关窗口）时发的信号。刷新和关窗口在浏览器里长得一样，
		// 所以这里不立刻退：先等宽限期，新页面只要发出任何请求就会撤销（见 clearLeave）。
		// 源码态 `agent-purge web` 归终端管，页面来去与它无关——永不自杀。
		req.resume();
		const gen = url.searchParams.get("gen");
		const live = Boolean(ctx.autoExit) && gen !== null && gen === String(ctx.gen);
		if (live) {
			ctx.leaveTimer = setTimeout(() => { ctx.leaveTimer = null; ctx.shutdown(0); }, LEAVE_GRACE);
			ctx.leaveTimer.unref?.();
		}
		return send(res, 200, { ok: true, exit: live });
	}
	if (req.method === "GET" && p === "/api/state") return send(res, 200, await state(url.searchParams.get("versions") === "1"));
	if (req.method === "GET" && p === "/api/armor") return send(res, 200, armorState());
	if (req.method === "POST" && p === "/api/apply") return send(res, 200, applyChanges(await body(req)));
	if (req.method === "POST" && p === "/api/power") return send(res, 200, applyConfiguration(DATA, { enabled: booleanField(await body(req), "on") }));
	if (req.method === "POST" && p === "/api/sync") { const payload = await body(req); return send(res, 200, applyConfiguration(DATA, { onlyFailed: booleanField(payload, "onlyFailed", false) })); }
	if (req.method === "POST" && p === "/api/defaults") return send(res, 200, saveDefaults(await body(req)));
	if (req.method === "POST" && p === "/api/pi-auto") return send(res, 200, { piAuto: setPiAuto(DATA, booleanField(await body(req), "on")) });
	if (req.method === "POST" && p === "/api/omp-auto") return send(res, 200, { ompAuto: setOmpAuto(DATA, booleanField(await body(req), "on")) });
	if (req.method === "POST" && p === "/api/dsh-profile") return send(res, 200, saveDshProfile(await body(req)));
	if (req.method === "POST" && p === "/api/persona") return send(res, 200, savePersona(await body(req)));
	if (req.method === "POST" && p === "/api/persona/import") return send(res, 200, await handleImportPersonas(await body(req)));
	if (req.method === "DELETE" && p === "/api/persona") return send(res, 200, deletePersona(url.searchParams.get("id")));
	if (req.method === "POST" && p === "/api/harness") return send(res, 200, saveHarnessConfig(await body(req)));
	if (req.method === "POST" && p === "/api/use") return send(res, 200, usePersona(await body(req)));
	if (req.method === "POST" && p === "/api/install") return send(res, 200, applyInstall(await body(req)));
	if (req.method === "POST" && p === "/api/arm") return send(res, 200, applyArm(await body(req)));
	if (req.method === "POST" && p === "/api/arm-all") return send(res, 200, applyArmAll(await body(req)));
	if (req.method === "POST" && p === "/api/clean") {
		await body(req);
		const { clean } = await import("../lib/clean.mjs");
		const resClean = clean(DATA, { all: false, dryRun: false });
		return send(res, 200, resClean);
	}
	if (req.method === "GET" && p === "/api/update") {
		const { checkForUpdate, checkNpmVersion, canReplaceSelf, detectInstallType, compareSemver } = await import("../lib/update.mjs");
		const force = url.searchParams.get("force") === "1";
		const cacheFile = join(DATA, "update-cache.json");
		const isExe = canReplaceSelf();
		const installType = detectInstallType();

		const [ghRes, npmRes] = await Promise.allSettled([
			checkForUpdate({ force, cacheFile }),
			checkNpmVersion({ timeout: 3500 })
		]);
		const gh = ghRes.status === "fulfilled" ? ghRes.value : { ok: false, error: ghRes.reason?.message };
		const npm = npmRes.status === "fulfilled" ? npmRes.value : { ok: false, error: npmRes.reason?.message };

		const current = gh.current || npm.current || "0.0.0";
		let latest = gh.ok && gh.latest ? gh.latest : current;
		if (npm.ok && npm.latest && compareSemver(latest, npm.latest) > 0) {
			latest = npm.latest;
		}
		const hasUpdate = compareSemver(current, latest) > 0;

		return send(res, 200, {
			ok: gh.ok || npm.ok,
			current,
			latest,
			hasUpdate,
			installType,
			isExe,
			execPath: process.execPath,
			npm: {
				ok: npm.ok,
				latest: npm.latest,
				hasUpdate: npm.hasUpdate,
				error: npm.error,
				command: "npm install -g agent-purge@latest"
			},
			github: {
				ok: gh.ok,
				latest: gh.latest,
				hasUpdate: gh.hasUpdate,
				body: gh.body || "",
				htmlUrl: gh.htmlUrl,
				assets: gh.assets || [],
				error: gh.error
			},
			body: gh.body || (hasUpdate ? `发现新版本 v${latest}` : ""),
			htmlUrl: gh.htmlUrl || "https://github.com/ZiChuanLan/agent-purge/releases/latest"
		});
	}
	if (req.method === "POST" && p === "/api/update-upgrade") {
		const reqPayload = await body(req);
		const { checkForUpdate, downloadFile, replaceSelfExecutable, canReplaceSelf } = await import("../lib/update.mjs");
		const isExe = canReplaceSelf();
		const upgradeType = reqPayload?.type || (isExe ? "exe" : "npm");

		if (upgradeType === "npm") {
			const { execFile } = await import("node:child_process");
			const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
			const args = ["install", "-g", "agent-purge@latest"];
			return new Promise((resolve) => {
				execFile(npmCmd, args, { timeout: 120000, windowsHide: true }, (error, stdout, stderr) => {
					if (error) {
						resolve(send(res, 500, {
							ok: false,
							type: "npm",
							error: `npm 执行出错：${error.message}`,
							output: (stderr || stdout || "").trim(),
							command: "npm install -g agent-purge@latest"
						}));
					} else {
						resolve(send(res, 200, {
							ok: true,
							type: "npm",
							message: "npm 全局安装已更新到最新版！请重启 agent-purge 服务以生效。",
							output: (stdout || "").trim(),
							command: "npm install -g agent-purge@latest"
						}));
					}
				});
			});
		}

		const info = await checkForUpdate({ force: true });
		if (!info.ok || !info.hasUpdate) {
			return send(res, 400, { error: info.error || "GitHub Release 暂无可用新版本" });
		}
		const targetExe = info.assets?.find((a) => a.name.toLowerCase() === "agent-purge.exe");
		const targetSetup = info.assets?.find((a) => a.name.toLowerCase().endsWith("-setup.exe"));

		const { tmpdir } = await import("node:os");
		if (isExe && targetExe) {
			const tempFile = join(tmpdir(), `agent-purge-download-${randomUUID()}.exe`);
			try {
				await downloadFile(targetExe.downloadUrl, tempFile, undefined, { expectedSize: targetExe.size, digest: targetExe.digest });
				replaceSelfExecutable(tempFile);
			} finally { rmSync(tempFile, { force: true }); }
			return send(res, 200, { ok: true, type: "exe", version: info.latest, message: "便携版 exe 已就地升级成功！下次启动即为新版本。" });
		} else if (process.platform === "win32" && targetSetup) {
			const tempSetup = join(tmpdir(), `agent-purge-setup-${randomUUID()}.exe`);
			await downloadFile(targetSetup.downloadUrl, tempSetup, undefined, { expectedSize: targetSetup.size, digest: targetSetup.digest });
			const { spawn } = await import("node:child_process");
			spawn(tempSetup, [], { detached: true, stdio: "ignore" }).unref();
			return send(res, 200, { ok: true, type: "setup", version: info.latest, message: "安装程序已启动，请按界面向导完成安装。" });
		}
		return send(res, 400, { error: "未在 Release 中找到适配 Windows 的升级安装文件，请前往页面手动下载。" });
	}
	if (req.method === "POST" && p === "/api/verify") {
		const { harness } = await body(req);
		if (!Object.hasOwn(matrix.harnesses ?? {}, harness)) return send(res, 400, { error: `未知 harness：${harness}` });
		if (verifying.has(harness)) return send(res, 409, { error: `${harness} 正在实测，等它跑完` });
		verifying.add(harness);
		const cap = await import("../lib/capture.mjs");
		try {
			const mode = resolveActivation(loadState(DATA).state, harness, { launch: true }).mode;
			const report = await cap.verifyHarnesses([harness], { root: DATA, mode, timeout: 60000 });
			const r = report.harnesses[0] ?? {};
			const roles = [...new Set((r.modes ?? []).flatMap(m => (m.requests ?? []).filter(q => q.kind === "main").flatMap(q => q.roles ?? [])))];
			return send(res, 200, { harness, status: r.status, reason: r.reason ?? null, version: r.version ?? "",
				scope: r.scope, assessment: verificationEvidence(r), roles, processFile: r.processFile,
				injected: r.modes?.[0]?.injected ?? null, chars: r.modes?.[0]?.chars ?? 0 });
		} catch (error) {
			return send(res, 500, { error: `实测失败：${error.message}` });
		} finally {
			verifying.delete(harness);
			cap.cleanupRoots();
		}
	}
	send(res, 404, { error: "not found" });
}

function armorState() {
	const rows = plans(matrix).map((x) => ({
		id: x.id,
		class: x.class,
		bare: x.bare,
		persona: x.persona,
		recommended: x.recommended,
		blocked: x.blocked,
		warnings: x.warnings,
		requiresSeed: x.requiresSeed,
		mode: x.mode ?? null,
		defaultLayers: x.defaultLayers ?? [],
		cmd: x.cmd,
	}));
	return {
		target: matrix.armorTarget ?? null,
		measuredAt: matrix.armorMeasuredAt ?? null,
		judge: matrix.armorJudge ?? null,
		rows,
	};
}

async function state(withVersions) {
	// 先跟磁盘对账，再报数：armed 是缓存，磁盘才是真相
	const reconciled = await reconcileArmed(DATA);
	const found = detect({ versions: withVersions });
	const persisted = persistStatus(DATA);
	const { state: st } = loadState(DATA);
	const shims = shimStatus();
	const slashes = slashStatus(DATA);
	const projects = new Map(projectStatus(process.cwd(), DATA).map(r => [r.id, r]));
	const harnesses = Object.entries(matrix.harnesses).map(([id, m]) => {
		const d = found[id] ?? {};
		const inst = persisted.find((x) => x.name === id);
		const armed = armedOf(st, id);
		const eff = resolveFor(st, id);
		const caps = capsFor(id, { bin: d.bin ?? null });
		const activation = resolveActivation(st, id, { channel: armed.includes("install") ? "install" : "slash" });
		let override = "no";
		if (m.override === true) override = "yes";
		else if (m.override) override = String(m.override);
		return {
			id,
			class: m.class,
			override,
			inject: Boolean(m.inject),
			hotSwitch: Boolean(m.hotSwitch),
			chars: m.defaultSystemChars == null ? null : `${m.defaultSystemChars} → ${m.purgedSystemChars ?? "?"}`,
			version: d.version ?? m.measuredVersion ?? null,
			residue: m.residue ?? null,
			reason: m.reason ?? null,
			supported: m.class !== "unsupported",
			oneshot: Boolean(oneshots[id]),
			layer: LAYER[id] ?? (m.class === "unsupported" ? null : "sys"),
			found: Boolean(d.found),
			bin: d.bin ?? null,
			home: d.home ?? null,
			install: d.install ?? null,
			installSource: d.installSource ?? null,
			homeExists: Boolean(d.homeExists),
			persistable: Boolean(inst),
			installed: Boolean(inst?.installed),
			persistFile: inst?.file ?? null,
			armed,
			// 这家实际生效的人设/模式 + 来源（override 还是跟随全局）
			persona: eff.persona,
			mode: eff.mode,
			personaFrom: eff.personaFrom,
			modeFrom: eff.modeFrom,
			// 「本项目」按当前目录的选择显示；暂停撤块后仍可取消选择
			projectOn: Boolean(projects.get(id)?.selected || projects.get(id)?.on),
			projectFile: caps.project?.file ?? null,
			projectPath: projects.get(id)?.file ?? null,
			projectDirs: projectDirectories(DATA, id),
			activation,
			auto: id === "pi" ? st.piAuto === true : id === "omp" ? st.ompAuto === true : null,
			profiles: id === "dsh" ? dshProfilesOf(st) ?? DSH_PROFILES : undefined,
			shim: Boolean(shims.find((s) => s.id === id)?.installed),
			slash: slashes.find((s) => s.id === id) ?? null,
			// 每条通道「能不能用 + 为什么不能用」由 lib/caps.mjs 统一裁决：
			// UI 只负责画，不再自己猜（以前 shim 硬编码可点，zcode 点了必然无效）
			caps,
		};
	});
	const defaults = defaultsOf(st, harnesses);
	return {
		version: currentVersion(),
		harnesses,
		reconciled,
		personas: store.list().map((x) => ({ id: x.id, meta: x.meta, body: x.body, chars: x.body.trim().length })),
		active: store.activeId(),
		persona: st.persona,
		overrides: st.overrides ?? {},
		defaults,
		// false = state.json 里还没有默认（defaults 只是 UI 的建议值，裸敲 agent-purge 仍会提示“未设置”）
		defaultsSet: Boolean(st.default?.harness),
		armed: st.armed ?? {},
		paused: st.default?.mode === "off",
		prevMode: st.prevMode ?? 'replace',
		pausedInstalls: st.pausedInstalls ?? [],
		lastApply: st.lastApply ?? null,
		// dsh 的三个 profile（desktop/web/headless）；null 就是全开
		dshProfiles: dshProfilesOf(st) ?? DSH_PROFILES,
		dshAll: DSH_PROFILES,
		// /purge off|mode 写进来的 profile 级运行时状态（暂停/覆盖模式），UI 要能看到，否则
		// 「装了常驻却没生效」无从解释
		dshRuntime: st.dshRuntime ?? {},
		modes: MODES,
		piAuto: st.piAuto === true,
		ompAuto: st.ompAuto === true,
		shimDir: shims[0]?.dir ?? null,
		slashes: slashes,
	};
}

/**
 * state.json 里 default 为 null（全新安装、从没设过）时，给 UI 一个能画出来的值：
 * 第一个“装了 + 被支持 + 可注入”的 harness + replace。
 * 只用于展示，不落盘——裸敲 agent-purge 该提示“还没设置”照样提示（UI 看 defaultsSet）。
 */
function defaultsOf(st, harnesses) {
	const cur = st.default?.harness;
	const mode = MODES.includes(st.default?.mode) ? st.default.mode : "replace";
	if (cur && harnesses.some((h) => h.id === cur)) return { harness: cur, mode };
	const pick =
		harnesses.find((h) => h.found && h.supported && h.inject) ??
		harnesses.find((h) => h.supported) ??
		harnesses[0];
	return { harness: pick?.id ?? null, mode };
}

function applyChanges(payload) {
	for (const key of Object.keys(payload)) if (!["harness", "persona", "mode", "resumeMode", "enabled"].includes(key)) throw httpError(400, `未知配置字段: ${key}`);
	if (payload.harness !== undefined && payload.harness !== null) {
		knownHarness(payload.harness);
		if (matrix.harnesses[payload.harness].class === "unsupported") throw httpError(400, "默认执行器未开放启动入口");
	}
	if (payload.persona !== undefined && (typeof payload.persona !== "string" || !store.read(payload.persona))) throw httpError(400, "人设不存在或标识无效");
	if (payload.mode !== undefined && !MODES.includes(payload.mode)) throw httpError(400, "模式无效");
	if (payload.resumeMode !== undefined && !["strict", "replace", "append"].includes(payload.resumeMode)) throw httpError(400, "恢复模式无效");
	if (payload.enabled !== undefined) booleanField(payload, "enabled");
	return applyConfiguration(DATA, payload);
}
function saveDefaults(payload) {
	const report = applyChanges(payload);
	return { ...report, defaults: loadState(DATA).state.default };
}

function saveDshProfile(payload) {
	const profile = payload.profile;
	if (!DSH_PROFILES.includes(profile)) throw httpError(400, `未知 profile: ${profile}`);
	return { ok: true, dshProfiles: setDshProfile(DATA, profile, booleanField(payload, "on"), DSH_PROFILES) };
}

function savePersona(payload) {
	const id = payload.id;
	if (typeof id !== "string" || !isValidId(id) || id !== id.trim()) throw httpError(400, "人设标识无效");
	if (typeof payload.body !== "string" || !payload.body.trim()) throw httpError(400, "正文应为非空文本");
	if (payload.meta !== undefined && !plainObject(payload.meta)) throw httpError(400, "meta 应为对象");
	if (payload.apply !== undefined) booleanField(payload, "apply");
	return withControlLock(DATA, () => {
		// 只覆盖表单带上来的键，其余 frontmatter（harness / order / description...）原样保留：
		// 旧实现直接拿表单三个字段重写文件，点一次保存就把手写的键全吃掉
		const meta = { ...(store.read(id)?.meta ?? {}) };
		const given = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
		for (const [k, v] of Object.entries(given)) {
			if (k === "id" || v === undefined) continue;
			if (k === "desc" || k === "description") continue;
			if (k === "model") continue;
			meta[k] = typeof v === "string" ? v.trim() : v;
		}
		// 说明：README/模板的键是 description；旧 UI 发的是 desc，两边都认，写回只留 description
		const desc = given.description ?? given.desc;
		if (desc !== undefined) {
			meta.description = String(desc ?? "").trim();
			delete meta.desc;
			if (!meta.description) delete meta.description;
		}
		// 建议模型：多值用逗号分隔（UI 是单行 input），空 = 不限制（读时 asArray 兜底 ["*"]）
		if (given.model !== undefined) {
			const list = (Array.isArray(given.model) ? given.model : String(given.model ?? "").split(","))
				.map((s) => String(s).trim())
				.filter(Boolean);
			if (list.length) meta.model = list;
			else delete meta.model;
		}
		const current = store.activeId() === id;
		const referenced = Object.values(loadState(DATA).state.overrides ?? {}).some(value => value?.persona === id);
		const saved = store.save(id, { meta: { ...meta, id }, body: payload.body });
		const applied = current || payload.apply === true ? applyConfiguration(DATA, { persona: id }) : referenced ? applyConfiguration(DATA) : null;
		return { ok: applied?.ok ?? true, applied, persona: { id: saved.id, meta: saved.meta, body: saved.body } };
	});
}

function deletePersona(id) {
	return withControlLock(DATA, () => {
		if (typeof id !== "string" || !isValidId(id)) throw httpError(400, "人设标识无效");
		if (!store.read(id)) throw httpError(400, "找不到这个人设");
		if (store.list().length <= 1) throw httpError(409, "至少保留一个人设");
		const references = Object.entries(loadState(DATA).state.overrides ?? {}).filter(([, value]) => value?.persona === id).map(([harness]) => harness);
		if (references.length) throw httpError(409, `人设仍被引用：${references.join("、")}，请先调整分家选择`);
		const current = store.activeId() === id;
		if (!store.remove(id)) throw httpError(400, "人设标识无效");
		const applied = current ? applyConfiguration(DATA, { persona: store.activeId() }) : null;
		return { ok: applied?.ok ?? true, active: store.activeId(), applied };
	});
}

function usePersona(payload) {
	return { ...applyChanges({ persona: payload.id ?? "" }), active: store.activeId() };
}

async function handleImportPersonas(payload) {
	const source = String(payload?.source || "").trim();
	if (!source) throw httpError(400, "导入源不能为空（请提供 GitHub 仓库如 ZiChuanLan/some-magic 或本地目录）");
	const overwrite = payload?.overwrite !== false;
	const { importPersonas } = await import("../lib/persona-import.mjs");
	try {
		const result = await importPersonas(source, DATA, { overwrite });
		let applied = null;
		if (payload?.activateId && store.read(payload.activateId)) {
			applied = applyConfiguration(DATA, { persona: payload.activateId });
		}
		return {
			ok: true,
			result,
			personas: store.list().map((x) => ({ id: x.id, meta: x.meta, body: x.body, chars: x.body.trim().length })),
			persona: store.activeId(),
			applied,
		};
	} catch (e) {
		throw httpError(400, `拉取人设失败: ${e.message}`);
	}
}

// 按执行器覆盖人设/模式：值传 null / "" / "follow" = 恢复跟随全局。
function saveHarnessConfig(payload) {
	const id = knownHarness(payload.harness);
	const patch = {};
	for (const key of Object.keys(payload)) if (!["harness", "persona", "mode"].includes(key)) throw httpError(400, `未知分家字段: ${key}`);
	for (const key of ["persona", "mode"]) {
		if (!Object.hasOwn(payload, key)) continue;
		const value = payload[key];
		if (value !== null && typeof value !== "string") throw httpError(400, `${key} 应为文本或 null`);
		patch[key] = value === null || value === "" || value === "follow" ? null : value;
	}
	if (!Object.keys(patch).length) throw httpError(400, "缺少分家配置字段");
	if (patch.persona && !store.read(patch.persona)) throw httpError(400, "人设不存在");
	if (patch.mode && !MODES.includes(patch.mode)) throw httpError(400, "模式无效");
	const applied = configureHarness(DATA, id, patch);
	return { ok: applied.ok, applied, overrides: loadState(DATA).state.overrides ?? {}, effective: applied.effective };
}

// 兼容旧客户端的全局开关：只暂停/恢复原范围，不再一键全量注册。
function applyArmAll(payload) {
	return applyConfiguration(DATA, { enabled: verbOf(payload.action) === "on" });
}
function applyInstall(payload) {
	return changeChannel(DATA, { harness: knownHarness(payload.harness), channel: "install", enabled: verbOf(payload.action) === "on" });
}
const VERB_OFF = new Set(["off", "uninstall", "remove", "stop", "false", false, 0]);
const VERB_ON = new Set(["on", "install", "add", "start", "true", true, 1]);
function verbOf(action) {
	if (VERB_OFF.has(action)) return "off";
	if (VERB_ON.has(action)) return "on";
	throw httpError(400, "action 应明确指定 on 或 off");
}
function applyArm(payload) {
	knownHarness(payload.harness);
	if (payload.channel !== undefined && ![...ARMS, "auto", "all"].includes(payload.channel)) throw httpError(400, "通道无效");
	const on = verbOf(payload.action) === "on";
	return withControlLock(DATA, () => {
	// auto：开关式语义。开 = 挑这个执行器最省心的可用通道；关 = 只撤它真正装着的那几条。
	if (payload.channel === "auto") {
		const { state: st } = loadState(DATA);
		const current = st.armed?.[payload.harness] ?? [];
		if (on) {
			const caps = capsFor(payload.harness, { bin: detect()[payload.harness]?.bin ?? null });
			const pick = ["install", "slash", "shim"].find(channel => caps[channel]?.ok);
			if (!pick) return { error: "这个执行器暂时没有可用的接管方式，展开细节看原因。" };
			// 已经是这个通道就什么都不做，开关是幂等的
			if (current.includes(pick)) return { ok: true, results: [], channel: pick, done: [], skipped: [] };
			const result = changeChannel(DATA, { harness: payload.harness, channel: pick, enabled: true });
			return { ok: result.ok, results: [result], channel: pick, done: result.ok ? [result] : [], skipped: result.ok ? [] : [result.error] };
		}
		const result = disableHarness(DATA, payload.harness);
		return { ...result, channel: null, done: result.results.filter(r => r.ok), skipped: result.results.filter(r => !r.ok).map(r => r.error) };
	}
	const channels = !payload.channel || payload.channel === "all" ? ["install", "shim", "slash"] : [payload.channel];
	const results = channels.map(channel => changeChannel(DATA, { harness: payload.harness, channel, enabled: on, ...(channel === "project" ? { dir: process.cwd() } : {}) }));
	return { ok: results.every(r => r.ok), results, done: results.filter(r => r.ok), skipped: results.filter(r => !r.ok).map(r => r.error) };
	});
}

const send = (res, code, obj) => {
	if (res.destroyed || res.writableEnded) return;
	res.writeHead(code === 200 && obj?.error ? 400 : code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(obj));
};
const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
function booleanField(payload, key, fallback) {
	if (!Object.hasOwn(payload, key) && fallback !== undefined) return fallback;
	if (typeof payload[key] !== "boolean") throw httpError(400, `${key} 应为布尔值`);
	return payload[key];
}
function knownHarness(id) {
	if (typeof id !== "string" || !Object.hasOwn(matrix.harnesses, id)) throw httpError(400, "未知执行器");
	return id;
}
function localHost(req) {
	const host = req.headers.host;
	if (typeof host !== "string") return false;
	try {
		const url = new URL(`http://${host}`);
		return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password &&
			url.host === host.toLowerCase() && Number(url.port || 80) === req.socket.localPort;
	} catch { return false; }
}
const html = (res, ctx = {}) => {
	// 每次发页面都换一个代号：/api/leave 只认自己那一代，旧页面的 beacon 晚到也不会误伤新页面
	const gen = String((ctx.gen = (ctx.gen ?? 0) + 1));
	const page = readResource("web/ui.html").toString("utf8")
		.replace('<meta name="ap-server-gen" content="">', `<meta name="ap-server-gen" content="${gen}">`);
	return res
		.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" })
		.end(page);
};

// 刷新页面时 pagehide 会先于新页面的请求到达：留一个宽限期，让"关窗口"和"刷新"各归各位。
const LEAVE_GRACE = 1500;
function clearLeave(ctx) {
	if (!ctx?.leaveTimer) return;
	clearTimeout(ctx.leaveTimer);
	ctx.leaveTimer = null;
}

function isMutating(method) {
	return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

/** 浏览器跨站请求会带 Origin；curl/脚本没有，放行。有 Origin 就必须和 Host 同源。 */
function sameOrigin(req) {
	// 先看浏览器声明的跨站属性：没有 Origin 的跨站请求（部分 fetch 场景）也要挡住
	const site = req.headers["sec-fetch-site"];
	if (site && site !== "same-origin" && site !== "none") return false;
	const origin = req.headers.origin;
	if (!origin) return true;
	try {
		const u = new URL(origin);
		const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "[::1]";
		return loopback && u.protocol === "http:" && u.origin === origin && u.host.toLowerCase() === String(req.headers.host ?? "").toLowerCase();
	} catch {
		return false;
	}
}

function body(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0, done = false;
		const finish = (error, value) => {
			if (done) return;
			done = true;
			chunks.length = 0;
			if (error) reject(error); else resolve(value);
		};
		const contentType = req.headers["content-type"];
		if (contentType && !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
			req.resume(); finish(httpError(415, "请求应为 JSON")); return;
		}
		req.on("data", chunk => {
			if (done) return;
			size += chunk.length;
			if (size > 2 * 1024 * 1024) { finish(httpError(413, "请求超过 2 MiB")); return; }
			chunks.push(chunk);
		});
		req.once("end", () => {
			if (done) return;
			let value;
			try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
			catch { finish(httpError(400, "JSON 格式无效")); return; }
			if (!plainObject(value)) { finish(httpError(400, "JSON 应为对象")); return; }
			finish(null, value);
		});
		req.once("aborted", () => finish(httpError(400, "请求已中断")));
		req.once("error", error => finish(httpError(400, `请求读取失败：${error.message}`)));
	});
}

// 只有被直接当脚本跑（node web/server.mjs --serve 7788）才自启动；
// 被 bin 导入时必须保持安静——否则 `agent-purge web --serve 7789` 会两个端口各起一个实例，
// 并在第二个 bind 时吐出误导性的“端口已被占用：老实例还在跑”。
// 编译态 import.meta.url 也是 exe 路径，光比路径会把 exe 误当入口：只认 .mjs 脚本。
const selfPath = fileURLToPath(import.meta.url);
const isEntry = Boolean(process.argv[1]) && selfPath.endsWith(".mjs") && resolve(process.argv[1]) === selfPath;
if (isEntry && process.argv.includes("--serve")) {
	const servePort = Number(process.argv[process.argv.indexOf("--serve") + 1] ?? 7788);
	serveWeb(servePort, { autoExit: process.argv.includes("--auto-exit") });
}
