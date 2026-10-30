import { describe, expect, it } from "vitest";
import { authFailureLogKey, createAuthFailureLogLimiter } from "./auth-failure-log.js";

describe("auth failure log limiter", () => {
  it("logs the first failure per client, then one line per window with the suppressed count", () => {
    let t = 0;
    const lim = createAuthFailureLogLimiter({ windowMs: 60_000, now: () => t });
    const key = authFailureLogKey("100.118.96.70", "webchat");
    expect(lim.hit(key)).toEqual({ emit: true, suppressed: 0 });
    // The app's old ~1/s retry loop for 59 seconds.
    for (let i = 1; i < 60; i++) {
      t = i * 1000;
      expect(lim.hit(key).emit).toBe(false);
    }
    t = 60_000;
    expect(lim.hit(key)).toEqual({ emit: true, suppressed: 59 });
    t = 61_000;
    expect(lim.hit(key)).toEqual({ emit: false, suppressed: 1 });
  });

  it("keys clients independently", () => {
    const lim = createAuthFailureLogLimiter({ now: () => 0 });
    expect(lim.hit(authFailureLogKey("a", "webchat")).emit).toBe(true);
    expect(lim.hit(authFailureLogKey("b", "webchat")).emit).toBe(true);
    expect(lim.hit(authFailureLogKey("a", "cli")).emit).toBe(true);
    expect(lim.hit(authFailureLogKey("a", "webchat")).emit).toBe(false);
  });

  it("bounds memory under a flood of distinct clients", () => {
    let t = 0;
    const lim = createAuthFailureLogLimiter({ maxKeys: 10, now: () => t });
    for (let i = 0; i < 100; i++) {
      t = i;
      lim.hit(`ip-${i}|x`);
    }
    expect(lim.size()).toBeLessThanOrEqual(10);
  });
});
