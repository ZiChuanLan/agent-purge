// Bilingual (en / zh-CN) dictionary and helpers for the Web console.
// Defaults to English ("en") unless the server-detected or user-selected locale is Chinese.

const normalize = (value) => {
	if (typeof value !== 'string') return 'en';
	const v = value.trim().toLowerCase();
	return v === 'zh' || v.startsWith('zh-') ? 'zh-CN' : 'en';
};

let currentLocale = (() => {
	if (typeof document !== 'undefined') {
		const meta = document.querySelector('meta[name="ap-locale"]')?.getAttribute('content');
		if (meta && meta !== 'auto') return normalize(meta);
		const lang = document.documentElement?.getAttribute('lang');
		if (lang) return normalize(lang);
	}
	return 'en';
})();

export function getLocale() {
	return currentLocale;
}

export function isZh(locale = currentLocale) {
	return normalize(locale) === 'zh-CN';
}

export function setLocale(locale) {
	currentLocale = normalize(locale);
	if (typeof document !== 'undefined' && document.documentElement) {
		document.documentElement.lang = currentLocale;
	}
	return currentLocale;
}

export const fmtNumber = (n, locale = currentLocale) => Number(n || 0).toLocaleString(isZh(locale) ? 'zh-CN' : 'en-US');

export const fmtTime = (date, locale = currentLocale) =>
	new Date(date).toLocaleTimeString(isZh(locale) ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });

export const fmtDateTime = (date, options = undefined, locale = currentLocale) =>
	new Date(date).toLocaleString(isZh(locale) ? 'zh-CN' : 'en-US', options);

export const listJoin = (items, locale = currentLocale) => items.join(isZh(locale) ? '、' : ', ');

export function pick(zh, en, locale = currentLocale) {
	return isZh(locale) ? zh : en;
}

export const MESSAGES = {
	en: {
		'page.title': 'agent-purge · Prompt Console',
		'skip.main': 'Skip to main content',
		'brand.aria': 'agent-purge console',
		'nav.aria': 'Primary navigation',
		'nav.console': 'Console',
		'nav.library': 'Personas',
		'nav.project': 'Rule Files',
		'nav.diagnostics': 'Tests & Logs',
		'nav.settings': 'Settings',
		'conn.connecting': 'Connecting to local service',
		'conn.connected': 'Connected · {time}',
		'conn.stopped': 'Service stopped',
		'conn.disconnected': 'Local service disconnected',
		'conn.disconnectedNotice': '{error} Use the refresh button in the top right to retry.',
		'version.loading': 'Loading…',
		'version.checkTitle': 'Check for updates',
		'refresh.title': 'Refresh status',
		'exit.title': 'Stop local agent-purge service and close window',
		'exit.aria': 'Exit application',
		'exit.confirmUnsaved': 'There are unsaved settings or drafts. Stop and close anyway?',
		'exit.stopping': 'Stopping local service and closing window…',

		'console.currentPersona': 'Current Persona',
		'console.reading': 'Loading…',
		'console.readingDesc': 'Loading persona description…',
		'console.switchPersona': 'Switch Persona',
		'console.editBody': 'Edit',
		'console.newPersona': 'New',
		'console.pullGithub': 'Pull from GitHub',
		'console.managedRatio': 'managed',
		'console.powerReading': 'Loading',
		'console.powerConnecting': 'Connecting…',
		'console.disarmAll': 'Disarm All',
		'console.disarmAllTitle': 'Revoke all enabled prompt configurations and restore original files; persona files are kept',
		'console.defaultMode': 'Default Mode',
		'mode.replace': 'Replace Identity',
		'mode.strict': 'Persona Only',
		'mode.append': 'Append',
		'mode.off': 'Paused',
		'mode.hintDefault': 'Replaces the assistant identity while keeping host tools and rules.',
		'console.applyChanges': 'Apply Changes',
		'console.saveSettings': 'Save Settings',
		'console.applying': 'Applying…',
		'console.discardChanges': 'Discard',
		'console.scopeTitle': 'Managed Targets',
		'console.targetsCount': '{count} targets',
		'console.targetsVisibleCount': '{visible} / {total} targets',
		'console.detecting': 'Detecting installed AI clients…',
		'console.searchPlaceholder': 'Search tools, commands, or status',
		'console.searchAria': 'Search managed targets',
		'console.filterAria': 'Filter managed targets',
		'console.filterAll': 'All',
		'console.filterOn': 'Managed',
		'console.filterReady': 'Ready',
		'console.showAll': 'Show uninstalled',
		'console.batchAria': 'Batch actions',
		'console.batchTitle': 'Batch-configure managed targets or modes',
		'console.batchPlaceholder': 'Batch actions…',
		'console.batchEnableReady': 'Enable all ready tools',
		'console.batchDisableAll': 'Disable all targets',
		'console.batchModePreferred': 'Restore recommended modes',
		'console.batchModeReplace': 'Set all to "Replace Identity"',
		'console.batchModeStrict': 'Set all to "Persona Only"',
		'console.targetListAria': 'Managed targets list',
		'console.drawerAria': 'Target configuration details',
		'console.launchPrefs': 'CLI Launch Preference',
		'console.unset': 'Not set',
		'console.launchHint': 'Client launched when running agent-purge directly in a terminal; does not affect the targets above.',
		'console.preferredClient': 'Preferred client',
		'console.save': 'Save',

		'library.title': 'Personas',
		'library.subtitle': 'The body is written into prompts; name and description are for management only.',
		'library.pullExternal': 'Pull External',
		'library.newPersona': 'New Persona',
		'library.listAria': 'Persona list',
		'library.searchAria': 'Search personas',
		'library.searchPlaceholder': 'Search name or description',
		'library.editorAria': 'Persona editor',
		'library.editorEmpty': 'Select a persona on the left to view or edit its content.',
		'library.editTitle': 'Edit Persona',
		'library.editCurrentTitle': 'Edit Current Persona',
		'library.newTitle': 'New Persona',
		'library.unmodified': 'Unmodified',
		'library.unsaved': 'Unsaved',
		'library.saved': 'Saved',
		'library.fieldId': 'ID',
		'library.idHint': 'Letters, numbers, hyphens, underscores; cannot be changed after creation.',
		'library.fieldName': 'Display Name',
		'library.fieldDesc': 'Description',
		'library.fieldBody': 'Persona Content',
		'library.advancedMeta': 'Advanced Metadata',
		'library.fieldModel': 'Suggested Models (comma-separated, leave blank for any)',
		'library.delete': 'Delete',
		'library.saveAndSync': 'Save & Sync',
		'library.saveAndApply': 'Save & Apply',

		'project.title': 'Rule Files',
		'project.subtitle': 'Append a managed persona block to project or global tool rule files; preserves original content and can be removed anytime.',
		'project.scopeLabel': 'Scope',
		'project.scopeProject': 'Current Project',
		'project.scopeGlobal': 'Global Directory',
		'project.personaLabel': 'Persona to Write',
		'project.dirLabel': 'Project Directory',
		'project.dirPlaceholder': 'e.g. /home/user/my-project',
		'project.load': 'Load',
		'project.cwd': 'Current Dir',
		'project.recentAria': 'Recent projects',
		'project.noteAria': 'Rule file behavior',
		'project.globalPersona': 'Global Persona',
		'project.sysTakeover': 'System Prompt Injection',
		'project.sysTakeoverDesc': 'Managed in Console, takes effect via each tool’s system entry',
		'project.ruleFiles': 'Rule Files',
		'project.scopeProjectHeading': 'Rule files in current directory',
		'project.scopeGlobalHeading': 'Global rule files per tool',
		'project.scopeDesc': 'Appends a managed block at the end of existing rule files without altering original rules; removable anytime.',
		'project.loading': 'Loading rule files…',
		'project.footnote': 'Rule files only affect the target project or global config directory; blocks are appended at the end without modifying existing rules. "Disarm All" does not touch project rules—click "Remove" here to revert cleanly.',

		'diag.title': 'Tests & Logs',
		'diag.subtitle': 'Inspect configuration writes and actual request verification separately. Test runs never touch your active sessions.',
		'diag.resyncAll': 'Re-sync Active Targets',
		'diag.lastApply': 'Last Apply',
		'diag.retryFailed': 'Retry Failed',
		'diag.noApplyYet': 'No apply records yet.',
		'diag.captureTitle': 'Dry-Run Verification',
		'diag.captureSubtitle': 'Runs each tool in an isolated temporary directory with a test persona to verify whether requests carry the persona.',
		'diag.noCaptureYet': 'No verification report loaded yet.',
		'diag.runtimeState': 'Runtime State & Paths',
		'diag.runtimeHint': 'Targets without runtime confirmation are not marked as active in the current session. Reload the host after installing or updating plugins.',

		'settings.title': 'Settings',
		'settings.subtitle': 'Interface language, desktop window behavior, and WebDAV backup. Everything is stored locally.',
		'settings.languageTitle': 'Language',
		'settings.languageDesc': 'Auto follows LC_ALL / LC_MESSAGES / LANG and falls back to English outside Chinese locales.',
		'settings.languageLabel': 'Interface Language',
		'settings.languageAuto': 'Auto (System Locale)',
		'settings.languageEn': 'English',
		'settings.languageZh': '简体中文 (Chinese)',
		'settings.saveLanguage': 'Save Language',
		'settings.languageSaved': 'Language preference updated.',
		'settings.desktopTitle': 'Desktop Window',
		'settings.desktopSubtitle': 'Applies only when launched via desktop icon / executable; terminal runs of agent-purge web are managed by the terminal.',
		'settings.closeActionLabel': 'When closing window',
		'settings.closeExit': 'Exit local service',
		'settings.closeStay': 'Keep service in background (reconnect on next launch)',
		'settings.closeHint': 'Takes effect immediately for the next window close.',
		'settings.confirmClose': 'Confirm before closing window',
		'settings.saveDesktop': 'Save Window Settings',
		'settings.webdavTitle': 'WebDAV Backup',
		'settings.webdavSubtitle': 'Backs up personas and settings (the WebDAV password in state.json is never included). Restore overwrites matching local files after saving a snapshot in backups/.',
		'settings.webdavUrl': 'URL',
		'settings.webdavDir': 'Remote Directory',
		'settings.webdavUsername': 'Username',
		'settings.webdavPassword': 'Password',
		'settings.webdavPasswordKeep': 'Saved; leave blank to keep',
		'settings.webdavPasswordUnset': 'Not set',
		'settings.webdavPasswordPlaceholder': 'Leave blank to keep unchanged',
		'settings.webdavSaveTest': 'Save & Test Connection',
		'settings.webdavBackup': 'Back Up Now',
		'settings.webdavRestore': 'Restore from Backup',

		'footer.note': 'Configuration writes and session activation are separate: refer to executor callbacks and request evidence.',

		'import.title': 'Pull Personas from External Source',
		'import.closeAria': 'Close',
		'import.subtitle': 'Supports public GitHub repositories (owner/repo) or a local directory; imports .md prompt files and skips docs automatically.',
		'import.recommended': 'Recommended',
		'import.sourceLabel': 'Source',
		'import.sourcePlaceholder': 'owner/repo or /path/to/prompts',
		'import.overwrite': 'Overwrite existing IDs',
		'import.cancel': 'Cancel',
		'import.start': 'Start Pull',
		'import.pulling': 'Pulling…',

		'update.title': 'Update Available',
		'update.desc': 'A newer version is available and can be upgraded in place.',
		'update.currentTag': 'Current v{version}',
		'update.latestTag': 'Latest v{version}',
		'update.changelog': 'Release Notes',
		'update.commandLabel': 'Terminal Upgrade Command',
		'update.copy': 'Copy',
		'update.later': 'Later',
		'update.releasePage': 'Release Page',
		'update.upgradeNow': 'Upgrade Now',

		'confirm.title': 'Confirm Enabling Target',
		'confirm.desc': 'Enabling will rewrite the target tool’s system prompt and may strip built-in identity and restrictions.',
		'confirm.targetTool': 'Target Tool',
		'confirm.badgeConfig': 'Config',
		'confirm.backupTitle': 'Full backup before writing',
		'confirm.backupDesc': 'A SHA256 snapshot of every modified file is saved before writing and restored byte-for-byte when disabled. Your personas and custom edits remain safe.',
		'confirm.legalTitle': 'Notice',
		'confirm.legalDesc': 'For local lawful persona customization and model instruction research only. Enabling strips or rewrites host built-in system prompts; please comply with each software’s terms of use and take responsibility for generated output.',
		'confirm.cancel': 'Cancel',
		'confirm.submit': 'Confirm & Enable',
	},
	'zh-CN': {
		'page.title': 'agent-purge · 提示词控制台',
		'skip.main': '跳到主要内容',
		'brand.aria': 'agent-purge 控制台',
		'nav.aria': '主要导航',
		'nav.console': '控制台',
		'nav.library': '人设库',
		'nav.project': '规则文件',
		'nav.diagnostics': '测试与记录',
		'nav.settings': '设置',
		'conn.connecting': '正在连接本地服务',
		'conn.connected': '已连接 · {time}',
		'conn.stopped': '服务已停止',
		'conn.disconnected': '本地服务未连接',
		'conn.disconnectedNotice': '{error} 用右上角刷新按钮重试。',
		'version.loading': '版本加载中',
		'version.checkTitle': '检查更新',
		'refresh.title': '刷新状态',
		'exit.title': '退出 agent-purge 本地服务并关闭窗口',
		'exit.aria': '退出程序',
		'exit.confirmUnsaved': '还有未保存的设置或草稿，确定退出并关闭吗？',
		'exit.stopping': '正在退出本地服务并关闭窗口…',

		'console.currentPersona': '当前人设',
		'console.reading': '正在读取…',
		'console.readingDesc': '正在读取人设说明…',
		'console.switchPersona': '更换人设',
		'console.editBody': '编辑正文',
		'console.newPersona': '新建',
		'console.pullGithub': '从 GitHub 拉取',
		'console.managedRatio': '已接管',
		'console.powerReading': '正在读取',
		'console.powerConnecting': '服务连接中…',
		'console.disarmAll': '全部撤销',
		'console.disarmAllTitle': '撤销所有已启用的提示词配置，恢复原厂设置；不删除人设文件',
		'console.defaultMode': '默认力度',
		'mode.replace': '替换身份',
		'mode.strict': '只留人设',
		'mode.append': '末尾追加',
		'mode.off': '暂停',
		'mode.hintDefault': '只改助手对自己的认知，保留原厂工具与规范。',
		'console.applyChanges': '应用变更',
		'console.saveSettings': '保存设置',
		'console.applying': '正在应用…',
		'console.discardChanges': '撤销改动',
		'console.scopeTitle': '接管范围',
		'console.targetsCount': '{count} 个目标',
		'console.targetsVisibleCount': '{visible} / {total} 个目标',
		'console.detecting': '正在检测本机已安装的 AI 客户端…',
		'console.searchPlaceholder': '搜索工具、命令或状态',
		'console.searchAria': '搜索接管目标',
		'console.filterAria': '筛选接管目标',
		'console.filterAll': '全部',
		'console.filterOn': '已接管',
		'console.filterReady': '可接管',
		'console.showAll': '显示未安装',
		'console.batchAria': '批量操作',
		'console.batchTitle': '批量设置接管范围或模式',
		'console.batchPlaceholder': '批量操作…',
		'console.batchEnableReady': '开启所有已就绪工具',
		'console.batchDisableAll': '关闭全部接管',
		'console.batchModePreferred': '恢复各家推荐力度',
		'console.batchModeReplace': '全部改为「替换身份」',
		'console.batchModeStrict': '全部改为「只留人设」',
		'console.targetListAria': '接管目标列表',
		'console.drawerAria': '工具接管详情',
		'console.launchPrefs': '命令行启动首选项',
		'console.unset': '未设置',
		'console.launchHint': '在终端直接执行 agent-purge 时代为唤起的客户端；不影响上面各工具的接管范围。',
		'console.preferredClient': '首选客户端',
		'console.save': '保存',

		'library.title': '人设库',
		'library.subtitle': '正文会写进提示词；名称与说明只用于管理。',
		'library.pullExternal': '从外部拉取',
		'library.newPersona': '新建人设',
		'library.listAria': '人设列表',
		'library.searchAria': '搜索人设',
		'library.searchPlaceholder': '搜索名称或说明',
		'library.editorAria': '人设编辑器',
		'library.editorEmpty': '从左侧选一份人设，查看或编辑正文。',
		'library.editTitle': '编辑人设',
		'library.editCurrentTitle': '编辑当前人设',
		'library.newTitle': '新建人设',
		'library.unmodified': '未修改',
		'library.unsaved': '未保存',
		'library.saved': '已保存',
		'library.fieldId': '标识',
		'library.idHint': '字母、数字、短横线、下划线；创建后不可改。',
		'library.fieldName': '显示名称',
		'library.fieldDesc': '说明',
		'library.fieldBody': '人设正文',
		'library.advancedMeta': '高级元数据',
		'library.fieldModel': '建议模型（逗号分隔，留空不限制）',
		'library.delete': '删除',
		'library.saveAndSync': '保存并同步',
		'library.saveAndApply': '保存并应用',

		'project.title': '规则文件',
		'project.subtitle': '把人设托管块追加到项目目录或工具全局规则文件；默认保留原文件并在末尾追加（append），随时可移除。',
		'project.scopeLabel': '作用范围',
		'project.scopeProject': '当前项目',
		'project.scopeGlobal': '全局目录',
		'project.personaLabel': '写入人设',
		'project.dirLabel': '项目目录',
		'project.dirPlaceholder': '例如 D:\\work\\my-project',
		'project.load': '读取',
		'project.cwd': '当前目录',
		'project.recentAria': '最近项目',
		'project.noteAria': '规则文件生效说明',
		'project.globalPersona': '全局人设',
		'project.sysTakeover': '系统提示词接管',
		'project.sysTakeoverDesc': '在「控制台」管理，按各家系统入口生效',
		'project.ruleFiles': '规则文件',
		'project.scopeProjectHeading': '当前目录的规则文件',
		'project.scopeGlobalHeading': '各工具全局规则文件',
		'project.scopeDesc': '人设以托管块追加在原文件末尾（append），保留原有规则，随时可移除',
		'project.loading': '正在读取规则文件…',
		'project.footnote': '规则文件只影响对应的项目目录或全局配置文件；以托管块追加在文件末尾，不影响原有规则内容。「全部撤销」不会动项目规则，本页点「移除」即可无损撤回。',

		'diag.title': '测试与记录',
		'diag.subtitle': '配置写没写进去、工具认没认到，分开看。这里的试跑不碰你正在用的会话。',
		'diag.resyncAll': '重新同步现有范围',
		'diag.lastApply': '上一次应用',
		'diag.retryFailed': '重试失败项',
		'diag.noApplyYet': '尚无应用记录',
		'diag.captureTitle': '安全试跑',
		'diag.captureSubtitle': '在临时目录里用测试人设跑一遍，看请求里有没有真的带上人设。',
		'diag.noCaptureYet': '尚未加载试跑报告。',
		'diag.runtimeState': '运行状态与路径',
		'diag.runtimeHint': '运行时没被确认的项目不会标成「当前会话已生效」。首次安装或更新插件后，需要重新加载宿主。',

		'settings.title': '设置',
		'settings.subtitle': '界面语言、桌面窗口行为与 WebDAV 备份。都只存在本机，不上传任何东西。',
		'settings.languageTitle': '界面语言',
		'settings.languageDesc': '默认跟随系统环境变量（LC_ALL / LC_MESSAGES / LANG），非中文环境自动回退英文。',
		'settings.languageLabel': '显示语言',
		'settings.languageAuto': '自动（跟随系统）',
		'settings.languageEn': 'English',
		'settings.languageZh': '简体中文',
		'settings.saveLanguage': '保存语言设置',
		'settings.languageSaved': '界面语言已更新。',
		'settings.desktopTitle': '桌面窗口',
		'settings.desktopSubtitle': '只对双击 exe / 桌面图标打开的窗口生效；终端里跑 agent-purge web 时由终端托管。',
		'settings.closeActionLabel': '关闭窗口时',
		'settings.closeExit': '退出本地服务',
		'settings.closeStay': '服务留在后台（下次双击直接连上）',
		'settings.closeHint': '改完立即生效，下一次关窗就按新方式处理。',
		'settings.confirmClose': '关闭窗口前先确认',
		'settings.saveDesktop': '保存窗口设置',
		'settings.webdavTitle': 'WebDAV 备份',
		'settings.webdavSubtitle': '备份人设库与设置（state.json 里的 WebDAV 密码不会写进备份）。恢复会覆盖本机同名文件，并先在数据目录 backups/ 留一份快照。',
		'settings.webdavUrl': '地址',
		'settings.webdavDir': '远端目录',
		'settings.webdavUsername': '用户名',
		'settings.webdavPassword': '密码',
		'settings.webdavPasswordKeep': '已保存，留空不修改',
		'settings.webdavPasswordUnset': '未设置',
		'settings.webdavPasswordPlaceholder': '留空 = 不修改',
		'settings.webdavSaveTest': '保存并测试连接',
		'settings.webdavBackup': '立即备份',
		'settings.webdavRestore': '从备份恢复',

		'footer.note': '配置写入与会话生效是两件事：以执行器回调和请求证据为准。',

		'import.title': '从外部拉取人设',
		'import.closeAria': '关闭',
		'import.subtitle': '支持公开 GitHub 仓库（owner/repo）或本机目录；只导入 .md 提示词，自动跳过说明文档。',
		'import.recommended': '推荐',
		'import.sourceLabel': '导入源',
		'import.sourcePlaceholder': 'owner/repo 或 D:\\prompts',
		'import.overwrite': '覆盖同名标识',
		'import.cancel': '取消',
		'import.start': '开始拉取',
		'import.pulling': '正在拉取…',

		'update.title': '发现新版本',
		'update.desc': '检查到最新版本，可以就地升级。',
		'update.currentTag': '当前 v{version}',
		'update.latestTag': '最新 v{version}',
		'update.changelog': '更新说明',
		'update.commandLabel': '终端升级命令',
		'update.copy': '复制',
		'update.later': '稍后',
		'update.releasePage': 'Release 页面',
		'update.upgradeNow': '一键升级',

		'confirm.title': '确认开启接管',
		'confirm.desc': '开启后会改写目标工具的系统提示词，可能清除原厂身份与限制。',
		'confirm.targetTool': '目标工具',
		'confirm.badgeConfig': '配置托管',
		'confirm.backupTitle': '写入前先做完整备份',
		'confirm.backupDesc': '每个被改动的文件都会按原字节建立 SHA256 快照；关闭接管时逐位还原。人设与你自己的修改不受影响。',
		'confirm.legalTitle': '使用须知',
		'confirm.legalDesc': '仅供本地合法的人设定制与模型指令研究。开启后会剥离或改写宿主内置的系统提示词；请遵守各软件的使用条款，并对生成内容与操作后果自行负责。',
		'confirm.cancel': '取消',
		'confirm.submit': '确认开启',
	},
};

export function t(key, vars = undefined, locale = currentLocale) {
	const table = MESSAGES[normalize(locale)] || MESSAGES.en;
	let template = table[key] ?? MESSAGES.en[key] ?? key;
	if (vars) {
		for (const [k, v] of Object.entries(vars)) {
			template = template.replaceAll(`{${k}}`, String(v ?? ''));
		}
	}
	return template;
}

export function applyDomI18n(root = typeof document !== 'undefined' ? document : null, locale = currentLocale) {
	if (!root) return;
	if (root.documentElement) root.documentElement.lang = normalize(locale);
	if (root.title !== undefined) document.title = t('page.title', undefined, locale);
	for (const el of root.querySelectorAll('[data-i18n]')) {
		el.textContent = t(el.dataset.i18n, undefined, locale);
	}
	for (const el of root.querySelectorAll('[data-i18n-attr]')) {
		for (const pair of el.dataset.i18nAttr.split(',')) {
			const [attr, key] = pair.split(':').map(s => s.trim());
			if (attr && key) el.setAttribute(attr, t(key, undefined, locale));
		}
	}
}
