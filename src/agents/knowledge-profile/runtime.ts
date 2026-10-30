/**
 * Live wiring for agents.knowledge.profile: binds the builder's sources to the
 * real gateway modules and caches the result briefly.
 *
 * Cost notes:
 *  - tool catalog (createInfiniBotTools, loads plugins) and skills catalog (scans
 *    SKILL.md dirs) are cached 60 s — they change only on config/plugin edits.
 *  - session stores (sessions.json can be >10 MB) are summarised once per file
 *    mtime; only the summary is kept.
 *  - the whole result is cached PROFILE_TTL_MS so a UI poll + event burst
 *    never rebuilds more than once every few seconds.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../../config/config.js";
import type { InfinibotConfig } from "../../config/types.infinibot.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { collectExplicitAllowlist, resolveToolProfilePolicy } from "../tool-policy.js";
import { resolveEffectiveToolPolicy } from "../pi-tools.policy.js";
import {
  buildKnowledgeProfiles,
  listProfileAgentIds,
  type CatalogTool,
  type FederationSummary,
  type KnowledgeProfileSources,
  type McpServerSummary,
  type RunSummary,
  type SessionSummary,
  type SkillSummary,
} from "./build.js";
import {
  defaultOpenDb,
  probeStores,
  probeVectorIndex,
  recentToolsFromTranscripts,
  type ProbePaths,
} from "./probes.js";
import type { KnowledgeProfileResult, MemorySection } from "./types.js";

export const PROFILE_TTL_MS = 5_000;
const CATALOG_TTL_MS = 60_000;
const SESSION_STORE_MAX_BYTES = 64 * 1024 * 1024;

export const SOVEREIGN_MEMORY_URL =
  process.env.INFINIBOT_SOVEREIGN_MEMORY_URL?.replace(/\/$/, "") || "http://localhost:3014/api";

// ── Paths ──────────────────────────────────────────────────────────────

export function resolveProbePaths(env: NodeJS.ProcessEnv = process.env): ProbePaths {
  const legacyStateDir = env.INFINIBOT_STATE_DIR ?? "state";
  // Same derivation as src/vault/store/index.ts.
  const root =
    env.INFINIBOT_ROOT || env.INFINIBOT_STATE_DIR?.replace(/[\\/]state$/, "") || process.cwd();
  return {
    stateDir: resolveStateDir(env),
    legacyStateDir,
    vaultDb: path.join(root, "state", "vault", "vault.db"),
  };
}

// ── Tool + skill catalogs (60 s) ───────────────────────────────────────

let catalogCache: { at: number; tools: CatalogTool[] } | null = null;

function allowlistUnion(cfg: InfinibotConfig): string[] {
  const allow: string[] = [];
  for (const id of listProfileAgentIds(cfg)) {
    const p = resolveEffectiveToolPolicy({ config: cfg, sessionKey: `agent:${id}:main` });
    allow.push(
      ...collectExplicitAllowlist([
        resolveToolProfilePolicy(p.profile),
        p.globalPolicy,
        p.agentPolicy,
        p.agentProviderPolicy,
        p.globalProviderPolicy,
      ]),
      ...(p.profileAlsoAllow ?? []),
    );
  }
  return [...new Set(allow)];
}

/**
 * Gateway tool registry (names + descriptions). createInfiniBotTools is sync
 * and loads plugins through the process-wide plugin registry cache: ~1 ms in
 * the running gateway (plugins load at boot), but a cold process pays the
 * full plugin load once (measured ~70 s under tsx).
 */
async function buildToolCatalog(cfg: InfinibotConfig): Promise<CatalogTool[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.tools;
  const [{ createInfiniBotTools }, { getPluginToolMeta }] = await Promise.all([
    import("../infinibot-tools.js"),
    import("../../plugins/tools.js"),
  ]);
  // Union of every agent's explicit allowlist so plugin tools any agent can
  // see are part of the catalog (mirrors agent.tools.list's allowlist input).
  const tools = createInfiniBotTools({
    agentSessionKey: resolveMainSessionKey(cfg),
    config: cfg,
    pluginToolAllowlist: allowlistUnion(cfg),
  }) as unknown as Array<{ name: string; description?: string }>;
  const seen = new Set<string>();
  const out: CatalogTool[] = [];
  for (const t of tools) {
    if (!t?.name || seen.has(t.name)) continue;
    seen.add(t.name);
    const meta = getPluginToolMeta(t as never) as { pluginId?: string } | undefined;
    out.push({
      name: t.name,
      description: t.description,
      ...(meta?.pluginId ? { pluginId: meta.pluginId } : {}),
    });
  }
  catalogCache = { at: Date.now(), tools: out };
  return out;
}

let skillsCache: { at: number; skills: SkillSummary[] } | null = null;

async function buildSkillCatalog(cfg: InfinibotConfig): Promise<SkillSummary[]> {
  if (skillsCache && Date.now() - skillsCache.at < CATALOG_TTL_MS) return skillsCache.skills;
  const { buildWorkspaceSkillStatus } = await import("../skills-status.js");
  const ws = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const report = buildWorkspaceSkillStatus(ws, { config: cfg });
  const skills = report.skills.map((s) => ({
    name: s.name,
    description: s.description,
    eligible: s.eligible && !s.disabled && !s.blockedByAllowlist,
    emoji: s.emoji,
  }));
  skillsCache = { at: Date.now(), skills };
  return skills;
}

// ── Sessions (per-file mtime cache, summary only) ──────────────────────

type FileSummary = {
  mtimeMs: number;
  /** agentId → partial summary (a store can hold keys of several agents). */
  byAgent: Map<
    string,
    {
      sessions: number;
      last24h: number;
      last: number;
      tokens: number;
      recent: Array<[number, string]>;
    }
  >;
};
const sessionFileCache = new Map<string, FileSummary>();

function summariseStoreFile(file: string, ownerAgentId: string, now: number): FileSummary | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = sessionFileCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached;
  const byAgent: FileSummary["byAgent"] = new Map();
  if (st.size <= SESSION_STORE_MAX_BYTES) {
    const store = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    const dir = path.dirname(file);
    for (const [key, entry] of Object.entries(store ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      const agentId = key.startsWith("agent:") ? resolveAgentIdFromSessionKey(key) : ownerAgentId;
      let s = byAgent.get(agentId);
      if (!s)
        byAgent.set(agentId, (s = { sessions: 0, last24h: 0, last: 0, tokens: 0, recent: [] }));
      const updatedAt = Number(entry.updatedAt) || 0;
      s.sessions++;
      if (now - updatedAt < 86_400_000) s.last24h++;
      if (updatedAt > s.last) s.last = updatedAt;
      s.tokens += Number(entry.totalTokens) || 0;
      const transcript =
        typeof entry.sessionFile === "string" && entry.sessionFile
          ? path.isAbsolute(entry.sessionFile)
            ? entry.sessionFile
            : path.join(dir, entry.sessionFile)
          : typeof entry.sessionId === "string"
            ? path.join(dir, `${entry.sessionId}.jsonl`)
            : "";
      if (transcript) {
        s.recent.push([updatedAt, transcript]);
        if (s.recent.length > 16) {
          s.recent.sort((a, b) => b[0] - a[0]);
          s.recent.length = 4;
        }
      }
    }
  }
  const summary = { mtimeMs: st.mtimeMs, byAgent };
  sessionFileCache.set(file, summary);
  return summary;
}

export function summariseSessions(
  cfg: InfinibotConfig,
  agentIds: string[],
  now = Date.now(),
): Map<string, SessionSummary> {
  const files = new Map<string, string>();
  for (const id of agentIds) files.set(resolveStorePath(cfg.session?.store, { agentId: id }), id);
  const out = new Map<string, SessionSummary>();
  const recent = new Map<string, Array<[number, string]>>();
  for (const [file, owner] of files) {
    const summary = summariseStoreFile(file, owner, now);
    if (!summary) continue;
    for (const [agentId, s] of summary.byAgent) {
      const cur = out.get(agentId) ?? {
        sessions: 0,
        sessionsLast24h: 0,
        lastActiveAt: null,
        totalTokens: 0,
        recentFiles: [],
      };
      cur.sessions += s.sessions;
      cur.sessionsLast24h += s.last24h;
      cur.totalTokens += s.tokens;
      if (s.last && (!cur.lastActiveAt || s.last > cur.lastActiveAt)) cur.lastActiveAt = s.last;
      out.set(agentId, cur);
      recent.set(agentId, [...(recent.get(agentId) ?? []), ...s.recent]);
    }
  }
  for (const [agentId, list] of recent) {
    const cur = out.get(agentId);
    if (cur)
      cur.recentFiles = list
        .sort((a, b) => b[0] - a[0])
        .slice(0, 4)
        .map(([, f]) => f);
  }
  return out;
}

// ── Sovereign memory (:3014, shared) ───────────────────────────────────

export async function probeSovereign(
  url = SOVEREIGN_MEMORY_URL,
  timeoutMs = 1200,
): Promise<MemorySection["sovereign"]> {
  try {
    const res = await fetch(`${url}/stats`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok)
      return {
        status: "error",
        shared: true,
        url,
        counts: {},
        lastUpdatedAt: null,
        error: `HTTP ${res.status}`,
      };
    const raw = (await res.json()) as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = raw[k] ?? (raw.counts as Record<string, unknown> | undefined)?.[k];
        if (typeof v === "number") return v;
      }
      return undefined;
    };
    const counts: MemorySection["sovereign"]["counts"] = {};
    const map = {
      beliefs: ["beliefs", "totalBeliefs", "total_beliefs"],
      values: ["values", "totalValues", "total_values"],
      relationships: ["relationships", "totalRelationships", "total_relationships"],
      memories: ["memories", "totalMemories", "total_memories"],
      lessons: ["lessons", "totalLessons", "total_lessons"],
      conversations: ["conversations", "totalConversations", "total_conversations"],
    } as const;
    for (const [k, keys] of Object.entries(map)) {
      const v = pick(...keys);
      if (v !== undefined) counts[k as keyof typeof counts] = v;
    }
    const last = raw.lastUpdated ?? raw.last_updated ?? raw.lastMemoryAt;
    return {
      status: Object.values(counts).some((n) => (n ?? 0) > 0) ? "ok" : "empty",
      shared: true,
      url,
      counts,
      lastUpdatedAt:
        typeof last === "number"
          ? last
          : typeof last === "string"
            ? Date.parse(last) || null
            : null,
    };
  } catch (e) {
    return {
      status: "offline",
      shared: true,
      url,
      counts: {},
      lastUpdatedAt: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Registries (in-memory) ─────────────────────────────────────────────

async function listRuns(): Promise<RunSummary[]> {
  const { listAllSubagentRuns, isSubagentRunActive } = await import("../subagent-registry.js");
  return listAllSubagentRuns().map((r) => {
    const active = isSubagentRunActive(r);
    const rec = r as typeof r & { agentId?: string };
    return {
      runId: r.runId,
      agentId: normalizeAgentId(rec.agentId || resolveAgentIdFromSessionKey(r.childSessionKey)),
      label: r.label || r.task?.split("\n")[0]?.slice(0, 120) || r.runId,
      startedAt: r.startedAt ?? r.createdAt ?? null,
      endedAt: r.endedAt ?? null,
      active,
      state: active
        ? "running"
        : r.interruptedAt
          ? "interrupted"
          : typeof r.outcome === "object" && r.outcome && "status" in r.outcome
            ? String((r.outcome as { status: unknown }).status)
            : r.endedAt
              ? "done"
              : "queued",
    };
  });
}

async function listMcp(): Promise<McpServerSummary[]> {
  const out = new Map<string, McpServerSummary>();
  try {
    const { getMCPClientManager } = await import("../../mcp/client.js");
    for (const c of getMCPClientManager().getStatus()) {
      out.set(`local:${c.name}`, {
        name: c.name,
        status: c.status,
        toolCount: c.tools?.length ?? 0,
      });
    }
  } catch {}
  try {
    const { listFederationMCPs } = await import("../../federation/mcp-proxy.js");
    const res = await listFederationMCPs();
    for (const s of res.servers ?? []) {
      const key = `${s.nodeId === "local" || !s.nodeId ? "local" : s.nodeId}:${s.name}`;
      if (out.has(`local:${s.name}`) && (s.nodeId === "local" || !s.nodeId)) continue;
      out.set(key, {
        name: s.name,
        status: String(s.status ?? "running"),
        toolCount: s.tools?.length ?? 0,
        nodeName: s.nodeName,
      });
    }
  } catch {}
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function listFederation(cfg: InfinibotConfig): Promise<FederationSummary> {
  const local = {
    id: cfg.federation?.nodeId ?? "local",
    name: cfg.federation?.nodeName ?? os.hostname(),
    online: true,
    local: true,
  };
  try {
    const [{ getFederationHub }, { getFederationSatellite }] = await Promise.all([
      import("../../federation/hub.js"),
      import("../../federation/satellite.js"),
    ]);
    const hub = getFederationHub();
    if (hub) {
      const nodes = hub.getConnectedNodes().map((n) => ({
        id: n.manifest.id,
        name: n.manifest.name,
        online: true,
        isMaster: n.manifest.isMaster,
      }));
      return {
        role: "master",
        nodes: [{ ...local, isMaster: true }, ...nodes.filter((n) => n.id !== local.id)],
      };
    }
    const sat = getFederationSatellite();
    if (sat) {
      const nodes = sat
        .getFederatedNodes()
        .map((m) => ({ id: m.id, name: m.name, online: true, isMaster: m.isMaster }));
      return { role: "satellite", nodes: [local, ...nodes.filter((n) => n.id !== local.id)] };
    }
  } catch {}
  return { role: "standalone", nodes: [local] };
}

// ── Entry point ────────────────────────────────────────────────────────

let resultCache: { at: number; result: KnowledgeProfileResult } | null = null;
let inflight: Promise<KnowledgeProfileResult> | null = null;

export async function createLiveSources(
  cfg: InfinibotConfig = loadConfig(),
): Promise<KnowledgeProfileSources> {
  const paths = resolveProbePaths();
  // Async prerequisites resolved up-front so the builder's getters stay sync.
  const [catalog, skills, runs, federation] = await Promise.all([
    buildToolCatalog(cfg).catch((e) => e as Error),
    buildSkillCatalog(cfg).catch((e) => e as Error),
    listRuns().catch((e) => e as Error),
    listFederation(cfg),
  ]);
  const unwrap = <T>(v: T | Error): T => {
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    now: () => Date.now(),
    config: cfg,
    toolCatalog: () => unwrap(catalog),
    stores: () => probeStores(paths, defaultOpenDb),
    sovereign: () => probeSovereign(),
    sessions: (ids) => summariseSessions(cfg, ids),
    runs: () => unwrap(runs),
    mcpServers: listMcp,
    federation: () => federation,
    skills: () => unwrap(skills),
    workspaceDir: (id) => resolveAgentWorkspaceDir(cfg, id),
    vectorConfig: (id) => {
      const r = resolveMemorySearchConfig(cfg, id);
      if (!r || !r.enabled) return { enabled: false };
      return {
        enabled: true,
        provider: r.provider,
        model: r.model,
        storePath: r.store?.path,
        sessionsSource: r.sources?.includes("sessions"),
      };
    },
    vectorIndex: (p) => probeVectorIndex(p, defaultOpenDb),
    recentTools: (files) => recentToolsFromTranscripts(files),
    workspaceEntries: (dir) => {
      try {
        return fs.readdirSync(dir).filter((n) => !n.startsWith(".")).length;
      } catch {
        return null;
      }
    },
  };
}

export async function getKnowledgeProfiles(
  opts: { agentId?: string; fresh?: boolean } = {},
): Promise<KnowledgeProfileResult> {
  const pick = (r: KnowledgeProfileResult, cached: boolean): KnowledgeProfileResult => {
    const want = opts.agentId ? normalizeAgentId(opts.agentId) : null;
    return { ...r, cached, agents: want ? r.agents.filter((a) => a.id === want) : r.agents };
  };
  if (!opts.fresh && resultCache && Date.now() - resultCache.at < PROFILE_TTL_MS)
    return pick(resultCache.result, true);
  if (!inflight) {
    inflight = (async () => {
      const result = await buildKnowledgeProfiles(await createLiveSources());
      resultCache = { at: Date.now(), result };
      return result;
    })().finally(() => {
      inflight = null;
    });
  }
  return pick(await inflight, false);
}

/** Test hook. */
export function resetKnowledgeProfileCaches(): void {
  resultCache = null;
  catalogCache = null;
  skillsCache = null;
  sessionFileCache.clear();
}
