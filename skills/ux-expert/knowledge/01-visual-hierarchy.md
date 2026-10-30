# 01 · Visual Hierarchy

## Pattern: One dominant focal point per view
- **When**: Any screen with a primary user goal (CTA, status, key data).
- **How**:
  - Choose ONE element to win by size, weight, color saturation, or isolation.
  - Make the next-most-important element ~60% the visual weight of the winner.
  - Push everything else to ≤40% — neutral text, ghost buttons, muted icons.
  - Use whitespace as the cheapest hierarchy lever before reaching for color.
- **Source**: Refactoring UI ch.2 (Schoger/Wathan); NN/g "Visual Hierarchy".
- **Anti-patterns**: Two equal-weight primary buttons; gradient backgrounds that out-compete the CTA; using bold on >25% of text.

## Pattern: Scanning paths (F, Z, layer-cake)
- **When**: Content-heavy pages (docs, dashboards, marketing) and lists.
- **How**:
  - Long-form text → expect F-pattern; front-load the first 2 words of every paragraph + heading.
  - Sparse landing → Z-pattern; place CTA at the bottom-right terminus of the Z.
  - Dashboards / settings → layer-cake (rows); align labels left, values right, group via `<section>` with H2.
- **Source**: NN/g eyetracking studies 2006–2020.
- **Anti-patterns**: Centered body copy >70ch; CTAs scattered along left edge.

## Pattern: Contrast as hierarchy (not just color)
- **When**: All UI; especially dark themes where saturation reads "alive".
- **How**:
  - Build hierarchy with weight (font + bg + border) BEFORE hue.
  - Reserve high chroma for one accent role (primary action / brand).
  - Demote secondary actions to outline or text-only buttons.
- **Source**: Material 3 emphasis tokens; Polaris elevation.
- **Anti-patterns**: Every button uses the brand gradient.

## Pattern: Size + weight ladder
- **When**: Designing a single component.
- **How**: Limit yourself to a 3-step ladder per component (e.g. title 600/18, label 500/13, hint 400/12). Anything more = noise.
- **Source**: Refactoring UI ch.3.

## Pattern: Optical alignment, not pixel alignment
- **When**: Icon + text rows, hero composition.
- **How**: Nudge icons + emoji 1–2 px to balance counter-space; align cap-heights not bounding boxes.
- **Source**: Apple HIG "Layout".

## Anti-pattern checklist (audit triggers)
- Multiple "primary" CTAs visible at once.
- Headline & body the same color + weight.
- Decorative shadows louder than the data they wrap.
- Icons in 4+ sizes within the same view.
- Cards that are all the same elevation regardless of importance.
