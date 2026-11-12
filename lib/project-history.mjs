// 项目规则页的操作历史：只记录网页端成功/失败尝试，不参与安装状态。
// 独立 JSONL 文件，避免把审计记录塞进 state.json 或足迹账本。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pathKey = path => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const historyFile = root => join(root, "project-history.jsonl");

export function appendProjectHistory(root, entry) {
	if (!root || !entry?.dir) return null;
	mkdirSync(root, { recursive: true });
	const row = { at: new Date().toISOString(), ...entry };
	appendFileSync(historyFile(root), JSON.stringify(row) + "\n", "utf8");
	return row;
}

export function readProjectHistory(root, dir, limit = 20) {
	if (!root || !dir || !existsSync(historyFile(root))) return [];
	try {
		const rows = readFileSync(historyFile(root), "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map(line => JSON.parse(line))
			.filter(row => row && typeof row.dir === "string" && pathKey(row.dir) === pathKey(dir));
		return rows.reverse().slice(0, limit);
	} catch {
		return [];
	}
}
