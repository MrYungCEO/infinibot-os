/**
 * Federation Modals
 *
 * Management modals for federation nodes:
 * - Node Details Modal (full info, metrics, sessions, MCPs)
 * - Node Settings Modal (edit name, sharing)
 * - Connect Wizard (step-by-step satellite setup)
 * - Confirmation Dialogs
 * - Invite (connection link) Modal
 *
 * Glass G7: every modal is a `.sg-backdrop` + `.sg-sheet` glass sheet from the
 * shared system kit. Modals render outside the dashboard's `.sg-page`, so each
 * one is wrapped in a `display: contents` `.sg-page` root to inherit the kit's
 * colour variables without creating a layout box.
 */

import { html, nothing, type TemplateResult } from "lit";
import {
  ensureSystemGlass,
  sgChip,
  sgGauge,
  sgIcon,
  sgLed,
  type SgIconName,
  type SgTone,
} from "./system-glass";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface NodeInfo {
  id: string;
  name: string;
  status: "online" | "offline" | "connecting";
  role: "master" | "satellite" | "standalone";
  isLocal: boolean;
  connectedAt?: number;
  lastSeen?: number;
  latencyMs?: number;
  cpu?: number;
  ram?: number;
  gpu?: number;
  gpuName?: string;
  sessions?: number;
  mcpCount?: number;
  capabilities?: {
    hasOllama?: boolean;
    hasComfyUI?: boolean;
    hasVoice?: boolean;
    gpu?: string;
    mcpServers?: string[];
    agents?: string[];
  };
  version?: string;
  platform?: string;
  url?: string;
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
}

export interface NodeDetailsModalProps extends ModalProps {
  node: NodeInfo | null;
  onPing: (nodeId: string) => void;
  onRestart: (nodeId: string) => void;
  onDisconnect: (nodeId: string) => void;
  onOpenSettings: (nodeId: string) => void;
}

export interface NodeSettingsModalProps extends ModalProps {
  node: NodeInfo | null;
  onSave: (nodeId: string, settings: NodeSettings) => void;
}

export interface NodeSettings {
  name: string;
  shareOllama: boolean;
  shareMCPs: boolean;
  shareAgents: boolean;
  acceptTasks: boolean;
}

export interface ConnectWizardProps extends ModalProps {
  onConnect: (url: string, name?: string) => Promise<boolean>;
  /** Called when user pastes an invite token instead of entering a URL manually */
  onConnectWithInvite?: (invite: string) => Promise<boolean>;
}

export interface ConfirmDialogProps extends ModalProps {
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
}

// ══════════════════════════════════════════════════════════════════════════════
// Styles + shell
// ══════════════════════════════════════════════════════════════════════════════

const modalStyles = `
  .fedm-root { display: contents; }
  .fedm-root .sg-backdrop { z-index: 10000; }
  .fedm-root .fedm-sheet { display: flex; flex-direction: column; padding: 0; overflow: hidden; width: min(600px, 100%); }
  .fedm-root .fedm-sheet--sm { width: min(420px, 100%); }
  .fedm-head { display: flex; align-items: center; gap: 14px; padding: 20px 22px 16px; border-bottom: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08)); }
  .fedm-head__icon {
    flex: none; display: grid; place-items: center; width: 42px; height: 42px; border-radius: 13px; color: var(--sg-gold);
    background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1)); box-shadow: inset 0 0 0 1px var(--glass-gold-a24, rgba(217, 180, 95, 0.24)), var(--glass-glow-soft, none);
  }
  .fedm-head__copy { flex: 1; min-width: 0; }
  .fedm-head__eyebrow { margin: 0 0 3px; color: var(--sg-gold); font-size: 10px; font-weight: 700; letter-spacing: var(--glass-tracking-caps, 0.16em); text-transform: uppercase; }
  .fedm-head__title { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--sg-fg); font-size: 17px; font-weight: 650; letter-spacing: -0.02em; overflow-wrap: anywhere; }
  .fedm-body { flex: 1; overflow-y: auto; padding: 20px 22px; display: flex; flex-direction: column; gap: 18px; }
  .fedm-foot { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; padding: 14px 22px 18px; border-top: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08)); }
  .fedm-foot--center { justify-content: center; }

  .fedm-label { display: block; margin: 0 0 7px; color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
  .fedm-hint { margin: 6px 0 0; color: var(--sg-fg-3); font-size: 12px; line-height: 1.5; }
  .fedm-field { display: flex; flex-direction: column; }
  .fedm-section-title { margin: 0 0 10px; display: flex; align-items: center; gap: 10px; color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
  .fedm-section-title::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--glass-stroke-gold, rgba(217, 180, 95, 0.28)), transparent); }

  /* Status banner */
  .fedm-banner { display: flex; align-items: center; gap: 12px; padding: 13px 15px; border-radius: var(--sg-radius-md);
    --tone: var(--sg-ok); background: color-mix(in srgb, var(--tone) 9%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 26%, transparent); }
  .fedm-banner--bad { --tone: var(--sg-bad); }
  .fedm-banner--warn { --tone: var(--sg-warn); }
  .fedm-banner--gold { --tone: var(--sg-gold); }
  .fedm-banner__title { color: var(--sg-fg); font-weight: 640; font-size: 14px; }
  .fedm-banner__sub { color: var(--sg-fg-2); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
  .fedm-banner__msg { color: var(--tone); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
  .fedm-banner .sg-ico { color: var(--tone); flex: none; }

  /* Metrics */
  .fedm-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .fedm-metric { display: grid; justify-items: center; gap: 8px; padding: 14px 10px; border-radius: var(--sg-radius-md);
    background: var(--glass-sheen, none), var(--glass-3, rgba(30, 27, 23, 0.66)); box-shadow: inset 0 0 0 1px var(--glass-stroke); }
  .fedm-metric__label { color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }

  .fedm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .fedm-chips .sg-chip .sg-ico { opacity: 0.9; }
  .fedm-empty-line { color: var(--sg-fg-3); font-size: 12.5px; }

  .fedm-info { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0; }
  .fedm-info > div { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 10px 12px; border-radius: 10px;
    background: var(--glass-hover, rgba(255, 255, 255, 0.04)); box-shadow: inset 0 0 0 1px var(--glass-stroke); min-width: 0; }
  .fedm-info dt { color: var(--sg-fg-3); font-size: 12px; flex: none; }
  .fedm-info dd { margin: 0; color: var(--sg-fg); font-size: 12.5px; font-weight: 600; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: none; }
  .fedm-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  /* Toggles */
  .fedm-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 14px; border-radius: 12px;
    background: var(--glass-hover, rgba(255, 255, 255, 0.04)); box-shadow: inset 0 0 0 1px var(--glass-stroke); }
  .fedm-toggle-row + .fedm-toggle-row { margin-top: 8px; }
  .fedm-toggle-label { color: var(--sg-fg); font-size: 13.5px; font-weight: 600; }
  .fedm-toggle-desc { color: var(--sg-fg-3); font-size: 12px; margin-top: 2px; }
  .fed-toggle { position: relative; flex: none; width: 42px; height: 24px; padding: 0; border: 0; border-radius: 99px; cursor: pointer;
    background: var(--glass-press, rgba(255, 255, 255, 0.1)); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong);
    transition: background var(--sg-dur) var(--sg-ease), box-shadow var(--sg-dur) var(--sg-ease); }
  .fed-toggle.active { background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: 0 0 14px -3px var(--glass-gold-a40, transparent); }
  .fed-toggle-knob { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--sg-fg-2);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3); transition: transform var(--sg-dur) var(--sg-spring), background var(--sg-dur); }
  .fed-toggle.active .fed-toggle-knob { transform: translateX(18px); background: #fff; }

  /* Wizard */
  .fedm-steps { display: flex; align-items: flex-start; justify-content: center; gap: 0; }
  .fedm-step { display: grid; justify-items: center; gap: 7px; width: 92px; position: relative; }
  .fedm-step + .fedm-step::before { content: ""; position: absolute; top: 16px; right: 50%; width: 100%; height: 1px; z-index: 0;
    background: var(--glass-stroke-strong, rgba(255, 255, 255, 0.14)); }
  .fedm-step.complete + .fedm-step::before, .fedm-step.active + .fedm-step.active::before { background: var(--glass-gold-fill, var(--sg-gold)); }
  .fedm-step__num { position: relative; z-index: 1; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%;
    color: var(--sg-fg-3); font-size: 13px; font-weight: 650; background: var(--glass-4, rgba(18, 17, 15, 0.9)); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong); }
  .fedm-step.active .fedm-step__num { color: var(--sg-gold); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), 0 0 16px -4px var(--glass-gold-a40, transparent); background: var(--glass-gold-a10), var(--glass-4); }
  .fedm-step.complete .fedm-step__num { color: var(--glass-ink, #0b0906); background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: none; }
  .fedm-step__label { color: var(--sg-fg-3); font-size: 11.5px; font-weight: 560; text-align: center; }
  .fedm-step.active .fedm-step__label { color: var(--sg-fg); }
  .fedm-wizard-content { min-height: 200px; display: flex; flex-direction: column; gap: 14px; }
  .fedm-root .fedm-seg { display: flex; width: 100%; }
  .fedm-root .fedm-seg > button { flex: 1 1 0; min-width: 0; justify-content: center; }
  @media (max-width: 480px) {
    .fedm-root .fedm-seg > button { padding-inline: 8px; white-space: normal; line-height: 1.25; text-align: center; }
  }
  .fedm-mono { font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 12px; }
  .fedm-root textarea.sg-input { resize: none; height: 84px; line-height: 1.45; word-break: break-all; }
  .fedm-url-preview { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 10px; color: var(--sg-gold);
    font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 12.5px; word-break: break-all;
    background: var(--glass-gold-a06, rgba(217, 180, 95, 0.06)); box-shadow: inset 0 0 0 1px var(--glass-gold-a16, rgba(217, 180, 95, 0.16)); }
  .fedm-url-preview .sg-ico { flex: none; }
  .fedm-center { display: grid; justify-items: center; gap: 10px; padding: 12px 6px; text-align: center; }
  .fedm-center .fedm-url-preview { width: 100%; justify-content: center; }
  .fedm-hero-icon { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 20px; color: var(--sg-gold);
    background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1)); box-shadow: inset 0 0 0 1px var(--glass-gold-a24, rgba(217, 180, 95, 0.24)), var(--glass-glow-soft, none); }
  .fedm-hero-icon--ok { color: var(--sg-ok); background: color-mix(in srgb, var(--sg-ok) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-ok) 30%, transparent), 0 0 30px -8px color-mix(in srgb, var(--sg-ok) 50%, transparent); }
  .fedm-hero-icon--bad { color: var(--sg-bad); background: color-mix(in srgb, var(--sg-bad) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-bad) 30%, transparent); }
  .fedm-hero-icon--warn { color: var(--sg-warn); background: color-mix(in srgb, var(--sg-warn) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-warn) 30%, transparent); }
  .fedm-center__title { margin: 4px 0 0; color: var(--sg-fg); font-size: 17px; font-weight: 650; letter-spacing: -0.02em; }
  .fedm-center__title--ok { color: var(--sg-ok); }
  .fedm-center__body { margin: 0; max-width: 400px; color: var(--sg-fg-2); font-size: 13px; line-height: 1.6; }
  .fedm-spin { display: inline-flex; animation: fedm-spin 1s linear infinite; }
  @keyframes fedm-spin { to { transform: rotate(360deg); } }

  /* Invite */
  .fedm-invite-form { width: 100%; max-width: 400px; text-align: left; }
  .fedm-cmd-block { display: flex; flex-direction: column; gap: 8px; }
  .fedm-cmd { margin: 0; padding: 12px 14px; border-radius: 12px; overflow-x: auto; white-space: pre;
    color: var(--sg-fg); font-family: var(--glass-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.55;
    background: color-mix(in srgb, var(--glass-base, #07070a) 55%, transparent); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong), inset 0 1px 3px rgba(0, 0, 0, 0.25); }
  .fedm-cmd code { color: inherit; font: inherit; }
  .fedm-cmd-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .fedm-cmd-row .fedm-label { margin: 0; }
  .fedm-copied { color: var(--sg-ok); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-ok) 40%, transparent); }
  .fedm-details summary { cursor: pointer; color: var(--sg-fg-2); font-size: 12.5px; list-style: none; display: inline-flex; align-items: center; gap: 6px; }
  .fedm-details summary::-webkit-details-marker { display: none; }
  .fedm-details summary .sg-ico { transition: transform var(--sg-dur) var(--sg-ease); }
  .fedm-details[open] summary .sg-ico { transform: rotate(90deg); }
  .fedm-details textarea { margin-top: 10px; }
  .fedm-expiry-time { margin-left: auto; color: var(--sg-fg-3); font-size: 11.5px; font-variant-numeric: tabular-nums; }

  :root[data-theme="light"] .fedm-cmd { background: rgba(255, 255, 255, 0.72); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong); }

  @media (max-width: 560px) {
    .fedm-head { padding: 16px 16px 14px; }
    .fedm-body { padding: 16px; }
    .fedm-foot { padding: 12px 16px 16px; }
    .fedm-foot > .sg-btn { flex: 1 1 auto; }
    .fedm-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .fedm-info { grid-template-columns: minmax(0, 1fr); }
    .fedm-actions > .sg-btn { flex: 1 1 calc(50% - 8px); }
    .fedm-step { width: 80px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .fedm-spin { animation: none; }
    .fed-toggle, .fed-toggle-knob, .fedm-details summary .sg-ico { transition: none; }
  }
`;

function stop(e: Event) {
  e.stopPropagation();
}

/** Shared glass sheet shell: backdrop + sheet + header + body + footer. */
function renderSheet(o: {
  onClose: () => void;
  icon: SgIconName;
  iconTone?: "bad" | "warn";
  eyebrow?: string;
  title: TemplateResult | string;
  label: string;
  body: TemplateResult;
  footer: TemplateResult;
  small?: boolean;
  bodyClass?: string;
  footerClass?: string;
  extraStyles?: string;
}): TemplateResult {
  ensureSystemGlass();
  const iconStyle =
    o.iconTone === "bad"
      ? "color:var(--sg-bad);background:color-mix(in srgb,var(--sg-bad) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sg-bad) 30%,transparent)"
      : o.iconTone === "warn"
        ? "color:var(--sg-warn);background:color-mix(in srgb,var(--sg-warn) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sg-warn) 30%,transparent)"
        : "";
  return html`
    <div class="sg-page fedm-root">
      <style>${modalStyles}${o.extraStyles ?? ""}</style>
      <div
        class="sg-backdrop fed-modal-overlay"
        @click=${o.onClose}
        @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") o.onClose(); }}
      >
        <div
          class="sg-sheet fedm-sheet fed-modal ${o.small ? "fedm-sheet--sm" : ""}"
          role="dialog"
          aria-modal="true"
          aria-label=${o.label}
          @click=${stop}
        >
          <header class="fedm-head">
            <span class="fedm-head__icon" style=${iconStyle}>${sgIcon(o.icon, 20)}</span>
            <div class="fedm-head__copy">
              ${o.eyebrow ? html`<p class="fedm-head__eyebrow">${o.eyebrow}</p>` : nothing}
              <h2 class="fedm-head__title">${o.title}</h2>
            </div>
            <button class="sg-btn sg-btn--ghost sg-btn--icon fed-modal-close" aria-label="Close" @click=${o.onClose}>${sgIcon("close", 18)}</button>
          </header>
          <div class="fedm-body ${o.bodyClass ?? ""}">${o.body}</div>
          <footer class="fedm-foot ${o.footerClass ?? ""}">${o.footer}</footer>
        </div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Node Details Modal
// ══════════════════════════════════════════════════════════════════════════════

export function renderNodeDetailsModal(props: NodeDetailsModalProps): TemplateResult | typeof nothing {
  if (!props.open || !props.node) return nothing;

  const node = props.node;
  const isOnline = node.status === "online";
  const statusTone: SgTone = isOnline ? "ok" : node.status === "connecting" ? "warn" : "bad";
  const subParts = [
    isOnline && node.latencyMs != null ? `Latency ${node.latencyMs}ms` : "",
    node.lastSeen ? `Last seen ${formatTimeAgo(node.lastSeen)}` : "",
  ].filter(Boolean);
  const caps = node.capabilities;
  const hasCaps = !!(caps?.gpu || caps?.hasOllama || caps?.hasVoice || caps?.hasComfyUI || caps?.mcpServers?.length || caps?.agents?.length);

  const body = html`
    <div class="fedm-banner fedm-banner--${statusTone === "ok" ? "ok" : statusTone}">
      ${sgLed(statusTone)}
      <div>
        <div class="fedm-banner__title">${isOnline ? "Online" : node.status === "connecting" ? "Connecting" : "Offline"}</div>
        ${subParts.length ? html`<div class="fedm-banner__sub">${subParts.join(" · ")}</div>` : nothing}
      </div>
    </div>

    ${isOnline ? html`
      <div class="fedm-metrics">
        ${renderMetric("CPU", node.cpu ?? 0)}
        ${renderMetric("RAM", node.ram ?? 0)}
        ${renderMetric("GPU", node.gpu ?? 0)}
      </div>
    ` : nothing}

    <section>
      <h3 class="fedm-section-title">Capabilities</h3>
      ${hasCaps ? html`
        <div class="fedm-chips">
          ${caps?.gpu ? sgChip(html`${sgIcon("chip", 12)} ${caps.gpu}`, "gold") : nothing}
          ${caps?.hasOllama ? sgChip(html`${sgIcon("spark", 12)} Ollama`, "gold") : nothing}
          ${caps?.hasVoice ? sgChip(html`${sgIcon("activity", 12)} Voice`, "gold") : nothing}
          ${caps?.hasComfyUI ? sgChip(html`${sgIcon("palette", 12)} ComfyUI`, "gold") : nothing}
          ${caps?.mcpServers?.length ? sgChip(html`${sgIcon("chip", 12)} ${caps.mcpServers.length} MCPs`) : nothing}
          ${caps?.agents?.length ? sgChip(html`${sgIcon("users", 12)} ${caps.agents.length} Agents`) : nothing}
        </div>
      ` : html`<div class="fedm-empty-line">No GPU, Ollama, voice or ComfyUI reported by this node yet.</div>`}
    </section>

    <section>
      <h3 class="fedm-section-title">Information</h3>
      <dl class="fedm-info">
        <div><dt>Node ID</dt><dd class="fedm-mono" title=${node.id}>${node.id.length > 12 ? `${node.id.substring(0, 12)}...` : node.id}</dd></div>
        <div><dt>Role</dt><dd style="text-transform:capitalize">${node.role}</dd></div>
        <div><dt>Platform</dt><dd>${node.platform ?? "Unknown"}</dd></div>
        <div><dt>Version</dt><dd>${node.version ?? "Unknown"}</dd></div>
        <div><dt>Sessions</dt><dd>${node.sessions ?? 0}</dd></div>
        <div><dt>MCPs</dt><dd>${node.mcpCount ?? 0}</dd></div>
      </dl>
    </section>

    ${!node.isLocal ? html`
      <div class="fedm-actions">
        <button class="sg-btn" @click=${() => props.onPing(node.id)}>${sgIcon("activity", 14)} Ping</button>
        <button class="sg-btn" @click=${() => props.onOpenSettings(node.id)}>${sgIcon("settings", 14)} Settings</button>
        <button class="sg-btn" @click=${() => props.onRestart(node.id)}>${sgIcon("refresh", 14)} Restart</button>
        <button class="sg-btn sg-btn--danger" @click=${() => props.onDisconnect(node.id)}>${sgIcon("close", 14)} Disconnect</button>
      </div>
    ` : nothing}
  `;

  return renderSheet({
    onClose: props.onClose,
    icon: node.isLocal ? "cpu" : "server",
    eyebrow: node.isLocal ? "This device" : "Fleet node",
    title: html`<span>${node.name}</span>${node.role === "master" ? sgChip("Master", "gold") : nothing}`,
    label: `Node details: ${node.name}`,
    body,
    footer: html`<button class="sg-btn" @click=${props.onClose}>Close</button>`,
  });
}

function renderMetric(label: string, percent: number) {
  return html`
    <div class="fedm-metric">
      ${sgGauge(percent / 100, { size: 66, caption: label })}
      <span class="fedm-metric__label">${label}</span>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Node Settings Modal
// ══════════════════════════════════════════════════════════════════════════════

export function renderNodeSettingsModal(
  props: NodeSettingsModalProps,
  settings: NodeSettings,
  onSettingsChange: (key: keyof NodeSettings, value: boolean | string) => void
): TemplateResult | typeof nothing {
  if (!props.open || !props.node) return nothing;

  const node = props.node;
  const toggle = (key: "shareOllama" | "shareMCPs" | "shareAgents" | "acceptTasks", label: string, desc: string) => html`
    <div class="fedm-toggle-row">
      <div>
        <div class="fedm-toggle-label">${label}</div>
        <div class="fedm-toggle-desc">${desc}</div>
      </div>
      <button
        class="fed-toggle ${settings[key] ? "active" : ""}"
        role="switch"
        aria-checked=${settings[key] ? "true" : "false"}
        aria-label=${label}
        @click=${() => onSettingsChange(key, !settings[key])}
      >
        <span class="fed-toggle-knob"></span>
      </button>
    </div>
  `;

  const body = html`
    <div class="fedm-field">
      <label class="fedm-label" for="fedm-node-name">Display Name</label>
      <input
        id="fedm-node-name"
        type="text"
        class="sg-input fed-form-input"
        .value=${settings.name}
        @input=${(e: Event) => onSettingsChange("name", (e.target as HTMLInputElement).value)}
      />
    </div>

    <section>
      <h3 class="fedm-section-title">Resource Sharing</h3>
      ${toggle("shareOllama", "Share Ollama", "Allow other nodes to use this node's Ollama")}
      ${toggle("shareMCPs", "Share MCP Servers", "Make this node's MCPs available to federation")}
      ${toggle("shareAgents", "Share Agents", "Allow spawning agents on this node")}
      ${toggle("acceptTasks", "Accept Routed Tasks", "Receive compute tasks from other nodes")}
    </section>
  `;

  return renderSheet({
    onClose: props.onClose,
    icon: "settings",
    eyebrow: "Node settings",
    title: node.name,
    label: `Node settings: ${node.name}`,
    body,
    footer: html`
      <button class="sg-btn" @click=${props.onClose}>Cancel</button>
      <button class="sg-btn sg-btn--primary" @click=${() => props.onSave(node.id, settings)}>${sgIcon("check", 14)} Save Changes</button>
    `,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Connect Wizard Modal
// ══════════════════════════════════════════════════════════════════════════════

export function renderConnectWizard(
  props: ConnectWizardProps,
  state: {
    step: number;
    url: string;
    name: string;
    testing: boolean;
    testResult: "success" | "error" | null;
    testMessage: string;
    inviteMode: boolean;
    inviteText: string;
  },
  onStateChange: (updates: Partial<typeof state>) => void
): TemplateResult | typeof nothing {
  if (!props.open) return nothing;

  const handleTest = async () => {
    onStateChange({ testing: true, testResult: null });
    try {
      let success: boolean;
      if (state.inviteMode && state.inviteText && props.onConnectWithInvite) {
        success = await props.onConnectWithInvite(state.inviteText);
      } else {
        success = await props.onConnect(state.url, state.name);
      }
      onStateChange({
        testing: false,
        testResult: success ? "success" : "error",
        testMessage: success ? "Connection successful!" : "Failed to connect",
      });
      if (success) onStateChange({ step: 3 });
    } catch (err) {
      onStateChange({
        testing: false,
        testResult: "error",
        testMessage: err instanceof Error ? err.message : "Connection failed",
      });
    }
  };

  // Decode invite bundle to preview the hub URL
  const invitePreview = (() => {
    if (!state.inviteText) return null;
    try {
      const b = JSON.parse(atob(state.inviteText)) as { v?: number; hubUrl?: string; hubName?: string; expiresAt?: number };
      if (b.v !== 1 || !b.hubUrl) return null;
      const minsLeft = b.expiresAt ? Math.max(0, Math.round((b.expiresAt - Date.now()) / 60_000)) : null;
      return { hubUrl: b.hubUrl, hubName: b.hubName ?? "Hub", minsLeft };
    } catch {
      return null;
    }
  })();

  const step1Ready = state.inviteMode
    ? !!state.inviteText && invitePreview !== null
    : !!state.url;

  const stepCls = (n: number) => `fedm-step ${state.step >= n ? "active" : ""} ${state.step > n ? "complete" : ""}`;

  const body = html`
    <div class="fedm-steps fed-wizard-steps" aria-label="Step ${state.step} of 3">
      <div class=${stepCls(1)}>
        <div class="fedm-step__num">${state.step > 1 ? sgIcon("check", 15) : "1"}</div>
        <div class="fedm-step__label">${state.inviteMode ? "Paste Token" : "Enter URL"}</div>
      </div>
      <div class=${stepCls(2)}>
        <div class="fedm-step__num">${state.step > 2 ? sgIcon("check", 15) : "2"}</div>
        <div class="fedm-step__label">Connect</div>
      </div>
      <div class=${stepCls(3)}>
        <div class="fedm-step__num">3</div>
        <div class="fedm-step__label">Done</div>
      </div>
    </div>

    <div class="fedm-wizard-content">
      ${state.step === 1 ? html`
        <div class="sg-seg fedm-seg" role="tablist" aria-label="Connection method">
          <button
            class="fed-mode-tab ${!state.inviteMode ? "active" : ""}"
            role="tab"
            aria-selected=${!state.inviteMode ? "true" : "false"}
            @click=${() => onStateChange({ inviteMode: false })}
          >${sgIcon("globe", 14)} Enter URL manually</button>
          <button
            class="fed-mode-tab ${state.inviteMode ? "active" : ""}"
            role="tab"
            aria-selected=${state.inviteMode ? "true" : "false"}
            @click=${() => onStateChange({ inviteMode: true })}
          >${sgIcon("key", 14)} Paste invite token</button>
        </div>

        ${!state.inviteMode ? html`
          <div class="fedm-field">
            <label class="fedm-label" for="fedm-hub-url">Hub WebSocket URL</label>
            <input
              id="fedm-hub-url"
              type="text"
              class="sg-input fedm-mono fed-form-input"
              placeholder="ws://192.168.1.100:47913/federation"
              .value=${state.url}
              @input=${(e: Event) => onStateChange({ url: (e.target as HTMLInputElement).value })}
            />
          </div>
          <div class="fedm-field">
            <label class="fedm-label" for="fedm-hub-name">Display Name (optional)</label>
            <input
              id="fedm-hub-name"
              type="text"
              class="sg-input fed-form-input"
              placeholder="e.g., Main Hub"
              .value=${state.name}
              @input=${(e: Event) => onStateChange({ name: (e.target as HTMLInputElement).value })}
            />
          </div>
          ${state.url ? html`<div class="fedm-url-preview">${sgIcon("wifi", 14)} ${state.url}</div>` : nothing}
        ` : html`
          <div class="fedm-field">
            <label class="fedm-label" for="fedm-invite">Invite token (from hub's "Generate Connection Link")</label>
            <textarea
              id="fedm-invite"
              class="sg-input fedm-mono fed-invite-paste"
              placeholder="Paste the token here…"
              .value=${state.inviteText}
              @input=${(e: Event) => onStateChange({ inviteText: (e.target as HTMLTextAreaElement).value.trim() })}
            ></textarea>
          </div>
          ${state.inviteText && invitePreview ? html`
            <div class="fedm-banner fed-invite-decode-preview">
              ${sgIcon("check", 16)}
              <div class="fedm-banner__msg">
                Valid invite — <strong>${invitePreview.hubName}</strong> at <code class="fedm-mono">${invitePreview.hubUrl}</code>
                ${invitePreview.minsLeft !== null ? html` · expires in ${invitePreview.minsLeft} min` : nothing}
              </div>
            </div>
          ` : nothing}
          ${state.inviteText && !invitePreview ? html`
            <div class="fedm-banner fedm-banner--bad fed-invite-decode-error">
              ${sgIcon("alert", 16)}
              <div class="fedm-banner__msg">Could not decode token — check that you pasted the full string.</div>
            </div>
          ` : nothing}
          ${!state.inviteText ? html`<p class="fedm-hint">On the hub, open Federation → Share Invite, generate a token and paste it here. Tokens last 15 minutes.</p>` : nothing}
        `}
      ` : nothing}

      ${state.step === 2 ? html`
        <div class="fedm-center">
          <span class="fedm-hero-icon">${state.testing ? html`<span class="fedm-spin">${sgIcon("refresh", 28)}</span>` : sgIcon("network", 28)}</span>
          <p class="fedm-center__title">Connecting to</p>
          <div class="fedm-url-preview">
            ${state.inviteMode && invitePreview ? invitePreview.hubUrl : state.url}
          </div>

          ${state.testing ? html`
            <div class="fedm-banner fedm-banner--gold fed-test-result loading">${sgLed("gold")}<div class="fedm-banner__msg">Connecting…</div></div>
          ` : nothing}
          ${state.testResult === "success" ? html`
            <div class="fedm-banner fed-test-result success">${sgIcon("check", 16)}<div class="fedm-banner__msg">${state.testMessage}</div></div>
          ` : nothing}
          ${state.testResult === "error" ? html`
            <div class="fedm-banner fedm-banner--bad fed-test-result error">${sgIcon("alert", 16)}<div class="fedm-banner__msg">${state.testMessage}</div></div>
          ` : nothing}
        </div>
      ` : nothing}

      ${state.step === 3 ? html`
        <div class="fedm-center">
          <span class="fedm-hero-icon fedm-hero-icon--ok">${sgIcon("check", 30)}</span>
          <p class="fedm-center__title fedm-center__title--ok">Connected!</p>
          <p class="fedm-center__body">
            ${state.inviteMode && invitePreview
              ? `Now connected to ${invitePreview.hubName}.`
              : `Node "${state.name || "Hub"}" is now part of your federation.`}
          </p>
        </div>
      ` : nothing}
    </div>
  `;

  const footer = html`
    ${state.step === 1 ? html`
      <button class="sg-btn" @click=${props.onClose}>Cancel</button>
      <button
        class="sg-btn sg-btn--primary"
        ?disabled=${!step1Ready}
        @click=${() => onStateChange({ step: 2 })}
      >Next ${sgIcon("arrowRight", 14)}</button>
    ` : nothing}

    ${state.step === 2 ? html`
      <button class="sg-btn" @click=${() => onStateChange({ step: 1 })}>Back</button>
      <button
        class="sg-btn sg-btn--primary"
        ?disabled=${state.testing}
        @click=${handleTest}
      >${state.testing ? "Connecting…" : html`${sgIcon("link", 14)} Connect`}</button>
    ` : nothing}

    ${state.step === 3 ? html`
      <button class="sg-btn sg-btn--primary" @click=${props.onClose}>Done</button>
    ` : nothing}
  `;

  return renderSheet({
    onClose: props.onClose,
    icon: "link",
    eyebrow: "Join a federation",
    title: "Connect to Master Hub",
    label: "Connect to Master Hub",
    body,
    footer,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Confirm Dialog
// ══════════════════════════════════════════════════════════════════════════════

export function renderConfirmDialog(props: ConfirmDialogProps): TemplateResult | typeof nothing {
  if (!props.open) return nothing;

  return renderSheet({
    onClose: props.onClose,
    icon: "alert",
    iconTone: props.danger ? "bad" : "warn",
    eyebrow: props.danger ? "Please confirm" : "Confirm",
    title: props.title,
    label: props.title,
    small: true,
    body: html`<p class="fedm-center__body" style="max-width:none">${props.message}</p>`,
    footer: html`
      <button class="sg-btn" @click=${props.onClose}>Cancel</button>
      <button
        class="sg-btn ${props.danger ? "sg-btn--danger" : "sg-btn--primary"}"
        @click=${props.onConfirm}
      >${props.confirmText ?? "Confirm"}</button>
    `,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Invite Modal
// ══════════════════════════════════════════════════════════════════════════════

export interface InviteModalState {
  open: boolean;
  generating: boolean;
  /** Operator-chosen name the joining satellite will adopt (1–48 chars). */
  satelliteName: string;
  invite: string | null;
  expiresAt: number | null;
  hubUrls: Array<{ type: string; url: string; label: string }>;
  /** CLI-format invites (`infinibot-invite-v1:…`), one per hubUrl. */
  cliInvites: Array<{ urlLabel: string; url: string; encoded: string }>;
  selectedUrlIndex: number;
  /** Which command block was last copied (key for the "Copied!" hint). */
  copiedKey: string | null;
  copied: boolean;
  error: string | null;
}

export interface InviteModalProps {
  state: InviteModalState;
  onClose: () => void;
  onGenerate: (selectedUrl?: string) => void;
  onCopy: () => void;
}

export function createInviteModalState(): InviteModalState {
  return {
    open: false,
    generating: false,
    satelliteName: "Satellite",
    invite: null,
    expiresAt: null,
    hubUrls: [],
    cliInvites: [],
    selectedUrlIndex: 0,
    copiedKey: null,
    copied: false,
    error: null,
  };
}

export function renderInviteModal(
  props: InviteModalProps,
  onStateChange: (updates: Partial<InviteModalState>) => void,
): TemplateResult | typeof nothing {
  if (!props.state.open) return nothing;

  const { state } = props;

  const minutesLeft = state.expiresAt
    ? Math.max(0, Math.round((state.expiresAt - Date.now()) / 60_000))
    : null;

  // Rebuild invite with the selected URL substituted in
  const getDisplayInvite = (): string => {
    if (!state.invite) return "";
    if (state.selectedUrlIndex === 0) return state.invite;
    try {
      const bundle = JSON.parse(atob(state.invite)) as { hubUrl: string; hubUrls: Array<{ url: string }> };
      const chosen = state.hubUrls[state.selectedUrlIndex];
      if (chosen) bundle.hubUrl = chosen.url;
      return btoa(JSON.stringify(bundle));
    } catch {
      return state.invite;
    }
  };

  const displayInvite = getDisplayInvite();

  // CLI invite for the currently-selected URL (for the pre-filled commands).
  const selectedCli = state.cliInvites[state.selectedUrlIndex]?.encoded ?? "";
  const cmdUnix = selectedCli
    ? `npm install -g infinibot\ninfinibot federation join '${selectedCli}'`
    : "";
  const cmdWin = selectedCli
    ? `npm install -g infinibot\ninfinibot federation join '${selectedCli}'`
    : "";

  const copyText = (text: string, key: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    onStateChange({ copied: true, copiedKey: key });
    props.onCopy();
  };

  const cmdBlock = (label: string, cmd: string, key: string) => html`
    <div class="fedm-cmd-block">
      <div class="fedm-cmd-row">
        <span class="fedm-label">${label}</span>
        <button
          class="sg-btn sg-btn--sm ${state.copiedKey === key ? "fedm-copied" : ""}"
          @click=${() => copyText(cmd, key)}
        >${state.copiedKey === key ? html`${sgIcon("check", 13)} Copied!` : html`${sgIcon("copy", 13)} Copy commands`}</button>
      </div>
      <pre class="fedm-cmd fed-invite-cmd"><code>${cmd}</code></pre>
    </div>
  `;

  const expiryTone = minutesLeft !== null && minutesLeft < 3 ? "bad" : "ok";

  const body = html`
    ${state.error ? html`
      <div class="fedm-banner fedm-banner--bad" role="alert">
        ${sgIcon("alert", 16)}
        <div class="fedm-banner__msg">${state.error}</div>
      </div>
    ` : nothing}

    ${!state.invite ? html`
      <div class="fedm-center">
        <span class="fedm-hero-icon">${sgIcon("link", 28)}</span>
        <p class="fedm-center__title">One-Click Satellite Connection</p>
        <p class="fedm-center__body">
          Generate a 15-minute invite token. Send it to a satellite machine
          and paste it into its Federation → Connect form to connect automatically.
        </p>
        <div class="fedm-field fedm-invite-form">
          <label class="fedm-label" for="fedm-sat-name">Satellite name</label>
          <input
            id="fedm-sat-name"
            class="sg-input fed-invite-name-input"
            type="text"
            maxlength="48"
            placeholder="Satellite"
            .value=${state.satelliteName}
            @input=${(e: Event) =>
              onStateChange({ satelliteName: (e.target as HTMLInputElement).value })}
          />
          <p class="fedm-hint">
            The name this machine will show up as across the fleet (map, sessions,
            hardware, node picker). 1–48 characters.
          </p>
        </div>
        <button
          class="sg-btn sg-btn--primary"
          ?disabled=${state.generating || !state.satelliteName.trim()}
          @click=${() => props.onGenerate()}
        >
          ${state.generating
            ? html`<span class="fedm-spin">${sgIcon("refresh", 14)}</span> Generating…`
            : html`${sgIcon("spark", 14)} Generate Token`}
        </button>
      </div>
    ` : html`
      ${state.satelliteName.trim() ? html`
        <div class="fedm-banner fedm-banner--gold">
          ${sgIcon("server", 16)}
          <div class="fedm-banner__msg" style="color:var(--sg-fg-2)">This satellite will join as <strong style="color:var(--sg-fg)">${state.satelliteName.trim()}</strong></div>
        </div>
      ` : nothing}

      ${state.hubUrls.length > 1 ? html`
        <div class="fedm-field">
          <label class="fedm-label" for="fedm-hub-select">Hub address encoded in link</label>
          <select
            id="fedm-hub-select"
            class="sg-input fed-invite-url-select"
            @change=${(e: Event) => {
              const idx = parseInt((e.target as HTMLSelectElement).value, 10);
              onStateChange({ selectedUrlIndex: idx, copied: false });
            }}
          >
            ${state.hubUrls.map((u, i) => html`
              <option value=${i} ?selected=${i === state.selectedUrlIndex}>${u.label} — ${u.url}</option>
            `)}
          </select>
          <p class="fedm-hint">
            Choose the address the satellite machine can reach. LAN for same network, Tailscale for VPN, Tunnel for internet.
          </p>
        </div>
      ` : nothing}

      ${selectedCli ? html`
        ${cmdBlock("Run on the satellite — macOS / Linux", cmdUnix, "unix")}
        ${cmdBlock("Run on the satellite — Windows (PowerShell)", cmdWin, "win")}
      ` : nothing}

      <details class="fedm-details">
        <summary>${sgIcon("chevron", 13)} Or paste the raw invite into a satellite's web UI</summary>
        <textarea
          class="sg-input fedm-mono fed-invite-token"
          readonly
          .value=${displayInvite}
          @click=${(e: Event) => (e.target as HTMLTextAreaElement).select()}
        ></textarea>
      </details>

      ${state.expiresAt ? html`
        <div class="fedm-banner fedm-banner--${expiryTone} fed-invite-expiry">
          ${sgLed(expiryTone)}
          <div class="fedm-banner__msg">Expires in ${minutesLeft} minute${minutesLeft !== 1 ? "s" : ""}</div>
          <span class="fedm-expiry-time">${new Date(state.expiresAt).toLocaleTimeString()}</span>
        </div>
      ` : nothing}
    `}
  `;

  const footer = html`
    ${state.invite ? html`
      <button class="sg-btn" @click=${() => {
        onStateChange({
          invite: null,
          expiresAt: null,
          copied: false,
          copiedKey: null,
          cliInvites: [],
          error: null,
          selectedUrlIndex: 0,
        });
      }}>
        ${sgIcon("refresh", 14)} Regenerate
      </button>
    ` : nothing}
    <button class="sg-btn" @click=${props.onClose}>Close</button>
  `;

  return renderSheet({
    onClose: props.onClose,
    icon: "link",
    eyebrow: "Share invite",
    title: "Generate Connection Link",
    label: "Generate Connection Link",
    body,
    footer,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
