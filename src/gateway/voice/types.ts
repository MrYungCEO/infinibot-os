/**
 * Non-Docker voice stack — provider adapter interfaces.
 *
 * Two tiny interfaces, no class hierarchies:
 *   STT — a stateful stream: start() → pushAudio(chunk) … → end() → transcript.
 *         Batch providers (Groq, OpenAI) accumulate chunks and POST on end().
 *         Streaming providers (Deepgram) open a socket on start() and resolve
 *         the final transcript on end().
 *   TTS — synthesize(text) → a Node Readable of encoded audio bytes.
 *
 * The registry (./providers/registry.ts) maps a VoiceConfig onto a concrete
 * adapter. Everything downstream (HTTP proxies, doctor, the WS pipeline) talks
 * to these interfaces only.
 */

import type { Readable } from "node:stream";

export interface SttStartOptions {
  /** Sample rate of the PCM frames pushed via pushAudio (default 16000). */
  sampleRate?: number;
  /** BCP-47 language hint, e.g. "en". Optional — providers auto-detect. */
  language?: string;
  /** Provider model override (else the config / provider default is used). */
  model?: string;
  /** Container/encoding hint for the buffered audio: "wav" | "pcm" | "webm". */
  encoding?: "wav" | "pcm" | "webm" | "ogg" | "mp3";
}

export interface SttStream {
  /** Feed one chunk of audio. For batch providers this just appends. */
  pushAudio(chunk: Buffer): void;
  /** Finalize: returns the transcript (possibly empty for silence). */
  end(): Promise<string>;
  /** Abort without waiting for a transcript (client hangup). */
  abort?(): void;
}

export interface SttProvider {
  readonly name: string;
  start(opts?: SttStartOptions): Promise<SttStream> | SttStream;
}

export interface TtsSynthesizeOptions {
  /** Provider voice id (else the config / provider default is used). */
  voice?: string;
  /** Output container: "mp3" | "wav" | "pcm" | "opus". Default "mp3". */
  format?: "mp3" | "wav" | "pcm" | "opus";
  /** Speaking rate multiplier where supported (1 = normal). */
  speed?: number;
}

export interface TtsProvider {
  readonly name: string;
  /** Content-Type of the stream synthesize() returns for a given format. */
  mimeFor(format?: string): string;
  synthesize(text: string, opts?: TtsSynthesizeOptions): Promise<Readable>;
}

/**
 * Batch helper used by doctor and the same-origin STT proxy: drive a
 * start/pushAudio/end cycle over one complete audio buffer and return the
 * transcript. Keeps callers from re-implementing the 3-step dance.
 */
export async function transcribeBuffer(
  provider: SttProvider,
  audio: Buffer,
  opts?: SttStartOptions,
): Promise<string> {
  const stream = await provider.start(opts);
  stream.pushAudio(audio);
  return stream.end();
}
