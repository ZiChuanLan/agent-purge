# Getting started

## Requirements

**Node.js 20+**, plus the coding agents you want to manage installed locally. agent-purge ships no models and no credentials.

## Install

```bash
npm install -g agent-purge
agent-purge web
```

Or run it without a global install:

```bash
npx agent-purge web
```

## First run

1. Edit the starter persona or create a new one in the **Persona Library**.
2. Go to the **Console**, select the active persona and mode, save, then arm the target harnesses.
3. Follow the per-harness guidance to reload the plugin or start a new session.

The console listens on `http://127.0.0.1:7788`. If that port is reserved or taken it falls forward to a free port in `7890–7909` and opens a desktop window. **Nothing is armed on first launch.**

## Installation formats

| Format | Requirements | Typical use |
|---|---|---|
| npm | Node.js 20+ | Standard cross-platform install and upgrade |
| `agent-purge-<version>-setup.exe` | Windows, external Node.js 20+ | GUI installer and uninstaller |
| `agent-purge-<version>.zip` | Windows, external Node.js 20+ | Portable archive |
| `agent-purge.exe` | Windows x64, bundled runtime | Standalone executable, no Node required |
| `agent-purge-<version>-darwin-arm64.dmg` / `x64.dmg` | macOS 12+ (bundled runtime) | Unsigned `.app`; right-click → Open or `xattr -cr` on first launch |
| `agent-purge-<version>-linux-x64` / `-linux-arm64` | Major Linux distros, bundled runtime | Single binary; `chmod +x` and run |
| `agent-purge-<version>-linux-<arch>.tar.gz` | Major Linux distros | Portable archive with `.desktop`, icon and a root-free `install.sh` |
| `agent-purge-<version>-linux-<arch>.deb` | Debian / Ubuntu derivatives | `sudo apt install ./*.deb` |
| `agent-purge-<version>-linux-<arch>.AppImage` | Major Linux distros (only when produced) | Double-click or `--appimage-extract-and-run` |

Download binaries from [GitHub Releases](https://github.com/ZiChuanLan/agent-purge/releases); unreleased versions have no assets. Verify SHA-256 and signature status — unsigned binaries may trigger OS warnings. The EXE inside the ZIP is a thin launcher, not the standalone build.

For headless/SSH/WSL environments run `agent-purge web --no-open`. The Web interface binds to loopback only.

## Upgrading

The version badge in the console opens the upgrade path that matches your install:

- Standalone EXE: downloads and hot-swaps in place
- npm global install: runs `npm install -g`
- **Source checkout** (`git clone`, run `node bin/agent-purge.mjs`): runs `git pull --ff-only` in the install directory and downloads nothing

Update detection for a source checkout compares upstream commits, so it can report an update when the version number has not changed. A dirty worktree, a detached HEAD, or a branch without an upstream is refused with an explanation.

## Next

- [Personas and modes](/en/guide/personas-and-modes) — what the four modes actually change
- [Scope](/en/guide/scope) — single-shot, persistent, command takeover, project rules
- [Support matrix](/en/reference/support) — measured purge and residue per harness