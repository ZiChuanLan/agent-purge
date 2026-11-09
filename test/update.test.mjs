import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSemver, currentVersion, checkForUpdate, downloadFile, canReplaceSelf, replaceSelfExecutable, replaceExecutable, detectInstallType, isGitCheckout, gitCheckoutState, gitPullSelf } from '../lib/update.mjs';

const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('compareSemver includes prerelease ordering and ignores build metadata', () => {
  for (const [a,b,result] of [['0.2.11','0.2.11',0], ['0.2.11','0.2.12',1], ['0.2.11','0.3.0',1], ['0.2.11','1.0.0',1], ['0.2.11','0.2.10',-1], ['v0.2.11','0.2.11',0], ['1.0.0-beta.9','1.0.0-beta.10',1], ['1.0.0-beta','1.0.0',1], ['1.0.0','1.0.0-rc.1',-1], ['1.0.0+one','1.0.0+two',0]]) assert.equal(Math.sign(compareSemver(a,b)),result,`${a} -> ${b}`);
});
test('currentVersion reads the packaged version and Node is never self-replaceable', () => {
  assert.equal(currentVersion(), pkgVersion);
  assert.equal(canReplaceSelf(), false);
  assert.throws(() => replaceSelfExecutable('not-a-file'), /Node\/脚本安装/);
});
test('no published Release is distinct from a verified latest version', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ status: 404 }));
  const info = await checkForUpdate({ force: true });
  assert.equal(info.ok, true);
  assert.equal(info.published, false);
  assert.equal(info.hasUpdate, false);
  assert.deepEqual(info.assets, []);
});
test('checkForUpdate times out during both headers and body without external network', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    await new Promise(done => signal.addEventListener('abort', done, { once: true }));
    throw new DOMException('fixture timeout', 'AbortError');
  });
  assert.equal((await checkForUpdate({timeout:10,force:true})).error, '请求超时');
  globalThis.fetch = async () => ({ ok:true, status:200, json:()=>new Promise(()=>{}) });
  assert.equal((await checkForUpdate({timeout:10,force:true})).error, '请求超时');
});
test('release cache recomputes current version and validates release metadata', async t => {
  const dir=mkdtempSync(join(tmpdir(),'ap-update-cache-')), file=join(dir,'cache.json');
  try {
    let calls=0;
    t.mock.method(globalThis,'fetch',async()=>{calls++;return {ok:true,status:200,json:async()=>({tag_name:'v9.9.9',assets:[{name:'agent-purge.exe',size:100,browser_download_url:'https://example.invalid/app',digest:'sha256:abc'},{name:'wrong',browser_download_url:'file:///tmp/x'}]})};});
    const info=await checkForUpdate({cacheFile:file}); assert.equal(info.hasUpdate,true); assert.equal(info.assets.length,1);
    const cached=JSON.parse(readFileSync(file,'utf8'));cached.current='0.0.0';writeFileSync(file,JSON.stringify(cached));
    assert.equal((await checkForUpdate({cacheFile:file})).current,pkgVersion);assert.equal(calls,1);
    globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({tag_name:'bad'})});
    assert.equal((await checkForUpdate({force:true})).ok,false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('streamed downloads publish only complete size/digest-verified bytes', async () => {
  const dir=mkdtempSync(join(tmpdir(),'ap-download-')), file=join(dir,'app.exe'), bytes=Buffer.from('MZfixture payload');
  const server=createServer((req,res)=>{
    if(req.url==='/stall'){res.writeHead(200);res.write('MZ');return;}
    if(req.url==='/truncated'){res.writeHead(200,{'content-length':100});res.end('MZ');return;}
    res.writeHead(200,{'content-length':bytes.length});res.end(bytes);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
    let progressed=0;
    const downloaded=await downloadFile(url,file,received=>progressed=received,{expectedSize:bytes.length,digest});
    assert.equal(progressed,bytes.length);assert.equal(downloaded.size,bytes.length);assert.deepEqual(readFileSync(file),bytes);
    for(const [path,opts] of [['/',{expectedSize:bytes.length+1}],['/',{digest:'sha256:wrong'}],['/',{maxBytes:2}],['/stall',{timeout:30}],['/truncated',{timeout:30}]]){
      await assert.rejects(downloadFile(url+path,file,undefined,opts));
      assert.deepEqual(readFileSync(file),bytes,`old destination survives ${path}`);
      assert.deepEqual(readdirSync(dir),['app.exe']);
    }
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true}); }
});
test('executable replacement uses destination-volume staging and preserves the old binary', () => {
  const dir=mkdtempSync(join(tmpdir(),'ap-replace-')), current=join(dir,'app.exe'), next=join(dir,'download.exe');
  const old=Buffer.from('OLD_BINARY'), bytes=Buffer.concat([Buffer.from('MZ'),Buffer.alloc(100,7)]);
  try {
    writeFileSync(current,old);writeFileSync(next,bytes);
    const result=replaceExecutable(current,next);assert.equal(result.ok,true);assert.deepEqual(readFileSync(current),bytes);assert.deepEqual(readFileSync(result.oldExePath),old);
    for(const name of ['node.exe','bun.exe','node','bun']) assert.throws(()=>replaceExecutable(join(dir,name),next),/共享运行时/);
    writeFileSync(next,'not exe');assert.throws(()=>replaceExecutable(current,next),/可执行文件/);assert.deepEqual(readFileSync(current),bytes);
    assert.equal(readdirSync(dir).some(name=>name.includes('.new-')),false);assert.equal(existsSync(next),true);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

// —— 源码检出（git clone 后直接 node bin/...）：更新就是这个目录里的 git pull ——
// 全用临时仓库跑，不碰真实安装目录；上游用一个裸仓库扮，避免任何外网访问。
function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}
test('git checkout is its own install type and pulls fast-forward only', () => {
  const base = mkdtempSync(join(tmpdir(), 'ap-git-'));
  const bare = join(base, 'origin.git'), work = join(base, 'work'), other = join(base, 'other');
  try {
    sh(base, 'init', '--bare', '-b', 'main', bare);
    sh(base, 'clone', bare, work);
    writeFileSync(join(work, 'a.txt'), 'v1\n');
    sh(work, 'add', '.'); sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v1');
    sh(work, 'push', '-u', 'origin', 'main');

    // 上游有新提交，本地还没拉
    sh(base, 'clone', bare, other);
    writeFileSync(join(other, 'b.txt'), 'v2\n');
    sh(other, 'add', '.'); sh(other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v2');
    sh(other, 'push', 'origin', 'main');

    assert.equal(isGitCheckout(work), true, '工作副本认得出自己是 git 检出');
    assert.equal(isGitCheckout(base), false, '不是仓库根的目录不能算检出');

    const before = gitCheckoutState({ root: work });
    assert.equal(before.ok, true);
    assert.equal(before.branch, 'main');
    assert.equal(before.upstream, 'origin/main');
    assert.equal(before.dirty, 0);

    const pulled = gitPullSelf({ root: work });
    assert.equal(pulled.ok, true);
    assert.equal(pulled.changed, true, '落后时必须真的快进');
    assert.notEqual(pulled.before, pulled.after);
    assert.equal(existsSync(join(work, 'b.txt')), true, '新提交的文件落地');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test('git update refuses a dirty tree, a detached head and a missing upstream', () => {
  const base = mkdtempSync(join(tmpdir(), 'ap-git-bad-'));
  const bare = join(base, 'origin.git'), work = join(base, 'work'), solo = join(base, 'solo');
  try {
    sh(base, 'init', '--bare', '-b', 'main', bare);
    sh(base, 'clone', bare, work);
    writeFileSync(join(work, 'a.txt'), 'v1\n');
    sh(work, 'add', '.'); sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v1');
    sh(work, 'push', '-u', 'origin', 'main');

    // 未提交改动：必须拒绝，且不许自作主张 stash/copy
    writeFileSync(join(work, 'a.txt'), 'local edit\n');
    assert.equal(gitCheckoutState({ root: work }).dirty, 1);
    assert.throws(() => gitPullSelf({ root: work }), /未提交改动/);
    assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'local edit\n', '本地改动保持原样');
    sh(work, 'checkout', '--', 'a.txt');

    // detached HEAD：没有分支名，不能猜
    sh(work, 'checkout', '--detach');
    assert.throws(() => gitPullSelf({ root: work }), /HEAD|没有上游/);
    sh(work, 'checkout', 'main');

    // 没有上游：明确拒绝，不能默认 origin/main
    sh(base, 'init', '-b', 'main', solo);
    writeFileSync(join(solo, 'a.txt'), 'x\n');
    sh(solo, 'add', '.'); sh(solo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'x');
    assert.equal(gitCheckoutState({ root: solo }).upstream, null);
    assert.throws(() => gitPullSelf({ root: solo }), /没有上游/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test('detectInstallType reports git for a source checkout and never for a compiled build', () => {
  // 本测试就运行在源码检出里，所以必须报 git；编译态由 canReplaceSelf 分支在前面拦掉
  assert.equal(isGitCheckout(), true);
  assert.equal(detectInstallType(), canReplaceSelf() ? 'exe' : 'git');
});
test('a failed pull throws instead of reporting success with stderr as output', () => {
  const base = mkdtempSync(join(tmpdir(), 'ap-git-fail-'));
  const work = join(base, 'work');
  try {
    sh(base, 'init', '-b', 'main', work);
    writeFileSync(join(work, 'a.txt'), 'v1\n');
    sh(work, 'add', '.'); sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'v1');
    // 上游指向一个必定连不上的地址：git pull 非零退出，必须抛而不是返回 ok
    sh(work, 'remote', 'add', 'origin', 'https://127.0.0.1:1/nope.git');
    // 直接写 config：上游分支在远端不存在时 --set-upstream-to 会拒绝，但线上配置就是这种形态
    sh(work, 'config', 'branch.main.remote', 'origin');
    sh(work, 'config', 'branch.main.merge', 'refs/heads/main');
    // 让 @{u} 能解析：远程跟踪引用手工造一个，这样才走到真正的 pull 失败
    sh(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.throws(() => gitPullSelf({ root: work, timeout: 8000 }), /git pull 失败/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
