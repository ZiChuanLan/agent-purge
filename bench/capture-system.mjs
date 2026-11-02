#!/usr/bin/env node
// Real installed binaries → isolated HOME → loopback fixture; no model-identity self reports.
// 抓取主体在 lib/capture.mjs（`agent-purge verify` 复用同一份），这里只剩编排、热切与报告。
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataHome } from '../lib/home.mjs';
import { captureHarness, cleanupRoots, put } from '../lib/capture.mjs';
import { writeVerification } from './capture-report.mjs';
const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function main(){
 try{
 const argv=process.argv.slice(2),hot=argv.includes('--hot');
 const unknown=argv.filter(a=>a.startsWith('--')&&!['--hot','--no-publish','--keep-roots'].includes(a));if(unknown.length)throw new Error('Unknown capture flags: '+unknown.join(', '));
 const wanted=argv.filter(a=>!a.startsWith('--'));const hs=wanted.length?wanted:['pi','omp','codex','claude','codebuddy','grok','hermes','kilo','opencode','opencode2','dsh','zcode','antigravity'];
 const out=join(REPO,'out','capture',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(out,{recursive:true});
 const report={schema:1,at:new Date().toISOString(),kind:'loopback-real-binary',out,limitations:['No behavioral model quality claim','Provider request roles reported separately; no production credentials inherited','HTTP proxies are not an OS network sandbox'],harnesses:[]};
 for(const h of hs){
  let result;try{result=await captureHarness(h,out);}catch(e){result={harness:h,status:'error',reason:e.message};}
  if(hot&&['pi','omp','dsh','opencode','opencode2'].includes(h)&&result.status==='captured'){
   try{
    const runner=['opencode','opencode2'].includes(h)?(await import('./capture-server-hot.mjs')).captureServerHot:(await import('./capture-hot.mjs')).captureHot;
    const proof=await runner(h,join(out,'hot'));result.hotSwitch={status:proof.status,scope:proof.scope,reason:proof.reason,evidence:join(out,'hot',h,'report.json'),pid:proof.pid,sessionId:proof.sessionId,steps:proof.steps};
    console.log(`${h} same-session: ${proof.status}`);
   }catch(e){result.hotSwitch={status:'error',reason:e.message};}
  }
  report.harnesses.push(result);put(join(out,'report.json'),report);
 }
 put(join(out,'report.md'),'# Real harness request capture\n\n'+report.at+'\n\n| Harness | Version | Status | Modes |\n|---|---|---|---|\n'+report.harnesses.map(h=>`| ${h.harness} | ${(h.version||'').replace(/\s+/g,' ').slice(0,100)} | ${h.status} | ${(h.modes||[]).map(m=>m.mode+': '+m.status).join(', ')||h.reason} |`).join('\n')+'\n');
 if(!argv.includes('--no-publish'))writeVerification(join(dataHome(),'verification','latest.json'),report);
 console.log(out);
 if(report.harnesses.some(h=>['error','partial'].includes(h.status)||['error','mismatch','blocked'].includes(h.hotSwitch?.status)))process.exitCode=1;
 }finally{cleanupRoots();}
}
// Do not top-level-await main: hot runners import this module's shared fixture helpers.
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
