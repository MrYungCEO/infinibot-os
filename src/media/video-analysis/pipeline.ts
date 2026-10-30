/**
 * The local video pipeline (the "video" extraction handler body).
 *
 *   probe → per chunk: scene-change keyframes (adaptive, capped) → small JPEGs
 *   → OCR of on-screen text → timestamped transcript of the chunk's audio
 *   → [chunk marked done + progress saved] → contact sheet → playback proxy
 *   → neutral vision-model description of the contact sheet.
 *
 * Every chunk is persisted through saveProgress(), so a gateway restart
 * resumes at the first unfinished chunk (frames already in the frame store
 * are reused). Scratch files go to params.tmpDir (tmpfs for the secure lane)
 * and are deleted when the job ends.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { layoutLines, meanConfidence } from "../../ocr/engines.js";
import { newSidecar, parseEntities, type ExtractParams } from "../../ocr/extract.js";
import type { ExtractionHelpers } from "../../ocr/handlers.js";
import type { OcrPage, OcrSidecar } from "../../ocr/types.js";
import * as ff from "./ffmpeg.js";
import { frameKeyFor, type FrameStore } from "./frame-store.js";
import {
  chunkBudget,
  DEFAULT_LIMITS,
  evenlyPick,
  formatTimecode,
  frameBudget,
  planChunks,
  selectKeyframes,
  type SamplingLimits,
  type SceneCandidate,
} from "./sampling.js";
import type { Transcriber } from "./transcribe.js";
import type { TranscriptSegment, VideoBlock, VideoKeyframe, VideoMeta } from "./types.js";

/** ffmpeg operations (real binaries by default; fakes in tests). */
export interface MediaTools {
  probe(file: string): Promise<VideoMeta>;
  detectScenes(file: string, start: number, len: number): Promise<SceneCandidate[]>;
  extractFrame(file: string, t: number, out: string, width?: number): Promise<string>;
  contactSheet(
    frames: Array<{ path: string; t: number }>,
    out: string,
  ): Promise<{ path: string; cols: number; rows: number }>;
  extractAudio(file: string, start: number, len: number, out: string): Promise<string>;
  makeProxy(file: string, out: string, hasAudio: boolean, duration: number): Promise<string>;
}

export function realMediaTools(bins = ff.resolveBins()): MediaTools {
  return {
    probe: (f) => ff.probe(bins, f),
    detectScenes: (f, s, l) => ff.detectScenes(bins, f, s, l),
    extractFrame: (f, t, o, w) => ff.extractFrame(bins, f, t, o, w),
    contactSheet: (frames, out) => ff.contactSheet(bins, frames, out),
    extractAudio: (f, s, l, o) => ff.extractAudio(bins, f, s, l, o),
    makeProxy: (f, o, a, d) => ff.makeProxy(bins, f, o, a, d),
  };
}

export interface VideoPipelineDeps {
  tools: MediaTools;
  transcriber: Transcriber | null;
  frames: (lane: "normal" | "secure") => FrameStore;
  limits?: Partial<SamplingLimits>;
  /** Skip the proxy (tests). */
  proxy?: boolean;
}

export const VIDEO_DESCRIBE_PROMPT = [
  "This is a contact sheet of keyframes sampled from one video, in time order (left to right, top to bottom); each tile is labelled with its timecode.",
  "Describe the video for a search index and an assistant that cannot see it. Answer in markdown with exactly these sections:",
  "## Summary",
  "Two to four sentences: what the video shows, the setting, and what happens over time.",
  "## Key entities",
  "A flat bullet list of short noun phrases (at most 6 words each, no sub-bullets, no headings): people roles, objects, places, organisations, visible labels and other notable things.",
  "Do not invent details that are not visible.",
].join("\n");

export function videoBlockOf(sc: OcrSidecar | null | undefined): VideoBlock | null {
  const v = sc?.video as VideoBlock | undefined;
  return v && v.version === 1 && Array.isArray(v.chunks) ? v : null;
}

/** Transcript + on-screen text as the sidecar's searchable markdown. */
export function videoMarkdown(v: VideoBlock): string {
  const parts: string[] = [];
  if (v.transcript.segments.length) {
    parts.push(
      "## Transcript",
      "",
      ...v.transcript.segments.map((s) => `[${formatTimecode(s.start)}] ${s.text}`),
      "",
    );
  }
  const onScreen = dedupeOcr(v.keyframes);
  if (onScreen.length) {
    parts.push(
      "## On-screen text",
      "",
      ...onScreen.map((k) => `[${formatTimecode(k.t)}] ${k.text.replace(/\s*\n\s*/g, " / ")}`),
      "",
    );
  }
  return parts.join("\n").trim();
}

/** Keyframe OCR with consecutive duplicates removed. */
export function dedupeOcr(keyframes: VideoKeyframe[]): Array<{ t: number; text: string }> {
  const out: Array<{ t: number; text: string }> = [];
  let last = "";
  for (const k of keyframes) {
    const text = k.ocr?.text?.trim();
    if (!text) continue;
    const norm = text.toLowerCase().replace(/\s+/g, " ");
    if (norm === last) continue;
    last = norm;
    out.push({ t: k.t, text });
  }
  return out;
}

function chunkPages(v: VideoBlock): OcrPage[] {
  return v.chunks
    .filter((c) => c.done)
    .map((c) => {
      const segs = v.transcript.segments.filter((s) => s.start >= c.start && s.start < c.end);
      const ocr = dedupeOcr(v.keyframes.filter((k) => k.t >= c.start && k.t < c.end));
      const text = [
        `### ${formatTimecode(c.start)} – ${formatTimecode(c.end)}`,
        ...segs.map((s) => `[${formatTimecode(s.start)}] ${s.text}`),
        ...ocr.map(
          (o) => `[${formatTimecode(o.t)}] (on screen) ${o.text.replace(/\s*\n\s*/g, " / ")}`,
        ),
      ].join("\n");
      const confs = v.keyframes
        .filter((k) => k.t >= c.start && k.t < c.end && k.ocr?.confidence != null)
        .map((k) => k.ocr!.confidence!);
      return {
        page: c.index + 1,
        method: "native" as const,
        text,
        confidence: confs.length
          ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 1000) / 1000
          : null,
      };
    });
}

/** Short, de-duplicated entity labels (drops headings and sentence-length items). */
export function cleanEntities(raw: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    let v = r
      .replace(/\*\*/g, "")
      .replace(/^["'`]+|["'`.]+$/g, "")
      .trim();
    if (!v || v.endsWith(":")) continue;
    const colon = v.indexOf(":");
    if (colon > 0 && colon <= 40) v = v.slice(0, colon).trim();
    if (v.length > 60 || v.split(/\s+/).length > 8) continue;
    if (!out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out.slice(0, 30);
}

export function frameName(i: number) {
  return `k${String(i).padStart(4, "0")}.jpg`;
}

/** Run (or resume) the pipeline for one video. */
export async function processVideo(
  params: ExtractParams,
  helpers: ExtractionHelpers,
  deps: VideoPipelineDeps,
): Promise<OcrSidecar> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const { entry, filePath, engines } = params;
  const now = params.now ?? Date.now;
  const store = deps.frames(entry.lane);
  const sc = newSidecar(params);
  const frameKey = frameKeyFor(entry.sha256);
  const scratchBase = params.tmpDir ?? os.tmpdir();
  fs.mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(scratchBase, "ib-video-"));
  try {
    let v = videoBlockOf(sc);
    if (!v || v.frameKey !== frameKey) {
      const meta = await deps.tools.probe(filePath);
      v = {
        version: 1,
        meta,
        frameKey,
        chunkSec: limits.chunkSec,
        chunks: planChunks(meta.duration, limits.chunkSec),
        keyframes: [],
        contactSheet: null,
        transcript: { engine: null, model: null, language: null, segments: [] },
        proxy: null,
      };
      sc.video = v;
      sc.warnings = [];
    }
    const block = v;
    const duration = block.meta.duration;
    const total = frameBudget(duration, limits.maxFrames);
    const ocrName = await engines.ocrEngineName().catch(() => null);
    const stt = deps.transcriber ? await deps.transcriber.available().catch(() => null) : null;
    const warn = (w: string) => {
      if (!sc.warnings.includes(w)) sc.warnings.push(w);
    };
    if (!ocrName) warn("no local OCR engine installed; on-screen text skipped");
    if (block.meta.hasAudio && !stt) warn("no local speech-to-text engine; transcript skipped");
    const steps = block.chunks.length + 2;
    const sync = (stage: string, done: number) => {
      sc.pageCount = block.chunks.length;
      sc.pages = chunkPages(block);
      sc.markdown = videoMarkdown(block);
      sc.updatedAt = now();
      helpers.saveProgress(sc, { done, total: steps, stage });
    };

    for (const chunk of block.chunks) {
      if (chunk.done) continue;
      const len = Math.max(0.1, chunk.end - chunk.start);
      // 1. Adaptive keyframes.
      const candidates = await deps.tools.detectScenes(filePath, chunk.start, len).catch((err) => {
        warn(`scene detection failed: ${(err as Error).message}`);
        return [] as SceneCandidate[];
      });
      const picks = selectKeyframes({
        candidates,
        start: chunk.start,
        end: chunk.end,
        budget: Math.min(chunkBudget(chunk, duration, total), total - block.keyframes.length),
        minGapSec: limits.minGapSec,
        maxGapSec: limits.maxGapSec,
      });
      // Drop any frames left by an interrupted attempt of this chunk.
      block.keyframes = block.keyframes.filter((k) => k.t < chunk.start || k.t >= chunk.end);
      const fresh: Array<VideoKeyframe & { path: string }> = [];
      for (const p of picks) {
        const id = frameName(block.keyframes.length + fresh.length + 1);
        const out = path.join(tmp, id);
        try {
          await deps.tools.extractFrame(filePath, p.t, out);
        } catch {
          warn(`frame extraction failed at ${formatTimecode(p.t)}`);
          continue;
        }
        store.put(frameKey, id, fs.readFileSync(out));
        fresh.push({ id, t: p.t, score: Math.round(p.score * 1000) / 1000, path: out });
      }
      // 2. On-screen text through the OCR engine.
      if (ocrName && fresh.length) {
        try {
          const res = await engines.ocrImages(fresh.map((f) => f.path));
          fresh.forEach((f, i) => {
            const r = res[i];
            const text = r ? layoutLines(r).trim() : "";
            if (text && text.replace(/\s+/g, "").length >= 3) {
              f.ocr = { text, confidence: r ? meanConfidence(r) : null };
            }
          });
        } catch (err) {
          warn(`OCR of keyframes failed: ${(err as Error).message}`);
        }
      }
      for (const f of fresh) {
        fs.rmSync(f.path, { force: true });
        const { path: _p, ...k } = f;
        block.keyframes.push(k);
      }
      block.keyframes.sort((a, b) => a.t - b.t);
      // 3. Transcript of the chunk's audio.
      if (block.meta.hasAudio && stt && deps.transcriber) {
        const wav = path.join(tmp, `a${chunk.index}.wav`);
        try {
          await deps.tools.extractAudio(filePath, chunk.start, len, wav);
          const r = await deps.transcriber.transcribe(wav, chunk.start);
          block.transcript.segments = [
            ...block.transcript.segments.filter(
              (s) => s.start < chunk.start || s.start >= chunk.end,
            ),
            ...r.segments.filter((s: TranscriptSegment) => s.start < chunk.end + 0.5),
          ].sort((a, b) => a.start - b.start);
          block.transcript.engine = r.engine;
          block.transcript.model = r.model;
          block.transcript.language ??= r.language;
        } catch (err) {
          // Retry the whole chunk later (the queue backs off) rather than lose speech.
          throw new Error(`transcription failed: ${(err as Error).message}`);
        } finally {
          fs.rmSync(wav, { force: true });
        }
      }
      chunk.done = true;
      sync("chunks", block.chunks.filter((c) => c.done).length);
    }

    // 4. Contact sheet (≤ 16 tiles, evenly over the keyframes).
    if (!block.contactSheet && block.keyframes.length) {
      const pick = evenlyPick(block.keyframes, 16);
      const local: Array<{ path: string; t: number }> = [];
      for (const k of pick) {
        const buf = store.get(frameKey, k.id);
        if (!buf) continue;
        const p = path.join(tmp, `cs-${k.id}`);
        fs.writeFileSync(p, buf, { mode: 0o600 });
        local.push({ path: p, t: k.t });
      }
      try {
        const sheet = await deps.tools.contactSheet(local, path.join(tmp, "sheet.jpg"));
        store.put(frameKey, "sheet.jpg", fs.readFileSync(sheet.path));
        block.contactSheet = {
          id: "sheet.jpg",
          times: local.map((l) => l.t),
          cols: sheet.cols,
          rows: sheet.rows,
        };
      } catch (err) {
        warn(`contact sheet failed: ${(err as Error).message}`);
      }
      sync("contact-sheet", block.chunks.length + 1);
    }

    // 5. Playback proxy (small H.264, served by RPC in both lanes).
    if (deps.proxy !== false && !block.proxy) {
      const out = path.join(tmp, "proxy.mp4");
      try {
        await deps.tools.makeProxy(filePath, out, block.meta.hasAudio, duration);
        const buf = fs.readFileSync(out);
        store.put(frameKey, "proxy.mp4", buf);
        block.proxy = {
          id: "proxy.mp4",
          bytes: buf.length,
          height: Math.min(360, block.meta.height),
        };
      } catch (err) {
        warn(`playback proxy failed: ${(err as Error).message}`);
      } finally {
        fs.rmSync(out, { force: true });
      }
    }

    // 6. Neutral description of the contact sheet (search + KG entities).
    const vlModel =
      engines.vl && params.cfg.vlMode !== "off" ? await engines.vl.model().catch(() => null) : null;
    if (!sc.description && block.contactSheet && vlModel && engines.vl) {
      const buf = store.get(frameKey, block.contactSheet.id);
      if (buf) {
        const p = path.join(tmp, "sheet-vl.jpg");
        fs.writeFileSync(p, buf, { mode: 0o600 });
        try {
          const r = await engines.vl.ask({
            images: [p],
            prompt: VIDEO_DESCRIBE_PROMPT,
            timeoutMs: 300_000,
          });
          sc.description = r.text || null;
          sc.engines.vl = r.model;
          sc.entities = cleanEntities(parseEntities(sc.description));
        } catch (err) {
          warn(`vision description failed: ${(err as Error).message}`);
        } finally {
          fs.rmSync(p, { force: true });
        }
      }
    } else if (!vlModel) {
      warn("no local vision model available; description skipped");
    }

    if (ocrName && block.keyframes.some((k) => k.ocr)) sc.engines.ocr = ocrName;
    sc.engines.text = [
      ...(block.transcript.engine ? [`stt:${block.transcript.engine}`] : []),
      ...(sc.engines.ocr ? ["ocr"] : []),
    ];
    const confs = block.keyframes
      .map((k) => k.ocr?.confidence)
      .filter((c): c is number => c != null);
    sc.confidence = confs.length
      ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 1000) / 1000
      : null;
    sc.pageCount = block.chunks.length;
    sc.pages = chunkPages(block);
    sc.markdown = videoMarkdown(block);
    sc.stage = "vl";
    sc.complete = true;
    return sc;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
