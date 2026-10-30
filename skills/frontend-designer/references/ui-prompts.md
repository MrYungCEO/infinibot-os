# UI Component Prompts

Specialized prompts for generating each major UI component type with Gemini.

## Hero Section

```
Generate a hero section with:
- Full-width background (gradient: [COLOR1] to [COLOR2] or image)
- Centered content container (max-width 1200px)
- Main headline: large, bold, [HEADLINE_TEXT]
- Subheadline: muted color, [SUBHEADLINE_TEXT]
- CTA buttons: primary [PRIMARY_CTA] and secondary [SECONDARY_CTA]
- Optional: hero image/illustration on right side
- Responsive: stack vertically on mobile

Tech: [REACT/HTML] + Tailwind CSS
Style: [MODERN/MINIMAL/BOLD]
Include animations: fade-in on load, hover states on buttons
```

### Hero Variants

**Split Hero (50/50)**
```
Left side: headline, text, CTAs
Right side: product screenshot or illustration
Gap: 4rem between columns
Mobile: image above text
```

**Video Hero**
```
Background: looping video (muted, autoplay)
Overlay: dark gradient for text readability
Content: centered, white text
Fallback: static image for mobile/reduced motion
```

**Animated Hero**
```
Headline: typewriter effect or word rotation
Background: subtle particle animation or gradient shift
CTAs: scale on hover
Images: parallax scroll effect
```

## Navigation

```
Generate a sticky navigation bar with:
- Logo on left
- Nav links in center: [HOME, FEATURES, PRICING, ABOUT]
- CTA button on right: [GET STARTED]
- Mobile: hamburger menu with slide-out drawer
- Scroll behavior: add shadow on scroll, optional background blur
- Height: 64px desktop, 56px mobile

Tech: [REACT/HTML] + Tailwind CSS
Include: smooth scroll to sections, active link highlighting
```

### Navigation Variants

**Transparent → Solid**
```
Initial: transparent background, white text
On scroll: white background, dark text, shadow
Transition: 300ms ease
```

**Mega Menu**
```
Dropdown on hover/click
Grid layout with categories
Optional: featured content area
Close on click outside
```

## Feature Grid

```
Generate a feature section with:
- Section heading: [SECTION_TITLE]
- Subheading: [SECTION_DESCRIPTION]
- Grid: 3 columns desktop, 1 column mobile
- Each feature card:
  - Icon (use Lucide icons: [ICON_NAMES])
  - Title
  - Description (2-3 lines)
- Card style: [FLAT/BORDERED/SHADOWED]
- Hover effect: lift with shadow increase

Tech: [REACT/HTML] + Tailwind CSS
Animation: cards fade in on scroll (IntersectionObserver)
```

### Feature Layout Options

**Icon Left**
```
┌─────────────────────────────┐
│ [Icon] Title                │
│        Description text     │
└─────────────────────────────┘
```

**Icon Top (Centered)**
```
┌─────────────────────────────┐
│           [Icon]            │
│           Title             │
│     Description text        │
└─────────────────────────────┘
```

**Large Icon Background**
```
┌─────────────────────────────┐
│ ░░░░░░░░░░░░░░░ [BIG ICON]  │
│ Title                       │
│ Description text here       │
└─────────────────────────────┘
```

## Pricing Table

```
Generate a pricing section with:
- 3 pricing tiers: [BASIC, PRO, ENTERPRISE]
- Prices: [$X/mo, $Y/mo, CUSTOM]
- Highlight middle tier as "Most Popular"
- Features list for each tier (use checkmarks)
- CTA button per tier
- Optional: monthly/yearly toggle with discount badge

Layout: horizontal cards, equal height
Highlighted card: slightly raised, colored border, badge
Mobile: stack vertically

Tech: [REACT/HTML] + Tailwind CSS
```

### Pricing Prompt Variables

```
TIERS = [
  { name: "Starter", price: 9, features: ["5 projects", "Basic support"] },
  { name: "Pro", price: 29, popular: true, features: ["Unlimited projects", "Priority support", "API access"] },
  { name: "Enterprise", price: "Custom", features: ["Custom integrations", "Dedicated support", "SLA"] }
]
```

## Testimonials

```
Generate a testimonials section with:
- Section heading: "What our customers say"
- Layout: [CAROUSEL/GRID/SINGLE_FEATURED]
- Each testimonial:
  - Quote text
  - Author name
  - Author role/company
  - Avatar image (use placeholder)
  - Optional: star rating
- Card style: large quotes, subtle background

Carousel: auto-advance every 5s, dots navigation, swipe on mobile
Grid: 2-3 columns

Tech: [REACT/HTML] + Tailwind CSS
```

## Contact Form

```
Generate a contact form with:
- Fields: Name, Email, Subject (dropdown), Message (textarea)
- Validation: required fields, email format
- Submit button with loading state
- Success/error message display
- Layout: single column, labels above inputs

Input styling:
- Border: subtle, darker on focus
- Focus: ring effect (primary color)
- Error: red border, error message below

Tech: [REACT/HTML] + Tailwind CSS
Include: basic client-side validation
```

## Footer

```
Generate a footer with:
- Logo and tagline
- Link columns: Product, Company, Resources, Legal
- Social media icons: [TWITTER, GITHUB, LINKEDIN]
- Newsletter signup: email input + subscribe button
- Copyright line with year
- Background: dark (slate-900) or light gray

Layout: 4 columns desktop, 2 columns tablet, stacked mobile
Spacing: generous padding (py-16)

Tech: [REACT/HTML] + Tailwind CSS
```

## Cards

```
Generate a card component with variants:
1. Basic card: image, title, description, link
2. Product card: image, title, price, add to cart button
3. Blog card: image, category tag, title, excerpt, author, date
4. Profile card: avatar, name, role, bio, social links

Base styles:
- Rounded corners (lg)
- Subtle shadow
- Hover: shadow increase, slight lift
- Image: aspect-ratio preserved, cover fit

Tech: [REACT/HTML] + Tailwind CSS
```

## Modals / Dialogs

```
Generate a modal component with:
- Backdrop: dark overlay (50% opacity), click to close
- Modal container: centered, max-width 500px, white bg
- Header: title + close button (X icon)
- Body: scrollable if content overflows
- Footer: action buttons (Cancel, Confirm)
- Animation: fade in backdrop, scale up modal
- Focus trap: keep focus within modal
- ESC key to close

Tech: [REACT/HTML] + Tailwind CSS
Accessibility: role="dialog", aria-modal="true", focus management
```

## Stats / Metrics

```
Generate a stats section with:
- 4 key metrics in a row: [METRIC_NAME: VALUE]
- Large numbers with animated count-up
- Subtle icons or labels
- Layout: 4 columns desktop, 2x2 tablet, stacked mobile
- Optional: dividers between metrics

Style: centered text, large numbers, small labels
Animation: count up on scroll into view

Tech: [REACT/HTML] + Tailwind CSS
```

## CTA Banner

```
Generate a CTA banner with:
- Background: gradient or solid color
- Headline: [CTA_HEADLINE]
- Subtext: [CTA_SUBTEXT]
- Buttons: [PRIMARY_CTA] and optional secondary
- Layout: centered content or split (text left, buttons right)
- Full-width with contained content

Tech: [REACT/HTML] + Tailwind CSS
```

## FAQ Accordion

```
Generate an FAQ section with:
- Section heading: "Frequently Asked Questions"
- Accordion items: question + expandable answer
- Only one open at a time
- Plus/minus or chevron icon for toggle
- Smooth expand/collapse animation

Questions: [LIST_OF_QUESTIONS]

Tech: [REACT/HTML] + Tailwind CSS
Accessibility: aria-expanded, button triggers, proper focus
```
