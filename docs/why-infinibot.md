---
title: Why InfiniBot
description: How InfiniBot compares to other AI agent platforms — architecture, surface area, and the trade-offs.
---

# Why InfiniBot

There are a lot of "AI agent" products now. Most fall into one of three buckets:

1. **Single-channel chat skins** — a web UI in front of one model, sometimes with tools, almost always cloud-hosted.
2. **CLI-first coding agents** — terminal-bound, single-machine, single-session, single-language (you, talking to one shell).
3. **Hosted multi-agent platforms** — closed clouds where "agents" are really chat threads with quotas, isolated from each other and from your machines.

InfiniBot is none of those. It's a **personal AI gateway** that runs on your hardware, owns your sessions, talks to every channel you actually use, and federates across as many devices as you have. This page explains what that buys you and where the trade-offs are.

## The short version

| Concern | Single-channel chat | CLI coding agent | Hosted multi-agent | **InfiniBot** |
|---|---|---|---|---|
| Hosting | Vendor cloud | Your terminal | Vendor cloud | **Your machine(s)** |
| Channels | 1 (web) | 1 (TTY) | 1 (web) | **Telegram, Discord, Slack, iMessage, BlueBubbles, Signal, WhatsApp, Google Chat, MS Teams, LINE, voice, web** |
| Multi-agent | No | No | Sandboxed threads | **Yes — first-class agent registry, sub-agent spawn, federation** |
| Session continuity | Per-tab | Per-shell | Per-thread | **Persistent across channels, devices, restarts** |
| Memory | None or vendor-locked | None | Vendor DB | **Local SQLite + vector, exportable** |
| Tools | Function-calling | Built-in only | Vendor catalog | **MCP (any server) + plugin SDK + your own** |
| Voice | Premium add-on | None | Premium add-on | **Local Speaches + Kokoro, optional** |
| Multi-device | No | No | Sometimes (read-only) | **Federated master/satellite mesh** |
| Cost at scale | Per-token vendor | Free CLI + per-token | Per-seat | **Your model bill only** |
| Lock-in | High | Low | Very high | **Low — open data, open code** |

The rest of this page expands each row.

## Hosting — your hardware, your rules

Hosted agent platforms are ergonomic until they aren't:

- **Rate limits and quotas** — vendor decides when you stop.
- **Data egress** — every prompt leaves your network.
- **Forced model upgrades** — they retire a checkpoint, your prompts subtly change behavior overnight.
- **Audit gaps** — you can't see what was actually sent or stored unless they let you.

InfiniBot runs as a **gateway process on your machine** (and optionally on more machines you trust, mesh-connected via [Federation](federation.md)). The gateway is a Node/TypeScript binary plus optional native companions (macOS/iOS/Android). Your prompts go to whichever model provider you configure (OpenAI, Anthropic, Bedrock, Ollama, llama.cpp, ...) — InfiniBot is the orchestrator, not the model.

The trade-off: **you operate it**. There's no "just sign up" path; you install, configure channels, point it at model credentials, and own the uptime. For some users that's a tax. For users who already run their own infra (or who care about data control) it's the entire point.

## Channels — meet users where they are

A web chat UI is the easy build. Reaching users where they actually live — group chats, voice notes, side-channel messages on Slack — is the hard one. InfiniBot ships first-class adapters for:

- **Messaging** — Telegram, Discord, Slack, iMessage, BlueBubbles, Signal, WhatsApp, Google Chat, MS Teams, LINE, web chat
- **Voice** — LiveKit-routed real-time voice with local Whisper STT (Speaches) and local Kokoro TTS
- **Terminal** — drive Claude Code (or any CLI agent) inside an embedded PTY, including from voice
- **Mobile/Desktop companions** — native iOS/Android/macOS apps that join the same gateway

Each adapter is more than "send/receive text". Group policy, mention gating, allowlists, attachments, native commands, reactions, threading semantics, presence, and per-account routing are all configurable. Each lives behind a normalized chat-context model so a single agent can answer in any of them without channel-specific prompts.

Single-channel agents force users to context-switch into the agent's UI. InfiniBot inverts it: the agent comes to whichever surface the user already has open.

## Multi-agent — first-class, not a thread tag

Most "multi-agent" products mean "multiple chat threads". InfiniBot's agent system is structural:

- **Agent registry** — multiple agents (`main`, `coder`, `architect`, `inspector`, ...) each with their own system prompt, model preference, tool subset, workspace, memory, and skill set.
- **Sub-agent spawning** — any agent can spawn a sub-agent, with a separate session, that returns a result. Coder spawns inspector to validate; main spawns deep-thinker for a planning step.
- **Lanes** — concurrency rules per agent kind (subagent vs main vs voice), so you don't get a CLI-coder's compile thrashing your interactive chat.
- **Cross-device** — via federation, an agent on a satellite can be spawned by an agent on the master, with the result streamed back. Use a Mac for compile-heavy CLI work and a phone for voice. Same gateway state.

Compare this to platforms where "agent" is a marketing word for "preset". When you need parallel work, those force you into a workflow runner with a different mental model. InfiniBot keeps it inside the agent metaphor.

## Sessions — persistent, addressable, durable

A session in InfiniBot is a first-class object with its own:

- Stable session key (`agent:<id>:<scope>` or channel-derived)
- Transcript file (JSONL on disk, replayable)
- Token usage + budget tracking
- Channel of origin and delivery context
- Skills snapshot, system-prompt report
- Spawned-by graph for sub-agents

This means:

- **Refresh-safe** — close the browser, the agent run keeps going on the gateway. Reconnect and watch it stream.
- **Cross-channel handoff** — start a thought in iMessage, continue it in voice, finish in web chat. Same session, same memory.
- **Activity feed** — `sessions.list` returns every live and recent session across every agent across the federation, with previews. The activity page is a real-time view onto this.
- **Replay + audit** — every transcript is on disk. You can grep them, diff them, export them.

CLI coding agents lose context the second the shell closes. Hosted threads die when the platform decides. InfiniBot sessions live until you delete them.

## Memory — yours, structured, exportable

Memory in InfiniBot is split into a few layers:

- **Transcripts** — the literal message log per session, JSONL, append-only.
- **Vector memory** — opt-in, SQLite + sqlite-vec for semantic recall. Stored locally.
- **Structured memory** — agents can read/write user-profile-style facts, project memory, reference pointers (URLs, locations, internal systems), and feedback (corrections + confirmations) into namespaced files.
- **Snapshots** — per-session skill snapshots, system-prompt reports, token-usage history.

It's all on your filesystem. You can `git diff` it. You can move it between machines. You can delete it. You can sync part of it across the federation. Vendor-cloud agent products give you "memory" as a checkbox; InfiniBot gives you the actual byte stream.

## Tools — MCP-native, plus a plugin SDK

Tooling is where most agent products lock you in. They define a tool schema, give you a vendor catalog, and that's the world.

InfiniBot is **MCP-native**. Any [Model Context Protocol](https://modelcontextprotocol.io) server speaks to it: kanban, filesystem, web, browser automation, message bus, TTS, memory, cron, federation nodes, canvas. You bring third-party MCP servers; you write your own; you run them locally or remotely.

Beyond MCP, there's a **plugin SDK**: TypeScript packages that register channel adapters, agent tools, hooks, gateway methods, and config schemas. The same plugin model the channels themselves use is what you write your custom integrations against.

A few things this enables that vendor catalogs can't:

- **Hooks** — pre/post message processing, on-tool-call, on-session-end. You write a hook for "every Gmail forward gets summarized", InfiniBot fires it at the right moment.
- **Agent tools** — give your `coder` agent access to your private CI status API; give your `architect` agent only filesystem-read; give your `voice` agent the canvas. Per-agent tool gating, declared in config.
- **Cron + workflows** — schedule agent jobs ("triage my inbox at 7am"), chain them, have one agent's output trigger another.

## Voice — local first, optional

Voice mode runs through:

- **Speaches** (local Whisper) for STT
- **Kokoro** (local TTS) for read-aloud
- **LiveKit** for the real-time audio transport (only when needed)

It's all in Docker, GPU-accelerated. Hosted voice products get you a polished demo at the cost of streaming every utterance to a vendor.

InfiniBot's voice mode is also bidirectional with the rest of the system: voice STT can drive a Claude Code terminal directly (the assistant text streams back through Kokoro), or it can talk to your `main` agent through web-chat semantics, or it can spawn a federated session on a satellite. Same primitives, different surface.

## Federation — many machines, one mesh

InfiniBot can run as a **master** on one machine and as **satellites** on others. The mesh:

- Discovers each other on the LAN (mDNS) or via configured master URLs
- Shares a federated resource registry (projects, agents, MCPs, directories, terminals)
- Routes session spawns, messages, and terminal I/O between nodes
- Streams events back up so the master UI sees everything

Concrete examples:

- Voice-control your Mac while you're on your phone — phone is master, Mac is satellite, the agent's `terminal.create` lands on the Mac and the output streams back.
- Run heavy local LLM inference on your gaming desktop, hit it from your laptop.
- Have one always-on home server and let your laptop join when it's open.

The full architecture lives in [Federation](federation.md).

## Cost — you pay your model bill only

Hosted platforms charge per seat, per token (with markup), per agent, per "credit". InfiniBot charges you nothing — it's open code running on your hardware. Your only variable cost is whatever model you point it at, billed by that provider.

For local models (Ollama, llama.cpp, MLX) the marginal cost per turn is electricity.

## Lock-in — low by design

The exit ramps are designed in:

- **Sessions** are JSONL files. `cat them | jq`. Move them. Diff them.
- **Memory** is plain markdown + SQLite. Open in any tool.
- **Config** is TypeScript-validated YAML/JSON. Standard formats.
- **Channels** are official SDKs underneath (Telegram bot API, Discord.js, Slack Bolt, etc.). If you ever want to migrate, you have raw access.
- **Models** are configured by name; switch providers any time.

There's no proprietary serialization, no DRM, no platform you have to apologize to in order to leave.

## When InfiniBot is the wrong choice

To be honest:

- **You want a polished single-purpose chat product.** InfiniBot is a platform; you assemble the UX.
- **You don't want to operate any infra.** Hosted products handle uptime; here you do.
- **You want fully managed compliance.** SOC2-style ceremonies happen at vendor scale. InfiniBot ships with secure defaults but you own the audit trail.
- **You only ever talk to one chat surface.** A single-channel chat skin is simpler if "I just want a web textbox" is the entire requirement.

For everything else — multi-channel reach, federated devices, real multi-agent orchestration, MCP tooling, owned memory, voice that doesn't leave your network, sessions that survive everything — there's a reason this codebase exists.
