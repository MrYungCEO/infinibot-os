/**
 * Review thread — verification as a visible agent-to-agent conversation.
 *
 * Every verified run gets a threaded dialogue between the worker agent and
 * the Reviewer agent ("Auditor", stationed on the Executive Island of the
 * agent mesh map):
 *
 *   worker   → reviewer  submission  RESULT summary + evidence
 *   reviewer → worker    challenge   failed checks / missing evidence, with exact re-run instructions
 *   worker   → reviewer  response    new evidence / fixes (the continuation's RESULT)
 *   reviewer → worker    verdict     VERIFIED / changes_needed / escalate / FAILED
 *   reviewer → reviewer  action      something the reviewer resolved itself
 *                                    (cwd-aware re-run, own screenshots, baseline run)
 *
 * Storage: `<stateDir>/verification/<runId>/review-thread.jsonl`, append-only,
 * one message per line with a per-run `seq`. Each append is broadcast live as
 * `review.message` so the mesh map can animate the packet as it happens; past
 * runs replay from the file (review.thread.get / review.threads.list).
 */

import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { ingestScreenshot } from "./screenshot-index.js";
import { getRecord, listRecords, verificationRunDir, type CompletionRecord } from "./store.js";

// ── Reviewer identity ───────────────────────────────────────────────────────

export const REVIEWER_AGENT = {
  id: "auditor",
  name: "Auditor",
  title: "Verification Reviewer",
  /** Where the reviewer lives on the agent mesh map. */
  station: "executive",
  /** Icon key in ui/src/ui/icons.ts. */
  icon: "shield",
} as const;

/** Max reviewer evaluations per round (submission + challenges) before it stops. */
export const REVIEW_ROUND_CAP = 4;

// ── Types ───────────────────────────────────────────────────────────────────

export type ReviewRole = "worker" | "reviewer";
export type ReviewMessageKind = "submission" | "challenge" | "response" | "verdict" | "action";
export type ReviewVerdictKind = "VERIFIED" | "changes_needed" | "escalate" | "FAILED";
export type EscalationCategory =
  | "destructive"
  | "credentials"
  | "product_decision"
  | "contradiction"
  | "worker_blocked";

export interface ReviewEvidenceRef {
  kind: "screenshot" | "command" | "file" | "commit" | "url" | "visual" | "claim" | "files";
  ref: string;
  status?: "pass" | "fail" | "warn" | "skipped";
  detail?: string;
  /** Directory a command was (re-)run in. */
  cwd?: string;
}

export interface ReviewAction {
  kind: "rerun" | "screenshot" | "baseline" | "resolve_evidence" | "scope";
  detail: string;
  status: "pass" | "fail" | "warn" | "skipped";
  cwd?: string;
}

export interface ReviewEscalation {
  category: EscalationCategory;
  /** Exactly what the human needs to decide. */
  decision: string;
  reason: string;
}

export interface ReviewMessage {
  id: string;
  seq: number;
  runId: string;
  ts: number;
  /** Reviewer evaluation number this message belongs to (1-based). */
  round: number;
  attempt: number;
  from: ReviewRole;
  to: ReviewRole;
  /** Agent ids (reviewer: "auditor"; worker: the run's child session key). */
  fromAgent: string;
  toAgent: string;
  kind: ReviewMessageKind;
  /** One-line headline (speech-bubble snippet). */
  title: string;
  /** Full text. */
  text: string;
  /** Challenge bullets / re-run instructions / remaining problems. */
  items?: string[];
  evidence?: ReviewEvidenceRef[];
  screenshots?: string[];
  verdict?: ReviewVerdictKind;
  escalation?: ReviewEscalation;
  actions?: ReviewAction[];
  /** Non-blocking notes (incidental claims, environment skips). */
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

export interface ReviewThread {
  summary: ReviewThreadSummary;
  reviewer: typeof REVIEWER_AGENT;
  messages: ReviewMessage[];
}

// ── Storage ─────────────────────────────────────────────────────────────────

const bus = new EventEmitter();
bus.setMaxListeners(0);

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
let broadcaster: BroadcastFn | null = null;

export const REVIEW_MESSAGE_EVENT = "review.message";

export function setReviewBroadcaster(fn: BroadcastFn | null): void {
  broadcaster = fn;
}

export function onReviewMessage(fn: (msg: ReviewMessage) => void): () => void {
  bus.on("message", fn);
  return () => bus.off("message", fn);
}

export function reviewThreadPath(runId: string): string {
  return path.join(verificationRunDir(runId), "review-thread.jsonl");
}

const cache = new Map<string, { mtimeMs: number; size: number; messages: ReviewMessage[] }>();

export function readReviewThread(runId: string): ReviewMessage[] {
  const file = reviewThreadPath(runId);
  let st;
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.messages;
  const messages: ReviewMessage[] = [];
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as ReviewMessage);
      } catch {
        /* torn line */
      }
    }
  } catch {
    return [];
  }
  messages.sort((a, b) => a.seq - b.seq);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, messages });
  return messages;
}

function workerAgentOf(rec: Pick<CompletionRecord, "childSessionKey" | "runId">): string {
  return rec.childSessionKey || rec.runId;
}

export function appendReviewMessage(
  runId: string,
  msg: Omit<
    ReviewMessage,
    "id" | "seq" | "runId" | "ts" | "fromAgent" | "toAgent" | "round" | "attempt"
  > &
    Partial<Pick<ReviewMessage, "round" | "attempt" | "ts">>,
): ReviewMessage | null {
  const rec = getRecord(runId);
  const prior = readReviewThread(runId);
  const seq = (prior[prior.length - 1]?.seq ?? 0) + 1;
  const worker = rec ? workerAgentOf(rec) : runId;
  // Screenshots must be servable by the control UI (verification-dir only).
  // A cited screenshot that does not exist stays visible as failed evidence,
  // never as a broken image.
  const screenshots = msg.screenshots
    ?.map((p) => ingestScreenshot(runId, p))
    .filter((p, i, a): p is string => Boolean(p) && a.indexOf(p) === i);
  const full: ReviewMessage = {
    ...msg,
    ...(screenshots ? { screenshots } : {}),
    id: `${runId}#${seq}`,
    seq,
    runId,
    ts: msg.ts ?? Date.now(),
    // A worker report opens the next review round; reviewer messages belong to the current one.
    round:
      msg.round ??
      (msg.kind === "submission" || msg.kind === "response"
        ? currentReviewRound(prior) + (prior.some((m) => m.kind === "submission" || m.kind === "response") ? 1 : 0)
        : currentReviewRound(prior)),
    attempt: msg.attempt ?? rec?.attempts.length ?? 1,
    fromAgent: msg.from === "reviewer" ? REVIEWER_AGENT.id : worker,
    toAgent: msg.to === "reviewer" ? REVIEWER_AGENT.id : worker,
    title: msg.title.slice(0, 200),
    text: msg.text.slice(0, 8000),
    ...(msg.items ? { items: msg.items.slice(0, 20).map((s) => s.slice(0, 800)) } : {}),
  };
  try {
    mkdirSync(path.dirname(reviewThreadPath(runId)), { recursive: true });
    appendFileSync(reviewThreadPath(runId), `${JSON.stringify(full)}\n`);
  } catch {
    return null;
  }
  bus.emit("message", full);
  if (broadcaster) {
    try {
      broadcaster(
        REVIEW_MESSAGE_EVENT,
        { message: full, summary: rec ? summarizeThread(rec, readReviewThread(runId)) : null },
        { dropIfSlow: true },
      );
    } catch {
      /* UI push is best effort */
    }
  }
  return full;
}

/** Reviewer evaluations so far (submission/response messages open a new one). */
export function currentReviewRound(messages: ReviewMessage[]): number {
  return Math.max(
    1,
    messages.filter((m) => m.kind === "submission" || m.kind === "response").length,
  );
}

export function summarizeThread(
  rec: CompletionRecord,
  messages: ReviewMessage[] = readReviewThread(rec.runId),
): ReviewThreadSummary {
  const last = messages[messages.length - 1];
  const lastVerdict = [...messages].reverse().find((m) => m.kind === "verdict");
  const escalation = lastVerdict?.escalation;
  const shots = new Set<string>();
  for (const m of messages) for (const s of m.screenshots ?? []) shots.add(s);
  return {
    runId: rec.runId,
    label: rec.label,
    workerAgent: workerAgentOf(rec),
    childSessionKey: rec.childSessionKey,
    requesterSessionKey: rec.requesterSessionKey,
    backend: rec.backend,
    state: rec.state,
    verdict: lastVerdict?.verdict ?? null,
    rounds: messages.filter((m) => m.kind === "submission" || m.kind === "response").length,
    messageCount: messages.length,
    startedAt: rec.startedAt,
    lastTs: last?.ts ?? rec.updatedAt,
    lastKind: last?.kind ?? null,
    lastTitle: last?.title ?? "",
    escalated: Boolean(escalation) || rec.state === "needs_owner",
    ...(escalation ? { escalation } : {}),
    screenshots: shots.size,
  };
}

export function getReviewThread(runId: string): ReviewThread | null {
  const rec = getRecord(runId);
  if (!rec) return null;
  const messages = readReviewThread(runId);
  return { summary: summarizeThread(rec, messages), reviewer: REVIEWER_AGENT, messages };
}

export function listReviewThreads(opts: {
  limit?: number;
  since?: number;
  states?: string[];
  requesterSessionKey?: string;
  /** Include runs that have no thread messages yet (default false). */
  includeEmpty?: boolean;
}): ReviewThreadSummary[] {
  const recs = listRecords({
    limit: Math.min(500, Math.max(1, (opts.limit ?? 50) * 3)),
    ...(opts.requesterSessionKey ? { requesterSessionKey: opts.requesterSessionKey } : {}),
  });
  const out: ReviewThreadSummary[] = [];
  for (const rec of recs) {
    if (opts.since && rec.updatedAt < opts.since) continue;
    if (opts.states?.length && !opts.states.includes(rec.state)) continue;
    if (!opts.includeEmpty && !existsSync(reviewThreadPath(rec.runId))) continue;
    out.push(summarizeThread(rec));
    if (out.length >= (opts.limit ?? 50)) break;
  }
  return out.sort((a, b) => b.lastTs - a.lastTs);
}

/** Text the worker receives as its continuation: the reviewer's challenge. */
export function formatChallengeForWorker(msg: ReviewMessage, cap = REVIEW_ROUND_CAP): string {
  const items = (msg.items ?? []).map((i) => `- ${i}`).join("\n");
  return [
    `[REVIEW CHALLENGE from ${REVIEWER_AGENT.name}, the verification reviewer — round ${msg.round}/${cap}]`,
    msg.text,
    items ? `\nWhat I need from you:\n${items}` : "",
    `\nReply by fixing what is real, re-running the checks (record each check's "cwd" in checks_run), and ending with an updated RESULT block. If a demand is wrong, say why in RESULT.open_issues with evidence; I will re-check it myself.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function resetReviewThreadCacheForTests(): void {
  cache.clear();
  bus.removeAllListeners();
  bus.setMaxListeners(0);
  broadcaster = null;
}
