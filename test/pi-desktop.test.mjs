import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugin, probePlugin, pluginDir, uninstallPlugin } from "../lib/pi-desktop.mjs";
import { extensionSource } from "../lib/extension.mjs";

// PI-Desktop 的扩展只能由插件贡献：这里验「装进 registry + 文件齐全」和「卸干净」。
function sandbox(t) {
	const dir = mkdtempSync(join(tmpdir(), "ap-pidesk-"));
	const data = join(dir, "data");
	mkdirSync(join(data, "plugins"), { recursive: true });
	writeFileSync(join(data, "plugins", "registry.json"), "[]\n", "utf8");
	process.env.PI_DESKTOP_DATA_DIR = data;
	t.after(() => {
		delete process.env.PI_DESKTOP_DATA_DIR;
		rmSync(dir, { recursive: true, force: true });
	});
	return data;
}

const registryOf = (data) => JSON.parse(readFileSync(join(data, "plugins", "registry.json"), "utf8"));

test("pi-desktop: 安装插件会写入源码/manifest/包装器并登记到 registry", (t) => {
	const data = sandbox(t);
	const r = installPlugin("C:/ap-home");
	assert.ok(r.file, r.error);
	assert.equal(existsSync(r.file), true);
	assert.equal(existsSync(join(pluginDir(), "manifest.json")), true);
	assert.equal(existsSync(join(pluginDir(), "main.cjs")), true);

	const manifest = JSON.parse(readFileSync(join(pluginDir(), "manifest.json"), "utf8"));
	assert.deepEqual(manifest.contributes.agentExtensions, ["src/agent-purge.ts"]);
	assert.deepEqual(manifest.permissions, ["agent.extension"]);

	const entry = registryOf(data).find((p) => p.id === "imported.agent-purge");
	assert.ok(entry, "registry 里没有登记");
	assert.equal(entry.enabled, true);
	assert.equal(entry.source, "dev");
	assert.equal(probePlugin(), true);
});

test("pi-desktop: 卸载会删 registry 条目和插件目录，且不碰别人的插件", (t) => {
	const data = sandbox(t);
	// 一个别人的插件目录 + 条目
	const foreign = join(data, "plugins", "imported", "someone-else");
	mkdirSync(foreign, { recursive: true });
	writeFileSync(join(foreign, "manifest.json"), JSON.stringify({ id: "imported.someone-else" }));
	writeFileSync(
		join(data, "plugins", "registry.json"),
		JSON.stringify([{ id: "imported.someone-else", enabled: true, path: foreign }], null, 2) + "\n",
	);

	installPlugin("C:/ap-home");
	assert.equal(registryOf(data).length, 2);
	const r = uninstallPlugin();
	assert.ok(r.removed.length >= 1);
	const left = registryOf(data);
	assert.deepEqual(left.map((p) => p.id), ["imported.someone-else"]);
	assert.equal(existsSync(pluginDir()), false);
	assert.equal(existsSync(foreign), true, "别人的插件目录被误删");
	assert.equal(probePlugin(), false);
});

test("pi-desktop: 没有 registry 时明确报错，不静默装一半", (t) => {
	const data = sandbox(t);
	rmSync(join(data, "plugins", "registry.json"), { force: true });
	const r = installPlugin("C:/ap-home");
	assert.match(r.error ?? "", /registry|插件登记表/);
});

// PI-Desktop 0.21 把 before_agent_start 的返回值按「会话中途 system 补丁」下发：不认补丁的模型
// （实测 mercury-3）看不到变化，认补丁的（deepseek-v4.1-flash）能换。生成代码必须同时写
// systemPromptOptions.forceSystemPrompt，走整份替换，才对所有模型生效。
test("pi-desktop: 生成的扩展把新提示词同时写进 forceSystemPrompt（含 off 撤销）", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ap-pidesk-ext-"));
	const root = join(dir, "ap");
	mkdirSync(join(root, "personas"), { recursive: true });
	writeFileSync(join(root, "personas", "alpha.md"), "---\nid: alpha\n---\nALPHA PERSONA\n", "utf8");
	const state = (on) =>
		writeFileSync(
			join(root, "state.json"),
			JSON.stringify({
				v: 1,
				persona: "alpha",
				default: { harness: "pi-desktop", mode: "replace" },
				armed: on ? { "pi-desktop": ["slash"] } : {},
				"pi-desktopAuto": true,
				piAuto: false,
				ompAuto: false,
			}) + "\n",
			"utf8",
		);
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const source = extensionSource(root, "pi-desktop");
	assert.match(source, /forceSystemPrompt = finalPrompt/, "生成代码里没有 forceSystemPrompt");
	const plugin = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
	const hooks = {};
	plugin.default({ on: (k, v) => (hooks[k] = v), registerCommand: () => {} });

	state(true);
	const event = { systemPrompt: "HOST PROMPT", systemPromptOptions: {} };
	const out = await hooks.before_agent_start(event);
	assert.match(String(out.systemPrompt), /ALPHA PERSONA/);
	assert.equal(event.systemPromptOptions.forceSystemPrompt, out.systemPrompt, "forceSystemPrompt 与返回的 prompt 不一致");

	state(false);
	const offEvent = { systemPrompt: "HOST PROMPT", systemPromptOptions: { forceSystemPrompt: "STALE" } };
	await hooks.before_agent_start(offEvent);
	assert.equal("forceSystemPrompt" in offEvent.systemPromptOptions, false, "off 后必须撤掉 forceSystemPrompt");
});
