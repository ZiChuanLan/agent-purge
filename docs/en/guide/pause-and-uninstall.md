# Pause and uninstall

## Pause or revoke

| Goal | Command | User personas |
|---|---|---|
| Temporarily pause / restore the armed scope | `agent-purge pause` / `agent-purge resume` | Kept |
| Revoke only one host's persistent config | `agent-purge uninstall dsh` | Kept, other channels untouched |
| Revoke every armed channel for one host | `agent-purge disarm dsh` | Kept |
| Revoke all registered takeovers | `agent-purge clean` | Kept |

```bash
agent-purge pause
agent-purge resume
agent-purge disarm dsh
agent-purge clean
```

## Removing the program

Revoke first, then remove:

```bash
agent-purge clean
npm uninstall -g agent-purge
```

The Windows installer's uninstall also revokes takeovers and keeps personas. On a restore conflict, keep the file and credentials named in the error and compare changes before acting — **never delete the backup outright**. Content already sent in past sessions cannot be recalled.

## Deleting data permanently

Back up first, then follow the uninstall section of the [CLI reference](/reference/cli#暂停撤销和卸载). `self-uninstall --yes` differs from a normal uninstall.

## Privacy boundaries

- **Local management**: the default data directory is `~/.agent-purge/` (`C:\Users\<user>\.agent-purge\` on Windows). Override with `AGENT_PURGE_HOME`; upgrades never overwrite it.
- **Model requests still go online**: once armed, the persona travels with the host's requests to whatever model service it is configured for. Local management is not offline operation. Update checks contact GitHub.
- **Host permissions are untouched**: this manages prompts and config entry points. It does not crack hosts or bypass authorization, and it does not guarantee rewritten model behaviour.
- **Only use it where you are authorized**: the Web UI binds to `127.0.0.1`; never expose it publicly. Full terms: [Legal](/en/LEGAL).