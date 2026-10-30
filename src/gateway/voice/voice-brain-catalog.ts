/**
 * Voice brain catalogue — everything the Voice page's brain picker can point a
 * call at, in one payload (`voice.brain.catalog`):
 *
 *   api    every chat provider of the shared onboarding catalogue
 *          (src/saas/onboarding-catalog.ts). Configured ones (an auth profile
 *          or env key on this gateway) carry their LIVE curated model list
 *          (same curation as onboarding: retired models hidden, Free flagged);
 *          the rest are listed unconfigured so the UI can offer "Add key".
 *   local  models served on this machine (Ollama, vLLM, any localhost
 *          provider), from the Secure Mode local-model probe.
 *   cli    subscription CLI providers (claude-cli, codex-cli…) with their
 *          installed / signed-in state (cliRouting.status).
 *
 * Keys never leave the gateway: the model lists are fetched here with the
 * stored credential. Lists are cached briefly per provider so opening the
 * picker repeatedly does not hammer provider APIs.
 */

import { loadConfig } from "../../config/config.js";
import type { InfinibotConfig } from "../../config/types.infinibot.js";

export type VoiceBrainModel = { id: string; label?: string; free?: boolean };

export type VoiceBrainApiProvider = {
  id: string;
  label: string;
  configured: boolean;
  models: VoiceBrainModel[];
  defaultModel?: string;
  /** The provider answered with an error (bad key, offline…). */
  error?: string;
  /** For "Add key": key placeholder, where to get one, and the OpenAI-compatible
   *  endpoint to register for providers the runtime doesn't ship. */
  keyHint?: string;
  keyUrl?: string;
  runtime?: { baseUrl: string; api: string };
};

export type VoiceBrainLocalModel = {
  ref: string;
  provider: string;
  model: string;
  reachable: boolean;
  onDemand?: boolean;
  note?: string;
};

export type VoiceBrainCliProvider = {
  id: string;
  label: string;
  account: string;
  installed: boolean;
  auth: string;
  ready: boolean;
  model: string;
  version?: string;
  installUrl: string;
};

export type VoiceBrainCatalog = {
  /** The voice brain model in use (null = the agent's model). */
  current: string | null;
  /** The agent's own primary model (what "Agent default" means). */
  agentModel: string | null;
  api: VoiceBrainApiProvider[];
  local: VoiceBrainLocalModel[];
  cli: VoiceBrainCliProvider[];
};

const LIST_TTL_MS = 5 * 60_000;
const PROVIDER_TIMEOUT_MS = 9_000;
const cache = new Map<string, { at: number; value: VoiceBrainApiProvider }>();

export function clearVoiceBrainCatalogCacheForTests(): void {
  cache.clear();
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function apiProviders(cfg: InfinibotConfig, agentId: string, fresh: boolean) {
  const [
    { ONBOARDING_PROVIDERS, onboardingProviderTitle },
    { resolveApiKeyForProvider },
    { resolveAgentDir },
    { fetchModelsFor },
    { curateModels, pickDefaultModel },
  ] = await Promise.all([
    import("../../saas/onboarding-catalog.js"),
    import("../../agents/model-auth.js"),
    import("../../agents/agent-scope.js"),
    import("../server-methods/quickstart-providers.js"),
    import("../provider-model-curation.js"),
  ]);
  const agentDir = resolveAgentDir(cfg, agentId);
  const chat = ONBOARDING_PROVIDERS.filter((p) => p.kind === "chat");
  return Promise.all(
    chat.map(async (p): Promise<VoiceBrainApiProvider> => {
      const label = onboardingProviderTitle(p);
      const meta = {
        ...(p.keyHint ? { keyHint: p.keyHint } : {}),
        ...(p.signupUrl ? { keyUrl: p.signupUrl } : {}),
        ...(p.runtime ? { runtime: { baseUrl: p.runtime.baseUrl, api: p.runtime.api } } : {}),
      };
      let apiKey: string | undefined;
      try {
        apiKey = (await resolveApiKeyForProvider({ provider: p.id, cfg, agentDir })).apiKey;
      } catch {
        apiKey = undefined;
      }
      if (!apiKey) return { id: p.id, label, configured: false, models: [], ...meta };
      const hit = cache.get(p.id);
      if (!fresh && hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
      let value: VoiceBrainApiProvider;
      try {
        const models = curateModels(
          p.id,
          await withTimeout(fetchModelsFor(p.id, { apiKey }), PROVIDER_TIMEOUT_MS, label),
        );
        value = {
          id: p.id,
          label,
          configured: true,
          models: models.slice(0, 600).map((m) => ({
            id: m.id,
            ...(m.label && m.label !== m.id ? { label: m.label } : {}),
            ...(m.free ? { free: true } : {}),
          })),
          defaultModel: pickDefaultModel(p.id, models, p.defaultModels[0]),
          ...meta,
        };
      } catch (err) {
        value = {
          id: p.id,
          label,
          configured: true,
          models: [],
          error: err instanceof Error ? err.message : String(err),
          ...meta,
        };
      }
      // Errors are retried on the next open; good lists are kept for a while.
      if (!value.error) cache.set(p.id, { at: Date.now(), value });
      return value;
    }),
  );
}

async function localModels(cfg: InfinibotConfig): Promise<VoiceBrainLocalModel[]> {
  const { listSecureModelCandidates } = await import("../../secure-mode/local-models.js");
  const all = await listSecureModelCandidates({ cfg });
  return all
    .filter((c) => c.local && (c.reachable || c.onDemand))
    .map((c) => ({
      ref: c.ref,
      provider: c.provider,
      model: c.model,
      reachable: c.reachable,
      ...(c.onDemand ? { onDemand: true } : {}),
      ...(c.note ? { note: c.note } : {}),
    }));
}

async function cliProviders(cfg: InfinibotConfig): Promise<VoiceBrainCliProvider[]> {
  const { buildCliRoutingStatus } = await import("../server-methods/cli-routing.js");
  const st = await buildCliRoutingStatus(cfg);
  if (!st.available) return [];
  return st.backends.map((b) => ({
    id: b.id,
    label: b.label,
    account: b.account,
    installed: b.installed,
    auth: b.auth,
    ready: b.ready,
    model: b.model,
    ...(b.version ? { version: b.version } : {}),
    installUrl: b.installUrl,
  }));
}

export async function buildVoiceBrainCatalog(
  opts: { agentId?: string; fresh?: boolean; current?: string | null } = {},
): Promise<VoiceBrainCatalog> {
  const cfg = loadConfig();
  const agentId = opts.agentId?.trim() || "main";
  const { resolveDefaultModelForAgent } = await import("../../agents/model-selection.js");
  let agentModel: string | null = null;
  try {
    const ref = resolveDefaultModelForAgent({ cfg, agentId });
    agentModel = `${ref.provider}/${ref.model}`;
  } catch {
    agentModel = null;
  }
  const settle = <T>(p: Promise<T[]>) => p.catch(() => [] as T[]);
  const [api, local, cli] = await Promise.all([
    settle(apiProviders(cfg, agentId, opts.fresh === true)),
    settle(localModels(cfg)),
    settle(cliProviders(cfg)),
  ]);
  return { current: opts.current ?? null, agentModel, api, local, cli };
}
