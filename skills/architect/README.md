# 🏗️ Architect — UI/UX Design-to-Code Specialist

> **The Architect transforms designs into production-ready, performant, accessible web interfaces.**

## Overview

The Architect is a specialized agent for web development with a focus on:
- **Design-to-code implementation**
- **Scroll-triggered animations**
- **Mobile-first responsive design**
- **Accessibility (WCAG 2.1 AA)**
- **Component architecture**
- **Visual presets and theming**

## Files in This Skill

| File | Purpose |
|------|---------|
| `SKILL.md` | Core skill definition with design patterns, presets, and guidelines |
| `MCP_SETUP.md` | MCP installation commands and configuration |
| `README.md` | This overview document |

## Quick Start

1. **Install MCPs** (see `MCP_SETUP.md`)
2. **Set environment variables** for Figma, Vercel, Cloudflare
3. **Use the agent**: The skill is loaded automatically when the `architect` agent is spawned

## Visual Presets

| Preset | Description |
|--------|-------------|
| 🌑 **Dark Luxury** | Gold accents, rich blacks, subtle glows |
| 🌈 **Neon Cyberpunk** | Cyan/magenta glows, grid patterns |
| 🌿 **Organic Nature** | Earth tones, soft shadows, rounded shapes |
| ⬜ **Minimalist Tech** | Pure whites, single accent, maximum whitespace |
| 📰 **Retro/Vintage** | Sepia, hard shadows, bold typography |

## 14 Stylization Techniques

### Layout
1. Bento Grid Layouts
2. Broken Grid
3. Split-Screen Layouts
4. Layered Depth

### Motion
5. Scroll-Triggered Reveals
6. Parallax Depth
7. Micro-Interactions
8. Staggered Animations

### Visual
9. Glassmorphism
10. Gradient Meshes
11. Noise Textures
12. Light/Glow Effects

### Typography
13. Variable Font Animations
14. Kinetic Typography

## Integration Points

### Figma → Code
```bash
figma: get_file_styles(fileKey="ABC123")
figma: get_component(nodeId="xxx")
```

### QA Handoff
```javascript
mesh({ 
  action: "spawn", 
  agentId: "inspector",
  task: "Review the website..."
})
```

### Deployment
```bash
vercel: deploy(preview=true)
cloudflare: pages_deploy(projectName="my-site")
```

## Related Skills

- `elite-design` — Premium UI patterns and anti-generic checklist
- `frontend-designer` — Gemini-powered component generation
- `web-dev` — Scroll effects and responsive patterns
- `web-qa` — Quality assurance and testing

## Toolkit

- **CSS:** Grid, Flexbox, Custom Properties, Container Queries
- **Frameworks:** Lit (InfiniBot UI), React 19, Next.js 15
- **Styling:** Tailwind CSS v4, CVA, BEM
- **Animation:** Framer Motion, GSAP, CSS Transitions
- **Languages:** TypeScript (strict mode)

## Quality Checklist

Before delivery, verify:

- [ ] Scroll-triggered animations on every section
- [ ] Mobile-first responsive (320px → 2K+)
- [ ] 5+ stylization techniques applied
- [ ] Visual preset chosen/defined
- [ ] Lighthouse accessibility ≥ 90
- [ ] Lighthouse performance ≥ 90
- [ ] Keyboard navigation works
- [ ] No console errors
- [ ] QA agent spawned for review

---

*For detailed patterns and code examples, see `SKILL.md`.*
