/**
 * Notes pipeline CLI — one command from raw clip to cut + hyperframes JSON.
 *
 *   bun src/compositions/notes-pipeline.ts \
 *     --input ~/Videos/raw.mp4 \
 *     --out   ~/Videos/cut.mp4 \
 *     [--speaches http://localhost:8002] \
 *     [--model deepdml/faster-whisper-large-v3-turbo-ct2] \
 *     [--language en] \
 *     [--max-gap 0.45] \
 *     [--no-cut]   # just transcribe + write JSON, skip ffmpeg
 *
 * Writes alongside the output:
 *   <out>.words.src.json   — source-time word timestamps
 *   <out>.words.cut.json   — cut-timeline word timestamps (feed hyperframes)
 *   <out>.cutlist.json     — keep/remove spans for debugging
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { transcribeWithSpeaches } from "./transcribe-speaches.js";
import { renderCut, buildCutlist } from "./notes-cutter.js";

interface CliArgs {
  input: string;
  out: string;
  speaches?: string;
  model?: string;
  language?: string;
  maxGap?: number;
  noCut?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--input":
        out.input = next();
        break;
      case "--out":
        out.out = next();
        break;
      case "--speaches":
        out.speaches = next();
        break;
      case "--model":
        out.model = next();
        break;
      case "--language":
        out.language = next();
        break;
      case "--max-gap":
        out.maxGap = Number(next());
        break;
      case "--no-cut":
        out.noCut = true;
        break;
    }
  }
  if (!out.input || !out.out) {
    throw new Error("Usage: notes-pipeline --input <src> --out <cut.mp4> [...]");
  }
  return out as CliArgs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = resolve(args.input);
  const output = resolve(args.out);

  console.log(`[1/3] transcribe via Speaches → ${args.speaches ?? "http://localhost:8002"}`);
  const t0 = Date.now();
  const stt = await transcribeWithSpeaches({
    filePath: input,
    baseUrl: args.speaches,
    model: args.model,
    language: args.language,
  });
  console.log(
    `      ${stt.words.length} words, lang=${stt.language ?? "?"}, dur=${stt.duration ?? "?"}s, took ${Date.now() - t0}ms`,
  );

  writeFileSync(`${output}.words.src.json`, JSON.stringify(stt.words, null, 2));

  console.log(`[2/3] build cutlist (filler + repeats + silence)`);
  const plan = buildCutlist({
    input,
    output,
    words: stt.words,
    maxGapSec: args.maxGap,
    durationSec: stt.duration,
  });
  writeFileSync(
    `${output}.cutlist.json`,
    JSON.stringify(
      { keep: plan.keep, removed: plan.removed, cutDurationSec: plan.cutDurationSec },
      null,
      2,
    ),
  );
  writeFileSync(`${output}.words.cut.json`, JSON.stringify(plan.cutWords, null, 2));
  console.log(
    `      keep=${plan.keep.length} spans, removed=${plan.removed.length}, cutDuration=${plan.cutDurationSec.toFixed(2)}s`,
  );

  if (args.noCut) {
    console.log(`[3/3] --no-cut set; skipping ffmpeg`);
    return;
  }

  console.log(`[3/3] ffmpeg concat → ${output}`);
  const result = await renderCut({
    input,
    output,
    words: stt.words,
    maxGapSec: args.maxGap,
    durationSec: stt.duration,
  });
  console.log(`      wrote ${result.outputPath} (${result.cutDurationSec.toFixed(2)}s)`);
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? err);
  process.exit(1);
});
