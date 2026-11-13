# 支持情况

以下为支持范围与当前验证程度；请求级验证只覆盖表中明确说明的宿主，不是对所有版本的兼容承诺。

## 先看净化方式

宿主给的入口分两种，直接决定人设是**取代**了宿主身份，还是**只是加了一段**：

| 净化方式 | 含义 | 宿主 |
|---|---|---|
| 替换 | 宿主提供整段 system prompt 入口，人设直接顶掉原生提示词 | Codex、OpenCode、DSH、Gemini CLI、Qwen、Qoder、Kimi、Kiro、CodeBuddy、Grok、omp、Claude* |
| 部分 | 替换生效，但宿主仍会前置自己的身份句 | Claude Code（残留 62 字身份句）、Kilo Code（`soul()` 前置 "You are Kilo"） |
| 追加 | **宿主没有整段入口，人设只是追加，原生身份仍在提示词里** | Antigravity（净增 517 字）、Crush、Continue、Auggie、Goose、zcode |
| 未测 | 没有系统提示词字数实测，不对外声称已净化 | pi、pi-desktop、WorkBuddy、WorkBuddy AI |

\* Claude 同时具备部分替换与整段替换的能力，取决于是否打二进制补丁；本仓库未包含该补丁。

每个宿主的判定与实测字数见 `matrix.json` 的 `purgeKind` 字段，测试会强制它与 `defaultSystemChars`/`purgedSystemChars` 自洽。未标注 `purgeKind` 的家默认为替换。

## 内置安全条款实测

「净化」到底删掉了什么，取决于宿主把安全条款写在哪。11 家隔离 HOME 四模式抓包，对 off 态 system 与 purge 后 system 分别统计「拒答 / 内容政策 / 越狱防护 / 有害用途」类条款冲突数：

| 执行器 | off 态 system | 内置安全条款 | purge 后 | 说明 |
|---|---|---|---|---|
| CodeBuddy | 17,262 | 13 | 0 | 完整 `<content_policy>`：政治敏感、色情、违法（武器/爆炸物/未授权入侵/欺诈/洗钱/毒品）、隐私、诽谤，逐条 MUST refuse |
| Claude | 27,237 | 3 | 0 | 拒答 DoS / 大规模针对 / 供应链破坏 / 检测规避；要求上报疑似 prompt injection |
| Kilo | 13,717 | 1 | 0 | 唯一命中是反向的「帮不上就直接给替代方案、别讲大道理」，不是安全限制 |
| OpenCode | 14,351 | 1 | 0 | 同上，反向表述 |
| Codex | 23,759 | 0 | 0 | 唯一 policy 命中是 Approval policy（沙箱权限说明），不是内容政策 |
| Antigravity | 15,824 | 0 | 0 | 只有 `<identity>` / `<guidelines>` / `<artifacts>` / `<subagents>` / `<skills>`，没有安全条款可删 |
| DSH / Grok / omp / opencode2 / pi | — | 0 | 0 | 系统提示词内无安全条款 |

**结论**：内置安全条款真实存在的只有 CodeBuddy 与 Claude，两家都在 replace 后归零——该删的删干净了。Antigravity 的提示词里一条都没有，它被拦在 Google 的 policy 分类器侧，不在本地提示词层，因此不在 purge 的能力范围内。zcode 未安装 CLI，未抓包。

口径：只统计强信号正则（refuse / content policy / harmful / jailbreak / weapons 等），不统计 `must not` 这类编码规范表述。机器可读数据在 `matrix.json` 的 `safety` 字段，测试会校验它与 `purgeKind` 不矛盾。

## 支持矩阵

| 执行器 / 宿主 | 已验证版本 | 主要接管通道 | 同会话热切 | 净化方式 | 验证状态与实测说明 |
|---|---|---|---|---|---|
| pi | 1.4.0 | 会话扩展 | 支持（`/purge` 热切） | 未测字数 | 动态扩展已实测；四模式抓包通过 |
| omp | 18.14.1 | 插件 | 支持 | 替换 | 四模式抓包；`MCP tool routes` 仍会追加（10K 量级），关掉 MCP server 可缩 |
| OpenCode 1.x / 2.x | 1.19.5 / 2.2.5 | 插件机制 | 支持（同会话注入） | 替换 | 插件挂载已实测，系统提示词 19332 → 112 |
| DSH | 0.2.1-rc.5 | 配置 / SDK / 插件 | 支持（SDK 同会话） | 替换 | headless/web/desktop 三形态四模式已抓包 |
| Codex | 0.166.0 | 启动参数 / 规则文件 | 需新会话 | 替换 | 启动入口已验证；固定替换身份，21026 → 24 |
| Claude Code | 2.1.316 | 启动参数 / 规则文件 | 需新会话 | 部分替换 | 启动入口与 `CLAUDE.md` 规则已验证；不打补丁仍残留 62 字身份句 |
| CodeBuddy | 2.179.0 | 启动入口 / 规则文件 | 需新会话 | 替换 | 启动参数与配置文件已验证；`<content_policy>` 13 条清零 |
| Grok | 1.0.73 | 启动入口 / 规则文件 | 需新会话 | 替换 | 5146 → 21 |
| Qwen Code | 0.27.2 | `--system-prompt` / `--append-system-prompt` | 需新会话 | 替换 | 启动参数已验证；长人设受命令行长度限制 |
| Gemini CLI | 0.68.0 | 环境变量 (`GEMINI_SYSTEM_MD`) | 需新会话 | 替换 | 真实包 `PromptProvider` 替换 core system prompt 已验证 |
| Crush | v0.100.0 | 全局规则 (`CRUSH.md`) / AGENTS.md | 需新会话 | 追加 | 真实 Windows release 实测；追加系统上下文，写托管块原子可逆 |
| Continue CLI | 1.5.47 | `--rule` | 需新会话 | 追加 | 真实安装 `@continuedev/cli`；`--rule` 追加规则/上下文 |
| Qoder CLI | 1.1.87 | `--system-prompt` / `--append-system-prompt` | 需新会话 | 替换 | 两个参数入口已验证，支持替换与追加 |
| Kimi Code | 2.5.3 | `--agent-file` | 需新会话 | 替换 | Markdown 正文作为 system prompt 替换 |
| Auggie CLI | 0.37.1 | `--rules` | 需新会话 | 追加 | `--rules` 追加规则/上下文 |
| Goose | 1.59.0 | `session/run --system` | 需新会话 | 追加 | `--system` 追加系统指令，BYOK 跑通 |
| Kiro CLI | 3.2.0 | `--agent` / Custom Agent | 需新会话 | 替换 | `--agent` 参数与自定义 agent `prompt` 字段替换已实测 |
| Kilo Code | @kilocode/cli 7.8.18 | 配置覆盖 (`code.md`) / AGENTS.md | 需新会话 | 部分替换 | 四模式真实抓包；`soul()` 仍前置 "You are Kilo" |
| Antigravity (agy) | CLI 1.5.3 / LS 1.23.x | 全局规则 (`~/.gemini/config/AGENTS.md`) | 需新会话 | 追加 | `<identity>` 完整保留，系统提示词 15378 → 15895（净增 517 字） |
| zcode | 3.16.3 | 配置 / Hook | 需新会话 | 追加 | CLI 拿不到 customSystemPrompt，9359 → 9359 未变 |
| WorkBuddy / WorkBuddy AI | 5.9.3 / 5.9.4 | 配置文件写入 (`app-config.json`) | 需新会话 | 未测字数 | 国际版与国内版上下文写入已实测 |
| pi-desktop | 0.21.0 | 持续配置 (`SYSTEM.md`) / 插件 | 支持（次轮生效） | 未测字数 | 持续配置与 imported 插件实测通过 |

## 详细验证记录

逐家 open/strict/replace/append 四模式的抓包结论、异常与已知坑见[兼容性与已知限制](/reference/compatibility)。
