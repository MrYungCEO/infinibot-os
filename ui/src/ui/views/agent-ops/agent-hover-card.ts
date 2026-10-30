import type { MeshAgent, MeshNode } from "./activity-map";
import { placeFloatingRect, type ScreenRect } from "./overlay-placement";

export type HoverCardTone = "active" | "waiting" | "success" | "danger" | "idle";

export interface AgentHoverCardModel {
  name: string;
  agentId: string;
  status: string;
  statusLabel: string;
  tone: HoverCardTone;
  task: string;
  activity: string;
  backend: string;
  node: string;
  progress: number;
  runtime: string;
  tokens: string;
  updated: string;
  checkpoint: string | null;
  runId: string | null;
  plugin: string | null;
  review: string | null;
  reviewStatus: string | null;
}

export interface HoverCardPlacement {
  left: number;
  top: number;
  mobile: boolean;
}

const STATUS: Record<string, { label: string; tone: HoverCardTone }> = {
  starting: { label: "Starting", tone: "waiting" },
  queued: { label: "Queued", tone: "waiting" },
  working: { label: "Working", tone: "active" },
  running: { label: "Working", tone: "active" },
  checkpoint: { label: "Checkpoint", tone: "active" },
  blocked: { label: "Blocked", tone: "danger" },
  finishing: { label: "Finishing", tone: "waiting" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  idle: { label: "Idle", tone: "idle" },
};

export function backendDisplayName(value?: string): string {
  const key = (value || "").toLowerCase();
  const labels: Record<string, string> = {
    "claude-code": "Claude Code",
    claude: "Claude Code",
    "claude-coder": "Claude Code",
    codex: "Codex CLI",
    opencode: "OpenCode",
    gemini: "Gemini CLI",
  };
  return labels[key] || value || "Native agent";
}

export function formatCompactNumber(value?: number): string {
  if (!Number.isFinite(value) || !value || value < 0) return "—";
  return new Intl.NumberFormat("en", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

export function formatUpdatedAgo(timestamp: number | undefined, now: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "No recent signal";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 5_000) return "Updated just now";
  return `Updated ${formatElapsed(elapsed)} ago`;
}

export function buildAgentHoverCardModel(
  agent: MeshAgent,
  node: MeshNode | undefined,
  review: any,
  now = Date.now(),
): AgentHoverCardModel {
  const rawStatus = String(agent.status || "idle").toLowerCase();
  const status = STATUS[rawStatus] ?? {
    label: rawStatus ? rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1) : "Idle",
    tone: "idle" as const,
  };
  const activity = agent.activityLabel || agent.lastActivity?.label || "Waiting for the next action";
  const task = agent.currentTask || activity || "No active task";
  const lastSignal = agent.lastActivityAt || agent.lastActivity?.at || agent.lastUpdateAt;
  const reviewSummary = typeof review?.summary === "string" && review.summary.trim()
    ? review.summary.trim()
    : null;

  return {
    name: agent.label || agent.agentId || agent.sessionKey,
    agentId: agent.agentId || agent.sessionKey,
    status: rawStatus,
    statusLabel: status.label,
    tone: status.tone,
    task,
    activity,
    backend: backendDisplayName(agent.coderBackend || agent.model),
    node: node?.name || agent.nodeId || "Local",
    progress: Math.max(0, Math.min(100, Number(agent.progress) || 0)),
    runtime: agent.startedAt ? formatElapsed(now - agent.startedAt) : "—",
    tokens: formatCompactNumber(agent.totalTokens),
    updated: formatUpdatedAgo(lastSignal, now),
    checkpoint: agent.currentCheckpoint || null,
    runId: agent.runId || null,
    plugin: agent.pluginId || null,
    review: reviewSummary,
    reviewStatus: review?.status ? String(review.status) : null,
  };
}

export function placeAgentHoverCard(args: {
  anchorX: number;
  anchorY: number;
  hostWidth: number;
  hostHeight: number;
  cardWidth: number;
  cardHeight: number;
  mobile: boolean;
  gap?: number;
  margin?: number;
  /** Screen rect of the agent's sprite ∪ name tag. When given, the card is
   *  placed beside it (flipping/sliding) instead of next to the pointer. */
  anchorRect?: ScreenRect | null;
  /** Other labels (name tags, floor signs) the card should keep clear of. */
  obstacles?: readonly ScreenRect[];
}): HoverCardPlacement {
  const gap = args.gap ?? 16;
  const margin = args.margin ?? 12;
  if (args.mobile) {
    const bottomTop = Math.max(margin, args.hostHeight - args.cardHeight - margin);
    const a = args.anchorRect;
    // Bottom sheet by default; flip to the top edge when the sheet would sit
    // on the very agent (and name tag) it describes and the top is clear.
    if (a && a.y + a.height > bottomTop && a.y >= margin + args.cardHeight + 4) {
      return { left: margin, top: margin, mobile: true };
    }
    return { left: margin, top: bottomTop, mobile: true };
  }

  if (args.anchorRect) {
    const p = placeFloatingRect({
      anchor: args.anchorRect,
      size: { width: args.cardWidth, height: args.cardHeight },
      bounds: { width: args.hostWidth, height: args.hostHeight },
      obstacles: args.obstacles,
      gap,
      margin,
    });
    return { left: p.x, top: p.y, mobile: false };
  }

  const right = args.anchorX + gap;
  const left = args.anchorX - args.cardWidth - gap;
  const proposedLeft = right + args.cardWidth <= args.hostWidth - margin ? right : left;
  return {
    left: Math.max(margin, Math.min(proposedLeft, args.hostWidth - args.cardWidth - margin)),
    top: Math.max(margin, Math.min(args.anchorY - args.cardHeight / 2, args.hostHeight - args.cardHeight - margin)),
    mobile: false,
  };
}
