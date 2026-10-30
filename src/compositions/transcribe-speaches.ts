/**
 * Speaches-backed transcription — OpenAI-compatible /v1/audio/transcriptions
 * with word-level timestamps. Mirrors the shape of transcribe.ts but speaks
 * HTTP to the Speaches container instead of shelling out to faster-whisper.
 *
 * Default endpoint matches docker-compose.voice.yaml (localhost:8002).
 */

import { createReadStream, existsSync } from "node:fs";
import { basename } from "node:path";

import { createSubsystemLogger } from "../logging/subsystem.js";

import type { CaptionCue, CaptionWord } from "./types.js";

const log = createSubsystemLogger("captions-speaches");

export interface SpeachesTranscribeOptions {
  filePath: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  maxWordsPerCue?: number;
  signal?: AbortSignal;
}

export interface SpeachesTranscribeResult {
  cues: CaptionCue[];
  words: CaptionWord[];
  language?: string;
  duration?: number;
}

const DEFAULT_BASE_URL = process.env.SPEACHES_URL ?? "http://localhost:8002";
const DEFAULT_MODEL = "deepdml/faster-whisper-large-v3-turbo-ct2";
const DEFAULT_MAX_WORDS_PER_CUE = 6;

interface SpeachesWord {
  start: number;
  end: number;
  word: string;
}

interface SpeachesSegment {
  start: number;
  end: number;
  text: string;
  words?: SpeachesWord[];
}

interface SpeachesVerboseJson {
  language?: string;
  duration?: number;
  text: string;
  words?: SpeachesWord[];
  segments?: SpeachesSegment[];
}

export async function transcribeWithSpeaches(
  opts: SpeachesTranscribeOptions,
): Promise<SpeachesTranscribeResult> {
  if (!existsSync(opts.filePath)) {
    throw new Error(`Media file not found: ${opts.filePath}`);
  }

  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const url = `${baseUrl}/v1/audio/transcriptions`;
  const model = opts.model ?? DEFAULT_MODEL;
  const maxWords = opts.maxWordsPerCue ?? DEFAULT_MAX_WORDS_PER_CUE;

  const form = new FormData();
  const buf = await readFileAsBlob(opts.filePath);
  form.append("file", buf, basename(opts.filePath));
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  if (opts.language) form.append("language", opts.language);

  log.info(`speaches transcribe start url=${url} model=${model} file=${opts.filePath}`);

  const res = await fetch(url, {
    method: "POST",
    body: form,
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Speaches ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as SpeachesVerboseJson;

  const words = collectWords(json);
  const cues = groupWordsToCues(words, maxWords, json.segments);

  return { cues, words, language: json.language, duration: json.duration };
}

async function readFileAsBlob(path: string): Promise<Blob> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path)) chunks.push(chunk as Buffer);
  return new Blob([Buffer.concat(chunks)]);
}

function collectWords(json: SpeachesVerboseJson): CaptionWord[] {
  const raw = json.words?.length ? json.words : (json.segments ?? []).flatMap((s) => s.words ?? []);
  return raw.map((w) => ({
    start: w.start,
    end: w.end,
    word: w.word.trim(),
  }));
}

function groupWordsToCues(
  words: CaptionWord[],
  maxWords: number,
  segments?: SpeachesSegment[],
): CaptionCue[] {
  if (segments?.length) {
    return segments.flatMap((s) => splitSegment(s, maxWords));
  }
  const cues: CaptionCue[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    const slice = words.slice(i, i + maxWords);
    if (!slice.length) continue;
    cues.push({
      start: slice[0].start,
      end: slice[slice.length - 1].end,
      text: slice.map((w) => w.word).join(" "),
      words: slice,
    });
  }
  return cues;
}

function splitSegment(seg: SpeachesSegment, maxWords: number): CaptionCue[] {
  const ws = (seg.words ?? []).map((w) => ({
    start: w.start,
    end: w.end,
    word: w.word.trim(),
  }));
  if (!ws.length) {
    return [{ start: seg.start, end: seg.end, text: seg.text.trim() }];
  }
  const out: CaptionCue[] = [];
  for (let i = 0; i < ws.length; i += maxWords) {
    const slice = ws.slice(i, i + maxWords);
    out.push({
      start: slice[0].start,
      end: slice[slice.length - 1].end,
      text: slice.map((w) => w.word).join(" "),
      words: slice,
    });
  }
  return out;
}
