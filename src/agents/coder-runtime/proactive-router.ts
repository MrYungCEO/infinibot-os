/**
 * Proactive Pop-Up System — routing rules (cooldown + tier downgrade + overrides).
 *
 * One place owns the decision of *which tier actually applies* when an agent
 * calls proactive.emit. The gateway handler does the IO (count prior emits,
 * read settings); this module is the deterministic policy.
 *
 * Rules (from the plan note §2 + §5):
 *   1. Cooldown / dedup. Repeat of the same dedupKey inside its window downgrades
 *      one tier. A second repeat inside the (downgraded) window downgrades again,
 *      i.e. it gets silently absorbed into the panel.
 *   2. Quiet hours. CRITICAL still pops; NOTABLE downgrades to FYI (panel-only);
 *      FYI/AMBIENT unchanged.
 *   3. Focus mode (Hyperfocus). Only CRITICAL pops; NOTABLE/FYI stay in the panel.
 */

import { TIER_ORDER, type PopupTier } from "../../proactive/popup-types.js";
import type { ProactivePopupSettings } from "../../proactive/popup-settings.js";
import { isWithinQuietHours } from "../../proactive/popup-settings.js";

/** Cooldown windows per requested tier. AMBIENT has no cooldown effect. */
export const COOLDOWN_MS: Record<PopupTier, number> = {
  CRITICAL: 15 * 60 * 1000,
  NOTABLE: 30 * 60 * 1000,
  FYI: 4 * 60 * 60 * 1000,
  AMBIENT: 0,
};

export interface RouteContext {
  /** Number of prior emits with the same dedupKey inside the requested tier's window. */
  priorInWindow: number;
  settings: ProactivePopupSettings;
  now?: Date;
}

export interface RouteDecision {
  requestedTier: PopupTier;
  appliedTier: PopupTier;
  /** True when the applied tier is below the requested tier. */
  downgraded: boolean;
  /** Human-readable explanation (one line per rule that fired). */
  reasons: string[];
}

/** Step a tier down by `steps`, clamped at AMBIENT (the panel-collapsed floor). */
export function downgradeTier(tier: PopupTier, steps: number): PopupTier {
  if (steps <= 0) return tier;
  const idx = TIER_ORDER.indexOf(tier);
  const next = Math.min(TIER_ORDER.length - 1, idx + steps);
  return TIER_ORDER[next];
}

function rank(tier: PopupTier): number {
  return TIER_ORDER.indexOf(tier);
}

/** Apply the quiet-hours / focus-mode caps to a tier. Never touches CRITICAL. */
function applyOverrides(
  tier: PopupTier,
  settings: ProactivePopupSettings,
  now: Date,
  reasons: string[],
): PopupTier {
  let out = tier;
  if (out === "CRITICAL") return out; // CRITICAL always pops.

  if (settings.focusMode.enabled) {
    // Hyperfocus: anything non-CRITICAL falls to the panel.
    if (rank(out) < rank("FYI")) {
      out = "FYI";
      reasons.push("focus-mode: non-critical held in panel (FYI)");
    }
  }
  if (isWithinQuietHours(settings.quietHours, now)) {
    // Quiet hours: NOTABLE → FYI; FYI/AMBIENT already silent.
    if (out === "NOTABLE") {
      out = "FYI";
      reasons.push("quiet-hours: NOTABLE downgraded to FYI");
    }
  }
  return out;
}

export function routeEmit(requestedTier: PopupTier, ctx: RouteContext): RouteDecision {
  const now = ctx.now ?? new Date();
  const reasons: string[] = [];

  // 1. Cooldown downgrade — one step per prior emit inside the window.
  let applied = requestedTier;
  if (ctx.priorInWindow > 0 && COOLDOWN_MS[requestedTier] > 0) {
    applied = downgradeTier(requestedTier, ctx.priorInWindow);
    reasons.push(
      `cooldown: ${ctx.priorInWindow} prior emit(s) in window → ${requestedTier} downgraded to ${applied}`,
    );
  }

  // 2 + 3. Quiet hours + focus-mode caps.
  applied = applyOverrides(applied, ctx.settings, now, reasons);

  return {
    requestedTier,
    appliedTier: applied,
    downgraded: rank(applied) > rank(requestedTier),
    reasons,
  };
}
