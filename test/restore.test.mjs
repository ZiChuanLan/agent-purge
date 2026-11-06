import { isolate } from "./isolate.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const dir = mkdtempSync(join(tmpdir(), 'ap-lifecycle-'));
isolate(dir);
Object.assign(process.env, { HOME: dir, USERPROFILE: dir, AGENT_PURGE_HOME: join(dir, 'data'), AGENT_PURGE_JOURNAL_DIR: join(dir, 'journal'), DSH_HOME: join(dir, '.dsh'), XDG_CONFIG_HOME: join(dir, '.config') });
const { swapFile, recover, journalDir } = await import('../lib/restore.mjs');
const { install, uninstall, stripBlock } = await import('../lib/persist.mjs');
const { backends } = await import('../backends/index.mjs');
const dsh = await import('../lib/dsh.mjs');
const moduleUrl = new URL('../lib/restore.mjs', import.meta.url).href;
const warning = [];
const collect = { onWarning: (w) => warning.push(w) };
const journals = () => readdirSync(journalDir).filter((f) => f.endsWith('.json'));
const active = join(dir, 'active.md');
writeFileSync(active, 'TEST PERSONA');
const cfg = join(dir, '.pi', 'agent', 'AGENTS.md');
mkdirSync(join(dir, '.pi', 'agent'), { recursive: true });
const childScript = `import { swapFile } from ${JSON.stringify(moduleUrl)}; swapFile(process.argv[1], 'temporary'); process.send('ready'); setInterval(()=>{},1000);`;
const children = new Set();
async function owner(file) {
 const p = spawn(process.execPath, ['--input-type=module', '-e', childScript, file], { env: process.env, stdio: ['ignore','ignore','pipe','ipc'] });
 children.add(p);
 await Promise.race([once(p, 'message'), once(p, 'exit').then(([code]) => { throw new Error(`owner exited ${code}`); })]);
 return p;
}
async function kill(p) { const closed = once(p, 'exit'); p.kill('SIGKILL'); await closed; children.delete(p); }
test.after(async () => { for (const p of children) await kill(p); rmSync(dir, { recursive: true, force: true }); });

test('hash uses full paths; binary content and independent undo survive', () => {
 const a = join(dir, 'a'), b = join(dir, 'b');
 const bytes = Buffer.from([0,255,13,10,128]); writeFileSync(a, bytes);
 const ua = swapFile(a, 'A'), ub = swapFile(b, 'B');
 assert.equal(journals().length, 2); ua(); ua(); ub(); ub();
 assert.deepEqual(readFileSync(a), bytes); assert.equal(existsSync(b), false); assert.equal(journals().length, 0);
});
test('live owners are not recovered; competing process cannot overwrite journal', async () => {
 const a = join(dir, 'alive-a'), b = join(dir, 'alive-b'); writeFileSync(a, 'original');
 const pa = await owner(a), pb = await owner(b);
 assert.equal(recover(collect), 0); assert.equal(readFileSync(a, 'utf8'), 'temporary');
 const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import {swapFile} from ${JSON.stringify(moduleUrl)};swapFile(${JSON.stringify(a)},'bad')`], { env: process.env, encoding: 'utf8' });
 assert.notEqual(r.status, 0); assert.match(r.stderr, /未结束的交换/);
 await kill(pa); assert.equal(recover(collect), 1); assert.equal(readFileSync(a, 'utf8'), 'original');
 assert.equal(readFileSync(b, 'utf8'), 'temporary'); await kill(pb); assert.equal(recover(collect), 1); assert.equal(existsSync(b), false);
});
test('user edits prevent undo; retained journal permits retry; corrupt receipt leaves file intact', () => {
 const f = join(dir, 'edited'); writeFileSync(f, 'before'); const undo = swapFile(f, 'after');
 const receipt = join(journalDir, journals()[0]), record = readFileSync(receipt);
 writeFileSync(f, 'user'); assert.throws(undo, /被修改/); assert.equal(readFileSync(f, 'utf8'), 'user');
 writeFileSync(receipt, '{bad'); assert.throws(undo, /无法读取恢复凭据/); assert.equal(readFileSync(f, 'utf8'), 'user');
 writeFileSync(receipt, record); writeFileSync(f, 'after'); undo(); undo(); assert.equal(readFileSync(f, 'utf8'), 'before');
});
test('dead owner with changed target and legacy receipts are conservative', async () => {
 const f = join(dir, 'changed'); const p = await owner(f); await kill(p); writeFileSync(f, 'new user data');
 assert.equal(recover(collect), 0); assert.equal(readFileSync(f, 'utf8'), 'new user data');
 for (const name of journals()) rmSync(join(journalDir, name));
 const legacy = join(journalDir, 'legacy.json'); writeFileSync(legacy, JSON.stringify({ file: f, exists: false }));
 assert.equal(recover(collect), 0); assert.equal(existsSync(legacy), true); assert.equal(readFileSync(f, 'utf8'), 'new user data'); rmSync(legacy);
});
test('install twice/uninstall returns exact bytes, including empty and absent files', () => {
 for (const original of [null, '', 'user\r\n\r\n', 'user without newline']) {
  if (original === null) rmSync(cfg, { force: true }); else writeFileSync(cfg, original);
  install('pi', { root: dir, active }); install('pi', { root: dir, active }); uninstall('pi', { root: dir }); uninstall('pi', { root: dir });
  assert.equal(existsSync(cfg), original !== null); if (original !== null) assert.equal(readFileSync(cfg, 'utf8'), original);
 }
});
test('legacy multiple blocks and outside edit/resync never restore old persona', () => {
 const block = '# >>> agent-purge\r\nOLD\r\n# <<< agent-purge\r\n';
 writeFileSync(cfg, 'USER\r\n'+block+'MIDDLE\r\n'+block);
 install('pi', { root: dir, active }); writeFileSync(cfg, readFileSync(cfg, 'utf8')+'NEW USER\r\n');
 install('pi', { root: dir, active }); uninstall('pi', { root: dir });
 const text = readFileSync(cfg, 'utf8'); assert.doesNotMatch(text, /agent-purge|OLD|TEST PERSONA/); assert.match(text, /USER/); assert.match(text, /MIDDLE/); assert.match(text, /NEW USER/);
 assert.equal(stripBlock('user mentions # >>> agent-purge\n'), 'user mentions # >>> agent-purge\n');
});
test('codex original overridden key survives external edit + resync', () => {
 const f = join(dir, '.codex', 'config.toml'); mkdirSync(join(dir, '.codex'), { recursive: true });
 writeFileSync(f, 'model_instructions_file = "mine.md"\r\n[t]\r\nx=1\r\n');
 install('codex', { root: dir, active }); writeFileSync(f, readFileSync(f,'utf8')+'# USER EDIT\r\n');
 install('codex', { root: dir, active }); uninstall('codex', { root: dir });
 assert.match(readFileSync(f,'utf8'), /model_instructions_file = "mine.md"/); assert.match(readFileSync(f,'utf8'), /# USER EDIT/); assert.doesNotMatch(readFileSync(f,'utf8'), /agent-purge/);
});
test('oneshot opencode setup/cleanup are idempotent and preserve prior file', () => {
 for (const name of ['opencode', 'opencode2']) {
  const f = name === 'opencode' ? join(dir, '.opencode', 'plugin', 'agent-purge.ts') : join(dir, '.config', 'opencode', 'plugins', 'agent-purge-v2-session.ts');
  mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, 'ORIGINAL');
  const b = backends[name]({ personaText:'test', mode:'append', cwd:dir, args:[] });
  b.cleanup(); assert.equal(readFileSync(f,'utf8'), 'ORIGINAL'); b.setup(); b.setup(); b.cleanup(); b.cleanup(); assert.equal(readFileSync(f,'utf8'), 'ORIGINAL');
 }
});
test('dsh temporary plugin restores prior package and patch; cleanup before setup is harmless', () => {
 const profile = dsh.profileDir('headless'); mkdirSync(profile, { recursive:true }); writeFileSync(join(profile,'package.json'), '{}'); writeFileSync(join(profile,'cordis.patch.yml'), '[]\n');
 dsh.addPlugin(dsh.SESSION, 'OLD SOURCE');
 const source = dsh.pluginFile(dsh.SESSION);
 const before = readFileSync(join(profile,'cordis.patch.yml'), 'utf8');
 const b = backends.dsh({ personaText:'test', mode:'append', args:[] }); b.cleanup(); assert.equal(readFileSync(source,'utf8'), 'OLD SOURCE');
 b.setup(); b.setup(); assert.notEqual(readFileSync(source,'utf8'), 'OLD SOURCE'); b.cleanup(); b.cleanup();
 assert.equal(readFileSync(source,'utf8'), 'OLD SOURCE'); assert.equal(readFileSync(join(profile,'cordis.patch.yml'),'utf8'), before);
 dsh.removePlugin(dsh.SESSION); assert.equal(readFileSync(join(profile,'cordis.patch.yml'),'utf8'), '[]\n'); assert.equal(journals().length, 0);
});
test('content already on disk: no journal and no lock is taken', () => {
 const f = join(dir, 'same'); writeFileSync(f, 'same-bytes');
 const undo = swapFile(f, 'same-bytes');
 assert.equal(journals().length, 0);
 undo(); undo();
 assert.equal(readFileSync(f, 'utf8'), 'same-bytes');
});
test('second session joins an identical swap but a different one still conflicts', async () => {
 const f = join(dir, 'join'); writeFileSync(f, 'original');
 const pa = await owner(f);
 assert.equal(journals().length, 1);
 const undo = swapFile(f, 'temporary'); // 同内容：不加锁、不新增 journal
 assert.equal(journals().length, 1); undo();
 assert.throws(() => swapFile(f, 'other'), /持有者 PID \d+/);
 await kill(pa); assert.equal(recover(collect), 1); assert.equal(readFileSync(f, 'utf8'), 'original');
});
test('dead owner is reclaimed once, then this swap proceeds', async () => {
 const f = join(dir, 'reclaim'); writeFileSync(f, 'original');
 const pa = await owner(f); await kill(pa);
 const undo = swapFile(f, 'next');
 assert.equal(readFileSync(f, 'utf8'), 'next');
 undo(); assert.equal(readFileSync(f, 'utf8'), 'original'); assert.equal(journals().length, 0);
});
test('dead owner whose file was edited is not reclaimed', async () => {
 const f = join(dir, 'reclaim-edited'); writeFileSync(f, 'original');
 const pa = await owner(f); await kill(pa); writeFileSync(f, 'user edit');
 assert.throws(() => swapFile(f, 'next'), /无法回收/);
 assert.equal(readFileSync(f, 'utf8'), 'user edit');
 for (const name of journals()) rmSync(join(journalDir, name));
});
