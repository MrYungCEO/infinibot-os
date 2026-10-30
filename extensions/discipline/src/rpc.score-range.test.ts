/**
 * `discipline.score.range` — arbitrary-window day scores for the analytics
 * chart. Previously unserved: the chart silently fell back to deriving scores
 * from the local log cache because the RPC always threw `unknown method`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const computeDayScore = vi.fn((date: string) => ({ date, compliance: 100 }));

vi.mock("./store.js", () => ({
  getDisciplineStore: () => ({ computeDayScore }),
}));

// No side-effect stubs needed: rpc.ts arms nothing at import (the plugin's
// service owns every timer/subscription).
const { createDisciplineHandlers } = await import("./rpc.js");
const disciplineHandlers = createDisciplineHandlers({
  stateDir: () => "/tmp/discipline-test-state",
  gatherBusinessSnapshot: async () => {
    throw new Error("not used");
  },
});

type Reply = { ok: boolean; payload?: any; error?: any };

async function call(params: Record<string, unknown>): Promise<Reply> {
  const handler = disciplineHandlers["discipline.score.range"];
  let reply: Reply | undefined;
  await handler!({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      reply = { ok, payload, error };
    },
  } as any);
  return reply!;
}

beforeEach(() => computeDayScore.mockClear());

describe("discipline.score.range", () => {
  it("returns one row per day, inclusive of both endpoints, oldest first", async () => {
    const res = await call({ from: "2026-03-01", to: "2026-03-04" });

    expect(res.ok).toBe(true);
    expect(res.payload.map((d: any) => d.date)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
    ]);
  });

  it("handles a single-day range", async () => {
    const res = await call({ from: "2026-03-01", to: "2026-03-01" });
    expect(res.payload).toHaveLength(1);
  });

  it("rejects an inverted range instead of looping forever", async () => {
    const res = await call({ from: "2026-03-10", to: "2026-03-01" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("caps an absurd window so a bad range cannot walk thousands of days", async () => {
    const res = await call({ from: "2000-01-01", to: "2026-01-01" });
    expect(res.ok).toBe(true);
    expect(res.payload.length).toBe(366);
  });

  it("defaults to the trailing 7 days when `from` is missing", async () => {
    const res = await call({ to: "2026-03-10" });
    expect(res.payload.map((d: any) => d.date)).toEqual([
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
  });

  it("ignores malformed dates rather than producing Invalid Date rows", async () => {
    const res = await call({ from: "not-a-date", to: "2026-03-10" });
    expect(res.ok).toBe(true);
    expect(res.payload).toHaveLength(7);
  });
});
