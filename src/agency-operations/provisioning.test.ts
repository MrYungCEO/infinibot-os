import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { SOP_CRON_CATEGORY } from "../cron/sop-jobs.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";
import { WorkforceOperatingStore } from "../workforce/operating-store.js";
import { WorkforceRoutingStore } from "../workforce/routing-store.js";
import { WorkforceSopStore } from "../workforce/sop-store.js";
import { WorkforceStore } from "../workforce/store.js";
import {
  agencyProvisioningStatus,
  ensureAgencyProvisioned,
  type AgencyProvisioningDeps,
} from "./provisioning.js";
import { AgencyOperationsStore } from "./store.js";

const ACTOR = "owner-1";

/** In-memory cron double. Never boots the real store or arms a timer. */
class FakeCron {
  jobs: CronJob[] = [];
  async list(): Promise<CronJob[]> {
    return [...this.jobs];
  }
  async add(input: CronJobCreate): Promise<CronJob> {
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

let dir: string;
let dbPath: string;
let operations: AgencyOperationsStore;
let workers: WorkforceStore;
let operating: WorkforceOperatingStore;
let sops: WorkforceSopStore;
let routing: WorkforceRoutingStore;
let cron: FakeCron;
let deps: AgencyProvisioningDeps;
let agencyId: string;

function rowCount(table: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agency-provisioning-"));
  dbPath = join(dir, "agency.db");
  operations = new AgencyOperationsStore(dbPath);
  workers = new WorkforceStore(dbPath);
  operating = new WorkforceOperatingStore(dbPath);
  sops = new WorkforceSopStore(dbPath);
  routing = new WorkforceRoutingStore(dbPath);
  cron = new FakeCron();
  agencyId = operations.createAgency({ name: "Acme", slug: "acme", ownerUserId: ACTOR }).id;
  deps = {
    workerStore: workers,
    sopStore: sops,
    routingStore: routing,
    sopService: { operatingStore: operating, cron },
  };
});

afterEach(() => {
  routing.close();
  sops.close();
  operating.close();
  workers.close();
  operations.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureAgencyProvisioned", () => {
  it("gives a fresh agency employees, SOPs, schedules and a routing policy", async () => {
    const result = await ensureAgencyProvisioned(deps, agencyId, ACTOR);

    expect(result.changed).toBe(true);
    expect(result.workforce!.created).toBeGreaterThan(0);
    expect(result.sops!.created).toBeGreaterThan(0);
    // The step that never existed before: an agency that arrives WORKING.
    expect(result.schedules.attached).toBeGreaterThan(0);
    expect(result.routingPolicyCreated).toBe(true);

    expect(sops.listSops(agencyId).length).toBeGreaterThan(0);
    expect(sops.listSchedules(agencyId).length).toBe(result.schedules.attached);
    // Real, operator-visible cron jobs, not orphan rows.
    expect(cron.jobs.every((job) => job.category === SOP_CRON_CATEGORY)).toBe(true);
    expect(cron.jobs.length).toBe(result.schedules.attached);
    // Each schedule drives a recurring responsibility the operating loop ticks.
    expect(operating.listResponsibilities(agencyId).length).toBe(result.schedules.attached);
  });

  it("every generated responsibility is scheduled in the future, never at the epoch", async () => {
    await ensureAgencyProvisioned(deps, agencyId, ACTOR);
    for (const responsibility of operating.listResponsibilities(agencyId)) {
      expect(responsibility.nextRunAt).toBeGreaterThan(Date.now() - 86_400_000);
    }
  });

  it("is a genuine no-op on every subsequent boot", async () => {
    await ensureAgencyProvisioned(deps, agencyId, ACTOR);
    const before = {
      workers: rowCount("wf_workers"),
      sops: rowCount("wf_sops"),
      schedules: rowCount("wf_sop_schedules"),
      responsibilities: rowCount("wf_recurring_responsibilities"),
      policy: rowCount("wf_routing_policy"),
      audit: rowCount("wf_audit_entries"),
      cronJobs: cron.jobs.length,
    };

    const second = await ensureAgencyProvisioned(deps, agencyId, ACTOR);
    expect(second.changed).toBe(false);
    expect(second.schedules.attached).toBe(0);
    const third = await ensureAgencyProvisioned(deps, agencyId, ACTOR);
    expect(third.changed).toBe(false);

    expect({
      workers: rowCount("wf_workers"),
      sops: rowCount("wf_sops"),
      schedules: rowCount("wf_sop_schedules"),
      responsibilities: rowCount("wf_recurring_responsibilities"),
      policy: rowCount("wf_routing_policy"),
      audit: rowCount("wf_audit_entries"),
      cronJobs: cron.jobs.length,
    }).toEqual(before);
  });

  it("never re-attaches a schedule the operator detached", async () => {
    await ensureAgencyProvisioned(deps, agencyId, ACTOR);
    const schedule = sops.listSchedules(agencyId)[0]!;
    sops.deleteSchedule(agencyId, schedule.id);
    const remaining = sops.listSchedules(agencyId).length;

    await ensureAgencyProvisioned(deps, agencyId, ACTOR);
    expect(sops.listSchedules(agencyId).length).toBe(remaining);
  });

  it("never rewrites an SOP the operator has taken over", async () => {
    await ensureAgencyProvisioned(deps, agencyId, ACTOR);
    const sop = sops.listSops(agencyId)[0]!;
    const renamed = sops.updateSop(agencyId, sop.id, { name: "My own procedure" })!;

    await ensureAgencyProvisioned(deps, agencyId, ACTOR);
    expect(sops.getSop(agencyId, sop.id)!.name).toBe(renamed.name);
  });

  it("reports its own completeness without writing", async () => {
    expect(agencyProvisioningStatus(routing, agencyId).complete).toBe(false);
    await ensureAgencyProvisioned(deps, agencyId, ACTOR);
    const status = agencyProvisioningStatus(routing, agencyId);
    expect(status.complete).toBe(true);
    expect(status.steps.map((step) => step.key).sort()).toEqual([
      "routing-policy",
      "sop-schedules",
      "sops",
      "workforce",
    ]);
  });

  it("works with no cron service at all: rows are still written", async () => {
    const withoutCron: AgencyProvisioningDeps = {
      ...deps,
      sopService: { operatingStore: operating, cron: null },
    };
    const result = await ensureAgencyProvisioned(withoutCron, agencyId, ACTOR);
    expect(result.schedules.attached).toBeGreaterThan(0);
    expect(cron.jobs).toHaveLength(0);
    expect(operating.listResponsibilities(agencyId).length).toBe(result.schedules.attached);
  });
});

describe("ensureAgencyProvisioned — first-run safety", () => {
  it("seeds SOP cron jobs disabled without an autonomy opt-in", async () => {
    const prev = process.env.INFINIBOT_AUTONOMY;
    process.env.INFINIBOT_AUTONOMY = "0";
    try {
      const result = await ensureAgencyProvisioned(deps, agencyId, ACTOR);
      expect(result.schedules.attached).toBeGreaterThan(0);
      expect(cron.jobs.length).toBe(result.schedules.attached);
      expect(cron.jobs.every((job) => job.enabled === false)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.INFINIBOT_AUTONOMY;
      else process.env.INFINIBOT_AUTONOMY = prev;
    }
  });

  it("concurrent provisioning of one agency never duplicates SOP cron jobs", async () => {
    const [a, b, c] = await Promise.all([
      ensureAgencyProvisioned(deps, agencyId, ACTOR),
      ensureAgencyProvisioned(deps, agencyId, ACTOR),
      ensureAgencyProvisioned(deps, agencyId, ACTOR),
    ]);
    expect(a.schedules.attached).toBeGreaterThan(0);
    expect(b).toBe(a);
    expect(c).toBe(a);
    const names = cron.jobs.map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
    expect(sops.listSchedules(agencyId).length).toBe(a.schedules.attached);
  });
});
