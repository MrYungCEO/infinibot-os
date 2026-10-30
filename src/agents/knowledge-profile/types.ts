/**
 * agents.knowledge.profile — "what does this agent know, and what can it reach?"
 *
 * A read-only, itemised, live profile per agent, assembled from EXISTING
 * sources (config, identity files, stores, registries). No new stores.
 * Every section degrades to a `status` instead of throwing.
 */

/** ok = data read; empty = source exists but holds nothing; not-configured /
 *  offline / error = the source isn't there (never fatal). */
export type SourceStatus = "ok" | "empty" | "not-configured" | "offline" | "error";

/** Relative cost of producing a field (so the UI/ops can reason about refresh). */
export type FieldCost = "cheap" | "moderate" | "expensive";

export type AgentLiveStatus = "running" | "active" | "idle" | "dormant";

export interface IdentityFileInfo {
  name: string;
  exists: boolean;
  size: number;
  updatedAt: number | null;
  readOnly?: boolean;
}

export interface IdentitySection {
  workspace: string;
  workspaceExists: boolean;
  persona: { name?: string; emoji?: string; theme?: string; creature?: string; vibe?: string };
  files: IdentityFileInfo[];
  present: number;
  total: number;
  lastUpdatedAt: number | null;
}

export interface MemorySection {
  /** Sovereign Memory (external :3014 service) — shared across agents. */
  sovereign: {
    status: SourceStatus;
    shared: true;
    url: string;
    counts: Partial<
      Record<
        "beliefs" | "values" | "relationships" | "memories" | "lessons" | "conversations",
        number
      >
    >;
    lastUpdatedAt: number | null;
    error?: string;
  };
  /** Semantic/vector memory index (memory_search) — per agent. */
  vector: {
    status: SourceStatus;
    enabled: boolean;
    provider?: string;
    model?: string;
    storePath?: string;
    files: number;
    chunks: number;
    sources: Record<string, { files: number; chunks: number }>;
    lastIndexedAt: number | null;
    reachable: boolean;
  };
  /** MEMORY.md + <workspace>/memory/*.md daily notes. */
  notebook: {
    status: SourceStatus;
    memoryMdBytes: number;
    dailyFiles: number;
    lastUpdatedAt: number | null;
  };
  /** Transcripts: session transcript files and whether they feed the index. */
  transcripts: {
    status: SourceStatus;
    sessions: number;
    indexedIntoMemory: boolean;
    indexedChunks: number;
  };
}

/** Static description of a knowledge source (shared: result.sourceDefs). */
export interface KnowledgeSourceDef {
  id: string;
  label: string;
  /** Short human summary of what's in it. */
  description: string;
  /** Tools that grant access; reachable = any of them allowed for the agent. */
  via: string[];
  /** UI tab id to deep-link to. */
  tab?: string;
  countLabel?: string;
  agentCountLabel?: string;
  note?: string;
}

/** Live, per-agent state of a knowledge source (static fields: KnowledgeSourceDef). */
export interface KnowledgeSource {
  id: string;
  status: SourceStatus;
  /** Headline count (null when the source is a live connector with no count). */
  count: number | null;
  /** Extra counts ("tasks", "rows", …). */
  detail?: Record<string, number>;
  /** Items attributed to THIS agent (assigned tasks, authored reports, mapped dirs). */
  agentCount?: number | null;
  lastUpdatedAt: number | null;
  reachable: boolean;
  /** Tools from the def's `via` this agent actually has. */
  grantedBy: string[];
  /** Live note (why a source is unavailable, the workspace path…). */
  note?: string;
}

/** Shared tool catalog entry (result.tools) — agents reference tools by name. */
export interface ToolInfo {
  name: string;
  description: string;
  domain: string;
  /** Core runtime tool (exec/read/…) not part of the gateway tool registry. */
  core?: boolean;
}

export interface SkillInfo {
  name: string;
  description?: string;
  eligible?: boolean;
  emoji?: string;
}

export interface ToolDomainGroup {
  domain: string;
  allowed: number;
  total: number;
  /** Names of the allowed tools in this domain (details in result.tools). */
  allowedTools: string[];
}

export interface CapabilitiesSection {
  type: "native" | "cli";
  cliCommand?: string;
  model: { primary: string | null; fallbacks: string[] };
  backend: { primary: string; fallback?: string; explicit: boolean };
  tools: {
    profile?: string;
    allowed: number;
    total: number;
    /** Allowlist entries that match nothing in the catalog (typos, uninstalled plugins). */
    unknownAllowEntries: string[];
    domains: ToolDomainGroup[];
  };
  skills: {
    mode: "all" | "list" | "none";
    /** Explicit skill names for mode "list" (details in result.skills); empty for "all". */
    enabled: string[];
    /** Number of skills the agent effectively has. */
    count: number;
    catalogTotal: number;
    catalogEligible: number;
  };
  mcp: {
    status: SourceStatus;
    reachable: boolean;
    scoped: boolean;
    servers: Array<{
      name: string;
      status: string;
      toolCount: number;
      enabledForAgent: boolean;
      nodeName?: string;
    }>;
  };
  channels: Array<{
    channel: string;
    accountId?: string;
    peer?: string;
    source: "binding" | "agent-bot" | "default-route";
  }>;
  federation: {
    role: "master" | "satellite" | "standalone";
    nodes: Array<{
      id: string;
      name: string;
      online: boolean;
      isMaster?: boolean;
      local?: boolean;
    }>;
    canTargetRemote: boolean;
  };
  subagents: { canSpawn: boolean; allowAgents: string[]; coders: string[] };
  access: Record<
    "browser" | "voice" | "computerUse" | "exec" | "web" | "messaging" | "files",
    boolean
  >;
}

export interface ActivitySection {
  status: AgentLiveStatus;
  runningNow: number;
  runs: Array<{
    runId: string;
    label: string;
    startedAt: number | null;
    endedAt: number | null;
    state: string;
  }>;
  lastActiveAt: number | null;
  sessions: number;
  sessionsLast24h: number;
  totalTokens: number;
  recentTools: Array<{ name: string; count: number }>;
}

export interface AgentKnowledgeProfile {
  id: string;
  name: string;
  emoji?: string;
  isDefault: boolean;
  department?: string;
  description?: string;
  identity: IdentitySection;
  memory: MemorySection;
  knowledge: KnowledgeSource[];
  capabilities: CapabilitiesSection;
  activity: ActivitySection;
  /** Per-domain counts for the capability matrix: domain → allowed tools. */
  matrix: Record<string, number>;
  /** Totals for roster badges. */
  badges: { tools: number; sources: number; skills: number; identityFiles: number };
  /** Sources that failed for this agent only (shared failures: result.errors). */
  errors: string[];
}

export interface KnowledgeProfileResult {
  generatedAt: number;
  cached: boolean;
  tookMs: number;
  defaultAgentId: string;
  domains: string[];
  agents: AgentKnowledgeProfile[];
  /** Shared static metadata for agent.knowledge[] entries (by id). */
  sourceDefs: KnowledgeSourceDef[];
  /** Shared tool catalog (gateway registry + core runtime tools). */
  tools: ToolInfo[];
  /** Shared skills catalog (default workspace). */
  skills: SkillInfo[];
  /** Failures of shared sources (stores, MCP, catalogs…). */
  errors: string[];
  costs: Record<string, FieldCost>;
}
