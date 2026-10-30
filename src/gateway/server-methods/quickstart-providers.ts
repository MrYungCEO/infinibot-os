/**
 * Provider model discovery for the quickstart onboarding UI.
 *
 * Given a provider id and an API key, probe the provider's `/models` endpoint
 * (or local equivalent) and return the list. Used by the Models step so the
 * user sees real, current model names instead of guessing.
 *
 * Supported providers:
 *   - anthropic       — https://api.anthropic.com/v1/models
 *   - openai          — https://api.openai.com/v1/models
 *   - openrouter      — https://openrouter.ai/api/v1/models
 *   - zai             — https://api.z.ai/api/paas/v4/models
 *   - ollama          — local Ollama server (http://localhost:11434/api/tags)
 *   - ollama-cloud    — Ollama Turbo / Cloud (https://ollama.com/api/tags)
 *
 * No API key required for `ollama` (local) or for the static `anthropic`
 * fallback list — the wizard still works on a clean machine without keys.
 */
import { curateModels, pickDefaultModel, type CuratableModel } from "../provider-model-curation.js";
import type { GatewayRequestHandlers } from "./types.js";

export interface DiscoveredModel extends CuratableModel {
  id: string;
  label?: string;
  /** Model context window in tokens, when the provider exposes it. */
  contextWindow?: number;
  /** Free-form provider hint ("instruct", "vision", etc.) for UI badges. */
  family?: string;
  /** True when the model supports tool/function calling (best-effort guess). */
  toolUse?: boolean;
}

interface FetchInput {
  apiKey?: string;
  endpoint?: string;
}

const ANTHROPIC_FALLBACK: DiscoveredModel[] = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", contextWindow: 200_000, toolUse: true },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", contextWindow: 200_000, toolUse: true },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    contextWindow: 200_000,
    toolUse: true,
  },
];

export const quickstartProvidersHandlers: GatewayRequestHandlers = {
  "quickstart.providers.fetchModels": async ({ params, respond }) => {
    const provider = typeof params.provider === "string" ? params.provider : "";
    const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
    const endpoint = typeof params.endpoint === "string" ? params.endpoint : "";
    const preferred = typeof params.preferred === "string" ? params.preferred : undefined;

    try {
      // Chat models only, nothing deprecated/shut down, `free` flagged, and a
      // default the key really has — so no picker ever preselects a dead model.
      const models = curateModels(provider, await fetchModelsFor(provider, { apiKey, endpoint }));
      const defaultModel = pickDefaultModel(provider, models, preferred);
      respond(true, { provider, models, count: models.length, defaultModel });
    } catch (err) {
      respond(true, {
        provider,
        models: [],
        count: 0,
        error: (err as Error).message,
      });
    }
  },

  /**
   * Validate an API key by making a real authenticated call to the provider.
   * Returns { ok, error?, modelCount?, latencyMs }. The UI uses this to gate
   * the "Save & continue" button — a key that the provider rejects never gets
   * written to disk and the active provider never changes.
   */
  "quickstart.providers.validate": async ({ params, respond }) => {
    const provider = typeof params.provider === "string" ? params.provider : "";
    const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
    const endpoint = typeof params.endpoint === "string" ? params.endpoint : "";
    const start = Date.now();

    if (provider === "ollama") {
      const host = (endpoint || "").replace(/\/$/, "") || "http://localhost:11434";
      const ok = await probe(`${host}/api/tags`, {}).catch(() => false);
      respond(true, {
        ok,
        error: ok ? undefined : `Cannot reach Ollama at ${host} — is it running?`,
        latencyMs: Date.now() - start,
      });
      return;
    }

    if (!apiKey) {
      respond(true, { ok: false, error: "API key is required", latencyMs: 0 });
      return;
    }

    try {
      const models = await fetchModelsFor(provider, { apiKey, endpoint });
      respond(true, { ok: true, modelCount: models.length, latencyMs: Date.now() - start });
    } catch (err) {
      respond(true, {
        ok: false,
        error: (err as Error).message,
        latencyMs: Date.now() - start,
      });
    }
  },

  /**
   * One tiny real chat turn with the chosen model (a few output tokens) so
   * setup never saves a model the key can't call. Answers ok with
   * `{ ok:false, error }` on failure; `error` is plain language.
   */
  "quickstart.providers.testModel": async ({ params, respond }) => {
    const provider = typeof params.provider === "string" ? params.provider : "";
    const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
    const endpoint = typeof params.endpoint === "string" ? params.endpoint : "";
    const model = typeof params.model === "string" ? params.model.trim() : "";
    const start = Date.now();
    if (!model) {
      respond(true, { ok: false, error: "Pick a model first.", latencyMs: 0 });
      return;
    }
    try {
      const reply = await testModelCall(provider, { apiKey, endpoint, model });
      respond(true, { ok: true, reply, latencyMs: Date.now() - start });
    } catch (err) {
      respond(true, { ok: false, error: (err as Error).message, latencyMs: Date.now() - start });
    }
  },

  /** Quick reachability probe — used by UI badges before we bother fetching. */
  "quickstart.providers.ping": async ({ params, respond }) => {
    const provider = typeof params.provider === "string" ? params.provider : "";
    const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
    const endpoint = typeof params.endpoint === "string" ? params.endpoint : "";
    try {
      const ok = await pingProvider(provider, { apiKey, endpoint });
      respond(true, { provider, ok });
    } catch (err) {
      respond(true, { provider, ok: false, error: (err as Error).message });
    }
  },
};

export async function fetchModelsFor(
  provider: string,
  input: FetchInput,
): Promise<DiscoveredModel[]> {
  switch (provider) {
    case "anthropic":
      return fetchAnthropic(input);
    case "openai":
      return fetchOpenAI(input);
    case "openrouter":
      return fetchOpenRouter(input);
    case "zai":
      return fetchZai(input);
    case "ollama":
      return fetchOllama(input);
    case "ollama-cloud":
      return fetchOllamaCloud(input);
    case "llamacloud":
    case "llama-cloud":
      return fetchLlamaCloud(input);
    case "groq":
      return fetchOpenAICompat("Groq", "https://api.groq.com/openai/v1/models", input.apiKey);
    case "together":
      return fetchOpenAICompat("Together", "https://api.together.xyz/v1/models", input.apiKey);
    case "deepseek":
      return fetchOpenAICompat("DeepSeek", "https://api.deepseek.com/models", input.apiKey);
    case "mistral":
      return fetchOpenAICompat("Mistral", "https://api.mistral.ai/v1/models", input.apiKey);
    case "fireworks":
      return fetchOpenAICompat(
        "Fireworks",
        "https://api.fireworks.ai/inference/v1/models",
        input.apiKey,
      );
    case "xai":
    case "grok":
      return fetchOpenAICompat("xAI", "https://api.x.ai/v1/models", input.apiKey);
    case "cerebras":
      return fetchOpenAICompat("Cerebras", "https://api.cerebras.ai/v1/models", input.apiKey);
    case "google":
    case "gemini":
      return fetchGemini(input);
    case "cohere":
      return fetchCohere(input);
    case "perplexity":
      return fetchPerplexity();
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function pingProvider(provider: string, input: FetchInput): Promise<boolean> {
  // For probes, do a HEAD/GET to the cheapest reachable endpoint per provider.
  switch (provider) {
    case "anthropic":
      if (!input.apiKey) return false;
      return probe("https://api.anthropic.com/v1/models", anthropicHeaders(input.apiKey));
    case "openai":
      if (!input.apiKey) return false;
      return probe("https://api.openai.com/v1/models", { Authorization: `Bearer ${input.apiKey}` });
    case "openrouter":
      if (!input.apiKey) return false;
      return probe("https://openrouter.ai/api/v1/models", {
        Authorization: `Bearer ${input.apiKey}`,
      });
    case "zai":
      if (!input.apiKey) return false;
      return probe("https://api.z.ai/api/paas/v4/models", {
        Authorization: `Bearer ${input.apiKey}`,
      });
    case "ollama": {
      const host = input.endpoint?.replace(/\/$/, "") || "http://localhost:11434";
      return probe(`${host}/api/tags`, {});
    }
    case "ollama-cloud":
      if (!input.apiKey) return false;
      return probe("https://ollama.com/api/tags", { Authorization: `Bearer ${input.apiKey}` });
    case "llamacloud":
    case "llama-cloud":
      if (!input.apiKey) return false;
      return probe("https://api.llama.com/compat/v1/models", {
        Authorization: `Bearer ${input.apiKey}`,
      });
    case "groq":
      return !!input.apiKey && probe("https://api.groq.com/openai/v1/models", bearer(input.apiKey));
    case "together":
      return !!input.apiKey && probe("https://api.together.xyz/v1/models", bearer(input.apiKey));
    case "deepseek":
      return !!input.apiKey && probe("https://api.deepseek.com/models", bearer(input.apiKey));
    case "mistral":
      return !!input.apiKey && probe("https://api.mistral.ai/v1/models", bearer(input.apiKey));
    case "fireworks":
      return (
        !!input.apiKey &&
        probe("https://api.fireworks.ai/inference/v1/models", bearer(input.apiKey))
      );
    case "xai":
    case "grok":
      return !!input.apiKey && probe("https://api.x.ai/v1/models", bearer(input.apiKey));
    case "cerebras":
      return !!input.apiKey && probe("https://api.cerebras.ai/v1/models", bearer(input.apiKey));
    case "cohere":
      return !!input.apiKey && probe("https://api.cohere.com/v1/models", bearer(input.apiKey));
    case "google":
    case "gemini":
      return (
        !!input.apiKey &&
        probe(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(input.apiKey)}`,
          {},
        )
      );
    case "perplexity":
      // No public /models listing endpoint — treat a present key as reachable.
      return !!input.apiKey;
    default:
      return false;
  }
}

async function probe(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Anthropic ───────────────────────────────────────────────────────────

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

async function fetchAnthropic(input: FetchInput): Promise<DiscoveredModel[]> {
  if (!input.apiKey) return ANTHROPIC_FALLBACK;
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: anthropicHeaders(input.apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return ANTHROPIC_FALLBACK;
    const body = (await res.json()) as {
      data?: Array<{ id: string; display_name?: string; type?: string }>;
    };
    const models = (body.data ?? []).map((m) => ({
      id: m.id,
      label: m.display_name ?? m.id,
      family: m.type,
      toolUse: true,
    }));
    return models.length ? models : ANTHROPIC_FALLBACK;
  } catch {
    return ANTHROPIC_FALLBACK;
  }
}

// ─── OpenAI ─────────────────────────────────────────────────────────────

async function fetchOpenAI(input: FetchInput): Promise<DiscoveredModel[]> {
  if (!input.apiKey) throw new Error("OpenAI API key required");
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
  const models = body.data ?? [];
  // Return only chat-capable models (heuristic — OpenAI exposes embeddings,
  // tts, etc. on the same listing). Keep gpt-* and o-series, drop the rest.
  const filtered = models
    .filter((m) => /^(gpt-|o[1-9]|chatgpt-|gpt$)/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return filtered.map((m) => ({
    id: m.id,
    label: m.id,
    family: m.owned_by,
    toolUse: m.id.startsWith("gpt-"),
  }));
}

// ─── OpenRouter ─────────────────────────────────────────────────────────

async function fetchOpenRouter(input: FetchInput): Promise<DiscoveredModel[]> {
  if (!input.apiKey) throw new Error("OpenRouter API key required");
  // /models is public, so it proves nothing about the key. /key is authenticated.
  const keyRes = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!keyRes.ok) {
    const text = await keyRes.text().catch(() => "");
    const why = providerErrorText(text);
    throw new Error(`OpenRouter rejected the key (${keyRes.status})${why ? `: ${why}` : "."}`);
  }
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as {
    data?: Array<{
      id: string;
      name?: string;
      context_length?: number;
      supported_parameters?: string[];
      pricing?: { prompt?: string; completion?: string };
      expiration_date?: string | null;
      architecture?: { output_modalities?: string[] };
    }>;
  };
  const now = Date.now();
  return (body.data ?? []).map((m) => {
    const expires = m.expiration_date ? Date.parse(m.expiration_date) : Number.NaN;
    const out = m.architecture?.output_modalities;
    return {
      id: m.id,
      label: m.name ?? m.id,
      contextWindow: m.context_length,
      toolUse: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"),
      free: m.id.endsWith(":free") || (m.pricing?.prompt === "0" && m.pricing?.completion === "0"),
      deprecated: Number.isFinite(expires) && expires <= now,
      chat: Array.isArray(out) ? out.includes("text") : undefined,
    };
  });
}

// ─── Z.ai ───────────────────────────────────────────────────────────────

async function fetchZai(input: FetchInput): Promise<DiscoveredModel[]> {
  if (!input.apiKey) throw new Error("Z.ai API key required");
  const res = await fetch("https://api.z.ai/api/paas/v4/models", {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Z.ai ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => ({ id: m.id, label: m.id, toolUse: true }));
}

// ─── LlamaCloud (Meta Llama API) ────────────────────────────────────────

const LLAMACLOUD_FALLBACK: DiscoveredModel[] = [
  {
    id: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    label: "Llama 4 Maverick (17B·128E)",
    contextWindow: 1_000_000,
    toolUse: true,
    family: "vision",
  },
  {
    id: "Llama-4-Scout-17B-16E-Instruct-FP8",
    label: "Llama 4 Scout (17B·16E)",
    contextWindow: 1_000_000,
    toolUse: true,
    family: "vision",
  },
  {
    id: "Llama-3.3-70B-Instruct",
    label: "Llama 3.3 70B Instruct",
    contextWindow: 128_000,
    toolUse: true,
  },
  {
    id: "Llama-3.3-8B-Instruct",
    label: "Llama 3.3 8B Instruct",
    contextWindow: 128_000,
    toolUse: true,
  },
];

async function fetchLlamaCloud(input: FetchInput): Promise<DiscoveredModel[]> {
  if (!input.apiKey) {
    // No key on a clean machine — still surface the curated catalog so the
    // wizard's model dropdown isn't empty.
    return LLAMACLOUD_FALLBACK;
  }
  try {
    const res = await fetch("https://api.llama.com/compat/v1/models", {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      const list = (body.data ?? []).map((m) => ({
        id: m.id,
        label: m.id,
        toolUse: true,
        family: /llama-4/i.test(m.id) ? "vision" : undefined,
      }));
      if (list.length) return list;
    }
  } catch {
    // fall through to curated catalog
  }
  return LLAMACLOUD_FALLBACK;
}

// ─── Ollama (local) ─────────────────────────────────────────────────────

async function fetchOllama(input: FetchInput): Promise<DiscoveredModel[]> {
  const host = input.endpoint?.replace(/\/$/, "") || "http://localhost:11434";
  const res = await fetch(`${host}/api/tags`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`Ollama ${res.status} at ${host} — is the server running?`);
  }
  const body = (await res.json()) as {
    models?: Array<{
      name: string;
      details?: { parameter_size?: string; family?: string };
    }>;
  };
  return (body.models ?? []).map((m) => ({
    id: m.name,
    label: m.name,
    family: m.details?.family,
    toolUse: true, // Ollama Turbo + most chat models support function calling
  }));
}

// ─── Ollama Cloud (Turbo) ───────────────────────────────────────────────

async function fetchOllamaCloud(input: FetchInput): Promise<DiscoveredModel[]> {
  if (!input.apiKey)
    throw new Error("Ollama Cloud API key required (get one at https://ollama.com/settings/keys)");
  // ollama.com/api/tags and /v1/models answer WITHOUT a key, so listing alone
  // would accept any string. Probe chat with an empty body: Ollama
  // authenticates before validating the body, so 401/403 rejects the key and a
  // 400 means it got past auth. Nothing is generated or billed.
  const probe = await fetch("https://ollama.com/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (probe.status === 401 || probe.status === 403) {
    throw new Error(
      `Ollama Cloud rejected the key (${probe.status}). Get one at https://ollama.com/settings/keys`,
    );
  }
  // Ollama Cloud (Turbo) uses the same /api/tags endpoint shape as the local
  // server, fronted by the cloud host. Library listing is also reachable via
  // /v1/models for OpenAI-compat. Probe both, prefer richer one.
  try {
    const res = await fetch("https://ollama.com/api/tags", {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        models?: Array<{ name: string; details?: { family?: string }; capabilities?: string[] }>;
      };
      const list = (body.models ?? []).map((m) => ({
        id: m.name,
        label: m.name,
        family: m.details?.family,
        toolUse: m.capabilities ? m.capabilities.includes("tools") : true,
        // e.g. clef ("decision") lists no "completion": it can't chat.
        chat: m.capabilities ? m.capabilities.includes("completion") : undefined,
      }));
      if (list.length) return list;
    }
  } catch {
    // fall through to OpenAI-compat endpoint
  }
  const compat = await fetch("https://ollama.com/v1/models", {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!compat.ok) {
    const text = await compat.text().catch(() => "");
    throw new Error(`Ollama Cloud ${compat.status}: ${text || compat.statusText}`);
  }
  const body = (await compat.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => ({ id: m.id, label: m.id, toolUse: true }));
}

// ─── Generic OpenAI-compatible /models ──────────────────────────────────
// Groq, Together, DeepSeek, Mistral, Fireworks, xAI, Cerebras all expose an
// OpenAI-shaped models listing (Bearer auth, `{data:[{id}]}` — Together returns
// a bare array). One helper covers them all.

function bearer(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function fetchOpenAICompat(
  label: string,
  url: string,
  apiKey: string | undefined,
): Promise<DiscoveredModel[]> {
  if (!apiKey) throw new Error(`${label} API key required`);
  const res = await fetch(url, { headers: bearer(apiKey), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${label} ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as
    | { data?: Array<{ id: string; context_length?: number; active?: boolean }> }
    | Array<{ id: string; context_length?: number; active?: boolean }>;
  const list = Array.isArray(body) ? body : (body.data ?? []);
  return list
    .filter((m) => typeof m?.id === "string")
    .map((m) => ({
      id: m.id,
      label: m.id,
      contextWindow: m.context_length,
      toolUse: true,
      // Groq lists decommissioned models with `active: false`.
      deprecated: m.active === false,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ─── Google Gemini ───────────────────────────────────────────────────────
// Different shape: key is a query param, models are `models/<id>` and gate on
// supportedGenerationMethods including "generateContent".
async function fetchGemini(input: FetchInput): Promise<DiscoveredModel[]> {
  if (!input.apiKey) throw new Error("Google Gemini API key required");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(input.apiKey)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as {
    models?: Array<{
      name: string;
      displayName?: string;
      inputTokenLimit?: number;
      supportedGenerationMethods?: string[];
    }>;
  };
  return (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => {
      const id = m.name.replace(/^models\//, "");
      return { id, label: m.displayName ?? id, contextWindow: m.inputTokenLimit, toolUse: true };
    });
}

// ─── Cohere ──────────────────────────────────────────────────────────────
// Bearer auth but `{models:[{name, endpoints}]}` — filter to chat-capable.
async function fetchCohere(input: FetchInput): Promise<DiscoveredModel[]> {
  if (!input.apiKey) throw new Error("Cohere API key required");
  const res = await fetch("https://api.cohere.com/v1/models?page_size=100", {
    headers: bearer(input.apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cohere ${res.status}: ${text || res.statusText}`);
  }
  const body = (await res.json()) as {
    models?: Array<{ name: string; context_length?: number; endpoints?: string[] }>;
  };
  return (body.models ?? [])
    .filter((m) => !m.endpoints || m.endpoints.includes("chat"))
    .map((m) => ({ id: m.name, label: m.name, contextWindow: m.context_length, toolUse: true }));
}

// ─── Perplexity ──────────────────────────────────────────────────────────
// Perplexity has NO public model-listing endpoint; the model set is fixed, so
// return the curated catalog (keeps the dropdown populated like the others).
const PERPLEXITY_FALLBACK: DiscoveredModel[] = [
  { id: "sonar", label: "Sonar", contextWindow: 128_000 },
  { id: "sonar-pro", label: "Sonar Pro", contextWindow: 200_000 },
  { id: "sonar-reasoning", label: "Sonar Reasoning", contextWindow: 128_000 },
  { id: "sonar-reasoning-pro", label: "Sonar Reasoning Pro", contextWindow: 128_000 },
  { id: "sonar-deep-research", label: "Sonar Deep Research", contextWindow: 128_000 },
];
async function fetchPerplexity(): Promise<DiscoveredModel[]> {
  return PERPLEXITY_FALLBACK;
}

// ─── Test call ────────────────────────────────────────────────────────────
// One tiny chat turn with the chosen model so setup can prove the key + model
// work before saving. A few output tokens at most; nothing else is generated.

const OPENAI_COMPAT_CHAT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  xai: "https://api.x.ai/v1",
  grok: "https://api.x.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  zai: "https://api.z.ai/api/paas/v4",
  llamacloud: "https://api.llama.com/compat/v1",
  "llama-cloud": "https://api.llama.com/compat/v1",
  cohere: "https://api.cohere.ai/compatibility/v1",
  perplexity: "https://api.perplexity.ai",
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  together: "Together",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  fireworks: "Fireworks",
  xai: "xAI",
  grok: "xAI",
  cerebras: "Cerebras",
  zai: "Z.ai",
  llamacloud: "LlamaCloud",
  "llama-cloud": "LlamaCloud",
  cohere: "Cohere",
  perplexity: "Perplexity",
};

const TEST_PROMPT = "Reply with the single word: ok";
// Thinking models (Gemini 3.x, gpt-oss) spend the first tokens reasoning;
// 64 leaves room for a visible "ok" and still costs a fraction of a cent.
const TEST_MAX_TOKENS = 64;

/** The human message inside a provider error body (`{error:{message}}`, `{message}`), else the trimmed text. */
export function providerErrorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const msg = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
    if (msg) return msg.trim().slice(0, 200);
  } catch {
    // not JSON
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Plain-language reason for a failed test call. */
export function describeTestFailure(label: string, status: number, body: string): string {
  const detail = providerErrorText(body);
  if (status === 401 || status === 403) return `${label} rejected the key (${status}).`;
  if (status === 404) return `This model isn't available to your ${label} key. Pick another one.`;
  if (status === 402)
    return `${label} says the account has no credit left (402). Add credit or pick a free model.`;
  if (status === 429)
    return `${label} is rate-limiting this key or the quota is used up (429). Try again shortly or pick another model.`;
  return `${label} couldn't run this model (${status})${detail ? `: ${detail}` : "."}`;
}

async function postJson(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(describeTestFailure(label, res.status, text));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export async function testModelCall(
  provider: string,
  input: FetchInput & { model: string },
): Promise<string> {
  const { model } = input;
  const apiKey = input.apiKey ?? "";
  if (provider !== "ollama" && !apiKey) throw new Error("Enter an API key first.");
  switch (provider) {
    case "anthropic": {
      const body = (await postJson(
        "Anthropic",
        "https://api.anthropic.com/v1/messages",
        anthropicHeaders(apiKey),
        {
          model,
          max_tokens: TEST_MAX_TOKENS,
          messages: [{ role: "user", content: TEST_PROMPT }],
        },
      )) as { content?: Array<{ text?: string }> };
      return (body.content ?? [])
        .map((c) => c.text ?? "")
        .join("")
        .trim();
    }
    case "google":
    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const body = (await postJson(
        "Google",
        url,
        { "x-goog-api-key": apiKey },
        {
          contents: [{ role: "user", parts: [{ text: TEST_PROMPT }] }],
          generationConfig: {
            maxOutputTokens: TEST_MAX_TOKENS,
            // Gemini 3+ otherwise spends the whole budget thinking and returns no text.
            ...(/^gemini-([3-9]|\d{2})/.test(model)
              ? { thinkingConfig: { thinkingLevel: "low" } }
              : {}),
          },
        },
      )) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return (body.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("")
        .trim();
    }
    case "ollama":
    case "ollama-cloud": {
      const host =
        provider === "ollama"
          ? (input.endpoint || "").replace(/\/$/, "") || "http://localhost:11434"
          : "https://ollama.com";
      const headers: Record<string, string> =
        provider === "ollama" ? {} : { Authorization: `Bearer ${apiKey}` };
      const body = (await postJson(
        provider === "ollama" ? "Ollama" : "Ollama Cloud",
        `${host}/api/chat`,
        headers,
        {
          model,
          stream: false,
          messages: [{ role: "user", content: TEST_PROMPT }],
          options: { num_predict: TEST_MAX_TOKENS },
        },
      )) as { message?: { content?: string } };
      return (body.message?.content ?? "").trim();
    }
    default: {
      const base = OPENAI_COMPAT_CHAT_BASE[provider];
      if (!base) throw new Error(`Unknown provider: ${provider}`);
      // OpenAI's newer models reject max_tokens; everyone else still expects it.
      const limit =
        provider === "openai"
          ? { max_completion_tokens: TEST_MAX_TOKENS }
          : { max_tokens: TEST_MAX_TOKENS };
      const body = (await postJson(
        PROVIDER_LABELS[provider] ?? provider,
        `${base}/chat/completions`,
        bearer(apiKey),
        {
          model,
          messages: [{ role: "user", content: TEST_PROMPT }],
          ...limit,
        },
      )) as { choices?: Array<{ message?: { content?: string | null } }> };
      return (body.choices?.[0]?.message?.content ?? "").trim();
    }
  }
}
