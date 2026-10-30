/**
 * Secure Mode policy: which models and tools a secure-lane run may use.
 *
 * Both checks are allowlists and fail closed. Models must be served from this
 * machine (loopback or an address bound to one of its interfaces, see
 * host-locality.ts) or from a host the owner listed in
 * `secureMode.allowedModelHosts`; provider names are irrelevant (an "ollama"
 * provider pointed at ollama.com is remote). Tools must be on the local-only
 * allowlist below.
 */

import type { InfinibotConfig } from "../config/config.js";
import {
  getHostLocalityChecker,
  type HostVerdict,
  isLoopbackAddress,
  normalizeHost,
} from "./host-locality.js";
import { isSecureSessionKey } from "./session-key.js";

export class SecureModeBlockedError extends Error {
  readonly code = "SECURE_MODE_BLOCKED";
  constructor(message: string) {
    super(`Blocked by Secure Mode: ${message}`);
    this.name = "SecureModeBlockedError";
  }
}

/**
 * Tools a secure run may use. Everything else (web_*, message/telegram/gmail,
 * mcp, coders, sessions_spawn, exec/shell, write/edit, memory, plugin tools…)
 * is left out of the run. `write`/`edit` are excluded too: they would put
 * secure content on disk in the clear. `secure_lane` is the encrypted store.
 */
export const SECURE_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  "read",
  "secure_lane",
  // Lane-bound: in a secure session it reads only vault-sealed secure files,
  // and its vision pass is a loopback Ollama call.
  "file_context",
  // Same lane binding; frames stay in the vault/tmpfs, vision is loopback only.
  "video_analysis",
  // Sanitized + owner-approved search via a local SearXNG; pages are read by
  // local models only (research/egress.ts is its egress allowlist).
  "secure_research",
]);

/** Never allowed, even if the owner lists them in secureMode.allowTools. */
const NEVER_ALLOW = new Set([
  "web_fetch",
  "web_search",
  "web_search_exa",
  "web_read",
  "web_image_search",
  "youtube_transcript",
  "rss_read",
  "research",
  "browser",
  "github_read",
  "github_project_sync",
  "gmail",
  "message",
  "telegram_send",
  "telegram_set_default",
  "sessions_send",
  "sessions_spawn",
  "claude_coder",
  "codex_coder",
  "grok_coder",
  "opencode_coder",
  "mcp",
  "nodes",
  "mesh",
  "ssh_devices",
  "tailscale_control",
  "gateway",
  "android_ops",
  "image",
  "vision",
  "screen_analyze",
  "tts",
  "calendar",
  "kanban",
  "notes",
  "memory_search",
  "memory_get",
  // provider usage lookups + model switching
  "session_status",
]);

function normalizeTool(name: string): string {
  return name.trim().toLowerCase();
}

export function resolveSecureToolAllowlist(cfg?: InfinibotConfig): Set<string> {
  const allowed = new Set(SECURE_TOOL_ALLOWLIST);
  for (const extra of cfg?.secureMode?.allowTools ?? []) {
    const n = normalizeTool(String(extra));
    if (n && !NEVER_ALLOW.has(n) && !n.startsWith("flypic_") && !n.startsWith("mcp_")) {
      allowed.add(n);
    }
  }
  return allowed;
}

export function checkSecureTool(
  toolName: string,
  cfg?: InfinibotConfig,
): { allowed: true } | { allowed: false; reason: string } {
  const n = normalizeTool(toolName);
  if (resolveSecureToolAllowlist(cfg).has(n)) return { allowed: true };
  return {
    allowed: false,
    reason: `Blocked by Secure Mode: tool "${toolName}" is not on the local-only allowlist (${[
      ...resolveSecureToolAllowlist(cfg),
    ].join(", ")}). Secure runs cannot reach the network or write outside the encrypted lane.`,
  };
}

type NamedTool = { name: string };

/**
 * Keep only allowlisted tools for a secure session. Non-secure sessions pass
 * through untouched.
 */
export function filterToolsForSecureSession<T extends NamedTool>(
  tools: T[],
  sessionKey: string | undefined,
  cfg?: InfinibotConfig,
): T[] {
  if (!isSecureSessionKey(sessionKey)) return tools;
  const allowed = resolveSecureToolAllowlist(cfg);
  return tools.filter((t) => allowed.has(normalizeTool(t.name)));
}

function hostOf(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Literal loopback check (no DNS, no interfaces). */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "localhost" || h === "ip6-localhost" || h.endsWith(".localhost")) return true;
  return isLoopbackAddress(h);
}

/**
 * Synchronous locality check: loopback, IP literals bound to a local
 * interface, allowlisted hosts, and hostnames resolved recently. A hostname
 * that has not been resolved yet fails closed — use the async variant on the
 * run path.
 */
export function isLocalModelBaseUrl(baseUrl: string | undefined, cfg?: InfinibotConfig): boolean {
  if (!baseUrl) return false;
  const host = hostOf(baseUrl);
  if (!host) return false;
  return getHostLocalityChecker().checkSync(host, cfg).local;
}

/** DNS-resolving locality check for a model endpoint. */
export async function checkModelBaseUrlLocality(
  baseUrl: string | undefined,
  cfg?: InfinibotConfig,
): Promise<HostVerdict | null> {
  if (!baseUrl) return null;
  const host = hostOf(baseUrl);
  if (!host) return null;
  return getHostLocalityChecker().check(host, cfg);
}

/** Providers that run through a CLI that talks to a hosted API. */
const REMOTE_CLI_PROVIDERS = new Set([
  "claude-cli",
  "codex-cli",
  "claude-code",
  "codex",
  "gemini-cli",
  "grok-cli",
  "opencode-cli",
]);

/** Who a cloud CLI sends the conversation to, for the refusal message. */
const CLI_VENDORS: Record<string, string> = {
  "claude-cli": "Claude Code sends your messages to Anthropic",
  "claude-code": "Claude Code sends your messages to Anthropic",
  "codex-cli": "Codex CLI sends your messages to OpenAI",
  codex: "Codex CLI sends your messages to OpenAI",
  "gemini-cli": "Gemini CLI sends your messages to Google",
  "grok-cli": "Grok Build sends your messages to xAI",
  "opencode-cli": "OpenCode sends your messages to its configured cloud provider",
};

/** An operator-declared local-only CLI backend (agents.defaults.cliBackends.<id>.localOnly). */
function isLocalOnlyCliBackend(provider: string, cfg?: InfinibotConfig): boolean {
  const key = provider.trim().toLowerCase();
  const backends = cfg?.agents?.defaults?.cliBackends ?? {};
  for (const [id, backend] of Object.entries(backends)) {
    if (id.trim().toLowerCase() === key) return backend?.localOnly === true;
  }
  return false;
}

export function isRemoteCliProvider(provider: string): boolean {
  return REMOTE_CLI_PROVIDERS.has(provider.trim().toLowerCase());
}

/** Providers whose built-in default endpoint is this machine. */
const LOCAL_DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: "http://127.0.0.1:11434/v1",
};

export function resolveModelBaseUrl(params: {
  provider: string;
  baseUrl?: string;
  cfg?: InfinibotConfig;
}): string | undefined {
  return (
    params.baseUrl ??
    params.cfg?.models?.providers?.[params.provider]?.baseUrl ??
    LOCAL_DEFAULT_BASE_URLS[params.provider.trim().toLowerCase()] ??
    undefined
  );
}

type ModelCheckParams = {
  provider: string;
  modelId: string;
  baseUrl?: string;
  cfg?: InfinibotConfig;
};

export type SecureModelVerdict =
  | { allowed: true; host?: string; via?: HostVerdict["via"]; detail?: string }
  | { allowed: false; reason: string; host?: string; via?: HostVerdict["via"] };

function verdictFromHost(
  params: ModelCheckParams,
  baseUrl: string | undefined,
  v: HostVerdict | null,
): SecureModelVerdict {
  const ref = `${params.provider}/${params.modelId}`;
  if (v?.local) return { allowed: true, host: v.host, via: v.via, detail: v.detail };
  const where = baseUrl ? (hostOf(baseUrl) ?? baseUrl) : "a hosted API";
  // Plain "not an address of this machine" adds nothing; DNS answers and
  // rebinding quarantines do.
  const why = v && !v.detail.endsWith("is not an address of this machine") ? ` (${v.detail})` : "";
  return {
    allowed: false,
    host: v?.host,
    via: v?.via,
    reason: `Blocked by Secure Mode: ${ref} is served from ${where}${why}, not this machine. Secure runs use local models only (this machine's loopback or network interfaces, or secureMode.allowedModelHosts).`,
  };
}

function cliVerdict(params: ModelCheckParams): SecureModelVerdict | null {
  if (isLocalOnlyCliBackend(params.provider, params.cfg)) {
    return { allowed: true, detail: `${params.provider} is marked localOnly` };
  }
  if (!isRemoteCliProvider(params.provider)) return null;
  const who =
    CLI_VENDORS[params.provider.trim().toLowerCase()] ??
    `${params.provider} sends your messages to a hosted API`;
  return {
    allowed: false,
    reason: `Blocked by Secure Mode: ${who}, off this computer. Secure runs use local models only (e.g. ollama on 127.0.0.1), or a CLI marked localOnly.`,
  };
}

/** Sync check (unresolved hostnames fail closed). Prefer checkSecureModelAsync. */
export function checkSecureModel(params: ModelCheckParams): SecureModelVerdict {
  const cli = cliVerdict(params);
  if (cli) return cli;
  const baseUrl = resolveModelBaseUrl(params);
  const host = baseUrl ? hostOf(baseUrl) : null;
  const v = host ? getHostLocalityChecker().checkSync(host, params.cfg) : null;
  return verdictFromHost(params, baseUrl, v);
}

/** Resolves the endpoint's hostname with DNS and checks every address. */
export async function checkSecureModelAsync(params: ModelCheckParams): Promise<SecureModelVerdict> {
  const cli = cliVerdict(params);
  if (cli) return cli;
  const baseUrl = resolveModelBaseUrl(params);
  const v = await checkModelBaseUrlLocality(baseUrl, params.cfg);
  return verdictFromHost(params, baseUrl, v);
}

/** Throw unless a secure session may use this model. No-op for normal sessions. */
export async function assertSecureModelAllowed(
  params: ModelCheckParams & { sessionKey?: string },
): Promise<void> {
  if (!isSecureSessionKey(params.sessionKey)) return;
  const res = await checkSecureModelAsync(params);
  if (!res.allowed)
    throw new SecureModeBlockedError(res.reason.replace(/^Blocked by Secure Mode: /, ""));
}
