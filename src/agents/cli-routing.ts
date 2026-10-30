/**
 * Subscription CLI routing — run a gateway agent's chat through the user's
 * logged-in CLI coding agent (Claude Code, Codex, Gemini CLI, Grok Build,
 * OpenCode) instead of an API-key model provider.
 *
 * The CLIs are real model providers (`claude-cli/sonnet`, `codex-cli/…`, see
 * cli-backends.ts + cli-runner.ts), so routing is just a model decision: when
 * it applies to an agent, the agent's primary model becomes the first
 * installed CLI in `cliRouting.providers` and its fallbacks become the rest.
 * Model pickers, sessions, failover and every channel then work unchanged.
 *
 * Off by default (`cliRoutingEnabled`). `agents.list[].cliRouting` overrides
 * per agent (true = always, false = never). Agents on a local model (Ollama,
 * vLLM, …) keep it: they need no API key anyway.
 *
 * `cliRouting.allTraffic` (with the switch on) is the gateway-wide "route
 * everything" mode: every agent, local-model agents and per-agent opt-outs
 * included, and every run — chat, channels, voice, group chat, sub-agents,
 * cron, heartbeats — even when it was pinned to an API model (a sub-agent
 * model, a cron job model, a chat's picked model). A run already on a CLI
 * keeps that CLI. runWithModelFallback applies it (resolveForcedCliRoute), so
 * every ingress gets it from one place. Secure Mode sessions never do.
 *
 * Where it can run: local installs and fleet tenant Machines (one Fly Machine
 * per workspace, CLIs and their sign-ins on the workspace's own volume). Not
 * on a shared multi-tenant gateway, where one HOME would hold every
 * workspace's sign-in (resolveCliRoutingAvailability).
 *
 * Kept dependency-light on purpose: agent-scope.ts and model-selection.ts call
 * into it, so it must not import them back.
 */

import type { InfinibotConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isSaasMode } from "../saas/config.js";
import { resolveBin } from "./coder-backend/bin-detect.js";

export type CliProviderInfo = {
  /** Provider id used in model refs: `claude-cli/sonnet`. */
  id: string;
  /** Binary on PATH. */
  command: string;
  label: string;
  vendor: string;
  /** Which paid plan the CLI signs in with. */
  plan: string;
  /** Model used when cliRouting.models has none for this provider. */
  defaultModel: string;
  /** Setup › Coders catalog id (install + sign-in), when there is one. */
  coderId: string | null;
  /** argv (after the binary) that starts an interactive sign-in. */
  loginArgs: string[];
  installUrl: string;
  /** Plain-language card title for beginners ("ChatGPT"). Never says CLI/API. */
  account: string;
  /** Button label ("Sign in with ChatGPT"). */
  signInLabel: string;
  /** Usable at no cost with a normal account. */
  free: boolean;
};

/** The CLIs routing knows how to drive, in default fallback order. */
export const CLI_ROUTING_PROVIDERS: readonly CliProviderInfo[] = [
  {
    id: "claude-cli",
    command: "claude",
    label: "Claude Code",
    vendor: "Anthropic",
    plan: "Claude Pro or Max subscription",
    defaultModel: "sonnet",
    coderId: "claude-code",
    loginArgs: ["auth", "login"],
    installUrl: "https://docs.anthropic.com/en/docs/claude-code",
    account: "Claude",
    signInLabel: "Sign in with Claude",
    free: false,
  },
  {
    id: "codex-cli",
    command: "codex",
    label: "Codex CLI",
    vendor: "OpenAI",
    plan: "ChatGPT Plus, Pro or Business plan",
    // "default" = whatever the CLI is configured to use (no --model flag).
    defaultModel: "default",
    coderId: "codex",
    loginArgs: ["login", "--device-auth"],
    installUrl: "https://github.com/openai/codex",
    account: "ChatGPT",
    signInLabel: "Sign in with ChatGPT",
    free: false,
  },
  {
    id: "gemini-cli",
    command: "gemini",
    label: "Gemini CLI",
    vendor: "Google",
    plan: "Gemini API key or paid Google plan (Google AI Pro/Ultra, Code Assist Standard)",
    defaultModel: "default",
    coderId: "gemini",
    // Gemini CLI has no login subcommand: the first interactive run asks
    // how to sign in ("Login with Google").
    loginArgs: [],
    installUrl: "https://github.com/google-gemini/gemini-cli",
    account: "Google account",
    signInLabel: "Sign in with Google",
    // Not free: Google rejects free personal accounts in Gemini CLI
    // (IneligibleTierError). It needs a Gemini API key or a paid Google plan.
    free: false,
  },
  {
    id: "grok-cli",
    command: "grok",
    label: "Grok Build",
    vendor: "xAI",
    plan: "SuperGrok or X Premium+ subscription",
    defaultModel: "default",
    coderId: "grok-build",
    loginArgs: ["login", "--device-auth"],
    installUrl: "https://github.com/xai-org/grok-build",
    account: "Grok",
    signInLabel: "Sign in with Grok",
    free: false,
  },
  {
    id: "opencode-cli",
    command: "opencode",
    label: "OpenCode",
    vendor: "the provider OpenCode is configured for",
    plan: "Whatever OpenCode is signed in to (Claude, ChatGPT, Copilot, Ollama, …)",
    defaultModel: "default",
    coderId: "opencode",
    loginArgs: ["auth", "login"],
    installUrl: "https://opencode.ai",
    account: "OpenCode",
    signInLabel: "Sign in with OpenCode",
    free: false,
  },
];

/** CLIs people ask for that have no headless mode routing could drive. */
export const CLI_ROUTING_UNSUPPORTED: ReadonlyArray<{ id: string; label: string; reason: string }> =
  [
    {
      id: "antigravity",
      label: "Google Antigravity",
      reason:
        "Antigravity is an editor. Its `antigravity chat` command opens a chat window and returns nothing to the terminal, so InfiniBot can't read replies from it. Google users: choose Google account (Gemini CLI) instead, with the same Google sign-in.",
    },
  ];

export const DEFAULT_CLI_ROUTING_ORDER = CLI_ROUTING_PROVIDERS.map((p) => p.id);

export function getCliProviderInfo(id: string): CliProviderInfo | undefined {
  const key = id.trim().toLowerCase();
  return CLI_ROUTING_PROVIDERS.find((p) => p.id === key);
}

/** Providers whose primary model already needs no API key. */
const LOCAL_MODEL_PROVIDERS = new Set(["ollama", "vllm", "lmstudio", "lm-studio", "llamacpp"]);

// ── installed detection (sync, cached — model resolution runs per turn) ─────

type BinResolver = (command: string) => string | undefined;
let binResolver: BinResolver = (command) => resolveBin(command);
const binCache = new Map<string, { at: number; path: string | undefined }>();
const BIN_TTL_MS = 30_000;

/** Test seam. Pass undefined to restore PATH lookup. */
export function setCliRoutingBinResolver(fn: BinResolver | undefined): void {
  binResolver = fn ?? ((command) => resolveBin(command));
  binCache.clear();
}

export function resolveCliProviderBin(command: string): string | undefined {
  const hit = binCache.get(command);
  if (hit && Date.now() - hit.at < BIN_TTL_MS) return hit.path;
  let resolved: string | undefined;
  try {
    resolved = binResolver(command);
  } catch {
    resolved = undefined;
  }
  binCache.set(command, { at: Date.now(), path: resolved });
  return resolved;
}

// ── where routing can run ───────────────────────────────────────────────────

export type CliRoutingAvailability = {
  available: boolean;
  /** local = this computer; tenant-machine = a workspace's own cloud Machine. */
  where: "local" | "tenant-machine" | "shared-cloud";
  /** Plain-language reason, when unavailable. */
  reason?: string;
};

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");

export const CLI_ROUTING_SHARED_CLOUD_REASON =
  "This InfiniBot Cloud server is shared by several workspaces, so it can't keep your Claude, ChatGPT, Google or Grok sign-in separate from other people's. Use an API key here (Grok: an xAI API key), or use your subscription in InfiniBot Desktop or a self-hosted install.";

/**
 * Local installs and fleet tenant Machines can drive the user's CLIs. A shared
 * multi-tenant gateway (SAAS_MODE / CLOUD_MODE without FLEET_TENANT_ID) can't:
 * every workspace would share one HOME and so one sign-in.
 */
export function resolveCliRoutingAvailability(
  env: NodeJS.ProcessEnv = process.env,
): CliRoutingAvailability {
  if (env.FLEET_TENANT_ID?.trim()) return { available: true, where: "tenant-machine" };
  // isSaasMode() also reads the SaaS env file the gateway loads at boot.
  const saas = truthy(env.SAAS_MODE) || (env === process.env && isSaasMode());
  if (saas || truthy(env.CLOUD_MODE)) {
    return { available: false, where: "shared-cloud", reason: CLI_ROUTING_SHARED_CLOUD_REASON };
  }
  return { available: true, where: "local" };
}

// ── decision ────────────────────────────────────────────────────────────────

function agentEntry(cfg: InfinibotConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  return list.find((entry) => entry && normalizeAgentId(entry.id) === id);
}

/** "Route all traffic": the switch is on and cliRouting.allTraffic is set. */
export function isCliRoutingAllTraffic(cfg: InfinibotConfig | undefined): boolean {
  return cfg?.cliRoutingEnabled === true && cfg.cliRouting?.allTraffic === true;
}

/** Effective on/off for one agent: its own override, else the global switch. */
export function isCliRoutingEnabledForAgent(cfg: InfinibotConfig, agentId: string): boolean {
  if (!resolveCliRoutingAvailability().available) return false;
  if (isCliRoutingAllTraffic(cfg)) return true;
  const override = agentEntry(cfg, agentId)?.cliRouting;
  if (typeof override === "boolean") return override;
  return cfg.cliRoutingEnabled === true;
}

export function resolveCliRoutingOrder(cfg: InfinibotConfig): string[] {
  const configured = cfg.cliRouting?.providers;
  const raw =
    Array.isArray(configured) && configured.length ? configured : DEFAULT_CLI_ROUTING_ORDER;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const id = String(entry ?? "")
      .trim()
      .toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Binary for a provider: config override (agents.defaults.cliBackends) or built-in. */
function providerCommand(cfg: InfinibotConfig, id: string): string | undefined {
  const overrides = cfg.agents?.defaults?.cliBackends ?? {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key.trim().toLowerCase() === id && value?.command?.trim()) return value.command.trim();
  }
  return getCliProviderInfo(id)?.command;
}

export function resolveCliRoutingModel(cfg: InfinibotConfig, providerId: string): string {
  const fromCfg = cfg.cliRouting?.models?.[providerId]?.trim();
  return fromCfg || getCliProviderInfo(providerId)?.defaultModel || "default";
}

/** "provider/model" refs to try, installed CLIs first. Empty when none is configured. */
export function resolveCliRoutingRefs(cfg: InfinibotConfig): string[] {
  const order = resolveCliRoutingOrder(cfg);
  const installed: string[] = [];
  const missing: string[] = [];
  for (const id of order) {
    const command = providerCommand(cfg, id);
    if (!command) continue;
    const ref = `${id}/${resolveCliRoutingModel(cfg, id)}`;
    if (resolveCliProviderBin(command)) installed.push(ref);
    else missing.push(ref);
  }
  // Nothing installed: still route to the first choice so the turn fails with
  // "Claude Code isn't installed" instead of a confusing missing-API-key error.
  if (installed.length === 0) return missing.slice(0, 1);
  return installed;
}

function isLocalModelRef(ref: string | undefined): boolean {
  if (!ref) return false;
  const slash = ref.indexOf("/");
  if (slash <= 0) return false;
  return LOCAL_MODEL_PROVIDERS.has(ref.slice(0, slash).trim().toLowerCase());
}

export type CliRoutingDecision = {
  /** "claude-cli/sonnet" */
  primary: string;
  /** Remaining CLI refs, then (with fallbackToApi) the agent's normal models. */
  fallbacks: string[];
};

/**
 * Routing decision for one agent, or null when its own model should be used.
 * `rawPrimary` / `rawFallbacks` are the agent's configured (un-routed) models.
 */
export function resolveCliRoutingDecision(params: {
  cfg: InfinibotConfig;
  agentId: string;
  rawPrimary?: string;
  rawFallbacks?: string[];
}): CliRoutingDecision | null {
  const { cfg } = params;
  if (!isCliRoutingEnabledForAgent(cfg, params.agentId)) return null;
  if (isLocalModelRef(params.rawPrimary) && !isCliRoutingAllTraffic(cfg)) return null;
  const refs = resolveCliRoutingRefs(cfg);
  const [primary, ...rest] = refs;
  if (!primary) return null;
  const fallbacks = [...rest];
  if (cfg.cliRouting?.fallbackToApi === true) {
    for (const ref of [params.rawPrimary, ...(params.rawFallbacks ?? [])]) {
      const trimmed = ref?.trim();
      if (trimmed && !fallbacks.includes(trimmed) && trimmed !== primary) fallbacks.push(trimmed);
    }
  }
  return { primary, fallbacks };
}

/** A subscription CLI provider id (built-in or agents.defaults.cliBackends). */
export function isCliRoutingProviderId(
  cfg: InfinibotConfig | undefined,
  provider: string,
): boolean {
  const id = provider.trim().toLowerCase();
  if (getCliProviderInfo(id)) return true;
  const overrides = cfg?.agents?.defaults?.cliBackends ?? {};
  return Object.keys(overrides).some((key) => key.trim().toLowerCase() === id);
}

/**
 * "Route all traffic" for one run that asked for `provider/model`: null unless
 * cliRouting.allTraffic is on and the run isn't already on a CLI. The pinned
 * model becomes the first API fallback when fallbackToApi is set. Callers skip
 * Secure Mode sessions (they stay on local models).
 */
export function resolveForcedCliRoute(params: {
  cfg: InfinibotConfig | undefined;
  agentId: string;
  provider: string;
  model: string;
  /** The agent's own fallbacks (used only with fallbackToApi). */
  rawFallbacks?: string[];
}): CliRoutingDecision | null {
  const { cfg } = params;
  if (!cfg || !isCliRoutingAllTraffic(cfg)) return null;
  if (!params.provider || isCliRoutingProviderId(cfg, params.provider)) return null;
  return resolveCliRoutingDecision({
    cfg,
    agentId: params.agentId,
    rawPrimary: params.model ? `${params.provider}/${params.model}` : undefined,
    rawFallbacks: params.rawFallbacks,
  });
}
