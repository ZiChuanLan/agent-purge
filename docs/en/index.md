---
layout: home

hero:
  name: agent-purge
  text: One persona, many coding agents
  tagline: A local prompt and persona console · zero production dependencies · every write is byte-reversible
  image:
    src: /images/logo.svg
    alt: agent-purge
  actions:
    - theme: brand
      text: Get started
      link: /en/guide/getting-started
    - theme: alt
      text: Support matrix
      link: /en/reference/support
    - theme: alt
      text: GitHub
      link: https://github.com/ZiChuanLan/agent-purge

features:
  - title: One configuration, many entry points
    details: CLI and Web share the same persona library and armed state — single-shot launches, persistent configs, in-session <code>/purge</code>, and project rule files.
  - title: Per-harness autonomy
    details: Harnesses follow global settings by default, or get their own persona and injection mode. The console only offers channels that were measured to work.
  - title: Hot-switch with honest boundaries
    details: Harnesses with per-turn callbacks apply changes on the next turn; static config entry points require a new session, and the UI says so.
  - title: Byte-reversible
    details: Every write stashes the original bytes and restores them exactly on uninstall. Project rules get diff preview and SHA conflict detection.
  - title: Local first
    details: No external backend, no config uploads. Data lives in <code>~/.agent-purge/</code> and survives upgrades.
  - title: Measured, not claimed
    details: Purge effect, built-in safety clauses and residue per harness are backed by isolated-HOME captures, and tests fail when numbers contradict measurements.
---

## The problem

Every coding agent ships its own system prompt: product identity, behavioural rules, refusal clauses, tool instructions. To work your way, you rewrite a different config for each host — and a bad edit is hard to undo.

agent-purge collects those entry points into one place: **one persona, injected into the hosts you pick; one command, restored exactly.**

## Two ways to drive it

::: code-group

```bash [Console]
agent-purge web
```

```bash [CLI]
agent-purge codex --mode replace
agent-purge use concise
agent-purge arm pi --slash
```

:::

## Read the measurements first

Purge capability differs a lot per host, and this project writes the difference down:

- **Full replace**: Codex, OpenCode, DSH, Claude, Gemini CLI, Qwen, Qoder, Kimi, Kiro, CodeBuddy, Grok, omp — the host exposes a full system-prompt entry point.
- **Partial**: Claude (a 62-character identity sentence remains), Kilo (`soul()` prepends an identity).
- **Append only**: Antigravity, Crush, Continue, Auggie, Goose, zcode — no full entry point; the native identity stays in the prompt.

Per-harness evidence, measured sizes and built-in safety clause data: [Support matrix](/en/reference/support).

## Console

![agent-purge console](/images/console-desktop.png)

![agent-purge project rules](/images/project-rules.png)
