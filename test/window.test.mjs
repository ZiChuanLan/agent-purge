import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { findChromiumAppBrowser, focusConsoleWindow, nativeWindowAvailable, openAppWindow, prepareWindowProfile, windowProfileDir } from '../lib/window.mjs';

test('missing/headless browser reports a manual URL without an uncaught spawn error', () => {
  const child = Object.assign(new EventEmitter(), { unref() {}, pid: 123 });
  const errors = [];
  const result = openAppWindow('http://127.0.0.1:12345', {
    spawnProcess: () => child, onError: error => errors.push(error.message),
  });
  assert.equal(result.pid, 123);
  child.emit('error', new Error('ENOENT'));
  assert.deepEqual(errors, ['ENOENT']);
  assert.equal(openAppWindow('http://127.0.0.1:12345', {
    spawnProcess: () => { throw new Error('spawn failed'); }, onError: () => {},
  }).mode, 'manual');
});

test('openAppWindow passes windowsHide: false so Chromium window is visible (issue #9)', () => {
  let capturedOpts = null;
  const child = Object.assign(new EventEmitter(), { unref() {}, pid: 456 });
  openAppWindow('http://127.0.0.1:12345', {
    spawnProcess: (_cmd, _args, opts) => { capturedOpts = opts; return child; },
  });
  assert.equal(capturedOpts?.windowsHide, false, 'browser window should not be spawned hidden with SW_HIDE');
});

test('openAppWindow gives the console window a dedicated profile so its pid stays usable (issue #14)', {
  skip: !findChromiumAppBrowser() ? '本机没有 Edge/Chrome，--app 分支不适用' : false,
}, () => {
  let capturedArgs = null;
  const child = Object.assign(new EventEmitter(), { unref() {}, pid: 789 });
  const result = openAppWindow('http://127.0.0.1:12345', {
    profileDir: 'C:\\Users\\test\\.agent-purge\\window-profile',
    spawnProcess: (_cmd, args) => { capturedArgs = args; return child; },
  });
  assert.equal(result.mode, 'app');
  assert.ok(capturedArgs.includes('--user-data-dir=C:\\Users\\test\\.agent-purge\\window-profile'));
  assert.ok(capturedArgs.includes('--no-first-run'));
  // Edge 的首启不受 --no-first-run 约束，会经 WAM 把系统 Microsoft 账号关联进新 profile
  assert.ok(capturedArgs.includes('--disable-sync'), 'fresh profile should not auto-link the OS Microsoft account');
  assert.ok(capturedArgs.includes('--app=http://127.0.0.1:12345'));
});

test('windowProfileDir keeps the window profile inside the data home', () => {
  assert.equal(windowProfileDir('C:\\data'), join('C:\\data', 'window-profile'));
});
test('prepareWindowProfile drops a profile another browser (or an older version) left behind', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'ap-window-')), 'window-profile');
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(join(dir, 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { user_name: 'a@b.c', is_consented_primary_account: true } } },
  }));
  assert.equal(prepareWindowProfile(dir, 'C:\\chrome.exe'), true);
  assert.equal(existsSync(join(dir, 'Local State')), false, 'the old Edge profile must not be handed to Chrome');
  assert.equal(readFileSync(join(dir, '.agent-purge-browser'), 'utf8'), 'C:\\chrome.exe');
  assert.equal(existsSync(`${dir}.stale`), false);
});

test('prepareWindowProfile keeps a profile the same browser owns and skips one a live window holds', () => {
  const home = mkdtempSync(join(tmpdir(), 'ap-window-'));
  const dir = join(home, 'same');
  assert.equal(prepareWindowProfile(dir, 'C:\\chrome.exe'), false);
  assert.equal(prepareWindowProfile(dir, 'C:\\chrome.exe'), false);
  assert.equal(existsSync(dir), true);

  const live = join(home, 'live');
  mkdirSync(live, { recursive: true });
  const rename = () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
  assert.equal(prepareWindowProfile(live, 'C:\\chrome.exe', { rename }), false, 'a profile in use must not be touched');
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(join(live, '.agent-purge-browser')), false);
});
test('openAppWindow prefers the native WebView2 host and passes window state plus the close prompt', () => {
  let captured = null;
  const child = Object.assign(new EventEmitter(), { unref() {}, pid: 321 });
  const result = openAppWindow('http://127.0.0.1:12345', {
    profileDir: 'C:\\data\\window-profile',
    nativeExe: 'C:\\app\\agent-purge-window.exe',
    nativeReady: true,
    confirmClose: '关闭窗口会同时退出 agent-purge 服务，确定关闭吗？',
    spawnProcess: (command, args) => { captured = { command, args }; return child; },
  });
  assert.equal(result.engine, 'webview2');
  assert.equal(result.mode, 'app');
  assert.equal(captured.command, 'C:\\app\\agent-purge-window.exe');
  assert.equal(captured.args[0], 'http://127.0.0.1:12345');
  const dataIndex = captured.args.indexOf('--data');
  assert.equal(captured.args[dataIndex + 1], join('C:\\data\\window-profile', 'webview2'));
  const stateIndex = captured.args.indexOf('--state');
  assert.equal(captured.args[stateIndex + 1], join('C:\\data\\window-profile', 'window-state.txt'));
  const confirmIndex = captured.args.indexOf('--confirm-close');
  assert.equal(captured.args[confirmIndex + 1], '关闭窗口会同时退出 agent-purge 服务，确定关闭吗？');
});

test('openAppWindow skips the close prompt when the setting is off', () => {
  let captured = null;
  const child = Object.assign(new EventEmitter(), { unref() {}, pid: 322 });
  openAppWindow('http://127.0.0.1:12345', {
    nativeExe: 'C:\\app\\agent-purge-window.exe',
    nativeReady: true,
    spawnProcess: (_command, args) => { captured = args; return child; },
  });
  assert.equal(captured.includes('--confirm-close'), false);
});

test('nativeWindowAvailable reports false without an exe', () => {
  assert.equal(nativeWindowAvailable(null), false);
  assert.equal(nativeWindowAvailable('C:\\nope\\agent-purge-window.exe'), false);
});

test('focusConsoleWindow tells "window is gone" apart from "window exists but stayed behind"', () => {
  const calls = [];
  const run = (_command, args) => { calls.push(args); return 'AgentPurge.Native\nAGENT_PURGE_WINDOW_FOCUSED\r\n'; };
  assert.deepEqual(focusConsoleWindow({ pid: 4321, profileDir: 'C:\\data\\window-profile' }, { platform: 'win32', run }), { found: true, focused: true });
  assert.match(calls[0].join(' '), /-Command/);
  assert.match(calls[0].join(' '), /4321/);
  assert.match(calls[0].join(' '), /C:\\data\\window-profile/);

  assert.deepEqual(
    focusConsoleWindow({ pid: 4321 }, { platform: 'win32', run: () => 'AGENT_PURGE_WINDOW_UNFOCUSED\n' }),
    { found: true, focused: false },
    '窗口还在只是没抢到焦点时，调用方不能再开一扇',
  );

  assert.deepEqual(
    focusConsoleWindow({ pid: 4321 }, { platform: 'win32', run: () => 'AGENT_PURGE_WINDOW_NOT_FOUND\n' }),
    { found: false, focused: false },
  );

  assert.deepEqual(focusConsoleWindow({ pid: 4321 }, { platform: 'win32', run: () => { throw new Error('powershell missing'); } }), { found: false, focused: false });
  assert.deepEqual(focusConsoleWindow({ pid: 4321 }, { platform: 'linux', run }), { found: false, focused: false });
});
