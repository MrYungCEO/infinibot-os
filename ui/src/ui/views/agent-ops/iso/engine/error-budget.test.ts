/**
 * Error-budget tests: protected calls swallow throws, degrade after a burst,
 * skip while degraded, recover the window over time, and report health.
 */

import { describe, expect, it, vi } from "vitest";
import { ErrorBudget } from "./error-budget";

/** Budget with an injected clock + silent logger for deterministic tests. */
function makeBudget(maxErrors = 3, windowMs = 1000) {
  let nowMs = 0;
  const logs: string[] = [];
  const budget = new ErrorBudget({
    maxErrors,
    windowMs,
    now: () => nowMs,
    logger: (sub, err) => logs.push(`${sub}:${String(err)}`),
  });
  return {
    budget,
    logs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("ErrorBudget", () => {
  it("returns the result of a successful call", () => {
    const { budget } = makeBudget();
    expect(budget.runProtected("flock", () => 42)).toBe(42);
  });

  it("swallows a throw and returns undefined", () => {
    const { budget } = makeBudget();
    const out = budget.runProtected("flock", () => {
      throw new Error("boom");
    });
    expect(out).toBeUndefined();
    expect(budget.isDegraded("flock")).toBe(false);
  });

  it("a throwing subsystem cannot break a sibling in the same frame", () => {
    const { budget } = makeBudget();
    let siblingRan = false;
    budget.runProtected("labels", () => {
      throw new Error("label crash");
    });
    budget.runProtected("sprites", () => {
      siblingRan = true;
    });
    expect(siblingRan).toBe(true);
  });

  it("degrades after exceeding maxErrors within the window", () => {
    const { budget } = makeBudget(3, 1000);
    const thrower = () => {
      throw new Error("x");
    };
    // maxErrors=3 → degrade on the 4th error.
    for (let i = 0; i < 4; i++) budget.runProtected("flock", thrower);
    expect(budget.isDegraded("flock")).toBe(true);
  });

  it("skips calls (does not invoke fn) once degraded", () => {
    const { budget } = makeBudget(3, 1000);
    for (let i = 0; i < 4; i++)
      budget.runProtected("flock", () => {
        throw new Error("x");
      });
    expect(budget.isDegraded("flock")).toBe(true);

    const spy = vi.fn(() => 1);
    const out = budget.runProtected("flock", spy);
    expect(out).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();

    const snap = budget.snapshot().find((s) => s.name === "flock")!;
    expect(snap.skippedCalls).toBeGreaterThanOrEqual(1);
  });

  it("does not degrade if errors are spread beyond the window", () => {
    const { budget, advance } = makeBudget(3, 1000);
    const thrower = () => {
      throw new Error("x");
    };
    for (let i = 0; i < 6; i++) {
      budget.runProtected("flock", thrower);
      advance(400); // 400ms apart → never >3 within any 1000ms window
    }
    expect(budget.isDegraded("flock")).toBe(false);
  });

  it("reset() un-degrades and clears the window", () => {
    const { budget } = makeBudget(3, 1000);
    for (let i = 0; i < 4; i++)
      budget.runProtected("flock", () => {
        throw new Error("x");
      });
    expect(budget.isDegraded("flock")).toBe(true);
    budget.reset("flock");
    expect(budget.isDegraded("flock")).toBe(false);
    expect(budget.runProtected("flock", () => 7)).toBe(7);
  });

  it("fires onDegrade exactly once on the transition", () => {
    let nowMs = 0;
    const onDegrade = vi.fn();
    const budget = new ErrorBudget({
      maxErrors: 2,
      windowMs: 1000,
      now: () => nowMs,
      logger: () => {},
      onDegrade,
    });
    for (let i = 0; i < 5; i++)
      budget.runProtected("flock", () => {
        throw new Error("x");
      });
    expect(onDegrade).toHaveBeenCalledTimes(1);
    expect(onDegrade.mock.calls[0][0]).toBe("flock");
  });

  it("snapshot + lastError surface health for the telemetry overlay", () => {
    const { budget } = makeBudget(5, 1000);
    budget.runProtected("flock", () => 1);
    budget.runProtected("labels", () => {
      throw new Error("nan in label");
    });

    const snap = budget.snapshot();
    const flock = snap.find((s) => s.name === "flock")!;
    const labels = snap.find((s) => s.name === "labels")!;
    expect(flock.totalCalls).toBe(1);
    expect(flock.errorCount).toBe(0);
    expect(labels.errorCount).toBe(1);
    expect(labels.lastError).toBe("nan in label");

    const last = budget.lastError();
    expect(last?.subsystem).toBe("labels");
    expect(last?.message).toBe("nan in label");
  });
});
