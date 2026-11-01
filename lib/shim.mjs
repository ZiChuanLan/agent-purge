// 裸命令接管：在你的 PATH 前面放一层同名 shim，敲 `codex` 等于敲 `agent-purge codex`。
//
// 关键点：shim 会把「真身路径」写进 AGENT_PURGE_REAL_BIN，spawn 时优先用它，
// 否则 resolver 会在 PATH 里先找到 shim 自己 → 无限套娃。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ownShimDirectory } from "./environment.mjs";
import { looksOwned, removeOwnedFile } from "./persist.mjs";
import { record } from "./footprints.mjs";

const WIN = process.platform === "win32";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = ownShimDirectory();
// 与 spawn 的 SPAWN_EXTS 保持同一优先级：.ps1 走 powershell 数组传参，
// 不会被 cmd.exe 做 %VAR% 展开；.cmd 只作兜底。
const EXTS = WIN ? [".exe", ".ps1", ".cmd", ".bat"] : [""];

export function shimDir() {
	return DIR;
}

/** 本工具自己的调用前缀：bun 编译版直接用自身 exe，普通 node 版本带上脚本路径 */
function selfPrefix() {
	if (process.versions.bun) return { cmd: process.execPath, args: [] };
	return { cmd: process.execPath, args: [join(ROOT, "bin", "agent-purge.mjs")] };
}

/** PATH 里找同名可执行文件，跳过我们自己的 shim 目录 */
export function resolveReal(id) {
	const dirs = (process.env.PATH ?? "").split(WIN ? ";" : ":").filter(Boolean);
	for (const d of dirs) {
		if (resolve(d) === resolve(DIR)) continue;
		for (const ext of EXTS) {
			const p = join(d, id + ext);
			if (existsSync(p)) return p;
		}
	}
	return null;
}

export function installShim(root, id) {
	const real = resolveReal(id);
	if (!real) return { error: `PATH 里找不到真正的 ${id}（agent-purge doctor 看探测结果）` };
	mkdirSync(DIR, { recursive: true });
	for (const name of WIN ? [`${id}.cmd`, `${id}.ps1`] : [id]) {
		const file = join(DIR, name);
		if (existsSync(file) && !looksOwned(readFileSync(file, "utf8"))) return { error: `同名文件不是托管 shim：${file}` };
	}
	const self = selfPrefix();
	const files = [];
	// 拼接时不能折叠空格：node.exe 常在 "C:\Program Files\..." 下
	const callLine = [`"${self.cmd}"`, ...self.args.map((a) => `"${a}"`), id].join(" ");

	if (WIN) {
		const cmdFile = join(DIR, `${id}.cmd`);
		writeFileSync(
			cmdFile,
			[
				"@echo off",
				"rem agent-purge shim — 删掉本文件即取消接管",
				`set "AGENT_PURGE_REAL_BIN=${real}"`,
				`${callLine} %*`,
				"",
			].join("\r\n"),
			"utf8",
		);
		files.push(cmdFile);

		const psFile = join(DIR, `${id}.ps1`);
		writeFileSync(
			psFile,
			[
				"# agent-purge shim — 删掉本文件即取消接管",
				`$env:AGENT_PURGE_REAL_BIN = '${real.replace(/'/g, "''")}'`,
				`& '${self.cmd}' ${self.args.map((a) => `'${a}'`).join(" ")} ${id} @args`,
				"exit $LASTEXITCODE",
				"",
			].join("\r\n"),
			"utf8",
		);
		files.push(psFile);
	} else {
		const sh = join(DIR, id);
		writeFileSync(
			sh,
			[
				"#!/bin/sh",
				"# agent-purge shim — 删掉本文件即取消接管",
				`AGENT_PURGE_REAL_BIN='${real.replace(/'/g, "'\\''")}' exec '${self.cmd}' ${self.args.map((a) => `'${a}'`).join(" ")} ${id} "$@"`,
				"",
			].join("\n"),
			{ encoding: "utf8", mode: 0o755 },
		);
		files.push(sh);
	}

	// 账本才是卸载的依据：按文件名扫 bin/ 扫不到改过名的孤儿
	for (const f of files) record(root, { kind: "file", harness: id, channel: "shim", path: f, undo: { type: "file-delete" } });
	record(root, { kind: "path", harness: id, channel: "shim", path: DIR, undo: { type: "path-env" } });
	// Web 的 shim 开关也必须把目录放进 PATH，否则文件写了但裸命令仍走原程序。
	const path = ensureUserPath();
	return { file: files[0], files, real, path };
}
export function uninstallShim(root, id) {
	// 没有 shim 不等于失败：state 里可能记着一条从来没落地的 armed（换了机器、装了又手工删了）。
	// 这里报 error 会让 clean 永远「有残留」，就是那种清不掉的 codebuddy:shim。
	if (!existsSync(DIR)) return { action: "already-gone", detail: `shim 目录不存在: ${DIR}` };
	const removed = [];
	for (const f of readdirSync(DIR)) {
		const base = f.replace(/\.(cmd|ps1|bat|exe)$/i, "");
		if (base === id) {
			const file = join(DIR, f);
			const r = removeOwnedFile(file, { root });
			if (r.action === "skipped-foreign") return { error: `保留外来文件：${file}`, removed };
			removed.push(file);
		}
	}
	if (!removed.length) return { action: "already-gone", detail: `没有 ${id} 的 shim` };
	return { file: removed[0], removed, action: "deleted-file" };
}

export function shimStatus() {
	if (!existsSync(DIR)) return [];
	const seen = new Map();
	for (const f of readdirSync(DIR)) {
		let owned = false;
		try { owned = looksOwned(readFileSync(join(DIR, f), "utf8")); } catch {}
		if (!owned) continue;
		const id = f.replace(/\.(cmd|ps1|bat|exe)$/i, "");
		if (!seen.has(id)) seen.set(id, { id, installed: true, dir: DIR, files: [] });
		seen.get(id).files.push(join(DIR, f));
	}
	return [...seen.values()];
}

/** 只读：shim 目录是否已在用户 PATH（且在最前）。供 status 用，不写注册表。 */
export function pathState() {
	if (!WIN || process.env.AGENT_PURGE_ISOLATED === "1") {
		const parts = (process.env.PATH ?? "").split(WIN ? ";" : ":");
		return { dir: DIR, present: parts.includes(DIR), first: parts[0] === DIR };
	}
	const read = spawnSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: "utf8" });
	const parts = (read.stdout ?? "").trim().split(";").filter(Boolean);
	const norm = (s) => resolve(s.trim().replace(/\\{2,}/g, "\\")).toLowerCase();
	const at = parts.findIndex((p) => norm(p) === norm(DIR));
	return { dir: DIR, present: at >= 0, first: at === 0 && parts[0].trim() === DIR };
}

/**
 * 把 shim 目录放到用户 PATH 最前面（幂等）。Windows 走 [Environment]::SetEnvironmentVariable，
 * 不用 setx（setx 在 >1024 字符时会截断）。
 */
export function ensureUserPath() {
	if (!WIN || process.env.AGENT_PURGE_ISOLATED === "1") return { changed: false, dir: DIR, how: `把 ${DIR} 加到 shell rc 的 PATH 最前：export PATH="${DIR}:$PATH"`, first: false };
	const read = spawnSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: "utf8" });
	const current = (read.stdout ?? "").trim();
	const parts = current.split(";").filter(Boolean);
	// 合并连续反斜杠：上一版曾把 "C:\\Users\\..." 这种双反斜杠写进 PATH，
	// 归一后才能认出它是同一条并顺手清掉
	const norm = (s) => resolve(s.trim().replace(/\\{2,}/g, "\\"));
	const at = parts.findIndex((p) => norm(p).toLowerCase() === norm(DIR).toLowerCase());
	// 位置对还不够：得确认存的就是干净路径（曾被写成 "C:\\\\Users\\\\..."，位置对但 where 找不到）
	const clean = at === 0 && parts[0].trim() === DIR;
	if (clean) return { changed: false, dir: DIR, first: true, how: "已在最前" };

	const next = [DIR, ...parts.filter((p) => norm(p).toLowerCase() !== norm(DIR).toLowerCase())];
	// PowerShell 单引号是字面量：用 '' 包住，内部单引号翻倍。绝不能走 JSON.stringify
	// （JSON 会把 \\ 写成 \\\\，写进 PATH 就变成带双反斜杠的废路径）
	const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
	const write = spawnSync(
		"powershell",
		["-NoProfile", "-Command", `[Environment]::SetEnvironmentVariable('Path', ${psQuote(next.join(";"))}, 'User')`],
		{ encoding: "utf8" },
	);
	if (write.status !== 0) return { changed: false, dir: DIR, first: false, how: `写入用户 PATH 失败：${(write.stderr ?? "").trim()}` };
	return { changed: true, dir: DIR, first: true, how: at === 0 ? "已就地修正 PATH 里的脏路径" : "已写入用户 PATH（新开终端生效；disarm 不会自动移除）" };
}

/** 把 ensureUserPath 加进去的那一段拿掉（只动自己那一条，别的条目原样保留） */
export function removeUserPath(dir = DIR) {
	if (!WIN || process.env.AGENT_PURGE_ISOLATED === "1") {
		const present = (process.env.PATH ?? "").split(WIN ? ";" : ":").some(p => resolve(p || ".").toLowerCase() === resolve(dir).toLowerCase());
		return { ok: !present, changed: false, dir, how: present ? `从 shell rc 移除 ${dir}` : "PATH 中已无该目录" };
	}
	const read = spawnSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: "utf8" });
	if (read.status !== 0) return { ok: false, changed: false, dir, how: `读取用户 PATH 失败：${read.stderr ?? ""}` };
	const parts = (read.stdout ?? "").trim().split(";").filter(Boolean);
	const norm = (s) => resolve(s.trim().replace(/\\{2,}/g, "\\")).toLowerCase();
	const left = parts.filter((p) => norm(p) !== norm(dir));
	if (left.length === parts.length) return { ok: true, changed: false, dir, how: "不在用户 PATH 里" };
	// 整条 PATH 只有我们这一条时不要写空值：那是把用户的 PATH 清空，不是撤销
	if (!left.length) return { ok: false, changed: false, dir, how: "用户 PATH 只剩这一条，请手工确认清空" };
	const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
	const write = spawnSync(
		"powershell",
		["-NoProfile", "-Command", `[Environment]::SetEnvironmentVariable('Path', ${psQuote(left.join(";"))}, 'User')`],
		{ encoding: "utf8" },
	);
	if (write.status !== 0) return { ok: false, changed: false, dir, how: `写入用户 PATH 失败：${(write.stderr ?? "").trim()}` };
	return { ok: true, changed: true, dir, how: "已从用户 PATH 移除（新开终端生效）" };
}
