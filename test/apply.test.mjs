import { isolate } from "./isolate.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'ap-apply-')),root=join(dir,'data'),saved={...process.env};
isolate(dir);
for(const key of ['HOME','USERPROFILE','AGENT_PURGE_HOME','XDG_CONFIG_HOME','DSH_HOME','CODEX_HOME','OMP_HOME','HERMES_HOME','PI_CODING_AGENT_DIR','CLAUDE_CONFIG_DIR']) process.env[key]=key==='AGENT_PURGE_HOME'?root:join(dir,key);
for(const key of ['AGENT_PURGE_FORCE','AGENT_PURGE_MODE','AGENT_PURGE_PERSONA']) delete process.env[key];
mkdirSync(root,{recursive:true});
const {createStore}=await import('../lib/personas.mjs');const {loadState,patchState}=await import('../lib/state.mjs');
const {applyConfiguration,changeChannel,disableHarness}=await import('../lib/apply.mjs');const {targets}=await import('../lib/persist.mjs');
const {reconcileArmed}=await import('../lib/armed.mjs');const store=createStore(root);
store.save('a',{body:'PERSONA A'});store.save('b',{body:'PERSONA B'});store.setActive('a');
const text=file=>readFileSync(file,'utf8');
test.after(()=>{process.env=saved;rmSync(dir,{recursive:true,force:true});});
test('shared apply: static sync, pause remembers scope, reconcile respects pause, resume uses new persona',async()=>{
 patchState(root,{default:{harness:'pi',mode:'replace'},armed:{}});
 const file=targets.pi.file();mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,'USER RULES\r\n');
 assert.equal(changeChannel(root,{harness:'pi',channel:'install',enabled:true}).ok,true);assert.match(text(file),/PERSONA A/);
 let r=applyConfiguration(root,{persona:'b',mode:'append'});assert.equal(r.ok,true);assert.equal(r.runtimeConfirmed,false);assert.equal(r.results[0].when,'next-session');assert.match(text(file),/PERSONA B/);assert.doesNotMatch(text(file),/PERSONA A/);
 r=applyConfiguration(root,{enabled:false});assert.equal(text(file),'USER RULES\r\n');assert.deepEqual(loadState(root).state.armed.pi,['install']);await reconcileArmed(root);assert.deepEqual(loadState(root).state.armed.pi,['install']);
 r=applyConfiguration(root,{persona:'a'});assert.equal(r.mode,'off');assert.equal(text(file),'USER RULES\r\n');
 r=applyConfiguration(root,{enabled:true});assert.equal(r.mode,'append');assert.match(text(file),/PERSONA A/);
});
test('partial failures preserved and retried without falsely marking runtime confirmed',()=>{
 const blocked=targets.grok.file();mkdirSync(blocked,{recursive:true});patchState(root,{armed:{pi:['install'],grok:['install']}});
 const first=applyConfiguration(root,{persona:'b'});assert.equal(first.ok,false);assert.equal(first.partial,true);assert.equal(first.results.find(r=>r.harness==='grok').status,'failed');
 rmSync(blocked,{recursive:true});const second=applyConfiguration(root,{onlyFailed:true});assert.equal(second.ok,true);assert.equal(second.results.length,1);assert.equal(second.results[0].harness,'grok');assert.equal(second.runtimeConfirmed,false);
});
test('pause has no valid default/persona precondition; selected static channel stays unwritten while paused',()=>{
 patchState(root,{default:null,armed:{}});let r=applyConfiguration(root,{enabled:false});assert.equal(r.mode,'off');
 r=changeChannel(root,{harness:'omp',channel:'install',enabled:true});assert.equal(r.ok,true);assert.equal(r.action,'selected-while-paused');assert.equal(existsSync(targets.omp.file()),false);
 for(const p of store.list()) store.remove(p.id);
 r=applyConfiguration(root,{enabled:false});assert.equal(r.ok,true);
 assert.equal(changeChannel(root,{harness:'omp',channel:'install',enabled:false}).ok,true);
});
test('CLI use shares application path and rewrites installed static body',()=>{
 store.save('a',{body:'PERSONA A'});store.save('b',{body:'PERSONA B'});store.setActive('a');patchState(root,{default:{harness:'pi',mode:'replace'},armed:{pi:['install']}});
 const cli=spawnSync(process.execPath,[join(process.cwd(),'bin','agent-purge.mjs'),'use','b'],{env:process.env,encoding:'utf8'});
 assert.equal(cli.status,0,cli.stderr);assert.match(text(targets.pi.file()),/PERSONA B/);assert.equal(loadState(root).state.lastApply.persona,'b');
});
test('exclusive apply lock rejects overlapping writer without altering state',()=>{
 const previous=text(join(root,'state.json'));writeFileSync(join(root,'.apply.lock'),JSON.stringify({pid:process.pid}));
 try{assert.throws(()=>applyConfiguration(root,{persona:'a'}),/另一个配置操作/);assert.equal(text(join(root,'state.json')),previous);}finally{rmSync(join(root,'.apply.lock'));}
});
test('disableHarness cleans an installed block even when armed state was lost', () => {
 const file=targets.pi.file(); mkdirSync(join(file,'..'),{recursive:true}); writeFileSync(file,'USER RULES\n');
 assert.equal(changeChannel(root,{harness:'pi',channel:'install',enabled:true}).ok,true);
 assert.match(text(file),/PERSONA B/);
 patchState(root,{armed:{}});
 const r=disableHarness(root,'pi');
 assert.equal(r.ok,true);
 assert.doesNotMatch(text(file),/PERSONA B/);
 assert.match(text(file),/USER RULES/);
 assert.ok(loadState(root).state.disabledHarnesses.includes('pi'));
});
test('历史能力证据不确认本次应用',()=>{
 store.save('a',{body:'PERSONA A'});store.setActive('a');patchState(root,{default:{harness:'pi',mode:'replace'},armed:{pi:['install']}});
 const verification=join(root,'verification'),report=modes=>JSON.stringify({schema:1,results:[{harness:'pi',status:'captured',modes}]});
 const req=roles=>({roles,chars:100,markerCount:1,identityLines:[],toolDefinitions:3});
 mkdirSync(verification,{recursive:true});
 writeFileSync(join(verification,'latest.json'),report([{mode:'replace',status:'captured',exitCode:0,requests:[req(['system'])]}]));
 let r=applyConfiguration(root,{persona:'a'});assert.equal(r.ok,true);assert.equal(r.results[0].historicalCapabilityVerified,true);assert.equal(r.results[0].runtimeConfirmed,false);assert.equal(r.runtimeConfirmed,false);
 writeFileSync(join(verification,'latest.json'),report([{mode:'replace',status:'captured',exitCode:0,requests:[req(['user'])]}]));
 r=applyConfiguration(root,{persona:'a'});assert.equal(r.results[0].runtimeConfirmed,false);assert.equal(r.runtimeConfirmed,false);
 rmSync(verification,{recursive:true,force:true});
 assert.equal(applyConfiguration(root,{persona:'a'}).runtimeConfirmed,false);
});
test('dsh: enabling slash cascades to install and initializes purge off; removing install cascades slash off', () => {
 const dshHome = process.env.DSH_HOME;
 const headless = join(dshHome, 'profiles', 'headless');
 mkdirSync(headless, { recursive: true });
 writeFileSync(join(headless, 'package.json'), '{}');
 patchState(root, { default: { harness: 'dsh', mode: 'replace' }, armed: {} });
 // 单独开启 slash 通道
 const r = changeChannel(root, { harness: 'dsh', channel: 'slash', enabled: true });
 assert.equal(r.ok, true);
 const armed = loadState(root).state.armed?.dsh ?? [];
 assert.ok(armed.includes('install'), 'slash 必须级联安装 install 常驻插件');
 assert.ok(armed.includes('slash'), 'slash 必须被武装');
 const runtime = loadState(root).state.dshRuntime ?? {};
 assert.equal(runtime.headless?.enabled, false, '开启热切时默认必须处于 purge off 状态');
 // 卸载 install 时，slash 必须一并级联卸载
 const un = changeChannel(root, { harness: 'dsh', channel: 'install', enabled: false });
 assert.equal(un.ok, true);
 const armedAfter = loadState(root).state.armed?.dsh ?? [];
 assert.equal(armedAfter.includes('install'), false);
 assert.equal(armedAfter.includes('slash'), false);
});
