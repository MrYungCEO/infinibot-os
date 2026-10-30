# 04 · Spacing & Rhythm

## Pattern: 4 / 8 pt spacing grid
- **When**: Defining tokens; every component.
- **How**:
  - Base unit = 4 px; main rhythm in 8 px multiples (8/16/24/32/48/64).
  - Use 4 px only for micro gaps (icon ↔ label).
  - Forbid arbitrary spacings (`margin: 13px`).
- **Source**: Material 3; Apple HIG "Layout".
- **Anti-patterns**: Spacing values pulled from Figma without quantization.

## Pattern: 8-step spacing scale
- **When**: Adopting tokens.
- **How**: `space-1` 4, `space-2` 8, `space-3` 12, `space-4` 16, `space-5` 24, `space-6` 32, `space-7` 48, `space-8` 64. Anything bigger → `space-9` 96 / `space-10` 128.
- **Source**: Tailwind spacing scale; IBM Carbon.

## Pattern: Vertical rhythm
- **When**: Reading surfaces (docs, articles, settings).
- **How**: Pick a baseline (e.g. 8 px). Top margins of headings + paragraph + media all snap to multiples. Use `margin-top` for sectioning, `margin-bottom` only for inline-flow exceptions; or pick one direction and stick with it.
- **Source**: Bringhurst; web typography handbook.

## Pattern: White space ≠ "wasted" space
- **When**: Stakeholders push to "fill" empty regions.
- **How**:
  - White space around a CTA increases conversion measurably (Carmel‐Gilfilen / Baymard).
  - Group related items with smaller gaps; separate unrelated with 2× larger gaps (gestalt proximity).
- **Source**: Gestalt; Refactoring UI ch.3.

## Pattern: Density tiers
- **When**: Designing data-heavy UIs.
- **How**: Provide `comfortable` (default) + `compact` (75% row height, smaller paddings). Tie to user preference token. Never make compact the default for first-run users.
- **Source**: Atlassian density; Gmail.

## Pattern: Touch target padding ≥ visual size
- **When**: Mobile / hybrid UIs.
- **How**: Visual icon may be 20 px, but tap target must be ≥44×44 pt (iOS) / ≥48×48 dp (Android) — expand via padding or `::before` overlay, not by enlarging the icon.
- **Source**: Apple HIG; WCAG 2.2 SC 2.5.8.

## Anti-pattern checklist
- Inconsistent gaps inside the same list (24 / 26 / 22).
- Card padding doubled but inner gap unchanged → orphan content.
- Headings glued to following paragraph (margin-top < 16 px on H2+).
- Buttons at 28×28 with no extended hit area on mobile.
