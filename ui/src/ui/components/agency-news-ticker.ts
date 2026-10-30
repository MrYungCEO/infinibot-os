/**
 * Agency News Ticker — bottom marquee strip for the live agency world.
 *
 * A thin (~40px) gold-on-dark monospace ribbon that scrolls the last 8 world
 * events horizontally, broadcast-style. The engine dispatches "agency-news"
 * CustomEvents (detail {ts,text}); the host can either listen for those and
 * call push(), or set the events[] property directly.
 *
 * Drop in as <agency-news-ticker></agency-news-ticker> and call
 *   ticker.push("agent claude-1 entered TERMINAL BANK");
 */

import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

interface TickerEvent {
  ts: number;
  text: string;
}

const MAX_EVENTS = 8;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatStamp(ts: number): string {
  const d = new Date(ts);
  return `[${pad2(d.getHours())}:${pad2(d.getMinutes())}]`;
}

@customElement("agency-news-ticker")
export class AgencyNewsTicker extends LitElement {
  @property({ type: Array }) events: TickerEvent[] = [];

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 40px;
      overflow: hidden;
      background: #0a0e1a;
      border-top: 1px solid rgba(212, 175, 55, 0.45);
      position: relative;
      font-family: "Courier New", ui-monospace, SFMono-Regular, Menlo,
        Consolas, monospace;
    }
    .badge {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      padding: 0 10px;
      background: #0a0e1a;
      border-right: 1px solid rgba(212, 175, 55, 0.45);
      color: #d4af37;
      font-weight: bold;
      letter-spacing: 1px;
      font-size: 11px;
      text-transform: uppercase;
    }
    .badge .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ef4444;
      margin-right: 7px;
      box-shadow: 0 0 6px #ef4444;
      animation: blink 1.4s steps(1, end) infinite;
    }
    @keyframes blink {
      0%,
      60% {
        opacity: 1;
      }
      61%,
      100% {
        opacity: 0.25;
      }
    }
    .viewport {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      white-space: nowrap;
      overflow: hidden;
    }
    .track {
      display: inline-flex;
      align-items: center;
      white-space: nowrap;
      will-change: transform;
      animation: marquee var(--marquee-dur, 30s) linear infinite;
      padding-left: 100%;
    }
    .item {
      display: inline-flex;
      align-items: center;
      color: #d4af37;
      font-size: 12px;
      line-height: 40px;
    }
    .item .stamp {
      color: #8a7028;
      margin-right: 6px;
    }
    .sep {
      color: rgba(212, 175, 55, 0.4);
      margin: 0 18px;
    }
    .empty {
      color: #9aa2b1;
      font-size: 12px;
      padding-left: 12px;
      opacity: 0.7;
    }
    @keyframes marquee {
      from {
        transform: translateX(0);
      }
      to {
        transform: translateX(-100%);
      }
    }
  `;

  /** Append a new event, trimming to the last MAX_EVENTS. */
  push(text: string, ts?: number): void {
    const stamp = typeof ts === "number" ? ts : Date.now();
    const next = [...this.events, { ts: stamp, text: String(text || "") }];
    this.events = next.slice(-MAX_EVENTS);
  }

  private renderItems() {
    return this.events.map(
      (ev, i) => html`<span class="item"
          ><span class="stamp">${formatStamp(ev.ts)}</span>${ev.text}</span
        >${i < this.events.length - 1
          ? html`<span class="sep">&bull;</span>`
          : null}`,
    );
  }

  override render() {
    if (!this.events.length) {
      return html`<div class="badge"><span class="dot"></span>LIVE</div>
        <div class="viewport">
          <span class="empty">Awaiting agency activity&hellip;</span>
        </div>`;
    }
    // Duration scales with event count so density stays readable.
    const dur = Math.max(18, this.events.length * 4);
    return html`<div class="badge"><span class="dot"></span>LIVE</div>
      <div class="viewport">
        <div class="track" style="--marquee-dur:${dur}s">
          ${this.renderItems()}
          <span class="sep">&bull;</span>
          ${this.renderItems()}
        </div>
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agency-news-ticker": AgencyNewsTicker;
  }
}
