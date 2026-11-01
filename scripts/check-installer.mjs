// Real Inno Setup lifecycle, with a temporary install/data tree and guarded
// per-user registry/shortcut changes. Local execution is NOT a clean OS test.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedEnv } from '../lib/environment.mjs';
import { hashFile, listFiles, readJSON } from './build-common.mjs';

assert.equal(process.platform, 'win32', 'Installer acceptance requires Windows');
const onRunner = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows';
assert.ok(onRunner || process.argv.includes('--allow-local-machine'),
  'Use a disposable Windows runner, or explicitly opt into guarded local acceptance with --allow-local-machine.');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = readJSON(join(source, 'package.json')).version;
const setup = join(source, 'dist', `agent-purge-${version}-setup.exe`);
assert.ok(existsSync(setup), 'Build the actual setup EXE first');
const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const taskkill = join(system32, 'taskkill.exe');

function footprint() {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $key='{8E4C1D07-2B39-4C6E-9F3A-5D1B7C0A6E42}_is1'
    $roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\',
      'HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\',
      'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\',
      'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\')
    $installs=@($roots | ForEach-Object { $p=$_+$key; if(Test-Path -LiteralPath $p) {
      $v=Get-ItemProperty -LiteralPath $p
      @{key=$p;location=$v.InstallLocation;uninstall=$v.UninstallString}
    }})
    $shortcuts=@(
      [IO.Path]::Combine([Environment]::GetFolderPath('DesktopDirectory'),'agent-purge.lnk'),
      [IO.Path]::Combine([Environment]::GetFolderPath('CommonDesktopDirectory'),'agent-purge.lnk'),
      [IO.Path]::Combine([Environment]::GetFolderPath('Programs'),'agent-purge'),
      [IO.Path]::Combine([Environment]::GetFolderPath('CommonPrograms'),'agent-purge')
    )
    @{installs=$installs;shortcuts=$shortcuts} | ConvertTo-Json -Depth 5 -Compress
  `], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}
const before = footprint();
assert.deepEqual(before.installs, [], 'Existing installation found: no changes made');
assert.deepEqual(before.shortcuts.filter(existsSync), [], 'Existing shortcut/group found: no changes made');

// Keep the install tree in the OS temporary area, just like the clean runner,
// rather than inside the actively watched development checkout.
const base = onRunner ? process.env.RUNNER_TEMP || tmpdir() : tmpdir();
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'ap-installer-'));
const env = isolatedEnv(root);
// Only the shared Node runtime and Windows tools remain visible, not real harnesses.
for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
env.PATH = `${dirname(process.execPath)};${system32}`;
const app = join(root, '安装 space'), cli = join(app, 'bin', 'agent-purge.mjs');
const uninstaller = join(app, 'unins000.exe');
const log = join(root, 'acceptance.json');
const report = { schema: 1, startedAt: new Date().toISOString(), version,
  environment: onRunner ? 'ephemeral-windows-runner' : 'isolated-profile-on-existing-windows',
  installerSha256: hashFile(setup), checks: [], ok: false, root };
const pass = (id, detail = {}) => { report.checks.push({ id, status: 'passed', ...detail }); console.log(`PASS ${id}`); };
const inside = file => assert.ok(relative(root, resolve(file)) && !relative(root, resolve(file)).startsWith('..'), 'Fixture path escaped');
function killTree(child) {
  if (child?.pid && child.exitCode === null)
    spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
}
function run(command, args, { childEnv = env, timeout = 45000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', expired = false;
    child.stdout.on('data', data => { output = (output + data).slice(-16000); });
    child.stderr.on('data', data => { output = (output + data).slice(-16000); });
    const timer = setTimeout(() => { expired = true; killTree(child); reject(new Error(`Timeout: ${command}\n${output}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (!expired) resolveRun({ code, output }); });
  });
}
async function runCLI(...args) {
  const result = await run(process.execPath, [cli, ...args]);
  assert.equal(result.code, 0, result.output);
  return result;
}
const installArgs = label => ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS',
  '/TASKS=!desktopicon', `/DIR=${app}`, `/LOG=${join(root, `${label}.log`)}`];
const uninstallArgs = label => ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${join(root, `${label}.log`)}`];
async function installedLauncher() {
  const reserve = createServer();
  await new Promise(resolveListen => reserve.listen(0, '127.0.0.1', resolveListen));
  const port = reserve.address().port;
  await new Promise(resolveClose => reserve.close(resolveClose));
  const child = spawn(join(app, 'agent-purge.exe'), ['--serve', String(port)], {
    cwd: root, env, windowsHide: true, stdio: 'ignore',
  });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  try {
    let state;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { state = await response.json(); break; }
      } catch {}
      await delay(100);
    }
    assert.equal(state?.version, version, 'Actual installed GUI launcher did not start the server');
    assert.ok(state.personas.some(p => p.id === 'neutral'));
    for (const asset of ['/', '/app.js', '/styles.css', '/assets/agent-purge.ico']) {
      const response = await fetch(`http://127.0.0.1:${port}${asset}`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200, asset);
      await response.arrayBuffer();
    }
  } finally {
    // The C launcher owns a Node child. Stop this exact process tree, never
    // enumerate/kill unrelated Node/browser processes on the user's machine.
    killTree(child);
    await Promise.race([closed, delay(5000)]);
  }
}

let managed;
const rules = join(env.PI_CODING_AGENT_DIR, 'AGENTS.md');
const original = Buffer.from('# user rules\r\n原有配置 KEEP\r\n');
try {
  const missingNode = await run(setup, installArgs('missing-node'), { childEnv: { ...env, PATH: system32 } });
  assert.notEqual(missingNode.code, 0, 'Installer accepted missing Node');
  assert.equal(existsSync(cli), false);
  assert.deepEqual(footprint().installs, []);
  pass('missing-node-rejected-without-dialog', { exitCode: missingNode.code });

  const install = await run(setup, installArgs('install'));
  assert.equal(install.code, 0, install.output);
  assert.ok(existsSync(cli));
  const registered = footprint().installs;
  assert.ok(registered.length > 0 && registered.every(item => resolve(item.location).toLowerCase() === app.toLowerCase()),
    `Unexpected uninstall registration: ${JSON.stringify(registered)}`);
  pass('actual-setup-installed-to-unicode-space-path');

  await runCLI('use', 'neutral');
  const persona = join(env.AGENT_PURGE_HOME, 'personas', 'neutral.md');
  writeFileSync(persona, readFileSync(persona, 'utf8') + '\nUSER_PERSONA_KEEP_验收\n');
  writeFileSync(rules, original);
  await runCLI('install', 'pi');
  managed = readFileSync(rules);
  assert.notDeepEqual(managed, original);
  const personaHash = hashFile(persona), stateHash = hashFile(join(env.AGENT_PURGE_HOME, 'state.json'));
  pass('installed-cli-applies-persona-to-isolated-host');

  const repair = await run(setup, installArgs('reinstall'));
  assert.equal(repair.code, 0, repair.output || readFileSync(join(root, 'reinstall.log'), 'utf8').slice(-3500));
  assert.equal(hashFile(persona), personaHash);
  assert.equal(hashFile(join(env.AGENT_PURGE_HOME, 'state.json')), stateHash);
  assert.deepEqual(readFileSync(rules), managed);
  pass('same-version-reinstall-preserves-persona-state-and-host');

  await installedLauncher();
  pass('actual-installed-native-launcher-serves-web-and-assets');

  // A real restoration failure must block uninstallation, not eat recovery data.
  inside(rules);
  const { unlinkSync } = await import('node:fs');
  unlinkSync(rules); mkdirSync(rules);
  const blocked = await run(uninstaller, uninstallArgs('blocked-uninstall'));
  assert.notEqual(blocked.code, 0, 'Uninstaller ignored the restoration conflict');
  assert.ok(existsSync(cli), 'Program payload lost after blocked uninstall');
  assert.ok(existsSync(join(env.AGENT_PURGE_HOME, 'footprints.json')));
  assert.equal(hashFile(persona), personaHash);
  pass('restoration-conflict-blocks-uninstall-and-keeps-recovery-data', { exitCode: blocked.code });
  rmdirSync(rules); writeFileSync(rules, managed);

  const removed = await run(uninstaller, uninstallArgs('uninstall'));
  assert.equal(removed.code, 0, removed.output);
  assert.equal(existsSync(cli), false);
  assert.equal(hashFile(persona), personaHash);
  assert.deepEqual(readFileSync(rules), original);
  pass('uninstall-restores-original-bytes-and-preserves-user-persona');
  const after = footprint();
  assert.deepEqual(after.installs, []);
  assert.deepEqual(after.shortcuts.filter(existsSync), []);
  assert.deepEqual(listFiles(root).filter(file => file.toLowerCase().endsWith('.lnk')), [], 'Isolated profile retained shortcuts');
  pass('uninstall-registry-and-shortcuts-clean');
  report.ok = true;
} catch (error) {
  report.error = error.stack || error.message;
  // Only undo our own installation. Never uninstall a replaced/foreign entry.
  if (existsSync(uninstaller)) {
    if (managed && existsSync(rules)) {
      const { statSync } = await import('node:fs');
      if (statSync(rules).isDirectory()) { inside(rules); rmdirSync(rules); writeFileSync(rules, managed); }
    }
    try {
      if (footprint().installs.every(item => resolve(item.location).toLowerCase() === app.toLowerCase())) {
        const cleanup = await run(uninstaller, uninstallArgs('failure-cleanup'));
        report.failureCleanup = { exitCode: cleanup.code, registryEntries: footprint().installs.length };
      }
    } catch (cleanupError) { report.failureCleanup = { error: cleanupError.message }; }
  }
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(log, JSON.stringify(report, null, 2) + '\n');
  const archived = join(source, 'out', 'acceptance-2026-11-01', basename(root));
  mkdirSync(archived, { recursive: true });
  for (const file of readdirSync(root).filter(file => /\.(?:log|json)$/.test(file))) copyFileSync(join(root, file), join(archived, file));
  console.log(`Acceptance report: ${log}`);
  console.log(`Archived evidence: ${archived}`);
}
