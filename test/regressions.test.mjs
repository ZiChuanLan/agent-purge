// 回归：TOML 顶层块、persona id 防穿越、opencode append、omp /purge 生成。
// 都在临时 HOME 里跑，不碰真实配置。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let pass = 0;
const fails = [];
const t = async (name, fn) => {
	try {
		await fn();
		pass++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		fails.push(`${name}: ${e.message}`);
		console.log(`  ✗ ${name}\n     ${e.message}`);
	}
};

const dir = mkdtempSync(join(tmpdir(), "ap-regress-"));
const saved = { ...process.env };
const DATA = join(dir, ".agent-purge");
process.env.USERPROFILE = dir;
process.env.HOME = dir;
process.env.AGENT_PURGE_HOME = DATA;
process.env.OMP_HOME = join(dir, ".omp");
process.env.CODEX_HOME = join(dir, ".codex");
// 静态 import 会在这个赋值前求值，把 home 固定成真实用户目录；改成先设 env 再动态导入
const { upsertBlock, stripBlock, install: installTarget, uninstall: uninstallTarget } = await import("../lib/persist.mjs");
const { createStore, isValidId } = await import("../lib/personas.mjs");
const { installSlash, slashStatus, uninstallSlash } = await import("../lib/slashes.mjs");
const { backends } = await import("../backends/index.mjs");
mkdirSync(join(DATA, "personas"), { recursive: true });
writeFileSync(join(DATA, "personas", "alpha.md"), "---\nid: alpha\n---\n正文 A\n");
writeFileSync(join(DATA, "state.json"), JSON.stringify({ v: 1, persona: "alpha", default: { harness: "pi", mode: "replace" } }));

console.log("TOML 顶层块");
await t("codex 的块插在第一个 [table] 之前，重复装不留第二份", () => {
	const original = `# my config\nmodel = "x"\n\n[hooks.state.'a']\ntrusted_hash = "sha256:1"\n`;
	const body = 'model_instructions_file = "C:/p.md"';
	const next = upsertBlock(original, body, "top");
	assert.ok(next.indexOf("# >>> agent-purge") < next.indexOf("[hooks.state"));
	assert.equal((next.match(/model_instructions_file/g) || []).length, 1);
	const twice = upsertBlock(next, body, "top");
	assert.equal((twice.match(/# >>> agent-purge/g) || []).length, 1);
	assert.equal((twice.match(/model_instructions_file/g) || []).length, 1);
	assert.equal(stripBlock(twice).replace(/\n{2,}/g, "\n").trim(), original.replace(/\n{2,}/g, "\n").trim());
});
await t("已有同名顶层键被替换，不会 duplicate key", () => {
	const original = `model_instructions_file = "old"\n\n[table]\nk = 1\n`;
	const next = upsertBlock(original, 'model_instructions_file = "new"', "top");
	assert.equal((next.match(/model_instructions_file/g) || []).length, 1);
	assert.match(next, /"new"/);
});
await t("块插在头注释之后、首个 table/多行数组之前", () => {
	const original = `#:schema x\nmodel = "x"\narr = [\n  [1, 2]\n]\n\n[t]\nk = 1\n`;
	const next = upsertBlock(original, 'model_instructions_file = "p"', "top");
	assert.ok(next.startsWith("#:schema x\n"), next);
	assert.ok(next.indexOf("# >>> agent-purge") < next.indexOf("arr = ["));
	assert.ok(next.indexOf("# <<< agent-purge") < next.indexOf("[t]"));
	assert.match(next, /arr = \[\n  \[1, 2\]\n\]/);
});
await t("CRLF 配置插块后仍是 CRLF，卸载不把用户正文抛成 LF", () => {
	const original = '#:schema\r\nmodel = "x"\r\n\r\n[t]\r\nk = 1\r\n';
	const next = upsertBlock(original, 'model_instructions_file = "p"', "top");
	assert.doesNotMatch(next, /[^\r]\n/);
	assert.ok(next.indexOf("# >>> agent-purge") < next.indexOf("[t]"));
	const back = stripBlock(next).replace(/\r\n(?:\r\n)+/g, "\r\n");
	assert.equal(back, original.replace(/\r\n(?:\r\n)+/g, "\r\n"));
});
await t("codex 真装真卸：临时 CODEX_HOME，块在 table 前，CRLF 保留", () => {
	const file = join(dir, ".codex", "config.toml");
	const active = join(DATA, "personas", "active.md");
	mkdirSync(join(dir, ".codex"), { recursive: true });
	writeFileSync(active, "PERSONA");
	const original = '#:schema\r\nmodel = "x"\r\n\r\n[t]\r\nk = 1\r\n';
	writeFileSync(file, original);
	const r = installTarget("codex", { root: DATA, active });
	assert.equal(r.file, file);
	const src = readFileSync(file, "utf8");
	assert.ok(src.indexOf("model_instructions_file") < src.indexOf("[t]"));
	assert.doesNotMatch(src, /[^\r]\n/);
	const u = uninstallTarget("codex");
	assert.equal(u.action, "removed-block");
	assert.equal(readFileSync(file, "utf8").replace(/\r\n(?:\r\n)+/g, "\r\n"), original.replace(/\r\n(?:\r\n)+/g, "\r\n"));
});

console.log("persona id");
await t("路径分隔符 / .. / 保留名一律拒绝", () => {
	for (const bad of ["../x", "a/b", "a\\b", "..", "active", "", "x".repeat(65)]) {
		assert.equal(isValidId(bad), false, bad);
	}
	assert.equal(isValidId("ok-1"), true);
	const store = createStore(DATA);
	assert.equal(store.read("../../state"), null);
	assert.equal(store.remove("../../state"), false);
});

console.log("opencode");
await t("append 模式生成 push，不是整段替换", () => {
	const cwd = join(dir, "proj");
	mkdirSync(cwd, { recursive: true });
	const b = backends.opencode({ personaText: "PERSONA", mode: "append", cwd, args: [] });
	try {
		b.setup();
		const src = readFileSync(join(cwd, ".opencode", "plugin", "agent-purge.ts"), "utf8");
		assert.match(src, /output\.system\.push/);
		assert.doesNotMatch(src, /splice\(0, output\.system\.length/);
	} finally {
		b.cleanup();
	}
});

console.log("omp /purge");
await t("生成扩展、安装状态可见、卸载干净", () => {
	const r = installSlash("omp", DATA, { personaId: "alpha", personaBody: "正文 A" });
	assert.ok(r.file && existsSync(r.file));
	const src = readFileSync(r.file, "utf8");
	assert.match(src, /before_agent_start/);
	assert.match(src, /registerCommand\("purge"/);
	assert.match(src, /ompAuto/);
	assert.match(src, /if \(mode === "strict"\) return \{ systemPrompt: \[cache\.body\] \};/);
	assert.match(src, /if \(mode === "append"\) return \{ systemPrompt: \[\.\.\.hostBlocks, cache\.body\] \};/);
	assert.match(src, /if \(hostBlocks\.some\(/);
	assert.match(src, /const projectBlocks = hostBlocks\.filter/);
	assert.ok(slashStatus(DATA).find((s) => s.id === "omp")?.installed);
	uninstallSlash("omp", DATA);
	assert.equal(existsSync(r.file), false);
});

console.log("CLI 参数");
await t("--layer 被识别且不传给 pi，--ask= 会被识别", () => {
	const run = (...args) =>
		spawnSync(process.execPath, [join(process.cwd(), "bin", "agent-purge.mjs"), ...args], {
			encoding: "utf8",
			env: { ...process.env, AGENT_PURGE_HOME: DATA },
		});
	const a = run("pi", "--layer", "user", "--dry-run");
	assert.equal(a.status, 0, a.stderr);
	assert.match(a.stdout, /\[layer\]/);
	assert.match(a.stdout, /\[cmd\] pi$/m);
	const b = run("omp", "--ask=hi", "--dry-run");
	assert.equal(b.status, 0, b.stderr);
	assert.match(b.stdout, /\[cmd\] omp -p/);
	assert.match(b.stdout, / hi$/m);
	// 默认走扩展：命令行不再塞人设；--profile / --no-extensions 下默认扩展目录不加载，必须保留命令行注入
	const c = run("omp", "--dry-run");
	assert.equal(c.status, 0, c.stderr);
	assert.doesNotMatch(c.stdout, /--system-prompt/);
	const d = run("omp", "--profile", "work", "--dry-run");
	assert.equal(d.status, 0, d.stderr);
	assert.match(d.stdout, /--system-prompt/);
	const e = run("omp", "--no-extensions", "--dry-run");
	assert.equal(e.status, 0, e.stderr);
	assert.match(e.stdout, /--system-prompt/);
});

console.log(fails.length ? `\n✗ ${fails.length} 失败，${pass} 通过` : `\n✓ 全部通过：${pass} 通过，0 失败`);
for (const f of fails) console.error(" - " + f);
process.env = saved;
rmSync(dir, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
