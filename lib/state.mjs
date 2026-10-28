// 唯一状态文件。
//
// 之前是两套：`.defaults.json`（harness+mode）与 `personas/.active`（人设指针），
// 两个文件、两套语义、Web 与 CLI 各写一边 —— 这就是"用起来混乱"的根源：
// 用户改了一处以为全生效，其实另一处还压着旧值。
//
// 现在只有 state.json：
//   persona  谁      —— 当前 persona id（人设的唯一指针）
//   default  注入谁   —— 裸敲 agent-purge 时启动的 harness + 注入模式
//   armed    怎么生效 —— 每家已经武装了哪几条通道：shim / slash / install
//
// personas/active.md 退化为「派生物」：由 launch/arm 时按 persona 生成，
// 供落盘型 harness 与 opencode 插件读取，不再承载状态。
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "state.json";
const LEGACY_DEFAULTS = ".defaults.json";
const LEGACY_ACTIVE = join("personas", ".active");

export const MODES = ["strict", "replace", "append", "off"];
/** 三种生效通道，互不冲突，可以叠加 */
export const ARMS = ["shim", "slash", "install"];

export const ARM_LABEL = {
	shim: "裸命令接管（敲 codex 就是接管的）",
	slash: "会话内 /purge（热切换）",
	install: "配置文件常驻（连别人启动的也生效）",
};

export function statePath(root) {
	return join(root, FILE);
}

function emptyState() {
	return { v: 1, persona: null, default: null, armed: {}, piAuto: false, piUserLayer: false, ompAuto: false, dshProfiles: null };
}

/**
 * 读状态，顺带把旧布局迁移过来（旧文件改名 `*.migrated` 留档，之后只认 state.json）。
 * 返回 `{ state, migrated[] }`；migrated 是给调用方打印的一行行说明。
 */
export function loadState(root) {
	const file = statePath(root);
	let state = emptyState();
	const migrated = [];

	if (existsSync(file)) {
		try {
			const raw = JSON.parse(readFileSync(file, "utf8"));
			state = { ...state, ...raw, armed: raw?.armed && typeof raw.armed === "object" ? raw.armed : {} };
		} catch {
			migrated.push("state.json 损坏 → 按空状态重来");
		}
	}

	const legacy = join(root, LEGACY_DEFAULTS);
	if (!state.default && existsSync(legacy)) {
		try {
			const d = JSON.parse(readFileSync(legacy, "utf8"));
			if (d?.harness) {
				state.default = { harness: d.harness, mode: MODES.includes(d.mode) ? d.mode : "replace" };
				migrated.push(`.defaults.json → default=${state.default.harness} · ${state.default.mode}`);
			}
			renameSync(legacy, legacy + ".migrated");
		} catch {
			/* 坏文件不动它，留给人工看 */
		}
	}

	if (!state.persona) {
		const old = join(root, LEGACY_ACTIVE);
		if (existsSync(old)) {
			const id = readFileSync(old, "utf8").trim();
			if (id) {
				state.persona = id;
				migrated.push(`personas/.active → persona=${id}`);
			}
			renameSync(old, old + ".migrated");
		}
	}

	// 迁完立即落盘：否则下次调用看不到旧文件，迁移结果直接丢掉
	if (migrated.length) saveState(root, state);

	return { state, migrated };
}

export function saveState(root, state) {
	// 先写临时文件再改名：Web 与 CLI 同时写时，读的一方不会看到半截 JSON
	const file = statePath(root);
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
		renameSync(tmp, file);
	} catch (e) {
		// rename 失败时别把半截临时文件留在 ~/.agent-purge
		try {
			unlinkSync(tmp);
		} catch {}
		throw e;
	}
	return state;
}

/** 浅合并；armed 需要整块替换时传完整对象 */
export function patchState(root, patch) {
	const { state } = loadState(root);
	return saveState(root, { ...state, ...patch });
}

export function setDefault(root, { harness, mode }) {
	if (!harness) throw new Error("harness 不能为空");
	const { state } = loadState(root);
	const next = { ...state, default: { harness, mode: MODES.includes(mode) ? mode : "replace" } };
	return saveState(root, next).default;
}

export function setPersona(root, id) {
	const { state } = loadState(root);
	return saveState(root, { ...state, persona: id }).persona;
}

/** 裸敲 pi 是否也自动注入（装好的扩展直接读这个位） */
export function setPiAuto(root, on) {
	const { state } = loadState(root);
	return saveState(root, { ...state, piAuto: on === true }).piAuto;
}

/** 裸敲 omp 是否也自动注入（omp 扩展读这个位） */
export function setOmpAuto(root, on) {
	const { state } = loadState(root);
	return saveState(root, { ...state, ompAuto: on === true }).ompAuto;
}

/** pi 的人设走哪一层：false = system（默认），true = 额外塞进用户消息（给忽略 system 的模型用） */
export function setPiUserLayer(root, on) {
	const { state } = loadState(root);
	return saveState(root, { ...state, piUserLayer: on === true }).piUserLayer;
}

/** armed 变成 {codex: ["shim","install"]}；空数组即删键 */
export function setArmed(root, id, arm, on) {
	const { state } = loadState(root);
	const cur = new Set(state.armed?.[id] ?? []);
	if (on) cur.add(arm);
	else cur.delete(arm);
	const list = ARMS.filter((a) => cur.has(a));
	const armed = { ...state.armed };
	if (list.length) armed[id] = list;
	else delete armed[id];
	saveState(root, { ...state, armed });
	return list;
}

export function armedOf(state, id) {
	return state.armed?.[id] ?? [];
}

/** dsh 三个 profile 哪些生效：null = 没设置过（全部），[] = 全关 */
export function dshProfilesOf(state) {
	return Array.isArray(state?.dshProfiles) ? state.dshProfiles : null;
}

/** 开/关单个 dsh profile；all 由调用方传入（列表归属 lib/dsh.mjs，别在状态层再写一份） */
export function setDshProfile(root, profile, on, all) {
	const { state } = loadState(root);
	const cur = new Set(dshProfilesOf(state) ?? all);
	if (on) cur.add(profile);
	else cur.delete(profile);
	const list = all.filter((p) => cur.has(p));
	return saveState(root, { ...state, dshProfiles: list }).dshProfiles;
}
