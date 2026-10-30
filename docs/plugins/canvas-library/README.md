# HoloCanvas library plugin (`canvas-library`)

The Canvas Library ("HoloCanvas") used to be a core page. It is now a bundled
first-party plugin (manifest v2) in `extensions/canvas-library`. It is **off
and invisible on a fresh install**, and switched on once for installs that
already have saved canvases.

Design rows: `docs/plugins/PLUGIN-PLATFORM.md` row 25 (Canvas Library → plugin)
and B34 (canvas runtime stays core).

## What moved, what stayed

| | Where | Plugin off |
|---|---|---|
| Library page (`/canvas`, tab `canvas`, sidebar "HoloCanvas" in Work) | plugin — `extensions/canvas-library/ui` | no sidebar/launchpad/⌘K entry; `/canvas` shows the "HoloCanvas is turned off — Open Plugins" card |
| `canvas-library.*` RPCs (list, get, tags, save, delete, bake, fromSource, examples.load) | plugin — `extensions/canvas-library/src/rpc.ts` | not registered |
| `canvas_library` agent tool | plugin — `src/tool.ts` | not registered |
| Example canvases (neutral, opt-in "Load examples") | plugin — `src/examples.ts` | — |
| Saved-canvas store `<stateDir>/canvas-library.db` | **core** — `src/canvas-host/saved-canvases.ts` | kept; work-review keeps saving here |
| Share pages `/canvas/:id`, `/api/canvas/:id`, `/api/canvas/:id/export.html` | **core** — `src/gateway/server-canvas-share-http.ts` | work |
| Report / markdown / stylized-walkthrough → canvas | **core** — `src/canvas-host/canvas-convert.ts` + RPC `canvas.convert` | works |
| Walkthrough overlays (proactive `infinite-canvas-walkthrough`, `report-walkthrough`, `stylized-walkthrough`), `canvas.run` workflows, work-review | **core** | work |

The plugin reaches core only through the `canvasRuntime` seam exported from
`infinibot/plugin-sdk` (`src/canvas-host/plugin-seam.ts`): `store()`,
`parseSource()`, `convert()`, `bakeNarration()`, `sharePath()`. Core never
imports the plugin.

The old core RPC names `canvas.library.*` are gone (their only caller was the
library page, which now uses `canvas-library.*`). `canvas.library.shareLink`
and `canvas.library.seed` were dropped: the page builds share links from the
current origin, and examples are loaded with `canvas-library.examples.load`.

## Data

Nothing moves. Saved canvases stay in `<stateDir>/canvas-library.db` because
the core runtime writes there with the plugin off (work-review, `canvas.convert
{save:true}`). The library is a view over that store, so canvases saved while
the plugin was off show up when it is turned on. Disabling or uninstalling the
plugin never deletes canvases. The plugin keeps nothing in
`<stateDir>/plugin-data/canvas-library`.

## Migration (existing installs)

`src/plugins/canvas-library-migration.ts`, run at gateway start before plugins
load (`src/gateway/server.impl.ts`, delimited block):

- If `plugins.entries.canvas-library.enabled` is already set (true or false),
  it is respected and recorded as `explicit`.
- Else if the store has at least one canvas, `enabled: true` is written (and
  `canvas-library` is added to `plugins.allow` if an allow-list exists). The
  boot log says: *Canvas Library is now the "HoloCanvas" plugin … kept ON*.
- Else it is recorded as `no-data` and the plugin stays off. Canvases saved
  later (e.g. by work-review) never switch it on.

It runs once per state dir: the result is recorded in
`<stateDir>/plugin-migrations.json` under `core-surface:canvas-library` (same
file/key format as the Discipline migration). It never moves or deletes data.

## Core RPC `canvas.convert` (admin scope)

```jsonc
// source: "report" | "markdown" | "walkthrough"
{ "source": "report", "reportId": "…", "title"?: "…",
  "save"?: true, "tags"?: ["…"], "emit"?: true, "tier"?: "NOTABLE" }
{ "source": "markdown", "markdown": "# …", "save"?: true }
{ "source": "walkthrough", "chapters": [{ "title": "…", "body": "…" }], "emit"?: true }
// → { ok, title, mediaKind, payload, canvasId?, sharePath?, eventId? }
```

A report converts from its stored `ReportPayload` (`config.payload`) when
present, else from its markdown parity copy via `markdownToPayload`.

## Plugin RPCs

| Method | Scope | Params |
|---|---|---|
| `canvas-library.list` | read | `{tag?, limit?, offset?}` → `{entries (no payload), total}` |
| `canvas-library.get` | read | `{id}` → `{entry}` |
| `canvas-library.tags` | read | → `{tags}` |
| `canvas-library.save` | write | `{title, payload:{nodes[],scenes[]}, tags?, id?, thumbnailDataUrl?}` |
| `canvas-library.delete` | write | `{id}` |
| `canvas-library.bake` | write | `{id}` → `{manifest}` (per-scene narration audio) |
| `canvas-library.fromSource` | write | same source params as `canvas.convert` → `{entry, mediaKind}` |
| `canvas-library.examples.load` | write | → `{added, alreadyPresent}` (idempotent by title) |

Mutations broadcast `canvas-library:changed`.

## Agent tool reach

`canvas_library` is a normal (non-optional) plugin tool, so it follows the
platform rule: agents whose tool allowlist includes `group:plugins` (e.g.
brand-designer, content) get it while the plugin is on; `main` has an explicit
allowlist and does not, unless `canvas_library` is added to it. Showing a canvas
never needs this tool — the core `proactive` tool / `canvas.convert` do that.

## Core fixes made alongside the move

- Report and stylized-walkthrough overlays (`report-walkthrough`,
  `stylized-walkthrough`) now render on the full canvas surface; before, they
  fell into the presenter card with an empty body.
- `reports/to-canvas.ts` and `stylized-walkthrough/to-canvas.ts` now emit the
  fields the overlay draws (`h2`, `brand`, stats-card `kicker`); headings were
  invisible. Report headline metrics get their own card.
- `reports.render` keeps the rendered `ReportPayload` in `config.payload`, so
  those reports convert section by section (others use the markdown copy).
- The saved-canvas tag filter queried `json_each` without a FROM and threw.
- Sidebar group counts ignore plugin-gated tabs whose plugin is off.

## Verification (side gateway, 2026-09-28)

Fresh install (off → on → off) and a secrets-stripped copy of the owner config
with the owner's 47-canvas store: see the probe matrix in the branch's PR notes.
The owner copy's `plugins.entries.robopark-map` had to be removed to boot (that
plugin isn't on this base — unrelated).

## Tests

- `extensions/canvas-library/src/plugin.test.ts` — manifest, registration =
  declarations, RPCs, examples, tool.
- `src/plugins/canvas-library-migration.test.ts` — fresh/no-data, data → on,
  explicit choice, idempotence, shared marker file.
- `src/canvas-host/canvas-convert.test.ts` — report (payload + markdown),
  walkthrough, markdown, errors, renderer field names.
- `ui/src/ui/plugin-host-canvas-library.test.ts` — `canvas` tab gating + nav label.
