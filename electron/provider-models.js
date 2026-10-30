/**
 * Live provider model discovery for the first-run wizard (main process).
 *
 * MIRROR of src/gateway/server-methods/quickstart-providers.ts — keep the two in
 * sync. We mirror (rather than import the dist module) because this runs at
 * first-run when there is no gateway, and the electron layer must not depend on
 * a TypeScript rebuild to ship. Same provider list, same endpoints, same shapes.
 *
 * Given a provider id + an API key (or local endpoint), probe the provider's
 * model listing and return [{ id, label }]. Used by the wizard's "Fetch models"
 * button so BYOK providers (Ollama Cloud, OpenRouter, DeepSeek, …) show real,
 * current model names instead of a "(default)" placeholder.
 */

const TIMEOUT_MS = 15_000;
const OLLAMA_TIMEOUT_MS = 8_000;

function bearer(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

function anthropicHeaders(apiKey) {
  return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
}

const ANTHROPIC_FALLBACK = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

const LLAMACLOUD_FALLBACK = [
  { id: "Llama-4-Maverick-17B-128E-Instruct-FP8", label: "Llama 4 Maverick (17B·128E)" },
  { id: "Llama-4-Scout-17B-16E-Instruct-FP8", label: "Llama 4 Scout (17B·16E)" },
  { id: "Llama-3.3-70B-Instruct", label: "Llama 3.3 70B Instruct" },
  { id: "Llama-3.3-8B-Instruct", label: "Llama 3.3 8B Instruct" },
];

const PERPLEXITY_FALLBACK = [
  { id: "sonar", label: "Sonar" },
  { id: "sonar-pro", label: "Sonar Pro" },
  { id: "sonar-reasoning", label: "Sonar Reasoning" },
  { id: "sonar-reasoning-pro", label: "Sonar Reasoning Pro" },
  { id: "sonar-deep-research", label: "Sonar Deep Research" },
];

async function getJson(url, headers, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchOpenAICompat(label, url, apiKey) {
  if (!apiKey) throw new Error(`${label} API key required`);
  const body = await getJson(url, bearer(apiKey)).catch((e) => {
    throw new Error(`${label} ${e.message}`);
  });
  const list = Array.isArray(body) ? body : body.data ?? [];
  return list
    .filter((m) => m && typeof m.id === "string")
    .map((m) => ({ id: m.id, label: m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchAnthropic(apiKey) {
  if (!apiKey) return ANTHROPIC_FALLBACK;
  try {
    const body = await getJson("https://api.anthropic.com/v1/models?limit=100", anthropicHeaders(apiKey));
    const models = (body.data ?? []).map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
    return models.length ? models : ANTHROPIC_FALLBACK;
  } catch {
    return ANTHROPIC_FALLBACK;
  }
}

async function fetchOpenAI(apiKey) {
  if (!apiKey) throw new Error("OpenAI API key required");
  const body = await getJson("https://api.openai.com/v1/models", bearer(apiKey)).catch((e) => {
    throw new Error(`OpenAI ${e.message}`);
  });
  return (body.data ?? [])
    .filter((m) => /^(gpt-|o[1-9]|chatgpt-|gpt$)/i.test(m.id))
    .map((m) => ({ id: m.id, label: m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchOpenRouter(apiKey) {
  if (!apiKey) throw new Error("OpenRouter API key required");
  const body = await getJson("https://openrouter.ai/api/v1/models", bearer(apiKey)).catch((e) => {
    throw new Error(`OpenRouter ${e.message}`);
  });
  return (body.data ?? []).map((m) => ({ id: m.id, label: m.name ?? m.id }));
}

async function fetchZai(apiKey) {
  if (!apiKey) throw new Error("Z.ai API key required");
  const body = await getJson("https://api.z.ai/api/paas/v4/models", bearer(apiKey)).catch((e) => {
    throw new Error(`Z.ai ${e.message}`);
  });
  return (body.data ?? []).map((m) => ({ id: m.id, label: m.id }));
}

async function fetchOllama(endpoint) {
  const host = (endpoint || "").replace(/\/$/, "") || "http://localhost:11434";
  let body;
  try {
    body = await getJson(`${host}/api/tags`, {}, OLLAMA_TIMEOUT_MS);
  } catch (e) {
    throw new Error(`Ollama at ${host} — is the server running? (${e.message})`);
  }
  return (body.models ?? []).map((m) => ({ id: m.name, label: m.name }));
}

async function fetchOllamaCloud(apiKey) {
  if (!apiKey) {
    throw new Error("Ollama Cloud API key required (get one at https://ollama.com/settings/keys)");
  }
  // Prefer the richer /api/tags shape; fall back to the OpenAI-compat listing.
  try {
    const body = await getJson("https://ollama.com/api/tags", bearer(apiKey));
    const list = (body.models ?? []).map((m) => ({ id: m.name, label: m.name }));
    if (list.length) return list;
  } catch {/* fall through */}
  const body = await getJson("https://ollama.com/v1/models", bearer(apiKey)).catch((e) => {
    throw new Error(`Ollama Cloud ${e.message}`);
  });
  return (body.data ?? []).map((m) => ({ id: m.id, label: m.id }));
}

async function fetchLlamaCloud(apiKey) {
  if (!apiKey) return LLAMACLOUD_FALLBACK;
  try {
    const body = await getJson("https://api.llama.com/compat/v1/models", bearer(apiKey));
    const list = (body.data ?? []).map((m) => ({ id: m.id, label: m.id }));
    if (list.length) return list;
  } catch {/* fall through */}
  return LLAMACLOUD_FALLBACK;
}

async function fetchGemini(apiKey) {
  if (!apiKey) throw new Error("Google Gemini API key required");
  const body = await getJson(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
    {},
  ).catch((e) => {
    throw new Error(`Gemini ${e.message}`);
  });
  return (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => {
      const id = String(m.name).replace(/^models\//, "");
      return { id, label: m.displayName ?? id };
    });
}

async function fetchCohere(apiKey) {
  if (!apiKey) throw new Error("Cohere API key required");
  const body = await getJson("https://api.cohere.com/v1/models?page_size=100", bearer(apiKey)).catch((e) => {
    throw new Error(`Cohere ${e.message}`);
  });
  return (body.models ?? [])
    .filter((m) => !m.endpoints || m.endpoints.includes("chat"))
    .map((m) => ({ id: m.name, label: m.name }));
}

/**
 * Discover models for a provider. Returns [{ id, label }]. Throws on a missing
 * key / unreachable endpoint so the caller can surface the message inline.
 */
async function fetchModelsFor(provider, { apiKey = "", endpoint = "" } = {}) {
  switch (provider) {
    case "anthropic":
      return fetchAnthropic(apiKey);
    case "openai":
      return fetchOpenAI(apiKey);
    case "openrouter":
      return fetchOpenRouter(apiKey);
    case "zai":
      return fetchZai(apiKey);
    case "ollama":
      return fetchOllama(endpoint);
    case "ollama-cloud":
      return fetchOllamaCloud(apiKey);
    case "llamacloud":
    case "llama-cloud":
      return fetchLlamaCloud(apiKey);
    case "groq":
      return fetchOpenAICompat("Groq", "https://api.groq.com/openai/v1/models", apiKey);
    case "together":
      return fetchOpenAICompat("Together", "https://api.together.xyz/v1/models", apiKey);
    case "deepseek":
      return fetchOpenAICompat("DeepSeek", "https://api.deepseek.com/models", apiKey);
    case "mistral":
      return fetchOpenAICompat("Mistral", "https://api.mistral.ai/v1/models", apiKey);
    case "fireworks":
      return fetchOpenAICompat("Fireworks", "https://api.fireworks.ai/inference/v1/models", apiKey);
    case "xai":
    case "grok":
      return fetchOpenAICompat("xAI", "https://api.x.ai/v1/models", apiKey);
    case "cerebras":
      return fetchOpenAICompat("Cerebras", "https://api.cerebras.ai/v1/models", apiKey);
    case "google":
    case "gemini":
      return fetchGemini(apiKey);
    case "cohere":
      return fetchCohere(apiKey);
    case "perplexity":
      return PERPLEXITY_FALLBACK;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

module.exports = { fetchModelsFor };
