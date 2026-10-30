/**
 * Voice Terminal HUD — live data poller.
 *
 * One shared poller per gateway client, started while at least one HUD panel
 * set is subscribed and stopped when the last one leaves. Each section keeps
 * its own loading / error state so a slow or failing RPC only affects its own
 * panel. Polls slow down (or stop) while the tab is hidden via managedInterval.
 */

import type { GatewayBrowserClient } from "../../gateway";
import { managedInterval, type SchedulerHandle } from "../../perf/visibility-scheduler";

export type Section<T> = { data: T | null; loading: boolean; error: string | null; at: number };

export type HudRaw = {
  agents: Section<unknown>;
  completions: Section<unknown>;
  calendar: Section<unknown>;
  scheduled: Section<unknown>;
  proactive: Section<unknown>;
  version: Section<unknown>;
  notion: Section<unknown>;
  hardware: Section<unknown>;
};

type Key = keyof HudRaw;
type Listener = (raw: HudRaw) => void;

const RPC_OPTS = { timeoutMs: 20_000 };

const empty = <T>(): Section<T> => ({ data: null, loading: true, error: null, at: 0 });

function todayRange(now = new Date()): { fromIso: string; toIso: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { fromIso: start.toISOString(), toIso: end.toISOString() };
}

function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err ?? "error");
  return m.length > 120 ? `${m.slice(0, 117)}…` : m;
}

/** Section → loader + poll period (ms). */
const PLAN: Array<{ keys: Key[]; every: number; load: (c: GatewayBrowserClient) => Promise<unknown[]> }> = [
  { keys: ["agents"], every: 5_000, load: async (c) => [await c.request("subagents.list", { includeCompleted: false, limit: 40, compact: true }, RPC_OPTS)] },
  { keys: ["completions"], every: 20_000, load: async (c) => [await c.request("verification.list", { limit: 60 }, RPC_OPTS)] },
  { keys: ["calendar"], every: 60_000, load: async (c) => [await c.request("calendar.events.list", todayRange(), RPC_OPTS)] },
  { keys: ["scheduled"], every: 60_000, load: async (c) => [await c.request("scheduledTasks.list", {}, RPC_OPTS)] },
  { keys: ["proactive"], every: 45_000, load: async (c) => [await c.request("proactive.state", { touch: false }, RPC_OPTS)] },
  { keys: ["version"], every: 60_000, load: async (c) => [await c.request("system.version", {}, RPC_OPTS)] },
  { keys: ["notion"], every: 30_000, load: async (c) => [await c.request("kanban.notionSync.status", {}, RPC_OPTS)] },
  {
    keys: ["hardware"],
    every: 5_000,
    load: async () => {
      const res = await fetch("/api/hardware/nodes", { cache: "no-store" });
      if (!res.ok) throw new Error(`hardware telemetry HTTP ${res.status}`);
      return [await res.json()];
    },
  },
];

class HudStore {
  raw: HudRaw = {
    agents: empty(),
    completions: empty(),
    calendar: empty(),
    scheduled: empty(),
    proactive: empty(),
    version: empty(),
    notion: empty(),
    hardware: empty(),
  };
  private listeners = new Set<Listener>();
  private timers: SchedulerHandle[] = [];
  private client: GatewayBrowserClient | null = null;
  private inflight = new Set<Key>();

  subscribe(client: GatewayBrowserClient | null, fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.raw);
    if (client && client !== this.client) this.start(client);
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.stop();
    };
  }

  /** Re-fetch one section now (after an action that changed it). */
  refresh(key: Key): void {
    const plan = PLAN.find((p) => p.keys.includes(key));
    if (plan && this.client) void this.run(plan, this.client);
  }

  private start(client: GatewayBrowserClient): void {
    this.stop();
    this.client = client;
    for (const plan of PLAN) {
      this.timers.push(managedInterval(() => void this.run(plan, client), plan.every, { hiddenMs: Math.max(plan.every, 60_000), immediate: true }));
    }
  }

  private stop(): void {
    for (const t of this.timers) t.cancel();
    this.timers = [];
    this.client = null;
  }

  private async run(plan: (typeof PLAN)[number], client: GatewayBrowserClient): Promise<void> {
    const key = plan.keys[0];
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    try {
      const [data] = await plan.load(client);
      if (client !== this.client) return;
      this.raw = { ...this.raw, [key]: { data, loading: false, error: null, at: Date.now() } };
    } catch (err) {
      if (client !== this.client) return;
      const prev = this.raw[key];
      // Keep the last good payload; surface the error alongside it.
      this.raw = { ...this.raw, [key]: { ...prev, loading: false, error: errText(err), at: Date.now() } };
      // Nothing to show yet (e.g. the socket was still handshaking): retry soon
      // instead of waiting a full poll period.
      if (prev.data == null) window.setTimeout(() => this.client === client && void this.run(plan, client), 3_000);
    } finally {
      this.inflight.delete(key);
    }
    for (const fn of this.listeners) fn(this.raw);
  }
}

export const hudStore = new HudStore();
