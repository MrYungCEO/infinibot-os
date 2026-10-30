/**
 * Voice-provider registry — which backend serves InfiniBot's voice.
 *
 * A *voice provider* is a whole voice backend: it can issue realtime
 * (LiveKit) sessions, and optionally serve STT, TTS and wake word. This sits
 * one level above the STT/TTS adapters in ./providers/registry.ts (Groq,
 * ElevenLabs, native whisper, …), which the built-in provider uses internally.
 *
 * Providers come from two places:
 *   - built-in: "local" (this gateway's own stack: voice.json cloud/native
 *     adapters + the Docker Kokoro/Speaches/LiveKit containers). Always
 *     registered, so voice keeps working with every plugin disabled.
 *   - plugins: a loaded plugin calls `api.registerVoiceProvider()` (manifest
 *     v2 must declare the id in `contributes.voiceProviders`). Read live from
 *     the active plugin registry, so enabling/disabling a plugin (which
 *     reloads the registry) changes the provider set without extra wiring.
 *
 * Selection (`voice.backend` in infinibot.json):
 *   - "auto" (default / unset): "local" — voice runs on this machine, always.
 *     A plugin provider is NEVER chosen automatically (not even for a missing
 *     capability or when local fails): enabling or linking the Robovoice
 *     plugin does not switch voice to it. Cloud voice is an explicit choice
 *     (docs/voice/LOCAL-DEFAULT.md).
 *   - "<id>": that provider (e.g. "robovoice" = cloud voice for devices that
 *     can't run voice locally). If it isn't registered (plugin disabled/errored)
 *     we fall back to "local" and report `fellBack`.
 * Per capability: if the selected provider lacks a capability (e.g. Robovoice
 * does STT/TTS inside its LiveKit agent and exposes no HTTP STT), that
 * capability is served by "local".
 */

import { loadConfig } from "../../config/config.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { isFleetTenantMachineEnv } from "../../saas/fleet-config-guard.js";
import type { SttProvider, TtsProvider } from "./types.js";
import type { VoiceSafetyFlag } from "./commercial-safety.js";

export type VoiceCapability = "realtime" | "stt" | "tts" | "wakeWord";

export const LOCAL_VOICE_PROVIDER_ID = "local";

export type VoiceRealtimeRequest = {
  /** Room name the client proposes (the local provider honours it). */
  room?: string;
  participant?: string;
  /** InfiniBot agent id driving the conversation (character mapping key). */
  agentId?: string;
  /** Host header the browser used — lets providers derive reachable URLs. */
  requestHost?: string;
  /** True when the browser reached the gateway over https. */
  secure?: boolean;
};

export type VoiceRealtimeSession = {
  /** LiveKit server URL the browser connects to. */
  url: string;
  token: string;
  room: string;
  participant: string;
  /** Provider-side character/persona that will answer, when known. */
  characterId?: string;
  characterName?: string;
};

export type VoiceProviderStatus = {
  /** True when the provider can serve a session right now. */
  ready: boolean;
  /** "local" | "self-hosted" | "cloud" — where the voice actually runs. */
  deployment?: "local" | "self-hosted" | "cloud";
  /** One-line human summary ("Robovoice cloud · 3 characters"). */
  detail?: string;
  /** Why it isn't ready (missing URL, unreachable, no credits, …). */
  error?: string;
  /** Commercial-safety labels (non-commercial models in use). */
  safety?: VoiceSafetyFlag[];
  /**
   * Account the provider runs voice on (e.g. the Robovoice org + location), so
   * the voice UI can show whose pipeline is live. Display-only, secret-free.
   */
  account?: {
    org?: string;
    location?: string;
    locationId?: string;
    /** Characters/agents available at that location. */
    agents?: number;
    /** Where the LLM step runs, e.g. "InfiniBot" when the gateway answers. */
    llm?: string;
  };
};

export type VoiceWakeWordInfo = {
  engine: string;
  phrases: string[];
  /** False when the wake-word model is non-commercial (self-host only). */
  commercialSafe: boolean;
};

export interface VoiceProvider {
  /** Unique id; also the value of `voice.backend` that selects it. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly capabilities: readonly VoiceCapability[];
  status(): Promise<VoiceProviderStatus>;
  /**
   * Cheap sync check: false when the provider can't possibly serve yet (e.g.
   * no URL set). "auto" skips unconfigured plugin providers so enabling a
   * voice plugin never breaks voice before it is set up. Default: true.
   */
  configured?(): boolean;
  createRealtimeSession?(req: VoiceRealtimeRequest): Promise<VoiceRealtimeSession>;
  createStt?(): SttProvider;
  createTts?(): TtsProvider;
  wakeWord?(): VoiceWakeWordInfo | null;
}

/** A provider plus where it came from. */
export type RegisteredVoiceProvider = {
  provider: VoiceProvider;
  /** "builtin" or the owning plugin id. */
  source: "builtin" | { pluginId: string };
};

/** Error a provider throws for an expected, user-actionable failure. */
export class VoiceProviderError extends Error {
  constructor(
    message: string,
    /** HTTP status to surface (402 no credits, 503 unreachable, …). */
    readonly status = 502,
    readonly code = "voice_provider_error",
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}

/** Duck-typed check: plugins may load a separate copy of this module. */
export function isVoiceProviderError(err: unknown): err is VoiceProviderError {
  return (
    err instanceof Error &&
    err.name === "VoiceProviderError" &&
    typeof (err as { status?: unknown }).status === "number"
  );
}

const builtins = new Map<string, VoiceProvider>();

/** Register a built-in (core) provider. Idempotent per id. */
export function registerBuiltinVoiceProvider(provider: VoiceProvider): void {
  builtins.set(provider.id, provider);
}

/** Test hook. */
export function clearBuiltinVoiceProvidersForTests(): void {
  builtins.clear();
}

/** All registered providers: built-ins first, then loaded plugin providers. */
export function listVoiceProviders(): RegisteredVoiceProvider[] {
  const out: RegisteredVoiceProvider[] = [];
  for (const provider of builtins.values()) out.push({ provider, source: "builtin" });
  for (const reg of getActivePluginRegistry()?.voiceProviders ?? []) {
    if (builtins.has(reg.provider.id)) continue; // built-ins can't be shadowed
    out.push({ provider: reg.provider, source: { pluginId: reg.pluginId } });
  }
  return out;
}

/** The configured selection: "auto" or a provider id. */
export function configuredVoiceBackend(env: NodeJS.ProcessEnv = process.env): string {
  let v = "auto";
  try {
    const cfg = loadConfig() as { voice?: { backend?: unknown } };
    const raw = cfg.voice?.backend;
    if (typeof raw === "string" && raw.trim()) v = raw.trim();
  } catch {
    /* keep "auto" */
  }
  return hostedVoiceBackend(v, env);
}

/**
 * InfiniBot Cloud: a hosted tenant Machine (FLEET_TENANT_ID) has no local
 * voice stack — voice runs on the hosted Robovoice broker. There, "auto"
 * and "local" mean cloud voice; an explicit other provider id is kept.
 */
export function hostedVoiceBackend(backend: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isFleetTenantMachineEnv(env)) return backend;
  return backend === "auto" || backend === LOCAL_VOICE_PROVIDER_ID
    ? CLOUD_VOICE_PROVIDER_ID
    : backend;
}

/** Provider id of the opt-in cloud voice (extensions/robovoice). */
export const CLOUD_VOICE_PROVIDER_ID = "robovoice";

export type VoiceProviderResolution = {
  provider: VoiceProvider | null;
  source: RegisteredVoiceProvider["source"] | null;
  /** What `voice.backend` asked for. */
  requested: string;
  /** True when the requested provider wasn't available and we fell back. */
  fellBack: boolean;
  reason?: string;
};

/**
 * Pick the provider that serves `capability`. Returns provider=null only when
 * nothing (not even the built-in) can serve it — the "no voice provider" state.
 */
export function resolveVoiceProvider(
  capability: VoiceCapability,
  backend: string = configuredVoiceBackend(),
): VoiceProviderResolution {
  const all = listVoiceProviders();
  const can = (r: RegisteredVoiceProvider) => r.provider.capabilities.includes(capability);
  const local = all.find((r) => r.provider.id === LOCAL_VOICE_PROVIDER_ID && can(r)) ?? null;
  const done = (r: RegisteredVoiceProvider | null, fellBack: boolean, reason?: string) => ({
    provider: r?.provider ?? null,
    source: r?.source ?? null,
    requested: backend,
    fellBack,
    reason,
  });

  if (backend === "auto" || backend === LOCAL_VOICE_PROVIDER_ID) {
    // Local or nothing: never route to a cloud plugin the user didn't pick.
    return done(local, false, local ? undefined : `local voice does not provide ${capability}`);
  }
  const selected = all.find((r) => r.provider.id === backend);
  if (!selected) {
    return done(local, true, `voice provider "${backend}" is not available (plugin disabled?)`);
  }
  if (!can(selected)) {
    // Not a failure: the selected backend just doesn't do this piece.
    return done(local, false, `"${backend}" does not provide ${capability}; using built-in`);
  }
  return done(selected, false);
}

/** The provider the user thinks of as "active" (the realtime one). */
export function activeVoiceProviderId(): string | null {
  return resolveVoiceProvider("realtime").provider?.id ?? null;
}
