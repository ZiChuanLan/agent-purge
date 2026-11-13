import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { findChromiumAppBrowser, focusConsoleWindow, openAppWindow, windowProfileDir } from '../lib/window.mjs';

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
  assert.ok(capturedArgs.includes('--app=http://127.0.0.1:12345'));
});

test('windowProfileDir keeps the window profile inside the data home', () => {
  assert.equal(windowProfileDir('C:\\data'), join('C:\\data', 'window-profile'));
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
