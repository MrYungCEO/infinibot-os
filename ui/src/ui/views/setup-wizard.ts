/**
 * Setup wizard — first-run onboarding for new users.
 *
 * Six steps, each one persists what the user entered to ~/.infinibot/infinibot.json
 * via the gateway's `config.patch` RPC (keys go to the auth profile store)
 * before advancing. The final step verifies the configuration with a real
 * model + channel smoke test so the user lands on a known-working installation.
 *
 * Steps:
 *   1. Model provider        — local Ollama (auto-detected) / OpenRouter /
 *                              Anthropic / OpenAI / Groq / Gemini / Ollama Cloud
 *   2. Channel               — Telegram / Discord / WhatsApp / web-only
 *   3. Optional integrations — Notion API token, Brave Search, coding backend
 *   4. Voice                 — local voice (default, nothing to do); optionally
 *                              link Cloud voice (Robovoice), which is free
 *   5. Federation (advanced) — solo (default) / satellite / master
 *   6. Review + test         — show summary, ping the model, optionally ping channel
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { icon } from "../icons";
import { loadSettings } from "../storage";
import { isTabAvailable } from "../plugin-host.js";
import "../components/robovoice-link.js";
import "../components/telegram-setup";
import { channelLockReason, channelUpgradeCta, isChannelExcluded } from "../cloud/plan-channels";
import { openUpgrade } from "../cloud/upgrade";
import { OLLAMA_CLOUD_DEFAULT_MODEL_ID } from "../../../../src/agents/provider-model-defaults.js";

import { BRAND_DEFAULT_LOGO } from "./branding-modal";
import "../components/provider-logo.js";
import { g8GlassStyles } from "./glass-g8.js";
import {
  IDENTITY_FILENAMES,
  stageImportFiles,
  setPendingAction,
  commitPendingImport,
  cancelPendingImport,
  setPeerUrl,
  setPeerToken,
  pullIdentityFromPeer,
  type ImportAction,
} from "../controllers/agent-identity";
import {
  createSatelliteSetupState,
  scanForMasters,
  probeMaster,
  connectAsSatellite,
  connectAsSatelliteWithInvite,
  resetSatelliteSetup,
  disconnectSatellite,
  subscribeToFederationEvents,
  isValidMasterUrl,
  decodeInvite,
  type SatelliteSetupState,
  type ScannedMaster,
} from "../controllers/satellite-setup";

// ── Types ─────────────────────────────────────────────────────────────────

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;
/** Step order. Provider comes first; federation is an advanced, skippable step. */
export const STEP_PROVIDER: WizardStep = 1;
export const STEP_CHANNEL: WizardStep = 2;
export const STEP_INTEGRATIONS: WizardStep = 3;
export const STEP_VOICE: WizardStep = 4;
export const STEP_FEDERATION: WizardStep = 5;
export const STEP_REVIEW: WizardStep = 6;
const STEP_LABELS: Record<WizardStep, string> = {
  1: "Provider",
  2: "Channel",
  3: "Integrations",
  4: "Voice",
  5: "Federation",
  6: "Review",
};
export type ProviderId =
  | "ollama"
  | "openrouter"
  | "anthropic"
  | "openai"
  | "groq"
  | "gemini"
  | "ollama-cloud";

/** A model returned by the `quickstart.providers.fetchModels` RPC. */
export interface WizardDiscoveredModel {
  id: string;
  label?: string;
}
export type ChannelId = "telegram" | "discord" | "whatsapp" | "web";
export type NodeRole = "solo" | "satellite" | "master";
// COORDINATION: opencode-swap
export type CoderBackendChoice = "claude-code" | "opencode" | "codex" | "grok";

export interface SetupWizardState {
  step: WizardStep;
  /**
   * What kind of node this gateway is. Asked on the welcome step.
   *
   * - "solo"     — standalone, default. Wizard runs all 5 steps as before.
   * - "satellite" — joins an existing federation. The wizard runs an inline
   *                 connect flow on the welcome step; once connected, the
   *                 remaining steps are skipped (provider/channels/etc come
   *                 from the master via identity sync) and the user lands
   *                 on the review/done card.
   * - "master"   — first node of a federation. Just stamps
   *                 `federation.mode = master` into config and runs the
   *                 normal wizard. Other nodes can then be added later.
   */
  nodeRole: NodeRole;
  /** Local Ollama probe result (auto-detected on the provider step). */
  ollamaDetected: "unknown" | "checking" | "running" | "absent";
  /** True once the user picks a provider by hand — detection stops overriding it. */
  providerTouched: boolean;
  /** Inline state for the satellite mini-flow on the federation step. */
  satellite: SatelliteSetupState;
  // Provider
  provider: ProviderId;
  apiKey: string;
  ollamaBaseUrl: string;
  defaultModel: string;
  /** Models discovered for the current provider via the gateway RPC. Empty until "Fetch models" runs. */
  discoveredModels: WizardDiscoveredModel[];
  /** True while the "Fetch models" request is in flight. */
  fetchingModels: boolean;
  /** Last fetch-models error, surfaced inline under the button. */
  modelsError: string | null;
  // Channel
  channel: ChannelId;
  telegramBotToken: string;
  /** The guided <telegram-setup> saved a bot (it writes the config itself). */
  telegramConnected: boolean;
  telegramTestChatId: string;
  discordBotToken: string;
  // Optional integrations
  notionToken: string;
  braveApiKey: string;
  // COORDINATION: opencode-swap
  coderBackend: CoderBackendChoice;
  /** Default model for the OpenCode backend (provider/name). Empty = use backend's built-in fallback. */
  opencodeModel: string;
  // UI state
  loading: boolean;
  error: string | null;
  saving: boolean;
  testResult: { kind: "model" | "channel"; ok: boolean; message: string } | null;
  completed: boolean;
  /** Tracks which steps have been persisted so the user can return without re-saving. */
  persistedSteps: Record<WizardStep, boolean>;
}

// Display order = object order: local first, then OpenRouter (the gateway's
// built-in default provider), then direct vendor keys.
const PROVIDER_DEFAULTS: Record<ProviderId, { defaultModel: string; placeholder: string; label: string }> = {
  ollama:         { defaultModel: "llama3.1:8b",                 placeholder: "(local — no key)", label: "Ollama (local, free)" },
  openrouter:     { defaultModel: "anthropic/claude-sonnet-4-5", placeholder: "sk-or-…",   label: "OpenRouter (one key, many models)" },
  anthropic:      { defaultModel: "claude-sonnet-4-6",           placeholder: "sk-ant-…",  label: "Anthropic (Claude)" },
  openai:         { defaultModel: "gpt-4o",                      placeholder: "sk-…",      label: "OpenAI (GPT)" },
  groq:           { defaultModel: "llama-3.3-70b-versatile",     placeholder: "gsk_…",     label: "Groq (fast open models)" },
  gemini:         { defaultModel: "gemini-2.0-flash",            placeholder: "AIza…",     label: "Google (Gemini)" },
  "ollama-cloud": { defaultModel: OLLAMA_CLOUD_DEFAULT_MODEL_ID,    placeholder: "(Ollama Cloud / Turbo key)", label: "Ollama Cloud (Turbo)" },
};

/** Provider id as the agent runtime / auth store know it ("gemini" → "google"). */
function runtimeProviderId(id: ProviderId): string {
  return id === "gemini" ? "google" : id;
}

// Module-scoped state — wizard is a singleton at any one time.
let wizardState: SetupWizardState = createInitialWizardState();

// COORDINATION: opencode-swap — per-backend InfiniBot MCP install status.
// Lives outside SetupWizardState because it's loaded async from the server
// and isn't part of what the wizard persists to infinibot.json.
type CoderMcpEntry = { registered: boolean; path?: string };
let coderMcpStatus: {
  loaded: boolean;
  loading: boolean;
  installing: CoderBackendChoice | null;
  error: string | null;
  notice: string | null;
  entries: Record<CoderBackendChoice, CoderMcpEntry>;
} = {
  loaded: false,
  loading: false,
  installing: null,
  error: null,
  notice: null,
  entries: {
    "claude-code": { registered: false },
    opencode: { registered: false },
    codex: { registered: false },
    grok: { registered: false },
  },
};

async function loadCoderMcpStatus(host: AppViewState): Promise<void> {
  if (coderMcpStatus.loaded || coderMcpStatus.loading) return;
  coderMcpStatus = { ...coderMcpStatus, loading: true };
  host.requestUpdate?.();
  try {
    const res = await fetch("/api/coder/mcp-status");
    const body = (await res.json()) as {
      entries?: Array<{ backend: CoderBackendChoice; registered?: boolean; path?: string }>;
    };
    const next = { ...coderMcpStatus.entries };
    for (const e of body.entries ?? []) {
      if (e.backend in next) {
        next[e.backend] = { registered: !!e.registered, path: e.path };
      }
    }
    coderMcpStatus = { ...coderMcpStatus, entries: next, loaded: true };
  } catch {
    // leave defaults; user can still hit Install which will surface a real error
    coderMcpStatus = { ...coderMcpStatus, loaded: true };
  } finally {
    coderMcpStatus = { ...coderMcpStatus, loading: false };
    host.requestUpdate?.();
  }
}

async function installCoderMcp(id: CoderBackendChoice, host: AppViewState): Promise<void> {
  if (coderMcpStatus.installing) return;
  const wasRegistered = coderMcpStatus.entries[id]?.registered === true;
  coderMcpStatus = { ...coderMcpStatus, installing: id, error: null, notice: null };
  host.requestUpdate?.();
  try {
    const res = await fetch("/api/coder/mcp-install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: id, force: wasRegistered }),
    });
    const body = (await res.json()) as {
      path?: string;
      changed?: boolean;
      error?: string;
    };
    if (!res.ok) {
      coderMcpStatus = { ...coderMcpStatus, error: body.error ?? `HTTP ${res.status}` };
    } else {
      coderMcpStatus = {
        ...coderMcpStatus,
        entries: {
          ...coderMcpStatus.entries,
          [id]: { registered: true, path: body.path ?? coderMcpStatus.entries[id]?.path },
        },
        notice: body.changed
          ? `Installed InfiniBot MCP into ${id}.`
          : `InfiniBot MCP already registered in ${id}.`,
      };
    }
  } catch (e) {
    coderMcpStatus = { ...coderMcpStatus, error: (e as Error).message };
  } finally {
    coderMcpStatus = { ...coderMcpStatus, installing: null };
    host.requestUpdate?.();
  }
}

/**
 * Cleanup handle for the gateway event subscription used by the satellite
 * mini-flow. Lazily attached the first time the user picks "Satellite", and
 * detached when they leave that role or when resetSetupWizard runs. Living
 * at module scope mirrors the wizard singleton.
 */
let satelliteEventUnsub: (() => void) | null = null;

export function createInitialWizardState(): SetupWizardState {
  return {
    step: STEP_PROVIDER,
    nodeRole: "solo",
    ollamaDetected: "unknown",
    providerTouched: false,
    satellite: createSatelliteSetupState(),
    // OpenRouter matches the gateway's runtime default (src/agents/defaults.ts);
    // switched to Ollama automatically when a local daemon is detected.
    provider: "openrouter",
    apiKey: "",
    ollamaBaseUrl: "http://localhost:11434",
    defaultModel: PROVIDER_DEFAULTS.openrouter.defaultModel,
    discoveredModels: [],
    fetchingModels: false,
    modelsError: null,
    channel: "web",
    telegramBotToken: "",
    telegramConnected: false,
    telegramTestChatId: "",
    discordBotToken: "",
    notionToken: "",
    braveApiKey: "",
    coderBackend: "claude-code", // COORDINATION: opencode-swap
    opencodeModel: "",
    loading: false,
    error: null,
    saving: false,
    testResult: null,
    completed: false,
    persistedSteps: { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false },
  };
}

export function resetSetupWizard(state: AppViewState): void {
  wizardState = createInitialWizardState();
  if (satelliteEventUnsub) {
    try { satelliteEventUnsub(); } catch {}
    satelliteEventUnsub = null;
  }
  state.requestUpdate?.();
}

export interface WizardStepProgress {
  step: WizardStep;
  label: string;
  complete: boolean;
  active: boolean;
  optional: boolean;
}

export function getWizardProgress(): {
  steps: WizardStepProgress[];
  percent: number;
  completed: boolean;
  currentStep: WizardStep;
} {
  const s = wizardState;
  const defs: Array<{ label: string; optional: boolean }> = [
    { label: STEP_LABELS[1], optional: false },
    { label: STEP_LABELS[2], optional: true  },
    { label: STEP_LABELS[3], optional: true  },
    { label: STEP_LABELS[4], optional: true  },
    { label: STEP_LABELS[5], optional: true  },
    { label: STEP_LABELS[6], optional: false },
  ];
  const steps: WizardStepProgress[] = defs.map((d, i) => {
    const step = (i + 1) as WizardStep;
    const complete = s.completed || s.persistedSteps[step] || step < s.step;
    return {
      step,
      label: d.label,
      complete,
      active: step === s.step && !s.completed,
      optional: d.optional,
    };
  });
  const completeCount = steps.filter(st => st.complete).length;
  return {
    steps,
    percent: Math.round(completeCount / defs.length * 100),
    completed: s.completed,
    currentStep: s.step,
  };
}

/**
 * Lazily attach the federation event subscriber the first time the user
 * picks the satellite role. Idempotent — extra calls are no-ops while the
 * subscription is active. Detached when the user leaves the satellite role.
 */
function ensureSatelliteEventSubscription(host: AppViewState, client: GatewayBrowserClient): void {
  if (satelliteEventUnsub) return;
  satelliteEventUnsub = subscribeToFederationEvents(
    wizardState.satellite,
    client,
    () => host.requestUpdate?.(),
  );
}

function detachSatelliteEventSubscription(): void {
  if (!satelliteEventUnsub) return;
  try { satelliteEventUnsub(); } catch {}
  satelliteEventUnsub = null;
}

// ── Persistence ───────────────────────────────────────────────────────────

/** Apply a partial config patch via the gateway. The `config.patch` RPC takes
 *  a raw JSON5 string + the current snapshot's hash for optimistic concurrency.
 *  We refresh the hash on every call to avoid stale-hash errors. */
async function patchConfig(client: GatewayBrowserClient, patch: object): Promise<void> {
  const snapshot = (await client.request("config.get", {})) as { hash?: string };
  const baseHash = snapshot?.hash;
  if (!baseHash) throw new Error("could not read config snapshot hash");
  await client.request("config.patch", {
    raw: JSON.stringify(patch),
    baseHash,
  });
}

/**
 * Dual-write: in addition to the legacy `config.patch` (which keeps the
 * old consumers working), upsert each wizard-set credential into the
 * auth profile store so it shows up in the /apikeys page immediately —
 * no boot migration round-trip required. Silently ignores failures so a
 * malfunctioning auth store can't block wizard progress.
 */
async function upsertWizardKey(
  client: GatewayBrowserClient,
  params: { provider: string; type: "api_key" | "token"; key: string },
): Promise<void> {
  const value = params.key.trim();
  if (!value) return;
  try {
    await client.request("auth.profiles.upsert", {
      profileId: `${params.provider}:default`,
      provider: params.provider,
      type: params.type,
      key: value,
    });
  } catch {
    // Non-fatal — the config.patch already happened so the consumer
    // still works; the /apikeys row just won't appear until the next
    // gateway boot picks up the migration shim.
  }
}

/** Build the provider patch: pin `agents.defaults.model.primary` to the chosen
 *  provider/model so chat uses it straight away. The API key itself goes to
 *  the auth profile store (upsertWizardKey) — the config schema is strict and
 *  has no top-level `providers`/`defaultModel` keys, which is why the old
 *  patch here was rejected. Local Ollama is auto-discovered by the runtime. */
export function buildProviderPatch(s: SetupWizardState): object {
  const model = s.defaultModel.trim() || PROVIDER_DEFAULTS[s.provider].defaultModel;
  return {
    agents: { defaults: { model: { primary: `${runtimeProviderId(s.provider)}/${model}` } } },
  };
}

export function buildChannelPatch(s: SetupWizardState): object {
  const channels: Record<string, unknown> = {};
  // Telegram: the guided setup (<telegram-setup>) already saved the bot token,
  // owner and default chat through the gateway. Nothing to patch from here.
  // Discord: the strict schema and src/discord/token.ts read `token` (a
  // `botToken` key was rejected by config.patch, so the step never saved).
  if (s.channel === "discord" && s.discordBotToken.trim()) {
    channels.discord = { token: s.discordBotToken.trim() };
  }
  // WhatsApp is QR-based — config patch only flips the `enabled` flag; the
  // session is established later via the channels page.
  if (s.channel === "whatsapp") {
    channels.whatsapp = { enabled: true };
  }
  return { channels };
}

function buildIntegrationsPatch(s: SetupWizardState): object {
  const out: Record<string, unknown> = {};
  // Keys must match the strict config schema (notion.apiKey,
  // tools.web.search.apiKey) or config.patch rejects the whole step.
  if (s.notionToken.trim()) {
    out.notion = { apiKey: s.notionToken.trim() };
  }
  if (s.braveApiKey.trim()) {
    out.tools = { web: { search: { apiKey: s.braveApiKey.trim() } } };
  }
  // COORDINATION: opencode-swap — persist chosen backend + per-backend model
  const coder: Record<string, unknown> = {};
  // coder.backend accepts every CoderBackendId; claude-code is the default.
  if (s.coderBackend && s.coderBackend !== "claude-code") {
    coder.backend = s.coderBackend;
  }
  if (s.opencodeModel.trim()) {
    coder.models = { opencode: s.opencodeModel.trim() };
  }
  if (Object.keys(coder).length > 0) {
    out.coder = coder;
  }
  return out;
}

/**
 * Deep-link entry point used by the dashboard voice card. Jumps
 * the wizard to the Voice step and switches the Setup view
 * to the wizard section.
 */
export function openVoiceSetup(host: AppViewState): void {
  wizardState.step = STEP_VOICE;
  wizardState.error = null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("infinibot:setup-section", { detail: { section: "wizard" } }));
  }
  host.requestUpdate?.();
}

// ── Step navigation ───────────────────────────────────────────────────────

export function setStep(host: AppViewState, next: WizardStep): void {
  wizardState.step = next;
  wizardState.error = null;
  wizardState.testResult = null;
  host.requestUpdate?.();
}

export function setField<K extends keyof SetupWizardState>(
  host: AppViewState,
  key: K,
  value: SetupWizardState[K],
): void {
  wizardState[key] = value;
  // When the provider flips, swap the defaultModel placeholder so the user
  // doesn't accidentally save an Anthropic model name against an OpenAI key.
  if (key === "provider") {
    wizardState.providerTouched = true;
    wizardState.defaultModel = PROVIDER_DEFAULTS[value as ProviderId].defaultModel;
    // Discovered models belong to the previous provider — clear them so the
    // dropdown doesn't show stale entries against the new key/endpoint.
    wizardState.discoveredModels = [];
    wizardState.modelsError = null;
  }
  host.requestUpdate?.();
}

/**
 * Discover the provider's live model catalog via the gateway's
 * `quickstart.providers.fetchModels` RPC and populate the wizard's
 * `discoveredModels` dropdown. Local Ollama passes the configured base URL as
 * the endpoint; key-based providers pass the entered API key. Errors are shown
 * inline (the manual text input stays usable as a fallback).
 */
export async function fetchWizardModels(
  host: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = wizardState;
  s.fetchingModels = true;
  s.modelsError = null;
  host.requestUpdate?.();
  try {
    const params: { provider: string; apiKey?: string; endpoint?: string } = {
      provider: s.provider,
    };
    if (s.provider === "ollama") {
      params.endpoint = s.ollamaBaseUrl.trim() || "http://localhost:11434";
    } else {
      params.apiKey = s.apiKey.trim();
    }
    const res = (await client.request("quickstart.providers.fetchModels", params)) as {
      models?: WizardDiscoveredModel[];
      error?: string;
    };
    const models = Array.isArray(res?.models) ? res.models : [];
    if (res?.error && models.length === 0) {
      s.discoveredModels = [];
      s.modelsError = res.error;
    } else {
      s.discoveredModels = models;
      s.modelsError = models.length === 0 ? "No models returned by the provider." : null;
      // Auto-select the first discovered model so the user can advance without
      // hand-typing — they can still override via the dropdown or text input.
      const first = models[0];
      if (first) s.defaultModel = first.id;
    }
  } catch (e) {
    s.discoveredModels = [];
    s.modelsError = e instanceof Error ? e.message : String(e);
  } finally {
    s.fetchingModels = false;
    host.requestUpdate?.();
  }
}

/**
 * Change the node-role choice on the welcome step. When the user switches
 * away from satellite mid-flow, we reset the satellite controller so any
 * in-flight phase doesn't bleed back in if they switch return.
 */
export function setNodeRole(host: AppViewState, role: NodeRole): void {
  if (wizardState.nodeRole === role) return;
  if (wizardState.nodeRole === "satellite" && role !== "satellite") {
    // Roll back the satellite mini-flow when leaving — keeps the wizard
    // reversible without forcing the user to disconnect first. Also detach
    // the federation event subscriber so we don't hold listeners while
    // satellite mode isn't active.
    wizardState.satellite = createSatelliteSetupState();
    detachSatelliteEventSubscription();
  }
  wizardState.nodeRole = role;
  wizardState.error = null;
  host.requestUpdate?.();
}

/** Update one field of the inline satellite controller. */
export function updateSatelliteField<K extends keyof SatelliteSetupState>(
  host: AppViewState,
  key: K,
  value: SatelliteSetupState[K],
): void {
  wizardState.satellite[key] = value;
  host.requestUpdate?.();
}

/**
 * Probe the local Ollama daemon once (via the same gateway RPC the "Fetch
 * models" button uses). When it's running and the user hasn't picked a
 * provider yet, preselect Ollama with its first installed model — a stranger
 * with Ollama can finish this step without any key.
 */
export async function detectLocalOllama(host: AppViewState, client: GatewayBrowserClient): Promise<void> {
  if (wizardState.ollamaDetected !== "unknown") return;
  wizardState.ollamaDetected = "checking";
  try {
    const res = (await client.request("quickstart.providers.fetchModels", {
      provider: "ollama",
      endpoint: wizardState.ollamaBaseUrl.trim() || "http://localhost:11434",
    })) as { models?: WizardDiscoveredModel[] };
    const models = Array.isArray(res?.models) ? res.models : [];
    wizardState.ollamaDetected = models.length > 0 ? "running" : "absent";
    if (models.length > 0 && !wizardState.providerTouched && !wizardState.persistedSteps[STEP_PROVIDER]) {
      wizardState.provider = "ollama";
      wizardState.discoveredModels = models;
      wizardState.defaultModel = models[0]!.id;
      wizardState.modelsError = null;
    }
  } catch {
    wizardState.ollamaDetected = "absent";
  } finally {
    host.requestUpdate?.();
  }
}

/** Persist the current step's fields to config, then advance. */
async function commitAndAdvance(
  host: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  wizardState.saving = true;
  wizardState.error = null;
  host.requestUpdate?.();
  try {
    if (wizardState.step === STEP_PROVIDER) {
      await patchConfig(client, buildProviderPatch(wizardState));
      // The key lives in the auth profile store (also what /apikeys lists).
      // Local Ollama has no key — skip.
      if (wizardState.provider !== "ollama") {
        await upsertWizardKey(client, {
          provider: runtimeProviderId(wizardState.provider),
          type: "api_key",
          key: wizardState.apiKey,
        });
      }
      wizardState.persistedSteps[STEP_PROVIDER] = true;
    } else if (wizardState.step === STEP_CHANNEL && wizardState.channel !== "web") {
      if (wizardState.channel !== "telegram") {
        await patchConfig(client, buildChannelPatch(wizardState));
      }
      // Mirror the Discord bot token into the auth profile store. Telegram is
      // saved by the guided setup (the token never comes back to this page);
      // WhatsApp is QR-flow — nothing to mirror.
      if (wizardState.channel === "discord") {
        await upsertWizardKey(client, {
          provider: "discord",
          type: "token",
          key: wizardState.discordBotToken,
        });
      }
      wizardState.persistedSteps[STEP_CHANNEL] = true;
    } else if (wizardState.step === STEP_INTEGRATIONS) {
      const patch = buildIntegrationsPatch(wizardState);
      if (Object.keys(patch).length > 0) {
        await patchConfig(client, patch);
      }
      // Mirror the integration keys (Notion, Brave Search) too.
      await upsertWizardKey(client, {
        provider: "notion",
        type: "api_key",
        key: wizardState.notionToken,
      });
      await upsertWizardKey(client, {
        provider: "brave",
        type: "api_key",
        key: wizardState.braveApiKey,
      });
      wizardState.persistedSteps[STEP_INTEGRATIONS] = true;
    } else if (wizardState.step === STEP_VOICE) {
      // Voice step — local voice is the default and needs nothing saved here.
      // Optional Cloud voice (Robovoice) linking happens inside the step
      // (<robovoice-link>, device-code sign-in writes the plugin's own state).
      wizardState.persistedSteps[STEP_VOICE] = true;
    } else if (wizardState.step === STEP_FEDERATION) {
      // Advanced: stamp the federation role into config when the user chose
      // master. Satellite role is already persisted by the inline connect
      // flow (federation.node.add writes config). Solo is the default and
      // needs no patch.
      if (wizardState.nodeRole === "master") {
        await patchConfig(client, { federation: { mode: "master" } });
      }
      wizardState.persistedSteps[STEP_FEDERATION] = true;
    }
    if (wizardState.step < 6) {
      wizardState.step = (wizardState.step + 1) as WizardStep;
    } else {
      wizardState.completed = true;
    }
  } catch (e) {
    wizardState.error = e instanceof Error ? e.message : String(e);
  } finally {
    wizardState.saving = false;
    host.requestUpdate?.();
  }
}

// ── Smoke tests ───────────────────────────────────────────────────────────

async function testModel(client: GatewayBrowserClient): Promise<{ ok: boolean; message: string }> {
  try {
    // Hit a tiny chat completion via the agent stub — every gateway exposes
    // models.list which only succeeds when at least one provider has a valid
    // key. Cheap, stateless, no token spend.
    const res = (await client.request("models.list", {})) as { models?: Array<{ id: string }> };
    const count = res?.models?.length ?? 0;
    if (count === 0) return { ok: false, message: "Gateway says no models are reachable. Check your API key." };
    return { ok: true, message: `Reached ${count} model${count === 1 ? "" : "s"} via the gateway.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

async function testChannel(client: GatewayBrowserClient, s: SetupWizardState): Promise<{ ok: boolean; message: string }> {
  if (s.channel === "web") {
    return { ok: true, message: "Web chat needs no test — open the Chat tab." };
  }
  if (s.channel === "telegram") {
    let to = s.telegramTestChatId.trim();
    if (!to) {
      // The guided setup found the owner's chat: test against that.
      try {
        const summary = (await client.request("telegram.setup.summary", {})) as {
          defaultChatId?: string | null;
        };
        to = summary?.defaultChatId?.trim() ?? "";
      } catch {
        to = "";
      }
    }
    if (!to) {
      return { ok: false, message: "Telegram isn't finished yet. Go back to the channel step and let InfiniBot find you." };
    }
    try {
      await client.request("send", {
        channel: "telegram",
        to,
        message: "InfiniBot setup test — your gateway can reach Telegram.",
        idempotencyKey: `setup-test:${Date.now()}`,
      });
      return { ok: true, message: "Sent a test message via Telegram." };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
  return {
    ok: true,
    message: `${s.channel} configured. Finish the device-side handshake on the Channels tab.`,
  };
}

export async function runSmokeTests(host: AppViewState, client: GatewayBrowserClient): Promise<void> {
  wizardState.loading = true;
  wizardState.testResult = null;
  host.requestUpdate?.();
  const model = await testModel(client);
  if (!model.ok) {
    wizardState.testResult = { kind: "model", ok: false, message: model.message };
    wizardState.loading = false;
    host.requestUpdate?.();
    return;
  }
  const channel = await testChannel(client, wizardState);
  wizardState.testResult = {
    kind: channel.ok ? "channel" : "channel",
    ok: channel.ok,
    message: channel.ok ? `${model.message} ${channel.message}` : channel.message,
  };
  wizardState.loading = false;
  host.requestUpdate?.();
}

// ── Render ────────────────────────────────────────────────────────────────

export function renderSetupWizard(
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const s = wizardState;
  return html`
    ${wizardStyles()}
    ${g8GlassStyles}
    <div class="sw-root g8-page">
      ${renderHeader(s, host)}
      ${renderProgress(s, host)}
      <div class="sw-card">
        ${s.step === STEP_PROVIDER ? renderStepProvider(s, host, client)
          : s.step === STEP_CHANNEL ? renderStepChannel(s, host)
          : s.step === STEP_INTEGRATIONS ? renderStepIntegrations(s, host, client)
          : s.step === STEP_VOICE ? renderStepVoice(s, host)
          : s.step === STEP_FEDERATION ? renderStepFederation(s, host, client)
          : renderStepReview(s, host, client)}
        ${s.error ? html`<div class="sw-error">${s.error}</div>` : nothing}
      </div>
      ${renderFooter(s, host, client)}
    </div>
  `;
}

function renderHeader(s: SetupWizardState, host: AppViewState): TemplateResult {
  return html`
    <div class="sw-header">
      <div class="sw-brand">
        <div class="sw-logo">
          <img src=${BRAND_DEFAULT_LOGO} alt="InfiniBot" />
        </div>
        <div class="sw-brand__text">
          <div class="sw-eyebrow">SETUP · ${s.completed ? "COMPLETE" : `STEP ${s.step} OF 6`}</div>
          <h1 class="sw-title">${s.completed ? "You're up and running." : "Let's wire your stack."}</h1>
          <p class="sw-sub">
            Six short steps. Each one saves as you go,
            so you can quit any time without losing progress.
          </p>
        </div>
      </div>
      <button class="sw-btn sw-btn--ghost" @click=${() => resetSetupWizard(host)} title="Start over">
        Reset
      </button>
    </div>
  `;
}

function renderProgress(s: SetupWizardState, host: AppViewState): TemplateResult {
  const labels = [1, 2, 3, 4, 5, 6].map((n) => STEP_LABELS[n as WizardStep]);
  return html`
    <div class="sw-progress">
      ${labels.map((label, i) => {
        const step = (i + 1) as WizardStep;
        const done = s.persistedSteps[step] || step < s.step;
        const active = step === s.step;
        return html`
          <button
            class="sw-progress__step ${active ? "is-active" : ""} ${done ? "is-done" : ""}"
            data-learn-id="setup-step-${step}"
            ?disabled=${step > s.step && !s.persistedSteps[step]}
            @click=${() => setStep(host, step)}
            title="Go to ${label}"
          >
            <span class="sw-progress__num">${done ? icon('check') : step}</span>
            <span class="sw-progress__label">${label}</span>
          </button>
          ${i < labels.length - 1 ? html`<span class="sw-progress__line ${done ? "is-done" : ""}"></span>` : nothing}
        `;
      })}
    </div>
  `;
}

function renderStepFederation(s: SetupWizardState, host: AppViewState, client: GatewayBrowserClient): TemplateResult {
  return html`
    <h2 class="sw-step-title">Federation <span class="sw-badge">Advanced · optional</span></h2>
    <p class="sw-step-sub">
      Most people stay on <strong>Solo</strong> and just continue. Only change this if you're
      joining an existing InfiniBot federation (Satellite) or making this machine the hub
      other devices connect to (Master). You can change it later on the Federation page.
    </p>

    ${renderNodeRolePicker(s, host)}

    ${s.nodeRole === "satellite"
      ? renderSatelliteFlow(s, host, client)
      : nothing}
  `;
}

/**
 * Three-card picker: solo / satellite / master. Picking satellite expands an
 * inline mini-flow below; picking master just stamps federation.mode=master
 * into config when the user advances. Solo is the default and changes
 * nothing.
 */
function renderNodeRolePicker(s: SetupWizardState, host: AppViewState): TemplateResult {
  const cards: Array<{ id: NodeRole; ic: ReturnType<typeof icon>; t: string; d: string }> = [
    { id: "solo",      ic: icon('house'),  t: "Solo",      d: "Just this machine. Default — pick this if you're not sure." },
    { id: "satellite", ic: icon('radio'),  t: "Satellite", d: "Join an existing InfiniBot federation. Identity, keys, and config sync from the master." },
    { id: "master",    ic: icon('globe'),  t: "Master",    d: "First node of a new federation. Other devices will connect to this one." },
  ];
  return html`
    <div class="sw-grid" style="grid-template-columns: repeat(3, 1fr); margin-bottom: 16px;">
      ${cards.map((c) => html`
        <button
          type="button"
          class="sw-grid__card"
          @click=${() => setNodeRole(host, c.id)}
          style="${s.nodeRole === c.id
            ? 'border-color: var(--sw-primary); background: var(--sw-primary-soft); box-shadow: 0 0 0 1px var(--sw-primary-strong) inset;'
            : 'cursor: pointer;'}; text-align: left;"
        >
          <div class="sw-grid__icon">${c.ic}</div>
          <div class="sw-grid__title">${c.t}${s.nodeRole === c.id ? html` ${icon('check')}` : ""}</div>
          <div class="sw-grid__desc">${c.d}</div>
        </button>
      `)}
    </div>
  `;
}

/**
 * Inline satellite setup. Shown only when nodeRole === "satellite". Has its
 * own internal phases driven by the controller — the user scans, types a URL,
 * probes, and connects without leaving the welcome step.
 *
 * Once `phase === "connected"`, the wizard treats this as completion of the
 * entire setup (master pushes provider + channel + identity files), so the
 * footer flips to a "Finish" button.
 */
function renderSatelliteFlow(s: SetupWizardState, host: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const sat = s.satellite;
  const onChange = () => host.requestUpdate?.();
  // First render in satellite mode wires up the federation event subscriber
  // so phase transitions reflect live master state. queueMicrotask defers
  // until after the current render so we don't fight Lit's update cycle.
  if (!satelliteEventUnsub) {
    queueMicrotask(() => ensureSatelliteEventSubscription(host, client));
  }
  // Auto-fire a one-shot LAN scan when the user lands on the satellite role
  // so masters discovered on the network show up without an explicit click.
  // The latch (`autoScanFired`) keeps it from re-running on every render and
  // resetSatelliteSetup() clears it for retries. Skipped in invite-paste
  // mode — the user already has the hub URL embedded in the token.
  if (
    !sat.inviteMode &&
    !sat.autoScanFired &&
    sat.phase === "idle" &&
    sat.scanResults.length === 0 &&
    !sat.busy
  ) {
    sat.autoScanFired = true;
    queueMicrotask(() => void scanForMasters(sat, client, onChange));
  }

  const invitePreview = decodeInvite(sat.inviteText);
  const inviteDecodeError = sat.inviteText.trim() && !invitePreview;
  const toggleDisabled = sat.busy || sat.phase === "connecting" || sat.phase === "connected";

  return html`
    <div style="margin-top: 8px; padding: 18px; border: 1px solid var(--sw-border-strong); border-radius: 12px; background: rgba(0,0,0,0.25);">
      <div style="font-family: var(--sw-mono); font-size: 11px; font-weight: 700; letter-spacing: 0.18em; color: var(--sw-primary); margin-bottom: 8px;">
        SATELLITE SETUP
      </div>
      <div style="font-size: 14px; color: var(--sw-text); margin-bottom: 14px;">
        Point this device at a master gateway. We'll probe before saving anything.
      </div>

      ${renderSatellitePhase(sat)}

      <!-- Mode toggle: Scan/URL vs Paste Invite -->
      <div role="tablist" aria-label="Connect method" style="display: flex; gap: 6px; margin-bottom: 12px;">
        <button
          type="button"
          role="tab"
          aria-pressed=${!sat.inviteMode}
          class="sw-btn ${!sat.inviteMode ? "sw-btn--primary" : "sw-btn--ghost"}"
          @click=${() => updateSatelliteField(host, "inviteMode", false)}
          ?disabled=${toggleDisabled}
          style="flex: 1;"
        >Scan / URL</button>
        <button
          type="button"
          role="tab"
          aria-pressed=${sat.inviteMode}
          class="sw-btn ${sat.inviteMode ? "sw-btn--primary" : "sw-btn--ghost"}"
          @click=${() => updateSatelliteField(host, "inviteMode", true)}
          ?disabled=${toggleDisabled}
          style="flex: 1;"
        >Paste Invite</button>
      </div>

      ${sat.inviteMode ? html`
        <!-- Invite paste mode -->
        <label class="sw-field" style="margin-bottom: 10px;">
          <span class="sw-field__label">Invite token</span>
          <textarea
            class="sw-input mono"
            placeholder="Paste the invite from the master device"
            .value=${sat.inviteText}
            @input=${(e: Event) => updateSatelliteField(host, "inviteText", (e.target as HTMLTextAreaElement).value)}
            ?disabled=${sat.busy || sat.phase === "connected"}
            style="width: 100%; min-height: 80px; resize: vertical; box-sizing: border-box;"
          ></textarea>
          <span class="sw-field__hint">
            On the master, click <strong>Generate Invite</strong> in Federation settings and copy the token here.
          </span>
        </label>

        ${invitePreview ? html`
          <div style="margin-bottom: 12px; padding: 10px 12px; background: rgba(0, 255, 0, 0.05); border: 1px solid rgba(0, 255, 0, 0.25); border-radius: 8px; font-size: 12px; color: var(--sw-text);">
            <div style="font-weight: 600; margin-bottom: 4px;">${invitePreview.hubName}</div>
            <div style="font-family: var(--sw-mono); color: var(--sw-text-mute); word-break: break-all;">${invitePreview.hubUrl}</div>
            ${invitePreview.minutesLeft !== null ? html`
              <div style="margin-top: 4px; font-family: var(--sw-mono); font-size: 11px; color: ${invitePreview.minutesLeft <= 1 ? "#f87171" : "var(--sw-text-mute)"};">
                ${invitePreview.minutesLeft === 0 ? "Expired" : `Expires in ${invitePreview.minutesLeft} min`}
              </div>
            ` : nothing}
          </div>
        ` : nothing}

        ${inviteDecodeError ? html`
          <div style="margin-bottom: 12px; padding: 10px 12px; background: rgba(255, 50, 50, 0.08); border: 1px solid rgba(255, 50, 50, 0.25); border-radius: 8px; font-size: 12px; color: #ff6b6b;">
            Couldn't decode this token. Make sure you copied the whole invite string from the master.
          </div>
        ` : nothing}

        <!-- Action row (invite mode) -->
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
          <button
            type="button"
            class="sw-btn sw-btn--primary"
            @click=${() => connectAsSatelliteWithInvite(sat, client, onChange)}
            ?disabled=${sat.busy || !invitePreview || sat.phase === "connected"}
          >
            ${sat.phase === "connecting" ? "Connecting…" : sat.phase === "connected" ? html`${icon('check')} Connected` : "Connect"}
          </button>
          ${sat.phase === "connected" ? html`
            <button
              type="button"
              class="sw-btn sw-btn--ghost"
              @click=${() => disconnectSatellite(sat, client, onChange)}
              ?disabled=${sat.busy}
            >Disconnect</button>
          ` : nothing}
          ${sat.phase === "failed" ? html`
            <button
              type="button"
              class="sw-btn sw-btn--ghost"
              @click=${() => resetSatelliteSetup(sat, onChange)}
            >Reset</button>
          ` : nothing}
        </div>

        ${renderSatelliteError(sat)}
        ${renderConnectedSummary(sat)}
      ` : html`
        <!-- URL / scan mode (existing flow) -->
        <label class="sw-field" style="margin-bottom: 10px;">
          <span class="sw-field__label">Master URL</span>
          <div style="display: flex; gap: 8px; align-items: stretch;">
            <input
              class="sw-input mono"
              placeholder="ws://192.168.1.10:47913 — or pick from the scan below"
              .value=${sat.masterUrl}
              @input=${(e: Event) => updateSatelliteField(host, "masterUrl", (e.target as HTMLInputElement).value)}
              ?disabled=${sat.busy || sat.phase === "connected"}
              style="flex: 1;"
            />
            <button
              type="button"
              class="sw-btn sw-btn--ghost"
              @click=${() => probeMaster(sat, client, onChange)}
              ?disabled=${sat.busy || !sat.masterUrl.trim() || !isValidMasterUrl(sat.masterUrl) || sat.phase === "connected"}
              title="Open a transient WebSocket to confirm reachability without saving anything."
            >
              ${sat.phase === "probing" ? "Testing…" : "Test"}
            </button>
          </div>
          <span class="sw-field__hint">
            Accepts <code>ws://</code> or <code>wss://</code>. The <code>/federation</code> path is added if missing.
          </span>
        </label>

        <!-- Optional: node name + auth token -->
        <div style="display: flex; gap: 12px; margin-bottom: 10px;">
          <label class="sw-field" style="flex: 1; margin: 0;">
            <span class="sw-field__label">Node name (optional)</span>
            <input
              class="sw-input mono"
              placeholder=${navigatorHostnameHint()}
              .value=${sat.nodeName}
              @input=${(e: Event) => updateSatelliteField(host, "nodeName", (e.target as HTMLInputElement).value)}
              ?disabled=${sat.busy || sat.phase === "connected"}
            />
          </label>
          <label class="sw-field" style="flex: 1; margin: 0;">
            <span class="sw-field__label">Auth token (optional)</span>
            <input
              type="password"
              class="sw-input mono"
              placeholder="paste if master requires it"
              .value=${sat.authToken}
              @input=${(e: Event) => updateSatelliteField(host, "authToken", (e.target as HTMLInputElement).value)}
              ?disabled=${sat.busy || sat.phase === "connected"}
            />
          </label>
        </div>

        <!-- Action row -->
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
          <button
            type="button"
            class="sw-btn sw-btn--ghost"
            @click=${() => scanForMasters(sat, client, onChange)}
            ?disabled=${sat.busy || sat.phase === "connected"}
            title="Discover InfiniBot masters reachable on this LAN"
          >
            ${sat.phase === "scanning"
              ? "Scanning…"
              : sat.scanResults.length > 0
                ? html`${icon('refresh')} Re-scan LAN`
                : html`${icon('search')} Scan LAN`}
          </button>
          <button
            type="button"
            class="sw-btn sw-btn--primary"
            @click=${() => connectAsSatellite(sat, client, onChange)}
            ?disabled=${sat.busy || !sat.masterUrl.trim() || !isValidMasterUrl(sat.masterUrl) || sat.phase === "connected"}
          >
            ${sat.phase === "connecting" ? "Connecting…" : sat.phase === "connected" ? html`${icon('check')} Connected` : "Connect"}
          </button>
          ${sat.phase === "connected" ? html`
            <button
              type="button"
              class="sw-btn sw-btn--ghost"
              @click=${() => disconnectSatellite(sat, client, onChange)}
              ?disabled=${sat.busy}
            >Disconnect</button>
          ` : nothing}
          ${sat.phase === "failed" ? html`
            <button
              type="button"
              class="sw-btn sw-btn--ghost"
              @click=${() => resetSatelliteSetup(sat, onChange)}
            >Reset</button>
          ` : nothing}
        </div>

        ${renderScanResults(sat, host)}
        ${renderProbeReport(sat)}
        ${renderSatelliteError(sat)}
        ${renderConnectedSummary(sat)}
      `}
    </div>
  `;
}

function renderSatellitePhase(sat: SatelliteSetupState): TemplateResult {
  const map: Record<SatelliteSetupState["phase"], { label: string; color: string; ic: string }> = {
    idle:        { label: "ready",                   color: "var(--sw-text-mute)", ic: "○" },
    scanning:    { label: "scanning network…",       color: "#60a5fa",            ic: "↻" },
    scanned:     { label: "scan complete",           color: "#60a5fa",            ic: "+" },
    probing:     { label: "probing master…",         color: "#fbbf24",            ic: "↻" },
    probed:      { label: "master reachable",        color: "#34d399",            ic: "+" },
    connecting:  { label: "connecting…",             color: "#fbbf24",            ic: "↻" },
    connected:   { label: "connected to master",     color: "#34d399",            ic: "●" },
    failed:      { label: "failed",                  color: "#f87171",            ic: "x" },
  };
  const cur = map[sat.phase];
  return html`
    <div style="display: flex; align-items: center; gap: 8px; font-family: var(--sw-mono); font-size: 11px; margin-bottom: 14px; color: ${cur.color};">
      <span>${cur.ic}</span><span style="text-transform: uppercase; letter-spacing: 0.12em;">${cur.label}</span>
      ${sat.liveState && sat.phase !== "idle" ? html`
        <span style="color: var(--sw-text-faint); margin-left: 6px;">last event: ${sat.liveState}</span>
      ` : nothing}
    </div>
  `;
}

function renderScanResults(sat: SatelliteSetupState, host: AppViewState): TemplateResult {
  // Skeleton while the auto-scan / manual scan is running so the user
  // sees activity instead of an unexplained blank pane.
  if (sat.phase === "scanning") {
    return html`
      <div style="margin-bottom: 12px;">
        <div style="font-size: 11px; color: var(--sw-text-mute); margin-bottom: 6px; display: flex; align-items: center; gap: 8px;">
          <span style="width: 12px; height: 12px; border: 2px solid color-mix(in srgb, var(--sw-primary) 25%, transparent); border-top-color: var(--sw-primary); border-radius: 50%; display: inline-block; animation: sw-spin 0.85s linear infinite;"></span>
          Scanning your network for InfiniBot masters…
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${[68, 82, 60].map((w) => html`
            <div style="height: 38px; padding: 8px 10px; background: rgba(255,255,255,0.025); border: 1px solid var(--sw-border); border-radius: 6px;">
              <div style="height: 8px; width: ${w}%; border-radius: 3px; background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.04) 100%); background-size: 200% 100%; animation: sw-shimmer 1.4s ease-in-out infinite;"></div>
              <div style="height: 6px; width: ${Math.max(30, w - 30)}%; margin-top: 6px; border-radius: 3px; background: rgba(255,255,255,0.05);"></div>
            </div>
          `)}
        </div>
        <style>
          @keyframes sw-spin { to { transform: rotate(360deg); } }
          @keyframes sw-shimmer {
            0% { background-position: 200% 0; opacity: 0.55; }
            50% { opacity: 1; }
            100% { background-position: -200% 0; opacity: 0.55; }
          }
        </style>
      </div>
    `;
  }

  // Auto-scan or manual scan completed with no candidates.
  if (sat.autoScanFired && sat.scanResults.length === 0 && sat.phase !== "idle") {
    return html`
      <div style="margin-bottom: 12px; padding: 10px 12px; background: rgba(255,255,255,0.03); border: 1px dashed var(--sw-border); border-radius: 6px; font-size: 12px; color: var(--sw-text-mute);">
        No masters found on this network. Make sure the master is running and bound to the LAN
        (<code style="font-family: var(--sw-mono);">--bind lan</code>) — or paste its URL in the field above.
      </div>
    `;
  }

  if (sat.scanResults.length === 0) return html``;
  return html`
    <div style="margin-bottom: 12px;">
      <div style="font-size: 11px; color: var(--sw-text-mute); margin-bottom: 6px;">
        ${sat.scanResults.length} device${sat.scanResults.length === 1 ? "" : "s"} discovered on your network — click to use:
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${sat.scanResults.map((c: ScannedMaster) => html`
          <button
            type="button"
            @click=${() => updateSatelliteField(host, "masterUrl", c.wsUrl)}
            style="text-align: left; padding: 8px 10px; background: rgba(255,255,255,0.025); border: 1px solid var(--sw-border); border-radius: 6px; cursor: pointer; color: var(--sw-text); font-family: var(--sw-mono); font-size: 12px;"
          >
            <div style="display: flex; justify-content: space-between; gap: 8px; align-items: center;">
              <span>${c.hostname || c.dnsName || c.ip || c.wsUrl}</span>
              ${c.likelyMaster ? html`<span style="color: #34d399; font-size: 10px;">★ likely master</span>` : nothing}
            </div>
            <div style="font-size: 11px; color: var(--sw-text-faint); margin-top: 2px;">${c.wsUrl}</div>
            ${c.reason ? html`<div style="font-size: 10.5px; color: var(--sw-text-faint); margin-top: 2px;">${c.reason}</div>` : nothing}
          </button>
        `)}
      </div>
    </div>
  `;
}

function renderProbeReport(sat: SatelliteSetupState): TemplateResult {
  if (!sat.probe || sat.phase !== "probed") return html``;
  return html`
    <div style="margin-bottom: 12px; padding: 10px 12px; background: color-mix(in srgb, #34d399 12%, transparent); border: 1px solid color-mix(in srgb, #34d399 30%, transparent); border-radius: 6px; font-size: 12px; color: #34d399;">
      Master reachable at <code style="font-family: var(--sw-mono);">${sat.probe.url}</code>. Click <strong>Connect</strong> to register and pull config.
    </div>
  `;
}

function renderSatelliteError(sat: SatelliteSetupState): TemplateResult {
  if (!sat.error) return html``;
  const e = sat.error;
  const kindLabel: Record<typeof e.kind, string> = {
    timeout:             "TIMEOUT",
    unauthorized:        "AUTH FAILED",
    "protocol-mismatch": "VERSION MISMATCH",
    network:             "NETWORK",
    config:              "BAD URL",
    unknown:             "ERROR",
  };
  return html`
    <div style="margin-bottom: 12px; padding: 12px; background: color-mix(in srgb, #ef4444 10%, transparent); border: 1px solid color-mix(in srgb, #ef4444 25%, transparent); border-radius: 6px;">
      <div style="font-family: var(--sw-mono); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: #f87171; margin-bottom: 6px;">${kindLabel[e.kind]}</div>
      <div style="font-size: 12.5px; color: var(--sw-text); margin-bottom: 6px;">${e.message}</div>
      <div style="font-size: 12px; color: var(--sw-text-mute);"><strong>Try:</strong> ${e.fix}</div>
    </div>
  `;
}

function renderConnectedSummary(sat: SatelliteSetupState): TemplateResult {
  if (sat.phase !== "connected" || !sat.connected) return html``;
  return html`
    <div style="padding: 12px; background: color-mix(in srgb, #34d399 12%, transparent); border: 1px solid color-mix(in srgb, #34d399 30%, transparent); border-radius: 6px; font-size: 12.5px; color: var(--sw-text);">
      <div style="font-family: var(--sw-mono); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: #34d399; margin-bottom: 6px;">CONNECTED</div>
      <div>Master node: <code>${sat.connected.nodeId ?? "unknown"}</code>${sat.connected.version ? html` · v${sat.connected.version}` : nothing}</div>
      <div style="margin-top: 6px; color: var(--sw-text-mute);">
        Identity files (<code>SOUL.md</code>, <code>MEMORY.md</code>, etc.), API keys, and gateway password sync from the master automatically. You can finish the wizard now — provider/channel/integrations come from there.
      </div>
    </div>
  `;
}

function navigatorHostnameHint(): string {
  try {
    return (typeof navigator !== "undefined" && navigator.userAgent.includes("Win")) ? "MyPC-Satellite" : "macbook-satellite";
  } catch {
    return "satellite";
  }
}

function renderStepProvider(
  s: SetupWizardState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const def = PROVIDER_DEFAULTS[s.provider];
  // Local Ollama needs no key; everyone else needs a key before fetch is useful.
  const canFetch =
    !s.fetchingModels && (s.provider === "ollama" || s.apiKey.trim().length > 0);
  if (s.ollamaDetected === "unknown") void detectLocalOllama(host, client);
  return html`
    <h2 class="sw-step-title">Pick a model provider.</h2>
    <p class="sw-step-sub">
      This is the brain your agents use. Run a free local model with Ollama, or bring your own key —
      InfiniBot calls the provider directly and never proxies your traffic. Add more providers later
      from the API Keys page.
    </p>
    <div class="sw-detect ${s.ollamaDetected === "running" ? "is-ok" : ""}" data-testid="sw-ollama-detect">
      ${s.ollamaDetected === "checking" || s.ollamaDetected === "unknown"
        ? "Looking for a local Ollama…"
        : s.ollamaDetected === "running"
          ? html`${icon('checkCircle')} Ollama is running on this machine — no API key needed.`
          : html`No local Ollama found. <a href="https://ollama.com/download" target="_blank" rel="noopener">Install Ollama</a> for free local models, or pick a hosted provider below.`}
    </div>
    <div class="sw-providers" data-learn-id="setup-providers">
      ${(Object.keys(PROVIDER_DEFAULTS) as ProviderId[]).map((id) => html`
        <button
          class="sw-provider ${s.provider === id ? "is-selected" : ""}"
          data-provider=${id}
          @click=${() => setField(host, "provider", id)}
        >
          <div class="sw-provider__name">
            <ib-provider-logo provider=${id} label=${PROVIDER_DEFAULTS[id].label} size="28"></ib-provider-logo>
            ${PROVIDER_DEFAULTS[id].label}
            ${id === "ollama" && s.ollamaDetected === "running" ? html`<span class="sw-badge">detected</span>` : nothing}
          </div>
          <div class="sw-provider__model">default: ${PROVIDER_DEFAULTS[id].defaultModel}</div>
        </button>
      `)}
    </div>

    ${s.provider === "ollama" ? html`
      <label class="sw-field">
        <span class="sw-field__label">Ollama base URL</span>
        <input
          class="sw-input mono"
          .value=${s.ollamaBaseUrl}
          @input=${(e: Event) => setField(host, "ollamaBaseUrl", (e.target as HTMLInputElement).value)}
          placeholder="http://localhost:11434"
        />
        <span class="sw-field__hint">Make sure the Ollama daemon is running and reachable from this machine.</span>
      </label>
    ` : html`
      <label class="sw-field">
        <span class="sw-field__label">${def.label} API key</span>
        <input
          type="password"
          class="sw-input mono"
          .value=${s.apiKey}
          @input=${(e: Event) => setField(host, "apiKey", (e.target as HTMLInputElement).value)}
          placeholder=${def.placeholder}
          autocomplete="off"
        />
        <span class="sw-field__hint">Stored locally in this gateway's auth profile store (<code>${runtimeProviderId(s.provider)}:default</code>) — manage it later on the API Keys page.</span>
      </label>
    `}

    <div class="sw-field">
      <span class="sw-field__label">Available models</span>
      <div class="sw-fetch-row">
        <button
          class="sw-btn sw-btn--ghost"
          ?disabled=${!canFetch}
          @click=${() => void fetchWizardModels(host, client)}
        >
          ${s.fetchingModels ? "Fetching…" : "Fetch models"}
        </button>
        ${s.discoveredModels.length > 0 ? html`
          <select
            class="sw-input"
            @change=${(e: Event) => setField(host, "defaultModel", (e.target as HTMLSelectElement).value)}
          >
            ${s.discoveredModels.map((m) => html`
              <option value=${m.id} ?selected=${m.id === s.defaultModel}>${m.label ?? m.id}</option>
            `)}
          </select>
        ` : nothing}
      </div>
      ${s.modelsError ? html`<span class="sw-field__hint sw-field__hint--error">${s.modelsError}</span>` : html`
        <span class="sw-field__hint">
          ${s.provider === "ollama"
            ? "Pulls the model list from your local Ollama daemon."
            : "Pulls the live model catalog from the provider using your key."}
        </span>
      `}
    </div>

    <label class="sw-field">
      <span class="sw-field__label">Default model</span>
      <input
        class="sw-input mono"
        .value=${s.defaultModel}
        @input=${(e: Event) => setField(host, "defaultModel", (e.target as HTMLInputElement).value)}
        placeholder=${def.defaultModel}
      />
      <span class="sw-field__hint">Saved as <code>${runtimeProviderId(s.provider)}/${s.defaultModel || def.defaultModel}</code> in <code>agents.defaults.model.primary</code>. Or pick from the dropdown above.</span>
    </label>

    <button class="sw-linkbtn" @click=${() => setStep(host, STEP_FEDERATION)}>
      Joining an existing InfiniBot federation? Connect as a satellite instead →
    </button>
  `;
}

function renderStepChannel(s: SetupWizardState, host: AppViewState): TemplateResult {
  const channels: Array<{ id: ChannelId; label: string; sub: string }> = [
    { id: "web",       label: "Web chat only",  sub: "Skip channel setup. Talk through the in-app chat tab." },
    { id: "telegram",  label: "Telegram",       sub: "Guided setup, about a minute. Best for solo daily use." },
    { id: "discord",   label: "Discord",        sub: "Bot token from Discord Developer Portal." },
    { id: "whatsapp",  label: "WhatsApp",       sub: "QR-based pairing — finish on the Channels tab." },
  ];
  return html`
    <h2 class="sw-step-title">Pick a channel.</h2>
    <p class="sw-step-sub">
      A channel is how the agent reaches you outside the browser. You can add more later or skip this entirely.
    </p>
    <div class="sw-channels">
      ${channels.map((c) => isChannelExcluded(c.id) ? html`
        <button
          class="sw-channel is-plan-locked"
          data-plan-locked="true"
          data-testid=${`sw-channel-plan-lock-${c.id}`}
          title=${channelLockReason(c.id)}
          @click=${() => void openUpgrade("pro", { source: `setup-wizard:${c.id}` })}
        >
          <div class="sw-channel__label">${c.label}</div>
          <div class="sw-channel__sub">Not on the Free plan. ${channelUpgradeCta(c.id)}.</div>
        </button>
      ` : html`
        <button
          class="sw-channel ${s.channel === c.id ? "is-selected" : ""}"
          @click=${() => setField(host, "channel", c.id)}
        >
          <div class="sw-channel__label">${c.label}</div>
          <div class="sw-channel__sub">${c.sub}</div>
        </button>
      `)}
    </div>

    ${s.channel === "telegram" && !isChannelExcluded("telegram") ? html`
      <div style="margin-top: 14px;">
        <telegram-setup
          .client=${host.client}
          @telegram-setup-ready=${(e: CustomEvent<{ connected: boolean }>) =>
            setField(host, "telegramConnected", Boolean(e.detail?.connected))}
          @telegram-setup-changed=${(e: CustomEvent<{ connected: boolean }>) =>
            setField(host, "telegramConnected", Boolean(e.detail?.connected))}
        ></telegram-setup>
        <span class="sw-field__hint">
          ${s.telegramConnected
            ? "Telegram is connected. Press Continue."
            : "Finish the steps above, then Continue lights up. Or pick “Web chat only” to do this later."}
        </span>
      </div>
    ` : nothing}

    ${s.channel === "discord" ? html`
      <label class="sw-field">
        <span class="sw-field__label">Discord bot token</span>
        <input
          type="password"
          class="sw-input mono"
          .value=${s.discordBotToken}
          @input=${(e: Event) => setField(host, "discordBotToken", (e.target as HTMLInputElement).value)}
          placeholder="MTIz..."
          autocomplete="off"
        />
        <span class="sw-field__hint">
          From <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a> → your application → Bot.
        </span>
      </label>
    ` : nothing}

    ${s.channel === "whatsapp" ? html`
      <div class="sw-callout">
        <strong>WhatsApp pairs via QR code.</strong> We'll flip the channel on now; the QR will appear on the Channels tab the next time the gateway starts. Scan it with WhatsApp → Linked Devices.
      </div>
    ` : nothing}
  `;
}

function renderStepIntegrations(
  s: SetupWizardState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  return html`
    <h2 class="sw-step-title">Optional integrations.</h2>
    <p class="sw-step-sub">
      All of these are skippable — paste a token now, or come back later from the relevant tab.
    </p>

    <label class="sw-field">
      <span class="sw-field__label">Notion API token</span>
      <input
        type="password"
        class="sw-input mono"
        .value=${s.notionToken}
        @input=${(e: Event) => setField(host, "notionToken", (e.target as HTMLInputElement).value)}
        placeholder="ntn_…  (or  secret_…)"
        autocomplete="off"
      />
      <span class="sw-field__hint">
        Create at <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener">notion.so/my-integrations</a>. Optional: Projects, Tasks, Databases and the CRM all work without it; this only mirrors them to Notion.
      </span>
    </label>

    <label class="sw-field">
      <span class="sw-field__label">Brave Search API key</span>
      <input
        type="password"
        class="sw-input mono"
        .value=${s.braveApiKey}
        @input=${(e: Event) => setField(host, "braveApiKey", (e.target as HTMLInputElement).value)}
        placeholder="BSA…"
        autocomplete="off"
      />
      <span class="sw-field__hint">
        Used by the agent's <code>research</code> tool. Free tier at <a href="https://brave.com/search/api/" target="_blank" rel="noopener">brave.com/search/api</a>.
      </span>
    </label>

    ${renderIdentityImportBlock(host, client)}

    <div class="sw-callout">
      <strong>Calendar &amp; GitHub use OAuth.</strong> Open the Schedule tab to connect Google Calendar / Calendly, and the Workspace tab to wire up GitHub repos. Both happen after setup.
    </div>

    ${renderCoderBackendPicker(s, host)}
  `;
}

/* COORDINATION: opencode-swap — coding agent picker injected at end of step 4 */
function renderCoderBackendPicker(s: SetupWizardState, host: AppViewState): TemplateResult {
  // Kick off the per-backend MCP install status fetch the first time this
  // step renders. Cheap, no-op on subsequent renders.
  void loadCoderMcpStatus(host);

  const cards: Array<{
    id: CoderBackendChoice;
    label: string;
    desc: string;
    req: string;
  }> = [
    {
      id: "claude-code",
      label: "Claude Code",
      desc: "Anthropic's official CLI coding agent. Best-in-class for Claude models, deep tool-use, and the InfiniBot skill/memory system.",
      req: "Requires an Anthropic API key (set in Step 2).",
    },
    {
      id: "opencode",
      label: "OpenCode",
      desc: "Open-source coding agent (github.com/sst/opencode). Supports 75+ providers — Anthropic, OpenAI, Gemini, Ollama, local models, and more.",
      req: "Install with: npm i -g opencode-ai@latest",
    },
    {
      id: "codex",
      label: "Codex CLI",
      desc: "OpenAI's official CLI coding agent. Supports GPT-5 and ChatGPT OAuth authentication.",
      req: "Install with: npm i -g @openai/codex",
    },
    {
      id: "grok",
      label: "Grok Build",
      desc: "xAI's Grok Build CLI. Runs grok-* models on your SuperGrok / X Premium+ sign-in — no API key needed.",
      req: "Install from Setup › Coders, then sign in with `grok login --device-auth`.",
    },
  ];

  return html`
    <div style="border-top: 1px dashed var(--sw-border); padding-top: 20px; margin-top: 16px;">
      <span class="sw-field__label" style="display:block; margin-bottom: 4px;">Coding agent backend</span>
      <span class="sw-field__hint" style="display:block; margin-bottom: 12px;">
        Powers the <code>claude_coder</code> tool. You can change this later from Settings → Coding Backend.
      </span>
      <div style="display:flex; gap:12px; flex-wrap:wrap;">
        ${cards.map((c) => renderCoderBackendCard(c, s, host))}
      </div>
      ${coderMcpStatus.error
        ? html`<div style="margin-top:10px; padding:8px 12px; border-radius:6px; background:rgba(239,68,68,.1); color:#fca5a5; font-size:12px; white-space:pre-wrap;">${coderMcpStatus.error}</div>`
        : nothing}
      ${coderMcpStatus.notice
        ? html`<div style="margin-top:10px; padding:8px 12px; border-radius:6px; background:rgba(34,197,94,.12); color:#86efac; font-size:12px;">${coderMcpStatus.notice}</div>`
        : nothing}
    </div>
  `;
}

function renderCoderBackendCard(
  c: { id: CoderBackendChoice; label: string; desc: string; req: string },
  s: SetupWizardState,
  host: AppViewState,
): TemplateResult {
  const mcp = coderMcpStatus.entries[c.id];
  const installing = coderMcpStatus.installing === c.id;
  const registered = mcp?.registered === true;
  return html`
    <div style="flex:1; min-width:220px; display:flex; flex-direction:column; gap:8px;">
      <button
        class="sw-provider-btn ${s.coderBackend === c.id ? "active" : ""}"
        style="text-align:left; display:flex; flex-direction:column; gap:6px; padding:14px 16px; background: ${s.coderBackend === c.id ? "rgba(139,92,246,.15)" : "var(--sw-surface)"};
          border: 1.5px solid ${s.coderBackend === c.id ? "var(--sw-primary)" : "var(--sw-border)"};
          border-radius: 10px; cursor:pointer; color: var(--c-text-1,#e4e4e7); transition: border-color .15s, background .15s;
          backdrop-filter: blur(8px);"
        @click=${() => setField(host, "coderBackend", c.id)}
      >
        <span style="font-weight:600; font-size:14px; display:flex; align-items:center; gap:10px;"><ib-provider-logo provider=${c.id} label=${c.label} size="28"></ib-provider-logo>${c.label}</span>
        <span style="font-size:12px; color:var(--c-text-2,#a1a1aa); line-height:1.5;">${c.desc}</span>
        <span style="font-size:11px; color:var(--c-text-3,#71717a); font-style:italic;">${c.req}</span>
      </button>
      <div
        title=${mcp?.path ?? ""}
        style="display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px dashed var(--sw-border); border-radius:8px; background:rgba(255,255,255,.02);"
      >
        <span style="font-size:11px; font-weight:600; color:var(--c-text-2,#a1a1aa); letter-spacing:.02em;">InfiniBot MCP</span>
        <span style="font-size:11px; padding:2px 8px; border-radius:999px; ${registered
          ? "background:rgba(34,197,94,.15); color:#86efac;"
          : "background:rgba(245,158,11,.15); color:#fbbf24;"}">
          ${registered ? "✓ installed" : "✗ not installed"}
        </span>
        <button
          ?disabled=${installing}
          @click=${() => installCoderMcp(c.id, host)}
          style="margin-left:auto; font-size:11px; font-weight:600; padding:4px 12px; border-radius:6px;
            border:1px solid color-mix(in srgb, var(--sw-primary, #8b5cf6) 35%, transparent);
            background:color-mix(in srgb, var(--sw-primary, #8b5cf6) 12%, transparent);
            color:var(--sw-primary, #8b5cf6); cursor:${installing ? "wait" : "pointer"};"
        >
          ${installing ? "Installing…" : registered ? "Reinstall" : "Install"}
        </button>
      </div>
      ${c.id === "opencode" && s.coderBackend === "opencode"
        ? renderOpencodeModelField(s, host)
        : nothing}
    </div>
  `;
}

function renderOpencodeModelField(s: SetupWizardState, host: AppViewState): TemplateResult {
  return html`
    <div style="display:flex; flex-direction:column; gap:4px; padding:8px 10px; border:1px dashed var(--sw-border); border-radius:8px; background:rgba(255,255,255,.02);">
      <label style="font-size:11px; font-weight:600; color:var(--c-text-2,#a1a1aa); letter-spacing:.02em;">
        Default model
      </label>
      <input
        type="text"
        .value=${s.opencodeModel}
        placeholder="ollama-cloud/glm-5.1"
        @input=${(e: Event) =>
          setField(host, "opencodeModel", (e.target as HTMLInputElement).value)}
        style="font-size:12px; padding:6px 8px; border-radius:6px; border:1px solid var(--sw-border);
          background:var(--sw-surface); color:var(--c-text-1,#e4e4e7); font-family:ui-monospace,SFMono-Regular,monospace;"
      />
      <span style="font-size:10px; color:var(--c-text-3,#71717a); line-height:1.4;">
        provider/model id used when no explicit model is passed. Leave blank to use the built-in fallback (ollama-cloud/glm-5.1).
      </span>
    </div>
  `;
}

/**
 * Wizard-embedded identity import — lets a fresh install bring in SOUL.md /
 * MEMORY.md / etc. from another moltbot or infinibot system at first-run
 * time. Reuses the same controller as the Memory tab so the per-file resolve
 * dialog behavior stays identical.
 *
 * Note we render the resolution dialog only *here* (no portal back to the
 * Memory view), and we always target the default agent — the user picks a
 * specific agent later from the Memory tab if they want.
 */
function renderIdentityImportBlock(
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const ids = host.agentIdentityState;
  const pending = ids?.pendingImports ?? [];
  const showDialog = (ids?.importDialogOpen ?? false) && pending.length > 0;

  return html`
    <div class="sw-field" style="border-top: 1px dashed var(--sw-border); padding-top: 16px; margin-top: 8px;">
      <span class="sw-field__label">Bring identity from another moltbot / infinibot (optional)</span>
      <span class="sw-field__hint">
        Drop your existing <code>SOUL.md</code>, <code>MEMORY.md</code>, <code>USER.md</code>, etc., or a previously exported <code>.json</code> bundle. You'll review each file before it's written. Already have a federation master? Use the URL field below.
      </span>

      <div
        @dragover=${(e: DragEvent) => { e.preventDefault(); (e.currentTarget as HTMLElement).style.borderColor = "var(--sw-primary)"; }}
        @dragleave=${(e: DragEvent) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--sw-border)"; }}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).style.borderColor = "var(--sw-border)";
          if (e.dataTransfer?.files?.length) {
            stageImportFiles(host, client, e.dataTransfer.files);
          }
        }}
        style="margin-top: 10px; padding: 14px; border: 2px dashed var(--sw-border); border-radius: 8px; text-align: center; transition: border-color 120ms ease;"
      >
        <div style="font-size: 12.5px; color: var(--sw-text-mute); margin-bottom: 8px;">
          Drop ${IDENTITY_FILENAMES.length} known identity files or a bundle here.
        </div>
        <label class="sw-btn sw-btn--ghost" style="cursor: pointer; display: inline-block; display: inline-flex; align-items: center; gap: 6px;">
          ${icon('folder')} Choose files
          <input
            type="file"
            multiple
            accept=".md,.json"
            style="display: none;"
            @change=${(e: Event) => {
              const files = (e.target as HTMLInputElement).files;
              if (files?.length) {
                stageImportFiles(host, client, files);
                (e.target as HTMLInputElement).value = "";
              }
            }}
          />
        </label>
      </div>

      <div style="display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap;">
        <input
          type="text"
          class="sw-input mono"
          placeholder="peer gateway url (wss://…)"
          .value=${ids?.peerUrl ?? ""}
          @input=${(e: Event) => setPeerUrl(host, (e.target as HTMLInputElement).value)}
          style="flex: 1; min-width: 220px;"
        />
        <input
          type="password"
          class="sw-input mono"
          placeholder="token (optional)"
          .value=${ids?.peerToken ?? ""}
          @input=${(e: Event) => setPeerToken(host, (e.target as HTMLInputElement).value)}
          style="width: 160px;"
        />
        <button
          class="sw-btn sw-btn--ghost"
          ?disabled=${ids?.pulling || !(ids?.peerUrl ?? "").trim()}
          @click=${() => pullIdentityFromPeer(host, client)}
        >
          ${ids?.pulling ? "Pulling…" : html`${icon('download')} Pull from peer`}
        </button>
      </div>

      ${ids?.status ? html`
        <div style="margin-top: 8px; padding: 6px 10px; background: color-mix(in srgb, #10b981 14%, transparent); color: #10b981; border-radius: 4px; font-size: 11.5px;">${ids.status}</div>
      ` : nothing}
      ${ids?.error ? html`
        <div style="margin-top: 8px; padding: 6px 10px; background: color-mix(in srgb, #ef4444 14%, transparent); color: #f87171; border-radius: 4px; font-size: 11.5px;">${ids.error}</div>
      ` : nothing}

      ${showDialog ? html`
        <div style="margin-top: 12px; padding: 12px; border: 1px solid var(--sw-border-strong); border-radius: 8px; background: rgba(0,0,0,0.4);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <strong style="color: var(--sw-primary); font-family: var(--sw-mono); font-size: 12px;">${pending.length} file(s) ready — choose action per file</strong>
            <button class="sw-btn sw-btn--ghost" style="padding: 4px 10px;" @click=${() => cancelPendingImport(host)}>Cancel</button>
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow-y: auto;">
            ${pending.map((p) => html`
              <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(255,255,255,0.025); border: 1px solid var(--sw-border); border-radius: 6px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-family: var(--sw-mono); font-size: 12px; color: var(--sw-primary);">${p.filename}</span>
                  <span style="font-size: 10.5px; color: var(--sw-text-faint);">
                    ${p.currentContent ? `replaces ${p.currentContent.length} chars on disk` : "creating new"}
                  </span>
                </div>
                <div style="display: flex; gap: 4px;">
                  ${(["replace", "append", "skip"] as ImportAction[]).map((a) => html`
                    <button
                      class="sw-btn sw-btn--ghost"
                      style="padding: 3px 8px; font-size: 11px; ${p.action === a ? 'background: var(--sw-primary); color: #000; border-color: var(--sw-primary);' : ''}"
                      @click=${() => setPendingAction(host, p.filename, a)}
                    >${a}</button>
                  `)}
                </div>
              </div>
            `)}
          </div>
          <div style="display: flex; justify-content: flex-end; margin-top: 10px;">
            <button
              class="sw-btn sw-btn--primary"
              ?disabled=${ids?.importing}
              @click=${() => commitPendingImport(host, client)}
            >
              ${ids?.importing ? "Importing…" : "Apply"}
            </button>
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}

function renderStepVoice(_s: SetupWizardState, host: AppViewState): TemplateResult {
  const on = isTabAvailable("robovoice");
  return html`
    <h2 class="sw-step-title">Voice.</h2>
    <p class="sw-step-sub">
      Local voice is on by default: it runs on this computer, private, no account needed.
      Talk to any agent, or straight to a CLI agent, from the Voice page. If this computer can't
      run voice, you can pick Cloud voice (Robovoice) instead. It's optional and free. Link it
      below, then choose Cloud voice in the Voice page's Settings.
    </p>
    <div class="sw-callout" data-testid="sw-voice-robovoice">
      ${on
        ? html`<robovoice-link variant="compact"></robovoice-link>`
        : html`Cloud voice (Robovoice) is off. You can turn it on from the Voice page if you ever want it.`}
    </div>
    <div style="margin-top:12px;">
      <button class="sw-btn sw-btn--ghost" type="button" @click=${() => host.setTab?.("voice" as never)}>Open the Voice page</button>
    </div>
  `;
}

function renderStepReview(
  s: SetupWizardState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const def = PROVIDER_DEFAULTS[s.provider];
  const summary: Array<[string, string]> = [
    ["Provider",       `${def.label} · ${s.defaultModel || def.defaultModel}`],
    ["API key",        s.provider === "ollama" ? "n/a (local)" : (s.apiKey ? "set (hidden)" : "(empty — verify in API Keys later)")],
    ["Channel",        s.channel === "web" ? "Web chat only" : s.channel],
    ...(s.channel === "telegram" ? [
      ["Telegram bot",   s.telegramConnected ? "connected (guided setup)" : "(not finished)"] as [string, string],
    ] : []),
    ["Notion",         s.notionToken ? "set" : "skipped"],
    ["Brave",          s.braveApiKey ? "set" : "skipped"],
    ["Voice",          "Local voice (default)"],
  ];
  return html`
    <h2 class="sw-step-title">Review &amp; verify.</h2>
    <p class="sw-step-sub">
      Confirm the summary below, then run a smoke test. We hit <code>models.list</code> on the gateway to confirm the
      provider is reachable, and (when applicable) send one test message through the configured channel.
    </p>
    <dl class="sw-summary">
      ${summary.map(([k, v]) => html`
        <div class="sw-summary__row">
          <dt>${k}</dt>
          <dd>${v}</dd>
        </div>
      `)}
    </dl>

    <div class="sw-test">
      <button
        class="sw-btn sw-btn--primary"
        ?disabled=${s.loading}
        @click=${() => runSmokeTests(host, client)}
      >
        ${s.loading ? "Testing…" : "Run smoke test"}
      </button>
      ${s.testResult
        ? html`
            <div class="sw-test__result ${s.testResult.ok ? "ok" : "fail"}">
              <span class="sw-test__dot"></span>
              <span>${s.testResult.message}</span>
            </div>
          `
        : nothing}
    </div>

    ${s.completed
      ? html`
          <div class="sw-callout sw-callout--ok">
            <strong>Setup complete.</strong> Open the Chat tab to start a conversation, or jump to any other view from the sidebar. Re-run this wizard any time from Settings → Setup.
          </div>
        `
      : nothing}
  `;
}

function renderFooter(
  s: SetupWizardState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const isLast = s.step === STEP_REVIEW;
  const canBack = s.step > 1;
  // Per-step gating. The welcome step also gates on the satellite mini-flow:
  // if the user picked satellite but hasn't connected yet, "Continue" stays
  // disabled — clicking the inline Connect button is the path forward.
  const canForward = (() => {
    if (s.step === STEP_FEDERATION) {
      if (s.nodeRole === "satellite") return s.satellite.phase === "connected";
      return true; // solo or master
    }
    if (s.step === STEP_PROVIDER) return s.provider === "ollama" ? !!s.ollamaBaseUrl.trim() : !!s.apiKey.trim();
    if (s.step === STEP_CHANNEL) {
      if (s.channel === "telegram") return s.telegramConnected;
      if (s.channel === "discord") return !!s.discordBotToken.trim();
      return true;
    }
    return true;
  })();
  // Forward-button label varies for the satellite path so the user knows
  // what's about to happen.
  const forwardLabel = (() => {
    if (s.saving) return "Saving…";
    if (s.step === STEP_FEDERATION) {
      if (s.nodeRole === "satellite") {
        return s.satellite.phase === "connected"
          ? "Continue — config syncs from master →"
          : "Connect first to continue";
      }
      if (s.nodeRole === "master") return "Save as master →";
      return "Continue as solo →";
    }
    return "Save & continue →";
  })();
  return html`
    <div class="sw-footer">
      <button class="sw-btn sw-btn--ghost" ?disabled=${!canBack} @click=${() => setStep(host, (s.step - 1) as WizardStep)}>
        ← Back
      </button>
      <div style="flex:1;"></div>
      ${isLast
        ? html`
            <button
              class="sw-btn sw-btn--primary"
              ?disabled=${s.saving}
              @click=${() => { wizardState.completed = true; host.requestUpdate?.(); }}
              title="Mark setup as complete and exit the wizard"
            >${s.completed ? "Close" : "Finish setup →"}</button>
          `
        : html`
            <button
              class="sw-btn sw-btn--primary"
              ?disabled=${!canForward || s.saving}
              @click=${() => commitAndAdvance(host, client)}
            >
              ${forwardLabel}
            </button>
          `}
    </div>
  `;
}

// ── Styles ────────────────────────────────────────────────────────────────

export function wizardStyles(): TemplateResult {
  return html`
    <style>
      .sw-root {
        --sw-primary: var(--g-primary, #fbbf24);
        --sw-primary-soft: color-mix(in srgb, var(--sw-primary) 12%, transparent);
        --sw-primary-strong: color-mix(in srgb, var(--sw-primary) 35%, transparent);
        --sw-text: var(--text, #e4e4e7);
        --sw-text-mute: color-mix(in srgb, var(--text, #e4e4e7) 60%, transparent);
        --sw-text-faint: color-mix(in srgb, var(--text, #e4e4e7) 38%, transparent);
        --sw-surface: rgba(255,255,255,0.045);
        --sw-surface-strong: rgba(255,255,255,0.085);
        --sw-border: color-mix(in srgb, var(--sw-primary) 18%, rgba(255,255,255,0.08));
        --sw-border-strong: color-mix(in srgb, var(--sw-primary) 40%, transparent);
        --sw-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        --sw-radius: 14px;

        max-width: 880px; margin: 0 auto; padding: 24px;
        color: var(--sw-text);
        font-size: 14px; line-height: 1.6;
      }
      .sw-header {
        display:flex; align-items:flex-start; gap:14px; margin-bottom: 20px;
        padding: 18px 20px;
        background: linear-gradient(135deg, var(--sw-surface-strong), rgba(255,255,255,0.015));
        backdrop-filter: blur(22px) saturate(170%);
        -webkit-backdrop-filter: blur(22px) saturate(170%);
        border: 1px solid var(--sw-border);
        border-radius: var(--sw-radius);
        box-shadow: 0 12px 40px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.06);
      }
      .sw-brand { display:flex; align-items:flex-start; gap:16px; flex:1; min-width:0; }
      .sw-brand__text { flex:1; min-width:0; }
      .sw-logo {
        flex-shrink: 0;
        width: 56px; height: 56px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 14px;
        background: radial-gradient(circle at 30% 25%, var(--sw-primary-soft), rgba(255,255,255,0.03));
        border: 1px solid var(--sw-border-strong);
        box-shadow:
          0 0 22px color-mix(in srgb, var(--sw-primary) 30%, transparent),
          inset 0 1px 0 rgba(255,255,255,.12);
      }
      .sw-logo img {
        width: 38px; height: 38px;
        object-fit: contain;
        filter: drop-shadow(0 2px 6px rgba(0,0,0,.45));
      }
      .sw-eyebrow {
        font-family: var(--sw-mono);
        font-size: 10px; font-weight: 700; letter-spacing: 0.22em;
        color: var(--sw-primary);
        margin-bottom: 6px;
      }
      .sw-title {
        font-family: var(--sw-mono);
        font-size: 26px; font-weight: 700;
        letter-spacing: -0.01em;
        margin: 0 0 6px;
        color: var(--text-strong, #fff);
      }
      .sw-sub {
        margin: 0; color: var(--sw-text-mute);
        max-width: 640px;
      }
      .sw-sub code, .sw-step-sub code {
        font-family: var(--sw-mono);
        background: rgba(0,0,0,0.4);
        border: 1px solid var(--sw-border);
        padding: 1px 6px; border-radius: 4px;
        font-size: 0.88em;
      }

      .sw-progress {
        display: flex; align-items: center; gap: 4px;
        padding: 12px 16px; margin-bottom: 14px;
        background: var(--sw-surface);
        backdrop-filter: blur(18px) saturate(160%);
        -webkit-backdrop-filter: blur(18px) saturate(160%);
        border: 1px solid var(--sw-border);
        border-radius: 12px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
      }
      .sw-progress__step {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 6px 10px; border: none; background: transparent;
        color: var(--sw-text-faint); cursor: pointer;
        font-family: var(--sw-mono);
        font-size: 11px; font-weight: 700; letter-spacing: 0.1em;
        transition: color .15s ease;
      }
      .sw-progress__step:not(:disabled):hover { color: var(--sw-text); }
      .sw-progress__step:disabled { cursor: not-allowed; opacity: .5; }
      .sw-progress__step.is-active { color: var(--sw-primary); }
      .sw-progress__num {
        width: 26px; height: 26px;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 999px;
        background: var(--sw-surface);
        border: 1px solid var(--sw-border);
        font-variant-numeric: tabular-nums;
      }
      .sw-progress__step.is-active .sw-progress__num {
        background: var(--sw-primary-soft);
        border-color: var(--sw-primary);
        color: var(--sw-primary);
      }
      .sw-progress__step.is-done .sw-progress__num {
        background: var(--sw-primary);
        border-color: var(--sw-primary);
        color: #000;
      }
      .sw-progress__line {
        flex:1; height: 1px;
        background: var(--sw-border);
      }
      .sw-progress__line.is-done { background: var(--sw-primary); }

      .sw-card {
        position: relative;
        background:
          linear-gradient(160deg, rgba(255,255,255,0.06), rgba(255,255,255,0.01) 42%),
          var(--sw-surface);
        backdrop-filter: blur(30px) saturate(185%);
        -webkit-backdrop-filter: blur(30px) saturate(185%);
        border: 1px solid var(--sw-border);
        border-radius: var(--sw-radius);
        padding: 28px;
        box-shadow:
          0 24px 70px rgba(0,0,0,.55),
          0 0 0 1px rgba(255,255,255,.02) inset,
          inset 0 1px 0 rgba(255,255,255,.06);
        overflow: hidden;
      }
      /* Soft primary glow bleeding from the top edge — reinforces the glass depth. */
      .sw-card::before {
        content: "";
        position: absolute; inset: 0; pointer-events: none;
        background: radial-gradient(120% 60% at 50% -10%, var(--sw-primary-soft), transparent 60%);
        opacity: .7;
      }
      .sw-card > * { position: relative; }

      .sw-step-title {
        font-family: var(--sw-mono);
        font-size: 22px; font-weight: 700;
        letter-spacing: -0.005em;
        margin: 0 0 8px;
        color: var(--text-strong, #fff);
      }
      .sw-step-sub {
        margin: 0 0 22px;
        color: var(--sw-text-mute);
      }

      .sw-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 12px;
        margin-bottom: 18px;
      }
      .sw-grid__card {
        background: linear-gradient(160deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015));
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--sw-border);
        border-radius: 10px;
        padding: 14px;
        transition: border-color .15s ease, background .15s ease, transform .15s ease, box-shadow .15s ease;
      }
      button.sw-grid__card { cursor: pointer; }
      button.sw-grid__card:hover {
        border-color: var(--sw-border-strong);
        transform: translateY(-1px);
        box-shadow: 0 10px 30px rgba(0,0,0,.35), 0 0 18px var(--sw-primary-soft);
      }
      .sw-grid__icon { font-size: 20px; margin-bottom: 8px; }
      .sw-grid__title {
        font-family: var(--sw-mono);
        font-size: 13px; font-weight: 700;
        color: var(--text-strong, #fff);
        margin-bottom: 4px;
      }
      .sw-grid__desc { font-size: 12.5px; color: var(--sw-text-mute); line-height: 1.55; }

      .sw-detect {
        margin: 0 0 14px; padding: 10px 12px; border-radius: 10px; font-size: 12.5px;
        color: var(--sw-text-mute); background: var(--sw-surface); border: 1px solid var(--sw-border);
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      }
      .sw-detect.is-ok { color: var(--sw-text); border-color: var(--sw-primary-strong); background: var(--sw-primary-soft); }
      .sw-detect a { color: var(--sw-primary); }
      .sw-detect svg { width: 15px; height: 15px; flex: none; }
      .sw-badge {
        display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; vertical-align: middle;
        font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
        color: var(--sw-primary); border: 1px solid var(--sw-primary-strong); background: var(--sw-primary-soft);
      }
      .sw-linkbtn { all: unset; cursor: pointer; font-size: 12px; color: var(--sw-text-faint); text-decoration: underline; }
      .sw-linkbtn:hover { color: var(--sw-text); }
      .sw-callout {
        display: block;
        padding: 12px 14px;
        background: var(--sw-primary-soft);
        border: 1px solid var(--sw-border-strong);
        border-left: 3px solid var(--sw-primary);
        border-radius: 8px;
        font-size: 13px;
        color: var(--sw-text);
        margin: 14px 0 0;
      }
      .sw-callout strong { color: var(--sw-primary); font-family: var(--sw-mono); }
      .sw-callout--ok {
        background: color-mix(in srgb, #10b981 12%, transparent);
        border-color: color-mix(in srgb, #10b981 35%, transparent);
        border-left-color: #10b981;
      }
      .sw-callout--ok strong { color: #34d399; }

      .sw-providers, .sw-channels {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 8px;
        margin-bottom: 18px;
      }
      .sw-provider, .sw-channel {
        text-align: left;
        background: linear-gradient(160deg, rgba(255,255,255,0.05), rgba(255,255,255,0.012));
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--sw-border);
        border-radius: 10px;
        padding: 12px 14px;
        cursor: pointer; color: var(--sw-text);
        transition: border-color .15s ease, background .15s ease, transform .15s ease, box-shadow .15s ease;
      }
      .sw-provider:hover, .sw-channel:hover {
        border-color: var(--sw-border-strong);
        background: var(--sw-surface-strong);
        transform: translateY(-1px);
        box-shadow: 0 8px 24px rgba(0,0,0,.32);
      }
      .sw-channel.is-plan-locked { border-style: dashed; border-color: rgba(232, 184, 75, 0.38); }
      .sw-channel.is-plan-locked .sw-channel__sub { color: #f1cd6f; }
      .sw-provider.is-selected, .sw-channel.is-selected {
        background: var(--sw-primary-soft);
        border-color: var(--sw-primary);
        box-shadow: 0 0 0 1px var(--sw-primary-strong) inset, 0 0 20px var(--sw-primary-soft);
      }
      .sw-provider__name { display: flex; align-items: center; gap: 10px; }
      .sw-provider__name, .sw-channel__label {
        font-family: var(--sw-mono);
        font-size: 13px; font-weight: 700;
        color: var(--text-strong, #fff);
        margin-bottom: 3px;
      }
      .sw-provider__model, .sw-channel__sub {
        font-size: 11px; color: var(--sw-text-mute); font-family: var(--sw-mono);
      }
      .sw-channel__sub { font-family: inherit; font-size: 12px; line-height: 1.5; }

      .sw-field {
        display: block; margin-bottom: 14px;
      }
      .sw-field__label {
        display: block;
        font-family: var(--sw-mono);
        font-size: 10px; font-weight: 700; letter-spacing: 0.16em;
        color: var(--sw-text-faint); text-transform: uppercase;
        margin-bottom: 6px;
      }
      .sw-input {
        width: 100%;
        background: rgba(0,0,0,0.4);
        color: var(--text-strong, #fff);
        border: 1px solid var(--sw-border);
        border-radius: 8px;
        padding: 10px 12px;
        font-family: inherit; font-size: 13px;
        outline: none;
        transition: border-color .15s ease;
      }
      .sw-input.mono { font-family: var(--sw-mono); }
      .sw-input:focus { border-color: var(--sw-primary); }
      .sw-field__hint {
        display: block; margin-top: 6px;
        font-size: 11.5px; color: var(--sw-text-faint);
      }
      .sw-field__hint a { color: var(--sw-primary); text-decoration: underline; }
      .sw-field__hint--error { color: var(--sw-danger, #ff6b6b); }
      .sw-fetch-row {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      }
      .sw-fetch-row select { flex: 1; min-width: 180px; }

      .sw-summary {
        margin: 0 0 18px;
        background: rgba(0,0,0,0.25);
        border: 1px solid var(--sw-border);
        border-radius: 10px;
        padding: 6px 14px;
      }
      .sw-summary__row {
        display: flex; justify-content: space-between; gap: 10px;
        padding: 8px 0;
        border-bottom: 1px dashed rgba(255,255,255,0.06);
      }
      .sw-summary__row:last-child { border-bottom: none; }
      .sw-summary dt {
        font-family: var(--sw-mono);
        font-size: 11px; font-weight: 700; letter-spacing: 0.1em;
        color: var(--sw-text-faint); text-transform: uppercase;
      }
      .sw-summary dd {
        font-family: var(--sw-mono);
        font-size: 12.5px; color: var(--text-strong, #fff);
        margin: 0; text-align: right;
      }

      .sw-test {
        display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .sw-test__result {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 6px 12px; border-radius: 999px;
        font-size: 12px; font-weight: 600;
      }
      .sw-test__result.ok {
        background: color-mix(in srgb, #10b981 12%, transparent);
        border: 1px solid color-mix(in srgb, #10b981 35%, transparent);
        color: #34d399;
      }
      .sw-test__result.fail {
        background: color-mix(in srgb, #ef4444 12%, transparent);
        border: 1px solid color-mix(in srgb, #ef4444 35%, transparent);
        color: #fca5a5;
      }
      .sw-test__dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: currentColor;
        box-shadow: 0 0 8px currentColor;
      }

      .sw-footer {
        display: flex; align-items: center; gap: 8px;
        margin-top: 14px;
        padding: 12px 16px;
        background: var(--sw-surface);
        backdrop-filter: blur(18px) saturate(160%);
        -webkit-backdrop-filter: blur(18px) saturate(160%);
        border: 1px solid var(--sw-border);
        border-radius: 12px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
      }
      .sw-btn {
        font-family: var(--sw-mono);
        font-size: 12px; font-weight: 700;
        letter-spacing: 0.1em; text-transform: uppercase;
        padding: 10px 18px; border-radius: 8px;
        border: 1px solid var(--sw-border);
        background: transparent; color: var(--sw-text);
        cursor: pointer;
        transition: background .15s ease, color .15s ease, border-color .15s ease, transform .15s ease;
      }
      .sw-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .sw-btn--primary {
        background: var(--sw-primary);
        color: #000; border-color: var(--sw-primary);
        box-shadow: 0 8px 22px color-mix(in srgb, var(--sw-primary) 28%, transparent);
      }
      .sw-btn--primary:not(:disabled):hover { transform: translateY(-1px); }
      .sw-btn--ghost {
        background: transparent;
        color: var(--sw-text-mute);
      }
      .sw-btn--ghost:not(:disabled):hover {
        color: var(--sw-text);
        border-color: var(--sw-border-strong);
        background: var(--sw-surface);
      }

      .sw-error {
        margin-top: 14px;
        background: color-mix(in srgb, #ef4444 12%, transparent);
        border: 1px solid color-mix(in srgb, #ef4444 35%, transparent);
        border-left: 3px solid #ef4444;
        color: #fca5a5;
        padding: 10px 12px; border-radius: 8px;
        font-family: var(--sw-mono);
        font-size: 12.5px;
        white-space: pre-wrap;
      }

      @media (max-width: 700px) {
        .sw-progress { overflow-x: auto; padding-bottom: 8px; }
        .sw-progress__step { flex-shrink: 0; }
        .sw-progress__line { min-width: 8px; }
        .sw-header { flex-wrap: wrap; }
        .sw-logo { width: 46px; height: 46px; }
        .sw-logo img { width: 30px; height: 30px; }
      }
    </style>
  `;
}
