/**
 * First-run provisioning for an agency.
 *
 * A fresh agency used to arrive empty: `agency.ops.sops.seed` existed but
 * nothing ever called it, so a live install could sit at ZERO SOPs and zero
 * schedules while the operator was told the AI agency was "set up". Everything
 * that made the agency actually run had to be discovered and clicked by hand.
 *
 * This module makes provisioning happen by itself, exactly once per step:
 *
 *   workforce   the six production AI roles           (idempotent seeder)
 *   sops        the starter procedures for those roles (idempotent seeder)
 *   schedules   the suggested cadence for each seeded SOP
 *   routing     the task-routing / autostage policy row
 *
 * ── IDEMPOTENCE ─────────────────────────────────────────────────────────────
 * Steps are recorded in `wf_agency_provisioning` with a version. Once a step is
 * recorded, `ensureAgencyProvisioned` returns after a handful of primary-key
 * lookups and writes nothing — so it is safe on the hot path (`agencies.list`,
 * agency bootstrap, every operating-loop tick).
 *
 * ── NEVER CLOBBER THE OPERATOR ──────────────────────────────────────────────
 * Schedules are attached ONLY on the first run of that step, and only for SOPs
 * that have no schedule at all. If the operator later detaches one, the version
 * marker means we never put it back. Their agency, their cadence.
 */

import { addAutonomyJob } from "../cron/autonomy-optin.js";
import type { SopCronPort } from "../cron/sop-jobs.js";
import { attachSopSchedule, type SopServiceDeps } from "../workforce/sop-service.js";
import { SOP_SEED_VERSION, seedAgencySops, suggestedScheduleFor } from "../workforce/sop-seeds.js";
import type { WorkforceRoutingStore } from "../workforce/routing-store.js";
import type { WorkforceSopStore } from "../workforce/sop-store.js";
import type { WorkforceStore } from "../workforce/store.js";
import { AI_ROLE_SEED_VERSION, seedAgencyAiWorkforce } from "./seed-workforce.js";

/** Bump to re-run the schedule-attachment step on existing installs. */
export const AGENCY_SCHEDULE_PROVISION_VERSION = 1;
/** Bump to re-apply the default routing policy on existing installs. */
export const AGENCY_ROUTING_PROVISION_VERSION = 1;

export const PROVISION_KEYS = {
  workforce: "workforce",
  sops: "sops",
  schedules: "sop-schedules",
  routing: "routing-policy",
} as const;

export type AgencyProvisioningDeps = {
  workerStore: WorkforceStore;
  sopStore: WorkforceSopStore;
  routingStore: WorkforceRoutingStore;
  /** Supplies the operating store and (optionally) the cron service. */
  sopService: Omit<SopServiceDeps, "sopStore" | "workerStore">;
  now?: () => number;
};

export type AgencyProvisioningResult = {
  agencyId: string;
  /** False when every step was already at its current version. No writes. */
  changed: boolean;
  workforce: { created: number; adopted: number; existing: number } | null;
  sops: { created: number; adopted: number; existing: number; skipped: number } | null;
  schedules: { attached: number; skipped: number; failed: number };
  routingPolicyCreated: boolean;
  warnings: string[];
};

/** The seed roles that own SOPs, keyed by `agentId`. */
function workerIdsByRoleId(store: WorkforceStore, agencyId: string): Map<string, string> {
  const byRole = new Map<string, string>();
  for (const worker of store.listWorkers(agencyId, { type: "ai" })) {
    if (worker.agentId) byRole.set(worker.agentId, worker.id);
  }
  return byRole;
}

/**
 * In-flight provisioning per agency. The operating loop and the agency RPCs can
 * both provision the same agency at the same moment; without this both passes
 * read "no schedules yet" and attach every SOP twice (duplicate cron jobs).
 */
const inFlight = new Map<string, Promise<AgencyProvisioningResult>>();

/**
 * Bring one agency up to the current provisioning baseline.
 *
 * Safe (and cheap) to call on every request and every tick: when nothing is
 * behind, this performs four indexed lookups and returns `changed: false`.
 * Concurrent calls for the same agency share one pass.
 */
export async function ensureAgencyProvisioned(
  deps: AgencyProvisioningDeps,
  agencyId: string,
  actorId: string,
): Promise<AgencyProvisioningResult> {
  const pending = inFlight.get(agencyId);
  if (pending) return pending;
  const run = provisionAgency(deps, agencyId, actorId).finally(() => {
    inFlight.delete(agencyId);
  });
  inFlight.set(agencyId, run);
  return run;
}

async function provisionAgency(
  deps: AgencyProvisioningDeps,
  agencyId: string,
  actorId: string,
): Promise<AgencyProvisioningResult> {
  const now = deps.now?.() ?? Date.now();
  const result: AgencyProvisioningResult = {
    agencyId,
    changed: false,
    workforce: null,
    sops: null,
    schedules: { attached: 0, skipped: 0, failed: 0 },
    routingPolicyCreated: false,
    warnings: [],
  };

  const routing = deps.routingStore;
  const workforceDone = routing.getProvisionedVersion(agencyId, PROVISION_KEYS.workforce);
  const sopsDone = routing.getProvisionedVersion(agencyId, PROVISION_KEYS.sops);
  const schedulesDone = routing.getProvisionedVersion(agencyId, PROVISION_KEYS.schedules);
  const routingDone = routing.getProvisionedVersion(agencyId, PROVISION_KEYS.routing);

  if (
    workforceDone >= AI_ROLE_SEED_VERSION &&
    sopsDone >= SOP_SEED_VERSION &&
    schedulesDone >= AGENCY_SCHEDULE_PROVISION_VERSION &&
    routingDone >= AGENCY_ROUTING_PROVISION_VERSION
  ) {
    return result;
  }

  // 1. Workforce. The seeder is itself idempotent; the marker just lets us
  //    skip calling it at all once it has converged.
  if (workforceDone < AI_ROLE_SEED_VERSION) {
    const seeded = seedAgencyAiWorkforce(deps.workerStore, agencyId, actorId);
    result.workforce = seeded;
    result.changed = result.changed || seeded.created > 0 || seeded.adopted > 0;
    routing.recordProvisioned(
      agencyId,
      PROVISION_KEYS.workforce,
      AI_ROLE_SEED_VERSION,
      seeded,
      now,
    );
  }

  const roleIds = workerIdsByRoleId(deps.workerStore, agencyId);

  // 2. SOPs. Never rewrites a procedure the operator has taken over.
  if (sopsDone < SOP_SEED_VERSION) {
    const seeded = seedAgencySops(deps.sopStore, agencyId, roleIds);
    result.sops = seeded;
    result.changed = result.changed || seeded.created > 0 || seeded.adopted > 0;
    routing.recordProvisioned(agencyId, PROVISION_KEYS.sops, SOP_SEED_VERSION, seeded, now);
  }

  // 3. Schedules — the step that was missing entirely. Without these the
  //    operating loop has nothing to materialise and the agency never moves.
  if (schedulesDone < AGENCY_SCHEDULE_PROVISION_VERSION) {
    const existingSchedules = new Set(
      deps.sopStore.listSchedules(agencyId).map((schedule) => schedule.sopId),
    );
    // Seeded SOP schedules nudge the main agent on a cadence, so their cron jobs
    // follow the autonomy opt-in: created disabled on a fresh install until the
    // operator opts in. Schedules an operator attaches by hand are not gated.
    const cron = deps.sopService.cron
      ? gateAutonomyCron(deps.sopService.cron)
      : deps.sopService.cron;
    for (const sop of deps.sopStore.listSops(agencyId)) {
      const suggested = suggestedScheduleFor(sop.slug);
      if (!suggested || sop.source !== "seed" || !sop.ownerWorkerId) {
        result.schedules.skipped += 1;
        continue;
      }
      if (existingSchedules.has(sop.id)) {
        result.schedules.skipped += 1;
        continue;
      }
      try {
        await attachSopSchedule(
          { ...deps.sopService, cron, sopStore: deps.sopStore, workerStore: deps.workerStore },
          agencyId,
          {
            sopId: sop.id,
            workerId: sop.ownerWorkerId,
            managerWorkerId:
              deps.workerStore.getWorker(agencyId, sop.ownerWorkerId)?.managerWorkerId ?? null,
            cadence: suggested.cadence,
            interval: suggested.interval,
            weekday: suggested.weekday,
            monthDay: suggested.monthDay,
            runAt: suggested.runAt,
            slaMinutes: suggested.slaMinutes,
            priority: sop.defaultPriority,
            enabled: true,
          },
        );
        result.schedules.attached += 1;
        result.changed = true;
      } catch (error) {
        result.schedules.failed += 1;
        result.warnings.push(
          `${sop.slug}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // Recorded even when some attachments failed: retrying forever on every
    // request would hammer the cron service. The warnings surface the failure.
    routing.recordProvisioned(
      agencyId,
      PROVISION_KEYS.schedules,
      AGENCY_SCHEDULE_PROVISION_VERSION,
      result.schedules,
      now,
    );
  }

  // 4. Routing policy. Materialising the row makes the defaults visible and
  //    editable in the UI instead of implicit in the code.
  if (routingDone < AGENCY_ROUTING_PROVISION_VERSION) {
    const before = routing.getPolicy(agencyId);
    if (before.updatedAt === 0) {
      routing.setPolicy(agencyId, {}, now);
      result.routingPolicyCreated = true;
      result.changed = true;
    }
    routing.recordProvisioned(
      agencyId,
      PROVISION_KEYS.routing,
      AGENCY_ROUTING_PROVISION_VERSION,
      { created: result.routingPolicyCreated },
      now,
    );
  }

  if (result.changed) {
    deps.workerStore.recordAudit(
      agencyId,
      actorId,
      "agency.provisioned",
      "agency",
      agencyId,
      null,
      {
        workforce: result.workforce,
        sops: result.sops,
        schedules: result.schedules,
        routingPolicyCreated: result.routingPolicyCreated,
      },
    );
  }
  return result;
}

/** Provisioning state for the UI / diagnostics. Read-only. */
export function agencyProvisioningStatus(
  routingStore: WorkforceRoutingStore,
  agencyId: string,
): {
  complete: boolean;
  steps: Array<{ key: string; version: number; current: number; appliedAt: number | null }>;
} {
  const applied = new Map(
    routingStore.listProvisioning(agencyId).map((entry) => [entry.key, entry]),
  );
  const expected: Array<[string, number]> = [
    [PROVISION_KEYS.workforce, AI_ROLE_SEED_VERSION],
    [PROVISION_KEYS.sops, SOP_SEED_VERSION],
    [PROVISION_KEYS.schedules, AGENCY_SCHEDULE_PROVISION_VERSION],
    [PROVISION_KEYS.routing, AGENCY_ROUTING_PROVISION_VERSION],
  ];
  const steps = expected.map(([key, current]) => ({
    key,
    version: applied.get(key)?.version ?? 0,
    current,
    appliedAt: applied.get(key)?.appliedAt ?? null,
  }));
  return { complete: steps.every((step) => step.version >= step.current), steps };
}

/** Route cron job creation through the autonomy opt-in gate. */
function gateAutonomyCron(cron: SopCronPort): SopCronPort {
  return {
    list: (opts) => cron.list(opts),
    remove: (id) => cron.remove(id),
    add: (input) => addAutonomyJob(cron as Parameters<typeof addAutonomyJob>[0], input),
  };
}
