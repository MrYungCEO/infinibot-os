/**
 * Agent Activity — /activity page.
 * Real-time monitoring of every running agent, in the black-gold glass
 * system (styles: glass-activity.css.ts, primitives: glass-agents-shared.ts).
 */

import { html, nothing, svg, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import "../components/subagent-activity-panel";
import "../components/subagent-history-feed";
import "../components/recently-finished-sessions-feed";
import "../components/credit-usage-breakdown";
import "../components/queue-activity-strip";
import { estimateProgress } from "../components/progress-estimate";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type {
  AgentActivityState,
  AgentSession,
  AgentStep,
  SpawnNotification,
} from "../controllers/agent-activity";
import {
  loadAgentActivity,
  loadSessionHistory,
  dismissSpawnNotification,
  restartActivityPolling,
  retryActivityLoad,
  forceCompleteSession,
  isClaudeCoder,
  isStreamingSession,
  pinToLive,
  pinToBackground,
  unpinSession,
  toggleBgCollapsed,
  openChatModal,
  closeChatModal,
  sendModalMessage,
  scrollModalToBottom,
} from "../controllers/agent-activity";
import { renderAgentDashboard } from "./agent-activity-dashboard";
import { getRecentlyCompletedTodayCount } from "./recently-completed-feed";
import { glassAurora, glassEmpty, glassSkeletonCards } from "./glass-agents-shared";
import { activityGlassStyle, ACTIVITY_DASH_CSS, ACTIVITY_MODAL_CSS, ACTIVITY_PAGE_CSS, installActivityTokenGlass } from "./glass-activity.css";
import { mountSubagentDetailListener } from "../components/subagent-detail-modal";
import {
  ALL_CODER_BACKEND_IDS,
  getCoderBackendBrand,
  type CoderBackendBrand,
  type CoderBackendId,
} from "../lib/coder-backend-brand";

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

// ── HUD Color System ────────────────────────────────────────
//
// All values resolve through the global --g-* token system so the appearance
// picker recolors the activity feed in lockstep with the rest of the app.
// Keep hardcoded hex only for semantic-status colors (active=green,
// thinking=violet, error=red) — those carry meaning independent of brand.

export const HUD = {
  // Backgrounds — token-driven, no more hardcoded #050505 blacks.
  bg:        "var(--g-bg-deep, rgba(0,0,0,0.5))",
  bgCard:    "var(--g-surface, rgba(255,255,255,0.04))",
  bgSurface: "var(--g-surface-strong, rgba(255,255,255,0.06))",
  bgHover:   "var(--g-surface-hover, rgba(255,255,255,0.08))",
  bgInset:   "color-mix(in srgb, var(--g-bg-deep) 70%, transparent)",

  // Brand spectrum — reads from --g-primary so palette swaps cascade.
  gold:        "var(--g-primary)",
  goldDim:     "color-mix(in srgb, var(--g-primary) 70%, var(--g-fg-dim))",
  goldMuted:   "color-mix(in srgb, var(--g-primary) 45%, var(--g-fg-dim))",
  goldSubtle:  "var(--g-primary-soft)",
  goldBorder:  "var(--g-primary-muted)",
  goldGlow:    "var(--g-primary-strong)",

  // Text — token-driven.
  text:        "var(--g-fg, #e4e4e7)",
  textMuted:   "var(--g-fg-dim, #71717a)",
  textDim:     "var(--g-fg-faint, #52525b)",
  textGold:    "var(--g-primary)",

  // Borders — also tokenized.
  border:      "var(--g-border, rgba(255,255,255,0.08))",
  borderLight: "var(--g-border-strong, rgba(255,255,255,0.12))",

  // Semantic accents. Hardcoded because "active = green" / "error = red"
  // carries meaning independent of any brand palette.
  active:      "#22c55e",
  activeGlow:  "rgba(34,197,94,0.30)",
  tool:        "var(--g-primary)",
  toolBg:      "color-mix(in srgb, var(--g-primary) 6%, transparent)",
  result:      "#22c55e",
  resultBg:    "rgba(34,197,94,0.05)",
  thinking:    "#a78bfa",
  thinkingBg:  "rgba(167,139,250,0.06)",
  user:        "var(--g-primary)",
  userBg:      "color-mix(in srgb, var(--g-primary) 5%, transparent)",
  error:       "#ef4444",
  errorBg:     "rgba(239,68,68,0.07)",
  spawn:       "var(--g-primary)",

  // Mono font — fall back chain.
  mono: "var(--g-mono-family, 'JetBrains Mono','SF Mono','Consolas',monospace)",
};

// Step type styling — gold-centric
const STEP_STYLES: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  user:        { icon: "▸", color: HUD.user,     bg: HUD.userBg,     label: "INPUT" },
  text:        { icon: "◆", color: HUD.text,     bg: "transparent",  label: "OUTPUT" },
  tool_call:   { icon: "⚡", color: HUD.tool,    bg: HUD.toolBg,     label: "CALL" },
  tool_result: { icon: "↩", color: HUD.result,   bg: HUD.resultBg,   label: "RESULT" },
  thinking:    { icon: "◈", color: HUD.thinking, bg: HUD.thinkingBg, label: "REASON" },
  spawn:       { icon: "⊕", color: HUD.spawn,    bg: HUD.goldSubtle, label: "SPAWN" },
  error:       { icon: "✕", color: HUD.error,    bg: HUD.errorBg,    label: "ERROR" },
};

// ── Session typology ────────────────────────────────────────
//
// One discriminator that the rest of the view uses to badge/style cards.
// More granular than session.kind ("main"|"subagent"|"other") because we
// also want to call out Claude Coder runs and external (MCP / ACP) sessions
// distinctly — they have different reliability and observability profiles.
type SessionType = "native" | "subagent" | "coder" | "external";

export const SESSION_TYPE_BADGES: Record<SessionType, { label: string; icon: string; color: string; tone: string; doc: string }> = {
  native:   { label: "NATIVE",  icon: "◆", color: HUD.gold,           tone: HUD.goldSubtle, doc: "Direct gateway chat session" },
  subagent: { label: "SUB",     icon: "↳", color: "#a78bfa",           tone: "color-mix(in srgb, #a78bfa 10%, transparent)", doc: "Spawned by a parent agent" },
  coder:    { label: "CODER",   icon: "⌘", color: "#60a5fa",           tone: "color-mix(in srgb, #60a5fa 10%, transparent)", doc: "Claude Coder CLI run" },
  external: { label: "EXTERNAL",icon: "✣", color: HUD.goldDim,         tone: "color-mix(in srgb, var(--g-fg-dim) 8%, transparent)", doc: "MCP / ACP / mobile or web bridge session" },
};

/** Detect the session type. Order matters — coder > subagent > external > native. */
export function getSessionType(session: AgentSession): SessionType {
  if (isClaudeCoder(session)) return "coder";
  if (session.kind === "subagent") return "subagent";
  const ch = (session.channel ?? "").toLowerCase();
  if (ch && ch !== "internal" && ch !== "webchat" && ch !== "gateway" && session.kind !== "main") {
    // mcp / acp / mobile / ios / android / telegram / discord / etc.
    return "external";
  }
  return "native";
}

// ── Coder backend badge resolution ──────────────────────────
//
// When a session is a coder run we replace the generic CODER badge with the
// brand-kit entry for the actual backend (claude-code / opencode / codex) so
// the activity card carries the right logo + accent. Falls back to the
// generic CODER badge for legacy rows that predate the `coderBackend` stamp.
type ResolvedBadge = {
  label: string;
  icon: TemplateResult | string;
  color: string;
  tone: string;
  doc: string;
};

function resolveCoderBrand(session: AgentSession): CoderBackendBrand | null {
  const id = (session.coderBackend ?? "") as CoderBackendId | "";
  if (id) return getCoderBackendBrand(id);
  // Display-name heuristics for legacy rows that haven't been re-stamped.
  if (session.displayName?.startsWith("OpenCode")) return getCoderBackendBrand("opencode");
  if (session.displayName?.startsWith("Codex")) return getCoderBackendBrand("codex");
  if (session.displayName?.startsWith("Claude Coder")) return getCoderBackendBrand("claude-code");
  return null;
}

/** Pick the badge to render for a session — per-backend brand for coder runs. */
function pickBadge(session: AgentSession, sessionType: SessionType): ResolvedBadge {
  if (sessionType === "coder") {
    const brand = resolveCoderBrand(session);
    if (brand) {
      return {
        label: brand.shortLabel,
        icon: brand.icon,
        color: brand.accent,
        tone: brand.tone,
        doc: `${brand.label} CLI run`,
      };
    }
  }
  return SESSION_TYPE_BADGES[sessionType];
}

// Agent colors per ID. Falls through to brand --g-primary for anything
// unmapped so the appearance picker still has reach.
const AGENT_COLORS: Record<string, string> = {
  main: "var(--g-primary)",
  webdev: "#60a5fa",
  qa: "#34d399",
  coder: "#a78bfa",
  opus: "#f472b6",
  "claude-code": "#60a5fa",
};
function agentColor(id: string): string { return AGENT_COLORS[id] || HUD.goldDim; }

/** Get best display name for a session — task-based for sub-agents */
function sessionTitle(session: AgentSession): string {
  if (session.kind === "subagent") {
    return session.label || session.displayName || session.derivedTitle || `Sub-agent ${session.agentId}`;
  }
  return session.agentName;
}

/** Get task/goal description */
function sessionGoal(session: AgentSession): string {
  if (session.kind === "subagent") {
    return session.derivedTitle || session.lastMessagePreview || "";
  }
  return session.derivedTitle || session.lastMessagePreview || session.label || "";
}

// ── Main Render ──────────────────────────────────────────────

/**
 * "Force complete" affordance — only renders for sessions that look
 * stuck: marked `active` but no events for > 5 minutes AND no
 * authoritative `completedViaEvent` from the gateway. Lets the user
 * pop the session out of "spinner-forever" purgatory when the chat
 * completion event was lost (WS drop, server restart, etc).
 *
 * Pure UI-side mark — the server-side session record is untouched.
 */
const STUCK_MS = 5 * 60 * 1000;
function renderForceCompleteAffordance(session: AgentSession, state: AppViewState) {
  if (!session.active) return nothing;
  if (session.completedViaEvent) return nothing;
  const last = session.updatedAt ?? 0;
  if (Date.now() - last < STUCK_MS) return nothing;
  return html`
    <button
      title="No events for ${timeAgo(last)}+ but session is still flagged active. Click to mark complete locally — won't affect the server-side record."
      @click=${(e: Event) => {
        e.stopPropagation();
        forceCompleteSession(state, session.key);
      }}
      style="
        margin-left: auto;
        padding: 1px 8px;
        background: transparent;
        border: 1px solid ${HUD.error};
        color: ${HUD.error};
        font-family: ${HUD.mono}; font-size: 9px;
        letter-spacing: 0.1em; font-weight: 700;
        cursor: pointer;
      "
    >✓ FORCE COMPLETE</button>
  `;
}

/**
 * Health badge — surfaces poll freshness + paused / refreshing / failure
 * state in one compact pill. Goes where the old "POLL Xs" label was, but
 * actually communicates *why* the feed might look stale.
 */
export function renderHealthBadge(as: AgentActivityState) {
  const lastOk = as.lastSuccessAt;
  const sinceOkMs = lastOk ? Date.now() - lastOk : Infinity;
  // Light escalates with staleness: green <60s, amber <5m, red beyond.
  const dot =
    sinceOkMs < 60_000 ? "var(--ok, #22c55e)" : sinceOkMs < 300_000 ? "var(--warn, #f59e0b)" : "var(--danger, #ef4444)";
  const ago = lastOk ? timeAgo(lastOk) : "";
  const label = lastOk ? (ago === "now" ? "Live · just now" : `Live · ${ago} ago`) : "Waiting…";
  const pill = (color: string) => `
    display:inline-flex; align-items:center; gap:7px; height:24px; padding:0 10px;
    border-radius:999px; white-space:nowrap;
    border:1px solid var(--glass-stroke, rgba(255,255,255,0.08));
    background:color-mix(in srgb, var(--glass-fg, #fff) 4%, transparent);
    font:500 10.5px/1 var(--mono, monospace); letter-spacing:0.04em; color:${color};
  `;

  if (as.paused) {
    return html`<span
      title="Tab is hidden — polling paused. Switch back to refresh."
      style=${pill("var(--glass-fg-3, var(--muted))")}
    ><span style="width:7px;height:7px;border-radius:50%;background:var(--glass-fg-3, var(--muted));"></span>Paused</span>`;
  }

  return html`<span
    title="${as.consecutiveFailures > 0
      ? `${as.consecutiveFailures} consecutive failed poll(s); last success ${lastOk ? timeAgo(lastOk) : "—"} ago`
      : "Background polling healthy"}"
    style=${pill(as.consecutiveFailures > 2 ? "var(--danger, #ef4444)" : "var(--glass-fg-2, var(--muted))")}
  >
    <span style="
      width:7px; height:7px; border-radius:50%; flex:none;
      background:${dot};
      box-shadow:0 0 0 3px color-mix(in srgb, ${dot} 18%, transparent), 0 0 10px ${dot};
      ${as.refreshing ? "animation: hud-pulse 1s infinite;" : ""}
    "></span>
    ${label}${as.consecutiveFailures > 0 ? html` <span style="color:var(--danger, #ef4444);">×${as.consecutiveFailures}</span>` : nothing}
  </span>`;
}

/**
 * Error banner — replaces the silent text-only error. Calls out the
 * failure count when it's escalated past a soft hiccup and offers a
 * one-click retry so the user isn't stuck waiting for the next interval.
 */
export function renderErrorBanner(
  state: AppViewState,
  client: GatewayBrowserClient,
  as: AgentActivityState,
) {
  const repeated = as.consecutiveFailures > 1;
  return html`
    <div role="alert" style="
      display:flex; align-items:center; gap:12px; flex-shrink:0;
      padding:10px 12px 10px 14px; border-radius:14px;
      background:var(--danger-subtle, rgba(239,68,68,0.1));
      border:1px solid color-mix(in srgb, var(--danger, #ef4444) 35%, transparent);
      color:var(--danger, #ef4444); font-size:12.5px; line-height:1.4;
      font-family:var(--glass-font, inherit);
    ">
      <span style="
        width:8px; height:8px; border-radius:50%; flex:none; background:var(--danger, #ef4444);
        box-shadow:0 0 0 3px color-mix(in srgb, var(--danger, #ef4444) 18%, transparent), 0 0 10px var(--danger, #ef4444);
      "></span>
      <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
        ${repeated
          ? html`<strong>×${as.consecutiveFailures}</strong> ${as.error}`
          : html`${as.error}`}
        ${as.lastSuccessAt
          ? html`<span style="color:var(--glass-fg-3, var(--muted)); margin-left:8px; font:500 10.5px var(--mono, monospace);">
              last ok ${timeAgo(as.lastSuccessAt)} ago
            </span>`
          : nothing}
      </span>
      <button
        ?disabled=${as.loading}
        @click=${() => { void retryActivityLoad(state, client); }}
        style="
          flex:none; height:30px; padding:0 14px; border-radius:999px; cursor:pointer;
          background:color-mix(in srgb, var(--danger, #ef4444) 12%, transparent);
          border:1px solid color-mix(in srgb, var(--danger, #ef4444) 45%, transparent);
          color:var(--danger, #ef4444); font:600 12px/1 var(--glass-font, inherit);
        "
      >${as.loading ? "Retrying…" : "Retry"}</button>
    </div>
  `;
}

// ── Focused Chat Modal ────────────────────────────────────────

function modalStepIcon(type: string): string {
  return type === "user" ? "▸" : type === "tool_call" ? "⚡" : type === "tool_result" ? "↩" : type === "thinking" ? "◈" : type === "error" ? "✕" : type === "spawn" ? "⊕" : "◆";
}
function modalStepColor(type: string): string {
  return type === "user" ? HUD.user : type === "tool_call" ? HUD.tool : type === "tool_result" ? HUD.result : type === "thinking" ? HUD.thinking : type === "error" ? HUD.error : type === "spawn" ? HUD.spawn : HUD.text;
}

function buildTranscriptMarkdown(title: string, steps: import("../controllers/agent-activity").AgentStep[]): string {
  const lines: string[] = [`# Transcript: ${title}`, `_Exported ${new Date().toISOString()}_`, ""];
  for (const step of steps) {
    const ts = step.timestamp ? new Date(step.timestamp).toLocaleTimeString() : "";
    if (step.type === "user") {
      lines.push(`## User  ${ts}`, step.content, "");
    } else if (step.type === "text") {
      lines.push(`## Assistant  ${ts}`, step.content, "");
    } else if (step.type === "tool_call") {
      lines.push(`### Tool Call: \`${step.content}\`  ${ts}`, step.detail ? "```\n" + step.detail + "\n```" : "", "");
    } else if (step.type === "tool_result") {
      lines.push(`### Tool Result: \`${step.detail ?? ""}\`  ${ts}`, step.content ? "```\n" + step.content + "\n```" : "", "");
    } else if (step.type === "thinking") {
      lines.push(`_Thinking:_ ${step.content}`, "");
    } else if (step.type === "error") {
      lines.push(`> **Error:** ${step.content}`, "");
    } else {
      lines.push(step.content, "");
    }
  }
  return lines.join("\n");
}

function downloadTranscript(title: string, steps: import("../controllers/agent-activity").AgentStep[]): void {
  const md = buildTranscriptMarkdown(title, steps);
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `transcript-${title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}-${Date.now()}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function copyToClipboard(text: string): void {
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text);
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

// ── Glass icons (inline, stroke = currentColor) ───────────────
const svgIcon = (d: TemplateResult) => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC_CLOSE = svgIcon(svg`<path d="M18 6 6 18M6 6l12 12"/>`);
const IC_COPY = svgIcon(svg`<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>`);
const IC_DOWNLOAD = svgIcon(svg`<path d="M12 3v12m0 0-4-4m4 4 4-4M4 19h16"/>`);
const IC_SEND = svgIcon(svg`<path d="M5 12h14m0 0-6-6m6 6-6 6"/>`);
const IC_SYNC = svgIcon(svg`<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16m0 5v-5h5M3 12a9 9 0 0 1 15.4-6.4L21 8m0-5v5h-5"/>`);
const IC_SPARK = svgIcon(svg`<path d="M12 3v4m0 10v4M3 12h4m10 0h4M6.3 6.3l2.8 2.8m5.8 5.8 2.8 2.8m0-11.4-2.8 2.8m-5.8 5.8-2.8 2.8"/>`);
const IC_CHAT = svgIcon(svg`<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>`);

function renderModalStep(
  step: import("../controllers/agent-activity").AgentStep,
  showAllTools: boolean,
  _stepIndex: number,
  _state: AppViewState,
) {
  const icon = modalStepIcon(step.type);
  const ts = step.timestamp ? new Date(step.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const copyBtn = (text: string, prevent = false) => html`<button
    class="gaa-copy"
    title="Copy"
    aria-label="Copy"
    @click=${(e: Event) => { if (prevent) e.preventDefault(); e.stopPropagation(); copyToClipboard(text); }}
  >${IC_COPY}</button>`;

  // User message — gold glass bubble, right aligned
  if (step.type === "user") {
    return html`
      <div class="gaa-msg" data-role="user">
        <div class="gaa-bubble">${step.content}${copyBtn(step.content)}</div>
        <span class="gaa-meta">${ts}</span>
      </div>
    `;
  }

  // Tool call / result — collapsible details card
  if (step.type === "tool_call" || step.type === "tool_result") {
    const headerText = step.type === "tool_call"
      ? `${icon} ${step.content}`
      : `${icon} Result · ${step.detail ?? ""}`;
    const bodyText = step.type === "tool_call" ? (step.detail ?? "") : (step.content ?? "");
    return html`
      <div class="gaa-tool-wrap">
        <details class="gaa-tool" data-kind=${step.type === "tool_call" ? "call" : "result"} ?open=${showAllTools}>
          <summary>
            <span class="gaa-tool-name">${headerText}</span>
            <span class="gaa-meta">${ts}</span>
            ${copyBtn(bodyText, true)}
          </summary>
          ${bodyText ? html`<pre>${bodyText}</pre>` : nothing}
        </details>
      </div>
    `;
  }

  // Thinking — italic muted block with a gold rule
  if (step.type === "thinking") {
    return html`<div class="gaa-think">${icon} ${truncate(step.content, 800)}</div>`;
  }

  // Error
  if (step.type === "error") {
    return html`<div class="gaa-step-err" role="alert">${icon} ${step.content}</div>`;
  }

  // Assistant text — left-aligned glass bubble
  return html`
    <div class="gaa-msg" data-role="assistant">
      <div class="gaa-bubble">${step.content}${copyBtn(step.content)}</div>
      <span class="gaa-meta">${step.model ? html`${step.model} · ` : nothing}${ts}</span>
    </div>
  `;
}

export function renderChatModal(
  state: AppViewState,
  client: GatewayBrowserClient,
  as: import("../controllers/agent-activity").AgentActivityState,
) {
  if (!as.modalKey) return nothing;

  const session = as.sessions.find((s) => s.key === as.modalKey);
  const title = session ? sessionTitle(session) : as.modalKey;
  const sessionType = session ? getSessionType(session) : "native";
  const badge = session ? pickBadge(session, sessionType) : SESSION_TYPE_BADGES[sessionType];
  const isActive = session?.active ?? false;
  const isComplete = session?.completedViaEvent ?? false;
  const isError = session?.completionState === "error";
  const duration = session?.updatedAt && session.steps.length > 0
    ? `${Math.round((session.updatedAt - (session.steps[0]?.timestamp ?? session.updatedAt)) / 1000)}s`
    : null;

  // Status chip text + light
  let statusText = "Idle";
  let statusLight: "ok" | "danger" | "idle" = "idle";
  if (isActive) { statusText = "Live"; statusLight = "ok"; }
  else if (isError) { statusText = "Error"; statusLight = "danger"; }
  else if (isComplete) { statusText = "Done"; statusLight = "ok"; }

  const toolStepCount = as.modalSteps.filter(s => s.type === "tool_call").length;

  // Auto-scroll hook via a ref-like side-effect in the template
  // (called after render via setTimeout to run after DOM update)
  if (!as.modalLoading && as.modalSteps.length > 0) {
    setTimeout(() => scrollModalToBottom(), 0);
  }

  const send = () => {
    if (as.modalDraft.trim() && !as.modalSending && as.modalKey) {
      void sendModalMessage(state, client, as.modalKey, as.modalDraft);
    }
  };

  return html`
    ${activityGlassStyle(ACTIVITY_MODAL_CSS)}
    <!-- Backdrop -->
    <div class="gaa-modal-backdrop" @click=${() => closeChatModal(state)}></div>

    <!-- Modal panel -->
    <div class="gaa-modal gt-scope" role="dialog" aria-modal="true" aria-label=${`Conversation: ${title}`}
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeChatModal(state); } }}
    >
      <!-- Header -->
      <div class="gaa-modal-head">
        <div class="gaa-modal-title-wrap">
          <div class="gaa-modal-eyebrow">
            <span class="gt-chip gaa-modal-badge" data-tone="gold" title=${badge.doc}>${badge.icon} ${badge.label}</span>
            <span class="gt-chip">
              <span class="gt-light" data-state=${statusLight} ?data-pulse=${isActive}></span>${statusText}
            </span>
            <!-- Node badge — flags which federation peer the session is
                 actually running on. Helps the operator confirm they're
                 driving the right device before sending input. -->
            ${session ? renderNodeBadge(session) : nothing}
            ${duration ? html`<span class="gaa-modal-dur">${duration}</span>` : nothing}
          </div>
          <h2 class="gaa-modal-title" title=${title}>${truncate(title, 60)}</h2>
        </div>
        <!-- Close -->
        <button class="gaa-icon-btn" title="Close (run continues)" aria-label="Close conversation"
          @click=${() => closeChatModal(state)}>${IC_CLOSE}</button>
      </div>

      <!-- Toolbar: toggle + download -->
      <div class="gaa-modal-tools">
        ${toolStepCount > 0 ? html`
          <button class="gt-btn" aria-pressed=${as.modalShowAllTools ? "true" : "false"}
            @click=${() => {
              as.modalShowAllTools = !as.modalShowAllTools;
              state.requestUpdate?.();
            }}
          >${as.modalShowAllTools ? "Collapse tools" : "Expand tools"} · ${toolStepCount}</button>
        ` : nothing}
        <button class="gt-btn" @click=${() => downloadTranscript(title, as.modalSteps)}>${IC_DOWNLOAD} Download .md</button>
        <span class="gaa-modal-count">
          ${as.modalSteps.length} steps
          ${as.modalSending ? html`<span class="gaa-modal-sending"><span class="gt-light" data-state="gold" data-pulse></span> Sending…</span>` : nothing}
        </span>
      </div>

      <!-- Body: transcript -->
      <div id="infinibot-modal-scroll-body" class="gaa-modal-body">
        ${as.modalLoading && as.modalSteps.length === 0 ? html`
          <div class="gaa-modal-skel" aria-busy="true" aria-label="Loading conversation">
            ${[0, 1, 2, 3, 4].map(() => html`<div class="gt-skel"></div>`)}
          </div>
        ` : nothing}

        ${!as.modalLoading && as.modalSteps.length === 0 ? html`
          <div class="gaa-empty-session">${glassEmpty({
            title: "No messages yet",
            sub: isActive
              ? "This run hasn't said anything yet. Send it a message below, or wait for its first step."
              : "This session is empty. Send a message below to continue the conversation.",
            icon: IC_CHAT,
          })}</div>
        ` : nothing}

        ${as.modalSteps.map((step, i) => renderModalStep(step, as.modalShowAllTools, i, state))}

        <!-- Live streaming response -->
        ${as.modalStream !== null ? html`
          <div class="gaa-msg" data-role="assistant">
            <div class="gaa-bubble" data-streaming>${as.modalStream || html`<span class="gaa-caret"></span>`}</div>
          </div>
        ` : nothing}

        <!-- Spacer so last message isn't flush against composer -->
        <div style="height:8px;"></div>
      </div>

      <!-- Error banner -->
      ${as.modalError ? html`
        <div class="gaa-modal-error" role="alert">
          <span class="gt-light" data-state="danger"></span>
          <span>${as.modalError}</span>
          <button class="gaa-icon-btn" aria-label="Dismiss error"
            @click=${() => { as.modalError = null; state.requestUpdate?.(); }}>${IC_CLOSE}</button>
        </div>
      ` : nothing}

      <!-- Composer -->
      <div class="gaa-composer">
        <textarea
          class="gt-input"
          .value=${as.modalDraft}
          placeholder=${isActive ? "Send a message…" : "Continue conversation (may start a new context)…"}
          aria-label="Message"
          rows="2"
          ?disabled=${as.modalSending}
          @input=${(e: Event) => {
            as.modalDraft = (e.target as HTMLTextAreaElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        ></textarea>
        <button
          class="gt-btn gt-primary"
          ?disabled=${as.modalSending || !as.modalDraft.trim()}
          @click=${send}
        >${as.modalSending ? "Sending…" : html`Send ${IC_SEND}`}</button>
      </div>
    </div>
  `;
}

export function renderAgentActivity(state: AppViewState, client: GatewayBrowserClient) {
  const as = state.agentActivityState;
  if (!as) {
    return html`
      ${activityGlassStyle(ACTIVITY_PAGE_CSS)}
      <div class="gaa-page gt-scope" aria-busy="true">
        ${glassAurora()}
        <header class="gt-hero">
          <div>
            <span class="gt-eyebrow">Agents · Live telemetry</span>
            <h1 class="gt-title">Activity</h1>
            <p class="gt-sub">Connecting to the activity feed…</p>
          </div>
        </header>
        ${glassSkeletonCards(4)}
      </div>
    `;
  }

  // Idempotent: wires the global "infinibot:subagent-open-detail" CustomEvent
  // from any <subagent-activity-panel> card to the shared modal.
  if (client) mountSubagentDetailListener(client, () => state.requestUpdate?.());

  const activeSessions = as.sessions.filter((s) => s.active);
  const subagentSessions = as.sessions.filter((s) => s.kind === "subagent");
  const coderSessions = as.sessions.filter((s) => isClaudeCoder(s));
  const externalSessions = as.sessions.filter((s) => getSessionType(s) === "external");
  const nativeSessions = as.sessions.filter((s) => getSessionType(s) === "native");
  const doneToday = getRecentlyCompletedTodayCount();

  // Per-backend breakdown of coder sessions, in the canonical order, dropping
  // backends that aren't currently represented so the header stays compact.
  const coderBreakdown = ALL_CODER_BACKEND_IDS.map((id) => ({
    brand: getCoderBackendBrand(id),
    count: coderSessions.filter((s) => (resolveCoderBrand(s)?.id ?? null) === id).length,
  })).filter((row) => row.count > 0);
  const coderWithoutBrand =
    coderSessions.length - coderBreakdown.reduce((sum, row) => sum + row.count, 0);

  const toggleCoder = () => { as.showCoderOnly = !as.showCoderOnly; state.requestUpdate?.(); };
  const filters: Array<{ key: "showActiveOnly" | "showSubagentsOnly" | "showCoderOnly"; label: string; title: string }> = [
    { key: "showActiveOnly", label: "Live", title: "Only running agents that emitted an event in the last 5 minutes" },
    { key: "showSubagentsOnly", label: "Subs", title: "Only sub-agents" },
    { key: "showCoderOnly", label: "Coder", title: "Only coder runs (Claude Code / OpenCode / Codex)" },
  ];

  return html`
    ${activityGlassStyle(ACTIVITY_PAGE_CSS)}
    ${activityGlassStyle(ACTIVITY_DASH_CSS, { primitives: false })}
    <div class="gaa-page gt-scope">
      ${glassAurora()}

      <!-- Header -->
      <header class="gt-hero" data-learn-id="activity-header">
        <div class="gaa-hero-copy">
          <span class="gt-eyebrow">Agents · Live telemetry</span>
          <h1 class="gt-title">Activity</h1>
          <p class="gt-sub">Every agent, sub-agent and coder run as it happens — progress, completions and the work still queued.</p>
        </div>
        <div class="gaa-hero-side">
          <div class="gt-stat gt-glass">
            <span class="gt-stat-value gaa-stat-row">
              <span class="gt-light" data-state=${activeSessions.length > 0 ? "ok" : "idle"} ?data-pulse=${activeSessions.length > 0}></span>${activeSessions.length}
            </span>
            <span class="gt-stat-label">Live now</span>
          </div>
          <div class="gt-stat gt-glass">
            <span class="gt-stat-value">${as.sessions.length}</span>
            <span class="gt-stat-label">Sessions</span>
          </div>
          <div class="gt-stat gt-glass">
            <span class="gt-stat-value">${doneToday}</span>
            <span class="gt-stat-label">Done today</span>
          </div>
        </div>
      </header>

      <!-- Toolbar: session mix + filters + poll + sync -->
      <section class="gaa-toolbar gt-glass" aria-label="Activity filters">
        <div class="gaa-breakdown">
          <span class="gt-chip" title=${SESSION_TYPE_BADGES.native.doc}>
            <span class="gaa-chip-glyph">${SESSION_TYPE_BADGES.native.icon}</span><span class="gaa-chip-num">${nativeSessions.length}</span> Native
          </span>
          <span class="gt-chip" title=${SESSION_TYPE_BADGES.subagent.doc}>
            <span class="gaa-chip-glyph">${SESSION_TYPE_BADGES.subagent.icon}</span><span class="gaa-chip-num">${subagentSessions.length}</span> Sub
          </span>
          <!-- Coder counter: one entry per active backend with the right
               logo. Clicking any one toggles the coder filter; legacy rows
               without a backend stamp roll into the generic CODER counter. -->
          ${coderBreakdown.map(
            (row) => html`
              <button type="button" class="gt-chip gaa-chip-btn" aria-pressed=${as.showCoderOnly ? "true" : "false"}
                title="Toggle filter to ${row.brand.label} runs" @click=${toggleCoder}
              ><span class="gaa-chip-glyph">${row.brand.icon}</span><span class="gaa-chip-num">${row.count}</span> ${row.brand.shortLabel}</button>
            `,
          )}
          ${coderWithoutBrand > 0 ? html`
            <button type="button" class="gt-chip gaa-chip-btn" aria-pressed=${as.showCoderOnly ? "true" : "false"}
              title="Toggle filter to coder runs" @click=${toggleCoder}
            ><span class="gaa-chip-glyph">${SESSION_TYPE_BADGES.coder.icon}</span><span class="gaa-chip-num">${coderWithoutBrand}</span> Coder</button>
          ` : nothing}
          ${externalSessions.length > 0 ? html`
            <span class="gt-chip" title=${SESSION_TYPE_BADGES.external.doc}>
              <span class="gaa-chip-glyph">${SESSION_TYPE_BADGES.external.icon}</span><span class="gaa-chip-num">${externalSessions.length}</span> External
            </span>
          ` : nothing}
          ${renderHealthBadge(as)}
        </div>

        <div class="gaa-controls">
          <div class="gt-seg" role="group" aria-label="Filter running agents">
            ${filters.map((f) => html`
              <button type="button" title=${f.title} aria-pressed=${as[f.key] ? "true" : "false"}
                @click=${() => { as[f.key] = !as[f.key]; state.requestUpdate?.(); }}
              >${f.label}</button>
            `)}
          </div>
          <label class="gaa-poll" title="Polling interval">
            <span>Poll</span>
            <select
              class="gt-input gaa-select"
              aria-label="Polling interval"
              .value=${String(as.pollInterval)}
              @change=${(e: Event) => {
                as.pollInterval = parseInt((e.target as HTMLSelectElement).value) || 5;
                restartActivityPolling(state, client);
                state.requestUpdate?.();
              }}
            >
              ${[3, 5, 10, 30].map((v) => html`<option value=${String(v)} ?selected=${as.pollInterval === v}>${v}s</option>`)}
            </select>
          </label>
          <button
            class="gt-btn gt-primary gaa-sync"
            ?disabled=${as.loading}
            ?data-busy=${as.loading}
            @click=${async () => {
              await loadAgentActivity(state, client);
              state.requestUpdate?.();
            }}
          >${IC_SYNC} ${as.loading ? "Syncing…" : "Sync"}</button>
        </div>
      </section>

      <!-- Error banner with retry -->
      ${as.error ? renderErrorBanner(state, client, as) : nothing}

      <!-- Persistent queue lifecycle strip (queue.* events, gold accent) -->
      <div class="gaa-slot" data-learn-id="activity-queue-strip">
        <queue-activity-strip></queue-activity-strip>
      </div>

      <!-- Top running-agent feed: live view of currently running sub-agents. -->
      ${client ? html`
        <div class="gaa-slot">
          <subagent-activity-panel
            .gateway=${client}
            .pollIntervalMs=${3000}
            .limit=${10}
            .liveSessions=${new Map(as.sessions.map((s) => [s.key, s]))}
          ></subagent-activity-panel>
        </div>
      ` : nothing}

      <!-- Spawn Notifications -->
      ${renderSpawnNotifications(as, state)}

      <!-- Agent Activity Dashboard -->
      <div class="gaa-body">
        ${client ? html`
          <div class="gaa-credit">
            <credit-usage-breakdown ${ref(installActivityTokenGlass)} .client=${client}></credit-usage-breakdown>
          </div>
        ` : nothing}
        ${renderAgentDashboard({
          as,
          kanbanTasks: state.kanbanTasks ?? [],
          kanbanProjects: state.kanbanProjects ?? [],
          client,
          state,
          onNavigateToKanban: (projectId: string) => {
            state.kanbanSelectedProjectId = projectId;
            state.setTab?.("kanban" as never);
            state.requestUpdate?.();
          },
        })}
        ${renderMeshSection(as)}
      </div>
    </div>

    <!-- Focused Chat Modal — rendered outside the main scroll container -->
    ${as.modalKey ? renderChatModal(state, client, as) : nothing}

    <!--
      Sub-agent Detail Modal is mounted globally from app-render.ts so it
      layers above every view (chat, activity, etc).  The local listener
      mount above is kept as a safety net in case Activity is the first
      view rendered before the global mount runs.
    -->

    <style>
      @keyframes hud-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      @keyframes hud-slide {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes hud-fade {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes hud-progress {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        @keyframes hud-pulse { from { opacity: 1; } to { opacity: 1; } }
        @keyframes hud-fade { from { opacity: 1; } to { opacity: 1; } }
      }
      details summary::-webkit-details-marker { display: none; }
    </style>
  `;
}

// ── Mesh messages (cross-node) ───────────────────────────────

function renderMeshSection(as: AgentActivityState) {
  const messages = as.meshMessages || [];
  if (messages.length === 0) return nothing;

  const recent = messages.slice(0, 10);

  return html`
    <section class="ga-panel gaa-mesh" aria-label="Mesh messages">
      <div class="gaa-mesh-head">
        <h3 class="ga-section-head">Mesh · ${messages.length} messages</h3>
        ${as.lastMeshFetchAt ? html`<span class="gaa-mesh-sync">Synced ${timeAgo(as.lastMeshFetchAt)}</span>` : nothing}
      </div>
      <div class="gaa-mesh-list">
        ${recent.map((m) => html`
          <div class="ga-card gaa-mesh-row" ?data-read=${m.read}>
            <span class="gaa-mesh-glyph">⇄</span>
            <div class="gaa-mesh-main">
              <div class="gaa-mesh-line">
                <span class="gaa-mesh-from">${truncate(m.from, 24)}</span>
                <span class="gaa-mesh-arrow">→</span>
                <span class="gaa-mesh-to">${truncate(m.to, 24)}</span>
                <span class="gt-chip gaa-mesh-type" data-tone="gold">${m.type}</span>
                <span class="gaa-mesh-time">
                  ${m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}
                </span>
              </div>
              ${m.payload?.message || m.payload?.action ? html`
                <div class="gaa-mesh-msg">${truncate(m.payload.message || m.payload.action || "", 140)}</div>
              ` : nothing}
            </div>
          </div>
        `)}
      </div>
    </section>
  `;
}

// ── Spawn Notifications ──────────────────────────────────────

function renderSpawnNotifications(as: AgentActivityState, state: AppViewState) {
  const active = as.spawnNotifications.filter((n) => !n.dismissed);
  if (active.length === 0) return nothing;

  return html`
    <div class="gaa-toasts" role="status" aria-live="polite">
      ${active.map((n) => renderSpawnNotification(n, state))}
    </div>
  `;
}

function renderSpawnNotification(n: SpawnNotification, state: AppViewState) {
  return html`
    <div class="gaa-toast">
      <span class="gaa-toast-orb">${IC_SPARK}</span>
      <div class="gaa-toast-main">
        <div class="gaa-toast-title">Agent spawned</div>
        <div class="gaa-toast-line"><b>${n.agentId}</b> ← ${n.parentAgent}</div>
        ${n.task ? html`<div class="gaa-toast-task">${truncate(n.task, 80)}</div>` : nothing}
      </div>
      <button class="gaa-icon-btn" aria-label="Dismiss"
        @click=${() => { dismissSpawnNotification(state, n.id); state.requestUpdate?.(); }}>${IC_CLOSE}</button>
    </div>
  `;
}

// ── Two-section layout helpers ───────────────────────────────

/** Top section: rich cards for sessions that are actively streaming live events. */
function renderLiveSection(
  sessions: AgentSession[],
  as: AgentActivityState,
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  if (sessions.length === 0) {
    return html`
      <div style="
        display:flex; align-items:center; gap:10px;
        padding:12px 16px; margin-bottom:12px;
        border:1px dashed ${HUD.border};
        font-family:${HUD.mono}; font-size:10px; letter-spacing:0.1em; color:${HUD.textDim};
      ">
        <span>◌</span>
        <span>NO LIVE STREAMS — ACTIVE AGENTS WILL APPEAR HERE AS THEY EMIT EVENTS</span>
      </div>
    `;
  }
  return html`
    <div style="margin-bottom:20px;">
      <div style="
        display:flex; align-items:center; gap:8px;
        padding-bottom:8px; border-bottom:1px solid ${HUD.goldBorder}; margin-bottom:12px;
      ">
        <span style="
          display:inline-block; width:6px; height:6px; border-radius:50%; flex-shrink:0;
          background:${HUD.active}; box-shadow:0 0 6px ${HUD.activeGlow};
          animation:hud-pulse 2s infinite;
        "></span>
        <span style="font-size:9px; font-weight:700; color:${HUD.gold}; letter-spacing:0.15em;">LIVE AGENTS</span>
        <span style="
          font-size:8px; padding:1px 6px;
          border:1px solid ${HUD.active}; color:${HUD.active};
          letter-spacing:0.08em;
        ">${sessions.length}</span>
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(440px, 1fr)); gap:12px; padding-bottom:4px;">
        ${sessions.map(session => isClaudeCoder(session)
          ? renderCoderTerminalCard(session, state, client, as)
          : renderAgentCard(session, as, state, client))}
      </div>
    </div>
  `;
}

/** Bottom section: compact one-line rows for non-streaming / detached sessions. */
function renderBackgroundSection(
  sessions: AgentSession[],
  as: AgentActivityState,
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  if (sessions.length === 0) return nothing;
  const collapsed = as.bgCollapsed ?? false;
  return html`
    <div style="margin-bottom:20px;">
      <!-- Section header — click to collapse/expand -->
      <div style="
        display:flex; align-items:center; gap:8px; cursor:pointer;
        padding-bottom:8px; margin-bottom:${collapsed ? 0 : 8}px;
        border-bottom:1px solid ${HUD.border};
        user-select:none;
      " @click=${() => toggleBgCollapsed(state)}>
        <span style="font-size:9px; font-weight:700; color:${HUD.textMuted}; letter-spacing:0.15em;">
          BACKGROUND TASKS
        </span>
        <span style="
          font-size:8px; padding:1px 6px;
          border:1px solid ${HUD.border}; color:${HUD.textDim};
          letter-spacing:0.08em;
        ">${sessions.length}</span>
        <span style="margin-left:auto; font-size:9px; color:${HUD.textDim}; letter-spacing:0.06em;">
          ${collapsed ? "▶ EXPAND" : "▼ COLLAPSE"}
        </span>
      </div>
      ${collapsed ? nothing : html`
        <div style="display:flex; flex-direction:column; gap:2px;">
          ${sessions.map(s => renderCompactRow(s, as, state, client))}
        </div>
      `}
    </div>
  `;
}

/** A single compact row for a background (non-streaming) session. */
function renderCompactRow(session: AgentSession, as: AgentActivityState, state: AppViewState, client: GatewayBrowserClient) {
  const isPinnedLive = as.pinnedToLive?.has(session.key) ?? false;
  const label = session.label || session.displayName || session.derivedTitle || session.agentName;

  // Last meaningful log line
  const lastStep = session.steps.length > 0 ? session.steps[session.steps.length - 1] : null;
  const lastLog = lastStep
    ? truncate((lastStep.content || "").replace(/\s+/g, " "), 60)
    : session.lastMessagePreview ? truncate(session.lastMessagePreview, 60) : "";

  // Status pill
  let statusColor = HUD.textDim;
  let statusLabel = "IDLE";
  if (session.completedViaEvent && session.completionState === "error") {
    statusColor = HUD.error; statusLabel = "ERROR";
  } else if (session.completedViaEvent) {
    statusColor = HUD.active; statusLabel = "DONE";
  } else if (session.active) {
    statusColor = "#fbbf24"; statusLabel = "RUNNING";
  }

  // Type icon
  const isCoderSess = isClaudeCoder(session);
  const typeIcon = isCoderSess ? "⌘" : session.kind === "subagent" ? "↳" : "◆";
  const typeColor = isCoderSess ? "#60a5fa" : session.kind === "subagent" ? "#a78bfa" : HUD.goldMuted;

  return html`
    <div style="
      display:flex; align-items:center; gap:8px;
      min-height:38px; padding:0 12px;
      background:${HUD.bgCard}; border:1px solid ${HUD.border};
      font-family:${HUD.mono}; font-size:10px;
      transition:background 0.1s; cursor:pointer;
    "
      @mouseenter=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = HUD.bgHover; }}
      @mouseleave=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = HUD.bgCard; }}
      @click=${() => { void openChatModal(state, client, session.key); }}
    >
      <!-- Type icon -->
      <span style="color:${typeColor}; flex-shrink:0; font-size:10px; width:14px; text-align:center;">
        ${typeIcon}
      </span>

      <!-- Status pill -->
      <span style="
        flex-shrink:0; font-size:8px; font-weight:700; letter-spacing:0.1em;
        padding:1px 6px; border:1px solid ${statusColor}; color:${statusColor};
        min-width:52px; text-align:center;
      ">${statusLabel}</span>

      <!-- Label -->
      <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${HUD.text};">
        ${truncate(label, 55)}
      </span>

      <!-- Last log (truncated ~60 chars) -->
      ${lastLog ? html`
        <span style="
          flex:0 0 240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
          color:${HUD.textDim}; font-size:9px;
        " title="${lastLog}">${lastLog}</span>
      ` : nothing}

      <!-- Time ago -->
      <span style="flex-shrink:0; color:${HUD.textDim}; font-size:9px; min-width:40px; text-align:right;">
        ${timeAgo(session.updatedAt)}
      </span>

      <!-- Open chat modal (compact row) -->
      <button
        title="Open full conversation in focused chat modal"
        @click=${(e: Event) => {
          e.stopPropagation();
          void openChatModal(state, client, session.key);
        }}
        style="
          flex-shrink:0; background:none;
          border:1px solid ${HUD.goldBorder};
          color:${HUD.goldDim};
          cursor:pointer; font-family:${HUD.mono};
          font-size:8px; padding:2px 7px; letter-spacing:0.05em;
          transition:all 0.1s;
        "
      >⤢ OPEN</button>

      <!-- Pin to Live button -->
      <button
        title="${isPinnedLive ? "Unpin (restore auto-classification)" : "Pin to Live Agents section"}"
        @click=${(e: Event) => {
          e.stopPropagation();
          isPinnedLive ? unpinSession(state, session.key) : pinToLive(state, session.key);
        }}
        style="
          flex-shrink:0; background:none;
          border:1px solid ${isPinnedLive ? HUD.active : HUD.border};
          color:${isPinnedLive ? HUD.active : HUD.textDim};
          cursor:pointer; font-family:${HUD.mono};
          font-size:8px; padding:2px 7px; letter-spacing:0.05em;
          transition:all 0.1s;
        "
      >${isPinnedLive ? "✕ UNPIN" : "⬆ LIVE"}</button>
    </div>
  `;
}

// ── Session Summary ──────────────────────────────────────────

function getSessionSummary(session: AgentSession): string {
  if (session.lastMessagePreview) return session.lastMessagePreview;
  if (session.derivedTitle) return session.derivedTitle;
  if (session.label) return session.label;
  if (session.steps.length > 0) {
    const lastStep = session.steps[session.steps.length - 1];
    return lastStep.content;
  }
  return "";
}

// ── Agent Card ───────────────────────────────────────────────

/**
 * Hash a node id to a stable hue so every federation peer gets its own
 * colour. Used by the node badge on agent cards + modal header.
 */
function nodeIdHue(nodeId: string): number {
  let h = 0;
  for (let i = 0; i < nodeId.length; i++) h = (Math.imul(31, h) + nodeId.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function renderNodeBadge(
  session: Pick<AgentSession, "node" | "nodeId" | "remote">,
  opts: { compact?: boolean } = {},
): TemplateResult | typeof nothing {
  // Only badge sessions that are explicitly remote OR have a non-local
  // node name. Local sessions stay clean to avoid badge spam.
  const isRemote = Boolean(session.remote);
  const nodeName = session.node ?? "";
  if (!isRemote && (!nodeName || nodeName === "local" || nodeName === "")) return nothing;
  const idForHue = session.nodeId || nodeName || "remote";
  const hue = nodeIdHue(idForHue);
  const fg = `hsl(${hue}, 80%, 70%)`;
  const bg = `hsla(${hue}, 80%, 50%, 0.12)`;
  const border = `hsla(${hue}, 80%, 60%, 0.45)`;
  const label = (nodeName || idForHue).toUpperCase().slice(0, 16);
  return html`
    <span
      title=${`Running on ${nodeName || idForHue}`}
      style="
        display:inline-flex; align-items:center; gap:3px;
        border:1px solid ${border};
        background:${bg};
        color:${fg};
        font-size:${opts.compact ? "7px" : "8px"};
        padding:${opts.compact ? "1px 5px" : "1px 6px"};
        font-weight:700;
        letter-spacing:0.1em;
        border-radius:3px;
        text-transform:uppercase;
      "
    >🛰 ${label}</span>
  `;
}

function renderAgentCard(
  session: AgentSession,
  as: AgentActivityState,
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const sessionType = getSessionType(session);
  const badge = pickBadge(session, sessionType);
  const isExpanded = session.expanded;
  const title = sessionTitle(session);
  const goal = sessionGoal(session);
  const progress = estimateProgress(session);
  const isSub = sessionType === "subagent";
  const color = agentColor(session.agentId);
  const stepCount = session.steps.length;
  const toolCalls = session.steps.filter((s) => s.type === "tool_call").length;
  const summary = getSessionSummary(session);

  // Remote sessions get a per-node coloured left edge so the eye picks
  // them out of a busy feed without reading the badge text.
  const remoteAccent = session.remote
    ? `border-left: 3px solid hsl(${nodeIdHue(session.nodeId || session.node || "remote")}, 80%, 60%);`
    : "";
  return html`
    <div class="glass-deep lift-on-hover" style="
      ${remoteAccent || (isSub ? `border-left: 3px solid color-mix(in srgb, ${color} 60%, transparent);` : "")}
      ${session.active ? `--g-glow-primary: 0 0 28px color-mix(in srgb, var(--g-primary) 28%, transparent);` : ""}
      animation: hud-fade 0.2s ease;
    ">
      <!-- Card Header -->
      <div style="
        padding: 12px 14px; display: flex; align-items: flex-start; gap: 10px; cursor: pointer;
        border-bottom: 1px solid ${isExpanded ? HUD.border : "transparent"};
        transition: background 0.1s ease;
      " @click=${() => {
        session.expanded = !session.expanded;
        if (session.expanded && !session.previewLoaded) {
          void loadSessionHistory(state, client, session.key);
        }
        state.requestUpdate?.();
      }}
        @mouseenter=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = HUD.bgHover; }}
        @mouseleave=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <!-- Status dot -->
        <div style="
          width:6px; height:6px; flex-shrink:0; margin-top:5px;
          background: ${session.active ? HUD.active : HUD.textDim};
          ${session.active ? `box-shadow: 0 0 6px ${HUD.activeGlow}; animation: hud-pulse 2s infinite;` : ""}
        "></div>

        <!-- Agent info -->
        <div style="flex:1; min-width:0;">
          <!-- Title + badges -->
          <div style="display:flex; align-items:center; gap:6px; margin-bottom:2px; flex-wrap:wrap;">
            <span style="font-weight:600; font-size:12px; color:${session.active ? color : HUD.text}; letter-spacing:0.02em;">
              ${truncate(title, 50)}
            </span>
            <span title=${badge.doc} style="
              display: inline-flex; align-items: center; gap: 4px;
              border:1px solid color-mix(in srgb, ${badge.color} 35%, transparent);
              background: ${badge.tone};
              color:${badge.color};
              font-size:8px; padding:1px 6px; font-weight:700; letter-spacing:0.1em;
              border-radius: 3px;
            "><span style="font-size:9px;line-height:1;">${badge.icon}</span>${badge.label}</span>
            ${renderNodeBadge(session)}
            ${isSub ? html`
              <span style="font-size:8px; color:${HUD.textDim}; letter-spacing:0.05em;">
                ${session.agentName}
              </span>
            ` : nothing}
            ${session.channel ? html`
              <span style="font-size:8px; color:${HUD.textDim}; letter-spacing:0.1em; text-transform:uppercase;">
                ${session.channel}
              </span>
            ` : nothing}
          </div>

          <!-- Goal / task description (prominent for sub-agents) -->
          ${goal ? html`
            <div style="
              font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
              ${isSub ? `color:${HUD.text}; font-weight:500;` : `color:${HUD.textMuted};`}
            ">
              ${truncate(goal, 80)}
            </div>
          ` : nothing}

          <!-- Progress bar -->
          ${progress && session.active ? html`
            <div style="margin-top:6px; display:flex; align-items:center; gap:8px;">
              <div style="flex:1; height:3px; background:${HUD.border}; overflow:hidden;">
                <div style="
                  height:100%; width:${progress.pct}%;
                  background: linear-gradient(90deg, ${color}, ${color}80);
                  transition: width 0.5s ease;
                "></div>
              </div>
              <span style="font-size:8px; color:${color}; letter-spacing:0.1em; font-weight:700; flex-shrink:0;">
                ${progress.phase}
              </span>
            </div>
          ` : nothing}

          <!-- Completed badge for finished sub-agents -->
          ${!session.active && isSub && stepCount > 0 ? html`
            <div style="margin-top:4px; font-size:9px; color:${HUD.active}; letter-spacing:0.05em;">
              ✓ COMPLETE · ${stepCount} steps · ${toolCalls} tools · ${formatTokens(session.totalTokens)} tok
            </div>
          ` : nothing}
          ${renderForceCompleteAffordance(session, state)}
        </div>

        <!-- Stats -->
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:1px; flex-shrink:0;">
          <span style="font-size:10px; color:${HUD.goldMuted};">${timeAgo(session.updatedAt)}</span>
          <div style="display:flex; gap:6px; font-size:9px; color:${HUD.textDim};">
            <span>${formatTokens(session.totalTokens)} tok</span>
            ${stepCount > 0 ? html`<span>·</span><span>${stepCount} msg</span>` : nothing}
          </div>
        </div>

        <!-- Open chat modal -->
        <button
          title="Open full conversation in focused chat modal"
          @click=${(e: Event) => {
            e.stopPropagation();
            void openChatModal(state, client, session.key);
          }}
          style="
            flex-shrink:0; background:none;
            border:1px solid ${HUD.goldBorder};
            color:${HUD.goldDim};
            cursor:pointer; font-family:${HUD.mono};
            font-size:7px; padding:2px 6px; letter-spacing:0.08em;
            transition: all 0.1s;
          "
          @mouseenter=${(e: Event) => { (e.currentTarget as HTMLElement).style.borderColor = HUD.gold; (e.currentTarget as HTMLElement).style.color = HUD.gold; }}
          @mouseleave=${(e: Event) => { (e.currentTarget as HTMLElement).style.borderColor = HUD.goldBorder; (e.currentTarget as HTMLElement).style.color = HUD.goldDim; }}
        >⤢ OPEN</button>

        <!-- Pin control -->
        ${(() => {
          const pinned = as.pinnedToLive.has(session.key);
          return html`<button
            title="${pinned ? "Unpin (restore auto-classification)" : "Send to Background Tasks"}"
            @click=${(e: Event) => {
              e.stopPropagation();
              pinned ? unpinSession(state, session.key) : pinToBackground(state, session.key);
            }}
            style="
              flex-shrink:0; background:none;
              border:1px solid ${pinned ? HUD.active : HUD.border};
              color:${pinned ? HUD.active : HUD.textDim};
              cursor:pointer; font-family:${HUD.mono};
              font-size:7px; padding:2px 6px; letter-spacing:0.08em;
            "
          >${pinned ? "✕ UNPIN" : "→ BG"}</button>`;
        })()}

        <!-- Expand indicator -->
        <span style="
          color:${HUD.goldMuted}; font-size:8px; flex-shrink:0;
          transform:rotate(${isExpanded ? "180deg" : "0deg"});
          transition:transform 0.15s ease;
        ">▼</span>
      </div>

      <!-- Collapsed preview -->
      ${!isExpanded ? html`
        <div style="padding:0 14px 10px 32px;">
          ${summary ? html`
            <div style="font-size:10px; color:${HUD.textDim}; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${truncate(summary, 120)}
            </div>
          ` : nothing}
          ${session.steps.length > 0 ? html`
            <div style="margin-top:6px;">
              ${session.steps.slice(-3).reverse().map((step) => renderStepCompact(step))}
              ${session.steps.length > 3 ? html`
                <div style="font-size:9px; color:${HUD.textDim}; margin-top:4px; letter-spacing:0.05em;">
                  ${session.steps.length} MSG · ${toolCalls} TOOLS
                </div>
              ` : nothing}
            </div>
          ` : !session.lastMessagePreview ? html`
            <div style="font-size:9px; color:${HUD.textDim}; margin-top:6px; letter-spacing:0.05em;">
              ▸ CLICK TO LOAD
            </div>
          ` : nothing}
        </div>
      ` : nothing}

      <!-- Expanded feed -->
      ${isExpanded ? html`
        <div style="max-height:500px; overflow-y:auto; border-top:1px solid ${HUD.border};">
          <!-- Info bar -->
          <div style="
            padding:6px 14px; background:${HUD.bg};
            display:flex; gap:14px; font-size:9px; color:${HUD.textDim};
            border-bottom:1px solid ${HUD.border}; flex-wrap:wrap; letter-spacing:0.05em;
          ">
            <span style="color:${HUD.goldMuted};">MODEL</span> <span>${session.model || "default"}</span>
            <span style="color:${HUD.goldMuted};">IN</span> <span>${formatTokens(session.inputTokens)}</span>
            <span style="color:${HUD.goldMuted};">OUT</span> <span>${formatTokens(session.outputTokens)}</span>
            <span style="color:${HUD.goldMuted};">MSG</span> <span>${session.steps.length}</span>
            ${toolCalls > 0 ? html`<span style="color:${HUD.goldMuted};">TOOLS</span> <span>${toolCalls}</span>` : nothing}
          </div>

          ${session.loadingHistory ? html`
            <div style="padding:16px; text-align:center; color:${HUD.goldMuted}; font-size:10px; letter-spacing:0.1em;">
              LOADING...
            </div>
          ` : nothing}

          <!-- Steps timeline -->
          <div style="padding:4px 0;">
            ${session.steps.length === 0
              ? html`
                <div style="padding:20px; text-align:center; font-size:10px;">
                  ${session.previewLoaded
                    ? html`<span style="color:${HUD.textDim}; letter-spacing:0.1em;">EMPTY SESSION</span>`
                    : html`<button style="
                        padding:4px 14px; background:transparent; border:1px solid ${HUD.goldBorder};
                        color:${HUD.goldDim}; font-size:9px; font-family:${HUD.mono}; cursor:pointer;
                        letter-spacing:0.1em;
                      " @click=${() => { void loadSessionHistory(state, client, session.key); }}>
                        LOAD HISTORY
                      </button>`
                  }
                </div>`
              : session.steps.map((step, i) => renderStepFull(step, i, session.steps.length))}
          </div>

          ${session.steps.length >= 25 ? html`
            <div style="padding:6px 14px; text-align:center; border-top:1px solid ${HUD.border};">
              <button style="
                padding:3px 14px; background:transparent; border:1px solid ${HUD.goldBorder};
                color:${HUD.goldDim}; font-size:9px; font-family:${HUD.mono}; cursor:pointer;
                letter-spacing:0.1em;
              " @click=${() => { void loadSessionHistory(state, client, session.key); }}>
                MORE
              </button>
            </div>
          ` : nothing}
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Step Renderers ───────────────────────────────────────────

function renderStepCompact(step: AgentStep) {
  const style = STEP_STYLES[step.type] || STEP_STYLES.text;
  return html`
    <div style="display:flex; align-items:flex-start; gap:6px; margin-top:3px; font-size:10px;">
      <span style="color:${style.color}; flex-shrink:0; width:12px; text-align:center;">${style.icon}</span>
      <span style="color:${step.type === "user" ? HUD.goldDim : HUD.textMuted}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
        ${step.type === "tool_call"
          ? html`<span style="color:${HUD.goldDim};">${step.content}</span> ${step.detail ? truncate(step.detail, 50) : ""}`
          : truncate(step.content, 100)}
      </span>
    </div>
  `;
}

function renderStepFull(step: AgentStep, index: number, total: number) {
  const style = STEP_STYLES[step.type] || STEP_STYLES.text;
  const isLast = index === total - 1;

  return html`
    <div style="
      padding: 8px 14px; background: ${style.bg};
      border-bottom: 1px solid ${HUD.bg}; position: relative;
    ">
      <!-- Timeline -->
      <div style="
        position:absolute; left:20px; top:0; bottom:0;
        width:1px; background:${HUD.border};
        ${isLast ? "height:50%;" : ""}
      "></div>

      <div style="display:flex; align-items:flex-start; gap:10px;">
        <!-- Dot -->
        <div style="
          width:14px; height:14px; display:flex; align-items:center; justify-content:center;
          font-size:9px; flex-shrink:0; z-index:1; position:relative;
          color:${style.color}; background:${HUD.bgCard}; border:1px solid ${style.color};
        ">${style.icon}</div>

        <!-- Content -->
        <div style="flex:1; min-width:0;">
          <!-- Header -->
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:3px;">
            <span style="
              font-size:9px; font-weight:700; color:${style.color};
              letter-spacing:0.12em;
            ">${step.type === "tool_call" ? step.content.toUpperCase() : style.label}</span>
            <span style="font-size:9px; color:${HUD.textDim};">
              ${step.timestamp ? new Date(step.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ""}
            </span>
            ${step.model ? html`
              <span style="font-size:8px; color:${HUD.textDim};">${step.model}</span>
            ` : nothing}
            ${step.usage?.total ? html`
              <span style="font-size:8px; color:${HUD.goldMuted};">${formatTokens(step.usage.total)}</span>
            ` : nothing}
          </div>

          <!-- Body -->
          ${step.type === "tool_call" && step.detail ? html`
            <pre style="
              margin:0; padding:6px 8px; background:${HUD.bg}; border:1px solid ${HUD.border};
              font-size:10px; color:${HUD.textMuted}; line-height:1.4;
              overflow-x:auto; white-space:pre-wrap; word-break:break-all;
              font-family:${HUD.mono}; max-height:100px; overflow-y:auto;
            ">${step.detail}</pre>
          ` : step.type === "tool_result" && step.detail ? html`
            <pre style="
              margin:0; padding:6px 8px; background:${HUD.bg}; border:1px solid rgba(34,197,94,0.15);
              font-size:10px; color:${HUD.result}; line-height:1.4;
              overflow-x:auto; white-space:pre-wrap; word-break:break-all;
              font-family:${HUD.mono}; max-height:160px; overflow-y:auto;
            ">${step.detail}</pre>
          ` : step.type === "thinking" ? html`
            <div style="
              padding:6px 8px; background:${HUD.thinkingBg}; border:1px solid rgba(167,139,250,0.12);
              font-size:10px; color:${HUD.thinking}; line-height:1.5;
              font-style:italic; max-height:160px; overflow-y:auto;
            ">${step.content}</div>
          ` : step.type === "user" ? html`
            <div style="
              padding:6px 8px; background:${HUD.userBg}; border-left:2px solid ${HUD.goldBorder};
              font-size:10px; color:${HUD.goldDim}; line-height:1.5;
              max-height:160px; overflow-y:auto;
              white-space:pre-wrap; word-break:break-word;
            ">${truncate(step.content, 1000)}</div>
          ` : step.content ? html`
            <div style="
              font-size:10px; color:${HUD.textMuted}; line-height:1.5;
              max-height:160px; overflow-y:auto;
              white-space:pre-wrap; word-break:break-word;
            ">${truncate(step.content, 1000)}</div>
          ` : nothing}
        </div>
      </div>
    </div>
  `;
}

// ── Claude Coder Terminal Card ───────────────────────────────
// Custom card for claude-coder runs: terminal aesthetic, every action visible.

function coderActionLine(step: AgentStep) {
  const ts = step.timestamp ? new Date(step.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

  if (step.type === "tool_call") {
    const tool = step.content || "tool";
    return html`
      <div style="display:flex; gap:8px; align-items:flex-start; padding:3px 12px; font-size:10px; line-height:1.4;">
        <span style="color:${HUD.textDim}; flex-shrink:0; width:60px;">${ts}</span>
        <span style="color:${HUD.gold}; flex-shrink:0; width:14px;">$</span>
        <span style="color:${HUD.gold}; font-weight:600; flex-shrink:0;">${tool}</span>
        ${step.detail ? html`
          <span style="color:${HUD.textMuted}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${truncate(step.detail.replace(/\s+/g, " "), 200)}
          </span>
        ` : nothing}
      </div>
    `;
  }
  if (step.type === "tool_result") {
    return html`
      <div style="display:flex; gap:8px; align-items:flex-start; padding:3px 12px; font-size:10px; line-height:1.4; background:${HUD.resultBg};">
        <span style="color:${HUD.textDim}; flex-shrink:0; width:60px;">${ts}</span>
        <span style="color:${HUD.result}; flex-shrink:0; width:14px;">↩</span>
        <span style="color:${HUD.result}; overflow:hidden; text-overflow:ellipsis; flex:1;
          display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;
          word-break:break-word; white-space:pre-wrap;">${truncate(step.detail || step.content || "", 400)}</span>
      </div>
    `;
  }
  if (step.type === "thinking") {
    return html`
      <div style="display:flex; gap:8px; align-items:flex-start; padding:3px 12px; font-size:10px; line-height:1.4; background:${HUD.thinkingBg};">
        <span style="color:${HUD.textDim}; flex-shrink:0; width:60px;">${ts}</span>
        <span style="color:${HUD.thinking}; flex-shrink:0; width:14px;">◈</span>
        <span style="color:${HUD.thinking}; font-style:italic; overflow:hidden; flex:1;
          display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
          word-break:break-word;">${truncate(step.content, 240)}</span>
      </div>
    `;
  }
  if (step.type === "user") {
    return html`
      <div style="display:flex; gap:8px; align-items:flex-start; padding:3px 12px; font-size:10px; line-height:1.4; background:${HUD.userBg};">
        <span style="color:${HUD.textDim}; flex-shrink:0; width:60px;">${ts}</span>
        <span style="color:${HUD.user}; flex-shrink:0; width:14px;">▸</span>
        <span style="color:${HUD.goldDim}; overflow:hidden; flex:1; white-space:pre-wrap; word-break:break-word;
          display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;">${truncate(step.content, 400)}</span>
      </div>
    `;
  }
  if (step.type === "error") {
    return html`
      <div style="display:flex; gap:8px; align-items:flex-start; padding:3px 12px; font-size:10px; line-height:1.4; background:${HUD.errorBg};">
        <span style="color:${HUD.textDim}; flex-shrink:0; width:60px;">${ts}</span>
        <span style="color:${HUD.error}; flex-shrink:0; width:14px;">✕</span>
        <span style="color:${HUD.error}; overflow:hidden; flex:1; word-break:break-word;
          display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;">${truncate(step.content, 300)}</span>
      </div>
    `;
  }
  return html`
    <div style="display:flex; gap:8px; align-items:flex-start; padding:3px 12px; font-size:10px; line-height:1.4;">
      <span style="color:${HUD.textDim}; flex-shrink:0; width:60px;">${ts}</span>
      <span style="color:${HUD.textMuted}; flex-shrink:0; width:14px;">◆</span>
      <span style="color:${HUD.text}; overflow:hidden; flex:1; word-break:break-word; white-space:pre-wrap;
        display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;">${truncate(step.content, 400)}</span>
    </div>
  `;
}

function renderCoderTerminalCard(
  session: AgentSession,
  state: AppViewState,
  client: GatewayBrowserClient,
  as: AgentActivityState,
) {
  const isExpanded = session.expanded ?? true;
  const progress = estimateProgress(session);
  const stepCount = session.steps.length;
  const toolCalls = session.steps.filter((s) => s.type === "tool_call").length;
  const errors = session.steps.filter((s) => s.type === "error").length;
  const label = session.label || session.displayName || session.derivedTitle || "Coder run";
  const runId = session.sessionId || session.key;
  // Show ALL steps for coder runs — every action visible. Cap at 200 to avoid runaway DOM.
  const visibleSteps = session.steps.slice(-200);

  // Per-backend badge: pulls Claude/OpenCode/Codex logo + accent from the
  // brand kit so the terminal-style header shows which CLI is actually
  // running, not a generic "CLAUDE CODER" label for all three.
  const badge = pickBadge(session, "coder");
  const brand = resolveCoderBrand(session);
  const headerLabel = brand ? brand.label.toUpperCase() : "CODER";
  return html`
    <div class="glass-deep" style="
      grid-column: 1 / -1;
      --g-glow-primary: 0 0 28px color-mix(in srgb, ${badge.color} 30%, transparent);
      border-left: 3px solid ${badge.color};
      animation: hud-fade 0.2s ease;
      font-family: ${HUD.mono};
    ">
      <!-- Terminal title bar -->
      <div style="
        padding: 8px 14px; display:flex; align-items:center; gap:10px;
        background: linear-gradient(90deg, color-mix(in srgb, ${badge.color} 6%, transparent), transparent);
        border-bottom: 1px solid color-mix(in srgb, ${badge.color} 25%, transparent);
        cursor:pointer;
      " @click=${() => {
        session.expanded = !(session.expanded ?? true);
        if (session.expanded && !session.previewLoaded) {
          void loadSessionHistory(state, client, session.key);
        }
        state.requestUpdate?.();
      }}>
        <!-- Traffic lights -->
        <div style="display:flex; gap:5px; flex-shrink:0;">
          <span style="width:9px; height:9px; border-radius:50%; background:${session.active ? HUD.error : "#3a3a3a"};"></span>
          <span style="width:9px; height:9px; border-radius:50%; background:${session.active ? "#f59e0b" : "#3a3a3a"};"></span>
          <span style="width:9px; height:9px; border-radius:50%; background:${HUD.result};
            ${session.active ? `box-shadow:0 0 6px ${HUD.activeGlow}; animation: hud-pulse 2s infinite;` : ""}"></span>
        </div>

        <!-- Title -->
        <span title=${badge.doc} style="
          display: inline-flex; align-items: center; gap: 5px;
          border:1px solid color-mix(in srgb, ${badge.color} 35%, transparent);
          background: ${badge.tone};
          color:${badge.color};
          font-size:9px; padding:2px 7px; font-weight:700; letter-spacing:0.15em;
          border-radius: 3px; flex-shrink:0;
        ">${badge.icon} ${headerLabel}</span>
        <span style="font-size:11px; color:${HUD.text}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">
          ${truncate(label, 80)}
        </span>

        <!-- Status -->
        ${progress ? html`
          <span style="
            font-size:9px; color:${session.active ? HUD.gold : HUD.result};
            border:1px solid ${session.active ? HUD.gold : HUD.result};
            padding:1px 7px; letter-spacing:0.1em; flex-shrink:0; font-weight:700;
            ${session.active ? "animation: hud-pulse 2s infinite;" : ""}
          ">${progress.phase} ${progress.pct}%</span>
        ` : nothing}

        <!-- Timestamps + token -->
        <span style="font-size:9px; color:${HUD.goldMuted}; flex-shrink:0;">${timeAgo(session.updatedAt)}</span>
        <span style="font-size:9px; color:${HUD.textDim}; flex-shrink:0;">${formatTokens(session.totalTokens)} tok</span>

        <!-- Open chat modal (coder) -->
        <button
          title="Open full conversation in focused chat modal"
          @click=${(e: Event) => {
            e.stopPropagation();
            void openChatModal(state, client, session.key);
          }}
          style="
            flex-shrink:0; background:none;
            border:1px solid color-mix(in srgb, ${badge.color} 40%, transparent);
            color:${badge.color};
            cursor:pointer; font-family:${HUD.mono};
            font-size:7px; padding:2px 6px; letter-spacing:0.08em;
          "
        >⤢ OPEN</button>

        <!-- Coder pin control -->
        ${(() => {
          const pinned = as.pinnedToLive.has(session.key);
          return html`<button
            title="${pinned ? "Unpin (restore auto-classification)" : "Send to Background Tasks"}"
            @click=${(e: Event) => {
              e.stopPropagation();
              pinned ? unpinSession(state, session.key) : pinToBackground(state, session.key);
            }}
            style="
              flex-shrink:0; background:none;
              border:1px solid ${pinned ? HUD.active : HUD.border};
              color:${pinned ? HUD.active : HUD.textDim};
              cursor:pointer; font-family:${HUD.mono};
              font-size:7px; padding:2px 6px; letter-spacing:0.08em;
            "
          >${pinned ? "✕ UNPIN" : "→ BG"}</button>`;
        })()}

        <span style="
          color:${HUD.goldMuted}; font-size:9px; flex-shrink:0;
          transform:rotate(${isExpanded ? "180deg" : "0deg"}); transition:transform 0.15s ease;
        ">▼</span>
      </div>

      <!-- Stats strip -->
      <div style="
        padding: 5px 14px; display:flex; gap:14px; flex-wrap:wrap;
        font-size:9px; color:${HUD.textDim}; letter-spacing:0.05em;
        background:${HUD.bgInset}; border-bottom:1px solid ${HUD.border};
      ">
        <span><span style="color:${HUD.goldMuted};">RUN</span> ${truncate(runId, 36)}</span>
        ${session.model ? html`<span><span style="color:${HUD.goldMuted};">MODEL</span> ${session.model}</span>` : nothing}
        <span><span style="color:${HUD.goldMuted};">STEPS</span> ${stepCount}</span>
        <span><span style="color:${HUD.goldMuted};">TOOLS</span> ${toolCalls}</span>
        ${errors > 0 ? html`<span style="color:${HUD.error};">ERR ${errors}</span>` : nothing}
        ${session.inputTokens ? html`<span><span style="color:${HUD.goldMuted};">IN</span> ${formatTokens(session.inputTokens)}</span>` : nothing}
        ${session.outputTokens ? html`<span><span style="color:${HUD.goldMuted};">OUT</span> ${formatTokens(session.outputTokens)}</span>` : nothing}
        ${renderForceCompleteAffordance(session, state)}
      </div>

      <!-- Action stream -->
      ${isExpanded ? html`
        <div style="
          background:${HUD.bg}; max-height:560px; overflow-y:auto;
          border-bottom:1px solid ${HUD.border};
        ">
          ${session.loadingHistory ? html`
            <div style="padding:14px; text-align:center; color:${HUD.goldMuted}; font-size:10px; letter-spacing:0.1em;">
              LOADING ACTIONS...
            </div>
          ` : nothing}
          ${visibleSteps.length === 0
            ? html`
              <div style="padding:18px; text-align:center; font-size:10px; color:${HUD.textDim}; letter-spacing:0.1em;">
                ${session.previewLoaded
                  ? "NO ACTIONS YET"
                  : html`<button style="
                      padding:4px 14px; background:transparent; border:1px solid ${HUD.goldBorder};
                      color:${HUD.goldDim}; font-size:9px; font-family:${HUD.mono}; cursor:pointer;
                      letter-spacing:0.1em;
                    " @click=${(e: Event) => { e.stopPropagation(); void loadSessionHistory(state, client, session.key); }}>
                      LOAD ACTIONS
                    </button>`
                }
              </div>`
            : html`
              <div style="padding:6px 0;">
                ${visibleSteps.map((step) => coderActionLine(step))}
              </div>`
          }
        </div>
        <!-- Footer prompt -->
        <div style="
          padding:5px 14px; font-size:9px; color:${HUD.goldMuted};
          letter-spacing:0.1em; background:${HUD.bgCard};
          display:flex; justify-content:space-between; align-items:center;
        ">
          <span>$ ${session.active ? "running…" : "exited"} · ${visibleSteps.length} action${visibleSteps.length === 1 ? "" : "s"} shown</span>
          <button style="
            background:transparent; border:1px solid ${HUD.goldBorder};
            color:${HUD.goldDim}; font-size:9px; padding:2px 8px; cursor:pointer;
            font-family:${HUD.mono}; letter-spacing:0.1em;
          " @click=${(e: Event) => { e.stopPropagation(); void loadSessionHistory(state, client, session.key); }}>
            REFRESH
          </button>
        </div>
      ` : nothing}
    </div>
  `;
}
