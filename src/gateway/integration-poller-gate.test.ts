import { afterEach, describe, expect, it, vi } from "vitest";

import { startWhenConfigured } from "./integration-poller-gate.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startWhenConfigured", () => {
  it("starts immediately when the integration is already configured", async () => {
    const start = vi.fn();
    const gate = await startWhenConfigured({ name: "x", isConfigured: () => true, start });
    expect(start).toHaveBeenCalledTimes(1);
    expect(gate.started()).toBe(true);
  });

  it("stays idle while unconfigured and starts once it becomes configured", async () => {
    vi.useFakeTimers();
    let configured = false;
    const start = vi.fn();
    const gate = await startWhenConfigured({
      name: "x",
      isConfigured: () => configured,
      start,
      recheckMs: 1000,
    });
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(start).not.toHaveBeenCalled();
    configured = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(gate.started()).toBe(true);
  });

  it("a failing configuration check never starts the poller", async () => {
    const start = vi.fn();
    const warn = vi.fn();
    const gate = await startWhenConfigured({
      name: "x",
      isConfigured: () => {
        throw new Error("boom");
      },
      start,
      log: { info: vi.fn(), warn },
    });
    gate.stop();
    expect(start).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
