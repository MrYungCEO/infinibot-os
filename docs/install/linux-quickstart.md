---
summary: "Install InfiniBot on Linux with one command"
---

# Linux quickstart

## One-line install

```bash
curl -fsSL https://infinibotos.com/install.sh | bash
```

The installer:

- installs Node.js 22.12+ and git if they are missing (NodeSource on Debian/Ubuntu and Fedora/RHEL, pacman on Arch, nvm elsewhere)
- switches npm to a user-writable prefix (`~/.npm-global`) when the system one needs root
- runs `npm install -g infinibot@latest`
- opens the setup wizard (`infinibot onboard --install-daemon`)

Flags and internals: [Installer internals](/install/installer).

## With npm

If you already have Node 22.12+ and git:

```bash
npm i -g infinibot && infinibot onboard
```

Or run it once without installing:

```bash
npx -y infinibot@latest onboard
```

Prefer a browser to a terminal wizard? `infinibot quickstart` opens the same setup as a web page on `http://127.0.0.1:18790`.

## Where things live

| What | Location |
|------|----------|
| Config | `~/.infinibot/infinibot.json` |
| Credentials | `~/.infinibot/credentials/` |
| Logs | `~/.infinibot/logs/` |
| Workspace | `~/infinibot/` |
| systemd unit | `~/.config/systemd/user/infinibot-gateway.service` |

## Verify

```bash
infinibot --version
infinibot status
infinibot doctor
```

## Run the gateway

```bash
infinibot gateway              # foreground, http://127.0.0.1:18789
```

If you let the wizard install the service:

```bash
systemctl --user status infinibot-gateway
journalctl --user -u infinibot-gateway -f
loginctl enable-linger "$USER"     # keep it running after you log out
```

## Headless server

```bash
curl -fsSL https://infinibotos.com/install.sh | bash -s -- --no-onboard

infinibot onboard --non-interactive --accept-risk --skip-health \
  --gateway-auth password --gateway-password "your-strong-password" \
  --anthropic-api-key "sk-ant-..."     # or --openrouter-api-key / --openai-api-key / ...
```

To reach the dashboard from another machine, start the gateway with `--bind lan` (or `--bind tailnet`) and keep password auth on.

## Troubleshooting

**`infinibot: command not found`**: npm's global bin directory is not on `PATH`.

```bash
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

**`EACCES: permission denied` from `npm install -g`**: do not use `sudo`. Give npm a user prefix:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
npm i -g infinibot
```

**`npm error spawn git ENOENT`**: install git (`sudo apt-get install -y git`) and retry. See [why git is needed](/install/installer#why-git-is-needed).

## Docker

There is no published image yet. Build one from a source checkout: [Docker](/install/docker).

## Next steps

- [Set up WhatsApp](../channels/whatsapp-quickstart.md)
- [Set up Telegram](../channels/telegram-quickstart.md)
- [Updating](/install/updating)
