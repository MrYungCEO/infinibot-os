# Brief · FEEDBACK-01 · Persistent error surface for render failures

## Files
- `app/studio/components/render/**`
- Shared `components/error/` primitives

## Brand-system constraints
- Danger token (e.g. `--color-danger`) used for accent only.
- Glass surface allowed but ensure 4.5:1 over worst-case media (see A11Y-03).

## Problem
Per `knowledge/15`, toasts are for non-blocking ack; fatal errors must persist. Render failures currently rely on a toast that disappears in seconds, leaving users uncertain.

## Acceptance criteria
- On render failure, the Status Drawer (see STATE-01) flips into an error state with:
  - WHAT: "Couldn't render video"
  - WHY: short, plain English ("The render server is unreachable.")
  - HOW: `Retry` (primary), `Save draft` (secondary), `Contact support` (link).
  - Correlation ID shown small, copy-on-click.
- A toast is still shown briefly to grab attention, but the persistent drawer remains until the user acts.
- Logs send full stack to telemetry; never surface it.

## Verification
- Force a 500 from the render API → drawer shows the recovery surface; toast appears + disappears; drawer remains.
- Click "Retry" → re-runs the request; on success the drawer transitions to success state.
- Screen reader announces error via `aria-live="assertive"` on the drawer.

## Knowledge refs
- `knowledge/09-empty-error-loading-states.md` → WHAT/WHY/HOW
- `knowledge/15-feedback-and-status-systems.md` → Toast for non-blocking; not for fatal
