/**
 * useSessionChat — one fixed gateway session as a live chat: history, the
 * gateway's `chat` / `agent` broadcasts, send and abort. The single-session
 * sibling of useChatSync, for surfaces locked to one conversation (the CMO
 * chat uses the web's `agent:cmo:cmo-chat`, so both show the same thread).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  HISTORY_PAGE_SIZE,
  buildTurns,
  emptyLive,
  extractText,
  fetchHistoryPage,
  makePagingCaps,
  reduceChatEvent,
  reduceToolEvent,
} from './session-sync';

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function useSessionChat(gateway, sessionKey) {
  const { status, sendReq, subscribeEvent } = gateway || {};
  const connected = status === 'connected';
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(emptyLive);
  const liveRef = useRef(live);
  const messagesRef = useRef(messages);
  const capsRef = useRef(makePagingCaps());
  liveRef.current = live;
  messagesRef.current = messages;

  const loadHistory = useCallback(async ({ quiet = false } = {}) => {
    if (!sessionKey || typeof sendReq !== 'function') return;
    if (!quiet) setLoading(true);
    try {
      const page = await fetchHistoryPage(sendReq, { sessionKey, limit: HISTORY_PAGE_SIZE, caps: capsRef.current });
      const pending = liveRef.current.runId ? messagesRef.current.filter((m) => m.pending) : [];
      const still = pending.filter((p) => {
        const text = extractText(p);
        return !page.messages.some((m) => String(m.role).toLowerCase() === 'user' && (extractText(m) || '').includes(text));
      });
      setMessages([...page.messages, ...still]);
      setError(null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [sendReq, sessionKey]);

  useEffect(() => {
    if (connected) loadHistory();
  }, [connected, loadHistory]);

  useEffect(() => {
    if (typeof subscribeEvent !== 'function' || !sessionKey) return undefined;
    const offChat = subscribeEvent('chat', (payload) => {
      const { live: next, effect } = reduceChatEvent(liveRef.current, payload, sessionKey);
      if (!effect) return;
      liveRef.current = next;
      setLive(next);
      if (effect === 'adopt' || effect === 'settle') loadHistory({ quiet: true });
    });
    const offAgent = subscribeEvent('agent', (payload) => {
      const next = reduceToolEvent(liveRef.current, payload, sessionKey);
      if (next !== liveRef.current) {
        liveRef.current = next;
        setLive(next);
      }
    });
    return () => {
      offChat?.();
      offAgent?.();
    };
  }, [subscribeEvent, sessionKey, loadHistory]);

  const send = useCallback(async (text) => {
    const message = String(text || '').trim();
    if (!message || !connected || liveRef.current.runId) return false;
    const runId = uuid();
    const now = Date.now();
    const optimistic = { id: `local-${runId}`, role: 'user', content: [{ type: 'text', text: message }], timestamp: now, pending: true };
    setMessages((prev) => [...prev, optimistic]);
    const started = { ...emptyLive(), runId, startedAt: now };
    liveRef.current = started;
    setLive(started);
    try {
      await sendReq('chat.send', { sessionKey, message, deliver: false, idempotencyKey: runId });
      return true;
    } catch (err) {
      liveRef.current = emptyLive();
      setLive({ ...emptyLive(), error: String(err?.message || err) });
      setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? { ...m, failed: true } : m)));
      return false;
    }
  }, [connected, sendReq, sessionKey]);

  const abort = useCallback(async () => {
    const runId = liveRef.current.runId;
    if (!runId) return;
    try {
      await sendReq('chat.abort', { sessionKey, runId });
    } catch {}
  }, [sendReq, sessionKey]);

  const turns = useMemo(() => buildTurns(messages, live.runId ? live : null), [messages, live]);

  return { turns, loading, error, live, isStreaming: Boolean(live.runId), send, abort, refresh: loadHistory, connected };
}
