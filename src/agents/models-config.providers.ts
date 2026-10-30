import type { InfinibotConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  DEFAULT_COPILOT_API_BASE_URL,
  resolveCopilotApiToken,
} from "../providers/github-copilot-token.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";
import { resolveAwsSdkEnvVarName, resolveEnvApiKey } from "./model-auth.js";
import { localProvidersEnabled } from "../saas/config.js";
import { discoverBedrockModels } from "./bedrock-discovery.js";
import {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_MODEL_CATALOG,
} from "./synthetic-models.js";
import { discoverVeniceModels, VENICE_BASE_URL } from "./venice-models.js";
import { OLLAMA_CLOUD_DEFAULT_MODEL_ID } from "./provider-model-defaults.js";

type ModelsConfig = NonNullable<InfinibotConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.1";
const MINIMAX_DEFAULT_VISION_MODEL_ID = "MiniMax-VL-01";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 200000;
const MINIMAX_DEFAULT_MAX_TOKENS = 8192;
// Pricing: MiniMax doesn't publish public rates. Override in models.json for accurate costs.
const MINIMAX_API_COST = {
  input: 15,
  output: 60,
  cacheRead: 2,
  cacheWrite: 10,
};

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2-0905-preview";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256000;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
const MOONSHOT_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_CODE_MODEL_ID = "kimi-for-coding";
const KIMI_CODE_CONTEXT_WINDOW = 262144;
const KIMI_CODE_MAX_TOKENS = 32768;
const KIMI_CODE_HEADERS = { "User-Agent": "KimiCLI/0.77" } as const;
const KIMI_CODE_COMPAT = { supportsDeveloperRole: false } as const;
const KIMI_CODE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const QWEN_PORTAL_BASE_URL = "https://portal.qwen.ai/v1";
const QWEN_PORTAL_OAUTH_PLACEHOLDER = "qwen-oauth";
const QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW = 128000;
const QWEN_PORTAL_DEFAULT_MAX_TOKENS = 8192;
const QWEN_PORTAL_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const OLLAMA_API_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
const OLLAMA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";
const OLLAMA_CLOUD_API_BASE_URL = "https://ollama.com";
const OLLAMA_CLOUD_DEFAULT_CONTEXT_WINDOW = 128000;
const OLLAMA_CLOUD_DEFAULT_MAX_TOKENS = 8192;
// Ollama Cloud (Turbo) pricing is not metered per-token at the API level
// (subscription-based). Leave at 0 so InfiniBot's cost tracker doesn't
// fabricate fake numbers; override in models.json if you want budget alerts.
const OLLAMA_CLOUD_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
// Known Turbo models (2026-09 catalog). Used as a fallback when /api/tags can't
// be reached (offline, rate-limit, key revoked) so the provider still
// registers with *something* selectable. Live catalog is fetched first.
// Never list retired ids here (kimi-k2.5 → HTTP 410 since 2026-07-31).
const OLLAMA_CLOUD_FALLBACK_MODELS = [
  OLLAMA_CLOUD_DEFAULT_MODEL_ID,
  "gpt-oss:20b",
  "glm-5.2",
  "kimi-k2.6",
  "minimax-m2.7",
] as const;

// ─────── LlamaCloud (Meta Llama API) ───────
// Meta's hosted Llama API exposes an OpenAI-compatible surface at
// https://api.llama.com/compat/v1. We register it as the "llamacloud"
// provider so a single LLAMACLOUD_API_KEY (or auth profile) lights up the
// full Llama 4 / 3.3 catalog in every model picker. Live catalog is fetched
// from /models first; the curated fallback below keeps the provider usable
// offline or when the key can't reach the discovery endpoint.
const LLAMACLOUD_BASE_URL = "https://api.llama.com/compat/v1";
const LLAMACLOUD_DEFAULT_CONTEXT_WINDOW = 128000;
const LLAMACLOUD_DEFAULT_MAX_TOKENS = 8192;
// Llama API is metered per-token but Meta has not published stable public
// rates; leave at 0 so the cost tracker doesn't fabricate numbers. Override
// in models.json for budget alerts.
const LLAMACLOUD_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
// Curated catalog with capability metadata (vision via `input`, reasoning).
// Used as the discovery fallback and to enrich live-discovered ids with the
// right modality flags so the picker capability filters work out of the box.
const LLAMACLOUD_MODEL_CATALOG: ReadonlyArray<{
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
}> = [
  {
    id: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    name: "Llama 4 Maverick (17B·128E)",
    reasoning: true,
    vision: true,
    contextWindow: 1_000_000,
  },
  {
    id: "Llama-4-Scout-17B-16E-Instruct-FP8",
    name: "Llama 4 Scout (17B·16E)",
    reasoning: true,
    vision: true,
    contextWindow: 1_000_000,
  },
  {
    id: "Llama-3.3-70B-Instruct",
    name: "Llama 3.3 70B Instruct",
    reasoning: false,
    vision: false,
    contextWindow: 128_000,
  },
  {
    id: "Llama-3.3-8B-Instruct",
    name: "Llama 3.3 8B Instruct",
    reasoning: false,
    vision: false,
    contextWindow: 128_000,
  },
];
const LLAMACLOUD_DEFAULT_MODEL_ID = "Llama-4-Maverick-17B-128E-Instruct-FP8";

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
  };
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

interface OllamaPsResponse {
  models?: Array<{ name?: string; model?: string; context_length?: number }>;
}

// Ollama's OpenAI-compatible /v1 endpoint always runs at the SERVER's context
// length (we deliberately never send num_ctx — a different value reloads the
// model). Past that length Ollama silently front-truncates the prompt, so the
// system prompt and tool schemas are the first thing lost. Budget against the
// real runtime context, not the model's trained maximum.
const OLLAMA_FALLBACK_RUNTIME_CONTEXT = 32_768;
const OLLAMA_MIN_CONTEXT_WINDOW = 16_000;

/**
 * Runtime context per loaded model from /api/ps, plus a server-wide guess
 * (the smallest loaded context) for models that aren't loaded right now.
 */
export async function probeOllamaRuntimeContext(
  apiBaseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ byModel: Map<string, number>; server?: number }> {
  const byModel = new Map<string, number>();
  try {
    const res = await fetchFn(`${apiBaseUrl}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { byModel };
    const data = (await res.json()) as OllamaPsResponse;
    let server: number | undefined;
    for (const m of data.models ?? []) {
      const ctx = m.context_length;
      if (typeof ctx !== "number" || !Number.isFinite(ctx) || ctx <= 0) continue;
      for (const id of [m.name, m.model]) if (id) byModel.set(id, ctx);
      server = server === undefined ? ctx : Math.min(server, ctx);
    }
    return { byModel, server };
  } catch {
    return { byModel };
  }
}

export function resolveOllamaContextWindow(
  modelId: string,
  runtime: { byModel: Map<string, number>; server?: number },
): number {
  const ctx = runtime.byModel.get(modelId) ?? runtime.server ?? OLLAMA_FALLBACK_RUNTIME_CONTEXT;
  // Never below the runner's hard minimum: a tiny server default (old Ollama
  // ran at 4k) would otherwise block the model outright instead of running
  // with tighter compaction.
  return Math.max(OLLAMA_MIN_CONTEXT_WINDOW, Math.min(OLLAMA_DEFAULT_CONTEXT_WINDOW, ctx));
}

// Turn a raw Ollama tag like "huihui_ai/qwen3.5-abliterated:35b" into a
// human label like "Qwen3.5 35B" for the model picker. Drops the namespace,
// the "abliterated"/"uncensored" marker (re-added by the caller), and tidies
// the :tag size suffix.
function friendlyOllamaBaseName(modelId: string): string {
  const noNamespace = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  const [base, tag] = noNamespace.split(":");
  const cleanedBase = base
    .replace(/[-_]?(abliterated|uncensored)/gi, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const pretty = cleanedBase.replace(/\b\w/g, (c) => c.toUpperCase());
  const size = tag && tag !== "latest" ? ` ${tag.toUpperCase()}` : "";
  return `${pretty}${size}`.trim() || modelId;
}

/**
 * Resolve the base URL for the local Ollama daemon. Honors the standard
 * `OLLAMA_HOST` env var (Ollama's own convention — may be a bare `host:port`,
 * `host`, or a full URL) and an explicitly configured base URL, falling back
 * to the documented default. Returns a normalized origin with no trailing
 * slash and no `/v1` suffix (the `/api/tags` path is appended by the caller).
 */
function resolveOllamaApiBaseUrl(configuredBaseUrl?: string): string {
  const candidate = (configuredBaseUrl ?? process.env.OLLAMA_HOST ?? "").trim();
  if (!candidate) return OLLAMA_API_BASE_URL;
  // Accept bare host[:port] (no scheme) — Ollama's OLLAMA_HOST often omits it.
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
  try {
    const url = new URL(withScheme);
    // Strip a trailing /v1 (the OpenAI-compat base) so /api/tags resolves.
    return `${url.origin}`;
  } catch {
    return OLLAMA_API_BASE_URL;
  }
}

async function discoverOllamaModels(configuredBaseUrl?: string): Promise<ModelDefinitionConfig[]> {
  // Skip Ollama discovery in test environments
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }
  const apiBaseUrl = resolveOllamaApiBaseUrl(configuredBaseUrl);
  try {
    const response = await fetch(`${apiBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      // Quiet by design: Ollama is an optional local daemon and may simply not
      // be running at boot. Surface only at debug level so logs aren't spammed.
      if (process.env.DEBUG) console.debug(`Ollama discovery skipped: HTTP ${response.status}`);
      return [];
    }
    const data = (await response.json()) as OllamaTagsResponse;
    if (!data.models || data.models.length === 0) {
      return [];
    }
    const runtime = await probeOllamaRuntimeContext(apiBaseUrl);
    return data.models.map((model) => {
      const modelId = model.name;
      const lower = modelId.toLowerCase();
      const isReasoning =
        lower.includes("r1") ||
        lower.includes("reasoning") ||
        lower.includes("qwq") ||
        lower.includes("qwen3");
      // Abliterated builds (refusal weights ablated) are LOCAL-ONLY opt-ins.
      // Give them a clear picker label so the user can tell at a glance the
      // model has had its alignment refusals removed. Discovery is dynamic,
      // so any current/future huihui_ai/mlabonne abliterated pull is covered.
      const isAbliterated = lower.includes("abliterat") || lower.includes("uncensored");
      const name = isAbliterated
        ? `${friendlyOllamaBaseName(modelId)} (abliterated, local)`
        : modelId;
      return {
        id: modelId,
        name,
        reasoning: isReasoning,
        input: ["text"],
        cost: OLLAMA_DEFAULT_COST,
        contextWindow: resolveOllamaContextWindow(modelId, runtime),
        maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
      };
    });
  } catch (error) {
    // Most common cause is "no local daemon" (ECONNREFUSED / fetch failed),
    // which is expected when the user hasn't installed Ollama. Keep it quiet —
    // a single debug line gated on DEBUG — so boot logs aren't spammed.
    if (process.env.DEBUG) console.debug(`Ollama discovery skipped: ${String(error)}`);
    return [];
  }
}

function normalizeApiKeyConfig(value: string): string {
  const trimmed = value.trim();
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function resolveEnvApiKeyVarName(provider: string): string | undefined {
  const resolved = resolveEnvApiKey(provider);
  if (!resolved) return undefined;
  const match = /^(?:env: |shell env: )([A-Z0-9_]+)$/.exec(resolved.source);
  return match ? match[1] : undefined;
}

function resolveAwsSdkApiKeyVarName(): string {
  return resolveAwsSdkEnvVarName() ?? "AWS_PROFILE";
}

function resolveApiKeyFromProfiles(params: {
  provider: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): string | undefined {
  const ids = listProfilesForProvider(params.store, params.provider);
  for (const id of ids) {
    const cred = params.store.profiles[id];
    if (!cred) continue;
    if (cred.type === "api_key") return cred.key;
    if (cred.type === "token") return cred.token;
  }
  return undefined;
}

export function normalizeGoogleModelId(id: string): string {
  if (id === "gemini-3-pro") return "gemini-3-pro-preview";
  if (id === "gemini-3-flash") return "gemini-3-flash-preview";
  return id;
}

function normalizeGoogleProvider(provider: ProviderConfig): ProviderConfig {
  let mutated = false;
  const models = provider.models.map((model) => {
    const nextId = normalizeGoogleModelId(model.id);
    if (nextId === model.id) return model;
    mutated = true;
    return { ...model, id: nextId };
  });
  return mutated ? { ...provider, models } : provider;
}

export function normalizeProviders(params: {
  providers: ModelsConfig["providers"];
  agentDir: string;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) return providers;
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};

  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    let normalizedProvider = provider;

    // Fix common misconfig: apiKey set to "${ENV_VAR}" instead of "ENV_VAR".
    if (
      normalizedProvider.apiKey &&
      normalizeApiKeyConfig(normalizedProvider.apiKey) !== normalizedProvider.apiKey
    ) {
      mutated = true;
      normalizedProvider = {
        ...normalizedProvider,
        apiKey: normalizeApiKeyConfig(normalizedProvider.apiKey),
      };
    }

    // If a provider defines models, pi's ModelRegistry requires apiKey to be set.
    // Fill it from the environment or auth profiles when possible.
    const hasModels =
      Array.isArray(normalizedProvider.models) && normalizedProvider.models.length > 0;
    if (hasModels && !normalizedProvider.apiKey?.trim()) {
      const authMode =
        normalizedProvider.auth ?? (normalizedKey === "amazon-bedrock" ? "aws-sdk" : undefined);
      if (authMode === "aws-sdk") {
        const apiKey = resolveAwsSdkApiKeyVarName();
        mutated = true;
        normalizedProvider = { ...normalizedProvider, apiKey };
      } else {
        const fromEnv = resolveEnvApiKeyVarName(normalizedKey);
        const fromProfiles = resolveApiKeyFromProfiles({
          provider: normalizedKey,
          store: authStore,
        });
        const apiKey = fromEnv ?? fromProfiles;
        if (apiKey?.trim()) {
          mutated = true;
          normalizedProvider = { ...normalizedProvider, apiKey };
        }
      }
    }

    if (normalizedKey === "google") {
      const googleNormalized = normalizeGoogleProvider(normalizedProvider);
      if (googleNormalized !== normalizedProvider) mutated = true;
      normalizedProvider = googleNormalized;
    }

    next[key] = normalizedProvider;
  }

  return mutated ? next : providers;
}

function buildMinimaxProvider(): ProviderConfig {
  return {
    baseUrl: MINIMAX_API_BASE_URL,
    api: "anthropic-messages",
    models: [
      {
        id: MINIMAX_DEFAULT_MODEL_ID,
        name: "MiniMax M2.1",
        reasoning: false,
        input: ["text"],
        cost: MINIMAX_API_COST,
        contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
      },
      {
        id: MINIMAX_DEFAULT_VISION_MODEL_ID,
        name: "MiniMax VL 01",
        reasoning: false,
        input: ["text", "image"],
        cost: MINIMAX_API_COST,
        contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

function buildMoonshotProvider(): ProviderConfig {
  return {
    baseUrl: MOONSHOT_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: MOONSHOT_DEFAULT_MODEL_ID,
        name: "Kimi K2 0905 Preview",
        reasoning: false,
        input: ["text"],
        cost: MOONSHOT_DEFAULT_COST,
        contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

function buildKimiCodeProvider(): ProviderConfig {
  return {
    baseUrl: KIMI_CODE_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: KIMI_CODE_MODEL_ID,
        name: "Kimi For Coding",
        reasoning: true,
        input: ["text"],
        cost: KIMI_CODE_DEFAULT_COST,
        contextWindow: KIMI_CODE_CONTEXT_WINDOW,
        maxTokens: KIMI_CODE_MAX_TOKENS,
        headers: KIMI_CODE_HEADERS,
        compat: KIMI_CODE_COMPAT,
      },
    ],
  };
}

function buildQwenPortalProvider(): ProviderConfig {
  return {
    baseUrl: QWEN_PORTAL_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: "coder-model",
        name: "Qwen Coder",
        reasoning: false,
        input: ["text"],
        cost: QWEN_PORTAL_DEFAULT_COST,
        contextWindow: QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW,
        maxTokens: QWEN_PORTAL_DEFAULT_MAX_TOKENS,
      },
      {
        id: "vision-model",
        name: "Qwen Vision",
        reasoning: false,
        input: ["text", "image"],
        cost: QWEN_PORTAL_DEFAULT_COST,
        contextWindow: QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW,
        maxTokens: QWEN_PORTAL_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

function buildSyntheticProvider(): ProviderConfig {
  return {
    baseUrl: SYNTHETIC_BASE_URL,
    api: "anthropic-messages",
    models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
  };
}

async function buildVeniceProvider(): Promise<ProviderConfig> {
  const models = await discoverVeniceModels();
  return {
    baseUrl: VENICE_BASE_URL,
    api: "openai-completions",
    models,
  };
}

async function buildOllamaProvider(configuredBaseUrl?: string): Promise<ProviderConfig> {
  const models = await discoverOllamaModels(configuredBaseUrl);
  // Keep the OpenAI-compat base URL in sync with the resolved host so requests
  // hit the same daemon discovery probed (honors OLLAMA_HOST / configured URL).
  const apiBaseUrl = resolveOllamaApiBaseUrl(configuredBaseUrl);
  const baseUrl = apiBaseUrl === OLLAMA_API_BASE_URL ? OLLAMA_BASE_URL : `${apiBaseUrl}/v1`;
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}

async function discoverOllamaCloudModels(apiKey: string): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }
  const toDefinition = (id: string): ModelDefinitionConfig => {
    const lower = id.toLowerCase();
    const isReasoning =
      lower.includes("r1") || lower.includes("reasoning") || lower.includes("deepseek-v3");
    return {
      id,
      name: id,
      reasoning: isReasoning,
      input: ["text"],
      cost: OLLAMA_CLOUD_DEFAULT_COST,
      contextWindow: OLLAMA_CLOUD_DEFAULT_CONTEXT_WINDOW,
      maxTokens: OLLAMA_CLOUD_DEFAULT_MAX_TOKENS,
    };
  };
  try {
    const response = await fetch(`${OLLAMA_CLOUD_API_BASE_URL}/api/tags`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const data = (await response.json()) as OllamaTagsResponse;
      const ids = (data.models ?? []).map((m) => m.name).filter(Boolean);
      if (ids.length > 0) return ids.map(toDefinition);
    }
  } catch {
    // fall through to /v1/models
  }
  try {
    const response = await fetch(`${OLLAMA_CLOUD_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      const ids = (data.data ?? []).map((m) => m.id).filter(Boolean);
      if (ids.length > 0) return ids.map(toDefinition);
    }
  } catch {
    // fall through to hardcoded fallback
  }
  return OLLAMA_CLOUD_FALLBACK_MODELS.map(toDefinition);
}

async function buildOllamaCloudProvider(apiKey: string): Promise<ProviderConfig> {
  const discovered = await discoverOllamaCloudModels(apiKey);
  // Reorder so the preferred default (OLLAMA_CLOUD_DEFAULT_MODEL_ID) lands first when present in the
  // discovered list — pi-coding-agent's ModelRegistry uses the provider's
  // first model as the default when agents.defaults.model isn't pinned.
  const models = sortOllamaCloudModels(discovered);
  return {
    baseUrl: OLLAMA_CLOUD_BASE_URL,
    api: "openai-completions",
    models,
  };
}

function sortOllamaCloudModels(models: ModelDefinitionConfig[]): ModelDefinitionConfig[] {
  if (models.length === 0) return models;
  const idx = models.findIndex((m) => m.id === OLLAMA_CLOUD_DEFAULT_MODEL_ID);
  if (idx <= 0) return models;
  const reordered = models.slice();
  const [preferred] = reordered.splice(idx, 1);
  reordered.unshift(preferred);
  return reordered;
}

function llamaCloudDefinition(
  id: string,
  meta?: (typeof LLAMACLOUD_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  const lower = id.toLowerCase();
  const known = meta ?? LLAMACLOUD_MODEL_CATALOG.find((m) => m.id === id);
  const vision = known?.vision ?? lower.includes("llama-4");
  const reasoning = known?.reasoning ?? lower.includes("llama-4");
  return {
    id,
    name: known?.name ?? id,
    api: "openai-completions",
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
    cost: LLAMACLOUD_DEFAULT_COST,
    contextWindow: known?.contextWindow ?? LLAMACLOUD_DEFAULT_CONTEXT_WINDOW,
    maxTokens: LLAMACLOUD_DEFAULT_MAX_TOKENS,
  };
}

async function discoverLlamaCloudModels(apiKey: string): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }
  try {
    const response = await fetch(`${LLAMACLOUD_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = (data.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
      if (ids.length > 0) return ids.map((id) => llamaCloudDefinition(id));
    }
  } catch {
    // fall through to curated catalog
  }
  return LLAMACLOUD_MODEL_CATALOG.map((m) => llamaCloudDefinition(m.id, m));
}

async function buildLlamaCloudProvider(apiKey: string): Promise<ProviderConfig> {
  const discovered = await discoverLlamaCloudModels(apiKey);
  // Float the preferred default to the front — pi-coding-agent's
  // ModelRegistry uses the provider's first model when no default is pinned.
  const idx = discovered.findIndex((m) => m.id === LLAMACLOUD_DEFAULT_MODEL_ID);
  const models =
    idx > 0
      ? [discovered[idx], ...discovered.slice(0, idx), ...discovered.slice(idx + 1)]
      : discovered;
  return {
    baseUrl: LLAMACLOUD_BASE_URL,
    api: "openai-completions",
    models,
  };
}

export async function resolveImplicitProviders(params: {
  agentDir: string;
  config?: InfinibotConfig;
}): Promise<ModelsConfig["providers"]> {
  const providers: Record<string, ProviderConfig> = {};
  // Honor an explicitly configured local Ollama base URL (set by the setup
  // wizard) so discovery + the OpenAI-compat baseUrl point at the right daemon.
  const configuredOllamaBaseUrl = params.config?.models?.providers?.ollama?.baseUrl;
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });

  const minimaxKey =
    resolveEnvApiKeyVarName("minimax") ??
    resolveApiKeyFromProfiles({ provider: "minimax", store: authStore });
  if (minimaxKey) {
    providers.minimax = { ...buildMinimaxProvider(), apiKey: minimaxKey };
  }

  const moonshotKey =
    resolveEnvApiKeyVarName("moonshot") ??
    resolveApiKeyFromProfiles({ provider: "moonshot", store: authStore });
  if (moonshotKey) {
    providers.moonshot = { ...buildMoonshotProvider(), apiKey: moonshotKey };
  }

  const kimiCodeKey =
    resolveEnvApiKeyVarName("kimi-code") ??
    resolveApiKeyFromProfiles({ provider: "kimi-code", store: authStore });
  if (kimiCodeKey) {
    providers["kimi-code"] = { ...buildKimiCodeProvider(), apiKey: kimiCodeKey };
  }

  const syntheticKey =
    resolveEnvApiKeyVarName("synthetic") ??
    resolveApiKeyFromProfiles({ provider: "synthetic", store: authStore });
  if (syntheticKey) {
    providers.synthetic = { ...buildSyntheticProvider(), apiKey: syntheticKey };
  }

  const veniceKey =
    resolveEnvApiKeyVarName("venice") ??
    resolveApiKeyFromProfiles({ provider: "venice", store: authStore });
  if (veniceKey) {
    providers.venice = { ...(await buildVeniceProvider()), apiKey: veniceKey };
  }

  const qwenProfiles = listProfilesForProvider(authStore, "qwen-portal");
  if (qwenProfiles.length > 0) {
    providers["qwen-portal"] = {
      ...buildQwenPortalProvider(),
      apiKey: QWEN_PORTAL_OAUTH_PLACEHOLDER,
    };
  }

  // Ollama provider - auto-discover if running locally, or if explicitly configured
  const ollamaKey =
    resolveEnvApiKeyVarName("ollama") ??
    resolveApiKeyFromProfiles({ provider: "ollama", store: authStore });
  // Always try to discover Ollama models - it doesn't require an API key.
  // Cloud-only (SaaS) installs skip the local daemon entirely.
  if (localProvidersEnabled()) {
    const ollamaProvider = await buildOllamaProvider(configuredOllamaBaseUrl);
    if (ollamaProvider.models.length > 0 || ollamaKey) {
      // Use "ollama" as a placeholder key since Ollama doesn't actually require auth
      providers.ollama = { ...ollamaProvider, apiKey: ollamaKey || "ollama" };
    }
  }

  // Ollama Cloud (Turbo) - registers only when a key is present. Without this,
  // setting OLLAMA_API_KEY auto-attached to the *local* provider (baseUrl
  // 127.0.0.1:11434), so sessions silently failed when there was no local
  // daemon. Now an env var or auth profile maps to a distinct cloud provider
  // pointed at https://ollama.com/v1.
  const ollamaCloudResolved = resolveEnvApiKey("ollama-cloud");
  const ollamaCloudEnvVar = ollamaCloudResolved
    ? resolveEnvApiKeyVarName("ollama-cloud")
    : undefined;
  const ollamaCloudProfileKey = resolveApiKeyFromProfiles({
    provider: "ollama-cloud",
    store: authStore,
  });
  // For env-resolved keys we persist the *var name* (matching the pattern used
  // by every other provider above) so the on-disk config doesn't bake in the
  // secret. The actual fetch uses the raw value at discovery time below.
  const ollamaCloudApiKeyField = ollamaCloudEnvVar ?? ollamaCloudProfileKey;
  if (ollamaCloudApiKeyField) {
    const rawKey = ollamaCloudResolved?.apiKey ?? ollamaCloudProfileKey ?? "";
    if (rawKey) {
      const cloudProvider = await buildOllamaCloudProvider(rawKey);
      providers["ollama-cloud"] = { ...cloudProvider, apiKey: ollamaCloudApiKeyField };
    }
  }

  // LlamaCloud (Meta Llama API) — registers only when a key is present.
  // Same env-var-name-vs-secret persistence rule as the providers above.
  const llamaCloudResolved = resolveEnvApiKey("llamacloud");
  const llamaCloudEnvVar = llamaCloudResolved ? resolveEnvApiKeyVarName("llamacloud") : undefined;
  const llamaCloudProfileKey = resolveApiKeyFromProfiles({
    provider: "llamacloud",
    store: authStore,
  });
  const llamaCloudApiKeyField = llamaCloudEnvVar ?? llamaCloudProfileKey;
  if (llamaCloudApiKeyField) {
    const rawKey = llamaCloudResolved?.apiKey ?? llamaCloudProfileKey ?? "";
    if (rawKey) {
      const llamaProvider = await buildLlamaCloudProvider(rawKey);
      providers.llamacloud = { ...llamaProvider, apiKey: llamaCloudApiKeyField };
    }
  }

  return providers;
}

export async function resolveImplicitCopilotProvider(params: {
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderConfig | null> {
  const env = params.env ?? process.env;
  const authStore = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const hasProfile = listProfilesForProvider(authStore, "github-copilot").length > 0;
  const envToken = env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN;
  const githubToken = (envToken ?? "").trim();

  if (!hasProfile && !githubToken) return null;

  let selectedGithubToken = githubToken;
  if (!selectedGithubToken && hasProfile) {
    // Use the first available profile as a default for discovery (it will be
    // re-resolved per-run by the embedded runner).
    const profileId = listProfilesForProvider(authStore, "github-copilot")[0];
    const profile = profileId ? authStore.profiles[profileId] : undefined;
    if (profile && profile.type === "token") {
      selectedGithubToken = profile.token;
    }
  }

  let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
  if (selectedGithubToken) {
    try {
      const token = await resolveCopilotApiToken({
        githubToken: selectedGithubToken,
        env,
      });
      baseUrl = token.baseUrl;
    } catch {
      baseUrl = DEFAULT_COPILOT_API_BASE_URL;
    }
  }

  // pi-coding-agent's ModelRegistry marks a model "available" only if its
  // `AuthStorage` has auth configured for that provider (via auth.json/env/etc).
  // Our Copilot auth lives in InfiniBot's auth-profiles store instead, so we also
  // write a runtime-only auth.json entry for pi-coding-agent to pick up.
  //
  // This is safe because it's (1) within InfiniBot's agent dir, (2) contains the
  // GitHub token (not the exchanged Copilot token), and (3) matches existing
  // patterns for OAuth-like providers in pi-coding-agent.
  // Note: we deliberately do not write pi-coding-agent's `auth.json` here.
  // InfiniBot uses its own auth store and exchanges tokens at runtime.
  // `models list` uses InfiniBot's auth heuristics for availability.

  // We intentionally do NOT define custom models for Copilot in models.json.
  // pi-coding-agent treats providers with models as replacements requiring apiKey.
  // We only override baseUrl; the model list comes from pi-ai built-ins.
  return {
    baseUrl,
    models: [],
  } satisfies ProviderConfig;
}

export async function resolveImplicitBedrockProvider(params: {
  agentDir: string;
  config?: InfinibotConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderConfig | null> {
  const env = params.env ?? process.env;
  const discoveryConfig = params.config?.models?.bedrockDiscovery;
  const enabled = discoveryConfig?.enabled;
  const hasAwsCreds = resolveAwsSdkEnvVarName(env) !== undefined;
  if (enabled === false) return null;
  if (enabled !== true && !hasAwsCreds) return null;

  const region = discoveryConfig?.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
  const models = await discoverBedrockModels({ region, config: discoveryConfig });
  if (models.length === 0) return null;

  return {
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    api: "bedrock-converse-stream",
    auth: "aws-sdk",
    models,
  } satisfies ProviderConfig;
}
