// armed 的真相是磁盘，`state.json` 的 armed 只是缓存。
// 读之前先对账：手工删了 shim 文件、旧版本写错的 install、slash 文件被清掉 —— 都在这层纠正。
// （以前 Web 的 install 通道不看 install() 的 error 就 setArmed(true)，留下了假记录）
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadState, setArmed } from "./state.mjs";

const home = process.env.USERPROFILE || process.env.HOME;

/** 返回被纠正掉的条目，如 ["pi:install"]，方便 doctor/status 说人话 */
export async function reconcileArmed(root) {
	const { status } = await import("./persist.mjs");
	const { resolveSlash } = await import("./slashes.mjs");
	const { state } = loadState(root);
	const armed = state.armed ?? {};
	const fixed = [];
	const installs = new Map(status(root).map((s) => [s.name, s.installed]));
	for (const [h, chans] of Object.entries(armed)) {
		for (const ch of [...chans]) {
			let alive = true;
			if (ch === "shim") {
				const bin = join(home, ".agent-purge", "bin");
				alive = existsSync(join(bin, `${h}.cmd`)) || existsSync(join(bin, `${h}.ps1`)) || existsSync(join(bin, h));
			} else if (ch === "install") {
				alive = Boolean(installs.get(h));
			} else if (ch === "slash") {
				const s = resolveSlash(h, root);
				// dsh 给 probe（看挂载块，不看固定路径）；其余家 slash 就是单个文件
				alive = Boolean(s && s.offered !== false && (s.probe ? s.probe() : existsSync(s.file)));
			}
			if (!alive) {
				setArmed(root, h, ch, false);
				fixed.push(`${h}:${ch}`);
			}
		}
	}
	return fixed;
}
