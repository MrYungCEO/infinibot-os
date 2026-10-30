---
title: Federation
description: How InfiniBot meshes multiple machines into one agent fabric — master/satellite roles, what crosses the wire, and how to set it up.
---

# Federation

InfiniBot can run as a single instance on one machine, or as a **mesh of many machines** sharing one agent fabric. This page is the deep-dive: what federation actually does, what crosses the wire, what stays local, and how to set it up.

> If you only ever run one machine, you can skip this — InfiniBot works fine standalone. Federation is what you turn on when you want **one master orchestrating multiple devices** (laptop + desktop + home server + phone), each contributing their own resources.

## Mental model

Pick one machine to be your **master**. The master runs a `FederationHub` that other gateways connect into.

Every other gateway runs as a **satellite**. The satellite dials the master over WebSocket and stays connected. From that point on, the master can:

- Read the satellite's local resource registry (projects, agents, MCP servers, directories, terminals)
- Spawn sessions on the satellite (`session.spawn`, `session.send`)
- Proxy arbitrary RPC into the satellite's gateway (`gateway.proxy.invoke`) — this is what powers cross-device terminals, cross-device voice, cross-device tool calls
- Receive event streams back from the satellite (`event.broadcast`) — terminal output, chat tokens, agent metrics

The satellite stays a fully working gateway in its own right. UI clients connected directly to a satellite still work. Federation just adds an extra plane.

Conceptually:

```
                       UI (web/app)
                          │
                          ▼
   ┌─────────────── MASTER GATEWAY ───────────────┐
   │  agents · sessions · MCPs · terminals · UI    │
   │  FederationHub  ◄────────────────────────────┐│
   └──────────────────│───────────│──────────────┘│
                      │           │               │
                  ws  │       ws  │           ws  │
                      ▼           ▼               ▼
              SATELLITE A  SATELLITE B    SATELLITE C
              (your Mac)   (home server)  (gaming desktop)
              Ollama,      Cron,          GPU LLM,
              voice,       backups,       comfy UI,
              terminal     scheduling     long-running tools
```

## Roles

### Master

Has `gateway.federation.mode = "master"` and a known `federationPort`. Hosts the hub. Browser UIs connect to the master to see the unified view.

What the master adds on top of a normal gateway:

- A second WebSocket listener (the federation port, default `47913` for federation traffic separate from the UI port).
- A node registry tracking which satellites are connected and what they offer.
- Cross-node spawn/send/invoke routing.
- Aggregator endpoints that fan out to satellites and merge responses (`federation.resources.directories`, `federation.resources.projects`, etc.).
- A failover manager that retracks remote sessions if a satellite drops.

### Satellite

Has `gateway.federation.mode = "satellite"` and `gateway.federation.masterUrl` pointing at the master. Connects on startup, advertises its local capabilities (Ollama? GPU? ComfyUI? voice? mcp servers? agents? workspaces?), and listens for inbound master messages.

Satellites can themselves run UI, channels, voice, terminals — they're full gateways. Federation just gives them a tap to the master.

### Standalone

Default mode. No federation. Don't even think about this page until you have a reason.

## What crosses the wire

### Resource discovery

When the master needs the federated view of a resource type, it asks each satellite. The satellite returns a typed list and the master merges. Currently federated:

- `projects` — project registry across nodes
- `tasks` — kanban tasks
- `agents` — agent identities + presence
- `mcp` — registered MCP servers per node
- `directories` — registered cwds per node (drives the terminal/files pickers)
- `business` — business-domain entries
- `terminals` (via `terminal.list` proxied through `federation.node.invoke`)

This means the activity feed, the directory picker, the terminal chooser, and the agents list all show **everything across the mesh** — and each row carries a `node` tag so the UI can show "this is on home-server" badges.

### Session spawn / send

Master → satellite session control:

- `session.spawn` — "spawn agent X on satellite Y with task Z, return the runId". Master records a pending request keyed by correlation id, satellite executes locally, completes via `session.complete` back to the master.
- `session.send` — "send this message into existing session-key K on satellite Y". Routes through `chat.send` on the satellite's local gateway.

Both are idempotency-keyed (the satellite's `messageId` doubles as the idempotency token), so retries don't double-fire.

### Generic gateway-RPC proxy

The workhorse. `federation.node.invoke` on the master takes `{nodeId, method, params}` and proxies any RPC the satellite's local gateway exposes:

- `terminal.create / write / resize / destroy / getBuffer / list`
- `terminal.assistantStream.start / stop`
- Anything else registered on the satellite's method list

Result envelope: `{success, payload, error}`. The hub serializes the payload and returns it through the master's `federation.node.invoke` response. From the UI's perspective, calling `federation.node.invoke {method:"terminal.write"}` looks the same as calling `terminal.write` directly — just on a different machine.

This is what enables cross-device PTYs: master UI creates a terminal with `nodeId: "satellite-A"`, the PTY actually spawns on satellite A, keystrokes from the master flow through the proxy, and output streams back through `event.broadcast`.

### Event broadcast (reverse channel)

Satellites push gateway-broadcaster events upstream when they're worth seeing on the master. Events forwarded:

- `terminal.output`, `terminal.created`, `terminal.destroyed`, `terminal.exit`, `terminal.titleChange`
- `chat`, `agent` (chat-streaming + agent lifecycle — what the activity feed listens to)

The master's hub re-broadcasts each event to its UI clients with a `federationNodeId` tag injected into the payload, so UI handlers can route to the right panel.

Other broadcasts (presence, health ticks, metrics) stay local — they'd add noise on the federation wire without a consumer.

### Heartbeats + presence

Satellites heartbeat every few seconds. Master tracks last-seen and updates the federation node list. When a satellite drops, the master:

- Marks the node offline in the registry
- Triggers the failover manager for any sessions it had been tracking on that node
- Surfaces the disconnect to UI clients (the device picker greys out, the activity feed marks remote sessions as `node: <name>` with a stale timestamp)

## What stays local

Federation is **explicit** — a satellite doesn't push everything everywhere. By default these stay on the satellite:

- Channel state (Telegram bots, Discord clients, etc.) — each gateway runs its own channels
- Vault contents, secrets, OAuth tokens
- The session store (other than what's exposed via list/preview/spawn)
- Filesystem reads beyond the registered directories
- MCP server invocations (proxy goes through `federation.node.invoke` only on demand)

That's by design: federation is a control + observability plane, not a replication system. Your secrets stay on whichever machine you put them.

## Setting up a federation

### 1. Pick the master

Choose the machine you want to be the home base. Usually:

- The most-always-on (a desktop or home server)
- The one with the most external connectivity (channel webhooks etc.)
- The one with the UI you'll use most

In `state/<agent>/config.json` (or your equivalent config file), under `gateway.federation`:

```json
{
  "gateway": {
    "federation": {
      "enabled": true,
      "mode": "master",
      "federationPort": 47913,
      "nodeName": "home-master"
    }
  }
}
```

### 2. Start each satellite

On every other machine, set:

```json
{
  "gateway": {
    "federation": {
      "enabled": true,
      "mode": "satellite",
      "masterUrl": "ws://192.168.1.142:47913",
      "nodeName": "macbook",
      "capabilities": {
        "hasOllama": true,
        "hasComfyUI": false,
        "hasVoice": true
      }
    }
  }
}
```

`masterUrl` can be:

- A LAN IP (`ws://192.168.1.142:47913`)
- A Tailscale IP (`ws://100.x.y.z:47913`) — recommended for mesh across networks
- A public URL with TLS (`wss://master.example.com:47913`)

The satellite reconnects automatically if the master goes away.

### 3. Verify the mesh

On the master, hit `federation.nodes.list` (visible in the Federation control panel under Settings → Federation). Each connected satellite should appear with its `capabilities`, `hostname`, `online: true`.

Inside the activity feed, sessions started on satellites carry a `node: <name>` badge. The directory picker on `/terminals` shows a flat list with sourcenode tags. Spawning a terminal with `nodeId: "<satellite>"` lands the PTY on that satellite — the xterm in the master UI streams the output via the federation event channel.

## Failure modes + recovery

### Satellite disconnects mid-session

The master's failover manager retains the session info and emits a `session.complete` with `success: false, error: "node disconnected"` to any pending request keyed on that satellite. Next-step behavior is up to the agent: retry on a different node, queue, or fail.

Reconnects rejoin the mesh automatically; in-flight sessions started before the drop are not auto-resumed (they'd require state migration; see [Session migration](../FEDERATION_RETRY_TESTING.md) for the experimental path).

### Master goes down

Satellites keep running locally. UI clients connected directly to a satellite still work. When the master comes back, satellites reconnect and the mesh reforms — sessions on satellites continued running through the outage are visible again.

### Network partition

Each side keeps working in isolation. When the partition heals, satellites reconnect. There's no automatic reconciliation of work done on both sides during the split — it's not a CRDT.

### Auth + security

Federation traffic includes a token in the connect handshake (`gateway.federation.token`). Set it on both sides; mismatches drop the connection. For exposure across untrusted networks use TLS (`wss://`) and Tailscale or a VPN. The federation port is **not** safe to expose unauthenticated to the internet.

See [Federation Security](../FEDERATION_SECURITY_README.md) for the full security model — message signing, replay protection, allowed-method lists per node.

## Common topologies

### Solo + portable

- 1 always-on home server (master)
- 1 laptop (satellite when home, standalone or roaming-master when not)

The laptop's satellite mode auto-disconnects on Wi-Fi change and reconnects when it sees the master again. While disconnected it works as a normal standalone gateway.

### Compute split

- 1 lightweight UI host (master) — laptop, mac mini
- 1 GPU desktop (satellite) — Ollama, llama.cpp, ComfyUI, heavy MCP tools

The master's UI shows everything; heavy compute happens on the GPU box. `federation.node.invoke` routes the right calls to the right machine; capability flags drive an automatic compute router for "give me an LLM model" / "give me image gen" requests.

### Multi-user household

- 1 family-shared master with channel access (Telegram, iMessage, etc.)
- N personal-device satellites, each with private MCPs and notes

Channels live on the shared master; private work lives on satellites. The agent's identity model (`agent:main:...` vs `agent:user1:...`) keeps inbound traffic addressed correctly.

## Satellite quick-start

The one-command satellite onboarding flow uses signed invite tokens. The master mints a single blob; the satellite redeems it after `npm i -g infinibot`. No separate URL + token flags.

On the master (one-time, per satellite):

```bash
infinibot federation invite --label "yungceo-windows"
```

This prints a single encoded invite string that begins with `infinibot-invite-v1:`. Hand it to the satellite operator however you like (chat, QR, email).

On each satellite:

```bash
npm i -g infinibot
infinibot federation join <paste-invite>
```

That's the entire pairing flow. The satellite will:

1. Decode + display the master, fingerprint, and label, and ask for confirmation (use `--yes` for headless installs).
2. Merge the master URL + signed satellite token into `~/.infinibot/infinibot.json`.
3. Restart the gateway in satellite mode (skip with `--config-only`).

Flags:

- `infinibot federation invite [--label <name>] [--expires 30d|12h|60m] [--satellite-id <id>] [--master-url <url>] [--qr] [--copy] [--json]`
- `infinibot federation join <encoded-invite> [--yes] [--config-only] [--no-restart]`

### Pairing from the setup wizard

`infinibot quickstart` (the browser wizard npm users get) asks **"How will this
install run?"** first. Pick **Satellite** and it walks you through the same
invite flow without the CLI:

1. **Master**: type the master's address (`192.168.1.20:18789`,
   `ws://studio.local:18789`, …) or press **Scan network** (mDNS on the LAN plus
   your Tailscale peers).
2. **Pair**: paste an invite. Both formats work: the `infinibot-invite-v1:…`
   string from `infinibot federation invite`, and the invite code from the
   master's Federation page (`federation.generateInvite`). **Test connection**
   registers once with the master using the invite's token, exactly as the
   satellite will, then disconnects. It reports "linked" or a specific error:
   unreachable, not a master, invite-only master without an invite, or an
   expired/revoked/foreign invite.
3. **Share**: choose what the master may use on this machine (below).
4. **Finish** writes the config, then pulls the master's shared settings
   (model providers, MCP, voice), so a satellite needs no API key of its own.
   Run `infinibot gateway run` and the node appears in the master's node list.

The wizard writes this block (the token is the invite's signed `SatelliteToken`):

```json5
"federation": {
  "enabled": true,
  "mode": "satellite",
  "masterUrl": "ws://192.168.1.20:18789/federation",
  "nodeName": "Laptop",
  "authToken": { "satelliteId": "node_…", "permissions": { "level": "full", … }, "issuedAt": 0, "expiresAt": 0, "signature": "…" },
  "share": { "terminals": true, "coders": true, "agents": true, "compute": true },
  "label": "Studio master"
}
```

The satellite presents `authToken` every time it registers, including after a
restart. The master signs tokens with a hub key kept in
`~/.infinibot/federation/hub-keypair.json` (owner-only), so tokens survive
master restarts and CLI-minted invites validate against the running hub.

### What a satellite shares (`federation.share`)

| Key | Off means the satellite refuses |
|---|---|
| `terminals` | `terminal.*` calls proxied from the master |
| `coders` | `terminal.spawnAgent` / `coder.*` (Claude Code, Codex, OpenCode spawns) |
| `agents` | federated `session.spawn` and proxied `chat.*` / `sessions.*` / `agent` |
| `compute` | advertising local models and GPU (Ollama, ComfyUI) in its manifest |

Unset keys (and configs written before this existed) stay shared. The check
runs on the satellite, so it holds whatever the master asks.

### Revoking

```bash
infinibot federation invites list
infinibot federation invites revoke <fingerprint>
```

`revoke` marks the invite revoked in the local audit file (`~/.infinibot/federation-invites.json`) and, if the master gateway is running in-process, immediately invalidates the satellite token via `FederationSecurity.revokeSatelliteToken`.

## Internals reference

For people writing federation-aware plugins or auditing what crosses the wire:

- `src/federation/hub.ts` — master-side hub, message routing, heartbeats, failover
- `src/federation/satellite.ts` — satellite client, reconnect, send-to-master surfaces
- `src/federation/protocol.ts` — typed message shapes (`session.spawn`, `gateway.proxy.invoke`, `event.broadcast`, etc.)
- `src/federation/security.ts` — auth + signing model
- `src/gateway/server-runtime-state.ts` — where the master's broadcaster gets wrapped to forward terminal events

For practical recipes, see also the room-temperature scratch docs in the repo root: `FEDERATION_COMPLETION_CALLBACKS.md`, `FEDERATION_RETRY_TESTING.md`, `FEDERATION_SECURITY_README.md`, `IDENTITY_SYNC_IMPLEMENTATION.md`, `SATELLITE_MESH.md`. These will be folded into this docs tree as they stabilize.

## TL;DR

Federation gives you **one agent surface across many machines**, with each machine still working independently. It's a control + observability mesh, not a replication system. Your secrets stay where you put them; your sessions are addressable from anywhere; your tools run on whichever box has the right capability. The cost is one extra port and a config block on each node.
