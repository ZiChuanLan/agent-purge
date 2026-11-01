// 读回「实测证据」：谁真的被证明把人设发进了特权角色层。
// 只认本机抓包写下的 verification/latest.json，不认 matrix.json 的常量表，也不认配置写入成功。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verificationEvidence } from "./evidence.mjs";
export { sysHit } from "./evidence.mjs";

export function verificationFile(root) {
	return join(root, "verification", "latest.json");
}

/** harness 名 → true（有实测且命中 sys 层）。没有报告 = 空集合，调用方按「未实测」处理。 */
export function verifiedHarnesses(root) {
	const ok = new Set();
	let raw;
	try {
		raw = JSON.parse(readFileSync(verificationFile(root), "utf8"));
	} catch {
		return ok;
	}
	for (const r of Array.isArray(raw?.results) ? raw.results : []) if (verificationEvidence(r).state === "verified") ok.add(r.harness);
	return ok;
}
