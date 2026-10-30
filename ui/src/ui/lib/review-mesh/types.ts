/**
 * Client-side mirror of the review-thread contract
 * (src/verification/review-thread.ts + the screenshot gallery RPC).
 *
 * Kept as a structural copy (the UI bundle never imports backend modules).
 * Every field the backend may omit is optional here, and every reader in the
 * UI tolerates missing data — a newer/older gateway must never blank the map.
 */

export type ReviewRole = "worker" | "reviewer";
export type ReviewMessageKind = "submission" | "challenge" | "response" | "verdict" | "action";
export type ReviewVerdictKind = "VERIFIED" | "changes_needed" | "escalate" | "FAILED";

export interface ReviewEvidenceRef {
  kind: string;
  ref: string;
  status?: "pass" | "fail" | "warn" | "skipped";
  detail?: string;
  cwd?: string;
}

export interface ReviewAction {
  kind: string;
  detail: string;
  status: "pass" | "fail" | "warn" | "skipped";
  cwd?: string;
}

export interface ReviewEscalation {
  category: string;
  decision: string;
  reason: string;
}

export interface ReviewMessage {
  id: string;
  seq: number;
  runId: string;
  ts: number;
  round: number;
  attempt: number;
  from: ReviewRole;
  to: ReviewRole;
  fromAgent: string;
  toAgent: string;
  kind: ReviewMessageKind;
  title: string;
  text: string;
  items?: string[];
  evidence?: ReviewEvidenceRef[];
  screenshots?: string[];
  verdict?: ReviewVerdictKind;
  escalation?: ReviewEscalation;
  actions?: ReviewAction[];
  notes?: string[];
}

export interface ReviewThreadSummary {
  runId: string;
  label: string;
  workerAgent: string;
  childSessionKey: string;
  requesterSessionKey: string;
  backend: string | null;
  state: string;
  verdict: ReviewVerdictKind | null;
  rounds: number;
  messageCount: number;
  startedAt: number;
  lastTs: number;
  lastKind: ReviewMessageKind | null;
  lastTitle: string;
  escalated: boolean;
  escalation?: ReviewEscalation;
  screenshots: number;
}

export interface ReviewerIdentity {
  id: string;
  name: string;
  title: string;
  station: string;
  icon: string;
}

export interface ReviewThread {
  summary: ReviewThreadSummary;
  reviewer: ReviewerIdentity;
  messages: ReviewMessage[];
}

export interface ReviewMessageEvent {
  message: ReviewMessage;
  summary: ReviewThreadSummary | null;
}

export interface ScreenshotAssessment {
  pass: boolean | null;
  summary: string;
  issues: string[];
}

export interface ScreenshotEntry {
  id: string;
  path: string;
  url: string;
  thumbUrl: string;
  runId: string;
  label: string;
  agent: string;
  route: string | null;
  viewport: string | null;
  theme: string | null;
  ts: number;
  verdict: "pass" | "fail" | "unknown";
  runState: string | null;
  runVerdict: string | null;
  visualDir: string | null;
  assessment?: ScreenshotAssessment | null;
  baselinePath?: string | null;
  baselineUrl?: string | null;
  source: "visual_verify" | "result";
}

/** Subset of verification.completion (src/verification/notify.ts CompletionBroadcast). */
export interface CompletionBroadcast {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  label: string;
  state: string;
  verdict: string | null;
  summary?: string;
}

export const REVIEWER_ID = "auditor";
export const DEFAULT_REVIEWER: ReviewerIdentity = {
  id: REVIEWER_ID,
  name: "Auditor",
  title: "Verification Reviewer",
  station: "executive",
  icon: "shield",
};
