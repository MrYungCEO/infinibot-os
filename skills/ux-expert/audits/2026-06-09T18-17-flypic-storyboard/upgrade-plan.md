# Upgrade Plan · FlyPic Storyboard

## Prioritization matrix (impact × effort)

| Rank | ID | Title | Impact | Effort | Brief |
|---|---|---|---|---|---|
| 1 | A11Y-01 | Wire `useReducedMotion()` across all framer-motion springs | accessibility | S | `01-reduced-motion-springs.md` |
| 2 | A11Y-02 | Add `aria-label` + visible focus to all dock icon buttons | accessibility | S | `02-dock-aria-and-focus.md` |
| 3 | A11Y-03 | Force WCAG 4.5:1 on glass panels via scrim token | a11y + brand | M | `03-glass-scrim-token.md` |
| 4 | CTA-01 | Demote secondary CTAs so one primary wins | conversion | S | `04-primary-cta-hierarchy.md` |
| 5 | STATE-01 | Determinate render progress + persistent status drawer | clarity + conversion | M | `05-render-progress-dock.md` |
| 6 | STATE-02 | First-run storyboard empty state → guided onboarding | conversion | M | `06-empty-state-onboarding.md` |
| 7 | COPY-01 | Verb-first CTA microcopy pass on all dialogs | clarity | S | `07-cta-microcopy-pass.md` |
| 8 | BRAND-01 | Audit + unify lucide-only icon family | brand-fit | S | `08-icon-family-unify.md` |
| 9 | FEEDBACK-01 | Persistent error surface for render failures | clarity | M | `09-render-error-surface.md` |
| 10 | TYPE-01 | Apply `tabular-nums` to all timeline timecodes | typography | S | `10-tabular-nums-timecode.md` |
| 11 | RESP-01 | Mobile collapse for canvas/timeline split | responsive | L | `11-mobile-storyboard-layout.md` |
| 12 | POLISH-01 | Optical alignment pass on dock icons | hierarchy | S | `12-dock-optical-align.md` |

## Sprint plan (recommended)
- **This week (S effort, ship first)**: A11Y-01, A11Y-02, CTA-01, COPY-01, BRAND-01, TYPE-01, POLISH-01 → 7 tickets, all small.
- **This sprint (M effort)**: A11Y-03, STATE-01, STATE-02, FEEDBACK-01 → 4 tickets.
- **Next sprint (L effort)**: RESP-01 → mobile layout overhaul.

## Confirmation gate
Per skill constraints, NO dispatch happens until the user replies with the IDs to ship. Expected confirmation:
> "Ship A11Y-01, A11Y-02, CTA-01"

On approval, dispatch each brief template as the `task` field to `mcp__infinibot__claude_coder`, tagged `ux-audit:2026-06-09T18-17-flypic-storyboard:<ID>`.
