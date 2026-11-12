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
	assert.equal(matrix.harnesses.antigravity.modes, undefined);
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
