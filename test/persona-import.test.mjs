import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseSource,
	parsePersonaDoc,
	sanitizeId,
	importFromDirectory,
	pullFromGitHub,
	importPersonas,
} from "../lib/persona-import.mjs";
import { createStore } from "../lib/personas.mjs";

test("parseSource 解析各种来源字符串", () => {
	// GitHub 短名
	const gh1 = parseSource("ZiChuanLan/some-magic");
	assert.equal(gh1.kind, "github");
	assert.equal(gh1.owner, "ZiChuanLan");
	assert.equal(gh1.repo, "some-magic");
	assert.equal(gh1.ref, "main");

	// GitHub 带分支
	const gh2 = parseSource("owner/repo@dev");
	assert.equal(gh2.ref, "dev");

	// GitHub 完整 URL
	const gh3 = parseSource("https://github.com/ZiChuanLan/some-magic/tree/release/prompts");
	assert.equal(gh3.kind, "github");
	assert.equal(gh3.owner, "ZiChuanLan");
	assert.equal(gh3.repo, "some-magic");
	assert.equal(gh3.ref, "release");
	assert.equal(gh3.subpath, "prompts");

	// 本地存在目录
	const tempDir = mkdtempSync(join(tmpdir(), "ap-src-test-"));
	try {
		const local = parseSource(tempDir);
		assert.equal(local.kind, "local");
		assert.equal(local.path.toLowerCase(), tempDir.toLowerCase());
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("sanitizeId 和 parsePersonaDoc 规范化元数据", () => {
	assert.equal(sanitizeId("My Persona! @#"), "my-persona");
	assert.equal(sanitizeId("active"), "persona"); // active 是保留名

	const docWithFm = `---
id: custom-bot
name: 机械姬
description: 测试人设
order: 5
harness: ["pi", "dsh"]
---
你是高级代码助手。`;
	const p1 = parsePersonaDoc(docWithFm, "fallback");
	assert.equal(p1.id, "custom-bot");
	assert.equal(p1.meta.name, "机械姬");
	assert.equal(p1.meta.order, 5);
	assert.deepEqual(p1.meta.harness, ["pi", "dsh"]);
	assert.equal(p1.body, "你是高级代码助手。");

	const docNoFm = `这是没有任何元数据的裸提示词。`;
	const p2 = parsePersonaDoc(docNoFm, "simple-agent");
	assert.equal(p2.id, "simple-agent");
	assert.equal(p2.meta.name, "simple-agent");
	assert.equal(p2.body, "这是没有任何元数据的裸提示词。");
});

test("importFromDirectory 批量导入本地文件并自动过滤", () => {
	const srcDir = mkdtempSync(join(tmpdir(), "ap-import-src-"));
	const targetRoot = mkdtempSync(join(tmpdir(), "ap-import-target-"));

	try {
		// 写入文件：2 个合法人设，1 个 README，1 个空内容，1 个隐藏文件
		writeFileSync(
			join(srcDir, "xiaomajiang.md"),
			`---\nid: xiaomajiang\nname: 小码酱\n---\n小码酱专属提示词`
		);
		writeFileSync(
			join(srcDir, "ctf.md"),
			`# CTF 模式\n挑战目标是沙箱`
		);
		writeFileSync(join(srcDir, "README.md"), `# Readme\n说明文档`);
		writeFileSync(join(srcDir, ".hidden.md"), `隐藏内容`);
		writeFileSync(join(srcDir, "empty.md"), ``);

		const res = importFromDirectory(srcDir, targetRoot, { overwrite: true });
		assert.equal(res.success, true);
		assert.equal(res.total, 2);
		assert.equal(res.imported.length, 2);

		const store = createStore(targetRoot);
		const xmj = store.read("xiaomajiang");
		assert.ok(xmj);
		assert.equal(xmj.meta.name, "小码酱");
		assert.equal(xmj.body.trim(), "小码酱专属提示词");

		const ctf = store.read("ctf");
		assert.ok(ctf);
		assert.equal(ctf.body.trim(), "# CTF 模式\n挑战目标是沙箱");

		// 测试 overwrite: false：已有文件跳过，新增文件正常导入
		writeFileSync(join(srcDir, "ctf.md"), `# CTF 模式改版`);
		writeFileSync(join(srcDir, "newbot.md"), `# 新机器人`);
		const resNoOverwrite = importFromDirectory(srcDir, targetRoot, { overwrite: false });
		assert.equal(resNoOverwrite.imported.length, 1);
		assert.equal(resNoOverwrite.imported[0].id, "newbot");
		assert.equal(resNoOverwrite.skipped.some((x) => x.id === "ctf"), true);
	} finally {
		rmSync(srcDir, { recursive: true, force: true });
		rmSync(targetRoot, { recursive: true, force: true });
	}
});

test("pullFromGitHub 模拟网络返回及 blob 降级解析", async () => {
	const targetRoot = mkdtempSync(join(tmpdir(), "ap-gh-test-"));
	const originalFetch = globalThis.fetch;

	try {
		// Mock fetch
		globalThis.fetch = async (url) => {
			const u = String(url);
			if (u.includes("/contents")) {
				return {
					ok: true,
					status: 200,
					json: async () => [
						{
							name: "magic.md",
							type: "file",
							download_url: "https://raw.mock/magic.md",
						},
						{
							name: "README.md",
							type: "file",
							download_url: "https://raw.mock/README.md",
						},
					],
				};
			}
			if (u.includes("magic.md")) {
				return {
					ok: true,
					status: 200,
					text: async () => `---\nid: magic\nname: 魔法\n---\n施展魔法`,
				};
			}
			return { ok: false, status: 404, text: async () => "Not Found" };
		};

		const res = await pullFromGitHub(
			{ owner: "mock-user", repo: "mock-repo", ref: "main", subpath: "" },
			targetRoot
		);
		assert.equal(res.success, true);
		assert.equal(res.total, 1);
		assert.equal(res.imported[0].id, "magic");

		const store = createStore(targetRoot);
		assert.ok(store.read("magic"));
		assert.equal(store.read("magic").body.trim(), "施展魔法");

		// 测试 importPersonas 统一分流入口
		const unifiedRes = await importPersonas("mock-user/mock-repo", targetRoot);
		assert.equal(unifiedRes.total, 1);
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(targetRoot, { recursive: true, force: true });
	}
});
