# Plugins page control + per-plugin appearance (Phase 0 · stream 0C)

Branch `feat/plugins-page-control` (from `feat/plugin-platform-design` 50e7d4a1).
Design context: [`PLUGIN-PLATFORM.md`](PLUGIN-PLATFORM.md) §3.2–3.6.

## Manifest v2 additions (all optional, additive)

Existing v2 manifests keep validating unchanged. Unknown `contributes.*`
kinds are ignored by the strict parser and listed in Setup › Plugins.

```jsonc
{
  "license": "FSL-1.1-ALv2",          // shown in Overview
  "homepage": "https://…",
  "appearance": {
    // Colour DEFAULTS must be InfiniBot tokens: token:primary | accent | info |
    // success | warning | danger | neutral | text | muted | surface | bg
    "accent": "token:primary",
    "tint": "none",                    // or token:*
    "tintStrength": 0.06,              // 0 … 0.3
    "density": "comfortable",          // or "compact"
    "fontScale": 1,                    // 0.85 … 1.3
    "icon": "server",
    "monogram": "IC",                  // ≤ 3 chars, list/detail tile
    "layout": [
      { "id": "default-view", "label": "Opens on", "type": "select",
        "options": [{ "value": "agents", "label": "Agent Ops" }, { "value": "fleet", "label": "Fleet" }],
        "default": "agents" },
      { "id": "show-map", "label": "Show map", "type": "toggle", "default": true }
    ],
    "variables": [
      // name MUST be --plugin-<id>-*; colour defaults must be tokens;
      // role "text" is checked at 4.5:1, "ui" at 3:1 in both themes
      { "name": "--plugin-infinitrade-profit", "label": "Profit colour", "type": "color",
        "default": "token:success", "role": "text" }
    ]
  },
  "contributes": {
    // any contribution entry may say which permissions it depends on —
    // revoking one turns the dependents off live
    "rpc":  [{ "method": "x.orders.place", "scope": "write", "requires": ["network:api.tradelocker.com"] }],
    "http": ["/plugins/x/asset.js", { "path": "/plugins/x/hook", "requires": ["exec"] }],
    // data importers shown in the Data tab; `method` must be a declared rpc.
    // The UI calls it with { filename, content } (file text).
    "importers": [{ "id": "omnitrade", "label": "Import from OmniTrade", "method": "x.import.omnitrade",
                    "description": "…", "accept": ".json" }]
  }
}
```

Implicit dependencies: tools with `"trust": "exec"` require `exec`; MCP
servers require `secrets:<NAME>` for `auth: "secret:NAME"` and
`network:<host>` for their URL. Permission keys: `exec`, `credits`,
`network:<host>`, `fs:<path>`, `secrets:<NAME>`, `channels:<id>`.

## Store listing (`listing`, optional — any manifest version)

Branch `feat/plugins-marketplace-ui`. Feeds the marketplace-style Plugins
page (cards, store-listing detail page, screenshot gallery). It is parsed
**leniently** (`src/plugins/listing.ts`): a malformed field is dropped with a
warning (shown under Health › Diagnostics) and never stops the plugin from
loading, so v1 and v2 manifests without it — or with a broken one — keep
working exactly as before.

```jsonc
"listing": {
  "tagline": "One line under the name (≤ 140 chars)",
  "description": "Long **markdown** description (sanitized when rendered)",
  "category": "apps",            // apps | channels | integrations | developer | any lowercase slug
  "tags": ["voice", "agents"],   // ≤ 12, lower-cased
  "cover": "assets/cover.svg",   // 16:9 art, path inside the plugin folder
  "icon": "assets/icon.svg",     // square
  "screenshots": [{ "src": "assets/shot-1.webp", "caption": "…" }],   // ≤ 8
  "publisher": { "name": "InfiniBot", "url": "https://…" },
  "links": { "docs": "https://…", "support": "https://…", "source": "https://…" }
}
```

- **Images** are plugin-relative paths (png, webp, jpg, gif, avif, svg; no
  `..`, no absolute paths, no hidden segments) or inline
  `data:image/…;base64,` URLs ≤ 256 KB. Keep files small (bundled plugins are
  tested to stay < 200 KB each). **No third-party logos or brand marks**
  ([BRAND-USAGE](../licensing/BRAND-USAGE.md)) — plugins without a cover get a
  generated gold-on-black cover per category with the plugin's monogram.
- **Links** must be http(s); anything else is dropped.
- **Category** when omitted is inferred: declares channels → `channels`,
  providers or `kind: "memory"` → `integrations`, declares pages → `apps`,
  otherwise `developer`.
- Nothing in the listing is a rating, install count or review. Those come
  from the registry (Phase 3) and are only shown when real data exists.

### Listing images route

`GET /api/plugin-assets/<pluginId>/<path>` serves listing images:

- behind the central HTTP gate (`/api/` is never public — gateway token,
  password or session cookie required; `<img>` requests carry the cookie);
- only files the listing **declares** (cover, icon, screenshots) — every other
  path is a 404, so `..`, encoded slashes and absolute paths have nothing to
  reach;
- the real path (symlinks resolved) must stay inside the plugin folder, be a
  regular file ≤ 2 MB with an image extension;
- `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src
  'none'; style-src 'unsafe-inline'; sandbox`, `Cache-Control: private,
  max-age=300`.

`plugins.list` / `plugins.get` return the listing with image paths already
turned into these URLs, plus `category`, declared `channels` / `providers`,
`setup` (`{ needed, reason, target: "settings" | "channels" }` — from real
config: a channel plugin with no `channels.<id>` block, or required settings
unset) and, in `plugins.get`, `listingWarnings` and `updatedAt` (install time,
else when the plugin's files last changed). Older UIs ignore the new fields;
the new UI falls back gracefully on older gateways.

### Page layout

- **Browse** — hero, search (name, tagline, tags, channels), All / Installed
  / Enabled / Available, category and trust-tier chips, sort, grid or compact
  list, an Installed shelf, then category sections (First-party apps,
  Channels, Integrations, Developer). "Installed" = on, or added by the owner;
  "Available" = ships with InfiniBot but off (and, later, registry entries).
  Each card has one primary action: Enable (restart confirm), Open (the
  plugin's page), Set up (Setup › Channels or the settings section),
  Configure.
- **Detail** — one scrolling store listing with a sticky section nav:
  Overview (gallery + lightbox, markdown description, start-page switch),
  What it adds (live/saved switches), Permissions (plain-English title, risk
  level, granted/revoked, what revoking turns off), Settings (switches,
  selects, write-only secrets with Set / Not set, a sticky save bar with the
  changed fields and a restart warning), Appearance, Health & Logs, Data,
  Versions, Uninstall. `?plugin=<id>&ptab=<section>` deep-links to a section.

## Using appearance in a plugin UI

Every plugin surface is rendered inside `[data-plugin-scope="<id>"]`, which
carries (for the active theme): `--plugin-accent` (always AA-safe as text),
`--plugin-tint`, `--plugin-surface`, `--plugin-space`, `--plugin-density-scale`,
`--plugin-font-scale`, `--plugin-<id>-layout-<option>`, your declared
variables, and — only when the owner changes the accent — scoped `--g-primary`
& friends. Style with those vars, or read them:

```ts
import { readPluginAppearance, onPluginAppearanceChange, listenPluginAppearanceBridge } from "infinibot/plugin-sdk";
const a = readPluginAppearance(el, { layoutOptions: ["default-view"] }); // a.accent, a.layout["default-view"], …
const off = onPluginAppearanceChange(() => rerender());                 // owner edits + theme flips
listenPluginAppearanceBridge();                                          // sandboxed iframe pages
```

## RPCs (all admin-only)

| Method | Params | Restart? |
|---|---|---|
| `plugins.list` | – | – |
| `plugins.get` | `{id}` | – |
| `plugins.setEnabled` | `{id, enabled}` | **yes** (confirmed in UI, sub-agent warning) |
| `plugins.contributions.set` | `{id, key, enabled}` | no |
| `plugins.permissions.set` | `{id, key, granted}` → `disabledNow/enabledNow` | no |
| `plugins.config.get` | `{id}` → schema, masked values, `secretKeys` | – |
| `plugins.config.set` | `{id, values}` (blank/masked secret = keep) | **yes** if loaded |
| `plugins.appearance.get / preview / set / reset` | `{id, appearance?, strict?}` | no |
| `plugins.health` | `{id}` | – |
| `plugins.logs` | `{id, limit?, level?}` | – |
| `plugins.restart` | `{id}` services in place · `{id, full:true}` | services: no · full: **yes** |
| `plugins.data.export / import / clear` | `{id}` · `{id, bundle, mode}` or `{id, importer, payload}` · `{id, confirm:id}` | no |
| `plugins.uninstall` | `{id, keepData}` | **yes** if loaded or package removed |

Config: `plugins.entries.<id>.{appearance, contributions.{disabled,enabled},
permissions.revoked}` are hot (config-reload no-op); the loader re-seeds the
live state from them.

## What is live vs. what still restarts

| Live (no restart) | Needs a gateway restart |
|---|---|
| Nav entry / page hide, RPC & HTTP route toggles, tool toggles, service stop/start | Turning a plugin on/off (code load/unload — Phase 0F hot lifecycle) |
| Permission grant/revoke (+ cascade) | Saving plugin settings (plugins read config at register) |
| Appearance (all fields) | Full reload, uninstall |
| Service restart, data export/import/clear | |

Saved-but-not-enforced-yet toggles (UI says "saved"): sub-views, widgets,
overlays, launchpad, map layers, cron, agents, skills, MCP servers, sidecars,
panel kinds — they apply when 0B/0D land those hosts (`isContributionActive`
in `src/plugins/host-state.ts` is the check to call).

## Known limits

- In-process (T0/T1) plugins aren't sandboxed: revoking a permission turns off
  the declared dependents, not arbitrary code paths inside the plugin (0E).
- No registry yet → update/rollback show "no registry" (Phase 3).
- The iframe tier host isn't built; the bridge message + SDK listener are.
- Core bug found (not fixed here): the palette applier writes dark-theme
  `--text`/`--fg`/`--bg`/`--g-fg` inline on `:root` even in light mode, so core
  pages using `--text` look washed out in light. The Plugins page uses
  `--card-foreground` instead.
- The Plugins page pins its own light-mode text colours (`data-mode` on the
  host) so it reads correctly even with the palette bug above; other core
  pages still need the core fix.
- At 1101–1680 px the app zooms `body` to 0.7 (viewport-scale.css) and the
  ambient background layer only paints the top-left 70 % of the window — an
  app-wide artifact visible behind every page, not specific to Plugins.
