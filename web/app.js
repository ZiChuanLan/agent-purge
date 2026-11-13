import { MODE_LABELS, MODE_DESCRIPTIONS, CHANNEL_LABELS, CAPTURE_LABELS, personaName, configurationOf, changed, needsApply, sortedHarnesses, effectLabel as effectLabelFor, harnessTitle, HARNESS_PURGE_EFFECTS, modeAvailability, unsupportedHarnesses } from './model.mjs';
import { verificationEvidence } from './evidence.mjs';

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
const fmt = n => Number(n || 0).toLocaleString('zh-CN');
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
const CHANNEL_SHORT = { install: '配置', slash: '插件', shim: '命令', project: '项目' };
const INSTALL_SOURCE = { shortcut: '开始菜单快捷方式', registry: '注册表卸载项', guess: '盘符扫描', scan: '盘内浅扫' };
const CHANNEL_STATIC = {
  install: '写进这家自己的配置或插件，新开的会话读取。',
  slash: '装上扩展后，在会话里执行 /purge on 开启；同一会话里可以换人设。',
  shim: '接管终端里的同名命令，启动时自动注入；桌面图标不受影响。',
  project: '写进当前项目目录的规则文件，只影响这个目录。'
};
const EVIDENCE = {
  verified: ['命中人设', 'is-on'],
  'off-verified': ['暂停干净', ''],
  partial: ['部分命中', 'is-warn'],
  miss: ['请求未命中', 'is-warn'],
  'no-request': ['没抓到请求', 'is-fixed'],
  unavailable: ['没找到入口', 'is-fixed'],
  blocked: ['被挡住', 'is-bad'],
  error: ['运行出错', 'is-bad'],
  mismatch: ['仍有残留', 'is-bad'],
  invalid: ['没有有效证据', 'is-bad'],
  'not-tested': ['没试过', '']
};

const captureFor = id => (capture?.report?.results ?? []).find(r => r.harness === id) || null;
const evidenceOf = result => {
  const ev = verificationEvidence(result);
  const [label, kind] = EVIDENCE[ev.state] || [ev.label, ''];
  return { ...ev, label, chipClass: kind };
};
const whereLabel = scope => {
  if (scope?.kind === 'isolated-cli') return `临时环境${scope.profile ? ` · ${scope.profile}` : ''}`;
  if (scope?.kind === 'isolated-session') return `临时会话${scope.profile ? ` · ${scope.profile}` : ''}`;
  return '临时环境';
};
const mode = () => draft?.mode || 'replace';
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
  let result; try { result = await response.json(); } catch { throw new Error('本地服务返回了无效内容，请确认它还在运行。'); }
  if (!response.ok || result.error) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}
function announce(result, success) {
  const report = result.applied || result;
  if (report.ok === false) {
    const failed = report.results?.filter(r => r.status === 'failed' || r.ok === false) || [];
    notify(`${report.partial ? '部分写入成功。' : '操作没有全部完成。'}${failed.map(r => `${harnessTitle(r.harness)}：${r.error}`).join('；') || '详情见「测试与记录」。'}`, 'warn');
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
  base = configurationOf(state);
  if (!preserve) draft = { ...base };
  setConnection(`已连接 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`, 'is-live');
  render();

}

function render() {
  const p = state.personas.find(p => p.id === state.active);
  $('current-persona').textContent = personaName(p);
  $('current-mode').textContent = `${fmt(p?.chars)} 字 · ${state.personas.length} 份可用`;
  $('persona-description').textContent = p?.meta?.description || p?.meta?.desc || '这份人设没有写说明。';
  const activeCount = state.harnesses.filter(consoleOn).length;
  $('scope-count').textContent = String(activeCount);
  const consoleTargets = state.harnesses.filter(isReadyTarget);
  $('scope-total').textContent = String(consoleTargets.length);
  $('coverage-strip').replaceChildren(...consoleTargets.map(h => node('i', { class: consoleOn(h) ? (state.paused ? 'is-warn' : 'is-on') : '' })));
  $('coverage-strip').title = `${activeCount} / ${consoleTargets.length} 个已就绪工具已启用`;

  $('power-status').textContent = state.paused ? '已暂停' : '配置启用';
  $('power-status').className = `pill ${state.paused ? 'is-warn' : 'is-good'}`;
  $('power').textContent = state.paused ? '恢复全部' : '暂停全部';
  $('power').title = state.paused ? '恢复所有工具的人设注入' : '暂停全部工具的人设注入；只暂停某一家，在它的详情里选「暂停这家」';
  $('power').disabled = false;
  $('disarm-all').disabled = activeCount === 0;

  $('persona-select').replaceChildren(...state.personas.map(p => new Option(`${personaName(p)} · ${fmt(p.chars)} 字`, p.id)));
  $('persona-select').value = draft.persona;
  $('persona-select').disabled = false;

  const projectPersonaSelect = $('project-persona-select');
  if (projectPersonaSelect) {
    const activePersona = state.personas.find(item => item.id === state.active);
    const keepVal = rulePersona && state.personas.some(item => item.id === rulePersona) ? rulePersona : '';
    projectPersonaSelect.replaceChildren(
      new Option(`跟随当前人设（${personaName(activePersona)}）`, ''),
      ...state.personas.map(item => new Option(`${personaName(item)} · ${fmt(item.chars)} 字`, item.id))
    );
    projectPersonaSelect.value = keepVal;
    rulePersona = keepVal;
  }

  document.querySelectorAll('[name=mode]').forEach(el => { el.checked = el.value === draft.mode; });

  const defaults = $('default-harness');
  defaults.replaceChildren(new Option('未设置', ''), ...state.harnesses.filter(h => h.oneshot && h.supported).map(h => new Option(`${harnessTitle(h.id)}${h.found ? '' : '（本机未发现）'}`, h.id)));
  defaults.value = state.defaultsSet ? state.defaults.harness : '';
  $('default-summary').textContent = state.defaultsSet ? harnessTitle(state.defaults.harness) : '未设置';
  $('diagnostic-state').textContent = JSON.stringify({ active: state.active, mode: state.defaults.mode, armed: state.armed, pausedInstalls: state.pausedInstalls, reconciled: state.reconciled, revision: state.lastApply?.revision, runtimeConfirmed: state.lastApply?.runtimeConfirmed }, null, 2);

  $('version-badge').textContent = `v${state.version || '未知'}`;
  renderConfigControls(); renderHarnesses(); renderPersonas(); renderReport();
  renderEditorStatus(); lockControls();
}

function renderConfigControls() {
  const dirty = configDirty();
  const selected = state.personas.find(p => p.id === draft.persona);
  const count = state.harnesses.filter(consoleOn).length;
  const label = $('draft-state');
  label.className = 'draft-state';
  if (draftConflict) {
    label.textContent = '保存的配置在别处变了，草稿仍在；应用前请核对';
    label.classList.add('is-conflict');
  } else if (state.defaultsSet === false) {
    label.textContent = '第一次设置，保存后开始接管';
  } else if (dirty) {
    label.textContent = count ? `有未保存的改动，会同步到 ${count} 个工具` : '有未保存的改动';
    label.classList.add('is-dirty');
  } else {
    label.textContent = '已与保存的配置一致';
  }

  $('apply').textContent = state.defaultsSet === false ? '保存设置' : '应用变更';
  $('apply').disabled = busy || !needsApply(state, draft, base) || !selected;
  $('reset-config').disabled = busy || !dirty;

  const unsupported = unsupportedHarnesses(state.harnesses.filter(consoleOn), draft.mode);
  $('mode-hint').textContent = unsupported.length
    ? `${MODE_DESCRIPTIONS[draft.mode] || ''} 已接管的 ${unsupported.map(h => harnessTitle(h.id)).join('、')} 不支持这个力度，会按它自己的固定方式写入。`
    : MODE_DESCRIPTIONS[draft.mode] || '';
}

const consoleChannels = h => (h.armed || []).filter(c => c !== 'project');
const consoleOn = h => consoleChannels(h).length > 0;

function scopeLine() {
  const active = state.harnesses.filter(consoleOn);
  if (state.paused) return active.length ? `已暂停；${active.length} 个工具的配置还留着，恢复后继续生效。` : '已暂停，当前没有工具在使用人设。';
  if (!active.length) return '还没有接管任何工具。打开卡片右上角开关，或点「设置」即可开始。';
  return `正在接管 ${active.length} 个工具：${active.map(h => harnessTitle(h.id)).join('、')}。`;
}

function toolStatus(h) {
  const on = consoleOn(h);
  const failed = state.lastApply?.results?.some(r => r.harness === h.id && r.status === 'failed');
  const installed = Boolean(h.found || h.homeExists);
  if (on && failed) return { key: 'failed', label: '需重试' };
  if (on && state.paused) return { key: 'paused', label: '已暂停' };
  if (on && h.mode === 'off') return { key: 'paused', label: '单独暂停' };
  if (on) return { key: 'on', label: '已接管' };
  if (!installed) return { key: 'missing', label: '未安装' };
  return { key: 'off', label: '可接管' };
}

function toolSub(h) {
  const info = HARNESS_PURGE_EFFECTS[h.id];
  const kind = info?.typeLabel || ({ config: '配置托管', plugin: '插件', 'launch-arg': '启动命令', 'file-swap': '文件替换', 'native-extension': '原生扩展', 'config-or-hook': '配置 / 钩子' }[h.class] || '配置');
  const hot = h.caps?.hot?.ok && !kind.includes('热切') ? '热切' : '';
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
const GROUP_ORDER = [
  ['on', '已接管'],
  ['ready', '可接管'],
  ['missing', '未安装'],
];
const GROUP_KEYS = new Set(GROUP_ORDER.map(([key]) => key));

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
  const modeLabel = h.mode === 'off' ? '已暂停' : (MODE_LABELS[h.mode] || (avail.preferred ? MODE_LABELS[avail.preferred] : '替换身份'));
  const customPersona = h.personaFrom === 'override' ? state.personas.find(p => p.id === h.persona) : null;
  const metaText = customPersona ? `专属：${personaName(customPersona)}` : modeLabel;

  const statusLabel = rulesOnly && !on ? '项目文件' : status.label;
  const statusChipClass = status.key === 'on' ? 'is-on' : status.key === 'paused' ? 'is-warn' : status.key === 'failed' ? 'is-bad' : '';
  const rightControl = rulesOnly
    ? chip('仅项目规则', '')
    : node('label', { class: 'switch', title: `${on ? '关闭' : '开启'} ${harnessTitle(h.id)} 接管` },
        node('input', {
          type: 'checkbox', 'data-toggle': h.id, checked: on,
          disabled: !installed && !on,
          'aria-label': `${on ? '关闭' : '开启'} ${harnessTitle(h.id)} 的人设接管`
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
        'aria-label': `设置 ${harnessTitle(h.id)}`
      }, '设置 →')
    )
  );
}

function renderTargetList(rows, animate = false) {
  const list = $('harness-list');
  if (!rows.length) {
    list.replaceChildren(node('div', { class: 'target-empty' },
      node('strong', {}, '没有匹配的目标'),
      node('p', {}, targetQuery || targetFilter !== 'all' ? '换个关键词，或把筛选切回「全部」。' : '勾选「显示未安装」看看还能接哪些。')
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
  for (const [key, label] of GROUP_ORDER) {
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
  $('harness-count').textContent = `${visibleTargets.length} / ${all.length} 个目标`;
  if (!visibleTargets.length) {
    closeDrawer({ restore: false });
    $('harness-list').replaceChildren(node('div', { class: 'target-empty' },
      node('strong', {}, '没有匹配的目标'),
      node('p', {}, targetQuery || targetFilter !== 'all' ? '换个关键词，或把筛选切回「全部」。' : '勾选「显示未安装」看看还能接哪些。')
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
  let why = info.ok ? CHANNEL_STATIC[c] : info.why || '不可用';
  if (c === 'install' && ['dsh', 'opencode', 'opencode2'].includes(h.id)) why = '装成宿主插件，新开的会话自动读取；首次安装或更新代码后要重启一次。';
  if (c === 'slash' && h.id === 'dsh') why = '装上 /purge 开关；注入仍靠常驻配置，两样都要启用。';
  if (c === 'project') why = `写进当前目录的 ${h.caps?.project?.file || '规则文件'}；只影响这个目录。`;
  return node('div', { class: 'channel-item' },
    node('div', { class: 'channel-head' },
      node('div', { class: 'channel-name' }, CHANNEL_LABELS[c], isOn ? chip('已启用', 'is-on') : null),
      node('button', {
        type: 'button', class: `btn btn-sm ${isOn ? 'btn-primary' : 'btn-ghost'}`, 'data-channel': c, 'data-target': h.id, 'data-enabled': String(!isOn),
        title: isOn ? `关闭 ${CHANNEL_LABELS[c]}` : `启用 ${CHANNEL_LABELS[c]}`
      }, isOn ? '关闭' : '启用')
    ),
    node('div', { class: 'channel-why' }, why)
  );
}

function unavailableDetail(h) {
  const blocked = CHANNELS.filter(c => !h.caps?.[c]?.ok && !channelOn(h, c));
  if (!blocked.length) return null;
  return node('details', { class: 'fine' },
    node('summary', {}, `另有 ${blocked.length} 种方式对这家不适用`),
    node('div', { class: 'fine-body' }, blocked.map(c => {
      const cap = h.caps?.[c] || {};
      const hidden = cap.hiddenLabel ? `（曾用落点：${cap.hiddenLabel}）` : '';
      return node('p', {}, node('strong', {}, CHANNEL_LABELS[c]), cap.why || '不可用', hidden);
    }))
  );
}

function modeControl(h) {
  const avail = modeAvailability(h);
  const usable = ['replace', 'strict', 'append'].filter(m => avail.supported.has(m));
  if (usable.length <= 1) {
    return node('div', {},
      node('div', { class: 'mode-readonly' },
        node('strong', {}, MODE_LABELS[usable[0]] || '固定'),
        node('span', { class: 'hint' }, '固定方式')
      ),
      node('p', { class: 'panel-sub' }, avail.note || '这家只接受这一种写法。'),
      avail.purgeNote ? node('p', { class: 'panel-sub' }, avail.purgeNote) : null,
      h.modeFrom === 'override'
        ? node('button', { type: 'button', class: 'link', 'data-mode-follow': h.id }, '恢复跟随全局')
        : null
    );
  }
  const options = [new Option(`跟随全局 · ${MODE_LABELS[draft.mode] || ''}`, 'follow')];
  for (const m of usable) options.push(new Option(`${MODE_LABELS[m]}${avail.preferred === m ? '（推荐）' : ''}`, m));
  options.push(new Option('暂停这家', 'off'));
  // 旧配置可能留着已归并的 strict；回落到等价的 replace，避免下拉框空选
  const current = h.mode === 'off' ? 'off' : usable.includes(h.mode) ? h.mode : 'replace';
  const value = h.modeFrom === 'override' ? current : 'follow';
  const select = node('select', { class: 'select', 'data-hmode': h.id, 'aria-label': `${harnessTitle(h.id)} 改写力度` }, ...options);
  select.value = value;
  return node('div', {}, select,
    avail.limited && avail.note ? node('p', { class: 'panel-sub' }, avail.note) : null,
    avail.purgeNote ? node('p', { class: 'panel-sub' }, avail.purgeNote) : null,
    unsupportedHarnesses([h], draft.mode).length && h.modeFrom !== 'override'
      ? node('p', { class: 'panel-sub' }, `全局力度「${MODE_LABELS[draft.mode]}」对它不适用，实际按 ${MODE_LABELS[h.mode]} 写入。`)
      : null
  );
}

function effectsDetail(h) {
  const info = HARNESS_PURGE_EFFECTS[h.id];
  if (!info) return null;
  return node('details', { class: 'fine' },
    node('summary', {}, '它会改写什么'),
    node('ul', { class: 'effect-list' }, info.items.map(item => node('li', {}, item)))
  );
}

function formatVerifyTime(raw) {
  if (!raw) return '时间未记录';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function verifyNote(h) {
  const result = captureFor(h.id);
  if (!result) return '还没试过。试跑在临时环境里进行，不碰你正在用的窗口。';
  const ev = evidenceOf(result);
  const reason = result.reason ? ` · ${result.reason}` : '';
  return `${ev.label} · ${whereLabel(result.scope)} · ${formatVerifyTime(result.at || capture?.report?.at)}${reason}（不代表当前会话）`;
}

function technicalDetail(h) {
  return node('details', { class: 'fine' },
    node('summary', {}, '技术细节'),
    node('div', { class: 'fine-body' },
      node('p', {}, node('strong', {}, '热切机制'), h.caps?.hot?.how || h.caps?.hot?.why || '启动时读取一次，改完要重开会话。'),
      node('p', {}, node('strong', {}, '配置路径'), node('code', { class: 'path' }, h.persistFile || h.home || '—')),
      h.install && h.install !== h.home ? node('p', {}, node('strong', {}, '安装目录'), node('code', { class: 'path' }, h.install), h.installSource ? ` · ${INSTALL_SOURCE[h.installSource] || h.installSource}` : '') : null,
      node('p', {}, node('strong', {}, '命令入口'), node('code', { class: 'path' }, h.bin || '未发现'))
    )
  );
}

function toolPanel(h) {
  const channels = availableChannels(h);
  const info = HARNESS_PURGE_EFFECTS[h.id];
  const effect = consoleOn(h) ? effectLabelSafe(h) : null;
  const installed = Boolean(h.found || h.homeExists);
  const ev = captureFor(h.id) ? evidenceOf(captureFor(h.id)) : null;

  const personaOptions = [new Option(`跟随全局（${personaName(state.personas.find(p => p.id === state.persona))}）`, '')];
  for (const p of state.personas) personaOptions.push(new Option(personaName(p), p.id));
  const personaSelect = node('select', { class: 'select', 'data-hpersona': h.id, 'aria-label': `${harnessTitle(h.id)} 使用的人设` }, ...personaOptions);
  personaSelect.value = h.personaFrom === 'override' ? h.persona : '';

  const rulesOnly = targetGroup(h) === 'rules';
  const toggleBtn = rulesOnly
    ? null
    : node('button', {
        type: 'button',
        class: `btn ${consoleOn(h) ? 'btn-ghost' : 'btn-primary'}`,
        'data-drawer-toggle': h.id,
        disabled: !installed && !consoleOn(h)
      }, consoleOn(h) ? '关闭接管' : '开启接管');

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
      node('button', { type: 'button', id: 'close-drawer', class: 'icon-btn', 'aria-label': '关闭详情', title: '关闭详情 (Esc)' }, closeIcon)
    ),
    node('div', { class: 'detail-head' },
      node('div', { class: 'detail-id' },
        harnessIcon(h.id, 34),
        node('div', {},
          node('h2', {}, harnessTitle(h.id),
            h.personaFrom === 'override' ? node('span', { class: 'tool-flag is-accent' }, '专属') : null,
            state.defaultsSet && state.defaults.harness === h.id ? node('span', { class: 'tool-flag' }, '默认') : null
          ),
          node('p', {}, `${toolSub(h)} · ${installed ? '本机已安装' : '本机没装'}`)
        )
      ),
      toggleBtn ? node('div', { class: 'detail-actions' }, toggleBtn) : null
    ),
    node('section', { class: 'drawer-section' },
      node('h3', {}, '01 // 独立设置'),
      node('div', { class: 'panel-fields-grid' },
        node('div', { class: 'panel-field' },
          node('span', { class: 'field-label' }, '使用哪份人设'),
          personaSelect
        ),
        node('div', { class: 'panel-field' },
          node('span', { class: 'field-label' }, '改写力度'),
          modeControl(h)
        )
      ),
      ['pi', 'omp'].includes(h.id) && h.armed.includes('slash')
        ? node('label', { class: 'check' }, node('input', { type: 'checkbox', 'data-auto': h.id, checked: state[h.id === 'pi' ? 'piAuto' : 'ompAuto'] }), ' 新会话自动应用（关闭时须执行 /purge on）')
        : null,
      h.id === 'dsh' && h.homeExists
        ? node('div', { class: 'panel-field' },
            node('span', { class: 'field-label' }, '生效形态'),
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
      node('h3', {}, '02 // 接管方式'),
      channels.length
        ? node('div', { class: `channel-list channel-count-${channels.length}` }, channels.map(c => channelRow(h, c)))
        : node('p', { class: 'muted' }, h.reason || '这家仅支持项目级规则文件，请到「项目规则」页写入。'),
      unavailableDetail(h)
    ),
    node('div', { class: 'panel-foot' },
      node('div', { class: 'panel-foot-head' },
        node('h3', { class: 'panel-foot-title' }, '03 // 安全试跑')
      ),
      node('div', { class: 'verify-bar' },
        node('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-verify': h.id, disabled: !installed, title: '在临时目录里跑一次，不读取也不修改当前会话' }, '试跑一次'),
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
  }, node('strong', {}, personaName(p)), node('small', {}, `${p.id} · ${fmt(p.chars)} 字`), state.active === p.id ? chip('当前人设', '') : null)) : [empty('没有匹配的人设')]));
}
function confirmDiscard() { return !editorDirty() || window.confirm('这份人设有未保存的修改，放弃吗？'); }
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
  $('editor-title').textContent = editor ? current ? '编辑当前人设' : '编辑人设' : '新建人设';
  $('editor-status').textContent = editorDirty() ? '未保存' : '已保存';
  $('char-count').textContent = `${$('edit-body').value.trim().length} 字`;
  $('save-persona').textContent = current ? '保存并同步' : '保存';
  $('save-persona').disabled = busy || !editorDirty();
  $('save-apply').hidden = current;
  $('save-apply').disabled = busy;
  $('delete-persona').disabled = busy || !editor || state.personas.length <= 1;
  $('edit-id').disabled = busy || Boolean(editor);
  $('editor-hint').textContent = current ? '保存后会同步到已接管的工具；暂停时只更新人设，不恢复应用。' : '「保存」只改人设库；「保存并应用」会切换当前人设并同步。';
}
async function saveEditor(apply) {
  if (!$('editor-form').reportValidity()) return;
  const value = editorValue();
  if (!editor && state.personas.some(p => p.id === value.id)) { notify('这个标识已经存在，换一个再试。', 'error'); return; }
  await operation(async () => {
    const result = await api('persona', { ...value, apply });
    editor = result.persona.id;
    editorBaseline = JSON.stringify(value);
    await refresh({ resetDraft: apply });
    announce(result, apply ? '人设已保存并应用。' : '人设已保存。');
  });
}

/* ---------------- reports ---------------- */
function renderReport() {
  const r = state.lastApply;
  $('retry-failed').hidden = !r?.results?.some(x => x.status === 'failed');
  $('report-meta').textContent = r ? `${new Date(r.at).toLocaleString('zh-CN')} · ${MODE_LABELS[r.mode] || r.mode} · ${r.results.length} 项` : '应用后，这里会按工具记录写入结果。';
  $('apply-results').replaceChildren(...(!r ? [empty('还没有应用记录。')] : !r.results.length ? [empty('配置已保存，当前没有需要写入的通道。')] : r.results.map(x => node('div', { class: 'result-row' },
    node('div', { class: 'result-title' }, harnessTitle(x.harness), chip(x.status === 'failed' ? '失败' : '已写入', x.status === 'failed' ? 'is-bad' : 'is-on')),
    node('div', { class: 'result-detail' }, `${CHANNEL_LABELS[x.channel] || x.channel}${x.message ? ` · ${x.message}` : ''}`, x.status === 'failed' ? null : node('span', { class: 'hint' }, ' · 运行中的会话尚未确认')),
    x.error ? node('div', { class: 'result-detail error' }, x.error) : null
  ))));
}

function captureRow(result) {
  const ev = evidenceOf(result);
  const modes = result.modes || [];
  const roles = [...new Set(modes.flatMap(m => (m.requests || []).flatMap(r => r.roles || [])))].join(' + ');
  const hot = result.hotSwitch?.status;
  return node('tr', {},
    node('td', {}, node('strong', {}, harnessTitle(result.harness)), node('div', { class: 'hint' }, result.version || '版本未知')),
    node('td', {}, chip(ev.label, ev.chipClass)),
    node('td', {}, roles || '—'),
    node('td', {},
      result.reason || (!modes.length ? result.evidence || '' : ''),
      hot ? node('div', { class: 'hint' }, `同会话热切：${CAPTURE_LABELS[hot] || hot}`) : null,
      modes.length ? node('details', { class: 'fine' },
        node('summary', {}, `${modes.length} 种力度的请求证据`),
        node('div', { class: 'fine-body' }, modes.map(m => node('p', {},
          `${MODE_LABELS[m.mode] || m.mode} · ${CAPTURE_LABELS[m.status] || m.status}：${m.reason || ''} `,
          (m.requests || []).map(r => `${(r.roles || []).join('+')} / ${r.chars} 字 / 人设 ${r.markerCount} 次 / 身份句 ${r.identityLines?.length || 0}`).join('；')
        )))
      ) : null
    )
  );
}

function captureSummary(report) {
  const results = report.results || [];
  const hits = results.filter(r => ['verified', 'off-verified'].includes(evidenceOf(r).state)).length;
  const missing = results.filter(r => ['no-request', 'unavailable', 'miss'].includes(evidenceOf(r).state)).length;
  return `最近一次在临时环境里试了 ${results.length} 个工具：${hits} 个在请求里命中了人设${missing ? `，${missing} 个没抓到或没命中` : ''}。`;
}

async function loadCapture() {
  try {
    capture = await api('verification');
    const report = capture.report;
    const command = node('p', { class: 'hint' }, '重新试跑：', node('code', {}, 'npm run test:harness'));
    $('capture-results').replaceChildren(...(!report ? [node('p', { class: 'muted' }, '还没有试跑报告。试跑使用临时配置和本地服务，不以模型自称的身份作为证据。'), command] : [
      node('p', { class: 'muted' }, captureSummary(report)),
      node('p', { class: 'hint' }, `${report.at || ''} · 临时环境。这不代表你正在用的窗口已经生效。`),
      node('div', { class: 'table-scroll' }, node('table', { class: 'capture-table' },
        node('thead', {}, node('tr', {}, ['工具 / 版本', '结果', '注入层', '说明'].map(label => node('th', {}, label)))),
        node('tbody', {}, report.results.map(captureRow))
      )),
      command
    ]));
  } catch (error) { $('capture-results').textContent = `报告读取失败：${error.message}`; }
}

/* ---------------- project & global rules ---------------- */
let ruleScope = 'project';
let rulePersona = '';

async function loadProject(dir = '') {
  $('project-targets').replaceChildren(empty('正在读取规则文件…'));
  $('project-dir-wrap').hidden = ruleScope === 'global';
  $('project-scope-heading').textContent = ruleScope === 'global' ? '各工具全局规则文件' : '当前目录的规则文件';
  $('project-scope-desc').textContent = '人设以托管块追加在原文件末尾（append），保留原有规则，随时可移除';
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
  const selectedPersonaTitle = persona ? personaName(persona) : '当前人设';
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
      node('span', { class: 'project-recent-count' }, item.current ? '当前' : item.files ? `${item.written}/${item.files} 已写入` : '未写入')
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
    const writeLabel = scope === 'global' ? '写入全局文件' : '写入此项目';
    const label = on ? '移除' : pending ? '取消选择' : blocked ? '处理现有块' : writeLabel;
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
    }, `更新为「${selectedPersonaTitle}」`) : null;
    const writtenLabel = target.writtenPersonaName ? `已写入 · ${target.writtenPersonaName}` : '已写入';
    const status = on ? writtenLabel : blocked ? '归属不明' : pending ? '已暂停' : target.selected ? '待写入' : '未写入';
    const diff = target.diff;
    const diffSummary = diff ? (diff.added || diff.removed ? `查看写入差异 · +${diff.added} / -${diff.removed}` : '查看写入差异 · 没有变化') : null;
    const scopeNote = on
      ? `已写入${target.writtenPersonaName ? `「${target.writtenPersonaName}」` : ''}，追加在原文件末尾（append），随时可移除。`
      : '保留原有规则并在末尾追加（append）托管块，对所有读取方生效。';
    return node('article', { class: 'project-card', 'data-project-card': target.file },
      node('div', { class: 'project-card-head' },
        node('div', {},
          node('h2', {}, target.file),
          node('p', { class: 'project-path' }, target.path)
        ),
        chip(status, on ? 'is-on' : blocked || pending ? 'is-warn' : '')
      ),
      node('p', { class: 'project-readers' }, readers.length ? `读取方：${readers.map(id => harnessTitle(id)).join('、')}` : '没有已登记的工具读取这个文件'),
      node('p', { class: 'project-scope-note' }, scopeNote),
      node('div', { class: 'project-controls' }, updateButton, actionButton),
      target.gitHint && (on || hasBlock) ? node('p', { class: 'hint' }, target.gitHint) : null,
      blocked ? node('p', { class: 'hint' }, '文件里有 agent-purge 托管块，但账本里找不到归属；先手动核对，避免误删。') : null,
      !on && !hasBlock && !project.persona ? node('p', { class: 'hint' }, '先在「控制台」或「人设库」选一份人设，才能写入。') : null,
      !on && !hasBlock && project.paused ? node('p', { class: 'hint' }, '全局暂停中：恢复后会按当前选择写回；现在只取消选择。') : null,
      target.preview ? node('details', { class: 'project-preview' },
        node('summary', {}, `查看托管块 · ${fmt(target.preview.chars)} 字`),
        node('pre', {}, target.preview.text + (target.preview.truncated ? '\n…' : ''))
      ) : null,
      diff ? node('details', { class: 'project-preview project-diff' },
        node('summary', {}, diffSummary),
        node('pre', {}, diff.text)
      ) : null,
      target.after != null ? node('details', { class: 'project-preview project-after' },
        node('summary', {}, `写入后的规则文件 · ${fmt(target.afterChars)} 字`),
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
    .sort((a, b) => harnessTitle(a.id).localeCompare(harnessTitle(b.id), 'zh-CN'));
  const coverage = node('details', { class: 'project-coverage' },
    node('summary', {}, `按工具查看读取关系 · ${toolRows.length} 家`),
    node('div', { class: 'project-coverage-list' }, ...toolRows.map(row => node('div', { class: 'project-coverage-row' },
      node('strong', {}, harnessTitle(row.id)),
      node('span', { class: 'project-coverage-file' }, `读取 ${row.file}`),
      node('span', { class: 'project-coverage-state' }, row.on ? '已写入' : row.hasBlock ? '归属不明' : project.paused && row.selected ? '已暂停' : '未写入')
    )))
  );
  const history = (project.history || []).map(row => {
    const at = new Date(row.at);
    const when = Number.isNaN(at.getTime()) ? String(row.at ?? '') : at.toLocaleString('zh-CN', { hour12: false });
    const who = row.persona ? (state?.personas?.find(p => p.id === row.persona) ? personaName(state.personas.find(p => p.id === row.persona)) : row.persona) : '未记录人设';
    return node('div', { class: 'project-history-row' },
      node('span', { class: 'project-history-time' }, when),
      node('strong', {}, row.file || '规则文件'),
      node('span', {}, `${row.action === 'remove' ? '移除' : '写入'} · ${who}`),
      node('span', { class: row.ok === false ? 'project-history-state is-failed' : 'project-history-state' }, row.ok === false ? '失败' : '完成')
    );
  });
  const historyPanel = history.length ? node('details', { class: 'project-history' },
    node('summary', {}, `本页操作记录 · ${history.length} 条`),
    node('div', { class: 'project-history-list' }, ...history)
  ) : null;
  $('project-targets').replaceChildren(
    node('p', { class: 'project-persona' },
      persona ? `当前待写入人设：${personaName(persona)}（${rulePersona ? '本页指定' : '跟随控制台'}）` : '还没有选中人设；规则文件只能预览，不能写入。'
    ),
    ...cards,
    coverage,
    ...(historyPanel ? [historyPanel] : [])
  );
}
/* ---------------- navigation ---------------- */
const pageFromHash = () => ({ personas: 'library', overview: 'console', rules: 'project' }[location.hash.slice(1)] || location.hash.slice(1) || 'console');
async function navigate(page, { replace = false, focus = true } = {}) {
  if (!['console', 'library', 'diagnostics', 'project'].includes(page)) page = 'console';
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
      ? (action === 'on' ? `${file} 已写入（追加托管块），随时可移除。` : `${file} 的托管块已移除。`)
      : '规则文件未改变。');
  });
});

/* ---------------- console events ---------------- */
$('persona-select').addEventListener('change', () => {
  draft.persona = $('persona-select').value;
  const p = state.personas.find(p => p.id === draft.persona);
  $('current-persona').textContent = personaName(p);
  $('current-mode').textContent = `${fmt(p?.chars)} 字 · ${state.personas.length} 份可用`;
  $('persona-description').textContent = p?.meta?.description || p?.meta?.desc || '这份人设没有写说明。';
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
      notify(done.length ? `已开启：${done.join('、')}。` : '没有可以一键开启的工具。', done.length ? 'good' : '');
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
      notify('已恢复各家推荐的改写力度。', 'good');
    } else if (val === 'mode-replace' || val === 'mode-strict') {
      const target = val === 'mode-replace' ? 'replace' : 'strict';
      const active = state.harnesses.filter(h => h.supported && consoleOn(h) && modeAvailability(h).supported.has(target));
      for (const h of active) await api('harness', { harness: h.id, mode: target });
      await refresh();
      notify(`已把 ${active.length} 个工具改为「${MODE_LABELS[target]}」。`, 'good');
    }
  });
});

$('reset-config').addEventListener('click', () => { draft = { ...base }; draftConflict = false; render(); });
$('config-form').addEventListener('submit', e => {
  e.preventDefault();
  operation(async () => {
    $('apply').textContent = '正在应用…';
    const result = await api('apply', {
      persona: draft.persona,
      mode: state.paused ? 'off' : draft.mode,
      ...(state.defaultsSet === false ? { harness: state.defaults.harness } : {}),
      ...(state.paused ? { resumeMode: draft.mode } : {})
    });
    await refresh({ resetDraft: result.ok === true });
    pulseClass(document.querySelector('.command-bar'), 'is-wiping', 560);
    pulseClass($('coverage-strip'), 'is-updating', 600);
    announce(result, state.paused ? '配置已保存，当前仍处于暂停状态。' : '已应用。新开的会话会读取，运行中的会话看各家提示。');
  });
});
$('power').addEventListener('click', () => operation(async () => {
  const on = state.paused;
  const result = await api('power', { on });
  await refresh();
  announce(result, on ? '已恢复全部工具的人设注入。' : '已暂停全部工具；现有配置已安全复原。');
}));
$('disarm-all').addEventListener('click', () => {
  if (!window.confirm('停用所有已接管的工具？\n\n会撤销系统提示词配置、插件与命令别名，并按原字节还原原厂文件。\n项目规则不在其中，需到「项目规则」页单独移除。\n人设和用户修改会保留，不会卸载 agent-purge 本身。')) return;
  operation(async () => {
    const res = await api('clean', { keepProject: true });
    await refresh();
    if (res.ok) notify('已撤销全部接管：原厂文件已还原，人设和用户修改已保留。', 'good');
    else notify(`部分项目撤销失败：${(res.leftovers || []).join('；')}`, 'warn');
  });
});
$('refresh').addEventListener('click', () => operation(async () => { await refresh(); notify('状态已刷新，未保存的选择保持不变。'); }));
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
    announce(result, on ? `${harnessTitle(id)} 已开启接管。` : `${harnessTitle(id)} 已停止接管并还原原厂文件。`);
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
      notify(`正在临时环境里试跑 ${harnessTitle(id)}，最多等一分钟…`, 'muted');
      const r = await api('verify', { harness: id });
      try { capture = await api('verification'); } catch { /* 报告读不到就保持旧的 */ }
      await refresh();
      const ev = r.assessment ? (EVIDENCE[r.assessment.state]?.[0] || r.assessment.label) : evidenceOf(captureFor(id)).label;
      notify(`${harnessTitle(id)}：${ev} · ${whereLabel(r.scope)}${r.reason ? `；${r.reason}` : ''}。不代表当前会话已生效。`, ['verified', 'off-verified'].includes(r.assessment?.state) ? 'good' : 'warn');
    });
    return;
  }
  const followMode = e.target.closest('[data-mode-follow]');
  if (followMode) {
    operation(async () => {
      const result = await api('harness', { harness: followMode.dataset.modeFollow, mode: 'follow' });
      await refresh();
      announce(result, `${harnessTitle(followMode.dataset.modeFollow)} 恢复跟随全局力度。`);
    });
    return;
  }
  const channelBtn = e.target.closest('[data-channel]');
  if (channelBtn) {
    operation(async () => {
      const result = await api('arm', { harness: channelBtn.dataset.target, channel: channelBtn.dataset.channel, action: channelBtn.dataset.enabled === 'true' ? 'on' : 'off' });
      await refresh();
      pulseClass(document.querySelector(`.tool-card[data-id="${CSS.escape(channelBtn.dataset.target)}"]`), 'is-toggled', 520);
      announce(result, '接管方式已更新。首次安装或更新扩展后请重新加载客户端。');
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
  $('confirm-harness-badge').textContent = purgeInfo?.typeLabel || '配置托管';
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
      announce(result, pick ? `${harnessTitle(el.dataset.hpersona)} 改用这份人设。` : `${harnessTitle(el.dataset.hpersona)} 恢复跟随全局人设。`);
    });
    return;
  }
  if (el.dataset.hmode) {
    const pick = el.value;
    operation(async () => {
      const result = await api('harness', { harness: el.dataset.hmode, mode: pick || 'follow' });
      await refresh();
      announce(result, pick === 'follow' ? `${harnessTitle(el.dataset.hmode)} 恢复跟随全局力度。` : `${harnessTitle(el.dataset.hmode)} 的力度改为「${MODE_LABELS[pick] || pick}」。`);
    });
    return;
  }
  if (el.dataset.toggle) {
    await setHarnessArmed(el.dataset.toggle, el.checked, el);
    return;
  }
  if (el.dataset.auto) operation(async () => { await api(`${el.dataset.auto}-auto`, { on: el.checked }); await refresh(); notify('自动应用设置已更新。', 'good'); });
  if (el.dataset.profile) operation(async () => { await api('dsh-profile', { profile: el.dataset.profile, on: el.checked }); await refresh(); notify('dsh 生效形态已更新。', 'good'); });
};
document.querySelector('.target-console').addEventListener('change', onToolsChange);

$('default-form').addEventListener('submit', e => {
  e.preventDefault();
  operation(async () => { const result = await api('defaults', { harness: $('default-harness').value || null }); await refresh(); announce(result, '启动首选项已保存，接管范围没有改变。'); });
});

/* ---------------- library events ---------------- */
$('persona-search').addEventListener('input', renderPersonas);
$('persona-list').addEventListener('click', e => { const el = e.target.closest('[data-persona]'); if (el) openEditor(el.dataset.persona); });
$('editor-form').addEventListener('input', renderEditorStatus);
$('editor-form').addEventListener('submit', e => { e.preventDefault(); saveEditor(false); });
$('save-apply').addEventListener('click', () => saveEditor(true));
$('delete-persona').addEventListener('click', () => {
  if (!confirm(`删除人设「${editor}」？${editor === state.active ? '当前人设会回退并同步到已接管的工具。' : ''}`)) return;
  operation(async () => {
    const result = await api(`persona?id=${encodeURIComponent(editor)}`, null, 'DELETE');
    editor = null; editorBaseline = '';
    $('editor-form').hidden = true; $('editor-empty').hidden = false;
    await refresh({ resetDraft: true });
    announce(result, '人设已删除。');
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
  startImportBtn.disabled = false; startImportBtn.textContent = '开始拉取';
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
  startImportBtn.disabled = true; startImportBtn.textContent = '正在拉取…';
  importStatus.hidden = false; importStatus.className = 'status-box';
  importStatus.textContent = `正在从 ${source} 拉取…`;
  try {
    const res = await api('persona/import', { source, overwrite });
    if (!res.ok) throw new Error(res.error || '拉取失败');
    const { total = 0, imported = [] } = res.result || {};
    importStatus.className = 'status-box success';
    const names = imported.map(x => x.name || x.id).slice(0, 3).join('、');
    importStatus.textContent = `导入 ${total} 个人设${names ? `（${names}${imported.length > 3 ? ' 等' : ''}）` : ''}。`;
    await refresh();
    notify(`已拉取 ${total} 个人设。`, 'good');
    setTimeout(() => importDialog?.close(), 1200);
  } catch (err) {
    importStatus.className = 'status-box error';
    importStatus.textContent = `导入失败：${err.message}`;
    notify(`人设导入失败：${err.message}`, 'error');
  } finally {
    startImportBtn.disabled = false; startImportBtn.textContent = '开始拉取';
  }
});

/* ---------------- diagnostics ---------------- */
$('sync-all').addEventListener('click', () => operation(async () => { const r = await api('sync', {}); await refresh(); announce(r, '已按原范围重新同步。'); }));
$('retry-failed').addEventListener('click', () => operation(async () => { const r = await api('sync', { onlyFailed: true }); await refresh(); announce(r, '失败项已重试。'); }));

/* ---------------- update ---------------- */
let cachedUpdateInfo = null;
function showUpdateDialog(res) {
  const dialog = $('update-dialog');
  if (!dialog) return;
  $('update-current-tag').textContent = `当前 v${res.current}`;
  const gitBehind = Number(res.git?.behind) || 0;
  const sameVersion = !res.latest || res.latest === res.current;
  $('update-latest-tag').textContent = sameVersion && gitBehind ? `上游 ${gitBehind} 个新提交` : `最新 v${res.latest}`;
  const sources = [];
  if (res.npm?.ok && res.npm?.latest === res.latest) sources.push('npm');
  if (res.github?.ok && res.github?.latest === res.latest) sources.push('GitHub');
  if (res.installType === 'git') sources.push('git');
  $('update-source-label').textContent = sources.length ? `来源 ${sources.join(' / ')}` : '';
  const changelog = (res.github?.body || res.body || '').trim();
  $('update-changelog-text').textContent = changelog || '暂无详细发布说明。';
  $('update-changelog-box').hidden = !changelog;

  const type = res.installType || (res.isExe ? 'exe' : 'npm');
  const cmdBox = $('update-command-box');
  const doBtn = $('btn-do-upgrade');
  const statusEl = $('update-status');
  statusEl.hidden = true; statusEl.textContent = ''; statusEl.className = 'status-box';
  if (type === 'exe') {
    cmdBox.hidden = true; doBtn.textContent = '一键就地升级'; doBtn.title = '自动下载新版 EXE 并热替换';
  } else if (type === 'git') {
    cmdBox.hidden = false; $('update-command-text').textContent = 'git pull --ff-only';
    doBtn.textContent = '一键 git 更新'; doBtn.title = '在安装目录执行 git pull --ff-only';
    const git = res.git || {};
    if (git.dirty) {
      statusEl.hidden = false; statusEl.className = 'status-box error';
      statusEl.textContent = `工作区有 ${git.dirty} 处未提交改动：先提交或撤销，更新会拒绝执行。`;
    } else if (git.branch) {
      statusEl.hidden = false;
      statusEl.textContent = `当前分支 ${git.branch}${git.upstream ? ` → ${git.upstream}` : '（没有上游）'}；更新只做快进合并。`;
    }
  } else {
    cmdBox.hidden = false; $('update-command-text').textContent = res.npm?.command || 'npm install -g agent-purge@latest';
    doBtn.textContent = '一键 npm 升级'; doBtn.title = '后台调用 npm 全局更新';
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
      vb.textContent = `v${res.current || state?.version || '未知'}`;
      if (force) notify(`检查更新失败：${res.error || '网络异常'}`, 'warn');
      return;
    }
    cachedUpdateInfo = res;
    vb.textContent = `v${res.current}`;
    const behind = Number(res.git?.behind) || 0;
    const versionAhead = res.latest && res.latest !== res.current;
    if (res.hasUpdate) {
      vb.className = 'version is-new';
      vb.textContent = versionAhead ? `v${res.current} → v${res.latest}` : `v${res.current} · 上游 ${behind} 个新提交`;
      vb.title = versionAhead ? `有新版本 v${res.latest}，点击查看并升级` : `上游有 ${behind} 个新提交，点击一键 git 更新`;
      if (force) showUpdateDialog(res);
    } else {
      vb.className = 'version';
      vb.title = `v${res.current} 已是最新，点击重新检查`;
      if (force) notify(`已是最新版本 v${res.current}。`, 'good');
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
  if (cmd) navigator.clipboard?.writeText(cmd).then(() => notify('升级命令已复制。', 'good')).catch(() => {});
});
$('btn-do-upgrade')?.addEventListener('click', async () => {
  if (!cachedUpdateInfo) return;
  const doBtn = $('btn-do-upgrade');
  const statusEl = $('update-status');
  const type = cachedUpdateInfo.installType || (cachedUpdateInfo.isExe ? 'exe' : 'npm');
  const busyText = type === 'exe' ? '正在下载替换…' : type === 'git' ? '正在 git pull…' : '正在 npm 升级…';
  const waitText = type === 'exe' ? '正在下载新版并热替换，请稍候…' : type === 'git' ? '正在安装目录执行 git pull --ff-only…' : '正在调用 npm 全局更新，可能需要十几秒…';
  const retryText = type === 'exe' ? '重试就地升级' : type === 'git' ? '重试 git 更新' : '重试 npm 升级';
  doBtn.disabled = true; doBtn.textContent = busyText;
  statusEl.hidden = false; statusEl.className = 'status-box'; statusEl.textContent = waitText;
  try {
    const res = await api('update-upgrade', { type });
    if (res.ok) {
      statusEl.className = 'status-box success';
      statusEl.textContent = res.message || '升级成功。';
      doBtn.textContent = '升级完成';
      notify(res.message || '升级成功。', 'good');
      setTimeout(() => { $('update-dialog')?.close(); checkAppUpdate(true); }, 2500);
    } else {
      statusEl.className = 'status-box error';
      statusEl.textContent = `${res.error || '更新失败'}${res.output ? `\n${res.output}` : ''}`;
      doBtn.disabled = false; doBtn.textContent = retryText;
    }
  } catch (err) {
    statusEl.className = 'status-box error';
    statusEl.textContent = err.message || '网络请求异常';
    doBtn.disabled = false; doBtn.textContent = retryText;
  }
});

/* ---------------- lifecycle ---------------- */
$('exit-btn')?.addEventListener('click', async () => {
  if (configDirty() || editorDirty()) {
    if (!confirm('还有未保存的设置或草稿，确定退出并关闭吗？')) return;
  }
  setConnection('服务已停止', 'is-down');
  notify('正在退出本地服务并关闭窗口…', 'muted');
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
window.addEventListener('beforeunload', e => { if (configDirty() || editorDirty()) { e.preventDefault(); e.returnValue = ''; } });

refresh().then(() => navigate(pageFromHash(), { replace: true, focus: false })).then(() => checkAppUpdate(false)).catch(error => {
  setConnection('本地服务未连接', 'is-down');
  notify(`${error.message} 用右上角刷新按钮重试。`, 'error');
});
