# Frontend Design Workflow

Complete workflow for taking a project from idea to shipped frontend.

## Overview

```
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│Discovery│ → │ Design  │ → │  Build  │ → │  Test   │ → │  Ship   │
│  5 min  │   │ 10 min  │   │ 30 min+ │   │ 10 min  │   │  5 min  │
└─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘
```

---

## Phase 1: Discovery (5 min)

### Requirements Gathering Prompt

Ask the user or use this prompt with Gemini:

```
I'm building a frontend for [PROJECT]. Help me define requirements:

1. PROJECT TYPE
   - [ ] Landing page
   - [ ] Dashboard
   - [ ] E-commerce
   - [ ] Portfolio
   - [ ] Blog
   - [ ] SaaS application
   - [ ] Other: ___

2. PAGES NEEDED
   List all pages/sections: ___

3. TARGET AUDIENCE
   Who will use this? ___
   What devices? (mobile/desktop/both): ___

4. BRAND IDENTITY
   Existing brand? (Y/N): ___
   Brand colors: ___
   Logo: ___
   Mood/vibe: ___

5. REFERENCE SITES
   Sites you like: ___
   What you like about them: ___

6. TECH CONSTRAINTS
   Framework preference: ___
   Must integrate with: ___
   Hosting: ___

7. TIMELINE
   When do you need it? ___

Output a structured requirements brief.
```

### Requirements Output Format

```json
{
  "project": {
    "name": "...",
    "type": "landing_page",
    "description": "..."
  },
  "pages": [
    { "name": "Home", "sections": ["hero", "features", "pricing", "cta", "footer"] }
  ],
  "audience": {
    "primary": "...",
    "devices": ["mobile", "desktop"]
  },
  "brand": {
    "colors": { "primary": "#...", "secondary": "#..." },
    "fonts": { "heading": "...", "body": "..." },
    "vibe": "modern, professional"
  },
  "tech": {
    "framework": "nextjs",
    "styling": "tailwind",
    "hosting": "vercel"
  }
}
```

---

## Phase 2: Design System (10 min)

### Generate Design Tokens

Use `references/design-system-patterns.md` with project context:

```bash
gemini --model gemini-2.5-pro "Generate a design system for:
Project: [NAME]
Industry: [INDUSTRY]
Vibe: [ADJECTIVES]
Primary color: [IF KNOWN]

Output:
1. Full color palette with semantic colors
2. Typography scale
3. Spacing scale
4. Component variants (buttons, inputs, cards)

Format: JSON + CSS custom properties"
```

### Create tokens.css

Convert output to CSS custom properties file:

```css
/* tokens.css - Generated design system */
:root {
  /* Colors */
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  /* ... */
  
  /* Typography */
  --font-sans: 'Inter', system-ui, sans-serif;
  --text-base: 1rem;
  --text-lg: 1.125rem;
  /* ... */
  
  /* Spacing */
  --space-4: 1rem;
  --space-8: 2rem;
  /* ... */
}
```

---

## Phase 3: Build (30 min+)

### Component Generation Order

Build in this order for best results:

1. **Layout shell** — HTML structure, containers
2. **Navigation** — Header, mobile menu
3. **Hero** — First impression section
4. **Content sections** — Features, benefits, etc.
5. **Social proof** — Testimonials, logos, stats
6. **Conversion** — Pricing, CTA, forms
7. **Footer** — Links, newsletter, copyright

### Per-Component Workflow

For each component:

```
1. Prompt Gemini with component spec from references/ui-prompts.md
2. Review output, request adjustments if needed
3. Copy code to project
4. Test responsive behavior
5. Add animations/interactions
6. Move to next component
```

### Iteration Prompt

When component needs changes:

```
The [COMPONENT] you generated needs these changes:
1. [SPECIFIC CHANGE]
2. [SPECIFIC CHANGE]

Keep everything else the same. Output the updated code.
```

---

## Phase 4: Test (10 min)

### Visual QA Checklist

```
[ ] Desktop (1440px, 1920px)
[ ] Tablet (768px, 1024px)
[ ] Mobile (375px, 414px)
[ ] Hover states work
[ ] Focus states visible
[ ] Animations smooth
[ ] Images load correctly
[ ] Text readable at all sizes
[ ] No horizontal scroll on mobile
[ ] Touch targets >= 44px
```

### Accessibility Check

```bash
# Run Lighthouse
npx lighthouse http://localhost:3000 --only-categories=accessibility

# Or use axe-core in browser
```

Minimum requirements:
- [ ] All images have alt text
- [ ] Color contrast passes (4.5:1)
- [ ] Keyboard navigation works
- [ ] Focus indicators visible
- [ ] ARIA labels on interactive elements
- [ ] Semantic HTML structure

### Performance Check

```
[ ] Images optimized (WebP, lazy loading)
[ ] Fonts loaded efficiently (display: swap)
[ ] CSS/JS minified
[ ] No layout shift (CLS)
[ ] Fast paint (LCP < 2.5s)
```

---

## Phase 5: Ship (5 min)

### Pre-Deploy Checklist

```
[ ] All links work
[ ] Forms submit correctly
[ ] Meta tags set (title, description, OG)
[ ] Favicon added
[ ] Analytics configured
[ ] Error pages exist (404, 500)
[ ] SSL enabled
[ ] Environment variables set
```

### Deploy Commands

**Vercel (Next.js)**
```bash
npx vercel --prod
```

**Netlify (Static)**
```bash
npx netlify deploy --prod
```

**Cloudflare Pages**
```bash
npx wrangler pages deploy dist
```

---

## Quick Reference: Gemini Commands

```bash
# Generate full page
gemini --model gemini-2.5-pro "Build a [TYPE] page with [SECTIONS]..."

# Generate component
gemini --model gemini-2.5-pro "Generate a [COMPONENT] component with [SPECS]..."

# Refine component
gemini --model gemini-2.5-pro "Update this code: [PASTE CODE]. Change: [CHANGES]"

# Screenshot to code
gemini --model gemini-2.5-pro "Recreate this UI in React + Tailwind" < screenshot.png

# Design system
gemini --model gemini-2.5-pro --output-format json "Generate design tokens for [BRAND]..."
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Layout broken on mobile | Check flex/grid, use min-width breakpoints |
| Text too small | Use clamp() or increase mobile font sizes |
| Animation janky | Use transform/opacity only, add will-change |
| Images slow | Compress, lazy load, use next/image |
| Colors look off | Check color space, ensure hex values correct |
| Spacing inconsistent | Stick to spacing scale, use variables |
