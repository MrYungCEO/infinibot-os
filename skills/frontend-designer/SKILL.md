---
name: frontend-designer
description: Visual UI/UX development agent using Gemini 3.1 Pro Preview. Use when building landing pages, dashboards, SaaS interfaces, portfolios, or any web frontend that needs professional design. Triggers on requests to design websites, create UI components, build visual interfaces, generate design systems, or make things look good. Handles responsive layouts, animations, accessibility, and modern CSS.
---

# Frontend Designer — Visual UI/UX Development Agent

Professional frontend design agent powered by Gemini 3.1 Pro. Specializes in visual design, UI/UX best practices, and production-ready responsive interfaces.

## Quick Start

1. **Gather requirements** — What are we building? Who's it for?
2. **Generate design system** — Colors, typography, spacing, components
3. **Build components** — Use the boilerplate or generate fresh
4. **Polish & test** — Responsive, accessible, performant

## Gemini 3.1 Pro Preview API

All generation uses Gemini 3.1 Pro Preview via direct API:

```powershell
# PowerShell wrapper script (recommended)
powershell -File "$HOME\clawd\scripts\gemini-3.1-pro.ps1" -Prompt "Generate a React landing page hero section with gradient background, centered headline, subtitle, and CTA button. Use Tailwind CSS. Modern, clean aesthetic."

# With JSON output
powershell -File "$HOME\clawd\scripts\gemini-3.1-pro.ps1" -Prompt "Generate design system tokens" -Json

# Direct API call (alternative)
$body = @{contents=@(@{parts=@(@{text="Your prompt here"})})} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=$env:GOOGLE_API_KEY" -Method Post -Body $body -ContentType "application/json"
```

### Model Details
- **Model**: `gemini-3.1-pro-preview`
- **Provider**: Google AI Studio (generativelanguage.googleapis.com)
- **Context**: 1M tokens
- **Specialization**: Enhanced software engineering, agentic reliability

## Workflow

### Phase 1: Discovery (5 min)

Ask these questions before designing:

1. **What's the product?** (SaaS, portfolio, ecommerce, landing page)
2. **Who's the audience?** (Developers, executives, consumers)
3. **What's the vibe?** (Professional, playful, minimal, bold)
4. **Existing brand?** (Colors, fonts, logo)
5. **Key pages/sections?** (Hero, features, pricing, contact)
6. **Responsive targets?** (Mobile-first, desktop-first, specific breakpoints)

### Phase 2: Design System Generation

Use the design system prompt from `references/design-system-patterns.md`:

```bash
gemini --model gemini-3.1-pro-preview "$(cat references/design-system-patterns.md)" > design-system.json
```

Output includes:
- CSS custom properties for all tokens
- Tailwind config extension
- Component variant specs
- Accessibility color pairs

### Phase 3: Component Building

Generate components with the specialized prompts in `references/ui-prompts.md`:

| Component Type | Prompt Reference |
|---------------|------------------|
| Hero sections | `hero-section-prompt` |
| Feature grids | `feature-grid-prompt` |
| Pricing tables | `pricing-table-prompt` |
| Testimonials | `testimonial-prompt` |
| Navigation | `navigation-prompt` |
| Forms | `form-prompt` |
| Cards | `card-prompt` |
| Footers | `footer-prompt` |

### Phase 4: Assembly

Use the boilerplate at `assets/boilerplate/` or generate a full page:

```bash
gemini --model gemini-3.1-pro-preview "Build a complete landing page HTML file with:
- Sticky navigation
- Hero with headline, subtitle, CTA
- 3-column feature grid with icons
- Pricing table (3 tiers)
- Testimonial carousel
- Contact form
- Footer with links

Tech: HTML5, Tailwind CSS (CDN), vanilla JS
Style: Modern SaaS, clean white background, blue accents
Responsive: Mobile-first, breakpoints at 640px, 1024px"
```

## Framework-Specific Patterns

### React + Tailwind (Default)

```jsx
// Generated component structure
export function FeatureCard({ icon, title, description }) {
  return (
    <div className="group relative p-6 bg-white rounded-2xl shadow-sm hover:shadow-xl transition-all duration-300 border border-gray-100">
      <div className="w-12 h-12 flex items-center justify-center rounded-xl bg-blue-50 text-blue-600 group-hover:scale-110 transition-transform">
        {icon}
      </div>
      <h3 className="mt-4 text-lg font-semibold text-gray-900">{title}</h3>
      <p className="mt-2 text-gray-600 text-sm leading-relaxed">{description}</p>
    </div>
  );
}
```

### Next.js App Router

- Use `app/` directory structure
- Server components by default, `"use client"` only when needed
- Metadata exports for SEO
- Image optimization with `next/image`
- Font optimization with `next/font`

### Vue 3 + Tailwind

- Composition API (`<script setup>`)
- Auto-imports with unplugin
- Nuxt 3 for SSR

### Vanilla HTML + CSS

- Use boilerplate from `assets/boilerplate/`
- CSS custom properties for theming
- Progressive enhancement
- No build step required

## Design Principles

### 1. Visual Hierarchy
- Size: Larger = more important
- Color: High contrast for CTAs, muted for secondary
- Spacing: Group related items, separate sections
- Typography: 3-4 sizes max, clear heading scale

### 2. Responsive Design
- Mobile-first CSS (min-width breakpoints)
- Fluid typography: `clamp(1rem, 2vw + 0.5rem, 1.5rem)`
- Container queries where appropriate
- Touch targets: minimum 44x44px

### 3. Motion & Animation
- Use `transition-all duration-300` for hover states
- `transform` and `opacity` for performance
- Respect `prefers-reduced-motion`
- Meaningful animations (not decorative)

### 4. Accessibility
- Semantic HTML (`<nav>`, `<main>`, `<section>`, `<article>`)
- Color contrast: 4.5:1 for text, 3:1 for large text
- Focus indicators: visible, high contrast
- Alt text for images
- ARIA labels for interactive elements

## Common Patterns

### Hero Section
```
┌─────────────────────────────────────────────┐
│  Logo                           Nav Links   │
├─────────────────────────────────────────────┤
│                                             │
│         Big Bold Headline Here              │
│      Supporting text that explains          │
│                                             │
│    [Primary CTA]    [Secondary CTA]         │
│                                             │
│         ┌─────────────────────┐             │
│         │   Hero Image/Demo   │             │
│         └─────────────────────┘             │
└─────────────────────────────────────────────┘
```

### Feature Grid
```
┌───────────┐  ┌───────────┐  ┌───────────┐
│   Icon    │  │   Icon    │  │   Icon    │
│  Feature  │  │  Feature  │  │  Feature  │
│   Text    │  │   Text    │  │   Text    │
└───────────┘  └───────────┘  └───────────┘
```

### Pricing Table
```
┌──────────┐  ┌──────────────┐  ┌──────────┐
│  Basic   │  │ ⭐ Pro        │  │Enterprise│
│  $9/mo   │  │   $29/mo     │  │  Custom  │
│  ─────   │  │   ─────      │  │  ─────   │
│  • Feat  │  │  • Feat      │  │ • Feat   │
│  • Feat  │  │  • Feat      │  │ • Feat   │
│ [Button] │  │  [Button]    │  │ [Button] │
└──────────┘  └──────────────┘  └──────────┘
```

## Anti-Patterns (Don't Do This)

❌ **Walls of text** — Break into digestible chunks
❌ **Low contrast** — Test with contrast checkers
❌ **Tiny touch targets** — 44px minimum
❌ **Animation overload** — Subtle > flashy
❌ **No whitespace** — Let the design breathe
❌ **Inconsistent spacing** — Use the spacing scale
❌ **Too many fonts** — 1-2 families max
❌ **Unoptimized images** — Compress, lazy load

## References

- `references/design-system-patterns.md` — Design system generation prompts and token structures
- `references/ui-prompts.md` — Specialized prompts for each component type
- `references/workflow.md` — Full PRD → Design → Build workflow

## Asset Boilerplate

The `assets/boilerplate/` directory contains:

```
boilerplate/
├── index.html          ← Semantic HTML5 skeleton
├── css/
│   ├── reset.css       ← Modern CSS reset
│   ├── tokens.css      ← Design system custom properties
│   └── components.css  ← Base component styles
└── js/
    ├── main.js         ← Intersection observers, animations
    └── utils.js        ← Helper functions
```

## After Building

1. **Preview** — `npx serve .` or `python -m http.server 8080`
2. **Test responsive** — Chrome DevTools device mode
3. **Check accessibility** — Run Lighthouse audit
4. **Optimize images** — Compress before deploy
5. **Ship it** — Vercel, Netlify, Cloudflare Pages
