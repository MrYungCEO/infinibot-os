# Privacy

InfiniBot is self-hosted software. It runs on your own machines, and your
conversations, memory, notes, projects and settings are stored locally in your
state directory (`~/.infinibot` by default, or `$INFINIBOT_STATE_DIR`).

**InfiniBot has no third-party analytics or telemetry.** It does not include
analytics SDKs (no PostHog, Sentry, Mixpanel, Amplitude, Plausible or Google
Analytics), and the project maintainers do not receive any usage data from your
install.

This page lists every outbound network call InfiniBot makes on its own, so you
can see what leaves your machine and how to turn it off.

<!-- OWNER: re-check this list before each release; any new built-in outbound call must be added here. -->

## Calls you configure

These happen only because you connected a service. Your data goes directly
from your machine to that service, under that service's privacy policy:

- **Model providers** (Anthropic, OpenAI, OpenRouter, Groq, Google and others):
  prompts, conversation context and tool results are sent to the provider you
  pick for each agent. Local models (for example Ollama) stay on your network.
- **Chat channels** (WhatsApp, Telegram, Discord, Slack, Signal, iMessage and
  plugin channels): messages are sent and received through the channel you
  link.
- **Voice** (speech-to-text and text-to-speech providers such as ElevenLabs or
  OpenAI, or local engines): audio and text go to the engine you pick.
- **Integrations** (Notion, Gmail, GitHub, Whop, Stripe, Square, MCP servers,
  web search and others): only when you add credentials for them.
- **Federation**: when you pair satellites, the gateways talk to each other
  directly (optionally over Tailscale).

## Built-in outbound calls

| What | Destination | When | How to turn it off |
| --- | --- | --- | --- |
| Update check | `registry.npmjs.org` (the `infinibot` package) | At gateway start, at most once every 24 hours | Set `update.checkOnStart: false` in `~/.infinibot/infinibot.json` |
| In-app updater | `registry.npmjs.org` | Only when you open the updater or click update | Don't use it |
| Desktop app updater (Electron) | GitHub Releases of `MrYungCEO/infinibot-desktop-releases` | On launch of the packaged desktop app | Use the CLI/npm install instead of the desktop app |
| Voice packs (optional local voice models) | `cdn.infinibot.app/voice-packs/`, or the URL in `INFINIBOT_VOICE_PACK_BASE` | Only when you install a voice pack | Don't install voice packs, or point `INFINIBOT_VOICE_PACK_BASE` at your own mirror |
| Web fonts | `fonts.googleapis.com`, `fonts.gstatic.com` | When the Control UI or `setup.html` loads in your browser | Block these hosts; the UI falls back to system fonts |
| KinglyVault (plugin purchases) | `kinglyvault.com`, or the URL in `INFINIBOT_VAULT_URL` / `KINGLYVAULT_BASE_URL` | When you buy or restore a paid plugin on the Plugins page. Once your KinglyVault account is connected, the gateway re-checks your purchases about every 12 hours | Don't connect KinglyVault (free plugins never need it), or press Disconnect on Plugins › Purchases. Paid plugins lock while disconnected |

The update check sends a normal HTTPS request for public package metadata. It
does not include any identifier for you or your install.

## Local-only data

- **License funnel log.** `license-telemetry.jsonl` in your state directory
  records upgrade-prompt events locally (rotated at 5 MB). It is **never sent
  anywhere**. You can delete it at any time.
- **Logs, sessions, memory and databases** all stay in your state directory.
  Delete the directory to remove everything.

## Reporting a privacy issue

If InfiniBot sends data somewhere that isn't listed here, please treat it as a
security issue and report it privately as described in
[SECURITY.md](SECURITY.md).
