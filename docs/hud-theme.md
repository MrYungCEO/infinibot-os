---
title: HUD Theme Primitives
description: Glass-depth, floating elevation, and HUD framing classes for the InfiniBot UI.
---

# HUD Theme Primitives

The InfiniBot UI uses a token-driven glassmorphism system (`theme-glass.ts`) so every panel, button, and chip can opt into the same depth, blur, and floating-card behavior. This page lists the available primitives, what they do, and when to reach for each.

All primitives are **CSS classes** that read from the `--g-*` design tokens. The tokens themselves are runtime-overridable via the appearance picker (and `applyThemeOverrides({...})`), so a palette swap re-tunes everything in place.

## Surface primitives — pick one for any panel

| Class | Use it for | Reads as |
|---|---|---|
| `.glass` | Lightweight surfaces, sidebars, secondary chrome | Sheet of frosted glass over the bg |
| `.glass-panel` | Standard rounded plate (chat panes, dialogs) | Glass plate floating above the page with a top-edge highlight |
| `.glass-plate` | Rounded plate without primary tint | Same as `.glass-panel` but neutral border |
| `.glass-floating` | Foreground floating cards (popovers, side dialogs) | Plate with stacked drop shadows + soft primary halo |
| `.glass-deep` | Hero / primary surface for a view | Deep refractive glass — top glare, bottom recess, primary bloom in the corner |
| `.glass-elevated` | Dramatic floating card | Highest altitude — three-stop drop shadow + primary glow |

Stack with these utility classes:

| Class | Effect |
|---|---|
| `.glass-edge` | Thin primary halo + edge highlight ring |
| `.glass-noise` | Subtle SVG film grain so panels aren't plastic |
| `.glass-alive-border` | 14s slow-panning gradient ring around the panel |
| `.glass-spin-border` | 4s conic gradient sweep — premium accent |
| `.shimmer-sheen` | Diagonal light sweep on hover-eligible elements |
| `.lift-on-hover` | Translate-up + intensified shadow on hover |
| `.depth-1 / .depth-2 / .depth-3` | Apply `--g-shadow-{sm,,lg}` directly |

## Buttons + chips

| Class | Effect |
|---|---|
| `.glass-button` | Standard primary button — surface + border + blur |
| `.glass-button.glass-button--primary` | Filled accent gradient with primary glow |
| `.glass-chip` | Pill-shaped status chip with primary tint |

## Headers

| Class | Effect |
|---|---|
| `.hud-title` | Mono-spaced uppercase label with a glowing primary dot |
| `.hud-title.hud-title--underline` | Above + thin primary underline rule |
| `.hud-frame` | Adds top-left + bottom-right corner brackets to any element |

## Background layers

These sit fixed behind the entire app and react to theme tokens:

- `.hud-aurora` — radial color plumes that drift slowly.
- `.hud-top-glow` — 2px primary→accent shimmer band across the top edge.
- `.infinibot-bg-overlay` — user-configurable tint + blur layer (driven by the appearance picker).

All three are mounted by `injectGlassTheme()` at app boot.

## Tokens you can override at runtime

`applyThemeOverrides({...})` accepts:

```ts
{
  primary?: string;        // hex
  accent?: string;         // hex
  surfaceTint?: string;    // hex — base panel surface
  bg?: string;             // hex — app background
  fg?: string;             // hex — text
  blur?: number;           // px — base backdrop blur
  blurHeavy?: number;      // px — heavy backdrop blur
  radius?: number;         // px — corner radius
  surfaceAlpha?: number;   // 0–1 — panel surface opacity
  shadowDepth?: number;    // 0.5–2 — multiplies all drop shadows
  overlayColor?: string;   // hex — bg overlay tint
  overlayOpacity?: number; // 0–1
  overlayBlur?: number;    // px
  overlayEnabled?: boolean;
  glassEnabled?: boolean;  // disables backdrop-filter when false
  glassTint?: string;      // hex — extra wash inside .glass / .glass-panel
  glassTintStrength?: number; // 0–1
  glassBorderColor?: string;
  fontFamily?: string;
}
```

`BUILT_IN_PALETTES` ships six presets: `infinibot-gold`, `aurora`, `ember`, `forest`, `noir`, `porcelain`. Apply one with `applyPalette(BUILT_IN_PALETTES[0])`.

## Composing for premium surfaces

The "high-end HUD" look is usually:

```html
<div class="glass-deep glass-edge glass-noise">
  <div class="hud-title hud-title--underline">SECTION</div>
  ...
</div>
```

For a foreground popover or modal:

```html
<div class="glass-elevated glass-noise lift-on-hover">
  ...
</div>
```

For a clickable card row:

```html
<div class="glass-panel lift-on-hover">
  ...
</div>
```

For a hero panel that should feel "alive":

```html
<div class="glass-deep glass-alive-border glass-noise">
  <div class="hud-title">LIVE</div>
  ...
</div>
```

## Reduced-motion respect

Every animation (`.hud-aurora`, `.hud-top-glow`, `.glass-spin-border`, `.shimmer-sheen`, `.glass-alive-border`) is disabled when the user has `prefers-reduced-motion: reduce`. The static depth, gradient, and glass blur stay — only the moving parts pause.

## Migration notes for existing views

The new primitives are **additive**. Existing classes (`.glass`, `.glass-panel`, `.glass-plate`, `.glass-floating`) are unchanged in semantics — they just got richer shadow stacks (top-edge highlight, bottom-edge recess, softer far-shadow). No view needs to change to benefit from the depth bump.

To opt into the deeper look:

- Replace a flat `<div>` panel with `class="glass-deep"`.
- Add `glass-edge` to surfaces that should look "selected" / focused.
- Add `glass-noise` to anything that's reading too sterile.
- Add `lift-on-hover` to interactive cards.
- Use `hud-title` instead of bespoke `<h2>` styles for consistency.
