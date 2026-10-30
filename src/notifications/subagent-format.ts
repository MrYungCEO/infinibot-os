/**
 * Human-readable formatting helpers for sub-agent notifications.
 *
 * Old notifications surfaced bare runId-like strings ("subagent_spawn
 * coder-mobile-foo-bar-x9y2") with no project hint, no task context, and
 * no outcome detail. These helpers turn a runId / label / task / outcome
 * tuple into a friendly title + 1-line summary the Alerts page can render
 * straight onto a glass row.
 *
 * All functions are pure and side-effect free so they can also be used
 * by `subagent-announce.ts` when building the trigger message back to the
 * main agent.
 */

import type { NotificationSeverity } from "./history-store.js";

const RUNID_NOISE_RE = /^(coder|subagent|claude|opencode|codex)[-_]/i;
const HEX_TAIL_RE = /[-_][a-z0-9]{4,8}$/i;
const WHITESPACE_RE = /\s+/g;

/**
 * Format a millisecond duration as a short human string ("4m 12s", "32s",
 * "2h 5m"). Returns `undefined` if the input isn't a finite positive number.
 */
export function formatDurationHuman(ms?: number): string | undefined {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return undefined;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Strip runId-style noise off a label. `coder-mobile-foo-bar-x9y2` becomes
 * `Mobile foo bar`; a clean human label is returned unchanged.
 */
export function humanizeSubagentLabel(raw?: string | null, fallback?: string): string {
  const seed = (raw ?? "").trim();
  if (!seed) return fallback?.trim() || "Sub-agent";
  // Looks human already (contains a space, no leading runId prefix, no hex tail)
  const looksHuman = /\s/.test(seed) && !RUNID_NOISE_RE.test(seed) && !HEX_TAIL_RE.test(seed);
  if (looksHuman) return seed.slice(0, 80);

  let body = seed
    .replace(RUNID_NOISE_RE, "")
    .replace(HEX_TAIL_RE, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!body) return fallback?.trim() || "Sub-agent";
  body = body.charAt(0).toUpperCase() + body.slice(1);
  return body.slice(0, 80);
}

/**
 * Return the first non-empty sentence/line of `task`, trimmed to `maxLen`.
 * Strips markdown bullets, code fences, and collapses internal whitespace.
 */
export function subagentTaskExcerpt(task?: string | null, maxLen = 110): string {
  if (!task) return "";
  const cleaned = String(task)
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s>]+/, "").trim())
    .find((line) => line.length > 0);
  if (!cleaned) return "";
  const collapsed = cleaned.replace(WHITESPACE_RE, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
}

export type SubagentPhase = "spawn" | "complete" | "fail" | "timeout" | "cancel";

export interface SubagentTitleInput {
  phase: SubagentPhase;
  label?: string | null;
  runId?: string | null;
  sessionKey?: string | null;
  task?: string | null;
}

/**
 * Build a short, scannable title from a phase + label/task/runId. Examples:
 *   "Mobile Voice: federation device picker — running"
 *   "Sub-agent finished: Mobile Library glassmorphism revamp"
 *   "Sub-agent failed: API refactor"
 */
export function formatSubagentNotificationTitle(input: SubagentTitleInput): string {
  const labelSource = input.label || input.task || input.sessionKey || input.runId || "";
  const label = humanizeSubagentLabel(labelSource, "Sub-agent");
  switch (input.phase) {
    case "spawn":
      return `${label} — running`;
    case "complete":
      return `Sub-agent finished: ${label}`;
    case "fail":
      return `Sub-agent failed: ${label}`;
    case "timeout":
      return `Sub-agent timed out: ${label}`;
    case "cancel":
      return `Sub-agent cancelled: ${label}`;
    default:
      return label;
  }
}

export interface SubagentSummaryInput {
  phase: SubagentPhase;
  task?: string | null;
  durationMs?: number;
  filesTouchedCount?: number;
  summary?: string | null;
  errorMessage?: string | null;
  projectHint?: string | null;
}

/**
 * Build a 1-line description that fits a notification row body. Combines a
 * task excerpt, runtime, and outcome detail. Drops empty pieces so we never
 * emit a stray "• •" separator.
 */
export function formatSubagentNotificationSummary(input: SubagentSummaryInput): string {
  const pieces: string[] = [];
  const duration = formatDurationHuman(input.durationMs);

  if (input.phase === "spawn") {
    const excerpt = subagentTaskExcerpt(input.task, 110);
    if (excerpt) pieces.push(excerpt);
    if (input.projectHint) pieces.push(input.projectHint);
  } else {
    // Completion / failure / timeout / cancel
    if (duration) {
      pieces.push(
        input.phase === "complete"
          ? `completed in ${duration}`
          : input.phase === "fail"
            ? `failed after ${duration}`
            : input.phase === "timeout"
              ? `timed out after ${duration}`
              : `stopped after ${duration}`,
      );
    }
    if (typeof input.filesTouchedCount === "number" && input.filesTouchedCount > 0) {
      pieces.push(
        `${input.filesTouchedCount} file${input.filesTouchedCount === 1 ? "" : "s"} changed`,
      );
    }
    const summary = (input.summary ?? "").trim();
    if (summary) {
      pieces.push(subagentTaskExcerpt(summary, 110));
    } else if (input.phase === "fail" && input.errorMessage) {
      pieces.push(subagentTaskExcerpt(input.errorMessage, 110));
    } else if (!summary && input.task) {
      // Fall back to task excerpt so the row still says what the agent worked on.
      pieces.push(subagentTaskExcerpt(input.task, 90));
    }
  }

  return pieces.filter(Boolean).join(" · ");
}

/**
 * Map a sub-agent lifecycle phase + outcome to a notification severity.
 *   spawn  → info
 *   complete → success
 *   fail   → error
 *   timeout → warn
 *   cancel → info
 */
export function severityForSubagentPhase(
  phase: SubagentPhase,
  outcome?: "ok" | "error" | "timeout" | "unknown",
): NotificationSeverity {
  if (outcome === "timeout") return "warn";
  if (outcome === "error") return "error";
  switch (phase) {
    case "spawn":
      return "info";
    case "complete":
      return "success";
    case "fail":
      return "error";
    case "timeout":
      return "warn";
    case "cancel":
      return "info";
    default:
      return "info";
  }
}
