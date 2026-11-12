import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isolatedEnv } from '../../lib/environment.mjs';

// Every real browser test owns a fresh server/HOME. No real harness, token or user profile.
const test = base.extend({
  app: async ({}, use) => {
    const root = mkdtempSync(join(tmpdir(), 'ap-browser-'));
    const env = { ...isolatedEnv(root), PATH: '', Path: '' };
    // Detection fixtures are configuration markers, never real host executables.
    mkdirSync(join(env.PI_CODING_AGENT_DIR, 'extensions'));
    writeFileSync(join(env.CODEX_HOME, 'config.toml'), '# user config\n');
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), '{}');
    const child = spawn(process.execPath, [resolve('bin/agent-purge.mjs'), '--serve', '0'], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise(resolve => child.once('close', resolve));
    let output = '';
    try {
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Server timeout: ${output}`)), 15000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
        child.stderr.on('data', data => { output += data; });
        child.stdout.on('data', data => {
          output += data;
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) { clearTimeout(timer); resolve(match[0]); }
        });
      });
      await use({ url, root, env });
    } finally {
      if (child.exitCode === null) child.kill();
      await closed;
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  page: async ({ page, app }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Update checks stay offline. Everything else goes to the real isolated server.
    await page.route('**/api/update*', route => route.fulfill({
      json: { ok: true, current: '0.2.23', latest: '0.2.23', hasUpdate: false },
    }));
    await page.goto(app.url);
    await expect(page.locator('#connection')).toContainText('已连接');
    await use(page);
    expect(errors, 'browser runtime exceptions').toEqual([]);
  },
});

const selectTool = async (page, id) => {
  await page.locator(`.target-row[data-id="${id}"]`).click();
  await expect(page.locator(`#panel-${id}`)).toBeVisible();
};

test('issues #1/#6: fresh defaults save without toggling modes; legacy deep link works', async ({ page, app }) => {
  await expect(page.locator('#apply')).toBeEnabled();
  await expect(page.locator('[name=mode][value=replace]')).toBeChecked();
  await page.locator('#apply').click();
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('#notice')).toContainText('已应用');
  await page.goto(`${app.url}/#personas`);
  await expect(page.locator('#page-library')).toBeVisible();
  await page.getByRole('button', { name: /中性模板/ }).click();
  await expect(page.locator('#edit-desc')).toHaveValue(/起步/);
  await expect(page.locator('#edit-body')).not.toHaveValue('');
  await page.getByRole('button', { name: '控制台', exact: true }).click();
  await page.locator('#launch-settings summary').click();
  await page.locator('#default-harness').selectOption('codex');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#default-summary')).toHaveText('Codex');
  const state = JSON.parse(readFileSync(join(app.env.AGENT_PURGE_HOME, 'state.json'), 'utf8'));
  expect(state.default.harness).toBe('codex');
  expect(state.default.mode).toBe('replace');
});

test('reload twice keeps the local service alive (pagehide must not kill it)', async ({ page, app }) => {
  // 回归：pagehide 曾经直发 /api/exit，浏览器里刷新一两次服务就没了，页面显示"本地服务未连接"。
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await expect(page.locator('#connection')).toContainText('已连接');
  }
  const response = await page.request.get(`${app.url}/api/state`);
  expect(response.status()).toBe(200);
});

test('draft refresh, keyboard update action, unsaved navigation and metadata preservation', async ({ page, app }) => {
  await page.locator('[name=mode][value=append]').check();
  await page.locator('#refresh').click();
  await expect(page.locator('[name=mode][value=append]')).toBeChecked();
  await expect(page.locator('#version-badge')).toBeEnabled();
  await page.locator('#version-badge').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#notice')).toContainText('已是最新版本');
  await page.locator('#edit-current').click();
  await page.locator('#edit-body').fill('DRAFT <img src=x onerror=alert(1)>');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '控制台', exact: true }).click();
  await expect(page.locator('#page-library')).toBeVisible();
  await page.locator('#refresh').click();
  await expect(page.locator('#edit-body')).toHaveValue('DRAFT <img src=x onerror=alert(1)>');
  await page.locator('#save-persona').click();
  await expect(page.locator('#editor-status')).toHaveText('已保存');
  const persona = readFileSync(join(app.env.AGENT_PURGE_HOME, 'personas', 'neutral.md'), 'utf8');
  expect(persona).toMatch(/harness:/);
  expect(persona).toMatch(/order:\s*1/);
  expect(persona).toContain('DRAFT <img');
});

test('pause, resume and clean preserve user personas and roll back managed rules', async ({ page, app }) => {
  await selectTool(page, 'pi');
  await page.locator('[data-toggle=pi]').check();
  await expect(page.locator('[data-toggle=pi]')).toBeChecked();
  await page.locator('#power').click();
  await expect(page.locator('#power-status')).toHaveText('已暂停');
  await expect(page.locator('[data-toggle=pi]')).toBeChecked();
  await page.locator('#power').click();
  await expect(page.locator('#power-status')).toHaveText('配置启用');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#disarm-all').click();
  await expect(page.locator('#notice')).toContainText('人设和用户修改已保留');
  await expect(page.locator('[data-toggle=pi]')).not.toBeChecked();
  expect(readFileSync(join(app.env.AGENT_PURGE_HOME, 'personas', 'neutral.md'), 'utf8')).toContain('中性模板');
});

test('verification badges distinguish no request, process error, off success and actual marker miss', async ({ page }) => {
  let record = { harness: 'dsh', version: 'fixture', status: 'no-request', scope: { kind: 'isolated-cli', profile: 'headless' }, modes: [] };
  await page.route('**/api/verification', route => route.fulfill({ json: { report: { at: '2026-11-02T00:00:00Z', results: [record] } } }));
  await page.locator('#refresh').click();
  await page.locator('#show-all').check();
  await selectTool(page, 'dsh');
  const drawer = page.locator('.tool-panel');
  await expect(drawer).toContainText('没抓到请求');
  await expect(drawer).not.toContainText('实测未命中');
  await expect(drawer).toContainText('headless');
  await expect(drawer).toContainText('不代表当前会话');
  record = { ...record, status: 'error', reason: 'fixture startup failed' };
  await page.locator('#refresh').click();
  await expect(drawer).toContainText('运行出错');
  await expect(drawer).toContainText('fixture startup failed');
  record = { ...record, status: 'captured', reason: null, modes: [{ mode: 'off', status: 'captured', exitCode: 0, requests: [{ roles: ['system'], markerCount: 0 }] }] };
  await page.locator('#refresh').click();
  await expect(drawer).toContainText('暂停干净');
  record = { ...record, status: 'mismatch', modes: [{ ...record.modes[0], mode: 'replace', status: 'mismatch' }] };
  await page.locator('#refresh').click();
  await expect(drawer).toContainText('请求未命中');
});
test('rule files page writes, identifies persona, supports global scope and removes cleanly', async ({ page, app }) => {
  await page.getByRole('button', { name: '规则文件', exact: true }).click();
  await expect(page.locator('#project-title')).toHaveText('规则文件');
  await expect(page.locator('#project-scope-desc')).toContainText('append');
  const card = page.locator('.project-card').filter({ hasText: 'AGENTS.md' });
  await expect(card).toContainText('写入此项目');
  await card.locator('.project-diff summary').click();
  await expect(card.locator('.project-diff pre')).toContainText('+ # >>> agent-purge');
  await page.locator('.project-coverage summary').click();
  await expect(page.locator('.project-coverage-list')).toContainText('Claude Code');
  await card.getByRole('button', { name: '写入此项目' }).click();
  await expect(card.locator('.chip')).toHaveText('已写入 · 中性模板');
  await expect(page.locator('.project-history')).toContainText('写入');
  await expect(card.locator('.project-after')).toBeVisible();
  const file = join(app.root, 'AGENTS.md');
  expect(readFileSync(file, 'utf8')).toContain('# >>> agent-purge');
  await card.getByRole('button', { name: '移除', exact: true }).click();
  await expect(card.locator('.chip')).toHaveText('未写入');

  await page.locator('[name="rule-scope"][value="global"]').check();
  const piGlobal = page.locator('.project-card').filter({ hasText: 'AGENTS.md (Pi)' });
  await expect(piGlobal).toContainText('写入全局文件');
  await piGlobal.getByRole('button', { name: '写入全局文件' }).click();
  await expect(piGlobal.locator('.chip')).toHaveText('已写入 · 中性模板');
  const globalFile = join(app.env.PI_CODING_AGENT_DIR, 'AGENTS.md');
  expect(readFileSync(globalFile, 'utf8')).toContain('# >>> agent-purge');
  await piGlobal.getByRole('button', { name: '移除', exact: true }).click();
  await expect(piGlobal.locator('.chip')).toHaveText('未写入');
});
test('rules-only project file writes without an owner selector', async ({ page, app }) => {
  await page.getByRole('button', { name: '规则文件', exact: true }).click();
  const card = page.locator('.project-card').filter({ hasText: '.clinerules' });
  await expect(card).toContainText('写入此项目');
  await card.getByRole('button', { name: '写入此项目' }).click();
  await expect(card.locator('.chip')).toHaveText('已写入 · 中性模板');
  const file = join(app.root, '.clinerules');
  expect(readFileSync(file, 'utf8')).toContain('# >>> agent-purge');
  await card.getByRole('button', { name: '移除', exact: true }).click();
  await expect(card.locator('.chip')).toHaveText('未写入');
  expect(existsSync(file)).toBe(false);
});



for (const width of [1440, 768, 390, 320]) {
  test(`responsive ${width}px: no page overflow; accessible console/library/project/diagnostics`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, route] of [['控制台', 'console'], ['人设库', 'library'], ['规则文件', 'project'], ['测试与记录', 'diagnostics']]) {
      await page.getByRole('button', { name, exact: true }).click();
      if (route === 'library') await page.getByRole('button', { name: /中性模板/ }).click();
      await expect(page.locator(`#page-${route}`)).toBeVisible();
      const sizes = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
      expect(sizes.content, `${route} overflow at ${width}px`).toBeLessThanOrEqual(sizes.viewport);
      if (width === 1440 || width === 390) {
        await page.screenshot({ path: testInfo.outputPath(`${route}-${width}.png`), fullPage: true });
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        expect(results.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
      }
    }
  });
}
