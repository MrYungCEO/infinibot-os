/**
 * Specialist-agent analysis of a processed video on the LOCAL vision model.
 *
 * The agent's persona (its systemPrompt) frames the prompt; the model sees a
 * contact sheet plus a handful of timecoded keyframes, and gets the
 * transcript and on-screen text. It answers in a fixed JSON shape that we
 * parse into VideoFindings (observations, entities, moments, confidence,
 * open questions, summary). "Look again" extracts fresh frames at the asked
 * timestamps and inspects them with the same persona.
 */
import type { OcrEngines } from "../../ocr/types.js";
import type { AnalystPersona } from "./personas.js";
import { dedupeOcr } from "./pipeline.js";
import { evenlyPick, formatTimecode, parseTimecode, round3 } from "./sampling.js";
import type {
  TranscriptSegment,
  VideoBlock,
  VideoEntity,
  VideoFindings,
  VideoKeyframe,
  VideoMoment,
  VideoObservation,
} from "./types.js";

export const MAX_ANALYSIS_FRAMES = 8;

/** Keyframes shown to the model: strongest scene changes spread over the video. */
export function pickAnalysisFrames(
  keyframes: VideoKeyframe[],
  n = MAX_ANALYSIS_FRAMES,
): VideoKeyframe[] {
  if (keyframes.length <= n) return [...keyframes];
  // Half evenly spaced (coverage), half the highest scene-change scores.
  const even = evenlyPick(keyframes, Math.ceil(n / 2));
  const rest = keyframes
    .filter((k) => !even.includes(k))
    .sort((a, b) => b.score - a.score)
    .slice(0, n - even.length);
  return [...even, ...rest].sort((a, b) => a.t - b.t);
}

/** Transcript lines that fit `maxChars`, evenly thinned when too long. */
export function transcriptExcerpt(segments: TranscriptSegment[], maxChars: number): string {
  const lines = segments.map((s) => `[${formatTimecode(s.start)}] ${s.text}`);
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;
  const avg = full.length / Math.max(1, lines.length);
  const keep = Math.max(1, Math.floor(maxChars / avg));
  return `${evenlyPick(lines, keep).join("\n")}\n[… transcript thinned to fit]`;
}

export const FINDINGS_SCHEMA = `{
  "summary": "3-6 sentences from your specialist point of view",
  "observations": [{"t": "mm:ss or null", "text": "what you observe"}],
  "entities": [{"name": "object / artifact / person role / place", "type": "artifact|object|person|place|text|other", "t": "mm:ss", "confidence": 0.0}],
  "moments": [{"t": "mm:ss", "label": "short title", "detail": "why it matters"}],
  "confidence": 0.0,
  "open_questions": ["what cannot be determined from the footage, and what would resolve it"]
}`;

export function buildAnalysisPrompt(params: {
  persona: AnalystPersona;
  fileName: string;
  video: VideoBlock;
  frames: VideoKeyframe[];
  hasSheet: boolean;
  instructions?: string;
}): string {
  const { persona, video, frames } = params;
  const onScreen = dedupeOcr(video.keyframes)
    .map((o) => `[${formatTimecode(o.t)}] ${o.text.replace(/\s*\n\s*/g, " / ")}`)
    .join("\n")
    .slice(0, 1500);
  const transcript = transcriptExcerpt(video.transcript.segments, 4000);
  const images = [
    params.hasSheet
      ? "Image 1: contact sheet of the whole video (tiles labelled with timecodes, in time order)."
      : null,
    ...frames.map(
      (f, i) => `Image ${i + 1 + (params.hasSheet ? 1 : 0)}: keyframe at ${formatTimecode(f.t)}.`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
  return [
    persona.systemPrompt,
    "",
    "---",
    `TASK: Analyze the video "${params.fileName}" (duration ${formatTimecode(video.meta.duration)}, ${video.meta.width}x${video.meta.height}) from your specialist perspective.`,
    params.instructions ? `Operator instructions: ${params.instructions}` : null,
    "",
    "IMAGES:",
    images,
    "",
    "TRANSCRIPT (local speech-to-text, may contain errors):",
    transcript || "(no speech)",
    "",
    "ON-SCREEN TEXT (local OCR):",
    onScreen || "(none)",
    "",
    "Reply with ONLY one JSON object, no markdown fences, in exactly this shape:",
    FINDINGS_SCHEMA,
    "Use timecodes from the image labels or transcript. confidence values are 0..1. Include 3-10 observations, every notable object or artifact in entities, and 2-8 moments.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** Find the outermost JSON object in model output (tolerates fences/prose/trailing commas). */
export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const body = cleaned.slice(start, i + 1);
        for (const candidate of [body, body.replace(/,\s*([}\]])/g, "$1")]) {
          try {
            return JSON.parse(candidate) as Record<string, unknown>;
          } catch {
            /* try next */
          }
        }
        return null;
      }
    }
  }
  return null;
}

function tOf(v: unknown, duration: number): number | undefined {
  let t: number | null = null;
  if (typeof v === "number" && Number.isFinite(v)) t = v;
  else if (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null")
    t = parseTimecode(v);
  if (t === null || t < 0) return undefined;
  return round3(Math.min(t, Math.max(0, duration)));
}

function conf(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const x = n > 1 && n <= 100 ? n / 100 : n;
  return Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
}

const str = (v: unknown, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Model text → findings. Never throws; unparseable output becomes the summary. */
export function parseFindings(text: string, duration: number): VideoFindings {
  const j = extractJson(text);
  if (!j) {
    return {
      summary: text.trim().slice(0, 4000),
      observations: [],
      entities: [],
      moments: [],
      confidence: null,
      openQuestions: [],
    };
  }
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const observations: VideoObservation[] = arr(j.observations)
    .map((o) =>
      typeof o === "string"
        ? { text: o.trim() }
        : {
            t: tOf((o as any)?.t ?? (o as any)?.time, duration),
            text: str((o as any)?.text ?? (o as any)?.observation),
          },
    )
    .filter((o) => o.text)
    .slice(0, 30);
  const entities: VideoEntity[] = arr(j.entities ?? j.objects ?? j.artifacts)
    .map((e) =>
      typeof e === "string"
        ? { name: e.trim().slice(0, 120) }
        : {
            name: str((e as any)?.name ?? (e as any)?.label, 120),
            type: str((e as any)?.type, 40) || undefined,
            t: tOf((e as any)?.t ?? (e as any)?.time, duration),
            confidence: conf((e as any)?.confidence),
          },
    )
    .filter((e) => e.name)
    .slice(0, 40);
  const moments: VideoMoment[] = arr(j.moments ?? j.notable_moments)
    .map((m) => ({
      t: tOf((m as any)?.t ?? (m as any)?.time ?? (m as any)?.timecode, duration),
      label: str((m as any)?.label ?? (m as any)?.title, 120),
      detail: str((m as any)?.detail ?? (m as any)?.description) || undefined,
    }))
    .filter((m) => m.t !== undefined && Boolean(m.label))
    .map((m) => ({ ...m, t: m.t as number }))
    .sort((a, b) => a.t - b.t)
    .slice(0, 16);
  return {
    summary: str(j.summary, 4000),
    observations,
    entities,
    moments,
    confidence: conf(j.confidence) ?? null,
    openQuestions: arr(j.open_questions ?? j.openQuestions)
      .map((q) => str(q, 400))
      .filter(Boolean)
      .slice(0, 12),
  };
}

export async function askAnalysis(params: {
  vl: NonNullable<OcrEngines["vl"]>;
  prompt: string;
  images: string[];
  timeoutMs?: number;
}): Promise<{ text: string; model: string }> {
  return await params.vl.ask({
    images: params.images,
    prompt: params.prompt,
    timeoutMs: params.timeoutMs ?? 600_000,
  });
}

export function buildLookAgainPrompt(params: {
  persona: AnalystPersona;
  fileName: string;
  question: string;
  frames: Array<{ t: number }>;
  video: VideoBlock;
  priorSummary?: string;
}): string {
  const { video } = params;
  const near = video.transcript.segments.filter((s) =>
    params.frames.some((f) => s.end >= f.t - 12 && s.start <= f.t + 12),
  );
  const ocr = video.keyframes.filter(
    (k) => k.ocr && params.frames.some((f) => Math.abs(k.t - f.t) <= 12),
  );
  return [
    params.persona.systemPrompt,
    "",
    "---",
    `FOLLOW-UP on the video "${params.fileName}". You are looking again at freshly extracted frames:`,
    ...params.frames.map((f, i) => `Image ${i + 1}: frame at ${formatTimecode(f.t)}.`),
    params.priorSummary
      ? `\nYour earlier analysis said: ${params.priorSummary.slice(0, 1200)}`
      : "",
    near.length
      ? `\nTranscript around these times:\n${near
          .map((s) => `[${formatTimecode(s.start)}] ${s.text}`)
          .join("\n")
          .slice(0, 2000)}`
      : "",
    ocr.length
      ? `\nOn-screen text nearby:\n${ocr
          .map((k) => `[${formatTimecode(k.t)}] ${k.ocr!.text.replace(/\s*\n\s*/g, " / ")}`)
          .join("\n")
          .slice(0, 800)}`
      : "",
    "",
    `QUESTION: ${params.question}`,
    "",
    "Answer from what is visible in these frames (cite timecodes). Be specific and concise, state your confidence, and say what you cannot see.",
  ].join("\n");
}
