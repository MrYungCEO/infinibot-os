import { describe, expect, it } from "vitest";
import { HudStatsTracker, formatHudNumber, isOnlineStatus } from "./hud-metrics";

describe("hud-metrics", () => {
  it("counts live agents and excludes resting finished runs", () => {
    const t = new HudStatsTracker();
    const agents = [
      { sessionKey: "a", status: "working" },
      { sessionKey: "b", status: "starting" },
      { sessionKey: "c", status: "finishing" },
      { sessionKey: "d", status: "idle" },
      { sessionKey: "e", status: "completed" },
      { sessionKey: "f", status: "failed" },
    ];
    expect(t.compute(agents, 1_000).online).toBe(4);
    expect(isOnlineStatus("blocked")).toBe(true);
    expect(isOnlineStatus("DONE")).toBe(false);
  });

  it("tools/min counts tool events in the trailing 60s and decays", () => {
    const t = new HudStatsTracker();
    t.noteTool(0);
    t.noteTool(30_000);
    t.noteTool(59_000);
    expect(t.compute([], 59_500).toolsPerMin).toBe(3);
    expect(t.compute([], 61_000).toolsPerMin).toBe(2);
    expect(t.compute([], 200_000).toolsPerMin).toBe(0);
  });

  it("tokens/hr is null (\"—\") when no agent reports usage", () => {
    const t = new HudStatsTracker();
    const agents = [{ sessionKey: "a", status: "working", totalTokens: 0 }];
    t.noteTokens(agents, 0);
    t.noteTokens(agents, 120_000);
    expect(t.compute(agents, 120_000).tokensPerHr).toBeNull();
    expect(formatHudNumber(null)).toBe("—");
  });

  it("tokens/hr extrapolates live growth only, not pre-existing history", () => {
    const t = new HudStatsTracker();
    t.noteTokens([{ sessionKey: "a", totalTokens: 50_000 }], 0);
    // Too early to extrapolate.
    expect(t.compute([], 5_000).tokensPerHr).toBeNull();
    t.noteTokens([{ sessionKey: "a", totalTokens: 51_000 }], 60_000);
    // A new agent's existing total is just its baseline.
    t.noteTokens([{ sessionKey: "b", inputTokens: 900_000, outputTokens: 100 }], 60_000);
    // 1000 tokens over 60s → 60k/hr.
    expect(t.compute([], 60_000).tokensPerHr).toBeCloseTo(60_000, 5);
    // Agent leaving (not in the sample) doesn't register as negative.
    t.noteTokens([{ sessionKey: "b", inputTokens: 900_000, outputTokens: 1_100 }], 120_000);
    expect(t.compute([], 120_000).tokensPerHr).toBeCloseTo(60_000, 5);
  });

  it("formats numbers compactly", () => {
    expect(formatHudNumber(0)).toBe("0");
    expect(formatHudNumber(1_500)).toBe("1.5k");
    expect(formatHudNumber(25_000)).toBe("25k");
    expect(formatHudNumber(2_400_000)).toBe("2.4M");
  });
});
