/**
 * Dev harness: mounts the real <agency-world-viz> against a fake gateway so a
 * crowded, mixed-backend fleet can be driven and screenshotted without a
 * gateway (provider logo badges + agent spread). window.__fake has controls.
 */
import "../ui/components/agency-world-viz";

type Row = { sessionKey: string; label: string; status: string; agentId?: string; coderBackend?: string };
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
  spawn(i: number, label: string, coderBackend?: string, agentId = "main") {
    const row: Row = { sessionKey: key(i), label, status: "running", agentId, ...(coderBackend ? { coderBackend } : {}) };
    state.subs.push(row);
    emit("subagent.spawned", { ...row });
  },
  tool(i: number, name: string) {
    emit("agent", { sessionKey: key(i), stream: "tool", data: { name, phase: "start" } });
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
