#define UNICODE
#include <windows.h>
#include <wchar.h>

/* 不经 cmd.exe：原始参数只由目标 Node 解析一次；保留退出码供安装/卸载检查。 */
int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR ignored, int show) {
    (void)instance; (void)previous; (void)ignored; (void)show;
    wchar_t directory[32768], node[32768], command[32768];
    DWORD length = GetModuleFileNameW(NULL, directory, 32768);
    if (!length || length >= 32768) return 1;
    wchar_t *slash = wcsrchr(directory, L'\\');
    if (!slash) return 1;
    *slash = L'\0';
    DWORD found = SearchPathW(NULL, L"node.exe", NULL, 32768, node, NULL);
    if (!found || found >= 32768) {
        MessageBoxW(NULL, L"请安装 Node.js 20 或更高版本后重试。", L"agent-purge", MB_ICONERROR);
        return 1;
    }
    const wchar_t *args = GetCommandLineW();
    if (*args == L'"') { args++; while (*args && *args != L'"') args++; if (*args) args++; }
    else while (*args && *args > L' ') args++;
    while (*args && *args <= L' ') args++;
    int written = _snwprintf(command, 32768, L"\"%s\" \"%s\\bin\\agent-purge.mjs\" %s", node, directory, *args ? args : L"web --auto-exit");
    if (written < 0 || written >= 32768) return 1;
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    ZeroMemory(&startup, sizeof(startup)); ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
    if (!CreateProcessW(node, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, directory, &startup, &process)) {
        MessageBoxW(NULL, L"启动失败。请检查安装目录和 Node.js。", L"agent-purge", MB_ICONERROR);
        return 1;
    }
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1; GetExitCodeProcess(process.hProcess, &code); CloseHandle(process.hProcess);
    return (int)code;
}
