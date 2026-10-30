/**
 * Secure Mode readiness per agent (Agents page).
 *
 * A secure run uses the agent's own primary model, and the gateway refuses it
 * unless that model is served from this machine (src/secure-mode/policy.ts) —
 * there is no fallback to a hosted model. So "can this agent run in Secure
 * Mode?" is exactly the gateway's `secure.check {model}` verdict for the
 * agent's effective primary model. CLI agents never can (no local-CLI
 * exception). Nothing is guessed client-side: verdicts come from the gateway.
 *
 * The pure helpers run under node vitest; the small cache below fetches the
 * verdicts and the installed local models once per Secure Mode session.
 */

export type SecureVerdict = { allowed: boolean; reason?: string };

export type AgentSecureInput = {
  type: "native" | "cli" | string;
  /** Roster entries for CLI coder backends (no config agent behind them). */
  virtual?: boolean;
  /** Configured model ("provider/model"), or "default" / "" for the defaults primary. */
  model: string;
};

export type AgentSecureReadiness =
  | { kind: "ready"; modelRef: string }
  | { kind: "blocked"; modelRef: string; reason: string }
  | { kind: "cli"; reason: string }
  | { kind: "checking"; modelRef: string | null };

export const CLI_SECURE_REASON =
  "CLI coder backends call a hosted API, so they never run in Secure Mode.";

/** The model a run actually uses: the agent's own, else agents.defaults.model.primary. */
export function effectiveModelRef(agentModel: string | null | undefined, defaultModel: string | null | undefined): string | null {
  const own = (agentModel ?? "").trim();
  if (own && own !== "default") return own;
  const def = (defaultModel ?? "").trim();
  return def || null;
}

export function agentSecureReadiness(
  agent: AgentSecureInput,
  defaultModel: string | null | undefined,
  verdicts: ReadonlyMap<string, SecureVerdict>,
): AgentSecureReadiness {
  if (agent.virtual || agent.type === "cli") return { kind: "cli", reason: CLI_SECURE_REASON };
  const ref = effectiveModelRef(agent.model, defaultModel);
  if (!ref) {
    return { kind: "blocked", modelRef: "", reason: "No model is configured for this agent." };
  }
  const v = verdicts.get(ref);
  if (!v) return { kind: "checking", modelRef: ref };
  if (v.allowed) return { kind: "ready", modelRef: ref };
  return {
    kind: "blocked",
    modelRef: ref,
    reason: (v.reason ?? "This model is not served from this machine.").replace(/^Blocked by Secure Mode:\s*/, ""),
  };
}

export type CatalogModel = { id: string; provider: string; name?: string; unconfigured?: boolean; available?: boolean };

/** Embedding / reranker models cannot drive an agent. */
const NON_CHAT_MODEL = /(^|[-_/:.])(embed|embedding|rerank|reranker)([-_/:.]|$)|nomic-embed|bge-/i;

function refOf(m: CatalogModel): string {
  return `${m.provider}/${m.id}`;
}

function usable(m: CatalogModel): boolean {
  return Boolean(m.id && m.provider && m.id !== "__setup__" && !m.unconfigured && !NON_CHAT_MODEL.test(m.id));
}

/** One probe model ref per provider; the local/remote verdict is per endpoint. */
export function providerProbeRefs(catalog: readonly CatalogModel[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of catalog) {
    if (!usable(m) || out.has(m.provider)) continue;
    out.set(m.provider, refOf(m));
  }
  return out;
}

/** Installed models whose provider the gateway confirmed is served locally. */
export function localModelOptions(
  catalog: readonly CatalogModel[],
  providerVerdicts: ReadonlyMap<string, SecureVerdict>,
): Array<{ ref: string; label: string; provider: string }> {
  const seen = new Set<string>();
  const out: Array<{ ref: string; label: string; provider: string }> = [];
  for (const m of catalog) {
    if (!usable(m) || providerVerdicts.get(m.provider)?.allowed !== true) continue;
    const ref = refOf(m);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, label: m.name && m.name !== m.id ? `${m.name}` : m.id, provider: m.provider });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

// ── runtime cache ──────────────────────────────────────────────────────────

type RequestClient = { request<T = unknown>(method: string, params?: unknown): Promise<T> };

function parseVerdict(raw: unknown): SecureVerdict | null {
  const m = (raw as { model?: { allowed?: unknown; reason?: unknown } } | null)?.model;
  if (!m || typeof m.allowed !== "boolean") return null;
  return { allowed: m.allowed, ...(typeof m.reason === "string" ? { reason: m.reason } : {}) };
}

export type SecureAgentsCache = {
  verdicts: Map<string, SecureVerdict>;
  local: Array<{ ref: string; label: string; provider: string }> | null;
  localError: string | null;
  localLoading: boolean;
};

export const secureAgentsCache: SecureAgentsCache = {
  verdicts: new Map(),
  local: null,
  localError: null,
  localLoading: false,
};

const inflight = new Set<string>();

/** Fetch `secure.check` verdicts for refs not cached yet; calls onUpdate as they land. */
export function ensureSecureVerdicts(client: RequestClient, refs: Iterable<string>, onUpdate: () => void): void {
  for (const ref of refs) {
    if (!ref || secureAgentsCache.verdicts.has(ref) || inflight.has(ref)) continue;
    inflight.add(ref);
    void client
      .request<unknown>("secure.check", { model: ref })
      .then((res) => {
        const v = parseVerdict(res);
        secureAgentsCache.verdicts.set(ref, v ?? { allowed: false, reason: "The gateway returned no verdict for this model." });
      })
      .catch((err: unknown) => {
        secureAgentsCache.verdicts.set(ref, {
          allowed: false,
          reason: `Could not check this model: ${err instanceof Error ? err.message : String(err)}`,
        });
      })
      .finally(() => {
        inflight.delete(ref);
        onUpdate();
      });
  }
}

/** Load installed models (models.list) and keep the ones the gateway calls local. */
export async function ensureLocalModels(client: RequestClient, onUpdate: () => void): Promise<void> {
  if (secureAgentsCache.local || secureAgentsCache.localLoading) return;
  secureAgentsCache.localLoading = true;
  secureAgentsCache.localError = null;
  try {
    const res = await client.request<{ models?: CatalogModel[] }>("models.list", {});
    const catalog = Array.isArray(res?.models) ? res.models : [];
    const probes = providerProbeRefs(catalog);
    const providerVerdicts = new Map<string, SecureVerdict>();
    await Promise.all(
      [...probes].map(async ([provider, ref]) => {
        try {
          const v = parseVerdict(await client.request<unknown>("secure.check", { model: ref }));
          if (v) providerVerdicts.set(provider, v);
        } catch {
          /* unknown provider → not offered */
        }
      }),
    );
    secureAgentsCache.local = localModelOptions(catalog, providerVerdicts);
  } catch (err) {
    secureAgentsCache.localError = err instanceof Error ? err.message : String(err);
  } finally {
    secureAgentsCache.localLoading = false;
    onUpdate();
  }
}

/** Drop cached verdicts (model / config change, Secure Mode toggled). */
export function resetSecureAgentsCache(): void {
  secureAgentsCache.verdicts.clear();
  secureAgentsCache.local = null;
  secureAgentsCache.localError = null;
  secureAgentsCache.localLoading = false;
  inflight.clear();
}
