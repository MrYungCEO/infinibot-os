# Discipline plugin (`discipline`)

Branch `plugin/discipline` (from `feat/saas-clerk-neon` 248b236d). Row 23 + 24
of [PLUGIN-PLATFORM.md](PLUGIN-PLATFORM.md) §2: the Day planner and the Focus
board move out of core into a first-party manifest-v2 plugin,
`extensions/discipline`.

## What the plugin owns

| Piece | Where now | Was |
|---|---|---|
| `discipline.*` RPCs (35) | `extensions/discipline/src/rpc.ts` | `src/gateway/server-methods/discipline.ts` |
| Focus RPCs `discipline.focus.*` (13) | `src/focus-rpc.ts` + `src/focus-store.ts` | `src/gateway/server-methods/focus.ts` (`focus.*`) |
| Store (`discipline.db`), types, insights, Notion sync | `src/store.ts`, `types.ts`, `insights.ts`, `notion-sync.ts` | `src/discipline/**` |
| Auto-log (agent activity + completions → active block, auto start-day, auto-complete) | `src/auto-log.ts` | `src/discipline/auto-log` |
| Block alerts, 09:30 check-in, 21:00 wrap | `src/alerts.ts` | `src/notifications/discipline-alerts.ts` |
| Telegram block bridge | `src/telegram-bridge.ts` | `src/discipline/telegram-bridge.ts` |
| Agent tools `discipline`, `focus` | `src/tool.ts`, `src/focus-tool.ts` | `src/agents/tools/{discipline,focus}-tool.ts` |
| Day + Focus board pages | still `ui/src/ui/views/{discipline,focus}.ts`, now plugin-gated | core tabs |

All background work lives in one service, `discipline-runtime`
(`index.ts`): started with the gateway only while the plugin is enabled,
stopped on disable/restart (it logs `discipline runtime stopped`). Nothing is
armed at import or register time. The old core handlers started the auto-log,
the Telegram bridge and the Telegram completion notifier as **import side
effects**, which kept one-shot CLI commands alive. After this change,
importing `dist/gateway/server-methods.js` leaves 1 timer instead of 3. The
remaining one is `src/agents/subagent-progress.ts`, which isn't part of this
surface.

Config (`plugins.entries.discipline.config`): `autoLog`, `alerts`,
`telegramBridge` — all default on.

## Core seams (core builds and runs with the plugin off)

Plugins load through jiti in **their own module instances**. A plugin that
imports a core singleton (`onAgentEvent`, the kanban store, …) gets a second,
disconnected copy. So everything crosses through the host:

- `src/infra/work-completions.ts` — kanban (`kanban-store-ops.ts`) and the
  agent runner (`subagent-progress.ts`) emit `emitWorkCompleted()`; they no
  longer import Discipline. Plugins subscribe through
  `api.runtime.host.onWorkCompleted`.
- `src/infra/day-planner-seam.ts` — provider set by the plugin
  (`api.runtime.host.setDayPlannerProvider`). Readers: the Telegram
  completion notifier (`notifications/telegram-completions.ts`, now started
  from `server-startup.ts`; sends nothing while the plugin is off), the
  agent-integration test message's chat-id fallback, and the CEO hourly
  report's "focus posture" section.
- `src/proactive/business-snapshot.ts` — `gatherBusinessSnapshot` +
  `BusinessSnapshot`/`InsightRef` moved here (the proactive engine is core);
  the plugin gets it as `api.runtime.host.gatherBusinessSnapshot`.
- `src/plugins/core-tool-slots.ts` — `createInfiniBotTools()` still calls
  `createDisciplineTool()` / `createFocusTool()` (so `infinibot-tools.ts`,
  which has owner WIP, is untouched). Those are now slots the plugin fills;
  empty slots are dropped by `pi-tools.ts` and `agent.tools.list`, and the
  system-prompt section only appears while the slot is filled.
- Fills and the provider count **only while the plugin is loaded in the
  active registry** (`isPluginActive`): a plugin turned off reloads the
  gateway in-process, and module state outlives that reload.
- `api.runtime.host` (new section of the plugin runtime): `onAgentEvent`,
  `onWorkCompleted`, `emitNotification`, `gatherBusinessSnapshot`,
  `setDayPlannerProvider`, `setCoreToolSlot`.
- `src/gateway/plugin-method-aliases.ts` — manifest-v2 plugins may only
  register `<id>.*`, so the legacy `focus.*` names forward to
  `discipline.focus.*` while the plugin is loaded, and answer "focus.x is
  provided by the Discipline plugin, which is turned off — enable it in
  Setup › Plugins" otherwise. `discipline.*` names are unchanged.

## Fresh vs existing installs (migration)

- **Fresh install:** the plugin is bundled and disabled by default. There is
  no sidebar entry, no launchpad / ⌘K / ui_control / wake-word entry, no
  `discipline.*` RPCs, no tools, no timers. `/discipline` and `/focus` show
  "Discipline is turned off — Open Plugins".
- **Existing install:** `src/plugins/core-surface-migrations.ts` runs at
  gateway boot, next to plugin auto-enable. If the state dir has
  **user-authored** Discipline data — rows in `discipline_blocks`, `_logs`,
  `_templates` or `_routine_completions`, or Focus items — it writes
  `plugins.entries.discipline.enabled = true`. It checks both
  `<stateDir>/discipline.db` and the plugin-data copy. `discipline_events` /
  `_day_start` don't count: the old core auto-log filled them on every
  install, even ones that never opened the page.
- It runs once per state dir and never overrides the owner. An explicit
  `enabled` (true or false) is always respected. "No data" and "explicit"
  outcomes are recorded in `<stateDir>/plugin-migrations.json`. An enable is
  recorded by the explicit `enabled: true` itself; if the config write
  fails, the check runs again next boot.
- The owner can turn it off in Setup › Plugins. The choice survives
  restarts, and the data stays.

## Data

`<stateDir>/plugin-data/discipline/` holds `discipline.db`,
`discipline-notion.json` and `focus.json`. `src/data-dir.ts` moves the
pre-plugin files in on first open per state dir (tenant-aware). The move
checkpoints the SQLite WAL first, never overwrites, leaves a
`*.moved-to-plugin-data` breadcrumb and is idempotent. Disabling never
touches the directory. Setup › Plugins › Data can export or clear it.

**Rollback note:** a pre-plugin build looks for `<stateDir>/discipline.db`.
To roll back, move `plugin-data/discipline/discipline.db` back next to the
breadcrumb.

The **Focus board** used to live only in the browser's localStorage (and a
separate cwd-relative `state/focus.json` for the agent tool). The UI now
mirrors to `discipline.focus.*`. The server copy wins, and an empty server
board is seeded once from the browser. `discipline.focus.set` stores items
that arrive with a title as given (no Notion needed). `focus.sync` no longer
drops every item when Notion isn't configured.

## Shared-file hunks (for integration)

- `ui/src/ui/navigation.ts` — `discipline` removed from the Work group (the
  manifest nav adds it back while enabled).
- `ui/src/ui/plugin-host.ts` — `FIRST_PARTY_PAGES += discipline, focus`.
- `ui/src/ui/app-render.ts` — `renderDisciplinePluginPage()` (gated page +
  plugin scope); the topbar block-alert overlay is mounted only while
  enabled; a plugin-gated host that's off shows no sub-tab strip; Focus
  hydration.
- `ui/src/ui/app-settings.ts` — the Discipline tab loader skips RPCs while
  off and hydrates Focus.
- `ui/src/ui/controllers/dashboard.ts`, `views/dashboard.ts` — no
  `discipline.*` calls / card while off.
- `src/gateway/server-methods.ts` — `discipline`/`focus` handler imports
  removed; alias dispatch (6 lines).
- `src/gateway/server-methods-list.ts` — `discipline.*` block removed.
- `src/gateway/server.impl.ts` — boot migration call.
- `src/gateway/server-startup.ts` — `startDisciplineAlerts` → `startTelegramCompletions`.
- `src/plugins/runtime/{types,index}.ts` — `host` section.
- `src/agents/pi-tools.ts`, `src/gateway/server-methods/agent-tools.ts` —
  `dropEmptyToolSlots(...)`.
- `src/agents/system-prompt.ts` — Discipline section gated on the slot.

## Not done / follow-ups

- Mobile app (`mobile/src/screens/DisciplineScreen.js` etc.) still calls
  `discipline.*` directly. It works while the plugin is on and gets
  "unknown method" when it's off. It needs a plugin-aware gate.
- `agents.*.tools.allow` entries naming `discipline` / `focus` log the
  existing "unknown allowlist entries" warning while the plugin is off.
- Pre-existing, not changed: at 390 px the Day view's active-block header is
  cramped (the block title wraps away). It's the same with the plugin-scope
  wrapper removed.
