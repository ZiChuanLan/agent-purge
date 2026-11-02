// CLI 与 Web 的唯一应用入口。配置已写入 ≠ 已被正在运行的 harness 读取。
import { createHash, randomUUID } from "node:crypto";
import { withControlLock } from "./control.mjs";
import { join } from "node:path";
import { createStore } from "./personas.mjs";
import { ARMS, MODES, loadState, patchState, resolveFor, resolveActivation, setArmed, setOverride } from "./state.mjs";
import { install, uninstall, status as installStatus } from "./persist.mjs";
import { installSlash, uninstallSlash } from "./slashes.mjs";
import { installShim, uninstallShim } from "./shim.mjs";
import { projectDirectories, projectFilePath, projectInstall, projectUninstall } from "./project.mjs";
import { liveProfiles } from "./dsh.mjs";
import { capsFor } from "./caps.mjs";
import { verifiedHarnesses } from "./verification.mjs";
import { readResource } from "./root.mjs";
const HARNESS_IDS = (() => {
	try { return new Set(Object.keys(JSON.parse(readResource("matrix.json").toString("utf8")).harnesses)); }
	catch (error) { throw new Error(`执行器清单读取失败：${error.message}`, { cause: error }); }
})();

const DYNAMIC = new Set(["dsh", "opencode", "opencode2"]);

const exclusive = withControlLock;

export function effectFor(harness, channel, mode) {
	if (channel === "shim") return { when: "next-launch", message: "新启动的命令生效；已运行会话不变" };
	if (channel === "slash") return { when: "next-turn", message: "已加载扩展下一轮读取；首次安装需重启，手动通道需 /purge on" };
	if (channel === "project") return { when: "next-session", message: "已处理所选项目的规则文件；对应目录里新开的会话读取" };
	if (DYNAMIC.has(harness)) return { when: "next-turn", message: "已加载插件下一轮读取；首次安装/更新插件代码需重启" };
	return { when: "next-session", message: mode === "off" ? "静态内容已撤下；已启动会话需重开" : "配置已写入；新会话读取" };
}

function attempt(harness, channel, mode, work) {
	try {
		const result = work() ?? {};
		if (result.error) throw new Error(result.error);
		return { harness, channel, status: "written", runtimeConfirmed: false, ...effectFor(harness, channel, mode), ...result };
	} catch (e) {
		return { harness, channel, status: "failed", runtimeConfirmed: false, error: e.message };
	}
}

function sync(root, options = {}) {
	const store = createStore(root);
	const { state: before } = loadState(root);
	if (options.mode !== undefined && !MODES.includes(options.mode)) throw new Error(`未知模式: ${options.mode}`);
	const persona = options.persona ?? store.activeId();
	let mode = options.mode ?? before.default?.mode ?? "replace";
	if (options.enabled === false) mode = "off";
	if (before.default?.mode === "off" && options.enabled !== true && mode !== "off") mode = "off";
	if (options.enabled === true && mode === "off") mode = MODES.includes(before.prevMode) && before.prevMode !== "off" ? before.prevMode : "replace";
	const picked = store.read(persona);
	if (!picked && mode !== "off") throw new Error("没有可用人设，无法应用");
	if (options.persona !== undefined && !picked) throw new Error(`没有人设: ${options.persona}`);
	if (options.resumeMode !== undefined && !["strict", "replace", "append"].includes(options.resumeMode)) throw new Error(`未知恢复模式: ${options.resumeMode}`);
	const prevMode = options.resumeMode ?? (mode === "off" && options.mode && options.mode !== "off" ? options.mode : null) ?? (mode === "off" && before.default?.mode !== "off" ? before.default?.mode ?? "replace" : before.prevMode);
	// 先发布 off，确保静态清理有一项失败时，动态通道仍然停止。
	patchState(root, { default: { harness: options.harness !== undefined ? options.harness : before.default?.harness ?? null, mode }, prevMode });
	if (picked) store.setActive(picked.id);
	const active = join(root, "personas", "active.md");
	const revision = createHash("sha256").update(JSON.stringify([picked?.id ?? null, picked?.body.trim() ?? "", mode])).digest("hex").slice(0, 16);
	const paused = new Set(before.pausedInstalls ?? []);
	const selected = before.armed ?? {};
	// 每家生效值 = 全局默认 + 该家例外（例外存在 state.json.overrides，运行时插件读同一份）
	const view = {
		...before,
		persona: picked?.id ?? before.persona,
		default: { harness: options.harness !== undefined ? options.harness : before.default?.harness ?? null, mode },
	};
	const forHarness = (harness) => {
		const eff = resolveFor(view, harness);
		const who = store.read(eff.persona) ?? (eff.personaFrom === "override" ? null : picked);
		return {
			persona: who ?? null,
			active: who && picked && who.id !== picked.id ? store.materialize(who.id) : active,
			// 暂停是总开关：全局 off 压过任何例外
			mode: resolveActivation(view, harness, { launch: true }).mode,
		};
	};
	const failures = options.onlyFailed ? (before.lastApply?.results ?? []).filter(r => r.status === "failed") : null;
	const retry = failures ? new Set(failures.map(r => `${r.harness}:${r.channel}`)) : null;
	const results = [];
	for (const [harness, channels] of Object.entries(selected)) {
		if (!Array.isArray(channels)) continue;
		for (const channel of channels) {
			if (retry && !retry.has(`${harness}:${channel}`)) continue;
			const h = forHarness(harness);
			if (channel === "project") {
				const dirs = projectDirectories(root, harness);
				if (!dirs.length) {
					results.push({ ...attempt(harness, channel, h.mode, () => ({ error: "没有已登记的项目目录，请重新启用项目通道并指定目录" })), persona: h.persona?.id ?? null, mode: h.mode });
				}
				for (const dir of dirs) {
					const file = projectFilePath(harness, dir);
					if (failures && !failures.some(r => r.harness === harness && r.channel === channel && (!r.file || r.file === file))) continue;
					const r = attempt(harness, channel, h.mode, () => h.mode === "off"
						? projectUninstall(harness, { root, dir, keepSelection: true })
						: projectInstall(harness, { root, dir, active: String(h.persona?.body ?? "").trim() }));
					results.push({ file, ...r, persona: h.persona?.id ?? null, mode: h.mode });
				}
				continue;
			}
			const r = attempt(harness, channel, h.mode, () => {
				if (channel === "install") {
					if (h.mode === "off" && !DYNAMIC.has(harness)) {
						const r = uninstall(harness, { root });
						if (!r.error) paused.add(harness);
						return r;
					}
					if (h.mode === "off") return { action: "disabled-by-state" };
					const r = install(harness, { root, active: h.active, mode: h.mode });
					if (!r.error) paused.delete(harness);
					return r;
				}
				if (channel === "slash") {
					if (h.mode === "off") return { action: "disabled-by-state" };
					return installSlash(harness, root, { personaId: h.persona?.id, personaBody: String(h.persona?.body ?? "").trim() });
				}

				if (channel === "shim") return { action: "reads-on-launch" };
				return { error: `未知通道: ${channel}` };
			});
			results.push({ ...r, persona: h.persona?.id ?? null, mode: h.mode });
		}
	}
	// 旧版本可能写了静态文件却漏 armed。off 也清理这些已识别的托管块，但不扩大恢复范围。
	if (mode === "off" && !retry) {
		for (const row of installStatus(root)) {
			if (!row.installed || DYNAMIC.has(row.name) || selected[row.name]?.includes("install")) continue;
			results.push(attempt(row.name, "install", mode, () => uninstall(row.name, { root })));
		}
	}
	// runtimeConfirmed 不是写死在代码里的常量：只有本机实测抓包证明人设进了特权层才算确认。
	const verified = verifiedHarnesses(root);
	for (const r of results) { r.historicalCapabilityVerified = verified.has(r.harness); r.runtimeConfirmed = false; }
	const failed = results.filter(r => r.status === "failed");
	const report = { id: randomUUID(), at: new Date().toISOString(), revision, persona: picked?.id ?? null, mode,
		ok: failed.length === 0, partial: failed.length > 0 && results.some(r => r.status !== "failed"), results,
		runtimeConfirmed: results.some(r => r.runtimeConfirmed) };
	patchState(root, { pausedInstalls: [...paused].filter(h => selected[h]?.includes("install")), lastApply: report });
	return report;
}

export function applyConfiguration(root, options = {}) {
	return exclusive(root, () => sync(root, options));
}

/** 安装范围与电源分开：暂停时增加静态通道仅记选择，不写入人设；卸载不要求人设存在。 */
export function changeChannel(root, { harness, channel, enabled, force = false, dir }) {
	return exclusive(root, () => {
		if (!ARMS.includes(channel)) throw new Error(`未知通道: ${channel}`);
		if (!HARNESS_IDS.has(harness)) throw new Error(`未知执行器: ${harness}`);
		if (typeof enabled !== "boolean") throw new Error("enabled 必须是布尔值");
		const { state } = loadState(root);
		// 通道路径也走同一套解析：被例外指定了其他人设/模式的那家，写进去的必须是它的值
		const eff = resolveFor(state, harness);
		const mode = resolveActivation(enabled ? { ...state, disabledHarnesses: (state.disabledHarnesses ?? []).filter(id => id !== harness) } : state, harness, { launch: true }).mode;
		if (!enabled && !(state.armed?.[harness] ?? []).some(c => c !== channel)
			&& !(channel === "project" && dir !== undefined && projectDirectories(root, harness).length > 1)) {
			patchState(root, { disabledHarnesses: [...new Set([...(state.disabledHarnesses ?? []), harness])] });
		}
		// 不指定目录的撤销用于关闭整个执行器/clean；指定目录时只撤这一处。
		if (channel === "project" && !enabled && dir === undefined) {
			const results = projectDirectories(root, harness).map(dir => ({
				file: projectFilePath(harness, dir),
				...attempt(harness, channel, mode, () => projectUninstall(harness, { root, dir })),
			}));
			setArmed(root, harness, channel, projectDirectories(root, harness).length > 0);
			const failed = results.filter(r => r.status === "failed");
			return { harness, channel, ...effectFor(harness, channel, mode), ok: !failed.length,
				status: failed.length ? "failed" : "written", runtimeConfirmed: false, results,
				...(failed.length ? { error: failed.map(r => `${r.file}: ${r.error}`).join("；") } : {}),
			};
		}
		// dsh slash 依赖 install 常驻插件改写系统提示词：开启 slash 时若未装 install，自动级联安装
		if (harness === "dsh" && channel === "slash" && enabled && !(state.armed?.dsh ?? []).includes("install")) {
			const store = createStore(root);
			const picked = store.read(eff.persona) ?? (eff.personaFrom === "override" ? null : store.read(store.activeId()));
			if (picked) {
				const activePath = store.activeId() && picked.id !== store.activeId() ? store.materialize(picked.id) : store.refreshActive();
				const installResult = attempt(harness, "install", mode, () => install(harness, { root, active: activePath, mode }));
				if (installResult.status === "failed") {
					return { ok: false, ...installResult, error: `级联安装常驻配置失败: ${installResult.error}` };
				}
				setArmed(root, harness, "install", true);
			}
		}
		// dsh 卸载常驻配置时，若会话命令插件仍在，自动一并撤销，避免留下无效的孤儿命令插件
		if (harness === "dsh" && channel === "install" && !enabled && (state.armed?.dsh ?? []).includes("slash")) {
			attempt(harness, "slash", mode, () => uninstallSlash(harness, root));
			setArmed(root, harness, "slash", false);
		}
		const result = attempt(harness, channel, mode, () => {
			if (enabled && !force) {
				const cap = capsFor(harness)[channel];
				if (!cap?.ok) return { error: cap?.why ?? "不支持该通道" };
			}
			if (!enabled) {
				if (channel === "install") return uninstall(harness, { root });
				if (channel === "slash") return uninstallSlash(harness, root);
				if (channel === "project") return projectUninstall(harness, { dir, root });
				return uninstallShim(root, harness);
			}
			if (channel === "shim") return installShim(root, harness);
			if (channel === "install" && mode === "off" && !DYNAMIC.has(harness)) return { action: "selected-while-paused" };
			if (channel === "project" && mode === "off") return projectInstall(harness, { root, dir, paused: true });
			const store = createStore(root);
			const picked = store.read(eff.persona) ?? (eff.personaFrom === "override" ? null : store.read(store.activeId()));
			if (!picked) return { error: "没有可用人设" };
			const activePath = store.activeId() && picked.id !== store.activeId() ? store.materialize(picked.id) : store.refreshActive();
			if (channel === "install") return install(harness, { root, active: activePath, mode });
			if (channel === "project") return projectInstall(harness, { root, active: picked.body.trim(), dir });
			return installSlash(harness, root, { personaId: picked.id, personaBody: picked.body.trim() });
		});
		if (result.status !== "failed") {
			if (enabled) patchState(root, { disabledHarnesses: (loadState(root).state.disabledHarnesses ?? []).filter(id => id !== harness) });
			setArmed(root, harness, channel, channel === "project" ? projectDirectories(root, harness).length > 0 : enabled);
			// 开启 dsh 热切通道时，默认初始化为 purge off 状态，日常不注入提示词，仅当会话输入 /purge on 才激活
			if (harness === "dsh" && channel === "slash" && enabled) {
				const prevRuntime = loadState(root).state.dshRuntime ?? {};
				const nextRuntime = { ...prevRuntime };
				const targets = liveProfiles();
				const profiles = targets.length ? targets : ["desktop", "web", "headless", "sdk"];
				for (const p of profiles) {
					nextRuntime[p] = { ...(prevRuntime[p] ?? {}), enabled: false };
				}
				patchState(root, { dshRuntime: nextRuntime });
			}
			const paused = new Set(state.pausedInstalls ?? []);
			if (channel === "install") {
				if (enabled && result.action === "selected-while-paused") paused.add(harness);
				else paused.delete(harness);
				patchState(root, { pausedInstalls: [...paused] });
			}
		}
		return { ok: result.status !== "failed", ...result };
	});
}

/** 分家修改与所有相关落点同步在同一事务内。 */
export function configureHarness(root, harness, patch) {
	return exclusive(root, () => {
		if (!HARNESS_IDS.has(harness)) throw new Error(`未知执行器: ${harness}`);
		if (patch.persona && !createStore(root).read(patch.persona)) throw new Error(`没有人设: ${patch.persona}`);
		setOverride(root, harness, patch);
		return { effective: resolveFor(loadState(root).state, harness), ...sync(root) };
	});
}

export function disableHarness(root, harness) {
	return exclusive(root, () => {
		if (!HARNESS_IDS.has(harness)) throw new Error(`未知执行器: ${harness}`);
		const state = loadState(root).state;
		patchState(root, { disabledHarnesses: [...new Set([...(state.disabledHarnesses ?? []), harness])] });
		// 状态可能丢过（旧版本/手工删 state），但配置文件仍留着我们的块。
		// 关闭时以磁盘探针为准补上 install，避免“按钮关了、人设还在”。
		const channels = new Set(state.armed?.[harness] ?? []);
		try {
			const actual = installStatus(root).find(item => item.name === harness);
			if (actual?.installed) channels.add("install");
		} catch { /* 探针失败不阻断已知通道的清理 */ }
		const results = [...channels].map(channel => changeChannel(root, { harness, channel, enabled: false }));
		return { ok: results.every(r => r.ok), results };
	});
}
