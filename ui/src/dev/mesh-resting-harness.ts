/**
 * Dev harness: mounts the real <agency-world-viz> against a fake gateway client
 * so the bridge → viz → engine finished-agent resting flow can be driven and
 * screenshotted without a gateway. window.__fake exposes the controls.
 */
import "../ui/components/agency-world-viz";

type Row = { sessionKey: string; label: string; status: string };
const state = {
  subs: [] as Row[],
  sessions: [{ key: "agent:main:main", kind: "main", label: "Main (idle)", active: false }] as any[],
};
const frameCbs = new Set<(evt: any) => void>();
const client = {
  connected: true,
  request: async (method: string) => {
    if (method === "subagents.list") return { subagents: state.subs.map((s) => ({ ...s })) };
    if (method === "sessions.list") return { sessions: state.sessions };
    if (method === "federation.status") return { role: "master", nodes: [] };
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

(window as any).__fake = {
  state,
  emit,
  key,
  spawn(i: number, label: string) {
    const row = { sessionKey: key(i), label, status: "running" };
    state.subs.push(row);
    emit("subagent.spawned", { ...row, agentId: "main" });
  },
  finish(i: number, ok = true) {
    state.subs = state.subs.filter((s) => s.sessionKey !== key(i));
    emit(ok ? "subagent.complete" : "subagent.error", { sessionKey: key(i) });
  },
  viz: () => document.querySelector("agency-world-viz") as any,
};

const viz = document.createElement("agency-world-viz") as any;
viz.client = client;
document.body.appendChild(viz);
