/**
 * <guided-tour-overlay> — renders the active guided walkthrough
 * (ui/src/learn/guided/engine.ts) over the real app.
 *
 *   • Spotlight: four dim panels AROUND the target, so the target itself stays
 *     clickable/typeable (steps can wait for the user's own action).
 *   • Tooltip card next to the target; a bottom sheet under 640px.
 *   • Keyboard: Esc exits, → / Enter = Next (when ready), ← = Back.
 *   • Minimize hides the dim + card behind a small "Resume tour" pill, so a
 *     tour never blocks the UI.
 *   • Safe-practice steps show a shield note and never perform the action.
 *
 * Mounted on <html> (outside the zoomed <body>) by the engine, so fixed
 * coordinates equal getBoundingClientRect() pixels. Theme tokens (--g-*) come
 * from :root, so light and dark both work.
 */

import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { walkthroughRef } from "../../../../src/learn/guided/types.js";
import { guidedState } from "../../learn/guided/catalog-store";
import {
  doItForMe,
  exitTour,
  nextStep,
  prevStep,
  refreshTarget,
  retryStep,
  setMinimized,
  startWalkthrough,
  subscribeTour,
  tourState,
} from "../../learn/guided/engine";
import { navigateTo } from "../../learn/guided/engine";
import { currentPath, pathNextAfter, pathProgress, setPathAuto, startPath, walkthroughProgressMap } from "../../learn/guided/learning-path";

type Box = { top: number; left: number; width: number; height: number };

const PAD = 6;
const CARD_W = 340;

/** Minimal inline markdown: **bold**, `code`, line breaks. Escapes everything else. */
export function renderInlineMd(text: string): TemplateResult[] {
  const out: TemplateResult[] = [];
  const lines = text.split(/\n/);
  lines.forEach((line, li) => {
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    for (const p of parts) {
      if (p.startsWith("**") && p.endsWith("**")) out.push(html`<strong>${p.slice(2, -2)}</strong>`);
      else if (p.startsWith("`") && p.endsWith("`")) out.push(html`<code>${p.slice(1, -1)}</code>`);
      else out.push(html`${p}`);
    }
    if (li < lines.length - 1) out.push(html`<br />`);
  });
  return out;
}

@customElement("guided-tour-overlay")
export class GuidedTourOverlay extends LitElement {
  @state() private rev = 0;
  /** Seconds until the next lesson of the user's learning path starts (null = no countdown). */
  @state() private pathCountdown: number | null = null;
  private pathTimer: ReturnType<typeof setInterval> | null = null;
  private pathTimerFor: string | null = null;
  @state() private box: Box | null = null;
  @state() private vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  @state() private vh = typeof window === "undefined" ? 800 : window.innerHeight;
  @state() private nudge = false;

  private unsub?: () => void;
  private raf = 0;
  private followTimer: ReturnType<typeof setInterval> | null = null;
  private lastStepKey = "";

  private onScrollOrResize = () => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.measure();
    });
  };

  private onKey = (e: KeyboardEvent) => {
    const t = tourState();
    if (t.phase === "idle") return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (t.minimized) exitTour();
      else exitTour();
      return;
    }
    if (t.minimized) return;
    const path = e.composedPath();
    const inField = path.some(
      (n) => n instanceof HTMLElement && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)),
    );
    if (inField) return;
    if ((e.key === "ArrowRight" || e.key === "Enter") && t.phase === "ready") {
      // Enter on a focused card button runs that button instead.
      if (e.key === "Enter" && path.some((n) => n instanceof HTMLButtonElement)) return;
      e.preventDefault();
      nextStep();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      prevStep();
    }
  };

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 10060;
      pointer-events: none;
      font-family: var(--g-font, system-ui, -apple-system, "Segoe UI", sans-serif);
      color: var(--g-fg, #ece7da);
    }
    .dim {
      position: fixed;
      background: rgba(4, 4, 8, 0.58);
      pointer-events: auto;
    }
    :host-context([data-theme="light"]) .dim {
      background: rgba(20, 20, 30, 0.34);
    }
    .ring {
      position: fixed;
      border-radius: 12px;
      border: 2px solid var(--g-primary, #d4af37);
      box-shadow:
        0 0 0 4px color-mix(in srgb, var(--g-primary, #d4af37) 22%, transparent),
        0 0 24px 2px color-mix(in srgb, var(--g-primary, #d4af37) 45%, transparent);
      pointer-events: none;
      transition: top 0.2s ease, left 0.2s ease, width 0.2s ease, height 0.2s ease;
    }
    .ring.waiting {
      animation: pulse 1.6s ease-in-out infinite;
    }
    @keyframes pulse {
      50% {
        box-shadow:
          0 0 0 8px color-mix(in srgb, var(--g-primary, #d4af37) 12%, transparent),
          0 0 30px 4px color-mix(in srgb, var(--g-primary, #d4af37) 55%, transparent);
      }
    }
    .card {
      position: fixed;
      width: min(${CARD_W}px, calc(100vw - 24px));
      box-sizing: border-box;
      pointer-events: auto;
      background: color-mix(in srgb, var(--g-surface, #15130f) 96%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 42%, var(--g-border, #333));
      border-radius: 16px;
      padding: 14px 16px 12px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(12px);
      outline: none;
      animation: card-in 0.18s ease;
    }
    .card.center {
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(440px, calc(100vw - 24px));
    }
    .card.sheet {
      left: 8px;
      right: 8px;
      width: auto;
      bottom: max(8px, env(safe-area-inset-bottom));
      border-radius: 18px;
      max-height: 55vh;
      overflow: auto;
    }
    .card.sheet.top {
      bottom: auto;
      top: max(8px, env(safe-area-inset-top));
    }
    .card.nudge {
      animation: nudge 0.35s ease;
    }
    @keyframes card-in {
      from {
        opacity: 0;
        translate: 0 6px;
      }
    }
    @keyframes nudge {
      25% {
        translate: -6px 0;
      }
      75% {
        translate: 6px 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .card,
      .ring,
      .ring.waiting {
        animation: none !important;
        transition: none !important;
      }
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #a9a293);
      margin-bottom: 6px;
    }
    .meta .count {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
    }
    .icon-btn {
      background: transparent;
      border: 0;
      color: var(--g-fg-dim, #a9a293);
      cursor: pointer;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: inline-grid;
      place-items: center;
      font-size: 16px;
      line-height: 1;
    }
    .icon-btn:hover,
    .icon-btn:focus-visible {
      background: color-mix(in srgb, var(--g-fg, #fff) 10%, transparent);
      color: var(--g-fg, #fff);
      outline: none;
    }
    .progress {
      height: 3px;
      border-radius: 99px;
      background: color-mix(in srgb, var(--g-fg, #fff) 10%, transparent);
      margin-bottom: 10px;
      overflow: hidden;
    }
    .progress > span {
      display: block;
      height: 100%;
      background: var(--g-primary, #d4af37);
      transition: width 0.25s ease;
    }
    h3 {
      margin: 0 0 6px;
      font-size: 15px;
      line-height: 1.3;
      color: var(--g-fg, #fff);
    }
    .body {
      font-size: 13px;
      line-height: 1.55;
      color: var(--g-fg-muted, var(--g-fg-dim, #c9c2b0));
      margin: 0 0 10px;
    }
    code {
      font-family: var(--g-font-mono, ui-monospace, monospace);
      font-size: 12px;
      padding: 1px 5px;
      border-radius: 5px;
      background: color-mix(in srgb, var(--g-fg, #fff) 10%, transparent);
    }
    .practice {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      font-size: 12px;
      line-height: 1.45;
      padding: 8px 10px;
      margin: 0 0 10px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--g-success, #22c55e) 45%, transparent);
      background: color-mix(in srgb, var(--g-success, #22c55e) 10%, transparent);
    }
    .hint {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 12px;
      padding: 7px 10px;
      margin: 0 0 10px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--g-primary, #d4af37) 12%, transparent);
      color: var(--g-fg, #fff);
    }
    .hint.warn {
      background: color-mix(in srgb, var(--g-warning, #f59e0b) 14%, transparent);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--g-primary, #d4af37);
      flex: none;
      animation: blink 1.2s ease-in-out infinite;
    }
    @keyframes blink {
      50% {
        opacity: 0.3;
      }
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .spacer {
      flex: 1;
    }
    button.btn {
      font: inherit;
      font-size: 12.5px;
      font-weight: 600;
      min-height: 34px;
      padding: 0 12px;
      border-radius: 10px;
      cursor: pointer;
      border: 1px solid var(--g-border, color-mix(in srgb, var(--g-fg, #fff) 18%, transparent));
      background: transparent;
      color: var(--g-fg, #fff);
    }
    button.btn:hover:not(:disabled),
    button.btn:focus-visible {
      border-color: var(--g-primary, #d4af37);
      outline: none;
    }
    button.btn.primary {
      background: var(--g-primary, #d4af37);
      border-color: var(--g-primary, #d4af37);
      color: var(--g-on-primary, #111);
    }
    button.btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    button.link {
      background: none;
      border: 0;
      padding: 0 4px;
      color: var(--g-fg-dim, #a9a293);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 3px;
      min-height: 34px;
    }
    .pill {
      position: fixed;
      right: 16px;
      bottom: max(16px, env(safe-area-inset-bottom));
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px 8px 14px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-surface, #15130f) 96%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 55%, transparent);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
      font-size: 12.5px;
    }
    .done-badge {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      margin: 4px auto 10px;
      font-size: 26px;
      background: color-mix(in srgb, var(--g-primary, #d4af37) 20%, transparent);
      border: 2px solid var(--g-primary, #d4af37);
    }
    .center-text {
      text-align: center;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub = subscribeTour(() => {
      this.rev++;
      this.measure();
    });
    window.addEventListener("resize", this.onScrollOrResize);
    window.addEventListener("scroll", this.onScrollOrResize, true);
    document.addEventListener("keydown", this.onKey, true);
    // Targets move (lazy views, animations): follow them cheaply.
    this.followTimer = setInterval(() => {
      if (tourState().phase !== "idle") {
        refreshTarget();
        this.measure();
      }
    }, 400);
  }

  disconnectedCallback(): void {
    this.unsub?.();
    window.removeEventListener("resize", this.onScrollOrResize);
    window.removeEventListener("scroll", this.onScrollOrResize, true);
    document.removeEventListener("keydown", this.onKey, true);
    if (this.followTimer) clearInterval(this.followTimer);
    this.stopPathCountdown();
    super.disconnectedCallback();
  }

  private measure(): void {
    this.vw = window.innerWidth;
    this.vh = window.innerHeight;
    const t = tourState().target;
    if (!t || !t.isConnected) {
      if (this.box) this.box = null;
      return;
    }
    const r = t.getBoundingClientRect();
    const next = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
    const b = this.box;
    if (!b || Math.abs(b.top - next.top) > 0.5 || Math.abs(b.left - next.left) > 0.5 || Math.abs(b.width - next.width) > 0.5 || Math.abs(b.height - next.height) > 0.5) {
      this.box = next;
    }
  }

  protected updated(): void {
    this.syncPathCountdown();
    const t = tourState();
    const key = `${t.walkthrough?.id}:${t.step?.id}:${t.phase === "done"}`;
    if (key !== this.lastStepKey && t.phase !== "idle" && !t.minimized) {
      this.lastStepKey = key;
      // Focus the card for screen readers — but never steal focus from a field
      // the user is asked to type into.
      if (t.step?.action?.kind !== "input") {
        const card = this.renderRoot.querySelector<HTMLElement>(".card");
        card?.focus({ preventScroll: true });
      }
    }
  }

  private shake(): void {
    this.nudge = true;
    setTimeout(() => (this.nudge = false), 400);
  }

  private dims(b: Box): TemplateResult {
    const { vw, vh } = this;
    const top = Math.max(0, b.top);
    const left = Math.max(0, b.left);
    const right = Math.min(vw, b.left + b.width);
    const bottom = Math.min(vh, b.top + b.height);
    const click = () => this.shake();
    return html`
      <div class="dim" style="top:0;left:0;width:${vw}px;height:${top}px" @click=${click}></div>
      <div class="dim" style="top:${bottom}px;left:0;width:${vw}px;height:${Math.max(0, vh - bottom)}px" @click=${click}></div>
      <div class="dim" style="top:${top}px;left:0;width:${left}px;height:${Math.max(0, bottom - top)}px" @click=${click}></div>
      <div class="dim" style="top:${top}px;left:${right}px;width:${Math.max(0, vw - right)}px;height:${Math.max(0, bottom - top)}px" @click=${click}></div>
    `;
  }

  /** Card position next to the target, clamped to the viewport. */
  private cardStyle(b: Box, estH: number): string {
    const { vw, vh } = this;
    const w = Math.min(CARD_W, vw - 24);
    const gap = 12;
    const pref = tourState().step?.placement ?? "auto";
    const spaceBelow = vh - (b.top + b.height);
    const spaceAbove = b.top;
    const spaceRight = vw - (b.left + b.width);
    const spaceLeft = b.left;
    let place = pref;
    if (place === "auto" || place === "center") {
      if (spaceBelow >= estH + gap) place = "bottom";
      else if (spaceAbove >= estH + gap) place = "top";
      else if (spaceRight >= w + gap) place = "right";
      else if (spaceLeft >= w + gap) place = "left";
      else place = "bottom";
    }
    let top = 0;
    let left = 0;
    if (place === "bottom" || place === "top") {
      left = b.left + b.width / 2 - w / 2;
      top = place === "bottom" ? b.top + b.height + gap : b.top - estH - gap;
    } else {
      top = b.top + b.height / 2 - estH / 2;
      left = place === "right" ? b.left + b.width + gap : b.left - w - gap;
    }
    left = Math.min(Math.max(12, left), vw - w - 12);
    top = Math.min(Math.max(12, top), vh - estH - 12);
    return `top:${Math.round(top)}px;left:${Math.round(left)}px`;
  }

  /** Learning path: count down into the next lesson once a path lesson is done. */
  private syncPathCountdown(): void {
    const t = tourState();
    const ref = t.phase === "done" && t.track && t.walkthrough ? walkthroughRef(t.track.id, t.walkthrough.id) : null;
    if (ref === this.pathTimerFor) return;
    this.stopPathCountdown();
    this.pathTimerFor = ref;
    if (!ref || t.auto || t.minimized) return;
    const cur = currentPath();
    if (!cur?.stored.auto || !pathNextAfter(ref)) return;
    this.pathCountdown = 6;
    this.pathTimer = setInterval(() => {
      const n = (this.pathCountdown ?? 1) - 1;
      if (n > 0) {
        this.pathCountdown = n;
        return;
      }
      this.stopPathCountdown();
      void startPath(ref);
    }, 1000);
  }

  private stopPathCountdown(): void {
    if (this.pathTimer) clearInterval(this.pathTimer);
    this.pathTimer = null;
    this.pathCountdown = null;
  }

  private renderPathDone(ref: string): TemplateResult | typeof nothing {
    const cur = currentPath();
    const next = pathNextAfter(ref);
    if (!cur || !cur.items.some((i) => i.ref === ref)) return nothing;
    const prog = pathProgress(cur.items, walkthroughProgressMap());
    if (!next) {
      return html`<p class="body" data-learn-overlay="path-finished"><strong>You finished your learning path.</strong> Everything else is on the Learn page.</p>`;
    }
    return html`
      <p class="body" data-learn-overlay="path-progress">
        Your learning path: ${prog.done} of ${prog.total} done${prog.minutesLeft ? ` · about ${prog.minutesLeft} min left` : ""}.
      </p>
      <div class="row" style="justify-content:center">
        <button class="btn primary" data-learn-overlay="path-next" @click=${() => {
          this.stopPathCountdown();
          void startPath(ref);
        }}>
          Next in your path: ${next.title}${this.pathCountdown ? ` (${this.pathCountdown})` : ""}
        </button>
        ${this.pathCountdown
          ? html`<button class="btn" data-learn-overlay="path-pause" @click=${() => {
              this.stopPathCountdown();
              void setPathAuto(false);
            }}>Pause my path</button>`
          : nothing}
      </div>
    `;
  }

  private renderDone(): TemplateResult {
    const t = tourState();
    const track = t.track;
    const wts = track?.walkthroughs ?? [];
    const p = guidedState().progress;
    const next = wts.find((w) => w.id !== t.walkthrough?.id && p.walkthroughs[walkthroughRef(track!.id, w.id)]?.status !== "completed");
    const trackDone = track ? wts.every((w) => w.id === t.walkthrough?.id || p.walkthroughs[walkthroughRef(track.id, w.id)]?.status === "completed") : false;
    const ref = track && t.walkthrough ? walkthroughRef(track.id, t.walkthrough.id) : "";
    const pathBlock = ref ? this.renderPathDone(ref) : nothing;
    const inPath = pathBlock !== nothing;
    return html`
      <div class="dim" style="inset:0"></div>
      <div class="card center center-text" role="dialog" aria-modal="true" aria-labelledby="gt-done" tabindex="-1" data-learn-overlay="done">
        <div class="done-badge" aria-hidden="true">${track?.badge.icon ?? "★"}</div>
        <h3 id="gt-done">Walkthrough complete</h3>
        <p class="body">
          ${t.walkthrough?.title} · ${track?.title}
          ${trackDone && track?.quiz.length
            ? html`<br />All walkthroughs done — take the quick check to earn the <strong>${track.badge.label}</strong>.`
            : nothing}
          ${t.minted.length ? html`<br /><strong>Certificate earned: ${t.minted.join(", ")}.</strong>` : nothing}
        </p>
        ${pathBlock}
        <div class="row" style="justify-content:center">
          ${next && !inPath
            ? html`<button class="btn primary" data-learn-overlay="next-walkthrough" @click=${() => void startWalkthrough(track!.id, next.id)}>
                Next: ${next.title}
              </button>`
            : nothing}
          <button
            class="btn ${next || inPath ? "" : "primary"}"
            @click=${() => {
              const id = track?.id;
              exitTour();
              if (id) navigateTo(`/learn/${id}`);
            }}
          >
            ${trackDone && track?.quiz.length ? "Take the check" : "Back to track"}
          </button>
          <button class="link" @click=${() => exitTour()}>Close</button>
        </div>
      </div>
    `;
  }

  render() {
    void this.rev;
    const t = tourState();
    if (t.phase === "idle") return nothing;
    if (t.minimized) {
      return html`<div class="pill" role="status">
        <span>Tour paused · ${t.walkthrough?.title}</span>
        <button class="btn primary" data-learn-overlay="resume" @click=${() => setMinimized(false)}>Resume</button>
        <button class="icon-btn" aria-label="Exit tour" @click=${() => exitTour()}>×</button>
      </div>`;
    }
    if (t.phase === "done") return this.renderDone();
    const step = t.step;
    const wt = t.walkthrough;
    if (!step || !wt) return nothing;
    const total = wt.steps.length;
    const n = t.index + 1;
    const b = this.box;
    const narrow = this.vw < 640;
    const waiting = t.phase === "waiting-action" || t.phase === "checking";
    const locating = t.phase === "locating" || t.phase === "navigating";
    const explain = step.practice?.mode === "explain";
    const estH = 220 + (step.practice ? 60 : 0) + (t.hint ? 34 : 0);
    const sheetTop = narrow && b && b.top + b.height / 2 > this.vh / 2 && b.top > this.vh * 0.45 ? true : false;
    const cardClass = narrow ? `sheet ${sheetTop ? "top" : ""}` : b ? "" : "center";
    const style = !narrow && b ? this.cardStyle(b, estH) : "";

    return html`
      ${b ? this.dims(b) : html`<div class="dim" style="inset:0" @click=${() => this.shake()}></div>`}
      ${b ? html`<div class="ring ${waiting ? "waiting" : ""}" style="top:${b.top}px;left:${b.left}px;width:${b.width}px;height:${b.height}px"></div>` : nothing}
      <div
        class="card ${cardClass} ${this.nudge ? "nudge" : ""}"
        style=${style}
        role="dialog"
        aria-modal="false"
        aria-labelledby="gt-title"
        aria-describedby="gt-body"
        tabindex="-1"
        data-learn-overlay="card"
        data-step=${step.id}
        data-phase=${t.phase}
      >
        <div class="meta">
          <span>${t.track?.title}</span>
          <span class="count">Step ${n} of ${total}</span>
          <button class="icon-btn" title="Minimize" aria-label="Minimize tour" @click=${() => setMinimized(true)}>–</button>
          <button class="icon-btn" title="Exit (Esc)" aria-label="Exit tour" data-learn-overlay="exit" @click=${() => exitTour()}>×</button>
        </div>
        <div class="progress" aria-hidden="true"><span style="width:${Math.round((t.index / total) * 100)}%"></span></div>
        <h3 id="gt-title">${step.title}</h3>
        <p class="body" id="gt-body">${renderInlineMd(step.body)}</p>
        ${step.practice
          ? html`<div class="practice" data-learn-overlay="practice">
              <span aria-hidden="true">🛡</span>
              <span><strong>${explain ? "Safe practice — explained, not performed." : "Safe practice — sandbox data."}</strong> ${step.practice.note}</span>
            </div>`
          : nothing}
        ${t.resumed && t.index === 0 ? nothing : nothing}
        ${locating ? html`<div class="hint" aria-live="polite"><span class="dot"></span>Finding it on the page…</div>` : nothing}
        ${t.phase === "missing"
          ? html`<div class="hint warn" aria-live="polite">
              ${t.hint} It may need data you don't have yet, or a wider window.
            </div>`
          : nothing}
        ${waiting && t.hint ? html`<div class="hint" aria-live="polite"><span class="dot"></span>${t.hint}</div>` : nothing}
        <div class="row">
          <button class="btn" ?disabled=${t.index === 0} @click=${() => prevStep()} aria-label="Previous step">Back</button>
          <span class="spacer"></span>
          ${t.phase === "missing"
            ? html`<button class="link" @click=${() => retryStep()}>Retry</button>`
            : nothing}
          ${(waiting || t.phase === "missing" || locating) && !explain
            ? html`<button class="link" data-learn-overlay="skip" @click=${() => nextStep(true)}>Skip</button>`
            : nothing}
          ${t.phase === "waiting-action" && step.action && !explain
            ? html`<button class="btn" data-learn-overlay="do-it" @click=${() => doItForMe()}>Do it for me</button>`
            : html`<button
                class="btn primary"
                data-learn-overlay="next"
                ?disabled=${t.phase !== "ready"}
                @click=${() => nextStep()}
              >
                ${n === total ? "Finish" : "Next"}
              </button>`}
        </div>
        <span class="sr" aria-live="polite">Step ${n} of ${total}: ${step.title}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "guided-tour-overlay": GuidedTourOverlay;
  }
}
