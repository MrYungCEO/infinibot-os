/**
 * Runtime walkthrough overrides (client-side).
 *
 * The bundled walkthroughs live under `src/learn/` and are served by the
 * gateway via `learn.tracks.list`. That directory is off-limits to the UI
 * build, so any walkthrough we want to author purely from the front-end lives
 * here instead and is *concatenated client-side* onto whatever the gateway
 * returns (see `mergeMissions`).
 *
 * These power the mission rail and floating Learn pill: each
 * mission is a short coachmark sequence (steps with an optional DOM `selector`
 * to highlight) that the `<coachmark-overlay>` walks the user through.
 */

import type { Tab } from "../ui/navigation";

export interface CoachStep {
  id: string;
  /** Tooltip heading. */
  title: string;
  /** Tooltip body (plain text / light markdown rendered as-is). */
  body: string;
  /**
   * CSS selector for the element to spotlight. When omitted the step renders as
   * a centered card (good for intros / outros).
   */
  selector?: string;
  /** Optional tab to navigate to before showing this step. */
  tab?: Tab;
  /** Estimated minutes for this step (summed into the mission ETA when set). */
  estMinutes?: number;
}

export interface LearnMission {
  id: string;
  title: string;
  description: string;
  /** Emoji / short glyph used as cover art. */
  icon: string;
  /** CSS gradient used as the card cover background. */
  cover: string;
  category: string;
  /** Rough completion time, minutes. */
  etaMin: number;
  /** Whether this mission is part of the Day-1 starter queue. */
  starter?: boolean;
  steps: CoachStep[];
}

// ── New walkthroughs authored from the UI ───────────────────────────────────

/** 09 — Knowledge Graph (graph view + agent memory). */
export const KNOWLEDGE_GRAPH: LearnMission = {
  id: "09-knowledge-graph",
  title: "Knowledge Graph",
  description: "See how your agent's memory connects — entities, relationships, and clusters.",
  icon: "◈",
  cover: "linear-gradient(135deg, #6366f1 0%, #0ea5e9 100%)",
  category: "Agent",
  etaMin: 3,
  steps: [
    {
      id: "open-graph",
      title: "Open the Knowledge Graph",
      body: "The Knowledge Graph renders your agent's memory as a live force-directed map. Nodes are entities; edges are the relationships the agent has learned.",
      tab: "knowledge-graph",
      selector: '[data-tab-pill="knowledge-graph"]',
      estMinutes: 1,
    },
    {
      id: "memory",
      title: "Where the data comes from",
      body: "The graph is fed by the Memory subsystem — identity, beliefs, values, relationships, and semantic memory. As the agent works, the graph grows.",
      tab: "memory",
      selector: '[data-tab-pill="memory"]',
      estMinutes: 1,
    },
    {
      id: "explore",
      title: "Explore & cluster",
      body: "Hover a node to highlight its connections; dense regions cluster into summaries automatically. It's the fastest way to audit what your agent actually knows about you.",
      estMinutes: 1,
    },
  ],
};

// ── Self-contained base missions (front-end only) ───────────────────────────
// These give the missions rail useful content even when the gateway's learn
// tracks aren't loaded. They intentionally mirror the "Day 1" vibe.

export const TOUR_DASHBOARD: LearnMission = {
  id: "01-tour-dashboard",
  title: "Tour the Dashboard",
  description: "Your command center — health, agents, suggestions, and the world map.",
  icon: "⌂",
  cover: "linear-gradient(135deg, #10b981 0%, #047857 100%)",
  category: "Getting started",
  etaMin: 2,
  starter: true,
  steps: [
    {
      id: "dashboard",
      title: "The Dashboard",
      body: "This is home base — a fast read on gateway health, running agents, and what to do next. Everything else is one tab away.",
      tab: "dashboard",
      selector: '[data-tab-pill="dashboard"]',
      estMinutes: 1,
    },
    {
      id: "topbar",
      title: "The topbar",
      body: "Up top: connection health, your plan badge, the active coding backend, and the terminal clock. The badges update live.",
      selector: ".topbar-coder-cluster",
      estMinutes: 1,
    },
  ],
};

export const FIRST_CHAT: LearnMission = {
  id: "02-first-chat",
  title: "Send your first message",
  description: "Open a chat and ask the agent to do something real.",
  icon: "✦",
  cover: "linear-gradient(135deg, #f59e0b 0%, #b45309 100%)",
  category: "Getting started",
  etaMin: 2,
  starter: true,
  steps: [
    {
      id: "open-chat",
      title: "Open Chat",
      body: "The Chat page is where you talk to your agents. Type in the box at the bottom and press Enter. Try “What can you see in my projects?”",
      tab: "webchat",
      selector: '[data-learn-id="chat-composer"], [data-tab-pill="webchat"]',
      estMinutes: 2,
    },
  ],
};

export const BUILD_A_WORKFLOW: LearnMission = {
  id: "03-build-a-workflow",
  title: "Build a Workflow",
  description: "Turn a repeatable process into a reusable, runnable workflow.",
  icon: "⚙",
  cover: "linear-gradient(135deg, #a78bfa 0%, #6d28d9 100%)",
  category: "Agent",
  etaMin: 3,
  starter: true,
  steps: [
    {
      id: "agents",
      title: "Start from Agents",
      body: "Agents are the workers. Workflows are the recipes they follow. We'll go from one to the other.",
      tab: "agents",
      selector: '[data-tab-pill="agents"]',
      estMinutes: 1,
    },
    {
      id: "workflows",
      title: "Open Workflows",
      body: "Workflows are reusable markdown instruction sets. Author once, then point any agent at it for a consistent multi-step process.",
      tab: "workflows",
      selector: '[data-tab-pill="workflows"]',
      estMinutes: 2,
    },
  ],
};

/** Front-end base missions, in display order. */
export const BASE_MISSIONS: LearnMission[] = [
  TOUR_DASHBOARD,
  FIRST_CHAT,
  BUILD_A_WORKFLOW,
  KNOWLEDGE_GRAPH,
];

/** Just the UI-authored override walkthroughs (08 + 09). */
export const EXTRA_WALKTHROUGHS: LearnMission[] = [KNOWLEDGE_GRAPH];

/** Ids that make up the Day-1 "starter mission" queue. */
export const STARTER_MISSION_IDS: string[] = BASE_MISSIONS.filter((m) => m.starter).map((m) => m.id);

/**
 * Return every mission, deduped by id. `serverTracks` (from
 * `learn.tracks.list`) is optional — when present, its entries are normalized
 * into `LearnMission` shape and concatenated, with UI-authored missions taking
 * precedence on id collisions so the override mechanism actually overrides.
 */
export function mergeMissions(serverTracks?: ServerTrackLike[]): LearnMission[] {
  const byId = new Map<string, LearnMission>();
  for (const t of serverTracks ?? []) {
    const m = normalizeServerTrack(t);
    if (m) byId.set(m.id, m);
  }
  // UI-authored missions win on collision.
  for (const m of BASE_MISSIONS) byId.set(m.id, m);
  return [...byId.values()];
}

/** Loose shape of a `learn.tracks.list` entry — only the bits we read. */
export interface ServerTrackLike {
  id: string;
  title?: string;
  description?: string;
  category?: string;
  steps?: Array<{ id: string; title: string; body: string; estMinutes?: number; cta?: { tab?: string } }>;
}

const FALLBACK_COVERS = [
  "linear-gradient(135deg, #6366f1 0%, #0ea5e9 100%)",
  "linear-gradient(135deg, #10b981 0%, #047857 100%)",
  "linear-gradient(135deg, #f59e0b 0%, #b45309 100%)",
  "linear-gradient(135deg, #a78bfa 0%, #6d28d9 100%)",
];

function normalizeServerTrack(t: ServerTrackLike): LearnMission | null {
  if (!t?.id || !Array.isArray(t.steps) || t.steps.length === 0) return null;
  const eta = t.steps.reduce((sum, s) => sum + (s.estMinutes ?? 1), 0);
  let hash = 0;
  for (const ch of t.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    id: t.id,
    title: t.title ?? t.id,
    description: t.description ?? "",
    icon: "◆",
    cover: FALLBACK_COVERS[hash % FALLBACK_COVERS.length]!,
    category: t.category ?? "General",
    etaMin: Math.max(1, eta),
    steps: t.steps.map((s) => ({
      id: s.id,
      title: s.title,
      body: s.body,
      estMinutes: s.estMinutes,
      tab: s.cta?.tab as Tab | undefined,
      selector: s.cta?.tab ? `[data-tab-pill="${s.cta.tab}"]` : undefined,
    })),
  };
}
