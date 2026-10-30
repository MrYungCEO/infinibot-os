/**
 * Exit classifier — decides what a finished CLI process actually means.
 *
 *   complete     RESULT block with status "done" (still subject to review)
 *   blocked      RESULT status "blocked"
 *   needs_input  RESULT status "needs_input"
 *   premature    exited 0 but the work is visibly unfinished: no RESULT block
 *                and the last message says it is waiting / will do more, or
 *                background tasks were still running, or plan items remain
 *   failed       non-zero exit / crash / killed with no usable RESULT
 *   no_result    exited 0, no RESULT block, but nothing suggests it stopped
 *                early (legacy agents) — reviewed from transcript heuristics
 *
 * Premature runs are resumed on the same session (see pipeline.ts).
 */

import { parseResultBlock, type RunResult } from "./contract.js";
import type { TranscriptDigest } from "./transcript.js";

export type ExitClass =
  | "complete"
  | "blocked"
  | "needs_input"
  | "premature"
  | "failed"
  | "no_result"
  /** Assigned by the pipeline: the attempt died with a gateway restart / could not start. */
  | "interrupted";

export interface ExitClassification {
  kind: ExitClass;
  reasons: string[];
  result: RunResult | null;
}

/** Final-message phrasing that means "I'm not done yet". */
const WAITING_RE =
  /\b(i'?ll|i will|i'?m going to|let me|going to|now i'?ll|next,? i'?ll|i'?ll now)\s+(wait|check|monitor|poll|run|continue|verify|look|test|re-?run|finish|then)\b|\bwait(ing)? for (the )?(background|notification|build|tests?|run|results?|it|task)\b|\bonce (it|the (build|tests?|run|job|task))\b.{0,40}\b(finish|complete|done)|\b(still running|in the background|in progress|will report back|stand by|hold on)\b/i;

/** Final-message phrasing that lists outstanding plan items. */
const UNFINISHED_PLAN_RE =
  /(^|\n)\s*(- \[ \]|☐|todo:|remaining( steps| work)?:|next steps?:\s*\n\s*(1\.|-))/i;

export interface ClassifyInput {
  exitCode: number | null;
  killed?: boolean;
  digest: TranscriptDigest;
  /** Extra text (e.g. SessionInfo.output) to scan for a RESULT block. */
  extraText?: string;
}

function failureDetail(extraText?: string): string | null {
  const raw = extraText?.trim();
  if (!raw) return null;
  let detail = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const eventError = event.error;
      const candidate =
        typeof eventError === "object" && eventError !== null
          ? (eventError as Record<string, unknown>).message
          : typeof eventError === "string"
            ? eventError
            : event.message;
      if (typeof candidate === "string" && candidate.trim()) {
        try {
          const nested = JSON.parse(candidate) as { error?: { message?: unknown } };
          detail =
            typeof nested.error?.message === "string" ? nested.error.message : candidate.trim();
        } catch {
          detail = candidate.trim();
        }
      }
    } catch {
      detail = trimmed;
    }
  }
  return detail ? detail.replace(/\s+/g, " ").slice(0, 240) : null;
}

export function classifyExit(input: ClassifyInput): ExitClassification {
  const { digest } = input;
  const reasons: string[] = [];
  const result =
    parseResultBlock(digest.finalText) ??
    parseResultBlock(digest.fullText) ??
    (input.extraText ? parseResultBlock(input.extraText) : null);
  const finalTail = digest.finalText.slice(-600);

  const pending = digest.pendingBackgroundTasks;
  if (pending.length > 0) {
    reasons.push(
      `${pending.length} background task(s) were still running when the run ended: ${pending
        .map((t) => t.description || t.id)
        .slice(0, 3)
        .join("; ")}`,
    );
  }
  if (digest.killedAfterResult.length > 0 && pending.length === 0) {
    reasons.push(`${digest.killedAfterResult.length} background task(s) were killed at exit`);
  }

  if (result) {
    if (result.status === "blocked") return { kind: "blocked", reasons, result };
    if (result.status === "needs_input") return { kind: "needs_input", reasons, result };
    // A "done" RESULT with background work still running is still premature —
    // whatever that work was checking never got looked at.
    if (pending.length > 0) {
      return { kind: "premature", reasons, result };
    }
    return { kind: "complete", reasons, result };
  }

  const crashed = input.killed === true || (input.exitCode !== null && input.exitCode !== 0);
  if (crashed || (digest.resultIsError && input.exitCode !== 0)) {
    const detail = failureDetail(input.extraText);
    if (detail) reasons.push(`coding agent error: ${detail}`);
    reasons.push(
      input.killed
        ? "the process was killed (timeout or stop)"
        : input.exitCode === 127 && !detail
          ? "the coding agent couldn't start (exit code 127: its CLI isn't installed here). No coding agent is set up in this workspace yet — connect one (Claude Code / OpenCode / Codex) under Settings → Connect your AI to run code tasks."
          : `the process exited with code ${input.exitCode}`,
    );
    return { kind: "failed", reasons, result: null };
  }

  reasons.push("no RESULT block in the final message");
  if (WAITING_RE.test(finalTail)) {
    reasons.push(
      `the last message says it is still waiting / about to do more: "${finalTail.trim().slice(-160)}"`,
    );
  }
  if (UNFINISHED_PLAN_RE.test(finalTail)) {
    reasons.push("the last message lists unfinished plan items");
  }
  if (!digest.finalText.trim()) {
    reasons.push("the run produced no final message");
  }
  if (input.exitCode === null && !digest.sawResultEvent) {
    reasons.push("no exit code and no end-of-run event");
  }
  // Anything beyond "no RESULT block" is positive evidence of an early stop.
  if (reasons.length > 1) return { kind: "premature", reasons, result: null };
  return { kind: "no_result", reasons, result: null };
}
