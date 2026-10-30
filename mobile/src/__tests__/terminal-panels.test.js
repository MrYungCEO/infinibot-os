/**
 * terminals/panels unit tests (node env — no RN renderer, matches the existing
 * mesh-layout.test.js pattern).
 *
 * These lock in the two semantics the web fix established
 * (ui/src/ui/controllers/terminals.ts):
 *
 *  1. Sending a panel to another numbered workspace moves the VIEW only —
 *     no PTY teardown, and the session is intact in the destination.
 *  2. Closing a panel is reference-counted — a duplicate detaches, and the PTY
 *     is destroyed only when the LAST panel referencing it closes, even when
 *     the mirrors live in different workspaces.
 */
'use strict';

const {
  FIRST_WORKSPACE,
  MAX_PANELS,
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
} = require('../terminals/panels');

const NODE = 'local';

/** Panels adopted from a gateway terminal list — the 1:1 starting state. */
function seed(ids = ['t1', 't2']) {
  return reconcilePanels([], ids.map((id) => ({ id, nodeId: NODE })));
}

describe('panel <-> PTY identity', () => {
  test('an ordinary panel is its own PTY', () => {
    const [p] = seed(['t1']);
    expect(p.panelId).toBe('t1');
    expect(ptyIdOf(p)).toBe('t1');
    expect(isMirror(p)).toBe(false);
  });

  test('a mirror keeps its own panel id but the source PTY', () => {
    const { panels, panel } = duplicatePanel(seed(['t1']), 't1', 'mirror-1');
    expect(panel.panelId).toBe('mirror-1');
    expect(ptyIdOf(panel)).toBe('t1');
    expect(isMirror(panel)).toBe(true);
    expect(refCount(panels, 't1')).toBe(2);
  });
});

describe('reconcilePanels', () => {
  test('adopts one panel per gateway PTY, in workspace 1', () => {
    const panels = seed(['t1', 't2']);
    expect(panels).toHaveLength(2);
    expect(panels.every((p) => p.workspace === FIRST_WORKSPACE)).toBe(true);
  });

  test('is idempotent — a second pass returns the same array reference', () => {
    const panels = seed(['t1', 't2']);
    const terms = [{ id: 't1', nodeId: NODE }, { id: 't2', nodeId: NODE }];
    expect(reconcilePanels(panels, terms)).toBe(panels);
  });

  test('drops panels — and their mirrors — when the PTY dies server-side', () => {
    const { panels } = duplicatePanel(seed(['t1', 't2']), 't1', 'm1');
    expect(refCount(panels, 't1')).toBe(2);
    const next = reconcilePanels(panels, [{ id: 't2', nodeId: NODE }]);
    expect(next.map((p) => p.panelId)).toEqual(['t2']);
  });

  test('never drops panels for a node it has no fresh data about', () => {
    const panels = [
      { panelId: 'r1', ptyId: 'r1', nodeId: 'remote', workspace: 1 },
      { panelId: 't1', ptyId: 't1', nodeId: NODE, workspace: 1 },
    ];
    // Only local terminals were fetched — the remote panel must survive.
    const next = reconcilePanels(panels, [{ id: 't1', nodeId: NODE }], {
      scopeNodeIds: [NODE],
    });
    expect(next.map((p) => p.panelId).sort()).toEqual(['r1', 't1']);
  });

  test('does not resurrect a workspace assignment', () => {
    let panels = seed(['t1']);
    panels = sendPanelToWorkspace(panels, 't1', 3);
    const next = reconcilePanels(panels, [{ id: 't1', nodeId: NODE }]);
    expect(next.find((p) => p.panelId === 't1').workspace).toBe(3);
  });
});

describe('sendPanelToWorkspace', () => {
  test('moves the panel and leaves the PTY binding untouched', () => {
    const before = seed(['t1', 't2']);
    const after = sendPanelToWorkspace(before, 't1', 2);
    const moved = after.find((p) => p.panelId === 't1');
    expect(moved.workspace).toBe(2);
    // The identity that the PTY is addressed by has not changed at all.
    expect(ptyIdOf(moved)).toBe('t1');
    expect(refCount(after, 't1')).toBe(1);
    // ...and the other panel did not move.
    expect(after.find((p) => p.panelId === 't2').workspace).toBe(1);
  });

  test('the panel disappears from the source workspace and appears in the target', () => {
    const after = sendPanelToWorkspace(seed(['t1', 't2']), 't1', 2);
    expect(panelsIn(after, NODE, 1).map((p) => p.panelId)).toEqual(['t2']);
    expect(panelsIn(after, NODE, 2).map((p) => p.panelId)).toEqual(['t1']);
  });

  test('sending beyond the current count creates a new numbered workspace', () => {
    const before = seed(['t1', 't2']);
    expect(workspaceCount(before, NODE)).toBe(1);
    const after = sendPanelToWorkspace(before, 't1', workspaceCount(before, NODE) + 1);
    expect(workspaceCount(after, NODE)).toBe(2);
    expect(occupiedWorkspaces(after, NODE)).toEqual([1, 2]);
  });

  test('is a no-op for the current workspace, an unknown panel, or a bad target', () => {
    const before = seed(['t1']);
    expect(sendPanelToWorkspace(before, 't1', 1)).toBe(before);
    expect(sendPanelToWorkspace(before, 'nope', 2)).toBe(before);
    // A garbage target clamps to workspace 1 rather than creating NaN.
    expect(sendPanelToWorkspace(before, 't1', 'abc')).toBe(before);
    const moved = sendPanelToWorkspace(sendPanelToWorkspace(before, 't1', 4), 't1', -3);
    expect(moved.find((p) => p.panelId === 't1').workspace).toBe(FIRST_WORKSPACE);
  });
});

describe('duplicatePanel', () => {
  test('mirrors into the source workspace and shares the PTY', () => {
    const { panels, panel } = duplicatePanel(seed(['t1']), 't1', 'm1');
    expect(panel.workspace).toBe(1);
    expect(panelsForPty(panels, 't1').sort()).toEqual(['m1', 't1']);
  });

  test('a mirror can then be sent to another workspace, still sharing the PTY', () => {
    let { panels } = duplicatePanel(seed(['t1']), 't1', 'm1');
    panels = sendPanelToWorkspace(panels, 'm1', 2);
    expect(refCount(panels, 't1')).toBe(2);
    expect(panelsIn(panels, NODE, 1).map((p) => p.panelId)).toEqual(['t1']);
    expect(panelsIn(panels, NODE, 2).map((p) => p.panelId)).toEqual(['m1']);
  });

  test('refuses an unknown source and a full workspace', () => {
    expect(duplicatePanel(seed(['t1']), 'nope').panel).toBeNull();

    let panels = seed(['t1']);
    for (let i = 0; i < MAX_PANELS - 1; i++) {
      panels = duplicatePanel(panels, 't1', `m${i}`).panels;
    }
    expect(panelsIn(panels, NODE, 1)).toHaveLength(MAX_PANELS);
    const full = duplicatePanel(panels, 't1', 'overflow');
    expect(full.panel).toBeNull();
    expect(full.panels).toBe(panels);
  });
});

describe('closePanel — reference counting', () => {
  test('closing a lone panel destroys its PTY', () => {
    const res = closePanel(seed(['t1', 't2']), 't1');
    expect(res.destroyPty).toBe(true);
    expect(res.ptyId).toBe('t1');
    expect(res.remainingRefs).toBe(0);
    expect(res.panels.map((p) => p.panelId)).toEqual(['t2']);
  });

  test('closing a MIRROR detaches only — the PTY is never destroyed', () => {
    const { panels } = duplicatePanel(seed(['t1']), 't1', 'm1');
    const res = closePanel(panels, 'm1');
    expect(res.destroyPty).toBe(false);
    expect(res.remainingRefs).toBe(1);
    expect(res.panels.map((p) => p.panelId)).toEqual(['t1']);
  });

  test('closing the SOURCE while a mirror survives also only detaches', () => {
    // The source panel is not privileged — what matters is the reference count.
    const { panels } = duplicatePanel(seed(['t1']), 't1', 'm1');
    const res = closePanel(panels, 't1');
    expect(res.destroyPty).toBe(false);
    expect(res.remainingRefs).toBe(1);
    expect(panelsForPty(res.panels, 't1')).toEqual(['m1']);
  });

  test('the LAST panel referencing a PTY destroys it — exactly once', () => {
    let { panels } = duplicatePanel(seed(['t1']), 't1', 'm1');
    const first = closePanel(panels, 'm1');
    expect(first.destroyPty).toBe(false);
    const second = closePanel(first.panels, 't1');
    expect(second.destroyPty).toBe(true);
    expect(second.panels).toHaveLength(0);
  });

  test('refs are counted across ALL workspaces, not just the visible one', () => {
    let { panels } = duplicatePanel(seed(['t1']), 't1', 'm1');
    panels = sendPanelToWorkspace(panels, 'm1', 5);
    // Only 't1' is visible in workspace 1, but the PTY is still referenced.
    expect(panelsIn(panels, NODE, 1).map((p) => p.panelId)).toEqual(['t1']);
    const res = closePanel(panels, 't1');
    expect(res.destroyPty).toBe(false);
    expect(res.remainingRefs).toBe(1);
  });

  test('closing an unknown panel is inert — it can never destroy a session', () => {
    const panels = seed(['t1']);
    const res = closePanel(panels, 'ghost');
    expect(res.destroyPty).toBe(false);
    expect(res.panels).toBe(panels);
  });

  test('isLastRef agrees with closePanel', () => {
    const { panels } = duplicatePanel(seed(['t1']), 't1', 'm1');
    expect(isLastRef(panels, 'm1')).toBe(false);
    expect(isLastRef(panels, 'ghost')).toBe(false);
    const after = closePanel(panels, 'm1').panels;
    expect(isLastRef(after, 't1')).toBe(true);
  });
});

describe('output fan-out index', () => {
  test('one PTY maps to every panel mirroring it', () => {
    let { panels } = duplicatePanel(seed(['t1', 't2']), 't1', 'm1');
    panels = duplicatePanel(panels, 'm1', 'm2').panels; // mirror of a mirror
    const index = indexByPty(panels);
    expect(index.get('t1').sort()).toEqual(['m1', 'm2', 't1']);
    expect(index.get('t2')).toEqual(['t2']);
  });

  test('a mirror of a mirror still points at the ORIGINAL PTY', () => {
    let { panels } = duplicatePanel(seed(['t1']), 't1', 'm1');
    const { panel } = duplicatePanel(panels, 'm1', 'm2');
    expect(ptyIdOf(panel)).toBe('t1');
  });

  test('panelsForPty falls back to the PTY id before the first reconcile', () => {
    expect(panelsForPty([], 'brand-new')).toEqual(['brand-new']);
  });
});

describe('nextActivePanel', () => {
  test('hands focus to the last remaining panel in the same workspace', () => {
    const panels = seed(['t1', 't2', 't3']);
    expect(nextActivePanel(panels, NODE, 1, 't3')).toBe('t2');
  });

  test('returns null when the workspace empties', () => {
    const panels = seed(['t1']);
    expect(nextActivePanel(panels, NODE, 1, 't1')).toBeNull();
  });

  test('ignores panels in other workspaces', () => {
    const panels = sendPanelToWorkspace(seed(['t1', 't2']), 't2', 2);
    expect(nextActivePanel(panels, NODE, 1, 't1')).toBeNull();
  });
});
