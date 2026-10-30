/**
 * <world-atmosphere> — real-clock day/night lighting wash for the agent world map.
 *
 * A self-contained, presentation-only custom element. It paints a full-area
 * ambient colour wash + darkening + vignette that tracks the wall clock through
 * five phases (dawn → day → dusk → night → deep-night), smoothly interpolated
 * minute-to-minute. It NEVER touches <agency-world-viz>, its PIXI engine, the
 * atrium system, the FX layer, or the environment backdrop. It only emits a
 * window event + a global flag that other layers may OPT IN to consuming.
 *
 * ── MOUNT (one-liner) ─────────────────────────────────────────────────────────
 *   Inside the world-map frame, ABOVE <world-environment> but BELOW the
 *   architecture + viz sprites (so the city + agents stay readable above the
 *   wash; the wash tints the SKY/backdrop, not the lit buildings):
 *     <world-environment style="position:absolute;inset:0;z-index:0"></world-environment>
 *     <world-atmosphere  style="position:absolute;inset:0;z-index:1"></world-atmosphere>
 *     <world-sectors     style="position:absolute;inset:0;z-index:2"></world-sectors>
 *     <agency-world-viz  style="...z-index:3"></agency-world-viz>
 *   (Wash uses CSS blend modes, so it tints whatever is painted beneath it.)
 *
 * ── ATTRIBUTES / API ──────────────────────────────────────────────────────────
 *   attr  override="dawn|day|dusk|night|deep-night"   freeze a phase (for demos)
 *   meth  setTimeOverride(phase|null)    freeze a phase, or null → resume clock
 *   meth  currentPhase() → Phase
 *   prop  (read) intensity 0..1          ambient light level (1 = bright noon)
 *
 * ── LIGHTING / OFF-HOURS CONTRACT (other layers OPT IN — we never reach in) ───
 *   Every tick this element publishes the world's lighting state two ways:
 *
 *   1. window.__worldIsNight : boolean
 *        true while the `deep-night` phase is active (the documented off-hours
 *        signal). agent-fx-layer / agent-emotes-layer (other owners) may read
 *        this to switch agents into sleepy / idle behaviours. It is ONLY ever
 *        true in deep-night — dusk/night still read false so "off-hours" means
 *        the genuine dead-of-night window, not merely "dark".
 *   2. window.__worldLightsOn : boolean   (true from dusk through deep-night)
 *        the "are the streetlights on" signal — flips true at dusk so building
 *        windows / lamps glow. <world-sectors> consumes this to light up.
 *   3. CustomEvent "world-atmosphere:phase" on window, detail:
 *        { phase, prevPhase, intensity (0..1), isNight, lightsOn,
 *          wash: {top, bottom}, hour (0..24) }
 *      Fired once on connect and again whenever the phase label changes
 *      (not every frame) so listeners can react cheaply.
 *
 *   Shared CSS hook: any element that adds the class `world-lit-window` and is
 *   rendered in the LIGHT DOM under a host that mirrors `data-world-lights` will
 *   glow at dusk. <world-sectors> uses its own shadow-scoped copy of this rule;
 *   this contract is documented here as the single source of phase truth.
 *
 *   Respects `prefers-reduced-motion`: cross-phase tweening + the vignette
 *   breathing are disabled; phase colours still apply, just without animation.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";

export type Phase = "dawn" | "day" | "dusk" | "night" | "deep-night";

interface Anchor {
  /** Wall-clock hour the anchor is centred on. */
  hour: number;
  phase: Phase;
  /** Top-of-screen wash colour [r,g,b]. */
  top: [number, number, number];
  /** Bottom (horizon) wash colour [r,g,b]. */
  bottom: [number, number, number];
  /** Ambient light 0 (pitch) .. 1 (bright noon). */
  light: number;
}

/**
 * Phase anchors around the 24h clock. Interpolation walks the *circular* list
 * so 02:00 deep-night blends smoothly back toward 06:00 dawn. Colours are kept
 * deliberately desaturated — this is a wash over an already-busy scene.
 */
const ANCHORS: Anchor[] = [
  { hour: 2.0, phase: "deep-night", top: [4, 6, 16], bottom: [10, 14, 34], light: 0.1 },
  { hour: 6.0, phase: "dawn", top: [58, 70, 122], bottom: [232, 168, 124], light: 0.55 },
  { hour: 12.0, phase: "day", top: [150, 196, 255], bottom: [210, 232, 255], light: 1.0 },
  { hour: 18.5, phase: "dusk", top: [74, 44, 94], bottom: [255, 126, 95], light: 0.5 },
  { hour: 21.5, phase: "night", top: [10, 18, 48], bottom: [22, 30, 66], light: 0.24 },
];

/** Hour each phase label is pinned to (used by setTimeOverride). */
const PHASE_HOUR: Record<Phase, number> = {
  "deep-night": 2.0,
  dawn: 6.0,
  day: 12.0,
  dusk: 18.5,
  night: 21.5,
};

const PHASES: Phase[] = ["dawn", "day", "dusk", "night", "deep-night"];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rgb = (c: [number, number, number]) => `rgb(${c.map(Math.round).join(",")})`;

/** Phase label for a given hour — the nearest anchor whose window we sit in. */
function phaseForHour(hour: number): Phase {
  // Windows (start inclusive): deep-night 22→5, dawn 5→8, day 8→17, dusk 17→20, night 20→22.
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 17) return "day";
  if (hour >= 17 && hour < 20) return "dusk";
  if (hour >= 20 && hour < 22) return "night";
  return "deep-night";
}

/** Interpolated wash + light for a fractional hour, walking the circular anchor list. */
function sample(hour: number): { top: string; bottom: string; light: number } {
  const n = ANCHORS.length;
  // Find the anchor segment [a, b) the hour falls in (circular, +24 wrap).
  let a = ANCHORS[n - 1];
  let b = ANCHORS[0];
  for (let i = 0; i < n; i++) {
    const cur = ANCHORS[i];
    const nxt = ANCHORS[(i + 1) % n];
    const start = cur.hour;
    const end = nxt.hour > cur.hour ? nxt.hour : nxt.hour + 24;
    const h = hour >= start ? hour : hour + 24;
    if (h >= start && h < end) {
      a = cur;
      b = nxt;
      const t = (h - start) / (end - start);
      const ease = t * t * (3 - 2 * t); // smoothstep
      return {
        top: rgb([lerp(a.top[0], b.top[0], ease), lerp(a.top[1], b.top[1], ease), lerp(a.top[2], b.top[2], ease)] as [number, number, number]),
        bottom: rgb([lerp(a.bottom[0], b.bottom[0], ease), lerp(a.bottom[1], b.bottom[1], ease), lerp(a.bottom[2], b.bottom[2], ease)] as [number, number, number]),
        light: lerp(a.light, b.light, ease),
      };
    }
  }
  return { top: rgb(b.top), bottom: rgb(b.bottom), light: b.light };
}

@customElement("world-atmosphere")
export class WorldAtmosphere extends LitElement {
  /** Frozen phase, or null to follow the real clock. Mirrors setTimeOverride. */
  @property({ type: String }) override: Phase | null = null;

  @state() private _top = "rgb(150,196,255)";
  @state() private _bottom = "rgb(210,232,255)";
  @state() private _light = 1;
  @state() private _phase: Phase = "day";

  /** Public read-only: ambient light level 0..1 (1 = bright noon). */
  get intensity() {
    return this._light;
  }

  private _timer: number | null = null;
  private _reduced = false;

  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      display: block;
      pointer-events: none;
      overflow: hidden;
      contain: strict;
    }
    .layer {
      position: absolute;
      inset: 0;
    }
    /* Colour wash — soft-light keeps the underlying scene legible while tinting. */
    .wash {
      mix-blend-mode: soft-light;
      transition: background 4s ease, opacity 4s ease;
    }
    /* Darkening — multiply the deep horizon colour in as the sun drops. */
    .darken {
      mix-blend-mode: multiply;
      transition: background 4s ease, opacity 4s ease;
    }
    /* Edge vignette that tightens at night. */
    .vignette {
      transition: opacity 4s ease;
      animation: breathe 9s ease-in-out infinite;
    }
    /* Warm pinpoint that rises at dusk/dawn near the horizon. */
    .horizon {
      mix-blend-mode: screen;
      transition: opacity 4s ease, background 4s ease;
    }
    @keyframes breathe {
      0%, 100% { opacity: var(--vig, 0); }
      50% { opacity: calc(var(--vig, 0) * 0.82); }
    }
    :host([data-reduced]) .wash,
    :host([data-reduced]) .darken,
    :host([data-reduced]) .vignette,
    :host([data-reduced]) .horizon {
      transition: none;
      animation: none;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this._reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (this._reduced) this.setAttribute("data-reduced", "");
    this._tick();
    // Re-evaluate every 30s — fast enough that phase boundaries feel live,
    // cheap enough to be invisible. CSS handles the per-frame smoothing.
    this._timer = window.setInterval(() => this._tick(), 30_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._timer != null) clearInterval(this._timer);
    this._timer = null;
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("override")) this._tick();
  }

  /** Freeze a phase for demos / screenshots, or pass null to resume the clock. */
  setTimeOverride(phase: Phase | null): void {
    this.override = phase && PHASES.includes(phase) ? phase : null;
    this._tick();
  }

  currentPhase(): Phase {
    return this._phase;
  }

  /** Current fractional hour, honouring an active override. */
  private _hour(): number {
    if (this.override) return PHASE_HOUR[this.override];
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }

  private _tick(): void {
    const hour = this._hour();
    const s = sample(hour);
    const phase = this.override ?? phaseForHour(hour);
    const prev = this._phase;

    this._top = s.top;
    this._bottom = s.bottom;
    this._light = s.light;
    this._phase = phase;

    const isNight = phase === "deep-night";
    const lightsOn = phase === "dusk" || phase === "night" || phase === "deep-night";

    // Publish the global lighting contract for opt-in consumers.
    (window as any).__worldIsNight = isNight;
    (window as any).__worldLightsOn = lightsOn;
    document.documentElement.dataset.worldLights = lightsOn ? "on" : "off";
    document.documentElement.dataset.worldPhase = phase;

    // Fire the phase event only when the LABEL changes — listeners react cheaply.
    if (phase !== prev) {
      window.dispatchEvent(
        new CustomEvent("world-atmosphere:phase", {
          detail: {
            phase,
            prevPhase: prev,
            intensity: s.light,
            isNight,
            lightsOn,
            wash: { top: s.top, bottom: s.bottom },
            hour,
          },
        }),
      );
    }
    this.requestUpdate();
  }

  render() {
    // OPT-IN: the layered wash+darken+vignette dims the iso map by a notable
    // amount even at noon. Default to nothing; turn on with
    // `window.__worldAtmosphere = true` (or `?atmosphere=1`).
    const optIn =
      (typeof window !== "undefined" &&
        ((window as unknown as { __worldAtmosphere?: boolean }).__worldAtmosphere === true ||
          new URLSearchParams(window.location.search).get("atmosphere") === "1"));
    if (!optIn) return nothing;
    const dark = Math.max(0, 1 - this._light); // 0 noon .. ~0.9 deep-night
    const vig = 0.18 + dark * 0.62;
    // Warm horizon glow strength peaks at dawn/dusk (mid-light), fades at the extremes.
    const warm = this._phase === "dawn" || this._phase === "dusk" ? 0.5 : 0.0;
    return html`
      <div
        class="layer wash"
        style="background:linear-gradient(180deg, ${this._top} 0%, ${this._bottom} 100%); opacity:${0.55 + dark * 0.35}"
      ></div>
      <div
        class="layer darken"
        style="background:${this._bottom}; opacity:${dark * 0.7}"
      ></div>
      <div
        class="layer horizon"
        style="background:radial-gradient(120% 60% at 50% 92%, ${this._bottom} 0%, transparent 60%); opacity:${warm}"
      ></div>
      <div
        class="layer vignette"
        style="--vig:${vig}; background:radial-gradient(125% 125% at 50% 42%, transparent 52%, rgba(2,4,12,0.9) 100%); opacity:${vig}"
      ></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "world-atmosphere": WorldAtmosphere;
  }
  interface Window {
    __worldIsNight?: boolean;
    __worldLightsOn?: boolean;
  }
}
