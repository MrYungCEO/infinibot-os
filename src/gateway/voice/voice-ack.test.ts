import { afterEach, describe, expect, it, vi } from "vitest";

import { ackIntentFor, clearAcksForTests, isBannedAck, pickAck, scheduleAck } from "./voice-ack.js";

afterEach(() => {
  clearAcksForTests();
  vi.useRealTimers();
});

describe("filler policy", () => {
  it("never uses the old canned line", () => {
    expect(isBannedAck("One moment, let me check.")).toBe(true);
    expect(isBannedAck("On it, one moment.")).toBe(true);
    const ack = pickAck("call-1", "lookup", "One moment, let me check.");
    expect(ack).not.toMatch(/one moment/i);
  });

  it("varies: no phrase repeats within the last three acks of a call", () => {
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) seen.push(pickAck("call-2", "lookup"));
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    expect(new Set(seen.slice(0, 3)).size).toBe(3);
  });

  it("keeps a fresh model-written ack", () => {
    expect(pickAck("call-3", "action", "Sending it to Alex now")).toBe("Sending it to Alex now.");
    // …but not the same words twice on one call
    expect(pickAck("call-3", "action", "Sending it to Alex now")).not.toBe(
      "Sending it to Alex now.",
    );
  });

  it("maps tools to intents", () => {
    expect(ackIntentFor(["sessions_spawn"])).toBe("delegate");
    expect(ackIntentFor(["telegram_send"])).toBe("action");
    expect(ackIntentFor(["web_search"])).toBe("lookup");
    expect(ackIntentFor([], "hello there")).toBe("generic");
  });

  it("speaks only when nothing was said within the delay (fast tool = no filler)", () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    let answered = false;
    const fast = scheduleAck({
      delayMs: 700,
      spoken: () => answered,
      speak: (t) => spoken.push(t),
      phrase: () => "Okay.",
    });
    vi.advanceTimersByTime(300);
    answered = true; // the tool answered in 300 ms
    vi.advanceTimersByTime(1000);
    expect(spoken).toEqual([]);
    expect(fast.fired()).toBe(false);

    answered = false;
    const slow = scheduleAck({
      delayMs: 700,
      spoken: () => answered,
      speak: (t) => spoken.push(t),
      phrase: () => "Okay.",
    });
    vi.advanceTimersByTime(701);
    expect(spoken).toEqual(["Okay."]);
    expect(slow.fired()).toBe(true);
  });

  it("cancel stops a pending ack", () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const h = scheduleAck({
      spoken: () => false,
      speak: (t) => spoken.push(t),
      phrase: () => "Okay.",
    });
    h.cancel();
    vi.advanceTimersByTime(2000);
    expect(spoken).toEqual([]);
  });
});
