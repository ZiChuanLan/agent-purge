import { getLocale, isZh, listJoin, pick } from './i18n.mjs';

const MODE_LABELS_BY_LOCALE = {
	en: { strict: 'Persona Only', replace: 'Replace Identity', append: 'Append', off: 'Paused' },
	'zh-CN': { strict: '只留人设', replace: '替换身份', append: '末尾追加', off: '暂停' },
};
const MODE_DESCRIPTIONS_BY_LOCALE = {
	en: {
		replace: 'Keeps built-in coding rules and tool definitions; replaces only the assistant identity. Recommended for most tools.',
		strict: 'Suppresses controllable built-in system instructions so the persona takes priority. Scope varies by tool.',
		append: 'Keeps the built-in system prompt intact and appends the persona at the end. Required for append-only tools.',
		off: 'Pauses persona injection for this tool while keeping local configuration.',
	},
	'zh-CN': {
		replace: '保留原厂代码规范与工具定义，只把助手对自己的认知换成人设。多数工具推荐。',
		strict: '把可控入口的原厂系统指令一起压掉，让人设优先。各家能压的范围不同。',
		append: '原厂系统提示词原样保留，在末尾补一段人设。写入型工具只能这样做。',
		off: '暂停对这个工具的注入，已有本地配置保留。',
	},
};

export const modeLabels = (locale = getLocale()) => (isZh(locale) ? MODE_LABELS_BY_LOCALE['zh-CN'] : MODE_LABELS_BY_LOCALE.en);
export const modeDescriptions = (locale = getLocale()) => (isZh(locale) ? MODE_DESCRIPTIONS_BY_LOCALE['zh-CN'] : MODE_DESCRIPTIONS_BY_LOCALE.en);

// Legacy exports kept for existing imports; prefer modeLabels()/modeDescriptions() for dynamic locale.
export const MODE_LABELS = new Proxy({}, {
	get: (_, key) => modeLabels()[key],
	ownKeys: () => Object.keys(MODE_LABELS_BY_LOCALE.en),
	getOwnPropertyDescriptor: (_, key) => ({ enumerable: true, configurable: true, value: modeLabels()[key] }),
});
export const MODE_DESCRIPTIONS = new Proxy({}, {
	get: (_, key) => modeDescriptions()[key],
	ownKeys: () => Object.keys(MODE_DESCRIPTIONS_BY_LOCALE.en),
	getOwnPropertyDescriptor: (_, key) => ({ enumerable: true, configurable: true, value: modeDescriptions()[key] }),
});

const PURGE_NOTES_BY_LOCALE = {
	en: {
		append: 'This tool has no full system-prompt entry: the persona is appended, so built-in identity remains.',
		partial: 'Replacement is active, though the host still prepends its own identity line.',
		unverified: 'System prompt character count has not been measured for this tool yet; no purge claim is made.',
	},
	'zh-CN': {
		append: '这家没有整段 system prompt 入口：人设是追加进去的，内置身份仍在提示词里。',
		partial: '替换生效，但宿主仍会前置自己的身份句。',
		unverified: '这家还没有系统提示词字数的实测，不声称已净化。',
	},
};

export const purgeNoteOf = (harness, locale = getLocale()) => {
	const table = isZh(locale) ? PURGE_NOTES_BY_LOCALE['zh-CN'] : PURGE_NOTES_BY_LOCALE.en;
	return table[harness?.purgeKind] ?? null;
};

export function modeAvailability(harness, locale = getLocale()) {
	const labels = modeLabels(locale);
	const declared = Array.isArray(harness?.modes) && harness.modes.length ? harness.modes : null;
	const supported = declared ? new Set([...declared, 'off']) : new Set(Object.keys(labels));
	return {
		supported,
		limited: Boolean(declared),
		preferred: harness?.preferredMode ?? null,
		note: harness?.modesNote ?? (declared
			? pick(
				`这家只支持：${declared.map(m => labels[m] || m).join(' / ')}`,
				`Supports only: ${declared.map(m => labels[m] || m).join(' / ')}`,
				locale,
			)
			: null),
		purgeKind: harness?.purgeKind ?? 'replace',
		purgeNote: purgeNoteOf(harness, locale),
	};
}

export const unsupportedHarnesses = (list, mode) => (list || []).filter(h => !modeAvailability(h).supported.has(mode));

const CAPTURE_LABELS_BY_LOCALE = {
	en: {
		captured: 'Captured', passed: 'Passed', partial: 'Partial', blocked: 'Blocked',
		missing: 'Not found', unavailable: 'Not found', error: 'Error', mismatch: 'Mismatch',
		'no-request': 'No request', 'not-tested': 'Not tested',
	},
	'zh-CN': {
		captured: '已捕获请求', passed: '验证通过', partial: '部分通过', blocked: '接入受阻',
		missing: '未发现入口', unavailable: '未发现入口', error: '检测异常', mismatch: '不符合预期',
		'no-request': '未捕获请求', 'not-tested': '未测试',
	},
};
export const captureLabels = (locale = getLocale()) => (isZh(locale) ? CAPTURE_LABELS_BY_LOCALE['zh-CN'] : CAPTURE_LABELS_BY_LOCALE.en);
export const CAPTURE_LABELS = new Proxy({}, {
	get: (_, key) => captureLabels()[key],
	ownKeys: () => Object.keys(CAPTURE_LABELS_BY_LOCALE.en),
	getOwnPropertyDescriptor: (_, key) => ({ enumerable: true, configurable: true, value: captureLabels()[key] }),
});

const CHANNEL_LABELS_BY_LOCALE = {
	en: { install: 'Config', shim: 'CLI Shim', slash: 'Plugin', project: 'Project Rules' },
	'zh-CN': { install: '配置写入', shim: '启动命令', slash: '会话插件', project: '项目规则' },
};
export const channelLabels = (locale = getLocale()) => (isZh(locale) ? CHANNEL_LABELS_BY_LOCALE['zh-CN'] : CHANNEL_LABELS_BY_LOCALE.en);
export const CHANNEL_LABELS = new Proxy({}, {
	get: (_, key) => channelLabels()[key],
	ownKeys: () => Object.keys(CHANNEL_LABELS_BY_LOCALE.en),
	getOwnPropertyDescriptor: (_, key) => ({ enumerable: true, configurable: true, value: channelLabels()[key] }),
});

export const HARNESS_TITLES = {
	'workbuddy-ai': 'WorkBuddy AI',
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

export const harnessTitle = (id, locale = getLocale()) => {
	if (id === 'workbuddy-ai') return isZh(locale) ? 'WorkBuddy 国际版' : 'WorkBuddy AI';
	return HARNESS_TITLES[id] || id;
};

const PURGE_EFFECTS_ZH = {
	workbuddy: {
		channelType: 'config',
		typeLabel: '配置接管',
		safetyLevel: 'safe',
		items: [
			'按模板剥离「You are WorkBuddy」等产品身份行（未抓包测字数）',
			'收起内容政策与强制拒答条款',
			'收起高危目录的递归操作禁令',
			'同步 app-config.json 里的自定义指令',
			'改动前留原字节快照，关闭时逐位还原',
		],
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
			'改动前留原字节快照，关闭时逐位还原',
		],
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
			'/purge on / off 即时切换',
		],
	},
	codebuddy: {
		channelType: 'shim',
		typeLabel: '启动命令',
		safetyLevel: 'shim',
		items: [
			'去掉约 1.7 万字的原厂合规与安全说教',
			'用 --system-prompt-file 重建系统提示词',
			'不落地改文件，关闭时撤除命令别名',
		],
	},
	antigravity: {
		channelType: 'config',
		typeLabel: '配置接管',
		safetyLevel: 'safe',
		items: [
			'托管全局 AGENTS.md，不用手动挂载',
			'人设以 <user_rules> 追加：内置 <identity> 仍在系统提示词里，不是替换',
			'改动前留原字节快照，关闭时自动还原',
		],
	},
	pi: {
		channelType: 'slash',
		typeLabel: '扩展',
		safetyLevel: 'hot',
		items: [
			'每轮对话前改写系统提示词',
			'/purge off 立即撤回，并清掉会话里残留的托管块',
			'不写磁盘，只在当前会话生效',
		],
	},
	'pi-desktop': {
		channelType: 'slash',
		typeLabel: '插件',
		safetyLevel: 'hot',
		items: [
			'以 imported 插件接入，同一会话可换人设',
			'/purge off 恢复宿主原生状态',
		],
	},
	omp: {
		channelType: 'slash',
		typeLabel: '扩展',
		safetyLevel: 'hot',
		items: [
			'每轮对话前改写系统提示词',
			'/purge on / off 会话内切换',
			'关闭后过滤残留的托管块',
		],
	},
	claude: {
		channelType: 'shim',
		typeLabel: '启动命令',
		safetyLevel: 'shim',
		items: [
			'用 --system-prompt-file 替换系统提示词（不打二进制补丁时仍残留 62 字身份句）',
			'保留 ~/.claude/CLAUDE.md 与项目规则',
		],
	},
	hermes: {
		channelType: 'shim',
		typeLabel: '启动命令',
		safetyLevel: 'shim',
		items: [
			'用 --ignore-rules 绕开内置规范',
			'托管 ~/.hermes/SOUL.md，可无损还原',
		],
	},
	opencode: {
		channelType: 'slash',
		typeLabel: '插件',
		safetyLevel: 'hot',
		items: [
			'插件在每轮组装时改写系统提示词',
			'跟随当前人设，下一轮生效',
		],
	},
	opencode2: {
		channelType: 'slash',
		typeLabel: '插件',
		safetyLevel: 'hot',
		items: [
			'插件在每轮组装时改写系统提示词',
			'换人设即时生效，不用重启宿主',
		],
	},
	zcode: {
		channelType: 'config',
		typeLabel: '配置接管',
		safetyLevel: 'safe',
		items: [
			'接管 ~/.zcode/AGENTS.md 全局指令',
			'原字节快照，随时还原',
		],
	},
	codex: {
		channelType: 'config',
		typeLabel: '配置接管',
		safetyLevel: 'safe',
		items: [
			'写进 ~/.codex/config.toml 的 developer_instructions',
			'保持原 TOML 结构与换行，关闭时原样还原',
		],
	},
	grok: {
		channelType: 'config',
		typeLabel: '配置接管',
		safetyLevel: 'safe',
		items: [
			'写进 ~/.grok/AGENTS.md，启动时加载',
			'原字节快照，关闭时逐位还原',
		],
	},
	kilo: {
		channelType: 'config',
		typeLabel: '配置接管',
		safetyLevel: 'safe',
		items: [
			'写进 ~/.config/kilo/agent/code.md，替换 code agent 提示词（宿主 soul() 仍前置 "You are Kilo"）',
			'原文件快照，关闭时自动还原',
		],
	},
};

const PURGE_EFFECTS_EN = {
	workbuddy: {
		channelType: 'config',
		typeLabel: 'Config',
		safetyLevel: 'safe',
		items: [
			'Strips product identity lines such as "You are WorkBuddy" from templates',
			'Collapses content policy and forced refusal clauses',
			'Collapses recursive operation bans on sensitive directories',
			'Syncs custom instructions in app-config.json',
			'Saves a byte-level snapshot before editing; restores cleanly when disabled',
		],
	},
	'workbuddy-ai': {
		channelType: 'config',
		typeLabel: 'Config',
		safetyLevel: 'safe',
		items: [
			'Strips product identity lines such as "You are WorkBuddy" from templates',
			'Collapses content policy and forced refusal clauses',
			'Collapses recursive operation bans on sensitive directories',
			'Syncs custom instructions in app-config.json',
			'Saves a byte-level snapshot before editing; restores cleanly when disabled',
		],
	},
	dsh: {
		channelType: 'slash',
		typeLabel: 'Plugin',
		safetyLevel: 'hot',
		items: [
			'Collapses extra approval and request-interception prompts',
			'Removes memory and context noise',
			'Strips {{model}} template prefix to prevent host variable pollution',
			'In-memory hook only—never unpacks or modifies app.asar',
			'Instant toggle via /purge on / off',
		],
	},
	codebuddy: {
		channelType: 'shim',
		typeLabel: 'CLI Shim',
		safetyLevel: 'shim',
		items: [
			'Removes ~17k chars of built-in compliance and safety boilerplate',
			'Rebuilds system prompt via --system-prompt-file',
			'No on-disk config edits; removes CLI shim when disabled',
		],
	},
	antigravity: {
		channelType: 'config',
		typeLabel: 'Config',
		safetyLevel: 'safe',
		items: [
			'Manages global AGENTS.md automatically',
			'Appends persona as <user_rules>: built-in <identity> remains in the system prompt',
			'Saves a byte-level snapshot before editing; restores automatically when disabled',
		],
	},
	pi: {
		channelType: 'slash',
		typeLabel: 'Extension',
		safetyLevel: 'hot',
		items: [
			'Rewrites the system prompt before each turn',
			'/purge off reverts immediately and strips residual managed blocks in session',
			'No disk writes; active only in the current session',
		],
	},
	'pi-desktop': {
		channelType: 'slash',
		typeLabel: 'Plugin',
		safetyLevel: 'hot',
		items: [
			'Connects as an imported plugin; switch personas within the same session',
			'/purge off restores the host’s native state',
		],
	},
	omp: {
		channelType: 'slash',
		typeLabel: 'Extension',
		safetyLevel: 'hot',
		items: [
			'Rewrites the system prompt before each turn',
			'In-session toggle via /purge on / off',
			'Filters residual managed blocks when turned off',
		],
	},
	claude: {
		channelType: 'shim',
		typeLabel: 'CLI Shim',
		safetyLevel: 'shim',
		items: [
			'Replaces system prompt via --system-prompt-file (a 62-char identity line remains without binary patching)',
			'Preserves ~/.claude/CLAUDE.md and project rules',
		],
	},
	hermes: {
		channelType: 'shim',
		typeLabel: 'CLI Shim',
		safetyLevel: 'shim',
		items: [
			'Bypasses built-in rules with --ignore-rules',
			'Manages ~/.hermes/SOUL.md with lossless restoration',
		],
	},
	opencode: {
		channelType: 'slash',
		typeLabel: 'Plugin',
		safetyLevel: 'hot',
		items: [
			'Rewrites system prompt on each turn assembly',
			'Follows the active persona starting on the next turn',
		],
	},
	opencode2: {
		channelType: 'slash',
		typeLabel: 'Plugin',
		safetyLevel: 'hot',
		items: [
			'Rewrites system prompt on each turn assembly',
			'Persona switches take effect immediately without restarting the host',
		],
	},
	zcode: {
		channelType: 'config',
		typeLabel: 'Config',
		safetyLevel: 'safe',
		items: [
			'Manages global instructions in ~/.zcode/AGENTS.md',
			'Byte-level snapshot for clean restoration anytime',
		],
	},
	codex: {
		channelType: 'config',
		typeLabel: 'Config',
		safetyLevel: 'safe',
		items: [
			'Writes developer_instructions into ~/.codex/config.toml',
			'Preserves TOML structure and line endings; restores cleanly when disabled',
		],
	},
	grok: {
		channelType: 'config',
		typeLabel: 'Config',
		safetyLevel: 'safe',
		items: [
			'Writes ~/.grok/AGENTS.md, loaded at startup',
			'Byte-level snapshot; restores cleanly when disabled',
		],
	},
	kilo: {
		channelType: 'config',
		typeLabel: 'Config',
		safetyLevel: 'safe',
		items: [
			'Writes ~/.config/kilo/agent/code.md to replace code agent prompt (host soul() still prepends "You are Kilo")',
			'Original file snapshot; restores automatically when disabled',
		],
	},
};

export const harnessPurgeEffects = (id, locale = getLocale()) => (isZh(locale) ? PURGE_EFFECTS_ZH : PURGE_EFFECTS_EN)[id] || null;
export const HARNESS_PURGE_EFFECTS = new Proxy({}, {
	get: (_, key) => harnessPurgeEffects(key),
	ownKeys: () => Object.keys(PURGE_EFFECTS_EN),
	getOwnPropertyDescriptor: (_, key) => ({ enumerable: true, configurable: true, value: harnessPurgeEffects(key) }),
});

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const personaName = (persona, locale = getLocale()) => persona?.meta?.name || persona?.id || pick('未选择', 'None selected', locale);
export function configurationOf(state) {
	return { persona: state.active ?? '', mode: state.paused ? state.prevMode || 'replace' : state.defaults?.mode || 'replace' };
}
export const changed = (draft, base) => JSON.stringify(draft) !== JSON.stringify(base);
export const needsApply = (state, draft, base) => state.defaultsSet === false || changed(draft, base);
export function sortedHarnesses(state, showAll = false) {
	const selected = h => (h.armed ?? []).some(c => c !== 'project');
	return [...(state.harnesses ?? [])]
		.filter(h => h.caps?.injectable !== false)
		.filter(h => showAll || selected(h) || h.found || h.homeExists)
		.sort((a, b) => Number(selected(b)) - Number(selected(a)) || Number(b.found) - Number(a.found) || a.id.localeCompare(b.id));
}

export function effectLabel(harness, paused = false, dshRuntime = null, locale = getLocale()) {
	const name = harnessTitle(harness.id ?? pick('这个执行器', 'this target', locale), locale);
	const on = (harness.armed ?? []).some(c => c !== 'project');
	if (on && paused) return pick('总电源已暂停：配置留着，恢复后按原范围应用', 'Global pause active: config kept and will apply on resume', locale);
	if (on && (harness.mode === 'off' || ['harness-off', 'harness-disabled'].includes(harness.activation?.blockedBy))) {
		return pick('这家已关闭：恢复全部也不会自动启用', 'Disabled for this tool: resuming all will not re-enable it', locale);
	}
	if (!on) {
		return harness.found || harness.homeExists
			? ''
			: pick('本机没装，装好后再回来开', 'Not installed locally; install first to enable', locale);
	}
	if (harness.id === 'dsh' && dshRuntime) {
		const states = Object.entries(dshRuntime).filter(([, v]) => v && typeof v === 'object');
		const off = states.filter(([, v]) => v.enabled === false);
		const profiles = harness.profiles || ['desktop', 'web', 'headless', 'sdk'];
		if (profiles.length && profiles.every(p => dshRuntime[p]?.enabled === false)) {
			return pick('dsh 已选形态均被 /purge off 暂停；在对应形态执行 /purge on 恢复', 'All selected dsh profiles are paused by /purge off; run /purge on to resume', locale);
		}
		if (off.length) {
			return pick(
				`dsh 这些形态被 /purge off 暂停：${off.map(([p]) => p).join('、')}；未列出的形态尚未确认`,
				`dsh profiles paused by /purge off: ${off.map(([p]) => p).join(', ')}; unlisted profiles unconfirmed`,
				locale,
			);
		}
	}
	const dynamic = harness.caps?.hot;
	if (dynamic?.ok && harness.armed.includes(dynamic.needs)) {
		if (dynamic.needs === 'slash' && harness.auto !== true) {
			return pick(
				`扩展已安装：重新加载 ${name} 后执行 /purge on 生效；当前会话还没确认`,
				`Extension installed: reload ${name} and run /purge on to activate; current session unconfirmed`,
				locale,
			);
		}
		return pick(
			'插件已加载：下一轮读取；首次安装或更新代码后要重启；当前会话还没确认',
			'Plugin loaded: applies on next turn; restart after first install or update; current session unconfirmed',
			locale,
		);
	}
	if (harness.armed.includes('install')) {
		return pick(
			`配置已写入：新开 ${name} 读取；现有会话还没确认`,
			`Config written: new ${name} sessions will read it; active sessions unconfirmed`,
			locale,
		);
	}
	if (harness.armed.includes('slash')) {
		return pick(
			`在 ${name} 里执行 /purge on 后生效；当前会话还没确认`,
			`Run /purge on inside ${name} to activate; current session unconfirmed`,
			locale,
		);
	}
	return pick(
		`已接管命令行：终端敲 ${name} 时自动注入`,
		`CLI command managed: auto-injects when running ${name} in terminal`,
		locale,
	);
}

export function scopeSummary(state, locale = getLocale()) {
	const ids = Object.entries(state.armed ?? {})
		.filter(([, channels]) => (channels ?? []).some(c => c !== 'project'))
		.map(([id]) => harnessTitle(id, locale));
	if (state.paused) {
		return ids.length
			? pick(`已暂停，这些执行器的配置还留着：${listJoin(ids, locale)}`, `Paused; configurations kept for: ${listJoin(ids, locale)}`, locale)
			: pick('已暂停，暂时没有执行器在用这份人设', 'Paused; no targets are currently using this persona', locale);
	}
	if (!ids.length) {
		return pick('选择要管理的执行器；写入通道后，按详情提示检查生效时机。', 'Select targets to manage; after enabling a channel, check its detail panel for activation timing.', locale);
	}
	return pick(
		`已选择 ${ids.length} 个执行器：${listJoin(ids, locale)}；实际生效看各自状态`,
		`${ids.length} target(s) selected: ${listJoin(ids, locale)}; check individual status for activation`,
		locale,
	);
}
