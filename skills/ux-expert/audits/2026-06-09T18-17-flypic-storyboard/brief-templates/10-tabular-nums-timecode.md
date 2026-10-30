# Brief · TYPE-01 · Tabular numerics on timeline timecodes

## Files
- `app/studio/components/timeline/**`
- Any KPI tiles / duration displays

## Brand-system constraints
- Keep current font stack.
- Apply only to numeric runs, not labels.

## Problem
Timecode displays (`00:03 / 00:12`) shift width as digits change because the font uses proportional figures. Per `knowledge/02`.

## Acceptance criteria
- Every numeric run inside timeline + duration displays has `font-variant-numeric: tabular-nums` applied (CSS class or utility).
- No layout shift while the playhead advances.

## Verification
- Play a video preview — counter no longer wobbles.
- Computed style on timecode span includes `font-variant-numeric: tabular-nums`.

## Knowledge refs
- `knowledge/02-typography-systems.md` → Tabular numerics
