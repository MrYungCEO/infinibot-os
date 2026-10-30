# Brief · BRAND-01 · Unify icon family to lucide-only

## Files
- All `app/studio/**` and any shared component lib

## Brand-system constraints
- lucide-react is the declared family.
- Stroke width: 1.5 px across all sizes.
- Use filled vs outline only to indicate STATE (active vs idle), not preference.

## Problem
Mixed icon sources (lucide + emoji + custom SVG + occasional heroicon) erode brand. Per `knowledge/16`, one family per product.

## Acceptance criteria
- Grep `app/studio/**` for non-lucide imports (`@heroicons`, custom svg, emoji `📹 🎬 ▶️` in JSX text content meant as icons) → zero.
- Where lucide lacks an icon, add a custom SVG in `components/icons/` matching: 24×24 viewbox, 1.5 stroke, `currentColor`.
- Document any custom icons in `components/icons/README.md`.
- Optional: introduce `<Icon name="play" />` wrapper for consistent sizing.

## Verification
- Visual sweep: every icon in the storyboard surface shares stroke weight + radius vocabulary.
- No emoji rendered as iconography in chrome (still OK in user-generated content).
- Bundle size delta ≤ +2 KB compressed.

## Knowledge refs
- `knowledge/16-brand-system-application.md` → One icon family per product
