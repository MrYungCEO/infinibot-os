/**
 * Determinism harness: seedable PRNG + replay validation.
 * ───────────────────────────────────────────────────────
 * The world viz must be *reproducible*: given the same seed and the same
 * input event log, re-running the simulation has to produce bit-identical
 * state. That is what lets us record a session, replay it for debugging, and
 * trust that a regression is real and not RNG drift.
 *
 * The single source of non-determinism in JS sims is `Math.random()`. This
 * module replaces it with a seedable xorshift32 generator. Every world
 * subsystem that needs randomness draws from a {@link Rng} (forked per
 * subsystem from a root seed) instead of `Math.random`, so the entire run is
 * a pure function of (seed, events).
 *
 * `hashState` + {@link ReplayValidator} turn that property into an assertion:
 * hash the world state each tick and compare the hash streams of two runs.
 */

/**
 * xorshift32 PRNG. Fast, tiny, period 2³²−1 — ample for visual simulation.
 * Deterministic across platforms (pure uint32 math, no float accumulation).
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Never allow a zero state (xorshift would lock to 0).
    this.state = (seed | 0) === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  /** Raw next uint32. */
  nextUint32(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextUint32() / 0x100000000;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Pick a random element. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  /**
   * Derive an independent child generator. Lets each subsystem own its own
   * stream so adding/removing a draw in one subsystem can't shift another's
   * sequence. `salt` distinguishes sibling forks.
   */
  fork(salt = 0): Rng {
    return new Rng((this.nextUint32() ^ (salt * 0x85ebca6b)) >>> 0);
  }

  /** Snapshot the internal state (for save/restore of a replay cursor). */
  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = (state | 0) === 0 ? 0x9e3779b9 : state >>> 0;
  }
}

/**
 * FNV-1a 32-bit hash of an arbitrary serialisable value. Stable ordering is
 * the caller's responsibility — pass plain objects with consistent key order
 * (or arrays). Returns an 8-char hex string.
 */
export function hashState(value: unknown): string {
  const str = typeof value === "string" ? value : stableStringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** JSON.stringify with sorted object keys, so key order never affects a hash. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

export interface RecordedEvent<P = unknown> {
  /** Sim tick at which the event applies. */
  tick: number;
  type: string;
  payload?: P;
}

/**
 * A reducer that advances world state by one tick given the events scheduled
 * for that tick and a seeded Rng. Must be pure w.r.t. (state, events, rng).
 */
export type SimStep<S> = (state: S, events: RecordedEvent[], rng: Rng) => S;

export interface ReplayResult {
  ok: boolean;
  /** First tick at which the two runs' hashes diverged, or null if identical. */
  divergedAt: number | null;
  hashesA: string[];
  hashesB: string[];
}

/**
 * Runs a simulation from (seed, initialState) for `ticks` steps, applying any
 * recorded events scheduled at each tick, and returns the per-tick state-hash
 * stream. Two invocations with the same inputs MUST return identical streams.
 */
export class ReplayValidator<S> {
  constructor(
    private readonly step: SimStep<S>,
    private readonly clone: (s: S) => S = (s) => JSON.parse(JSON.stringify(s)),
  ) {}

  run(seed: number, initialState: S, events: RecordedEvent[], ticks: number): string[] {
    const rng = new Rng(seed);
    let state = this.clone(initialState);
    const byTick = groupByTick(events);
    const hashes: string[] = [];
    for (let t = 0; t < ticks; t++) {
      state = this.step(state, byTick.get(t) ?? [], rng);
      hashes.push(hashState(state));
    }
    return hashes;
  }

  /** Run twice with identical inputs and assert hash-stream equality. */
  validate(seed: number, initialState: S, events: RecordedEvent[], ticks: number): ReplayResult {
    const hashesA = this.run(seed, initialState, events, ticks);
    const hashesB = this.run(seed, initialState, events, ticks);
    return diffHashStreams(hashesA, hashesB);
  }
}

/** Compare two hash streams, reporting the first divergence. */
export function diffHashStreams(a: string[], b: string[]): ReplayResult {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return { ok: false, divergedAt: i, hashesA: a, hashesB: b };
    }
  }
  return { ok: true, divergedAt: null, hashesA: a, hashesB: b };
}

function groupByTick(events: RecordedEvent[]): Map<number, RecordedEvent[]> {
  const m = new Map<number, RecordedEvent[]>();
  for (const e of events) {
    const list = m.get(e.tick);
    if (list) list.push(e);
    else m.set(e.tick, [e]);
  }
  return m;
}
