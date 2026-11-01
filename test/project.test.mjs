import { isolate } from "./isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ap-project-"));
const saved = { ...process.env };
isolate(dir);
for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "DSH_HOME", "CODEX_HOME", "OMP_HOME", "HERMES_HOME", "PI_CODING_AGENT_DIR", "PI_HOME", "CLAUDE_CONFIG_DIR", "CODEBUDDY_HOME", "GROK_HOME", "ZCODE_HOME"]) process.env[key] = join(dir, key);
process.env.AGENT_PURGE_HOME = join(dir, "data");
process.env.AGENT_PURGE_SHIM_DIR = join(dir, "bin");
for (const key of ["AGENT_PURGE_MODE", "AGENT_PURGE_FORCE", "AGENT_PURGE_PERSONA"]) delete process.env[key];
const { gitHint, projectInstall, projectStatus, projectUninstall } = await import("../lib/project.mjs");
const { listLedger } = await import("../lib/footprints.mjs");
const { applyConfiguration, changeChannel } = await import("../lib/apply.mjs");
const { createStore } = await import("../lib/personas.mjs");
const { loadState, patchState } = await import("../lib/state.mjs");
const { clean } = await import("../lib/clean.mjs");
const cli = resolve("bin/agent-purge.mjs");
test.after(() => {
	process.env = saved;
	rmSync(dir, { recursive: true, force: true });
});

function fixture(name) {
	const base = join(dir, name);
	const root = join(base, "data");
	const projects = ["a", "b", "other"].map(name => join(base, name));
	for (const path of [root, ...projects]) mkdirSync(path, { recursive: true });
	const store = createStore(root);
	store.save("alpha", { body: "PERSONA_ALPHA" });
	store.save("beta", { body: "PERSONA_BETA" });
	store.setActive("alpha");
	patchState(root, { default: { harness: "pi", mode: "replace" }, armed: {} });
	return { root, projects, store };
}

function inDirectory(path, fn) {
	const original = process.cwd;
	process.cwd = () => path;
	try { return fn(); } finally { process.cwd = original; }
}

test("project：已有的 AGENTS.md 只插托管块，off 后逐字节还原并清账本", () => {
	const root = join(dir, "p1");
	const proj = join(dir, "proj1");
	mkdirSync(proj, { recursive: true });
	const file = join(proj, "AGENTS.md");
	const original = "# 项目规则\n\n照旧。\n";
	writeFileSync(file, original);

	const r = projectInstall("pi", { root, active: "人设正文", dir: proj });
	assert.equal(r.error, undefined, r.error);
	assert.equal(r.action, "appended-block");
	const on = readFileSync(file, "utf8");
	assert.ok(on.includes("人设正文"), "块里必须是人设正文");
	assert.ok(on.startsWith("# 项目规则"), "原有内容不能挪位置或改写");
	assert.equal(projectStatus(proj, root).find((x) => x.id === "pi").on, true);
	// 同一个 AGENTS.md 被多家共用：没写块的那家不能显示成“开着”
	const omp = projectStatus(proj, root).find((x) => x.id === "omp");
	assert.deepEqual({ hasBlock: omp.hasBlock, on: omp.on }, { hasBlock: true, on: false });
	assert.equal(listLedger(root).length, 1, "写入必须登记账本");

	const off = projectUninstall("pi", { dir: proj, root });
	assert.ok(!off.error, off.error);
	assert.equal(readFileSync(file, "utf8"), original, "撤销必须逐字节还原原文件");
	assert.equal(listLedger(root).length, 0, "撤销后账本应清掉这条");
});

test("project：原本不存在的文件，off 后整个删掉而不是留空壳", () => {
	const proj = join(dir, "proj2");
	mkdirSync(proj, { recursive: true });
	const file = join(proj, "CLAUDE.md");
	const r = projectInstall("claude", { root: join(dir, "p2"), active: "人设 B", dir: proj });
	assert.equal(r.action, "created");
	assert.ok(readFileSync(file, "utf8").includes("人设 B"));
	projectUninstall("claude", { dir: proj });
	assert.equal(existsSync(file), false, "我们新建的文件应被删掉");
});

test("project：没有项目级落点的 harness 拒绝写入", () => {
	const proj = join(dir, "proj3");
	mkdirSync(proj, { recursive: true });
	const r = projectInstall("codebuddy", { root: join(dir, "p3"), active: "x", dir: proj });
	assert.match(r.error, /没有项目级规则文件/);
});

test("project：重复开同一家不叠加块", () => {
	const proj = join(dir, "proj4");
	mkdirSync(proj, { recursive: true });
	const root = join(dir, "p4");
	projectInstall("omp", { root, active: "第一版", dir: proj });
	projectInstall("omp", { root, active: "第二版", dir: proj });
	const text = readFileSync(join(proj, "AGENTS.md"), "utf8");
	assert.equal(text.match(/# >>> agent-purge/g)?.length, 1, "只能有一个托管块");
	assert.ok(text.includes("第二版") && !text.includes("第一版"), "块内容应换成新人设");
	projectUninstall("omp", { dir: proj });
});

test("project：CLI 在另一目录切人设，只同步原先登记的多个项目", () => {
	const { root, projects: [a, b, other] } = fixture("cross-directory");
	for (const path of [a, b]) {
		assert.equal(changeChannel(root, { harness: "pi", channel: "project", enabled: true, dir: path }).ok, true);
	}
	const result = spawnSync(process.execPath, [cli, "use", "beta"], {
		cwd: other, env: { ...process.env, AGENT_PURGE_HOME: root }, encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	for (const path of [a, b]) {
		const text = readFileSync(join(path, "AGENTS.md"), "utf8");
		assert.match(text, /PERSONA_BETA/);
		assert.doesNotMatch(text, /PERSONA_ALPHA/);
	}
	assert.equal(existsSync(join(other, "AGENTS.md")), false, "不能向无关的当前目录写规则");
	assert.equal(loadState(root).state.lastApply.results.length, 2, "每个项目单独报告结果");
});

test("project：跨目录暂停、换人设与恢复保留项目选择和原文件字节", () => {
	const { root, projects: [a, b, other] } = fixture("pause-resume");
	const file = join(a, "AGENTS.md");
	const created = join(b, "AGENTS.md");
	const original = "# 项目规则\r\n\r\n保留末尾空白  ";
	writeFileSync(file, original);
	for (const path of [a, b]) changeChannel(root, { harness: "pi", channel: "project", enabled: true, dir: path });
	inDirectory(other, () => {
		assert.equal(applyConfiguration(root, { persona: "beta" }).ok, true);
		assert.equal(applyConfiguration(root, { enabled: false }).ok, true);
		assert.equal(readFileSync(file, "utf8"), original);
		assert.equal(existsSync(created), false);
		assert.deepEqual(loadState(root).state.armed.pi, ["project"]);
		const status = projectStatus(a, root).find(r => r.id === "pi");
		assert.equal(status.selected, true);
		assert.equal(status.on, false);
		assert.equal(listLedger(root).length, 0, "暂停已撤销磁盘块，但应保留项目选择");
		assert.equal(applyConfiguration(root, { persona: "alpha" }).ok, true);
		assert.equal(existsSync(created), false, "暂停时切换人设不能重新写块");
		assert.equal(applyConfiguration(root, { enabled: true }).ok, true);
		for (const path of [a, b]) assert.match(readFileSync(join(path, "AGENTS.md"), "utf8"), /PERSONA_ALPHA/);
		assert.equal(existsSync(join(other, "AGENTS.md")), false);
	});
});

test("project：旧安装从账本找回目录，路径记录丢失时失败而不是猜当前目录", () => {
	const { root, projects: [a, , other] } = fixture("legacy-paths");
	projectInstall("claude", { root, active: "PERSONA_ALPHA", dir: a });
	patchState(root, { armed: { claude: ["project"] }, projectDirs: {} });
	inDirectory(other, () => {
		assert.equal(applyConfiguration(root, { persona: "beta" }).ok, true);
		assert.match(readFileSync(join(a, "CLAUDE.md"), "utf8"), /PERSONA_BETA/);
		assert.equal(existsSync(join(other, "CLAUDE.md")), false);
	});
	const missing = fixture("missing-paths");
	patchState(missing.root, { armed: { pi: ["project"] } });
	inDirectory(other, () => {
		const result = applyConfiguration(missing.root, { persona: "beta" });
		assert.equal(result.ok, false);
		assert.match(result.results[0].error, /项目.*(目录|路径)/);
		assert.equal(existsSync(join(other, "AGENTS.md")), false);
	});
});

test("project：暂停时新增选择不写入正文，无人设也能撤销该选择", () => {
	const { root, projects: [a, , other], store } = fixture("paused-selection");
	applyConfiguration(root, { enabled: false });
	const result = changeChannel(root, { harness: "pi", channel: "project", enabled: true, dir: a });
	assert.equal(result.ok, true);
	assert.equal(result.action, "selected-while-paused");
	assert.equal(existsSync(join(a, "AGENTS.md")), false);
	inDirectory(other, () => assert.equal(applyConfiguration(root, { enabled: true }).ok, true));
	assert.match(readFileSync(join(a, "AGENTS.md"), "utf8"), /PERSONA_ALPHA/);
	applyConfiguration(root, { enabled: false });
	for (const persona of store.list()) store.remove(persona.id);
	assert.equal(changeChannel(root, { harness: "pi", channel: "project", enabled: false, dir: a }).ok, true);
	assert.deepEqual(loadState(root).state.armed, {});
	assert.deepEqual(loadState(root).state.projectDirs, {});
});

test("project：移除一个项目不会取消其他项目，同步失败逐路径报告并可重试", () => {
	const { root, projects: [a, b, other] } = fixture("multiple-results");
	for (const path of [a, b]) changeChannel(root, { harness: "pi", channel: "project", enabled: true, dir: path });
	const blocked = join(a, "AGENTS.md");
	rmSync(blocked); mkdirSync(blocked);
	inDirectory(other, () => {
		const result = applyConfiguration(root, { persona: "beta" });
		assert.equal(result.ok, false);
		assert.equal(result.partial, true);
		assert.equal(result.results.find(r => r.file === blocked)?.status, "failed");
		assert.match(readFileSync(join(b, "AGENTS.md"), "utf8"), /PERSONA_BETA/);
		rmSync(blocked, { recursive: true });
		const retry = applyConfiguration(root, { onlyFailed: true });
		assert.equal(retry.ok, true);
		assert.equal(retry.results.length, 1);
		assert.equal(retry.results[0].file, blocked);
		assert.equal(existsSync(join(other, "AGENTS.md")), false);
	});
	assert.equal(changeChannel(root, { harness: "pi", channel: "project", enabled: false, dir: a }).ok, true);
	assert.deepEqual(loadState(root).state.armed.pi, ["project"]);
	assert.equal(applyConfiguration(root, { persona: "alpha" }).ok, true);
	assert.equal(existsSync(blocked), false);
	assert.match(readFileSync(join(b, "AGENTS.md"), "utf8"), /PERSONA_ALPHA/);
});

test("project：全局撤销与 clean 从无关目录执行也能清除全部项目选择", () => {
	const { root, projects: [a, b, other] } = fixture("global-remove");
	for (const path of [a, b]) changeChannel(root, { harness: "pi", channel: "project", enabled: true, dir: path });
	inDirectory(other, () => {
		assert.equal(changeChannel(root, { harness: "pi", channel: "project", enabled: false }).ok, true);
		assert.deepEqual(loadState(root).state.armed, {});
		assert.deepEqual(loadState(root).state.projectDirs, {});
		for (const path of [a, b]) assert.equal(existsSync(join(path, "AGENTS.md")), false);
		changeChannel(root, { harness: "pi", channel: "project", enabled: true, dir: a });
		applyConfiguration(root, { enabled: false });
		const result = clean(root);
		assert.equal(result.ok, true, JSON.stringify(result.steps));
		assert.deepEqual(loadState(root).state.projectDirs, {});
		assert.deepEqual(listLedger(root), []);
		assert.equal(existsSync(join(other, "AGENTS.md")), false);
	});
});

test("project：相对目录转换为绝对路径，同一目录重复启用不重复登记", () => {
	const { root, projects: [a, , other] } = fixture("relative-path");
	inDirectory(a, () => {
		assert.equal(changeChannel(root, { harness: "pi", channel: "project", enabled: true, dir: "." }).ok, true);
		assert.equal(changeChannel(root, { harness: "pi", channel: "project", enabled: true, dir: join(a, ".") }).ok, true);
	});
	assert.deepEqual(loadState(root).state.projectDirs.pi, [a]);
	assert.equal(listLedger(root).length, 1);
	inDirectory(other, () => assert.equal(applyConfiguration(root, { persona: "beta" }).ok, true));
	assert.match(readFileSync(join(a, "AGENTS.md"), "utf8"), /PERSONA_BETA/);
	assert.equal(existsSync(join(other, "AGENTS.md")), false);
});

test("project：部分撤销失败保留失败目录与通道，成功目录不会再次写入", () => {
	const { root, projects: [a, b, other] } = fixture("partial-remove");
	for (const path of [a, b]) changeChannel(root, { harness: "pi", channel: "project", enabled: true, dir: path });
	const blocked = join(a, "AGENTS.md");
	rmSync(blocked); mkdirSync(blocked);
	inDirectory(other, () => {
		const result = changeChannel(root, { harness: "pi", channel: "project", enabled: false });
		assert.equal(result.ok, false);
		assert.equal(result.results.find(r => r.file === blocked)?.status, "failed");
		assert.equal(existsSync(join(b, "AGENTS.md")), false);
		assert.deepEqual(loadState(root).state.projectDirs.pi, [a]);
		assert.deepEqual(loadState(root).state.armed.pi, ["project"]);
		assert.deepEqual(listLedger(root).map(e => e.path), [blocked]);
		rmSync(blocked, { recursive: true });
		assert.equal(changeChannel(root, { harness: "pi", channel: "project", enabled: false }).ok, true);
		assert.deepEqual(loadState(root).state.projectDirs, {});
		assert.deepEqual(loadState(root).state.armed, {});
	});
});

test("project：CLI 无参数 off 也能撤销暂停中尚未写入的项目选择", () => {
	const { root, projects: [a, , other] } = fixture("paused-cli-off");
	const run = (...args) => {
		const result = spawnSync(process.execPath, [cli, ...args], {
			cwd: other, env: { ...process.env, AGENT_PURGE_HOME: root }, encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		return result.stdout;
	};
	run("pause");
	run("project", "on", "pi", "--dir", a);
	assert.deepEqual(loadState(root).state.projectDirs.pi, [a]);
	assert.match(run("project", "status", "--dir", a), /已选，尚未写入/);
	run("project", "off", "--dir", a);
	assert.deepEqual(loadState(root).state.projectDirs, {});
	assert.deepEqual(loadState(root).state.armed, {});
	run("resume");
	assert.equal(existsSync(join(a, "AGENTS.md")), false);
	assert.equal(existsSync(join(other, "AGENTS.md")), false);
});

test("project：git 仓库里未跟踪的规则文件给提示，跟踪后不再提示", (t) => {
	const proj = join(dir, "proj5");
	mkdirSync(proj, { recursive: true });
	const git = (...args) => spawnSync("git", ["-C", proj, ...args], { encoding: "utf8" });
	if (git("--version").status !== 0) return t.skip("本机没有 git");
	git("init");
	writeFileSync(join(proj, "AGENTS.md"), "x\n");
	const hint = gitHint("pi", proj);
	assert.ok(hint && hint.includes("--skip-worktree"), `应给出不被提交的办法，实际：${hint}`);
	git("add", "AGENTS.md");
	assert.equal(gitHint("pi", proj), null, "已被跟踪的文件不该再提示");
	assert.equal(gitHint("pi", join(dir, "not-a-repo")), null, "不是 git 仓库不提示");
});
