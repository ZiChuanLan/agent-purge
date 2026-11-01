import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedEnv } from '../lib/environment.mjs';
import { runtimeFiles, validateThin, writeManifest } from '../scripts/build-common.mjs';
import { checkDocumentationLinks, publicationProblem } from '../scripts/check-repo.mjs';

test('thin manifest detects changed source, changed payload, extra files and wrong product', () => {
  const root=mkdtempSync(join(tmpdir(),'ap-manifest-')), src=join(root,'source'), out=join(root,'payload');
  try {
    for(const dir of ['bin','lib','backends','bench','web/assets']) mkdirSync(join(src,dir),{recursive:true});
    const files=['bin/agent-purge.mjs','lib/core.mjs','backends/index.mjs','bench/capture.mjs','web/assets/pi.png','web/server.mjs','web/ui.html','web/app.js','web/model.mjs','web/styles.css','matrix.json','package.json','README.md','CONTRIBUTING.md','LICENSE'];
    for(const file of files) writeFileSync(join(src,file),file==='package.json'?' {"version":"1.2.3"}':file);
    mkdirSync(join(src,'web/shots'));writeFileSync(join(src,'web/shots/private.png'),'PRIVATE');
    mkdirSync(join(src,'personas'));writeFileSync(join(src,'personas/private.md'),'PRIVATE');
    const allowed=runtimeFiles(src);assert.equal(allowed.some(file=>/shots|private/.test(file)),false);
    for(const file of allowed){mkdirSync(dirname(join(out,file)),{recursive:true});copyFileSync(join(src,file),join(out,file));}
    writeManifest(out,'thin','1.2.3',src);assert.equal(validateThin(out,src).version,'1.2.3');
    writeFileSync(join(src,'lib/core.mjs'),'changed');assert.throws(()=>validateThin(out,src),/源码不一致/);writeFileSync(join(src,'lib/core.mjs'),'lib/core.mjs');
    writeFileSync(join(out,'README.md'),'edited');assert.throws(()=>validateThin(out,src),/文件已改变/);writeFileSync(join(out,'README.md'),'README.md');
    writeFileSync(join(out,'extra'),'extra');assert.throws(()=>validateThin(out,src),/文件清单已改变/);rmSync(join(out,'extra'));
    writeManifest(out,'standalone','1.2.3',src);assert.throws(()=>validateThin(out,src),/manifest\/版本不匹配/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('npm package includes all runtime files', () => {
  const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['pack','--dry-run','--json','--ignore-scripts'],{encoding:'utf8',shell:process.platform==='win32'});
  assert.equal(result.status,0,result.stderr);
  const entries=JSON.parse(result.stdout)[0].files;
  const packed=new Set(entries.map(file=>file.path));
  assert.ok(packed.has('lib/templates/personas/neutral.md'), '新安装必须包含起步模板');
  for (const file of packed) assert.doesNotMatch(file, /^(?:personas|out|dist|\.tmp|\.pi)\//, '私人数据不得进入 npm 包');
  for (const file of entries) assert.equal(publicationProblem(file.path, { distribution: true, size: file.size }), null, file.path);
  assert.deepEqual(checkDocumentationLinks([...packed]), [], '打包后的文档不能链接到未随包分发的文件');
  const missing=runtimeFiles(resolve('.')).filter(file=>!packed.has(file.replaceAll('\\','/')));
  assert.deepEqual(missing,[]);
});
test('starter template is not excluded from a fresh Git checkout', () => {
  const result = spawnSync('git', ['check-ignore', '--no-index', 'lib/templates/personas/neutral.md'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout || result.stderr);
});
test('installer cleanup preserves user data; permanent CLI removal requires explicit confirmation', () => {
  const installer = readFileSync(resolve('packaging/agent-purge.iss'), 'utf8');
  assert.match(installer, /agent-purge\.exe'\), 'clean'/);
  assert.doesNotMatch(installer, /'self-uninstall/);
  assert.doesNotMatch(installer, /(?:^|\W)MsgBox\(/, 'silent acceptance must not block on unsuppressible dialogs');
  assert.match(installer, /SuppressibleMsgBox/);
  assert.match(installer, /Tasks: desktopicon/, 'desktop shortcut must be explicitly selectable');
  const root = mkdtempSync(join(tmpdir(), 'ap-uninstall-confirm-')), env = isolatedEnv(root);
  try {
    const file = join(env.AGENT_PURGE_HOME, 'keep.txt');
    writeFileSync(file, 'USER DATA');
    const result = spawnSync(process.execPath, [resolve('bin/agent-purge.mjs'), 'self-uninstall'], { env, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--yes/);
    assert.equal(readFileSync(file, 'utf8'), 'USER DATA');
    assert.deepEqual(readdirSync(env.AGENT_PURGE_JOURNAL_DIR), []);
    assert.deepEqual(readdirSync(env.AGENT_PURGE_HOME), ['keep.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('CLI --help never initializes configuration or recovers a journal', () => {
  const root=mkdtempSync(join(tmpdir(),'ap-help-')), env=isolatedEnv(root);
  try {
    const journal=join(env.AGENT_PURGE_JOURNAL_DIR,'unrelated.json');writeFileSync(journal,'KEEP');
    const result=spawnSync(process.execPath,[resolve('bin/agent-purge.mjs'),'--help'],{env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.deepEqual(readdirSync(env.AGENT_PURGE_HOME),[]);assert.equal(readFileSync(journal,'utf8'),'KEEP');
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('compiled resources provide the actual version instead of a disk fallback', () => {
  const root=mkdtempSync(join(tmpdir(),'ap-compiled-version-'));
  try {
    const pkg=join(root,'embedded-package.json'), entry=join(root,'entry.mjs');
    writeFileSync(pkg,'{"version":"8.7.6"}');
    writeFileSync(entry,`globalThis.__AGENT_PURGE_FILES = { 'package.json': ${JSON.stringify(pkg)} };\nconst {currentVersion,canReplaceSelf}=await import(${JSON.stringify(pathToFileURL(resolve('lib/update.mjs')).href)});\nif(currentVersion()!=='8.7.6'||canReplaceSelf())process.exit(1);`);
    const result=spawnSync(process.execPath,[entry],{env:isolatedEnv(root),encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
