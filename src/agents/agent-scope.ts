import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import type { InfinibotConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "./workspace.js";
import { resolveCliRoutingDecision } from "./cli-routing.js";
import { isSaasTenantScope, resolveTenantWorkspaceRoot } from "../saas/tenant-config.js";

export { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

type AgentEntry = NonNullable<NonNullable<InfinibotConfig["agents"]>["list"]>[number];

type ResolvedAgentConfig = {
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentEntry["model"];
  memorySearch?: AgentEntry["memorySearch"];
  humanDelay?: AgentEntry["humanDelay"];
  heartbeat?: AgentEntry["heartbeat"];
  identity?: AgentEntry["identity"];
  groupChat?: AgentEntry["groupChat"];
  subagents?: AgentEntry["subagents"];
  sandbox?: AgentEntry["sandbox"];
  tools?: AgentEntry["tools"];
  execution?: AgentEntry["execution"];
  capabilities?: string[];
};

let defaultAgentWarned = false;

function listAgents(cfg: InfinibotConfig): AgentEntry[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is AgentEntry => Boolean(entry && typeof entry === "object"));
}

export function listAgentIds(cfg: InfinibotConfig): string[] {
  const agents = listAgents(cfg);
  if (agents.length === 0) return [DEFAULT_AGENT_ID];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of agents) {
    const id = normalizeAgentId(entry?.id);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}

export function resolveDefaultAgentId(cfg: InfinibotConfig): string {
  const agents = listAgents(cfg);
  if (agents.length === 0) return DEFAULT_AGENT_ID;
  const defaults = agents.filter((agent) => agent?.default);
  if (defaults.length > 1 && !defaultAgentWarned) {
    defaultAgentWarned = true;
    console.warn("Multiple agents marked default=true; using the first entry as default.");
  }
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

export function resolveSessionAgentIds(params: { sessionKey?: string; config?: InfinibotConfig }): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
  const sessionKey = params.sessionKey?.trim();
  const normalizedSessionKey = sessionKey ? sessionKey.toLowerCase() : undefined;
  const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
  const sessionAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId;
  return { defaultAgentId, sessionAgentId };
}

export function resolveSessionAgentId(params: {
  sessionKey?: string;
  config?: InfinibotConfig;
}): string {
  return resolveSessionAgentIds(params).sessionAgentId;
}

function resolveAgentEntry(cfg: InfinibotConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  return listAgents(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

export function resolveAgentConfig(
  cfg: InfinibotConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const entry = resolveAgentEntry(cfg, id);
  if (!entry) return undefined;

  // Synthesise an execution block for CLI agents that were seeded with
  // `type: "cli"` + `cliCommand` but no explicit `execution` block.
  // The standard roster (coder-claude, coder-codex, coder-opencode) writes
  // exactly this shape — without this bridge the terminal-first spawn path in
  // sessions.spawn / sessions_spawn_tool would never fire for those agents,
  // silently falling through to a generic agent-loop that cannot drive CLIs.
  //
  // Note: `type` and `cliCommand` are seeder-only fields accepted by the Zod
  // schema but not present in the TypeScript `AgentConfig` type, so we access
  // them via `as Record<string, unknown>` to avoid TS errors while still
  // reading the values reliably at runtime.
  const rawEntry = entry as Record<string, unknown>;
  let effectiveExecution =
    typeof entry.execution === "object" && entry.execution ? entry.execution : undefined;
  if (
    !effectiveExecution &&
    rawEntry.type === "cli" &&
    typeof rawEntry.cliCommand === "string" &&
    (rawEntry.cliCommand as string).trim()
  ) {
    const cliVal = (rawEntry.cliCommand as string).trim();
    effectiveExecution = {
      mode: "terminal",
      cli: cliVal as NonNullable<typeof effectiveExecution>["cli"],
    };
  }

  return {
    name: typeof entry.name === "string" ? entry.name : undefined,
    workspace: typeof entry.workspace === "string" ? entry.workspace : undefined,
    agentDir: typeof entry.agentDir === "string" ? entry.agentDir : undefined,
    model:
      typeof entry.model === "string" || (entry.model && typeof entry.model === "object")
        ? entry.model
        : undefined,
    memorySearch: entry.memorySearch,
    humanDelay: entry.humanDelay,
    heartbeat: entry.heartbeat,
    identity: entry.identity,
    groupChat: entry.groupChat,
    subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
    sandbox: entry.sandbox,
    tools: entry.tools,
    execution: effectiveExecution,
  };
}

/** The agent's own configured primary model, ignoring subscription CLI routing. */
export function resolveAgentModelPrimaryRaw(
  cfg: InfinibotConfig,
  agentId: string,
): string | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  if (!raw) return undefined;
  if (typeof raw === "string") return raw.trim() || undefined;
  const primary = raw.primary?.trim();
  return primary || undefined;
}

function defaultsModel(cfg: InfinibotConfig): { primary?: string; fallbacks?: string[] } {
  const raw = cfg.agents?.defaults?.model as { primary?: string; fallbacks?: string[] } | string;
  if (typeof raw === "string") return { primary: raw.trim() || undefined };
  return raw ?? {};
}

/** Subscription CLI routing for an agent (null = use its own model). */
export function resolveAgentCliRouting(cfg: InfinibotConfig, agentId: string) {
  if (!cfg) return null;
  const defaults = defaultsModel(cfg);
  return resolveCliRoutingDecision({
    cfg,
    agentId,
    rawPrimary: resolveAgentModelPrimaryRaw(cfg, agentId) ?? defaults.primary?.trim(),
    rawFallbacks: resolveAgentModelFallbacksOverrideRaw(cfg, agentId) ?? defaults.fallbacks,
  });
}

export function resolveAgentModelPrimary(
  cfg: InfinibotConfig,
  agentId: string,
): string | undefined {
  const routed = resolveAgentCliRouting(cfg, agentId);
  if (routed) return routed.primary;
  return resolveAgentModelPrimaryRaw(cfg, agentId);
}

export function resolveAgentModelFallbacksOverride(
  cfg: InfinibotConfig,
  agentId: string,
): string[] | undefined {
  const routed = resolveAgentCliRouting(cfg, agentId);
  if (routed) return routed.fallbacks;
  return resolveAgentModelFallbacksOverrideRaw(cfg, agentId);
}

function resolveAgentModelFallbacksOverrideRaw(
  cfg: InfinibotConfig,
  agentId: string,
): string[] | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  if (!raw || typeof raw === "string") return undefined;
  // Important: treat an explicitly provided empty array as an override to disable global fallbacks.
  if (!Object.hasOwn(raw, "fallbacks")) return undefined;
  return Array.isArray(raw.fallbacks) ? raw.fallbacks : undefined;
}

export function resolveAgentWorkspaceDir(cfg: InfinibotConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  // SaaS member: persona / memory files live in the tenant's own state dir,
  // never in a workspace path from the operator's shared config.
  if (isSaasTenantScope()) return path.join(resolveTenantWorkspaceRoot(), id);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) return resolveUserPath(configured);
  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (id === defaultAgentId) {
    const fallback = cfg.agents?.defaults?.workspace?.trim();
    if (fallback) return resolveUserPath(fallback);
    return DEFAULT_AGENT_WORKSPACE_DIR;
  }
  const home = os.homedir();
  const newPath = path.join(home, `infinibot-${id}`);
  const legacyPath = path.join(home, `clawd-${id}`);
  try {
    if (!fsSync.existsSync(newPath) && fsSync.existsSync(legacyPath)) {
      return legacyPath;
    }
  } catch {}
  return newPath;
}

export function resolveAgentDir(cfg: InfinibotConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  // SaaS member: auth profiles / models.json stay inside the tenant namespace.
  if (isSaasTenantScope())
    return path.join(resolveStateDir(process.env, os.homedir), "agents", id, "agent");
  const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
  if (configured) return resolveUserPath(configured);
  const root = resolveStateDir(process.env, os.homedir);
  return path.join(root, "agents", id, "agent");
}
