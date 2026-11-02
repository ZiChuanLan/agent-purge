// WorkBuddy (腾讯桌面端) 模板接管层
// WorkBuddy 的所有系统提示词直接裸露在 app.asar.unpacked/resources/templates/ 下。
// 遵循 agent-purge 的足迹账本与 stash 原字节无损恢复机制。

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "./home.mjs";
import { cancel, record } from "./footprints.mjs";
import { readStash, writeStash, sha256 } from "./persist.mjs";

const DEFAULT_CANDIDATES = [
	process.env.WORKBUDDY_TEMPLATES_DIR,
	"D:/WorkBuddy/resources/app.asar.unpacked/resources/templates",
	"C:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/templates",
	join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy", "resources", "app.asar.unpacked", "resources", "templates"),
].filter(Boolean);

export const CORE_TEMPLATES = [
	"workbuddy-prompt.tpl",
	"workbuddy-expert-prompt.tpl",
	"workbuddy-craft-code-prompt.tpl",
	"workbuddy-craft-coding-prompt.tpl",
	"workbuddy-craft-design-prompt.tpl",
	"workbuddy-expert-code-prompt.tpl",
	"workbuddy-expert-coding-prompt.tpl",
	"workbuddy-ask-prompt.tpl",
	"workbuddy-ask-code-prompt.tpl",
	"workbuddy-ask-coding-prompt.tpl",
];

export function findTemplatesDir() {
	for (const dir of DEFAULT_CANDIDATES) {
		if (dir && existsSync(join(dir, "workbuddy-prompt.tpl"))) {
			return dir;
		}
	}
	return null;
}

export function patchTemplateContent(original, personaText, mode) {
	if (mode === "off") return original;
	const trimmedPersona = (personaText || "").trim();
	if (!trimmedPersona) return original;

	const marker = `<!-- agent-purge:workbuddy:${mode} -->`;

	if (mode === "strict") {
		// strict: 彻底抹去 WorkBuddy 宿主身份与内置规则，保留必要占位符
		return [
			marker,
			`This conversation is powered by {{ modelName }}`,
			"",
			trimmedPersona,
			"",
			`{{ UserInstructionsContent }}`,
			`{{ UserMemoryContent }}`,
			"",
		].join("\n");
	}

	if (mode === "append") {
		return [
			original.trim(),
			"",
			marker,
			"# Additional Instructions",
			trimmedPersona,
			"",
		].join("\n");
	}

	// replace: 替换主体指令，剥离内置限制
	// 找到 {{ WorkbuddyMemory_1 }} 或 {{ UserInstructionsContent }}
	const injectPoint = original.indexOf("{{ WorkbuddyMemory_1 }}");
	if (injectPoint !== -1) {
		const tail = original.slice(injectPoint);
		return [
			marker,
			`This conversation is powered by {{ modelName }}`,
			"",
			trimmedPersona,
			"",
			tail,
		].join("\n");
	}

	return [
		marker,
		`This conversation is powered by {{ modelName }}`,
		"",
		trimmedPersona,
		"",
		`{{ UserInstructionsContent }}`,
		`{{ UserMemoryContent }}`,
		"",
	].join("\n");
}

export function installWorkbuddy(root = dataHome(), { personaText, mode = "replace", templatesDir = findTemplatesDir() } = {}) {
	if (!templatesDir || !existsSync(templatesDir)) {
		return { status: "not-found", reason: "未检测到 WorkBuddy 模板目录" };
	}

	const touched = [];
	for (const tpl of CORE_TEMPLATES) {
		const fullPath = join(templatesDir, tpl);
		if (!existsSync(fullPath)) continue;

		const current = readFileSync(fullPath, "utf8");
		let stash = readStash(fullPath, root);
		const initial = stash?.before ?? current;

		const next = mode === "off"
			? initial
			: patchTemplateContent(initial, personaText, mode);

		if (next !== current) {
			writeStash(fullPath, { before: initial, after: next }, root);
			writeFileSync(fullPath, next, "utf8");
			record(root, {
				kind: "file",
				harness: "workbuddy",
				channel: "install",
				path: fullPath,
				sha256: sha256(next),
				undo: { type: "file-stash" },
			});
			touched.push(tpl);
		}
	}

	return { status: "installed", templatesDir, touched, mode };
}

export function uninstallWorkbuddy(root = dataHome(), { templatesDir = findTemplatesDir() } = {}) {
	if (!templatesDir || !existsSync(templatesDir)) {
		return { status: "not-found", reason: "未检测到 WorkBuddy 模板目录" };
	}

	const restored = [];
	for (const tpl of CORE_TEMPLATES) {
		const fullPath = join(templatesDir, tpl);
		if (!existsSync(fullPath)) continue;

		const current = readFileSync(fullPath, "utf8");
		const stash = readStash(fullPath, root);
		if (stash && stash.before) {
			if (current === stash.after) {
				writeFileSync(fullPath, stash.before, "utf8");
				restored.push(tpl);
			}
		}
		cancel(root, { kind: "file", harness: "workbuddy", channel: "install", path: fullPath });
	}

	return { status: "uninstalled", restored };
}
