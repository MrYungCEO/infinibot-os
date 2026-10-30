# Elite Web Design Skill

> High-end UI/UX patterns for professional, non-generic interfaces

## When to Use This Skill

- Building landing pages, dashboards, or web applications
- Upgrading "AI-generated looking" UIs
- Creating premium brand experiences
- Implementing design systems from scratch

## Anti-Generic Checklist

Before finalizing ANY design, verify:

- [ ] Hero section is NOT centered text + CTA + illustration
- [ ] Cards have varied sizes or unique layouts
- [ ] Colors are NOT default blue/purple gradient
- [ ] Navigation has personality beyond standard patterns
- [ ] Forms use progressive disclosure or inline validation
- [ ] Animations have spring physics, not linear
- [ ] Spacing creates intentional tension, not uniform gaps
- [ ] Typography has clear hierarchy with scale contrast
- [ ] Dark mode has depth, not just inverted colors
- [ ] Mobile is redesigned, not just reflowed

---

## Component Library — Premium Patterns

### 1. Hero Section Variants

#### Split Hero (60/40)
```html
<section class="hero-split">
  <div class="hero-content">
    <span class="hero-eyebrow">Now in Beta</span>
    <h1 class="hero-title">
      Ship products<br>
      <span class="gradient-text">10x faster</span>
    </h1>
    <p class="hero-description">
      The modern development platform that scales with your ambition.
    </p>
    <div class="hero-actions">
      <button class="btn-primary">Start Building</button>
      <button class="btn-ghost">Watch Demo →</button>
    </div>
  </div>
  <div class="hero-visual">
    <!-- 3D render, video, or interactive element -->
  </div>
</section>
```

```css
.hero-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-16);
  min-height: 90vh;
  align-items: center;
  padding: var(--space-24) var(--space-16);
}

.hero-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  background: rgba(var(--accent-rgb), 0.1);
  border: 1px solid rgba(var(--accent-rgb), 0.2);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.hero-title {
  font-size: clamp(3rem, 8vw, 5rem);
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.03em;
  margin-top: var(--space-4);
}

.gradient-text {
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-description {
  font-size: var(--text-lg);
  color: var(--text-secondary);
  max-width: 480px;
  margin-top: var(--space-6);
  line-height: 1.6;
}

.hero-actions {
  display: flex;
  gap: var(--space-4);
  margin-top: var(--space-8);
}

@media (max-width: 1024px) {
  .hero-split {
    grid-template-columns: 1fr;
    text-align: center;
  }
  
  .hero-description {
    margin-inline: auto;
  }
  
  .hero-actions {
    justify-content: center;
  }
  
  .hero-visual {
    order: -1;
  }
}
```

#### Immersive Hero (Full Viewport)
```html
<section class="hero-immersive">
  <div class="hero-bg">
    <video autoplay muted loop playsinline>
      <source src="hero-bg.mp4" type="video/mp4">
    </video>
    <div class="hero-overlay"></div>
  </div>
  
  <div class="hero-content">
    <h1 class="hero-title">
      Beyond the<br>
      <em>Ordinary</em>
    </h1>
    
    <div class="scroll-indicator">
      <span>Scroll to explore</span>
      <div class="scroll-line"></div>
    </div>
  </div>
</section>
```

```css
.hero-immersive {
  position: relative;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.hero-bg {
  position: absolute;
  inset: 0;
  z-index: -1;
}

.hero-bg video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.3) 0%,
    rgba(0, 0, 0, 0.6) 100%
  );
}

.hero-title {
  font-size: clamp(4rem, 12vw, 10rem);
  font-weight: 300;
  text-align: center;
  letter-spacing: -0.04em;
  line-height: 1;
}

.hero-title em {
  font-style: italic;
  font-weight: 400;
}

.scroll-indicator {
  position: absolute;
  bottom: var(--space-8);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  opacity: 0.6;
}

.scroll-indicator span {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.scroll-line {
  width: 1px;
  height: 60px;
  background: linear-gradient(
    to bottom,
    currentColor 0%,
    transparent 100%
  );
  animation: scroll-pulse 2s ease-in-out infinite;
}

@keyframes scroll-pulse {
  0%, 100% { opacity: 0.3; transform: scaleY(1); }
  50% { opacity: 1; transform: scaleY(1.2); }
}
```

---

### 2. Card System — Breaking the Grid

#### Bento Grid
```html
<div class="bento-grid">
  <div class="bento-card bento-large">
    <div class="bento-icon">⚡</div>
    <h3>Lightning Fast</h3>
    <p>Sub-millisecond response times globally.</p>
  </div>
  
  <div class="bento-card bento-tall">
    <div class="bento-visual">
      <img src="feature-visual.png" alt="">
    </div>
    <h3>Beautiful by Default</h3>
  </div>
  
  <div class="bento-card">
    <h3>99.99%</h3>
    <p>Uptime guaranteed</p>
  </div>
  
  <div class="bento-card">
    <h3>150+</h3>
    <p>Edge locations</p>
  </div>
  
  <div class="bento-card bento-wide">
    <div class="bento-code">
      <code>npm install @acme/sdk</code>
    </div>
    <p>Get started in seconds</p>
  </div>
</div>
```

```css
.bento-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: minmax(180px, auto);
  gap: var(--space-4);
  padding: var(--space-16) var(--space-8);
}

.bento-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.bento-card:hover {
  transform: translateY(-4px);
  border-color: var(--border-hover);
  box-shadow: var(--shadow-lg);
}

.bento-large {
  grid-column: span 2;
  grid-row: span 2;
}

.bento-tall {
  grid-row: span 2;
}

.bento-wide {
  grid-column: span 2;
}

.bento-icon {
  font-size: 3rem;
  margin-bottom: var(--space-4);
}

.bento-card h3 {
  font-size: var(--text-xl);
  font-weight: 600;
  margin-bottom: var(--space-2);
}

.bento-card p {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.bento-visual {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-4);
}

.bento-visual img {
  max-width: 100%;
  max-height: 200px;
  object-fit: contain;
}

.bento-code {
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}

.bento-code code {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--accent);
}

@media (max-width: 1024px) {
  .bento-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .bento-grid {
    grid-template-columns: 1fr;
  }
  
  .bento-large,
  .bento-wide {
    grid-column: span 1;
  }
}
```

---

### 3. Navigation — Beyond the Basics

#### Reveal Navigation
```html
<header class="nav-reveal" data-scrolled="false">
  <nav class="nav-container">
    <a href="/" class="nav-logo">
      <svg><!-- Logo SVG --></svg>
    </a>
    
    <div class="nav-links">
      <a href="/features">Features</a>
      <a href="/pricing">Pricing</a>
      <a href="/docs">Documentation</a>
      <a href="/blog">Blog</a>
    </div>
    
    <div class="nav-actions">
      <button class="btn-ghost">Sign In</button>
      <button class="btn-primary">Get Started</button>
    </div>
    
    <button class="nav-toggle" aria-label="Menu">
      <span></span>
      <span></span>
    </button>
  </nav>
</header>
```

```css
.nav-reveal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  padding: var(--space-4) var(--space-8);
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.nav-reveal[data-scrolled="false"] {
  background: transparent;
}

.nav-reveal[data-scrolled="true"] {
  background: rgba(var(--bg-rgb), 0.8);
  backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--border-subtle);
  padding: var(--space-3) var(--space-8);
}

.nav-container {
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.nav-logo {
  display: flex;
  align-items: center;
}

.nav-logo svg {
  height: 32px;
  width: auto;
}

.nav-links {
  display: flex;
  gap: var(--space-1);
}

.nav-links a {
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-secondary);
  border-radius: var(--radius-md);
  transition: all 0.2s;
}

.nav-links a:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.nav-actions {
  display: flex;
  gap: var(--space-3);
}

.nav-toggle {
  display: none;
  flex-direction: column;
  gap: 6px;
  padding: var(--space-2);
  background: none;
  border: none;
  cursor: pointer;
}

.nav-toggle span {
  width: 24px;
  height: 2px;
  background: var(--text-primary);
  border-radius: 2px;
  transition: all 0.3s;
}

@media (max-width: 1024px) {
  .nav-links,
  .nav-actions {
    display: none;
  }
  
  .nav-toggle {
    display: flex;
  }
}
```

```javascript
// Scroll detection for nav reveal
const nav = document.querySelector('.nav-reveal');
let lastScroll = 0;

window.addEventListener('scroll', () => {
  const currentScroll = window.scrollY;
  
  nav.dataset.scrolled = currentScroll > 50 ? 'true' : 'false';
  
  if (currentScroll > lastScroll && currentScroll > 400) {
    nav.style.transform = 'translateY(-100%)';
  } else {
    nav.style.transform = 'translateY(0)';
  }
  
  lastScroll = currentScroll;
}, { passive: true });
```

---

### 4. Buttons — Premium Feel

```css
/* Button System */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-6);
  font-size: var(--text-sm);
  font-weight: 500;
  border-radius: var(--radius-md);
  border: none;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

/* Primary Button */
.btn-primary {
  background: var(--accent);
  color: var(--accent-contrast);
  box-shadow: 
    0 1px 2px rgba(0, 0, 0, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 
    0 4px 12px rgba(var(--accent-rgb), 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.btn-primary:active {
  transform: translateY(0);
}

/* Ghost Button */
.btn-ghost {
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border-subtle);
}

.btn-ghost:hover {
  background: var(--bg-hover);
  border-color: var(--border-hover);
}

/* Icon Button */
.btn-icon {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.btn-icon:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* Loading State */
.btn.loading {
  pointer-events: none;
  color: transparent;
}

.btn.loading::after {
  content: '';
  position: absolute;
  width: 18px;
  height: 18px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Shine Effect */
.btn-shine::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.2),
    transparent
  );
  transition: left 0.5s;
}

.btn-shine:hover::before {
  left: 100%;
}
```

---

### 5. Form Elements — Progressive & Polished

```html
<div class="input-group">
  <input 
    type="email" 
    id="email" 
    class="input-field"
    placeholder=" "
    required
  >
  <label for="email" class="input-label">Email address</label>
  <span class="input-highlight"></span>
  <span class="input-error">Please enter a valid email</span>
</div>
```

```css
.input-group {
  position: relative;
  margin-bottom: var(--space-6);
}

.input-field {
  width: 100%;
  padding: var(--space-4) var(--space-4);
  padding-top: var(--space-6);
  font-size: var(--text-base);
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  color: var(--text-primary);
  transition: all 0.2s;
}

.input-field:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.1);
}

.input-label {
  position: absolute;
  left: var(--space-4);
  top: 50%;
  transform: translateY(-50%);
  font-size: var(--text-base);
  color: var(--text-tertiary);
  pointer-events: none;
  transition: all 0.2s;
}

.input-field:focus + .input-label,
.input-field:not(:placeholder-shown) + .input-label {
  top: var(--space-3);
  transform: translateY(0);
  font-size: var(--text-xs);
  color: var(--accent);
}

.input-highlight {
  position: absolute;
  bottom: 0;
  left: 50%;
  width: 0;
  height: 2px;
  background: var(--accent);
  transition: all 0.3s;
}

.input-field:focus ~ .input-highlight {
  left: 0;
  width: 100%;
}

.input-error {
  display: none;
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--error);
}

.input-group.error .input-field {
  border-color: var(--error);
}

.input-group.error .input-error {
  display: block;
}
```

---

### 6. Dark Mode — Depth, Not Inversion

```css
:root {
  /* Light Mode */
  --bg-primary: #ffffff;
  --bg-secondary: #f9fafb;
  --bg-tertiary: #f3f4f6;
  --bg-hover: rgba(0, 0, 0, 0.04);
  
  --text-primary: #111827;
  --text-secondary: #6b7280;
  --text-tertiary: #9ca3af;
  
  --border-subtle: rgba(0, 0, 0, 0.08);
  --border-hover: rgba(0, 0, 0, 0.15);
  
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
}

[data-theme="dark"] {
  /* Dark Mode — NOT just inverted */
  --bg-primary: #0a0a0b;
  --bg-secondary: #141415;
  --bg-tertiary: #1e1e20;
  --bg-hover: rgba(255, 255, 255, 0.04);
  
  --text-primary: #fafafa;
  --text-secondary: #a1a1aa;
  --text-tertiary: #71717a;
  
  --border-subtle: rgba(255, 255, 255, 0.08);
  --border-hover: rgba(255, 255, 255, 0.15);
  
  /* Shadows become glows in dark mode */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.5);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.6);
  
  /* Subtle noise texture for depth */
  --noise-opacity: 0.015;
}

/* Add noise texture for depth */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
  opacity: var(--noise-opacity, 0);
  pointer-events: none;
  z-index: 9999;
}
```

---

### 7. Scroll Animations — Purposeful Motion

```javascript
// Intersection Observer for scroll reveals
const observerOptions = {
  root: null,
  rootMargin: '0px',
  threshold: 0.1
};

const revealOnScroll = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('revealed');
      // Optional: unobserve after reveal
      // revealOnScroll.unobserve(entry.target);
    }
  });
}, observerOptions);

// Observe all elements with reveal class
document.querySelectorAll('.reveal').forEach(el => {
  revealOnScroll.observe(el);
});
```

```css
/* Base reveal state */
.reveal {
  opacity: 0;
  transform: translateY(30px);
  transition: 
    opacity 0.6s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

.reveal.revealed {
  opacity: 1;
  transform: translateY(0);
}

/* Staggered reveals */
.reveal-stagger > .reveal:nth-child(1) { transition-delay: 0ms; }
.reveal-stagger > .reveal:nth-child(2) { transition-delay: 100ms; }
.reveal-stagger > .reveal:nth-child(3) { transition-delay: 200ms; }
.reveal-stagger > .reveal:nth-child(4) { transition-delay: 300ms; }
.reveal-stagger > .reveal:nth-child(5) { transition-delay: 400ms; }

/* Reveal from different directions */
.reveal-left {
  transform: translateX(-30px);
}

.reveal-right {
  transform: translateX(30px);
}

.reveal-scale {
  transform: scale(0.95);
}

.revealed.reveal-left,
.revealed.reveal-right {
  transform: translateX(0);
}

.revealed.reveal-scale {
  transform: scale(1);
}

/* Respect reduced motion */
@media (prefers-reduced-motion: reduce) {
  .reveal {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
```

---

## Design Tokens Template

```css
:root {
  /* ═══════════════════════════════════════════════════════════
     SPACING — 8px base
     ═══════════════════════════════════════════════════════════ */
  --space-0: 0;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
  --space-20: 80px;
  --space-24: 96px;
  --space-32: 128px;
  
  /* ═══════════════════════════════════════════════════════════
     TYPOGRAPHY
     ═══════════════════════════════════════════════════════════ */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-display: 'Satoshi', var(--font-sans);
  --font-mono: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
  
  --text-xs: 0.75rem;      /* 12px */
  --text-sm: 0.875rem;     /* 14px */
  --text-base: 1rem;       /* 16px */
  --text-lg: 1.125rem;     /* 18px */
  --text-xl: 1.25rem;      /* 20px */
  --text-2xl: 1.5rem;      /* 24px */
  --text-3xl: 1.875rem;    /* 30px */
  --text-4xl: 2.25rem;     /* 36px */
  --text-5xl: 3rem;        /* 48px */
  --text-6xl: 3.75rem;     /* 60px */
  --text-7xl: 4.5rem;      /* 72px */
  
  --leading-tight: 1.1;
  --leading-snug: 1.3;
  --leading-normal: 1.5;
  --leading-relaxed: 1.7;
  
  --tracking-tight: -0.03em;
  --tracking-normal: 0;
  --tracking-wide: 0.05em;
  
  /* ═══════════════════════════════════════════════════════════
     RADIUS
     ═══════════════════════════════════════════════════════════ */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xl: 24px;
  --radius-full: 9999px;
  
  /* ═══════════════════════════════════════════════════════════
     TRANSITIONS
     ═══════════════════════════════════════════════════════════ */
  --ease-out: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-in-out: cubic-bezier(0.4, 0, 0.4, 1);
  --ease-spring: cubic-bezier(0.175, 0.885, 0.32, 1.275);
  
  --duration-fast: 150ms;
  --duration-normal: 250ms;
  --duration-slow: 400ms;
  
  /* ═══════════════════════════════════════════════════════════
     Z-INDEX
     ═══════════════════════════════════════════════════════════ */
  --z-dropdown: 50;
  --z-sticky: 60;
  --z-fixed: 70;
  --z-modal-backdrop: 80;
  --z-modal: 90;
  --z-toast: 100;
  --z-tooltip: 110;
}
```

---

## Quick Reference — Avoid These

| ❌ Generic Pattern | ✅ Premium Alternative |
|-------------------|----------------------|
| Centered hero with stock illustration | Split layout, real imagery, asymmetry |
| Purple-pink gradient | Subtle monochromatic depth, accent sparingly |
| Equal padding everywhere | Intentional whitespace, breathing room |
| 14px body text | 16-18px minimum for readability |
| Boring hover states | Micro-interactions, transform + shadow |
| Cookie-cutter cards | Bento grids, varied sizes, broken layouts |
| Linear animations | Spring physics, cubic-bezier easing |
| Template navigation | Creative reveals, contextual nav |
| Basic forms | Floating labels, inline validation |
| Dark mode = invert | Layered depth, subtle noise, glows |

---

## Implementation Checklist

Before shipping:

1. [ ] Lighthouse accessibility score > 90
2. [ ] All focus states visible and styled
3. [ ] Animations respect `prefers-reduced-motion`
4. [ ] Touch targets minimum 44x44px on mobile
5. [ ] Color contrast passes WCAG AA
6. [ ] No layout shift on interaction
7. [ ] Critical CSS inlined, rest deferred
8. [ ] Images have width/height to prevent CLS
9. [ ] Custom fonts have fallback + font-display: swap
10. [ ] Dark mode tested across all components
