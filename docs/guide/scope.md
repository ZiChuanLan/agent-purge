# 应用范围

宿主给的接管入口不止一种，作用范围和生效时机都不同。先决定你想覆盖到哪一层，再选通道。

## 四种通道

| 通道 | 做什么 | 生效时机 |
|---|---|---|
| `install` | 写入宿主的托管配置或插件 | 静态配置需新会话；已加载动态插件下一轮读取 |
| `shim` | 通过 PATH 中的同名命令转发启动 | 下一次从该命令启动 |
| `slash` | 安装会话内 `/purge` 扩展 | 取决于宿主扩展和启用状态 |
| `project` | 写入指定目录的项目规则文件 | 对应目录的新会话 |

```bash
agent-purge install codex
agent-purge arm pi --slash
agent-purge project on pi --dir /path/to/project
agent-purge status
```

`arm <h>` 会尝试开启该执行器可用的常驻、命令和 slash 通道，结果逐项报告；项目通道需单独选择。同一人设经多个入口提供时可能重复，建议只开启需要的范围。

## 临时使用

只想临时用一次，可以通过 agent-purge 启动一次，不必登记常驻通道：

```bash
agent-purge codex --mode append
agent-purge pi --ask "解释这段代码"
agent-purge codex -- --help          # -- 后的参数交给宿主
```

## 生效时机为什么不同

- **会话内热切**（`command` / `state`）：进程每轮重拼 system。Pi、pi-desktop、omp 靠 `before_agent_start` 钩子，OpenCode / dsh 靠插件每轮读状态。改设置下一轮就生效。
- **需新会话**：`system` 只在启动时拼一次。Claude、Codex、Grok、Kiro、Antigravity 等都属这类，改完必须重开会话。

逐家的热切能力见[支持情况](/reference/support)。

## 项目规则共享

同一份规则可以按目录写入宿主自己的规则文件，供该目录下的会话读取。适合「这个仓库要用简洁风格、其他仓库保持默认」这类场景。写入前有 diff 预览，撤销时按原字节还原。

## magpie 网关

如果使用 magpie 网关，可选插件位于仓库的 `magpie-plugin/` 目录，不是仓库根目录。安装方法和网关改写边界见该目录下的 README。