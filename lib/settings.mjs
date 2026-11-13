// 桌面端偏好：窗口行为 + WebDAV 备份账号。
//
// 都存在 state.json 的 settings 段里，跟人设/接管配置同生共死；区别只有一个：
// webdav.password 是明文，只在本机文件里，永远不出现在 API 返回值里。
import { updateState } from "./state.mjs";
import { normalizeLanguageSetting } from "./i18n.mjs";

export const DEFAULT_WEBDAV_DIR = "agent-purge";
const text = value => (typeof value === "string" ? value.trim() : "");

/**
 * 前端能直接用的设置形状。
 * 密码只报「有没有」，回显等于把凭据送给任何一个能打开本机页面的人。
 */
export function settingsOf(state) {
	const raw = state?.settings ?? {};
	const desktop = raw.desktop ?? {};
	const webdav = raw.webdav ?? {};
	return {
		language: normalizeLanguageSetting(raw.language),
		desktop: {
			// 默认：关窗即退出、退出前先确认（桌面端双击启动的默认体验）
			exitOnClose: desktop.exitOnClose !== false,
			confirmOnClose: desktop.confirmOnClose !== false,
		},
		webdav: {
			url: text(webdav.url),
			username: text(webdav.username),
			dir: text(webdav.dir) || DEFAULT_WEBDAV_DIR,
			hasPassword: Boolean(text(webdav.password)),
			lastBackupAt: text(webdav.lastBackupAt) || null,
			lastRestoreAt: text(webdav.lastRestoreAt) || null,
		},
	};
}

/** 只有服务端自己用：带密码的完整设置，用来发 WebDAV 请求。 */
export function settingsWithSecret(state) {
	const view = settingsOf(state);
	return { ...view, webdav: { ...view.webdav, password: text(state?.settings?.webdav?.password) } };
}

/** 桌面端关窗后是否退出服务；读不懂配置就当默认值，别把人挡在门外。 */
export function desktopExitOnClose(state) {
	try { return settingsOf(state).desktop.exitOnClose; } catch { return true; }
}

/**
 * 保存设置。只覆盖 payload 里点名的键：用户手写进 state.json 的其他字段原样保留。
 * @param {string} root 数据目录
 * @param {{ desktop?: { exitOnClose?: boolean, confirmOnClose?: boolean },
 *           webdav?: { url?: string, username?: string, password?: string, dir?: string } }} payload
 */
export function saveSettings(root, payload = {}) {
	const desktopPatch = payload.desktop ?? {};
	const webdavPatch = payload.webdav ?? {};
	if (typeof desktopPatch !== "object" || typeof webdavPatch !== "object") throw new Error("设置载荷格式不对");
	const url = webdavPatch.url === undefined ? undefined : text(webdavPatch.url);
	if (url !== undefined && url && !/^https?:\/\//i.test(url)) throw new Error("WebDAV 地址要以 http:// 或 https:// 开头");
	const dir = webdavPatch.dir === undefined ? undefined : text(webdavPatch.dir).replace(/^\/+|\/+$/g, "");
	if (dir !== undefined && dir.split("/").some(segment => segment === "..")) throw new Error("远端目录不能包含 ..");
	return updateState(root, state => {
		const current = state.settings ?? {};
		const language = payload.language !== undefined ? normalizeLanguageSetting(payload.language) : normalizeLanguageSetting(current.language);
		const desktop = { ...(current.desktop ?? {}) };
		for (const key of ["exitOnClose", "confirmOnClose"]) {
			if (desktopPatch[key] !== undefined) desktop[key] = desktopPatch[key] === true;
		}
		const webdav = { ...(current.webdav ?? {}) };
		for (const [key, value] of [["url", url], ["username", webdavPatch.username], ["dir", dir]]) {
			if (value !== undefined) webdav[key] = text(value);
		}
		if (webdavPatch.password !== undefined) {
			const password = text(webdavPatch.password);
			if (password) webdav.password = password;
			else delete webdav.password; // 空串 = 清除已保存的密码
		}
		return { ...state, settings: { ...current, language, desktop, webdav } };
	});
}

/** 备份/恢复成功后回写时间戳，让设置页能显示「上次备份」。 */
export function noteWebdavRun(root, patch) {
	return updateState(root, state => {
		const current = state.settings ?? {};
		return { ...state, settings: { ...current, webdav: { ...(current.webdav ?? {}), ...patch } } };
	});
}
