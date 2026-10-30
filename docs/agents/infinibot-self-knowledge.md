# InfiniBot self-knowledge (`infinibot_help`)

Agents know InfiniBot itself (every page, sub-tab, Setup section, plugin, setting, setup check, flow) as it exists in the code right now, plus the user's live state. They give real click-paths and navigate instead of inventing them.

## Pieces

| Piece | Where | What |
| --- | --- | --- |
| Generator | `scripts/gen-infinibot-knowledge.ts` (runs in `pnpm build`, `pnpm knowledge:gen`, `pnpm knowledge:check`) | Reads `ui/src/ui/navigation.ts` (TAB_GROUPS, HOST_SUBVIEWS, RETIRED/HIDDEN/REDIRECT tabs, routes, titles, subtitles, ⌘K keywords), the Setup page's section nav, `TAB_SYNONYMS`, core setup checks, every `extensions/*/infinibot.plugin.json` (+ `learn.json`), core Learn tracks and `docs/{plugins,autonomy,features,start,help,saas}`. |
| Snapshot | `src/infinibot-knowledge/generated/core-knowledge.generated.ts`, digest `docs/reference/infinibot-knowledge.md` | Generated. Never edit. |
| Curated | `src/infinibot-knowledge/curated.ts` | Only what code can't say: multi-step flows and what a control means. Each entry inherits its breadcrumb/route from a generated anchor, and tests check that the quoted UI labels still exist in the source. |
| Runtime | `runtime.ts` | Snapshot + live plugin registry (new plugins show up without a rebuild) + UI target registry. Re-composed whenever the plugin registry changes. |
| Live state | `live-state.ts` → tool `infinibot_state` | Plugins, non-ready setup checks, model, channels, Telegram approvals, voice, coders, Solatrix agent access/permissions/wallets/RPC, main-agent allowlist. Cached 20s and redacted. |
| Help | `help.ts` → tool `infinibot_help {question, context?, includeState?}` | Returns diagnosis, place (breadcrumb, route, target ids), steps, a `navigate` ui_control call, a suggested action and reminders. |
| Prompt | `prompt.ts` / `digest.ts renderPromptSection` | UI map + rules, added to the main system prompt when the agent has `infinibot_help`, and to both voice orchestrator paths. |
| Fix hints | `fix-hints.ts`, `extensions/solatrix/src/agent/access-fix.ts` | Tool errors carry `code` + `fix {where, route, targets, tab}`. |

## Target ids (shared with feat/ui-highlight-nav)

`page:<tab>` · `page:<host>/<view>` (alias `page:<retiredTab>`) · `section:setup/<id>` · `plugin:<id>` · `plugin:<id>/<detailTab>` · `plugin:<id>/settings/<settingsId>` · `control:<owner>/<panel>/<control>` · `check:<setupCheckId>` · `tool:<name>` · `flow:<id>` · `doc:<path>`.

### UI target registry adapter

`targets.ts loadUiTargets()` uses the registry when it's present, and otherwise degrades to `nav.switch_tab` on the closest page. It checks these sources in order:

1. An in-process provider: `registerUiTargetsProvider(() => targets)`.
2. `INFINIBOT_UI_TARGETS_PATH`.
3. `dist/control-ui/ui-targets.json`, `dist/ui-targets.json`, `ui/src/ui/ui-targets.json` or `src/ui-targets/ui-targets.json`.

The format is `{ targets: [{ id, route?, label?, breadcrumb? }] }` or a bare array. If a target id isn't in the knowledge base yet, a minimal entry is created for it.

`detectUiControlCaps()` reads the live `ui_control` schema. Once its `action` enum contains `navigate` / `highlight`, `infinibot_help` returns `{action:"navigate", args:{target}}` (+ highlight) instead of the switch_tab fallback. No code change is needed here when that lands.

## Keeping it current

`src/infinibot-knowledge/knowledge.test.ts` fails when:

- the snapshot is stale;
- a sidebar page, host sub-tab, retired route, Setup section, plugin, plugin page, settings panel, plugin tool or setup check has no entry;
- any route doesn't resolve (path → tab, `?view` → sub-tab, `&plugin` → installed plugin, `&ptab` → detail tab);
- a breadcrumb doesn't start at a real sidebar group/section, or doesn't use the sidebar label;
- a curated label, anchor or target is gone.

## Enabling on a live install

New tools only reach an agent through its allowlist:

1. Add `"infinibot_help", "infinibot_state"` to `agents.list[main].tools.allow` in `~/.infinibot/infinibot.json`, and to any other front-facing agent's list.
2. Restart the gateway.

Sub-agents get `infinibot_help` automatically (`REQUIRED_SUBAGENT_TOOL_ALLOW`). The standard roster (`standard-roster.ts`) already lists both tools for fresh installs.
