/**
 * Voice runtime ROUTER + readiness probe.
 *
 * The single place that decides — for a given saved voice.json — WHICH backend
 * an STT/TTS request should hit, and whether that backend can actually run.
 * Both same-origin proxies (server-voice-stt.ts / server-voice-tts.ts) call
 * resolveSttRoute()/resolveTtsRoute() instead of branching ad-hoc, so the
 * "cloud vs native vs docker vs not-configured" decision lives in one file.
 *
 * Root cause this fixes: the proxies used to treat an ABSENT voice.json (and a
 * config with a missing key) as "fall through to the Speaches/Kokoro docker
 * container". Users who never chose docker got the misleading
 * "Bring up Speaches: docker compose …" error. Now an unconfigured / mis-keyed
 * stack fails with a specific, actionable message and NEVER silently defaults
 * to docker.
 */

import {
  loadVoiceConfig,
  resolveSttApiKey,
  resolveTtsApiKey,
  type VoiceConfig,
  type VoiceSttConfig,
  type VoiceTtsConfig,
} from "./config.js";
import { resolveVoiceUrls } from "../server-voice-urls.js";

/** Which backend a voice request resolves to. */
export type VoiceRouteKind = "cloud" | "native" | "docker" | "unconfigured";

export interface VoiceRoute {
  component: "stt" | "tts";
  kind: VoiceRouteKind;
  /** Provider id (groq/openai/native/…) or "speaches"/"kokoro" for docker. */
  provider: string | null;
  /** Cloud/docker endpoint URL, or native binary path. null when unconfigured. */
  endpoint: string | null;
  /** Cloud key resolvable (config or env). Always false for native/docker. */
  hasKey: boolean;
  /**
   * User-facing blocker. null ⇒ proceed. When set, the proxy MUST surface this
   * (503) and MUST NOT fall through to the docker container.
   */
  error: string | null;
  /** The loaded config (null only when unconfigured). */
  cfg: VoiceConfig | null;
}

const NOT_CONFIGURED =
  "STT not configured — run `infinibot quickstart` and complete the Voice step.";
const TTS_NOT_CONFIGURED =
  "TTS not configured — run `infinibot quickstart` and complete the Voice step.";

/**
 * Decide the STT route from the saved voice.json.
 *   - no voice.json          → unconfigured (clear error, NOT docker)
 *   - mode === 'docker'      → docker (Speaches); caller probes the endpoint
 *   - provider === 'native'  → native; error if whisper binary/model missing
 *   - cloud provider         → cloud; error if no resolvable API key
 */
export function resolveSttRoute(cfg: VoiceConfig | null = loadVoiceConfig()): VoiceRoute {
  const base = { component: "stt" as const };
  if (!cfg) {
    return {
      ...base,
      kind: "unconfigured",
      provider: null,
      endpoint: null,
      hasKey: false,
      error: NOT_CONFIGURED,
      cfg: null,
    };
  }
  // "Native (Local)" means the local Docker voice stack — NOT a whisper.cpp
  // binary. So mode==='docker' AND provider==='native' both route to Speaches
  // (the docker path honors the satellite local/master voiceNode toggle with
  // automatic fallback). There is no in-process/binary STT path anymore.
  if (cfg.mode === "docker" || cfg.stt.provider === "native") {
    return {
      ...base,
      kind: "docker",
      provider: "speaches",
      endpoint: resolveVoiceUrls().speaches,
      hasKey: false,
      error: null,
      cfg,
    };
  }
  const stt: VoiceSttConfig = cfg.stt;
  const hasKey = Boolean(resolveSttApiKey(stt));
  return {
    ...base,
    kind: "cloud",
    provider: stt.provider,
    endpoint: null,
    hasKey,
    error: hasKey
      ? null
      : "Cloud STT requires an API key — set it via Quickstart → Voice → STT provider.",
    cfg,
  };
}

/**
 * Decide the TTS route. Mirrors resolveSttRoute:
 *   - no voice.json          → unconfigured
 *   - mode === 'docker'      → docker (Kokoro); caller probes the endpoint
 *   - provider === 'native'  → native (local engine; no key)
 *   - cloud provider         → cloud; error if no resolvable API key
 */
export function resolveTtsRoute(cfg: VoiceConfig | null = loadVoiceConfig()): VoiceRoute {
  const base = { component: "tts" as const };
  if (!cfg) {
    return {
      ...base,
      kind: "unconfigured",
      provider: null,
      endpoint: null,
      hasKey: false,
      error: TTS_NOT_CONFIGURED,
      cfg: null,
    };
  }
  // "Native (Local)" means the local Docker Kokoro container — NOT in-process
  // kokoro-js. So mode==='docker' AND provider==='native' both route to the
  // docker Kokoro endpoint (honoring the local/master voiceNode toggle with
  // automatic fallback). There is no in-process/binary TTS path anymore.
  if (cfg.mode === "docker" || cfg.tts.provider === "native") {
    return {
      ...base,
      kind: "docker",
      provider: "kokoro",
      endpoint: resolveVoiceUrls().kokoro,
      hasKey: false,
      error: null,
      cfg,
    };
  }
  const tts: VoiceTtsConfig = cfg.tts;
  const hasKey = Boolean(resolveTtsApiKey(tts));
  return {
    ...base,
    kind: "cloud",
    provider: tts.provider,
    endpoint: null,
    hasKey,
    error: hasKey
      ? null
      : "Cloud TTS requires an API key — set it via Quickstart → Voice → TTS provider.",
    cfg,
  };
}

// ── Readiness probe (for voice.runtime.status + quickstart Done summary) ──────

export interface VoiceComponentStatus {
  component: "stt" | "tts";
  kind: VoiceRouteKind;
  provider: string | null;
  endpoint: string | null;
  hasKey: boolean;
  /** Best-effort: is this backend actually usable right now? */
  reachable: boolean;
  detail: string;
}

export interface VoiceRuntimeStatus {
  mode: VoiceConfig["mode"] | null;
  configured: boolean;
  stt: VoiceComponentStatus;
  tts: VoiceComponentStatus;
  /** Both components reachable. */
  ok: boolean;
}

/** Whether the native TTS engine (kokoro-js) can be imported. Cached after the
 *  first resolve since module availability doesn't change within a process. */
let kokoroLoadable: boolean | null = null;
async function nativeTtsLoadable(): Promise<boolean> {
  if (kokoroLoadable !== null) return kokoroLoadable;
  try {
    await import(/* @vite-ignore */ "kokoro-js" as any);
    kokoroLoadable = true;
  } catch {
    kokoroLoadable = false;
  }
  return kokoroLoadable;
}

/** Probe a docker endpoint's /v1/models with a short timeout. */
async function probeDocker(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function componentStatus(route: VoiceRoute): Promise<VoiceComponentStatus> {
  const shared = {
    component: route.component,
    kind: route.kind,
    provider: route.provider,
    endpoint: route.endpoint,
    hasKey: route.hasKey,
  };
  if (route.kind === "unconfigured") {
    return { ...shared, reachable: false, detail: route.error ?? "not configured" };
  }
  if (route.error) {
    // Missing key / missing native binary — known-unreachable with a reason.
    return { ...shared, reachable: false, detail: route.error };
  }
  if (route.kind === "docker") {
    const reachable = route.endpoint ? await probeDocker(route.endpoint) : false;
    return {
      ...shared,
      reachable,
      detail: reachable
        ? `${route.endpoint} reachable`
        : `${route.endpoint} unreachable — bring up the container (\`docker compose -f docker-compose.voice.yaml up -d\`)`,
    };
  }
  if (route.kind === "native") {
    if (route.component === "stt") {
      // resolveSttRoute already verified the binary/model exist when error===null.
      return { ...shared, reachable: true, detail: `whisper.cpp ready (${route.endpoint})` };
    }
    // Native TTS = kokoro-js (in-process). It's an optional dependency, so the
    // honest readiness signal is whether the package resolves — otherwise a
    // synth would throw at runtime despite "configured".
    const kokoroOk = await nativeTtsLoadable();
    return {
      ...shared,
      reachable: kokoroOk,
      detail: kokoroOk
        ? "kokoro-js ready (weights download on first use)"
        : "native TTS engine (kokoro-js) not installed — run Quickstart → Voice → Install or `npm i kokoro-js`",
    };
  }
  // cloud + key present. We don't spend a live API call here; key presence is
  // the readiness signal the wizard/dashboard need.
  return { ...shared, reachable: true, detail: `${route.provider} key present` };
}

/** Full STT+TTS readiness snapshot — drives voice.runtime.status + 🎙 indicator. */
export async function probeVoiceRuntime(): Promise<VoiceRuntimeStatus> {
  const cfg = loadVoiceConfig();
  const sttRoute = resolveSttRoute(cfg);
  const ttsRoute = resolveTtsRoute(cfg);
  const [stt, tts] = await Promise.all([componentStatus(sttRoute), componentStatus(ttsRoute)]);
  return {
    mode: cfg?.mode ?? null,
    configured: Boolean(cfg),
    stt,
    tts,
    ok: stt.reachable && tts.reachable,
  };
}
