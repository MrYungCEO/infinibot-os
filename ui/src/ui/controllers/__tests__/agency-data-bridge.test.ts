import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgencyDataBridge, type WorldEvent } from "../agency-data-bridge";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../gateway";

// ────────────────────────────────────────────────────────────────
// Fake gateway client. Stores the live-stream handler so the test can
// push synthetic event frames, and answers snapshot/reconcile requests
// with empty canned payloads.
// ────────────────────────────────────────────────────────────────
class FakeGateway {
  handler: ((evt: GatewayEventFrame) => void) | null = null;
  unsubCalls = 0;
  requests: Array<{ method: string; params: unknown }> = [];

  get connected(): boolean {
    return true;
  }

  subscribe(handler: (evt: GatewayEventFrame) => void): () => void {
    this.handler = handler;
    return () => {
      this.unsubCalls++;
      this.handler = null;
    };
  }

  request(method: string, params: unknown): Promise<any> {
    this.requests.push({ method, params });
    // Canned empty snapshots; the bridge tolerates {} (synthesizes a LOCAL node).
    return Promise.resolve({});
  }

  /** Push a raw gateway event frame through the stored live-stream handler. */
  push(event: string, payload: unknown): void {
    this.handler?.({ type: "event", event, payload } as GatewayEventFrame);
  }
}

function makeBridge(): { bridge: AgencyDataBridge; client: FakeGateway } {
  const client = new FakeGateway();
  const bridge = new AgencyDataBridge(client as unknown as GatewayBrowserClient);
  return { bridge, client };
}

/** Flatten every batch the subscriber received into a single WorldEvent[]. */
function flatten(batches: WorldEvent[][]): WorldEvent[] {
  return batches.flat();
}

describe("AgencyDataBridge", () => {
  let rafCbs: Array<FrameRequestCallback>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Route rAF through setTimeout so fake timers can drive the flush.
    rafCbs = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>)) as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("spawns 50 distinct agents, batched (not 50 synchronous calls)", () => {
    const { bridge, client } = makeBridge();
    const batches: WorldEvent[][] = [];
    bridge.subscribe((events) => batches.push(events));

    // Push 50 synthetic spawn frames in a single synchronous tick.
    for (let i = 0; i < 50; i++) {
      client.push("subagent.spawned", {
        runId: "r" + i,
        sessionKey: "s" + i,
        label: "agent " + i,
        status: "working",
        progress: 0,
      });
    }

    // Nothing should have been delivered synchronously yet (it is queued).
    expect(batches.length).toBe(0);

    // Drive the queued rAF + 200ms debounce flush.
    vi.runAllTimers();

    const spawns = flatten(batches).filter((e) => e.kind === "agent.spawn");
    // toAgent keys by sessionKey (sessionKey precedence over runId).
    const keys = new Set(
      spawns.map((e) => (e as Extract<WorldEvent, { kind: "agent.spawn" }>).agent.sessionKey),
    );
    expect(keys.size).toBe(50);
    expect(spawns.length).toBe(50);
    // Delivered in batches, not 50 separate synchronous calls.
    expect(batches.length).toBeLessThan(50);
    expect(batches.length).toBeGreaterThan(0);

    bridge.destroy();
  });

  it("coalesces multiple progress frames for one session into a batch", () => {
    const { bridge, client } = makeBridge();
    const batches: WorldEvent[][] = [];
    bridge.subscribe((events) => batches.push(events));

    for (let i = 0; i < 5; i++) {
      client.push("session.progress", {
        sessionKey: "sess-1",
        status: "working",
        progress: i * 20,
      });
    }

    // Not delivered as 5 separate synchronous calls.
    expect(batches.length).toBe(0);

    vi.runAllTimers();

    const progress = flatten(batches).filter((e) => e.kind === "agent.progress");
    expect(progress.length).toBe(5);
    // Coalesced: far fewer subscriber invocations than progress frames.
    expect(batches.length).toBeLessThan(5);

    bridge.destroy();
  });

  it("maps lifecycle and infra topics to the right WorldEvent kinds", () => {
    const { bridge, client } = makeBridge();
    const batches: WorldEvent[][] = [];
    bridge.subscribe((events) => batches.push(events));

    client.push("subagent.complete", { sessionKey: "done-ok" });
    client.push("subagent.error", { sessionKey: "boom", error: "kaboom" });
    client.push("node.connected", { nodeId: "n1", name: "Node One" });
    client.push("node.disconnected", { nodeId: "n1" });
    client.push("heartbeat", { ts: 123456 });

    vi.runAllTimers();

    const all = flatten(batches);

    const complete = all.filter(
      (e): e is Extract<WorldEvent, { kind: "agent.complete" }> => e.kind === "agent.complete",
    );
    const ok = complete.find((e) => e.sessionKey === "done-ok");
    const failed = complete.find((e) => e.sessionKey === "boom");
    expect(ok?.success).toBe(true);
    expect(failed?.success).toBe(false);

    const upserts = all.filter(
      (e): e is Extract<WorldEvent, { kind: "node.upsert" }> => e.kind === "node.upsert",
    );
    expect(upserts.some((e) => e.node.id === "n1")).toBe(true);

    const removes = all.filter(
      (e): e is Extract<WorldEvent, { kind: "node.remove" }> => e.kind === "node.remove",
    );
    expect(removes.some((e) => e.nodeId === "n1")).toBe(true);

    const ticks = all.filter(
      (e): e is Extract<WorldEvent, { kind: "period.tick" }> => e.kind === "period.tick",
    );
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0].epochMs).toBe(123456);

    bridge.destroy();
  });

  it("stops delivering events after destroy()", () => {
    const { bridge, client } = makeBridge();
    const batches: WorldEvent[][] = [];
    bridge.subscribe((events) => batches.push(events));

    bridge.destroy();
    // Stored handler is detached on unsubscribe; even if invoked, destroyed
    // bridges ignore frames and clear subscribers.
    for (let i = 0; i < 5; i++) {
      client.handler?.({
        type: "event",
        event: "subagent.spawned",
        payload: { sessionKey: "late-" + i, label: "late", status: "working" },
      } as GatewayEventFrame);
    }

    vi.runAllTimers();

    expect(batches.length).toBe(0);
    expect(client.unsubCalls).toBe(1);
  });
});
