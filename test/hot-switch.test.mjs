import { isolate } from "./isolate.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { extensionSource } from '../lib/extension.mjs';
import { createTextRewriter, createSectionRewriter, createContentRewriter, rewriteSections, stripIdentity } from '../lib/rewrite.mjs';
const root=mkdtempSync(join(tmpdir(),'ap-hot-')); const saved={...process.env};
isolate(root);
for(const key of ['HOME','USERPROFILE','AGENT_PURGE_HOME','XDG_CONFIG_HOME','DSH_HOME']) process.env[key]=root;
delete process.env.AGENT_PURGE_MODE; delete process.env.AGENT_PURGE_PERSONA; delete process.env.AGENT_PURGE_FORCE;
mkdirSync(join(root,'personas')); mkdirSync(join(root,'profiles','headless'),{recursive:true});
writeFileSync(join(root,'profiles','headless','package.json'),'{}');
const prefix='这是一段前四十个字符完全相同的人设正文。'.repeat(4);
const A=prefix+'\nVERSION A'; const B=prefix+'\nVERSION B';
for(const [id,body] of [['a',A],['b',B]]) writeFileSync(join(root,'personas',id+'.md'),'---\r\nname: '+id+'\r\n---\r\n'+body);
const state=(mode='replace',persona='a',extra={})=>{writeFileSync(join(root,'state.json'),JSON.stringify({persona,default:{mode},armed:{pi:['slash'],omp:['slash'],dsh:['install'],opencode:['install'],opencode2:['install']},piAuto:true,ompAuto:true,...extra}));writeFileSync(join(root,'personas','active.md'),persona==='b'?B:A);};
const fromSource=async s=>import('data:text/javascript;base64,'+Buffer.from(s).toString('base64'));
test('DSH replace removes templated model identity before host interpolation; persona stays literal', () => {
 const host=[{name:'deployment:persona-prefix',text:'You are a coding agent powered by the {{model}} model.\nKeep project notes.'}];
 const persona='My literal example uses {{not_a_host_variable}}.';
 const output=rewriteSections(host,persona,'replace');
 assert.equal(output[0].text,persona);
 assert.equal(output[0].interpolate,false);
 assert.equal(output[1].text,'Keep project notes.');
 assert.equal(stripIdentity('You are a coding agent powered by the {{model}} model.'),'');
 for(const mode of ['strict','append']) assert.equal(rewriteSections(host,persona,mode).find(s=>s.name==='agent-purge').interpolate,false);
 assert.equal(rewriteSections(host,persona,'off'),host);
});
test.after(()=>{process.env=saved;rmSync(root,{recursive:true,force:true});});
test('rewriters: full body dedup, same-prefix user text retained, strict→off restores host',()=>{
 const text=createTextRewriter();const host=['You are an AI assistant.\nTOOLS',prefix+'\nUSER RULE'];
 let out=text(host,A,'append');assert.deepEqual(out,[...host,A]);
 out=text(out,B,'append');assert.deepEqual(out,[...host,B]);
 out=text(out,B,'strict');assert.deepEqual(out,[B]);assert.deepEqual(text(out,'','off'),host);
 const sections=createSectionRewriter();const original=[{name:'host',text:'TOOLS',cache_control:{type:'ephemeral'}}];
 let s=sections(original,A,'strict');s=sections(s,B,'append');assert.deepEqual(s,[...original,{name:'agent-purge',text:B,interpolate:false}]);assert.deepEqual(sections(s,'','off'),original);
 const content=createContentRewriter();const blocks=[{type:'text',text:'TOOLS',cache_control:{type:'ephemeral'}},{type:'image',source:{data:'X'}}];
 let c=content(blocks,A,'append');c=content(c,B,'replace');assert.deepEqual(c,[{type:'text',text:B},...blocks]);assert.deepEqual(content(c,'','off'),blocks);
});
for(const harness of ['pi','omp']) test(`${harness}: generated extension same instance A→B→strict→off and command toggles`,async()=>{
 state('append');const hooks={},commands={};const ext=(await fromSource(extensionSource(root,harness))).default;
 ext({on:(k,v)=>hooks[k]=v,registerCommand:(k,v)=>commands[k]=v});
 const host=harness==='pi'?'You are an AI assistant.\nTOOLS':['You are an AI assistant.\nTOOLS'];
 let out=(await hooks.before_agent_start({systemPrompt:host})).systemPrompt;
 assert.match(JSON.stringify(out),/VERSION A/);state('append','b');out=(await hooks.before_agent_start({systemPrompt:out})).systemPrompt;
 assert.match(JSON.stringify(out),/VERSION B/);assert.doesNotMatch(JSON.stringify(out),/VERSION A/);
 state('strict','b');out=(await hooks.before_agent_start({systemPrompt:out})).systemPrompt;assert.doesNotMatch(JSON.stringify(out),/TOOLS/);
 state('off','b');out=(await hooks.before_agent_start({systemPrompt:out})).systemPrompt;assert.deepEqual(out,host);
 state('replace','b');const ctx={ui:{notify(){}}};await commands.purge.handler('off',ctx);
 assert.deepEqual((await hooks.before_agent_start({systemPrompt:host})).systemPrompt,host);
 await commands.purge.handler('on',ctx);assert.match(JSON.stringify((await hooks.before_agent_start({systemPrompt:host})).systemPrompt),/VERSION B/);
 state('replace','b',{armed:{}});assert.deepEqual((await hooks.before_agent_start({systemPrompt:host})).systemPrompt,host);
});
test('pi 1.5.x replace strips identity & <docs> while preserving custom <docs>, supports {{cwd}} & no-op off skip', async () => {
 const pi152 = [
  'You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.',
  '<tools>\n- read: Read file\n</tools>',
  '<rules>\n- Be concise in your responses\n</rules>',
  '<docs>\nPi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: C:/pi/README.md\n- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.\n</docs>',
  '<project_context>\n<docs>USER CUSTOM DOCS</docs>\n</project_context>',
  '<cwd>\nH:/WorkSpace\n</cwd>',
 ].join('\n\n');
 writeFileSync(join(root, 'personas', 'cwdp.md'), 'PERSONA IN {{cwd}}');
 state('replace', 'cwdp');
 const hooks = {}, commands = {}, notes = [];
 (await fromSource(extensionSource(root, 'pi') + '\n// pi152')).default({
  on: (k, v) => hooks[k] = v,
  registerCommand: (k, v) => commands[k] = v,
 });
 const replaced = (await hooks.before_agent_start({ systemPrompt: pi152, systemPromptOptions: { cwd: 'H:\\WorkSpace\\proj' } })).systemPrompt;
 assert.ok(replaced.startsWith('PERSONA IN H:/WorkSpace/proj'), replaced);
 assert.doesNotMatch(replaced, /coding assistant running inside pi/);
 assert.doesNotMatch(replaced, /Pi documentation \(read only/);
 assert.match(replaced, /<tools>/);
 assert.match(replaced, /<rules>/);
 assert.match(replaced, /<docs>USER CUSTOM DOCS<\/docs>/);
 assert.match(replaced, /<cwd>/);
 assert.doesNotMatch(replaced, /<\/rules>\n\n\n+<project_context>/);

 // 旧版无 <docs> 标签的裸文本同样切除
 const barePi = 'You are an expert coding assistant operating inside pi, a coding agent harness.\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)\n\nProject-specific instructions:';
 const bareOut = (await hooks.before_agent_start({ systemPrompt: barePi })).systemPrompt;
 assert.doesNotMatch(bareOut, /Pi documentation \(read only/);
 assert.match(bareOut, /Project-specific instructions:/);

 // 切回 off：带 systemPromptOptions 且未改动宿主时不返回 systemPrompt（避免触发 forceSystemPrompt）
 state('off', 'cwdp');
 const restored = (await hooks.before_agent_start({ systemPrompt: replaced, systemPromptOptions: { cwd: 'H:/WorkSpace/proj' } })).systemPrompt;
 assert.equal(restored, pi152);
 const noop = await hooks.before_agent_start({ systemPrompt: pi152, systemPromptOptions: { cwd: 'H:/WorkSpace/proj' } });
 assert.equal(noop, undefined);

 // /purge reload 给明确回显
 await commands.purge.handler('reload', { ui: { notify: (msg) => notes.push(msg) } });
 assert.match(notes.at(-1), /已重读/);
});
test('pi/omp off cleans residual resident agent-purge block from host system prompt', async () => {
 state('replace', 'b'); const hooks = {}, commands = {};
 const ext = (await fromSource(extensionSource(root, 'pi'))).default;
 ext({ on: (k, v) => hooks[k] = v, registerCommand: (k, v) => commands[k] = v });
 const resident = '# >>> agent-purge\nRESIDENT XIAOMAJIANG\n# <<< agent-purge\n\nYou are an AI assistant.\nTOOLS';
 const ctx = { ui: { notify() {} } };
 await commands.purge.handler('off', ctx);
 const out = (await hooks.before_agent_start({ systemPrompt: resident })).systemPrompt;
 assert.equal(out, 'You are an AI assistant.\nTOOLS');
 assert.doesNotMatch(out, /RESIDENT XIAOMAJIANG/);
});
test('pi context: preserves content metadata and user attachments; off removes only own user prefix',async()=>{
 state('append','a',{piUserLayer:true});const hooks={};(await fromSource(extensionSource(root,'pi')+'\n// context')).default({on:(k,v)=>hooks[k]=v,registerCommand(){}});
 const original=[{role:'system',content:[{type:'text',text:'TOOLS',cache_control:{type:'ephemeral'}}]},{role:'user',content:[{type:'text',text:'QUESTION'},{type:'image',source:{data:'Y'}}]}];
 const event={messages:structuredClone(original)};await hooks.context_with_system(event);assert.deepEqual(event.messages[0].content[0],original[0].content[0]);
 assert.deepEqual(event.messages[1].content.slice(1),original[1].content);state('append','b',{piUserLayer:true});await hooks.context_with_system(event);
 assert.doesNotMatch(JSON.stringify(event),/VERSION A/);state('off','b');await hooks.context_with_system(event);assert.deepEqual(event.messages,original);
});
test('resident opencode v1/v2: actual generated callbacks follow active file, disarm restores host',async()=>{
 const {install,targets}=await import('../lib/persist.mjs');
 for(const id of ['opencode','opencode2']){
  state('append');const r=install(id,{root,active:join(root,'personas','active.md')});assert.ok(!r.error,r.error);
  const plugin=await fromSource(readFileSync(targets[id].file(),'utf8'));let hook;
  if(id==='opencode') hook=(await plugin.AgentPurge())['experimental.chat.system.transform'];
  else await plugin.default.setup({session:{hook:async(_name,fn)=>hook=fn}});
  const original=id==='opencode'?['HOST']:[{type:'text',text:'HOST',cache_control:{type:'ephemeral'}}];const event={system:structuredClone(original)};
  const call=()=>id==='opencode'?hook({},event):hook(event);
  await call();state('append','b');await call();assert.doesNotMatch(JSON.stringify(event),/VERSION A/);assert.match(JSON.stringify(event),/VERSION B/);
  state('strict','b');await call();state('off','b');await call();assert.deepEqual(event.system,original);
  state('append','a');await call();state('replace','b',{armed:{}});await call();assert.deepEqual(event.system,original);
 }
});
test('dsh same callback: A→B→off, sync result preserved; slash mode scoped to profile',async()=>{
 const {install}=await import('../lib/persist.mjs');state('append');install('dsh',{root,active:join(root,'personas','active.md')});
 const file=join(root,'dsh','agent-purge','index.js');const plugin=(await import(pathToFileURL(file))).default;
 let asm={sections:[{name:'host',text:'HOST',cache_control:{type:'ephemeral'}}]};const original=structuredClone(asm);const ctx={systemPrompt:{assemble:()=>asm}};plugin.apply(ctx);
 asm=ctx.systemPrompt.assemble();state('append','b');asm=ctx.systemPrompt.assemble();assert.doesNotMatch(JSON.stringify(asm),/VERSION A/);
 state('strict','b');asm=ctx.systemPrompt.assemble();state('off','b');asm=ctx.systemPrompt.assemble();assert.deepEqual(asm,original);
});
test('dsh slash mode: defaults to purge off until explicitly turned on via /purge on',async()=>{
 const {install}=await import('../lib/persist.mjs');
 // 同时武装 install 和 slash，未执行 /purge on（dshRuntime 为空或 enabled 为 false）
 state('append','a',{armed:{dsh:['install','slash']},dshRuntime:{headless:{enabled:false}}});
 install('dsh',{root,active:join(root,'personas','active.md')});
 const file=join(root,'dsh','agent-purge','index.js');
 const plugin=(await import(pathToFileURL(file).href+'?slash-default-off')).default;
 const original={sections:[{name:'host',text:'HOST'}]};
 const ctx={get:(k)=>k==='profileContext'?{name:'headless'}:undefined,systemPrompt:{assemble:()=>structuredClone(original)}};
 plugin.apply(ctx);
 // 默认处于 purge off 状态：不修改系统提示词
 let asm=ctx.systemPrompt.assemble();
 assert.deepEqual(asm,original);
 // 模拟用户在会话内执行 /purge on
 state('append','a',{armed:{dsh:['install','slash']},dshRuntime:{headless:{enabled:true}}});
 asm=ctx.systemPrompt.assemble();
 assert.match(JSON.stringify(asm),/VERSION A/);
 // 模拟用户执行 /purge off
 state('append','a',{armed:{dsh:['install','slash']},dshRuntime:{headless:{enabled:false}}});
 asm=ctx.systemPrompt.assemble();
 assert.deepEqual(asm,original);
});
test('overrides: runtime reads the per-harness persona/mode, global stays as fallback',async()=>{
 // pi / omp：全局 append + a，pi 单独指向 b → 注入的是 b；显式 FORCE 不需要，slash 已武装
 state('append','a',{overrides:{pi:{persona:'b'}}});
 const hooks={};(await fromSource(extensionSource(root,'pi'))).default({on:(k,v)=>hooks[k]=v,registerCommand(){}});
 const host='You are an AI assistant.\nTOOLS';
 let out=(await hooks.before_agent_start({systemPrompt:host})).systemPrompt;
 assert.match(out,/VERSION B/);assert.doesNotMatch(out,/VERSION A/);
 // 模式也跟着覆盖：strict 只剩人设（宿主被整只换掉）
 state('append','a',{overrides:{pi:{persona:'b',mode:'strict'}}});
 out=(await hooks.before_agent_start({systemPrompt:host})).systemPrompt;assert.equal(out,B);
 // 覆盖模式 off：这一家放过宿主，全局仍是 append
 state('append','a',{overrides:{pi:{mode:'off'}}});
 out=(await hooks.before_agent_start({systemPrompt:host})).systemPrompt;assert.equal(out,host);

 // opencode v1 / v2：同一份 state，两家身份各认各的
 const {install,targets}=await import('../lib/persist.mjs');
 for(const id of ['opencode','opencode2']){
  state('append','a',{overrides:{[id]:{persona:'b'}}});
  const r=install(id,{root,active:join(root,'personas','active.md')});assert.ok(!r.error,r.error);
  const plugin=await fromSource(readFileSync(targets[id].file(),'utf8'));let hook;
  if(id==='opencode') hook=(await plugin.AgentPurge())['experimental.chat.system.transform'];
  else await plugin.default.setup({session:{hook:async(_name,fn)=>hook=fn}});
  const event={system:id==='opencode'?['HOST']:[{type:'text',text:'HOST'}]};
  const call=()=>id==='opencode'?hook({},event):hook(event);
  await call();assert.match(JSON.stringify(event),/VERSION B/);assert.doesNotMatch(JSON.stringify(event),/VERSION A/);
  state('append','a',{overrides:{[id]:{mode:'strict'}}});await call();
  assert.equal(event.system.length,1);assert.match(JSON.stringify(event.system),/VERSION A/);
 }

 // dsh：三个 profile 共用一份插件，统一按 "dsh" 查例外
 state('append','a',{overrides:{dsh:{persona:'b'}}});
 install('dsh',{root,active:join(root,'personas','active.md')});
 const dshPlugin=(await import(pathToFileURL(join(root,'dsh','agent-purge','index.js')).href+'?overrides')).default;
 const ctx2={systemPrompt:{assemble:()=>({sections:[{name:'host',text:'HOST'}]})}};dshPlugin.apply(ctx2);
 const asm=ctx2.systemPrompt.assemble();
 assert.match(JSON.stringify(asm),/VERSION B/);assert.doesNotMatch(JSON.stringify(asm),/VERSION A/);
});
test('launchConfig: explicit > override > global, inherited env is not permission',async()=>{
 const {launchConfig}=await import('../lib/spawn.mjs');
 const st={v:1,persona:'a',default:{harness:'codex',mode:'append'},armed:{},overrides:{codex:{persona:'b',mode:'strict'},pi:{mode:'off'}}};
 assert.deepEqual(launchConfig(st,'codex',{env:{}}),{persona:'b',mode:'strict'});
 assert.deepEqual(launchConfig(st,'pi',{env:{}}),{persona:'a',mode:'off'});
 assert.deepEqual(launchConfig(st,'opencode',{env:{}}),{persona:'a',mode:'append'});
 assert.deepEqual(launchConfig({v:1},'pi',{env:{}}),{persona:null,mode:'replace'});
 // 继承环境变量不再压过显式/分家/全局配置
 assert.deepEqual(launchConfig(st,'codex',{env:{AGENT_PURGE_PERSONA:'a',AGENT_PURGE_MODE:'append'}}),{persona:'b',mode:'strict'});
 assert.deepEqual(launchConfig(st,'codex',{env:{AGENT_PURGE_PERSONA:'',AGENT_PURGE_MODE:''}}),{persona:'b',mode:'strict'});
 assert.deepEqual(launchConfig(st,'codex',{persona:'a',mode:'off',env:{AGENT_PURGE_MODE:'append'}}),{persona:'a',mode:'off'});
});
test('dsh deep purge: auto approval, noise stripping, strict complete and contexts reset', async () => {
 const { install } = await import('../lib/persist.mjs');
 state('strict', 'b');
 install('dsh', { root, active: join(root, 'personas', 'active.md') });
 const file = join(root, 'dsh', 'agent-purge', 'index.js');
 const plugin = (await import(pathToFileURL(file).href + '?deep-purge-test')).default;
 const hooks = {};
 let asm = {
  sections: [
   { name: 'host', text: 'HOST' },
   { name: 'dsh-experimental-session-mnemon', text: '11.4KB MEMORY NOISE' },
   { name: 'dsh-repeat-tool-reminder', text: 'REMINDER' }
  ],
  contexts: [
   { name: 'working_directory', text: 'H:/WorkSpace' },
   { name: 'approval:policy', text: 'NEVER' },
   { name: 'sandbox:policy', text: 'STRICT' }
  ]
 };
 const ctx = {
  systemPrompt: { assemble: () => asm },
  on: (evt, handler) => { hooks[evt] = handler; }
 };
 plugin.apply(ctx);
 assert.ok(typeof hooks['approval/request'] === 'function');
 const approvalResult = hooks['approval/request']({ toolName: 'bash' }, () => 'unavailable');
 assert.equal(approvalResult, 'allowed-once');

 const runAssemble = async () => hooks['system-prompt/assemble'](asm, {}, async () => asm);

 const outStrict = await runAssemble();
 assert.equal(outStrict.sections.some(s => s.name.includes('mnemon')), false);
 assert.equal(outStrict.sections.some(s => s.name.includes('repeat-tool-reminder')), false);
 const selfSection = outStrict.sections.find(s => s.name === 'agent-purge');
 assert.ok(selfSection);
 assert.equal(selfSection.order, -100000);
 assert.equal(selfSection.interpolate, false);
 assert.equal(selfSection.complete, true);
 assert.deepEqual(outStrict.contexts, []);

 state('replace', 'b');
 const outReplace = await runAssemble();
 assert.equal(outReplace.sections.find(s => s.name === 'agent-purge').order, -100000);
 assert.equal(outReplace.sections.some(s => s.name === 'host'), true);
 assert.equal(outReplace.sections.some(s => s.name.includes('mnemon')), false);
 assert.equal(outReplace.contexts.some(c => c.name === 'working_directory'), true);
 assert.equal(outReplace.contexts.some(c => c.name === 'approval:policy'), false);
 assert.equal(outReplace.contexts.some(c => c.name === 'sandbox:policy'), false);

 state('off', 'b');
 const approvalOff = hooks['approval/request']({ toolName: 'bash' }, () => 'delegated');
 assert.equal(approvalOff, 'delegated');
});

test('dsh slash command plugin: applies without ReferenceError, registers /purge & /ap, updates per-profile state (issue #12)', async () => {
 const { slashSource } = await import('../lib/dsh.mjs');
 state('append', 'a', { armed: { dsh: ['install', 'slash'] }, dshRuntime: {} });
 const plugin = (await fromSource(slashSource(root))).default;
 assert.equal(plugin.name, 'agent-purge-slash');

 const registered = {};
 const mockCtx = {
  get: (k) => k === 'profileContext' ? { name: 'web' } : undefined,
  inject: (deps, callback) => {
   callback({
    commands: {
     register: (spec) => { registered[spec.name] = spec; }
    }
   });
  }
 };

 // issue #12: apply 不能报 ReferenceError: hostProfile is not defined 或 Assignment to constant variable
 plugin.apply(mockCtx);
 assert.ok(registered['purge']);
 assert.ok(registered['ap']);

 // 执行 /purge on，写入当前 profile (web)
 const resOn = registered['purge'].handler({ rawInput: 'on' });
 assert.equal(resOn.kind, 'success');
 let st = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
 assert.equal(st.dshRuntime?.web?.enabled, true);

 // 执行 /purge mode strict
 const resMode = registered['purge'].handler({ rawInput: 'mode strict' });
 assert.equal(resMode.kind, 'success');
 st = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
 assert.equal(st.dshRuntime?.web?.mode, 'strict');

 // 执行 /purge status
 const resStatus = registered['purge'].handler({ rawInput: 'status' });
 assert.equal(resStatus.kind, 'success');
 assert.match(resStatus.text, /模式 strict/);

 // 执行 /purge off
 const resOff = registered['purge'].handler({ rawInput: 'off' });
 assert.equal(resOff.kind, 'success');
 st = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
 assert.equal(st.dshRuntime?.web?.enabled, false);

 // 不传 profileContext 也能安全回落，不报错
 const fallbackCtx = { inject: () => {} };
 plugin.apply(fallbackCtx);
});

