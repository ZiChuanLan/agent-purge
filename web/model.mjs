export const MODE_LABELS = { strict: '只留人设', replace: '换身份', append: '追加', off: '暂停' };
export const CAPTURE_LABELS = { captured: '已捕获', passed: '已验证', partial: '部分完成', blocked: '受阻', missing: '未找到入口', unavailable: '未找到入口', error: '出错', mismatch: '不符合预期', 'no-request': '未捕获请求', 'not-tested': '未实测' };
export const CHANNEL_LABELS = { install: '常驻配置（全局）', shim: '命令入口（进程接管）', slash: '会话内切换（热切）', project: '本项目（项目规则文件）' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const personaName = persona => persona?.meta?.name || persona?.id || '未选择';
export function configurationOf(state) {
  return { persona: state.active ?? '', mode: state.paused ? state.prevMode || 'replace' : state.defaults?.mode || 'replace' };
}
export const changed = (draft, base) => JSON.stringify(draft) !== JSON.stringify(base);
export const needsApply = (state, draft, base) => state.defaultsSet === false || changed(draft, base);
export function sortedHarnesses(state, showAll = false) {
  const selected = h => (h.armed?.length ?? 0) > 0;
  // 不可注入的家不进接管列表；「显示本机未装的」也不放它进来
  return [...(state.harnesses ?? [])]
    .filter(h => h.caps?.injectable !== false)
    .filter(h => showAll || selected(h) || h.found || h.homeExists)
    .sort((a, b) => Number(selected(b)) - Number(selected(a)) || Number(b.found) - Number(a.found) || a.id.localeCompare(b.id));
}
export function effectLabel(harness, paused = false, dshRuntime = null) {
  const name = harness.id ?? '这个执行器';
  const on = (harness.armed?.length ?? 0) > 0;
  if (on && paused) return '总电源已暂停：配置保留，恢复后按原范围应用';
  if (on && (harness.mode === 'off' || ['harness-off', 'harness-disabled'].includes(harness.activation?.blockedBy))) return '这家已关闭：全局恢复也不会自动启用';
  if (!on) return harness.found || harness.homeExists ? '' : '本机没装，装好后再回来开';
  // dsh 的 /purge off|mode 是 profile 级的（dshRuntime.<profile>），总开关开着也可能某形态被暂停
  if (harness.id === 'dsh' && dshRuntime) {
    const states = Object.entries(dshRuntime).filter(([, v]) => v && typeof v === 'object');
    const off = states.filter(([, v]) => v.enabled === false);
    const profiles = harness.profiles || ['desktop', 'web', 'headless', 'sdk'];
    if (profiles.length && profiles.every(p => dshRuntime[p]?.enabled === false)) return 'dsh 已选形态均被 /purge off 暂停；在对应形态执行 /purge on 恢复';
    if (off.length) return `dsh 这些形态被 /purge off 暂停：${off.map(([p]) => p).join('、')}；未列出的形态尚未确认`;
  }
  const dynamic = harness.caps?.hot;
  if (dynamic?.ok && harness.armed.includes(dynamic.needs)) {
    if (dynamic.needs === 'slash' && harness.auto !== true) return `扩展已选择：重新加载 ${name} 后执行 /purge on；当前会话尚未确认`;
    return '动态通道已选择：已加载插件下一轮读取，首次安装或代码更新需重启；当前会话尚未确认';
  }
  if (harness.projectOn && harness.armed.includes('project')) return '项目规则已登记：其他原生执行器也可能读取同名文件；对应目录的新会话读取';
  if (harness.armed.includes('install')) return `配置已选择：新开的 ${name} 读取；现有会话尚未确认`;
  if (harness.armed.includes('slash')) return `在 ${name} 里执行 /purge on 后启用；当前会话尚未确认`; 
  return `已接管命令：在终端敲 ${name} 时自动注入`; 
}
/** 标题下那一行：说清谁在被接管，而不是只报个数。 */
export function scopeSummary(state) {
  const ids = Object.entries(state.armed ?? {}).filter(([, channels]) => channels?.length).map(([id]) => id);
  if (state.paused) return ids.length ? `已暂停，这些执行器的配置还留着：${ids.join('、')}` : '已暂停，暂时没有执行器在用这份人设';
  if (!ids.length) return '选择要管理的执行器；写入通道后，按详情提示检查生效时机。';
  return `已选择 ${ids.length} 个执行器：${ids.join('、')}；实际生效看各自状态`;
}
