// 在任何配置模块求值前隔离全部落点；即使单独运行测试也不借用真实用户目录。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv } from "../lib/environment.mjs";
const root = mkdtempSync(join(tmpdir(), "ap-test-env-"));
export function isolate(dir) {
	process.env = isolatedEnv(dir);
	Object.assign(process.env, { HOME: dir, USERPROFILE: dir, AGENT_PURGE_HOME: join(dir, ".agent-purge"),
		PI_CODING_AGENT_DIR: join(dir, ".pi", "agent"), PI_HOME: join(dir, ".pi", "agent"), OMP_HOME: join(dir, ".omp"),
		CODEX_HOME: join(dir, ".codex"), CLAUDE_CONFIG_DIR: join(dir, ".claude"), CODEBUDDY_HOME: join(dir, ".codebuddy"),
		GROK_HOME: join(dir, ".grok"), HERMES_HOME: join(dir, ".hermes"), DSH_HOME: join(dir, ".dsh"), ZCODE_HOME: join(dir, ".zcode"),
		XDG_CONFIG_HOME: join(dir, ".config") });
	return process.env;
}
isolate(root);
process.once("exit", () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
