// Discover top-level unit tests so adding a regression cannot silently omit it from CI.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const legacy = ['test/magpie/hooks.test.mjs', 'test/magpie/page.test.mjs', 'test/harness-adapters.test.mjs', 'test/regressions.test.mjs'];
const files = readdirSync(resolve(root, 'test')).filter(file => file.endsWith('.test.mjs') && !legacy.includes(`test/${file}`)).sort().map(file => `test/${file}`);
for (const args of [...legacy.map(file => [file]), ['--test', ...files]]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 180000 });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}
