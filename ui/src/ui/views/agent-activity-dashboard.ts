/**
 * Agent Activity Dashboard — Sections A–D layout module.
 *
 * Scope: LAYOUT + visualization only.
 * Consumes existing controller data (agentActivityState, kanbanTasks/Projects).
 * Does NOT touch: session registry, polling logic, list-keying, kanban store.
 *
 * Sibling scopes:
 *   coder-agent-activity-feed-persistence-fix-cils — subagent-activity-panel.ts + session keying
 *   coder-recently-completed-feed-kanban-time-vg23 — kanban store timestamps + listRecentlyCompleted RPC
 */

import { html, nothing, svg, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { AgentActivityState, AgentSession } from "../controllers/agent-activity";
import type { KanbanTask, KanbanProject } from "../types";
import {
  loadRecentlyCompleted,
  subscribeRecentCompleted,
  renderRecentlyCompletedBody,
  getRecentlyCompletedTodayCount,
} from "./recently-completed-feed";
import { openSubagentDetailModal } from "../components/subagent-detail-modal";
import {
  getCoderBackendIcon,
  getCoderBackendIconLabel,
  getCoderBackendBrand,
  type CoderBackendIconId,
} from "../lib/coder-backend-brand";
import { icons } from "../icons";
import { managedInterval, type SchedulerHandle } from "../perf/visibility-scheduler";

// ── Metric history ring buffer ───────────────────────────────────────────────

interface MetricSample {
  ts: number;
  activeAgents: number;
  pendingTasks: number;
  completedToday: number;
}

const MAX_SAMPLES = 30;
let _samples: MetricSample[] = [];
let _notifTimerId: SchedulerHandle | null = null;
let _sampleTimerId: SchedulerHandle | null = null;
let _durationTimerId: SchedulerHandle | null = null;
let _fileCountTimerId: SchedulerHandle | null = null;
let _dashReqUpdate: (() => void) | null = null;
let _dashInitialized = false;

// ── Notification strip cache ─────────────────────────────────────────────────
interface NotifStripItem {
  id: string;
  category: string;
  title: string;
  body: string;
  severity: string;
  ts: number;
  deepLink?: string | null;
}
let _notifStripItems: NotifStripItem[] = [];

// ── Subagent detail modal ─────────────────────────────────────────────────────
// Modal state + render lives in components/subagent-detail-modal.ts so the
// top-section <subagent-activity-panel>, the chat-page panel, AND the cards
// in this dashboard all flow through the same modal.

const _subagentFileCounts = new Map<string, number>();

function _pushSample(m: { activeAgents: number; pendingTasks: number; completedToday: number }): void {
  _samples = [..._samples.slice(-(MAX_SAMPLES - 1)), { ts: Date.now(), ...m }];
}

export function initDashboard(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
  getMetrics: () => { activeAgents: number; pendingTasks: number; completedToday: number },
): void {
  _dashReqUpdate = requestUpdate;
  if (_dashInitialized) return;
  _dashInitialized = true;

  // Kick recently-completed subscription (guard inside is idempotent)
  void loadRecentlyCompleted(client, requestUpdate);
  subscribeRecentCompleted(client);

  // Load recent agent completion notifications for the top strip
  void loadNotifStrip(client, requestUpdate);
  if (_notifTimerId === null) {
    _notifTimerId = managedInterval(() => void loadNotifStrip(client, requestUpdate), 60_000, {
      hiddenMs: 120_000,
    });
  }

  // Sample metrics every 60 s for sparklines
  const sample = () => _pushSample(getMetrics());
  sample();
  if (_sampleTimerId === null) {
    _sampleTimerId = managedInterval(sample, 60_000, { hiddenMs: 120_000 });
  }

  // 1 s tick keeps live-duration counters on agent cards current
  if (_durationTimerId === null) {
    _durationTimerId = managedInterval(() => { _dashReqUpdate?.(); }, 1_000, { hiddenMs: 30_000 });
  }

  // Seed subagent file-count badges on startup, refresh every 30s
  void refreshSubagentFileCounts(client, requestUpdate);
  if (_fileCountTimerId === null) {
    _fileCountTimerId = managedInterval(() => void refreshSubagentFileCounts(client, requestUpdate), 30_000, {
      hiddenMs: 120_000,
    });
  }
}

async function refreshSubagentFileCounts(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): Promise<void> {
  try {
    const resp = await (client as unknown as { request: (m: string, p?: unknown) => Promise<unknown> })
      .request("subagents.list", { includeCompleted: true, compact: true, limit: 100 });
    const r = resp as { subagents?: Array<{ sessionKey: string; filesTouchedCount?: number }> };
    if (!r?.subagents) return;
    let changed = false;
    for (const sub of r.subagents) {
      const prev = _subagentFileCounts.get(sub.sessionKey);
      const next = sub.filesTouchedCount ?? 0;
      if (prev !== next) { _subagentFileCounts.set(sub.sessionKey, next); changed = true; }
    }
    if (changed) requestUpdate();
  } catch { /* non-fatal */ }
}

async function loadNotifStrip(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): Promise<void> {
  try {
    const resp = await (client as unknown as { request: (m: string, p?: unknown) => Promise<unknown> })
      .request("notifications.history.list", {
        limit: 5,
        filters: { categories: ["agent.completed", "agent.error", "agent.input_required"] },
      });
    const r = resp as { items?: NotifStripItem[] };
    if (!r?.items) return;
    _notifStripItems = r.items.slice(0, 5);
    requestUpdate();
  } catch { /* non-fatal: strip is hidden when empty */ }
}

// ── Formatters ───────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function trendIndicator(samples: number[]): string {
  if (samples.length < 2) return "";
  const last = samples[samples.length - 1];
  const prev = samples[Math.max(0, samples.length - 6)];
  if (last > prev) return "▲";
  if (last < prev) return "▼";
  return "—";
}

// ── SVG helpers ──────────────────────────────────────────────────────────────

function sparklineSVG(values: number[], color: string): TemplateResult {
  if (values.length < 2) {
    return html`<svg viewBox="0 0 100 20" style="width:100%;height:20px;" preserveAspectRatio="none"></svg>`;
  }
  const W = 100; const H = 20;
  const max = Math.max(...values, 1);
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - (v / max) * H * 0.85).toFixed(1)}`)
    .join(" ");
  const areaPath = `M ${pts} L ${W},${H} 0,${H} Z`;
  return html`
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:20px;" preserveAspectRatio="none">
      ${svg`<path d="${areaPath}" fill="${color}" fill-opacity="0.18"/>`}
      ${svg`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`}
    </svg>
  `;
}

function ringProgressSVG(pct: number, color: string, size = 60): TemplateResult {
  const r = size / 2 - 7;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.max(0, Math.min(100, pct)) / 100);
  const cx = size / 2;
  return html`
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"
         style="transform:rotate(-90deg);display:block;">
      ${svg`<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="5"/>`}
      ${svg`<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="5"
        stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
        stroke-linecap="round"
        style="transition:stroke-dashoffset 600ms cubic-bezier(0.22,1,0.36,1);"/>`}
    </svg>
  `;
}

// ── Session helpers ──────────────────────────────────────────────────────────

function sessionLabel(s: AgentSession): string {
  return s.label || s.displayName || s.derivedTitle || s.agentName;
}

function sessionGoal(s: AgentSession): string {
  return (s.derivedTitle || s.lastMessagePreview || "").slice(0, 110);
}

function sessionProgress(s: AgentSession): { phase: string; pct: number } {
  if (s.completedViaEvent) {
    return s.completionState === "error" ? { phase: "ERROR", pct: 100 } : { phase: "DONE", pct: 100 };
  }
  if (!s.active) return { phase: "IDLE", pct: 0 };
  const tools = s.steps.filter(st => st.type === "tool_call").length;
  const last = s.steps[s.steps.length - 1];
  if (!last) return { phase: "START", pct: 5 };
  if (last.type === "thinking") return { phase: "THINK", pct: Math.min(30 + tools * 5, 80) };
  if (last.type === "tool_call") return { phase: last.content.toUpperCase().slice(0, 14) || "WORK", pct: Math.min(20 + tools * 8, 90) };
  return { phase: "WORK", pct: Math.min(10 + s.steps.length * 3, 85) };
}

function sessionDuration(s: AgentSession): string {
  const start = s.steps.length > 0 ? s.steps[0].timestamp : (s.updatedAt ?? 0);
  if (!start) return "—";
  return fmtDuration(Date.now() - start);
}

function sessionCheckpoint(s: AgentSession): string {
  const last = s.steps[s.steps.length - 1];
  if (!last) return "";
  const raw = (last.content || "").replace(/\s+/g, " ").trim();
  return raw.length > 82 ? raw.slice(0, 82) + "…" : raw;
}

// ── Section A — Hero tile ────────────────────────────────────────────────────

function renderHeroTile(opts: {
  label: string;
  value: string | number;
  subValue?: string;
  trendStr: string;
  samples: number[];
  warn?: boolean;
  danger?: boolean;
}): TemplateResult {
  const { label, value, subValue, trendStr, samples, warn, danger } = opts;
  const color = danger ? "#ef4444" : warn ? "#f59e0b" : "var(--g-primary, #fbbf24)";
  const glow = danger
    ? "rgba(239,68,68,0.30)"
    : warn
    ? "rgba(245,158,11,0.24)"
    : "rgba(251,191,36,0.30)";

  return html`
    <div class="iad-hero-tile${warn ? " iad-warn" : ""}${danger ? " iad-danger" : ""}">
      <div class="iad-corner iad-tl"></div>
      <div class="iad-corner iad-br"></div>
      <div class="iad-hero-label">${label}</div>
      <div class="iad-hero-num" style="color:${color};text-shadow:0 0 28px ${glow};">
        ${value}
        ${subValue ? html`<span class="iad-hero-sub">${subValue}</span>` : nothing}
      </div>
      ${trendStr ? html`<div class="iad-hero-trend" style="color:${color};">${trendStr}</div>` : nothing}
      <div class="iad-sparkline">${sparklineSVG(samples, color)}</div>
    </div>
  `;
}

// ── Section B — Running agent card ───────────────────────────────────────────

/**
 * Resolve the coder backend id for a session, falling back to display-name
 * heuristics for legacy rows that predate the coderBackend stamp (mirrors
 * resolveCoderBrand in agent-activity.ts).
 */
function resolveBackendId(session: AgentSession): CoderBackendIconId | null {
  if (session.coderBackend) return session.coderBackend;
  const dn = session.displayName ?? "";
  if (dn.startsWith("OpenCode")) return "opencode";
  if (dn.startsWith("Codex")) return "codex";
  if (dn.startsWith("Claude Coder")) return "claude-code";
  if (dn.startsWith("Gemini")) return "gemini";
  if (dn.startsWith("Grok")) return "grok";
  return null;
}

/**
 * Visual source variant on the card:
 *   coder    — backend-branded (per-backend accent + logo)
 *   native   — gold/HUD accent (autonomous main session)
 *   external — neutral muted (PTY / other)
 */
function resolveSourceVariant(
  session: AgentSession,
  backendId: CoderBackendIconId | null,
): "coder" | "native" | "external" {
  if (backendId) return "coder";
  if (session.kind === "other") return "external";
  return "native";
}

/**
 * Reduce the AgentSession to one of the five card substates. activeSessions
 * are filtered to !completedViaEvent upstream, so spawned/running is the
 * common path; completed/error/timeout/cancelled is forward-compat for a
 * future grace-window where terminal cards linger before being filtered out.
 */
function resolveSubstate(
  session: AgentSession,
): "running" | "complete" | "error" | "timeout" | "cancelled" {
  if (session.completedViaEvent) {
    if (session.completionState === "error") return "error";
    return "complete";
  }
  return "running";
}

/** Status pill icon (terminal states use the icon set; running has no icon — uses live dot). */
function renderTerminalIcon(
  substate: "complete" | "error" | "timeout" | "cancelled",
): TemplateResult {
  if (substate === "complete") return icons.checkCircle;
  if (substate === "error") return icons.xCircle;
  if (substate === "timeout") return icons.clock;
  return icons.stop; // cancelled
}

function substateLabel(substate: ReturnType<typeof resolveSubstate>): string {
  if (substate === "complete") return "COMPLETE";
  if (substate === "error") return "ERROR";
  if (substate === "timeout") return "TIMEOUT";
  if (substate === "cancelled") return "CANCELLED";
  return "RUNNING";
}

// Compact satellite/node glyph: center dot + half arc
const _dashNodeIcon: TemplateResult = html`<svg viewBox="0 0 10 10" width="10" height="10" fill="none" aria-hidden="true"><circle cx="5" cy="5" r="1.5" fill="currentColor"/><path d="M2.5 5a2.5 2.5 0 0 1 5 0" stroke="currentColor" stroke-width="1" stroke-linecap="round" fill="none"/></svg>`;

/** Satellite role indicator: hollow ring = remote (satellite), none for local. */
function renderFederationChip(session: AgentSession): TemplateResult | typeof nothing {
  if (!session.remote) return nothing;
  const raw = session.node && session.node !== "federation" && session.node !== "local"
    ? session.node
    : session.node === "federation" ? "fed" : null;
  if (!raw) return nothing;
  const name = raw.length > 14 ? raw.slice(0, 14) + "…" : raw;
  const tooltip = `Federation node: ${session.node}`;
  return html`<span class="iad-fed-chip" title="${tooltip}">${_dashNodeIcon}${name}<span class="iad-fed-ring"></span></span>`;
}

/** Generic agent fallback icon when no coder backend is known. */
const genericAgentIcon: TemplateResult = html`
  <svg
    width="14" height="14" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="1.75"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  >
    <path d="M12 8V4H8"/>
    <rect width="16" height="12" x="4" y="8" rx="2"/>
    <path d="M2 14h2"/><path d="M20 14h2"/>
    <path d="M15 13v2"/><path d="M9 13v2"/>
  </svg>
`;

function renderRunningAgentCard(
  session: AgentSession,
  linkedProject: KanbanProject | undefined,
  onViewKanban: ((projectId: string) => void) | undefined,
  onCardClick?: (() => void) | undefined,
  filesTouchedCount?: number,
): TemplateResult {
  const prog = sessionProgress(session);
  const backendId = resolveBackendId(session);
  const source = resolveSourceVariant(session, backendId);
  const substate = resolveSubstate(session);
  const stateGroup: "spawned" | "completed" =
    substate === "running" ? "spawned" : "completed";

  // Accent: brand-kit hex for coder runs (provider-branded), gold for native,
  // neutral grey for external. Drives --card-accent CSS var on the card.
  const backendBrand = backendId ? getCoderBackendBrand(backendId) : null;
  const accent =
    source === "coder" && backendBrand
      ? backendBrand.accent
      : source === "native"
      ? "#fbbf24"
      : "#9ca3af";

  // For the live state pulse: green for running, accent for completed/etc.
  // (matches the prior behavior where the running dot was always green so it
  // reads as "live" regardless of which provider spawned the run.)
  const liveColor = "#22c55e";
  const ringColor =
    substate === "error" ? "#ef4444"
    : stateGroup === "completed" ? accent
    : liveColor;

  const label = sessionLabel(session);
  const goal = sessionGoal(session);
  const checkpoint = sessionCheckpoint(session);
  const dur = sessionDuration(session);

  const backendIconEl =
    (backendId && getCoderBackendIcon(backendId)) || genericAgentIcon;
  const backendLabel = backendId
    ? getCoderBackendIconLabel(backendId)
    : session.kind === "other" ? "EXTERNAL" : "AGENT";
  const backendShort = backendBrand?.shortLabel
    ?? (session.kind === "other" ? "EXT" : "AGENT");

  // Card clickable iff the modal has something to look up.
  const clickable = Boolean(onCardClick) && Boolean(session.key);

  // CSS vars drive the per-card accent without inline color mixing in templates.
  const cardStyle = [
    `--card-accent:${accent};`,
    `--card-accent-soft:${accent}22;`,
    `--card-accent-mid:${accent}55;`,
    `--card-accent-line:${accent}38;`,
  ].join("");

  return html`
    <div
      class="iad-agent-card iad-source-${source} iad-state-${stateGroup}${clickable ? " iad-card-clickable" : ""}"
      data-substate="${substate}"
      data-backend="${backendId ?? ""}"
      style="${cardStyle}"
      role="${clickable ? "button" : nothing}"
      tabindex="${clickable ? "0" : nothing}"
      @click=${clickable ? (() => onCardClick!()) : nothing}
      @keydown=${clickable ? ((e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCardClick!();
        }
      }) : nothing}
    >
      <div class="iad-corner iad-tl"></div>
      <div class="iad-corner iad-br"></div>

      <!-- Header: backend icon + label + state pill -->
      <div class="iad-agent-header">
        <span
          class="iad-backend-icon"
          title="${backendLabel}"
          aria-label="${backendLabel}"
        >${backendIconEl}</span>
        <span class="iad-agent-label" title="${label}">${label}</span>
        ${filesTouchedCount ? html`
          <span class="iad-files-badge" title="${filesTouchedCount} files touched">
            ${icons.folder}<span>${filesTouchedCount}</span>
          </span>
        ` : nothing}
        ${renderFederationChip(session)}
        ${stateGroup === "spawned" ? html`
          <div class="iad-state-pill iad-state-pill-live">
            <span class="iad-status-dot"></span>
            <span>${prog.phase}</span>
          </div>
        ` : html`
          <div class="iad-state-pill iad-state-pill-${substate}">
            <span class="iad-pill-icon">${renderTerminalIcon(substate as "complete" | "error" | "timeout" | "cancelled")}</span>
            <span>${substateLabel(substate)}</span>
          </div>
        `}
      </div>

      <!-- Backend brand badge row -->
      <div class="iad-brand-row">
        <span class="iad-brand-badge">${backendShort}</span>
        ${source === "native" ? html`<span class="iad-source-tag">AUTONOMOUS</span>` : nothing}
        ${source === "external" ? html`<span class="iad-source-tag">PTY · EXTERNAL</span>` : nothing}
      </div>

      <!-- Goal text -->
      ${goal ? html`<div class="iad-agent-goal" title="${goal}">${goal}</div>` : nothing}

      <!-- Ring gauge + stats -->
      <div class="iad-agent-mid">
        <div class="iad-ring-wrap">
          ${ringProgressSVG(prog.pct, ringColor)}
          <span class="iad-ring-label" style="color:${ringColor};">${prog.pct}%</span>
        </div>
        <div class="iad-agent-stats">
          <div class="iad-stat">
            <span class="iad-stat-k">DURATION</span>
            <span class="iad-stat-v">${dur}</span>
          </div>
          <div class="iad-stat">
            <span class="iad-stat-k">STEPS</span>
            <span class="iad-stat-v">${session.steps.length}</span>
          </div>
          <div class="iad-stat">
            <span class="iad-stat-k">KIND</span>
            <span class="iad-stat-v">
              ${session.kind === "subagent" ? "SUB" : session.kind === "other" ? "EXT" : "MAIN"}
            </span>
          </div>
          ${linkedProject ? html`
            <div class="iad-stat">
              <span class="iad-stat-k">PROJECT</span>
              <span class="iad-stat-v iad-project-chip" title="${linkedProject.name}">${linkedProject.name}</span>
            </div>
          ` : nothing}
        </div>
      </div>

      <!-- Checkpoint -->
      ${checkpoint ? html`<div class="iad-checkpoint" title="${checkpoint}">${checkpoint}</div>` : nothing}

      <!-- Footer -->
      <div class="iad-agent-footer">
        ${linkedProject && onViewKanban ? html`
          <button
            class="iad-kanban-btn"
            @click=${(e: Event) => { e.stopPropagation(); onViewKanban(linkedProject.id); }}
          >View kanban task →</button>
        ` : html`<span></span>`}
        ${session.model ? html`
          <span class="iad-model-chip">${session.model.split("-").slice(-1)[0]}</span>
        ` : nothing}
      </div>

      ${stateGroup === "spawned" ? html`
        <div class="iad-progress-bar" aria-hidden="true">
          <div class="iad-progress-fill" style="width:${prog.pct}%;"></div>
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Section C right — Pending queue ─────────────────────────────────────────

function renderPendingQueue(
  tasks: KanbanTask[],
  projects: KanbanProject[],
  activeSessions: AgentSession[],
): TemplateResult {
  const projMap = new Map(projects.map(p => [p.id, p]));
  const activeAgentIds = new Set(activeSessions.map(s => s.agentId).filter(Boolean));

  const pending = tasks
    .filter(t =>
      (t.status === "todo" || t.status === "in_progress") &&
      !activeAgentIds.has(t.assignedAgent ?? ""),
    )
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .slice(0, 14);

  return html`
    <div class="iad-oversight-card" data-learn-id="activity-pending">
      <div class="iad-corner iad-tl"></div>
      <div class="iad-corner iad-br"></div>
      <div class="iad-card-hdr">
        <span class="iad-card-title">Pending Queue</span>
        <span class="iad-card-count">${pending.length}</span>
      </div>
      <div class="iad-oversight-body iad-fade-edges">
        ${pending.length === 0 ? html`
          <div class="iad-empty">Queue clear — all tasks assigned or done.</div>
        ` : pending.map(t => {
          const proj = projMap.get(t.projectId);
          const statusColor = t.status === "in_progress" ? "#f59e0b" : "var(--g-fg-faint,rgba(245,245,244,0.45))";
          return html`
            <div class="iad-pq-row">
              <div class="iad-pq-left">
                <div class="iad-pq-title" title="${t.title}">${t.title}</div>
                <div class="iad-pq-meta">
                  ${proj ? html`<span class="iad-pq-proj" title="${proj.name}">${proj.name}</span>` : nothing}
                  <span class="iad-pq-age">${t.createdAt ? timeAgo(t.createdAt) : "—"}</span>
                  <span class="iad-pq-status" style="color:${statusColor};">${t.status.replace("_", " ")}</span>
                </div>
              </div>
              <!-- TODO: wire to existing spawn flow once spawn-flow integration is ready -->
              <button class="iad-spawn-btn" title="Spawn agent on this task (spawn-flow integration pending)">⊕</button>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}


// ── Notification strip (top area, last 5 agent completions) ──────────────────

function notifSeverityColor(severity: string): string {
  if (severity === "error" || severity === "critical") return "#ef4444";
  if (severity === "warn" || severity === "warning") return "#f59e0b";
  if (severity === "success") return "#22c55e";
  return "var(--g-primary,#fbbf24)";
}

function renderNotificationStrip(
  items: NotifStripItem[],
  onDeepLink?: (link: string) => void,
): TemplateResult | typeof nothing {
  if (items.length === 0) return nothing;

  return html`
    <div class="iad-notif-strip">
      ${items.map(item => {
        const color = notifSeverityColor(item.severity);
        const clickable = !!item.deepLink;
        return html`
          <div
            class="iad-notif-pill${clickable ? " iad-notif-pill--link" : ""}"
            style="--pill-accent:${color};"
            title="${item.title}: ${item.body}"
            @click=${clickable ? () => onDeepLink?.(item.deepLink!) : nothing}
          >
            <span class="iad-notif-pill-title">${item.title}</span>
            ${item.body ? html`<span class="iad-notif-pill-body">${item.body}</span>` : nothing}
            <span class="iad-notif-pill-age">${timeAgo(item.ts)}</span>
          </div>
        `;
      })}
    </div>
  `;
}

// ── Styles ───────────────────────────────────────────────────────────────────

function dashStyles(): TemplateResult {
  return html`
    <style>
      /* ── Root ─────────────────────────────────────────────────── */
      .iad-root {
        display: flex;
        flex-direction: column;
        gap: 20px;
        padding: 0 0 24px;
        font-family: var(--g-mono-family, 'JetBrains Mono','SF Mono',monospace);
      }

      /* ── Corner bracket decoration ───────────────────────────── */
      .iad-corner {
        position: absolute;
        width: 10px; height: 10px;
        pointer-events: none;
        z-index: 2;
      }
      .iad-tl {
        top: 7px; left: 7px;
        border-top: 1.5px solid var(--g-primary, #fbbf24);
        border-left: 1.5px solid var(--g-primary, #fbbf24);
        border-radius: 2px 0 0 0;
        opacity: 0.8;
      }
      .iad-br {
        bottom: 7px; right: 7px;
        border-bottom: 1.5px solid var(--g-primary, #fbbf24);
        border-right: 1.5px solid var(--g-primary, #fbbf24);
        border-radius: 0 0 2px 0;
        opacity: 0.8;
      }
      .iad-warn .iad-tl, .iad-warn .iad-br { border-color: #f59e0b; }
      .iad-danger .iad-tl, .iad-danger .iad-br { border-color: #ef4444; }

      /* ── Section header row ──────────────────────────────────── */
      .iad-section-hdr {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.15));
      }
      .iad-section-dot {
        width: 7px; height: 7px;
        border-radius: 50%;
        background: var(--g-fg-faint, rgba(245,245,244,0.45));
        flex-shrink: 0;
      }
      .iad-section-dot.live {
        background: #22c55e;
        box-shadow: 0 0 8px rgba(34,197,94,0.6);
        animation: iad-pulse 2s infinite;
      }
      .iad-section-title {
        font-size: 10px;
        font-weight: 700;
        color: var(--g-primary, #fbbf24);
        letter-spacing: 0.15em;
        text-transform: uppercase;
        text-shadow: 0 0 12px rgba(251,191,36,0.35);
      }
      .iad-section-badge {
        font-size: 9px;
        padding: 2px 8px;
        border: 1px solid var(--g-border, rgba(255,255,255,0.18));
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        letter-spacing: 0.08em;
        border-radius: 3px;
      }

      /* ── Notification strip ──────────────────────────────────── */
      .iad-notif-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 2px 0;
      }
      .iad-notif-pill {
        display: flex;
        align-items: baseline;
        gap: 6px;
        padding: 5px 10px;
        border-radius: 20px;
        border: 1px solid color-mix(in srgb, var(--pill-accent) 40%, transparent);
        background: color-mix(in srgb, var(--pill-accent) 8%, transparent);
        font-size: 10px;
        letter-spacing: 0.04em;
        transition: background 150ms;
        max-width: 320px;
        overflow: hidden;
      }
      .iad-notif-pill--link {
        cursor: pointer;
      }
      .iad-notif-pill--link:hover {
        background: color-mix(in srgb, var(--pill-accent) 16%, transparent);
      }
      .iad-notif-pill-title {
        color: var(--pill-accent);
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex-shrink: 0;
        max-width: 140px;
      }
      .iad-notif-pill-body {
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
      }
      .iad-notif-pill-age {
        color: var(--g-fg-faint, rgba(245,245,244,0.40));
        white-space: nowrap;
        flex-shrink: 0;
      }

      /* ── Section A: Hero row ─────────────────────────────────── */
      .iad-hero-row {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 16px;
      }
      @media (max-width: 900px)  { .iad-hero-row { grid-template-columns: repeat(2, 1fr); } }
      @media (max-width: 520px)  { .iad-hero-row { grid-template-columns: 1fr; } }

      .iad-hero-tile {
        background:
          linear-gradient(155deg,
            rgba(255,255,255,0.10) 0%,
            rgba(255,255,255,0.04) 45%,
            rgba(0,0,0,0.22) 100%);
        backdrop-filter: blur(22px) saturate(180%);
        -webkit-backdrop-filter: blur(22px) saturate(180%);
        border: 1px solid var(--g-border, rgba(255,255,255,0.16));
        border-radius: 14px;
        box-shadow:
          0 6px 24px rgba(0,0,0,0.40),
          0 1px 3px rgba(0,0,0,0.30),
          inset 0 1px 0 rgba(255,255,255,0.12),
          inset 0 -1px 0 rgba(0,0,0,0.28);
        position: relative;
        padding: 20px 20px 14px;
        min-height: 180px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition: box-shadow 200ms ease, transform 200ms ease, border-color 200ms ease;
      }
      .iad-hero-tile:hover {
        box-shadow:
          0 10px 36px rgba(0,0,0,0.50),
          0 2px 6px rgba(0,0,0,0.35),
          0 0 28px var(--g-primary-soft, rgba(251,191,36,0.10)),
          inset 0 1px 0 rgba(255,255,255,0.16),
          inset 0 -1px 0 rgba(0,0,0,0.30);
        border-color: var(--g-border-strong, rgba(255,255,255,0.28));
        transform: translateY(-2px);
      }
      .iad-hero-tile.iad-warn {
        border-color: rgba(245,158,11,0.35);
        box-shadow:
          0 6px 24px rgba(0,0,0,0.40),
          0 0 0 1px rgba(245,158,11,0.18),
          inset 0 1px 0 rgba(255,255,255,0.10);
      }
      .iad-hero-tile.iad-danger {
        border-color: rgba(239,68,68,0.40);
        animation: iad-danger-pulse 1.8s ease-in-out infinite;
      }
      @keyframes iad-danger-pulse {
        0%, 100% { box-shadow: 0 6px 24px rgba(0,0,0,0.40), 0 0 0 1px rgba(239,68,68,0.18), inset 0 1px 0 rgba(255,255,255,0.10); }
        50%       { box-shadow: 0 6px 24px rgba(0,0,0,0.40), 0 0 28px rgba(239,68,68,0.28), inset 0 1px 0 rgba(255,255,255,0.10); }
      }

      .iad-hero-label {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        margin-bottom: 8px;
        flex-shrink: 0;
      }
      .iad-hero-num {
        font-size: 52px;
        font-weight: 800;
        line-height: 1;
        letter-spacing: -0.02em;
        color: var(--g-primary, #fbbf24);
        flex: 1;
        display: flex;
        align-items: flex-start;
        gap: 10px;
        flex-wrap: wrap;
        min-width: 0;
        word-break: break-all;
      }
      .iad-hero-sub {
        font-size: 12px;
        font-weight: 500;
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        align-self: flex-end;
        padding-bottom: 7px;
        letter-spacing: 0;
        white-space: nowrap;
      }
      .iad-hero-trend {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        margin-top: 4px;
        flex-shrink: 0;
      }
      .iad-sparkline {
        margin-top: auto;
        padding-top: 8px;
        opacity: 0.65;
      }

      /* ── Section B: Running agents grid ──────────────────────── */
      .iad-agents-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 16px;
      }
      @media (max-width: 900px) { .iad-agents-grid { grid-template-columns: 1fr; } }

      /*
       * Depth-glass card — mirrors the technique used by
       * components/subagent-activity-panel.ts (the gold-standard panel for
       * sub-agent cards). Low-alpha surface, heavy backdrop blur, inset
       * highlight + drop shadow, ::before top-edge highlight, hover lift.
       *
       * Per-card accent comes through the --card-accent CSS var set inline by
       * renderRunningAgentCard (brand-kit hex for coder runs, gold for
       * native autonomous, neutral grey for external/PTY).
       */
      .iad-agent-card {
        --card-accent: rgba(255,255,255,0.18);
        --card-accent-soft: rgba(255,255,255,0.10);
        --card-accent-mid: rgba(255,255,255,0.30);
        --card-accent-line: rgba(255,255,255,0.22);

        position: relative;
        isolation: isolate;
        overflow: hidden;
        padding: 14px 16px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        border-radius: 14px;

        background: color-mix(in oklab, var(--g-surface, #0c1018) 18%, transparent);
        backdrop-filter: blur(24px) saturate(140%);
        -webkit-backdrop-filter: blur(24px) saturate(140%);

        box-shadow:
          inset 0 0 0 1px color-mix(in oklab, white 8%, transparent),
          0 8px 32px color-mix(in oklab, black 35%, transparent);

        transition:
          transform 220ms cubic-bezier(0.23, 1, 0.32, 1),
          box-shadow 220ms ease,
          opacity 220ms ease;
      }

      /* Top-edge highlight — the signature "glass lip" of the depth-glass kit. */
      .iad-agent-card::before {
        content: "";
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 1px;
        background: linear-gradient(
          to right,
          transparent 0%,
          rgba(255,255,255,0.12) 50%,
          transparent 100%
        );
        pointer-events: none;
        z-index: 2;
      }

      .iad-card-clickable { cursor: pointer; }
      .iad-card-clickable:focus-visible {
        outline: none;
        box-shadow:
          inset 0 0 0 1px var(--card-accent-mid),
          0 0 0 2px color-mix(in oklab, var(--card-accent) 60%, transparent),
          0 8px 32px color-mix(in oklab, black 35%, transparent);
      }
      .iad-agent-card:hover {
        transform: translateY(-2px);
        box-shadow:
          inset 0 0 0 1px color-mix(in oklab, white 10%, transparent),
          0 12px 40px color-mix(in oklab, black 40%, transparent),
          0 0 28px color-mix(in oklab, var(--card-accent) 18%, transparent);
      }

      /* Spawned (active) state: replace the white inset with brand accent. */
      .iad-agent-card.iad-state-spawned {
        box-shadow:
          inset 0 0 0 1px var(--card-accent-line),
          0 8px 32px color-mix(in oklab, black 35%, transparent),
          0 0 18px color-mix(in oklab, var(--card-accent) 10%, transparent);
      }
      .iad-agent-card.iad-state-spawned:hover {
        box-shadow:
          inset 0 0 0 1px var(--card-accent-mid),
          0 12px 40px color-mix(in oklab, black 40%, transparent),
          0 0 32px color-mix(in oklab, var(--card-accent) 22%, transparent);
      }

      /* Completed group: muted overall. The static state pill carries
       * the substate color (success/danger/warn/faint) — see below. */
      .iad-agent-card.iad-state-completed {
        opacity: 0.88;
      }
      .iad-agent-card.iad-state-completed:hover {
        opacity: 1;
      }

      /* External / PTY: neutral, no accent glow even when "spawned" (kind=other). */
      .iad-agent-card.iad-source-external.iad-state-spawned {
        box-shadow:
          inset 0 0 0 1px rgba(255,255,255,0.10),
          0 8px 32px color-mix(in oklab, black 35%, transparent);
      }

      @media (prefers-reduced-motion: reduce) {
        .iad-agent-card { transition: none; }
        .iad-agent-card:hover { transform: none; }
      }

      .iad-agent-header {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        position: relative;
        z-index: 1;
      }
      .iad-backend-icon {
        flex-shrink: 0;
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--card-accent);
        filter: drop-shadow(0 0 6px color-mix(in oklab, var(--card-accent) 35%, transparent));
      }
      .iad-backend-icon svg { width: 16px; height: 16px; display: block; }
      .iad-agent-label {
        font-size: 11px;
        font-weight: 700;
        color: var(--g-fg, rgba(245,245,244,0.95));
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        letter-spacing: 0.02em;
      }

      /* ── State pills (header right) ──────────────────────────── */
      .iad-state-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 8px;
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.1em;
        flex-shrink: 0;
        border-radius: 3px;
        border: 1px solid transparent;
      }
      .iad-state-pill-live {
        color: #22c55e;
        border-color: rgba(34,197,94,0.35);
        background: rgba(34,197,94,0.10);
      }
      .iad-state-pill-complete {
        color: var(--g-state-success-fg, #4ade80);
        border-color: color-mix(in oklab, var(--g-state-success, #22c55e) 35%, transparent);
        background: color-mix(in oklab, var(--g-state-success, #22c55e) 14%, transparent);
      }
      .iad-state-pill-error {
        color: var(--g-state-danger-fg, #f87171);
        border-color: color-mix(in oklab, var(--g-state-danger, #ef4444) 40%, transparent);
        background: color-mix(in oklab, var(--g-state-danger, #ef4444) 14%, transparent);
      }
      .iad-state-pill-timeout {
        color: var(--g-state-warn-fg, #fbbf24);
        border-color: color-mix(in oklab, var(--g-state-warn, #f59e0b) 38%, transparent);
        background: color-mix(in oklab, var(--g-state-warn, #f59e0b) 14%, transparent);
      }
      .iad-state-pill-cancelled {
        color: var(--g-fg-faint, rgba(245,245,244,0.55));
        border-color: rgba(255,255,255,0.16);
        background: rgba(255,255,255,0.04);
      }
      .iad-pill-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .iad-pill-icon svg {
        width: 10px;
        height: 10px;
        display: block;
      }
      .iad-status-dot {
        width: 5px; height: 5px;
        border-radius: 50%;
        flex-shrink: 0;
        background: currentColor;
        box-shadow: 0 0 6px currentColor;
        animation: iad-pulse 2s infinite;
      }

      /* ── Backend brand row (below header) ─────────────────────── */
      .iad-brand-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
        position: relative;
        z-index: 1;
        margin-top: -4px;
      }
      .iad-brand-badge {
        display: inline-flex;
        align-items: center;
        font-size: 8px;
        font-weight: 800;
        letter-spacing: 0.14em;
        padding: 2px 7px;
        border-radius: 3px;
        color: var(--card-accent);
        background: color-mix(in oklab, var(--card-accent) 14%, transparent);
        border: 1px solid color-mix(in oklab, var(--card-accent) 35%, transparent);
        text-transform: uppercase;
        line-height: 1.2;
      }
      .iad-source-tag {
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: var(--g-fg-faint, rgba(245,245,244,0.45));
        text-transform: uppercase;
      }
      .iad-agent-goal {
        font-size: 10px;
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        line-height: 1.45;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .iad-agent-mid {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-shrink: 0;
      }
      .iad-ring-wrap {
        position: relative;
        flex-shrink: 0;
        width: 60px; height: 60px;
      }
      .iad-ring-label {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0;
      }
      .iad-agent-stats {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
        min-width: 0;
      }
      .iad-stat {
        display: flex;
        gap: 6px;
        align-items: baseline;
        font-size: 9px;
      }
      .iad-stat-k {
        color: var(--g-fg-faint, rgba(245,245,244,0.45));
        letter-spacing: 0.08em;
        flex-shrink: 0;
        min-width: 52px;
      }
      .iad-stat-v {
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .iad-project-chip {
        color: var(--g-primary, #fbbf24) !important;
        font-weight: 600;
      }
      .iad-checkpoint {
        font-size: 9px;
        color: var(--g-fg-faint, rgba(245,245,244,0.50));
        background: rgba(255,255,255,0.05);
        border: 1px solid var(--g-border, rgba(255,255,255,0.12));
        border-radius: 4px;
        padding: 5px 8px;
        line-height: 1.4;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 0;
        font-family: inherit;
      }
      .iad-agent-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-shrink: 0;
      }
      .iad-kanban-btn {
        background: none;
        border: none;
        color: var(--g-primary, #fbbf24);
        font-size: 9px;
        font-family: inherit;
        cursor: pointer;
        padding: 0;
        letter-spacing: 0.05em;
        opacity: 0.75;
        transition: opacity 0.12s;
      }
      .iad-kanban-btn:hover { opacity: 1; }
      .iad-model-chip {
        font-size: 8px;
        color: var(--g-fg-faint, rgba(245,245,244,0.45));
        letter-spacing: 0.04em;
      }

      /* ── Files-touched badge (header) ─────────────────────────── */
      .iad-files-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 8px;
        padding: 2px 6px;
        border: 1px solid rgba(251,191,36,0.35);
        color: var(--g-primary, #fbbf24);
        border-radius: 3px;
        letter-spacing: 0.04em;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .iad-files-badge svg { width: 9px; height: 9px; display: block; }

      /* ── Progress strip (bottom of spawned cards) ─────────────── */
      .iad-progress-bar {
        position: absolute;
        left: 0; right: 0; bottom: 0;
        height: 2px;
        background: color-mix(in oklab, var(--card-accent) 10%, transparent);
        overflow: hidden;
        pointer-events: none;
        z-index: 1;
      }
      .iad-progress-fill {
        height: 100%;
        background: linear-gradient(
          to right,
          color-mix(in oklab, var(--card-accent) 60%, transparent),
          var(--card-accent)
        );
        box-shadow: 0 0 8px color-mix(in oklab, var(--card-accent) 60%, transparent);
        transition: width 600ms cubic-bezier(0.22, 1, 0.36, 1);
      }

      /* ── Federation node chip ─────────────────────────────────── */
      .iad-fed-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 5px;
        border-radius: 20px;
        border: 1px solid rgba(34, 211, 238, 0.22);
        background: rgba(34, 211, 238, 0.08);
        color: #22d3ee;
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.05em;
        flex-shrink: 0;
        max-width: 110px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        cursor: default;
      }
      .iad-fed-chip svg { flex-shrink: 0; }
      .iad-fed-ring {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        border: 1.5px solid currentColor;
        flex-shrink: 0;
        display: inline-block;
      }

      /* Corner brackets pick up the per-card accent on spawned cards
       * so a coder-branded card carries the brand color all the way
       * through the HUD chrome instead of staying gold. */
      .iad-agent-card.iad-state-spawned .iad-tl,
      .iad-agent-card.iad-state-spawned .iad-br {
        border-color: var(--card-accent);
        opacity: 0.85;
      }
      .iad-agent-card.iad-state-completed .iad-tl,
      .iad-agent-card.iad-state-completed .iad-br {
        opacity: 0.4;
      }

      /* ── Autonomous goal groups (Section B sub-section) ──────── */
      .iad-goal-section {
        border: 1px solid rgba(6,182,212,0.28);
        border-left: 3px solid #06b6d4;
        border-radius: 12px;
        background:
          linear-gradient(135deg,
            rgba(6,182,212,0.06) 0%,
            rgba(6,182,212,0.02) 40%,
            transparent 100%);
        padding: 12px 14px 14px;
      }
      .iad-goal-section-hdr {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(6,182,212,0.18);
      }
      .iad-goal-section-title {
        font-size: 10px;
        font-weight: 700;
        color: #06b6d4;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        text-shadow: 0 0 12px rgba(6,182,212,0.35);
      }
      .iad-goal-section-badge {
        font-size: 9px;
        padding: 2px 8px;
        border: 1px solid rgba(6,182,212,0.45);
        color: #06b6d4;
        letter-spacing: 0.08em;
        border-radius: 3px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .iad-goal-cluster {
        margin-top: 14px;
      }
      .iad-goal-cluster:first-of-type {
        margin-top: 12px;
      }
      .iad-goal-cluster + .iad-goal-cluster {
        margin-top: 18px;
        padding-top: 14px;
        border-top: 1px dashed rgba(6,182,212,0.18);
      }
      .iad-goal-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      .iad-goal-icon {
        font-size: 13px;
        flex-shrink: 0;
        filter: drop-shadow(0 0 4px rgba(6,182,212,0.55));
      }
      .iad-goal-title-text {
        font-size: 12px;
        font-weight: 700;
        color: var(--g-fg, #e4e4e7);
        letter-spacing: 0.01em;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .iad-goal-phase-chip {
        font-size: 8px;
        padding: 2px 7px;
        border-radius: 3px;
        background: rgba(6,182,212,0.15);
        color: #06b6d4;
        border: 1px solid rgba(6,182,212,0.4);
        letter-spacing: 0.08em;
        font-weight: 700;
        flex-shrink: 0;
      }
      .iad-goal-turns-chip {
        font-size: 9px;
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
        letter-spacing: 0.06em;
        flex-shrink: 0;
      }
      .iad-goal-count-chip {
        font-size: 8px;
        padding: 1px 6px;
        border: 1px solid rgba(6,182,212,0.35);
        color: #06b6d4;
        letter-spacing: 0.08em;
        border-radius: 3px;
        flex-shrink: 0;
      }

      /* ── Subagent detail modal ───────────────────────────────── */
      .iad-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0,0,0,0.72);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .iad-modal-box {
        background:
          linear-gradient(145deg,
            rgba(255,255,255,0.12) 0%,
            rgba(255,255,255,0.05) 40%,
            rgba(0,0,0,0.30) 100%);
        backdrop-filter: blur(28px) saturate(200%);
        -webkit-backdrop-filter: blur(28px) saturate(200%);
        border: 1px solid var(--g-border, rgba(255,255,255,0.18));
        border-radius: 16px;
        box-shadow:
          0 24px 64px rgba(0,0,0,0.60),
          0 2px 8px rgba(0,0,0,0.40),
          inset 0 1px 0 rgba(255,255,255,0.14);
        width: 100%;
        max-width: 720px;
        max-height: 85vh;
        overflow-y: auto;
        padding: 24px;
        font-family: var(--g-mono-family, 'JetBrains Mono','SF Mono',monospace);
        color: var(--g-fg, rgba(245,245,244,0.92));
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .iad-modal-header {
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      .iad-modal-header-left { flex: 1; min-width: 0; }
      .iad-modal-title {
        font-size: 13px;
        font-weight: 700;
        color: var(--g-fg, rgba(245,245,244,0.92));
        word-break: break-word;
        margin-bottom: 6px;
      }
      .iad-modal-meta-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .iad-modal-runid {
        font-size: 9px;
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
        background: rgba(255,255,255,0.06);
        padding: 2px 6px;
        border-radius: 3px;
        letter-spacing: 0.03em;
      }
      .iad-modal-age {
        font-size: 9px;
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
      }
      .iad-modal-outcome {
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.12em;
        padding: 2px 8px;
        border: 1px solid;
        border-radius: 3px;
      }
      .iad-modal-x {
        background: none;
        border: 1px solid var(--g-border, rgba(255,255,255,0.18));
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
        width: 28px; height: 28px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        border-radius: 6px;
        font-size: 11px;
        flex-shrink: 0;
        transition: border-color 0.12s, color 0.12s;
      }
      .iad-modal-x:hover {
        border-color: #ef4444;
        color: #ef4444;
      }
      .iad-modal-section-label {
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        color: var(--g-primary, #fbbf24);
        display: flex;
        align-items: center;
        gap: 8px;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.10));
        padding-bottom: 6px;
      }
      .iad-modal-action-badge {
        font-size: 8px;
        font-weight: 600;
        letter-spacing: 0.06em;
      }
      .iad-modal-task-block {
        background: rgba(0,0,0,0.28);
        border: 1px solid var(--g-border, rgba(255,255,255,0.10));
        border-radius: 8px;
        padding: 12px 14px;
        font-size: 10px;
        line-height: 1.6;
        max-height: 200px;
        overflow-y: auto;
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--g-fg, rgba(245,245,244,0.88));
      }
      .iad-modal-kanban-row {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .iad-modal-nav-btn {
        display: flex;
        align-items: center;
        gap: 10px;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--g-border, rgba(255,255,255,0.14));
        border-radius: 8px;
        padding: 10px 14px;
        cursor: pointer;
        color: var(--g-fg, rgba(245,245,244,0.88));
        font-family: inherit;
        text-align: left;
        transition: border-color 0.12s, background 0.12s;
        width: 100%;
      }
      .iad-modal-nav-btn:hover {
        border-color: var(--g-primary, #fbbf24);
        background: rgba(255,255,255,0.07);
      }
      .iad-modal-nav-icon { font-size: 14px; flex-shrink: 0; }
      .iad-modal-nav-label {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .iad-modal-nav-kind {
        font-size: 7px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
      }
      .iad-modal-nav-name {
        font-size: 11px;
        font-weight: 600;
        color: var(--g-fg, rgba(245,245,244,0.92));
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .iad-modal-nav-status {
        font-size: 8px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .iad-modal-nav-chev {
        font-size: 16px;
        color: var(--g-fg-dim, rgba(245,245,244,0.45));
        flex-shrink: 0;
      }
      .iad-modal-no-kanban {
        font-size: 9px;
        color: var(--g-fg-dim, rgba(245,245,244,0.45));
        font-style: italic;
      }
      .iad-modal-files-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 340px;
        overflow-y: auto;
        border: 1px solid var(--g-border, rgba(255,255,255,0.09));
        border-radius: 8px;
        overflow: hidden;
      }
      .iad-modal-file-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.07));
        font-size: 10px;
        transition: background 0.08s;
      }
      .iad-modal-file-row:last-child { border-bottom: none; }
      .iad-modal-file-row:hover { background: rgba(255,255,255,0.05); }
      .iad-modal-file-action {
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.06em;
        flex-shrink: 0;
        width: 10px;
        text-align: center;
      }
      .iad-modal-file-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .iad-modal-file-dir {
        color: var(--g-fg-dim, rgba(245,245,244,0.50));
      }
      .iad-modal-file-btns {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
      .iad-modal-file-btn {
        background: none;
        border: 1px solid var(--g-border, rgba(255,255,255,0.14));
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
        width: 22px; height: 22px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        border-radius: 4px;
        font-size: 10px;
        text-decoration: none;
        transition: border-color 0.10s, color 0.10s;
      }
      .iad-modal-file-btn:hover {
        border-color: var(--g-primary, #fbbf24);
        color: var(--g-primary, #fbbf24);
      }
      .iad-modal-show-all {
        background: none;
        border: 1px solid var(--g-border, rgba(255,255,255,0.16));
        color: var(--g-primary, #fbbf24);
        font-family: inherit;
        font-size: 9px;
        letter-spacing: 0.08em;
        padding: 6px 16px;
        border-radius: 6px;
        cursor: pointer;
        align-self: flex-start;
        transition: border-color 0.12s;
      }
      .iad-modal-show-all:hover { border-color: var(--g-primary, #fbbf24); }
      .iad-modal-no-files {
        font-size: 9px;
        color: var(--g-fg-dim, rgba(245,245,244,0.45));
        font-style: italic;
      }
      .iad-modal-footer {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-top: 8px;
        border-top: 1px solid var(--g-border, rgba(255,255,255,0.09));
        font-size: 8px;
        color: var(--g-fg-dim, rgba(245,245,244,0.50));
        word-break: break-all;
      }
      .iad-meta-k {
        font-weight: 700;
        letter-spacing: 0.10em;
        color: var(--g-fg-dim, rgba(245,245,244,0.40));
        margin-right: 4px;
      }
      .iad-modal-loading, .iad-modal-err {
        padding: 24px;
        text-align: center;
        font-size: 10px;
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
      }
      .iad-modal-close-btn {
        display: block;
        margin: 8px auto 0;
        background: none;
        border: 1px solid var(--g-border, rgba(255,255,255,0.18));
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        font-family: inherit;
        font-size: 9px;
        padding: 6px 16px;
        border-radius: 6px;
        cursor: pointer;
        letter-spacing: 0.08em;
      }

      /* ── Empty state ─────────────────────────────────────────── */
      .iad-empty-state {
        padding: 32px 16px;
        text-align: center;
        background: rgba(255,255,255,0.02);
        border: 1px dashed var(--g-border, rgba(255,255,255,0.12));
        border-radius: 12px;
        margin-top: 12px;
      }

      /* ── Section C: Oversight side-by-side ───────────────────── */
      .iad-oversight-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        align-items: start;
      }
      @media (max-width: 900px) { .iad-oversight-row { grid-template-columns: 1fr; } }

      .iad-oversight-card {
        background:
          linear-gradient(155deg,
            rgba(255,255,255,0.10) 0%,
            rgba(255,255,255,0.04) 45%,
            rgba(0,0,0,0.22) 100%);
        backdrop-filter: blur(22px) saturate(180%);
        -webkit-backdrop-filter: blur(22px) saturate(180%);
        border: 1px solid var(--g-border, rgba(255,255,255,0.16));
        border-radius: 14px;
        box-shadow:
          0 6px 24px rgba(0,0,0,0.40),
          inset 0 1px 0 rgba(255,255,255,0.12),
          inset 0 -1px 0 rgba(0,0,0,0.28);
        position: relative;
        overflow: hidden;
        transition: box-shadow 200ms ease, transform 200ms ease, border-color 200ms ease;
      }
      .iad-oversight-card:hover {
        box-shadow:
          0 10px 36px rgba(0,0,0,0.50),
          inset 0 1px 0 rgba(255,255,255,0.16);
        border-color: var(--g-border-strong, rgba(255,255,255,0.28));
        transform: translateY(-1px);
      }
      .iad-card-hdr {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.14));
        background: rgba(255,255,255,0.03);
        flex-shrink: 0;
      }
      .iad-card-title {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.14em;
        color: var(--g-primary, #fbbf24);
        text-transform: uppercase;
        flex: 1;
      }
      .iad-card-count {
        font-size: 8px;
        padding: 2px 8px;
        border: 1px solid var(--g-border, rgba(255,255,255,0.18));
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        letter-spacing: 0.08em;
        border-radius: 3px;
      }
      .iad-oversight-body {
        max-height: 320px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.08) transparent;
      }
      /* Soft fade at top/bottom edges to hint scrollability */
      .iad-fade-edges {
        -webkit-mask-image:
          linear-gradient(to bottom,
            transparent 0%,
            black 14px,
            black calc(100% - 14px),
            transparent 100%);
        mask-image:
          linear-gradient(to bottom,
            transparent 0%,
            black 14px,
            black calc(100% - 14px),
            transparent 100%);
      }
      .iad-empty {
        padding: 22px 16px;
        font-size: 10px;
        color: var(--g-fg-faint, rgba(245,245,244,0.50));
        text-align: center;
        font-style: italic;
        letter-spacing: 0.02em;
      }

      /* Tuck the rcf widget cleanly inside the oversight card */
      .iad-oversight-body .rcf-root {
        border: none !important;
        border-radius: 0 !important;
        background: transparent !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        border-left: none !important;
        border-image: none !important;
        box-shadow: none !important;
      }
      .iad-oversight-body .rcf-header {
        border-top: none;
        padding-top: 12px;
      }

      /* ── Pending queue rows ───────────────────────────────────── */
      .iad-pq-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 9px 16px;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.09));
        transition: background 0.1s;
      }
      .iad-pq-row:last-child { border-bottom: none; }
      .iad-pq-row:hover { background: rgba(255,255,255,0.05); }
      .iad-pq-left { flex: 1; min-width: 0; }
      .iad-pq-title {
        font-size: 10px;
        font-weight: 600;
        color: var(--g-fg, rgba(245,245,244,0.92));
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-bottom: 3px;
      }
      .iad-pq-meta {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 8px;
        flex-wrap: wrap;
      }
      .iad-pq-proj {
        color: #a855f7;
        font-weight: 600;
        max-width: 90px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .iad-pq-age  { color: var(--g-fg-faint, rgba(245,245,244,0.45)); }
      .iad-pq-status { font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
      .iad-spawn-btn {
        background: none;
        border: 1px solid var(--g-border, rgba(255,255,255,0.16));
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        width: 24px; height: 24px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        font-size: 12px;
        border-radius: 4px;
        flex-shrink: 0;
        transition: border-color 0.12s, color 0.12s;
      }
      .iad-spawn-btn:hover {
        border-color: var(--g-primary, #fbbf24);
        color: var(--g-primary, #fbbf24);
      }

      /* ── Animations ───────────────────────────────────────────── */
      @keyframes iad-pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.45; }
      }

      @media (prefers-reduced-motion: reduce) {
        .iad-hero-tile,
        .iad-agent-card,
        .iad-oversight-card { transition: none; }
        .iad-hero-tile:hover,
        .iad-agent-card:hover,
        .iad-oversight-card:hover { transform: none; }
        @keyframes iad-pulse       { from {} to {} }
        @keyframes iad-danger-pulse { from {} to {} }
      }
    </style>
  `;
}

// ── Goal Spotlight ───────────────────────────────────────────────────────────
// COORDINATION: running-goal-views — top-of-dashboard goal spotlight when ≥1 running

function renderGoalSpotlight(state: AppViewState): TemplateResult {
  const goals = (state.autonomyState as any)?.activeGoals as Array<{
    taskId: string;
    goalText: string;
    status: string;
    currentPhase?: string;
    turnsUsed: number;
    maxTurns: number;
    startedAt?: number;
    lastVerdict?: { done: boolean; rationale: string };
  }> | undefined;
  const running = goals?.filter(g => g.status === 'running') ?? [];
  if (running.length === 0) return html``;

  return html`
    <div style="margin-bottom:16px">
      <div style="
        display:flex; align-items:center; gap:8px; margin-bottom:8px;
        font-size:10px; font-weight:700; letter-spacing:.1em; color:#06b6d4;
      ">
        🎯 GOAL SPOTLIGHT
        <span style="
          background:#06b6d422; color:#06b6d4; padding:0 6px; border-radius:8px;
          font-size:9px; font-weight:700; border:1px solid #06b6d444;
          display:flex; align-items:center; gap:4px;
        ">
          ${running.length}
          <span style="width:5px;height:5px;border-radius:50%;background:#06b6d4;display:inline-block;animation:iad-pulse 1.2s infinite"></span>
        </span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">
        ${running.map(g => {
          const elapsed = g.startedAt ? (() => {
            const ms = Date.now() - g.startedAt!;
            const s = Math.floor(ms / 1000);
            if (s < 60) return `${s}s`;
            const m = Math.floor(s / 60);
            return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
          })() : '';
          const pct = g.maxTurns > 0 ? Math.min(100, (g.turnsUsed / g.maxTurns) * 100) : 0;
          const goalTrunc = g.goalText.length > 90 ? g.goalText.slice(0, 87) + '…' : g.goalText;
          const phase = g.currentPhase?.replace(/_/g, ' ').toUpperCase() ?? 'RUNNING';
          const verdict = g.lastVerdict?.rationale ?? '';
          const verdictTrunc = verdict.length > 80 ? verdict.slice(0, 77) + '…' : verdict;
          return html`
            <div style="
              background:linear-gradient(135deg,#06b6d410 0%,#0a0a0f 100%);
              border:1px solid #06b6d433; border-radius:10px; padding:12px;
              border-left:3px solid #06b6d4;
            ">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                <span style="
                  font-size:8px;background:#06b6d422;color:#06b6d4;
                  padding:1px 6px;border-radius:4px;letter-spacing:.06em;font-weight:700;
                ">${phase}</span>
                <span style="font-size:8px;color:#475569;margin-left:auto">
                  turn ${g.turnsUsed}/${g.maxTurns}${elapsed ? ` · ${elapsed}` : ''}
                </span>
                <span style="width:5px;height:5px;border-radius:50%;background:#06b6d4;animation:iad-pulse 1.2s infinite;flex-shrink:0"></span>
              </div>
              <div style="font-size:11px;color:#e2e8f0;font-weight:600;line-height:1.4;margin-bottom:5px">${goalTrunc}</div>
              <div style="height:2px;background:#1e293b;border-radius:2px;overflow:hidden;margin-bottom:5px">
                <div style="height:100%;width:${pct}%;background:#06b6d4;transition:width .4s"></div>
              </div>
              ${verdictTrunc ? html`
                <div style="font-size:9px;color:#64748b;font-style:italic;line-height:1.3;margin-bottom:6px">${verdictTrunc}</div>
              ` : nothing}
              <button style="
                font-size:8px;padding:2px 10px;background:transparent;
                border:1px solid #06b6d444;color:#06b6d4;cursor:pointer;letter-spacing:.06em;
              " @click=${() => {
                state.setTab?.('autonomy' as any);
                setTimeout(() => {
                  if (state.autonomyState) {
                    (state.autonomyState as any).goalDetailTaskId = g.taskId;
                    (state.autonomyState as any).goalDetailLoading = true;
                    state.requestUpdate?.();
                  }
                }, 150);
              }}>🔍 OPEN DETAIL</button>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

// ── Main export ──────────────────────────────────────────────────────────────

export interface DashboardProps {
  as: AgentActivityState;
  kanbanTasks: KanbanTask[];
  kanbanProjects: KanbanProject[];
  client: GatewayBrowserClient;
  state: AppViewState;
  /** Optional: navigate to a project in the kanban view by project ID. */
  onNavigateToKanban?: (projectId: string) => void;
}

export function renderAgentDashboard(props: DashboardProps): TemplateResult {
  const { as, kanbanTasks, kanbanProjects, client, state } = props;

  // Lazy init: subscribe recently-completed + start metric sampling + 1s duration tick
  initDashboard(
    client,
    () => state.requestUpdate?.(),
    () => ({
      activeAgents: as.sessions.filter(s => s.active && !s.completedViaEvent).length,
      // Agent tasks are always created as "in_progress" (hardcoded in mcpCreateTask /
      // registerSubagentRun / claude-coder-tool). Manually-seeded Notion tasks default
      // to "Not started" → "todo". Filtering to in_progress gives a clean agent-only
      // signal without requiring a source/origin field that doesn't exist in the schema.
      pendingTasks: kanbanTasks.filter(t => t.status === "in_progress").length,
      completedToday: getRecentlyCompletedTodayCount(),
    }),
  );

  // ── Metrics ──────────────────────────────────────────────────

  const activeSessions = as.sessions.filter(s => s.active && !s.completedViaEvent);
  const completedSessions = as.sessions.filter(s => s.completedViaEvent && s.completionState !== "error");

  const activeCount     = activeSessions.length;
  const completedToday  = getRecentlyCompletedTodayCount();
  // Agent-only pending count: agents always create kanban tasks as "in_progress" via
  // mcpCreateTask / registerSubagentRun / claude-coder-tool (status hardcoded at creation).
  // Manually-created / seeded Notion tasks start as "Not started" → "todo".
  // Filtering to in_progress excludes test/seeded data without requiring a source field.
  const pendingCount    = kanbanTasks.filter(t => t.status === "in_progress").length;

  // Avg / median run duration from recently-completed sessions
  const rawDurations: number[] = completedSessions
    .filter(s => s.updatedAt !== null && s.steps.length > 0)
    .map(s => s.updatedAt! - s.steps[0].timestamp)
    .filter(d => d > 0 && d < 86_400_000)
    .slice(-20);
  const avgDuration = rawDurations.length > 0
    ? Math.round(rawDurations.reduce((a, b) => a + b, 0) / rawDurations.length)
    : 0;
  const medDuration = rawDurations.length > 0
    ? rawDurations.slice().sort((a, b) => a - b)[Math.floor(rawDurations.length / 2)]
    : 0;

  // Sparkline history arrays
  const activeHist    = _samples.map(s => s.activeAgents);
  const completedHist = _samples.map(s => s.completedToday);
  const pendingHist   = _samples.map(s => s.pendingTasks);
  // Duration sparkline: normalize to minutes capped at 100
  const durationHist  = rawDurations.slice(-30).map(d => Math.min(100, d / 60_000));

  // Severity thresholds
  const activeWarn  = activeCount > 5;
  const pendingWarn = pendingCount > 20;
  const pendingDanger = pendingCount > 50;

  // Project map for Section B agent cards
  const projMap = new Map(kanbanProjects.map(p => [p.id, p]));

  // COORDINATION: goal-orchestrator-mode — split active sessions by goal lineage
  // so autonomous goal sub-agents render as their own clustered section, separated
  // from manually-spawned agents (main chats, coder, MCP sub-agents).
  const goalGroups = new Map<string, { goalId: string; goalTitle: string; sessions: AgentSession[] }>();
  const manualActiveSessions: AgentSession[] = [];
  for (const s of activeSessions) {
    if (s.parentGoalId) {
      const key = s.parentGoalId;
      let group = goalGroups.get(key);
      if (!group) {
        group = {
          goalId: key,
          goalTitle: s.parentGoalTitle ?? key,
          sessions: [],
        };
        goalGroups.set(key, group);
      }
      group.sessions.push(s);
    } else {
      manualActiveSessions.push(s);
    }
  }

  const autonomyGoalsById = new Map<string, { currentPhase?: string; turnsUsed: number; maxTurns: number; status: string }>();
  const autonomyGoals = (state.autonomyState as any)?.activeGoals as Array<{
    taskId: string;
    currentPhase?: string;
    turnsUsed: number;
    maxTurns: number;
    status: string;
  }> | undefined;
  if (autonomyGoals) {
    for (const g of autonomyGoals) autonomyGoalsById.set(g.taskId, g);
  }

  const renderActiveCard = (session: AgentSession) => {
    const linkedTask = kanbanTasks.find(t =>
      t.assignedAgent === session.agentId ||
      t.assignedAgent === session.label,
    );
    const linkedProject = linkedTask ? projMap.get(linkedTask.projectId) : undefined;
    const filesTouchedCount = _subagentFileCounts.get(session.key) ?? 0;
    // Every running-agent card is clickable — the detail modal handles its own
    // not-found state for sessions outside the subagent registry. Only skip
    // wiring the handler if the lookup key is missing entirely (defensive: in
    // practice AgentSession.key is always populated by the activity controller).
    const onCardClick = session.key
      ? () => openSubagentDetailModal({
          client,
          requestUpdate: () => state.requestUpdate?.(),
          sessionKey: session.key,
        })
      : undefined;
    return renderRunningAgentCard(session, linkedProject, props.onNavigateToKanban, onCardClick, filesTouchedCount);
  };

  return html`
    ${dashStyles()}
    <div class="iad-root">

      <!-- ── Section A: Hero Stats ─────────────────────────────── -->
      <div class="iad-hero-row" data-learn-id="activity-stats">
        ${renderHeroTile({
          label: "Active Agents",
          value: activeCount,
          trendStr: trendIndicator(activeHist),
          samples: activeHist,
          warn: activeWarn,
        })}
        ${renderHeroTile({
          label: "Completed Today",
          value: completedToday,
          trendStr: trendIndicator(completedHist),
          samples: completedHist,
        })}
        ${renderHeroTile({
          label: "Pending Tasks",
          value: pendingCount,
          subValue: "agents only",
          trendStr: trendIndicator(pendingHist),
          samples: pendingHist,
          warn: pendingWarn,
          danger: pendingDanger,
        })}
        ${renderHeroTile({
          label: "Avg Run Duration",
          value: avgDuration > 0 ? fmtDuration(avgDuration) : "—",
          subValue: medDuration > 0 ? `med ${fmtDuration(medDuration)}` : undefined,
          trendStr: "",
          samples: durationHist,
        })}
      </div>

      <!-- ── Recent agent completion notifications strip ────────── -->
      ${renderNotificationStrip(_notifStripItems, (link) => {
        const sessionMatch = link.match(/\/activity\/session\/([^?#]+)/);
        if (sessionMatch) {
          const sk = decodeURIComponent(sessionMatch[1]);
          openSubagentDetailModal({
            client,
            requestUpdate: () => state.requestUpdate?.(),
            sessionKey: sk,
          });
        }
      })}

      <!-- COORDINATION: running-goal-views — Goal Spotlight (visible when ≥1 goal running) -->
      ${renderGoalSpotlight(state)}

      <!-- ── Section B: Running Agents Grid ────────────────────── -->
      ${activeSessions.length === 0 ? html`
        <div>
          <div class="iad-section-hdr" data-learn-id="activity-running">
            <span class="iad-section-dot"></span>
            <span class="iad-section-title">Running Agents</span>
            <span class="iad-section-badge">0</span>
          </div>
          <div class="iad-empty-state">
            <span style="font-size:10px;letter-spacing:0.08em;color:var(--g-fg-dim,rgba(245,245,244,0.55));">
              ◌ &nbsp;NO ACTIVE AGENTS — AWAITING TRANSMISSIONS
            </span>
          </div>
        </div>
      ` : html`
        ${goalGroups.size > 0 ? html`
          <div class="iad-goal-section">
            <div class="iad-goal-section-hdr">
              <span class="iad-goal-icon">🎯</span>
              <span class="iad-goal-section-title">Autonomous Goal Agents</span>
              <span class="iad-goal-section-badge">
                ${[...goalGroups.values()].reduce((n, g) => n + g.sessions.length, 0)}
                <span style="width:5px;height:5px;border-radius:50%;background:#06b6d4;display:inline-block;animation:iad-pulse 1.2s infinite"></span>
              </span>
              <span style="margin-left:auto;font-size:9px;color:var(--g-fg-dim,rgba(245,245,244,0.55));letter-spacing:0.06em;">
                ${goalGroups.size} GOAL${goalGroups.size !== 1 ? "S" : ""}
              </span>
            </div>
            ${[...goalGroups.values()].map(group => {
              const meta = autonomyGoalsById.get(group.goalId);
              const phase = meta?.currentPhase?.replace(/_/g, " ").toUpperCase();
              const turns = meta ? `turn ${meta.turnsUsed}/${meta.maxTurns}` : null;
              return html`
                <div class="iad-goal-cluster">
                  <div class="iad-goal-header">
                    <span class="iad-goal-icon">🎯</span>
                    <span class="iad-goal-title-text" title="${group.goalTitle}">
                      ${group.goalTitle}
                    </span>
                    ${phase ? html`<span class="iad-goal-phase-chip">${phase}</span>` : nothing}
                    ${turns ? html`<span class="iad-goal-turns-chip">${turns}</span>` : nothing}
                    <span class="iad-goal-count-chip">
                      ${group.sessions.length} SUB${group.sessions.length !== 1 ? "S" : ""}
                    </span>
                  </div>
                  <div class="iad-agents-grid">
                    ${group.sessions.map(renderActiveCard)}
                  </div>
                </div>
              `;
            })}
          </div>
        ` : nothing}

        ${manualActiveSessions.length > 0 ? html`
          <div>
            <div class="iad-section-hdr" data-learn-id="activity-running">
              <span class="iad-section-dot live"></span>
              <span class="iad-section-title">Running Agents</span>
              <span class="iad-section-badge">${manualActiveSessions.length}</span>
            </div>
            <div class="iad-agents-grid" style="margin-top:12px;">
              ${manualActiveSessions.map(renderActiveCard)}
            </div>
          </div>
        ` : nothing}
      `}

      <!-- ── Section C: Task Oversight ─────────────────────────── -->
      <div class="iad-oversight-row">

        <!-- Left: Recently Completed (embeds existing feed widget) -->
        <div class="iad-oversight-card" data-learn-id="activity-completed">
          <div class="iad-corner iad-tl"></div>
          <div class="iad-corner iad-br"></div>
          <div class="iad-card-hdr">
            <span class="iad-card-title">Recently Completed</span>
            <span class="iad-card-count">${completedToday} today</span>
          </div>
          <div class="iad-oversight-body iad-fade-edges">
            ${renderRecentlyCompletedBody(
              props.onNavigateToKanban
                ? (_taskId: string, projectId: string | null) => {
                    if (projectId) props.onNavigateToKanban!(projectId);
                  }
                : undefined,
            )}
          </div>
        </div>

        <!-- Right: Pending Queue -->
        ${renderPendingQueue(kanbanTasks, kanbanProjects, activeSessions)}
      </div>

      <!-- ── Section D: Activity Timeline ──────────────────────── -->
      <!-- TODO: timeline strip — horizontal dot-plot of events over last hour -->

    </div>
  `;
}
