# Brief · STATE-02 · First-run storyboard empty state → guided onboarding

## Files
- `app/studio/components/storyboard/EmptyState.tsx` (create if missing)
- `app/studio/page.tsx` — branch on `scenes.length === 0`

## Brand-system constraints
- Glass surface, lucide icons, brand-accent primary CTA.
- Illustration: use an existing FlyPic-style asset; if none, ship a clean SVG using brand tokens only.

## Problem
First-run users land on an empty storyboard and see "No scenes" — high abandonment. Per `knowledge/09`, empty = onboarding.

## Acceptance criteria
- Empty state contains:
  1. Illustration / icon (≤120px tall).
  2. One headline (≤8 words, value-first: "Turn a script into a launch video").
  3. One subheading (≤16 words, the how).
  4. Primary CTA: `Generate first scene` (brand accent).
  5. Secondary: `Start from template` (ghost) opens a templates picker.
  6. Tertiary: `Watch 60s tour` text link.
- After first scene is created, empty state is replaced — never re-shown unless the user manually clears all scenes.
- `aria-live="polite"` announces empty state on first render.

## Verification
- Fresh user account → land on `/app/studio` → see new empty state.
- Click "Generate first scene" → flows into the existing generate-scene path with the empty-state intent prefilled (if intent capture exists).
- Mobile (375×812): single column, primary CTA in lower thumb-zone.

## Knowledge refs
- `knowledge/09-empty-error-loading-states.md` → First-run empty state = onboarding
- `knowledge/07-conversion-patterns.md` → Verb-first CTA microcopy
- `knowledge/14-responsive-and-mobile-patterns.md` → Thumb-zone primary actions
