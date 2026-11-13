# Personas and modes

The persona body is what gets delivered to the agent; the name and description are for management only.

```bash
agent-purge ls                       # List personas
agent-purge use <id>                 # Switch active persona and sync armed scopes
agent-purge mode append              # Change global injection mode
agent-purge use <id> --for codex     # Assign persona specifically to Codex
agent-purge use follow --for codex   # Restore Codex to follow the global persona
```

## Four injection modes

| Mode | Behavior | Notes |
|---|---|---|
| `replace` (default) | Replaces host identity lines, preserving other instructions | Approximate detection; launch-arg harnesses that cannot read the host prompt fall back to strict |
| `strict` | Replaces the controllable host prompt with the persona | Clears the existing host instructions; the host may still prepend its own wrapper |
| `append` | Keeps host instructions and adds the persona | Original identity stays; watch for conflicting instructions |
| `off` | Stops injection for the target entry points | Global pause and single-shot flags act on different scopes |

**strict does not guarantee the model only receives your persona.** The effective role may be `system`, `developer`, or project context depending on the harness and channel. When unsure, try `append` first.

A mode decides **how the injected text is written**, not **where it lands**. When a host exposes no full system-prompt entry point, all four modes are just appends — see the [support matrix](/en/reference/support).

## Writing a persona by hand

Save this as `~/.agent-purge/personas/concise.md`, then run `agent-purge use concise`:

```markdown
---
id: concise
name: Concise collaboration
description: Lead with the conclusion; read the code before changing it
---

Lead with the conclusion, then the evidence.
Read the existing implementation before editing; say so when unsure.
```

Only the body reaches the prompt. `description` is list metadata; the legacy `desc` key still works, and Web edits preserve metadata they do not touch.

## Where personas come from

- **Web editor** — edit body and metadata in the Persona Library
- **Local import** — `agent-purge persona import <dir>` to bulk-import `.md` files
- **Repository pull** — `agent-purge pull [repo]`, defaults to GitHub

## Per-harness override

Each harness in the console can be given its own persona and mode, overriding the global default. Overrides affect only that harness; restoring "follow global" resets it.