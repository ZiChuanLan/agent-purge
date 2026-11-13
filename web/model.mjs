export const MODE_LABELS = { strict: '只留人设', replace: '替换身份', append: '末尾追加', off: '暂停' };
export const MODE_DESCRIPTIONS = {
  replace: '保留原厂代码规范与工具定义，只把助手对自己的认知换成人设。多数工具推荐。',
  strict: '把可控入口的原厂系统指令一起压掉，让人设优先。各家能压的范围不同。',
  append: '原厂系统提示词原样保留，在末尾补一段人设。写入型工具只能这样做。',
  off: '暂停对这个工具的注入，已有本地配置保留。'
};
/**
 * 某家 harness 实际生效的模式集合。
 * matrix.json 里 `modes` 显式声明过就只认它（off=暂停永远可用）；
 * 没声明 = 四种都可用。`preferredMode` 是实测首选，UI 只做高亮，不限制。
 */
/**
 * 宿主给的入口分两档：真能整段替换 system prompt 的，和只能把文本追加进去的。
 * append/partial 两档要明说「内置身份仍在」，否则用户在 antigravity 这类家上
 * 选了「只留人设」却拿到追加效果，就是虚假宣传。
 */
const PURGE_NOTES = {
  append: '这家没有整段 system prompt 入口：人设是追加进去的，内置身份仍在提示词里。',
  partial: '替换生效，但宿主仍会前置自己的身份句。',
  unverified: '这家还没有系统提示词字数的实测，不声称已净化。',
};
export const purgeNoteOf = (harness) => PURGE_NOTES[harness?.purgeKind] ?? null;
export function modeAvailability(harness) {
  const declared = Array.isArray(harness?.modes) && harness.modes.length ? harness.modes : null;
  const supported = declared ? new Set([...declared, 'off']) : new Set(Object.keys(MODE_LABELS));
  return {
    supported,
    limited: Boolean(declared),
    preferred: harness?.preferredMode ?? null,
    note: harness?.modesNote ?? (declared ? `这家只支持：${declared.map(m => MODE_LABELS[m] || m).join(' / ')}` : null),
    purgeKind: harness?.purgeKind ?? 'replace',
    purgeNote: purgeNoteOf(harness),
  };
}
/** 这批执行器里，哪些根本不认这个模式（全局三选一与各家下拉共用同一份判断） */
export const unsupportedHarnesses = (list, mode) => (list || []).filter(h => !modeAvailability(h).supported.has(mode));
export const CAPTURE_LABELS = { captured: '已捕获请求', passed: '验证通过', partial: '部分通过', blocked: '接入受阻', missing: '未发现入口', unavailable: '未发现入口', error: '检测异常', mismatch: '不符合预期', 'no-request': '未捕获请求', 'not-tested': '未测试' };
export const CHANNEL_LABELS = { install: '配置写入', shim: '启动命令', slash: '会话插件', project: '项目规则' };
export const HARNESS_TITLES = {
  'workbuddy-ai': 'WorkBuddy 国际版',
  'workbuddy': 'WorkBuddy',
  'pi-desktop': 'PI-Desktop',
  'opencode2': 'OpenCode 2.x',
  'codebuddy': 'CodeBuddy',
  'claude': 'Claude Code',
  'antigravity': 'Antigravity',
  'codex': 'Codex',
  'grok': 'Grok',
  'kilo': 'Kilo Code',
  'hermes': 'Hermes',
  'opencode': 'OpenCode',
  'pi': 'Pi',
  'dsh': 'dsh',
  'omp': 'omp',
  'zcode': 'ZCode',
  cursor: 'Cursor',
  devin: 'Devin CLI',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot CLI',
  amp: 'Amp',
  cline: 'Cline',
  roo: 'Roo Code',
  crush: 'Crush',

  continue: 'Continue CLI',
  qoder: 'Qoder CLI',
  kimi: 'Kimi Code',
  auggie: 'Auggie CLI',
  goose: 'Goose',
  qwen: 'Qwen Code',
  kiro: 'Kiro CLI',
};
export const harnessTitle = id => HARNESS_TITLES[id] || id;
export const HARNESS_PURGE_EFFECTS = {
  workbuddy: {
    channelType: 'config',
    typeLabel: '配置接管',
    safetyLevel: 'safe',
    items: [
      '按模板剥离「You are WorkBuddy」等产品身份行（未抓包测字数）',
      '收起内容政策与强制拒答条款',
      '收起高危目录的递归操作禁令',
      '同步 app-config.json 里的自定义指令',
      '改动前留原字节快照，关闭时逐位还原'
    ]
  },
  'workbuddy-ai': {
    channelType: 'config',
    typeLabel: '配置接管',
    safetyLevel: 'safe',
    items: [
      '按模板剥离「You are WorkBuddy」等产品身份行（未抓包测字数）',
      '收起内容政策与强制拒答条款',
      '收起高危目录的递归操作禁令',
      '同步 app-config.json 里的自定义指令',
      '改动前留原字节快照，关闭时逐位还原'
    ]
  },
  dsh: {
    channelType: 'slash',
    typeLabel: '插件',
    safetyLevel: 'hot',
    items: [
      '收起审批与请求拦截的额外提示',
      '去掉记忆与上下文噪音',
      '去掉 {{model}} 模板前缀，避免宿主变量二次污染',
      '只走内存 Hook，不解包、不改 app.asar',
      '/purge on / off 即时切换'
    ]
  },
  codebuddy: {
    channelType: 'shim',
    typeLabel: '启动命令',
    safetyLevel: 'shim',
    items: [
      '去掉约 1.7 万字的原厂合规与安全说教',
      '用 --system-prompt-file 重建系统提示词',
      '不落地改文件，关闭时撤除命令别名'
    ]
  },
  antigravity: {
    channelType: 'config',
    typeLabel: '配置接管',
    safetyLevel: 'safe',
    items: [
      '托管全局 AGENTS.md，不用手动挂载',
      '人设以 <user_rules> 追加：内置 <identity> 仍在系统提示词里，不是替换',
      '改动前留原字节快照，关闭时自动还原'
    ]
  },
  pi: {
    channelType: 'slash',
    typeLabel: '扩展',
    safetyLevel: 'hot',
    items: [
      '每轮对话前改写系统提示词',
      '/purge off 立即撤回，并清掉会话里残留的托管块',
      '不写磁盘，只在当前会话生效'
    ]
  },
  'pi-desktop': {
    channelType: 'slash',
    typeLabel: '插件',
    safetyLevel: 'hot',
    items: [
      '以 imported 插件接入，同一会话可换人设',
      '/purge off 恢复宿主原生状态'
    ]
  },
  omp: {
    channelType: 'slash',
    typeLabel: '扩展',
    safetyLevel: 'hot',
    items: [
      '每轮对话前改写系统提示词',
      '/purge on / off 会话内切换',
      '关闭后过滤残留的托管块'
    ]
  },
  claude: {
    channelType: 'shim',
    typeLabel: '启动命令',
    safetyLevel: 'shim',
    items: [
      '用 --system-prompt-file 替换系统提示词（不打二进制补丁时仍残留 62 字身份句）',
      '保留 ~/.claude/CLAUDE.md 与项目规则'
    ]
  },
  hermes: {
    channelType: 'shim',
    typeLabel: '启动命令',
    safetyLevel: 'shim',
    items: [
      '用 --ignore-rules 绕开内置规范',
      '托管 ~/.hermes/SOUL.md，可无损还原'
    ]
  },
  opencode: {
    channelType: 'slash',
    typeLabel: '插件',
    safetyLevel: 'hot',
    items: [
      '插件在每轮组装时改写系统提示词',
      '跟随当前人设，下一轮生效'
    ]
  },
  opencode2: {
    channelType: 'slash',
    typeLabel: '插件',
    safetyLevel: 'hot',
    items: [
      '插件在每轮组装时改写系统提示词',
      '换人设即时生效，不用重启宿主'
    ]
  },
  zcode: {
    channelType: 'config',
    typeLabel: '配置接管',
    safetyLevel: 'safe',
    items: [
      '接管 ~/.zcode/AGENTS.md 全局指令',
      '原字节快照，随时还原'
    ]
  },
  codex: {
    channelType: 'config',
    typeLabel: '配置接管',
    safetyLevel: 'safe',
    items: [
      '写进 ~/.codex/config.toml 的 developer_instructions',
      '保持原 TOML 结构与换行，关闭时原样还原'
    ]
  },
  grok: {
    channelType: 'config',
    typeLabel: '配置接管',
    safetyLevel: 'safe',
    items: [
      '写进 ~/.grok/AGENTS.md，启动时加载',
      '原字节快照，关闭时逐位还原'
    ]
  },
  kilo: {
    channelType: 'config',
    typeLabel: '配置接管',
    safetyLevel: 'safe',
    items: [
      '写进 ~/.config/kilo/agent/code.md，替换 code agent 提示词（宿主 soul() 仍前置 "You are Kilo"）',
      '原文件快照，关闭时自动还原'
    ]
  }
};

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const personaName = persona => persona?.meta?.name || persona?.id || '未选择';
export function configurationOf(state) {
  return { persona: state.active ?? '', mode: state.paused ? state.prevMode || 'replace' : state.defaults?.mode || 'replace' };
}
export const changed = (draft, base) => JSON.stringify(draft) !== JSON.stringify(base);
export const needsApply = (state, draft, base) => state.defaultsSet === false || changed(draft, base);
export function sortedHarnesses(state, showAll = false) {
  const selected = h => (h.armed ?? []).some(c => c !== 'project');
  // 不可注入的家不进接管列表；「显示本机未装的」也不放它进来
  return [...(state.harnesses ?? [])]
    .filter(h => h.caps?.injectable !== false)
    .filter(h => showAll || selected(h) || h.found || h.homeExists)
    .sort((a, b) => Number(selected(b)) - Number(selected(a)) || Number(b.found) - Number(a.found) || a.id.localeCompare(b.id));
}
export function effectLabel(harness, paused = false, dshRuntime = null) {
  const name = harnessTitle(harness.id ?? '这个执行器');
  const on = (harness.armed ?? []).some(c => c !== 'project');
  if (on && paused) return '总电源已暂停：配置留着，恢复后按原范围应用';
  if (on && (harness.mode === 'off' || ['harness-off', 'harness-disabled'].includes(harness.activation?.blockedBy))) return '这家已关闭：恢复全部也不会自动启用';
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
    if (dynamic.needs === 'slash' && harness.auto !== true) return `扩展已安装：重新加载 ${name} 后执行 /purge on 生效；当前会话还没确认`;
    return '插件已加载：下一轮读取；首次安装或更新代码后要重启；当前会话还没确认';
  }

  if (harness.armed.includes('install')) return `配置已写入：新开 ${name} 读取；现有会话还没确认`;
  if (harness.armed.includes('slash')) return `在 ${name} 里执行 /purge on 后生效；当前会话还没确认`;
  return `已接管命令行：终端敲 ${name} 时自动注入`;
}
/** 标题下那一行：说清谁在被接管，而不是只报个数。 */
export function scopeSummary(state) {
  const ids = Object.entries(state.armed ?? {}).filter(([, channels]) => (channels ?? []).some(c => c !== 'project')).map(([id]) => harnessTitle(id));
  if (state.paused) return ids.length ? `已暂停，这些执行器的配置还留着：${ids.join('、')}` : '已暂停，暂时没有执行器在用这份人设';
  if (!ids.length) return '选择要管理的执行器；写入通道后，按详情提示检查生效时机。';
  return `已选择 ${ids.length} 个执行器：${ids.join('、')}；实际生效看各自状态`;
}
