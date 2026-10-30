/**
 * Mirror a completion record into the existing reviews store
 * (`subagent_reviews_*`), so the Reviews/Oversight page, the agent focus
 * modal and the mobile feed show the verified-completion verdict without a
 * second data source.
 */

import { randomUUID } from "node:crypto";

import { getReviewByRunId, patchReview, upsertReview } from "../agents/reviews/index.js";
import type { AgentReview, ReviewCompletion, ReviewStatus } from "../agents/reviews/schema.js";
import type { CompletionRecord } from "./store.js";

export function completionOf(rec: CompletionRecord): ReviewCompletion | undefined {
  if (!rec.review) return undefined;
  return {
    verdict: rec.review.verdict,
    state: rec.state,
    reasons: rec.review.reasons,
    attempts: rec.attempts.length,
    screenshots: rec.review.screenshots,
    visualFiles: rec.review.visualFiles,
    evidence: rec.review.evidence.map((e) => ({
      kind: e.kind,
      ref: e.ref,
      status: e.status,
      detail: e.detail,
    })),
    resultSummary: rec.result?.summary,
    reviewedAt: rec.review.reviewedAt,
  };
}

function statusOf(rec: CompletionRecord): ReviewStatus {
  if (rec.state === "failed") return "errored";
  if (rec.state === "verified" || rec.state === "accepted") return "completed";
  if (rec.state === "rejected") return "aborted";
  return "partial";
}

export function mirrorCompletionIntoReviews(rec: CompletionRecord): AgentReview | undefined {
  const completion = completionOf(rec);
  if (!completion) return undefined;
  const existing = getReviewByRunId(rec.runId);
  const decision =
    rec.state === "accepted"
      ? ("approved" as const)
      : rec.state === "rejected"
        ? ("sent_back" as const)
        : undefined;
  if (existing) {
    return patchReview(rec.runId, {
      completion,
      ...(decision
        ? { decision, decidedAt: rec.decision?.at, decidedBy: rec.decision?.by ?? undefined }
        : {}),
    });
  }
  const summary =
    rec.result?.summary ||
    (rec.review?.reasons.length ? `Not verified: ${rec.review.reasons[0]}` : `Run ${rec.state}.`);
  return upsertReview({
    id: randomUUID(),
    runId: rec.runId,
    sessionKey: rec.childSessionKey,
    label: rec.label,
    status: statusOf(rec),
    summary: summary.slice(0, 1000),
    filesTouched: (rec.review?.changedFiles ?? []).slice(0, 200).map((p) => ({
      path: p,
      action: "modified" as const,
      linesAdded: 0,
      linesRemoved: 0,
    })),
    nextSteps: (rec.result?.open_issues ?? []).slice(0, 5),
    blockers:
      rec.state === "blocked" || rec.state === "needs_input" || rec.state === "needs_owner"
        ? (rec.result?.open_issues ?? []).slice(0, 5)
        : [],
    confidence:
      rec.review?.verdict === "VERIFIED"
        ? "high"
        : rec.review?.verdict === "FAILED"
          ? "low"
          : "medium",
    durationMs: Math.max(0, (rec.terminalAt ?? Date.now()) - rec.startedAt),
    completedAt: rec.terminalAt ?? Date.now(),
    source: "verifier",
    ...(decision
      ? { decision, decidedAt: rec.decision?.at, decidedBy: rec.decision?.by ?? undefined }
      : {}),
    completion,
  });
}
