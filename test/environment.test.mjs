import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv } from "../lib/environment.mjs";
import { defaultSources } from "../lib/locate.mjs";

const sandbox = (t) => {
	const root = mkdtempSync(join(tmpdir(), "ap-env-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
};

test("isolatedEnv: 在 Electron 内嵌 node 下透传 ELECTRON_RUN_AS_NODE", (t) => {
	// process.execPath 是 Electron helper 时，子进程缺这个变量会以退出码 64 拒绝启动，
	// 测试里的所有 CLI 子进程（plus 真实宿主抓包）会一起塌。
	const root = sandbox(t);
	const env = isolatedEnv(root, { PATH: "/usr/bin" });
	assert.equal(env.ELECTRON_RUN_AS_NODE, undefined, "纯 node 环境不该凭空造出这个变量");

	const electron = isolatedEnv(root, { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" });
	assert.equal(electron.ELECTRON_RUN_AS_NODE, "1");
	// 透传不等于放行其它变量：隔离边界仍然只认白名单
	assert.equal(isolatedEnv(root, { ELECTRON_RUN_AS_NODE: "1", SECRET_TOKEN: "x" }).SECRET_TOKEN, undefined);
});

test("isolatedEnv: HOME 仍被改到沙盒，不泄漏真实用户目录", (t) => {
	const root = sandbox(t);
	const env = isolatedEnv(root, { HOME: "/real/home", ELECTRON_RUN_AS_NODE: "1" });
	assert.equal(env.HOME, join(root, "home"));
	assert.equal(env.USERPROFILE, join(root, "home"));
});

test("defaultSources: AGENT_PURGE_APP_DIRS 能顶掉 macOS 的 /Applications", (t) => {
	const root = sandbox(t);
	const saved = process.env.AGENT_PURGE_APP_DIRS;
	t.after(() => {
		if (saved === undefined) delete process.env.AGENT_PURGE_APP_DIRS;
		else process.env.AGENT_PURGE_APP_DIRS = saved;
	});

	delete process.env.AGENT_PURGE_APP_DIRS;
	assert.equal(defaultSources(root).appDirs, undefined, "没设覆盖时交给平台默认");

	process.env.AGENT_PURGE_APP_DIRS = `${join(root, "A")}; ${join(root, "B")};`;
	assert.deepEqual(defaultSources(root).appDirs, [join(root, "A"), join(root, "B")]);
});
