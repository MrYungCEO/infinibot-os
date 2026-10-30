/**
 * Self-healing model resolution.
 *
 * When a configured model isn't in its provider's catalog (models.json / live
 * discovery) — typically because upstream retired it, e.g.
 * ollama-cloud/kimi-k2.5 → HTTP 410 — the turn must not fail. The fallback
 * runner first tries the configured fallbacks, then asks this module for
 * replacement candidates, in order:
 *
 *   1. the failed provider's current default (PROVIDER_DEFAULT_MODEL_IDS)
 *   2. the same provider's model nearest to the failed id (same family —
 *      gemini-1.5-flash → gemini-2.5-flash), else its first available model
 *   3. one model (its default, else its first) per OTHER provider the tenant
 *      has credentials for — tenant-configured providers (models.json) first
 *
 * Every candidate must exist in the catalog AND its provider must have a
 * credential the runner will actually use (same sources as
 * resolveApiKeyForProvider): we never switch to a model the tenant can't use.
 */

import fs from "node:fs";
import path from "node:path";

import { discoverAuthStorage, discoverModels } from "@mariozechner/pi-coding-agent";

import type { InfinibotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveInfiniBotAgentDir } from "./agent-paths.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { hasAuthForProvider } from "./model-auth.js";
import { nearestModelId, reconcileCatalog } from "./model-catalog-reconcile.js";
import { getCatalogReferenceSync } from "./model-catalog-reference.js";
import { getUnavailableModel } from "./model-unavailable.js";
import { modelKey, normalizeProviderId } from "./model-selection.js";
import { buildInlineProviderModels } from "./pi-embedded-runner/model.js";
import { PROVIDER_DEFAULT_MODEL_IDS } from "./provider-model-defaults.js";

export type HealCandidate = { provider: string; model: string };

export type ModelCatalogEntry = { provider: string; id: string };

/** Max distinct *other* providers offered as last-resort heal targets. */
const MAX_OTHER_PROVIDERS = 3;

function providerDefaultModel(provider: string): string | undefined {
  const normalized = normalizeProviderId(provider);
  if (normalized === normalizeProviderId(DEFAULT_PROVIDER)) return DEFAULT_MODEL;
  return PROVIDER_DEFAULT_MODEL_IDS[normalized];
}

/**
 * Pure ordering core — catalog + credential check are injected so it is unit
 * testable without a real agent dir.
 */
export function orderHealCandidates(params: {
  failedProvider: string;
  /** The rejected model id — lets the same-provider pick stay in its family. */
  failedModel?: string;
  catalog: ModelCatalogEntry[];
  /** Provider ids in tenant-preference order (models.json order); ranked before the rest. */
  preferredProviders?: string[];
  hasCredentials: (provider: string) => boolean;
  /** Keys ("provider/model") to skip — already tried / known unavailable. */
  exclude?: Set<string>;
}): HealCandidate[] {
  const exclude = params.exclude ?? new Set<string>();
  const byProvider = new Map<string, string[]>();
  for (const entry of params.catalog) {
    const provider = normalizeProviderId(entry.provider);
    const id = String(entry.id ?? "").trim();
    if (!provider || !id) continue;
    const list = byProvider.get(provider) ?? [];
    if (!list.includes(id)) list.push(id);
    byProvider.set(provider, list);
  }

  const out: HealCandidate[] = [];
  const seen = new Set<string>(exclude);
  const push = (provider: string, model: string) => {
    const key = modelKey(provider, model);
    if (seen.has(key)) return false;
    seen.add(key);
    out.push({ provider, model });
    return true;
  };
  const credentialCache = new Map<string, boolean>();
  const credentialed = (provider: string) => {
    let ok = credentialCache.get(provider);
    if (ok === undefined) {
      try {
        ok = params.hasCredentials(provider);
      } catch {
        ok = false;
      }
      credentialCache.set(provider, ok);
    }
    return ok;
  };

  const failed = normalizeProviderId(params.failedProvider);
  const sameProviderModels = byProvider.get(failed) ?? [];
  if (sameProviderModels.length > 0 && credentialed(failed)) {
    // 1. provider default, 2. first available model of the same provider.
    const preferred = providerDefaultModel(failed);
    if (preferred && sameProviderModels.includes(preferred)) push(failed, preferred);
    const open = sameProviderModels.filter((id) => !seen.has(modelKey(failed, id)));
    const nearest = params.failedModel ? nearestModelId(params.failedModel, open) : undefined;
    if (!nearest || !push(failed, nearest)) {
      for (const id of sameProviderModels) {
        if (push(failed, id)) break;
      }
    }
  }

  // 3. first available model of any other credentialed provider.
  const preferredOrder = (params.preferredProviders ?? []).map(normalizeProviderId);
  const others = [...byProvider.keys()]
    .filter((p) => p !== failed)
    .sort((a, b) => {
      const ia = preferredOrder.indexOf(a);
      const ib = preferredOrder.indexOf(b);
      return (
        (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib)
      );
    });
  let added = 0;
  for (const provider of others) {
    if (added >= MAX_OTHER_PROVIDERS) break;
    if (!credentialed(provider)) continue;
    const models = byProvider.get(provider) ?? [];
    const preferred = providerDefaultModel(provider);
    const pick = preferred && models.includes(preferred) ? preferred : models[0];
    if (pick && push(provider, pick)) added += 1;
  }
  return out;
}

function readModelsJsonProviders(agentDir: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")) as {
      providers?: Record<string, unknown>;
    };
    return raw?.providers && typeof raw.providers === "object" ? raw.providers : {};
  } catch {
    return {};
  }
}

/**
 * Resolve heal candidates from the agent's real catalog (models.json + built-in
 * registry + inline config providers), filtered by runtime credentials.
 */
export function resolveHealCandidates(params: {
  cfg: InfinibotConfig | undefined;
  agentDir?: string;
  failedProvider: string;
  failedModel?: string;
  exclude?: Set<string>;
}): HealCandidate[] {
  const agentDir = params.agentDir ?? resolveInfiniBotAgentDir();
  const cfg = params.cfg ?? {};
  const modelsJsonProviders = readModelsJsonProviders(agentDir);

  const catalog: ModelCatalogEntry[] = [];
  try {
    const authStorage = discoverAuthStorage(agentDir);
    const registry = discoverModels(authStorage, agentDir);
    for (const m of registry.getAll()) catalog.push({ provider: m.provider, id: m.id });
  } catch {
    // Registry unreadable — fall back to inline config providers only.
  }
  for (const m of buildInlineProviderModels(cfg.models?.providers ?? {})) {
    catalog.push({ provider: m.provider, id: m.id });
  }

  // Heal onto models the provider serves today: drop ids the reference lists
  // retired, add current ones, and skip anything a provider already rejected.
  const usable = reconcileCatalog(
    catalog.map((m) => ({ ...m, name: m.id })),
    getCatalogReferenceSync(),
  ).entries.filter((m) => !getUnavailableModel(m.provider, m.id));
  catalog.length = 0;
  catalog.push(...usable.map((m) => ({ provider: m.provider, id: m.id })));

  let authStore: ReturnType<typeof ensureAuthProfileStore> | null = null;
  try {
    authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  } catch {
    authStore = null;
  }
  // Mirror resolveApiKeyForProvider exactly: auth profiles, env keys, config
  // apiKey, Bedrock AWS env — plus keyless local Ollama. A models.json apiKey
  // alone is NOT enough (the runner won't use it → "No API key found").
  const hasCredentials = (provider: string) => {
    if (provider === "ollama") return true;
    return authStore ? hasAuthForProvider(provider, cfg, authStore) : false;
  };

  return orderHealCandidates({
    failedProvider: params.failedProvider,
    failedModel: params.failedModel,
    catalog,
    preferredProviders: [
      ...Object.keys(modelsJsonProviders),
      ...Object.keys(cfg.models?.providers ?? {}),
    ],
    hasCredentials,
    exclude: params.exclude,
  });
}

const log = createSubsystemLogger("agents/model-heal");
const warnedHeals = new Set<string>();

/** One clear warning per (from → to) per process. Returns the message. */
export function logModelHealed(from: string, to: string): string {
  const message = `model ${from} unavailable (retired?) — using ${to}`;
  const key = `${from}→${to}`;
  if (!warnedHeals.has(key)) {
    warnedHeals.add(key);
    log.warn(message);
  }
  return message;
}

/** Test-only: reset the once-per-process warning memo. */
export function resetModelHealWarningsForTest(): void {
  warnedHeals.clear();
}

/**
 * The model to suggest in place of one that turned out to be unavailable:
 * a heal candidate (credentials held), preferring the same provider's nearest
 * relative.
 */
export function suggestReplacementModel(params: {
  cfg: InfinibotConfig | undefined;
  agentDir?: string;
  provider: string;
  model: string;
}): string | undefined {
  try {
    const candidates = resolveHealCandidates({
      cfg: params.cfg,
      agentDir: params.agentDir,
      failedProvider: params.provider,
      failedModel: params.model,
      exclude: new Set([modelKey(params.provider, params.model)]),
    });
    // For a suggestion the closest relative beats the provider default
    // (kimi-k2.5 → kimi-k2.6 rather than gpt-oss:120b).
    const failed = normalizeProviderId(params.provider);
    const same = candidates.filter((c) => normalizeProviderId(c.provider) === failed);
    const nearest = nearestModelId(
      params.model,
      same.map((c) => c.model),
    );
    const pick = same.find((c) => c.model === nearest) ?? candidates[0];
    return pick ? `${pick.provider}/${pick.model}` : undefined;
  } catch {
    return undefined;
  }
}
