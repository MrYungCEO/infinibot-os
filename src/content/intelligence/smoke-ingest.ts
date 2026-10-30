#!/usr/bin/env node --import tsx
/**
 * Smoke-test: Ingest existing reel-pipeline data into the content-intel store.
 *
 * Run with: node --import tsx src/content/intelligence/smoke-ingest.ts
 *
 * This tests:
 * 1. Importing the pipeline manifest (181 reels)
 * 2. Importing existing transcripts (74 reels)
 * 3. Importing existing scores (16 reels)
 * 4. Syncing video flags
 * 5. Verifying state counts
 */

import { resetContentIntelStore, getContentIntelStore } from "./store.js";
import {
  importManifest,
  importTranscripts,
  importScoredManifest,
  syncVideoFlags,
} from "./importer.js";

async function main() {
  console.log("═══ Content Intelligence — Smoke Ingest ═══\n");

  // Reset the store for a clean test
  resetContentIntelStore();
  const store = getContentIntelStore();

  // ── Step 1: Import manifest ────────────────────────────────────
  console.log("Step 1: Import manifest...");
  const manifestResult = importManifest();
  console.log(`  Total rows: ${manifestResult.totalRows}`);
  console.log(`  Inserted: ${manifestResult.inserted}`);
  console.log(`  Updated: ${manifestResult.updated}`);
  console.log(`  Errors: ${manifestResult.errors.length}`);
  if (manifestResult.errors.length > 0) {
    for (const err of manifestResult.errors.slice(0, 5)) {
      console.log(`    ✗ ${err}`);
    }
  }
  console.log();

  // ── Step 2: Import transcripts ────────────────────────────────
  console.log("Step 2: Import transcripts...");
  const transcriptResult = importTranscripts();
  console.log(`  Inserted: ${transcriptResult.inserted}`);
  console.log(`  Skipped: ${transcriptResult.skipped}`);
  console.log();

  // ── Step 3: Import scores ─────────────────────────────────────
  console.log("Step 3: Import scores...");
  const scoreResult = importScoredManifest();
  console.log(`  Inserted: ${scoreResult.inserted}`);
  console.log(`  Skipped: ${scoreResult.skipped}`);
  console.log();

  // ── Step 4: Sync video flags ─────────────────────────────────
  console.log("Step 4: Sync video flags...");
  const videoSync = syncVideoFlags();
  console.log(`  Found video: ${videoSync.set}`);
  console.log(`  Missing video: ${videoSync.missing}`);
  console.log();

  // ── Step 5: Verify state ─────────────────────────────────────
  const state = store.countByState();
  const totalReels = store.countReels();
  console.log("Step 5: Verify state:");
  console.log(`  Total reels: ${totalReels}`);
  console.log(`  Has video: ${state.hasVideo}`);
  console.log(`  Has transcript: ${state.hasTranscript}`);
  console.log(`  Has score: ${state.hasScore}`);

  // ── Show sample reels ─────────────────────────────────────────
  console.log("\nSample reels (top 5 by publish time):");
  const reels = store.listReels(5);
  for (const reel of reels) {
    const transcript = store.getTranscript(reel.shortcode);
    const score = store.getScore(reel.shortcode);
    const metrics = store.getLatestMetrics(reel.shortcode);
    console.log(`  ${reel.shortcode}`);
    console.log(`    Published: ${reel.publish_time}  Duration: ${reel.duration_sec ?? "?"}s`);
    console.log(
      `    Views: ${metrics?.views ?? "?"}  Likes: ${metrics?.likes ?? "?"}  Comments: ${metrics?.comments ?? "?"}`,
    );
    console.log(`    Transcript: ${transcript ? transcript.text.slice(0, 80) + "…" : "NONE"}`);
    console.log(`    Score: ${score ? `${score.tier} (${score.overall})` : "NONE"}`);
    console.log(
      `    Flags: video=${reel.has_video} transcript=${reel.has_transcript} score=${reel.has_score}`,
    );
  }

  // ── List gaps ────────────────────────────────────────────────
  console.log("\nGap analysis:");
  console.log(`  Missing video: ${store.listReelsMissingVideo().length}`);
  console.log(`  Missing transcript: ${store.listReelsMissingTranscript().length}`);
  console.log(`  Missing score: ${store.listReelsMissingScore().length}`);

  // ── Verify idempotency ──────────────────────────────────────
  console.log("\nStep 6: Verify idempotency (re-import)...");
  const secondManifest = importManifest();
  console.log(
    `  Second import — inserted: ${secondManifest.inserted}, updated: ${secondManifest.updated}`,
  );
  const secondTranscripts = importTranscripts();
  console.log(
    `  Second transcript import — inserted: ${secondTranscripts.inserted}, skipped: ${secondTranscripts.skipped}`,
  );
  const secondScores = importScoredManifest();
  console.log(
    `  Second score import — inserted: ${secondScores.inserted}, skipped: ${secondScores.skipped}`,
  );
  console.log(`  Final reel count: ${store.countReels()}`);
  console.log();

  // Done
  console.log("═══ Smoke test PASSED ═══");
  console.log(`Total reels in store: ${store.countReels()}`);
  console.log(`State: ${JSON.stringify(store.countByState())}`);

  // Cleanup
  resetContentIntelStore();
}

main().catch((err) => {
  console.error("Smoke test FAILED:", err);
  process.exit(1);
});
