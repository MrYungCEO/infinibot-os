---
summary: "CLI reference for `infinibot voicecall` (voice-call plugin command surface)"
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
---

# `infinibot voicecall`

`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.

Primary doc:
- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Common commands

```bash
infinibot voicecall status --call-id <id>
infinibot voicecall call --to "+15555550123" --message "Hello" --mode notify
infinibot voicecall continue --call-id <id> --message "Any questions?"
infinibot voicecall end --call-id <id>
```

## Exposing webhooks (Tailscale)

```bash
infinibot voicecall expose --mode serve
infinibot voicecall expose --mode funnel
infinibot voicecall unexpose
```

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.

