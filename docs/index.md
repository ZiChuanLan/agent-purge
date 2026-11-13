---
layout: home

hero:
  name: agent-purge
  text: 一份人设，统一接管本机多个 coding agent
  tagline: 本地提示词与人设编排控制台 · 零生产依赖 · 每次写入都可逐位还原
  image:
    src: /logo.svg
    alt: agent-purge
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 支持情况
      link: /reference/support
    - theme: alt
      text: GitHub
      link: https://github.com/ZiChuanLan/agent-purge

features:
  - title: 一份人设，多端入口
    details: CLI 与 Web 共用同一份人设库与账本，支持单次启动、常驻配置、会话内 <code>/purge</code> 热切与按目录写入项目规则。
  - title: 能力诚实、分家自治
    details: 默认跟随全局人设与改写力度，也可按工具单独覆写；界面严格按各家实测支持度展示可用通道与力度，不摆假开关。
  - title: 支持热切，也明示边界
    details: Pi / omp / OpenCode / dsh 等具备每轮回调的动态通道下一轮即生效；静态配置或启动参数入口明示需新开会话。
  - title: 原子可逆
    details: 每次写入前保留原字节 <code>stash</code> 快照，关闭即逐位还原；项目规则支持 diff 预览与 SHA 冲突检测。
  - title: 零生产依赖、本地优先
    details: 无外部后端、不上传配置，数据保存在独立目录（默认 <code>~/.agent-purge/</code>），升级不覆盖用户人设。
  - title: 实测数据可查
    details: 每个宿主的净化效果、内置安全条款、残留说明都有隔离 HOME 真实抓包佐证，测试会拦住与实测矛盾的数字。
---

## 它解决什么问题

各家 coding agent 都自带一份系统提示词：产品身份、行为规范、拒答条款、工具说明。你想用自己的方式跟它协作，就得反复改各家互不兼容的配置——而且改坏了很难退回。

agent-purge 把这些入口收成一处：**同一份人设，注入到你指定的宿主；同一条命令，随时撤回原样。**

## 两种用法

::: code-group

```bash [图形控制台]
agent-purge web
```

```bash [命令行]
agent-purge codex --mode replace
agent-purge use concise
agent-purge arm pi --slash
```

:::

## 先看实测，再看宣传

不同宿主的净化能力差别很大，这个项目选择把差别写清楚：

- **真替换**：Codex、OpenCode、DSH、Claude、Gemini CLI、Qwen、Qoder、Kimi、Kiro、CodeBuddy、Grok、omp —— 宿主提供整段 system prompt 入口，人设直接顶掉原生提示词。
- **部分替换**：Claude（残留 62 字身份句）、Kilo（`soul()` 前置身份）。
- **只能追加**：Antigravity、Crush、Continue、Auggie、Goose、zcode —— 宿主没有整段入口，原生身份仍在提示词里。

逐家判定依据、实测字数与内置安全条款数据见 [支持情况](/reference/support) 与 [兼容性与已知限制](/reference/compatibility)。

## 界面一览

![agent-purge 控制台总览](/images/console-desktop.png)

系统提示词接管在「控制台」；项目目录及各家全局规则文件统一在「规则文件」页按作用范围与指定人设写入。

![agent-purge 规则文件](/images/project-rules.png)
