#!/usr/bin/env node
// agent-purge — 一个入口，把各家 harness 的系统提示词替换收进来。
// 能力与实测数字见 matrix.json。
//
// 命令只有两类，别再分第三类：
//   选东西（写 state.json）   use / mode / install / arm / slash
//   用东西（跑起来）           <harness> / 裸敲已 arm 的命令名 / web / ls / status
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { backends, oneshots } from "../backends/index.mjs";
import { resolveBin, launchConfig, prepareCommand, spawnPrepared } from "../lib/spawn.mjs";
import { launchEnvironment } from "../lib/environment.mjs";
import { createLaunch } from "../lib/launch.mjs";
import { installCrashHandlers, recover, swapFile } from "../lib/restore.mjs";
import { capsFor } from "../lib/caps.mjs";
import { MODES, armedOf, loadState, resolveFor } from "../lib/state.mjs";
import { dataHome, ensureDataHome } from "../lib/home.mjs";
import { applyConfiguration, changeChannel, configureHarness, disableHarness } from "../lib/apply.mjs";
import { ROOT, isCompiled, readResource } from "../lib/root.mjs";
// 静态导入：bun 单文件产物里，被动态 import 过的模块会被拆成独立 chunk，命名空间就空了
import { serveWeb } from "../web/server.mjs";

// 数据（state.json + personas/）放用户目录，npm 升级不会连人设一起清掉
// 编译态没有「包目录」可搬旧数据，传 null 跳过 legacy 迁移
const DATA = dataHome();
const matrix = (() => {
	try { return JSON.parse(readResource("matrix.json").toString("utf8")); }
	catch (error) { throw new Error(`无法加载 matrix.json：${error.message}`, { cause: error }); }
})();
// 这些家只有“整段替换/追加”两个启动口，没有宿主提示词可读：replace 实际按 strict 执行。
const STRICT_REPLACE = new Set(["codex", "claude", "grok", "codebuddy", "hermes"]);

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const controlArgs = separator < 0 ? argv : argv.slice(0, separator);
if (controlArgs.includes("--help") || controlArgs.includes("-h")) { help(); process.exit(0); }
if (argv[0] === "self-uninstall" && !argv.includes("--yes") && !argv.includes("--dry-run")) {
	console.error("self-uninstall 会永久删除用户人设、设置和恢复资料。请先备份；仅撤销接管并保留数据请用 agent-purge clean。\n先预览：agent-purge self-uninstall --dry-run\n确认删除：agent-purge self-uninstall --yes");
	process.exit(2);
}
ensureDataHome(isCompiled() ? null : ROOT);

installCrashHandlers();
const recovered = recover(); // 只在真实命令入口恢复；--help 不读写 journal
if (recovered > 0) console.log(`[restore] 回滚了 ${recovered} 个上次残留的配置文件`);

// 编译态与脚本态使用同一个 Web 入口；0 表示系统分配空闲端口，供隔离 smoke 使用。
if (argv[0] === "--serve") {
	const port = argv[1] === undefined ? 7788 : Number(argv[1]);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口必须为 0..65535 的整数");
	serveWeb(port, { autoExit: argv.includes("--auto-exit") });
	await new Promise(() => {});
}
const flag = (name, fallback) => {
	// 支持 --mode=append 这种写法（以前只认空格分隔，等号形式会被静默忽略）
	const inline = controlArgs.find((a) => a.startsWith(name + "="));
	if (inline !== undefined) return inline.slice(name.length + 1);
	const i = controlArgs.indexOf(name);
	return i === -1 ? fallback : controlArgs[i + 1];
};
let cmd = argv[0];

// 便携版 exe 双击无参数启动时，默认直接打开原生桌面窗口应用
if (!cmd && isCompiled()) {
	await webCmd({ autoExit: !argv.includes("--no-auto-exit") });
	// 挂住事件循环
	await new Promise(() => {});
}

if (!cmd || cmd.startsWith("-")) cmd = await defaultHarness();

// ── 选东西 ────────────────────────────────────────────────────────────────
switch (cmd) {
	case "use":
		await useCmd();
		break;
	case "sync":
		await syncCmd();
		break;
	case "mode":
		modeCmd();
		break;
	case "pause":
	case "resume":
		printApply(applyConfiguration(DATA, { enabled: cmd === "resume" }));
		break;
	case "install":
	case "uninstall":
		await installCmd(cmd, argv.slice(1));
		break;
	case "arm":
	case "disarm":
	case "register":
	case "注册":
		await armCmd(cmd === "arm" || cmd === "register" || cmd === "注册" ? "arm" : "disarm", argv.slice(1));
		break;
	case "slash":
		await slashCmd(argv.slice(1));
		break;
	case "project":
		await projectCmd(argv.slice(1));
		break;
	case "status":
		await statusCmd();
		break;
	case "ls":
		await lsCmd();
		break;
	case "pull":
		await personaImportCmd(argv.slice(1));
		break;
	case "persona":
		await personaImportCmd(argv.slice(1));
		break;
	case "doctor":
	case "detect": {
		const { doctor } = await import("../lib/doctor.mjs");
		await doctor(argv);
		break;
	}
	case "matrix":
		printMatrix();
		break;
	case "armor":
		await armorCli(argv.slice(1));
		break;
	case "update":
	case "upgrade": {
		const { checkForUpdate, downloadFile, replaceSelfExecutable, canReplaceSelf, RELEASES_PAGE } = await import("../lib/update.mjs");
		const doDownload = argv.includes("--download") || argv.includes("-d") || argv.includes("--yes") || argv.includes("-y");
		console.log("正在检查 GitHub Release 最新版本...");
		const info = await checkForUpdate({ force: true });
		if (!info.ok) {
			console.log(`✗ 检查更新失败：${info.error}`);
			console.log(`  可手动访问发布页查看：${RELEASES_PAGE}`);
			process.exitCode = 1;
			break;
		}
		console.log(`当前运行版本：v${info.current}`);
		if (info.published === false) {
			console.log("尚无公开 Release；这不表示 npm 已是最新版。npm 安装可运行 npm outdated -g agent-purge。");
			break;
		}
		console.log(`最新发布版本：v${info.latest} (${info.tagName || info.latest})`);
		if (!info.hasUpdate) {
			console.log("\n✓ 当前已是最新版本！");
			break;
		}
		console.log(`\n⚡ 发现新版本：v${info.latest}！`);
		if (info.body) {
			console.log(`\n【更新说明】\n${info.body.trim().slice(0, 500)}${info.body.length > 500 ? "..." : ""}`);
		}

		const isExe = canReplaceSelf();
		const targetExeAsset = info.assets?.find((a) => a.name.toLowerCase() === "agent-purge.exe");
		const targetSetupAsset = info.assets?.find((a) => a.name.toLowerCase().endsWith("-setup.exe"));

		if (isExe && targetExeAsset) {
			console.log(`\n检测到当前为独立 exe 运行环境，可直接原地升级。`);
			if (doDownload) {
				const { tmpdir } = await import("node:os");
				const tempTarget = join(tmpdir(), `agent-purge-new-${Date.now()}.exe`);
				console.log(`正在下载 ${targetExeAsset.name} (${(targetExeAsset.size / 1024 / 1024).toFixed(1)} MB)...`);
				await downloadFile(targetExeAsset.downloadUrl, tempTarget, (rec, tot) => {
					if (tot > 0) process.stdout.write(`\r下载进度: ${((rec / tot) * 100).toFixed(1)}%`);
				}, { expectedSize: targetExeAsset.size, digest: targetExeAsset.digest });
				console.log("\n下载完成，正在安全替换当前可执行文件...");
				try { replaceSelfExecutable(tempTarget); } finally { const { rmSync } = await import("node:fs"); rmSync(tempTarget, { force: true }); }
				console.log(`✓ 升级成功！当前 exe 已就绪为 v${info.latest}。重启 agent-purge 即可生效。`);
				break;
			}
			console.log(`  · 自动下载并就地升级当前 exe：\n     agent-purge update --download`);
		} else if (process.platform === "win32" && targetSetupAsset && doDownload) {
			const { tmpdir } = await import("node:os");
			const tempSetup = join(tmpdir(), targetSetupAsset.name);
			console.log(`正在下载安装包 ${targetSetupAsset.name}...`);
			await downloadFile(targetSetupAsset.downloadUrl, tempSetup, undefined, { expectedSize: targetSetupAsset.size, digest: targetSetupAsset.digest });
			console.log(`\n下载完成，正在启动安装程序：${tempSetup}`);
			const { spawn } = await import("node:child_process");
			spawn(tempSetup, [], { detached: true, stdio: "ignore" }).unref();
			process.exit(0);
		}

		console.log("\n【下载与升级方式】");
		console.log(`  1. 访问 GitHub Release 页面直接下载：\n     ${info.htmlUrl}`);
		if (info.assets?.length) {
			console.log("  2. Release 包含的安装/便携产物：");
			for (const a of info.assets) {
				const sizeMb = (a.size / 1024 / 1024).toFixed(1);
				console.log(`     · ${a.name} (${sizeMb} MB) → ${a.downloadUrl}`);
			}
		}
		console.log("  3. 若通过 npm 全局安装，可直接执行：\n     npm install -g agent-purge@latest");
		break;
	}
	case "web":
		await webCmd();
		break;
	case "clean":
	case "self-uninstall": {
		const { clean } = await import("../lib/clean.mjs");
		const dryRun = argv.includes("--dry-run");
		if (dryRun) console.log("dry-run：只报会做什么，一条也不写\n");
		const r = clean(DATA, { all: cmd === "self-uninstall", dryRun });
		for (const s of r.steps) {
			const detail = typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail);
			console.log(`${s.ok ? "✓" : "✗"} ${s.what}${s.detail === undefined ? "" : ` — ${detail}`}`);
		}
		if (r.leftovers.length) console.log(`\n还剩：\n${r.leftovers.map((l) => `  · ${l}`).join("\n")}`);
		console.log(r.ok && !r.leftovers.length ? "\n干净了：没有残留" : "\n有残留，见上");
		if (!r.ok) process.exitCode = 1;
		if (cmd === "self-uninstall") console.log("\n代码本身用包管理器卸：npm uninstall -g agent-purge");
		break;
	}
	case "verify": {
		const { verifyHarnesses, cleanupRoots } = await import("../lib/capture.mjs");
		const wanted = argv.slice(1).filter((a) => !a.startsWith("-"));
		const hs = wanted.length ? wanted : Object.keys(matrix.harnesses ?? {});
		const mode = loadState(DATA).state?.default?.mode ?? "replace";
		const report = await verifyHarnesses(hs, { root: DATA, mode });
		for (const r of report.harnesses) {
			if (r.status === "captured") {
				const m = r.modes[0];
				const where = ["sys", "user"].filter((k) => m?.injected?.[k]).join("+") || "-";
				console.log(`✓ ${r.harness} 实测：命中 ${where} · ${m?.chars ?? 0} 字 · ${m?.requests?.length ?? 0} 个请求`);
			} else if (r.status === "missing") console.log(`· ${r.harness} 未安装，跳过`);
			else console.log(`✗ ${r.harness} ${r.status}${r.reason ? ` — ${r.reason}` : ""}`);
		}
		console.log(`\n证据：${join(DATA, "verification", "latest.json")}`);
		cleanupRoots();
		if (report.harnesses.some((r) => ["mismatch", "error"].includes(r.status))) process.exitCode = 1;
		break;
	}
	default:
		await launch(cmd);
}

// ── 用东西 ────────────────────────────────────────────────────────────────

/** 无参：state.default 说跑谁就跑谁；没有默认就跑到 Web 去选 */
async function defaultHarness() {
	const { state } = loadState(DATA);
	const harness = state.default?.harness;
	if (!harness) {
		console.log("还没有默认 harness。两种办法：\n  agent-purge web           在浏览器里选，再点“设为默认执行器”\n  agent-purge <harness>     直接点名跑（如 agent-purge codex）");
		process.exit(0);
	}
	const eff = resolveFor(state, harness);
	const mark = (from) => (from === "override" ? "（单独指定）" : "（跟随全局）");
	console.log(`[default] ${harness} · ${eff.mode}${mark(eff.modeFrom)} · persona=${eff.persona ?? "-"}${mark(eff.personaFrom)}（state.json）`);
	return harness;
}

async function launch(name) {
	const spec = matrix.harnesses[name];
	if (!spec) die(`未知 harness: ${name}（可用: ${Object.keys(matrix.harnesses).join(", ")}；子命令见 --help）`);
	if (spec.class === "unsupported") die(`${name} 做不到：${spec.reason}`);

	const { state } = loadState(DATA);
	// 由 state.json 决定注入方式；显式 --mode 永远压过它
	const explicitMode = flag("--mode", null);
	if (explicitMode !== null && !MODES.includes(explicitMode)) die(`--mode 只能是 ${MODES.join(" / ")}`);
	const config = launchConfig(state, name, { mode: explicitMode, persona: flag("--persona", null) === "active" ? state.persona : flag("--persona", null) });
	const mode = config.mode;

	// 裸敲 pi 的持久位（写 state.json，扩展下一会话读它）
	const autoFlag = name === "pi" || name === "omp" ? flag("--auto", null) : null;
	if (autoFlag !== null) {
		if (autoFlag !== "on" && autoFlag !== "off") die("--auto 只能是 on / off");
		const { setPiAuto, setOmpAuto } = await import("../lib/state.mjs");
		if (name === "pi") setPiAuto(DATA, autoFlag === "on");
		else setOmpAuto(DATA, autoFlag === "on");
		console.log(`[auto] 裸敲 ${name} ${autoFlag === "on" ? "会" : "不会"}自动注入（已写入 state.json）`);
	}

	// pi 的人设落在哪一层：sys（默认，真系统提示词）或 user（塞进用户消息，给忽略 system 的模型）
	const layerFlag = name === "pi" ? flag("--layer", null) : null;
	if (layerFlag !== null) {
		if (layerFlag !== "sys" && layerFlag !== "user") die("--layer 只能是 sys / user");
		const { setPiUserLayer } = await import("../lib/state.mjs");
		setPiUserLayer(DATA, layerFlag === "user");
		console.log(
			layerFlag === "user"
				? "[layer] 人设额外塞进用户消息（给忽略 system 的模型用；代价是每条消息多一段）"
				: "[layer] 人设走 system 层（默认）",
		);
	}

	// 实测策略：该 harness 的哪一层真的能注入（数据来自 matrix.json armor 段）
	const { plan } = await import("../lib/armor.mjs");
	const strategy = plan(matrix, name);
	if (!strategy.error) {
		if (strategy.requiresSeed) console.log(`[策略] ${name}：裸注入 sys 层实测 ${strategy.bare.sys}%，带人设词种子 ${strategy.persona.sys}% —— 需要 seed 层`);
		const noSys = strategy.blocked.find((b) => b.layer === "sys");
		if (noSys && mode !== "off") console.log(`[策略] ${name}：sys 层不可用（${noSys.reason}），本次只能靠 user 层`);
	}
	if (mode === "replace" && STRICT_REPLACE.has(name)) {
		console.log(`[mode] ${name} 没有宿主提示词读取口：replace 实际按 strict 执行；要保留宿主请用 --mode append`);
	}

	// 通道全废的家（闭源桌面 / 提示词在服务端）说清楚：这次只是原样启动，没注入任何东西
	{
		const c = capsFor(name);
		if (!c.shim.ok && !c.install.ok && !c.slash.ok && mode !== "off") {
			const why = [c.shim, c.install, c.slash].map((x) => x.why).filter(Boolean)[0];
			console.log(`[提示] ${name} 注入不进去，本次是原样启动：${why}`);
		}
	}

	let picked = null, personaPath = null, personaText = "";
	if (mode !== "off") {
		const { createStore } = await import("../lib/personas.mjs");
		const store = createStore(DATA);
		const id = config.persona ?? store.activeId();
		picked = store.read(id);
		if (!picked) die(`没有 persona: ${id}`);
		personaPath = picked.id === store.activeId() ? store.refreshActive() : store.materialize(picked.id);
		personaText = picked.body.trim();
	}
	const cwd = resolve(flag("--cwd", process.cwd()));

	// --ask：一次性问答，与 Web UI 共用 oneshots 规格；不给才启动交互式 harness
	// 透传：有 -- 就只收 -- 后面的；没有就把“不是 agent-purge 自己的 flag”全交给 harness
	// （这样裸命令 `pi -p "…"` / `codex exec "…"` 经 shim 进来也能把参数带到，--ask 也一样）
	const dd = argv.indexOf("--");
	let passthrough = [];
	if (dd !== -1) {
		passthrough = argv.slice(dd + 1);
	} else {
		const ownWithValue = new Set(["--ask", "--mode", "--persona", "--cwd", "--auto", "--layer"]);
		const tail = argv.slice(1);
		for (let i = 0; i < tail.length; i++) {
			const t = tail[i];
			if (ownWithValue.has(t)) {
				i++;
				continue;
			}
			if (t === "--dry-run" || ownWithValue.has(t.split("=")[0])) continue;
			passthrough.push(t);
		}
	}

	const askEq = controlArgs.find((a) => a.startsWith("--ask="));
	const askIdx = controlArgs.indexOf("--ask");
	const askPrompt = askEq !== undefined ? askEq.slice(6) : askIdx !== -1 ? controlArgs[askIdx + 1] : null;
	let built;
	if (askPrompt !== null) {
		const raw = askPrompt;
		if (!raw || raw.startsWith("--")) die('--ask 需要一个 prompt，例如: agent-purge codex --ask "解释这段代码"');
		const prompt = raw.trim();
		const one = oneshots[name];
		if (!one) die(`${name} 没有一次性运行模式（可用: ${Object.keys(oneshots).join(", ")}）`);
		built = one({ prompt, personaPath, personaText, mode, cwd, root: DATA });
		if (passthrough.length) built.args = [...built.args, ...passthrough];
	} else {
		built = backends[name]?.({ personaPath, personaText, mode, args: passthrough, cwd, root: DATA, reason: spec.reason }) ?? {
			unsupported: "该 harness 还没有后端实现",
		};
	}

	if (built.manual) {
		console.log(`${name}: 需要人工介入`);
		built.manual.forEach((line) => console.log("  - " + line));
		process.exit(0);
	}
	if (built.unsupported) die(`${name} 做不到：${built.unsupported}`);

	if (built.note) console.log(built.note);
	const dryRun = controlArgs.includes("--dry-run");
	const ompProfile = name === "omp" ? (flag("--profile", null) ?? process.env.OMP_PROFILE ?? null) : null;
	const ompNoExtensions = name === "omp" && argv.includes("--no-extensions");
	const useExtension = mode !== "off" && (name === "pi" || (name === "omp" && askPrompt === null && !ompProfile && !ompNoExtensions));
	let extFile = null;
	if (useExtension) {
		if (name === "omp" && ["--system-prompt", "--append-system-prompt"].includes(built.args[0])) built.args.splice(0, 2);
		const { resolveSlash } = await import("../lib/slashes.mjs");
		extFile = resolveSlash(name, DATA)?.file;
		if (!extFile) die(`${name}: 没有扩展目录`);
		// 临时 -e 只供本次进程；不会悄悄选择常驻 /purge 或覆盖用户已有扩展。
		if (!state.armed?.[name]?.includes("slash")) {
			extFile = join(DATA, "runtime", "extension-" + name + ".mjs");
			built.args = ["-e", extFile, ...built.args];
		}
	}
	if (mode === "off") {
		const { launchConflicts } = await import("../lib/launch-conflicts.mjs");
		const conflicts = launchConflicts(DATA, name, cwd);
		if (conflicts.length) die("本次 off 与仍在磁盘上的常驻/项目内容冲突：\n" + conflicts.join("\n") + "\n请先 agent-purge pause 撤下登记内容，再重试。全局选择保持不变。");
		console.log(state.default?.mode === "off" ? "[off] 总电源关着：本次不安装、不 materialize、不注入；恢复请用 agent-purge resume" : "[off] 本次透传；全局选择保持不变");
	}
	console.log(`[cmd] ${[built.cmd, ...previewArgs(built.args)].join(" ")}`);
	if (extFile) console.log(`[ext] ${extFile}`);
	if (dryRun) return;
	if (!resolveBin(built.cmd)) die(`${name}: 找不到可执行文件 ${built.cmd}`);
	if (name === "opencode" && built.args.some(v => v === "--attach" || v.startsWith("--attach="))) die("一次性启用使用独立宿主；--attach 指向已有服务，请使用该服务已登记的常驻通道");
	const needsLease = useExtension || built.runtime || ["pi", "omp", "dsh", "opencode", "opencode2"].includes(name);
	const lease = needsLease ? createLaunch(DATA, name, { persona: picked?.id, mode, writer: useExtension ? "extension" : built.runtime ? "temporary" : "cli" }) : null;
	let undoExtension = null, cleaned = false, child = null, server = null;
	const cleanup = () => {
		if (cleaned) return true;
		try {
			lease?.close();
			if (server) { server.close(); server = null; }
			built.cleanup?.();
			if (undoExtension) { undoExtension(); undoExtension = null; }
			cleaned = true; return true;
		} catch (error) { console.error("[cleanup] " + error.message + "；恢复凭据已保留，可重试"); return false; }
	};
	process.once("exit", cleanup);
	try {
		const env = { ...launchEnvironment(process.env), ...built.env, ...lease?.env };
		if (useExtension) {
			const { extensionSource } = await import("../lib/extension.mjs");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(join(extFile, ".."), { recursive: true });
			undoExtension = swapFile(extFile, extensionSource(DATA, name));
		}
		built.setup?.();
		if (built.privateServer) {
			const { startPrivateServer } = await import("../lib/private-server.mjs");
			server = await startPrivateServer(built.cmd, { env, cwd, lease });
			built.args = server.clientArgs(built.args);
		}
		const stdio = askPrompt !== null ? ["ignore", "inherit", "inherit"] : "inherit";
		const descriptor = prepareCommand(built.cmd, built.args, { cwd, stdio, env });
		if (lease && !server && !descriptor.hostDirect) throw new Error("临时启用尚未验证这个启动器的宿主归属，请指向原生 exe 或标准 Node 入口");
		const startedAt = Date.now(); child = spawnPrepared(descriptor);
		if (lease && !server && child.pid) lease.publish(child.pid, startedAt);
		let finished = false;
		const finish = code => { if (finished) return; finished = true; process.exitCode = cleanup() ? code ?? 1 : 1; };
		child.once("error", error => { console.error(`${name}: ${error.message}`); finish(1); });
		child.once("close", finish);
	} catch (error) {
		if (child) child.kill(); cleanup(); process.exitCode = 1; console.error(`${name}: ${error.message}`);
	}

}

// ── 选东西的实现 ───────────────────────────────────────────────────────────

function printApply(r) {
	console.log(`persona ${r.persona ?? "(未设置)"} · mode ${r.mode} · revision ${r.revision}`);
	for (const row of r.results) {
		// 被例外覆盖的那家写进去的不是全局值，直接标出来，否则看不出来它是怎么生效的
		const odd = row.mode && row.mode !== r.mode ? ` [${row.persona ?? "-"} · ${row.mode}]` : "";
		console.log(`${row.status === "failed" ? "✗" : "✓"} ${row.harness}:${row.channel}${odd}${row.channel === "project" && row.file ? ` → ${row.file}` : ""} — ${row.error ?? row.message}`);
	}
	if (!r.ok) process.exitCode = 1;
}

/** 只列跟全局不一样的几家；没例外就什么都不打印 */
function printOverrides(state) {
	for (const [h, o] of Object.entries(state.overrides ?? {})) {
		const bits = [o.persona ? `人设=${o.persona}` : "", o.mode ? `模式=${o.mode}` : ""].filter(Boolean);
		console.log(`  ${h}: ${bits.join(" ")}（其余跟随全局；--for ${h} follow 恢复）`);
	}
}

async function useCmd() {
	const id = argv[1];
	const forHarness = flag("--for", null);
	if (forHarness) {
		if (!id) die("用法：agent-purge use <persona|follow> --for <harness>");
		const follow = id === "follow";
		const { createStore } = await import("../lib/personas.mjs");
		const store = createStore(DATA);
		if (!follow && !store.read(id)) die(`没有人设: ${id}（可用: ${store.list().map((p) => p.id).join(", ")}）`);
		const report = configureHarness(DATA, forHarness, { persona: follow ? null : id });
		const eff = resolveFor(loadState(DATA).state, forHarness);
		console.log(`${forHarness} 人设 → ${eff.persona ?? "(未设置)"}（${eff.personaFrom === "override" ? "单独指定" : "跟随全局"}）`);
		printApply(report);
		return;
	}
	if (!id) {
		console.log(`当前 persona: ${loadState(DATA).state.persona ?? "(未设置)"}`);
		printOverrides(loadState(DATA).state);
		return;
	}
	printApply(applyConfiguration(DATA, { persona: id }));
}

async function syncCmd() {
	printApply(applyConfiguration(DATA, { onlyFailed: argv.includes("--failed") }));
}

function modeCmd() {
	const mode = argv[1];
	const forHarness = flag("--for", null);
	if (forHarness) {
		if (!mode) die("用法：agent-purge mode <strict|replace|append|off|follow> --for <harness>");
		const follow = mode === "follow";
		if (!follow && !MODES.includes(mode)) die(`未知模式: ${mode}（可用: ${MODES.join("/")}/follow）`);
		const report = configureHarness(DATA, forHarness, { mode: follow ? null : mode });
		const eff = resolveFor(loadState(DATA).state, forHarness);
		console.log(`${forHarness} 模式 → ${eff.mode}（${eff.modeFrom === "override" ? "单独指定" : "跟随全局"}）`);
		printApply(report);
		return;
	}
	if (!mode) {
		console.log(`当前模式: ${loadState(DATA).state.default?.mode ?? "replace"}\nstrict=只发人设；replace=移除宿主身份句；append=宿主后追加；off=暂停并撤下静态内容`);
		printOverrides(loadState(DATA).state);
		return;
	}
	printApply(applyConfiguration(DATA, { mode }));
}

async function installCmd(verb, rest) {
	const { targets } = await import("../lib/persist.mjs");
	const named = rest.filter(value => !value.startsWith("-"));
	const ids = named.length ? named : Object.keys(targets);
	for (const harness of ids) {
		const r = changeChannel(DATA, { harness, channel: "install", enabled: verb === "install", force: rest.includes("--force") });
		console.log(`${r.ok ? "✓" : "✗"} ${verb} ${harness} — ${r.error ?? r.action ?? r.message}${r.file ? " → " + r.file : ""}`);
		if (r.profiles) console.log(`  实际 profile：${r.profiles.join(", ") || "没有已安装的插件"}`);
		for (const file of r.preserved ?? []) console.log(`  保留用户修改/旧版文件：${file}`);
		if (verb === "uninstall" && harness === "dsh") console.log("  uninstall 仅撤常驻通道；撤销包含 /purge 在内的全部入口请用 agent-purge disarm dsh。");
		if (!r.ok) process.exitCode = 1;
	}
}

async function armCmd(verb, rest) {
	const named = rest.filter(value => !value.startsWith("-"));
	const ids = named.length ? named : Object.keys(matrix.harnesses).filter(h => matrix.harnesses[h].class !== "unsupported");
	for (const h of ids) if (!matrix.harnesses[h]) die(`未知执行器: ${h}`);
	if (rest.includes("--all")) {
		console.log("总电源：" + (verb === "arm" ? "恢复" : "暂停"));
		printApply(applyConfiguration(DATA, { enabled: verb === "arm" }));
	}
	const channels = ["install", "shim", "slash", "project"].filter(c => rest.includes("--" + c));
	let shim = false;
	for (const harness of ids) {
		if (verb === "disarm" && !channels.length) {
			const r = disableHarness(DATA, harness);
			console.log(`${r.ok ? "✓" : "✗"} disarm ${harness}`);
			for (const row of r.results) if (!row.ok) console.log("  " + row.channel + ": " + row.error);
			if (!r.ok) process.exitCode = 1;
			continue;
		}
		for (const channel of channels.length ? channels : ["install", "shim", "slash"]) {
			if (verb === "arm" && !capsFor(harness)[channel]?.ok) { console.log(`- ${harness}:${channel} — ${capsFor(harness)[channel]?.why}`); continue; }
			const r = changeChannel(DATA, { harness, channel, enabled: verb === "arm", force: rest.includes("--force") });
			console.log(`${r.ok ? "✓" : "✗"} ${verb} ${harness}:${channel} — ${r.error ?? r.action ?? r.message}`);
			if (!r.ok) process.exitCode = 1;
			if (r.ok && verb === "arm" && channel === "shim") shim = true;
		}
	}
	if (shim) { const { ensureUserPath } = await import("../lib/shim.mjs"); const r = ensureUserPath(); console.log("[path] " + r.how); }
}

async function slashCmd(rest) {
	const { slashStatus } = await import("../lib/slashes.mjs");
	const verb = rest[0];
	if (!verb || verb === "status") {
		for (const row of slashStatus(DATA)) console.log(`${row.installed ? "✓" : "·"} ${row.id}: ${row.note} → ${row.file}`);
		return;
	}
	const enabled = verb !== "off";
	const named = (enabled ? rest : rest.slice(1)).filter(v => !v.startsWith("-"));
	const ids = named.length ? named : slashStatus(DATA).filter(s => enabled ? s.offered : s.installed).map(s => s.id);
	for (const harness of ids) {
		const r = changeChannel(DATA, { harness, channel: "slash", enabled });
		console.log(`${r.ok ? "✓" : "✗"} /purge ${harness} — ${r.error ?? r.action ?? r.message}`);
		if (!r.ok) process.exitCode = 1;
	}
}

async function projectCmd(rest) {
	const { projectStatus, projectTargets, gitHint } = await import("../lib/project.mjs");
	const dir = resolve(flag("--dir", process.cwd()));
	const verb = ["on", "off", "status"].includes(rest[0]) ? rest[0] : "status";
	const named = [];
	for (let i = rest[0] === verb ? 1 : 0; i < rest.length; i++) {
		if (rest[i] === "--dir") { i++; continue; }
		if (!rest[i].startsWith("-")) named.push(rest[i]);
	}
	const capable = Object.keys(projectTargets);
	if (verb === "status") {
		const rows = projectStatus(dir, DATA);
		console.log(`项目目录：${dir}`);
		for (const r of rows) console.log(`${r.on || r.selected ? "✓" : " "} ${r.id.padEnd(9)} ${r.file}${r.selected && !r.on ? "（已选，尚未写入）" : r.hasBlock && !r.on ? "（有块但不是我们记的）" : ""}`);
		return;
	}
	if (verb !== "on" && verb !== "off") die(`用法：agent-purge project on|off [harness…] [--dir X]`);
	const ids = named.length
		? named
		: verb === "on"
			? Object.keys(loadState(DATA).state.armed ?? {}).filter((h) => capable.includes(h))
			: projectStatus(dir, DATA).filter((r) => r.on || r.selected).map((r) => r.id);
	if (!ids.length) {
		console.log(verb === "on" ? `没有已接管的项目级 harness（可用: ${capable.join(", ")}）；点名写：agent-purge project on pi` : "这个目录里没有托管块");
		return;
	}
	for (const h of ids) {
		if (!capable.includes(h)) {
			console.log(`- ${h}: 没有项目级规则文件`);
			continue;
		}
		const r = changeChannel(DATA, { harness: h, channel: "project", enabled: verb === "on", dir });
		if (!r.ok) {
			console.log(`✗ ${h}: ${r.error ?? "写入失败"}`);
			continue;
		}
		console.log(`${verb === "on" ? "✓" : "-"} ${h} ${r.file}${r.action ? `（${r.action}）` : ""}`);
		if (verb === "on") r.hint = gitHint(h, dir);
		if (r.hint) console.log(`   注意：${r.hint}`);
	}
}

async function statusCmd() {
	const { migrated } = loadState(DATA);
	migrated.forEach((m) => console.log(`[migrate] ${m}`));
	// armed 是缓存，磁盘才是真相：先把假记录摘掉，再报数
	const { reconcileArmed } = await import("../lib/armed.mjs");
	const fixed = await reconcileArmed(DATA);
	if (fixed.length) console.log(`[对账] armed 纠正：${fixed.join(", ")}`);
	const { state } = loadState(DATA);
	return Promise.all([import("../lib/shim.mjs"), import("../lib/slashes.mjs")]).then(([shimMod, slashMod]) => {
		const shims = shimMod.shimStatus();
		const slashes = slashMod.slashStatus(DATA);

		console.log(`persona  ${state.persona ?? "(未设置)"}`);
		console.log(`default  ${state.default ? `${state.default.harness ?? "(未选默认)"} · ${state.default.mode}` : "(未设置)"}   裸敲 agent-purge 用它`);
		console.log(`state    ${join(DATA, "state.json")}`);
		console.log("");
		console.log("harness     shim   slash  install   /purge层  常驻落点");
		for (const [h] of Object.entries(matrix.harnesses)) {
			const armed = armedOf(state, h);
			const sh = shims.find((s) => s.id === h);
			const sl = slashes.find((s) => s.id === h);
			const cap = capsFor(h, { bin: sh?.target ?? null });
			const mark = (on) => (on ? " ✓  " : " ·  ");
			const slashCol = sl && sl.offered ? (sl.layer === "sys" ? "sys(热)" : "user") : "—";
			// install 列不写“注册没注册”，写“能不能装”：装了是 ✓，能装没装是「可用」，没落点才是 —
			const installCol = armed.includes("install") ? " ✓ " : cap.install.ok ? "可用" : " — ";
			const landing = cap.install.ok ? `${cap.install.layer || "?"}${cap.install.verified === false ? "(未实测)" : ""}` : (cap.install.why || "");
			console.log(
				`${h.padEnd(11)}${mark(sh?.installed).padEnd(7)}${mark(sl?.installed).padEnd(7)}${installCol.padEnd(10)}${slashCol.padEnd(10)}${landing}`,
			);
		}
		const dir = shimMod.shimDir();
		const ps = shimMod.pathState();
		const where = !ps.present ? "不在 PATH" : ps.first ? "已在 PATH 最前" : "在 PATH 但不最前（真身可能先被命中）";
		console.log(`\nshim 目录 ${dir}（${where}）`);
		if (!ps.first) console.log(`修好它：agent-purge arm <h> --shim（会自动修正 PATH）`);
	});
}

async function personaImportCmd(args = []) {
	let sub = args[0];
	let source = args[1];
	if (sub !== "pull" && sub !== "import") {
		source = sub;
		sub = "pull";
	}
	if (!source && sub === "pull") {
		source = "ZiChuanLan/some-magic";
	}
	if (!source) {
		die("用法：agent-purge pull [owner/repo 或 本地目录] 或 agent-purge persona import <dir>");
	}

	const noOverwrite = argv.includes("--no-overwrite");
	const { importPersonas } = await import("../lib/persona-import.mjs");
	console.log(`正在从 ${source} 拉取人设...`);
	try {
		const res = await importPersonas(source, DATA, { overwrite: !noOverwrite });
		console.log(`\n拉取完成！共导入 ${res.total} 个人设：`);
		for (const item of res.imported) {
			console.log(`  ✓ ${item.id.padEnd(14)} ${item.name} (${item.chars} 字, ${item.action === "created" ? "新增" : "更新"})`);
		}
		if (res.skipped?.length) {
			console.log(`\n跳过 ${res.skipped.length} 个文件：`);
			for (const item of res.skipped) {
				console.log(`  - ${item.file || item.id}: ${item.reason}`);
			}
		}
		if (res.errors?.length) {
			console.log(`\n错误 ${res.errors.length} 项：`);
			for (const item of res.errors) {
				console.log(`  ✗ ${item.file}: ${item.error}`);
			}
		}
		console.log(`\n查看已安装人设：agent-purge ls`);
		console.log(`切换当前人设：agent-purge use <id>`);
	} catch (e) {
		die(`拉取失败：${e.message}`);
	}
}

async function lsCmd() {
	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	const { state } = loadState(DATA);
	const fit = store.resolve({ harness: state.default?.harness, model: null });
	for (const p of store.list()) {
		const mark = p.id === store.activeId() ? "*" : " ";
		const best = fit?.persona?.id === p.id && fit?.matched ? " ← 最匹配当前 harness" : "";
		const desc = p.meta?.description ?? p.meta?.desc ?? "";
		console.log(`${mark} ${p.id.padEnd(14)} ${String(p.meta?.name ?? "").padEnd(12)} ${desc.slice(0, 44)}${best}`);
	}
	console.log(`\n* = active（agent-purge use <id> 切换）`);
}

async function webCmd(options = {}) {
	const port = Number(flag("--port", "7788"));
	if (!Number.isInteger(port) || port < 0 || port > 65535) die("端口必须为 0..65535 的整数");
	const noOpen = argv.includes("--no-open");
	const autoExit = options.autoExit ?? (argv.includes("--auto-exit") || (isCompiled() && !argv.includes("--no-auto-exit")));
	const url = `http://127.0.0.1:${port}`;
	const { openAppWindow } = await import("../lib/window.mjs");
	const probeAlive = async () => {
		try {
			const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1500) });
			if (!res.ok) return false;
			const data = await res.json().catch(() => null);
			return Boolean(data && typeof data === "object" && ("version" in data || "personas" in data));
		} catch { return false; }
	};

	// --detach：脱离当前终端后台存活，日志丢弃
	if (argv.includes("--detach")) {
		if (port === 0) die("--detach 需要明确端口；随机端口请用前台 web --port 0 --no-open");
		if (await probeAlive()) {
			console.log(`agent-purge 后台服务已在运行 → ${url}`);
			if (!noOpen) {
				const res = openAppWindow(url);
				if (res.mode === "app") console.log(`已启动独立桌面窗口（${res.browser}）`);
			}
			process.exit(0);
		}
		// 源码态 execPath 是 node，得连脚本路径一起给；编译态 execPath 就是 exe 本体
		const serveArgs = ["--serve", String(port)];
		if (autoExit) serveArgs.push("--auto-exit");
		const serve = isCompiled() ? serveArgs : [join(ROOT, "web", "server.mjs"), ...serveArgs];
		const child = spawn(process.execPath, serve, {
			detached: true,
			stdio: "ignore",
			shell: false,
			windowsHide: true,
			env: { ...process.env, AGENT_PURGE_HOME: DATA },
		});
		child.unref();
		console.log(`agent-purge 后台启动请求已发送 → ${url}（pid ${child.pid}；请确认服务可连接）`);
		if (!noOpen) {
			const res = openAppWindow(url);
			if (res.mode === "app") console.log(`已启动独立桌面窗口（${res.browser}）`);
		}
		process.exit(0);
	}

	const onServerError = async (e) => {
		// 端口被占时（如桌面启动器二次双击、老实例未退出）：先探测是否正是活着的 agent-purge
		if (e.code === "EADDRINUSE") {
			if (await probeAlive()) {
				if (!noOpen) {
					const res = openAppWindow(url);
					if (res.mode === "app") console.log(`✓ 发现已在运行的 agent-purge 服务，已作为独立桌面窗口打开（${res.browser}）`);
					else console.log(`✓ 发现已在运行的 agent-purge 服务，已在浏览器中打开：${url}`);
				} else {
					console.log(`agent-purge 服务已在 ${url} 运行`);
				}
				process.exit(0);
			}
			console.error(`${port} 已被占用且未响应 agent-purge 请求：可能是老实例卡死或其他程序占用。`);
			console.error(`清掉再启：Get-NetTCPConnection -LocalPort ${port} -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`);
		} else {
			console.error(`web 启动失败：${e.message}`);
		}
		process.exit(1);
	};

	const server = serveWeb(port, { autoExit, onError: onServerError });
	if (!noOpen) {
		server.once("listening", () => {
			const res = openAppWindow(`http://127.0.0.1:${server.address().port}`);
			if (res.mode === "app") console.log(`✓ 已作为独立桌面窗口打开（无标签/地址栏，原生客户端体验）`);
		});
	}
	return server;
}

// ── 其余 ──────────────────────────────────────────────────────────────────

async function armorCli(rest) {
	const { renderMatrix, renderPlan, plans, plan, preflight, runBench, runJudge } = await import("../lib/armor.mjs");
	const color = !argv.includes("--no-color") && Boolean(process.stdout.isTTY);
	const sub = rest[0]?.startsWith("-") ? "matrix" : rest[0] ?? "matrix";
	const opts = (name, fallback) => {
		const i = rest.indexOf(name);
		return i === -1 ? fallback : rest[i + 1];
	};
	const flags = rest.filter((x) => x.startsWith("--"));
	// 位置参数 ≠ 非 - 开头的 token：`--base https://x` 的值不是 harness 名
	const VALUE_FLAGS = new Set(["--base", "--key", "--model", "--task", "--layers", "--only", "--repeat", "--concurrency", "--timeout", "--out", "--dir", "--probe"]);
	const positionals = (from = 1) => {
		const out = [];
		for (let i = from; i < rest.length; i++) {
			const a = rest[i];
			if (a.startsWith("--")) {
				if (VALUE_FLAGS.has(a)) i++;
				continue;
			}
			if (!a.startsWith("-")) out.push(a);
		}
		return out;
	};

	if (sub === "matrix") return renderMatrix(matrix, { color });

	if (sub === "plan") {
		const ids = positionals();
		const list = ids.length ? ids.map((id) => plan(matrix, id)) : plans(matrix);
		list.forEach((p, i) => {
			if (i) console.log();
			renderPlan(p, { color });
		});
		if (!ids.length) console.log(`\n${"─".repeat(48)}\n批量跑：agent-purge armor run --task crack-bare --layers off,sys,user --only ${list.map((p) => p.id).join(",")}`);
		return;
	}

	if (sub === "preflight" || sub === "check") {
		const ids = positionals();
		const env = { base: opts("--base", process.env.MG_BASE), key: opts("--key", process.env.MG_KEY), model: opts("--model", process.env.MG_MODEL) };
		let bad = 0;
		for (const id of ids.length ? ids : ["pi"]) {
			const r = preflight(matrix, id, env);
			console.log(`${r.ok ? "✓" : "✗"} ${id}`);
			r.checks.forEach((c) => console.log(`   ${c.ok ? "ok  " : "MISS"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`));
			if (!r.ok) bad++;
		}
		if (bad) process.exitCode = 1;
		return;
	}

	if (sub === "run") {
		if (flags.includes("--help")) {
			console.log(`agent-purge armor run --task crack-bare --layers off,sys,user --only pi,codex --repeat 2 --concurrency 3
  --base <url>  --key <key>  --model <id>    上游（默认读 MG_BASE / MG_KEY / MG_MODEL）
  --task crack-bare|crack-persona           问法（裸问法 / 带人设词种子）
  --layers off,sys,user|off,sys
  --out <dir>`);
			return;
		}
		const env = {
			MG_BASE: opts("--base", process.env.MG_BASE),
			MG_KEY: opts("--key", process.env.MG_KEY),
			MG_MODEL: opts("--model", process.env.MG_MODEL),
		};
		if (!env.MG_BASE || !env.MG_KEY) {
			console.error("缺少上游：--base / --key（或环境变量 MG_BASE / MG_KEY）。例：\n  agent-purge armor run --base https://api.deepseek.com/v1 --key $env:MG_KEY --model deepseek-flash --task crack-bare --layers off,sys --only pi");
			process.exit(2);
		}
		const pass = [];
		for (let i = 0; i < rest.length; i++) {
			const a = rest[i];
			if (["--base", "--key", "--model"].includes(a)) { i++; continue; }
			pass.push(a);
		}
		const { code } = runBench(pass, env);
		process.exitCode = code;
		return;
	}

	if (sub === "judge") {
		const pass = [];
		for (let i = 0; i < rest.length; i++) {
			const a = rest[i];
			if (["--base", "--key", "--model"].includes(a)) { i++; continue; }
			pass.push(a);
		}
		const { code } = runJudge(pass, {
			MG_BASE: opts("--base", process.env.MG_BASE),
			MG_KEY: opts("--key", process.env.MG_KEY),
			MG_MODEL: opts("--model", process.env.MG_MODEL),
		});
		process.exitCode = code;
		return;
	}

	console.error(`未知子命令: armor ${sub}（可用: matrix | plan | preflight | run | judge）`);
	process.exit(2);
}

function printMatrix() {
	const rows = Object.entries(matrix.harnesses).map(([name, s]) => ({
		harness: name,
		class: s.class,
		override: s.override === true ? "yes" : s.override ? String(s.override) : "no",
		inject: s.inject ? "yes" : "no",
		hot: s.hotSwitch ? "yes" : "no",
		chars: s.defaultSystemChars != null ? `${s.defaultSystemChars} → ${s.purgedSystemChars ?? "?"}` : "—",
		armor: s.armor ? `${s.armor.probe.bare.sys ?? "—"}${s.armor.probe.bare.sys == null ? "" : "%"} / ${s.armor.probe.bare.user ?? "—"}${s.armor.probe.bare.user == null ? "" : "%"}` : "未测",
		version: s.measuredVersion ?? "—",
	}));
	const head = ["harness", "class", "override", "inject", "hot", "system chars", "sys/user 注入", "version"];
	const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(Object.values(r)[i]).length)));
	const line = (cells) => cells.map((c, i) => String(c).padEnd(width[i])).join("  ");
	console.log(line(head));
	console.log(width.map((w) => "-".repeat(w)).join("  "));
	rows.forEach((r) => console.log(line(Object.values(r))));
	const residues = Object.entries(matrix.harnesses).filter(([, s]) => s.residue);
	if (residues.length) {
		console.log("\n残留:");
		residues.forEach(([n, s]) => console.log(`  ${n}: ${s.residue}`));
	}
}

function help() {
	console.log(`agent-purge —— 把任意 harness 的系统提示词换成你的 persona

一句话：先「选」，再「用」。选一次，之后所有入口都跟着变。

① 选（写共享配置并同步；已加载动态插件下一轮读取，静态入口需新会话）
   agent-purge use <id>           换 persona（ls 看有哪些，* = 当前；自动刷新已武装的常驻落点）
   agent-purge use <id> --for <h> 只给某一家换 persona；--for <h> follow 恢复跟随全局
   agent-purge pull [repo]        从 GitHub（默认 ZiChuanLan/some-magic）拉取人设
   agent-purge persona import <dir> 从本地目录批量导入人设 (.md)
   agent-purge sync               只刷新常驻落点/命令文件，不换 persona
   agent-purge mode <m>           replace(换身份, 默认) / strict(只留人设) / append(追加) / off
   agent-purge mode <m> --for <h> 只给某一家设模式；--for <h> follow 恢复跟随全局
   agent-purge pause              暂停并撤下静态托管内容，保留通道选择
   agent-purge resume             恢复上次模式与原选择范围
   agent-purge clean              从所有 harness 彻底拔出插件与接管命令并还原配置
   agent-purge update             检查 GitHub Release 最新版本与下载更新
   agent-purge web                浏览器里点选 harness · persona · mode

② 用（命令入口与常驻配置的生效时机不同）
   agent-purge                   裸敲 = 跑 default 里那家（web 选过就用选过的）
   agent-purge <h> [--ask "…"]   指定一家启动；--dry-run 只看命令，-- 后面透传
   <h>                           web / arm 之后直接敲命令名，就已经注入

③ 装（让「别的入口」也带人设；一条命令全装，想只做一项就点名）
   agent-purge arm <h>|--all                常驻 + 裸命令接管 + /purge 全开（= 注册）
   agent-purge 注册 [--all]                 中文别名，同上
   agent-purge arm <h> --shim               只做裸命令接管（写 PATH 最前）
   agent-purge arm <h> --install            只做配置文件常驻
   agent-purge arm <h> --slash              只做会话内 /purge
   agent-purge disarm <h>|--all             以上全部撤掉；不带 <h> 就是所有 harness
   agent-purge clean                        按账本撒回所有写入（保留 state 与人设）
   agent-purge self-uninstall --yes         撤回写入 + 永久删除数据目录（先备份人设）
   agent-purge self-uninstall --dry-run     只预览将撤销和删除的项目
   agent-purge project on|off [<h>…]        项目级：写当前目录的 AGENTS.md / CLAUDE.md
     [--dir X]                              托管块；只影响这个项目，删块即逐字节还原

   注：--all 是总电源（state.json 的 default.mode）。带 <h> 时只撤那家，
       但同样把总电源关掉——不然裸敲 agent-purge、agent-purge <h> 照样注入。
       彻底别管我：agent-purge disarm --all

④ 看
   agent-purge status             一张表：每家的 shim / slash / install / 能做什么
   agent-purge ls                 persona 列表
   agent-purge verify [harness…]  实测：本机真跑一次，看人设到底进没进 system（写 verification/latest.json）
   agent-purge matrix             能力矩阵（matrix.json）
   agent-purge armor [...]        plan|preflight|run|judge 实测热力图
   agent-purge doctor             本机探测（哪家装了、版本）

通道语义
   shim     在 PATH 最前放同名 cmd，裸敲即经 agent-purge 启动（sys 层注入）
   install  改 harness 自己的配置/插件文件（连别人启动的它也会带人设）
   slash    pi / omp / dsh 通过扩展提供 /purge，会话下一轮读取
   project  写当前项目根的 AGENTS.md / CLAUDE.md（和全局块同时开会两份都进）
   热切     pi / omp / dsh / opencode / opencode2 已验证同会话 A→B→strict→off
            首次安装或更新插件代码需重新加载；其他启动参数入口需新会话
   证据     npm run test:harness；Web「验证与诊断」展示请求角色与宿主残留
            配置写入不代表当前会话已读取；Codex 实际请求角色为 developer。

harness: pi, opencode, opencode2, dsh, codex, claude, grok, omp, hermes, zcode, antigravity, codebuddy
          opencode2 = @opencode/cli 2.x（v2 插件 API），dsh = DeepSeek Harness（cordis 插件，desktop/web/headless 三形态）。
`);
}

/** [cmd] 只用于复现启动参数；人设正文不能整段落进终端/CI 日志。 */
function previewArgs(args) {
	const secret = new Set(["--system-prompt", "--append-system-prompt", "--system-prompt-override", "--rules"]);
	const out = [];
	for (let i = 0; i < args.length; i++) {
		const a = String(args[i]);
		if (a === "-c" && typeof args[i + 1] === "string" && args[i + 1].startsWith("developer_instructions=")) {
			out.push(a, `developer_instructions=<persona ${args[i + 1].length} 字>`);
			i++;
			continue;
		}
		if (secret.has(a) && args[i + 1] !== undefined) {
			out.push(a, `<persona ${String(args[i + 1]).length} 字>`);
			i++;
			continue;
		}
		out.push(a.includes(" ") ? JSON.stringify(a) : a);
	}
	return out;
}

function die(message) {
	console.error(message);
	process.exit(2);
}
