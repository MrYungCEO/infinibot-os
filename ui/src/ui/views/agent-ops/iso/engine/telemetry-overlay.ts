/**
 * <telemetry-overlay> — toggleable engine debug HUD.
 * ──────────────────────────────────────────────────
 * A glassmorphic, top-left corner panel (~280×180) that surfaces the world
 * engine's live health: render FPS, sim tick rate, agents alive, quadtree
 * size, and per-subsystem error counts / degradation from the
 * {@link ./error-budget.ts}. Toggle with the backtick (`) hotkey.
 *
 * It is a *pure sink*: feed it snapshots either by setting the `.snapshot`
 * property each frame, or by setting `.provider = () => TelemetrySnapshot` and
 * letting the overlay self-poll on `requestAnimationFrame`. This keeps it
 * decoupled from any specific viz — the engine ships it; the viz opts in.
 *
 * Uses Shadow DOM so its styles are fully self-contained (works dropped into a
 * bare `__test.html` with no app stylesheet).
 */

import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";

export interface SubsystemTelemetry {
  name: string;
  errorCount: number;
  degraded: boolean;
}

export interface TelemetrySnapshot {
  fps: number;
  tickRate: number;
  agentsAlive: number;
  quadtreeSize: number;
  subsystems: SubsystemTelemetry[];
  lastError?: { subsystem: string; message: string } | null;
}

export type TelemetryProvider = () => TelemetrySnapshot;

const EMPTY: TelemetrySnapshot = {
  fps: 0,
  tickRate: 0,
  agentsAlive: 0,
  quadtreeSize: 0,
  subsystems: [],
  lastError: null,
};

@customElement("telemetry-overlay")
export class TelemetryOverlay extends LitElement {
  /** Latest snapshot to render. Ignored while a `provider` is set. */
  @property({ attribute: false }) snapshot: TelemetrySnapshot = EMPTY;

  /** Optional pull source — when set, the overlay self-polls each frame. */
  @property({ attribute: false }) provider: TelemetryProvider | null = null;

  /** Hotkey to toggle visibility. Default backtick. */
  @property({ type: String }) hotkey = "`";

  /** Start visible? Default false (press the hotkey to reveal). */
  @property({ type: Boolean }) defaultVisible = false;

  @state() private visible = false;
  @state() private current: TelemetrySnapshot = EMPTY;

  private rafHandle: number | null = null;
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key === this.hotkey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Don't hijack the backtick while typing in an input/textarea.
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      e.preventDefault();
      this.toggle();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.visible = this.defaultVisible;
    window.addEventListener("keydown", this.onKeyDown);
    if (this.provider) this.startPolling();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKeyDown);
    this.stopPolling();
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("provider")) {
      if (this.provider) this.startPolling();
      else this.stopPolling();
    }
    if (changed.has("snapshot") && !this.provider) {
      this.current = this.snapshot;
    }
  }

  toggle(): void {
    this.visible = !this.visible;
  }

  show(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  private startPolling(): void {
    if (this.rafHandle != null) return;
    const tick = () => {
      if (this.provider) {
        try {
          this.current = this.provider();
        } catch {
          /* never let the HUD throw */
        }
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopPolling(): void {
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  static styles = css`
    :host {
      position: fixed;
      top: 16px;
      left: 16px;
      z-index: 99999;
      font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
      pointer-events: none;
    }
    .panel {
      width: 280px;
      min-height: 180px;
      box-sizing: border-box;
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(13, 17, 28, 0.62);
      backdrop-filter: blur(18px) saturate(150%);
      -webkit-backdrop-filter: blur(18px) saturate(150%);
      border: 1px solid rgba(120, 160, 255, 0.18);
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.45),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
      color: #e6ecff;
      pointer-events: auto;
      animation: fade 0.16s ease-out;
    }
    @keyframes fade {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    .hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #8fb4ff;
    }
    .hint {
      font-size: 9px;
      opacity: 0.5;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px 12px;
      margin-bottom: 10px;
    }
    .stat {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .stat .k {
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      opacity: 0.55;
    }
    .stat .v {
      font-size: 16px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }
    .v.good {
      color: #6ee7a8;
    }
    .v.warn {
      color: #ffd166;
    }
    .v.bad {
      color: #ff7a90;
    }
    .subs {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 8px;
    }
    .subs-title {
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      opacity: 0.5;
      margin-bottom: 5px;
    }
    .sub-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      padding: 1px 0;
    }
    .sub-name {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #6ee7a8;
      box-shadow: 0 0 6px rgba(110, 231, 168, 0.6);
    }
    .dot.degraded {
      background: #ff7a90;
      box-shadow: 0 0 6px rgba(255, 122, 144, 0.7);
    }
    .dot.errored {
      background: #ffd166;
      box-shadow: 0 0 6px rgba(255, 209, 102, 0.6);
    }
    .sub-count {
      font-variant-numeric: tabular-nums;
      opacity: 0.8;
    }
    .sub-count.nonzero {
      color: #ffd166;
    }
    .empty {
      font-size: 10px;
      opacity: 0.4;
      font-style: italic;
    }
    .last-err {
      margin-top: 8px;
      font-size: 10px;
      color: #ff9fb0;
      line-height: 1.3;
      word-break: break-word;
    }
    .last-err b {
      color: #ff7a90;
    }
  `;

  render() {
    if (!this.visible) return nothing;
    const s = this.current ?? EMPTY;
    return html`
      <div class="panel" role="status" aria-label="engine telemetry">
        <div class="hdr">
          <span class="title">⚙ Engine Telemetry</span>
          <span class="hint">\` to toggle</span>
        </div>
        <div class="grid">
          <div class="stat">
            <span class="k">FPS</span>
            <span class="v ${fpsClass(s.fps)}">${Math.round(s.fps)}</span>
          </div>
          <div class="stat">
            <span class="k">Sim Tick/s</span>
            <span class="v">${Math.round(s.tickRate)}</span>
          </div>
          <div class="stat">
            <span class="k">Agents</span>
            <span class="v">${s.agentsAlive}</span>
          </div>
          <div class="stat">
            <span class="k">Quadtree</span>
            <span class="v">${s.quadtreeSize}</span>
          </div>
        </div>
        <div class="subs">
          <div class="subs-title">Subsystems</div>
          ${s.subsystems.length === 0
            ? html`<div class="empty">no subsystems registered</div>`
            : s.subsystems.map(
                (sub) => html`
                  <div class="sub-row">
                    <span class="sub-name">
                      <span
                        class="dot ${sub.degraded
                          ? "degraded"
                          : sub.errorCount > 0
                            ? "errored"
                            : ""}"
                      ></span>
                      ${sub.name}${sub.degraded
                        ? html`<span style="opacity:.6"> (degraded)</span>`
                        : nothing}
                    </span>
                    <span class="sub-count ${sub.errorCount > 0 ? "nonzero" : ""}"
                      >${sub.errorCount} err</span
                    >
                  </div>
                `,
              )}
        </div>
        ${s.lastError
          ? html`<div class="last-err">
              <b>${s.lastError.subsystem}:</b> ${s.lastError.message}
            </div>`
          : nothing}
      </div>
    `;
  }
}

function fpsClass(fps: number): string {
  if (fps >= 55) return "good";
  if (fps >= 30) return "warn";
  return "bad";
}

declare global {
  interface HTMLElementTagNameMap {
    "telemetry-overlay": TelemetryOverlay;
  }
}
