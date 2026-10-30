---
summary: "Get InfiniBot: start on InfiniBot Cloud in your browser, or run it yourself free with the desktop app for Windows and Linux (SmartScreen and checksum help) or the npm package on Mac, Linux and Windows."
read_when:
  - Installing InfiniBot
  - Choosing between Cloud, the desktop app and npm
---

# Install

There are three ways to run InfiniBot. The fastest is **InfiniBot Cloud**: nothing to install, on any computer or phone. Prefer your own hardware? The desktop app and npm package are free. New to all this? Follow [Getting started](/docs/start/getting-started).

| Way | Best for | What you need |
| --- | --- | --- |
| **InfiniBot Cloud** | Most people: nothing to install, works on Mac, Windows, Linux and phones, always on from Pro | A browser. The Free plan (30 active min/day) needs no card; paid plans from $19/mo |
| **Desktop app** (run it yourself, free) | Your own Windows or Linux computer, local models | Windows 10/11 or a modern Linux, 64-bit, 8 GB RAM recommended |
| **npm package** (run it yourself, free) | People comfortable with a terminal, Mac users | Node.js 22.12 or newer |

## InfiniBot Cloud

[Start on InfiniBot Cloud](https://cloud.infinibotos.com/app/) and your private InfiniBot opens in the browser. The Free plan gives you 30 active minutes a day and needs no card. Paid cloud plans run from $19 to $199 a month; see [Cloud pricing](https://cloud.infinibotos.com/pricing).

## Run it yourself, free

The desktop app and the npm package run InfiniBot on your own computer, with no account needed.

## Desktop app (Windows and Linux)

Download the current release (v2026.10.18) from the [download page](/download). Installed apps update themselves when a new release ships. macOS: coming soon.

### Windows

1. Download `InfiniBot-Setup-x64.exe` and open it.
2. Windows may show a blue **"Windows protected your PC"** screen. Click **More info**, then **Run anyway**. This happens because InfiniBot is a new app that isn't code-signed yet, not because anything is wrong. Want to double-check? Compare the file's SHA-256 with the checksum on the [download page](/download#verify) (PowerShell: `Get-FileHash .\InfiniBot-Setup-x64.exe`).
3. Finish the installer and open **InfiniBot** from the Start menu.

Upgrading from 2026.10.17 or earlier on Windows? Run the new installer once. Your data is kept, and from 2026.10.18 on, updates install automatically.

![Illustration of step 1: the blue Windows SmartScreen dialog titled "Windows protected your PC", with a gold circle and arrow pointing at the "More info" link](/assets/download/smartscreen-step1-1000.webp)

![Illustration of step 2: the expanded SmartScreen dialog showing "App: InfiniBot-Setup-x64.exe" and "Publisher: Unknown publisher", with a gold circle and arrow pointing at "Run anyway"](/assets/download/smartscreen-step2-1000.webp)

*Illustration — a reproduction of the Windows SmartScreen dialog, not a screenshot.* Full walkthrough: [Windows guide](/docs/windows).

### Linux

- **AppImage** (any modern distro): `chmod +x InfiniBot-x86_64.AppImage && ./InfiniBot-x86_64.AppImage`. If it complains about FUSE, install `libfuse2` (Ubuntu 24.04+: `libfuse2t64`) or run it with `--appimage-extract-and-run`.
- **.deb** (Debian, Ubuntu 22.04+): `sudo apt install ./infinibot_amd64.deb`, then open InfiniBot from your app menu.

### Check the checksum (optional)

A checksum is a fingerprint of the file. If yours matches the published one, the file is exactly what we released. The current values are on the [download page](/download#verify) and in [SHA256SUMS](/download/SHA256SUMS).

Windows (PowerShell, in your Downloads folder):

```powershell
cd $HOME\Downloads
Get-FileHash .\InfiniBot-Setup-x64.exe
```

Compare the **Hash** it prints with the Windows line on the download page (upper or lower case doesn't matter).

Linux:

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

### First launch

A brand-new install asks where to keep your data, then opens the 8-step setup: your goals, AI brain, channels, voice, phone, privacy, your plan, finish. Every step is explained in [Getting started](/docs/start/getting-started#3-the-8-step-setup).

## npm package (Mac, Linux, Windows)

You need [Node.js](https://nodejs.org/) 22.12 or newer. Then:

```bash
npm i -g infinibot
infinibot quickstart
```

`infinibot quickstart` opens a guided setup in your browser. You can also use the one-line installers, which check for npm, install the `infinibot` package and run `infinibot quickstart`:

```bash
# macOS / Linux
curl -fsSL https://infinibotos.com/install.sh | bash
```

```powershell
# Windows (PowerShell)
iwr https://infinibotos.com/install.ps1 | iex
```

Useful commands after installing:

- `infinibot onboard` runs the guided setup again.
- `infinibot dashboard` opens the app in your browser.
- `infinibot status` and `infinibot health` check that the gateway is running.
- `infinibot doctor` finds and fixes common problems.

More: [CLI quickstart](/docs/cli/quickstart) and the [CLI reference](/docs/cli).

## Troubleshooting: `infinibot` not found

If your terminal says `infinibot: command not found` after `npm i -g infinibot`, your shell can't see npm's global folder.

```bash
npm prefix -g
echo "$PATH"
```

If `$(npm prefix -g)/bin` (macOS/Linux) or `$(npm prefix -g)` (Windows) isn't in your `PATH`, add it. For zsh or bash:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Then open a new terminal.

If `sharp` fails to install on macOS (common with Homebrew's libvips), use prebuilt binaries:

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm i -g infinibot
```

## Update and uninstall

- **Desktop app:** updates install automatically (on Windows, from 2026.10.18 on; older Windows installs run the new installer once). Uninstall it like any other app (Windows: Settings → Apps; Linux: delete the AppImage, or remove the InfiniBot package with your package manager).
- **npm:** `npm i -g infinibot@latest` to update, `npm rm -g infinibot` to remove.
