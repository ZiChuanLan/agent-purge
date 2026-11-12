import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { userHome } from "./paths.mjs";
import { swapFile } from "./restore.mjs";

// Kiro 的自定义 agent 把 prompt 当作主会话 system prompt；文件按 name 识别。
export const AGENT_NAME = "agent-purge";

export function kiroHome() {
	return process.env.KIRO_HOME ? resolve(process.env.KIRO_HOME) : join(userHome(), ".kiro");
}

export function kiroAgentFile() {
	return join(kiroHome(), "agents", `${AGENT_NAME}.json`);
}

export function kiroAgentSource(personaText) {
	return JSON.stringify({
		name: AGENT_NAME,
		description: "agent-purge managed persona",
		prompt: String(personaText ?? "").trim(),
	}, null, 2) + "\n";
}

/** 只在这次启动期间写；返回能把原字节还原的 undo。 */
export function temporaryKiroAgent({ personaText }) {
	const file = kiroAgentFile();
	mkdirSync(join(file, ".."), { recursive: true });
	return swapFile(file, kiroAgentSource(personaText));
}
