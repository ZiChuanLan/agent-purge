// 持久化层：把 persona 写进 harness 自己的配置，这样用户在自己终端敲 codex 也生效。
// 分两类：托管块（文本文件，带标记，可精确删除）与插件文件（可删）。
// 不动二进制——这里只做可逆的配置改动。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RESIDENT as DSH_RESIDENT, SESSION as DSH_SESSION, addPlugin, hasPlugin, pluginFileOnDisk, residentSource, removePlugin } from "./dsh.mjs";

const BEGIN = "# >>> agent-purge";
const END = "# <<< agent-purge";
const home = process.env.USERPROFILE || process.env.HOME;
// opencode 认 XDG_CONFIG_HOME（lib/detect.mjs 也是这么探测的）：两处必须同一个落点，否则装了白装
export const opencodePlugins = () => join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "plugins");

export const targets = {
	pi: {
		// pi 每次启动都读全局 AGENTS.md（“Global Agent Rules”），它就是 pi 唯一的 sys 层常驻口
		// 代价：正文是快照，换 persona 要重新 install
		file: () => join(home, ".pi", "agent", "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "全局 AGENTS.md，每次启动重读；正文是快照，换人设要重装",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	claude: {
		// 用户级 CLAUDE.md：每次都读，但进入的是 <system-reminder> 的上下文块（USER 层），不是 system 数组
		file: () => join(home, ".claude", "CLAUDE.md"),
		kind: "block",
		layer: "user",
		note: "CLAUDE.md 进的是 <system-reminder> 上下文块（用户消息），不是 system 数组",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	grok: {
		// grok 把全局 AGENTS.md 的内容 append 到系统提示；单文件上限 10000 字符，超了会被截
		file: () => join(home, ".grok", "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "内容 append 进系统提示；单文件上限 10000 字符，超了会自动截断",
		body: (active) => clamp(readFileSync(active, "utf8").trim(), 9600),
	},
	zcode: {
		// 官方文档：~/.zcode/AGENTS.md 是“every workspace 的默认 instructions”（桌面闭源，无法抓包复核）
		file: () => join(home, ".zcode", "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "官方文档写的默认 instructions 文件；桌面版闭源，无法抓包复核",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	omp: {
		// Oh My Pi 血统：~/.omp/agent/AGENTS.md 就是它的 rules 文件（--no-rules 关的就是它）
		file: () => join(home, ".omp", "agent", "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "就是它的 rules 文件（--no-rules 关的就是这个）",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	hermes: {
		// SOUL.md 每次构建提示都重读（prompt_builder.load_soul_md）
		file: () => join(process.env.HERMES_HOME || join(home, "AppData", "Local", "hermes"), "SOUL.md"),
		kind: "block",
		layer: "sys",
		note: "SOUL.md 每次构建提示都重读（prompt_builder.load_soul_md）",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	codex: {
		file: () => join(home, ".codex", "config.toml"),
		kind: "block",
		// TOML 顶层键必须写在第一个 [table] 之前：追加到文件尾会被解析成上一个表里的键
		position: "top",
		layer: "sys",
		note: "model_instructions_file 直接换掉它的指令文件（连 GUI/子进程启动都生效）",
		body: (active) => `model_instructions_file = "${active.replace(/\\/g, "/")}"`,
	},
	opencode: {
		// 写入用全局单一位置；读取/删除要扫全部历史位置，否则老版本留下的项目级插件会继续注入
		file: () => join(opencodePlugins(), "agent-purge.ts"),
		files: () => [
			join(opencodePlugins(), "agent-purge.ts"),
			// 旧落点：设了 XDG 的机器上，老版本写在 home/.config 的那份也得能被扫到并清掉
			join(home, ".config", "opencode", "plugins", "agent-purge.ts"),
			join(home, ".config", "opencode", "plugin", "agent-purge.ts"),
			join(process.cwd(), ".opencode", "plugin", "agent-purge.ts"),
		],
		kind: "file",
		layer: "sys",
		note: "插件改 chat.system（SYS 层真改）；每轮读 state.json + active.md，人设与模式（off/replace/append）全部热切",
		// 每轮请求都重拼一次 system：人设、模式都从 state.json 现读 → 真热切，不用重启
		body: (active, root) => `import { readFileSync } from "node:fs";
// agent-purge 托管文件：删除即可取消
const PERSONA = ${JSON.stringify(active.replace(/\\/g, "/"))};
const STATE = ${JSON.stringify(join(root, "state.json").replace(/\\/g, "/"))};
function cfg() {
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    const mode = st && st.default ? st.default.mode : "replace";
    const body = readFileSync(PERSONA, "utf8").trim();
    return body ? { mode: mode || "replace", body } : null;
  } catch {
    return null;
  }
}
export const AgentPurge = async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    const c = cfg();
    if (!c || c.mode === "off") return;
    if (c.mode === "append") output.system.push(c.body);
    else output.system.splice(0, output.system.length, c.body);
  },
});
`,
	},
	dsh: {
		// cordis 插件挂 systemPrompt 层；三个 profile 各一份（desktop 由 Electron 独占，装完要重启一次）
		file: () => pluginFileOnDisk(DSH_RESIDENT),
		kind: "file",
		layer: "sys",
		note: "cordis 插件包；运行时每轮读 state.json，开关 / 切模式 / 换人设都即时生效；只有首次安装要重启一次",
		probe: () => hasPlugin(DSH_RESIDENT),
		install: ({ root, active }) => {
			const r = addPlugin(DSH_RESIDENT, residentSource(root, active));
			return { file: pluginFileOnDisk(DSH_RESIDENT), note: `三个 profile：${r.profiles.join("/")}；重启一次 DeepSeek Harness 后插件开始工作（之后热切换）` };
		},
		uninstall: () => {
			removePlugin(DSH_RESIDENT);
			// 一次性插件被 SIGKILL 时不会自己清，一并扫掉
			removePlugin(DSH_SESSION);
			return { file: pluginFileOnDisk(DSH_RESIDENT) };
		},
	},
	opencode2: {
		// v2 新版插件 API（V1 的 experimental.chat.system.transform 在 2.x 已废），与 V1 插件文件物理分开
		file: () => join(opencodePlugins(), "agent-purge-v2.ts"),
		files: () => [join(opencodePlugins(), "agent-purge-v2.ts"), join(opencodePlugins(), "agent-purge-v2-session.ts")],
		kind: "file",
		layer: "sys",
		note: "v2 插件 ctx.session.hook(\"context\")；运行时读 state.json，热切",
		body: (active, root) => `import { readFileSync } from "node:fs";
// agent-purge 托管文件：删除即可取消
const STATE = ${JSON.stringify(join(root, "state.json").replace(/\\/g, "/"))};
const ACTIVE = ${JSON.stringify(String(active).replace(/\\/g, "/"))};
function cfg() {
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    // 磁盘卸载后服务里已加载的回调还在：armed 没了就当成已关闭
    const armed = st && st.armed && st.armed.opencode2;
    if (!Array.isArray(armed) || !armed.includes("install")) return null;
    const mode = (st && st.default && st.default.mode) || "replace";
    if (mode === "off") return null;
    const body = readFileSync(ACTIVE, "utf8").trim();
    return body ? { mode, body } : null;
  } catch {
    return null;
  }
}
export default {
  id: "agent-purge",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      const c = cfg();
      if (!c) return;
      if (c.mode === "append") event.system.push({ type: "text", text: c.body });
      else event.system.splice(0, event.system.length, { type: "text", text: c.body });
    });
  },
};
`,
	},
};

export function status(_root) {
	return Object.entries(targets).map(([name, t]) => {
		const file = t.file();
		// 自定义探针（多文件目标用），优先于默认的存在性判断
		if (t.probe) return { name, installed: t.probe(), file };
		const candidates = t.files ? t.files() : [file];
		const present = candidates.filter((f) => existsSync(f));
		if (!present.length) return { name, installed: false, file };
		// 文件类目标：只要还存在任意一份托管文件就算“已安装”（内容可能是旧版本写的）
		const installed =
			t.kind === "block"
				? present.some((f) => readFileSync(f, "utf8").includes(BEGIN))
				: present.length > 0;
		return { name, installed, file: present[0], files: present };
	});
}

export function install(name, { root, active }) {
	const t = targets[name];
	if (!t) return { error: `${name} 没有持久化后端（可用: ${Object.keys(targets).join(", ")}）` };
	// 多文件/自定义布局的 harness 自带安装函数（dsh 三个 profile、opencode2 v2 插件）
	// 它们的失败信号是异常（同名外来目录拒绝覆盖等），这里转成调用方约好的 {error}
	if (t.install) {
		try {
			return { ...t.install({ root, active }), action: "custom" };
		} catch (e) {
			return { error: e.message };
		}
	}
	const file = t.file();
	mkdirSync(dirname(file), { recursive: true });
	if (t.kind === "file") {
		writeFileSync(file, t.body(active, root));
		return { file, action: "wrote-whole-file" };
	}
	const old = existsSync(file) ? readFileSync(file, "utf8") : "";
	const next = upsertBlock(old, t.body(active), t.position);
	writeFileSync(file, next);
	return { file, action: old.includes(BEGIN) ? "replaced-block" : "appended-block" };
}

export function uninstall(name) {
	const t = targets[name];
	if (!t) return { error: `${name} 没有持久化后端` };
	if (t.uninstall) {
		try {
			return { ...t.uninstall(), action: "custom" };
		} catch (e) {
			return { error: e.message };
		}
	}
	if (t.kind === "file") {
		// 清掉所有历史位置，保证“关掉”之后没有任何残留插件还在注入
		const candidates = t.files ? t.files() : [t.file()];
		const gone = candidates.filter((f) => existsSync(f));
		if (!gone.length) return { file: t.file(), action: "already-gone" };
		for (const f of gone) rmSync(f, { force: true });
		return { file: gone[0], files: gone, action: "deleted-file" };
	}
	const file = t.file();
	if (!existsSync(file)) return { file, action: "already-gone" };
	const old = readFileSync(file, "utf8");
	if (!old.includes(BEGIN)) return { file, action: "no-block" };
	const stripped = stripBlock(old);
	// 只剩空白说明这文件本来就是给我们用的，直接删掉别留空壳
	if (!stripped.trim()) {
		rmSync(file, { force: true });
		return { file, action: "deleted-empty-file" };
	}
	writeFileSync(file, stripped);
	return { file, action: "removed-block" };
}

// 按标记替换或追加，幂等。position="top" 用于 TOML：块必须落在第一个 [table] 之前。
export function upsertBlock(text, body, position = "bottom") {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const block = `${BEGIN}\n${body}\n${END}`;
	const stripped = text.includes(BEGIN) ? stripBlock(text) : text;
	if (position === "top") {
		let lines = stripped.split(/\r?\n/);
		const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
		const end = firstTable === -1 ? lines.length : firstTable;
		// 已有的顶层同名键先删掉，否则 TOML 会报 duplicate key
		const key = body.split("=")[0].trim();
		const keyRe = key ? new RegExp(`^\\s*${escapeRe(key)}\\s*=`) : null;
		if (keyRe) lines = lines.filter((l, i) => !(i < end && keyRe.test(l)));
		// 插在开头连续的注释/空行之后：顶层键必须早于第一个 [table]，但不该淹没 #:schema 这类头注释
		let at = 0;
		while (at < lines.length && (/^\s*#/.test(lines[at]) || lines[at].trim() === "")) at++;
		lines.splice(at, 0, ...block.split("\n"));
		return lines.join(eol).replace(/\s*$/, eol);
	}
	return `${stripped.replace(/\s*$/, "")}${eol}${eol}${block.split("\n").join(eol)}${eol}`;
}

export function stripBlock(text) {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	return text
		.replace(/\r?\n*# >>> agent-purge[\s\S]*?# <<< agent-purge\r?\n*/, eol + eol)
		.replace(/^(?:\r?\n)+/, "")
		.replace(/\s*$/, eol);
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 有些 harness 对单文件有硬上限（grok：10000 字符），超了直接截断并留一行明说 */
function clamp(text, max) {
	if (text.length <= max) return text;
	return text.slice(0, max) + "\n\n（agent-purge：超出该 harness 的文件上限，此处被截断）";
}
