import type { InfinibotConfig } from "../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
} from "./failover-error.js";
import {
  buildModelAliasIndex,
  isCliProvider,
  modelKey,
  parseModelRef,
  resolveConfiguredModelRefRaw,
  resolveModelRefFromString,
} from "./model-selection.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import {
  ensureAuthProfileStore,
  isProfileInCooldown,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { logModelHealed, resolveHealCandidates, type HealCandidate } from "./model-heal.js";
import { planSecureFallbackCandidates, type SecureModelDeps } from "../secure-mode/local-models.js";
import { checkSecureModelAsync } from "../secure-mode/policy.js";
import { isSecureSessionKey } from "../secure-mode/session-key.js";
import { emitSecureModelNotice } from "./turn-failure.js";
import { resolveRunCliRoute } from "./cli-routing-run.js";
import { clearModelUnavailable, markModelUnavailable } from "./model-unavailable.js";
import {
  getOllamaSafetyNetFallbacksAsync,
  logOllamaSafetyNetExercised,
} from "./ollama-safety-net.js";

type ModelCandidate = {
  provider: string;
  model: string;
};

type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (isFailoverError(err)) return false;
  const name = "name" in err ? String(err.name) : "";
  // Only treat explicit AbortError names as user aborts.
  // Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isAbortError(err) && !isTimeoutError(err);
}

function buildAllowedModelKeys(
  cfg: InfinibotConfig | undefined,
  defaultProvider: string,
): Set<string> | null {
  const rawAllowlist = (() => {
    const modelMap = cfg?.agents?.defaults?.models ?? {};
    return Object.keys(modelMap);
  })();
  if (rawAllowlist.length === 0) return null;
  const keys = new Set<string>();
  for (const raw of rawAllowlist) {
    const parsed = parseModelRef(String(raw ?? ""), defaultProvider);
    if (!parsed) continue;
    keys.add(modelKey(parsed.provider, parsed.model));
  }
  return keys.size > 0 ? keys : null;
}

function resolveImageFallbackCandidates(params: {
  cfg: InfinibotConfig | undefined;
  defaultProvider: string;
  modelOverride?: string;
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
  });
  const allowlist = buildAllowedModelKeys(params.cfg, params.defaultProvider);
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) return;
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) return;
    if (enforceAllowlist && allowlist && !allowlist.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const addRaw = (raw: string, enforceAllowlist: boolean) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (!resolved) return;
    addCandidate(resolved.ref, enforceAllowlist);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride, false);
  } else {
    const imageModel = params.cfg?.agents?.defaults?.imageModel as
      | { primary?: string }
      | string
      | undefined;
    const primary = typeof imageModel === "string" ? imageModel.trim() : imageModel?.primary;
    if (primary?.trim()) addRaw(primary, false);
  }

  const imageFallbacks = (() => {
    const imageModel = params.cfg?.agents?.defaults?.imageModel as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (imageModel && typeof imageModel === "object") {
      return imageModel.fallbacks ?? [];
    }
    return [];
  })();

  for (const raw of imageFallbacks) {
    addRaw(raw, true);
  }

  return candidates;
}

function resolveFallbackCandidates(params: {
  cfg: InfinibotConfig | undefined;
  provider: string;
  model: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
}): ModelCandidate[] {
  // Raw: the configured default model. A routed run passes its CLI chain as
  // fallbacksOverride; a non-routed one (cliRouting: false) must not fall
  // back onto the default agent's subscription CLI.
  const primary = params.cfg
    ? resolveConfiguredModelRefRaw({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const provider = String(params.provider ?? "").trim() || defaultProvider;
  const model = String(params.model ?? "").trim() || defaultModel;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });
  const allowlist = buildAllowedModelKeys(params.cfg, defaultProvider);
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) return;
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) return;
    // CLI providers (claude-cli, codex-cli, …) have no catalog entry: subscription
    // CLI routing puts them in the fallback chain regardless of the allowlist.
    if (
      enforceAllowlist &&
      allowlist &&
      !allowlist.has(key) &&
      !isCliProvider(candidate.provider, params.cfg)
    )
      return;
    seen.add(key);
    candidates.push(candidate);
  };

  addCandidate({ provider, model }, false);

  const modelFallbacks = (() => {
    if (params.fallbacksOverride !== undefined) return params.fallbacksOverride;
    const model = params.cfg?.agents?.defaults?.model as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (model && typeof model === "object") return model.fallbacks ?? [];
    return [];
  })();

  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider,
      aliasIndex,
    });
    if (!resolved) continue;
    addCandidate(resolved.ref, true);
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addCandidate({ provider: primary.provider, model: primary.model }, false);
  }

  return candidates;
}

export async function runWithModelFallback<T>(params: {
  cfg: InfinibotConfig | undefined;
  provider: string;
  model: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  run: (provider: string, model: string) => Promise<T>;
  onError?: (attempt: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => void | Promise<void>;
  /**
   * Fired once when the requested model was unavailable (not in its provider's
   * catalog — e.g. retired upstream) and the turn succeeded on another model.
   */
  onModelHealed?: (info: { from: string; to: string; message: string }) => void | Promise<void>;
  /** Test seam: replaces the catalog-backed heal candidate resolver. */
  resolveHealCandidates?: (failed: { provider: string; exclude: Set<string> }) => HealCandidate[];
  /**
   * Session the run belongs to. A Secure Mode session runs on local models
   * only: a remote requested model moves to the secure default, remote
   * fallbacks are dropped, and nothing remote is ever attempted.
   */
  sessionKey?: string;
  /** With sessionKey: run id for the "Secure Mode: using <model>" notice. */
  runId?: string;
  /** Test seam for the secure local-model probe. */
  secureDeps?: SecureModelDeps;
  /**
   * false = never apply "route all traffic" (cliRouting.allTraffic) to this
   * run. For internal runs whose `run` callback can't drive a CLI.
   */
  cliRouting?: false;
}): Promise<{
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  /** "provider/model" originally requested, when the run healed onto another model. */
  healedFrom?: string;
}> {
  const forced = resolveRunCliRoute(params);
  if (forced) {
    params = { ...params, ...forced };
  }
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
  });

  // Universal Ollama safety net: when the caller hasn't supplied an explicit
  // fallbacks override and the config flag isn't disabled, append local Ollama
  // models as last-resort candidates so configured-provider outages still
  // resolve to a working local model. ON by default for standardization.
  const safetyNetKeys = new Set<string>();
  if (params.fallbacksOverride === undefined) {
    const safetyNetFlag = params.cfg?.agents?.defaults?.model as
      | { ollamaSafetyNet?: boolean }
      | string
      | undefined;
    const safetyNetEnabled =
      !safetyNetFlag ||
      typeof safetyNetFlag === "string" ||
      safetyNetFlag.ollamaSafetyNet !== false;
    if (safetyNetEnabled) {
      const seenKeys = new Set(candidates.map((c) => modelKey(c.provider, c.model)));
      const safetyNet = await getOllamaSafetyNetFallbacksAsync({ cfg: params.cfg });
      for (const raw of safetyNet) {
        const parsed = parseModelRef(raw, DEFAULT_PROVIDER);
        if (!parsed) continue;
        const key = modelKey(parsed.provider, parsed.model);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        safetyNetKeys.add(key);
        candidates.push({ provider: parsed.provider, model: parsed.model });
      }
    }
  }

  const secureSession = isSecureSessionKey(params.sessionKey);
  if (secureSession) {
    // Throws SecureModeBlockedError (not a failover error) when no local
    // model is reachable, so the turn fails clearly instead of going remote.
    const plan = await planSecureFallbackCandidates({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      candidates,
      deps: params.secureDeps,
    });
    candidates.splice(0, candidates.length, ...plan.candidates);
    if (plan.switchedFrom && params.runId) {
      emitSecureModelNotice({
        runId: params.runId,
        sessionKey: params.sessionKey,
        from: plan.switchedFrom,
        to: `${plan.first.provider}/${plan.first.model}`,
      });
    }
  }

  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;
  let healInjected = false;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i] as ModelCandidate;
    if (secureSession) {
      // Self-heal replacements are spliced in later; they must be local too.
      const v = await checkSecureModelAsync({
        provider: candidate.provider,
        modelId: candidate.model,
        cfg: params.cfg,
      });
      if (!v.allowed) continue;
    }
    if (authStore) {
      const profileIds = resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
      });
      const isAnyProfileAvailable = profileIds.some((id) => !isProfileInCooldown(authStore, id));

      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        // All profiles for this provider are in cooldown; skip without attempting
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          error: `Provider ${candidate.provider} is in cooldown (all profiles unavailable)`,
          reason: "rate_limit",
        });
        continue;
      }
    }
    if (safetyNetKeys.has(modelKey(candidate.provider, candidate.model))) {
      logOllamaSafetyNetExercised(`${candidate.provider}/${candidate.model}`);
    }
    try {
      const result = await params.run(candidate.provider, candidate.model);
      clearModelUnavailable(candidate.provider, candidate.model);
      let healedFrom: string | undefined;
      if (i > 0 && attempts[0]?.reason === "model_not_found") {
        healedFrom = `${attempts[0].provider}/${attempts[0].model}`;
        const to = `${candidate.provider}/${candidate.model}`;
        const message = logModelHealed(healedFrom, to);
        try {
          await params.onModelHealed?.({ from: healedFrom, to, message });
        } catch {
          // Notification only — never fail a successful turn over it.
        }
      }
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
        ...(healedFrom ? { healedFrom } : {}),
      };
    } catch (err) {
      if (shouldRethrowAbort(err)) throw err;
      const normalized =
        coerceToFailoverError(err, {
          provider: candidate.provider,
          model: candidate.model,
        }) ?? err;
      if (!isFailoverError(normalized)) throw err;

      lastError = normalized;
      const described = describeFailoverError(normalized);
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described.message,
        reason: described.reason,
        status: described.status,
        code: described.code,
      });
      if (described.reason === "model_not_found") {
        // Remembered so models.list can flag it instead of offering it again.
        markModelUnavailable(candidate.provider, candidate.model, described.message);
      }
      if (described.reason === "model_not_found" && !healInjected) {
        // Self-heal: splice catalog-backed, credentialed replacements in after
        // the configured fallbacks and before the local Ollama safety net.
        healInjected = true;
        const exclude = new Set(candidates.map((c) => modelKey(c.provider, c.model)));
        let heal: HealCandidate[] = [];
        try {
          heal = params.resolveHealCandidates
            ? params.resolveHealCandidates({ provider: candidate.provider, exclude })
            : resolveHealCandidates({
                cfg: params.cfg,
                agentDir: params.agentDir,
                failedProvider: candidate.provider,
                failedModel: candidate.model,
                exclude,
              });
        } catch {
          heal = [];
        }
        if (heal.length > 0) {
          const firstSafetyNet = candidates.findIndex(
            (c, idx) => idx > i && safetyNetKeys.has(modelKey(c.provider, c.model)),
          );
          const insertAt = firstSafetyNet === -1 ? candidates.length : firstSafetyNet;
          candidates.splice(insertAt, 0, ...heal);
        }
      }
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: normalized,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  if (attempts.length <= 1 && lastError) throw lastError;
  const summary =
    attempts.length > 0
      ? attempts
          .map(
            (attempt) =>
              `${attempt.provider}/${attempt.model}: ${attempt.error}${
                attempt.reason ? ` (${attempt.reason})` : ""
              }`,
          )
          .join(" | ")
      : "unknown";
  throw new Error(`All models failed (${attempts.length || candidates.length}): ${summary}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

export async function runWithImageModelFallback<T>(params: {
  cfg: InfinibotConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: (attempt: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => void | Promise<void>;
}): Promise<{
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}> {
  const candidates = resolveImageFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i] as ModelCandidate;
    try {
      const result = await params.run(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      if (shouldRethrowAbort(err)) throw err;
      lastError = err;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: err instanceof Error ? err.message : String(err),
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  if (attempts.length <= 1 && lastError) throw lastError;
  const summary =
    attempts.length > 0
      ? attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`)
          .join(" | ")
      : "unknown";
  throw new Error(`All image models failed (${attempts.length || candidates.length}): ${summary}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}
