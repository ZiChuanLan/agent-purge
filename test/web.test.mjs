import "./isolate.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { configurationOf, changed, needsApply, sortedHarnesses, effectLabel, scopeSummary } from '../web/model.mjs';
const sandbox = mkdtempSync(join(tmpdir(), 'ap-web-test-'));
const data = join(sandbox, 'data');
const { isolatedEnv } = await import("../lib/environment.mjs");
const env = { ...isolatedEnv(sandbox), AGENT_PURGE_HOME: data, AGENT_PURGE_SHIM_DIR: join(sandbox, 'bin'), PATH: '' };
for (const key of ['HOME','USERPROFILE','PI_CODING_AGENT_DIR','PI_HOME','OMP_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','CODEBUDDY_HOME','GROK_HOME','DSH_HOME','ZCODE_HOME','HERMES_HOME','XDG_CONFIG_HOME']) env[key] = join(sandbox, key);
for (const key of ['AGENT_PURGE_MODE','AGENT_PURGE_FORCE','AGENT_PURGE_PERSONA']) delete env[key];
mkdirSync(join(data, 'personas'), { recursive: true });
writeFileSync(join(data, 'personas', 'a.md'), '---\nid: a\nname: Alpha\n---\nPERSONA_A');
writeFileSync(join(data, 'personas', 'b.md'), '---\nid: b\nname: Beta\n---\nPERSONA_B');
const child = spawn(process.execPath, [resolve('web/server.mjs'), '--serve', '0'], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stderr.on('data', b => logs += b);
let url;
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Web start timeout: ${logs}`)), 15000);
  child.once('exit', code => { clearTimeout(timer); reject(new Error(`Web exited ${code}: ${logs}`)); });
  child.stdout.on('data', b => { const match = String(b).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { url = match[0]; clearTimeout(timer); resolve(); } });
});
async function api(path, payload, method = payload ? 'POST' : 'GET') {
  await ready;
  const response = await fetch(`${url}/api/${path}`, { method, headers: { 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.error, undefined); return body;
}
test.after(async () => {
  if (child.exitCode === null) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed; }
  rmSync(sandbox, { recursive: true, force: true });
});
test('fresh install: static assets, CSP, no path traversal, power-off without default', async () => {
  await ready;
  const html = await fetch(url); assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
  const initial = await api('state');
  assert.equal(initial.defaultsSet, false);
  const initialConfig = configurationOf(initial);
  assert.equal(needsApply(initial, initialConfig, initialConfig), true, 'issue #6: 首次保留默认模式也能直接保存');
  const saved = await api('apply', { ...initialConfig, harness: initial.defaults.harness });
  assert.equal(saved.ok, true);
  assert.equal((await api('state')).defaultsSet, true);
  await api('defaults', { harness: null });
  const markup = await html.text();
  assert.match(markup, /<meta name="ap-server-gen" content="\d+">/, 'HTML 要带上本代编号，供页面卸载时对账');
  const idPattern = markup.match(/id="edit-id"[^>]*pattern="([^"]+)"/)[1];
  // HTML pattern uses Unicode sets (/v); an unescaped hyphen disables browser validation.
  const idRegex = new RegExp(`^(?:${idPattern})$`, 'v');
  assert.equal(idRegex.test('persona-a_2'), true);
  for (const invalid of ['../a', 'a b', '-a', 'a'.repeat(65)]) assert.equal(idRegex.test(invalid), false);
  for (const name of ['app.js','model.mjs','evidence.mjs','styles.css']) assert.equal((await fetch(`${url}/${name}`)).status, 200);
  assert.equal((await fetch(`${url}/package.json`)).status, 404);
  assert.equal((await api('power', { on: false })).mode, 'off');
  assert.equal((await api('state')).defaultsSet, false);
});
test('Web shared apply: select static while paused, resume, switch, edit, delete active', async () => {
  assert.equal((await api('arm', { harness: 'pi', channel: 'install', action: 'on' })).ok, true);
  await api('apply', { persona: 'a', mode: 'off', resumeMode: 'append' });
  const before = await api('state'); assert.equal(before.prevMode, 'append'); assert.equal(before.paused, true);
  await api('power', { on: true });
  const file = join(env.PI_CODING_AGENT_DIR, 'AGENTS.md'); assert.match(readFileSync(file, 'utf8'), /PERSONA_A/);
  await api('use', { id: 'b' }); assert.match(readFileSync(file, 'utf8'), /PERSONA_B/); assert.doesNotMatch(readFileSync(file, 'utf8'), /PERSONA_A/);
  await api('persona', { id: 'b', body: 'BODY_EDITED', meta: { name: '<img src=x onerror=alert(1)>' } }); assert.match(readFileSync(file, 'utf8'), /BODY_EDITED/);
  await api('persona?id=b', null, 'DELETE'); assert.match(readFileSync(file, 'utf8'), /PERSONA_A/); assert.doesNotMatch(readFileSync(file, 'utf8'), /BODY_EDITED/);
  const after = await api('state'); assert.equal(after.lastApply.runtimeConfirmed, false); assert.equal(after.lastApply.persona, 'a');
});
test('sync error stays partial, retry works, pause keeps selected scope', async () => {
  const file = join(env.PI_CODING_AGENT_DIR, 'AGENTS.md');
  rmSync(file); mkdirSync(file);
  const result = await api('sync', {}); assert.equal(result.ok, false); assert.equal(result.results[0].status, 'failed');
  rmSync(file, { recursive: true }); assert.equal((await api('sync', { onlyFailed: true })).ok, true);
  await api('power', { on: false }); const state = await api('state'); assert.deepEqual(state.armed.pi, ['install']);
});
test('verification: missing and malformed reports and same-origin guard', async () => {
  assert.equal((await api('verification')).report, null);
  mkdirSync(join(data, 'verification')); writeFileSync(join(data, 'verification', 'latest.json'), '{bad');
  assert.equal((await fetch(`${url}/api/verification`)).status, 500);
  const denied = await fetch(`${url}/api/power`, { method: 'POST', headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: '{"on":true}' });
  assert.equal(denied.status, 403);
});
test('UI model: paused resume draft, selection sorting, conservative effect labels', () => {
  assert.deepEqual(configurationOf({ active: 'a', paused: true, prevMode: 'strict', defaults: { mode: 'off' } }), { persona: 'a', mode: 'strict' });
  assert.equal(changed({ a: 1 }, { a: 2 }), true);
  const harnesses = [{ id: 'z', armed: [], found: false }, { id: 'a', armed: [], found: true }, { id: 'b', armed: ['install'] }];
  assert.deepEqual(sortedHarnesses({ harnesses }).map(h => h.id), ['b', 'a']);
  assert.equal(effectLabel(harnesses[2]), '配置已写入：新开 b 读取；现有会话还没确认'); assert.match(effectLabel(harnesses[2], true), /暂停/);
  assert.equal(effectLabel({ id: 'c', armed: [], found: false }), '本机没装，装好后再回来开');
  // dsh 的 /purge off 是 profile 级：UI 要能看出哪个形态被暂停了
  assert.match(effectLabel({ id: 'dsh', armed: ['install', 'slash'] }, false, { desktop: { enabled: false } }), /未列出的形态尚未确认/);
  assert.match(effectLabel({ id: 'dsh', profiles: ['desktop', 'web'], armed: ['install', 'slash'] }, false, { desktop: { enabled: false }, web: { enabled: false } }), /已选形态均被/);
  assert.equal(effectLabel({ id: 'dsh', armed: ['install', 'slash'] }, false, {}), '配置已写入：新开 dsh 读取；现有会话还没确认');
  assert.match(effectLabel({ id: 'pi', armed: ['slash'], auto: false, caps: { hot: { ok: true, needs: 'slash' } } }), /purge on/);
  assert.match(effectLabel({ id: 'pi', armed: ['install'], mode: 'off' }), /这家已关闭/);
  assert.match(scopeSummary({ armed: { a: ['install'], b: [] } }), /已选择 1 个/);
  assert.match(scopeSummary({ armed: {}, paused: true }), /已暂停/);
});
test('one switch per harness: auto picks a working channel, off clears every channel', async () => {
  const armedOf = async id => (await api('state')).harnesses.find(h => h.id === id).armed;
  assert.equal((await api('arm', { harness: 'pi', channel: 'auto', action: 'off' })).ok, true);
  assert.deepEqual(await armedOf('pi'), []);
  const on = await api('arm', { harness: 'pi', channel: 'auto', action: 'on' });
  assert.equal(on.ok, true); assert.ok(on.channel, 'auto 应报出它选了哪条通道');
  assert.deepEqual(await armedOf('pi'), [on.channel]);
  // 再点一次开关不会多挂一条通道
  const again = await api('arm', { harness: 'pi', channel: 'auto', action: 'on' });
  assert.equal(again.ok, true); assert.equal(again.channel, on.channel);
  assert.deepEqual(await armedOf('pi'), [on.channel]);
  // 手动多开一条后，auto 关要把整个执行器撤干净
  await api('arm', { harness: 'pi', channel: 'slash', action: 'on' });
  await api('arm', { harness: 'pi', channel: 'auto', action: 'off' });
  assert.deepEqual(await armedOf('pi'), []);
});
test('project selection: explicit off stays local while paused, auto off removes all registered projects', async () => {
  await api('arm', { harness: 'pi', channel: 'auto', action: 'off' });
  await api('power', { on: true });
  await api('arm', { harness: 'pi', channel: 'project', action: 'on' });
  const local = join(sandbox, 'AGENTS.md');
  const other = join(sandbox, 'other-project'); mkdirSync(other);
  const cli = spawnSync(process.execPath, [resolve('bin/agent-purge.mjs'), 'project', 'on', 'pi', '--dir', other], { cwd: sandbox, env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  await api('use', { id: 'a' });
  for (const file of [local, join(other, 'AGENTS.md')]) assert.match(readFileSync(file, 'utf8'), /PERSONA_A/);
  await api('power', { on: false });
  const view = async () => (await api('state')).harnesses.find(h => h.id === 'pi');
  assert.equal((await view()).projectOn, false, '暂停后块已撤下，不能冒充已写入');
  assert.equal((await view()).projectSelected, true, '暂停仍保留本项目选择');
  await api('arm', { harness: 'pi', channel: 'project', action: 'off' });
  assert.equal((await view()).projectOn, false);
  assert.deepEqual((await view()).armed, ['project'], '别的项目仍被选择');
  await api('power', { on: true });
  assert.equal(existsSync(local), false, '已撤选的本项目不能重新写入');
  assert.match(readFileSync(join(other, 'AGENTS.md'), 'utf8'), /PERSONA_A/);
  await api('arm', { harness: 'pi', channel: 'auto', action: 'off' });
  assert.deepEqual((await view()).armed, []);
  assert.equal(existsSync(join(other, 'AGENTS.md')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')).projectDirs, {});
});
test('per-harness persona/mode: 单独指定只动这一家，follow 回去跟随全局', async () => {
  await api('persona', { id: 'b', body: 'PERSONA_B', meta: { name: 'Beta' } });
  const view = async id => (await api('state')).harnesses.find(h => h.id === id);
  const first = async () => (await api('state')).harnesses.find(h => h.personaFrom === 'global' && h.modeFrom === 'global');
  const target = await first();
  assert.ok(target, '至少一家初始跟随全局');
  const id = target.id;

  const one = await api('harness', { harness: id, persona: 'b' });
  assert.equal(one.effective.persona, 'b'); assert.equal(one.effective.personaFrom, 'override');
  assert.equal(one.effective.modeFrom, 'global', '只改人设时模式仍跟随');
  assert.equal((await view(id)).persona, 'b', 'state 回读要能看到这家的人设');

  // 全局换人设不能让被例外的那家跟着变
  await api('use', { id: 'a' });
  assert.equal((await view(id)).persona, 'b');
  const other = await first();
  if (other) assert.equal(other.persona, 'a', '没被指定的那家跟着全局');

  const mode = await api('harness', { harness: id, mode: 'append' });
  assert.equal(mode.effective.mode, 'append'); assert.equal(mode.effective.persona, 'b', '改模式不动已指定的人设');

  const back = await api('harness', { harness: id, persona: 'follow' });
  assert.equal(back.effective.personaFrom, 'global'); assert.equal(back.effective.mode, 'append', 'follow 只还人设');
  assert.equal((await api('state')).overrides[id]?.persona, undefined);

  const bad = await fetch(`${url}/api/harness`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: 'no-such-harness', mode: 'append' }) });
  assert.match((await bad.json()).error, /未知执行器/);
});
test('invalid API payloads preserve configuration and foreign Host is blocked', async () => {
  const before = readFileSync(join(data, 'state.json'), 'utf8');
  const invalid = [
    ['power', '{bad'], ['power', 'null'], ['power', '[]'], ['power', '{}'], ['power', '{"on":"false"}'],
    ['power', ''], ['arm', '{"harness":"pi","action":"typo"}'], ['arm', '{"harness":"pi","channel":"typo","action":"on"}'],
    ['harness', '{"harness":"pi","mode":"typo"}'], ['harness', '{"harness":"pi"}'],
    ['apply', '{"mode":"typo"}'], ['apply', '{"harness":"../pi"}'], ['persona', '{"id":"../x","body":"x"}'],
  ];
  for (const [path, raw] of invalid) {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.equal(response.status, 400, `${path}: ${raw}`);
    assert.ok((await response.json()).error);
    assert.equal(readFileSync(join(data, 'state.json'), 'utf8'), before);
  }
  assert.equal((await fetch(`${url}/api/power`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"on":true}' })).status, 415);
  assert.equal((await fetch(`${url}/api/power`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(2 * 1024 * 1024) }) })).status, 413);
  const { request } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = request(`${url}/api/state`, { headers: { host: `foreign.invalid:${new URL(url).port}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  assert.equal(readFileSync(join(data, 'state.json'), 'utf8'), before);
});
test('issue #1: metadata roundtrip and referenced non-active persona update', async () => {
  writeFileSync(join(data, 'personas', 'meta.md'), '---\nid: meta\nname: Before\ndescription: Original\norder: 7\nharness: ["pi"]\nmodel: ["a/*", "b/*"]\n---\nMETA_OLD');
  const saved = await api('persona', { id: 'meta', body: 'META_NEW', meta: { name: 'After', desc: 'Description', model: 'a/*, b/*' } });
  assert.equal(saved.persona.meta.order, 7);
  assert.deepEqual(saved.persona.meta.harness, ['pi']);
  assert.deepEqual(saved.persona.meta.model, ['a/*', 'b/*']);
  const disk = readFileSync(join(data, 'personas', 'meta.md'), 'utf8');
  assert.match(disk, /description:/); assert.doesNotMatch(disk, /^desc:/m);
  await api('harness', { harness: 'pi', persona: 'meta', mode: 'append' });
  await api('power', { on: true });
  await api('arm', { harness: 'pi', channel: 'install', action: 'on' });
  await api('persona', { id: 'meta', body: 'META_UPDATED', meta: {} });
  assert.match(readFileSync(join(env.PI_CODING_AGENT_DIR, 'AGENTS.md'), 'utf8'), /META_UPDATED/);
  const response = await fetch(`${url}/api/persona?id=meta`, { method: 'DELETE' });
  assert.equal(response.status, 409);
  assert.equal(existsSync(join(data, 'personas', 'meta.md')), true);
  await api('harness', { harness: 'pi', persona: 'follow', mode: 'follow' });
});

test('POST /api/persona/import 端点导入本地目录', async () => {
  const importSrc = mkdtempSync(join(sandbox, 'import-src-'));
  writeFileSync(join(importSrc, 'gamma.md'), '---\nid: gamma\nname: Gamma\n---\nPERSONA_GAMMA');
  const res = await api('persona/import', { source: importSrc, overwrite: true });
  assert.equal(res.ok, true);
  assert.equal(res.result.total, 1);
  assert.equal(res.result.imported[0].id, 'gamma');
  assert.ok(res.personas.some(p => p.id === 'gamma'));
  assert.equal(existsSync(join(data, 'personas', 'gamma.md')), true);
});

test('POST /api/heartbeat 心跳上报与状态返回', async () => {
  const res = await api('heartbeat', {});
  assert.equal(res.ok, true);
  assert.equal(typeof res.now, 'number');
  assert.equal(typeof res.autoExit, 'boolean');
});

test('POST /api/exit 触发优雅退出', async () => {
  // 单独启动一个临时 Web 服务用于验证退出端点
  const exitChild = spawn(process.execPath, [resolve('web/server.mjs'), '--serve', '0'], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let exitUrl;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('exitChild 启动超时')), 10000);
    exitChild.once('exit', code => { clearTimeout(timer); reject(new Error(`exitChild exited ${code}`)); });
    exitChild.stdout.on('data', b => {
      const match = String(b).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { exitUrl = match[0]; clearTimeout(timer); resolve(); }
    });
  });

  const res = await fetch(`${exitUrl}/api/exit`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);

  const exitCode = await new Promise(resolve => {
    const timer = setTimeout(() => { exitChild.kill(); resolve(-1); }, 5000);
    exitChild.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0);
});

test('POST /api/leave 源码态只当作"页面走了"：刷新不会把服务带走', async () => {
  // 前端 pagehide 会发 /api/leave；以前发的 /api/exit 会让"刷新两次"直接把服务刷死。
  const gen = (await (await fetch(url)).text()).match(/name="ap-server-gen" content="(\d+)"/)[1];
  const res = await api(`leave?gen=${gen}`, {});
  assert.equal(res.ok, true);
  assert.equal(res.exit, false, '没有 --auto-exit（终端托管）时不该自杀');
  await new Promise(r => setTimeout(r, 300));
  assert.ok((await api('state')).harnesses.length > 0, '服务仍在响应');
});

test('autoExit: 刷新撤销下线倒计时，旧页面迟到的 beacon 不算数', async () => {
  const { serveWeb } = await import('../web/server.mjs');
  let resolveExit;
  const exited = new Promise(r => { resolveExit = r; });
  const server = serveWeb(0, {
    autoExit: true,
    heartbeatTimeout: 60000,
    initialConnectTimeout: 60000,
    onExit: code => resolveExit(code)
  });
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const genOf = async () => (await (await fetch(base)).text()).match(/name="ap-server-gen" content="(\d+)"/)[1];
  const leave = async (gen) => (await fetch(`${base}/api/leave?gen=${gen}`, { method: 'POST' })).json();

  const first = await genOf();
  assert.equal((await leave(first)).exit, true, '页面卸载 → 起下线倒计时');
  const second = await genOf();
  assert.equal((await leave(first)).exit, false, '上一代页面的 beacon 迟到，必须忽略');
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(server.listening, true, '刷新后的新页面已撤销倒计时');

  assert.equal((await leave(second)).exit, true);
  const code = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('页面真的关掉后未退出')), 5000))
  ]);
  assert.equal(code, 0);
});

test('autoExit: 窗口关闭无心跳后自动超时退出', async () => {
  const { serveWeb } = await import('../web/server.mjs');
  let exitedCode = null;
  const exited = new Promise(resolve => {
    const server = serveWeb(0, {
      autoExit: true,
      heartbeatTimeout: 200,
      initialConnectTimeout: 10000,
      onExit: code => { exitedCode = code; resolve(code); }
    });
    server.once('listening', async () => {
      const p = server.address().port;
      // 模拟前端初次接入并上报心跳
      await fetch(`http://127.0.0.1:${p}/api/heartbeat`, { method: 'POST' });
      // 随后前端窗口关闭，不再发送心跳，等待 200ms 后超时自动退出
    });
  });

  const code = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('autoExit 超时未触发退出')), 5000))
  ]);
  assert.equal(code, 0);
  assert.equal(exitedCode, 0);
});

test('serveWeb: custom onError intercepts EADDRINUSE without immediate exit (issue #9)', async () => {
  const { serveWeb } = await import('../web/server.mjs');
  const first = serveWeb(0);
  await new Promise(resolve => first.once('listening', resolve));
  const occupiedPort = first.address().port;

  let capturedError = null;
  serveWeb(occupiedPort, {
    onError: (err) => { capturedError = err; }
  });

  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(capturedError?.code, 'EADDRINUSE');

  // 探活已有服务状态
  const stateRes = await fetch(`http://127.0.0.1:${occupiedPort}/api/state`);
  assert.equal(stateRes.ok, true);
  const state = await stateRes.json();
  assert.equal(typeof state, 'object');
  assert.ok('version' in state || 'personas' in state);

  await new Promise(resolve => first.close(resolve));
});
