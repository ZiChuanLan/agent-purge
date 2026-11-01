// 唯一配置文件；已配置的模式与运行时实际启用状态分开解析。
import { existsSync, readFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withControlLock, atomicControlJSON } from "./control.mjs";
import { resolveConfigured } from "./activation.mjs";
export { resolveActivation } from "./activation.mjs";

export const MODES = ["strict", "replace", "append", "off"];
export const ARMS = ["shim", "slash", "install", "project"];
export const ARM_LABEL = {
	shim: "裸命令接管（敲 codex 就是接管的）", slash: "会话内 /purge（热切换）",
	install: "配置文件常驻（连别人启动的也生效）", project: "所选项目的规则文件",
};
export const statePath = root => join(root, "state.json");
const object = value => value && typeof value === "object" && !Array.isArray(value);
function emptyState() {
	return { v: 1, persona: null, default: null, armed: {}, overrides: {}, projectDirs: {}, piAuto: false, piUserLayer: false, ompAuto: false, dshProfiles: null };
}

/** 损坏配置保持原字节，报告后停止操作；运行时独立读取失败时只透传。 */
export function loadState(root) {
	const file = statePath(root), migrated = [];
	let state = emptyState();
	if (existsSync(file)) {
		try {
			const raw = JSON.parse(readFileSync(file, "utf8"));
			if (!object(raw)) throw new Error("配置必须是对象");
			state = { ...state, ...raw, armed: object(raw.armed) ? raw.armed : {},
				overrides: object(raw.overrides) ? raw.overrides : {}, projectDirs: object(raw.projectDirs) ? raw.projectDirs : {} };
		} catch (error) { throw new Error(`state.json 损坏，原文件已保留：${file}`, { cause: error }); }
	}
	const legacy = join(root, ".defaults.json");
	if (!state.default && existsSync(legacy)) {
		try {
			const d = JSON.parse(readFileSync(legacy, "utf8"));
			if (d?.harness) {
				state.default = { harness: d.harness, mode: MODES.includes(d.mode) ? d.mode : "replace" };
				migrated.push(`.defaults.json → default=${state.default.harness} · ${state.default.mode}`);
			}
		} catch { /* 旧配置保持原样 */ }
	}
	const oldActive = join(root, "personas", ".active");
	if (!state.persona && existsSync(oldActive)) {
		const id = readFileSync(oldActive, "utf8").trim();
		if (id) { state.persona = id; migrated.push(`personas/.active → persona=${id}`); }
	}
	if (migrated.length) withControlLock(root, () => {
		saveState(root, state);
		if (existsSync(legacy)) renameSync(legacy, legacy + ".migrated");
		if (existsSync(oldActive)) renameSync(oldActive, oldActive + ".migrated");
	});
	return { state, migrated };
}

export function saveState(root, state) {
	return withControlLock(root, () => {
		let before = {};
		try { before = JSON.parse(readFileSync(statePath(root), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
		const next = { ...state };
		// 随机撤销代次不会因 off→on 复活旧启动；生成器每轮核对这个值。
		if (next.default?.mode === "off" && before.default?.mode !== "off") next.activationEpoch = randomUUID();
		const ids = new Set([...Object.keys(before.overrides ?? {}), ...Object.keys(next.overrides ?? {}), ...(next.disabledHarnesses ?? [])]);
		for (const id of ids) {
			if ((next.overrides?.[id]?.mode === "off" && before.overrides?.[id]?.mode !== "off") ||
				((next.disabledHarnesses ?? []).includes(id) && !(before.disabledHarnesses ?? []).includes(id)))
				next.harnessEpochs = { ...next.harnessEpochs, [id]: randomUUID() };
		}
		atomicControlJSON(statePath(root), next);
		return next;
	});
}
export function updateState(root, update) {
	return withControlLock(root, () => saveState(root, update(loadState(root).state)));
}
export function patchState(root, patch) { return updateState(root, state => ({ ...state, ...patch })); }
export function setDefault(root, { harness, mode }) {
	if (!harness) throw new Error("harness 为空");
	if (!MODES.includes(mode)) throw new Error(`未知模式: ${mode}`);
	return updateState(root, state => ({ ...state, default: { harness, mode } })).default;
}
export function setPersona(root, id) { return patchState(root, { persona: id }).persona; }
export function setPiAuto(root, on) { return patchState(root, { piAuto: on === true }).piAuto; }
export function setOmpAuto(root, on) { return patchState(root, { ompAuto: on === true }).ompAuto; }
export function setPiUserLayer(root, on) { return patchState(root, { piUserLayer: on === true }).piUserLayer; }
export function armedOf(state, id) { return Array.isArray(state?.armed?.[id]) ? state.armed[id] : []; }
export function setArmed(root, id, arm, on) {
	if (!ARMS.includes(arm)) throw new Error(`未知通道: ${arm}`);
	const state = updateState(root, before => {
		const cur = new Set(armedOf(before, id)); on ? cur.add(arm) : cur.delete(arm);
		const list = ARMS.filter(a => cur.has(a)), armed = { ...before.armed };
		if (list.length) armed[id] = list; else delete armed[id];
		return { ...before, armed };
	});
	return armedOf(state, id);
}
export function overridesOf(state) { return object(state?.overrides) ? state.overrides : {}; }
export function resolveFor(state, id) { return resolveConfigured(state, id); }
export function setOverride(root, id, patch = {}) {
	const next = updateState(root, state => {
		const cur = { ...(overridesOf(state)[id] ?? {}) };
		for (const [key, value] of Object.entries(patch)) {
			if (!["persona", "mode"].includes(key)) throw new Error(`未知分家字段: ${key}`);
			if (value === null || value === undefined || value === "") delete cur[key];
			else if (key === "mode" && !MODES.includes(value)) throw new Error(`未知模式: ${value}`);
			else cur[key] = value;
		}
		const overrides = { ...overridesOf(state) };
		if (Object.keys(cur).length) overrides[id] = cur; else delete overrides[id];
		return { ...state, overrides };
	});
	return next.overrides[id] ?? null;
}
export function dshProfilesOf(state) { return Array.isArray(state?.dshProfiles) ? state.dshProfiles : null; }
export function setDshProfile(root, profile, on, all) {
	if (!all.includes(profile)) throw new Error(`未知 dsh profile: ${profile}`);
	return updateState(root, state => {
		const cur = new Set(dshProfilesOf(state) ?? all); on ? cur.add(profile) : cur.delete(profile);
		return { ...state, dshProfiles: all.filter(p => cur.has(p)) };
	}).dshProfiles;
}
