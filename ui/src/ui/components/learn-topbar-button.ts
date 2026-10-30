/**
 * <learn-topbar-button> — graduation-cap trigger for the Learn / missions
 * surface, mounted in the global topbar's `.topbar-status` cluster right next
 * to the Live button.
 *
 * Replaces the old floating `<learn-floating-pill>` collapsed pill, which was a
 * sticky banner painting over the app chrome. Clicking dispatches
 * `infinibot:learn-open`, which `<learn-missions-panel>` (mounted in the app
 * shell) listens for.
 *
 * Also hosts the contextual **Learn this** chip: when the current page has a
 * guided track (its `routes`), the chip launches that walkthrough in place.
 * And it boots the guided engine: a tour interrupted by a reload resumes here.
 *
 * Renders into the LIGHT DOM so the global `.topbar-glass-btn` glassmorphism
 * styling in `styles/layout.css` applies verbatim — the button is visually
 * identical to CHART / CANVAS and friends.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { subscribeLearn } from "../controllers/learn-missions";
import { missionsDismissed, starterMissions } from "./learn-missions-panel";
import {
  guidedClient,
  guidedState,
  loadGuidedCatalog,
  refreshGuidedCatalog,
  subscribeGuided,
  trackForRoute,
} from "../../learn/guided/catalog-store";
import { currentRoute, isTourActive, resumeIfPending, startTrack, subscribeTour } from "../../learn/guided/engine";
import { PLUGIN_HOST_EVENT } from "../plugin-host";

@customElement("learn-topbar-button")
export class LearnTopbarButton extends LitElement {
  /** Current app tab — set by app-render so the chip follows navigation. */
  @property({ attribute: false }) tab = "";
  /** Bumped to force a re-read of the localStorage-backed progress store. */
  @state() private rev = 0;

  private unsubs: (() => void)[] = [];
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private onPlugins = () => {
    if (guidedState().loaded) void refreshGuidedCatalog();
  };
  private onPop = () => {
    this.rev += 1;
  };

  /** Light DOM: inherit the topbar's global glass button styling. */
  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    const bump = () => {
      this.rev += 1;
    };
    this.unsubs = [subscribeLearn(bump), subscribeGuided(bump), subscribeTour(bump)];
    window.addEventListener(PLUGIN_HOST_EVENT, this.onPlugins);
    window.addEventListener("popstate", this.onPop);
    this.boot(0);
  }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    window.removeEventListener(PLUGIN_HOST_EVENT, this.onPlugins);
    window.removeEventListener("popstate", this.onPop);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    super.disconnectedCallback();
  }

  /** Once the gateway is connected: load the catalog, then resume any interrupted tour. */
  private boot(attempt: number): void {
    this.bootTimer = setTimeout(async () => {
      const c = guidedClient();
      if (!c?.connected) {
        if (attempt < 40) this.boot(attempt + 1);
        return;
      }
      await loadGuidedCatalog(c);
      await resumeIfPending();
    }, attempt === 0 ? 1200 : 750);
  }

  private open(): void {
    window.dispatchEvent(new CustomEvent("infinibot:learn-open"));
  }

  render() {
    void this.rev;
    void this.tab;
    const remaining = missionsDismissed() ? 0 : starterMissions().filter((m) => !m.done).length;
    const route = typeof window === "undefined" ? "/" : currentRoute();
    const onLearn = route === "/learn" || route.startsWith("/learn/") || route.startsWith("/learn?");
    const ctx = !onLearn && !isTourActive() ? trackForRoute(route) : undefined;
    return html`
      <button
        class="topbar-glass-btn learn-topbar-btn"
        data-learn-id="learn-topbar"
        @click=${() => this.open()}
        title="Learn — missions"
        aria-label=${remaining > 0
          ? `Learn — missions (${remaining} remaining)`
          : "Learn — missions"}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M22 9 12 4 2 9l10 5 10-5Z" />
          <path d="M6 11.5V17c0 1.1 2.7 2.5 6 2.5s6-1.4 6-2.5v-5.5" />
          <path d="M22 9v5" />
        </svg>
        ${remaining > 0
          ? html`<span class="learn-topbar-badge" aria-hidden="true">${remaining}</span>`
          : nothing}
      </button>
      ${/* After the cap in the DOM so the control bar's "⋯" menu entry (it clicks
        the first button) opens missions; CSS `order` still shows the chip first. */ ""}
      ${ctx
        ? html`<button
            class="topbar-glass-btn learn-this-chip"
            data-learn-id="learn-this"
            data-learn-track=${ctx.id}
            title=${`Learn this page — ${ctx.title} guided walkthrough`}
            aria-label=${`Learn this page: start the ${ctx.title} walkthrough`}
            @click=${() => void startTrack(ctx.id)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
              <path d="M12 17h.01" />
            </svg>
            <span class="learn-this-label">Learn this</span>
          </button>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "learn-topbar-button": LearnTopbarButton;
  }
}
