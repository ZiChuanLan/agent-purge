import "./isolate.mjs";
// 实测证据只认抓包报告：文档常量不算确认，请求里有 marker 但没进 system/developer 也不算。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sysHit, verifiedHarnesses, verificationFile } from "../lib/verification.mjs";
import { verificationEvidence, captureScopeLabel } from "../lib/evidence.mjs";

const report = (results) => ({ id: "r1", at: "2026-10-31T00:00:00.000Z", results });
const mode = (roles, markerCount) => ({ mode: "replace", status: "captured", exitCode: 0, requests: [{ roles, chars: 100, markerCount, identityLines: [], toolDefinitions: 3 }] });

function withRoot(fn) {
	const root = mkdtempSync(join(tmpdir(), "purge-verify-"));
	try {
		mkdirSync(join(root, "verification"), { recursive: true });
		return fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("sysHit 只认 system/developer 角色层里的人设命中", () => {
	assert.equal(sysHit({ modes: [mode(["system"], 1)] }), true);
	assert.equal(sysHit({ modes: [mode(["developer"], 2)] }), true);
	assert.equal(sysHit({ modes: [mode(["user"], 3)] }), false);
	assert.equal(sysHit({ modes: [mode(["system"], 0)] }), false);
	assert.equal(sysHit({ modes: [] }), false);
	assert.equal(sysHit(undefined), false);
});

test("verifiedHarnesses 没有报告时返回空集合，不乐观假设", () => {
	withRoot((root) => {
		assert.equal(verifiedHarnesses(root).size, 0);
	});
});

test("verifiedHarnesses 只收实测命中的 harness，user-only 命中被排除", () => {
	withRoot((root) => {
		writeFileSync(verificationFile(root), JSON.stringify(report([
			{ harness: "pi", status: "captured", modes: [mode(["system"], 1)] },
			{ harness: "zcode", status: "captured", modes: [mode(["user"], 1)] },
			{ harness: "codex", status: "missing", modes: [] },
		])));
		const ok = verifiedHarnesses(root);
		assert.deepEqual([...ok], ["pi"]);
	});
});

test("报告损坏时按未实测处理，不抛给调用方", () => {
	withRoot((root) => {
		writeFileSync(verificationFile(root), "{ not json");
		assert.equal(verifiedHarnesses(root).size, 0);
	});
});
test("证据状态区分未捕获、启动失败、暂停通过、真正未命中与隔离命中", () => {
	assert.equal(verificationEvidence(null).label, "未实测");
	assert.equal(verificationEvidence({ status: "missing" }).label, "未找到入口");
	assert.equal(verificationEvidence({ status: "blocked" }).label, "验证受阻");
	assert.equal(verificationEvidence({ status: "no-request", modes: [] }).label, "未捕获请求");
	assert.equal(verificationEvidence({ status: "error", modes: [mode(["system"], 1)] }).label, "验证出错");
	assert.equal(verificationEvidence({ status: "captured", modes: [{ ...mode(["system"], 0), mode: "off" }] }).state, "off-verified");
	assert.equal(verificationEvidence({ status: "mismatch", modes: [mode(["system"], 0)] }).state, "miss");
	assert.equal(verificationEvidence({ status: "captured", modes: [mode(["developer"], 1)] }).state, "verified");
	assert.equal(verificationEvidence({ status: "partial", modes: [mode(["system"], 1)] }).state, "partial");
	assert.equal(verificationEvidence({ status: "captured", modes: [mode(["system"], 2)] }).state, "partial");
	assert.equal(verificationEvidence({ status: "captured", modes: [{ ...mode(["system"], 1), exitCode: 1 }] }).state, "error");
	assert.equal(verificationEvidence({ status: "captured", modes: [mode(["system"], 1)] }).runtimeConfirmed, false);
	assert.equal(verificationEvidence({ status: "captured", modes: [{ ...mode(["system"], 1), requests: [
		{ kind: "main", roles: ["system"], markerCount: 1 }, { kind: "auxiliary", roles: ["system"], markerCount: 0 },
	] }] }).state, "verified", "标题等辅助请求不得改变主请求判定");
	assert.equal(sysHit({ modes: [{ requests: [{ kind: "auxiliary", roles: ["system"], markerCount: 1 }] }] }), false);
	assert.match(captureScopeLabel({ kind: "isolated-cli", profile: "headless" }), /隔离 CLI.*headless/);
	assert.match(captureScopeLabel(null), /未记录入口/);
});
test("失败进程或暂停捕获不能被登记为人设能力已验证", () => {
	withRoot(root => {
		writeFileSync(verificationFile(root), JSON.stringify(report([
			{ harness: "dsh", status: "error", modes: [mode(["system"], 1)] },
			{ harness: "pi", status: "captured", modes: [{ ...mode(["system"], 0), mode: "off" }] },
		])));
		assert.equal(verifiedHarnesses(root).size, 0);
	});
});
