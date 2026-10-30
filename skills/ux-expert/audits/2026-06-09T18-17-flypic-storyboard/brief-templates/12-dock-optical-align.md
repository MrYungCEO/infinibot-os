# Brief · POLISH-01 · Dock icon optical alignment pass

## Files
- `app/studio/components/dock/**`

## Brand-system constraints
- lucide-react icons, 1.5 px stroke, 20–24 px rendered.

## Problem
Lucide icons share a 24-viewbox but optical centers vary (`play` reads right-heavy; `square` reads centered). Per `knowledge/01` → optical alignment beats pixel alignment.

## Acceptance criteria
- For each dock icon, override CSS `transform: translate(...)` by 1–2 px where needed to visually center.
- Document offsets in a small icon-table file so future icons get the same treatment.

## Verification
- Visual sweep — every dock icon reads centered to the eye, not the bounding box.
- No regression at 2x DPI screenshots.

## Knowledge refs
- `knowledge/01-visual-hierarchy.md` → Optical alignment
