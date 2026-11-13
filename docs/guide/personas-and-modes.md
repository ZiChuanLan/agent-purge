# 人设与模式

人设正文决定要提供给执行器的提示词；名称和说明只用于管理。首次运行会生成 `neutral` 起步模板，你可以在 Web 中直接编辑，也可以创建自己的 Markdown 文件。

```bash
agent-purge ls                       # 查看人设
agent-purge use <id>                 # 切换并同步已选范围
agent-purge mode append              # 修改全局模式
agent-purge use <id> --for codex     # 只给 Codex 指定人设
agent-purge use follow --for codex   # 恢复跟随全局
```

## 四种处理模式

| 模式 | 行为 | 注意 |
|---|---|---|
| `replace`（默认） | 优先替换宿主身份行，尽量保留其他说明 | 身份识别是近似处理；无法读取宿主文本的启动入口按 strict 执行 |
| `strict` | 用人设替换可控入口中的宿主文本 | 该入口原有说明也会移除；宿主仍可能添加额外文本 |
| `append` | 保留宿主说明，另加一份人设 | 不替换原身份，需注意规则冲突 |
| `off` | 停止相应入口注入 | 全局暂停与单次启动参数的作用范围不同 |

**strict 不等于「模型只收到人设」。** 实际角色可能是 `system`、`developer` 或项目上下文，取决于宿主和通道。希望保留宿主说明时，可先试 `append`。

模式只决定**注入的那段文本怎么写**，不改变**注入到哪**。宿主没有整段 system prompt 入口时，四种模式都只是追加——逐家判定见[支持情况](/reference/support)。

## 手写人设

将以下内容保存为 `~/.agent-purge/personas/concise.md`，然后执行 `agent-purge use concise`：

```markdown
---
id: concise
name: 简洁协作
description: 中文、先结论、修改前先读代码
---

用简体中文协作。先给结论，再给依据。
修改代码前先阅读现有实现；不确定时明确说明。
```

只有正文进入提示词。`description` 用于列表说明，旧键 `desc` 仍兼容；Web 编辑会保留未涉及的元数据。高级匹配、排序与数据目录配置见[命令行参考](/reference/cli#人设文件)。

也可参考维护者的 [some-magic 人设仓库](https://github.com/ZiChuanLan/some-magic)。

## 人设从哪来

- **Web 编辑**：人设库页直接改正文与元数据
- **本地导入**：`agent-purge persona import <dir>`，批量导入目录下的 `.md`
- **仓库拉取**：`agent-purge pull [repo]`，默认从 GitHub 拉取

## 按宿主覆写

控制台的每家详情里都能单独指定人设与力度，覆盖全局默认。覆写只影响该宿主，恢复「跟随全局」即可回到默认。
