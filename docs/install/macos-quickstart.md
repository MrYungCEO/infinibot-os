---
summary: "Install InfiniBot on macOS with one command"
---

# macOS quickstart

## One-line install

Open Terminal (`Cmd + Space`, type "Terminal") and run:

```bash
curl -fsSL https://infinibotos.com/install.sh | bash
```

The installer:

- installs Node.js 22.12+ if it is missing (Homebrew when you have it, nvm otherwise)
- installs git with Homebrew if it is missing (without Homebrew it asks you to run `xcode-select --install`)
- runs `npm install -g infinibot@latest`
- opens the setup wizard (`infinibot onboard --install-daemon`)

The wizard asks for a model provider, a gateway password, optional channels, and whether to install the LaunchAgent so the gateway starts at login.

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
| LaunchAgent | `~/Library/LaunchAgents/com.infinibot.gateway.plist` |

## Verify

```bash
infinibot --version
infinibot status
infinibot doctor
```

## Run the gateway

```bash
infinibot gateway              # foreground, http://127.0.0.1:18789
infinibot dashboard            # open the dashboard in your browser
```

If you let the wizard install the LaunchAgent:

```bash
infinibot gateway status
infinibot gateway restart
infinibot gateway stop
```

## Troubleshooting

**`infinibot: command not found`**: npm's global bin directory is not on `PATH`.

```bash
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**`npm error spawn git ENOENT`**: run `xcode-select --install` (or `brew install git`) and retry. See [why git is needed](/install/installer#why-git-is-needed).

**`sharp` fails to build**: install with its prebuilt binaries.

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm i -g infinibot
```

## Next steps

- [Set up WhatsApp](../channels/whatsapp-quickstart.md)
- [Set up Telegram](../channels/telegram-quickstart.md)
- [Set up iMessage](../channels/imessage-quickstart.md)
- [Updating](/install/updating)
