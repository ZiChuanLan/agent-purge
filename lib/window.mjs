// 桌面原生独立窗口启动器：优先使用 Edge/Chrome 的 App 模式（无地址栏、无标签页的原生软件窗口体验）
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BROWSER_PATHS = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** 控制台窗口独占的浏览器配置目录：见 openAppWindow 的 profileDir 说明。 */
export function windowProfileDir(home) {
	return join(home, "window-profile");
}

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
 * @param {{ width?: number, height?: number, profileDir?: string }} [opts]
 *
 * profileDir：给控制台窗口一个独占的浏览器配置目录。不给的时候，Chromium 会把 --app
 * 请求转给用户正在用的浏览器进程、自己立刻退出 —— 返回的 pid 就废了，单例也没法把老窗口
 * 叫到前台。独占配置目录后，我们启动的进程就是窗口的宿主，pid 一直有效；顺带让窗口尺寸
 * 和页面偏好在下次启动时恢复。
 */
export function openAppWindow(url, { width = 1260, height = 860, profileDir = null, spawnProcess = spawn,
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
		// 独占配置目录时先压掉首启提示，否则新profile会弹「导入书签/设为默认」打扰用户。
		const profileArgs = profileDir
			? [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble"]
			: [];
		const child = launch(
			browser,
			[...profileArgs, `--app=${url}`, `--window-size=${width},${height}`],
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

// 把已经开着的控制台窗口叫到前台。Windows 上靠窗口枚举：
// 先挑属于「我们的浏览器进程」的顶层窗口，再退到按标题匹配 —— 浏览器进程可能重启，
// 只认 pid 会漏；而只要机器上有这扇窗口，就绝不能再开一扇新的（issue #14）。
// 抢前台的常规限制是「只有前台进程能设前台窗口」；从资源管理器双击启动时我们本来就有这个
// 权限，但命令行场景不一定。AttachThreadInput 先把输入线程接到当前前台线程上，绕开限制。
const WINDOW_SCRIPT = (pid, profileDir) => {
	const quote = value => `'${String(value).replaceAll("'", "''")}'`;
	return `$sig = @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
[DllImport("user32.dll")] public static extern bool FlashWindow(IntPtr hWnd, bool invert);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
'@
Add-Type -Namespace AgentPurge -Name Native -MemberDefinition $sig
$wanted = @(${Number.isInteger(pid) && pid > 0 ? pid : 0})
$profile = ${quote(profileDir ?? "")}
if ($profile) {
  try {
    $wanted += @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) -and $_.CommandLine -notlike '*--type=*' } |
      ForEach-Object { $_.ProcessId })
  } catch {}
}
$windows = New-Object System.Collections.ArrayList
$collect = [AgentPurge.Native+EnumWindowsProc]{ param($handle, $state)
  if (-not [AgentPurge.Native]::IsWindowVisible($handle)) { return $true }
  $class = New-Object System.Text.StringBuilder 256
  [void][AgentPurge.Native]::GetClassName($handle, $class, 256)
  if ($class.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
  $text = New-Object System.Text.StringBuilder 512
  [void][AgentPurge.Native]::GetWindowText($handle, $text, 512)
  $owner = 0
  [void][AgentPurge.Native]::GetWindowThreadProcessId($handle, [ref]$owner)
  [void]$windows.Add([pscustomobject]@{ hwnd = [Int64]$handle; title = $text.ToString(); pid = $owner })
  return $true
}
[void][AgentPurge.Native]::EnumWindows($collect, [IntPtr]::Zero)
$pick = $null
foreach ($window in $windows) { if ($wanted -contains $window.pid) { $pick = $window; break } }
if (-not $pick) { foreach ($window in $windows) { if ($window.title -like 'agent-purge · 提示词控制台*') { $pick = $window; break } } }
if (-not $pick) { 'AGENT_PURGE_WINDOW_NOT_FOUND'; exit 0 }
$handle = [IntPtr]$pick.hwnd
[void][AgentPurge.Native]::ShowWindow($handle, 9)
if ([AgentPurge.Native]::GetForegroundWindow() -ne $handle) {
  $owner = 0
  $foreground = [AgentPurge.Native]::GetWindowThreadProcessId([AgentPurge.Native]::GetForegroundWindow(), [ref]$owner)
  $mine = [AgentPurge.Native]::GetCurrentThreadId()
  [void][AgentPurge.Native]::AttachThreadInput($mine, $foreground, $true)
  [void][AgentPurge.Native]::BringWindowToTop($handle)
  [void][AgentPurge.Native]::SetForegroundWindow($handle)
  [void][AgentPurge.Native]::AttachThreadInput($mine, $foreground, $false)
}
if ([AgentPurge.Native]::GetForegroundWindow() -ne $handle) {
  # 还没抢到：最小化再还原一次，等于替用户按了「恢复这个窗口」
  [void][AgentPurge.Native]::ShowWindow($handle, 6)
  Start-Sleep -Milliseconds 120
  [void][AgentPurge.Native]::ShowWindow($handle, 9)
  [void][AgentPurge.Native]::SetForegroundWindow($handle)
}
if ([AgentPurge.Native]::GetForegroundWindow() -ne $handle) {
  # 最后手段：SwitchToThisWindow 走外壳的切换通道，比 SetForegroundWindow 宽松
  [AgentPurge.Native]::SwitchToThisWindow($handle, $true)
  Start-Sleep -Milliseconds 150
}
if ([AgentPurge.Native]::GetForegroundWindow() -ne $handle) {
  # 系统仍然不让抢前台（例如前台是终端）：让任务栏闪一下，至少让用户知道窗口在哪
  for ($i = 0; $i -lt 3; $i++) {
    [void][AgentPurge.Native]::FlashWindow($handle, $true)
    Start-Sleep -Milliseconds 180
    [void][AgentPurge.Native]::FlashWindow($handle, $false)
    Start-Sleep -Milliseconds 120
  }
}
if ([AgentPurge.Native]::GetForegroundWindow() -eq $handle) { 'AGENT_PURGE_WINDOW_FOCUSED' } else { 'AGENT_PURGE_WINDOW_UNFOCUSED' }
`;
};

/**
 * 找控制台窗口并尝试切到前台。
 * found=false 说明窗口真的没了（用户关了窗口、浏览器崩了），调用方可以补开一扇；
 * found=true 而 focused=false 说明窗口还在、只是系统不让我们抢焦点，绝不能补开第二扇。
 * @param {{ pid?: number, profileDir?: string }} target
 * @param {{ platform?: string, run?: typeof execFileSync }} [opts]
 */
export function focusConsoleWindow({ pid = 0, profileDir = null } = {}, { platform = process.platform, run = execFileSync } = {}) {
	try {
		if (platform === "win32") {
			const output = run(
				"powershell",
				["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOW_SCRIPT(pid, profileDir)],
				{ encoding: "utf8", windowsHide: true, timeout: 20000 },
			);
			const lines = String(output).trim().split(/\r?\n/);
			const verdict = lines[lines.length - 1]?.trim();
			if (verdict === "AGENT_PURGE_WINDOW_FOCUSED") return { found: true, focused: true };
			if (verdict === "AGENT_PURGE_WINDOW_UNFOCUSED") return { found: true, focused: false };
			return { found: false, focused: false };
		}
		if (platform === "darwin" && Number.isInteger(pid) && pid > 0) {
			run("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`], { encoding: "utf8", timeout: 15000 });
			return { found: true, focused: true };
		}
	} catch {
		return { found: false, focused: false };
	}
	return { found: false, focused: false };
}
