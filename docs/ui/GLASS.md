# InfiniBot Glass design system

The control UI's premium black-gold glass layer. It covers the app shell (top
bar, sidebar, page frame, ambient background), the chat surfaces and a set of
reusable primitives that any page can use.

| File | What it holds |
|---|---|
| `ui/src/styles/glass/tokens.css` | `--glass-*` tokens, the light theme, the HUD theme, reduced transparency, reduced motion and perf mode |
| `ui/src/styles/glass/primitives.css` | `.g-*` classes |
| `ui/src/styles/glass/shell.css` | Ambient background, top bar, sidebar rail and page frame |
| `ui/src/styles/glass/chat.css` | Light-DOM chat bubbles, tool cards and composer |
| `ui/src/ui/theme-glass.ts` | Mounts the `.glass-ambient` layer (gold orbs, grain and vignette) |

The shadow-DOM chats carry the same recipe in their own static styles: `views/webchat.ts`, `components/agent-chat-modal.ts` (the right-hand chat dock) and `views/masonry-grid.ts` (the grid chat panels). Each of those blocks is marked `Premium glass layer`.

## Ground rules

- **Additive only.** Every older token still works: `--g-*`, `--bg`, `--text`, `--gold`, `--accent`, `--card`, `--border` and so on. Nothing was renamed or removed. A page that uses only the old tokens keeps working, and moves to glass when it adopts the new tokens.
- **Use tokens, not literals.** The glass tokens follow the theme (dark, light or HUD), the palette (Appearance page), `prefers-reduced-transparency`, `prefers-reduced-motion` and `:root.perf-mode`. A hard-coded `rgba(0,0,0,.4)` follows none of those, and it shows up grey in light mode.
- **Shadow DOM is fine.** Custom properties pierce shadow roots, so Lit components can read `var(--glass-…)` directly. To vary by theme inside a component, use `:host-context([data-theme="light"])`.
- **Blur budget.** Use at most one `backdrop-filter` per stacked surface. Panels and rails blur. Cards, rows and buttons that sit on them do not; `.g-card` deliberately has no blur. Several stacked blurs are the main GPU cost on low-end machines.

## Tokens

### Surfaces (frosted tiers, thin to thick)

| Token | Use |
|---|---|
| `--glass-1` | Rails and the page frame |
| `--glass-2` | Panels, the top bar and the composer |
| `--glass-3` | Cards and chat bubbles |
| `--glass-4` | Menus, popovers, modals and docks |
| `--glass-solid` | Opaque fallback, used automatically when reduced transparency is on |
| `--glass-base` | Page base colour, behind everything |
| `--glass-sheen` | Specular top-light gradient; layer it first: `background: var(--glass-sheen), var(--glass-2)` |
| `--glass-tint` | Faint gold wash for hero panels |
| `--glass-hover` / `--glass-press` | Interactive fills |

### Edges and depth

| Token | Use |
|---|---|
| `--glass-stroke`, `--glass-stroke-strong` | Hairline borders |
| `--glass-stroke-gold` | Gold hairline for hover and emphasis |
| `--glass-edge` | Gradient border from gold to transparent (see `.g-panel` / `.g-edge`) |
| `--glass-edge-soft` | Neutral gradient border |
| `--glass-specular`, `--glass-inner-shade` | Inset top highlight and bottom shade |
| `--glass-elev-1` … `--glass-elev-4` | Elevation scale: rail < panel/top bar < card/stat < modal/toast |
| `--glass-glow`, `--glass-glow-soft` | Gold glow |
| `--glass-focus-ring` | The single focus ring. Use it for every `:focus-visible` |

### Brand

`--glass-gold`, `--glass-gold-hi`, `--glass-gold-deep`, `--glass-gold-a06/a10/a16/a24/a40` (alpha steps), `--glass-gold-fill` (solid metallic gold for primary buttons), `--glass-gold-tint` (dark gold glass for user bubbles and selected states) and `--glass-ink` (text on solid gold).

### Text

`--glass-fg` (primary), then `--glass-fg-2`, `--glass-fg-3` and `--glass-fg-4` for secondary, tertiary and placeholder or disabled text.

### Type, spacing, radius and motion

| Group | Tokens |
|---|---|
| Fonts | `--font-ui` / `--glass-font` (Inter / SF Pro), `--font-ui-display`, `--glass-font-mono` (JetBrains Mono, for code and the brand) |
| Text sizes | `--glass-text-xs` … `--glass-text-xl` |
| Tracking | `--glass-tracking-tight`, `--glass-tracking-caps` |
| Spacing (4pt grid) | `--glass-space-1` … `--glass-space-8` |
| Radius | `--glass-radius-xs` (7px), `--glass-radius-sm` (10px), `--glass-radius` (14px), `--glass-radius-lg` (20px), `--glass-radius-xl` (26px), `--glass-radius-pill` |
| Motion | `--glass-spring` (overshoot), `--glass-ease`, `--glass-dur-fast` / `--glass-dur` / `--glass-dur-slow`, `--glass-lift` |
| Blur | `--glass-blur-sm`, `--glass-blur`, `--glass-blur-lg` |
| Ambient | `--glass-noise` and `--glass-noise-opacity` (film grain), `--glass-orb-1..3` and `--glass-ambient-opacity` |

Under reduced motion, every duration becomes `0ms` and `--glass-lift` becomes `none`. Under reduced transparency, every surface becomes `--glass-solid` and the blur is turned off.

## Primitives

```html
<section class="g-panel">
  <h3 class="g-section-head">Usage <span class="g-section-head__count">12</span></h3>
  <div class="g-card g-card--interactive">…</div>
  <input class="g-input" placeholder="Search" />
  <button class="g-btn g-btn--primary">Save</button>
  <button class="g-btn">Cancel</button>
  <button class="g-btn g-btn--ghost g-btn--icon" aria-label="More">…</button>
  <span class="g-chip g-chip--ok"><i class="g-chip__dot"></i> Live</span>
  <table class="g-table">…<td class="g-num">$4,820.00</td>…</table>
</section>
```

| Class | What it is |
|---|---|
| `.g-glass` | Plain frosted surface with a neutral gradient edge |
| `.g-panel` | Hero panel: frosted, gold gradient edge, `elev-2`, 20px padding |
| `.g-card` | Card on a panel, with no blur. Add `.g-card--interactive` for spring lift and gold edge on hover |
| `.g-float` | Popover, menu or modal surface |
| `.g-edge` / `.g-edge--gold` | Adds only the gradient hairline border to any element |
| `.g-noise` | Film-grain overlay. Use it on one or two hero surfaces per screen |
| `.g-section-head` | Caps eyebrow followed by a gold hairline. `.g-section-head__count` holds a tabular count |
| `.g-title` | Display heading |
| `.g-btn` | Glass button. Modifiers: `--primary` (metallic gold), `--ghost`, `--danger`, `--sm`, `--icon` |
| `.g-input` | Recessed input or textarea with the gold focus ring |
| `.g-chip` | Pill. Modifiers: `--gold`, `--ok`, `--warn`, `--danger`. Use `.g-chip__dot` for a status LED |
| `.g-table` | Glass table with tabular numbers and a gold row hover. `.g-num` right-aligns a cell |
| `.g-divider`, `.g-kbd`, `.g-num` / `.g-tabular`, `.g-text-gold` | Small parts |
| `.g-scroll-fade` | Scroll container whose top and bottom edges fade out |
| `.g-shimmer` / `.g-skeleton` | Streaming text shimmer and loading block |

`.g-glass`, `.g-card`, `.g-panel` and `.g-edge` draw their border on `::before`. If an element already uses `::before`, wrap it instead.

## Theming notes

- **Light mode with a dark palette.** The dark palettes (InfiniBot Gold, Noir, Aurora, Ember, Forest) write their `bg`, `fg` and surface tokens inline on `:root`. That used to beat every light-theme rule, so light mode showed white text on a light page. `tokens.css` now re-points those neutral tokens with `!important` when `data-theme="light"` and the palette is dark-native. The InfiniBot Gold palette also switches to a deeper antique gold (`#b7820f`) so text stays readable on porcelain. Light-native palettes such as Porcelain are left alone.
- **Page base colour.** When an animated background is selected, `html` and `body` are transparent. The glass layer paints `--glass-base` on `html`, and effects still draw on top of it.
- **Ambient layer.** `.glass-ambient` holds three slow gold orbs, film grain and a vignette at z-index −2. It shows for the Ambient Grid, Gradient and None backgrounds. With a WebGL background the orbs hide so the two never compete; the grain stays.

## Adopting glass on a page

1. Replace literal colours with tokens. For example, `rgba(0,0,0,.4)` becomes `var(--glass-2)` and `#fff` becomes `var(--glass-fg)`.
2. Wrap the page's main sections in `.g-panel`, and use `.g-card` for the items inside them.
3. Swap buttons and inputs for `.g-btn` / `.g-input`, or point their existing rules at the tokens.
4. Check dark, light and 390px widths.
