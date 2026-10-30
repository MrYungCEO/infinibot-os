/**
 * Clip transitions — the abstraction for "wipe / dissolve / glitch
 * between two consecutive clips on the same track".
 *
 * Persisted on `comp.meta.transitions` as a sparse array — one entry
 * per transition the operator/agent has placed. Each entry references
 * its outgoing + incoming clip ids, so re-ordering clips on the
 * timeline doesn't invalidate the transitions (we resolve at render
 * time, not by index).
 *
 * The translator consumes this list and emits a pair of GSAP
 * animations: the outgoing clip's exit is overridden to the
 * transition's "out" effect, and the incoming clip's entrance is
 * overridden to the matching "in". Both share the same duration and
 * are positioned around the cut so the visual handover is symmetric.
 *
 * Phase 3 implementation: CSS-only effects (opacity, clip-path,
 * transform, filter) that work in both inline preview AND export. The
 * data model is forward-compatible with a future WebGL/shader-driven
 * implementation — same Transition shape, different rendering path.
 */

export type TransitionKind =
  | "crossDissolve"
  | "wipeLeft"
  | "wipeRight"
  | "wipeUp"
  | "wipeDown"
  | "zoomBlur"
  | "glitch"
  | "slideLeft"
  | "slideRight"
  | "fadeBlack"
  | "fadeWhite";

export interface ClipTransition {
  /** Stable id so re-saves replace instead of duplicate. */
  id: string;
  /** Outgoing clip id (must overlap with `toClipId` in time). */
  fromClipId: string;
  /** Incoming clip id. */
  toClipId: string;
  /** Transition style. */
  kind: TransitionKind;
  /** Effect duration in seconds — typically 0.3–1.5. */
  durationSec: number;
  /**
   * Optional easing override. Defaults are tuned per-kind so the
   * agent rarely needs to set this manually.
   */
  ease?: string;
}

/** Curated default duration per transition kind (seconds). */
export const TRANSITION_DEFAULT_DURATIONS: Record<TransitionKind, number> = {
  crossDissolve: 0.4,
  wipeLeft: 0.6,
  wipeRight: 0.6,
  wipeUp: 0.6,
  wipeDown: 0.6,
  zoomBlur: 0.5,
  glitch: 0.35,
  slideLeft: 0.5,
  slideRight: 0.5,
  fadeBlack: 0.6,
  fadeWhite: 0.6,
};

/** Operator-facing labels for the picker UI. */
export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  crossDissolve: "Cross Dissolve",
  wipeLeft: "Wipe Left",
  wipeRight: "Wipe Right",
  wipeUp: "Wipe Up",
  wipeDown: "Wipe Down",
  zoomBlur: "Zoom Blur",
  glitch: "Glitch",
  slideLeft: "Slide Left",
  slideRight: "Slide Right",
  fadeBlack: "Fade to Black",
  fadeWhite: "Fade to White",
};

/**
 * Validate + read transitions off comp.meta. Drops malformed entries
 * silently — the RPC handler enforces shape on write, so any garbage
 * here is the agent's fault and we'd rather render correctly than fail
 * the whole composition.
 */
export function readTransitions(meta: Record<string, unknown> | undefined): ClipTransition[] {
  const raw = meta?.transitions;
  if (!Array.isArray(raw)) return [];
  const out: ClipTransition[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.fromClipId !== "string" || typeof e.toClipId !== "string") continue;
    if (typeof e.kind !== "string" || !(e.kind in TRANSITION_DEFAULT_DURATIONS)) continue;
    out.push({
      id: typeof e.id === "string" ? e.id : `tr-${e.fromClipId}-${e.toClipId}`,
      fromClipId: e.fromClipId,
      toClipId: e.toClipId,
      kind: e.kind as TransitionKind,
      durationSec:
        typeof e.durationSec === "number" && e.durationSec > 0
          ? e.durationSec
          : TRANSITION_DEFAULT_DURATIONS[e.kind as TransitionKind],
      ease: typeof e.ease === "string" ? e.ease : undefined,
    });
  }
  return out;
}
