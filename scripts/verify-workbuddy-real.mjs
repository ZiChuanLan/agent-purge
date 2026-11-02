import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTemplatesDir, installWorkbuddy, uninstallWorkbuddy } from '../lib/workbuddy.mjs';

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

console.log('=== WorkBuddy 真实环境探测与注入验证 ===');
const tplDir = findTemplatesDir();
console.log(`Detected Templates Directory: ${tplDir}`);

if (!tplDir) {
  console.error('未在系统中找到 WorkBuddy 安装目录！');
  process.exit(1);
}

const mainTpl = join(tplDir, 'workbuddy-prompt.tpl');
const originalContent = readFileSync(mainTpl, 'utf8');
const originalSha = sha(originalContent);
console.log(`Original workbuddy-prompt.tpl SHA256: ${originalSha}`);

const TEST_MARKER = 'AP_WORKBUDDY_SYS_INJECTION_VERIFIED_' + Date.now();
const testPersona = `You are a Pure Autonomous Agent. Marker: ${TEST_MARKER}.`;

console.log('\n[1] 执行 strict 模式安装...');
const instRes = installWorkbuddy(undefined, {
  personaText: testPersona,
  mode: 'strict',
  templatesDir: tplDir,
});
console.log(`Installed: touched ${instRes.touched.length} templates.`);

// 读取修改后的模板
const modifiedContent = readFileSync(mainTpl, 'utf8');
const modifiedSha = sha(modifiedContent);
console.log(`Modified SHA256: ${modifiedSha}`);

// 断言
if (!modifiedContent.includes(TEST_MARKER)) {
  throw new Error('断言失败：修改后的模板未包含 Marker！');
}
if (modifiedContent.includes('You are WorkBuddy')) {
  throw new Error('断言失败：strict 模式未清空 WorkBuddy 宿主身份！');
}
console.log('✓ strict 模式断言成功：宿主身份已清空，Marker 已成功植入系统模板！');

console.log('\n[2] 执行卸载还原...');
const uninstRes = uninstallWorkbuddy(undefined, { templatesDir: tplDir });
console.log(`Uninstalled: restored ${uninstRes.restored.length} templates.`);

const restoredContent = readFileSync(mainTpl, 'utf8');
const restoredSha = sha(restoredContent);
console.log(`Restored SHA256: ${restoredSha}`);

if (restoredSha !== originalSha) {
  throw new Error(`致命错误：还原后的 SHA256 (${restoredSha}) 与原始 (${originalSha}) 不一致！`);
}
console.log('✓ 卸载还原验证成功：原字节 100% 逐位一致！');
console.log('\n=== WorkBuddy 模板级接管实测全部通过！ ===');
