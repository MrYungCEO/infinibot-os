# 08 · Accessibility (WCAG 2.2 AA)

## Pattern: Visible focus indicator (SC 2.4.7 + 2.4.11)
- **When**: All interactive elements.
- **How**:
  - 2 px outline minimum, ≥3:1 contrast against adjacent colors.
  - Outline OUTSIDE the element (`outline-offset: 2px`) so it doesn't get clipped.
  - Never `outline: none` without an equivalent replacement.
  - WCAG 2.2 SC 2.4.11 "Focus Not Obscured": focus target must not be hidden by sticky headers / cookie banners.
- **Source**: WCAG 2.2.
- **Anti-patterns**: Custom focus identical to hover; brand-blue focus on brand-blue button.

## Pattern: Target size ≥ 24×24 CSS px (SC 2.5.8)
- **When**: All pointer targets.
- **How**:
  - AA: 24×24 px CSS minimum.
  - Recommended: 44×44 (iOS) / 48×48 (Android) for touch.
  - Exempt: inline links in body text; equivalent alternative present.
- **Source**: WCAG 2.2 SC 2.5.8.

## Pattern: Dragging movements (SC 2.5.7)
- **When**: Drag-and-drop reordering, sliders.
- **How**: Provide a non-drag alternative (up/down buttons, type-to-set). Don't rely on drag alone.
- **Source**: WCAG 2.2 SC 2.5.7.

## Pattern: Semantic HTML first, ARIA second
- **When**: Building any component.
- **How**:
  - `<button>` for actions, `<a href>` for navigation. Never `<div onClick>`.
  - Use ARIA only when no native equivalent (combobox, tablist, dialog with custom behavior).
  - Match WAI-ARIA Authoring Practices Guide for combobox / dialog / menu / tree.
- **Source**: WAI-ARIA APG 1.2; "First rule of ARIA: don't use ARIA".

## Pattern: Skip link + landmark regions
- **When**: Any page with persistent nav.
- **How**: First focusable element = "Skip to content". Wrap regions with `<header><nav><main><aside><footer>`. One `<h1>` per page.
- **Source**: WCAG 2.4.1; WebAIM.

## Pattern: Forms — labels associated; errors programmatic
- **When**: Every form.
- **How**:
  - `<label for>` or wrapping label.
  - `aria-describedby` ties hint + error text to the input.
  - `aria-invalid="true"` on the field; live-region announces summary.
- **Source**: WCAG 3.3.1 / 3.3.3.

## Pattern: Color contrast (SC 1.4.3 / 1.4.11)
- See `03-color-and-contrast.md`.

## Pattern: Keyboard parity
- **When**: Any custom widget.
- **How**: Every mouse/touch action must have a keyboard path. Test by unplugging the mouse. Modal: focus trap, ESC to dismiss, focus return to opener.
- **Source**: WAI-ARIA APG dialog pattern.

## Pattern: Reduced motion + transparency
- See `05-motion-design.md`. Also honor `prefers-reduced-transparency` (Safari).

## Anti-pattern checklist
- Icon-only buttons missing `aria-label`.
- `<div role="button">` without `tabindex="0"` + Enter/Space handlers.
- Form errors injected without `aria-live`.
- Modal that doesn't trap focus / return focus.
- Tooltips that only appear on hover (no focus/touch equivalent).
