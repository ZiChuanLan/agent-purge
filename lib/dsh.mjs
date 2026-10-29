// dsh（DeepSeek Harness）的插件通道，三形态（desktop / web / headless）共用一套写法。
//
// 三个插件名，互不覆盖：
//   agent-purge          常驻注入：每次 assemble 读 state.json + active.md，off 即时生效
//   agent-purge-slash    会话内热切：只注册 /purge 命令，不碰系统提示词
//   agent-purge-session  一次性：persona 快照编译进源码，进程退出即删
//
// 三个 profile 都要装：paths 推导自 profile 的 dirname（src/index.js → package root），
// 所以包必须放在 <profile>/node_modules/<name> 下。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DSH_PROFILES = ["desktop", "web", "headless"];
export const RESIDENT = "agent-purge";
export const SLASH_RESIDENT = "agent-purge-slash";
export const SESSION = "agent-purge-session";
/** 我们写过的三个块名：stash 用完即弃的判断用 */
const ALL = [RESIDENT, SLASH_RESIDENT, SESSION];

export const dshHome = () => process.env.DSH_HOME || join(homedir(), ".dsh");
export const profileDir = (p) => join(dshHome(), "profiles", p);
export const pluginDir = (p, name = RESIDENT) => join(profileDir(p), "node_modules", name);
const patchFile = (p) => join(profileDir(p), "cordis.patch.yml");
// 原始字节存 profile 级：插件目录会被删，多插件叠在一起时也要能一起还原（`[]` 空壳）
const stashFile = (p) => join(profileDir(p), ".agent-purge.patch.before");
const parseStash = (file) => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
};
const rmStash = (p) => rmSync(stashFile(p), { force: true });

/** 旧版前缀匹配会把 `-slash` 尾段留在 patch 里（issue #4）。只认第 0 列的裸行：块标量里的内容
 * 必须缩进，子段更不可能出现在列 0，所以这个模式不会误删用户文本。 */
const healStraySlash = (text) => text.replace(/^-slash[ \t]*\r?(?:\n|$)/gm, "");

/** 剥孤儿行会改字节：换写前留一份原始字节，判断错了还有退路。
 * 只在我们真棭行时写，且不覆盖已有备份（否则每次装/卸都会把真正的原文冲掉）。 */
const healBackup = (p, raw) => {
	const f = join(profileDir(p), ".agent-purge.patch.healed");
	if (raw === null || healStraySlash(raw) === raw || existsSync(f)) return;
	writeFileSync(f, raw);
};

/** dsh 的 patch 模板就是一个 `[]`：空 flow 数组后面再接 `- insert:` 是非法 YAML
 * （真 dsh 报 `end of the stream or a document separator is expected`），文档根的 `[]` 先摊平。
 * 只认文档根：手写的 flow 数组、缩进里的 `[]` 原样留着。 */
const flattenEmptyArray = (text) => {
	const lines = text.split("\n");
	const i = lines.findIndex((l) => l.trim() && !/^\s*#/.test(l));
	if (i < 0 || lines[i].trim() !== "[]") return text;
	return [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n");
};

/**
 * dsh 自己建过的 profile（带 package.json）。
 * 不在这个名单里的目录绝不碰：PROFILE_TEMPLATES 里没有 desktop，我们写个
 * 只有 patch + node_modules 的空目录，dsh 启动时会判定 "profile desktop does not exist" 直接拒绝启动。
 * web / headless 虽然会自动 initProfile，但那是 dsh 的活，不是我们的。
 */
export function liveProfiles() {
	return DSH_PROFILES.filter((p) => existsSync(join(profileDir(p), "package.json")));
}

const mark = (name) => [`# >>> agent-purge:${name}`, `# <<< agent-purge:${name}`];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// marker 必须**整行**匹配：`agent-purge` 是 `agent-purge-slash` 的前缀，
// 不锚行的话删常驻块会把 /purge 那段一起吃掉，留下 `-slash` 让 patch 变成非法 YAML（issue #4）。
const blockRe = (name) => {
	const [begin, end] = mark(name);
	return new RegExp(`(?:^|\\r?\\n)${esc(begin)}[ \\t]*\\r?\\n[\\s\\S]*?(?:^|\\r?\\n)${esc(end)}[ \\t]*\\r?(?:\\n|$)`, "g");
};
const hasBlock = (text, name) => blockRe(name).test(text);
/** 把我们的三段（以及旧版残留的孤儿行）都剥掉，得到“没有 agent-purge 的原样”。 */
const stripOurs = (text) => ALL.reduce((t, n) => t.replace(blockRe(n), ""), healStraySlash(text));

/** 这个 package.json 是 agent-purge 写的吗（别碰同名外来目录）。 */
const isOurs = (meta) => existsSync(meta) && /"?agentPurge"?\s*:\s*true/.test(readFileSync(meta, "utf8"));

/** 常驻插件：不编译人设，每次请求现读 state；off 就把宿主的返回值原样透传。 */
export function residentSource(root, activePath) {
	const state = join(root, "state.json").replace(/\\/g, "/");
	// active.md 是派生物，实际位置是 <root>/personas/active.md（由 createStore().materialize 给出）
	const active = String(activePath).replace(/\\/g, "/");
	return `// 由 agent-purge 生成；删掉本目录 + patch 段即取消。
import { readFileSync, appendFileSync } from "node:fs";
const STATE = ${JSON.stringify(state)};
const ACTIVE = ${JSON.stringify(active)};
const NAME = ${JSON.stringify(RESIDENT)};
// 一行一条的运行日志，出问题先看它。写失败静默。
const LOG = STATE.replace(/state\.json$/, "dsh.log");
function log(ev, extra) {
  try {
    appendFileSync(LOG, new Date().toISOString() + " " + PROFILE + " " + ev + (extra ? " " + extra : "") + "\\n");
  } catch { /* 只读环境不抛 */ }
}
// 自己在哪个 profile：<dsh>/profiles/<name>/node_modules/<pkg>/index.js
const PROFILE = (() => {
  try {
    const m = /[\\\\/]profiles[\\\\/]([^\\\\/]+)[\\\\/]/.exec(new URL(import.meta.url).pathname);
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
})();
function cfg() {
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    // 磁盘卸载后内存里的回调还在：armed 里没有 install 就当成已关闭
    const armed = st && st.armed && st.armed.dsh;
    if (!Array.isArray(armed) || !armed.includes("install")) return null;
    // dshProfiles：没设置过 = desktop/web/headless 全开；设了 = 只认列出的那几个（可热改）
    const on = st && Array.isArray(st.dshProfiles) ? st.dshProfiles : null;
    if (on && (!PROFILE || !on.includes(PROFILE))) return null;
    const mode = (st && st.default && st.default.mode) || "replace";
    if (mode === "off") return null;
    const body = readFileSync(ACTIVE, "utf8").trim();
    return body ? { mode, body } : null;
  } catch {
    return null;
  }
}
function put(asm, c) {
  if (!asm || typeof asm !== "object") return asm;
  const sections = Array.isArray(asm.sections) ? asm.sections : [];
  if (c.mode === "append") return { ...asm, sections: [...sections, { name: NAME, text: c.body }] };
  return { ...asm, sections: [{ name: NAME, text: c.body }] };
}
export default {
  name: NAME,
  inject: ["systemPrompt"],
  apply(ctx) {
    log("apply", "inject=" + JSON.stringify(["systemPrompt"]));
    // 宿主每轮 assemble 走 system-prompt/assemble 瀑布。必须 global：agent 作用域的
    // systemPrompt 是另一个实例，且切预设时宿主会整只换代理，实例上的 monkey-patch 会丢。
    const handler = async (assembly, _context, next) => {
      let assembled = assembly;
      if (typeof next === "function") {
        try {
          assembled = await next();
        } catch {
          assembled = assembly; // 下游抛错也要让上游兜底，不能把整轮发消息弄死
        }
      }
      const c = cfg();
      const out = c ? put(assembled, c) : assembled;
      log("assemble", (c ? "mode=" + c.mode : "off")
        + " in=" + (Array.isArray(assembled && assembled.sections) ? assembled.sections.length : -1)
        + " out=" + (Array.isArray(out && out.sections) ? out.sections.length : -1)
        + " names=" + (Array.isArray(out && out.sections) ? out.sections.map((s) => s && s.name).join(",") : "-"));
      return out;
    };
    try {
      ctx.on("system-prompt/assemble", handler, { global: true, prepend: true });
      log("hook", "system-prompt/assemble global");
    } catch (e) {
      // 老版本没有这个瀑布：退回包 assemble（关闭时同 this、同参数、同返回类型）
      const prompt = ctx.systemPrompt;
      const orig = prompt.assemble;
      prompt.assemble = function (...rest) {
        const c = cfg();
        if (!c) return orig.apply(this, rest);
        const out = orig.apply(this, rest);
        if (out && typeof out.then === "function") return out.then((asm) => put(asm, c));
        return put(out, c);
      };
    }
  },
};
`;
}

/** 会话内热切插件：只注册 /purge，改 state.json，不产生模型消息、不碰系统提示词。 */
export function slashSource(root) {
	const state = join(root, "state.json").replace(/\\/g, "/");
	return `// 由 agent-purge 生成（/purge 命令）；删掉本目录 + patch 段即取消。
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const STATE = ${JSON.stringify(state)};
const NAME = ${JSON.stringify(SLASH_RESIDENT)};
const LOG = STATE.replace(/state\.json$/, "dsh.log");
function log(ev, extra) {
  try {
    appendFileSync(LOG, new Date().toISOString() + " " + PROFILE + " " + ev + (extra ? " " + extra : "") + "\\n");
  } catch { /* 只读环境不抛 */ }
}
const PROFILE = (() => {
  try {
    const m = /[\\\\/]profiles[\\\\/]([^\\\\/]+)[\\\\/]/.exec(new URL(import.meta.url).pathname);
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
})();
function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")) || {}; } catch { return {}; }
}
function saveState(st) {
  writeFileSync(STATE, JSON.stringify(st, null, 2) + "\\n");
}
function apPatch(fn) {
  const st = readState();
  if (!st.armed || typeof st.armed !== "object") st.armed = {};
  if (!Array.isArray(st.armed.dsh)) st.armed.dsh = [];
  fn(st, st.armed.dsh);
  saveState(st);
}
function handleAp(raw) {
  const parts = String(raw || "").trim().split(/\\s+/).filter(Boolean);
  const cmd = (parts[0] || "status").toLowerCase();
  const arg = parts.slice(1).join(" ").trim();
  if (cmd === "off") {
    apPatch((st, a) => {
      if (a.includes("install")) {
        st.dshPrevArmed = a.slice();
        st.armed.dsh = a.filter((x) => x !== "install");
      }
    });
    return { kind: "success", text: "agent-purge 已关闭（dsh），下一句起不注入" };
  }
  if (cmd === "on") {
    apPatch((st, a) => {
      if (!a.includes("install")) a.push("install");
      delete st.dshPrevArmed;
    });
    return { kind: "success", text: "agent-purge 已开启（dsh），下一句起生效" };
  }
  if (cmd === "mode") {
    const m = arg.toLowerCase();
    if (m !== "strict" && m !== "replace" && m !== "append") {
      return { kind: "error", text: "用法：/purge mode strict|replace|append" };
    }
    apPatch((st) => { if (!st.default || typeof st.default !== "object") st.default = {}; st.default.mode = m; });
    return { kind: "success", text: "模式已切到 " + m };
  }
  if (cmd === "status" || cmd === "help") {
    const st = readState();
    const a = st.armed && Array.isArray(st.armed.dsh) ? st.armed.dsh : [];
    const mode = (st.default && st.default.mode) || "replace";
    return { kind: "success", text: "agent-purge / dsh：" + (a.includes("install") ? "开" : "关") + " · 模式 " + mode + " · 人设 " + (st.persona || "-") + "（可用：on | off | status | mode <strict|replace|append>）" };
  }
  return { kind: "error", text: "用法：/purge on | off | status | mode <strict|replace|append>" };
}
export default {
  name: NAME,
  apply(ctx) {
    log("apply", "slash-only");
    try {
      if (typeof ctx.inject === "function") {
        ctx.inject(["commands"], (c) => {
          const spec = {
            description: "agent-purge 人设注入：开关 / 模式",
            input: { hint: "on | off | status | mode <strict|replace|append>" },
            handler: ({ rawInput }) => handleAp(rawInput),
          };
          // 主名 /purge（和 pi 等其他 harness 统一），/ap 留作别名；
          // 与已有同名命令（如 dsh-purge）撞车时只跳过那一个
          for (const n of ["purge", "ap"]) {
            try {
              c.commands.register({ name: n, ...spec });
              log("command", "registered /" + n);
            } catch (e) {
              log("command", "skip /" + n + " " + (e && e.message));
            }
          }
        });
      } else {
        log("command", "no inject api");
      }
    } catch (e) {
      log("command", "err " + (e && e.message));
    }
  },
};
`;
}

/** 一次性插件：人设快照内嵌，进程结束就没。 */
export function sessionSource(personaText, mode) {
	const put =
		mode === "append"
			? `return { ...asm, sections: [...(Array.isArray(asm.sections) ? asm.sections : []), { name: NAME, text: PERSONA }] };`
			: `return { ...asm, sections: [{ name: NAME, text: PERSONA }] };`;
	return `// 由 agent-purge 生成（一次性，进程退出即删）。
const PERSONA = ${JSON.stringify(personaText.trim())};
const NAME = ${JSON.stringify(SESSION)};
export default {
  name: NAME,
  inject: ["systemPrompt"],
  apply(ctx) {
    const prompt = ctx.systemPrompt;
    const orig = prompt.assemble;
    // 同常驻插件：不包 async，保持宿主的返回类型
    prompt.assemble = function (...rest) {
      const out = orig.apply(this, rest);
      const put = (asm) => {
        if (!asm || typeof asm !== "object") return asm;
        ${put}
      };
      if (out && typeof out.then === "function") return out.then(put);
      return put(out);
    };
  },
};
`;
}

/** 装一个插件名到三个 profile，并在 patch 里挂上（同一段 marker 幂等）。 */
export function addPlugin(name, source) {
	const pkg = JSON.stringify({ name, version: "0.0.0", type: "module", main: "index.js", agentPurge: true }, null, 1);
	const [begin, end] = mark(name);
	const block = `\n${begin}\n- insert:\n    - id: ${name}\n      name: ${name}\n${end}\n`;
	const files = [];
	const touched = []; // { dir, patch, before }：中途抛错时按相反顺序回滚
	// 只装进 dsh 已经建好的 profile；一个都没有说明 dsh 还没跑过
	const targets = liveProfiles();
	if (targets.length === 0) throw new Error("找不到任何 dsh profile（~/.dsh/profiles/*/package.json）—— 先启动一次 dsh，让它把 profile 建好再来装");
	// 预检：同名目录要么不存在，要么是我们的（package.json 带 agentPurge 标记），否则不碰
	for (const p of targets) {
		const dir = pluginDir(p, name);
		const meta = join(dir, "package.json");
		if (existsSync(dir) && !isOurs(meta)) throw new Error(`${dir} 已存在且不是 agent-purge 装的，拒绝覆盖`);
	}
	try {
		for (const p of targets) {
			const dir = pluginDir(p, name);
			const patch = patchFile(p);
			const before = existsSync(patch) ? readFileSync(patch, "utf8") : null;
			// 先登记再动手：下面任何一步抛错，这一轮的产物都能被回滚（stash 一并回滚）
			touched.push({ dir, patch, before, existedDir: existsSync(dir), stashPath: stashFile(p), stash: existsSync(stashFile(p)) ? readFileSync(stashFile(p), "utf8") : null });
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), pkg);
			writeFileSync(join(dir, "index.js"), source);
			files.push(dir);
			// 旧版前缀匹配留下的孤儿 `-slash` 行会让整份 patch 不是合法 YAML：写入前剥掉
			const stripped = healStraySlash(before ?? "");
			const healed = flattenEmptyArray(stripped);
			healBackup(p, before);
			if (hasBlock(healed, name)) {
				if (healed !== (before ?? "")) {
					// 旧版装坏的 `[]` + 块：把自愈后的形态记成 stash.after，卸载才还原得回原文
					const prev = parseStash(stashFile(p));
					const keep = prev && prev.after === before ? prev.before : stripOurs(before ?? "");
					writeFileSync(stashFile(p), JSON.stringify({ before: keep, after: healed }));
					writeFileSync(patch, healed);
				}
				continue;
			}
			// 空文档（模板那个 `[]`）直接换成我们的段；stash 记剥孤儿后的原样，卸载还回 `[]`
			const next = healed.trim() ? healed + block : block.slice(1);
			const prev = parseStash(stashFile(p));
			// 还原点只在文件还是我们上次写的样子时有效：被改过就按当前字节重新记，
			// 否则旧 before 会把用户后来写的内容整份覆盖掉（或把文件误删）
			let keep = null;
			if (prev && prev.after === before) keep = prev.before;
			// 旧版写坏的 patch（`[]` + 块）里也含我们的块：还原点得先剥掉自己，否则卸载后会回放旧块
			else if (before !== null) keep = stripOurs(before);
			writeFileSync(stashFile(p), JSON.stringify({ before: keep, after: next }));
			writeFileSync(patch, next);
		}
	} catch (e) {
		// 回滚：撤销本次已写的文件，宁可完全没装也不留半套
		for (const { dir, patch, before, existedDir, stashPath, stash } of touched.reverse()) {
			// 只删这一轮新建的目录：重装时目录本来就在，删掉会让还原后的 patch 指向一个不存在的包
			if (!existedDir) rmSync(dir, { recursive: true, force: true });
			if (before === null) rmSync(patch, { force: true });
			else writeFileSync(patch, before);
			if (stash === null) rmSync(stashPath, { force: true });
			else writeFileSync(stashPath, stash);
		}
		throw e;
	}
	return { dirs: files, profiles: targets };
}

/** 只撤自己那一段：目录 + patch marker，别的配置原样。 */
export function removePlugin(name) {
	// 删 install 写入的那一段：前导 \n 可有可无（整份替换的形态没有），尾随 \n 一并吃掉
	const re = blockRe(name);
	for (const p of DSH_PROFILES) {
		const dir = pluginDir(p, name);
		const meta = join(dir, "package.json");
		// 只删自己装的；同名但不是我们的目录留着（可能被用户或其他包占了）
		const ours = isOurs(meta);
		// 当初整份替换过的：先读出来，不然删目录就丢了（新版在 profile 根，旧版在插件目录）
		const stash = parseStash(stashFile(p)) ?? parseStash(join(dir, ".patch.before"));
		if (ours) rmSync(dir, { recursive: true, force: true });
		const patch = patchFile(p);
		if (!existsSync(patch)) continue;
		const text = readFileSync(patch, "utf8");
		const healed = healStraySlash(text);
		healBackup(p, text);
		// 我们整份写的、且此后没人动过、且这是最后一个属于自己的块 → 整份还原（原本没这个文件就删掉它）
		// 还有别的块（例如先装的 /purge）时不能整份还原，否则会连带把它抹掉
		const siblings = ALL.filter((n) => n !== name && hasBlock(text, n));
		if (stash && text === stash.after && siblings.length === 0) {
			if (stash.before === null) rmSync(patch, { force: true });
			else writeFileSync(patch, stash.before);
			rmStash(p);
			continue;
		}
		let next = healed;
		if (hasBlock(next, name)) next = next.replace(re, "");
		// 卸到没有我们的块了：剩下的只要等于“原文摊平 `[]` 后的样子”，就把原文逐字节还回去
		// （多块先后装时，第一个块删完 text 就不再等于 stash.after，但剩下的仍然是原文）
		if (stash && !ALL.some((n) => hasBlock(next, n))) {
			const base = stash.before === null ? "" : stash.before;
			const baseFlat = flattenEmptyArray(healStraySlash(base));
			// 只认两种“等于原文”：逐字节相等，或两边都只剩空白（原文是那个 `[]` 空壳）
			if (next === baseFlat || (next.trim() === "" && baseFlat.trim() === "")) {
				if (stash.before === null) rmSync(patch, { force: true });
				else writeFileSync(patch, stash.before);
				rmStash(p);
				continue;
			}
		}
		if (next !== text) writeFileSync(patch, next);
		// 我们三个块都不在了 → 这份 stash 用完即弃
		if (!ALL.some((n) => hasBlock(next, n))) rmStash(p);
	}
}

/** 盘上真有那份插件文件的位置：status / armed 对账用。
 * 不能拿没装过的 desktop 路径当真相：web/headless 装了、desktop 没建过时，
 * 读那个路径就是 ENOENT（issue #3）。 */
export function pluginFileOnDisk(name) {
	for (const p of liveProfiles()) {
		const f = join(pluginDir(p, name), "index.js");
		if (existsSync(f)) return f;
	}
	return join(pluginDir("desktop", name), "index.js");
}

/** 任一份 profile 挂着就算能用：/purge 是会话内的，后来新建的 profile 不影响已有会话。 */
export function hasPluginAny(name) {
	const targets = liveProfiles();
	return targets.length > 0 && targets.some((p) => {
		const patch = patchFile(p);
		return existsSync(join(pluginDir(p, name), "index.js")) && existsSync(patch) && hasBlock(readFileSync(patch, "utf8"), name);
	});
}

/** patch 里还挂着这个名字吗（status 用；不许在有其他 insert 时谎报干净）。 */
export function hasPlugin(name) {
	const targets = liveProfiles();
	if (targets.length === 0) return false;
	return targets.every((p) => {
		const patch = patchFile(p);
		return existsSync(join(pluginDir(p, name), "index.js")) && existsSync(patch) && hasBlock(readFileSync(patch, "utf8"), name);
	});
}
