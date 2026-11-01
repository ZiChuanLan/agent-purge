// 短时同步本地事务；同进程内部调用复用持有的锁，不重复获取。
import * as controlFs from "node:fs";
import { resolve as resolveControlRoot } from "node:path";
import { randomUUID as controlUUID } from "node:crypto";
const controlHeld = new Set();

export function withControlLock(root, work) {
	const key = resolveControlRoot(root);
	if (controlHeld.has(key)) return work();
	controlFs.mkdirSync(key, { recursive: true });
	const file = key + "/.apply.lock";
	let fd;
	for (let attempt = 0; attempt < 2; attempt++) {
		try { fd = controlFs.openSync(file, "wx", 0o600); break; }
		catch (error) {
			if (error.code !== "EEXIST") throw error;
			let owner, bytes;
			try { bytes = controlFs.readFileSync(file, "utf8"); owner = JSON.parse(bytes); } catch {}
			let dead = false;
			if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
				try { process.kill(owner.pid, 0); } catch (e) { dead = e.code === "ESRCH"; }
			}
			if (attempt === 0 && dead && bytes === controlFs.readFileSync(file, "utf8")) { controlFs.unlinkSync(file); continue; }
			throw new Error(`另一个配置操作尚未结束（PID ${owner?.pid ?? "unknown"}）：${file}`);
		}
	}
	if (fd === undefined) throw new Error(`配置锁获取失败：${file}`);
	const token = controlUUID();
	try {
		controlFs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
		controlFs.fsyncSync(fd);
		// Windows 的打开句柄会阻止数据目录改名；锁的所有权由 wx 文件与 token 保持。
		controlFs.closeSync(fd);
		fd = undefined;
		controlHeld.add(key);
		const result = work();
		if (result && typeof result.then === "function") throw new Error("配置事务必须是同步的本地文件操作");
		return result;
	} finally {
		controlHeld.delete(key);
		if (fd !== undefined) controlFs.closeSync(fd);
		try { if (JSON.parse(controlFs.readFileSync(file, "utf8")).token === token) controlFs.unlinkSync(file); } catch {}
	}
}

export function atomicControlJSON(file, value) {
	const tmp = file + ".tmp-" + controlUUID();
	try {
		controlFs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		controlFs.renameSync(tmp, file);
	} finally { controlFs.rmSync(tmp, { force: true }); }
}

export const controlRuntime = `import * as controlFs from "node:fs";
import { resolve as resolveControlRoot } from "node:path";
import { randomUUID as controlUUID } from "node:crypto";
const controlHeld = new Set();
${withControlLock.toString()}
${atomicControlJSON.toString()}
`;
