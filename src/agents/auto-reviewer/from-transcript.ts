/**
 * Derive an AgentReview from a finished subagent run record.
 *
 * Sources of information (in priority order):
 *   1. filesTouched — already tracked by the registry during the run
 *   2. git diff --numstat — line counts for files that are in a git repo
 *   3. progress updates — last few messages from the in-memory progress store
 *   4. LLM call (haiku) — generates summary, nextSteps, blockers, confidence
 *   5. Deterministic fallback — used when LLM is unavailable or errors
 *
 * The function is safe to call with either a live SubagentRunRecord or a
 * SubagentHistoryEntry (both have the fields we need). The caller in index.ts
 * normalises them into a RunContext before calling here.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { type AgentReview, type FileTouched, type ReviewStatus } from "../reviews/schema.js";
import { REVIEW_SYSTEM_PROMPT, buildReviewPrompt, type ReviewPromptContext } from "./prompt.js";

const log = createSubsystemLogger("auto-reviewer");

/** The model used for review summarisation. Intentionally pinned to haiku (cheap + fast). */
export const AUTO_REVIEW_MODEL = "claude-haiku-4-5-20251001";
export const AUTO_REVIEW_PROVIDER = "anthropic";

/** How many times we retry the LLM call before falling back to deterministic. */
const MAX_LLM_RETRIES = 1;
/** Delay between retries (ms). */
const RETRY_DELAY_MS = 1_500;

export type RunContext = {
  runId: string;
  sessionKey: string;
  label?: string;
  task: string;
  status: ReviewStatus;
  durationMs: number;
  completedAt: number;
  errorMessage?: string;
  workdir?: string;
  projectId?: string;
  filesTouched?: Array<{
    path: string;
    action: "created" | "edited" | "deleted" | "read";
    at?: number;
  }>;
  progressUpdates?: string[];
};

/** Map registry file actions to review file actions. */
function mapAction(action: "created" | "edited" | "deleted" | "read"): FileTouched["action"] {
  switch (action) {
    case "created":
      return "added";
    case "deleted":
      return "deleted";
    default:
      return "modified";
  }
}

/**
 * Try to get line counts via `git diff --numstat` for a file relative to HEAD.
 * Returns { added: 0, removed: 0 } on any failure (git not available, not a repo, etc.)
 */
function getLineCountsFromGit(
  workdir: string,
  filePath: string,
): { added: number; removed: number } {
  try {
    const result = spawnSync("git", ["diff", "--numstat", "HEAD", "--", filePath], {
      cwd: workdir,
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || !result.stdout?.trim()) return { added: 0, removed: 0 };
    const line = result.stdout.trim().split("\n")[0] ?? "";
    const parts = line.split(/\s+/);
    const added = parseInt(parts[0] ?? "0", 10);
    const removed = parseInt(parts[1] ?? "0", 10);
    return {
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
    };
  } catch {
    return { added: 0, removed: 0 };
  }
}

function buildFilesTouched(ctx: RunContext): FileTouched[] {
  if (!ctx.filesTouched || ctx.filesTouched.length === 0) return [];
  // Dedupe by path, keeping last action per path.
  const seen = new Map<string, FileTouched["action"]>();
  for (const f of ctx.filesTouched) {
    if (f.action === "read") continue; // reads aren't meaningful for a review
    seen.set(f.path, mapAction(f.action));
  }
  const out: FileTouched[] = [];
  for (const [filePath, action] of seen) {
    let linesAdded = 0;
    let linesRemoved = 0;
    if (ctx.workdir) {
      const counts = getLineCountsFromGit(ctx.workdir, filePath);
      linesAdded = counts.added;
      linesRemoved = counts.removed;
    }
    out.push({ path: filePath, action, linesAdded, linesRemoved });
  }
  return out;
}

/** Parse test result lines from progress update text. Very heuristic. */
export function parseTestResultsFromText(text: string): {
  passed: number;
  failed: number;
  skipped: number;
} | null {
  // vitest / jest: "Tests  3 passed | 1 failed | 0 skipped" or "✓ 3 | ✗ 1 | ↓ 0"
  const vPatterns = [
    /(\d+)\s+passed.*?(\d+)\s+failed.*?(\d+)\s+skipped/i,
    /Tests.*?(\d+)\s+passed/i,
    /(\d+)\s+test[s]?\s+passed/i,
    /PASS.*?(\d+)/i,
    /FAIL.*?(\d+)/i,
  ];
  for (const pat of vPatterns) {
    const m = text.match(pat);
    if (m) {
      const passed = parseInt(m[1] ?? "0", 10);
      const failed = parseInt(m[2] ?? "0", 10);
      const skipped = parseInt(m[3] ?? "0", 10);
      if (passed + failed + skipped > 0) {
        return { passed, failed, skipped };
      }
    }
  }
  return null;
}

function buildDeterministicSummary(
  ctx: RunContext,
  filesTouched: FileTouched[],
): {
  summary: string;
  nextSteps: string[];
  blockers: string[];
  confidence: "high" | "medium" | "low";
} {
  const durationSec = Math.round(ctx.durationMs / 1000);
  const fileCount = filesTouched.length;
  const label = ctx.label || ctx.task.slice(0, 80);

  let summary: string;
  let confidence: "high" | "medium" | "low";
  const blockers: string[] = [];
  const nextSteps: string[] = [];

  switch (ctx.status) {
    case "completed":
      summary = `Agent "${label}" completed in ${durationSec}s and touched ${fileCount} file${fileCount !== 1 ? "s" : ""}.`;
      confidence = fileCount > 0 ? "medium" : "low";
      if (fileCount === 0) {
        nextSteps.push("Verify the task was actually completed — no file changes were recorded.");
      }
      break;
    case "errored":
      summary = `Agent "${label}" errored after ${durationSec}s.`;
      if (ctx.errorMessage) {
        summary += ` Error: ${ctx.errorMessage.slice(0, 120)}`;
        blockers.push(ctx.errorMessage.slice(0, 200));
      }
      confidence = "low";
      nextSteps.push("Review the error and retry or respawn the agent.");
      break;
    case "aborted":
      summary = `Agent "${label}" was aborted after ${durationSec}s.`;
      confidence = "low";
      nextSteps.push("Re-run the task if the abort was unintentional.");
      break;
    case "partial":
      summary = `Agent "${label}" partially completed after ${durationSec}s and touched ${fileCount} file${fileCount !== 1 ? "s" : ""}.`;
      confidence = "low";
      nextSteps.push("Review what was completed and continue the remaining work.");
      break;
    default:
      summary = `Agent "${label}" ran for ${durationSec}s.`;
      confidence = "low";
  }

  return { summary, nextSteps, blockers, confidence };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LLMReviewResult = {
  summary: string;
  nextSteps: string[];
  blockers: string[];
  confidence: "high" | "medium" | "low";
};

async function callLLMForReview(ctx: ReviewPromptContext): Promise<LLMReviewResult | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS);
    }
    try {
      // Dynamic import avoids pulling Anthropic SDK into every test that
      // imports from this module.
      const { runLLM } = await import("../../services/email/llm-analysis.js");
      const userPrompt = buildReviewPrompt(ctx);
      const result = await runLLM({
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 512,
        temperature: 0.1,
      });
      // Parse the JSON from the response
      const raw = result.text.trim();
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON found in LLM response");
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
      const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 600) : null;
      if (!summary) throw new Error("Missing summary in LLM response");
      const nextSteps = Array.isArray(parsed.nextSteps)
        ? (parsed.nextSteps as unknown[])
            .filter((s) => typeof s === "string")
            .map((s) => (s as string).slice(0, 300))
            .slice(0, 5)
        : [];
      const blockers = Array.isArray(parsed.blockers)
        ? (parsed.blockers as unknown[])
            .filter((s) => typeof s === "string")
            .map((s) => (s as string).slice(0, 300))
        : [];
      const rawConf = typeof parsed.confidence === "string" ? parsed.confidence : "medium";
      const confidence: "high" | "medium" | "low" =
        rawConf === "high" || rawConf === "low" ? rawConf : "medium";
      return { summary, nextSteps, blockers, confidence };
    } catch (err) {
      lastErr = err;
      log.warn("auto-reviewer: LLM call failed", {
        attempt,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.warn("auto-reviewer: all LLM attempts failed, using deterministic fallback", {
    err: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  return null;
}

/**
 * Derive a complete AgentReview from a RunContext.
 * LLM is used for summary/nextSteps; falls back deterministically on error.
 */
export async function deriveReview(ctx: RunContext): Promise<AgentReview> {
  const filesTouched = buildFilesTouched(ctx);
  const durationSec = Math.round(ctx.durationMs / 1000);

  // Collect progress update messages for the LLM prompt
  const progressUpdates = (ctx.progressUpdates ?? []).filter((s) => typeof s === "string");

  const promptCtx: ReviewPromptContext = {
    task: ctx.task,
    label: ctx.label,
    status: ctx.status,
    durationSec,
    filesTouched: filesTouched.map((f) => ({ path: f.path, action: f.action })),
    lastProgressUpdates: progressUpdates,
    workdir: ctx.workdir,
    errorMessage: ctx.errorMessage,
  };

  let llmResult: LLMReviewResult | null = null;
  try {
    llmResult = await callLLMForReview(promptCtx);
  } catch (err) {
    log.warn("auto-reviewer: callLLMForReview threw unexpectedly", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const { summary, nextSteps, blockers, confidence } = llmResult
    ? {
        summary: llmResult.summary,
        nextSteps: llmResult.nextSteps,
        blockers: llmResult.blockers,
        confidence: llmResult.confidence,
      }
    : buildDeterministicSummary(ctx, filesTouched);

  // Try to parse test results from progress updates
  let testsRun: AgentReview["testsRun"];
  const combinedText = progressUpdates.join("\n");
  const parsedTests = parseTestResultsFromText(combinedText);
  if (parsedTests) {
    testsRun = {
      name: "tests",
      passed: parsedTests.passed,
      failed: parsedTests.failed,
      skipped: parsedTests.skipped,
    };
  }

  const review: AgentReview = {
    id: randomUUID(),
    runId: ctx.runId,
    sessionKey: ctx.sessionKey,
    label: ctx.label,
    projectId: ctx.projectId,
    status: ctx.status,
    summary,
    filesTouched,
    testsRun,
    nextSteps,
    blockers,
    confidence: llmResult ? confidence : (confidence as "high" | "medium" | "low"),
    durationMs: ctx.durationMs,
    completedAt: ctx.completedAt,
    selfReported: false,
  };

  return review;
}
