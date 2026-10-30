/**
 * Voice-provider client helpers — the UI side of the core voice-provider
 * registry (gateway `voice.providers.list` / `voice.providers.select`, see
 * src/gateway/voice/provider-registry.ts).
 *
 * Voice UI never hardcodes a backend: it asks the gateway which provider is
 * active and gets LiveKit sessions from `/api/voice/connection`, which the
 * active provider (built-in "local" or a plugin such as Robovoice) serves.
 */

import { isCloudBuild } from "../cloud/cloud-env.js";
import type { GatewayBrowserClient } from "../gateway.js";

export type VoiceSafetyFlag = { code: string; severity: string; subject: string; message: string };

export type VoiceProviderInfo = {
  id: string;
  label: string;
  description?: string;
  capabilities: string[];
  source: "builtin" | "plugin";
  pluginId?: string;
  active: boolean;
  status: {
    ready: boolean;
    deployment?: "local" | "self-hosted" | "cloud";
    detail?: string;
    error?: string;
    safety?: VoiceSafetyFlag[];
    /** Account the provider runs voice on (Robovoice org + location, who answers). */
    account?: VoiceProviderAccount;
  };
};

export type VoiceProviderAccount = {
  org?: string;
  location?: string;
  locationId?: string;
  agents?: number;
  llm?: string;
};

export type VoiceProvidersPayload = {
  backend: string;
  active: Record<"realtime" | "stt" | "tts" | "wakeWord", string | null>;
  fellBack: boolean;
  fallbackReason?: string;
  providers: VoiceProviderInfo[];
};

export type VoiceProviderSummary = {
  /** "provider" = a plugin provider is active, "local" = built-in, "none" = nothing. */
  kind: "provider" | "local" | "none";
  title: string;
  detail: string;
  ready: boolean;
  /** Self-host-only labels on the active provider. */
  safety: VoiceSafetyFlag[];
  warning?: string;
  /** Org / location the active provider runs on (plugin providers). */
  account?: VoiceProviderAccount;
};

/** "Org · Location · LLM InfiniBot" (empty when the provider reports no account). */
export function describeVoiceAccount(a: VoiceProviderAccount | undefined): string {
  if (!a) return "";
  return [a.org, a.location, a.llm ? `LLM ${a.llm}` : ""].filter(Boolean).join(" · ");
}

export function summarizeVoiceProviders(p: VoiceProvidersPayload | null | undefined): VoiceProviderSummary {
  const activeId = p?.active.realtime ?? null;
  const active = p?.providers.find((x) => x.id === activeId);
  if (!p || !active) {
    return {
      kind: "none",
      title: "No voice provider",
      detail: "Voice isn't available on this gateway. Set it up in Setup › Voice.",
      ready: false,
      safety: [],
    };
  }
  const safety = active.status.safety ?? [];
  const warning = p.fellBack
    ? `${p.fallbackReason ?? "Selected voice provider unavailable"} — using built-in voice.`
    : active.status.error;
  if (active.source === "builtin") {
    return {
      kind: "local",
      title: "Local voice",
      detail: active.status.detail ?? "Built-in voice stack",
      ready: active.status.ready,
      safety,
      warning,
    };
  }
  const where =
    active.status.deployment === "cloud" ? "cloud" : active.status.deployment === "self-hosted" ? "self-hosted" : "";
  return {
    kind: "provider",
    title: `${active.label}${where ? ` · ${where}` : ""}`,
    detail: active.status.detail ?? active.description ?? "",
    ready: active.status.ready,
    safety,
    warning,
    account: active.status.account,
  };
}

export async function loadVoiceProviders(
  client: GatewayBrowserClient | null | undefined,
): Promise<VoiceProvidersPayload | null> {
  if (!client) return null;
  try {
    return await client.request<VoiceProvidersPayload>("voice.providers.list", {});
  } catch {
    return null;
  }
}

export async function selectVoiceProvider(
  client: GatewayBrowserClient,
  id: string,
): Promise<VoiceProvidersPayload> {
  const payload = await client.request<VoiceProvidersPayload>("voice.providers.select", { id });
  setVoiceProvidersState(payload);
  return payload;
}

/**
 * One-click "Switch to local voice" (shown when cloud voice is busy): clears
 * voice.backend so the gateway is back on local voice ("auto").
 */
export async function switchToLocalVoice(client: GatewayBrowserClient | null): Promise<void> {
  if (!client) throw new Error("gateway not connected");
  await selectVoiceProvider(client, "auto");
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(VOICE_PROVIDER_EVENT));
}

// ── Which voice UI the app shows ─────────────────────────────────────────────
// Local voice (the built-in Voice Terminal, <voice-chat>) is the default.
// Cloud voice (the Robovoice console + calls) is shown only when the owner
// selected it (voice.backend = "robovoice") AND the gateway actually serves
// realtime voice from it. Unknown / not loaded yet = local.

/** Provider id of the opt-in cloud voice option. */
export const CLOUD_VOICE_PROVIDER_ID = "robovoice";
/** Window event fired whenever the known provider selection changes. */
export const VOICE_PROVIDER_EVENT = "infinibot:voice-provider";

let providersState: VoiceProvidersPayload | null = null;
let providersLoad: Promise<VoiceProvidersPayload | null> | null = null;

/** Pure: does this payload put the app on cloud voice (Robovoice)? */
export function cloudVoiceSelected(p: VoiceProvidersPayload | null | undefined): boolean {
  return !!p && p.backend === CLOUD_VOICE_PROVIDER_ID && p.active.realtime === CLOUD_VOICE_PROVIDER_ID;
}

/** True when the app shows cloud voice (Robovoice) instead of local voice. */
export function isCloudVoiceActive(): boolean {
  // InfiniBot Cloud has no local voice: until the tenant gateway reports its
  // providers, assume cloud voice (it resolves "auto" to Robovoice there).
  if (!providersState && isCloudBuild()) return true;
  return cloudVoiceSelected(providersState);
}

export function getVoiceProvidersState(): VoiceProvidersPayload | null {
  return providersState;
}

export function setVoiceProvidersState(p: VoiceProvidersPayload | null): void {
  const before = isCloudVoiceActive();
  providersState = p;
  try {
    window.dispatchEvent(
      new CustomEvent(VOICE_PROVIDER_EVENT, { detail: { cloud: isCloudVoiceActive(), changed: before !== isCloudVoiceActive() } }),
    );
  } catch {
    /* no window (tests) */
  }
}

/** Load once per page (and again on demand with `force`). */
export function refreshVoiceProvidersState(
  client: GatewayBrowserClient | null | undefined,
  force = false,
): Promise<VoiceProvidersPayload | null> {
  if (!client) return Promise.resolve(providersState);
  if (providersLoad && !force) return providersLoad;
  providersLoad = loadVoiceProviders(client).then((p) => {
    if (p) setVoiceProvidersState(p);
    else providersLoad = null; // retry on the next call
    return p;
  });
  return providersLoad;
}
