# InfiniBot Desktop (Electron)

This directory packages InfiniBot as a standalone desktop app. The Electron
shell does **one job**: it boots the same InfiniBot **gateway** that
`pnpm start` runs (using Electron's own bundled Node via
`ELECTRON_RUN_AS_NODE=1`, so we don't ship a second Node runtime), then
points a native window at the gateway's web UI on `http://127.0.0.1:18789`.

> The mobile app is **not** bundled here. Mobile (React Native) stays a
> separate codebase and connects to this same gateway over the LAN — see
> [Mobile gateway discovery](#mobile-gateway-discovery) below. Do not try to
> render React Native inside Electron.

## Architecture at a glance

| Piece | File | What it does |
|-------|------|--------------|
| Main process | `main.js` | window/tray lifecycle, spawns gateway, IPC |
| Gateway launcher | `launcher.js` | run by Electron-as-Node; locates & loads `dist/entry.js` |
| First-run wizard | `wizard.html` / `wizard.js` | restore / local / satellite setup |
| Preload bridge | `preload.js` | safe `window.wizard` / `window.api` surface |
| Builder config | `package.json` → `build` | electron-builder targets |
| `.deb` maintainer scripts | `build/deb/postinst.sh`, `postrm.sh` | desktop-db + icon-cache refresh |

The gateway is spawned as a child process (`daemon start --foreground`) and
the window waits for `/health` before loading the UI. On quit, both the
satellite and local gateway children are `SIGTERM`-ed.

## Outputs

All installers land in `electron/dist/` with predictable names (version is
pulled from this dir's `package.json`, kept in lock-step with the repo root —
currently **2026.6.29**):

| Platform | Target | File |
|----------|--------|------|
| Windows | NSIS installer | `InfiniBot-Setup-<version>.exe` |
| Windows | Portable | `InfiniBot-Portable-<version>.exe` |
| Linux | Debian package | `infinibot_<version>_amd64.deb` (and `_arm64.deb`) |
| Linux | AppImage | `InfiniBot-<version>.AppImage` (x64), `…-arm64.AppImage` |

`electron/dist/` is git-ignored (covered by the root `dist` rule) — installers
are never committed.

## Build commands

Run these from the **repo root**:

```bash
# Produce all installers for the CURRENT platform:
pnpm electron:dist

# Platform-scoped:
pnpm electron:build:linux   # AppImage + .deb (run on Linux)
pnpm electron:build:win     # NSIS + portable .exe (run on Windows; see matrix)
pnpm electron:build:mac     # dmg + zip (run on macOS)
```

Each of these first runs `electron:bundle:prepare`, which:
`pnpm build` → `pnpm ui:build` → `pnpm mobile:web:build` →
`cd electron && npm install && npm run rebuild` (rebuilds native modules —
`better-sqlite3`, `@lydell/node-pty`, `sharp` — against Electron's ABI).

## Cross-platform build matrix

electron-builder cannot fully cross-compile every target. Build where the
target natively belongs:

| Build host | Can produce | Notes |
|------------|-------------|-------|
| **Linux** | `.deb`, `.AppImage` | Native modules rebuilt for Electron ABI. ✅ Verified on this box. |
| **Windows** | `.exe` (NSIS + portable) | **Build the `.exe` here.** Native modules need MSVC build tools (`windows-build-tools` / Visual Studio Build Tools). |
| **macOS** | `.dmg`, `.zip` | Requires an `assets/icon.icns` (not committed yet). |
| Linux → Windows | `.exe` via **Wine** | Possible but fragile with native modules. Prefer a real Windows host. |

### Producing the Windows `.exe` (6-line recap)

1. On a Windows box, ensure the `main` branch is up to date (PR #24 has the
   latest) and install **Node 20+**, **pnpm**, and **Visual Studio Build
   Tools** (C++ workload).
2. `pnpm install` at the repo root.
3. `pnpm electron:build:win`.
4. Find `InfiniBot-Setup-<version>.exe` and `InfiniBot-Portable-<version>.exe`
   in `electron/dist/`.
5. (Optional) set `CSC_LINK` + `CSC_KEY_PASSWORD` first to code-sign — see below.
6. Install with the Setup `.exe` (one-click) or just run the Portable `.exe`.

## Installing the produced packages

```bash
# Linux .deb:
sudo dpkg -i infinibot_<version>_amd64.deb
sudo apt-get install -f          # pull any missing runtime deps
# …or in one step:
sudo apt install ./infinibot_<version>_amd64.deb

# Linux AppImage (no install):
chmod +x InfiniBot-<version>.AppImage
./InfiniBot-<version>.AppImage

# Windows:
#  - InfiniBot-Setup-<version>.exe   → one-click install, Start Menu shortcut, uninstaller
#  - InfiniBot-Portable-<version>.exe → runs from anywhere, no install
```

The `.deb` installs to `/opt/InfiniBot`, drops a `.desktop` entry into
`/usr/share/applications`, registers hicolor icons, and its `postinst.sh`
refreshes `update-desktop-database` + `gtk-update-icon-cache` so InfiniBot
appears in app menus immediately.

## Code-signing

Signing is **not** done in this PR — only the hooks are wired. electron-builder
reads these env vars at build time:

| Platform | Env var | Value |
|----------|---------|-------|
| Windows | `CSC_LINK` | path/URL to your `.pfx`/`.p12` certificate |
| Windows | `CSC_KEY_PASSWORD` | the certificate's password |
| macOS | `CSC_LINK` / `CSC_KEY_PASSWORD` | Developer ID cert + password |

To sign later, obtain an **OV/EV Authenticode certificate** (Windows) from a CA
(DigiCert, Sectigo, etc.), export it as `.pfx`, then:

```bash
export CSC_LINK="C:\path\to\cert.pfx"
export CSC_KEY_PASSWORD="••••••"
pnpm electron:build:win
```

Without these set, builds are **unsigned** (Windows SmartScreen will warn;
that's expected for an unsigned binary).

## Runtime dependencies

- **Node**: bundled by Electron — nothing to install.
- **Voice**: nothing to install locally. Voice runs on **Robovoice** — the
  wizard's optional "Connect Robovoice" step can open the Voice page after
  setup, or link any time with `infinibot robovoice login`. Docker is not
  required.

## Mobile gateway discovery

The Electron host runs the gateway on `127.0.0.1:18789` (HTTP/WS UI). The same
gateway also listens on the LAN, so the mobile RN app connects to
`ws://<this-host-LAN-IP>:18789` — the mobile↔gateway contract is unchanged
(see repo memory `mobile_gateway_url_default_wrong.md`: the WS port is
**18789**, not the canonical-but-unused federation port 47913). Nothing about
Electron packaging changes how mobile finds the gateway; it's the same host,
same port, over the LAN.
