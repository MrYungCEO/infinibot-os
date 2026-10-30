/**
 * <learn-missions-panel> — the Day-1 missions popover opened by the topbar
 * graduation cap (`infinibot:learn-open`).
 *
 * Missions are guided walkthroughs (core `CORE_MISSIONS` + plugin
 * `contributes.learn.missions`) run by the guided engine over the real app.
 *
 * Behaviour (fixes the old panel that sat over page content):
 *   • A popover anchored under the topbar — closes on outside click, Esc, route
 *     change, or when a mission starts. A bottom sheet under 640px.
 *   • Auto-pops once on a brand-new install, never on /learn, never while the
 *     first-run checklist is showing, and never again after "Don't show again"
 *     (stored per user in the gateway, so it stays dismissed on every device).
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getFirstRunStatus, isFirstRunActive } from "../controllers/first-run";
import {
  findTrack,
  guidedState,
  loadGuidedCatalog,
  pref,
  setPref,
  subscribeGuided,
  walkthroughProgress,
} from "../../learn/guided/catalog-store";
import { currentRoute, navigateTo, startWalkthrough } from "../../learn/guided/engine";
import type { LearnWalkthrough, PublicLearnTrack } from "../../../../src/learn/guided/types.js";

type MissionItem = { track: PublicLearnTrack; wt: LearnWalkthrough; done: boolean };

/** Starter missions available right now (plugin missions only while the plugin is on). */
export function starterMissions(): MissionItem[] {
  return guidedState()
    .missions.filter((m) => m.starter)
    .map((m) => {
      const [tid, wid] = m.walkthrough.split("/");
      const track = findTrack(tid!);
      const wt = track?.walkthroughs.find((w) => w.id === wid);
      return track && wt ? { track, wt, done: walkthroughProgress(track.id, wt.id)?.status === "completed" } : null;
    })
    .filter((x): x is MissionItem => Boolean(x));
}

export function missionsDismissed(): boolean {
  return Boolean(pref<boolean>("missionsDismissed"));
}

@customElement("learn-missions-panel")
export class LearnMissionsPanel extends LitElement {
  @state() private open = false;
  @state() private rev = 0;

  private unsub?: () => void;
  private onOpenRequest = () => {
    this.open = !this.open;
    if (this.open) void loadGuidedCatalog();
  };
  private onDocPointer = (e: Event) => {
    if (!this.open) return;
    const path = e.composedPath();
    if (path.includes(this)) return;
    // The topbar trigger toggles on its own.
    if (path.some((n) => n instanceof HTMLElement && n.tagName === "LEARN-TOPBAR-BUTTON")) return;
    this.open = false;
  };
  private onKey = (e: KeyboardEvent) => {
    if (this.open && e.key === "Escape") {
      this.open = false;
      e.stopPropagation();
    }
  };
  private onRoute = () => {
    this.open = false;
  };

  static styles = css`
    :host {
      position: fixed;
      right: 18px;
      top: 72px;
      z-index: 10040;
      font-family: var(--g-font, system-ui, sans-serif);
    }
    .card {
      width: min(440px, calc(100vw - 24px));
      max-height: min(70vh, 560px);
      overflow: auto;
      border-radius: 18px;
      background: color-mix(in srgb, var(--g-surface, #14110a) 96%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 36%, var(--g-border, #333));
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(12px);
      color: var(--g-fg, #e7e3d6);
      animation: card-in 0.2s ease;
    }
    @keyframes card-in {
      from {
        opacity: 0;
        translate: 0 -8px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .card {
        animation: none;
      }
    }
    @media (max-width: 640px) {
      :host {
        left: 8px;
        right: 8px;
        top: auto;
        bottom: max(8px, env(safe-area-inset-bottom));
      }
      .card {
        width: 100%;
      }
    }
    header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px 8px;
    }
    .glyph {
      width: 30px;
      height: 30px;
      border-radius: 9px;
      display: grid;
      place-items: center;
      color: var(--g-primary, #d4af37);
      background: color-mix(in srgb, var(--g-primary, #d4af37) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 45%, transparent);
    }
    h3 {
      margin: 0;
      font-size: 14.5px;
    }
    header p {
      margin: 2px 0 0;
      font-size: 11.5px;
      color: var(--g-fg-dim, #b9b2a0);
    }
    .x {
      margin-left: auto;
      background: transparent;
      border: none;
      color: var(--g-fg-dim, #b9b2a0);
      font-size: 18px;
      cursor: pointer;
      width: 32px;
      height: 32px;
      border-radius: 8px;
    }
    .x:hover,
    .x:focus-visible {
      color: var(--g-fg, #fff);
      background: color-mix(in srgb, var(--g-fg, #fff) 8%, transparent);
      outline: none;
    }
    ol {
      list-style: none;
      margin: 0;
      padding: 4px 12px 8px;
      display: grid;
      gap: 8px;
    }
    li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid var(--g-border, color-mix(in srgb, var(--g-fg, #fff) 12%, transparent));
    }
    li > div {
      flex: 1;
      min-width: 0;
    }
    li strong {
      display: block;
      font-size: 13px;
    }
    li span {
      font-size: 11.5px;
      color: var(--g-fg-dim, #b9b2a0);
    }
    .n {
      flex: none;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid var(--g-primary, #d4af37);
      color: var(--g-primary, #d4af37);
    }
    li.done .n {
      background: var(--g-success, #22c55e);
      border-color: var(--g-success, #22c55e);
      color: #fff;
    }
    button.btn {
      font: inherit;
      font-size: 12.5px;
      font-weight: 600;
      min-height: 36px;
      padding: 0 12px;
      border-radius: 10px;
      cursor: pointer;
      border: 1px solid var(--g-border, color-mix(in srgb, var(--g-fg, #fff) 18%, transparent));
      background: transparent;
      color: var(--g-fg, #fff);
      white-space: nowrap;
    }
    button.btn.primary {
      background: var(--g-primary, #d4af37);
      border-color: var(--g-primary, #d4af37);
      color: var(--g-on-primary, #111);
    }
    button.btn:focus-visible {
      outline: 2px solid var(--g-primary, #d4af37);
      outline-offset: 2px;
    }
    footer {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 8px 16px 14px;
      flex-wrap: wrap;
    }
    footer .spacer {
      flex: 1;
    }
    .link {
      background: none;
      border: 0;
      color: var(--g-fg-dim, #b9b2a0);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 3px;
      min-height: 36px;
    }
    .empty {
      padding: 10px 16px 4px;
      font-size: 12.5px;
      color: var(--g-fg-dim, #b9b2a0);
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub = subscribeGuided(() => {
      this.rev += 1;
    });
    window.addEventListener("infinibot:learn-open", this.onOpenRequest);
    window.addEventListener("popstate", this.onRoute);
    document.addEventListener("pointerdown", this.onDocPointer, true);
    document.addEventListener("keydown", this.onKey, true);
    this.scheduleAutoPop(0);
  }

  disconnectedCallback(): void {
    this.unsub?.();
    window.removeEventListener("infinibot:learn-open", this.onOpenRequest);
    window.removeEventListener("popstate", this.onRoute);
    document.removeEventListener("pointerdown", this.onDocPointer, true);
    document.removeEventListener("keydown", this.onKey, true);
    super.disconnectedCallback();
  }

  /** First-run auto-pop: once, and only where it can't cover what the user came for. */
  private scheduleAutoPop(attempt: number): void {
    setTimeout(async () => {
      if (pref("autoPopped") || missionsDismissed()) return;
      if (isFirstRunActive()) return; // the checklist already links the tour
      if (getFirstRunStatus() === null && attempt < 4) {
        this.scheduleAutoPop(attempt + 1);
        return;
      }
      await loadGuidedCatalog();
      const gs = guidedState();
      const anyProgress = Object.keys(gs.progress.walkthroughs).length > 0;
      if (anyProgress || pref("autoPopped") || missionsDismissed()) return;
      if (currentRoute().startsWith("/learn")) return;
      void setPref("autoPopped", true);
      this.open = true;
    }, attempt === 0 ? 1800 : 1200);
  }

  private start(item: MissionItem): void {
    this.open = false;
    void startWalkthrough(item.track.id, item.wt.id);
  }

  render() {
    void this.rev;
    if (!this.open) return nothing;
    const items = starterMissions();
    const left = items.filter((i) => !i.done).length;
    return html`
      <div class="card" role="dialog" aria-label="Day 1 missions" data-learn-id="missions-panel">
        <header>
          <span class="glyph" aria-hidden="true">🎓</span>
          <div>
            <h3>${left ? "Day 1 missions" : "Learn InfiniBot"}</h3>
            <p>${left ? `${left} short guided tours over the real app.` : "Starter missions done — explore the full catalog."}</p>
          </div>
          <button class="x" @click=${() => (this.open = false)} aria-label="Close">×</button>
        </header>
        ${items.length === 0 ? html`<div class="empty">Loading missions…</div>` : nothing}
        <ol>
          ${items.map(
            (i, n) => html`<li class=${i.done ? "done" : ""}>
              <span class="n">${i.done ? "✓" : n + 1}</span>
              <div><strong>${i.wt.title}</strong><span>${i.track.title} · ~${i.wt.estMinutes} min</span></div>
              <button class="btn ${i.done ? "" : "primary"}" @click=${() => this.start(i)}>${i.done ? "Replay" : "Start"}</button>
            </li>`,
          )}
        </ol>
        <footer>
          <button
            class="btn"
            data-learn-id="missions-open-learn"
            @click=${() => {
              this.open = false;
              navigateTo("/learn");
            }}
          >
            All tracks
          </button>
          <span class="spacer"></span>
          ${missionsDismissed()
            ? nothing
            : html`<button
                class="link"
                data-learn-id="missions-dismiss"
                @click=${() => {
                  void setPref("missionsDismissed", true);
                  this.open = false;
                }}
              >
                Don't show again
              </button>`}
        </footer>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "learn-missions-panel": LearnMissionsPanel;
  }
}
