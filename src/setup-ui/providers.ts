/**
 * Model providers offered by the local setup wizard, and the config each one
 * writes.
 *
 * The list is the BYOK catalog the hosted quickstart uses
 * (src/saas/onboarding-catalog.ts: same labels, key hints and authenticated
 * key checks) plus local Ollama. What gets written matches the legacy
 * wizard's canonical path: `models.providers.<id>` with baseUrl + api + a
 * model entry (the models schema requires them, or the agent loop fails on
 * its first turn) and `agents.defaults.model.primary = "<id>/<model>"`.
 */
import { OLLAMA_CLOUD_DEFAULT_MODEL_ID } from "../agents/provider-model-defaults.js";
import { maskKey } from "../saas/key-validation.js";
import { ONBOARDING_PROVIDERS } from "../saas/onboarding-catalog.js";

type Runtime = { baseUrl: string; api: string; defaultModel: string };

/** Endpoint + API dialect per provider (mirrors the legacy wizard's PROV_CATALOG). */
const RUNTIME: Record<string, Runtime> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic-messages",
    defaultModel: "claude-opus-4-7",
  },
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", defaultModel: "gpt-4o" },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    api: "openai-completions",
    defaultModel: "gemini-2.5-pro",
  },
  "ollama-cloud": {
    baseUrl: "https://ollama.com/v1",
    api: "openai-completions",
    defaultModel: OLLAMA_CLOUD_DEFAULT_MODEL_ID,
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    api: "openai-completions",
    defaultModel: "mistral-large-latest",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai-completions",
    defaultModel: "llama-3.3-70b-versatile",
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    api: "openai-completions",
    defaultModel: "llama-3.3-70b",
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    api: "openai-completions",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    defaultModel: "openrouter/auto",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    defaultModel: "deepseek-chat",
  },
  xai: { baseUrl: "https://api.x.ai/v1", api: "openai-completions", defaultModel: "grok-2-latest" },
  zai: {
    baseUrl: "https://api.z.ai/api/paas/v4",
    api: "openai-completions",
    defaultModel: "glm-4.5",
  },
  cohere: {
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    api: "openai-completions",
    defaultModel: "command-r-plus",
  },
  perplexity: {
    baseUrl: "https://api.perplexity.ai",
    api: "openai-completions",
    defaultModel: "sonar",
  },
  fireworks: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    api: "openai-completions",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  },
  llamacloud: {
    baseUrl: "https://api.llama.com/compat/v1",
    api: "openai-completions",
    defaultModel: "Llama-4-Maverick-17B-128E-Instruct-FP8",
  },
  ollama: {
    baseUrl: "http://localhost:11434",
    api: "openai-completions",
    defaultModel: "llama3.2",
  },
};

/** Shown first, in this order: the big three, then Ollama Cloud (a common no-GPU pick). */
const LEAD = ["anthropic", "openai", "google", "ollama-cloud"];

export type SetupProvider = {
  id: string;
  label: string;
  keyHint: string;
  signupUrl: string;
  /** `local` runs on this machine and needs no key. */
  kind: "chat" | "local";
  /** False when the provider has no authenticated key check. */
  verifiable: boolean;
  configured: boolean;
  maskedKey: string | null;
};

export function setupProviderIds(): string[] {
  const chat = ONBOARDING_PROVIDERS.filter((p) => p.kind === "chat" && RUNTIME[p.id]).map(
    (p) => p.id,
  );
  const lead = LEAD.filter((id) => chat.includes(id));
  return [...lead, ...chat.filter((id) => !lead.includes(id)), "ollama"];
}

export function listSetupProviders(config: Record<string, unknown>): SetupProvider[] {
  const configured = ((
    config.models as
      | { providers?: Record<string, { apiKey?: unknown; baseUrl?: unknown }> }
      | undefined
  )?.providers ?? {}) as Record<string, { apiKey?: unknown; baseUrl?: unknown }>;
  return setupProviderIds().map((id) => {
    const entry = configured[id];
    const key = typeof entry?.apiKey === "string" ? entry.apiKey : "";
    if (id === "ollama") {
      return {
        id,
        label: "Ollama (local)",
        keyHint: "http://localhost:11434",
        signupUrl: "https://ollama.com/download",
        kind: "local",
        verifiable: true,
        configured: Boolean(entry),
        maskedKey: entry && typeof entry.baseUrl === "string" ? entry.baseUrl : null,
      };
    }
    const spec = ONBOARDING_PROVIDERS.find((p) => p.id === id)!;
    return {
      id,
      label: spec.label,
      keyHint: spec.keyHint,
      signupUrl: spec.signupUrl,
      kind: "chat",
      verifiable: Boolean(spec.check),
      configured: Boolean(key),
      maskedKey: key ? maskKey(key) : null,
    };
  });
}

/** Default model: the catalog's curated pick (shared with the hosted quickstart), else ours. */
export function defaultModelFor(provider: string): string {
  const spec = ONBOARDING_PROVIDERS.find((p) => p.id === provider);
  return spec?.defaultModels[0] ?? RUNTIME[provider]?.defaultModel ?? "";
}

/** The config patch for a verified key (or a local Ollama host). */
export function buildProviderPatch(input: {
  provider: string;
  apiKey?: string;
  endpoint?: string;
  model?: string;
  /** Leave an existing primary model alone (adding a second provider). */
  keepPrimary?: boolean;
}): Record<string, unknown> {
  const rt = RUNTIME[input.provider];
  if (!rt) throw new Error(`Unsupported provider: ${input.provider}`);
  const model = input.model?.trim() || defaultModelFor(input.provider);
  const baseUrl = input.endpoint?.trim().replace(/\/$/, "") || rt.baseUrl;
  const providerCfg: Record<string, unknown> = {
    baseUrl,
    api: rt.api,
    models: [
      {
        id: model,
        name: model,
        api: rt.api,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  };
  if (input.apiKey?.trim()) providerCfg.apiKey = input.apiKey.trim();
  return {
    models: { providers: { [input.provider]: providerCfg } },
    ...(input.keepPrimary
      ? {}
      : { agents: { defaults: { model: { primary: `${input.provider}/${model}` } } } }),
  };
}
