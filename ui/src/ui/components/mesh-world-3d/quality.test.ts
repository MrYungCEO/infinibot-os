import { describe, expect, it } from "vitest";
import { AutoTier, FpsMeter, initialTier, settingsFor } from "./quality";

function run(auto: AutoTier, fps: number, ms: number, start = 0): { changes: string[]; end: number } {
  const dt = 1000 / fps;
  const changes: string[] = [];
  let t = start;
  while (t < start + ms) {
    t += dt;
    const c = auto.frame(dt, t);
    if (c) changes.push(c);
  }
  return { changes, end: t };
}

describe("quality tiers", () => {
  it("caps DPR harder on phones and drops effects on low", () => {
    expect(settingsFor("high").maxPixelRatio).toBe(2);
    expect(settingsFor("high", { mobile: true }).maxPixelRatio).toBe(1.75);
    const low = settingsFor("low");
    expect(low).toMatchObject({ bloom: false, shadows: false, dust: false, maxPixelRatio: 1, reflections: false, particles: false, drones: 0 });
    expect(settingsFor("high")).toMatchObject({ bloom: true, reflections: true, particles: true });
    expect(settingsFor("medium", { mobile: true }).bloom).toBe(false);
  });

  it("picks a conservative starting tier on phones", () => {
    expect(initialTier({ mobile: true, cores: 4, memoryGb: 3 })).toBe("low");
    expect(initialTier({ mobile: true, cores: 8, memoryGb: 8 })).toBe("medium");
    expect(initialTier({ cores: 12 })).toBe("high");
  });
});

describe("AutoTier", () => {
  it("ignores the warm-up window (shader compiles) after start", () => {
    const auto = new AutoTier("high");
    const a = run(auto, 8, 2_400);
    expect(a.changes).toEqual([]);
    const b = run(auto, 60, 6_000, a.end);
    expect(b.changes).toEqual([]);
    expect(auto.tier).toBe("high");
  });

  it("steps down while fps stays under budget, and stops at low", () => {
    const auto = new AutoTier("high");
    const { changes } = run(auto, 30, 14_000);
    expect(changes).toEqual(["medium", "low"]);
    expect(auto.tier).toBe("low");
  });

  it("holds the tier at 60 fps and never re-enters a tier it fell out of", () => {
    const auto = new AutoTier("high");
    const a = run(auto, 30, 4_700);
    expect(a.changes).toEqual(["medium"]);
    const b = run(auto, 60, 30_000, a.end);
    expect(b.changes).toEqual([]);
    expect(auto.tier).toBe("medium");
  });

  it("upgrades after sustained headroom", () => {
    const auto = new AutoTier("low");
    const { changes } = run(auto, 60, 30_000);
    expect(changes).toEqual(["medium", "high"]);
  });

  it("steps all the way down on software GL (3–5 fps frames are slow, not pauses)", () => {
    const auto = new AutoTier("high");
    const { changes } = run(auto, 4, 40_000);
    expect(changes).toEqual(["medium", "low"]);
  });

  it("ignores pauses (long gaps are not slow frames)", () => {
    const auto = new AutoTier("high");
    expect(auto.frame(5000, 5000)).toBeNull();
    const { changes } = run(auto, 60, 4_000, 5000);
    expect(changes).toEqual([]);
  });
});

describe("FpsMeter", () => {
  it("averages recent frame times", () => {
    const m = new FpsMeter(10);
    for (let i = 0; i < 20; i++) m.push(1000 / 60);
    expect(Math.round(m.fps)).toBe(60);
    m.push(1500); // pause — ignored
    expect(Math.round(m.fps)).toBe(60);
  });
});
