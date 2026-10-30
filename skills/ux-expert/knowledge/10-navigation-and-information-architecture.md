# 10 · Navigation & Information Architecture

## Pattern: 5 ± 2 top-level destinations
- **When**: Designing primary nav.
- **How**: Cap top-level items at 7 (ideally 5). Beyond that, group under "More" / overflow. Card-sort with real users when uncertain.
- **Source**: NN/g IA; Miller's 7±2.

## Pattern: Persistent location cues (you-are-here)
- **When**: Apps with >2 nav layers.
- **How**:
  - Active item is HIGH contrast + filled background OR left-edge accent bar.
  - Breadcrumbs for ≥3 levels deep, last segment plain (not a link).
  - Page title in browser tab matches the visible heading.
- **Source**: NN/g breadcrumbs research.

## Pattern: Sidebar vs top nav
- **When**: Choosing primary chrome.
- **How**:
  - Top nav: ≤5 destinations, marketing/portal apps.
  - Side nav: 6–15 destinations, dense tooling (Linear, Notion, Figma).
  - Collapsible side nav for power users; default-open for new users.
- **Source**: Atlassian; Polaris.

## Pattern: Search as a first-class surface
- **When**: >100 items in any list, or >10 destinations.
- **How**:
  - Global search via cmd-K / ctrl-K palette.
  - Type-ahead with grouped results (Pages, Files, Actions).
  - Recents at top when query is empty.
- **Source**: Linear, Notion, Slack patterns.

## Pattern: Breadcrumbs that double as navigation
- **When**: Hierarchical content.
- **How**: Each segment clickable; current segment plain text; truncate middle on overflow (`Home / … / Folder / Item`).
- **Source**: NN/g breadcrumbs.

## Pattern: Hub-and-spoke vs nested drill-down
- **When**: Mobile or wizards.
- **How**: Mobile flows favor hub-and-spoke (back returns to hub). Wizards keep a linear progress indicator.
- **Source**: Apple HIG navigation; Material flow patterns.

## Pattern: Anchor-stable URLs
- **When**: SPA navigation.
- **How**: Every visible state has a deep-linkable URL (filters, modal-open, tab, item). Back button must work as the user expects ("back = previous visible state").
- **Source**: web.dev "URL design".

## Pattern: Tab semantics — sibling, not nested
- **When**: Using tabs.
- **How**: Tabs represent peer views of the same subject (no parent/child). If one tab needs sub-tabs, you've outgrown tabs — use a sidebar.
- **Source**: NN/g tabs UX.

## Anti-pattern checklist
- Active nav item indicated only by a 1-px underline.
- Hamburger menu on desktop hiding primary destinations.
- Browser back breaks the SPA state.
- Search hidden under a magnifier icon when search is the dominant action.
- Breadcrumbs that disagree with the sidebar's selected node.
