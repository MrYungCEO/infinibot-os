// Route-aware popup suppression for the control UI.
//
// Login / auth surfaces must be CLEAN: while the user is on the gateway auth
// screen, the sovereign onboarding flow, or the password-free profile gate,
// NO other overlay may appear — no proactive popup/toast/modal, no upgrade
// nag, no "welcome back", no federation invite, no vault-onboarding wizard.
//
// The auth screen, onboarding flow and profile gate are themselves full-page
// views (renderApp returns them early), so they are never matched here and
// stay visible — we only hide OTHER overlays while they are showing.
//
// Two enforcement layers, kept in one place:
//   1. A `data-auth-route` flag on <body>, set every render from app state,
//      plus a stylesheet that hides overlay elements when the flag is "1".
//      This catches imperatively body-appended modals (openUpgradeModal,
//      agent-focus-modal, …) that live outside the Lit render tree.
//   2. isAuthRouteNow(), a synchronous read of that flag, so imperative
//      openers can early-return and skip the side effect entirely.

import { isGateEnabled, isGatePassed } from "../profiles";

/** Minimal structural slice of AppViewState needed to classify the route. */
export interface AuthRouteState {
  onboarding?: boolean;
  connected?: boolean;
}

/**
 * True when the UI is showing an auth/login surface and all OTHER popups
 * must be suppressed.
 *   - onboarding flow active
 *   - not connected to the gateway (auth screen)
 *   - profile gate enabled but not yet passed this session
 */
export function computeIsAuthRoute(state: AuthRouteState): boolean {
  if (state.onboarding) return true;
  if (!state.connected) return true;
  if (isGateEnabled() && !isGatePassed()) return true;
  return false;
}

const STYLE_ID = "auth-route-popup-guard";

function ensureGuardStyle(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Hide every overlay element while on an auth surface. The auth/onboarding/
  // gate views are full-page renders, not listed here, so they remain visible.
  style.textContent = `
body[data-auth-route="1"] upgrade-modal,
body[data-auth-route="1"] plan-limit-modal,
body[data-auth-route="1"] agent-focus-modal,
body[data-auth-route="1"] proactive-popups,
body[data-auth-route="1"] proactive-panel,
body[data-auth-route="1"] proactive-toast,
body[data-auth-route="1"] proactive-modal,
body[data-auth-route="1"] vault-onboarding,
body[data-auth-route="1"] branding-modal,
body[data-auth-route="1"] .proactive-popup,
body[data-auth-route="1"] .nudge-toast,
body[data-auth-route="1"] .upgrade-nag,
body[data-auth-route="1"] .welcome-back-modal,
body[data-auth-route="1"] .federation-invite {
  display: none !important;
}
`;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Reflect the current auth-route state onto <body data-auth-route> and make
 * sure the suppression stylesheet is installed. Call once per render.
 * Returns the computed flag for callers that want it inline.
 */
export function syncAuthRouteFlag(state: AuthRouteState): boolean {
  if (typeof document === "undefined") return false;
  ensureGuardStyle();
  const on = computeIsAuthRoute(state);
  if (document.body) document.body.dataset.authRoute = on ? "1" : "0";
  return on;
}

/** Synchronous read of the body flag — for imperative popup openers. */
export function isAuthRouteNow(): boolean {
  if (typeof document === "undefined") return false;
  return document.body?.dataset?.authRoute === "1";
}
