// 每家的 build() 是纯函数：只描述"怎么启动"，不 spawn、不写盘。
// setup/cleanup 由入口统一调用，保证能按哈希回滚。
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SESSION as DSH_SESSION, addPlugin, sessionSource } from "../lib/dsh.mjs";
import { opencodePlugins, targets } from "../lib/persist.mjs";
import { opencodeSource } from "../lib/opencode.mjs";
import { dataHome } from "../lib/home.mjs";
import { swapFile } from "../lib/restore.mjs";
import { installKilocode, uninstallKilocode } from "../lib/kilocode.mjs";

function temporaryPlugin(harness, file, root, args) {
 let undo = null;
 return { cmd: harness, args, runtime: true,
  setup: () => { mkdirSync(join(file, ".."), { recursive: true }); if (!undo) undo = swapFile(file, opencodeSource(root, harness, { temporary: true })); },
  cleanup: () => { if (undo) { undo(); undo = null; } },
 };
}

const inline = (text) => text.replace(/\s+$/, "");
// codex 的 -c 值按 TOML 解析：整段人设必须包成 basic string，否则空格/引号/换行会解析失败。
const tomlStr = (value) => JSON.stringify(String(value));

export const backends = {
	// pi：命令行已试过 --system-prompt，但 pi.cmd 走 cmd.exe，10K 人设会撞 8191 上限（实测“命令行太长”）。
	// 所以 pi 的注入靠扩展（sys 层、无长度限制、跟 state.json 走），这里只透传。
	// 扩展由 launch() 在启动前自动确保安装。
	pi: ({ args }) => ({ cmd: "pi", args }),

	codex: ({ personaPath, personaText, mode, args }) => ({
		cmd: "codex",
		args:
			mode === "off"
				? [...args]
				: mode === "append"
					? ["-c", `developer_instructions=${tomlStr(inline(personaText))}`, ...args]
					: ["-c", `model_instructions_file=${tomlStr(personaPath.replace(/\\/g, "/"))}`, ...args],
	}),

// CodeBuddy（腾讯云，npm @tencent-ai/codebuddy-code）：原生整段替换，无残留
	codebuddy: ({ personaPath, personaText, mode, args }) => ({
		cmd: "codebuddy",
		args:
			mode === "off"
				? [...args]
				: mode === "append"
					? ["--append-system-prompt", inline(personaText), ...args]
					// replace 走文件：内联 9.6K 会把裸命令（.cmd 包装器）撞上 8191 上限
					: ["--system-prompt-file", personaPath, ...args],
	}),

	claude: ({ personaPath, mode, args }) => ({
		cmd: "claude",
		args:
			mode === "off"
				? [...args]
				: mode === "append"
					? ["--append-system-prompt-file", personaPath, ...args]
					: ["--system-prompt-file", personaPath, ...args],
		residueHint: mode === "off" ? "" : "不补丁时残留 62 字身份句",
	}),

	grok: ({ personaText, mode, args }) => ({
		cmd: "grok",
		args:
			mode === "off"
				? [...args]
				: mode === "append"
					? ["--rules", inline(personaText), ...args]
					: ["--system-prompt-override", inline(personaText), ...args],
	}),

	omp: ({ personaText, mode, args }) =>
		mode === "off"
			? { cmd: "omp", args: [...args] }
			: {
					cmd: "omp",
					args: [mode === "append" ? "--append-system-prompt" : "--system-prompt", inline(personaText), ...args],
					residueHint: "MCP tool routes 仍会追加（10K 量级），关掉 MCP server 可缩",
				},

	// 临时插件与常驻插件不共享许可；人设正文不编译进孤儿文件。
	opencode: ({ mode, cwd, args, root = dataHome() }) => {
		if (mode === "off") return { cmd: "opencode", args: [...args] };
		return temporaryPlugin("opencode", join(cwd, ".opencode", "plugin", "agent-purge.ts"), root, args);
	},
	dsh: ({ mode, args, root = dataHome() }) => {
		if (mode === "off") return { cmd: "dsh", args: ["--profile", "headless", ...args] };
		let temporary = null;
		return { cmd: "dsh", args: ["--profile", "headless", ...args], runtime: true,
			setup: () => { if (!temporary) temporary = addPlugin(DSH_SESSION, sessionSource("", mode, root), { temporary: true }); },
			cleanup: () => { if (temporary) { temporary.cleanup(); temporary = null; } } };
	},
	opencode2: ({ mode, args, root = dataHome() }) => {
		if (mode === "off") return { cmd: "opencode2", args: [...args], privateServer: true };
		return { ...temporaryPlugin("opencode2", join(opencodePlugins(), "agent-purge-v2-session.ts"), root, args), privateServer: true };
	},

	// Kilo Code：code.md 覆盖默认 code agent 的 prompt；AGENTS.md 是 append 通道。
	// 一次性运行用临时安装，退出时按 stash 还原；交互式启动可先 agent-purge install kilo。
	kilo: ({ personaText, mode, args, root = dataHome() }) => {
		if (mode === "off") return { cmd: "kilo", args: ["run", ...args] };
		let installed = false;
		return {
			cmd: "kilo",
			args: ["run", ...args],
			setup: () => { if (!installed) { installKilocode(root, { personaText, mode }); installed = true; } },
			cleanup: () => { if (installed) { uninstallKilocode(root); installed = false; } },
		};
	},

	// 需要落盘或调用方配合，CLI 不代劳，只给可复制的配方
	zcode: () => ({
		manual: [
			"CLI 拿不到 customSystemPrompt（只有 app-server/SDK 能传）；CLI 只有 UserPromptSubmit hook 注入，且落在 user 角色。",
			"注入配方: ~/.zcode/cli/config.json 里 hooks.enabled=true + UserPromptSubmit hook 返回 additionalContext。",
			"归零配方: 等长替换 resources/glm/zcode.cjs 里的 IJs（42 字），但 cli_prefix 段仍留 42 字。",
		],
	}),

	// 交互式：SOUL.md 是唯一身份入口。启动前写入、退出还原（在 UI 里接管着就一直留着）。
	// 注意它只在会话首次/重建时读 SOUL.md：续会话从 session DB 还原 system 提示词，改文件不当场生效
	// （源码 agent/conversation_loop.py::_restore_or_build_system_prompt）。
	hermes: ({ personaText, personaPath, mode, args = [] }) => {
		let undo = null;
		return {
			cmd: "hermes",
			args: [...(mode === "off" ? [] : ["--ignore-rules"]), ...args],
			note: "SOUL.md 仅供新会话读取；退出后恢复启动前的原字节，不更改常驻选择",
			setup: () => {
				if (mode === "off" || undo) return;
				const file = targets.hermes.file();
				mkdirSync(join(file, ".."), { recursive: true });
				const original = existsSync(file) ? readFileSync(file, "utf8") : "";
				const body = personaText ?? readFileSync(personaPath, "utf8");
				undo = swapFile(file, mode === "append" ? original + "\n\n" + body : body);
			},
			cleanup: () => { if (undo) { undo(); undo = null; } },
		};
	},

	antigravity: () => ({
		manual: [
			"prompt 在 resources/bin/language_server.exe（Go embed.FS）。",
			"闭源 App 的身份句在二进制里，只能等长替换；改动会使签名失效、更新被覆盖，所以默认不做。",
		],
	}),
};




// 一次性问答（headless）规格：Web UI 与 `agent-purge <h> --ask` 共用。
// 只收录实测过参数的 harness，没验过的不猜。
export const oneshots = {
	pi: ({ prompt }) => ({
		cmd: "pi",
		args: ["-p", prompt],
		note: "注入靠扩展（sys 层）；人设走 state.json，不占命令行",
	}),
	claude: ({ prompt, personaPath, mode }) => ({
		cmd: "claude",
		args: ["-p", prompt, ...(mode === "off" ? [] : [mode === "append" ? "--append-system-prompt-file" : "--system-prompt-file", personaPath])],
	}),
	grok: ({ prompt, personaText, mode }) => ({
		cmd: "grok",
		args: ["-p", prompt, "--always-approve", ...(mode === "off" ? [] : [mode === "append" ? "--rules" : "--system-prompt-override", inline(personaText)])],
	}),
	omp: ({ prompt, personaText, mode }) => ({
		cmd: "omp",
		args: ["-p", ...(mode === "off" ? [] : [mode === "append" ? "--append-system-prompt" : "--system-prompt", inline(personaText)]), prompt],
	}),
	codex: ({ prompt, personaPath, personaText, mode }) => ({
		cmd: "codex",
		args: [
			...(mode === "off"
				? []
				: ["-c", mode === "append" ? `developer_instructions=${tomlStr(inline(personaText))}` : `model_instructions_file=${tomlStr(personaPath.replace(/\\/g, "/"))}`]),
			"exec",
			prompt,
		],
	}),
	opencode: ({ prompt, personaText, mode, cwd, root }) => {
		if (mode === "off") return { cmd: "opencode", args: ["run", prompt] };
		const b = backends.opencode({ personaText, mode, cwd, root, args: ["run", prompt] });
		return b;
	},
	opencode2: ({ prompt, personaText, mode, root }) => {
		if (mode === "off") return { cmd: "opencode2", args: ["run", prompt], privateServer: true };
		const b = backends.opencode2({ personaText, mode, root, args: ["run", prompt] });
		return b;
	},
	dsh: ({ prompt, personaText, mode, root }) => {
		if (mode === "off") return { cmd: "dsh", args: ["--profile", "headless", prompt] };
		// backends.dsh 会自己补 --profile headless，这里只给 prompt（否则重复）
		return backends.dsh({ personaText, mode, root, args: [prompt] });
	},
	zcode: ({ prompt }) => ({
		cmd: "zcode",
		args: ["--prompt", prompt, "--mode", "yolo", "--output-format", "stream-json", "--no-color"],
		note: "persona 对 zcode CLI 不生效：customSystemPrompt 只有 app-server/SDK 能传",
	}),
	kilo: ({ prompt, personaText, mode, root }) => {
		if (mode === "off") return { cmd: "kilo", args: ["run", prompt, "--format", "json"] };
		let installed = false;
		return {
			cmd: "kilo",
			args: ["run", prompt, "--format", "json"],
			setup: () => { if (!installed) { installKilocode(root, { personaText, mode }); installed = true; } },
			cleanup: () => { if (installed) { uninstallKilocode(root); installed = false; } },
		};
	},

	codebuddy: ({ prompt, personaPath, personaText, mode }) => ({
		cmd: "codebuddy",
		args: [
			"-p",
			prompt,
			"--max-turns",
			"5",
			...(mode === "off"
				? []
				: mode === "append"
					? ["--append-system-prompt", inline(personaText)]
					: ["--system-prompt-file", personaPath]),
		],
	}),
	hermes: ({ prompt, personaText, personaPath, mode }) => backends.hermes({ personaText, personaPath, mode, args: ["-z", prompt] }),
};
