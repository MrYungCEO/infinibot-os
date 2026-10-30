---
summary: "Install InfiniBot on Windows with one command"
---

# Windows quickstart

Two ways to run InfiniBot on Windows: the desktop app (no terminal) from [infinibotos.com/download](https://infinibotos.com/download), or the CLI below.

## One-line install

Open PowerShell (`Win + X`, then **Terminal** or **Windows PowerShell**) and run:

```powershell
iwr -useb https://infinibotos.com/install.ps1 | iex
```

The installer:

- installs Node.js 22.12+ and Git if they are missing (winget, then Chocolatey, then Scoop)
- runs `npm install -g infinibot@latest`
- adds npm's global directory to your user `PATH` if needed
- opens the setup wizard (`infinibot onboard --install-daemon`)

An administrator window is only needed if winget has to install Node.js or Git machine-wide.

Flags and internals: [Installer internals](/install/installer).

## With npm

If you already have Node 22.12+ and Git:

```powershell
npm i -g infinibot; infinibot onboard
```

Or run it once without installing:

```powershell
npx -y infinibot@latest onboard
```

`&&` works in PowerShell 7 and in `cmd.exe`; Windows PowerShell 5.1 needs `;` as shown.

Prefer a browser to a terminal wizard? `infinibot quickstart` opens the same setup as a web page on `http://127.0.0.1:18790`.

## Where things live

| What | Location |
|------|----------|
| Config | `%USERPROFILE%\.infinibot\infinibot.json` |
| Credentials | `%USERPROFILE%\.infinibot\credentials\` |
| Logs | `%USERPROFILE%\.infinibot\logs\` |
| Workspace | `%USERPROFILE%\infinibot\` |

## Verify

```powershell
infinibot --version
infinibot status
infinibot doctor
```

## Run the gateway

```powershell
infinibot gateway              # foreground, http://127.0.0.1:18789
infinibot dashboard            # open the dashboard in your browser
```

If you let the wizard install the background task:

```powershell
infinibot gateway status
infinibot gateway restart
infinibot gateway stop
```

## Troubleshooting

**`infinibot` is not recognized**: open a new PowerShell window. If it still fails, run `npm config get prefix` and add that directory to your user `PATH`.

**`npm error spawn git ENOENT`**: Git is missing. See [why git is needed](/install/installer#why-git-is-needed).

```powershell
winget install --id Git.Git -e
```

**Node.js is too old**:

```powershell
winget upgrade --id OpenJS.NodeJS.LTS -e
```

**Running scripts is disabled on this system**: allow signed local scripts for your user, then re-run.

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## Next steps

- [Set up WhatsApp](../channels/whatsapp-quickstart.md)
- [Set up Telegram](../channels/telegram-quickstart.md)
- [Set up Discord](../channels/discord-quickstart.md)
- [Updating](/install/updating)
