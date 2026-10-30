import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENCY_OPERATING_LOOP_DEFAULT_MS,
  AGENCY_OPERATING_LOOP_JOB_NAME,
  AGENCY_OPERATING_LOOP_MAX_MS,
  AGENCY_OPERATING_LOOP_MIN_MS,
  ensureAgencyOperatingLoopCronJobs,
  findAgencyOperatingLoopJob,
  normalizeOperatingLoopIntervalMs,
  operatingLoopIntervalFromJob,
} from "./agency-operating-jobs.js";
import { CronService } from "./service.js";

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const cleanups: Array<() => Promise<void>> = [];

async function makeCron() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-agency-cron-"));
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
  return cron;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("ensureAgencyOperatingLoopCronJobs", () => {
  it("installs the operating loop job once and is idempotent across boots", async () => {
    const cron = await makeCron();

    expect(await ensureAgencyOperatingLoopCronJobs(cron)).toEqual([AGENCY_OPERATING_LOOP_JOB_NAME]);
    expect(await ensureAgencyOperatingLoopCronJobs(cron)).toEqual([]);
    expect(await ensureAgencyOperatingLoopCronJobs(cron)).toEqual([]);

    const jobs = (await cron.list({ includeDisabled: true })).filter(
      (job) => job.name === AGENCY_OPERATING_LOOP_JOB_NAME,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule).toEqual({
      kind: "every",
      everyMs: AGENCY_OPERATING_LOOP_DEFAULT_MS,
    });
    expect(jobs[0].sessionTarget).toBe("main");
    expect(jobs[0].payload.kind).toBe("systemEvent");
    // Fresh install with no autonomy opt-in: seeded disabled.
    expect(jobs[0].enabled).toBe(false);

    cron.stop();
  });

  it("seeds the job enabled when autonomy is opted in", async () => {
    vi.stubEnv("INFINIBOT_AUTONOMY", "1");
    try {
      const cron = await makeCron();
      await ensureAgencyOperatingLoopCronJobs(cron);
      expect((await findAgencyOperatingLoopJob(cron))?.enabled).toBe(true);
      cron.stop();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never clobbers operator edits to the seeded job", async () => {
    const cron = await makeCron();
    await ensureAgencyOperatingLoopCronJobs(cron);
    const job = (await findAgencyOperatingLoopJob(cron))!;

    await cron.update(job.id, { enabled: false, schedule: { kind: "every", everyMs: 3_600_000 } });
    expect(await ensureAgencyOperatingLoopCronJobs(cron)).toEqual([]);

    const after = (await findAgencyOperatingLoopJob(cron))!;
    expect(after.enabled).toBe(false);
    expect(after.schedule).toEqual({ kind: "every", everyMs: 3_600_000 });
    // The operator-edited schedule is what actually drives the loop.
    expect(operatingLoopIntervalFromJob(after)).toBe(3_600_000);

    cron.stop();
  });

  it("seeds a configured cadence, clamped to sane bounds", async () => {
    const cron = await makeCron();
    await ensureAgencyOperatingLoopCronJobs(cron, { everyMs: 5 * 60_000 });
    expect((await findAgencyOperatingLoopJob(cron))!.schedule).toEqual({
      kind: "every",
      everyMs: 5 * 60_000,
    });
    cron.stop();

    expect(normalizeOperatingLoopIntervalMs(10)).toBe(AGENCY_OPERATING_LOOP_MIN_MS);
    expect(normalizeOperatingLoopIntervalMs(999 * 60 * 60_000)).toBe(AGENCY_OPERATING_LOOP_MAX_MS);
    expect(normalizeOperatingLoopIntervalMs(undefined)).toBe(AGENCY_OPERATING_LOOP_DEFAULT_MS);
    expect(operatingLoopIntervalFromJob(undefined)).toBe(AGENCY_OPERATING_LOOP_DEFAULT_MS);
  });
});
