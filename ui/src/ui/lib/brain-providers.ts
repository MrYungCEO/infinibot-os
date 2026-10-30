/**
 * Cloud providers offered on the onboarding "brain" step (bring your own key).
 *
 * Derived from the shared catalogue (src/saas/onboarding-catalog.ts, itself
 * built on src/agents/known-providers.ts) so this list can't drift from the
 * API Keys page, SaaS onboarding or the gateway again. The 2026-10-16
 * onboarding shipped a hand-written list of five and silently dropped Ollama
 * Cloud, which is the built-in fallback and the owner's main provider.
 *
 * `featured` providers are shown as cards; the rest sit under "More providers".
 */
import { OLLAMA_CLOUD_DEFAULT_MODEL_ID } from "../../../../src/agents/provider-model-defaults.js";
import {
  ONBOARDING_PROVIDERS,
  onboardingProviderTitle,
  type ProviderRuntime,
} from "../../../../src/saas/onboarding-catalog.js";

export interface BrainProvider {
  /** Catalogue id: the auth profile provider, the model-ref prefix and the fetchModels id. */
  id: string;
  label: string;
  sub: string;
  /** Default model id (without the provider prefix). */
  model: string;
  placeholder: string;
  keyUrl: string;
  featured: boolean;
  badge?: string;
  /** OpenAI-compatible endpoint for providers the agent runtime doesn't ship. */
  runtime?: ProviderRuntime;
}

/** Card order on the brain step. Ollama Cloud first: best value, and the built-in fallback. */
export const FEATURED_BRAIN_PROVIDER_IDS = [
  "ollama-cloud",
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "groq",
] as const;

const OVERRIDES: Record<string, Partial<Pick<BrainProvider, "label" | "sub" | "model" | "placeholder" | "badge">>> = {
  "ollama-cloud": {
    label: "Ollama Cloud",
    sub: "Big open models (GPT-OSS, GLM, Kimi), low prices",
    model: OLLAMA_CLOUD_DEFAULT_MODEL_ID,
    placeholder: "Ollama API key",
    badge: "Best value",
  },
  openrouter: { sub: "One key, hundreds of models, some free", model: "anthropic/claude-sonnet-4.5", placeholder: "sk-or-…" },
  anthropic: { sub: "Claude", model: "claude-sonnet-4-6", placeholder: "sk-ant-…" },
  openai: { sub: "GPT", model: "gpt-4o", placeholder: "sk-…" },
  // No fixed model: the live list picks the newest GA Flash (gemini-2.0-flash was retired).
  google: { label: "Google", sub: "Gemini, has a free tier", model: "", placeholder: "AIza…" },
  groq: { sub: "Very fast open models, free tier", model: "llama-3.3-70b-versatile", placeholder: "gsk_…" },
};

function build(): BrainProvider[] {
  const featured = FEATURED_BRAIN_PROVIDER_IDS as readonly string[];
  const rows = ONBOARDING_PROVIDERS.filter((p) => p.kind === "chat").map((p): BrainProvider => {
    const o = OVERRIDES[p.id] ?? {};
    return {
      id: p.id,
      label: o.label ?? onboardingProviderTitle(p),
      sub: o.sub ?? "",
      model: o.model !== undefined ? o.model : (p.defaultModels[0] ?? ""),
      placeholder: o.placeholder ?? p.keyHint,
      keyUrl: p.signupUrl,
      featured: featured.includes(p.id),
      badge: o.badge,
      runtime: p.runtime,
    };
  });
  const rank = (id: string) => (featured.includes(id) ? featured.indexOf(id) : featured.length);
  return [...rows].sort((a, b) => rank(a.id) - rank(b.id));
}

export const BRAIN_PROVIDERS: readonly BrainProvider[] = build();

export function getBrainProvider(id: string): BrainProvider | undefined {
  return BRAIN_PROVIDERS.find((p) => p.id === id);
}

/** `provider/model` ref saved as the primary model. Model ids may contain "/" (OpenRouter, Together). */
export function brainModelRef(p: Pick<BrainProvider, "id">, model: string): string {
  const m = model.trim();
  return m.startsWith(`${p.id}/`) ? m : `${p.id}/${m}`;
}

/**
 * Config patch registering an OpenAI-compatible provider the runtime doesn't
 * ship (Together, DeepSeek, …) so the saved primary model resolves. The key
 * stays in the auth profile store. Null for built-in providers.
 */
export function brainRuntimePatch(p: BrainProvider, model: string, existingModelIds: string[] = []): object | null {
  if (!p.runtime) return null;
  const ids = [...new Set([...existingModelIds, model.trim()].filter(Boolean))];
  return {
    models: {
      providers: {
        [p.id]: {
          baseUrl: p.runtime.baseUrl,
          api: p.runtime.api,
          models: ids.map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8192,
          })),
        },
      },
    },
  };
}

/** One row of the live model picker (from `quickstart.providers.fetchModels`). */
export interface BrainModelOption {
  id: string;
  label?: string;
  free?: boolean;
}

/** Normalise the fetchModels payload (objects or bare ids). */
export function toModelOptions(models: Array<{ id: string; label?: string; free?: boolean } | string> | undefined): BrainModelOption[] {
  return (models ?? [])
    .map((m) => (typeof m === "string" ? { id: m } : { id: m.id, label: m.label, free: m.free === true }))
    .filter((m) => Boolean(m.id))
    .slice(0, 600);
}

type Rpc = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

/**
 * Save a BYOK provider as the assistant's brain: key → auth profile store
 * (`<id>:default`, what the runtime and API Keys page read), primary model →
 * `voice.setup.brain`, and for runtime-less providers their endpoint via
 * `config.patch`. Returns the saved `provider/model` ref.
 */
export async function saveBrainProvider(rpc: Rpc, p: BrainProvider, key: string, model: string): Promise<string> {
  const m = (model || p.model).trim();
  await rpc("auth.profiles.upsert", { profileId: `${p.id}:default`, provider: p.id, type: "api_key", key: key.trim() });
  const ref = brainModelRef(p, m);
  await rpc("voice.setup.brain", { provider: "cloud", modelId: ref });
  if (p.runtime) {
    const snap = await rpc<{
      hash?: string;
      config?: { models?: { providers?: Record<string, { models?: Array<{ id?: string }> }> } };
    }>("config.get", {});
    const existing = (snap?.config?.models?.providers?.[p.id]?.models ?? []).map((x) => x.id ?? "").filter(Boolean);
    const patch = brainRuntimePatch(p, m, existing);
    if (patch && snap?.hash) await rpc("config.patch", { raw: JSON.stringify(patch), baseHash: snap.hash });
  }
  return ref;
}

/**
 * Store a BYOK key WITHOUT changing the assistant's primary model (the Voice
 * page's "Add key": the key becomes usable for the voice brain only). Writes
 * the `<id>:default` auth profile and, for runtime-less providers, registers
 * the endpoint + model via `config.patch`. Returns the `provider/model` ref.
 */
export async function saveBrainKey(rpc: Rpc, p: BrainProvider, key: string, model: string): Promise<string> {
  const m = (model || p.model).trim();
  await rpc("auth.profiles.upsert", { profileId: `${p.id}:default`, provider: p.id, type: "api_key", key: key.trim() });
  if (p.runtime) {
    const snap = await rpc<{
      hash?: string;
      config?: { models?: { providers?: Record<string, { models?: Array<{ id?: string }> }> } };
    }>("config.get", {});
    const existing = (snap?.config?.models?.providers?.[p.id]?.models ?? []).map((x) => x.id ?? "").filter(Boolean);
    const patch = brainRuntimePatch(p, m, existing);
    if (patch && snap?.hash) await rpc("config.patch", { raw: JSON.stringify(patch), baseHash: snap.hash });
  }
  return brainModelRef(p, m);
}
