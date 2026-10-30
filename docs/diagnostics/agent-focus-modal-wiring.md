# Agent Focus Modal — wiring note

A new robust, gamified agent inspector lives at
`ui/src/ui/components/agent-focus-modal.ts` (`<agent-focus-modal>`). It replaces
the old slide-in `<agent-focus-panel>` for the mesh-click flow on the isometric
world (`<agency-world-viz>`), matching/exceeding the Activity page's
`<subagent-detail-modal>` information density in the gold-on-black isometric
aesthetic.

## Public contract

```ts
// Registered globally by mountAgentFocusModal() (called from app-render.ts).
window.openAgentFocus(target)
```

`target` may be:
- a **string** — an `agentId`, `sessionKey`, or `runId`; the modal resolves the
  rest via `subagents.list`.
- an **object** — a MeshAgent-like record
  (`{ sessionKey, agentId, runId, status, progress, label, currentTask,
  coderBackend, nodeId, kanbanTaskId, ... }`) **or** `{ agent, review }`
  (the exact `agency-agent-select` detail shape).

Also openable via a CustomEvent (for surfaces that can't reach `window`):

```ts
window.dispatchEvent(new CustomEvent("infinibot:open-agent-focus", {
  detail: { agent: meshAgent }   // or { target: "<runId>" }
}));
```

`closeAgentFocus()` and `mountAgentFocusModal(client, requestUpdate?)` are also
exported from the module.

## Mount

`mountAgentFocusModal(client)` is already called once from `app-render.ts`
(right next to `mountSubagentDetailListener`). It:
- stores the gateway client,
- registers `window.openAgentFocus`,
- registers the `infinibot:open-agent-focus` event bridge,
- registers a **dev hotkey `Ctrl+Shift+A`** that opens the first active agent
  (used for visual verification).

The modal self-mounts a single `<agent-focus-modal>` element to `document.body`
on first open — no markup changes are needed in any view.

## FOLLOW-UP (owned by mesh-badges agent 8cjq)

`ui/src/ui/components/agency-world-viz.ts` and
`ui/src/ui/components/gpu-animation-panel.ts` currently route a mesh agent click
through the `agency-agent-select` event → old `<agent-focus-panel>` (in
`dashboard.ts` / `gpu-animation-panel.ts`). Those files were owned by another
agent at the time this modal was built, so they were intentionally **not**
edited here.

Once 8cjq is done, the mesh-click handler should call:

```ts
window.openAgentFocus(detail.agent);   // detail = agency-agent-select detail
```

instead of (or in addition to) setting the old slide-in panel's `.agent`/`.open`.
The old `<agent-focus-panel>` can then be removed from the dashboard band and
grid host. No other call sites need to change — the contract is the single
`window.openAgentFocus(...)` entry point.
