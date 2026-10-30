/**
 * useFederatedTerminals — federation-wide PTY listing + per-node invocation.
 *
 * The gateway's `terminal.list` only enumerates terminals on the node
 * receiving the request. To see terminals running on other federation nodes
 * (desktop, other phones, satellites), we fan out `terminal.list` across all
 * known nodes via `federation.node.invoke` and merge — tagging each entry
 * with the node it lives on. Live `terminal.output` / `terminal.exit` events
 * already arrive on the master channel with a `federationNodeId` tag added
 * by the federation hub, so no per-node subscription is needed.
 *
 * Returns helpers for routing terminal actions (write/destroy/create/
 * agent.invoke) to the correct node — local goes through the local gateway,
 * remote goes through `federation.node.invoke`.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import { METHOD } from '../constants/gateway';
import { useFederation } from './useFederation';

const LOCAL_NODE_ID = 'local';
// Defense-in-depth poll cadence — matches useFederation's node-roster poll.
// Events are the primary detection path; this fills any gap if an event is
// missed (subscription churn, satellite reconnect, etc.).
const POLL_INTERVAL_MS = 15_000;

function isLocalNode(node) {
  return !node || node.isLocal === true || node.id === LOCAL_NODE_ID;
}

function unwrapInvokeResult(res) {
  // The federation tunnel (federation.node.invoke generic-proxy branch) wraps
  // the satellite's response as `{ status: 'ok', method, payload: <inner> }`.
  // Older paths returned the inner shape directly, or a `{ ok, result }`
  // envelope. Unwrap whichever shape we see.
  if (!res || typeof res !== 'object') return res;
  if ('payload' in res && !('terminals' in res)) {
    return res.payload ?? res;
  }
  if ('result' in res && !('terminals' in res)) {
    return res.result ?? res;
  }
  return res;
}

function mapTerminal(t, node) {
  let cli = 'shell';
  if (t.isClaudeMode || t.cliType === 'claude') cli = 'claude';
  else if (t.cliType === 'opencode') cli = 'opencode';
  else if (t.cliType === 'gemini') cli = 'gemini';
  else if (t.cliType === 'codex') cli = 'codex';
  else if (t.cliType === 'grok') cli = 'grok';
  else if (t.activeCLI) cli = t.activeCLI;
  return {
    id: t.id,
    title: t.title || t.name || cli,
    cli,
    cwd: t.cwd || '.',
    status: t.status === 'exited' ? 'exited' : 'running',
    createdAt: t.createdAt || new Date().toISOString(),
    nodeId: node?.id || LOCAL_NODE_ID,
    nodeName: node?.name || 'Local',
    isLocal: isLocalNode(node),
  };
}

export function useFederatedTerminals(gateway) {
  const federation = useFederation(gateway);
  const { nodes } = federation;
  const { sendReq, status, subscribeEvent } = gateway || {};

  const [terminals, setTerminals] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const nodesRef = useRef(nodes);
  const refreshRef = useRef(null);
  const terminalsRef = useRef(terminals);

  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // ── Resolve which node owns a given terminal id ────────────
  const nodeFor = useCallback((terminalId) => {
    const term = terminals.find((t) => t.id === terminalId);
    if (!term) return null;
    return nodesRef.current.find((n) => n.id === term.nodeId) || null;
  }, [terminals]);

  // ── Invoke a terminal method on the right node ─────────────
  // Local → direct gateway call. Remote → federation.node.invoke proxy.
  const invokeOnNode = useCallback(async (node, method, params) => {
    if (!sendReq) throw new Error('Gateway not ready');
    if (isLocalNode(node)) {
      return sendReq(method, params);
    }
    const wrap = await sendReq('federation.node.invoke', {
      nodeId: node.id,
      method,
      params,
    });
    return unwrapInvokeResult(wrap);
  }, [sendReq]);

  const invokeOnNodeId = useCallback(async (nodeId, method, params) => {
    const node = nodesRef.current.find((n) => n.id === nodeId)
      || (nodeId === LOCAL_NODE_ID
        ? { id: LOCAL_NODE_ID, isLocal: true, name: 'Local' }
        : null);
    if (!node) throw new Error(`Unknown federation node: ${nodeId}`);
    return invokeOnNode(node, method, params);
  }, [invokeOnNode]);

  // ── Fetch terminals from one node ──────────────────────────
  const fetchNodeTerminals = useCallback(async (node) => {
    if (!sendReq) return [];
    try {
      const res = await invokeOnNode(node, METHOD.TERMINAL_LIST, {});
      // invokeOnNode already unwraps `{ payload }` for remote calls, but the
      // tunneled shape can vary by code path — be defensive here too.
      const inner = res?.terminals ? res : res?.payload ?? res;
      const list = Array.isArray(inner?.terminals) ? inner.terminals : [];
      return list.map((t) => mapTerminal(t, node));
    } catch (err) {
      // Remote nodes can be offline; don't let one failure poison the list.
      console.debug(
        `[useFederatedTerminals] node ${node?.id || 'local'} list failed:`,
        err?.message || err,
      );
      return [];
    }
  }, [sendReq, invokeOnNode]);

  // ── Federation-wide refresh ────────────────────────────────
  const refresh = useCallback(async () => {
    if (!sendReq || status !== 'connected') return;
    setLoading(true);
    setError(null);
    try {
      const nodeList = nodesRef.current.length ? nodesRef.current : [{ id: LOCAL_NODE_ID, isLocal: true, name: 'Local' }];
      const results = await Promise.all(nodeList.map(fetchNodeTerminals));
      // Dedupe by id — if the same terminal id surfaces via multiple nodes
      // (master + satellite mirroring), keep the first (local takes priority
      // because nodes[] tends to list the local node first).
      const seen = new Set();
      const merged = [];
      for (const list of results) {
        for (const t of list) {
          if (!t.id || seen.has(t.id)) continue;
          seen.add(t.id);
          merged.push(t);
        }
      }
      setTerminals(merged);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [sendReq, status, fetchNodeTerminals]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // ── Re-fetch when connection or node set changes ───────────
  useEffect(() => {
    if (status === 'connected') refresh();
    // We deliberately depend on nodes.length, not nodes (object identity
    // churns on every poll). When new nodes appear we want to re-fetch.
  }, [status, nodes.length, refresh]);

  // ── Live spawn/destroy detection via lifecycle events ─────
  // Server-side, `terminal.created` / `terminal.destroyed` / `terminal.exit`
  // fire on every PTY transition (terminal.ts:163, :197). Satellites tee
  // these up to master, and master rebroadcasts tagged with
  // `federationNodeId` — see server-runtime-state.ts:443-466 + hub.ts:2327.
  // So one subscription catches spawn events from every node in the
  // federation. Event-driven path is instant; polling below is backstop.
  useEffect(() => {
    if (!subscribeEvent) return undefined;

    const resolveNode = (rawNodeId) => {
      if (!rawNodeId) return null;
      return nodesRef.current.find((n) => n.id === rawNodeId)
        || (rawNodeId === LOCAL_NODE_ID
          ? { id: LOCAL_NODE_ID, isLocal: true, name: 'Local' }
          : { id: rawNodeId, name: rawNodeId, isLocal: false });
    };

    const onCreated = (payload) => {
      if (!payload) return;
      const termId = payload.terminalId || payload.id;
      if (!termId) return;
      // Skip if we already have this terminal — avoids dupes when our own
      // optimistic insert in `handleCreate` raced ahead of the broadcast.
      if (terminalsRef.current.some((t) => t.id === termId)) return;
      const rawNodeId = payload.federationNodeId || LOCAL_NODE_ID;
      const node = resolveNode(rawNodeId);
      const mapped = mapTerminal(
        {
          id: termId,
          title: payload.title || payload.name,
          cliType: payload.cliType,
          isClaudeMode: payload.isClaudeMode,
          cwd: payload.cwd,
          createdAt: payload.createdAt,
          status: 'running',
        },
        node,
      );
      setTerminals((prev) => (prev.some((t) => t.id === termId) ? prev : [...prev, mapped]));
    };

    const onDestroyed = (payload) => {
      if (!payload) return;
      const termId = payload.terminalId || payload.id;
      if (!termId) return;
      setTerminals((prev) => prev.filter((t) => t.id !== termId));
    };

    const onTitleChange = (payload) => {
      if (!payload) return;
      const termId = payload.terminalId || payload.id;
      const title = payload.title;
      if (!termId || typeof title !== 'string') return;
      setTerminals((prev) => prev.map((t) => (t.id === termId ? { ...t, title } : t)));
    };

    const unsubs = [
      subscribeEvent('terminal.created', onCreated),
      subscribeEvent('terminal.destroyed', onDestroyed),
      subscribeEvent('terminal.titleChange', onTitleChange),
    ];

    return () => {
      unsubs.forEach((u) => { try { u && u(); } catch {} });
    };
  }, [subscribeEvent]);

  // ── Polling backstop (defense-in-depth) ───────────────────
  // 15s parallel `terminal.list` across all nodes. Catches drops where the
  // lifecycle event was missed (subscription gap during reconnect, fed link
  // hiccup, etc.). Pauses when the app is backgrounded to save battery.
  useEffect(() => {
    if (status !== 'connected') return undefined;
    let timer = null;
    let appActive = AppState.currentState === 'active';

    const tick = () => {
      if (!appActive) return;
      const fn = refreshRef.current;
      if (typeof fn === 'function') fn();
    };

    const startTimer = () => {
      if (timer) return;
      timer = setInterval(tick, POLL_INTERVAL_MS);
    };
    const stopTimer = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };

    if (appActive) startTimer();

    const sub = AppState.addEventListener('change', (next) => {
      const nowActive = next === 'active';
      if (nowActive && !appActive) {
        // Returning from background — refresh immediately so the list is
        // fresh before the next 15s tick.
        const fn = refreshRef.current;
        if (typeof fn === 'function') fn();
        startTimer();
      } else if (!nowActive && appActive) {
        stopTimer();
      }
      appActive = nowActive;
    });

    return () => {
      stopTimer();
      try { sub?.remove?.(); } catch {}
    };
  }, [status]);

  return {
    terminals,
    setTerminals,
    loading,
    error,
    nodes,
    federation,
    refresh,
    invokeOnNode,
    invokeOnNodeId,
    nodeFor,
  };
}

export default useFederatedTerminals;
