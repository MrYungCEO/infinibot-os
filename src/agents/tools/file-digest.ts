/**
 * Cheap, bounded views of saved file analyses for agent tools (file_context,
 * video_analysis). Everything here reads the saved sidecar — no OCR, no vision
 * model — so a whole folder can be reviewed in one tool call.
 */
import { analysisDataOf, isVideoEntry } from "../../media/video-analysis/service.js";
import { videoBlockOf } from "../../media/video-analysis/pipeline.js";
import { formatTimecode } from "../../media/video-analysis/sampling.js";
import type { OcrAnalysis, OcrEntry, OcrSidecar } from "../../ocr/types.js";

/** Hard cap on one tool result (chars of JSON). Small local models choke on more. */
export const TOOL_RESULT_MAX_CHARS = 24_000;
/** Max files in one batch call. */
export const BATCH_MAX_FILES = 40;

export function cut(text: string | null | undefined, n: number): string | undefined {
  if (!text) return undefined;
  const flat = text.trim();
  if (!flat) return undefined;
  return flat.length > n ? `${flat.slice(0, Math.max(0, n - 1))}…` : flat;
}

function analysisLine(a: OcrAnalysis, n: number) {
  const d = analysisDataOf(a);
  return {
    id: a.id,
    by: d?.agentName ?? a.agentId ?? a.analyzer,
    ...(d?.status && d.status !== "done" ? { status: d.status } : {}),
    ...(a.analyzer === "inspect" && typeof a.data?.question === "string"
      ? { question: cut(a.data.question, 160) }
      : {}),
    summary: cut(a.summary, n),
  };
}

/**
 * Compact digest of one file from its saved sidecar: what it is, the saved
 * description/summary, entities, saved analyses and a short text excerpt.
 * `budget` is a rough char budget for the free-text fields.
 */
export function compactFileDigest(
  entry: OcrEntry,
  sc: OcrSidecar | null,
  budget = 1600,
): Record<string, unknown> {
  const video = isVideoEntry(entry) ? videoBlockOf(sc) : null;
  const descN = Math.max(160, Math.floor(budget * 0.45));
  const textN = Math.max(120, Math.floor(budget * 0.25));
  const anaN = Math.max(120, Math.floor(budget * 0.2));
  const analyses = (sc?.analyses ?? []).slice(-4).map((a) => analysisLine(a, anaN));
  return {
    id: entry.id,
    name: entry.name,
    kind: video ? "video" : entry.mime?.split("/")[0] || entry.ext.replace(/^\./, ""),
    status: entry.status,
    ...(entry.error ? { error: cut(entry.error, 200) } : {}),
    ...(video
      ? {
          duration: formatTimecode(video.meta.duration),
          size: `${video.meta.width}x${video.meta.height}`,
          hasAudio: video.meta.hasAudio,
        }
      : {}),
    ...(sc?.pageCount && sc.pageCount > 1 ? { pages: sc.pageCount } : {}),
    description: cut(sc?.description, descN) ?? cut(entry.summary, descN) ?? null,
    entities: (sc?.entities ?? []).slice(0, 12),
    ...(analyses.length ? { analyses } : {}),
    text: cut(sc?.markdown, textN) ?? "",
    ...(sc && !sc.complete ? { partial: true } : {}),
  };
}

type Path = Array<string | number>;

function collectStrings(value: unknown, path: Path, out: Array<{ path: Path; len: number }>) {
  if (typeof value === "string") {
    out.push({ path, len: value.length });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectStrings(v, [...path, i], out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectStrings(v, [...path, k], out);
  }
}

function setAt(root: unknown, path: Path, next: string) {
  let cur = root as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] as Record<string | number, unknown>;
  cur[path[path.length - 1]] = next;
}

function getAt(root: unknown, path: Path): string {
  let cur = root as Record<string | number, unknown>;
  for (const k of path) cur = cur[k] as Record<string | number, unknown>;
  return cur as unknown as string;
}

/**
 * Keep a tool payload under `maxChars` of JSON by halving its longest strings
 * (text, descriptions, transcripts) until it fits. Adds `truncated: true`.
 */
export function capToolPayload<T extends Record<string, unknown>>(
  payload: T,
  maxChars = TOOL_RESULT_MAX_CHARS,
): T {
  let size = JSON.stringify(payload).length;
  if (size <= maxChars) return payload;
  const copy = structuredClone(payload) as T & { truncated?: boolean; hint?: string };
  for (let round = 0; round < 40 && size > maxChars; round++) {
    const strings: Array<{ path: Path; len: number }> = [];
    collectStrings(copy, [], strings);
    strings.sort((a, b) => b.len - a.len);
    const top = strings[0];
    if (!top || top.len < 80) break;
    // Trim the few longest strings together so many medium fields shrink evenly.
    for (const s of strings.slice(0, 8)) {
      if (s.len < top.len / 2 || s.len < 80) continue;
      const cur = getAt(copy, s.path);
      setAt(copy, s.path, `${cur.slice(0, Math.floor(cur.length / 2))}…`);
    }
    size = JSON.stringify(copy).length;
  }
  copy.truncated = true;
  copy.hint ??= "Result shortened to stay small. Ask for one file with maxChars for more text.";
  return copy;
}

/** Parse `ids` (array or comma-separated string) into unique trimmed ids. */
export function readIdList(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))].slice(0, BATCH_MAX_FILES);
}
