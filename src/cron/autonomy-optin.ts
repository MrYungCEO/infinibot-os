/**
 * Autonomy opt-in for seeded cron jobs.
 *
 * The gateway seeds a family of self-driven jobs on boot: proactive nudges,
 * the autonomy queue poll, CEO/proactive reports, oversight reports, the agency
 * operating loop, project summaries and agency SOP schedules. Every one of them
 * wakes the main agent (or runs model work in-process), so on a fresh install
 * they would start spending the user's model tokens within minutes of the first
 * boot, before the user asked for anything.
 *
 * Policy:
 *  - FRESH install: missing autonomy jobs are created DISABLED. The operator
 *    turns them on with `cron.autonomy: true` (config), `INFINIBOT_AUTONOMY=1`,
 *    or per job in Settings.
 *  - EXISTING install: nothing changes. Seeding only ever affects the creation
 *    of missing jobs; an existing job's `enabled` flag is never touched. An
 *    install that already has an enabled autonomy job predates the opt-in and
 *    keeps getting new autonomy jobs enabled, exactly as before.
 *  - Opting in later: jobs that were created disabled *by this gate* are
 *    recorded in a sidecar file next to the cron store. When the opt-in turns on
 *    they are enabled once. Jobs the operator disabled themselves are not on
 *    that list and stay disabled.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../config/io.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

/** Minimal slice of CronService the opt-in needs. Structural for tests. */
export type AutonomyCronPort = {
  list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]>;
  add(input: CronJobCreate): Promise<CronJob>;
  update?(id: string, patch: CronJobPatch): Promise<unknown>;
  readonly storePath?: string;
};

/** Names of the fixed autonomy jobs seeded at boot. */
export const AUTONOMY_JOB_NAMES: ReadonlySet<string> = new Set([
  // src/cron/default-jobs.ts
  "heartbeat-proactive",
  "autonomy-queue-poll",
  // src/reports/ceo-cron.ts
  "ceo-hourly-insights",
  // src/reports/proactive-cron.ts
  "proactive-daily-brief",
  "proactive-dev-summary",
  "proactive-content-overview",
  // src/cron/oversight-jobs.ts
  "oversight-morning-brief",
  "oversight-drift-digest",
  "oversight-inbox-triage",
  "oversight-velocity-report",
  "oversight-cost-report",
  "oversight-client-snapshot",
  "oversight-followups-report",
  "oversight-health-audit",
  "oversight-memory-hygiene",
  "oversight-pulse",
  "oversight-subagent-watchdog",
  "oversight-provider-ratelimit-watch",
  "oversight-disk-log-rolloff",
  // src/cron/agency-operating-jobs.ts, src/cron/project-summary-jobs.ts
  "agency-operating-loop",
  "project-summary-daily",
]);

/** SOP schedules are named `agency-sop:<slug>:<worker>` (src/cron/sop-jobs.ts). */
const SOP_JOB_PREFIX = "agency-sop:";

export function isAutonomyJobName(name: string): boolean {
  return AUTONOMY_JOB_NAMES.has(name) || name.startsWith(SOP_JOB_PREFIX);
}

function parseFlag(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

/**
 * The explicit operator choice, or undefined when none was made.
 * `INFINIBOT_AUTONOMY` wins over `cron.autonomy` in config.
 */
export function resolveExplicitAutonomy(
  env: NodeJS.ProcessEnv = process.env,
  readConfig: () => { cron?: { autonomy?: boolean } } | undefined = safeLoadConfig,
): boolean | undefined {
  const fromEnv = parseFlag(env.INFINIBOT_AUTONOMY);
  if (fromEnv !== undefined) return fromEnv;
  const fromConfig = readConfig()?.cron?.autonomy;
  return typeof fromConfig === "boolean" ? fromConfig : undefined;
}

function safeLoadConfig(): { cron?: { autonomy?: boolean } } | undefined {
  try {
    return loadConfig();
  } catch {
    return undefined;
  }
}

/**
 * Should a newly created autonomy job start enabled?
 *
 * Explicit opt-in/out wins. Otherwise an install that already runs any enabled
 * autonomy job (i.e. predates the opt-in) keeps its behaviour; a fresh one
 * starts with everything off.
 */
export async function resolveAutonomySeedEnabled(
  cron: Pick<AutonomyCronPort, "list">,
  opts?: {
    env?: NodeJS.ProcessEnv;
    readConfig?: () => { cron?: { autonomy?: boolean } } | undefined;
  },
): Promise<boolean> {
  const explicit = resolveExplicitAutonomy(opts?.env, opts?.readConfig);
  if (explicit !== undefined) return explicit;
  const jobs = await cron.list({ includeDisabled: true });
  return jobs.some((job) => job.enabled && isAutonomyJobName(job.name));
}

type OptInState = { seededDisabled: string[] };

export function autonomyOptInPath(storePath: string): string {
  return path.join(path.dirname(storePath), "autonomy-optin.json");
}

async function readOptInState(file: string): Promise<OptInState> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as Partial<OptInState>;
    return {
      seededDisabled: Array.isArray(parsed.seededDisabled)
        ? parsed.seededDisabled.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { seededDisabled: [] };
  }
}

async function writeOptInState(file: string, state: OptInState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

/** Serialises writes to the sidecar file within this process. */
let optInWriteChain: Promise<unknown> = Promise.resolve();

async function recordSeededDisabled(cron: AutonomyCronPort, jobId: string): Promise<void> {
  if (!cron.storePath) return;
  const file = autonomyOptInPath(cron.storePath);
  const next = optInWriteChain.then(async () => {
    const state = await readOptInState(file);
    if (!state.seededDisabled.includes(jobId)) state.seededDisabled.push(jobId);
    await writeOptInState(file, state);
  });
  optInWriteChain = next.catch(() => undefined);
  await next;
}

export type SeedAutonomyOptions = {
  /** Pre-resolved decision (saves a list() per job when seeding a batch). */
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  readConfig?: () => { cron?: { autonomy?: boolean } } | undefined;
};

/**
 * Create an autonomy job, gated by the opt-in. The spec's own `enabled: false`
 * is always respected; the gate can only turn a job off, never on.
 */
export async function addAutonomyJob(
  cron: AutonomyCronPort,
  spec: CronJobCreate,
  opts?: SeedAutonomyOptions,
): Promise<CronJob> {
  const allowed = opts?.enabled ?? (await resolveAutonomySeedEnabled(cron, opts));
  if (allowed || spec.enabled === false) return cron.add(spec);
  const job = await cron.add({ ...spec, enabled: false });
  await recordSeededDisabled(cron, job.id);
  return job;
}

/**
 * When the operator has explicitly opted in, enable the jobs this gate created
 * disabled (once), then forget them. Operator-disabled jobs are never touched.
 * Returns the names of jobs that were enabled.
 */
export async function applyAutonomyOptIn(
  cron: AutonomyCronPort,
  opts?: {
    env?: NodeJS.ProcessEnv;
    readConfig?: () => { cron?: { autonomy?: boolean } } | undefined;
  },
): Promise<string[]> {
  if (resolveExplicitAutonomy(opts?.env, opts?.readConfig) !== true) return [];
  if (!cron.storePath || !cron.update) return [];
  const file = autonomyOptInPath(cron.storePath);
  const state = await readOptInState(file);
  if (state.seededDisabled.length === 0) return [];
  const pending = new Set(state.seededDisabled);
  const enabled: string[] = [];
  for (const job of await cron.list({ includeDisabled: true })) {
    if (!pending.has(job.id)) continue;
    if (!job.enabled) {
      await cron.update(job.id, { enabled: true });
      enabled.push(job.name);
    }
  }
  await writeOptInState(file, { seededDisabled: [] });
  return enabled;
}
