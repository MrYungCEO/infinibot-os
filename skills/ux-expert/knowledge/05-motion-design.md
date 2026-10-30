# 05 · Motion Design

## Pattern: Duration by distance + role
- **When**: Defining transition tokens.
- **How**:
  - Micro (hover, ripple, focus): 80–120 ms
  - Small UI (toggle, accordion): 150–200 ms
  - Container (modal, sheet, page): 250–400 ms
  - Large hero / full-screen: 400–500 ms (cap here)
- **Source**: Material 3 motion duration tokens.
- **Anti-patterns**: 500 ms hover state; 100 ms full-page transition.

## Pattern: Easing by direction
- **When**: Choosing curves.
- **How**:
  - Entering screen → `cubic-bezier(0, 0, 0.2, 1)` (decelerate).
  - Leaving screen → `cubic-bezier(0.4, 0, 1, 1)` (accelerate).
  - Persistent in-place → `cubic-bezier(0.4, 0, 0.2, 1)` (standard).
  - Springy delight → framer-motion `spring` w/ stiffness 300, damping 30.
- **Source**: Material 3 easing; Apple HIG.
- **Anti-patterns**: Linear for everything; bouncing on serious surfaces (banking, healthcare).

## Pattern: Choreography — stagger related items
- **When**: Lists, grids, dashboards animating in.
- **How**: Stagger children by 30–60 ms; never animate >12 items at once (cap or batch).
- **Source**: Material motion guidelines; framer-motion `staggerChildren`.

## Pattern: Respect prefers-reduced-motion
- **When**: ALWAYS.
- **How**:
  - `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }`
  - In React: `useReducedMotion()` from framer-motion → swap animations for instant state changes.
  - Keep critical feedback (focus, error shake replacement = color flash) but kill decorative parallax / autoplay.
- **Source**: WCAG 2.3.3 "Animation from Interactions"; framer-motion docs.
- **Anti-patterns**: Parallax that ignores reduced-motion; auto-playing video.

## Pattern: Motion as functional feedback
- **When**: Optimistic UI, drag, async actions.
- **How**: Movement should explain causation — the modal grows from the button that opened it; the saved item slides into its list position. Decoration without meaning = noise.
- **Source**: Material motion principles.

## Pattern: 60 fps budget
- **When**: Any animation.
- **How**: Animate only `transform` + `opacity`. `top/left/width/height` cause layout thrash. Use `will-change` sparingly; remove after animation.
- **Source**: web.dev "rendering performance".

## Anti-pattern checklist
- Spinner replacing a button for >3 s without secondary status text.
- Auto-rotating carousels without pause control (WCAG 2.2.2).
- Decorative motion that re-triggers on every scroll.
- Page transitions ≥500 ms (feels broken).
