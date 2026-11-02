import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installWorkbuddyPrompt, uninstallWorkbuddyPrompt, workbuddySettingsFile } from '../lib/workbuddy.mjs';

console.log('=== WorkBuddy 身份上下文注入验证（隔离 settings 副本） ===');
const originalHome = process.env.WORKBUDDY_CONFIG_DIR;
const originalData = process.env.AGENT_PURGE_HOME;
const dir = mkdtempSync(join(tmpdir(), 'ap-workbuddy-settings-'));
const data = mkdtempSync(join(tmpdir(), 'ap-workbuddy-data-'));
process.env.WORKBUDDY_CONFIG_DIR = dir;
process.env.AGENT_PURGE_HOME = data;
const file = workbuddySettingsFile();
writeFileSync(file, JSON.stringify({ personalization: { customPrompt: 'keep me' } }, null, 2) + '\n');

try {
	const marker = `AP_WORKBUDDY_SETTINGS_VERIFIED_${Date.now()}`;
	const installed = installWorkbuddyPrompt(data, {
		personaText: `You are a test persona. Marker: ${marker}.`,
		mode: 'replace',
	});
	console.log(`[1] install: ${installed.status} (${installed.chars} chars)`);
	const prompt = JSON.parse(readFileSync(file, 'utf8')).personalization?.customPrompt ?? '';
	if (!prompt.includes(marker) || !prompt.includes('# >>> agent-purge:workbuddy')) {
		throw new Error('断言失败：settings.json customPrompt 未包含托管块或 marker');
	}
	console.log('✓ settings.json customPrompt 已写入身份上下文');

	const restored = uninstallWorkbuddyPrompt(data);
	const after = JSON.parse(readFileSync(file, 'utf8')).personalization?.customPrompt ?? null;
	if (after !== 'keep me') throw new Error(`致命错误：customPrompt 未恢复为原值（${after}）`);
	console.log(`[2] uninstall: ${restored.status}; customPrompt 原值已恢复`);
} finally {
	if (originalHome === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
	else process.env.WORKBUDDY_CONFIG_DIR = originalHome;
	if (originalData === undefined) delete process.env.AGENT_PURGE_HOME;
	else process.env.AGENT_PURGE_HOME = originalData;
	rmSync(dir, { recursive: true, force: true });
	rmSync(data, { recursive: true, force: true });
}
console.log('\n=== WorkBuddy settings 身份上下文接管实测通过；模型回复需在桌面端新任务确认 ===');
