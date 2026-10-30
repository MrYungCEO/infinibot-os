---
title: quickstart
description: The web-based guided setup for InfiniBot
---

`infinibot quickstart` is the recommended way to set up a fresh InfiniBot install. It boots the gateway in the foreground, opens a styled onboarding flow in your browser, and walks you through every step end-to-end with verification at each stage.

It replaces the legacy clack TUI (`infinibot onboard`) for interactive use. The TUI remains available for scripted / non-interactive installs.

## TL;DR

```bash
infinibot quickstart
```

That is the whole command. The gateway starts on `127.0.0.1:18789`, your browser opens to `http://127.0.0.1:18789/quickstart`, and you finish setup there. Press Ctrl+C in the terminal when done.

## Prerequisites

- Node 22+ or Bun installed.
- InfiniBot installed (`npm i -g infinibot` or `pnpm add -g infinibot`).
- An API key for at least one model provider (Anthropic, OpenAI, Z.ai, OpenRouter, or any compatible).
- (Optional) A Notion integration token if you want kanban data mirrored to Notion. The wizard walks you through creating one.

## Flags

| Flag                | Default      | Description                                                          |
|---------------------|--------------|----------------------------------------------------------------------|
| `--no-open`         | `false`      | Do not auto-open the browser. Prints the URL so you can open it manually. |
| `--port <number>`   | from config  | Override the gateway port. Falls back to `18789` if no config is present. |
| `--bind <mode>`     | `loopback`   | One of: `loopback`, `lan`, `tailnet`, `auto`. Controls who can reach the gateway. |

Examples:

```bash
infinibot quickstart                       # default: localhost only, auto-open browser
infinibot quickstart --port 18900          # use a different port
infinibot quickstart --bind lan            # listen on your LAN so other devices can reach setup
infinibot quickstart --no-open --bind lan  # for headless servers + remote browser
```

## Lifecycle

1. Quickstart pings `http://127.0.0.1:<port>/quickstart` to see if a gateway is already running on that port.
2. If yes, it just opens the browser at the existing URL. Useful when the gateway is already up under a system service.
3. If no, it spawns the gateway in the foreground. Gateway logs stream into your terminal so you can watch what is happening.
4. Once the gateway responds (within 15 seconds), the browser opens.
5. Walk through the steps in the web UI. Each step writes its captured values to `~/.infinibot/infinibot.json` immediately, so you can stop and resume any time.
6. The Review step calls `quickstart.finalize`, which writes a `onboarding.completed` flag into your config.
7. Press Ctrl+C in the terminal to stop the gateway when finished.

## Steps in detail

The web UI has nine sidebar entries. Each one writes a config patch to disk before you advance, so partial setups are safe to abandon.

### 1. Welcome

Risk acknowledgement and overview. No config writes.

### 2. Models and auth

Pick a primary provider and paste an API key. The wizard writes:

```jsonc
{
  "models": {
    "primary": "claude-opus-4-7",
    "provider": "anthropic"
  },
  "providers": {
    "anthropic": { "apiKey": "<your key>" }
  }
}
```

Fields:
- **Primary provider**: select from Anthropic, OpenAI, Z.ai, OpenRouter, or Custom.
- **API key**: stored in your config file, never sent anywhere except the providers API.
- **Model name (override)**: leave blank to use the providers default. For Anthropic that is `claude-opus-4-7`; for OpenAI it is `gpt-4o`; for Z.ai it is `glm-4.5`.

### 3. Gateway

Configure where the gateway listens.

| Setting     | Options                                            | Notes                                                          |
|-------------|----------------------------------------------------|----------------------------------------------------------------|
| Bind        | `loopback`, `lan`, `tailnet`, `auto`               | `loopback` is recommended unless you trust your network.       |
| Port        | any free port                                      | Defaults to `18789`. The control UI, mobile app, and CLI all read this. |
| Auth mode   | `token`, `password`, `open`                        | `open` is only safe with `loopback`.                           |

Writes to `gateway.port`, `gateway.bind`, `gateway.authMode`.

### 4. Channels

Pick the messaging channels you want active. Each tile opens a config form for that channel.

Built-in channels with token-based setup:
- Telegram (`TELEGRAM_BOT_TOKEN`)
- Discord (`DISCORD_BOT_TOKEN`)
- Slack (`SLACK_BOT_TOKEN`)

Built-in channels with no-token (paired-after-start) setup:
- Signal
- iMessage
- WhatsApp
- MSTeams
- Matrix
- Voice (LiveKit-based)

For each channel you can:
- Click **Enable** with a token to enable + persist the token.
- Click **Disable** to flip the channel off.

Writes to `channels.<id>.enabled` and `channels.<id>.token`.

### 5. Hooks

Optional. Register a single command to run when onboarding completes. Useful for desktop notifications or kicking off a follow-up script.

Writes to `hooks.internal.entries[]` with `event: "onboard.complete"`.

For full hook configuration see [Hooks](/hooks).

### 6. Federation

Choose between two modes:
- **Standalone**: this node runs alone. Default.
- **Satellite**: this node connects to a master gateway and shares state. You will be asked for a master URL.

Writes to `federation.mode` and `federation.masterUrl`.

For details see [Federation](/federation).

### 7. Notion (optional)

The most polished part of the flow. Connect a Notion integration so kanban data mirrors there.

The Notion step is documented in detail in [Notion sync](/notion-sync). Summary:

1. Paste your integration token. The wizard validates it with `/users/me` and shows the workspace name.
2. The wizard lists pages your integration can access. If the list is empty you get an inline hint to invite the integration to a page in Notion.
3. Pick a parent page. The wizard creates `Projects` and `Tasks` databases under it with the right schema and the relation wired up automatically.
4. Verification runs four checks: token still valid, Projects DB reachable, Tasks DB reachable, Tasks-to-Projects relation pointing correctly, write probe. Any failed check tells you exactly what to fix.
5. Pick a sync mode (`mirror` is recommended) and finalize.

You can skip Notion entirely. Kanban works perfectly without it.

### 8. Kanban

Status display + a one-shot legacy importer. Most users have nothing to do here. Click **Import legacy Notion kanban** if you have data in the pre-revamp hardcoded Notion DBs and want to import it.

For the architecture see [Kanban](/kanban).

### 9. Review and finish

A summary table of every step. Hit **Finalize** to mark setup complete and switch the config from setup mode to normal.

## Re-running quickstart

You can run `infinibot quickstart` any time to revisit settings. Steps that the server detects as complete (model present, gateway port set, channels enabled, etc.) show a green checkmark in the sidebar. Click any step to jump straight to it.

The `quickstart.status` RPC drives this — it inspects your current config and reports per-step state, so the UI is always honest about what is configured.

## Architecture

For contributors and operators who want to know what is happening under the hood:

- The CLI command lives in `src/commands/quickstart.ts`. It is registered in `src/cli/program/register.quickstart.ts`.
- The HTTP handler is `src/gateway/quickstart-ui.ts`. It serves a single self-contained HTML file at `/quickstart`. No Vite bundle, no React, no extra build step. The whole flow ships in any package mode (npm install, single binary, packaged Mac app).
- The web UI talks to the gateway via WebSocket using existing RPC namespaces. New methods added for quickstart:
  - `quickstart.status` — snapshot of all steps and their completion state
  - `quickstart.applyPatch` — deep-merge a config patch and persist
  - `quickstart.migrateLegacyNotion` — one-time legacy import
  - `quickstart.finalize` — write the `onboarding.completed` flag
  - `notion.wizard.status` — current Notion + kanban state
  - `notion.wizard.verifyToken` — validate a Notion integration token
  - `notion.wizard.listPages` — pages the integration can access
  - `notion.wizard.createSystemDbs` — create Projects + Tasks DBs under a parent page
  - `notion.wizard.verifySetup` — run the verification pass
  - `notion.wizard.finalize` — persist the verified configuration
  - `notion.wizard.disconnect` — clear all Notion config

## Troubleshooting

**Gateway failed to start within 15s.**
The gateway crashed during startup. Look at the log lines printed before the error. Most common causes:
- Port already in use by another process. Run `infinibot quickstart --port 18900`.
- Missing config-required env vars. Run `infinibot doctor` (see [Doctor](/gateway/doctor)).

**Browser did not auto-open.**
Some terminals run sandboxed and cannot launch a browser. You will see a `Could not auto-open` message in the terminal. Copy the printed URL into a browser manually.

**Token-protected gateway and the web UI cannot connect.**
The quickstart UI talks to the gateway over WebSocket. If your gateway requires a token (`auth.mode = token`), you need to load the URL with the token cookie set. Easiest path: stop the gateway, run quickstart on a fresh install, finish the wizard before re-enabling token auth.

**The Notion integration list is empty.**
The integration is created but not invited to any pages. In Notion, open the page where you want kanban DBs to live, click the **...** menu, choose **Connections**, and invite **InfiniBot Sync**. Then click **Reload** in the wizard.

**Migration imported zero rows.**
You did not have data in the legacy hardcoded Notion DBs (UUIDs `202f4bdd-9bcf-814d-9255-d9afab315b1e` and `202f4bdd-9bcf-81f3-9709-f99f4802ed97`). This is normal for fresh installs. The migration is also idempotent, so re-running it is harmless.

## Non-interactive setup

For CI and scripted installs, keep using the legacy TUI:

```bash
infinibot onboard --non-interactive --accept-risk \
  --auth-choice apiKey --anthropic-api-key $ANTHROPIC_API_KEY \
  --gateway-port 18789 --gateway-bind loopback \
  --skip-channels --skip-skills
```

See [Onboard](/cli/onboard) for the full flag list. Quickstart is purely additive; it does not deprecate the TUI.

## See also

- [Notion sync](/notion-sync) — the Notion wizard reference and sync modes
- [Kanban](/kanban) — local-first kanban architecture
- [Onboard](/cli/onboard) — the legacy TUI
- [Federation](/federation) — federation modes
- [Hooks](/hooks) — hook event reference
