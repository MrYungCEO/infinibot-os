/**
 * Tests for the cross-node spawn idempotency guard: a replay with the same key
 * returns the recorded result instead of double-spawning.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getIdempotentResult,
  recordIdempotentResult,
  __clearIdempotencyCache,
} from "./spawn-idempotency.js";

beforeEach(() => {
  __clearIdempotencyCache();
});

describe("spawn idempotency", () => {
  it("returns undefined for a missing or blank key", () => {
    expect(getIdempotentResult("never-seen")).toBeUndefined();
    expect(getIdempotentResult("")).toBeUndefined();
    expect(getIdempotentResult(null)).toBeUndefined();
  });

  it("returns the recorded result for a known key (no double-spawn)", () => {
    recordIdempotentResult("k1", { runId: "r1" });
    expect(getIdempotentResult("k1")).toEqual({ runId: "r1" });
  });

  it("never records under a blank key", () => {
    recordIdempotentResult("", { runId: "x" });
    expect(getIdempotentResult("")).toBeUndefined();
  });

  it("expires entries after their TTL", () => {
    recordIdempotentResult("k2", { runId: "r2" }, -1); // already expired
    expect(getIdempotentResult("k2")).toBeUndefined();
  });
});
