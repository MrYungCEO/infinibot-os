---
summary: "InfiniBot on Windows: the desktop installer, the SmartScreen 'Windows protected your PC' screen, checking the SHA-256, and running the CLI natively or in WSL2."
read_when:
  - Installing InfiniBot on Windows
  - Windows shows "Windows protected your PC"
---
# Windows

The easiest way to run InfiniBot on Windows 10 or 11 is the **desktop app**. Download `InfiniBot-Setup-x64.exe` from the [download page](/download) (64-bit, current release v2026.10.18). From 2026.10.18 on, it updates itself when a new release ships.

**Upgrading from 2026.10.17 or earlier?** Those versions download the update but can't install it themselves. Run the new installer from the [download page](/download) once. Your data is kept.

Prefer not to install anything? [Try InfiniBot Cloud in your browser](https://cloud.infinibotos.com). The Free plan needs no card.

## Install the desktop app

1. Open `InfiniBot-Setup-x64.exe` from your Downloads folder. If your browser says the file isn't commonly downloaded, choose **Keep**.
2. Windows may show a blue **"Windows protected your PC"** screen. Click **More info**, then **Run anyway**. This happens because InfiniBot is a new app that isn't code-signed yet, not because anything is wrong. Want to double-check? Compare the file's SHA-256 with the checksum on the [download page](/download#verify) (PowerShell: `Get-FileHash .\InfiniBot-Setup-x64.exe`).
3. Finish the installer and open **InfiniBot** from the Start menu or the desktop shortcut.
4. The first time it opens, pick where to keep your data, then follow the 8-step setup. See [Getting started](/start/getting-started).

## The "Windows protected your PC" screen

Step 1: on the first screen, click the small **More info** link under the message. Don't press "Don't run".

![Illustration of step 1: the blue Windows SmartScreen dialog titled "Windows protected your PC". It says Microsoft Defender SmartScreen prevented an unrecognized app from starting. A gold circle and arrow point at the "More info" link; the only button is "Don't run"](/assets/download/smartscreen-step1-1000.webp)

Step 2: the screen now shows **App: InfiniBot-Setup-x64.exe** and **Publisher: Unknown publisher** ("Unknown publisher" is expected for now). Click **Run anyway**.

![Illustration of step 2: the expanded SmartScreen dialog showing "App: InfiniBot-Setup-x64.exe" and "Publisher: Unknown publisher", with a gold circle and arrow pointing at the "Run anyway" button next to "Don't run"](/assets/download/smartscreen-step2-1000.webp)

*Illustration — a reproduction of the Windows SmartScreen dialog, not a screenshot.*

Why it happens: SmartScreen warns about apps that aren't code-signed yet or haven't been downloaded many times. InfiniBot is a new app and its installer isn't signed yet. You usually see the screen only once, the first time you open the installer.

## Check the SHA-256 checksum

A checksum is a fingerprint of the file. If the fingerprint of your download matches the published one, the file is exactly what we released.

1. Open the **Start** menu, type **PowerShell** and open it.
2. Go to your Downloads folder and print the fingerprint:

   ```powershell
   cd $HOME\Downloads
   Get-FileHash .\InfiniBot-Setup-x64.exe
   ```

3. Compare the **Hash** it prints with the `InfiniBot-Setup-x64.exe` line on the [download page](/download#verify) or in [SHA256SUMS](/download/SHA256SUMS). Upper or lower case doesn't matter. To let PowerShell compare for you, paste the published value between the quotes; it prints `True` when they match:

   ```powershell
   (Get-FileHash .\InfiniBot-Setup-x64.exe).Hash -eq "PASTE-THE-PUBLISHED-SHA-256-HERE"
   ```

## Command line on Windows (optional)

You don't need this for the desktop app. If you prefer a terminal, install [Node.js](https://nodejs.org/) 22.12 or newer and run this in PowerShell:

```powershell
iwr https://infinibotos.com/install.ps1 | iex
```

It installs the `infinibot` npm package and runs `infinibot quickstart`. The same package also runs inside WSL2 (Ubuntu), which some tools and skills that expect Linux prefer; see the WSL2 steps below.

## WSL2 (advanced)

### 1) Install WSL2 + Ubuntu

Open PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Reboot if Windows asks.

### 2) Enable systemd (required for gateway install)

In your WSL terminal:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Then from PowerShell:

```powershell
wsl --shutdown
```

Re-open Ubuntu, then verify:

```bash
systemctl --user status
```

### 3) Install InfiniBot (inside WSL)

Install Node.js 22.12 or newer inside WSL, then:

```bash
npm i -g infinibot
infinibot onboard --install-daemon
```

More install options: [Install](/install)


## Advanced: expose WSL services over LAN (portproxy)

WSL has its own virtual network. If another machine needs to reach a service
running **inside WSL** (SSH, a local TTS server, or the Gateway), you must
forward a Windows port to the current WSL IP. The WSL IP changes after restarts,
so you may need to refresh the forwarding rule.

Example (PowerShell **as Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Allow the port through Windows Firewall (one-time):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Refresh the portproxy after WSL restarts:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Notes:
- SSH from another machine targets the **Windows host IP** (example: `ssh user@windows-host -p 2222`).
- Remote nodes must point at a **reachable** Gateway URL (not `127.0.0.1`); use
  `infinibot status --all` to confirm.
- Use `listenaddress=0.0.0.0` for LAN access; `127.0.0.1` keeps it local only.
- If you want this automatic, register a Scheduled Task to run the refresh
  step at login.

