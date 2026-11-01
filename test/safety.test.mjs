import { isolate } from "./isolate.mjs";
// 安全回归：卸载 / self-uninstall 绝不能删到「不是我们写的东西」，也绝不能删掉自己的还原依据。
//
// 这几条对应 2026-10-31 那次事故：
//   1. slash / file 通道写入前不存 stash → 用户手改过的扩展被整份覆盖且永不还原
//   2. clean --all 先 rmSync 数据目录 → 账本 + stash 一起没了，事后无法核对也无法还原
//   3. clean 跑完不重置 armed → 「没有 codebuddy 的 shim」这种条目永远清不掉
// 全部在临时 HOME 里跑，不碰真实配置。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "ap-safety-"));
const saved = { ...process.env };
isolate(dir);
process.env.USERPROFILE = dir;
process.env.HOME = dir;
process.env.AGENT_PURGE_HOME = join(dir, ".agent-purge");
process.env.XDG_CONFIG_HOME = join(dir, ".config");
process.env.PI_HOME = join(dir, ".pi", "agent");
process.env.OMP_HOME = join(dir, ".omp");
const DATA = process.env.AGENT_PURGE_HOME;

// 静态 import 会在上面赋值前求值（把 home 固定成真实用户目录）：必须动态导入
const { installSlash, uninstallSlash } = await import("../lib/slashes.mjs");
const { install, uninstall } = await import("../lib/persist.mjs");
const { cancel, listLedger, record } = await import("../lib/footprints.mjs");
const { clean } = await import("../lib/clean.mjs");
const { loadState } = await import("../lib/state.mjs");

const active = join(DATA, "personas", "alpha.md");
mkdirSync(join(DATA, "personas"), { recursive: true });
writeFileSync(active, "PERSONA");
writeFileSync(join(DATA, "state.json"), JSON.stringify({ v: 1, persona: "alpha", armed: {} }));

const trashes = () => readdirSync(dir).filter((n) => n.startsWith(".agent-purge.trash-"));
const stepOf = (r, what) => r.steps.find((s) => s.what === what);

after(() => {
	process.env = saved;
	rmSync(dir, { recursive: true, force: true });
});

test("slash 覆盖用户已有的同名扩展：撤销时按原字节还原，不整份删", () => {
	const ext = join(dir, ".pi", "agent", "extensions");
	mkdirSync(ext, { recursive: true });
	const file = join(ext, "agent-purge.ts");
	const mine = "// 我自己手写的扩展，只是碰巧同名\nexport default {};\n";
	writeFileSync(file, mine);

	const r = installSlash("pi", DATA, { personaId: "alpha", personaBody: "PERSONA" });
	assert.ok(r.file, JSON.stringify(r));
	assert.notEqual(readFileSync(file, "utf8"), mine, "没写上");

	uninstallSlash("pi", DATA);
	assert.equal(readFileSync(file, "utf8"), mine, "用户原有的扩展被吃掉了");
});

test("file 类目标（opencode2 插件）覆盖用户文件：撤销时还原原字节", () => {
	const plug = join(dir, ".config", "opencode", "plugins");
	mkdirSync(plug, { recursive: true });
	const file = join(plug, "agent-purge-v2.ts");
	const mine = "// 用户自己的 v2 插件\n";
	writeFileSync(file, mine);

	const r = install("opencode2", { root: DATA, active });
	assert.ok(r.file?.endsWith("agent-purge-v2.ts"), JSON.stringify(r));
	assert.notEqual(readFileSync(file, "utf8"), mine, "没写上");

	uninstall("opencode2");
	assert.equal(readFileSync(file, "utf8"), mine, "用户原有的插件被吃掉了");
});

test("用户改过我们写的文件：不删，改名停用，字节一个不少", () => {
	installSlash("omp", DATA, { personaId: "alpha", personaBody: "PERSONA" });
	const file = join(dir, ".omp", "agent", "extensions", "agent-purge.ts");
	const edited = `${readFileSync(file, "utf8")}\n// 用户手改的一行\n`;
	writeFileSync(file, edited);

	uninstallSlash("omp", DATA);
	assert.equal(existsSync(file), false, "还在加载");
	assert.equal(readFileSync(`${file}.disabled-by-agent-purge`, "utf8"), edited, "手改内容丢了");
	rmSync(`${file}.disabled-by-agent-purge`, { force: true });
});

test("账本落 sha256：撤销时才有指纹可比", () => {
	const file = join(dir, "ledger-fingerprint.txt");
	writeFileSync(file, "hello");
	const e = record(DATA, { kind: "file", harness: "pi", channel: "shim", path: file, undo: { type: "file-delete" } });
	assert.match(e.sha256, /^[0-9a-f]{64}$/);
	cancel(DATA, { kind: "file", path: file });
	rmSync(file, { force: true });
	assert.equal(listLedger(DATA).length, 0);
});

test("clean 之后 armed 归零：不再出现「账本空了、state 还写着」", () => {
	writeFileSync(
		join(DATA, "state.json"),
		JSON.stringify({ v: 1, persona: "alpha", armed: { codex: ["install"], codebuddy: ["shim"] } }),
	);
	const r = clean(DATA, {});
	assert.ok(
		r.steps.every((s) => s.ok),
		JSON.stringify(r.steps),
	);
	assert.deepEqual(loadState(DATA).state.armed, {});
	assert.deepEqual(r.leftovers, []);
});

test("登记过但内容已被换掉、又不是我们的文件：一个字节都不动", () => {
	const notes = join(dir, "notes");
	mkdirSync(notes, { recursive: true });
	const mine = join(notes, "mine.txt");
	writeFileSync(mine, "我的笔记 A");
	record(DATA, { kind: "file", harness: "pi", channel: "shim", path: mine, undo: { type: "file-delete" } });
	writeFileSync(mine, "我的笔记 B —— 用户后来又改了");

	const r = clean(DATA, {});
	assert.equal(stepOf(r, "ledger:file-delete")?.ok, false, "把别人的文件删了");
	assert.equal(readFileSync(mine, "utf8"), "我的笔记 B —— 用户后来又改了");
	assert.ok(
		r.leftovers.some((l) => l.includes("mine.txt")),
		r.leftovers.join(" | "),
	);
});

test("self-uninstall：残留时保留原数据目录，修复后可按原路径重试", () => {
	const r = clean(DATA, { all: true });
	assert.equal(stepOf(r, "data-home")?.ok, false);
	assert.equal(existsSync(DATA), true);
	assert.equal(trashes().length, 0);
	assert.ok(existsSync(join(DATA, "footprints.json")));
	assert.ok(r.leftovers.some(l => l.includes("mine.txt")));
	assert.equal(loadState(DATA).state.default.mode, "off");
	assert.equal(readFileSync(join(dir, "notes", "mine.txt"), "utf8"), "我的笔记 B —— 用户后来又改了");
	rmSync(join(dir, "notes", "mine.txt"));
	assert.equal(clean(DATA, { all: true }).ok, true);
});

test("确认干净后才真删：没有残留时数据目录整个清掉，不留 trash", () => {
	mkdirSync(join(DATA, "personas"), { recursive: true });
	writeFileSync(join(DATA, "state.json"), JSON.stringify({ v: 1, persona: "alpha", armed: {} }));
	writeFileSync(join(DATA, "personas", "alpha.md"), "PERSONA");

	const r = clean(DATA, { all: true });
	assert.equal(stepOf(r, "data-home")?.ok, true, JSON.stringify(r.steps));
	assert.equal(existsSync(DATA), false);
	assert.equal(trashes().length, 0);
});
test("永久删除拒绝 HOME 及其上级、大小写别名和目录链接，且拒绝前不写状态", () => {
	const fakeHome = join(dir, "protected", "UserHome");
	mkdirSync(fakeHome, { recursive: true });
	const before = '{"v":1,"default":{"harness":"pi","mode":"append"}}';
	writeFileSync(join(fakeHome, "state.json"), before);
	const oldHome = process.env.HOME, oldUser = process.env.USERPROFILE;
	process.env.HOME = process.env.USERPROFILE = fakeHome;
	try {
		for (const root of [fakeHome, join(fakeHome, ".."), ...(process.platform === "win32" ? [fakeHome.toUpperCase()] : [])]) {
			assert.equal(clean(root, { all: true }).ok, false);
			assert.equal(readFileSync(join(fakeHome, "state.json"), "utf8"), before);
		}
		const alias = join(dir, "home-alias");
		symlinkSync(fakeHome, alias, process.platform === "win32" ? "junction" : "dir");
		assert.equal(clean(alias, { all: true }).ok, false);
		assert.equal(readFileSync(join(fakeHome, "state.json"), "utf8"), before);
	} finally { process.env.HOME = oldHome; process.env.USERPROFILE = oldUser; }
});
