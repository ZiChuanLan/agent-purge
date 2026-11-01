#!/usr/bin/env node
// HTTP session API of a real resident server; configuration changes use the public CLI.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnBin, resolveBin } from '../lib/spawn.mjs';
import { configure, isolatedEnv, put, runProcess, seed, cleanupRoots, trackRoot } from '../lib/capture.mjs';
import { inspectRequest, requestKind, startCaptureProvider } from './capture-provider.mjs';
const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
export async function captureServerHot(h,out){
 const bin=resolveBin(h);if(!bin)return {harness:h,status:'unavailable',reason:'Executable not found'};
 const root=trackRoot(mkdtempSync(join(tmpdir(),`ap-server-hot-${h}-`))),env=isolatedEnv(root),cwd=join(root,'work');mkdirSync(cwd);
 const provider=await startCaptureProvider(join(out,h,'requests')),port=await freePort(),url=`http://127.0.0.1:${port}`;
 const v2=h==='opencode2';if(v2)env.OPENCODE_SERVER_PASSWORD=randomUUID();
 let child,closed=false,stdout='',stderr='';const report={harness:h,at:new Date().toISOString(),isolation:root,steps:[]};
 const a=`AP_HOT_A_${randomUUID()}`,b=`AP_HOT_B_${randomUUID()}`;
 const command=async args=>{const r=await runProcess(process.execPath,[join(REPO,'bin/agent-purge.mjs'),...args],{env,cwd});if(r.code!==0)throw new Error(r.stderr||r.stdout||r.error);};
 async function api(path,body){const r=await fetch(url+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(v2?{authorization:'Basic '+Buffer.from('opencode:'+env.OPENCODE_SERVER_PASSWORD).toString('base64')}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(35000)});const text=await r.text();if(!r.ok)throw new Error(`${path}: ${r.status} ${text.slice(0,1000)}`);if(r.status===204)return null;try{return JSON.parse(text);}catch{throw new Error(`${path}: response is not JSON (${text.slice(0,200)})`);}}
 try{
  configure(h,env,provider.url,cwd);seed(env,h,'append',`Shared neutral fixture prefix. Marker ${a}.`);put(join(env.AGENT_PURGE_HOME,'personas/capture-b.md'),`Shared neutral fixture prefix. Marker ${b}.`);
  await command(['install',h]);
  child=spawnBin(bin,['serve','--hostname','127.0.0.1','--port',String(port)],{env,cwd,stdio:['ignore','pipe','pipe']});report.pid=child.pid;
  child.stdout.on('data',c=>stdout=(stdout+c).slice(-100000));child.stderr.on('data',c=>stderr=(stderr+c).slice(-100000));child.on('close',()=>closed=true);child.on('error',e=>stderr+=e.message);
  const deadline=Date.now()+20000;let ready=false;
  while(Date.now()<deadline&&!closed){try{await api(v2?'/api/info':'/global/health');ready=true;break;}catch{}await new Promise(r=>setTimeout(r,200));}
  if(!ready)throw new Error('Server health endpoint unavailable: '+stderr.slice(-1800));
  const created=await api(v2?'/api/session':'/session',v2?{location:{directory:cwd},model:{providerID:'capture',id:'capture'}}:{});const session=v2?created.data:created;report.sessionId=session.id;if(!session.id)throw new Error('Session API did not return an id');
  for(const [label,args,marker] of [['A',null,a],['B',['use','capture-b'],b],['strict',['mode','strict'],b],['off',['pause'],null]]){
   if(args)await command(args);const start=provider.captures.length;
   const reply=v2?await api(`/api/session/${session.id}/prompt`,{text:`Reply CAPTURE_OK. Turn ${label}.`}):await api(`/session/${session.id}/message`,{model:{providerID:'capture',modelID:'capture'},parts:[{type:'text',text:`Reply CAPTURE_OK. Turn ${label}.`}]});
   if(v2)await api(`/api/experimental/session/${session.id}/wait`,{});
   if(reply?.info?.error)throw new Error(JSON.stringify(reply.info.error));
   const requests=provider.captures.slice(start).filter(r=>requestKind(r.body)==='main').map(r=>{const {text: _text,...analysis}=inspectRequest(r.body,marker||a);return {id:r.id,...analysis,oldMarkerCount:inspectRequest(r.body,a).markerCount,newMarkerCount:inspectRequest(r.body,b).markerCount,userMessages:(r.body.messages??r.body.input??[]).filter(m=>m.role==='user').length};});
   const ok=requests.length>0&&requests.every(r=>label==='off'?r.oldMarkerCount===0&&r.newMarkerCount===0:r.markerCount===1&&(label==='A'?r.newMarkerCount===0:r.oldMarkerCount===0));
   report.steps.push({label,status:ok?'passed':'mismatch',pid:child.pid,sessionId:session.id,requests});
  }
  report.status=report.steps.every(s=>s.status==='passed')?'passed':'mismatch';
 }catch(e){report.status='blocked';report.reason=e.message;}
 finally{
  if(child&&!closed){const done=new Promise(r=>child.once('close',r));if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});else child.kill('SIGKILL');await done;}
  await provider.close();put(join(out,h,'process.json'),{stdout,stderr});put(join(out,h,'report.json'),report);
 }
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const out=join(REPO,'out','capture-hot',new Date().toISOString().replace(/[:.]/g,'-'));
 try{
  for(const h of process.argv.slice(2).length?process.argv.slice(2):['opencode','opencode2']){const r=await captureServerHot(h,out);console.log(h,r.status,r.reason||'',out);}
 }finally{cleanupRoots();}
}
