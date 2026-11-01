// 明确的 Node 20+ 瘦包；仅复制运行时白名单，不包含截图、测试输出和私人 persona。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, readJSON, runtimeFiles, writeManifest } from './build-common.mjs';
import { smoke } from './build-smoke.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist'), OUT = join(DIST, 'agent-purge');
const VERSION = readJSON(join(ROOT,'package.json')).version;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
for (const file of runtimeFiles(ROOT)) {
  const target = join(OUT, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(ROOT,file),target);
}
writeFileSync(join(OUT,'agent-purge.cmd'), [
  '@echo off',
  'node -e "process.exit(Number(process.versions.node.split(\'.\')[0]) >= 20 ? 0 : 1)" >nul 2>nul',
  'if errorlevel 1 (echo agent-purge needs Node.js 20+ : https://nodejs.org & exit /b 1)',
  'node "%~dp0bin\\agent-purge.mjs" %*',
].join('\r\n')+'\r\n');

if (process.platform === 'win32') {
  const resource = join(OUT,'launcher.rc'), object = join(OUT,'launcher.res');
  try {
    writeFileSync(resource, `1 ICON "${join(ROOT,'web/assets/agent-purge.ico').replaceAll('\\','/')}"\r\n`);
    const windres = spawnSync('windres',[resource,'-O','coff','-o',object],{cwd:ROOT,encoding:'utf8'});
    if (windres.status !== 0) throw new Error(`windres: ${windres.error?.message ?? windres.stderr}`);
    const gcc = spawnSync('gcc',['-O2','-s','-mwindows',join(ROOT,'packaging/launcher.c'),object,'-o',join(OUT,'agent-purge.exe')],{cwd:ROOT,encoding:'utf8'});
    if (gcc.status !== 0) throw new Error(`gcc: ${gcc.error?.message ?? gcc.stderr}`);
  } finally { rmSync(resource,{force:true});rmSync(object,{force:true}); }
  if (!existsSync(join(OUT,'agent-purge.exe'))) throw new Error('桌面启动器没有生成；不使用旧的预编译文件');
}
writeManifest(OUT,'thin',VERSION,ROOT);
await smoke(process.execPath,[join(OUT,'bin/agent-purge.mjs')],{cwd:OUT,version:VERSION});
console.log(`瘦包：${OUT} (${Math.round(listFiles(OUT).reduce((size,file)=>size+statSync(join(OUT,file)).size,0)/1024)} KB)`);
if (process.platform === 'win32') {
  const zip = join(DIST,`agent-purge-${VERSION}.zip`);
  rmSync(zip,{force:true});
  // PowerShell 7 启动 Node 后再调用 Windows PowerShell 5，会继承不兼容的
  // PSModulePath；直接用系统 .NET ZIP API，不依赖 Archive 模块自动加载。
  const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${OUT.replaceAll("'","''")}','${zip.replaceAll("'","''")}',[IO.Compression.CompressionLevel]::Optimal,$true)`],
    {encoding:'utf8',windowsHide:true});
  if (result.status !== 0) throw new Error(`zip: ${result.error?.message ?? result.stderr}`);
  console.log(`便携 ZIP：${zip} (${Math.round(readFileSync(zip).length/1024)} KB)`);
}
