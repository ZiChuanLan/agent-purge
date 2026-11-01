import "./isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLaunch, readLaunch, validLaunch, launchRuntime } from "../lib/launch.mjs";
import { loadState, patchState } from "../lib/state.mjs";
import { withControlLock } from "../lib/control.mjs";
import { isolatedEnv } from "../lib/environment.mjs";

test("launch validation matches generated runtime and rejects wrong identity, expiry and revoked epochs",async()=>{
 const generated=await import("data:text/javascript;base64,"+Buffer.from(launchRuntime+"\nexport {validLaunch};").toString("base64"));
 const record={version:1,harness:"pi",token:"fixture",hostPid:100,startedAt:1000,expiresAt:60000,epoch:"A",harnessEpoch:"B"},state={activationEpoch:"A",harnessEpochs:{pi:"B"}},identity={token:"fixture",pid:100,bornAt:1000,now:2000};
 for(const [r,s,i,want] of [[record,state,identity,true],[{...record,harness:"omp"},state,identity,false],[record,state,{...identity,pid:101},false],[record,state,{...identity,bornAt:20000},false],[record,state,{...identity,now:60001},false],[record,{...state,activationEpoch:"new"},identity,false],[record,{...state,harnessEpochs:{pi:"new"}},identity,false],[record,state,{...identity,token:"inherited-wrong"},false]]){
  assert.equal(validLaunch(r,s,"pi",i),want);assert.equal(generated.validLaunch(r,s,"pi",i),want);
 }
});
test("real child owns its lease; nested inherited token and off→resume never reactivate it",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ap-lease-")),env=isolatedEnv(root),data=env.AGENT_PURGE_HOME,file=join(root,"host.mjs");
 const launchURL=pathToFileURL(resolve("lib/launch.mjs")).href,stateURL=pathToFileURL(resolve("lib/state.mjs")).href;
 writeFileSync(file,`import {spawnSync} from "node:child_process";import {readLaunch} from ${JSON.stringify(launchURL)};import {loadState} from ${JSON.stringify(stateURL)};const check=()=>!!readLaunch(process.env.AGENT_PURGE_HOME,loadState(process.env.AGENT_PURGE_HOME).state,"pi");if(process.argv[2]==="nested"){console.log(JSON.stringify(check()));}else{process.on("message",()=>{const nested=spawnSync(process.execPath,[process.argv[1],"nested"],{env:process.env,encoding:"utf8"});process.send({own:check(),nested:JSON.parse(nested.stdout)});});}`);
 patchState(data,{persona:"a",default:{mode:"append"},armed:{}});const lease=createLaunch(data,"pi",{persona:"a",mode:"append"});let child;
 try{
  child=fork(file,[],{env:{...env,...lease.env},execArgv:[],stdio:["ignore","pipe","pipe","ipc"]});lease.publish(child.pid,Date.now());
  const check=async()=>{const response=once(child,"message");child.send({});return (await response)[0];};
  assert.deepEqual(await check(),{own:true,nested:false});
  patchState(data,{default:{mode:"off"}});assert.deepEqual(await check(),{own:false,nested:false});
  patchState(data,{default:{mode:"append"}});assert.deepEqual(await check(),{own:false,nested:false});
  lease.close();assert.equal(existsSync(lease.file),false);
 }finally{lease.close();if(child){const closed=once(child,"close");child.kill();await closed;}rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("harness off and dead-owner recovery preserve epoch revocation and lock ownership",()=>{
 const root=mkdtempSync(join(tmpdir(),"ap-lock-"));
 try{
  patchState(root,{default:{mode:"append"}});const lease=createLaunch(root,"pi");lease.publish(process.pid,Date.now()-process.uptime()*1000);assert.ok(readLaunch(root,loadState(root).state,"pi",lease.token));
  patchState(root,{overrides:{pi:{mode:"off"}}});const epoch=loadState(root).state.harnessEpochs.pi;assert.equal(typeof epoch,"string");
  patchState(root,{overrides:{}});assert.equal(loadState(root).state.harnessEpochs.pi,epoch);assert.equal(readLaunch(root,loadState(root).state,"pi",lease.token),null);lease.close();
  writeFileSync(join(root,".apply.lock"),JSON.stringify({pid:2147483647,token:"dead"}));
  withControlLock(root,()=>patchState(root,{testLock:true}));assert.equal(loadState(root).state.testLock,true);assert.equal(existsSync(join(root,".apply.lock")),false);
  writeFileSync(join(root,".apply.lock"),JSON.stringify({pid:process.pid,token:"live"}));assert.throws(()=>withControlLock(root,()=>{}),/另一个配置操作/);assert.equal(existsSync(join(root,".apply.lock")),true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
