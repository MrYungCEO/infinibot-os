import { html, nothing } from "lit";

import type { AppViewState } from "../app-view-state";
import { GLASS_TOOLS_CSS } from "./glass-tools-shared";

function formatRemaining(ms: number): string {
  const remaining = Math.max(0, ms);
  const totalSeconds = Math.floor(remaining / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

// Commands that delete, escalate or pipe remote code into a shell. Only used
// to add a warning chip; the decision itself is always the user's.
const DESTRUCTIVE_RE =
  /(\brm\s+-[a-z]*[rf]|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bchmod\s+-R\b|\bchown\s+-R\b|:\(\)\s*\{|\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b|\bgit\s+push\b[^\n]*--force|\bgit\s+reset\s+--hard\b|\bdrop\s+(table|database)\b|>\s*\/dev\/sd)/i;

function renderMetaRow(label: string, value?: string | null) {
  if (!value) return nothing;
  return html`<div class="exec-approval-meta-row xa-meta-row">
    <span class="xa-meta-k">${label}</span><span class="xa-meta-v" title=${value}>${value}</span>
  </div>`;
}

const XA_CSS = /* css */ `
.exec-approval-overlay.xa-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(ellipse 60% 50% at 50% 42%, color-mix(in srgb, var(--g-primary) 10%, transparent), transparent 70%),
    color-mix(in srgb, var(--bg, #050505) 72%, transparent);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
  backdrop-filter: blur(10px) saturate(140%);
  padding: 20px;
  /* above the app top bar / page toolbars (≈99999), like the other app modals */
  z-index: 100450;
}
:root[data-theme="light"] .exec-approval-overlay.xa-overlay {
  background:
    radial-gradient(ellipse 60% 50% at 50% 42%, color-mix(in srgb, var(--g-primary) 14%, transparent), transparent 70%),
    rgba(244, 244, 245, 0.62);
}
.exec-approval-card.xa-card {
  width: min(600px, 100%);
  max-height: calc(100dvh - 40px);
  overflow: auto;
  padding: 0;
  border-radius: 22px;
  animation: xa-in 520ms var(--gt-ease) both;
}
@keyframes xa-in { from { opacity: 0; transform: translateY(14px) scale(0.98); } }
.xa-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 26px 26px 18px;
}
.xa-shield {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 52px; height: 52px;
}
.xa-shield svg.xa-ring { position: absolute; inset: 0; transform: rotate(-90deg); }
.xa-ring-track { fill: none; stroke: color-mix(in srgb, var(--gt-fg) 8%, transparent); stroke-width: 3; }
.xa-ring-fill {
  fill: none; stroke: var(--gt-gold); stroke-width: 3; stroke-linecap: round;
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--gt-gold) 60%, transparent));
  transition: stroke-dashoffset 600ms ease;
}
.xa-card[data-risk="high"] .xa-ring-fill { stroke: var(--danger); filter: drop-shadow(0 0 4px color-mix(in srgb, var(--danger) 60%, transparent)); }
.xa-shield-core {
  display: grid; place-items: center;
  width: 38px; height: 38px;
  border-radius: 50%;
  color: var(--gt-gold-ink);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gt-gold) 32%, transparent), color-mix(in srgb, var(--gt-gold) 6%, transparent) 72%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 35%, transparent);
}
.xa-card[data-risk="high"] .xa-shield-core {
  color: var(--danger);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--danger) 30%, transparent), color-mix(in srgb, var(--danger) 6%, transparent) 72%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 40%, transparent);
}
.xa-shield-core svg { width: 18px; height: 18px; }
.xa-titles { flex: 1; min-width: 0; }
.xa-card .exec-approval-title.xa-title {
  margin: 4px 0 2px;
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.015em;
  color: var(--gt-fg);
}
.xa-card .exec-approval-sub.xa-sub {
  margin: 0;
  display: flex; align-items: center; gap: 8px;
  font: 500 12px/1.2 var(--mono);
  color: var(--gt-dim);
}
.xa-card[data-expired] .xa-sub { color: var(--danger); }
.xa-chips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.xa-body { padding: 0 26px 4px; }
.xa-label {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px;
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.xa-card .exec-approval-command.xa-command {
  position: relative;
  margin: 0;
  padding: 14px 16px 14px 34px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--gt-gold) 22%, transparent);
  background:
    linear-gradient(180deg, rgba(0, 0, 0, 0.42), rgba(0, 0, 0, 0.28));
  color: var(--gt-fg);
  font: 500 13px/1.6 var(--mono);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow: auto;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), inset 0 10px 30px -18px rgba(0, 0, 0, 0.8);
}
.xa-card .xa-command::before {
  content: "$";
  position: absolute; left: 15px; top: 14px;
  color: var(--gt-gold-ink);
  font-weight: 700;
}
:root[data-theme="light"] .xa-card .exec-approval-command.xa-command {
  background: linear-gradient(180deg, #1c1917, #26221d);
  color: #fafaf9;
}
:root[data-theme="light"] .xa-card .xa-command::before { color: color-mix(in srgb, var(--g-primary, #fbbf24) 85%, #fff); }
.xa-card .exec-approval-meta.xa-meta {
  margin: 14px 0 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid var(--gt-line);
  background: var(--gt-line);
}
.xa-card .exec-approval-meta.xa-meta > :last-child:nth-child(odd) { grid-column: 1 / -1; }
.xa-card .exec-approval-meta-row.xa-meta-row {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--bg, #050505) 50%, transparent);
  min-width: 0;
}
:root[data-theme="light"] .xa-card .exec-approval-meta-row.xa-meta-row { background: rgba(255, 255, 255, 0.75); }
.xa-meta-k {
  font: 600 9.5px/1 var(--mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.xa-card .exec-approval-meta-row span.xa-meta-v {
  font: 500 12px/1.35 var(--mono);
  color: var(--gt-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.xa-card .exec-approval-error.xa-error {
  margin: 14px 0 0;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  background: var(--danger-subtle);
  color: var(--danger);
  font-size: 12.5px;
}
.xa-card .exec-approval-actions.xa-actions {
  margin: 18px 0 0;
  padding: 18px 26px 22px;
  display: grid;
  grid-template-columns: 1.3fr 1fr 1fr;
  gap: 10px;
  border-top: 1px solid var(--gt-line);
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--gt-gold) 4%, transparent));
  border-radius: 0 0 22px 22px;
}
.xa-actions .gt-btn { height: 46px; border-radius: 14px; font-size: 13px; text-transform: none; letter-spacing: 0; white-space: nowrap; padding: 0 12px; }
.xa-titles .gt-eyebrow::before { display: none; }
.xa-actions .gt-btn svg { width: 15px; height: 15px; }
.xa-note {
  margin: 12px 0 0;
  font-size: 11.5px;
  color: var(--gt-faint);
  line-height: 1.5;
}
@media (max-width: 520px) {
  .exec-approval-overlay.xa-overlay { flex-direction: column; justify-content: flex-end; align-items: stretch; padding: 10px; }
  .exec-approval-overlay.xa-overlay > .xa-card { flex: 0 0 auto; height: auto; width: 100%; }
  .exec-approval-card.xa-card { border-radius: 22px; max-height: calc(100dvh - 20px); }
  .xa-head { padding: 18px 16px 14px; flex-wrap: wrap; }
  .xa-chips { width: 100%; justify-content: flex-start; }
  .xa-body { padding: 0 16px 2px; }
  .xa-card .exec-approval-meta-row.xa-meta-row { padding: 9px 10px; }
  .xa-card .exec-approval-actions.xa-actions {
    position: sticky; bottom: 0;
    background: var(--gt-surface-solid);
  }
  .xa-card .exec-approval-actions.xa-actions { grid-template-columns: 1fr 1fr; padding: 14px 16px 16px; }
  .xa-actions .gt-btn.gt-primary { grid-column: 1 / -1; }
}
@media (prefers-reduced-motion: reduce) {
  .exec-approval-card.xa-card { animation: none; }
  .xa-ring-fill { transition: none; }
}
:root.perf-mode .exec-approval-overlay.xa-overlay { -webkit-backdrop-filter: none; backdrop-filter: none; }
@media (prefers-reduced-transparency: reduce) {
  .exec-approval-overlay.xa-overlay { -webkit-backdrop-filter: none; backdrop-filter: none; background: color-mix(in srgb, var(--bg, #050505) 92%, transparent); }
}
`;

const shieldIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>`;
const alertIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>`;
const checkIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>`;
const infinityIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 15.5c-2 0-3.5-1.6-3.5-3.5s1.5-3.5 3.5-3.5c3.5 0 5.5 7 9 7 2 0 3.5-1.6 3.5-3.5s-1.5-3.5-3.5-3.5c-3.5 0-5.5 7-9 7z"/></svg>`;
const xIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

export function renderExecApprovalPrompt(state: AppViewState) {
  const active = state.execApprovalQueue[0];
  if (!active) return nothing;
  const request = active.request;
  const remainingMs = active.expiresAtMs - Date.now();
  const remaining = remainingMs > 0 ? `expires in ${formatRemaining(remainingMs)}` : "expired";
  const queueCount = state.execApprovalQueue.length;
  const totalMs = Math.max(1, active.expiresAtMs - (active.createdAtMs || active.expiresAtMs - 1));
  const frac = Math.min(1, Math.max(0, remainingMs / totalMs));
  const circ = 2 * Math.PI * 24;
  const highRisk = DESTRUCTIVE_RE.test(request.command ?? "");
  return html`
    <style>${GLASS_TOOLS_CSS}${XA_CSS}</style>
    <div
      class="exec-approval-overlay xa-overlay gt-scope"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
      aria-labelledby="xa-title"
    >
      <div
        class="exec-approval-card xa-card gt-glass"
        data-risk=${highRisk ? "high" : "normal"}
        ?data-expired=${remainingMs <= 0}
      >
        <div class="exec-approval-header xa-head">
          <div class="xa-shield" aria-hidden="true">
            <svg class="xa-ring" viewBox="0 0 52 52">
              <circle class="xa-ring-track" cx="26" cy="26" r="24"></circle>
              <circle
                class="xa-ring-fill"
                cx="26"
                cy="26"
                r="24"
                stroke-dasharray=${circ.toFixed(2)}
                stroke-dashoffset=${(circ * (1 - frac)).toFixed(2)}
              ></circle>
            </svg>
            <span class="xa-shield-core">${highRisk ? alertIcon : shieldIcon}</span>
          </div>
          <div class="xa-titles">
            <span class="gt-eyebrow">Security checkpoint</span>
            <div class="exec-approval-title xa-title" id="xa-title">Exec approval needed</div>
            <div class="exec-approval-sub xa-sub">
              <span class="gt-light" data-state=${remainingMs > 0 ? (highRisk ? "danger" : "gold") : "idle"} ?data-pulse=${remainingMs > 0}></span>
              ${remaining}
            </div>
          </div>
          <div class="xa-chips">
            ${highRisk ? html`<span class="gt-chip" data-tone="danger">Destructive pattern</span>` : nothing}
            ${queueCount > 1
              ? html`<span class="exec-approval-queue gt-chip" data-tone="gold">${queueCount} pending</span>`
              : nothing}
          </div>
        </div>
        <div class="xa-body">
          <div class="xa-label"><span>Command</span>${request.host ? html`<span>on ${request.host}</span>` : nothing}</div>
          <div class="exec-approval-command xa-command mono">${request.command}</div>
          <div class="exec-approval-meta xa-meta">
            ${renderMetaRow("Host", request.host)}
            ${renderMetaRow("Agent", request.agentId)}
            ${renderMetaRow("Session", request.sessionKey)}
            ${renderMetaRow("CWD", request.cwd)}
            ${renderMetaRow("Resolved", request.resolvedPath)}
            ${renderMetaRow("Security", request.security)}
            ${renderMetaRow("Ask", request.ask)}
          </div>
          ${state.execApprovalError
            ? html`<div class="exec-approval-error xa-error" role="alert">${state.execApprovalError}</div>`
            : nothing}
          <p class="xa-note">This command will not run until you approve it. Requests left unanswered expire.</p>
        </div>
        <div class="exec-approval-actions xa-actions">
          <button
            class="gt-btn gt-primary"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-once")}
          >
            ${checkIcon} Allow once
          </button>
          <button
            class="gt-btn"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-always")}
          >
            ${infinityIcon} Always allow
          </button>
          <button
            class="gt-btn gt-danger"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("deny")}
          >
            ${xIcon} Deny
          </button>
        </div>
      </div>
    </div>
  `;
}
