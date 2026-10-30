# Brief · A11Y-02 · Dock icon buttons — aria-labels + visible focus

## Files
- `app/studio/components/dock/*.tsx` (or wherever the floating dock lives — grep `backdrop-filter` + `lucide-react` to locate)
- Shared button component if dock uses one

## Brand-system constraints
- Keep glass dock visuals + framer-motion hover bounce.
- Focus ring uses brand accent at full saturation OR a neutral high-contrast white `rgba(255,255,255,0.9)` — must satisfy 3:1 against the glass surface.
- Tooltip remains, but is augmented (not replaced) by the label.

## Problem
The floating dock uses icon-only buttons (lucide icons). Screen readers, voice control, and switch users cannot identify the actions; keyboard users cannot see focus reliably on tinted glass.

## Acceptance criteria
- Every dock button has `aria-label="<verb + object>"` (e.g. `Add scene`, `Play preview`, `Open inspector`).
- Tooltip text and `aria-label` agree word-for-word.
- Focus ring: 2 px solid, `outline-offset: 2px`, ≥3:1 contrast vs both glass surface and worst-case background. Use a `--focus-ring` token; do not hard-code.
- `:focus-visible` (not `:focus`) so mouse users don't see it; keyboard users do.
- Tab order matches visual order left → right.
- All buttons are `<button type="button">`, not `<div onClick>`.

## Verification
- Tab through the dock with keyboard only — ring visible on every stop.
- VoiceOver / NVDA reads each button's verb.
- Axe DevTools shows 0 a11y violations on the dock subtree.
- Visual: dock looks identical for mouse users (no ring without keyboard focus).

## Knowledge refs
- `knowledge/08-accessibility-wcag-2-2.md` → Visible focus indicator + Semantic HTML
- `knowledge/11-dock-and-floating-panel-patterns.md` → Floating dock
