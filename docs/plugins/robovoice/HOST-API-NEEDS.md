---
summary: "Every core / plugin-host API the Robovoice plugin uses, adds, or still needs (host API v0 → v2 manifest)"
read_when:
  - You are changing the plugin host or the voice-provider interface
  - You are hardening the Robovoice plugin
---
# Robovoice plugin — host API needs

The plugin host API is **v0** (manifest v2, `infinibot-plugin-api` `2.0.0`, branch
`feat/plugin-platform-design`). This file records every host/core surface the
`robovoice` plugin touches, split into what already existed, what this branch
added, and what's still missing. Branch: `plugin/robovoice`.

## A. Existing host APIs used (unchanged)

| API | Used for |
| --- | --- |
| Manifest v2 `contributes.nav` / `pages` (`builtin: "robovoice"`) | Settings sidebar entry + plugin-gated `/robovoice` page |
| Manifest v2 `contributes.rpc` with `read`/`write`/`admin` scopes | 10 `robovoice.*` RPCs (settings/secrets/test are admin; mapping is write; reads are read) |
| Manifest v2 `contributes.http` + `api.registerHttpRoute` | `/plugins/robovoice/connection-details`, `/plugins/robovoice/mcp` (behind the gateway HTTP auth gate: `/plugins/` is a protected prefix) |
| `api.registerGatewayMethod` | the RPCs |
| `api.runtime.state.resolveStateDir()` | `<stateDir>/plugin-data/robovoice/{settings,secrets}.json` |
| `api.pluginConfig` / `configSchema` / `uiHints` | declarative defaults (`baseUrl`, `deployment`, `deviceId`, …) |
| `api.config.voice.robovoiceUrl` + `ROBOVOICE_URL` | legacy URL fallback during migration |
| `plugins.setEnabled` (admin RPC) | "Turn on Robovoice" in Setup › Voice |
| `infinibot/plugin-sdk` alias (jiti) | `VoiceProviderError`, `flagVoiceModels`, types |

## B. Core / host APIs ADDED on this branch

Every core change, with file:

1. **Voice-provider registry (new core interface)** — `src/gateway/voice/provider-registry.ts`
   - `VoiceProvider { id, label, description?, capabilities: ("realtime"|"stt"|"tts"|"wakeWord")[], status(), createRealtimeSession?(req), createStt?(), createTts?(), wakeWord?() }`
   - `registerBuiltinVoiceProvider`, `listVoiceProviders`, `resolveVoiceProvider(capability, backend?)`, `configuredVoiceBackend`, `activeVoiceProviderId`, `VoiceProviderError` + `isVoiceProviderError` (duck-typed; plugins may load a second module copy).
   - Selection: `voice.backend` = `"auto"` (default: always `local`; Robovoice is used only when the user picks it by id) | provider id. Missing provider → falls back to `local` with `fellBack: true`. Missing capability → that capability served by `local`.
2. **Built-in `local` provider** — `src/gateway/voice/local-provider.ts` (wraps the existing voice.json / Docker / LiveKit stack; unchanged behaviour).
3. **Plugin API: `api.registerVoiceProvider(provider)`** — `src/plugins/types.ts`, `src/plugins/registry.ts` (`PluginRegistry.voiceProviders?`, optional so hand-built registries stay valid). Rejects undeclared ids (v2), duplicates, and the reserved `local` id.
4. **Manifest v2: `contributes.voiceProviders: string[]`** — `src/plugins/manifest-v2.ts`.
5. **Plugin SDK exports** — `src/plugin-sdk/index.ts`: voice-provider types, `VoiceProviderError`, `flagVoiceModels`, `isLessacVoice`, `isOpenWakeWordDefaultModel`.
6. **Commercial-safety flagger** — `src/gateway/voice/commercial-safety.ts` (openWakeWord default weights, Piper Lessac voices → `self-host-only`).
7. **`/api/voice/connection` + `/api/connection-details` delegate to the active provider** — `src/gateway/server-voice-connection.ts`. Response keeps `{token,url,room,participant}` and adds `provider`, `characterId`, `characterName`, `fellBack`. Provider errors map to their HTTP status (402 over the fair-use limit — shown as "Cloud voice is busy — switch to local voice", 503 unreachable/not configured, 503 `no_voice_provider`). Token minting moved into exported `mintLocalLivekitSession()` (same grants/TTL/URL derivation as before). New `?agent=` query param.
8. **RPCs `voice.providers.list` (read) / `voice.providers.select` (write)** — `src/gateway/server-methods/voice-providers.ts`, registered + scope-classified in `src/gateway/server-methods.ts`.
9. **Config `voice.backend`** — `src/config/zod-schema.ts`, `src/config/types.infinibot.ts`; reload rule `voice.backend → none` in `src/gateway/config-reload.ts` (re-read per request, no restart).
10. **UI**: `FIRST_PARTY_PAGES.robovoice` (plugin-host.ts), `robovoice` Tab in navigation.ts, lazy view, app-render gate; `<voice-provider-card>`; voice-chat provider badge; `getToken(room, participant, agentId)`.

11. **Linkage branch additions** (see LINKAGE.md):
    - Manifest v2 `contributes.selfAuthHttp` (subset of `http`): routes the plugin authenticates itself, dispatched before the shared-secret gate — `src/plugins/manifest-v2.ts`, `src/plugins/registry.ts` (`PluginHttpRouteRegistration.selfAuth`), `src/gateway/server/plugins-http.ts` (`isSelfAuthRoute`), `src/gateway/server-http.ts`.
    - `api.runtime.state.resolveSharedDir()` — install-wide dir (never per profile) for provider credentials/links — `src/plugins/runtime/{index,types}.ts`.
    - Plugin SDK: `encryptInstallSecret` / `decryptInstallSecret` (the per-install AES-GCM key email accounts use), `resolveSelfCallAuthHeaders`, `listAgentPersonas` (`src/plugins/agent-personas.ts`).
    - CLI: `robovoice` in `EXIT_AFTER_COMMANDS` (`src/cli/run-main.ts`) — plugin commands otherwise hang on import-time timers.
    - `main.toolsAllow` += `robovoice_call` (`src/agents/standard-roster.ts`).

## C. Still needed from the host (not built — worked around)

| Need | Why | Workaround today |
| --- | --- | --- |
| **Plugin secret store** (`api.secrets.get/set`, per-plugin, honouring `permissions.secrets`) | Device key + edge token + per-agent MCP tokens | `secrets.json` (0600) in the install-wide plugin dir, every value encrypted with the install key via the SDK's `encryptInstallSecret`; env fallbacks. Never returned to the UI (masked hint only). |
| **`api.runtime.tools.list()/invoke(name,args,{sessionKey})`** with JSON schemas | MCP `tools/list` needs real input schemas | `/plugins/robovoice/mcp` advertises a permissive object schema and calls tools via loopback `POST /tools/invoke` with the caller's bearer. Keep the legacy bridge for characters that need precise schemas. |
| **Plugin page contribution to an existing host page** (e.g. `contributes.setupSections`) | Offer Robovoice inside Setup › Voice without core knowing the plugin id | `<voice-provider-card>` in core reads `plugins.list` for `robovoice` by id. |
| **Plugin → core event emit** (`api.events.emit("voice.providers.changed")`) | UI refresh when provider readiness changes | UI polls/refreshes on load and after saves. |
| **Per-plugin network allowlist enforcement** (`permissions.network`) | Declared but not enforced by host | Manifest declares `<configured Robovoice URL>`; the plugin only calls `settings.baseUrl`. |
| **Config write API scoped to `plugins.entries.<id>.config`** without restart | Settings live in state files instead of config | `settings.json` in plugin state dir; config stays declarative. |
| **HTTP route prefix declarations** (`/plugins/robovoice/api/*`) | A transparent proxy for the old `/api/{voices,settings,wake,setup}` Robovoice routes | Not proxied; see migration. Legacy `server-voice-proxy.ts` kept unchanged. |
| **STT/TTS streaming via provider** | Robovoice exposes no HTTP STT/TTS; the HTTP `/api/voice/stt|tts` handlers still route by voice.json | Robovoice is `realtime`-only; registry serves stt/tts from `local`. When a provider does offer `createStt/createTts`, `server-voice-stt/tts.ts` still need a 3-line delegate (not added — no provider uses it yet). |

## D. Robovoice-side needs

- **Done on `feat/infinibot-link`** (needs deploy): `/api/edge/infinibot/{link,agents,calls}`, `edge_infinibot_links`, `queueCommand` `character_id` hint. `GET /api/edge/me` already returns `credits` (`walletCredits`: `available_credits`, `held_credits`, `credit_usd`, `standard_credits_per_second`, …) — the plugin reads that (the old `wallet` USD shape is still accepted).
- **Robovoice Desktop**: honour `pending_command.character_id` on `start_call` (`electron/src/main/calls.ts#handleCommand`; desktop branch owns it). Until then Desktop starts its active agent.
- **Per-tenant MCP registry**: tenant org documents strip `mcp_servers`; per-agent InfiniBot tools on tenant orgs need an org-scoped MCP registry read by `src/robovoice/org_config.py` (agent deploy).
- **Wake-word model in the public pipeline** (`/api/call/pipeline`) so the safety label doesn't depend on the owner typing it in.
- **`?character=` for connection-details is honoured only when the character exists**; mapping UI shows `(missing)` for stale ids.
