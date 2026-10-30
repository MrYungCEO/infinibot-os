/**
 * Merge every sub-agent run store into one RunRecord per runId:
 *   spawn-ledger.ndjson   intent (label, task, backend, workdir, respawnOf) + run.ended
 *   runs.json             live registry (running runs, kanbanTaskId)
 *   history.json          recent finished runs (status, files touched)
 *   reviews.json          verifier verdicts (VERIFIED / UNVERIFIED / FAILED, evidence)
 *   run-reviews.json      per-run review cards (kanbanTaskId, backend, files)
 *   durable/<runId>/      meta.json, exit.code, stdout.log(.gz) → cost/tokens/RESULT
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  backendFromCommand,
  classifyCategory,
  detectDeploys,
  resolveProject,
} from "../classify.js";
import { parseResultBlock, parseRunLog, type LogCursor } from "../stream-log.js";
import type { RunOutcome, RunRecord } from "../types.js";
import { clean, readJson } from "../util.js";
import type { KanbanData } from "./kanban.js";

interface Partial_ {
  runId: string;
  label?: string;
  task?: string;
  kind?: string;
  backend?: string;
  workdir?: string;
  respawnOf?: string;
  startedAt?: number;
  endedAt?: number;
  ledgerOutcome?: string;
  ledgerError?: boolean;
  spawnFailed?: boolean;
  running?: boolean;
  historyStatus?: string;
  filesTouched?: number;
  kanbanTaskId?: string;
  verdict?: string;
  state?: string;
  reviewStatus?: string;
  reviewSummary?: string;
  reviewCommits?: number;
  reviewFiles?: number;
  exitCode?: number;
  exitAt?: number;
}

export interface RunSourceOptions {
  stateDir: string;
  fromMs: number;
  toMs: number;
  now: number;
  kanban: KanbanData;
  cursors: Map<string, LogCursor>;
}

function get(map: Map<string, Partial_>, runId: string): Partial_ {
  let p = map.get(runId);
  if (!p) {
    p = { runId };
    map.set(runId, p);
  }
  return p;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const numv = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

async function readLedger(file: string, map: Map<string, Partial_>): Promise<void> {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const id = str(o?.runId);
    if (!id || id === "smoke-test-run") continue;
    const p = get(map, id);
    if (o.event === "spawn.intent") {
      p.label = str(o.label) ?? p.label;
      p.task = typeof o.task === "string" ? o.task.slice(0, 600) : p.task;
      p.kind = str(o.kind) ?? p.kind;
      p.backend = str(o.backend) ?? p.backend;
      p.workdir = str(o.workdir) ?? p.workdir;
      p.respawnOf = str(o.respawnOfRunId) ?? p.respawnOf;
      p.startedAt = p.startedAt ?? numv(o.ts);
    } else if (o.event === "run.ended") {
      p.endedAt = numv(o.ts) ?? p.endedAt;
      p.ledgerOutcome =
        str(o.outcome) ?? (typeof o.outcome === "object" ? str(o.outcome?.status) : undefined);
      p.ledgerError = Boolean(o.error);
    } else if (o.event === "spawn.failed") {
      p.spawnFailed = true;
      p.endedAt = p.endedAt ?? numv(o.ts);
    }
  }
}

function readRegistry(stateDir: string, map: Map<string, Partial_>): void {
  const runs =
    readJson<{ runs?: Record<string, any> }>(path.join(stateDir, "subagents", "runs.json"))?.runs ??
    {};
  for (const r of Object.values(runs)) {
    const id = str(r?.runId);
    if (!id) continue;
    const p = get(map, id);
    p.label = p.label ?? str(r.label);
    p.task = p.task ?? (typeof r.task === "string" ? r.task.slice(0, 600) : undefined);
    p.startedAt = p.startedAt ?? numv(r.startedAt) ?? numv(r.createdAt);
    p.workdir = p.workdir ?? str(r.workdir);
    p.backend = p.backend ?? str(r.coderBackend);
    p.kanbanTaskId = p.kanbanTaskId ?? str(r.kanbanTaskId);
    if (numv(r.endedAt)) p.endedAt = p.endedAt ?? numv(r.endedAt);
    else p.running = true;
  }
  const hist =
    readJson<{ entries?: any[] }>(path.join(stateDir, "subagents", "history.json"))?.entries ?? [];
  for (const h of hist) {
    const id = str(h?.runId);
    if (!id) continue;
    const p = get(map, id);
    p.label = p.label ?? str(h.label);
    p.startedAt = p.startedAt ?? numv(h.startedAt);
    p.endedAt = p.endedAt ?? numv(h.endedAt);
    p.historyStatus = str(h.outcome?.status) ?? str(h.status);
    p.filesTouched = numv(h.filesTouchedCount) ?? p.filesTouched;
    p.kanbanTaskId = p.kanbanTaskId ?? str(h.kanbanTaskId);
    p.workdir = p.workdir ?? str(h.workdir);
    p.backend = p.backend ?? str(h.coderBackend);
  }
}

/** reviews.json is large (MBs); keep only the newest compact verdict per run. */
function readReviews(stateDir: string, map: Map<string, Partial_>): void {
  const rv =
    readJson<{ reviews?: any[] }>(path.join(stateDir, "subagents", "reviews.json"))?.reviews ?? [];
  const newest = new Map<string, { at: number; r: any }>();
  for (const r of rv) {
    const id = str(r?.runId);
    if (!id) continue;
    const at = numv(r.completion?.reviewedAt) ?? numv(r.completedAt) ?? 0;
    // Prefer verifier entries with a verdict; among them the newest wins.
    const rank = (r.completion?.verdict ? 1e15 : 0) + at;
    const prev = newest.get(id);
    if (!prev || rank >= prev.at) newest.set(id, { at: rank, r });
  }
  for (const [id, { r }] of newest) {
    const p = get(map, id);
    p.verdict = str(r.completion?.verdict);
    p.state = str(r.completion?.state);
    p.reviewStatus = str(r.status);
    p.reviewSummary = clean(r.summary ?? r.completion?.resultSummary, 300) || undefined;
    const ev: any[] = Array.isArray(r.completion?.evidence) ? r.completion.evidence : [];
    const commits = new Set(
      ev.filter((e) => e?.kind === "commit" && e?.status !== "fail").map((e) => e.ref),
    );
    p.reviewCommits = commits.size || undefined;
    p.reviewFiles = Array.isArray(r.filesTouched) ? r.filesTouched.length : undefined;
    p.label = p.label ?? str(r.label);
    p.endedAt = p.endedAt ?? numv(r.completedAt);
  }
  const rr =
    readJson<{ reviews?: any[] }>(path.join(stateDir, "subagents", "run-reviews.json"))?.reviews ??
    [];
  for (const r of rr) {
    const id = str(r?.runId);
    if (!id) continue;
    const p = get(map, id);
    p.kanbanTaskId = p.kanbanTaskId ?? str(r.kanbanTaskId);
    p.backend = p.backend ?? str(r.backend);
    p.label = p.label ?? str(r.title);
    p.startedAt = p.startedAt ?? numv(r.startedAt);
    p.endedAt = p.endedAt ?? numv(r.finishedAt);
    if (Array.isArray(r.filesTouched))
      p.filesTouched = Math.max(p.filesTouched ?? 0, r.filesTouched.length);
  }
}

function outcomeOf(p: Partial_, hasResult: boolean, resultStatus?: string): RunOutcome {
  const v = (p.verdict ?? "").toUpperCase();
  const s = (p.state ?? "").toLowerCase();
  if (v === "VERIFIED" || s === "verified") return "verified";
  if (v === "FAILED" || s === "failed" || p.spawnFailed) return "failed";
  if (["needs_owner", "needs_input", "blocked"].includes(s)) return "needs_you";
  if (!p.endedAt && p.running && p.exitCode === undefined) return "running";
  if (v === "UNVERIFIED" || s === "stalled" || s === "unverified") return "unverified";
  const rs = (resultStatus ?? "").toLowerCase();
  if (rs === "blocked" || rs === "needs_input") return "needs_you";
  if (p.exitCode !== undefined && p.exitCode !== 0 && !hasResult) return "failed";
  if (p.ledgerError || p.historyStatus === "error" || p.reviewStatus === "errored") return "failed";
  return "unverified";
}

function lastLogWrite(dir: string): number | undefined {
  for (const f of ["stdout.log", "exit.code"]) {
    try {
      return fs.statSync(path.join(dir, f)).mtimeMs;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

export async function loadRuns(opts: RunSourceOptions): Promise<RunRecord[]> {
  const { stateDir, fromMs, toMs, now, kanban, cursors } = opts;
  const map = new Map<string, Partial_>();
  await readLedger(path.join(stateDir, "subagents", "spawn-ledger.ndjson"), map);
  readRegistry(stateDir, map);
  readReviews(stateDir, map);

  const durable = path.join(stateDir, "subagents", "durable");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(durable);
  } catch {
    /* none */
  }
  for (const d of dirs) {
    const meta = readJson<any>(path.join(durable, d, "meta.json"));
    const id = str(meta?.runId) ?? d;
    const p = get(map, id);
    p.startedAt = p.startedAt ?? numv(meta?.startedAt);
    p.workdir = p.workdir ?? str(meta?.cwd);
    p.backend = p.backend ?? backendFromCommand(str(meta?.command)) ?? undefined;
    try {
      const ec = path.join(durable, d, "exit.code");
      const st = fs.statSync(ec);
      const code = Number.parseInt(fs.readFileSync(ec, "utf8").trim(), 10);
      // An empty exit.code (left by a gateway restart) is not an exit, and a
      // log written well after it means the run was resumed and is alive.
      let logAt = 0;
      try {
        logAt = fs.statSync(path.join(durable, d, "stdout.log")).mtimeMs;
      } catch {
        /* archived */
      }
      if (Number.isFinite(code) && logAt <= st.mtimeMs + 120_000) {
        p.exitCode = code;
        p.exitAt = st.mtimeMs;
      }
    } catch {
      /* still running or never wrote one */
    }
  }

  const records: RunRecord[] = [];
  for (const p of map.values()) {
    const start = p.startedAt;
    if (!start) continue;
    let end = p.endedAt ?? p.exitAt;
    // A registry end can be days late (cleanup sweeps): the last log write is
    // the truthful end of work for a finished run.
    const logMtime = lastLogWrite(path.join(durable, p.runId));
    if (end && logMtime && logMtime >= start && logMtime < end - 10 * 60_000) end = logMtime;
    const effectiveEnd = end ?? (p.running ? now : start);
    if (start >= toMs || effectiveEnd < fromMs) continue;

    // Durable log: parse (incrementally) only for runs in range.
    const dir = path.join(durable, p.runId);
    let cursor = cursors.get(p.runId) ?? null;
    if (fs.existsSync(dir)) {
      try {
        cursor = await parseRunLog(dir, cursor);
        if (cursor) cursors.set(p.runId, cursor);
      } catch {
        /* unreadable log */
      }
    }
    if (p.running && !p.endedAt && p.exitCode === undefined) {
      // Registry entries can outlive a dead process: only call it running
      // when its log moved (or it started) in the last 3 hours.
      let lastMove = start;
      try {
        lastMove = Math.max(lastMove, fs.statSync(path.join(dir, "stdout.log")).mtimeMs);
      } catch {
        /* no log */
      }
      if (now - lastMove > 3 * 3600_000) {
        p.running = false;
        p.endedAt = lastMove;
      }
    }
    const m = cursor?.metrics;
    const result = parseResultBlock(m?.finalText);
    const label = clean(p.label ?? p.task ?? p.runId, 140);
    const kTask = kanban.task(p.kanbanTaskId);
    const project = resolveProject({
      label,
      kanbanProject: kanban.projectName(kTask?.projectId),
      workdir: p.workdir,
    });
    const outcome = outcomeOf(p, Boolean(result), result?.status);
    const endTs = outcome === "running" ? undefined : (end ?? effectiveEnd);
    const deploys =
      outcome === "failed"
        ? []
        : detectDeploys(
            `${result?.text ?? ""}\n${p.reviewSummary ?? ""}`,
            p.runId,
            label,
            endTs ?? now,
          );
    const kind =
      p.kind ?? (p.runId.startsWith("verify-") ? "verify" : (p.runId.split("-")[0] ?? "coder"));
    records.push({
      runId: p.runId,
      label,
      kind,
      backend: p.backend ?? "unknown",
      project,
      category: classifyCategory(label, p.task),
      workdir: p.workdir,
      startedAt: start,
      endedAt: endTs,
      outcome,
      verdict: p.verdict,
      state: p.state,
      kanbanTaskId: p.kanbanTaskId,
      respawnOf: p.respawnOf,
      rootId: p.runId.replace(/(?:-c\d+)+$/, ""),
      costUsd: m?.costUsd ?? 0,
      tokensIn: m?.tokensIn ?? 0,
      tokensOut: m?.tokensOut ?? 0,
      tokensCached: m?.tokensCached ?? 0,
      model: m?.model,
      commits: Math.max(result?.commits.length ?? 0, p.reviewCommits ?? 0),
      files: Math.max(result?.files ?? 0, p.reviewFiles ?? 0, p.filesTouched ?? 0),
      deploys,
      telegramSends: m?.telegramSends ?? 0,
      summary: result?.summary || p.reviewSummary,
    });
  }
  // Continuation passes (-c2…) have no ledger intent: inherit the root's
  // label, project and category so the task reads as one thing.
  const byId = new Map(records.map((r) => [r.runId, r]));
  for (const r of records) {
    if (r.rootId === r.runId || r.label !== r.runId) continue;
    const root = byId.get(r.rootId) ?? (map.get(r.rootId)?.label ? null : undefined);
    const label = root?.label ?? clean(map.get(r.rootId)?.label, 140);
    if (!label) continue;
    r.label = label;
    r.project = root?.project ?? resolveProject({ label, workdir: r.workdir });
    r.category = root?.category ?? classifyCategory(label, map.get(r.rootId)?.task);
    for (const d of r.deploys) d.label = label;
  }
  return records;
}
