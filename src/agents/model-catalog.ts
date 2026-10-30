import { type InfinibotConfig, loadConfig } from "../config/config.js";
import { resolveInfiniBotAgentDir } from "./agent-paths.js";
import { reconcileCatalog } from "./model-catalog-reconcile.js";
import { loadCatalogReference, REFERENCE_TTL_MS } from "./model-catalog-reference.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { ensureInfiniBotModelsJson } from "./models-config.js";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  /** USD per 1M tokens. Only meaningful for pricing when `costSource` is set. */
  cost?: { input: number; output: number };
  /** Live source of `cost` ("openrouter-api" | "models.dev" | "provider-api"). */
  costSource?: string;
};

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost?: { input?: number; output?: number };
};

type PiSdkModule = typeof import("@mariozechner/pi-coding-agent");

// Keyed by agent dir: in SaaS mode each tenant has its own agent dir (and its
// own models.json), so one process-wide slot would serve tenant A's catalog to B.
const modelCatalogPromises = new Map<string, Promise<ModelCatalogEntry[]>>();
/** Per agent dir: the catalog is rebuilt once the reference lists it was reconciled against expire. */
const modelCatalogLoadedAt = new Map<string, number>();
let hasLoggedModelCatalogError = false;
const defaultImportPiSdk = () => import("@mariozechner/pi-coding-agent");
let importPiSdk = defaultImportPiSdk;

export function resetModelCatalogCacheForTest() {
  modelCatalogPromises.clear();
  modelCatalogLoadedAt.clear();
  hasLoggedModelCatalogError = false;
  importPiSdk = defaultImportPiSdk;
}

// Test-only escape hatch: allow mocking the dynamic import to simulate transient failures.
export function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>) {
  importPiSdk = loader ?? defaultImportPiSdk;
}

export async function loadModelCatalog(params?: {
  config?: InfinibotConfig;
  useCache?: boolean;
}): Promise<ModelCatalogEntry[]> {
  const cacheKey = resolveInfiniBotAgentDir();
  if (params?.useCache === false) {
    modelCatalogPromises.delete(cacheKey);
  }
  const loadedAt = modelCatalogLoadedAt.get(cacheKey) ?? 0;
  if (modelCatalogPromises.has(cacheKey) && Date.now() - loadedAt > REFERENCE_TTL_MS) {
    modelCatalogPromises.delete(cacheKey);
  }
  const cached = modelCatalogPromises.get(cacheKey);
  if (cached) return cached;

  modelCatalogLoadedAt.set(cacheKey, Date.now());
  const modelCatalogPromise = (async () => {
    const models: ModelCatalogEntry[] = [];
    const sortModels = (entries: ModelCatalogEntry[]) =>
      entries.sort((a, b) => {
        const p = a.provider.localeCompare(b.provider);
        if (p !== 0) return p;
        return a.name.localeCompare(b.name);
      });
    try {
      const cfg = params?.config ?? loadConfig();
      await ensureInfiniBotModelsJson(cfg);
      // IMPORTANT: keep the dynamic import *inside* the try/catch.
      // If this fails once (e.g. during a pnpm install that temporarily swaps node_modules),
      // we must not poison the cache with a rejected promise (otherwise all channel handlers
      // will keep failing until restart).
      const piSdk = await importPiSdk();
      const agentDir = cacheKey;
      const authStorage = piSdk.discoverAuthStorage(agentDir);
      const registry = piSdk.discoverModels(authStorage, agentDir) as
        | {
            getAll: () => Array<DiscoveredModel>;
          }
        | Array<DiscoveredModel>;
      const entries = Array.isArray(registry) ? registry : registry.getAll();
      for (const entry of entries) {
        const id = String(entry?.id ?? "").trim();
        if (!id) continue;
        const provider = String(entry?.provider ?? "").trim();
        if (!provider) continue;
        const name = String(entry?.name ?? id).trim() || id;
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
        const input = Array.isArray(entry?.input)
          ? (entry.input as Array<"text" | "image">)
          : undefined;
        const cin = entry?.cost?.input;
        const cout = entry?.cost?.output;
        const cost =
          typeof cin === "number" && typeof cout === "number"
            ? { input: cin, output: cout }
            : undefined;
        models.push({ id, name, provider, contextWindow, reasoning, input, cost });
      }

      // Line the static registry up with what providers actually serve today:
      // drop retired / non-chat ids, add current ones, refresh pricing.
      try {
        const reference = await loadCatalogReference({
          cfg,
          resolveKey: async (provider) =>
            (await resolveApiKeyForProvider({ provider, cfg, agentDir })).apiKey,
        });
        // Models the operator declared by hand are never second-guessed.
        const keep = new Set<string>();
        for (const [provider, block] of Object.entries(cfg.models?.providers ?? {})) {
          for (const m of block?.models ?? []) keep.add(`${provider}/${m.id}`);
        }
        const reconciled = reconcileCatalog(models, reference, { keep });
        models.length = 0;
        models.push(...reconciled.entries);
      } catch (error) {
        console.warn(`[model-catalog] reference reconcile skipped: ${String(error)}`);
      }

      if (models.length === 0) {
        // If we found nothing, don't cache this result so we can try again.
        modelCatalogPromises.delete(cacheKey);
      }

      return sortModels(models);
    } catch (error) {
      if (!hasLoggedModelCatalogError) {
        hasLoggedModelCatalogError = true;
        console.warn(`[model-catalog] Failed to load model catalog: ${String(error)}`);
      }
      // Don't poison the cache on transient dependency/filesystem issues.
      modelCatalogPromises.delete(cacheKey);
      if (models.length > 0) {
        return sortModels(models);
      }
      return [];
    }
  })();
  modelCatalogPromises.set(cacheKey, modelCatalogPromise);

  return modelCatalogPromise;
}

/**
 * Check if a model supports image input based on its catalog entry.
 */
export function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("image") ?? false;
}

/**
 * Find a model in the catalog by provider and model ID.
 */
export function findModelInCatalog(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = provider.toLowerCase().trim();
  const normalizedModelId = modelId.toLowerCase().trim();
  return catalog.find(
    (entry) =>
      entry.provider.toLowerCase() === normalizedProvider &&
      entry.id.toLowerCase() === normalizedModelId,
  );
}
