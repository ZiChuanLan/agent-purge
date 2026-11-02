import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installKilocode, kiloAgentsFile, kiloBuildAgentFile, probeKilocode, uninstallKilocode } from "../lib/kilocode.mjs";

test("kilo: code agent replace is reversible", () => {
	const dir = mkdtempSync(join(tmpdir(), "ap-kilo-"));
	const previous = process.env.KILO_CONFIG_DIR;
	process.env.KILO_CONFIG_DIR = dir;
	const agent = kiloBuildAgentFile();
	mkdirSync(join(dir, "agent"), { recursive: true });
	writeFileSync(agent, "---\ndescription: original\nmode: primary\n---\nKeep this original prompt.\n");
	try {
		const r = installKilocode(dir, { personaText: "KILO_PERSONA", mode: "replace" });
		assert.equal(r.status, "installed");
		assert.equal(r.file, agent);
		const text = readFileSync(agent, "utf8");
		assert.match(text, /agent-purge:kilo/);
		assert.match(text, /KILO_PERSONA/);
		assert.doesNotMatch(text, /Keep this original prompt/);
		assert.equal(probeKilocode(), true);
		const back = uninstallKilocode(dir);
		assert.equal(back.status, "uninstalled");
		const restored = readFileSync(agent, "utf8");
		assert.match(restored, /Keep this original prompt/);
		assert.equal(probeKilocode(), false);
	} finally {
		if (previous === undefined) delete process.env.KILO_CONFIG_DIR;
		else process.env.KILO_CONFIG_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("kilo: append mode uses managed AGENTS.md block and removes cleanly", () => {
	const dir = mkdtempSync(join(tmpdir(), "ap-kilo-append-"));
	const previous = process.env.KILO_CONFIG_DIR;
	process.env.KILO_CONFIG_DIR = dir;
	const agents = kiloAgentsFile();
	mkdirSync(dir, { recursive: true });
	writeFileSync(agents, "# Existing rules\n\nDo not remove this.\n");
	try {
		const r = installKilocode(dir, { personaText: "APPEND_PERSONA", mode: "append" });
		assert.equal(r.status, "installed");
		assert.equal(r.file, agents);
		const text = readFileSync(agents, "utf8");
		assert.match(text, /APPEND_PERSONA/);
		assert.match(text, /Do not remove this/);
		assert.equal(probeKilocode(), true);
		uninstallKilocode(dir);
		const restored = readFileSync(agents, "utf8");
		assert.match(restored, /Do not remove this/);
		assert.doesNotMatch(restored, /APPEND_PERSONA/);
	} finally {
		if (previous === undefined) delete process.env.KILO_CONFIG_DIR;
		else process.env.KILO_CONFIG_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
