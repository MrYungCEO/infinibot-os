# @infinibot/voice-call

Official Voice Call plugin for **InfiniBot**.

Providers:
- **Twilio** (Programmable Voice + Media Streams)
- **Telnyx** (Call Control v2)
- **Plivo** (Voice API + XML transfer + GetInput speech)
- **Mock** (dev/no network)

Docs: `https://infinibotos.com/docs/plugins/voice-call`
Plugin system: `https://infinibotos.com/docs/plugin`

## Install (local dev)

### Option A: install via InfiniBot (recommended)

```bash
infinibot plugins install @infinibot/voice-call
```

Restart the Gateway afterwards.

### Option B: copy into your global extensions folder (dev)

```bash
mkdir -p ~/.infinibot/extensions
cp -R extensions/voice-call ~/.infinibot/extensions/voice-call
cd ~/.infinibot/extensions/voice-call && pnpm install
```

## Config

Put under `plugins.entries.voice-call.config`:

```json5
{
  provider: "twilio", // or "telnyx" | "plivo" | "mock"
  fromNumber: "+15550001234",
  toNumber: "+15550005678",

  twilio: {
    accountSid: "ACxxxxxxxx",
    authToken: "your_token"
  },

  plivo: {
    authId: "MAxxxxxxxxxxxxxxxxxxxx",
    authToken: "your_token"
  },

  // Webhook server
  serve: {
    port: 3334,
    path: "/voice/webhook"
  },

  // Public exposure (pick one):
  // publicUrl: "https://example.ngrok.app/voice/webhook",
  // tunnel: { provider: "ngrok" },
  // tailscale: { mode: "funnel", path: "/voice/webhook" }

  outbound: {
    defaultMode: "notify" // or "conversation"
  },

  streaming: {
    enabled: true,
    streamPath: "/voice/stream"
  }
}
```

Notes:
- Twilio/Telnyx/Plivo require a **publicly reachable** webhook URL.
- `mock` is a local dev provider (no network calls).
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` allows Twilio webhooks with invalid signatures **only** when `tunnel.provider="ngrok"` and `serve.bind` is loopback (ngrok local agent). Use for local dev only.

## TTS for calls

Voice Call uses the core `messages.tts` configuration (OpenAI or ElevenLabs) for
streaming speech on calls. You can override it under the plugin config with the
same shape — overrides deep-merge with `messages.tts`.

```json5
{
  tts: {
    provider: "openai",
    openai: {
      voice: "alloy"
    }
  }
}
```

Notes:
- Edge TTS is ignored for voice calls (telephony audio needs PCM; Edge output is unreliable).
- Core TTS is used when Twilio media streaming is enabled; otherwise calls fall back to provider native voices.

## CLI

```bash
infinibot voicecall call --to "+15555550123" --message "Hello from InfiniBot"
infinibot voicecall continue --call-id <id> --message "Any questions?"
infinibot voicecall speak --call-id <id> --message "One moment"
infinibot voicecall end --call-id <id>
infinibot voicecall status --call-id <id>
infinibot voicecall tail
infinibot voicecall expose --mode funnel
```

## Tool

Tool name: `voice_call`

Actions:
- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

## Gateway RPC

- `voicecall.initiate` (to?, message, mode?)
- `voicecall.continue` (callId, message)
- `voicecall.speak` (callId, message)
- `voicecall.end` (callId)
- `voicecall.status` (callId)

## Notes

- Uses webhook signature verification for Twilio/Telnyx/Plivo.
- `responseModel` / `responseSystemPrompt` control AI auto-responses.
- Media streaming requires `ws` and OpenAI Realtime API key.
