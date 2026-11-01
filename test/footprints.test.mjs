import { isolate } from "./isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ap-ledger-"));
isolate(dir);
Object.assign(process.env, { HOME: dir, USERPROFILE: dir, AGENT_PURGE_HOME: join(dir, "data") });
const { cancel, ledgerFile, listLedger, record } = await import("../lib/footprints.mjs");
const { clean } = await import("../lib/clean.mjs");
const { dataHome } = await import("../lib/home.mjs");
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("账本：按所有者去重；损坏时保留证据并停止写入", () => {
	const root = join(dir, "l1");
	const file = join(dir, "a.txt");
	writeFileSync(file, "x");
	record(root, { kind: "file", harness: "codex", channel: "shim", path: file, undo: { type: "file-delete" } });
	record(root, { kind: "file", harness: "codex", channel: "shim", path: file, undo: { type: "file-delete" } });
	assert.equal(listLedger(root).length, 1, "重复登记应去重");
	cancel(root, { kind: "file", path: file });
	assert.equal(listLedger(root).length, 0);
	writeFileSync(ledgerFile(root), "{not json");
	assert.throws(() => listLedger(root), /账本损坏/);
	assert.throws(() => record(root, { kind: "file", harness: "pi", channel: "shim", path: file, undo: { type: "file-delete" } }), /账本损坏/);
	assert.equal(readFileSync(ledgerFile(root), "utf8"), "{not json");
});

test("账本：path 条目登记目录时不能把目录当文件读", () => {
	const root = join(dir, "l-path");
	const folder = join(dir, "shim-bin");
	mkdirSync(folder, { recursive: true });
	const entry = record(root, { kind: "path", harness: "codebuddy", channel: "shim", path: folder, undo: { type: "path-env" } });
	assert.equal(entry.kind, "path");
	assert.equal(entry.sha256, undefined, "目录没有文件哈希");
	assert.equal(listLedger(root).length, 1);
	cancel(root, { kind: "path", path: folder });
	assert.equal(listLedger(root).length, 0);
});

test("clean：按账本删文件、剥托管块，块外内容原样保留", () => {
	const root = join(dir, "l2");
	mkdirSync(root, { recursive: true });
	const victim = join(dir, "victim.md");
	const agentFile = join(dir, "AGENTS.md");
	writeFileSync(victim, "shim");
	writeFileSync(agentFile, "MINE\n# >>> agent-purge\n注入块\n# <<< agent-purge\n");
	record(root, { kind: "file", harness: "codex", channel: "shim", path: victim, undo: { type: "file-delete" } });
	record(root, { kind: "block", harness: "pi", channel: "install", path: agentFile, undo: { type: "block-revert" } });

	const r = clean(root);
	assert.equal(existsSync(victim), false, "file-delete 应删掉写入的文件");
	const after = readFileSync(agentFile, "utf8");
	assert.ok(after.includes("MINE"), "块外内容不能在撤销时丢");
	assert.ok(!after.includes("注入块"), "托管块应被剥掉");
	assert.equal(listLedger(root).length, 0, "撤销后账本应清空");
	assert.deepEqual(r.leftovers, []);
});

test("clean --dry-run：一条都不写（文件、托管块、账本原样）", () => {
	const root = join(dir, "l4");
	mkdirSync(root, { recursive: true });
	const victim = join(dir, "dry-victim.md");
	const agentFile = join(dir, "dry-AGENTS.md");
	writeFileSync(victim, "shim");
	writeFileSync(agentFile, "MINE\n# >>> agent-purge\n注入块\n# <<< agent-purge\n");
	record(root, { kind: "file", harness: "codex", channel: "shim", path: victim, undo: { type: "file-delete" } });
	record(root, { kind: "block", harness: "pi", channel: "install", path: agentFile, undo: { type: "block-revert" } });
	const snapshot = () => [readFileSync(victim, "utf8"), readFileSync(agentFile, "utf8"), readFileSync(ledgerFile(root), "utf8")];
	const before = snapshot();

	const r = clean(root, { dryRun: true });

	assert.deepEqual(snapshot(), before, "dry-run 动了字节：它必须只读");
	assert.equal(listLedger(root).length, 2, "dry-run 不许销账，否则下次真 clean 就看不见这些残留");
	assert.equal(r.ok, true);
	assert.ok(r.steps.some((s) => String(s.detail).includes("dry-run")), "步骤里要明确标出这是演练");
});

test("self-uninstall：连数据目录一起删；数据目录就是 cwd 时拒绝清空", () => {
	const root = join(dir, "l3");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "state.json"), "{}");
	const prev = process.env.AGENT_PURGE_HOME;
	process.env.AGENT_PURGE_HOME = root;
	try {
		assert.equal(dataHome(), root);
		clean(root, { all: true });
		assert.equal(existsSync(root), false, "all=true 应删掉整个数据目录");

		// 数据目录 == cwd 时必须拒绝：那是在删用户自己的目录
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "state.json"), "{}");
		const realCwd = process.cwd;
		process.cwd = () => root;
		try {
			const r = clean(root, { all: true });
			assert.equal(existsSync(join(root, "state.json")), true, "cwd 保护必须拦住删除");
			assert.equal(r.ok, false, "拒绝删除要报成未完成，不能静默成功");
		} finally {
			process.cwd = realCwd;
		}
	} finally {
		process.env.AGENT_PURGE_HOME = prev;
	}
});
