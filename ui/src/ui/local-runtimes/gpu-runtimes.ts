/**
 * <ib-gpu-runtimes> — which local model runtime owns the GPU, VRAM use, and
 * Start/Stop for each registry runtime (vLLM unit, Ollama). Lives at the
 * bottom of the chat model picker (`compact`) and on the System page.
 *
 * Starting one swaps the GPU: the gateway frees VRAM from the other runtime
 * first. Progress comes from `localRuntimes.status` events.
 */
import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  formatMb,
  getLocalRuntimesState,
  onLocalRuntimes,
  refreshLocalRuntimes,
  startLocalRuntime,
  stopLocalRuntime,
  type LocalRuntimesState,
  type RuntimeStatus,
} from "./store";
import { isCloudBuild } from "../cloud/cloud-env";

const chip = svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2.5v2.5M15 2.5v2.5M9 19v2.5M15 19v2.5M2.5 9h2.5M2.5 15h2.5M19 9h2.5M19 15h2.5"/></svg>`;
const play = svg`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z"/></svg>`;
const square = svg`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
const eject = svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5l7 8H5z"/><path d="M5 18h14"/></svg>`;
const swapIcon = svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4 3 8l4 4"/><path d="M3 8h13a4 4 0 0 1 4 4"/><path d="m17 20 4-4-4-4"/><path d="M21 16H8a4 4 0 0 1-4-4"/></svg>`;
const ring = svg`<svg class="spin" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".22" stroke-width="2.4"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

const STATE_LABEL: Record<RuntimeStatus["state"], string> = {
  ready: "Running",
  starting: "Starting",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  unavailable: "Offline",
};

function shortModel(name: string): string {
  return name.replace(/:latest$/, "").replace(/^.*\//, "");
}

@customElement("ib-gpu-runtimes")
export class GpuRuntimes extends LitElement {
  /** Dense variant for the model picker. */
  @property({ type: Boolean, reflect: true }) compact = false;
  @state() private s: LocalRuntimesState = getLocalRuntimesState();
  @state() private now = Date.now();
  private off: (() => void) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.off = onLocalRuntimes((s) => (this.s = s));
    void refreshLocalRuntimes();
    this.tick = setInterval(() => {
      if (this.s.status?.swap) this.now = Date.now();
    }, 1000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.off?.();
    if (this.tick) clearInterval(this.tick);
  }

  private renderRuntime(r: RuntimeStatus) {
    const swap = this.s.status?.swap;
    const busy = this.s.pending === r.id || swap?.runtimeId === r.id || r.state === "starting" || r.state === "stopping";
    const isSystemd = r.kind === "systemd";
    const running = isSystemd ? r.healthy : r.loadedModels.length > 0;
    const vram = r.loadedModels.reduce((n, m) => n + m.vramMb, 0);
    let detail: string;
    if (r.error && r.state === "failed") detail = r.error;
    else if (isSystemd) {
      detail = running
        ? r.idleStopAt
          ? `Idle stop in ${Math.max(1, Math.round((r.idleStopAt - this.now) / 60_000))} min`
          : "Serving"
        : r.state === "unavailable"
          ? "Unit not found"
          : "Starts on demand";
    } else {
      detail = !r.healthy
        ? "Not answering"
        : running
          ? `${r.loadedModels.map((m) => shortModel(m.name)).join(", ")} · ${formatMb(vram)}`
          : "Loads models on demand";
    }
    const dot = busy ? "busy" : r.state === "failed" ? "err" : running ? "on" : "off";
    const label = running ? (isSystemd ? "Stop" : "Unload") : isSystemd ? "Start" : "Load";
    return html`<div class="rt" data-runtime=${r.id}>
      <span class="dot dot--${dot}" aria-hidden="true"></span>
      <div class="rt-main">
        <div class="rt-name">
          ${r.label}
          <span class="rt-state rt-state--${dot}">${busy && swap?.runtimeId === r.id ? "Starting" : STATE_LABEL[r.state]}</span>
        </div>
        <div class="rt-detail" title=${r.error ?? detail}>${detail}</div>
      </div>
      <button
        class="btn ${running ? "btn--ghost" : "btn--gold"}"
        ?disabled=${busy || !!swap || (!isSystemd && !r.healthy) || r.state === "unavailable"}
        title=${running ? `${label} ${r.label}` : `${label} ${r.label} — frees the GPU from the other runtime first`}
        @click=${() => void (running ? stopLocalRuntime(r.id) : startLocalRuntime(r.id))}
      >
        <span class="btn-ico">${busy ? ring : running ? (isSystemd ? square : eject) : play}</span>${label}
      </button>
    </div>`;
  }

  render() {
    // InfiniBot Cloud tenants have no local GPU.
    if (isCloudBuild()) return nothing;
    const { status, unsupported, error } = this.s;
    if (unsupported || (!status && !this.s.loading && !error)) return nothing;
    if (!status) {
      return html`<div class="wrap"><div class="head"><span class="ico">${chip}</span><span class="title">GPU</span><span class="muted">${error ? "Unavailable" : "Loading…"}</span></div></div>`;
    }
    if (!status.enabled || status.runtimes.length === 0) return nothing;
    const gpu = status.gpu;
    const pct = gpu ? Math.min(100, Math.round((gpu.usedMb / gpu.totalMb) * 100)) : 0;
    const swap = status.swap;
    const elapsed = swap ? Math.max(swap.elapsedSec, Math.round((this.now - swap.startedAt) / 1000)) : 0;
    const prog = swap && swap.etaSec > 0 ? Math.min(96, Math.round((elapsed / swap.etaSec) * 100)) : 0;
    const owner = status.runtimes.find((r) => r.holdsGpu);
    return html`<div class="wrap" part="wrap">
      <div class="head">
        <span class="ico">${chip}</span>
        <span class="title">GPU</span>
        <span class="muted">${gpu ? gpu.name.replace(/^NVIDIA (GeForce )?/, "") : "no GPU info"}</span>
        <span class="grow"></span>
        ${gpu ? html`<span class="vram">${formatMb(gpu.usedMb)} <span class="muted">/ ${formatMb(gpu.totalMb)}</span></span>` : nothing}
      </div>
      ${gpu
        ? html`<div class="bar" role="meter" aria-label="VRAM used" aria-valuemin="0" aria-valuemax=${gpu.totalMb} aria-valuenow=${gpu.usedMb}>
            <span class="bar-fill ${pct > 92 ? "bar-fill--hot" : ""}" style="width:${pct}%"></span>
          </div>`
        : nothing}
      ${!this.compact
        ? html`<div class="owner muted">${owner ? html`Loaded: <strong>${owner.label}</strong>` : "No local model loaded"}</div>`
        : nothing}
      ${swap
        ? html`<div class="swap swap--${swap.phase}" role="status">
            <span class="swap-ico">${swap.phase === "failed" ? swapIcon : ring}</span>
            <div class="swap-main">
              <div class="swap-msg">${swap.message}</div>
              ${swap.phase !== "failed" && swap.etaSec > 0
                ? html`<div class="swap-bar"><span style="width:${prog}%"></span></div>`
                : nothing}
            </div>
            <span class="swap-time">${elapsed}s</span>
          </div>`
        : nothing}
      <div class="list">${status.runtimes.map((r) => this.renderRuntime(r))}</div>
      ${error ? html`<div class="err">${error}</div>` : nothing}
      ${!this.compact && status.log.length
        ? html`<div class="log">
            <div class="log-head">Recent swaps</div>
            ${status.log.slice(0, 6).map(
              (e) => html`<div class="log-row log-row--${e.kind}">
                <span class="log-time">${new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                <span class="log-msg">${e.message}</span>
              </div>`,
            )}
          </div>`
        : nothing}
    </div>`;
  }

  static styles = css`
    :host {
      display: block;
      --g-gold: var(--glass-gold, #d8b45a);
      --g-text: var(--text, #ece7da);
      --g-muted: var(--muted, rgba(236, 231, 218, 0.56));
      --g-line: var(--border, rgba(255, 255, 255, 0.08));
      --g-ok: #6fd0a0;
      --g-err: #ff7a7a;
      font: inherit;
      color: var(--g-text);
    }
    .wrap {
      display: flex;
      flex-direction: column;
      gap: 9px;
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid var(--g-line);
      background: linear-gradient(180deg, rgba(216, 180, 90, 0.05), rgba(255, 255, 255, 0.015));
    }
    :host([compact]) .wrap {
      gap: 7px;
      padding: 10px 12px;
      border-radius: 0;
      border: 0;
      border-top: 1px solid var(--g-line);
      background: linear-gradient(180deg, rgba(216, 180, 90, 0.04), transparent);
    }
    .head { display: flex; align-items: center; gap: 7px; font-size: 12px; min-width: 0; }
    .ico { display: inline-flex; width: 16px; height: 16px; color: var(--g-gold); }
    .ico svg { width: 100%; height: 100%; }
    .title { font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; font-size: 10.5px; color: var(--g-gold); }
    .muted { color: var(--g-muted); }
    .grow { flex: 1; }
    .vram { font-variant-numeric: tabular-nums; font-size: 11.5px; white-space: nowrap; }
    .bar { height: 5px; border-radius: 99px; background: rgba(255, 255, 255, 0.07); overflow: hidden; }
    .bar-fill {
      display: block; height: 100%; border-radius: inherit;
      background: linear-gradient(90deg, rgba(216, 180, 90, 0.55), var(--g-gold));
      box-shadow: 0 0 10px rgba(216, 180, 90, 0.45);
      transition: width 0.6s ease;
    }
    .bar-fill--hot { background: linear-gradient(90deg, #d89a5a, #ff8c6b); }
    .owner { font-size: 12px; }
    .owner strong { color: var(--g-text); font-weight: 600; }
    .list { display: flex; flex-direction: column; gap: 2px; }
    .rt { display: flex; align-items: center; gap: 10px; padding: 6px 0; min-width: 0; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: rgba(255, 255, 255, 0.22); }
    .dot--on { background: var(--g-ok); box-shadow: 0 0 8px rgba(111, 208, 160, 0.6); }
    .dot--busy { background: var(--g-gold); box-shadow: 0 0 10px rgba(216, 180, 90, 0.7); animation: pulse 1.2s ease-in-out infinite; }
    .dot--err { background: var(--g-err); }
    .rt-main { flex: 1; min-width: 0; }
    .rt-name { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 7px; white-space: nowrap; }
    .rt-state { font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--g-muted); }
    .rt-state--on { color: var(--g-ok); }
    .rt-state--busy { color: var(--g-gold); }
    .rt-state--err { color: var(--g-err); }
    .rt-detail { font-size: 11.5px; color: var(--g-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .btn {
      display: inline-flex; align-items: center; gap: 5px; flex: none;
      height: 26px; padding: 0 10px; border-radius: 8px; cursor: pointer;
      font: inherit; font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em;
      border: 1px solid rgba(216, 180, 90, 0.35); color: var(--g-gold); background: rgba(216, 180, 90, 0.08);
      transition: background 0.15s, border-color 0.15s, opacity 0.15s;
    }
    .btn:hover:not([disabled]) { background: rgba(216, 180, 90, 0.16); border-color: rgba(216, 180, 90, 0.6); }
    .btn--ghost { color: var(--g-text); border-color: var(--g-line); background: rgba(255, 255, 255, 0.03); }
    .btn--ghost:hover:not([disabled]) { background: rgba(255, 255, 255, 0.07); border-color: rgba(255, 255, 255, 0.18); }
    .btn[disabled] { opacity: 0.45; cursor: default; }
    .btn-ico { display: inline-flex; width: 11px; height: 11px; }
    .btn-ico svg { width: 100%; height: 100%; }
    .swap {
      display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 10px;
      border: 1px solid rgba(216, 180, 90, 0.28); background: rgba(216, 180, 90, 0.07);
    }
    .swap--failed { border-color: rgba(255, 122, 122, 0.35); background: rgba(255, 122, 122, 0.07); }
    .swap-ico { display: inline-flex; width: 16px; height: 16px; color: var(--g-gold); flex: none; }
    .swap--failed .swap-ico { color: var(--g-err); }
    .swap-ico svg { width: 100%; height: 100%; }
    .swap-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .swap-msg { font-size: 12.5px; font-weight: 550; }
    .swap-bar { height: 3px; border-radius: 99px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
    .swap-bar span { display: block; height: 100%; background: var(--g-gold); border-radius: inherit; transition: width 1s linear; }
    .swap-time { font-size: 11px; color: var(--g-muted); font-variant-numeric: tabular-nums; }
    .err { font-size: 11.5px; color: var(--g-err); }
    .log { border-top: 1px solid var(--g-line); padding-top: 8px; display: flex; flex-direction: column; gap: 4px; }
    .log-head { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--g-muted); }
    .log-row { display: flex; gap: 10px; font-size: 11.5px; }
    .log-time { color: var(--g-muted); font-variant-numeric: tabular-nums; flex: none; }
    .log-row--failed .log-msg { color: var(--g-err); }
    .spin { animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse { 50% { opacity: 0.45; } }
    @media (prefers-reduced-motion: reduce) {
      .spin, .dot--busy { animation: none; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-gpu-runtimes": GpuRuntimes;
  }
}
