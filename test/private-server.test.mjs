import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnv } from '../lib/environment.mjs';
import { startPrivateServer, privateClientArgs } from '../lib/private-server.mjs';

test('private v2 host owns the exact server PID and uses an ephemeral authenticated endpoint', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ap-private-server-'));
  let server;
  try {
    writeFileSync(join(cwd, 'serve'), `const http = require('node:http');
const s = http.createServer((req,res) => { res.end(JSON.stringify({ pid: process.pid, password: process.env.OPENCODE_PASSWORD, args: process.argv.slice(2) })); });
s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+s.address().port})));
process.stdin.resume(); process.stdin.on('end',()=>s.close());`);
    let published;
    const env = { ...isolatedEnv(cwd), OPENCODE_PASSWORD: 'INHERITED', OPENCODE_SERVER_PASSWORD: 'INHERITED_SECOND' };
    const lease = { publish: (pid, at) => { published = { pid, at }; }, close: () => {} };
    server = await startPrivateServer(process.execPath, { env, cwd, lease, timeout: 5000 });
    assert.equal(server.pid, published.pid);
    assert.notEqual(server.pid, process.pid);
    const info = await (await fetch(server.url)).json();
    assert.equal(info.pid, server.pid);
    assert.equal(info.password, env.OPENCODE_PASSWORD);
    assert.notEqual(info.password, 'INHERITED');
    assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined);
    assert.deepEqual(info.args, ['--stdio','--hostname','127.0.0.1','--port','0']);
    assert.deepEqual(server.clientArgs(['run','QUESTION','--standalone']), ['--server',server.url,'run','QUESTION']);
    server.close(); await server.exited;
  } finally { server?.close(); rmSync(cwd, { recursive: true, force: true }); }
});
test('private server failure revokes the lease and stops the child', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ap-private-fail-'));
  try {
    writeFileSync(join(cwd, 'serve'), `console.log(JSON.stringify({url:'https://external.invalid:443'}));setInterval(()=>{},1000);`);
    let revoked = false, pid;
    await assert.rejects(startPrivateServer(process.execPath, { env: isolatedEnv(cwd), cwd, lease: { publish: value => pid = value, close: () => revoked = true } }), /readiness/);
    assert.equal(revoked, true); assert.ok(pid);
    assert.throws(() => privateClientArgs(['--server=http://elsewhere'], 'http://127.0.0.1:1'), /移除 --server/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
