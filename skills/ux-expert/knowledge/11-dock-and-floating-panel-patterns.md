# 11 · Dock & Floating Panel Patterns

## Pattern: Command palette (cmd/ctrl-K)
- **When**: Apps with >10 actions or >50 navigable items.
- **How**:
  - Modal centered, ~640 px wide, 60–70% viewport height max.
  - Fuzzy match across actions + entities + recents.
  - Grouped sections with icons; ↑↓ keyboard, ↵ to invoke, Esc to dismiss.
  - Surface keyboard shortcut for each match in the right gutter.
  - Open in ≤80 ms; index lazily.
- **Source**: Linear, Raycast, GitHub palette.
- **Anti-patterns**: Cmd-K opens an empty list waiting for the user to type a perfect query.

## Pattern: Floating dock (toolbar pill)
- **When**: Creative tools (canvas, editor) needing persistent quick actions.
- **How**:
  - Pill-shaped container, glass / surface-elevated background.
  - 5–9 icon buttons max; divider groups by function.
  - Tooltip on hover after 400 ms delay; keyboard shortcut suffix in tooltip.
  - Anchored bottom-center (canvas tools) or right-center (inspector).
  - Auto-hide on print/full-screen; never block primary content.
- **Source**: Figma toolbar; tldraw dock.
- **Anti-patterns**: 14-icon dock with no labels; dock overlapping the active artboard.

## Pattern: Side panel (drawer / inspector)
- **When**: Selecting an object reveals editable properties.
- **How**:
  - Width 320–400 px desktop; collapse to bottom-sheet on mobile.
  - Sticky header with title + close (× upper-right, 44×44 target).
  - Tabs INSIDE the panel for related modes (Properties / History / Comments).
  - Persist open/closed in URL or localStorage.
  - Resizable handle on the inner edge.
- **Source**: Figma inspector; VS Code.

## Pattern: Floating action button (FAB)
- **When**: A single dominant create action on mobile / canvas.
- **How**: Bottom-right, 56 dp; 16 dp safe margin from edges; respects keyboard inset; never more than ONE FAB per surface.
- **Source**: Material 3 FAB.

## Pattern: Glass-morphism done responsibly
- **When**: Floating elements over rich backgrounds (video, gradients).
- **How**:
  - `backdrop-filter: blur(20px) saturate(140%)` + bg `rgba(15,15,17,0.65)`.
  - Add an inner stroke `inset 0 1px 0 rgba(255,255,255,0.06)` for definition.
  - Always test contrast of text on top across worst-case bg (busy video frame).
  - Fall back to opaque surface where `backdrop-filter` is unsupported.
  - Honor `prefers-reduced-transparency`.
- **Source**: Apple HIG materials; Vision Pro guidelines.
- **Anti-patterns**: Blur with no fallback; text below 4.5:1 over the worst background frame.

## Pattern: Modal vs sheet vs popover
- **When**: Choosing transient surfaces.
- **How**:
  - Modal: blocking decision, can't ignore (delete confirm).
  - Sheet: side-task on mobile; slides from bottom; dismissible by drag.
  - Popover: contextual options anchored to a trigger; non-blocking.
- **Source**: Apple HIG; Material 3.

## Anti-pattern checklist
- Floating dock that follows scroll AND overlaps key content.
- Glass panels with text contrast under 4.5:1 over white video frames.
- Command palette without keyboard shortcuts shown.
- Side panel without persistence — reopens every navigation.
