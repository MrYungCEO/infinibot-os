# Brief · RESP-01 · Mobile collapse for canvas/timeline split

## Files
- `app/studio/page.tsx` + layout components
- New `app/studio/components/MobileStoryboardLayout.tsx`

## Brand-system constraints
- Preserve glass + framer-motion; mobile layout uses bottom-sheet pattern for inspector.
- Honor safe-area insets (iOS notch / dynamic island / home indicator).

## Problem
Two-panel canvas/timeline UIs squish unreadably under 768 px. Per `knowledge/14`, single column under 640 px; tabs / disclosure for siblings.

## Acceptance criteria
- ≤640 px: stacked layout — canvas on top (16:9 letterbox), scene list below (horizontal carousel), inspector as bottom-sheet (swipe-up).
- 640–1024 px: tabs to switch between canvas, timeline, inspector.
- ≥1024 px: current 3-panel layout unchanged.
- Touch targets ≥44 pt; primary actions in lower-third thumb-zone.
- Safe-area: bottom-sheet sticks above home indicator; sticky bars use `env(safe-area-inset-*)`.
- No horizontal scroll on the body at any viewport ≤375 px.

## Verification
- Test at 375×812, 414×896, 768×1024, 1024×1366, 1440×900.
- CLS < 0.1 on first load.
- VoiceOver swipe order matches visual order.

## Knowledge refs
- `knowledge/14-responsive-and-mobile-patterns.md` → all
- `knowledge/11-dock-and-floating-panel-patterns.md` → Modal vs sheet vs popover
