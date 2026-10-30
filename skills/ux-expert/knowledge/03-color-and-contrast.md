# 03 · Color & Contrast

## Pattern: Semantic palette roles (not "blue/red")
- **When**: Building or auditing tokens.
- **How**:
  - Define ROLES: `surface`, `surface-elevated`, `text-primary`, `text-secondary`, `text-disabled`, `border`, `border-strong`, `primary`, `primary-hover`, `on-primary`, `success`, `warning`, `danger`, `info`, `focus-ring`.
  - Every component references roles, never raw hex.
- **Source**: Material 3 color roles; Polaris semantic tokens.
- **Anti-patterns**: `#3B82F6` sprinkled in components.

## Pattern: WCAG 2.2 contrast minimums
- **When**: Any text or interactive surface.
- **How**:
  - Body text (≤18 px regular / ≤14 px bold) → **4.5:1** against bg.
  - Large text (≥24 px or 18.66 px bold) → **3:1**.
  - UI components + graphical objects (icons, focus rings) → **3:1**.
  - Disabled text is exempt but should still hit ~3:1 to be perceivable.
- **Source**: WCAG 2.2 SC 1.4.3 / 1.4.11.
- **Anti-patterns**: Gray-on-gray hints at 2.1:1; placeholder = "label".

## Pattern: APCA for dark mode
- **When**: Verifying contrast in dark themes.
- **How**: Use APCA (Lc ≥ 75 for body, ≥ 60 for large text). WCAG ratios under-predict dark-mode legibility for desaturated text.
- **Source**: Andrew Somers / APCA spec.

## Pattern: Don't carry color alone
- **When**: Conveying state (success/error/warning).
- **How**: Color + icon + text. Never red border with no other cue.
- **Source**: WCAG 1.4.1 "Use of Color".

## Pattern: Dark-mode surfaces by elevation
- **When**: Building a dark theme.
- **How**:
  - Background `#0B0B0E`–`#111114` (not pure black — causes halation).
  - Each elevation tier raises lightness ~3–5% (overlay alpha 0.04–0.08 on top of base).
  - Use translucent borders (rgba(255,255,255,0.08)) over solid lines.
- **Source**: Material 3 dark theme; Linear design notes.

## Pattern: Accent restraint
- **When**: Saturated brand color is in play.
- **How**: Saturated accent appears on ≤10% of pixels in a given viewport. Everything else is neutral.
- **Source**: Refactoring UI ch.5.

## Anti-pattern checklist
- White text on photographic backgrounds without a scrim.
- Pure black (#000) backgrounds with pure white (#fff) text in dark mode.
- 3+ accent colors competing for attention.
- Focus ring color identical to brand → invisible focus on the brand button.
- Status colors that fail color-blind tests (red/green only).
