/**
 * useTerminalPanels — React binding for the panel <-> PTY model in `panels.js`.
 *
 * Owns the client-side panel list, the per-node active workspace, and the
 * persistence of both. Every decision that matters (which PTY a panel points
 * at, whether a close should destroy that PTY) is delegated to the pure
 * functions in `panels.js`, which are unit-tested in
 * `src/__tests__/terminal-panels.test.js`. This file is only wiring:
 * AsyncStorage, reconciliation against the gateway's terminal list, and the
 * one gateway call the model asks for (`terminal.destroy`, and only on the
 * last reference).
 *
 * The screen keeps talking about "terminals"; this hook is what makes a
 * terminal (a PTY, owned by the gateway) and a panel (a view, owned by us)
 * two separate things — which is what lets a panel move between workspaces
 * without a teardown, and lets a duplicate be closed without killing the
 * session it shares.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  FIRST_WORKSPACE,
  closePanel,
  duplicatePanel,
  generatePanelId,
  isMirror,
  nextActivePanel,
  occupiedWorkspaces,
  panelsForPty,
  panelsIn,
  ptyIdOf,
  reconcilePanels,
  refCount,
  sendPanelToWorkspace,
  workspaceCount,
} from './panels';

const PANELS_KEY = '@infinibot/terminals_panels';
const WORKSPACE_KEY = '@infinibot/terminals_active_workspace';

/**
 * @param opts.terminals      gateway terminal list ([{ id, nodeId, ... }])
 * @param opts.nodeId         the federation node currently being browsed
 * @param opts.destroyPty     async (ptyId, nodeId) => void — issues terminal.destroy
 * @param opts.onDetach       optional (panel, ptyId) => void, fired when a panel
 *                            is closed but its PTY survives in another panel
 */
export function useTerminalPanels({ terminals, nodeId, destroyPty, onDetach }) {
  const [panels, setPanels] = useState([]);
  const [activeWorkspaceByNode, setActiveWorkspaceByNode] = useState({});
  const [loaded, setLoaded] = useState(false);

  const activeWorkspace = activeWorkspaceByNode[nodeId] || FIRST_WORKSPACE;

  // ── Restore ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rawPanels, rawWs] = await Promise.all([
          AsyncStorage.getItem(PANELS_KEY),
          AsyncStorage.getItem(WORKSPACE_KEY),
        ]);
        if (cancelled) return;
        if (rawPanels) {
          const parsed = JSON.parse(rawPanels);
          // Reject anything that isn't a well-formed panel rather than letting
          // a corrupt entry poison the reference counting.
          if (Array.isArray(parsed)) {
            setPanels(
              parsed.filter(
                (p) =>
                  p &&
                  typeof p.panelId === 'string' &&
                  typeof p.nodeId === 'string' &&
                  Number.isFinite(p.workspace),
              ),
            );
          }
        }
        if (rawWs) {
          const parsed = JSON.parse(rawWs);
          if (parsed && typeof parsed === 'object') setActiveWorkspaceByNode(parsed);
        }
      } catch {
        // Corrupt entry — start clean; reconcile will re-adopt every live PTY.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Persist ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(PANELS_KEY, JSON.stringify(panels)).catch(() => {});
  }, [panels, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(
      WORKSPACE_KEY,
      JSON.stringify(activeWorkspaceByNode),
    ).catch(() => {});
  }, [activeWorkspaceByNode, loaded]);

  // ── Reconcile against the gateway's PTY list ──────────────────────────
  // Scoped to the node we actually fetched, so switching nodes never wipes
  // another node's workspaces.
  useEffect(() => {
    if (!loaded) return;
    setPanels((prev) =>
      reconcilePanels(prev, terminals || [], { scopeNodeIds: [nodeId] }),
    );
  }, [terminals, nodeId, loaded]);

  // ── Derived view ──────────────────────────────────────────────────────
  const termById = useMemo(() => {
    const m = new Map();
    for (const t of terminals || []) m.set(t.id, t);
    return m;
  }, [terminals]);

  /**
   * The panels shown right now: this node, this workspace, each merged with
   * its PTY's server record. `panelId` is the VIEW key (React keys, xterm
   * handles); `ptyId` is what every gateway call must use.
   */
  const visiblePanels = useMemo(
    () =>
      panelsIn(panels, nodeId, activeWorkspace)
        .map((p) => {
          const pty = termById.get(ptyIdOf(p));
          if (!pty) return null;
          return {
            ...pty,
            panelId: p.panelId,
            ptyId: ptyIdOf(p),
            workspace: p.workspace,
            isMirror: isMirror(p),
            refs: refCount(panels, ptyIdOf(p)),
          };
        })
        .filter(Boolean),
    [panels, nodeId, activeWorkspace, termById],
  );

  /** Every panel on this node regardless of workspace (for the index sheet). */
  const nodePanels = useMemo(
    () =>
      panels
        .filter((p) => p.nodeId === nodeId)
        .map((p) => {
          const pty = termById.get(ptyIdOf(p));
          if (!pty) return null;
          return {
            ...pty,
            panelId: p.panelId,
            ptyId: ptyIdOf(p),
            workspace: p.workspace,
            isMirror: isMirror(p),
            refs: refCount(panels, ptyIdOf(p)),
          };
        })
        .filter(Boolean),
    [panels, nodeId, termById],
  );

  const workspaces = useMemo(() => {
    const occupied = occupiedWorkspaces(panels, nodeId);
    // Always offer at least workspace 1, and always include the one we are
    // standing in even if the user just emptied it.
    const set = new Set(occupied.length ? occupied : [FIRST_WORKSPACE]);
    set.add(activeWorkspace);
    return Array.from(set).sort((a, b) => a - b);
  }, [panels, nodeId, activeWorkspace]);

  const nextWorkspace = useMemo(
    () => workspaceCount(panels, nodeId) + 1,
    [panels, nodeId],
  );

  const countIn = useCallback(
    (ws) => panelsIn(panels, nodeId, ws).length,
    [panels, nodeId],
  );

  /** Panel ids currently mirroring a PTY — the output fan-out target set. */
  const panelsRef = useRef(panels);
  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);
  const targetsForPty = useCallback(
    (ptyId) => panelsForPty(panelsRef.current, ptyId),
    [],
  );

  // ── Actions ───────────────────────────────────────────────────────────

  const setActiveWorkspace = useCallback(
    (ws) => {
      setActiveWorkspaceByNode((prev) =>
        prev[nodeId] === ws ? prev : { ...prev, [nodeId]: ws },
      );
    },
    [nodeId],
  );

  /**
   * Adopt a PTY that this client just spawned, so the panel lands in the
   * workspace the user is looking at rather than always workspace 1.
   */
  const adoptPanel = useCallback(
    (ptyId, targetNodeId, workspace = activeWorkspace) => {
      setPanels((prev) => {
        if (prev.some((p) => p.panelId === ptyId)) return prev;
        return [
          ...prev,
          { panelId: ptyId, ptyId, nodeId: targetNodeId, workspace },
        ];
      });
    },
    [activeWorkspace],
  );

  /**
   * Move a panel to another numbered workspace. Issues NO gateway call — the
   * PTY is untouched and keeps running; only the view is re-parented.
   * @returns the workspace it landed in
   */
  const sendToWorkspace = useCallback((panelId, target) => {
    setPanels((prev) => sendPanelToWorkspace(prev, panelId, target));
    return target;
  }, []);

  /**
   * Mirror a panel into a second panel sharing the same live PTY. No
   * terminal.create is issued — a mirror never spawns its own process.
   * @returns { panelId } of the mirror, or { error }
   */
  const duplicate = useCallback((panelId) => {
    const newId = generatePanelId();
    let result = { error: 'Panel not found' };
    setPanels((prev) => {
      const res = duplicatePanel(prev, panelId, newId);
      result = res.panel ? { panelId: res.panel.panelId } : { error: res.error };
      return res.panels;
    });
    return result;
  }, []);

  /**
   * Close a panel, reference-counted.
   *
   * The PTY is destroyed ONLY when this was the last panel referencing it.
   * Closing a duplicate (in this workspace or any other) merely detaches the
   * view and the session keeps running.
   *
   * @returns { destroyed: boolean, ptyId, remainingRefs }
   */
  const close = useCallback(
    async (panelId) => {
      const before = panelsRef.current;
      const res = closePanel(before, panelId);
      if (!res.ptyId) return { destroyed: false, ptyId: null, remainingRefs: 0 };

      setPanels(res.panels);

      if (res.destroyPty) {
        try {
          await destroyPty?.(res.ptyId, res.nodeId);
        } catch (err) {
          // The panel is already gone locally; a failed destroy is logged, not
          // rolled back — re-adding a panel for a PTY that may or may not be
          // alive would be worse than letting the next reconcile settle it.
          console.warn('[terminals] destroy failed:', err?.message || err);
        }
      } else {
        onDetach?.(panelId, res.ptyId);
      }

      return {
        destroyed: res.destroyPty,
        ptyId: res.ptyId,
        remainingRefs: res.remainingRefs,
      };
    },
    [destroyPty, onDetach],
  );

  /**
   * Which panel should take focus after `panelId` leaves the visible workspace
   * (closed, or sent elsewhere). Computed against the CURRENT panel list.
   */
  const focusAfter = useCallback(
    (panelId) => nextActivePanel(panelsRef.current, nodeId, activeWorkspace, panelId),
    [nodeId, activeWorkspace],
  );

  return {
    panels,
    loaded,
    visiblePanels,
    nodePanels,
    workspaces,
    activeWorkspace,
    nextWorkspace,
    setActiveWorkspace,
    countIn,
    targetsForPty,
    adoptPanel,
    sendToWorkspace,
    duplicate,
    close,
    focusAfter,
  };
}

export default useTerminalPanels;
