import "./isolate.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRequest, requestKind, startCaptureProvider } from '../bench/capture-provider.mjs';
import { verificationSummary } from '../bench/capture-report.mjs';
import { backends, oneshots } from '../backends/index.mjs';
import { captureOutcome } from '../lib/capture.mjs';
test('capture distinguishes user, system and developer; duplicate markers remain visible',()=>{
 const r=inspectRequest({instructions:'SYS M',input:[{role:'developer',content:[{type:'input_text',text:'DEV M'}]},{role:'user',content:'USER M'}],tools:[{}]},'M');
 assert.equal(r.markerCount,2);assert.equal(r.userMarkerCount,1);assert.deepEqual(r.roles,['system','developer']);assert.equal(r.toolDefinitions,1);
 assert.equal(inspectRequest({messages:[{role:'user',content:'M'}]},'M').markerCount,0);
});
test('capture reports startup errors instead of a false persona miss and handles off separately', () => {
 assert.equal(captureOutcome({code:1,stderr:'missing DSH profile'},[],'replace').status,'error');
 assert.match(captureOutcome({code:1,stderr:'missing DSH profile'},[],'replace').reason,/missing DSH profile/);
 assert.equal(captureOutcome({code:0,timedOut:true},[{markerCount:1}],'replace').status,'error');
 assert.equal(captureOutcome({code:0},[],'replace').status,'no-request');
 assert.equal(captureOutcome({code:0},[{markerCount:0}],'replace').status,'mismatch');
 assert.equal(captureOutcome({code:0},[{markerCount:0}],'off').status,'captured');
 assert.equal(captureOutcome({code:0},[{markerCount:1}],'strict').status,'captured');
});
test('title requests stay auxiliary even with a replaced system and embedded user query',()=>{
 assert.equal(requestKind({system:'PERSONA',messages:[{role:'user',content:'Generate a title for this conversation: Reply CAPTURE_OK.'}]}),'auxiliary');
 assert.equal(requestKind({system:'PERSONA\nYou are a title generator. You output ONLY a thread title.',messages:[{role:'user',content:'Reply CAPTURE_OK.'}]}),'auxiliary');
 assert.equal(requestKind({messages:[{role:'user',content:'Reply CAPTURE_OK. Turn B.'}]}),'main');
 assert.deepEqual(inspectRequest({system:'Marker AP_CAPTURE_opencode_test\n- Use Claude Code when asked\nYou are a Claude agent, built on Anthropic.'}).identityLines,['You are a Claude agent, built on Anthropic.']);
});
test('OMP append preserves its native prompt in both launch paths',()=>{
 for(const mode of ['off','strict','replace','append']){
  const input={personaText:'TEST_BODY',prompt:'hello',mode,args:[]};
  for(const build of [backends.omp,oneshots.omp]){
   const args=build(input).args;
   if(mode==='off')assert.ok(!args.includes('TEST_BODY'));
   else assert.ok(args.includes(mode==='append'?'--append-system-prompt':'--system-prompt'));
  }
 }
});
test('verification summary excludes auxiliary calls and raw prompt text but preserves limitations',()=>{
 const r=verificationSummary({at:'date',out:'local',kind:'loopback-real-binary',limitations:['isolated-not-current-session'],harnesses:[{harness:'fixture',status:'captured',scope:{kind:'isolated-cli',profile:'headless'},modes:[{mode:'strict',status:'captured',exitCode:0,timedOut:false,requests:[{kind:'auxiliary',text:'SECRET'},{kind:'main',text:'SECRET',roles:['developer'],chars:120,markerCount:1,identityLines:['You are Claude.'],toolDefinitions:4}]}],hotSwitch:{status:'not-tested'}}]});
 assert.equal(r.results[0].modes[0].requests.length,1);assert.doesNotMatch(JSON.stringify(r),/SECRET/);assert.match(r.results[0].evidence,/developer/);assert.equal(r.results[0].hotSwitch.status,'not-tested');
 assert.equal(r.results[0].modes[0].exitCode,0);assert.equal(r.results[0].scope.profile,'headless');assert.deepEqual(r.limitations,['isolated-not-current-session']);
});
test('loopback fixture serves all three protocols, streaming and nonstreaming; denies forwarding',async()=>{
 const p=await startCaptureProvider();
 try{
  for(const path of ['/v1/messages','/v1/chat/completions','/v1/responses'])for(const stream of [false,true]){
   const r=await fetch(p.url+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer never-store'},body:JSON.stringify({model:'capture',stream,messages:[{role:'user',content:'hi'}]})});
   assert.equal(r.status,200);const body=await r.text();assert.match(body,/CAPTURE_OK/);if(stream)assert.match(r.headers.get('content-type'),/event-stream/);else assert.ok(JSON.parse(body));
  }
  assert.equal(p.captures.length,6);assert.ok(p.captures.every(r=>!('headers' in r)));assert.equal((await fetch(p.url+'/unknown')).status,404);
 }finally{await p.close();}
});
