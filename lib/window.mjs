// 桌面原生独立窗口启动器：优先用自带的 WebView2 窗口宿主，没有再退回 Chrome/Edge 的 --app 模式
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Chrome 优先：Edge 的首启体验在 Windows 上一定会把系统里已登录的 Microsoft 账号关联进新 profile
// （--disable-sync、--disable-features=ImplicitSignIn 都拦不住，实测），Chrome 不会碰 Microsoft 账号。
const BROWSER_PATHS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** 控制台窗口独占的浏览器配置目录：见 openAppWindow 的 profileDir 说明。 */
export function windowProfileDir(home) {
	return join(home, "window-profile");
}

/** 记录 window-profile 属于哪个浏览器：换内核后旧 profile 不能复用（Edge 的 profile 里留着系统 Microsoft 账号）。 */
const PROFILE_MARKER = ".agent-purge-browser";

/**
 * 让 window-profile 与当前浏览器配对。
 * 换过内核（Edge → Chrome）或老版本留下的 profile 一律弃掉重开，免得把 Edge 那个带系统账号的 profile
 * 交给 Chrome；rename 兼作存活探针——窗口正在用这个目录时 Windows 会拒绝改名，那就原样不动。
 * @returns {boolean} 是否真的弃掉了旧 profile
 */
export function prepareWindowProfile(profileDir, browser, { rename = renameSync, remove = rmSync, read = readFileSync,
	write = writeFileSync, mkdir = mkdirSync } = {}) {
	if (!profileDir) return false;
	let owner = null;
	try { owner = read(join(profileDir, PROFILE_MARKER), "utf8").trim(); } catch { /* 没标记 = 老版本或用别的内核开的 */ }
	let reset = false;
	if (owner !== browser && existsSync(profileDir)) {
		const stale = `${profileDir}.stale`;
		try {
			remove(stale, { recursive: true, force: true });
			rename(profileDir, stale);
			reset = true;
		} catch {
			return false;
		}
		try { remove(stale, { recursive: true, force: true }); } catch { /* 删不干净就留着，下次启动再清 */ }
	}
	try {
		mkdir(profileDir, { recursive: true });
		write(join(profileDir, PROFILE_MARKER), browser);
	} catch { /* 标记写不上不影响开窗 */ }
	return reset;
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

/** WebView2 Runtime 的安装位置：Win11 自带，Win10 由 Edge 更新推送。 */
const WEBVIEW2_ROOTS = [
	"C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application",
	"C:\\Program Files\\Microsoft\\EdgeWebView\\Application",
];

/**
 * 本机有没有可用的 WebView2 Runtime。
 * 只看目录里有没有 msedgewebview2.exe，不读注册表：一次 readdir 比拉一个 PowerShell 便宜得多。
 */
export function findWebView2Runtime() {
	if (process.platform !== "win32") return null;
	for (const root of WEBVIEW2_ROOTS) {
		let entries;
		try { entries = readdirSync(root); } catch { continue; }
		for (const entry of entries) {
			const exe = join(root, entry, "msedgewebview2.exe");
			if (existsSync(exe)) return exe;
		}
	}
	return null;
}

/** 原生窗口宿主是否就绪：exe、加载器、运行时三样缺一不可。 */
export function nativeWindowAvailable(nativeExe) {
	if (!nativeExe || !existsSync(nativeExe)) return false;
	if (!existsSync(join(dirname(nativeExe), "WebView2Loader.dll"))) return false;
	return Boolean(findWebView2Runtime());
}

/** 窗口宿主的诊断日志：GUI 进程失败时既没有控制台也没有窗口，只有这个文件能留下线索（issue #20）。 */
export function nativeWindowLogPath(stateDir) {
	return join(stateDir, "window-error.log");
}

/**
 * 宿主退出码 → 一眼能看懂的原因。
 * 0xC0000135 是加载器找不到 DLL：宿主自己都跑不起来，代码里再多的错误处理也来不及执行。
 */
export function nativeExitHint(code) {
	if (code === 3221225781 || code === -1073741515) return "缺少运行库（0xC0000135 STATUS_DLL_NOT_FOUND）";
	if (code === 3221225785 || code === -1073741511) return "运行库入口点缺失（0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND）";
	return "";
}

/**
 * 以原生应用窗口（独立窗口、无地址栏、无标签页）打开指定 URL。
 *
 * 优先用自带窗口宿主 agent-purge-window.exe（WebView2）：窗口属于本应用，没有浏览器首启、没有账号、
 * 没有同步，任务栏图标也是自己的。宿主或运行时缺失时退回 Chrome/Edge 的 --app 模式，两者都没有
 * 才交给系统默认浏览器。
 *
 * @param {string} url
 * @param {{ width?: number, height?: number, profileDir?: string, nativeExe?: string,
 *   spawnProcess?: typeof spawn, onError?: (error: Error) => void }} [opts]
 *
 * profileDir：浏览器 --app 模式用的独占配置目录。不给的时候 Chromium 会把请求转给用户正在用的浏览器
 * 进程、自己立刻退出 —— pid 就废了，单例也没法把老窗口叫到前台。原生宿主不靠它保 pid（我们就是宿主），
 * 但同样用它存放 WebView2 数据与窗口尺寸/位置的记忆。
 */
export function openAppWindow(url, { width = 1260, height = 860, profileDir = null, nativeExe = null, confirmClose = "",
	nativeReady = null, nativeStartupTimeout = 2500, spawnProcess = spawn,
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
	// nativeReady 是测试用的注入点：CI 上不一定装了 WebView2 Runtime，靠它稳定走原生分支。
	const useNative = nativeExe ? (nativeReady ?? nativeWindowAvailable(nativeExe)) : false;
	if (useNative) {
		const stateDir = profileDir ?? dirname(nativeExe);
		const child = launch(nativeExe, [
			url,
			"--title", "agent-purge · 提示词控制台",
			"--data", join(stateDir, "webview2"),
			"--state", join(stateDir, "window-state.txt"),
			"--width", String(width),
			"--height", String(height),
			...(confirmClose ? ["--confirm-close", confirmClose] : []),
		]);
		const logFailure = detail => {
			try {
				mkdirSync(stateDir, { recursive: true });
				appendFileSync(nativeWindowLogPath(stateDir), `${new Date().toISOString()} agent-purge-window ${detail}\n`);
			} catch { /* 日志写不上不影响开窗 */ }
		};
		// 复用实例的短命启动进程也要等一下；否则 process.exit 会让错误监听和日志都来不及执行。
		const ready = child ? new Promise(resolveReady => {
			let settled = false;
			const settle = ok => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolveReady(ok);
			};
			const timer = setTimeout(() => settle(true), nativeStartupTimeout);
			child.once("error", error => { logFailure(`spawn failed: ${error.message}`); settle(false); });
			child.once("exit", (code, signal) => {
				if (code === 0 && !signal) { settle(true); return; }
				const hint = nativeExitHint(code);
				const detail = signal ? `signal ${signal}` : `exit ${code} (0x${(code >>> 0).toString(16)})${hint ? ` ${hint}` : ""}`;
				logFailure(detail);
				onError(new Error(`窗口宿主异常退出（${detail}）；服务仍在运行，请手动访问 ${url}`));
				settle(false);
			});
		}) : Promise.resolve(false);
		return { mode: child ? "app" : "manual", engine: "webview2", browser: "webview2", pid: child?.pid, ready };
	}
	const browser = findChromiumAppBrowser();
	if (browser) {
		// 换过内核或老版本留下的 profile 先弃掉：Edge 的 profile 里留着系统 Microsoft 账号，不能交给 Chrome。
		prepareWindowProfile(profileDir, browser);
		// --app 模式：启动独立应用窗口，体验与原生桌面客户端完全一致
		// 独占配置目录时先压掉首启提示，否则新profile会弹「导入书签/设为默认」打扰用户。
		// --disable-sync：只关同步，拦不住 Edge 把系统账号写进新 profile（实测开关与 --disable-features
		// 都拦不住），所以本机默认走 Chrome；没有 Chrome 时才回退 Edge。
		const profileArgs = profileDir
			? [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", "--disable-sync"]
			: [];
		const child = launch(
			browser,
			[...profileArgs, `--app=${url}`, `--window-size=${width},${height}`],
		);
		return { mode: child ? "app" : "manual", engine: "chromium", browser, pid: child?.pid };
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

/** 原生宿主启动即失败时只补开浏览器，不重启服务；返回最终窗口 PID 给单例登记。 */
export async function openAppWindowWithFallback(url, options = {}) {
	const opened = openAppWindow(url, options);
	if (opened.engine !== "webview2" || await opened.ready) return opened;
	return openAppWindow(url, {
		...options, nativeReady: false,
		// 浏览器回退用独立子目录，避免清掉原生 WebView2 的数据与窗口记忆。
		profileDir: options.profileDir ? join(options.profileDir, "browser-fallback") : null,
	});
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
$windows = New-Object System.Collections.ArrayList
$collect = [AgentPurge.Native+EnumWindowsProc]{ param($handle, $state)
  if (-not [AgentPurge.Native]::IsWindowVisible($handle)) { return $true }
  $class = New-Object System.Text.StringBuilder 256
  [void][AgentPurge.Native]::GetClassName($handle, $class, 256)
  # AgentPurgeWindow 是自带的 WebView2 窗口宿主；Chrome_WidgetWin_1 是浏览器 --app 模式
  if ($class.ToString() -ne 'Chrome_WidgetWin_1' -and $class.ToString() -ne 'AgentPurgeWindow') { return $true }
  $text = New-Object System.Text.StringBuilder 512
  [void][AgentPurge.Native]::GetWindowText($handle, $text, 512)
  [uint32]$owner = 0
  [void][AgentPurge.Native]::GetWindowThreadProcessId($handle, [ref]$owner)
  [void]$windows.Add([pscustomobject]@{ hwnd = [Int64]$handle; title = $text.ToString(); pid = $owner })
  return $true
}
[void][AgentPurge.Native]::EnumWindows($collect, [IntPtr]::Zero)
$pick = $null
foreach ($window in $windows) { if ($wanted -contains $window.pid) { $pick = $window; break } }
if (-not $pick -and $profile) {
  try {
    $wanted += @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" -OperationTimeoutSec 3 -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) -and $_.CommandLine -notlike '*--type=*' } |
      ForEach-Object { $_.ProcessId })
    foreach ($window in $windows) { if ($wanted -contains $window.pid) { $pick = $window; break } }
  } catch {}
}
if (-not $pick) { foreach ($window in $windows) { if ($window.title -like 'agent-purge · 提示词控制台*') { $pick = $window; break } } }
if (-not $pick) { 'AGENT_PURGE_WINDOW_NOT_FOUND'; exit 0 }
$handle = [IntPtr]$pick.hwnd
[void][AgentPurge.Native]::ShowWindow($handle, 9)
if ([AgentPurge.Native]::GetForegroundWindow() -ne $handle) {
  [uint32]$owner = 0
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
			const pwsh = join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
			const powershell = existsSync(pwsh) ? pwsh : join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
				"System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			const env = { ...process.env };
			for (const key of Object.keys(env)) if (["PSMODULEPATH", "PSHOME"].includes(key.toUpperCase())) delete env[key];
			const output = run(
				powershell,
				["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOW_SCRIPT(pid, profileDir)],
				{ encoding: "utf8", windowsHide: true, timeout: 20000, env },
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
