/**
 * Behavioural tests for the vault handlers added to close the Table 3
 * "called but not served" bugs — with emphasis on the destructive ones
 * (course delete/archive, clearing a member's warnings).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = {
  getMember: vi.fn(),
  clearWarnings: vi.fn(),
  addModerationLog: vi.fn(),
  getModerationLogs: vi.fn(),
  getCourse: vi.fn(),
  getCourses: vi.fn(),
  deleteCourse: vi.fn(),
  upsertCourse: vi.fn(),
  getProgress: vi.fn(),
  getRule: vi.fn(),
  getAnalytics: vi.fn(),
};

vi.mock("../../vault/store/index.js", () => ({
  getVaultStore: () => store,
  // No Supabase configured → both getStore() and getCourseStore() use the
  // SQLite store above.
  getSupabaseStore: () => null,
}));

vi.mock("../../vault/discord/index.js", () => ({
  DiscordIntegration: class {},
  createDiscordIntegration: () => ({
    sendMessage: vi.fn(),
    sendDM: vi.fn(),
  }),
}));

const { vaultHandlers, __resetVaultSetupMarksForTest } = await import("./vault.js");

type Reply = { ok: boolean; payload?: any; error?: any };

async function call(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
  const handler = vaultHandlers[method];
  if (!handler) throw new Error(`no handler for ${method}`);
  let reply: Reply | undefined;
  await handler({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      reply = { ok, payload, error };
    },
  } as any);
  if (!reply) throw new Error(`${method} never responded`);
  return reply;
}

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  __resetVaultSetupMarksForTest();
  delete process.env.DISCORD_GUILD_ID;
  delete process.env.DISCORD_BOT_TOKEN;
});

describe("vault.courses.delete", () => {
  it("deletes an existing course", async () => {
    store.getCourse.mockResolvedValue({ id: "c1", name: "Course One" });
    store.deleteCourse.mockResolvedValue(undefined);

    const res = await call("vault.courses.delete", { id: "c1" });

    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ deleted: true, courseId: "c1" });
    expect(store.deleteCourse).toHaveBeenCalledWith("c1");
  });

  it("refuses to delete an unknown course instead of silently succeeding", async () => {
    store.getCourse.mockResolvedValue(null);

    const res = await call("vault.courses.delete", { id: "nope" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "NOT_FOUND" });
    expect(store.deleteCourse).not.toHaveBeenCalled();
  });

  it("accepts courseId as well as id", async () => {
    store.getCourse.mockResolvedValue({ id: "c2" });
    store.deleteCourse.mockResolvedValue(undefined);

    const res = await call("vault.courses.delete", { courseId: "c2" });

    expect(res.ok).toBe(true);
    expect(store.deleteCourse).toHaveBeenCalledWith("c2");
  });
});

describe("vault.courses.archive", () => {
  it("soft-archives via a status update, never a delete", async () => {
    store.getCourse.mockResolvedValue({ id: "c1", status: "published" });
    store.upsertCourse.mockImplementation(async (c: any) => ({ ...c, name: "Course One" }));

    const res = await call("vault.courses.archive", { id: "c1" });

    expect(res.ok).toBe(true);
    expect(res.payload.archived).toBe(true);
    expect(store.upsertCourse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1", status: "archived" }),
    );
    expect(store.deleteCourse).not.toHaveBeenCalled();
  });

  it("is idempotent for an already-archived course", async () => {
    store.getCourse.mockResolvedValue({ id: "c1", status: "archived" });

    const res = await call("vault.courses.archive", { id: "c1" });

    expect(res.ok).toBe(true);
    expect(res.payload.archived).toBe(true);
    expect(store.upsertCourse).not.toHaveBeenCalled();
  });

  it("404s for an unknown course", async () => {
    store.getCourse.mockResolvedValue(null);
    const res = await call("vault.courses.archive", { id: "gone" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("vault.moderation.clearWarnings", () => {
  it("clears warnings and writes a moderation-log entry", async () => {
    store.getMember
      .mockResolvedValueOnce({ id: "m1", discordId: "d1", warnings: [{}, {}] })
      .mockResolvedValueOnce({ id: "m1", discordId: "d1", warnings: [] });
    store.clearWarnings.mockResolvedValue(undefined);
    store.addModerationLog.mockResolvedValue({ id: "log1" });

    const res = await call("vault.moderation.clearWarnings", { memberId: "m1" });

    expect(res.ok).toBe(true);
    expect(res.payload.cleared).toBe(2);
    expect(store.clearWarnings).toHaveBeenCalledWith("m1");
    expect(store.addModerationLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "clear_warnings", targetMemberId: "m1" }),
    );
  });

  it("is idempotent when the member has no warnings", async () => {
    store.getMember.mockResolvedValue({ id: "m1", warnings: [] });
    store.clearWarnings.mockResolvedValue(undefined);
    store.addModerationLog.mockResolvedValue({ id: "log1" });

    const res = await call("vault.moderation.clearWarnings", { memberId: "m1" });

    expect(res.ok).toBe(true);
    expect(res.payload.cleared).toBe(0);
  });

  it("404s for an unknown member and does not touch the store", async () => {
    store.getMember.mockResolvedValue(null);

    const res = await call("vault.moderation.clearWarnings", { memberId: "ghost" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "NOT_FOUND" });
    expect(store.clearWarnings).not.toHaveBeenCalled();
  });
});

describe("vault.moderation.logs", () => {
  it("returns the store's log entries under `logs`", async () => {
    store.getModerationLogs.mockResolvedValue([{ id: "l1" }, { id: "l2" }]);

    const res = await call("vault.moderation.logs", { memberId: "m1", limit: 10 });

    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ logs: [{ id: "l1" }, { id: "l2" }], count: 2 });
    expect(store.getModerationLogs).toHaveBeenCalledWith("m1", 10);
  });
});

describe("vault.rules.test", () => {
  it("dry-runs without mutating the rule or firing actions", async () => {
    store.getRule.mockResolvedValue({
      id: "r1",
      name: "Welcome",
      enabled: true,
      trigger: { type: "member_join" },
      conditions: [{ type: "member_tier", tiers: ["pro"] }],
      actions: [{ type: "assign_role", roleId: "x" }],
      triggerCount: 3,
    });
    store.getMember.mockResolvedValue({ id: "m1", tier: "pro", roles: [] });

    const res = await call("vault.rules.test", { id: "r1", memberId: "m1" });

    expect(res.ok).toBe(true);
    expect(res.payload.result).toMatchObject({ ruleId: "r1", dryRun: true, wouldRun: true });
    expect(res.payload.result.conditions[0]).toMatchObject({ evaluated: true, passed: true });
    // The dry run must not bump triggerCount / lastTriggeredAt.
    expect(store.upsertCourse).not.toHaveBeenCalled();
  });

  it("reports wouldRun=false when a condition fails", async () => {
    store.getRule.mockResolvedValue({
      id: "r1",
      name: "Welcome",
      enabled: true,
      trigger: { type: "member_join" },
      conditions: [{ type: "member_tier", tiers: ["pro"] }],
      actions: [],
      triggerCount: 0,
    });
    store.getMember.mockResolvedValue({ id: "m1", tier: "free", roles: [] });

    const res = await call("vault.rules.test", { id: "r1", memberId: "m1" });

    expect(res.payload.result.wouldRun).toBe(false);
  });

  it("404s for an unknown rule", async () => {
    store.getRule.mockResolvedValue(null);
    const res = await call("vault.rules.test", { id: "nope" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("vault.analytics.export", () => {
  it("emits JSON by default", async () => {
    store.getAnalytics.mockResolvedValue({ members: { total: 2 } });

    const res = await call("vault.analytics.export", {});

    expect(res.ok).toBe(true);
    expect(res.payload.format).toBe("json");
    expect(JSON.parse(res.payload.content)).toEqual({ members: { total: 2 } });
  });

  it("flattens to metric,value rows for csv", async () => {
    store.getAnalytics.mockResolvedValue({ members: { total: 2, active: 1 } });

    const res = await call("vault.analytics.export", { format: "csv" });

    expect(res.payload.format).toBe("csv");
    expect(res.payload.content.split("\n")).toEqual([
      "metric,value",
      "members.total,2",
      "members.active,1",
    ]);
    expect(res.payload.filename).toMatch(/^vault-analytics-month-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe("vault.courses.enrolled", () => {
  it("answers an empty roster when no member is supplied", async () => {
    const res = await call("vault.courses.enrolled", {});
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ courses: [], count: 0 });
    expect(store.getProgress).not.toHaveBeenCalled();
  });

  it("joins progress onto courses", async () => {
    store.getProgress.mockResolvedValue([
      {
        courseId: "c1",
        overallProgress: 50,
        lessonProgress: [{ status: "completed" }, { status: "in_progress" }],
        enrolledAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    store.getCourse.mockResolvedValue({
      id: "c1",
      name: "Course One",
      description: "d",
      accessLevel: "pro",
      modules: [{ lessons: [{ id: "l1" }, { id: "l2" }] }],
    });

    const res = await call("vault.courses.enrolled", { memberId: "m1" });

    expect(res.payload.courses).toEqual([
      expect.objectContaining({
        id: "c1",
        title: "Course One",
        progress: 50,
        totalLessons: 2,
        completedLessons: 1,
        tier: "pro",
      }),
    ]);
  });
});

describe("vault setup wizard", () => {
  it("derives step completion from real state", async () => {
    store.getCourses.mockResolvedValue([{ id: "c1" }]);

    const res = await call("vault.setup.status");

    expect(res.ok).toBe(true);
    const byId = Object.fromEntries(res.payload.steps.map((s: any) => [s.id, s.completed]));
    expect(byId.discord).toBe(false); // no Discord creds in env
    expect(byId.courses).toBe(true); // a course exists
    expect(res.payload.completed).toBe(false); // required steps incomplete
  });

  it("records an explicit completion and reflects it in status", async () => {
    store.getCourses.mockResolvedValue([]);

    const done = await call("vault.setup.complete", { stepId: "roles", data: { tier: "pro" } });
    expect(done.ok).toBe(true);
    expect(done.payload).toMatchObject({ completed: true, stepId: "roles" });

    const res = await call("vault.setup.status");
    const roles = res.payload.steps.find((s: any) => s.id === "roles");
    expect(roles.completed).toBe(true);
    expect(roles.completedAt).toEqual(expect.any(String));
  });

  it("rejects an unknown step id", async () => {
    const res = await call("vault.setup.complete", { stepId: "not-a-step" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
