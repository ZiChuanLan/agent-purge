// 控制台单例登记：同一个数据目录只允许一个控制台实例。
//
// 「单例」指的是控制台服务 + 它开出来的那个桌面窗口。登记文件落在数据目录里，
// 所以在同一个 home 上重复启动（双击 exe、命令行再敲一次 web）只会把老窗口叫到前台，
// 不会再多开一个服务或多开一个页面；换了 AGENT_PURGE_HOME 就是另一个实例，互不干扰。
//
// 存活判定只看登记的 pid：进程被强杀时文件会残留，下一次启动发现 pid 不在就直接清掉重来。
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "web-instance.json";

export function instancePath(home) {
	return join(home, FILE);
}

/** 读取登记；坏文件（截断、手改）当作没有登记，不抛错。 */
export function readInstance(home) {
	try {
		const record = JSON.parse(readFileSync(instancePath(home), "utf8"));
		if (!record || typeof record !== "object") return null;
		if (!Number.isInteger(record.pid) || !Number.isInteger(record.port)) return null;
		return record;
	} catch {
		return null;
	}
}

/** pid 是否还活着；EPERM 说明进程存在但库不让我们发信号，同样算活着。 */
export function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

/**
 * 原子占位：只有能独占创建登记文件的进程才算拿到实例。
 * @returns {{ ok: true } | { ok: false, existing?: object, error?: Error }}
 */
export function claimInstance(home, record) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = openSync(instancePath(home), "wx");
			try {
				writeFileSync(handle, `${JSON.stringify({ ...record, startedAt: new Date().toISOString() }, null, 2)}\n`);
			} finally {
				closeSync(handle);
			}
			return { ok: true };
		} catch (error) {
			if (error.code !== "EEXIST") return { ok: false, error };
			const existing = readInstance(home);
			// 同一进程重复登记不算冲突（重启服务端时会走到这里）
			if (existing && existing.pid !== process.pid && processAlive(existing.pid)) return { ok: false, existing };
			// 僵尸登记：进程已经不在了，清掉重来
			try { rmSync(instancePath(home), { force: true }); } catch {}
		}
	}
	return { ok: false, existing: readInstance(home) ?? undefined };
}

/**
 * 占位 + 退出清理一步到位，给各个启动入口复用。
 * 端口 0 是随机端口（隔离 smoke / 测试），不参与单例。
 * @returns {{ ok: true } | { ok: false, existing?: object, error?: Error }}
 */
export function registerInstance(home, port) {
	if (port === 0) return { ok: true };
	const claim = claimInstance(home, { pid: process.pid, port });
	if (claim.ok) process.once("exit", () => releaseInstance(home, process.pid));
	return claim;
}

/** 补记窗口进程，供下次启动把窗口叫到前台；只改自己那条登记。 */
export function updateWindow(home, pid, windowPid) {
	const existing = readInstance(home);
	if (!existing || existing.pid !== pid) return false;
	writeFileSync(instancePath(home), `${JSON.stringify({ ...existing, windowPid }, null, 2)}\n`);
	return true;
}

/** 退出时清理；pid 对不上说明登记已经易主，不要删别人的。 */
export function releaseInstance(home, pid = process.pid) {
	const existing = readInstance(home);
	if (!existing || existing.pid !== pid) return false;
	rmSync(instancePath(home), { force: true });
	return true;
}

/**
 * 控制台窗口进程是否还活着。
 * autoExit 用它把「服务该不该退」从「页面还发不发心跳」改成「窗口还在不在」：
 * 窗口活着却把服务退掉，只会留一扇连不上的旧页面，下次启动再补一扇新的（issue #14）。
 */
export function windowAliveIn(home, port = null) {
	const record = readInstance(home);
	if (!record || record.pid !== process.pid) return false;
	if (Number.isInteger(port) && record.port !== port) return false;
	if (!Number.isInteger(record.windowPid) || record.windowPid <= 0) return false;
	return processAlive(record.windowPid);
}
