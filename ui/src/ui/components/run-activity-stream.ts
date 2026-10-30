/**
 * <run-activity-stream> — Live SSE-backed run output viewer.
 *
 * Connects to GET /api/runs/:runId/stream, replays buffered lines, then
 * streams new ones in real time. Renders a scrolling terminal-style log
 * with gold/glass styling matching the InfiniBot design language.
 *
 * Usage:
 *   <run-activity-stream .runId=${"abc123"} .gateway=${client}></run-activity-stream>
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { gatewayOrigin } from "../gateway-endpoint";

interface StreamLine {
  lineType: "tool" | "checkpoint" | "progress" | "lifecycle" | "status";
  text: string;
  ts: number;
}

@customElement("run-activity-stream")
export class RunActivityStream extends LitElement {
  @property({ type: String }) runId = "";
  @property({ type: String }) gatewayOrigin = "";

  @state() private _lines: StreamLine[] = [];
  @state() private _status: "idle" | "connecting" | "live" | "closed" | "error" = "idle";
  @state() private _paused = false;

  private _es: EventSource | null = null;
  private _bottom: Element | null = null;
  private _scrollObserver: IntersectionObserver | null = null;

  static styles = css`
    :host {
      display: block;
      --ras-bg: rgba(4, 6, 12, 0.92);
      --ras-border: rgba(212, 166, 58, 0.35);
      --ras-gold: #d4a63a;
      --ras-gold-dim: rgba(212, 166, 58, 0.55);
      --ras-green: #22d3a0;
      --ras-red: #ef4444;
      --ras-cyan: #22d3ee;
      --ras-purple: #a78bfa;
      --ras-text: rgba(240, 235, 220, 0.88);
      --ras-dim: rgba(180, 170, 150, 0.5);
      --ras-radius: 10px;
      font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace;
    }

    .ras-shell {
      background: var(--ras-bg);
      border: 1px solid var(--ras-border);
      border-radius: var(--ras-radius);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: 280px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(212, 166, 58, 0.08);
      backdrop-filter: blur(20px);
    }

    .ras-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      background: rgba(212, 166, 58, 0.06);
      border-bottom: 1px solid rgba(212, 166, 58, 0.15);
      flex-shrink: 0;
    }

    .ras-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--ras-dim);
      flex-shrink: 0;
    }
    .ras-dot.live { background: var(--ras-green); box-shadow: 0 0 6px var(--ras-green); animation: pulse 1.6s ease-in-out infinite; }
    .ras-dot.error { background: var(--ras-red); }
    .ras-dot.closed { background: var(--ras-gold-dim); }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .ras-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ras-gold);
      flex: 1;
    }

    .ras-badge {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 4px;
      border: 1px solid var(--ras-border);
      color: var(--ras-dim);
    }
    .ras-badge.live { color: var(--ras-green); border-color: rgba(34, 211, 160, 0.4); }
    .ras-badge.error { color: var(--ras-red); border-color: rgba(239, 68, 68, 0.4); }

    .ras-pause-btn {
      background: none;
      border: 1px solid var(--ras-border);
      border-radius: 4px;
      color: var(--ras-dim);
      font-size: 10px;
      padding: 2px 7px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .ras-pause-btn:hover { color: var(--ras-gold); border-color: var(--ras-gold-dim); }

    .ras-log {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
      scroll-behavior: smooth;
    }
    .ras-log::-webkit-scrollbar { width: 4px; }
    .ras-log::-webkit-scrollbar-track { background: transparent; }
    .ras-log::-webkit-scrollbar-thumb { background: rgba(212, 166, 58, 0.2); border-radius: 2px; }

    .ras-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--ras-dim);
      font-size: 12px;
      gap: 8px;
    }

    .ras-spinner {
      width: 12px; height: 12px;
      border: 2px solid rgba(212, 166, 58, 0.2);
      border-top-color: var(--ras-gold-dim);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .ras-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 2px 14px;
      font-size: 11.5px;
      line-height: 1.55;
      color: var(--ras-text);
      transition: background 0.1s;
    }
    .ras-row:hover { background: rgba(212, 166, 58, 0.04); }

    .ras-time {
      color: var(--ras-dim);
      font-size: 10px;
      flex-shrink: 0;
      user-select: none;
      width: 42px;
      text-align: right;
    }

    .ras-text { flex: 1; overflow-wrap: break-word; word-break: break-all; white-space: pre-wrap; }

    /* Line type colors */
    .ras-row[data-kind="tool"] .ras-text { color: var(--ras-text); }
    .ras-row[data-kind="tool"] .ras-text:first-line { }
    .ras-row[data-kind="tool"][data-ok="true"] .ras-text { color: rgba(200, 220, 200, 0.7); }
    .ras-row[data-kind="tool"][data-err="true"] .ras-text { color: var(--ras-red); }
    .ras-row[data-kind="checkpoint"] .ras-text { color: var(--ras-cyan); }
    .ras-row[data-kind="progress"] .ras-text { color: var(--ras-gold); }
    .ras-row[data-kind="lifecycle"] .ras-text { color: var(--ras-green); font-weight: 600; }

    .ras-bottom-anchor { height: 1px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.runId) this._connect();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._teardown();
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("runId") && this.runId) {
      this._teardown();
      this._lines = [];
      this._status = "idle";
      this._connect();
    }
  }

  private _resolveOrigin(): string {
    if (this.gatewayOrigin) return this.gatewayOrigin;
    return gatewayOrigin();
  }

  private _connect(): void {
    if (!this.runId) return;
    this._status = "connecting";

    const url = `${this._resolveOrigin()}/api/runs/${encodeURIComponent(this.runId)}/stream`;
    const es = new EventSource(url);
    this._es = es;

    es.onopen = () => {
      this._status = "live";
    };

    es.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data as string) as {
          type: string;
          lineType?: StreamLine["lineType"];
          text?: string;
          ts?: number;
        };
        if (payload.type === "line" && payload.text) {
          this._pushLine({
            lineType: payload.lineType ?? "status",
            text: payload.text,
            ts: payload.ts ?? Date.now(),
          });
        } else if (payload.type === "complete") {
          this._status = "closed";
        }
      } catch {
        /* malformed — ignore */
      }
    };

    es.onerror = () => {
      if (this._status !== "closed") this._status = "error";
      es.close();
    };
  }

  private _teardown(): void {
    this._es?.close();
    this._es = null;
    this._scrollObserver?.disconnect();
    this._scrollObserver = null;
  }

  private _pushLine(line: StreamLine): void {
    this._lines = [...this._lines, line];
    if (!this._paused) {
      this.updateComplete.then(() => {
        this._bottom?.scrollIntoView({ behavior: "auto", block: "end" });
      });
    }
  }

  private _onLogScroll(e: Event): void {
    const el = e.target as HTMLElement;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom && this._paused) {
      this._paused = false;
    } else if (!nearBottom && !this._paused) {
      this._paused = true;
    }
  }

  private _timeLabel(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  render() {
    const statusLabel =
      this._status === "connecting"
        ? "Connecting…"
        : this._status === "live"
          ? "Live"
          : this._status === "closed"
            ? "Ended"
            : this._status === "error"
              ? "Error"
              : "Idle";

    return html`
      <div class="ras-shell">
        <div class="ras-header">
          <div class="ras-dot ${this._status === "live" ? "live" : this._status === "error" ? "error" : this._status === "closed" ? "closed" : ""}"></div>
          <span class="ras-label">Activity Stream</span>
          <span class="ras-badge ${this._status === "live" ? "live" : this._status === "error" ? "error" : ""}">${statusLabel}</span>
          ${this._lines.length > 0
            ? html`<button class="ras-pause-btn" @click=${() => { this._paused = !this._paused; }}>
                ${this._paused ? "▶ Resume" : "⏸ Pause"}
              </button>`
            : nothing}
        </div>
        <div class="ras-log" @scroll=${this._onLogScroll}>
          ${this._lines.length === 0
            ? html`<div class="ras-empty">
                ${this._status === "connecting"
                  ? html`<div class="ras-spinner"></div><span>Connecting…</span>`
                  : this._status === "live"
                    ? html`<span>Waiting for activity…</span>`
                    : html`<span>No activity recorded</span>`}
              </div>`
            : this._lines.map(
                (line) => html`
                  <div class="ras-row"
                    data-kind=${line.lineType}
                    data-ok=${line.lineType === "tool" && line.text.startsWith("✓") ? "true" : "false"}
                    data-err=${line.lineType === "tool" && line.text.startsWith("✗") ? "true" : "false"}
                  >
                    <span class="ras-time">${this._timeLabel(line.ts)}</span>
                    <span class="ras-text">${line.text}</span>
                  </div>
                `,
              )}
          <div class="ras-bottom-anchor" ${ref((el) => { this._bottom = el ?? null; })}></div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "run-activity-stream": RunActivityStream;
  }
}
