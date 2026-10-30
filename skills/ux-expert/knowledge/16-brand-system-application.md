# 16 · Brand System Application

## Pattern: Tokenize everything brand-coupled
- **When**: Anywhere brand identity touches UI.
- **How**:
  - Tokens layered: primitive (`color.blue.500`) → semantic (`color.action.primary`) → component (`button.primary.bg`).
  - Components reference component tokens only.
  - Theme = swap semantic layer; primitives stay constant.
- **Source**: IBM Carbon tokens; Material 3 schemes.

## Pattern: Brand audit checklist (per audit)
- **When**: Auditing a product's brand fidelity.
- **How**:
  - Inventory the brand tokens declared in code (CSS vars / theme file).
  - Identify components that bypass them (raw hex, off-grid spacing).
  - Inventory illustration / icon set; flag mixed-source icons (lucide + heroicons + emoji = chaos).
  - Confirm font stack matches brand voice axis.
  - Check motion vocab (springy vs subtle) consistent with brand.
- **Source**: Polaris audit method; Atlassian theming.

## Pattern: One icon family per product
- **When**: Choosing icons.
- **How**:
  - Pick a single family (lucide / phosphor / heroicons / SF Symbols).
  - Same stroke width across the app (1.5 px is the common default).
  - Use filled vs outline to express STATE (active filled, idle outline) not preference.
- **Source**: Apple SF Symbols principles.

## Pattern: Brand accent restraint (rule of 10%)
- **When**: Applying brand color.
- **How**: Saturated brand on ≤10% of any viewport. The "premium" feel of Linear/Vercel comes from neutral surfaces + a precise accent.
- **Source**: Refactoring UI; observed in Linear, Vercel, Stripe.

## Pattern: Glass + brand = define a SCRIM
- **When**: Glass-morphism over media (FlyPic case).
- **How**:
  - Behind glass surfaces, place a scrim gradient that guarantees worst-case contrast.
  - Define brand tokens for `glass.surface`, `glass.border`, `glass.scrim` separately from solid surfaces.
- **Source**: Apple HIG materials; Vision Pro.

## Pattern: Theming as data, not branching
- **When**: Light/dark/custom themes.
- **How**:
  - Every theme = a JSON token file.
  - One root `<html data-theme="dark">` swap.
  - No `if (theme === 'dark')` branches in components.
- **Source**: Radix Themes; shadcn/ui.

## Pattern: Asset pipeline matches brand grid
- **When**: Generating illustrations / hero art.
- **How**: Match the product's grid + corner-radius vocabulary. Round corners on cards → round corners in illustrations. Flat product UI ≠ photorealistic hero.
- **Source**: Stripe Press; Linear's visual system.

## Anti-pattern checklist
- Marketing site uses Inter; product UI uses SF Pro → different brand feel.
- Mixed icon sets in the same view (lucide + emoji + custom SVG).
- Brand gradient applied to 5+ component types at once.
- Glass panels in product, hard-shadow cards on marketing → identity split.
- Dark-mode brand color = same hex as light, looking muddy.

## Audit prompt for vision
> "List every distinct color, font, icon family, corner-radius, and motion duration visible. Flag any inconsistency vs the declared brand tokens at: `<paste tokens file or summary>`."
