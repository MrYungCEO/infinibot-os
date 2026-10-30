/**
 * terminals/panels — the panel <-> PTY model for the mobile Terminals screen.
 *
 * Mobile parity for the web fix in `ui/src/ui/controllers/terminals.ts`
 * (send-panel-to-workspace + reference-counted teardown). Pure functions, no
 * React and no gateway, so the semantics that actually matter — "closing a
 * duplicate must not kill the shared PTY" — are unit-testable.
 *
 * The model
 * ---------
 * The gateway hands us a flat list of live PTYs (`terminal.list`). Historically
 * the screen rendered that list 1:1, so a PTY *was* a panel and closing the
 * panel meant destroying the PTY. That conflates two different things:
 *
 *   PTY    — the process. Owned by the gateway. Identified by `ptyId`.
 *   panel  — a VIEW of a PTY. Owned by this client. Identified by `panelId`.
 *
 * A panel carries:
 *   { panelId, ptyId, nodeId, workspace }
 *
 * For an ordinary panel `panelId === ptyId` (the historical 1:1 case, so
 * nothing changes). A DUPLICATED panel gets a fresh `panelId` but keeps the
 * source's `ptyId`, so several panels — possibly in different workspaces —
 * mirror one live terminal.
 *
 * That buys the two behaviours:
 *
 *   1. Send to workspace — changing `panel.workspace` re-parents the VIEW.
 *      No RPC is issued at all, so the PTY never notices it moved.
 *
 *   2. Duplicate-safe close — `closePanel` reference-counts panels by `ptyId`
 *      and only reports `destroyPty: true` when the panel being closed was the
 *      LAST one referencing that PTY. Closing a duplicate just detaches the
 *      view.
 *
 * Workspaces are numbered from 1 and are per-node: workspace 2 on `local` is a
 * different set of panels from workspace 2 on a satellite, which matches how
 * the screen already scopes everything by the selected federation node.
 */

/** Workspace numbering starts at 1 (matches the web's numbered workspaces). */
export const FIRST_WORKSPACE = 1;

/** Panels beyond this per node/workspace is almost certainly a runaway loop. */
export const MAX_PANELS = 24;

/** Fresh panel id for a duplicate. Never collides with a gateway PTY id. */
export function generatePanelId() {
  return `panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The backing PTY id for a panel. Ordinary panels are their own PTY. */
export function ptyIdOf(panel) {
  if (!panel) return null;
  return panel.ptyId || panel.panelId;
}

/** True when this panel is a mirror of another panel's PTY. */
export function isMirror(panel) {
  return Boolean(panel && panel.ptyId && panel.ptyId !== panel.panelId);
}

/** How many live panels currently reference a given PTY (the reference count). */
export function refCount(panels, ptyId) {
  if (!ptyId) return 0;
  return (panels || []).filter((p) => ptyIdOf(p) === ptyId).length;
}

/**
 * True when closing `panelId` would remove the last view of its PTY — i.e. when
 * the PTY should actually be destroyed. An unknown panel id is treated as "not
 * the last ref" so a stale tap can never destroy a session.
 */
export function isLastRef(panels, panelId) {
  const panel = (panels || []).find((p) => p.panelId === panelId);
  if (!panel) return false;
  return refCount(panels, ptyIdOf(panel)) <= 1;
}

/** ptyId -> [panelId, ...]. Drives PTY-output fan-out to every mirror. */
export function indexByPty(panels) {
  const index = new Map();
  for (const p of panels || []) {
    const pid = ptyIdOf(p);
    if (!pid) continue;
    if (!index.has(pid)) index.set(pid, []);
    index.get(pid).push(p.panelId);
  }
  return index;
}

/** Every panel id currently showing `ptyId`. Falls back to the PTY's own id. */
export function panelsForPty(panels, ptyId) {
  const hits = (panels || []).filter((p) => ptyIdOf(p) === ptyId).map((p) => p.panelId);
  // Before the first reconcile there may be no panel yet for a PTY that is
  // already streaming; addressing it by its own id preserves the 1:1 behaviour.
  return hits.length ? hits : [ptyId];
}

/**
 * Reconcile the local panel list against the gateway's PTY list.
 *
 * - every PTY with no panel gets one (panelId === ptyId, workspace 1)
 * - every panel whose PTY is gone from the server list is dropped, INCLUDING
 *   its mirrors — the process is dead, so no view of it is meaningful
 * - panels for PTYs on other nodes are left untouched (the screen only ever
 *   receives the terminals it has fetched, and dropping unseen nodes' panels
 *   would wipe a workspace every time the user switched node)
 *
 * @param panels     current panel list
 * @param terminals  gateway terminals: [{ id, nodeId }, ...]
 * @param opts.scopeNodeIds  only reconcile removals within these node ids.
 *                           Omit to reconcile against every node present in
 *                           `terminals`.
 */
export function reconcilePanels(panels, terminals, opts = {}) {
  const list = Array.isArray(panels) ? panels : [];
  const terms = Array.isArray(terminals) ? terminals : [];
  const liveIds = new Set(terms.map((t) => t.id));

  const scope =
    opts.scopeNodeIds != null
      ? new Set(opts.scopeNodeIds)
      : new Set(terms.map((t) => t.nodeId));

  // Drop panels whose PTY no longer exists — but only inside the scope we
  // actually have fresh data for.
  const kept = list.filter((p) => {
    if (!scope.has(p.nodeId)) return true;
    return liveIds.has(ptyIdOf(p));
  });

  // Adopt any PTY that has no panel yet.
  const covered = new Set(kept.map((p) => ptyIdOf(p)));
  const adopted = [];
  for (const t of terms) {
    if (covered.has(t.id)) continue;
    covered.add(t.id);
    adopted.push({
      panelId: t.id,
      ptyId: t.id,
      nodeId: t.nodeId,
      workspace: FIRST_WORKSPACE,
    });
  }

  if (adopted.length === 0 && kept.length === list.length) return list;
  return [...kept, ...adopted];
}

/** Panels on one node, in one workspace, in list order. */
export function panelsIn(panels, nodeId, workspace) {
  return (panels || []).filter(
    (p) => p.nodeId === nodeId && p.workspace === workspace,
  );
}

/** Highest workspace number in use on a node (at least FIRST_WORKSPACE). */
export function workspaceCount(panels, nodeId) {
  let max = FIRST_WORKSPACE;
  for (const p of panels || []) {
    if (p.nodeId !== nodeId) continue;
    if (p.workspace > max) max = p.workspace;
  }
  return max;
}

/** Sorted list of workspace numbers that hold at least one panel on a node. */
export function occupiedWorkspaces(panels, nodeId) {
  const seen = new Set();
  for (const p of panels || []) {
    if (p.nodeId === nodeId) seen.add(p.workspace);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Move a panel to another numbered workspace WITHOUT touching its PTY.
 *
 * `target` may be `workspaceCount + 1` (or higher) to create a brand-new
 * numbered workspace, exactly like the web's "New workspace N+1" option.
 * Returns the same array reference when nothing changed, so a caller can use
 * identity to skip a re-render.
 */
export function sendPanelToWorkspace(panels, panelId, target) {
  const list = Array.isArray(panels) ? panels : [];
  const panel = list.find((p) => p.panelId === panelId);
  if (!panel) return list;

  let tgt = Math.floor(Number(target));
  if (!Number.isFinite(tgt) || tgt < FIRST_WORKSPACE) tgt = FIRST_WORKSPACE;
  if (tgt === panel.workspace) return list;

  return list.map((p) => (p.panelId === panelId ? { ...p, workspace: tgt } : p));
}

/**
 * Mirror a panel: a second panel sharing the SAME backing PTY.
 *
 * The mirror lands beside its source (same node + workspace) and never spawns
 * its own process. Returns `{ panels, panel }`, or `{ panels, panel: null }`
 * when the source is unknown or the workspace is already at MAX_PANELS.
 */
export function duplicatePanel(panels, panelId, newPanelId = generatePanelId()) {
  const list = Array.isArray(panels) ? panels : [];
  const src = list.find((p) => p.panelId === panelId);
  if (!src) return { panels: list, panel: null, error: 'Panel not found' };

  if (panelsIn(list, src.nodeId, src.workspace).length >= MAX_PANELS) {
    return {
      panels: list,
      panel: null,
      error: `Workspace ${src.workspace} is full (${MAX_PANELS} panels).`,
    };
  }

  const mirror = {
    panelId: newPanelId,
    ptyId: ptyIdOf(src), // share the source's PTY
    nodeId: src.nodeId,
    workspace: src.workspace,
  };
  return { panels: [...list, mirror], panel: mirror };
}

/**
 * Close a panel.
 *
 * This function does NOT talk to the gateway — it decides whether the caller
 * should. `destroyPty` is true ONLY when the closed panel was the last view of
 * its PTY; otherwise the panel is detached and the session keeps running in
 * whichever panels remain (possibly in another workspace).
 *
 * @returns { panels, destroyPty, ptyId, nodeId, remainingRefs }
 */
export function closePanel(panels, panelId) {
  const list = Array.isArray(panels) ? panels : [];
  const panel = list.find((p) => p.panelId === panelId);
  if (!panel) {
    return {
      panels: list,
      destroyPty: false,
      ptyId: null,
      nodeId: null,
      remainingRefs: 0,
    };
  }

  const ptyId = ptyIdOf(panel);
  const next = list.filter((p) => p.panelId !== panelId);
  const remainingRefs = refCount(next, ptyId);

  return {
    panels: next,
    destroyPty: remainingRefs === 0,
    ptyId,
    nodeId: panel.nodeId,
    remainingRefs,
  };
}

/**
 * Pick the panel that should be focused after `panelId` left the current view
 * (was closed, or sent to another workspace). Prefers the last remaining panel
 * in the same node+workspace, mirroring the web's "hand focus to another panel
 * still in view". Returns null when the workspace is now empty.
 */
export function nextActivePanel(panels, nodeId, workspace, excludeId) {
  const remaining = panelsIn(panels, nodeId, workspace).filter(
    (p) => p.panelId !== excludeId,
  );
  return remaining.length ? remaining[remaining.length - 1].panelId : null;
}

export default {
  FIRST_WORKSPACE,
  MAX_PANELS,
  generatePanelId,
  ptyIdOf,
  isMirror,
  refCount,
  isLastRef,
  indexByPty,
  panelsForPty,
  reconcilePanels,
  panelsIn,
  workspaceCount,
  occupiedWorkspaces,
  sendPanelToWorkspace,
  duplicatePanel,
  closePanel,
  nextActivePanel,
};
