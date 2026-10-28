// 零依赖 Web 服务：配置台。选默认 harness/mode、管理 persona、常驻安装、探测。
// 刻意不做"运行"：交互式 harness 属于终端/桌面，Web 只负责选（见 ARCHITECTURE.md）。
import { createServer } from "node:http";import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detect } from "../lib/detect.mjs";
import { oneshots } from "../backends/index.mjs";
import { createStore } from "../lib/personas.mjs";
import { MODES, armedOf, dshProfilesOf, loadState, patchState, setArmed, setDefault, setPersona, setPiAuto, setOmpAuto, setDshProfile } from "../lib/state.mjs";
import { install, status as persistStatus, uninstall } from "../lib/persist.mjs";
import { plans, summary as armorSummary } from "../lib/armor.mjs";
import { installShim, shimStatus, uninstallShim } from "../lib/shim.mjs";
import { installSlash, refreshSlashes, slashStatus, uninstallSlash } from "../lib/slashes.mjs";
import { reconcileArmed } from "../lib/armed.mjs";
import { capsFor } from "../lib/caps.mjs";
import { ensureDataHome } from "../lib/home.mjs";
import { DSH_PROFILES } from "../lib/dsh.mjs";

const ROOT = process.versions.bun ? dirname(process.execPath) : dirname(dirname(fileURLToPath(import.meta.url)));
// 数据（state.json + personas/）在用户目录，不在安装目录
const DATA = ensureDataHome(ROOT).home;
// 运行期真正被改写的层（≠ bench 能测到的层）：每家只有它自己暴露的那一个写入点。
// sys = 系统提示/配置文件/插件 splice；user = 只落在用户消息里（zcode 的 hook）。
const LAYER = {
	pi: "sys", codex: "sys", codebuddy: "sys", claude: "sys", grok: "sys",
	omp: "sys", opencode: "sys", hermes: "sys", antigravity: "sys",
	// zcode 只有文档说它会读 AGENTS.md，桌面版闭源、无法复核，层就不claim（UI 显示“—”+「文档」）
	zcode: "",
};
const matrix = JSON.parse(readFileSync(join(ROOT, "matrix.json"), "utf8"));
const store = createStore(DATA);

export function serveWeb(port = 7788) {
	// handle 是 async：任何异常都在这里收口，否则请求会挂着不响应
	const server = createServer((req, res) => {
		handle(req, res).catch((e) => {
			try {
				send(res, 500, { error: `服务端错误: ${e.message}` });
			} catch {}
		});
	});
	server.on("error", (e) => {
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
		console.log(`agent-purge web → http://127.0.0.1:${port}`);
	});
}

async function handle(req, res) {
	const url = new URL(req.url, "http://127.0.0.1");
	const p = url.pathname;

	// 防 CSRF：本机 Web 页面能 POST 就能写配置/改人设；跨站页面用 text/plain 也能发“简单请求”。
	// 只放同源：Origin 的 host 必须和本次请求的 Host 完全一致（端口不同也挡住）。
	if (isMutating(req.method) && !sameOrigin(req)) return send(res, 403, { error: "只接受本机同源请求" });

	if (req.method === "GET" && (p === "/" || p === "/index.html")) return html(res);
	if (req.method === "GET" && p === "/api/state") return send(res, 200, await state(url.searchParams.get("versions") === "1"));
	if (req.method === "GET" && p === "/api/armor") return send(res, 200, armorState());
	if (req.method === "POST" && p === "/api/defaults") return send(res, 200, saveDefaults(await body(req)));
	if (req.method === "POST" && p === "/api/pi-auto") return send(res, 200, { piAuto: setPiAuto(DATA, (await body(req)).on === true) });
	if (req.method === "POST" && p === "/api/omp-auto") return send(res, 200, { ompAuto: setOmpAuto(DATA, (await body(req)).on === true) });
	if (req.method === "POST" && p === "/api/dsh-profile") return send(res, 200, saveDshProfile(await body(req)));
	if (req.method === "POST" && p === "/api/persona") return send(res, 200, savePersona(await body(req)));
	if (req.method === "DELETE" && p === "/api/persona") return send(res, 200, deletePersona(url.searchParams.get("id")));
	if (req.method === "POST" && p === "/api/use") return send(res, 200, usePersona(await body(req)));
	if (req.method === "POST" && p === "/api/install") return send(res, 200, applyInstall(await body(req)));
	if (req.method === "POST" && p === "/api/arm") return send(res, 200, applyArm(await body(req)));
	if (req.method === "POST" && p === "/api/arm-all") return send(res, 200, applyArmAll(await body(req)));
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
	const harnesses = Object.entries(matrix.harnesses).map(([id, m]) => {
		const d = found[id] ?? {};
		const inst = persisted.find((x) => x.name === id);
		const armed = armedOf(st, id);
		return {
			id,
			class: m.class,
			override: m.override === true ? "yes" : m.override ? String(m.override) : "no",
			inject: Boolean(m.inject),
			hotSwitch: Boolean(m.hotSwitch),
			chars: m.defaultSystemChars != null ? `${m.defaultSystemChars} → ${m.purgedSystemChars ?? "?"}` : null,
			version: d.version ?? m.measuredVersion ?? null,
			residue: m.residue ?? null,
			reason: m.reason ?? null,
			supported: m.class !== "unsupported",
			oneshot: Boolean(oneshots[id]),
			layer: LAYER[id] ?? (m.class === "unsupported" ? null : "sys"),
			found: Boolean(d.found),
			bin: d.bin ?? null,
			home: d.home ?? null,
			homeExists: Boolean(d.homeExists),
			persistable: Boolean(inst),
			installed: Boolean(inst?.installed),
			persistFile: inst?.file ?? null,
			armed,
			shim: Boolean(shims.find((s) => s.id === id)?.installed),
			slash: slashes.find((s) => s.id === id) ?? null,
			// 每条通道「能不能用 + 为什么不能用」由 lib/caps.mjs 统一裁决：
			// UI 只负责画，不再自己猜（以前 shim 硬编码可点，zcode 点了必然无效）
			caps: capsFor(id, { bin: d.bin ?? null }),
		};
	});
	const defaults = defaultsOf(st, harnesses);
	return {
		harnesses,
		reconciled,
		personas: store.list().map((x) => ({ id: x.id, meta: x.meta, body: x.body, chars: x.body.trim().length })),
		active: store.activeId(),
		persona: st.persona,
		defaults,
		// false = state.json 里还没有默认（defaults 只是 UI 的建议值，裸敲 agent-purge 仍会提示“未设置”）
		defaultsSet: Boolean(st.default?.harness),
		armed: st.armed ?? {},
		// dsh 的三个 profile（desktop/web/headless）；null 就是全开
		dshProfiles: dshProfilesOf(st) ?? DSH_PROFILES,
		dshAll: DSH_PROFILES,
		modes: MODES,
		piAuto: st.piAuto === true,
		ompAuto: st.ompAuto === true,
		shimDir: shimStatus()[0]?.dir ?? null,
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

function saveDefaults(payload) {
	const { harness, mode } = payload;
	const spec = matrix.harnesses[harness];
	if (!spec) return { error: `未知 harness: ${harness}` };
	if (spec.class === "unsupported") return { error: `${harness} 做不到：${spec.reason}` };
	if (mode && !MODES.includes(mode)) return { error: `mode 只能是 ${MODES.join(" / ")}` };
	try {
		return { ok: true, defaults: setDefault(DATA, { harness, mode: mode ?? "replace" }) };
	} catch (e) {
		return { error: e.message };
	}
}

function saveDshProfile(payload) {
	const profile = String(payload.profile || "").trim();
	if (!DSH_PROFILES.includes(profile)) return { error: `未知 profile: ${profile}（${DSH_PROFILES.join(" / ")}）` };
	try {
		return { ok: true, dshProfiles: setDshProfile(DATA, profile, payload.on === true, DSH_PROFILES) };
	} catch (e) {
		return { error: e.message };
	}
}

function savePersona(payload) {
	const id = String(payload.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
	if (!id) return { error: "id 不能为空（小写字母/数字/-/_）" };
	if (!payload.body?.trim()) return { error: "正文不能为空" };
	try {
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
		const saved = store.save(id, { meta: { ...meta, id }, body: payload.body });
		return { ok: true, persona: { id: saved.id, meta: saved.meta, body: saved.body } };
	} catch (e) {
		return { error: e.message };
	}
}

function deletePersona(id) {
	if (!id) return { error: "缺少 id" };
	if (store.list().length <= 1) return { error: "至少保留一个 persona" };
	if (!store.read(id)) return { error: "找不到这个 persona" };
	if (!store.remove(id)) return { error: "非法 persona id" };
	return { ok: true, active: store.activeId() };
}

function usePersona(payload) {
	if (!payload.id) return { error: "缺少 id" };
	try {
		store.setActive(payload.id);
		// 两个指针必须一起写，否则 UI 选的“当前人设”和 `agent-purge` 实际用的不是同一个
		setPersona(DATA, payload.id);
		const { state: st } = loadState(DATA);
		const slashTargets = Object.entries(st.armed ?? {})
			.filter(([, a]) => a.includes("slash"))
			.map(([k]) => k);
		const refreshed = refreshSlashes(DATA, slashTargets, { personaId: payload.id, personaBody: store.read(payload.id).body.trim() });
		return { ok: true, active: payload.id, refreshed };
	} catch (e) {
		return { error: e.message };
	}
}

/** 全局总开关：所有 harness × 选定通道一次折腾完（= `agent-purge 注册 --all` / `disarm --all`）*/
function applyArmAll(payload) {
	if (!payload.action) return { error: "缺少 action" };
	const { action } = payload;
	const channel = payload.channel ?? "all";
	const verb = verbOf(action);

	// 全局总闸 = 电源，不只是注册表：撤的时候把 default.mode 置 off（记下 prevMode），
	// 否则 `agent-purge <h>` 这条入口永远注入 —— 用户实测“关了也能直接接管”就出在这。
	// 开的时候把上次的 mode 还回去。
	const { state: cur } = loadState(DATA);
	const m = cur.default?.mode ?? "off";
	if (verb === "off" && m !== "off" && cur.default?.harness) {
		setDefault(DATA, { harness: cur.default.harness, mode: "off" });
		patchState(DATA, { prevMode: m });
	}
	if (verb === "on" && m === "off" && cur.default?.harness) {
		const back = MODES.includes(cur.prevMode) && cur.prevMode !== "off" ? cur.prevMode : "replace";
		setDefault(DATA, { harness: cur.default.harness, mode: back });
	}

	const perHarness = [];
	const failed = [];
	for (const [h, spec] of Object.entries(matrix.harnesses)) {
		if (spec.class === "unsupported") {
			failed.push(`${h}: 做不到（${spec.reason}）`);
			continue;
		}
		const r = applyArm({ harness: h, channel, action: verb, persona: payload.persona });
		if (r.error) failed.push(`${h}: ${r.error}`);
		else perHarness.push({ harness: h, done: (r.done ?? []).map((d) => d.channel), skipped: r.skipped ?? [] });
	}
	if (!perHarness.length) return { error: failed.join("；") || "没有可注册的 harness" };
	const after = loadState(DATA).state.default;
	return { ok: true, action: verb, channel, mode: after?.mode ?? null, harnesses: perHarness, failed };
}

function applyInstall(payload) {
	const { harness, action } = payload;
	if (action === "uninstall") {
		const r = uninstall(harness);
		setArmed(DATA, harness, "install", false);
		return { ok: true, result: r };
	}
	// 装谁就把谁设为 active：active.md 与 install 指向始终是同一份正文
	const wanted = payload.persona ?? store.activeId();
	if (!store.read(wanted)) return { error: "没有可用 persona" };
	store.setActive(wanted);
	const r = install(harness, { root: DATA, active: store.refreshActive() });
	if (r.error) return { error: r.error };
	setArmed(DATA, harness, "install", true);
	return { ok: true, result: r };
}

/** UI 传 install/uninstall、CLI 传 on/off —— 统一成 on/off，否则 uninstall 会被当成安装 */
const VERB_OFF = new Set(["off", "uninstall", "remove", "stop", "false", false, 0]);
function verbOf(action) {
	return VERB_OFF.has(action) ? "off" : "on";
}

/** 裸命令接管（shim）、/purge（slash）、常驻（install）：Web 上一个开关全部搞定 */
function applyArm(payload) {
	if (!payload.action) return { error: "缺少 action" };
	const { harness, channel, action } = payload;
	const id = payload.persona ?? store.activeId();
	if (!store.read(id)) return { error: "没有可用 persona" };
	const verb = verbOf(action);
	const channels = !channel || channel === "all" ? ["install", "shim", "slash"] : [channel];
	const done = [];
	const skipped = [];
	for (const ch of channels) {
		const r = armChannel(harness, ch, verb, id);
		if (r.error) skipped.push(`${ch}: ${r.error}`);
		else done.push({ channel: ch, ...r });
	}
	if (!done.length) return { error: skipped.join("；") || "没有可用通道" };
	return { ok: true, harness, action: verb, done, skipped };
}

function armChannel(harness, channel, verb, id) {
	// 开之前先问能力表：这条通道在这家身上本来就无效的，不写任何文件、直接说明原因
	if (verb === "on") {
		const cap = capsFor(harness)[channel];
		if (cap && !cap.ok) return { error: cap.why };
	}
	if (channel === "install") {
		const r = verb === "off" ? applyInstall({ harness, action: "uninstall" }) : applyInstall({ harness, action: "install", persona: id });
		return r.error ? { error: r.error } : (r.result ?? { ok: true });
	}
	if (channel === "shim") {
		if (verb === "off") {
			const r = uninstallShim(DATA, harness);
			if (r.error) return { error: r.error };
			setArmed(DATA, harness, "shim", false);
			return { removed: r.removed };
		}
		const r = installShim(DATA, harness);
		if (r.error) return { error: r.error };
		setArmed(DATA, harness, "shim", true);
		return { file: r.file, real: r.real };
	}
	if (channel === "slash") {
		if (verb === "off") {
			const r = uninstallSlash(harness, DATA);
			if (r.error) return { error: r.error };
			setArmed(DATA, harness, "slash", false);
			return { removed: r.removed };
		}
		const r = installSlash(harness, DATA, { personaId: id, personaBody: store.read(id).body.trim() });
		if (r.error) return { error: r.error };
		setArmed(DATA, harness, "slash", true);
		return { file: r.file, layer: r.layer };
	}
	return { error: `未知通道: ${channel}` };
}

const send = (res, code, obj) =>
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(obj));
const html = (res) =>
	res
		.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
		.end(readFileSync(join(ROOT, "web", "ui.html"), "utf8"));

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
		return loopback && u.host.toLowerCase() === String(req.headers.host ?? "").toLowerCase();
	} catch {
		return false;
	}
}

function body(req) {
	return new Promise((resolve) => {
		let raw = "";
		let size = 0;
		let done = false;
		const finish = (value) => {
			if (done) return;
			done = true;
			resolve(value);
		};
		req.on("data", (c) => {
			size += c.length;
			// 本机也不该接无上限的 body：一个坏页面能靠大 POST 把内存吃光
			if (size > 2 * 1024 * 1024) {
				req.destroy();
				return finish({});
			}
			raw += c;
		});
		req.on("end", () => {
			try {
				finish(JSON.parse(raw || "{}"));
			} catch {
				finish({});
			}
		});
	});
}

// 只有被直接当脚本跑（node web/server.mjs --serve 7788）才自启动；
// 被 bin 导入时必须保持安静——否则 `agent-purge web --serve 7789` 会两个端口各起一个实例，
// 并在第二个 bind 时吐出误导性的“端口已被占用：老实例还在跑”。
const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry && process.argv.includes("--serve")) serveWeb(Number(process.argv[process.argv.indexOf("--serve") + 1] ?? 7788));
