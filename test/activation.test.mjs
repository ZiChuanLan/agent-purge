import { isolate } from "./isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionSource } from "../lib/extension.mjs";
import { createTextRewriter, createSectionRewriter, createContentRewriter } from "../lib/rewrite.mjs";

const root = mkdtempSync(join(tmpdir(), "ap-activation-"));
isolate(root);
process.env.AGENT_PURGE_HOME = root;
mkdirSync(join(root, "personas"));
writeFileSync(join(root, "personas", "a.md"), "AP_FIXTURE_A");
writeFileSync(join(root, "personas", "b.md"), "AP_FIXTURE_B");
const base = { persona: "a", default: { mode: "append" }, armed: { pi: ["slash"], omp: ["slash"] }, piAuto: true, ompAuto: true };
function state(extra = {}) { writeFileSync(join(root, "state.json"), JSON.stringify({ ...base, ...extra })); }
let n = 0;
async function extension(id = "pi") {
	const hooks = {}, commands = {};
	const source = extensionSource(root, id) + `\n// fixture ${n++}`;
	const plugin = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
	plugin.default({ on: (key, fn) => hooks[key] = fn, registerCommand: (key, command) => commands[key] = command });
	return { hooks, commands };
}
test.after(() => rmSync(root, { recursive: true, force: true }));

test("off without provenance preserves exact whitespace, empty entries, named sections and metadata", () => {
	const texts = ["  HOST\r\n  ", "", "AP_FIXTURE_A", "# >>> agent-purge\nUSER EXAMPLE\n# <<< agent-purge\n"];
	assert.deepEqual(createTextRewriter()(texts, "", "off"), texts);
	const sections = [{ name: "agent-purge", text: "user-owned", cache_control: { type: "ephemeral" } }];
	assert.deepEqual(createSectionRewriter()(sections, "", "off"), sections);
	const content = [{ type: "text", text: "  HOST  " }, { type: "text", text: "" }, { type: "image", source: { data: "X" } }];
	assert.deepEqual(createContentRewriter()(content, "", "off"), content);
});

for (const id of ["pi", "omp"]) test(`${id}: global off suppresses override, env and session mode`, async () => {
	state(); const { hooks, commands } = await extension(id);
	await commands.purge.handler("mode strict", { ui: { notify() {} } });
	process.env.AGENT_PURGE_FORCE = "1"; process.env.AGENT_PURGE_MODE = "strict";
	state({ default: { mode: "off" }, overrides: { [id]: { mode: "strict" } } });
	const host = id === "pi" ? "  HOST\r\n  " : ["  HOST\r\n  ", ""];
	assert.deepEqual((await hooks.before_agent_start({ systemPrompt: host })).systemPrompt, host);
	delete process.env.AGENT_PURGE_FORCE; delete process.env.AGENT_PURGE_MODE;
});

test("orphan extension plus inherited FORCE grants no activation", async () => {
	state({ armed: {}, piAuto: false }); process.env.AGENT_PURGE_FORCE = "1";
	const { hooks } = await extension();
	assert.equal((await hooks.before_agent_start({ systemPrompt: "HOST" })).systemPrompt, "HOST");
	delete process.env.AGENT_PURGE_FORCE;
});

test("pi cloned context A→B→strict→off restores generated system and user prefix with attachments", async () => {
	state({ piUserLayer: true }); const { hooks } = await extension();
	const original = [{ role: "user", id: "question", content: [{ type: "text", text: "QUESTION" }, { type: "image", source: { data: "ATTACHMENT" } }] }];
	let event = { messages: structuredClone(original) };
	await hooks.context_with_system(event);
	assert.match(JSON.stringify(event), /AP_FIXTURE_A/);
	for (const extra of [{ persona: "b", piUserLayer: true }, { persona: "b", default: { mode: "strict" }, piUserLayer: true }]) {
		state(extra); event = structuredClone(event); await hooks.context_with_system(event);
		assert.doesNotMatch(JSON.stringify(event), /AP_FIXTURE_A/);
	}
	state({ default: { mode: "off" } }); event = structuredClone(event); await hooks.context_with_system(event);
	assert.deepEqual(event.messages, original);
});

test("pi untouched user labels and externally edited content survive off", async () => {
	state({ piUserLayer: true }); const { hooks } = await extension();
	const text = "<agent-purge>\nmy literal example\n</agent-purge>\n\nQUESTION";
	let event = { messages: [{ role: "system", content: "  HOST  " }, { role: "user", content: text }] };
	await hooks.context_with_system(event); event = structuredClone(event);
	state({ default: { mode: "off" } }); await hooks.context_with_system(event);
	assert.equal(event.messages[1].content, text); assert.equal(event.messages[0].content, "  HOST  ");
});
