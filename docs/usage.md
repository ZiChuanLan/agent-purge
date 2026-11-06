# 使用指南

[返回项目首页](../README.md)

## 选择人设

运行 `agent-purge web` 打开本地控制台，在「人设库」编辑中性模板或新建人设，再回「控制台」应用。

```bash
agent-purge ls
agent-purge use <id>
agent-purge mode append
agent-purge sync
```

CLI 和 Web 共用状态。切换人设、模式或编辑当前正文时，会同步已选择的通道；失败项可在「验证与诊断」查看和重试。

默认执行器只决定裸敲 `agent-purge` 时启动谁，**不决定应用范围**。要让其他入口也读取人设，需要选择对应通道。

### 人设文件

默认目录为 `~/.agent-purge/personas/`，每份人设是 `<id>.md`：

```markdown
---
id: concise
name: 简洁协作
description: 中文、先结论、修改前先读代码
harness: ["*"]
model: ["*"]
order: 10
---

用简体中文协作。先给结论，再给依据。
修改代码前先阅读现有实现；不确定时明确说明。
```

只有正文进入提示词。`description` 用于列表说明，旧键 `desc` 仍兼容；Web 编辑会保留表单未涉及的元数据。`active` 是内部保留标识，请勿用作人设名。

### 为一家执行器单独配置

```bash
agent-purge use concise --for codex
agent-purge mode append --for codex
agent-purge use follow --for codex
agent-purge mode follow --for codex
```

`follow` 取消该字段的例外配置。全局暂停优先于分家模式，恢复时仍保留原选择。

## 处理模式

| 模式 | 行为 | 注意 |
|---|---|---|
| `replace` | 在可读取的宿主文本中近似移除身份行，再放入人设 | 没有宿主文本读取口的启动入口按 `strict` 处理 |
| `strict` | 替换可控入口里的宿主文本 | 该入口原有说明也会移除；宿主仍可能另加文本 |
| `append` | 保留宿主说明并追加人设 | 可能出现相互矛盾的身份说明 |
| `off` | 停止当前入口注入 | 全局暂停与单次启动参数的范围不同 |

`codex / claude / grok / codebuddy / hermes` 的 CLI 启动入口没有宿主文本读取口，`replace` 按 `strict` 执行，并在终端提示。希望保留宿主说明时可选择 `append`。

CLI 的 `append` 将人设放在后面；[magpie 插件](../magpie-plugin/README.md)放在前面。实际角色可能是 `system`、`developer` 或项目上下文，详见[兼容性](compatibility.md)。

## 单次启动

```bash
agent-purge codex
agent-purge pi --persona concise
agent-purge codex --mode append
agent-purge pi --ask "解释这段代码"
agent-purge codex --dry-run
agent-purge codex -- --help
```

`--` 后的参数交给宿主，不再由 agent-purge 解析。`--dry-run` 展示启动命令，不启动宿主。

`--mode off` 只影响本次启动，不撤销已经安装到磁盘的其他通道；若与常驻或项目内容冲突，先执行 `agent-purge pause`，不要把单次 off 当成全量卸载。

## 常驻与项目通道

| 通道 | 做什么 | 何时读取 |
|---|---|---|
| `install` | 写入宿主的托管配置或插件 | 静态配置需新会话；动态插件加载后下一轮 |
| `shim` | 在 PATH 前面放同名命令，转发给 agent-purge | 下一次从该命令启动 |
| `slash` | 安装会话内 `/purge` 扩展 | pi / omp / dsh 加载扩展后使用 |
| `project` | 在指定项目规则文件中写入托管块 | 对应目录的新会话 |

```bash
agent-purge install codex
agent-purge arm pi --slash
agent-purge arm codex --shim
agent-purge arm pi
agent-purge status
```

`arm <h>` 尝试开启该执行器的常驻、命令和 slash 通道，结果逐项报告；不是每个执行器都支持全部通道。首次安装或更新插件代码后需重新加载宿主。Linux/macOS 的 shim 目录需要按命令提示加入 shell 的 PATH。

DSH 只写入它已初始化的 profile，不凭空创建 desktop/web/headless 配置。其 slash 插件只是开关，注入还需要常驻插件；实际处理的 profile 会在命令结果中列出。插件包放在 agent-purge 数据目录（`~/.agent-purge/dsh/<插件名>/`），patch 用绝对 `file:` URL 引用它，不依赖 profile 的 `node_modules`，因此 dsh 重装依赖或清理 profile 都不会让插件失效。

### 项目规则

```bash
agent-purge project on pi --dir /path/to/project
agent-purge project status --dir /path/to/project
agent-purge project off --dir /path/to/project
```

目录以绝对路径登记。后续同步只处理已登记的目录，不跟着当前工作目录漂移；暂停保留登记，恢复后按原范围应用。

项目通道不提供每个文件夹独立的人设；仍跟随全局或分家配置。其他执行器可能也读取同名 `AGENTS.md` / `CLAUDE.md`，同时开启项目与全局入口可能重复提供人设。

## 暂停、撤销和卸载

| 目的 | 命令 | 人设数据 |
|---|---|---|
| 临时暂停 / 恢复原范围 | `agent-purge pause` / `agent-purge resume` | 保留 |
| 只撤销常驻通道 | `agent-purge uninstall dsh` | 保留；slash 和 shim 不受影响 |
| 撤销一家已选的全部通道 | `agent-purge disarm dsh` | 保留 |
| 撤销全部登记的接管 | `agent-purge clean` | 保留 |
| 卸载 npm 程序 | 先 `agent-purge clean`，再 `npm uninstall -g agent-purge` | 保留 |
| 永久删除用户数据 | `agent-purge self-uninstall --yes` | **删除，先备份** |

`self-uninstall --dry-run` 只预览。不传 `--yes` 不会永久删除。

Windows 安装器卸载会先撤销接管，再移除程序；恢复冲突时停止卸载并保留凭据。ZIP / 独立 EXE 也应先 `clean` 再删除程序。外部编辑会保留，旧版或被修改的 DSH 插件可能改名为 `.disabled-by-agent-purge*`；核对后再自行处理。

`arm --all` / `disarm --all` 会同时操作总电源和执行器通道。只需临时停用时用 `pause`，不要全量卸载。历史会话中已经发送的内容不会被撤回。

## 数据与隐私

用户数据与程序分开保存，默认位置：

- Windows：`C:\Users\<用户>\.agent-purge\`
- Linux/macOS：`~/.agent-purge/`

其中包括人设、`state.json` 和恢复凭据。升级不会用发行包覆盖这份目录。需要改位置时：

```bash
export AGENT_PURGE_HOME=/path/to/ap-data
```

```powershell
$env:AGENT_PURGE_HOME = 'D:\ap-data'
```

PowerShell 赋值仅影响当前会话；`setx` 影响之后新开的进程。旧版包目录中的数据会在首次运行时尝试迁移，原件保留。

配置和提示词改写在本地执行，更新检查会访问 GitHub。启用后，人设会随宿主请求发送给其配置的模型服务；agent-purge 不提供网络隔离。Web 仅监听 `127.0.0.1`，不要直接暴露到公网。

## 常见问题

- **保存后没效果**：执行 `agent-purge status`，检查人设、模式和通道；新建会话或重新加载插件。配置写入成功不是当前会话的请求证据。
- **暂停后仍有旧内容**：已有历史不会清除；检查是否仍在旧会话，或另有独立提示词插件。
- **恢复冲突**：保留报错指出的原文件和恢复材料，比较修改后再合并，不要直接删除备份。
- **Windows 提示缺 Node**：薄包和安装器需要 PATH 中的 Node 20+；独立 `agent-purge.exe` 自带运行时。
- **SSH / WSL 无桌面**：使用 `agent-purge web --no-open`，按终端地址访问；默认端口为 `7788`。
- **更新显示无公开 Release**：不代表 npm 已是最新版。npm 安装用 `npm outdated -g agent-purge` 检查版本。
- **换模型或中转后人设表现不同**：先区分“请求是否包含人设”和“模型是否遵循人设”。Web 的隔离验证不测试你的真实中转；需要核对中转前后的 system/developer 字段。不要把 API Key 或完整私密人设贴进公开 issue，见[验证范围](compatibility.md#验证状态与第三方中转)。
