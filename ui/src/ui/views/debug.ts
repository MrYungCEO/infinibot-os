import { html, nothing, type TemplateResult } from "lit";

import type { EventLogEntry } from "../app-events";
import { formatEventPayload } from "../presenter";
import {
  opsIcon,
  renderOpsSharedStyles,
  renderOpsTelemetryRail,
  type OpsIconName,
} from "./ops-glass";

export type DebugProps = {
  loading: boolean;
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  models: unknown[];
  heartbeat: unknown;
  eventLog: EventLogEntry[];
  callMethod: string;
  callParams: string;
  callResult: string | null;
  callError: string | null;
  onCallMethodChange: (next: string) => void;
  onCallParamsChange: (next: string) => void;
  onRefresh: () => void;
  onCall: () => void;
};

function snapshotPanel(
  label: string,
  caption: string,
  value: unknown,
  icon: OpsIconName,
): TemplateResult {
  return html`
    <article class="ops-debug-snapshot">
      <header><span class="ops-debug-snapshot-icon">${opsIcon(icon, 16)}</span><div><h3>${label}</h3><p>${caption}</p></div></header>
      <pre class="ops-json-view"><code>${JSON.stringify(value ?? {}, null, 2)}</code></pre>
    </article>
  `;
}

export function renderDebug(props: DebugProps) {
  const securityAudit =
    props.status && typeof props.status === "object"
      ? (props.status as { securityAudit?: { summary?: Record<string, number> } }).securityAudit
      : null;
  const securitySummary = securityAudit?.summary ?? null;
  const critical = securitySummary?.critical ?? 0;
  const warn = securitySummary?.warn ?? 0;
  const info = securitySummary?.info ?? 0;
  const securityTone = critical > 0 ? "danger" : warn > 0 ? "warn" : "success";
  const securityLabel =
    critical > 0 ? `${critical} critical` : warn > 0 ? `${warn} warnings` : "No critical issues";
  const statusKeys = props.status ? Object.keys(props.status).length : 0;
  const healthKeys = props.health ? Object.keys(props.health).length : 0;

  return html`
    <div class="ops-page ops-debug-page" aria-busy=${props.loading ? "true" : "false"}>
      ${renderOpsSharedStyles()}
      <style>
        .ops-debug-page .ops-debug-layout { display:grid;grid-template-columns:minmax(0,1.24fr) minmax(300px,.76fr);gap:18px;align-items:start; }
        .ops-debug-page .ops-toolbar .btn,.ops-debug-page .ops-rpc-submit { display:inline-flex;align-items:center;justify-content:center;gap:8px; }
        .ops-debug-page .ops-security-strip { display:flex;align-items:center;gap:11px;margin-top:18px;padding:12px 14px;border:1px solid var(--g-border);border-radius:var(--g-radius-sm);background:var(--g-surface);color:var(--g-fg-dim);font-size:11px;line-height:1.5; }
        .ops-debug-page .ops-security-strip.success { border-color:var(--g-success-border);background:var(--g-success-soft); }.ops-debug-page .ops-security-strip.warn{border-color:var(--g-warning-border);background:var(--g-warning-soft)}.ops-debug-page .ops-security-strip.danger{border-color:var(--g-danger-border);background:var(--g-danger-soft)}
        .ops-debug-page .ops-security-strip .ops-icon { color:var(--g-primary); }.ops-debug-page .ops-security-strip strong{color:var(--g-fg)}
        .ops-debug-page .ops-snapshot-grid { display:grid;gap:11px;margin-top:16px; }
        .ops-debug-page .ops-debug-snapshot { overflow:hidden;border:1px solid var(--g-border);border-radius:var(--g-radius);background:color-mix(in srgb,var(--g-bg-deep) 46%,var(--g-surface));box-shadow:inset 0 1px 0 color-mix(in srgb,var(--g-fg) 7%,transparent);transition:border-color 160ms ease,transform 160ms ease,box-shadow 160ms ease; }
        .ops-debug-page .ops-debug-snapshot:hover { transform:translateY(-1px);border-color:var(--g-border-strong);box-shadow:var(--g-shadow),inset 0 1px 0 color-mix(in srgb,var(--g-fg) 10%,transparent); }
        .ops-debug-page .ops-debug-snapshot header { display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--g-border);background:color-mix(in srgb,var(--g-surface-strong) 64%,transparent); }
        .ops-debug-page .ops-debug-snapshot-icon { display:grid;place-items:center;width:29px;height:29px;border:1px solid var(--g-border);border-radius:var(--g-radius-sm);background:var(--g-primary-soft);color:var(--g-primary); }
        .ops-debug-page .ops-debug-snapshot h3 { margin:0;color:var(--g-fg);font-size:11px;font-weight:700;letter-spacing:.02em; }.ops-debug-page .ops-debug-snapshot p{margin:3px 0 0;color:var(--g-fg-faint);font-size:9px}
        .ops-debug-page .ops-json-view { min-height:130px;max-height:290px;margin:0;padding:14px;overflow:auto;background:transparent;color:var(--g-fg-dim);font:500 10px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;scrollbar-width:thin;scrollbar-color:var(--g-border-strong) transparent; }
        .ops-debug-page .ops-rpc-panel { position:sticky;top:14px; }
        .ops-debug-page .ops-rpc-form { display:grid;gap:14px;margin-top:20px; }
        .ops-debug-page .ops-rpc-form .field>span { color:var(--g-fg-faint);font-size:9px;font-weight:700;letter-spacing:.11em;text-transform:uppercase; }
        .ops-debug-page .ops-rpc-form input,.ops-debug-page .ops-rpc-form textarea { width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
        .ops-debug-page .ops-rpc-form textarea { min-height:154px;resize:vertical;line-height:1.6; }
        .ops-debug-page .ops-rpc-submit { width:100%;min-height:44px; }
        .ops-debug-page .ops-rpc-result { margin-top:13px;border:1px solid var(--g-border);border-radius:var(--g-radius-sm);background:color-mix(in srgb,var(--g-bg-deep) 55%,var(--g-surface)); }
        .ops-debug-page .ops-rpc-result-label { display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--g-border);color:var(--g-primary);font-size:9px;font-weight:750;letter-spacing:.12em;text-transform:uppercase; }
        .ops-debug-page .ops-rpc-result pre { max-height:310px;margin:0;padding:13px;overflow:auto;color:var(--g-fg-dim);font:500 10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere; }
        .ops-debug-page .ops-models-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:9px;margin-top:16px;max-height:420px;overflow:auto;padding-right:3px;scrollbar-width:thin;scrollbar-color:var(--g-border-strong) transparent; }
        .ops-debug-page .ops-model-chip { min-width:0;padding:11px 12px;border:1px solid var(--g-border);border-radius:var(--g-radius-sm);background:var(--g-surface);color:var(--g-fg-dim);font:500 10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;transition:border-color 150ms ease,background 150ms ease,transform 150ms ease; }
        .ops-debug-page .ops-model-chip:hover { transform:translateY(-1px);border-color:var(--g-border-strong);background:var(--g-surface-hover);color:var(--g-primary); }
        .ops-debug-page .ops-event-list { position:relative;display:grid;gap:9px;margin-top:16px; }
        .ops-debug-page .ops-event-list::before { content:"";position:absolute;top:10px;bottom:10px;left:15px;width:1px;background:linear-gradient(var(--g-primary),var(--g-border),transparent);opacity:.55; }
        .ops-debug-page .ops-event { position:relative;display:grid;grid-template-columns:minmax(150px,.34fr) minmax(0,1fr);gap:18px;margin-left:7px;padding:13px 14px 13px 30px;border:1px solid var(--g-border);border-radius:var(--g-radius-sm);background:var(--g-surface);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--g-fg) 7%,transparent); }
        .ops-debug-page .ops-event::before { content:"";position:absolute;left:3px;top:19px;width:9px;height:9px;border:2px solid var(--g-bg);border-radius:50%;background:var(--g-primary);box-shadow:0 0 12px color-mix(in srgb,var(--g-primary) 70%,transparent); }
        .ops-debug-page .ops-event-name { color:var(--g-fg);font-size:11px;font-weight:700;overflow-wrap:anywhere; }.ops-debug-page .ops-event-time{margin-top:5px;color:var(--g-fg-faint);font:500 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.ops-debug-page .ops-event pre{max-height:180px;margin:0;overflow:auto;color:var(--g-fg-dim);font:500 9px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
        @media (max-width:980px){.ops-debug-page .ops-debug-layout{grid-template-columns:1fr}.ops-debug-page .ops-rpc-panel{position:relative;top:auto}}
        @media (max-width:600px){.ops-debug-page .ops-models-grid{grid-template-columns:1fr}.ops-debug-page .ops-event{grid-template-columns:1fr;gap:10px}.ops-debug-page .ops-json-view{max-height:230px}.ops-debug-page .ops-security-strip{align-items:flex-start}}
        @media (max-width:390px){.ops-debug-page .ops-event{padding-right:10px}.ops-debug-page .ops-json-view{font-size:9px}.ops-debug-page .ops-toolbar,.ops-debug-page .ops-toolbar .btn{width:100%}}
      </style>

      <header class="ops-hero">
        <div class="ops-hero-copy"><div class="ops-eyebrow">Developer systems / Diagnostics</div><h1 class="ops-title">Runtime <em>debug</em></h1><p class="ops-subtitle">Inspect live gateway state, interrogate raw methods, and trace event traffic from one focused operator surface.</p></div>
        <div class="ops-live-badge"><span class="ops-status-dot ${critical > 0 ? "warn" : ""}"></span>${critical > 0 ? "Action required" : props.loading ? "Refreshing" : "Diagnostics ready"}</div>
      </header>

      <div class="ops-metrics" aria-label="Debug summary">
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("database", 13)}Status fields</span><strong class="ops-metric-value accent">${statusKeys}</strong></div>
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("activity", 13)}Health fields</span><strong class="ops-metric-value">${healthKeys}</strong></div>
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("chip", 13)}Models</span><strong class="ops-metric-value">${props.models.length}</strong></div>
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("radio", 13)}Events</span><strong class="ops-metric-value">${props.eventLog.length}</strong></div>
      </div>

      ${renderOpsTelemetryRail("Diagnostic telemetry", [
        { label: "runtime", value: props.loading ? "sampling" : "ready", tone: props.loading ? "warning" : "success" },
        { label: "security", value: securityLabel, tone: critical > 0 ? "danger" : warn > 0 ? "warning" : "success" },
        { label: "rpc", value: props.callError ? "error" : props.callResult ? "complete" : "standby", tone: props.callError ? "danger" : props.callResult ? "success" : "accent" },
        { label: "event window", value: props.eventLog.length },
      ])}

      <div class="ops-debug-layout">
        <section class="ops-panel">
          <div class="ops-section-head"><div class="ops-heading-group"><span class="ops-heading-icon">${opsIcon("database", 19)}</span><div><h2 class="ops-heading">State inspector</h2><p class="ops-kicker">Current status, health, and heartbeat snapshots.</p></div></div><div class="ops-toolbar"><button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>${opsIcon("refresh", 15)}${props.loading ? "Refreshing…" : "Refresh"}</button></div></div>
          ${securitySummary ? html`<div class="ops-security-strip ${securityTone}">${opsIcon("shield", 17)}<span><strong>Security audit: ${securityLabel}</strong>${info > 0 ? ` · ${info} informational findings.` : "."} Run <span class="mono">infinibot security audit --deep</span> for details.</span></div>` : nothing}
          <div class="ops-snapshot-grid">${
            props.loading && !props.status
              ? html`${Array.from(
                  { length: 3 },
                  () =>
                    html`
                      <div class="ops-skeleton" style="min-height: 170px"></div>
                    `,
                )}`
              : html`${snapshotPanel("Status", "Gateway state vector", props.status, "database")}${snapshotPanel("Health", "Service readiness", props.health, "activity")}${snapshotPanel("Last heartbeat", "Most recent lifecycle pulse", props.heartbeat, "radio")}`
          }</div>
        </section>

        <section class="ops-panel ops-rpc-panel">
          <div class="ops-heading-group"><span class="ops-heading-icon">${opsIcon("terminal", 19)}</span><div><h2 class="ops-heading">Manual RPC</h2><p class="ops-kicker">Send a raw gateway method with JSON parameters.</p></div></div>
          <div class="ops-rpc-form"><label class="field"><span>Method</span><input .value=${props.callMethod} @input=${(event: Event) => props.onCallMethodChange((event.target as HTMLInputElement).value)} placeholder="system-presence" spellcheck="false" /></label><label class="field"><span>Params / JSON</span><textarea .value=${props.callParams} @input=${(event: Event) => props.onCallParamsChange((event.target as HTMLTextAreaElement).value)} rows="6" spellcheck="false"></textarea></label><button class="btn primary ops-rpc-submit" @click=${props.onCall}>${opsIcon("play", 16)}Execute method</button></div>
          ${props.callError ? html`<div class="callout danger" role="alert" style="margin-top:13px">${props.callError}</div>` : nothing}
          ${props.callResult ? html`<div class="ops-rpc-result" aria-live="polite"><div class="ops-rpc-result-label">${opsIcon("check", 13)}Response</div><pre>${props.callResult}</pre></div>` : nothing}
        </section>
      </div>

      <section class="ops-panel">
        <div class="ops-heading-group"><span class="ops-heading-icon">${opsIcon("chip", 19)}</span><div><h2 class="ops-heading">Model catalog</h2><p class="ops-kicker">Provider inventory reported by <span class="mono">models.list</span>.</p></div></div>
        ${props.models.length === 0 ? html`<div class="ops-empty"><div><span class="ops-empty-icon">${opsIcon("chip", 23)}</span><strong>No models reported</strong><span>Refresh diagnostics after the gateway finishes loading providers.</span></div></div>` : html`<div class="ops-models-grid">${props.models.map((model) => html`<div class="ops-model-chip">${typeof model === "string" ? model : JSON.stringify(model)}</div>`)}</div>`}
      </section>

      <section class="ops-panel">
        <div class="ops-heading-group"><span class="ops-heading-icon">${opsIcon("radio", 19)}</span><div><h2 class="ops-heading">Event trace</h2><p class="ops-kicker">Latest gateway events in arrival order.</p></div></div>
        ${props.eventLog.length === 0 ? html`<div class="ops-empty"><div><span class="ops-empty-icon">${opsIcon("radio", 23)}</span><strong>Waiting for events</strong><span>Live gateway activity will appear here as it arrives.</span></div></div>` : html`<div class="ops-event-list">${props.eventLog.map((event) => html`<article class="ops-event"><div><div class="ops-event-name">${event.event}</div><div class="ops-event-time">${new Date(event.ts).toLocaleTimeString()}</div></div><pre>${formatEventPayload(event.payload)}</pre></article>`)}</div>`}
      </section>
    </div>
  `;
}
