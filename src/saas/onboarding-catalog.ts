/**
 * Provider catalogue for the SaaS new-member quickstart (BYOK step).
 *
 * The provider SET is derived from the canonical registry
 * (src/agents/known-providers.ts) so onboarding stays 1:1 with InfiniBot: every
 * cloud `category: "model"` entry is offered, local ones (`local: true`, or no
 * env key to bring) are not. Replicate is the one non-model entry included — it
 * hosts image/video models that InfiniBot's media tools use.
 *
 * This file only adds what the registry doesn't carry: a key placeholder, the
 * provider's key page, a cheap AUTHENTICATED check, and (for providers the
 * agent runtime doesn't ship) an OpenAI-compatible endpoint so a tenant can
 * actually chat with them. Zero imports beyond the registry and no I/O, so it
 * can be bundled into test harnesses.
 */
import { KNOWN_PROVIDERS, type KnownProvider } from "../agents/known-providers.js";

/**
 * How a key is checked. Every check must be authenticated — an endpoint that
 * answers 2xx without a key (e.g. ollama.com/api/tags) proves nothing.
 *
 * - `get`: GET `url`; only a 2xx accepts the key (count models from `countField`).
 * - `auth-probe`: POST an empty JSON body to `url`. The provider authenticates
 *   before it validates the body, so 401/403 rejects the key and a 400/422
 *   ("bad request") proves the key got past auth. Nothing is generated or billed.
 */
export type KeyCheck =
  | {
      kind: "get";
      /** A function when the key is part of the URL (Telegram's `/bot<token>/getMe`). */
      url: string | ((key: string) => string);
      headers: (key: string) => Record<string, string>;
      /** POST with no body instead of GET (Slack's `apps.connections.open`). */
      method?: "POST";
      /** Response field holding the model array (`"*"` = the body is the array). */
      countField?: string;
      /** Boolean field that must be `true` (Slack answers a bad token with 200 `{ok:false}`). */
      okField?: string;
      /** Dotted path to a display name for the connected account (`result.username`). */
      accountField?: string;
    }
  | { kind: "auth-probe"; url: string; headers: (key: string) => Record<string, string> };

/** OpenAI-compatible endpoint for providers without a built-in agent runtime. */
export interface ProviderRuntime {
  baseUrl: string;
  api: "openai-completions";
}

export interface OnboardingProviderSpec {
  id: string;
  label: string;
  envKey: string;
  keyHint: string;
  signupUrl: string;
  /** `chat` providers can back the assistant; `media` ones (Replicate) can't. */
  kind: "chat" | "media";
  /** Undefined → key is stored when well-formed and reported as unverified. */
  check?: KeyCheck;
  /** Preferred default model ids, best first. */
  defaultModels: string[];
  /** Set when the agent runtime has no built-in provider for this id. */
  runtime?: ProviderRuntime;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

type ProviderExtras = Omit<OnboardingProviderSpec, "id" | "label" | "envKey" | "kind">;

const EXTRAS: Record<string, ProviderExtras> = {
  anthropic: {
    keyHint: "sk-ant-…",
    signupUrl: "https://console.anthropic.com/settings/keys",
    check: {
      kind: "get",
      url: "https://api.anthropic.com/v1/models?limit=100",
      headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
      countField: "data",
    },
    defaultModels: ["claude-sonnet-4-5", "claude-sonnet-4-0", "claude-haiku-4-5"],
  },
  openai: {
    keyHint: "sk-…",
    signupUrl: "https://platform.openai.com/api-keys",
    check: {
      kind: "get",
      url: "https://api.openai.com/v1/models",
      headers: bearer,
      countField: "data",
    },
    defaultModels: ["gpt-5.1", "gpt-5", "gpt-4o"],
  },
  google: {
    keyHint: "AIza…",
    signupUrl: "https://aistudio.google.com/apikey",
    check: {
      kind: "get",
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      headers: (key) => ({ "x-goog-api-key": key }),
      countField: "models",
    },
    defaultModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
  },
  groq: {
    keyHint: "gsk_…",
    signupUrl: "https://console.groq.com/keys",
    check: {
      kind: "get",
      url: "https://api.groq.com/openai/v1/models",
      headers: bearer,
      countField: "data",
    },
    defaultModels: ["llama-3.3-70b-versatile"],
  },
  together: {
    keyHint: "Together API key",
    signupUrl: "https://api.together.xyz/settings/api-keys",
    check: {
      kind: "get",
      url: "https://api.together.xyz/v1/models",
      headers: bearer,
      countField: "*",
    },
    defaultModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    runtime: { baseUrl: "https://api.together.xyz/v1", api: "openai-completions" },
  },
  deepseek: {
    keyHint: "sk-…",
    signupUrl: "https://platform.deepseek.com/api_keys",
    check: {
      kind: "get",
      url: "https://api.deepseek.com/models",
      headers: bearer,
      countField: "data",
    },
    defaultModels: ["deepseek-chat"],
    runtime: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions" },
  },
  mistral: {
    keyHint: "Mistral API key",
    signupUrl: "https://console.mistral.ai/api-keys",
    check: {
      kind: "get",
      url: "https://api.mistral.ai/v1/models",
      headers: bearer,
      countField: "data",
    },
    defaultModels: ["mistral-large-latest"],
  },
  cohere: {
    keyHint: "Cohere API key",
    signupUrl: "https://dashboard.cohere.com/api-keys",
    check: {
      kind: "get",
      url: "https://api.cohere.com/v1/models?page_size=100",
      headers: bearer,
      countField: "models",
    },
    defaultModels: ["command-a-03-2025"],
    runtime: { baseUrl: "https://api.cohere.ai/compatibility/v1", api: "openai-completions" },
  },
  perplexity: {
    keyHint: "pplx-…",
    signupUrl: "https://www.perplexity.ai/settings/api",
    // No model-listing endpoint: probe chat completions with an empty body.
    check: {
      kind: "auth-probe",
      url: "https://api.perplexity.ai/chat/completions",
      headers: bearer,
    },
    defaultModels: ["sonar-pro", "sonar"],
    runtime: { baseUrl: "https://api.perplexity.ai", api: "openai-completions" },
  },
  fireworks: {
    keyHint: "fw_…",
    signupUrl: "https://fireworks.ai/account/api-keys",
    check: {
      kind: "get",
      url: "https://api.fireworks.ai/inference/v1/models",
      headers: bearer,
      countField: "data",
    },
    defaultModels: ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
    runtime: { baseUrl: "https://api.fireworks.ai/inference/v1", api: "openai-completions" },
  },
  openrouter: {
    keyHint: "sk-or-…",
    signupUrl: "https://openrouter.ai/keys",
    // /models is public on OpenRouter, so validate against the key endpoint.
    check: { kind: "get", url: "https://openrouter.ai/api/v1/key", headers: bearer },
    defaultModels: ["anthropic/claude-sonnet-4.5", "openai/gpt-5", "google/gemini-2.5-flash"],
  },
  xai: {
    keyHint: "xai-…",
    signupUrl: "https://console.x.ai",
    check: { kind: "get", url: "https://api.x.ai/v1/models", headers: bearer, countField: "data" },
    defaultModels: ["grok-4", "grok-3"],
  },
  cerebras: {
    keyHint: "csk-…",
    signupUrl: "https://cloud.cerebras.ai",
    check: {
      kind: "get",
      url: "https://api.cerebras.ai/v1/models",
      headers: bearer,
      countField: "data",
    },
    defaultModels: ["llama-3.3-70b"],
  },
  zai: {
    keyHint: "Z.ai API key",
    signupUrl: "https://z.ai/manage-apikey/apikey-list",
    check: {
      kind: "get",
      url: "https://api.z.ai/api/paas/v4/models",
      headers: bearer,
      countField: "data",
    },
    defaultModels: ["glm-4.6", "glm-4.5"],
  },
  llamacloud: {
    keyHint: "LLM|…",
    signupUrl: "https://llama.developer.meta.com/",
    check: {
      kind: "get",
      url: "https://api.llama.com/compat/v1/models",
      headers: bearer,
      countField: "data",
    },
    defaultModels: ["Llama-4-Maverick-17B-128E-Instruct-FP8"],
  },
  "ollama-cloud": {
    keyHint: "Ollama API key",
    signupUrl: "https://ollama.com/settings/keys",
    // ollama.com/api/tags and /v1/models answer without a key; probe chat instead.
    check: { kind: "auth-probe", url: "https://ollama.com/api/chat", headers: bearer },
    // kimi-k2.5 was retired by Ollama on 2026-07-31 (HTTP 410); gpt-oss:120b matches the gateway catalogue.
    defaultModels: ["gpt-oss:120b", "kimi-k2.6"],
  },
  replicate: {
    keyHint: "r8_…",
    signupUrl: "https://replicate.com/account/api-tokens",
    check: { kind: "get", url: "https://api.replicate.com/v1/account", headers: bearer },
    defaultModels: [],
  },
};

/** Registry entries outside `category: "model"` that the BYOK step still offers. */
const EXTRA_REGISTRY_IDS: readonly string[] = ["replicate"];

/** A provider that runs on the member's machine (or has no key to bring). */
export function isLocalProvider(p: KnownProvider): boolean {
  return ("local" in p && p.local === true) || !p.envKey;
}

function titleOf(label: string): string {
  return label.replace(/\s*\(.*\)\s*$/, "");
}

/** Cloud providers a member can bring their own key for, in registry order. */
export const ONBOARDING_PROVIDERS: OnboardingProviderSpec[] = KNOWN_PROVIDERS.filter(
  (p) => (p.category === "model" || EXTRA_REGISTRY_IDS.includes(p.id)) && !isLocalProvider(p),
).map((p) => {
  const extras = EXTRAS[p.id];
  return {
    id: p.id,
    label: p.label,
    envKey: p.envKey,
    kind: p.category === "model" ? "chat" : "media",
    keyHint: extras?.keyHint ?? "API key",
    signupUrl: extras?.signupUrl ?? "",
    check: extras?.check,
    defaultModels: extras?.defaultModels ?? [],
    runtime: extras?.runtime,
  } satisfies OnboardingProviderSpec;
});

export function getOnboardingProvider(id: unknown): OnboardingProviderSpec | undefined {
  return ONBOARDING_PROVIDERS.find((p) => p.id === id);
}

/** Order used when picking the tenant's default model: the big four, then registry order. */
export const DEFAULT_MODEL_PRIORITY: string[] = [
  "anthropic",
  "openai",
  "openrouter",
  "google",
  ...ONBOARDING_PROVIDERS.map((p) => p.id).filter(
    (id) => !["anthropic", "openai", "openrouter", "google"].includes(id),
  ),
];

/** Short display title (registry label without the parenthetical). */
export function onboardingProviderTitle(p: { label: string }): string {
  return titleOf(p.label);
}

// ── Cloud voice ────────────────────────────────────────────────────────────

/** Voice output (TTS). OpenAI reuses the member's OpenAI model key. */
export type OnboardingTtsId = "openai" | "elevenlabs" | "cartesia";
/** Speech recognition (STT). OpenAI/Groq reuse the matching model key. */
export type OnboardingSttId = "openai" | "groq" | "deepgram";

export interface OnboardingVoiceSpec<Id extends string> {
  id: Id;
  label: string;
  /** Model provider whose saved key this voice provider reuses. */
  reusesKeyOf?: string;
  needsOwnKey: boolean;
  keyHint?: string;
  signupUrl?: string;
  voices: string[];
  check?: KeyCheck;
}

export const ONBOARDING_VOICE_PROVIDERS: OnboardingVoiceSpec<OnboardingTtsId>[] = [
  {
    id: "openai",
    label: "OpenAI voice",
    reusesKeyOf: "openai",
    needsOwnKey: false,
    voices: ["alloy", "echo", "fable", "nova", "onyx", "shimmer"],
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    needsOwnKey: true,
    keyHint: "xi-…",
    signupUrl: "https://elevenlabs.io/app/settings/api-keys",
    voices: ["onwK4e9ZLuTAKqWW03F9"],
    check: {
      kind: "get",
      url: "https://api.elevenlabs.io/v1/user",
      headers: (key) => ({ "xi-api-key": key }),
    },
  },
  {
    id: "cartesia",
    label: "Cartesia",
    needsOwnKey: true,
    keyHint: "sk_car_…",
    signupUrl: "https://play.cartesia.ai/keys",
    // The Cartesia adapter's default voice (src/gateway/voice/providers/cartesia-tts.ts).
    voices: ["a0e99841-438c-4a64-b679-ae501e7d6091"],
    check: {
      kind: "get",
      url: "https://api.cartesia.ai/voices",
      headers: (key) => ({ "X-API-Key": key, "Cartesia-Version": "2024-06-10" }),
    },
  },
];

export const ONBOARDING_STT_PROVIDERS: OnboardingVoiceSpec<OnboardingSttId>[] = [
  { id: "openai", label: "OpenAI Whisper", reusesKeyOf: "openai", needsOwnKey: false, voices: [] },
  { id: "groq", label: "Groq Whisper", reusesKeyOf: "groq", needsOwnKey: false, voices: [] },
  {
    id: "deepgram",
    label: "Deepgram",
    needsOwnKey: true,
    keyHint: "Deepgram API key",
    signupUrl: "https://console.deepgram.com/",
    voices: [],
    check: {
      kind: "get",
      url: "https://api.deepgram.com/v1/projects",
      headers: (key) => ({ Authorization: `Token ${key}` }),
    },
  },
];

export const STT_DEFAULT_MODELS: Record<OnboardingSttId, string> = {
  openai: "whisper-1",
  groq: "whisper-large-v3-turbo",
  deepgram: "nova-2",
};
