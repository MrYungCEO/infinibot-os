import { useState, useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS } from '../constants/theme';

const CACHE_KEY = '@infinibot/discipline_v2';
const CACHE_TTL = 5 * 60 * 1000;
const POLL_MS = 15_000;
const MISSING_RX = /method not found|unknown method|not implemented|no handler|unsupported/i;

// ── Category metadata ──────────────────────────────────────────────────────

export const CATEGORY_COLORS = {
  'deep-work': COLORS.primary,
  meetings: '#8B5CF6',
  ops: '#3B82F6',
  body: '#10B981',
  admin: '#6B7280',
  break: '#F59E0B',
  personal: '#EC4899',
};

export const CATEGORY_LABELS = {
  'deep-work': 'Deep Work',
  meetings: 'Meetings',
  ops: 'Ops',
  body: 'Body',
  admin: 'Admin',
  break: 'Break',
  personal: 'Personal',
};

export const DISCIPLINE_CATEGORIES = [
  'deep-work', 'meetings', 'ops', 'body', 'admin', 'break', 'personal',
];

// ── Utility helpers ────────────────────────────────────────────────────────

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function nowMinutes() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

export function minsToHHMM(m) {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function humanDuration(mins) {
  if (mins <= 0) return '0m';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function blockStatus(block, nowMin, completedSet, todayStr) {
  const dayOfWeek = new Date().getDay();
  if (!block.enabled) return 'disabled';
  const appliesToday = block.oneOffDate
    ? block.oneOffDate === todayStr
    : (block.days || []).includes(dayOfWeek);
  if (!appliesToday) return 'not-today';
  if (completedSet.has(block.id)) return 'completed';
  if (block.endMinute <= nowMin) {
    const minutesPast = nowMin - block.endMinute;
    // Still actionable for ~2h after end — treat as overrunning so the user
    // can still mark complete. Older than that = truly missed.
    if (minutesPast <= 120) return 'overrunning';
    return 'missed';
  }
  if (block.startMinute <= nowMin) return 'in-progress';
  if (block.startMinute <= nowMin + 15) return 'starting-soon';
  return 'upcoming';
}

export function streakCount(week) {
  if (!Array.isArray(week) || week.length === 0) return 0;
  const sorted = [...week].sort((a, b) => b.date?.localeCompare(a.date));
  let streak = 0;
  for (const day of sorted) {
    if ((day.compliance || 0) >= 50) streak++;
    else break;
  }
  return streak;
}

export function scoreColor(pct) {
  if (pct >= 85) return '#10B981';
  if (pct >= 60) return COLORS.primary;
  if (pct >= 30) return '#F59E0B';
  return '#EF4444';
}

// ── Default settings ───────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  militant: false,
  probeIntervalMin: 30,
  dayStartHour: 6,
  dayEndHour: 23,
  quietHoursStart: 22,
  quietHoursEnd: 6,
  telegramEnabled: false,
  telegramChatId: '',
  telegramEvents: {
    blockStart: true, blockEnd: true, blockComplete: false,
    abort: true, slip: true, dailyReview: true,
  },
  prioritySortEnabled: false,
  priorityHighlight: true,
  ai: { enabled: false, autoPlanNextDay: false, autoDailyReview: false },
};

// ── Hook ───────────────────────────────────────────────────────────────────

export function useDiscipline({ sendReq, subscribeEvent, status }) {
  const [supported, setSupported] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [blocks, setBlocks] = useState([]);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [today, setToday] = useState(null);
  const [week, setWeek] = useState([]);
  const [routineCompletions, setRoutineCompletions] = useState([]);
  const [blockCompletions, setBlockCompletions] = useState([]);
  const [eventCounts, setEventCounts] = useState([]);
  const [allEvents, setAllEvents] = useState([]);
  // Proactive insights keyed by blockId + the business-signal rollup.
  const [insights, setInsights] = useState({});
  const [insightSummary, setInsightSummary] = useState(null);
  // When the discipline day auto-started today (null until first activity).
  const [dayStart, setDayStart] = useState(null);
  const [notionStatus, setNotionStatus] = useState(null);
  const [templates, setTemplates] = useState([]);

  const pollRef = useRef(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────

  const todayStr = todayIso();
  const nowMin = nowMinutes();

  const completedSet = new Set(
    blockCompletions
      .filter(c => c.date === todayStr)
      .map(c => c.blockId)
  );

  const todayBlocks = blocks
    .filter(b => {
      if (!b.enabled) return false;
      const dow = new Date().getDay();
      return b.oneOffDate
        ? b.oneOffDate === todayStr
        : (b.days || []).includes(dow);
    })
    .sort((a, b) => a.startMinute - b.startMinute);

  const routineDoneSet = new Set(
    routineCompletions
      .filter(r => r.dateIso === todayStr)
      .map(r => `${r.blockId}:${r.itemId}`)
  );

  // ── Cache ────────────────────────────────────────────────────────────────

  const loadCache = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts < CACHE_TTL && isMounted.current) {
        if (data.blocks) setBlocks(data.blocks);
        if (data.logs) setLogs(data.logs);
        if (data.settings) setSettings({ ...DEFAULT_SETTINGS, ...data.settings });
        if (data.today) setToday(data.today);
        if (data.week) setWeek(data.week);
        if (data.routineCompletions) setRoutineCompletions(data.routineCompletions);
        if (data.blockCompletions) setBlockCompletions(data.blockCompletions);
      }
    } catch {}
  }, []);

  const saveCache = useCallback(async (data) => {
    try {
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
    } catch {}
  }, []);

  // ── Load ─────────────────────────────────────────────────────────────────

  const load = useCallback(async (silent = false) => {
    if (!sendReq || status !== 'connected') return;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [stateRes, scoreRes, weekRes] = await Promise.all([
        sendReq('discipline.state', {}),
        sendReq('discipline.score.day', { date: todayIso() }),
        sendReq('discipline.score.week', {}),
      ]);

      if (!isMounted.current) return;

      const newBlocks = stateRes?.blocks || [];
      const newLogs = stateRes?.logs || [];
      const newSettings = { ...DEFAULT_SETTINGS, ...(stateRes?.settings || {}) };
      const newRoutineCompletions = stateRes?.routineCompletions || [];
      const newBlockCompletions = stateRes?.blockCompletions || [];

      setDayStart(stateRes?.dayStart ?? null);
      setBlocks(newBlocks);
      setLogs(newLogs);
      setSettings(newSettings);
      setRoutineCompletions(newRoutineCompletions);
      setBlockCompletions(newBlockCompletions);
      if (scoreRes) setToday(scoreRes);
      if (weekRes) setWeek(Array.isArray(weekRes) ? weekRes : []);
      setSupported(true);

      saveCache({
        blocks: newBlocks, logs: newLogs, settings: newSettings,
        today: scoreRes, week: weekRes,
        routineCompletions: newRoutineCompletions,
        blockCompletions: newBlockCompletions,
      });

      // Non-blocking: event counts
      sendReq('discipline.events.list', {}).then(evRes => {
        if (isMounted.current && evRes) {
          setEventCounts(evRes.counts || []);
          setAllEvents(evRes.events || []);
        }
      }).catch(() => {});

      // Non-blocking: proactive insights (same engine as web — server RPC).
      sendReq('discipline.insights', {}).then(inRes => {
        if (isMounted.current && inRes) {
          const byId = {};
          for (const ins of inRes.insights || []) byId[ins.blockId] = ins;
          setInsights(byId);
          setInsightSummary(inRes.summary || null);
        }
      }).catch(() => {});

    } catch (err) {
      if (!isMounted.current) return;
      if (MISSING_RX.test(String(err?.message || err))) {
        setSupported(false);
      } else {
        setError(err?.message || String(err));
        loadCache();
      }
    } finally {
      if (isMounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [sendReq, status, loadCache, saveCache]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load(false);
  }, [load]);

  // ── Mount / poll ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (status === 'connected') {
      loadCache().then(() => load());
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => load(true), POLL_MS);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live subscription ────────────────────────────────────────────────────

  useEffect(() => {
    if (!subscribeEvent) return;
    const unsub = subscribeEvent('discipline.event', () => { load(true); });
    return unsub;
  }, [subscribeEvent, load]);

  // ── Day actions ──────────────────────────────────────────────────────────

  const startDay = useCallback(async () => {
    if (!sendReq) throw new Error('Not connected');
    const res = await sendReq('discipline.start_day', {});
    await load(false);
    return res;
  }, [sendReq, load]);

  const endDay = useCallback(async () => {
    if (!sendReq) throw new Error('Not connected');
    const res = await sendReq('discipline.end_day', {});
    await load(false);
    return res;
  }, [sendReq, load]);

  const shiftFromNow = useCallback(async () => {
    if (!sendReq) throw new Error('Not connected');
    const res = await sendReq('discipline.shift_from_now', {});
    await load(false);
    return res;
  }, [sendReq, load]);

  // ── Block actions ────────────────────────────────────────────────────────

  const markBlockComplete = useCallback(async (blockId) => {
    if (!sendReq) return;
    const nowMin_ = nowMinutes();
    setBlockCompletions(prev => {
      const filtered = prev.filter(c => !(c.blockId === blockId && c.date === todayIso()));
      return [...filtered, { blockId, date: todayIso(), completedAt: Date.now(), completedMin: nowMin_ }];
    });
    try {
      await sendReq('discipline.blocks.complete', { id: blockId });
      load(true);
    } catch (err) {
      setBlockCompletions(prev => prev.filter(c => !(c.blockId === blockId && c.date === todayIso())));
      throw err;
    }
  }, [sendReq, load]);

  const unmarkBlockComplete = useCallback(async (blockId) => {
    if (!sendReq) return;
    setBlockCompletions(prev => prev.filter(c => !(c.blockId === blockId && c.date === todayIso())));
    try {
      await sendReq('discipline.blocks.uncomplete', { id: blockId });
      load(true);
    } catch {
      await load(false);
    }
  }, [sendReq, load]);

  const toggleRoutineItem = useCallback(async (blockId, itemId) => {
    if (!sendReq) return;
    const key = `${blockId}:${itemId}`;
    const wasDone = routineDoneSet.has(key);
    if (wasDone) {
      setRoutineCompletions(prev =>
        prev.filter(r => !(r.blockId === blockId && r.itemId === itemId && r.dateIso === todayIso()))
      );
    } else {
      setRoutineCompletions(prev => [
        ...prev,
        { blockId, itemId, dateIso: todayIso(), completedAt: Date.now() },
      ]);
    }
    try {
      await sendReq('discipline.routine.toggle', { blockId, itemId });
    } catch {
      await load(false);
    }
  }, [sendReq, routineDoneSet, load]);

  const createBlock = useCallback(async (draft) => {
    if (!sendReq) throw new Error('Not connected');
    const block = await sendReq('discipline.blocks.create', draft);
    if (block) setBlocks(prev => [...prev, block]);
    return block;
  }, [sendReq]);

  const updateBlock = useCallback(async (id, patch) => {
    if (!sendReq) throw new Error('Not connected');
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, ...patch } : b));
    try {
      const updated = await sendReq('discipline.blocks.update', { id, ...patch });
      if (updated) setBlocks(prev => prev.map(b => b.id === id ? updated : b));
      return updated;
    } catch (err) {
      await load(false);
      throw err;
    }
  }, [sendReq, load]);

  const deleteBlock = useCallback(async (id) => {
    if (!sendReq) return;
    setBlocks(prev => prev.filter(b => b.id !== id));
    try {
      await sendReq('discipline.blocks.delete', { id });
    } catch {
      await load(false);
    }
  }, [sendReq, load]);

  const updateSettings = useCallback(async (patch) => {
    if (!sendReq) return;
    setSettings(prev => ({ ...prev, ...patch }));
    try {
      const updated = await sendReq('discipline.settings.update', patch);
      if (updated && isMounted.current) setSettings(prev => ({ ...prev, ...updated }));
    } catch {
      await load(false);
    }
  }, [sendReq, load]);

  // ── Quick log (manual event) ──────────────────────────────────────────────

  const quickLog = useCallback(async ({ label, category, note, blockId }) => {
    if (!sendReq) throw new Error('Not connected');
    const entry = await sendReq('discipline.logs.create', {
      label,
      category: category || 'personal',
      source: 'manual',
      note,
      blockId,
      startMs: Date.now(),
    });
    if (entry) setLogs(prev => [entry, ...prev].slice(0, 500));
    return entry;
  }, [sendReq]);

  // ── History ──────────────────────────────────────────────────────────────

  const loadHistory = useCallback(async ({ sinceMs, untilMs, limit = 200 } = {}) => {
    if (!sendReq) return [];
    try {
      const res = await sendReq('discipline.logs.list', { sinceMs, untilMs, limit });
      return Array.isArray(res) ? res : [];
    } catch {
      return [];
    }
  }, [sendReq]);

  // ── Templates ────────────────────────────────────────────────────────────

  const loadTemplates = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('discipline.templates.list', {});
      if (isMounted.current) setTemplates(Array.isArray(res) ? res : []);
    } catch {}
  }, [sendReq]);

  const applyTemplate = useCallback(async (id) => {
    if (!sendReq) throw new Error('Not connected');
    const res = await sendReq('discipline.templates.apply', { id });
    await load(false);
    return res;
  }, [sendReq, load]);

  // ── Notion ───────────────────────────────────────────────────────────────

  const loadNotionStatus = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('discipline.notion.status', {});
      if (isMounted.current) setNotionStatus(res);
    } catch {}
  }, [sendReq]);

  return {
    // Status
    supported, loading, refreshing, error,
    // Data
    blocks, todayBlocks, logs, settings, today, week,
    routineCompletions, completedSet, routineDoneSet,
    eventCounts, allEvents, notionStatus, templates,
    insights, insightSummary, dayStart,
    // Helpers
    nowMin,
    todayStr,
    // Actions
    load, refresh,
    startDay, endDay, shiftFromNow,
    markBlockComplete, unmarkBlockComplete, toggleRoutineItem,
    createBlock, updateBlock, deleteBlock,
    updateSettings,
    quickLog, loadHistory,
    loadTemplates, applyTemplate,
    loadNotionStatus,
  };
}

export default useDiscipline;
