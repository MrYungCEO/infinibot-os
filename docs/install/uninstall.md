---
summary: "Uninstall InfiniBot completely (CLI, service, state, workspace)"
read_when:
  - You want to remove InfiniBot from a machine
  - The gateway service is still running after uninstall
---

# Uninstall

Two paths:
- **Easy path** if `infinibot` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
infinibot uninstall
```

Non-interactive (automation / npx):

```bash
infinibot uninstall --all --yes --non-interactive
npx -y infinibot uninstall --all --yes --non-interactive
```

Manual steps (same result):

1) Stop the gateway service:

```bash
infinibot gateway stop
```

2) Uninstall the gateway service (launchd/systemd/schtasks):

```bash
infinibot gateway uninstall
```

3) Delete state + config:

```bash
rm -rf "${INFINIBOT_STATE_DIR:-$HOME/.infinibot}"
```

If you set `INFINIBOT_CONFIG_PATH` to a custom location outside the state dir, delete that file too.

4) Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/infinibot
```

5) Remove the CLI install (pick the one you used):

```bash
npm rm -g infinibot
pnpm remove -g infinibot
bun remove -g infinibot
```

6) If you installed the macOS app:

```bash
rm -rf /Applications/InfiniBot.app
```

Notes:
- If you used profiles (`--profile` / `INFINIBOT_PROFILE`), repeat step 3 for each state dir (defaults are `~/.infinibot-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `infinibot` is missing.

### macOS (launchd)

Default label is `com.infinibot.gateway` (or `com.infinibot.<profile>`):

```bash
launchctl bootout gui/$UID/com.infinibot.gateway
rm -f ~/Library/LaunchAgents/com.infinibot.gateway.plist
```

If you used a profile, replace the label and plist name with `com.infinibot.<profile>`.

### Linux (systemd user unit)

Default unit name is `infinibot-gateway.service` (or `infinibot-gateway-<profile>.service`):

```bash
systemctl --user disable --now infinibot-gateway.service
rm -f ~/.config/systemd/user/infinibot-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `InfiniBot Gateway` (or `InfiniBot Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "InfiniBot Gateway"
Remove-Item -Force "$env:USERPROFILE\.infinibot\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.infinibot-<profile>\gateway.cmd`.

## Normal install vs source checkout

### Normal install (install.sh / npm / pnpm / bun)

If you used `https://infinibotos.com/install.sh` or `install.ps1`, the CLI was installed with `npm install -g infinibot@latest`.
Remove it with `npm rm -g infinibot` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `infinibot ...` / `bun run infinibot ...`):

1) Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2) Delete the repo directory.
3) Remove state + workspace as shown above.
