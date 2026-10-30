# UI targets: universal navigation and live highlighting

Any InfiniBot-connected agent can open an exact place in the control UI and
point at an exact control on the user's screen. That covers the in-app main
agent, voice, Telegram-driven sessions, sub-agents, and external MCP
orchestrators such as Claude Code over the `infinibot` MCP server. It works the
same on local installs and on cloud tenants.

```
agent ──ui_control{navigate|highlight|guide}──▶ gateway
          resolve target (registry) → availability → pick the user's tab
                                         │  one reveal plan, one socket
                                         ▼
                              browser tab: UIControlBus view "guide"
                              route → reveal steps → wait → <ib-guide-layer>
```

## 1. Target registry (single source of truth)

Code lives in `src/ui-targets/`. It is dependency-free and shared with the UI.

| Kind | Id pattern | Example |
|---|---|---|
| page | `page:<route>` / `page:<host>/<subview>` | `page:apikeys`, `page:setup/plugins`, `page:solatrix/settings` |
| section | `section:setup/<id>`, `plugin:<id>/settings/<sid>`, `plugin:<id>/section/<s>` | `plugin:solatrix/settings/agent-access` |
| nav | `nav:sidebar/<tab>`, `nav:sidebar-group/<g>`, `nav:sidebar` | `nav:sidebar/mesh` |
| control | `control:<area>/<…>`, `plugin:<id>/enable`, `plugin:<id>/topbar/<slot>` | `control:solatrix/agent-access/mode`, `control:topbar/chat` |
| modal | `modal:<name>` | `modal:chat`, `modal:approvals`, `modal:chart` |
| plugin | `plugin:<id>` | `plugin:solatrix` |
| setup-check | `setup-check:<name>` | `setup-check:models` |

The registry is built from these sources:

- **Navigation.** `ui/src/ui/guide/derive-nav-targets.ts` reads `navigation.ts`
  (TAB_PATHS, HOST_SUBVIEWS, TAB_REDIRECTS and aliases, TAB_GROUPS for the
  sidebar) and `CONTROL_BAR_ITEMS`. The result is committed as
  `src/ui-targets/generated/nav-targets.json`, and a drift test regenerates it
  with `UPDATE_UI_TARGETS=1 pnpm -C ui vitest run --config vitest.guide.config.ts`.
- **Plugin manifests.** Each installed v2 plugin contributes its pages,
  navSection items, `contributes.settings`, `topbarSlots`, detail-page
  sections and on/off switch. These are read live from the plugin registry.
- **Guided Learn anchors.** Every `learn:<id>` that a walkthrough spotlights
  becomes a target, carrying that step's route and copy.
- **Setup-status checks.** Core and plugin checks become targets that lead to
  their fix action.
- **Curated targets** in `src/ui-targets/curated.ts`. These cover the controls
  people ask about: Solatrix agent-access modes, limits, freeze, allowlist,
  audit and consent; the API-key add flow; coders cards; channel cards; the
  chat modal and agent switcher; the chart panel and its source switch; the
  wallet chip; approvals; the launchpad; the mesh HUD; memory and the
  knowledge graph. A curated entry with `extends: true` only enriches a
  derived target.

Each target records how to reach it:

- `route`
- `reveal` steps: `route`, `event`, `click` (guarded by `unless`), `dispatch`,
  `open` (surface), `sidebar`, `wait`
- `selectors`, which pierce shadow roots and prefer `[data-ib-target="<id>"]`
- `fallbackSelectors`, for example the ⋯ overflow menu
- `availability`: plugin, cloud/local, and notes

### API

`src/ui-targets/index.ts` exposes:

- `listUiTargets`, `searchUiTargets`, `resolveUiTarget` and `getUiTarget`,
  which use the live gateway registry
- `buildUiTargets`, `resolveTarget`, `searchTargets`, `buildRevealPlan` and
  `evaluateAvailability`, which are pure

### Static dump

`src/ui-targets/ui-targets.json` holds every target a stock install can have,
with all first-party plugins included. Regenerate it with
`pnpm ui-targets:gen`; `pnpm ui-targets:check` verifies it is current.

### Gateway RPCs (read scope)

| RPC | Params | Returns |
|---|---|---|
| `ui.targets.list` | `{ kind?, plugin?, prefix?, available? }` | the matching targets |
| `ui.targets.search` | `{ query, limit? }` | ranked `targets` plus `best`, which is a resolved plan or the ambiguity candidates |
| `ui.targets.get` | `{ id }` | the target, its plan and its availability |

### Natural-language resolution

Resolution is deterministic and does not call a model. The query is split
into word slots and each slot is expanded with synonyms ("turn on" becomes
enable, "config" also matches settings). Each slot is then scored against the
target's title, id, keywords and description, with a light stemmer.

Scores are adjusted as follows:

- phrase bonuses scale with the length of the matched phrase
- title specificity adds weight
- intent priors apply: "open" favours pages and modals, "button" favours
  controls
- plugin surfaces are ranked lower unless the query names the plugin
- raw Learn anchors are ranked lower

If two top results are unrelated and close in score, the answer is
`AMBIGUOUS_TARGET` with candidates. A page and its own sidebar entry or
sub-section never count as rivals.

## 2. `ui_control` actions

| Action | Arguments | What happens |
|---|---|---|
| `find_targets` | `query` | Ranked targets. No browser needed. |
| `list_targets` | `args: { kind?, plugin?, prefix?, limit? }` | Registry listing. |
| `navigate` | `target` \| `query` \| `route` \| `args.tabId` | Opens the page, host sub-tab, plugin page, settings section or modal. Returns `resolved` and the final route. |
| `open_panel` / `open_modal` | `target` \| `query` | Same as `navigate`, restricted to `modal:*`. |
| `highlight` | `target` \| `query` \| `args.selector`, `text`, `style` = `pulse`\|`spotlight`\|`outline`\|`arrow`, `durationMs` | Reveals the element (navigating and opening as needed), waits for it, then draws the overlay. |
| `guide` | `steps: [{ target\|query\|route, text, style?, advance: next\|click\|auto, durationMs? }]`, `title?` | Runs up to 12 steps in order. `click` advances when the user clicks the highlighted control. |
| `clear_highlight` | — | Removes the element highlight and the guide, and clears overlay-card text highlights. |
| `back` | — | Browser back. |

Examples:

```jsonc
{ "action": "navigate", "target": "plugin:solatrix/settings/agent-access" }
{ "action": "highlight", "target": "control:solatrix/agent-access/mode", "text": "Set this to Read-only" }
{ "action": "highlight", "query": "show the chart source switch", "text": "Switch the source here", "style": "arrow" }
{ "action": "guide", "title": "Add an API key", "steps": [
  { "target": "control:apikeys/add", "text": "Click **+ Add Key**", "advance": "click" },
  { "target": "control:apikeys/dialog/provider", "text": "Pick your provider", "advance": "click" },
  { "target": "control:apikeys/dialog/key", "text": "Paste the key, then Save" } ] }
```

Failures come back as structured codes the agent can act on:

- `AMBIGUOUS_TARGET`, with `candidates`
- `TARGET_UNAVAILABLE`, with `fixTarget`, for example `plugin:infinitrade/enable`
- `TARGET_NOT_FOUND`
- `NO_UI_CLIENT`

In the browser, `result.found`, `inPlace`, `usedFallback`, `route` and `steps`
report exactly what happened.

## 3. Scoping (who sees it)

`src/gateway/ui-guide.ts` → `pickGuideTabs` picks exactly one tab:

1. An explicit `connId`, a `tab` codename or an `instanceId`.
2. The tab that sent `chat.send` in the agent's session within the last
   30 minutes. `ui_control` passes the agent's own session key, and the agent
   cannot override it.
3. The user's focused tab. If none is focused, the most recently active tab.
   Browsers report focus, visibility and interaction through
   `ui.client.activity`, and an interaction marks that tab as focused.

`scope: "all"` fans out to every tab of the same user. In cloud that means the
same tenant and the same member email.

A targeted `ui.request` is written only to that tab's socket; it is never
broadcast. This fixes the duplicate actions across tabs.

Candidate tabs are always filtered to the tenant namespace of the current
request scope, so nothing reaches another tenant's browser.

## 4. Rendering

`<ib-guide-layer>` (`ui/src/ui/guide/guide-layer.ts`) is mounted on `<html>`,
outside the zoomed `<body>`.

- **Ring.**
  - Tracks the element every frame and is clipped to scroll containers.
  - Uses a rotating gold sheen; the pulse style adds a ripple.
  - The spotlight style dims the rest of the page, and the arrow style adds a
    bouncing pointer.
- **Callout.**
  - Shows the agent's monogram and name, plus a `via MCP/voice/Telegram` chip.
  - Renders inline `**bold**` and `` `code` ``.
  - Guides get step dots, Back and Next buttons, and a click-to-continue hint.
  - The callout sits beside dialogs rather than over them. On screens 640px
    wide or less it becomes a bottom sheet.
- **Behaviour.**
  - The layer never blocks clicks: its host is `pointer-events: none`.
  - Esc or ✕ dismisses it, and `aria-live` announces each callout.
  - Animation stops under `prefers-reduced-motion`.

The runner (`ui/src/ui/guide/runner.ts`) highlights in place when the control
is already on screen. It falls back to the ⋯ menu when a topbar control has
overflowed. On phones it scrolls the horizontal nav strip, and it expands
collapsed sidebar groups and plugin sections.

## 5. Adding a target

1. Add `data-ib-target="<id>"` to the element. The id must be unique in the
   DOM; a templated id such as `data-ib-target=${`control:coders/${id}`}` is
   fine.
2. Register the id: derive it (a nav, manifest or learn source) or add it to
   `curated.ts` with `title`, `description`, `keywords`, `route`/`reveal` and
   `selectors`.
3. `pnpm ui-targets:gen`. `src/ui-targets/ui-targets.test.ts` fails if a
   `data-ib-target` literal is unregistered, used twice, or points to a route
   that doesn't exist.
