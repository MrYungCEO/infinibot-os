import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { localProvidersEnabled } from "../../saas/config.js";
import { type AuthProfileStore, ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import { hasAuthForProvider } from "../../agents/model-auth.js";
import {
  buildAllowedModelSet,
  isCliProvider,
  modelKey,
  normalizeProviderId,
  parseModelRef,
  resolveConfiguredModelRef,
} from "../../agents/model-selection.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  classifyModelFree,
  classifyProviderFree,
  type FreeInfo,
  type FreeKind,
  type ProviderFreeInfo,
} from "../../agents/model-free.js";
import { suggestReplacementModel } from "../../agents/model-heal.js";
import { getUnavailableModel } from "../../agents/model-unavailable.js";
import {
  type InfinibotConfig,
  loadConfig,
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import { applyMergePatch } from "../../config/merge-patch.js";

function isLocalBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local") ||
      // Private LAN / container-bridge ranges (e.g. a vLLM box at 172.17.0.1).
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Per-provider "usable right now" map for the model pickers: a credential
 * exists (same check as `infinibot models list`), or the provider is a local
 * endpoint that needs none.
 */
export function resolveProviderAvailability(
  providers: Iterable<string>,
  cfg: InfinibotConfig,
  authStore: AuthProfileStore,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const configured = (cfg.models?.providers ?? {}) as Record<string, { baseUrl?: unknown }>;
  for (const provider of providers) {
    if (out.has(provider)) continue;
    out.set(
      provider,
      // Local Ollama needs no key; its models are only listed when the daemon answered.
      provider === "ollama" ||
        isLocalBaseUrl(configured[provider]?.baseUrl) ||
        hasAuthForProvider(provider, cfg, authStore),
    );
  }
  return out;
}

export type ModelProviderInfo = { id: string; available?: boolean; free?: ProviderFreeInfo };

/**
 * Stamp the sourced free classification onto models.list rows and build the
 * per-provider summary (group-header badges, "free tier available — connect").
 */
export function annotateModelFree(
  models: Array<{
    id: string;
    provider: string;
    unconfigured?: boolean;
    available?: boolean;
    free?: FreeKind;
    freeNote?: string;
    freeSource?: string;
  }>,
  catalog: ModelCatalogEntry[],
  cfg: InfinibotConfig,
): ModelProviderInfo[] {
  const costs = new Map(catalog.map((m) => [modelKey(m.provider, m.id), m]));
  const configured = (cfg.models?.providers ?? {}) as Record<string, { baseUrl?: unknown }>;
  const byProvider = new Map<string, { available?: boolean; infos: Array<FreeInfo | null> }>();
  for (const m of models) {
    const group = byProvider.get(m.provider) ?? { available: m.available, infos: [] };
    byProvider.set(m.provider, group);
    if (m.unconfigured) continue;
    const entry = costs.get(modelKey(m.provider, m.id));
    const info = classifyModelFree({
      provider: m.provider,
      id: m.id,
      cost: entry?.cost,
      costSource: entry?.costSource,
      local: isLocalBaseUrl(configured[m.provider]?.baseUrl),
    });
    group.infos.push(info);
    if (!info) continue;
    m.free = info.kind;
    m.freeNote = info.note;
    m.freeSource = info.verified ? `${info.source} (verified ${info.verified})` : info.source;
  }
  return Array.from(byProvider.entries()).map(([id, group]) => {
    const free =
      classifyProviderFree(id, group.infos) ??
      // A not-yet-connected local provider (placeholder row, no models listed).
      (id === "ollama"
        ? classifyProviderFree(id, [classifyModelFree({ provider: id, id: "" })])
        : null);
    return {
      id,
      ...(group.available !== undefined ? { available: group.available } : {}),
      ...(free ? { free: group.infos.length === 0 ? { ...free, count: 0 } : free } : {}),
    };
  });
}

/** Flag rows a provider recently rejected as not found, with the nearest valid model. */
export function annotateModelUnavailable(
  models: Array<{ id: string; provider: string; unavailable?: boolean; suggestion?: string }>,
  cfg: InfinibotConfig,
  suggest: (provider: string, model: string) => string | undefined = (provider, model) =>
    suggestReplacementModel({ cfg, provider, model }),
): void {
  for (const m of models) {
    if (!getUnavailableModel(m.provider, m.id)) continue;
    m.unavailable = true;
    const suggestion = suggest(m.provider, m.id);
    if (suggestion) m.suggestion = suggestion;
  }
}

// Providers we always surface in the model picker even when no model is
// configured/discovered yet, so the grid dropdown shows a "not connected"
// affordance (→ Quick Start) instead of hiding the option entirely. The fake
// `__setup__` id is marked `unconfigured` so the UI routes a click to setup
// rather than patching an unusable model onto the session. `local: true`
// entries are suppressed in cloud-only mode.
const ALWAYS_VISIBLE_PROVIDERS: Array<{ provider: string; label: string; local?: boolean }> = [
  { provider: "ollama", label: "Ollama (local)", local: true },
  { provider: "ollama-cloud", label: "Ollama Cloud" },
];

/**
 * Stamp `available` (provider has credentials / is local) and, when an
 * allowlist is configured, `allowed` onto models.list rows.
 */
export function annotateModelAccess(
  models: Array<{
    id: string;
    provider: string;
    available?: boolean;
    allowed?: boolean;
    pinned?: boolean;
  }>,
  catalog: ModelCatalogEntry[],
  cfg: InfinibotConfig,
  authStore: AuthProfileStore,
): void {
  const availability = resolveProviderAvailability(
    models.map((m) => m.provider),
    cfg,
    authStore,
  );
  const def = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const allow = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider: def.provider,
    defaultModel: def.model,
  });
  const pinned = pinnedModelKeys(cfg, def.provider);
  for (const m of models) {
    const key = modelKey(m.provider, m.id);
    m.available = availability.get(m.provider) ?? true;
    if (!allow.allowAny) m.allowed = allow.allowedKeys.has(key);
    if (pinned.has(key)) m.pinned = true;
  }
}

/** Normalized keys of the models listed in agents.defaults.models ("your models"). */
function pinnedModelKeys(cfg: InfinibotConfig, defaultProvider: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    const parsed = parseModelRef(raw, defaultProvider);
    if (!parsed) continue;
    const key = modelKey(parsed.provider, parsed.model);
    out.set(key, [...(out.get(key) ?? []), raw]);
  }
  return out;
}

export type AllowlistChangePlan =
  | { ok: true; key: string; changed: boolean; patch: Record<string, unknown> | null }
  | { ok: false; error: string };

/**
 * Work out the agents.defaults.models merge patch that adds or removes one
 * model. Adding is limited to models the allowlist can actually honour (in the
 * catalog, a CLI provider, or an explicitly configured provider) so a pick can
 * never be saved and still rejected by sessions.patch.
 */
export function planAllowlistChange(params: {
  cfg: InfinibotConfig;
  catalog: ModelCatalogEntry[];
  action: "add" | "remove";
  model: string;
}): AllowlistChangePlan {
  const { cfg, catalog, action } = params;
  const raw = params.model.trim();
  if (!raw) return { ok: false, error: "model required" };
  const def = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const ref = parseModelRef(raw, def.provider);
  if (!ref) return { ok: false, error: `invalid model: ${raw}` };
  const key = modelKey(ref.provider, ref.model);
  const existing = pinnedModelKeys(cfg, def.provider).get(key) ?? [];
  const wrap = (models: Record<string, unknown>) => ({ agents: { defaults: { models } } });

  if (action === "remove") {
    if (existing.length === 0) return { ok: true, key, changed: false, patch: null };
    return {
      ok: true,
      key,
      changed: true,
      patch: wrap(Object.fromEntries(existing.map((k) => [k, null]))),
    };
  }

  if (existing.length > 0) return { ok: true, key, changed: false, patch: null };
  const configured = (cfg.models?.providers ?? {}) as Record<string, unknown>;
  const known =
    catalog.some((entry) => modelKey(entry.provider, entry.id) === key) ||
    isCliProvider(ref.provider, cfg) ||
    configured[normalizeProviderId(ref.provider)] != null;
  if (!known) return { ok: false, error: `unknown model: ${key}` };
  return { ok: true, key, changed: true, patch: wrap({ [key]: {} }) };
}

/**
 * Apply an allowlist change to the config file. agents.* is read live through
 * loadConfig(), so this never restarts the gateway (unlike config.patch).
 */
async function changeAllowlist(
  action: "add" | "remove",
  params: unknown,
  catalog: ModelCatalogEntry[],
): Promise<
  { ok: true; key: string; changed: boolean; models: string[] } | { ok: false; error: string }
> {
  const model = (params as { model?: unknown } | null)?.model;
  if (typeof model !== "string") return { ok: false, error: "model (string) required" };
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) return { ok: false, error: "invalid config; fix before changing models" };
  const plan = planAllowlistChange({ cfg: snapshot.config, catalog, action, model });
  if (!plan.ok) return plan;
  let next = snapshot.config;
  if (plan.patch) {
    const validated = validateConfigObjectWithPlugins(applyMergePatch(snapshot.config, plan.patch));
    if (!validated.ok) return { ok: false, error: "invalid config" };
    await writeConfigFile(validated.config);
    next = validated.config;
  }
  return {
    ok: true,
    key: plan.key,
    changed: plan.changed,
    models: Object.keys(next.agents?.defaults?.models ?? {}),
  };
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const catalog = await context.loadGatewayModelCatalog();
      // Surface a flat `vision` flag derived from the catalog's `input`
      // modality list so model-picker capability filters work client-side
      // without leaking the full input array shape over the wire.
      const models: Array<{
        id: string;
        name: string;
        provider: string;
        contextWindow?: number;
        reasoning?: boolean;
        vision?: boolean;
        unconfigured?: boolean;
        /** false when the provider has no credential (picker shows it disabled). */
        available?: boolean;
        /** false when agents.defaults.models (the allowlist) excludes it — sessions.patch would reject it. */
        allowed?: boolean;
        /** true when agents.defaults.models lists it explicitly (removable from "your models"). */
        pinned?: boolean;
        free?: FreeKind;
        freeNote?: string;
        freeSource?: string;
        unavailable?: boolean;
        suggestion?: string;
      }> = catalog.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        contextWindow: m.contextWindow,
        reasoning: m.reasoning,
        vision: Array.isArray(m.input) ? m.input.includes("image") : undefined,
      }));
      try {
        annotateModelAccess(models, catalog, loadConfig(), ensureAuthProfileStore());
      } catch {
        // Availability is advisory — never fail the catalog over it.
      }

      // Ensure Ollama / Ollama Cloud always appear as provider groups, even on
      // a fresh machine with no local daemon and no cloud key — the UI renders
      // these as a "not connected" entry that opens Quick Start.
      const allowLocal = localProvidersEnabled();
      for (const ph of ALWAYS_VISIBLE_PROVIDERS) {
        if (ph.local && !allowLocal) continue;
        if (!models.some((m) => m.provider === ph.provider)) {
          models.push({
            id: "__setup__",
            name: `${ph.label} — not connected`,
            provider: ph.provider,
            unconfigured: true,
          });
        }
      }

      let providers: ModelProviderInfo[] = [];
      try {
        const cfg = loadConfig();
        providers = annotateModelFree(models, catalog, cfg);
        annotateModelUnavailable(models, cfg);
      } catch {
        // Badges are advisory — never fail the catalog over them.
      }

      respond(true, { models, providers }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.allowlist.add": async ({ params, respond, context }) => {
    try {
      const res = await changeAllowlist("add", params, await context.loadGatewayModelCatalog());
      if (!res.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, res.error));
        return;
      }
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.allowlist.remove": async ({ params, respond, context }) => {
    try {
      const res = await changeAllowlist("remove", params, await context.loadGatewayModelCatalog());
      if (!res.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, res.error));
        return;
      }
      respond(true, res, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
