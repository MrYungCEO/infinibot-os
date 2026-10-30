/**
 * infinibot_state — the user's LIVE InfiniBot state, assembled from existing
 * sources (plugin registry, setup.status, config, solatrix.agent.status,
 * coders.status). Cheap (cached 20s), best-effort (a failing probe is listed
 * in `unavailable`, never thrown) and REDACTED: no keys, tokens, URLs with
 * credentials, chat ids or wallet addresses ever leave this module.
 */

export type PluginState = {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  error?: string;
};

export type SolatrixState = {
  enabled: boolean;
  /** off | read | approval | full — agent access mode (separate from enabling the plugin). */
  agentAccess?: string;
  frozen?: { reason: string } | null;
  consentAccepted?: boolean;
  permissions?: { executeSwaps: boolean; transferFunds: boolean };
  walletCount?: number;
  rpc?: { source: string; rateLimited: boolean };
  network?: string;
  fullAccessAllowed?: boolean;
  pendingApprovals?: number;
};

export type InfinibotState = {
  at: number;
  deployment: "cloud" | "local";
  plugins: PluginState[];
  setup: Array<{ id: string; title: string; state: string; reason: string; fix?: string }>;
  models: { primary?: string; fallbacks: number; providerCheck?: string };
  channels: { configured: string[]; telegram: { configured: boolean; ownerChat: boolean } };
  approvals: { telegram: { enabled: boolean; reason?: string } };
  voice: { configured: boolean | null };
  coders: Array<{
    id: string;
    installed: boolean;
    signedIn: boolean | null;
    isDefault: boolean;
  }> | null;
  solatrix: SolatrixState | null;
  /** Main agent's tool allowlist facts (so help can say "restart needed"). */
  mainAgent: { toolsAllowlisted: boolean; hasInfinibotHelp: boolean; hasUiControl: boolean } | null;
  /** Probes that failed (name → short reason). */
  unavailable: Record<string, string>;
};

export type LiveStateDeps = {
  /** Gateway RPC (loopback). */
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  config: () => Record<string, unknown>;
  cloud: () => boolean;
  /** In-process plugin registry (null outside the gateway). */
  registryPlugins: () => Array<{
    id: string;
    name?: string;
    enabled?: boolean;
    status?: string;
    error?: string;
  }> | null;
  /** In-process setup.status (null → use RPC). */
  setupStatus?: () => Promise<unknown> | null;
  voiceConfigured?: () => Promise<boolean | null>;
  telegramApprovals?: (
    cfg: Record<string, unknown>,
  ) => Promise<{ enabled: boolean; chatId: string | null } | null>;
};

const SECRET_KEY =
  /(token|secret|password|passwd|api[-_]?key|apikey|private[-_]?key|authorization|cookie|credential|mnemonic|seed)/i;
const SECRET_VALUE =
  /^(sk-|xox[bap]-|ghp_|gho_|AKIA|eyJ)|^[1-9A-HJ-NP-Za-km-z]{60,}$|^[A-Za-z0-9+/_-]{48,}={0,2}$/;

/** Deep redaction safety net over the assembled state. */
export function redactState<T>(value: T): T {
  const walk = (v: unknown, key = ""): unknown => {
    if (SECRET_KEY.test(key) && v !== null && typeof v !== "boolean" && typeof v !== "number")
      return "[redacted]";
    if (typeof v === "string") {
      if (SECRET_VALUE.test(v.trim())) return "[redacted]";
      // URLs: keep scheme+host only (drops ?api-key=… and paths with keys).
      if (/^https?:\/\//i.test(v)) {
        try {
          const u = new URL(v);
          return `${u.protocol}//${u.hostname}`;
        } catch {
          return "[redacted]";
        }
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

function configuredChannels(cfg: Record<string, unknown>): string[] {
  const channels = rec(cfg.channels);
  return Object.entries(channels)
    .filter(([, v]) => {
      const c = rec(v);
      if (c.enabled === false) return false;
      // Configured = has any credential-ish or account entry (values never read out).
      return Object.keys(c).some((k) =>
        /token|accounts|phone|botToken|appToken|webhook|serverUrl|homeserver|apiKey|password/i.test(
          k,
        ),
      );
    })
    .map(([k]) => k)
    .sort();
}

export async function collectInfinibotState(deps: LiveStateDeps): Promise<InfinibotState> {
  const unavailable: Record<string, string> = {};
  let cfg: Record<string, unknown> = {};
  try {
    cfg = deps.config();
  } catch (e) {
    unavailable.config = errText(e);
  }
  const cloud = (() => {
    try {
      return deps.cloud();
    } catch {
      return false;
    }
  })();

  // Plugins.
  let plugins: PluginState[] = [];
  const reg = deps.registryPlugins();
  const summarize = (p: {
    id: string;
    name?: string;
    enabled?: boolean;
    status?: string;
    error?: string;
  }): PluginState => ({
    id: p.id,
    name: p.name ?? p.id,
    enabled: Boolean(p.enabled),
    status: p.status ?? (p.enabled ? "loaded" : "disabled"),
    ...(p.error ? { error: String(p.error).slice(0, 160) } : {}),
  });
  if (reg) plugins = reg.map(summarize);
  else {
    try {
      const r = rec(await deps.call("plugins.list"));
      plugins = ((r.plugins as unknown[]) ?? []).map((p) => summarize(p as PluginState));
    } catch (e) {
      unavailable.plugins = errText(e);
    }
  }
  const isLoaded = (id: string) =>
    plugins.some((p) => p.id === id && p.enabled && p.status === "loaded");

  // Setup status (non-ready only).
  let setup: InfinibotState["setup"] = [];
  try {
    const raw = rec((await deps.setupStatus?.()) ?? (await deps.call("setup.status")));
    setup = ((raw.checks as unknown[]) ?? [])
      .map((c) => rec(c))
      .filter((c) => c.state !== "ready")
      .map((c) => {
        const a = rec(c.action);
        const fix = a.label
          ? `${a.label}${a.tab ? ` (${a.tab}${a.view ? `?view=${a.view}` : ""}${a.section ? ` › ${a.section}` : ""})` : ""}`
          : undefined;
        return {
          id: String(c.id),
          title: String(c.title ?? c.id),
          state: String(c.state),
          reason: String(c.reason ?? ""),
          ...(fix ? { fix } : {}),
        };
      });
  } catch (e) {
    unavailable.setup = errText(e);
  }

  // Models (names only).
  const agents = rec(cfg.agents);
  const defaults = rec(agents.defaults);
  const model = rec(defaults.model);
  const models: InfinibotState["models"] = {
    primary:
      typeof model.primary === "string"
        ? model.primary
        : typeof defaults.model === "string"
          ? (defaults.model as string)
          : undefined,
    fallbacks: Array.isArray(model.fallbacks) ? model.fallbacks.length : 0,
    providerCheck:
      setup.find((s) => s.id === "core.models")?.state ?? (unavailable.setup ? undefined : "ready"),
  };

  // Channels + approvals.
  const configured = configuredChannels(cfg);
  const tg = rec(rec(cfg.channels).telegram);
  const ownerChat =
    tg.defaultChatId !== undefined ||
    (Array.isArray(tg.allowFrom) &&
      tg.allowFrom.some((x) => String(x ?? "").trim() && String(x) !== "*"));
  let approvals: InfinibotState["approvals"] = { telegram: { enabled: false } };
  try {
    const r = await deps.telegramApprovals?.(cfg);
    if (r) {
      approvals = {
        telegram: {
          enabled: r.enabled,
          ...(r.enabled
            ? {}
            : {
                reason:
                  rec(rec(cfg.approvals).telegram).enabled === false
                    ? "approvals.telegram.enabled is false"
                    : !configured.includes("telegram")
                      ? "no Telegram channel connected"
                      : "no owner chat id yet (message the bot once)",
              }),
        },
      };
    }
  } catch (e) {
    unavailable.approvals = errText(e);
  }

  // Voice.
  let voiceConfigured: boolean | null = null;
  try {
    voiceConfigured = (await deps.voiceConfigured?.()) ?? null;
  } catch (e) {
    unavailable.voice = errText(e);
  }

  // Coders (local only; spawns cached version probes → RPC).
  let coders: InfinibotState["coders"] = null;
  if (!cloud) {
    try {
      const r = rec(await deps.call("coders.status"));
      const list = (Array.isArray(r.coders) ? r.coders : Array.isArray(r) ? r : []) as unknown[];
      coders = list.map((c) => {
        const x = rec(c);
        // CoderAuthState: signed-in | api-key | env | signed-out | unknown | n/a
        const st = typeof x.auth === "string" ? x.auth : String(rec(x.auth).state ?? "");
        return {
          id: String(x.id),
          installed: Boolean(x.installed),
          signedIn: ["signed-in", "api-key", "env"].includes(st)
            ? true
            : st === "signed-out"
              ? false
              : null,
          isDefault: Boolean(x.isDefault),
        };
      });
    } catch (e) {
      unavailable.coders = errText(e);
    }
  }

  // Solatrix (only when loaded — its RPCs don't exist otherwise).
  let solatrix: SolatrixState | null = null;
  const solatrixKnown = plugins.find((p) => p.id === "solatrix");
  if (solatrixKnown) {
    solatrix = { enabled: isLoaded("solatrix") };
    if (solatrix.enabled) {
      try {
        const s = rec(await deps.call("solatrix.agent.status"));
        const grants = rec(s.grants);
        const frozen = s.frozen ? rec(s.frozen) : null;
        const rpc = rec(s.rpc);
        solatrix = {
          enabled: true,
          agentAccess: typeof s.mode === "string" ? s.mode : undefined,
          frozen: frozen ? { reason: String(frozen.reason ?? "kill switch") } : null,
          consentAccepted: Boolean(s.consent),
          permissions: {
            executeSwaps: Boolean(grants.swaps),
            transferFunds: Boolean(grants.transfers),
          },
          walletCount: Array.isArray(s.wallets) ? s.wallets.length : undefined,
          rpc: rpc.source
            ? { source: String(rpc.source), rateLimited: Boolean(rpc.rateLimited) }
            : undefined,
          network: typeof s.network === "string" ? s.network : undefined,
          fullAccessAllowed:
            typeof rec(s.platform).fullAccessAllowed === "boolean"
              ? Boolean(rec(s.platform).fullAccessAllowed)
              : undefined,
          pendingApprovals: typeof s.pending === "number" ? s.pending : undefined,
        };
      } catch (e) {
        unavailable.solatrix = errText(e);
      }
    }
  }

  // Main agent allowlist (tools only reach an agent when allowlisted).
  let mainAgent: InfinibotState["mainAgent"] = null;
  const main = (Array.isArray(agents.list) ? agents.list : [])
    .map(rec)
    .find((a) => a.id === "main");
  if (main) {
    const allow = rec(main.tools).allow;
    const list = Array.isArray(allow) ? allow.map(String) : null;
    mainAgent = {
      toolsAllowlisted: Boolean(list),
      hasInfinibotHelp: list ? list.includes("infinibot_help") : true,
      hasUiControl: list ? list.includes("ui_control") : true,
    };
  }

  return redactState({
    at: Date.now(),
    deployment: cloud ? "cloud" : "local",
    plugins,
    setup,
    models,
    channels: { configured, telegram: { configured: configured.includes("telegram"), ownerChat } },
    approvals,
    voice: { configured: voiceConfigured },
    coders,
    solatrix,
    mainAgent,
    unavailable,
  });
}

// ── default wiring (gateway process) ────────────────────────────────────────

let cached: { at: number; state: Promise<InfinibotState> } | null = null;
const TTL_MS = 20_000;

export async function defaultLiveStateDeps(): Promise<LiveStateDeps> {
  const [{ loadConfig }, { isSaasMode }, { getActivePluginRegistry }, { callGatewayTool }] =
    await Promise.all([
      import("../config/config.js"),
      import("../saas/config.js"),
      import("../plugins/runtime.js"),
      import("../agents/tools/gateway.js"),
    ]);
  return {
    call: (method, params) => callGatewayTool(method, { timeoutMs: 6_000 }, params ?? {}),
    config: () => loadConfig() as unknown as Record<string, unknown>,
    cloud: () => isSaasMode(),
    registryPlugins: () => {
      const r = getActivePluginRegistry();
      return r
        ? r.plugins.map((p) => ({
            id: p.id,
            name: p.name,
            enabled: p.enabled,
            status: p.status,
            error: p.error,
          }))
        : null;
    },
    setupStatus: () => {
      const r = getActivePluginRegistry();
      // In-process only inside the gateway (registry present); else RPC.
      return r
        ? import("../gateway/setup-status/registry.js").then((m) => m.getSetupStatus())
        : null;
    },
    voiceConfigured: async () => {
      const m = await import("../gateway/voice/config.js");
      return m.isVoiceConfigured();
    },
    telegramApprovals: async (cfg) => {
      const m = await import("../approvals/telegram-approvals.js");
      const r = m.resolveTelegramApprovalsConfig(cfg as never);
      return { enabled: r.enabled, chatId: r.chatId };
    },
  };
}

/** Cached live state (20s). */
export function getInfinibotState(
  opts: { force?: boolean; deps?: LiveStateDeps } = {},
): Promise<InfinibotState> {
  if (!opts.force && !opts.deps && cached && Date.now() - cached.at < TTL_MS) return cached.state;
  const state = (opts.deps ? Promise.resolve(opts.deps) : defaultLiveStateDeps()).then(
    collectInfinibotState,
  );
  if (!opts.deps) {
    cached = { at: Date.now(), state };
    state.catch(() => {
      cached = null;
    });
  }
  return state;
}

export function resetInfinibotStateCache(): void {
  cached = null;
}
