#!/usr/bin/env node
// 只生成独立运行时产物；安装器始终由 build:setup 从经过核验的瘦包单独生成。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBin, spawnBin } from '../lib/spawn.mjs';
import { hashFile, listFiles, readJSON } from './build-common.mjs';
import { smoke } from './build-smoke.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), DIST = join(ROOT,'dist');
const ENTRY = join(ROOT,'.build-entry.mjs');
const EXE = join(DIST, process.platform === 'win32' ? 'agent-purge.exe' : 'agent-purge');
const version = readJSON(join(ROOT,'package.json')).version;
const targets = {win32:'windows',darwin:'darwin',linux:'linux'};
const target = `bun-${targets[process.platform]}-${process.arch}`;
const assets = ['matrix.json','package.json','lib/evidence.mjs','web/ui.html','web/app.js','web/model.mjs','web/styles.css',...listFiles(join(ROOT,'web/assets')).map(file=>`web/assets/${file}`),...listFiles(join(ROOT,'lib/templates/personas')).map(file=>`lib/templates/personas/${file}`)];
const duplicates = assets.map(file=>file.split('/').pop()).filter((file,index,all)=>all.indexOf(file)!==index);
if (duplicates.length) throw new Error('内嵌资源重名：'+duplicates.join(', '));
const bun = captureBin('bun',['--version']);
if (!bun) throw new Error('构建独立产物需要 Bun，请先安装 Bun');
console.log(`Bun ${bun.trim()} -> ${target}`);
mkdirSync(DIST,{recursive:true});
const buildTemp = mkdtempSync(join(tmpdir(),'ap-compile-'));
try {
  // This module is both executed by Node and served as browser source. Bun's
  // file loader must not replace the JS module's exports with an asset path.
  const browserEvidence = join(buildTemp, 'browser-evidence.txt');
  writeFileSync(browserEvidence, readFileSync(join(ROOT, 'lib/evidence.mjs')));
  writeFileSync(ENTRY,[...assets.map((file,index)=>`import a${index} from ${JSON.stringify(file === 'lib/evidence.mjs' ? browserEvidence.replaceAll('\\','/') : './'+file)} with { type: "file" };`),`globalThis.__AGENT_PURGE_FILES = {${assets.map((file,index)=>`${JSON.stringify(file)}:a${index}`).join(',')}};`,'import("./bin/agent-purge.mjs");'].join('\n'));
  const args=['build',ENTRY,'--compile',`--target=${target}`,`--outfile=${EXE}`,'--asset-naming=[name].[ext]'];
  if (process.platform==='win32') args.push('--windows-hide-console', `--windows-icon=${join(ROOT,'web/assets/agent-purge.ico')}`, '--windows-title=agent-purge', '--windows-publisher=agent-purge', '--windows-description=agent-purge', `--windows-version=${version.split(/[+-]/)[0]}.0`);
  const code = await new Promise((resolve,reject)=>{
    const child=spawnBin('bun',args,{cwd:ROOT,env:{...process.env,TEMP:buildTemp,TMP:buildTemp},stdio:'inherit'});
    child.once('error',reject);child.once('close',resolve);
  });
  if (code!==0 || !existsSync(EXE)) throw new Error('bun build --compile 失败');
  await smoke(EXE,[],{cwd:DIST,version,serve:!process.argv.includes('--no-serve-check')});
  writeFileSync(join(DIST,'standalone-manifest.json'),JSON.stringify({schema:1,flavor:'standalone',version,target,file:EXE.split(/[\\/]/).pop(),sha256:hashFile(EXE),assets:Object.fromEntries(assets.map(file=>[file,hashFile(join(ROOT,file))]))},null,2)+'\n');
  console.log(`独立产物：${EXE} (${(statSync(EXE).size/1048576).toFixed(1)} MB)`);
  console.log('未自动生成安装器；build:setup 会单独构建、核验并打包 Node 瘦包。');
} finally { rmSync(ENTRY,{force:true});rmSync(buildTemp,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
