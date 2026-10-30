/**
 * Oversight reports — shared collectors.
 *
 * Pure reads over the canonical InfiniBot stores (kanban, subagent history +
 * registry, the plan-aware credits aggregator, the databases "clients" role,
 * agent memory files, and the filesystem). Every read is wrapped in `safe()`
 * so a single store failure degrades to a `collectionGaps` note instead of
 * aborting the whole report — the same defensive contract the existing
 * `ceo-hourly` / `daily-summary` collectors use.
 *
 * These return plain data; the report kinds shape it into a ReportPayload.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { budgetStatuses, summary } from "../../credits/aggregator.js";
import { listProviderPlans } from "../../credits/plan-service.js";
import { listSubagentHistory } from "../../agents/subagent-history.js";
import { loadSubagentRegistryFromDisk } from "../../agents/subagent-registry.store.js";
import { getKanbanStore } from "../../tasks/store.js";
import { getDatabasesStore } from "../../databases/store.js";
import { listMemoryFiles } from "../../memory/internal.js";
import type { KanbanProject, KanbanTask } from "../../tasks/types.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

export function resolveStateDir(stateDir?: string): string {
  return stateDir ?? process.env.INFINIBOT_STATE_DIR ?? join(homedir(), ".infinibot");
}

export function safe<T>(label: string, gaps: string[], fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    gaps.push(`${label}: ${String((err as Error)?.message ?? err)}`);
    return fallback;
  }
}

export async function safeAsync<T>(
  label: string,
  gaps: string[],
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    gaps.push(`${label}: ${String((err as Error)?.message ?? err)}`);
    return fallback;
  }
}

const FOLLOW_UP_TAGS = ["follow-up", "followup", "waiting-on", "waiting", "blocked"];

export function isFollowUpTask(t: KanbanTask): boolean {
  const tags = (t.tags ?? []).map((x) => String(x).toLowerCase());
  if (tags.some((x) => FOLLOW_UP_TAGS.includes(x))) return true;
  return t.status === "review";
}

export function daysSince(ms: number | undefined, now: number): number {
  if (!ms || ms <= 0) return -1;
  return Math.max(0, Math.floor((now - ms) / DAY_MS));
}

// ─────────────────────────────────────────────────────────────────────────────
// Kanban + subagent activity (morning brief, velocity, follow-ups, drift)
// ─────────────────────────────────────────────────────────────────────────────

export interface ActivityWindow {
  now: number;
  since: number;
  tasksCompleted: KanbanTask[];
  tasksInProgress: KanbanTask[];
  tasksBlocked: KanbanTask[];
  agents: { completed: number; failed: number; timedOut: number; inProgress: number };
  agentFailures: Array<{
    runId: string;
    task: string;
    status: string;
    error?: string;
    backend?: string;
  }>;
  gaps: string[];
}

export async function collectActivityWindow(opts: {
  now?: number;
  windowMs?: number;
  stateDir?: string;
}): Promise<ActivityWindow> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs && opts.windowMs > 0 ? opts.windowMs : DAY_MS;
  const since = now - windowMs;
  const stateDir = resolveStateDir(opts.stateDir);
  const gaps: string[] = [];

  const allTasks = await safeAsync(
    "kanban.getTasks",
    gaps,
    async () => getKanbanStore(stateDir).getTasks(),
    [] as KanbanTask[],
  );

  const tasksCompleted = allTasks.filter(
    (t) =>
      t.status === "done" &&
      typeof t.completedAt === "number" &&
      (t.completedAt as number) >= since,
  );
  const tasksInProgress = allTasks.filter((t) => t.status === "in_progress");
  const tasksBlocked = allTasks.filter(
    (t) =>
      t.status === "review" || (t as { autonomousStatus?: string }).autonomousStatus === "blocked",
  );

  const finished = safe(
    "subagents.history",
    gaps,
    () => listSubagentHistory({ since, limit: 200 }).entries,
    [] as ReturnType<typeof listSubagentHistory>["entries"],
  );
  const completed = finished.filter((e) => e.status === "complete").length;
  const failed = finished.filter((e) => e.status === "error").length;
  const timedOut = finished.filter((e) => e.status === "timeout").length;
  const agentFailures = finished
    .filter((e) => e.status !== "complete")
    .map((e) => ({
      runId: e.runId,
      task: e.task,
      status: e.status,
      error: e.error ?? e.outcome?.error ?? undefined,
      backend: e.coderBackend,
    }));

  const inProgress = safe(
    "subagents.registry",
    gaps,
    () =>
      [...loadSubagentRegistryFromDisk().values()].filter((r) => !r.endedAt && !r.interruptedAt)
        .length,
    0,
  );

  return {
    now,
    since,
    tasksCompleted,
    tasksInProgress,
    tasksBlocked,
    agents: { completed, failed, timedOut, inProgress },
    agentFailures,
    gaps,
  };
}

export interface ProjectActivity {
  project: KanbanProject;
  lastActivityAt: number;
  daysSinceActivity: number;
  openCount: number;
  doneCount: number;
}

export async function collectProjectActivity(opts: {
  now?: number;
  stateDir?: string;
}): Promise<{ projects: ProjectActivity[]; gaps: string[] }> {
  const now = opts.now ?? Date.now();
  const stateDir = resolveStateDir(opts.stateDir);
  const gaps: string[] = [];
  const projects = await safeAsync(
    "kanban.getProjects",
    gaps,
    async () => getKanbanStore(stateDir).getProjects(),
    [] as KanbanProject[],
  );
  const tasks = await safeAsync(
    "kanban.getTasks",
    gaps,
    async () => getKanbanStore(stateDir).getTasks(),
    [] as KanbanTask[],
  );
  const byId = new Map<string, ProjectActivity>();
  for (const p of projects) {
    byId.set(p.id, {
      project: p,
      lastActivityAt: p.updatedAt ?? 0,
      daysSinceActivity: -1,
      openCount: 0,
      doneCount: 0,
    });
  }
  for (const t of tasks) {
    const agg = byId.get(t.projectId);
    if (!agg) continue;
    if (typeof t.updatedAt === "number" && t.updatedAt > agg.lastActivityAt) {
      agg.lastActivityAt = t.updatedAt;
    }
    if (t.status === "done") agg.doneCount += 1;
    else agg.openCount += 1;
  }
  const out = [...byId.values()];
  for (const a of out) a.daysSinceActivity = daysSince(a.lastActivityAt, now);
  return { projects: out, gaps };
}

export interface VelocityRow {
  projectId: string;
  name: string;
  thisWeek: number;
  lastWeek: number;
  delta: number;
}

export async function collectVelocity(opts: {
  now?: number;
  stateDir?: string;
}): Promise<{ rows: VelocityRow[]; gaps: string[] }> {
  const now = opts.now ?? Date.now();
  const stateDir = resolveStateDir(opts.stateDir);
  const gaps: string[] = [];
  const projects = await safeAsync(
    "kanban.getProjects",
    gaps,
    async () => getKanbanStore(stateDir).getProjects(),
    [] as KanbanProject[],
  );
  const tasks = await safeAsync(
    "kanban.getTasks",
    gaps,
    async () => getKanbanStore(stateDir).getTasks(),
    [] as KanbanTask[],
  );
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const thisWeekStart = now - WEEK_MS;
  const lastWeekStart = now - 2 * WEEK_MS;
  const tally = new Map<string, { thisWeek: number; lastWeek: number }>();
  for (const t of tasks) {
    if (t.status !== "done" || typeof t.completedAt !== "number") continue;
    const c = t.completedAt;
    const row = tally.get(t.projectId) ?? { thisWeek: 0, lastWeek: 0 };
    if (c >= thisWeekStart) row.thisWeek += 1;
    else if (c >= lastWeekStart) row.lastWeek += 1;
    tally.set(t.projectId, row);
  }
  const rows: VelocityRow[] = [...tally.entries()]
    .map(([projectId, v]) => ({
      projectId,
      name: nameById.get(projectId) ?? projectId,
      thisWeek: v.thisWeek,
      lastWeek: v.lastWeek,
      delta: v.thisWeek - v.lastWeek,
    }))
    .sort((a, b) => b.thisWeek - a.thisWeek);
  return { rows, gaps };
}

// ─────────────────────────────────────────────────────────────────────────────
// Credits / cost (cost report, provider rate-limit watch)
// ─────────────────────────────────────────────────────────────────────────────

export interface CostSnapshot {
  period: string;
  totalCostUsd: number;
  byBackend: Array<{ backend: string; costUsd: number; requests: number }>;
  byProject: Array<{ projectId: string; costUsd: number; requests: number }>;
  budgets: Array<{
    name: string;
    pctUsed: number;
    state: string;
    currentSpendUsd: number;
    monthlyLimitUsd: number;
  }>;
  plans: Array<{
    provider: string;
    pctUsed: number;
    usedUsd?: number;
    limitUsd?: number;
    status: string;
  }>;
  gaps: string[];
}

export function collectCost(opts: {
  period?: "day" | "week" | "month";
  stateDir?: string;
}): CostSnapshot {
  const period = opts.period ?? "week";
  const gaps: string[] = [];
  const agg = safe(
    "credits.summary",
    gaps,
    () => summary({ period }),
    null as ReturnType<typeof summary> | null,
  );
  const byBackend = ((agg?.byBackend ?? []) as unknown as Array<Record<string, unknown>>)
    .map((b) => ({
      backend: String(b.backend ?? b.agentBackend ?? "unknown"),
      costUsd: Number(b.costUsd ?? 0),
      requests: Number(b.requests ?? 0),
    }))
    .filter((b) => b.costUsd > 0 || b.requests > 0)
    .sort((a, b) => b.costUsd - a.costUsd);
  const byProject = ((agg?.byProject ?? []) as Array<Record<string, unknown>>)
    .map((p) => ({
      projectId: String(p.projectId ?? "unattributed"),
      costUsd: Number(p.costUsd ?? 0),
      requests: Number(p.requests ?? 0),
    }))
    .filter((p) => p.costUsd > 0 || p.requests > 0)
    .sort((a, b) => b.costUsd - a.costUsd);
  const budgets = safe(
    "credits.budgets",
    gaps,
    () =>
      budgetStatuses().map((s) => ({
        name: s.name,
        pctUsed: Math.round(s.pctUsed),
        state: s.state,
        currentSpendUsd: Number(s.currentSpendUsd.toFixed(2)),
        monthlyLimitUsd: s.monthlyLimitUsd,
      })),
    [] as CostSnapshot["budgets"],
  );
  const plans = safe(
    "credits.plans",
    gaps,
    () =>
      listProviderPlans()
        .map((v) => {
          const u = v.usage as unknown as Record<string, unknown> | undefined;
          const usedUsd = u?.usedUsd != null ? Number(u.usedUsd) : undefined;
          const limitUsd = u?.limitUsd != null ? Number(u.limitUsd) : undefined;
          const usedTok = u?.usedTokens != null ? Number(u.usedTokens) : undefined;
          const limitTok = u?.limitTokens != null ? Number(u.limitTokens) : undefined;
          let pctUsed = 0;
          if (usedUsd != null && limitUsd) pctUsed = Math.round((usedUsd / limitUsd) * 100);
          else if (usedTok != null && limitTok) pctUsed = Math.round((usedTok / limitTok) * 100);
          return {
            provider: String(v.provider),
            pctUsed,
            usedUsd,
            limitUsd,
            status: String(u?.status ?? "unknown"),
          };
        })
        .sort((a, b) => b.pctUsed - a.pctUsed),
    [] as CostSnapshot["plans"],
  );
  return {
    period,
    totalCostUsd: Number((agg?.totalCostUsd ?? 0).toFixed(4)),
    byBackend,
    byProject,
    budgets,
    plans,
    gaps,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clients / CRM (client status snapshot)
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientRow {
  id: string;
  name: string;
  status: string;
  lastTouchAt: number;
  daysSinceTouch: number;
  nextDeliverable: string;
}

/** Pull a human display string out of a databases PropertyValue of unknown shape. */
function propText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  const o = v as Record<string, unknown>;
  return String(
    o.text ?? o.markdown ?? o.name ?? o.label ?? o.value ?? o.iso ?? o.optionId ?? "",
  ).trim();
}

export function collectClients(opts: { now?: number; stateDir?: string }): {
  clients: ClientRow[];
  gaps: string[];
} {
  const now = opts.now ?? Date.now();
  const stateDir = resolveStateDir(opts.stateDir);
  const gaps: string[] = [];
  const clients = safe(
    "databases.clients",
    gaps,
    () => {
      const store = getDatabasesStore(stateDir);
      const resolved = store.resolveSystemRole("clients" as never);
      if (!resolved) return [] as ClientRow[];
      const props = (resolved.properties ?? []) as Array<{
        id: string;
        name?: string;
        type?: string;
      }>;
      const findProp = (...needles: string[]) =>
        props.find((p) => needles.some((n) => (p.name ?? "").toLowerCase().includes(n)));
      const statusProp = findProp("status", "stage");
      const nextProp = findProp("next", "deliverable", "milestone");
      const touchProp = findProp("last touch", "last contact", "last update", "updated");
      const rows = store.queryRows({ databaseId: resolved.database.id } as never) as Array<{
        id: string;
        title?: string;
        updatedAt?: number;
        values?: Record<string, unknown>;
      }>;
      return rows.map((r) => {
        const vals = r.values ?? {};
        const lastTouchRaw = touchProp ? propText(vals[touchProp.id]) : "";
        const parsed = lastTouchRaw ? Date.parse(lastTouchRaw) : NaN;
        const lastTouchAt = Number.isFinite(parsed) ? parsed : (r.updatedAt ?? 0);
        return {
          id: r.id,
          name: r.title || "(untitled client)",
          status: statusProp ? propText(vals[statusProp.id]) || "—" : "—",
          lastTouchAt,
          daysSinceTouch: daysSince(lastTouchAt, now),
          nextDeliverable: nextProp ? propText(vals[nextProp.id]) || "—" : "—",
        };
      });
    },
    [] as ClientRow[],
  );
  clients.sort((a, b) => b.daysSinceTouch - a.daysSinceTouch);
  return { clients, gaps };
}

// ─────────────────────────────────────────────────────────────────────────────
// Health audit + memory hygiene (monthly)
// ─────────────────────────────────────────────────────────────────────────────

function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      try {
        if (entry.isDirectory()) total += dirSizeBytes(p);
        else total += fs.statSync(p).size;
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* dir missing */
  }
  return total;
}

export interface HealthSnapshot {
  logsBytes: number;
  reportsBytes: number;
  dbBytes: Array<{ name: string; bytes: number }>;
  freeBytes: number | null;
  uptimeSec: number;
  gaps: string[];
}

export function collectHealth(opts: { stateDir?: string }): HealthSnapshot {
  const stateDir = resolveStateDir(opts.stateDir);
  const gaps: string[] = [];
  const logsBytes = safe("health.logs", gaps, () => dirSizeBytes(join(stateDir, "logs")), 0);
  const reportsBytes = safe(
    "health.reports",
    gaps,
    () => dirSizeBytes(join(stateDir, "reports")),
    0,
  );
  const dbBytes = safe(
    "health.db",
    gaps,
    () =>
      fs
        .readdirSync(stateDir)
        .filter((f) => f.endsWith(".db") || f.endsWith(".sqlite"))
        .map((f) => ({ name: f, bytes: fs.statSync(join(stateDir, f)).size }))
        .sort((a, b) => b.bytes - a.bytes),
    [] as Array<{ name: string; bytes: number }>,
  );
  const freeBytes = safe<number | null>(
    "health.free",
    gaps,
    () => {
      const s = (
        fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }
      ).statfsSync?.(stateDir);
      return s ? s.bavail * s.bsize : null;
    },
    null,
  );
  return {
    logsBytes,
    reportsBytes,
    dbBytes,
    freeBytes,
    uptimeSec: Math.round(process.uptime()),
    gaps,
  };
}

export interface MemoryHygiene {
  total: number;
  empty: string[];
  large: Array<{ path: string; bytes: number }>;
  workspaceDir: string;
  gaps: string[];
}

export async function collectMemoryHygiene(opts: {
  workspaceDir?: string;
}): Promise<MemoryHygiene> {
  const gaps: string[] = [];
  // Default to the agent workspace memory (DEV agent identity lives in ~/clawd).
  const workspaceDir =
    opts.workspaceDir ?? process.env.INFINIBOT_AGENT_WORKSPACE ?? join(homedir(), "clawd");
  const files = await safeAsync(
    "memory.list",
    gaps,
    () => listMemoryFiles(workspaceDir),
    [] as string[],
  );
  const empty: string[] = [];
  const large: Array<{ path: string; bytes: number }> = [];
  for (const rel of files) {
    try {
      const bytes = fs.statSync(join(workspaceDir, rel)).size;
      if (bytes === 0) empty.push(rel);
      if (bytes > 24_000) large.push({ path: rel, bytes });
    } catch {
      /* skip */
    }
  }
  large.sort((a, b) => b.bytes - a.bytes);
  return { total: files.length, empty, large, workspaceDir, gaps };
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}
