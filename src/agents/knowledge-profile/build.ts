/**
 * Assemble per-agent knowledge & capability profiles.
 *
 * Pure assembly over injected sources (see runtime.ts for the live wiring) so
 * each section can be tested — and so a missing store only ever degrades its
 * own section. The tool-policy evaluation mirrors agent.tools.list
 * (agent-tools.ts buildTools) for session key `agent:<id>:main`, but builds
 * the tool catalog ONCE and filters it per agent.
 */

import path from "node:path";
import { sanitizeIdentityEmoji } from "../../shared/identity-emoji.js";

import type { InfinibotConfig } from "../../config/types.infinibot.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentModelFallbacksOverride,
  resolveAgentModelPrimary,
  resolveDefaultAgentId,
} from "../agent-scope.js";
import { resolveAgentCoderBackends } from "../agent-integration-config.js";
import { filterToolsByPolicy, resolveEffectiveToolPolicy } from "../pi-tools.policy.js";
import {
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
  stripPluginOnlyAllowlist,
} from "../tool-policy.js";
import { STANDARD_AGENT_ROSTER } from "../standard-roster.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { CAPABILITY_DOMAINS, CORE_TOOL_DESCRIPTIONS, domainForTool } from "./domains.js";
import {
  IDENTITY_FILE_NAMES,
  dailyMemoryStats,
  readPersona,
  statFile,
  type CountProbe,
  type StoreSnapshot,
} from "./probes.js";
import type {
  ActivitySection,
  AgentKnowledgeProfile,
  AgentLiveStatus,
  CapabilitiesSection,
  FieldCost,
  IdentitySection,
  KnowledgeProfileResult,
  KnowledgeSource,
  KnowledgeSourceDef,
  MemorySection,
  ToolDomainGroup,
  ToolInfo,
} from "./types.js";

export interface CatalogTool {
  name: string;
  description?: string;
  /** Plugin id when the tool comes from a plugin (for group:plugins expansion). */
  pluginId?: string;
}

export interface SessionSummary {
  sessions: number;
  sessionsLast24h: number;
  lastActiveAt: number | null;
  totalTokens: number;
  /** Most recent transcript files first. */
  recentFiles: string[];
}

export interface RunSummary {
  runId: string;
  agentId: string;
  label: string;
  startedAt: number | null;
  endedAt: number | null;
  active: boolean;
  state: string;
}

export interface McpServerSummary {
  name: string;
  status: string;
  toolCount: number;
  nodeName?: string;
}

export interface FederationSummary {
  role: "master" | "satellite" | "standalone";
  nodes: Array<{ id: string; name: string; online: boolean; isMaster?: boolean; local?: boolean }>;
}

export interface SkillSummary {
  name: string;
  description?: string;
  eligible?: boolean;
  emoji?: string;
}

export interface VectorIndexInfo {
  enabled: boolean;
  provider?: string;
  model?: string;
  storePath?: string;
  sessionsSource?: boolean;
}

/** Everything the builder reads. Each getter may throw — the builder catches. */
export interface KnowledgeProfileSources {
  now: () => number;
  config: InfinibotConfig;
  toolCatalog: () => CatalogTool[];
  stores: () => StoreSnapshot;
  sovereign: () => Promise<MemorySection["sovereign"]>;
  sessions: (agentIds: string[]) => Map<string, SessionSummary>;
  runs: () => RunSummary[];
  mcpServers: () => Promise<McpServerSummary[]>;
  federation: () => FederationSummary;
  skills: () => SkillSummary[];
  workspaceDir: (agentId: string) => string;
  vectorConfig: (agentId: string) => VectorIndexInfo;
  vectorIndex: (storePath: string) => {
    status: MemorySection["vector"]["status"];
    files: number;
    chunks: number;
    sources: Record<string, { files: number; chunks: number }>;
    lastIndexedAt: number | null;
  };
  recentTools: (files: string[]) => Array<{ name: string; count: number }>;
  workspaceEntries: (dir: string) => number | null;
}

export const FIELD_COSTS: Record<string, FieldCost> = {
  "identity.files": "cheap",
  "identity.persona": "cheap",
  "memory.sovereign": "moderate",
  "memory.vector": "cheap",
  "memory.notebook": "cheap",
  "knowledge.*": "cheap",
  "capabilities.tools": "moderate",
  "capabilities.skills": "moderate",
  "capabilities.mcp": "cheap",
  "capabilities.channels": "cheap",
  "capabilities.federation": "cheap",
  "activity.sessions": "moderate",
  "activity.runs": "cheap",
  "activity.recentTools": "expensive",
};

// ── Tool policy ────────────────────────────────────────────────────────

export interface AgentToolResolution {
  profile?: string;
  allowed: Set<string>;
  unknownAllowEntries: string[];
}

/**
 * Effective tool set for `agent:<id>:main` over a prebuilt catalog — the same
 * policy chain agent.tools.list applies (profile → provider profile → global →
 * global provider → agent → agent provider), minus the per-call group/subagent
 * steps which don't apply to an agent's main session.
 */
export function resolveAgentTools(
  cfg: InfinibotConfig,
  agentId: string,
  catalog: CatalogTool[],
): AgentToolResolution {
  const sessionKey = `agent:${normalizeAgentId(agentId)}:main`;
  const p = resolveEffectiveToolPolicy({ config: cfg, sessionKey });
  const mergeAlsoAllow = (
    policy: ReturnType<typeof resolveToolProfilePolicy>,
    alsoAllow?: string[],
  ) => {
    if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) return policy;
    return { ...policy, allow: Array.from(new Set([...policy.allow, ...alsoAllow])) };
  };
  const pluginGroups = buildPluginToolGroups({
    tools: catalog,
    toolMeta: (t: CatalogTool) => (t.pluginId ? { pluginId: t.pluginId } : undefined),
  });
  const coreNames = new Set(
    catalog.filter((t) => !t.pluginId).map((t) => normalizeToolName(t.name)),
  );
  const unknown = new Set<string>();
  const resolve = (policy: ReturnType<typeof resolveToolProfilePolicy>) => {
    const r = stripPluginOnlyAllowlist(policy, pluginGroups, coreNames);
    for (const u of r.unknownAllowlist) if (!u.includes("*")) unknown.add(u);
    return expandPolicyWithPluginGroups(r.policy, pluginGroups);
  };
  const steps = [
    resolve(mergeAlsoAllow(resolveToolProfilePolicy(p.profile), p.profileAlsoAllow)),
    resolve(
      mergeAlsoAllow(resolveToolProfilePolicy(p.providerProfile), p.providerProfileAlsoAllow),
    ),
    resolve(p.globalPolicy),
    resolve(p.globalProviderPolicy),
    resolve(p.agentPolicy),
    resolve(p.agentProviderPolicy),
  ];
  let filtered = catalog as unknown as Array<{ name: string }>;
  for (const step of steps)
    if (step) filtered = filterToolsByPolicy(filtered as never, step) as never;
  return {
    profile: p.profile,
    allowed: new Set(filtered.map((t) => normalizeToolName(t.name))),
    unknownAllowEntries: [...unknown].sort(),
  };
}

/** Catalog = gateway registry tools + core runtime tools it doesn't include. */
export function withCoreTools(catalog: CatalogTool[]): CatalogTool[] {
  const seen = new Set(catalog.map((t) => normalizeToolName(t.name)));
  const extra = Object.entries(CORE_TOOL_DESCRIPTIONS)
    .filter(([name]) => !seen.has(name))
    .map(([name, description]) => ({ name, description, core: true }));
  return [...catalog, ...extra];
}

// ── Knowledge sources ──────────────────────────────────────────────────

interface SourceDef extends KnowledgeSourceDef {
  probe?: keyof StoreSnapshot;
}

const SOURCE_DEFS: SourceDef[] = [
  {
    id: "notes",
    label: "Notes",
    description: "Shared markdown notes",
    via: ["notes"],
    tab: "notes",
    probe: "notes",
    countLabel: "notes",
  },
  {
    id: "projects",
    label: "Projects & kanban",
    description: "Projects, tasks and phases",
    via: ["kanban"],
    tab: "projects",
    probe: "kanban",
    countLabel: "projects",
    agentCountLabel: "tasks assigned",
  },
  {
    id: "databases",
    label: "Databases",
    description: "Local Notion-style databases",
    via: ["databases"],
    tab: "databases",
    probe: "databases",
    countLabel: "databases",
  },
  {
    id: "notion",
    label: "Notion",
    description: "Synced Notion databases",
    via: ["databases"],
    tab: "databases",
    probe: "notion",
    countLabel: "databases",
  },
  {
    id: "crm",
    label: "CRM",
    description: "Clients, leads and products (role databases)",
    via: ["business_objects", "client_contacts", "databases"],
    tab: "clients",
    probe: "crm",
    countLabel: "records",
  },
  {
    id: "reports",
    label: "Reports",
    description: "Rendered reports & briefings",
    via: ["report"],
    tab: "reports",
    probe: "reports",
    countLabel: "reports",
    agentCountLabel: "authored",
  },
  {
    id: "research",
    label: "Research",
    description: "Research topics, feeds & articles",
    via: ["research"],
    tab: "research",
    probe: "research",
    countLabel: "articles",
  },
  {
    id: "vault",
    label: "Vault",
    description: "Community courses & members",
    via: ["vault"],
    tab: "vault",
    probe: "vault",
    countLabel: "items",
  },
  {
    id: "content-intel",
    label: "Content intel",
    description: "Scored reels & transcripts",
    via: ["content_intel"],
    tab: "content-intel",
    probe: "contentIntel",
    countLabel: "reels",
  },
  {
    id: "directories",
    label: "Directory map",
    description: "Project directories mapped to agents",
    via: ["read", "exec"],
    tab: "directories",
    probe: "directories",
    countLabel: "directories",
    agentCountLabel: "mapped to agent",
    note: "Mapped directories are injected into the agent's context",
  },
  {
    id: "knowledge-graph",
    label: "Knowledge graph",
    description: "Typed relations across business objects",
    via: ["object_relations"],
    tab: "knowledge-graph",
    note: "Derived from kanban, notes, databases, agents & sessions",
  },
  {
    id: "workspace",
    label: "Workspace files",
    description: "The agent's own workspace directory",
    via: ["read", "write", "edit", "exec"],
    tab: "files",
    countLabel: "top-level entries",
  },
  {
    id: "sessions",
    label: "Session history",
    description: "Past conversations & transcripts",
    via: ["sessions_history", "sessions_list"],
    tab: "sessions",
    countLabel: "sessions",
  },
  {
    id: "memory-index",
    label: "Semantic memory",
    description: "Vector index over memory + transcripts",
    via: ["memory_search", "memory_get"],
    tab: "memory",
    countLabel: "chunks",
  },
  {
    id: "web",
    label: "Open web",
    description: "Live search, fetch and browsing",
    via: ["web_search", "web_fetch", "web_read", "web_image_search", "browser"],
  },
  {
    id: "inbox",
    label: "Inbox",
    description: "Connected email accounts",
    via: ["gmail"],
    tab: "inbox",
  },
  {
    id: "calendar",
    label: "Calendar",
    description: "Calendar events & scheduling",
    via: ["calendar"],
    tab: "schedule",
  },
];

function sourceFromDef(
  def: SourceDef,
  probe: CountProbe | undefined,
  allowed: Set<string>,
  agentId: string,
  overrides: Partial<KnowledgeSource> = {},
): KnowledgeSource {
  const grantedBy = def.via.filter((t) => allowed.has(t));
  const out: KnowledgeSource = {
    id: def.id,
    status: probe?.status ?? "ok",
    count: probe ? probe.count : null,
    lastUpdatedAt: probe?.lastUpdatedAt ?? null,
    reachable: grantedBy.length > 0,
    grantedBy,
  };
  if (probe?.detail) out.detail = probe.detail;
  if (probe?.byAgent && def.agentCountLabel)
    out.agentCount = probe.byAgent[agentId.toLowerCase()] ?? 0;
  if (probe?.note && probe.status !== "ok" && probe.status !== "empty") out.note = probe.note;
  return { ...out, ...overrides };
}

/** Static source metadata sent once per result (probe key stripped). */
export const KNOWLEDGE_SOURCE_DEFS: KnowledgeSourceDef[] = SOURCE_DEFS.map(
  ({ probe: _probe, ...def }) => def,
);

// ── Helpers ────────────────────────────────────────────────────────────

function safe<T>(errors: string[], label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

async function safeAsync<T>(
  errors: string[],
  label: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

function rawEntry(cfg: InfinibotConfig, agentId: string): Record<string, unknown> | undefined {
  const id = normalizeAgentId(agentId);
  return (cfg.agents?.list ?? []).find((a) => a?.id && normalizeAgentId(a.id) === id) as
    | Record<string, unknown>
    | undefined;
}

export function liveStatus(
  activity: { runningNow: number; lastActiveAt: number | null; sessions: number },
  now: number,
): AgentLiveStatus {
  if (activity.runningNow > 0) return "running";
  if (activity.lastActiveAt && now - activity.lastActiveAt < 2 * 60_000) return "running";
  if (activity.lastActiveAt && now - activity.lastActiveAt < 24 * 3_600_000) return "active";
  if (activity.sessions > 0 || activity.lastActiveAt) return "idle";
  return "dormant";
}

function modelToString(m: unknown): string | null {
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && typeof (m as { primary?: unknown }).primary === "string")
    return (m as { primary: string }).primary;
  return null;
}

// ── Builder ────────────────────────────────────────────────────────────

/** Agent ids = configured list (or ["main"]) plus the default. */
export function listProfileAgentIds(cfg: InfinibotConfig): string[] {
  const ids = listAgentIds(cfg).map(normalizeAgentId);
  const def = normalizeAgentId(resolveDefaultAgentId(cfg));
  if (!ids.includes(def)) ids.unshift(def);
  return [...new Set(ids)];
}

export async function buildKnowledgeProfiles(
  src: KnowledgeProfileSources,
  opts: { agentId?: string } = {},
): Promise<KnowledgeProfileResult> {
  const started = Date.now();
  const cfg = src.config;
  const now = src.now();
  const globalErrors: string[] = [];
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  let agentIds = listProfileAgentIds(cfg);
  if (opts.agentId) {
    const want = normalizeAgentId(opts.agentId);
    agentIds = agentIds.filter((id) => id === want);
  }

  // Shared (agent-independent) inputs — computed once.
  const catalog = withCoreTools(safe(globalErrors, "tool catalog", src.toolCatalog, []));
  const stores = safe<StoreSnapshot | null>(globalErrors, "stores", src.stores, null);
  const [sovereign, mcpServers] = await Promise.all([
    safeAsync<MemorySection["sovereign"]>(globalErrors, "sovereign memory", src.sovereign, {
      status: "error",
      shared: true,
      url: "",
      counts: {},
      lastUpdatedAt: null,
    }),
    safeAsync<McpServerSummary[] | null>(globalErrors, "mcp", src.mcpServers, null),
  ]);
  const sessions = safe(
    globalErrors,
    "sessions",
    () => src.sessions(agentIds),
    new Map<string, SessionSummary>(),
  );
  const runs = safe(globalErrors, "subagent runs", src.runs, [] as RunSummary[]);
  const federation = safe<FederationSummary>(globalErrors, "federation", src.federation, {
    role: "standalone",
    nodes: [],
  });
  const skillCatalog = safe<SkillSummary[] | null>(globalErrors, "skills", src.skills, null);
  const toolCatalog: ToolInfo[] = catalog
    .map((t) => ({
      name: t.name,
      description: (t.description ?? "").split("\n")[0].slice(0, 280),
      domain: domainForTool(t.name),
      ...((t as { core?: boolean }).core ? { core: true } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rosterById = new Map(STANDARD_AGENT_ROSTER.map((a) => [a.id, a]));

  const agents: AgentKnowledgeProfile[] = [];
  for (const agentId of agentIds) {
    const errors: string[] = [];
    const resolved = safe(
      errors,
      "agent config",
      () => resolveAgentConfig(cfg, agentId),
      undefined,
    );
    const entry = rawEntry(cfg, agentId) ?? {};
    const roster = rosterById.get(agentId);
    const identityCfg = (resolved?.identity ?? {}) as {
      name?: string;
      emoji?: string;
      theme?: string;
    };

    // Identity
    const workspace = safe(errors, "workspace", () => src.workspaceDir(agentId), "");
    const files = IDENTITY_FILE_NAMES.map((name) => {
      const st = workspace
        ? statFile(path.join(workspace, name))
        : { exists: false, size: 0, mtimeMs: null };
      return {
        name,
        exists: st.exists,
        size: st.size,
        updatedAt: st.mtimeMs,
        ...(name === "SOUL.md" ? { readOnly: true } : {}),
      };
    });
    const personaFile = workspace ? readPersona(workspace) : {};
    const workspaceEntries = workspace
      ? safe(errors, "workspace entries", () => src.workspaceEntries(workspace), null)
      : null;
    const identity: IdentitySection = {
      workspace,
      workspaceExists: workspaceEntries !== null,
      persona: {
        name: identityCfg.name ?? personaFile.name,
        emoji: sanitizeIdentityEmoji(identityCfg.emoji) ?? personaFile.emoji,
        theme: identityCfg.theme ?? personaFile.theme,
        creature: personaFile.creature,
        vibe: personaFile.vibe,
      },
      files,
      present: files.filter((f) => f.exists).length,
      total: files.length,
      lastUpdatedAt: files.reduce<number | null>(
        (m, f) => (f.updatedAt && (!m || f.updatedAt > m) ? f.updatedAt : m),
        null,
      ),
    };

    // Tools
    const tools = safe<AgentToolResolution>(
      errors,
      "tool policy",
      () => resolveAgentTools(cfg, agentId, catalog),
      { allowed: new Set(), unknownAllowEntries: [] },
    );
    const has = (n: string) => tools.allowed.has(n);
    const domains: ToolDomainGroup[] = CAPABILITY_DOMAINS.map((domain) => {
      const list = toolCatalog.filter((t) => t.domain === domain);
      const allowedTools = list
        .filter((t) => tools.allowed.has(normalizeToolName(t.name)))
        .map((t) => t.name);
      return { domain, allowed: allowedTools.length, total: list.length, allowedTools };
    }).filter((d) => d.total > 0);
    const matrix: Record<string, number> = {};
    for (const d of domains) matrix[d.domain] = d.allowed;

    // Memory
    const vcfg = safe<VectorIndexInfo>(
      errors,
      "memory index config",
      () => src.vectorConfig(agentId),
      { enabled: false },
    );
    const vindex =
      vcfg.enabled && vcfg.storePath
        ? safe(errors, "memory index", () => src.vectorIndex(vcfg.storePath!), null)
        : null;
    const memoryMd = files.find((f) => f.name === "MEMORY.md");
    const daily = workspace ? dailyMemoryStats(workspace) : { count: 0, latest: null };
    const sess = sessions.get(agentId);
    const sessionChunks = vindex?.sources?.sessions?.chunks ?? 0;
    const memory: MemorySection = {
      sovereign,
      vector: {
        status: !vcfg.enabled ? "not-configured" : (vindex?.status ?? "error"),
        enabled: vcfg.enabled,
        provider: vcfg.provider,
        model: vcfg.model,
        storePath: vcfg.storePath,
        files: vindex?.files ?? 0,
        chunks: vindex?.chunks ?? 0,
        sources: vindex?.sources ?? {},
        lastIndexedAt: vindex?.lastIndexedAt ?? null,
        reachable: has("memory_search") || has("memory_get"),
      },
      notebook: {
        status: memoryMd?.exists || daily.count ? "ok" : "empty",
        memoryMdBytes: memoryMd?.size ?? 0,
        dailyFiles: daily.count,
        lastUpdatedAt: Math.max(memoryMd?.updatedAt ?? 0, daily.latest ?? 0) || null,
      },
      transcripts: {
        status: sess ? (sess.sessions ? "ok" : "empty") : "not-configured",
        sessions: sess?.sessions ?? 0,
        indexedIntoMemory: Boolean(vcfg.sessionsSource) && sessionChunks > 0,
        indexedChunks: sessionChunks,
      },
    };

    // Knowledge sources
    const knowledge: KnowledgeSource[] = SOURCE_DEFS.map((def) => {
      const probe = def.probe
        ? stores
          ? stores[def.probe]
          : {
              status: "error" as const,
              count: null,
              lastUpdatedAt: null,
              note: "stores unavailable",
            }
        : undefined;
      if (def.id === "workspace")
        return sourceFromDef(def, undefined, tools.allowed, agentId, {
          status: workspaceEntries === null ? "not-configured" : workspaceEntries ? "ok" : "empty",
          count: workspaceEntries,
          note: workspace || undefined,
        });
      if (def.id === "sessions")
        return sourceFromDef(def, undefined, tools.allowed, agentId, {
          status: memory.transcripts.status,
          count: sess?.sessions ?? null,
          lastUpdatedAt: sess?.lastActiveAt ?? null,
        });
      if (def.id === "memory-index")
        return sourceFromDef(def, undefined, tools.allowed, agentId, {
          status: memory.vector.status,
          count: memory.vector.enabled ? memory.vector.chunks : null,
          detail: memory.vector.enabled
            ? { files: memory.vector.files, chunks: memory.vector.chunks }
            : undefined,
          lastUpdatedAt: memory.vector.lastIndexedAt,
          note: memory.vector.enabled ? undefined : "memorySearch disabled for this agent",
        });
      return sourceFromDef(def, probe, tools.allowed, agentId);
    });

    // Capabilities
    const type =
      entry.type === "cli" || resolved?.execution?.mode === "terminal" ? "cli" : "native";
    const skillsRaw = entry.skills as unknown;
    const skillList = Array.isArray(skillsRaw)
      ? (skillsRaw as unknown[]).filter((s): s is string => typeof s === "string")
      : skillsRaw &&
          typeof skillsRaw === "object" &&
          Array.isArray((skillsRaw as { allow?: unknown }).allow)
        ? (skillsRaw as { allow: unknown[] }).allow.filter(
            (s): s is string => typeof s === "string",
          )
        : null;
    const eligibleSkills = (skillCatalog ?? []).filter((s) => s.eligible !== false);
    const skills: CapabilitiesSection["skills"] = {
      mode: skillList === null ? "all" : skillList.length ? "list" : "none",
      enabled: skillList ?? [],
      count: skillList === null ? eligibleSkills.length : skillList.length,
      catalogTotal: skillCatalog?.length ?? 0,
      catalogEligible: eligibleSkills.length,
    };
    const enabledMCPs = Array.isArray(entry.enabledMCPs) ? (entry.enabledMCPs as string[]) : null;
    const mcpReachable = has("mcp") || type === "cli";
    const mcp: CapabilitiesSection["mcp"] = {
      status: mcpServers === null ? "error" : mcpServers.length ? "ok" : "empty",
      reachable: mcpReachable,
      scoped: enabledMCPs !== null,
      servers: (mcpServers ?? []).map((s) => ({
        ...s,
        enabledForAgent: mcpReachable && (enabledMCPs ? enabledMCPs.includes(s.name) : true),
      })),
    };
    const channels: CapabilitiesSection["channels"] = [];
    for (const b of cfg.bindings ?? []) {
      if (!b?.agentId || normalizeAgentId(b.agentId) !== agentId) continue;
      channels.push({
        channel: b.match?.channel ?? "?",
        accountId: b.match?.accountId,
        peer: b.match?.peer ? `${b.match.peer.kind}:${b.match.peer.id}` : undefined,
        source: "binding",
      });
    }
    if (entry.telegramBotTokenRef || entry.telegramBot)
      channels.push({ channel: "telegram", source: "agent-bot" });
    if (agentId === defaultAgentId) {
      const chans = (cfg.channels ?? {}) as Record<string, unknown>;
      for (const [name, v] of Object.entries(chans)) {
        if (!v || typeof v !== "object") continue;
        if ((v as { enabled?: unknown }).enabled === false) continue;
        if (channels.some((c) => c.channel === name)) continue;
        channels.push({ channel: name, source: "default-route" });
      }
    }
    const subagentsCfg = (resolved?.subagents ?? {}) as { allowAgents?: unknown };
    const coders = ["claude_coder", "opencode_coder", "codex_coder", "grok_coder"].filter(has);
    const capabilities: CapabilitiesSection = {
      type,
      cliCommand: typeof entry.cliCommand === "string" ? entry.cliCommand : undefined,
      model: {
        primary:
          safe(errors, "model", () => resolveAgentModelPrimary(cfg, agentId), undefined) ??
          modelToString(cfg.agents?.defaults?.model) ??
          null,
        fallbacks:
          safe(
            errors,
            "fallbacks",
            () => resolveAgentModelFallbacksOverride(cfg, agentId),
            undefined,
          ) ??
          (cfg.agents?.defaults?.model as { fallbacks?: string[] } | undefined)?.fallbacks ??
          [],
      },
      backend: (() => {
        const b = safe(errors, "backend", () => resolveAgentCoderBackends(cfg, agentId), null);
        return b
          ? {
              primary: b.primary,
              fallback: b.fallback,
              explicit: Boolean(entry.defaultCoderBackend),
            }
          : { primary: "claude-code", explicit: false };
      })(),
      tools: {
        profile: tools.profile,
        allowed: tools.allowed.size,
        total: catalog.length,
        unknownAllowEntries: tools.unknownAllowEntries,
        domains,
      },
      skills,
      mcp,
      channels,
      federation: {
        role: federation.role,
        nodes: federation.nodes,
        canTargetRemote:
          federation.nodes.some((n) => !n.local) && (has("nodes") || has("sessions_spawn")),
      },
      subagents: {
        canSpawn: has("sessions_spawn") || coders.length > 0,
        allowAgents: Array.isArray(subagentsCfg.allowAgents)
          ? (subagentsCfg.allowAgents as string[])
          : [],
        coders,
      },
      access: {
        browser: has("browser"),
        voice: has("tts") || [...tools.allowed].some((t) => t.startsWith("voice_") || t === "talk"),
        computerUse: [...tools.allowed].some(
          (t) => /^(hyprland|desktop)_/.test(t) || t === "screen_analyze",
        ),
        exec: has("exec") || type === "cli",
        web: has("web_search") || has("web_fetch") || has("web_read"),
        messaging: has("message") || has("telegram_send"),
        files: has("read") || has("write") || type === "cli",
      },
    };

    // Activity
    const agentRuns = runs.filter((r) => r.agentId === agentId);
    const runningNow = agentRuns.filter((r) => r.active).length;
    const lastRun = agentRuns.reduce<number | null>((m, r) => {
      const t = r.endedAt ?? r.startedAt;
      return t && (!m || t > m) ? t : m;
    }, null);
    const lastActiveAt = Math.max(sess?.lastActiveAt ?? 0, lastRun ?? 0) || null;
    const recentTools = sess?.recentFiles.length
      ? safe(errors, "recent tools", () => src.recentTools(sess.recentFiles), [])
      : [];
    const activityBase = { runningNow, lastActiveAt, sessions: sess?.sessions ?? 0 };
    const activity: ActivitySection = {
      status: liveStatus(activityBase, now),
      runningNow,
      runs: agentRuns
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        .slice(0, 8)
        .map((r) => ({
          runId: r.runId,
          label: r.label,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          state: r.state,
        })),
      lastActiveAt,
      sessions: sess?.sessions ?? 0,
      sessionsLast24h: sess?.sessionsLast24h ?? 0,
      totalTokens: sess?.totalTokens ?? 0,
      recentTools,
    };

    agents.push({
      id: agentId,
      name:
        (typeof resolved?.name === "string" && resolved.name) ||
        roster?.name ||
        identity.persona.name ||
        agentId,
      emoji: identity.persona.emoji,
      isDefault: agentId === defaultAgentId,
      department: roster?.department,
      description: roster?.description,
      identity,
      memory,
      knowledge,
      capabilities,
      activity,
      matrix,
      badges: {
        tools: tools.allowed.size,
        sources: knowledge.filter((k) => k.reachable).length,
        skills: skills.count,
        identityFiles: identity.present,
      },
      errors,
    });
  }

  return {
    generatedAt: now,
    cached: false,
    tookMs: Date.now() - started,
    defaultAgentId,
    domains: [...CAPABILITY_DOMAINS].filter((d) =>
      agents.some((a) => a.capabilities.tools.domains.some((g) => g.domain === d)),
    ),
    agents,
    sourceDefs: KNOWLEDGE_SOURCE_DEFS,
    tools: toolCatalog,
    skills: skillCatalog ?? [],
    errors: globalErrors,
    costs: FIELD_COSTS,
  };
}
