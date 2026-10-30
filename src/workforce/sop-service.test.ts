import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SOP_CRON_CATEGORY, sopCronJobName, sopCronSchedule } from "../cron/sop-jobs.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";
import { WorkforceOperatingStore } from "./operating-store.js";
import { attachSopSchedule, detachSopSchedule, runSopOnce } from "./sop-service.js";
import { WorkforceSopStore } from "./sop-store.js";
import type { SopServiceDeps } from "./sop-service.js";
import { WorkforceStore } from "./store.js";

const AGENCY = "agency-1";
const WORKER = "agency-1:ai:pm";

/** In-memory cron double. Never boots the real store or arms a timer. */
class FakeCron {
  jobs: CronJob[] = [];
  addCalls = 0;

  async list(): Promise<CronJob[]> {
    return [...this.jobs];
  }

  async add(input: CronJobCreate): Promise<CronJob> {
    this.addCalls += 1;
    const job: CronJob = {
      ...input,
      id: randomUUID(),
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      state: {},
    };
    this.jobs.push(job);
    return job;
  }

  async remove(id: string): Promise<{ ok: boolean; removed: boolean }> {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.id !== id);
    return { ok: true, removed: this.jobs.length !== before };
  }
}

let tempDir: string;
let sopStore: WorkforceSopStore;
let operating: WorkforceOperatingStore;
let workforce: WorkforceStore;
let cron: FakeCron;
let deps: SopServiceDeps;

function makeSop(overrides: Record<string, unknown> = {}) {
  return sopStore.createSop(AGENCY, {
    slug: "pm-daily-standup",
    name: "Daily standup and blocker sweep",
    summary: "Find blockers before they hit the client.",
    ownerWorkerId: WORKER,
    steps: [
      {
        title: "Pull state",
        instruction: "List every open work item.",
        expectedOutput: "Inventory.",
      },
      { title: "Escalate", instruction: "Escalate anything stalled." },
    ],
    acceptanceCriteria: ["Every blocker names an owner"],
    ...overrides,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "sop-service-"));
  const dbPath = join(tempDir, "agency.db");
  workforce = new WorkforceStore(dbPath);
  workforce.createWorker(
    {
      id: WORKER,
      agencyId: AGENCY,
      type: "ai",
      displayName: "Pace",
      title: "Project Manager",
      employmentType: "agent",
      agentId: "pm",
      modelBinding: "claude",
      autonomyLevel: 3,
    },
    "tester",
  );
  sopStore = new WorkforceSopStore(dbPath);
  operating = new WorkforceOperatingStore(dbPath);
  cron = new FakeCron();
  deps = { sopStore, operatingStore: operating, cron, workerStore: workforce };
});

afterEach(() => {
  sopStore.close();
  operating.close();
  workforce.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("sopCronSchedule", () => {
  it("maps a simple weekly cadence onto a real cron expression", () => {
    expect(
      sopCronSchedule({
        cadence: "weekly",
        interval: 1,
        weekday: 1,
        monthDay: null,
        runAt: "08:30",
      }),
    ).toEqual({ kind: "cron", expr: "30 8 * * 1", tz: "UTC" });
  });

  it("maps daily and monthly cadences onto cron expressions", () => {
    expect(
      sopCronSchedule({
        cadence: "daily",
        interval: 1,
        weekday: null,
        monthDay: null,
        runAt: "06:00",
      }),
    ).toEqual({ kind: "cron", expr: "0 6 * * *", tz: "UTC" });
    expect(
      sopCronSchedule({
        cadence: "monthly",
        interval: 1,
        weekday: null,
        monthDay: 5,
        runAt: "09:00",
      }),
    ).toEqual({ kind: "cron", expr: "0 9 5 * *", tz: "UTC" });
  });

  it("falls back to an interval schedule anchored in the FUTURE, never the epoch", () => {
    const now = Date.UTC(2026, 6, 26, 12, 0, 0);
    const schedule = sopCronSchedule(
      { cadence: "weekly", interval: 2, weekday: 1, monthDay: null, runAt: "09:00", nextRunAt: 0 },
      now,
    );
    expect(schedule.kind).toBe("every");
    if (schedule.kind !== "every") throw new Error("expected an interval schedule");
    expect(schedule.everyMs).toBe(14 * 86_400_000);
    expect(schedule.anchorMs).toBeGreaterThan(now);
  });
});

describe("attachSopSchedule", () => {
  it("creates a real cron job, a responsibility and a linked schedule", async () => {
    const sop = makeSop();
    const result = await attachSopSchedule(deps, AGENCY, {
      sopId: sop.id,
      workerId: WORKER,
      cadence: "daily",
      runAt: "08:00",
    });

    expect(result.changed).toBe(true);
    expect(result.cronJobCreated).toBe(true);
    expect(result.cronJob).not.toBeNull();
    expect(result.cronJob!.name).toBe(sopCronJobName(sop.slug, WORKER));
    expect(result.cronJob!.category).toBe(SOP_CRON_CATEGORY);
    expect(result.cronJob!.schedule).toEqual({ kind: "cron", expr: "0 8 * * *", tz: "UTC" });

    // The responsibility is what tick() actually materialises work from.
    expect(result.responsibility.title).toBe(sop.name);
    expect(result.responsibility.instructions).toContain("**Procedure**");
    expect(result.responsibility.context).toMatchObject({ sopId: sop.id, sopSlug: sop.slug });

    // …and the schedule row links all three together.
    expect(result.schedule.cronJobId).toBe(result.cronJob!.id);
    expect(result.schedule.responsibilityId).toBe(result.responsibility.id);
  });

  it("registers the cron job idempotently and never duplicates it", async () => {
    const sop = makeSop();
    const input = { sopId: sop.id, workerId: WORKER, cadence: "daily" as const, runAt: "08:00" };

    const first = await attachSopSchedule(deps, AGENCY, input);
    const second = await attachSopSchedule(deps, AGENCY, input);

    expect(cron.addCalls).toBe(1);
    expect(cron.jobs).toHaveLength(1);
    expect(second.cronJobCreated).toBe(false);
    expect(second.changed).toBe(false);
    expect(second.cronJob!.id).toBe(first.cronJob!.id);
    expect(sopStore.listSchedules(AGENCY, { sopId: sop.id })).toHaveLength(1);
    expect(operating.listResponsibilities(AGENCY)).toHaveLength(1);
    // Nothing was rewritten on the no-op pass.
    expect(second.schedule.updatedAt).toBe(first.schedule.updatedAt);
    expect(second.responsibility.updatedAt).toBe(first.responsibility.updatedAt);
  });

  it("never clobbers an operator's edits to the cron job", async () => {
    const sop = makeSop();
    const input = { sopId: sop.id, workerId: WORKER, cadence: "daily" as const, runAt: "08:00" };
    await attachSopSchedule(deps, AGENCY, input);

    // The operator pauses and re-times the job in Settings.
    cron.jobs[0].enabled = false;
    cron.jobs[0].schedule = { kind: "cron", expr: "0 22 * * *", tz: "UTC" };

    await attachSopSchedule(deps, AGENCY, input);
    expect(cron.jobs).toHaveLength(1);
    expect(cron.jobs[0].enabled).toBe(false);
    expect(cron.jobs[0].schedule).toEqual({ kind: "cron", expr: "0 22 * * *", tz: "UTC" });
  });

  it("NEVER persists an epoch nextRunAt, even when one is passed in", async () => {
    const sop = makeSop();
    const now = Date.UTC(2026, 6, 26, 12, 0, 0);
    const result = await attachSopSchedule({ ...deps, now: () => now }, AGENCY, {
      sopId: sop.id,
      workerId: WORKER,
      cadence: "daily",
      runAt: "09:00",
      nextRunAt: 0,
    });

    expect(result.schedule.nextRunAt).toBeGreaterThan(now);
    expect(result.responsibility.nextRunAt).toBeGreaterThan(now);
    // …and it is one real interval away, not ~20,000 days ago.
    expect(result.responsibility.nextRunAt - now).toBeLessThanOrEqual(2 * 86_400_000);
  });

  it("re-anchors the responsibility when the cadence changes, but not otherwise", async () => {
    const sop = makeSop();
    const first = await attachSopSchedule(deps, AGENCY, {
      sopId: sop.id,
      workerId: WORKER,
      cadence: "daily",
      runAt: "08:00",
    });

    // The loop advances the responsibility past what the schedule row knows.
    const advanced = first.responsibility.nextRunAt + 5 * 86_400_000;
    operating.updateResponsibility(AGENCY, first.responsibility.id, { nextRunAt: advanced });

    // A reconcile that does not touch the cadence must not undo that.
    await attachSopSchedule(deps, AGENCY, {
      sopId: sop.id,
      workerId: WORKER,
      cadence: "daily",
      runAt: "08:00",
    });
    expect(operating.getResponsibility(AGENCY, first.responsibility.id)!.nextRunAt).toBe(advanced);

    // Changing the cadence does re-anchor it — and to a future time.
    const changed = await attachSopSchedule(deps, AGENCY, {
      sopId: sop.id,
      workerId: WORKER,
      cadence: "weekly",
      weekday: 1,
      runAt: "08:00",
    });
    expect(changed.responsibility.cadence).toBe("weekly");
    expect(changed.responsibility.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("keeps the SOP body in the responsibility when the SOP is edited", async () => {
    const sop = makeSop();
    const input = { sopId: sop.id, workerId: WORKER, cadence: "daily" as const, runAt: "08:00" };
    await attachSopSchedule(deps, AGENCY, input);

    sopStore.updateSop(AGENCY, sop.id, {
      steps: [{ title: "Brand new step", instruction: "A completely rewritten procedure." }],
    });
    const result = await attachSopSchedule(deps, AGENCY, input);
    expect(result.responsibility.instructions).toContain("Brand new step");
    expect(result.changed).toBe(true);
  });

  it("rejects an unknown SOP", async () => {
    await expect(
      attachSopSchedule(deps, AGENCY, { sopId: "nope", workerId: WORKER }),
    ).rejects.toThrow(/SOP not found/);
  });

  it("generates a QUEUED backlog item when the loop ticks the schedule", async () => {
    const sop = makeSop();
    const result = await attachSopSchedule(deps, AGENCY, {
      sopId: sop.id,
      workerId: WORKER,
      cadence: "daily",
      runAt: "08:00",
    });

    const tick = operating.tick(AGENCY, result.responsibility.nextRunAt + 1_000);
    expect(tick.generatedWorkItemIds).toHaveLength(1);

    const item = operating.getWorkItem(AGENCY, tick.generatedWorkItemIds[0])!;
    // Backlog. NEVER `accepted` — that column is the human authorisation gate.
    expect(item.status).toBe("queued");
    expect(item.responsibilityId).toBe(result.responsibility.id);
    expect(item.context).toMatchObject({ sopId: sop.id });
  });
});

describe("detachSopSchedule", () => {
  it("removes the schedule, its responsibility and its cron job", async () => {
    const sop = makeSop();
    const attached = await attachSopSchedule(deps, AGENCY, {
      sopId: sop.id,
      workerId: WORKER,
      cadence: "daily",
      runAt: "08:00",
    });

    const result = await detachSopSchedule(deps, AGENCY, attached.schedule.id);
    expect(result.schedule).not.toBeNull();
    expect(result.responsibilityRemoved).toBe(true);
    expect(result.cronJobRemoved).toBe(true);
    expect(cron.jobs).toHaveLength(0);
    expect(sopStore.getSchedule(AGENCY, attached.schedule.id)).toBeNull();
    expect(operating.listResponsibilities(AGENCY)).toHaveLength(0);
  });

  it("never removes a cron job it does not own", async () => {
    const sop = makeSop();
    const attached = await attachSopSchedule(deps, AGENCY, {
      sopId: sop.id,
      workerId: WORKER,
      cadence: "daily",
      runAt: "08:00",
    });
    cron.jobs[0].category = "operator:mine";

    const result = await detachSopSchedule(deps, AGENCY, attached.schedule.id);
    expect(result.cronJobRemoved).toBe(false);
    expect(cron.jobs).toHaveLength(1);
  });

  it("is a safe no-op for an unknown schedule", async () => {
    const result = await detachSopSchedule(deps, AGENCY, "nope");
    expect(result).toEqual({
      schedule: null,
      responsibilityRemoved: false,
      cronJobRemoved: false,
    });
  });
});

describe("runSopOnce", () => {
  it("produces exactly one QUEUED work item and records the run", () => {
    const sop = makeSop();
    const result = runSopOnce(deps, AGENCY, { sopId: sop.id });

    expect(result.workItem.status).toBe("queued");
    expect(result.workItem.title).toBe(sop.name);
    expect(result.workItem.instructions).toContain("**Procedure**");
    expect(result.workItem.context).toMatchObject({ sopId: sop.id, trigger: "manual" });
    expect(result.workItem.dueAt).toBeGreaterThan(result.workItem.scheduledFor);

    expect(result.run.trigger).toBe("manual");
    expect(result.run.status).toBe("materialised");
    expect(result.run.workItemId).toBe(result.workItem.id);
    expect(result.run.sopVersion).toBe(sop.version);
    expect(sopStore.listRuns(AGENCY, { sopId: sop.id })).toHaveLength(1);
  });

  it("schedules a future run without spawning anything now", () => {
    const sop = makeSop();
    const now = Date.now();
    const runAt = now + 3 * 86_400_000;
    const result = runSopOnce(deps, AGENCY, { sopId: sop.id, runAt });

    expect(result.workItem.scheduledFor).toBe(runAt);
    expect(result.workItem.status).toBe("queued");
  });

  it("never schedules at the epoch when runAt is 0 or negative", () => {
    const sop = makeSop();
    const now = Date.UTC(2026, 6, 26, 12, 0, 0);
    const local: SopServiceDeps = { ...deps, now: () => now };
    expect(runSopOnce(local, AGENCY, { sopId: sop.id, runAt: 0 }).workItem.scheduledFor).toBe(now);
    expect(runSopOnce(local, AGENCY, { sopId: sop.id, runAt: -5 }).workItem.scheduledFor).toBe(now);
  });

  it("is idempotent for the same occurrence", () => {
    const sop = makeSop();
    const runAt = Date.now() + 86_400_000;
    const first = runSopOnce(deps, AGENCY, { sopId: sop.id, runAt });
    const second = runSopOnce(deps, AGENCY, { sopId: sop.id, runAt });
    expect(second.workItem.id).toBe(first.workItem.id);
    expect(operating.listWorkItems(AGENCY)).toHaveLength(1);
  });

  it("defaults to the SOP owner and rejects an ownerless SOP", () => {
    const owned = makeSop();
    expect(runSopOnce(deps, AGENCY, { sopId: owned.id }).workItem.workerId).toBe(WORKER);

    const ownerless = sopStore.createSop(AGENCY, {
      slug: "ownerless",
      name: "Ownerless",
      steps: [{ title: "Step", instruction: "Do it." }],
    });
    expect(() => runSopOnce(deps, AGENCY, { sopId: ownerless.id })).toThrow(/workerId required/);
  });

  it("does not disturb an attached schedule's cadence", async () => {
    const sop = makeSop();
    const attached = await attachSopSchedule(deps, AGENCY, {
      sopId: sop.id,
      workerId: WORKER,
      cadence: "daily",
      runAt: "08:00",
    });
    const before = operating.getResponsibility(AGENCY, attached.responsibility.id)!;

    const manual = runSopOnce(deps, AGENCY, { sopId: sop.id });
    expect(manual.workItem.responsibilityId).toBeNull();
    expect(manual.run.scheduleId).toBe(attached.schedule.id);
    expect(operating.getResponsibility(AGENCY, attached.responsibility.id)!.nextRunAt).toBe(
      before.nextRunAt,
    );
  });
});
