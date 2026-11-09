// 自测：四种 agent API × 四种模式，直接喂假的请求体，不依赖 magpie。
//   node test/magpie/hooks.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-purge-hook-"));
const { isolate } = await import("../isolate.mjs");
isolate(home);
process.env.AGENT_PURGE_HOME = home;
process.once("exit", () => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(home, "personas"), { recursive: true });
writeFileSync(
	join(home, "personas", "canary.md"),
	["---", "name: Canary", "description: 自测用", "---", "Your name is Canary-9f3a. Be terse."].join("\n"),
);
writeFileSync(join(home, "state.json"), JSON.stringify({ v: 1, persona: "canary", default: { harness: "codex", mode: "strict" } }));

const { onRequest } = await import("../../magpie-plugin/hooks.js");

const PERSONA = "Your name is Canary-9f3a. Be terse.";
const HOST = "You are Claude, made by Anthropic.\nUse the Read tool before editing.";
const stripped = "Use the Read tool before editing.";

const ctx = (protocol, options = {}, agent = "claude") => ({ protocol, agent, options, report: () => {} });

const bodies = {
	anthropic: () => ({ system: HOST, messages: [{ role: "user", content: "hi" }] }),
	chat: () => ({ messages: [{ role: "system", content: HOST }, { role: "user", content: "hi" }] }),
	responses: () => ({ instructions: HOST, input: [{ role: "user", content: "hi" }] }),
	gemini: () => ({ systemInstruction: { parts: [{ text: HOST }] }, contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
};

// anthropic 的多个 text 块在 API 里是分开的，比对时用空行拼接
const systemOf = {
	anthropic: (b) => (Array.isArray(b.system) ? b.system.map((x) => x.text).join("\n\n") : b.system),
	chat: (b) => b.messages.find((m) => m.role === "system").content,
	responses: (b) => b.instructions,
	gemini: (b) => b.systemInstruction.parts.map((x) => x.text).join("\n\n"),
};

let n = 0;
const check = (label, got, want) => {
	assert.equal(got, want, `${label}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
	n++;
};

for (const protocol of Object.keys(bodies)) {
	const sys = systemOf[protocol];

	// off：请求一个字节都不动
	const off = bodies[protocol]();
	const before = JSON.stringify(off);
	assert.equal(await onRequest(off, ctx(protocol, { mode: "off" })), undefined, `${protocol} off 应放行`);
	check(`${protocol} off 未改动`, JSON.stringify(off), before);

	// strict：整段换成人设（frontmatter 必须已经剥掉）
	const strict = bodies[protocol]();
	await onRequest(strict, ctx(protocol, { mode: "strict" }));
	check(`${protocol} strict`, sys(strict), PERSONA);

	// append：人设在前，宿主原样
	const append = bodies[protocol]();
	await onRequest(append, ctx(protocol, { mode: "append" }));
	check(`${protocol} append`, sys(append), `${PERSONA}\n\n${HOST}`);

	// replace：人设在前，宿主去掉报名字的那一行，其余留着
	const replace = bodies[protocol]();
	await onRequest(replace, ctx(protocol, { mode: "replace" }));
	check(`${protocol} replace`, sys(replace), `${PERSONA}\n\n${stripped}`);

	// 默认模式来自 state.json（strict），不给 options 也生效
	const dflt = bodies[protocol]();
	await onRequest(dflt, ctx(protocol));
	check(`${protocol} 默认取 state.mode`, sys(dflt), PERSONA);

	// agents 白名单之外的不动
	const other = bodies[protocol]();
	const otherBefore = JSON.stringify(other);
	assert.equal(await onRequest(other, ctx(protocol, { agents: ["codex"] }, "claude")), undefined);
	check(`${protocol} agents 白名单外放行`, JSON.stringify(other), otherBefore);

	// disabledAgents 排除名单内的放行
	const excluded = bodies[protocol]();
	const excludedBefore = JSON.stringify(excluded);
	assert.equal(await onRequest(excluded, ctx(protocol, { disabledAgents: ["claude"] }, "claude")), undefined);
	check(`${protocol} disabledAgents 排除生效`, JSON.stringify(excluded), excludedBefore);

	// disabledAgents 排除名单外的正常改写
	const notExcluded = bodies[protocol]();
	await onRequest(notExcluded, ctx(protocol, { disabledAgents: ["codex"], mode: "strict" }, "claude"));
	check(`${protocol} disabledAgents 排除名单外正常改写`, sys(notExcluded), PERSONA);
}

// 页面导入的人设（options.inlinePersonas）：正文里自带的 frontmatter 也要剥掉
const inlined = (extra = {}) =>
	ctx("anthropic", {
		mode: "strict",
		persona: "mine",
		inlinePersonas: [{ id: "mine", name: "Mine", text: "---\nname: Ignored\n---\nSay only OK." }],
		...extra,
	});
const inMemory = bodies.anthropic();
await onRequest(inMemory, inlined());
check("导入人设 strict", systemOf.anthropic(inMemory), "Say only OK.");

// 和磁盘上的同 id 人设并存时，导入的那份优先
writeFileSync(join(home, "personas", "dup.md"), "FROM-DISK");
const dup = bodies.anthropic();
await onRequest(
	dup,
	ctx("anthropic", { mode: "strict", persona: "dup", inlinePersonas: [{ id: "dup", name: "Dup", text: "FROM-PAGE" }] }),
);
check("导入人设优先于同名磁盘文件", systemOf.anthropic(dup), "FROM-PAGE");

// 坏数据不炸：非数组、非法 id、空正文都当没有，原样放行
for (const inlinePersonas of ["junk", [{ id: "../etc", text: "x" }], [{ id: "blank", text: "   " }], [{ id: 42 }]]) {
	const bad = bodies.anthropic();
	const label = JSON.stringify(inlinePersonas).slice(0, 30);
	assert.equal(await onRequest(bad, ctx("anthropic", { mode: "strict", persona: "blank", inlinePersonas })), undefined, `坏 ${label} 应放行`);
	check(`坏 inlinePersonas 放行 ${label}`, bad.system, HOST);
}

// 未知协议：放行
const odd = { system: "x" };
assert.equal(await onRequest(odd, ctx("cohere", { mode: "strict" })), undefined);
check("未知协议放行", odd.system, "x");

// 人设文件不存在：放行
const missing = bodies.anthropic();
assert.equal(await onRequest(missing, ctx("anthropic", { mode: "strict", persona: "no-such-persona" })), undefined);
check("人设不存在放行", missing.system, HOST);

// 坏请求体：放行，不抛
assert.equal(await onRequest(null, ctx("anthropic")), undefined);
assert.equal(await onRequest({ messages: "junk" }, ctx("chat", { mode: "append" })).then((r) => r?.messages?.[0]?.content ?? "none"), PERSONA);

// 全局暂停高于 options，克隆后的请求也恢复；恢复后分家 off 仍优先。
for (const protocol of Object.keys(bodies)) {
  const original = bodies[protocol]();
  const rewritten = structuredClone(original);
  await onRequest(rewritten, ctx(protocol, { mode: 'strict' }));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ persona: 'canary', default: { mode: 'off' }, overrides: { claude: { mode: 'strict' } } }));
  const copied = structuredClone(rewritten);
  await onRequest(copied, ctx(protocol, { mode: 'strict' }));
  check(`${protocol} global off restores exact original`, JSON.stringify(copied), JSON.stringify(original));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ persona: 'canary', default: { mode: 'replace' }, overrides: { claude: { mode: 'off' } } }));
  const disabled = bodies[protocol]();
  await onRequest(disabled, ctx(protocol, { mode: 'strict' }));
  check(`${protocol} harness off beats plugin options`, JSON.stringify(disabled), JSON.stringify(original));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ persona: 'canary', default: { mode: 'strict' } }));
}
const many = { messages: [{ role: 'system', content: 'HOST_ONE' }, { role: 'developer', content: 'HOST_TWO' }, { role: 'user', content: '<agent-purge>USER_LITERAL</agent-purge>' }] };
const beforeMany = JSON.stringify(many);
await onRequest(many, ctx('chat', { mode: 'strict' }));
check('chat strict removes every privileged host message', many.messages.filter(m => ['system','developer'].includes(m.role)).length, 1);
await onRequest(many, ctx('chat', { mode: 'off' }));
check('chat off restores all original messages', JSON.stringify(many), beforeMany);
const traversal = bodies.anthropic();
assert.equal(await onRequest(traversal, ctx('anthropic', { mode: 'strict', persona: '../secret', inlinePersonas: [{id:'../secret',text:'BAD'}] })), undefined);
check('traversal persona remains untouched', traversal.system, HOST);
writeFileSync(join(home, 'state.json'), '{bad');
assert.equal(await onRequest(bodies.anthropic(), inlined()), undefined);
rmSync(join(home, 'state.json'));
const independent = bodies.anthropic(); await onRequest(independent, inlined());
check('standalone explicit inline persona remains supported', systemOf.anthropic(independent), 'Say only OK.');

console.log(`ok — ${n} 项断言通过`);
