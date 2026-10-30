import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkforceOperatingStore } from "./operating-store.js";
import { WorkforceStore } from "./store.js";

describe("durable employee operating loops", () => {
  let directory: string;
  let dbPath: string;
  let workforce: WorkforceStore;
  let operating: WorkforceOperatingStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "infinibot-loop-"));
    dbPath = join(directory, "agency.db");
    workforce = new WorkforceStore(dbPath);
    workforce.createWorker({
      agencyId: "agency-a",
      id: "manager",
      type: "human",
      displayName: "Manager",
    });
    workforce.createWorker({
      agencyId: "agency-a",
      id: "agent",
      type: "ai",
      displayName: "Agent",
    });
    workforce.createWorker({
      agencyId: "agency-b",
      id: "agent",
      type: "ai",
      displayName: "Other Agent",
    });
    operating = new WorkforceOperatingStore(dbPath);
  });

  afterEach(() => {
    operating.close();
    workforce.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("generates recurring inbox work exactly once and advances the recurrence", () => {
    const now = Date.UTC(2026, 6, 24, 9);
    operating.createResponsibility("agency-a", {
      id: "daily-report",
      workerId: "agent",
      managerWorkerId: "manager",
      title: "Daily delivery report",
      instructions: "Summarize progress and blockers.",
      cadence: "daily",
      interval: 1,
      weekday: null,
      monthDay: null,
      runAt: "09:00",
      slaMinutes: 60,
      priority: "high",
      enabled: true,
      nextRunAt: now,
      context: { channel: "ops" },
    });

    const first = operating.tick("agency-a", now);
    const second = operating.tick("agency-a", now);
    expect(first.generatedWorkItemIds).toHaveLength(1);
    expect(second.generatedWorkItemIds).toHaveLength(0);
    expect(operating.listWorkItems("agency-a")).toHaveLength(1);
    expect(operating.listResponsibilities("agency-a")[0]?.nextRunAt).toBe(now + 86_400_000);
  });

  it("enforces deterministic lifecycle transitions and SLA escalation", () => {
    const now = Date.UTC(2026, 6, 24, 10);
    const item = operating.enqueueWorkItem("agency-a", {
      workerId: "agent",
      managerWorkerId: "manager",
      title: "Client QA",
      dueAt: now - 1,
      scheduledFor: now - 3_600_000,
    });
    expect(() => operating.transitionWorkItem("agency-a", item.id, "completed", { now })).toThrow(
      "invalid work item transition",
    );
    operating.transitionWorkItem("agency-a", item.id, "accepted", { now });
    operating.transitionWorkItem("agency-a", item.id, "in_progress", { now });
    const tick = operating.tick("agency-a", now);
    const escalated = operating.getWorkItem("agency-a", item.id)!;
    expect(tick.escalatedWorkItemIds).toEqual([item.id]);
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalationLevel).toBe(1);
  });

  it("maintains agency isolation for inbox, schedules, reviews, and memory", () => {
    operating.createSchedule("agency-a", {
      workerId: "agent",
      timezone: "UTC",
      weekdays: [1, 2, 3, 4, 5],
      shiftStart: "09:00",
      shiftEnd: "17:00",
      effectiveFrom: "2026-07-01",
      effectiveTo: null,
      enabled: true,
    });
    operating.enqueueWorkItem("agency-a", { workerId: "agent", title: "Agency A only" });
    operating.enqueueWorkItem("agency-b", { workerId: "agent", title: "Agency B only" });
    operating.upsertJobMemory("agency-a", {
      workerId: "agent",
      namespace: "client",
      key: "tone",
      value: "direct",
    });
    operating.createReviewCycle("agency-a", {
      workerId: "agent",
      managerWorkerId: "manager",
      cadenceDays: 7,
      nextReviewAt: 100,
    });

    expect(operating.listWorkItems("agency-a")[0]?.title).toBe("Agency A only");
    expect(operating.listWorkItems("agency-b")[0]?.title).toBe("Agency B only");
    expect(operating.listSchedules("agency-b")).toEqual([]);
    expect(operating.listJobMemory("agency-a", "agent")[0]?.value).toBe("direct");
    expect(operating.tick("agency-a", 100).dueReviewCycleIds).toHaveLength(1);
  });

  it("upserts durable job context and rolls completed manager reviews forward", () => {
    operating.upsertJobMemory("agency-a", {
      workerId: "agent",
      namespace: "project",
      key: "brief",
      value: { version: 1 },
    });
    operating.upsertJobMemory("agency-a", {
      workerId: "agent",
      namespace: "project",
      key: "brief",
      value: { version: 2 },
    });
    expect(operating.listJobMemory("agency-a", "agent", "project")).toHaveLength(1);
    expect(operating.listJobMemory("agency-a", "agent", "project")[0]?.value).toEqual({
      version: 2,
    });

    const cycle = operating.createReviewCycle("agency-a", {
      workerId: "agent",
      managerWorkerId: "manager",
      cadenceDays: 14,
      nextReviewAt: 1_000,
      agenda: ["quality", "blockers"],
    });
    const completed = operating.completeReviewCycle("agency-a", cycle.id, "On track", 2_000);
    expect(completed.lastReviewAt).toBe(2_000);
    expect(completed.nextReviewAt).toBe(2_000 + 14 * 86_400_000);
    expect(completed.outcome).toBe("On track");
  });

  it("schedules an omitted nextRunAt from now instead of the Unix epoch", () => {
    // The create RPC defaults this param to 0. Persisting that verbatim showed
    // up in the UI as "next 20657d ago" and made the loop advance one interval
    // per tick from 1970, so it could never reach the present.
    const responsibility = operating.createResponsibility("agency-a", {
      workerId: "agent",
      managerWorkerId: null,
      title: "Sweep stale projects",
      instructions: "Close out abandoned work.",
      cadence: "daily",
      interval: 1,
      weekday: null,
      monthDay: null,
      runAt: "09:00",
      slaMinutes: 1_440,
      priority: "normal",
      enabled: true,
      nextRunAt: 0,
      context: {},
    });
    expect(responsibility.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("catches a stale recurrence up to the present rather than crawling one interval per tick", () => {
    const now = Date.UTC(2026, 6, 26, 12);
    operating.createResponsibility("agency-a", {
      id: "stale",
      workerId: "agent",
      managerWorkerId: null,
      title: "Long-neglected duty",
      instructions: "Run me.",
      cadence: "daily",
      interval: 1,
      weekday: null,
      monthDay: null,
      runAt: "09:00",
      slaMinutes: 60,
      priority: "normal",
      enabled: true,
      // Explicitly years in the past, as a row created before the fix would be.
      nextRunAt: Date.UTC(1970, 0, 4, 9),
      context: {},
    });

    operating.tick("agency-a", now);
    const next = operating
      .listResponsibilities("agency-a")
      .find((item) => item.id === "stale")?.nextRunAt;
    // One tick must land it in the future, not merely on 1970-01-05.
    expect(next).toBeGreaterThan(now);
  });
});
