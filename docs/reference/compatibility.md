# 兼容性与已知限制

[返回项目首页](/)

以下是 **2026-11-01 的本地验收快照**，只适用于列出的版本；不代表所有宿主版本或远端发行包均通过。

## 宿主请求验证

真实宿主进程使用隔离 HOME、配置与本地测试 provider，不继承生产凭据。九个宿主的 `off / strict / replace / append` 共 36 次主请求均完成捕获，进程退出码为 0。

| 执行器 | 实测版本 | 实际角色 | off → strict 字符数 | 同会话热切 |
|---|---|---|---|---|
| pi | 1.4.0 | system | 2,845 → 111 | 通过 |
| omp | 18.14.1 | system | 10,588 → 568 | 通过（扩展入口） |
| codex | 0.166.0 | developer | 20,745 → 3,685 | 未验证；启动参数入口 |
| claude | 2.1.316 | system | 27,237 → 254 | 未验证；启动参数入口 |
| codebuddy | 2.179.0 | system | 17,261 → 119 | 未验证；启动参数入口 |
| grok | 1.0.73 | system | 5,121 → 113 | 未验证；启动参数入口 |
| opencode | 1.19.5 | system | 10,992 → 117 | 通过 |
| opencode2 | 2.2.5 | system | 10,052 → 118 | 通过 |
| dsh | 0.2.1-rc.5 | system | 2,729 → 112 | 通过（SDK 同会话；headless/web/desktop 三形态四模式已抓） |

热切保持同一进程和会话，执行 A → B → strict → off，检查旧人设残留和工具定义。字符数用于描述一次请求，不是质量评分。

- Claude 的 strict 仍含固定身份句；Codex 和 OMP 仍有额外运行说明。`strict` 仅替换可控入口。
- DSH 的 replace 曾漏掉包含 `{{model}}` 的身份模板行，工作区已补回归；身份行匹配仍不是完整语义识别。
- DSH 三形态已于 2026-11-02 补测（`0.2.1-rc.5`，本地 loopback provider）：headless 用 CLI，web 用 `dsh web`，desktop 用 `DeepSeek Harness.exe`；三形态各 `off / strict / replace / append` 四模式，共 12 次主请求均在 system 层捕获，marker 命中 1（off 为 0），user 层 0。见 `out/capture/dsh-surfaces-2026-11-01T18-05-22-727Z/report.json`。desktop 的 strict 仍含宿主注入的约 11.4K `billion-context` 系统提醒，因此 strict 不是纯人设。
- DSH 0.2.2-rc.1（2026-11-06 本机验证）：0.2.2 把 profile 依赖交给 pnpm 的运行时解析表，插件不能继续手写进 `<profile>/node_modules`——目录一旦被清理就报 `Cannot find package '<name>' imported from .../profiles/web/`（issue #11）。插件包改放数据目录，patch 用绝对 `file:` URL 引用；`0.2.1-rc.5` 与 `0.2.2-rc.1` 均实测能加载，profile 名在运行时取宿主 `profileContext`（旧布局的路径推导保留为兜底）。四模式抓包结论未因此变化。
- Hermes、zcode 未找到入口，不计成功。
- WorkBuddy 5.9.3 于 2026-11-02 用本机桌面会话验证 `settings.json → personalization.customPrompt`：写入测试人设后模型回答切换成功；这是身份上下文追加，不是完整 system 替换，云端请求体不可见，因此不列入上表。
- WorkBuddy 设置里的“名字”“人设设定”是它自己的云端个人配置，不是 `customPrompt`；关闭 agent-purge 不会清掉这两项，也不应越权改写。
- WorkBuddy（国内 5.9.3 / 国际 5.9.4，2026-11-06 本机 CDP 实测）：身份槽位是 `personalization.customPrompt`，但 AppConfigService 的主存是 `<home>/app/app-config.json`，`settings.json` 只是 `readLegacySettings()` 的回落。只写 `settings.json` 时面板显示旧值；改写 `app-config.json` 后立即按新人设作答（“你叫什么名字” → 阿绿）。两者都写时以 `app-config.json` 为准（国内版实测回答阿绿而不是 settings 里的阿紫）。因此 agent-purge 按「`app-config.json` 存在就写它，否则写 `settings.json`」写入，并在两处都清掉自己写过的 marker。
- Antigravity（CLI `agy` 1.5.3 / 桌面 App 语言服务 1.23.x，2026-11-09）：唯一自动生效的落点是 `~/.gemini/config/AGENTS.md`（无 frontmatter = `always_on`），宿主把它插进 `systemInstruction` 的 `<user_rules>` 段。隔离 HOME 真实二进制抓包 `off/strict/replace/append` 四模式均捕获主请求，marker 全落 system 层（system 15378 → 15895/15844/15843 字），`<user_rules>` 位于 `</identity>` 之后。真模型三问（直问身份 / 追问底层模型 / 越狱式要求说出真名）均自称新人设。**残留**：`<identity>` 段里的 `You are Antigravity, ...` 仍在提示词里，靠规则段的 take-precedence 声明压住，不是删除。`~/.gemini/config/agents/<name>.md` 能整段换掉 `<identity>`，但必须先 `--agent <name>` 或手动选择，`settings.json` 里没有默认 agent 键（34 个键全试过），所以不作自动通道。
- Kilo Code `@kilocode/cli` 7.8.18：`~/.config/kilo/agent/code.md`（replace/strict）与 `AGENTS.md`（append）通道；2026-11-02 隔离 HOME 真实二进制抓包 `off/strict/replace/append` 四模式均捕获主请求，marker 全落 system 层（system 13717→5442/5353/13975 字）；源码确认 `soul()` 仍前置 `You are Kilo`。
- `opencode`（`opencode-ai` 1.x）与 `opencode2`（`@opencode/cli` 2.x）是不同接口，不能混用插件。
- 不支持注入的闭源桌面入口不会标为注入成功；有些只能原样启动，有些会明确拒绝。

### 内置安全条款实测（2026-11-13）

「净化」到底删掉了什么，取决于宿主把安全条款写在哪。11 家隔离 HOME 四模式抓包，对 off 态 system 与 purge 后 system 分别统计「拒答 / 内容政策 / 越狱防护 / 有害用途」类条款冲突数：

| 执行器 | off 态 system | 内置安全条款 | purge 后 | 说明 |
|---|---|---|---|---|
| codebuddy | 17,262 | 13 | 0 | 完整 `<content_policy>`：政治敏感、色情、违法（武器/爆炸物/未授权入侵/欺诈/洗钱/毒品）、隐私、诽谤，逐条 MUST refuse |
| claude | 27,237 | 3 | 0 | 拒答 DoS / 大规模针对 / 供应链破坏 / 检测规避；要求上报疑似 prompt injection |
| kilo | 13,717 | 1 | 0 | 唯一命中是反向的「帮不上就直接给替代方案、别讲大道理」，不是安全限制 |
| opencode | 14,351 | 1 | 0 | 同上，反向表述 |
| codex | 23,759 | 0 | 0 | 唯一 policy 命中是 Approval policy（沙箱权限说明），不是内容政策 |
| antigravity | 15,824 | 0 | 0 | 只有 `<identity>` / `<guidelines>` / `<artifacts>` / `<subagents>` / `<skills>`，没有安全条款可删 |
| dsh / grok / omp / opencode2 / pi | — | 0 | 0 | 系统提示词内无安全条款 |

**结论**：内置安全条款真实存在的只有 CodeBuddy 与 Claude，两家都在 replace 后归零——该删的删干净了。Antigravity 的提示词里一条都没有，它被拦在 Google 的 policy 分类器侧，不在本地提示词层，因此不在 purge 的能力范围内。zcode 未安装 CLI，未抓包。

口径：只统计强信号正则（refuse / content policy / harmful / jailbreak / weapons 等），不统计 `must not` 这类编码规范表述。机器可读数据在 `matrix.json` 的 `safety` 字段，测试会校验它与 `purgeKind` 不矛盾。

## 系统、浏览器与发行形式

| 项目 | 已执行 | 尚不能据此承诺 |
|---|---|---|
| Windows 11 x64 | Node 20.20.2 / 22.23.4 / 24.13.1 回归 | 所有 Windows/CPU 版本 |
| Ubuntu 24.04 WSL2 x64 | Node 20.20.2 / 22.23.4 / 24.13.1 回归 | 原生 Linux 桌面及其他发行版 |
| Web | Edge 156、Firefox 157、WebKit 27.2 共 21 项；320/390/768/1440px | macOS/Safari 系统集成、完整人工无障碍认证 |
| npm | Windows 与 Linux 实际 tarball 离线安装、CLI/Web | 未测的包管理器和受限企业环境 |
| Windows ZIP / 独立 EXE | 解压后运行；独立 EXE 在无 Node 的 PATH 下运行 | 全新操作系统或已签名发行 |
| Windows 安装器 | 临时目录连续三轮安装、重装、原生启动器、冲突阻止卸载及数据保留 | 干净 VM、跨版本升级、所有目录 |
| macOS | 已配置 CI 矩阵 | 本轮没有 macOS 实机或远端运行证据 |
| Linux 发行包 | Ubuntu 24.04 上构建 `linux-x64` / `linux-arm64` 二进制、`.tar.gz`、`.deb`；`.deb` 实际 `dpkg -i` 安装、运行 `--help` / `status` 后 `dpkg -r` 干净卸载；便携包的 `install.sh` 装到 `~/.local` 后可执行；独立二进制在 PATH 无 Node 时运行 | 原生 Linux 桌面环境与多数发行版的桌面启动器；AppImage 取决于 runner 能否取到 appimagetool |

Linux 上的 Windows 参数桥接测试明确跳过。CI 矩阵定义不等于远端执行成功，必须核对对应提交。

## 已知发布限制

- **覆盖安装存在环境相关失败**：工作区所在 H 盘出现两次卸载日志文件占用，重装退出码为 4；系统临时目录连续通过，但占用者与根因尚未确认。不要把“重跑通过”视为问题已修复。
- 当前本地 Windows 产物未签名。SHA-256 只用于核对字节，不等于发布者签名。
- 干净 Windows、macOS、跨版本升级和 Release 上传后重新下载核对仍需完成。
- 不保证提示词改写后的模型表现；请求角色、人设命中与模型行为是三件事。

## 验证状态与第三方中转

Web 的“安全试跑”使用临时 HOME、测试人设和本地 provider。DSH 的 headless/web/desktop 三形态四模式已分别抓包，同会话热切使用 SDK 验证；隔离抓包仍不能替代用户正在运行的会话，也不能证明第三方中转完整转发了提示词。

- **未捕获请求**：没有足够请求证据，不能判定人设未命中。
- **验证出错**：进程退出失败或超时，保留错误原因与隔离进程输出。
- **请求未命中**：确实捕获到主请求，但 system/developer 未出现测试人设。
- **隔离测试命中**：相应测试入口成功传递了测试人设，不等于模型会服从，也不代表当前会话。
- **暂停验证通过**：off 模式没有残留测试人设，不应显示为“未命中”。

2026-11-02 排查发现：DSH 单模式验证原先缺少首次 profile 初始化，四模式测试中先运行 off 恰好掩盖了该缺陷；工作区现已修复，并将辅助标题请求与主请求分开判定。

第三方中转需要另行验证 **宿主 → 中转 → 上游模型**。应使用不含私密数据的测试标记，核对两端实际请求字段；仅比较“你是谁”的回答，不能判断 system 是否被删除。改变人设提示词也不能保证修复中转的协议转换或服务端过滤。

## 复现

```bash
npm test
npm run test:package
npm run test:ui
node bench/capture-system.mjs --hot --no-publish
```

真实宿主测试需先安装相应宿主。原始请求和日志进入被 Git 忽略的 `out/`；`--no-publish` 不替换用户已有 Web 验证报告。HTTP 代理隔离不等于操作系统网络沙箱。

版本表只保留便于维护的结论；原始诊断、截图迭代和逐文件哈希不进入源码仓库。每次发布的证据应随对应 CI artifact 保存，见[发布流程](../releasing.md)。
