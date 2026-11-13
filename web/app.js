import { MODE_LABELS, MODE_DESCRIPTIONS, CHANNEL_LABELS, CAPTURE_LABELS, personaName, configurationOf, changed, needsApply, sortedHarnesses, effectLabel as effectLabelFor, harnessTitle, HARNESS_PURGE_EFFECTS, modeAvailability, unsupportedHarnesses, modeLabels, modeDescriptions, channelLabels, captureLabels, harnessPurgeEffects } from './model.mjs';
import { applyDomI18n, fmtDateTime, fmtNumber, fmtTime, getLocale, isZh, listJoin, pick, setLocale, t } from './i18n.mjs';
import { verificationEvidence } from './evidence.mjs';
applyDomI18n();

const $ = id => document.getElementById(id);
// 数据只进入文本节点或固定属性，不解析来自人设/报告的 HTML。
function node(tag, attrs = {}, ...children) {
  const el = ['svg', 'path'].includes(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') {
      if (['svg', 'path'].includes(tag)) el.setAttribute('class', String(value));
      else el.className = value;
    }
    else if (key === 'checked' || key === 'hidden' || key === 'disabled') el[key] = Boolean(value);
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const chip = (label, kind = '', title = null) => node('span', { class: `chip ${kind}`, title }, label);
const fmt = n => fmtNumber(n);
const empty = label => node('p', { class: 'empty' }, label);

const ICONS = {
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
};
function icon(name, size = 14) {
  const svg = node('svg', {
    class: `lucide lucide-${name}`,
    viewBox: '0 0 24 24', width: String(size), height: String(size),
    fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
  });
  for (const [tag, attrs] of ICONS[name] || []) svg.append(node(tag, attrs));
  return svg;
}

const HARNESS_ICON_FILES = { pi: 'pi.png', 'pi-desktop': 'pi-desktop.png', claude: 'claude.ico', codex: 'codex.webp', omp: 'omp.png', dsh: 'dsh.ico', grok: 'grok.ico', hermes: 'hermes.ico', opencode: 'opencode.ico', opencode2: 'opencode2.ico', codebuddy: 'codebuddy.png', zcode: 'zcode.png', workbuddy: 'workbuddy.png', 'workbuddy-ai': 'workbuddy.png', kilo: 'kilo.png', antigravity: 'antigravity.png', continue: 'continue.png', qoder: 'qoder.png', kimi: 'kimi.png', auggie: 'auggie.png', goose: 'goose.png', qwen: 'qwen.png', kiro: 'kiro.ico', crush: 'crush.png' };
const harnessIcon = (id, size = 22) => {
  const file = HARNESS_ICON_FILES[id];
  const big = size > 22 ? ' tool-icon-lg' : '';
  if (!file) return node('span', { class: `tool-icon is-fallback${big}`, 'aria-hidden': 'true' }, id.slice(0, 1).toUpperCase());
  // ?v=2 绕开旧版 server 对 /assets/ 发过的 max-age 缓存
  return node('img', { class: `tool-icon${big}`, src: `assets/${file}?v=2`, alt: '', width: String(size), height: String(size) });
};

let state, base, draft, editor = null, editorBaseline = '', busy = false, activePage = 'console', expanded = null;
let capture = null, draftConflict = false, project = null;

const CHANNELS = ['install', 'slash', 'shim', 'project'];
const installSourceLabel = src => ({
  shortcut: pick('开始菜单快捷方式', 'Start Menu shortcut'),
  registry: pick('注册表卸载项', 'Uninstall registry entry'),
  guess: pick('盘符扫描', 'Drive scan'),
  scan: pick('盘内浅扫', 'Shallow disk scan'),
}[src] || src);
const channelStatic = c => ({
  install: pick('写进这家自己的配置或插件，新开的会话读取。', 'Written to this tool’s own config or plugin; read by new sessions.'),
  slash: pick('装上扩展后，在会话里执行 /purge on 开启；同一会话里可以换人设。', 'After installing the extension, run /purge on inside a session; switch personas anytime in the same session.'),
  shim: pick('接管终端里的同名命令，启动时自动注入；桌面图标不受影响。', 'Wraps the CLI command in terminal to auto-inject at launch; desktop icons are unaffected.'),
  project: pick('写进当前项目目录的规则文件，只影响这个目录。', 'Written to the rule file in the current project directory; affects only this directory.'),
}[c]);
const evidenceMap = () => ({
  verified: [pick('命中人设', 'Persona hit'), 'is-on'],
  'off-verified': [pick('暂停干净', 'Cleanly paused'), ''],
  partial: [pick('部分命中', 'Partial hit'), 'is-warn'],
  miss: [pick('请求未命中', 'Missed'), 'is-warn'],
  'no-request': [pick('没抓到请求', 'No request'), 'is-fixed'],
  unavailable: [pick('没找到入口', 'Not found'), 'is-fixed'],
  blocked: [pick('被挡住', 'Blocked'), 'is-bad'],
  error: [pick('运行出错', 'Error'), 'is-bad'],
  mismatch: [pick('仍有残留', 'Residual'), 'is-bad'],
  invalid: [pick('没有有效证据', 'Invalid evidence'), 'is-bad'],
  'not-tested': [pick('没试过', 'Not tested'), '']
});

const captureFor = id => (capture?.report?.results ?? []).find(r => r.harness === id) || null;
const evidenceOf = result => {
  const ev = verificationEvidence(result);
  const [label, kind] = evidenceMap()[ev.state] || [ev.label, ''];
  return { ...ev, label, chipClass: kind };
};
const whereLabel = scope => {
  if (scope?.kind === 'isolated-cli') return pick(`临时环境${scope.profile ? ` · ${scope.profile}` : ''}`, `Isolated CLI${scope.profile ? ` · ${scope.profile}` : ''}`);
  if (scope?.kind === 'isolated-session') return pick(`临时会话${scope.profile ? ` · ${scope.profile}` : ''}`, `Isolated session${scope.profile ? ` · ${scope.profile}` : ''}`);
  return pick('临时环境', 'Isolated env');
};
const mode = () => document.querySelector('[name=mode]:checked')?.value || draft?.mode || 'replace';
const configDirty = () => draft && base && changed(draft, base);
const editorValue = () => ({ id: $('edit-id').value.trim(), meta: { name: $('edit-name').value.trim(), description: $('edit-desc').value.trim(), model: $('edit-model').value }, body: $('edit-body').value });
const editorDirty = () => editor !== null && JSON.stringify(editorValue()) !== editorBaseline;

function setConnection(text, kind = '') {
  $('connection').className = `conn ${kind}`;
  $('connection-text').textContent = text;
}
function notify(message, kind = '') {
  const el = $('notice');
  el.textContent = message;
  el.className = `notice ${kind}`;
  el.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { el.hidden = true; }, 6000);
}
function pulseClass(el, cls, ms = 600) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  clearTimeout(el._pulseTimer);
  el._pulseTimer = setTimeout(() => el.classList.remove(cls), ms);
}
async function api(path, data, method) {
  const response = await fetch(`/api/${path}`, { method: method || (data ? 'POST' : 'GET'), headers: data ? { 'content-type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  let result; try { result = await response.json(); } catch { throw new Error(pick('本地服务返回了无效内容，请确认它还在运行。', 'Local service returned invalid data; please verify it is running.')); }
  if (!response.ok || result.error) throw new Error(result.error || pick(`请求失败 (${response.status})`, `Request failed (${response.status})`));
  return result;
}
function announce(result, success) {
  const report = result.applied || result;
  if (report.ok === false) {
    const failed = report.results?.filter(r => r.status === 'failed' || r.ok === false) || [];
    notify(`${report.partial ? pick('部分写入成功。', 'Partially applied. ') : pick('操作没有全部完成。', 'Operation incomplete. ')}${failed.map(r => `${harnessTitle(r.harness)}${pick('：', ': ')}${r.error}`).join(pick('；', '; ')) || pick('详情见「测试与记录」。', 'See Tests & Logs for details.')}`, 'warn');
  } else notify(success, 'good');
}

const lockedControls = new Set();
function lockControls() {
  if (!busy) return;
  document.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)').forEach(el => { lockedControls.add(el); el.disabled = true; });
}
function focusKey(el) {
  if (!el || el === document.body) return null;
  if (el.id) return { id: el.id };
  const keys = ['expand', 'hpersona', 'hmode', 'modeFollow', 'toggle', 'channel', 'verify', 'auto', 'profile', 'page'];
  const key = keys.find(key => el.dataset?.[key] !== undefined);
  return key ? { key, value: el.dataset[key] } : null;
}
function restoreFocus(key) {
  if (!key) return;
  const target = key.id ? $(key.id) : [...document.querySelectorAll(`[data-${key.key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}="${CSS.escape(key.value)}"]`)][0];
  if (target && !target.disabled) target.focus({ preventScroll: true });
}
async function operation(work) {
  if (busy) return;
  const focus = focusKey(document.activeElement);
  busy = true;
  lockControls();
  document.body.setAttribute('aria-busy', 'true');
  try { await work(); } catch (error) { notify(error.message, 'error'); }
  finally {
    busy = false;
    lockedControls.forEach(el => { if (el.isConnected) el.disabled = false; }); lockedControls.clear();
    document.body.removeAttribute('aria-busy');
    if (state) { renderConfigControls(); renderHarnesses(); renderEditorStatus(); }
    restoreFocus(focus);
  }
}

async function refresh({ resetDraft = false } = {}) {
  const fresh = await api('state');
  try { capture = await api('verification'); } catch { capture = { report: null }; }
  const preserve = configDirty() && !resetDraft;
  draftConflict = Boolean(preserve && base && changed(configurationOf(fresh), base));
  state = {
    ...fresh,
    personas: Array.isArray(fresh.personas) ? fresh.personas : [],
    harnesses: Array.isArray(fresh.harnesses) ? fresh.harnesses : [],
    defaults: fresh.defaults || { harness: null, mode: 'replace' },
    armed: fresh.armed || {},
    modes: fresh.modes || Object.keys(MODE_LABELS)
  };
  state.settingsDesktop = fresh.desktop || null;
  if (fresh.locale) {
    setLocale(fresh.locale);
    applyDomI18n();
  }
  base = configurationOf(state);
  if (!preserve) draft = { ...base };
  setConnection(t('conn.connected', { time: fmtTime(Date.now()) }), 'is-live');
  render();

}

function render() {
  const p = state.personas.find(p => p.id === state.active);
  $('current-persona').textContent = personaName(p);
  $('current-mode').textContent = pick(`${fmt(p?.chars)} 字 · ${state.personas.length} 份可用`, `${fmt(p?.chars)} chars · ${state.personas.length} available`);
  $('persona-description').textContent = p?.meta?.description || p?.meta?.desc || pick('这份人设没有写说明。', 'No description for this persona.');
  const activeCount = state.harnesses.filter(consoleOn).length;
  $('scope-count').textContent = String(activeCount);
  const consoleTargets = state.harnesses.filter(isReadyTarget);
  $('scope-total').textContent = String(consoleTargets.length);
  $('coverage-strip').replaceChildren(...consoleTargets.map(h => node('i', { class: consoleOn(h) ? (state.paused ? 'is-warn' : 'is-on') : '' })));
  $('coverage-strip').title = pick(`${activeCount} / ${consoleTargets.length} 个已就绪工具已启用`, `${activeCount} / ${consoleTargets.length} ready tools enabled`);

  $('power-status').textContent = state.paused ? pick('已暂停', 'Paused') : pick('配置启用', 'Active');
  $('power-status').className = `pill ${state.paused ? 'is-warn' : 'is-good'}`;
  $('power').textContent = state.paused ? pick('恢复全部', 'Resume All') : pick('暂停全部', 'Pause All');
  $('power').title = state.paused ? pick('恢复所有工具的人设注入', 'Resume persona injection for all tools') : pick('暂停全部工具的人设注入；只暂停某一家，在它的详情里选「暂停这家」', 'Pause persona injection for all tools; to pause one tool only, choose "Pause this tool" in its details');
  $('power').disabled = false;
  $('disarm-all').disabled = activeCount === 0;

  $('persona-select').replaceChildren(...state.personas.map(p => new Option(pick(`${personaName(p)} · ${fmt(p.chars)} 字`, `${personaName(p)} · ${fmt(p.chars)} chars`), p.id)));
  $('persona-select').value = draft.persona;
  $('persona-select').disabled = false;

  const projectPersonaSelect = $('project-persona-select');
  if (projectPersonaSelect) {
    const activePersona = state.personas.find(item => item.id === state.active);
    const keepVal = rulePersona && state.personas.some(item => item.id === rulePersona) ? rulePersona : '';
    projectPersonaSelect.replaceChildren(
      new Option(pick(`跟随当前人设（${personaName(activePersona)}）`, `Follow current (${personaName(activePersona)})`), ''),
      ...state.personas.map(item => new Option(pick(`${personaName(item)} · ${fmt(item.chars)} 字`, `${personaName(item)} · ${fmt(item.chars)} chars`), item.id))
    );
    projectPersonaSelect.value = keepVal;
    rulePersona = keepVal;
  }

  document.querySelectorAll('[name=mode]').forEach(el => { el.checked = el.value === draft.mode; });

  const defaults = $('default-harness');
  defaults.replaceChildren(new Option(pick('未设置', 'Not set'), ''), ...state.harnesses.filter(h => h.oneshot && h.supported).map(h => new Option(`${harnessTitle(h.id)}${h.found ? '' : pick('（本机未发现）', ' (not found)')}`, h.id)));
  defaults.value = state.defaultsSet ? state.defaults.harness : '';
  $('default-summary').textContent = state.defaultsSet ? harnessTitle(state.defaults.harness) : pick('未设置', 'Not set');
  $('diagnostic-state').textContent = JSON.stringify({ active: state.active, mode: state.defaults.mode, armed: state.armed, pausedInstalls: state.pausedInstalls, reconciled: state.reconciled, revision: state.lastApply?.revision, runtimeConfirmed: state.lastApply?.runtimeConfirmed }, null, 2);

  $('version-badge').textContent = `v${state.version || pick('未知', 'unknown')}`;
  renderConfigControls(); renderHarnesses(); renderPersonas(); renderReport(); renderSettings();
  renderEditorStatus(); lockControls();
}

function renderConfigControls() {
  const dirty = configDirty();
  const selected = state.personas.find(p => p.id === draft.persona);
  const count = state.harnesses.filter(consoleOn).length;
  const label = $('draft-state');
  label.className = 'draft-state';
  if (draftConflict) {
    label.textContent = pick('保存的配置在别处变了，草稿仍在；应用前请核对', 'Saved config changed elsewhere while draft is active; review before applying');
    label.classList.add('is-conflict');
  } else if (state.defaultsSet === false) {
    label.textContent = pick('第一次设置，保存后开始接管', 'First-time setup; save to start');
  } else if (dirty) {
    label.textContent = count ? pick(`有未保存的改动，会同步到 ${count} 个工具`, `Unsaved changes; will sync to ${count} tool(s)`) : pick('有未保存的改动', 'Unsaved changes');
    label.classList.add('is-dirty');
  } else {
    label.textContent = pick('已与保存的配置一致', 'In sync with saved config');
  }

  $('apply').textContent = state.defaultsSet === false ? t('console.saveSettings') : t('console.applyChanges');
  $('apply').disabled = busy || !needsApply(state, draft, base) || !selected;
  $('reset-config').disabled = busy || !dirty;

  const unsupported = unsupportedHarnesses(state.harnesses.filter(consoleOn), draft.mode);
  $('mode-hint').textContent = unsupported.length
    ? pick(
      `${MODE_DESCRIPTIONS[draft.mode] || ''} 已接管的 ${listJoin(unsupported.map(h => harnessTitle(h.id)))} 不支持这个力度，会按它自己的固定方式写入。`,
      `${MODE_DESCRIPTIONS[draft.mode] || ''} Managed ${listJoin(unsupported.map(h => harnessTitle(h.id)))} do not support this mode and will use their fixed mode.`,
    )
    : MODE_DESCRIPTIONS[draft.mode] || '';
}

const consoleChannels = h => (h.armed || []).filter(c => c !== 'project');
const consoleOn = h => consoleChannels(h).length > 0;

function scopeLine() {
  const active = state.harnesses.filter(consoleOn);
  if (state.paused) return active.length ? pick(`已暂停；${active.length} 个工具的配置还留着，恢复后继续生效。`, `Paused; configs kept for ${active.length} tool(s) and will apply on resume.`) : pick('已暂停，当前没有工具在使用人设。', 'Paused; no tools are currently using a persona.');
  if (!active.length) return pick('还没有接管任何工具。打开卡片右上角开关，或点「设置」即可开始。', 'No tools managed yet. Flip a card switch or click "Configure" to start.');
  return pick(`正在接管 ${active.length} 个工具：${listJoin(active.map(h => harnessTitle(h.id)))}。`, `Managing ${active.length} tool(s): ${listJoin(active.map(h => harnessTitle(h.id)))}.`);
}

function toolStatus(h) {
  const on = consoleOn(h);
  const failed = state.lastApply?.results?.some(r => r.harness === h.id && r.status === 'failed');
  const installed = Boolean(h.found || h.homeExists);
  if (on && failed) return { key: 'failed', label: pick('需重试', 'Retry needed') };
  if (on && state.paused) return { key: 'paused', label: pick('已暂停', 'Paused') };
  if (on && h.mode === 'off') return { key: 'paused', label: pick('单独暂停', 'Tool paused') };
  if (on) return { key: 'on', label: pick('已接管', 'Managed') };
  if (!installed) return { key: 'missing', label: pick('未安装', 'Not installed') };
  return { key: 'off', label: pick('可接管', 'Ready') };
}

function toolSub(h) {
  const info = HARNESS_PURGE_EFFECTS[h.id];
  const kind = info?.typeLabel || ({
    config: pick('配置托管', 'Config'),
    plugin: pick('插件', 'Plugin'),
    'launch-arg': pick('启动命令', 'CLI Arg'),
    'file-swap': pick('文件替换', 'File Swap'),
    'native-extension': pick('原生扩展', 'Extension'),
    'config-or-hook': pick('配置 / 钩子', 'Config / Hook'),
  }[h.class] || pick('配置', 'Config'));
  const hot = h.caps?.hot?.ok && !kind.includes(pick('热切', 'Hot')) ? pick('热切', 'Hot-switch') : '';
  return [kind, hot].filter(Boolean).join(' · ');
}

function availableChannels(h) {
  return CHANNELS.filter(c => c !== 'project' && (h.caps?.[c]?.ok || channelOn(h, c)));
}
const channelOn = (h, c) => c === 'project' ? Boolean(h.projectOn) : h.armed.includes(c);
const isReadyTarget = h => consoleOn(h) || availableChannels(h).length > 0;

let targetFilter = 'all';
let targetQuery = '';
let visibleTargets = [];

const targetRows = () => [...$('harness-list').querySelectorAll('.target-row')];
const installed = h => Boolean(h.found || h.homeExists);
const targetGroup = h => {
  if (consoleOn(h)) return 'on';
  if (availableChannels(h).length > 0) return 'ready';
  return 'missing';
};
const groupOrder = () => [
  ['on', pick('已接管', 'Managed')],
  ['ready', pick('可接管', 'Ready')],
  ['missing', pick('未安装', 'Not installed')],
];

function matchesTarget(h) {
  if (!$('show-all').checked && !isReadyTarget(h)) return false;
  if (targetFilter !== 'all' && targetGroup(h) !== targetFilter) return false;
  if (!targetQuery) return true;
  const haystack = [h.id, harnessTitle(h.id), toolSub(h), toolStatus(h).label, ...availableChannels(h).map(c => CHANNEL_LABELS[c])]
    .join(' ').toLowerCase();
  return haystack.includes(targetQuery);
}

let lastGridKey = '';

function targetRow(h, index = 0, animate = false) {
  const status = toolStatus(h);
  const installed = Boolean(h.found || h.homeExists);
  const on = consoleOn(h);
  const active = h.id === expanded;
  const rulesOnly = targetGroup(h) === 'rules';
  const avail = modeAvailability(h);
  const modeLabel = h.mode === 'off' ? pick('已暂停', 'Paused') : (MODE_LABELS[h.mode] || (avail.preferred ? MODE_LABELS[avail.preferred] : MODE_LABELS.replace));
  const customPersona = h.personaFrom === 'override' ? state.personas.find(p => p.id === h.persona) : null;
  const metaText = customPersona ? pick(`专属：${personaName(customPersona)}`, `Custom: ${personaName(customPersona)}`) : modeLabel;

  const statusLabel = rulesOnly && !on ? pick('项目文件', 'Rule file') : status.label;
  const statusChipClass = status.key === 'on' ? 'is-on' : status.key === 'paused' ? 'is-warn' : status.key === 'failed' ? 'is-bad' : '';
  const rightControl = rulesOnly
    ? chip(pick('仅项目规则', 'Project rules only'), '')
    : node('label', { class: 'switch', title: pick(`${on ? '关闭' : '开启'} ${harnessTitle(h.id)} 接管`, `${on ? 'Disable' : 'Enable'} ${harnessTitle(h.id)}`) },
        node('input', {
          type: 'checkbox', 'data-toggle': h.id, checked: on,
          disabled: !installed && !on,
          'aria-label': pick(`${on ? '关闭' : '开启'} ${harnessTitle(h.id)} 的人设接管`, `${on ? 'Disable' : 'Enable'} persona injection for ${harnessTitle(h.id)}`)
        }),
        node('span', { class: 'switch-track', 'aria-hidden': 'true' })
      );

  return node('article', {
    class: `tool-card target-row${active ? ' is-active' : ''}${on ? ' is-on' : ''}${!installed ? ' is-missing' : ''}${animate ? ' is-entering' : ''}`,
    'data-id': h.id, 'data-expand': h.id
  },
    node('div', { class: 'tool-card-top' },
      node('div', { class: 'tool-card-id' },
        harnessIcon(h.id, 28),
        node('div', { class: 'tool-card-titles' },
          node('strong', {}, harnessTitle(h.id)),
          node('small', {}, toolSub(h))
        )
      ),
      rightControl
    ),
    node('div', { class: 'tool-card-foot' },
      node('div', { class: 'tool-card-meta' },
        node('span', { class: 'tool-card-index', 'aria-hidden': 'true' }, String(index + 1).padStart(2, '0')),
        chip(statusLabel, statusChipClass),
        node('span', {}, metaText)
      ),
      node('button', {
        type: 'button', class: 'tool-card-more', 'data-expand': h.id,
        'aria-label': pick(`设置 ${harnessTitle(h.id)}`, `Configure ${harnessTitle(h.id)}`)
      }, pick('设置 →', 'Configure →'))
    )
  );
}

function renderTargetList(rows, animate = false) {
  const list = $('harness-list');
  if (!rows.length) {
    list.replaceChildren(node('div', { class: 'target-empty' },
      node('strong', {}, pick('没有匹配的目标', 'No matching targets')),
      node('p', {}, targetQuery || targetFilter !== 'all' ? pick('换个关键词，或把筛选切回「全部」。', 'Try another keyword or switch filter back to "All".') : pick('勾选「显示未安装」看看还能接哪些。', 'Check "Show uninstalled" to see other supported tools.'))
    ));
    return;
  }
  const groups = new Map();
  rows.forEach((h, idx) => {
    const key = targetGroup(h);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ h, idx });
  });
  const sections = [];
  for (const [key, label] of groupOrder()) {
    const items = groups.get(key);
    if (!items?.length) continue;
    sections.push(node('section', { class: 'tool-group', 'data-group': key },
      node('div', { class: 'tool-group-head' },
        node('span', {}, label),
        node('span', { class: 'tool-group-count' }, String(items.length))
      ),
      node('div', { class: 'tool-grid-cards' }, items.map(({ h, idx }) => targetRow(h, idx, animate)))
    ));
  }
  list.replaceChildren(...sections);
}

function closeDrawer({ restore = true } = {}) {
  const prev = expanded;
  expanded = null;
  document.querySelector('.target-console')?.classList.remove('has-detail');
  $('tool-drawer').hidden = true;
  $('drawer-backdrop').hidden = true;
  targetRows().forEach(row => row.classList.remove('is-active'));
  if (restore && prev) {
    document.querySelector(`.tool-card[data-id="${CSS.escape(prev)}"] .tool-card-more`)?.focus({ preventScroll: true });
  }
}

function renderHarnesses() {
  if (detailTimer) { clearTimeout(detailTimer); detailTimer = null; }
  $('scope-summary').textContent = scopeLine();
  const showAll = $('show-all').checked;
  const all = sortedHarnesses(state, showAll).filter(h => showAll || isReadyTarget(h));
  visibleTargets = all.filter(matchesTarget);
  $('harness-count').textContent = t('console.targetsVisibleCount', { visible: visibleTargets.length, total: all.length });
  if (!visibleTargets.length) {
    closeDrawer({ restore: false });
    $('harness-list').replaceChildren(node('div', { class: 'target-empty' },
      node('strong', {}, pick('没有匹配的目标', 'No matching targets')),
      node('p', {}, targetQuery || targetFilter !== 'all' ? pick('换个关键词，或把筛选切回「全部」。', 'Try another keyword or switch filter back to "All".') : pick('勾选「显示未安装」看看还能接哪些。', 'Check "Show uninstalled" to see other supported tools.'))
    ));
    lockControls();
    return;
  }
  if (expanded && !visibleTargets.some(h => h.id === expanded)) {
    expanded = null;
  }
  const gridKey = visibleTargets.map(h => h.id).join(',');
  const animate = gridKey !== lastGridKey;
  lastGridKey = gridKey;
  renderTargetList(visibleTargets, animate);
  renderDetail(expanded);
  lockControls();
}

function selectTarget(id, { focusClose = false } = {}) {
  if (!id) return;
  const h = state?.harnesses?.find(item => item.id === id);
  if (!h) return;
  if (detailTimer) { clearTimeout(detailTimer); detailTimer = null; }
  const prev = expanded;
  expanded = id;
  targetRows().forEach(row => row.classList.toggle('is-active', row.dataset.id === id));
  const wasOpen = !$('tool-drawer').hidden;
  renderDetail(id);
  if (!wasOpen) pulseClass($('tool-drawer'), 'is-opening', 520);
  else if (prev !== id) pulseClass($('tool-drawer'), 'is-switching', 360);
  if (focusClose) $('close-drawer')?.focus({ preventScroll: true });
}

let detailTimer = null;
function renderDetail(id) {
  const drawer = $('tool-drawer');
  const backdrop = $('drawer-backdrop');
  const host = $('tool-detail');
  const h = id ? state?.harnesses?.find(item => item.id === id) : null;
  const shell = document.querySelector('.target-console');
  if (!h) {
    shell?.classList.remove('has-detail');
    drawer.hidden = true;
    backdrop.hidden = true;
    host.replaceChildren();
    return;
  }
  shell?.classList.add('has-detail');
  drawer.hidden = false;
  backdrop.hidden = false;
  host.replaceChildren(toolPanel(h));
}
function channelRow(h, c) {
  const isOn = channelOn(h, c);
  const info = h.caps?.[c] || {};
  let why = info.ok ? channelStatic(c) : info.why || pick('不可用', 'Unavailable');
  if (c === 'install' && ['dsh', 'opencode', 'opencode2'].includes(h.id)) why = pick('装成宿主插件，新开的会话自动读取；首次安装或更新代码后要重启一次。', 'Installed as a host plugin and read by new sessions; restart once after initial install or update.');
  if (c === 'slash' && h.id === 'dsh') why = pick('装上 /purge 开关；注入仍靠常驻配置，两样都要启用。', 'Installs the /purge toggle; injection still relies on persistent config, so both must be enabled.');
  if (c === 'project') why = pick(`写进当前目录的 ${h.caps?.project?.file || '规则文件'}；只影响这个目录。`, `Written to ${h.caps?.project?.file || 'rule file'} in the current directory; affects only this directory.`);
  return node('div', { class: 'channel-item' },
    node('div', { class: 'channel-head' },
      node('div', { class: 'channel-name' }, CHANNEL_LABELS[c], isOn ? chip(pick('已启用', 'Enabled'), 'is-on') : null),
      node('button', {
        type: 'button', class: `btn btn-sm ${isOn ? 'btn-primary' : 'btn-ghost'}`, 'data-channel': c, 'data-target': h.id, 'data-enabled': String(!isOn),
        title: isOn ? pick(`关闭 ${CHANNEL_LABELS[c]}`, `Disable ${CHANNEL_LABELS[c]}`) : pick(`启用 ${CHANNEL_LABELS[c]}`, `Enable ${CHANNEL_LABELS[c]}`)
      }, isOn ? pick('关闭', 'Disable') : pick('启用', 'Enable'))
    ),
    node('div', { class: 'channel-why' }, why)
  );
}

function unavailableDetail(h) {
  const blocked = CHANNELS.filter(c => !h.caps?.[c]?.ok && !channelOn(h, c));
  if (!blocked.length) return null;
  return node('details', { class: 'fine' },
    node('summary', {}, pick(`另有 ${blocked.length} 种方式对这家不适用`, `${blocked.length} other method(s) not applicable`)),
    node('div', { class: 'fine-body' }, blocked.map(c => {
      const cap = h.caps?.[c] || {};
      const hidden = cap.hiddenLabel ? pick(`（曾用落点：${cap.hiddenLabel}）`, ` (former path: ${cap.hiddenLabel})`) : '';
      return node('p', {}, node('strong', {}, CHANNEL_LABELS[c]), cap.why || pick('不可用', 'Unavailable'), hidden);
    }))
  );
}

function modeControl(h) {
  const avail = modeAvailability(h);
  const usable = ['replace', 'strict', 'append'].filter(m => avail.supported.has(m));
  if (usable.length <= 1) {
    return node('div', {},
      node('div', { class: 'mode-readonly' },
        node('strong', {}, MODE_LABELS[usable[0]] || pick('固定', 'Fixed')),
        node('span', { class: 'hint' }, pick('固定方式', 'Fixed mode'))
      ),
      node('p', { class: 'panel-sub' }, avail.note || pick('这家只接受这一种写法。', 'This tool only supports this mode.')),
      avail.purgeNote ? node('p', { class: 'panel-sub' }, avail.purgeNote) : null,
      h.modeFrom === 'override'
        ? node('button', { type: 'button', class: 'link', 'data-mode-follow': h.id }, pick('恢复跟随全局', 'Follow global'))
        : null
    );
  }
  const options = [new Option(pick(`跟随全局 · ${MODE_LABELS[draft.mode] || ''}`, `Follow global · ${MODE_LABELS[draft.mode] || ''}`), 'follow')];
  for (const m of usable) options.push(new Option(`${MODE_LABELS[m]}${avail.preferred === m ? pick('（推荐）', ' (Recommended)') : ''}`, m));
  options.push(new Option(pick('暂停这家', 'Pause this tool'), 'off'));
  // 旧配置可能留着已归并的 strict；回落到等价的 replace，避免下拉框空选
  const current = h.mode === 'off' ? 'off' : usable.includes(h.mode) ? h.mode : 'replace';
  const value = h.modeFrom === 'override' ? current : 'follow';
  const select = node('select', { class: 'select', 'data-hmode': h.id, 'aria-label': pick(`${harnessTitle(h.id)} 改写力度`, `${harnessTitle(h.id)} rewrite mode`) }, ...options);
  select.value = value;
  return node('div', {}, select,
    avail.limited && avail.note ? node('p', { class: 'panel-sub' }, avail.note) : null,
    avail.purgeNote ? node('p', { class: 'panel-sub' }, avail.purgeNote) : null,
    unsupportedHarnesses([h], draft.mode).length && h.modeFrom !== 'override'
      ? node('p', { class: 'panel-sub' }, pick(
        `全局力度「${MODE_LABELS[draft.mode]}」对它不适用，实际按 ${MODE_LABELS[h.mode]} 写入。`,
        `Global mode "${MODE_LABELS[draft.mode]}" does not apply here; writing as ${MODE_LABELS[h.mode]}.`,
      ))
      : null
  );
}

function effectsDetail(h) {
  const info = HARNESS_PURGE_EFFECTS[h.id];
  if (!info) return null;
  return node('details', { class: 'fine' },
    node('summary', {}, pick('它会改写什么', 'What it modifies')),
    node('ul', { class: 'effect-list' }, info.items.map(item => node('li', {}, item)))
  );
}

function formatVerifyTime(raw) {
  if (!raw) return pick('时间未记录', 'Time not recorded');
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function verifyNote(h) {
  const result = captureFor(h.id);
  if (!result) return pick('还没试过。试跑在临时环境里进行，不碰你正在用的窗口。', 'Not tested yet. Runs in an isolated temp dir without touching active windows.');
  const ev = evidenceOf(result);
  const reason = result.reason ? ` · ${result.reason}` : '';
  return pick(
    `${ev.label} · ${whereLabel(result.scope)} · ${formatVerifyTime(result.at || capture?.report?.at)}${reason}（不代表当前会话）`,
    `${ev.label} · ${whereLabel(result.scope)} · ${formatVerifyTime(result.at || capture?.report?.at)}${reason} (does not reflect active sessions)`,
  );
}

function technicalDetail(h) {
  return node('details', { class: 'fine' },
    node('summary', {}, pick('技术细节', 'Technical details')),
    node('div', { class: 'fine-body' },
      node('p', {}, node('strong', {}, pick('热切机制', 'Hot-switch')), h.caps?.hot?.how || h.caps?.hot?.why || pick('启动时读取一次，改完要重开会话。', 'Read once at startup; restart session after changes.')),
      node('p', {}, node('strong', {}, pick('配置路径', 'Config path')), node('code', { class: 'path' }, h.persistFile || h.home || '—')),
      h.install && h.install !== h.home ? node('p', {}, node('strong', {}, pick('安装目录', 'Install dir')), node('code', { class: 'path' }, h.install), h.installSource ? ` · ${installSourceLabel(h.installSource)}` : '') : null,
      node('p', {}, node('strong', {}, pick('命令入口', 'Command')), node('code', { class: 'path' }, h.bin || pick('未发现', 'Not found')))
    )
  );
}

function toolPanel(h) {
  const channels = availableChannels(h);
  const info = HARNESS_PURGE_EFFECTS[h.id];
  const effect = consoleOn(h) ? effectLabelSafe(h) : null;
  const installed = Boolean(h.found || h.homeExists);
  const ev = captureFor(h.id) ? evidenceOf(captureFor(h.id)) : null;

  const personaOptions = [new Option(pick(`跟随全局（${personaName(state.personas.find(p => p.id === state.persona))}）`, `Follow global (${personaName(state.personas.find(p => p.id === state.persona))})`), '')];
  for (const p of state.personas) personaOptions.push(new Option(personaName(p), p.id));
  const personaSelect = node('select', { class: 'select', 'data-hpersona': h.id, 'aria-label': pick(`${harnessTitle(h.id)} 使用的人设`, `Persona for ${harnessTitle(h.id)}`) }, ...personaOptions);
  personaSelect.value = h.personaFrom === 'override' ? h.persona : '';

  const rulesOnly = targetGroup(h) === 'rules';
  const toggleBtn = rulesOnly
    ? null
    : node('button', {
        type: 'button',
        class: `btn ${consoleOn(h) ? 'btn-ghost' : 'btn-primary'}`,
        'data-drawer-toggle': h.id,
        disabled: !installed && !consoleOn(h)
      }, consoleOn(h) ? pick('关闭接管', 'Disable') : pick('开启接管', 'Enable'));

  const closeIcon = node('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    node('path', { d: 'M18 6 6 18M6 6l12 12' })
  );

  const targetIdx = visibleTargets.findIndex(item => item.id === h.id);
  const indexTag = String((targetIdx >= 0 ? targetIdx : 0) + 1).padStart(2, '0');
  const statusChipClass = toolStatus(h).key === 'on' ? 'is-on' : toolStatus(h).key === 'paused' ? 'is-warn' : toolStatus(h).key === 'failed' ? 'is-bad' : '';

  return node('div', { class: 'tool-panel', id: `panel-${h.id}` },
    node('div', { class: 'drawer-eyebrow' },
      node('div', { class: 'drawer-eyebrow-left' },
        node('span', { class: 'drawer-code' }, `TARGET // ${indexTag}`),
        chip(toolStatus(h).label, statusChipClass)
      ),
      node('button', { type: 'button', id: 'close-drawer', class: 'icon-btn', 'aria-label': pick('关闭详情', 'Close details'), title: pick('关闭详情 (Esc)', 'Close details (Esc)') }, closeIcon)
    ),
    node('div', { class: 'detail-head' },
      node('div', { class: 'detail-id' },
        harnessIcon(h.id, 34),
        node('div', {},
          node('h2', {}, harnessTitle(h.id),
            h.personaFrom === 'override' ? node('span', { class: 'tool-flag is-accent' }, pick('专属', 'Custom')) : null,
            state.defaultsSet && state.defaults.harness === h.id ? node('span', { class: 'tool-flag' }, pick('默认', 'Default')) : null
          ),
          node('p', {}, `${toolSub(h)} · ${installed ? pick('本机已安装', 'Installed') : pick('本机没装', 'Not installed')}`)
        )
      ),
      toggleBtn ? node('div', { class: 'detail-actions' }, toggleBtn) : null
    ),
    node('section', { class: 'drawer-section' },
      node('h3', {}, pick('01 // 独立设置', '01 // Tool Overrides')),
      node('div', { class: 'panel-fields-grid' },
        node('div', { class: 'panel-field' },
          node('span', { class: 'field-label' }, pick('使用哪份人设', 'Persona')),
          personaSelect
        ),
        node('div', { class: 'panel-field' },
          node('span', { class: 'field-label' }, pick('改写力度', 'Mode')),
          modeControl(h)
        )
      ),
      ['pi', 'omp'].includes(h.id) && h.armed.includes('slash')
        ? node('label', { class: 'check' }, node('input', { type: 'checkbox', 'data-auto': h.id, checked: state[h.id === 'pi' ? 'piAuto' : 'ompAuto'] }), pick(' 新会话自动应用（关闭时须执行 /purge on）', ' Auto-apply to new sessions (requires /purge on when off)'))
        : null,
      h.id === 'dsh' && h.homeExists
        ? node('div', { class: 'panel-field' },
            node('span', { class: 'field-label' }, pick('生效形态', 'Active Profiles')),
            node('div', { class: 'profile-set' }, state.dshAll.map(p =>
              node('label', { class: 'profile-chip' },
                node('input', { type: 'checkbox', 'data-profile': p, checked: state.dshProfiles.includes(p) }),
                node('span', {}, p)
              )
            ))
          )
        : null
    ),
    node('section', { class: 'drawer-section' },
      node('h3', {}, pick('02 // 接管方式', '02 // Channels')),
      channels.length
        ? node('div', { class: `channel-list channel-count-${channels.length}` }, channels.map(c => channelRow(h, c)))
        : node('p', { class: 'muted' }, h.reason || pick('这家仅支持项目级规则文件，请到「项目规则」页写入。', 'Supports project rule files only; configure on the Rule Files page.')),
      unavailableDetail(h)
    ),
    node('div', { class: 'panel-foot' },
      node('div', { class: 'panel-foot-head' },
        node('h3', { class: 'panel-foot-title' }, pick('03 // 安全试跑', '03 // Dry-Run Verification'))
      ),
      node('div', { class: 'verify-bar' },
        node('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-verify': h.id, disabled: !installed, title: pick('在临时目录里跑一次，不读取也不修改当前会话', 'Run once in an isolated temp dir without touching active sessions') }, pick('试跑一次', 'Verify Once')),
        ev ? chip(ev.label, ev.chipClass) : null,
        node('span', { class: 'verify-note' }, verifyNote(h))
      ),
      node('div', { class: 'panel-meta-row' },
        info ? effectsDetail(h) : null,
        technicalDetail(h)
      )
    )
  );
}

// effectLabel 来自 model.mjs，单独包一层避免老数据缺字段时报错
function effectLabelSafe(h) {
  try { return effectLabelFor(h); } catch { return null; }
}
/* ---------------- personas ---------------- */
function renderPersonas() {
  const query = $('persona-search').value.toLocaleLowerCase();
  const list = state.personas.filter(p => `${p.id} ${personaName(p)} ${p.meta?.description || p.meta?.desc || ''}`.toLocaleLowerCase().includes(query));
  $('persona-list').replaceChildren(...(list.length ? list.map(p => node('button', {
    type: 'button', class: `persona-item ${editor === p.id ? 'selected' : ''}`, 'data-persona': p.id
  }, node('strong', {}, personaName(p)), node('small', {}, pick(`${p.id} · ${fmt(p.chars)} 字`, `${p.id} · ${fmt(p.chars)} chars`)), state.active === p.id ? chip(pick('当前人设', 'Active'), '') : null)) : [empty(pick('没有匹配的人设', 'No matching personas'))]));
}
function confirmDiscard() { return !editorDirty() || window.confirm(pick('这份人设有未保存的修改，放弃吗？', 'Discard unsaved changes to this persona?')); }
function openEditor(id) {
  if (!confirmDiscard()) return;
  editor = id || '';
  const p = state.personas.find(p => p.id === id);
  $('editor-empty').hidden = true; $('editor-form').hidden = false;
  $('edit-id').value = p?.id || ''; $('edit-id').disabled = Boolean(p);
  $('edit-name').value = p?.meta?.name || ''; $('edit-desc').value = p?.meta?.description || p?.meta?.desc || '';
  $('edit-body').value = p?.body || '';
  const model = p?.meta?.model;
  $('edit-model').value = Array.isArray(model) ? model.join(', ') : (model || '');
  editorBaseline = JSON.stringify(editorValue());
  renderEditorStatus(); renderPersonas();
}
function renderEditorStatus() {
  if (editor === null) return;
  const current = editor === state.active;
  $('editor-title').textContent = editor ? (current ? t('library.editCurrentTitle') : t('library.editTitle')) : t('library.newTitle');
  $('editor-status').textContent = editorDirty() ? t('library.unsaved') : t('library.saved');
  $('char-count').textContent = pick(`${$('edit-body').value.trim().length} 字`, `${$('edit-body').value.trim().length} chars`);
  $('save-persona').textContent = current ? t('library.saveAndSync') : t('console.save');
  $('save-persona').disabled = busy || !editorDirty();
  $('save-apply').hidden = current;
  $('save-apply').disabled = busy;
  $('delete-persona').disabled = busy || !editor || state.personas.length <= 1;
  $('edit-id').disabled = busy || Boolean(editor);
  $('editor-hint').textContent = current
    ? pick('保存后会同步到已接管的工具；暂停时只更新人设，不恢复应用。', 'Saving syncs to managed tools; while paused, only the persona is updated.')
    : pick('「保存」只改人设库；「保存并应用」会切换当前人设并同步。', '"Save" updates the library only; "Save & Apply" switches the active persona and syncs.');
}
async function saveEditor(apply) {
  if (!$('editor-form').reportValidity()) return;
  const value = editorValue();
  if (!editor && state.personas.some(p => p.id === value.id)) { notify(pick('这个标识已经存在，换一个再试。', 'This ID already exists; choose another.'), 'error'); return; }
  await operation(async () => {
    const result = await api('persona', { ...value, apply });
    editor = result.persona.id;
    editorBaseline = JSON.stringify(value);
    await refresh({ resetDraft: apply });
    announce(result, apply ? pick('人设已保存并应用。', 'Persona saved and applied.') : pick('人设已保存。', 'Persona saved.'));
  });
}

/* ---------------- reports ---------------- */
function renderReport() {
  const r = state.lastApply;
  $('retry-failed').hidden = !r?.results?.some(x => x.status === 'failed');
  $('report-meta').textContent = r
    ? `${fmtDateTime(r.at)} · ${MODE_LABELS[r.mode] || r.mode} · ${pick(`${r.results.length} 项`, `${r.results.length} item(s)`)}`
    : pick('应用后，这里会按工具记录写入结果。', 'Write results per tool will appear here after applying.');
  $('apply-results').replaceChildren(...(!r
    ? [empty(pick('还没有应用记录。', 'No apply records yet.'))]
    : !r.results.length
      ? [empty(pick('配置已保存，当前没有需要写入的通道。', 'Configuration saved; no channels needed writing.'))]
      : r.results.map(x => node('div', { class: 'result-row' },
          node('div', { class: 'result-title' }, harnessTitle(x.harness), chip(x.status === 'failed' ? pick('失败', 'Failed') : pick('已写入', 'Written'), x.status === 'failed' ? 'is-bad' : 'is-on')),
          node('div', { class: 'result-detail' }, `${CHANNEL_LABELS[x.channel] || x.channel}${x.message ? ` · ${x.message}` : ''}`, x.status === 'failed' ? null : node('span', { class: 'hint' }, pick(' · 运行中的会话尚未确认', ' · Active sessions unconfirmed'))),
          x.error ? node('div', { class: 'result-detail error' }, x.error) : null
  ))));
}

function captureRow(result) {
  const ev = evidenceOf(result);
  const modes = result.modes || [];
  const roles = [...new Set(modes.flatMap(m => (m.requests || []).flatMap(r => r.roles || [])))].join(' + ');
  const hot = result.hotSwitch?.status;
  return node('tr', {},
    node('td', {}, node('strong', {}, harnessTitle(result.harness)), node('div', { class: 'hint' }, result.version || pick('版本未知', 'Unknown version'))),
    node('td', {}, chip(ev.label, ev.chipClass)),
    node('td', {}, roles || '—'),
    node('td', {},
      result.reason || (!modes.length ? result.evidence || '' : ''),
      hot ? node('div', { class: 'hint' }, pick(`同会话热切：${CAPTURE_LABELS[hot] || hot}`, `In-session hot-switch: ${CAPTURE_LABELS[hot] || hot}`)) : null,
      modes.length ? node('details', { class: 'fine' },
        node('summary', {}, pick(`${modes.length} 种力度的请求证据`, `Request evidence for ${modes.length} mode(s)`)),
        node('div', { class: 'fine-body' }, modes.map(m => node('p', {},
          `${MODE_LABELS[m.mode] || m.mode} · ${CAPTURE_LABELS[m.status] || m.status}${pick('：', ': ')}${m.reason || ''} `,
          (m.requests || []).map(r => pick(
            `${(r.roles || []).join('+')} / ${r.chars} 字 / 人设 ${r.markerCount} 次 / 身份句 ${r.identityLines?.length || 0}`,
            `${(r.roles || []).join('+')} / ${r.chars} chars / persona ×${r.markerCount} / identity lines ${r.identityLines?.length || 0}`,
          )).join(pick('；', '; '))
        )))
      ) : null
    )
  );
}

function captureSummary(report) {
  const results = report.results || [];
  const hits = results.filter(r => ['verified', 'off-verified'].includes(evidenceOf(r).state)).length;
  const missing = results.filter(r => ['no-request', 'unavailable', 'miss'].includes(evidenceOf(r).state)).length;
  return pick(
    `最近一次在临时环境里试了 ${results.length} 个工具：${hits} 个在请求里命中了人设${missing ? `，${missing} 个没抓到或没命中` : ''}。`,
    `Last isolated test ran ${results.length} tool(s): ${hits} hit the persona${missing ? `, ${missing} had no request or missed` : ''}.`,
  );
}

async function loadCapture() {
  try {
    capture = await api('verification');
    const report = capture.report;
    const command = node('p', { class: 'hint' }, pick('重新试跑：', 'Re-run: '), node('code', {}, 'npm run test:harness'));
    $('capture-results').replaceChildren(...(!report ? [node('p', { class: 'muted' }, pick('还没有试跑报告。试跑使用临时配置和本地服务，不以模型自称的身份作为证据。', 'No verification report yet. Tests use isolated configs and a local fixture server, never model self-reports.')), command] : [
      node('p', { class: 'muted' }, captureSummary(report)),
      node('p', { class: 'hint' }, pick(`${report.at || ''} · 临时环境。这不代表你正在用的窗口已经生效。`, `${report.at || ''} · Isolated environment. Does not reflect your active windows.`)),
      node('div', { class: 'table-scroll' }, node('table', { class: 'capture-table' },
        node('thead', {}, node('tr', {}, [pick('工具 / 版本', 'Tool / Version'), pick('结果', 'Result'), pick('注入层', 'Layer'), pick('说明', 'Details')].map(label => node('th', {}, label)))),
        node('tbody', {}, report.results.map(captureRow))
      )),
      command
    ]));
  } catch (error) { $('capture-results').textContent = pick(`报告读取失败：${error.message}`, `Failed to load report: ${error.message}`); }
}

/* ---------------- project & global rules ---------------- */
let ruleScope = 'project';
let rulePersona = '';

async function loadProject(dir = '') {
  $('project-targets').replaceChildren(empty(t('project.loading')));
  $('project-dir-wrap').hidden = ruleScope === 'global';
  $('project-scope-heading').textContent = ruleScope === 'global' ? t('project.scopeGlobalHeading') : t('project.scopeProjectHeading');
  $('project-scope-desc').textContent = t('project.scopeDesc');
  document.querySelectorAll('[name="rule-scope"]').forEach(el => { el.checked = el.value === ruleScope; });
  try {
    const params = new URLSearchParams();
    if (ruleScope === 'global') params.set('scope', 'global');
    else if (dir) params.set('dir', dir);
    if (rulePersona) params.set('persona', rulePersona);
    const qs = params.toString();
    project = await api(`project${qs ? `?${qs}` : ''}`);
    if (project.dir) $('project-dir').value = project.dir;
    renderProject();
  } catch (error) {
    project = null;
    $('project-targets').replaceChildren(node('p', { class: 'empty' }, error.message));
  }
}

function renderProject() {
  if (!project) return;
  const scope = project.scope === 'global' ? 'global' : 'project';
  const persona = state?.personas?.find(p => p.id === project.persona);
  const selectedPersonaTitle = persona ? personaName(persona) : pick('当前人设', 'Current persona');
  const projects = scope === 'global' ? [] : (project.projects?.length ? project.projects : project.recent.map(dir => ({ dir, current: dir === project.dir, files: 0, written: 0 })));
  $('project-recent').replaceChildren(...projects.map(item =>
    node('button', {
      type: 'button',
      class: 'recent-chip project-recent-item',
      'data-project-dir': item.dir,
      title: item.dir,
      'aria-current': item.current ? 'true' : 'false'
    },
      node('span', { class: 'project-recent-path' }, item.dir),
      node('span', { class: 'project-recent-count' }, item.current ? pick('当前', 'Current') : item.files ? pick(`${item.written}/${item.files} 已写入`, `${item.written}/${item.files} written`) : pick('未写入', 'Not written'))
    )
  ));
  const cards = project.targets.map(target => {
    const readers = target.tools || [];
    const on = Boolean(target.on);
    const hasBlock = Boolean(target.hasBlock);
    const pending = !on && Boolean(target.selected) && project.paused;
    const blocked = hasBlock && !on;
    const canWrite = !hasBlock && !project.paused && Boolean(project.persona) && readers.length > 0;
    const canUpdate = on && !project.paused && Boolean(project.persona) && target.writtenPersona !== project.persona;
    const action = on || pending ? 'off' : 'on';
    const writeLabel = scope === 'global' ? pick('写入全局文件', 'Write Global File') : pick('写入此项目', 'Write to Project');
    const label = on ? pick('移除', 'Remove') : pending ? pick('取消选择', 'Deselect') : blocked ? pick('处理现有块', 'Resolve Existing Block') : writeLabel;
    const disableAction = blocked || (!on && !pending && !canWrite);
    const actionButton = node('button', {
      type: 'button',
      class: `btn ${on || pending ? 'btn-ghost' : 'btn-ink'}`,
      'data-project-action': action,
      'data-project-file': target.file,
      'data-project-id': target.id || '',
      disabled: disableAction
    }, label);
    const updateButton = canUpdate ? node('button', {
      type: 'button',
      class: 'btn btn-primary',
      'data-project-action': 'on',
      'data-project-file': target.file,
      'data-project-id': target.id || ''
    }, pick(`更新为「${selectedPersonaTitle}」`, `Update to "${selectedPersonaTitle}"`)) : null;
    const writtenLabel = target.writtenPersonaName ? pick(`已写入 · ${target.writtenPersonaName}`, `Written · ${target.writtenPersonaName}`) : pick('已写入', 'Written');
    const status = on ? writtenLabel : blocked ? pick('归属不明', 'Unknown owner') : pending ? pick('已暂停', 'Paused') : target.selected ? pick('待写入', 'Pending') : pick('未写入', 'Not written');
    const diff = target.diff;
    const diffSummary = diff ? (diff.added || diff.removed ? pick(`查看写入差异 · +${diff.added} / -${diff.removed}`, `View diff · +${diff.added} / -${diff.removed}`) : pick('查看写入差异 · 没有变化', 'View diff · No changes')) : null;
    const scopeNote = on
      ? pick(
        `已写入${target.writtenPersonaName ? `「${target.writtenPersonaName}」` : ''}，追加在原文件末尾（append），随时可移除。`,
        `Written${target.writtenPersonaName ? ` "${target.writtenPersonaName}"` : ''} as an appended block at the end of the file; removable anytime.`,
      )
      : pick('保留原有规则并在末尾追加（append）托管块，对所有读取方生效。', 'Preserves existing rules and appends a managed block at the end for all reading tools.');
    return node('article', { class: 'project-card', 'data-project-card': target.file },
      node('div', { class: 'project-card-head' },
        node('div', {},
          node('h2', {}, target.file),
          node('p', { class: 'project-path' }, target.path)
        ),
        chip(status, on ? 'is-on' : blocked || pending ? 'is-warn' : '')
      ),
      node('p', { class: 'project-readers' }, readers.length ? pick(`读取方：${listJoin(readers.map(id => harnessTitle(id)))}`, `Read by: ${listJoin(readers.map(id => harnessTitle(id)))}`) : pick('没有已登记的工具读取这个文件', 'No registered tools read this file')),
      node('p', { class: 'project-scope-note' }, scopeNote),
      node('div', { class: 'project-controls' }, updateButton, actionButton),
      target.gitHint && (on || hasBlock) ? node('p', { class: 'hint' }, target.gitHint) : null,
      blocked ? node('p', { class: 'hint' }, pick('文件里有 agent-purge 托管块，但账本里找不到归属；先手动核对，避免误删。', 'File contains an agent-purge block not found in the ledger; inspect manually to avoid accidental deletion.')) : null,
      !on && !hasBlock && !project.persona ? node('p', { class: 'hint' }, pick('先在「控制台」或「人设库」选一份人设，才能写入。', 'Select a persona in Console or Personas first to write.')) : null,
      !on && !hasBlock && project.paused ? node('p', { class: 'hint' }, pick('全局暂停中：恢复后会按当前选择写回；现在只取消选择。', 'Global pause active: selection will write back on resume; deselecting only for now.')) : null,
      target.preview ? node('details', { class: 'project-preview' },
        node('summary', {}, pick(`查看托管块 · ${fmt(target.preview.chars)} 字`, `View managed block · ${fmt(target.preview.chars)} chars`)),
        node('pre', {}, target.preview.text + (target.preview.truncated ? '\n…' : ''))
      ) : null,
      diff ? node('details', { class: 'project-preview project-diff' },
        node('summary', {}, diffSummary),
        node('pre', {}, diff.text)
      ) : null,
      target.after != null ? node('details', { class: 'project-preview project-after' },
        node('summary', {}, pick(`写入后的规则文件 · ${fmt(target.afterChars)} 字`, `Resulting rule file · ${fmt(target.afterChars)} chars`)),
        node('pre', {}, target.after + (target.afterTruncated ? '\n…' : ''))
      ) : null
    );
  });
  const toolRows = project.targets
    .flatMap(target => (target.tools || []).map(id => ({
      id,
      file: target.file,
      on: Boolean(target.on),
      hasBlock: Boolean(target.hasBlock),
      selected: Boolean(target.selected)
    })))
    .sort((a, b) => harnessTitle(a.id).localeCompare(harnessTitle(b.id), isZh() ? 'zh-CN' : 'en'));
  const coverage = node('details', { class: 'project-coverage' },
    node('summary', {}, pick(`按工具查看读取关系 · ${toolRows.length} 家`, `Per-tool file mapping · ${toolRows.length} tool(s)`)),
    node('div', { class: 'project-coverage-list' }, ...toolRows.map(row => node('div', { class: 'project-coverage-row' },
      node('strong', {}, harnessTitle(row.id)),
      node('span', { class: 'project-coverage-file' }, pick(`读取 ${row.file}`, `Reads ${row.file}`)),
      node('span', { class: 'project-coverage-state' }, row.on ? pick('已写入', 'Written') : row.hasBlock ? pick('归属不明', 'Unknown') : project.paused && row.selected ? pick('已暂停', 'Paused') : pick('未写入', 'Not written'))
    )))
  );
  const history = (project.history || []).map(row => {
    const at = new Date(row.at);
    const when = Number.isNaN(at.getTime()) ? String(row.at ?? '') : fmtDateTime(at, { hour12: false });
    const who = row.persona ? (state?.personas?.find(p => p.id === row.persona) ? personaName(state.personas.find(p => p.id === row.persona)) : row.persona) : pick('未记录人设', 'Unknown persona');
    return node('div', { class: 'project-history-row' },
      node('span', { class: 'project-history-time' }, when),
      node('strong', {}, row.file || pick('规则文件', 'Rule file')),
      node('span', {}, `${row.action === 'remove' ? pick('移除', 'Remove') : pick('写入', 'Write')} · ${who}`),
      node('span', { class: row.ok === false ? 'project-history-state is-failed' : 'project-history-state' }, row.ok === false ? pick('失败', 'Failed') : pick('完成', 'Done'))
    );
  });
  const historyPanel = history.length ? node('details', { class: 'project-history' },
    node('summary', {}, pick(`本页操作记录 · ${history.length} 条`, `Page activity log · ${history.length}`)),
    node('div', { class: 'project-history-list' }, ...history)
  ) : null;
  $('project-targets').replaceChildren(
    node('p', { class: 'project-persona' },
      persona
        ? pick(`当前待写入人设：${personaName(persona)}（${rulePersona ? '本页指定' : '跟随控制台'}）`, `Persona to write: ${personaName(persona)} (${rulePersona ? 'page override' : 'follows Console'})`)
        : pick('还没有选中人设；规则文件只能预览，不能写入。', 'No persona selected; rule files can only be previewed.')
    ),
    ...cards,
    coverage,
    ...(historyPanel ? [historyPanel] : [])
  );
}
/* ---------------- navigation ---------------- */
const pageFromHash = () => ({ personas: 'library', overview: 'console', rules: 'project' }[location.hash.slice(1)] || location.hash.slice(1) || 'console');
async function navigate(page, { replace = false, focus = true } = {}) {
  if (!['console', 'library', 'diagnostics', 'project', 'settings'].includes(page)) page = 'console';
  if (activePage === 'library' && page !== 'library' && !confirmDiscard()) {
    history.replaceState(null, '', '#library');
    return;
  }
  if (activePage === 'library' && page !== 'library' && editorDirty()) { editor = null; $('editor-form').hidden = true; $('editor-empty').hidden = false; }
  if (page !== 'console' && expanded) closeDrawer({ restore: false });
  activePage = page;
  document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== `page-${page}`; });
  pulseClass($(`page-${page}`), 'is-entering', 360);
  document.querySelectorAll('[data-page]').forEach(el => el.setAttribute('aria-current', el.dataset.page === page ? 'page' : 'false'));
  if (page === 'library' && editor === null && state?.active) openEditor(state.active);
  if (replace || location.hash !== `#${page}`) history[replace ? 'replaceState' : 'pushState'](null, '', `#${page}`);
  if (focus) $('main').focus({ preventScroll: true });
  if (page === 'diagnostics') await loadCapture();
  if (page === 'project') await loadProject(ruleScope === 'project' ? (project?.dir || '') : '');
  if (page === 'settings') renderSettings();
}
window.addEventListener('hashchange', () => navigate(pageFromHash(), { replace: true }));
document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.page)));
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); navigate('console'); });
$('project-load').addEventListener('click', () => loadProject($('project-dir').value.trim()));
$('project-cwd').addEventListener('click', () => loadProject(project?.cwd || ''));
$('project-dir').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  loadProject($('project-dir').value.trim());
});
$('project-recent').addEventListener('click', e => {
  const chip = e.target.closest('[data-project-dir]');
  if (chip) loadProject(chip.dataset.projectDir);
});
document.querySelectorAll('[name="rule-scope"]').forEach(el => el.addEventListener('change', () => {
  ruleScope = el.value === 'global' ? 'global' : 'project';
  loadProject(ruleScope === 'project' ? (project?.dir || '') : '');
}));
$('project-persona-select').addEventListener('change', e => {
  rulePersona = e.target.value;
  loadProject(ruleScope === 'project' ? (project?.dir || '') : '');
});

/* ---------------- settings ---------------- */
function renderSettings() {
  const s = state?.settings;
  if (!s) return;
  if ($('language-select')) $('language-select').value = s.language || 'auto';
  const desktop = s.desktop || {};
  const webdav = s.webdav || {};
  $('close-action').value = desktop.exitOnClose === false ? 'stay' : 'exit';
  $('confirm-close').checked = desktop.confirmOnClose !== false;
  const badge = $('desktop-mode-badge');
  const managed = Boolean(state.settingsDesktop?.managed);
  badge.textContent = managed ? pick('桌面端 · 窗口形态', 'Desktop · Window') : pick('终端托管', 'Terminal Managed');
  badge.className = `pill ${managed ? 'is-good' : ''}`;
  $('desktop-mode-badge').title = managed
    ? pick('双击 exe / 桌面图标启动：关闭窗口的行为由下面这项决定', 'Launched via desktop shortcut / executable: window close behavior is controlled below')
    : pick('当前是命令行启动的 web 服务，关窗退出不适用（由终端托管）', 'Launched from CLI; window-close exit does not apply (managed by terminal)');

  $('webdav-url').value = webdav.url || '';
  $('webdav-dir').value = webdav.dir || 'agent-purge';
  $('webdav-username').value = webdav.username || '';
  $('webdav-password').value = '';
  $('webdav-password').placeholder = webdav.hasPassword ? t('settings.webdavPasswordKeep') : t('settings.webdavPasswordUnset');
  $('backup-stamp').textContent = webdav.lastBackupAt
    ? pick(`上次备份 ${fmtDateTime(webdav.lastBackupAt)}`, `Last backup ${fmtDateTime(webdav.lastBackupAt)}`)
    : pick('还没有备份过', 'No backups yet');
}

function settingsStatus(id, message, kind = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.className = `hint${kind ? ` is-${kind}` : ''}`;
}

$('save-language')?.addEventListener('click', () => operation(async () => {
  const result = await api('settings', { language: $('language-select').value });
  state.settings = result.settings;
  if (result.locale) {
    setLocale(result.locale);
    applyDomI18n();
  }
  render();
  settingsStatus('language-status', t('settings.languageSaved'), 'good');
  notify(t('settings.languageSaved'), 'good');
}));

$('save-desktop')?.addEventListener('click', () => operation(async () => {
  const result = await api('settings', {
    desktop: { exitOnClose: $('close-action').value === 'exit', confirmOnClose: $('confirm-close').checked },
  });
  state.settings = result.settings;
  renderSettings();
  settingsStatus('desktop-status', pick('已保存；下一次关窗就按新方式处理。', 'Saved; applies on next window close.'));
  notify(pick('窗口设置已保存。', 'Window settings saved.'), 'good');
}));

async function saveWebdav({ test = false } = {}) {
  const payload = { webdav: { url: $('webdav-url').value.trim(), dir: $('webdav-dir').value.trim(), username: $('webdav-username').value.trim() } };
  const password = $('webdav-password').value;
  if (password) payload.webdav.password = password;
  const saved = await api('settings', payload);
  state.settings = saved.settings;
  $('webdav-password').value = '';
  renderSettings();
  if (!test) return saved;
  const result = await api('webdav', { action: 'test' });
  settingsStatus('webdav-status', result.willCreateDir
    ? pick(`连接正常（首次备份时将自动创建目录）：${result.url}`, `Connected (remote dir will be created on first backup): ${result.url}`)
    : pick(`连接正常：${result.url}`, `Connected: ${result.url}`), 'good');
  return saved;
}

async function runWebdavUi(pendingText, work) {
  settingsStatus('webdav-status', pendingText);
  try {
    return await work();
  } catch (error) {
    settingsStatus('webdav-status', error.message, 'bad');
    throw error;
  }
}

$('webdav-save')?.addEventListener('click', () => operation(() => runWebdavUi(pick('正在测试连接…', 'Testing connection…'), async () => {
  await saveWebdav({ test: true });
  notify(pick('WebDAV 设置已保存，连接正常。', 'WebDAV settings saved; connection OK.'), 'good');
})));

$('webdav-backup')?.addEventListener('click', () => operation(() => runWebdavUi(pick('正在备份…', 'Backing up…'), async () => {
  await saveWebdav();
  const result = await api('webdav', { action: 'backup' });
  state.settings = (await api('settings')).settings;
  renderSettings();
  settingsStatus('webdav-status', pick(`已备份 ${result.files} 个文件（${fmt(result.bytes)} 字节）→ ${result.remote}`, `Backed up ${result.files} file(s) (${fmt(result.bytes)} bytes) → ${result.remote}`), 'good');
  notify(pick('备份完成。', 'Backup complete.'), 'good');
})));

$('webdav-restore')?.addEventListener('click', () => operation(async () => {
  if (!$('webdav-url').value.trim()) throw new Error(pick('先填 WebDAV 地址', 'Enter WebDAV URL first'));
  if (!confirm(pick('恢复会用远端备份覆盖本机的人设与设置（会先在本地 backups/ 留一份快照）。继续？', 'Restore will overwrite local personas and settings with the remote backup (a local snapshot will be saved in backups/ first). Continue?'))) return;
  await runWebdavUi(pick('正在恢复…', 'Restoring…'), async () => {
    await saveWebdav();
    const result = await api('webdav', { action: 'restore', confirm: true });
    await refresh({ resetDraft: true });
    renderSettings();
    settingsStatus('webdav-status', pick(`已恢复 ${result.written.length} 个文件；本地快照：${result.snapshot || '未创建'}`, `Restored ${result.written.length} file(s); local snapshot: ${result.snapshot || 'none'}`), 'good');
    notify(pick('已从备份恢复，请检查人设与设置。', 'Restored from backup; please review personas and settings.'), 'good');
  });
}));
$('project-targets').addEventListener('click', e => {
  const btn = e.target.closest('[data-project-action]');
  if (!btn || btn.disabled || !project) return;
  const file = btn.dataset.projectFile;
  const id = btn.dataset.projectId || '';
  const action = btn.dataset.projectAction;
  const scope = project.scope === 'global' ? 'global' : 'project';
  operation(async () => {
    const sha = project?.targets?.find(t => t.file === file && (!id || t.id === id))?.sha ?? null;
    const result = await api('project', {
      scope,
      ...(scope === 'project' ? { dir: project.dir } : { id }),
      file,
      action,
      sha,
      ...(rulePersona ? { persona: rulePersona } : {}),
    });
    project = result.view;
    renderProject();
    announce(result.results ?? result.result, result.ok
      ? (action === 'on' ? pick(`${file} 已写入（追加托管块），随时可移除。`, `${file} updated (managed block appended); removable anytime.`) : pick(`${file} 的托管块已移除。`, `Managed block removed from ${file}.`))
      : pick('规则文件未改变。', 'Rule file unchanged.'));
  });
});

/* ---------------- console events ---------------- */
$('persona-select').addEventListener('change', () => {
  draft.persona = $('persona-select').value;
  const p = state.personas.find(p => p.id === draft.persona);
  $('current-persona').textContent = personaName(p);
  $('current-mode').textContent = pick(`${fmt(p?.chars)} 字 · ${state.personas.length} 份可用`, `${fmt(p?.chars)} chars · ${state.personas.length} available`);
  $('persona-description').textContent = p?.meta?.description || p?.meta?.desc || pick('这份人设没有写说明。', 'No description for this persona.');
  pulseClass($('current-persona'), 'is-swapping', 400);
  pulseClass(document.querySelector('.command-bar'), 'is-wiping', 560);
  renderConfigControls();
});
document.querySelectorAll('[name=mode]').forEach(el => el.addEventListener('change', () => { draft.mode = mode(); renderConfigControls(); }));
$('quick-pull-btn')?.addEventListener('click', () => $('import-dialog')?.showModal());
$('quick-new-btn')?.addEventListener('click', () => { navigate('library'); $('new-persona')?.click(); });
$('edit-current').addEventListener('click', () => { openEditor(draft.persona); navigate('library'); });
$('new-persona').addEventListener('click', () => openEditor(''));

$('batch-actions-select')?.addEventListener('change', async e => {
  const val = e.target.value;
  if (!val) return;
  e.target.value = '';
  operation(async () => {
    if (val === 'enable-ready') {
      const ready = state.harnesses.filter(h => h.supported && (h.found || h.homeExists) && !consoleOn(h));
      const done = [];
      for (const h of ready) {
        const channel = ['install', 'slash', 'shim'].find(c => h.caps?.[c]?.ok);
        if (!channel) continue;
        await api('arm', { harness: h.id, channel, action: 'on' });
        done.push(harnessTitle(h.id));
      }
      await refresh();
      notify(done.length ? pick(`已开启：${listJoin(done)}。`, `Enabled: ${listJoin(done)}.`) : pick('没有可以一键开启的工具。', 'No ready tools to enable.'), done.length ? 'good' : '');
    } else if (val === 'disable-all') {
      $('disarm-all')?.click();
    } else if (val === 'mode-preferred') {
      const active = state.harnesses.filter(h => h.supported && consoleOn(h));
      for (const h of active) {
        const avail = modeAvailability(h);
        const target = avail.preferred || (avail.supported.has('replace') ? 'replace' : 'append');
        await api('harness', { harness: h.id, mode: target });
      }
      await refresh();
      notify(pick('已恢复各家推荐的改写力度。', 'Restored recommended modes.'), 'good');
    } else if (val === 'mode-replace' || val === 'mode-strict') {
      const target = val === 'mode-replace' ? 'replace' : 'strict';
      const active = state.harnesses.filter(h => h.supported && consoleOn(h) && modeAvailability(h).supported.has(target));
      for (const h of active) await api('harness', { harness: h.id, mode: target });
      await refresh();
      notify(pick(`已把 ${active.length} 个工具改为「${MODE_LABELS[target]}」。`, `Set ${active.length} tool(s) to "${MODE_LABELS[target]}".`), 'good');
    }
  });
});

$('reset-config').addEventListener('click', () => { draft = { ...base }; draftConflict = false; render(); });
$('config-form').addEventListener('submit', e => {
  e.preventDefault();
  operation(async () => {
    $('apply').textContent = t('console.applying');
    const result = await api('apply', {
      persona: draft.persona,
      mode: state.paused ? 'off' : draft.mode,
      ...(state.defaultsSet === false ? { harness: state.defaults.harness } : {}),
      ...(state.paused ? { resumeMode: draft.mode } : {})
    });
    await refresh({ resetDraft: result.ok === true });
    pulseClass(document.querySelector('.command-bar'), 'is-wiping', 560);
    pulseClass($('coverage-strip'), 'is-updating', 600);
    announce(result, state.paused ? pick('配置已保存，当前仍处于暂停状态。', 'Configuration saved; still paused.') : pick('已应用。新开的会话会读取，运行中的会话看各家提示。', 'Applied. New sessions will pick it up; check tool notes for running sessions.'));
  });
});
$('power').addEventListener('click', () => operation(async () => {
  const on = state.paused;
  const result = await api('power', { on });
  await refresh();
  announce(result, on ? pick('已恢复全部工具的人设注入。', 'Resumed persona injection for all tools.') : pick('已暂停全部工具；现有配置已安全复原。', 'Paused all tools; original configurations restored safely.'));
}));
$('disarm-all').addEventListener('click', () => {
  if (!window.confirm(pick(
    '停用所有已接管的工具？\n\n会撤销系统提示词配置、插件与命令别名，并按原字节还原原厂文件。\n项目规则不在其中，需到「项目规则」页单独移除。\n人设和用户修改会保留，不会卸载 agent-purge 本身。',
    'Disable all managed tools?\n\nThis will revoke system prompt configs, plugins, and CLI shims, restoring original files byte-for-byte.\nProject rule files are not included—remove them on the Rule Files page.\nYour personas and custom edits are preserved; agent-purge itself is not uninstalled.',
  ))) return;
  operation(async () => {
    const res = await api('clean', { keepProject: true });
    await refresh();
    if (res.ok) notify(pick('已撤销全部接管：原厂文件已还原，人设和用户修改已保留。', 'All targets disarmed: original files restored, personas and edits kept.'), 'good');
    else notify(pick(`部分项目撤销失败：${(res.leftovers || []).join('；')}`, `Some items failed to disarm: ${(res.leftovers || []).join('; ')}`), 'warn');
  });
});
$('refresh').addEventListener('click', () => operation(async () => { await refresh(); notify(pick('状态已刷新，未保存的选择保持不变。', 'Status refreshed; unsaved selections kept.')); }));
$('show-all').addEventListener('change', renderHarnesses);

const setHarnessArmed = async (id, on, resetCheckbox = null) => {
  if (on && ['workbuddy', 'workbuddy-ai', 'antigravity', 'zcode'].includes(id)) {
    const confirmed = await confirmHarnessArm(id);
    if (!confirmed) {
      if (resetCheckbox) resetCheckbox.checked = false;
      return;
    }
  }
  operation(async () => {
    const result = await api('arm', { harness: id, channel: 'auto', action: on ? 'on' : 'off' });
    await refresh();
    pulseClass(document.querySelector(`.tool-card[data-id="${CSS.escape(id)}"]`), 'is-toggled', 520);
    pulseClass($('coverage-strip'), 'is-updating', 600);
    announce(result, on ? pick(`${harnessTitle(id)} 已开启接管。`, `${harnessTitle(id)} enabled.`) : pick(`${harnessTitle(id)} 已停止接管并还原原厂文件。`, `${harnessTitle(id)} disabled and original files restored.`));
  });
};

const onToolsClick = async e => {
  if (e.target.closest('#close-drawer')) { closeDrawer(); return; }
  if (e.target.closest('.switch')) return;
  const drawerToggle = e.target.closest('[data-drawer-toggle]');
  if (drawerToggle) {
    const id = drawerToggle.dataset.drawerToggle;
    const h = state?.harnesses?.find(item => item.id === id);
    if (h) await setHarnessArmed(id, !consoleOn(h));
    return;
  }
  const verifyBtn = e.target.closest('[data-verify]');
  if (verifyBtn) {
    const id = verifyBtn.dataset.verify;
    operation(async () => {
      notify(pick(`正在临时环境里试跑 ${harnessTitle(id)}，最多等一分钟…`, `Testing ${harnessTitle(id)} in an isolated environment (up to 1 min)…`), 'muted');
      const r = await api('verify', { harness: id });
      try { capture = await api('verification'); } catch { /* 报告读不到就保持旧的 */ }
      await refresh();
      const ev = r.assessment ? (evidenceMap()[r.assessment.state]?.[0] || r.assessment.label) : evidenceOf(captureFor(id)).label;
      notify(pick(
        `${harnessTitle(id)}：${ev} · ${whereLabel(r.scope)}${r.reason ? `；${r.reason}` : ''}。不代表当前会话已生效。`,
        `${harnessTitle(id)}: ${ev} · ${whereLabel(r.scope)}${r.reason ? `; ${r.reason}` : ''}. Does not reflect active sessions.`,
      ), ['verified', 'off-verified'].includes(r.assessment?.state) ? 'good' : 'warn');
    });
    return;
  }
  const followMode = e.target.closest('[data-mode-follow]');
  if (followMode) {
    operation(async () => {
      const result = await api('harness', { harness: followMode.dataset.modeFollow, mode: 'follow' });
      await refresh();
      announce(result, pick(`${harnessTitle(followMode.dataset.modeFollow)} 恢复跟随全局力度。`, `${harnessTitle(followMode.dataset.modeFollow)} now follows global mode.`));
    });
    return;
  }
  const channelBtn = e.target.closest('[data-channel]');
  if (channelBtn) {
    operation(async () => {
      const result = await api('arm', { harness: channelBtn.dataset.target, channel: channelBtn.dataset.channel, action: channelBtn.dataset.enabled === 'true' ? 'on' : 'off' });
      await refresh();
      pulseClass(document.querySelector(`.tool-card[data-id="${CSS.escape(channelBtn.dataset.target)}"]`), 'is-toggled', 520);
      announce(result, pick('接管方式已更新。首次安装或更新扩展后请重新加载客户端。', 'Channel updated. Reload the client after installing or updating an extension.'));
    });
    return;
  }
  const expand = e.target.closest('[data-expand]');
  if (expand) { selectTarget(expand.dataset.expand, { focusClose: e.detail === 0 }); return; }
};
document.querySelector('.target-console').addEventListener('click', onToolsClick);
$('drawer-backdrop').addEventListener('click', () => closeDrawer());
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && expanded) {
    e.preventDefault();
    closeDrawer();
  }
});
$('harness-search').addEventListener('input', e => {
  targetQuery = e.target.value.trim().toLowerCase();
  renderHarnesses();
});
$('harness-search').addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown') return;
  const firstBtn = document.querySelector('.tool-card .tool-card-more');
  if (!firstBtn) return;
  e.preventDefault();
  firstBtn.focus();
});
document.querySelectorAll('.filter-chip').forEach(btn => btn.addEventListener('click', () => {
  targetFilter = btn.dataset.filter;
  document.querySelectorAll('.filter-chip').forEach(chip => {
    const active = chip === btn;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  renderHarnesses();
}));
function confirmHarnessArm(id) {
  const dialog = $('confirm-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(true);
  const purgeInfo = HARNESS_PURGE_EFFECTS[id];
  $('confirm-harness-title').textContent = harnessTitle(id);
  $('confirm-harness-badge').textContent = purgeInfo?.typeLabel || pick('配置托管', 'Config');
  dialog.showModal();
  return new Promise(resolve => {
    let settled = false;
    const finish = val => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('close', onClose);
      $('cancel-confirm')?.removeEventListener('click', onCancel);
      $('close-confirm')?.removeEventListener('click', onCancel);
      $('confirm-form')?.removeEventListener('submit', onSubmit);
      resolve(val);
    };
    const onCancel = e => { e?.preventDefault(); dialog.close(); finish(false); };
    const onSubmit = e => { e?.preventDefault(); dialog.close(); finish(true); };
    const onClose = () => finish(false);
    $('cancel-confirm')?.addEventListener('click', onCancel);
    $('close-confirm')?.addEventListener('click', onCancel);
    $('confirm-form')?.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose, { once: true });
  });
}

const onToolsChange = async e => {
  const el = e.target;
  if (el.dataset.hpersona) {
    const pick = el.value;
    operation(async () => {
      const result = await api('harness', { harness: el.dataset.hpersona, persona: pick || 'follow' });
      await refresh();
      announce(result, pick ? pick(`${harnessTitle(el.dataset.hpersona)} 改用这份人设。`, `${harnessTitle(el.dataset.hpersona)} now uses this persona.`) : pick(`${harnessTitle(el.dataset.hpersona)} 恢复跟随全局人设。`, `${harnessTitle(el.dataset.hpersona)} now follows global persona.`));
    });
    return;
  }
  if (el.dataset.hmode) {
    const pick = el.value;
    operation(async () => {
      const result = await api('harness', { harness: el.dataset.hmode, mode: pick || 'follow' });
      await refresh();
      announce(result, pick === 'follow' ? pick(`${harnessTitle(el.dataset.hmode)} 恢复跟随全局力度。`, `${harnessTitle(el.dataset.hmode)} now follows global mode.`) : pick(`${harnessTitle(el.dataset.hmode)} 的力度改为「${MODE_LABELS[pick] || pick}」。`, `${harnessTitle(el.dataset.hmode)} mode set to "${MODE_LABELS[pick] || pick}".`));
    });
    return;
  }
  if (el.dataset.toggle) {
    await setHarnessArmed(el.dataset.toggle, el.checked, el);
    return;
  }
  if (el.dataset.auto) operation(async () => { await api(`${el.dataset.auto}-auto`, { on: el.checked }); await refresh(); notify(pick('自动应用设置已更新。', 'Auto-apply setting updated.'), 'good'); });
  if (el.dataset.profile) operation(async () => { await api('dsh-profile', { profile: el.dataset.profile, on: el.checked }); await refresh(); notify(pick('dsh 生效形态已更新。', 'dsh profiles updated.'), 'good'); });
};
document.querySelector('.target-console').addEventListener('change', onToolsChange);

$('default-form').addEventListener('submit', e => {
  e.preventDefault();
  operation(async () => { const result = await api('defaults', { harness: $('default-harness').value || null }); await refresh(); announce(result, pick('启动首选项已保存，接管范围没有改变。', 'Launch preference saved; managed targets unchanged.')); });
});

/* ---------------- library events ---------------- */
$('persona-search').addEventListener('input', renderPersonas);
$('persona-list').addEventListener('click', e => { const el = e.target.closest('[data-persona]'); if (el) openEditor(el.dataset.persona); });
$('editor-form').addEventListener('input', renderEditorStatus);
$('editor-form').addEventListener('submit', e => { e.preventDefault(); saveEditor(false); });
$('save-apply').addEventListener('click', () => saveEditor(true));
$('delete-persona').addEventListener('click', () => {
  if (!confirm(pick(`删除人设「${editor}」？${editor === state.active ? '当前人设会回退并同步到已接管的工具。' : ''}`, `Delete persona "${editor}"?${editor === state.active ? ' The active persona will fall back and sync to managed tools.' : ''}`))) return;
  operation(async () => {
    const result = await api(`persona?id=${encodeURIComponent(editor)}`, null, 'DELETE');
    editor = null; editorBaseline = '';
    $('editor-form').hidden = true; $('editor-empty').hidden = false;
    await refresh({ resetDraft: true });
    announce(result, pick('人设已删除。', 'Persona deleted.'));
  });
});

/* ---------------- import ---------------- */
const importDialog = $('import-dialog');
const importStatus = $('import-status');
const importSourceInput = $('import-source');
const startImportBtn = $('start-import');
$('pull-personas')?.addEventListener('click', () => {
  if (!importDialog) return;
  if (!importSourceInput.value.trim()) importSourceInput.value = 'ZiChuanLan/some-magic';
  importStatus.hidden = true; importStatus.className = 'status-box'; importStatus.textContent = '';
  startImportBtn.disabled = false; startImportBtn.textContent = t('import.start');
  importDialog.showModal();
});
$('close-import')?.addEventListener('click', () => importDialog?.close());
$('cancel-import')?.addEventListener('click', () => importDialog?.close());
importDialog?.addEventListener('click', e => {
  const pill = e.target.closest('[data-preset]');
  if (pill) { importSourceInput.value = pill.dataset.preset; importSourceInput.focus(); }
});
$('import-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const source = importSourceInput.value.trim();
  if (!source) return;
  const overwrite = $('import-overwrite').checked;
  startImportBtn.disabled = true; startImportBtn.textContent = t('import.pulling');
  importStatus.hidden = false; importStatus.className = 'status-box';
  importStatus.textContent = pick(`正在从 ${source} 拉取…`, `Pulling from ${source}…`);
  try {
    const res = await api('persona/import', { source, overwrite });
    if (!res.ok) throw new Error(res.error || pick('拉取失败', 'Pull failed'));
    const { total = 0, imported = [] } = res.result || {};
    importStatus.className = 'status-box success';
    const names = listJoin(imported.map(x => x.name || x.id).slice(0, 3));
    importStatus.textContent = pick(
      `导入 ${total} 个人设${names ? `（${names}${imported.length > 3 ? ' 等' : ''}）` : ''}。`,
      `Imported ${total} persona(s)${names ? ` (${names}${imported.length > 3 ? ', etc.' : ''})` : ''}.`,
    );
    await refresh();
    notify(pick(`已拉取 ${total} 个人设。`, `Pulled ${total} persona(s).`), 'good');
    setTimeout(() => importDialog?.close(), 1200);
  } catch (err) {
    importStatus.className = 'status-box error';
    importStatus.textContent = pick(`导入失败：${err.message}`, `Import failed: ${err.message}`);
    notify(pick(`人设导入失败：${err.message}`, `Persona import failed: ${err.message}`), 'error');
  } finally {
    startImportBtn.disabled = false; startImportBtn.textContent = t('import.start');
  }
});

/* ---------------- diagnostics ---------------- */
$('sync-all').addEventListener('click', () => operation(async () => { const r = await api('sync', {}); await refresh(); announce(r, pick('已按原范围重新同步。', 'Re-synced active targets.')); }));
$('retry-failed').addEventListener('click', () => operation(async () => { const r = await api('sync', { onlyFailed: true }); await refresh(); announce(r, pick('失败项已重试。', 'Retried failed targets.')); }));

/* ---------------- update ---------------- */
let cachedUpdateInfo = null;
function showUpdateDialog(res) {
  const dialog = $('update-dialog');
  if (!dialog) return;
  $('update-current-tag').textContent = t('update.currentTag', { version: res.current });
  const gitBehind = Number(res.git?.behind) || 0;
  const sameVersion = !res.latest || res.latest === res.current;
  $('update-latest-tag').textContent = sameVersion && gitBehind
    ? pick(`上游 ${gitBehind} 个新提交`, `${gitBehind} upstream commit(s)`)
    : t('update.latestTag', { version: res.latest });
  const sources = [];
  if (res.npm?.ok && res.npm?.latest === res.latest) sources.push('npm');
  if (res.github?.ok && res.github?.latest === res.latest) sources.push('GitHub');
  if (res.installType === 'git') sources.push('git');
  $('update-source-label').textContent = sources.length ? pick(`来源 ${sources.join(' / ')}`, `via ${sources.join(' / ')}`) : '';
  const changelog = (res.github?.body || res.body || '').trim();
  $('update-changelog-text').textContent = changelog || pick('暂无详细发布说明。', 'No release notes available.');
  $('update-changelog-box').hidden = !changelog;

  const type = res.installType || (res.isExe ? 'exe' : 'npm');
  const cmdBox = $('update-command-box');
  const doBtn = $('btn-do-upgrade');
  const statusEl = $('update-status');
  statusEl.hidden = true; statusEl.textContent = ''; statusEl.className = 'status-box';
  if (type === 'exe') {
    cmdBox.hidden = true; doBtn.textContent = pick('一键就地升级', 'Upgrade in Place'); doBtn.title = pick('自动下载新版 EXE 并热替换', 'Download and replace executable automatically');
  } else if (type === 'git') {
    cmdBox.hidden = false; $('update-command-text').textContent = 'git pull --ff-only';
    doBtn.textContent = pick('一键 git 更新', 'Git Pull Now'); doBtn.title = pick('在安装目录执行 git pull --ff-only', 'Run git pull --ff-only in install directory');
    const git = res.git || {};
    if (git.dirty) {
      statusEl.hidden = false; statusEl.className = 'status-box error';
      statusEl.textContent = pick(`工作区有 ${git.dirty} 处未提交改动：先提交或撤销，更新会拒绝执行。`, `Working tree has ${git.dirty} uncommitted change(s); commit or discard before updating.`);
    } else if (git.branch) {
      statusEl.hidden = false;
      statusEl.textContent = pick(`当前分支 ${git.branch}${git.upstream ? ` → ${git.upstream}` : '（没有上游）'}；更新只做快进合并。`, `Branch ${git.branch}${git.upstream ? ` → ${git.upstream}` : ' (no upstream)'}; fast-forward only.`);
    }
  } else {
    cmdBox.hidden = false; $('update-command-text').textContent = res.npm?.command || 'npm install -g agent-purge@latest';
    doBtn.textContent = pick('一键 npm 升级', 'Upgrade via npm'); doBtn.title = pick('后台调用 npm 全局更新', 'Run global npm update in background');
  }
  doBtn.disabled = false;
  const ghLink = $('update-github-link');
  if (ghLink) ghLink.href = res.htmlUrl || 'https://github.com/ZiChuanLan/agent-purge/releases/latest';
  dialog.showModal();
}

async function checkAppUpdate(force = false) {
  const vb = $('version-badge');
  if (!vb) return;
  try {
    const res = await api(`update${force ? '?force=1' : ''}`);
    if (!res.ok) {
      vb.textContent = `v${res.current || state?.version || pick('未知', 'unknown')}`;
      if (force) notify(pick(`检查更新失败：${res.error || '网络异常'}`, `Update check failed: ${res.error || 'network error'}`), 'warn');
      return;
    }
    cachedUpdateInfo = res;
    vb.textContent = `v${res.current}`;
    const behind = Number(res.git?.behind) || 0;
    const versionAhead = res.latest && res.latest !== res.current;
    if (res.hasUpdate) {
      vb.className = 'version is-new';
      vb.textContent = versionAhead ? `v${res.current} → v${res.latest}` : pick(`v${res.current} · 上游 ${behind} 个新提交`, `v${res.current} · ${behind} new commit(s)`);
      vb.title = versionAhead ? pick(`有新版本 v${res.latest}，点击查看并升级`, `New version v${res.latest} available; click to upgrade`) : pick(`上游有 ${behind} 个新提交，点击一键 git 更新`, `${behind} new upstream commit(s); click to pull`);
      if (force) showUpdateDialog(res);
    } else {
      vb.className = 'version';
      vb.title = pick(`v${res.current} 已是最新，点击重新检查`, `v${res.current} is up to date; click to re-check`);
      if (force) notify(pick(`已是最新版本 v${res.current}。`, `Already on latest version v${res.current}.`), 'good');
    }
  } catch { /* 离线或后台探测失败不阻碍主界面 */ }
}

$('version-badge')?.addEventListener('click', () => {
  if (cachedUpdateInfo?.hasUpdate) showUpdateDialog(cachedUpdateInfo);
  else checkAppUpdate(true);
});
$('close-update')?.addEventListener('click', () => $('update-dialog')?.close());
$('dismiss-update')?.addEventListener('click', () => $('update-dialog')?.close());
$('copy-update-command')?.addEventListener('click', () => {
  const cmd = $('update-command-text')?.textContent;
  if (cmd) navigator.clipboard?.writeText(cmd).then(() => notify(pick('升级命令已复制。', 'Upgrade command copied.'), 'good')).catch(() => {});
});
$('btn-do-upgrade')?.addEventListener('click', async () => {
  if (!cachedUpdateInfo) return;
  const doBtn = $('btn-do-upgrade');
  const statusEl = $('update-status');
  const type = cachedUpdateInfo.installType || (cachedUpdateInfo.isExe ? 'exe' : 'npm');
  const busyText = type === 'exe' ? pick('正在下载替换…', 'Downloading…') : type === 'git' ? pick('正在 git pull…', 'Running git pull…') : pick('正在 npm 升级…', 'Updating via npm…');
  const waitText = type === 'exe' ? pick('正在下载新版并热替换，请稍候…', 'Downloading new version and replacing executable…') : type === 'git' ? pick('正在安装目录执行 git pull --ff-only…', 'Running git pull --ff-only in install directory…') : pick('正在调用 npm 全局更新，可能需要十几秒…', 'Running global npm update; this may take a few seconds…');
  const retryText = type === 'exe' ? pick('重试就地升级', 'Retry Upgrade') : type === 'git' ? pick('重试 git 更新', 'Retry git pull') : pick('重试 npm 升级', 'Retry npm update');
  doBtn.disabled = true; doBtn.textContent = busyText;
  statusEl.hidden = false; statusEl.className = 'status-box'; statusEl.textContent = waitText;
  try {
    const res = await api('update-upgrade', { type });
    if (res.ok) {
      statusEl.className = 'status-box success';
      statusEl.textContent = res.message || pick('升级成功。', 'Upgrade complete.');
      doBtn.textContent = pick('升级完成', 'Upgraded');
      notify(res.message || pick('升级成功。', 'Upgrade complete.'), 'good');
      setTimeout(() => { $('update-dialog')?.close(); checkAppUpdate(true); }, 2500);
    } else {
      statusEl.className = 'status-box error';
      statusEl.textContent = `${res.error || pick('更新失败', 'Update failed')}${res.output ? `\n${res.output}` : ''}`;
      doBtn.disabled = false; doBtn.textContent = retryText;
    }
  } catch (err) {
    statusEl.className = 'status-box error';
    statusEl.textContent = err.message || pick('网络请求异常', 'Network request failed');
    doBtn.disabled = false; doBtn.textContent = retryText;
  }
});

/* ---------------- lifecycle ---------------- */
$('exit-btn')?.addEventListener('click', async () => {
  if (configDirty() || editorDirty()) {
    if (!confirm(t('exit.confirmUnsaved'))) return;
  }
  document.body.dataset.exiting = '1';
  setConnection(t('conn.stopped'), 'is-down');
  notify(t('exit.stopping'), 'muted');
  try { await fetch('/api/exit', { method: 'POST', keepalive: true }); } catch {}
  setTimeout(() => window.close(), 200);
});
setInterval(() => { fetch('/api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {}); }, 2500);
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  try {
    const gen = document.querySelector('meta[name="ap-server-gen"]')?.getAttribute('content') ?? '';
    const target = `/api/leave?gen=${encodeURIComponent(gen)}`;
    if (navigator.sendBeacon) navigator.sendBeacon(target);
    else fetch(target, { method: 'POST', keepalive: true }).catch(() => {});
  } catch {}
});
window.addEventListener('beforeunload', e => {
  // 关窗确认只在「关掉这扇桌面窗口」时有意义：终端托管的 web 页面和主动点退出都不拦
  const wantConfirm = state?.settingsDesktop?.managed === true
    && state?.settings?.desktop?.confirmOnClose !== false
    && !document.body.dataset.exiting;
  if (wantConfirm || configDirty() || editorDirty()) { e.preventDefault(); e.returnValue = ''; }
});

refresh().then(() => navigate(pageFromHash(), { replace: true, focus: false })).then(() => checkAppUpdate(false)).catch(error => {
  setConnection(t('conn.disconnected'), 'is-down');
  notify(t('conn.disconnectedNotice', { error: error.message }), 'error');
});
