# Learn tracks from plugins (`contributes.learn`)

A manifest-v2 plugin can ship its own **guided Learn track**. A track is a short course: an overview, 3–6 walkthroughs that run as overlay tours over the real app, a quick check (quiz) and a mastery badge. Plugin tracks show up on the Learn page under the plugin's monogram and accent. They also appear as **Take the tour** on the Plugins page and as the **Learn this** chip on the plugin's pages.

Tracks appear **only while the plugin is enabled and loaded**. Turn the plugin off and its tracks, missions and badges disappear from the catalog. The owner can also switch one track off (contribution key `learn:<trackId>`, Plugins › *plugin* › What it adds) without a restart.

- Schema and types: `src/learn/guided/types.ts`
- Validation (fail-closed, shared by gateway and UI): `src/learn/guided/validate.ts`
- Engine: `ui/src/learn/guided/engine.ts`
- Overlay: `ui/src/ui/components/guided-tour-overlay.ts`
- Core tracks, useful as worked examples: `src/learn/guided/core/*.ts`

## Declaring it

Put the content in a JSON file inside the plugin and point the manifest at it:

```jsonc
// infinibot.plugin.json
{
  "manifestVersion": 2,
  "contributes": {
    "learn": "learn.json"          // or { "file": "learn.json" }, or the object inline
  }
}
```

```jsonc
// learn.json
{
  "tracks": [ { /* LearnTrack */ } ],
  "missions": [ { "walkthrough": "myplugin/first-steps", "starter": true } ]
}
```

The file must be a `.json` file inside the plugin folder. If it is missing, unreadable or invalid, **the plugin does not load**, the same as any other malformed v2 declaration, and the error names the exact field.

## Track

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `a-z0-9-`. A plugin track must be named `<pluginId>` or `<pluginId>-*`. |
| `title`, `summary` | yes | Card title and one-line summary. |
| `overview` | yes | Markdown shown at the top of the track page. |
| `category` | yes for core | Plugin tracks default to "Plugins". |
| `level` | – | `beginner` (default) \| `intermediate` \| `advanced`. |
| `walkthroughs` | yes | 1–12 (aim for 3–6). |
| `quiz` | – | 2–6 options each; `answer` is the index of the correct option. **Answer keys never reach the browser**: the gateway strips them and grades `learn.guided.quiz.submit` on the server. You pass with 70% or more. |
| `badge` | – | `{ id, label, icon? }`. Plugin badges count as **plugin mastery** on the certification path. |
| `routes` | – | Paths this track teaches. They drive the contextual **Learn this** chip (the longest matching prefix wins). |
| `signals` | – | Tab ids whose use means the user already knows this area. "Recommended next" prefers tracks for areas the user hasn't touched. |
| `prerequisites` | – | Track ids that are recommended first. Advisory only. |
| `requires` | – | Condition; the track is listed only when it holds (see *Conditions*). |
| `disclaimer` | – | Shown prominently on the track page (medical, financial, legal). |
| `estMinutes`, `order`, `certRequired` | – | `certRequired` applies to core tracks only. |

## Walkthrough

`{ id, title, summary, estMinutes, steps[], prerequisites?, requires? }`. A `prerequisites` ref is `<walkthroughId>` within the same track, or `<trackId>/<walkthroughId>`.

## Step

| Field | Notes |
|---|---|
| `id`, `title`, `body` | `body` supports `**bold**`, `` `code` `` and line breaks. |
| `route` | The engine navigates here first, using the same router as the sidebar. Plugin routes and sub-views work, e.g. `/infinitrade/journal`, `/autonomy?view=goals`. |
| `target` | The element to spotlight: a CSS selector, `learn:<id>` (short for `[data-learn-id="<id>"]`), or a **list of fallbacks** tried in order. Selectors **pierce open shadow roots**. The first *visible* match wins. Leave it out for a centred card. |
| `placement` | `auto` (default) \| `top` \| `bottom` \| `left` \| `right` \| `center`. |
| `action` | Waits for the user to act: `{ kind: "click" }`, `{ kind: "toggle" }`, `{ kind: "input", match?, sample? }` or `{ kind: "navigate", path }`. `click`, `toggle` and `input` watch the step target unless `action.target` is set. `sample` is what the audit types, and what **Do it for me** fills in. |
| `check` | A condition polled until it holds; Next stays disabled until then. `checkHint` tells the user what to do. |
| `skipIf` | Skip the step when the condition holds, e.g. `{ "kind": "viewport", "maxWidth": 800 }` for sidebar-only steps. |
| `branches` | `[{ when, goto }]`, checked in order when the step completes. `goto` is a step id in the same walkthrough. |
| `practice` | `{ mode: "explain" \| "sandbox", note }`. **Required for any risky step** (see *Safe practice*). |
| `optional`, `waitMs` | `waitMs` (default 8000) is how long to wait for the target before offering *Retry / Skip*. |

### Conditions

```
pluginEnabled {plugin}   method {method}          surface {surface}
element {target}         route {path[?query]}     viewport {maxWidth?, minWidth?}
rpc {method, params?, path?, equals?|min?|includes?}
completed {ref}          not {condition}          all|any {conditions[]}
```

- **`rpc` checks may only call read-only methods.** A name ending in `list`, `get`, `status`, `snapshot`, `summary` and similar passes; anything that reads like a write (`set`, `create`, `send`, `place`, `sign`, `order`, `trade`…) is rejected when the manifest is validated. `path` is dotted, `*` maps over arrays, and `length` works too (`plugins.*.enabled`, `goals.length`). With no expectation the value must be truthy.
- `surface` asks whether a UI surface is compiled into the running build (`ui/src/learn/guided/surfaces.ts`). Use it to guard walkthroughs for newer UI.
- When deciding whether to list a track, `element`, `route` and `rpc` conditions count as satisfiable: a track is never hidden just because the user is on another page.

## Safe practice (required for risky steps)

Tours must never cause real-world side effects. Placing orders, signing on-chain transactions, sending messages to real people, spending credits or deleting data are all off limits.

- `practice.mode: "explain"`: the step spotlights the control and explains it, including the permission gate that protects it. The engine **never waits for or performs the action**; validation rejects an explain step that has an `action`.
- `practice.mode: "sandbox"`: the step works against paper, demo or mock data, and the note says which.
- Infinitrade and Solatrix tracks explain order and swap controls, and the `gated:orders` / Execute-swaps permission, only. Never click them.

## Design rules for good walkthroughs

1. **Target real chrome, not data.** Headers, tabs, toolbars, empty-state buttons and forms render on a fresh install. A row that only exists once the user has data needs a fallback list (`["learn:first-row", "learn:empty-state"]`) or a `skipIf`.
2. **Add `data-learn-id` to your components** for anything you target. It survives restyles, unlike class names.
3. **Keep a step to one idea**, and a body to no more than three sentences. Say what it is and why it matters.
4. **Mobile.** Steps aimed at desktop-only chrome (sidebar, wide toolbars) need `skipIf: { kind: "viewport", maxWidth: 800 }` or a fallback target.
5. **Actions teach; Next informs.** Use an `action` wherever doing beats reading. Pair it with a `check` when the result matters (e.g. an `rpc` check that a setting really changed).

## Developing without restarts

On a **side gateway** (never the live one: audit mode clicks real controls):

```bash
# list real, visible targets on a page (pierces shadow DOM)
BASE=http://127.0.0.1:<port> PW=<pw> node scripts/learn/probe-route.mjs /myplugin
BASE=… PW=… TEST='["learn:my-id", ".fallback"]' CLICK='learn:open-dialog' node scripts/learn/probe-route.mjs /myplugin

# inject your learn.json into the page and run every walkthrough in headless Chrome
BASE=… PW=… INJECT=extensions/myplugin/learn.json node --import tsx scripts/learn/audit-walkthroughs.mjs
```

In the browser console, `__infinibotLearn.register(track, { pluginId })` validates a track with the gateway's parser and adds it to the page's catalog. `__infinibotLearn.start(trackId, walkthroughId)` runs it.

The audit writes `report.md`, with steps passed/total per walkthrough. A walkthrough ships only when every step passes.

## Progress, sync and mobile

- Progress is stored per user in the gateway (`<state>/learn.sqlite`, tables `guided_*`) through `learn.guided.progress.update` / `quiz.submit` / `prefs.set`, so it follows the user across browsers and devices. The browser keeps a local mirror for instant paint and offline use.
- A tour interrupted by a reload resumes at the same step.
- `infinibot://learn/<trackId>[/<walkthroughId>]` opens the track (and starts the walkthrough) in the mobile app's web view.
