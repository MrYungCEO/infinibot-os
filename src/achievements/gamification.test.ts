/**
 * Gamification engine — XP economy, levels/ranks, quests, leaderboard.
 * Uses an isolated on-disk store in a temp dir so we exercise the real SQLite
 * path (not a mock) without touching the shared singleton db.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AchievementStore } from "./store.js";
import { AchievementWatcher } from "./watcher.js";
import {
  GamificationEngine,
  levelForXp,
  xpForLevel,
  rankForLevel,
  deriveProgression,
  XP_REWARDS,
} from "./gamification.js";

function makeEngine(now: number) {
  const dir = mkdtempSync(join(tmpdir(), "gami-"));
  const store = new AchievementStore(dir);
  const watcher = new AchievementWatcher({ store, now: () => now });
  const engine = new GamificationEngine({ store, watcher, now: () => now });
  return { engine, store, dir };
}

describe("levels & ranks (pure)", () => {
  it("derives levels from XP on the 50·L² curve", () => {
    expect(levelForXp(0)).toBe(1);
    expect(xpForLevel(2)).toBe(50);
    expect(levelForXp(50)).toBe(2);
    expect(levelForXp(200)).toBe(3);
  });

  it("derives ranks from level thresholds", () => {
    expect(rankForLevel(1).key).toBe("recruit");
    expect(rankForLevel(3).key).toBe("operator");
    expect(rankForLevel(25).key).toBe("legend");
  });

  it("produces a progress ring fraction within the level", () => {
    const p = deriveProgression({
      ownerId: "a",
      xp: 120,
      tasks: 2,
      tools: 0,
      handshakes: 0,
      updatedAt: 0,
    });
    expect(p.level).toBe(2);
    expect(p.xpIntoLevel).toBe(70); // 120 - floor(50)
    expect(p.xpForNextLevel).toBe(150); // xpForLevel(3)=200 minus 50
  });
});

describe("XP awards + leaderboard", () => {
  let ctx: ReturnType<typeof makeEngine>;
  beforeEach(() => (ctx = makeEngine(1_700_000_000_000)));
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("awards task XP (base + clean-ship bonus + clean-ship quest) and tracks counters", () => {
    ctx.engine.recordTaskCompletion("agent-x", { failed: false });
    const prog = ctx.engine.getProgression("agent-x");
    // base 50 + clean bonus 25 + the daily_clean_ship quest (target 1) reward 120.
    expect(prog.xp).toBe(XP_REWARDS.task + XP_REWARDS.cleanShipBonus + 120);
    expect(prog.tasks).toBe(1);
  });

  it("does not grant the clean-ship bonus on a failed task", () => {
    ctx.engine.recordTaskCompletion("agent-y", { failed: true });
    expect(ctx.engine.getProgression("agent-y").xp).toBe(XP_REWARDS.task);
  });

  it("ranks the leaderboard by XP and excludes the global bucket", () => {
    ctx.engine.recordTaskCompletion("low", { failed: true }); // 50
    ctx.engine.recordTaskCompletion("high", { failed: false }); // 75
    ctx.engine.recordTaskCompletion("high", { failed: false }); // 150
    const lb = ctx.engine.getLeaderboard();
    expect(lb[0].ownerId).toBe("high");
    expect(lb.find((e) => e.ownerId === "global")).toBeUndefined();
  });
});

describe("quests", () => {
  let ctx: ReturnType<typeof makeEngine>;
  beforeEach(() => (ctx = makeEngine(1_700_000_000_000)));
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("advances the daily-five-tasks quest and grants reward XP on completion", () => {
    for (let i = 0; i < 5; i++) ctx.engine.recordTaskCompletion("q", { failed: true });
    const quests = ctx.engine.getQuests("q");
    const five = quests.find((x) => x.defKind === "daily_five_tasks");
    expect(five?.progress).toBe(5);
    expect(five?.completedAt).not.toBeNull();
    // 5 tasks * 50 base + 150 quest reward = 400.
    expect(ctx.engine.getProgression("q").xp).toBe(5 * XP_REWARDS.task + 150);
  });

  it("counts only distinct tools toward the toolsmith quest", () => {
    ctx.engine.recordToolUse("t", "grep");
    ctx.engine.recordToolUse("t", "grep"); // dup — no quest progress
    ctx.engine.recordToolUse("t", "read");
    const tool = ctx.engine.getQuests("t").find((x) => x.defKind === "daily_three_tools");
    expect(tool?.progress).toBe(2);
  });
});
