/**
 * Build DayRollup records. One pass over every source for the whole range,
 * then folded per local day. Results land in analytics/daily/<day>.json plus a
 * compact index.json; a mirror under files/.daily-review lets the control UI
 * read them through the already-served `files.read` RPC.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveProject } from "./classify.js";
import { sizeBonus, baselineFrom, finalizeScore, scorePoints } from "./score.js";
import { loadCommits, discoverRepos, type CommitRecord } from "./sources/git.js";
import { loadKanban, type KanbanData } from "./sources/kanban.js";
import {
  countWorkEvents,
  listReports,
  loadIncidents,
  type Incident,
  type ReportFile,
} from "./sources/misc.js";
import { loadRuns } from "./sources/runs.js";
import { scanSessions, type SessionCache } from "./sources/sessions.js";
import type { LogCursor } from "./stream-log.js";
import type {
  Accomplishment,
  Bucket,
  DailyReviewConfig,
  DayIndexEntry,
  DayRollup,
  DayRun,
  DeployRef,
  HourBucket,
  ProjectBucket,
  RunRecord,
} from "./types.js";
import {
  addDays,
  cacheDir,
  dailyDir,
  dayEnd,
  dayKey,
  dayStart,
  daysBetween,
  filesMirrorDir,
  loadConfig,
  readJson,
  round,
  stateDir as defaultStateDir,
  today,
  writeJsonAtomic,
} from "./util.js";

interface RollupCache {
  v: 1;
  cursors: Record<string, LogCursor>;
  sessions: SessionCache;
}

const CACHE_FILE = "rollup-cache.json";

function loadCache(base: string): RollupCache {
  const c = readJson<RollupCache>(path.join(cacheDir(base), CACHE_FILE));
  return c && c.v === 1 ? c : { v: 1, cursors: {}, sessions: {} };
}

export interface Sources {
  runs: RunRecord[];
  kanban: KanbanData;
  commits: CommitRecord[];
  reports: ReportFile[];
  incidents: Incident[];
  sessions: SessionCache;
  workEvents: Record<string, number>;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function bucket(name: string): Bucket {
  return { name, runs: 0, verified: 0, failed: 0, minutes: 0, costUsd: 0, tokens: 0, commits: 0 };
}

function finishBuckets<T extends Bucket>(map: Map<string, T>, limit = 20): T[] {
  const list = [...map.values()].map((b) => ({
    ...b,
    minutes: round(b.minutes, 1),
    costUsd: round(b.costUsd),
  }));
  return list.sort((a, b) => b.minutes - a.minutes || b.runs - a.runs).slice(0, limit) as T[];
}

const runLink = (runId: string) => `/reviews/${encodeURIComponent(runId)}`;

/** Fold the shared sources into one day's record. Exported for tests. */
export function buildDay(
  date: string,
  src: Sources,
  now: number,
  previousNets: number[],
): DayRollup {
  const ds = dayStart(date);
  const de = dayEnd(date);
  const isToday = date === dayKey(now);
  const endOf = (r: RunRecord) => r.endedAt ?? (r.outcome === "running" ? now : r.startedAt);
  const inDay = (ts: number | undefined) => typeof ts === "number" && ts >= ds && ts < de;

  const hours: HourBucket[] = Array.from({ length: 24 }, (_, h) => ({
    h,
    agentMinutes: 0,
    runsStarted: 0,
    messages: 0,
    commits: 0,
    costUsd: 0,
    tokens: 0,
  }));
  const byProject = new Map<string, ProjectBucket>();
  const byBackend = new Map<string, Bucket>();
  const byAgent = new Map<string, Bucket>();
  const byCategory = new Map<string, Bucket>();
  const dayRuns: DayRun[] = [];
  let cliCost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached = 0;
  let telegramFromRuns = 0;

  const runDeploys = new Map<string, DeployRef[]>();
  for (const r of src.runs) {
    const s = r.startedAt;
    const e = Math.max(endOf(r), s);
    const ov = overlap(s, e, ds, de);
    const startedToday = inDay(s);
    const endedToday = r.outcome !== "running" && inDay(r.endedAt ?? s);
    if (ov <= 0 && !startedToday && !endedToday) continue;
    const dur = Math.max(60_000, e - s);
    const frac = e - s <= 0 ? (endedToday ? 1 : 0) : ov / dur;
    const minutes = ov / 60_000;
    const cost = r.costUsd * frac;
    const tokens = (r.tokensIn + r.tokensOut) * frac;
    cliCost += cost;
    tokensIn += r.tokensIn * frac;
    tokensOut += r.tokensOut * frac;
    tokensCached += r.tokensCached * frac;
    // Spread minutes/cost over the hours the run was alive.
    if (ov > 0) {
      for (let h = 0; h < 24; h++) {
        const h0 = ds + h * 3600_000;
        const hv = overlap(s, e, h0, Math.min(de, h0 + 3600_000));
        if (hv <= 0) continue;
        hours[h]!.agentMinutes += hv / 60_000;
        hours[h]!.costUsd += r.costUsd * (hv / dur);
        hours[h]!.tokens += (r.tokensIn + r.tokensOut) * (hv / dur);
      }
    } else if (endedToday) {
      const h = new Date(r.endedAt ?? s).getHours();
      hours[h]!.costUsd += cost;
      hours[h]!.tokens += tokens;
    }
    if (endedToday) {
      telegramFromRuns += r.telegramSends;
      if (r.deploys.length)
        runDeploys.set(
          r.runId,
          r.deploys.map((d) => ({ ...d, ts: r.endedAt ?? d.ts })),
        );
    }
    dayRuns.push({
      runId: r.runId,
      rootId: r.rootId,
      label: r.label,
      project: r.project,
      category: r.category,
      backend: r.backend,
      kind: r.kind,
      start: s,
      end: r.outcome === "running" ? undefined : r.endedAt,
      outcome: r.outcome,
      verdict: r.verdict,
      costUsd: round(cost, 3),
      tokens: Math.round(tokens),
      commits: endedToday ? r.commits : 0,
      files: endedToday ? r.files : 0,
      deploys: 0,
      rework: Boolean(r.respawnOf) && startedToday,
      kanbanTaskId: r.kanbanTaskId,
      minutes: round(minutes, 1),
    });
    // Time and money follow every attempt.
    const addTime = (map: Map<string, Bucket>, name: string) => {
      const b = map.get(name) ?? bucket(name);
      b.minutes += minutes;
      b.costUsd += cost;
      b.tokens += tokens;
      map.set(name, b);
    };
    addTime(byBackend, r.backend);
    addTime(byAgent, r.kind);
    addTime(byCategory, r.category);
    if (!byProject.has(r.project)) byProject.set(r.project, { ...bucket(r.project), tasks: [] });
    addTime(byProject as unknown as Map<string, Bucket>, r.project);
  }

  // ── Logical tasks: continuation passes (-c2, -c3…) collapse into one ───────
  // The latest attempt carries the task's outcome; commits/files take the max
  // over attempts (later passes usually re-list earlier commits).
  const attempts = new Map<string, DayRun[]>();
  for (const r of dayRuns) {
    const list = attempts.get(r.rootId) ?? [];
    list.push(r);
    attempts.set(r.rootId, list);
  }
  const endKey = (x: DayRun) =>
    x.outcome === "running" ? Number.POSITIVE_INFINITY : (x.end ?? x.start);
  const tasks: DayRun[] = [];
  const deploys: DeployRef[] = [];
  const deploySeen = new Set<string>();
  for (const [root, list] of attempts) {
    list.sort((a, b) => endKey(a) - endKey(b));
    const latest = list[list.length - 1]!;
    // A later unverified pass (e.g. an operator follow-up) does not undo an
    // earlier verification; a later failure does.
    const outcome =
      latest.outcome === "unverified" && list.some((x) => x.outcome === "verified")
        ? "verified"
        : latest.outcome;
    const merged: DayRun = {
      ...latest,
      outcome,
      attempts: list.length,
      minutes: round(
        list.reduce((s, x) => s + x.minutes, 0),
        1,
      ),
      costUsd: round(
        list.reduce((s, x) => s + x.costUsd, 0),
        3,
      ),
      tokens: list.reduce((s, x) => s + x.tokens, 0),
      commits: Math.max(...list.map((x) => x.commits)),
      files: Math.max(...list.map((x) => x.files)),
      rework: list.some((x) => x.rework),
    };
    // Deploys: unique per target+ref; a bare "netlify" only when no ref'd one.
    const ds_: DeployRef[] = list.flatMap((x) => runDeploys.get(x.runId) ?? []);
    const withRef = new Set(ds_.filter((d) => d.ref).map((d) => d.target));
    let n = 0;
    for (const d of ds_) {
      if (!d.ref && withRef.has(d.target)) continue;
      const key = d.ref ? `${d.target}:${d.ref}` : `${root}:${d.target}`;
      if (deploySeen.has(key)) continue;
      deploySeen.add(key);
      deploys.push({ ...d, runId: latest.runId, label: latest.label });
      n += 1;
    }
    merged.deploys = n;
    tasks.push(merged);
  }
  const taskEnded = (t: DayRun) => t.outcome !== "running" && inDay(t.end ?? t.start);
  for (const t of tasks) {
    const ended = taskEnded(t);
    if (!ended && t.outcome !== "running" && !(t.minutes > 0)) continue;
    const count = (map: Map<string, Bucket>, name: string) => {
      const b = map.get(name) ?? bucket(name);
      b.runs += 1;
      if (ended && t.outcome === "verified") b.verified += 1;
      if (ended && t.outcome === "failed") b.failed += 1;
      if (ended) b.commits += t.commits;
      map.set(name, b);
    };
    count(byBackend, t.backend);
    count(byAgent, t.kind);
    count(byCategory, t.category);
    count(byProject as unknown as Map<string, Bucket>, t.project);
    byProject
      .get(t.project)
      ?.tasks.push({ label: t.label, minutes: t.minutes, outcome: t.outcome, runId: t.runId });
    const first = attempts
      .get(t.rootId)!
      .reduce((m, x) => Math.min(m, x.start), Number.POSITIVE_INFINITY);
    if (inDay(first)) hours[new Date(first).getHours()]!.runsStarted += 1;
  }
  for (const pb of byProject.values()) {
    pb.tasks.sort((a, b) => b.minutes - a.minutes);
    pb.tasks = pb.tasks.slice(0, 14);
  }

  // ── Git ────────────────────────────────────────────────────────────────────
  const commits = src.commits.filter((c) => inDay(c.ts));
  const repoMap = new Map<
    string,
    { name: string; commits: number; merges: number; project: string }
  >();
  for (const c of commits) {
    const rb = repoMap.get(c.repo) ?? { name: c.repo, commits: 0, merges: 0, project: c.project };
    if (c.merge) rb.merges += 1;
    else rb.commits += 1;
    repoMap.set(c.repo, rb);
    hours[new Date(c.ts).getHours()]!.commits += 1;
    const pb = byProject.get(c.project);
    if (pb && !c.merge) pb.commits += 1;
  }
  const plainCommits = commits.filter((c) => !c.merge).length;

  // ── Sessions (chat / voice / telegram) ─────────────────────────────────────
  const channels = new Map<string, { name: string; messages: number; costUsd: number }>();
  let chatMessages = 0;
  let voiceTurns = 0;
  let telegramSends = telegramFromRuns;
  let gatewayCost = 0;
  for (const f of Object.values(src.sessions)) {
    const b = f.days[date];
    if (!b) continue;
    const ch = channels.get(f.channel) ?? { name: f.channel, messages: 0, costUsd: 0 };
    ch.messages += b.user + b.assistant;
    ch.costUsd += b.costUsd;
    channels.set(f.channel, ch);
    if (f.channel !== "agents") chatMessages += b.user;
    if (f.channel === "voice") voiceTurns += b.user;
    telegramSends += b.telegramSends;
    gatewayCost += b.costUsd;
    const total = b.hours.reduce((a, n) => a + n, 0) || 1;
    b.hours.forEach((n, h) => {
      hours[h]!.messages += n;
      hours[h]!.costUsd += (b.costUsd * n) / total;
    });
  }

  // ── Kanban ─────────────────────────────────────────────────────────────────
  const kCompleted = src.kanban.completed.filter((t) => inDay(t.ts));
  const kCreated = src.kanban.created.filter((t) => inDay(t.ts));
  const kMoved = src.kanban.moved.filter((t) => inDay(t.ts));
  const endedRuns = tasks.filter(taskEnded);
  const linked = new Set(endedRuns.map((r) => r.kanbanTaskId).filter(Boolean));
  const kanbanUnlinked = kCompleted.filter((t) => !linked.has(t.id));
  const projectName = (pid: string, title?: string) =>
    resolveProject({ label: title, kanbanProject: src.kanban.projectName(pid) });

  // ── Incidents, reports ─────────────────────────────────────────────────────
  const incidents = src.incidents.filter((i) => inDay(i.ts));
  const reports = src.reports.filter((r) => inDay(r.ts));
  const failedRuns = endedRuns.filter((r) => r.outcome === "failed");

  // ── Score ──────────────────────────────────────────────────────────────────
  const verifiedRunIds = new Set(
    endedRuns.filter((r) => r.outcome === "verified").map((r) => r.runId),
  );
  const deploysUncredited = deploys.filter((d) => !d.runId || !verifiedRunIds.has(d.runId)).length;
  const pts = scorePoints({
    runs: [...endedRuns, ...tasks.filter((t) => t.outcome === "running")],
    rework: dayRuns.filter((r) => r.rework).length,
    deploysUncredited,
    kanbanUnlinked: kanbanUnlinked.length,
    commits: plainCommits,
    incidents: incidents.length,
  });
  const score = finalizeScore(pts.net, baselineFrom(previousNets), pts.components);

  // ── Highlights ─────────────────────────────────────────────────────────────
  const acc: Accomplishment[] = [];
  for (const r of endedRuns) {
    if (r.outcome !== "verified") continue;
    acc.push({
      title: r.label,
      project: r.project,
      kind: "run",
      ref: r.runId,
      link: runLink(r.runId),
      weight: round(10 * (1 + sizeBonus(r)), 1),
      ts: r.end ?? r.start,
    });
  }
  for (const d of deploys) {
    acc.push({
      title: `${d.target}${d.ref ? ` ${d.ref}` : ""}: ${d.label}`,
      project: dayRuns.find((r) => r.runId === d.runId)?.project ?? "Other",
      kind: "deploy",
      ref: d.runId,
      link: d.runId ? runLink(d.runId) : undefined,
      weight: 9,
      ts: d.ts,
    });
  }
  for (const t of kanbanUnlinked) {
    acc.push({
      title: t.title,
      project: projectName(t.projectId, t.title),
      kind: "kanban",
      ref: t.id,
      link: `/projects`,
      weight: 3,
      ts: t.ts,
    });
  }
  for (const c of commits.filter((c) => c.merge).slice(0, 8)) {
    acc.push({
      title: `${c.repo}: ${c.subject}`,
      project: c.project,
      kind: "merge",
      ref: c.sha,
      weight: 2,
      ts: c.ts,
    });
  }
  acc.sort((a, b) => b.weight - a.weight || b.ts - a.ts);

  const inProgress = [
    ...tasks
      .filter((r) => r.outcome === "running")
      .map((r) => ({ title: r.label, project: r.project, runId: r.runId, since: r.start })),
    ...src.kanban.inProgress
      .filter((t) => inDay(t.ts) && !dayRuns.some((r) => r.kanbanTaskId === t.id))
      .map((t) => ({
        title: t.title,
        project: projectName(t.projectId, t.title),
        taskId: t.id,
        since: t.ts,
      })),
  ].slice(0, 16);

  const reasonFor = (r: DayRun) =>
    r.outcome === "needs_you"
      ? "Needs your input or is blocked"
      : r.outcome === "failed"
        ? "Failed"
        : "Finished, not verified";
  const needsYou = endedRuns
    .filter((r) => r.outcome === "needs_you" || r.outcome === "unverified")
    .sort(
      (a, b) =>
        (a.outcome === "needs_you" ? -1 : 0) - (b.outcome === "needs_you" ? -1 : 0) ||
        (b.end ?? 0) - (a.end ?? 0),
    )
    .slice(0, 16)
    .map((r) => ({
      title: r.label,
      project: r.project,
      runId: r.runId,
      reason: reasonFor(r),
      ts: r.end ?? r.start,
    }));

  const activeHours = hours.filter(
    (h) => h.agentMinutes > 0.5 || h.messages > 0 || h.commits > 0,
  ).length;
  const stamps = [
    ...dayRuns.map((r) => Math.max(r.start, ds)),
    ...dayRuns.map((r) => Math.min(r.end ?? now, de - 1)),
    ...commits.map((c) => c.ts),
  ].filter((t) => t >= ds && t < de);

  const roundHours = hours.map((h) => ({
    ...h,
    agentMinutes: round(h.agentMinutes, 1),
    costUsd: round(h.costUsd, 3),
    tokens: Math.round(h.tokens),
  }));

  return {
    v: 1,
    date,
    generatedAt: now,
    partial: isToday,
    totals: {
      runs: endedRuns.length + tasks.filter((t) => t.outcome === "running").length,
      runsStarted: hours.reduce((s, h) => s + h.runsStarted, 0),
      verified: endedRuns.filter((r) => r.outcome === "verified").length,
      unverified: endedRuns.filter((r) => r.outcome === "unverified").length,
      failed: failedRuns.length,
      needsYou: endedRuns.filter((r) => r.outcome === "needs_you").length,
      running: tasks.filter((t) => t.outcome === "running").length,
      rework: dayRuns.filter((r) => r.rework).length,
      agentMinutes: round(
        dayRuns.reduce((s, r) => s + r.minutes, 0),
        1,
      ),
      activeHours,
      firstActivity: stamps.length ? Math.min(...stamps) : undefined,
      lastActivity: stamps.length ? Math.max(...stamps) : undefined,
      costUsd: round(cliCost + gatewayCost),
      cliCostUsd: round(cliCost),
      gatewayCostUsd: round(gatewayCost),
      tokensIn: Math.round(tokensIn),
      tokensOut: Math.round(tokensOut),
      tokensCached: Math.round(tokensCached),
      commits: plainCommits,
      merges: commits.length - plainCommits,
      reposTouched: repoMap.size,
      deploys: deploys.length,
      kanbanCompleted: kCompleted.length,
      kanbanCreated: kCreated.length,
      kanbanMoved: kMoved.length,
      chatMessages,
      voiceTurns,
      telegramSends,
      reports: reports.length,
      incidents: incidents.length,
      oomKills: incidents.filter((i) => i.kind === "oom").length,
      workEvents: src.workEvents[date] ?? 0,
    },
    byProject: finishBuckets(byProject, 24),
    byBackend: finishBuckets(byBackend),
    byAgent: finishBuckets(byAgent),
    byCategory: finishBuckets(byCategory),
    hours: roundHours,
    repos: [...repoMap.values()].sort((a, b) => b.commits + b.merges - (a.commits + a.merges)),
    runs: dayRuns.sort((a, b) => a.start - b.start).slice(-400),
    deploys: deploys.slice(0, 40),
    accomplishments: acc.slice(0, 12),
    inProgress,
    needsYou,
    kanban: {
      completed: kCompleted.slice(0, 40).map((t) => ({
        id: t.id,
        title: t.title,
        project: projectName(t.projectId, t.title),
        ts: t.ts,
      })),
    },
    commitsList: commits
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 80)
      .map((c) => ({ repo: c.repo, sha: c.sha, subject: c.subject, ts: c.ts, merge: c.merge })),
    reports: reports.slice(0, 30),
    incidents: incidents.slice(0, 30),
    channels: [...channels.values()]
      .map((c) => ({ ...c, costUsd: round(c.costUsd) }))
      .sort((a, b) => b.messages - a.messages),
    score,
  };
}

export function indexEntry(r: DayRollup): DayIndexEntry {
  return {
    date: r.date,
    score: r.score.value,
    grade: r.score.grade,
    net: r.score.net,
    verified: r.totals.verified,
    unverified: r.totals.unverified,
    failed: r.totals.failed,
    runs: r.totals.runs,
    commits: r.totals.commits,
    deploys: r.totals.deploys,
    costUsd: r.totals.costUsd,
    agentMinutes: r.totals.agentMinutes,
    kanbanCompleted: r.totals.kanbanCompleted,
    activeHours: r.totals.activeHours,
    projects: r.byProject.slice(0, 8).map((p) => ({ name: p.name, minutes: p.minutes })),
    categories: r.byCategory.map((c) => ({ name: c.name, minutes: c.minutes })),
  };
}

export function readDay(date: string, base = defaultStateDir()): DayRollup | null {
  return readJson<DayRollup>(path.join(dailyDir(base), `${date}.json`));
}

export function readIndex(base = defaultStateDir()): DayIndexEntry[] {
  return readJson<{ days: DayIndexEntry[] }>(path.join(dailyDir(base), "index.json"))?.days ?? [];
}

export interface RollupOptions {
  from: string;
  to: string;
  now?: number;
  base?: string;
  config?: DailyReviewConfig;
  log?: (msg: string) => void;
}

/** Recompute [from, to] and persist. Returns the rebuilt days. */
export async function rollupRange(opts: RollupOptions): Promise<DayRollup[]> {
  const base = opts.base ?? defaultStateDir();
  const now = opts.now ?? Date.now();
  const cfg = opts.config ?? loadConfig(base);
  const log = opts.log ?? (() => {});
  const to = opts.to > today(now) ? today(now) : opts.to;
  const days = daysBetween(opts.from, to);
  if (!days.length) return [];
  const fromMs = dayStart(days[0]!);
  const toMs = dayEnd(days[days.length - 1]!);

  const cache = loadCache(base);
  const cursors = new Map(Object.entries(cache.cursors));
  const t0 = Date.now();
  const kanban = loadKanban(base, fromMs, toMs);
  const runs = await loadRuns({ stateDir: base, fromMs, toMs, now, kanban, cursors });
  log(`runs: ${runs.length} (${Date.now() - t0} ms)`);
  const sessions = await scanSessions(base, fromMs, cache.sessions);
  log(`sessions: ${Object.keys(sessions).length} files`);
  const repos = discoverRepos(cfg.git.roots, cfg.git.extraRepos, cfg.git.exclude);
  const commits = await loadCommits(repos, fromMs, toMs);
  log(`git: ${repos.length} repos, ${commits.length} commits`);
  const reports = listReports(base, fromMs, toMs);
  const incidents = await loadIncidents(base, fromMs, toMs);
  const workEvents = countWorkEvents(base, days);
  const src: Sources = { runs, kanban, commits, reports, incidents, sessions, workEvents };

  // Baseline needs the 14 days before each day: seed from disk.
  const nets = new Map<string, number>();
  for (const e of readIndex(base)) nets.set(e.date, e.net);
  const out: DayRollup[] = [];
  for (const d of days) {
    const prev: number[] = [];
    for (let i = 1; i <= 14; i++) {
      const n = nets.get(addDays(d, -i));
      if (typeof n === "number") prev.push(n);
    }
    const r = buildDay(d, src, now, prev);
    const existing = readDay(d, base);
    if (existing?.summary) r.summary = existing.summary;
    nets.set(d, r.score.net);
    out.push(r);
  }

  // Persist days, index, mirror and cache.
  const dir = dailyDir(base);
  fs.mkdirSync(dir, { recursive: true });
  const mirror = filesMirrorDir(base);
  for (const r of out) {
    writeJsonAtomic(path.join(dir, `${r.date}.json`), r);
    writeJsonAtomic(path.join(mirror, "days", `${r.date}.json`), r);
  }
  writeIndex(base, out.map(indexEntry));
  // Keep cursors only for runs that might still change or are cheap to keep.
  cache.cursors = Object.fromEntries(cursors);
  cache.sessions = sessions;
  writeJsonAtomic(path.join(cacheDir(base), CACHE_FILE), cache);
  return out;
}

export function writeIndex(base: string, updated: DayIndexEntry[]): DayIndexEntry[] {
  const map = new Map(readIndex(base).map((e) => [e.date, e]));
  for (const e of updated) map.set(e.date, e);
  const days = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  const payload = { generatedAt: Date.now(), days };
  writeJsonAtomic(path.join(dailyDir(base), "index.json"), payload);
  writeJsonAtomic(path.join(filesMirrorDir(base), "index.json"), payload);
  return days;
}

/** Persist a single (already built) day, e.g. after attaching a summary. */
export function saveDay(r: DayRollup, base = defaultStateDir()): void {
  writeJsonAtomic(path.join(dailyDir(base), `${r.date}.json`), r);
  writeJsonAtomic(path.join(filesMirrorDir(base), "days", `${r.date}.json`), r);
}

/** Earliest day any run store knows about (for backfill). */
export function earliestDataDay(base = defaultStateDir()): string {
  try {
    const fd = fs.openSync(path.join(base, "subagents", "spawn-ledger.ndjson"), "r");
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (const l of lines) {
      const ts = /"ts":(\d{12,})/.exec(l)?.[1];
      // Skip the ledger's smoke-test line.
      if (ts && !l.includes("smoke-test")) return dayKey(Number(ts));
    }
  } catch {
    /* fall through */
  }
  return addDays(today(), -30);
}
