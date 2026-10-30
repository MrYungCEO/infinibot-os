name: interactive-graph-view
description: Build a new InfiniBot view with a Cytoscape.js node graph, click drawer, context menu, filters, and localStorage persistence.
---
# Interactive Graph View

## When to use
- User asks for a visual network/graph/funnel/flow/map page in InfiniBot (e.g. "agency funnel", "pipeline map", "workflow graph", "dependency tree")
- The view needs clickable nodes with a detail drawer, drag-to-reposition, and live data subscription
- Node layout must persist across sessions and export to PNG

## How to apply

1. **Load Cytoscape from CDN** — inject a `<script>` tag for `cytoscape.min.js` inside the component's shadow DOM render; do not npm-install it (build latency).

2. **Define node/edge data** as typed arrays (`FunnelNode[]`, `FunnelEdge[]`) with fields: `id`, `label`, `type`, `layer`, `volume`, `status`, `agentId?`, `url?`.

3. **Render the component** as a standard InfiniBot Lit component (`src/ui/views/<slug>.ts`) extending `LitElement` with `static styles = css\`...\`` and a shadow-DOM canvas container `<div id="cy"></div>`.

4. **Initialize Cytoscape** in `firstUpdated()`:
   - Container = `this.shadowRoot.getElementById('cy')`
   - Layout: `preset` (reads saved positions) falling back to `breadthfirst` or `cose`
   - Edge width expression: `Math.max(1.5, Math.log(volume+1)*1.5)`; dashed style for "cold" edges
   - Node color driven by `type` via a `NODE_COLORS` map

5. **Click drawer** — on `cy.on('tap', 'node', ...)` toggle a 320px right-panel inside the shadow DOM; populate with metrics, status badge, agent chip, URL field, quick-action buttons, and a system-prompt hint `<textarea>`.

6. **Right-click context menu** — on `cy.on('cxttap', 'node', ...)` render an absolutely-positioned `<ul>` with actions: Edit, Set as Goal, Assign Agent, Link URL, Reports, Delete. Remove on next `click`/`cxttap`.

7. **Section filter chips** — keep an `activeFilter` state; on change call `cy.elements().removeClass('hidden')` then `cy.elements('[layer != "X"]').addClass('hidden')` and `cy.layout({name:'preset'}).run()`.

8. **Persist positions** — `cy.on('dragfree', 'node', ...)` → `localStorage.setItem('infinibot.<slug>.v1', JSON.stringify(cy.nodes().map(n => ({id:n.id(), x:n.position('x'), y:n.position('y')}))))`. Restore in `firstUpdated()` before layout.

9. **Live toggle** — `window.addEventListener('infinibot:funnel:update', handler)` when the Live switch is on; update node data and call `cy.getElementById(id).data(patch)`.

10. **Active pulse** — `setInterval(() => cy.nodes('[status="active"]').flashClass('pulsing', 700), 2200)` started in `firstUpdated()`, cleared in `disconnectedCallback()`.

11. **Export PNG** button calls `cy.png({ full: true, scale: 2 })`, creates a temp `<a>` and clicks it.

12. **Register the view** — add the route in `src/ui/navigation.ts` (nav entry under the correct group) and export from `src/ui/views/index.ts`. Add the import in `src/ui/app-render.ts` case switch.

13. **Build and visual-verify** — run `pnpm -C ui build` (0 TS errors required), then invoke the `visual-verify-loop` skill to confirm the graph renders and the drawer opens on node click.

## Rules
- Never npm-install Cytoscape; always load from CDN script tag injected into shadow DOM
- Always clear intervals in `disconnectedCallback()` to avoid animation leaks
- Always use `preset` layout with saved positions as the primary layout; fall back to algorithmic only when no saved state exists
- Never use `position:fixed` for the click drawer — use absolute positioning inside the shadow host to avoid the containing-block trap from `.panel backdrop-filter`
- Always type node/edge arrays; never pass raw `any` objects to `cy.add()`
- Always gate the Cytoscape init behind `await import` or a CDN load promise so the canvas isn't initialized before the script is ready