/**
 * Browser-facing Speaches STT proxy.
 *
 * Same-origin so the UI can transcribe without CORS configuration on the
 * Speaches container. Forwards a multipart-audio POST to Speaches's
 * OpenAI-compatible /v1/audio/transcriptions and returns the JSON `{text}`
 * result straight back. Mirrors the shape of server-voice-tts.ts.
 *
 * Used by voice-chat's terminal mode — local Whisper STT in the browser
 * captures mic audio via VAD-Web, posts it here, and we relay to Speaches.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveReachableVoiceUrl, resolveVoiceUrls } from "./server-voice-urls.js";
import { createSttProvider, VoiceConfigError } from "./voice/providers/registry.js";
import { setupSttModel } from "./voice/local-setup/wire.js";
import { resolveSttRoute } from "./voice/runtime-status.js";
import { transcribeBuffer, type SttStartOptions } from "./voice/types.js";

const DEFAULT_MODEL = "deepdml/faster-whisper-large-v3-turbo-ct2";

/** SPEACHES_MODEL env > the model the one-click voice setup installed > large-v3-turbo. */
function speachesModel(): string {
  return process.env.SPEACHES_MODEL || setupSttModel() || DEFAULT_MODEL;
}

/**
 * Pull the first file part out of a multipart/form-data body. Returns its raw
 * bytes plus a best-guess encoding hint from the filename/content-type. Used
 * to feed the non-Docker STT adapters, which take a buffer rather than a
 * forwarded multipart stream.
 */
function extractFilePart(
  body: Buffer,
  contentType: string,
): { bytes: Buffer; encoding: SttStartOptions["encoding"] } | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = m ? (m[1] || m[2]).trim() : null;
  if (!boundary) return null;
  const delim = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from("\r\n\r\n");

  let pos = 0;
  while (pos < body.length) {
    const start = body.indexOf(delim, pos);
    if (start < 0) break;
    const partStart = start + delim.length;
    const next = body.indexOf(delim, partStart);
    if (next < 0) break;
    const part = body.subarray(partStart, next);
    const sep = part.indexOf(headerSep);
    if (sep >= 0) {
      const headers = part.subarray(0, sep).toString("utf-8").toLowerCase();
      if (headers.includes('name="file"') || headers.includes("filename=")) {
        // Strip the leading CRLF after headers and the trailing CRLF before delim.
        let data = part.subarray(sep + headerSep.length);
        if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
          data = data.subarray(0, data.length - 2);
        }
        let encoding: SttStartOptions["encoding"] = "wav";
        if (headers.includes("webm")) encoding = "webm";
        else if (headers.includes("ogg")) encoding = "ogg";
        else if (headers.includes("mpeg") || headers.includes(".mp3")) encoding = "mp3";
        else if (headers.includes("wav")) encoding = "wav";
        return { bytes: Buffer.from(data), encoding };
      }
    }
    pos = next;
  }
  return null;
}

export async function handleVoiceSttRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith("/api/voice/stt")) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  try {
    // Buffer the inbound multipart body. The browser sends `multipart/form-data`
    // with one `file` part (audio blob) plus optional `model`/`language`/etc.
    // We don't need to parse it — just forward the raw bytes with the
    // original Content-Type header so the boundary stays intact.
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    const contentType = req.headers["content-type"];
    if (!contentType || !contentType.startsWith("multipart/")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "expected multipart/form-data with `file` (audio) and optional `model`/`language`",
        }),
      );
      return true;
    }

    // ── Runtime router ───────────────────────────────────────────────────
    // resolveSttRoute() is the single decision point: cloud / native / docker
    // / unconfigured. Only mode==='docker' falls through to the Speaches proxy
    // below. An unconfigured stack — or a cloud provider with no key, or a
    // native stack with no whisper binary — fails here with a specific,
    // actionable error and does NOT silently default to docker.
    const route = resolveSttRoute();
    if (route.kind !== "docker") {
      // unconfigured / missing-key / missing-binary → specific 503, never docker.
      if (route.error || !route.cfg) {
        res.writeHead(503, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: route.error ?? "STT not configured" }));
        return true;
      }
      const part = extractFilePart(body, contentType);
      if (!part) {
        res.writeHead(400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: "could not find `file` part in multipart body" }));
        return true;
      }
      try {
        const sttProvider = createSttProvider(route.cfg.stt);
        const text = await transcribeBuffer(sttProvider, part.bytes, { encoding: part.encoding });
        res.writeHead(200, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ text }));
        return true;
      } catch (err) {
        const status = err instanceof VoiceConfigError ? 503 : 502;
        res.writeHead(status, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            error: `voice STT (${route.provider}): ${(err as Error).message}`,
          }),
        );
        return true;
      }
    }

    // ── Docker (Speaches) path — only when mode==='docker' ────────────────
    // Rebuild the multipart with the model Speaches ACTUALLY has loaded
    // (SPEACHES_MODEL env / DEFAULT_MODEL) rather than forwarding the browser's
    // hardcoded model name. The browser sends e.g. "Systran/faster-whisper-medium"
    // but the container is configured (compose WHISPER_MODEL) with a different
    // model — forwarding it verbatim makes Speaches 404 "model not installed"
    // and every transcription fails. Injecting the configured model here makes
    // STT work regardless of what any client sends.
    // Honor the satellite-wide voice node toggle with automatic fallback (same
    // as TTS): local Docker Speaches or the master's, whichever is selected and
    // reachable.
    const speachesEndpoint = await resolveReachableVoiceUrl("speaches");
    const SPEACHES_URL = speachesEndpoint.url;
    if (speachesEndpoint.fellBack) {
      console.warn(
        `[VoiceStt] preferred voice node "${speachesEndpoint.preferred}" unreachable — fell back to "${speachesEndpoint.node}" (${SPEACHES_URL})`,
      );
    }
    const part = extractFilePart(body, contentType);
    if (!part) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "could not find `file` part in multipart body" }));
      return true;
    }
    const ext =
      part.encoding === "mp3"
        ? "mp3"
        : part.encoding === "ogg"
          ? "ogg"
          : part.encoding === "webm"
            ? "webm"
            : "wav";
    const mime = ext === "mp3" ? "audio/mpeg" : `audio/${ext}`;
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(part.bytes)], { type: mime }), `audio.${ext}`);
    fd.append("model", speachesModel());
    fd.append("response_format", "json");
    // Disable Speaches' built-in VAD. The browser already runs VAD-Web before
    // sending, so the clip IS speech — a second VAD pass here is redundant and,
    // worse, frequently strips the WHOLE clip ("VAD filter removed NN of audio,
    // kept: <none>") and returns an empty transcription. That's the intermittent
    // "STT does nothing". Let Whisper transcribe the audio the client captured.
    fd.append("vad_filter", "false");
    const upstream = await fetch(`${SPEACHES_URL}/v1/audio/transcriptions`, {
      method: "POST",
      body: fd,
    });

    const upstreamText = await upstream.text();
    if (!upstream.ok) {
      // Forward the upstream status + body so the browser sees the
      // real reason (model missing, bad request, etc.).
      res.writeHead(upstream.status || 502, {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
      });
      res.end(upstreamText);
      return true;
    }

    // Speaches returns either JSON `{text: "..."}` or plain text — pass
    // the bytes through with the upstream content-type. The browser's
    // existing parser handles both shapes.
    res.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(upstreamText);
    return true;
  } catch (err: any) {
    console.error("[VoiceStt] proxy error:", err?.message || err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `STT proxy failed: ${err?.message || err}`,
          upstream: resolveVoiceUrls().speaches,
          defaultModel: speachesModel(),
        }),
      );
    }
    return true;
  }
}
