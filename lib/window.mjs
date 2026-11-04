// 桌面原生独立窗口启动器：优先使用 Edge/Chrome 的 App 模式（无地址栏、无标签页的原生软件窗口体验）
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const BROWSER_PATHS = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/**
 * 寻找本机安装的 Chromium 内核浏览器（Edge / Chrome）
 */
export function findChromiumAppBrowser() {
	if (process.platform !== "win32") return null;
	for (const p of BROWSER_PATHS) {
		if (existsSync(p)) return p;
	}
	return null;
}

/**
 * 以原生应用窗口（独立窗口、无地址栏、无标签页）打开指定 URL
 * @param {string} url
 * @param {{ width?: number, height?: number }} [opts]
 */
export function openAppWindow(url, { width = 1260, height = 860, spawnProcess = spawn,
	onError = error => console.error(`[web] 无法自动打开浏览器：${error.message}；服务仍在运行，请手动访问 ${url}`) } = {}) {
	const launch = (command, args) => {
		try {
			// 窗口启动器是 GUI 进程；windowsHide 会向 libuv/Windows 传入 SW_HIDE，
			// 导致新起进程的 Chromium 窗口以 WS_VISIBLE=0 创建（桌面残留点击穿透白块，见 issue #9）。
			const child = spawnProcess(command, args, { detached: true, stdio: "ignore", windowsHide: false });
			child.once("error", onError);
			child.unref();
			return child;
		} catch (error) { onError(error); return null; }
	};
	const browser = findChromiumAppBrowser();
	if (browser) {
		// --app 模式：启动独立应用窗口，体验与原生桌面客户端完全一致
		const child = launch(
			browser,
			[`--app=${url}`, `--window-size=${width},${height}`],
		);
		return { mode: child ? "app" : "manual", browser, pid: child?.pid };
	}

	// 兜底回退：系统默认浏览器打开
	let child;
	if (process.platform === "win32") {
		child = launch("cmd.exe", ["/d", "/c", "start", "", url]);
	} else if (process.platform === "darwin") {
		child = launch("open", [url]);
	} else {
		child = launch("xdg-open", [url]);
	}
	return { mode: child ? "browser" : "manual", browser: "default", pid: child?.pid };
}
