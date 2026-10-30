import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureCeoReportCronJobs } from "../reports/ceo-cron.js";
import { ensureProactiveReportCronJobs } from "../reports/proactive-cron.js";
import { ensureAgencyOperatingLoopCronJobs } from "./agency-operating-jobs.js";
import {
  AUTONOMY_JOB_NAMES,
  addAutonomyJob,
  applyAutonomyOptIn,
  autonomyOptInPath,
  isAutonomyJobName,
  resolveAutonomySeedEnabled,
} from "./autonomy-optin.js";
import { ensureDefaultProactiveCronJobs } from "./default-jobs.js";
import { ensureOversightCronJobs } from "./oversight-jobs.js";
import { ensureProjectSummaryCronJobs } from "./project-summary-jobs.js";
import { CronService } from "./service.js";
import { ensureSopCronJob, sopCronJobSpec } from "./sop-jobs.js";
import type { CronJobCreate } from "./types.js";

// oversight-client-snapshot belongs to the business-agency plugin and is only
// seeded while it is loaded; seed as an install with the plugin on so every
// autonomy job goes through the gate.
vi.mock("../business-agency/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../business-agency/runtime.js")>()),
  isBusinessAgencyActive: () => true,
}));

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const cleanups: Array<() => Promise<void>> = [];

async function makeCron(seed?: unknown) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-autonomy-optin-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, "cron", "jobs.json");
  if (seed) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(seed));
  }
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await cron.start();
  return cron;
}

/** Everything the gateway seeds on boot, in boot order (server.impl.ts). */
async function bootSeed(cron: CronService) {
  await ensureDefaultProactiveCronJobs(cron);
  await ensureCeoReportCronJobs(cron);
  await ensureProactiveReportCronJobs(cron);
  await ensureOversightCronJobs(cron);
  await ensureAgencyOperatingLoopCronJobs(cron);
  await ensureProjectSummaryCronJobs(cron);
}

beforeEach(() => {
  // Never let the developer's real config decide these tests.
  vi.stubEnv("INFINIBOT_CONFIG_PATH", path.join(os.tmpdir(), "infinibot-missing-config.json"));
  vi.stubEnv("INFINIBOT_AUTONOMY", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("autonomy opt-in: fresh install", () => {
  it("seeds every autonomy job disabled — zero enabled autonomous jobs", async () => {
    const cron = await makeCron();
    await bootSeed(cron);
    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.length).toBe(AUTONOMY_JOB_NAMES.size);
    expect(jobs.filter((job) => job.enabled)).toEqual([]);
    // Second boot is a no-op and still leaves everything off.
    await bootSeed(cron);
    const again = await cron.list({ includeDisabled: true });
    expect(again.length).toBe(jobs.length);
    expect(again.filter((job) => job.enabled)).toEqual([]);
    cron.stop();
  });

  it("covers every seeded job name in AUTONOMY_JOB_NAMES", async () => {
    const cron = await makeCron();
    await bootSeed(cron);
    for (const job of await cron.list({ includeDisabled: true })) {
      expect(isAutonomyJobName(job.name), job.name).toBe(true);
    }
    cron.stop();
  });

  it("seeds enabled when INFINIBOT_AUTONOMY=1", async () => {
    vi.stubEnv("INFINIBOT_AUTONOMY", "1");
    const cron = await makeCron();
    await bootSeed(cron);
    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.every((job) => job.enabled)).toBe(true);
    cron.stop();
  });

  it("seeds enabled when cron.autonomy is true in config", async () => {
    const cron = await makeCron();
    const enabled = await resolveAutonomySeedEnabled(cron, {
      env: {},
      readConfig: () => ({ cron: { autonomy: true } }),
    });
    expect(enabled).toBe(true);
    cron.stop();
  });

  it("opting in later enables only the jobs the gate disabled", async () => {
    const cron = await makeCron();
    await bootSeed(cron);
    // Operator explicitly creates their own disabled job — must stay disabled.
    const own = await cron.add({
      name: "my-disabled-job",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hi" },
    });

    vi.stubEnv("INFINIBOT_AUTONOMY", "1");
    const enabled = await applyAutonomyOptIn(cron);
    expect(new Set(enabled)).toEqual(new Set(AUTONOMY_JOB_NAMES));
    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((job) => job.id === own.id)?.enabled).toBe(false);
    expect(jobs.filter((job) => job.enabled).length).toBe(AUTONOMY_JOB_NAMES.size);

    // One-shot: afterwards the operator can turn jobs off and they stay off.
    const pulse = jobs.find((job) => job.name === "oversight-pulse")!;
    await cron.update(pulse.id, { enabled: false });
    expect(await applyAutonomyOptIn(cron)).toEqual([]);
    const sidecar = JSON.parse(await fs.readFile(autonomyOptInPath(cron.storePath), "utf-8"));
    expect(sidecar.seededDisabled).toEqual([]);
    cron.stop();
  });

  it("the gate never turns a job ON that the spec ships disabled", async () => {
    const cron = await makeCron();
    const spec: CronJobCreate = {
      name: "heartbeat-proactive",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "x" },
    };
    const job = await addAutonomyJob(cron, spec, { enabled: true });
    expect(job.enabled).toBe(false);
    cron.stop();
  });
});

describe("autonomy opt-in: existing install", () => {
  function legacyJob(name: string, enabled: boolean, i: number) {
    return {
      id: `legacy-${i}`,
      name,
      enabled,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 900_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: `legacy ${name}` },
      state: {},
    };
  }

  it("leaves existing jobs exactly as they are and keeps seeding new ones enabled", async () => {
    // Snapshot of an install that predates the opt-in: some jobs on, one the
    // operator turned off, and a job that shipped after this snapshot missing.
    const names = [...AUTONOMY_JOB_NAMES].filter((name) => name !== "project-summary-daily");
    const seed = {
      version: 1,
      jobs: names.map((name, i) => legacyJob(name, name !== "oversight-pulse", i)),
    };
    const cron = await makeCron(seed);
    const before = await cron.list({ includeDisabled: true });

    await bootSeed(cron);
    const after = await cron.list({ includeDisabled: true });

    for (const job of before) {
      const same = after.find((j) => j.id === job.id)!;
      expect(same.enabled, job.name).toBe(job.enabled);
      expect(same.schedule).toEqual(job.schedule);
      expect(same.payload).toEqual(job.payload);
    }
    expect(after.find((j) => j.name === "oversight-pulse")?.enabled).toBe(false);
    // The missing job is added — enabled, as it would have been before.
    const added = after.filter((j) => !before.some((b) => b.id === j.id));
    expect(added.map((j) => j.name)).toEqual(["project-summary-daily"]);
    expect(added[0]?.enabled).toBe(true);
    cron.stop();
  });

  it("INFINIBOT_AUTONOMY=0 keeps new jobs off but never disables existing ones", async () => {
    vi.stubEnv("INFINIBOT_AUTONOMY", "0");
    const cron = await makeCron({
      version: 1,
      jobs: [legacyJob("heartbeat-proactive", true, 0)],
    });
    await bootSeed(cron);
    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((j) => j.name === "heartbeat-proactive")?.enabled).toBe(true);
    expect(jobs.filter((j) => j.enabled).map((j) => j.name)).toEqual(["heartbeat-proactive"]);
    cron.stop();
  });
});

describe("SOP cron dedupe", () => {
  it("concurrent ensureSopCronJob calls create exactly one job", async () => {
    const cron = await makeCron();
    const spec = sopCronJobSpec({
      name: "agency-sop:ceo-weekly-operating-review:legacy-unassigned-ai-ceo",
      sopName: "CEO weekly operating review",
      sopSlug: "ceo-weekly-operating-review",
      workerName: "AI CEO",
      schedule: { kind: "cron", expr: "0 8 * * 1", tz: "UTC" },
      enabled: true,
    });
    const results = await Promise.all([
      ensureSopCronJob(cron, spec),
      ensureSopCronJob(cron, spec),
      ensureSopCronJob(cron, spec),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const jobs = (await cron.list({ includeDisabled: true })).filter((j) => j.name === spec.name);
    expect(jobs).toHaveLength(1);
    cron.stop();
  });
});
