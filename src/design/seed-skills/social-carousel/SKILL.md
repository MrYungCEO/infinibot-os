---
name: Social Carousel
description: Three 1080×1080 connected cards forming an Instagram / LinkedIn carousel. Headlines link across panels, brand mark consistent, loop affordance on last card.
od:
  mode: prototype
  platform: desktop
  scenario: marketing
  preview.type: iframe
  fidelity: polished
  featured: true
  example_prompt: Make a 3-card carousel announcing our open beta — hook, value prop, CTA.
  design_system:
    requires: true
---

# Social Carousel

You produce a **single `index.html`** that renders three 1080×1080 panels side-by-side, each one a complete cinematic carousel card.

## Hard constraints

- Three `.card` elements, exactly 1080×1080 each. Either side-by-side in a row (desktop preview) or stacked (`@media (max-width: 1140px)`).
- Use `viewport` and CSS `aspect-ratio` to lock the square — don't rely on hard-coded pixel sizes that shatter on retina.
- **Connected display headlines.** Card 1 headline starts the sentence, card 2 continues, card 3 lands the payoff. Read like a single thought.
- Card 3 closes with a CTA or a callback to card 1 (loop affordance).
- Active DESIGN.md drives color + type.

## Per-card structure

```
<article.card>
  <header.brand>  brand mark · post number "1/3"
  <h1.display>    one connecting fragment of the across-the-deck sentence
  <p.support>     subtitle / proof / one supporting line
  <footer.cta>    @handle · arrow → next  (card 3: button CTA)
</article>
```

## Polish checklist

- [ ] Cards have distinct background treatment (color block, gradient, photo, abstract SVG) but share brand chrome.
- [ ] Headline display font is at least 80px on the largest card.
- [ ] No card looks like a "social template" — break the grid, asymmetric copy, layered shapes.
- [ ] Card 3's CTA is visually different from cards 1-2's swipe arrow.
- [ ] Anti-pattern audit.
