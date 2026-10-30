# Desktop release (Windows + Linux from a Linux host)

The desktop app embeds the gateway. Electron spawns `resources/app/dist/entry.js gateway run` through
`launcher.js` with `ELECTRON_RUN_AS_NODE=1` and opens its UI in the window. The first-run wizard writes
the config with `infinibot onboard --non-interactive`.

```bash
export PATH=~/.nvm/versions/node/v22.23.1/bin:$PATH          # Node >= 22.12
pnpm install --frozen-lockfile && pnpm build && pnpm ui:build
(cd electron && NODE_ENV=development npm install --include=dev)
V=2026.10.8; EV=$(node -p "require('./electron/node_modules/electron/package.json').version")
# Per-target PRODUCTION bundle with that OS's native modules (better-sqlite3 for Electron's ABI, etc.)
node scripts/desktop/stage-bundle.mjs --platform linux --out /work/stage-linux --version $V --electron $EV
node scripts/desktop/stage-bundle.mjs --platform win32 --out /work/stage-win   --version $V --electron $EV
cd electron
IB_DESKTOP_STAGE=/work/stage-linux IB_DESKTOP_OUT=/work/out-linux \
  npx electron-builder --config electron-builder.release.cjs --linux --publish never
WINEPREFIX=/work/wineprefix IB_DESKTOP_STAGE=/work/stage-win IB_DESKTOP_OUT=/work/out-win \
  npx electron-builder --config electron-builder.release.cjs --win --x64 --publish never
```

Then re-pack the AppImage for Ubuntu 22.04+/24.04 (static type-2 runtime, no libfuse2; sandbox-probing
`build/appimage/AppRun`; rewrites the sha512/size in `latest-linux.yml`). Needs squashfs-tools:

```bash
node electron/scripts/appimage-finalize.mjs /work/out-linux/InfiniBot-x86_64.AppImage
```

The .deb maintainer scripts (`build/deb/postinst.sh`) set chrome-sandbox to root:root 4755 and install an
AppArmor `userns` profile, so the .deb runs with the full sandbox on Ubuntu 24.04. Both fixes come from
Robovoice Desktop.

Outputs: `InfiniBot-Setup-x64.exe`, `InfiniBot-x86_64.AppImage` and `infinibot_amd64.deb`
(version-less names), plus `latest.yml` and `latest-linux.yml`. Run `sha256sum` to make `SHA256SUMS`.
Delete `*-unpacked/` and the stage dirs afterwards (about 1 GB each).

Publish with `scripts/desktop/publish-github-release.sh <dir> <version>`. It targets the public
`MrYungCEO/infinibot-desktop-releases` repo, because the source repo is private. The infinibotos.com `/download/*`
redirects point to `releases/latest/download/<name>`, so the page needs no edits when a new version ships.
The only thing to update is the inline `#desktop-release` JSON in `docs/download.html`: the page also
reads sizes and digests from the GitHub API when it can reach it.

First launch with an existing `~/.infinibot` (an npm install) asks before using it, or creates a separate
profile in `~/.infinibot-desktop`. A fresh setup takes 18789 only when it's free and otherwise uses the next free
port. A healthy gateway on the configured port is adopted only when it serves the same state dir (checked via
/proc on Linux). A gateway for a different profile is never adopted or killed.

Testing on a dev box that runs a live gateway: launch under `env -i` with temp `HOME`,
`INFINIBOT_STATE_DIR` (under /tmp, which makes the wizard use port 28789) **and `TMUX_TMPDIR`**. The tmux
server is shared per UID, and its sessions inherit the live environment. Never run the wizard flow under
Wine with a `Z:\tmp` state dir: the sandbox-port guard won't recognise it, so it falls back to :18789 and
adopts the live gateway.

Browser Relay extension: the unpacked folder ships at `resources/app/assets/chrome-extension/` and
stage-bundle adds `assets/infinibot-browser-relay.zip`. The gateway finds it via `INFINIBOT_REPO_ROOT`
(set by launcher.js), never via cwd (the gateway's cwd is the state dir), and copies it to
a user-VISIBLE folder for Chrome's "Load unpacked" (dot folders and AppData are hidden in the picker): Linux `~/InfiniBot/browser-extension`, macOS `~/InfiniBot/Browser Extension`, Windows `%USERPROFILE%\Documents\InfiniBot\browser-extension` (src/browser/extension-assets.ts). The old hidden `<state dir>/browser/chrome-extension` copy is kept in sync for existing installs. Optional `INFINIBOT_CHROME_WEBSTORE_URL` surfaces "Install from Chrome Web Store" first.
Check a build with `7za l InfiniBot-Setup-x64.exe | grep chrome-extension`.

Branding: Windows file properties come from `electron/package.json` (`description` = FileDescription,
`build.copyright`, `author.name` = CompanyName); NSIS art is `build/installer*.bmp` + `assets/icon.ico`;
Linux icons are `build/icons/` (all the InfiniBot infinity-globe mark). Also upload a versioned copy of
the installer (`InfiniBot-Setup-<version>.exe`) next to the version-less one.

Unsigned: SmartScreen shows "Windows protected your PC" (More info → Run anyway). Signing env vars are in
SIGNING.md.
