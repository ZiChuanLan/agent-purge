import { isolate } from "./isolate.mjs";
// dsh / opencode2 常驻接管的回归测试。
// 走的是 shipped 控制面（lib/persist.mjs → lib/dsh.mjs / 插件生成），不是测试内重实现。
// 全程在临时 HOME 里跑，结束时恢复原环境变量并删目录。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

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

const dir = mkdtempSync(join(tmpdir(), "ap-harness-"));
const saved = { ...process.env };
isolate(dir);
const DATA = join(dir, ".agent-purge");
process.env.USERPROFILE = dir;
process.env.HOME = dir;
process.env.AGENT_PURGE_HOME = DATA;
process.env.DSH_HOME = join(dir, ".dsh");
// dsh 首次启动会给每个形态建 profile（带 package.json）；插件只往 dsh 建过的 profile 里写
for (const p of ["desktop", "web", "headless", "sdk"]) {
	mkdirSync(join(dir, ".dsh", "profiles", p), { recursive: true });
	writeFileSync(join(dir, ".dsh", "profiles", p, "package.json"), `{"name":"dsh-profile-${p}","private":true}`);
}
// XDG 故意不指向 home/.config：两家落点一旦分叉就必须被这条抓住
process.env.XDG_CONFIG_HOME = join(dir, "xdg");

mkdirSync(join(DATA, "personas"), { recursive: true });
writeFileSync(join(DATA, "personas", "alpha.md"), "---\nid: alpha\nname: Alpha\n---\n正文 A\n");
writeFileSync(join(DATA, "personas", "beta.md"), "---\nid: beta\nname: Beta\n---\n正文 B\n");

const { createStore } = await import("../lib/personas.mjs");
const persist = await import("../lib/persist.mjs");
const { DSH_PROFILES, RESIDENT, pluginSpecifier } = await import("../lib/dsh.mjs");

const store = createStore(DATA);
store.setActive("alpha");
const yml = (p) => join(dir, ".dsh", "profiles", p, "cordis.patch.yml");

try {
	console.log("\ndsh 常驻");
	await t("install 只写一份插件包，但每个已有 profile 都挂 patch 段", () => {
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		assert.ok(existsSync(join(DATA, "dsh", RESIDENT, "index.js")), "数据目录缺 index.js");
		for (const p of DSH_PROFILES) {
			assert.match(readFileSync(yml(p), "utf8"), new RegExp(`# >>> ${RESIDENT}`), `${p} 的 patch 没挂上`);
			assert.ok(!existsSync(join(dir, ".dsh", "profiles", p, "node_modules", RESIDENT)), `${p} 不该再往 node_modules 里写`);
		}
	});
	await t("patch 里挂了一次 insert 段", () => {
		const text = readFileSync(yml("desktop"), "utf8");
		assert.equal(text.split(`# >>> ${RESIDENT}`).length - 1, 1);
		assert.match(text, /- insert:\n    - id: agent-purge\n      name: 'file:\/\/\/.*agent-purge\/index\.js'/);
	});
	await t("重复 install 幂等（不会写两段）", () => {
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		const text = readFileSync(yml("desktop"), "utf8");
		assert.equal(text.split(`# >>> ${RESIDENT}`).length - 1, 1);
	});
	await t("插件读的是 personas/active.md（换 persona 才能热切）", () => {
		const src = readFileSync(join(DATA, "dsh", RESIDENT, "index.js"), "utf8");
		assert.match(src, /personas[\/\\]active\.md/);
		assert.doesNotMatch(src, /\.build[\/\\]alpha\.md/);
	});
	await t("uninstall 后 patch 字节级还原（含边界形态）", () => {
		const cases = ["- id: x\n  name: y\n", "- id: x\n  name: y", "- id: x\r\n  name: y\r\n", "- id: x\n\n"];
		for (const before of cases) {
			writeFileSync(yml("desktop"), before);
			persist.install("dsh", { root: DATA, active: store.refreshActive() });
			assert.notEqual(readFileSync(yml("desktop"), "utf8"), before, "install 没写进去");
			persist.uninstall("dsh");
			assert.equal(readFileSync(yml("desktop"), "utf8"), before, `还原失败：${JSON.stringify(before)}`);
		}
	});
	await t("uninstall 清掉数据目录的插件包和所有 profile 里的旧副本", () => {
		assert.ok(!existsSync(join(DATA, "dsh", RESIDENT)), "数据目录还留着");
		for (const p of DSH_PROFILES) {
			assert.ok(!existsSync(join(dir, ".dsh", "profiles", p, "node_modules", RESIDENT)), `${p} 还留着旧副本`);
		}
	});
	await t("status 报未安装", () => {
		const row = persist.status(DATA).find((r) => r.name === "dsh");
		assert.equal(row.installed, false);
	});

	console.log("\nopencode2 常驻");
	const v2file = () => join(dir, "xdg", "opencode", "plugins", "agent-purge-v2.ts");
	await t("install 写 v2 专属文件，不碰 v1 的 agent-purge.ts", () => {
		persist.install("opencode2", { root: DATA, active: store.refreshActive() });
		assert.ok(existsSync(v2file()), "缺 agent-purge-v2.ts");
		assert.ok(!existsSync(join(dir, "xdg", "opencode", "plugins", "agent-purge.ts")), "不应写 v1 文件");
	});
	await t("插件用 v2 API（session.hook context）", () => {
		const src = readFileSync(v2file(), "utf8");
		assert.match(src, /ctx\.session\.hook\("context"/);
		assert.doesNotMatch(src, /experimental\.chat\.system\.transform/);
	});
	await t("插件读 active.md", () => {
		const source = readFileSync(v2file(), "utf8");
		const literal = source.match(/const ACTIVE = ("[^\n]+");/);
		assert.ok(literal);
		assert.equal(JSON.parse(literal[1]), join(DATA, "personas", "active.md"));
	});
	await t("换 persona 后同一插件读到新正文（热切路径）", () => {
		store.setActive("beta");
		const activeSrc = readFileSync(join(DATA, "personas", "active.md"), "utf8");
		assert.match(activeSrc, /正文 B/);
		assert.ok(existsSync(v2file()), "换 persona 不该删插件");
	});
	await t("uninstall 删掉托管文件", () => {
		persist.uninstall("opencode2");
		assert.ok(!existsSync(v2file()));
	});

	console.log("\n运行时开关（跑生成插件的真实回调，不只看源码）");
	const { pathToFileURL } = await import("node:url");
	const stateFile = join(DATA, "state.json");
	const writeState = (armed, mode) =>
		writeFileSync(stateFile, JSON.stringify({ v: 1, persona: "beta", default: { harness: "dsh", mode }, armed }));
	const loadPlugin = async (file, tag) => {
		// engines 写的是 node>=20，而 20 不能直接 import .ts：先搭成 .mjs 再加载
		const src = file.endsWith(".ts") ? file.replace(/\.ts$/, `.${tag}.mjs`) : file;
		if (src !== file) writeFileSync(src, readFileSync(file, "utf8"));
		return (await import(`${pathToFileURL(src).href}?${tag}`)).default;
	};

	await t("armed 有 install 时 dsh 插件真注入", async () => {
		store.setActive("beta");
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		writeState({ dsh: ["install"] }, "replace");
		const plugin = await loadPlugin(join(DATA, "dsh", RESIDENT, "index.js"), "armed");
		const ctx = { systemPrompt: { assemble: async () => ({ sections: [{ name: "host", text: "HOST" }] }) } };
		plugin.apply(ctx);
		const asm = await ctx.systemPrompt.assemble();
		assert.match(asm.sections[0].text, /正文 B/);
		// replace：人设在前，宿主 section 保留（只删“自称 + 点名厂商”的行）
		assert.equal(asm.sections.length, 2);
		assert.equal(asm.sections[1].text, "HOST");
	});
	await t("armed 被清掉后同一插件停止注入（磁盘卸载后的残存回调）", async () => {
		writeState({}, "replace");
		const plugin = await loadPlugin(join(DATA, "dsh", RESIDENT, "index.js"), "disarmed");
		const ctx = { systemPrompt: { assemble: async () => ({ sections: [{ name: "host", text: "HOST" }] }) } };
		plugin.apply(ctx);
		const asm = await ctx.systemPrompt.assemble();
		assert.equal(asm.sections[0].text, "HOST", "未武装却仍改了 sections");
	});
	await t("mode off 时即使 armed 也放过宿主结果", async () => {
		writeState({ dsh: ["install"] }, "off");
		const plugin = await loadPlugin(join(DATA, "dsh", RESIDENT, "index.js"), "offmode");
		const ctx = { systemPrompt: { assemble: async () => ({ sections: [{ name: "host", text: "HOST" }] }) } };
		plugin.apply(ctx);
		assert.equal((await ctx.systemPrompt.assemble()).sections[0].text, "HOST");
	});

	// 零伤害的核心：宿主的 assemble 可能是同步的，包装层不能把它变成 Promise
	await t("宿主 assemble 同步：开启时同步注入，关闭时同步原样返回", async () => {
		store.setActive("beta");
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		const desktop = join(DATA, "dsh", RESIDENT, "index.js");
		const hostAsm = { sections: [{ name: "host", text: "HOST" }] };
		const mk = () => ({ systemPrompt: { assemble: () => hostAsm } });
		writeState({ dsh: ["install"] }, "replace");
		let plugin = await loadPlugin(desktop, "sync-on");
		let ctx = mk();
		plugin.apply(ctx);
		let out = ctx.systemPrompt.assemble();
		assert.ok(!(out && typeof out.then === "function"), "开启态把同步 assemble 变成了 Promise");
		assert.match(out.sections[0].text, /正文 B/);

		writeState({ dsh: ["install"] }, "off");
		plugin = await loadPlugin(desktop, "sync-off");
		ctx = mk();
		plugin.apply(ctx);
		out = ctx.systemPrompt.assemble();
		assert.ok(!(out && typeof out.then === "function"), "关闭态把同步 assemble 变成了 Promise");
		assert.equal(out, hostAsm, "关闭态返回的不是宿主原对象（多包了一层）");
		assert.equal(out.sections[0].text, "HOST");
	});

	await t("dshProfiles 只让勾中的形态注入", async () => {
		store.setActive("beta");
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		// 插件包只有一份（数据目录），profile 靠宿主 profileContext 报给插件
		const mk = (profile) => ({
			get: (key) => (key === "profileContext" ? { name: profile } : undefined),
			systemPrompt: { assemble: async () => ({ sections: [{ name: "host", text: "HOST" }] }) },
		});
		const file = join(DATA, "dsh", RESIDENT, "index.js");
		writeFileSync(
			stateFile,
			JSON.stringify({ v: 1, persona: "beta", default: { harness: "dsh", mode: "replace" }, armed: { dsh: ["install"] }, dshProfiles: ["web"] }),
		);

		let plugin = await loadPlugin(file, "prof-desktop-off");
		let ctx = mk("desktop");
		plugin.apply(ctx);
		assert.equal((await ctx.systemPrompt.assemble()).sections[0].text, "HOST", "desktop 没勾却注入了");

		plugin = await loadPlugin(file, "prof-web-on");
		ctx = mk("web");
		plugin.apply(ctx);
		assert.match((await ctx.systemPrompt.assemble()).sections[0].text, /正文 B/, "web 勾了却没注入");
	});
	await t("opencode2 插件同样按 armed 开关", async () => {
		store.setActive("beta");
		persist.install("opencode2", { root: DATA, active: store.refreshActive() });
		const hookOf = async (tag) => {
			const plugin = await loadPlugin(v2file(), tag);
			let cb = null;
			await plugin.setup({ session: { hook: (_n, fn) => { cb = fn; } } });
			return cb;
		};
		writeState({ opencode2: ["install"] }, "replace");
		let hook = await hookOf("on");
		let ev = { system: [{ type: "text", text: "HOST" }] };
		hook(ev);
		assert.match(ev.system[0].text, /正文 B/);
		writeState({}, "replace");
		hook = await hookOf("off");
		ev = { system: [{ type: "text", text: "HOST" }] };
		hook(ev);
		assert.equal(ev.system[0].text, "HOST", "未武装却仍改 system");
	});
	await t("同名但非我们装的目录拒绝覆盖（数据目录里的同名插件）", () => {
		const dir2 = mkdtempSync(join(tmpdir(), "ap-foreign-"));
		const home2 = join(dir2, ".agent-purge");
		const savedProfile = process.env.DSH_HOME;
		const savedHome = process.env.AGENT_PURGE_HOME;
		try {
			mkdirSync(join(dir2, ".dsh", "profiles", "desktop"), { recursive: true });
			writeFileSync(join(dir2, ".dsh", "profiles", "desktop", "package.json"), '{"name":"dsh-profile-desktop"}');
			mkdirSync(join(home2, "dsh", RESIDENT), { recursive: true });
			writeFileSync(join(home2, "dsh", RESIDENT, "package.json"), '{"name":"someone-else"}');
			process.env.DSH_HOME = join(dir2, ".dsh");
			process.env.AGENT_PURGE_HOME = home2;
			const r = persist.install("dsh", { root: DATA, active: store.refreshActive() });
			assert.match(r.error ?? "", /拒绝覆盖/, "应返回 {error} 而不是抛：Web/CLI 都没接异常");
		} finally {
			process.env.DSH_HOME = savedProfile;
			process.env.AGENT_PURGE_HOME = savedHome;
			rmSync(dir2, { recursive: true, force: true });
		}
	});
	await t("没建过的 profile 不碰（dsh 会拒绝启动）", () => {
		const savedProfile = process.env.DSH_HOME;
		const dir4 = mkdtempSync(join(tmpdir(), "ap-live-"));
		try {
			// 只模拟用户跑过 desktop：web / headless 目录 dsh 还没建
			mkdirSync(join(dir4, ".dsh", "profiles", "desktop"), { recursive: true });
			writeFileSync(join(dir4, ".dsh", "profiles", "desktop", "package.json"), '{"name":"dsh-profile-desktop"}');
			process.env.DSH_HOME = join(dir4, ".dsh");
			const r = persist.install("dsh", { root: DATA, active: store.refreshActive() });
			assert.equal(r.error ?? "", "");
			// 插件包在数据目录（与 profile 无关），patch 才按活着的 profile 挂
			assert.ok(existsSync(join(DATA, "dsh", RESIDENT, "index.js")), "插件包应该写到数据目录");
			assert.match(readFileSync(join(dir4, ".dsh", "profiles", "desktop", "cordis.patch.yml"), "utf8"), /agent-purge:agent-purge/, "desktop 的 patch 应该挂上");
			assert.ok(!existsSync(join(dir4, ".dsh", "profiles", "web")), "不该凭空造 web profile（dsh 才该造）");
			assert.ok(!existsSync(join(dir4, ".dsh", "profiles", "headless")), "不该凭空造 headless profile");
		} finally {
			process.env.DSH_HOME = savedProfile;
			rmSync(dir4, { recursive: true, force: true });
		}
	});
	await t("patch 原本是 `[]` 时安装后仍是合法 YAML", () => {
		writeFileSync(yml("web"), "[]\n");
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		const text = readFileSync(yml("web"), "utf8");
		assert.doesNotMatch(text, /\]\s*\n\s*- insert/, "`[]` 后面接了列表项，YAML 非法");
		assert.match(text, /^# >>> agent-purge:/, "应该整份换成托管段");
		persist.uninstall("dsh");
	});
	await t("中途失败回滚，不留半套", () => {
		const savedProfile = process.env.DSH_HOME;
		const savedHome = process.env.AGENT_PURGE_HOME;
		const dir3 = mkdtempSync(join(tmpdir(), "ap-rollback-"));
		const home3 = join(dir3, ".agent-purge");
		try {
			// desktop 先写成功；web 的 patch 位置上放一个目录，writeFileSync 必失败
			const webProfile = join(dir3, ".dsh", "profiles", "web");
			mkdirSync(webProfile, { recursive: true });
			writeFileSync(join(webProfile, "package.json"), '{"name":"dsh-profile-web"}');
			mkdirSync(join(dir3, ".dsh", "profiles", "desktop"), { recursive: true });
			writeFileSync(join(dir3, ".dsh", "profiles", "desktop", "package.json"), '{"name":"dsh-profile-desktop"}');
			mkdirSync(join(webProfile, "cordis.patch.yml"), { recursive: true });
			process.env.DSH_HOME = join(dir3, ".dsh");
			process.env.AGENT_PURGE_HOME = home3;
			const deskPlugin = join(home3, "dsh", RESIDENT);
			const deskYml = join(dir3, ".dsh", "profiles", "desktop", "cordis.patch.yml");
			const deskStash = join(dir3, ".dsh", "profiles", "desktop", ".agent-purge.patch.before");
			writeFileSync(deskYml, "[]\n");
			const r = persist.install("dsh", { root: DATA, active: store.refreshActive() });
			assert.ok(r.error, "应该以 {error} 报错");
			assert.equal(existsSync(deskPlugin), false, "失败后插件目录残留");
			assert.equal(readFileSync(deskYml, "utf8"), "[]\n", "失败后 desktop patch 没回原样");
			assert.equal(existsSync(deskStash), false, "失败后 stash 残留（回滚没盖住 stash）");
		} finally {
			process.env.DSH_HOME = savedProfile;
			process.env.AGENT_PURGE_HOME = savedHome;
			rmSync(dir3, { recursive: true, force: true });
		}
	});
	await t("回滚：原本没有 patch 文件就删掉，新写的插件也一起撤回", () => {
		const savedProfile = process.env.DSH_HOME;
		const savedHome = process.env.AGENT_PURGE_HOME;
		const dir5 = mkdtempSync(join(tmpdir(), "ap-rollback2-"));
		const home5 = join(dir5, ".agent-purge");
		try {
			const webProfile = join(dir5, ".dsh", "profiles", "web");
			mkdirSync(webProfile, { recursive: true });
			writeFileSync(join(webProfile, "package.json"), '{"name":"dsh-profile-web"}');
			mkdirSync(join(dir5, ".dsh", "profiles", "desktop"), { recursive: true });
			writeFileSync(join(dir5, ".dsh", "profiles", "desktop", "package.json"), '{"name":"dsh-profile-desktop"}');
			mkdirSync(join(webProfile, "cordis.patch.yml"), { recursive: true });
			process.env.DSH_HOME = join(dir5, ".dsh");
			process.env.AGENT_PURGE_HOME = home5;
			const deskYml = join(dir5, ".dsh", "profiles", "desktop", "cordis.patch.yml");
			const r = persist.install("dsh", { root: DATA, active: store.refreshActive() });
			assert.ok(r.error, "应该以 {error} 报错");
			assert.equal(existsSync(join(home5, "dsh", RESIDENT)), false, "失败后插件目录残留");
			assert.equal(existsSync(deskYml), false, "原本没这个 patch，回滚后却留下了");
		} finally {
			process.env.DSH_HOME = savedProfile;
			process.env.AGENT_PURGE_HOME = savedHome;
			rmSync(dir5, { recursive: true, force: true });
		}
	});
	await t("重装失败：已经装好的插件不能被回滚删掉（否则 patch 指向不存在的文件）", () => {
		persist.uninstall("dsh");
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		const pluginDirNow = join(DATA, "dsh", RESIDENT);
		const pluginSrc = readFileSync(join(pluginDirNow, "index.js"), "utf8");
		assert.equal(existsSync(pluginDirNow), true, "前置：先得装好一份");
		const webProfile = join(dir, ".dsh", "profiles", "web");
		mkdirSync(webProfile, { recursive: true });
		writeFileSync(join(webProfile, "package.json"), '{"name":"dsh-profile-web"}');
		rmSync(join(webProfile, "cordis.patch.yml"), { recursive: true, force: true });
		mkdirSync(join(webProfile, "cordis.patch.yml"), { recursive: true });
		const r = persist.install("dsh", { root: DATA, active: store.refreshActive() });
		assert.ok(r.error, "应该以 {error} 报错");
		assert.equal(existsSync(pluginDirNow), true, "回滚把之前就装好的插件删了");
		assert.equal(readFileSync(join(pluginDirNow, "index.js"), "utf8"), pluginSrc, "回滚把之前就装好的插件改坏了");
		persist.uninstall("dsh");
		rmSync(join(webProfile, "cordis.patch.yml"), { recursive: true, force: true });
	});
	await t("空文件 / `[]` / 不存在：卸载后字节还原", () => {		for (const content of [null, "", "[]\n"]) {
			persist.uninstall("dsh");
			rmSync(yml("desktop"), { force: true });
			if (content !== null) writeFileSync(yml("desktop"), content);
			persist.install("dsh", { root: DATA, active: store.refreshActive() });
			assert.match(readFileSync(yml("desktop"), "utf8"), /agent-purge:agent-purge/, "没挂上段");
			persist.uninstall("dsh");
			if (content === null) assert.equal(existsSync(yml("desktop")), false, "原本没这个文件，卸载后却留下了");
			else assert.equal(readFileSync(yml("desktop"), "utf8"), content, "卸载没字节还原");
		}
	});
	await t("uninstall 顺带清一次性插件残留", () => {
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		// 模拟被 SIGKILL 的一次性插件：cleanup 没跑成
		const sess = join(DATA, "dsh", "agent-purge-session");
		mkdirSync(sess, { recursive: true });
		writeFileSync(join(sess, "package.json"), JSON.stringify({ name: "agent-purge-session", agentPurge: true }));
		writeFileSync(join(sess, "index.js"), "export default {};");
		persist.uninstall("dsh");
		assert.equal(existsSync(sess), false, "一次性插件残留没清");
	});
	await t("卸载保留用户修改或新增的 DSH 插件文件；重装不覆盖外部编辑", () => {
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		const plugin = join(DATA, "dsh", RESIDENT);
		const edited = readFileSync(join(plugin, "index.js"), "utf8") + "\n// user change\n";
		writeFileSync(join(plugin, "index.js"), edited);
		writeFileSync(join(plugin, "notes.txt"), "PRIVATE NOTES");
		assert.match(persist.install("dsh", { root: DATA, active: store.refreshActive() }).error, /外部修改/);
		persist.uninstall("dsh");
		assert.equal(existsSync(plugin), false);
		assert.equal(readFileSync(`${plugin}.disabled-by-agent-purge/index.js`, "utf8"), edited);
		assert.equal(readFileSync(`${plugin}.disabled-by-agent-purge/notes.txt`, "utf8"), "PRIVATE NOTES");
	});
	await t("caps 认得两家的热切", async () => {
		const caps = await import("../lib/caps.mjs");
		assert.equal(caps.capsFor("dsh").hot.ok, true, "dsh 被当成不能热切");
		assert.equal(caps.capsFor("opencode2").hot.ok, true, "opencode2 被当成不能热切");
	});

	console.log("\n边界");
	await t("uninstall 不依赖 persona 还在", () => {
		store.setActive("alpha");
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		rmSync(join(DATA, "personas", "alpha.md"));
		assert.doesNotThrow(() => persist.uninstall("dsh"));
	});
	await t("两个目标可同时安装、各自独立卸载", () => {
		store.setActive("beta");
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		persist.install("opencode2", { root: DATA, active: store.refreshActive() });
		assert.ok(existsSync(join(DATA, "dsh", RESIDENT, "index.js")));
		assert.ok(existsSync(v2file()));
		persist.uninstall("dsh");
		assert.ok(existsSync(v2file()), "卸 dsh 不该动 opencode2");
		persist.uninstall("opencode2");
	});
	await t("路径带单引号/空格/中文：patch 仍是合法 YAML 且能还原", () => {
		const savedProfile = process.env.DSH_HOME;
		const savedHome = process.env.AGENT_PURGE_HOME;
		const weird = join(mkdtempSync(join(tmpdir(), "ap-quote-")), "a b 'c' 中文");
		const home6 = join(weird, "data");
		const dsh6 = join(weird, "dsh");
		try {
			mkdirSync(join(dsh6, "profiles", "web"), { recursive: true });
			writeFileSync(join(dsh6, "profiles", "web", "package.json"), '{"name":"dsh-profile-web"}');
			process.env.DSH_HOME = dsh6;
			process.env.AGENT_PURGE_HOME = home6;
			persist.install("dsh", { root: DATA, active: store.refreshActive() });
			const patch = join(dsh6, "profiles", "web", "cordis.patch.yml");
			const line = readFileSync(patch, "utf8").split("\n").find((l) => l.includes("      name: "));
			// YAML 单引号标量里 `'` 必须双写成 `''`，否则整份 patch 解析失败
			assert.match(line, /^      name: '.*''.*'$/, line);
			const scalar = line.trim().replace(/^name: /, "");
			assert.equal(scalar.slice(1, -1).replace(/''/g, "'"), pluginSpecifier(RESIDENT));
			persist.uninstall("dsh");
			assert.equal(existsSync(patch), false, "原本没有 patch，卸载后该删掉");
		} finally {
			process.env.DSH_HOME = savedProfile;
			process.env.AGENT_PURGE_HOME = savedHome;
			rmSync(weird, { recursive: true, force: true });
		}
	});
	await t("迁移旧布局后不留空 node_modules", () => {
		const profile = join(dir, ".dsh", "profiles", "desktop");
		const legacy = join(profile, "node_modules", RESIDENT);
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "package.json"), JSON.stringify({ name: RESIDENT, agentPurge: true }));
		writeFileSync(join(legacy, "index.js"), "export default {};");
		const pkg = readFileSync(join(legacy, "package.json"));
		const src = readFileSync(join(legacy, "index.js"));
		const h = (b) => createHash("sha256").update(b).digest("hex");
		writeFileSync(join(legacy, ".agent-purge.files.json"), JSON.stringify({ "package.json": h(pkg), "index.js": h(src) }));
		persist.install("dsh", { root: DATA, active: store.refreshActive() });
		assert.equal(existsSync(legacy), false, "旧副本没清");
		assert.equal(existsSync(join(profile, "node_modules")), false, "留下空 node_modules");
		persist.uninstall("dsh");
	});
} finally {
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fails.length ? "✗ 失败" : "✓ 全部通过"}：${pass} 通过，${fails.length} 失败`);
if (fails.length) {
	for (const f of fails) console.log(`  - ${f}`);
	process.exit(1);
}
