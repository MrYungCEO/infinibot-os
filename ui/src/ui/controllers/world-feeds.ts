/**
 * World Feeds — data publisher for the <world-overlays> heatmap + mission layers.
 *
 * The overlay renderers (heatmap-layer.ts, mission-overlay.ts) are presentation
 * only: they read per-agent weights and a critical-path set keyed by the same
 * agent id the engine publishes in `window.__agentFxState` (= sessionKey). This
 * controller is the missing producer: it polls the gateway for real spend,
 * failures, and the kanban critical path, derives those structures, and publishes
 * them both on the `window.__worldHeatmap` / `window.__worldMission` fallbacks the
 * overlay reads AND directly via the overlay's setters when an instance is given.
 *
 * Pure data-plane: it never touches Pixi, the canvas, or layout. Polls on a slow
 * cadence (heatmap/burn move slowly) and tolerates every RPC failing independently
 * so a missing feed degrades to "no heat" instead of throwing.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { HeatmapWeights, MissionData, MissionSector } from "../components/world-overlays/types";

interface OverlaySink {
  setHeatmapWeights?: (w: HeatmapWeights) => void;
  setMissionData?: (d: MissionData) => void;
}

export interface WorldFeeds {
  stop(): void;
}

export interface WorldFeedsOptions {
  client?: GatewayBrowserClient | null;
  overlays?: OverlaySink | null;
}

const POLL_MS = 8000;

interface HistoryEntry {
  sessionKey?: string;
  status?: string;
}
interface CreditEntry {
  sessionKey?: string | null;
  costUsd?: number;
}
interface LiveAgent {
  sessionKey: string;
  task?: string;
  status?: string;
}
interface KanbanTask {
  title?: string;
  priority?: string;
  status?: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Start the world-feeds poll loop. Returns a handle whose stop() clears the timer.
 * `overlays` may be null (window-global publication still happens for the layer's
 * own fallback read path).
 */
export function startWorldFeeds(opts: WorldFeedsOptions): WorldFeeds {
  const client = opts.client ?? null;
  const sink = opts.overlays ?? null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const safeRequest = async <T = unknown>(method: string, params?: unknown): Promise<T | null> => {
    if (!client) return null;
    try {
      return (await client.request<T>(method, params)) ?? null;
    } catch {
      return null;
    }
  };

  async function computeHeatmap(): Promise<HeatmapWeights> {
    const burn: Record<string, number> = {};
    const failure: Record<string, number> = {};

    // Burn — sum recent credit spend per sessionKey.
    const credits = await safeRequest<{ entries?: CreditEntry[] }>("credits.recent", { limit: 300 });
    for (const e of credits?.entries ?? []) {
      const sk = e.sessionKey ?? undefined;
      if (!sk) continue;
      burn[sk] = (burn[sk] ?? 0) + num(e.costUsd);
    }

    // Failure — count error/timeout terminal runs per sessionKey.
    const hist = await safeRequest<{ history?: HistoryEntry[] }>("subagents.history", {
      limit: 200,
    });
    for (const h of hist?.history ?? []) {
      const sk = h.sessionKey;
      if (!sk) continue;
      const s = (h.status ?? "").toLowerCase();
      if (s === "error" || s === "timeout") failure[sk] = (failure[sk] ?? 0) + 1;
    }

    return { burn, failure };
  }

  async function computeMission(): Promise<MissionData> {
    const live = await safeRequest<{ agents?: LiveAgent[] }>("subagents.list", {});
    const agents = live?.agents ?? [];
    if (!agents.length) return { criticalAgentIds: [], criticalSectors: [] };

    // Critical tasks = kanban tasks at critical/high priority that are still open.
    const tasksRes = await safeRequest<{ tasks?: KanbanTask[] }>("kanban.tasks.list", {});
    const criticalTitles: string[] = [];
    for (const t of tasksRes?.tasks ?? []) {
      const p = (t.priority ?? "").toLowerCase();
      const st = (t.status ?? "").toLowerCase();
      const open = st !== "done" && st !== "cancelled";
      if (open && (p === "critical" || p === "high") && t.title) {
        criticalTitles.push(t.title.toLowerCase());
      }
    }

    // An agent is on the critical path when its current task text matches a
    // critical kanban task (substring either direction — agent task labels and
    // kanban titles rarely match verbatim).
    const criticalAgentIds: string[] = [];
    for (const a of agents) {
      const task = (a.task ?? "").toLowerCase().trim();
      if (!task) continue;
      const hit = criticalTitles.some(
        (title) => title.length > 4 && (task.includes(title) || title.includes(task)),
      );
      if (hit) criticalAgentIds.push(a.sessionKey);
    }

    const criticalSectors: MissionSector[] = [];
    return { criticalAgentIds, criticalSectors };
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const [heat, mission] = await Promise.all([computeHeatmap(), computeMission()]);
      if (stopped) return;
      window.__worldHeatmap = heat;
      window.__worldMission = mission;
      sink?.setHeatmapWeights?.(heat);
      sink?.setMissionData?.(mission);

      // Aggregate system-activity level (0..1) for the volumetric ground-grid
      // pulse (activity-map updateFloorPulse) and the <world-environment> element.
      // Blend recent total burn (log-scaled) with the live-agent count so the
      // floor breathes faster when either money OR concurrency is high.
      const totalBurn = Object.values(heat.burn ?? {}).reduce((a, b) => a + b, 0);
      const liveAgents = Object.keys(heat.burn ?? {}).length;
      const burnLevel = Math.min(1, Math.log10(1 + totalBurn * 50) / 2);
      const concurrency = Math.min(1, liveAgents / 8);
      const activity = Math.max(0, Math.min(1, 0.6 * concurrency + 0.4 * burnLevel));
      window.__worldActivity = activity;
      if (typeof window.dispatchEvent === "function") {
        window.dispatchEvent(new CustomEvent("world-env:activity", { detail: activity }));
      }
    } catch {
      /* a bad poll never kills the loop */
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    }
  }

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
