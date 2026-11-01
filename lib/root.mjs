// 随包资源访问：源码态读磁盘，bun --compile 产物读内嵌表。
//
// 为什么不是「算一个 ROOT 再 join」：实测（bun 1.3.14, Windows）
//   - `[dir]/[name].[ext]` 命名下根目录文件变成 `B:/~BUN/root/./matrix.json`，readFileSync 直接 ENOENT；
//   - 拼接出来的 `B:/~BUN/root/matrix.json` 同样打不开；
//   - bunfs 目录不支持 readdir。
// 只有「原样用 import 拿到的路径」能读，所以编译态的每条路径都由 build 入口生成的表给出，
// 键 = 仓库相对路径（posix 分隔）。源码态保持原来的 join(包根, 相对路径) 行为。
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = globalThis.__AGENT_PURGE_FILES ?? null;

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 编译态：资源在 bunfs 里只读，任何「往包目录写」的逻辑都要绕开 */
export const isCompiled = () => FILES !== null;

/** 读一个随包资源（仓库相对路径，posix 分隔）：matrix.json / web/ui.html / lib/templates/... */
export function readResource(rel) {
	const hit = FILES?.[rel];
	if (hit) return readFileSync(hit);
	if (FILES) throw new Error(`exe 里没内嵌 ${rel}（scripts/build-exe.mjs 的 assets() 漏了它）`);
	return readFileSync(join(ROOT, rel));
}

/** 列一个资源目录下的文件名（不含子目录）：编译态筛内嵌表，源码态真读目录 */
export function listResources(prefix) {
	const dir = prefix.endsWith("/") ? prefix : `${prefix}/`;
	if (FILES) {
		return Object.keys(FILES)
			.filter((k) => k.startsWith(dir) && !k.slice(dir.length).includes("/"))
			.map((k) => k.slice(dir.length));
	}
	return readdirSync(join(ROOT, dir));
}
