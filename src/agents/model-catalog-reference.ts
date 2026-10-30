/**
 * Reference model lists — the ground truth the static registry is reconciled
 * against (model-catalog-reconcile.ts).
 *
 * Sources, best first:
 *   1. the provider's own list-models API, when a key is configured
 *      (Google generativelanguage /v1beta/models, OpenAI-compatible /models,
 *      Anthropic /v1/models) or the list is public (OpenRouter, opencode Zen)
 *   2. models.dev (https://models.dev/api.json) — keyless, carries pricing,
 *      limits, modalities and a `deprecated` status
 *   3. nothing → the static registry is left as is
 *
 * Results are cached on disk (state dir) with a TTL; a failed refresh keeps
 * serving the last good copy, and a missing cache + no network falls back to
 * the static list. Only public catalog data is cached — never a key.
 *
 * Disable with INFINIBOT_MODEL_CATALOG_REFERENCE=off (air-gapped installs).
 */

import fs from "node:fs";
import path from "node:path";

import type { InfinibotConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  type CatalogReference,
  isChatModelId,
  type ReferenceModel,
  type ReferenceProvider,
} from "./model-catalog-reconcile.js";

const log = createSubsystemLogger("agents/model-catalog");

export const REFERENCE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const CACHE_VERSION = 1;

const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1000";

/** Built-in providers reconciled against models.dev (provider id → models.dev key). */
export const MODELS_DEV_PROVIDERS: Readonly<Record<string, string>> = {
  google: "google",
  "google-vertex": "google-vertex",
  openai: "openai",
  anthropic: "anthropic",
  groq: "groq",
  mistral: "mistral",
  xai: "xai",
  cerebras: "cerebras",
  opencode: "opencode",
};

/** OpenAI-compatible list-models endpoints (Bearer key). */
const OPENAI_COMPAT_MODELS_URL: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1/models",
  groq: "https://api.groq.com/openai/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
  xai: "https://api.x.ai/v1/models",
  cerebras: "https://api.cerebras.ai/v1/models",
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type CacheFile = {
  version: number;
  providers: Record<string, ReferenceProvider>;
  /** When models.dev was last fetched successfully (ms). */
  modelsDevAt?: number;
};

export type ReferenceLoadOptions = {
  cfg?: InfinibotConfig;
  /** Resolve a provider's API key (undefined = none). Never logged or cached. */
  resolveKey?: (provider: string) => Promise<string | undefined>;
  fetchImpl?: FetchLike;
  now?: () => number;
  cachePath?: string;
  ttlMs?: number;
};

let memo: CatalogReference | null = null;
let inflight: Promise<CatalogReference | null> | null = null;

export function resetCatalogReferenceForTest(): void {
  memo = null;
  inflight = null;
}

export function setCatalogReferenceForTest(ref: CatalogReference | null): void {
  memo = ref;
}

function referenceDisabled(opts: ReferenceLoadOptions): boolean {
  const flag = (process.env.INFINIBOT_MODEL_CATALOG_REFERENCE ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return true;
  // Unit tests never hit the network unless they inject a fetch.
  if ((process.env.VITEST || process.env.NODE_ENV === "test") && !opts.fetchImpl) return true;
  return false;
}

function defaultCachePath(): string {
  return path.join(resolveStateDir(), "cache", "model-catalog-reference.json");
}

function readCache(cachePath: string): CacheFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CacheFile;
    if (raw?.version !== CACHE_VERSION || !raw.providers || typeof raw.providers !== "object") {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, data: CacheFile): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, cachePath);
  } catch {
    // Cache is an optimisation — a read-only state dir just refetches.
  }
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

type ModelsDevModel = {
  id?: string;
  name?: string;
  reasoning?: boolean;
  status?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
};

/** models.dev provider block → reference models. */
export function mapModelsDevProvider(block: unknown): ReferenceModel[] {
  const models = (block as { models?: Record<string, ModelsDevModel> } | null)?.models;
  if (!models || typeof models !== "object") return [];
  const out: ReferenceModel[] = [];
  for (const m of Object.values(models)) {
    const id = typeof m?.id === "string" ? m.id.trim() : "";
    if (!id) continue;
    const input = m.modalities?.input ?? [];
    const cin = num(m.cost?.input);
    const cout = num(m.cost?.output);
    out.push({
      id,
      name: typeof m.name === "string" ? m.name : undefined,
      contextWindow: num(m.limit?.context) || undefined,
      maxTokens: num(m.limit?.output) || undefined,
      reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
      input: input.includes("image") ? ["text", "image"] : ["text"],
      output: Array.isArray(m.modalities?.output) ? m.modalities.output : undefined,
      ...(cin !== undefined && cout !== undefined ? { cost: { input: cin, output: cout } } : {}),
      ...(m.status === "deprecated" ? { deprecated: true } : {}),
    });
  }
  return out;
}

type OpenRouterModel = {
  id?: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
};

/** OpenRouter /api/v1/models → reference models (pricing is USD per token → per 1M). */
export function mapOpenRouterModels(body: unknown): ReferenceModel[] {
  const data = (body as { data?: OpenRouterModel[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ReferenceModel[] = [];
  for (const m of data) {
    const id = typeof m?.id === "string" ? m.id.trim() : "";
    if (!id) continue;
    const prompt = Number(m.pricing?.prompt);
    const completion = Number(m.pricing?.completion);
    const priced =
      Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0;
    const input = m.architecture?.input_modalities ?? [];
    out.push({
      id,
      name: typeof m.name === "string" ? m.name : undefined,
      contextWindow: num(m.context_length) || undefined,
      maxTokens: num(m.top_provider?.max_completion_tokens) || undefined,
      reasoning: Array.isArray(m.supported_parameters)
        ? m.supported_parameters.includes("reasoning")
        : undefined,
      input: input.includes("image") ? ["text", "image"] : ["text"],
      output: m.architecture?.output_modalities,
      ...(priced
        ? {
            cost: {
              input: Math.round(prompt * 1e6 * 1e6) / 1e6,
              output: Math.round(completion * 1e6 * 1e6) / 1e6,
            },
          }
        : {}),
    });
  }
  return out;
}

type GoogleModel = {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
};

/** Google /v1beta/models → models that can generateContent. */
export function mapGoogleModels(body: unknown): ReferenceModel[] {
  const models = (body as { models?: GoogleModel[] } | null)?.models;
  if (!Array.isArray(models)) return [];
  const out: ReferenceModel[] = [];
  for (const m of models) {
    const id = String(m?.name ?? "")
      .replace(/^models\//, "")
      .trim();
    if (!id) continue;
    if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
    out.push({
      id,
      name: m.displayName,
      contextWindow: num(m.inputTokenLimit) || undefined,
      maxTokens: num(m.outputTokenLimit) || undefined,
      reasoning: typeof m.thinking === "boolean" ? m.thinking : undefined,
    });
  }
  return out;
}

function openAiListIds(body: unknown): string[] {
  const data = (body as { data?: Array<{ id?: unknown }> } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.map((m) => (typeof m?.id === "string" ? m.id.trim() : "")).filter(Boolean);
}

/**
 * Narrow a models.dev list to what the provider's own API reports. `extras`
 * are live models models.dev doesn't know yet (kept when they look like chat
 * models, with whatever metadata the provider gave).
 */
export function narrowToLive(
  base: ReferenceModel[],
  liveIds: string[],
  extras: ReferenceModel[] = [],
): ReferenceModel[] {
  if (liveIds.length === 0) return base;
  const live = new Set(liveIds.map((id) => id.toLowerCase()));
  const kept = base.filter((m) => live.has(m.id.toLowerCase()));
  const have = new Set(kept.map((m) => m.id.toLowerCase()));
  for (const m of extras) {
    if (have.has(m.id.toLowerCase()) || !isChatModelId(m.id)) continue;
    have.add(m.id.toLowerCase());
    kept.push(m);
  }
  return kept;
}

async function fetchLive(
  provider: string,
  fetchImpl: FetchLike,
  resolveKey: (provider: string) => Promise<string | undefined>,
): Promise<{ ids: string[]; extras: ReferenceModel[] } | null> {
  if (provider === "opencode") {
    const ids = openAiListIds(await fetchJson(fetchImpl, OPENCODE_ZEN_MODELS_URL));
    return { ids, extras: ids.map((id) => ({ id })) };
  }
  const key = (await resolveKey(provider).catch(() => undefined))?.trim();
  if (!key) return null;
  if (provider === "google") {
    const models = mapGoogleModels(
      await fetchJson(fetchImpl, GOOGLE_MODELS_URL, { "x-goog-api-key": key }),
    );
    return { ids: models.map((m) => m.id), extras: models };
  }
  if (provider === "anthropic") {
    const body = await fetchJson(fetchImpl, ANTHROPIC_MODELS_URL, {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    });
    return { ids: openAiListIds(body), extras: [] };
  }
  const url = OPENAI_COMPAT_MODELS_URL[provider];
  if (!url) return null;
  return {
    ids: openAiListIds(await fetchJson(fetchImpl, url, { Authorization: `Bearer ${key}` })),
    extras: [],
  };
}

async function refresh(opts: ReferenceLoadOptions): Promise<CatalogReference | null> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? REFERENCE_TTL_MS;
  const cachePath = opts.cachePath ?? defaultCachePath();
  const resolveKey = opts.resolveKey ?? (async () => undefined);
  const cached = readCache(cachePath);
  const providers: Record<string, ReferenceProvider> = { ...cached?.providers };
  const fresh = (p: string) => {
    const hit = providers[p];
    return Boolean(hit && now() - hit.fetchedAt < ttl);
  };
  let changed = false;
  let modelsDevAt = cached?.modelsDevAt ?? 0;

  const jobs: Array<Promise<void>> = [];

  // OpenRouter: its public list IS the provider API (ids + pricing).
  if (!fresh("openrouter")) {
    jobs.push(
      fetchJson(fetchImpl, OPENROUTER_MODELS_URL)
        .then((body) => {
          const models = mapOpenRouterModels(body);
          if (models.length === 0) return;
          providers.openrouter = { source: "openrouter-api", fetchedAt: now(), models, live: true };
          changed = true;
        })
        .catch((err) => log.debug(`openrouter model list unavailable: ${String(err)}`)),
    );
  }

  // models.dev (+ the provider's own list when we hold a key). A provider that
  // is cached from models.dev only is retried for a live list on every load —
  // that is how a newly added key takes effect without waiting for the TTL.
  const devTargets = Object.keys(MODELS_DEV_PROVIDERS).filter(
    (p) => !fresh(p) || !providers[p]?.live,
  );
  if (devTargets.length > 0) {
    jobs.push(
      (async () => {
        let dev: Record<string, unknown> | null = null;
        if (!modelsDevAt || now() - modelsDevAt >= ttl) {
          try {
            dev = (await fetchJson(fetchImpl, MODELS_DEV_URL)) as Record<string, unknown>;
            modelsDevAt = now();
            changed = true;
          } catch (err) {
            log.debug(`models.dev unavailable: ${String(err)}`);
          }
        }
        await Promise.all(
          devTargets.map(async (provider) => {
            let base = providers[provider]?.models ?? [];
            let baseFresh = false;
            if (dev) {
              let mapped = mapModelsDevProvider(dev[MODELS_DEV_PROVIDERS[provider] as string]);
              // pi-ai's google-vertex transport only speaks Gemini.
              if (provider === "google-vertex")
                mapped = mapped.filter((m) => m.id.startsWith("gemini-"));
              if (mapped.length > 0) {
                base = mapped;
                baseFresh = true;
              }
            }
            let live: Awaited<ReturnType<typeof fetchLive>> = null;
            try {
              live = await fetchLive(provider, fetchImpl, resolveKey);
            } catch (err) {
              log.debug(`${provider} list-models unavailable: ${String(err)}`);
            }
            if (live && live.ids.length > 0) {
              const models = narrowToLive(base, live.ids, live.extras);
              if (models.length > 0) {
                providers[provider] = {
                  source: "provider-api",
                  fetchedAt: now(),
                  models,
                  live: true,
                };
                changed = true;
                return;
              }
            }
            if (baseFresh) {
              providers[provider] = { source: "models.dev", fetchedAt: now(), models: base };
              changed = true;
            }
          }),
        );
      })(),
    );
  }

  await Promise.all(jobs);
  if (changed) writeCache(cachePath, { version: CACHE_VERSION, providers, modelsDevAt });
  if (Object.keys(providers).length === 0) return null;
  return { providers };
}

/** Load (cached, TTL) the reference lists. Null = no reference; use the static catalog. */
export async function loadCatalogReference(
  opts: ReferenceLoadOptions = {},
): Promise<CatalogReference | null> {
  if (referenceDisabled(opts)) return null;
  if (inflight) return inflight;
  inflight = refresh(opts)
    .then((ref) => {
      memo = ref ?? memo;
      return memo;
    })
    .catch((err) => {
      log.debug(`model reference refresh failed: ${String(err)}`);
      return memo;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Last known reference without touching the network (in-memory, else the disk
 * cache at any age). Used on the hot path — model resolution and self-heal.
 */
export function getCatalogReferenceSync(cachePath?: string): CatalogReference | null {
  if (memo) return memo;
  if (referenceDisabled({})) return null;
  const cached = readCache(cachePath ?? defaultCachePath());
  if (cached && Object.keys(cached.providers).length > 0) memo = { providers: cached.providers };
  return memo;
}
