#!/usr/bin/env node
/**
 * reviews-backfill.mjs
 *
 * Walk existing subagent history and generate auto-reviews for the last 100
 * runs that don't already have one. Run once after deploying the review system
 * to retroactively populate reviews for today's completed spawns.
 *
 * Usage:
 *   node scripts/reviews-backfill.mjs [--limit=100] [--dry-run]
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Enable TypeScript resolution via tsx so we can import .ts source directly.
// Falls back to the compiled dist/ if tsx is not available.
let tsxAvailable = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  tsxAvailable = true;
} catch {
  // tsx not installed — expect the repo to have been built
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.slice("--limit=".length), 10) : 100;

console.log(`[reviews-backfill] Starting. limit=${limit} dryRun=${dryRun} tsx=${tsxAvailable}`);

async function main() {
  // Import the review system. If tsx is available we load from src/, else dist/.
  const base = tsxAvailable ? "../src" : "../dist";

  const { listSubagentHistory } = await import(`${base}/agents/subagent-history.js`);
  const { hasReviewForRun } = await import(`${base}/agents/reviews/index.js`);
  const { autoReview } = await import(`${base}/agents/auto-reviewer/index.js`);

  const { entries } = listSubagentHistory({ limit, since: 0 });

  const toReview = entries.filter((e) => !hasReviewForRun(e.runId));
  console.log(
    `[reviews-backfill] Found ${entries.length} history entries, ${toReview.length} without reviews.`,
  );

  if (toReview.length === 0) {
    console.log("[reviews-backfill] Nothing to do.");
    return;
  }

  let succeeded = 0;
  let failed = 0;

  for (const entry of toReview) {
    process.stdout.write(`  → ${entry.runId} (${entry.label ?? entry.task.slice(0, 60)}) ... `);
    if (dryRun) {
      console.log("SKIP (dry-run)");
      continue;
    }
    try {
      await autoReview(entry.runId);
      const { getReviewByRunId } = await import(`${base}/agents/reviews/index.js`);
      const review = getReviewByRunId(entry.runId);
      if (review) {
        console.log(`OK [${review.confidence}] ${review.summary.slice(0, 80)}`);
        succeeded++;
      } else {
        console.log("WARN: autoReview completed but no review found");
        failed++;
      }
    } catch (err) {
      console.log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
    // Throttle to avoid hammering the LLM API
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `[reviews-backfill] Done. succeeded=${succeeded} failed=${failed} skipped=${dryRun ? toReview.length : 0}`,
  );
}

main().catch((err) => {
  console.error("[reviews-backfill] Fatal:", err);
  process.exit(1);
});
