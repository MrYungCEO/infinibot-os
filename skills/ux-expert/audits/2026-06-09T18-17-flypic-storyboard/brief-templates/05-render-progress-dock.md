# Brief · STATE-01 · Render progress: determinate bar + persistent status drawer

## Files
- `app/studio/components/render/**`
- New `app/studio/components/status-drawer/StatusDrawer.tsx`

## Brand-system constraints
- Glass surface + lucide icons.
- framer-motion entrance from bottom-right; honor reduced-motion (consume `useMotionPrefs`).

## Problem
Rendering a video takes seconds to minutes. A spinner alone leaves users guessing. Per `knowledge/15`, multi-minute work needs a persistent status surface, not just a transient toast.

## Acceptance criteria
- Per-scene determinate progress bar when render API exposes %; indeterminate + descriptive text ("Rendering scene 2 of 5…") otherwise.
- Persistent status drawer pinned bottom-right with: job title, % bar, ETA when known, cancel button.
- Drawer survives navigation within `/app/studio/**`.
- On success: drawer collapses to a "✓ Render complete · Open" pill for 30s, then disappears.
- On failure: drawer turns danger-tinted with WHAT/WHY/HOW per knowledge/09 + retry button.
- aria-live="polite" on the drawer container; `role="status"` on the progress region.

## Verification
- Kick a 60s render — drawer appears within 300ms.
- Navigate to a sibling page → drawer persists.
- Force a failure (kill render server) → drawer shows recovery path.
- Screen reader announces start, completion, failure.

## Knowledge refs
- `knowledge/09-empty-error-loading-states.md` → Loading + error states
- `knowledge/15-feedback-and-status-systems.md` → Persistent status surfaces; Progress for long tasks
