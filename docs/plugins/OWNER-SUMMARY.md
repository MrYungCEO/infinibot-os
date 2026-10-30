# Plugin platform — owner summary (1 page)

Full design: [`PLUGIN-PLATFORM.md`](PLUGIN-PLATFORM.md). Branch
`feat/plugin-platform-design`. Nothing merged, pushed or restarted.

## The idea

InfiniBot becomes **one small core AI OS + plugins**. Every specialised
product (Infinitrade, Robovoice, OmniClinic, agency OS, creator OS) is a
plugin bundle on that core instead of a fork with its own gateway. Other
people build plugins the same way we do and publish them through InfiniBot
Cloud accounts.

## Core vs plugin (135 surfaces and features classified)

| | Count | Examples |
|---|---|---|
| **Core** | 73 | chat, grid, voice UI + wake word, agents, goals + verification, memory, research, projects, notes, databases, terminals, files, browser, channels framework, MCP, skills, settings, plugin host |
| **First-party, bundled (can turn off)** | 39 | business-agency (CRM, Command, registers…), content-studio, productivity (Discipline, Focus), fleet, dev-extras, voice-local (Kokoro/Whisper), notion, email, **InfiniCode** |
| **First-party, via marketplace** | 4 | **Robovoice, Infinitrade, FlyPic**, OmniClinic (private source, can be paid) |
| **Marketplace tier** | 4 | growth (Funnels, Campaigns, Loops…), desktop-linux, tier-2 channels |
| **Private cloud code** | 1 | SaaS/fleet/billing/licence gate (also hosts the registry) |
| **Remove** | 14 | Vault, android-ops, instances, Solana chart, upgrade pill, gamification, war room, moltbook… |

## The four first-party plugins

| Plugin | What it becomes | Effort |
|---|---|---|
| **InfiniCode** | Bundled plugin: own nav entry + page + RPCs, off by default. **Already working in the spike.** Still to do: move the UI into the plugin, persistence, and make the coder panel spawn only on click. | 4–6 d |
| **FlyPic** | Media-generation provider: MCP server + skill + agent defaults + project link, token moved to the vault, generations metered in credits | 4–5 d |
| **Robovoice** | Realtime voice provider behind a core "voice provider" interface. Core keeps voice (BYOK cloud + a local Kokoro/Whisper plugin); Robovoice adds LiveKit calls, characters and credits (1 credit = 1 s) | 12–16 d |
| **Infinitrade** | Folded onto the main gateway. The :18911 gateway and `~/.infinibot-omnitrade` retire via a migration command; ~120 RPCs renamed `infinitrade.*`; TradeLocker creds move to the vault | 15–20 d |

## Marketplace model

- **Registry on InfiniBot Cloud** (Netlify Functions + Neon, like
  cloud-serverless). A publisher account is a Clerk account or org.
- **Submission pipeline:** upload → automated checks (manifest, licence
  allowlist, secret scan, permission/static analysis, reproducible build,
  tests, `visual_verify` screenshots) → AI + human review → signed publish.
  The gateway verifies publisher and registry signatures before installing,
  and a revocation list handles takedowns.
- **Safety:** every plugin declares its capabilities and permissions up
  front, and users approve them at install. Community plugins run
  **sandboxed out-of-process** with no raw file, exec or network access
  beyond what they declared. Their UI runs in a sandboxed iframe.
- **Money:** usage-based credits only (never flat or unlimited). Publishers
  earn a share of the credits spent in their plugin.

## Phased plan

| Phase | What | Effort | Wall time (parallel agents) |
|---|---|---|---|
| 0 | Plugin host v2 in core: full manifest, host services, UI slots, agent surfaces, sandbox, hot enable/disable | 21–24 d | ~1–1.5 wk |
| 1 | InfiniCode, FlyPic, Robovoice (+ voice-local), Infinitrade, plus the bundled packs | 35–47 d, plus 5–8 d per pack | ~3–4 wk |
| 2 | `@infinibot/plugin-sdk`, UI kit, `infinibot plugin create/dev/test/verify/publish`, templates, docs | 8–10 d | ~1 wk |
| 3 | Registry, submissions, signing, in-app Marketplace, credits and payouts | 15–20 d | ~1.5–2 wk |
| 4 | UGC launch: publisher onboarding, moderation, IG "build your own AI OS" content | 5–8 d | ~1 wk |

## What the spike proved

Working in an isolated worktree:
- InfiniCode loads as a **v2 plugin**.
- A new switch in Setup › Plugins turns it on and off.
- When on, it adds its own sidebar entry, page and RPCs.
- When off, all of those disappear: the RPC returns "unknown method" and the page shows a "turned off" card.
- The host rejects any RPC or route a plugin didn't declare.

Proven on a fresh install and on a stripped copy of your config, with tests, both builds and screenshots.

## Decisions I need from you

1. Approve the core/plugin split, especially voice staying core, Discipline/Notion/Mail as plugins, and the 14 removals.
2. Ship Robovoice, Infinitrade, FlyPic and OmniClinic as private registry plugins, outside the public repo?
3. Robovoice as the default voice when logged into Cloud, or opt-in?
4. Revenue share (proposed 70/30, then 80/20 at volume) and payout rail (Whop or Stripe Connect).
5. SDK licence Apache-2.0?
6. Sandbox all community plugins at launch?
7. Who reviews submissions at launch?
8. Infinitrade fork's extra data (achievements, discipline): merge or leave?
9. Phase 1 order (proposed: InfiniCode + FlyPic first, then Robovoice and Infinitrade in parallel).

Also found: opening `/inficode` auto-starts a Claude CLI session. Your
shell exports real Telegram/Notion/Loops tokens, which side gateways
inherit.
