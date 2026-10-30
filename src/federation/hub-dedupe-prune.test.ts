import { describe, expect, it } from "vitest";
import { pruneTunneledDedupe, TUNNELED_DEDUPE_MAX, TUNNELED_DEDUPE_TTL_MS } from "./hub.js";

describe("pruneTunneledDedupe", () => {
  it("drops expired entries and caps the size (oldest first)", () => {
    const now = 10_000_000;
    const m = new Map<string, unknown>();
    m.set("old", { ts: now - TUNNELED_DEDUPE_TTL_MS - 1, ok: true, payload: "x".repeat(1000) });
    for (let i = 0; i < TUNNELED_DEDUPE_MAX + 500; i++) m.set(`k${i}`, { ts: now, ok: true });
    pruneTunneledDedupe(m, now);
    expect(m.has("old")).toBe(false);
    expect(m.size).toBe(TUNNELED_DEDUPE_MAX);
    expect(m.has("k0")).toBe(false);
    expect(m.has(`k${TUNNELED_DEDUPE_MAX + 499}`)).toBe(true);
  });
});
