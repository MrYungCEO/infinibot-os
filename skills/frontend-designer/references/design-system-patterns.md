# Design System Generation Patterns

Prompts and structures for generating comprehensive design systems with Gemini.

## Master Design System Prompt

Use this prompt to generate a complete design system:

```
Create a comprehensive design system for the following project:

PROJECT CONTEXT:
- Product: [PRODUCT_NAME]
- Industry: [INDUSTRY]
- Brand personality: [TRAITS - e.g., professional, modern, trustworthy]
- Target audience: [USERS]
- Primary use: [WEB/MOBILE/BOTH]

Generate the following in JSON format:

1. COLOR SYSTEM
{
  "colors": {
    "primary": { "50": "#...", "100": "#...", ..., "900": "#..." },
    "secondary": { ... },
    "accent": { ... },
    "neutral": { "50": "#...", ..., "950": "#..." },
    "semantic": {
      "success": { "light": "#...", "DEFAULT": "#...", "dark": "#..." },
      "warning": { ... },
      "error": { ... },
      "info": { ... }
    }
  }
}

2. TYPOGRAPHY SYSTEM
{
  "fonts": {
    "heading": "Font Name, fallback, sans-serif",
    "body": "Font Name, fallback, sans-serif",
    "mono": "Font Name, fallback, monospace"
  },
  "scale": {
    "xs": { "size": "0.75rem", "lineHeight": "1rem" },
    "sm": { "size": "0.875rem", "lineHeight": "1.25rem" },
    "base": { "size": "1rem", "lineHeight": "1.5rem" },
    "lg": { "size": "1.125rem", "lineHeight": "1.75rem" },
    "xl": { "size": "1.25rem", "lineHeight": "1.75rem" },
    "2xl": { "size": "1.5rem", "lineHeight": "2rem" },
    "3xl": { "size": "1.875rem", "lineHeight": "2.25rem" },
    "4xl": { "size": "2.25rem", "lineHeight": "2.5rem" },
    "5xl": { "size": "3rem", "lineHeight": "1" }
  },
  "weights": ["400", "500", "600", "700"]
}

3. SPACING SYSTEM (4px base)
{
  "spacing": {
    "0": "0",
    "1": "0.25rem",
    "2": "0.5rem",
    "3": "0.75rem",
    "4": "1rem",
    "5": "1.25rem",
    "6": "1.5rem",
    "8": "2rem",
    "10": "2.5rem",
    "12": "3rem",
    "16": "4rem",
    "20": "5rem",
    "24": "6rem"
  }
}

4. BORDER RADIUS
{
  "radius": {
    "none": "0",
    "sm": "0.125rem",
    "DEFAULT": "0.25rem",
    "md": "0.375rem",
    "lg": "0.5rem",
    "xl": "0.75rem",
    "2xl": "1rem",
    "3xl": "1.5rem",
    "full": "9999px"
  }
}

5. SHADOWS
{
  "shadows": {
    "sm": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    "DEFAULT": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
    "md": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
    "lg": "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    "xl": "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)"
  }
}

6. COMPONENT VARIANTS
{
  "button": {
    "primary": { "bg": "primary-600", "text": "white", "hover": "primary-700" },
    "secondary": { "bg": "secondary-100", "text": "secondary-700", "hover": "secondary-200" },
    "ghost": { "bg": "transparent", "text": "neutral-700", "hover": "neutral-100" },
    "sizes": {
      "sm": { "px": "3", "py": "1.5", "text": "sm" },
      "md": { "px": "4", "py": "2", "text": "base" },
      "lg": { "px": "6", "py": "3", "text": "lg" }
    }
  }
}

Also provide:
- CSS custom properties version
- Tailwind config extension
- Dark mode variants
- Accessibility color contrast notes
```

## CSS Custom Properties Output

```css
:root {
  /* Colors */
  --color-primary-50: #eff6ff;
  --color-primary-100: #dbeafe;
  --color-primary-500: #3b82f6;
  --color-primary-600: #2563eb;
  --color-primary-700: #1d4ed8;
  
  /* Typography */
  --font-heading: 'Inter', system-ui, sans-serif;
  --font-body: 'Inter', system-ui, sans-serif;
  
  /* Spacing */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  
  /* Radius */
  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
  
  /* Shadows */
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);
  
  /* Transitions */
  --transition-fast: 150ms ease;
  --transition-normal: 300ms ease;
  --transition-slow: 500ms ease;
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #0f172a;
    --color-fg: #f8fafc;
    /* ... */
  }
}
```

## Tailwind Config Extension

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: {
          50: 'var(--color-primary-50)',
          // ...
        }
      },
      fontFamily: {
        heading: ['var(--font-heading)'],
        body: ['var(--font-body)'],
      },
      spacing: {
        // Custom spacing if needed
      },
      borderRadius: {
        // Custom radius if needed
      }
    }
  }
}
```

## Industry-Specific Palettes

### Fintech / Finance
- Primary: Deep blue (#1e40af) — trust, stability
- Secondary: Teal (#0d9488) — growth
- Accent: Gold (#f59e0b) — premium
- Neutral: Slate grays

### Healthcare
- Primary: Calming blue (#0284c7)
- Secondary: Soft green (#10b981)
- Accent: Warm coral (#f97316)
- Neutral: Cool grays

### Creative / Design
- Primary: Vibrant purple (#7c3aed)
- Secondary: Hot pink (#ec4899)
- Accent: Electric blue (#06b6d4)
- Neutral: True grays

### Enterprise / B2B
- Primary: Professional blue (#2563eb)
- Secondary: Slate (#475569)
- Accent: Green (#22c55e)
- Neutral: Cool slate

### E-commerce
- Primary: Action orange (#ea580c)
- Secondary: Trust blue (#3b82f6)
- Accent: Success green (#16a34a)
- Neutral: Warm grays

## Typography Pairings

| Heading | Body | Vibe |
|---------|------|------|
| Inter | Inter | Clean, modern, tech |
| Plus Jakarta Sans | Inter | Friendly, approachable |
| Poppins | Open Sans | Bold, playful |
| Fraunces | Source Sans Pro | Editorial, premium |
| Space Grotesk | DM Sans | Techy, startup |
| Playfair Display | Lora | Elegant, editorial |

## Accessibility Checklist

- [ ] Primary color on white: ≥4.5:1 contrast
- [ ] Text colors meet WCAG AA (4.5:1 normal, 3:1 large)
- [ ] Focus states visible and high contrast
- [ ] Error states distinguishable by more than color
- [ ] Interactive elements have hover/focus states
