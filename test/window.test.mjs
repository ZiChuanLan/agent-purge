import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openAppWindow } from '../lib/window.mjs';

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
