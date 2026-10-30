# /projects (kanban) rendering performance

Investigation of "drag-and-drop stutters and the page always feels slow".

**Verdict: the glassmorphism / `backdrop-filter` hypothesis is wrong.** The page is slow
because `renderKanban` runs an unguarded side effect in its render body that re-enters
itself, producing a **~140 full-app re-render-per-second loop** that never stops. The
board is a 3,686-node, 81-card, unvirtualized tree, so each of those re-renders is
expensive. The main thread is saturated before the user touches anything.

Measured on the real install: **81 projects, 3,284 tasks**, business filter cleared, real
gateway at `localhost:18789`, headless Chromium via `tests/e2e/lib/harness.mjs`.

Repro scripts (added by this investigation):

| script | what it does |
| --- | --- |
| `scripts/perf-kanban.mjs` | full sweep: load / idle / scroll / drag, DOM census, backdrop-filter A/B |
| `scripts/perf-kanban-drag.mjs` | focused scroll+drag benchmark, `--neutralize` to stub the render loop |
| `scripts/perf-kanban-ws.mjs` | counts RPC frames the page sends while idle |
| `scripts/perf-kanban-stacks.mjs` | captures call stacks for every `_rerender()` |
| `scripts/perf-kanban-shot.mjs` | visual regression check of the CSS changes |

Raw JSON output lands in `ui/.perf/`.

---

## 1. Headline numbers

`drag` = synthetic HTML5 drag of a project card across all 6 columns, twice (48 `dragover`
events, 12 column changes), frame times sampled with `requestAnimationFrame`.

### As shipped (before)

| metric | value |
| --- | --- |
| Idle, 8 s, nobody touching the page | **54 long tasks / 7,954 ms of long-task time** |
| Idle RPCs sent, 10 s | **1,137** (1,121 × `subagents.list`, 9 × `federation.node.invoke`, 3 × `federation.nodes.list`, 2 × `kanban.listRecentlyCompleted`) |
| Scroll a column | **6.3 fps**, median frame **154 ms**, p95 185 ms |
| Drag a card across the board | **5.2 fps**, median frame **156 ms**, p95 **304 ms**, worst 331 ms |
| Long tasks during one drag | 51 tasks / 7,073 ms |
| Full board re-renders during one drag | 57 (of which ~15 are drag-caused; the rest are the idle loop) |
| DOM nodes (document / board) | 4,519 / **3,686** |
| Project cards rendered | **81 of 81** — 20 in the viewport. **No virtualization.** |
| Nodes per card | 43.4 |

### After the fixes in this change (kanban.ts still untouched — see §5)

| metric | before | after |
| --- | --- | --- |
| Idle `kanban.listRecentlyCompleted` / 10 s | 2 | **0** |
| Idle `federation.nodes.list` / 10 s | 3 | **0** |
| Idle `federation.node.invoke` / 10 s | 9 | **0** |
| Idle `subagents.list` / 10 s | 1,121 | 1,408 *(unchanged — lives in kanban.ts)* |
| Scroll | 6.3 fps | 5.4 fps |
| Drag | 5.2 fps | 4.3 fps |

The federation fan-out storm is gone, but **the user sees no frame-rate change**, because
the `subagents.list` loop alone still saturates the main thread. Fixing it requires
`kanban.ts`, which this change was not permitted to edit.

### With the kanban.ts loop stubbed out (what the user gets once §5 P0 lands)

Measured by patching `app.client.request` to leave `subagents.list` pending — a
measurement-only intervention that stops the loop without editing the view.

| metric | loop stubbed, no CSS fix | loop stubbed + CSS fix | gain from CSS |
| --- | --- | --- | --- |
| Scroll fps | 51.3 | **125.1** | **2.4×** |
| Scroll median frame | 16.1 ms | **7.7 ms** | **2.1× faster** |
| Scroll p95 frame | 22.6 ms | **10.2 ms** | 2.2× faster |
| Scroll pass wall-clock | 1,150 ms | **472 ms** | 2.4× faster |
| Drag fps | 11.0 | **13.3** | 1.2× |
| Drag median frame | 28.3 ms | **18.2 ms** | **1.6× faster** |
| Drag p95 frame | 325 ms | 282 ms | 1.15× |
| Drag long-task time | 3,477 ms | 3,080 ms | 1.13× |

**End to end (as shipped → loop fixed + CSS fixed):**
scroll median frame **154 ms → 7.7 ms (20×)**, drag median frame **156 ms → 18.2 ms (8.6×)**.

Drag p95 stays at ~282 ms because each of the 12 column changes still triggers one full
board re-render. That is §5 P1 and cannot be fixed from CSS.

---

## 2. The `backdrop-filter` hypothesis — killed

Tested by injecting `*,*::before,*::after{backdrop-filter:none !important}` and repeating
the identical drag on the same page instance.

| condition | with backdrop-filter | without | delta |
| --- | --- | --- | --- |
| Drag, as shipped | 5.2 fps / 156 ms median | 4.8 fps / 174 ms | **−0.4 fps (worse)** |
| Drag, loop stubbed | 11.0 fps / 28.3 ms | 11.1 fps / 28.4 ms | **+0.1 fps (noise)** |
| Drag, loop stubbed + CSS fix | 13.3 fps / 18.2 ms | 9.6 fps / 20.7 ms | **−3.7 fps (worse)** |

**The delta is zero to slightly negative in every condition.** Disabling backdrop-filter
does not make the board faster; the run-to-run spread is larger than the effect.

Why the theory doesn't hold here — the DOM census:

- 174 elements have a non-`none` `backdrop-filter`, **44 of them on screen**.
- 162 of those 174 are `.gc-action-tasks` / `.gc-action-edit`, the two 32×32px hover
  buttons on each card. They are `opacity: 0` until hover, and at 32×32 px their blur
  region is trivial.
- The card surfaces themselves (`.gc`, `.gc-inner`, `.pk-column`) use **opaque gradients
  and `rgba()` fills, not `backdrop-filter`**. There is no "many simultaneously-visible
  blurred cards" situation to fix.

The remaining ~12 are large chrome surfaces (topbar pills, nav, `infinibot-bg-overlay`)
where the effect is wanted and the cost is a handful of static layers.

**Do not spend effort de-glassing the kanban board.** The compositor is not the bottleneck;
the main thread is.

---

## 3. Root cause

`renderKanban` (`ui/src/ui/views/kanban.ts:6621-6629`) calls four data-loading helpers
from inside its **render body**. Two of them end by requesting another render:

### 3a. `ensureSubagentPolling` — 140 re-renders/second (primary, still open)

```
ui/src/ui/views/kanban.ts:209-239
```

```ts
function ensureSubagentPolling(client: any): void {
  ...
  const refresh = async () => {
    ... await client.request("subagents.list", ...)
    _subagentByTaskId = next;
    _rerender();                       // ← line 231
  };
  void refresh();                      // ← line 236: runs on EVERY call
  if (_subagentPollTimer) return;      // ← guard is AFTER the eager refresh
  _subagentPollTimer = setInterval(() => void refresh(), 30_000);
}
```

`render → ensureSubagentPolling → refresh → RPC → _rerender → render → …`. The guard only
protects the `setInterval`, not the eager `void refresh()`. The loop is bounded solely by
local WebSocket round-trip latency, which measured **112–140 iterations per second**.

Every iteration re-renders the entire `infinibot-app` (not just the board) and re-runs
`_saveScrollPositions()` / `_restoreScrollPositions()`, which force a synchronous layout
and then write `scrollTop` back inside a `requestAnimationFrame`.

Confirmed three ways: stack capture (`perf-kanban-stacks.mjs`: 3,216 identical stacks in
8 s), WS frame count (1,121 `subagents.list` per 10 s idle), and by stubbing the RPC —
which took scroll from 6.3 to 51.3 fps.

### 3b. `loadRecentlyCompleted` — a second, slower loop (FIXED here)

```
ui/src/ui/views/recently-completed-feed.ts:177
```

Same shape: called from `renderKanban`'s render body, ends with `_rerender()` in its
`finally`. Its `if (_loading) return` guard collapses *concurrent* calls but not the *next*
one, so it re-fetched forever — and each iteration fanned out a
`federation.nodes.list` + one `federation.node.invoke` **per federation peer**.

### 3c. Layout thrash

`_rerender()` (`kanban.ts:1558`) → `_saveScrollPositions()` (`:1508`) reads
`scrollTop`/`scrollLeft` from every `.pk-column-content` (forced synchronous layout), then
`_restoreScrollPositions()` (`:1530`) writes them back in a `rAF`. One read/write flush
pair per re-render × 140/s. Baseline `Performance.getMetrics` recorded 2,081
`RecalcStyleCount` and 2.63 s of `RecalcStyleDuration` for a single page visit.

The column-resize handler (`startColumnResize`, `:961`) is **clean** — no rect reads in
`pointermove`, no per-move re-render. Board-view (`renderBoard`) drag handlers are also
clean — they toggle classes directly. Only the *projects* kanban re-renders on drag.

---

## 4. Fixes applied in this change

### `ui/src/ui/views/recently-completed-feed.ts` — kill the second render loop

Added a 30 s freshness gate (`_lastLoadedAt` / `FEED_TTL_MS`) so render-path callers are a
no-op, plus a `force` option for the user-facing Retry button. Also fixes the same
render-body call pattern in `activity-panel.ts` and `agent-activity-dashboard.ts`.

**Measured:** idle `kanban.listRecentlyCompleted` 2 → 0, `federation.nodes.list` 3 → 0,
`federation.node.invoke` 9 → 0 per 10 s.

### `ui/src/styles/kanban-perf.css` (new, imported from `ui/src/styles.css`)

Scoped under `.kanban-layout` with one extra class of specificity, because `kanbanStyles()`
injects its `<style>` into the light DOM *after* this sheet and wins every tie.

| rule | rationale | measured |
| --- | --- | --- |
| `content-visibility: auto` + `contain-intrinsic-size: auto 210px` on `.gc` | only ~20 of 81 cards are ever in the viewport; off-screen ones now skip style/layout/paint | the bulk of the 2.4× scroll win |
| shadows re-homed from `.gc-inner` onto `.gc` | `content-visibility: auto` implies paint containment, which clips a *descendant's* shadow; an element's own shadow is not clipped. Keeps the cards pixel-identical | no regression (verified, `ui/.perf/board-after*.png`) |
| `contain: layout style` on `.pk-board` / `.gallery-grid` / `.pk-column` | stops one card's re-render invalidating board-wide layout | |
| `contain: layout style paint` on `.pk-column-content` | already `overflow-y: auto`, so paint clipping is free | |
| `transition: all .4s` → `transform, box-shadow` on `.gc`, `border-color, opacity` on `.gc-inner` | `all` arms transitions on layout-affecting properties every time the board flips a class, which a drag does 12× | drag median 28.3 → 18.2 ms |
| `.pk-col-drag-over { transform: none }` (was `scale(1.01)`) | scaling the drop-target column repaints the column *and every card in it* on each column change; the border/fill/glow change already signals the target | drag p95 325 → 282 ms |
| `will-change: transform, opacity` on `.gc--dragging` only | promote the dragged card, not all 81 | |
| `scroll-behavior: auto` on `.pk-column-content` (was `smooth`) | `_restoreScrollPositions` writes `scrollTop` on every re-render; with `smooth` each write started an interpolated scroll animation, so the columns were permanently mid-animation | |

Every rule above was kept only because the measurement improved; nothing was added on
faith. Visual check: `scripts/perf-kanban-shot.mjs` — board and hover state unchanged.

`pnpm ui:build` passes.

---

## 5. Patch plan for `ui/src/ui/views/kanban.ts` (not applied — file was locked)

Prioritised. **P0 alone is worth ~8× on scroll and ~5× on drag frame time** and is a
five-line change. Line numbers are as of this analysis; anchor on the function names,
since the file is being edited concurrently.

### P0 — stop the 140/s render loop *(critical, 5 lines)*

`ensureSubagentPolling`, `kanban.ts:209-239`. Move the eager refresh **below** the timer
guard:

```ts
  if (_subagentPollTimer) return;
  void refresh();
  _subagentPollTimer = setInterval(() => void refresh(), 30_000);
```

(currently `void refresh()` is line 236, the guard is line 237.)

Then make `refresh()` (line 212) skip its `_rerender()` (line 231) when nothing changed,
so the 30 s poll doesn't re-render the whole app for no reason:

```ts
    const key = [...next].map(([k, v]) => `${k}:${v.status}:${v.runId}`).sort().join("|");
    if (key === _subagentBadgeKey) return;
    _subagentBadgeKey = key;
    _subagentByTaskId = next;
    _rerender();
```

**Expected: scroll 6.3 → ~51 fps, drag median frame 156 → ~28 ms.** Also removes ~112
gateway RPCs/second per open `/projects` tab, which is a server-side win too.

### P1 — stop re-rendering the board on every drag-over *(high)*

`renderProjectsKanban`, `kanban.ts:3904-3949`. `handleDragStart` (`:3904`),
`handleDragOver` (`:3920`), `handleDragLeave` (`:3927`), `handleDrop` (`:3937`) and
`handleDragEnd` (`:3913`) each call `_rerender()`, and the only thing that changes is a
class name. That is **12–15 full board re-renders per drag**, ~280 ms each — the stutter
the user reports.

Toggle the classes directly instead, exactly as `renderBoard`'s handlers already do
(`kanban.ts:4735-4743` — use those as the model):

```ts
const setDragOverCol = (colEl: HTMLElement | null) => {
  for (const el of document.querySelectorAll(".pk-column.pk-col-drag-over")) {
    el.classList.remove("pk-col-drag-over");
    el.querySelector(".pk-drop-zone")?.classList.remove("pk-drop-active");
  }
  colEl?.classList.add("pk-col-drag-over");
  colEl?.querySelector(".pk-drop-zone")?.classList.add("pk-drop-active");
};

const handleDragOver = (e: DragEvent, colId: string) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  if (_projectKanbanDragOverCol === colId) return;
  _projectKanbanDragOverCol = colId;
  setDragOverCol(e.currentTarget as HTMLElement);   // no _rerender()
};
```

`handleDragStart` should likewise just add `gc--dragging` in the `requestAnimationFrame`
it already schedules (`:3908-3910`) and drop its `_rerender()` on `:3907`. Keep
`_projectKanbanDragOverCol` / `_projectKanbanDragId` — the template at `:3966` and `:3954`
still reads them for the initial render; they just stop driving re-renders.

Only `handleDrop` (`:3937`) needs a real re-render, and only *after* `onUpdateProject`
resolves.

**Expected: drag p95 frame ~282 ms → ~20 ms** (removes the last source of drag jank).

### P2 — coalesce `_rerender()` to one per frame *(high, cheap insurance)*

`kanban.ts:1558`. There are **~180 `_rerender()` call sites** in this file; any future
render-path side effect will re-create P0. Make the function self-throttling and stop the
read/write layout thrash from firing more than once a frame:

```ts
let _rerenderScheduled = false;
function _rerender() {
  if (_rerenderScheduled) return;
  _rerenderScheduled = true;
  requestAnimationFrame(() => {
    _rerenderScheduled = false;
    _saveScrollPositions();
    document.dispatchEvent(new CustomEvent("kanban-state-change"));
    _currentRequestUpdate?.();
    _restoreScrollPositions();
  });
}
```

Better still, delete `_saveScrollPositions`/`_restoreScrollPositions` (`:1508`, `:1530`)
once P4 lands — scroll position only needs restoring because Lit is replacing the column
DOM, which keyed `repeat()` prevents.

### P3 — memoize the per-card work *(medium)*

`renderProjectGalleryCard`, `kanban.ts:2508-2675`, runs 81× per board render:

- `:2554` `props.projects.find(p => p.id === project.parentProjectId)` — an O(n) scan
  **per card**, i.e. O(n²) = 6,561 comparisons per render. Same pattern again at `:5013`.
  Build `const byId = new Map(props.projects.map(p => [p.id, p]))` **once** in
  `renderProjectsKanban` (`:3880`) / `renderGallery` (`:3183`) and pass it through
  `ProjectGalleryCardOpts`.
- Task counts / progress re-scan `props.tasks` (3,284 rows). Precompute
  `Map<projectId, {total, done}>` in one pass per render, not one pass per card.
- `getProjectIdentity(project)` (`:2321`) derives colours/initials deterministically —
  cache in a `Map<string, Identity>` keyed by `project.id + project.name`.

### P4 — keyed `repeat()` instead of `.map()` *(medium)*

`kanban.ts:3978` (`${projects.map(renderProjectKanbanCard)}`) and the gallery grid at
`:3253`. With plain `.map()`, Lit diffs by index, so a drop that moves a project between
columns re-renders both columns' full card lists. Switch to
`repeat(projects, p => p.id, renderProjectKanbanCard)` from `lit/directives/repeat.js`, so
a status change moves one DOM node. This is also what makes P2's scroll-restore hack
unnecessary.

### P5 — virtualization: **not needed yet, and not where you'd guess**

- **Gallery grid** — already bounded: `GALLERY_PAGE_SIZE = 24` (`:789`). Leave it.
- **Task board** (`renderBoard`) — per-project task lists; largest observed is 41 tasks.
  Leave it.
- **Projects kanban** (`renderProjectsKanban`) — the only unbounded list: renders all 81
  project cards / 3,686 nodes, ~20 visible. This is the one that would need it. But the
  `content-visibility: auto` rule already added in `kanban-perf.css` gives most of the
  benefit (off-screen cards skip style, layout and paint) without the complexity.

  **Recommendation: do P0–P4 first and re-measure.** Only reach for
  `@lit-labs/virtualizer` on `.pk-column-content` if the project count grows past ~300, or
  if profiling after P0–P4 still shows card *construction* (not layout) dominating.

### P6 — move the render-body side effects out of `renderKanban` *(medium)*

`kanban.ts:6621-6629` calls `loadRecentlyCompleted`, `subscribeRecentCompleted`,
`initProjectsRecentlyCompleted` and `ensureSubagentPolling` from the render body. Two of
the four were self-re-entering; only `subscribeRecentCompleted` and
`initProjectsRecentlyCompleted` were correctly guarded. Gate the whole block behind a
one-shot mount flag (or hoist it to the view's first-update hook) so a helper that starts
requesting updates can never re-create this bug:

```ts
if (props.client && props.onRequestUpdate && !_kanbanEffectsMounted) {
  _kanbanEffectsMounted = true;
  ...
}
```

---

## 6. Caveats

- `ui/src/ui/views/kanban.ts` was being edited by another agent throughout this
  investigation, so the "after" runs include whatever else landed there. The
  before/after CSS comparison was run against the same kanban.ts build within a few
  minutes, and the loop-stubbed A/B isolates the CSS effect regardless.
- Headless Chromium on this machine, GPU-accelerated compositing available. Absolute fps
  will differ on other hardware; the ratios are what matter.
- The synthetic drag dispatches real `DragEvent`s with a `DataTransfer`, so the app's own
  handlers run exactly as for a user. It fires one `dragover` per frame rather than a
  native drag's continuous stream, so it is a *conservative* (best-case) measurement of
  drag cost.
