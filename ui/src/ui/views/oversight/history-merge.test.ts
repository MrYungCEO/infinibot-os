import { describe, expect, it } from "vitest";
import { historyRowToSubagent, mergeLiveAndHistory } from "./history-merge";

describe("oversight history merge", () => {
  it("keeps archived runs visible when the live spine is empty (post-restart)", () => {
    const merged = mergeLiveAndHistory(
      [],
      [
        { runId: "a", task: "t1", status: "complete", startedAt: 1, endedAt: 10 },
        { runId: "b", task: "t2", status: "error", endedAt: 20, outcome: { status: "error", error: "boom" } },
      ],
    );
    expect(merged.map((r) => r.runId)).toEqual(["b", "a"]);
    expect(merged[1]).toMatchObject({ status: "completed", progress: 100, endedAt: 10, archived: true });
    expect(merged[0]).toMatchObject({ status: "error", outcome: { error: "boom" } });
  });

  it("prefers the live row on runId collisions", () => {
    const merged = mergeLiveAndHistory(
      [{ runId: "a", status: "working", lastUpdateAt: 50 }],
      [{ runId: "a", status: "complete", endedAt: 10 }, { runId: "c", status: "timeout", endedAt: 5 }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ runId: "a", status: "working" });
    expect(merged[1]).toMatchObject({ runId: "c", status: "timeout" });
  });

  it("drops malformed archive rows", () => {
    expect(historyRowToSubagent({ runId: "", endedAt: 1 })).toBeNull();
    expect(historyRowToSubagent({ runId: "x" })).toBeNull();
  });
});
