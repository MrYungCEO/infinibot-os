# Plugin sidebar sections

Every **enabled** manifest-v2 plugin that contributes at least one routable
page gets its **own section** in the control-UI sidebar. Disabled plugins show
nothing: no section, no hidden-tab rows, no Launchpad entries.

| Part | Where it comes from |
|---|---|
| Header | plugin `name` (or `navSection.title`) + monogram chip (`appearance.monogram`, else initials of the name) |
| Accent marker | the plugin's resolved appearance `--plugin-accent` (dark + light), used on the chip, the item rail and the active item |
| Items | the plugin's `contributes.pages`, in manifest order (or `navSection.items`). Label/icon come from the matching `contributes.nav` entry, then the page `title` |
| Order | below all core groups; sorted by `navSection.order` (default 1000), then title |

The nav entry's `group` no longer puts a plugin page inside a core group.
InfiniCode left Agents, OmniClinic's old "Clinic" group became its section,
and Robovoice left Settings.

Business & Agency (`navSection.order: 10`) is the first plugin section. It
replaced the two core/custom "Business" groups; see
[BUSINESS-AGENCY.md](BUSINESS-AGENCY.md) § Saved sidebar layouts for how
saved layouts degrade. Topbar controls are a separate contribution:
[TOPBAR-SLOTS.md](TOPBAR-SLOTS.md).

## Optional manifest addition: `contributes.navSection`

```jsonc
"contributes": {
  "pages": [ … ],
  "nav":   [ … ],
  "navSection": {
    "title": "Trading",            // default: plugin name
    "order": 50,                   // default: 1000
    "collapsedByDefault": true,    // default: false
    "items": [                     // default: every declared page, manifest order
      { "page": "infinitrade", "label": "Dashboard", "icon": "chart" }
    ]
  }
}
```

Parsed and validated in `src/plugins/manifest-v2.ts`. It fails closed: a
non-object value, a non-number `order`, a non-boolean `collapsedByDefault`, or
an item naming no `contributes.pages` tab (or listed twice) rejects the
manifest.

## Rules

- **Only routable pages appear.** A page is routable when its `builtin` maps
  to a tab in `FIRST_PARTY_PAGES` (`ui/src/ui/plugin-host.ts`). Entry-module
  (`entry`) pages have no control-UI route yet, so they get no sidebar item.
- **Owner toggles in Setup › Plugins win.** A hidden nav contribution
  (`nav:<tab>`) drops the item (the page stays routable). A switched-off page
  (`page:<tab>`) drops it too. A section with nothing left disappears.
- **Live updates.** `applyPluginList` fires the `infinibot-plugin-host` window
  event when sections or tabs change. The sidebar redraws without a reload.
  This covers enable/disable (reconnect → `plugins.list`) and contribution
  toggles (the Plugins page re-syncs the host).
- **Per-user preferences.** Collapsed/hidden state is stored in the
  nav-sidebar state as `pluginSections: { <pluginId>: { collapsed?, hidden? } }`
  (localStorage + `nav.sidebar.set`). Sections themselves are never stored as
  categories, so custom categories, renames, hidden tabs and the layoutVersion
  migration are untouched. Plugin tabs you hid or renamed survive the merge
  even while the plugin is off.
- **Interactions.** Click the header to collapse or expand (`aria-expanded`).
  Right-click it for Collapse / Manage plugin… / Hide section; hidden sections
  appear under "Hidden Tabs" with a restore button. Plugin items can be renamed
  and hidden, but not dragged into core categories.
- **Icon rail.** The section collapses to its monogram tile. Hovering, Enter or
  ArrowDown opens a body-mounted flyout `role="menu"` of its pages
  (arrow keys, Home/End, Escape).
- **≤1100px row (390px mobile).** The chip is followed inline by the pages,
  as labels or as icon tiles in icon mode. The flyout drops below the chip.
- **Search.** ⌘K sidebar search and the Launchpad match plugin pages on their
  own label and on the plugin's name. The Launchpad groups them under the
  plugin's name.

## What a new plugin (FlyPic, Infinitrade, …) needs

1. A `contributes.pages` entry whose page the control UI can route:
   `builtin` + a `FIRST_PARTY_PAGES` entry + the `Tab` / `TAB_PATHS` / render
   block (Infinitrade's branch already adds `infinitrade`). An `entry`-only
   page, like FlyPic's `/plugins/flypic/ui-panel.js` today, gets **no section**
   until the host can route entry-module pages or the plugin ships a builtin
   page.
2. Optionally a `contributes.nav` entry per page for label and icon; `group`
   is ignored for placement.
3. Optionally `appearance.monogram` / `appearance.accent`, and
   `contributes.navSection` for title, order, collapse default or
   selecting/relabelling pages. Several pages (dashboard, positions, chart, …)
   are listed in manifest order automatically.
