/**
 * Browser-facing TTS proxy.
 *
 * Same-origin so the UI can synthesize without CORS configuration on the
 * upstream service. Default path forwards JSON { voice, input, response_format? }
 * to Kokoro's OpenAI-compatible /v1/audio/speech and streams the audio body
 * straight back.
 *
 * Pass `provider: "elevenlabs"` to route through ElevenLabs instead — used by
 * the voice UI's Jarvis toggle. ElevenLabs needs an API key, sourced from
 * the gateway's config or ELEVENLABS_API_KEY / XI_API_KEY env vars.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { probeVoiceService, resolveReachableVoiceUrl } from "./server-voice-urls.js";
import { loadVoiceConfig } from "./voice/config.js";
import { createTtsProvider, VoiceConfigError } from "./voice/providers/registry.js";
import { resolveTtsRoute } from "./voice/runtime-status.js";

// Default voice id for the "Jarvis" preset — ElevenLabs' "Daniel" preset is
// a deep British male voice and the most common stock pick for a Jarvis vibe.
// Override per-request via `voice` if you want a different ElevenLabs voice.
const ELEVENLABS_JARVIS_VOICE_ID = "onwK4e9ZLuTAKqWW03F9";
// Turbo v2.5 trades a hair of quality for ~3× lower TTFB — important for a
// conversational voice UI where the user is staring at the orb.
const ELEVENLABS_DEFAULT_MODEL = "eleven_turbo_v2_5";
const ELEVENLABS_BASE = "https://api.elevenlabs.io";
// Upper bound on a single upstream TTS synthesis request. Sentences are short
// (the voice stream chunks at phrase boundaries), so 15s is generous headroom;
// anything slower is a stuck provider and we want to fail over, not hang.
const TTS_UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * True when `v` is a local/placeholder voice name that must NOT be forwarded to
 * a cloud provider. Covers the OpenAI/Kokoro placeholders ("onyx", "coral") and
 * the Kokoro `xx_name` voice id pattern (e.g. "am_puck", "af_sky"). Cloud voice
 * ids (ElevenLabs 20-char mixed-case ids; OpenAI single words other than the
 * placeholders) don't match, so legitimate cloud overrides still pass through.
 */
function isLocalPlaceholderVoice(v: unknown): boolean {
  if (typeof v !== "string" || !v.trim()) return true;
  const s = v.trim();
  return s === "onyx" || s === "coral" || /^[a-z]{2}_[a-z]+$/.test(s);
}

function resolveElevenLabsKey(): string | undefined {
  // The gateway's tts.ts resolver reads config.elevenlabs.apiKey too, but it
  // requires the full ResolvedTtsConfig. For this lightweight proxy the env
  // vars are enough — if a user has the key in infinibot.json instead, they
  // can either also export it or we can extend this later.
  return process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || undefined;
}

export async function handleVoiceTtsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith("/api/voice/tts")) return false;

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
    let body = "";
    for await (const chunk of req) body += chunk;

    const data = JSON.parse(body || "{}");
    const input = typeof data.input === "string" ? data.input.slice(0, 2000) : "";
    const provider = typeof data.provider === "string" ? data.provider : "kokoro";
    const voice = typeof data.voice === "string" && data.voice.trim() ? data.voice : "onyx";
    const responseFormat = typeof data.response_format === "string" ? data.response_format : "mp3";

    if (!input) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "input required" }));
      return true;
    }

    // ── Runtime router ───────────────────────────────────────────────────
    // resolveTtsRoute() is the single decision point (cloud / native / docker
    // / unconfigured). Only mode==='docker' falls through to the legacy
    // Kokoro/ElevenLabs proxy below. An unconfigured stack — or a cloud
    // provider with no key — fails here with a specific error instead of
    // silently defaulting to the Kokoro docker container.
    const route = resolveTtsRoute();
    if (route.kind !== "docker") {
      if (route.error || !route.cfg) {
        res.writeHead(503, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: route.error ?? "TTS not configured" }));
        return true;
      }
      try {
        const ttsProvider = createTtsProvider(route.cfg.tts);
        const stream = await ttsProvider.synthesize(input, {
          // Honor a per-request voice override, BUT ignore local/placeholder
          // voice names when this route resolved to a CLOUD provider. The UI's
          // Kokoro path posts Kokoro voice names (e.g. "am_puck", "coral") that
          // ElevenLabs/OpenAI don't have — forwarding them 404s and silences
          // read-aloud. Treat "onyx"/"coral" and the Kokoro `xx_name` pattern as
          // "use the configured cloud voice".
          voice: isLocalPlaceholderVoice(data.voice) ? undefined : (data.voice as string),
          format: (responseFormat as "mp3" | "wav" | "pcm" | "opus") || "mp3",
          speed: typeof data.speed === "number" ? data.speed : undefined,
        });
        res.writeHead(200, {
          "Content-Type": ttsProvider.mimeFor(responseFormat),
          "Cache-Control": "no-cache",
        });
        stream.pipe(res);
        return true;
      } catch (err) {
        const status = err instanceof VoiceConfigError ? 503 : 502;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `voice TTS (${route.provider}): ${(err as Error).message}`,
          }),
        );
        return true;
      }
    }

    // ── ElevenLabs branch (Jarvis voice) ─────────────────────────────────
    if (provider === "elevenlabs") {
      const apiKey = resolveElevenLabsKey();
      if (!apiKey) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "ELEVENLABS_API_KEY not set on gateway",
            hint: "Add it to your environment or infinibot config and restart the gateway.",
          }),
        );
        return true;
      }

      const voiceId = voice && voice !== "onyx" ? voice : ELEVENLABS_JARVIS_VOICE_ID;
      const modelId =
        typeof data.model_id === "string" && data.model_id.trim()
          ? data.model_id
          : ELEVENLABS_DEFAULT_MODEL;
      // ElevenLabs offers a streaming endpoint that emits bytes as the
      // model generates — keeps first-audio latency down for long replies.
      const upstream = await fetch(
        `${ELEVENLABS_BASE}/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=2&output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
            "xi-api-key": apiKey,
          },
          body: JSON.stringify({
            text: input,
            model_id: modelId,
            voice_settings: {
              stability: 0.45,
              similarity_boost: 0.8,
              style: 0.0,
              use_speaker_boost: true,
            },
          }),
          // Bound the upstream so a hung provider can't stall the browser's
          // serial TTS queue forever (which would silence the whole reply).
          // On timeout this throws → caller falls back to the other provider.
          signal: AbortSignal.timeout(TTS_UPSTREAM_TIMEOUT_MS),
        },
      );

      if (!upstream.ok || !upstream.body) {
        const errBody = await upstream.text().catch(() => "");
        res.writeHead(upstream.status || 502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: `elevenlabs ${upstream.status}: ${errBody.slice(0, 200)}` }),
        );
        return true;
      }

      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache",
      });
      Readable.fromWeb(upstream.body as any).pipe(res);
      return true;
    }

    // ── Kokoro branch (default) ──────────────────────────────────────────
    // Honor the satellite-wide voice node toggle with automatic fallback: use
    // the local Docker Kokoro or the master's, whichever the user selected —
    // and if that side is down, transparently use the other.
    const kokoroEndpoint = await resolveReachableVoiceUrl("kokoro");
    let KOKORO_URL = kokoroEndpoint.url;
    if (kokoroEndpoint.fellBack) {
      console.warn(
        `[VoiceTts] preferred voice node "${kokoroEndpoint.preferred}" unreachable — fell back to "${kokoroEndpoint.node}" (${KOKORO_URL})`,
      );
    }
    const kokoroBody: Record<string, unknown> = {
      model: "kokoro",
      voice,
      input,
      response_format: responseFormat,
      stream: true,
    };
    const reqSpeed = typeof data.speed === "number" ? data.speed : undefined;
    if (reqSpeed !== undefined) {
      kokoroBody.speed = reqSpeed;
    }
    // No Kokoro container answering: the local Speaches container also serves
    // Kokoro (ONNX) on the same OpenAI-compatible route, so local voice keeps
    // speaking with only Speaches up.
    if (!(await probeVoiceService(KOKORO_URL, 1500))) {
      const speaches = await resolveSpeachesKokoro();
      if (speaches) {
        KOKORO_URL = speaches.url;
        kokoroBody.model = speaches.model;
        delete kokoroBody.stream;
        // Speaches has no OpenAI voice-name aliases ("onyx"): use the
        // configured Kokoro voice (voice.json tts.voice) for a placeholder.
        if (!/^[a-z]{2}_[a-z]+$/.test(voice)) {
          const configured = loadVoiceConfig()?.tts.voice ?? "";
          kokoroBody.voice = /^[a-z]{2}_[a-z]+$/.test(configured) ? configured : "af_heart";
        }
      }
    }
    const upstream = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kokoroBody),
      // Bound the upstream so a hung/unreachable Kokoro container can't stall
      // the browser's serial TTS queue forever. On timeout this throws → the
      // outer catch returns an error and the client falls back to its next
      // synthesis candidate.
      signal: AbortSignal.timeout(TTS_UPSTREAM_TIMEOUT_MS),
    });

    if (!upstream.ok || !upstream.body) {
      const errBody = await upstream.text().catch(() => "");
      res.writeHead(upstream.status || 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `kokoro ${upstream.status}: ${errBody.slice(0, 200)}` }));
      return true;
    }

    const contentType = upstream.headers.get("content-type") || audioMimeFor(responseFormat);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
    });

    Readable.fromWeb(upstream.body as any).pipe(res);
    return true;
  } catch (err: any) {
    console.error("[VoiceTts] proxy error:", err?.message || err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "TTS proxy failed" }));
    }
    return true;
  }
}

/** Speaches' Kokoro TTS model, cached per URL (model ids differ per image: fp16 / fp32). */
let speachesKokoro: { url: string; model: string; at: number } | null = null;
export async function resolveSpeachesKokoro(): Promise<{ url: string; model: string } | null> {
  const { url } = await resolveReachableVoiceUrl("speaches");
  const base = url.replace(/\/+$/, "");
  if (speachesKokoro && speachesKokoro.url === base && Date.now() - speachesKokoro.at < 5 * 60_000) {
    return speachesKokoro;
  }
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const preferred = process.env.SPEACHES_TTS_MODEL?.trim();
    const ids = (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    const model = (preferred && ids.includes(preferred) ? preferred : ids.find((id) => /kokoro/i.test(id))) ?? null;
    if (!model) return null;
    speachesKokoro = { url: base, model, at: Date.now() };
    return speachesKokoro;
  } catch {
    return null;
  }
}

function audioMimeFor(format: string): string {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "opus":
      return "audio/opus";
    case "pcm":
      return "audio/pcm";
    default:
      return "application/octet-stream";
  }
}
