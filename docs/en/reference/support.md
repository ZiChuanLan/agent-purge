# Support matrix

The following is the supported scope and current verification level. Request-level verification only covers the harnesses explicitly listed; it is not a compatibility promise for every version.

## Purge kind first

Host entry points come in two kinds, and they decide whether the persona *replaces* the host identity or is merely *added*:

| Purge kind | Meaning | Hosts |
|---|---|---|
| Replace | The host exposes a full system-prompt entry point; the persona displaces the native prompt | Codex, OpenCode, DSH, Gemini CLI, Qwen, Qoder, Kimi, Kiro, CodeBuddy, Grok, omp, Claude* |
| Partial | Replacement works, but the host still prepends its own identity sentence | Claude Code (62-character identity sentence remains), Kilo Code (`soul()` prepends "You are Kilo") |
| Append | **No full entry point exists; the persona is only appended and the native identity stays in the prompt** | Antigravity (+517 chars), Crush, Continue, Auggie, Goose, zcode |
| Unverified | No measured system-prompt size; we do not claim it is purged | pi, pi-desktop, WorkBuddy, WorkBuddy AI |

\* Claude can do partial or full replacement depending on a binary patch; this repository does not include that patch.

Every judgement and measured count lives in the `purgeKind` field of `matrix.json`; tests force it to agree with `defaultSystemChars`/`purgedSystemChars`. A host without `purgeKind` defaults to replace.

## Measured safety clauses

What purge removes depends on where the host writes its safety clauses. Isolated-HOME four-mode captures across 11 harnesses counted refusal / content-policy / jailbreak / harmful-use clauses in the off-state system prompt and after purge:

| Harness | off-state system | Built-in safety clauses | After purge | Notes |
|---|---|---|---|---|
| CodeBuddy | 17,262 | 13 | 0 | A full `<content_policy>`: politically sensitive topics, pornography, illegal activity (weapons, explosives, unauthorized hacking, fraud, money laundering, drugs), privacy leaks, defamation — each a MUST refuse |
| Claude | 27,237 | 3 | 0 | Refuses DoS / mass targeting / supply-chain compromise / detection evasion; asks the model to report suspected prompt injection |
| Kilo | 13,717 | 1 | 0 | The only hit is the reverse case — "if you can't help, offer alternatives, don't preach" |
| OpenCode | 14,351 | 1 | 0 | Same reverse phrasing |
| Codex | 23,759 | 0 | 0 | The only `policy` hit is Approval policy (sandbox permissions), not content policy |
| Antigravity | 15,824 | 0 | 0 | Only `<identity>` / `<guidelines>` / `<artifacts>` / `<subagents>` / `<skills>`; nothing to remove |
| DSH / Grok / omp / opencode2 / pi | — | 0 | 0 | No safety clauses in the system prompt |

**Conclusion**: only CodeBuddy and Claude actually carry built-in safety clauses, and both drop to zero after replace. Antigravity has none in its prompt — it is blocked in Google's policy classifier, not in the local prompt layer. zcode was not captured (no CLI installed).

Counting rule: strong-signal regexes only (refuse / content policy / harmful / jailbreak / weapons), excluding `must not` phrasing that appears in ordinary coding guidelines.

## Matrix

| Harness | Verified version | Primary channel | Hot switch | Purge kind | Notes |
|---|---|---|---|---|---|
| pi | 1.4.0 | Session extension | Yes (`/purge`) | Unverified | Dynamic extension measured; four modes captured |
| omp | 18.14.1 | Plugin | Yes | Replace | Four modes captured; MCP tool routes still appended (~10K) |
| OpenCode 1.x / 2.x | 1.19.5 / 2.2.5 | Plugin | Yes | Replace | Plugin mount measured; 19332 → 112 |
| DSH | 0.2.1-rc.5 | Config / SDK / plugin | Yes | Replace | headless/web/desktop all captured |
| Codex | 0.166.0 | Launch args / rules | New session | Replace | Fixed replacement; 21026 → 24 |
| Claude Code | 2.1.316 | Launch args / rules | New session | Partial | 62-character identity sentence remains without a binary patch |
| CodeBuddy | 2.179.0 | Launch args / rules | New session | Replace | `<content_policy>` 13 clauses cleared |
| Grok | 1.0.73 | Launch args / rules | New session | Replace | 5146 → 21 |
| Qwen Code | 0.27.2 | `--system-prompt` / `--append-system-prompt` | New session | Replace | Long personas hit command-line limits |
| Gemini CLI | 0.68.0 | `GEMINI_SYSTEM_MD` | New session | Replace | `PromptProvider` replaces the core system prompt |
| Crush | v0.100.0 | `CRUSH.md` / AGENTS.md | New session | Append | Appends system context; atomic, reversible |
| Continue CLI | 1.5.47 | `--rule` | New session | Append | Appends rule context |
| Qoder CLI | 1.1.87 | `--system-prompt` / `--append-system-prompt` | New session | Replace | Both entry points verified |
| Kimi Code | 2.5.3 | `--agent-file` | New session | Replace | Markdown body replaces the system prompt |
| Auggie CLI | 0.37.1 | `--rules` | New session | Append | Appends rule context |
| Goose | 1.59.0 | `session/run --system` | New session | Append | Appends system directives |
| Kiro CLI | 3.2.0 | `--agent` / custom agent | New session | Replace | Custom agent `prompt` replaces the system prompt |
| Kilo Code | @kilocode/cli 7.8.18 | `code.md` / AGENTS.md | New session | Partial | `soul()` still prepends "You are Kilo" |
| Antigravity (agy) | CLI 1.5.3 / LS 1.23.x | `~/.gemini/config/AGENTS.md` | New session | Append | `<identity>` fully retained; 15378 → 15895 |
| zcode | 3.16.3 | Config / hook | New session | Append | CLI cannot take customSystemPrompt; 9359 → 9359 |
| WorkBuddy / WorkBuddy AI | 5.9.3 / 5.9.4 | `app-config.json` | New session | Unverified | Config write measured |
| pi-desktop | 0.21.0 | `SYSTEM.md` / plugin | Yes (next turn) | Unverified | Persistent config and imported plugin measured |

## Detailed records

Per-harness four-mode capture conclusions, anomalies and known pitfalls are documented in [Compatibility and limits](/reference/compatibility) (Chinese).