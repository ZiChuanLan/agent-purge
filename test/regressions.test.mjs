import { isolate } from "./isolate.mjs";
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
isolate(dir);
const DATA = join(dir, ".agent-purge");
process.env.USERPROFILE = dir;
process.env.HOME = dir;
process.env.AGENT_PURGE_HOME = DATA;
for (const key of ["AGENT_PURGE_MODE", "AGENT_PURGE_PERSONA", "AGENT_PURGE_FORCE"]) delete process.env[key];
process.env.OMP_HOME = join(dir, ".omp");
process.env.CODEX_HOME = join(dir, ".codex");
process.env.DSH_HOME = join(dir, ".dsh");
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
await t("append 回调保留宿主并追加一次，重复回调不叠加", async () => {
	const cwd = join(dir, "proj");
	mkdirSync(cwd, { recursive: true });
	const b = backends.opencode({ personaText: "PERSONA", mode: "append", cwd, args: [], root: DATA });
	const { createLaunch } = await import("../lib/launch.mjs");
	writeFileSync(join(DATA, "personas", "temporary.md"), "PERSONA");
	const lease = createLaunch(DATA, "opencode", { persona: "temporary", mode: "append" });
	try {
		b.setup();
		lease.publish(process.pid, Date.now() - process.uptime() * 1000);
		process.env.AGENT_PURGE_LAUNCH = lease.token;
		const src = readFileSync(join(cwd, ".opencode", "plugin", "agent-purge.ts"), "utf8");
		const { AgentPurge } = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);
		const hook = (await AgentPurge())["experimental.chat.system.transform"];
		const output = { system: ["HOST", "tool instructions"] };
		await hook({}, output);
		assert.deepEqual(output.system, ["HOST", "tool instructions", "PERSONA"]);
		await hook({}, output);
		assert.deepEqual(output.system, ["HOST", "tool instructions", "PERSONA"]);
	} finally {
		delete process.env.AGENT_PURGE_LAUNCH;
		lease.close();
		b.cleanup();
		rmSync(join(DATA, "personas", "temporary.md"), { force: true });
	}
});

console.log("omp /purge");
await t("生成扩展、三种模式运行正确、安装状态可见、卸载干净", async () => {
	const r = installSlash("omp", DATA, { personaId: "alpha", personaBody: "正文 A" });
	assert.ok(r.file && existsSync(r.file));
	const src = readFileSync(r.file, "utf8");
	assert.match(src, /before_agent_start/);
	assert.match(src, /registerCommand\("purge"/);
	const { default: extension } = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);
	const hooks = {};
	extension({ on: (name, fn) => hooks[name] = fn, registerCommand() {} });
	const host = ["You are an AI assistant.\nTOOL RULES", "PROJECT RULES"];
	for (const mode of ["strict", "replace", "append"]) {
		writeFileSync(join(DATA, "state.json"), JSON.stringify({ persona: "alpha", default: { mode }, armed: { omp: ["slash"] }, ompAuto: true }));
		const result = await hooks.before_agent_start({ systemPrompt: host });
		const expected = mode === "strict" ? ["正文 A"] : mode === "append" ? [...host, "正文 A"] : ["正文 A", "TOOL RULES", "PROJECT RULES"];
		assert.deepEqual(result.systemPrompt, expected);
	}
	assert.ok(slashStatus(DATA).find((s) => s.id === "omp")?.installed);
	uninstallSlash("omp", DATA);
	assert.equal(existsSync(r.file), false);
	writeFileSync(join(DATA, "state.json"), JSON.stringify({ persona: "alpha", default: { harness: "pi", mode: "replace" }, armed: {} }));
});

console.log("dsh 插件");
const webProfile = join(dir, ".dsh", "profiles", "web");
const dshPatch = join(webProfile, "cordis.patch.yml");
const userPatch = "# 用户自己的补丁\n- insert:\n    - id: mine\n      name: mine\n";
mkdirSync(webProfile, { recursive: true });
writeFileSync(join(webProfile, "package.json"), JSON.stringify({ name: "web" }));
writeFileSync(dshPatch, userPatch);
const dsh = await import("../lib/dsh.mjs");
await t("删常驻块不吃掉 /purge 那段（marker 前缀撞车）", () => {
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	dsh.addPlugin(dsh.SLASH_RESIDENT, "export default {};");
	dsh.removePlugin(dsh.RESIDENT);
	const text = readFileSync(dshPatch, "utf8");
	assert.doesNotMatch(text, /^-slash$/m, text);
	assert.ok(text.includes("# >>> agent-purge:agent-purge-slash"));
	assert.equal(dsh.hasPlugin(dsh.SLASH_RESIDENT), true);
	assert.equal(dsh.hasPlugin(dsh.RESIDENT), false);
	dsh.removePlugin(dsh.SLASH_RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), userPatch);
});
await t("只有 web profile（没有 desktop）时 slashStatus 不 ENOENT", () => {
	dsh.addPlugin(dsh.SLASH_RESIDENT, "export default {};");
	const row = slashStatus(DATA).find((s) => s.id === "dsh");
	assert.equal(row?.installed, true);
	// 插件包落在数据目录（issue #11）：不再依赖某个 profile 的 node_modules
	assert.ok(row.file.startsWith(join(DATA, "dsh")), row.file);
	dsh.removePlugin(dsh.SLASH_RESIDENT);
	assert.equal(slashStatus(DATA).find((s) => s.id === "dsh")?.installed, false);
});
await t("卸常驻后重装：常驻块要真的重新挂上，不被 /purge 的 marker 骗过", () => {
	dsh.addPlugin(dsh.SLASH_RESIDENT, "export default {};");
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	dsh.removePlugin(dsh.RESIDENT);
	assert.equal(dsh.hasPlugin(dsh.RESIDENT), false);
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	const text = readFileSync(dshPatch, "utf8");
	assert.equal(dsh.hasPlugin(dsh.RESIDENT), true);
	assert.equal((text.match(/^# >>> agent-purge:agent-purge$/gm) || []).length, 1, text);
	dsh.removePlugin(dsh.RESIDENT);
	dsh.removePlugin(dsh.SLASH_RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), userPatch);
});
await t("dsh slash 对账看挂载块，不看会消失的路径", async () => {
	const { setArmed, loadState } = await import("../lib/state.mjs");
	const { reconcileArmed } = await import("../lib/armed.mjs");
	dsh.addPlugin(dsh.SLASH_RESIDENT, "export default {};");
	setArmed(DATA, "dsh", "slash", true);
	assert.deepEqual(await reconcileArmed(DATA), []);
	assert.ok(loadState(DATA).state.armed.dsh.includes("slash"));
	// 文件还在、块没了：不能谎报还在挂载
	const text = readFileSync(dshPatch, "utf8");
	writeFileSync(dshPatch, text.slice(0, text.indexOf("# >>> agent-purge:agent-purge-slash")));
	assert.deepEqual(await reconcileArmed(DATA), ["dsh:slash"]);
	assert.ok(!(loadState(DATA).state.armed.dsh ?? []).includes("slash"));
	dsh.removePlugin(dsh.SLASH_RESIDENT);
});
await t("旧版留下的孤儿 `-slash` 行：再装一次就洗掉，patch 变回合法 YAML", () => {
	// 复现 issue #4 的残留形态：整段被前缀匹配吃掉，只剩 `-slash` 尾段
	const dirty = userPatch + "-slash\n";
	writeFileSync(dshPatch, dirty);
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	const text = readFileSync(dshPatch, "utf8");
	assert.doesNotMatch(text, /^-slash$/m, text);
	assert.ok(dsh.hasPlugin(dsh.RESIDENT));
	// 剥行前留了原文备份，且第二次装不许把它冲掉
	const backup = join(webProfile, ".agent-purge.patch.healed");
	assert.equal(readFileSync(backup, "utf8"), dirty);
	dsh.removePlugin(dsh.RESIDENT);
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	assert.equal(readFileSync(backup, "utf8"), dirty, "备份被后续操作覆盖了");
	dsh.removePlugin(dsh.RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), userPatch);
	rmSync(backup, { force: true });
});
await t("块标量里缩进的 `-slash` 是用户内容，剥孤儿行不许碰", () => {
	const literal = `${userPatch}  prompt: |\n    -slash\n`;
	writeFileSync(dshPatch, literal);
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	assert.match(readFileSync(dshPatch, "utf8"), /^    -slash$/m, "把用户块标量里的字面量删了");
	assert.equal(existsSync(join(webProfile, ".agent-purge.patch.healed")), false, "没剥行却写了备份");
	dsh.removePlugin(dsh.RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), literal);
});
await t("只剩孤儿行、没有我们的块：卸载也把它剥掉", () => {
	writeFileSync(dshPatch, userPatch + "-slash\n");
	dsh.removePlugin(dsh.RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), userPatch);
});
await t("CRLF + stash 对不上时仍按整行 marker 删干净，且不啃掉 CRLF", () => {
	writeFileSync(dshPatch, userPatch);
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	// 编辑器规范化把整份换成 CRLF：stash.after 对不上，只能走 blockRe 分支
	const crlf = readFileSync(dshPatch, "utf8").replace(/\r?\n/g, "\r\n");
	writeFileSync(dshPatch, crlf);
	dsh.removePlugin(dsh.RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), userPatch.replace(/\r?\n/g, "\r\n"));
});
await t("dsh 后来新建 profile：已装的 /purge 不能判成没装（任一份在就算能用）", () => {
	dsh.addPlugin(dsh.SLASH_RESIDENT, "export default {};");
	assert.equal(slashStatus(DATA).find((s) => s.id === "dsh")?.installed, true);
	const headless = join(dir, ".dsh", "profiles", "headless");
	mkdirSync(headless, { recursive: true });
	writeFileSync(join(headless, "package.json"), JSON.stringify({ name: "headless" }));
	assert.equal(slashStatus(DATA).find((s) => s.id === "dsh")?.installed, true);
	rmSync(headless, { recursive: true, force: true });
	dsh.removePlugin(dsh.SLASH_RESIDENT);
});
await t("`[]` 空壳 + 常驻/热切双装：卸完还回 `[]`，不是 0 字节", () => {
	writeFileSync(dshPatch, "[]\n");
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	dsh.addPlugin(dsh.SLASH_RESIDENT, "export default {};");
	dsh.removePlugin(dsh.RESIDENT);
	dsh.removePlugin(dsh.SLASH_RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), "[]\n");
});
await t("dsh 模板的 `[]`：装完必须是单个合法 YAML 文档（`[]` 后面接 `- insert:` 会让 dsh 拒绝启动）", () => {
	// 真 dsh 的模板：注释 + 空数组 + 用户注释
	const template = `# Your patch layer for this dsh profile\n[]\n\n# 用户注释\n`;
	writeFileSync(dshPatch, template);
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	const text = readFileSync(dshPatch, "utf8");
	assert.doesNotMatch(text, /^[ \t]*\[[ \t]*\][ \t]*$/m, text);
	assert.match(text, /# 用户注释/, text);
	assert.ok(dsh.hasPlugin(dsh.RESIDENT), text);
	dsh.removePlugin(dsh.RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), template);
});
await t("0.2.8 装坏的 patch（`[]` + 块）：再装一次就把 `[]` 摊平，dsh 又能启动", () => {
	writeFileSync(dshPatch, "# 头部\n[]\n\n# >>> agent-purge:agent-purge\n- insert:\n    - id: agent-purge\n      name: agent-purge\n# <<< agent-purge:agent-purge\n");
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	const text = readFileSync(dshPatch, "utf8");
	assert.doesNotMatch(text, /^[ \t]*\[[ \t]*\][ \t]*$/m, text);
	assert.ok(dsh.hasPlugin(dsh.RESIDENT), text);
	dsh.removePlugin(dsh.RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), "# 头部\n[]\n");
});
await t("存量 0.2.19 现场（裸包名块 + node_modules 副本）：问一次状态就自愈成 file: URL", () => {
	// 0.2.19 的 addPlugin 把裸包名写进 patch，插件包落在 profile 的 node_modules，且没有指纹清单
	const legacyDir = join(webProfile, "node_modules", dsh.RESIDENT);
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(join(legacyDir, "package.json"), JSON.stringify({ name: dsh.RESIDENT, version: "0.0.0", type: "module", main: "index.js", agentPurge: true }));
	writeFileSync(join(legacyDir, "index.js"), "export default {};");
	// 用户升级后跑过一次 install（数据目录已有包），但没重装，盘上 patch 还是旧形态
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	const legacyPatch = "# 头部\n[]\n\n# >>> agent-purge:agent-purge\n- insert:\n    - id: agent-purge\n      name: agent-purge\n# <<< agent-purge:agent-purge\n";
	writeFileSync(dshPatch, legacyPatch);
	assert.equal(existsSync(legacyDir), true, "副本应当还在（无指纹时 addPlugin 不硬删）");

	// 关键：只问状态，不显式 install
	assert.equal(dsh.hasPluginAny(dsh.RESIDENT), true);
	const text = readFileSync(dshPatch, "utf8");
	assert.match(text, /name: 'file:\/\//, text);
	assert.doesNotMatch(text, /^[ \t]*\[[ \t]*\][ \t]*$/m, text);
	assert.match(text, /# 头部/, "自愈把用户块外的注释弄丢了");
	assert.equal(existsSync(legacyDir), false, "旧 node_modules 副本没被收走");

	// 幂等：再问一次，字节不动
	const settled = readFileSync(dshPatch, "utf8");
	dsh.hasPluginAny(dsh.RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), settled);

	dsh.removePlugin(dsh.RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), "# 头部\n[]\n");
});
await t("数据目录里没有插件包时不自愈：不把 patch 指向不存在的文件，如实报未安装", () => {
	const stale = "# 头部\n[]\n\n# >>> agent-purge:agent-purge\n- insert:\n    - id: agent-purge\n      name: agent-purge\n# <<< agent-purge:agent-purge\n";
	writeFileSync(dshPatch, stale);
	assert.equal(dsh.hasPluginAny(dsh.RESIDENT), false, "没插件包却报已装");
	assert.equal(readFileSync(dshPatch, "utf8"), stale, "没有包就不该动 patch");
});
await t("旧副本里有用户改动（有指纹但对不上）：不删，留给调用方改名保留", () => {
	writeFileSync(dshPatch, userPatch);
	const legacyDir = join(webProfile, "node_modules", dsh.RESIDENT);
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(join(legacyDir, "package.json"), JSON.stringify({ name: dsh.RESIDENT, version: "0.0.0", type: "module", main: "index.js", agentPurge: true }));
	writeFileSync(join(legacyDir, "index.js"), "改过的内容");
	writeFileSync(join(legacyDir, ".agent-purge.files.json"), JSON.stringify({ "package.json": "x", "index.js": "y" }));
	dsh.addPlugin(dsh.RESIDENT, "export default {};");
	assert.equal(existsSync(legacyDir), true, "有指纹却被硬删了");
	rmSync(join(webProfile, "node_modules"), { recursive: true, force: true });
	dsh.removePlugin(dsh.RESIDENT);
	assert.equal(readFileSync(dshPatch, "utf8"), userPatch);
});
await t("只有 web profile 时 persist.install(dsh).file 真的存在（issue #3 同源）", () => {
	writeFileSync(dshPatch, userPatch);
	const r = installTarget("dsh", { root: DATA, active: join(DATA, "personas", "alpha.md") });
	assert.ok(r.file && existsSync(r.file), JSON.stringify(r));
	uninstallTarget("dsh");
	assert.equal(readFileSync(dshPatch, "utf8"), userPatch);
});
await t("disarm dsh --all：只撤 dsh，别的 harness 不受牵连，总电源关掉", () => {
	const runCli = (...args) =>
		spawnSync(process.execPath, [join(process.cwd(), "bin", "agent-purge.mjs"), ...args], {
			encoding: "utf8",
			env: { ...process.env, AGENT_PURGE_HOME: DATA },
		});
	mkdirSync(join(DATA, "personas"), { recursive: true });
	writeFileSync(join(DATA, "personas", "alpha.md"), "测试人设\n");
	const statePath = join(DATA, "state.json");
	const savedState = existsSync(statePath) ? readFileSync(statePath, "utf8") : null; // 别把总电源关着留给后面的用例
	writeFileSync(
		statePath,
		JSON.stringify({ persona: "alpha", default: { harness: "codex", mode: "replace" }, armed: { codex: ["install"], dsh: ["install"] } }, null, 2),
	);
	try {
		const r = runCli("disarm", "dsh", "--all");
		assert.equal(r.status, 0, r.stderr);
		const st = JSON.parse(readFileSync(statePath, "utf8"));
		assert.equal(st.default.mode, "off", "总电源没关");
		assert.ok(!(st.armed?.dsh ?? []).includes("install"), "dsh 没撤干净");
		assert.ok((st.armed?.codex ?? []).includes("install"), "把没点名的 harness 一起撤了");
		assert.match(r.stdout, /总电源/, "没告诉用户总电源被动了");
	} finally {
		if (savedState === null) rmSync(statePath, { force: true });
		else writeFileSync(statePath, savedState);
	}
});
await t("没设过默认 harness 时，disarm dsh --all 也能真把总电源关掉（issue #5）", () => {
	const runCli = (...args) =>
		spawnSync(process.execPath, [join(process.cwd(), "bin", "agent-purge.mjs"), ...args], {
			encoding: "utf8",
			env: { ...process.env, AGENT_PURGE_HOME: DATA },
		});
	const statePath = join(DATA, "state.json");
	const savedState = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
	writeFileSync(statePath, JSON.stringify({ persona: "alpha", default: null, armed: { dsh: ["install"] } }));
	try {
		const r = runCli("disarm", "dsh", "--all");
		assert.equal(r.status, 0, r.stderr);
		assert.equal(JSON.parse(readFileSync(statePath, "utf8")).default?.mode, "off", "没默认 harness 时总电源没关上");
		// 关掉之后，点名启动也必须原样跑：这才是“总电源”应有的效果
		const dry = runCli("dsh", "--dry-run");
		assert.match(`${dry.stdout}${dry.stderr}`, /总电源关着/, "总电源关了却还在注入");
	} finally {
		if (savedState === null) rmSync(statePath, { force: true });
		else writeFileSync(statePath, savedState);
	}
});
await t("--layer 被识别且不传给 pi，--ask= 会被识别", () => {
	const run = (...args) =>
		spawnSync(process.execPath, [join(process.cwd(), "bin", "agent-purge.mjs"), ...args], {
			encoding: "utf8",
			env: { ...process.env, AGENT_PURGE_HOME: DATA },
		});
	const a = run("pi", "--layer", "user", "--dry-run");
	assert.equal(a.status, 0, a.stderr);
	assert.match(a.stdout, /\[layer\]/);
	assert.match(a.stdout, /\[cmd\] pi(?: -e [^\r\n]*extension-pi\.mjs)?$/m);
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
	const append = run("omp", "--mode", "append", "--dry-run");
	assert.equal(append.status, 0, append.stderr);
	assert.doesNotMatch(append.stdout, /--(?:append-)?system-prompt/);
	const direct = run("omp", "--mode", "append", "--no-extensions", "--dry-run");
	assert.equal(direct.status, 0, direct.stderr);
	assert.match(direct.stdout, /--append-system-prompt/);
});

await t("落盘类 launch 指向 personas/active.md：不经 agent-purge 直接重启也拿到当前人设", () => {
	const run = (...args) =>
		spawnSync(process.execPath, [join(process.cwd(), "bin", "agent-purge.mjs"), ...args], {
			encoding: "utf8",
			env: { ...process.env, AGENT_PURGE_HOME: DATA },
		});
	const r = run("codex", "--dry-run");
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /model_instructions_file=".*personas\/active\.md"/, "codex 还指向因人设变化的 .build/<id>.md");
	// 显式 --persona 选的不是 active 那个：必须指向它自己，不能被 active.md 顶掉
	writeFileSync(join(DATA, "personas", "beta.md"), "---\nid: beta\n---\n正文 B\n");
	const b = run("codex", "--persona", "beta", "--dry-run");
	assert.equal(b.status, 0, b.stderr);
	assert.match(b.stdout, /\.build[\\/]beta\.md/, "--persona 被 active.md 顶掉了");
	assert.doesNotMatch(b.stdout, /active\.md/);
});

console.log(fails.length ? `\n✗ ${fails.length} 失败，${pass} 通过` : `\n✓ 全部通过：${pass} 通过，0 失败`);
for (const f of fails) console.error(" - " + f);
process.env = saved;
rmSync(dir, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
