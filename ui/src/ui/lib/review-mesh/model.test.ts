import { describe, expect, it } from "vitest";

import {
  PacketScheduler,
  ThreadStore,
  arcPoint,
  distinctValues,
  filterScreenshots,
  groupScreenshotsByRun,
  isPacketMessage,
  lodCaps,
  mergeMessages,
  mergeScreenshots,
  needsOwner,
  orbitSlots,
  packetTone,
  recentThreads,
  scheduleReplay,
  travelsToReviewer,
  workerOf,
  MAX_PACKETS,
} from "./model";
import type { ReviewMessage, ReviewThreadSummary, ScreenshotEntry } from "./types";

const W = "agent:main:subagent:abc";

function msg(seq: number, patch: Partial<ReviewMessage> = {}): ReviewMessage {
  const fromReviewer = patch.from === "reviewer";
  return {
    id: `r1#${seq}`,
    seq,
    runId: "r1",
    ts: 1_000_000 + seq * 60_000,
    round: 1,
    attempt: 1,
    from: "worker",
    to: "reviewer",
    fromAgent: fromReviewer ? "auditor" : W,
    toAgent: fromReviewer ? W : "auditor",
    kind: "submission",
    title: `m${seq}`,
    text: "",
    ...patch,
  };
}

function summary(runId: string, lastTs: number, patch: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary {
  return {
    runId,
    label: runId,
    workerAgent: W,
    childSessionKey: W,
    requesterSessionKey: "agent:main:main",
    backend: null,
    state: "running",
    verdict: null,
    rounds: 1,
    messageCount: 1,
    startedAt: 0,
    lastTs,
    lastKind: "submission",
    lastTitle: "",
    escalated: false,
    screenshots: 0,
    ...patch,
  };
}

function shot(id: string, patch: Partial<ScreenshotEntry> = {}): ScreenshotEntry {
  return {
    id,
    path: `/p/${id}.png`,
    url: `/api/verification/file?path=${id}`,
    thumbUrl: `/api/verification/file?path=${id}&thumb=1`,
    runId: "run-a",
    label: "Panel",
    agent: W,
    route: "/mesh",
    viewport: "1440x900",
    theme: "dark",
    ts: 1000,
    verdict: "pass",
    runState: null,
    runVerdict: null,
    visualDir: null,
    source: "visual_verify",
    ...patch,
  };
}

describe("packet colours", () => {
  it("maps kinds and verdicts to tones", () => {
    expect(packetTone(msg(1, { kind: "submission" }))).toBe("gold");
    expect(packetTone(msg(1, { kind: "challenge" }))).toBe("amber");
    expect(packetTone(msg(1, { kind: "challenge", evidence: [{ kind: "command", ref: "x", status: "fail" }] }))).toBe("red");
    expect(packetTone(msg(1, { kind: "challenge", evidence: [{ kind: "command", ref: "x", status: "warn" }] }))).toBe("amber");
    expect(packetTone(msg(1, { kind: "response" }))).toBe("cyan");
    expect(packetTone(msg(1, { kind: "verdict", verdict: "VERIFIED" }))).toBe("green");
    expect(packetTone(msg(1, { kind: "verdict", verdict: "FAILED" }))).toBe("red");
    expect(packetTone(msg(1, { kind: "verdict", verdict: "changes_needed" }))).toBe("red");
    expect(packetTone(msg(1, { kind: "verdict", verdict: "escalate" }))).toBe("magenta");
    expect(packetTone(msg(1, { kind: "action" }))).toBe("violet");
  });

  it("actions are pulses, not packets; direction and worker resolution", () => {
    expect(isPacketMessage(msg(1, { kind: "action" }))).toBe(false);
    expect(isPacketMessage(msg(1, { kind: "verdict" }))).toBe(true);
    expect(travelsToReviewer(msg(1))).toBe(true);
    const back = msg(2, { from: "reviewer", to: "worker", kind: "challenge" });
    expect(travelsToReviewer(back)).toBe(false);
    expect(workerOf(back)).toBe(W);
    expect(workerOf(msg(3))).toBe(W);
  });

  it("needsOwner covers escalation, escalate verdict and needs_owner state", () => {
    expect(needsOwner(summary("a", 1, { escalated: true }))).toBe(true);
    expect(needsOwner(summary("a", 1, { verdict: "escalate" }))).toBe(true);
    expect(needsOwner(summary("a", 1, { state: "needs_owner" }))).toBe(true);
    expect(needsOwner(summary("a", 1))).toBe(false);
    expect(needsOwner(null)).toBe(false);
  });
});

describe("thread store", () => {
  it("merges by seq, incoming wins, ascending order", () => {
    const merged = mergeMessages([msg(1), msg(3)], [msg(2), msg(3, { title: "new" })]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(merged[2].title).toBe("new");
  });

  it("dedupes live messages by seq and reports freshness", () => {
    const store = new ThreadStore();
    expect(store.ingest({ message: msg(1), summary: null }).fresh).toBe(true);
    expect(store.ingest({ message: msg(1), summary: null }).fresh).toBe(false);
    const r = store.ingest({ message: msg(2, { from: "reviewer", to: "worker", kind: "verdict", verdict: "VERIFIED" }), summary: null });
    expect(r.fresh).toBe(true);
    expect(r.thread.messages).toHaveLength(2);
    expect(r.thread.summary.verdict).toBe("VERIFIED");
    expect(r.thread.summary.workerAgent).toBe(W);
  });

  it("out-of-order arrival still sorts; setThread fills history and marks complete", () => {
    const store = new ThreadStore();
    store.ingest({ message: msg(3), summary: null });
    store.ingest({ message: msg(1), summary: null });
    expect(store.get("r1")!.messages.map((m) => m.seq)).toEqual([1, 3]);
    const t = store.setThread({
      summary: summary("r1", 9),
      reviewer: { id: "auditor", name: "Auditor", title: "", station: "executive", icon: "shield" },
      messages: [msg(1), msg(2), msg(3)],
    });
    expect(t.complete).toBe(true);
    expect(t.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("setSummaries never rolls back a newer live summary", () => {
    const store = new ThreadStore();
    store.ingest({ message: msg(5), summary: summary("r1", 2_000_000, { lastTitle: "live" }) });
    store.setSummaries([summary("r1", 1, { lastTitle: "stale" }), summary("r2", 5)]);
    expect(store.get("r1")!.summary.lastTitle).toBe("live");
    expect(store.get("r2")).toBeTruthy();
  });

  it("is bounded: evicts the oldest threads and caps messages", () => {
    const store = new ThreadStore(3, 2);
    store.setSummaries([summary("a", 1), summary("b", 2), summary("c", 3), summary("d", 4)]);
    expect(store.size).toBe(3);
    expect(store.get("a")).toBeUndefined();
    expect(store.list().map((t) => t.summary.runId)).toEqual(["d", "c", "b"]);
    for (let i = 1; i <= 5; i++) store.ingest({ message: { ...msg(i), runId: "d" }, summary: null });
    expect(store.get("d")!.messages.map((m) => m.seq)).toEqual([4, 5]);
  });
});

describe("replay scheduling", () => {
  it("orders by seq, dedupes and compresses gaps within bounds", () => {
    const steps = scheduleReplay([msg(3), msg(1), msg(2), msg(2)], { minGapMs: 500, maxGapMs: 1500, compression: 60 });
    expect(steps.map((s) => s.message.seq)).toEqual([1, 2, 3]);
    // 60s real gap / 60 = 1000ms
    expect(steps.map((s) => s.delayMs)).toEqual([0, 1000, 2000]);
  });

  it("clamps tiny and huge gaps and honours lastN + startDelay", () => {
    const ms = [msg(1, { ts: 0 }), msg(2, { ts: 10 }), msg(3, { ts: 10_000_000 })];
    expect(scheduleReplay(ms, { minGapMs: 400, maxGapMs: 900 }).map((s) => s.delayMs)).toEqual([0, 400, 1300]);
    const last2 = scheduleReplay(ms, { lastN: 2, startDelayMs: 250, minGapMs: 400, maxGapMs: 900 });
    expect(last2.map((s) => s.message.seq)).toEqual([2, 3]);
    expect(last2[0].delayMs).toBe(250);
  });

  it("recentThreads keeps threads inside the window, newest first", () => {
    const now = 1_000_000;
    const ts = [now - 1000, now - 20 * 60_000, now - 5000].map((t, i) => ({ summary: summary(`t${i}`, t) }));
    expect(recentThreads(ts, now, 10 * 60_000).map((t) => t.summary.runId)).toEqual(["t0", "t2"]);
  });

  it("PacketScheduler respects due time, cap and backlog", () => {
    const s = new PacketScheduler<string>(3);
    s.enqueue("late", 100);
    s.enqueue("a", 0);
    s.enqueue("b", 0);
    expect(s.take(0, 0, 10)).toEqual(["a", "b"]);
    expect(s.take(50, 0, 10)).toEqual([]);
    expect(s.take(100, 12, 12)).toEqual([]);
    expect(s.take(100, 11, 12)).toEqual(["late"]);
    for (const x of ["1", "2", "3", "4", "5"]) s.enqueue(x, 0);
    expect(s.length).toBe(3);
    expect(s.take(0, 0, 10)).toEqual(["3", "4", "5"]);
    s.enqueue("x", 0);
    s.remove((i) => i === "x");
    expect(s.length).toBe(0);
  });
});

describe("LOD caps", () => {
  it("full fidelity at normal zoom on desktop", () => {
    const c = lodCaps({ zoom: 1, lowPower: false });
    expect(c.maxPackets).toBe(MAX_PACKETS);
    expect(c.maxThumbs).toBe(12);
    expect(c.trailDots).toBeGreaterThan(0);
    expect(c.packetTargets).toBe(true);
  });
  it("low power / reduced motion cut packets, thumbs and trails", () => {
    for (const c of [lodCaps({ zoom: 1, lowPower: true }), lodCaps({ zoom: 1, lowPower: false, reducedMotion: true })]) {
      expect(c.maxPackets).toBeLessThanOrEqual(4);
      expect(c.maxThumbs).toBeLessThanOrEqual(4);
      expect(c.trailDots).toBe(0);
    }
  });
  it("zooming out drops thumbnails entirely and trails", () => {
    expect(lodCaps({ zoom: 0.45, lowPower: false }).maxThumbs).toBe(4);
    const far = lodCaps({ zoom: 0.25, lowPower: false });
    expect(far.maxThumbs).toBe(0);
    expect(far.trailDots).toBe(0);
    expect(far.packetTargets).toBe(false);
  });
  it("mobile gets a reduced budget", () => {
    const m = lodCaps({ zoom: 1, lowPower: false, mobile: true });
    expect(m.maxPackets).toBeLessThan(MAX_PACKETS);
    expect(m.maxThumbs).toBe(6);
  });
});

describe("geometry", () => {
  it("arcPoint hits endpoints and lifts the middle", () => {
    const out = { x: 0, y: 0 };
    expect(arcPoint(0, 0, 100, 0, 50, 0, out)).toEqual({ x: 0, y: 0 });
    expect(arcPoint(0, 0, 100, 0, 50, 1, out)).toEqual({ x: 100, y: 0 });
    arcPoint(0, 0, 100, 0, 50, 0.5, out);
    expect(out.x).toBeCloseTo(50);
    expect(out.y).toBeCloseTo(-25);
  });
  it("orbit slots: newest nearest (inner ring first), all distinct", () => {
    const slots = orbitSlots(12, { innerRadius: 100, outerRadius: 200, squash: 1 });
    expect(slots).toHaveLength(12);
    const r = slots.map((p) => Math.hypot(p.x, p.y));
    for (let i = 0; i < 6; i++) expect(r[i]).toBeCloseTo(100);
    for (let i = 6; i < 12; i++) expect(r[i]).toBeCloseTo(200);
    // all above the island centre (upper arc)
    for (const p of slots) expect(p.y).toBeLessThan(0.0001);
    const keys = new Set(slots.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
    expect(keys.size).toBe(12);
  });
});

describe("screenshot gallery", () => {
  const items = [
    shot("a", { ts: 100, verdict: "pass", route: "/mesh", viewport: "1440x900", runId: "r1", label: "Mesh" }),
    shot("b", { ts: 300, verdict: "fail", route: "/mesh", viewport: "390x844", runId: "r1", label: "Mesh", assessment: { pass: false, summary: "overflow", issues: ["Clipped button"] } }),
    shot("c", { ts: 200, verdict: "pass", route: "/chat", viewport: "390x844", runId: "r2", label: "Chat", agent: "agent:x" }),
  ];
  it("filters by verdict, route, viewport, agent, run and date", () => {
    expect(filterScreenshots(items, { verdict: "fail" }).map((s) => s.id)).toEqual(["b"]);
    expect(filterScreenshots(items, { verdict: "all", route: "/mesh" }).map((s) => s.id)).toEqual(["a", "b"]);
    expect(filterScreenshots(items, { viewport: "390x844" }).map((s) => s.id)).toEqual(["b", "c"]);
    expect(filterScreenshots(items, { agent: "agent:x" }).map((s) => s.id)).toEqual(["c"]);
    expect(filterScreenshots(items, { runId: "r1", since: 150 }).map((s) => s.id)).toEqual(["b"]);
    expect(filterScreenshots(items, { until: 150 }).map((s) => s.id)).toEqual(["a"]);
  });
  it("search matches label, route and assessment issues (case-insensitive)", () => {
    expect(filterScreenshots(items, { q: "clipped" }).map((s) => s.id)).toEqual(["b"]);
    expect(filterScreenshots(items, { q: "CHAT" }).map((s) => s.id)).toEqual(["c"]);
    expect(filterScreenshots(items, { q: "  " })).toHaveLength(3);
  });
  it("groups by run, newest first, with pass/fail counts", () => {
    const g = groupScreenshotsByRun(items);
    expect(g.map((x) => x.runId)).toEqual(["r1", "r2"]);
    expect(g[0].items.map((s) => s.id)).toEqual(["b", "a"]);
    expect([g[0].pass, g[0].fail]).toEqual([1, 1]);
  });
  it("merges by id newest-first with a cap; distinct values sorted", () => {
    const m = mergeScreenshots(items, [shot("a", { ts: 999 }), shot("d", { ts: 50 })], 3);
    expect(m.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(distinctValues(items, "viewport")).toEqual(["1440x900", "390x844"]);
  });
});
