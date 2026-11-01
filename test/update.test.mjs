import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSemver, currentVersion, checkForUpdate, downloadFile, canReplaceSelf, replaceSelfExecutable, replaceExecutable } from '../lib/update.mjs';

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
