/**
 * <world-interactions hostSelector="agency-world-viz">
 *
 * A sibling overlay that layers *game-functional* interactions over the Agency
 * World map without ever touching the host's DOM or internals:
 *
 *   • Drag-to-assign  — drag an idle agent onto a sector building to spawn a
 *                       task assigned to that sector.
 *   • Radial menu     — right-click an agent for Resume / Stop / Respawn /
 *                       Send Message / Promote / Open Focus.
 *   • Director mode   — hotkey D; paint-select agents and issue group commands.
 *
 * ── HOW IT STAYS OUT OF THE HOST'S WAY ─────────────────────────────────────
 * The overlay is `position: fixed`, kept aligned to the host element's bounding
 * box, and `pointer-events: none` by default — only its own interactive widgets
 * (radial buttons, action bar, prompt) opt back in. All world hit-testing is
 * done from pointer listeners attached to the *host element* using its bbox, so
 * the map keeps panning/zooming normally except when we intentionally consume a
 * gesture (dragging an agent, rect-selecting, or opening the radial menu).
 *
 * It reads agent + sector positions from documented window globals
 * (window.__agentFxState / window.__worldSectors) — see ./types.ts.
 *
 * ── MOUNTING (integration step, not done here) ─────────────────────────────
 * Place as a sibling *after* the world host wherever the world-map band lives
 * (e.g. dashboard world-map band), then `import "./components/world-interactions"`:
 *
 *   <agency-world-viz></agency-world-viz>
 *   <world-interactions hostSelector="agency-world-viz"></world-interactions>
 *
 * The element self-positions over the host and needs no other wiring; for
 * drag-to-assign drop zones the host must publish `window.__worldSectors`.
 */
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { DragAssignController } from "./drag-assign.js";
import { RadialMenuController } from "./radial-menu.js";
import { DirectorModeController } from "./director-mode.js";
import type { FxAgent, InteractionHost, PromptOptions } from "./types.js";
import { agentRpcTarget, hitTestAgent, readAgents } from "./world-state.js";

/** True when a pointer event started on an interactive control (not the map). */
function startsOnControl(e: Event): boolean {
  for (const n of e.composedPath()) {
    if (!(n instanceof HTMLElement)) continue;
    const tag = n.tagName;
    if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "LABEL") return true;
    if (n.getAttribute("role") === "toolbar" || n.getAttribute("role") === "button") return true;
  }
  return false;
}

@customElement("world-interactions")
export class WorldInteractions extends LitElement implements InteractionHost {
  /** CSS selector for the world host element to overlay. */
  @property({ type: String }) hostSelector = "agency-world-viz";

  @state() private toastMsg = "";
  @state() private toastKind: "ok" | "err" = "ok";
  @state() private prompt: PromptOptions | null = null;
  @state() private promptValue = "";

  private drag = new DragAssignController(this);
  private radial = new RadialMenuController(this);
  private director = new DirectorModeController(this);

  private hostEl: HTMLElement | null = null;
  private hostRect: DOMRect | null = null;
  private ro: ResizeObserver | null = null;
  private rafId = 0;
  private toastTimer = 0;
  /** Active window-level pointer gesture, if any. */
  private gesture: "drag" | "rect" | null = null;
  /** Pointer-down anchor for an agent gesture, used to tell a tap (→ open the
   *  focus modal) apart from a drag (→ assign to a sector). */
  private downAt: { x: number; y: number; agent: FxAgent } | null = null;

  // ── InteractionHost ────────────────────────────────────────────────────
  toast(message: string, kind: "ok" | "err" = "ok"): void {
    this.toastMsg = message;
    this.toastKind = kind;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastMsg = "";
    }, 2600);
  }

  openPrompt(opts: PromptOptions): void {
    this.prompt = opts;
    this.promptValue = opts.value ?? "";
    this.requestUpdate();
    requestAnimationFrame(() =>
      this.renderRoot.querySelector<HTMLTextAreaElement>(".wi-prompt-input")?.focus(),
    );
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  override connectedCallback(): void {
    super.connectedCallback();
    this.attachToHost();
    window.addEventListener("scroll", this.syncRect, true);
    window.addEventListener("resize", this.syncRect, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    this.loop();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.detachFromHost();
    window.removeEventListener("scroll", this.syncRect, true);
    window.removeEventListener("resize", this.syncRect, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.endGesture();
    cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.toastTimer);
  }

  private attachToHost(): void {
    // Resolve from our own root first so we work whether we're placed in the
    // light DOM (sibling of <agency-world-viz>) OR inside a shadow root next to
    // the engine host div (document.querySelector can't cross shadow boundaries).
    const root = this.getRootNode() as Document | ShadowRoot;
    const el =
      (root.querySelector?.(this.hostSelector) as HTMLElement | null) ??
      document.querySelector<HTMLElement>(this.hostSelector);
    if (!el) {
      // The host may mount after us; retry shortly.
      window.setTimeout(() => {
        if (this.isConnected && !this.hostEl) this.attachToHost();
      }, 400);
      return;
    }
    this.hostEl = el;
    el.addEventListener("pointerdown", this.onHostPointerDown, true);
    el.addEventListener("contextmenu", this.onHostContextMenu, true);
    this.ro = new ResizeObserver(() => this.syncRect());
    this.ro.observe(el);
    this.syncRect();
  }

  private detachFromHost(): void {
    const el = this.hostEl;
    if (el) {
      el.removeEventListener("pointerdown", this.onHostPointerDown, true);
      el.removeEventListener("contextmenu", this.onHostContextMenu, true);
    }
    this.ro?.disconnect();
    this.ro = null;
    this.hostEl = null;
  }

  /** Keep the fixed overlay box aligned to the host element. */
  private syncRect = (): void => {
    if (!this.hostEl) return;
    const r = this.hostEl.getBoundingClientRect();
    this.hostRect = r;
    this.style.position = "fixed";
    this.style.left = `${r.left}px`;
    this.style.top = `${r.top}px`;
    this.style.width = `${r.width}px`;
    this.style.height = `${r.height}px`;
  };

  /** rAF tick: keep overlay redrawing while any interaction is live so halos
   *  and ghosts follow agents that move within the world. */
  private loop = (): void => {
    if (this.drag.active || this.director.active || this.radial.open || this.gesture) {
      this.syncRect();
      this.requestUpdate();
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  // ── coordinate helper ─────────────────────────────────────────────────────
  /** Convert a pointer event to host-relative px (the space agents live in). */
  private toLocal(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.hostRect ?? this.hostEl?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  // ── host pointer routing ──────────────────────────────────────────────────
  /** Stop a gesture from reaching the map (pan/zoom) when we own it. */
  private consume(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
  }

  private onHostPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return; // left button only; right opens radial
    // Presses on HUD controls (buttons, inputs, toolbars) layered over the map
    // belong to the control, not to the agent sprite underneath it.
    if (startsOnControl(e)) return;
    const { x, y } = this.toLocal(e);
    const agent = hitTestAgent(readAgents(), x, y);

    if (this.director.active) {
      // Shift-click toggles a single agent; bare drag paints a rect.
      if (e.shiftKey && agent) {
        this.consume(e);
        this.director.toggleAgent(agent);
        return;
      }
      this.consume(e);
      this.director.beginRect(x, y);
      this.beginGesture("rect");
      return;
    }

    if (agent) {
      this.consume(e);
      this.downAt = { x, y, agent };
      this.drag.begin(agent, x, y);
      this.beginGesture("drag");
    }
    // else: let the gesture fall through so the map can pan/zoom.
  };

  private onHostContextMenu = (e: MouseEvent): void => {
    const { x, y } = this.toLocal(e);
    const agent = hitTestAgent(readAgents(), x, y);
    if (!agent) return; // allow the normal context menu off-agent
    e.preventDefault();
    e.stopPropagation();
    this.radial.openAt(agent, x, y);
  };

  private beginGesture(kind: "drag" | "rect"): void {
    this.gesture = kind;
    window.addEventListener("pointermove", this.onWindowPointerMove, true);
    window.addEventListener("pointerup", this.onWindowPointerUp, true);
  }

  private endGesture(): void {
    if (!this.gesture) return;
    this.gesture = null;
    window.removeEventListener("pointermove", this.onWindowPointerMove, true);
    window.removeEventListener("pointerup", this.onWindowPointerUp, true);
  }

  private onWindowPointerMove = (e: PointerEvent): void => {
    const { x, y } = this.toLocal(e);
    if (this.gesture === "drag") this.drag.move(x, y);
    else if (this.gesture === "rect") this.director.moveRect(x, y);
  };

  /** Below this pointer travel (px) we treat the gesture as a tap, not a drag. */
  private static readonly TAP_SLOP_PX = 6;

  private onWindowPointerUp = (e: PointerEvent): void => {
    const { x, y } = this.toLocal(e);
    if (this.gesture === "drag") {
      // A tap (negligible travel) on an agent opens the Agent Focus modal —
      // the same entry point the right-click radial "Focus" action and the
      // dashboard map use. This is what makes resting/"sleeping" agents parked
      // on concourse beds clickable: they live in __agentFxState like any other
      // agent, so hitTestAgent already resolves them. Only an actual drag falls
      // through to drag-to-assign.
      const down = this.downAt;
      const dist = down ? Math.hypot(x - down.x, y - down.y) : Infinity;
      if (down && dist <= WorldInteractions.TAP_SLOP_PX) {
        this.drag.cancel();
        const open = window.openAgentFocus;
        if (typeof open === "function") open(agentRpcTarget(down.agent));
      } else {
        this.drag.end(x, y);
      }
    } else if (this.gesture === "rect") {
      this.director.endRect();
    }
    this.downAt = null;
    this.endGesture();
  };

  // ── keyboard ──────────────────────────────────────────────────────────────
  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    if (e.key === "Escape") {
      if (this.prompt) {
        this.prompt = null;
        return;
      }
      if (this.radial.open) {
        this.radial.close();
        return;
      }
      if (this.director.active) {
        this.director.exit();
        return;
      }
    }

    if (this.radial.open && this.radial.handleKey(e)) {
      e.preventDefault();
      return;
    }

    if (typing) return;

    if ((e.key === "d" || e.key === "D") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.director.toggle();
    }
  };

  // ── prompt submit ─────────────────────────────────────────────────────────
  private submitPrompt(): void {
    const p = this.prompt;
    if (!p) return;
    const value = this.promptValue;
    this.prompt = null;
    p.onSubmit(value);
  }

  // ── render ────────────────────────────────────────────────────────────────
  override render() {
    const p = this.prompt;
    return html`
      <button
        class="wi-fab ${this.director.active ? "on" : ""}"
        title="Director mode (D)"
        aria-pressed=${this.director.active}
        @click=${() => this.director.toggle()}
      >
        ⌖ Director
      </button>

      ${this.drag.render()} ${this.director.render()} ${this.radial.render()}

      ${p
        ? html`<div
            class="wi-prompt-backdrop"
            @pointerdown=${() => {
              this.prompt = null;
            }}
          >
            <div
              class="wi-prompt"
              role="dialog"
              aria-label=${p.title}
              @pointerdown=${(e: Event) => e.stopPropagation()}
            >
              <div class="wi-prompt-title">${p.title}</div>
              <textarea
                class="wi-prompt-input"
                placeholder=${p.placeholder ?? ""}
                .value=${this.promptValue}
                @input=${(e: Event) => {
                  this.promptValue = (e.target as HTMLTextAreaElement).value;
                }}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    this.submitPrompt();
                  }
                }}
              ></textarea>
              <div class="wi-prompt-actions">
                <button class="wi-bar-btn ghost" @click=${() => (this.prompt = null)}>
                  Cancel
                </button>
                <button class="wi-bar-btn primary" @click=${() => this.submitPrompt()}>
                  ${p.confirmLabel ?? "Send"}
                </button>
              </div>
            </div>
          </div>`
        : ""}

      ${this.toastMsg
        ? html`<div class="wi-toast ${this.toastKind}" role="status">${this.toastMsg}</div>`
        : ""}
    `;
  }

  static styles = css`
    :host {
      position: fixed;
      inset: auto;
      pointer-events: none;
      z-index: 60;
      font-family: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
      color: #f5e9c8;
      --wi-gold: #d4af37;
      --wi-gold-soft: #f5d77a;
      --wi-bg: rgba(10, 10, 14, 0.92);
      --wi-line: rgba(212, 175, 55, 0.55);
    }
    .wi-svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
      pointer-events: none;
    }

    /* ── drag-to-assign ── */
    .wi-dropzone {
      fill: rgba(212, 175, 55, 0.08);
      stroke: var(--wi-gold);
      stroke-width: 1.5;
      stroke-dasharray: 6 5;
      opacity: 0.55;
      transition: opacity 0.12s ease;
    }
    .wi-dropzone.hot {
      fill: rgba(212, 175, 55, 0.22);
      stroke: var(--wi-gold-soft);
      stroke-width: 2.5;
      stroke-dasharray: none;
      opacity: 1;
      filter: drop-shadow(0 0 10px rgba(212, 175, 55, 0.7));
    }
    .wi-dropzone-label {
      fill: var(--wi-gold-soft);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      opacity: 0.7;
      text-transform: uppercase;
    }
    .wi-dropzone-label.hot {
      opacity: 1;
    }
    .wi-ghost {
      position: absolute;
      transform: translate(-50%, -50%);
      display: flex;
      align-items: center;
      gap: 6px;
      pointer-events: none;
      filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.6));
    }
    .wi-ghost-dot {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, var(--wi-gold-soft), var(--wi-gold));
      box-shadow: 0 0 14px rgba(212, 175, 55, 0.9);
    }
    .wi-ghost-label {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 6px;
      background: var(--wi-bg);
      border: 1px solid var(--wi-line);
      white-space: nowrap;
    }
    .wi-reject {
      position: absolute;
      transform: translate(-50%, -50%);
      color: #ff5c5c;
      font-size: 26px;
      font-weight: 700;
      pointer-events: none;
      animation: wi-reject 0.5s ease forwards;
    }
    @keyframes wi-reject {
      0% { transform: translate(-50%, -50%) scale(0.4); opacity: 0; }
      30% { transform: translate(-50%, -50%) scale(1.2); opacity: 1; }
      100% { transform: translate(-50%, -50%) scale(1); opacity: 0; }
    }

    /* ── radial menu ── */
    .wi-radial-backdrop {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.18);
    }
    .wi-radial {
      position: absolute;
      width: 0;
      height: 0;
      pointer-events: none;
    }
    .wi-radial-hub {
      position: absolute;
      transform: translate(-50%, -50%);
      width: 40px;
      height: 40px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 700;
      color: var(--wi-gold-soft);
      background: var(--wi-bg);
      border: 1.5px solid var(--wi-gold);
      box-shadow: 0 0 18px rgba(212, 175, 55, 0.5);
    }
    .wi-radial-btn {
      position: absolute;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      width: 64px;
      padding: 7px 4px;
      border-radius: 10px;
      cursor: pointer;
      color: #f5e9c8;
      background: var(--wi-bg);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid var(--wi-line);
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55);
      transition: transform 0.08s ease, border-color 0.12s ease, background 0.12s ease;
      animation: wi-pop 0.14s ease backwards;
    }
    .wi-radial-btn:hover,
    .wi-radial-btn:focus-visible {
      border-color: var(--wi-gold-soft);
      background: rgba(212, 175, 55, 0.18);
      outline: none;
    }
    .wi-radial-btn.danger:hover,
    .wi-radial-btn.danger:focus-visible {
      border-color: #ff6b6b;
      background: rgba(255, 92, 92, 0.16);
    }
    .wi-radial-icon {
      font-size: 16px;
      line-height: 1;
      color: var(--wi-gold-soft);
    }
    .wi-radial-label {
      font-size: 9px;
      letter-spacing: 0.03em;
      text-align: center;
    }
    @keyframes wi-pop {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* ── director mode ── */
    .wi-director-tint {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: radial-gradient(
        circle at 50% 40%,
        rgba(212, 175, 55, 0.05),
        rgba(0, 0, 0, 0.42)
      );
      box-shadow: inset 0 0 0 2px rgba(212, 175, 55, 0.4);
    }
    .wi-sel-rect {
      fill: rgba(212, 175, 55, 0.12);
      stroke: var(--wi-gold-soft);
      stroke-width: 1.5;
      stroke-dasharray: 5 4;
    }
    .wi-sel-halo {
      fill: none;
      stroke: var(--wi-gold-soft);
      stroke-width: 2.5;
      filter: drop-shadow(0 0 6px rgba(212, 175, 55, 0.8));
    }
    .wi-director-bar {
      position: absolute;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      pointer-events: auto;
      background: var(--wi-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--wi-gold);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(212, 175, 55, 0.15);
    }
    .wi-director-title {
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.18em;
      color: var(--wi-gold);
    }
    .wi-director-count {
      font-size: 11px;
      color: var(--wi-gold-soft);
      opacity: 0.85;
      padding-right: 4px;
    }

    /* ── shared buttons ── */
    .wi-bar-btn {
      pointer-events: auto;
      font: inherit;
      font-size: 11px;
      padding: 6px 11px;
      border-radius: 8px;
      cursor: pointer;
      color: #f5e9c8;
      background: rgba(212, 175, 55, 0.1);
      border: 1px solid var(--wi-line);
      transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s;
    }
    .wi-bar-btn:hover:not(:disabled),
    .wi-bar-btn:focus-visible:not(:disabled) {
      background: rgba(212, 175, 55, 0.24);
      border-color: var(--wi-gold-soft);
      outline: none;
    }
    .wi-bar-btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .wi-bar-btn.danger:hover:not(:disabled) {
      background: rgba(255, 92, 92, 0.2);
      border-color: #ff6b6b;
    }
    .wi-bar-btn.ghost {
      background: transparent;
    }
    .wi-bar-btn.primary {
      background: var(--wi-gold);
      color: #1a1408;
      font-weight: 700;
      border-color: var(--wi-gold-soft);
    }

    /* ── director toggle FAB ── */
    .wi-fab {
      position: absolute;
      right: 14px;
      bottom: 14px;
      pointer-events: auto;
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      padding: 8px 13px;
      border-radius: 10px;
      cursor: pointer;
      color: var(--wi-gold-soft);
      background: var(--wi-bg);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid var(--wi-line);
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5);
    }
    .wi-fab:hover,
    .wi-fab:focus-visible {
      border-color: var(--wi-gold-soft);
      outline: none;
    }
    .wi-fab.on {
      background: var(--wi-gold);
      color: #1a1408;
      box-shadow: 0 0 18px rgba(212, 175, 55, 0.6);
    }

    /* ── prompt ── */
    .wi-prompt-backdrop {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      display: grid;
      place-items: center;
      background: rgba(0, 0, 0, 0.5);
      z-index: 5;
    }
    .wi-prompt {
      width: min(440px, 86vw);
      padding: 16px;
      background: var(--wi-bg);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid var(--wi-gold);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(212, 175, 55, 0.15);
    }
    .wi-prompt-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--wi-gold-soft);
      margin-bottom: 10px;
      letter-spacing: 0.03em;
    }
    .wi-prompt-input {
      width: 100%;
      min-height: 88px;
      resize: vertical;
      box-sizing: border-box;
      font: inherit;
      font-size: 12px;
      color: #f5e9c8;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--wi-line);
      border-radius: 8px;
      padding: 9px 10px;
    }
    .wi-prompt-input:focus {
      outline: none;
      border-color: var(--wi-gold-soft);
    }
    .wi-prompt-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }

    /* ── toast ── */
    .wi-toast {
      position: absolute;
      bottom: 64px;
      left: 50%;
      transform: translateX(-50%);
      pointer-events: none;
      font-size: 12px;
      padding: 8px 14px;
      border-radius: 9px;
      background: var(--wi-bg);
      border: 1px solid var(--wi-line);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
      animation: wi-pop 0.16s ease;
    }
    .wi-toast.ok {
      border-color: var(--wi-gold);
      color: var(--wi-gold-soft);
    }
    .wi-toast.err {
      border-color: #ff6b6b;
      color: #ff9b9b;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "world-interactions": WorldInteractions;
  }
}
