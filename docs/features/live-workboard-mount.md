# Mounting the Live Workboard under the Revenue pipeline

The delivery ⇄ autonomy split board (full projects kanban + autonomous work board
+ drag-to-assign handoff) is now a reusable render function:

```
ui/src/ui/components/live-workboard.ts  →  export function renderLiveWorkboard(host, client, options?)
```

It reads the **full** projects database (`kanban.projects.list` /
`kanban.tasks.list` — the same source as the `/projects` page), self-loads, keeps
itself live on `agency.work.updated`, and emits its own styles, so it can be
dropped into any view that has an app `host` and a gateway `client`.

This note describes the exact, conflict-free graft into **Agency Operations**
(`ui/src/ui/views/agency-operations.ts`) — a file another agent currently owns,
so it is intentionally left unedited here. Two additions, nothing else.

## 1. Add the import

At the top of `ui/src/ui/views/agency-operations.ts`, alongside the other view
imports, add:

```ts
import { renderLiveWorkboard, type LiveWorkboardHost } from "../components/live-workboard";
```

## 2. Add the render call beneath the Revenue pipeline

In `renderAgencyOperations(...)`, the Revenue pipeline lives in this section
(currently ~line 8420):

```ts
        <section class="aops-card aops-pipeline">
          <header><h2>Revenue pipeline</h2>...</header>
          ...
        </section>
```

Immediately **after that section's closing `</section>`**, drop in one line:

```ts
        <section class="aops-card">
          <header><h2>Live workboard</h2></header>
          ${renderLiveWorkboard(host as unknown as LiveWorkboardHost, client)}
        </section>
```

That is the whole graft. `host` is the same `AgencyOperationsHost` already in
scope; the cast is safe because `LiveWorkboardHost` only needs the optional
`requestUpdate` / `setTab` / `tab` / state-bag fields the app host already
carries, and `renderLiveWorkboard` creates the state bags it needs on first call.

### Compact variant (delivery kanban only, no autonomy half)

If a tighter section is wanted, pass options to render only the delivery kanban +
handoff bridge:

```ts
${renderLiveWorkboard(host as unknown as LiveWorkboardHost, client, { autonomy: false })}
```

`options` (all optional):

| field      | default | effect                                                        |
| ---------- | ------- | ------------------------------------------------------------- |
| `autonomy` | `true`  | include the autonomous work board half (full split view)      |
| `title`    | —       | render an `<h1>` heading above the board                       |

## Notes

- No backend change is required — the board uses existing gateway RPCs
  (`kanban.projects.list`, `kanban.tasks.list`, `agency.ops.employees.list`,
  `agency.ops.employee.*`, and the handoff/routing methods it already resolved).
- The board carries its own detail modals, mode switch, filters and handoff
  dialog; you do not need to render anything else beside it.
- After adding the two lines, rebuild the UI: `pnpm -C ui build`.
