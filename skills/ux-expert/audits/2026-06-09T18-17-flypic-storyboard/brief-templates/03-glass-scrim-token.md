# Brief · A11Y-03 · Glass scrim token — guarantee 4.5:1 over worst-case media

## Files
- `styles/tokens.css` or `tailwind.config.{ts,js}` — add tokens
- `app/studio/components/**` — all components using `backdrop-filter`

## Brand-system constraints
- Keep the glass-morphism aesthetic — this is FlyPic's identity.
- Do NOT remove `backdrop-filter`; ADD a scrim underneath.
- Provide a fallback for browsers without backdrop-filter (Firefox older versions).

## Problem
Glass panels (toolbar, inspector, dock) sit over video preview frames. When the underlying video shows a bright scene (sky, beach, white logo), body-text contrast drops below WCAG 4.5:1. The pattern needs a scrim token so text contrast is guaranteed regardless of background.

## Acceptance criteria
- New tokens added:
  - `--glass-surface: rgba(15, 15, 17, 0.65)`
  - `--glass-border: rgba(255, 255, 255, 0.08)`
  - `--glass-scrim: linear-gradient(180deg, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.45) 100%)`
- Every glass panel renders a scrim pseudo-element (`::before`) BEHIND the content, ABOVE the backdrop.
- Inner stroke: `box-shadow: inset 0 1px 0 var(--glass-border)`.
- Fallback: `@supports not (backdrop-filter: blur(1px)) { background: rgb(15,15,17,0.92); }`.
- Honor `@media (prefers-reduced-transparency: reduce)` → swap to opaque surface.
- Worst-case automated check: capture a glass panel composited over a pure-white background frame; programmatic contrast check on body text ≥ 4.5:1.

## Verification
- Switch the video preview to a bright frame (or temp white poster) — body text still legible.
- Lighthouse a11y score on `/app/studio` stays ≥95.
- Reduced-transparency emulation in DevTools → glass becomes opaque, layout intact.

## Knowledge refs
- `knowledge/03-color-and-contrast.md` → WCAG 2.2 minimums
- `knowledge/08-accessibility-wcag-2-2.md` → SC 1.4.3 / 1.4.11
- `knowledge/11-dock-and-floating-panel-patterns.md` → Glass-morphism done responsibly
- `knowledge/16-brand-system-application.md` → Glass + brand = define a SCRIM
