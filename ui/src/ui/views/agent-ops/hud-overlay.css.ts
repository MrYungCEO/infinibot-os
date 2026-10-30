/**
 * Shared HUD-overlay stylesheet for the agent world-map DOM overlays
 * (pinboard / active-agents / credit-usage). Bound to the live Galactic theme
 * via the --gx-* CSS custom properties published by `galactic-theme.ts`
 * (see applyGalacticThemeToRoot / installGalacticThemeRootBridge).
 *
 * Exported as a plain string so it can be injected once as a <style> tag — both
 * Lit-`render`-into-DOM overlays (pinboard, active-agents) and shadow-DOM Lit
 * elements (credit-usage, via unsafeCSS) reuse the exact same treatment without
 * copy-pasting CSS three times.
 *
 * Every --gx-* var has a hardcoded fallback matching the default gold theme so
 * the overlays still look right before the root bridge runs its first frame.
 */

export const HUD_OVERLAY_CSS = `
@keyframes gx-scan {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
@keyframes gx-slide-in {
  from { opacity: 0; transform: translateY(-10px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes gx-edge-flash {
  0%   { box-shadow: 0 0 0 0 var(--gx-gold-50, rgba(212,175,55,0.5)); }
  100% { box-shadow: 0 0 0 6px var(--gx-gold-15, rgba(212,175,55,0)); }
}

/* Base panel frame — clear glassmorphic surface: heavy backdrop blur, faint
   gold-tinted glass, hairline border + inner highlight, soft drop shadow. */
.hud-overlay {
  position: relative;
  display: flex;
  flex-direction: column;
  background:
    /* very faint scanline texture so it still reads as HUD, not flat glass */
    repeating-linear-gradient(
      0deg,
      var(--gx-gold-15, rgba(212,175,55,0.03)) 0px,
      var(--gx-gold-15, rgba(212,175,55,0.03)) 1px,
      transparent 1px,
      transparent 5px
    ),
    /* glossy top→bottom wash with gold tint at the top */
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--gx-gold, #d4af37) 10%, rgba(20,16,30,0.42)) 0%,
      color-mix(in srgb, var(--gx-void, #06000f) 70%, transparent) 100%
    );
  border: 1px solid var(--gx-gold-30, rgba(212,175,55,0.32));
  border-radius: 12px;
  box-shadow:
    /* inner top highlight — the "wet glass" gloss line */
    inset 0 1px 0 var(--gx-gold-30, rgba(255,255,255,0.18)),
    /* inner bottom shadow to add depth */
    inset 0 -1px 0 rgba(0,0,0,0.45),
    /* outer drop shadow */
    0 14px 44px rgba(0,0,0,0.55),
    /* soft gold rim glow */
    0 0 0 1px var(--gx-gold-15, rgba(212,175,55,0.10));
  backdrop-filter: blur(18px) saturate(180%);
  -webkit-backdrop-filter: blur(18px) saturate(180%);
  overflow: hidden;
}
/* Soft diagonal sheen so the panel reads as polished glass under a top light. */
.hud-overlay::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(120% 60% at 50% -10%, var(--gx-gold-15, rgba(255,255,255,0.10)), transparent 55%),
    linear-gradient(135deg, var(--gx-gold-15, rgba(255,255,255,0.05)) 0%, transparent 35%);
  z-index: 1;
}

/* HUD corner brackets — gold L-shapes pinned to all four corners. */
.hud-corner {
  position: absolute;
  width: 16px;
  height: 16px;
  pointer-events: none;
  z-index: 3;
}
.hud-corner--tl { top: 3px;    left: 3px;    border-top: 1.5px solid var(--gx-gold-80, rgba(212,175,55,0.85)); border-left: 1.5px solid var(--gx-gold-80, rgba(212,175,55,0.85)); }
.hud-corner--tr { top: 3px;    right: 3px;   border-top: 1.5px solid var(--gx-gold-80, rgba(212,175,55,0.85)); border-right: 1.5px solid var(--gx-gold-80, rgba(212,175,55,0.85)); }
.hud-corner--bl { bottom: 3px; left: 3px;    border-bottom: 1.5px solid var(--gx-gold-80, rgba(212,175,55,0.85)); border-left: 1.5px solid var(--gx-gold-80, rgba(212,175,55,0.85)); }
.hud-corner--br { bottom: 3px; right: 3px;   border-bottom: 1.5px solid var(--gx-gold-80, rgba(212,175,55,0.85)); border-right: 1.5px solid var(--gx-gold-80, rgba(212,175,55,0.85)); }

/* Animated horizontal scanline that sweeps across the panel top. */
.hud-scanline {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  pointer-events: none;
  z-index: 4;
  overflow: hidden;
}
.hud-scanline::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent 0%, var(--gx-gold-30, rgba(212,175,55,0.3)) 50%, transparent 100%);
  animation: gx-scan 3s linear infinite;
}

/* Gold uppercase eyebrow/title with wide tracking. */
.hud-eyebrow {
  color: var(--gx-gold-lt, #e9c46a);
  text-transform: uppercase;
  letter-spacing: 0.4em;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

/* Thin gold gradient rule under a header. */
.hud-rule {
  height: 1px;
  border: 0;
  margin: 0;
  background: linear-gradient(90deg, var(--gx-gold-50, rgba(212,175,55,0.5)), transparent 70%);
}

/* Small status pill. */
.hud-pill {
  color: var(--gx-gold-lt, rgba(233,196,106,0.85));
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 1px 7px;
  border: 1px solid var(--gx-gold-30, rgba(212,175,55,0.35));
  border-radius: 999px;
  background: var(--gx-gold-15, rgba(212,175,55,0.08));
  white-space: nowrap;
}

/* Violet left-bar accent treatment per row. */
.hud-row-accent {
  border-left: 2px solid var(--gx-accent2, #a855f7);
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
}
.hud-row-accent:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px var(--gx-accent2-40, rgba(168,85,247,0.4));
}

/* Footer micro-strip — 2px gold→accent2 gradient line. */
.hud-footer-strip {
  height: 2px;
  flex-shrink: 0;
  background: linear-gradient(90deg, var(--gx-gold, #d4af37), var(--gx-accent2, #a855f7));
  opacity: 0.7;
}

@media (prefers-reduced-motion: reduce) {
  .hud-scanline::before { animation: none; }
  .hud-row-accent:hover { transform: none; }
}
`;
