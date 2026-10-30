/**
 * Voice backend router.
 *
 * `selectVoiceBackend()` resolves which backend (cloud or native) should
 * service a given component (STT or TTS) for one request. It probes the
 * primary; on failure (timeout, 5xx, missing API key, missing local model)
 * it falls back per the `fallback` config and emits a structured event so
 * the UI can surface "voice fell back to native".
 *
 * The probe is injectable so this is unit-testable without live services.
 */
import { resolveVoiceUrls } from "../gateway/server-voice-urls.js";
import type { VoiceProvider, VoiceSetupConfig } from "./schema.js";

export type VoiceComponent = "stt" | "tts";

export type VoiceProbeResult = { ok: boolean; error?: string };

/**
 * Tests whether a backend can currently service a component. Returns
 * `{ ok: false, error }` to trigger fallback. Injected in tests.
 */
export type VoiceProbe = (
  kind: VoiceProvider,
  component: VoiceComponent,
  setup: VoiceSetupConfig,
) => Promise<VoiceProbeResult>;

export type VoiceRouteEvent =
  | {
      type: "voice_backend_selected";
      component: VoiceComponent;
      chosen: VoiceProvider;
      at: number;
    }
  | {
      type: "voice_fallback";
      component: VoiceComponent;
      primary: VoiceProvider;
      chosen: VoiceProvider;
      reason: string;
      at: number;
    }
  | {
      type: "voice_unavailable";
      component: VoiceComponent;
      primary: VoiceProvider;
      reason: string;
      at: number;
    };

export type ResolvedVoiceBackend = {
  /** Which backend won. */
  kind: VoiceProvider;
  component: VoiceComponent;
  /** Concrete provider id (e.g. "openai", "kokoro"). */
  provider: string;
  /** Resolved voice id, when known. */
  voice?: string;
  /** Resolved model id, when known. */
  model?: string;
  /** API key for cloud backends. */
  apiKey?: string;
  /** Upstream URL for native backends. */
  url?: string;
  /** True when this is not the configured primary (fell back). */
  fellBack: boolean;
  /** Events emitted during resolution (selection + any fallback). */
  events: VoiceRouteEvent[];
};

export class VoiceUnavailableError extends Error {
  constructor(
    message: string,
    readonly component: VoiceComponent,
    readonly events: VoiceRouteEvent[],
  ) {
    super(message);
    this.name = "VoiceUnavailableError";
  }
}

/** The other backend, for fallback. */
function otherProvider(p: VoiceProvider): VoiceProvider {
  return p === "cloud" ? "native" : "cloud";
}

/** Does the configured fallback policy permit primary→other for this primary? */
function fallbackAllows(setup: VoiceSetupConfig, primary: VoiceProvider): boolean {
  const f = setup.fallback ?? "off";
  if (f === "off") return false;
  if (f === "cloud-to-native") return primary === "cloud";
  if (f === "native-to-cloud") return primary === "native";
  return false;
}

/**
 * Default probe: cheap, no network round-trip beyond a HEAD-style check.
 *   - cloud: requires an API key to be present.
 *   - native: requires the relevant upstream URL to resolve; optionally
 *     reachable (a fetch with a short timeout) when `liveCheck` is set.
 */
export function makeDefaultProbe(
  opts: { liveCheck?: boolean; timeoutMs?: number } = {},
): VoiceProbe {
  const timeoutMs = opts.timeoutMs ?? 2500;
  return async (kind, _component, setup) => {
    if (kind === "cloud") {
      const key = setup.cloud?.apiKey?.trim();
      if (!key) return { ok: false, error: "cloud backend has no API key" };
      return { ok: true };
    }
    // native
    if (!setup.native) return { ok: false, error: "native backend not configured" };
    if (!opts.liveCheck) return { ok: true };
    const urls = resolveVoiceUrls();
    const target = _component === "stt" ? urls.speaches : urls.kokoro;
    if (!target) return { ok: false, error: "no native upstream URL resolved" };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(target, { signal: ctrl.signal }).catch((e) => {
        throw e;
      });
      clearTimeout(timer);
      // Any HTTP answer means the container is up (even a 404 on `/`).
      void res;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `native upstream unreachable: ${(err as Error).message}` };
    }
  };
}

function describe(
  kind: VoiceProvider,
  component: VoiceComponent,
  setup: VoiceSetupConfig,
): Omit<ResolvedVoiceBackend, "fellBack" | "events" | "kind" | "component"> {
  if (kind === "cloud") {
    const c = setup.cloud;
    return {
      provider: component === "stt" ? (c?.stt ?? "openai") : (c?.tts ?? "openai"),
      voice: c?.ttsVoice,
      model: c?.ttsModel,
      apiKey: c?.apiKey,
    };
  }
  const n = setup.native;
  const urls = resolveVoiceUrls();
  return {
    provider: component === "stt" ? (n?.sttModel ?? "whisper-base") : (n?.tts ?? "kokoro"),
    voice: n?.ttsVoice,
    url: component === "stt" ? urls.speaches : urls.kokoro,
  };
}

/**
 * Resolve the backend for one component. Probes primary, falls back per
 * policy, throws `VoiceUnavailableError` when nothing works.
 */
export async function selectVoiceBackend(params: {
  setup: VoiceSetupConfig;
  component: VoiceComponent;
  probe?: VoiceProbe;
  emit?: (event: VoiceRouteEvent) => void;
  now?: () => number;
}): Promise<ResolvedVoiceBackend> {
  const { setup, component } = params;
  const probe = params.probe ?? makeDefaultProbe();
  const now = params.now ?? (() => Date.now());
  const emit = params.emit ?? defaultEmit;
  const events: VoiceRouteEvent[] = [];
  const record = (e: VoiceRouteEvent) => {
    events.push(e);
    emit(e);
  };

  const primary = setup.provider;
  const primaryResult = await probe(primary, component, setup);
  if (primaryResult.ok) {
    record({ type: "voice_backend_selected", component, chosen: primary, at: now() });
    return {
      kind: primary,
      component,
      ...describe(primary, component, setup),
      fellBack: false,
      events,
    };
  }

  // Primary failed. Try fallback if policy allows.
  if (fallbackAllows(setup, primary)) {
    const alt = otherProvider(primary);
    const altResult = await probe(alt, component, setup);
    if (altResult.ok) {
      record({
        type: "voice_fallback",
        component,
        primary,
        chosen: alt,
        reason: primaryResult.error ?? "primary backend failed",
        at: now(),
      });
      return { kind: alt, component, ...describe(alt, component, setup), fellBack: true, events };
    }
  }

  const reason = primaryResult.error ?? "primary backend unavailable";
  record({ type: "voice_unavailable", component, primary, reason, at: now() });
  throw new VoiceUnavailableError(`voice ${component} unavailable: ${reason}`, component, events);
}

function defaultEmit(event: VoiceRouteEvent): void {
  // Structured single-line JSON so log scrapers / the UI activity feed can
  // pick up "voice fell back to native" without parsing prose.
  try {
    console.warn(`[voice-router] ${JSON.stringify(event)}`);
  } catch {
    /* ignore */
  }
}
