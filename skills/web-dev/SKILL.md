---
name: web-dev
description: Build responsive websites with modern scroll effects, animations, and mobile-first design. Use when creating landing pages, portfolios, dashboards, or any web project that needs responsive layout and scroll-driven animations. Triggers on requests to build websites, create landing pages, or make web pages with scrolling effects.
---

# Web Dev — Responsive Sites with Scroll Effects

Build production-ready responsive websites using the included boilerplate and patterns.

## Quick Start

1. Copy `assets/boilerplate/` to the workspace as the project root
2. Customize `index.html` — replace sections, content, colors
3. Edit `css/style.css` — adjust the CSS custom properties at `:root`
4. Edit `js/main.js` — configure scroll observers and animations
5. Serve with `npx serve .` or `python -m http.server 8080` for preview
6. When done, **spawn the `web-qa` agent** to review the site

## Architecture

```
project/
├── index.html          ← Semantic HTML5, sections for scroll
├── css/
│   ├── reset.css       ← Normalize/reset
│   ├── style.css       ← Design system (custom props, grid, typography)
│   └── scroll.css      ← Scroll-driven animations & effects
├── js/
│   ├── main.js         ← IntersectionObserver, scroll triggers
│   └── smooth.js       ← Smooth scroll, parallax, progress bar
└── assets/             ← Images, fonts, icons
```

## Design System

All customization flows through CSS custom properties in `:root`:

```css
--color-bg, --color-fg, --color-accent, --color-accent-2
--font-heading, --font-body
--space-xs through --space-3xl
--radius-sm, --radius-md, --radius-lg
--transition-fast, --transition-normal, --transition-slow
```

Change these to retheme the entire site instantly.

## Responsive Breakpoints

Mobile-first with three breakpoints:
- `--bp-sm: 640px` — Tablet
- `--bp-md: 1024px` — Desktop
- `--bp-lg: 1440px` — Wide

Use the grid utility classes: `.grid-auto`, `.grid-2`, `.grid-3`, `.grid-4`

## Scroll Effects Available

### 1. Fade-in on scroll
Add `class="scroll-reveal"` to any element. It fades/slides in when entering viewport.

### 2. Parallax sections
Add `data-parallax="0.3"` to background elements. Value = speed multiplier.

### 3. Sticky sections
Add `class="scroll-sticky-section"` for sections that pin while content scrolls through.

### 4. Progress bar
Automatic scroll progress bar at top of page (configurable in `main.js`).

### 5. Counter animations
Add `class="scroll-counter" data-target="500"` for animated number counters.

### 6. Horizontal scroll sections
Wrap in `class="horizontal-scroll-wrapper"` for horizontal scroll-on-vertical-scroll.

## After Building

**Always spawn the QA agent for review:**

```
Use sessions_spawn to run the web-qa agent:
- task: "Review the website at http://localhost:8080. Test responsive design, scroll effects, accessibility, and performance. Send detailed feedback."
```

The QA agent will navigate the site with a real browser, test breakpoints, check scroll behavior, and send structured feedback back to this session.

## References

- `references/scroll-patterns.md` — Advanced scroll effect recipes and IntersectionObserver patterns
- `references/responsive-patterns.md` — Common responsive layout patterns and grid systems
