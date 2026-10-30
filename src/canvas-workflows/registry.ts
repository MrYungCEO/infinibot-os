/**
 * Holo-Canvas Workflow Registry.
 *
 * Pre-authored, voice-spawnable canvas walkthroughs that hydrate from live
 * system data and render via the existing `infinite-canvas-walkthrough`
 * overlay. Each workflow is a thin `build(ctx)` function that pulls live
 * snapshots through the in-process gateway methods (no HTTP) and returns a
 * ready-to-emit {@link CanvasPayload}.
 *
 * Node schema is locked to the overlay's direct-field shape
 * (n.title, n.body, n.h1, n.sub, n.stats, n.kicker, n.h2 …) — NOT a
 * `content` object. See
 * ui/src/ui/components/walkthroughs/infinite-canvas-walkthrough.ts.
 */

import type { InfiniteCanvasWalkthroughMedia } from "../proactive/popup-types.js";

// ── BuildCtx RPC callers ────────────────────────────────────────────────────
// Each caller returns the same payload shape the matching gateway RPC responds
// with, so templates can be authored against a stable contract. The default
// factory (getDefaultBuildCtx) wires them to the in-process stores; tests can
// inject a stub ctx.

/** Federation node row (subset of `federation.nodes.list` response). */
export interface FederationNodeRow {
  id: string;
  name: string;
  status: string;
  role: string;
  isLocal?: boolean;
  platform?: string;
  url?: string | null;
  gatewayUrl?: string | null;
  load?: unknown;
  activeSessions?: number;
  capabilities?: {
    version?: string;
    gpu?: string;
    cpu?: string;
    ram?: string;
    [k: string]: unknown;
  };
  lastSeen?: number;
}

/** Kanban project row (subset of `kanban.projects.list` response). */
export interface KanbanProjectRow {
  id: string;
  name: string;
  description?: string;
  status?: string;
  priority?: string;
  progress?: number;
  taskCount?: number;
  type?: string[];
  node?: string;
  nodes?: string[];
  createdAt?: number;
  updatedAt?: number;
}

/** Kanban task row (subset of `kanban.tasks.list` response). */
export interface KanbanTaskRow {
  id: string;
  projectId: string;
  title: string;
  status: string;
  assignee?: string;
  priority?: string;
  node?: string;
  completedAt?: number;
}

/** Systems-intelligence insight row (subset of `systems.insights.list`). */
export interface SystemsInsightRow {
  id: string;
  type?: string;
  title?: string;
  description?: string;
  severity?: string;
  relatedIds?: string[];
  createdAt?: number;
}

/** Credits timeseries point. */
export interface CreditsTimeseriesPoint {
  bucketStart: number;
  series: Record<string, { tokens: number; costUsd: number; requests: number }>;
  [k: string]: unknown;
}

/** Agent row (subset of `agents.list` response). */
export interface AgentRow {
  id: string;
  name?: string;
  identity?: { name?: string; theme?: string; emoji?: string };
}

/** In-process RPC surface made available to workflow `build(ctx)` functions. */
export interface BuildCtx {
  /** `federation.nodes.list` — federation fleet snapshot. */
  federation: {
    list(): Promise<{ nodes: FederationNodeRow[]; role: string }>;
  };
  /** `kanban.projects.list` + `kanban.tasks.list` — board snapshot. */
  kanban: {
    snapshot(): Promise<{
      projects: KanbanProjectRow[];
      tasks: KanbanTaskRow[];
    }>;
  };
  /** `systems.insights.list` — live systems-intelligence insights. */
  insights: {
    summary(): Promise<{ insights: SystemsInsightRow[] }>;
  };
  /** `credits.timeseries` — recent spend points. */
  credits: {
    timeseries(opts?: {
      bucket?: string;
      range?: { start?: number; end?: number };
    }): Promise<{ points: CreditsTimeseriesPoint[] }>;
  };
  /** `agents.list` — configured agents. */
  agents: {
    list(): Promise<{ agents: AgentRow[] }>;
  };
}

/** Ready-to-emit canvas payload (matches infinite-canvas-walkthrough). */
export type CanvasPayload = InfiniteCanvasWalkthroughMedia;

/** A registered canvas workflow. */
export interface CanvasWorkflow {
  id: string;
  title: string;
  description: string;
  defaultVoice?: string;
  build(ctx: BuildCtx): Promise<CanvasPayload>;
}

// ── Registry ────────────────────────────────────────────────────────────────

const registry = new Map<string, CanvasWorkflow>();

/** Register a workflow. Throws if the id is already taken. */
export function registerWorkflow(wf: CanvasWorkflow): void {
  if (!wf?.id || typeof wf.id !== "string") throw new Error("workflow id is required");
  if (registry.has(wf.id)) throw new Error(`workflow already registered: ${wf.id}`);
  registry.set(wf.id, wf);
}

/** Look up a workflow by id. Returns undefined when not found. */
export function getWorkflow(id: string): CanvasWorkflow | undefined {
  return registry.get(id);
}

/** List all registered workflows (stable insertion order). */
export function listWorkflows(): CanvasWorkflow[] {
  return [...registry.values()];
}

/** Clear the registry (test helper). */
export function clearWorkflows(): void {
  registry.clear();
}

// ── Default BuildCtx (in-process, no HTTP) ──────────────────────────────────

/**
 * Build a {@link BuildCtx} wired to the existing in-process gateway stores.
 * Used by the `canvas.run` RPC handler when the caller doesn't supply a ctx
 * (e.g. tests inject a stub). Each caller is defensive: on error it returns
 * an empty result so a workflow degrades gracefully instead of throwing.
 */
export function getDefaultBuildCtx(): BuildCtx {
  return {
    federation: {
      async list() {
        try {
          const { getFederationHub, getFederationSatellite } =
            await import("../federation/index.js");
          const { loadConfig } = await import("../config/io.js");
          const os = await import("node:os");
          const hub = getFederationHub();
          const satellite = getFederationSatellite();
          const config = loadConfig();
          const { getLocalVersionInfo } = await import("../infra/version-info.js");
          const localInfo = await getLocalVersionInfo();
          const localNode: FederationNodeRow = {
            id: config.federation?.nodeId ?? "local",
            name: config.federation?.nodeName ?? localInfo.hostname ?? os.hostname(),
            status: "online",
            role: hub ? "master" : "standalone",
            isLocal: true,
            platform: process.platform,
            capabilities: { version: localInfo.version ?? "unknown" },
          };
          const satellites: FederationNodeRow[] = hub
            ? (hub.getConnectedNodes?.() ?? []).map((n: any) => ({
                id: n.id,
                name: n.manifest?.name ?? n.id,
                status: n.state === "registered" ? "online" : n.state,
                role: "satellite",
                isLocal: false,
                platform: (n.manifest?.capabilities as any)?.platform,
                activeSessions: n.activeSessions,
                capabilities: n.manifest?.capabilities,
                lastSeen: n.lastHeartbeat ?? n.connectedAt,
              }))
            : [];
          return { nodes: [localNode, ...satellites], role: localNode.role };
        } catch {
          return { nodes: [], role: "standalone" };
        }
      },
    },
    kanban: {
      async snapshot() {
        try {
          const { listProjects, listTasks } = await import("../databases/kanban-store-ops.js");
          return {
            projects: listProjects() as KanbanProjectRow[],
            tasks: listTasks() as KanbanTaskRow[],
          };
        } catch {
          return { projects: [], tasks: [] };
        }
      },
    },
    insights: {
      async summary() {
        try {
          const { getSystemsIntelligenceStore } = await import("../systems-intelligence/store.js");
          const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
          const store = getSystemsIntelligenceStore(stateDir);
          const values = store.listValues();
          const priorities = store.listPriorities();
          const now = Date.now();
          const insights: SystemsInsightRow[] = [];
          for (const value of values) {
            const linked = priorities.filter(
              (p: any) => Array.isArray(p.valueIds) && p.valueIds.includes(value.id),
            );
            if (linked.length === 0) {
              insights.push({
                id: `insight-no-priority-${value.id}`,
                type: "warning",
                title: `Value "${value.name}" has no linked priorities`,
                severity: "medium",
                createdAt: now,
              });
            }
          }
          for (const priority of priorities) {
            if (priority.status === "active" && (priority.progress ?? 0) < 20) {
              const days = (now - priority.updatedAt) / (1000 * 60 * 60 * 24);
              if (days > 7) {
                insights.push({
                  id: `insight-stalled-${priority.id}`,
                  type: "warning",
                  title: `Priority "${priority.title}" may be stalled`,
                  description: `No progress in ${Math.floor(days)} days.`,
                  severity: "high",
                  createdAt: now,
                });
              }
            }
          }
          return { insights };
        } catch {
          return { insights: [] };
        }
      },
    },
    credits: {
      async timeseries(opts) {
        try {
          const { timeseries } = await import("../credits/aggregator.js");
          const end = opts?.range?.end ?? Date.now();
          const start = opts?.range?.start ?? end - 24 * 60 * 60 * 1000;
          const bucket = (opts?.bucket ?? "hour") as "minute" | "hour" | "day" | "week";
          const points = timeseries({
            bucket,
            range: { start, end },
            groupBy: "agent_backend",
          });
          return { points: points as CreditsTimeseriesPoint[] };
        } catch {
          return { points: [] };
        }
      },
    },
    agents: {
      async list() {
        try {
          const { loadConfig } = await import("../config/io.js");
          const { listAgentsForGateway } = await import("../gateway/session-utils.js");
          const cfg = loadConfig();
          const result = listAgentsForGateway(cfg);
          return {
            agents: (result.agents ?? []).map((a: any) => ({
              id: a.id,
              name: a.name,
              identity: a.identity,
            })),
          };
        } catch {
          return { agents: [] };
        }
      },
    },
  };
}
