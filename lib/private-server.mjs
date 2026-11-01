// OpenCode v2 的 prompt 在独立 server 进程执行：父进程直接持有该 PID，不把许可交给 CLI/后代。
import { randomBytes } from "node:crypto";
import { prepareCommand, spawnPrepared } from "./spawn.mjs";

export function privateClientArgs(args, url) {
	if (args.some(value => value === "--server" || value.startsWith("--server="))) throw new Error("本次启动使用独立服务，请移除 --server");
	return ["--server", url, ...args.filter(value => value !== "--standalone")];
}
export async function startPrivateServer(command, { env, cwd, lease, timeout = 20000 }) {
	const password = randomBytes(32).toString("base64url");
	// 客户端和服务端使用同一次随机认证；不读取用户已有的服务器密码。
	env.OPENCODE_PASSWORD = password;
	delete env.OPENCODE_SERVER_PASSWORD;
	const descriptor = prepareCommand(command, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
	if (!descriptor.hostDirect) throw new Error("独立服务需要可核验的原生入口");
	const startedAt = Date.now(), child = spawnPrepared(descriptor);
	child.on("error", () => {});
	child.stdin.on("error", () => {});
	let closed = false, errors = "";
	const close = () => {
		if (closed) return;
		closed = true;
		child.stdin.end();
		if (child.exitCode === null) child.kill();
	};
	const exited = new Promise(resolve => child.once("close", code => resolve(code)));
	child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-2000); });
	try {
		if (child.pid) lease?.publish(child.pid, startedAt);
		const url = await new Promise((resolve, reject) => {
			let pending = "", settled = false;
			const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
			const timer = setTimeout(() => finish(new Error("独立服务启动超时")), timeout);
			child.once("error", error => finish(error));
			child.once("exit", code => finish(new Error(`独立服务提前退出 (${code})${errors ? ": " + errors.replaceAll(password, "[redacted]") : ""}`)));
			child.stdout.on("data", chunk => {
				if (settled) return;
				pending += chunk.toString();
				if (pending.length > 32768) { finish(new Error("独立服务 readiness 超出限制")); return; }
				let end;
				while ((end = pending.indexOf("\n")) !== -1) {
					const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
					if (!line) continue;
					try {
						const data = JSON.parse(line), ready = new URL(data.url);
						if (ready.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(ready.hostname) || !ready.port || ready.username || ready.password || ready.pathname !== "/" || ready.search || ready.hash) throw new Error("readiness URL 不是本机独立服务");
						finish(null, ready.origin); return;
					} catch (error) { finish(new Error(`独立服务 readiness 无效：${error.message}`)); return; }
				}
			});
		});
		return { pid: child.pid, url, exited, close, clientArgs: args => privateClientArgs(args, url) };
	} catch (error) { lease?.close(); close(); await exited; throw error; }
}
