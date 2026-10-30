---
summary: "Voice runs locally by default (local STT/TTS, direct CLI-agent and gateway-agent chat); Robovoice is an opt-in cloud voice for devices that can't run voice locally"
read_when:
  - You are changing how the Voice page, chat mic, wake words or voice buttons reach an agent
  - You are wiring or debugging the local voice engine or the Robovoice cloud option
  - Someone asks why a voice reply said (or didn't say) "Sending that to Claude Code"
---
# Voice: local by default, Robovoice optional (cloud)

This replaces the Robovoice-only period (Sep 30 – Oct 13 2026). The Voice page keeps its current
look: the holographic Voice Terminal, sub-tabs, HUD and call controls. Only the engine underneath
changed.

## Engines

| Engine | When | Speech | Who answers |
| --- | --- | --- | --- |
| **Local voice** (default) | `voice.backend` unset, `auto` or `local` | Browser Silero VAD → `POST /api/voice/stt` (local Whisper, Speaches) → `POST /api/voice/tts` (local Kokoro, or the Speaches container's Kokoro when no Kokoro container answers) | `POST /api/voice/turn` (below) |
| **Cloud voice (Robovoice)** | `voice.backend: "robovoice"`, chosen under Voice › Settings › Voice engine. Needs the Robovoice plugin on and linked | Robovoice's LiveKit agent (its own STT/TTS; free for InfiniBot, metered for fair use) | Robovoice calls the same voice-turn seam through the plugin |

Turning the Robovoice plugin on, or linking it, does **not** switch voice to it. If `robovoice` is
selected while the plugin is off or unlinked, the gateway falls back to local
(`voice.providers.list` → `fellBack`) and the UI stays on local voice.

**Never automatic (owner decision 2026-10-16).** `auto`/`local` resolve to local voice only — even
when local voice can't serve, nothing routes to Robovoice; the UI shows the local fix ("Set up voice
for me"). `/api/voice/connection` no longer retries a failed provider on another one. Cloud voice is
free for InfiniBot (no credits, no wallet, no top-up); when Robovoice refuses a call (fair-use daily
cap → `429 cloud_voice_busy`) the Voice page and chat show "Cloud voice is busy — switch to local
voice" with a one-click switch (`switchToLocalVoice` → `voice.providers.select {id:"auto"}`).
See `docs/voice/FREE-CLOUD-VOICE.md`.

## One voice-turn seam for both

`runVoiceLlmTurn` (`src/gateway/voice/voice-llm-turn.ts`) answers every turn. Local calls reach it
through `POST /api/voice/turn` (`src/gateway/server-voice-turn.ts`, a protected route, so the caller
is the owner). It returns SSE: `{delta}` events, then `{done, text, …}`.

- **Direct CLI mode.** The routing switch in the Voice page bar (`voice.cliRoute.*`) picks a Claude
  Code, Codex or OpenCode session. Each utterance is typed straight into that session and its reply
  (read from the CLI's own JSONL transcript) is spoken back. Nothing narrates a relay: there is no
  "Sending that to Claude Code", "Passing that to the coder", "<CLI> is still working" or
  "<CLI> is done". The only spoken extras are "Approved."/"Denied." for permission prompts and a
  neutral "Still working on it." on long work. The live CLI terminal (`<voice-terminal-stream>`)
  shows under the session.
- **Gateway agent.** The agent picked in the session (any InfiniBot agent in local mode) answers,
  using the fast path for conversation and the full agent with tools for work. Sub-agents it spawns
  (`claude_coder`, `sessions_spawn`, …) run on the call's session
  `agent:<id>:voicecall-owner:local:<callKey>`. The announce flow treats that key as a voice call
  (`deliver:false`, no WhatsApp fallback). While the line is quiet the local engine polls
  `{poll:true}` every 5 s and speaks the progress and results.

## UI wiring

- `ui/src/ui/controllers/voice-provider.ts` holds the engine choice (`isCloudVoiceActive()`,
  `VOICE_PROVIDER_EVENT`).
- `views/voice-robovoice/call-store.ts` exposes one call API for both engines.
  `local-call-session.ts` is the local engine and `call-session.ts` is Robovoice.
- `voice-console.ts`: in local mode it shows Session plus Settings (Voice engine card and wake
  word). With cloud voice it shows Robovoice's tabs, and the same engine card sits on Account.
- The chat mic and read-aloud (`components/chat-speech.ts`, `controllers/tts.ts`) use local Whisper
  and Kokoro. They use `robovoice.speech.*` only with cloud voice.
- Wake words and voice buttons (`app-render.ts` → `startRobovoiceCallFromIntent`) start a local call
  with no account check.

## Config

`voice.backend` (`auto` | `local` | `robovoice`) is hot-reloaded. The legacy voice keys (`provider`,
`native`, `cloud`, `kokoroUrl`, `speachesUrl`, `livekitUrlExternal`, …) and the voice-setup bridge
(`saveVoiceSetup` → `voice.json`) are back, so existing `~/.infinibot/infinibot.json` and
`voice.json` files validate and are honoured. `SPEACHES_TTS_MODEL` picks the Speaches TTS model
(the default is the first Kokoro model it lists).

## Tests

- Gateway: `src/gateway/server-voice-turn.test.ts`, `src/gateway/voice/provider-registry.test.ts`,
  `src/gateway/voice/voice-cli-turn.test.ts`, `src/gateway/voice/voice-cli-sessions.test.ts`.
- UI: `views/voice-robovoice/local-voice-default.test.ts` and `local-call-session.test.ts`.
- End to end on a side gateway: `scripts/verify-local-voice-side-gateway.mts`.
