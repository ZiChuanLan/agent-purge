import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { userHome } from "./paths.mjs";
import { swapFile } from "./restore.mjs";

// Kimi Code 的 agent file：frontmatter 描述 agent，Markdown 正文成为该 agent 的 system prompt。
export const AGENT_NAME = "agent-purge";

export function kimiHome() {
	return process.env.KIMI_HOME ? resolve(process.env.KIMI_HOME) : join(userHome(), ".kimi-code");
}

export function kimiAgentFile() {
	return join(kimiHome(), "agents", `${AGENT_NAME}.md`);
}

export function kimiAgentSource(personaText) {
	return `---\nname: ${AGENT_NAME}\ndescription: agent-purge managed persona\n---\n\n${String(personaText ?? "").trim()}\n`;
}

/** 只在这次启动期间写；返回能把原字节还原的 undo。 */
export function temporaryKimiAgent({ personaText }) {
	const file = kimiAgentFile();
	mkdirSync(join(file, ".."), { recursive: true });
	return swapFile(file, kimiAgentSource(personaText));
}
