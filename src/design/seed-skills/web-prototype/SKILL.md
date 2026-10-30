---
name: Web Prototype
description: Single-page marketing / landing / hero prototype in one self-contained HTML file. Default for prototype-mode briefs.
od:
  mode: prototype
  platform: desktop
  scenario: design
  preview.type: iframe
  fidelity: polished
  default_for: prototype
  featured: true
  example_prompt: Build me a landing page for a small-batch coffee subscription with a hero, three feature cards, a pricing strip, and a footer.
  design_system:
    requires: true
---

# Web Prototype

You produce a **single self-contained `index.html`** that renders a polished one-page marketing/landing/hero layout.

## Hard constraints

- **One file**. All CSS inline in `<style>`. All JS, if any, inline at the bottom of `<body>`. No external links except Google Fonts, image CDNs you decide on, and tasteful pexels/unsplash imagery.
- **No build step**. Open in a browser, it works.
- **Follow the active DESIGN.md.** Color, type, spacing, voice, anti-patterns all come from there. Quote the section names in comments above the relevant CSS so a reader can audit.
- **Mobile-responsive** via a single `@media (max-width: 640px)` block — don't over-engineer breakpoints.
- **Real content**. Use the project brief to write the actual copy. No "Lorem Ipsum". No "your headline here".

## Structure

```
<nav> brand-mark, links, primary CTA
<main>
  <section.hero>     headline · supporting copy · CTA · supporting visual (svg / hero img / abstract css art)
  <section.features> 3-card grid OR alternating image/text rows
  <section.social>   logos / testimonials / metric strip
  <section.cta>      single decisive CTA
<footer> minimal — copyright, social, address
```

## Output

Write `index.html` at the project workspace root. Don't create subfolders unless you legit need them (e.g. `/assets/hero.svg`).

## Polish checklist before declaring done

- [ ] H1 is a complete, opinionated sentence — not a label.
- [ ] At least one detail that wouldn't survive a "looks AI-generated" sniff test (asymmetric layout, off-color accent, hand-drawn underline, unconventional spacing).
- [ ] Buttons have a real hover state, not just default browser behavior.
- [ ] Page loads with no console errors and no layout shift.
- [ ] Anti-pattern audit: re-read the DESIGN.md anti-patterns section and confirm none triggered.
