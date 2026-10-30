# 14 · Responsive & Mobile Patterns

## Pattern: Mobile-first breakpoints
- **When**: Building any responsive layout.
- **How**:
  - Default styles target ≤375 px.
  - Breakpoints: 640 (sm) / 768 (md) / 1024 (lg) / 1280 (xl) / 1536 (2xl).
  - Avoid `max-width` queries; layer mobile → desktop with `min-width`.
- **Source**: Tailwind; CSS Tricks responsive.

## Pattern: Touch target ≥44 pt with comfortable spacing
- **When**: Mobile / tablet.
- **How**:
  - Buttons + tappable rows: 44×44 pt minimum, 48 dp Android.
  - Adjacent targets separated by ≥8 px gap.
  - Avoid stacking 3+ small links inline within paragraphs.
- **Source**: Apple HIG; Material 3.

## Pattern: Thumb-zone primary actions
- **When**: Mobile actions, especially commerce.
- **How**: Place primary actions in the lower 1/3 of the screen (right-thumb dominant for ~88% of users). Top-bar for nav / context only.
- **Source**: Steven Hoober mobile ergonomics research.

## Pattern: Safe-area + dynamic island insets
- **When**: iOS / mobile web.
- **How**: Use `env(safe-area-inset-*)` for sticky bars; test with dynamic island, home indicator, and keyboard insets.
- **Source**: Apple HIG; web.dev viewport.

## Pattern: One column ≤640 px
- **When**: Mobile layouts.
- **How**: Stack everything single-column under 640 px. Horizontal scroll only for media galleries / cards (with visible chevrons or fade-edge).
- **Source**: NN/g mobile UX 2023.

## Pattern: Disclosure over tabs on small screens
- **When**: Tabs would have ≤120 px each.
- **How**: Convert tabs into a vertical accordion or segmented selector below ~640 px.
- **Source**: Material 3 adaptive tabs.

## Pattern: Hover is unreliable
- **When**: Designing tooltips, dropdowns.
- **How**: Every hover-revealed action must have a click/tap path. Use `@media (hover: hover)` to gate hover-only enhancements.
- **Source**: CSS Media Queries Level 4.

## Pattern: Performance budget = UX budget
- **When**: Mobile / 3G testing.
- **How**:
  - LCP < 2.5 s, INP < 200 ms, CLS < 0.1.
  - First load JS < 170 KB compressed.
  - Image: AVIF/WebP, lazy-load below-fold, fixed `width/height` to prevent CLS.
- **Source**: Core Web Vitals; web.dev.

## Anti-pattern checklist
- Fixed 1200 px container on mobile → horizontal scroll.
- Tap targets <32 px on mobile.
- CLS from fonts/images > 0.1.
- Sticky bottom nav covering form CTA — overlap with no scroll padding.
- Hover-only mega-menus on touch.
