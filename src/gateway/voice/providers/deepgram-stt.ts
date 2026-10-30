/**
 * Deepgram STT — streaming WS (wss://api.deepgram.com/v1/listen).
 *
 * start() opens the socket, pushAudio() sends linear16 PCM frames as they
 * arrive, end() sends CloseStream and resolves the concatenated final
 * transcript once Deepgram flushes. Auth via the `Authorization: Token KEY`
 * header. Input that's a WAV container is unwrapped to raw PCM.
 */

import WebSocket from "ws";

import type { SttProvider, SttStartOptions, SttStream } from "../types.js";
import { rawDataToString } from "../../../infra/ws.js";

const DEEPGRAM_BASE = "wss://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-2";

interface DeepgramResult {
  type?: string;
  is_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

export function createDeepgramStt(opts: { apiKey: string; model?: string }): SttProvider {
  return {
    name: "deepgram",
    async start(start?: SttStartOptions): Promise<SttStream> {
      const sampleRate = start?.sampleRate ?? 16000;
      const model = start?.model || opts.model || DEFAULT_MODEL;
      const url =
        `${DEEPGRAM_BASE}?model=${encodeURIComponent(model)}` +
        `&encoding=linear16&sample_rate=${sampleRate}&channels=1&smart_format=true` +
        (start?.language ? `&language=${encodeURIComponent(start.language)}` : "");

      const ws = new WebSocket(url, { headers: { Authorization: `Token ${opts.apiKey}` } });
      const finals: string[] = [];
      let socketErr: Error | null = null;

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(rawDataToString(data)) as DeepgramResult;
          const text = msg.channel?.alternatives?.[0]?.transcript ?? "";
          if (msg.is_final && text) finals.push(text);
        } catch {
          /* ignore non-JSON keepalives */
        }
      });
      ws.on("error", (err) => {
        socketErr = err instanceof Error ? err : new Error(String(err));
      });

      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", (err) => reject(err));
      });

      return {
        pushAudio(chunk) {
          if (ws.readyState !== WebSocket.OPEN) return;
          // Strip a WAV header if present — Deepgram wants raw linear16.
          const pcm =
            chunk.length >= 44 && chunk.toString("ascii", 0, 4) === "RIFF"
              ? chunk.subarray(44)
              : chunk;
          ws.send(pcm);
        },
        async end() {
          if (socketErr) throw socketErr;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "CloseStream" }));
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), 5000);
            ws.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          if (socketErr) throw socketErr;
          return finals.join(" ").trim();
        },
        abort() {
          try {
            ws.terminate();
          } catch {
            /* noop */
          }
        },
      };
    },
  };
}
