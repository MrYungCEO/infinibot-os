/**
 * Ollama Command Center — real-time local model runtime dashboard.
 *
 * Glass G7: rendered on the shared system-glass kit (views/system-glass.ts)
 * inside this element's shadow root — hero with server status LED + host /
 * auto-refresh / refresh controls, stat tiles (installed, running, VRAM,
 * sessions), GPU gauges, running models with live VRAM meters, installed
 * models as interactive glass cards, sessions, quick actions and a recessed
 * connection console. Data layer (controller polling, gateway fallback,
 * back-off on failure) is unchanged.
 */

import { html, css, nothing, LitElement } from 'lit';
import { customElement, state, property } from 'lit/decorators.js';
import type { GatewayBrowserClient } from '../gateway';
import '../local-runtimes/gpu-runtimes';
import {
  type OllamaStatus,
  type OllamaMonitorState,
  type LoadedModel,
  type AvailableModel,
  createOllamaMonitorState,
  loadStatusViaGateway,
  loadModelViaGateway,
  unloadModelViaGateway,
  formatVRAM,
  formatBytes,
  getModelShortName,
  setOllamaHost,
} from '../controllers/ollama-monitor';
import {
  systemGlassStyles,
  sgAurora,
  sgChip,
  sgEmpty,
  sgGauge,
  sgGloss,
  sgHero,
  sgIcon,
  sgLed,
  sgMeter,
  sgSkeleton,
  type SgStat,
  type SgTone,
} from './system-glass';

type ModelDetails = AvailableModel['details'] | LoadedModel['details'];

function relTime(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  const unit = s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return future ? `in ${unit}` : `${unit} ago`;
}

function modelTag(name: string): { base: string; tag: string; ns: string } {
  const [full, tag] = name.split(':');
  const path = full ?? name;
  const slash = path.lastIndexOf('/');
  return {
    base: slash >= 0 ? path.slice(slash + 1) : path,
    ns: slash >= 0 ? path.slice(0, slash) : '',
    tag: tag ?? 'latest',
  };
}

@customElement('ollama-command-center')
export class OllamaCommandCenter extends LitElement {
  static styles = [
    systemGlassStyles,
    css`
      :host {
        display: block;
        width: 100%;
        min-width: 0;
        flex: 1 0 auto;
        container-type: inline-size;
      }
      [hidden] { display: none !important; }
      .sg-ollama { padding-bottom: 24px; }
      /* Kit gauge label: keep value + caption stacked in the ring centre. */
      .sg-gauge__label { align-content: center; gap: 2px; }
      .sg-ollama .sg-hero__side { flex: 0 0 auto; max-width: 100%; }

      /* ── Hero controls ── */
      .om-host {
        display: flex; align-items: center; gap: 8px; min-width: 0;
        flex: 0 1 250px;
      }
      .om-host .sg-input { min-height: 36px; font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 12.5px; }
      .om-host__ico { flex: none; color: var(--sg-fg-3); }
      .om-auto[aria-pressed="true"] { box-shadow: inset 0 0 0 1px var(--glass-stroke-gold, rgba(217, 180, 95, 0.3)), var(--glass-specular, none); }
      .om-switch {
        position: relative; width: 28px; height: 16px; border-radius: 99px; flex: none;
        background: var(--glass-hover, rgba(255, 255, 255, 0.08));
        box-shadow: inset 0 0 0 1px var(--glass-stroke-strong, rgba(255, 255, 255, 0.13));
        transition: background var(--sg-dur) var(--sg-ease);
      }
      .om-switch::after {
        content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
        background: var(--sg-fg-2); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        transition: transform var(--sg-dur) var(--sg-spring), background var(--sg-dur);
      }
      .om-auto[aria-pressed="true"] .om-switch { background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: none; }
      .om-auto[aria-pressed="true"] .om-switch::after { transform: translateX(12px); background: var(--glass-ink, #0b0906); }
      .om-countdown { min-width: 2.2em; color: var(--sg-gold); font-variant-numeric: tabular-nums; font-size: 11.5px; }
      .om-spin { animation: om-spin 0.9s linear infinite; }
      @keyframes om-spin { to { transform: rotate(360deg); } }

      /* ── Layout ── */
      .om-main { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 18px; align-items: start; }
      .om-col { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
      .om-panel-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
      .om-panel-head .sg-h2 { display: inline-flex; align-items: center; gap: 9px; }
      .om-panel-head .sg-h2 .sg-ico { color: var(--sg-gold); }
      .om-panel-head .sg-spacer { min-width: 8px; }

      /* ── GPU ── */
      .om-gpu { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: center; }
      .om-gauge { display: grid; justify-items: center; gap: 8px; }
      .om-gauge__cap { color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
      .om-gpu__specs { grid-column: 1 / -1; display: grid; gap: 10px; min-width: 0; }
      .om-gpu__name { margin: 0; color: var(--sg-fg); font-size: 16px; font-weight: 640; letter-spacing: -0.015em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .om-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
      .om-kv > div {
        padding: 9px 11px; border-radius: var(--sg-radius-sm);
        background: var(--glass-hover, rgba(255, 255, 255, 0.04));
        box-shadow: inset 0 0 0 1px var(--glass-stroke, rgba(255, 255, 255, 0.06));
        min-width: 0;
      }
      .om-kv dt { margin: 0; color: var(--sg-fg-3); font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
      .om-kv dd { margin: 4px 0 0; color: var(--sg-fg); font-size: 14px; font-weight: 620; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .om-kv dd.is-warn { color: var(--sg-warn); }
      .om-kv dd.is-bad { color: var(--sg-bad); }
      .om-kv dd.is-ok { color: var(--sg-ok); }

      /* ── Running models ── */
      .om-running { display: grid; gap: 10px; }
      .om-run {
        display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 14px; align-items: center;
        padding: 14px 16px;
      }
      .om-run__name { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--sg-fg); font-weight: 640; font-size: 14px; }
      .om-run__name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .om-run__meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
      .om-run__bar { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
      .om-run__bar .sg-meter { flex: 1; margin-top: 6px; }
      .om-run__bar small { margin-top: 6px; color: var(--sg-fg-3); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }

      .om-load { display: flex; gap: 10px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.07)); }
      .om-load select.sg-input { flex: 1; min-width: 0; appearance: none; -webkit-appearance: none; padding-right: 34px; cursor: pointer;
        background-image: linear-gradient(45deg, transparent 50%, var(--sg-fg-3) 50%), linear-gradient(135deg, var(--sg-fg-3) 50%, transparent 50%);
        background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%;
        background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
      }
      .om-load select.sg-input option { color: #111; background: #fff; }

      /* ── Installed models ── */
      .om-models { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
      .om-model { display: flex; flex-direction: column; gap: 10px; padding: 15px 16px 14px; text-align: left; border: 0; color: inherit; font: inherit; }
      .om-model.is-selected::before { background: var(--glass-edge, rgba(217, 180, 95, 0.5)); }
      .om-model.is-selected { box-shadow: var(--glass-elev-2, none), 0 0 0 1px var(--glass-stroke-gold, rgba(217, 180, 95, 0.32)); }
      .om-model__top { display: flex; align-items: flex-start; gap: 10px; }
      .om-model__glyph {
        flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px;
        color: var(--sg-gold); background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
        box-shadow: inset 0 0 0 1px var(--glass-gold-a24, rgba(217, 180, 95, 0.24));
      }
      .om-model__id { min-width: 0; flex: 1; }
      .om-model__name { margin: 0; color: var(--sg-fg); font-size: 14px; font-weight: 650; letter-spacing: -0.012em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .om-model__tag { margin: 2px 0 0; color: var(--sg-fg-3); font-size: 11.5px; font-family: var(--glass-font-mono, ui-monospace, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .om-model__state { flex: none; display: inline-flex; align-items: center; gap: 6px; color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
      .om-model__state.is-live { color: var(--sg-ok); }
      .om-model__chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .om-model__foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.06)); }
      .om-model__size { color: var(--sg-fg); font-weight: 640; font-variant-numeric: tabular-nums; }
      .om-model__size small { color: var(--sg-fg-3); font-weight: 500; margin-left: 6px; }

      /* ── Sessions ── */
      .om-sessions { display: grid; gap: 8px; }
      .om-session { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 12px 14px; }
      .om-session__ico { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; color: var(--sg-gold); background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1)); }
      .om-session__name { color: var(--sg-fg); font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .om-session__meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 3px; color: var(--sg-fg-3); font-size: 11.5px; font-variant-numeric: tabular-nums; }

      /* ── Quick actions ── */
      .om-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .om-action { display: grid; justify-items: start; gap: 8px; padding: 14px; border: 0; color: inherit; font: inherit; text-align: left; }
      .om-action .sg-ico { color: var(--sg-gold); }
      .om-action b { color: var(--sg-fg); font-size: 13px; font-weight: 620; }
      .om-action span { color: var(--sg-fg-3); font-size: 11.5px; }

      /* ── Recessed console ── */
      .om-console {
        margin: 0; padding: 14px 16px; border-radius: var(--sg-radius-md);
        background: color-mix(in srgb, var(--glass-base, #07070a) 58%, transparent);
        box-shadow: inset 0 0 0 1px var(--glass-stroke, rgba(255, 255, 255, 0.06)), inset 0 2px 10px rgba(0, 0, 0, 0.35);
        font: 12px/1.75 var(--glass-font-mono, ui-monospace, "SF Mono", Menlo, monospace);
        color: var(--sg-fg-2); overflow-x: auto; white-space: pre-wrap; word-break: break-word;
      }
      :host-context([data-theme="light"]) .om-console { background: rgba(255, 255, 255, 0.55); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong, rgba(0, 0, 0, 0.1)), inset 0 1px 4px rgba(60, 45, 20, 0.08); }
      .om-console .k { color: var(--sg-fg-3); }
      .om-console .p { color: var(--sg-gold); }
      .om-console .ok { color: var(--sg-ok); }
      .om-console .bad { color: var(--sg-bad); }
      .om-copied { color: var(--sg-ok); font-size: 11.5px; font-weight: 600; }

      code.om-code {
        padding: 2px 7px; border-radius: 7px; color: var(--sg-gold);
        background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
        font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 0.92em;
      }

      .om-skel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }

      /* ── Responsive (container-based so an embedded copy reflows too) ── */
      @container (max-width: 1080px) {
        .om-main { grid-template-columns: minmax(0, 1fr); }
      }
      @container (max-width: 640px) {
        .om-host { flex: 1 1 100%; }
        .sg-ollama .sg-hero__side { flex: 1 1 100%; }
        .om-actions { grid-template-columns: minmax(0, 1fr); }
        .om-run { grid-template-columns: minmax(0, 1fr); }
        .om-run > .sg-led { display: none; }
        .om-run .sg-btn { justify-self: start; }
        .om-load { flex-direction: column; }
        .om-models, .om-skel-grid { grid-template-columns: minmax(0, 1fr); }
      }
      @media (prefers-reduced-motion: reduce) {
        .om-spin { animation: none; }
        .om-switch, .om-switch::after { transition: none; }
      }
    `,
  ];

  @state() private _state: OllamaMonitorState = createOllamaMonitorState();
  @state() private _loading = false;
  @state() private _countdown = 5;
  @state() private _selectedModel = '';
  @state() private _hostInput = '';

  @property({ type: String }) ollamaHost = 'http://127.0.0.1:11434';

  /*
   * The gateway already polls Ollama server-side. Preferring it means the panel
   * works for a host the browser can't reach directly (LAN address, no CORS
   * headers) — a direct fetch there never settles, which pinned this view on a
   * loading spinner forever. `*ViaGateway` still falls back to the direct API
   * when no client is set.
   */
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  private _refreshTimer: number | null = null;
  private _countdownTimer: number | null = null;

  connectedCallback() {
    super.connectedCallback();
    this._state.ollamaHost = this.ollamaHost || this._state.ollamaHost;
    this._hostInput = this._state.ollamaHost;
    this.loadStatus();
    if (this._state.autoRefresh) {
      this.startAutoRefresh();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopAutoRefresh();
  }

  /*
   * connectedCallback fires before the host has committed `.client`, so the
   * very first poll would go out over the direct API and stall for the whole
   * fetch timeout before the panel could paint. Re-poll the moment the client
   * actually lands.
   */
  updated(changed: Map<string, unknown>) {
    if (changed.has('client') && this.client) this.loadStatus();
  }

  private _consecutiveFailures = 0;

  /*
   * A poll started before `.client` landed goes out over the (slow, often
   * unreachable) direct API. When the gateway-backed poll that replaces it
   * finishes first, the stale answer must not overwrite it — hence the
   * sequence guard on every write below.
   */
  private _loadSeq = 0;

  private async loadStatus() {
    const seq = ++this._loadSeq;
    this._loading = true;
    this.requestUpdate();

    try {
      const status = await loadStatusViaGateway(this.client, this._state.ollamaHost);
      if (seq !== this._loadSeq) return;
      this._state = {
        ...this._state,
        status,
        error: status.error || null,
        lastRefresh: Date.now(),
      };
      
      // Reset failures on successful connect or slow down polling when offline
      if (status.online) {
        if (this._consecutiveFailures > 0) {
          // Server came back online - restore fast polling
          this._consecutiveFailures = 0;
          if (this._state.refreshInterval !== 5000) {
            this.stopAutoRefresh();
            this._state.refreshInterval = 5000;
            if (this._state.autoRefresh) this.startAutoRefresh();
            console.log('[OllamaMonitor] Server online, restoring 5s polling');
          }
        }
      } else {
        this._consecutiveFailures++;
        // After 3 failures, slow down to 30s polling
        if (this._consecutiveFailures >= 3 && this._state.autoRefresh) {
          this.stopAutoRefresh();
          this._state.refreshInterval = 30000;
          this.startAutoRefresh();
          console.log('[OllamaMonitor] Server offline, slowing poll to 30s');
        }
      }
    } catch (err: any) {
      if (seq !== this._loadSeq) return;
      this._consecutiveFailures++;
      this._state = {
        ...this._state,
        error: err.message || 'Failed to connect',
      };
      
      // Slow down after repeated failures
      if (this._consecutiveFailures >= 3 && this._state.autoRefresh) {
        this.stopAutoRefresh();
        this._state.refreshInterval = 30000;
        this.startAutoRefresh();
      }
    }

    this._loading = false;
    this.requestUpdate();
  }

  private startAutoRefresh() {
    this.stopAutoRefresh();
    this._countdown = Math.floor(this._state.refreshInterval / 1000);
    
    this._countdownTimer = window.setInterval(() => {
      this._countdown--;
      if (this._countdown <= 0) {
        this._countdown = Math.floor(this._state.refreshInterval / 1000);
      }
      this.requestUpdate();
    }, 1000);

    /*
     * Skip the tick while a poll is still out. Against an unreachable Ollama
     * host the status call can take longer than the 5s interval, and firing a
     * fresh poll on top of it meant each one was superseded before it landed —
     * the panel never left its loading spinner.
     */
    this._refreshTimer = window.setInterval(() => {
      if (this._loading) return;
      this.loadStatus();
    }, this._state.refreshInterval);
  }

  private stopAutoRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  }

  private toggleAutoRefresh() {
    this._state = {
      ...this._state,
      autoRefresh: !this._state.autoRefresh,
    };

    if (this._state.autoRefresh) {
      this.startAutoRefresh();
    } else {
      this.stopAutoRefresh();
    }
    this.requestUpdate();
  }

  private async handleLoadModel() {
    if (!this._selectedModel) return;

    this._loading = true;
    this.requestUpdate();

    const result = await loadModelViaGateway(this.client, this._state.ollamaHost, this._selectedModel);
    if (!result.success) {
      this._state = { ...this._state, error: result.error || 'Failed to load model' };
    }

    await this.loadStatus();
    this._selectedModel = '';
  }

  private async handleUnloadModel(name: string) {
    this._loading = true;
    this.requestUpdate();

    const result = await unloadModelViaGateway(this.client, this._state.ollamaHost, name);
    if (!result.success) {
      this._state = { ...this._state, error: result.error || 'Failed to unload model' };
    }

    await this.loadStatus();
  }

  private handleHostChange() {
    if (this._hostInput && this._hostInput !== this._state.ollamaHost) {
      setOllamaHost(this._hostInput);
      this._state = { ...this._state, ollamaHost: this._hostInput };
      this.loadStatus();
    }
  }

  private getTempClass(temp: number | undefined): string {
    if (!temp) return 'cool';
    if (temp >= 80) return 'hot';
    if (temp >= 60) return 'warm';
    return 'cool';
  }

  /** Brief "Copied" confirmation for the copy actions (display only). */
  @state() private _copied = '';
  private _copiedTimer: number | null = null;

  private copyText(text: string, key: string) {
    void navigator.clipboard?.writeText(text);
    this._copied = key;
    if (this._copiedTimer) clearTimeout(this._copiedTimer);
    this._copiedTimer = window.setTimeout(() => { this._copied = ''; }, 1600);
  }

  private renderChips(d: ModelDetails | undefined) {
    if (!d) return nothing;
    const fams = (d.families?.length ? d.families : d.family ? [d.family] : []).filter(
      (f, i, a) => a.indexOf(f) === i,
    );
    return html`
      ${d.parameter_size ? sgChip(d.parameter_size, 'gold') : nothing}
      ${d.quantization_level ? sgChip(d.quantization_level) : nothing}
      ${fams.slice(0, 3).map((f) => sgChip(f))}
      ${d.format && d.format !== 'gguf' ? sgChip(d.format) : nothing}
    `;
  }

  private renderHeroActions() {
    const auto = this._state.autoRefresh;
    return html`
      <label class="om-host" title="Ollama host">
        <span class="om-host__ico">${sgIcon('link', 15)}</span>
        <input
          class="sg-input"
          type="text"
          aria-label="Ollama host"
          .value=${this._hostInput}
          @input=${(e: Event) => this._hostInput = (e.target as HTMLInputElement).value}
          @blur=${() => this.handleHostChange()}
          @keyup=${(e: KeyboardEvent) => e.key === 'Enter' && this.handleHostChange()}
          placeholder="Ollama Host"
        />
      </label>
      <button
        type="button"
        class="sg-btn om-auto auto-refresh-toggle ${auto ? 'active' : ''}"
        aria-pressed=${auto ? 'true' : 'false'}
        title=${auto ? 'Auto-refresh on — click to pause' : 'Auto-refresh paused — click to resume'}
        @click=${() => this.toggleAutoRefresh()}
      >
        <span class="om-switch" aria-hidden="true"></span>
        Auto
        ${auto ? html`<span class="om-countdown countdown">${this._countdown}s</span>` : nothing}
      </button>
      <button class="sg-btn sg-btn--primary" @click=${() => this.loadStatus()} ?disabled=${this._loading}>
        <span class=${this._loading ? 'om-spin' : ''} style="display:inline-flex">${sgIcon('refresh', 15)}</span>
        Refresh
      </button>
    `;
  }

  private renderGpuPanel(s: OllamaStatus, usedVRAM: number, totalVRAM: number, vramPercent: number) {
    const gpu = s.gpu;
    const util = gpu?.utilization;
    const temp = gpu?.temperature;
    const tempCls = this.getTempClass(temp);
    return html`
      <section class="sg-panel sg-enter" aria-label="GPU status">
        <div class="om-panel-head">
          <h2 class="sg-h2">${sgIcon('chip', 17)} GPU</h2>
          <span class="sg-spacer"></span>
          ${gpu ? sgChip(gpu.name || 'GPU', 'gold') : sgChip('No GPU telemetry')}
        </div>
        <div class="om-gpu">
          <div class="om-gauge">
            ${sgGauge(vramPercent / 100, { size: 112, caption: 'VRAM' })}
            <span class="om-gauge__cap">Models in VRAM</span>
          </div>
          ${util !== undefined
            ? html`<div class="om-gauge">
                ${sgGauge(util / 100, { size: 112, caption: 'Util' })}
                <span class="om-gauge__cap">Compute</span>
              </div>`
            : html`<div class="om-gauge">
                ${sgGauge(0, { size: 112, label: '—', caption: 'Util', autoTone: false })}
                <span class="om-gauge__cap">No util data</span>
              </div>`}
          <div class="om-gpu__specs">
            <p class="om-gpu__name" title=${gpu?.name || 'GPU'}>${gpu?.name || 'VRAM budget'}</p>
            ${gpu ? nothing : html`<p class="sg-faint" style="margin:0;font-size:12px">The gateway reports no GPU telemetry — VRAM share assumes ${formatVRAM(totalVRAM)}.</p>`}
            <dl class="om-kv">
              <div><dt>VRAM</dt><dd>${formatVRAM(usedVRAM)} / ${formatVRAM(totalVRAM)}</dd></div>
              <div><dt>Temp</dt><dd class=${tempCls === 'hot' ? 'is-bad' : tempCls === 'warm' ? 'is-warn' : temp ? 'is-ok' : ''}>${temp ?? '--'}°C</dd></div>
              ${gpu?.powerDraw !== undefined
                ? html`<div><dt>Power</dt><dd>${gpu.powerDraw}W / ${gpu.powerLimit ?? '--'}W</dd></div>`
                : nothing}
            </dl>
          </div>
        </div>
      </section>
    `;
  }

  private renderRunning(loadedModels: LoadedModel[], unloadedModels: AvailableModel[], totalVRAM: number) {
    return html`
      <section class="sg-panel sg-enter" aria-label="Running models">
        <div class="om-panel-head">
          <h2 class="sg-h2">${sgIcon('activity', 17)} Running models</h2>
          <span class="sg-spacer"></span>
          ${sgChip(`${loadedModels.length} active`, loadedModels.length ? 'ok' : undefined, loadedModels.length > 0)}
        </div>
        ${loadedModels.length === 0
          ? sgEmpty({
              icon: 'layers',
              title: 'No models loaded',
              body: unloadedModels.length
                ? 'Pick an installed model below to warm it into memory — the first request is instant afterwards.'
                : html`Pull one first with <code class="om-code">ollama pull llama3.2</code>, then load it here.`,
            })
          : html`<div class="om-running">
              ${loadedModels.map((model) => {
                const vram = model.size_vram || model.size;
                const share = totalVRAM > 0 ? vram / totalVRAM : 0;
                const offload = model.size > 0 && model.size_vram < model.size;
                return html`
                  <div class="sg-card om-run">
                    ${sgLed('ok')}
                    <div style="min-width:0">
                      <div class="om-run__name"><span title=${model.name}>${getModelShortName(model.name)}</span></div>
                      <div class="om-run__meta">
                        ${this.renderChips(model.details)}
                        ${offload ? sgChip('partial CPU offload', 'warn') : nothing}
                        ${model.expires_at ? sgChip(html`${sgIcon('activity', 11)} unloads ${relTime(model.expires_at)}`) : nothing}
                      </div>
                      <div class="om-run__bar">
                        ${sgMeter(share, share >= 0.9 ? 'bad' : share >= 0.75 ? 'warn' : undefined)}
                        <small>${formatVRAM(vram)} · ${Math.round(share * 100)}% VRAM</small>
                      </div>
                    </div>
                    <button
                      class="sg-btn sg-btn--sm sg-btn--danger btn-unload"
                      @click=${() => this.handleUnloadModel(model.name)}
                      ?disabled=${this._loading}
                    >
                      ${sgIcon('close', 13)} Unload
                    </button>
                  </div>
                `;
              })}
            </div>`}

        ${unloadedModels.length > 0 ? html`
          <div class="om-load load-model-section">
            <select
              class="sg-input model-select"
              aria-label="Model to load"
              .value=${this._selectedModel}
              @change=${(e: Event) => this._selectedModel = (e.target as HTMLSelectElement).value}
            >
              <option value="">+ Load Model...</option>
              ${unloadedModels.map(model => html`
                <option value=${model.name} ?selected=${model.name === this._selectedModel}>
                  ${getModelShortName(model.name)} (${formatBytes(model.size)})
                </option>
              `)}
            </select>
            <button
              class="sg-btn sg-btn--primary"
              @click=${() => this.handleLoadModel()}
              ?disabled=${!this._selectedModel || this._loading}
            >
              ${sgIcon('play', 14)} Load
            </button>
          </div>
        ` : nothing}
      </section>
    `;
  }

  private renderInstalled(availableModels: AvailableModel[], loadedModels: LoadedModel[]) {
    const sorted = [...availableModels].sort((a, b) => b.size - a.size);
    return html`
      <section class="sg-panel sg-enter" aria-label="Installed models">
        <div class="om-panel-head">
          <h2 class="sg-h2">${sgIcon('database', 17)} Installed models</h2>
          <span class="sg-spacer"></span>
          ${sgChip(`${availableModels.length} on disk`)}
        </div>
        ${sorted.length === 0
          ? sgEmpty({
              icon: 'download',
              title: 'No models installed yet',
              body: html`Pull a model from the Ollama library, e.g. <code class="om-code">ollama pull llama3.2</code> — it shows up here on the next refresh.`,
            })
          : html`<div class="om-models">
              ${sorted.map((m) => {
                const live = loadedModels.some((lm) => lm.name === m.name);
                const selected = this._selectedModel === m.name;
                const { base, tag, ns } = modelTag(m.name);
                return html`
                  <div
                    class="sg-card sg-card--interactive om-model ${selected ? 'is-selected' : ''}"
                    role="button"
                    tabindex="0"
                    aria-pressed=${selected ? 'true' : 'false'}
                    title=${live ? `${m.name} is loaded` : `Select ${m.name} to load`}
                    @pointermove=${sgGloss}
                    @click=${() => { if (!live) this._selectedModel = selected ? '' : m.name; }}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.target !== e.currentTarget) return;
                      if ((e.key === 'Enter' || e.key === ' ') && !live) {
                        e.preventDefault();
                        this._selectedModel = selected ? '' : m.name;
                      }
                    }}
                  >
                    <div class="om-model__top">
                      <span class="om-model__glyph">${sgIcon('layers', 18)}</span>
                      <div class="om-model__id">
                        <p class="om-model__name" title=${m.name}>${base}</p>
                        <p class="om-model__tag">${ns ? `${ns} · ` : ''}:${tag}</p>
                      </div>
                      <span class="om-model__state ${live ? 'is-live' : ''}">
                        ${sgLed(live ? 'ok' : selected ? 'gold' : 'off')}${live ? 'Live' : selected ? 'Selected' : 'Idle'}
                      </span>
                    </div>
                    <div class="om-model__chips">${this.renderChips(m.details)}</div>
                    <div class="om-model__foot">
                      <span class="om-model__size">${formatBytes(m.size)}<small>${relTime(m.modified_at) ? `updated ${relTime(m.modified_at)}` : ''}</small></span>
                      ${live
                        ? html`<button class="sg-btn sg-btn--sm sg-btn--ghost"
                            @click=${(e: Event) => { e.stopPropagation(); this.handleUnloadModel(m.name); }}
                            ?disabled=${this._loading}>Unload</button>`
                        : html`<button class="sg-btn sg-btn--sm"
                            @click=${(e: Event) => { e.stopPropagation(); this._selectedModel = m.name; void this.handleLoadModel(); }}
                            ?disabled=${this._loading}>${sgIcon('play', 12)} Load</button>`}
                    </div>
                  </div>
                `;
              })}
            </div>`}
      </section>
    `;
  }

  private renderSessions(s: OllamaStatus) {
    const sessions = s.activeSessions ?? [];
    return html`
      <section class="sg-panel sg-enter" aria-label="Active sessions">
        <div class="om-panel-head">
          <h2 class="sg-h2">${sgIcon('users', 17)} Active sessions</h2>
          <span class="sg-spacer"></span>
          ${sgChip(`${sessions.length} active`, sessions.length ? 'ok' : undefined, sessions.length > 0)}
        </div>
        ${!sessions.length
          ? sgEmpty({
              icon: 'user',
              title: 'No active sessions',
              body: 'Sessions appear here while agents or chats are generating with a local model.',
            })
          : html`<div class="om-sessions sessions-list">
              ${sessions.map(session => html`
                <div class="sg-card om-session session-card">
                  <span class="om-session__ico">${sgIcon(session.name.includes('agent') ? 'spark' : 'user', 16)}</span>
                  <div style="min-width:0">
                    <div class="om-session__name">${session.name}</div>
                    <div class="om-session__meta">
                      <span>${session.model}</span>
                      <span>${session.tokensPerMin} tok/min</span>
                      <span>${(session.totalTokens / 1000).toFixed(1)}k tokens</span>
                    </div>
                  </div>
                  ${sgLed(session.isActive ? 'ok' : 'off')}
                </div>
              `)}
            </div>`}
      </section>
    `;
  }

  private renderQuickActions() {
    return html`
      <section class="sg-panel sg-enter" aria-label="Quick actions">
        <div class="om-panel-head">
          <h2 class="sg-h2">${sgIcon('bolt', 17)} Quick actions</h2>
        </div>
        <div class="om-actions quick-actions">
          <button class="sg-card sg-card--interactive om-action action-btn" @pointermove=${sgGloss}
            @click=${() => window.open(this._state.ollamaHost, '_blank')}>
            ${sgIcon('globe', 18)}<b>Open Ollama</b><span>Server root in a new tab</span>
          </button>
          <button class="sg-card sg-card--interactive om-action action-btn" @pointermove=${sgGloss}
            @click=${() => this.loadStatus()}>
            ${sgIcon('activity', 18)}<b>View Stats</b><span>Poll the server now</span>
          </button>
          <button class="sg-card sg-card--interactive om-action action-btn" @pointermove=${sgGloss}
            @click=${() => this.copyText(this._state.ollamaHost, 'api')}>
            ${sgIcon('copy', 18)}<b>Copy API URL</b>
            ${this._copied === 'api' ? html`<span class="om-copied">Copied</span>` : html`<span>${this._state.ollamaHost}</span>`}
          </button>
        </div>
      </section>
    `;
  }

  private renderConsole(isOnline: boolean) {
    const st = this._state;
    const last = st.lastRefresh ? new Date(st.lastRefresh).toLocaleTimeString() : '—';
    return html`
      <section class="sg-panel sg-enter" aria-label="Connection console">
        <div class="om-panel-head">
          <h2 class="sg-h2">${sgIcon('server', 17)} Connection</h2>
          <span class="sg-spacer"></span>
          <button class="sg-btn sg-btn--sm sg-btn--ghost"
            @click=${() => this.copyText(`curl ${st.ollamaHost}/api/tags`, 'curl')}>
            ${sgIcon('copy', 13)} ${this._copied === 'curl' ? 'Copied' : 'Copy curl'}
          </button>
        </div>
        <pre class="om-console"><span class="k">host     </span> ${st.ollamaHost}
<span class="k">status   </span> ${isOnline ? html`<span class="ok">online</span>` : html`<span class="bad">offline</span>`}${st.status?.version ? ` · v${st.status.version}` : ''}
<span class="k">via      </span> ${this.client ? 'gateway (server-side poll)' : 'direct API'}
<span class="k">polling  </span> ${st.autoRefresh ? `every ${Math.round(st.refreshInterval / 1000)}s` : 'paused'}
<span class="k">last poll</span> ${last}${st.error ? html`
<span class="k">error    </span> <span class="bad">${st.error}</span>` : nothing}
<span class="p">$</span> curl ${st.ollamaHost}/api/tags</pre>
      </section>
    `;
  }

  render() {
    const s = this._state.status;
    const isOnline = s?.online ?? false;
    const loadedModels = s?.loadedModels || [];
    const availableModels = s?.availableModels || [];
    const unloadedModels = availableModels.filter(
      m => !loadedModels.some(lm => lm.name === m.name)
    );

    // Calculate VRAM usage
    const totalVRAM = s?.gpu?.totalVRAM || 32 * 1024 * 1024 * 1024;
    const usedVRAM = loadedModels.reduce((sum, m) => sum + (m.size_vram || m.size || 0), 0);
    const vramPercent = Math.min((usedVRAM / totalVRAM) * 100, 100);

    const booting = !s && !this._state.error;
    const statusTone: SgTone = booting ? 'gold' : isOnline ? 'ok' : 'bad';
    const statusLabel = booting
      ? 'Connecting'
      : isOnline
        ? `Online${s?.version ? ` · v${s.version}` : ''}`
        : 'Offline';

    const diskTotal = availableModels.reduce((sum, m) => sum + (m.size || 0), 0);
    const sessions = s?.activeSessions ?? [];
    const tokPerMin = sessions.reduce((sum, x) => sum + (x.tokensPerMin || 0), 0);
    const stats: SgStat[] = isOnline
      ? [
          { label: 'Installed', icon: 'database', value: availableModels.length, foot: diskTotal ? `${formatBytes(diskTotal)} on disk` : 'no models pulled' },
          { label: 'Running', icon: 'activity', value: loadedModels.length, tone: loadedModels.length ? 'ok' : undefined, foot: loadedModels.length ? loadedModels.map((m) => getModelShortName(m.name)).join(', ') : 'nothing in memory' },
          { label: 'VRAM used', icon: 'chip', value: formatVRAM(usedVRAM), meter: vramPercent / 100, foot: `of ${formatVRAM(totalVRAM)} · ${Math.round(vramPercent)}%` },
          { label: 'Sessions', icon: 'users', value: sessions.length, foot: sessions.length ? `${tokPerMin} tok/min` : 'idle' },
        ]
      : [];

    return html`
      <div class="sg-page sg-ollama container">
        ${sgAurora()}
        ${sgHero({
          eyebrow: 'Fleet · Local models',
          title: 'Ollama',
          accent: 'Runtime',
          icon: 'server',
          sub: html`Local model server at <span class="sg-mono">${this._state.ollamaHost}</span> — load, unload and watch VRAM in real time.`,
          status: { tone: statusTone, label: statusLabel },
          actions: this.renderHeroActions(),
          stats,
        })}

        ${booting ? html`
          <div class="om-main" aria-busy="true">
            <div class="om-col">
              <div class="sg-panel">${sgSkeleton(3)}<div style="height:16px"></div>${sgSkeleton(1, true)}</div>
              <div class="sg-panel"><div class="om-skel-grid">${sgSkeleton(1, true)}${sgSkeleton(1, true)}${sgSkeleton(1, true)}</div></div>
            </div>
            <div class="om-col"><div class="sg-panel">${sgSkeleton(4)}</div></div>
          </div>
        ` : nothing}

        ${!isOnline && !booting ? html`
          <div class="om-main">
            <section class="sg-panel sg-enter">
              ${sgEmpty({
                icon: 'alert',
                title: "Ollama isn't running",
                body: html`Nothing answered at <code class="om-code">${this._state.ollamaHost}</code>. Start it with
                  <code class="om-code">ollama serve</code> (or open the Ollama app), then retry.
                  ${this._state.error ? html`<br /><span class="sg-faint">${this._state.error}</span>` : nothing}`,
                action: html`<div class="sg-actions" style="justify-content:center">
                  <button class="sg-btn sg-btn--primary" @click=${() => this.loadStatus()} ?disabled=${this._loading}>
                    ${sgIcon('refresh', 14)} Retry Connection
                  </button>
                  <button class="sg-btn" @click=${() => this.copyText('ollama serve', 'serve')}>
                    ${sgIcon('copy', 14)} ${this._copied === 'serve' ? 'Copied' : 'Copy command'}
                  </button>
                </div>`,
              })}
            </section>
            <div class="om-col"><ib-gpu-runtimes></ib-gpu-runtimes>${this.renderConsole(false)}</div>
          </div>
        ` : nothing}

        ${isOnline && s ? html`
          <div class="om-main">
            <div class="om-col">
              ${this.renderRunning(loadedModels, unloadedModels, totalVRAM)}
              ${this.renderInstalled(availableModels, loadedModels)}
            </div>
            <div class="om-col">
              <ib-gpu-runtimes></ib-gpu-runtimes>
              ${this.renderGpuPanel(s, usedVRAM, totalVRAM, vramPercent)}
              ${this.renderSessions(s)}
              ${this.renderQuickActions()}
              ${this.renderConsole(true)}
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ollama-command-center': OllamaCommandCenter;
  }
}

// Export render function for integration
export function renderOllamaMonitor(container: HTMLElement, ollamaHost = 'http://localhost:11434') {
  const el = document.createElement('ollama-command-center') as OllamaCommandCenter;
  el.ollamaHost = ollamaHost;
  container.innerHTML = '';
  container.appendChild(el);
  return el;
}
