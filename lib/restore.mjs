// 临时文件交换：独占 journal + 所有者存活检查 + 写后指纹。
// 冲突或恢复失败保留 journal，不覆盖用户在测试期间的修改。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const JOURNAL_DIR = process.env.AGENT_PURGE_JOURNAL_DIR || path.join(os.tmpdir(), "agent-purge-restore");
let installed = false;
const live = new Set();
const hash = (bytes) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const read = (file) => { try { return fs.readFileSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
function canonical(file) {
	const full = path.resolve(file);
	// 同一目录的符号链接也应指向同一把锁；不跟随不存在的目标。
	try { return fs.realpathSync(full); } catch (e) {
		if (e.code !== "ENOENT") throw e;
		return path.join(fs.realpathSync(path.dirname(full)), path.basename(full));
	}
}
function entryPath(file) {
	const key = process.platform === "win32" ? file.toLowerCase() : file;
	return path.join(JOURNAL_DIR, createHash("sha256").update(key).digest("hex") + ".json");
}
function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return true;
	try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}
function atomicWrite(file, bytes, mode) {
	const tmp = file + ".purge-" + randomUUID() + ".tmp";
	try {
		fs.writeFileSync(tmp, bytes, { flag: "wx", mode: mode ?? 0o600 });
		fs.renameSync(tmp, file);
	} finally { fs.rmSync(tmp, { force: true }); }
}
const readRecord = (journal) => { try { return JSON.parse(fs.readFileSync(journal, "utf8")); } catch { return null; } };
function restore(record, journal) {
	let currentRecord;
	try {
		const source = fs.readFileSync(journal, "utf8");
		currentRecord = JSON.parse(source);
	} catch (error) {
		throw new Error(`无法读取恢复凭据，文件未改动：${journal}`, { cause: error });
	}
	if (currentRecord.operation !== record.operation) throw new Error(`恢复所有权已改变：${record.file}`);
	const current = hash(read(record.file));
	if (current !== record.beforeHash && current !== record.afterHash) {
		throw new Error(`文件在交换后被修改，保留 journal 等待处理：${record.file}`);
	}
	if (current !== record.beforeHash) {
		if (record.backup === null) fs.rmSync(record.file, { force: true });
		else atomicWrite(record.file, Buffer.from(record.backup, "base64"), record.mode);
	}
	fs.rmSync(journal);
}

// 已达成目标状态时的 undo：没有 journal 可还原，重复调用无害。
const noSwap = () => {};

/** 独占交换；返回可重试、幂等的 undo。恢复失败会抛错且保留原始备份。
 *  磁盘内容与目标内容一致时不落 journal —— slash 常驻时每次启动都会走到这里，
 *  无条件独占会把第二个会话挡在门外（issue #8）。 */
export function swapFile(file, content) {
	file = canonical(file);
	const next = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
	const nextHash = hash(next);
	fs.mkdirSync(JOURNAL_DIR, { recursive: true });
	const journal = entryPath(file);
	let fd;
	for (let attempt = 0; ; attempt++) {
		// 内容已经一致（可能是另一个会话刚写完）：不需要交换，也不需要锁
		if (hash(read(file)) === nextHash) return noSwap;
		try { fd = fs.openSync(journal, "wx", 0o600); break; }
		catch (e) {
			if (e.code !== "EEXIST") throw e;
			const holder = readRecord(journal);
			// 持有者已退出：先回收它的 journal 再重试一次；回收不了就保守报错
			if (attempt === 0 && holder?.version === 2 && holder.operation && !alive(holder.pid)) {
				try { restore(holder, journal); continue; }
				catch (error) { throw new Error(`无法回收已退出进程的交换，请先处理 journal：${file}（${error.message}）`); }
			}
			const owner = Number.isInteger(holder?.pid) ? `（持有者 PID ${holder.pid}）` : "";
			throw new Error(`文件存在未结束的交换${owner}，请先处理 journal：${file}`);
		}
	}
	let record;
	try {
		const backup = read(file);
		record = { version: 2, file, pid: process.pid, operation: randomUUID(), at: new Date().toISOString(),
			backup: backup === null ? null : backup.toString("base64"), beforeHash: hash(backup), afterHash: hash(next),
			mode: backup === null ? undefined : fs.statSync(file).mode & 0o777 };
		fs.writeFileSync(fd, JSON.stringify(record));
		fs.fsyncSync(fd);
		fs.closeSync(fd); fd = undefined;
		atomicWrite(file, next, record.mode);
	} catch (e) {
		if (fd !== undefined) fs.closeSync(fd);
		if (record) { try { restore(record, journal); } catch {} }
		else fs.rmSync(journal, { force: true });
		throw e;
	}
	let done = false;
	const undo = () => {
		if (done) return;
		restore(record, journal);
		done = true;
		live.delete(undo);
	};
	live.add(undo);
	return undo;
}

/** 只恢复已死亡的 v2 所有者；旧格式无法证明所有权，保留并报告。 */
export function recover({ onWarning = (message) => console.error(`[restore] ${message}`) } = {}) {
	fs.mkdirSync(JOURNAL_DIR, { recursive: true });
	let n = 0;
	for (const name of fs.readdirSync(JOURNAL_DIR)) {
		if (!name.endsWith(".json")) continue;
		const journal = path.join(JOURNAL_DIR, name);
		try {
			const record = JSON.parse(fs.readFileSync(journal, "utf8"));
			if (record.version !== 2 || !record.operation || !path.isAbsolute(record.file || "")) {
				onWarning(`旧版或不完整 journal，未自动覆盖文件：${journal}`); continue;
			}
			if (alive(record.pid)) continue;
			restore(record, journal); n++;
		} catch (e) { onWarning(`${journal}: ${e.message}`); }
	}
	return n;
}

export function installCrashHandlers() {
	if (installed) return;
	installed = true;
	const flush = () => {
		for (const undo of [...live]) {
			try { undo(); } catch (e) { console.error(`[restore] ${e.message}`); }
		}
	};
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
		try { process.on(sig, () => { flush(); process.exit(sig === "SIGINT" ? 130 : 143); }); } catch {}
	}
	process.on("uncaughtException", (e) => {
		console.error("[restore] 未捕获异常：", e?.stack ?? e);
		flush(); process.exit(1);
	});
	process.on("exit", flush);
}
export const journalDir = JOURNAL_DIR;
