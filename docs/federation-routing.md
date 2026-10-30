# Federation cross-node routing

InfiniBot federation is **hub-and-spoke**: a master runs the hub; satellites
connect to it over WebSocket. Satellites have **no direct peer links** — every
cross-node call a satellite makes is tunnelled up to the master, which is the
router.

## The one routing decision

`src/federation/local-node.ts::isLocalNodeId(nodeId)` is the single source of
truth for "run here vs forward":

- `""`, `"local"`, or this node's own id → **local**.
- On the **master**, the alias `"master"` is also local.
- On a **satellite**, `"master"` is **remote** (route up to the hub).

Both the gateway handlers and the forwarder use it, so a forwarded call that
lands on its target runs locally instead of bouncing again.

## The one forwarder

`src/federation/hub-forward.ts::forwardGatewayCall(nodeId, method, params)`
handles every direction:

| This process | Target            | Path                                                        |
|--------------|-------------------|-------------------------------------------------------------|
| master       | satellite         | `hub.invokeOnNode` → `gateway.proxy.invoke` (params strip nodeId) |
| satellite    | master            | `satellite.invokeOnMaster` (nodeId attached → master runs local) |
| satellite    | sibling satellite | `satellite.invokeOnMaster` (nodeId attached → **master re-forwards** to the sibling) |
| standalone   | any               | `NOT_FEDERATED` → caller falls through to a local spawn      |

`sat → sat` works because the satellite tunnels the call to the master with
`nodeId` re-attached; the master's own handler sees a non-local `nodeId`, hits
its forward branch, and reaches the sibling via the hub. No second satellite
mesh is needed.

Handlers fall through to a **local** spawn **only** on `NOT_FEDERATED` (a
genuinely standalone install). Every other failure (`MASTER_UNAVAILABLE`,
`INVOKE_FAILED`, unknown node) is surfaced to the caller so a sub-agent is never
silently landed on the wrong node.

## What routes through this

- `sessions.spawn` (gateway sessions, incl. `coderBackend` terminal CLI path)
- `terminal.spawnAgent` (CLI coders: claude / opencode / codex / gemini)
- `sessions.send`, `chat.send`, `chat.abort` (follow-ups / teardown)
- `claude_coder` / `opencode_coder` / `codex_coder` agent tools — pass a
  `nodeId` and the spawn forwards to that node's `terminal.spawnAgent`.

## Reliability primitives

- **Idempotency** — `src/federation/spawn-idempotency.ts`. Pass an
  `idempotencyKey`; a replay (retry / forward-timeout / double-click) returns
  the original result instead of double-spawning. The key rides in the
  forwarded params so the node that actually spawns is the one that dedupes.
- **Heartbeat / liveness** — satellite → master `node.heartbeat` every 30s;
  master drops a node after 40s of silence (`hub.startHeartbeatMonitor`).
- **Reconnect** — satellite auto-reconnects with exponential backoff on socket
  drop (`satellite.scheduleReconnect`); no gateway restart required.

## Self-test (acceptance)

Run on the **master** after the gateway has loaded this build:

```bash
node scripts/federation-selftest.mjs            # transport ping matrix (safe, default)
node scripts/federation-selftest.mjs --spawn    # real sessions.spawn per cell + teardown
node scripts/federation-selftest.mjs --spawn --cli   # also a CLI coder per cell
```

It drives every (origin, target) pair — master↔satellite↔satellite, both
directions — and prints PASS/FAIL per cell. `ping` mode routes
`federation.ping` (same forward path, zero side effects); `spawn` mode performs
real spawns and tears them down. The full 6-cell matrix needs **two**
satellites connected; with one satellite only the master↔satellite cells run.

> New gateway methods (`federation.ping`, `federation.selftest`) require the
> gateway to be (re)started to be served — they are compiled into `dist` but a
> running process won't pick them up until it restarts.
