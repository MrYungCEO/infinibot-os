/**
 * AI War Room — Visual Verifier
 *
 * Cross-agent review loop. After an agent produces output (code, design, copy),
 * other agents review it. Results are broadcast with visual indicators
 * (approve/reject/revise). The loop continues until consensus or CEO override.
 */

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  WarRoomSession,
  WarRoomAgentRole,
  WarRoomArtifact,
  VisualReviewRequest,
  VisualReview,
  ReviewDecision,
} from "./types.js";
import { getWarRoomBus } from "./message-bus.js";
import { getWarRoomStore } from "./orchestrator.js";
import { buildAgentContext } from "./agents.js";
import { WAR_ROOM_DEFAULT_MODEL } from "./agents.js";
import { collectAnthropicApiKeys } from "../agents/live-auth-keys.js";

// ─── Anthropic Client ─────────────────────────────────────────────────────────

function createAnthropicClient(): Anthropic {
  const keys = collectAnthropicApiKeys();
  const apiKey = keys[0] ?? process.env.ANTHROPIC_API_KEY ?? "";
  return new Anthropic({ apiKey });
}

// ─── Review Request Management ─────────────────────────────────────────────────

export function createReviewRequest(
  session: WarRoomSession,
  opts: {
    artifact: WarRoomArtifact;
    reviewerRoles: WarRoomAgentRole[];
    maxIterations?: number;
  },
): VisualReviewRequest {
  const store = getWarRoomStore();
  const request: VisualReviewRequest = {
    id: randomUUID(),
    sessionId: session.id,
    artifactId: opts.artifact.id,
    artifact: opts.artifact,
    reviewerRoles: opts.reviewerRoles,
    reviews: {
      ceo: undefined,
      cto: undefined,
      cmo: undefined,
      cfo: undefined,
      ops: undefined,
    },
    iteration: 1,
    maxIterations: opts.maxIterations ?? 3,
    createdAt: Date.now(),
  };

  store.reviewRequests.set(request.id, request);

  // Notify bus that review has been requested
  getWarRoomBus().publish({
    type: "review.requested",
    sessionId: session.id,
    payload: {
      reviewRequestId: request.id,
      artifact: opts.artifact,
      reviewerRoles: opts.reviewerRoles,
    },
    timestamp: Date.now(),
  });

  return request;
}

export function getReviewRequest(reviewRequestId: string): VisualReviewRequest | undefined {
  return getWarRoomStore().reviewRequests.get(reviewRequestId);
}

// ─── Review Execution ─────────────────────────────────────────────────────────

/** Run a single agent's review of an artifact */
export async function runAgentReview(
  session: WarRoomSession,
  reviewRequestId: string,
  reviewerRole: WarRoomAgentRole,
): Promise<VisualReview> {
  const store = getWarRoomStore();
  const request = store.reviewRequests.get(reviewRequestId);
  if (!request) throw new Error(`Review request not found: ${reviewRequestId}`);

  const agent = session.agents.find((a) => a.role === reviewerRole);
  if (!agent) throw new Error(`Agent not found for role: ${reviewerRole}`);

  const bus = getWarRoomBus();
  bus.publishMonitorHighlight(session.id, agent.monitorIndex, true);
  bus.publishAgentTurnStart(session.id, agent.role, agent.id, agent.monitorIndex);

  const client = createAnthropicClient();

  const reviewPrompt = buildReviewPrompt(request.artifact, reviewerRole, request.iteration);

  let reviewContent = "";
  try {
    const stream = client.messages.stream({
      model: agent.model ?? WAR_ROOM_DEFAULT_MODEL,
      max_tokens: 512,
      system: buildAgentContext(agent, session.scenario, session.scenarioContext),
      messages: [{ role: "user", content: reviewPrompt }],
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        reviewContent += chunk.delta.text;
      }
    }
  } catch (err) {
    reviewContent = `Error during review: ${err instanceof Error ? err.message : String(err)}
DECISION: APPROVE
FEEDBACK: Unable to complete review due to error.`;
  }

  // Parse the decision from the response
  const { decision, feedback, suggestions } = parseReviewResponse(reviewContent);

  const review: VisualReview = {
    role: reviewerRole,
    decision,
    feedback,
    suggestions,
    timestamp: Date.now(),
  };

  // Store the review
  request.reviews[reviewerRole] = review;

  // Update artifact review status
  request.artifact.reviewStatus =
    decision === "approved" ? "approved" : decision === "rejected" ? "rejected" : "needs-revision";
  request.artifact.reviewNotes = feedback;

  bus.publishReviewResult(session.id, request.artifactId, reviewerRole, decision, feedback);

  bus.publishAgentTurnEnd(session.id, agent.role, agent.id, agent.monitorIndex);
  bus.publishMonitorHighlight(session.id, agent.monitorIndex, false);

  return review;
}

/** Run all reviewers for a review request and determine consensus */
export async function runFullReview(
  session: WarRoomSession,
  reviewRequestId: string,
): Promise<{
  request: VisualReviewRequest;
  consensus: ReviewDecision | null;
  needsIteration: boolean;
}> {
  const store = getWarRoomStore();
  const request = store.reviewRequests.get(reviewRequestId);
  if (!request) throw new Error(`Review request not found: ${reviewRequestId}`);

  // Run each reviewer sequentially
  for (const role of request.reviewerRoles) {
    // Skip the creator
    if (role === request.artifact.createdByRole) continue;
    await runAgentReview(session, reviewRequestId, role);
    // Small delay between reviews
    await sleep(300);
  }

  // Determine consensus
  const completedReviews = request.reviewerRoles
    .filter((r) => r !== request.artifact.createdByRole)
    .map((r) => request.reviews[r])
    .filter((r): r is VisualReview => r !== undefined);

  const consensus = determineConsensus(completedReviews);

  request.consensus = consensus ?? undefined;
  const needsIteration =
    consensus === "needs-revision" && request.iteration < request.maxIterations;

  if (!needsIteration) {
    request.completedAt = Date.now();
  } else {
    request.iteration++;
  }

  store.reviewRequests.set(request.id, request);

  return { request, consensus, needsIteration };
}

/** CEO override for a review */
export function ceoOverrideReview(
  reviewRequestId: string,
  decision: ReviewDecision,
): VisualReviewRequest {
  const store = getWarRoomStore();
  const request = store.reviewRequests.get(reviewRequestId);
  if (!request) throw new Error(`Review request not found: ${reviewRequestId}`);

  request.consensus = decision;
  request.completedAt = Date.now();
  request.artifact.reviewStatus =
    decision === "approved" ? "approved" : decision === "rejected" ? "rejected" : "needs-revision";

  store.reviewRequests.set(request.id, request);
  return request;
}

// ─── Review Prompt Builder ────────────────────────────────────────────────────

function buildReviewPrompt(
  artifact: WarRoomArtifact,
  reviewerRole: WarRoomAgentRole,
  iteration: number,
): string {
  const roleInstructions: Record<WarRoomAgentRole, string> = {
    ceo: "Review for strategic alignment, business value, and executive clarity.",
    cto: "Review for technical correctness, code quality, scalability, and security.",
    cmo: "Review for user experience, clarity, brand consistency, and conversion potential.",
    cfo: "Review for financial soundness, cost efficiency, and ROI clarity.",
    ops: "Review for operational feasibility, reliability, deployment readiness, and monitoring.",
  };

  return `You are reviewing the following artifact (iteration ${iteration}):

## Artifact: ${artifact.title}
Type: ${artifact.type}
Created by: ${artifact.createdByRole.toUpperCase()}

${artifact.type === "code" ? "```" + (artifact.language ?? "") : ""}
${artifact.content}
${artifact.type === "code" ? "```" : ""}

## Your Review Focus
${roleInstructions[reviewerRole]}

## Instructions
Provide your review. You MUST include exactly one of these on its own line:
- DECISION: APPROVE
- DECISION: REJECT
- DECISION: NEEDS-REVISION

Then provide your FEEDBACK (specific, actionable, under 200 words).

If suggesting revisions, list them as SUGGESTIONS:
- [suggestion 1]
- [suggestion 2]`;
}

// ─── Response Parser ──────────────────────────────────────────────────────────

function parseReviewResponse(content: string): {
  decision: ReviewDecision;
  feedback: string;
  suggestions?: string[];
} {
  // Extract decision
  const decisionMatch = content.match(/DECISION:\s*(APPROVE|REJECT|NEEDS-REVISION)/i);
  let decision: ReviewDecision = "approved";
  if (decisionMatch) {
    const d = decisionMatch[1].toUpperCase();
    if (d === "REJECT") decision = "rejected";
    else if (d === "NEEDS-REVISION") decision = "needs-revision";
    else decision = "approved";
  }

  // Extract feedback (everything before SUGGESTIONS or DECISION line)
  const feedbackMatch = content
    .replace(/DECISION:\s*(APPROVE|REJECT|NEEDS-REVISION)/gi, "")
    .replace(/SUGGESTIONS:[\s\S]*/i, "")
    .trim();
  const feedback = feedbackMatch || "Review completed.";

  // Extract suggestions
  const suggestionsMatch = content.match(/SUGGESTIONS:([\s\S]*)/i);
  let suggestions: string[] | undefined;
  if (suggestionsMatch) {
    suggestions = suggestionsMatch[1]
      .split("\n")
      .map((s) => s.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean);
  }

  return { decision, feedback, suggestions };
}

// ─── Consensus Determination ──────────────────────────────────────────────────

function determineConsensus(reviews: VisualReview[]): ReviewDecision | null {
  if (reviews.length === 0) return null;

  const counts: Record<ReviewDecision, number> = {
    approved: 0,
    rejected: 0,
    "needs-revision": 0,
  };

  for (const review of reviews) {
    counts[review.decision]++;
  }

  // Any rejection triggers rejection
  if (counts.rejected > 0) return "rejected";
  // Any revision request triggers revision
  if (counts["needs-revision"] > 0) return "needs-revision";
  // All approved
  return "approved";
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
