# InfiniBot OS — Quick Start

**Goal: a running InfiniBot gateway on your machine in under 5 minutes.**

No account is needed. A self-hosted InfiniBot has no sign-in, no plan limits and no message caps. Bring your own model key, or run a local model with Ollama.

---

## Fastest path: install the npm package

| Platform | One-liner |
|---|---|
| macOS / Linux / WSL | `curl -fsSL https://infinibotos.com/install.sh \| bash` |
| Windows (PowerShell) | `iwr -useb https://infinibotos.com/install.ps1 \| iex` |
| Any OS with Node 22.12+ and git | `npm i -g infinibot && infinibot onboard` |
| Try without installing | `npx -y infinibot@latest onboard` |

Each one installs the `infinibot` npm package and opens the setup wizard (model provider + gateway password). The scripts add Node.js and git if they are missing. Then start it:

```bash
infinibot gateway        # → http://127.0.0.1:18789
```

Prefer a browser to a terminal wizard? Run `infinibot quickstart` instead of `infinibot onboard`. Installer flags (`--no-onboard`, `--version`, `--dry-run`) and hosting are covered in [Installer internals](install/installer.md).

| | macOS / Linux | Windows |
|---|---|---|
| CLI | npm global prefix (`npm prefix -g`) | npm global prefix |
| State (config, sessions, keys) | `~/.infinibot` | `%USERPROFILE%\.infinibot` |
| Agent workspace | `~/infinibot` | `%USERPROFILE%\infinibot` |

The steps below build from a source checkout instead (for development, or to run unreleased code).

---

## 0 · One-time prerequisites

| Requirement | Why | Install |
|---|---|---|
| Node.js **22.12+** | Runs the gateway (the repo's `.nvmrc` pins 22) | <https://nodejs.org/> or `nvm install 22` |
| `pnpm` | Package manager; the lockfile is pnpm's | `corepack enable` (ships with Node) or `npm i -g pnpm` |
| `git` | Clone the repo | <https://git-scm.com/> |

---

## 1 · Install from a clone

```bash
git clone https://github.com/MrYungCEO/infinibot-os.git
cd InfiniBot
pnpm install            # exact versions from pnpm-lock.yaml
pnpm build:all          # backend (dist/) + control UI (dist/control-ui)
pnpm infinibot onboard  # model provider + gateway password
pnpm infinibot gateway  # → http://127.0.0.1:18789
```

Open <http://127.0.0.1:18789> and log in with the gateway password you picked during onboarding.

`scripts/satellite-setup.sh` (macOS/Linux) and `scripts/satellite-setup.ps1` (Windows) run the Node/pnpm checks plus the install and build for you. They never change your git remotes or branches. `--update` / `-Update` fast-forwards first, and skips that when you have local changes.

> **Windows:** clone outside OneDrive (OneDrive sync corrupts `node_modules`).

---

## 2 · Onboarding without prompts / Docker

Non-interactive onboarding (CI, servers):

```bash
# npm install: drop the `pnpm` prefix
pnpm infinibot onboard --non-interactive --accept-risk --skip-daemon --skip-health \
  --gateway-auth password --gateway-password "your-strong-password" \
  --anthropic-api-key "sk-ant-..."     # or --openrouter-api-key / --openai-api-key / ...
```

Docker (no onboarding needed to boot; the password is the only required setting):

```bash
export INFINIBOT_GATEWAY_PASSWORD="your-strong-password"
docker compose build && docker compose up -d infinibot-gateway
```

The first browser login asks for device pairing. Approve it once with `docker compose exec infinibot-gateway node dist/index.js devices list`, then `… devices approve <request-id>`, and reload.

Add `pnpm link --global` once in the repo if you want a plain `infinibot` command instead of `pnpm infinibot`.

---

## 3 · Verify the install

```bash
infinibot status     # Gateway up? Auth wired? Daemon registered?
infinibot doctor     # Full diagnostic — points at anything misconfigured
```

If `infinibot` isn't on your PATH yet:

- **macOS/Linux:** `export PATH="$PATH:$(npm prefix -g)/bin"` (add to `~/.zshrc` / `~/.bashrc`)
- **Windows:** the installer adds the npm global prefix to your user PATH; open a fresh PowerShell window

---

## 4 · Add a satellite (second device on the same network)

Once the master device is running with `--master-mode`, the satellite gets paired through the dashboard:

1. On the **master**, open the dashboard → **Federation → Add Satellite Node**.
2. Run the one-liner from [§1](#1--install-one-liner) on the satellite.
3. Walk through the wizard — when it asks for the master, hit **⊕ Scan LAN** (mDNS discovery) or paste the master URL.
4. The wizard writes `infinibot.json` to the satellite's config directory:

   | OS | Config path |
   |---|---|
   | macOS / Linux | `~/.infinibot/infinibot.json` |
   | Windows | `%USERPROFILE%\.infinibot\infinibot.json` |

5. Start the satellite gateway — it auto-connects:

   ```bash
   bun start gateway
   # [FEDERATION] satellite mode, connecting to ws://192.168.1.10:47913/federation
   # [FEDERATION] connected to master as node-<uuid>
   ```

Full walkthrough with troubleshooting: [`docs/federation/satellite-setup.md`](./federation/satellite-setup.md).

---

## 5 · Connect messaging channels (optional)

After install, hook InfiniBot up to whichever channels you live on:

| Platform | Difficulty | Setup time |
|---|---|---|
| [Telegram](channels/telegram-quickstart.md) | Easy | 3 min |
| [WhatsApp](channels/whatsapp-quickstart.md) | Easy | 2 min |
| [Discord](channels/discord-quickstart.md) | Medium | 5 min |
| [Slack](channels/slack-quickstart.md) | Medium | 10 min |
| [Signal](channels/signal-quickstart.md) | Medium | 5 min |
| [iMessage](channels/imessage-quickstart.md) | macOS only | 5 min |

---

## 6 · Mobile companion

Pair the React Native app (Expo Go QR or personal EAS build):

[Mobile node setup →](nodes/mobile-quickstart.md)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `gh: command not found` | Install <https://cli.github.com/> first |
| `Permission denied` / 404 from `gh api` | Run `gh auth login` again; confirm `gh auth status` shows the right account |
| `git clone` prompts for password | You forgot `gh auth setup-git` — run it, then retry |
| `unknown method: ...` on first request | Restart the gateway after install so the methods registry rebuilds |
| Login screen rejects password | Stop, restart with `--password "<your-password>"` — passwords aren't read from `.env` |
| Satellite won't pair | Check master is `--master-mode`, both devices on same LAN, same gateway version |
| **Anything else** | `infinibot doctor` runs every diagnostic and tells you what's wrong |

---

## What's next?

- [`docs/index.md`](./index.md) — full feature index (~20 surfaces)
- [`setup.html`](../setup.html) — friendly one-page setup with copy buttons (open in a browser)
- `/learn` (in-app) — 19 interactive walkthroughs + Master certification
- [`docs/federation/satellite-setup.md`](./federation/satellite-setup.md) — multi-device topology
