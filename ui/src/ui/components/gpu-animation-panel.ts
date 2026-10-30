/**
 * GPU Animation Panel — Live mesh visualisation.
 *
 * Two engines share this panel:
 *  - neural-mesh-viz  → 3D WebGL neural network (existing)
 *  - agency-world-viz → 2D animated agency floor (upgraded)
 *
 * A small toolbar lets the operator switch between them; the choice is
 * persisted in localStorage so the panel comes back in the same mode.
 */

import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";

// Wave-1 UI chrome (side-effect imports register the custom elements).
import "./agent-focus-panel";
import "./agency-news-ticker";
import "./world-timeline-scrubber";
import type { AgentFocusPanel } from "./agent-focus-panel";
import type { AgencyNewsTicker } from "./agency-news-ticker";
import { AgencyRecorder, downloadBlob } from "../views/agent-ops/agency-recorder";
import { AudioBus } from "../views/agent-ops/agency-fx";

type VizMode = "world" | "mesh";
const STORAGE_KEY = "gpu-panel.viz-mode";

@customElement("gpu-animation-panel")
export class GPUAnimationPanel extends LitElement {
  @property({ type: Object }) client: GatewayBrowserClient | null = null;
  @property({ type: Array }) sessions: any[] = [];
  @state() private mode: VizMode = "world";
  @state() private recording = false;
  @state() private muted = AudioBus.shared().muted;

  /** Set true via ?demo / ?agency-demo query params; forwarded to the viz. */
  private demoRequested = false;
  /** Lazily-created canvas recorder (world mode only). */
  private recorder: AgencyRecorder | null = null;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background: #000;
      overflow: hidden;
      position: relative;
    }
    .stage {
      position: absolute;
      inset: 0;
    }
    neural-mesh-viz,
    agency-world-viz {
      width: 100%;
      height: 100%;
      display: block;
    }
    .toolbar {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 30;
      display: inline-flex;
      gap: 0;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid rgba(212, 175, 55, 0.45);
      border-radius: 999px;
      padding: 3px;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      font-family: "JetBrains Mono", "SF Mono", monospace;
    }
    .toolbar button {
      appearance: none;
      border: 0;
      background: transparent;
      color: #9aa2b1;
      font-size: 11px;
      letter-spacing: 1px;
      padding: 5px 12px;
      border-radius: 999px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: color 0.15s, background 0.15s;
    }
    .toolbar button.active {
      background: rgba(212, 175, 55, 0.18);
      color: #d4af37;
    }
    .toolbar button:hover:not(.active) {
      color: #d4af37;
    }
    .badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 8px;
      background: rgba(212, 175, 55, 0.25);
      color: #d4af37;
      letter-spacing: 0.6px;
    }
    /* Standalone world-mode controls (REC / mute), styled like the toolbar. */
    .world-tools {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 30;
      display: inline-flex;
      gap: 6px;
      font-family: "JetBrains Mono", "SF Mono", monospace;
    }
    .world-tools button {
      appearance: none;
      border: 1px solid rgba(212, 175, 55, 0.45);
      background: rgba(0, 0, 0, 0.55);
      color: #9aa2b1;
      font-size: 11px;
      letter-spacing: 1px;
      padding: 5px 12px;
      border-radius: 999px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      transition: color 0.15s, background 0.15s, border-color 0.15s;
    }
    .world-tools button:hover {
      color: #d4af37;
    }
    .world-tools button.recording {
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.7);
      background: rgba(239, 68, 68, 0.18);
    }
    .world-tools button .rec-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ef4444;
      box-shadow: 0 0 6px #ef4444;
    }
    .world-tools button.recording .rec-dot {
      animation: rec-blink 1.2s steps(1, end) infinite;
    }
    @keyframes rec-blink {
      0%,
      60% {
        opacity: 1;
      }
      61%,
      100% {
        opacity: 0.25;
      }
    }
    /* Bottom news strip — only mounted in world mode. */
    .news {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 25;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "mesh" || stored === "world") this.mode = stored;
    } catch {}
    // Demo flag: ?demo or ?agency-demo drives the synthetic world source.
    try {
      const qs = new URLSearchParams(location.search);
      this.demoRequested = qs.has("demo") || qs.has("agency-demo");
    } catch {}
    // Lazy-load whichever engine we start in
    if (this.mode === "mesh") {
      if (!customElements.get("neural-mesh-viz")) {
        void import("./neural-mesh-viz.js");
      }
    } else {
      if (!customElements.get("agency-world-viz")) {
        void import("./agency-world-viz.js");
      }
    }

    // Selection / news events bubble (composed) up from the viz + engine.
    this.addEventListener("agency-agent-select", this.onAgentSelect as EventListener);
    this.addEventListener("agency-node-select", this.onNodeSelect as EventListener);
    this.addEventListener("agency-news", this.onNews as EventListener);
    // Focus-panel action buttons (bubbles + composed).
    this.addEventListener("focus-open-session", this.onFocusOpenSession as EventListener);
    this.addEventListener("focus-stop", this.onFocusStop as EventListener);
    this.addEventListener("focus-open-run", this.onFocusOpenRun as EventListener);
    this.addEventListener("focus-open-oversight", this.onFocusOpenOversight as EventListener);
    this.addEventListener("agency-open-oversight", this.onFocusOpenOversight as EventListener);
    // Esc closes the focus panel while this host is connected.
    document.addEventListener("keydown", this.onKeyDown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("agency-agent-select", this.onAgentSelect as EventListener);
    this.removeEventListener("agency-node-select", this.onNodeSelect as EventListener);
    this.removeEventListener("agency-news", this.onNews as EventListener);
    this.removeEventListener("focus-open-session", this.onFocusOpenSession as EventListener);
    this.removeEventListener("focus-stop", this.onFocusStop as EventListener);
    this.removeEventListener("focus-open-run", this.onFocusOpenRun as EventListener);
    this.removeEventListener("focus-open-oversight", this.onFocusOpenOversight as EventListener);
    this.removeEventListener("agency-open-oversight", this.onFocusOpenOversight as EventListener);
    document.removeEventListener("keydown", this.onKeyDown);
    // Stop any in-flight recording without downloading.
    void this.recorder?.stop();
    this.recorder = null;
  }

  override firstUpdated(): void {
    if (this.demoRequested) this.applyDemoFlag();
    // Forward client to focus panel once mounted.
    const panel = this.focusPanel;
    if (panel && this.client) (panel as any).client = this.client;
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("client")) {
      const panel = this.focusPanel;
      if (panel) (panel as any).client = this.client;
    }
  }

  // ── Focus panel + ticker refs ──────────────────────────────────────────

  private get focusPanel(): AgentFocusPanel | null {
    return this.renderRoot?.querySelector("agent-focus-panel") ?? null;
  }
  private get ticker(): AgencyNewsTicker | null {
    return this.renderRoot?.querySelector("agency-news-ticker") ?? null;
  }

  // ── Event handlers (arrow fns so listeners can be removed) ─────────────

  private onAgentSelect = (e: CustomEvent) => {
    const panel = this.focusPanel;
    if (!panel) return;
    panel.agent = e.detail?.agent ?? null;
    panel.node = null;
    panel.open = true;
    if (this.client && !(panel as any).client) (panel as any).client = this.client;
  };

  private onNodeSelect = (e: CustomEvent) => {
    const panel = this.focusPanel;
    if (!panel) return;
    panel.node = e.detail?.node ?? null;
    panel.agent = null;
    panel.open = true;
  };

  private onNews = (e: CustomEvent) => {
    this.ticker?.push(e.detail?.text ?? "", e.detail?.ts);
  };

  private onFocusOpenSession = (e: CustomEvent) => {
    // Don't invent a switch RPC — re-dispatch for the app shell to handle.
    this.dispatchEvent(
      new CustomEvent("agency-open-session", {
        detail: { sessionKey: e.detail?.sessionKey ?? null },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private onFocusStop = (e: CustomEvent) => {
    const sessionKey = e.detail?.sessionKey ?? null;
    if (!sessionKey) return;
    void this.client?.request("agent.abort", { sessionKey });
  };

  private onFocusOpenRun = (e: CustomEvent) => {
    this.dispatchEvent(
      new CustomEvent("agency-open-run", {
        detail: { runId: e.detail?.runId ?? null },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private onFocusOpenOversight = (e: CustomEvent) => {
    const runId = e.detail?.runId ?? null;
    if (!runId) return;
    if (typeof window !== "undefined") {
      // Match the oversight page's routing: pathname /oversight resolves the
      // tab (tabFromPath is an exact match), and the review detail is keyed on
      // the hash (#review-<runId>) — a /oversight/<runId> path matches neither.
      window.history.pushState({}, "", `/oversight#review-${String(runId)}`);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      const panel = this.focusPanel;
      if (panel) panel.open = false;
    }
  };

  /** Query the <agency-world-viz> and flag it as a demo (after it mounts). */
  private applyDemoFlag(): void {
    const viz = this.renderRoot?.querySelector("agency-world-viz") as
      | (HTMLElement & { demo?: boolean })
      | null;
    if (viz) viz.demo = true;
    // The element registers asynchronously on first run; retry next tick.
    else setTimeout(() => this.applyDemoFlag(), 0);
  }

  private setMode(next: VizMode) {
    if (next === this.mode) return;
    this.mode = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    if (next === "mesh" && !customElements.get("neural-mesh-viz")) {
      void import("./neural-mesh-viz.js");
    }
    if (next === "world" && !customElements.get("agency-world-viz")) {
      void import("./agency-world-viz.js");
    }
    // Re-apply the demo flag to the freshly-mounted world viz.
    if (next === "world" && this.demoRequested) {
      void this.updateComplete.then(() => this.applyDemoFlag());
    }
  }

  // ── REC button ─────────────────────────────────────────────────────────

  private async toggleRecording(): Promise<void> {
    const canvas = (this.renderRoot?.querySelector("agency-world-viz") as any)
      ?.getCanvas?.() as HTMLCanvasElement | null | undefined;
    if (!canvas) return;
    this.recorder ??= new AgencyRecorder(canvas);
    if (!this.recording) {
      this.recorder.start();
      // Reflect actual recorder state (start() no-ops if unsupported).
      this.recording = this.recorder.recording;
    } else {
      const blob = await this.recorder.stop();
      this.recording = false;
      if (blob) {
        downloadBlob(blob, `agency-world-${new Date().toISOString()}.webm`);
      }
    }
  }

  // ── MUTE toggle ──────────────────────────────────────────────────────────

  private toggleMute(): void {
    const bus = AudioBus.shared();
    bus.muted = !bus.muted;
    this.muted = bus.muted;
  }

  override render() {
    return html`
      <div class="stage">
        ${this.mode === "world"
          ? html`
              <agency-world-viz
                .client=${this.client}
                .sessions=${this.sessions}
              ></agency-world-viz>
            `
          : html`
              <neural-mesh-viz
                .client=${this.client}
                .sessions=${this.sessions}
              ></neural-mesh-viz>
            `}
      </div>
      <div class="toolbar" role="tablist" aria-label="Mesh visualisation mode">
        <button
          class=${this.mode === "world" ? "active" : ""}
          @click=${() => this.setMode("world")}
          title="2D animated agency world"
        >
          AGENCY <span class="badge">NEW</span>
        </button>
        <button
          class=${this.mode === "mesh" ? "active" : ""}
          @click=${() => this.setMode("mesh")}
          title="3D neural mesh network"
        >
          MESH
        </button>
      </div>

      ${this.mode === "world"
        ? html`
            <div class="world-tools">
              <button
                class=${this.recording ? "recording" : ""}
                @click=${() => void this.toggleRecording()}
                title=${this.recording
                  ? "Stop recording and download clip"
                  : "Record a short clip of the agency world"}
              >
                <span class="rec-dot"></span>${this.recording ? "STOP" : "REC"}
              </button>
              <button
                @click=${() => this.toggleMute()}
                title=${this.muted ? "Unmute agency sounds" : "Mute agency sounds"}
              >
                ${this.muted ? "🔇" : "🔊"}
              </button>
            </div>
          `
        : null}

      <!-- Time-scrub replay timeline pinned to the bottom of the grid panel. -->
      ${this.mode === "world" ? html`<world-timeline-scrubber></world-timeline-scrubber>` : null}

      <!-- Mounted always so the slide-in transition can animate even when closed. -->
      <agent-focus-panel></agent-focus-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "gpu-animation-panel": GPUAnimationPanel;
  }
}
