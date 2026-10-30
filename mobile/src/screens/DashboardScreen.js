/**
 * DashboardScreen — full mobile port of the web UI Command Center dashboard
 * (ui/src/ui/views/dashboard.ts). Replaces the old "Business" tab.
 *
 * It mirrors the web dashboard's sections, optimized for touch + vertical
 * scroll: hero greeting, an Agent Field summary (the web's Pixi.js world map
 * is summarized into a data card — see note below), a 6-tile KPI strip, the
 * 24h activity timeline, live agent pulse, AI recommendations, agent roster,
 * project velocity, system/federation health, revenue, discipline, client
 * pipeline, priority queue, recently shipped, focus & priorities, a kanban
 * mini-board, workflows, scheduled jobs, knowledge notes, content surfaces,
 * connected fleet, and continue-learning.
 *
 * Data is loaded with one batched, fault-tolerant pass (Promise.allSettled);
 * any single RPC that the gateway/scope doesn't expose simply leaves its card
 * in an empty state rather than failing the whole screen.
 *
 * Porting decisions vs. the web dashboard:
 *   - The Pixi.js <agency-world-viz> live world map and <dashboard-calendar-
 *     panel> are heavy canvas/DOM visualizations. On mobile they are rendered
 *     as an "Agent Field" summary card (running agents, nodes online, trips)
 *     with a tap-through to the existing NeuralMesh / Agency World screens.
 *   - All SVG charts (sparklines, bars, donut, gauge, day timeline) are ported
 *     1:1 via react-native-svg (see components/DashboardCharts).
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Dimensions,
  Platform,
  Image,
  Alert,
  Vibration,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SwipeReveal } from '../components/SwipeReveal';
import { COLORS, FONT_FAMILY } from '../constants/theme';
import { withAlpha, innerTopHighlight } from '../theme/color-utils';
import { Sparkline, BarChart, Donut, Gauge, DayTimeline } from '../components/DashboardCharts';
import { ProactiveSection } from '../components/ProactiveSection';
import { TodaysPriorities } from '../components/TodaysPriorities';
import { useTheme } from '../theme/ThemeProvider';
import { useSecureMode } from '../secure/useSecureMode';
import { SecureModeBar, secureFrameStyle } from '../secure/SecureControls';
import { SecureBoard } from '../secure/SecureBoard';
import {
  getDashboardPreset,
  setDashboardPreset,
  getRecSnoozes,
  setRecSnoozes,
  getRecDismissed,
  setRecDismissed,
} from '../utils/storage';

const { width: SCREEN_W } = Dimensions.get('window');
const DOCK_BOTTOM_SPACE = 96;
const H_PAD = 14;
const CARD_W = SCREEN_W - H_PAD * 2;

// ============================================================
// Helpers
// ============================================================
const fmtMoney = (n, hide) =>
  hide
    ? '••••'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(n || 0);

const fmtCompact = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  n = Number(n);
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
};

const timeAgo = (ts) => {
  if (!ts) return '';
  const ms = Date.now() - Number(ts);
  if (ms < 0) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

const fmtDur = (ms) => {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

const asArray = (v, keys = []) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of keys) if (Array.isArray(v[k])) return v[k];
  }
  return [];
};

const normStatus = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '_');
const isBlocked = (t) =>
  t?.blocked === true || /block/.test(normStatus(t?.status)) || normStatus(t?.priority) === 'blocked';

// Section palette for donuts / lanes
const SEG_COLORS = () => [
  COLORS.primary,
  COLORS.info,
  COLORS.purple,
  COLORS.success,
  COLORS.warning,
  COLORS.cyan,
  COLORS.pink,
];

// ============================================================
// Preset system (web parity — mirrors ui DASH_PRESETS)
// ============================================================
// Mobile cards are grouped onto the web SectionId taxonomy. `show(id)`
// gates each card by the active preset; 'full' shows everything.
const PRESET_LIST = [
  { key: 'hyperfocus', label: 'Hyperfocus' },
  { key: 'operator', label: 'Operator' },
  { key: 'executive', label: 'Executive' },
  { key: 'full', label: 'Full' },
];

const PRESET_SECTIONS = {
  hyperfocus: new Set([
    'proactive', 'insights-pulse', 'suggested-projects', 'focus-kanban', 'priority-shipped', 'activity-timeline',
  ]),
  operator: new Set([
    'proactive', 'world-map', 'kpi-strip', 'activity-timeline', 'insights-pulse', 'suggested-projects',
    'roster-velocity-health', 'priority-shipped', 'focus-kanban', 'workflows-cron-notes', 'federation',
  ]),
  executive: new Set([
    'proactive', 'command-zone', 'kpi-strip', 'insights-pulse', 'suggested-projects',
    'revenue-discipline-pipeline', 'federation',
  ]),
  full: null, // everything
};

function makeShow(preset) {
  if (preset === 'full' || !PRESET_SECTIONS[preset]) return () => true;
  const set = PRESET_SECTIONS[preset];
  return (sectionId) => set.has(sectionId);
}

// Session-level cache of the active preset. AsyncStorage reads are async, so
// without this the dashboard flashes the 'full' layout on every remount before
// the persisted preset resolves a tick later. Caching the last-known value makes
// the saved preset apply synchronously on the initial render of every remount
// after the first — killing the navigate-away-and-back flicker (web parity).
let _presetCache = null;

// Segmented-pill preset switcher (mirrors the persisted view-mode toggle idiom
// used elsewhere in mobile — DisciplineScreen tabs / ViewToggle). Active segment
// uses a solid COLORS.primary background.
function PresetBar({ preset, onChange }) {
  return (
    <View style={styles.presetBar}>
      {PRESET_LIST.map((p) => {
        const active = preset === p.key;
        return (
          <TouchableOpacity
            key={p.key}
            onPress={() => onChange(p.key)}
            activeOpacity={0.8}
            style={[styles.presetPill, active && styles.presetPillActive]}
            hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${p.label} preset`}
          >
            <Text style={[styles.presetPillTxt, active && styles.presetPillTxtActive]} numberOfLines={1}>
              {p.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ============================================================
// Data loader — one batched, fault-tolerant pass
// ============================================================
function useDashboardData(gateway) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const sendReq = gateway?.sendReq;

  const load = useCallback(async () => {
    if (!sendReq || gateway?.status !== 'connected') {
      setLoading(false);
      return;
    }
    const call = (m, p = {}) => sendReq(m, p).catch(() => null);
    const [
      meR, subsR, completedR, tasksR, insightsR, workflowsR, cronR, notesR,
      nodesR, agentsR, incomeR, clientsR, bizR, discStateR, discWeekR,
      prioritiesR, contentR, tracksR, coursesR, projectsR, autonomyR,
    ] = await Promise.all([
      call('users.me'),
      call('subagents.list', { includeCompleted: true, limit: 60 }),
      call('kanban.listRecentlyCompleted', { limit: 60 }),
      call('kanban.tasks.list', {}),
      call('systems.insights.list', {}),
      call('workflows.list', {}),
      call('cron.list', {}),
      call('notes.list', { limit: 6 }),
      call('node.list', {}),
      call('agents.list', {}),
      call('business.income.stats', {}),
      call('business.clients.list', {}),
      call('business.list', {}),
      call('discipline.state', {}),
      call('discipline.score.week', {}),
      call('systems.priorities.list', {}),
      call('content.pages.list', { includeArchived: false }),
      call('learn.tracks.list', {}),
      call('vault.courses.enrolled', {}),
      call('kanban.projects.list', {}),
      call('autonomy:status', {}),
    ]);

    // Fallback for agents (web uses agents.list; mobile gateway also exposes
    // agents.management.list)
    let agents = asArray(agentsR, ['agents']);
    if (!agents.length) {
      const altA = await call('agents.management.list', {});
      agents = asArray(altA, ['agents']);
    }
    // Fallback for nodes (mobile federation hook uses federation.nodes.list)
    let nodes = asArray(nodesR, ['nodes']);
    if (!nodes.length) {
      const altN = await call('federation.nodes.list', {});
      nodes = asArray(altN, ['nodes']);
    }

    setData({
      me: meR || {},
      subagents: asArray(subsR, ['subagents']),
      completed: asArray(completedR, ['entries', 'completed']),
      tasks: asArray(tasksR, ['tasks']),
      insights: asArray(insightsR, ['insights']),
      workflows: asArray(workflowsR, ['workflows']),
      cron: asArray(cronR, ['jobs', 'crons']),
      notes: asArray(notesR, ['notes']),
      nodes,
      agents,
      income: incomeR || {},
      clients: asArray(clientsR, ['clients']),
      businesses: asArray(bizR, ['businesses']),
      discipline: discStateR || {},
      discWeek: Array.isArray(discWeekR) ? discWeekR : asArray(discWeekR, ['week', 'scores']),
      priorities: asArray(prioritiesR, ['priorities']),
      content: asArray(contentR, ['pages']),
      tracks: asArray(tracksR, ['tracks']),
      courses: asArray(coursesR, ['courses']),
      projects: asArray(projectsR, ['projects']),
      autonomy: autonomyR || {},
    });
    setLoading(false);
  }, [sendReq, gateway?.status]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, reload: load };
}

// ============================================================
// Derived metrics
// ============================================================
function useDerived(data) {
  return useMemo(() => {
    if (!data) return null;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dayStart = startOfDay.getTime();
    const last24 = Date.now() - 24 * 60 * 60 * 1000;

    const running = data.subagents.filter(
      (s) => /run|active|progress/.test(normStatus(s.status)) && !/done|complete|error|stopped/.test(normStatus(s.status)),
    );
    const completedToday = data.completed.filter((e) => Number(e.completedAt ?? e.finishedAt ?? 0) >= dayStart);
    const shipped24 = data.completed.filter((e) => Number(e.completedAt ?? e.finishedAt ?? 0) >= last24);

    const tasksByStatus = { todo: [], in_progress: [], blocked: [], review: [], done: [] };
    data.tasks.forEach((t) => {
      if (isBlocked(t)) return tasksByStatus.blocked.push(t);
      const s = normStatus(t.status);
      if (/done|complete/.test(s)) tasksByStatus.done.push(t);
      else if (/progress|updating/.test(s)) tasksByStatus.in_progress.push(t);
      else if (/review/.test(s)) tasksByStatus.review.push(t);
      else tasksByStatus.todo.push(t);
    });

    // 24h hourly completion buckets
    const hourly = new Array(24).fill(0);
    shipped24.forEach((e) => {
      const ts = Number(e.completedAt ?? e.finishedAt ?? 0);
      if (!ts) return;
      const hoursAgo = Math.floor((Date.now() - ts) / (60 * 60 * 1000));
      const idx = 23 - Math.min(23, Math.max(0, hoursAgo));
      hourly[idx] += 1;
    });
    const peakHour = hourly.indexOf(Math.max(...hourly));

    // Project velocity (group completions by project)
    const projCounts = new Map();
    shipped24.forEach((e) => {
      const name = String(e.projectName ?? e.project ?? '—');
      projCounts.set(name, (projCounts.get(name) || 0) + 1);
    });
    const velocity = [...projCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

    // Per-agent run stats from subagents
    const perAgent = new Map();
    data.subagents.forEach((s) => {
      const key = String(s.agentId ?? s.label ?? '').toLowerCase();
      if (!key) return;
      const cur = perAgent.get(key) ?? { runs: 0, success: 0 };
      cur.runs += 1;
      if (normStatus(s.status) !== 'error') cur.success += 1;
      perAgent.set(key, cur);
    });
    const roster = data.agents.slice(0, 8).map((a) => {
      const id = String(a.id ?? a.agentId ?? '');
      const c = perAgent.get(id.toLowerCase()) ?? { runs: 0, success: 0 };
      return {
        id,
        name: String(a.name ?? a.displayName ?? id ?? 'Agent'),
        backend: String(a.backend ?? a.coderBackend ?? a.provider ?? 'claude'),
        runs: c.runs,
        successPct: c.runs > 0 ? Math.round((c.success / c.runs) * 100) : 100,
        active: c.runs > 0,
      };
    });

    // Client pipeline (group by stage/status)
    const stageCounts = new Map();
    data.clients.forEach((c) => {
      const stage = String(c.status ?? c.stage ?? c.Stage ?? 'Active');
      stageCounts.set(stage, (stageCounts.get(stage) || 0) + 1);
    });
    const pipeline = [...stageCounts.entries()].sort((a, b) => b[1] - a[1]);

    // Priorities
    const active = data.priorities
      .filter((p) => String(p.status ?? 'active').toLowerCase() === 'active')
      .sort((a, b) => Number(a.rank ?? 99) - Number(b.rank ?? 99));
    const focusList = active.slice(0, 5).map((p) => {
      const outcomes = Array.isArray(p.outcomes) ? p.outcomes : [];
      const next = outcomes.find((o) => !o.completed)?.description;
      return {
        id: String(p.id ?? ''),
        title: String(p.title ?? 'Priority'),
        progress: Math.max(0, Math.min(100, Math.round(Number(p.progress ?? 0)))),
        isFocus: Number(p.rank ?? 99) === 1,
        nextStep: next,
      };
    });
    const avgProg = focusList.length
      ? Math.round(focusList.reduce((s, p) => s + p.progress, 0) / focusList.length)
      : 0;

    // Content surfaces
    const surfaceCounts = new Map();
    data.content.forEach((p) => {
      const surface = String(p.surface ?? 'page').toLowerCase();
      const status = String(p.status ?? '').toLowerCase();
      const cur = surfaceCounts.get(surface) ?? { count: 0, published: 0 };
      cur.count += 1;
      if (status === 'published' || status === 'live') cur.published += 1;
      surfaceCounts.set(surface, cur);
    });
    const surfaces = [...surfaceCounts.entries()].sort((a, b) => b[1].count - a[1].count);
    const recentPages = data.content
      .slice()
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
      .slice(0, 4);

    // Nodes
    const nodes = data.nodes.map((n) => ({
      id: String(n.nodeId ?? n.id ?? ''),
      name: String(n.nodeName ?? n.name ?? n.id ?? 'node'),
      kind: String(n.kind ?? n.role ?? (n.isLocal ? 'this device' : 'node')),
      online: n.online ?? n.connected ?? n.status === 'online' ?? false,
      local: !!(n.isLocal || n.local),
    }));
    const nodesOnline = nodes.filter((n) => n.online).length;

    // Discipline
    const blocks = asArray(data.discipline.blocks);
    const blockCompletions = asArray(data.discipline.blockCompletions);
    const completedSet = new Set(blockCompletions.map((c) => String(c.blockId ?? c.id)));
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const parseMin = (v) => {
      if (typeof v === 'number') return v;
      const m = String(v ?? '').match(/(\d{1,2}):(\d{2})/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
    };
    const timelineBlocks = blocks.map((b) => {
      const startMin = parseMin(b.start ?? b.startTime ?? b.startMin);
      const endMin = parseMin(b.end ?? b.endTime ?? b.endMin) || startMin + 30;
      const done = completedSet.has(String(b.id));
      const activeNow = nowMin >= startMin && nowMin < endMin;
      return {
        id: String(b.id ?? ''),
        label: String(b.label ?? b.title ?? 'Block'),
        startMin,
        endMin,
        state: done ? 'done' : activeNow ? 'active' : 'todo',
      };
    });
    const currentBlock = timelineBlocks.find((b) => b.state === 'active');
    const todayScore = Number(data.discipline.todayScore ?? data.discipline.score ?? 0);

    // Income streams + daily
    const streams = asArray(data.income.incomeStreams ?? data.income.streams);
    const daily = asArray(data.income.dailyData ?? data.income.daily).map((d) =>
      typeof d === 'number' ? d : Number(d.amount ?? d.value ?? 0),
    );

    // ── Projects in progress (group tasks by project, mirror web) ──
    const projectNameById = new Map();
    data.projects.forEach((p) => {
      const id = String(p.id ?? '');
      if (id) projectNameById.set(id, String(p.name ?? p.title ?? 'Project'));
    });
    const projectStats = new Map();
    data.tasks.forEach((t) => {
      const pid = String(t.projectId ?? t.project_id ?? '');
      if (!pid) return;
      const s = projectStats.get(pid) ?? { total: 0, ip: 0, done: 0, blocked: 0 };
      s.total += 1;
      if (isBlocked(t)) s.blocked += 1;
      else {
        const st = normStatus(t.status);
        if (/done|complete/.test(st)) s.done += 1;
        else if (/progress|doing|updating/.test(st)) s.ip += 1;
      }
      projectStats.set(pid, s);
    });
    const projectsInProgress = [...projectStats.entries()]
      .filter(([, s]) => s.ip > 0 || s.blocked > 0 || s.total > s.done)
      .map(([id, s]) => ({
        id,
        name: projectNameById.get(id) ?? 'Project',
        total: s.total,
        inProgress: s.ip,
        done: s.done,
        blocked: s.blocked,
        progress: s.total > 0 ? Math.round((s.done / s.total) * 100) : 0,
      }))
      .sort((a, b) => b.inProgress + b.blocked - (a.inProgress + a.blocked))
      .slice(0, 5);

    // ── Clients in progress (active engagements) ──
    const clientGet = (c, keys) => {
      for (const k of keys) {
        const v = c?.[k] ?? c?.data?.[k];
        if (v != null && v !== '') return v;
      }
      return undefined;
    };
    const clientsInProgress = data.clients
      .map((c) => {
        const status = String(clientGet(c, ['status', 'Status', 'stage', 'Stage']) ?? '');
        const st = status.toLowerCase().replace(/\s+/g, '_');
        const inProg = /progress|active|engaged|onboard|building|delivery/.test(st);
        if (!inProg) return null;
        const startedAt = Number(
          clientGet(c, ['startedAt', 'created_at', 'createdAt']) ?? 0,
        );
        const lastActivityAt = Number(
          clientGet(c, ['lastActivityAt', 'updated_at', 'updatedAt']) ?? 0,
        ) || null;
        return {
          id: String(c.id ?? clientGet(c, ['Name', 'name']) ?? Math.random()),
          name: String(clientGet(c, ['name', 'Name', 'Client', 'title']) ?? 'Client'),
          status: status || 'In progress',
          project: String(clientGet(c, ['activeProjectTitle', 'Active Project', 'projectName', 'Project']) ?? ''),
          progress: Math.max(0, Math.min(100, Math.round(Number(clientGet(c, ['progress', 'Progress', '% Complete']) ?? 0)))),
          daysInProgress: startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 86400000)) : 0,
          lastActivityAt,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .slice(0, 6);

    // ── Business federation summaries (lightweight, from already-loaded data) ──
    const businessSummaries = data.businesses
      .map((b) => {
        const bid = String(b.id ?? '');
        const bizClients = data.clients.filter(
          (c) => String(clientGet(c, ['businessId', 'Business ID', 'business_id']) ?? '') === bid,
        );
        const activeClients = bizClients.filter((c) => {
          const st = String(clientGet(c, ['status', 'Status']) ?? '').toLowerCase();
          return /progress|active|engaged/.test(st);
        }).length;
        const projInProg = data.projects.filter((p) => {
          const pbid = String(p.businessId ?? '');
          if (pbid && pbid !== bid) return false;
          const st = normStatus(p.status);
          return /progress|updating|reviewing/.test(st) || p.active === true;
        }).length;
        const blockedTasks = data.tasks.filter(
          (t) => isBlocked(t) && String(t.businessId ?? '') === bid,
        ).length;
        const status = blockedTasks > 3 ? 'red' : blockedTasks > 0 || projInProg === 0 ? 'amber' : 'green';
        return {
          id: bid,
          name: String(b.name ?? 'Business'),
          activeClients,
          projectsInProgress: projInProg,
          blockedTasks,
          status,
        };
      })
      .sort((a, b) => b.activeClients - a.activeClients)
      .slice(0, 6);

    // ── Autonomy oversight mini (read-only summary of autonomy:status) ──
    const a = data.autonomy || {};
    const pendingTasks = asArray(a.pendingTasks);
    const recentAudit = asArray(a.recentAudit);
    const isPaused = !!a.pauseState?.isPaused;
    const blockedTask = pendingTasks.find((t) => normStatus(t.currentPhase) === 'awaiting_prefire');
    const autoStatus = a.error
      ? 'error'
      : isPaused
        ? 'paused'
        : blockedTask
          ? 'blocked'
          : a.runningTask
            ? 'running'
            : 'idle';
    const autonomyMini = {
      status: autoStatus,
      statusLabel:
        autoStatus === 'paused'
          ? `Paused${a.pauseState?.reason ? ` · ${a.pauseState.reason}` : ''}`
          : autoStatus === 'blocked'
            ? 'Blocked on prefire'
            : autoStatus === 'running'
              ? `Running ${String(a.runningTask?.title ?? 'task')}`
              : autoStatus === 'error'
                ? 'Autonomy unavailable'
                : 'Idle',
      openPrefireDrafts: pendingTasks.filter(
        (t) => normStatus(t.currentPhase) === 'awaiting_prefire' || t.context?.prefireRequired === true,
      ).length,
      decisions: recentAudit
        .filter((e) => {
          const cat = normStatus(e.category);
          const at = normStatus(e.actionType);
          return cat.includes('autonomy') || at.includes('approval') || at.includes('prefire');
        })
        .slice(0, 3)
        .map((e) => {
          const outcome = normStatus(e.outcome);
          return {
            id: String(e.id ?? e.timestamp ?? Math.random()),
            timestamp: Number(e.timestamp ?? Date.now()),
            summary: String(e.description ?? e.actionType ?? 'Autonomy decision').slice(0, 88),
            ok: /success|approved|completed/.test(outcome),
          };
        }),
    };

    // ── Proactive insight synthesis (client-side, merged with backend) ──
    const blockedCount = tasksByStatus.blocked.length;
    const synth = [];
    if (blockedCount > 0) {
      synth.push({
        id: 'synth-blocked-tasks',
        title: `${blockedCount} task${blockedCount === 1 ? '' : 's'} blocked`,
        description: 'Clear blockers first — downstream work is stalled until you act.',
        severity: blockedCount >= 3 ? 'high' : 'medium',
        actionable: true,
      });
    }
    const inProgressTotal = tasksByStatus.in_progress.length;
    if (inProgressTotal > 12) {
      synth.push({
        id: 'synth-wip-overflow',
        title: `${inProgressTotal} tasks in progress`,
        description: 'Too many open threads. Finish or park half of them.',
        severity: 'medium',
        actionable: true,
      });
    }
    if (shipped24.length === 0 && data.completed.length > 0) {
      const lastDone = Math.max(...data.completed.map((e) => Number(e.completedAt ?? e.finishedAt ?? 0)));
      const hoursSince = (Date.now() - lastDone) / 3600000;
      if (hoursSince > 24) {
        synth.push({
          id: 'synth-completion-drought',
          title: `No completions in ${Math.floor(hoursSince)}h`,
          description: 'Momentum is slipping. Ship one small task to break the seal.',
          severity: hoursSince > 72 ? 'high' : 'medium',
          actionable: true,
        });
      }
    }
    const failedRuns = data.completed.filter((e) => normStatus(e.status) === 'error').length;
    if (failedRuns >= 3) {
      synth.push({
        id: 'synth-agent-failures',
        title: `${failedRuns} agent runs failed recently`,
        description: 'Check the failure mode — same agent twice usually means a broken brief.',
        severity: 'high',
        actionable: true,
      });
    }
    const agedUrgent = data.tasks.filter((t) => {
      const pri = normStatus(t.priority);
      const st = normStatus(t.status);
      return (pri === 'urgent' || pri === 'high') && !/done|complete/.test(st) &&
        Number(t.createdAt ?? 0) < Date.now() - 14 * 86400000;
    }).length;
    if (agedUrgent > 0) {
      synth.push({
        id: 'synth-aged-urgent',
        title: `${agedUrgent} urgent task${agedUrgent === 1 ? '' : 's'} aging > 2 weeks`,
        description: "Urgent work shouldn't sit. Re-scope, delegate, or kill.",
        severity: 'high',
        actionable: true,
      });
    }
    const backendInsights = (data.insights || []).filter((i) => i && i.title);
    const seenIds = new Set(backendInsights.map((i) => i.id));
    const sevRank = (s) => (s === 'high' || s === 'critical' ? 0 : s === 'medium' || s === 'warn' ? 1 : 2);
    const mergedInsights = [...backendInsights, ...synth.filter((i) => !seenIds.has(i.id))]
      .sort((x, y) => sevRank(String(x.severity)) - sevRank(String(y.severity)))
      .slice(0, 8);

    // ── CEO strategic insights (high-altitude alerts, mirror computeInsights) ──
    const ceoInsights = [];
    const ceoAdd = (i) => ceoInsights.push(i);
    if (blockedCount > 3) {
      ceoAdd({
        id: 'ceo-blocked',
        severity: 'critical',
        title: `${blockedCount} tasks blocked`,
        rationale: 'Blocked work is threatening delivery — clear the critical path.',
      });
    }
    const offlineNodes = nodes.filter((n) => !n.online && !n.local).length;
    if (offlineNodes > 0) {
      ceoAdd({
        id: 'ceo-nodes-offline',
        severity: 'warn',
        title: `${offlineNodes} satellite${offlineNodes === 1 ? '' : 's'} offline`,
        rationale: 'Remote federation nodes are unreachable — fleet capacity is reduced.',
      });
    }
    const idleClient = clientsInProgress.find(
      (c) => c.lastActivityAt != null && Date.now() - c.lastActivityAt > 7 * 86400000,
    );
    if (idleClient) {
      ceoAdd({
        id: `ceo-idle-client-${idleClient.id}`,
        severity: 'warn',
        title: `${idleClient.name} idle ${Math.floor((Date.now() - idleClient.lastActivityAt) / 86400000)}d`,
        rationale: 'An in-progress client has no recent activity and may need follow-up.',
      });
    }
    if (autoStatus === 'blocked' || (autoStatus === 'paused' && autonomyMini.openPrefireDrafts > 0)) {
      ceoAdd({
        id: 'ceo-autonomy',
        severity: 'warn',
        title: `Autonomy ${autoStatus}`,
        rationale: 'The autonomous work loop needs a decision to advance.',
      });
    }
    if (failedRuns >= 3) {
      ceoAdd({
        id: 'ceo-failures',
        severity: 'warn',
        title: `${failedRuns} agent runs failed`,
        rationale: 'A cluster of failures usually means a broken brief or a flaky tool.',
      });
    }
    const ceoRank = { critical: 0, warn: 1, success: 2, info: 3 };
    ceoInsights.sort((x, y) => ceoRank[x.severity] - ceoRank[y.severity]);
    const ceoTop = ceoInsights.slice(0, 5);

    // ── Daily briefing (CEO synthesis — headline + bullet lines) ──
    const focusTop = focusList.find((p) => p.isFocus) ?? focusList[0];
    const briefLines = [];
    if (running.length > 0) {
      briefLines.push({ tone: 'primary', icon: 'hardware-chip', text: `${running.length} agent${running.length === 1 ? '' : 's'} actively working — ${shipped24.length} shipped in the last 24h.` });
    } else if (shipped24.length > 0) {
      briefLines.push({ tone: 'ok', icon: 'checkmark-circle', text: `${shipped24.length} task${shipped24.length === 1 ? '' : 's'} shipped in 24h. Fleet is idle.` });
    } else {
      briefLines.push({ tone: 'info', icon: 'information-circle', text: 'Fleet is idle. Spin up a goal or kick off a workflow.' });
    }
    if (blockedCount > 0) {
      briefLines.push({ tone: 'danger', icon: 'alert-circle', text: `${blockedCount} task${blockedCount === 1 ? '' : 's'} blocked — clear blockers to unblock downstream work.` });
    }
    if (mergedInsights[0]) {
      briefLines.push({ tone: sevRank(String(mergedInsights[0].severity)) === 0 ? 'warn' : 'info', icon: 'flash', text: String(mergedInsights[0].title) });
    }
    if (Number(data.income.today) > 0) {
      briefLines.push({ tone: 'ok', icon: 'cash', text: `${fmtMoney(data.income.today)} earned today · ${fmtMoney(data.income.week)} this week.` });
    }
    if (currentBlock) {
      briefLines.push({ tone: 'primary', icon: 'timer', text: `Now in: ${currentBlock.label}.` });
    }
    if (focusTop) {
      briefLines.push({ tone: focusTop.progress >= 70 ? 'ok' : 'primary', icon: 'locate', text: `Focus: "${focusTop.title}" — ${focusTop.progress}% done${focusTop.nextStep ? ` · next: ${focusTop.nextStep}` : ''}.` });
    }
    if (nodes.length > 1) {
      const hasRemote = nodes.some((n) => !n.local && n.online);
      briefLines.push({ tone: hasRemote ? 'info' : 'warn', icon: 'git-network', text: `${nodesOnline}/${nodes.length} nodes online${hasRemote ? ' — fleet is healthy.' : ' — remote satellites offline.'}` });
    }
    let headline;
    if (blockedCount > 0) headline = `${blockedCount} blocker${blockedCount === 1 ? '' : 's'} need your attention — InfiniBot is on the rest.`;
    else if (running.length > 0) headline = `InfiniBot is on it — ${running.length} agent${running.length === 1 ? '' : 's'} working, ${shipped24.length} shipped today.`;
    else if (shipped24.length > 0) headline = `${shipped24.length} task${shipped24.length === 1 ? '' : 's'} shipped today. Queue what's next.`;
    else headline = 'Quiet day. Set a goal or spawn an agent to get moving.';
    const briefing = { headline, lines: briefLines.slice(0, 8) };

    return {
      running,
      completedToday,
      shipped24,
      tasksByStatus,
      hourly,
      peakHour,
      velocity,
      roster,
      pipeline,
      focusList,
      avgProg,
      surfaces,
      recentPages,
      nodes,
      nodesOnline,
      timelineBlocks,
      currentBlock,
      todayScore,
      streams,
      daily,
      insights: mergedInsights,
      projectsInProgress,
      clientsInProgress,
      businessSummaries,
      autonomyMini,
      ceoInsights: ceoTop,
      briefing,
      blockedCount,
    };
  }, [data]);
}

// ============================================================
// Reusable card chrome
// ============================================================
function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function SectionHeader({ icon, title, subtitle, accent, onPress, actionLabel }) {
  return (
    <View style={styles.sectionHead}>
      <View style={styles.sectionHeadLeft}>
        {icon ? (
          <View style={[styles.sectionIcon, { backgroundColor: withAlpha(accent || COLORS.primary, 0.14) }]}>
            <Ionicons name={icon} size={15} color={accent || COLORS.primary} />
          </View>
        ) : null}
        <View style={{ flexShrink: 1 }}>
          <Text style={styles.sectionTitle} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.sectionSub} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {onPress ? (
        <TouchableOpacity onPress={onPress} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={[styles.sectionAction, { color: accent || COLORS.primary }]}>{actionLabel || 'View'} ›</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function EmptyHint({ text }) {
  return <Text style={styles.empty}>{text}</Text>;
}

function StatPill({ label, value, color }) {
  return (
    <View style={styles.statPill}>
      <Text style={[styles.statPillValue, color && { color }]}>{value}</Text>
      <Text style={styles.statPillLabel}>{label}</Text>
    </View>
  );
}

// ── In-place action chrome (Focus & Priorities + AI Recommendations) ──
function ActionBtn({ icon, label, color, onPress, primary }) {
  const c = color || COLORS.primary;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[
        styles.actionBtn,
        { borderColor: withAlpha(c, primary ? 0.55 : 0.28), backgroundColor: withAlpha(c, primary ? 0.2 : 0.08) },
      ]}
    >
      {icon ? <Ionicons name={icon} size={12} color={c} style={{ marginRight: 4 }} /> : null}
      <Text style={[styles.actionBtnTxt, { color: c }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

function InlineError({ text }) {
  if (!text) return null;
  return (
    <View style={styles.inlineError}>
      <Ionicons name="warning" size={12} color={COLORS.error} style={{ marginRight: 6 }} />
      <Text style={styles.inlineErrorTxt} numberOfLines={2}>{text}</Text>
    </View>
  );
}

// Swipeable row wrapper — swipe-right = Mark Complete, swipe-left = Snooze.
// Gestures are an enhancement layered over the always-present action buttons.
function SwipeRow({ onComplete, onSnooze, children }) {
  const ref = React.useRef(null);
  const renderLeft = onComplete
    ? (progress) => (
        <SwipeReveal value={progress} style={[styles.swipeAction, { backgroundColor: withAlpha(COLORS.success, 0.18), borderColor: COLORS.success }]}>
          <Ionicons name="checkmark-done" size={16} color={COLORS.success} />
          <Text style={[styles.swipeActionTxt, { color: COLORS.success }]}>Complete</Text>
        </SwipeReveal>
      )
    : undefined;
  const renderRight = onSnooze
    ? (progress) => (
        <SwipeReveal value={progress} style={[styles.swipeAction, styles.swipeActionRight, { backgroundColor: withAlpha(COLORS.warning, 0.18), borderColor: COLORS.warning }]}>
          <Ionicons name="time" size={16} color={COLORS.warning} />
          <Text style={[styles.swipeActionTxt, { color: COLORS.warning }]}>Snooze</Text>
        </SwipeReveal>
      )
    : undefined;
  return (
    <Swipeable
      ref={ref}
      renderLeftActions={renderLeft}
      renderRightActions={renderRight}
      leftThreshold={56}
      rightThreshold={56}
      friction={2}
      overshootLeft={false}
      overshootRight={false}
      // ReanimatedSwipeable reports the swipe direction: 'right' = left actions opened.
      onSwipeableOpen={(dir) => {
        ref.current?.close();
        if (dir === 'right' && onComplete) { Vibration.vibrate(20); onComplete(); }
        else if (dir === 'left' && onSnooze) { Vibration.vibrate(20); onSnooze(); }
      }}
    >
      {children}
    </Swipeable>
  );
}

// ============================================================
// Greeting header
// ============================================================
function GreetingHeader({ name, runningCount, nodesOnline, nodesTotal }) {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 60000);
    return () => clearInterval(t);
  }, []);
  const hr = time.getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  return (
    <View style={styles.greeting}>
      <BlurView intensity={Platform.OS === 'android' ? 45 : 60} tint="dark" style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={[withAlpha(COLORS.primary, 0.22), withAlpha(COLORS.primary, 0.06), 'rgba(0,0,0,0.4)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <LinearGradient colors={innerTopHighlight} start={{ x: 0, y: 0 }} end={{ x: 0, y: 0.55 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <View
        style={[StyleSheet.absoluteFill, { borderRadius: 22, borderWidth: 1, borderColor: withAlpha(COLORS.primary, 0.18) }]}
        pointerEvents="none"
      />
      <View style={styles.greetingInner}>
        <Text style={styles.greetingEyebrow}>INFINIBOT · COMMAND CENTER</Text>
        <Text style={styles.greetingTitle}>
          {greet}
          {name ? `, ${name}` : ''}
        </Text>
        <View style={styles.greetingMeta}>
          <View style={styles.greetingMetaItem}>
            <View style={[styles.pulseDot, { backgroundColor: COLORS.success }]} />
            <Text style={styles.greetingMetaText}>{runningCount} agents working</Text>
          </View>
          <Text style={styles.greetingMetaDot}>·</Text>
          <Text style={styles.greetingMetaText}>
            {nodesOnline}/{nodesTotal} nodes online
          </Text>
          <Text style={styles.greetingMetaDot}>·</Text>
          <Text style={styles.greetingMetaText}>{timeStr}</Text>
        </View>
      </View>
    </View>
  );
}

// ============================================================
// KPI strip
// ============================================================
function KpiStrip({ d }) {
  const tiles = [
    { label: 'Active Agents', value: d.running.length, icon: 'flash', color: COLORS.primary, spark: d.hourly.slice(-12) },
    { label: 'Done Today', value: d.completedToday.length, icon: 'checkmark-done', color: COLORS.success, spark: d.hourly.slice(-12) },
    { label: 'In Progress', value: d.tasksByStatus.in_progress.length, icon: 'sync', color: COLORS.info },
    { label: 'Blocked', value: d.tasksByStatus.blocked.length, icon: 'alert-circle', color: COLORS.warning },
    { label: 'Queue', value: d.tasksByStatus.todo.length, icon: 'list', color: COLORS.purple },
    { label: 'Shipped 24h', value: d.shipped24.length, icon: 'rocket', color: COLORS.cyan, spark: d.hourly },
  ];
  return (
    <View style={styles.kpiGrid}>
      {tiles.map((t) => (
        <View key={t.label} style={styles.kpiTile}>
          <View style={styles.kpiTop}>
            <View style={[styles.kpiIcon, { backgroundColor: withAlpha(t.color, 0.14) }]}>
              <Ionicons name={t.icon} size={14} color={t.color} />
            </View>
            {t.spark ? <Sparkline data={t.spark} width={52} height={20} color={t.color} /> : <View style={{ height: 20 }} />}
          </View>
          <Text style={styles.kpiValue}>{fmtCompact(t.value)}</Text>
          <Text style={styles.kpiLabel}>{t.label}</Text>
        </View>
      ))}
    </View>
  );
}

// ============================================================
// Main screen
// ============================================================
export function DashboardScreen({ gateway, navigation }) {
  const insets = useSafeAreaInsets();
  const { data, loading, reload } = useDashboardData(gateway);
  const d = useDerived(data);
  const [refreshing, setRefreshing] = useState(false);
  const [hideRevenue, setHideRevenue] = useState(false);
  const sendReq = gateway?.sendReq;
  // Secure Mode: the dashboard body becomes the secure board while it is on.
  const { colors: themeColors } = useTheme();
  const gwConnected = gateway?.status === 'connected';
  const secure = useSecureMode(sendReq, gateway?.subscribeEvent, { connected: gwConnected });
  const secureOn = secure.enabled;

  // ── Preset (web parity) — hydrate from storage, persist on change ──
  // Seed from the session cache so remounts paint the saved preset immediately
  // (no flash of the 'full' layout); fall back to async storage on first load.
  const [preset, setPreset] = useState(() => _presetCache ?? 'full');
  useEffect(() => {
    let alive = true;
    getDashboardPreset().then((p) => {
      _presetCache = p;
      if (alive) setPreset(p);
    });
    return () => { alive = false; };
  }, []);
  const changePreset = useCallback((p) => {
    _presetCache = p;
    setPreset(p);
    setDashboardPreset(p);
  }, []);
  const show = useMemo(() => makeShow(preset), [preset]);

  // ── In-place action state (optimistic, local overrides) ──
  // Focus & Priorities
  const [removedPriorityIds, setRemovedPriorityIds] = useState(() => new Set());
  const [pinnedPriorityIds, setPinnedPriorityIds] = useState(() => new Set());
  const [priorityError, setPriorityError] = useState('');
  // AI Recommendations
  const [removedRecIds, setRemovedRecIds] = useState(() => new Set());
  const [dismissedRecIds, setDismissedRecIds] = useState(() => new Set());
  const [recSnoozes, setRecSnoozesState] = useState({});
  const [recError, setRecError] = useState('');

  // Hydrate persisted rec dismiss/snooze maps
  useEffect(() => {
    let alive = true;
    getRecDismissed().then((ids) => { if (alive) setDismissedRecIds(new Set(ids)); });
    getRecSnoozes().then((m) => { if (alive) setRecSnoozesState(m || {}); });
    return () => { alive = false; };
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const go = (route, params) => {
    try {
      navigation?.navigate(route, params);
    } catch {}
  };
  const goModal = (route, params) => {
    try {
      navigation?.getParent()?.navigate(route, params) ?? navigation?.navigate(route, params);
    } catch {}
  };

  // ── Mutation helper: optimistic with revert on RPC failure ──
  const callRpc = useCallback(async (method, params) => {
    if (!sendReq) throw new Error('Not connected to gateway');
    const res = await sendReq(method, params);
    return res;
  }, [sendReq]);

  // ── Focus & Priorities actions ──
  const priorityComplete = useCallback(async (p) => {
    setPriorityError('');
    setRemovedPriorityIds((s) => new Set(s).add(p.id)); // optimistic remove
    try {
      await callRpc('systems.priorities.update', { id: p.id, status: 'completed' });
    } catch (e) {
      setRemovedPriorityIds((s) => { const n = new Set(s); n.delete(p.id); return n; }); // revert
      setPriorityError(`Couldn't complete "${p.title}". ${e?.message || ''}`.trim());
    }
  }, [callRpc]);

  const priorityPin = useCallback(async (p) => {
    setPriorityError('');
    const wasPinned = pinnedPriorityIds.has(p.id);
    setPinnedPriorityIds((s) => { // optimistic toggle
      const n = new Set(s);
      if (wasPinned) n.delete(p.id); else n.add(p.id);
      return n;
    });
    try {
      await callRpc('systems.priorities.update', { id: p.id, rank: wasPinned ? 99 : 1 });
    } catch (e) {
      setPinnedPriorityIds((s) => { // revert
        const n = new Set(s);
        if (wasPinned) n.add(p.id); else n.delete(p.id);
        return n;
      });
      setPriorityError(`Couldn't ${wasPinned ? 'unpin' : 'pin'} "${p.title}". ${e?.message || ''}`.trim());
    }
  }, [callRpc, pinnedPriorityIds]);

  const priorityHandoff = useCallback(async (p) => {
    setPriorityError('');
    const task = `Work on priority: ${p.title}${p.nextStep ? ` — next: ${p.nextStep}` : ''}`;
    try {
      await callRpc('sessions.spawn', { task, agentId: 'coder', label: String(p.title).slice(0, 60) });
      Vibration.vibrate(20);
    } catch (e) {
      setPriorityError(`Couldn't hand off "${p.title}". ${e?.message || ''}`.trim());
    }
  }, [callRpc]);

  const priorityActionSheet = useCallback((p) => {
    const pinned = pinnedPriorityIds.has(p.id);
    Alert.alert(p.title, p.nextStep ? `→ ${p.nextStep}` : undefined, [
      { text: 'Mark Complete', onPress: () => priorityComplete(p) },
      { text: pinned ? 'Unpin' : 'Pin to Top', onPress: () => priorityPin(p) },
      { text: 'Hand off to agent', onPress: () => priorityHandoff(p) },
      { text: 'Open', onPress: () => goModal('AutonomyModal') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [pinnedPriorityIds, priorityComplete, priorityPin, priorityHandoff]);

  // ── AI Recommendations actions ──
  const isSpawnRec = (rec) => {
    const blob = `${rec.id || ''} ${rec.title || ''} ${rec.description || ''} ${rec.actionType || ''} ${rec.kind || ''}`.toLowerCase();
    return !!rec.coderTask || /spawn|coder|agent|delegate|kick off|ship|build|run/.test(blob);
  };

  const recApproveSpawn = useCallback(async (rec) => {
    setRecError('');
    setRemovedRecIds((s) => new Set(s).add(rec.id)); // optimistic remove
    try {
      await callRpc('sessions.spawn', {
        task: rec.coderTask || rec.description || rec.title,
        agentId: 'coder',
        label: String(rec.title || 'Recommendation').slice(0, 60),
      });
      Vibration.vibrate(20);
    } catch (e) {
      setRemovedRecIds((s) => { const n = new Set(s); n.delete(rec.id); return n; }); // revert
      setRecError(`Couldn't spawn for "${rec.title}". ${e?.message || ''}`.trim());
    }
  }, [callRpc]);

  const recComplete = useCallback(async (rec) => {
    setRecError('');
    const taskId = rec.taskId || rec.kanbanTaskId || rec.task_id;
    setRemovedRecIds((s) => new Set(s).add(rec.id)); // optimistic remove
    if (!taskId) return; // local-only dismiss when no linked task
    try {
      await callRpc('kanban.tasks.update', { id: taskId, patch: { status: 'done', done: true } });
    } catch (e) {
      setRemovedRecIds((s) => { const n = new Set(s); n.delete(rec.id); return n; }); // revert
      setRecError(`Couldn't complete "${rec.title}". ${e?.message || ''}`.trim());
    }
  }, [callRpc]);

  const recSnooze = useCallback((rec, ms) => {
    const until = Date.now() + ms;
    setRecSnoozesState((prev) => {
      const next = { ...prev, [rec.id]: until };
      setRecSnoozes(next);
      return next;
    });
  }, []);

  const recDismiss = useCallback((rec) => {
    setDismissedRecIds((prev) => {
      const next = new Set(prev).add(rec.id);
      setRecDismissed([...next]);
      return next;
    });
  }, []);

  const recActionSheet = useCallback((rec) => {
    const buttons = [];
    if (isSpawnRec(rec)) buttons.push({ text: 'Approve & Spawn', onPress: () => recApproveSpawn(rec) });
    buttons.push({ text: 'Mark Complete', onPress: () => recComplete(rec) });
    buttons.push({ text: 'Snooze 1h', onPress: () => recSnooze(rec, 60 * 60 * 1000) });
    buttons.push({ text: 'Snooze 1d', onPress: () => recSnooze(rec, 24 * 60 * 60 * 1000) });
    buttons.push({ text: 'Dismiss', style: 'destructive', onPress: () => recDismiss(rec) });
    buttons.push({ text: 'Open', onPress: () => goModal('AutonomyModal') });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(String(rec.title || 'Recommendation'), rec.description ? String(rec.description) : undefined, buttons);
  }, [recApproveSpawn, recComplete, recSnooze, recDismiss]);

  // ── Derived display lists (apply local overrides on top of d) ──
  const focusDisplay = useMemo(() => {
    if (!d) return [];
    const list = d.focusList.filter((p) => !removedPriorityIds.has(p.id));
    // pinned ids float to the top, preserving relative order otherwise
    return list.slice().sort((a, b) => {
      const ap = pinnedPriorityIds.has(a.id) ? 0 : 1;
      const bp = pinnedPriorityIds.has(b.id) ? 0 : 1;
      return ap - bp;
    });
  }, [d, removedPriorityIds, pinnedPriorityIds]);

  const recsDisplay = useMemo(() => {
    if (!d) return [];
    const now = Date.now();
    return d.insights.filter((ins) => {
      const id = String(ins.id ?? '');
      if (removedRecIds.has(id) || dismissedRecIds.has(id)) return false;
      const until = recSnoozes[id];
      if (until && until > now) return false;
      return true;
    });
  }, [d, removedRecIds, dismissedRecIds, recSnoozes]);

  const segColors = SEG_COLORS();

  return (
    <GestureHandlerRootView style={[styles.root, secureFrameStyle(themeColors, secureOn)]}>
    <ScrollView
      style={styles.root}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: DOCK_BOTTOM_SPACE + insets.bottom + 24, paddingHorizontal: H_PAD }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} colors={[COLORS.primary]} />}
    >
      {/* Hero greeting */}
      <GreetingHeader
        name={data?.me?.name || data?.me?.displayName}
        runningCount={d?.running.length ?? 0}
        nodesOnline={d?.nodesOnline ?? 0}
        nodesTotal={d?.nodes.length ?? 0}
      />

      <SecureModeBar secure={secure} connected={gwConnected} style={{ paddingHorizontal: 0 }} />

      {secureOn ? (
        <SecureBoard sendReq={sendReq} subscribeEvent={gateway?.subscribeEvent} connected={gwConnected} style={{ marginTop: 8 }} />
      ) : (
      <>
      {/* Preset switcher (always visible) */}
      <PresetBar preset={preset} onChange={changePreset} />

      {/* Today's Priorities — prominent shared (web + mobile) daily checklist.
          Always visible near the top, above the data-load gate. */}
      <TodaysPriorities gateway={gateway} />

      {loading && !d ? (
        <Card style={{ marginTop: 16, alignItems: 'center', paddingVertical: 40 }}>
          <Text style={styles.empty}>Loading command center…</Text>
        </Card>
      ) : !d ? (
        <Card style={{ marginTop: 16, alignItems: 'center', paddingVertical: 40 }}>
          <Ionicons name="cloud-offline-outline" size={28} color={COLORS.textMuted} />
          <Text style={[styles.empty, { marginTop: 8 }]}>Connect to the gateway to load your dashboard.</Text>
        </Card>
      ) : (
        <>
          {/* ── Daily briefing (CEO synthesis) ── */}
          {show('proactive') && d.briefing ? (
            <Card style={[styles.section, styles.briefCard]}>
              <View style={styles.briefHead}>
                <View style={styles.briefBadge}>
                  <Ionicons name="sparkles" size={13} color={COLORS.primary} />
                  <Text style={styles.briefEyebrow}>DAILY BRIEFING</Text>
                </View>
                <Text style={styles.briefTime}>{new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</Text>
              </View>
              <Text style={styles.briefHeadline}>{d.briefing.headline}</Text>
              {d.briefing.lines.map((ln, i) => {
                const tc =
                  ln.tone === 'danger' ? COLORS.error :
                  ln.tone === 'warn' ? COLORS.warning :
                  ln.tone === 'ok' ? COLORS.success :
                  ln.tone === 'primary' ? COLORS.primary : COLORS.info;
                return (
                  <View key={i} style={styles.briefLine}>
                    <Ionicons name={ln.icon} size={14} color={tc} style={{ marginRight: 8, marginTop: 1 }} />
                    <Text style={styles.briefLineTxt}>{ln.text}</Text>
                  </View>
                );
              })}
            </Card>
          ) : null}

          {/* ── Proactive Overhaul v2: commitment-enforced focus + drift radar ── */}
          {show('proactive') && <ProactiveSection gateway={gateway} />}

          {/* ── Agent Field (world-map summary) ── */}
          {show('world-map') && (
          <Card style={styles.section}>
            <SectionHeader
              icon="planet"
              title="Agent Field"
              subtitle="Live operations"
              accent={COLORS.primary}
              onPress={() => goModal('NeuralMeshModal')}
              actionLabel="Open map"
            />
            <View style={styles.fieldRow}>
              <StatPill label="Working" value={d.running.length} color={COLORS.success} />
              <StatPill label="Nodes" value={`${d.nodesOnline}/${d.nodes.length}`} color={COLORS.info} />
              <StatPill label="Shipped 24h" value={d.shipped24.length} color={COLORS.primary} />
              <StatPill label="Agents" value={d.roster.length} color={COLORS.purple} />
            </View>
            <Text style={styles.fieldNote}>
              The live world map is available full-screen on the Agent Mesh view.
            </Text>
            {(preset === 'operator' || preset === 'full') ? (
              <View style={styles.desktopHintRow}>
                <Ionicons name="desktop-outline" size={13} color={COLORS.textMuted} style={{ marginRight: 6 }} />
                <Text style={styles.desktopHintTxt}>Open the live world map on desktop for the full Pixi view.</Text>
              </View>
            ) : null}
          </Card>
          )}

          {/* ── KPI strip ── */}
          {show('kpi-strip') && (
          <View style={styles.section}>
            <KpiStrip d={d} />
          </View>
          )}

          {/* ── Activity timeline (24h) ── */}
          {show('activity-timeline') && (
          <Card style={styles.section}>
            <SectionHeader icon="bar-chart" title="Activity Timeline" subtitle="Completions · last 24h" accent={COLORS.primary} />
            {d.shipped24.length ? (
              <>
                <BarChart data={d.hourly} width={CARD_W - 32} height={88} color={COLORS.primary} />
                <View style={styles.legendRow}>
                  <Text style={styles.legendItem}>● {d.shipped24.length} shipped</Text>
                  <Text style={styles.legendItem}>peak {d.peakHour}h ago band</Text>
                  <Text style={styles.legendItem}>{d.running.length} agents now</Text>
                </View>
              </>
            ) : (
              <EmptyHint text="No completions in the last 24h yet." />
            )}
          </Card>
          )}

          {/* ── Live pulse ── */}
          {show('insights-pulse') && (
          <Card style={styles.section}>
            <SectionHeader
              icon="pulse"
              title="Live Pulse"
              subtitle={`${d.running.length} running`}
              accent={COLORS.success}
              onPress={() => goModal('ActivityModal')}
              actionLabel="Full activity"
            />
            {d.running.length ? (
              d.running.slice(0, 6).map((s, i) => {
                const prog = Math.max(0, Math.min(100, Number(s.progress ?? s.percent ?? 0)));
                return (
                  <TouchableOpacity
                    key={s.runId ?? s.id ?? i}
                    style={styles.pulseRow}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${String(s.label ?? s.agentId ?? 'agent')} focus`}
                    onPress={() => goModal('TaskActivity', {
                      task: {
                        sessionKey: s.sessionKey ?? null,
                        id: s.runId ?? s.id ?? null,
                        title: String(s.label ?? s.task ?? s.agentId ?? 'Agent'),
                        status: s.status ?? 'running',
                        coderBackend: s.coderBackend,
                      },
                    })}
                  >
                    <View style={[styles.pulseDot, { backgroundColor: COLORS.success, marginTop: 6 }]} />
                    <View style={{ flex: 1 }}>
                      <View style={styles.pulseTopRow}>
                        <Text style={styles.pulseLabel} numberOfLines={1}>
                          {String(s.label ?? s.agentId ?? 'Agent')}
                        </Text>
                        <Text style={styles.pulseTime}>{timeAgo(s.startedAt ?? s.createdAt)}</Text>
                      </View>
                      <Text style={styles.pulseTask} numberOfLines={1}>
                        {String(s.task ?? s.title ?? s.summary ?? 'Working…')}
                      </Text>
                      {prog > 0 ? (
                        <View style={styles.progTrack}>
                          <View style={[styles.progFill, { width: `${prog}%`, backgroundColor: COLORS.success }]} />
                        </View>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              })
            ) : (
              <EmptyHint text="No agents running right now." />
            )}
          </Card>
          )}

          {/* ── Autonomy oversight (read-only mini) ── */}
          {show('insights-pulse') && (
          <Card style={styles.section}>
            <SectionHeader
              icon="git-commit"
              title="Autonomy"
              subtitle="Oversight"
              accent={COLORS.cyan}
              onPress={() => goModal('AutonomyModal')}
              actionLabel="Open"
            />
            <View style={styles.autoStatusRow}>
              <View style={[styles.autoDot, { backgroundColor:
                d.autonomyMini.status === 'running' ? COLORS.success :
                d.autonomyMini.status === 'blocked' ? COLORS.error :
                d.autonomyMini.status === 'paused' ? COLORS.warning :
                d.autonomyMini.status === 'error' ? COLORS.textMuted : COLORS.info }]} />
              <Text style={styles.autoStatusTxt} numberOfLines={1}>{d.autonomyMini.statusLabel}</Text>
              {d.autonomyMini.openPrefireDrafts > 0 ? (
                <View style={[styles.badge, { backgroundColor: withAlpha(COLORS.warning, 0.16) }]}>
                  <Text style={[styles.badgeTxt, { color: COLORS.warning }]}>{d.autonomyMini.openPrefireDrafts} PREFIRE</Text>
                </View>
              ) : null}
            </View>
            {d.autonomyMini.decisions.length ? (
              d.autonomyMini.decisions.map((dec, i) => (
                <View key={dec.id ?? i} style={styles.autoDecRow}>
                  <Ionicons name={dec.ok ? 'checkmark-circle' : 'ellipse-outline'} size={14} color={dec.ok ? COLORS.success : COLORS.textMuted} style={{ marginRight: 8 }} />
                  <Text style={styles.autoDecTxt} numberOfLines={1}>{dec.summary}</Text>
                  <Text style={styles.listMeta}>{timeAgo(dec.timestamp)}</Text>
                </View>
              ))
            ) : (
              <EmptyHint text="No recent autonomy decisions." />
            )}
          </Card>
          )}

          {/* ── AI Recommendations (in-place actions) ── */}
          {show('insights-pulse') && (
          <Card style={styles.section}>
            <SectionHeader icon="bulb" title="AI Recommendations" subtitle="Proactive nudges" accent={COLORS.warning} />
            <InlineError text={recError} />
            {recsDisplay.length ? (
              recsDisplay.slice(0, 5).map((ins, i) => {
                const id = String(ins.id ?? `rec-${i}`);
                const rec = { ...ins, id };
                const sev = String(ins.severity ?? 'info').toLowerCase();
                const c = sev === 'high' || sev === 'critical' ? COLORS.error : sev === 'warn' || sev === 'medium' ? COLORS.warning : COLORS.info;
                const spawnable = isSpawnRec(rec);
                return (
                  <SwipeRow
                    key={id}
                    onComplete={() => recComplete(rec)}
                    onSnooze={() => recSnooze(rec, 60 * 60 * 1000)}
                  >
                    <TouchableOpacity
                      activeOpacity={0.9}
                      onLongPress={() => { Vibration.vibrate(30); recActionSheet(rec); }}
                      delayLongPress={300}
                      style={styles.insightRow}
                    >
                      <View style={[styles.insightBar, { backgroundColor: c }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.insightTitle} numberOfLines={2}>
                          {String(ins.title ?? 'Insight')}
                        </Text>
                        {ins.description ? (
                          <Text style={styles.insightDesc} numberOfLines={2}>
                            {String(ins.description)}
                          </Text>
                        ) : null}
                        <View style={styles.actionRow}>
                          {spawnable ? (
                            <ActionBtn icon="rocket" label="Approve & Spawn" color={COLORS.primary} primary onPress={() => recApproveSpawn(rec)} />
                          ) : null}
                          <ActionBtn icon="checkmark-done" label="Complete" color={COLORS.success} onPress={() => recComplete(rec)} />
                          <ActionBtn icon="time" label="Snooze" color={COLORS.warning} onPress={() => recSnooze(rec, 60 * 60 * 1000)} />
                          <ActionBtn icon="close" label="Dismiss" color={COLORS.textMuted} onPress={() => recDismiss(rec)} />
                          <ActionBtn icon="open-outline" label="Open" color={COLORS.info} onPress={() => goModal('AutonomyModal')} />
                        </View>
                      </View>
                    </TouchableOpacity>
                  </SwipeRow>
                );
              })
            ) : (
              <EmptyHint text="No recommendations right now — all clear." />
            )}
          </Card>
          )}

          {/* ── CEO strategic insights ── */}
          {show('insights-pulse') && d.ceoInsights.length ? (
            <Card style={styles.section}>
              <SectionHeader icon="trophy" title="Strategic Alerts" subtitle="CEO view" accent={COLORS.error} />
              {d.ceoInsights.map((ci, i) => {
                const c = ci.severity === 'critical' ? COLORS.error : ci.severity === 'warn' ? COLORS.warning : ci.severity === 'success' ? COLORS.success : COLORS.info;
                return (
                  <View key={ci.id ?? i} style={styles.ceoRow}>
                    <View style={[styles.ceoBar, { backgroundColor: c }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.ceoTitle} numberOfLines={2}>{ci.title}</Text>
                      <Text style={styles.ceoRationale} numberOfLines={2}>{ci.rationale}</Text>
                    </View>
                  </View>
                );
              })}
            </Card>
          ) : null}

          {/* ── Agent roster ── */}
          {show('roster-velocity-health') && (
          <Card style={styles.section}>
            <SectionHeader icon="people" title="Agent Roster" accent={COLORS.purple} onPress={() => goModal('AgentsModal')} />
            {d.roster.length ? (
              d.roster.map((a, i) => (
                <View key={a.id || i} style={styles.rosterRow}>
                  <View style={[styles.avatar, { backgroundColor: withAlpha(segColors[i % segColors.length], 0.18) }]}>
                    <Text style={[styles.avatarTxt, { color: segColors[i % segColors.length] }]}>
                      {a.name.slice(0, 2).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rosterName} numberOfLines={1}>
                      {a.name}
                    </Text>
                    <Text style={styles.rosterMeta}>
                      {a.backend} · {a.runs} runs
                    </Text>
                  </View>
                  <View style={styles.rosterRight}>
                    <View style={styles.successTrack}>
                      <View style={[styles.successFill, { width: `${a.successPct}%`, backgroundColor: COLORS.success }]} />
                    </View>
                    <Text style={styles.rosterPct}>{a.successPct}%</Text>
                  </View>
                  <View style={[styles.onlineDot, { backgroundColor: a.active ? COLORS.success : COLORS.textMuted }]} />
                </View>
              ))
            ) : (
              <EmptyHint text="No agents registered." />
            )}
          </Card>
          )}

          {/* ── Velocity + Health row ── */}
          {show('roster-velocity-health') && (
          <View style={styles.twoCol}>
            <Card style={[styles.section, styles.col]}>
              <SectionHeader icon="git-network" title="Velocity" accent={COLORS.primary} />
              {d.velocity.length ? (
                <View style={{ alignItems: 'center' }}>
                  <Donut
                    segments={d.velocity.map(([, v], i) => ({ value: v, color: segColors[i % segColors.length] }))}
                    size={108}
                    thickness={14}
                    centerValue={d.shipped24.length}
                    centerLabel="shipped"
                  />
                  <View style={styles.donutLegend}>
                    {d.velocity.slice(0, 3).map(([name, v], i) => (
                      <View key={name} style={styles.legendChip}>
                        <View style={[styles.legendSwatch, { backgroundColor: segColors[i % segColors.length] }]} />
                        <Text style={styles.legendChipTxt} numberOfLines={1}>
                          {name} {v}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : (
                <EmptyHint text="No completions yet." />
              )}
            </Card>

            <Card style={[styles.section, styles.col]}>
              <SectionHeader icon="hardware-chip" title="Health" accent={COLORS.success} />
              <View style={{ alignItems: 'center' }}>
                <Gauge
                  value={d.nodes.length ? (d.nodesOnline / d.nodes.length) * 100 : 0}
                  size={104}
                  color={COLORS.success}
                  label={`${d.nodesOnline}/${d.nodes.length}`}
                  sublabel="nodes"
                />
                <View style={styles.fieldRow}>
                  <StatPill label="Agents" value={d.roster.filter((a) => a.active).length} color={COLORS.primary} />
                  <StatPill label="Running" value={d.running.length} color={COLORS.info} />
                </View>
              </View>
            </Card>
          </View>
          )}

          {/* ── Revenue ── */}
          {show('revenue-discipline-pipeline') && (
          <Card style={styles.section}>
            <SectionHeader
              icon="cash"
              title="Revenue"
              accent={COLORS.success}
              onPress={() => setHideRevenue((v) => !v)}
              actionLabel={hideRevenue ? 'Show' : 'Hide'}
            />
            <View style={styles.revRow}>
              <View style={styles.revCell}>
                <Text style={styles.revVal}>{fmtMoney(data.income.today, hideRevenue)}</Text>
                <Text style={styles.revLab}>Today</Text>
              </View>
              <View style={styles.revCell}>
                <Text style={styles.revVal}>{fmtMoney(data.income.week, hideRevenue)}</Text>
                <Text style={styles.revLab}>Week</Text>
              </View>
              <View style={styles.revCell}>
                <Text style={styles.revVal}>{fmtMoney(data.income.month, hideRevenue)}</Text>
                <Text style={styles.revLab}>Month</Text>
              </View>
              <View style={styles.revCell}>
                <Text style={styles.revVal}>{fmtMoney(data.income.allTime, hideRevenue)}</Text>
                <Text style={styles.revLab}>All-Time</Text>
              </View>
            </View>
            {d.daily.length ? <BarChart data={d.daily.slice(-30)} width={CARD_W - 32} height={64} color={COLORS.success} /> : null}
            {d.streams.length ? (
              <View style={{ marginTop: 10 }}>
                {d.streams.slice(0, 3).map((s, i) => (
                  <View key={i} style={styles.streamRow}>
                    <Text style={styles.streamName} numberOfLines={1}>
                      {String(s.label ?? s.name ?? 'Stream')}
                    </Text>
                    <Text style={styles.streamAmt}>{fmtMoney(s.amount ?? s.total ?? s.value, hideRevenue)}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </Card>
          )}

          {/* ── Business fleet (federation) ── */}
          {show('command-zone') && d.businessSummaries.length ? (
            <Card style={styles.section}>
              <SectionHeader icon="briefcase" title="Business Fleet" subtitle={`${d.businessSummaries.length} businesses`} accent={COLORS.primary} onPress={() => go('BusinessProfile')} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
                {d.businessSummaries.map((b) => {
                  const sc = b.status === 'red' ? COLORS.error : b.status === 'amber' ? COLORS.warning : COLORS.success;
                  return (
                    <View key={b.id} style={styles.bizCard}>
                      <View style={styles.bizHead}>
                        <View style={[styles.autoDot, { backgroundColor: sc }]} />
                        <Text style={styles.bizName} numberOfLines={1}>{b.name}</Text>
                      </View>
                      <View style={styles.bizStats}>
                        <View style={styles.bizStat}>
                          <Text style={styles.bizStatVal}>{b.activeClients}</Text>
                          <Text style={styles.bizStatLab}>clients</Text>
                        </View>
                        <View style={styles.bizStat}>
                          <Text style={styles.bizStatVal}>{b.projectsInProgress}</Text>
                          <Text style={styles.bizStatLab}>projects</Text>
                        </View>
                        <View style={styles.bizStat}>
                          <Text style={[styles.bizStatVal, { color: b.blockedTasks > 0 ? COLORS.error : COLORS.text }]}>{b.blockedTasks}</Text>
                          <Text style={styles.bizStatLab}>blocked</Text>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            </Card>
          ) : null}

          {/* ── Discipline + Pipeline row ── */}
          {show('revenue-discipline-pipeline') && (
          <View style={styles.twoCol}>
            <Card style={[styles.section, styles.col]}>
              <SectionHeader icon="timer" title="Discipline" accent={COLORS.warning} onPress={() => goModal('More')} actionLabel="" />
              <View style={{ alignItems: 'center', marginBottom: 8 }}>
                <Gauge value={d.todayScore} size={92} color={COLORS.warning} sublabel="today" />
              </View>
              {d.currentBlock ? (
                <Text style={styles.discNow} numberOfLines={1}>
                  Now: {d.currentBlock.label}
                </Text>
              ) : null}
              {d.timelineBlocks.length ? (
                <DayTimeline blocks={d.timelineBlocks} width={CARD_W / 2 - 36} height={14} />
              ) : (
                <EmptyHint text="No blocks scheduled." />
              )}
            </Card>

            <Card style={[styles.section, styles.col]}>
              <SectionHeader icon="people-circle" title="Pipeline" accent={COLORS.info} onPress={() => go('Clients')} />
              {d.pipeline.length ? (
                <View style={{ alignItems: 'center' }}>
                  <Donut
                    segments={d.pipeline.map(([, v], i) => ({ value: v, color: segColors[i % segColors.length] }))}
                    size={100}
                    thickness={13}
                    centerValue={data.clients.length}
                    centerLabel="clients"
                  />
                  <View style={styles.donutLegend}>
                    {d.pipeline.slice(0, 3).map(([name, v], i) => (
                      <View key={name} style={styles.legendChip}>
                        <View style={[styles.legendSwatch, { backgroundColor: segColors[i % segColors.length] }]} />
                        <Text style={styles.legendChipTxt} numberOfLines={1}>
                          {name} {v}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : (
                <EmptyHint text="No clients yet." />
              )}
            </Card>
          </View>
          )}

          {/* ── Priority queue ── */}
          {show('priority-shipped') && (
          <Card style={styles.section}>
            <SectionHeader icon="flag" title="Priority Queue" accent={COLORS.error} onPress={() => goModal('Board')} actionLabel="" />
            {d.tasksByStatus.blocked.concat(d.tasksByStatus.in_progress, d.tasksByStatus.todo).slice(0, 6).length ? (
              d.tasksByStatus.blocked
                .concat(d.tasksByStatus.in_progress, d.tasksByStatus.todo)
                .slice(0, 6)
                .map((t, i) => (
                  <View key={t.id ?? i} style={styles.queueRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.queueTitle} numberOfLines={1}>
                        {String(t.title ?? 'Untitled task')}
                      </Text>
                      <Text style={styles.queueMeta} numberOfLines={1}>
                        {String(t.projectName ?? t.project ?? '—')} · {timeAgo(t.updatedAt)}
                      </Text>
                    </View>
                    {isBlocked(t) ? (
                      <View style={[styles.badge, { backgroundColor: withAlpha(COLORS.error, 0.16) }]}>
                        <Text style={[styles.badgeTxt, { color: COLORS.error }]}>BLOCKED</Text>
                      </View>
                    ) : null}
                  </View>
                ))
            ) : (
              <EmptyHint text="Queue is clear." />
            )}
          </Card>
          )}

          {/* ── Recently shipped ── */}
          {show('priority-shipped') && (
          <Card style={styles.section}>
            <SectionHeader icon="checkmark-circle" title="Recently Shipped" accent={COLORS.success} />
            {d.shipped24.length ? (
              d.shipped24
                .slice()
                .sort((a, b) => Number(b.completedAt ?? 0) - Number(a.completedAt ?? 0))
                .slice(0, 6)
                .map((e, i) => (
                  <View key={e.id ?? i} style={styles.queueRow}>
                    <Ionicons name="checkmark" size={15} color={COLORS.success} style={{ marginRight: 8 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.queueTitle} numberOfLines={1}>
                        {String(e.title ?? 'Task')}
                      </Text>
                      <Text style={styles.queueMeta} numberOfLines={1}>
                        {String(e.projectName ?? '—')} · {fmtDur(e.durationMs)} · {timeAgo(e.completedAt)}
                      </Text>
                    </View>
                  </View>
                ))
            ) : (
              <EmptyHint text="Nothing shipped in the last 24h." />
            )}
          </Card>
          )}

          {/* ── Focus & priorities (in-place actions) ── */}
          {show('focus-kanban') && (
          <Card style={styles.section}>
            <SectionHeader icon="locate" title="Focus & Priorities" accent={COLORS.primary} />
            <InlineError text={priorityError} />
            {focusDisplay.length ? (
              <>
                <View style={styles.focusTop}>
                  <Gauge value={d.avgProg} size={84} color={COLORS.primary} sublabel="avg" />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={styles.focusEyebrow}>#1 FOCUS</Text>
                    <Text style={styles.focusTitle} numberOfLines={2}>
                      {focusDisplay.find((p) => p.isFocus)?.title ?? focusDisplay[0].title}
                    </Text>
                  </View>
                </View>
                {focusDisplay.slice(0, 4).map((p, i) => {
                  const pinned = pinnedPriorityIds.has(p.id);
                  return (
                    <SwipeRow key={p.id || i} onComplete={() => priorityComplete(p)}>
                      <TouchableOpacity
                        activeOpacity={0.9}
                        onLongPress={() => { Vibration.vibrate(30); priorityActionSheet(p); }}
                        delayLongPress={300}
                        style={styles.priorityRow}
                      >
                        <Text style={styles.priorityRank}>{i + 1}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.priorityTitle} numberOfLines={1}>
                            {p.title}
                          </Text>
                          {p.nextStep ? (
                            <Text style={styles.priorityNext} numberOfLines={1}>
                              → {p.nextStep}
                            </Text>
                          ) : null}
                          <View style={styles.progTrack}>
                            <View style={[styles.progFill, { width: `${p.progress}%`, backgroundColor: COLORS.primary }]} />
                          </View>
                          <View style={styles.actionRow}>
                            <ActionBtn icon="checkmark-done" label="Complete" color={COLORS.success} primary onPress={() => priorityComplete(p)} />
                            <ActionBtn icon={pinned ? 'bookmark' : 'bookmark-outline'} label={pinned ? 'Unpin' : 'Pin'} color={COLORS.warning} onPress={() => priorityPin(p)} />
                            <ActionBtn icon="git-branch" label="Hand off" color={COLORS.purple} onPress={() => priorityHandoff(p)} />
                            <ActionBtn icon="open-outline" label="Open" color={COLORS.info} onPress={() => goModal('AutonomyModal')} />
                          </View>
                        </View>
                        <Text style={styles.priorityPct}>{p.progress}%</Text>
                      </TouchableOpacity>
                    </SwipeRow>
                  );
                })}
              </>
            ) : (
              <EmptyHint text="No active priorities set." />
            )}
          </Card>
          )}

          {/* ── Kanban mini-board ── */}
          {show('focus-kanban') && (
          <Card style={styles.section}>
            <SectionHeader icon="grid" title="Board" subtitle="Snapshot" accent={COLORS.purple} onPress={() => goModal('Board')} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
              {[
                { key: 'todo', label: 'To Do', color: COLORS.info },
                { key: 'in_progress', label: 'In Progress', color: COLORS.primary },
                { key: 'blocked', label: 'Blocked', color: COLORS.error },
                { key: 'done', label: 'Done', color: COLORS.success },
              ].map((lane) => {
                const items = d.tasksByStatus[lane.key] || [];
                return (
                  <View key={lane.key} style={styles.lane}>
                    <View style={styles.laneHead}>
                      <Text style={[styles.laneTitle, { color: lane.color }]}>{lane.label}</Text>
                      <Text style={styles.laneCount}>{items.length}</Text>
                    </View>
                    {items.slice(0, 4).map((t, i) => (
                      <View key={t.id ?? i} style={styles.laneCard}>
                        <Text style={styles.laneCardTxt} numberOfLines={2}>
                          {String(t.title ?? 'Task')}
                        </Text>
                      </View>
                    ))}
                    {!items.length ? <Text style={styles.laneEmpty}>—</Text> : null}
                  </View>
                );
              })}
            </ScrollView>
          </Card>
          )}

          {/* ── Projects in progress ── */}
          {show('suggested-projects') && d.projectsInProgress.length ? (
            <Card style={styles.section}>
              <SectionHeader icon="folder-open" title="Projects In Progress" subtitle={`${d.projectsInProgress.length} active`} accent={COLORS.purple} onPress={() => goModal('Board')} />
              {d.projectsInProgress.map((p, i) => (
                <View key={p.id ?? i} style={styles.projRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.projName} numberOfLines={1}>{p.name}</Text>
                    <Text style={styles.projMeta} numberOfLines={1}>
                      {p.inProgress} active · {p.done}/{p.total} done{p.blocked > 0 ? ` · ${p.blocked} blocked` : ''}
                    </Text>
                    <View style={styles.progTrack}>
                      <View style={[styles.progFill, { width: `${p.progress}%`, backgroundColor: p.blocked > 0 ? COLORS.warning : COLORS.purple }]} />
                    </View>
                  </View>
                  <Text style={styles.projPct}>{p.progress}%</Text>
                </View>
              ))}
            </Card>
          ) : null}

          {/* ── Clients in progress ── */}
          {show('command-zone') && d.clientsInProgress.length ? (
            <Card style={styles.section}>
              <SectionHeader icon="person-circle" title="Clients In Progress" subtitle={`${d.clientsInProgress.length} engagements`} accent={COLORS.info} onPress={() => go('Clients')} />
              {d.clientsInProgress.map((c, i) => (
                <View key={c.id ?? i} style={styles.queueRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.queueTitle} numberOfLines={1}>{c.name}</Text>
                    <Text style={styles.queueMeta} numberOfLines={1}>
                      {c.status}{c.project ? ` · ${c.project}` : ''}{c.daysInProgress ? ` · ${c.daysInProgress}d` : ''}
                    </Text>
                  </View>
                  {c.progress > 0 ? (
                    <View style={styles.rosterRight}>
                      <View style={styles.successTrack}>
                        <View style={[styles.successFill, { width: `${c.progress}%`, backgroundColor: COLORS.info }]} />
                      </View>
                      <Text style={styles.rosterPct}>{c.progress}%</Text>
                    </View>
                  ) : null}
                </View>
              ))}
            </Card>
          ) : null}

          {/* ── Workflows + Cron + Notes (stacked) ── */}
          {show('workflows-cron-notes') && (
          <Card style={styles.section}>
            <SectionHeader icon="git-branch" title="Workflows" accent={COLORS.cyan} onPress={() => goModal('WorkflowsModal')} />
            {data.workflows.length ? (
              data.workflows.slice(0, 5).map((w, i) => {
                const st = normStatus(w.status);
                const c = st === 'running' ? COLORS.success : st === 'error' ? COLORS.error : st === 'paused' ? COLORS.warning : COLORS.textMuted;
                return (
                  <View key={w.id ?? i} style={styles.listRow}>
                    <View style={[styles.onlineDot, { backgroundColor: c }]} />
                    <Text style={styles.listName} numberOfLines={1}>
                      {String(w.name ?? 'Workflow')}
                    </Text>
                    <Text style={styles.listMeta}>{String(w.kind ?? w.status ?? '')}</Text>
                  </View>
                );
              })
            ) : (
              <EmptyHint text="No workflows." />
            )}
          </Card>
          )}

          {show('workflows-cron-notes') && (
          <Card style={styles.section}>
            <SectionHeader icon="alarm" title="Scheduled" accent={COLORS.warning} onPress={() => goModal('CronModal')} />
            {data.cron.length ? (
              data.cron.slice(0, 5).map((j, i) => (
                <View key={j.id ?? i} style={styles.listRow}>
                  <View style={[styles.onlineDot, { backgroundColor: j.enabled === false ? COLORS.textMuted : COLORS.success }]} />
                  <Text style={styles.listName} numberOfLines={1}>
                    {String(j.label ?? j.name ?? j.cron ?? 'Job')}
                  </Text>
                  <Text style={styles.listMeta} numberOfLines={1}>
                    {String(j.cron ?? j.schedule ?? '')}
                  </Text>
                </View>
              ))
            ) : (
              <EmptyHint text="No scheduled jobs." />
            )}
          </Card>
          )}

          {show('workflows-cron-notes') && (
          <Card style={styles.section}>
            <SectionHeader icon="document-text" title="Knowledge" accent={COLORS.primary} onPress={() => go('Notes')} />
            {data.notes.length ? (
              data.notes.slice(0, 5).map((n, i) => (
                <View key={n.id ?? i} style={styles.listRow}>
                  <Ionicons name="document-outline" size={14} color={COLORS.textMuted} style={{ marginRight: 8 }} />
                  <Text style={styles.listName} numberOfLines={1}>
                    {String(n.title ?? n.name ?? 'Untitled note')}
                  </Text>
                  <Text style={styles.listMeta}>{timeAgo(n.updatedAt ?? n.updated_at)}</Text>
                </View>
              ))
            ) : (
              <EmptyHint text="No notes captured." />
            )}
          </Card>
          )}

          {/* ── Content surfaces ── */}
          {show('content-card') && d.surfaces.length ? (
            <Card style={styles.section}>
              <SectionHeader icon="albums" title="Content Pages" subtitle={`${data.content.length} total`} accent={COLORS.pink} />
              <View style={styles.surfaceGrid}>
                {d.surfaces.slice(0, 6).map(([surface, v], i) => (
                  <View key={surface} style={styles.surfaceTile}>
                    <Text style={[styles.surfaceCount, { color: segColors[i % segColors.length] }]}>{v.count}</Text>
                    <Text style={styles.surfaceName} numberOfLines={1}>
                      {surface}
                    </Text>
                    <Text style={styles.surfaceSub}>{v.published} live</Text>
                  </View>
                ))}
              </View>
            </Card>
          ) : null}

          {/* ── Connected fleet ── */}
          {show('federation') && (
          <Card style={styles.section}>
            <SectionHeader
              icon="git-network"
              title="Connected Fleet"
              subtitle={`${d.nodesOnline}/${d.nodes.length} online`}
              accent={COLORS.info}
              onPress={() => goModal('FederationDirectoryModal')}
            />
            {d.nodes.length ? (
              <View style={styles.fleetGrid}>
                {d.nodes.slice(0, 8).map((n, i) => (
                  <View key={n.id || i} style={styles.fleetTile}>
                    <View style={[styles.onlineDot, { backgroundColor: n.online ? COLORS.success : COLORS.textMuted }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fleetName} numberOfLines={1}>
                        {n.name}
                      </Text>
                      <Text style={styles.fleetKind} numberOfLines={1}>
                        {n.local ? 'this device' : n.kind}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <EmptyHint text="No federation nodes connected." />
            )}
          </Card>
          )}

          {/* ── Continue learning ── */}
          {show('learning-band') && (data.tracks.length || data.courses.length) ? (
            <Card style={styles.section}>
              <SectionHeader icon="school" title="Continue Learning" accent={COLORS.purple} />
              {data.tracks.slice(0, 1).map((t, i) => {
                const prog = t.progress || {};
                const total = Number(prog.totalSteps ?? (Array.isArray(t.steps) ? t.steps.length : 0)) || 1;
                const done = Number(prog.completedSteps ?? 0);
                return (
                  <View key={t.id ?? i} style={{ marginBottom: 10 }}>
                    <Text style={styles.trackTitle} numberOfLines={1}>
                      {String(t.title ?? 'Track')}
                    </Text>
                    <View style={styles.progTrack}>
                      <View style={[styles.progFill, { width: `${Math.round((done / total) * 100)}%`, backgroundColor: COLORS.purple }]} />
                    </View>
                    <Text style={styles.trackMeta}>
                      {done}/{total} steps
                    </Text>
                  </View>
                );
              })}
              {data.courses.slice(0, 3).map((c, i) => (
                <View key={c.id ?? i} style={styles.listRow}>
                  <Ionicons name="book-outline" size={14} color={COLORS.purple} style={{ marginRight: 8 }} />
                  <Text style={styles.listName} numberOfLines={1}>
                    {String(c.title ?? c.name ?? 'Course')}
                  </Text>
                  <Text style={styles.listMeta}>{String(c.tier ?? '')}</Text>
                </View>
              ))}
            </Card>
          ) : null}

          {/* ── Quick nav to business tools ── */}
          <Card style={styles.section}>
            <SectionHeader icon="apps" title="Business Tools" accent={COLORS.primary} />
            <View style={styles.navGrid}>
              {[
                { label: 'CRM', icon: 'people', route: 'Clients' },
                { label: 'Leads', icon: 'magnet', route: 'Leads' },
                { label: 'Income', icon: 'trending-up', route: 'IncomeStreams' },
                // Spend lives in Credits & Usage (the old Budget page read an unused budget store and showed zeros).
                { label: 'Spend', icon: 'wallet', route: 'CreditsModal', modal: true },
                { label: 'Schedule', icon: 'calendar', route: 'Schedule' },
                { label: 'Databases', icon: 'server', route: 'Databases' },
                { label: 'Profile', icon: 'business', route: 'BusinessProfile' },
                { label: 'Command', icon: 'speedometer', route: 'BusinessCommandCenter' },
              ].map((t) => (
                <TouchableOpacity key={t.route} style={styles.navTile} onPress={() => (t.modal ? goModal(t.route) : go(t.route))} activeOpacity={0.75}>
                  <View style={[styles.navIcon, { backgroundColor: withAlpha(COLORS.primary, 0.12) }]}>
                    <Ionicons name={t.icon} size={18} color={COLORS.primary} />
                  </View>
                  <Text style={styles.navLabel} numberOfLines={1}>
                    {t.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </Card>
        </>
      )}
      </>
      )}
    </ScrollView>
    </GestureHandlerRootView>
  );
}

// ============================================================
// Styles
// ============================================================
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },

  // Greeting
  greeting: { borderRadius: 22, overflow: 'hidden', marginBottom: 14 },
  greetingInner: { padding: 18 },
  greetingEyebrow: { fontFamily: FONT_FAMILY.semiBold, fontSize: 10, letterSpacing: 1.5, color: withAlpha(COLORS.primary, 0.9) },
  greetingTitle: { fontFamily: FONT_FAMILY.bold, fontSize: 22, color: COLORS.text, marginTop: 6 },
  greetingMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 10, flexWrap: 'wrap' },
  greetingMetaItem: { flexDirection: 'row', alignItems: 'center' },
  greetingMetaText: { fontFamily: FONT_FAMILY.medium, fontSize: 12, color: COLORS.textSecondary },
  greetingMetaDot: { color: COLORS.textMuted, marginHorizontal: 7 },
  pulseDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },

  // Card
  card: {
    backgroundColor: 'rgba(14,14,20,0.78)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.primary, 0.08),
    padding: 16,
  },
  section: { marginBottom: 12 },

  // Preset switcher (segmented pill)
  presetBar: { flexDirection: 'row', gap: 6, marginTop: 2, marginBottom: 12 },
  presetPill: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 99,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: withAlpha(COLORS.text, 0.1),
    backgroundColor: withAlpha(COLORS.text, 0.03),
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetPillActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  presetPillTxt: { fontFamily: FONT_FAMILY.semiBold, fontSize: 11.5, color: COLORS.textSecondary },
  presetPillTxtActive: { color: COLORS.background },

  // Desktop hint row (world-map summary, operator/full only)
  desktopHintRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(COLORS.text, 0.06) },
  desktopHintTxt: { flex: 1, fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted },

  // In-place action buttons
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  actionBtnTxt: { fontFamily: FONT_FAMILY.semiBold, fontSize: 11 },
  inlineError: { flexDirection: 'row', alignItems: 'center', backgroundColor: withAlpha(COLORS.error, 0.1), borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, marginBottom: 8 },
  inlineErrorTxt: { flex: 1, fontFamily: FONT_FAMILY.regular, fontSize: 11.5, color: COLORS.error },

  // Swipe actions
  swipeAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 16, minWidth: 96, borderRadius: 12, borderWidth: 1, marginVertical: 4, marginLeft: 6 },
  swipeActionRight: { marginLeft: 0, marginRight: 6 },
  swipeActionTxt: { fontFamily: FONT_FAMILY.bold, fontSize: 11, letterSpacing: 0.4 },

  // Section header
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionHeadLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  sectionIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  sectionTitle: { fontFamily: FONT_FAMILY.bold, fontSize: 15, color: COLORS.text },
  sectionSub: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
  sectionAction: { fontFamily: FONT_FAMILY.semiBold, fontSize: 12 },

  empty: { fontFamily: FONT_FAMILY.regular, fontSize: 13, color: COLORS.textMuted, textAlign: 'center', paddingVertical: 6 },

  // Daily briefing
  briefCard: { borderColor: withAlpha(COLORS.primary, 0.22), backgroundColor: withAlpha(COLORS.primary, 0.05) },
  briefHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  briefBadge: { flexDirection: 'row', alignItems: 'center' },
  briefEyebrow: { fontFamily: FONT_FAMILY.bold, fontSize: 10, letterSpacing: 1.4, color: COLORS.primary, marginLeft: 6 },
  briefTime: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted },
  briefHeadline: { fontFamily: FONT_FAMILY.bold, fontSize: 16, lineHeight: 22, color: COLORS.text, marginBottom: 10 },
  briefLine: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 5 },
  briefLineTxt: { flex: 1, fontFamily: FONT_FAMILY.regular, fontSize: 12.5, lineHeight: 18, color: COLORS.textSecondary },

  // Autonomy mini
  autoStatusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  autoDot: { width: 9, height: 9, borderRadius: 5, marginRight: 8 },
  autoStatusTxt: { flex: 1, fontFamily: FONT_FAMILY.semiBold, fontSize: 13, color: COLORS.text },
  autoDecRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(COLORS.text, 0.06) },
  autoDecTxt: { flex: 1, fontFamily: FONT_FAMILY.regular, fontSize: 12, color: COLORS.textSecondary, marginRight: 8 },

  // CEO strategic insights
  ceoRow: { flexDirection: 'row', alignItems: 'stretch', paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(COLORS.text, 0.06) },
  ceoBar: { width: 3, borderRadius: 2, marginRight: 10 },
  ceoTitle: { fontFamily: FONT_FAMILY.semiBold, fontSize: 13, color: COLORS.text },
  ceoRationale: { fontFamily: FONT_FAMILY.regular, fontSize: 11.5, lineHeight: 16, color: COLORS.textMuted, marginTop: 2 },

  // Business fleet
  bizCard: { width: 150, backgroundColor: withAlpha(COLORS.text, 0.04), borderRadius: 14, padding: 12 },
  bizHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  bizName: { flex: 1, fontFamily: FONT_FAMILY.semiBold, fontSize: 13, color: COLORS.text },
  bizStats: { flexDirection: 'row', justifyContent: 'space-between' },
  bizStat: { alignItems: 'center', flex: 1 },
  bizStatVal: { fontFamily: FONT_FAMILY.bold, fontSize: 16, color: COLORS.text },
  bizStatLab: { fontFamily: FONT_FAMILY.regular, fontSize: 9.5, color: COLORS.textMuted, marginTop: 1 },

  // Projects in progress
  projRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(COLORS.text, 0.06) },
  projName: { fontFamily: FONT_FAMILY.semiBold, fontSize: 13, color: COLORS.text },
  projMeta: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted, marginTop: 2, marginBottom: 5 },
  projPct: { fontFamily: FONT_FAMILY.bold, fontSize: 13, color: COLORS.text, marginLeft: 10, width: 38, textAlign: 'right' },

  // Two-column
  twoCol: { flexDirection: 'row', gap: 12 },
  col: { flex: 1 },

  // Stat pills
  fieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  statPill: { flexGrow: 1, minWidth: 64, backgroundColor: withAlpha(COLORS.text, 0.04), borderRadius: 12, paddingVertical: 10, paddingHorizontal: 8, alignItems: 'center' },
  statPillValue: { fontFamily: FONT_FAMILY.bold, fontSize: 17, color: COLORS.text },
  statPillLabel: { fontFamily: FONT_FAMILY.regular, fontSize: 10, color: COLORS.textMuted, marginTop: 2 },
  fieldNote: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted, marginTop: 10 },

  // KPI grid
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  kpiTile: {
    width: (CARD_W - 20) / 3,
    backgroundColor: 'rgba(14,14,20,0.78)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.primary, 0.08),
    padding: 11,
    minHeight: 92,
  },
  kpiTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kpiIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  kpiValue: { fontFamily: FONT_FAMILY.bold, fontSize: 22, color: COLORS.text, marginTop: 8 },
  kpiLabel: { fontFamily: FONT_FAMILY.regular, fontSize: 10.5, color: COLORS.textMuted, marginTop: 1 },

  // Activity legend
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 },
  legendItem: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted },

  // Live pulse
  pulseRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(COLORS.text, 0.06) },
  pulseTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pulseLabel: { fontFamily: FONT_FAMILY.semiBold, fontSize: 13, color: COLORS.text, flex: 1, marginRight: 8 },
  pulseTime: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted },
  pulseTask: { fontFamily: FONT_FAMILY.regular, fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  progTrack: { height: 4, borderRadius: 2, backgroundColor: withAlpha(COLORS.text, 0.08), marginTop: 6, overflow: 'hidden' },
  progFill: { height: 4, borderRadius: 2 },

  // Insights
  insightRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(COLORS.text, 0.06) },
  insightBar: { width: 3, alignSelf: 'stretch', borderRadius: 2, marginRight: 11 },
  insightTitle: { fontFamily: FONT_FAMILY.semiBold, fontSize: 13, color: COLORS.text },
  insightDesc: { fontFamily: FONT_FAMILY.regular, fontSize: 12, color: COLORS.textMuted, marginTop: 2 },

  // Roster
  rosterRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(COLORS.text, 0.06) },
  avatar: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  avatarTxt: { fontFamily: FONT_FAMILY.bold, fontSize: 12 },
  rosterName: { fontFamily: FONT_FAMILY.semiBold, fontSize: 13, color: COLORS.text },
  rosterMeta: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
  rosterRight: { width: 64, marginHorizontal: 8 },
  successTrack: { height: 4, borderRadius: 2, backgroundColor: withAlpha(COLORS.text, 0.08), overflow: 'hidden' },
  successFill: { height: 4, borderRadius: 2 },
  rosterPct: { fontFamily: FONT_FAMILY.medium, fontSize: 10, color: COLORS.textMuted, marginTop: 3, textAlign: 'right' },
  onlineDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 4 },

  // Donut legend
  donutLegend: { marginTop: 10, alignSelf: 'stretch', gap: 4 },
  legendChip: { flexDirection: 'row', alignItems: 'center' },
  legendSwatch: { width: 9, height: 9, borderRadius: 3, marginRight: 7 },
  legendChipTxt: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textSecondary, flex: 1 },

  // Revenue
  revRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  revCell: { alignItems: 'center', flex: 1 },
  revVal: { fontFamily: FONT_FAMILY.bold, fontSize: 15, color: COLORS.text },
  revLab: { fontFamily: FONT_FAMILY.regular, fontSize: 10, color: COLORS.textMuted, marginTop: 2 },
  streamRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  streamName: { fontFamily: FONT_FAMILY.regular, fontSize: 12, color: COLORS.textSecondary, flex: 1, marginRight: 8 },
  streamAmt: { fontFamily: FONT_FAMILY.semiBold, fontSize: 12, color: COLORS.success },

  // Discipline
  discNow: { fontFamily: FONT_FAMILY.medium, fontSize: 12, color: COLORS.warning, marginBottom: 6, textAlign: 'center' },

  // Priority queue / shipped
  queueRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(COLORS.text, 0.06) },
  queueTitle: { fontFamily: FONT_FAMILY.semiBold, fontSize: 13, color: COLORS.text },
  queueMeta: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, marginLeft: 8 },
  badgeTxt: { fontFamily: FONT_FAMILY.bold, fontSize: 9, letterSpacing: 0.5 },

  // Focus
  focusTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  focusEyebrow: { fontFamily: FONT_FAMILY.semiBold, fontSize: 10, letterSpacing: 1, color: COLORS.primary },
  focusTitle: { fontFamily: FONT_FAMILY.bold, fontSize: 15, color: COLORS.text, marginTop: 3 },
  priorityRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(COLORS.text, 0.06) },
  priorityRank: { fontFamily: FONT_FAMILY.bold, fontSize: 14, color: COLORS.textMuted, width: 22 },
  priorityTitle: { fontFamily: FONT_FAMILY.semiBold, fontSize: 13, color: COLORS.text },
  priorityNext: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
  priorityPct: { fontFamily: FONT_FAMILY.medium, fontSize: 12, color: COLORS.primary, width: 40, textAlign: 'right' },

  // Kanban lanes
  lane: { width: 150, backgroundColor: withAlpha(COLORS.text, 0.03), borderRadius: 12, padding: 10 },
  laneHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  laneTitle: { fontFamily: FONT_FAMILY.bold, fontSize: 12 },
  laneCount: { fontFamily: FONT_FAMILY.bold, fontSize: 12, color: COLORS.textMuted },
  laneCard: { backgroundColor: 'rgba(20,20,28,0.7)', borderRadius: 8, padding: 8, marginBottom: 6 },
  laneCardTxt: { fontFamily: FONT_FAMILY.regular, fontSize: 11.5, color: COLORS.textSecondary },
  laneEmpty: { fontFamily: FONT_FAMILY.regular, fontSize: 12, color: COLORS.textMuted, textAlign: 'center', paddingVertical: 8 },

  // Generic list rows
  listRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(COLORS.text, 0.06) },
  listName: { fontFamily: FONT_FAMILY.medium, fontSize: 13, color: COLORS.text, flex: 1, marginLeft: 6, marginRight: 8 },
  listMeta: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted },

  // Content surfaces
  surfaceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  surfaceTile: { width: (CARD_W - 52) / 3, backgroundColor: withAlpha(COLORS.text, 0.04), borderRadius: 12, padding: 11, alignItems: 'center' },
  surfaceCount: { fontFamily: FONT_FAMILY.bold, fontSize: 20 },
  surfaceName: { fontFamily: FONT_FAMILY.medium, fontSize: 11, color: COLORS.text, marginTop: 2, textTransform: 'capitalize' },
  surfaceSub: { fontFamily: FONT_FAMILY.regular, fontSize: 10, color: COLORS.textMuted, marginTop: 1 },

  // Fleet
  fleetGrid: { gap: 8 },
  fleetTile: { flexDirection: 'row', alignItems: 'center', backgroundColor: withAlpha(COLORS.text, 0.03), borderRadius: 10, padding: 10, gap: 10 },
  fleetName: { fontFamily: FONT_FAMILY.semiBold, fontSize: 12.5, color: COLORS.text },
  fleetKind: { fontFamily: FONT_FAMILY.regular, fontSize: 10.5, color: COLORS.textMuted, marginTop: 1 },

  // Learning
  trackTitle: { fontFamily: FONT_FAMILY.semiBold, fontSize: 13, color: COLORS.text, marginBottom: 6 },
  trackMeta: { fontFamily: FONT_FAMILY.regular, fontSize: 11, color: COLORS.textMuted, marginTop: 4 },

  // Quick nav
  navGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  navTile: { width: (CARD_W - 62) / 4, alignItems: 'center', paddingVertical: 6 },
  navIcon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  navLabel: { fontFamily: FONT_FAMILY.medium, fontSize: 10.5, color: COLORS.textSecondary, textAlign: 'center' },
});

export default DashboardScreen;
