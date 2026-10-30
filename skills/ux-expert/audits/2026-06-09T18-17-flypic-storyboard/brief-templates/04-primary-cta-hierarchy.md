# Brief · CTA-01 · One primary CTA wins per surface

## Files
- `app/studio/**/*.tsx` — header bar, dock, inspector footer

## Brand-system constraints
- Preserve brand accent (current saturated color).
- All other buttons demote to `outline` or `ghost` variants — keep same height/radius.

## Problem
Multiple buttons currently use the brand accent (Generate scene, Render video, Save). The eye doesn't know what to do. Per `knowledge/01` and `knowledge/07`, one element should win per view.

## Acceptance criteria
- Per surface (storyboard canvas, render dialog, inspector), exactly ONE button uses `variant="primary"` (brand accent fill).
- Secondary buttons use `variant="secondary"` (outline) or `variant="ghost"` (text only).
- The primary CTA is the action the user is most likely to take next given current state (e.g. "Render video" when ≥1 scene exists; "Generate first scene" on empty state).
- A `<PrimaryActionContext>` (or equivalent prop drilling — pick what fits the codebase) declares the current primary so child components can demote themselves.

## Verification
- Screenshot each major surface at 1440×900: only one brand-accent button visible per frame.
- A11y: primary button still meets contrast.
- No regressions in click-through on existing analytics events (rename only when needed).

## Knowledge refs
- `knowledge/01-visual-hierarchy.md` → One dominant focal point
- `knowledge/07-conversion-patterns.md` → One primary CTA per screen
