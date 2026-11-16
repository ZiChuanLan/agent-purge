// Run each native Linux distribution in isolated user data. System dpkg changes
// are allowed only on a disposable Actions runner, never on a workstation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../lib/environment.mjs';
import { hashFile, readJSON } from './build-common.mjs';
import { smoke } from './build-smoke.mjs';

assert.equal(process.platform, 'linux');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(source, 'dist');
const version = readJSON(join(source, 'package.json')).version;
const arch = process.arch;
assert.ok(['x64', 'arm64'].includes(arch), `Unsupported Linux architecture: ${arch}`);
const stem = `agent-purge-${version}-linux-${arch}`;
const manifest = readJSON(join(dist, 'linux-manifest.json'));
assert.equal(manifest.version, version);
const root = mkdtempSync(join(tmpdir(), 'ap-linux-acceptance-'));
const env = { ...isolatedEnv(root), NODE_DISABLE_COMPILE_CACHE: '1' };
const checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${arch} ${name}`); };
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', timeout: 120000, ...options });
  assert.equal(result.status, 0, `${cmd}: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
};
const verify = name => {
  const file = join(dist, name);
  assert.ok(manifest.files[name], `Manifest missing ${name}`);
  assert.equal(hashFile(file), manifest.files[name], `Checksum mismatch: ${name}`);
  return file;
};
let debInstalled = false;
try {
  const binary = verify(stem);
  chmodSync(binary, 0o755);
  await smoke(binary, [], { cwd: root, version, withoutNode: true });
  pass('standalone-without-node');

  const tarball = verify(`${stem}.tar.gz`);
  const unpack = join(root, 'portable');
  mkdirSync(unpack);
  run('tar', ['-xzf', tarball, '-C', unpack]);
  const portable = join(unpack, stem);
  assert.equal(hashFile(join(portable, 'agent-purge')), hashFile(binary));
  run('/bin/sh', [join(portable, 'install.sh')]);
  const installed = join(env.HOME, '.local', 'bin', 'agent-purge');
  assert.equal(hashFile(installed), hashFile(binary));
  assert.ok(existsSync(join(env.XDG_DATA_HOME, 'applications', 'agent-purge.desktop')));
  assert.ok(existsSync(join(env.XDG_DATA_HOME, 'icons', 'hicolor', '512x512', 'apps', 'agent-purge.png')));
  await smoke(installed, [], { cwd: root, version, withoutNode: true });
  pass('portable-user-install-and-web');
  // Only remove the three exact files installed under this freshly created root.
  for (const file of [installed,
    join(env.XDG_DATA_HOME, 'applications', 'agent-purge.desktop'),
    join(env.XDG_DATA_HOME, 'icons', 'hicolor', '512x512', 'apps', 'agent-purge.png')]) rmSync(file);
  assert.ok(existsSync(env.AGENT_PURGE_HOME));
  pass('portable-removal-preserves-user-data');

  const deb = verify(`${stem}.deb`);
  const debArch = arch === 'x64' ? 'amd64' : 'arm64';
  assert.equal(run('dpkg-deb', ['-f', deb, 'Architecture']).trim(), debArch);
  assert.equal(run('dpkg-deb', ['-f', deb, 'Version']).trim(), version);
  const extracted = join(root, 'deb');
  run('dpkg-deb', ['-x', deb, extracted]);
  assert.equal(hashFile(join(extracted, 'opt/agent-purge/agent-purge')), hashFile(binary));
  await smoke(join(extracted, 'opt/agent-purge/agent-purge'), [], { cwd: root, version, withoutNode: true });
  pass('debian-native-payload');
  if (process.env.GITHUB_ACTIONS === 'true') {
    const prior = spawnSync('dpkg-query', ['-W', '-f=${Status}', 'agent-purge'], { encoding: 'utf8' });
    assert.ok(prior.status !== 0 || !prior.stdout.includes('installed'), 'Refusing to replace an existing package');
    assert.ok(!existsSync('/opt/agent-purge') && !existsSync('/usr/bin/agent-purge'), 'Existing system files found');
    run('sudo', ['-n', 'dpkg', '-i', deb]);
    debInstalled = true;
    assert.equal(realpathSync('/usr/bin/agent-purge'), '/opt/agent-purge/agent-purge');
    await smoke('/usr/bin/agent-purge', [], { cwd: root, version, withoutNode: true });
    run('sudo', ['-n', 'dpkg', '--remove', 'agent-purge']);
    debInstalled = false;
    assert.equal(existsSync('/usr/bin/agent-purge'), false);
    pass('debian-system-install-run-remove');
  }

  const imageName = `${stem}.AppImage`;
  if (manifest.files[imageName]) {
    const image = verify(imageName);
    chmodSync(image, 0o755);
    // Execute without requiring FUSE; extraction remains in the isolated temp tree.
    run(image, ['--appimage-extract']);
    await smoke(join(root, 'squashfs-root', 'AppRun'), [], { cwd: root, version, withoutNode: true });
    pass('appimage-native-apprun-and-web');
  }
  const reportDir = join(source, 'out', 'linux-acceptance');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `${arch}.json`), JSON.stringify({ version, arch, ok: true, checks }, null, 2) + '\n');
} finally {
  if (debInstalled) run('sudo', ['-n', 'dpkg', '--remove', 'agent-purge']);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
