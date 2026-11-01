// 单次 off 不移除其他来源；有静态托管块时报告精确路径，不靠粗粒度禁用宿主功能。
import { existsSync, readFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { targets, stripBlock } from "./persist.mjs";
import { listLedger } from "./footprints.mjs";
import { projectFilePath } from "./project.mjs";

export function launchConflicts(root, harness, cwd) {
	const files = new Set();
	const target = targets[harness];
	if (target?.kind === "block") files.add(target.file());
	for (const row of listLedger(root)) if (row.kind === "block" && (row.harness === harness || row.channel === "project")) files.add(row.path);
	let dir = resolve(cwd);
	while (true) {
		const file = projectFilePath(harness, dir); if (file) files.add(file);
		if (dir === parse(dir).root) break;
		dir = dirname(dir);
	}
	return [...files].filter(file => {
		if (!existsSync(file)) return false;
		try { const text = readFileSync(file, "utf8"); return stripBlock(text) !== text; }
		catch { throw new Error(`静态配置读取失败：${file}`); }
	});
}
