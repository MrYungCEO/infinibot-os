import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgencyDataBridge, type WorldEvent } from "./agency-data-bridge";
import {
  MAX_RESTING_COMPLETED,
  RESTING_STORAGE_KEY,
  RestingRing,
} from "../views/agent-ops/resting-completed";

// ── Test doubles ──────────────────────────────────────────────

function memStorage(seed?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    raw: m,
  };
}

type Sub = { sessionKey: string; label: string; status: string };

function fakeClient() {
  const state = { subs: [] as Sub[] };
  let frameCb: ((evt: any) => void) | null = null;
  const client = {
    request: vi.fn(async (method: string) => {
      if (method === "subagents.list") return { subagents: state.subs.map((s) => ({ ...s })) };
      if (method === "sessions.list") return { sessions: [] };
      return {};
    }),
    subscribe: (cb: (evt: any) => void) => {
      frameCb = cb;
      return () => {
        frameCb = null;
      };
    },
  };
  return {
    client: client as any,
    state,
    emit: (event: string, payload: unknown) => frameCb?.({ type: "event", event, payload }),
  };
}

const key = (i: number) => `agent:main:subagent:run-${i}`;

async function setup(opts: { storage?: ReturnType<typeof memStorage>; subs?: Sub[] } = {}) {
  const storage = opts.storage ?? memStorage();
  const fc = fakeClient();
  if (opts.subs) fc.state.subs = opts.subs;
  const ring = new RestingRing(storage);
  const bridge = new AgencyDataBridge(fc.client, { resting: ring });
  const batches: WorldEvent[][] = [];
  bridge.subscribe((b) => batches.push(b));
  await vi.advanceTimersByTimeAsync(250); // snapshot + 200ms flush
  const drain = async () => {
    await vi.advanceTimersByTimeAsync(250);
    const all = batches.flat();
    batches.length = 0;
    return all;
  };
  const reconcile = async () => {
    await (bridge as any).reconcile();
    return drain();
  };
  const first = batches.flat();
  batches.length = 0;
  return { bridge, ring, storage, fc, drain, reconcile, first };
}

let clock = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────

describe("RestingRing", () => {
  it("caps at MAX_RESTING_COMPLETED and evicts the oldest first", () => {
    expect(MAX_RESTING_COMPLETED).toBe(10);
    const ring = new RestingRing(memStorage());
    const evicted: string[] = [];
    for (let i = 1; i <= 12; i++) {
      evicted.push(
        ...ring.add({ sessionKey: key(i), agentId: "main", label: `R${i}`, nodeId: "local", success: true, endedAt: i }),
      );
    }
    expect(ring.size).toBe(10);
    expect(evicted).toEqual([key(1), key(2)]);
    expect(ring.list().map((e) => e.sessionKey)).toEqual(
      Array.from({ length: 10 }, (_, n) => key(12 - n)),
    );
  });

  it("survives corrupt storage", () => {
    const ring = new RestingRing(memStorage({ [RESTING_STORAGE_KEY]: "{not json" }));
    expect(ring.size).toBe(0);
  });
});

describe("AgencyDataBridge — recently-completed resting ring", () => {
  it("keeps finished agents (completed + failed) and evicts the 11th-oldest with agent.leave", async () => {
    const subs: Sub[] = Array.from({ length: 12 }, (_, n) => ({
      sessionKey: key(n + 1),
      label: `Run ${n + 1}`,
      status: "running",
    }));
    const t = await setup({ subs });
    expect(t.first.filter((e) => e.kind === "agent.spawn")).toHaveLength(12);

    // Finish all 12 in order; run 3 fails.
    for (let i = 1; i <= 12; i++) {
      t.fc.emit(i === 3 ? "subagent.error" : "subagent.complete", { sessionKey: key(i) });
    }
    const ev = await t.drain();
    const completes = ev.filter((e) => e.kind === "agent.complete");
    expect(completes).toHaveLength(12);
    expect(completes.find((e: any) => e.sessionKey === key(3))).toMatchObject({ success: false });
    const leaves = ev.filter((e) => e.kind === "agent.leave").map((e: any) => e.sessionKey);
    expect(leaves).toEqual([key(1), key(2)]);
    expect(t.ring.list().map((e) => e.sessionKey)).toEqual(
      Array.from({ length: 10 }, (_, n) => key(12 - n)),
    );
    expect(t.ring.list().find((e) => e.sessionKey === key(3))?.success).toBe(false);
    t.bridge.destroy();
  });

  it("does not re-spawn / re-complete resting agents on reconcile ticks", async () => {
    const t = await setup({ subs: [{ sessionKey: key(1), label: "A", status: "running" }] });
    t.fc.state.subs = [{ sessionKey: key(1), label: "A", status: "completed" }];
    const first = await t.reconcile();
    expect(first.filter((e) => e.kind === "agent.complete")).toHaveLength(1);
    expect(t.ring.has(key(1))).toBe(true);

    // Still in the grace window (terminal), then dropped out of the list.
    expect(await t.reconcile()).toEqual([]);
    t.fc.state.subs = [];
    expect(await t.reconcile()).toEqual([]);
    expect(await t.reconcile()).toEqual([]);
    // Duplicate completion frames are ignored too.
    t.fc.emit("subagent.complete", { sessionKey: key(1) });
    expect(await t.drain()).toEqual([]);
    expect(t.ring.has(key(1))).toBe(true);
    t.bridge.destroy();
  });

  it("finishes an agent that silently drops out of the lists", async () => {
    const t = await setup({ subs: [{ sessionKey: key(1), label: "A", status: "running" }] });
    t.fc.state.subs = [];
    const ev = await t.reconcile();
    expect(ev).toEqual([{ kind: "agent.complete", sessionKey: key(1), success: true, message: undefined }]);
    expect(t.ring.has(key(1))).toBe(true);
    t.bridge.destroy();
  });

  it("does not conjure a sleeper for an unknown completion", async () => {
    const t = await setup();
    t.fc.emit("subagent.complete", { sessionKey: key(99) });
    await t.drain();
    expect(t.ring.size).toBe(0);
    t.bridge.destroy();
  });

  it("wakes a resting agent when its session goes active again", async () => {
    const t = await setup({ subs: [{ sessionKey: key(1), label: "A", status: "running" }] });
    t.fc.emit("subagent.complete", { sessionKey: key(1) });
    await t.drain();
    expect(t.ring.has(key(1))).toBe(true);

    t.fc.state.subs = [{ sessionKey: key(1), label: "A", status: "running" }];
    const ev = await t.reconcile();
    const spawn = ev.find((e) => e.kind === "agent.spawn") as any;
    expect(spawn?.agent.status).toBe("working");
    expect(t.ring.has(key(1))).toBe(false);
    // Now live again: a steady reconcile is quiet, and a later finish re-rests it.
    expect(await t.reconcile()).toEqual([]);
    t.fc.emit("subagent.complete", { sessionKey: key(1) });
    await t.drain();
    expect(t.ring.has(key(1))).toBe(true);
    t.bridge.destroy();
  });

  it("wakes via a live respawn / resumed progress frame", async () => {
    const t = await setup({
      subs: [
        { sessionKey: key(1), label: "A", status: "running" },
        { sessionKey: key(2), label: "B", status: "running" },
      ],
    });
    t.fc.emit("subagent.complete", { sessionKey: key(1) });
    t.fc.emit("subagent.complete", { sessionKey: key(2) });
    await t.drain();
    t.fc.emit("subagent.spawned", { sessionKey: key(1), label: "A" });
    t.fc.emit("session.progress", { sessionKey: key(2), status: "running" });
    await t.drain();
    expect(t.ring.has(key(1))).toBe(false);
    expect(t.ring.has(key(2))).toBe(false);
    t.bridge.destroy();
  });

  it("restores the last ≤10 finished runs on reload (oldest first), without duplicates", async () => {
    const storage = memStorage();
    const subs: Sub[] = Array.from({ length: 12 }, (_, n) => ({
      sessionKey: key(n + 1),
      label: `Run ${n + 1}`,
      status: "running",
    }));
    const a = await setup({ storage, subs });
    for (let i = 1; i <= 12; i++) a.fc.emit("subagent.complete", { sessionKey: key(i) });
    await a.drain();
    a.bridge.destroy();

    // Reload: nothing live, runs 11 and 12 still inside the list's grace window.
    const b = await setup({
      storage,
      subs: [
        { sessionKey: key(11), label: "Run 11", status: "completed" },
        { sessionKey: key(12), label: "Run 12", status: "completed" },
      ],
    });
    const spawns = b.first.filter((e) => e.kind === "agent.spawn") as any[];
    expect(spawns.map((s) => s.agent.sessionKey)).toEqual(
      Array.from({ length: 10 }, (_, n) => key(n + 3)),
    );
    expect(spawns.every((s) => s.agent.status === "completed")).toBe(true);
    expect(spawns[0].agent.label).toBe("Run 3");
    // And the next reconcile doesn't touch them.
    expect(await b.reconcile()).toEqual([]);
    b.bridge.destroy();
  });
});
