import { describe, expect, it } from "vitest";

import {
  buildCompletedEntries,
  completedVerdictOf,
  deployStateOf,
  filterCompleted,
  formatDuration,
  haloAlpha,
  type CompletionRecordLite,
} from "./completed";
import type { ScreenshotEntry } from "./types";

const NOW = 10_000_000_000;

function rec(runId: string, patch: Partial<CompletionRecordLite> = {}): CompletionRecordLite {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    label: `Run ${runId}`,
    startedAt: NOW - 600_000,
    terminalAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    state: "verified",
    attempts: [{}, {}],
    result: { summary: "Fixed the panel. Also tidied CSS.", commits: ["abc"], files_changed: ["a.ts", "b.ts"] },
    review: { verdict: "VERIFIED", changedFiles: ["b.ts", "c.ts"], commits: ["abc", "def"] },
    ...patch,
  };
}

describe("completed entries", () => {
  it("maps verdicts from state", () => {
    expect(completedVerdictOf({ state: "verified" })).toBe("VERIFIED");
    expect(completedVerdictOf({ state: "needs_owner" })).toBe("NEEDS_OWNER");
    expect(completedVerdictOf({ state: "failed" })).toBe("FAILED");
    expect(completedVerdictOf({ state: "unverified" })).toBe("UNVERIFIED");
    expect(completedVerdictOf({ state: "stalled", review: { verdict: "FAILED" } })).toBe("FAILED");
  });

  it("builds entries within the window, newest first, with merged counts and thumbs", () => {
    const shots = [
      { id: "s1", runId: "a", thumbUrl: "/t/1", ts: 1 },
      { id: "s2", runId: "a", thumbUrl: "/t/2", ts: 5 },
    ] as unknown as ScreenshotEntry[];
    const entries = buildCompletedEntries(
      [
        rec("a"),
        rec("b", { terminalAt: NOW - 1000 }),
        rec("old", { terminalAt: NOW - 30 * 3_600_000 }),
        rec("running", { state: "running", terminalAt: null }),
      ],
      { now: NOW, screenshots: shots, threads: new Map([["a", { messageCount: 3 }]]) },
    );
    expect(entries.map((e) => e.runId)).toEqual(["b", "a"]);
    const a = entries[1];
    expect(a.files).toBe(3);
    expect(a.commits).toBe(2);
    expect(a.durationMs).toBe(540_000);
    expect(a.summary).toBe("Fixed the panel.");
    expect(a.thumbUrl).toBe("/t/2");
    expect(a.screenshots).toBe(2);
    expect(a.hasThread).toBe(true);
    expect(a.attempts).toBe(2);
  });

  it("filters by verdict group, search and window", () => {
    const entries = buildCompletedEntries(
      [rec("v"), rec("u", { state: "unverified" }), rec("o", { state: "needs_owner" }), rec("f", { state: "failed", label: "Deploy fix" })],
      { now: NOW },
    );
    expect(filterCompleted(entries, { filter: "verified" }).map((e) => e.runId)).toEqual(["v"]);
    expect(filterCompleted(entries, { filter: "attention" }).map((e) => e.runId).sort()).toEqual(["o", "u"]);
    expect(filterCompleted(entries, { filter: "failed" }).map((e) => e.runId)).toEqual(["f"]);
    expect(filterCompleted(entries, { q: "deploy" }).map((e) => e.runId)).toEqual(["f"]);
    expect(filterCompleted(entries, { windowMs: 30_000, now: NOW })).toHaveLength(0);
  });
});

describe("deploy state", () => {
  it("prefers explicit tags", () => {
    expect(deployStateOf({ tags: { deploy: "restart-pending" }, result: null })).toBe("restart_pending");
  });
  it("reads conservative signals from the RESULT text", () => {
    const r = (summary: string, open_issues: string[] = []) => deployStateOf({ result: { summary, open_issues } });
    expect(r("Deployed live as abc123.")).toBe("live");
    expect(r("Merged into release branch.")).toBe("merged");
    expect(r("Built OK.", ["Gateway restart pending"])).toBe("restart_pending");
    expect(r("Committed on the branch, not deployed.")).toBe("not_deployed");
    expect(r("Not merged or deployed yet")).toBe("not_deployed");
    expect(r("Refactored the store.")).toBeNull();
    expect(r("")).toBeNull();
  });
});

describe("formatting + halo", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_725_000)).toBe("1h 02m");
  });
  it("halo holds then fades to zero", () => {
    expect(haloAlpha(NOW, NOW)).toBe(1);
    expect(haloAlpha(NOW - 60_000, NOW)).toBe(1);
    const mid = haloAlpha(NOW - (90_000 + (15 * 60_000 - 90_000) / 2), NOW);
    expect(mid).toBeCloseTo(0.5);
    expect(haloAlpha(NOW - 20 * 60_000, NOW)).toBe(0);
  });
});
