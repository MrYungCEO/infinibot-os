---
summary: "Core voice-provider interface: how voice (realtime/STT/TTS/wake word) is served by the built-in stack or a voice plugin"
read_when:
  - You are writing a plugin that provides voice
  - You are debugging which backend serves a voice session
---
# Voice providers

A **voice provider** is a complete voice backend. The core registry lives in
`src/gateway/voice/provider-registry.ts`. It sits one level above the STT/TTS
adapters in `src/gateway/voice/providers/`, such as Groq or ElevenLabs.

```ts
interface VoiceProvider {
  id: string;                 // also the value of voice.backend
  label: string;
  capabilities: ("realtime" | "stt" | "tts" | "wakeWord")[];
  status(): Promise<{ ready; deployment?; detail?; error?; safety? }>;
  configured?(): boolean;     // sync; auto skips unconfigured plugin providers
  createRealtimeSession?(req: { room?; participant?; agentId?; requestHost?; secure? }):
    Promise<{ url; token; room; participant; characterId?; characterName? }>;
  createStt?(): SttProvider;
  createTts?(): TtsProvider;
  wakeWord?(): { engine; phrases; commercialSafe } | null;
}
```

- **Built-in `local`** (`local-provider.ts`) is always registered. It wraps the existing stack:
  voice.json cloud/native adapters, or the Docker Kokoro/Speaches containers when voice.json is
  absent, plus LiveKit tokens minted by the gateway.
- **Plugins** call `api.registerVoiceProvider(provider)`. Manifest-v2 plugins must declare each id
  in `contributes.voiceProviders`. The id `local` is reserved.
- **Selection** is set by `voice.backend` in `infinibot.json`, which needs no restart:
  - `auto` (the default) uses `local`: voice runs on this machine. A plugin provider serves a
    capability under `auto` only when `local` can't. Enabling or linking a voice plugin never
    switches voice to it; Robovoice is opt-in cloud voice ([LOCAL-DEFAULT.md](../voice/LOCAL-DEFAULT.md)).
  - A provider id selects that provider. If it isn't loaded, voice falls back to `local` and the
    response reports `fellBack`.
  - For each capability, if the selected provider doesn't have it, that capability is served by
    `local`.
- **HTTP**: `GET /api/voice/connection?room=&participant=&agent=` (alias `/api/connection-details`)
  returns `{token, url, room, participant, provider, characterId?}`.
  - Error `{error, code}` statuses come from the provider: 402 when out of credits, 503 when
    unreachable or not configured.
  - 503 with `no_voice_provider` means nothing can serve the request.
- **RPC**: `voice.providers.list` (read) and `voice.providers.select {id}` (write).
- **Safety**: `flagVoiceModels()` from `infinibot/plugin-sdk` labels non-commercial models as
  `self-host-only`: openWakeWord default weights and Piper Lessac voices.

UI: `ui/src/ui/controllers/voice-provider.ts` (engine store), the Voice page's Settings ›
Voice engine card (Local voice (default) / Cloud voice (Robovoice)), `<voice-provider-card>` on
the Robovoice page, and the session header badge (LOCAL or ROBOVOICE).
