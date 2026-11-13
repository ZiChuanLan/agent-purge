# 快速开始

## 环境要求

需要 **Node.js 20+**，并先在本机安装你要管理的 coding agent。agent-purge 本身不打包任何模型或凭据。

## 安装

```bash
npm install -g agent-purge
agent-purge web
```

也可以直接运行 `npx agent-purge web`，无需全局安装。

## 三步上手

1. 在**「人设库」**编辑起步模板或新建人设（支持从 GitHub 仓库或本地目录批量拉取）。
2. 回到**「控制台」**选择人设与默认力度、保存设置，打开目标工具开关或点开右侧详情工作区调优通道。
3. 在**「规则文件」**为指定项目目录或全局配置目录追加规则块（默认在原文件末尾 append，随时可无损移除）。

控制台默认监听 `http://127.0.0.1:7788`；若端口被系统保留或占用，会自动顺延至 `7890–7909` 空闲端口并打开独立桌面窗口。**首次启动不会自动接管任何工具。**

## 平台与安装形式

| 形式 | 运行要求 | 适用场景 |
|---|---|---|
| npm | Node.js 20+ | 用 npm 安装与升级 |
| `agent-purge-<版本>-setup.exe` | Windows，外部 Node.js 20+ | 图形安装和卸载 |
| `agent-purge-<版本>.zip` | Windows，外部 Node.js 20+ | 解压后使用 |
| `agent-purge.exe` | Windows x64，自带运行时 | 无需另装 Node 的独立便携版 |
| `agent-purge-<版本>-darwin-arm64.dmg` / `x64.dmg` | macOS 12+（Apple Silicon / Intel，自带运行时） | 未签名 `.app` 磁盘镜像，拖入 `/Applications` 后首次需右键「打开」或 `xattr -cr` 放行 |
| `agent-purge-<版本>-linux-x64` / `-linux-arm64` | 主流 Linux 发行版（自带运行时） | 单文件二进制，`chmod +x` 后直接运行 |
| `agent-purge-<版本>-linux-<架构>.tar.gz` | 主流 Linux 发行版 | 便携包，含 `.desktop`、图标与免 root 的 `install.sh` |
| `agent-purge-<版本>-linux-<架构>.deb` | Debian / Ubuntu 及衍生版 | `sudo apt install ./*.deb`，注册 `/usr/bin/agent-purge` 与桌面入口 |
| `agent-purge-<版本>-linux-<架构>.AppImage` | 主流 Linux 发行版（存在时才有） | 双击或用 `--appimage-extract-and-run` 直接启动控制台 |

下载附件以实际 [GitHub Releases](https://github.com/ZiChuanLan/agent-purge/releases) 为准；未发布的版本没有附件。请核对 SHA-256 和签名状态，未签名程序可能出现系统提示。ZIP 中的 EXE 是薄启动器，不是自带运行时的独立版。

SSH / WSL 等无桌面环境使用 `agent-purge web --no-open`。Web 仅监听本机；Linux 可用 npm / 源码入口或 Release 里的二进制、`.tar.gz`、`.deb`（AppImage 随 runner 能力可选生成），macOS 可用 npm / 源码或 `.dmg` 镜像（`.dmg` 未经 Apple 签名与公证）。平台验证范围见[兼容性说明](/reference/compatibility)。

## 升级

控制台右上角的版本角标点开就是升级入口，按安装形态自动选路：

- 独立 EXE：下载并就地热替换
- npm 全局安装：调 `npm install -g`
- **源码检出**（`git clone` 后直接 `node bin/agent-purge.mjs`）：在安装目录执行 `git pull --ff-only`，不下载任何发布产物

源码检出的「有没有更新」按上游提交算，版本号没变也会提示；工作区有未提交改动、处于游离 HEAD 或分支没有上游时一律拒绝并说明原因。

## 下一步

- [人设与模式](/guide/personas-and-modes) —— 四种处理模式到底改了什么
- [应用范围](/guide/scope) —— 单次启动、常驻、命令接管、项目规则四类通道
- [支持情况](/reference/support) —— 每个宿主的实测净化和残留
