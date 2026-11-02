import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

test("zcode: verify actual bundle and global AGENTS.md loader", () => {
	const zcodeDir = "D:/zcode";
	const glmCjs = join(zcodeDir, "resources/glm/zcode.cjs");
	if (!existsSync(glmCjs)) {
		// 环境中若未安装 ZCode 则跳过物理断言
		return;
	}

	const cjsCode = readFileSync(glmCjs, "utf8");

	// 1. 验证内核中存在 ~/.zcode/AGENTS.md 加载逻辑
	assert.ok(cjsCode.includes(".zcode\",\"AGENTS.md\""), "ZCode 内核包含 ~/.zcode/AGENTS.md 加载路径");

	// 2. 验证 ContextBuilder 中存在 customSystemPrompt 逻辑
	assert.ok(cjsCode.includes("customSystemPrompt"), "ZCode 内核包含 customSystemPrompt 属性");
	assert.ok(cjsCode.includes("Custom System Prompt"), "ZCode 内核包含 Custom System Prompt 注入块");

	// 3. 验证存在 UserPromptSubmit Hook 拦截事件
	assert.ok(cjsCode.includes("UserPromptSubmit"), "ZCode 内核包含 UserPromptSubmit Hook 事件");
});
