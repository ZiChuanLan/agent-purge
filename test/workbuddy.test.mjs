import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_TEMPLATES, installWorkbuddy, patchTemplateContent, uninstallWorkbuddy } from "../lib/workbuddy.mjs";
import { status } from "../lib/persist.mjs";

test("workbuddy: patchTemplateContent in strict/replace/append modes", () => {
	const original = `This conversation is powered by {{ modelName }}\n\nYour main goal is to follow the USER's instructions...\nYou are WorkBuddy.\n{{ WorkbuddyMemory_1 }}\n{{ UserInstructionsContent }}\n`;
	const persona = "You are a specialized CTF Security Researcher. Marker: AP_TEST_MARKER.";

	// 1. strict: 宿主身份被抹除，Marker 存在
	const strict = patchTemplateContent(original, persona, "strict");
	assert.match(strict, /AP_TEST_MARKER/);
	assert.doesNotMatch(strict, /You are WorkBuddy/);
	assert.match(strict, /\{\{ modelName \}\}/);
	assert.match(strict, /\{\{ UserInstructionsContent \}\}/);

	// 2. replace: 替换主指令并保留上下文占位符
	const replace = patchTemplateContent(original, persona, "replace");
	assert.match(replace, /AP_TEST_MARKER/);
	assert.doesNotMatch(replace, /Your main goal is to follow the USER's instructions/);
	assert.match(replace, /\{\{ WorkbuddyMemory_1 \}\}/);

	// 3. append: 原文保留，末尾追加
	const append = patchTemplateContent(original, persona, "append");
	assert.match(append, /You are WorkBuddy/);
	assert.match(append, /AP_TEST_MARKER/);

	// 4. off: 保持原样
	const off = patchTemplateContent(original, persona, "off");
	assert.equal(off, original);
});

test("workbuddy: install and uninstall lifecycle with stash restoration", () => {
	const dir = mkdtempSync(join(tmpdir(), "ap-wb-test-"));
	const apHome = join(dir, "ap-data");
	const tplDir = join(dir, "templates");
	mkdirSync(tplDir, { recursive: true });

	const sampleOriginal = `This conversation is powered by {{ modelName }}\n{{ WorkbuddyMemory_1 }}\n{{ UserInstructionsContent }}\n`;
	const previousTemplates = process.env.WORKBUDDY_TEMPLATES_DIR;
	process.env.WORKBUDDY_TEMPLATES_DIR = tplDir;
	writeFileSync(join(tplDir, "workbuddy-prompt.tpl"), sampleOriginal, "utf8");

	// 1. 安装 replace
	const installRes = installWorkbuddy(apHome, {
		personaText: "Test Persona 1",
		mode: "replace",
		templatesDir: tplDir,
	});
	assert.equal(installRes.status, "installed");
	assert.deepEqual(installRes.touched, ["workbuddy-prompt.tpl"]);

	const installedContent = readFileSync(join(tplDir, "workbuddy-prompt.tpl"), "utf8");
	assert.match(installedContent, /Test Persona 1/);
	assert.equal(status(apHome).find((x) => x.name === "workbuddy")?.installed, true);

	// 2. 卸载 uninstall
	const uninstallRes = uninstallWorkbuddy(apHome, { templatesDir: tplDir });
	assert.equal(uninstallRes.status, "uninstalled");
	assert.deepEqual(uninstallRes.restored, ["workbuddy-prompt.tpl"]);

	const restoredContent = readFileSync(join(tplDir, "workbuddy-prompt.tpl"), "utf8");
	assert.equal(restoredContent, sampleOriginal, "原字节完全无损还原");
	assert.equal(status(apHome).find((x) => x.name === "workbuddy")?.installed, false);

	if (previousTemplates === undefined) delete process.env.WORKBUDDY_TEMPLATES_DIR;
	else process.env.WORKBUDDY_TEMPLATES_DIR = previousTemplates;
	rmSync(dir, { recursive: true, force: true });
});
