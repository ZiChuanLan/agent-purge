import "./isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectSystemLocale, normalizeLanguageSetting, normalizeLocale, resolveLocale } from "../lib/i18n.mjs";
import { saveSettings, settingsOf } from "../lib/settings.mjs";
import { loadState } from "../lib/state.mjs";
import { isolatedEnv } from "../lib/environment.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "ap-i18n-"));
test.after(() => rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

test("i18n: locale detection follows LC_ALL -> LC_MESSAGES -> LANG and falls back to en", () => {
	assert.equal(normalizeLocale("zh_CN.UTF-8"), "zh-CN");
	assert.equal(normalizeLocale("zh-Hans"), "zh-CN");
	assert.equal(normalizeLocale("zh_TW.UTF-8"), "zh-CN");
	assert.equal(normalizeLocale("en_US.UTF-8"), "en");
	assert.equal(normalizeLocale("ja_JP.UTF-8"), "en");
	assert.equal(normalizeLocale("C"), "en");
	assert.equal(normalizeLocale("C.UTF-8"), "en");
	assert.equal(normalizeLocale("POSIX"), "en");
	assert.equal(normalizeLocale("auto"), null);

	assert.equal(detectSystemLocale({ LC_ALL: "C", LANG: "zh_CN.UTF-8" }, "linux"), "en");
	assert.equal(detectSystemLocale({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, "linux"), "zh-CN");
	assert.equal(detectSystemLocale({ LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, "linux"), "zh-CN");
	assert.equal(detectSystemLocale({ LANG: "en_US.UTF-8" }, "linux"), "en");
	assert.equal(detectSystemLocale({ LANG: "fr_FR.UTF-8" }, "linux"), "en");
	assert.equal(detectSystemLocale({}, "linux"), "en");

	assert.equal(resolveLocale({ setting: "zh-CN", env: { LANG: "en_US.UTF-8" }, platform: "linux" }), "zh-CN");
	assert.equal(resolveLocale({ setting: "en", env: { LANG: "zh_CN.UTF-8" }, platform: "linux" }), "en");
	assert.equal(resolveLocale({ setting: "auto", env: { LANG: "zh_CN.UTF-8" }, platform: "linux" }), "zh-CN");
	assert.equal(resolveLocale({ setting: "auto", env: { LANG: "en_GB.UTF-8" }, platform: "linux" }), "en");
});

test("settings: language defaults to auto and persists en / zh-CN", () => {
	const home = join(sandbox, "settings-home");
	mkdirSync(join(home, "personas"), { recursive: true });
	writeFileSync(join(home, "state.json"), JSON.stringify({ v: 1, persona: "neutral" }));
	assert.equal(settingsOf(loadState(home).state).language, "auto");
	assert.equal(normalizeLanguageSetting("en_US"), "en");
	saveSettings(home, { language: "en" });
	assert.equal(settingsOf(loadState(home).state).language, "en");
	saveSettings(home, { language: "zh-CN" });
	assert.equal(settingsOf(loadState(home).state).language, "zh-CN");
	saveSettings(home, { language: "auto" });
	assert.equal(settingsOf(loadState(home).state).language, "auto");
});

test("CLI --help respects LANG / LC_ALL and defaults to English outside Chinese locales", () => {
	const cli = resolve("bin/agent-purge.mjs");
	const runHelp = (extraEnv) => {
		const home = join(sandbox, `cli-${Math.random().toString(36).slice(2)}`);
		const env = { ...isolatedEnv(home), ...extraEnv };
		const res = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env });
		assert.equal(res.status, 0, res.stderr);
		assert.equal(existsSync(join(env.AGENT_PURGE_HOME, "state.json")), false, "--help must not initialize state");
		return res.stdout;
	};

	const enOut = runHelp({ LANG: "en_US.UTF-8" });
	assert.match(enOut, /One persona, many coding agents/);
	assert.doesNotMatch(enOut, /把任意 harness 的系统提示词换成/);

	const cOut = runHelp({ LC_ALL: "C", LANG: "zh_CN.UTF-8" });
	assert.match(cOut, /One persona, many coding agents/);

	const zhOut = runHelp({ LANG: "zh_CN.UTF-8" });
	assert.match(zhOut, /把任意 harness 的系统提示词换成/);
});
