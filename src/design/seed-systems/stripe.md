---
name: Stripe
description: Editorial confidence. Gradients earned with purpose, abundant whitespace, deep navy text, signature multi-color geometric headers.
---

# Stripe

Stripe sells trust through editorial confidence. The brand is "boring banking infrastructure that knows it's actually beautiful" — generous whitespace, premium typography, signature gradient flourishes used with restraint.

## 1. Color

- **Primary** `#635BFF` — the deep blue/violet that anchors the brand. Used for primary CTAs and key links.
- **Background** `#FFFFFF` default, `#F6F9FC` for raised surfaces, `#0A2540` for dark sections.
- **Foreground** `#0A2540` on light, `#FFFFFF` on dark.
- **Subtle text** `#425466` on light, `#ADBDCC` on dark.
- **Accent gradient** `#7A73FF → #635BFF → #0A2540` — used in hero backgrounds, never on text.

A signature gradient palette ("Pink → Orange → Mint" — `#FF80B5 → #FFC371 → #7DDFB7`) appears on marketing-flavored hero sections only. Never twice on the same page.

## 2. Typography

Display: a custom-feeling sans — use Camphor / Sohne / Inter as substitutes. Body: serif fallback is fine on long-form, but the main brand is sans throughout.

- Display XL: 72px / 1.05 / 600
- Display L: 56px / 1.05 / 600
- H1: 40px / 1.1 / 600
- H2: 28px / 1.2 / 600
- Body L: 19px / 1.55 / 400
- Body: 17px / 1.6 / 400
- Caption: 14px / 1.4 / 500

Letter-spacing tight on display (-0.02em), normal on body. Headlines wrap to 2-3 lines deliberately.

## 3. Spacing

8px base. Larger jumps (16, 24, 40, 64, 96, 128) for editorial breathing room. Stripe's secret is that sections are 96-160px tall vertically.

## 4. Layout

- Max content width: 1080px text, 1200px hero.
- Sections: full-bleed background, content centered.
- Asymmetric layouts welcome — copy on the left, code/visual on the right.

## 5. Components

Buttons:
- Primary — primary color, white text, 6px radius, 1px inner glow, 0.5px outer border. Hover: brighten 6%.
- Secondary — transparent on light, white on dark; same 6px radius.

Code blocks: signature element. `#0A2540` background, JetBrains Mono, syntax-highlighted. Often shown next to copy in a 2-column hero.

Cards: white surface, 0px or 1px hairline border, very subtle shadow (`0 2px 4px rgba(10,37,64,0.08)`).

## 6. Motion

Calm — 240–320ms transitions. Easing: `cubic-bezier(0.16, 1, 0.3, 1)` (premium ease-out). Hover states are smooth fade-ins, not pops.

The signature gradient on the hero often gently shifts angle over time — slow, ~12s loop, easy on the eyes.

## 7. Voice

- Headlines: serious + slightly grand. "Financial infrastructure for the internet."
- Body: technical but accessible. Explains the why before the how.
- CTA verbs: "Start now", "Contact sales", "Read the docs". No exclamation marks.

## 8. Brand

- Multi-color geometric hero is canon (Stripe's "wave"). Even abstracted, the visual feels Stripe-y if it's a flowing gradient with a clean masthead floating over it.
- Code is always shown — the brand believes in showing engineers the thing.
- Photography is rare. When present: real customers, premium lighting, on-brand pastels.

## 9. Anti-patterns

- Multiple gradient sections stacked. One per page, ideally just the hero.
- Stock photos of teams in offices.
- Drop shadows heavier than `0 2px 8px`.
- Border radius > 12px.
- Headline display weight at 700+. Stripe uses 600. The restraint matters.
- Mixing serif and sans within the same heading.
- "Get started for free" with an exclamation mark.
