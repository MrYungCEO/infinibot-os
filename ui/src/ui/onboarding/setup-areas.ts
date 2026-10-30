/**
 * Setup › Your setup: one card per onboarding area with its current value and
 * an Edit button that opens just that step (<ib-onboarding-flow editStep>).
 *
 * Also the shared helpers the flow uses while editing:
 *   - stepFromParam: /setup?step=voice deep links (aliases accepted)
 *   - patchConfigLive: config.patch without a forced gateway restart, reporting
 *     whether the change still needs one (older gateways: plain config.patch)
 *   - the close event every "go somewhere else" button fires so the Setup page
 *     closes the full-screen flow before the app routes away.
 */
import type { StepId } from "./profile";
import { USE_CASES, type UseCaseId } from "./use-cases";

export type EditableStep = Exclude<StepId, "finish">;

export interface SetupArea {
  id: EditableStep;
  label: string;
  icon: string;
  /** Plain words about what saving does to the running gateway. */
  applies: string;
}

export const SETUP_AREAS: readonly SetupArea[] = [
  { id: "usecases", label: "Goals", icon: "target", applies: "Applies right away." },
  { id: "model", label: "AI brain", icon: "brain", applies: "Applies right away, no restart." },
  { id: "channels", label: "Channels", icon: "messageSquare", applies: "Telegram and WhatsApp connect right away. Adding a first Discord bot restarts InfiniBot for a few seconds." },
  { id: "voice", label: "Voice", icon: "mic", applies: "Applies right away, no restart." },
  { id: "phone", label: "Phone & remote access", icon: "smartphone", applies: "Applies right away, no restart." },
  { id: "browser", label: "Your browser", icon: "globe", applies: "Applies right away, no restart." },
  { id: "aiapps", label: "AI apps (MCP)", icon: "plug", applies: "Each app picks it up the next time it starts." },
  { id: "kinglyvault", label: "KinglyVault", icon: "crown", applies: "Applies right away, no restart." },
  { id: "privacy", label: "Privacy · Secure Mode", icon: "lock", applies: "Applies right away, no restart." },
  { id: "recommend", label: "Plan · plugins", icon: "puzzle", applies: "Turning plugins on or off restarts InfiniBot for a few seconds." },
];

const ALIASES: Record<string, EditableStep> = {
  goals: "usecases",
  usecases: "usecases",
  "use-cases": "usecases",
  brain: "model",
  model: "model",
  ai: "model",
  provider: "model",
  channels: "channels",
  channel: "channels",
  voice: "voice",
  phone: "phone",
  remote: "phone",
  tailscale: "phone",
  browser: "browser",
  chrome: "browser",
  extension: "browser",
  aiapps: "aiapps",
  "ai-apps": "aiapps",
  mcp: "aiapps",
  kinglyvault: "kinglyvault",
  kv: "kinglyvault",
  privacy: "privacy",
  secure: "privacy",
  "secure-mode": "privacy",
  plan: "recommend",
  plugins: "recommend",
  recommend: "recommend",
};

/** `?step=` value → the step it edits (null for anything unknown). */
export function stepFromParam(v: string | null | undefined): EditableStep | null {
  if (!v) return null;
  return ALIASES[v.trim().toLowerCase()] ?? null;
}

/** The `?step=` name used in URLs for a step. */
export function paramForStep(step: EditableStep): string {
  return step === "usecases" ? "goals" : step === "model" ? "brain" : step === "recommend" ? "plan" : step === "aiapps" ? "mcp" : step;
}

export function areaFor(step: StepId): SetupArea | null {
  return SETUP_AREAS.find((a) => a.id === step) ?? null;
}

// ── live config writes ──────────────────────────────────────────────────

type Rpc = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

export interface LivePatchResult {
  restartRequired: boolean;
  /** Config keys that need the restart (empty when it applied live). */
  reasons: string[];
  /** The gateway is too old for restart:"auto"; it restarted to apply. */
  legacy: boolean;
}

/**
 * Merge `patch` into the config with no forced restart: the gateway applies it
 * by its reload rules and says whether a restart is still needed. A gateway
 * without `restart: "auto"` rejects the param; then the plain patch runs
 * (which restarts) and the result says so.
 */
export async function patchConfigLive(rpc: Rpc, patch: Record<string, unknown>): Promise<LivePatchResult> {
  const snap = await rpc<{ hash?: string }>("config.get", {});
  const raw = JSON.stringify(patch);
  try {
    const res = await rpc<{ reload?: { restartRequired?: boolean; restartReasons?: string[] } }>("config.patch", {
      raw,
      baseHash: snap?.hash,
      restart: "auto",
    });
    return {
      restartRequired: Boolean(res?.reload?.restartRequired),
      reasons: res?.reload?.restartReasons ?? [],
      legacy: !res?.reload,
    };
  } catch (err) {
    if (!/invalid config\.patch params/i.test(String((err as Error)?.message ?? err))) throw err;
    await rpc("config.patch", { raw, baseHash: snap?.hash });
    return { restartRequired: true, reasons: [], legacy: true };
  }
}

/** One plain sentence about how a saved change reached the gateway. */
export function describeApply(r: LivePatchResult, what = "Saved"): string {
  if (!r.restartRequired) return `${what}. Applied live, no restart needed.`;
  if (r.legacy) return `${what}. InfiniBot restarts for a few seconds to apply it.`;
  return `${what}. InfiniBot restarts for a few seconds to apply it (${r.reasons.slice(0, 3).join(", ")}).`;
}

// ── closing the flow before navigating ──────────────────────────────────

/** Fired by the flow right before it routes elsewhere; Setup closes it. */
export const ONBOARDING_CLOSE_EVENT = "infinibot:onboarding-close";
/** Fired by the flow when an edit is saved or cancelled (detail: EditDoneDetail). */
export const SETUP_EDIT_DONE_EVENT = "infinibot:setup-edit-done";

export interface EditDoneDetail {
  step: EditableStep;
  saved: boolean;
  message?: string;
}

// ── summary values ──────────────────────────────────────────────────────

export interface SetupSnapshot {
  useCases?: UseCaseId[] | null;
  brain?: { primary?: string | null; account?: string | null } | null;
  channels?: Record<string, { configured?: boolean; connected?: boolean; linked?: boolean; running?: boolean }> | null;
  channelLabels?: Record<string, string> | null;
  voice?: { backend?: string | null; ttsReachable?: boolean; sttReachable?: boolean; choice?: "local" | "cloud" | "later" | null } | null;
  phone?: { url?: string | null; tailscale?: boolean; loggedIn?: boolean } | null;
  browser?: { paired: boolean; connected: boolean; name?: string | null } | null;
  aiapps?: { added: string[] } | null;
  /** KinglyVault Connect (kinglyvault-relay); off = plugin turned off. */
  kinglyvault?: { connected: boolean; account?: string | null; off?: boolean } | null;
  secure?: { enabled: boolean; available: boolean } | null;
  plugins?: { enabled: string[]; names?: Record<string, string> } | null;
}

export interface AreaSummary {
  id: EditableStep;
  value: string;
  /** "ok" = set up, "off" = not set up / off, "unknown" = couldn't read it. */
  state: "ok" | "off" | "unknown";
}

function list(items: string[], max = 3): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

/** Card values for every area (pure, so it's unit-tested). */
export function summarizeSetup(s: SetupSnapshot): AreaSummary[] {
  const out: AreaSummary[] = [];
  // Goals
  if (s.useCases === undefined || s.useCases === null) out.push({ id: "usecases", value: "Not read yet", state: "unknown" });
  else if (!s.useCases.length) out.push({ id: "usecases", value: "General (nothing picked)", state: "off" });
  else out.push({ id: "usecases", value: list(s.useCases.map((id) => USE_CASES.find((u) => u.id === id)?.title ?? id)), state: "ok" });
  // Brain
  if (!s.brain) out.push({ id: "model", value: "Couldn't read the model", state: "unknown" });
  else if (s.brain.account) out.push({ id: "model", value: `Your ${s.brain.account}`, state: "ok" });
  else if (s.brain.primary) out.push({ id: "model", value: s.brain.primary, state: "ok" });
  else out.push({ id: "model", value: "No model picked", state: "off" });
  // Channels
  if (!s.channels) out.push({ id: "channels", value: "This app", state: "unknown" });
  else {
    const on = Object.entries(s.channels)
      .filter(([, c]) => c?.configured || c?.connected || c?.linked)
      .map(([id]) => s.channelLabels?.[id] ?? id);
    out.push({ id: "channels", value: on.length ? `This app + ${list(on)}` : "This app only", state: on.length ? "ok" : "off" });
  }
  // Voice
  const v = s.voice;
  if (!v) out.push({ id: "voice", value: "Couldn't read voice", state: "unknown" });
  else if (v.backend === "robovoice") out.push({ id: "voice", value: "Cloud voice (Robovoice)", state: "ok" });
  else if (v.ttsReachable || v.sttReachable) out.push({ id: "voice", value: "Local voice, running", state: "ok" });
  else if (v.choice === "later") out.push({ id: "voice", value: "Off (set up later)", state: "off" });
  else out.push({ id: "voice", value: "Local voice, not set up yet", state: "off" });
  // Phone
  const ph = s.phone;
  if (!ph) out.push({ id: "phone", value: "Couldn't read remote access", state: "unknown" });
  else if (ph.url) out.push({ id: "phone", value: ph.url.replace(/^https?:\/\//, ""), state: "ok" });
  else out.push({ id: "phone", value: ph.tailscale === false ? "Off (Tailscale not installed)" : "Off (no private link yet)", state: "off" });
  // Browser
  const br = s.browser;
  if (!br) out.push({ id: "browser", value: "Couldn't read the browser", state: "unknown" });
  else if (br.connected) out.push({ id: "browser", value: `Chrome connected${br.name ? ` (${br.name})` : ""}`, state: "ok" });
  else if (br.paired) out.push({ id: "browser", value: "Paired, Chrome not open right now", state: "off" });
  else out.push({ id: "browser", value: "Not connected yet", state: "off" });
  // AI apps
  const ai = s.aiapps;
  if (!ai) out.push({ id: "aiapps", value: "Not checked yet", state: "unknown" });
  else if (!ai.added.length) out.push({ id: "aiapps", value: "Not added to any app yet", state: "off" });
  else out.push({ id: "aiapps", value: `Added to ${list(ai.added)}`, state: "ok" });
  // KinglyVault
  const kv = s.kinglyvault;
  if (!kv) out.push({ id: "kinglyvault", value: "Couldn't read KinglyVault", state: "unknown" });
  else if (kv.off) out.push({ id: "kinglyvault", value: "KinglyVault Connect is turned off", state: "off" });
  else if (kv.connected) out.push({ id: "kinglyvault", value: `Connected${kv.account ? ` as ${kv.account}` : ""}`, state: "ok" });
  else out.push({ id: "kinglyvault", value: "Not connected (optional)", state: "off" });
  // Privacy
  if (!s.secure) out.push({ id: "privacy", value: "Couldn't read Secure Mode", state: "unknown" });
  else if (!s.secure.available) out.push({ id: "privacy", value: "Not available on this InfiniBot", state: "off" });
  else out.push({ id: "privacy", value: s.secure.enabled ? "Secure Mode on" : "Secure Mode off", state: s.secure.enabled ? "ok" : "off" });
  // Plan
  const pl = s.plugins;
  if (!pl) out.push({ id: "recommend", value: "Couldn't read plugins", state: "unknown" });
  else if (!pl.enabled.length) out.push({ id: "recommend", value: "No plugins on", state: "off" });
  else out.push({ id: "recommend", value: `${pl.enabled.length} on: ${list(pl.enabled.map((id) => pl.names?.[id] ?? id))}`, state: "ok" });
  return out;
}
