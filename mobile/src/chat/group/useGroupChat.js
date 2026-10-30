/**
 * useGroupChat — the live model of one open agent group chat (the data side of
 * the web's <ib-group-chat>).
 *
 *   load       groupchat.get (members, mode, workflows, runs, busy, activeTurns)
 *              + chat.history on the group key (messages tagged groupChat.*)
 *   live       `groupchat` events (message, turn.start/end, round.*, workflow,
 *              meta) through reduceGroupEvent, and `chat` deltas on each
 *              member's session for token streaming (applyChatEvent)
 *   resync     on (re)connect and app foreground — a gateway restart or a
 *              dropped socket can't leave a stale transcript or a stuck turn
 *   actions    send (text + images, slash commands) / stop / update (members,
 *              mode) / setSettings (group or per-member model + thinking) /
 *              rename / workflows
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  GROUP_CHAT_EVENT,
  applyChatEvent,
  applyGroupRefresh,
  emptyGroupState,
  expireTurn,
  loadedGroupState,
  reduceGroupEvent,
} from './group-logic';
import { toAttachments } from './composer-logic';

function cleanError(err) {
  return String(err?.message ?? err).replace(/^Error:\s*/, '');
}

export function useGroupChat({ sessionKey, connected, sendReq, subscribeEvent }) {
  const [state, setState] = useState(emptyGroupState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [runFilter, setRunFilter] = useState(null);

  const stateRef = useRef(state);
  const keyRef = useRef(sessionKey);
  const timersRef = useRef(new Set());
  const refreshTimerRef = useRef(null);
  const seqRef = useRef(0);
  keyRef.current = sessionKey;

  const commit = useCallback((next) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const later = useCallback((fn, ms) => {
    const id = setTimeout(() => { timersRef.current.delete(id); fn(); }, ms);
    timersRef.current.add(id);
  }, []);

  const load = useCallback(async ({ quiet = false } = {}) => {
    const key = keyRef.current;
    if (!key || !connected) return;
    const seq = ++seqRef.current;
    if (!quiet) setLoading(true);
    try {
      const [g, h] = await Promise.all([
        sendReq('groupchat.get', { key }),
        sendReq('chat.history', { sessionKey: key, limit: 1000 }),
      ]);
      if (key !== keyRef.current || seq !== seqRef.current) return;
      const next = loadedGroupState(g, Array.isArray(h?.messages) ? h.messages : []);
      // A quiet resync keeps streaming text already on screen for turns still running.
      if (quiet) {
        for (const [id, turn] of Object.entries(stateRef.current.live)) {
          if (next.live[id]) next.live[id] = { ...next.live[id], text: turn.text };
        }
      }
      commit(next);
      setRunFilter((f) => (f && !(g?.runs || []).some((r) => r.id === f) ? null : f));
      setError(null);
      setUnsupported(false);
    } catch (err) {
      if (key !== keyRef.current) return;
      const msg = cleanError(err);
      if (/unknown method|not found.*groupchat|groupchat\.get/i.test(msg)) setUnsupported(true);
      else setError(msg);
    } finally {
      if (key === keyRef.current && seq === seqRef.current) setLoading(false);
    }
  }, [connected, sendReq, commit]);

  const refreshGroup = useCallback(async () => {
    const key = keyRef.current;
    if (!key) return;
    try {
      const g = await sendReq('groupchat.get', { key });
      if (key === keyRef.current) commit(applyGroupRefresh(stateRef.current, g));
    } catch { /* transient */ }
  }, [sendReq, commit]);

  const scheduleRefresh = useCallback((ms = 250) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => { refreshTimerRef.current = null; refreshGroup(); }, ms);
  }, [refreshGroup]);

  // Open / switch group, and every (re)connect: full reload.
  useEffect(() => {
    commit(emptyGroupState());
    setError(null);
    setRunFilter(null);
    if (sessionKey && connected) load();
  }, [sessionKey, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Foreground after a while away: quiet resync.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && connected && keyRef.current) load({ quiet: true });
    });
    return () => sub.remove();
  }, [connected, load]);

  useEffect(() => {
    if (typeof subscribeEvent !== 'function' || !sessionKey) return undefined;
    const offGroup = subscribeEvent(GROUP_CHAT_EVENT, (evt) => {
      const { state: next, effects } = reduceGroupEvent(stateRef.current, evt, keyRef.current);
      if (next !== stateRef.current) commit(next);
      for (const fx of effects) {
        if (fx.type === 'refresh') scheduleRefresh(fx.delay);
        if (fx.type === 'expire') later(() => commit(expireTurn(stateRef.current, fx.runId)), fx.delay);
      }
    });
    // Token streaming: each member answers in its own session (agent:<id>:gcmember-<gid>).
    const offChat = subscribeEvent('chat', (payload) => {
      const live = stateRef.current.live;
      if (!Object.keys(live).length) return;
      const next = applyChatEvent(live, payload);
      if (next !== live) commit({ ...stateRef.current, live: next });
    });
    return () => { offGroup?.(); offChat?.(); };
  }, [sessionKey, subscribeEvent, commit, scheduleRefresh, later]);

  useEffect(() => () => {
    for (const id of timersRef.current) clearTimeout(id);
    timersRef.current.clear();
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, []);

  // ── actions ────────────────────────────────────────────────────────────
  const send = useCallback(async (text, images) => {
    const message = String(text || '').trim();
    const attachments = toAttachments(images);
    if ((!message && !attachments.length) || !connected || sending) return false;
    setSending(true);
    try {
      const res = await sendReq('groupchat.send', { key: keyRef.current, message, ...(attachments.length ? { attachments } : {}) });
      if (res?.command) {
        // /model, /think, /mode: the group changed (its status line arrives as an event).
        if (!res.command.ok) setError(res.command.reply);
        scheduleRefresh(50);
      } else {
        commit({ ...stateRef.current, roundActive: true });
      }
      return true;
    } catch (err) {
      setError(cleanError(err));
      return false;
    } finally {
      setSending(false);
    }
  }, [connected, sending, sendReq, commit, scheduleRefresh]);

  const stop = useCallback(async () => {
    try {
      await sendReq('groupchat.abort', { key: keyRef.current });
    } catch (err) {
      setError(cleanError(err));
    }
    scheduleRefresh(300);
  }, [sendReq, scheduleRefresh]);

  /** groupchat.update → the fresh description. Throws so a sheet can show the error. */
  const update = useCallback(async (patch) => {
    const g = await sendReq('groupchat.update', { key: keyRef.current, ...patch });
    commit(applyGroupRefresh(stateRef.current, g));
    return g;
  }, [sendReq, commit]);

  const setMode = useCallback(async (mode) => {
    const prev = stateRef.current;
    if (!prev.group || prev.group.mode === mode) return;
    commit({ ...prev, group: { ...prev.group, mode } });
    try {
      await update({ mode });
    } catch (err) {
      commit({ ...stateRef.current, group: prev.group });
      setError(cleanError(err));
    }
  }, [update, commit]);

  /**
   * Group (no agentId) or per-member model / thinking. `patch` fields: a string
   * sets, null clears (back to inherit); `patch === null` drops a member override.
   */
  const setSettings = useCallback(async ({ agentId, patch }) => {
    const params = agentId ? { memberSettings: { [agentId]: patch } } : { settings: patch ?? { model: null, thinkingLevel: null } };
    return update(params);
  }, [update]);

  const saveWorkflow = useCallback(async (workflow) => {
    const res = await sendReq('groupchat.workflow.save', { key: keyRef.current, workflow });
    const saved = res?.workflow;
    const cur = stateRef.current;
    if (saved && cur.group) {
      const list = cur.group.workflows || [];
      const workflows = list.some((w) => w.id === saved.id) ? list.map((w) => (w.id === saved.id ? saved : w)) : [...list, saved];
      commit({ ...cur, group: { ...cur.group, workflows } });
    }
    return saved;
  }, [sendReq, commit]);

  const deleteWorkflow = useCallback(async (workflowId) => {
    await sendReq('groupchat.workflow.delete', { key: keyRef.current, workflowId });
    const cur = stateRef.current;
    if (cur.group) commit({ ...cur, group: { ...cur.group, workflows: (cur.group.workflows || []).filter((w) => w.id !== workflowId) } });
  }, [sendReq, commit]);

  const runWorkflow = useCallback(async (workflowId, input) => {
    const res = await sendReq('groupchat.workflow.run', { key: keyRef.current, workflowId, input: input || '' });
    const run = res?.run;
    const cur = stateRef.current;
    if (run && cur.group) {
      commit({ ...cur, roundActive: true, group: { ...cur.group, runs: [...(cur.group.runs || []).filter((r) => r.id !== run.id), run] } });
    }
    return run;
  }, [sendReq, commit]);

  return {
    ...state,
    loading, error, setError, sending, unsupported,
    runFilter, setRunFilter,
    reload: load, send, stop, update, setMode, setSettings,
    saveWorkflow, deleteWorkflow, runWorkflow,
  };
}
