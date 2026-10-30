/**
 * Secure Mode: which local model a secure run uses.
 *
 * When Secure Mode is on and the model an agent/session is configured with is
 * remote, the run moves onto a local model automatically instead of failing:
 *
 *   1. the agent's own local models (its primary, then its fallbacks),
 *   2. `secureMode.defaultModel`,
 *   3. the suggested defaults (vllm-local/qwen3.8-27b, then the abliterated
 *      Qwen3.8 on Ollama: vision + tools),
 *   4. any other installed model on a local endpoint.
 *
 * A candidate counts only when its endpoint is local (host-locality.ts) AND
 * the server answers with that model. A remote model is never picked: when no
 * local model is reachable the run fails with a clear SecureModeBlockedError.
 */

import { runtimeForModel } from "../local-runtimes/runtime.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import type { InfinibotConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  checkSecureModelAsync,
  isRemoteCliProvider,
  resolveModelBaseUrl,
  SecureModeBlockedError,
} from "./policy.js";

export const SECURE_DEFAULT_SUGGESTIONS: readonly string[] = Object.freeze([
  "vllm-local/qwen3.8-27b",
  "ollama/huihui_ai/Qwen3.8-abliterated:latest",
]);

export type ModelRef = { provider: string; model: string };

export function parseModelRefLoose(raw: unknown): ModelRef | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) return null;
  return { provider: s.slice(0, slash).trim(), model: s.slice(slash + 1).trim() };
}

export const refKey = (r: ModelRef): string => `${r.provider}/${r.model}`;

/** Lists the model ids a local endpoint serves, or null when it does not answer. */
export type ModelLister = (baseUrl: string, provider: string) => Promise<string[] | null>;

const listCache = new Map<string, { at: number; ids: string[] | null }>();
const LIST_TTL_MS = 20_000;

/** GET {baseUrl}/models (OpenAI-compatible; Ollama serves it on /v1 too). */
export const defaultModelLister: ModelLister = async (baseUrl, provider) => {
  if (listerOverride) return listerOverride(baseUrl, provider);
  const hit = listCache.get(baseUrl);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.ids;
  let ids: string[] | null = null;
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2_500) });
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      ids = Array.isArray(body?.data)
        ? body.data.map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean)
        : [];
    }
  } catch {
    ids = null;
  }
  listCache.set(baseUrl, { at: Date.now(), ids });
  return ids;
};

let listerOverride: ModelLister | null = null;

/** Tests only: replace the live /models probe (null restores it). */
export function setSecureModelListerForTests(fn: ModelLister | null): void {
  listerOverride = fn;
  listCache.clear();
}

export type LocalModelCandidate = ModelRef & {
  ref: string;
  source: "agent" | "default" | "suggested" | "installed";
  local: boolean;
  reachable: boolean;
  /** Why it cannot be used (remote, not running, not installed). */
  note?: string;
  /**
   * Not running now, but a registry runtime (e.g. the vLLM unit) serves it and
   * the local runtime manager starts it on demand.
   */
  onDemand?: boolean;
};

function agentModelRefs(cfg: InfinibotConfig, agentId: string): ModelRef[] {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  const list: unknown[] =
    typeof raw === "string" ? [raw] : raw ? [raw.primary, ...(raw.fallbacks ?? [])] : [];
  return list.map(parseModelRefLoose).filter((r): r is ModelRef => r !== null);
}

/** Every model listed under a provider with a local endpoint, plus Ollama's installed models. */
async function installedLocalRefs(
  cfg: InfinibotConfig | undefined,
  lister: ModelLister,
): Promise<ModelRef[]> {
  const out: ModelRef[] = [];
  const providers = { ...cfg?.models?.providers } as Record<
    string,
    { baseUrl?: string; models?: Array<{ id?: string; input?: string[] }> }
  >;
  if (!providers.ollama)
    providers.ollama = { baseUrl: resolveModelBaseUrl({ provider: "ollama", cfg }) };
  for (const [provider, p] of Object.entries(providers)) {
    if (isRemoteCliProvider(provider)) continue;
    const baseUrl = resolveModelBaseUrl({ provider, cfg });
    if (!baseUrl) continue;
    const configured = (p.models ?? []).map((m) => m?.id).filter((id): id is string => !!id);
    const served = configured.length > 0 ? configured : ((await lister(baseUrl, provider)) ?? []);
    for (const id of served) {
      if (/embed/i.test(id)) continue;
      out.push({ provider, model: id });
    }
  }
  return out;
}

async function evaluate(
  ref: ModelRef,
  source: LocalModelCandidate["source"],
  cfg: InfinibotConfig | undefined,
  lister: ModelLister,
): Promise<LocalModelCandidate> {
  const base: LocalModelCandidate = {
    ...ref,
    ref: refKey(ref),
    source,
    local: false,
    reachable: false,
  };
  const verdict = await checkSecureModelAsync({ provider: ref.provider, modelId: ref.model, cfg });
  if (!verdict.allowed) {
    return { ...base, note: verdict.reason.replace(/^Blocked by Secure Mode: /, "") };
  }
  const baseUrl = resolveModelBaseUrl({ provider: ref.provider, cfg });
  const ids = baseUrl ? await lister(baseUrl, ref.provider) : null;
  if (ids === null) {
    const runtime = runtimeForModel(cfg, ref.provider, ref.model);
    if (runtime && runtime.kind === "systemd") {
      return {
        ...base,
        local: true,
        reachable: true,
        onDemand: true,
        note: `starts on demand (${runtime.label}, ≈${runtime.etaSec} s)`,
      };
    }
    return { ...base, local: true, note: `${baseUrl ?? ref.provider} is not answering` };
  }
  // An empty or unparseable list still proves the server is up; only reject
  // when the server lists models and this one is not among them.
  if (ids.length > 0 && !ids.includes(ref.model)) {
    return { ...base, local: true, note: `${ref.model} is not installed on ${baseUrl}` };
  }
  return { ...base, local: true, reachable: true };
}

export type SecureModelDeps = { lister?: ModelLister };

/**
 * Every candidate in preference order, evaluated (local? reachable?). Used by
 * the run path and by the Secure Mode settings picker (secure.models).
 */
export async function listSecureModelCandidates(params: {
  cfg: InfinibotConfig | undefined;
  agentId?: string;
  deps?: SecureModelDeps;
}): Promise<LocalModelCandidate[]> {
  const cfg = params.cfg;
  const lister = params.deps?.lister ?? defaultModelLister;
  const seen = new Set<string>();
  const ordered: Array<{ ref: ModelRef; source: LocalModelCandidate["source"] }> = [];
  const push = (ref: ModelRef | null, source: LocalModelCandidate["source"]) => {
    if (!ref) return;
    const k = refKey(ref);
    if (seen.has(k)) return;
    seen.add(k);
    ordered.push({ ref, source });
  };
  if (cfg && params.agentId) for (const r of agentModelRefs(cfg, params.agentId)) push(r, "agent");
  push(parseModelRefLoose(cfg?.secureMode?.defaultModel), "default");
  for (const s of SECURE_DEFAULT_SUGGESTIONS) push(parseModelRefLoose(s), "suggested");
  for (const r of await installedLocalRefs(cfg, lister)) push(r, "installed");
  return Promise.all(ordered.map((o) => evaluate(o.ref, o.source, cfg, lister)));
}

/** The best reachable local model for the secure default (the settings suggestion). */
export async function resolveSecureDefaultModel(params: {
  cfg: InfinibotConfig | undefined;
  deps?: SecureModelDeps;
}): Promise<LocalModelCandidate | null> {
  const all = await listSecureModelCandidates({ cfg: params.cfg, deps: params.deps });
  return all.find((c) => c.reachable && !c.onDemand) ?? all.find((c) => c.reachable) ?? null;
}

export type SecureRunModel = ModelRef & {
  /** Set when the requested model was remote and the run moved to a local one. */
  switchedFrom?: string;
  source?: LocalModelCandidate["source"] | "requested";
};

/**
 * The model a secure run actually uses. Keeps the requested model when it is
 * local; otherwise picks the agent's own local model, then the secure default,
 * then any reachable local model. Throws SecureModeBlockedError when nothing
 * local is reachable — never returns a remote model.
 */
export async function resolveSecureRunModel(params: {
  cfg: InfinibotConfig | undefined;
  sessionKey?: string;
  agentId?: string;
  provider: string;
  model: string;
  /** "provider/model" refs already tried (and failed) in this run. */
  exclude?: Set<string>;
  deps?: SecureModelDeps;
}): Promise<SecureRunModel> {
  const requested = { provider: params.provider, model: params.model };
  const reqVerdict = await checkSecureModelAsync({
    provider: requested.provider,
    modelId: requested.model,
    cfg: params.cfg,
  });
  if (reqVerdict.allowed && !params.exclude?.has(refKey(requested))) {
    return { ...requested, source: "requested" };
  }
  const agentId =
    params.agentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  const candidates = await listSecureModelCandidates({
    cfg: params.cfg,
    agentId,
    deps: params.deps,
  });
  // A stopped runtime is only auto-started for models the owner named (agent
  // model / secureMode.defaultModel) — automatic picks prefer what's running.
  const usable = (c: LocalModelCandidate) =>
    c.reachable &&
    !params.exclude?.has(c.ref) &&
    (!c.onDemand || c.source === "agent" || c.source === "default");
  const pick = candidates.find(usable);
  if (pick) {
    return {
      provider: pick.provider,
      model: pick.model,
      source: pick.source,
      ...(reqVerdict.allowed ? {} : { switchedFrom: refKey(requested) }),
    };
  }
  const tried = candidates
    .filter((c) => c.source !== "installed" || c.local)
    .slice(0, 6)
    .map(
      (c) =>
        `${c.ref}: ${c.note ?? (params.exclude?.has(c.ref) ? "already failed" : "unavailable")}`,
    );
  throw new SecureModeBlockedError(
    `no local model is reachable for this secure run (${refKey(requested)} ${
      reqVerdict.allowed ? "failed" : "is remote"
    }). Start a local model server or set secureMode.defaultModel. Checked: ${
      tried.join("; ") || "none configured"
    }.`,
  );
}

/**
 * Secure fallback chain: the first candidate becomes the resolved secure run
 * model (switched to a local one when it is remote), and every other
 * candidate is kept only when it is local. Throws when nothing local is
 * reachable.
 */
export async function planSecureFallbackCandidates(params: {
  cfg: InfinibotConfig | undefined;
  sessionKey?: string;
  candidates: ModelRef[];
  deps?: SecureModelDeps;
}): Promise<{ candidates: ModelRef[]; switchedFrom?: string; first: SecureRunModel }> {
  const [head, ...rest] = params.candidates;
  if (!head) throw new SecureModeBlockedError("no model configured for this secure run.");
  const first = await resolveSecureRunModel({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    provider: head.provider,
    model: head.model,
    deps: params.deps,
  });
  const out: ModelRef[] = [{ provider: first.provider, model: first.model }];
  const seen = new Set([refKey(first)]);
  for (const c of rest) {
    if (seen.has(refKey(c))) continue;
    seen.add(refKey(c));
    const v = await checkSecureModelAsync({
      provider: c.provider,
      modelId: c.model,
      cfg: params.cfg,
    });
    if (v.allowed) out.push(c);
  }
  return {
    candidates: out,
    first,
    ...(first.switchedFrom ? { switchedFrom: first.switchedFrom } : {}),
  };
}
