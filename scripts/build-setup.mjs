// 安装器只包含 manifest 验证过、与当前源码完全一致的 Node 瘦包，绝不借用独立 exe 的旧树。
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, validateThin } from './build-common.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'), DIST=join(ROOT,'dist');
const version=readJSON(join(ROOT,'package.json')).version;
if (process.platform!=='win32') throw new Error('Windows 安装器需要 Windows + Inno Setup 6');
validateThin(join(DIST,'agent-purge'),ROOT);
mkdirSync(DIST,{recursive:true});
writeFileSync(join(DIST,'version.iss'),`#define AppVer "${version}"\n`);
const candidates=['C:/Program Files (x86)/Inno Setup 6/ISCC.exe','C:/Program Files/Inno Setup 6/ISCC.exe',join(process.env.LOCALAPPDATA??'','Programs','Inno Setup 6','ISCC.exe')];
const which=spawnSync('where',['iscc'],{encoding:'utf8'});
const iscc=candidates.find(file=>existsSync(file))??(which.status===0?which.stdout.split(/\r?\n/)[0].trim():null);
if (!iscc) throw new Error('找不到 Inno Setup 6；安装后重跑 build:setup。瘦包仍可使用。');
const result=spawnSync(iscc,[`/DAppVer=${version}`,join(ROOT,'packaging/agent-purge.iss')],{cwd:ROOT,encoding:'utf8'});
if (result.status!==0) throw new Error(`Inno 编译失败：${result.error?.message??result.stdout??result.stderr}`);
const out=join(DIST,`agent-purge-${version}-setup.exe`);
if (!existsSync(out)) throw new Error('编译器未生成预期安装器：'+out);
console.log(`安装器：${out} (${Math.round(statSync(out).size/1024)} KB；Node 20+ 瘦包)`);
