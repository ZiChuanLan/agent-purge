// shell:false 为默认；标准 npm shim 直接解析为 Node 入口，其他脚本分开处理。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { resolveActivation } from "./state.mjs";
import { ownShimDirectory } from "./environment.mjs";
import { knownWrapper } from "./wrappers.mjs";

const WIN = process.platform === "win32";
const OWN_SHIM_DIR = ownShimDirectory();
const norm = (p) => WIN ? resolve(p).toLowerCase() : resolve(p);
export function which(names, path, exts = WIN ? [".exe", ".cmd", ".bat", ".ps1"] : [""]) {
 for (const name of names) for (const raw of path.split(delimiter)) {
  const dir = raw.replace(/^"|"$/g, "");
  if (!dir || norm(dir) === norm(OWN_SHIM_DIR)) continue;
  for (const ext of exts) { const p = join(dir, name + ext); if (existsSync(p)) return p; }
 }
 return null;
}
const SPAWN_EXTS = [".exe", ".ps1", ".cmd", ".bat"];
export function resolveBin(name, env = process.env) {
 if (!name) return null;
 if (name.includes("/") || name.includes("\\")) return existsSync(name) ? name : null;
 const real = env.AGENT_PURGE_REAL_BIN;
 if (real && existsSync(real)) {
  const base = real.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/i, "");
  if ((WIN ? base.toLowerCase() : base) === (WIN ? name.toLowerCase() : name)) return real;
 }
 return which([name], env.PATH || env.Path || "", WIN ? SPAWN_EXTS : [""]);
}
/** 显式参数 > 分家配置 > 全局；继承的注入环境不是新一次启用。 */
export function launchConfig(state, id, { persona = null, mode = null } = {}) {
 const activation = resolveActivation(state, id, { launch: true, persona: persona || undefined, mode: mode || undefined });
 return { persona: activation.persona, mode: activation.mode };
}
// 仅接受完整的标准模板；不能从任意脚本中捞出一条 node_modules 路径跳过其他逻辑。
const compact = (s) => s.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).map((l) => l.trim()).filter(Boolean).join("\n");
function npmTarget(file) {
 let text;
 try { text = readFileSync(file, "utf8"); } catch { return null; }
 const ext = extname(file).toLowerCase();
 let target;
 if (ext === ".ps1") {
  const hits = [...text.matchAll(/"\$basedir\/([^"\r\n]+)" \$args/g)];
  if (hits.length !== 4 || !hits.every((m) => m[1] === hits[0][1])) return null;
  target = hits[0][1];
  const template = `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
$exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
if ($MyInvocation.ExpectingInput) {
$input | & "$basedir/node$exe"  "$basedir/${target}" $args
} else {
& "$basedir/node$exe"  "$basedir/${target}" $args
}
$ret=$LASTEXITCODE
} else {
if ($MyInvocation.ExpectingInput) {
$input | & "node$exe"  "$basedir/${target}" $args
} else {
& "node$exe"  "$basedir/${target}" $args
}
$ret=$LASTEXITCODE
}
exit $ret`;
  if (compact(text) !== compact(template)) return null;
 } else if (ext === ".cmd") {
  const legacy = /"%dp0%\\([^"\r\n]+)" %\*/i.exec(text);
  const modern = /SET "NPM_CLI_JS=%~dp0\\([^"\r\n]+)"[\s\S]*?"%NODE_EXE%" "%NPM_CLI_JS%" %\*/i.exec(text);
  const m = legacy ?? modern; if (!m) return null;
  target = m[1];
  if (modern) {
   // Node 20+ 的 npm.cmd 先解析 npm-prefix.js，再执行 npm-cli.js；只接受这一固定入口。
   if (!/^node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/.test(target)) return null;
  } else {
   const template = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
SET "_prog=%dp0%\\node.exe"
) ELSE (
SET "_prog=node"
SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`;
   if (compact(text) !== compact(template)) return null;
  }
 } else return null;
 if (!/^node_modules[\\/]/.test(target) || /[$%`]/.test(target)) return null;
 const script = join(dirname(file), target);
 return existsSync(script) ? script : null;
}
// 已核对的启动器模板：整份匹配，不从未知 batch 中猜入口。
function nativeShim(file) {
 let source;
 try { source = readFileSync(file, "utf8"); } catch { return null; }
 const text = compact(source), dir = dirname(file);
 if (extname(file).toLowerCase() === ".ps1") {
  const m = /"\$basedir\/(node_modules\/[^"\r\n]+\.exe)"\s+\$args/.exec(source);
  if (!m) return null;
  const template = `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
$exe=".exe"
}
if ($MyInvocation.ExpectingInput) {
$input | & "$basedir/${m[1]}"   $args
} else {
& "$basedir/${m[1]}"   $args
}
exit $LASTEXITCODE`;
  const cmd = join(dir, m[1]);
  return text === compact(template) && existsSync(cmd) ? { cmd, args: [] } : null;
 }
 if (extname(file).toLowerCase() !== ".cmd") return null;
 if (text === '@ECHO off\nnode "%~dp0pi-launcher.js" %*') {
  const entry = join(dir, "pi-launcher.js");
  return existsSync(entry) ? { cmd: "node", args: [entry], hostDirect: false } : null;
 }
 const dsh = `@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*
exit /b %errorlevel%`;
 if (text === compact(dsh)) {
  const cmd = resolve(dir, "../../../..", "DeepSeek Harness.exe");
  // app.asar 内部路径由 Electron 读取，普通 existsSync 无法探测。
  const entry = resolve(dir, "../../..", "app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js");
  return existsSync(cmd) ? { cmd, args: ["--expose-internals", entry], env: { ELECTRON_RUN_AS_NODE: "1" } } : null;
 }
 return null;
}
function dispatch(name, args, opts) {
 const env = opts.env ?? process.env;
 if (!args.every((a) => typeof a === "string" && !a.includes("\0"))) throw new Error("参数必须是不含 NUL 的字符串");
 const full = resolveBin(name, env) ?? name;
 if (!WIN) return { hostDirect: true, cmd: full, args, opts: { ...opts, shell: false } };
 const ext = extname(full).toLowerCase();
 const wrapper = [".cmd", ".ps1"].includes(ext) ? knownWrapper(full, env, e => which(["node"], e.PATH || e.Path || "", [".exe"])) ?? nativeShim(full) : null;
 if (wrapper) return { hostDirect: wrapper.hostDirect !== false, cmd: wrapper.cmd, args: [...wrapper.args, ...args], opts: { ...opts, env: { ...env, ...wrapper.env }, shell: false, windowsVerbatimArguments: false } };
 const script = [".cmd", ".ps1"].includes(ext) ? npmTarget(full) : null;
 if (script) {
  const localNode = join(dirname(full), "node.exe");
  const node = existsSync(localNode) ? localNode : which(["node"], env.PATH || env.Path || "", [".exe"]);
  if (!node) throw new Error(`npm shim 找不到其 Node 运行时：${full}`);
  return { hostDirect: true, cmd: node, args: [script, ...args], opts: { ...opts, shell: false, windowsVerbatimArguments: false } };
 }
 if (ext === ".ps1") {
  // 不把用户参数插入 PowerShell 源码/命令行；JSON 通过子进程专用环境传输。
  const payload = JSON.stringify({ file: resolve(full), args });
  if (payload.length > 30000) throw new Error("普通 PowerShell 脚本参数超过 30000 字符，请使用原生入口");
  const code = `$ErrorActionPreference='Stop'; $p=ConvertFrom-Json $env:AGENT_PURGE_PS_ARGS; Remove-Item Env:AGENT_PURGE_PS_ARGS; $a=@($p.args | ForEach-Object {[string]$_}); & $p.file @a; if ($null -ne $LASTEXITCODE) {exit $LASTEXITCODE}`;
  return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(code,"utf16le").toString("base64")], opts: { ...opts, env: { ...env, AGENT_PURGE_PS_ARGS: payload }, shell: false } };
 }
 if (ext === ".cmd" || ext === ".bat") {
  // 未知 batch 可能再次展开 %*；只接收无需多层转义的参数，拒绝静默损坏。
  if (args.some((a) => !/^[a-zA-Z0-9_./:\\=+,-]+$/.test(a)) || /[%!^&|<>\r\n"]/.test(full)) throw new Error(`非标准 batch 不能可靠传递这些参数：${full}；请指向原生 exe 或 Node 入口`);
  const line = `"${full}" ${args.join(" ")}`;
  if (line.length > 7000) throw new Error(`batch 参数过长：${full}`);
  return { cmd: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], opts: { ...opts, shell: false, windowsVerbatimArguments: true } };
 }
 return { hostDirect: ext === ".exe", cmd: full, args, opts: { ...opts, shell: false } };
}
export function prepareCommand(name, args = [], opts = {}) { return dispatch(name, args, opts); }
export function spawnPrepared(descriptor) { return spawn(descriptor.cmd, descriptor.args, descriptor.opts); }
export function spawnBin(name, args = [], opts = {}) {
 const d = dispatch(name, args, opts); return spawn(d.cmd, d.args, d.opts);
}
export function captureBin(name, args = [], opts = {}) {
 try {
  const d = dispatch(name, args, { timeout: 4000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts });
  const r = spawnSync(d.cmd, d.args, d.opts); return r.error || r.status !== 0 ? null : (r.stdout ?? null);
 } catch { return null; }
}
