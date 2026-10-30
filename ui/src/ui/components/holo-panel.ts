/**
 * <holo-panel> — the single holographic-glass primitive used to compose the
 * Voice Terminal edge-HUD (running agents, completed agents, hardware tiles).
 *
 * Sci-fi control-deck aesthetic: translucent glass, cyan/teal glow edges, a
 * faint scanline/grid texture, corner ticks, and an animated border pulse for
 * "active" panels. Everything that paints around the voice blob composes ONE
 * of these — no per-lane card CSS is duplicated.
 *
 * Slots:
 *   [slot=title]  — small monospace header (left)
 *   [slot=badge]  — right-aligned status chip in the header
 *   (default)     — panel body
 *
 * Attributes / props:
 *   tone   "cyan" (default) | "teal" | "gold" | "danger" — glow hue
 *   active boolean — animated border pulse + brighter glow (running work)
 *   dim    boolean — desaturated / lowered opacity (past / idle)
 *   compact boolean — tighter padding for dense tiles
 *   frame  "box" (default) — the full glass card above
 *          "brackets" — borderless smoked glass with top-left + bottom-right
 *          corner brackets only (partial framing for floating HUD modules,
 *          e.g. the Voice Terminal's System column); no scanlines
 *   tone   "champagne" — fixed champagne-gold light (the Voice Terminal palette)
 *          instead of the theme primary
 */
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('holo-panel')
export class HoloPanel extends LitElement {
  @property({ reflect: true }) tone: 'cyan' | 'teal' | 'gold' | 'champagne' | 'danger' = 'cyan';
  @property({ type: Boolean, reflect: true }) active = false;
  @property({ type: Boolean, reflect: true }) dim = false;
  @property({ type: Boolean, reflect: true }) compact = false;
  @property({ reflect: true }) frame: 'box' | 'brackets' = 'box';
  /** Whether anything is slotted into the title/badge header (hidden when empty). */
  @state() private hasHead = false;

  private onHeadSlot = (): void => {
    const slots = this.renderRoot.querySelectorAll<HTMLSlotElement>('.hp-head slot');
    this.hasHead = [...slots].some((s) => s.assignedNodes({ flatten: true }).length > 0);
  };

  protected firstUpdated(): void {
    this.onHeadSlot();
  }

  render() {
    return html`
      <div class="hp" part="panel">
        <div class="hp-scan" aria-hidden="true"></div>
        <span class="tick tl"></span><span class="tick tr"></span>
        <span class="tick bl"></span><span class="tick br"></span>
        <div class="hp-head" part="head" ?hidden=${!this.hasHead}><slot name="title" @slotchange=${this.onHeadSlot}></slot><span class="spacer"></span><slot name="badge" @slotchange=${this.onHeadSlot}></slot></div>
        <div class="hp-body" part="body"><slot></slot></div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      /* tone → a single accent COLOR routed through the app theme tokens, so
         every panel follows whichever appearance theme the user picked. The
         per-tone palette is overridable by a host wrapper via --holo-tone-*. */
      --holo-tone-cyan:   var(--holo-tone-cyan-override,   var(--g-primary, #00e5ff));
      --holo-tone-teal:   var(--holo-tone-teal-override,   var(--g-accent,  #44ffcc));
      --holo-tone-gold:   var(--holo-tone-gold-override,   var(--g-primary, #ffb84a));
      --holo-tone-danger: var(--holo-tone-danger-override, #ff5a5a);
      --holo-tone: var(--holo-tone-cyan);            /* cyan → primary */
      --edge: color-mix(in srgb, var(--holo-tone) 35%, var(--g-border, transparent));
      --glow: color-mix(in srgb, var(--holo-tone) 18%, transparent);
      font-family: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
      color: var(--g-fg, #c8d8e8);
    }
    :host([tone='teal'])   { --holo-tone: var(--holo-tone-teal); }
    :host([tone='gold'])   { --holo-tone: var(--holo-tone-gold); }
    :host([tone='champagne']) { --holo-tone: #d6a62a; }
    /* danger = thin red hairline, NOT a full red panel: keep the surface bg
       and only let the edge/glow read red. */
    :host([tone='danger']) {
      --holo-tone: var(--holo-tone-danger);
      --glow: color-mix(in srgb, var(--holo-tone-danger) 10%, transparent);
    }
    :host([dim]) { opacity: 0.6; filter: saturate(0.55); }

    .hp {
      position: relative;
      border-radius: 8px;
      padding: 10px 12px;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--holo-tone) 5%, var(--g-surface-strong, rgba(6,14,26,0.62))) 0%,
          var(--g-bg-deep, rgba(3,8,18,0.78)) 100%);
      border: 1px solid var(--edge);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--holo-tone) 5%, transparent) inset,
        0 1px 0 rgba(255,255,255,0.04) inset,   /* hairline top highlight */
        0 0 14px var(--glow),
        0 8px 28px rgba(0,0,0,0.45);
      backdrop-filter: blur(8px) saturate(1.1);
      -webkit-backdrop-filter: blur(8px) saturate(1.1);
      overflow: hidden;
    }
    :host([compact]) .hp { padding: 7px 9px; border-radius: 6px; }

    /* scanline + faint grid texture */
    .hp-scan {
      position: absolute; inset: 0; pointer-events: none; z-index: 0;
      background:
        repeating-linear-gradient(0deg, transparent, transparent 3px,
          color-mix(in srgb, var(--holo-tone) 3.5%, transparent) 3px,
          color-mix(in srgb, var(--holo-tone) 3.5%, transparent) 4px),
        linear-gradient(color-mix(in srgb, var(--holo-tone) 4%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--holo-tone) 4%, transparent) 1px, transparent 1px);
      background-size: 100% 4px, 22px 22px, 22px 22px;
      opacity: 0.55;
    }

    /* active = animated border pulse */
    :host([active]) .hp { animation: hp-pulse 2.4s ease-in-out infinite; }
    @keyframes hp-pulse {
      0%, 100% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--holo-tone) 5%, transparent) inset, 0 0 12px var(--glow), 0 8px 28px rgba(0,0,0,0.45); border-color: var(--edge); }
      50%      { box-shadow: 0 0 0 1px color-mix(in srgb, var(--holo-tone) 12%, transparent) inset, 0 0 24px color-mix(in srgb, var(--holo-tone) 32%, transparent), 0 8px 28px rgba(0,0,0,0.45); border-color: color-mix(in srgb, var(--holo-tone) 60%, transparent); }
    }

    /* corner ticks */
    .tick { position: absolute; width: 9px; height: 9px; z-index: 2; }
    .tick.tl { top: 4px;  left: 4px;  border-top: 1px solid var(--edge); border-left: 1px solid var(--edge); }
    .tick.tr { top: 4px;  right: 4px; border-top: 1px solid var(--edge); border-right: 1px solid var(--edge); }
    .tick.bl { bottom: 4px; left: 4px; border-bottom: 1px solid var(--edge); border-left: 1px solid var(--edge); }
    .tick.br { bottom: 4px; right: 4px; border-bottom: 1px solid var(--edge); border-right: 1px solid var(--edge); }

    .hp-head {
      position: relative; z-index: 1;
      display: flex; align-items: center; gap: 6px;
      font-size: 8.5px; letter-spacing: 0.16em; text-transform: uppercase;
      color: color-mix(in srgb, var(--holo-tone) 85%, var(--g-fg-dim, transparent));
      margin-bottom: 6px;
    }
    .hp-head:empty, .hp-head[hidden] { display: none; }

    /* frame="brackets": borderless smoked glass, partial framing only. */
    :host([frame='brackets']) .hp {
      border: 0;
      border-radius: 2px;
      background:
        radial-gradient(120% 70% at 0% 0%, color-mix(in srgb, var(--holo-tone) 7%, transparent), transparent 60%),
        linear-gradient(165deg, rgba(10, 11, 14, 0.62) 0%, rgba(6, 7, 9, 0.34) 55%, rgba(4, 5, 7, 0.08) 100%);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--holo-tone) 10%, transparent), 0 18px 40px -30px rgba(0, 0, 0, 0.9);
      backdrop-filter: blur(10px) saturate(1.05);
      -webkit-backdrop-filter: blur(10px) saturate(1.05);
    }
    :host([frame='brackets']) .hp-scan,
    :host([frame='brackets']) .tick.tr,
    :host([frame='brackets']) .tick.bl { display: none; }
    :host([frame='brackets']) .tick { width: 12px; height: 12px; --edge: color-mix(in srgb, var(--holo-tone) 55%, transparent); }
    :host([frame='brackets']) .tick.tl { top: 0; left: 0; }
    :host([frame='brackets']) .tick.br { bottom: 0; right: 0; }
    :host([frame='brackets'][active]) .hp { animation: none; }
    .spacer, .spacer { flex: 0; }
    .hp-head .spacer { flex: 1 1 auto; }
    .hp-body { position: relative; z-index: 1; }

    @media (prefers-reduced-motion: reduce) {
      :host([active]) .hp { animation: none; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'holo-panel': HoloPanel;
  }
}
