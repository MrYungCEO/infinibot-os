/**
 * Universal Ollama safety-net for the agent model-fallback chain.
 *
 * When every configured API provider (Anthropic, OpenAI, ...) fails, the
 * gateway should still be able to answer by falling through to a locally
 * installed Ollama model. This module probes the local Ollama daemon (cached)
 * and produces a short list of `ollama/<model>` fallback candidates, preferring
 * the Qwen family and other capable generalists.
 *
 * This is ON by default for every user (standardization). It is suppressed only
 * when the caller passes an explicit fallbacks override, or when
 * `agents.defaults.model.ollamaSafetyNet` is set to `false` in config.
 */

import type { InfinibotConfig } from "../config/config.js";
import { localProvidersEnabled } from "../saas/config.js";

export interface OllamaSafetyNetOptions {
  cfg?: InfinibotConfig;
  /** When true, do not add the safety net (caller wants pure configured behavior). */
  disabled?: boolean;
  /** Preferred model order — first installed match wins. Defaults to PREFERRED_OLLAMA_MODELS. */
  preferred?: string[];
}

/**
 * Priority order for the safety net: Qwen first (user preference), then capable
 * generalists, then small last-resort models.
 */
export const PREFERRED_OLLAMA_MODELS: readonly string[] = [
  "qwen2.5:32b", // user's stated preference ("qwen 27b" — actual Qwen sizes are 14B/32B; 32B is closest)
  "qwen3:32b",
  "qwen2.5:14b",
  "qwen3:14b",
  "llama3.3:70b",
  "llama3.1:70b",
  "qwen2.5:7b",
  "llama3.1:8b",
  "llama3.2:latest",
];

/** How many safety-net candidates to append at most. */
const MAX_SAFETY_NET_CANDIDATES = 3;
/** Probe cache TTL. */
const PROBE_TTL_MS = 60_000;
/** Default Ollama host when nothing is configured. */
const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

interface ProbeResult {
  /** Wall-clock time the probe landed. */
  at: number;
  /** Host the probe targeted. */
  host: string;
  /** Whether the daemon answered at all. */
  running: boolean;
  /** Installed model names, in the order Ollama reported them. */
  models: string[];
}

let probeCache: ProbeResult | null = null;
let inFlight: Promise<ProbeResult> | null = null;
let exerciseLogged = false;

/**
 * Resolve the Ollama base URL from config, falling back to env and the local
 * default. Accepts both the documented `providers.ollama.baseUrl` shape and the
 * existing `integrations.ollama.host` shape so we line up with whatever the
 * install already configured.
 */
function resolveOllamaHost(cfg?: InfinibotConfig): string {
  const providers = (cfg as { providers?: { ollama?: { baseUrl?: string } } } | undefined)
    ?.providers;
  const providerBaseUrl = providers?.ollama?.baseUrl;
  if (typeof providerBaseUrl === "string" && providerBaseUrl.trim()) {
    return providerBaseUrl.trim().replace(/\/+$/, "");
  }
  const integrationsHost = (cfg as { integrations?: { ollama?: { host?: string } } } | undefined)
    ?.integrations?.ollama?.host;
  if (typeof integrationsHost === "string" && integrationsHost.trim()) {
    return integrationsHost.trim().replace(/\/+$/, "");
  }
  const envHost = process.env.OLLAMA_HOST?.trim();
  if (envHost) {
    return (envHost.startsWith("http") ? envHost : `http://${envHost}`).replace(/\/+$/, "");
  }
  return DEFAULT_OLLAMA_HOST;
}

/** Hit `/api/tags` and return the installed model list (empty + not-running on any failure). */
async function probeOllama(host: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return { at: Date.now(), host, running: false, models: [] };
    }
    const data = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const models = Array.isArray(data?.models)
      ? data.models
          .map((m) => (typeof m?.name === "string" ? m.name.trim() : ""))
          .filter((name): name is string => name.length > 0)
      : [];
    return { at: Date.now(), host, running: true, models };
  } catch {
    return { at: Date.now(), host, running: false, models: [] };
  }
}

function cacheIsFresh(host: string): boolean {
  return (
    probeCache !== null && probeCache.host === host && Date.now() - probeCache.at < PROBE_TTL_MS
  );
}

/** Kick off a probe (deduped) and refresh the cache when it lands. */
function startProbe(host: string): Promise<ProbeResult> {
  if (inFlight) return inFlight;
  inFlight = probeOllama(host)
    .then((result) => {
      probeCache = result;
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Turn a resolved probe into ordered `ollama/<model>` fallback refs. */
function buildFallbacks(probe: ProbeResult, preferred: readonly string[]): string[] {
  if (!probe.running || probe.models.length === 0) return [];

  const installed = probe.models;
  const installedLower = new Map(installed.map((name) => [name.toLowerCase(), name] as const));

  const picks: string[] = [];
  for (const want of preferred) {
    const match = installedLower.get(want.trim().toLowerCase());
    if (match && !picks.includes(match)) picks.push(match);
    if (picks.length >= MAX_SAFETY_NET_CANDIDATES) break;
  }

  // No preferred match installed — fall back to whatever is installed.
  if (picks.length === 0) {
    picks.push(...installed.slice(0, MAX_SAFETY_NET_CANDIDATES));
  }

  return picks.slice(0, MAX_SAFETY_NET_CANDIDATES).map((name) => `ollama/${name}`);
}

/**
 * Synchronous, cache-backed safety-net resolver.
 *
 * The first call (cold cache) kicks off an async probe and returns `[]`;
 * subsequent calls after the probe lands return the resolved candidate list.
 * Use {@link getOllamaSafetyNetFallbacksAsync} when you can await the probe.
 */
export function getOllamaSafetyNetFallbacks(opts?: OllamaSafetyNetOptions): string[] {
  // Cloud-only (SaaS) installs never fall back to a local Ollama daemon.
  if (opts?.disabled || !localProvidersEnabled()) return [];
  const host = resolveOllamaHost(opts?.cfg);
  const preferred = opts?.preferred ?? PREFERRED_OLLAMA_MODELS;

  if (cacheIsFresh(host) && probeCache) {
    return buildFallbacks(probeCache, preferred);
  }

  // Cold or stale cache: kick off a probe and return empty for now.
  void startProbe(host);
  return [];
}

/**
 * Async safety-net resolver — awaits the probe (reusing a fresh cache) before
 * returning. This is what the model-fallback runner uses.
 */
export async function getOllamaSafetyNetFallbacksAsync(
  opts?: OllamaSafetyNetOptions,
): Promise<string[]> {
  // Cloud-only (SaaS) installs never fall back to a local Ollama daemon.
  if (opts?.disabled || !localProvidersEnabled()) return [];
  const host = resolveOllamaHost(opts?.cfg);
  const preferred = opts?.preferred ?? PREFERRED_OLLAMA_MODELS;

  const probe = cacheIsFresh(host) && probeCache ? probeCache : await startProbe(host);
  return buildFallbacks(probe, preferred);
}

/** Emit the `[OLLAMA-SAFETY-NET]` log line the first time the net is exercised. */
export function logOllamaSafetyNetExercised(model: string): void {
  if (exerciseLogged) return;
  exerciseLogged = true;
  // eslint-disable-next-line no-console
  console.log(`[OLLAMA-SAFETY-NET] using ${model} as last-resort fallback`);
}

/** Bust the probe cache (and the one-shot log flag). Primarily for tests. */
export function clearOllamaProbeCache(): void {
  probeCache = null;
  inFlight = null;
  exerciseLogged = false;
}
