import "./isolate.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import { spawnBin, captureBin, prepareCommand } from '../lib/spawn.mjs';
import { MANAGED_PI_BATCH, MANAGED_PI_JS, MANAGED_PI_POWERSHELL } from '../lib/wrappers.mjs';
const dir = mkdtempSync(join(tmpdir(), 'ap argv '));
test.after(() => rmSync(dir, { recursive:true, force:true }));
const script = join(dir,'node_modules','fixture','cli.js'); mkdirSync(dirname(script),{recursive:true});
writeFileSync(script,'console.log(JSON.stringify(process.argv.slice(2)))');
const values = ['', '"', 'a"b', '中文', 'a b\\', '\\', 'line1\nline2', '%PATH%', '^&|<>!', 'x'.repeat(10000), 'developer_instructions="引号 \\" and \\n"'];
async function run(file,args,opts={}) {
 const child=spawnBin(file,args,{...opts,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr=''; child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
 const [code]=await once(child,'close'); assert.equal(code,0,stderr); return stdout.trim();
}
test('native argv round-trip',async()=>{ assert.deepEqual(JSON.parse(await run(process.execPath,[script,...values])),values); });
const cmd = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fixture\\cli.js" %*
`;
const ps=`#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
 $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
 if ($MyInvocation.ExpectingInput) {
  $input | & "$basedir/node$exe"  "$basedir/node_modules/fixture/cli.js" $args
 } else {
  & "$basedir/node$exe"  "$basedir/node_modules/fixture/cli.js" $args
 }
 $ret=$LASTEXITCODE
} else {
 if ($MyInvocation.ExpectingInput) {
  $input | & "node$exe"  "$basedir/node_modules/fixture/cli.js" $args
 } else {
  & "node$exe"  "$basedir/node_modules/fixture/cli.js" $args
 }
 $ret=$LASTEXITCODE
}
exit $ret
`;
for(const [ext,source] of [['cmd',cmd],['ps1',ps]]) test(`npm ${ext} preserves all argv including 10K`,{skip:process.platform!=='win32'},async()=>{
 const file=join(dir,`fixture.${ext}`); writeFileSync(file,source);
 assert.deepEqual(JSON.parse(await run(file,values)),values);
});
test('Node 20+ npm CMD resolves npm-cli.js and preserves spaced paths',{skip:process.platform!=='win32'},async()=>{
 const base=join(dir,'modern-npm');
 const cli=join(base,'node_modules','npm','bin','npm-cli.js');
 mkdirSync(dirname(cli),{recursive:true});
 writeFileSync(cli,'console.log(JSON.stringify(process.argv.slice(2)))');
 const file=join(base,'npm.cmd');
 writeFileSync(file,`:: Created by npm, please don't edit manually.
@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)
SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"
)
IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (
  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"
)
"%NODE_EXE%" "%NPM_CLI_JS%" %*`);
 const spaced=join(dir,'安装 space');
 assert.deepEqual(JSON.parse(await run(file,['install','--prefix',spaced,'--ignore-scripts'])),['install','--prefix',spaced,'--ignore-scripts']);
});
test('ordinary PowerShell runs its own logic and receives literal args',{skip:process.platform!=='win32'},async()=>{
 const file=join(dir,'ordinary.ps1');
 writeFileSync(file,`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ConvertTo-Json -Compress -InputObject @($args)`);
 assert.deepEqual(JSON.parse(await run(file,values)),values);
});
test('nonstandard batch refuses unsafe args, detection returns null instead of throwing',{skip:process.platform!=='win32'},()=>{
 const file=join(dir,'ordinary.cmd'); writeFileSync(file,'@echo off\necho hello\n');
 assert.throws(()=>spawnBin(file,['%PATH%']),/非标准 batch/); assert.throws(()=>spawnBin(file,['']),/非标准 batch/);
 assert.equal(captureBin(file,['%PATH%']),null);
});
test('pi official launcher preserves argv, but modified launcher is not bypassed',{skip:process.platform!=='win32'},async()=>{
 const file=join(dir,'pi.cmd');writeFileSync(join(dir,'pi-launcher.js'),'console.log(JSON.stringify(process.argv.slice(2)))');
 writeFileSync(file,'@ECHO off\nnode "%~dp0pi-launcher.js" %*');assert.deepEqual(JSON.parse(await run(file,values)),values);
 writeFileSync(file,'@ECHO off\necho changed\nnode "%~dp0pi-launcher.js" %*');assert.throws(()=>spawnBin(file,values),/非标准 batch/);
});
test('managed pi CMD and PowerShell resolve the exact verified host and preserve argv', {skip:process.platform!=='win32'}, async()=>{
 const base=join(dir,'managed'),bin=join(base,'bin'),pkg=join(base,'install','releases','1.0.0','node_modules','@earendil-works','pi-coding-agent');
 mkdirSync(bin,{recursive:true});mkdirSync(pkg,{recursive:true});
 writeFileSync(join(base,'install','current-version'),'1.0.0');
 writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',bin:{pi:'cli.js'}}));
 writeFileSync(join(pkg,'cli.js'),'console.log(JSON.stringify(process.argv.slice(2)))');
 writeFileSync(join(bin,'pi-launcher.js'),MANAGED_PI_JS);
 for(const [ext,source] of [['cmd',MANAGED_PI_BATCH],['ps1',MANAGED_PI_POWERSHELL]]) {
  const file=join(bin,'pi.'+ext);writeFileSync(file,source);
  assert.equal(prepareCommand(file,values).hostDirect,true);
  assert.deepEqual(JSON.parse(await run(file,values)),values);
  writeFileSync(file,source+'\n# changed\n');
  assert.notEqual(prepareCommand(file,['plain']).hostDirect,true);
 }
});
test('npm native-exe shim bypasses PowerShell native quoting',{skip:process.platform!=='win32'},async()=>{
 const exe=join(dir,'node_modules','fixture','native.exe');copyFileSync(process.execPath,exe);
 const file=join(dir,'native.ps1');writeFileSync(file,`#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
$exe=".exe"
}
if ($MyInvocation.ExpectingInput) {
$input | & "$basedir/node_modules/fixture/native.exe"   $args
} else {
& "$basedir/node_modules/fixture/native.exe"   $args
}
exit $LASTEXITCODE`);
 assert.deepEqual(JSON.parse(await run(file,[script,...values])),values);
});
test('nonzero subprocess result is not a successful capture',()=>{assert.equal(captureBin(process.execPath,['-e','process.stdout.write("oops");process.exit(2)']),null);});
