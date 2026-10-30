/**
 * <world-environment> — atmospheric backdrop for the agent world map.
 *
 * A self-contained, presentation-only custom element that layers (back → front):
 *   1. a holographic skybox (radial base, rotating wash, drifting nebulae,
 *      3 parallax star fields)            → skybox.ts
 *   2. a volumetric pulsing ground grid   → ground-grid.ts
 *   3. an animated atrium conduit-beam overlay (canvas) → conduit-beams.ts
 *
 * It is designed to mount BEHIND <agency-world-viz> (this element at z-index 0,
 * the viz at z-index 1+). It NEVER touches the viz, its PIXI engine, or the
 * atrium system — it only consumes data the host chooses to feed it.
 *
 * ── MOUNT (one-liner) ─────────────────────────────────────────────────────────
 *   Inside the world-map frame, before the <agency-world-viz>:
 *     <world-environment style="position:absolute;inset:0;z-index:0"></world-environment>
 *     <agency-world-viz ...></agency-world-viz>   // already z-index:1
 *
 *   ⚠ For the environment to be visible, the viz must let it show through. The
 *   viz host currently paints an opaque `background:#0a0e1a` and an opaque PIXI
 *   canvas. To reveal the environment the HOST integration must make the viz
 *   backdrop transparent (e.g. set `--viz-bg: transparent` / clear the PIXI
 *   renderer background) — that change belongs to the viz/host owner, not here.
 *
 * ── ATTRIBUTES / API ──────────────────────────────────────────────────────────
 *   attr  activity="0..1"                 system-activity level (grid pulse + flow)
 *   attr  beams='[{from,to,intensity,color}]'  initial beam set (JSON)
 *   attr  sky-theme="night|dusk|dawn"      palette
 *   meth  setActivity(0..1)
 *   meth  addBeam({from:{x,y},to:{x,y},intensity?,color?}) → id   (x,y are 0..1)
 *   meth  removeBeam(id)
 *   meth  setBeams(specs[])
 *   meth  setSkyTheme("night"|"dusk"|"dawn")
 *
 * ── HOST INTEGRATION CONTRACT (window events — no clean API exists in the viz) ─
 *   The atrium conduit geometry lives in PIXI (activity-map.ts) and is not
 *   exposed. To animate real conduits the host should relay them as window
 *   events (this element listens globally):
 *     window.dispatchEvent(new CustomEvent("world-env:activity", { detail: 0..1 }))
 *     window.dispatchEvent(new CustomEvent("world-env:beams",     { detail: BeamSpec[] }))
 *     window.dispatchEvent(new CustomEvent("world-env:beam-add",  { detail: {id?, ...BeamSpec} }))
 *     window.dispatchEvent(new CustomEvent("world-env:beam-remove",{ detail: { id } }))
 *     window.dispatchEvent(new CustomEvent("world-env:pan",       { detail: { x, y } }))  // px, for parallax
 *   Until any of these arrive the element runs ambient DEMO data so it never
 *   looks dead.
 */
import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  buildStarLayers,
  renderSky,
  skyboxStyles,
  SKY_THEMES,
  type SkyTheme,
} from "./world-environment/skybox.js";
import {
  groundGridStyles,
  registerGridProps,
  renderGround,
} from "./world-environment/ground-grid.js";
import { ConduitBeams, type BeamSpec } from "./world-environment/conduit-beams.js";

@customElement("world-environment")
export class WorldEnvironment extends LitElement {
  @property({ type: Number }) activity = 0.3;
  @property({ type: String, attribute: "sky-theme" }) skyTheme: SkyTheme = "night";
  @property({ attribute: "beams" }) beamsAttr: string | null = null;

  static styles = [
    css`
      :host {
        display: block;
        position: relative;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        pointer-events: none;
        background: #000;
      }
      .we-beams {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
    `,
    skyboxStyles,
    groundGridStyles,
  ];

  private stars = buildStarLayers();
  private beams: ConduitBeams | null = null;
  private ro: ResizeObserver | null = null;
  private demoTimer = 0;
  private demoActive = false;
  private gotExternalActivity = false;
  private gotExternalBeams = false;
  private panX = 0;
  private panY = 0;

  connectedCallback(): void {
    super.connectedCallback();
    registerGridProps();
    window.addEventListener("world-env:activity", this.onActivityEvt as EventListener);
    window.addEventListener("world-env:beams", this.onBeamsEvt as EventListener);
    window.addEventListener("world-env:beam-add", this.onBeamAddEvt as EventListener);
    window.addEventListener("world-env:beam-remove", this.onBeamRemoveEvt as EventListener);
    window.addEventListener("world-env:pan", this.onPanEvt as EventListener);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("world-env:activity", this.onActivityEvt as EventListener);
    window.removeEventListener("world-env:beams", this.onBeamsEvt as EventListener);
    window.removeEventListener("world-env:beam-add", this.onBeamAddEvt as EventListener);
    window.removeEventListener("world-env:beam-remove", this.onBeamRemoveEvt as EventListener);
    window.removeEventListener("world-env:pan", this.onPanEvt as EventListener);
    this.ro?.disconnect();
    this.beams?.stop();
    if (this.demoTimer) clearInterval(this.demoTimer);
  }

  firstUpdated(): void {
    this.applyTheme();
    this.applyActivity();
    const canvas = this.renderRoot.querySelector<HTMLCanvasElement>("canvas");
    if (canvas) {
      this.beams = new ConduitBeams(canvas);
      this.beams.setActivity(this.activity);
      this.syncCanvasSize();
      this.beams.start();
    }
    this.ro = new ResizeObserver(() => this.syncCanvasSize());
    this.ro.observe(this);
    // Pointer parallax fallback (host may also dispatch world-env:pan).
    this.addEventListener("pointermove", this.onPointerMove as EventListener);
    if (this.beamsAttr) this.applyBeamsAttr();
    // Kick off ambient demo unless the host feeds real data shortly.
    this.scheduleDemo();
  }

  updated(changed: PropertyValues): void {
    if (changed.has("activity")) this.applyActivity();
    if (changed.has("skyTheme")) this.applyTheme();
    if (changed.has("beamsAttr")) this.applyBeamsAttr();
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  setActivity(v: number): void {
    this.gotExternalActivity = true;
    this.stopDemo();
    this.activity = Math.max(0, Math.min(1, v));
    this.applyActivity();
  }

  addBeam(spec: BeamSpec): string {
    this.gotExternalBeams = true;
    this.stopDemo();
    return this.beams?.addBeam(spec) ?? "";
  }

  removeBeam(id: string): void {
    this.beams?.removeBeam(id);
  }

  setBeams(specs: BeamSpec[]): void {
    this.gotExternalBeams = true;
    this.stopDemo();
    this.beams?.setBeams(specs);
  }

  setSkyTheme(theme: SkyTheme): void {
    this.skyTheme = theme;
    this.applyTheme();
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private applyActivity(): void {
    const a = Math.max(0, Math.min(1, this.activity));
    this.style.setProperty("--we-activity", String(a));
    // Faster pulses as activity rises: 5.5s (idle) → 2.2s (busy).
    this.style.setProperty("--we-pulse-speed", `${(5.5 - 3.3 * a).toFixed(2)}s`);
    this.beams?.setActivity(a);
  }

  private applyTheme(): void {
    const pal = SKY_THEMES[this.skyTheme] ?? SKY_THEMES.night;
    for (const [k, v] of Object.entries(pal)) this.style.setProperty(k, v);
  }

  private applyBeamsAttr(): void {
    if (!this.beamsAttr || !this.beams) return;
    try {
      const specs = JSON.parse(this.beamsAttr) as BeamSpec[];
      if (Array.isArray(specs)) this.setBeams(specs);
    } catch {
      /* malformed attr — ignore */
    }
  }

  private syncCanvasSize(): void {
    const r = this.getBoundingClientRect();
    this.beams?.resize(r.width || 800, r.height || 480);
  }

  private setPan(x: number, y: number): void {
    this.panX = x;
    this.panY = y;
    this.style.setProperty("--we-pan-x", `${x}px`);
    this.style.setProperty("--we-pan-y", `${y}px`);
  }

  // ── event handlers ───────────────────────────────────────────────────────────
  private onActivityEvt = (e: CustomEvent<number>) => {
    if (typeof e.detail === "number") this.setActivity(e.detail);
  };
  private onBeamsEvt = (e: CustomEvent<BeamSpec[]>) => {
    if (Array.isArray(e.detail)) this.setBeams(e.detail);
  };
  private onBeamAddEvt = (e: CustomEvent<BeamSpec>) => {
    if (e.detail?.from && e.detail?.to) this.addBeam(e.detail);
  };
  private onBeamRemoveEvt = (e: CustomEvent<{ id: string }>) => {
    if (e.detail?.id) this.removeBeam(e.detail.id);
  };
  private onPanEvt = (e: CustomEvent<{ x: number; y: number }>) => {
    if (e.detail) this.setPan(e.detail.x ?? 0, e.detail.y ?? 0);
  };
  private onPointerMove = (e: PointerEvent) => {
    const r = this.getBoundingClientRect();
    const nx = (e.clientX - r.left) / (r.width || 1) - 0.5;
    const ny = (e.clientY - r.top) / (r.height || 1) - 0.5;
    this.setPan(nx * -40, ny * -28);
  };

  // ── ambient demo (when host feeds nothing) ────────────────────────────────────
  private scheduleDemo(): void {
    window.setTimeout(() => {
      if (!this.gotExternalActivity && !this.gotExternalBeams) this.startDemo();
    }, 1500);
  }

  private startDemo(): void {
    if (this.demoActive) return;
    this.demoActive = true;
    if (!this.gotExternalBeams && this.beams) {
      // Hub-and-spoke conduits radiating from the atrium core (~centre).
      const cx = 0.5;
      const cy = 0.54;
      const spokes = 6;
      const demo: BeamSpec[] = [];
      for (let i = 0; i < spokes; i++) {
        const ang = (i / spokes) * Math.PI * 2 + 0.4;
        demo.push({
          from: { x: cx, y: cy },
          to: { x: cx + Math.cos(ang) * 0.34, y: cy + Math.sin(ang) * 0.3 },
          intensity: 0.3 + (i % 3) * 0.25,
          color: i % 2 ? "#d4af37" : "#7dd3fc",
        });
      }
      this.beams.setBeams(demo);
    }
    if (!this.gotExternalActivity) {
      let t = 0;
      this.demoTimer = window.setInterval(() => {
        t += 0.4;
        const a = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(t)); // 0.35..0.75 sine
        this.activity = a;
        this.applyActivity();
      }, 400);
    }
  }

  private stopDemo(): void {
    if (!this.demoActive) return;
    this.demoActive = false;
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = 0;
    }
  }

  override render() {
    return html`
      ${renderSky(this.stars)}
      ${renderGround()}
      <canvas class="we-beams"></canvas>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "world-environment": WorldEnvironment;
  }
}
