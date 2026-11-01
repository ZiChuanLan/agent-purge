#!/usr/bin/env node
// Same live RPC process, real generated extension, neutral markers and loopback provider.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnBin, resolveBin } from '../lib/spawn.mjs';
import { configure, isolatedEnv, put, runProcess, seed, cleanupRoots, trackRoot } from '../lib/capture.mjs';
import { inspectRequest, requestKind, startCaptureProvider } from './capture-provider.mjs';
const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..'),CLI=join(REPO,'bin/agent-purge.mjs');
export async function captureHot(h,out) {
 const bin=resolveBin(h);if(!bin)return {harness:h,status:'unavailable'};
 const root=trackRoot(mkdtempSync(join(tmpdir(),`ap-hot-${h}-`))),env=isolatedEnv(root),cwd=join(root,'work');mkdirSync(cwd);
 const p=await startCaptureProvider(join(out,h,'requests'));let child,waiter,buffer='',stdout='',stderr='',closed=false;
 const events=[],steps=[],a=`AP_HOT_A_${randomUUID()}`,b=`AP_HOT_B_${randomUUID()}`;
 const report={harness:h,at:new Date().toISOString(),isolation:root,scope:{kind:'isolated-session',profile:h==='dsh'?'sdk':null,currentSession:false},steps};
 const command=async args=>{const r=await runProcess(process.execPath,[CLI,...args],{env,cwd});if(r.code!==0)throw new Error(`CLI ${args.join(' ')}: ${r.stderr||r.stdout}`);return r;};
 function wait(predicate,action,timeout=35000){
  if(closed)return Promise.reject(new Error('RPC process exited: '+stderr.slice(-1200)));
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiter=null;reject(new Error('RPC event timeout: '+stderr.slice(-1200)));},timeout);
   waiter={predicate,resolve:v=>{clearTimeout(timer);waiter=null;resolve(v);},reject:e=>{clearTimeout(timer);waiter=null;reject(e);}};action();});
 }
 async function rpc(method,params){const id=randomUUID();return wait(e=>e.id===id,()=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'));}
 const sessionId=randomUUID();
 async function prompt(message){if(h==='dsh'){await rpc('session/prompt',{sessionId,contentBlocks:[{type:'text',text:message}]});return rpc('session/wait',{sessionId});}const id=randomUUID();return wait(e=>e.type==='agent_end',()=>child.stdin.write(JSON.stringify({id,type:'prompt',message})+'\n'));}
 try{
  const flags=configure(h,env,p.url,cwd);seed(env,h,'append',`Shared neutral fixture prefix. Marker ${a}.`);
  put(join(env.AGENT_PURGE_HOME,'personas','capture-b.md'),`Shared neutral fixture prefix. Marker ${b}.`);
  if(h==='dsh'){const init=await runProcess(bin,['--profile','sdk','--dump-config'],{env,cwd});if(init.code!==0)throw new Error(init.stderr);await command(['install',h]);}else await command(['slash',h]);
  const extension=join(env.PI_CODING_AGENT_DIR,'extensions','agent-purge.ts');
  child=spawnBin(bin,h==='dsh'?['--profile','sdk']:[...flags,'--no-extensions','--extension',extension,'--mode','rpc'],{env,cwd,stdio:['pipe','pipe','pipe']});report.pid=child.pid;
  child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-200000);buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let e;try{e=JSON.parse(line);}catch{continue;}events.push(e);if(e.error||(e.type==='response'&&e.success===false))waiter?.reject(new Error(typeof e.error==='string'?e.error:JSON.stringify(e.error||e)));else if(waiter?.predicate(e))waiter.resolve(e);}});
  child.stderr.on('data',c=>stderr=(stderr+c).slice(-100000));child.on('error',e=>waiter?.reject(e));child.on('close',()=>{closed=true;waiter?.reject(new Error('RPC process exited: '+stderr.slice(-1200)));});
  // Exercise manual-only extension enablement, then change global config through the actual CLI service.
  if(h==='dsh'){await rpc('initialize',{cwd,provider:'deepseek-official',model:'deepseek-flash'});report.sessionId=sessionId;}else{const id=randomUUID();await wait(e=>e.type==='response'&&e.id===id,()=>child.stdin.write(JSON.stringify({id,type:'prompt',message:'/purge on'})+'\n'));}
  for(const [label,args,marker] of [['A',null,a],['B',['use','capture-b'],b],['strict',['mode','strict'],b],['off',['pause'],null]]){
   if(args)await command(args);const start=p.captures.length;await prompt(`Reply CAPTURE_OK. Turn ${label}.`);
   const requests=p.captures.slice(start).filter(r=>requestKind(r.body)==='main').map(r=>{const {text: _text,...analysis}=inspectRequest(r.body,marker||a);return {id:r.id,...analysis,oldMarkerCount:inspectRequest(r.body,a).markerCount,newMarkerCount:inspectRequest(r.body,b).markerCount,userMessages:(r.body.messages??r.body.input??[]).filter(m=>m.role==='user').length};});
   const ok=requests.length>0&&requests.every(r=>label==='off'?r.oldMarkerCount===0&&r.newMarkerCount===0:r.markerCount===1&&(label==='A'?r.newMarkerCount===0:r.oldMarkerCount===0));
   steps.push({label,status:ok?'passed':'mismatch',pid:child.pid,requests});
  }
  report.status=steps.every(s=>s.status==='passed')?'passed':'mismatch';
 }catch(e){report.status='blocked';report.reason=e.message;}
 finally{
  if(child&&!closed){const done=new Promise(r=>child.once('close',r));if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});else child.kill('SIGKILL');await done;}
  put(join(out,h,'process.json'),{stdout,stderr,events});await p.close();
  report.finalState=JSON.parse(readFileSync(join(env.AGENT_PURGE_HOME,'state.json'),'utf8'));put(join(out,h,'report.json'),report);
 }
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const out=join(REPO,'out','capture-hot',new Date().toISOString().replace(/[:.]/g,'-'));
 try{
  for(const h of process.argv.slice(2).length?process.argv.slice(2):['pi','omp']){const report=await captureHot(h,out);console.log(h,report.status,report.reason||'',out);}
 }finally{cleanupRoots();}
}
