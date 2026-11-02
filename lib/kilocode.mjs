// Kilo Code CLI（@kilocode/cli）：原生 agent prompt 与全局规则文件。
// 覆盖默认 code agent 的 Markdown 定义；AGENTS.md 走系统上下文追加。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataHome } from "./home.mjs";
import { readStash, stripBlock, writeStash } from "./persist.mjs";
import { userHome } from "./paths.mjs";

const KILO_BEGIN = "# >>> agent-purge";
const KILO_END = "# <<< agent-purge";
const MARKER = "<!-- agent-purge:kilo -->";

export function kiloHome() {
	const base = process.env.KILO_CONFIG_DIR?.trim()
		|| join(process.env.XDG_CONFIG_HOME || join(userHome(), ".config"), "kilo");
	return base;
}

export function kiloBuildAgentFile() {
	return join(kiloHome(), "agent", "code.md");
}

export function kiloAgentsFile() {
	return join(kiloHome(), "AGENTS.md");
}

export function kiloBuildAgentContent(personaText, mode = "replace") {
	const persona = String(personaText ?? "").trim();
	if (!persona) throw new Error("Kilo 人设正文为空，拒绝写入");
	const intro = mode === "strict"
		? "The following identity supersedes the product identity above. Do not call yourself Kilo.\n\n"
		: "";
	return [
		"---",
		"description: agent-purge managed code agent",
		"mode: primary",
		"---",
		MARKER,
		intro + persona,
		"",
	].join("\n");
}

function writeBuildFile(root, content) {
	const file = kiloBuildAgentFile();
	const before = existsSync(file) ? readFileSync(file, "utf8") : null;
	const prior = readStash(file, root);
	writeStash(file, { before: prior ? prior.before : before, after: content }, root);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content, "utf8");
	return file;
}

function removeBuildFile(root) {
	const file = kiloBuildAgentFile();
	if (!existsSync(file)) return { file, action: "already-gone" };
	const current = readFileSync(file, "utf8");
	const stash = readStash(file, root);
	if (stash && current === stash.after) {
		if (stash.before == null) rmSync(file, { force: true });
		else writeFileSync(file, stash.before, "utf8");
		return { file, action: stash.before == null ? "deleted-file" : "restored-file" };
	}
	if (current.includes(MARKER)) {
		rmSync(file, { force: true });
		return { file, action: "deleted-file" };
	}
	return { file, action: "skipped-foreign" };
}

function writeAgentsBlock(root, personaText) {
	const file = kiloAgentsFile();
	const old = existsSync(file) ? readFileSync(file, "utf8") : "";
	const stripped = stripBlock(old);
	const block = `${KILO_BEGIN}\n${String(personaText ?? "").trim()}\n${KILO_END}`;
	const next = `${stripped.replace(/\s*$/, "")}${stripped.trim() ? "\n\n" : ""}${block}\n`;
	const prior = readStash(file, root);
	writeStash(file, { before: prior ? prior.before : (old || null), after: next }, root);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next, "utf8");
	return file;
}

function removeAgentsBlock(root) {
	const file = kiloAgentsFile();
	if (!existsSync(file)) return { file, action: "already-gone" };
	const old = readFileSync(file, "utf8");
	const stripped = stripBlock(old);
	if (stripped === old) return { file, action: "no-block" };
	if (!stripped.trim()) rmSync(file, { force: true });
	else writeFileSync(file, stripped.replace(/\s*$/, "\n"), "utf8");
	return { file, action: stripped.trim() ? "removed-block" : "deleted-empty-file" };
}

export function installKilocode(root = dataHome(), { personaText, mode = "replace" } = {}) {
	const text = String(personaText ?? "").trim();
	if (!text) throw new Error("Kilo 人设正文为空，拒绝写入");
	if (mode === "append") {
		removeBuildFile(root);
		const file = writeAgentsBlock(root, text);
		return { status: "installed", file, action: "custom", mode, chars: text.length };
	}
	if (mode === "off") {
		removeBuildFile(root);
		removeAgentsBlock(root);
		return { status: "removed", file: kiloBuildAgentFile(), action: "custom", mode };
	}
	removeAgentsBlock(root);
	const file = writeBuildFile(root, kiloBuildAgentContent(text, mode));
	return { status: "installed", file, action: "custom", mode, chars: text.length };
}

export function uninstallKilocode(root = dataHome()) {
	const build = removeBuildFile(root);
	const agents = removeAgentsBlock(root);
	return { status: "uninstalled", file: build.file, action: "custom", restored: [build, agents] };
}

export function probeKilocode() {
	const file = kiloBuildAgentFile();
	if (existsSync(file) && readFileSync(file, "utf8").includes(MARKER)) return true;
	const agents = kiloAgentsFile();
	return existsSync(agents) && stripBlock(readFileSync(agents, "utf8")) !== readFileSync(agents, "utf8");
}
