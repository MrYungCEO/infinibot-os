/**
 * Oversight sampler — the scheduled "second-look" overseer.
 *
 * The auto-reviewer writes one review per finished run. That makes the
 * Oversight feed complete, but every entry is the FIRST look (written right as
 * the run ended). The sampler is the SECOND look: it periodically re-samples a
 * handful of already-completed reviews and re-checks them with fresh eyes,
 * flagging any that look like they drifted (build failed, blockers left,
 * nothing actually changed). Findings are surfaced in the same Oversight feed:
 *   - clean     → nothing changed, the run still looks good
 *   - drift     → the re-check is suspicious; the review is flagged drift:true
 *   - reopened  → the run produced no real change (no files touched on a
 *                 "completed" run) — the strongest drift signal
 *
 * Deterministic by design (no LLM round-trip): it re-derives a verdict from the
 * persisted review record so it is cheap, reliable, and safe to run on a timer.
 * A heavier LLM-backed re-audit can be layered on later behind the same RPC.
 *
 * Findings are persisted to STATE_DIR/subagents/sampler-findings.json so the
 * Oversight page can show the latest sampler pass without re-running it.
 */

import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { listReviews, patchReview, type AgentReview } from "../reviews/index.js";

const log = createSubsystemLogger("oversight-sampler");

const FINDINGS_VERSION = 1 as const;
const MAX_FINDINGS = 200;
const DEFAULT_SAMPLE = 5;

export type SamplerVerdict = "clean" | "drift" | "reopened";

export interface SamplerFinding {
  runId: string;
  reviewId?: string;
  label?: string;
  projectId?: string;
  verdict: SamplerVerdict;
  note: string;
  /** Confidence carried from the underlying review, for quick scanning. */
  confidence?: string;
  checkedAt: number;
}

export interface SamplerRunResult {
  sampledAt: number;
  sampled: number;
  driftCount: number;
  findings: SamplerFinding[];
}

interface PersistedFindings {
  version: 1;
  lastRunAt: number;
  findings: SamplerFinding[];
}

function findingsPath(): string {
  return path.join(resolveStateDir(), "subagents", "sampler-findings.json");
}

function loadFindings(): PersistedFindings {
  try {
    const raw = loadJsonFile(findingsPath());
    if (raw && typeof raw === "object") {
      const w = raw as Partial<PersistedFindings>;
      if (w.version === 1 && Array.isArray(w.findings)) {
        return { version: 1, lastRunAt: w.lastRunAt ?? 0, findings: w.findings };
      }
    }
  } catch (err) {
    log.warn("failed to load sampler findings", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return { version: FINDINGS_VERSION, lastRunAt: 0, findings: [] };
}

function saveFindings(data: PersistedFindings): void {
  try {
    saveJsonFile(findingsPath(), data);
  } catch (err) {
    log.warn("failed to persist sampler findings", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Deterministic re-check of a single completed review. Pure — no I/O — so it is
 * trivially testable and cheap to run over a batch.
 */
export function recheckReview(r: AgentReview): { verdict: SamplerVerdict; note: string } {
  // A "completed" run that touched nothing is the strongest drift signal: the
  // agent reported success but produced no change.
  if (r.status === "completed" && (r.filesTouched?.length ?? 0) === 0 && !r.buildPassed) {
    return {
      verdict: "reopened",
      note: "Run completed but touched no files and reported no passing build — no evidence of real work.",
    };
  }
  if (r.buildPassed === false) {
    return { verdict: "drift", note: "Re-check: the review records a failing build." };
  }
  if ((r.blockers?.length ?? 0) > 0) {
    return {
      verdict: "drift",
      note: `Re-check: ${r.blockers.length} unresolved blocker(s) recorded on a closed run.`,
    };
  }
  if (r.status === "errored") {
    return { verdict: "drift", note: "Re-check: run ended in error." };
  }
  if (r.confidence === "low") {
    return { verdict: "drift", note: "Re-check: auto-review confidence was low." };
  }
  return { verdict: "clean", note: "Re-check: no drift signals — work still looks good." };
}

/**
 * Run one sampler pass: sample up to `limit` recently-completed reviews,
 * re-check each, flag drift on the underlying review, and persist findings.
 */
export function runOversightSample(
  opts: { limit?: number; sinceDays?: number } = {},
): SamplerRunResult {
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 50) : DEFAULT_SAMPLE;
  const sinceDays = opts.sinceDays && opts.sinceDays > 0 ? opts.sinceDays : 7;
  const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  // Pull a recent window of finished reviews (any terminal status) as the
  // closed-work population, then sample the most recent `limit`.
  const population = listReviews({ since, limit: 200 }).reviews.filter(
    (r) => r.status === "completed" || r.status === "partial" || r.status === "errored",
  );
  const sample = population.slice(0, limit);

  const checkedAt = Date.now();
  const findings: SamplerFinding[] = sample.map((r) => {
    const { verdict, note } = recheckReview(r);
    if (verdict !== "clean") {
      // Flag the review so the "Drift detected" filter chip surfaces it.
      patchReview(r.runId, { drift: true, driftNote: note });
    } else if (r.drift) {
      // A previously-flagged review that now re-checks clean: clear the flag.
      patchReview(r.runId, { drift: false, driftNote: undefined });
    }
    return {
      runId: r.runId,
      reviewId: r.id,
      label: r.label,
      projectId: r.projectId,
      verdict,
      note,
      confidence: r.confidence,
      checkedAt,
    };
  });

  const driftCount = findings.filter((f) => f.verdict !== "clean").length;

  // Persist: prepend this pass, dedup by runId keeping the newest, cap length.
  const prior = loadFindings();
  const merged: SamplerFinding[] = [];
  const seen = new Set<string>();
  for (const f of [...findings, ...prior.findings]) {
    if (seen.has(f.runId)) continue;
    seen.add(f.runId);
    merged.push(f);
    if (merged.length >= MAX_FINDINGS) break;
  }
  saveFindings({ version: FINDINGS_VERSION, lastRunAt: checkedAt, findings: merged });

  log.info("oversight sampler pass complete", {
    sampled: sample.length,
    driftCount,
  });

  return { sampledAt: checkedAt, sampled: sample.length, driftCount, findings };
}

/** Read the latest persisted sampler findings without running a new pass. */
export function getSamplerFindings(limit = 50): {
  lastRunAt: number;
  findings: SamplerFinding[];
} {
  const data = loadFindings();
  const n = limit > 0 ? Math.min(limit, MAX_FINDINGS) : 50;
  return { lastRunAt: data.lastRunAt, findings: data.findings.slice(0, n) };
}
