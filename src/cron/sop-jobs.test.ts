import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CronService } from "./service.js";
import {
  SOP_CRON_CATEGORY,
  ensureSopCronJob,
  findSopCronJob,
  removeSopCronJob,
  sopCronJobName,
  sopCronJobSpec,
  sopCronSchedule,
} from "./sop-jobs.js";

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const cleanups: Array<() => Promise<void>> = [];

async function makeCron() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-sop-cron-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const cron = new CronService({
    storePath: path.join(dir, "cron", "jobs.json"),
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await cron.start();
  cleanups.push(async () => cron.stop());
  return cron;
}

function spec(overrides: Partial<Parameters<typeof sopCronJobSpec>[0]> = {}) {
  return sopCronJobSpec({
    name: sopCronJobName("pm-daily-standup", "agency-1:ai:pm"),
    sopName: "Daily standup and blocker sweep",
    sopSlug: "pm-daily-standup",
    workerName: "Pace",
    enabled: true,
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    ...overrides,
  });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("sopCronJobName", () => {
  it("is deterministic and safely sanitised", () => {
    expect(sopCronJobName("pm-daily-standup", "agency-1:ai:pm")).toBe(
      "agency-sop:pm-daily-standup:agency-1-ai-pm",
    );
    expect(sopCronJobName("PM Daily Standup", "agency-1:ai:pm")).toBe(
      sopCronJobName("pm-daily-standup", "agency-1:ai:pm"),
    );
  });

  it("distinguishes the same SOP attached to different workers", () => {
    expect(sopCronJobName("sop", "agency-1:ai:pm")).not.toBe(
      sopCronJobName("sop", "agency-1:ai:ceo"),
    );
  });
});

describe("ensureSopCronJob", () => {
  it("installs the job once and is idempotent across boots", async () => {
    const cron = await makeCron();

    const first = await ensureSopCronJob(cron, spec());
    expect(first.created).toBe(true);
    expect(first.job.category).toBe(SOP_CRON_CATEGORY);

    const second = await ensureSopCronJob(cron, spec());
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    const jobs = (await cron.list({ includeDisabled: true })).filter(
      (job) => job.category === SOP_CRON_CATEGORY,
    );
    expect(jobs).toHaveLength(1);
  });

  it("never clobbers operator edits to enabled or schedule", async () => {
    const cron = await makeCron();
    const created = (await ensureSopCronJob(cron, spec())).job;

    await cron.update(created.id, {
      enabled: false,
      schedule: { kind: "cron", expr: "0 22 * * *", tz: "UTC" },
    });

    // A later boot re-registers with the SHIPPED spec…
    await ensureSopCronJob(cron, spec());

    const job = await findSopCronJob(cron, created.name);
    expect(job!.enabled).toBe(false);
    expect(job!.schedule).toEqual({ kind: "cron", expr: "0 22 * * *", tz: "UTC" });
  });

  it("schedules a real, computable next run", async () => {
    const cron = await makeCron();
    const { job } = await ensureSopCronJob(cron, spec());
    expect(job.state.nextRunAtMs).toBeGreaterThan(Date.now());
  });

  it("nudges the session without ever staging work itself", async () => {
    const cron = await makeCron();
    const { job } = await ensureSopCronJob(cron, spec());
    expect(job.payload.kind).toBe("systemEvent");
    if (job.payload.kind !== "systemEvent") throw new Error("expected a systemEvent payload");
    expect(job.payload.text).toContain("Backlog");
    expect(job.payload.text).toContain("human authorisation gate");
  });
});

describe("removeSopCronJob", () => {
  it("removes a job this module owns", async () => {
    const cron = await makeCron();
    const { job } = await ensureSopCronJob(cron, spec());
    expect(await removeSopCronJob(cron, job.name)).toBe(true);
    expect(await findSopCronJob(cron, job.name)).toBeUndefined();
  });

  it("refuses to remove a job in another category", async () => {
    const cron = await makeCron();
    const { job } = await ensureSopCronJob(cron, spec());
    await cron.update(job.id, { category: "operator:mine" });

    expect(await removeSopCronJob(cron, job.name)).toBe(false);
    expect(await findSopCronJob(cron, job.name)).toBeDefined();
  });

  it("is a safe no-op for an unknown name", async () => {
    const cron = await makeCron();
    expect(await removeSopCronJob(cron, "agency-sop:nope:nobody")).toBe(false);
  });
});

describe("sopCronSchedule — no epoch scheduling", () => {
  it("anchors an interval schedule in the future when nextRunAt is missing", () => {
    const now = Date.UTC(2026, 6, 26, 12, 0, 0);
    for (const cadence of ["daily", "weekly", "monthly"] as const) {
      const schedule = sopCronSchedule(
        { cadence, interval: 3, weekday: 1, monthDay: 5, runAt: "09:00" },
        now,
      );
      expect(schedule.kind).toBe("every");
      if (schedule.kind !== "every") throw new Error("expected an interval schedule");
      expect(schedule.anchorMs, cadence).toBeGreaterThan(now);
    }
  });

  it("defaults a malformed runAt rather than producing an invalid expression", () => {
    const schedule = sopCronSchedule({
      cadence: "daily",
      interval: 1,
      weekday: null,
      monthDay: null,
      runAt: "nonsense",
    });
    expect(schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "UTC" });
  });
});
