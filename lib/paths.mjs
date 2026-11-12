// 配置落点只在这里解释。XDG_CONFIG_HOME 是配置根，PI_CODING_AGENT_DIR 是 agent 目录。
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function userHome() {
	return process.env.USERPROFILE || process.env.HOME || homedir();
}
export function configHome(id) {
	const home = userHome();
	const env = process.env;
	const roots = {
		pi: env.PI_CODING_AGENT_DIR || env.PI_HOME || join(home, ".pi", "agent"),
		omp: env.OMP_HOME || join(home, ".omp"),
		codex: env.CODEX_HOME || join(home, ".codex"),
		claude: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
		codebuddy: env.CODEBUDDY_HOME || join(home, ".codebuddy"),
		grok: env.GROK_HOME || join(home, ".grok"),
		dsh: env.DSH_HOME || join(home, ".dsh"),
		zcode: env.ZCODE_HOME || join(home, ".zcode"),
		hermes: env.HERMES_HOME || (process.platform === "win32" ? join(home, "AppData", "Local", "hermes") : join(home, ".hermes")),
		opencode: join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode"),
		kilo: env.KILO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "kilo"),
		qwen: env.QWEN_HOME || join(home, ".qwen"),
		gemini: env.GEMINI_HOME || join(home, ".gemini"),
		crush: env.CRUSH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "crush"),

		continue: env.CONTINUE_GLOBAL_DIR || join(home, ".continue"),
		qoder: env.QODER_HOME || join(home, ".qoder"),
		kimi: env.KIMI_HOME || join(home, ".kimi-code"),
		auggie: env.AUGGIE_HOME || join(home, ".augment"),
		goose: env.GOOSE_HOME || join(env.XDG_CONFIG_HOME || join(home, ".config"), "goose"),
		kiro: env.KIRO_HOME || join(home, ".kiro"),
	};
	const root = roots[id === "opencode2" ? "opencode" : id];
	return root ? resolve(root) : null;
}
