import { isolate } from "./isolate.mjs";
// hermes 交互式启动：SOUL.md 写入 → 退出还原；--ignore-rules 不能丢（丢了自带 rules 会顶回人设）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "purge-backends-"));
const home = join(dir, "home");
const data = join(dir, "data");
mkdirSync(join(home, "hermes"), { recursive: true });
const soul = join(home, "hermes", "SOUL.md");
const persona = join(dir, "persona.md");
writeFileSync(persona, "你是 pi，不是 Hermes。\n");
const original = "原始人设：我是 Hermes\n";
writeFileSync(soul, original);

const saved = { ...process.env };
isolate(dir);
Object.assign(process.env, {
	HOME: home,
	USERPROFILE: home,
	HERMES_HOME: join(home, "hermes"),
	AGENT_PURGE_HOME: data,
});

const { backends, oneshots } = await import("../backends/index.mjs");
const { setArmed } = await import("../lib/state.mjs");

const spec = (mode, args = []) => backends.hermes({ personaPath: persona, mode, args, root: data });

test("hermes 启动参数带 --ignore-rules，off 模式不加也不写文件", () => {
	assert.deepEqual(spec("replace", ["--resume"]).args, ["--ignore-rules", "--resume"]);
	const off = spec("off", ["-x"]);
	assert.deepEqual(off.args, ["-x"]);
	off.setup();
	off.cleanup();
	assert.equal(readFileSync(soul, "utf8"), original);
});

test("setup 写 SOUL.md，cleanup 还原到安装前的字节", () => {
	const s = spec("replace");
	s.setup();
	assert.match(readFileSync(soul, "utf8"), /你是 pi，不是 Hermes。/);
	s.cleanup();
	assert.equal(readFileSync(soul, "utf8"), original);
});

test("常驻已选择时临时启动退出也恢复原字节，不把临时人设留在全局", () => {
	setArmed(data, "hermes", "install", true);
	const s = spec("replace");
	s.setup();
	assert.match(readFileSync(soul, "utf8"), /你是 pi，不是 Hermes。/);
	s.cleanup();
	assert.equal(readFileSync(soul, "utf8"), original);
	setArmed(data, "hermes", "install", false);
});
test("hermes --ask 使用同一份临时 SOUL 生命周期", () => {
	const s = oneshots.hermes({ prompt: 'QUESTION', personaText: 'ASK_PERSONA', mode: 'append' });
	assert.deepEqual(s.args, ['--ignore-rules', '-z', 'QUESTION']);
	s.setup(); assert.equal(readFileSync(soul, 'utf8'), original + '\n\nASK_PERSONA');
	s.cleanup(); assert.equal(readFileSync(soul, 'utf8'), original);
});

test.after(() => {
	Object.assign(process.env, saved);
	rmSync(dir, { recursive: true, force: true });
});
