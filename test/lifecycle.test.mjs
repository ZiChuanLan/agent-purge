import { isolate } from "./isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const dir = mkdtempSync(join(tmpdir(), "ap-control-"));
isolate(dir);
const root = process.env.AGENT_PURGE_HOME;
const { createStore } = await import("../lib/personas.mjs");
const { patchState, loadState } = await import("../lib/state.mjs");
const { installSlash, uninstallSlash } = await import("../lib/slashes.mjs");
const { install, uninstall, targets } = await import("../lib/persist.mjs");
const store = createStore(root); store.save("a", { body: "PERSONA_A" }); store.save("b", { body: "PERSONA_B" }); store.setActive("a");
const cli = (...args) => spawnSync(process.execPath, [resolve("bin/agent-purge.mjs"), ...args], { env: process.env, encoding: "utf8" });
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("repeat install/uninstall never restores a previous managed extension", () => {
 for (const [id, file] of [["pi", join(process.env.PI_CODING_AGENT_DIR, "extensions", "agent-purge.ts")], ["omp", join(process.env.OMP_HOME, "agent", "extensions", "agent-purge.ts")]]) {
  mkdirSync(join(file, ".."), { recursive: true }); const original = "// my extension\r\n"; writeFileSync(file, original);
  installSlash(id, root, { personaId: "a", personaBody: "PERSONA_A" }); installSlash(id, root, { personaId: "a", personaBody: "PERSONA_A" }); uninstallSlash(id, root);
  assert.equal(readFileSync(file, "utf8"), original);
 }
 const file = targets.opencode2.file(); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "// ORIGINAL\n");
 install("opencode2", { root, active: store.refreshActive() }); install("opencode2", { root, active: store.refreshActive() }); uninstall("opencode2", { root });
 assert.equal(readFileSync(file, "utf8"), "// ORIGINAL\n");
});

test("CLI launch resolves per-harness persona and ignores inherited mode/persona", () => {
 patchState(root, { default: { harness: "codex", mode: "append" }, overrides: { codex: { persona: "b", mode: "strict" } } });
 process.env.AGENT_PURGE_PERSONA = "a"; process.env.AGENT_PURGE_MODE = "append"; process.env.AGENT_PURGE_FORCE = "1";
 const r = cli("codex", "--dry-run");
 delete process.env.AGENT_PURGE_PERSONA; delete process.env.AGENT_PURGE_MODE; delete process.env.AGENT_PURGE_FORCE;
 assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /\.build[\\/]b\.md/);
});

test("off launch does not require persona or materialize files", () => {
 patchState(root, { persona: null, default: { harness: "pi", mode: "off" }, overrides: {} });
 rmSync(join(root, "personas"), { recursive: true });
 const r = cli("pi", "--mode", "off", "--dry-run");
 assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stderr, /没有|找不到.*人设/);
 assert.equal(existsSync(join(root, "personas", "active.md")), false);
 assert.equal(loadState(root).state.default.mode, "off");
});
test("CLI delimiter preserves host flags without interpreting them as agent-purge flags", () => {
 const r = cli("codex", "--mode", "off", "--dry-run", "--", "--help", "--mode", "host-only", "--ask", "host question");
 assert.equal(r.status, 0, r.stderr);
 assert.match(r.stdout, /\[cmd\].*--help.*--mode host-only.*--ask/);
 assert.doesNotMatch(r.stdout, /① 选/);
});
