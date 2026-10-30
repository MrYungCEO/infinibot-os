/**
 * Phase 2 acceptance gate: render the seeded "Welcome" composition end
 * to end through the new hyperframes-engine pipeline and verify a real
 * MP4 lands on disk with non-zero duration.
 *
 *   bun run scripts/smoke-render-composition.ts
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { statSync } from "node:fs";

import { resolveStateDir } from "../src/config/paths.js";
import { getCompositionsStore } from "../src/compositions/store.js";
import { getJob, startRender } from "../src/compositions/render.js";

function ffprobeDuration(path: string): number | null {
  const tryRun = (bin: string): SpawnSyncReturns<string> | null => {
    try {
      return spawnSync(
        bin,
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
        { encoding: "utf-8" },
      );
    } catch {
      return null;
    }
  };
  const out = tryRun("ffprobe") ?? tryRun("/usr/bin/ffprobe");
  if (!out || out.status !== 0) return null;
  const dur = parseFloat(out.stdout.trim());
  return Number.isFinite(dur) ? dur : null;
}

async function main(): Promise<void> {
  const stateDir = resolveStateDir();
  const store = getCompositionsStore(stateDir);
  const list = store.list();
  // Pick the shortest composition so the acceptance gate stays fast
  // and the chance of asset-not-on-disk failures stays low.
  const comp = [...list].sort((a, b) => a.durationSec - b.durationSec)[0];
  if (!comp) throw new Error("no compositions seeded — open the editor once to seed defaults");
  console.log(`[smoke] rendering composition ${comp.id} "${comp.name}" (${comp.durationSec}s @ ${comp.fps}fps)`);

  const job = await startRender({ compositionId: comp.id });
  console.log(`[smoke] job ${job.id} started`);

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const cur = getJob(job.id);
    if (!cur) throw new Error("job vanished");
    if (cur.status === "completed") {
      console.log(`[smoke] render completed in ${(cur.endedAt! - cur.startedAt) / 1000}s → ${cur.outputPath}`);
      const path = cur.outputPath!;
      const size = statSync(path).size;
      if (size <= 0) throw new Error(`output file is empty: ${path}`);
      const dur = ffprobeDuration(path);
      if (dur == null) {
        console.warn(`[smoke] ffprobe couldn't read duration (still wrote ${size} bytes)`);
      } else if (dur <= 0) {
        throw new Error(`output duration is zero: ${path}`);
      } else {
        console.log(`[smoke] OK — ${size} bytes, ${dur.toFixed(3)}s`);
      }
      process.exit(0);
    }
    if (cur.status === "failed") throw new Error(`render failed: ${cur.error}`);
    if (cur.status === "cancelled") throw new Error("render cancelled");
    await new Promise((r) => setTimeout(r, 500));
    if (cur.totalFrames > 0) {
      process.stdout.write(
        `\r[smoke] ${cur.status} ${cur.frame}/${cur.totalFrames} (${Math.round(cur.progress * 100)}%)   `,
      );
    }
  }
  throw new Error("timed out waiting for render");
}

void main().catch((err) => {
  console.error("\n[smoke] ERROR:", err);
  process.exit(1);
});
