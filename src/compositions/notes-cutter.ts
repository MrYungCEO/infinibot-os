/**
 * Notes cutter — turn spoken editor notes into a clean cut.
 *
 * Input: a video/audio file + the word-level transcript from Speaches.
 * Output: a `keep_ranges` cutlist (seconds, source-relative), an ffmpeg
 * concat-cut MP4, and the same word list with timestamps rebased to the
 * cut timeline so hyperframes / captions stay in sync.
 *
 * Detection passes:
 *   1. Filler tokens   — "um", "uh", "like", "you know", "i mean", "so" …
 *   2. Repeats         — same lemma repeated within `repeatWindowSec`
 *   3. Dead air        — silence gaps between words longer than `maxGapSec`
 *
 * The cutter is intentionally conservative: it keeps a small head/tail
 * pad around each kept range so cuts don't clip consonants, and merges
 * adjacent kept ranges that share less than `mergeBelowSec` of removal.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createSubsystemLogger } from "../logging/subsystem.js";

import type { CaptionWord } from "./types.js";

const log = createSubsystemLogger("notes-cutter");

// ── Defaults ──────────────────────────────────────────────────────

export const DEFAULT_FILLERS = new Set([
  "um",
  "uh",
  "umm",
  "uhh",
  "uhm",
  "er",
  "erm",
  "ah",
  "eh",
  "hm",
  "hmm",
  "like",
  "literally",
  "basically",
  "essentially",
  "actually",
  "so",
  "right",
  "okay",
  "ok",
  "yeah",
  "well",
]);

/** Multi-word filler phrases — matched as a sliding window. */
export const DEFAULT_FILLER_PHRASES: string[][] = [
  ["you", "know"],
  ["i", "mean"],
  ["kind", "of"],
  ["sort", "of"],
];

export interface CutOptions {
  /** Source media file (video or audio). */
  input: string;
  /** Destination cut MP4 path. */
  output: string;
  /** Word-level transcript from Speaches (source-time). */
  words: CaptionWord[];

  /** Token blacklist (lowercase, no punctuation). Defaults to DEFAULT_FILLERS. */
  fillers?: Set<string>;
  /** Phrase blacklist. Defaults to DEFAULT_FILLER_PHRASES. */
  fillerPhrases?: string[][];

  /** Cut a same-lemma repeat that lands within this many seconds (default 1.2). */
  repeatWindowSec?: number;
  /** Cut silence gaps longer than this (default 0.45s). */
  maxGapSec?: number;
  /** Head pad before a kept word (seconds, default 0.06). */
  headPadSec?: number;
  /** Tail pad after a kept word (default 0.08). */
  tailPadSec?: number;
  /** Merge kept ranges if the gap between them is below this (default 0.12). */
  mergeBelowSec?: number;

  /** Duration of the source media, in seconds (used to clamp the last range). */
  durationSec?: number;
  /** Re-encode codec preset for the concat (default "libx264 -preset veryfast"). */
  videoCodec?: string;
  /** Audio codec (default "aac -b:a 192k"). */
  audioCodec?: string;
}

export interface CutSpan {
  start: number; // source-time, seconds
  end: number;
}

export interface CutResult {
  /** Ranges from source we kept (chronological, non-overlapping). */
  keep: CutSpan[];
  /** Ranges removed from source (filler / repeat / silence), for telemetry. */
  removed: { span: CutSpan; reason: "filler" | "repeat" | "silence" }[];
  /** Word list with timestamps rebased to the cut timeline. */
  cutWords: CaptionWord[];
  /** Final duration of the cut, in seconds. */
  cutDurationSec: number;
  /** Output path written by ffmpeg. */
  outputPath: string;
}

// ── Detection ─────────────────────────────────────────────────────

interface DropFlag {
  reason: "filler" | "repeat";
}

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, "");
}

function flagFillersAndRepeats(
  words: CaptionWord[],
  fillers: Set<string>,
  phrases: string[][],
  repeatWindowSec: number,
): Map<number, DropFlag> {
  const flags = new Map<number, DropFlag>();
  const norm = words.map((w) => normalize(w.word));

  // Single-token fillers.
  norm.forEach((n, i) => {
    if (n && fillers.has(n)) flags.set(i, { reason: "filler" });
  });

  // Multi-word filler phrases.
  for (const phrase of phrases) {
    if (!phrase.length) continue;
    outer: for (let i = 0; i <= norm.length - phrase.length; i++) {
      for (let k = 0; k < phrase.length; k++) {
        if (norm[i + k] !== phrase[k]) continue outer;
      }
      for (let k = 0; k < phrase.length; k++) {
        flags.set(i + k, { reason: "filler" });
      }
    }
  }

  // Repeats — same lemma within window.
  for (let i = 1; i < words.length; i++) {
    const cur = norm[i];
    if (!cur || flags.has(i)) continue;
    // Walk back over already-flagged words to find the nearest spoken neighbor.
    let j = i - 1;
    while (j >= 0 && flags.has(j)) j--;
    if (j < 0) continue;
    if (norm[j] !== cur) continue;
    if (words[i].start - words[j].end > repeatWindowSec) continue;
    // Drop the earlier instance — keeps the cleaner re-take.
    flags.set(j, { reason: "repeat" });
  }

  return flags;
}

// ── Cutlist build ─────────────────────────────────────────────────

export function buildCutlist(opts: CutOptions): Omit<CutResult, "outputPath"> {
  const fillers = opts.fillers ?? DEFAULT_FILLERS;
  const phrases = opts.fillerPhrases ?? DEFAULT_FILLER_PHRASES;
  const repeatWindow = opts.repeatWindowSec ?? 1.2;
  const maxGap = opts.maxGapSec ?? 0.45;
  const headPad = opts.headPadSec ?? 0.06;
  const tailPad = opts.tailPadSec ?? 0.08;
  const mergeBelow = opts.mergeBelowSec ?? 0.12;

  const words = opts.words.slice().sort((a, b) => a.start - b.start);
  if (!words.length) {
    return { keep: [], removed: [], cutWords: [], cutDurationSec: 0 };
  }

  const flags = flagFillersAndRepeats(words, fillers, phrases, repeatWindow);
  const kept = words.map((w, i) => ({ w, i })).filter(({ i }) => !flags.has(i));

  // Build keep spans from consecutive kept words, splitting on long silences.
  const spans: CutSpan[] = [];
  const removed: CutResult["removed"] = [];
  let curStart = Math.max(0, kept[0].w.start - headPad);
  let curEnd = kept[0].w.end + tailPad;

  for (let k = 1; k < kept.length; k++) {
    const prev = kept[k - 1].w;
    const next = kept[k].w;
    const gap = next.start - prev.end;
    if (gap > maxGap) {
      spans.push({ start: curStart, end: curEnd });
      removed.push({
        span: { start: prev.end, end: next.start },
        reason: "silence",
      });
      curStart = Math.max(0, next.start - headPad);
      curEnd = next.end + tailPad;
    } else {
      curEnd = next.end + tailPad;
    }
  }
  spans.push({ start: curStart, end: curEnd });

  // Record filler/repeat removals from flagged words.
  for (let i = 0; i < words.length; i++) {
    const flag = flags.get(i);
    if (!flag) continue;
    removed.push({
      span: { start: words[i].start, end: words[i].end },
      reason: flag.reason,
    });
  }

  // Merge spans whose gap is below mergeBelow (cleaner cuts, fewer concat seams).
  const merged: CutSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start - last.end < mergeBelow) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  // Clamp to source duration.
  if (opts.durationSec != null) {
    for (const s of merged) {
      s.end = Math.min(s.end, opts.durationSec);
    }
  }

  // Rebase words onto cut timeline.
  const cutWords: CaptionWord[] = [];
  let offset = 0;
  for (const span of merged) {
    for (const w of words) {
      if (w.start >= span.start && w.end <= span.end && !flags.has(words.indexOf(w))) {
        cutWords.push({
          word: w.word,
          start: offset + (w.start - span.start),
          end: offset + (w.end - span.start),
        });
      }
    }
    offset += span.end - span.start;
  }

  return { keep: merged, removed, cutWords, cutDurationSec: offset };
}

// ── ffmpeg concat ─────────────────────────────────────────────────

export async function renderCut(opts: CutOptions): Promise<CutResult> {
  if (!existsSync(opts.input)) {
    throw new Error(`Input not found: ${opts.input}`);
  }
  const plan = buildCutlist(opts);
  if (!plan.keep.length) {
    throw new Error("Cutlist is empty — nothing to render.");
  }

  mkdirSync(dirname(opts.output), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "notes-cut-"));
  const partPaths: string[] = [];

  // Cut each kept span into its own file so concat doesn't re-encode the
  // whole source twice. Each part is encoded once, then stream-copied at
  // concat time.
  const vCodec = opts.videoCodec ?? "libx264 -preset veryfast -crf 18";
  const aCodec = opts.audioCodec ?? "aac -b:a 192k";

  for (let i = 0; i < plan.keep.length; i++) {
    const span = plan.keep[i];
    const part = join(work, `part-${String(i).padStart(4, "0")}.mp4`);
    await runFfmpeg([
      "-y",
      "-ss",
      String(span.start),
      "-to",
      String(span.end),
      "-i",
      opts.input,
      "-c:v",
      ...vCodec.split(" "),
      "-c:a",
      ...aCodec.split(" "),
      "-movflags",
      "+faststart",
      part,
    ]);
    partPaths.push(part);
  }

  const listPath = join(work, "concat.txt");
  writeFileSync(
    listPath,
    partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
    "utf-8",
  );

  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    opts.output,
  ]);

  log.info(
    `notes-cut rendered input=${opts.input} output=${opts.output} keptSpans=${plan.keep.length} removed=${plan.removed.length} cutDurationSec=${plan.cutDurationSec.toFixed(2)}`,
  );

  return { ...plan, outputPath: opts.output };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-600)}`));
    });
  });
}
