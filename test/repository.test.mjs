import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocumentationLinks, publicationProblem } from '../scripts/check-repo.mjs';

test('publication policy keeps source/tests but excludes personal data and generated output', () => {
  for (const file of ['README.md','test/safety.test.mjs','lib/templates/personas/neutral.md','web/assets/agent-purge.ico','package-lock.json','.env.example'])
    assert.equal(publicationProblem(file), null, file);
  for (const file of ['out/requests.json','.pi/local.json','.opencode/package.json','node_modules/x/index.js',
    'personas/private.md','state.json','.env','.env.local','packaging/launcher.exe','web/shots/wip.png','docs/evidence/local.json','download.tgz'])
    assert.ok(publicationProblem(file), file);
  for (const file of ['test/release.test.mjs','scripts/test.mjs','magpie-plugin/hooks.js','package-lock.json'])
    assert.ok(publicationProblem(file, { distribution: true }), file);
  assert.equal(publicationProblem('magpie-plugin/README.md', { distribution: true }), null);
});
test('local documentation links must target published files and real heading anchors', () => {
  const root = mkdtempSync(join(tmpdir(), 'ap-doc-links-'));
  try {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'README.md'), '[guide](docs/usage.md#暂停撤销和卸载)\n');
    writeFileSync(join(root, 'docs/usage.md'), '# 使用指南\n\n## 暂停、撤销和卸载\n');
    assert.deepEqual(checkDocumentationLinks(['README.md','docs/usage.md'], root), []);
    assert.equal(checkDocumentationLinks(['README.md'], root).length, 1, '存在磁盘但未发布的目标也应失败');
    writeFileSync(join(root, 'README.md'), '[bad](docs/usage.md#不存在)\n');
    assert.equal(checkDocumentationLinks(['README.md','docs/usage.md'], root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('README shows a disclaimer section and keeps the full statement in sync with its document', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const legal = readFileSync(new URL('../docs/LEGAL.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const expected = legal.replace(/^# 免责与合规声明\n+/, '').trimEnd()
    .replace(/^## /gm, '### ').replaceAll('](../LICENSE)', '](LICENSE)');
  assert.match(readme, /^## 免责与合规声明$/m);
  const embedded = readme.match(/<!-- legal-body:start -->\n([\s\S]*?)\n<!-- legal-body:end -->/);
  assert.ok(embedded, 'README 必须包含可展开的完整声明，不能只剩外链');
  assert.equal(embedded[1], expected, 'README 与独立声明文档不能各说各话');
});
