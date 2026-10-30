---
summary: "Robovoice linkage: an InfiniBot install signs in to a Robovoice org, becomes a Robovoice LOCATION with its own edge device, its agents become callable characters, calls are free (measured for fair use); CLI, tool, per-agent MCP"
read_when:
  - You are linking InfiniBot to robovoice.io (or a self-hosted Robovoice with edge routes)
  - You are changing the Robovoice plugin's CLI, tool, link RPCs or agent MCP
  - You are deploying the Robovoice side (feat/infinibot-link)
---
# Robovoice linkage (InfiniBot ⇄ Robovoice SaaS)

Cloud voice (Robovoice) is optional and free. Local voice is InfiniBot's
default; linking only matters if the user picks Cloud voice. Robovoice still
measures usage (the `credits_*` / `billable_seconds` fields below are the
upstream API's names for that measurement) to keep things fair, with a daily
fair-use limit. The user never sees credits, a wallet or a top-up; when cloud
voice is busy or over the limit, the UI says "Cloud voice is busy — switch to
local voice".

`infinibot robovoice login` (or **Link to Robovoice** in the UI) signs this
InfiniBot install in to a Robovoice organization with the same browser-approved
device-code flow the `robovoice` edge CLI and Robovoice Desktop use. From then on:

- **The install is a Robovoice location** — "InfiniBot · <hostname>", created
  once and reused forever, keyed by a stable install id (never by name).
- **It has its own edge device there** (HMAC device key), so it shows in the
  location's Fleet / EdgeDevicesPanel, heartbeats, commands, analytics and usage
  like any robot.
- **Its agents are characters at that location** — `main` (INFINI) by default,
  more with `link <agent>`; each is a fleet agent (web-call kind) whose persona
  comes from the agent's identity, mirrored into the org's callable roster.
- **Calls are free** (usage measured for fair use) — a web call link on
  Robovoice cloud, or Robovoice Desktop's local pipeline.

One org per install. Everything (token, device key, link state, agent map) is
install-wide: `<INFINIBOT_STATE_DIR|~/.infinibot>/plugins/robovoice/`, shared by
every user profile (providers and credentials are shared per install; profiles
only isolate data).

## Architecture

```
 InfiniBot install (gateway :18789 + CLI)                          robovoice.io  (Next.js on Netlify + Neon)
 ┌──────────────────────────────────────────────┐                  ┌───────────────────────────────────────────────┐
 │ extensions/robovoice                         │  device code     │ /api/edge/auth/{start,token,approve,logout}   │
 │  link.ts   RobovoiceLinkService ─────────────┼─────────────────►│   → rve_… org token (fleet.manage approver)   │
 │  edge-api.ts                                 │  Bearer rve_…    │ /api/edge/infinibot/link    (GET/POST/DELETE) │
 │  settings.ts  install id, link state,        ├─────────────────►│   edge_infinibot_links (org, install) ─┐      │
 │               AES-GCM secrets (install key)  │                  │   locations "InfiniBot · host" ◄───────┤      │
 │  cli.ts     infinibot robovoice …            │                  │   registerDevice → edge_devices+robots ◄┘     │
 │  tool.ts    robovoice_call                   │                  │ /api/edge/infinibot/agents  (POST)            │
 │  index.ts   robovoice.link.* / agents.* /    │                  │   characters (persona) + robots (website kind)│
 │             call.* RPCs                      │                  │   → agent-settings bridge → callable roster   │
 │  provider.ts voice provider (device creds)   │  connection-     │   (owner: settings.json; tenant: org:<id> doc)│
 │                                              ├─ details ───────►│ /api/connection-details (device key)          │
 │  agent-mcp.ts /plugins/robovoice/agent-mcp ◄─┼── MCP, Bearer ───┤ voice agent (LiveKit) — character.mcp_servers │
 │     token → agent X → /tools/invoke as X     │   rvib_ (per X)  │   → platform MCP registry "infinibot-<X>"     │
 │  ui: <robovoice-link> (card + /robovoice)    │                  │ /api/edge/infinibot/calls  (POST/GET/DELETE)  │
 └──────────────────────────────────────────────┘                  │   cloud: /call/<character>?location=…         │
          │ start_call {character_id}                              │   local: queueCommand → Robovoice Desktop     │
          ▼                                                        │   status: LiveKit room + billing_holds +      │
 Robovoice Desktop (same org, heartbeats) ◄─────────────────────────┤           billing_usage_sessions (credits)    │
                                                                   └───────────────────────────────────────────────┘
```

### Idempotency and lifecycle

| Action | Robovoice side | InfiniBot side |
| --- | --- | --- |
| `login` / Link (first) | link row for (org, install id) → new location "InfiniBot · host" (+ caller as location member) → `registerDevice` (device id `infinibot-<sha256(org:install)[:16]>`) → agents synced | token + device key stored encrypted; `baseUrl`, `deviceId`, `locationId` set; `characterMap` filled |
| `login` again / relink | same link row (row lock) → same location, same device (revoked one is restored) | same install id; different org ⇒ old device key + map dropped |
| location deleted in Robovoice | next link recreates it (status reports `location_missing`) | — |
| `unlink` | device revoked (call ended, robot retired), link `unlinked_at` set, **location + agents kept** | device key + MCP tokens dropped; status shows "unlinked (location kept)" |
| `logout` | unlink (unless `--keep-device`) + token revoked | all secrets removed |

### Agents ↔ characters

`sync` sends every linked agent (default `["main"]`) to `/api/edge/infinibot/agents`:

- **Managed** (default, `link <agent> [--create]`): InfiniBot owns the persona.
  A `characters` row ("INFINI · InfiniBot") + a `robots` row (kind `website`,
  `website_url` = the agent's call link) at the install's location; the existing
  agent-settings bridge mirrors it into the callable roster. InfiniBot writes
  `system_prompt` (a short voice persona from the agent's name + role line —
  not the long text-chat prompt), `greeting`, `description`, `language`, voice;
  `infinibot_agent_id`, `infinibot_managed: true` tag it. Resync edits in place.
- **Linked** (`link <agent> --character <id>`): an existing character is claimed
  by a fleet agent at the location (`fleet_agent_id`), so it appears there; its
  prompt/voice stay as edited in Robovoice. Refused if another fleet agent
  already voices it.
- Overrides per agent: `--name`, `--voice`, `--tts`, `--language` (stored in
  `agentOverrides`).
- `unlink <agent>` deletes the fleet agent at the location; the character stays
  (a handed-out link stops working when someone deletes the character, never as
  a side effect — the bridge's rule).

### Robovoice → InfiniBot tools (settled design)

Each linked agent X gets its own MCP server entry in Robovoice:

```
mcp_servers[]: { id: "infinibot-X", url: "<public gateway url>/plugins/robovoice/agent-mcp?agent=X",
                 transport: "streamable_http", auth_token: "rvib_…" (scoped to X), enabled: true }
character X:   mcp_servers: ["infinibot-X"]
```

- The token is minted per agent, stored encrypted, verified by hash in constant
  time. **The token decides the agent**; `?agent=` must match or it's 403.
- `/plugins/robovoice/agent-mcp` is declared in the manifest's
  `contributes.selfAuthHttp`, so the gateway dispatches it before the shared-secret
  gate (like signed webhooks); without a valid `rvib_` token it answers 401.
- Tools run **as X**: `POST /tools/invoke` on loopback with the gateway's own
  credential and `sessionKey: agent:X:robovoice`, so X's tool policy
  (`agents.list[X].tools.allow`) applies; the plugin allowlist (`mcpTools`,
  default = the old bridge's curated list) narrows further.
- **Never exposed** regardless of allowlists: `gateway`, `exec`, `process`,
  `bash`, `apply_patch`, `infinibot_terminal` (also enforced on the older
  gateway-token `/plugins/robovoice/mcp`).
- Needs a URL Robovoice's voice agent can reach: `infinibot robovoice mcp --url
  https://<host>.ts.net` (Tailscale Funnel / tunnel). Without it, no binding is
  sent and characters talk without tools.
- Robovoice stores MCP servers only in the **platform** settings (owner org);
  tenant org documents strip `mcp_servers`/`allowed_tools` by design, so for a
  tenant org the sync reports `mcp.status = "unsupported"`. Per-tenant tool
  grants need Robovoice-side support (a per-org MCP registry read by
  `src/robovoice/org_config.py`).
- Rotation: `unlink <agent>`, `unlink`, `logout` and `mcp --off` revoke tokens;
  the next sync mints new ones.
- The host bridge (`Robovoice-Prod/scripts/infinibot-mcp-http.mjs` on :8793, one
  allowlist, all calls as `main`) keeps working for the self-hosted stack; migrate
  characters to the per-agent entries, then retire it.

## Calls

| Mode | How | Usage (free, fair use) | Watch |
| --- | --- | --- | --- |
| cloud (default when Desktop isn't running) | `/call/<character>?mode=voice&autostart=1&location=<install location>` — open it (`--open`) | measured against the org's fair-use limit (tenant org via the character/location) | room `robopark-<character>`: LiveKit participants + active hold, then `billing_usage_sessions` since start → usage |
| local (`--local`, or auto when Robovoice Desktop runs here) | `start_call` command (with `character_id`) to the org's online Desktop (same hostname first) | Desktop's local-rate hold → settle (`edge_local_calls`) | Desktop device room + `edge_local_calls` |
| phone | not offered — Robovoice has phone *agents* (inbound) but no outbound-call API | — | — |

Robovoice Desktop today starts its **active** agent on `start_call`; honouring
the new `character_id` hint is a one-line change in
`electron/src/main/calls.ts#handleCommand` (owned by the desktop branch).

## CLI reference — `infinibot robovoice`

| Command | What it does |
| --- | --- |
| `login [--api <url>] [--no-open] [--json]` | Device-code sign-in (prints the code + approval URL, opens the browser), then links: location + device + agent sync. Default API `https://robovoice.io` (or `ROBOVOICE_API`). |
| `logout [--keep-device]` | Retire the device (unless `--keep-device`), revoke the token, delete local credentials. |
| `status [--json] [--offline]` | Link, org, location (+ dashboard URL), device + state, usage (minutes this month), agents, agent-tools binding. |
| `agents [--json]` | Every InfiniBot agent, ● when it's at the location, its character. |
| `link <agent> [--character <id> \| --create] [--voice <id>] [--tts <provider>] [--language <code>] [--name <n>]` | Give an agent a character at the location (create/keep a managed one, or attach an existing one). |
| `unlink [agent]` | No agent: retire the device, keep the location. With an agent: detach it. |
| `call <agent> [--local \| --cloud] [--open] [--no-wait] [--json]` | Start a call; prints the link (or the Desktop that starts it), waits for connect → end, prints duration and measured seconds. |
| `sync` | Re-send linked agents (persona, voice, language, MCP binding). |
| `mcp [--url <public gateway url> \| --off]` | Per-agent tools on calls (binds on the next sync; `--off` revokes tokens). |

`robovoice` is a one-shot command (in `EXIT_AFTER_COMMANDS`), so it exits when done.

## Agent tool — `robovoice_call`

`{ action: "start" | "status" | "end" | "link_status", agent?, mode?: "auto"|"cloud"|"local", room?, since? }`

- `start` → `{ url, room, since, mode, desktop, credits_available, tell_user }` (agent defaults to the caller).
- `status` → `{ live, participants, billable_seconds, credits_used, credits_available }`.
- `end` → hangs up the room (own org only). `link_status` → org, location, device, agents, credits.

Allowlist trap (see memory "OmniTrade show_panel"): the tool is registered by the
plugin (it reaches the tool list through `resolvePluginTools` in
`src/agents/infinibot-tools.ts`) and `main.toolsAllow` in
`src/agents/standard-roster.ts` now lists it. **A live install must also add it
to `agents.list[<main index>].tools.allow` in `~/.infinibot/infinibot.json`**
(and to any other agent that should place calls), then restart the gateway.

## RPCs (manifest scopes)

`robovoice.link.status` (read) · `robovoice.link.start` / `.cancel` / `.sync`,
`robovoice.unlink`, `robovoice.logout`, `robovoice.agents.link` / `.unlink` (admin) ·
`robovoice.agents.list`, `robovoice.call.status` (read) · `robovoice.call.start` /
`.end` (write).

## Robovoice side (branch `feat/infinibot-link`)

- `frontend/db/migrations/2026_09_edge_infinibot.sql` + runtime guard
  `ensureEdgeInfinibotSchema()` (`frontend/lib/edge/schema.ts`).
- `frontend/lib/edge/infinibot.ts`: `linkInstall`, `syncAgents`, `linkStatus`,
  `unlinkInstall`, `startAgentCall`, `callStatus`, `endCall`, `infinibotManager`
  (edge token or session; the approving user must still have `fleet.manage`).
  Reuses `registerDevice`, `upsertRobot`, `syncAgentToSettings`, `slugify`,
  `DEFAULT_RULES`, `walletCredits`, `queueCommand` (now with an optional
  `character_id`), `endDeviceCall`, `revokeDevice`.
- Routes: `frontend/app/api/edge/infinibot/{link,agents,calls}/route.ts`.
- `@robovoice/edge`: `infinibotLink/Status/Unlink/SyncAgents/Call`, `callStatus`,
  `endCallRoom` + typings + README.

## Rollout (what needs a deploy / restart / config)

1. **Robovoice**: deploy `feat/infinibot-link` (frontend only; no `lk agent deploy`
   needed — the voice agent already reads character `mcp_servers`). The migration
   also runs at runtime on first use.
2. **InfiniBot**: merge `plugin/robovoice`, `pnpm build` then `pnpm -C ui build`,
   restart the gateway (new plugin code, `selfAuthHttp` host support,
   `resolveSharedDir`, SDK exports).
3. **Config**: add `"robovoice_call"` to `agents.list[main].tools.allow`
   (live config; the roster default only seeds new installs).
4. `infinibot robovoice login` (approve as an org admin / fleet manager).
5. Optional tools on calls: expose the gateway (Tailscale Funnel) and
   `infinibot robovoice mcp --url https://<host>.ts.net`.

## Verification

- Unit: `pnpm vitest run --config vitest.extensions.config.ts extensions/robovoice`
  (settings encryption, login → link idempotency, unlink/relink, deleted
  location, agents, MCP scoping, calls, CLI, tool) + host tests
  (`src/plugins/manifest-v2.test.ts`, `src/gateway/server/plugins-http.test.ts`,
  `src/plugins/agent-personas.test.ts`, `src/cli/run-main.test.ts`).
- E2E: `extensions/robovoice/scripts/side-gateway-e2e.sh` — isolated side gateway
  + mock SaaS (`test/mock-robovoice-server.ts` implements the edge + InfiniBot
  routes with the server's semantics).
