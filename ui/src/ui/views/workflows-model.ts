/**
 * Workflows view — pure, DOM-free helpers (status derivation, step parsing,
 * time formatting). Kept separate so they can be unit-tested in node.
 */

import type { WorkflowRun, WorkflowsState } from "../controllers/workflows";

export type WfFilter = "all" | "loops" | "oneshot" | "running" | "failed" | "notion";
export type WfStatus = "running" | "paused" | "failed" | "ok" | "idle";

type RunsAndDaemons = Pick<WorkflowsState, "recentRuns" | "liveDaemons">;

export function runsFor(ws: RunsAndDaemons, id: string): WorkflowRun[] {
  return (ws.recentRuns ?? []).filter((r) => r.workflowId === id);
}

export function daemonFor(ws: RunsAndDaemons, id: string) {
  return (ws.liveDaemons ?? []).find((d) => d.workflowId === id && !d.stopped);
}

export function statusOf(ws: RunsAndDaemons, wf: { id: string }): WfStatus {
  const d = daemonFor(ws, wf.id);
  if (d) return d.paused ? "paused" : "running";
  const last = runsFor(ws, wf.id)[0];
  if (!last) return "idle";
  if (last.status === "running" || last.status === "pending") return "running";
  if (last.status === "paused") return "paused";
  if (last.status === "failed" || last.status === "timeout") return "failed";
  if (last.status === "completed") return "ok";
  return "idle";
}

export const STATUS_LABEL: Record<WfStatus, string> = {
  running: "Running",
  paused: "Paused",
  failed: "Failed",
  ok: "Healthy",
  idle: "Ready",
};

export function ago(iso?: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function runDurationMs(r: WorkflowRun): number | null {
  const a = Date.parse(r.startedAt);
  const b = r.finishedAt ? Date.parse(r.finishedAt) : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function cleanMd(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function stepLabel(raw: string): string {
  const text = cleanMd(raw);
  const first = text.split(/(?<=[.:!?])\s/)[0] ?? text;
  const pick = first.length >= 4 ? first : text;
  return pick.length > 72 ? `${pick.slice(0, 70).trimEnd()}…` : pick;
}

/** Top-level steps of a workflow body: numbered items → H2/H3 → bullets. */
export function parseSteps(body: string): string[] {
  const lines = (body ?? "").split("\n");
  const numbered = lines.map((l) => /^\d+[.)]\s+(.+)/.exec(l)?.[1]).filter((s): s is string => !!s?.trim());
  if (numbered.length) return numbered.map(stepLabel);
  const heads = lines
    .map((l) => /^#{2,3}\s+(.+)/.exec(l)?.[1])
    .filter((s): s is string => !!s?.trim());
  if (heads.length) return heads.map(stepLabel);
  const bullets = lines.map((l) => /^[-*]\s+(.+)/.exec(l)?.[1]).filter((s): s is string => !!s?.trim());
  return bullets.map(stepLabel);
}

/** Rough step count from the flattened 200-char list preview. */
export function previewStepCount(preview: string): { n: number; more: boolean } {
  const p = preview ?? "";
  let n = (p.match(/(?:^|\s)\d+[.)]\s+\S/g) ?? []).length;
  if (!n) n = (p.match(/(?:^|\s)#{2,3}\s+\S/g) ?? []).length;
  return { n, more: p.length >= 195 && n > 0 };
}

