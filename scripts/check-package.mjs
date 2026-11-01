// Install the actual tarball offline into a fresh prefix, never the user's global npm.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCommand } from '../lib/spawn.mjs';
import { isolatedEnv } from '../lib/environment.mjs';
import { smoke } from './build-smoke.mjs';
import { checkDocumentationLinks, publicationProblem } from './check-repo.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(source, 'out', 'package');
const sandbox = mkdtempSync(join(tmpdir(), 'ap-package-'));
const env = { ...isolatedEnv(sandbox), npm_config_cache: join(sandbox, 'npm-cache') };
const npm = (args, cwd = source) => {
  const d = prepareCommand('npm', args, { cwd, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  const result = spawnSync(d.cmd, d.args, d.opts);
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
};
try {
  mkdirSync(output, { recursive: true });
  const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', output]));
  const names = packed.files.map(f => f.path);
  assert.ok(names.includes('lib/templates/personas/neutral.md'));
  for (const file of names) assert.doesNotMatch(file, /^(?:personas|out|dist|node_modules|\.tmp|\.pi)\//);
  for (const file of packed.files) assert.equal(publicationProblem(file.path, { distribution: true, size: file.size }), null, file.path);
  const prefix = join(sandbox, '安装 space');
  npm(['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', join(output, packed.filename)], sandbox);
  const installed = join(prefix, 'node_modules', 'agent-purge');
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, packed.version);
  assert.deepEqual(checkDocumentationLinks(names, installed), [], '实际安装包里的文档链接必须可用');
  await smoke(process.execPath, [join(installed, 'bin', 'agent-purge.mjs')], { cwd: prefix, version: packed.version });
  console.log(`npm tarball installed offline and verified: ${packed.filename}`);
} finally { rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
