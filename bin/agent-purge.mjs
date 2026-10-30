#!/usr/bin/env node
// agent-purge — 一个入口，把各家 harness 的系统提示词替换收进来。
// 能力与实测数字见 matrix.json。
//
// 命令只有两类，别再分第三类：
//   选东西（写 state.json）   use / mode / install / arm / slash
//   用东西（跑起来）           <harness> / 裸敲已 arm 的命令名 / web / ls / status
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backends, oneshots } from "../backends/index.mjs";
import { resolveBin, spawnBin } from "../lib/spawn.mjs";
import { installCrashHandlers, recover } from "../lib/restore.mjs";
import { capsFor } from "../lib/caps.mjs";
import { MODES, armedOf, loadState, patchState, setArmed, setDefault } from "../lib/state.mjs";
import { ensureDataHome } from "../lib/home.mjs";

// bun --compile 产物：资源目录 = exe 所在目录；普通 node：包根
const ROOT = process.versions.bun ? dirname(process.execPath) : dirname(dirname(fileURLToPath(import.meta.url)));
// 数据（state.json + personas/）放用户目录，npm 升级不会连人设一起清掉
const DATA = ensureDataHome(ROOT).home;
const matrix = JSON.parse(readFileSync(join(ROOT, "matrix.json"), "utf8"));

const argv = process.argv.slice(2);
installCrashHandlers();
const recovered = recover(); // 上次进程被杀时留下的半改配置，开机先回滚
if (recovered > 0) console.log(`[restore] 回滚了 ${recovered} 个上次残留的配置文件`);
if (argv.includes("--help") || argv.includes("-h")) help(); // 永远优先于默认值
const flag = (name, fallback) => {
	// 支持 --mode=append 这种写法（以前只认空格分隔，等号形式会被静默忽略）
	const inline = argv.find((a) => a.startsWith(name + "="));
	if (inline !== undefined) return inline.slice(name.length + 1);
	const i = argv.indexOf(name);
	return i === -1 ? fallback : argv[i + 1];
};
let cmd = argv[0];

if (!cmd || cmd.startsWith("-")) cmd = await defaultHarness();

// ── 选东西 ────────────────────────────────────────────────────────────────
switch (cmd) {
	case "use":
		await useCmd();
		break;
	case "mode":
		modeCmd();
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
	case "status":
		statusCmd();
		break;
	case "ls":
		await lsCmd();
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
	case "web":
		webCmd();
		break;
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
	console.log(`[default] ${harness} · ${state.default.mode} · persona=${state.persona ?? "-"}（state.json）`);
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
	const mode = explicitMode ?? state.default?.mode ?? "replace";

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

	// 通道全废的家（闭源桌面 / 提示词在服务端）说清楚：这次只是原样启动，没注入任何东西
	{
		const c = capsFor(name);
		if (!c.shim.ok && !c.install.ok && !c.slash.ok && mode !== "off") {
			const why = [c.shim, c.install, c.slash].map((x) => x.why).filter(Boolean)[0];
			console.log(`[提示] ${name} 注入不进去，本次是原样启动：${why}`);
		}
	}

	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	const personaName = flag("--persona", "active");
	let pickedName = personaName === "active" ? store.activeId() : personaName;
	let picked = store.read(pickedName);
	// 指针可能指向已删的 persona：回退到第一个，不让启动器直接死
	if (!picked && personaName === "active") {
		const first = store.list()[0];
		if (first) {
			console.warn(`[warn] active 指向不存在的 persona: ${pickedName ?? "(空)"}，本次回退到 ${first.id}（agent-purge use ${first.id} 可写回指针）`);
			pickedName = first.id;
			picked = first;
		}
	}
	if (!picked) die(`没有 persona: ${pickedName}（可用: ${store.list().map((p) => p.id).join(", ")}）`);
	const personaPath = store.materialize(picked.id);
	const personaText = picked.body.trim();
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

	const askEq = argv.find((a) => a.startsWith("--ask="));
	const askIdx = argv.indexOf("--ask");
	const askPrompt = askEq !== undefined ? askEq.slice(6) : askIdx !== -1 ? argv[askIdx + 1] : null;
	let built;
	if (askPrompt !== null) {
		const raw = askPrompt;
		if (!raw || raw.startsWith("--")) die('--ask 需要一个 prompt，例如: agent-purge codex --ask "解释这段代码"');
		const prompt = raw.trim();
		const one = oneshots[name];
		if (!one) die(`${name} 没有一次性运行模式（可用: ${Object.keys(oneshots).join(", ")}）`);
		built = one({ prompt, personaPath, personaText, mode, cwd });
		if (passthrough.length) built.args = [...built.args, ...passthrough];
	} else {
		built = backends[name]?.({ personaPath, personaText, mode, args: passthrough, cwd, reason: spec.reason }) ?? {
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
	if (built.residueHint) console.log(`[residue] ${built.residueHint}`);
	const dryRun = argv.includes("--dry-run");
	// 启动时把人设塞进扩展（omp / pi）：命令行走不通 10K 人设，扩展也没有长度上限。
	// omp 交互式启动时把后端的 --system-prompt 摘掉，否则扩展和命令行会各注入一次。
	// 但 --profile / --no-extensions 下默认扩展目录不会加载：这两个情况保留命令行注入。
	const ompProfile = name === "omp" ? (flag("--profile", null) ?? process.env.OMP_PROFILE ?? null) : null;
	const ompNoExtensions = name === "omp" && (argv.includes("--no-extensions") || argv.some((a) => a.startsWith("--no-extensions=")));
	const useExtension = name !== "omp" || (askPrompt === null && !ompProfile && !ompNoExtensions);
	let extFile = null;
	if ((name === "pi" || name === "omp") && !built.unsupported && !built.manual) {
		const isOmp = name === "omp";
		if (mode === "off") {
			// 不装、也不喊注入：扩展就算在盘上，也会因为 mode=off + 没 FORCE 而沉默
			built.env = { ...built.env, AGENT_PURGE_MODE: "off" };
		} else if (useExtension) {
			if (isOmp && built.args[0] === "--system-prompt") built.args.splice(0, 2);
			if (!dryRun) {
				const { installSlash } = await import("../lib/slashes.mjs");
				const r = installSlash(name, DATA, { personaId: picked.id, personaBody: personaText });
				if (r.error) die(`${name}: ${r.error}`);
				extFile = r.file;
			}
			built.env = { ...built.env, AGENT_PURGE_PERSONA: picked.id, AGENT_PURGE_MODE: mode, AGENT_PURGE_FORCE: "1" };
		} else if (isOmp && askPrompt === null) {
			console.log("[ext] --profile/--no-extensions：本次保留命令行注入，/purge 热切不可用");
		} else if (isOmp) {
			// --ask：命令行已经注入；扩展若在盘上且 ompAuto 开着会再注一遍，这里按 off 静音
			built.env = { ...built.env, AGENT_PURGE_MODE: "off" };
		}
	}
	// off 有两种来源：全局总电源关了，或者这一轮手动指定。措辞不能混，否则看日志的人会以为总开关坏了
	if (mode === "off") {
		const globalOff = (state.default?.mode ?? "") === "off";
		console.log(
			globalOff
				? "[off] 总电源关着（state.default.mode=off）：本轮原样启动，不装扩展、不注入；要注入就先去 UI 把总开关拧开，或 --mode replace/strict/append"
				: "[off] 本轮不注入（--mode off）：原样启动；全局默认仍是 " + (state.default?.mode ?? "?") + "，想改默认用 agent-purge mode <模式>",
		);
	}
	console.log(`[cmd] ${[built.cmd, ...built.args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a))].join(" ")}`);
	if (extFile) console.log(`[ext] ${extFile}（/purge 热切换）`);
	if (dryRun) process.exit(0);

	if (!resolveBin(built.cmd)) {
		die(`${name}: 找不到可执行文件 ${built.cmd}（PATH 里没有它；agent-purge doctor 可看本机探测结果）`);
	}
	built.setup?.();
	// Ctrl-C 时也要清掉一次性插件：process.exit 会触发 exit 监听器，不依赖 child close
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		try {
			built.cleanup?.();
		} catch {}
	};
	process.once("exit", cleanup);
	// 一次性问答：stdin 直接给 NUL。否则 codex 这类会先“Reading additional input from stdin...”
	// 并阻塞到 EOF（非 TTY 环境必现）；stdin 关了它就直接跑。
	const stdio = askPrompt !== null ? ["ignore", "inherit", "inherit"] : "inherit";
	const child = spawnBin(built.cmd, built.args, { cwd, stdio, env: { ...process.env, ...built.env } });
	const finish = (code) => {
		cleanup();
		process.exit(code ?? 1);
	};
	child.on("error", (e) => {
		console.error(`${name}: ${e.message}`);
		finish(1);
	});
	child.on("close", (code) => finish(code));
}

// ── 选东西的实现 ───────────────────────────────────────────────────────────

async function useCmd() {
	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	const arg = argv[1];
	const { state, migrated } = loadState(DATA);
	migrated.forEach((m) => console.log(`[migrate] ${m}`));

	const id = arg && !arg.startsWith("-") ? arg : state.persona;
	if (!id) {
		console.log(`当前 persona: (未设置)\n可用: ${store.list().map((p) => p.id).join(", ")}`);
		return;
	}
	if (!store.read(id)) die(`没有 persona: ${id}（可用: ${store.list().map((p) => p.id).join(", ")}）`);
	store.setActive(id); // 写 active.md 快照 + state.persona 指针

	// user 层的 /purge 命令文件是烘焙进去的，换人设必须重渲染
	const { refreshSlashes } = await import("../lib/slashes.mjs");
	const refreshed = refreshSlashes(DATA, state.armed ? Object.entries(state.armed).filter(([, a]) => a.includes("slash")).map(([k]) => k) : [], {
		personaId: id,
		personaBody: store.read(id).body.trim(),
	});
	console.log(`persona ← ${id}（active.md 已同步）`);
	refreshed.forEach((f) => console.log(`[slash] 重新写入 ${f}`));
	if (Object.keys(state.armed ?? {}).length) {
		console.log("已武装的 harness 下一轮/下次启动自动跟随；落盘型（install）若想立刻同步：agent-purge install <h>");
	}
}

function modeCmd() {
	const want = argv[1];
	const { state } = loadState(DATA);
	const current = state.default?.mode ?? "replace";
	if (!want) {
		console.log(
			[
				`当前注入方式: ${current}`,
				"  strict  只发人设（宿主提示词全丢，最干净）",
				"  replace 人设在前 + 宿主提示词剔除身份句（默认，官方仍认得你）",
				"  append  人设只挂在最前，宿主原样保留（最保守）",
				"  off     不注入（受管 harness 也能干净地裸用）",
			].join("\n"),
		);
		return;
	}
	if (!MODES.includes(want)) die(`mode 只能是 ${MODES.join(" / ")}`);
	setDefault(DATA, { harness: state.default?.harness ?? "codex", mode: want });
	console.log(`mode ← ${want}（state.json；下次启动生效，--mode 可临时覆盖）`);
}

async function installCmd(verb, rest) {
	const id = rest[0];
	const ids = id === "--all" || !id ? Object.keys(matrix.harnesses).filter((h) => matrix.harnesses[h].class !== "unsupported") : [id];
	// 常驻只走 lib/persist.mjs 这一个控制面（caps / Web 开关 / status 都读它的 targets）
	const { install, uninstall, targets } = await import("../lib/persist.mjs");
	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	for (const h of ids) {
		if (!matrix.harnesses[h]) die(`未知 harness: ${h}`);
		if (!targets[h]) {
			console.log(`${h}: 没有常驻模式（用 arm 走裸命令接管 / slash 走会话内）`);
			continue;
		}
		let r;
		if (verb === "install") {
			const pid = store.activeId();
			if (!pid) die("还没有 persona：先 agent-purge use <id>");
			r = install(h, { root: DATA, active: store.refreshActive() }) ?? {};
		} else {
			// 卸载不能依赖 persona 还在：人设删了也必须能关
			r = uninstall(h) ?? {};
		}
		const ok = !r.error;
		console.log(`${ok ? "✓" : "✗"} ${verb} ${h}${r.file ? ` → ${r.file}` : ""}${r.note ? `  (${r.note})` : ""}${r.error ? `  ${r.error}` : ""}`);
		if (ok) setArmed(DATA, h, "install", verb === "install");
	}
}

async function armCmd(verb, rest) {
	const { installShim, uninstallShim, ensureUserPath } = await import("../lib/shim.mjs");
	const { installSlash, uninstallSlash } = await import("../lib/slashes.mjs");
	const { install, uninstall } = await import("../lib/persist.mjs");
	const { capsFor } = await import("../lib/caps.mjs");
	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	const pid = store.activeId();
	if (!pid) die("还没有 persona：先 agent-purge use <id>");

	const supported = Object.keys(matrix.harnesses).filter((h) => matrix.harnesses[h].class !== "unsupported");
	const namedTarget = rest.filter((x) => !x.startsWith("-"));
	// 点了名的只动那家：`--all` 只管总电源，不再悄悄把别的 harness 一起撤（issue #5）
	const targets = namedTarget.length ? namedTarget : supported;

	// 全局 --all 就是总电源：撤的时候必须把 default.mode 置 off，
	// 否则 `agent-purge <h>` 这条入口照样注入（实测：关了总开关还能接管，就是这里漏的）。
	// 开的时候把上次的 mode 还回去。单家操作不动 mode。
	// 没设过默认 harness 时也要能关：launch() 在 default 为空时会回落成 replace。
	if (rest.includes("--all")) {
		const { state: cur } = loadState(DATA);
		const m = cur.default?.mode ?? null; // null = 从没设过，launch() 会回落成 replace
		const h = cur.default?.harness ?? null;
		if (verb === "disarm" && m !== "off") {
			patchState(DATA, { default: { harness: h, mode: "off" }, prevMode: m ?? "replace" });
			console.log(`总电源：mode ${m ?? "(未设，实际按 replace)"} → off（裸敲 agent-purge / agent-purge <h> 都不再注入；arm --all 还回去）`);
		}
		if (verb === "arm" && cur.default && m === "off") {
			const back = MODES.includes(cur.prevMode) && cur.prevMode !== "off" ? cur.prevMode : "replace";
			patchState(DATA, { default: { harness: h, mode: back } });
			console.log(`总电源：mode off → ${back}`);
		}
	}

	// 通道默认全开（常驻 + 裸命令接管 + /purge）；只想做其中一个就显式点名
	const named = ["--install", "--shim", "--slash"].filter((f) => rest.includes(f));
	const channels = named.length ? named.map((f) => f.slice(2)) : ["install", "shim", "slash"];
	let armedAny = 0;

	for (const h of targets) {
		if (!matrix.harnesses[h]) die(`未知 harness: ${h}`);
		const done = [];
		const skip = [];

		for (const ch of channels) {
			// 先过能力表：这家形态上做不到的通道（如 zcode 桌面 + shim），不写文件，直接说明原因
			if (verb === "arm") {
				const cap = capsFor(h)[ch];
				if (cap && !cap.ok) {
					skip.push(`${ch}: ${cap.why}`);
					continue;
				}
			}
			if (ch === "install") {
				const r = verb === "arm" ? install(h, { root: DATA, active: store.refreshActive() }) : uninstall(h);
				if (r.error) skip.push(`常驻: ${r.error}`);
				else {
					setArmed(DATA, h, "install", verb === "arm");
					done.push(verb === "arm" ? `常驻 ${r.action}` : `撤常驻 ${r.action}`);
				}
			}
			if (ch === "shim") {
				const r = verb === "arm" ? installShim(DATA, h) : uninstallShim(DATA, h);
				if (r.error) skip.push(`shim: ${r.error}`);
				else {
					setArmed(DATA, h, "shim", verb === "arm");
					done.push(verb === "arm" ? "裸命令接管" : "撤裸命令接管");
				}
			}
			if (ch === "slash") {
				const r =
					verb === "arm"
						? installSlash(h, DATA, { personaId: pid, personaBody: store.read(pid).body.trim() })
						: uninstallSlash(h, DATA);
				if (r.error) skip.push(`/purge: ${r.error}`);
				else {
					setArmed(DATA, h, "slash", verb === "arm");
					done.push(verb === "arm" ? `/purge ${r.layer} 层` : "撤 /purge");
				}
			}
		}
		const icon = done.length ? "✓" : "·";
		if (done.length) armedAny += 1;
		console.log(`${icon} ${verb} ${h.padEnd(11)} ${done.join(" · ") || "无可用通道"}${skip.length ? "  跳过: " + skip.join("；") : ""}`);
	}

	if (verb === "arm" && armedAny && channels.includes("shim")) {
		const r = ensureUserPath();
		console.log(r.changed ? `[path] ${r.dir} → 用户 PATH 最前（${r.how}）` : `[path] ${r.dir} 就位（${r.how}）`);
	}
	if (verb === "arm") {
		if (!armedAny) {
			console.log(`\n一个通道都没装上（${targets.join(", ")}）：上面“跳过”里写了每家为什么不行。`);
		} else {
			const h0 = targets[0];
			const lines = [];
			if (channels.includes("shim")) lines.push(`新开终端敲 ${h0} → 走 PATH 前置壳，注入生效`);
			if (channels.includes("slash")) {
				lines.push(
					h0 === "pi"
						? "裸敲 pi 不注入（只装了热切）；会话里打 /purge on 才改写，/purge status 看状态"
						: h0 === "dsh"
							? "dsh 会话里打 /purge 切开关（改 state.json，不产生模型消息）；三形态共用一份状态"
							: "会话里打 /purge 才注入（它展开成用户消息）",
				);
			}
			if (channels.includes("install")) lines.push("改了配置文件：连别人启动的、GUI 里点开的也生效（那家重启后生效）");
			console.log("\n下一步：\n" + lines.map((l) => "  - " + l).join("\n") + "\n复核：agent-purge status");
		}
	}
}

async function slashCmd(rest) {
	const { installSlash, uninstallSlash, slashStatus } = await import("../lib/slashes.mjs");
	const { createStore } = await import("../lib/personas.mjs");
	const store = createStore(DATA);
	const id = rest[0];
	if (!id || id === "status") {
		const rows = slashStatus(DATA);
		const live = rows.filter((s) => s.offered);
		live.forEach((s) => {
			console.log(`${s.installed ? "✓" : " "} ${s.id.padEnd(9)} ${s.layer.padEnd(4)} ${s.trigger.padEnd(22)} persona=${s.personaId ?? "-"}`);
			console.log(`   ${s.note}`);
		});
		// 只列“能把内容写进 system 数组”的；user 层不要再诱人点
		const dead = rows.filter((s) => !s.offered);
		if (dead.length) {
			const still = dead.filter((s) => s.installed).map((s) => s.id);
			console.log(`\n已下线（user 层，压不住系统提示词）：${dead.map((s) => s.id).join(", ")}`);
			if (still.length) console.log(`旧文件还在盘上：agent-purge slash off ${still.join(" ")}`);
		}
		return;
	}
	if (id === "off") {
		const target = rest[1];
		const ids =
			target && target !== "--all"
				? rest.slice(1).filter((x) => !x.startsWith("-"))
				: slashStatus(DATA).filter((s) => s.installed).map((s) => s.id);
		if (!ids.length) console.log("没有装着的 /purge");
		ids.forEach((h) => {
			const r = uninstallSlash(h, DATA);
			if (!r.error) {
				setArmed(DATA, h, "slash", false);
				console.log(`✓ 已移除 /purge ${h}${r.removed?.length ? " → " + r.removed.join(", ") : "（本来就没有）"}`);
			}
		});
		return;
	}
	const targets = id === "--all" ? slashStatus(DATA).filter((s) => s.offered).map((s) => s.id) : [id];
	const pid = store.activeId();
	if (!pid) die("还没有 persona：先 agent-purge use <id>");
	for (const h of targets) {
		const r = installSlash(h, DATA, { personaId: pid, personaBody: store.read(pid).body.trim() });
		if (r.error) {
			console.log(`- ${h}: ${r.error}`);
			continue;
		}
		setArmed(DATA, h, "slash", true);
		console.log(`✓ /purge → ${h}（${r.layer} 层）${r.file}`);
		console.log(`   ${r.note}`);
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

function webCmd() {
	const port = Number(flag("--port", "7788"));
	// --detach：脱离当前终端后台存活，日志丢弃
	if (argv.includes("--detach")) {
		const child = spawn(process.execPath, [join(ROOT, "web", "server.mjs"), "--serve", String(port)], {
			detached: true,
			stdio: "ignore",
			shell: false,
			env: { ...process.env, AGENT_PURGE_HOME: DATA },
		});
		child.unref();
		console.log(`agent-purge web 已在后台启动 → http://127.0.0.1:${port}（pid ${child.pid}）`);
		process.exit(0);
	}
	return import("../web/server.mjs").then(({ serveWeb }) => serveWeb(port));
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

① 选（写 state.json，全工具共用，改完立刻生效）
   agent-purge use <id>           换 persona（ls 看有哪些，* = 当前）
   agent-purge mode <m>           strict(只发人设) / replace(默认) / append / off
   agent-purge web                浏览器里点选 harness · persona · mode

② 用（三种入口，效果一样）
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

   注：--all 是总电源（state.json 的 default.mode）。带 <h> 时只撤那家，
       但同样把总电源关掉——不然裸敲 agent-purge、agent-purge <h> 照样注入。
       彻底别管我：agent-purge disarm --all

④ 看
   agent-purge status             一张表：每家的 shim / slash / install / 能做什么
   agent-purge ls                 persona 列表
   agent-purge matrix             能力矩阵（matrix.json）
   agent-purge armor [...]        plan|preflight|run|judge 实测热力图
   agent-purge doctor             本机探测（哪家装了、版本）

通道语义
   shim     在 PATH 最前放同名 cmd，裸敲即经 agent-purge 启动（sys 层注入）
   install  改 harness 自己的配置/插件文件（连别人启动的它也会带人设）
slash    会话里打 /purge 换提示词：**pi 和 dsh 都能做**（pi 的扩展钩子 / dsh 的 cordis 插件，真 sys 层、热切换）
其他家没有这个能力：/purge 展开成用户消息，bench 实测 0/2 无效，所以不提供
   注入强度：只有 sys 层算。user 层（上下文块/用户消息）在 codex/claude/opencode/grok/hermes 实测都是 0/2，一律不提供。

harness: pi, opencode, opencode2, dsh, codex, claude, grok, omp, hermes, zcode, antigravity, qoder, workbuddy, codebuddy
          opencode2 = @opencode/cli 2.x（v2 插件 API），dsh = DeepSeek Harness（cordis 插件，desktop/web/headless 三形态）。
         qoder / workbuddy 无 prompt 组装入口（提示词在服务端），只能改上下文规则文件。
`);
}

function die(message) {
	console.error(message);
	process.exit(2);
}
