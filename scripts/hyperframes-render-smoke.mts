#!/usr/bin/env node
/**
 * Phase 2 acceptance gate: render the seed composition via the new
 * hyperframes-backed pipeline, then ffprobe the output to confirm a
 * non-zero duration MP4 landed on disk.
 *
 *   pnpm exec tsx scripts/hyperframes-render-smoke.mts
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

import { resolveStateDir } from "../src/config/paths.js";
import { getCompositionsStore } from "../src/compositions/store.js";
import { startRender, getJob } from "../src/compositions/render.js";

async function main() {
  const stateDir = resolveStateDir();
  const store = getCompositionsStore(stateDir);
  const comps = store.list();
  if (comps.length === 0) {
    console.error("[smoke] no compositions found; seedDefaults should have run");
    process.exit(1);
  }
  // Prefer the seed "Welcome" composition (short, simple) over any
  // user-authored content that may pull large media or run minutes long.
  const comp = comps.find((c) => c.slug === "welcome" || c.name === "Welcome") ?? comps[0]!;
  console.log(`[smoke] rendering composition: ${comp.id} (${comp.name})`);

  const job = await startRender({ compositionId: comp.id });
  console.log(`[smoke] started render job ${job.id}, total frames target: ${comp.fps * comp.durationSec}`);

  const startedAt = Date.now();
  const timeoutMs = 5 * 60 * 1000; // 5 minutes
  while (true) {
    const j = getJob(job.id);
    if (!j) {
      console.error("[smoke] job vanished");
      process.exit(1);
    }
    if (j.status === "completed") {
      console.log(`[smoke] ✅ completed: ${j.outputPath}`);
      break;
    }
    if (j.status === "failed" || j.status === "cancelled") {
      console.error(`[smoke] ❌ ${j.status}: ${j.error ?? "(no error message)"}`);
      process.exit(2);
    }
    if (Date.now() - startedAt > timeoutMs) {
      console.error(`[smoke] timeout — last status: ${j.status}, progress: ${(j.progress * 100).toFixed(1)}%`);
      process.exit(3);
    }
    console.log(`[smoke] status=${j.status} progress=${(j.progress * 100).toFixed(1)}% frame=${j.frame}/${j.totalFrames}`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  const finalJob = getJob(job.id)!;
  const outPath = finalJob.outputPath!;
  if (!existsSync(outPath)) {
    console.error(`[smoke] output file missing: ${outPath}`);
    process.exit(4);
  }
  const stat = statSync(outPath);
  if (stat.size === 0) {
    console.error("[smoke] output file is empty");
    process.exit(5);
  }
  console.log(`[smoke] file size: ${stat.size} bytes`);

  // ffprobe duration sanity check.
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outPath],
    { encoding: "utf-8" },
  );
  if (probe.status !== 0) {
    console.error(`[smoke] ffprobe failed: ${probe.stderr}`);
    process.exit(6);
  }
  const duration = parseFloat(probe.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    console.error(`[smoke] non-positive duration from ffprobe: ${probe.stdout}`);
    process.exit(7);
  }
  console.log(`[smoke] ✅ ffprobe duration: ${duration.toFixed(2)}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] uncaught:", err);
  process.exit(99);
});
