# Business & Agency plugin

`extensions/business-agency` (id `business-agency`, manifest v2, first-party,
category "Apps") owns every business- and command-related surface. Before
this plugin they were core and spread over two "Business" sidebar groups (the
built-in one plus a user-made one in saved layouts). Now there is **one**
plugin section:

| # | Section item | Tab (route) | Sub-pages |
|---|---|---|---|
| 1 | Business HQ | `business-hq` (/business-hq) | also shown on /dashboard while on |
| 2 | Command | `command-ceo` (/ceo) | Operations (/ops), Today (/agency-daily), Agencies (/agency-operations), Topology (/agency-topology) |
| 3 | Clients | `clients` (/clients) | CRM, invoicing, payment links |
| 4 | Sales Pipeline | `pipeline` (/pipeline) | the lead pipeline |
| 5 | Register | `opportunities` (/opportunities) | Decisions, Risks, Commitments, People |
| 6 | Leads & Funnels | `leads` (/leads) | Qualifier (/qualifier), Funnels (/funnels), Campaigns (/campaigns) |
| 7 | Business settings | `business` (/business) | business profile, workspace, brand, income sync |

It also contributes:

- **Agency selector** in the topbar, through the new generic
  `contributes.topbarSlots` ([TOPBAR-SLOTS.md](TOPBAR-SLOTS.md)).
- **401 RPCs** as `business-agency.<legacy name>`, with the legacy names as
  manifest `rpcAliases` (see [below](#rpc-surface)).
- **Agent tools** `lead_generation`, `lead_scrape`, `client_contacts` and
  `business_objects`. Core keeps these names as tool slots, and the plugin
  fills them.
- **Roster agents** (`agents/roster.json`): client-director, outreach, ledger,
  scout, ops-ceo-briefing (BRIEFER) and ops-monitor (MONITOR).
- **Business schedules**: `agency-operating-loop` and its in-process
  scheduler, `agency-sop:*` SOP jobs, `ceo-hourly-insights` and
  `oversight-client-snapshot`.
- **Write-only settings** for payment keys: `whopApiKey`, `stripeSecretKey`
  and `squareAccessToken`, plus `whopCompanyId`.

## Behaviour

| Install | Result |
|---|---|
| Fresh | Bundled but **off**. Nothing business-related anywhere: no section, no agency selector, no business cron jobs (not even disabled ones), no business agents, no business RPCs (`unknown method`). `/dashboard` is the generic core home (`views/core-home.ts`), after the first-run checklist. |
| Existing, with business data | A one-time boot migration keeps it **on** (see [Migration](#migration)). The owner sees one "Business & Agency" section, and everything else works as before. |
| Plugin turned off | Gateway reloads in-process. Pages show "Business & Agency is turned off — enable in Plugins". The agency selector and agents disappear. Business cron jobs are **paused**, not disabled: their `enabled` flags are untouched and they resume when the plugin is back on. Data is never touched. |
| Old URLs (/ceo, /clients, /pipeline, /opportunities, /leads, /funnels, /campaigns, /business, /business-hq …) | While on, they open the plugin page (retired sub-page routes still redirect to host + `?view=`). While off, the same URL shows the "turned off" card. |

## What moved vs what stayed core

| Surface | Decision | Why |
|---|---|---|
| Business HQ, Command (CEO / Ops / Today / Agencies / Topology) | **moved** | Agency and business operating model. |
| Clients (CRM, invoicing, payment links), Sales Pipeline | **moved** | |
| Register (Opportunities, Decisions, Risks, Commitments, People) | **moved** | |
| Leads, Qualifier, Funnels, Campaigns | **moved** | Sales ops. They were hidden tabs; now they have a "Leads & Funnels" host. |
| Settings › Business (profile, income sync) | **moved** | Whop, Stripe and Square keys become write-only plugin settings. A key already saved per business still wins, then the plugin setting, then env. |
| Agency selector + `agency.ops.*` | **moved** | The selection is the global biz filter. With the plugin off, `getBizFilter()` returns null (the stored choice is kept). |
| `hq.*` progress log | **moved** | Kanban still records `task.done` progress into it. That is harmless while off. Bulk completions are logged with `bulk: true` and never counted (see below). |
| Inbox (email) | **stays core** | Communication, not business: every AI OS user has email. It moves to the Chat & Voice group. |
| Research | **stays core** | Knowledge feature (PLUGIN-PLATFORM design). It moves to the Work group. |
| Products | **own plugin** | Not absorbed. `optionalPlugins: ["products"]`: HQ shows product cards and calls `product.list` only while Products is on. |
| `objrel.*` / `relations.*` | **stays core** | Typed edges between every object type (reports, notes, projects …). |
| `priorities.*` | **stays core** | Personal daily priorities (`<todays-priorities>`). |
| `branding.*` | **stays core** | Control-UI branding, not business branding. |
| `business.packs.*` | **stays core** | Databases packs. |
| ops-project-health, overseer, archivist, inbox-handler agents | **stay core** | Project health and inbox triage are core. The business pack in `ROSTER_PACKS` is now `["inbox-handler"]`. |
| Vault, Android-ops | **untouched** | Owner-specific and out of scope (PLUGIN-PLATFORM rows 17 and 18 say remove). |

## Core seam

Core code that touches business data goes through one of two seams, so core
builds and runs with the plugin off.

**Gateway: `src/business-agency/`**
- `methods.ts` is the legacy method → scope table. It provides
  `isBusinessAgencyLegacyMethod`, and `listGatewayMethods()` drops those
  names from the advertised list.
- `runtime.ts`: `isBusinessAgencyActive()` (the plugin is loaded in the active
  registry), `createBusinessAgencyHandlers()` (lazy module loaders) and
  `readBusinessAgencyProviderKey()`.
- `cron.ts`: `isBusinessAgencyCronJob()` / `businessAgencyCronSkipReason()`.
  `cron/service/timer.ts` pauses owned jobs while the plugin is off.
  `server.impl.ts` seeds `ceo-hourly-insights` and the operating loop only
  while it is on, and `cron/oversight-jobs.ts` does the same for
  `oversight-client-snapshot`.
- `tools.ts` holds the tool factories that fill core's slots.
- `migration.ts` handles data detection and agent adoption.
- The plugin gets the seam as **`api.runtime.host.businessAgency`**, which is
  core's module instance. A jiti import would give the plugin its own copies
  of the JSON-backed stores (`business.json`, `hq-progress.json`), and they
  would overwrite each other. `infinibot/plugin-sdk` exports only the type.
- Other gated readers:
  - `graph-global.ts` skips client, opportunity, person and decision nodes.
  - `chat-panel.ts` and `federation/hub.ts` fall back to plugin handlers, so
    core chat panels and satellite→master proxying still reach
    `clients.list` etc. while the plugin is on.

**Control UI: `ui/src/ui/business-agency-gate.ts`**
- `BUSINESS_AGENCY_TABS`, `isBusinessAgencyTab()`, `isBusinessAgencyOn()`.
- Used by:
  - `app-render.ts`: one "turned off" card for any business tab, and the
    dashboard → core home fallback.
  - `app-settings.ts`: no business loaders while off.
  - `lib/biz-filter.ts`
  - the kanban agency filter
  - `report-associations.ts`: client and opportunity targets hidden while off.
- `control-bus-app-views.ts` (ui_control) now lists the pages of loaded plugin
  sections, so agents can `switch_tab` to "clients" while the plugin is on.

## Migration

`src/plugins/core-surface-migrations.ts` gained a `business-agency` entry. It
uses the same marker file (`<state>/plugin-migrations.json`) and the same
rules as Discipline and Canvas Library:

- An explicit `plugins.entries.business-agency.enabled` (true or false)
  always wins.
- Otherwise, on the first boot after the upgrade, the install counts as a
  business install only when **user-authored** business rows exist:
  - agency.db `clients`, `engagements`, `opportunities`, `proposals`,
    `invoices`, `payments` or `revenue_entries`;
  - any row in `opportunity.db`, `decision.db`, `risk.db`, `commitment.db` or
    `person.db`;
  - clients in `business.json`;
  - funnels or campaigns.
- These do **not** count, because they fill themselves on any install:
  agency.db `agencies` / `agency_projects` / `agency_tasks` (auto-imported
  from the board when the selector first loaded), and `hq-progress.json`
  events (recorded on every completed kanban task).
- The new optional `adoptAgents` hook tags the old core-seeded business
  agents (`_seedVersion`, no `_plugin`) with `_plugin: "business-agency"`.
  Plugin roster reconciliation then refreshes them while the plugin is on and
  removes them while it is off. Operator-customised agents (no
  `_seedVersion`) are never touched.
- **Data stays in place.** Every store keeps its path (agency.db, the register
  `.db` files, business.json, business/income.json, hq-progress.json,
  funnels/, campaigns/). Several are live SQLite WAL databases shared with
  core readers (kanban invoices, relations, graph), so moving them buys
  nothing and risks a rollback trap like Discipline's. Nothing is moved, so
  there is nothing to back up, and disabling is lossless.
  `<state>/plugin-data/business-agency` is reserved for plugin-owned state.

## Saved sidebar layouts

`NAV_LAYOUT_VERSION` is `2026.09.28-business-agency`. The built-in groups are
rebuilt once (Home, Chat & Voice + Inbox, Work + Research, Agents, Settings),
and custom categories are kept at their position. The merge
(`controllers/nav-sidebar.ts`):

- **Drops a custom category only when every tab it held moved into a plugin
  section.** Example: a custom "Revenue" or "Business" holding
  clients / business / opportunities. It would otherwise render as an empty
  header, because plugin pages never render inside categories. A custom
  category with any core tab left keeps that tab. A category the user just
  created (no tabs yet) is kept.
- Keeps hidden tabs and renames of plugin pages. Renames apply inside the
  plugin section, except that a rename that would duplicate another item's
  label in the same section is ignored, not deleted
  (`pluginSectionDisplayNames`). The owner's old rename of `business` to
  "Sales Pipeline" no longer produces two "Sales Pipeline" entries.

## RPC surface

`src/business-agency/methods.ts` is the source of truth. The manifest is
checked against it in `business-agency.test.ts`.

| Module | Legacy names |
|---|---|
| agency-operations | `agency.ops.*` (180) |
| business, business-income, business-summary | `business.*` (46) |
| clients | `clients.*` (19) |
| leads, lead-qualifier | `leads.*`, `leads.qualifier.*`, `netlify.*` (lead forms) |
| funnels, funnels-flow | `funnels.*` (61) |
| campaigns | `campaigns.*` (10) |
| opportunity, decision, risk, commitment, person | the register (41) |
| hq-progress | `hq.*` (4) |

Scopes are the ones core had. Methods core never listed stay admin. The
legacy names also stay in core's READ/WRITE scope sets, which only matters
while the plugin serves them.

## Tests

- `src/business-agency/business-agency.test.ts` covers:
  - manifest ↔ seam table, section order, topbar slot, write-only secrets;
  - the roster moved out of core;
  - core no longer registers or advertises any business method;
  - empty tool slots while off, cron pause;
  - migration: fresh, auto-imported-only, data, explicit off, adoption;
  - off-by-default load, and on-load aliases + slots + a live alias call.
- `src/plugins/topbar-slots.test.ts` covers manifest parsing and the
  contribution catalog.
- `ui/src/ui/plugin-host-business-agency.test.ts` covers:
  - gating;
  - one section in order, next to Products;
  - topbar slot on/off;
  - the owner's real saved layout, a custom "Revenue" category, and rename
    de-duplication.

## Bulk completions and the progress log

`kanban.tasks.update` takes an optional `source`: `"user" | "agent" | "bulk" |
"automation"` (any other value is rejected; omitted = a normal completion).
Completions with `bulk` or `automation` are still written to
`<state>/hq-progress.json` for audit, but with `bulk: true`, and the HQ strip
(done today, streak, cleared this week) ignores them. Scripts that close many
tasks must pass `source: "bulk"` (CLI: `infinibot kanban task:update --source bulk`).
As a fallback, more than 20 completions from one connection within 60 s are
marked bulk, including the earlier events of that burst. The agent `kanban`
tool records its completions with origin `agent`.

Past bulk runs are corrected on boot by `src/hq-progress/bulk-correction.ts`:
each backup file listed in `INFINIBOT_HQ_BULK_CORRECTION_FILE` (path-delimited;
`off` disables), or by default the owner archive file plus any
`<state>/hq-bulk-corrections/*.json`, marks the matching `task.done` events
bulk once. The applied correction is recorded under `corrections` in
hq-progress.json, keyed by the hash of the task-id set.
