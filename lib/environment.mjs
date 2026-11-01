// 只传递运行时所需的系统变量；测试、抓包与构建 smoke 共用隔离边界。
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export function ownShimDirectory(env = process.env) {
	return resolve(env.AGENT_PURGE_SHIM_DIR || join(env.AGENT_PURGE_HOME || join(env.USERPROFILE || env.HOME || homedir(), ".agent-purge"), "bin"));
}

const INTERNAL = new Set([
	"AGENT_PURGE_FORCE", "AGENT_PURGE_MODE", "AGENT_PURGE_PERSONA",
	"AGENT_PURGE_LAUNCH", "AGENT_PURGE_LAUNCH_FILE", "AGENT_PURGE_PS_ARGS",
]);

export function launchEnvironment(env = process.env) {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !INTERNAL.has(key.toUpperCase())));
}

export function isolatedEnv(root, source = process.env) {
	const env = {};
	for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)"])
		if (source[key]) env[key] = source[key];
	env.HOME = env.USERPROFILE = join(root, "home");
	env.TEMP = env.TMP = join(root, "tmp");
	for (const key of [
		"APPDATA", "LOCALAPPDATA", "AGENT_PURGE_HOME", "AGENT_PURGE_SHIM_DIR", "AGENT_PURGE_JOURNAL_DIR",
		"PI_CODING_AGENT_DIR", "PI_HOME", "OMP_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CODEBUDDY_HOME",
		"GROK_HOME", "HERMES_HOME", "DSH_HOME", "ZCODE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
	]) env[key] = join(root, key);
	for (const value of new Set(Object.values(env))) if (value.startsWith(root)) mkdirSync(value, { recursive: true });
	Object.assign(env, {
		AGENT_PURGE_ISOLATED: "1", NO_COLOR: "1", DO_NOT_TRACK: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
		OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
	});
	return env;
}
