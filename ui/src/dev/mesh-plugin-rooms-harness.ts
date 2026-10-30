/**
 * Dev harness: the real <agency-world-viz> against a fake gateway whose
 * plugins.list is the first-party manifest fixture (12 plugins). Drives
 * synthetic agents + tool events so the Plugin District can be screenshotted
 * with agents walking into and working in plugin rooms. window.__fake has
 * the controls; window.__hudPerf carries the engine's per-frame cost.
 *
 *   node ui/src/dev/gen-plugin-rooms-fixture.mjs   # refresh the fixture
 *   pnpm -C ui exec vite --port 5199               # then open
 *   /mesh-plugin-rooms-harness.html?plugins=all|none|<id,id>
 */
import "../ui/components/agency-world-viz";
import { PLUGIN_ROOMS_FIXTURE } from "./plugin-rooms-fixture";

const FIXTURE = PLUGIN_ROOMS_FIXTURE as unknown as Array<Record<string, any> & { id: string; name: string }>;

type Row = { sessionKey: string; label: string; status: string; agentId?: string; coderBackend?: string; currentTask?: string; pluginId?: string };
type PluginItem = (typeof FIXTURE)[number];

const params = new URLSearchParams(location.search);
const wanted = params.get("plugins") ?? "all";
const pick = (p: PluginItem) => wanted === "all" || (wanted !== "none" && wanted.split(",").includes(p.id));

const state = {
  plugins: FIXTURE.map((p) => ({ ...p, status: pick(p) ? "loaded" : "disabled", enabled: pick(p) })) as Array<PluginItem & { status: string; enabled: boolean; disabledContributions?: string[] }>,
  subs: [] as Row[],
  sessions: [{ key: "agent:main:main", kind: "main", label: "Main", active: true }] as any[],
  federation: { role: "master", nodes: [] } as any,
};

/**
 * `?live=1`: read-only render of a captured live gateway snapshot
 * (ui/src/dev/live-dump.json — plugins.list + subagents.list + sessions.list,
 * secrets scrubbed, never committed). A live gateway that predates
 * contributes.mapRoom emits no rooms, so the snapshot's loaded v2 plugins are
 * given THIS branch's manifest room (fixture by id) — the same default the
 * gateway applies once it runs this branch.
 */
async function loadLiveDump(): Promise<boolean> {
  if (params.get("live") !== "1") return false;
  const res = await fetch("/src/dev/live-dump.json");
  if (!res.ok) return false;
  const dump = await res.json();
  const byId = new Map(FIXTURE.map((p) => [p.id, p]));
  state.plugins = (dump.plugins as any[]).map((p) => {
    const fx = byId.get(p.id);
    const mapRoom = p.contributes?.mapRoom ?? fx?.contributes?.mapRoom;
    return { ...p, contributes: { ...(p.contributes ?? {}), ...(mapRoom ? { mapRoom } : {}) }, rosterAgentIds: p.rosterAgentIds ?? fx?.rosterAgentIds ?? [] };
  }) as any;
  state.subs = dump.subagents ?? [];
  state.sessions = dump.sessions ?? state.sessions;
  state.federation = dump.federation ?? state.federation;
  (window as any).__liveDump = { capturedAt: dump.capturedAt, plugins: state.plugins.length, subagents: state.subs.length, sessions: state.sessions.length };
  return true;
}
const frameCbs = new Set<(evt: any) => void>();
const client = {
  connected: true,
  request: async (method: string) => {
    if (method === "plugins.list") return { plugins: state.plugins.map((p) => ({ ...p })), landing: null };
    if (method === "subagents.list") return { subagents: state.subs.map((s) => ({ ...s })) };
    if (method === "sessions.list") return { sessions: state.sessions };
    if (method === "federation.status") return state.federation;
    return {};
  },
  subscribe: (cb: (evt: any) => void) => {
    frameCbs.add(cb);
    return () => { frameCbs.delete(cb); };
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};
const emit = (event: string, payload: unknown) => frameCbs.forEach((cb) => cb({ type: "event", event, payload }));
const key = (i: number) => `agent:main:subagent:run-${i}`;

const viz = document.createElement("agency-world-viz") as any;
viz.client = client;
void loadLiveDump().finally(() => document.body.appendChild(viz));

(window as any).__fake = {
  state,
  emit,
  key,
  viz: () => viz,
  engine: () => viz.engine,
  spawn(i: number, label: string, coderBackend?: string, agentId = "main", extra: Partial<Row> = {}) {
    const row: Row = { sessionKey: key(i), label, status: "running", agentId, ...(coderBackend ? { coderBackend } : {}), ...extra };
    state.subs.push(row);
    emit("subagent.spawned", { ...row });
  },
  progress(i: number, patch: Record<string, unknown>) {
    const row = state.subs.find((s) => s.sessionKey === key(i));
    if (row) Object.assign(row, patch);
    emit("session.progress", { sessionKey: key(i), status: "running", ...patch });
  },
  tool(i: number, name: string, label?: string) {
    emit("agent", { sessionKey: key(i), stream: "tool", data: { name, phase: "start", ...(label ? { label } : {}) } });
  },
  finish(i: number, ok = true) {
    state.subs = state.subs.filter((s) => s.sessionKey !== key(i));
    emit(ok ? "subagent.complete" : "subagent.error", { sessionKey: key(i) });
  },
  /** Flip a plugin on/off (as if plugins.list changed) and re-sync the rooms. */
  async setPlugin(id: string, on: boolean) {
    const p = state.plugins.find((x) => x.id === id);
    if (p) { p.status = on ? "loaded" : "disabled"; p.enabled = on; }
    await viz.refreshPluginRooms();
  },
  /** Toggle just the room contribution (owner switch) — plugin stays loaded. */
  async setRoom(id: string, on: boolean) {
    const p = state.plugins.find((x) => x.id === id);
    if (p) p.disabledContributions = on ? [] : [`mapRoom:${id}`];
    await viz.refreshPluginRooms();
  },
  rooms: () => viz.engine?.pluginRooms?.() ?? [],
  plan: () => Object.fromEntries(viz.engine?.spreadPlan?.() ?? new Map()),
  perf: () => (window as any).__hudPerf ?? null,
  sectors: () => (window as any).__worldSectors ?? [],
  fit: () => viz.engine?.zoomToFit?.(),
};
