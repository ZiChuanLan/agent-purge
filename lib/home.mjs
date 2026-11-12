// 用户数据目录：state.json 与 personas/ 不跟代码走。
//
// 原因：npm 升级是「整个包目录替换」，数据若留在包目录里会连人设一起被清掉。
// 所以代码认 ROOT（装在哪都行），数据认 HOME：
//   AGENT_PURGE_HOME 显式指定 > ~/.agent-purge
//
// 老布局（数据躺在包目录里）在首次运行时整份拷过来，原件留着当备份，不删。
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function dataHome() {
	const env = process.env.AGENT_PURGE_HOME?.trim();
	if (!env) return join(homedir(), ".agent-purge");
	return isAbsolute(env) ? env : resolve(env);
}

/**
 * 确保数据目录存在，并把旧布局搬过来。
 * @returns {{ home: string, migrated: string[] }}
 */
export function ensureDataHome(pkgRoot = null) {
	const home = dataHome();
	mkdirSync(home, { recursive: true });
	const migrated = [];
	// 显式指定 AGENT_PURGE_HOME = 用户自己挑的新家，不往里搬旧数据
	if (!pkgRoot || process.env.AGENT_PURGE_HOME?.trim() || resolve(pkgRoot) === resolve(home)) {
		return { home, migrated };
	}

	const state = [join(pkgRoot, "state.json"), join(home, "state.json")];
	if (existsSync(state[0]) && !existsSync(state[1])) {
		copyFileSync(state[0], state[1]);
		migrated.push(`state: ${state[0]} → ${state[1]}`);
	}

	const from = join(pkgRoot, "personas");
	const to = join(home, "personas");
	if (existsSync(from) && !existsSync(to)) {
		const md = readdirSync(from).filter((f) => f.endsWith(".md"));
		if (md.length) {
			cpSync(from, to, { recursive: true });
			migrated.push(`personas: ${from} → ${to}（${md.length} 个）`);
		}
	}

	// 旧布局里的账本和原字节备份也要跟着搬；否则项目块虽然还在磁盘上，
	// 新版本就找不到撤销基线，无法保证「随时撤销」。
	const ledger = [join(pkgRoot, "footprints.json"), join(home, "footprints.json")];
	if (existsSync(ledger[0]) && !existsSync(ledger[1])) {
		copyFileSync(ledger[0], ledger[1]);
		migrated.push(`footprints: ${ledger[0]} → ${ledger[1]}`);
	}
	const stashFrom = join(pkgRoot, "stash");
	const stashTo = join(home, "stash");
	if (existsSync(stashFrom) && !existsSync(stashTo)) {
		cpSync(stashFrom, stashTo, { recursive: true });
		migrated.push(`stash: ${stashFrom} → ${stashTo}`);
	}
	return { home, migrated };
}
