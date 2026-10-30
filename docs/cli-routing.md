---
summary: "Run InfiniBot on the Claude, ChatGPT, Google (Gemini) or Grok plan you already have, through its official CLI, with no API key"
read_when:
  - You have a Claude / ChatGPT / Google / Grok subscription but no API key
  - You want agents' chat to run through Claude Code, Codex CLI, Gemini CLI, Grok Build or OpenCode
  - A chat says your plan hit its usage limit or you were signed out
---

# Use my subscription (CLI routing)

InfiniBot can run your agents' chat — webchat, Telegram and the other channels, and voice — through the
coding CLI you are already signed in to, so your subscription pays instead of an API key.

| Card in onboarding | CLI           | Provider id    | Signs in with                         |
| ------------------ | ------------- | -------------- | ------------------------------------- |
| ChatGPT            | Codex CLI     | `codex-cli`    | ChatGPT Plus / Pro / Business         |
| Grok               | Grok Build    | `grok-cli`     | SuperGrok / X Premium+                |
| Google account     | Gemini CLI    | `gemini-cli`   | a Google account (free daily quota)   |
| Claude             | Claude Code   | `claude-cli`   | Claude Pro / Max                      |
| (settings only)    | OpenCode      | `opencode-cli` | whatever OpenCode is signed in to     |

Google Antigravity is not supported: it is an editor, and `antigravity chat` opens a window without
returning the reply, so there is nothing to read from. Use the Google account card (Gemini CLI) with the
same Google sign-in. Google Workspace accounts also need `GOOGLE_CLOUD_PROJECT` set for Gemini CLI;
personal Google accounts don't.

## Turning it on

- **Onboarding → AI brain**: "Which of these do you already have?" Pick a card; InfiniBot installs the
  CLI if needed (no admin rights), opens the account's sign-in in the browser, sends one tiny test
  message and switches on. Then "Start chatting" opens the chat.
- **Setup › Coders → Use my subscription**: the switch, the fallback order, per-account model, the
  per-agent overrides, "fall back to my API model" and "let it use InfiniBot tools".
- **Terminal**: `infinibot onboard` asks the same question. Or edit config:

```json5
{
  cliRoutingEnabled: true, // default false: existing installs keep their models
  cliRouting: {
    providers: ["claude-cli", "codex-cli", "gemini-cli"], // try in this order
    models: { "claude-cli": "sonnet" }, // "default" = the CLI's own default
    fallbackToApi: false, // after every CLI fails, try the agent's own model
    tools: true, // InfiniBot tools through the infinibot MCP server
    allTraffic: false, // true = route ALL traffic (see below)
  },
  agents: { list: [{ id: "writer", cliRouting: false }] }, // per agent: true / false / unset
}
```

The config is read on every turn; no restart is needed.

## Route all traffic

`cliRouting.allTraffic: true` (with `cliRoutingEnabled: true`; Setup › Coders → **Use it for everything**)
sends every model turn the gateway runs through the CLIs in `providers`, falling back down that list:

- every agent, including agents on a local model and agents with `cliRouting: false`;
- every ingress: web control UI and desktop chat, mobile, Telegram / Discord / Slack / the other
  channels, voice (Robovoice, web voice and the voice-call plugin), group chat, follow-up messages
  queued behind a running turn, sub-agents, cron jobs, heartbeats, the OpenAI-compatible HTTP API
  and federated nodes' chat (each node applies its own config);
- runs pinned to an API model: a sub-agent / cron / heartbeat model, the voice brain picker, a model
  picked in a chat. A run already on a CLI keeps that CLI. With `fallbackToApi` the pinned model is
  the last resort after every CLI.

It is applied in one place, `runWithModelFallback` (`src/agents/cli-routing-run.ts`), which every
agent turn goes through. Voice turns skip the direct-API "fast" step when they will be routed.
Secure Mode sessions are never moved onto a cloud CLI. Not covered (they are not chat turns and keep
their API model): embeddings / memory search, TTS text shaping, idea capture, discovery, design
auto-fill, Notion schema mapping, autonomy judges.

## Grok ("GrokBot")

Two ways, both in every surface that has the feature:

- **Grok subscription** → Grok Build CLI (`grok-cli`): `grok --output-format streaming-json -p …`,
  `-m <model>` on a new session, `--resume <id>` after, `--prompt-file` past ~100k chars,
  `XAI_API_KEY` removed from its env. Installed by Setup › Coders (single binary, no admin); sign in
  with `grok login --device-auth` (code shown in the sign-in box). Chat turns routed to `grok-cli`
  get no per-chat InfiniBot MCP injection (Grok Build has no per-run MCP flag); it still loads the
  global `infinibot` entry from `~/.grok/config.toml` or `~/.claude.json` when one is registered.
- **Grok Build as a coder backend** → coder backend id `grok` (`src/agents/coder-backend/grok.ts`):
  the `grok_coder` tool, `claude_coder { backend: "grok" }`, `coder.backend: "grok"`, per-agent
  `defaultCoderBackend` / `fallbackCoderBackend`, goals / queue phases / scheduled tasks
  (`agent: "grok"`), autonomy goal-mode backend `{ kind: "grok" }`, terminals (`cli: "grok"`) and
  the voice CLI selector. Spawns `grok --output-format streaming-json --no-auto-update [-m model]
  [--always-approve] [--resume id] --cwd <workdir> -p <prompt>` (`--prompt-file` for huge prompts),
  `XAI_API_KEY` removed unless saved for Grok Build in Setup › Coders. InfiniBot tools: Setup ›
  Coders / `POST /api/coder/mcp-install {backend:"grok"}` writes `[mcp_servers.infinibot]` into
  `~/.grok/config.toml` (`GROK_HOME` honoured).
- **xAI API key** → provider `xai` (`XAI_API_KEY`, onboarding / Settings › API keys).

## How it works

The CLIs are real model providers (`src/agents/cli-backends.ts`, `src/agents/cli-runner.ts`). When routing
applies to an agent, its primary model becomes the first **installed** CLI in `providers` and its
fallbacks become the rest (`src/agents/cli-routing.ts`). Model pickers, sessions, `/model`, failover and
every channel work unchanged; a model picked in a chat still wins for that chat. Agents on a local model
(Ollama, vLLM, LM Studio) keep it.

- **Streaming**: each CLI runs with its JSON event stream (`claude -p --output-format stream-json
  --include-partial-messages`, `codex exec --json`, `gemini --output-format stream-json`,
  `grok --output-format streaming-json`, `opencode run --format json`); reply text streams to webchat,
  channel block streaming and voice as it arrives.
- **Multi-turn context**: the CLI's own session id is stored on the InfiniBot session and resumed
  (`--resume`, `codex exec resume <thread>`, `--session`).
- **Persona**: the agent's system prompt goes with the first turn of a CLI session.
- **Tools**: the CLI gets the `infinibot` MCP server (memory, kanban, notes, workflows, messaging, …);
  calls go back through the gateway, so its tool policy and approvals apply. The CLI's own built-in
  tools are off (Claude Code: `--tools ""`; Codex: read-only sandbox). Grok Build has no per-run MCP
  flag: it only sees a globally registered `infinibot` entry (`~/.grok/config.toml` or `~/.claude.json`).
- **No API keys**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY` are removed
  from the CLI's environment so the subscription login is used, never a key.
- **Concurrency**: turns of one chat run in order (so resume stays correct); different chats run in
  parallel.
- **Failures**: usage limits, signed-out accounts, timeouts and a missing CLI are recognised and the
  next CLI is tried. If all fail, the chat shows one plain sentence and one fix (Sign in again / Switch
  to Google (free) / Try again in N min); codes `subscription_limit`, `subscription_signed_out`,
  `subscription_missing`, `subscription_timeout`, `subscription_failed`.

## Secure Mode

Cloud CLIs send the conversation to their vendor's servers, off this computer, so secure-lane sessions
never use them: the turn moves to the secure local model, or is refused with a message saying who would
receive the data. A CLI you run against a local model can be allowed explicitly:

```json5
{ agents: { defaults: { cliBackends: { "opencode-cli": { command: "opencode", localOnly: true } } } } }
```

## InfiniBot Cloud

- **Workspace on its own cloud Machine** (fleet tenant, `FLEET_TENANT_ID` set): works like a local
  install. Setup › Coders installs the CLI onto the workspace's volume (`/data/coders/...`), the sign-in
  is the CLI's device-code / URL flow in the sign-in box, and the credential stays in `/data/home` on
  that volume. `cliRouting.status` → `available: true, where: "tenant-machine"`.
- **Shared multi-tenant gateway** (`SAAS_MODE` / `CLOUD_MODE` without `FLEET_TENANT_ID`): one HOME would
  hold every workspace's sign-in, so routing never applies there, even if the config says so.
  `cliRouting.status` → `available: false, where: "shared-cloud", unavailableReason`; `cliRouting.set`
  (`enabled: true` / `allTraffic: true`), `.login` and `.connect` answer `UNAVAILABLE` with that reason.
  Grok there = an xAI API key.

## RPCs

- `cliRouting.status` — switch, `allTraffic`, `available` / `where` / `unavailableReason`, order,
  per-CLI installed / signed-in / model, per-agent routing.
- `cliRouting.set` — `{ enabled?, providers?, models?, fallbackToApi?, tools?, allTraffic?, agentId?, agentEnabled? }`.
- `cliRouting.login` — `{ provider, mode? }` → browser sign-in session (poll `coders.login.poll`) or a
  terminal running the CLI's login.
- `cliRouting.connect` — `{ provider }` → one tiny test turn; switches routing on with that CLI first
  only when it answers.
