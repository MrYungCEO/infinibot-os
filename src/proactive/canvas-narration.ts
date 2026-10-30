/**
 * Per-scene narration baking for the `infinite-canvas-walkthrough` media kind.
 *
 * THE MOAT: each canvas scene owns its OWN narration audio, separate from the
 * voice orchestrator's reply path. At emit-time we walk the payload, synthesize
 * any scene whose narration has `ttsText` but no `audioUrl` via the runtime
 * voice route (cloud / native / Kokoro docker — same decision point as the live
 * /api/voice/tts proxy), cache the mp3 on disk keyed by hash(text+voice), and
 * rewrite `narration.audioUrl` to a `/api/proactive/audio/:hash` link the
 * gateway serves back. The overlay then plays the baked audio per scene and
 * locks its beat animations to the audio clock.
 *
 * Best-effort: if synthesis is unavailable (e.g. Kokoro container down, no cloud
 * key) we leave `ttsText` intact so the frontend can fall back to a live
 * /api/voice/tts synth — the walkthrough still flows, just not pre-baked.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { createTtsProvider, VoiceConfigError } from "../gateway/voice/providers/registry.js";
import { resolveTtsRoute } from "../gateway/voice/runtime-status.js";
import { resolveVoiceUrls } from "../gateway/server-voice-urls.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { InfiniteCanvasWalkthroughMedia } from "./popup-types.js";

const log = createSubsystemLogger("proactive-canvas-narration");

/** Sub-directory of the state dir where baked scene audio is cached. */
export const PROACTIVE_AUDIO_SUBDIR = "proactive-audio";

/** Absolute path to the baked-audio cache dir for a given state dir. */
export function proactiveAudioDir(stateDir: string): string {
  return path.join(stateDir, PROACTIVE_AUDIO_SUBDIR);
}

/** Stable cache key for a (text, voice) pair. */
function narrationHash(text: string, voice: string): string {
  return createHash("sha1").update(`${voice}::${text}`).digest("hex").slice(0, 24);
}

/** Resolve the cache file path for a hash (always .mp3 — we bake mp3). */
function audioFileFor(stateDir: string, hash: string): string {
  return path.join(proactiveAudioDir(stateDir), `${hash}.mp3`);
}

/** The HTTP route the frontend fetches a baked clip from. */
function audioUrlFor(hash: string): string {
  return `/api/proactive/audio/${hash}.mp3`;
}

/**
 * Synthesize `text` to an mp3 Buffer via the runtime voice route. Returns null
 * when no usable route is configured (caller treats this as "leave ttsText for
 * live fallback"). Mirrors handleVoiceTtsRequest's routing.
 */
async function synthToMp3(text: string, voice: string): Promise<Buffer | null> {
  const route = resolveTtsRoute();

  // Cloud / native engines go through the provider abstraction.
  if (route.kind !== "docker") {
    if (route.error || !route.cfg) {
      log.warn("tts route unusable — skipping bake", { kind: route.kind, error: route.error });
      return null;
    }
    try {
      const provider = createTtsProvider(route.cfg.tts);
      const stream = await provider.synthesize(text, {
        voice: voice && voice !== "onyx" ? voice : undefined,
        format: "mp3",
      });
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return chunks.length ? Buffer.concat(chunks) : null;
    } catch (e) {
      const why = e instanceof VoiceConfigError ? "config" : "synth";
      log.warn(`cloud/native tts bake failed (${why})`, {
        provider: route.provider,
        err: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  // Docker (Kokoro) — hit the OpenAI-compatible speech endpoint directly.
  try {
    const { kokoro } = resolveVoiceUrls();
    const resp = await fetch(`${kokoro}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kokoro",
        voice: voice || "af_heart",
        input: text,
        response_format: "mp3",
      }),
    });
    if (!resp.ok) {
      log.warn("kokoro bake http error", { status: resp.status });
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.length ? buf : null;
  } catch (e) {
    log.warn("kokoro bake failed (container down?)", {
      err: e instanceof Error ? e.message : String(e),
      hint: "docker ps | grep kokoro",
    });
    return null;
  }
}

/**
 * Walk a walkthrough payload and bake any missing per-scene narration audio.
 * Mutates `media.scenes[*].narration.audioUrl` in place and returns the same
 * object. Never throws — synthesis failures degrade to live-synth fallback.
 *
 * `voiceSuppress` defaults to true for this kind so the orchestrator stays
 * silent while the scene audio plays.
 */
export async function bakeScenesNarration(
  media: InfiniteCanvasWalkthroughMedia,
  stateDir: string,
): Promise<InfiniteCanvasWalkthroughMedia> {
  if (media.voiceSuppress == null) media.voiceSuppress = true;
  const scenes = Array.isArray(media.scenes) ? media.scenes : [];
  let baked = 0;
  let cached = 0;
  let skipped = 0;

  for (const scene of scenes) {
    const nar = scene.narration;
    if (!nar) continue;
    // Already has explicit audio — leave it (pre-baked / external).
    if (nar.audioUrl) continue;
    const text = (nar.ttsText || "").trim();
    if (!text) continue;
    const voice = (nar.voice || "").trim() || "af_heart";
    const hash = narrationHash(text, voice);
    const file = audioFileFor(stateDir, hash);

    try {
      await fs.access(file);
      nar.audioUrl = audioUrlFor(hash);
      cached++;
      continue;
    } catch {
      /* not cached yet — synthesize below */
    }

    const buf = await synthToMp3(text, voice);
    if (!buf) {
      // Leave ttsText so the overlay can live-synth as a fallback.
      skipped++;
      continue;
    }
    try {
      await fs.mkdir(proactiveAudioDir(stateDir), { recursive: true });
      await fs.writeFile(file, buf);
      nar.audioUrl = audioUrlFor(hash);
      baked++;
    } catch (e) {
      skipped++;
      log.warn("failed to persist baked audio", {
        hash,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (baked || cached || skipped)
    log.info("scene narration baked", { baked, cached, skipped, total: scenes.length });
  return media;
}
