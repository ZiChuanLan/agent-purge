import { MODE_LABELS, CHANNEL_LABELS, CAPTURE_LABELS, personaName, configurationOf, changed, needsApply, sortedHarnesses, effectLabel, scopeSummary } from './model.mjs';
import { verificationEvidence, captureScopeLabel } from './evidence.mjs';
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
const badge = (label, kind = '') => node('span', { class: `badge ${kind}` }, label);
// 抽屉头的「⚡/🔄」emoji 换成内联 SVG：emoji 字形在 Windows 上按彩色位图渲染，和 11px 文字挤在一起忽大忽小
const HOT_SVG = {
  hot: node('svg', { viewBox: '0 0 16 16', width: '12', height: '12', 'aria-hidden': 'true' },
    node('path', { d: 'M9 1.5 3.5 9h3l-1 5.5L12 7H8.8z', fill: 'currentColor' })),
  restart: node('svg', { viewBox: '0 0 16 16', width: '12', height: '12', 'aria-hidden': 'true' },
    node('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
};
const hotBadge = (label, kind = '', icon = 'hot') =>
  node('span', { class: `badge ${kind}` }, HOT_SVG[icon].cloneNode(true), label);
const empty = label => node('p', { class: 'empty' }, label);
const INSTALL_SOURCE = { shortcut: '开始菜单快捷方式', registry: '注册表卸载项', guess: '盘符扫描', scan: '盘内浅扫' };
const HARNESS_ICON_FILES = { pi: 'pi.png', 'pi-desktop': 'pi-desktop.png', claude: 'claude.ico', codex: 'codex.webp', omp: 'omp.png', dsh: 'dsh.ico', grok: 'grok.ico', hermes: 'hermes.ico', opencode: 'opencode.ico', opencode2: 'opencode2.ico', codebuddy: 'codebuddy.png', zcode: 'zcode.png', workbuddy: 'workbuddy.png', 'workbuddy-ai': 'workbuddy.png', kilo: 'kilo.png' };
const harnessIcon = (id, size = 24) => {
  // 真实图标在 web/assets/ 下（各官网/favicon 下载），不是手绘 SVG。
  const file = HARNESS_ICON_FILES[id];
  // ?v=2：旧版 server 对 /assets/ 发过 max-age=86400，浏览器里还留着换前的图；换 URL 绕开那份旧缓存（server 已改 no-store）。
  const src = file ? `assets/${file}?v=2` : '';
  const img = src
    ? node('img', {
        class: 'harness-avatar',
        'data-id': id,
        src,
        alt: id,
        width: String(size),
        height: String(size)
      })
    : node('span', { class: 'harness-avatar fallback', 'aria-hidden': 'true' }, id.slice(0, 1).toUpperCase());
  if (size !== 24) {
    // CSP 禁内联 style；尺寸档位用类名表达（抽屉头 34px）
    img.classList.add(size === 34 ? 'harness-avatar-lg' : 'harness-avatar-md');
  }
  return img;
};

let state, base, draft, editor = null, editorBaseline = '', busy = false, activePage = 'console', expanded = null;
let capture = null, draftConflict = false;
// Process failure, no request, off-mode success and a real marker miss are distinct.
const captureFor = id => (capture?.report?.results ?? []).find(r => r.harness === id) || null;
function evidenceBadge(id) {
  const evidence = verificationEvidence(captureFor(id));
  return badge(evidence.label, evidence.kind);
}
function verifyNote(id) {
  const r = captureFor(id);
  if (!r) return '没有本机请求证据；能力说明不是实测结果。此按钮只验证隔离 CLI，不验证正在运行的桌面会话。';
  return `${r.version || '版本未知'} · ${captureScopeLabel(r.scope)} · ${r.at || capture?.report?.at || '时间未记录'} · ${r.reason || r.evidence || verificationEvidence(r).label}。不代表当前会话已应用。`;
}
const mode = () => document.querySelector('[name=mode]:checked')?.value || 'replace';
const configDirty = () => draft && base && changed(draft, base);
const editorValue = () => ({ id: $('edit-id').value.trim(), meta: { name: $('edit-name').value.trim(), description: $('edit-desc').value.trim(), model: $('edit-model').value }, body: $('edit-body').value });
const editorDirty = () => editor !== null && JSON.stringify(editorValue()) !== editorBaseline;
function notify(message, kind = '') {
  const el = $('notice'); el.textContent = message; el.className = `notice ${kind}`; el.hidden = false;
}
async function api(path, data, method = data ? 'POST' : 'GET') {
  const response = await fetch(`/api/${path}`, { method, headers: data ? { 'content-type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  let result; try { result = await response.json(); } catch { throw new Error('服务返回了无效内容，请确认本地服务仍在运行。'); }
  if (!response.ok || result.error) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}
function announce(result, success) {
  const report = result.applied || result;
  if (report.ok === false) {
    const failed = report.results?.filter(r => r.status === 'failed' || r.ok === false) || [];
    notify(`${report.partial ? '部分变更已写入' : '操作未全部完成'}。${failed.map(r => `${r.harness}：${r.error}`).join('；') || '请查看诊断中的逐项结果。'}`, 'warn');
  } else notify(success);
}
const lockedControls = new Set();
function lockControls() {
  if (!busy) return;
  document.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)').forEach(el => { lockedControls.add(el); el.disabled = true; });
}
function focusKey(el) {
  if (!el || el === document.body) return null;
  if (el.id) return { id: el.id };
  const keys = ['expand', 'hpersona', 'hmode', 'toggle', 'channel', 'verify', 'auto', 'profile', 'closeDrawer'];
  const key = keys.find(key => el.dataset?.[key] !== undefined);
  return key ? { key, value: el.dataset[key], drawer: Boolean(el.closest('.harness-drawer')) } : null;
}
function restoreFocus(key) {
  if (!key) return;
  const target = key.id ? $(key.id) : [...document.querySelectorAll('[data-' + key.key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + ']')].find(el => el.dataset[key.key] === key.value && Boolean(el.closest('.harness-drawer')) === key.drawer);
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
  state = { ...fresh, personas: Array.isArray(fresh.personas) ? fresh.personas : [], harnesses: Array.isArray(fresh.harnesses) ? fresh.harnesses : [], defaults: fresh.defaults || { harness: null, mode: 'replace' }, armed: fresh.armed || {}, modes: fresh.modes || Object.keys(MODE_LABELS) }; base = configurationOf(state);
  if (!preserve) draft = { ...base };
  $('connection').textContent = `本地服务已连接 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  render();
}
function render() {
  $('version-badge').textContent = `v${state.version || '未知'}`;
  const p = state.personas.find(p => p.id === state.active);
  $('current-persona').textContent = personaName(p);
  $('current-mode').textContent = `${MODE_LABELS[state.defaults.mode]} · ${p?.chars ?? 0} 字`;
  $('power-status').textContent = state.paused ? '已暂停' : '配置启用';
  $('power-status').className = `badge ${state.paused ? 'warn' : 'good'}`;
  $('power').textContent = state.paused ? '恢复应用' : '暂停应用'; $('power').disabled = false;
  const last = state.lastApply;
  $('current-sync').textContent = last ? last.ok ? '同步记录已更新' : '有同步失败项' : '尚无应用记录';
  $('persona-select').replaceChildren(...state.personas.map(p => new Option(`${personaName(p)} · ${p.chars} 字`, p.id)));
  $('persona-select').value = draft.persona; $('persona-select').disabled = false;
  document.querySelectorAll('[name=mode]').forEach(el => el.checked = el.value === draft.mode);
  renderConfigControls(); renderHarnesses(); renderPersonas(); renderReport();
  $('default-harness').replaceChildren(new Option('未设置', ''), ...state.harnesses.filter(h => h.oneshot && h.supported).map(h => new Option(`${h.id}${h.found ? '' : '（本机未发现）'}`, h.id)));
  $('default-harness').value = state.defaultsSet ? state.defaults.harness : '';
  $('default-summary').textContent = state.defaultsSet ? state.defaults.harness : '未设置';
  $('diagnostic-state').textContent = JSON.stringify({ active: state.active, mode: state.defaults.mode, armed: state.armed, pausedInstalls: state.pausedInstalls, reconciled: state.reconciled, revision: last?.revision, runtimeConfirmed: last?.runtimeConfirmed }, null, 2);
  renderEditorStatus(); lockControls();
}
function renderConfigControls() {
  const dirty = configDirty();
  const selected = state.personas.find(p => p.id === draft.persona);
  $('persona-description').textContent = selected?.meta?.description || selected?.meta?.desc || '未填写说明';
  $('draft-state').textContent = draftConflict ? '已保存配置发生变化；草稿保留，应用前请核对' : state.defaultsSet === false ? '首次设置尚未保存' : dirty ? '有待应用的选择' : '与已保存配置一致';
  $('apply').textContent = state.defaultsSet === false ? '保存当前设置' : '应用变更';
  $('apply').disabled = busy || !needsApply(state, draft, base) || !selected;
  $('reset-config').disabled = busy || !dirty;
  const count = Object.values(state.armed).filter(v => v.length).length;
  $('apply-hint').textContent = state.paused ? '已暂停，保存只记录选择，不写入任何执行器。' : count ? `保存后同步到这 ${count} 个执行器。` : '还没接管任何 AI，先在下面选一个。';
}
function miniSelect(h, kind) {
  const isPersona = kind === 'persona';
  const globalPersona = state.personas.find(p => p.id === state.persona);
  const options = isPersona
    ? [{ value: '', label: '人设·跟随' }, ...state.personas.map(p => ({ value: p.id, label: personaName(p) }))]
    : [{ value: '', label: '模式·跟随' }, ...state.modes.map(m => ({ value: m, label: MODE_LABELS[m] }))];
  // 只有真写了例外才选中覆盖值，否则选中“跟随全局”
  const current = isPersona ? (h.personaFrom === 'override' ? h.persona || '' : '') : (h.modeFrom === 'override' ? h.mode || '' : '');
  const globalNow = isPersona ? personaName(globalPersona) : MODE_LABELS[state.defaults?.mode || 'replace'];
  const what = isPersona ? '人设' : '模式';
  const shown = isPersona ? personaName(state.personas.find(p => p.id === h.persona)) : MODE_LABELS[h.mode] || h.mode;
  const source = current ? '（单独指定）' : `（跟随全局：${globalNow}）`;

  const selectedOpt = options.find(o => o.value === current) || options[0];

  // 隐藏的原生 select 供保持底层的 form/change 事件派发机制
  const nativeSelect = node('select', {
    class: 'custom-select-native',
    [isPersona ? 'data-hpersona' : 'data-hmode']: h.id,
    tabindex: '-1',
    'aria-hidden': 'true'
  }, options.map(o => node('option', { value: o.value }, o.label)));
  nativeSelect.value = current;

  // 现代风格自定义触发按钮
  const trigger = node('button', {
    type: 'button',
    class: `custom-select-trigger ${current ? 'is-override' : ''}`,
    [isPersona ? 'data-hpersona' : 'data-hmode']: h.id,
    title: `${h.id} 的${what}：${shown}${source}`,
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-label': `${h.id} ${what}：当前 ${selectedOpt.label}`
  },
    node('span', { class: 'custom-select-label' }, selectedOpt.label),
    node('svg', { class: 'custom-select-chevron', viewBox: '0 0 12 12', width: '9', height: '9', fill: 'none', 'aria-hidden': 'true' },
      node('path', { d: 'M2.5 4.5L6 8L9.5 4.5', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
  );

  // 现代风格浮层选项面板
  const menu = node('div', {
    class: 'custom-select-menu',
    role: 'listbox',
    'aria-label': `${h.id} ${what} 选项`
  }, options.map(o => {
    const isSel = o.value === current;
    return node('div', {
      class: `custom-select-option ${isSel ? 'is-selected' : ''}`,
      role: 'option',
      'data-value': o.value,
      'aria-selected': String(isSel),
      tabindex: '-1'
    },
      node('span', { class: 'custom-select-option-text' }, o.label),
      node('svg', { class: 'custom-select-check', viewBox: '0 0 12 12', width: '11', height: '11', fill: 'none', 'aria-hidden': 'true' },
        node('path', { d: 'M2.5 6.5L4.8 8.8L9.5 3.5', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
    );
  }));

  return node('div', {
    class: `custom-select ${current ? 'is-override' : ''}`,
    'data-custom-select': 'true'
  }, trigger, menu, nativeSelect);
}

function initCustomSelects() {
  document.addEventListener('click', e => {
    const trigger = e.target.closest('.custom-select-trigger');
    const option = e.target.closest('.custom-select-option');

    // 点击触发按钮：打开/关闭
    if (trigger) {
      e.preventDefault();
      const container = trigger.closest('.custom-select');
      if (!container) return;
      const wasOpen = container.classList.contains('is-open');
      closeAllCustomSelects();
      if (!wasOpen) {
        container.classList.add('is-open');
        container.closest('.harness-capsule')?.classList.add('has-open-select');
        trigger.setAttribute('aria-expanded', 'true');
        // 智能定位：检测距离视口底部空间，不足时向上翻转
        const menu = container.querySelector('.custom-select-menu');
        if (menu) {
          const rect = trigger.getBoundingClientRect();
          const menuHeight = 180;
          if (rect.bottom + menuHeight > window.innerHeight && rect.top > menuHeight) {
            container.classList.add('is-dropup');
          } else {
            container.classList.remove('is-dropup');
          }
          if (rect.left + 160 > window.innerWidth) {
            container.classList.add('is-align-right');
          } else {
            container.classList.remove('is-align-right');
          }
        }
      }
      return;
    }

    // 点击选项：选中并派发原生 change 事件
    if (option) {
      e.preventDefault();
      const container = option.closest('.custom-select');
      if (!container) return;
      const native = container.querySelector('.custom-select-native');
      const val = option.dataset.value;
      if (native && native.value !== val) {
        native.value = val;
        native.dispatchEvent(new Event('change', { bubbles: true }));
      }
      closeAllCustomSelects();
      return;
    }

    // 点击外部：关闭所有打开的下拉
    closeAllCustomSelects();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeAllCustomSelects();
      return;
    }
    const open = document.querySelector('.custom-select.is-open');
    if (!open) return;
    const items = Array.from(open.querySelectorAll('.custom-select-option'));
    let idx = items.findIndex(el => el.classList.contains('is-focused'));

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx = (idx + 1) % items.length;
      items.forEach((el, i) => el.classList.toggle('is-focused', i === idx));
      items[idx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('is-focused', i === idx));
      items[idx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (idx >= 0 && items[idx]) {
        e.preventDefault();
        items[idx].click();
      }
    }
  });
}

function closeAllCustomSelects() {
  document.querySelectorAll('.custom-select.is-open').forEach(el => {
    el.classList.remove('is-open', 'is-dropup', 'is-align-right');
    el.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
    el.querySelectorAll('.custom-select-option').forEach(opt => opt.classList.remove('is-focused'));
  });
  document.querySelectorAll('.harness-capsule.has-open-select').forEach(el => el.classList.remove('has-open-select'));
}
function renderHarnesses() {
  $('scope-summary').textContent = scopeSummary(state);
  const rows = sortedHarnesses(state, $('show-all').checked);
  if (!rows.length) {
    $('harness-list').replaceChildren(empty('没发现任何可配置的 AI。勾选“显示本机没装的”看看能配哪些。'));
    return;
  }

  const capsules = rows.map(h => {
    const on = h.armed.length > 0;
    const failed = state.lastApply?.results?.some(r => r.harness === h.id && r.status === 'failed');
    const installed = Boolean(h.found || h.homeExists);
    const isSelected = expanded === h.id;
    let statusText = on ? '已选择' : installed ? h.bin ? '已就绪' : '发现配置' : '未安装';
    if (on && state.paused) statusText = '已暂停';
    if (on && !state.paused && h.mode === 'off') statusText = '单独暂停';
    if (on && failed) statusText = '需重试';

    const capsuleClass = [
      'harness-capsule',
      on ? 'is-on' : '',
      failed ? 'is-bad' : '',
      isSelected ? 'is-selected' : '',
      !installed && !on ? 'is-uninstalled' : ''
    ].filter(Boolean).join(' ');

    return node('div', { class: capsuleClass },
      node('button', { type: 'button', class: 'capsule-body', 'data-expand': h.id, 'aria-expanded': String(isSelected), ...(isSelected ? { 'aria-controls': `drawer-${h.id}` } : {}), title: `${h.id} (${statusText}) - 点击展开详情` },
        harnessIcon(h.id, 24),
        node('div', { class: 'capsule-info' },
          node('div', { class: 'capsule-name-row' },
            node('span', { class: 'capsule-title' }, h.id),
            node('span', { class: `capsule-dot ${on ? 'is-on' : ''}` }),
            state.defaultsSet && state.defaults.harness === h.id && node('span', { class: 'capsule-badge-default' }, '默认')
          ),
          node('span', { class: 'capsule-status-text' }, statusText)
        )
      ),
      node('label', { class: 'switch switch-sm', title: `${on ? '关闭' : '开启'} ${h.id} 接管` },
        node('input', {
          type: 'checkbox',
          'data-toggle': h.id,
          checked: on,
          disabled: !installed && !on,
          'aria-label': `${on ? '关掉' : '打开'} ${h.id} 的人设接管`
        }),
        node('span', { class: 'switch-track', 'aria-hidden': 'true' })
      ),
      // 单独占一行：胶囊水平空间只够放开关，塞在标题旁必被挤成“人设·”
      node('div', { class: 'capsule-config' }, miniSelect(h, 'persona'), miniSelect(h, 'mode'))
    );
  });

  const gridNode = node('div', { class: 'harness-grid' }, capsules);

  const expandedHarness = rows.find(h => h.id === expanded);
  let drawerNode = null;
  if (expandedHarness) {
    const h = expandedHarness;
    const on = h.armed.length > 0;
    const failed = state.lastApply?.results?.some(r => r.harness === h.id && r.status === 'failed');
    const installed = Boolean(h.found || h.homeExists);
    let statusBadge = on ? badge('已选择', 'good') : badge(installed ? '未接管' : '未安装', installed ? '' : 'warn');
    if (on && state.paused) statusBadge = badge('已暂停', 'warn');
    if (on && !state.paused && h.mode === 'off') statusBadge = badge('单独暂停', 'warn');
    if (on && failed) statusBadge = badge('需要重试', 'bad');

    const effect = effectLabel(h, state.paused, state.dshRuntime);

    drawerNode = node('div', { id: `drawer-${h.id}`, class: 'harness-drawer' },
      node('div', { class: 'drawer-header' },
        node('div', { class: 'drawer-title-group' },
          harnessIcon(h.id, 34),
          node('div', { class: 'drawer-meta' },
            node('div', { class: 'drawer-name-row' },
              node('span', { class: 'drawer-title' }, h.id),
              statusBadge,
              h.hotSwitch ? hotBadge('支持热切', 'good', 'hot') : hotBadge('需新会话', '', 'restart'),
              evidenceBadge(h.id),
              state.defaultsSet && state.defaults.harness === h.id && badge('默认启动项', 'blue')
            ),
            Boolean(effect) && node('div', { class: 'drawer-effect' }, effect)
          )
        ),
        node('div', { class: 'drawer-actions' },
          node('label', { class: 'switch', title: `${on ? '关闭' : '开启'}接管` },
            node('input', {
              type: 'checkbox',
              'data-toggle': h.id,
              checked: on,
              disabled: !installed && !on,
              'aria-label': `${on ? '关掉' : '打开'} ${h.id} 的人设接管`
            }),
            node('span', { class: 'switch-track', 'aria-hidden': 'true' })
          ),
          node('button', {
            type: 'button',
            class: 'drawer-close',
            'data-close-drawer': 'true',
            'aria-label': '收起详情',
            title: '收起详情'
          }, '✕')
        )
      ),
      node('div', { class: 'drawer-body' }, harnessDetail(h))
    );
  }

  const focus = focusKey(document.activeElement);
  $('harness-list').replaceChildren(gridNode, ...(drawerNode ? [drawerNode] : []));
  lockControls();
  if (!busy) restoreFocus(focus);
}
function harnessDetail(h) {
  const channels = ['install', 'slash', 'shim', 'project'];
  // 项目块的真相在磁盘上（projectOn），armed 只是缓存
  const channelOn = c => c === 'project' ? Boolean(h.projectOn) : h.armed.includes(c);
  const supported = channels.filter(c => h.caps?.[c]?.ok || channelOn(c));
  const desc = {
    install: ['dsh', 'opencode', 'opencode2'].includes(h.id) ? '全局生效：装成宿主插件，新会话自动读取（无需每次带参数）；首次安装或更新代码需重启。' : '全局生效：写入这家自己的全局配置文件（人格/指令落点），新会话读取；不改命令本身。',
    slash: h.id === 'dsh' ? '装上 /purge 命令插件后，在 dsh 会话里输 /purge on 开启当前会话。注意：它只是个开关，注入靠「常驻配置」，两样都要启用；首次安装要重启 dsh。' : '安装扩展后重新加载宿主，用 /purge on 开启当前会话：同一会话内热切换人设，不重开不重启。',
    shim: '接管终端裸命令：在 PATH 前面放一层同名壳，以后你直接敲 codex/pi 就等于敲 agent-purge codex/pi，启动时自动注入；不影响已运行会话与桌面图标。',
    project: `写进当前目录的 ${h.caps?.project?.file || 'AGENTS.md'}；其他原生执行器也可能读取这个同名文件。每个文件只登记一个管理归属，同时开全局通道会有两份。`,
  };
  const installed = Boolean(h.found || h.homeExists);
  return [
    node('div', { class: 'capsule-config drawer-config' }, miniSelect(h, 'persona'), miniSelect(h, 'mode')),
    node('div', { class: 'verify-row' },
      node('button', { class: 'secondary', 'data-verify': h.id, disabled: !installed, title: '临时 HOME + 测试人设 + 本地 provider；不检查或修改当前桌面会话' }, '隔离验证一次'),
      node('div', {}, node('p', { class: 'help' }, verifyNote(h.id)))),
    !supported.length && node('p', { class: 'detail-note' }, h.reason || h.caps?.install?.why || '没有可配置的通道'),
    ...supported.map(channel => {
      const isOn = channelOn(channel);
      const blocked = !h.caps?.[channel]?.ok && !isOn;
      return node('div', { class: 'channel-row' }, node('div', {}, node('strong', {}, CHANNEL_LABELS[channel]), node('p', { class: 'help' }, h.caps?.[channel]?.why || desc[channel])), node('button', { class: 'secondary', 'data-channel': channel, 'data-target': h.id, 'data-enabled': String(!isOn), disabled: blocked }, isOn ? '关闭' : '启用'));
    }),
    ['pi', 'omp'].includes(h.id) && h.armed.includes('slash') && node('label', { class: 'check-label advanced' }, node('input', { type: 'checkbox', 'data-auto': h.id, checked: state[`${h.id}Auto`] }), ' 新会话自动应用（关闭时须 /purge on）'),
    h.id === 'dsh' && h.homeExists && node('div', { class: 'profile-options' }, state.dshAll.map(p => node('label', {}, node('input', { type: 'checkbox', 'data-profile': p, checked: state.dshProfiles.includes(p) }), p))),
    node('details', { class: 'advanced' }, node('summary', {}, '技术详情与不可用通道'), node('p', { class: 'help' }, `热切能力：${h.caps?.hot?.how || h.caps?.hot?.why || '待核实'}`), node('p', { class: 'help' }, '配置路径：', node('code', { class: 'path' }, h.persistFile || h.home || '—')), h.install && h.install !== h.home ? node('p', { class: 'help' }, '安装目录：', node('code', { class: 'path' }, h.install), h.installSource ? `（${INSTALL_SOURCE[h.installSource] || h.installSource}）` : '') : null, node('p', { class: 'help' }, '命令入口：', node('code', { class: 'path' }, h.bin || '未发现')), channels.filter(c => !h.caps?.[c]?.ok).map(c => node('p', { class: 'help' }, `${CHANNEL_LABELS[c]}：${h.caps?.[c]?.why || '不可用'}`))),
  ];
}
function renderPersonas() {
  const query = $('persona-search').value.toLocaleLowerCase();
  const list = state.personas.filter(p => `${p.id} ${personaName(p)} ${p.meta.description || ''}`.toLocaleLowerCase().includes(query));
  $('persona-list').replaceChildren(...(list.length ? list.map(p => node('button', { class: `persona-item ${editor === p.id ? 'selected' : ''}`, 'data-persona': p.id }, node('strong', {}, personaName(p)), node('small', {}, `${p.id} · ${p.chars} 字`), state.active === p.id && badge('当前人设', 'blue'))) : [empty('没有匹配的人设')]));
}
function confirmDiscard() { return !editorDirty() || window.confirm('这份人设有未保存修改，放弃修改？'); }
function openEditor(id) {
  if (!confirmDiscard()) return;
  editor = id || '';
  const p = state.personas.find(p => p.id === id);
  $('editor-empty').hidden = true; $('editor-form').hidden = false;
  $('edit-id').value = p?.id || ''; $('edit-id').disabled = Boolean(p);
  $('edit-name').value = p?.meta?.name || ''; $('edit-desc').value = p?.meta?.description || p?.meta?.desc || '';
  $('edit-body').value = p?.body || ''; $('edit-model').value = (p?.meta?.model || []).join(', ');
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
  $('editor-hint').textContent = current ? '当前人设的正文保存后会同步到已选范围；暂停时不会恢复应用。' : '“保存”只更新人设库；“保存并应用”会切换当前人设并同步。';
}
async function saveEditor(apply) {
  if (!$('editor-form').reportValidity()) return;
  const value = editorValue();
  if (!editor && state.personas.some(p => p.id === value.id)) { notify('这个标识已存在，请换一个标识，避免覆盖已有的人设。', 'error'); return; }
  await operation(async () => {
    const result = await api('persona', { ...value, apply });
    editor = result.persona.id;
    editorBaseline = JSON.stringify(value);
    await refresh({ resetDraft: apply });
    announce(result, apply ? '人设已保存并应用。' : '人设已保存。');
  });
}
function renderReport() {
  const r = state.lastApply;
  $('retry-failed').hidden = !r?.results?.some(x => x.status === 'failed');
  $('report-meta').textContent = r ? `${new Date(r.at).toLocaleString('zh-CN')} · 版本 ${r.revision} · ${MODE_LABELS[r.mode]}` : '应用后会记录每个通道的写入结果。';
  $('apply-results').className = '';
  $('apply-results').replaceChildren(...(!r ? [empty('尚无应用记录')] : !r.results.length ? [empty('配置已保存，当前没有需要写入的通道。')] : r.results.map(x => node('div', { class: 'result-row' }, node('div', {}, node('strong', {}, x.harness), node('p', { class: 'muted' }, CHANNEL_LABELS[x.channel] || x.channel)), badge(x.status === 'failed' ? '写入失败' : '配置已处理', x.status === 'failed' ? 'bad' : 'good'), node('p', { class: x.status === 'failed' ? 'error-text' : 'muted' }, x.error || x.message || '', x.status !== 'failed' && [node('br'), '运行中会话：尚未确认'])))));
}
function captureRow(result) {
  const modes = result.modes || [];
  const hot = result.hotSwitch?.status || 'not-tested';
  const strict = modes.find(m => m.mode === 'strict');
  const roles = [...new Set(modes.flatMap(m => (m.requests || []).flatMap(r => r.roles || [])))].join(' + ');
  const residual = strict?.requests?.some(r => r.identityLines?.length);
  const assessment = verificationEvidence(result);
  const details = modes.length ? node('details', {}, node('summary', {}, `${modes.length} 种模式的请求证据`), modes.map(m => node('p', { class: 'help' }, `${MODE_LABELS[m.mode] || m.mode} · ${CAPTURE_LABELS[m.status] || m.status}：`, m.reason || '', (m.requests || []).map(r => `${(r.roles || []).join('+')} / ${r.chars}字 / 人设${r.markerCount}次 / 身份句${r.identityLines?.length || 0} / 工具${r.toolDefinitions}`).join('；')))) : null;
  return node('tr', {},
    node('td', {}, node('strong', {}, result.harness), node('p', { class: 'muted' }, result.version || '版本未知'), node('p', { class: 'help' }, captureScopeLabel(result.scope))),
    node('td', {}, roles || '—'),
    node('td', {}, badge(assessment.label, assessment.kind), residual && node('p', { class: 'help' }, '仍有固定身份句')),
    node('td', {}, badge(CAPTURE_LABELS[hot] || hot, hot === 'passed' ? 'good' : ''), hot === 'passed' && node('p', { class: 'help' }, `${captureScopeLabel(result.hotSwitch?.scope)} · A → B → ${MODE_LABELS.strict} → ${MODE_LABELS.off}`)),
    node('td', {}, result.reason || (!modes.length ? result.evidence || '' : ''), result.hotSwitch?.reason && node('p', { class: 'help' }, result.hotSwitch.reason), details));
}
async function loadCapture() {
  try {
    capture = await api('verification');
    const report = capture.report;
    const command = node('p', { class: 'help' }, '重新验证：', node('code', {}, 'npm run test:harness'));
    $('capture-results').replaceChildren(...(!report ? [node('p', { class: 'muted' }, '暂无请求捕获报告。测试使用隔离配置和本地服务，不以模型自报身份作为证据。'), command] : [
      node('p', { class: 'help path' }, `${report.at} · 历史独立测试，不代表当前会话 · ${report.reportPath || ''}`),
      node('p', { class: 'help' }, '这是隔离测试，不是当前桌面会话。未捕获请求不等于人设未命中；命中也不证明模型行为符合人设。暂停模式单独判定。'),
      node('div', { class: 'table-scroll' }, node('table', { class: 'capture-table' }, node('thead', {}, node('tr', {}, ['执行器 / 版本', '实际角色', '请求捕获', '同会话热切', '证据 / 原因'].map(label => node('th', {}, label)))), node('tbody', {}, report.results.map(captureRow)))), command]));
  } catch (error) { $('capture-results').textContent = `报告读取失败：${error.message}`; }
}
const pageFromHash = () => ({ personas: 'library', overview: 'console' }[location.hash.slice(1)] || location.hash.slice(1) || 'console');
async function navigate(page, { replace = false, focus = true } = {}) {
  if (!['console', 'library', 'diagnostics'].includes(page)) page = 'console';
  if (activePage === 'library' && page !== 'library' && !confirmDiscard()) {
    history.replaceState(null, '', '#library');
    return;
  }
  // 放弃的编辑不应在下次进入时悄悄复活。
  if (activePage === 'library' && page !== 'library' && editorDirty()) { editor = null; $('editor-form').hidden = true; $('editor-empty').hidden = false; }
  activePage = page;
  document.querySelectorAll('.page').forEach(el => el.hidden = el.id !== `page-${page}`);
  document.querySelectorAll('[data-page]').forEach(el => el.setAttribute('aria-current', el.dataset.page === page ? 'page' : 'false'));
  if (replace || location.hash !== `#${page}`) history[replace ? 'replaceState' : 'pushState'](null, '', `#${page}`);
  if (focus) $('main').focus({ preventScroll: true });
  if (page === 'diagnostics') await loadCapture();
}
window.addEventListener('hashchange', () => navigate(pageFromHash(), { replace: true }));
document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.page)));
$('current-sync').addEventListener('click', e => { e.preventDefault(); navigate('diagnostics'); });
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); navigate('console'); });
$('persona-select').addEventListener('change', () => { draft.persona = $('persona-select').value; renderConfigControls(); });
document.querySelectorAll('[name=mode]').forEach(el => el.addEventListener('change', () => { draft.mode = mode(); renderConfigControls(); }));
$('reset-config').addEventListener('click', () => { draft = { ...base }; draftConflict = false; render(); });
$('config-form').addEventListener('submit', e => { e.preventDefault(); operation(async () => { const result = await api('apply', { persona: draft.persona, mode: state.paused ? 'off' : draft.mode, ...(state.defaultsSet === false ? { harness: state.defaults.harness } : {}), ...(state.paused ? { resumeMode: draft.mode } : {}) }); await refresh({ resetDraft: result.ok === true }); announce(result, state.paused ? '选择已保存，仍保持暂停。' : '变更已应用。请按各通道提示检查生效时机。'); }); });
$('power').addEventListener('click', () => operation(async () => { const on = state.paused; const result = await api('power', { on }); await refresh(); announce(result, on ? '已恢复原选择范围。' : '已暂停；静态内容已撤下，旧会话可能需要重开。'); }));
$('disarm-all').addEventListener('click', () => {
  if (!window.confirm('确定撤销所有已登记的接管吗？\n\n- 暂停：撤下静态内容并保留通道选择；\n- 完全还原：撤销托管配置、插件与同名命令，保留人设和用户修改；恢复冲突会保留凭据并报错。\n\n这不会卸载 agent-purge 程序本身。')) return;
  operation(async () => {
    const res = await api('clean', {});
    await refresh();
    if (res.ok) notify('已撤销登记的接管，人设和用户修改已保留。', 'good');
    else notify(`部分项目撤销失败：${(res.leftovers || []).join('；')}`, 'warn');
  });
});
$('refresh').addEventListener('click', () => operation(async () => { await refresh(); notify('状态已刷新，未保存的草稿保持不变。'); }));
$('show-all').addEventListener('change', renderHarnesses);
const toggleExpand = id => { expanded = expanded === id ? null : id; renderHarnesses(); };
$('harness-list').addEventListener('click', e => {
  const closeBtn = e.target.closest('[data-close-drawer]');
  if (closeBtn) { toggleExpand(null); return; }
  if (e.target.closest('.switch')) return;
  const verifyBtn = e.target.closest('[data-verify]');
  if (verifyBtn) {
    const id = verifyBtn.dataset.verify;
    operation(async () => {
      const r = await api('verify', { harness: id });
      try { capture = await api('verification'); } catch { /* 报告读不到就保持旧的 */ }
      await refresh();
      const assessment = r.assessment || verificationEvidence(captureFor(id));
      const where = r.roles?.join('+') || '角色未记录';
      notify(`${id}：${assessment.label} · ${captureScopeLabel(r.scope)}${assessment.state === 'verified' ? ` · ${where}，${r.chars ?? 0} 字` : ''}${r.reason ? `；${r.reason}` : ''}。不代表当前会话已应用。`, ['verified', 'off-verified'].includes(assessment.state) ? '' : 'warn');
    });
    return;
  }
  const expand = e.target.closest('[data-expand]');
  // 行内下拉自己处理点击，不能连带展开抽屉
  if (e.target.closest('.capsule-config')) return;
  if (expand) { toggleExpand(expand.dataset.expand); return; }
  const btn = e.target.closest('[data-channel]'); if (!btn) return;
  operation(async () => { const result = await api('arm', { harness: btn.dataset.target, channel: btn.dataset.channel, action: btn.dataset.enabled === 'true' ? 'on' : 'off' }); await refresh(); announce(result, '应用范围已更新。首次加载或更新扩展后请重新加载宿主。'); });
});
$('harness-list').addEventListener('change', e => {
  const el = e.target;
  const hp = el.dataset.hpersona, hm = el.dataset.hmode;
  if (hp) {
    const pick = el.value;
    operation(async () => { const result = await api('harness', { harness: hp, persona: pick || 'follow' }); await refresh(); announce(result, pick ? `${hp} 换用 ${pick}。` : `${hp} 恢复跟随全局人设。`); });
    return;
  }
  if (hm) {
    const pick = el.value;
    operation(async () => { const result = await api('harness', { harness: hm, mode: pick || 'follow' }); await refresh(); announce(result, pick ? `${hm} 模式 → ${MODE_LABELS[pick] || pick}。` : `${hm} 恢复跟随全局模式。`); });
    return;
  }
  if (el.dataset.toggle) {
    const id = el.dataset.toggle, on = el.checked;
    operation(async () => { const result = await api('arm', { harness: id, channel: 'auto', action: on ? 'on' : 'off' }); await refresh(); announce(result, on ? `${id} 开始使用当前人设。` : `${id} 已恢复原样。`); });
    return;
  }
  if (el.dataset.auto) operation(async () => { await api(`${el.dataset.auto}-auto`, { on: el.checked }); await refresh(); notify('自动应用设置已更新。'); });
  if (el.dataset.profile) operation(async () => { await api('dsh-profile', { profile: el.dataset.profile, on: el.checked }); await refresh(); notify('dsh 生效形态已更新。'); });
});
// 标准 button/select/input 使用浏览器原生键盘语义，不拦截子控件的 Enter/Space。
$('default-form').addEventListener('submit', e => { e.preventDefault(); operation(async () => { const result = await api('defaults', { harness: $('default-harness').value || null }); await refresh(); announce(result, '默认启动设置已保存，应用范围未改变。'); }); });
$('edit-current').addEventListener('click', () => { openEditor(draft.persona); navigate('library'); });
$('new-persona').addEventListener('click', () => openEditor(''));

// 外部拉取人设
const importDialog = $('import-dialog');
const importStatus = $('import-status');
const importSourceInput = $('import-source');
const startImportBtn = $('start-import');

$('pull-personas')?.addEventListener('click', () => {
  if (!importDialog) return;
  if (!importSourceInput.value.trim()) {
    importSourceInput.value = 'ZiChuanLan/some-magic';
  }
  importStatus.hidden = true;
  importStatus.className = 'import-status';
  importStatus.textContent = '';
  startImportBtn.disabled = false;
  startImportBtn.textContent = '开始拉取';
  importDialog.showModal();
});

$('close-import')?.addEventListener('click', () => importDialog?.close());
$('cancel-import')?.addEventListener('click', () => importDialog?.close());

importDialog?.addEventListener('click', e => {
  const pill = e.target.closest('[data-preset]');
  if (pill) {
    importSourceInput.value = pill.dataset.preset;
    importSourceInput.focus();
  }
});

$('import-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const source = importSourceInput.value.trim();
  if (!source) return;
  const overwrite = $('import-overwrite').checked;
  startImportBtn.disabled = true;
  startImportBtn.textContent = '正在拉取…';
  importStatus.hidden = false;
  importStatus.className = 'import-status';
  importStatus.textContent = `正在从 ${source} 拉取人设…`;

  try {
    const res = await api('persona/import', { source, overwrite });
    if (!res.ok) throw new Error(res.error || '拉取失败');
    const { total = 0, imported = [] } = res.result || {};
    importStatus.className = 'import-status success';
    const names = imported.map(x => x.name || x.id).slice(0, 3).join('、');
    const suffix = imported.length > 3 ? '等' : '';
    const detail = names ? `（${names}${suffix}）` : '';
    importStatus.textContent = `✓ 成功导入 ${total} 个人设${detail}！`;
    await refresh();
    notify(`成功拉取 ${total} 个人设。`);
    setTimeout(() => {
      importDialog?.close();
    }, 1200);
  } catch (err) {
    importStatus.className = 'import-status error';
    importStatus.textContent = `✗ 导入失败：${err.message}`;
    notify(`人设导入失败：${err.message}`, 'error');
  } finally {
    startImportBtn.disabled = false;
    startImportBtn.textContent = '开始拉取';
  }
});
$('persona-search').addEventListener('input', renderPersonas);
$('persona-list').addEventListener('click', e => { const el = e.target.closest('[data-persona]'); if (el) openEditor(el.dataset.persona); });
$('editor-form').addEventListener('input', renderEditorStatus);
$('editor-form').addEventListener('submit', e => { e.preventDefault(); saveEditor(false); });
$('save-apply').addEventListener('click', () => saveEditor(true));
$('delete-persona').addEventListener('click', () => { if (!confirm(`删除人设“${editor}”？${editor === state.active ? '当前人设将回退并同步到已选范围。' : ''}`)) return; operation(async () => { const result = await api(`persona?id=${encodeURIComponent(editor)}`, null, 'DELETE'); editor = null; editorBaseline = ''; $('editor-form').hidden = true; $('editor-empty').hidden = false; await refresh({ resetDraft: true }); announce(result, '人设已删除。'); }); });
$('sync-all').addEventListener('click', () => operation(async () => { const r = await api('sync', {}); await refresh(); announce(r, '已重新同步原范围。'); }));
$('retry-failed').addEventListener('click', () => operation(async () => { const r = await api('sync', { onlyFailed: true }); await refresh(); announce(r, '失败项已重试。'); }));
let cachedUpdateInfo = null;

function showUpdateDialog(res) {
  const dialog = $('update-dialog');
  if (!dialog) return;

  $('update-current-tag').textContent = `当前: v${res.current}`;
  $('update-latest-tag').textContent = `最新: v${res.latest}`;

  const sources = [];
  if (res.npm?.ok && res.npm?.latest === res.latest) sources.push('npm');
  if (res.github?.ok && res.github?.latest === res.latest) sources.push('GitHub');
  $('update-source-label').textContent = sources.length ? `来源: ${sources.join(' / ')}` : '';

  const changelog = (res.github?.body || res.body || '').trim();
  $('update-changelog-text').textContent = changelog || '暂无详细发布说明。';
  $('update-changelog-box').hidden = !changelog;

  const isExe = res.isExe || res.installType === 'exe';
  const cmdBox = $('update-command-box');
  const doBtn = $('btn-do-upgrade');
  const statusEl = $('update-status');
  statusEl.hidden = true;
  statusEl.textContent = '';
  statusEl.className = 'import-status';

  if (isExe) {
    cmdBox.hidden = true;
    doBtn.textContent = '一键就地升级';
    doBtn.title = '自动下载新版 EXE 并进行热替换';
  } else {
    cmdBox.hidden = false;
    $('update-command-text').textContent = res.npm?.command || 'npm install -g agent-purge@latest';
    doBtn.textContent = '一键执行 npm 升级';
    doBtn.title = '后台自动调用 npm 全局更新';
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
    if (res.hasUpdate) {
      vb.className = 'badge good';
      vb.textContent = `v${res.current} (发现 v${res.latest})`;
      vb.title = `发现新版本 v${res.latest}，点击查看并一键升级`;
      if (force) {
        showUpdateDialog(res);
      }
    } else {
      vb.className = 'badge';
      vb.title = `当前版本 v${res.current} 已是最新，点击可重新检查`;
      if (force) notify(`当前已是最新版本 v${res.current}！（npm 与 GitHub 均已对齐）`, 'good');
    }
  } catch {
    /* 离线或后台探测失败不阻碍主界面 */
  }
}

$('version-badge')?.addEventListener('click', () => {
  if (cachedUpdateInfo?.hasUpdate) {
    showUpdateDialog(cachedUpdateInfo);
  } else {
    checkAppUpdate(true);
  }
});
$('close-update')?.addEventListener('click', () => $('update-dialog')?.close());
$('dismiss-update')?.addEventListener('click', () => $('update-dialog')?.close());
$('copy-update-command')?.addEventListener('click', () => {
  const cmd = $('update-command-text')?.textContent;
  if (cmd) {
    navigator.clipboard?.writeText(cmd).then(() => notify('升级命令已复制！', 'good')).catch(() => {});
  }
});

$('btn-do-upgrade')?.addEventListener('click', async () => {
  if (!cachedUpdateInfo) return;
  const doBtn = $('btn-do-upgrade');
  const statusEl = $('update-status');
  const isExe = cachedUpdateInfo.isExe || cachedUpdateInfo.installType === 'exe';

  doBtn.disabled = true;
  doBtn.textContent = isExe ? '正在下载替换...' : '正在执行 npm 升级...';
  statusEl.hidden = false;
  statusEl.className = 'import-status';
  statusEl.textContent = isExe ? '正在下载最新版本可执行文件并进行热替换，请稍候...' : '正在调用 npm 执行全局更新，可能需要十几秒...';

  try {
    const res = await api('update-upgrade', { type: isExe ? 'exe' : 'npm' });
    if (res.ok) {
      statusEl.className = 'import-status success';
      statusEl.textContent = res.message || '升级成功！';
      doBtn.textContent = '升级完成';
      notify(res.message || '升级成功！', 'good');
      setTimeout(() => {
        $('update-dialog')?.close();
        checkAppUpdate(true);
      }, 2500);
    } else {
      statusEl.className = 'import-status error';
      statusEl.textContent = res.error || '更新失败';
      if (res.output) statusEl.textContent += `\n${res.output}`;
      doBtn.disabled = false;
      doBtn.textContent = isExe ? '重试就地升级' : '重试 npm 升级';
    }
  } catch (err) {
    statusEl.className = 'import-status error';
    statusEl.textContent = err.message || '网络请求异常';
    doBtn.disabled = false;
    doBtn.textContent = isExe ? '重试就地升级' : '重试 npm 升级';
  }
});
$('exit-btn')?.addEventListener('click', async () => {
  if (configDirty() || editorDirty()) {
    if (!confirm('当前有未保存的设置或草稿，确定退出并关闭吗？')) return;
  }
  $('connection').textContent = '服务已停止';
  notify('正在退出本地服务并关闭窗口…', 'muted');
  try {
    await fetch('/api/exit', { method: 'POST', keepalive: true });
  } catch {}
  setTimeout(() => {
    window.close();
  }, 200);
});

// 心跳保活与窗口关闭联动
setInterval(() => {
  fetch('/api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {});
}, 2500);

window.addEventListener('pagehide', event => {
  // 进 bfcache 不是关闭（回退还能接着用），别在那里埋退出倒计时
  if (event.persisted) return;
  try {
    // 刷新也会触发 pagehide，所以这里只上报"这一代页面走了"，是否退出由服务端裁决：
    // 源码态 `agent-purge web` 不会退，桌面窗口会留宽限期等新页面来撤销。
    const gen = document.querySelector('meta[name="ap-server-gen"]')?.getAttribute('content') ?? '';
    const target = `/api/leave?gen=${encodeURIComponent(gen)}`;
    if (navigator.sendBeacon) {
      navigator.sendBeacon(target);
    } else {
      fetch(target, { method: 'POST', keepalive: true }).catch(() => {});
    }
  } catch {}
});

window.addEventListener('beforeunload', e => { if (configDirty() || editorDirty()) { e.preventDefault(); e.returnValue = ''; } });
initCustomSelects();
refresh().then(() => navigate(pageFromHash(), { replace: true, focus: false })).then(() => checkAppUpdate(false)).catch(error => { $('connection').textContent = '本地服务未连接'; notify(`${error.message} 使用右上角“刷新状态”重试。`, 'error'); });
