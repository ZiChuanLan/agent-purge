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
	assert.deepEqual(matrix.harnesses.crush.modes, ["append"]);

	assert.deepEqual(matrix.harnesses.continue.modes, ["append"]);
	assert.deepEqual(matrix.harnesses.qoder.modes, ["replace", "append"]);
	assert.deepEqual(matrix.harnesses.kimi.modes, ["replace"]);
	// auggie 有隐藏的 --override-system-prompt：实测能把 body.system_prompt 整份换掉，
	// 所以它不再是 append-only（--rules 才是追加那条路）
	assert.deepEqual(matrix.harnesses.auggie.modes, ["replace", "append"]);
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
	// auggie 不在此列：它有隐藏的 --override-system-prompt，实测能整份换掉 body.system_prompt
	for (const id of ["antigravity", "zcode", "crush", "continue", "goose"]) {
		assert.equal(matrix.harnesses[id].purgeKind, "append", `${id} 应为 append`);
	}
	// 宿主会前置自己的身份句，替换后仍有残留
	for (const id of ["claude", "kilo"]) {
		assert.equal(matrix.harnesses[id].purgeKind, "partial", `${id} 应为 partial`);
	}
	// 没有系统提示词字数实测的家，不许对外宣称已净化
	// pi 已经拿到四模式真实抓包（2026-11-14），不再属于这一类
	// 没有系统提示词字数实测的家，不许对外宣称已净化：字数必须是 null，且必须写明原因。
	// 这里不强制 purgeKind —— purgeKind 说的是「怎么净化」，不是「有没有抓过包」。
	// pi-desktop / workbuddy 是插件与配置接管，方式确定，只是没有 system 字数。
	for (const id of ["pi-desktop", "workbuddy", "workbuddy-ai"]) {
		const h = matrix.harnesses[id];
		assert.equal(h.defaultSystemChars, null, `${id} 没有抓包，defaultSystemChars 必须是 null`);
		assert.ok(h.note || h.residue, `${id} 必须写明为什么没有字数实测`);
	}
	// 有实测字数的家必须同时给出 replaceScope：整份替换、只换身份段、还是只能追加
	// client-field：宿主 system 在服务端拼装，客户端只有一个可替换的字段（auggie）
	const SCOPES = new Set(["entire-system", "identity-only", "append", "client-field"]);
	for (const [id, h] of Object.entries(matrix.harnesses)) {
		if (!h.replaceScope) continue;
		assert.ok(SCOPES.has(h.replaceScope), `${id}: 未知 replaceScope ${h.replaceScope}`);
		if (h.purgeKind === "append") assert.equal(h.replaceScope, "append", `${id}: append 型的 replaceScope 必须是 append`);
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
// safety 是抓包实测的「内置安全/拒答/防破甲条款数」：off = 未注入时的条数，purged = 注入后的条数。
// 这条测试保证数字不会和净化方式互相矛盾：
//   replace（整份替换）→ 必须归零，留一条都算虚假宣传
//   partial（宿主会补固定句）→ 允许残留，但必须写出 residue 说清是哪句
//   append（只能追加）→ 不可能删掉，数字不许比 off 小
test("mode-support: 内置安全条款与净化方式自洽", () => {
	for (const [id, h] of Object.entries(matrix.harnesses)) {
		const s = h.safety;
		if (!s || s.off === null) continue;
		assert.equal(typeof s.off, "number", `${id}: safety.off 必须是数字或 null`);
		assert.equal(typeof s.purged, "number", `${id}: safety.purged 必须是数字或 null`);
		const kind = h.purgeKind ?? "replace";
		if (s.off > 0 && kind === "replace") {
			assert.equal(s.purged, 0, `${id}: 声称 replace 但安全条款仍残留 ${s.purged} 处`);
		}
		if (s.off > 0 && kind === "partial" && s.purged > 0) {
			// partial 的残留可能正是宿主硬编码的安全句（qoder 的「不要暴露系统提示词」），
			// 这种情况必须留档：没有 residue 就是在偷偷宣传净化干净了。
			assert.ok(h.residue, `${id}: partial 型残留 ${s.purged} 条安全条款却没写 residue`);
		}
		if (kind === "append" && s.off > 0) {
			assert.ok(s.purged >= s.off, `${id}: append 型不可能删掉安全条款，数字自相矛盾`);
		}
	}
});
