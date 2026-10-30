# Agency World

**Agency World** is InfiniBot's living 2D visualization of the agent mesh. Where the
3D *Neural Mesh* shows the topology, Agency World shows the *work*: every federation
node is a building, every running agent is a pixel character that walks between work
zones based on the tool it is actually calling, couriers fly between agents on real
inter‑agent messages, and incoming tasks ride a conveyor into the world.

It is designed to be a credible, real‑time demonstration of parallel agency — when ten
agents run at once, you see ten characters genuinely working in ten different zones.

> Toggle between **AGENCY** (this view) and **MESH** (3D neural network) using the pill
> control in the top‑right of the GPU panel. The choice is remembered in `localStorage`.

---

## The metaphor

| World element | What it represents |
|---|---|
| **Building** | A federation node (`hub`, `satellite`, or `local`). The hub gets a wide HQ with antenna + clock tower; satellites get a roof dish. Roof signage shows live CPU / MEM / GPU. A second floor grows when a node runs more than 12 agents. |
| **Pixel character** | A running agent. Its colour palette encodes the **provider** (claude / openai / gemini / ollama / xai / default). It walks to a work zone based on the **tool** it is currently using. |
| **Work zone** | Where an agent stands while using a class of tool — Terminal Bank (`Bash`), Research Lib (`Read`/`Grep`), Drafting Tables (`Edit`/`Write`), Comms Desk (`Task`), Browser Pit (`WebFetch`), Kanban Wall, Archives (memory), Break Room (idle/done), Entryway (starting). |
| **Envelope courier** | A real inter‑agent message, routed along the roads between buildings. |
| **Task gem on the conveyor** | An incoming kanban task ingested into the world. |
| **Confetti + chime** | An agent completed successfully. |
| **Red `!` pulse + alert** | An agent is blocked. |
| **Lightning flash** | The gateway connection dropped (a soft chime + flash signals reconnect). |
| **Day / night sky** | Tracks your local clock — stars and a moon appear in the evening. |

---

## Real‑time data path

Agency World is driven by a **WebSocket event bridge**, not polling, so a character
reacts to a tool call within ~200 ms instead of multiple seconds.

```
gateway ──(WS events)──► AgencyDataBridge ──(batched per frame)──► <agency-world-viz> ──► AgencyWorld engine
   subagent.spawned ┐                          │ WorldEvent[]                                  ├ Building[]
   subagent.complete ├─► normalize ─► WorldEvent┘                                               ├ AgentChar[]  (sprite-atlas walk)
   session.progress  │                                                                          ├ Courier[]    (road-routed)
   node.connected    │                                                                          ├ FxLayer      (per-tool particles, confetti, weather)
   federation.event  │                                                                          ├ SkyCycle     (day/night)
   heartbeat        ─┘                                                                          └ NewsTicker / AudioBus
```

- **`AgencyDataBridge`** (`ui/src/ui/controllers/agency-data-bridge.ts`) subscribes once
  to the gateway, normalizes every frame into a single `WorldEvent` union, and flushes
  batches once per animation frame (with a 200 ms safety debounce).
- On older gateways without an event stream it **falls back to a 10 s reconciliation
  poll** (with a one‑time console warning). A slow reconcile always runs to self‑heal
  missed deltas.
- The engine API is single‑sourced: the **mobile** WebView engine
  (`mobile/src/screens/agency-world/`) consumes the same `WorldEvent` shape.

### The `WorldEvent` union

```ts
type WorldEvent =
  | { kind: 'node.upsert';   node: MeshNode }
  | { kind: 'node.remove';   nodeId: string }
  | { kind: 'agent.spawn';   agent: MeshAgent }
  | { kind: 'agent.progress';sessionKey: string; patch: Partial<MeshAgent> }
  | { kind: 'agent.tool';    sessionKey: string; tool: { kind: string; label: string } }
  | { kind: 'agent.message'; from: string; to: string; type: 'request'|'response'|'broadcast' }
  | { kind: 'agent.complete';sessionKey: string; success: boolean; message?: string }
  | { kind: 'task.ingest';   id: string; title: string; nodeId?: string; priority?: string }
  | { kind: 'period.tick';   epochMs: number };
```

---

## Interactivity

- **Click an agent** → a focus panel slides in from the right with the agent's name,
  provider, current task, last tool, files touched, progress, and run‑id, plus
  **Open Session / Stop / Open Run** actions.
- **Click a building** → the world dims every other node to 35 % so you can focus on
  one node's activity. Click it again to clear.
- **Esc** closes the focus panel.
- **Mobile**: tap a character to open the Agent Focus Sheet (with haptic feedback when
  available); the WebView shows a "tap to reload" overlay if the engine ever crashes.

---

## Storytelling & marketing

- **News ticker** — a bottom marquee of the last 8 events (`[15:42] claude‑coder spawned · …`).
- **Record** — the `REC` button captures the live canvas to a `agency-world-<iso>.webm`
  via `MediaRecorder` (auto‑stops at 60 s).
- **Demo mode** — append `?demo=1` (or `?agency-demo=1`) to the URL to drive the world
  from a scripted synthetic source (12 agents, randomized tools, messages, task ingests)
  with **no backend required** — ideal for screen captures.
- **Audio** is synthesized in‑browser via WebAudio (completion chime, blocked alert,
  reconnect ding) — no audio assets ship. It is **muted by default**
  (`localStorage['agencyWorld.muted']`).

Effects honour `prefers-reduced-motion` (camera shake is skipped) and the particle pool
is capped so nothing accumulates over long runs.

---

## Source map

| Concern | File |
|---|---|
| PixiJS engine (buildings, agents, couriers, conveyor) | `ui/src/ui/views/agent-ops/agency-world.ts` |
| Pre‑rendered character / decor sprite atlas | `ui/src/ui/views/agent-ops/agency-sprite-atlas.ts` |
| Particles, confetti, day/night, WebAudio bus | `ui/src/ui/views/agent-ops/agency-fx.ts` |
| Building art per role + road pathing | `ui/src/ui/views/agent-ops/agency-buildings.ts` |
| Lit wrapper + event-bridge wiring | `ui/src/ui/components/agency-world-viz.ts` |
| Gateway → WorldEvent bridge | `ui/src/ui/controllers/agency-data-bridge.ts` |
| Selection focus panel | `ui/src/ui/components/agent-focus-panel.ts` |
| News ticker | `ui/src/ui/components/agency-news-ticker.ts` |
| Canvas recorder / demo source | `ui/src/ui/views/agent-ops/agency-recorder.ts`, `agency-demo-source.ts` |
| Panel host + view toggle | `ui/src/ui/components/gpu-animation-panel.ts` |
| Mobile WebView engine + RN bridge | `mobile/src/screens/agency-world/` |

See [`agency-world-v2-enhancement-plan.md`](./agency-world-v2-enhancement-plan.md) for the
design rationale and the parallel build that produced v2.
