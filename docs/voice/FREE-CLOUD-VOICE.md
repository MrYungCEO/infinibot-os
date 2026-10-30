---
summary: "Owner decision 2026-10-16: local voice is the default everywhere; Cloud voice (Robovoice) is an explicit, free option (no credits). Notes for the public-site docs agent."
read_when:
  - You are writing copy about InfiniBot voice, Robovoice, credits or pricing
  - You are changing the Robovoice credit gate or the fair-use cap
---
# Free cloud voice (Robovoice) — local stays the default

## The decision (owner, 2026-10-16)

> "make local default options only voice options, but honestly just keep robovoice cloud option
> functionality just without the credit gate making it seamless"

1. **Local voice is the default everywhere** — new installs, onboarding, Voice settings, voice
   chat, Telegram voice notes and the mobile app. Built-in engine or the user's own Docker
   Kokoro/Speaches. Nothing routes to Robovoice automatically, and there is no automatic fallback
   from local to cloud: a broken local setup shows "Set up voice for me".
2. **Cloud voice (Robovoice)** is an optional choice the user picks explicitly. It is **free**:
   no credits, no wallet, no top-up, no per-minute price anywhere in InfiniBot. The Robovoice
   plugin is no longer a paid plugin (moved to `free` in
   `src/saas/cloud/marketplace/first-party-pricing.json`).
3. If Robovoice is busy (fair-use cap), the user sees **"Cloud voice is busy — switch to local
   voice"** with a one-click switch. It is never presented as a paywall.

## For the public-site docs agent — copy rules

- Say "Local voice (default)" and "Cloud voice (Robovoice) — optional, free".
- Do **not** say: credits, wallet, top up, per minute, metered, billed, "Robovoice is InfiniBot's
  voice", "voice runs on Robovoice", "paid plugin $29" for Robovoice.
- OK to say: "Usage is measured to keep cloud voice fair. If it's ever busy, switch to local voice
  in one click."
- Robovoice's own product (robovoice.io for robots/kiosks/agencies) keeps its usage-based credits —
  this change is only for InfiniBot-originated sessions.

## How it works (for engineers)

| Layer | Where | What |
| --- | --- | --- |
| Robovoice server | `Robovoice-*/frontend/lib/edge/infinibot-cloud-voice.ts` | `INFINIBOT_CREDITS_GATE` (unset/`off` = free, `on` = bill credits again). `INFINIBOT_CLOUD_VOICE_DAILY_MINUTES` (default 240 per org per UTC day, `0` = no cap) |
| Calls | `app/api/connection-details/route.ts`, `lib/billing/calls.ts` | InfiniBot calls place a zero-amount `infinibot_free` hold; settlement writes a `billing_usage_sessions` row with `enforcement='infinibot_free'`, rated `charge_micros`, `charged_micros = 0` (metering kept). Cap reached → `429 {error:"cloud_voice_busy"}` |
| Speech (read-aloud / talk) | `lib/edge/infinibot-speech.ts` | Never refused for the wallet; a zero-amount ledger line with `meta.free=true, rated_micros` per request |
| InfiniBot plugin | `extensions/robovoice/src/client.ts`, `speech.ts`, `provider.ts` | 402/429 → `VoiceProviderError(429, "cloud_voice_busy")`; no top-up links; manifest `credits:false` |
| InfiniBot gateway | `src/gateway/voice/provider-registry.ts`, `server-voice-connection.ts` | `auto` = local only; no cross-provider retry |
| InfiniBot UI | `views/voice-robovoice/*`, `components/chat-speech.ts`, `views/robovoice/*` | Wallet pill/card/banners and credit prices removed; "Cloud voice · free"; busy notice + "Switch to local voice" |
| Voice turns | `src/gateway/voice/voice-ack.ts`, `voice-delegate.ts` | No relay narration ("handing that to the main agent" / "Sending that to Claude Code") |

Turning billing back on later: set `INFINIBOT_CREDITS_GATE=on` on the Robovoice Netlify site and
redeploy (env is read at runtime by functions; a redeploy makes sure every function picks it up).
The InfiniBot UI still shows the friendly busy line (not a top-up) for a 402.

## Cost of free cloud voice (owner reference)

See the run report of 2026-10-16 (feat/voice-local-default) for the per-minute estimate from
Robovoice's provider prices (`src/robovoice/pricing.py`).
