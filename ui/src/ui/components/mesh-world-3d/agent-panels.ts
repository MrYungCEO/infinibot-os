/**
 * 3D agent overlay panels — floating glass HUD cards anchored above agents in
 * the 3D Agent Mesh, drawn as crisp HTML over the canvas.
 *
 * The scene decides WHICH agents get a panel and WHERE (screen-space
 * declutter shared with name tags + zone signs, distance fade / scale —
 * `MeshWorldScene.panelAnchors()`); this layer only keeps one element per
 * panel, moves it every rendered frame (transform + opacity, no layout) and
 * re-renders its content when the data signature changes (~1 Hz for the
 * elapsed timer).
 *
 * Compact: name, status, current task, live tool line, progress, elapsed.
 * Expanded (hover / selection): + recent activity and quick actions (open
 * session, focus, stop, message) — the same actions the 2D map uses.
 */
import { css, html, nothing, render } from "lit";
import { icons } from "../../icons";
import type { PanelAnchor } from "./world-scene";

export interface PanelData {
  name: string;
  stateLabel: string;
  tone: string;
  activity: string;
  task: string;
  tool: string;
  /** 0..100, or null when the run reports none. */
  progress: number | null;
  elapsed: string;
  backend: string;
  zone: string;
  recent: Array<{ text: string; ago: string }>;
  running: boolean;
  following: boolean;
  canTask: boolean;
}

export interface PanelHandlers {
  data(key: string): PanelData | null;
  hover(key: string | null): void;
  select(key: string): void;
  open(key: string): void;
  focus(key: string): void;
  stop(key: string): void;
  message(key: string): void;
  task(key: string): void;
  /** Measured box sizes (px, unscaled) so the scene reserves the right space. */
  measured(box: { w: number; h: number; ew: number; eh: number }): void;
}

interface PanelEl {
  el: HTMLDivElement;
  sig: string;
  expanded: boolean;
  seen: number;
}

export const PANEL_W = 232;
export const PANEL_EW = 300;

export class AgentPanelLayer {
  private readonly els = new Map<string, PanelEl>();
  private frame = 0;
  private box = { w: PANEL_W, h: 92, ew: PANEL_EW, eh: 250 };

  constructor(private readonly root: HTMLElement, private readonly h: PanelHandlers) {}

  /**
   * Place panels for this frame's anchors (call after every rendered frame).
   * `k` converts canvas px → layer CSS px (ancestors may apply CSS zoom).
   */
  update(anchors: readonly PanelAnchor[], k = 1, refreshContent = false): void {
    this.frame++;
    for (const a of anchors) {
      let p = this.els.get(a.key);
      if (!p) {
        const el = document.createElement("div");
        el.className = "ap";
        el.dataset.key = a.key;
        el.setAttribute("data-testid", "mesh3d-agent-overlay");
        el.addEventListener("pointerenter", () => this.h.hover(a.key));
        el.addEventListener("pointerleave", () => this.h.hover(null));
        el.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          this.h.select(a.key);
        });
        this.root.appendChild(el);
        p = { el, sig: "", expanded: false, seen: this.frame };
        this.els.set(a.key, p);
      }
      p.seen = this.frame;
      if (p.expanded !== a.expanded || refreshContent || !p.sig) this.renderContent(a.key, p, a.expanded);
      p.expanded = a.expanded;
      p.el.classList.toggle("expanded", a.expanded);
      const s = (a.scale * k).toFixed(3);
      // Bottom-anchored: the card grows upward from just above the agent's head.
      p.el.style.transform = `translate3d(${(a.x * k).toFixed(1)}px, ${((a.bottom - 6 * a.scale) * k).toFixed(1)}px, 0) scale(${s}) translateY(-100%)`;
      p.el.style.opacity = a.alpha.toFixed(3);
      p.el.style.pointerEvents = a.alpha > 0.5 ? "auto" : "none";
      p.el.style.zIndex = a.expanded ? "3" : "1";
    }
    for (const [k, p] of this.els) {
      if (p.seen !== this.frame) {
        p.el.remove();
        this.els.delete(k);
      }
    }
    this.measure(k);
  }

  /** Refresh every panel's content (timers, live tool lines) without moving them. */
  refresh(): void {
    for (const [k, p] of this.els) this.renderContent(k, p, p.expanded);
    this.measure(this.lastK);
  }

  clear(): void {
    for (const p of this.els.values()) p.el.remove();
    this.els.clear();
  }

  keys(): string[] {
    return [...this.els.keys()];
  }

  private lastK = 1;

  private measure(k: number): void {
    this.lastK = k;
    let w = 0, h = 0, ew = 0, eh = 0;
    for (const p of this.els.values()) {
      const ow = p.el.offsetWidth;
      const oh = p.el.offsetHeight;
      if (!ow || !oh) continue;
      if (p.expanded) {
        ew = Math.max(ew, ow);
        eh = Math.max(eh, oh);
      } else {
        w = Math.max(w, ow);
        h = Math.max(h, oh);
      }
    }
    // offsetWidth is the unscaled layer-CSS size; the transform scale already
    // folds in k, so on screen a panel spans offsetWidth × anchor scale canvas px.
    void k;
    const next = { w: w || this.box.w, h: h || this.box.h, ew: ew || this.box.ew, eh: eh || this.box.eh };
    if (Math.abs(next.w - this.box.w) + Math.abs(next.h - this.box.h) + Math.abs(next.ew - this.box.ew) + Math.abs(next.eh - this.box.eh) > 3) {
      this.box = next;
      this.h.measured(next);
    }
  }

  private renderContent(key: string, p: PanelEl, expanded: boolean): void {
    const d = this.h.data(key);
    if (!d) return;
    const sig = JSON.stringify([d, expanded]);
    if (sig === p.sig) return;
    p.sig = sig;
    const pct = d.progress == null ? null : Math.max(0, Math.min(100, d.progress));
    render(
      html`
        <div class="ap-card" style="--tone:${d.tone}">
          <div class="ap-head">
            <span class="ap-ring"><span class="ap-dot"></span></span>
            <span class="ap-name" title=${d.name}>${d.name}</span>
            ${d.backend ? html`<span class="ap-mono">${d.backend}</span>` : nothing}
            <span class="ap-time" title="Elapsed">${d.elapsed}</span>
          </div>
          <div class="ap-state"><b>${d.stateLabel}</b>${d.activity ? html` · ${d.activity}` : nothing}${expanded && d.zone ? html` · ${d.zone}` : nothing}</div>
          <div class="ap-task" title=${d.task}>${d.task || "No task reported"}</div>
          ${d.tool ? html`<div class="ap-tool"><span class="ap-caret">›_</span><span>${d.tool}</span></div>` : nothing}
          <div class="ap-bar ${pct == null ? "indet" : ""}" aria-label=${pct == null ? "Working" : `Progress ${Math.round(pct)}%`}>
            <i style=${pct == null ? "" : `width:${pct}%`}></i>
          </div>
          ${expanded
            ? html`
                ${d.recent.length
                  ? html`<ol class="ap-recent" aria-label="Recent activity">
                      ${d.recent.map((r) => html`<li><span>${r.text}</span><time>${r.ago}</time></li>`)}
                    </ol>`
                  : html`<div class="ap-recent empty">No recent tool activity</div>`}
                <div class="ap-actions">
                  <button data-act="open" title="Open the session (Agent focus)" @click=${() => this.h.open(key)}>${icons.externalLink}Open</button>
                  <button data-act="focus" aria-pressed=${d.following ? "true" : "false"} title="Fly to and follow" @click=${() => this.h.focus(key)}>${icons.target}Focus</button>
                  <button data-act="message" title="Message this agent" @click=${() => this.h.message(key)}>${icons.messageSquare}Msg</button>
                  <button data-act="stop" ?disabled=${!d.running} title=${d.running ? "Stop this run" : "Not running"} @click=${() => this.h.stop(key)}>${icons.stop}Stop</button>
                  ${d.canTask ? html`<button data-act="task" title="Open the task" @click=${() => this.h.task(key)}>${icons.kanban}</button>` : nothing}
                </div>
              `
            : nothing}
        </div>
        <span class="ap-nub" aria-hidden="true"></span>
      `,
      p.el,
    );
  }
}

/** Styles for the panel layer (shadow DOM of <mesh-world-3d>). */
export const agentPanelStyles = css`
  :host-context([data-theme="light"]) .ap-layer {
    --ap-bg: rgba(250, 249, 245, 0.82);
    --ap-ink: #22201c;
    --ap-dim: rgba(40, 38, 34, 0.62);
  }
  .ap-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 2;
    overflow: hidden;
  }
  .ap {
    position: absolute;
    left: 0;
    top: 0;
    width: 232px;
    transform-origin: 0 0;
    will-change: transform, opacity;
    pointer-events: auto;
    cursor: pointer;
    font-family: Inter, "Space Grotesk", system-ui, sans-serif;
    color: var(--ap-ink, #f2ecdd);
  }
  .ap.expanded {
    width: 300px;
    cursor: default;
  }
  .ap-card {
    position: relative;
    padding: 9px 11px 10px;
    border-radius: 12px;
    background:
      linear-gradient(160deg, color-mix(in srgb, var(--gold) 9%, transparent), transparent 45%),
      var(--ap-bg, rgba(9, 9, 12, 0.72));
    border: 1px solid color-mix(in srgb, var(--gold) 34%, transparent);
    box-shadow:
      0 10px 30px rgba(0, 0, 0, 0.45),
      inset 0 1px 0 rgba(255, 255, 255, 0.07),
      0 0 0 1px rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(12px) saturate(140%);
    -webkit-backdrop-filter: blur(12px) saturate(140%);
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .ap.expanded .ap-card,
  .ap:hover .ap-card {
    border-color: color-mix(in srgb, var(--gold) 70%, transparent);
    box-shadow:
      0 14px 40px rgba(0, 0, 0, 0.55),
      0 0 24px color-mix(in srgb, var(--gold) 22%, transparent),
      inset 0 1px 0 rgba(255, 255, 255, 0.09);
  }
  /* Top edge light strip. */
  .ap-card::before {
    content: "";
    position: absolute;
    left: 14px;
    right: 14px;
    top: -1px;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--gold), transparent);
    opacity: 0.85;
  }
  .ap-nub {
    position: absolute;
    left: 50%;
    bottom: -6px;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    transform: rotate(45deg);
    background: var(--ap-bg, rgba(9, 9, 12, 0.72));
    border-right: 1px solid color-mix(in srgb, var(--gold) 45%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--gold) 45%, transparent);
  }
  .ap-head {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .ap-ring {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid var(--tone);
    display: grid;
    place-items: center;
    box-shadow: 0 0 10px color-mix(in srgb, var(--tone) 60%, transparent);
  }
  .ap-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tone);
  }
  .ap-name {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 650;
    letter-spacing: 0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ap-mono {
    flex: none;
    font: 700 9.5px "JetBrains Mono", ui-monospace, monospace;
    color: var(--gold);
    border: 1px solid color-mix(in srgb, var(--gold) 40%, transparent);
    border-radius: 4px;
    padding: 0 4px;
    line-height: 15px;
  }
  .ap-time {
    flex: none;
    font: 600 10.5px "JetBrains Mono", ui-monospace, monospace;
    color: var(--ap-dim, rgba(236, 230, 214, 0.6));
    font-variant-numeric: tabular-nums;
  }
  .ap-state {
    margin: 3px 0 0 21px;
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ap-dim, rgba(236, 230, 214, 0.6));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ap-state b {
    color: var(--tone);
    font-weight: 700;
  }
  .ap-task {
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ap.expanded .ap-task {
    -webkit-line-clamp: 3;
  }
  .ap-tool {
    margin-top: 5px;
    display: flex;
    gap: 6px;
    align-items: baseline;
    font: 500 10.5px "JetBrains Mono", ui-monospace, monospace;
    color: color-mix(in srgb, var(--gold) 80%, var(--ap-ink, #f2ecdd));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ap-tool span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ap-caret {
    flex: none;
    opacity: 0.8;
    animation: apBlink 1.1s steps(2) infinite;
  }
  @keyframes apBlink {
    50% {
      opacity: 0.25;
    }
  }
  .ap-bar {
    position: relative;
    height: 3px;
    margin-top: 8px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }
  .ap-bar i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, color-mix(in srgb, var(--gold) 55%, #000), var(--gold));
    box-shadow: 0 0 8px var(--gold);
    transition: width 0.6s ease;
  }
  .ap-bar.indet i {
    width: 36%;
    animation: apSweep 1.8s ease-in-out infinite;
  }
  @keyframes apSweep {
    from {
      transform: translateX(-110%);
    }
    to {
      transform: translateX(300%);
    }
  }
  .ap-recent {
    list-style: none;
    margin: 9px 0 0;
    padding: 7px 0 0;
    border-top: 1px solid color-mix(in srgb, var(--gold) 18%, transparent);
    display: grid;
    gap: 3px;
    font-size: 11px;
  }
  .ap-recent.empty {
    color: var(--ap-dim, rgba(236, 230, 214, 0.55));
    font-size: 11px;
  }
  .ap-recent li {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    min-width: 0;
  }
  .ap-recent li span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ap-recent time {
    flex: none;
    color: var(--ap-dim, rgba(236, 230, 214, 0.5));
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .ap-actions {
    display: flex;
    gap: 4px;
    margin-top: 9px;
  }
  .ap-actions button {
    flex: 1;
    justify-content: center;
    min-height: 26px;
    padding: 4px 6px;
    font-size: 10px;
    gap: 4px;
    border: 1px solid color-mix(in srgb, var(--gold) 28%, transparent);
    border-radius: 7px;
    color: var(--ap-ink, #ece6d6);
  }
  .ap-actions button svg {
    width: 12px;
    height: 12px;
  }
  .ap-actions button[data-act="task"] {
    flex: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .ap-caret,
    .ap-bar.indet i {
      animation: none;
    }
  }
`;
