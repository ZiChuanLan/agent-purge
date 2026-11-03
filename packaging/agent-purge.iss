; Inno Setup 6：只打包 scripts/build-setup.mjs 核验过的 Node 瘦包。
;
; 为什么不是单文件 exe：内置运行时（Bun/Node SEA）产物都是 90 MB 起，装一个 700 KB 的
; 配置工具不值。这里装的是 JS 树 + agent-purge.cmd 垫片，要求本机有 Node.js 20+（安装时检查）。
;
; 卸载先 clean（按账本还原），再删安装目录；保留用户人设与设置。
; 版本号由 dist\version.iss 给出（与 package.json 同源，parse 脚本 scripts/build-setup.mjs）
#include "..\dist\version.iss"
#define AppName "agent-purge"

[Setup]
AppId={{8E4C1D07-2B39-4C6E-9F3A-5D1B7C0A6E42}
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher=agent-purge
DefaultDirName={localappdata}\Programs\agent-purge
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
OutputDir=..\dist
OutputBaseFilename=agent-purge-{#AppVer}-setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\web\assets\agent-purge.ico
UninstallDisplayName={#AppName}
DisableProgramGroupPage=yes

[Files]
Source: "..\dist\agent-purge\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "其他选项："; Flags: unchecked

[Icons]
Name: "{group}\{#AppName} 客户端"; Filename: "{app}\agent-purge.exe"; Parameters: "web --auto-exit"; WorkingDir: "{app}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\agent-purge.exe"; Parameters: "web --auto-exit"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\agent-purge.exe"; Parameters: "web --auto-exit"; Description: "启动 {#AppName} 桌面客户端"; Flags: postinstall nowait skipifsilent

[Code]
const NodeUrl = 'https://nodejs.org/';

function HasNode(): Boolean;
var
  Code: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'), '/d /c node -e "process.exit(Number(process.versions.node.split(''.'')[0]) >= 20 ? 0 : 1)"', '', SW_HIDE,
    ewWaitUntilTerminated, Code) and (Code = 0);
end;

function InitializeSetup(): Boolean;
var
  Code: Integer;
begin
  Result := True;
  if HasNode() then
    Exit;
  if SuppressibleMsgBox('这个安装器包含 Node 瘦包，需要 Node.js 20 或更高版本。免 Node 请使用独立便携 exe。' + Chr(10) +
      '现在打开下载页吗？', mbConfirmation, MB_YESNO, IDNO) = IDYES then
    ShellExec('open', NodeUrl, '', '', SW_SHOWNORMAL, ewNoWait, Code);
  Result := False;
end;

function InitializeUninstall(): Boolean;
var
  Code: Integer;
begin
  Result := Exec(ExpandConstant('{app}\agent-purge.exe'), 'clean',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
  if not Result then
    SuppressibleMsgBox('撤销尚未全部成功。程序和恢复凭据已保留，请运行 agent-purge clean 查看并处理剩余项，再卸载。', mbError, MB_OK, IDOK);
end;
