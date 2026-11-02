#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataHome } from '../lib/home.mjs';

console.log('=== DSH 真实环境深度净化与运行时实测 ===\n');

// 1. 实测真实已安装的 desktop 插件
const desktopPluginPath = 'C:/Users/27783/.dsh/profiles/desktop/node_modules/agent-purge/index.js';
console.log(`[1/5] 读取真实 desktop profile 插件: ${desktopPluginPath}`);
const plugin = (await import(pathToFileURL(desktopPluginPath).href + '?t=' + Date.now())).default;
assert.equal(plugin.name, 'agent-purge', '插件名称必须为 agent-purge');
assert.deepEqual(plugin.inject, ['systemPrompt'], '必须注入 systemPrompt');
console.log('  ✓ 插件导出典范，元数据校验通过');

// 2. 模拟真实 Cordis 宿主并挂载
console.log('[2/5] 模拟 Cordis 宿主生命周期，注册 approval 钩子与 systemPrompt 瀑布');
const hooks = {};
let asm = {
  sections: [
    { name: 'host', text: 'HOST_PROMPT_SECTION' },
    { name: 'dsh-experimental-session-mnemon', text: 'REAL_11KB_MEMORY_CACHE_CONTENT_'.repeat(300) },
    { name: 'dsh-repeat-tool-reminder', text: 'REPEAT_TOOL_REMINDER_NOISE' },
    { name: 'other-normal-section', text: 'NORMAL_HOST_GUIDANCE' }
  ],
  contexts: [
    { name: 'working_directory', text: 'H:/WorkSpace/agent-purge' },
    { name: 'approval:policy', text: 'RESTRICTED_TOOL_POLICY' },
    { name: 'sandbox:policy', text: 'FS_FENCE_ENFORCED' }
  ]
};
const ctx = {
  systemPrompt: { assemble: () => asm },
  on(evt, handler, opts) {
    hooks[evt] = { handler, opts };
  }
};
plugin.apply(ctx);
assert.ok(hooks['approval/request'], '必须挂载 approval/request 钩子');
assert.equal(hooks['approval/request'].opts?.prepend, true, 'approval/request 必须以 prepend 优先接管');
console.log('  ✓ approval/request 钩子成功 prepend 挂载');

// 临时写入状态验证
const statePath = join(dataHome(), 'state.json');
const origStateText = readFileSync(statePath, 'utf8');
const activePersonaPath = join(dataHome(), 'personas', 'active.md');
const origPersonaText = readFileSync(activePersonaPath, 'utf8');

try {
  // 设置测试人设
  writeFileSync(activePersonaPath, 'VERIFY_DSH_DEEP_PURGE_TEST_PERSONA');

  // A. strict 模式实测
  console.log('[3/5] 实测 strict 模式（深度净化与审批免密）');
  let st = JSON.parse(origStateText);
  st.armed = { ...st.armed, dsh: ['install'] };
  st.dshRuntime = { ...st.dshRuntime, desktop: { enabled: true, mode: 'strict' } };
  writeFileSync(statePath, JSON.stringify(st, null, 2));

  // 验证 approval 自动放行
  const approvalResStrict = hooks['approval/request'].handler({ toolName: 'bash' }, () => 'denied');
  assert.equal(approvalResStrict, 'allowed-once', 'strict 模式下工具调用必须自动免密放行');
  console.log('  ✓ approval/request 自动返回 allowed-once（免除人工确认弹窗）');

  // 验证 assemble 深度净化
  const assembleResStrict = await hooks['system-prompt/assemble'].handler(asm, {}, async () => asm);
  assert.equal(assembleResStrict.sections.some(s => s.name.includes('mnemon')), false, 'mnemon 记忆噪音必须被剥离');
  assert.equal(assembleResStrict.sections.some(s => s.name.includes('repeat-tool-reminder')), false, '重复工具提醒必须被剥离');
  const strictPurgeSec = assembleResStrict.sections.find(s => s.name === 'agent-purge');
  assert.ok(strictPurgeSec, '必须包含 agent-purge 提示词');
  assert.equal(strictPurgeSec.order, -100000, 'order 必须置顶为 -100000');
  assert.equal(strictPurgeSec.interpolate, false, 'interpolate 必须为 false（免疫双花括号崩溃）');
  assert.equal(strictPurgeSec.complete, true, 'strict 下 complete 必须为 true（触发官方清空宿主提示词）');
  assert.deepEqual(assembleResStrict.contexts, [], 'strict 模式下 contexts 策略上下文必须全部清空');
  console.log('  ✓ 记忆噪音剥离、完整提示词置顶 (-100000)、双花括号免疫、contexts 清空全数通过');

  // B. replace 模式实测
  console.log('[4/5] 实测 replace 模式（选择性过滤与策略上下文剔除）');
  st.dshRuntime.desktop.mode = 'replace';
  writeFileSync(statePath, JSON.stringify(st, null, 2));

  const assembleResReplace = await hooks['system-prompt/assemble'].handler(asm, {}, async () => asm);
  assert.equal(assembleResReplace.sections.some(s => s.name.includes('mnemon')), false, 'replace 下同样剥离 mnemon');
  assert.equal(assembleResReplace.sections.some(s => s.name === 'other-normal-section'), true, '正常宿主 section 保留');
  assert.equal(assembleResReplace.contexts.some(c => c.name === 'working_directory'), true, 'working_directory 上下文保留');
  assert.equal(assembleResReplace.contexts.some(c => c.name === 'approval:policy'), false, 'approval:policy 策略上下文必须剔除');
  assert.equal(assembleResReplace.contexts.some(c => c.name === 'sandbox:policy'), false, 'sandbox:policy 策略上下文必须剔除');
  console.log('  ✓ replace 模式保留正常工作区上下文，精准剔除限制性安全策略');

  // C. off 模式实测
  console.log('[5/5] 实测 off 模式（干净旁路与零残留复原）');
  st.dshRuntime.desktop.enabled = false;
  writeFileSync(statePath, JSON.stringify(st, null, 2));

  const approvalResOff = hooks['approval/request'].handler({ toolName: 'bash' }, () => 'delegated_to_native');
  assert.equal(approvalResOff, 'delegated_to_native', 'off 模式下审批必须退回调用原生 next()');
  const assembleResOff = await hooks['system-prompt/assemble'].handler(asm, {}, async () => asm);
  assert.equal(assembleResOff.sections.some(s => s.name === 'agent-purge'), false, 'off 模式下不得包含 agent-purge 注入');
  console.log('  ✓ off 模式完全旁路，无任何残留');

} finally {
  // 恢复原始文件
  writeFileSync(statePath, origStateText);
  writeFileSync(activePersonaPath, origPersonaText);
}

// 6. 验证 DSH 真实可执行程序与 CLI 启动
console.log('\n=== DSH CLI 与进程级实测 ===');
const dshBin = 'D:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd';

const ver = spawnSync(dshBin, ['--version'], { encoding: 'utf8', shell: true });
assert.equal(ver.status, 0, 'dsh --version 必须退出 0');
console.log(`  ✓ dsh --version: ${ver.stdout.trim()}`);

const dumpHeadless = spawnSync(dshBin, ['--profile', 'headless', '--dump-config'], { encoding: 'utf8', shell: true });
assert.equal(dumpHeadless.status, 0, 'headless dump-config 必须成功');
console.log('  ✓ dsh --profile headless --dump-config 验证通过');

const webHelp = spawnSync(dshBin, ['web', '--help'], { encoding: 'utf8', shell: true });
assert.equal(webHelp.status, 0, 'dsh web --help 必须退出 0');
console.log('  ✓ dsh web 命令入口完整可用');

console.log('\n>>> 结论：DSH headless / web / desktop 插件逻辑与真实二进制实测全部通过！ <<<');
