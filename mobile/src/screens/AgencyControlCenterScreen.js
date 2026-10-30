/**
 * AgencyControlCenterScreen — the mobile "Business" tab landing.
 *
 * A FULLY NATIVE Agency Operations Control Center. It renders live gateway data
 * with native React Native components — NO WebViews, NO nav-list — at parity
 * with the web control UI's agency-operations surface, driven by the SAME
 * agency.ops.* RPCs the web agency-operations controller uses:
 *
 *   - Agents / subagents  <- subagents.list           (+ live `agent` / `subagents.update`)
 *   - Projects            <- agency.ops.projects.list  (kanban.projects.list HANGS ~20-30s — never used)
 *   - Clients             <- agency.ops.clients.list   (the real ~1292-client CRM w/ mrr + outstanding)
 *   - Finance / revenue   <- agency.ops.dashboard + agency.ops.finance.summary
 *   - Sessions / activity <- sessions.list (capped)     (+ live `chat`)
 *   - Channels            <- channels.status
 *
 * agencyId is resolved once from agency.ops.agencies.list (owner-first), mirroring
 * the web controller. Every RPC is wrapped in a short timeout and loaded together
 * with allSettled so no single slow/hanging call can wedge the whole screen.
 *
 * The KPI hero band shows the five headline agency metrics: Total Revenue,
 * Unpaid Revenue, Clients, Projects and Agents Working.
 *
 * Design language: InfiniBot black/gold glassmorphism (theme tokens only).
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';
import { withAlpha } from '../theme/color-utils';
import { SubAgentActivity } from '../components/SubAgentActivity';

const DOCK_BOTTOM_SPACE = 96;
const RPC_TIMEOUT_MS = 12_000;

// ── helpers ────────────────────────────────────────────────────────────────
const asArr = (v, keys = []) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of keys) if (Array.isArray(v[k])) return v[k];
  }
  return [];
};

const RUNNING_RE = /run|active|process|progress|pending|working/i;
const isRunning = (s) => RUNNING_RE.test(String(s ?? ''));

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const fmtMoney = (n) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(num(n));

// agency.ops.dashboard.summary values are in CENTS; finance.summary is in DOLLARS.
const centsToMoney = (c) => fmtMoney(num(c) / 100);
// Read a monthly-recurring figure off a project/client row (cents-preferred).
const mrrOf = (row) =>
  row?.mrrCents != null ? num(row.mrrCents) / 100 : row?.mrr != null ? num(row.mrr) : 0;

const relTime = (ts) => {
  if (!ts) return '';
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(n)) return '';
  const diff = Date.now() - n;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// Normalise a free-form project/client status into a coarse bucket.
const statusBucket = (raw) => {
  const s = String(raw ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (/(done|complete|shipped|closed|inactive|churned|archived)/.test(s)) return 'done';
  if (/(progress|review|active|doing|building|delivery|live)/.test(s)) return 'active';
  if (/(block|hold|wait|paused|overdue|risk)/.test(s)) return 'blocked';
  return 'todo';
};

// Wrap a promise so a slow/hanging RPC can never wedge the screen.
const withTimeout = (p, ms = RPC_TIMEOUT_MS) =>
  Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);

const TABS = [
  { key: 'overview', label: 'Overview', icon: 'grid' },
  { key: 'agents', label: 'Agents', icon: 'flash' },
  { key: 'projects', label: 'Projects', icon: 'albums' },
  { key: 'clients', label: 'Clients', icon: 'people' },
  { key: 'finance', label: 'Finance', icon: 'cash' },
  { key: 'sessions', label: 'Sessions', icon: 'pulse' },
  { key: 'channels', label: 'Channels', icon: 'chatbubbles' },
];

export function AgencyControlCenterScreen({ gateway, navigation }) {
  const insets = useSafeAreaInsets();
  const sendReq = gateway?.sendReq;
  const subscribeEvent = gateway?.subscribeEvent;
  const connected = gateway?.status === 'connected';

  const [tab, setTab] = useState('overview');
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const [agents, setAgents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [clients, setClients] = useState([]);
  const [dash, setDash] = useState(null); // agency.ops.dashboard.summary (cents)
  const [finance, setFinance] = useState(null); // agency.ops.finance.summary (dollars)
  const [sessions, setSessions] = useState([]);
  const [channels, setChannels] = useState([]);
  const [channelLabels, setChannelLabels] = useState({});
  const [agencyName, setAgencyName] = useState('');

  const loadingRef = useRef(false);
  const agencyIdRef = useRef(null);

  // Resolve (and cache) the active agency the way the web controller does:
  // first agency where the caller is owner, else the first agency at all.
  const resolveAgencyId = useCallback(async () => {
    if (agencyIdRef.current) return agencyIdRef.current;
    const r = await withTimeout(sendReq('agency.ops.agencies.list', {})).catch(() => null);
    const list = asArr(r, ['agencies']);
    const picked = list.find((a) => a?.role === 'owner') || list[0] || null;
    agencyIdRef.current = picked?.id || null;
    if (picked?.name) setAgencyName(picked.name);
    return agencyIdRef.current;
  }, [sendReq]);

  const load = useCallback(async () => {
    if (!sendReq || !connected || loadingRef.current) return;
    loadingRef.current = true;
    const call = (m, p = {}) => withTimeout(sendReq(m, p)).catch(() => null);
    try {
      const agencyId = await resolveAgencyId();

      // All calls fire together. Every one is timeout-guarded + null-on-error, so
      // Promise.all can never reject and can never hang past RPC_TIMEOUT_MS. The
      // only historically-slow call (kanban.projects.list) is deliberately gone.
      const [agentsR, sessionsR, channelsR, dashR, finR, clientsR, projectsR] =
        await Promise.all([
          call('subagents.list', { includeCompleted: true, limit: 60 }),
          call('sessions.list', {
            includeGlobal: false,
            includeUnknown: false,
            includeDerivedTitles: true,
            includeLastMessage: true,
            limit: 25,
          }),
          call('channels.status', {}),
          agencyId ? call('agency.ops.dashboard', { agencyId }) : Promise.resolve(null),
          agencyId ? call('agency.ops.finance.summary', { agencyId }) : Promise.resolve(null),
          agencyId ? call('agency.ops.clients.list', { agencyId }) : Promise.resolve(null),
          agencyId ? call('agency.ops.projects.list', { agencyId }) : Promise.resolve(null),
        ]);

      setAgents(asArr(agentsR, ['subagents']));
      setSessions(asArr(sessionsR, ['sessions']));
      if (dashR?.dashboard?.summary) setDash(dashR.dashboard.summary);
      if (finR?.finance) setFinance(finR.finance);
      if (clientsR) setClients(asArr(clientsR, ['clients']));
      if (projectsR) setProjects(asArr(projectsR, ['projects']));

      // channels.status → normalise the summary map into a flat list.
      setChannelLabels(channelsR?.channelLabels ?? {});
      const chRaw = channelsR?.channels ?? channelsR;
      if (Array.isArray(chRaw)) {
        setChannels(chRaw);
      } else if (chRaw && typeof chRaw === 'object') {
        setChannels(
          Object.entries(chRaw).map(([id, v]) => ({
            id,
            ...(v && typeof v === 'object' ? v : { value: v }),
          })),
        );
      } else {
        setChannels([]);
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [sendReq, connected, resolveAgencyId]);

  // This tab stays mounted while other tabs are open. Only refresh while it
  // is the one on screen — a busy gateway emits `agent` events constantly, and
  // each reload is ~8 RPCs.
  const [focused, setFocused] = useState(() => navigation?.isFocused?.() ?? true);
  useEffect(() => {
    if (!navigation?.addListener) return undefined;
    const a = navigation.addListener('focus', () => { setFocused(true); });
    const b = navigation.addListener('blur', () => setFocused(false));
    return () => { a(); b(); };
  }, [navigation]);
  const lastLoadRef = useRef(0);

  // First load, and catch up when the tab comes back into view.
  useEffect(() => {
    if (connected && focused && Date.now() - lastLoadRef.current > 5000) {
      lastLoadRef.current = Date.now();
      load();
    }
  }, [connected, focused, load]);

  // Steady poll so KPIs stay warm even without a WS event.
  useEffect(() => {
    if (!connected || !focused) return undefined;
    const t = setInterval(() => { lastLoadRef.current = Date.now(); load(); }, 20_000);
    return () => clearInterval(t);
  }, [connected, focused, load]);

  // Live event subscriptions — debounced reload on any relevant broadcast so
  // the control center updates in real time (same events the web UI emits).
  useEffect(() => {
    if (!subscribeEvent || !focused) return undefined;
    let timer = null;
    const bump = (payload) => {
      // `chat` streams a delta per token — only settle states are worth a reload.
      if (payload?.state === 'delta') return;
      if (timer) return;
      // At most one event-driven reload every 5s.
      const wait = Math.max(400, 5000 - (Date.now() - lastLoadRef.current));
      timer = setTimeout(() => {
        timer = null;
        lastLoadRef.current = Date.now();
        load();
      }, wait);
    };
    const events = [
      'agent',
      'subagents.update',
      'subagent',
      'subagent_completed',
      'subagent_failed',
      'chat', // session transcript changes (the gateway has no `sessions.update` event)
      'session.message',
      'clients:updated',
      'agency.ops.updated',
      'kanban:task:completed',
      'queue.changed',
      'queue.done',
    ];
    const unsubs = events.map((e) => {
      try {
        return subscribeEvent(e, bump);
      } catch {
        return null;
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubs.forEach((u) => {
        try { u?.(); } catch {}
      });
    };
  }, [subscribeEvent, load, focused]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // ── derived KPIs ──────────────────────────────────────────────────────────
  const runningAgents = useMemo(
    () => agents.filter((a) => isRunning(a?.status)).length,
    [agents],
  );
  const projectBuckets = useMemo(() => {
    const b = { active: [], todo: [], done: [], blocked: [] };
    for (const p of projects) b[statusBucket(p?.status)].push(p);
    return b;
  }, [projects]);
  const activeProjects = projectBuckets.active.length + projectBuckets.todo.length;
  // Every project exactly once, active-first — safe to slice for previews.
  const orderedProjects = useMemo(
    () => [
      ...projectBuckets.active,
      ...projectBuckets.todo,
      ...projectBuckets.blocked,
      ...projectBuckets.done,
    ],
    [projectBuckets],
  );
  const activeClients = useMemo(
    () => clients.filter((c) => statusBucket(c?.status) === 'active').length,
    [clients],
  );
  // Client name lookup so projects can show their client.
  const clientNameById = useMemo(() => {
    const m = new Map();
    for (const c of clients) if (c?.id) m.set(c.id, c.name || c.company || 'Client');
    return m;
  }, [clients]);

  // Headline agency metrics. Revenue/unpaid come from the dashboard summary
  // (cents). Clients/projects/agents are live counts.
  const totalRevenue = dash ? centsToMoney(dash.collectedCents) : finance ? fmtMoney(finance.cashCollectedMonth) : '—';
  const unpaidRevenue = dash
    ? centsToMoney(dash.outstandingInvoicesCents)
    : finance
      ? fmtMoney(finance.outstandingReceivables)
      : '—';
  const clientCount = clients.length || (dash ? num(dash.activeClients) : 0);

  const kpis = [
    { label: 'Revenue', value: totalRevenue, icon: 'cash', color: COLORS.success },
    { label: 'Unpaid', value: unpaidRevenue, icon: 'alert-circle', color: COLORS.warning },
    { label: 'Clients', value: clientCount ? String(clientCount) : '—', icon: 'people', color: COLORS.primary },
    { label: 'Projects', value: projects.length ? String(projects.length) : '—', icon: 'albums', color: COLORS.info },
    { label: 'Working', value: String(runningAgents), icon: 'flash', color: COLORS.cyan },
  ];

  const go = (screen) => {
    try { navigation?.navigate(screen); } catch {}
  };

  // ── section renderers ─────────────────────────────────────────────────────
  const renderOverview = () => (
    <View style={{ gap: 12 }}>
      {/* Agents preview */}
      <Card
        title="AI Workforce"
        icon="flash"
        accent={COLORS.success}
        badge={`${runningAgents} working`}
        onPressAll={() => setTab('agents')}
      >
        {agents.length === 0 ? (
          <Empty text="No agents running" />
        ) : (
          agents.slice(0, 4).map((a, i) => (
            <Row
              key={`${a.runId || a.id || a.sessionKey || a.task || 'a'}-${i}`}
              title={a.task || a.title || a.name || a.label || a.runId || 'Agent'}
              subtitle={`${a.coderBackend || a.model || 'agent'} · ${relTime(a.lastUpdateAt || a.updatedAt || a.createdAt)}`}
              statusDot={isRunning(a.status) ? COLORS.success : withAlpha(COLORS.text, 0.25)}
              right={<StatusPill status={a.status} />}
            />
          ))
        )}
      </Card>

      {/* Projects preview */}
      <Card
        title="Projects & Delivery"
        icon="albums"
        accent={COLORS.info}
        badge={`${activeProjects} active`}
        onPressAll={() => setTab('projects')}
      >
        {projects.length === 0 ? (
          <Empty text="No projects" />
        ) : (
          orderedProjects.slice(0, 4).map((p, i) => (
            <Row
              key={`${p.id || p.name || 'p'}-${i}`}
              title={p.name || p.title || 'Untitled project'}
              subtitle={clientNameById.get(p.clientId) || p.status || 'project'}
              statusDot={bucketColor(statusBucket(p.status))}
              right={mrrOf(p) ? <Text style={styles.mrrTxt}>{fmtMoney(mrrOf(p))}/mo</Text> : null}
            />
          ))
        )}
      </Card>

      {/* Finance preview — real agency revenue + receivables */}
      <Card
        title="Financial Command"
        icon="cash"
        accent={COLORS.cyan}
        badge={totalRevenue}
        onPressAll={() => setTab('finance')}
      >
        <View style={styles.financeRow}>
          {[
            { l: 'Collected', v: totalRevenue },
            { l: 'Outstanding', v: unpaidRevenue },
            { l: 'Overdue', v: dash ? centsToMoney(dash.overdueInvoicesCents) : '—' },
          ].map((f) => (
            <View key={f.l} style={styles.financeCell}>
              <Text style={styles.financeVal}>{f.v}</Text>
              <Text style={styles.financeLbl}>{f.l}</Text>
            </View>
          ))}
        </View>
      </Card>

      {/* Sessions preview */}
      <Card
        title="Live Activity"
        icon="pulse"
        accent={COLORS.purple}
        badge={`${sessions.length}`}
        onPressAll={() => setTab('sessions')}
      >
        {sessions.length === 0 ? (
          <Empty text="No recent sessions" />
        ) : (
          sessions.slice(0, 4).map((s, i) => (
            <Row
              key={`${s.key || s.sessionKey || 'sess'}-${i}`}
              title={s.title || s.derivedTitle || s.key || 'Session'}
              subtitle={`${s.kind || 'session'} · ${relTime(s.updatedAt || s.lastActivity)}`}
              statusDot={isRunning(s.status) ? COLORS.success : withAlpha(COLORS.text, 0.25)}
            />
          ))
        )}
      </Card>
    </View>
  );

  const renderAgents = () => (
    <View style={{ gap: 12 }}>
      <Text style={styles.tabHint}>
        Live AI workforce — tap an agent to drill into its activity, tools & output.
      </Text>
      <SubAgentActivity gateway={gateway} style={styles.embed} />
    </View>
  );

  const renderProjects = () => {
    const order = [
      ['active', 'In Progress', COLORS.info],
      ['todo', 'To Do', withAlpha(COLORS.text, 0.5)],
      ['blocked', 'Blocked', COLORS.warning],
      ['done', 'Done', COLORS.success],
    ];
    return (
      <View style={{ gap: 12 }}>
        {order.map(([bucket, label, color]) => {
          const list = projectBuckets[bucket];
          if (!list.length) return null;
          return (
            <Card key={bucket} title={label} icon="ellipse" accent={color} badge={String(list.length)}>
              {list.slice(0, 12).map((p, i) => (
                <Row
                  key={`${p.id || p.name || 'p'}-${i}`}
                  title={p.name || p.title || 'Untitled project'}
                  subtitle={clientNameById.get(p.clientId) || p.status || 'project'}
                  statusDot={color}
                  right={mrrOf(p) ? <Text style={styles.mrrTxt}>{fmtMoney(mrrOf(p))}/mo</Text> : null}
                />
              ))}
            </Card>
          );
        })}
        {projects.length === 0 && <Empty text="No projects yet" pad />}
      </View>
    );
  };

  const renderClients = () => (
    <View style={{ gap: 12 }}>
      <Card
        title="Clients"
        icon="people"
        accent={COLORS.primary}
        badge={`${clientCount} total`}
      >
        {clients.length === 0 ? (
          <Empty text="No clients yet" />
        ) : (
          <>
            <View style={styles.clientSummaryRow}>
              <View style={styles.clientSummaryCell}>
                <Text style={styles.clientSummaryVal}>{activeClients}</Text>
                <Text style={styles.clientSummaryLbl}>Active</Text>
              </View>
              <View style={styles.clientSummaryCell}>
                <Text style={styles.clientSummaryVal}>{clientCount}</Text>
                <Text style={styles.clientSummaryLbl}>Total</Text>
              </View>
              <View style={styles.clientSummaryCell}>
                <Text style={styles.clientSummaryVal}>{unpaidRevenue}</Text>
                <Text style={styles.clientSummaryLbl}>Owed</Text>
              </View>
            </View>
            {clients.slice(0, 40).map((c, i) => {
              const owed = num(c.outstandingCents);
              return (
                <Row
                  key={`${c.id || c.name || 'c'}-${i}`}
                  title={c.name || c.company || 'Client'}
                  subtitle={
                    [c.pipelineStatusLabel || c.status, c.projectCount ? `${c.projectCount} projects` : null]
                      .filter(Boolean)
                      .join(' · ') || 'client'
                  }
                  statusDot={statusBucket(c.status) === 'active' ? COLORS.primary : withAlpha(COLORS.text, 0.25)}
                  right={
                    owed > 0 ? (
                      <Text style={[styles.mrrTxt, { color: COLORS.warning }]}>{centsToMoney(owed)} owed</Text>
                    ) : mrrOf(c) ? (
                      <Text style={styles.mrrTxt}>{fmtMoney(mrrOf(c))}/mo</Text>
                    ) : null
                  }
                />
              );
            })}
            {clients.length > 40 && (
              <View style={styles.moreRow}>
                <Text style={styles.moreTxt}>+{clients.length - 40} more clients</Text>
              </View>
            )}
          </>
        )}
      </Card>
    </View>
  );

  const renderFinance = () => {
    // dashboard.summary → cents; finance.summary → dollars.
    const grid = [
      { l: 'Total Revenue', v: totalRevenue },
      { l: 'Unpaid / Owed', v: unpaidRevenue },
      { l: 'Overdue', v: dash ? centsToMoney(dash.overdueInvoicesCents) : '—' },
      { l: 'Cash / Month', v: finance ? fmtMoney(finance.cashCollectedMonth) : '—' },
      { l: 'Revenue / Month', v: finance ? fmtMoney(finance.revenueMonth) : '—' },
      { l: 'MRR', v: finance ? fmtMoney(finance.mrr) : '—' },
      { l: 'ARR', v: finance ? fmtMoney(finance.arr) : '—' },
      { l: 'Backlog', v: finance ? fmtMoney(finance.contractedBacklog) : '—' },
    ];
    return (
      <View style={{ gap: 12 }}>
        <Card title="Revenue & Receivables" icon="trending-up" accent={COLORS.cyan}>
          <View style={styles.kpiGrid}>
            {grid.map((f) => (
              <View key={f.l} style={styles.kpiGridCell}>
                <Text style={styles.kpiGridVal}>{f.v}</Text>
                <Text style={styles.kpiGridLbl}>{f.l}</Text>
              </View>
            ))}
          </View>
        </Card>
        <TouchableOpacity style={styles.fullBtn} onPress={() => go('IncomeStreams')} activeOpacity={0.8}>
          <Ionicons name="git-network" size={15} color={COLORS.cyan} />
          <Text style={styles.fullBtnTxt}>Manage income streams</Text>
          <Ionicons name="chevron-forward" size={15} color={withAlpha(COLORS.text, 0.4)} />
        </TouchableOpacity>
        {!dash && !finance && <Empty text="No finance data yet" pad />}
      </View>
    );
  };

  const renderSessions = () => (
    <View style={{ gap: 12 }}>
      <Card title="Sessions & Activity" icon="pulse" accent={COLORS.purple} badge={`${sessions.length}`}>
        {sessions.length === 0 ? (
          <Empty text="No active sessions" />
        ) : (
          sessions.slice(0, 25).map((s, i) => (
            <Row
              key={`${s.key || s.sessionKey || 'sess'}-${i}`}
              title={s.title || s.derivedTitle || s.key || 'Session'}
              subtitle={`${s.kind || 'session'} · ${relTime(s.updatedAt || s.lastActivity)}`}
              statusDot={isRunning(s.status) ? COLORS.success : withAlpha(COLORS.text, 0.25)}
              right={s.lastMessage ? null : <StatusPill status={s.status} />}
            />
          ))
        )}
      </Card>
    </View>
  );

  const renderChannels = () => (
    <View style={{ gap: 12 }}>
      <Card title="Channels" icon="chatbubbles" accent={COLORS.pink} badge={`${channels.length}`}>
        {channels.length === 0 ? (
          <Empty text="No channels configured" />
        ) : (
          channels.map((c, i) => {
            const on = c.connected ?? c.active ?? c.enabled ?? c.configured ?? false;
            const label = channelLabels?.[c.id] || String(c.id || c.name || 'channel').replace(/^\w/, (m) => m.toUpperCase());
            return (
              <Row
                key={`${c.id || c.name || 'ch'}-${i}`}
                title={label}
                subtitle={c.accountId || c.handle || c.username || (on ? 'configured' : 'not configured')}
                statusDot={on ? COLORS.success : withAlpha(COLORS.text, 0.25)}
                right={
                  <Text style={[styles.chanState, { color: on ? COLORS.success : withAlpha(COLORS.text, 0.4) }]}>
                    {on ? 'ON' : 'OFF'}
                  </Text>
                }
              />
            );
          })
        )}
      </Card>
    </View>
  );

  const body = {
    overview: renderOverview,
    agents: renderAgents,
    projects: renderProjects,
    clients: renderClients,
    finance: renderFinance,
    sessions: renderSessions,
    channels: renderChannels,
  }[tab];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 8, paddingBottom: DOCK_BOTTOM_SPACE + 8 },
      ]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
      }
    >
      {/* Hero band */}
      <View style={styles.hero}>
        <BlurView intensity={Platform.OS === 'android' ? 45 : 60} tint="dark" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={[withAlpha(COLORS.primary, 0.22), withAlpha(COLORS.primary, 0.06), 'rgba(0,0,0,0.4)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={[StyleSheet.absoluteFill, styles.heroBorder]} pointerEvents="none" />
        <View style={styles.heroInner}>
          <View style={styles.heroTopRow}>
            <Text style={styles.heroEyebrow} numberOfLines={1}>
              {agencyName ? `${agencyName.toUpperCase()} · OPERATIONS` : 'INFINIBOT · AGENCY OPERATIONS'}
            </Text>
            <View style={styles.liveChip}>
              <View style={[styles.liveDot, { backgroundColor: connected ? COLORS.success : COLORS.warning }]} />
              <Text style={styles.liveTxt}>{connected ? 'LIVE' : '…'}</Text>
            </View>
          </View>
          <Text style={styles.heroTitle}>Control Center</Text>
          <Text style={styles.heroSub}>
            Your whole agency — AI workforce, delivery, clients, finance & comms — live.
          </Text>
          <View style={styles.statRow}>
            {kpis.map((s) => (
              <View key={s.label} style={styles.statPill}>
                <Ionicons name={s.icon} size={12} color={s.color} style={{ marginBottom: 3 }} />
                <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                  {s.value}
                </Text>
                <Text style={styles.statLabel}>{s.label}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>

      {/* Segmented tab strip */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabStrip}
        contentContainerStyle={styles.tabStripInner}
      >
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              onPress={() => setTab(t.key)}
              activeOpacity={0.8}
              style={[styles.tabChip, on && styles.tabChipOn]}
            >
              <Ionicons name={t.icon} size={14} color={on ? '#0B0B10' : withAlpha(COLORS.text, 0.6)} />
              <Text style={[styles.tabChipTxt, on && styles.tabChipTxtOn]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading && !refreshing ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={COLORS.primary} />
          <Text style={styles.loadingTxt}>Loading agency operations…</Text>
        </View>
      ) : (
        body?.()
      )}
    </ScrollView>
  );
}

// ── shared presentational bits ───────────────────────────────────────────────
function bucketColor(bucket) {
  return {
    active: COLORS.info,
    todo: withAlpha(COLORS.text, 0.5),
    blocked: COLORS.warning,
    done: COLORS.success,
  }[bucket] || withAlpha(COLORS.text, 0.5);
}

function Card({ title, icon, accent, badge, onPressAll, children }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={[styles.cardIcon, { backgroundColor: withAlpha(accent, 0.16) }]}>
          <Ionicons name={icon} size={15} color={accent} />
        </View>
        <Text style={styles.cardTitle}>{title}</Text>
        {badge != null && (
          <View style={[styles.cardBadge, { borderColor: withAlpha(accent, 0.3), backgroundColor: withAlpha(accent, 0.12) }]}>
            <Text style={[styles.cardBadgeTxt, { color: accent }]}>{badge}</Text>
          </View>
        )}
        {onPressAll && (
          <TouchableOpacity onPress={onPressAll} hitSlop={8} style={styles.viewAll}>
            <Text style={[styles.viewAllTxt, { color: accent }]}>View all</Text>
            <Ionicons name="chevron-forward" size={13} color={accent} />
          </TouchableOpacity>
        )}
      </View>
      <View style={styles.cardBody}>{children}</View>
    </View>
  );
}

function Row({ title, subtitle, statusDot, right }) {
  return (
    <View style={styles.row}>
      {statusDot != null && <View style={[styles.rowDot, { backgroundColor: statusDot }]} />}
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.rowSub} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right ? <View style={styles.rowRight}>{right}</View> : null}
    </View>
  );
}

function StatusPill({ status }) {
  const bucket = statusBucket(status);
  const color = bucketColor(bucket);
  const label = String(status ?? bucket).replace(/[_-]+/g, ' ');
  return (
    <View style={[styles.pill, { borderColor: withAlpha(color, 0.35), backgroundColor: withAlpha(color, 0.12) }]}>
      <Text style={[styles.pillTxt, { color }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function Empty({ text, pad }) {
  return (
    <View style={[styles.emptyRow, pad && { paddingVertical: 26 }]}>
      <Text style={styles.emptyTxt}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  content: { paddingHorizontal: 14, gap: 12 },

  // Hero
  hero: { borderRadius: 22, overflow: 'hidden', marginBottom: 2 },
  heroBorder: { borderRadius: 22, borderWidth: 1, borderColor: 'rgba(212,175,55,0.18)' },
  heroInner: { padding: 18 },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  heroEyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, color: COLORS.primary, flexShrink: 1, marginRight: 8 },
  liveChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.3)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  liveTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8, color: 'rgba(255,255,255,0.7)' },
  heroTitle: { fontSize: 26, fontWeight: '800', color: '#FFFFFF', letterSpacing: 0.2 },
  heroSub: { fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 6, lineHeight: 17 },
  statRow: { flexDirection: 'row', gap: 6, marginTop: 14 },
  statPill: {
    flex: 1, alignItems: 'center', paddingVertical: 9, paddingHorizontal: 3, borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.28)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },
  statValue: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },
  statLabel: {
    fontSize: 8, fontWeight: '600', color: 'rgba(255,255,255,0.4)',
    letterSpacing: 0.3, textTransform: 'uppercase', marginTop: 2,
  },

  // Tabs
  tabStrip: { marginHorizontal: -14 },
  tabStripInner: { paddingHorizontal: 14, gap: 8, paddingVertical: 2 },
  tabChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 20,
    backgroundColor: 'rgba(14,14,20,0.7)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  tabChipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  tabChipTxt: { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.6)' },
  tabChipTxtOn: { color: '#0B0B10' },
  tabHint: { fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 16, marginHorizontal: 2 },
  embed: { marginHorizontal: -2 },

  // Loading
  loadingWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  loadingTxt: { fontSize: 12, color: 'rgba(255,255,255,0.4)' },

  // Card
  card: {
    borderRadius: 16, overflow: 'hidden',
    backgroundColor: 'rgba(14,14,20,0.78)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 10, elevation: 5,
  },
  cardHead: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    paddingHorizontal: 14, paddingTop: 13, paddingBottom: 10,
  },
  cardIcon: {
    width: 28, height: 28, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  cardTitle: { fontSize: 13, fontWeight: '700', color: '#FFFFFF', flexShrink: 1 },
  cardBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  cardBadgeTxt: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  viewAll: { flexDirection: 'row', alignItems: 'center', gap: 1, marginLeft: 'auto' },
  viewAllTxt: { fontSize: 11, fontWeight: '700' },
  cardBody: { paddingBottom: 6 },

  // Row
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.05)',
  },
  rowDot: { width: 8, height: 8, borderRadius: 4 },
  rowInfo: { flex: 1 },
  rowTitle: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.9)' },
  rowSub: { fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 1 },
  rowRight: { marginLeft: 8 },

  mrrTxt: { fontSize: 12, fontWeight: '700', color: COLORS.cyan },
  chanState: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },

  // Finance overview cells
  financeRow: { flexDirection: 'row', paddingHorizontal: 14, paddingTop: 4, paddingBottom: 10, gap: 8 },
  financeCell: {
    flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.25)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  financeVal: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },
  financeLbl: { fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginTop: 3, letterSpacing: 0.4 },

  // Finance KPI grid
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 10, paddingBottom: 10, gap: 8 },
  kpiGridCell: {
    width: '47%', flexGrow: 1, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.25)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  kpiGridVal: { fontSize: 17, fontWeight: '800', color: '#FFFFFF' },
  kpiGridLbl: { fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginTop: 3, letterSpacing: 0.4 },

  // Client summary strip
  clientSummaryRow: { flexDirection: 'row', paddingHorizontal: 14, paddingTop: 2, paddingBottom: 10, gap: 8 },
  clientSummaryCell: {
    flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.25)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  clientSummaryVal: { fontSize: 15, fontWeight: '800', color: '#FFFFFF' },
  clientSummaryLbl: { fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginTop: 3, letterSpacing: 0.4 },
  moreRow: { paddingVertical: 12, alignItems: 'center' },
  moreTxt: { fontSize: 11, color: 'rgba(255,255,255,0.4)', fontStyle: 'italic' },

  // Full-screen drill button
  fullBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 13, borderRadius: 14,
    backgroundColor: 'rgba(14,14,20,0.78)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  fullBtnTxt: { flex: 1, fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.85)' },

  // Pills / empty
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, borderWidth: 1, maxWidth: 120 },
  pillTxt: { fontSize: 9, fontWeight: '700', letterSpacing: 0.2, textTransform: 'capitalize' },
  emptyRow: { paddingVertical: 16, paddingHorizontal: 14, alignItems: 'center' },
  emptyTxt: { fontSize: 12, color: 'rgba(255,255,255,0.35)' },
});

export default AgencyControlCenterScreen;
