/**
 * <world-sectors> — distinct iso architecture for each InfiniBot tool sector.
 *
 * A self-contained, presentation-only custom element. It renders one monoline
 * iso building per sector of the galactic-HQ floorplan (sector-buildings.ts),
 * laid out on the SAME 24×24 station grid the PIXI map uses (sector-layout.ts),
 * so the architecture sits where each subsystem lives. It NEVER touches the
 * PIXI engine, <agency-world-viz>, the iso engine, sprites, or camera — it is a
 * decorative SVG overlay that the host positions over the world frame.
 *
 * Buildings light up at dusk: <world-atmosphere> flips `window.__worldLightsOn`
 * + sets `document.documentElement.dataset.worldLights="on"` + fires
 * `world-atmosphere:phase`. This element listens and toggles `data-lit` on its
 * shadow root, which drives the shared `.sector-window` glow + `.sector-beacon`
 * pulse. With no atmosphere mounted it falls back to reading the dataset on
 * connect, so it still works standalone.
 *
 * ── MOUNT (one-liner) ─────────────────────────────────────────────────────────
 *   Over the world frame, ABOVE <world-atmosphere> (so lit windows glow above
 *   the night wash) and below the live viz sprites:
 *     <world-sectors style="position:absolute;inset:0;z-index:2;pointer-events:none"></world-sectors>
 *   Optionally align to the viz camera by feeding it pan/zoom (see API).
 *
 * ── ATTRIBUTES / API ──────────────────────────────────────────────────────────
 *   attr  labels         show sector name plates
 *   attr  lit            force lights on (ignores clock) — handy for demos
 *   meth  setLit(boolean|null)   force on/off, or null → follow atmosphere
 *   meth  setCamera({panX,panY,zoom})   nudge layout to match host camera
 */
import { LitElement, css, html, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { BUILDINGS, DEFAULT_PALETTE, type BuildingPalette } from "./sector-buildings.js";

/**
 * Sector grid placement, mirrored from SECTORS in
 * ../sector-layout.ts (kept inline so we don't pull PIXI/gsap into this overlay).
 * Coords are tile-space CENTRES on the 24×24 platform.
 */
const STATION = { cols: 24, rows: 24 };
const SECTOR_CENTERS: Record<string, { c: number; r: number }> = {
  observatory: { c: 4, r: 4 },
  "mission-control": { c: 12, r: 4 },
  "comms-deck": { c: 20, r: 4 },
  "agent-quarters": { c: 4, r: 12 },
  "command-atrium": { c: 12, r: 12 },
  "broadcast-studio": { c: 20, r: 10 },
  "the-vault": { c: 20, r: 14 },
  "engineering-bay": { c: 4, r: 20 },
  "gateway-concourse": { c: 12, r: 20 },
  "canvas-atrium": { c: 20, r: 20 },
};

// Iso projection (half-tile 40×20). Diamond spans roughly ±480 in x, 0..480 in y.
const TILE_W = 40;
const TILE_H = 20;
const VIEW_W = 1100;
const VIEW_H = 640;
const ORIGIN_X = VIEW_W / 2;
const ORIGIN_Y = 70;

function isoOf(c: number, r: number): { x: number; y: number; depth: number } {
  // Centre the grid (12,12) at the origin.
  const cc = c - STATION.cols / 2;
  const rr = r - STATION.rows / 2;
  return {
    x: ORIGIN_X + (cc - rr) * (TILE_W / 2),
    y: ORIGIN_Y + (cc + rr) * (TILE_H / 2) + VIEW_H * 0.33,
    depth: cc + rr, // painter's order: smaller = farther/back
  };
}

@customElement("world-sectors")
export class WorldSectors extends LitElement {
  @property({ type: Boolean }) labels = false;
  /** Force lights on regardless of the clock. */
  @property({ type: Boolean }) lit = false;

  @state() private _lit = false;
  private _override: boolean | null = null;
  private _palette: BuildingPalette = DEFAULT_PALETTE;
  private _cam = { panX: 0, panY: 0, zoom: 1 };

  private _onPhase = (e: Event) => {
    const d = (e as CustomEvent).detail || {};
    if (this._override == null) this._lit = !!d.lightsOn;
  };

  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      display: block;
      pointer-events: none;
      overflow: hidden;
    }
    svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .building {
      transition: filter 2.5s ease;
    }
    .label {
      font: 600 9px/1 ui-monospace, monospace;
      fill: rgba(213, 226, 245, 0.55);
      letter-spacing: 0.12em;
      text-anchor: middle;
    }
    /* Windows / lamps — dark by day, gold glow once lit. */
    .sector-window {
      transition: opacity 2.8s ease;
    }
    :host([data-lit]) .sector-window {
      opacity: 0.95 !important;
      filter: drop-shadow(0 0 4px rgba(251, 191, 36, 0.95))
        drop-shadow(0 0 9px rgba(251, 191, 36, 0.5));
    }
    /* Structural lines warm + brighten once the city is lit. */
    .building {
      stroke-opacity: 0.9;
    }
    :host([data-lit]) .building {
      filter: drop-shadow(0 0 6px rgba(251, 191, 36, 0.4));
    }
    /* Glassmorphic night halo behind each volume. */
    :host([data-lit]) .glass-base {
      opacity: 0.5;
    }
    .glass-base {
      opacity: 0.12;
      transition: opacity 2.5s ease;
    }
    /* Beacons pulse only when lit (reduced-motion disables it). */
    :host([data-lit]) .sector-beacon {
      animation: pulse 2.4s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .building,
      .sector-window,
      .glass-base {
        transition: none;
      }
      :host([data-lit]) .sector-beacon {
        animation: none;
        opacity: 0.9;
      }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("world-atmosphere:phase", this._onPhase);
    // Fall back to the dataset the atmosphere element leaves on <html>.
    if (this._override == null) {
      const ds = document.documentElement.dataset.worldLights;
      if (ds) this._lit = ds === "on";
      else if (typeof (window as any).__worldLightsOn === "boolean")
        this._lit = (window as any).__worldLightsOn;
    }
    this._reflectLit();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("world-atmosphere:phase", this._onPhase);
  }

  protected updated(): void {
    this._reflectLit();
  }

  /** Force lights on/off, or null to resume following <world-atmosphere>. */
  setLit(v: boolean | null): void {
    this._override = v;
    if (v != null) this._lit = v;
    this.requestUpdate();
  }

  /** Nudge the layout to roughly track the host camera. */
  setCamera(cam: { panX?: number; panY?: number; zoom?: number }): void {
    this._cam = { ...this._cam, ...cam };
    this.requestUpdate();
  }

  private _reflectLit(): void {
    const on = this._override ?? this._lit ?? this.lit;
    if (on) this.setAttribute("data-lit", "");
    else this.removeAttribute("data-lit");
  }

  render() {
    const p = this._palette;
    // Sort back-to-front so nearer buildings overlap farther ones correctly.
    const placed = BUILDINGS.map((b) => {
      const c = SECTOR_CENTERS[b.sectorId] ?? { c: 12, r: 12 };
      return { b, iso: isoOf(c.c, c.r) };
    }).sort((a, z) => a.iso.depth - z.iso.depth);

    const { panX, panY, zoom } = this._cam;

    return html`
      <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <g transform="translate(${panX} ${panY}) scale(${zoom})">
          ${placed.map(
            ({ b, iso }) => svg`
              <g class="building" transform="translate(${iso.x} ${iso.y})">
                <title>${b.label} · ${b.archetype}</title>
                <!-- glassmorphic ground halo -->
                <ellipse class="glass-base" cx="0" cy="0" rx="46" ry="20"
                  fill="${p.gold}" />
                ${b.draw(p)}
                ${
                  this.labels
                    ? svg`<text class="label" x="0" y="24">${b.label}</text>`
                    : ""
                }
              </g>`,
          )}
        </g>
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "world-sectors": WorldSectors;
  }
}
