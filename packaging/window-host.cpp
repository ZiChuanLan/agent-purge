// agent-purge 控制台的原生窗口宿主：用 WebView2 给控制台一扇真正属于本应用的窗口。
//
// 为什么不继续用 Chrome/Edge 的 --app 模式：那扇窗口是浏览器本体，浏览器首启会把系统里已登录的
// Microsoft 账号关联进新 profile（实测 --disable-sync、--disable-features=ImplicitSignIn 都拦不住），
// 用户看到的就是「一个本地工具在要 Microsoft 账号授权」。WebView2 没有首启、没有账号、没有同步，
// 窗口图标与任务栏名称都是本应用的。
//
// 用法：agent-purge-window.exe <url> [--title T] [--width N] [--height N] [--data DIR] [--state FILE]
//   --data   WebView2 用户数据目录（窗口尺寸以外的浏览器状态都放这里）
//   --state  窗口位置/大小的记忆文件；没有就按 --width/--height 居中开
#define UNICODE
#include <windows.h>
#include <shellapi.h>
#include <string>
#include <wrl/client.h>
#include "WebView2.h"

using Microsoft::WRL::ComPtr;

namespace {

HWND g_hwnd = nullptr;
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_webview;
std::wstring g_url = L"about:blank";
std::wstring g_title = L"agent-purge";
std::wstring g_dataFolder;
std::wstring g_stateFile;
int g_width = 1260;
int g_height = 860;

const wchar_t kClass[] = L"AgentPurgeWindow";

// 高 DPI：动态取 Win10 的 SetProcessDpiAwarenessContext，mingw 的 user32 声明因 SDK 版本而异。
// -4 就是 DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2（头文件里不一定有这个名字）。
void EnableDpiAwareness() {
	typedef BOOL (WINAPI* SetContextFn)(HANDLE);
	HMODULE user32 = GetModuleHandleW(L"user32.dll");
	SetContextFn setContext = user32 ? (SetContextFn)GetProcAddress(user32, "SetProcessDpiAwarenessContext") : nullptr;
	if (setContext && setContext((HANDLE)(LONG_PTR)-4)) return;
	SetProcessDPIAware();
}

// mingw 的 gcc 不认 MIDL 的 __declspec(uuid)，__uuidof 会变成未定义符号，所以 IID 写在这里；
// scripts/build-window-host.mjs 会拿 WebView2.h 里的 MIDL_INTERFACE 字符串核对，SDK 升级漏改会构建失败。
const IID kEnvDoneIid = { 0x4e8a3389, 0xc9d8, 0x4bd2, { 0xb6, 0xb5, 0x12, 0x4f, 0xee, 0x6c, 0xc1, 0x4d } };
const IID kControllerDoneIid = { 0x6c4819f3, 0xc9b7, 0x4260, { 0x81, 0x27, 0xc9, 0xf5, 0xbd, 0xe7, 0xf6, 0x8c } };
const IID kController2Iid = { 0xc979903e, 0xd4ca, 0x4228, { 0x92, 0xeb, 0x47, 0xee, 0x3f, 0xa9, 0x6e, 0xab } };
const IID kScriptDoneIid = { 0x49511172, 0xcc67, 0x4bca, { 0x99, 0x23, 0x13, 0x71, 0x12, 0xf4, 0xc4, 0xcc } };

// 关窗前的两道判断：
//   1. 有没有未保存的草稿 —— 只有页面知道，问一次（WebView2 不会自己跑 beforeunload）；
//   2. 要不要确认 —— 文案由 Node 按设置页的「关闭窗口前先确认 / 关闭窗口时」给（--confirm-close），
//      宿主只负责弹一个原生对话框，不依赖 WebView2 的脚本对话框。
const wchar_t kDirtyScript[] = L"(window.__apDirty ? window.__apDirty() : false)";
const wchar_t kDirtyText[] = L"还有未保存的设置或草稿，确定关闭吗？\r\nUnsaved settings or drafts. Close anyway?";
std::wstring g_confirmText;
bool g_closing = false;

/** 只实现一个接口的 COM 回调；WebView2 只会 QueryInterface 到 IUnknown 和它自己。 */
template <class T> class Once : public T {
	LONG refs = 1;
	const IID& iid;
public:
	explicit Once(const IID& id) : iid(id) {}
	HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
		if (!ppv) return E_POINTER;
		if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, iid)) {
			*ppv = static_cast<T*>(this);
			AddRef();
			return S_OK;
		}
		*ppv = nullptr;
		return E_NOINTERFACE;
	}
	ULONG STDMETHODCALLTYPE AddRef() override { return (ULONG)InterlockedIncrement(&refs); }
	ULONG STDMETHODCALLTYPE Release() override {
		LONG left = InterlockedDecrement(&refs);
		if (!left) delete this;
		return (ULONG)left;
	}
};

std::wstring ExeDir() {
	wchar_t path[32768];
	DWORD length = GetModuleFileNameW(nullptr, path, 32768);
	if (!length || length >= 32768) return L".";
	wchar_t* slash = wcsrchr(path, L'\\');
	if (slash) *slash = L'\0';
	return path;
}

void EnsureDir(const std::wstring& dir) {
	std::wstring current;
	for (size_t i = 0; i < dir.size(); i += 1) {
		current.push_back(dir[i]);
		bool boundary = dir[i] == L'\\' || dir[i] == L'/';
		if (!boundary || current.size() <= 3) continue;
		CreateDirectoryW(current.c_str(), nullptr);
	}
	CreateDirectoryW(dir.c_str(), nullptr);
}

/** 系统是深色主题时给窗口一个深色底，避免首屏白闪（页面自己会注入 data-theme）。 */
bool SystemUsesDarkTheme() {
	DWORD value = 1, size = sizeof(value);
	HKEY key = nullptr;
	if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", 0, KEY_READ, &key) != ERROR_SUCCESS) return false;
	LONG status = RegQueryValueExW(key, L"AppsUseLightTheme", nullptr, nullptr, (LPBYTE)&value, &size);
	RegCloseKey(key);
	return status == ERROR_SUCCESS && value == 0;
}

void SaveWindowState() {
	if (g_stateFile.empty() || !g_hwnd) return;
	WINDOWPLACEMENT placement = { sizeof(placement) };
	GetWindowPlacement(g_hwnd, &placement);
	RECT& rc = placement.rcNormalPosition;
	WCHAR line[128];
	wsprintfW(line, L"%ld %ld %ld %ld %d\n", rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top,
		placement.showCmd == SW_SHOWMAXIMIZED ? 1 : 0);
	HANDLE file = CreateFileW(g_stateFile.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (file == INVALID_HANDLE_VALUE) return;
	DWORD written = 0;
	WriteFile(file, line, (DWORD)(wcslen(line) * sizeof(WCHAR)), &written, nullptr);
	CloseHandle(file);
}

/** 上次的窗口位置；读不到就居中按默认尺寸开。 */
bool LoadWindowState(RECT& rc, bool& maximized) {
	maximized = false;
	if (g_stateFile.empty()) return false;
	HANDLE file = CreateFileW(g_stateFile.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (file == INVALID_HANDLE_VALUE) return false;
	WCHAR buffer[128] = { 0 };
	DWORD read = 0;
	ReadFile(file, buffer, sizeof(buffer) - sizeof(WCHAR), &read, nullptr);
	CloseHandle(file);
	long x = 0, y = 0, w = 0, h = 0;
	int flag = 0;
	if (swscanf_s(buffer, L"%ld %ld %ld %ld %d", &x, &y, &w, &h, &flag) != 5) return false;
	if (w < 400 || h < 300) return false;
	// 显示器换了/拔了：记忆的位置可能在屏幕外，那就当没有记忆，重新居中
	RECT saved = { x, y, x + w, y + h };
	if (MonitorFromRect(&saved, MONITOR_DEFAULTTONULL) == nullptr) return false;
	rc = { x, y, x + w, y + h };
	maximized = flag == 1;
	return true;
}

struct ControllerDone : Once<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
	ControllerDone() : Once(kControllerDoneIid) {}
	HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Controller* controller) override {
		if (FAILED(result) || !controller) {
			MessageBoxW(g_hwnd, L"WebView2 控制器创建失败。请更新 Microsoft Edge WebView2 Runtime 后重试。", L"agent-purge", MB_ICONERROR);
			return result;
		}
		g_controller = controller;
		controller->get_CoreWebView2(&g_webview);
		ComPtr<ICoreWebView2Controller2> modern;
		if (SUCCEEDED(controller->QueryInterface(kController2Iid, (void**)modern.GetAddressOf()))) {
			COREWEBVIEW2_COLOR color = SystemUsesDarkTheme()
				? COREWEBVIEW2_COLOR{ 0xFF, 0x14, 0x0F, 0x0B }   // #0B0F14
				: COREWEBVIEW2_COLOR{ 0xFF, 0xFA, 0xF8, 0xF7 };  // #F7F8FA
			modern->put_DefaultBackgroundColor(color);
		}
		RECT client;
		GetClientRect(g_hwnd, &client);
		controller->put_Bounds(client);
		g_webview->Navigate(g_url.c_str());
		return S_OK;
	}
};

struct EnvDone : Once<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler> {
	EnvDone() : Once(kEnvDoneIid) {}
	HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment* env) override {
		if (FAILED(result) || !env) {
			MessageBoxW(g_hwnd, L"WebView2 环境创建失败。请安装或修复 Microsoft Edge WebView2 Runtime 后重试。", L"agent-purge", MB_ICONERROR);
			return result;
		}
		env->CreateCoreWebView2Controller(g_hwnd, new ControllerDone());
		return S_OK;
	}
};

void CloseNow() {
	SaveWindowState();
	DestroyWindow(g_hwnd);
}

/** 有未保存草稿就问草稿的事，否则按 --confirm-close 决定要不要弹确认；取消就把关窗请求放回去。 */
void AskThenClose(bool dirty) {
	const std::wstring text = dirty ? std::wstring(kDirtyText) : g_confirmText;
	if (text.empty() || MessageBoxW(g_hwnd, text.c_str(), L"agent-purge", MB_OKCANCEL | MB_ICONQUESTION) == IDOK) {
		CloseNow();
		return;
	}
	g_closing = false;
}

struct DirtyScriptDone : Once<ICoreWebView2ExecuteScriptCompletedHandler> {
	DirtyScriptDone() : Once(kScriptDoneIid) {}
	HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, LPCWSTR json) override {
		AskThenClose(SUCCEEDED(result) && json && std::wstring(json) == L"true");
		return S_OK;
	}
};

LRESULT CALLBACK Proc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
	switch (message) {
	case WM_SIZE:
		if (g_controller) {
			RECT client;
			GetClientRect(hwnd, &client);
			g_controller->put_Bounds(client);
		}
		return 0;
	case WM_CLOSE:
		// 第二次点关闭不再等页面：页面卡死时也得能把窗口关掉
		if (g_closing) { CloseNow(); return 0; }
		g_closing = true;
		if (g_webview && SUCCEEDED(g_webview->ExecuteScript(kDirtyScript, new DirtyScriptDone()))) return 0;
		g_closing = false;
		AskThenClose(false);
		return 0;
	case WM_DESTROY:
		if (g_controller) g_controller->Close();
		g_webview.Reset();
		g_controller.Reset();
		PostQuitMessage(0);
		return 0;
	}
	return DefWindowProcW(hwnd, message, wp, lp);
}

/** WebView2Loader.dll 从 exe 同目录加载：不链接导入库，SDK 只作为构建期头文件依赖。 */
HRESULT CreateEnvironment() {
	typedef HRESULT (STDMETHODCALLTYPE *CreateEnvFn)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions*,
		ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);
	std::wstring loaderPath = ExeDir() + L"\\WebView2Loader.dll";
	HMODULE loader = LoadLibraryW(loaderPath.c_str());
	if (!loader) {
		MessageBoxW(nullptr, L"缺少 WebView2Loader.dll：请重新安装 agent-purge，或改用浏览器窗口。", L"agent-purge", MB_ICONERROR);
		return HRESULT_FROM_WIN32(ERROR_MOD_NOT_FOUND);
	}
	CreateEnvFn createEnv = (CreateEnvFn)GetProcAddress(loader, "CreateCoreWebView2EnvironmentWithOptions");
	if (!createEnv) {
		MessageBoxW(nullptr, L"WebView2Loader.dll 版本不对：缺少 CreateCoreWebView2EnvironmentWithOptions。", L"agent-purge", MB_ICONERROR);
		return E_FAIL;
	}
	EnsureDir(g_dataFolder);
	return createEnv(nullptr, g_dataFolder.c_str(), nullptr, new EnvDone());
}

void ParseArgs(int argc, LPWSTR* argv) {
	for (int i = 1; i < argc; i += 1) {
		std::wstring arg = argv[i];
		auto next = [&](std::wstring& target) { if (i + 1 < argc) target = argv[++i]; };
		if (arg == L"--title") next(g_title);
		else if (arg == L"--data") next(g_dataFolder);
		else if (arg == L"--state") next(g_stateFile);
		else if (arg == L"--confirm-close") next(g_confirmText);
		else if (arg == L"--width") { std::wstring v; next(v); g_width = _wtoi(v.c_str()); }
		else if (arg == L"--height") { std::wstring v; next(v); g_height = _wtoi(v.c_str()); }
		else if (!arg.empty() && arg[0] != L'-') g_url = arg;
	}
	if (g_width < 400) g_width = 400;
	if (g_height < 300) g_height = 300;
}

} // namespace

int WINAPI WinMain(HINSTANCE instance, HINSTANCE, LPSTR, int show) {
	EnableDpiAwareness();
	int argc = 0;
	LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
	if (argv) { ParseArgs(argc, argv); LocalFree(argv); }
	if (g_dataFolder.empty()) g_dataFolder = ExeDir() + L"\\webview2-data";

	WNDCLASSEXW wc = { sizeof(wc) };
	wc.lpfnWndProc = Proc;
	wc.hInstance = instance;
	wc.lpszClassName = kClass;
	wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
	wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
	wc.hIconSm = wc.hIcon;
	wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
	if (!RegisterClassExW(&wc)) return 1;

	RECT rect = { 0, 0, g_width, g_height };
	bool maximized = false;
	if (!LoadWindowState(rect, maximized)) {
		RECT work{};
		SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
		int width = rect.right - rect.left, height = rect.bottom - rect.top;
		int x = work.left + ((work.right - work.left) - width) / 2;
		int y = work.top + ((work.bottom - work.top) - height) / 2;
		rect = { x, y, x + width, y + height };
	}
	g_hwnd = CreateWindowExW(0, kClass, g_title.c_str(), WS_OVERLAPPEDWINDOW,
		rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, nullptr, nullptr, instance, nullptr);
	if (!g_hwnd) return 1;
	// 不跟随 WinMain 的 nCmdShow：启动器用 SW_HIDE 拉起 Node，隐藏状态会一路继承下来（issue #9 同类问题）。
	ShowWindow(g_hwnd, maximized ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
	SetForegroundWindow(g_hwnd);
	UpdateWindow(g_hwnd);

	if (FAILED(CreateEnvironment())) return 1;

	MSG message;
	while (GetMessageW(&message, nullptr, 0, 0) > 0) {
		TranslateMessage(&message);
		DispatchMessageW(&message);
	}
	return 0;
}