/**
 * Global Activity Side Panel — slides out from the right edge.
 * Shows a compact, real-time feed of all agent sessions with clear task visibility.
 * Black & Gold terminal HUD aesthetic.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { AgentSession, AgentStep } from "../controllers/agent-activity";
import {
  createInitialActivityState,
  loadAgentActivity,
  startActivityPolling,
  stopActivityPolling,
  isClaudeCoder,
} from "../controllers/agent-activity";
import {
  loadRecentlyCompleted,
  subscribeRecentCompleted,
  renderRecentlyCompletedFeed,
  getRecentlyCompletedTodayCount,
} from "./recently-completed-feed";

// ── HUD Colors ───────────────────────────────────────────────

const P = {
  bg:        "#050505",
  bgCard:    "#0a0a0a",
  bgHover:   "#0f0f0f",
  bgSurface: "#111111",
  gold:      "var(--g-primary)",
  goldDim:   "var(--g-primary)",
  goldMuted: "#8B7536",
  goldBorder:"color-mix(in srgb, var(--g-primary) 12%, transparent)",
  goldGlow:  "color-mix(in srgb, var(--g-primary) 20%, transparent)",
  goldSubtle:"color-mix(in srgb, var(--g-primary) 4%, transparent)",
  text:      "#e4e4e7",
  textMuted: "#71717a",
  textDim:   "#52525b",
  border:    "#1a1a1a",
  active:    "#22c55e",
  activeGlow:"rgba(34,197,94,0.25)",
  activeBg:  "rgba(34,197,94,0.06)",
  tool:      "var(--g-primary)",
  result:    "#22c55e",
  thinking:  "#a78bfa",
  error:     "#ef4444",
  subBorder: "rgba(59,130,246,0.2)",
  subGlow:   "rgba(59,130,246,0.1)",
  mono:      "'JetBrains Mono','SF Mono','Consolas',monospace",
};

const PANEL_WIDTH = 400;

// ── Formatters ───────────────────────────────────────────────

function timeAgo(ts: number | null): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 5000) return "now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

function formatTokens(n?: number): string {
  if (!n) return "—";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// ── Agent Display Logic ──────────────────────────────────────

const AGENT_META: Record<string, { icon: string; color: string }> = {
  main:          { icon: "🔥", color: P.gold },
  webdev:        { icon: "🏗️", color: "#60a5fa" },
  qa:            { icon: "🔍", color: "#34d399" },
  coder:         { icon: "💻", color: "#a78bfa" },
  opus:          { icon: "🧠", color: "#f472b6" },
  "claude-code": { icon: "🤖", color: P.gold },
};

function agentIcon(agentId: string): string {
  return AGENT_META[agentId]?.icon || "⚡";
}

function agentColor(agentId: string): string {
  return AGENT_META[agentId]?.color || P.goldDim;
}

/** Get the best human-readable name for this session */
function sessionDisplayName(session: AgentSession): string {
  // For sub-agents: use label (which is the task description) as the name
  if (session.kind === "subagent") {
    return session.label || session.displayName || session.derivedTitle || `Sub-agent ${session.agentId}`;
  }
  // For main: use agent name
  return session.agentName;
}

/** Get task/goal summary for the session */
function sessionTask(session: AgentSession): string {
  if (session.kind === "subagent") {
    // For sub-agents, derivedTitle is usually the task prompt
    return session.derivedTitle || session.lastMessagePreview || "";
  }
  return session.derivedTitle || session.lastMessagePreview || session.label || "";
}

/** Estimate progress from steps */
function estimateProgress(session: AgentSession): { phase: string; pct: number } | null {
  if (!session.active && session.steps.length > 0) {
    return { phase: "COMPLETE", pct: 100 };
  }
  if (!session.active) return null;

  const stepCount = session.steps.length;
  const toolCalls = session.steps.filter((s) => s.type === "tool_call").length;
  const lastStep = session.steps[session.steps.length - 1];

  if (stepCount === 0) return { phase: "STARTING", pct: 5 };
  if (lastStep?.type === "thinking") return { phase: "THINKING", pct: Math.min(30 + toolCalls * 5, 80) };
  if (lastStep?.type === "tool_call") return { phase: lastStep.content?.toUpperCase() || "WORKING", pct: Math.min(20 + toolCalls * 8, 90) };
  if (lastStep?.type === "tool_result") return { phase: "PROCESSING", pct: Math.min(25 + toolCalls * 8, 90) };
  return { phase: "WORKING", pct: Math.min(10 + stepCount * 3, 85) };
}

function stepIcon(type: string): string {
  switch (type) {
    case "user":        return "▸";
    case "text":        return "◆";
    case "tool_call":   return "⚡";
    case "tool_result": return "↩";
    case "thinking":    return "◈";
    case "spawn":       return "⊕";
    case "error":       return "✕";
    default:            return "·";
  }
}

function stepColor(type: string): string {
  switch (type) {
    case "user":        return P.gold;
    case "tool_call":   return P.tool;
    case "tool_result": return P.result;
    case "thinking":    return P.thinking;
    case "error":       return P.error;
    case "spawn":       return P.gold;
    default:            return P.textMuted;
  }
}

// ── Panel Init / Teardown ────────────────────────────────────

export async function ensureActivityPanelData(state: AppViewState): Promise<void> {
  if (!state.agentActivityState) {
    state.agentActivityState = createInitialActivityState();
  }
  const client = state.client;
  if (client) {
    if (!state.agentActivityState.pollIntervalId) {
      await loadAgentActivity(state, client);
      startActivityPolling(state, client);
    }
    void loadRecentlyCompleted(client, () => state.requestUpdate?.());
    subscribeRecentCompleted(client);
  }
}

export function teardownActivityPanel(state: AppViewState): void {
  if (state.tab !== "activity") {
    stopActivityPolling(state);
  }
}

// ── Main Render ──────────────────────────────────────────────

export function renderActivityPanel(state: AppViewState, client: GatewayBrowserClient | null) {
  const open = state.activityPanelOpen ?? false;

  return html`
    <!-- Backdrop -->
    ${open ? html`
      <div style="
        position:fixed; inset:0; z-index:89;
        background:rgba(0,0,0,0.5); backdrop-filter:blur(2px);
      " @click=${() => {
        state.activityPanelOpen = false;
        teardownActivityPanel(state);
        state.requestUpdate?.();
      }}></div>
    ` : nothing}

    <!-- Panel -->
    <div style="
      position:fixed; top:0; right:0; bottom:0;
      width:${PANEL_WIDTH}px; z-index:90;
      background:${P.bg};
      border-left:1px solid ${P.goldBorder};
      box-shadow: ${open ? `-4px 0 40px rgba(0,0,0,0.6), -1px 0 15px ${P.goldGlow}` : "none"};
      transform:translateX(${open ? "0" : "100%"});
      transition:transform 0.25s cubic-bezier(0.4,0,0.2,1);
      display:flex; flex-direction:column;
      font-family:${P.mono};
      overflow:hidden;
    ">
      ${open ? renderPanelContent(state, client) : nothing}
    </div>

    <style>
      @keyframes ap-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      @keyframes ap-progress { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    </style>
  `;
}

// ── Panel Content ────────────────────────────────────────────

function renderPanelContent(state: AppViewState, client: GatewayBrowserClient | null) {
  const as = state.agentActivityState;
  const sessions = as?.sessions ?? [];
  const activeSessions = sessions.filter((s) => s.active);
  const subagents = sessions.filter((s) => s.kind === "subagent");
  const coderRuns = sessions.filter((s) => isClaudeCoder(s));
  const activeCoderRuns = coderRuns.filter((s) => s.active);

  return html`
    <!-- Header -->
    <div style="
      padding:14px 16px; flex-shrink:0;
      border-bottom:1px solid ${P.goldBorder};
      background:${P.bgCard};
    ">
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:10px; font-weight:700; color:${P.gold}; letter-spacing:0.15em;">
              AGENT FEED
            </span>
            ${activeSessions.length > 0 ? html`
              <span style="
                font-size:8px; padding:1px 6px; letter-spacing:0.1em; font-weight:700;
                border:1px solid ${P.active}; color:${P.active};
                animation:ap-pulse 2s infinite;
              ">${activeSessions.length} LIVE</span>
            ` : nothing}
          </div>
          <div style="font-size:9px; color:${P.textDim}; margin-top:2px; letter-spacing:0.05em;">
            ${sessions.length} SESSION${sessions.length !== 1 ? "S" : ""}
            ${subagents.length > 0 ? ` · ${subagents.length} SUB-AGENT${subagents.length !== 1 ? "S" : ""}` : ""}
          </div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          ${client ? html`
            <button style="
              padding:2px 8px; background:transparent; border:1px solid ${P.goldBorder};
              color:${P.goldMuted}; font-size:9px; font-family:${P.mono}; cursor:pointer;
            " @click=${async () => {
              if (client && as) {
                await loadAgentActivity(state, client);
                state.requestUpdate?.();
              }
            }}>↻</button>
          ` : nothing}
          <button style="
            padding:2px 8px; background:transparent; border:1px solid ${P.border};
            color:${P.textDim}; font-size:9px; font-family:${P.mono}; cursor:pointer;
          " @click=${() => {
            state.activityPanelOpen = false;
            teardownActivityPanel(state);
            state.requestUpdate?.();
          }}>✕</button>
        </div>
      </div>
    </div>

    <!-- Sessions List -->
    <div style="flex:1; overflow-y:auto; overflow-x:hidden;">
      ${sessions.length === 0 ? html`
        <div style="padding:40px 16px; text-align:center;">
          <div style="font-size:10px; color:${P.goldMuted}; letter-spacing:0.15em;">NO SESSIONS</div>
          <div style="font-size:9px; color:${P.textDim}; letter-spacing:0.08em; margin-top:4px;">
            AWAITING TRANSMISSIONS
          </div>
        </div>
      ` : sessions.map((s) => renderPanelSession(s, state))}

      <!-- Recently completed kanban tasks (collapsed by default) -->
      <div style="padding: 8px 10px 4px;">
        ${renderRecentlyCompletedFeed({
          mount: "activity",
          onNavigateToTask: (taskId, _projectId) => {
            if (taskId !== "__view_all__") {
              state.activityPanelOpen = false;
              state.setTab?.("kanban" as any);
            }
            state.requestUpdate?.();
          },
        })}
      </div>
    </div>

    <!-- Footer -->
    <div style="
      padding:8px 16px; flex-shrink:0; border-top:1px solid ${P.border};
      background:${P.bgCard};
      display:flex; justify-content:space-between; align-items:center; gap:6px;
    ">
      <span style="font-size:8px; color:${P.textDim}; letter-spacing:0.1em;">
        POLL ${as?.pollInterval ?? 10}s
      </span>
      <div style="display:flex; gap:6px;">
        ${coderRuns.length > 0 ? html`
          <button style="
            padding:2px 10px; background:transparent; border:1px solid ${P.gold};
            color:${P.gold}; font-size:8px; font-family:${P.mono}; cursor:pointer;
            letter-spacing:0.1em; display:flex; align-items:center; gap:4px;
            ${activeCoderRuns.length > 0 ? `box-shadow:0 0 8px ${P.goldGlow};` : ""}
          " title="Filter activity to Claude Coder runs"
            @click=${() => {
              if (as) as.showCoderOnly = true;
              state.activityPanelOpen = false;
              teardownActivityPanel(state);
              state.setTab("activity" as any);
              state.requestUpdate?.();
            }}>
            🤖 CODER ${coderRuns.length}${activeCoderRuns.length > 0 ? html` <span style="
              background:${P.active}; color:#000; font-size:7px; font-weight:700;
              padding:0 4px; letter-spacing:0;
            ">${activeCoderRuns.length}</span>` : nothing}
          </button>
        ` : nothing}
        <button style="
          padding:2px 10px; background:transparent; border:1px solid ${P.goldBorder};
          color:${P.goldDim}; font-size:8px; font-family:${P.mono}; cursor:pointer;
          letter-spacing:0.1em;
        " @click=${() => {
          state.activityPanelOpen = false;
          teardownActivityPanel(state);
          state.setTab("activity" as any);
          state.requestUpdate?.();
        }}>FULL VIEW →</button>
      </div>
    </div>
  `;
}

// ── Session Row ──────────────────────────────────────────────

function renderPanelSession(session: AgentSession, state: AppViewState) {
  const isExpanded = session.expanded;
  const lastSteps = session.steps.slice(-5).reverse();
  const name = sessionDisplayName(session);
  const task = sessionTask(session);
  const progress = estimateProgress(session);
  const isSub = session.kind === "subagent";
  const color = agentColor(session.agentId);
  const icon = agentIcon(session.agentId);
  const toolCalls = session.steps.filter((s) => s.type === "tool_call").length;

  return html`
    <div style="
      border-bottom:1px solid ${P.border};
      ${isSub ? `border-left:2px solid ${color}20;` : ""}
      ${session.active ? `background:${P.goldSubtle};` : ""}
    ">
      <!-- Session header -->
      <div style="
        padding:10px 16px; cursor:pointer;
        display:flex; align-items:flex-start; gap:8px;
        transition:background 0.1s ease;
      "
        @click=${() => { session.expanded = !session.expanded; state.requestUpdate?.(); }}
        @mouseenter=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = P.bgHover; }}
        @mouseleave=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = session.active ? P.goldSubtle : "transparent"; }}
      >
        <!-- Agent icon + status -->
        <div style="flex-shrink:0; position:relative; margin-top:1px;">
          <span style="font-size:14px;">${icon}</span>
          ${session.active ? html`
            <div style="
              position:absolute; bottom:-2px; right:-2px;
              width:6px; height:6px; background:${P.active};
              box-shadow:0 0 4px ${P.activeGlow};
              animation:ap-pulse 2s infinite;
            "></div>
          ` : nothing}
        </div>

        <!-- Main content -->
        <div style="flex:1; min-width:0;">
          <!-- Name + badges row -->
          <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
            <span style="font-size:11px; font-weight:600; color:${session.active ? color : P.text};">
              ${truncate(name, 35)}
            </span>
            <span style="
              font-size:7px; padding:1px 4px; letter-spacing:0.1em; font-weight:700;
              border:1px solid ${isSub ? `${color}40` : P.goldBorder};
              color:${isSub ? color : P.goldMuted};
            ">${isSub ? "SUB" : session.kind === "main" ? "MAIN" : "SES"}</span>
            ${session.channel ? html`
              <span style="font-size:7px; color:${P.textDim}; letter-spacing:0.08em; text-transform:uppercase;">
                ${session.channel}
              </span>
            ` : nothing}
          </div>

          <!-- Task/goal line -->
          ${task ? html`
            <div style="
              font-size:9px; color:${P.textMuted}; margin-top:2px;
              overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
              ${isSub ? `color:${P.text}; font-weight:500;` : ""}
            ">
              ${truncate(task, 60)}
            </div>
          ` : nothing}

          <!-- Progress bar (for active sessions) -->
          ${progress && session.active ? html`
            <div style="margin-top:5px; display:flex; align-items:center; gap:6px;">
              <div style="
                flex:1; height:3px; background:${P.border}; overflow:hidden;
              ">
                <div style="
                  height:100%; width:${progress.pct}%;
                  background: linear-gradient(90deg, ${color}, ${color}80);
                  transition: width 0.5s ease;
                  ${progress.pct < 100 ? `
                    background-size:200% 100%;
                    animation: ap-progress 2s linear infinite;
                    background-image: linear-gradient(90deg, ${color}40, ${color}, ${color}40);
                  ` : ""}
                "></div>
              </div>
              <span style="font-size:7px; color:${color}; letter-spacing:0.1em; font-weight:700; flex-shrink:0;">
                ${progress.phase}
              </span>
            </div>
          ` : nothing}

          <!-- Completed indicator for finished sub-agents -->
          ${!session.active && isSub && session.steps.length > 0 ? html`
            <div style="margin-top:3px; font-size:8px; color:${P.active}; letter-spacing:0.08em;">
              ✓ COMPLETE · ${session.steps.length} steps · ${toolCalls} tools
            </div>
          ` : nothing}
        </div>

        <!-- Stats + chevron -->
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:1px; flex-shrink:0;">
          <span style="font-size:9px; color:${P.goldMuted};">${timeAgo(session.updatedAt)}</span>
          <span style="font-size:8px; color:${P.textDim};">${formatTokens(session.totalTokens)}</span>
          <span style="
            font-size:7px; color:${P.goldMuted}; margin-top:2px;
            transform:rotate(${isExpanded ? "180deg" : "0deg"});
            transition:transform 0.15s ease;
          ">▼</span>
        </div>
      </div>

      <!-- Expanded: recent steps -->
      ${isExpanded ? html`
        <div style="padding:0 16px 10px 40px;">
          ${lastSteps.length === 0 ? html`
            <div style="font-size:9px; color:${P.textDim}; padding:4px 0; letter-spacing:0.05em;">
              NO ACTIVITY
            </div>
          ` : lastSteps.map((step) => renderPanelStep(step))}

          <!-- Mini stats bar -->
          <div style="
            margin-top:6px; padding-top:6px; border-top:1px solid ${P.border};
            display:flex; gap:10px; font-size:8px; color:${P.textDim}; letter-spacing:0.05em;
          ">
            <span>${session.steps.length} MSG</span>
            <span>${toolCalls} TOOLS</span>
            <span style="color:${P.goldMuted}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${session.model || "default"}
            </span>
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Step Row (compact) ───────────────────────────────────────

function renderPanelStep(step: AgentStep) {
  const color = stepColor(step.type);
  const icon = stepIcon(step.type);
  const content = step.type === "tool_call"
    ? step.content
    : truncate(step.content, 55);

  return html`
    <div style="display:flex; align-items:flex-start; gap:6px; margin-top:3px; font-size:9px; line-height:1.3;">
      <span style="color:${color}; flex-shrink:0; width:10px; text-align:center;">${icon}</span>
      <span style="color:${step.type === "user" ? P.goldDim : P.textMuted}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">
        ${content}
      </span>
      <span style="font-size:8px; color:${P.textDim}; flex-shrink:0;">
        ${step.timestamp ? new Date(step.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
      </span>
    </div>
  `;
}

// ── Grid Panel Body ──────────────────────────────────────────

/**
 * Renders the feed content (session list + footer) for embedding inside a grid panel.
 * The caller provides the outer panel chrome (ep-header with title, minimize/close etc.).
 * Shares the same agentActivityState as the global slide-out panel — no duplicate fetching.
 */
export function renderActivityFeedBody(state: AppViewState, client: GatewayBrowserClient | null) {
  const as = state.agentActivityState;
  const sessions = as?.sessions ?? [];
  const coderRuns = sessions.filter((s) => isClaudeCoder(s));
  const activeCoderRuns = coderRuns.filter((s) => s.active);

  return html`
    <div style="display:flex; flex-direction:column; height:100%; font-family:${P.mono}; background:${P.bg};">
      <div style="flex:1; overflow-y:auto; overflow-x:hidden; min-height:0;">
        ${sessions.length === 0 ? html`
          <div style="padding:40px 16px; text-align:center;">
            <div style="font-size:10px; color:${P.goldMuted}; letter-spacing:0.15em;">NO SESSIONS</div>
            <div style="font-size:9px; color:${P.textDim}; letter-spacing:0.08em; margin-top:4px;">
              AWAITING TRANSMISSIONS
            </div>
          </div>
        ` : sessions.map((s) => renderPanelSession(s, state))}
      </div>
      <div style="
        padding:8px 16px; flex-shrink:0; border-top:1px solid ${P.border};
        background:${P.bgCard};
        display:flex; justify-content:space-between; align-items:center; gap:6px;
      ">
        <span style="font-size:8px; color:${P.textDim}; letter-spacing:0.1em;">
          POLL ${as?.pollInterval ?? 10}s · ${sessions.length} SESSION${sessions.length !== 1 ? "S" : ""}
        </span>
        <div style="display:flex; gap:6px;">
          ${coderRuns.length > 0 ? html`
            <button style="
              padding:2px 8px; background:transparent; border:1px solid ${P.gold};
              color:${P.gold}; font-size:8px; font-family:${P.mono}; cursor:pointer;
              letter-spacing:0.1em; display:flex; align-items:center; gap:3px;
              ${activeCoderRuns.length > 0 ? `box-shadow:0 0 8px ${P.goldGlow};` : ""}
            " title="Open Coder tab"
              @click=${() => {
                state.activityPanelOpen = false;
                if (as) as.showCoderOnly = true;
                state.setTab?.("activity" as any);
                state.requestUpdate?.();
              }}>
              🤖 ${coderRuns.length}
            </button>
          ` : nothing}
          <button style="
            padding:2px 10px; background:transparent; border:1px solid ${P.goldBorder};
            color:${P.goldDim}; font-size:8px; font-family:${P.mono}; cursor:pointer;
            letter-spacing:0.1em;
          " @click=${() => {
            state.activityPanelOpen = false;
            state.setTab?.("activity" as any);
            state.requestUpdate?.();
          }}>FULL VIEW →</button>
        </div>
      </div>
    </div>
    <style>
      @keyframes ap-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      @keyframes ap-progress { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    </style>
  `;
}

// ── Topbar Button ────────────────────────────────────────────

export function renderActivityPanelButton(state: AppViewState) {
  const as = state.agentActivityState;
  const activeSessions = as?.sessions?.filter((s) => s.active) ?? [];
  const activeSubagents = activeSessions.filter((s) => s.kind === "subagent");
  const hasActive = activeSessions.length > 0;
  const doneToday = getRecentlyCompletedTodayCount();

  const titleParts: string[] = [];
  if (hasActive) titleParts.push(`${activeSessions.length} active (${activeSubagents.length} sub-agents)`);
  if (doneToday > 0) titleParts.push(`${doneToday} done today`);
  const title = titleParts.length > 0 ? titleParts.join(" · ") : "Agent Activity Feed";

  return html`
    <button
      class="pill"
      style="
        cursor:pointer; border:none; position:relative;
        ${hasActive ? `border:1px solid ${P.goldBorder};` : ""}
      "
      @click=${async () => {
        state.activityPanelOpen = !state.activityPanelOpen;
        if (state.activityPanelOpen) {
          await ensureActivityPanelData(state);
        } else {
          teardownActivityPanel(state);
        }
        state.requestUpdate?.();
      }}
      title="${title}"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
      ${hasActive ? html`
        <span style="
          position:absolute; top:2px; right:2px;
          min-width:14px; height:14px; padding:0 3px;
          background:${P.active}; color:#000;
          font-size:8px; font-weight:700; font-family:${P.mono};
          display:flex; align-items:center; justify-content:center;
          box-shadow:0 0 4px ${P.activeGlow};
          animation:ap-pulse 2s infinite;
        ">${activeSessions.length}</span>
      ` : doneToday > 0 ? html`
        <span style="
          position:absolute; top:2px; right:2px;
          min-width:14px; height:14px; padding:0 3px;
          background:color-mix(in srgb, #22d3ee 80%, transparent); color:#000;
          font-size:8px; font-weight:700; font-family:${P.mono};
          display:flex; align-items:center; justify-content:center;
        ">${doneToday}</span>
      ` : nothing}
    </button>
  `;
}
