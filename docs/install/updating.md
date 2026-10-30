---
summary: "Updating InfiniBot safely (global install or source), plus rollback strategy"
read_when:
  - Updating InfiniBot
  - Something breaks after an update
---

# Updating

InfiniBot is moving fast (pre “1.0”). Treat updates like shipping infra: update → run checks → restart (or use `infinibot update`, which restarts) → verify.

## Recommended: `infinibot update`

```bash
infinibot update
```

It installs the latest npm release, runs `infinibot doctor`, and restarts the gateway service. Useful flags: `--tag <version>` to pin, `--no-restart`, `--yes` for scripts.

Equivalent by hand:

```bash
npm i -g infinibot@latest
infinibot doctor
infinibot gateway restart
```

Re-running the installer also upgrades in place (add `--no-onboard` so the wizard does not run again):

```bash
curl -fsSL https://infinibotos.com/install.sh | bash -s -- --no-onboard
```

```powershell
$env:INFINIBOT_NO_ONBOARD = "1"; iwr -useb https://infinibotos.com/install.ps1 | iex
```

Source checkouts update with `git pull --ff-only && pnpm install && pnpm build:all`.

## Before you update

- Know how you installed: **global** (npm/pnpm) vs **from source** (git clone).
- Know how your Gateway is running: **foreground terminal** vs **supervised service** (launchd/systemd).
- Snapshot your tailoring:
  - Config: `~/.infinibot/infinibot.json`
  - Credentials: `~/.infinibot/credentials/`
  - Workspace: `~/infinibot`

## Update (global install)

Global install (pick one):

```bash
npm i -g infinibot@latest
```

```bash
pnpm add -g infinibot@latest
```
We do **not** recommend Bun for the Gateway runtime (WhatsApp/Telegram bugs).

To switch update channels (git + npm installs):

```bash
infinibot update --channel beta
infinibot update --channel dev
infinibot update --channel stable
```

Use `--tag <dist-tag|version>` for a one-off install tag/version.

See [Development channels](/install/development-channels) for channel semantics and release notes.

Note: on npm installs, the gateway logs an update hint on startup (checks the current channel tag). Disable via `update.checkOnStart: false`.

Then:

```bash
infinibot doctor
infinibot gateway restart
infinibot health
```

Notes:
- If your Gateway runs as a service, `infinibot gateway restart` is preferred over killing PIDs.
- If you’re pinned to a specific version, see “Rollback / pinning” below.

## Update (`infinibot update`)

For **source installs** (git checkout), prefer:

```bash
infinibot update
```

It runs a safe-ish update flow:
- Requires a clean worktree.
- Switches to the selected channel (tag or branch).
- Fetches + rebases against the configured upstream (dev channel).
- Installs deps, builds, builds the Control UI, and runs `infinibot doctor`.
- Restarts the gateway by default (use `--no-restart` to skip).

If you installed via **npm/pnpm** (no git metadata), `infinibot update` will try to update via your package manager. If it can’t detect the install, use “Update (global install)” instead.

## Update (Control UI / RPC)

The Control UI has **Update & Restart** (RPC: `update.run`). It:
1) Runs the same source-update flow as `infinibot update` (git checkout only).
2) Writes a restart sentinel with a structured report (stdout/stderr tail).
3) Restarts the gateway and pings the last active session with the report.

If the rebase fails, the gateway aborts and restarts without applying the update.

## Update (from source)

From the repo checkout:

Preferred:

```bash
infinibot update
```

Manual (equivalent-ish):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
infinibot doctor
infinibot health
```

Notes:
- `pnpm build` matters when you run the packaged `infinibot` binary ([`dist/entry.js`](https://github.com/MrYungCEO/infinibot-os/blob/main/dist/entry.js)) or use Node to run `dist/`.
- If you run from a repo checkout without a global install, use `pnpm infinibot ...` for CLI commands.
- If you run directly from TypeScript (`pnpm infinibot ...`), a rebuild is usually unnecessary, but **config migrations still apply** → run doctor.
- Switching between global and git installs is easy: install the other flavor, then run `infinibot doctor` so the gateway service entrypoint is rewritten to the current install.

## Always Run: `infinibot doctor`

Doctor is the “safe update” command. It’s intentionally boring: repair + migrate + warn.

Note: if you’re on a **source install** (git checkout), `infinibot doctor` will offer to run `infinibot update` first.

Typical things it does:
- Migrate deprecated config keys / legacy config file locations.
- Audit DM policies and warn on risky “open” settings.
- Check Gateway health and can offer to restart.
- Detect and migrate older gateway services (launchd/systemd; legacy schtasks) to current InfiniBot services.
- On Linux, ensure systemd user lingering (so the Gateway survives logout).

Details: [Doctor](/gateway/doctor)

## Start / stop / restart the Gateway

CLI (works regardless of OS):

```bash
infinibot gateway status
infinibot gateway stop
infinibot gateway restart
infinibot gateway --port 18789
infinibot logs --follow
```

If you’re supervised:
- macOS launchd (app-bundled LaunchAgent): `launchctl kickstart -k gui/$UID/com.infinibot.gateway` (use `com.infinibot.<profile>` if set)
- Linux systemd user service: `systemctl --user restart infinibot-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart infinibot-gateway[-<profile>].service`
  - `launchctl`/`systemctl` only work if the service is installed; otherwise run `infinibot gateway install`.

Runbook + exact service labels: [Gateway runbook](/gateway)

## Rollback / pinning (when something breaks)

### Pin (global install)

Install a known-good version (replace `<version>` with the last working one):

```bash
npm i -g infinibot@<version>
```

```bash
pnpm add -g infinibot@<version>
```

Tip: to see the current published version, run `npm view infinibot version`.

Then restart + re-run doctor:

```bash
infinibot doctor
infinibot gateway restart
```

### Pin (source) by date

Pick a commit from a date (example: “state of main as of 2026-01-01”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Then reinstall deps + restart:

```bash
pnpm install
pnpm build
infinibot gateway restart
```

If you want to go back to latest later:

```bash
git checkout main
git pull
```

## If you’re stuck

- Run `infinibot doctor` again and read the output carefully (it often tells you the fix).
- Check: [Troubleshooting](/gateway/troubleshooting)
- Ask in Discord: https://channels.discord.gg/clawd
