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
const setupOverride = process.argv.find(arg => arg.startsWith('--setup='))?.slice('--setup='.length);
const setup = setupOverride ? resolve(setupOverride) : join(source, 'dist', `agent-purge-${version}-setup.exe`);
assert.ok(existsSync(setup), 'Build the actual setup EXE first');
const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const pwsh = join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const powershell = existsSync(pwsh) ? pwsh : join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const taskkill = join(system32, 'taskkill.exe');
const powershellEnv = input => Object.fromEntries(Object.entries(input).filter(([key]) =>
  !['PSMODULEPATH', 'PSHOME'].includes(key.toUpperCase())));
function inspectScript(script, inputEnv = process.env) {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: powershellEnv(inputEnv), encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout || 'PowerShell inspection failed');
  return result.stdout.replace(/^\uFEFF/, '');
}
const realUserFiles = ['.agent-purge/state.json', '.agent-purge/footprints.json', '.pi/agent/settings.json', '.pi/agent/AGENTS.md']
  .map(file => join(process.env.USERPROFILE, file));
const userSnapshot = Object.fromEntries(realUserFiles.map(file => [file, existsSync(file) ? hashFile(file) : null]));

function footprint() {
  const output = inspectScript(`
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
  `);
  return JSON.parse(output);
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

function inspectWindow(pid) {
  const output = inspectScript(`
    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
    $process=Get-Process -Id ${pid} -ErrorAction SilentlyContinue
    $details=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -OperationTimeoutSec 10 -ErrorAction Stop
    $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" -OperationTimeoutSec 10 -ErrorAction Stop | ForEach-Object {$_.Name})
    @{alive=($null -ne $process);handle=$(if($process){[string]$process.MainWindowHandle}else{'0'});
      title=$(if($process){$process.MainWindowTitle}else{''});exe=$details.ExecutablePath;children=$children} | ConvertTo-Json -Compress
  `, env);
  return JSON.parse(output);
}

async function installedDesktop() {
  const reserve = createServer();
  await new Promise(done => reserve.listen(0, '127.0.0.1', done));
  const port = reserve.address().port;
  await new Promise(done => reserve.close(done));
  const stateFile = join(env.AGENT_PURGE_HOME, 'state.json');
  const state = readJSON(stateFile);
  state.settings = { ...state.settings, desktop: { exitOnClose: true, confirmOnClose: false } };
  const uiCheck = process.argv.includes('--ui');
  let debugPort;
  if (uiCheck) {
    state.settings.language = 'zh-CN';
    state.overrides = { ...state.overrides, dsh: { persona: 'neutral' } };
    const debugReserve = createServer();
    await new Promise(done => debugReserve.listen(0, '127.0.0.1', done));
    debugPort = debugReserve.address().port;
    await new Promise(done => debugReserve.close(done));
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  // Only the window is visible, as in normal desktop use. The launcher/Node remain hidden.
  const child = spawn(join(app, 'agent-purge.exe'), ['web', '--desktop', '--port', String(port)], {
    cwd: app, env: uiCheck ? { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` } : env,
    windowsHide: true, stdio: 'ignore',
  });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const closed = new Promise(done => child.once('close', done));
  let record, window, browser;
  const windowPids = new Set();
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Desktop launcher exited before opening a window (${child.exitCode})`);
      try { record = readJSON(join(env.AGENT_PURGE_HOME, 'web-instance.json')); } catch {}
      if (record?.windowPid) {
        windowPids.add(record.windowPid);
        window = inspectWindow(record.windowPid);
        if (!window.alive) throw new Error(`Native window process ${record.windowPid} died during startup`);
        if (window.handle !== '0' && window.children.includes('msedgewebview2.exe')) break;
      }
      await delay(250);
    }
    assert.ok(window?.alive && window.handle !== '0', 'Actual installed desktop window never appeared');
    assert.ok(window.children.includes('msedgewebview2.exe'), 'Native window did not initialize WebView2');
    assert.equal(resolve(window.exe).toLowerCase(), join(app, 'agent-purge-window.exe').toLowerCase(),
      'Expected the native host, not a silent browser fallback');
    assert.match(window.title, /agent-purge/);
    const response = await fetch(`http://127.0.0.1:${port}/api/instance`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    pass('actual-native-window-and-webview2-visible', { pid: record.pid, windowPid: record.windowPid, title: window.title });

    const reused = await run(join(app, 'agent-purge.exe'), ['web', '--desktop', '--port', String(port)], { timeout: 30000 });
    assert.equal(reused.code, 0, reused.output);
    const again = readJSON(join(env.AGENT_PURGE_HOME, 'web-instance.json'));
    if (again.windowPid) windowPids.add(again.windowPid);
    assert.equal(again.pid, record.pid);
    assert.equal(again.windowPid, record.windowPid);
    pass('desktop-second-launch-reuses-service-and-window');

    if (uiCheck) {
      const { chromium } = await import('@playwright/test');
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 15000 });
      const page = browser.contexts().flatMap(context => context.pages())
        .find(candidate => candidate.url().startsWith(`http://127.0.0.1:${port}`));
      assert.ok(page, 'No installed application page found in its isolated WebView2');
      await page.locator('#show-all').check();
      const card = page.locator('.tool-card[data-id="dsh"]');
      await card.waitFor({ state: 'visible' });
      assert.doesNotMatch(await card.locator('.tool-card-meta').innerText(), /专属|Custom:/);
      await card.locator('.tool-card-more').click();
      await page.locator('#panel-dsh').waitFor({ state: 'visible' });
      assert.doesNotMatch(await page.locator('#panel-dsh h2').innerText(), /专属|Custom/);
      assert.equal(await page.locator('select[data-hpersona="dsh"]').inputValue(), 'neutral',
        'Removing the badge must not remove independent persona settings');
      await page.screenshot({ path: join(root, 'desktop-dsh.png') });
      pass('installed-dsh-ui-uses-common-mode-label-without-exclusive-badge');
      await page.locator('#close-drawer').click();
    }

    const runningStateHash = hashFile(stateFile);
    const runningUninstall = await run(uninstaller, uninstallArgs('running-window-uninstall'));
    assert.notEqual(runningUninstall.code, 0, 'Uninstall must not delete binaries while its desktop is running');
    assert.ok(existsSync(cli));
    assert.equal(hashFile(stateFile), runningStateHash, 'Cancelling because the app is running must not revoke configuration');
    pass('running-desktop-blocks-uninstall-before-clean-or-payload-deletion');

    const close = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -Namespace ApAcceptance -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; if(-not [ApAcceptance.Native]::PostMessage([IntPtr]${window.handle},0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){exit 1}`]);
    assert.equal(close.code, 0, close.output);
    const exitCode = await Promise.race([closed, delay(15000).then(() => 'timeout')]);
    assert.equal(exitCode, 0, `Closing the actual window did not stop its service: ${exitCode}`);
    assert.equal(inspectWindow(record.windowPid).alive, false);
    assert.ok(existsSync(join(env.AGENT_PURGE_HOME, 'window-profile', 'window-state.txt')));
    pass('closing-native-window-exits-service-and-saves-window-state');
  } catch (error) {
    report.desktopError = error.stack || error.message;
    console.error(`Desktop acceptance failed: ${report.desktopError}`);
    throw error;
  } finally {
    killTree(child);
    await Promise.race([closed, delay(5000)]);
    for (const windowPid of windowPids) {
      try {
        const remaining = inspectWindow(windowPid);
        if (remaining.alive && remaining.exe &&
            resolve(remaining.exe).toLowerCase() === join(app, 'agent-purge-window.exe').toLowerCase())
          spawnSync(taskkill, ['/PID', String(windowPid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      } catch (error) {
        report.desktopCleanupError = error.message;
        console.error(`Desktop cleanup inspection failed: ${error.message}`);
      }
    }
    if (browser) await browser.close().catch(() => {});
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
  await installedDesktop();

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

  // A stale, non-active file ledger is the only kind of conflict this fixture tolerates.
  // Preserve the foreign file plus its ledger and diagnostic when clean returns 3.
  const legacyFile = join(root, 'legacy-user-file.txt');
  inside(legacyFile);
  writeFileSync(legacyFile, 'LEGACY USER BYTES KEEP');
  const ledgerPath = join(env.AGENT_PURGE_HOME, 'footprints.json');
  const ledger = readJSON(ledgerPath);
  ledger.entries.push({ id: 'acceptance-stale-file', kind: 'file', harness: 'pi', channel: 'shim',
    path: legacyFile, sha256: '0'.repeat(64), undo: { type: 'file-delete' } });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  const removed = await run(uninstaller, uninstallArgs('uninstall'));
  assert.equal(removed.code, 0, removed.output);
  assert.equal(existsSync(cli), false);
  assert.equal(hashFile(persona), personaHash);
  assert.deepEqual(readFileSync(rules), original);
  pass('uninstall-restores-original-bytes-and-preserves-user-persona');
  assert.equal(readFileSync(legacyFile, 'utf8'), 'LEGACY USER BYTES KEEP');
  assert.ok(readJSON(ledgerPath).entries.some(entry => entry.id === 'acceptance-stale-file'));
  assert.ok(readFileSync(join(env.AGENT_PURGE_HOME, 'clean-leftovers.log'), 'utf8').includes(legacyFile));
  pass('uninstall-skips-only-legacy-ledger-and-preserves-evidence');
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
  report.realUserFilesUnchanged = realUserFiles.every(file =>
    (existsSync(file) ? hashFile(file) : null) === userSnapshot[file]);
  if (!report.realUserFilesUnchanged) {
    report.ok = false;
    process.exitCode = 1;
    console.error('Real user configuration changed during acceptance; original files were not overwritten.');
  }
  writeFileSync(log, JSON.stringify(report, null, 2) + '\n');
  const archived = join(source, 'out', `acceptance-${report.startedAt.slice(0, 10)}`, basename(root));
  mkdirSync(archived, { recursive: true });
  for (const file of readdirSync(root).filter(file => /\.(?:log|json|png)$/.test(file))) copyFileSync(join(root, file), join(archived, file));
  console.log(`Acceptance report: ${log}`);
  console.log(`Archived evidence: ${archived}`);
}
