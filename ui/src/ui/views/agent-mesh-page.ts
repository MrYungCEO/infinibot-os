/**
 * Agent Mesh page (/mesh) — the canonical isometric agent mesh, full-bleed.
 *
 * Composes <agency-world-viz> (the same element the Dashboard band and the
 * Voice HUD backdrop use) rather than forking it. Each <agency-world-viz>
 * owns its own ActivityMap engine, Pixi canvas and AgencyDataBridge — there
 * is no module-level singleton to share or fight over — and the element
 * already pauses its ticker when the document is hidden or its host leaves
 * the viewport (IntersectionObserver), and tears everything down on
 * disconnect, so leaving the tab releases the GPU context.
 *
 * Mounted WITHOUT `no-overlays`: this is a full surface, so it gets the
 * recently-completed pinboard, active-agents breakdown and in-engine zoom
 * controls, and it is the surface that publishes the camera for mobile.
 * Clicking an agent opens the global Agent Focus modal (window.openAgentFocus).
 *
 * 2D / 3D: a toggle in the HUD switches to the 3D world (<mesh-world-3d>),
 * remembered per device. 3D is lazy-loaded with three.js only when chosen and
 * renders the viz's own MeshWorldModel, so both views show the same live
 * world; the 2D engine pauses (data keeps flowing) while 3D is on screen.
 */
import { LitElement, css, html, nothing } from "lit";
import { isTabAvailable } from "../plugin-host.js";
import { customElement, property, state } from "lit/decorators.js";
import "../components/agency-world-viz";
import type { AppViewState } from "../app-view-state.js";
import { getGatewayClient } from "../gateway-client.js";
import type { GatewayBrowserClient } from "../gateway.js";
import type { MeshWorldModel } from "./agent-ops/mesh-world-model.js";

type WorldViz = HTMLElement & {
  zoomToFit?: () => void;
  setSuspended?: (on: boolean) => void;
  world?: MeshWorldModel;
};

type MeshView = "2d" | "3d";
export const MESH_VIEW_KEY = "infinibot.mesh.view";

function readView(): MeshView {
  try {
    return localStorage.getItem(MESH_VIEW_KEY) === "3d" ? "3d" : "2d";
  } catch {
    return "2d";
  }
}

type Mesh3DModule = typeof import("../components/mesh-world-3d/mesh-world-3d.js");
let mesh3dModule: Promise<Mesh3DModule> | null = null;
/** Lazy chunk: three.js + the 3D world. Only fetched when 3D is chosen. */
export function loadMesh3D(): Promise<Mesh3DModule> {
  mesh3dModule ??= import("../components/mesh-world-3d/mesh-world-3d.js").catch((err) => {
    mesh3dModule = null;
    throw err;
  });
  return mesh3dModule;
}

@customElement("agent-mesh-page")
export class AgentMeshPage extends LitElement {
  @property({ attribute: false }) state: AppViewState | null = null;
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @state() private view: MeshView = readView();
  @state() private mod3d: Mesh3DModule | null = null;
  @state() private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private mobileMql: MediaQueryList | null = null;
  @state() private mobile = false;

  static override styles = css`
    :host {
      position: relative;
      display: block;
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      contain: strict;
    }
    agency-world-viz {
      position: absolute;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
      /* Own stacking context: the viz's high z-index overlays stay inside it,
         so the 3D view and its floating HUD can sit above it. */
      z-index: 0;
      isolation: isolate;
    }
    /* 3D on screen: the 2D map stays mounted (paused, still fed) so toggling
       back is instant and pixel-identical to before. */
    agency-world-viz.is-hidden {
      visibility: hidden;
      pointer-events: none;
    }
    mesh-world-3d {
      position: absolute;
      inset: 0;
      z-index: 2;
    }
    .mesh-hud--float {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 6;
    }
    .seg {
      display: inline-flex;
      padding: 2px;
      gap: 2px;
      border-radius: 7px;
      background: color-mix(in srgb, var(--g-primary, #d4af37) 10%, transparent);
    }
    .seg button {
      padding: 3px 9px;
      font-weight: 700;
    }
    .seg button[aria-pressed="true"] {
      background: var(--g-primary, #d4af37);
      color: #0b0b0d;
    }
    .loading3d,
    .notice {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      z-index: 7;
      padding: 10px 16px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 30%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, #0b0b0d 82%, transparent);
      color: var(--g-primary, #d4af37);
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .notice {
      top: auto;
      bottom: 60px;
      transform: translateX(-50%);
      color: var(--text, #e8e6e3);
    }
    /* Projected into the viz's top-left HUD toolbar row (slot="hud-toolbar"),
       so it stacks with Broadcast / Auto-focus / Spread instead of floating
       over them at narrow widths. */
    .mesh-hud {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 3px 2px 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 28%, transparent);
      border-radius: 8px;
      background: color-mix(in srgb, #0b0b0d 72%, transparent);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: var(--g-primary, #d4af37);
      font-size: 10.5px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      pointer-events: auto;
    }
    .mesh-hud__title {
      font-weight: 600;
      white-space: nowrap;
    }
    .mesh-hud__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 8px currentColor;
    }
    .mesh-hud__dot.is-off {
      background: var(--muted, #777);
      box-shadow: none;
    }
    button {
      all: unset;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      color: var(--text, #e8e6e3);
      letter-spacing: 0.08em;
      white-space: nowrap;
    }
    button:hover,
    button:focus-visible {
      background: color-mix(in srgb, var(--g-primary, #d4af37) 16%, transparent);
      color: var(--g-primary, #d4af37);
    }
    @media (max-width: 640px) {
      .mesh-hud {
        gap: 4px;
        padding: 2px 2px 2px 7px;
      }
      .mesh-hud__title,
      .mesh-hud__infi {
        display: none;
      }
      .seg button {
        padding: 3px 7px;
      }
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.mobileMql = window.matchMedia?.("(max-width: 640px), (pointer: coarse)") ?? null;
    this.mobile = !!this.mobileMql?.matches;
    this.mobileMql?.addEventListener?.("change", this.onMobileChange);
    if (this.view === "3d") void this.ensure3D();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.mobileMql?.removeEventListener?.("change", this.onMobileChange);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
  }

  override updated(): void {
    const viz = this.viz();
    viz?.setSuspended?.(this.view === "3d" && !!this.mod3d);
    // First 3D render can run before the viz is in the DOM — hand the model over now.
    const w3 = this.renderRoot.querySelector("mesh-world-3d") as (HTMLElement & { model: MeshWorldModel | null }) | null;
    if (w3 && !w3.model && viz?.world) w3.model = viz.world;
  }

  private readonly onMobileChange = (): void => {
    this.mobile = !!this.mobileMql?.matches;
  };

  private viz(): WorldViz | null {
    return this.renderRoot.querySelector("agency-world-viz") as WorldViz | null;
  }

  private async ensure3D(): Promise<void> {
    if (this.mod3d) return;
    try {
      this.mod3d = await loadMesh3D();
    } catch (err) {
      console.warn("[agent-mesh] 3D chunk failed to load", err);
      this.fallback("3D view failed to load — showing the 2D map");
    }
  }

  private setView(view: MeshView): void {
    if (view === this.view) return;
    this.view = view;
    try {
      localStorage.setItem(MESH_VIEW_KEY, view);
    } catch {
      /* storage unavailable: the choice lasts for this page */
    }
    if (view === "3d") void this.ensure3D();
  }

  /** Drop to 2D. `remember` (no WebGL at all) also stores 2D so the next visit doesn't retry. */
  private fallback(text: string, remember = false): void {
    if (remember) this.setView("2d");
    this.view = "2d";
    this.notice = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice = null), 5000);
  }

  private fit(): void {
    this.viz()?.zoomToFit?.();
  }

  private openInfiCode(): void {
    this.state?.setTab?.("inficode");
  }

  override render() {
    const client = this.client ?? this.state?.client ?? getGatewayClient() ?? null;
    const live = this.state ? this.state.connected : Boolean(client);
    const three = this.view === "3d";
    const ready3d = three && this.mod3d;
    const hud = (float: boolean) => html`
      <div
        class="mesh-hud ${float ? "mesh-hud--float" : ""}"
        slot=${float ? nothing : "hud-toolbar"}
        role="toolbar"
        aria-label="Agent mesh controls"
        data-ib-target="control:mesh/hud"
      >
        <span class="mesh-hud__dot ${live ? "" : "is-off"}" aria-hidden="true"></span>
        <span class="mesh-hud__title">Agent Mesh</span>
        <span class="seg" role="group" aria-label="Map view">
          <button type="button" data-view="2d" title="Isometric 2D map" aria-pressed=${three ? "false" : "true"} @click=${() => this.setView("2d")}>2D</button>
          <button type="button" data-view="3d" title="Live 3D world" aria-pressed=${three ? "true" : "false"} @click=${() => this.setView("3d")}>3D</button>
        </span>
        ${three
          ? nothing
          : html`<button type="button" title="Fit every agent in view" @click=${() => this.fit()}>Fit</button>
              ${isTabAvailable("inficode")
                ? html`<button type="button" class="mesh-hud__infi" title="Open the InfiCode sector mesh map" @click=${() => this.openInfiCode()}>
                    InfiCode mesh →
                  </button>`
                : nothing}`}
      </div>
    `;
    return html`
      <agency-world-viz review-layer class=${ready3d ? "is-hidden" : ""} .client=${client}>${ready3d ? nothing : hud(false)}</agency-world-viz>
      ${ready3d
        ? html`<mesh-world-3d
              ?mobile=${this.mobile}
              .model=${this.viz()?.world ?? null}
              .actions=${this.mod3d!.webActions(client)}
              @mesh3d-fallback=${(e: CustomEvent<{ reason: string }>) =>
                e.detail?.reason === "webgl-context-lost"
                  ? this.fallback("3D view lost its GPU context — showing the 2D map")
                  : this.fallback("3D isn't available on this device — showing the 2D map", true)}
            ></mesh-world-3d>
            ${hud(true)}`
        : nothing}
      ${three && !this.mod3d ? html`<div class="loading3d">Loading 3D world…</div>${hud(true)}` : nothing}
      ${this.notice ? html`<div class="notice" role="status">${this.notice}</div>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-mesh-page": AgentMeshPage;
  }
}
