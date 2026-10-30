/**
 * Scheduled jobs on a hosted fleet tenant Machine (FLEET_HOSTED_CRON).
 *
 *  - Only the tenant's own schedules run. The platform's proactive seeds
 *    (heartbeat every 15 min, autonomy poll every 5 min, oversight reports,
 *    CEO/project/agency loops) are never seeded on a tenant Machine, and copies
 *    an older image seeded into the store (seeding ran even with cron off) are
 *    removed on boot. Jobs run in the tenant's namespace, so any LLM call uses
 *    the tenant's own BYOK keys.
 *  - Wake mode (Starter): the Machine reports its next due job to the
 *    orchestrator (POST /fleet/schedule), which starts it in time; after a resume
 *    from suspend the cron timer is re-armed from the wall clock, and a job whose
 *    slot passed while the Machine booted still runs (catch-up window).
 *  - Always-on: the cron timer simply runs 24/7.
 */
import { DEFAULT_PROACTIVE_JOBS } from "./default-jobs.js";
import { AGENCY_OPERATING_LOOP_JOB_NAME } from "./agency-operating-jobs.js";
import { OVERSIGHT_CRON_JOBS } from "./oversight-jobs.js";
import { PROJECT_SUMMARY_JOB_NAME } from "./project-summary-jobs.js";
import type { CronService } from "./service.js";
import type { CronEvent } from "./service/state.js";
import { CEO_HOURLY_CRON_NAME } from "../reports/ceo-cron.js";
import { PROACTIVE_CRON_JOBS } from "../reports/proactive-cron.js";
import { fleetWorkBegin, fleetWorkEnd } from "../saas/fleet-idle.js";
import { fleetKeepAwake } from "../saas/fleet-keepawake.js";
import { resolveHostedFeatures } from "../saas/hosted-features.js";

/** Names of the jobs the platform seeds on a local install (never a tenant's). */
export function platformSeededJobNames(): Set<string> {
  return new Set<string>([
    ...DEFAULT_PROACTIVE_JOBS.map((j) => j.name),
    ...PROACTIVE_CRON_JOBS.map((j) => j.name),
    ...OVERSIGHT_CRON_JOBS.map((j) => j.name),
    CEO_HOURLY_CRON_NAME,
    AGENCY_OPERATING_LOOP_JOB_NAME,
    PROJECT_SUMMARY_JOB_NAME,
  ]);
}

/** Remove platform-seeded jobs from a tenant Machine's store. Returns their names. */
export async function removePlatformSeededJobs(cron: CronService): Promise<string[]> {
  const names = platformSeededJobNames();
  const removed: string[] = [];
  for (const job of await cron.list({ includeDisabled: true })) {
    if (!names.has(job.name)) continue;
    const r = await cron.remove(job.id);
    if (r.ok && r.removed) removed.push(job.name);
  }
  return removed;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ScheduleReporterDeps {
  /** Earliest due scheduled work on this Machine (cron jobs, scheduled agent tasks), or null. */
  nextWakeAtMs: () => Promise<number | null>;
  orchestratorUrl: string;
  token: string;
  tenantId: string;
  fetch?: FetchLike;
  debounceMs?: number;
  retryMs?: number;
  log?: (msg: string) => void;
}

/**
 * Report the next due job to the orchestrator whenever it changes. Debounced;
 * a failed report is retried, and a report is only re-sent when the time moved.
 */
export class ScheduleReporter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent: number | null | undefined = undefined;
  private stopped = false;
  readonly sent: Array<number | null> = [];

  constructor(private readonly deps: ScheduleReporterDeps) {}

  /** Something changed (job added/updated/removed/finished, boot): report soon. */
  poke(delayMs = this.deps.debounceMs ?? 2_000): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.stopped) return;
    const next = await this.deps.nextWakeAtMs();
    if (next === this.lastSent) return;
    try {
      const res = await (this.deps.fetch ?? ((u, i) => fetch(u, i)))(
        `${this.deps.orchestratorUrl}/fleet/schedule`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.deps.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ tenantId: this.deps.tenantId, nextWakeAtMs: next }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastSent = next;
      this.sent.push(next);
      this.deps.log?.(
        `next scheduled wake reported: ${next === null ? "none" : new Date(next).toISOString()}`,
      );
    } catch (err) {
      this.deps.log?.(`schedule report failed (${String(err)}); retrying`);
      this.poke(this.deps.retryMs ?? 60_000);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Call `onResume` when the process wakes from a VM suspend: wall time jumped far
 * past monotonic time between two ticks (monotonic stood still while frozen).
 */
export function watchForResume(
  onResume: (gapMs: number) => void,
  opts: {
    tickMs?: number;
    thresholdMs?: number;
    wall?: () => number;
    mono?: () => number;
  } = {},
): () => void {
  const wall = opts.wall ?? Date.now;
  const mono = opts.mono ?? (() => performance.now());
  const threshold = opts.thresholdMs ?? 30_000;
  let lastWall = wall();
  let lastMono = mono();
  const t = setInterval(() => {
    const w = wall();
    const m = mono();
    const gap = w - lastWall - (m - lastMono);
    lastWall = w;
    lastMono = m;
    if (gap > threshold) onResume(gap);
  }, opts.tickMs ?? 15_000);
  t.unref?.();
  return () => clearInterval(t);
}

/**
 * Business Hub Lead Autopilot: its next campaign run / approved send on this
 * tenant's own hub database. Only while the Business & Agency plugin is loaded
 * (a disabled plugin runs no scheduler, so it must not wake the Machine) and
 * only when the tenant already has a hub database (never creates one).
 */
export async function autopilotNextWakeMs(): Promise<number | null> {
  const { isBusinessAgencyActive } = await import("../business-agency/runtime.js");
  if (!isBusinessAgencyActive()) return null;
  const { existsSync } = await import("node:fs");
  const { getHubDb, hubDbPath } = await import("../business-hub/db.js");
  if (!existsSync(hubDbPath())) return null;
  const { autopilotNextWakeMs: next } = await import("../business-hub/autopilot.js");
  return next(getHubDb());
}

/** Earliest enabled cron job, scheduled agent task or autopilot run still to come, or null. */
export async function nextScheduledWakeMs(
  cron: Pick<CronService, "status">,
  tasks: () => Promise<Array<{ enabled: boolean; nextRunAt: number | null }>> = async () => {
    const { getScheduledTaskService } = await import("../autonomy/scheduled-tasks/runtime.js");
    return getScheduledTaskService().store.listTasks();
  },
  extra: Array<() => Promise<number | null>> = [autopilotNextWakeMs],
): Promise<number | null> {
  const times: number[] = [];
  const { nextWakeAtMs } = await cron.status();
  if (typeof nextWakeAtMs === "number") times.push(nextWakeAtMs);
  try {
    for (const t of await tasks()) {
      if (t.enabled && typeof t.nextRunAt === "number") times.push(t.nextRunAt);
    }
  } catch {
    // scheduled tasks unavailable (store not open): cron alone
  }
  for (const source of extra) {
    try {
      const t = await source();
      if (typeof t === "number") times.push(t);
    } catch {
      // optional source unavailable: the others still count
    }
  }
  return times.length ? Math.min(...times) : null;
}

let reporter: ScheduleReporter | null = null;
const jobHolds = new Map<string, () => void>();

/** Cron events on a fleet Machine: keep a wake-mode Machine awake per run, re-report. */
export function fleetCronEvent(evt: CronEvent): void {
  if (evt.action === "started") {
    fleetWorkBegin(`cron:${evt.jobId}`, "cron");
    const ka = fleetKeepAwake();
    if (ka && !jobHolds.has(evt.jobId)) jobHolds.set(evt.jobId, ka.acquire());
    return;
  }
  if (evt.action === "finished") {
    fleetWorkEnd(`cron:${evt.jobId}`, "cron");
    jobHolds.get(evt.jobId)?.();
    jobHolds.delete(evt.jobId);
  }
  reporter?.poke();
}

/**
 * Boot wiring for a fleet tenant Machine with hosted cron. Returns a stop
 * function, or null when this isn't a hosted-cron Machine.
 */
export async function startFleetCron(
  cron: CronService,
  log: { info: (m: string) => void; warn: (m: string) => void },
  env: NodeJS.ProcessEnv = process.env,
): Promise<(() => void) | null> {
  const hosted = resolveHostedFeatures(env);
  if (!hosted.fleet) return null;
  try {
    const removed = await removePlatformSeededJobs(cron);
    if (removed.length > 0)
      log.info(`fleet: removed platform-seeded cron jobs: ${removed.join(", ")}`);
  } catch (err) {
    log.warn(`fleet: platform cron cleanup failed: ${String(err)}`);
  }
  if (!hosted.cron) return null;
  const stops: Array<() => void> = [];
  if (hosted.runMode === "wake") {
    stops.push(
      watchForResume((gapMs) => {
        log.info(`fleet: resumed after ~${Math.round(gapMs / 1000)}s suspended; re-arming cron`);
        void cron.resync().catch((err) => log.warn(`fleet: cron resync failed: ${String(err)}`));
        reporter?.poke();
      }),
    );
    if (hosted.schedule) {
      reporter = new ScheduleReporter({
        nextWakeAtMs: () => nextScheduledWakeMs(cron),
        orchestratorUrl: hosted.schedule.orchestratorUrl,
        token: hosted.schedule.token,
        tenantId: env.FLEET_TENANT_ID?.trim() ?? "",
        log: (m) => log.info(`fleet: ${m}`),
      });
      reporter.poke(0);
      const r = reporter;
      // Scheduled agent tasks run on their own tick (src/autonomy/scheduled-tasks)
      // and emit no cron events: re-check while awake so their next slot is reported.
      const recheck = setInterval(() => r.poke(0), 60_000);
      recheck.unref?.();
      stops.push(() => {
        clearInterval(recheck);
        r.stop();
        if (reporter === r) reporter = null;
      });
    }
  }
  log.info(
    `fleet: tenant cron on (${hosted.runMode}${hosted.schedule ? ", wake-on-schedule" : ""})`,
  );
  return () => {
    for (const s of stops) s();
  };
}
