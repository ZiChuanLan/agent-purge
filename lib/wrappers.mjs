// 已核对的完整模板；只归一换行，未知 wrapper 不授予临时宿主身份。
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
export const MANAGED_PI_BATCH = "@ECHO off\nSETLOCAL\nSET \"node=node\"\n\"%node%\" \"%~dp0pi-launcher.js\" %*\nSET \"pi_exit_code=%ERRORLEVEL%\"\nIF \"%pi_exit_code%\"==\"9009\" (\n  IF \"%node%\"==\"node\" (\n    \"%SystemRoot%\\System32\\where.exe\" /Q node\n    IF ERRORLEVEL 1 GOTO node_missing\n  ) ELSE IF NOT EXIST \"%node%\" GOTO node_missing\n)\nEXIT /B %pi_exit_code%\n:node_missing\nECHO Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev. 1>&2\nEXIT /B %pi_exit_code%\r\n";
export const MANAGED_PI_JS = "const fs = require(\"node:fs\");\nconst path = require(\"node:path\");\nconst { spawnSync } = require(\"node:child_process\");\n\nconst packageName = \"@earendil-works/pi-coding-agent\";\nconst commandName = \"pi\";\nconst agentDir = path.dirname(__dirname);\nconst installRoot = path.join(agentDir, \"install\");\nconst currentFile = path.join(installRoot, \"current-version\");\nconst currentVersion = fs.readFileSync(currentFile, \"utf8\").trim();\nif (!currentVersion || currentVersion === \".\" || currentVersion === \"..\" || !/^[0-9A-Za-z._+-]+$/.test(currentVersion)) {\n\tthrow new Error(`Managed Pi version file is invalid: ${currentFile}`);\n}\n\nconst releaseDir = path.join(installRoot, \"releases\", currentVersion);\nconst packageDir = path.join(releaseDir, \"node_modules\", ...packageName.split(\"/\"));\nconst packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, \"package.json\"), \"utf8\"));\nconst binPath = typeof packageJson.bin === \"string\" ? packageJson.bin : packageJson.bin?.[commandName];\nif (!binPath) {\n\tthrow new Error(`${packageName} does not declare a ${commandName} bin`);\n}\nconst cliPath = path.resolve(packageDir, binPath);\nconst cliRelative = path.relative(packageDir, cliPath);\nif (cliRelative.startsWith(\"..\") || path.isAbsolute(cliRelative) || !fs.statSync(cliPath).isFile()) {\n\tthrow new Error(`Managed Pi executable is invalid: ${cliPath}`);\n}\n\nconst result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {\n\tstdio: \"inherit\",\n\tenv: { ...process.env, PI_MANAGED_INSTALL_ROOT: installRoot },\n});\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\r\n";
export const MANAGED_PI_POWERSHELL = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$launcher=Join-Path $basedir "pi-launcher.js"
$node="node"
try {
  if ($MyInvocation.ExpectingInput) {
    $input | & $node $launcher $args
  } else {
    & $node $launcher $args
  }
} catch [System.Management.Automation.CommandNotFoundException] {
  [Console]::Error.WriteLine("Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev.")
  exit 127
}
exit $LASTEXITCODE
`;
const normalize = source => source.replace(/\r\n?/g, "\n").replace(/\n$/, "");
const same = (source, expected) => normalize(source) === normalize(expected);
export function knownWrapper(file, env, findNode) {
 let source;
 try { source = readFileSync(file, "utf8"); } catch { return null; }
 const dir = dirname(file);
 if ((basename(file).toLowerCase() === "pi.cmd" && same(source, MANAGED_PI_BATCH)) || (basename(file).toLowerCase() === "pi.ps1" && same(source, MANAGED_PI_POWERSHELL))) {
  try {
   if (!same(readFileSync(join(dir, "pi-launcher.js"), "utf8"), MANAGED_PI_JS)) return null;
   const installRoot = join(dirname(dir), "install"), version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
   if (!/^[0-9A-Za-z._+-]+$/.test(version) || [".", ".."].includes(version)) return null;
   const pkg = realpathSync(join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent"));
   const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
   const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
   if (manifest.name !== "@earendil-works/pi-coding-agent" || typeof bin !== "string") return null;
   const entry = realpathSync(resolve(pkg, bin)), inside = relative(pkg, entry);
   if (inside.startsWith("..") || isAbsolute(inside) || !statSync(entry).isFile()) return null;
   const node = findNode(env); if (!node) return null;
   return { cmd: node, args: [entry], env: { PI_MANAGED_INSTALL_ROOT: installRoot }, hostDirect: true };
  } catch { return null; }
 }
 const v1 = join(dir, "node_modules", "opencode-ai", "bin", "opencode.exe");
 const template = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*';
 if (same(source, template) && existsSync(v1)) return { cmd: v1, args: [], hostDirect: true };
 const v2 = join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
 if (same(source, '@echo off\n"' + v2 + '" %*') && existsSync(v2)) return { cmd: v2, args: [], hostDirect: true };
 return null;
}
