// 足迹账本保留写入路径、所有者与还原方式；损坏时保留原文件并停止销账。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicControlJSON, withControlLock } from "./control.mjs";

const keyOf = path => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const sameLocation = (a, b) => (a.kind ?? "file") === (b.kind ?? "file") && keyOf(a.path) === keyOf(b.path);
const sameOwner = (a, b) => sameLocation(a, b) && a.harness === b.harness && a.channel === b.channel;
const idOf = entry => createHash("sha256").update([entry.kind ?? "file", keyOf(entry.path), entry.harness ?? "", entry.channel ?? ""].join("\0")).digest("hex").slice(0, 24);
export const ledgerFile = root => join(root, "footprints.json");

export function loadLedger(root) {
	const file = ledgerFile(root);
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(raw?.entries) || raw.entries.some(e => !e || typeof e.path !== "string" || !e.path || typeof e.undo?.type !== "string")) throw new Error("账本结构无效");
		return { version: 1, entries: raw.entries };
	} catch (error) {
		if (error.code === "ENOENT") return { version: 1, entries: [] };
		throw new Error(`足迹账本损坏，原文件已保留：${file}`, { cause: error });
	}
}
export function saveLedger(root, entries) {
	return withControlLock(root, () => atomicControlJSON(ledgerFile(root), { version: 1, entries }));
}

/** 同一位置、harness、channel 幂等；共享 PATH 不会互相覆盖所有权。 */
export function record(root, entry) {
	if (!entry?.path || !entry?.undo?.type) throw new Error("足迹缺少路径或撤销方式");
	return withControlLock(root, () => {
		const ledger = loadLedger(root), at = ledger.entries.findIndex(e => sameOwner(e, entry));
		const previous = at >= 0 ? ledger.entries[at] : null;
		const next = { ...previous, ...entry, id: idOf(entry), createdAt: previous?.createdAt ?? entry.createdAt ?? new Date().toISOString() };
		if (!entry.sha256 && entry.kind !== "path" && existsSync(entry.path)) next.sha256 = createHash("sha256").update(readFileSync(entry.path)).digest("hex");
		if (at >= 0) ledger.entries[at] = next; else ledger.entries.push(next);
		saveLedger(root, ledger.entries);
		return next;
	});
}

/** 精确 id 或位置销账；有 owner 条件时只影响该通道。 */
export function cancel(root, entry) {
	if (!entry?.path && !entry?.id) return;
	return withControlLock(root, () => {
		const ledger = loadLedger(root);
		const kept = ledger.entries.filter(e => entry.id ? e.id !== entry.id :
			!sameLocation(e, entry) || (entry.harness !== undefined && e.harness !== entry.harness) || (entry.channel !== undefined && e.channel !== entry.channel));
		if (kept.length !== ledger.entries.length) saveLedger(root, kept);
	});
}
export function forgetHarness(root, harness, channel = null) {
	return withControlLock(root, () => {
		const ledger = loadLedger(root);
		const kept = ledger.entries.filter(e => e.harness !== harness || (channel !== null && e.channel !== channel));
		if (kept.length !== ledger.entries.length) saveLedger(root, kept);
	});
}
export const listLedger = root => loadLedger(root).entries;
