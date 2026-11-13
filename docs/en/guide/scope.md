# Scope

Hosts expose more than one takeover entry point, each with a different reach and timing. Decide which layer you want to cover, then pick a channel.

## Four channels

| Channel | What it does | When it applies |
|---|---|---|
| `install` | Writes the host's managed config or plugin | Static config needs a new session; loaded dynamic plugins read the next turn |
| `shim` | Forwards launches through a same-named command on PATH | The next launch from that command |
| `slash` | Installs the in-session `/purge` extension | Depends on the host extension being enabled |
| `project` | Writes a project rule file for a given directory | New sessions in that directory |

```bash
agent-purge install codex
agent-purge arm pi --slash
agent-purge project on pi --dir /path/to/project
agent-purge status
```

`arm <h>` tries every persistent, command and slash channel available for that harness and reports each result. The project channel is chosen separately. When the same persona is served through several entry points it can duplicate — arm only what you need.

## Single-shot use

For a one-off run, launch through agent-purge without arming any persistent channel:

```bash
agent-purge codex --mode append
agent-purge pi --ask "Explain this code"
agent-purge codex -- --help          # Arguments after -- go to the host
```

## Why timing differs

- **In-session hot switch** (`command` / `state`): the process rebuilds the system prompt every turn. Pi, pi-desktop and omp use `before_agent_start` hooks; OpenCode and dsh use plugins that read state each turn. A settings change applies next turn.
- **New session required**: the system prompt is assembled once at startup. Claude, Codex, Grok, Kiro, Antigravity and others fall here — you must reopen the session.

Per-harness hot-switch capability is listed in the [support matrix](/en/reference/support).

## Shared project rules

The same rules can be written into a host's rule file per directory, for sessions started there. Useful for "this repository uses concise style, others keep the default". Writes have a diff preview and restore the original bytes on removal.

## magpie gateway

If you use the magpie gateway, the optional plugin lives in the repository's `magpie-plugin/` directory, not the repository root. Installation and gateway rewrite boundaries are documented in that directory's README.