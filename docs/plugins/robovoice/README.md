---
summary: "Robovoice plugin: voice provider for InfiniBot — setup, character mapping, safety labels, migration from the ad-hoc proxy + MCP bridge"
read_when:
  - You are connecting InfiniBot voice to Robovoice
  - You are migrating from voice.robovoiceUrl / the :8793 MCP bridge
---
# Robovoice plugin (`extensions/robovoice`)

First-party manifest-v2 plugin (id `robovoice`) that registers the **`robovoice`
voice provider** with the core voice-provider registry
([voice-providers.md](../voice-providers.md)). When it is on, InfiniBot's voice
page gets its LiveKit session from Robovoice: the mapped Robovoice character
answers, running Robovoice's own STT → LLM → TTS pipeline.

Voice is core. The built-in `local` provider (voice.json cloud/native stack,
Kokoro/Speaches/LiveKit Docker) is always there, so voice keeps working with the
plugin off. On fresh installs the plugin is **bundled and off**. Robovoice is the
**optional, free cloud voice** for devices that can't run voice locally: turning the plugin on or linking
it does not switch voice; the owner picks "Cloud voice (Robovoice)" under Voice › Settings › Voice
engine (`voice.backend: "robovoice"`). See [LOCAL-DEFAULT.md](../../voice/LOCAL-DEFAULT.md).

## What it does

| Piece | Where |
| --- | --- |
| Voice provider (`realtime`) | `src/provider.ts`: `connection-details` on Robovoice with the edge-device credentials and the mapped character |
| Robovoice HTTP client | `src/client.ts`: `/api/health`, `/api/call/characters`, `/api/call/pipeline`, `POST /api/connection-details`, `/api/edge/me` |
| Agent → character mapping | `src/character-map.ts`: explicit agent id, or the agent encoded in the voice room name `voice-emp_<enc>-<uuid>`, then the default character, then Robovoice's own choice |
| Settings + secrets | `src/settings.ts`: install-wide `<sharedDir>/plugin-data/robovoice/settings.json`; secrets in `secrets.json` (0600, AES-256-GCM with the install key) or env `ROBOVOICE_DEVICE_KEY` / `ROBOVOICE_EDGE_TOKEN` |
| **SaaS link** (install = Robovoice location) | `src/link.ts`, `src/edge-api.ts` — see [LINKAGE.md](./LINKAGE.md) |
| CLI `infinibot robovoice …` | `src/cli.ts` (login, logout, status, agents, link, unlink, call, sync, mcp) |
| Agent tool `robovoice_call` | `src/tool.ts` |
| Per-agent MCP (scoped tokens) | `/plugins/robovoice/agent-mcp` (`src/agent-mcp.ts`, manifest `selfAuthHttp`) |
| Commercial safety | `src/safety.ts`: labels openWakeWord default weights and Piper Lessac voices "self-host only"; on a cloud deployment these are an error |
| MCP for Robovoice characters | `/plugins/robovoice/mcp` (`src/mcp.ts`) |
| Settings page | `ui/src/ui/views/robovoice/index.ts` (`/robovoice`, Settings group, plugin-gated) |
| Mock Robovoice | `test/mock-robovoice-server.ts`, `test/mock-robovoice-cli.ts` (test fixtures only — never imported by runtime code; `test/real-data-guard.test.ts` enforces it) |

The plugin bundles **no models**.

RPCs: `robovoice.status`, `robovoice.settings.get` / `.set` (admin), `robovoice.secrets.set` (admin),
`robovoice.test` (admin; health + roster only, never connection-details, which would place a billing
hold), `robovoice.characters.list`, `robovoice.mapping.set` / `.resolve`, `robovoice.pipeline.get`,
`robovoice.credits.get`; linkage: `robovoice.link.*`, `robovoice.agents.*`, `robovoice.call.*`,
`robovoice.unlink`, `robovoice.logout` ([LINKAGE.md](./LINKAGE.md)).

## Migration for the owner's live setup

Do these in order. None of them touches the Robovoice Docker stack.

1. **Deploy the branch** (merge `plugin/robovoice` after `feat/plugin-platform-design`). Run
   `pnpm build`, then `pnpm -C ui build`, then restart the gateway. On its own this changes
   nothing: the plugin is bundled but off, so voice stays on `local`.
2. **Turn it on.** Setup › Voice › "Turn on Robovoice", or run
   `plugins.setEnabled {id:"robovoice", enabled:true}`. The gateway restarts in-process.
   Existing `voice.robovoiceUrl` / `ROBOVOICE_URL` is picked up as the Robovoice URL automatically.
3. **Connect.** On the `/robovoice` page:
   - Pick Self-hosted, with URL `http://192.168.1.110:3011`. Note: the MagicDNS host serves InfiniBot, not Robovoice.
   - Set an edge device id, e.g. `infinibot-gateway`.
   - If the dashboard runs the strict device policy, paste the device key:
     `base64url(HMAC-SHA256(DEVICE_KEY_SECRET, "robovoice-device:"+id))[:32]`.
   - Click Test connection. This only calls health and characters.
   - For Robovoice cloud, pick Cloud, use `https://robovoice.io`, and paste the `rve_…` edge token from `robovoice login`.
4. **Map characters.** Map `main` and any AI-employee agents to Robovoice characters (for example
   `main` → your owner character), and optionally set a default character.
5. **Verify a call** from the voice page. The header badge should read `ROBOVOICE · SELF-HOSTED`,
   and the log line reads `Voice via robovoice · character <id>`. To go back, pick
   "Built-in voice" in Setup › Voice (sets `voice.backend=local`, no restart).
6. **MCP bridge → plugin route (optional, when ready).** In Robovoice settings `mcp_servers`, add
   `{url: "http://host.docker.internal:18789/plugins/robovoice/mcp", transport: "streamable_http", auth_token: <gateway token>}`
   next to the existing `:8793` entry. Test with a trusted character, then retire
   `scripts/infinibot-mcp-http.mjs`. Limitation: tools/list schemas are permissive until the host
   exposes `runtime.tools` (HOST-API-NEEDS §C).
7. **Legacy proxy.** `server-voice-proxy.ts` (`voice.robovoiceUrl` → `/api/{voices,settings,wake,setup}`)
   is kept unchanged for compatibility. Once nothing calls those paths on the gateway, remove
   `voice.robovoiceUrl` and set the URL only in the plugin.

## Commercial-safety rules

- Robovoice's default wake word `models/hey_jarvis.onnx` (openWakeWord pretrained, CC-BY-NC-SA)
  and Piper `en_US-lessac-*` voices are labelled **Self-host only**. The plugin never downloads or
  ships them.
- On a `cloud` deployment the provider status error reads "Non-commercial model in use on a cloud
  deployment". It does not block calls; it tells the operator to swap the model before charging for
  calls.
- InfiniBot's own wake word (browser, local whisper) doesn't use openWakeWord.

## Isolated end-to-end check

`extensions/robovoice/scripts/side-gateway-e2e.sh` (needs `pnpm build`, node ≥ 22) starts a fresh
side gateway (`/tmp/rv-e2e`, port 19021) and the mock Robovoice (19022) with a scrubbed env. It then
checks: local sessions, auth, provider list, enabling the plugin, "auto stays local until
configured", masked 0600 secrets, test/credits/mapping/safety RPCs, Robovoice sessions with the
mapped character, provider switching without restart, the plugin connection route and the MCP
endpoint. It prints PASS/FAIL per check and exits with the fail count. `KEEP=1` leaves the servers
up for screenshots; `PHASE=local` stops after the plugin-off checks. It refuses to run if the
checkout has a `.env`.
