// pi/omp 使用同一生成器；源码与生成运行时共用启用、锁和来源追踪实现。
import { resolveRuntime, rewriteRuntime } from "./rewrite.mjs";
import { launchRuntime } from "./launch.mjs";
import { controlRuntime } from "./control.mjs";

export function extensionSource(root, harness) {
	return `// agent-purge 托管扩展：每轮读取配置；首次安装/更新后重载扩展。
import { readFileSync } from "node:fs";
${controlRuntime}
const HOME = ${JSON.stringify(root)};
const STATE = HOME + "/state.json";
const PERSONAS = HOME + "/personas/";
const HARNESS = ${JSON.stringify(harness)};
const AUTO = HARNESS + "Auto";
${rewriteRuntime}
${resolveRuntime}
${launchRuntime}
function readState() {
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    return st && typeof st === "object" && !Array.isArray(st) ? st : null;
  } catch { return null; }
}
function loadPersona(id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id || "") || id === "active") return { id: null, body: "" };
  try {
    const raw = readFileSync(PERSONAS + id + ".md", "utf8").replace(/^---\\r?\\n[\\s\\S]*?\\r?\\n---(?:\\r?\\n|$)/, "");
    return { id, body: raw.trim() };
  } catch { return { id, body: "" }; }
}
export default function agentPurge(api) {
  let forced = null, explicitMode = null, commandEpoch = null;
  let rewrite = createTextRewriter();
  let messageRecords = new Map(), generated = createProvenance(), bridge = null, lastCwd = "";
  function cwdOf(event) {
    return String(event?.systemPromptOptions?.cwd ?? process.cwd()).replace(/\\\\/g, "/");
  }
  function interpolatePersona(text, cwd) {
    if (!text || !text.includes("{{cwd}}")) return text;
    return cwd ? text.split("{{cwd}}").join(cwd) : text.replace(/[ \\t]*\\{\\{cwd\\}\\}[ \\t]*/g, " ").replace(/[ \\t]+\\n/g, "\\n");
  }
  function config() {
    const raw = readState();
    // PI-Desktop 没有独立的“自动应用”开关：沿用 pi 的 piAuto（同一套 state、同一套人设）
    const st = HARNESS === "pi-desktop" && raw && raw["pi-desktopAuto"] === undefined
      ? { ...raw, "pi-desktopAuto": raw.piAuto === true } : raw;
    const launch = readLaunch(HOME, st, HARNESS);
    const epoch = (st?.activationEpoch || "initial") + ":" + (st?.harnessEpochs?.[HARNESS] || "initial");
    if (commandEpoch && commandEpoch !== epoch) { forced = null; explicitMode = null; commandEpoch = null; }
    const c = resolveActivation(st, HARNESS, { channel: "slash", session: forced, launch: !!launch,
      mode: explicitMode || launch?.mode, persona: launch?.persona });
    // CLI 参数已注入时，这个进程的常驻扩展只负责撤销自己以前写的内容。
    if (launch?.writer === "cli") c.on = false;
    const persona = loadPersona(c.persona);
    return { ...c, st, ...persona, on: c.on && !!persona.body, epoch };
  }
  function recordFor(msg, index) {
    const key = msg.role + ":" + (msg.id ?? msg.timestamp ?? index);
    if (!messageRecords.has(key)) messageRecords.set(key, createProvenance());
    while (messageRecords.size > 64) messageRecords.delete(messageRecords.keys().next().value);
    return messageRecords.get(key);
  }
  api.on("session_start", async () => {
    forced = null; explicitMode = null; commandEpoch = null;
    rewrite = createTextRewriter(); messageRecords = new Map(); generated = createProvenance(); bridge = null;
  });
  api.on("before_agent_start", async event => {
    const c = config();
    const cwd = cwdOf(event);
    lastCwd = cwd;
    const persona = c.on ? interpolatePersona(c.body, cwd) : "";
    const input = Array.isArray(event.systemPrompt) ? event.systemPrompt : [event.systemPrompt ?? ""];
    const restored = rewrite(input, "", "off");
    let next = rewrite(input, persona, c.on ? c.mode : "off");
    if (!c.on) {
      const list = Array.isArray(next) ? next : [next];
      next = list.map(t => typeof t === "string" && t.includes("# >>> agent-purge") ? cleanManaged(t) : t);
    }
    const finalPrompt = HARNESS === "omp" ? next : (Array.isArray(next) ? next : [next]).join("\\n\\n");
    if (c.on) bridge = { before: restored.join("\\n\\n"), after: (Array.isArray(next) ? next : [next]).join("\\n\\n") };
    if (!c.on && event?.systemPromptOptions && finalPrompt === event.systemPrompt) return;
    return { systemPrompt: finalPrompt };
  });
  if (HARNESS === "pi") {
    try {
      api.on("context_with_system", async event => {
        if (!Array.isArray(event.messages)) return;
        const c = config(), messages = event.messages;
        // 只有完整匹配本会话生成消息的来源记录才删除，宿主/用户同名标签不参与清洗。
        for (let i = messages.length - 1; i >= 0; i--) if (generated.restore(messages[i]) === null) messages.splice(i, 1);
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.role !== "system" && msg.role !== "user") continue;
          const provenance = recordFor(msg, messages.slice(0, i).filter(m => m.role === msg.role).length);
          let host = provenance.restore(msg.content);
          if (msg.role === "system" && bridge) {
            if (host === bridge.after) host = bridge.before;
            else if (Array.isArray(host)) host = host.map(b => b?.text === bridge.after ? { ...b, text: bridge.before } : b);
          }
          let next = host;
          const persona = c.on ? interpolatePersona(c.body, lastCwd || cwdOf({})) : "";
          if (msg.role === "system") {
            if (c.on) {
              next = typeof host === "string" ? rewriteTexts([host], persona, c.mode).join("\\n\\n") : createContentRewriter()(host, persona, c.mode);
            } else if (typeof host === "string" && host.includes("# >>> agent-purge")) {
              next = cleanManaged(host);
            }
          }
          msg.content = provenance.remember(host, next);
        }
        if (c.on && !messages.some(m => m.role === "system")) {
          const own = { role: "system", content: interpolatePersona(c.body, lastCwd || cwdOf({})) };
          generated.remember(null, own); messages.unshift(own);
        }
        if (c.on && c.st.piUserLayer) {
          const index = messages.findLastIndex(m => m.role === "user");
          if (index >= 0) {
            const msg = messages[index], provenance = recordFor(msg, messages.slice(0, index).filter(m => m.role === msg.role).length);
            const host = provenance.restore(msg.content);
            const prefix = "<agent-purge>\\n" + interpolatePersona(c.body, lastCwd || cwdOf({})) + "\\n</agent-purge>\\n\\n";
            const next = typeof host === "string" ? prefix + host : [{ type: "text", text: prefix }, ...(Array.isArray(host) ? host : [])];
            msg.content = provenance.remember(host, next);
          }
        }
      });
    } catch { /* 旧宿主只支持 before_agent_start */ }
  }
  api.registerCommand("purge", {
    description: "会话开关、人设与模式（跟随 agent-purge 配置）",
    getArgumentCompletions: prefix => ["on", "off", "always", "status", "reload", "mode"].filter(v => v.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [cmd = "", want] = String(args).trim().split(/\\s+/);
      const tell = (text, level = "info") => ctx.ui.notify(text, level);
      const c = config();
      const summary = "状态: " + (c.on ? "开启" : "关闭") + "\\n模式: " + c.mode + "\\n人设: " + (c.id || "未设置") + "\\n启用来源: " + (c.source || c.blockedBy || "无") + "\\n配置: " + STATE;
      if (cmd === "status") return tell(summary);
      if (cmd === "reload") return tell("已重读最新配置与人设（每轮自动热读，无需重启）\\n" + summary);
      if (cmd === "off" || (!cmd && c.on)) { forced = false; commandEpoch = c.epoch; return tell("本会话已关闭；下一轮撤销有来源记录的内容"); }
      if (cmd === "on" || !cmd) {
        const activation = resolveActivation(c.st, HARNESS, { channel: "slash", session: true });
        if (!activation.on) return tell("当前未启用: " + activation.blockedBy, "error");
        if (!c.body) return tell("没有可用人设", "error");
        forced = true; commandEpoch = c.epoch;
        return tell("本会话已开启，下一轮读取当前人设");
      }
      if (cmd === "mode") {
        if (!["strict", "replace", "append"].includes(want)) return tell("用法: /purge mode strict|replace|append", "error");
        explicitMode = want; commandEpoch = c.epoch;
        return tell("本会话模式 → " + want + "；暂停和执行器停用仍优先");
      }
      if (cmd === "always") {
        if (!["on", "off"].includes(want)) return tell("用法: /purge always on|off", "error");
        try {
          withControlLock(HOME, () => {
            const st = readState(); if (!st) throw new Error("配置缺失或损坏");
            atomicControlJSON(STATE, { ...st, [AUTO]: want === "on" });
          });
          return tell("裸启动自动应用 → " + want + "；通道选择和暂停保持不变");
        } catch (e) { return tell(e.message, "error"); }
      }
      tell("用法: /purge [on|off|status|reload|mode strict|replace|append|always on|off]", "error");
    },
  });
}
`;
}
