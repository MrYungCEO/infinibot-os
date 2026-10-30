/**
 * <subagent-activity-card> — the single running/completed sub-agent card.
 *
 * Extracted verbatim from <subagent-activity-panel> so the EXACT same card can
 * be reused on any surface (the Activity page panel, the Voice Terminal edge
 * HUD running lane, …). The panel owns polling + layout; this element owns one
 * card's markup, styling, progress ring, segments, footer, and inline detail.
 *
 * Data shape is the canonical `Subagent` row. The card never fetches — the host
 * passes a normalized `agent`, the shared `now` clock, an optional live-session
 * map (for progress estimation), the stagger `index`, and the layout `density`.
 *
 * Click → dispatches `infinibot:subagent-open-detail` (bubbles + composed) so
 * the shared detail modal opens. Modifier-click toggles the inline detail.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import {
  getCoderBackendIcon,
  getCoderBackendIconLabel,
} from "../lib/coder-backend-brand";
import type { AgentSession } from "../controllers/agent-activity";
import { estimateProgress } from "./progress-estimate";

// ============================================================
// Types
// ============================================================

export interface Subagent {
  runId: string;
  /** childSessionKey from the registry — used to correlate with live AgentSession. */
  sessionKey?: string;
  label: string;
  status: "pending" | "running" | "complete" | "error" | "timeout";
  progress: number;
  task: string;
  lastUpdateAt: number;
  startedAt?: number;
  endedAt?: number;
  completedAt?: number;
  currentCheckpoint?: string;
  checkpoints?: string[];
  result?: string;
  error?: string;
  /**
   * CLI backend that produced this run, when known. Renders the provider's
   * brand mark in the card head. Falls through silently when missing or
   * unrecognised so legacy rows still render.
   */
  coderBackend?: string;
  /** True when this sub-agent is running on a remote federation node. */
  remote?: boolean;
  /** Remote node identifier. */
  nodeId?: string;
  /** Remote node display name. Falls back to first 6 hex chars of nodeId. */
  nodeName?: string;
  lastActivity?: {
    kind: string;
    label: string;
    at?: number;
    ageMs?: number;
  };
}

/**
 * Resolve the coder backend for a row. Prefers the live-registry value, and
 * falls back to a label-prefix heuristic for legacy rows that predate the
 * `coderBackend` stamp — IDENTICAL to the running-agent header resolution in
 * views/agent-activity.ts, so the same row resolves the same brand on every
 * surface (running cards, this panel, the mesh world).
 */
export function resolveSubagentBackend(raw: {
  coderBackend?: string;
  label?: string;
}): string | undefined {
  if (raw.coderBackend) return raw.coderBackend;
  const label = raw.label ?? "";
  if (label.startsWith("OpenCode")) return "opencode";
  if (label.startsWith("Codex")) return "codex";
  if (label.startsWith("Claude Coder")) return "claude-code";
  return undefined;
}

export function normalizeStatus(raw: string): Subagent["status"] {
  switch (raw) {
    case "starting":    return "pending";
    case "working":
    case "checkpoint":
    case "blocked":     return "running";
    case "finishing":
    case "completed":   return "complete";
    case "error":
    case "failed":      return "error";
    case "timeout":     return "timeout";
    case "pending":     return "pending";
    case "running":     return "running";
    case "complete":    return "complete";
    default:            return "pending";
  }
}

// ============================================================
// Status helpers
// ============================================================

const STATUS_LABEL: Record<string, string> = {
  pending:  "Starting",
  running:  "Working",
  complete: "Done",
  error:    "Failed",
  timeout:  "Timeout",
};

// ============================================================
// Agent-type detection
// ============================================================

type AgentKind = "coder" | "voice" | "canvas" | "research" | "web" | "agent" | "unknown";

function detectAgentKind(label: string): AgentKind {
  const l = label.toLowerCase();
  if (/code|coder|engineer|dev|build|fix|typescript|python/.test(l)) return "coder";
  if (/voice|audio|speak|tts|mic|sound/.test(l))                       return "voice";
  if (/canvas|design|art|paint|visual|ui|ux/.test(l))                  return "canvas";
  if (/research|analyst|study|investigate|deep/.test(l))               return "research";
  if (/web|scrape|crawl|fetch|browse|search/.test(l))                  return "web";
  if (/agent|bot|spawn|worker|task/.test(l))                           return "agent";
  return "unknown";
}

// ============================================================
// Helpers
// ============================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatTimeAgo(ms: number): string {
  if (ms < 5000) return "just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function truncateText(text: string, maxLen = 80): string {
  if (!text || text.length <= maxLen) return text ?? "";
  return text.slice(0, maxLen - 3) + "…";
}

// Compact satellite/node icon: center dot + half arc above
const _nodeIconSvg = html`<svg viewBox="0 0 10 10" width="10" height="10" fill="none" aria-hidden="true"><circle cx="5" cy="5" r="1.5" fill="currentColor"/><path d="M2.5 5a2.5 2.5 0 0 1 5 0" stroke="currentColor" stroke-width="1" stroke-linecap="round" fill="none"/></svg>`;

// ============================================================
// SubagentActivityCard Component
// ============================================================

@customElement("subagent-activity-card")
export class SubagentActivityCard extends LitElement {
  /** The (already normalized) sub-agent row this card draws. */
  @property({ attribute: false }) agent!: Subagent;
  /**
   * Live session map keyed by session key, sourced from the Running Agents
   * feed. When provided, the card uses estimateProgress() for running/pending
   * subagents that haven't reported explicit backend progress.
   */
  @property({ attribute: false }) liveSessions: Map<string, AgentSession> | null = null;
  /** Shared clock from the host so every card ticks in lockstep. */
  @property({ type: Number }) now = Date.now();
  /** Stagger index for the entrance animation. */
  @property({ type: Number }) index = 0;
  /**
   * "compact"  = fixed-width card (horizontal scroll row)
   * "expanded" = fill-width card (grid / vertical lane)
   */
  @property({ type: String, reflect: true }) density: "compact" | "expanded" = "compact";

  @state() private expanded = false;

  static styles = css`
    /* The host width is driven by density so the same card fills a vertical
       lane (expanded) or sits in a fixed-width horizontal row (compact). */
    :host {
      display: block;
      font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
      flex-shrink: 0;
      width: 248px;
    }
    :host([density="expanded"]) { width: auto; }

    @media (max-width: 600px) {
      :host { width: 220px; }
      :host([density="expanded"]) { width: auto; }
    }

    /* ── Glass card ──────────────────────────────────────────── */
    .sap-card {
      position: relative;
      width: 100%;
      border-radius: 12px;
      padding: 13px;
      cursor: pointer;
      overflow: hidden;
      isolation: isolate;

      background: linear-gradient(
        155deg,
        rgba(255, 255, 255, 0.045) 0%,
        rgba(255, 255, 255, 0) 45%,
        rgba(0, 0, 0, 0.08) 100%
      ), rgba(12, 16, 26, 0.72);

      backdrop-filter: blur(28px) saturate(180%);
      -webkit-backdrop-filter: blur(28px) saturate(180%);

      border: 1px solid var(--card-accent-dim, rgba(255, 255, 255, 0.075));

      box-shadow:
        0 2px 10px rgba(0, 0, 0, 0.45),
        0 0 var(--card-glow-size, 0px) var(--card-glow-color, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        inset 0 -1px 0 rgba(0, 0, 0, 0.28);

      transition:
        transform 0.22s cubic-bezier(0.23, 1, 0.32, 1),
        box-shadow 0.22s ease,
        border-color 0.22s ease;

      animation: sap-card-in 0.38s cubic-bezier(0.23, 1, 0.32, 1) both;
      animation-delay: var(--card-delay, 0ms);
    }

    @keyframes sap-card-in {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      .sap-card { animation: none; }
    }

    .sap-card:hover {
      transform: translateY(-2px) rotate(0.4deg);
      box-shadow:
        0 10px 32px rgba(0, 0, 0, 0.55),
        0 0 calc(var(--card-glow-size, 0px) * 2) var(--card-glow-color, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.11),
        inset 0 -1px 0 rgba(0, 0, 0, 0.32);
    }

    /* Depth inner layer */
    .sap-card::after {
      content: "";
      position: absolute;
      inset: 2px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.015);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      pointer-events: none;
      z-index: -1;
    }

    /* Shimmer sweep — active cards only */
    .sap-card.is-active::before {
      content: "";
      position: absolute;
      top: 0;
      left: -100%;
      width: 55%;
      height: 100%;
      background: linear-gradient(
        108deg,
        transparent 20%,
        rgba(255, 255, 255, 0.048) 50%,
        transparent 80%
      );
      animation: sap-shimmer 3.8s ease-in-out infinite;
      pointer-events: none;
      z-index: 3;
    }

    @keyframes sap-shimmer {
      0%   { left: -100%; opacity: 0; }
      8%   { opacity: 1; }
      52%  { left: 120%; opacity: 1; }
      53%  { opacity: 0; }
      100% { left: 120%; opacity: 0; }
    }

    @media (prefers-reduced-motion: reduce) {
      .sap-card.is-active::before { display: none; }
    }

    /* ── HUD corner brackets ─────────────────────────────────── */
    .sap-bracket {
      position: absolute;
      width: 12px;
      height: 12px;
      pointer-events: none;
      z-index: 4;
      opacity: 0.65;
    }

    .sap-bracket--tl {
      top: 5px;
      left: 5px;
      border-top: 1.5px solid var(--card-accent-bright, rgba(255,255,255,0.25));
      border-left: 1.5px solid var(--card-accent-bright, rgba(255,255,255,0.25));
      border-radius: 2px 0 0 0;
    }

    .sap-bracket--br {
      bottom: 5px;
      right: 5px;
      border-bottom: 1.5px solid var(--card-accent-bright, rgba(255,255,255,0.25));
      border-right: 1.5px solid var(--card-accent-bright, rgba(255,255,255,0.25));
      border-radius: 0 0 2px 0;
    }

    /* ── Status variants (set CSS vars on card) ──────────────── */
    /* Running / pending route through the app theme tokens so the cards adopt
       whichever appearance theme the user picked (gold-family in the HUD). */
    .sap-card[data-status="running"] {
      --card-accent-dim:    color-mix(in srgb, var(--g-primary, #22d3ee) 30%, transparent);
      --card-accent-bright: color-mix(in srgb, var(--g-primary, #22d3ee) 60%, transparent);
      --card-status-color:  var(--g-primary, #22d3ee);
      --card-glow-color:    color-mix(in srgb, var(--g-primary, #22d3ee) 14%, transparent);
      --card-glow-size:     36px;
    }

    .sap-card[data-status="complete"] {
      --card-accent-dim:    rgba(34, 197, 94, 0.16);
      --card-accent-bright: rgba(34, 197, 94, 0.45);
      --card-status-color:  #22c55e;
      --card-glow-color:    rgba(34, 197, 94, 0.07);
      --card-glow-size:     24px;
      /* Mute completed cards to match the Activity page's iad-state-completed treatment */
      opacity: 0.88;
    }

    .sap-card[data-status="complete"]:hover {
      opacity: 1;
    }

    /* Dim corner brackets on completed cards — mirrors iad-state-completed .iad-tl/.iad-br */
    .sap-card[data-status="complete"] .sap-bracket {
      opacity: 0.4;
    }

    .sap-card[data-status="error"] {
      --card-accent-dim:    rgba(248, 113, 113, 0.2);
      --card-accent-bright: rgba(248, 113, 113, 0.55);
      --card-status-color:  #f87171;
      --card-glow-color:    rgba(248, 113, 113, 0.11);
      --card-glow-size:     30px;
    }

    .sap-card[data-status="pending"] {
      --card-accent-dim:    color-mix(in srgb, var(--g-accent, #f59e0b) 28%, transparent);
      --card-accent-bright: color-mix(in srgb, var(--g-accent, #f59e0b) 50%, transparent);
      --card-status-color:  var(--g-accent, #f59e0b);
      --card-glow-color:    color-mix(in srgb, var(--g-accent, #f59e0b) 10%, transparent);
      --card-glow-size:     20px;
    }

    .sap-card[data-status="timeout"] {
      --card-accent-dim:    rgba(107, 114, 128, 0.14);
      --card-accent-bright: rgba(107, 114, 128, 0.3);
      --card-status-color:  #6b7280;
    }

    /* ── Card inner content ───────────────────────────────────── */
    .sap-card-inner {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: column;
      gap: 9px;
    }

    /* Head row: type-icon + label/status + ring */
    .sap-card-head {
      display: flex;
      align-items: flex-start;
      gap: 9px;
    }

    .sap-type-icon {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.055);
      border: 1px solid var(--card-accent-dim, rgba(255,255,255,0.07));
      color: var(--card-status-color, rgba(255,255,255,0.4));
    }

    .sap-card[data-status="pending"] .sap-type-icon {
      animation: sap-icon-pulse 1.5s ease-in-out infinite;
    }

    @keyframes sap-icon-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.5; }
    }

    .sap-card-meta {
      flex: 1;
      min-width: 0;
    }

    /* Agent label row — label text + optional backend brand chip */
    .sap-label-row {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 4px;
      min-width: 0;
    }

    .sap-card-label {
      flex: 1;
      font-size: 13px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.92);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.2;
    }

    /* Backend brand chip — small, color picked up from --card-status-color */
    .sap-backend-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border-radius: 5px;
      color: rgba(255, 255, 255, 0.62);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .sap-backend-chip svg { display: block; }

    /* Status row */
    .sap-status-row {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .sap-status-icon {
      display: flex;
      align-items: center;
      color: var(--card-status-color, rgba(255,255,255,0.35));
      flex-shrink: 0;
    }

    .sap-status-icon svg { width: 12px; height: 12px; }

    .sap-status-icon.spinning svg { animation: sap-spin 1s linear infinite; }

    @keyframes sap-spin { to { transform: rotate(360deg); } }

    .sap-status-text {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.9px;
      font-family: var(--font-mono, monospace);
      color: var(--card-status-color, rgba(255,255,255,0.35));
    }

    .sap-progress-pct {
      margin-left: auto;
      font-size: 10.5px;
      font-weight: 700;
      font-family: var(--font-mono, monospace);
      font-variant-numeric: tabular-nums;
      color: var(--card-status-color, rgba(255,255,255,0.35));
      flex-shrink: 0;
      text-shadow: 0 0 12px var(--card-glow-color, transparent);
    }

    /* ── SVG progress ring ─────────────────────────────────────── */
    .sap-ring {
      flex-shrink: 0;
      transform: rotate(-90deg);
    }

    .sap-ring-track {
      fill: none;
      stroke: rgba(255, 255, 255, 0.055);
      stroke-width: 2.5;
    }

    .sap-ring-fill {
      fill: none;
      stroke: var(--card-status-color, rgba(255,255,255,0.3));
      stroke-width: 2.5;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.45s ease;
    }

    .sap-ring-fill.pulsing {
      filter: drop-shadow(0 0 3px var(--card-status-color, transparent));
      animation: sap-ring-pulse 2s ease-in-out infinite;
    }

    @keyframes sap-ring-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.65; }
    }

    @media (prefers-reduced-motion: reduce) {
      .sap-ring-fill.pulsing { animation: none; filter: none; }
    }

    /* ── Segmented progress bar ────────────────────────────────── */
    .sap-segs {
      display: flex;
      gap: 2px;
      height: 2.5px;
    }

    .sap-seg {
      flex: 1;
      border-radius: 1.5px;
      background: rgba(255, 255, 255, 0.065);
      transition: background 0.22s ease;
    }

    .sap-seg.lit {
      background: var(--card-status-color, rgba(255,255,255,0.3));
    }

    .sap-card[data-status="complete"] .sap-seg.lit {
      box-shadow: 0 0 5px var(--card-glow-color, transparent);
    }

    /* Pulse the leading lit segment when active */
    .sap-card.is-active .sap-seg.pulse {
      animation: sap-seg-pulse 1.1s ease-in-out infinite;
    }

    @keyframes sap-seg-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.35; }
    }

    @media (prefers-reduced-motion: reduce) {
      .sap-card.is-active .sap-seg.pulse { animation: none; }
    }

    /* ── Card footer ────────────────────────────────────────────── */
    .sap-card-foot {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .sap-checkpoint {
      font-size: 10px;
      font-style: italic;
      color: rgba(255, 255, 255, 0.32);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sap-activity-row {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      font-family: var(--font-mono, monospace);
      color: rgba(255, 255, 255, 0.28);
    }

    .sap-activity-row svg { width: 11px; height: 11px; flex-shrink: 0; }

    .sap-activity-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sap-activity-age {
      flex-shrink: 0;
      color: rgba(255, 255, 255, 0.18);
    }

    /* ── Expanded detail panel ─────────────────────────────────── */
    .sap-detail {
      margin-top: 2px;
      padding: 10px;
      background: rgba(0, 0, 0, 0.32);
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.055);
    }

    .sap-detail-section { margin-bottom: 8px; }
    .sap-detail-section:last-child { margin-bottom: 0; }

    .sap-detail-lbl {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.9px;
      color: rgba(255, 255, 255, 0.25);
      margin-bottom: 4px;
    }

    .sap-detail-val {
      font-family: var(--font-mono, monospace);
      font-size: 10.5px;
      line-height: 1.5;
      color: rgba(255, 255, 255, 0.6);
      background: rgba(0, 0, 0, 0.22);
      padding: 6px 8px;
      border-radius: 5px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 120px;
      overflow-y: auto;
    }

    .sap-detail-val.error-text { color: #f87171; }

    /* ── Federation node chip ────────────────────────────────────── */
    .sap-node-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 5px;
      border-radius: 20px;
      border: 1px solid var(--card-accent-dim, rgba(34, 211, 238, 0.22));
      background: color-mix(in srgb, var(--card-status-color, #22d3ee) 8%, transparent);
      color: var(--card-status-color, #22d3ee);
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.04em;
      font-family: var(--font-mono, monospace);
      flex-shrink: 0;
      max-width: 100px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: default;
    }

    .sap-node-chip svg { flex-shrink: 0; }

    .sap-node-ring {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      border: 1.5px solid currentColor;
      flex-shrink: 0;
      display: inline-block;
    }
  `;

  // ============================================================
  // Interactions
  // ============================================================

  private toggleExpanded() {
    this.expanded = !this.expanded;
  }

  /**
   * Primary click → open the global subagent detail modal via a CustomEvent
   * that bubbles + composes out of the shadow DOM.  Modifier-click
   * (alt/ctrl/meta/shift) keeps the inline-expand behavior as an escape hatch
   * for quick peeks without opening the full modal.
   */
  private handleCardClick(e: MouseEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
      this.toggleExpanded();
      return;
    }
    this.dispatchEvent(new CustomEvent("infinibot:subagent-open-detail", {
      detail: { runId: this.agent.runId },
      bubbles: true,
      composed: true,
    }));
  }

  // ============================================================
  // Render
  // ============================================================

  render() {
    const agent = this.agent;
    if (!agent) return nothing;
    const isActive = agent.status === "running" || agent.status === "pending";
    const backendPct = agent.status === "complete" ? 100 : (agent.progress || 0);
    let effectivePct = backendPct;
    if (isActive && backendPct === 0 && agent.sessionKey) {
      const liveSession = this.liveSessions?.get(agent.sessionKey) ?? null;
      if (liveSession) {
        effectivePct = estimateProgress(liveSession)?.pct ?? 0;
      }
    }
    const progress = Math.min(100, Math.max(0, effectivePct));
    const elapsed = agent.startedAt
      ? formatDuration(Math.max(0, this.now - agent.startedAt))
      : "—";
    const updatedAgo = agent.lastUpdateAt
      ? formatTimeAgo(Math.max(0, this.now - agent.lastUpdateAt))
      : null;

    return html`
      <div
        class="sap-card ${isActive ? "is-active" : ""}"
        data-status=${agent.status}
        style="--card-delay:${this.index * 55}ms"
        @click=${(e: MouseEvent) => this.handleCardClick(e)}
      >
        <div class="sap-bracket sap-bracket--tl"></div>
        <div class="sap-bracket sap-bracket--br"></div>

        <div class="sap-card-inner">
          <!-- Head: type icon + label + ring -->
          <div class="sap-card-head">
            <div class="sap-type-icon">
              ${this.renderTypeIcon(agent.label)}
            </div>
            <div class="sap-card-meta">
              <div class="sap-label-row">
                <div class="sap-card-label">${agent.label || "Sub-Agent"}</div>
                ${this.renderBackendChip(agent.coderBackend)}
                ${this.renderNodeChip(agent)}
              </div>
              <div class="sap-status-row">
                <span class="sap-status-icon ${isActive ? "spinning" : ""}">
                  ${this.renderStatusIcon(agent.status)}
                </span>
                <span class="sap-status-text">${STATUS_LABEL[agent.status] ?? agent.status}</span>
                ${progress > 0 ? html`
                  <span class="sap-progress-pct">${progress}%</span>
                ` : nothing}
              </div>
            </div>
            ${this.renderRing(progress, isActive)}
          </div>

          <!-- Segmented bar -->
          ${this.renderSegments(progress, isActive)}

          <!-- Footer -->
          <div class="sap-card-foot">
            ${agent.currentCheckpoint ? html`
              <div class="sap-checkpoint" title=${agent.currentCheckpoint}>
                ${truncateText(agent.currentCheckpoint, 58)}
              </div>
            ` : nothing}
            ${agent.lastActivity ? this.renderActivityRow(agent) : nothing}
            <div class="sap-activity-row">
              ${icons.clock}
              <span class="sap-activity-label">${elapsed}</span>
              ${updatedAgo ? html`
                <span class="sap-activity-age">${updatedAgo}</span>
              ` : nothing}
            </div>
          </div>

          <!-- Expanded detail -->
          ${this.expanded ? this.renderDetail(agent) : nothing}
        </div>
      </div>
    `;
  }

  private renderRing(progress: number, isActive: boolean) {
    const r = 13;
    const circ = 2 * Math.PI * r;
    const offset = circ * (1 - progress / 100);
    return html`
      <svg class="sap-ring" width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <circle class="sap-ring-track" cx="17" cy="17" r=${r}/>
        <circle
          class="sap-ring-fill ${isActive ? "pulsing" : ""}"
          cx="17" cy="17" r=${r}
          stroke-dasharray=${circ.toFixed(2)}
          stroke-dashoffset=${offset.toFixed(2)}
        />
      </svg>
    `;
  }

  private renderSegments(progress: number, isActive: boolean) {
    const SEGS = 10;
    const lit = Math.round((progress / 100) * SEGS);
    return html`
      <div class="sap-segs" aria-hidden="true">
        ${Array.from({ length: SEGS }, (_, i) => {
          const isLit = i < lit;
          // Only pulse the rightmost lit segment
          const isPulse = isActive && isLit && i === lit - 1;
          return html`<div class="sap-seg ${isLit ? "lit" : ""} ${isPulse ? "pulse" : ""}"></div>`;
        })}
      </div>
    `;
  }

  private renderActivityRow(agent: Subagent) {
    const la = agent.lastActivity!;
    const ageMs = typeof la.ageMs === "number"
      ? la.ageMs
      : la.at ? this.now - la.at : 0;
    return html`
      <div class="sap-activity-row">
        ${this.renderActivityIcon(la.kind)}
        <span class="sap-activity-label">${truncateText(la.label, 52)}</span>
        <span class="sap-activity-age">${formatTimeAgo(Math.max(0, ageMs))}</span>
      </div>
    `;
  }

  private renderDetail(agent: Subagent) {
    return html`
      <div class="sap-detail">
        <div class="sap-detail-section">
          <div class="sap-detail-lbl">Run ID</div>
          <div class="sap-detail-val">${agent.runId}</div>
        </div>
        ${agent.task ? html`
          <div class="sap-detail-section">
            <div class="sap-detail-lbl">Task</div>
            <div class="sap-detail-val">${agent.task}</div>
          </div>
        ` : nothing}
        ${agent.result ? html`
          <div class="sap-detail-section">
            <div class="sap-detail-lbl">Result</div>
            <div class="sap-detail-val">${agent.result.slice(0, 800)}${agent.result.length > 800 ? "…" : ""}</div>
          </div>
        ` : nothing}
        ${agent.error ? html`
          <div class="sap-detail-section">
            <div class="sap-detail-lbl">Error</div>
            <div class="sap-detail-val error-text">${agent.error}</div>
          </div>
        ` : nothing}
        ${agent.startedAt ? html`
          <div class="sap-detail-section">
            <div class="sap-detail-lbl">Started</div>
            <div class="sap-detail-val">${new Date(agent.startedAt).toLocaleString()}</div>
          </div>
        ` : nothing}
        ${agent.completedAt ? html`
          <div class="sap-detail-section">
            <div class="sap-detail-lbl">Completed</div>
            <div class="sap-detail-val">${new Date(agent.completedAt).toLocaleString()}</div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  // ============================================================
  // Icon helpers — SVG only, no emoji
  // ============================================================

  private renderStatusIcon(status: string) {
    switch (status) {
      case "running":  return icons.loader;
      case "pending":  return icons.loader;
      case "complete": return icons.checkCircle;
      case "error":    return icons.xCircle;
      case "timeout":  return icons.clockRotate;
      default:         return icons.loader;
    }
  }

  private renderBackendChip(backend: string | undefined) {
    const icon = getCoderBackendIcon(backend);
    if (!icon) return nothing;
    const label = getCoderBackendIconLabel(backend);
    return html`
      <span class="sap-backend-chip" title=${label} aria-label=${label}>
        ${icon}
      </span>
    `;
  }

  private renderNodeChip(agent: Subagent) {
    if (!agent.remote || (!agent.nodeId && !agent.nodeName)) return nothing;
    const raw = agent.nodeName || agent.nodeId!.slice(0, 6);
    const name = raw.length > 14 ? raw.slice(0, 14) + "…" : raw;
    const tooltip = `Node: ${agent.nodeName || agent.nodeId}`;
    return html`
      <span class="sap-node-chip" title=${tooltip}
      >${_nodeIconSvg}${name}<span class="sap-node-ring"></span></span>
    `;
  }

  private renderTypeIcon(label: string) {
    const kind = detectAgentKind(label);
    switch (kind) {
      case "coder":    return icons.fileCode;
      case "voice":    return icons.mic;
      case "canvas":   return icons.palette;
      case "research": return icons.search;
      case "web":      return icons.globe;
      case "agent":    return icons.bot;
      default:         return icons.sparkles;
    }
  }

  private renderActivityIcon(kind: string) {
    switch (kind) {
      case "Read":                  return icons.fileText;
      case "Edit":
      case "Write":                 return icons.edit;
      case "Bash":                  return icons.zap;
      case "Grep":
      case "Glob":                  return icons.search;
      case "WebFetch":
      case "WebSearch":             return icons.globe;
      case "Task":
      case "Agent":                 return icons.bot;
      case "assistant":             return icons.sparkles;
      case "tool_error":
      case "error":                 return icons.xCircle;
      case "done":                  return icons.checkCircle;
      default:                      return icons.wrench;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "subagent-activity-card": SubagentActivityCard;
  }
}
