/**
 * Voice stack endpoint resolution.
 *
 * The gateway runs three voice-related upstreams: Kokoro TTS (8882),
 * Speaches STT (8002), and LiveKit (7882). On master nodes the
 * containers are local, so defaults to localhost are fine. On
 * satellites they're remote — the satellite federation manager writes
 * URLs derived from the master's hostname into infinibot.json's `voice`
 * block on connect.
 *
 * This module is the single resolution path the voice handlers go
 * through, so the "where does this URL come from?" question has one
 * answer:
 *
 *   1. infinibot.json `voice.{kokoroUrl,speachesUrl,livekitUrl}`  ← config (federation-aware)
 *   2. process.env.{KOKORO_URL,SPEACHES_URL,LIVEKIT_URL}          ← legacy/manual
 *   3. localhost defaults                                         ← bare-machine fallback
 *
 * Resolution happens on every call (no module-top-level capture) so
 * a config write — including the satellite bootstrap that fires on
 * master connect — takes effect on the next voice request without
 * a gateway restart.
 */

import { loadConfig } from "../config/io.js";
import { resolveVoiceNode, type VoiceNode } from "./voice/config.js";
import { readSetupState } from "./voice/local-setup/runner.js";

const DEFAULT_KOKORO = "http://localhost:8882";
const DEFAULT_SPEACHES = "http://localhost:8002";
const DEFAULT_LIVEKIT = "ws://localhost:7882";

/** This node's OWN local Docker endpoints — fixed compose ports on localhost. */
const LOCAL_VOICE_URLS: VoiceUrls = {
  kokoro: DEFAULT_KOKORO,
  speaches: DEFAULT_SPEACHES,
  livekit: DEFAULT_LIVEKIT,
  livekitExternal: DEFAULT_LIVEKIT,
};

export interface VoiceUrls {
  kokoro: string;
  speaches: string;
  livekit: string;
  /** External LiveKit URL — falls back to `livekit` when unset. Used
   *  when LiveKit is behind a different reverse-proxy hostname from
   *  what clients use internally. */
  livekitExternal: string;
}

/**
 * Read the live voice URLs from config + env + defaults. Cheap (one
 * loadConfig call which has its own cache).
 */
export function resolveVoiceUrls(): VoiceUrls {
  const cfg = loadConfig() as { voice?: Record<string, unknown> };
  const v = (cfg.voice ?? {}) as {
    kokoroUrl?: string;
    speachesUrl?: string;
    livekitUrl?: string;
    livekitUrlExternal?: string;
  };

  const kokoro = pick(v.kokoroUrl, process.env.KOKORO_URL, DEFAULT_KOKORO);
  const speaches = pick(v.speachesUrl, process.env.SPEACHES_URL, DEFAULT_SPEACHES);
  const livekit = pick(v.livekitUrl, process.env.LIVEKIT_URL, DEFAULT_LIVEKIT);
  const livekitExternal = pick(v.livekitUrlExternal, process.env.LIVEKIT_URL_EXTERNAL, livekit);

  return { kokoro, speaches, livekit, livekitExternal };
}

function pick(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

/**
 * The EXPLICITLY-configured external LiveKit URL (config or env), or "" when
 * unset. Unlike `resolveVoiceUrls().livekitExternal` this does NOT fall back to
 * the localhost default — callers use the empty result to decide whether to
 * derive a browser-reachable URL from the incoming request host instead.
 */
export function getExplicitLivekitExternalUrl(): string {
  const cfg = loadConfig() as { voice?: { livekitUrlExternal?: string } };
  return pick(cfg.voice?.livekitUrlExternal, process.env.LIVEKIT_URL_EXTERNAL);
}

/** Port of the resolved (internal) LiveKit URL, defaulting to 7882. */
export function resolveLivekitPort(): string {
  try {
    return new URL(resolveVoiceUrls().livekit).port || "7882";
  } catch {
    return "7882";
  }
}

/**
 * Resolve voice URLs for an EXPLICIT node:
 *   - "local"  → this node's own localhost containers (ignores master URLs).
 *   - "master" → the configured/federation URLs (resolveVoiceUrls()).
 * Used by the satellite-wide voice toggle so a satellite can deliberately use
 * its own Docker stack instead of the master's.
 */
export function resolveVoiceUrlsForNode(node: VoiceNode): VoiceUrls {
  if (node !== "local") return resolveVoiceUrls();
  // The one-click setup may have used other ports (default ones were taken).
  const setup = readSetupState();
  const ok = setup?.phase === "done";
  return {
    ...LOCAL_VOICE_URLS,
    ...(ok && setup.services.kokoro?.url ? { kokoro: setup.services.kokoro.url } : {}),
    ...(ok && setup.services.speaches?.url ? { speaches: setup.services.speaches.url } : {}),
  };
}

/** Probe a voice service's `/v1/models` (Kokoro + Speaches both expose it). */
export async function probeVoiceService(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  if (!baseUrl) return false;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ResolvedVoiceEndpoint {
  /** The base URL to use for this request. */
  url: string;
  /** Which node the URL belongs to after any fallback. */
  node: VoiceNode;
  /** The user's configured preference (before fallback). */
  preferred: VoiceNode;
  /** True when the preferred node was unreachable and we fell back. */
  fellBack: boolean;
}

/**
 * Pick the reachable endpoint for a voice service honoring the satellite-wide
 * node toggle, with AUTOMATIC FALLBACK: probe the preferred node first; if it's
 * down, use the other node when IT answers; otherwise return the preferred URL
 * anyway so the caller fails with a clear upstream error rather than silently
 * doing nothing. This is what makes "select local or master" reliable.
 */
export async function resolveReachableVoiceUrl(
  service: "kokoro" | "speaches",
): Promise<ResolvedVoiceEndpoint> {
  const preferred = resolveVoiceNode();
  const other: VoiceNode = preferred === "local" ? "master" : "local";
  const preferredUrl = resolveVoiceUrlsForNode(preferred)[service];
  const otherUrl = resolveVoiceUrlsForNode(other)[service];

  if (await probeVoiceService(preferredUrl)) {
    return { url: preferredUrl, node: preferred, preferred, fellBack: false };
  }
  // Only fall back when the other node is genuinely a DIFFERENT endpoint that
  // actually answers (on a standalone, both resolve to localhost — no fallback).
  if (otherUrl && otherUrl !== preferredUrl && (await probeVoiceService(otherUrl))) {
    return { url: otherUrl, node: other, preferred, fellBack: true };
  }
  return { url: preferredUrl, node: preferred, preferred, fellBack: false };
}
