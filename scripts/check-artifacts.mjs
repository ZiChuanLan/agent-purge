// Portable products only. Installer execution is deliberately restricted to a clean CI runner.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smoke } from './build-smoke.mjs';
import { hashFile, readJSON } from './build-common.mjs';

if (process.platform !== 'win32') throw new Error('Windows ZIP/EXE 验收需要 Windows');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(source, 'dist'), version = readJSON(join(source, 'package.json')).version;
const root = mkdtempSync(join(tmpdir(), 'ap-artifacts-'));
const quote = value => `'${value.replaceAll("'", "''")}'`;
try {
  const unpack = join(root, '解压 space');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(join(dist, `agent-purge-${version}.zip`))}, ${quote(unpack)})`],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const thin = join(unpack, 'agent-purge'), manifest = readJSON(join(thin, 'build-manifest.json'));
  assert.equal(manifest.flavor, 'thin');
  assert.equal(manifest.version, version);
  for (const [file, digest] of Object.entries(manifest.files)) assert.equal(hashFile(join(thin, file)), digest, file);
  await smoke(process.execPath, [join(thin, 'bin/agent-purge.mjs')], { cwd: thin, version });
  // Test the actual C launcher too, not only its JS payload.
  // GUI launcher intentionally has no redirected stdout; verify its exit status,
  // while HTTP readiness is exercised through the identical packaged Node entry.
  await smoke(join(thin, 'agent-purge.exe'), [], { cwd: thin, version, serve: false });
  const standalone = join(dist, 'agent-purge.exe');
  assert.equal(hashFile(standalone), readJSON(join(dist, 'standalone-manifest.json')).sha256);
  await smoke(standalone, [], { cwd: root, version, withoutNode: true });
  console.log('ZIP payload, graphical launcher, and standalone EXE without Node on PATH: passed');
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
