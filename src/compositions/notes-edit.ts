/**
 * notes-edit — agentic, resumable, preview-first cut pipeline for spoken
 * editor notes. Designed to be called repeatedly on the same job: every
 * step checks its own outputs and skips if up-to-date, so Vince (or the
 * user) can iterate freely.
 *
 * Job layout (one per source clip):
 *   <workspace>/jobs/<slug>/
 *     manifest.json     — job state: input path, params, step hashes
 *     audio.flac        — 16kHz mono extract (Speaches input)
 *     proxy.mp4         — 480p low-bitrate proxy (fast preview cuts)
 *     words.raw.json    — Speaches verbose_json
 *     edl.json          — editable decision list (HAND-TWEAKABLE)
 *     cutlist.json      — span list derived from EDL
 *     words.cut.json    — words rebased to cut timeline
 *     cut.proxy.mp4     — preview cut from proxy (renders in seconds)
 *     cut.mp4           — final full-res cut
 *     hyperframes.json  — motion-graphics keyframes for the cut timeline
 *     history.log       — audit trail (one line per step run)
 *
 * Steps (idempotent, dependency-ordered):
 *   init → extract-audio → proxy → transcribe → analyze → preview → render → hyperframes
 *
 * CLI:
 *   bun src/compositions/notes-edit.ts init    <input.mp4> [--slug X] [--workspace DIR]
 *   bun src/compositions/notes-edit.ts run     <slug> [--through STEP] [--workspace DIR]
 *   bun src/compositions/notes-edit.ts step    <slug> <step>
 *   bun src/compositions/notes-edit.ts preview <slug>      # quick proxy cut
 *   bun src/compositions/notes-edit.ts edl     <slug>      # print EDL path
 *   bun src/compositions/notes-edit.ts status  <slug>
 *   bun src/compositions/notes-edit.ts list
 *
 * Hand-tweak loop:
 *   1. `notes-edit run <slug> --through analyze`
 *   2. Edit `<workspace>/jobs/<slug>/edl.json`
 *   3. `notes-edit preview <slug>` → watch cut.proxy.mp4
 *   4. Repeat 2–3. When happy, `notes-edit run <slug>` for final.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import { transcribeWithSpeaches } from "./transcribe-speaches.js";
import { buildCutlist, DEFAULT_FILLERS } from "./notes-cutter.js";
import { jobsToProject, writeProjectJson } from "./notes-edit-storyboard.js";

import type { CaptionWord } from "./types.js";

// ── Workspace ────────────────────────────────────────────────────────

const DEFAULT_WORKSPACE =
  process.env.NOTES_EDIT_WORKSPACE ??
  (process.env.INFINIBOT_STATE_DIR
    ? `${process.env.INFINIBOT_STATE_DIR}/video/.notes-edit`
    : `${process.env.HOME}/Infini/.notes-edit`);

// ── Manifest ─────────────────────────────────────────────────────────

export type StepName =
  | "hyperframes-project"
  | "init"
  | "extract-audio"
  | "proxy"
  | "transcribe"
  | "analyze"
  | "preview"
  | "render"
  | "hyperframes";

export const STEP_ORDER: StepName[] = [
  "init",
  "extract-audio",
  "proxy",
  "transcribe",
  "analyze",
  "preview",
  "render",
  "hyperframes",
  "hyperframes-project",
];

export interface ManifestStep {
  done: boolean;
  at?: string;
  /** Output paths produced. */
  outputs?: string[];
  /** Hash of inputs that produced this step (for invalidation). */
  inputHash?: string;
  note?: string;
}

export interface Manifest {
  slug: string;
  input: string;
  workspace: string;
  durationSec?: number;
  createdAt: string;
  params: {
    speachesUrl: string;
    whisperModel: string;
    language?: string;
    proxyHeight: number;
    proxyCrf: number;
    maxGapSec: number;
    repeatWindowSec: number;
    headPadSec: number;
    tailPadSec: number;
    mergeBelowSec: number;
    fillers: string[];
  };
  steps: Record<StepName, ManifestStep>;
}

const DEFAULT_PARAMS: Manifest["params"] = {
  speachesUrl: process.env.SPEACHES_URL ?? "http://localhost:8002",
  whisperModel: process.env.SPEACHES_MODEL ?? "deepdml/faster-whisper-large-v3-turbo-ct2",
  language: "en",
  proxyHeight: 480,
  proxyCrf: 30,
  maxGapSec: 0.45,
  repeatWindowSec: 1.2,
  headPadSec: 0.06,
  tailPadSec: 0.08,
  mergeBelowSec: 0.12,
  fillers: [...DEFAULT_FILLERS],
};

function manifestPath(workspace: string, slug: string): string {
  return join(workspace, "jobs", slug, "manifest.json");
}

function jobDir(workspace: string, slug: string): string {
  return join(workspace, "jobs", slug);
}

function loadManifest(workspace: string, slug: string): Manifest {
  const p = manifestPath(workspace, slug);
  if (!existsSync(p)) throw new Error(`Manifest not found: ${p}`);
  return JSON.parse(readFileSync(p, "utf-8")) as Manifest;
}

function saveManifest(m: Manifest): void {
  writeFileSync(manifestPath(m.workspace, m.slug), JSON.stringify(m, null, 2));
}

function logHistory(m: Manifest, line: string): void {
  const p = join(jobDir(m.workspace, m.slug), "history.log");
  appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`);
}

function emptySteps(): Manifest["steps"] {
  return Object.fromEntries(
    STEP_ORDER.map((s) => [s, { done: false } as ManifestStep]),
  ) as Manifest["steps"];
}

// ── Step: init ───────────────────────────────────────────────────────

export async function stepInit(
  input: string,
  opts: { slug?: string; workspace?: string } = {},
): Promise<Manifest> {
  const ws = resolve(opts.workspace ?? DEFAULT_WORKSPACE);
  const slug =
    opts.slug ??
    basename(input)
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-");
  const dir = jobDir(ws, slug);
  mkdirSync(dir, { recursive: true });

  const duration = await ffprobeDuration(input);
  const m: Manifest = {
    slug,
    input: resolve(input),
    workspace: ws,
    durationSec: duration,
    createdAt: new Date().toISOString(),
    params: { ...DEFAULT_PARAMS },
    steps: emptySteps(),
  };
  m.steps.init = { done: true, at: new Date().toISOString() };
  saveManifest(m);
  logHistory(m, `init slug=${slug} input=${input} duration=${duration}s`);
  return m;
}

// ── Step: extract-audio ──────────────────────────────────────────────

export async function stepExtractAudio(m: Manifest): Promise<void> {
  const out = join(jobDir(m.workspace, m.slug), "audio.flac");
  if (m.steps["extract-audio"].done && existsSync(out)) return;
  await ffmpeg([
    "-y",
    "-i",
    m.input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "flac",
    "-compression_level",
    "5",
    out,
  ]);
  m.steps["extract-audio"] = {
    done: true,
    at: new Date().toISOString(),
    outputs: [out],
  };
  saveManifest(m);
  logHistory(m, `extract-audio → ${out}`);
}

// ── Step: proxy ──────────────────────────────────────────────────────

export async function stepProxy(m: Manifest): Promise<void> {
  const out = join(jobDir(m.workspace, m.slug), "proxy.mp4");
  if (m.steps.proxy.done && existsSync(out)) return;
  await ffmpeg([
    "-y",
    "-i",
    m.input,
    "-vf",
    `scale=-2:${m.params.proxyHeight}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(m.params.proxyCrf),
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    out,
  ]);
  m.steps.proxy = { done: true, at: new Date().toISOString(), outputs: [out] };
  saveManifest(m);
  logHistory(m, `proxy → ${out}`);
}

// ── Step: transcribe ─────────────────────────────────────────────────

export async function stepTranscribe(m: Manifest): Promise<void> {
  const audio = join(jobDir(m.workspace, m.slug), "audio.flac");
  const out = join(jobDir(m.workspace, m.slug), "words.raw.json");
  if (m.steps.transcribe.done && existsSync(out)) return;
  if (!existsSync(audio)) throw new Error(`Audio missing — run extract-audio first`);

  const result = await transcribeWithSpeaches({
    filePath: audio,
    baseUrl: m.params.speachesUrl,
    model: m.params.whisperModel,
    language: m.params.language,
  });
  writeFileSync(
    out,
    JSON.stringify(
      { language: result.language, duration: result.duration, words: result.words },
      null,
      2,
    ),
  );
  m.steps.transcribe = {
    done: true,
    at: new Date().toISOString(),
    outputs: [out],
    note: `${result.words.length} words`,
  };
  saveManifest(m);
  logHistory(m, `transcribe → ${out} (${result.words.length} words)`);
}

// ── Step: analyze (writes editable EDL) ──────────────────────────────

export interface EdlEntry {
  /** Source-time start (seconds). */
  start: number;
  /** Source-time end (seconds). */
  end: number;
  /** keep | drop. User can flip these by hand. */
  action: "keep" | "drop";
  /** Why this entry was created — auto fields are advisory. */
  reason?: "filler" | "repeat" | "silence" | "speech" | "manual";
  /** Original transcript text inside this span (for human reading). */
  text?: string;
}

export async function stepAnalyze(m: Manifest): Promise<void> {
  const dir = jobDir(m.workspace, m.slug);
  const wordsPath = join(dir, "words.raw.json");
  const edlPath = join(dir, "edl.json");
  const cutlistPath = join(dir, "cutlist.json");
  const cutWordsPath = join(dir, "words.cut.json");

  if (!existsSync(wordsPath)) throw new Error("Transcript missing — run transcribe");
  const payload = JSON.parse(readFileSync(wordsPath, "utf-8")) as {
    duration?: number;
    words: CaptionWord[];
  };

  const plan = buildCutlist({
    input: m.input,
    output: "(planning)",
    words: payload.words,
    maxGapSec: m.params.maxGapSec,
    repeatWindowSec: m.params.repeatWindowSec,
    headPadSec: m.params.headPadSec,
    tailPadSec: m.params.tailPadSec,
    mergeBelowSec: m.params.mergeBelowSec,
    fillers: new Set(m.params.fillers),
    durationSec: payload.duration ?? m.durationSec,
  });

  // Only (re)write EDL if user hasn't hand-edited it.
  const edl = buildEdl(payload.words, plan);
  if (!existsSync(edlPath) || isAutoEdl(edlPath)) {
    writeFileSync(edlPath, JSON.stringify({ auto: true, entries: edl }, null, 2));
  }
  writeFileSync(
    cutlistPath,
    JSON.stringify(
      { keep: plan.keep, removed: plan.removed, cutDurationSec: plan.cutDurationSec },
      null,
      2,
    ),
  );
  writeFileSync(cutWordsPath, JSON.stringify(plan.cutWords, null, 2));

  // Provider-neutral projection: one StoryboardProject per clip (keeps only).
  const project = jobsToProject([{ manifest: m, entries: edl }], {
    projectId: `notes-edit-${m.slug}`,
  });
  writeProjectJson(dir, project);

  m.steps.analyze = {
    done: true,
    at: new Date().toISOString(),
    outputs: [edlPath, cutlistPath, cutWordsPath, join(dir, "project.storyboard.json")],
    note: `keep ${plan.keep.length} spans, cut ${plan.cutDurationSec.toFixed(1)}s`,
  };
  saveManifest(m);
  logHistory(m, `analyze → ${plan.keep.length} keeps, ${plan.cutDurationSec.toFixed(1)}s cut`);
}

function buildEdl(words: CaptionWord[], plan: ReturnType<typeof buildCutlist>): EdlEntry[] {
  const merged: EdlEntry[] = [];
  for (const k of plan.keep) {
    merged.push({
      start: k.start,
      end: k.end,
      action: "keep",
      reason: "speech",
      text: wordsBetween(words, k.start, k.end),
    });
  }
  for (const r of plan.removed) {
    merged.push({
      start: r.span.start,
      end: r.span.end,
      action: "drop",
      reason: r.reason,
      text: wordsBetween(words, r.span.start, r.span.end),
    });
  }
  return merged.sort((a, b) => a.start - b.start);
}

function wordsBetween(words: CaptionWord[], a: number, b: number): string {
  return words
    .filter((w) => w.start >= a && w.end <= b)
    .map((w) => w.word)
    .join(" ");
}

function isAutoEdl(path: string): boolean {
  try {
    const j = JSON.parse(readFileSync(path, "utf-8")) as { auto?: boolean };
    return j.auto === true;
  } catch {
    return true;
  }
}

// ── Step: preview (proxy cut) ────────────────────────────────────────

export async function stepPreview(m: Manifest): Promise<void> {
  const dir = jobDir(m.workspace, m.slug);
  const proxy = join(dir, "proxy.mp4");
  const edlPath = join(dir, "edl.json");
  const out = join(dir, "cut.proxy.mp4");

  if (!existsSync(proxy)) throw new Error("Proxy missing — run proxy first");
  if (!existsSync(edlPath)) throw new Error("EDL missing — run analyze first");

  const edl = JSON.parse(readFileSync(edlPath, "utf-8")) as { entries: EdlEntry[] };
  const keeps = edl.entries.filter((e) => e.action === "keep");

  await ffmpegConcat(proxy, keeps, out, {
    videoArgs: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"],
    audioArgs: ["-c:a", "aac", "-b:a", "96k"],
  });
  m.steps.preview = {
    done: true,
    at: new Date().toISOString(),
    outputs: [out],
    note: `${keeps.length} keeps → ${out}`,
  };
  saveManifest(m);
  logHistory(m, `preview → ${out}`);
}

// ── Step: render (full-res cut) ──────────────────────────────────────

export async function stepRender(m: Manifest): Promise<void> {
  const dir = jobDir(m.workspace, m.slug);
  const edlPath = join(dir, "edl.json");
  const out = join(dir, "cut.mp4");
  if (!existsSync(edlPath)) throw new Error("EDL missing — run analyze first");

  const edl = JSON.parse(readFileSync(edlPath, "utf-8")) as { entries: EdlEntry[] };
  const keeps = edl.entries.filter((e) => e.action === "keep");

  await ffmpegConcat(m.input, keeps, out, {
    videoArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"],
    audioArgs: ["-c:a", "aac", "-b:a", "192k"],
  });
  m.steps.render = {
    done: true,
    at: new Date().toISOString(),
    outputs: [out],
    note: `${keeps.length} keeps → ${out}`,
  };
  saveManifest(m);
  logHistory(m, `render → ${out}`);
}

// ── Step: hyperframes ────────────────────────────────────────────────

export async function stepHyperframes(m: Manifest): Promise<void> {
  const dir = jobDir(m.workspace, m.slug);
  const wordsCutPath = join(dir, "words.cut.json");
  const out = join(dir, "hyperframes.json");
  if (!existsSync(wordsCutPath)) throw new Error("words.cut.json missing — run analyze");

  const words = JSON.parse(readFileSync(wordsCutPath, "utf-8")) as CaptionWord[];
  // Emit a simple, hyperframes-translator-friendly motion-graphics descriptor:
  // one "pop" overlay per emphasized word, plus a per-cue caption track.
  const emphasized = words.filter((w) => w.word.length >= 6 || /[!?]/.test(w.word));
  const descriptor = {
    version: 1,
    captionTrack: words.map((w) => ({ start: w.start, end: w.end, text: w.word })),
    overlays: emphasized.map((w) => ({
      kind: "wordPop" as const,
      text: w.word,
      start: w.start,
      end: w.end,
      preset: "scalePunch", // matches motion-presets.ts
    })),
  };
  writeFileSync(out, JSON.stringify(descriptor, null, 2));
  m.steps.hyperframes = {
    done: true,
    at: new Date().toISOString(),
    outputs: [out],
    note: `${descriptor.overlays.length} word pops, ${descriptor.captionTrack.length} caption cues`,
  };
  saveManifest(m);
  logHistory(m, `hyperframes → ${out}`);
}

// ── Step: hyperframes-project ────────────────────────────────────────
// Installs a Hyperframes Studio project that loads every analyzed clip
// in the workspace, so the local motion-graphics editor at
//   http://localhost:5190/#projectId=notes-edit
// can preview / extend the cut. Idempotent: re-running rewrites
// index.html and symlinks but reuses the audio concat unless missing.

export async function stepHyperframesProject(m: Manifest): Promise<void> {
  const { installHyperframesProject } = await import("./notes-edit-hyperframes/install.js");
  const r = await installHyperframesProject({ workspace: m.workspace });
  m.steps["hyperframes-project"] = {
    done: true,
    at: new Date().toISOString(),
    outputs: [r.projectDir],
    note: `${r.sourceClipCount} clips, ${r.cutDurationSec.toFixed(1)}s · ${r.studioUrl}`,
  };
  saveManifest(m);
  logHistory(m, `hyperframes-project → ${r.projectDir} (${r.studioUrl})`);
}

// ── Orchestration ────────────────────────────────────────────────────

const STEP_FNS: Record<Exclude<StepName, "init">, (m: Manifest) => Promise<void>> = {
  "extract-audio": stepExtractAudio,
  proxy: stepProxy,
  transcribe: stepTranscribe,
  analyze: stepAnalyze,
  preview: stepPreview,
  render: stepRender,
  hyperframes: stepHyperframes,
  "hyperframes-project": stepHyperframesProject,
};

export async function runThrough(m: Manifest, through: StepName = "hyperframes"): Promise<void> {
  const targetIdx = STEP_ORDER.indexOf(through);
  for (let i = 1; i <= targetIdx; i++) {
    const step = STEP_ORDER[i];
    const fn = STEP_FNS[step as Exclude<StepName, "init">];
    process.stdout.write(`  → ${step} ... `);
    const t0 = Date.now();
    try {
      await fn(m);
      console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      console.log(`FAILED`);
      throw err;
    }
  }
}

// ── ffmpeg helpers ───────────────────────────────────────────────────

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolveP, reject) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolveP() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-600)}`)),
    );
  });
}

async function ffprobeDuration(input: string): Promise<number> {
  return new Promise((resolveP, reject) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      input,
    ]);
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolveP(parseFloat(out.trim())) : reject(new Error(`ffprobe ${code}`)),
    );
  });
}

async function ffmpegConcat(
  source: string,
  keeps: EdlEntry[],
  out: string,
  enc: { videoArgs: string[]; audioArgs: string[] },
): Promise<void> {
  const { mkdtempSync, writeFileSync: wf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const work = mkdtempSync(join(tmpdir(), "notes-edit-"));
  const parts: string[] = [];
  for (let i = 0; i < keeps.length; i++) {
    const k = keeps[i];
    const part = join(work, `p-${String(i).padStart(4, "0")}.mp4`);
    await ffmpeg([
      "-y",
      "-ss",
      String(k.start),
      "-to",
      String(k.end),
      "-i",
      source,
      ...enc.videoArgs,
      ...enc.audioArgs,
      "-movflags",
      "+faststart",
      part,
    ]);
    parts.push(part);
  }
  const list = join(work, "concat.txt");
  wf(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
}

// ── CLI ──────────────────────────────────────────────────────────────

interface CliFlags {
  slug?: string;
  workspace?: string;
  through?: StepName;
}

function parseFlags(argv: string[]): { positional: string[]; flags: CliFlags } {
  const positional: string[] = [];
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slug") flags.slug = argv[++i];
    else if (a === "--workspace") flags.workspace = argv[++i];
    else if (a === "--through") flags.through = argv[++i] as StepName;
    else positional.push(a);
  }
  return { positional, flags };
}

async function cli() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);
  const ws = resolve(flags.workspace ?? DEFAULT_WORKSPACE);

  switch (cmd) {
    case "init": {
      if (!positional[0]) throw new Error("Usage: init <input>");
      const m = await stepInit(positional[0], { slug: flags.slug, workspace: ws });
      console.log(`Initialized job '${m.slug}' at ${jobDir(ws, m.slug)}`);
      console.log(`Next: bun src/compositions/notes-edit.ts run ${m.slug}`);
      break;
    }
    case "run": {
      const m = loadManifest(ws, positional[0]);
      await runThrough(m, flags.through ?? "hyperframes");
      console.log(`Done. Cut: ${join(jobDir(ws, m.slug), "cut.mp4")}`);
      break;
    }
    case "step": {
      const m = loadManifest(ws, positional[0]);
      const step = positional[1] as StepName;
      if (step === "init") throw new Error("init takes an input path; use the init command");
      await STEP_FNS[step as Exclude<StepName, "init">](m);
      console.log(`Step ${step} done.`);
      break;
    }
    case "preview": {
      const m = loadManifest(ws, positional[0]);
      await stepPreview(m);
      console.log(`Preview: ${join(jobDir(ws, m.slug), "cut.proxy.mp4")}`);
      break;
    }
    case "edl": {
      const m = loadManifest(ws, positional[0]);
      console.log(join(jobDir(m.workspace, m.slug), "edl.json"));
      break;
    }
    case "status": {
      const m = loadManifest(ws, positional[0]);
      console.log(`Job: ${m.slug}`);
      console.log(`Input: ${m.input}`);
      console.log(`Duration: ${m.durationSec?.toFixed(1)}s`);
      for (const s of STEP_ORDER) {
        const st = m.steps[s];
        console.log(`  [${st.done ? "x" : " "}] ${s.padEnd(15)} ${st.note ?? ""}`);
      }
      break;
    }
    case "list": {
      const jobs = join(ws, "jobs");
      if (!existsSync(jobs)) {
        console.log("(no jobs)");
        break;
      }
      for (const slug of readdirSync(jobs)) {
        const mp = manifestPath(ws, slug);
        if (!existsSync(mp)) continue;
        const m = JSON.parse(readFileSync(mp, "utf-8")) as Manifest;
        const done = STEP_ORDER.filter((s) => m.steps[s].done).length;
        console.log(`  ${slug.padEnd(28)} ${done}/${STEP_ORDER.length} steps  ${m.input}`);
      }
      break;
    }
    default:
      console.log(
        [
          "notes-edit — spoken-notes cut pipeline",
          "",
          "Commands:",
          "  init <input.mp4> [--slug X] [--workspace DIR]",
          "  run <slug> [--through STEP]",
          "  step <slug> <step>",
          "  preview <slug>",
          "  edl <slug>",
          "  status <slug>",
          "  list",
          "",
          "Steps (in order):",
          ...STEP_ORDER.map((s) => `  ${s}`),
        ].join("\n"),
      );
  }
}

// Detect direct execution (works under bun + node).
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  cli().catch((err) => {
    console.error(err.stack ?? err.message ?? err);
    process.exit(1);
  });
}
