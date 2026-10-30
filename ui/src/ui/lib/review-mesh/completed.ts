/**
 * Recently-completed agents on the mesh — pure model.
 *
 * Source: `verification.list` completion records (src/verification/store.ts
 * CompletionRecord) — the one place that knows a finished run's verdict,
 * RESULT summary, commits, files changed and screenshots. Screenshot thumbs are
 * joined from the gallery index (verification.screenshots.list) by runId.
 */

import type { ReviewThreadSummary, ScreenshotEntry } from "./types";

/** Structural subset of CompletionRecord the UI reads (all optional-safe). */
export interface CompletionRecordLite {
  runId: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
  label?: string;
  task?: string;
  backend?: string | null;
  model?: string | null;
  startedAt?: number;
  updatedAt?: number;
  terminalAt?: number | null;
  state?: string;
  round?: number;
  attempts?: unknown[];
  result?: {
    status?: string;
    summary?: string;
    commits?: string[];
    files_changed?: string[];
    screenshots?: string[];
    open_issues?: string[];
  } | null;
  review?: {
    verdict?: string;
    reasons?: string[];
    screenshots?: string[];
    changedFiles?: string[];
    commits?: string[];
  } | null;
  tags?: Record<string, string>;
}

export type CompletedVerdict = "VERIFIED" | "UNVERIFIED" | "FAILED" | "NEEDS_OWNER" | "ACCEPTED" | "REJECTED";
export type DeployState = "live" | "merged" | "restart_pending" | "not_deployed" | null;

export interface CompletedEntry {
  runId: string;
  sessionKey: string;
  label: string;
  verdict: CompletedVerdict;
  state: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  summary: string;
  files: number;
  commits: number;
  deploy: DeployState;
  backend: string | null;
  attempts: number;
  thumbUrl: string | null;
  screenshots: number;
  hasThread: boolean;
}

const TERMINAL = new Set(["verified", "unverified", "failed", "stalled", "blocked", "needs_input", "needs_owner", "accepted", "rejected"]);

export function isTerminalState(state: string | undefined): boolean {
  return TERMINAL.has(String(state ?? ""));
}

export function completedVerdictOf(rec: Pick<CompletionRecordLite, "state" | "review">): CompletedVerdict {
  switch (rec.state) {
    case "verified":
      return "VERIFIED";
    case "accepted":
      return "ACCEPTED";
    case "rejected":
      return "REJECTED";
    case "failed":
      return "FAILED";
    case "needs_owner":
      return "NEEDS_OWNER";
    default:
      return rec.review?.verdict === "FAILED" ? "FAILED" : "UNVERIFIED";
  }
}

export const VERDICT_TONE: Record<CompletedVerdict, "green" | "amber" | "red" | "magenta" | "slate"> = {
  VERIFIED: "green",
  ACCEPTED: "green",
  UNVERIFIED: "amber",
  FAILED: "red",
  REJECTED: "red",
  NEEDS_OWNER: "magenta",
};

export const VERDICT_TEXT: Record<CompletedVerdict, string> = {
  VERIFIED: "Verified",
  ACCEPTED: "Accepted",
  UNVERIFIED: "Unverified",
  FAILED: "Failed",
  REJECTED: "Rejected",
  NEEDS_OWNER: "Needs owner",
};

/**
 * Deploy state. An explicit `tags.deploy` wins; otherwise a conservative read
 * of the RESULT summary / open issues (agents say "deployed live", "restart
 * pending", "merged into …", "not deployed"). Null when nothing is said.
 */
export function deployStateOf(rec: Pick<CompletionRecordLite, "tags" | "result">): DeployState {
  const tag = rec.tags?.deploy?.toLowerCase().replace(/[\s-]+/g, "_");
  if (tag === "live" || tag === "merged" || tag === "restart_pending" || tag === "not_deployed") return tag;
  const text = [rec.result?.summary ?? "", ...(rec.result?.open_issues ?? [])].join(" \n ").toLowerCase();
  if (!text.trim()) return null;
  if (/\b(not|never|wasn'?t|isn'?t)\s+(yet\s+)?(deployed|live|merged|restarted)\b|\bnot\s+deployed\b|\bundeployed\b/.test(text)) return "not_deployed";
  if (/\brestart\s+(is\s+)?(pending|required|needed)\b|\bneeds?\s+(a\s+)?restart\b|\bawaiting\s+restart\b/.test(text)) return "restart_pending";
  if (/\b(deployed|now live|live on|went live|is live|rolled out|shipped to prod)/.test(text)) return "live";
  if (/\bmerged\b/.test(text)) return "merged";
  return null;
}

export const DEPLOY_TEXT: Record<Exclude<DeployState, null>, string> = {
  live: "Live",
  merged: "Merged",
  restart_pending: "Restart pending",
  not_deployed: "Not deployed",
};

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function firstLine(s: string, max = 140): string {
  const line = s.split(/\n|(?<=[.!?])\s/)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function buildCompletedEntries(
  records: readonly CompletionRecordLite[],
  opts: {
    now: number;
    windowMs?: number;
    screenshots?: readonly ScreenshotEntry[];
    threads?: ReadonlyMap<string, Pick<ReviewThreadSummary, "messageCount">> | null;
    limit?: number;
  },
): CompletedEntry[] {
  const { now, windowMs = 24 * 3_600_000, screenshots = [], threads = null, limit = 60 } = opts;
  const thumbByRun = new Map<string, ScreenshotEntry>();
  const shotCount = new Map<string, number>();
  for (const s of screenshots) {
    shotCount.set(s.runId, (shotCount.get(s.runId) ?? 0) + 1);
    const prev = thumbByRun.get(s.runId);
    if (!prev || s.ts > prev.ts) thumbByRun.set(s.runId, s);
  }
  const out: CompletedEntry[] = [];
  for (const r of records) {
    if (!r?.runId || !isTerminalState(r.state)) continue;
    const finishedAt = Number(r.terminalAt || r.updatedAt || 0);
    if (!finishedAt || now - finishedAt > windowMs) continue;
    const startedAt = Number(r.startedAt || 0);
    const files = new Set([...(r.result?.files_changed ?? []), ...(r.review?.changedFiles ?? [])]);
    const commits = new Set([...(r.result?.commits ?? []), ...(r.review?.commits ?? [])]);
    const shots = new Set([...(r.result?.screenshots ?? []), ...(r.review?.screenshots ?? [])]);
    const thumb = thumbByRun.get(r.runId);
    out.push({
      runId: r.runId,
      sessionKey: r.childSessionKey || r.runId,
      label: r.label || r.task?.slice(0, 80) || r.runId,
      verdict: completedVerdictOf(r),
      state: r.state ?? "",
      startedAt,
      finishedAt,
      durationMs: startedAt ? finishedAt - startedAt : 0,
      summary: firstLine(r.result?.summary || r.review?.reasons?.[0] || ""),
      files: files.size,
      commits: commits.size,
      deploy: deployStateOf(r),
      backend: r.backend ?? null,
      attempts: Array.isArray(r.attempts) ? r.attempts.length : 1,
      thumbUrl: thumb?.thumbUrl ?? null,
      screenshots: Math.max(shots.size, shotCount.get(r.runId) ?? 0),
      hasThread: Boolean(threads?.get(r.runId)?.messageCount),
    });
  }
  out.sort((a, b) => b.finishedAt - a.finishedAt);
  return out.slice(0, limit);
}

export type CompletedFilter = "all" | "verified" | "attention" | "failed";

export function filterCompleted(entries: readonly CompletedEntry[], f: { filter?: CompletedFilter; q?: string; windowMs?: number; now?: number }): CompletedEntry[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return entries.filter((e) => {
    if (f.windowMs && f.now && f.now - e.finishedAt > f.windowMs) return false;
    switch (f.filter ?? "all") {
      case "verified":
        if (e.verdict !== "VERIFIED" && e.verdict !== "ACCEPTED") return false;
        break;
      case "attention":
        if (e.verdict !== "UNVERIFIED" && e.verdict !== "NEEDS_OWNER") return false;
        break;
      case "failed":
        if (e.verdict !== "FAILED" && e.verdict !== "REJECTED") return false;
        break;
      default:
        break;
    }
    if (q && !`${e.label} ${e.summary} ${e.backend ?? ""} ${e.runId}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/**
 * Completion halo strength for a finished agent still on the map: full for the
 * first `holdMs`, then fades linearly to 0 at `lifeMs`.
 */
export function haloAlpha(finishedAt: number, now: number, holdMs = 90_000, lifeMs = 15 * 60_000): number {
  const age = now - finishedAt;
  if (!Number.isFinite(age) || age < 0) return 1;
  if (age <= holdMs) return 1;
  if (age >= lifeMs) return 0;
  return 1 - (age - holdMs) / (lifeMs - holdMs);
}
