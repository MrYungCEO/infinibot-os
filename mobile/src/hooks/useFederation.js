/**
 * useFederation — Hook for Federation node selection, directory, and remote invocation.
 *
 * Provides:
 *   - nodes:            list of federation nodes from `federation.nodes.list`
 *   - selectedNodeId:   currently routed node (persisted in AsyncStorage, broadcast to gateway)
 *   - selectNode(id):   change the active node and broadcast selection so web mirrors it
 *   - directories:      federated directories from `federation.resources.directories`
 *   - refreshDirs:      manual refresh
 *   - invokeOnNode:     send an arbitrary method to the selected (or specified) node.
 *                       Local node falls through to the local gateway; remote nodes go via
 *                       `federation.node.invoke`.
 *   - sendChatToNode:   convenience for routing a chat message to selected node.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SELECTION_KEY = '@moltbot/federation_selected_node';
const LOCAL_NODE_ID = 'local';

const FALLBACK_LOCAL_NODE = {
  id: LOCAL_NODE_ID,
  name: 'Local',
  status: 'online',
  role: 'standalone',
  isLocal: true,
};

export function useFederation(gateway) {
  const [nodes, setNodes] = useState([FALLBACK_LOCAL_NODE]);
  const [selectedNodeId, setSelectedNodeId] = useState(LOCAL_NODE_ID);
  const [directories, setDirectories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dirsLoading, setDirsLoading] = useState(false);
  const [error, setError] = useState(null);

  const pollRef = useRef(null);
  const lastBroadcastRef = useRef(0);

  // ── Load persisted selection ──
  // Runs once per mount. `hydrated` flips true once AsyncStorage has answered
  // so downstream effects can wait for the persisted id before acting.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(SELECTION_KEY);
        if (!cancelled && stored) setSelectedNodeId(stored);
      } catch {}
      if (!cancelled) setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Fetch nodes ──
  const refreshNodes = useCallback(async () => {
    if (!gateway?.sendReq) return;
    setLoading(true);
    try {
      const res = await gateway.sendReq('federation.nodes.list', {});
      const list = Array.isArray(res?.nodes) ? res.nodes : [];
      // Always ensure a local entry exists for routing purposes.
      const hasLocal = list.some((n) => n.isLocal || n.id === LOCAL_NODE_ID);
      const merged = hasLocal ? list : [FALLBACK_LOCAL_NODE, ...list];
      setNodes(merged);
      setError(null);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  // ── Fetch federated directories ──
  const refreshDirs = useCallback(async () => {
    if (!gateway?.sendReq) return;
    setDirsLoading(true);
    try {
      const res = await gateway.sendReq('federation.resources.directories', {});
      const list = Array.isArray(res?.directories) ? res.directories : [];
      setDirectories(list);
    } catch (err) {
      console.debug('[useFederation] directory fetch failed:', err?.message);
    } finally {
      setDirsLoading(false);
    }
  }, [gateway]);

  // ── Broadcast selection so web/desktop can mirror ──
  const broadcastSelection = useCallback(async (nodeId) => {
    if (!gateway?.sendReq) return;
    const now = Date.now();
    if (now - lastBroadcastRef.current < 500) return;
    lastBroadcastRef.current = now;
    try {
      await gateway.sendReq('federation.selection.set', {
        deviceId: 'mobile',
        nodeId,
        timestamp: now,
      });
    } catch (err) {
      // Server method may not exist on older gateways; ignore quietly.
      console.debug('[useFederation] broadcast skipped:', err?.message);
    }
  }, [gateway]);

  // ── Persist + broadcast on selection change ──
  const selectNode = useCallback(async (nodeId) => {
    const next = nodeId || LOCAL_NODE_ID;
    setSelectedNodeId(next);
    try { await AsyncStorage.setItem(SELECTION_KEY, next); } catch {}
    broadcastSelection(next);
  }, [broadcastSelection]);

  // ── Initial fetch + poll ──
  useEffect(() => {
    if (!gateway?.sendReq || gateway.status !== 'connected') return;
    refreshNodes();
    refreshDirs();
    pollRef.current = setInterval(() => {
      refreshNodes();
    }, 15_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [gateway?.status, refreshNodes, refreshDirs]);

  // ── Resolve currently selected node object ──
  // If the persisted id isn't in the roster yet (mount race or satellite
  // briefly offline), synthesize a stub so the picker label stays anchored to
  // the user's last choice instead of snapping back to "Local". The stub is
  // replaced as soon as the matching real node appears in `nodes`.
  const matched = nodes.find((n) => n.id === selectedNodeId);
  const stale = !matched
    && selectedNodeId
    && selectedNodeId !== LOCAL_NODE_ID
    ? {
        id: selectedNodeId,
        name: selectedNodeId,
        status: loading ? 'connecting' : 'offline',
        isLocal: false,
        role: 'satellite',
      }
    : null;
  const selectedNode = matched
    || stale
    || nodes.find((n) => n.isLocal)
    || FALLBACK_LOCAL_NODE;

  const isLocalSelected = selectedNode.isLocal || selectedNode.id === LOCAL_NODE_ID;

  // ── Invoke a method on a node (selected by default) ──
  const invokeOnNode = useCallback(async (method, params = {}, nodeIdOverride) => {
    if (!gateway?.sendReq) throw new Error('Gateway not ready');
    const targetId = nodeIdOverride || selectedNodeId;
    const target = nodes.find((n) => n.id === targetId);
    const local = !target || target.isLocal || target.id === LOCAL_NODE_ID;
    if (local) {
      return gateway.sendReq(method, params);
    }
    return gateway.sendReq('federation.node.invoke', {
      nodeId: targetId,
      method,
      params,
    });
  }, [gateway, selectedNodeId, nodes]);

  // ── Convenience: send a chat message to selected node ──
  const sendChatToNode = useCallback(async ({ message, sessionKey, agentId, label }) => {
    if (!gateway?.sendReq) throw new Error('Gateway not ready');
    if (isLocalSelected) {
      return gateway.sendMessage(message);
    }
    // Remote: spawn or send via federation.node.invoke
    if (sessionKey) {
      return gateway.sendReq('federation.node.invoke', {
        nodeId: selectedNodeId,
        method: 'session.send',
        params: { sessionKey, message },
      });
    }
    return gateway.sendReq('federation.node.invoke', {
      nodeId: selectedNodeId,
      method: 'session.spawn',
      params: { message, agentId: agentId || 'main', label: label || 'Mobile chat' },
    });
  }, [gateway, isLocalSelected, selectedNodeId]);

  return {
    // State
    nodes,
    selectedNodeId,
    selectedNode,
    isLocalSelected,
    directories,
    loading,
    dirsLoading,
    error,
    hydrated,
    // Actions
    selectNode,
    refreshNodes,
    refreshDirs,
    invokeOnNode,
    sendChatToNode,
  };
}

export default useFederation;
