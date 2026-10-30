---
summary: "Top-level overview of InfiniBot, features, and where to start"
read_when:
  - Introducing InfiniBot to newcomers
---
# InfiniBot

<p align="center">
  <strong>A self-hosted personal AI assistant: one gateway for your chat channels, models, agents and devices.</strong><br />
  Runs on your own machine. Your data stays in your state directory.
</p>

<p align="center">
  <a href="https://github.com/MrYungCEO/infinibot-os">GitHub</a> ·
  <a href="https://github.com/MrYungCEO/infinibot-os/releases">Releases</a> ·
  <a href="/QUICKSTART">Quickstart</a> ·
  <a href="/help/faq">FAQ</a>
</p>

InfiniBot runs a single long-running **gateway** process that connects chat
channels (WhatsApp, Telegram, Discord, Slack, Signal, iMessage and more through
plugins) and model providers (Anthropic, OpenAI, OpenRouter, local Ollama and
others) to a set of agents. You control it from a browser **Control UI**, the
CLI, or the desktop and mobile apps.

## Start here

- **Install:** [Quickstart](/QUICKSTART), or [Getting Started](/start/getting-started) for a full walkthrough
- **Guided setup:** [Wizard](/start/wizard) (`infinibot onboard`)
- **Open the dashboard (local gateway):** [http://127.0.0.1:18789/](http://127.0.0.1:18789/)
- **Why InfiniBot:** [Why InfiniBot](/why-infinibot): architecture, surface area and trade-offs
- **Something broken?** [FAQ](/help/faq), [Troubleshooting](/gateway/troubleshooting), or run `infinibot doctor`

If the gateway is running on the same computer, the dashboard link opens the
Control UI right away. If it doesn't load, start the gateway first with
`infinibot gateway`.

## How it works

```text
WhatsApp / Telegram / Discord / Slack / Signal / iMessage (+ plugins)
        │
        ▼
  ┌───────────────────────────┐
  │          Gateway          │  ws://127.0.0.1:18789 (loopback by default)
  │   sessions · agents ·     │
  │   tools · cron · stores   │  http://<gateway-host>:18793
  │                           │    /__infinibot__/canvas/ (Canvas host)
  └───────────┬───────────────┘
              │
              ├─ Control UI (browser dashboard)
              ├─ CLI / TUI (infinibot …)
              ├─ Coding-agent backends (Claude Code, Codex, OpenCode)
              ├─ Desktop app (Electron) and mobile app
              ├─ Federation satellites (other machines)
              └─ iOS / Android / macOS nodes via Gateway WS + pairing
```

Most things go through the **gateway** (`infinibot gateway`). It owns the
channel connections, the WebSocket control plane, sessions and the local
stores.

## Features

- **Chat and voice.** Multi-model, multi-session chat, with wake word and voice
  mode using cloud or local speech engines.
- **Channels.** WhatsApp, Telegram, Discord, Slack, Signal, iMessage (macOS),
  plus plugin channels such as Mattermost, Matrix and Microsoft Teams.
- **Agents.** Multi-agent routing, sub-agents, and coding agents run in
  persistent terminals.
- **Autonomy.** [Cron jobs](/automation/cron-jobs), [webhooks](/automation/webhook),
  goal runs and approval gates.
- **Projects and data.** Local-first kanban, notes and
  [business databases](/business-databases), with optional Notion sync.
- **Workflows and skills.** [Workflows](/workflows), [skills](/tools/skills), and
  an MCP server that exposes the gateway's tools to external coding agents.
- **Federation.** [Master/satellite](/federation) setups across machines,
  optionally over [Tailscale](/gateway/tailscale).
- **Content.** [Storyboard](/storyboard) (script to finished video) and video
  tools.
- **Media.** Send and receive images, audio and documents.

## Network model

- **One gateway per host (recommended).** It is the only process allowed to own
  the WhatsApp Web session. For strict isolation, run
  [multiple gateways](/gateway/multiple-gateways) with separate profiles and
  ports.
- **Loopback first.** The gateway listens on `127.0.0.1:18789` by default. For
  access over a tailnet, use `infinibot gateway --bind tailnet --token ...`; a
  token is required for any non-loopback bind.
- **Remote use.** Use an SSH tunnel or a private network such as Tailscale. See
  [Remote access](/gateway/remote). Don't expose the gateway to the public
  internet.

## Configuration

Config lives at `~/.infinibot/infinibot.json`. Environment variables are listed
in [Environment variables](/environment).

Example: only accept WhatsApp messages from your own number, and require a
mention in groups:

```json5
{
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } }
    }
  }
}
```

## Docs

- Basics:
  - [Help](/help)
  - [Configuration](/gateway/configuration)
  - [Configuration examples](/gateway/configuration-examples)
  - [Environment variables](/environment)
  - [Slash commands](/tools/slash-commands)
  - [Multi-agent routing](/concepts/multi-agent)
  - [Updating and rollback](/install/updating)
  - [Pairing (DMs and nodes)](/start/pairing)
  - [Skills](/tools/skills) and [skills config](/tools/skills-config)
  - [Models](/concepts/models) and [providers](/providers)
  - [RPC adapters](/reference/rpc)
  - [Gateway runbook](/gateway)
- Channels and surfaces:
  - [Control UI (browser)](/web/control-ui)
  - [WhatsApp](/channels/whatsapp)
  - [Telegram](/channels/telegram)
  - [Discord](/channels/discord)
  - [Slack](/channels/slack)
  - [Signal](/channels/signal)
  - [iMessage](/channels/imessage)
- Apps and platforms:
  - [macOS](/platforms/macos)
  - [iOS](/platforms/ios)
  - [Android](/platforms/android)
  - [Windows](/platforms/windows)
  - [Linux](/platforms/linux)
  - [Nodes](/nodes)
- Operations and safety:
  - [Sessions](/concepts/session)
  - [Security](/gateway/security)
  - [Remote access](/gateway/remote) and [discovery](/gateway/discovery)
  - [Troubleshooting](/gateway/troubleshooting)
- Project:
  - [Contributing](https://github.com/MrYungCEO/infinibot-os/blob/main/CONTRIBUTING.md)
  - [Security policy](https://github.com/MrYungCEO/infinibot-os/blob/main/SECURITY.md)
  - [Privacy](https://github.com/MrYungCEO/infinibot-os/blob/main/PRIVACY.md)
  - [Changelog](https://github.com/MrYungCEO/infinibot-os/blob/main/CHANGELOG.md)
  - [Releasing](/reference/RELEASING)

## History and credits

InfiniBot started as a fork of an MIT-licensed open-source personal-assistant
gateway, and still builds on that work. Upstream authorship and contributor
credits are kept in the [pre-release changelog archive](/history/CHANGELOG-upstream)
and in the repository's license notices.

## License

InfiniBot is licensed under the Functional Source License 1.1 with an
Apache-2.0 future license (FSL-1.1-ALv2). Each release converts to Apache-2.0
two years after it is published. See
[LICENSE](https://github.com/MrYungCEO/infinibot-os/blob/main/LICENSE) and the
plain-English [LICENSING.md](https://github.com/MrYungCEO/infinibot-os/blob/main/LICENSING.md).
Code inherited from the upstream project stays under its MIT license; see
[NOTICE](https://github.com/MrYungCEO/infinibot-os/blob/main/NOTICE).
