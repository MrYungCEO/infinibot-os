/**
 * Project repos — service layer shared by the RPCs, the agent tool, the
 * coder spawn context and the daily scan.
 *
 *  - resolveRepoRef(): { repoKey | path | projectId } → registered repo
 *  - health reports: background scan jobs (one per repo), cached on disk at
 *    <stateDir>/project-repos/health/<slug>-<hash>.json, broadcast as
 *    `projects.repo.health.changed`
 *  - deploy targets for agents (deployTargetFor / deployContextForWorkdir)
 *  - daily scan: REPORT ONLY (notification + badge count), never deletes
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { scanRepoHealth, type HealthReport } from "./branch-health.js";
import { deployStatus, type DeployStatus } from "./deploy-detect.js";
import {
  ensureRepoRecord,
  mainRootForKey,
  readRegistry,
  repoSlug,
  resolveRepoKeySync,
  updateRegistry,
  type DeployConfig,
  type RegistryFile,
  type RepoRecord,
} from "./registry.js";

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
let broadcaster: BroadcastFn | null = null;

export function setRepoHealthBroadcaster(fn: BroadcastFn | null): void {
  broadcaster = fn;
}

export function broadcastRepos(event: string, payload: unknown): void {
  try {
    broadcaster?.(event, payload, { dropIfSlow: true });
  } catch {
    /* best-effort */
  }
}

export function stateDir(): string {
  return resolveStateDir();
}

// ── Repo resolution ──────────────────────────────────────────────────

export interface RepoRef {
  repoKey?: string;
  path?: string;
  projectId?: string;
}

export interface ResolvedRepo {
  key: string;
  root: string;
  record: RepoRecord | null;
  /** The checkout the caller pointed at (may be a linked worktree). */
  checkout: string;
}

export function resolveRepoFromRegistry(reg: RegistryFile, ref: RepoRef): ResolvedRepo | null {
  if (ref.repoKey && reg.repos[ref.repoKey]) {
    const rec = reg.repos[ref.repoKey];
    return { key: rec.key, root: rec.root, record: rec, checkout: rec.root };
  }
  let p = ref.path;
  if (!p && ref.projectId) {
    const b = reg.bindings[ref.projectId];
    if (b?.path) p = b.path;
  }
  if (!p) return null;
  const k = resolveRepoKeySync(p);
  if (!k) return null;
  const rec = reg.repos[k.key] ?? null;
  return { key: k.key, root: rec?.root ?? mainRootForKey(k.key), record: rec, checkout: k.root };
}

/** Register (idempotent) the repo that holds `checkout`. */
export async function registerRepo(checkout: string): Promise<RepoRecord> {
  const rec = await updateRegistry(stateDir(), (reg) => ensureRepoRecord(reg, checkout));
  if (!rec) throw new Error(`${checkout} is not a git repository`);
  return rec;
}

// ── Health reports ───────────────────────────────────────────────────

export function healthFile(rec: Pick<RepoRecord, "key" | "name">): string {
  const h = crypto.createHash("sha1").update(rec.key).digest("hex").slice(0, 8);
  return path.join(stateDir(), "project-repos", "health", `${repoSlug(rec)}-${h}.json`);
}

export function readHealthReport(rec: Pick<RepoRecord, "key" | "name">): HealthReport | null {
  try {
    return JSON.parse(fs.readFileSync(healthFile(rec), "utf8")) as HealthReport;
  } catch {
    return null;
  }
}

function writeHealthReport(rec: RepoRecord, report: HealthReport): void {
  const file = healthFile(rec);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report));
  fs.renameSync(tmp, file);
}

interface ScanJob {
  key: string;
  startedAt: number;
  phase: string;
  done: number;
  total: number;
  promise: Promise<HealthReport>;
}

const jobs = new Map<string, ScanJob>();

export function scanJob(key: string): Omit<ScanJob, "promise"> | null {
  const j = jobs.get(key);
  return j
    ? { key: j.key, startedAt: j.startedAt, phase: j.phase, done: j.done, total: j.total }
    : null;
}

/** Start (or join) a background scan of a registered repo. */
export function startHealthScan(
  rec: RepoRecord,
  opts: { sizes?: boolean; github?: boolean } = {},
): Promise<HealthReport> {
  const running = jobs.get(rec.key);
  if (running) return running.promise;
  const job: ScanJob = {
    key: rec.key,
    startedAt: Date.now(),
    phase: "starting",
    done: 0,
    total: 0,
    promise: Promise.resolve(null as never),
  };
  let lastEmit = 0;
  job.promise = (async () => {
    broadcastRepos("projects.repo.health.changed", { repoKey: rec.key, scanning: true });
    try {
      const report = await scanRepoHealth(rec.root, {
        deployBranch: rec.deploy?.branch,
        deployWorktreePath: rec.deploy?.worktreePath,
        sizes: opts.sizes !== false,
        github: opts.github !== false,
        onProgress: (phase, done, total) => {
          job.phase = phase;
          job.done = done;
          job.total = total;
          if (Date.now() - lastEmit > 700) {
            lastEmit = Date.now();
            broadcastRepos("projects.repo.health.progress", {
              repoKey: rec.key,
              phase,
              done,
              total,
            });
          }
        },
      });
      report.repoKey = rec.key;
      writeHealthReport(rec, report);
      await updateRegistry(stateDir(), (reg) => {
        const r = reg.repos[rec.key];
        if (r) {
          r.lastHealth = {
            at: report.scannedAt,
            totals: report.totals,
            deployBranch: report.deployBranch,
          };
          r.updatedAt = Date.now();
        }
      });
      broadcastRepos("projects.repo.health.changed", {
        repoKey: rec.key,
        scanning: false,
        totals: report.totals,
        scannedAt: report.scannedAt,
      });
      return report;
    } catch (err) {
      broadcastRepos("projects.repo.health.changed", {
        repoKey: rec.key,
        scanning: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      jobs.delete(rec.key);
    }
  })();
  jobs.set(rec.key, job);
  job.promise.catch(() => undefined);
  return job.promise;
}

// ── Deploy targets for agents ────────────────────────────────────────

export interface DeployTargetInfo {
  repo: { key: string; name: string; root: string };
  deploy: DeployConfig | null;
  status?: DeployStatus;
  /** Plain-language instructions for agents. */
  instructions: string;
}

export function describeDeploy(rec: RepoRecord, status?: DeployStatus): string {
  const d = rec.deploy;
  if (!d) {
    return `No deploy branch is set for ${rec.name}. Ask the owner (Repos page → Deploy branch) before deploying.`;
  }
  const parts = [
    `Deploy ${rec.name} from branch "${d.branch}" in ${d.worktreePath}.`,
    d.target ? `Target: ${d.target.kind}${d.target.name ? ` (${d.target.name})` : ""}.` : "",
    d.command ? `Command: ${d.command}` : "",
    d.notes ? `Notes: ${d.notes}` : "",
  ];
  if (status) {
    if (!status.exists) parts.push("WARNING: the deploy folder does not exist.");
    else {
      if (!status.onDeployBranch) {
        parts.push(
          `WARNING: that folder is on "${status.checkedOutBranch ?? "detached HEAD"}", not "${d.branch}".`,
        );
      }
      if (status.dirty)
        parts.push(`It has ${status.dirtyCount} uncommitted change(s) — do not discard them.`);
      if (status.behind) parts.push(`It is ${status.behind} commit(s) behind ${status.originRef}.`);
      if (status.ahead)
        parts.push(`It is ${status.ahead} commit(s) ahead of ${status.originRef} (unpushed).`);
    }
  }
  parts.push(
    "Do feature work in a separate worktree/branch, then merge into the deploy branch; never build or reset inside the deploy folder unless the owner asks.",
  );
  return parts.filter(Boolean).join(" ");
}

export async function deployTargetFor(
  ref: RepoRef,
  opts: { status?: boolean } = {},
): Promise<DeployTargetInfo | null> {
  const reg = readRegistry(stateDir());
  const r = resolveRepoFromRegistry(reg, ref);
  if (!r) return null;
  const rec = r.record ?? {
    key: r.key,
    name: path.basename(r.root),
    root: r.root,
    addedAt: 0,
    updatedAt: 0,
  };
  const status = rec.deploy && opts.status !== false ? await deployStatus(rec.deploy) : undefined;
  return {
    repo: { key: rec.key, name: rec.name, root: rec.root },
    deploy: rec.deploy ?? null,
    status,
    instructions: describeDeploy(rec, status),
  };
}

/**
 * Markdown block for a coder spawn whose workdir (or project) belongs to a
 * repo with a deploy branch. Sync + fs-only (no git spawn) so it never slows
 * a spawn; returns null when nothing is configured.
 */
export function deployContextForSpawn(input: {
  workdir?: string;
  projectId?: string;
}): string | null {
  try {
    const reg = readRegistry(stateDir());
    const r =
      (input.projectId ? resolveRepoFromRegistry(reg, { projectId: input.projectId }) : null) ??
      (input.workdir ? resolveRepoFromRegistry(reg, { path: input.workdir }) : null);
    const d = r?.record?.deploy;
    if (!r?.record || !d) return null;
    const inDeployFolder =
      input.workdir && path.resolve(input.workdir) === path.resolve(d.worktreePath);
    return [
      "## Deploy target (from Repos › Deploy branch)",
      `- Repo: ${r.record.name} (${r.record.root})`,
      `- Deploy branch: \`${d.branch}\``,
      `- Deploy folder: ${d.worktreePath}`,
      d.target ? `- Target: ${d.target.kind}${d.target.name ? ` — ${d.target.name}` : ""}` : "",
      d.command ? `- Deploy command: \`${d.command}\`` : "",
      d.notes ? `- Notes: ${d.notes}` : "",
      inDeployFolder
        ? "- You are IN the deploy folder: do not build, reset or switch branches here unless the task says so."
        : "- Work in your own worktree/branch, merge into the deploy branch, and deploy from the deploy folder.",
      '- Live status: call the `project_repos` tool (action "deployTarget").',
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return null;
  }
}

// ── Daily scan (report only) ─────────────────────────────────────────

let schedulerTimer: NodeJS.Timeout | null = null;
const DAY_MS = 24 * 3_600_000;

export async function runDailyScanIfDue(
  opts: { force?: boolean; notify?: (text: string) => Promise<void> } = {},
): Promise<number> {
  const reg = readRegistry(stateDir());
  if (!reg.scan.daily && !opts.force) return 0;
  if (!opts.force && reg.scan.lastRunAt && Date.now() - reg.scan.lastRunAt < DAY_MS) return 0;
  await updateRegistry(stateDir(), (r) => {
    r.scan.lastRunAt = Date.now();
  });
  const lines: string[] = [];
  let scanned = 0;
  for (const rec of Object.values(reg.repos)) {
    if (!fs.existsSync(rec.root)) continue;
    try {
      const report = await startHealthScan(rec, { sizes: true, github: true });
      scanned++;
      const t = report.totals;
      if (t.safe || t.worktreesSafe || t.review) {
        lines.push(
          `${rec.name}: ${t.safe} branch(es) + ${t.worktreesSafe} worktree(s) safe to delete (${(t.reclaimBytes / 1e9).toFixed(1)} GB), ${t.review} to review, ${t.stashes} stash(es)`,
        );
      }
    } catch {
      /* one bad repo must not stop the rest */
    }
  }
  if (lines.length && opts.notify) {
    await opts
      .notify(`Repo branch health (report only — nothing was deleted):\n${lines.join("\n")}`)
      .catch(() => undefined);
    await updateRegistry(stateDir(), (r) => {
      r.scan.lastNotifiedAt = Date.now();
    });
  }
  return scanned;
}

export function startRepoHealthScheduler(log?: { warn: (m: string) => void }): void {
  if (schedulerTimer) return;
  const tick = async () => {
    try {
      await runDailyScanIfDue({
        notify: async (text) => {
          const { sendNotification } = await import("../../autonomy/notifications.js");
          await sendNotification("info", "Repo branch health", text, { link: "/repos" });
        },
      });
    } catch (err) {
      log?.warn(`repo health daily scan failed: ${String(err)}`);
    }
  };
  // Check hourly; the registry decides whether a day has passed.
  setTimeout(() => void tick(), 5 * 60_000).unref?.();
  schedulerTimer = setInterval(() => void tick(), 3_600_000);
  schedulerTimer.unref?.();
}
