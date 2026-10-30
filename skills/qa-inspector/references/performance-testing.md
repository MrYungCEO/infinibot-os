# Performance Testing Reference

## Core Web Vitals (Google)

| Metric | Good | Needs Improvement | Poor |
|--------|------|-------------------|------|
| **LCP** (Largest Contentful Paint) | ≤2.5s | 2.5s–4.0s | >4.0s |
| **INP** (Interaction to Next Paint) | ≤200ms | 200ms–500ms | >500ms |
| **CLS** (Cumulative Layout Shift) | ≤0.1 | 0.1–0.25 | >0.25 |

### LCP (Largest Contentful Paint)
**What:** Time until the largest content element is visible
**Target:** ≤2.5 seconds

**Common issues:**
- Unoptimized hero images
- Render-blocking CSS/JS
- Slow server response (TTFB)
- Client-side rendering delay

**Fixes:**
- Preload LCP image: `<link rel="preload" as="image" href="hero.jpg">`
- Optimize images (WebP, proper sizing)
- Inline critical CSS
- Use CDN

### INP (Interaction to Next Paint)
**What:** Responsiveness to user input
**Target:** ≤200ms

**Common issues:**
- Long JavaScript tasks
- Heavy event handlers
- Main thread blocking

**Fixes:**
- Code split / lazy load
- Use web workers for heavy computation
- Debounce input handlers
- Use `requestAnimationFrame` for visual updates

### CLS (Cumulative Layout Shift)
**What:** Visual stability (unexpected movement)
**Target:** ≤0.1

**Common issues:**
- Images without dimensions
- Dynamically injected content
- Web fonts causing FOUT/FOIT
- Ads or embeds without reserved space

**Fixes:**
- Always set width/height on images and videos
- Reserve space for dynamic content
- Use `font-display: optional` or preload fonts
- Reserve space for ads

---

## Lighthouse Scoring

### Scores
| Score | Rating |
|-------|--------|
| 90–100 | Good (green) |
| 50–89 | Needs Improvement (orange) |
| 0–49 | Poor (red) |

### Running Lighthouse

**Chrome DevTools:**
```
F12 → Lighthouse tab → Select categories → Analyze
```

**CLI:**
```bash
# Install
npm install -g lighthouse

# Run
lighthouse https://example.com --output html --output-path ./report.html

# Mobile simulation
lighthouse https://example.com --preset=desktop

# Specific categories
lighthouse https://example.com --only-categories=performance,accessibility
```

**CI/CD:**
```bash
# With Lighthouse CI
npm install -g @lhci/cli
lhci autorun
```

---

## Performance Budget

### Recommended Limits

| Resource | Target | Max |
|----------|--------|-----|
| **Total Page Size** | <1MB | <3MB |
| **JavaScript** | <200KB | <400KB |
| **CSS** | <50KB | <100KB |
| **Images** | <500KB | <1MB |
| **Fonts** | <100KB | <200KB |
| **HTTP Requests** | <30 | <50 |
| **Time to Interactive** | <3.8s | <5s |

### Check in DevTools
```
F12 → Network → Refresh
- Look at total size at bottom
- Filter by type (JS, CSS, Img)
- Check waterfall for blocking
```

---

## Network Throttling Tests

### Chrome DevTools Presets
| Preset | Down | Up | Latency |
|--------|------|----|---------| 
| Fast 3G | 1.5Mbps | 750Kbps | 40ms |
| Slow 3G | 500Kbps | 500Kbps | 400ms |
| Offline | 0 | 0 | 0 |

**How to test:**
```
F12 → Network tab → Throttling dropdown → Select preset
```

### Test scenarios
```
□ Fast 3G — Still usable?
□ Slow 3G — Loading states show?
□ Offline — Graceful error?
□ Lie-Fi — Timeouts handled?
```

---

## Image Optimization Checks

### Format Selection
| Format | Use Case |
|--------|----------|
| WebP | Photos, complex images (85%+ smaller than JPEG) |
| AVIF | Best compression, limited browser support |
| SVG | Icons, logos, simple graphics |
| PNG | Transparency needed, simple graphics |
| JPEG | Legacy fallback |

### Responsive Images
```html
<!-- Modern approach -->
<picture>
  <source srcset="hero.avif" type="image/avif">
  <source srcset="hero.webp" type="image/webp">
  <img src="hero.jpg" alt="..." width="1200" height="600" loading="lazy">
</picture>

<!-- Responsive sizing -->
<img 
  srcset="hero-400.jpg 400w,
          hero-800.jpg 800w,
          hero-1200.jpg 1200w"
  sizes="(max-width: 600px) 400px,
         (max-width: 1000px) 800px,
         1200px"
  src="hero-1200.jpg"
  alt="..."
>
```

### Checklist
```
□ Images are in WebP/AVIF format
□ Images sized appropriately (not 4000px for a 400px slot)
□ Responsive images for different viewports
□ Lazy loading for below-fold images
□ Width/height attributes set (prevent CLS)
□ Alt text present
```

---

## JavaScript Performance

### Bundle Analysis
```bash
# Webpack bundle analyzer
npm install -D webpack-bundle-analyzer
npx webpack-bundle-analyzer stats.json

# Source map explorer
npm install -D source-map-explorer
npx source-map-explorer dist/bundle.js
```

### Common Issues
```
□ Large bundle size (>200KB)
□ Unused code (tree shaking failed)
□ Duplicate dependencies
□ No code splitting
□ Synchronous third-party scripts
```

### Solutions
- Dynamic imports: `import('./module.js')`
- Tree shaking: ES modules, sideEffects: false
- Compression: gzip/brotli
- Defer/async scripts
- Remove unused dependencies

---

## CSS Performance

### Common Issues
```
□ Unused CSS (check Coverage in DevTools)
□ Render-blocking stylesheets
□ Large CSS file (>50KB)
□ Too many fonts/weights
□ Complex selectors
```

### Solutions
- PurgeCSS to remove unused styles
- Critical CSS inline in `<head>`
- Preload important stylesheets
- Subset fonts (only needed characters)
- CSS containment for complex layouts

### Check CSS Coverage
```
F12 → More tools → Coverage → Reload → Click CSS files
Red = unused, Green = used
```

---

## Server Performance

### TTFB (Time to First Byte)
**Target:** <200ms

**Check:**
```
F12 → Network → First document → Timing tab → Waiting (TTFB)
```

**If slow:**
- Check server response time
- Use CDN
- Implement caching
- Optimize database queries

### Caching Headers
```
□ Cache-Control headers present
□ Long max-age for static assets
□ ETag or Last-Modified for validation
□ Immutable for versioned assets
```

---

## Performance Testing Commands

### Quick Lighthouse
```bash
npx lighthouse https://example.com --output json | jq '.categories.performance.score'
```

### WebPageTest API
```bash
curl "https://www.webpagetest.org/runtest.php?url=https://example.com&k=YOUR_KEY&f=json"
```

### Core Web Vitals in Console
```javascript
// Paste in console to see CWV
new PerformanceObserver((l) => {
  l.getEntries().forEach((entry) => {
    console.log(entry.name, entry.value);
  });
}).observe({type: 'largest-contentful-paint', buffered: true});
```

### Network requests count
```javascript
performance.getEntriesByType('resource').length
```

### Total transfer size
```javascript
const resources = performance.getEntriesByType('resource');
const total = resources.reduce((sum, r) => sum + r.transferSize, 0);
console.log((total / 1024 / 1024).toFixed(2) + ' MB');
```
