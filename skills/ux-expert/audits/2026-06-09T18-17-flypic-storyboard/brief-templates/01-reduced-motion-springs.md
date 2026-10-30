# Brief · A11Y-01 · Honor `prefers-reduced-motion` across framer-motion choreography

## Files (start here, expand as needed)
- `app/studio/**/*.tsx` — any component importing from `framer-motion`
- `lib/motion/**` — shared motion presets (create if missing)

## Brand-system constraints
- Preserve the dark glass-morphism + lucide vocabulary; do NOT touch colors / surfaces.
- Keep existing motion vocabulary (springy enter, gentle exit) for users who do NOT prefer reduced motion.
- Use framer-motion idioms; do not introduce a competing library.

## Problem
Storyboard surfaces use framer-motion `animate` and `spring` choreography (staggered scene cards, dock pill bounce, modal pops). framer-motion does not auto-honor `prefers-reduced-motion` — animations still play for users with reduced-motion preference set at the OS level. WCAG 2.3.3 + SC 2.2.2 require reduced-motion compliance, and Apple/Material both mandate it.

## Acceptance criteria
- A shared `useMotionPrefs()` hook (or expand existing) wraps `useReducedMotion()` from framer-motion.
- All `motion.*` components in `app/studio/**` consume motion props from a preset map: `{ enter, exit, hover, stagger }`.
- When `useReducedMotion()` returns true:
  - `transition.duration` → ≤ 0.01s OR `animate` instant.
  - `staggerChildren` disabled.
  - Decorative loops (parallax, autoplay) stop.
  - CRITICAL feedback (focus, error color flash, save toast) still appears, just without springy motion.
- No new dependencies. No raw `transition={{ duration: ... }}` left in `app/studio/**` — all go through the preset.

## Verification
- macOS: System Settings → Accessibility → Display → "Reduce motion" ON. Reload `/app/studio`. Scenes appear without stagger; dock pill no longer bounces; modals fade instead of springing.
- DevTools → Rendering → "Emulate CSS media feature prefers-reduced-motion: reduce" → same result.
- Run `npm test` (if motion test exists, extend; else add a small test that asserts `useReducedMotion` is consumed in at least one `motion.*` usage).
- Screenshot diff at 1440×900 default state: visually identical when reduced-motion is OFF.

## Knowledge refs
- `knowledge/05-motion-design.md` → "Respect prefers-reduced-motion"
- `knowledge/08-accessibility-wcag-2-2.md` → SC 2.3.3
