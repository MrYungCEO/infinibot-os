# 02 · Typography Systems

## Pattern: Modular scale (1.125–1.333 ratio)
- **When**: Building or auditing a type scale.
- **How**:
  - Pick a base size (16 px web, 17 iOS, 14 sp Android).
  - Generate 6–8 steps using a single ratio (1.200 "minor third" or 1.250 "major third" are safest).
  - Cap at ~10 sizes total across the product. More = chaos.
- **Source**: Tim Brown "Modular Scale"; Material 3 type tokens.
- **Anti-patterns**: 14/15/16/17/18 px all in use; random one-off sizes.

## Pattern: Line-height by role
- **When**: Setting body, UI, and display styles.
- **How**:
  - Display (≥30 px): 1.05–1.15
  - Headings (20–28 px): 1.2–1.3
  - Body (14–18 px): 1.5–1.65
  - UI labels (12–14 px): 1.3–1.4
- **Source**: Refactoring UI ch.4; Material 3.
- **Anti-patterns**: 1.0 line-height on body copy (descenders clip).

## Pattern: Measure 45–75 ch
- **When**: Any paragraph block.
- **How**: Constrain `max-width` (~`65ch`) on body containers; for marketing copy aim 50–60 ch.
- **Source**: Bringhurst *Elements of Typographic Style*.
- **Anti-patterns**: Full-viewport-width paragraphs on desktop.

## Pattern: Pair one neutral + one expressive
- **When**: Selecting fonts.
- **How**: A neutral sans/serif for body + a single expressive face for display. Avoid 3+ families. System font stacks (SF/Inter/Roboto) for UI labels are the safest default.
- **Source**: Schoger "Practical Typography".

## Pattern: Numeric tabular-nums in tables / dashboards
- **When**: Tables, money, timestamps, KPI tiles.
- **How**: Use `font-variant-numeric: tabular-nums` so columns align without monospace ugliness.
- **Source**: CSS specs; Stripe Design System.

## Pattern: Letter-spacing inversely to size
- **When**: Building display heads + caps labels.
- **How**: Tighten display (>32 px) by −0.5% to −2%; loosen caps labels (10–12 px) by +5% to +8%.
- **Source**: Apple HIG "Typography".

## Anti-pattern checklist
- Italic + bold + underline on the same span.
- Headings using `font-weight: 700` everywhere (no 500/600 mid-weight).
- Mixing 3 type families in one view.
- Line-height 1.0 on multi-line text.
- All-caps for paragraphs (only labels ≤2 words should be ALL CAPS).
