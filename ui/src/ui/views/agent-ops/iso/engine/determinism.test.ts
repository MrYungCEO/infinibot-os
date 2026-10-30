/**
 * Determinism harness tests: PRNG reproducibility + replay validation.
 */

import { describe, expect, it } from "vitest";
import {
  Rng,
  hashState,
  stableStringify,
  diffHashStreams,
  ReplayValidator,
  type RecordedEvent,
  type SimStep,
} from "./determinism";

describe("Rng", () => {
  it("same seed → identical stream", () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds → different streams", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it("next() stays in [0,1)", () => {
    const r = new Rng(777);
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("int() is inclusive and in range", () => {
    const r = new Rng(5);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(r.int(1, 6));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("a zero seed does not lock the generator to zero", () => {
    const r = new Rng(0);
    const vals = new Set(Array.from({ length: 20 }, () => r.nextUint32()));
    expect(vals.size).toBeGreaterThan(1);
    expect(vals.has(0)).toBe(false);
  });

  it("fork() yields an independent but deterministic stream", () => {
    const make = () => {
      const root = new Rng(2024);
      const child = root.fork(1);
      return Array.from({ length: 20 }, () => child.next());
    };
    expect(make()).toEqual(make()); // deterministic
  });

  it("getState/setState round-trips a replay cursor", () => {
    const r = new Rng(99);
    for (let i = 0; i < 10; i++) r.next();
    const cursor = r.getState();
    const after = Array.from({ length: 5 }, () => r.next());

    const r2 = new Rng(1);
    r2.setState(cursor);
    const replayed = Array.from({ length: 5 }, () => r2.next());
    expect(replayed).toEqual(after);
  });
});

describe("hashState", () => {
  it("is stable across key ordering", () => {
    expect(hashState({ a: 1, b: 2 })).toBe(hashState({ b: 2, a: 1 }));
  });

  it("changes when content changes", () => {
    expect(hashState({ a: 1 })).not.toBe(hashState({ a: 2 }));
  });

  it("stableStringify sorts nested keys", () => {
    expect(stableStringify({ b: { d: 1, c: 2 }, a: 3 })).toBe(
      '{"a":3,"b":{"c":2,"d":1}}',
    );
  });
});

// ── A small but real world sim, driven entirely by the seeded Rng + events ──

interface World {
  tick: number;
  agents: { id: number; x: number; y: number }[];
}

const step: SimStep<World> = (state, events, rng) => {
  const next: World = {
    tick: state.tick + 1,
    agents: state.agents.map((a) => ({
      id: a.id,
      // movement is a pure function of the seeded rng
      x: a.x + Math.round(rng.range(-2, 2)),
      y: a.y + Math.round(rng.range(-2, 2)),
    })),
  };
  for (const e of events) {
    if (e.type === "spawn") {
      const p = e.payload as { id: number };
      next.agents.push({ id: p.id, x: 0, y: 0 });
    }
  }
  return next;
};

describe("ReplayValidator", () => {
  const initial: World = {
    tick: 0,
    agents: [
      { id: 1, x: 10, y: 10 },
      { id: 2, x: 20, y: 20 },
    ],
  };
  const events: RecordedEvent[] = [
    { tick: 3, type: "spawn", payload: { id: 3 } },
    { tick: 7, type: "spawn", payload: { id: 4 } },
  ];

  it("produces identical hash streams for identical (seed, events)", () => {
    const v = new ReplayValidator(step);
    const result = v.validate(0xc0ffee, initial, events, 30);
    expect(result.ok).toBe(true);
    expect(result.divergedAt).toBeNull();
  });

  it("diverges when the seed changes", () => {
    const v = new ReplayValidator(step);
    const a = v.run(1, initial, events, 30);
    const b = v.run(2, initial, events, 30);
    const diff = diffHashStreams(a, b);
    expect(diff.ok).toBe(false);
    expect(diff.divergedAt).not.toBeNull();
  });

  it("diverges when an event is dropped", () => {
    const v = new ReplayValidator(step);
    const withEvent = v.run(5, initial, events, 30);
    const without = v.run(5, initial, [events[0]], 30);
    const diff = diffHashStreams(withEvent, without);
    expect(diff.ok).toBe(false);
    // First spawn is at tick 3, second at tick 7 → divergence at tick 7.
    expect(diff.divergedAt).toBe(7);
  });
});
