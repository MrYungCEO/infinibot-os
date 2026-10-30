/**
 * Review dialogue — what the Auditor says, and when it hands a run to a human.
 *
 * Pure functions over the pipeline's classification + review outcome; the
 * pipeline (pipeline.ts) appends the messages to the run's review thread
 * (review-thread.ts) at each step:
 *
 *   attempt exits     → worker submission (1st) / response (later)
 *   reviewer resolves → action (cwd-aware re-run, run-id screenshots, baseline)
 *   gaps it can't fix → challenge (exact re-run instructions), delivered as the
 *                       worker's continuation prompt + the run's inbox
 *   terminal          → verdict (VERIFIED / changes_needed / escalate / FAILED)
 *
 * Escalation policy: the Auditor only asks a human for real blockers —
 * destructive/irreversible actions, missing credentials, product decisions,
 * a worker that reports itself blocked, or a contradiction it could not
 * resolve after re-checking itself. Running out of rounds on ordinary gaps
 * ends the run as changes_needed (unverified), not as an owner escalation.
 */

import type { ResultCheck, RunResult } from "./contract.js";
import type { ExitClassification } from "./classifier.js";
import type { EvidenceItem } from "./evidence.js";
import type { ReviewOutcome } from "./reviewer.js";
import {
  REVIEW_ROUND_CAP,
  type EscalationCategory,
  type ReviewAction,
  type ReviewEscalation,
  type ReviewEvidenceRef,
  type ReviewMessage,
  type ReviewVerdictKind,
} from "./review-thread.js";
import type { CompletionState } from "./store.js";

type Draft = Omit<
  ReviewMessage,
  "id" | "seq" | "runId" | "ts" | "fromAgent" | "toAgent" | "round" | "attempt"
>;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function evidenceOfResult(result: RunResult): ReviewEvidenceRef[] {
  const out: ReviewEvidenceRef[] = [];
  for (const c of result.checks_run as ResultCheck[])
    out.push({
      kind: "command",
      ref: c.command,
      detail: `claimed exit ${c.exit_code}${c.output_tail ? ` — ${clip(c.output_tail, 160)}` : ""}`,
      ...(c.cwd ? { cwd: c.cwd } : {}),
    });
  for (const c of result.claims)
    out.push({ kind: "claim", ref: `${c.claim} ← ${c.evidence_ref}`, detail: c.evidence_type });
  for (const sha of result.commits) out.push({ kind: "commit", ref: sha });
  return out.slice(0, 40);
}

/** Worker → reviewer: the first RESULT is a submission, later ones answer a challenge. */
export function workerMessage(p: {
  classification: ExitClassification;
  isResponse: boolean;
  attemptKind: string;
}): Draft {
  const r = p.classification.result;
  const kind = p.isResponse ? "response" : "submission";
  if (!r) {
    return {
      from: "worker",
      to: "reviewer",
      kind,
      title: p.isResponse ? "Exited again without a RESULT block" : "Exited without a RESULT block",
      text: `The worker's process ended (${p.attemptKind}) without a machine-readable RESULT.${p.classification.reasons.length ? ` ${p.classification.reasons.slice(0, 3).join("; ")}` : ""}`,
    };
  }
  const head =
    r.status === "done"
      ? p.isResponse
        ? "Addressed the challenge — please re-check"
        : "Work done — submitting for review"
      : r.status === "blocked"
        ? "Blocked — needs a decision"
        : "Needs input before continuing";
  return {
    from: "worker",
    to: "reviewer",
    kind,
    title: `${head}: ${clip(r.summary, 110)}`,
    text: r.summary || head,
    ...(r.open_issues.length ? { items: r.open_issues.map((i) => `open issue: ${i}`) } : {}),
    evidence: evidenceOfResult(r),
    screenshots: r.screenshots.slice(0, 24),
  };
}

/** Things the reviewer settled itself while reviewing (shown as actions on its node). */
export function reviewerActions(items: EvidenceItem[], warnings: string[]): ReviewAction[] {
  const out: ReviewAction[] = [];
  for (const i of items) {
    if (i.kind === "command" && i.cwd && !i.environment && i.status !== "skipped") {
      out.push({
        kind: i.baseline ? "baseline" : "rerun",
        detail: i.baseline
          ? `ran \`${clip(i.ref, 120)}\` at the base commit — the failure is pre-existing`
          : `re-ran \`${clip(i.ref, 120)}\` in ${i.cwd}: ${clip(i.detail, 140)}`,
        status: i.status === "fail" ? "fail" : i.baseline ? "warn" : "pass",
        cwd: i.cwd,
      });
    }
    if (i.kind === "screenshot" && /resolved by run id|resolved from/.test(i.detail)) {
      out.push({
        kind: "resolve_evidence",
        detail: `found screenshot ${i.ref.split("/").slice(-2).join("/")} (${clip(i.detail, 120)})`,
        status: i.status === "pass" ? "pass" : "fail",
      });
    }
  }
  for (const w of warnings)
    if (w.startsWith("incidental claim"))
      out.push({ kind: "scope", detail: clip(w, 220), status: "skipped" });
  // Keep the thread readable: collapse screenshot finds beyond a few.
  const shots = out.filter((a) => a.kind === "resolve_evidence");
  const rest = out.filter((a) => a.kind !== "resolve_evidence");
  if (shots.length > 3)
    rest.push({
      kind: "resolve_evidence",
      detail: `resolved ${shots.length} screenshots from this run's visual_verify captures`,
      status: shots.every((s) => s.status === "pass") ? "pass" : "warn",
    });
  else rest.push(...shots);
  return rest.slice(0, 16);
}

export function actionMessage(actions: ReviewAction[]): Draft | null {
  if (!actions.length) return null;
  const n = actions.filter((a) => a.kind !== "scope").length;
  const scoped = actions.length - n;
  return {
    from: "reviewer",
    to: "reviewer",
    kind: "action",
    title:
      n > 0
        ? `Checked it myself: ${n} re-check${n === 1 ? "" : "s"}${scoped ? `, ${scoped} incidental claim${scoped === 1 ? "" : "s"} set aside` : ""}`
        : `Set aside ${scoped} incidental claim${scoped === 1 ? "" : "s"} (not required by the task)`,
    text: actions.map((a) => `- ${a.detail}`).join("\n"),
    actions,
  };
}

/** Exact, actionable instructions for each gap. */
export function challengeItems(outcome: ReviewOutcome, items: EvidenceItem[]): string[] {
  const out: string[] = [];
  for (const i of items) {
    if (i.kind === "command" && i.status === "fail" && /claimed exit/.test(i.detail)) {
      out.push(
        `\`${i.ref}\` fails when I re-run it${i.cwd ? ` in ${i.cwd}` : ""} (${clip(i.detail.replace(/^claimed exit \S+ but /, ""), 220)}). Fix it, re-run it from that directory, and report the new exit code with "cwd" in checks_run. If it was already failing before your change, say so — I will confirm with a baseline run.`,
      );
    }
  }
  for (const f of outcome.fixable) {
    if (/fails when re-run/.test(f) && out.length) continue;
    out.push(f);
  }
  // One gap per artefact: a missing file shows up as a screenshot failure, a
  // claim failure and a reviewer objection — ask for it once.
  const seenPaths = new Set<string>();
  const deduped: string[] = [];
  for (const item of new Set(out)) {
    const paths = [...item.matchAll(/(?:^|[\s(`"'])(\/[\w.@+-]+(?:\/[\w.@+-]+)+)/g)].map((m) =>
      m[1].replace(/[.,;:]+$/, ""),
    );
    // Same missing artefact (a file path already asked for) → not a new gap.
    if (
      paths.length &&
      (paths.every((p) => seenPaths.has(p)) ||
        paths.some((p) => /\.\w{2,5}$/.test(p) && seenPaths.has(p)))
    )
      continue;
    for (const p of paths) seenPaths.add(p);
    deduped.push(item);
  }
  return deduped.slice(0, 10);
}

export function challengeMessage(p: {
  outcome: ReviewOutcome;
  items: EvidenceItem[];
  round: number;
}): Draft {
  const list = challengeItems(p.outcome, p.items);
  const first = list[0] ?? p.outcome.reasons[0] ?? "evidence is missing";
  return {
    from: "reviewer",
    to: "worker",
    kind: "challenge",
    title: `Not verified yet (${list.length} gap${list.length === 1 ? "" : "s"}): ${clip(first, 120)}`,
    text: `I reviewed your report against the evidence (round ${p.round}/${REVIEW_ROUND_CAP}). These must be closed before I can verify the work:`,
    items: list,
    evidence: evidenceRefs(p.items.filter((i) => i.status === "fail")),
    ...(p.outcome.warnings.length ? { notes: p.outcome.warnings.slice(0, 8) } : {}),
  };
}

function evidenceRefs(items: EvidenceItem[]): ReviewEvidenceRef[] {
  return items.slice(0, 20).map((i) => ({
    kind: i.kind,
    ref: i.ref,
    status: i.status,
    detail: clip(i.detail, 300),
    ...(i.cwd ? { cwd: i.cwd } : {}),
  }));
}

// ── Escalation ──────────────────────────────────────────────────────────────

const CREDENTIAL_RE =
  /(api[_ -]?key|access token|bot token|credential|\bsecret\b|password|oauth|login required|not logged in|unauthori[sz]ed|\b40[13]\b|missing (?:key|token)|no (?:api )?key|\b[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET)\b)/i;
const DESTRUCTIVE_RE =
  /\b(deploy(?:ing|ment)?|push(?:ing)? to (?:main|prod|production|origin)|force[- ]push|restart (?:the )?(?:live|gateway|prod)|drop (?:table|database)|delete (?:prod|production|the live)|rm -rf|migrat(?:e|ion) (?:the )?prod|publish(?:ing)? (?:to )?npm|irreversible|uncommitted work)/i;
const DECISION_RE =
  /\b(which (?:option|one|approach)|should (?:i|we)|decide|decision|choose|pick between|product (?:call|decision)|ambiguous|unclear (?:requirement|spec)|confirm (?:whether|which))\b/i;

/**
 * Should a human be asked? Returns null when the Auditor can finish on its
 * own (verified, or changes_needed after the round cap).
 */
export function decideEscalation(p: {
  classification: ExitClassification;
  outcome: ReviewOutcome;
  /** The same problems came back after the worker's response. */
  repeated: boolean;
  items: EvidenceItem[];
}): ReviewEscalation | null {
  const r = p.classification.result;
  if (p.outcome.verdict === "VERIFIED") return null;
  const issues = r?.open_issues ?? [];
  const text = [r?.summary ?? "", ...issues].join("\n");
  const cat = (c: EscalationCategory, decision: string, reason: string): ReviewEscalation => ({
    category: c,
    decision: clip(decision, 600),
    reason: clip(reason, 600),
  });
  if (r?.status === "blocked" || r?.status === "needs_input") {
    const first = issues[0] ?? r.summary;
    if (CREDENTIAL_RE.test(text))
      return cat(
        "credentials",
        `Provide the missing credential so the worker can continue: ${clip(first, 300)}`,
        "the worker cannot proceed without a credential only the owner has",
      );
    if (DESTRUCTIVE_RE.test(text))
      return cat(
        "destructive",
        `Approve or decline this irreversible step: ${clip(first, 300)}`,
        "the remaining step is destructive or outward-facing and needs the owner's go-ahead",
      );
    if (r.status === "needs_input" || DECISION_RE.test(text))
      return cat(
        "product_decision",
        `Answer the worker's question: ${clip(first, 300)}`,
        "the task needs a product decision the reviewer must not make",
      );
    return cat(
      "worker_blocked",
      `The worker reports it is blocked: ${clip(first, 300)}. Unblock it (then Continue), or Accept the work as-is.`,
      "the worker reported status blocked",
    );
  }
  if (p.repeated) {
    const contra = p.items.find(
      (i) => i.kind === "command" && i.status === "fail" && /claimed exit 0/.test(i.detail),
    );
    if (contra) {
      return cat(
        "contradiction",
        `The worker insists \`${clip(contra.ref, 140)}\` passes; I re-ran it${contra.cwd ? ` in ${contra.cwd}` : ""} and it fails (${clip(contra.detail, 200)}). Decide: Accept the run as-is, or Reject it.`,
        "the worker and the reviewer disagree on a check after a re-run in the right directory and a baseline check",
      );
    }
    const reason = p.outcome.reasons[0] ?? "the same gap";
    return cat(
      "contradiction",
      `After ${REVIEW_ROUND_CAP > 1 ? "repeated rounds" : "a round"} the worker answered the same way and this is still open: ${clip(reason, 300)}. Decide: Accept the run as-is, or Reject it.`,
      "the same problem came back unchanged after the worker's response",
    );
  }
  return null;
}

export function verdictKindFor(
  state: CompletionState,
  escalation: ReviewEscalation | null,
): ReviewVerdictKind {
  if (state === "verified" || state === "accepted") return "VERIFIED";
  if (escalation || state === "needs_owner" || state === "blocked" || state === "needs_input")
    return "escalate";
  if (state === "failed" || state === "rejected") return "FAILED";
  return "changes_needed";
}

export function verdictMessage(p: {
  state: CompletionState;
  outcome: ReviewOutcome | null;
  reasons: string[];
  escalation: ReviewEscalation | null;
  items: EvidenceItem[];
  rounds: number;
}): Draft {
  const verdict = verdictKindFor(p.state, p.escalation);
  const shots = p.items
    .filter(
      (i) => i.kind === "screenshot" && i.status === "pass" && /\.(png|jpe?g|webp)$/i.test(i.ref),
    )
    .map((i) => i.ref)
    .slice(0, 16);
  const passes = p.items.filter((i) => i.status === "pass").length;
  const title =
    verdict === "VERIFIED"
      ? `VERIFIED — ${passes} check${passes === 1 ? "" : "s"} confirmed${p.rounds > 1 ? ` after ${p.rounds} rounds` : ""}`
      : verdict === "escalate"
        ? `Owner decision needed: ${clip(p.escalation?.decision ?? p.reasons[0] ?? p.state, 120)}`
        : verdict === "FAILED"
          ? `FAILED: ${clip(p.reasons[0] ?? "the work is broken", 130)}`
          : `Changes needed — stopped after ${p.rounds} round${p.rounds === 1 ? "" : "s"}: ${clip(p.reasons[0] ?? "", 110)}`;
  const text =
    verdict === "VERIFIED"
      ? "Every claim that matters for the task is backed by evidence I checked myself."
      : verdict === "escalate"
        ? `I can't settle this without you. ${p.escalation?.reason ?? ""}`.trim()
        : verdict === "FAILED"
          ? "Hard evidence shows the work is broken."
          : `I stopped auto-continuing at the round cap (${REVIEW_ROUND_CAP}). Remaining gaps are listed; Continue reopens the review.`;
  return {
    from: "reviewer",
    to: "worker",
    kind: "verdict",
    verdict,
    title,
    text,
    ...(verdict === "VERIFIED" ? {} : { items: p.reasons.slice(0, 10) }),
    ...(p.escalation ? { escalation: p.escalation } : {}),
    ...(p.outcome?.warnings.length ? { notes: p.outcome.warnings.slice(0, 8) } : {}),
    evidence: evidenceRefs(
      p.items.filter(
        (i) =>
          i.kind !== "screenshot" &&
          (verdict === "VERIFIED" ? i.status === "pass" : i.status === "fail"),
      ),
    ),
    ...(shots.length ? { screenshots: shots } : {}),
  };
}
