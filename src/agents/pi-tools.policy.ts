import {
  APPROVAL_TOOLS,
  INFLIGHT_MESSAGING_TOOLS,
  VERIFIED_COMPLETION_TOOLS,
} from "../verification/tool-names.js";
import type { InfinibotConfig } from "../config/config.js";
import { getChannelDock } from "../channels/dock.js";
import { resolveChannelGroupToolsPolicy } from "../config/group-policy.js";
import {
  resolveAgentConfig,
  resolveAgentIdFromSessionKey,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { getBrowserExtensionGovernance } from "../browser/extension-governance.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveThreadParentSessionKey } from "../sessions/session-key-utils.js";

type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

function compilePattern(pattern: string): CompiledPattern {
  const normalized = normalizeToolName(pattern);
  if (!normalized) return { kind: "exact", value: "" };
  if (normalized === "*") return { kind: "all" };
  if (!normalized.includes("*")) return { kind: "exact", value: normalized };
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    kind: "regex",
    value: new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`),
  };
}

function compilePatterns(patterns?: string[]): CompiledPattern[] {
  if (!Array.isArray(patterns)) return [];
  return expandToolGroups(patterns)
    .map(compilePattern)
    .filter((pattern) => pattern.kind !== "exact" || pattern.value);
}

function matchesAny(name: string, patterns: CompiledPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === "all") return true;
    if (pattern.kind === "exact" && name === pattern.value) return true;
    if (pattern.kind === "regex" && pattern.value.test(name)) return true;
  }
  return false;
}

function makeToolPolicyMatcher(policy: SandboxToolPolicy) {
  const deny = compilePatterns(policy.deny);
  const allow = compilePatterns(policy.allow);
  return (name: string) => {
    const normalized = normalizeToolName(name);
    if (matchesAny(normalized, deny)) return false;
    if (allow.length === 0) return true;
    if (matchesAny(normalized, allow)) return true;
    if (normalized === "apply_patch" && matchesAny("exec", allow)) return true;
    return false;
  };
}

const DEFAULT_SUBAGENT_TOOL_DENY = [
  // Session management - main agent orchestrates
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  // System admin - dangerous from subagent
  "gateway",
  "agents_list",
  // Interactive setup - not a task
  "whatsapp_login",
  // Status/scheduling - main agent coordinates
  "session_status",
  "cron",
  // Memory - pass relevant info in spawn prompt instead
  "memory_search",
  "memory_get",
];

/**
 * Foundational tools every subagent needs to participate in voice-driven UI
 * work — the user expects "edit my video" to land in any agent persona,
 * not just the main one. If the operator narrows the allow list in their
 * config we still union these in so they're never accidentally filtered
 * out (explicit deny still wins; matched first in resolveSubagentToolPolicy).
 */
export const REQUIRED_SUBAGENT_TOOL_ALLOW = [
  "ui_control",
  // Read-only product knowledge: every agent may ask where/how in InfiniBot.
  "infinibot_help",
  "video_editor",
  ...VERIFIED_COMPLETION_TOOLS,
  ...APPROVAL_TOOLS,
  ...INFLIGHT_MESSAGING_TOOLS,
];

export function resolveSubagentToolPolicy(cfg?: InfinibotConfig): SandboxToolPolicy {
  const configured = cfg?.tools?.subagents?.tools;
  const deny = [
    ...DEFAULT_SUBAGENT_TOOL_DENY,
    ...(Array.isArray(configured?.deny) ? configured.deny : []),
  ];
  // If the operator supplied an explicit allow list, union our required
  // tools in. With no allow list, every non-denied tool passes anyway, so
  // there's nothing to do.
  const allow = Array.isArray(configured?.allow)
    ? Array.from(new Set([...configured!.allow, ...REQUIRED_SUBAGENT_TOOL_ALLOW]))
    : undefined;
  return { allow, deny };
}

export function isToolAllowedByPolicyName(name: string, policy?: SandboxToolPolicy): boolean {
  if (!policy) return true;
  return makeToolPolicyMatcher(policy)(name);
}

export function filterToolsByPolicy(tools: AnyAgentTool[], policy?: SandboxToolPolicy) {
  if (!policy) return tools;
  const matcher = makeToolPolicyMatcher(policy);
  return tools.filter((tool) => matcher(tool.name));
}

type ToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: string;
};

function unionAllow(base?: string[], extra?: string[]) {
  if (!Array.isArray(extra) || extra.length === 0) return base;
  // If the user is using alsoAllow without an allowlist, treat it as additive on top of
  // an implicit allow-all policy.
  if (!Array.isArray(base) || base.length === 0) {
    return Array.from(new Set(["*", ...extra]));
  }
  return Array.from(new Set([...base, ...extra]));
}

function pickToolPolicy(config?: ToolPolicyConfig): SandboxToolPolicy | undefined {
  if (!config) return undefined;
  const allow = Array.isArray(config.allow)
    ? unionAllow(config.allow, config.alsoAllow)
    : Array.isArray(config.alsoAllow) && config.alsoAllow.length > 0
      ? unionAllow(undefined, config.alsoAllow)
      : undefined;
  const deny = Array.isArray(config.deny) ? config.deny : undefined;
  if (!allow && !deny) return undefined;
  return { allow, deny };
}

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase();
}

function resolveGroupContextFromSessionKey(sessionKey?: string | null): {
  channel?: string;
  groupId?: string;
} {
  const raw = (sessionKey ?? "").trim();
  if (!raw) return {};
  const base = resolveThreadParentSessionKey(raw) ?? raw;
  const parts = base.split(":").filter(Boolean);
  let body = parts[0] === "agent" ? parts.slice(2) : parts;
  if (body[0] === "subagent") {
    body = body.slice(1);
  }
  if (body.length < 3) return {};
  const [channel, kind, ...rest] = body;
  if (kind !== "group" && kind !== "channel") return {};
  const groupId = rest.join(":").trim();
  if (!groupId) return {};
  return { channel: channel.trim().toLowerCase(), groupId };
}

function resolveProviderToolPolicy(params: {
  byProvider?: Record<string, ToolPolicyConfig>;
  modelProvider?: string;
  modelId?: string;
}): ToolPolicyConfig | undefined {
  const provider = params.modelProvider?.trim();
  if (!provider || !params.byProvider) return undefined;

  const entries = Object.entries(params.byProvider);
  if (entries.length === 0) return undefined;

  const lookup = new Map<string, ToolPolicyConfig>();
  for (const [key, value] of entries) {
    const normalized = normalizeProviderKey(key);
    if (!normalized) continue;
    lookup.set(normalized, value);
  }

  const normalizedProvider = normalizeProviderKey(provider);
  const rawModelId = params.modelId?.trim().toLowerCase();
  const fullModelId =
    rawModelId && !rawModelId.includes("/") ? `${normalizedProvider}/${rawModelId}` : rawModelId;

  const candidates = [...(fullModelId ? [fullModelId] : []), normalizedProvider];

  for (const key of candidates) {
    const match = lookup.get(key);
    if (match) return match;
  }
  return undefined;
}

let pairedBrowserOverride: boolean | undefined;
/** Test hook: force the "a Chrome is paired" answer (undefined = read the store). */
export function _setBrowserPairedForTests(value: boolean | undefined): void {
  pairedBrowserOverride = value;
}

function browserExtensionPaired(): boolean {
  if (pairedBrowserOverride !== undefined) return pairedBrowserOverride;
  try {
    return getBrowserExtensionGovernance().status().profiles.length > 0;
  } catch {
    return false;
  }
}

/**
 * Once a Chrome is paired (Setup › Connect your browser) the main agent gets
 * the `browser` tool even when its allowlist predates the extension, so it
 * works in chat and over MCP without hand-editing tools.allow. An explicit
 * deny (agent or global) still wins, and other agents are left alone.
 */
function withPairedBrowser(
  policy: SandboxToolPolicy | undefined,
  ctx: { config?: InfinibotConfig; agentId?: string; globalDeny?: string[] },
): SandboxToolPolicy | undefined {
  if (!policy?.allow || policy.allow.length === 0) return policy;
  if (!ctx.config || !ctx.agentId || ctx.agentId !== resolveDefaultAgentId(ctx.config))
    return policy;
  const allowed = expandToolGroups(policy.allow).map(normalizeToolName);
  if (allowed.includes("*") || allowed.includes("browser")) return policy;
  const denied = expandToolGroups([...(policy.deny ?? []), ...(ctx.globalDeny ?? [])]).map(
    normalizeToolName,
  );
  if (denied.includes("browser") || denied.includes("*")) return policy;
  if (!browserExtensionPaired()) return policy;
  return { ...policy, allow: [...policy.allow, "browser"] };
}

export function resolveEffectiveToolPolicy(params: {
  config?: InfinibotConfig;
  sessionKey?: string;
  modelProvider?: string;
  modelId?: string;
}) {
  const agentId = params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined;
  const agentConfig =
    params.config && agentId ? resolveAgentConfig(params.config, agentId) : undefined;
  const agentTools = agentConfig?.tools;
  const globalTools = params.config?.tools;

  const profile = agentTools?.profile ?? globalTools?.profile;
  const providerPolicy = resolveProviderToolPolicy({
    byProvider: globalTools?.byProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const agentProviderPolicy = resolveProviderToolPolicy({
    byProvider: agentTools?.byProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const agentPolicy = withPairedBrowser(pickToolPolicy(agentTools), {
    config: params.config,
    agentId,
    globalDeny: globalTools?.deny,
  });
  return {
    agentId,
    globalPolicy: pickToolPolicy(globalTools),
    globalProviderPolicy: pickToolPolicy(providerPolicy),
    agentPolicy,
    agentProviderPolicy: pickToolPolicy(agentProviderPolicy),
    profile,
    providerProfile: agentProviderPolicy?.profile ?? providerPolicy?.profile,
    // alsoAllow is applied at the profile stage (to avoid being filtered out early).
    profileAlsoAllow: Array.isArray(agentTools?.alsoAllow)
      ? agentTools?.alsoAllow
      : Array.isArray(globalTools?.alsoAllow)
        ? globalTools?.alsoAllow
        : undefined,
    providerProfileAlsoAllow: Array.isArray(agentProviderPolicy?.alsoAllow)
      ? agentProviderPolicy?.alsoAllow
      : Array.isArray(providerPolicy?.alsoAllow)
        ? providerPolicy?.alsoAllow
        : undefined,
  };
}

export function resolveGroupToolPolicy(params: {
  config?: InfinibotConfig;
  sessionKey?: string;
  spawnedBy?: string | null;
  messageProvider?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}): SandboxToolPolicy | undefined {
  if (!params.config) return undefined;
  const sessionContext = resolveGroupContextFromSessionKey(params.sessionKey);
  const spawnedContext = resolveGroupContextFromSessionKey(params.spawnedBy);
  const groupId = params.groupId ?? sessionContext.groupId ?? spawnedContext.groupId;
  if (!groupId) return undefined;
  const channelRaw = params.messageProvider ?? sessionContext.channel ?? spawnedContext.channel;
  const channel = normalizeMessageChannel(channelRaw);
  if (!channel) return undefined;
  let dock;
  try {
    dock = getChannelDock(channel);
  } catch {
    dock = undefined;
  }
  const toolsConfig =
    dock?.groups?.resolveToolPolicy?.({
      cfg: params.config,
      groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      accountId: params.accountId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    }) ??
    resolveChannelGroupToolsPolicy({
      cfg: params.config,
      channel,
      groupId,
      accountId: params.accountId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
  return pickToolPolicy(toolsConfig);
}

export function isToolAllowedByPolicies(
  name: string,
  policies: Array<SandboxToolPolicy | undefined>,
) {
  return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}
