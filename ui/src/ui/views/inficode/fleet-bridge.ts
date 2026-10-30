/**
 * InfiCode — Fleet Bridge.
 *
 * Live data path for infinicode-managed servers, kept deliberately separate
 * from AgencyDataBridge (controllers/agent-mesh.ts's data spine): that path
 * models LOCAL sessions/subagents (sessionKey, coderBackend, progress —
 * agent semantics). A fleet record is a remote SERVER (hardware, maintenance
 * reports) — a different shape, so it gets its own bridge feeding the same
 * gateway WS connection rather than being force-fit into MeshNode/MeshAgent.
 *
 * Snapshot on construct (`infinicode.fleet.list`) + live updates via the
 * federation event bus (`infinicode.status` / `infinicode.report`, arriving
 * wrapped as `{event:"federation.event", payload:{event:{type,payload}}}` —
 * same wrapper AgencyDataBridge unwraps for its own events), plus a slow
 * reconcile poll to self-heal any missed deltas.
 */

import type { GatewayBrowserClient, GatewayEventFrame } from "../../gateway.js";
import type { FleetRecord } from "./fleet-types.js";

const RECONCILE_MS = 15000;

export class FleetBridge {
  private client: GatewayBrowserClient;
  private unsub: (() => void) | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private subscribers = new Set<() => void>();

  private nodes = new Map<string, FleetRecord>();

  constructor(client: GatewayBrowserClient) {
    this.client = client;
    void this.snapshot().catch(() => {});
    this.unsub = this.client.subscribe((evt) => this.onFrame(evt));
    this.reconcileTimer = setInterval(() => {
      void this.snapshot().catch(() => {});
    }, RECONCILE_MS);
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  list(): FleetRecord[] {
    return [...this.nodes.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  destroy(): void {
    this.destroyed = true;
    this.unsub?.();
    this.unsub = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    this.subscribers.clear();
  }

  private async snapshot(): Promise<void> {
    if (this.destroyed) return;
    const res = await this.client
      .request<{ nodes?: FleetRecord[] }>("infinicode.fleet.list", {})
      .catch(() => null);
    const nodes = res?.nodes;
    if (!Array.isArray(nodes)) return;
    this.nodes = new Map(nodes.map((n) => [n.nodeId, n]));
    this.notify();
  }

  private onFrame(evt: GatewayEventFrame): void {
    if (this.destroyed || evt.event !== "federation.event") return;
    const inner = (evt.payload as { event?: { type?: string; payload?: unknown } } | undefined)?.event;
    if (!inner || typeof inner.type !== "string") return;

    if (inner.type === "infinicode.status") {
      const p = inner.payload as { nodeId?: string; status?: FleetRecord["status"] } | undefined;
      if (!p?.nodeId) return;
      const rec = this.nodes.get(p.nodeId) ?? { nodeId: p.nodeId, reports: [], lastSeenAt: Date.now() };
      this.nodes.set(p.nodeId, { ...rec, status: p.status, lastSeenAt: Date.now() });
      this.notify();
      return;
    }
    if (inner.type === "infinicode.report") {
      const p = inner.payload as { nodeId?: string; report?: FleetRecord["reports"][number] } | undefined;
      if (!p?.nodeId || !p.report) return;
      const rec = this.nodes.get(p.nodeId) ?? { nodeId: p.nodeId, reports: [], lastSeenAt: Date.now() };
      const reports = [...rec.reports, p.report].slice(-20);
      this.nodes.set(p.nodeId, { ...rec, reports, lastSeenAt: Date.now() });
      this.notify();
      return;
    }
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      try {
        cb();
      } catch (err) {
        console.error("[fleet-bridge] subscriber error:", err);
      }
    }
  }
}
