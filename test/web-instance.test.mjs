import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimInstance, instancePath, processAlive, readInstance, registerInstance, releaseInstance, updateWindow } from '../lib/web-instance.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'ap-instance-'));
test.after(() => rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const DEAD_PID = 999999;

test('claimInstance: 第二个进程抢不到同一个 home，登记里的 pid 不会被人覆盖', async () => {
  const home = mkdtempSync(join(sandbox, 'home-'));
  assert.deepEqual(claimInstance(home, { pid: DEAD_PID + 1, port: 7788 }), { ok: true });
  assert.equal(readInstance(home).port, 7788);

  // 找一个真的活着的、又不是自己的 pid：占位文件存在的意义就是挡住「另一个进程」
  const { spawn } = await import('node:child_process');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    writeFileSync(instancePath(home), JSON.stringify({ pid: holder.pid, port: 7788 }));
    const second = claimInstance(home, { pid: process.pid, port: 7890 });
    assert.equal(second.ok, false);
    assert.equal(second.existing?.port, 7788, '冲突时要把已有实例交回去，好让调用方去复用窗口');
    assert.equal(readInstance(home).pid, holder.pid);
  } finally {
    holder.kill();
  }
});

test('claimInstance: 进程被强杀留下的僵尸登记会被清掉重来', () => {
  const home = mkdtempSync(join(sandbox, 'stale-'));
  writeFileSync(instancePath(home), JSON.stringify({ pid: DEAD_PID, port: 7788 }));
  assert.equal(processAlive(DEAD_PID), false);
  assert.deepEqual(claimInstance(home, { pid: process.pid, port: 7890 }), { ok: true });
  assert.equal(readInstance(home).port, 7890);
  releaseInstance(home, process.pid);
});

test('readInstance: 坏文件当作没有登记', () => {
  const home = mkdtempSync(join(sandbox, 'broken-'));
  writeFileSync(instancePath(home), '{"pid":');
  assert.equal(readInstance(home), null);
  writeFileSync(instancePath(home), JSON.stringify({ pid: 'x', port: 7788 }));
  assert.equal(readInstance(home), null);
});

test('updateWindow: 只补在自己那条登记上，退出时清理也认 pid', () => {
  const home = mkdtempSync(join(sandbox, 'window-'));
  assert.deepEqual(claimInstance(home, { pid: process.pid, port: 7788 }), { ok: true });
  assert.equal(updateWindow(home, process.pid, 4242), true);
  assert.equal(readInstance(home).windowPid, 4242);
  assert.equal(updateWindow(home, DEAD_PID, 999), false, '别人的登记不许改');

  assert.equal(releaseInstance(home, DEAD_PID), false);
  assert.equal(readInstance(home)?.windowPid, 4242);
  assert.equal(releaseInstance(home, process.pid), true);
  assert.equal(readInstance(home), null);
});

test('registerInstance: 端口 0（隔离 smoke 的随机端口）不参与单例', () => {
  const home = mkdtempSync(join(sandbox, 'ephemeral-'));
  assert.deepEqual(registerInstance(home, 0), { ok: true });
  assert.equal(readInstance(home), null);
});

test('registerInstance: 登记后退出事件会清理文件', async () => {
  const home = mkdtempSync(join(sandbox, 'exit-'));
  const script = [
    `import { registerInstance, readInstance } from ${JSON.stringify(new URL('../lib/web-instance.mjs', import.meta.url).href)};`,
    `const home = ${JSON.stringify(home)};`,
    "registerInstance(home, 7788);",
    "console.log(JSON.stringify(readInstance(home)));",
  ].join('\n');
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout.trim()).port, 7788);
  assert.equal(readInstance(home), null, '子进程退出后登记必须消失');
});
