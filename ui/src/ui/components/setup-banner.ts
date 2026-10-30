/**
 * Slim "needs setup" banner shown at the top of a page whose sidebar entry
 * glows (controllers/nav-setup-status.ts). One shared component for every
 * page: reason + one action button; optional checks add "Later" (snooze a
 * week) and "Dismiss". The banner leaves by itself once the gateway reports
 * the check ready.
 */

import { html, nothing } from "lit";
import { hostForTab, subViewRouteForTab, type Tab } from "../navigation";
import {
  SETUP_SNOOZE_MS,
  setupActionHref,
  setupChecksForPage,
  snoozeSetupCheck,
  type SetupCheck,
} from "../controllers/nav-setup-status.js";
import "../../styles/setup-banner.css";

export type SetupBannerProps = {
  tab: Tab;
  /** Active host sub-view (`?view=`), to hide an action that points right here. */
  view?: string;
  basePath: string;
  onNavigate: (tab: Tab, view?: string) => void;
  requestUpdate?: () => void;
};

function pointsHere(check: SetupCheck, props: SetupBannerProps): boolean {
  const a = check.action;
  if (!a || a.href || !a.tab) return false;
  if (hostForTab(a.tab as Tab) !== hostForTab(props.tab)) return false;
  // Same host: "here" unless the action names a different sub-view (either
  // explicitly or through a retired id like "coders" → setup?view=coders).
  const view = a.view ?? subViewRouteForTab(a.tab as Tab)?.view;
  return !view || view === props.view;
}

function renderOne(check: SetupCheck, props: SetupBannerProps) {
  const lead = check.state === "error" ? "Setup problem" : check.state === "optional" ? "Optional" : "Needs setup";
  const action = check.action && !pointsHere(check, props) ? check.action : undefined;
  return html`
    <div
      class="setup-banner setup-banner--${check.state}"
      role=${check.state === "error" ? "alert" : "status"}
      data-setup-check=${check.id}
    >
      <span class="setup-banner__dot" aria-hidden="true"></span>
      <span class="setup-banner__text">
        <span class="setup-banner__lead">${lead}</span>
        <span class="setup-banner__title">${check.title}</span>
        <span class="setup-banner__reason">${check.reason}</span>
      </span>
      <span class="setup-banner__actions">
        ${action
          ? html`<a
              class="setup-banner__btn"
              href=${setupActionHref(action, props.basePath)}
              target=${action.href ? "_blank" : nothing}
              rel=${action.href ? "noopener" : nothing}
              @click=${(e: MouseEvent) => {
                if (action.href || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                if (action.section && typeof window !== "undefined") {
                  // Setup opens the named section (views/setup.ts listens).
                  window.dispatchEvent(new CustomEvent("infinibot:setup-section", { detail: { section: action.section } }));
                }
                props.onNavigate((action.tab ?? "setup") as Tab, action.view);
              }}
              >${action.label}</a
            >`
          : nothing}
        ${check.state === "optional"
          ? html`<button
                type="button"
                class="setup-banner__ghost"
                title="Hide for a week"
                @click=${() => {
                  snoozeSetupCheck(check.id, SETUP_SNOOZE_MS);
                  props.requestUpdate?.();
                }}
              >
                Later
              </button>
              <button
                type="button"
                class="setup-banner__close"
                title="Dismiss"
                aria-label=${`Dismiss: ${check.title}`}
                @click=${() => {
                  snoozeSetupCheck(check.id);
                  props.requestUpdate?.();
                }}
              >
                ×
              </button>`
          : nothing}
      </span>
    </div>
  `;
}

/**
 * Full-bleed canvases (chat, grid, mesh, terminals, graph) own every pixel of
 * <main>; their sidebar glow + hover hint carry the message instead.
 */
const NO_BANNER_TABS: ReadonlySet<string> = new Set([
  "chat",
  "webchat",
  "grid",
  "mesh",
  "terminals",
  "knowledge-graph",
  "autonomy",
]);

/** Banners for the current page (at most 2; the rest stay in the sidebar hint). */
export function renderSetupBanner(props: SetupBannerProps) {
  if (NO_BANNER_TABS.has(props.tab)) return nothing;
  const checks = setupChecksForPage(props.tab).slice(0, 2);
  if (checks.length === 0) return nothing;
  return html`<div class="setup-banners">${checks.map((c) => renderOne(c, props))}</div>`;
}
