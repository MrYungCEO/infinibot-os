---
summary: "InfiniBot voice on the owner's Robovoice location pipeline: Voice page ↔ Robovoice, the location pipeline editor, InfiniBot agents as Robovoice location agents, and InfiniBot (gateway or CLI agent) as the LLM step via a scoped callback"
read_when:
  - You are changing how InfiniBot voice runs on Robovoice
  - You are touching the Robovoice pipeline editor, voice agents or the voice-LLM callback
  - You are implementing the Robovoice side (edge pipeline route, infinibot LLM provider)
---
# Voice ↔ Robovoice location pipeline

Branch `feat/voice-robovoice-pipeline`, built on the linkage work
(`plugin/robovoice`, see [LINKAGE.md](./LINKAGE.md): the install is a Robovoice
location, its agents are characters there).

```
 Voice page (voice-chat.ts)                         Robovoice (cloud or self-hosted)
  badge: ROBOVOICE · CLOUD │ MOCK ORG · INFINIBOT · HOST · LLM INFINIBOT
  /api/voice/connection ──► voice provider "robovoice" ──► POST /api/connection-details (device key, character, location)
         │ (auto: provider error → built-in local)            └─ LiveKit room → Robovoice voice agent
         ▼                                                              STT (location pipeline)
                                                                        LLM step: character llm_provider = "infinibot"
 /plugins/robovoice/voice-llm/v1/chat/completions ◄──────────────────── POST (OpenAI-compatible, stream) Bearer rvllm_… (per location)
   selfAuthHttp, token → location, model infinibot:<agent>
   → api.runtime.host.voiceTurn → gateway agent (agentCommand)  or  CLI agent (claude/codex/opencode/gemini, JSON mode)
   ◄── SSE deltas (first-token timed) ─────────────────────────────────► TTS (location pipeline / agent voice)
```

## 1. Voice page ↔ Robovoice

- With the plugin on and a Robovoice URL/link, `voice.backend=auto` picks the
  `robovoice` provider. Sessions come from Robovoice `connection-details`
  (device key, mapped character, signed location).
- `VoiceProviderStatus.account` (core, `src/gateway/voice/provider-registry.ts`)
  carries `{org, location, locationId, agents, llm}`. The Voice page shows it
  as a second header badge (`MOCK ORG · INFINIBOT · HOST · LLM INFINIBOT`);
  the provider badge still reads `ROBOVOICE · CLOUD`.
- **Voice is core:** local voice is the default (`auto` = local) and nothing
  routes to Robovoice unless the user picks Cloud voice (Robovoice), which is
  free. If Cloud voice can't serve (unreachable, busy or over the daily
  fair-use limit, misconfigured) the user sees "Cloud voice is busy — switch to
  local voice"; when `/api/voice/connection` serves the local session instead it
  reports `fellBack` + `fallbackReason`.

## 2. Location pipeline editor (`/robovoice` → "Location pipeline")

`ui/src/ui/views/robovoice/pipeline-editor.ts` mirrors Robovoice's location
Pipeline tab (`pipeline-tab.tsx` + `settings-scope.tsx`):

- sticky bar: "At <location> · Live voice pipeline for <scope> · swap a stage & apply", Reset location defaults, **Apply live**
- scope card: organization · location picker + "Configure pipeline for:" Global pipeline | an agent
- three stage cards joined by dashed connectors: **1 Speech-to-Text** (#a855f7), **2 Language Model** (#34d399), **3 Text-to-Speech** (#fbbf24); Provider + Model/Voice per stage; providers without an org key disabled
- markers per field: **Overridden here** + *Reset to inherited*, or *Inherited · from organization / location / agent*; "· unsaved" while editing
- footer: "Effective now — STT … · LLM … · TTS …"

Precedence (per field, most specific set value wins): **org → location defaults
→ character → location × character**. Mirrored in
`extensions/robovoice/src/pipeline.ts` from Robovoice's
`lib/location-config.ts` / `src/robovoice/location_config.py` (isSet, per-provider
model keys at the location layer, generic `stt_model`/`llm_model` at the character
layers, a more specific provider switch drops a pinned model). Saving uses
Robovoice's `decide()`: a value equal to what's inherited (or empty) clears the
override; unchanged fields aren't sent.

RPCs: `robovoice.account.get`, `robovoice.location.select`,
`robovoice.pipeline.config.get` (layers + effective per scope + inherited values),
`robovoice.pipeline.config.set` (`{characterId?, values, reset?, resetAll?}`).

## 3. InfiniBot agents as Robovoice location agents

- Per-agent toggle = membership in `linkedAgents`; sync is the linkage's
  `/api/edge/infinibot/agents`, **idempotent by InfiniBot agent id** (resync
  edits the same character; off → the fleet agent is removed, the character kept).
- Per agent: LLM = InfiniBot (default) or the location's own LLM; InfiniBot
  backend (gateway agent / Claude Code / Codex / OpenCode / Gemini); Robovoice TTS
  provider + voice. Stored in `agentOverrides[agent]` (`llm`, `llmBackend`,
  `ttsProvider`, `voice`).
- UI: `<robovoice-agent-voice>` — `variant="row"` on the Robovoice page's
  "Voice agents" list, `variant="card"` in the Agents page **Voice** tab.
- RPCs: `robovoice.voiceAgents.list`, `robovoice.voiceAgent.set`.

### Agents page Voice tab

`ui/src/ui/views/agents-voice-slot.ts` is the single module behind the premium
Agents page drawer's **Voice** tab (`agents-premium.ts` → `getAgentVoiceSlot()`).
Its built-in renderer (`renderAgentVoiceSlot(agentId)`) shows the
`<robovoice-agent-voice variant="card">` settings when the Robovoice plugin is
enabled, a neutral note when it is off, and a pointer to the Backend picker for
virtual `cli:<backend>` nodes. It re-renders on `PLUGIN_HOST_EVENT`, so turning the
plugin on/off updates an open drawer. Another provider can still replace it via
`registerAgentVoiceSlot()`. The old `agents-management.ts` config tabs (and their
`robovoice:voice-slot` lines) are gone — that file now only feeds legacy editors
into the premium page.

## 4. LLM = InfiniBot (voice-LLM callback)

- `POST /plugins/robovoice/voice-llm/v1/chat/completions` — OpenAI-compatible
  (Robovoice's agent already speaks this to InfiniBot through its `moltbot`
  provider). Declared in `contributes.selfAuthHttp`: served before the shared-secret
  gate, **401 without a valid `rvllm_` token**. The gateway password is not accepted.
- Tokens: one per Robovoice location, 32 random bytes, stored AES-GCM-encrypted
  with the install key (`secrets.json`, 0600), checked by SHA-256 in constant time,
  **rotatable** (`robovoice.voiceLlm.rotate` → re-sync), revoked on unlink / org
  change / logout.
- Routing: `model: "infinibot:<agent>"` must name a voice agent at the token's
  location whose LLM is InfiniBot (403 otherwise); backend = the agent's
  `llmBackend`. `user` / `x-robovoice-session` / `metadata.room` key the call so
  context carries across turns (the gateway session, or the CLI's resumed session).
- Core `src/gateway/voice/voice-llm-turn.ts` (`api.runtime.host.voiceTurn`):
  - gateway: `agentCommand` on session `agent:<id>:voicecall:robovoice:<loc>:<call>`,
    streaming assistant deltas, same tool loop as chat;
  - CLI: `claude -p … --output-format stream-json --include-partial-messages`,
    `codex exec --json`, `opencode run --format json`, `gemini -p … --output-format stream-json`,
    one process per turn, resuming the CLI session id per call;
  - first-token and total time per turn (SSE closing chunk `infinibot.first_token_ms`,
    `robovoice.voiceLlm.status` p50, turn table on the page).
- **Trust (W5):** `voicecall:` sessions resolve to `untrusted-sender`
  (`src/routing/sender-trust.ts`): tools narrow to `tools.trust.untrustedTools`
  (default web_search / web_fetch / session_status), no coder/host/session tools,
  CLI turns get no permission bypass and no shell/edit tools. A caller is the owner
  (`voicecall-owner:` → owner trust) only when Robovoice sends
  `metadata.caller = {email, verified: true}` and the email is in
  `ownerCallerEmails` (Robovoice page).

## 5. Secrets

Robovoice credentials (edge token, device key, per-agent MCP tokens, per-location
voice-LLM tokens) stay plugin secrets: encrypted at rest, never returned to the UI
(masked hints only), never in `settings.json`.

## Verification

- Unit: `pnpm vitest run --config vitest.extensions.config.ts extensions/robovoice`
  (`src/voice-pipeline.test.ts`: precedence, sync idempotency, callback auth +
  routing, owner trust, rotation, mock end-to-end) and
  `pnpm vitest run src/gateway/voice/voice-llm-turn.test.ts src/routing/sender-trust.test.ts`.
- E2E: `extensions/robovoice/scripts/voice-pipeline-e2e.sh` — fresh side gateway
  + mock Robovoice + fake OpenAI model + fake Claude CLI (`KEEP=1` keeps it up).

## Robovoice-Prod changes needed (not made here)

1. **Edge pipeline route** `GET|PATCH /api/edge/infinibot/pipeline?location=` for an
   `rve_` token holder with `location.pipeline.edit` on a location in the token's
   org — same body/response and validation as `/api/location/[id]/config` (today
   Clerk-session only), plus `options` (models/voices per stage + provider).
2. **`infinibot` LLM provider** (OpenAI-compatible, like `moltbot`) allowed at the
   character and location×character layers: `llm_provider: "infinibot"`,
   `llm_model: "infinibot:<agent>"`, base URL + token taken from the location's
   voice-LLM binding, never from the settings doc (keeps `SECRETISH` stripping).
3. **Voice-LLM binding store**: accept `voice_llm: {base_url, token, location_id}`
   on `POST /api/edge/infinibot/agents`, store the token encrypted per location
   (like the platform MCP registry), echo `voice_llm: {status, base_url, agents}`;
   drop on unlink.
4. **Agent**: for `infinibot`, POST `<base_url>/chat/completions` with `stream: true`,
   `user: <room>`, `metadata: {location_id, room, caller}`, and speak deltas as they
   arrive; honour the org overlay for tenant orgs (`org_config.py`), where
   per-character providers are currently allowlisted.
5. **Caller identity**: pass `metadata.caller = {email, verified: true}` only for a
   Clerk-signed-in caller (from the signed call token), never client-supplied.
6. **Sync payload**: accept `llm_provider` / `llm_model` on agent sync (currently
   ignored; the character keeps its org LLM).
7. **Pipeline catalog for edge clients**: expose the tiered catalog
   (`/api/pipeline/catalog`) or a key-free subset to `rve_` tokens so the editor's
   model / voice lists match Robovoice's pickers.
