/**
 * useChatSync — the mobile chat's live model. One instance lives at the app
 * root (App.js) and is handed to the Chat tab as `gateway.chat`.
 *
 * It reads and writes the SAME gateway session store the web chat uses
 * (sessions.list / sessions.patch / sessions.delete / chat.history / chat.send),
 * with the rules in ./session-sync.js, and it folds the gateway's `chat` and
 * `agent` broadcasts into the open transcript — so a message sent from the web
 * shows up here while you watch, and the reverse, with no refresh.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

import {
  DEFAULT_AGENT_ID,
  HISTORY_PAGE_SIZE,
  SESSIONS_PAGE_SIZE,
  agentIdFromKey,
  buildTurns,
  emptyLive,
  extractText,
  fetchHistoryPage,
  fetchSessionsPage,
  isChatSessionKey,
  isSilentReply,
  makePagingCaps,
  markRead,
  mergeSessions,
  newSessionKey,
  pickDefaultAgentId,
  reduceActivity,
  reduceAgentActivity,
  reduceChatEvent,
  reduceToolEvent,
  sessionTitle,
} from './session-sync';
import { isGroupChatKey } from './group/group-logic';
import {
  AGENT_ROUTE,
  CLI_LABELS,
  backendInfo,
  parseRoute,
  parseRouteCommand,
  routeStorageKey,
} from './cli-route';

import { isSecureSessionKey } from '../secure/secure-logic';

const RECENT_FOLDERS_KEY = 'infinibot.chat.cli.recentFolders';

/** chat.cli tool calls on a CLI delta/final → live tool rows (collapsed in the transcript). */
function cliToolsToLive(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && t.name)
    .map((t, i) => ({ id: String(t.id || `cli-${i}`), name: String(t.name), args: t.input || undefined, result: t.output, pending: t.status === 'running', isError: t.status === 'error' }));
}

const LAST_KEY = '@infinibot/chat_last_session_v1';
const UNREAD_KEY = '@infinibot/chat_unread_v1';
// A run that goes quiet this long is treated as dropped: re-read the store.
const RUN_WATCHDOG_MS = 120_000;

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function cleanError(err) {
  return String(err?.message ?? err).replace(/^Error:\s*/, '');
}

export function useChatSync({ status, sendReq, subscribeEvent }) {
  const connected = status === 'connected';

  const [agents, setAgents] = useState([]);
  const [defaultAgentId, setDefaultAgentId] = useState(DEFAULT_AGENT_ID);
  const [globalModel, setGlobalModel] = useState(null);

  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsError, setSessionsError] = useState(null);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);

  const [activeKey, setActiveKey] = useState(null); // null = a new, unsent chat
  const [draftAgentId, setDraftAgentId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [live, setLive] = useState(emptyLive);
  const [activity, setActivity] = useState({ unread: {}, streaming: {} });
  const [toast, setToast] = useState(null);
  const [restored, setRestored] = useState(false);
  // Composer Agent | CLI target for the open thread (cli-route.js).
  const [route, setRouteState] = useState(AGENT_ROUTE);
  const [cliBackends, setCliBackends] = useState([]);
  /** The gateway serves chat.cli.* (null = not known yet). */
  const [cliSupported, setCliSupported] = useState(null);
  const [cliFolders, setCliFolders] = useState([]);
  const routeRef = useRef(route);
  routeRef.current = route;

  // Refs mirror state for the event handlers (subscribed once).
  const activeRef = useRef(null);
  const liveRef = useRef(live);
  const sessionsRef = useRef(sessions);
  const messagesRef = useRef(messages);
  const capsRef = useRef(makePagingCaps());
  const pageRef = useRef(SESSIONS_PAGE_SIZE); // how many sessions are loaded
  const historyTotalRef = useRef(null);
  const refreshTimerRef = useRef(null);
  const watchdogRef = useRef(null);
  const toastTimerRef = useRef(null);
  const historySeqRef = useRef(0);
  activeRef.current = activeKey;
  liveRef.current = live;
  sessionsRef.current = sessions;
  messagesRef.current = messages;

  const showToast = useCallback((msg) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // ── persisted bits: last open chat + unread marks ────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [[, last], [, unread]] = await AsyncStorage.multiGet([LAST_KEY, UNREAD_KEY]);
        if (!alive) return;
        if (unread) setActivity((a) => ({ ...a, unread: { ...JSON.parse(unread), ...a.unread } }));
        if (last && isChatSessionKey(last) && !activeRef.current) setActiveKey(last);
      } catch {}
      if (alive) setRestored(true);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!restored) return;
    AsyncStorage.setItem(UNREAD_KEY, JSON.stringify(activity.unread)).catch(() => {});
  }, [activity.unread, restored]);

  useEffect(() => {
    if (!restored) return;
    if (activeKey) AsyncStorage.setItem(LAST_KEY, activeKey).catch(() => {});
    else AsyncStorage.removeItem(LAST_KEY).catch(() => {});
  }, [activeKey, restored]);

  // ── loaders ──────────────────────────────────────────────────────────
  const loadAgents = useCallback(async () => {
    try {
      const res = await sendReq('agents.list', {});
      setAgents(Array.isArray(res?.agents) ? res.agents : []);
      setDefaultAgentId(pickDefaultAgentId(res));
    } catch (err) {
      console.log('[chat] agents.list failed', err?.message);
    }
  }, [sendReq]);

  const loadSessions = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setSessionsLoading(true);
    try {
      // Re-read everything currently on screen in one request so a refresh
      // never shrinks a list the user already paged through.
      const page = await fetchSessionsPage(sendReq, { offset: 0, limit: pageRef.current, caps: capsRef.current });
      const d = page.defaults;
      if (d?.model) setGlobalModel(d.modelProvider ? `${d.modelProvider}/${d.model}` : d.model);
      setSessions((prev) => mergeSessions(prev, page.rows, { keep: [activeRef.current] }));
      setHasMoreSessions(page.hasMore);
      setSessionsError(null);
    } catch (err) {
      setSessionsError(cleanError(err));
    } finally {
      setSessionsLoading(false);
      setSessionsLoaded(true);
    }
  }, [sendReq]);

  const loadMoreSessions = useCallback(async () => {
    if (sessionsLoading || !hasMoreSessions) return;
    setSessionsLoading(true);
    try {
      const page = await fetchSessionsPage(sendReq, { offset: pageRef.current, limit: SESSIONS_PAGE_SIZE, caps: capsRef.current });
      pageRef.current += SESSIONS_PAGE_SIZE;
      setSessions((prev) => mergeSessions(prev, [...prev, ...page.rows], { keep: [activeRef.current] }));
      setHasMoreSessions(page.hasMore);
    } catch (err) {
      showToast(cleanError(err));
    } finally {
      setSessionsLoading(false);
    }
  }, [sendReq, sessionsLoading, hasMoreSessions, showToast]);

  const scheduleSessionsRefresh = useCallback((delay = 600) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      loadSessions({ silent: true });
    }, delay);
  }, [loadSessions]);

  const loadHistory = useCallback(async ({ quiet = false } = {}) => {
    const key = activeRef.current;
    // Group chats load through useGroupChat (attributed messages + live turns).
    if (!key || isGroupChatKey(key)) return;
    const seq = ++historySeqRef.current;
    if (!quiet) setHistoryLoading(true);
    try {
      // Keep whatever depth the user already scrolled back to.
      const depth = Math.max(HISTORY_PAGE_SIZE, quiet ? messagesRef.current.filter((m) => !m.pending).length : 0);
      const page = await fetchHistoryPage(sendReq, { sessionKey: key, limit: depth, caps: capsRef.current });
      if (activeRef.current !== key || seq !== historySeqRef.current) return;
      historyTotalRef.current = page.total;
      // An optimistic user turn the store has not persisted yet stays visible.
      const pending = liveRef.current.runId ? messagesRef.current.filter((m) => m.pending) : [];
      const stillPending = pending.filter((p) => {
        const text = extractText(p);
        return !page.messages.some((m) => String(m.role).toLowerCase() === 'user' && (extractText(m) || '').includes(text));
      });
      setMessages([...page.messages, ...stillPending]);
      setHasOlder(page.hasMore);
      setHistoryError(null);
    } catch (err) {
      if (activeRef.current === key) setHistoryError(cleanError(err));
    } finally {
      if (activeRef.current === key && seq === historySeqRef.current) setHistoryLoading(false);
    }
  }, [sendReq]);

  const loadOlder = useCallback(async () => {
    const key = activeRef.current;
    if (!key || loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    try {
      const have = messagesRef.current.filter((m) => !m.pending).length;
      const page = await fetchHistoryPage(sendReq, {
        sessionKey: key, limit: HISTORY_PAGE_SIZE, before: have, total: historyTotalRef.current, caps: capsRef.current,
      });
      if (activeRef.current !== key) return;
      setMessages((prev) => [...page.messages, ...prev]);
      setHasOlder(page.hasMore && page.messages.length > 0);
    } catch (err) {
      showToast(cleanError(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [sendReq, loadingOlder, hasOlder, showToast]);

  // ── run watchdog ─────────────────────────────────────────────────────
  const armWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      if (!liveRef.current.runId) return;
      setLive(emptyLive());
      loadHistory({ quiet: true });
    }, RUN_WATCHDOG_MS);
  }, [loadHistory]);
  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  // ── live events ──────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof subscribeEvent !== 'function') return undefined;
    const offChat = subscribeEvent('chat', (payload) => {
      if (!payload?.sessionKey) return;
      setActivity((a) => reduceActivity(a, payload, activeRef.current));
      if (isGroupChatKey(payload.sessionKey)) {
        // Mirrored group message finals: the group view handles the transcript;
        // here they reorder the list, mark unread (above) and notify on agent replies.
        if (payload.state !== 'final') return;
        scheduleSessionsRefresh();
        if (payload.message?.role !== 'assistant' || AppState.currentState === 'active') return;
        const text = extractText(payload.message) || '';
        if (isSilentReply(text)) return;
        const row = sessionsRef.current.find((s) => s.key === payload.sessionKey);
        const who = payload.message?.groupChat?.agentName || payload.message?.groupChat?.agentId;
        Notifications.scheduleNotificationAsync({
          content: {
            title: row ? sessionTitle(row) : 'Group chat',
            body: `${who ? `${who}: ` : ''}${text.length > 150 ? `${text.slice(0, 150)}…` : text}`,
            data: { type: 'chat', kind: 'chat_reply', sessionKey: payload.sessionKey, runId: payload.runId },
            sound: 'default',
          },
          trigger: null,
        }).catch(() => {});
        return;
      }

      let { live: next, effect } = reduceChatEvent(liveRef.current, payload, activeRef.current);
      if (payload.state === 'delta' && payload.runId && payload.runId === liveRef.current.runId && payload.message?.cliTools) {
        next = { ...next, tools: cliToolsToLive(payload.message.cliTools) };
        effect = effect || 'stream';
      }
      if (effect) {
        liveRef.current = next;
        setLive(next);
      }
      if (effect === 'stream' || effect === 'adopt') armWatchdog();
      if (effect === 'adopt') loadHistory({ quiet: true });
      if (effect === 'settle') {
        clearWatchdog();
        loadHistory({ quiet: true });
        scheduleSessionsRefresh();
      }
      if (!effect && isChatSessionKey(payload.sessionKey)) {
        if (payload.state === 'final') {
          // Another chat moved: reorder / retitle the list.
          scheduleSessionsRefresh();
        } else if (payload.state === 'delta' && !sessionsRef.current.some((s) => s.key === payload.sessionKey)) {
          // A chat this device has never seen just started replying (created on
          // another device): fetch it so its row — and its live marker — show now.
          if (!refreshTimerRef.current) scheduleSessionsRefresh(300);
        }
      }
      if (payload.state === 'final' && isChatSessionKey(payload.sessionKey) && AppState.currentState !== 'active') {
        const text = extractText(payload.message) || '';
        if (!isSilentReply(text)) {
          const row = sessionsRef.current.find((s) => s.key === payload.sessionKey);
          Notifications.scheduleNotificationAsync({
            content: {
              title: row ? sessionTitle(row) : 'New reply from InfiniBot',
              body: text.length > 150 ? `${text.slice(0, 150)}…` : text,
              data: { type: 'chat', kind: 'chat_reply', sessionKey: payload.sessionKey, runId: payload.runId },
              sound: 'default',
            },
            trigger: null,
          }).catch(() => {});
        }
      }
    });
    const offAgent = subscribeEvent('agent', (payload) => {
      setActivity((a) => reduceAgentActivity(a, payload));
      if (
        isChatSessionKey(payload?.sessionKey) &&
        !sessionsRef.current.some((s) => s.key === payload.sessionKey) &&
        !refreshTimerRef.current
      ) {
        // A chat created on another device just started: list it now.
        scheduleSessionsRefresh(300);
      }
      const next = reduceToolEvent(liveRef.current, payload, activeRef.current);
      if (next !== liveRef.current) {
        liveRef.current = next;
        setLive(next);
        armWatchdog();
      }
    });
    // Newer gateways announce list changes (rename / pin / delete elsewhere).
    const offSessions = subscribeEvent('sessions.changed', () => scheduleSessionsRefresh(200));
    return () => {
      offChat?.();
      offAgent?.();
      offSessions?.();
    };
  }, [subscribeEvent, loadHistory, scheduleSessionsRefresh, armWatchdog, clearWatchdog]);

  // (Re)connect: re-read the store. Also covers a gateway restart.
  useEffect(() => {
    if (!connected || !restored) return;
    capsRef.current = makePagingCaps();
    loadAgents();
    loadSessions();
    if (activeRef.current) loadHistory();
  }, [connected, restored, loadAgents, loadSessions, loadHistory]);

  // Foreground: anything could have happened on another device meanwhile.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active' || !connected) return;
      loadSessions({ silent: true });
      if (activeRef.current) loadHistory({ quiet: true });
    });
    return () => sub.remove();
  }, [connected, loadSessions, loadHistory]);

  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // ── session actions ──────────────────────────────────────────────────
  const openSession = useCallback((key) => {
    const next = key || null;
    activeRef.current = next;
    historySeqRef.current += 1;
    setActiveKey(next);
    setMessages([]);
    messagesRef.current = [];
    setLive(emptyLive());
    liveRef.current = emptyLive();
    setHasOlder(false);
    setHistoryError(null);
    historyTotalRef.current = null;
    clearWatchdog();
    if (next) {
      setActivity((a) => markRead(a, next));
      if (isGroupChatKey(next)) { setHistoryLoading(false); return; }
      setHistoryLoading(true);
      loadHistory();
    } else {
      setHistoryLoading(false);
    }
  }, [loadHistory, clearWatchdog]);

  const currentAgentId = agentIdFromKey(activeKey) ?? draftAgentId ?? defaultAgentId;

  const newChat = useCallback((agentId) => {
    setDraftAgentId(agentId || agentIdFromKey(activeRef.current) || null);
    openSession(null);
  }, [openSession]);

  /** The agent is baked into the session key, so switching agents opens a fresh chat. */
  const pickAgent = useCallback((id) => {
    if (!id || id === currentAgentId) return;
    setDraftAgentId(id);
    if (activeRef.current) openSession(null);
  }, [currentAgentId, openSession]);

  const patchSession = useCallback(async (key, patch) => {
    try {
      await sendReq('sessions.patch', { key, ...patch });
      return true;
    } catch (err) {
      const msg = cleanError(err);
      showToast('pinned' in patch && /pinned|additional|unexpected/i.test(msg)
        ? 'Pinning needs a gateway restart to take effect.'
        : msg);
      return false;
    }
  }, [sendReq, showToast]);

  const renameSession = useCallback(async (key, title) => {
    const row = sessionsRef.current.find((s) => s.key === key);
    const label = String(title || '').trim();
    if (!row || label === sessionTitle(row)) return true;
    const prev = sessionsRef.current;
    setSessions(prev.map((s) => (s.key === key ? { ...s, label: label || undefined } : s)));
    const ok = await patchSession(key, { label: label || null });
    if (!ok) setSessions(prev);
    return ok;
  }, [patchSession]);

  const togglePin = useCallback(async (key) => {
    const row = sessionsRef.current.find((s) => s.key === key);
    if (!row) return false;
    const pinned = !row.pinned;
    const prev = sessionsRef.current;
    setSessions(mergeSessions(prev, prev.map((s) => (s.key === key ? { ...s, pinned } : s))));
    const ok = await patchSession(key, { pinned });
    if (!ok) setSessions(prev);
    return ok;
  }, [patchSession]);

  const deleteSession = useCallback(async (key) => {
    try {
      await sendReq('sessions.delete', { key, deleteTranscript: true });
      setSessions((prev) => prev.filter((s) => s.key !== key));
      setActivity((a) => markRead(a, key));
      if (activeRef.current === key) newChat();
      return true;
    } catch (err) {
      showToast(cleanError(err));
      return false;
    }
  }, [sendReq, newChat, showToast]);

  // ── Agent | CLI routing ─────────────────────────────────────────────
  const loadCliBackends = useCallback(async () => {
    if (!connected) return;
    try {
      const st = await sendReq('cliRouting.status', {});
      setCliBackends((st?.backends || []).map(backendInfo).filter(Boolean));
    } catch {
      /* keep the last list */
    }
    AsyncStorage.getItem(RECENT_FOLDERS_KEY)
      .then((raw) => setCliFolders(raw ? JSON.parse(raw).slice(0, 8) : []))
      .catch(() => {});
  }, [connected, sendReq]);
  useEffect(() => { loadCliBackends(); }, [loadCliBackends]);

  // Each thread remembers its target: local copy first, then the gateway's (chat.cli.state).
  useEffect(() => {
    let cancelled = false;
    const key = activeKey;
    AsyncStorage.getItem(routeStorageKey(key))
      .then((raw) => {
        if (cancelled) return;
        const r = raw ? parseRoute(JSON.parse(raw)) : null;
        setRouteState(r || AGENT_ROUTE);
      })
      .catch(() => {});
    if (key && connected && !isGroupChatKey(key)) {
      sendReq('chat.cli.state', { sessionKey: key })
        .then((res) => {
          if (cancelled) return;
          setCliSupported(true);
          const st = res?.state;
          const r = st ? parseRoute({ ...st, model: st.backend ? st.models?.[st.backend] : undefined }) : null;
          if (r) {
            setRouteState(r);
            AsyncStorage.setItem(routeStorageKey(key), JSON.stringify(r)).catch(() => {});
          }
        })
        .catch((err) => {
          if (!cancelled && /unknown method/i.test(String(err?.message || err))) setCliSupported(false);
        });
    } else if (connected && cliSupported === null) {
      sendReq('chat.cli.state', { sessionKey: 'agent:main:webchat-probe' })
        .then(() => !cancelled && setCliSupported(true))
        .catch((err) => !cancelled && /unknown method/i.test(String(err?.message || err)) && setCliSupported(false));
    }
    return () => { cancelled = true; };
  }, [activeKey, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRoute = useCallback((next) => {
    const prev = routeRef.current;
    const key = activeRef.current;
    setRouteState(next);
    routeRef.current = next;
    AsyncStorage.setItem(routeStorageKey(key), JSON.stringify(next)).catch(() => {});
    if (next.mode === 'cli' && next.cwd) {
      setCliFolders((list) => {
        const merged = [next.cwd, ...list.filter((f) => f !== next.cwd)].slice(0, 8);
        AsyncStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(merged)).catch(() => {});
        return merged;
      });
    }
    const label = next.mode === 'cli' ? CLI_LABELS[next.backend] : 'the agent';
    if (prev.mode !== next.mode || prev.backend !== next.backend) showToast(`Switched to ${label}`);
    if (key && cliSupported) {
      sendReq('chat.cli.mode', {
        sessionKey: key,
        mode: next.mode,
        ...(next.mode === 'cli' ? { backend: next.backend, ...(next.cwd ? { cwd: next.cwd } : {}), ...(next.model ? { model: next.model } : {}) } : {}),
      }).catch((err) => showToast(cleanError(err)));
    }
  }, [cliSupported, sendReq, showToast]);

  const runRouteCommandRef = useRef(null);
  runRouteCommandRef.current = async (cmd) => {
    if (cmd.kind === 'cli-unknown') {
      showToast(`Unknown CLI "${cmd.name}". Try claude, codex, opencode or gemini.`);
      return;
    }
    if (cmd.kind === 'agent') {
      setRoute(AGENT_ROUTE);
      if (cmd.agentId && agents.some((a) => a.id === cmd.agentId)) pickAgent(cmd.agentId);
      return;
    }
    if (!cliSupported) {
      showToast('CLI chat needs the gateway update.');
      return;
    }
    const cur = routeRef.current.mode === 'cli' ? routeRef.current : null;
    const backend = cmd.backend || cur?.backend || cliBackends.find((b) => b.status === 'ready')?.id || 'claude-code';
    const cwd = cmd.cwd || cur?.cwd;
    setRoute({ mode: 'cli', backend, ...(cwd ? { cwd } : {}) });
  };

  // ── composer ─────────────────────────────────────────────────────────
  const send = useCallback(async (text, image = null) => {
    const routeCmd = !image ? parseRouteCommand(text) : null;
    if (routeCmd) {
      await runRouteCommandRef.current?.(routeCmd);
      return true;
    }
    const message = String(text || '').trim();
    const hasImage = Boolean(image?.base64);
    if ((!message && !hasImage) || !connected) return false;
    if (liveRef.current.runId) return false;
    const cliRoute = routeRef.current.mode === 'cli' && !isSecureSessionKey(activeRef.current) ? routeRef.current : null;
    if (cliRoute && (hasImage || !cliSupported)) {
      showToast(hasImage ? 'Images go to the agent — switch to Agent mode to send one.' : `${CLI_LABELS[cliRoute.backend]} chat needs the gateway update.`);
      return false;
    }

    let key = activeRef.current;
    const now = Date.now();
    if (!key) {
      key = newSessionKey(currentAgentId, now);
      activeRef.current = key;
      if (cliRoute) AsyncStorage.setItem(routeStorageKey(key), JSON.stringify(cliRoute)).catch(() => {});
      setActiveKey(key);
      setSessions((prev) => mergeSessions(prev, [
        { key, kind: 'direct', derivedTitle: message.slice(0, 80) || 'Image', updatedAt: now },
        ...prev,
      ]));
    } else {
      setSessions((prev) => mergeSessions(prev, prev.map((s) => (s.key === key ? { ...s, updatedAt: now } : s))));
    }

    const runId = uuid();
    const content = [{ type: 'text', text: message || 'What is in this image?' }];
    if (hasImage) {
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType || 'image/jpeg', data: image.base64 } });
    }
    const cliMeta = cliRoute
      ? { backend: cliRoute.backend, ...(cliRoute.cwd ? { cwd: cliRoute.cwd } : {}), ...(cliRoute.model ? { model: cliRoute.model } : {}) }
      : null;
    const optimistic = { id: `local-${runId}`, role: 'user', content, timestamp: now, pending: true, ...(cliMeta ? { cli: cliMeta } : {}) };
    setMessages((prev) => [...prev, optimistic]);
    const started = { ...emptyLive(), runId, startedAt: now, ...(cliMeta ? { cli: cliMeta } : {}) };
    liveRef.current = started;
    setLive(started);
    armWatchdog();

    try {
      if (cliMeta) {
        await sendReq('chat.cli.send', { sessionKey: key, message, idempotencyKey: runId, ...cliMeta });
        scheduleSessionsRefresh(1500);
        return true;
      }
      await sendReq('chat.send', {
        sessionKey: key,
        message: message || 'What is in this image?',
        deliver: false,
        idempotencyKey: runId,
        ...(hasImage
          ? { attachments: [{ type: 'image', mimeType: image.mimeType || 'image/jpeg', content: image.base64 }] }
          : {}),
      });
      scheduleSessionsRefresh(1500);
      return true;
    } catch (err) {
      clearWatchdog();
      if (activeRef.current === key) {
        setLive({ ...emptyLive(), error: cleanError(err) });
        liveRef.current = emptyLive();
        setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? { ...m, failed: true } : m)));
      }
      return false;
    }
  }, [connected, currentAgentId, cliSupported, sendReq, showToast, armWatchdog, clearWatchdog, scheduleSessionsRefresh]);

  const abort = useCallback(async () => {
    const key = activeRef.current;
    const runId = liveRef.current.runId;
    if (!key || !runId) return;
    try {
      if (liveRef.current.cli) {
        await sendReq('chat.cli.abort', { sessionKey: key });
        return;
      }
      await sendReq('chat.abort', { sessionKey: key, runId });
    } catch (err) {
      showToast(cleanError(err));
    }
  }, [sendReq, showToast]);

  const refresh = useCallback(async () => {
    await Promise.all([loadSessions({ silent: true }), activeRef.current ? loadHistory({ quiet: true }) : null]);
  }, [loadSessions, loadHistory]);

  const turns = useMemo(() => buildTurns(messages, live.runId ? live : null), [messages, live]);
  const activeRow = useMemo(() => sessions.find((s) => s.key === activeKey) || null, [sessions, activeKey]);
  const unreadCount = useMemo(() => Object.keys(activity.unread).length, [activity.unread]);

  return {
    // roster
    agents, defaultAgentId, currentAgentId, pickAgent, globalModel,
    // sessions
    sessions, sessionsLoading, sessionsLoaded, sessionsError, hasMoreSessions,
    loadSessions, loadMoreSessions,
    activeKey, activeRow, openSession, newChat,
    renameSession, deleteSession, togglePin,
    activity, unreadCount,
    // transcript
    turns, messages, historyLoading, historyError, hasOlder, loadingOlder, loadOlder,
    live, isStreaming: Boolean(live.runId),
    send, abort, refresh,
    toast, showToast,
    // Agent | CLI
    route, setRoute, cliBackends, cliSupported, cliFolders, loadCliBackends,
  };
}
