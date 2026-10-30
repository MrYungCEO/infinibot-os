import type { Api, Model } from "@mariozechner/pi-ai";
import { discoverAuthStorage, discoverModels } from "@mariozechner/pi-coding-agent";

import type { InfinibotConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { resolveInfiniBotAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { isChatModel, modelIdSimilarity } from "../model-catalog-reconcile.js";
import { getCatalogReferenceSync } from "../model-catalog-reference.js";
import { normalizeModelCompat } from "../model-compat.js";
import { normalizeProviderId } from "../model-selection.js";

type InlineModelEntry = ModelDefinitionConfig & { provider: string };

export function buildInlineProviderModels(
  providers: Record<
    string,
    { models?: ModelDefinitionConfig[]; api?: ModelDefinitionConfig["api"] }
  >,
): InlineModelEntry[] {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    const trimmed = providerId.trim();
    if (!trimmed) return [];
    // Inherit `api` from the provider when the model omits it. pi-ai's
    // mapOptionsForApi switches on model.api and throws "Unhandled API in
    // mapOptionsForApi: undefined" if it's missing — without this fallback,
    // any user-declared provider where only the provider has `api` set (the
    // common case for OpenAI-compatible endpoints) crashes the agent loop.
    return (entry?.models ?? []).map((model) => ({
      ...model,
      api: model.api ?? entry?.api,
      provider: trimmed,
    }));
  });
}

export function buildModelAliasLines(cfg?: InfinibotConfig) {
  const models = cfg?.agents?.defaults?.models ?? {};
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) continue;
    const alias = String((entryRaw as { alias?: string } | undefined)?.alias ?? "").trim();
    if (!alias) continue;
    entries.push({ alias, model });
  }
  return entries
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}

/**
 * A model the provider serves today but the bundled registry predates
 * (e.g. google/gemini-3.8-flash). It is in the reference catalog, so build it
 * from the closest built-in model of the same provider — that carries the
 * right transport (api, baseUrl, headers, compat) — with the new id on top.
 */
export function resolveReferenceModel(
  provider: string,
  modelId: string,
  registryModels: ReadonlyArray<Model<Api>>,
  reference = getCatalogReferenceSync(),
): Model<Api> | undefined {
  const normalized = normalizeProviderId(provider);
  const ref = reference?.providers[normalized];
  const hit = ref?.models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
  if (!hit || !isChatModel(hit)) return undefined;
  const siblings = registryModels.filter((m) => normalizeProviderId(m.provider) === normalized);
  if (siblings.length === 0) return undefined;
  let template = siblings[0] as Model<Api>;
  let best = -Infinity;
  for (const m of siblings) {
    const score = modelIdSimilarity(hit.id, m.id);
    if (score > best) {
      best = score;
      template = m;
    }
  }
  // No family match in a mixed-transport provider (opencode): default to the
  // OpenAI-compatible transport rather than whatever happens to be listed first.
  if (best < 4) {
    template = siblings.find((m) => m.api === "openai-completions") ?? template;
  }
  return {
    ...template,
    id: hit.id,
    name: hit.name ?? hit.id,
    reasoning: hit.reasoning ?? template.reasoning,
    input: hit.input ?? template.input,
    contextWindow: hit.contextWindow ?? template.contextWindow,
    maxTokens: hit.maxTokens ?? template.maxTokens,
    cost: hit.cost
      ? { ...template.cost, input: hit.cost.input, output: hit.cost.output }
      : template.cost,
  } as Model<Api>;
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: InfinibotConfig,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: ReturnType<typeof discoverAuthStorage>;
  modelRegistry: ReturnType<typeof discoverModels>;
} {
  const resolvedAgentDir = agentDir ?? resolveInfiniBotAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
  if (!model) {
    const providers = cfg?.models?.providers ?? {};
    const inlineModels = buildInlineProviderModels(providers);
    const normalizedProvider = normalizeProviderId(provider);
    const inlineMatch = inlineModels.find(
      (entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId,
    );
    if (inlineMatch) {
      const normalized = normalizeModelCompat(inlineMatch as Model<Api>);
      return {
        model: normalized,
        authStorage,
        modelRegistry,
      };
    }
    // Listed by the provider today but newer than the registry: clone the
    // closest sibling so the transport (api, baseUrl, headers) is right.
    const referenceModel = resolveReferenceModel(
      provider,
      modelId,
      modelRegistry.getAll() as Model<Api>[],
    );
    if (referenceModel) {
      return { model: normalizeModelCompat(referenceModel), authStorage, modelRegistry };
    }
    const providerCfg = providers[provider];
    if (providerCfg || modelId.startsWith("mock-")) {
      // Carry the provider's endpoint: the transports dereference model.baseUrl,
      // so an id that isn't declared must still know where to go — then an
      // unknown id gets the provider's own "model not found" instead of a crash.
      const sibling = (modelRegistry.getAll() as Model<Api>[]).find(
        (m) => normalizeProviderId(m.provider) === normalizedProvider,
      );
      const fallbackModel: Model<Api> = normalizeModelCompat({
        id: modelId,
        name: modelId,
        api: providerCfg?.api ?? sibling?.api ?? "openai-responses",
        provider,
        ...((providerCfg?.baseUrl ?? sibling?.baseUrl)
          ? { baseUrl: providerCfg?.baseUrl ?? sibling?.baseUrl }
          : {}),
        ...((providerCfg?.headers ?? sibling?.headers)
          ? { headers: providerCfg?.headers ?? sibling?.headers }
          : {}),
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: providerCfg?.models?.[0]?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: providerCfg?.models?.[0]?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      } as Model<Api>);
      return { model: fallbackModel, authStorage, modelRegistry };
    }
    return {
      error: `Unknown model: ${provider}/${modelId}`,
      authStorage,
      modelRegistry,
    };
  }
  return { model: normalizeModelCompat(model), authStorage, modelRegistry };
}
