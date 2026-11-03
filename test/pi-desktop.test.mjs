import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugin, probePlugin, pluginDir, uninstallPlugin } from "../lib/pi-desktop.mjs";

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
