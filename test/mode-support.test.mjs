import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MODE_LABELS, modeAvailability, unsupportedHarnesses } from "../web/model.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const matrix = JSON.parse(readFileSync(join(root, "matrix.json"), "utf8"));

test("mode-support: 未声明 modes 的 harness 四种模式都算可用", () => {
	const avail = modeAvailability({ id: "pi", preferredMode: "replace" });
	assert.deepEqual([...avail.supported].sort(), Object.keys(MODE_LABELS).sort());
	assert.equal(avail.limited, false);
	assert.equal(avail.preferred, "replace");
});

test("mode-support: 声明了 modes 就只认它，且 off（暂停）永远可用", () => {
	const avail = modeAvailability({ modes: ["append"], modesNote: "写入型通道" });
	assert.deepEqual([...avail.supported].sort(), ["append", "off"]);
	assert.equal(avail.limited, true);
	assert.equal(avail.note, "写入型通道");
	assert.equal(avail.supported.has("strict"), false);
});

test("mode-support: matrix.json 里的 modes 都是真模式名，preferredMode 不能落在不可用集合里", () => {
	for (const [id, h] of Object.entries(matrix.harnesses)) {
		if (h.modes !== undefined) {
			assert.ok(Array.isArray(h.modes) && h.modes.length, `${id}: modes 必须是非空数组`);
			for (const m of h.modes) assert.ok(MODE_LABELS[m], `${id}: 未知模式 ${m}`);
			assert.ok(h.modesNote, `${id}: 声明了 modes 就必须写清 modesNote（UI 直接展示给用户）`);
		}
		const avail = modeAvailability(h);
		if (h.preferredMode) {
			assert.ok(avail.supported.has(h.preferredMode), `${id}: preferredMode=${h.preferredMode} 不在支持集合内`);
		}
	}
});

test("mode-support: 已知只支持单一模式的 harness 与实测一致", () => {
	assert.deepEqual(matrix.harnesses.codex.modes, ["replace"]);
	assert.deepEqual(matrix.harnesses.hermes.modes, ["append"]);
	assert.deepEqual(matrix.harnesses.zcode.modes, ["append"]);
	assert.deepEqual(matrix.harnesses.qwen.modes, ["replace", "append"]);
	assert.deepEqual(matrix.harnesses.gemini.modes, ["replace"]);
	assert.deepEqual(matrix.harnesses.crush.modes, ["append"]);

	assert.deepEqual(matrix.harnesses.continue.modes, ["append"]);
	assert.deepEqual(matrix.harnesses.qoder.modes, ["replace", "append"]);
	assert.deepEqual(matrix.harnesses.kimi.modes, ["replace"]);
	assert.deepEqual(matrix.harnesses.auggie.modes, ["append"]);
	assert.deepEqual(matrix.harnesses.goose.modes, ["append"]);
	assert.deepEqual(matrix.harnesses.kiro.modes, ["replace"]);
	// 四种模式都实测过的家不该被限制
	// antigravity 四模式都能写出不同文本，所以不限制模式；但四种都只是追加，靠 purgeKind=append 与 modesNote 说清
	assert.equal(matrix.harnesses.kilo.modes, undefined);
});

test("mode-support: unsupportedHarnesses 只挑出不认该模式的执行器", () => {
	const list = [
		{ id: "pi" },
		{ id: "codex", modes: ["replace"] },
		{ id: "hermes", modes: ["append"] },
		{ id: "zcode", modes: ["append"] },
	];
	assert.deepEqual(unsupportedHarnesses(list, "strict").map(h => h.id), ["codex", "hermes", "zcode"]);
	assert.deepEqual(unsupportedHarnesses(list, "replace").map(h => h.id), ["hermes", "zcode"]);
	assert.deepEqual(unsupportedHarnesses(list, "append").map(h => h.id), ["codex"]);
	// 暂停不受支持集合限制
	assert.deepEqual(unsupportedHarnesses(list, "off"), []);
	assert.deepEqual(unsupportedHarnesses(undefined, "strict"), []);
});

// purgeKind 是「这一家到底真删了宿主身份，还是只是往提示词里加了一段」的一等字段。
// 缺省视为 replace（宿主提供整段 system prompt 入口）。任何一家只要实测数字反过来
// 增长，就必须显式标 append —— 这是本项目最容易被写成虚假宣传的地方。
test("mode-support: purgeKind 与实测字数自洽", () => {
	const KINDS = new Set(["replace", "partial", "append", "unverified"]);
	for (const [id, h] of Object.entries(matrix.harnesses)) {
		const kind = h.purgeKind ?? "replace";
		assert.ok(KINDS.has(kind), `${id}: 未知 purgeKind ${kind}`);
		const d = h.defaultSystemChars;
		const p = h.purgedSystemChars;
		if (kind === "append") {
			assert.notEqual(h.override, true, `${id}: purgeKind=append 却声明 override:true，自相矛盾`);
			assert.ok(h.residue || h.note || h.modesNote, `${id}: append 型必须写明残留了什么`);
			if (typeof d === "number" && typeof p === "number") {
				assert.ok(p >= d, `${id}: append 型 purged(${p}) 不该低于 default(${d})`);
			}
		}
		if (kind === "replace" && typeof d === "number" && typeof p === "number") {
			assert.ok(p < d, `${id}: purgeKind=replace 但 purged(${p}) 没低于 default(${d})`);
		}
		if (kind === "partial" || kind === "unverified") {
			assert.ok(h.residue || h.note || h.verify, `${id}: ${kind} 必须写明残留部分或未测原因`);
		}
	}
});

test("mode-support: 追加型与部分替换型宿主清单锁定", () => {
	// 宿主没有整段 system prompt 入口，人设只能追加，原生身份仍在提示词里
	for (const id of ["antigravity", "zcode", "crush", "continue", "auggie", "goose"]) {
		assert.equal(matrix.harnesses[id].purgeKind, "append", `${id} 应为 append`);
	}
	// 宿主会前置自己的身份句，替换后仍有残留
	for (const id of ["claude", "kilo"]) {
		assert.equal(matrix.harnesses[id].purgeKind, "partial", `${id} 应为 partial`);
	}
	// 没有系统提示词字数实测的家，不许对外宣称已净化
	for (const id of ["pi", "pi-desktop", "workbuddy", "workbuddy-ai"]) {
		assert.equal(matrix.harnesses[id].purgeKind, "unverified", `${id} 应为 unverified`);
	}
});

// matrix 里 `patch: true` 等于对外承诺「能抹平宿主二进制里的身份串」。当前仓库
// 没有任何等长补丁实现，所以谁想开这个开关，必须同时把实现和这一行的登记做掉。
test("mode-support: 没有实现就不许声称 binary patch", () => {
	const IMPLEMENTED = new Set([]);
	for (const [id, h] of Object.entries(matrix.harnesses)) {
		if (h.patch === true) assert.ok(IMPLEMENTED.has(id), `${id}: patch:true 但没有补丁实现`);
	}
});
// safety 是 2026-11-13 全量抓包（11 家四模式）实测的「内置安全/拒答条款冲突数」。
// 这条测试保证数字不会和净化方式互相矛盾：真删型不许留，追加型不许声称删掉。
test("mode-support: 内置安全条款与净化方式自洽", () => {
	for (const [id, h] of Object.entries(matrix.harnesses)) {
		const s = h.safety;
		if (!s || s.off === null) continue;
		assert.equal(typeof s.off, "number", `${id}: safety.off 必须是数字或 null`);
		assert.equal(typeof s.purged, "number", `${id}: safety.purged 必须是数字或 null`);
		const kind = h.purgeKind ?? "replace";
		if (s.off > 0 && (kind === "replace" || kind === "partial")) {
			assert.equal(s.purged, 0, `${id}: 声称 ${kind} 但安全条款仍残留 ${s.purged} 处`);
		}
		if (kind === "append" && s.off > 0) {
			assert.ok(s.purged >= s.off, `${id}: append 型不可能删掉安全条款，数字自相矛盾`);
		}
	}
});
