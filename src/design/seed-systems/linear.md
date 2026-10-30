---
name: Linear
description: Restrained, dense, dark-mode-first. Minimal chrome, sharp edges, monospace accents, single-color brand language.
---

# Linear

The Linear visual language is "operator software" — built for power users who live in keyboard shortcuts, want information density, and trust the brand's restraint.

## 1. Color

- **Primary** `#5E6AD2` — the only saturated color. Used for primary actions, links, focus rings, and selected state.
- **Background** `#1E1E22` (default), `#08090A` (deepest surface), `#27272A` (raised cards).
- **Foreground** `#FFFFFF` for primary text on dark surfaces, `#9CA3AF` for secondary, `#6B7280` for tertiary.
- **Accent** `#B4F7CA` — reserved for success / completion. Sparing.
- **Danger** `#EF4444`. Never on a button — only on text + icons.

Neutrals carry the design. Color is information, not decoration.

## 2. Typography

Inter, with a tight letter-spacing of -0.011em on display sizes and 0 on body.

- Display L: 48px / line-height 1.05 / weight 700
- Display M: 32px / 1.1 / 700
- H1: 24px / 1.25 / 600
- H2: 18px / 1.35 / 600
- Body: 15px / 1.5 / 400
- Caption: 13px / 1.4 / 400
- Mono: JetBrains Mono / IBM Plex Mono — used in keyboard shortcuts, ids, code references.

Italics are rare. Bold is rare. Restraint is the brand.

## 3. Spacing

4px base unit. Common values: 4, 8, 12, 16, 24, 32, 48, 64. Avoid odd numbers (5, 9, 11) — keep the rhythm tight.

## 4. Layout

- Maximum content width: 1080px on text-heavy pages, full-bleed on dashboards.
- Sidebar: 240px collapsed, 60px icons-only.
- Density: prefer 4-6 line-height of breathing room over generous whitespace. This is operator UI.

## 5. Components

Buttons:
- Primary — primary color background, 1px darker border, 0.5px subtle inner shadow, 6px radius. Hover lifts 1px and brightens 4%.
- Secondary — transparent, border-color text foreground at 16% opacity.
- Ghost — no border, just the foreground color, used inline.

Inputs: 1px border at 8% opacity, 6px radius, 36px tall, focuses to primary color border with no glow.

Cards: 1px border, 8px radius, no shadow (Linear doesn't use drop shadows on dark surfaces).

## 6. Motion

Fast — 120–180ms for hover state, 220–280ms for layout shifts. Easing: `cubic-bezier(0.2, 0, 0, 1)` on enter, default linear-out on exit.

No bouncing. No spring. The brand is decisive.

## 7. Voice

- Headlines: declarative, often a single noun phrase or a tight sentence. "Built for modern software teams."
- Body copy: short paragraphs, no hedging, technical precision. Talks to engineers.
- Microcopy: terse. "Done", "Cancel", "Update", "Sign in".

Never: cute, exclamatory, emoji-heavy, "Let's get started!" energy.

## 8. Brand

- Logomark is a simple geometric mark, almost a glyph. Always at 100% opacity. Never tinted.
- Keyboard shortcut chips (⌘K, etc.) are signature brand elements — use the mono font with a 1px border, 4px radius, 3-4px horizontal padding.
- The "G" keyboard navigation prefix is canon — feel free to imply keyboard-first energy.

## 9. Anti-patterns (do not do this)

- Drop shadows on cards. We don't use them.
- Gradients on buttons. Solid colors only.
- More than one accent color on a single page.
- Italic body copy.
- Rounded corners > 8px on any surface.
- Stock illustration of "abstract people" or "shaking hands". No.
- Hand-drawn icons. Use a strict icon set (lucide, phosphor, heroicons).
- "Learn more" CTAs without a destination noun in the link.
