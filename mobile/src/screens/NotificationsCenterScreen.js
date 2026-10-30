import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Animated,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, FONTS, SPACING } from '../constants/theme';
import { GlassCard } from '../components/GlassCard';
import { GlassSurface } from '../components/GlassSurface';
import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../theme/color-utils';
import {
  getSeverityTokens,
  severityKeyForNotification,
  preferredNotificationTitle,
  preferredNotificationBody,
} from '../constants/severity-tokens';

// ── Constants ─────────────────────────────────────────────────────────────────

// Re-exported for NotificationDetailScreen + NotificationsPreferencesScreen so
// every screen in the Alerts family shares the same severity table. Use
// `getSeverityTokens(useTheme().colors)` inside components for the live values.
export { getSeverityTokens, severityKeyForNotification } from '../constants/severity-tokens';

// Static fallback severity hex map. Pure visual fallback for places that
// can't carry a `colors` reference (e.g. inside StyleSheet.create or the
// module-level skeleton row). Matches the canonical theme defaults so the
// live-token version and the fallback always agree.
const SEVERITY_COLORS = (() => {
  const tokens = getSeverityTokens(null);
  return {
    info: tokens.info.color,
    success: tokens.success.color,
    warn: tokens.warn.color,
    error: tokens.error.color,
    critical: tokens.critical.color,
    subagent: tokens.subagent.color,
  };
})();

const CATEGORY_ICONS = {
  'agent.completed': 'flash',
  'agent.error': 'warning',
  'agent.input_required': 'hand-right',
  'terminal.exit': 'terminal',
  'cron.fired': 'time',
  'discipline.alert': 'medal',
  'kanban.task.assigned': 'list',
  'kanban.task.due': 'alarm',
  'kanban.task.completed': 'checkmark-circle',
  'business.lead.new': 'person-add',
  'business.income.logged': 'cash',
  'federation.node.online': 'radio',
  'federation.node.offline': 'radio-outline',
  'system.update.available': 'cloud-download',
  'voice.call.incoming': 'call',
  'voice.call.missed': 'call-outline',
  'chat.mentions': 'chatbubble',
  'autonomy.checkpoint': 'shield-checkmark',
  'autonomy.budget.warning': 'alert-circle',
  'autonomy.budget.hit': 'ban',
  'credits.threshold': 'card',
  'manual': 'flask',
};

const CATEGORY_GROUPS = {
  All: null,
  Agents: ['agent.completed', 'agent.error', 'agent.input_required', 'chat.mentions', 'autonomy.checkpoint', 'autonomy.budget.warning', 'autonomy.budget.hit'],
  Tasks: ['kanban.task.assigned', 'kanban.task.due', 'kanban.task.completed'],
  Terminals: ['terminal.exit'],
  Cron: ['cron.fired'],
  Business: ['business.lead.new', 'business.income.logged'],
  Discipline: ['discipline.alert'],
  System: ['system.update.available', 'credits.threshold'],
  Voice: ['voice.call.incoming', 'voice.call.missed'],
  Federation: ['federation.node.online', 'federation.node.offline'],
};

// Icons for each group chip
const GROUP_ICONS = {
  All: 'apps',
  Agents: 'flash',
  Tasks: 'list',
  Terminals: 'terminal',
  Cron: 'time',
  Business: 'briefcase',
  Discipline: 'medal',
  System: 'settings',
  Voice: 'call',
  Federation: 'radio',
};

const SEVERITY_ORDER = ['info', 'success', 'warn', 'error', 'critical'];
const ALL_SEVERITIES = SEVERITY_ORDER;

const DATE_RANGES = [
  { label: 'Today', value: 'today' },
  { label: 'Yesterday', value: 'yesterday' },
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
  { label: 'All', value: 'all' },
];

const CATEGORY_LABELS = {
  'agent.completed': 'Agent Completed',
  'agent.error': 'Agent Error',
  'agent.input_required': 'Needs Input',
  'terminal.exit': 'Terminal',
  'cron.fired': 'Scheduled',
  'discipline.alert': 'Discipline',
  'kanban.task.assigned': 'Task Assigned',
  'kanban.task.due': 'Task Due',
  'kanban.task.completed': 'Task Done',
  'business.lead.new': 'New Lead',
  'business.income.logged': 'Income',
  'federation.node.online': 'Node Online',
  'federation.node.offline': 'Node Offline',
  'system.update.available': 'System Update',
  'voice.call.incoming': 'Incoming Call',
  'voice.call.missed': 'Missed Call',
  'chat.mentions': 'Chat',
  'autonomy.checkpoint': 'Checkpoint',
  'autonomy.budget.warning': 'Budget Warn',
  'autonomy.budget.hit': 'Budget Limit',
  'credits.threshold': 'Credits Low',
  'manual': 'Manual',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today - 86400000);
  const itemDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (itemDay.getTime() === today.getTime()) return 'Today';
  if (itemDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function dateRangeToTs(range) {
  const now = Date.now();
  switch (range) {
    case 'today': {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      return { fromTs: d.getTime(), toTs: now };
    }
    case 'yesterday': {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      return { fromTs: d.getTime() - 86400000, toTs: d.getTime() };
    }
    case '7d': return { fromTs: now - 7 * 86400000, toTs: now };
    case '30d': return { fromTs: now - 30 * 86400000, toTs: now };
    default: return {};
  }
}

function groupByDay(items) {
  const groups = {};
  for (const item of items) {
    const label = dayLabel(item.ts);
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  }
  return Object.entries(groups).map(([label, items]) => ({ label, items }));
}

function iconForCategory(category) {
  return CATEGORY_ICONS[category] || 'notifications-outline';
}

// ── Skeleton loading row ───────────────────────────────────────────────────────

function SkeletonRow({ index = 0 }) {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 900, delay: index * 80, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);

  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.55] });

  return (
    <Animated.View style={[styles.rowWrapper, { opacity }]}>
      <GlassSurface tint="neutral" depth={1} radius={14} style={styles.rowContainer}>
        <View style={[styles.rowSevEdge, { backgroundColor: COLORS.primaryLight }]} />
        <View style={[styles.rowIconCol, { backgroundColor: 'rgba(255,255,255,0.06)' }]}>
          <View style={{ width: 16, height: 16, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.1)' }} />
        </View>
        <View style={[styles.rowContent, { gap: 6 }]}>
          <View style={{ height: 11, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.12)', width: '65%' }} />
          <View style={{ height: 9, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.07)', width: '85%' }} />
          <View style={{ height: 9, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.05)', width: '45%', marginTop: 2 }} />
        </View>
      </GlassSurface>
    </Animated.View>
  );
}

// ── Stats Strip ───────────────────────────────────────────────────────────────

function StatsStrip({ stats }) {
  const cards = [
    { label: 'Today', value: stats.today, icon: 'today', color: COLORS.primary },
    { label: 'Unread', value: stats.unread, icon: 'mail-unread', color: '#3B82F6' },
    { label: 'Critical', value: stats.critical, icon: 'alert-circle', color: '#dc2626' },
    { label: 'This week', value: stats.week, icon: 'calendar', color: '#a855f7' },
  ];
  return (
    <View style={styles.statsStrip}>
      {cards.map((c, i) => (
        <GlassCard key={c.label} style={styles.statCard} glow={i === 2 && stats.critical > 0}>
          <View style={[styles.statIconWrap, { backgroundColor: `${c.color}18` }]}>
            <Ionicons name={c.icon} size={14} color={c.color} />
          </View>
          <Text style={[styles.statValue, { color: c.color }]}>{c.value ?? '—'}</Text>
          <Text style={styles.statLabel}>{c.label}</Text>
        </GlassCard>
      ))}
    </View>
  );
}

// ── Filter chips ──────────────────────────────────────────────────────────────

function ChipRow({ items, selected, onToggle, badgeCounts, showIcons }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chipRowContent}>
      {items.map((item) => {
        const active = selected.includes(item.value);
        const count = badgeCounts?.[item.value];
        const isCritical = item.value === 'critical' || item.value === 'error';
        return (
          <TouchableOpacity
            key={item.value}
            onPress={() => onToggle(item.value)}
            style={[styles.chip, active && styles.chipActive, isCritical && count > 0 && styles.chipCriticalPulse]}
            activeOpacity={0.75}
          >
            {showIcons && item.icon && (
              <Ionicons name={item.icon} size={11} color={active ? '#000' : COLORS.textMuted} style={{ marginRight: 4 }} />
            )}
            {item.dot && (
              <View style={[styles.severityDot, { backgroundColor: active ? '#000' : (SEVERITY_COLORS[item.value] || '#888') }]} />
            )}
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{item.label}</Text>
            {count != null && count > 0 && (
              <View style={[styles.chipBadge, active && styles.chipBadgeActive]}>
                <Text style={[styles.chipBadgeText, active && { color: '#000' }]}>{count > 99 ? '99+' : count}</Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ── Notification Row ──────────────────────────────────────────────────────────

function NotificationRow({ item, pushToken, onPress, onMarkRead, onDismiss, severityTokens }) {
  const isRead = item.readByToken?.includes(pushToken || '_default_');
  const sevKey = severityKeyForNotification(item);
  const sevToken = severityTokens?.[sevKey] || severityTokens?.info || { color: SEVERITY_COLORS.info, tint: 'rgba(59,130,246,0.15)', border: 'rgba(59,130,246,0.45)', label: 'INFO' };
  const sevColor = sevToken.color;
  const [actionOpen, setActionOpen] = useState(false);

  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleAnim, { toValue: 0.985, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 2 }).start();
  };

  const title = preferredNotificationTitle(item);
  const body = preferredNotificationBody(item);

  return (
    <Animated.View style={[styles.rowWrapper, { transform: [{ scale: scaleAnim }] }]}>
      <TouchableOpacity
        onPress={() => onPress(item)}
        onLongPress={() => setActionOpen((v) => !v)}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
        style={styles.rowTouchable}
      >
        <GlassSurface
          tint="neutral"
          depth={1}
          radius={14}
          style={[
            styles.rowContainer,
            !isRead && { borderColor: withAlpha(sevColor, 0.35) },
          ]}
        >
          {/* Severity left-edge gradient stripe fading downward */}
          <LinearGradient
            colors={[sevColor, withAlpha(sevColor, 0.0)]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.rowSevEdge}
          />
          {/* Icon circle with tinted glow */}
          <View
            style={[
              styles.rowIconCol,
              {
                backgroundColor: sevToken.tint,
                shadowColor: sevColor,
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: 0.45,
                shadowRadius: 6,
                elevation: 3,
              },
            ]}
          >
            <Ionicons name={iconForCategory(item.category)} size={16} color={sevColor} />
          </View>
          {/* Content */}
          <View style={styles.rowContent}>
            <View style={styles.rowTitleRow}>
              <Text style={[styles.rowTitle, isRead && styles.rowTitleRead]} numberOfLines={2}>
                {title}
              </Text>
              <View style={styles.rowRightMeta}>
                <Text style={styles.rowTime}>{relativeTime(item.ts)}</Text>
                {!isRead && <View style={[styles.unreadDot, { backgroundColor: sevColor }]} />}
              </View>
            </View>
            {body ? (
              <Text style={styles.rowBody} numberOfLines={2}>{body}</Text>
            ) : null}
            <View style={styles.rowMeta}>
              {/* Severity pill */}
              <View
                style={[
                  styles.severityPill,
                  { borderColor: sevToken.border, backgroundColor: sevToken.tint },
                ]}
              >
                <Text style={[styles.severityPillText, { color: sevColor }]}>{sevToken.label}</Text>
              </View>
              {item.source ? (
                <View style={styles.sourceChip}>
                  <Text style={styles.sourceChipText}>{item.source}</Text>
                </View>
              ) : null}
              <Text style={styles.categoryLabel}>{CATEGORY_LABELS[item.category] || item.category}</Text>
            </View>
          </View>
        </GlassSurface>
      </TouchableOpacity>
      {/* Long-press action bar */}
      {actionOpen && (
        <View style={styles.actionBar}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => { onMarkRead(item); setActionOpen(false); }}>
            <Ionicons name={isRead ? 'mail-unread-outline' : 'checkmark-done-outline'} size={14} color={COLORS.primary} />
            <Text style={styles.actionBtnText}>{isRead ? 'Unread' : 'Read'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, styles.actionBtnDanger]} onPress={() => { onDismiss(item); setActionOpen(false); }}>
            <Ionicons name="close-circle-outline" size={14} color={SEVERITY_COLORS.error} />
            <Text style={[styles.actionBtnText, { color: SEVERITY_COLORS.error }]}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      )}
    </Animated.View>
  );
}

// ── Section Header ─────────────────────────────────────────────────────────────

function SectionHeader({ label }) {
  return (
    <View style={styles.sectionHeaderRow}>
      <Text style={styles.sectionHeaderText}>{label}</Text>
      <View style={styles.sectionUnderline} />
    </View>
  );
}

// ── Empty State ────────────────────────────────────────────────────────────────

function EmptyState({ hasFilters }) {
  return (
    <GlassCard style={styles.emptyCard} glow cornerAccents>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="notifications-off-outline" size={48} color={COLORS.primary} style={{ opacity: 0.7 }} />
      </View>
      <Text style={styles.emptyTitle}>All quiet</Text>
      <Text style={styles.emptyDesc}>
        {hasFilters
          ? 'No alerts match your current filters. Try adjusting category, severity, or date range.'
          : "You'll see alerts here as they arrive — agent completions, task updates, system events, and more."}
      </Text>
    </GlassCard>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export function NotificationsCenterScreen({ navigation, route, gateway, notifications }) {
  const pushToken = route?.params?.pushToken || notifications?.expoPushToken || '_default_';
  const sendReq = gateway?.sendReq || route?.params?.gateway?.sendReq;

  const { colors: themeColors } = useTheme();
  const severityTokens = useMemo(() => getSeverityTokens(themeColors), [themeColors]);

  // Quick-filter chip strip — All / Unread / Errors / Sub-agents.
  // These are visual shortcuts on top of the category/severity chips below.
  const [quickFilter, setQuickFilter] = useState('all');

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [stats, setStats] = useState({ today: 0, unread: 0, critical: 0, week: 0 });
  const [liveNotif, setLiveNotif] = useState(null);
  const liveAnim = useRef(new Animated.Value(-80)).current;

  // Filter state
  const [selectedGroups, setSelectedGroups] = useState(['All']);
  const [selectedSeverities, setSelectedSeverities] = useState([]);
  const [searchText, setSearchText] = useState('');
  const [dateRange, setDateRange] = useState('all');
  const [groupCounts, setGroupCounts] = useState({});

  // Stable refs for auto-poll to avoid stale closures
  const loadItemsRef = useRef(null);
  const loadStatsRef = useRef(null);
  const pollRef = useRef(null);
  const liveTimerRef = useRef(null);
  const isMounted = useRef(true);

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  // Build filter params from state
  const buildFilters = useCallback(() => {
    const f = { token: pushToken };
    const categoriesFromGroups = selectedGroups.includes('All')
      ? []
      : selectedGroups.flatMap((g) => CATEGORY_GROUPS[g] || []);
    if (categoriesFromGroups.length > 0) f.categories = categoriesFromGroups;
    if (selectedSeverities.length > 0) f.severities = selectedSeverities;
    if (searchText.trim()) f.text = searchText.trim();
    const tsRange = dateRangeToTs(dateRange);
    if (tsRange.fromTs) f.fromTs = tsRange.fromTs;
    if (tsRange.toTs) f.toTs = tsRange.toTs;
    // Quick filter narrows on top of the structured filters.
    if (quickFilter === 'unread') f.unreadOnly = true;
    if (quickFilter === 'errors') f.severities = ['error', 'critical'];
    if (quickFilter === 'subagents') {
      f.categories = ['agent.completed', 'agent.error', 'agent.input_required'];
    }
    return f;
  }, [selectedGroups, selectedSeverities, searchText, dateRange, pushToken, quickFilter]);

  const loadStats = useCallback(async () => {
    if (!sendReq) return;
    try {
      const todayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
      const [unreadRes, todaySummary, weekSummary, critRes] = await Promise.all([
        sendReq('notifications.history.unreadCount', { token: pushToken }),
        sendReq('notifications.history.byCategorySummary', { period: 'day', token: pushToken }),
        sendReq('notifications.history.byCategorySummary', { period: 'week', token: pushToken }),
        // Accurate critical/error count for today using the list endpoint's `total`
        sendReq('notifications.history.list', {
          limit: 1,
          filters: { token: pushToken, severities: ['critical', 'error'], fromTs: todayStart },
        }),
      ]);

      const todayTotal = (todaySummary?.summary || []).reduce((s, c) => s + c.count, 0);
      const weekTotal = (weekSummary?.summary || []).reduce((s, c) => s + c.count, 0);
      const critCount = critRes?.total || 0;

      // Derive group unread counts from week summary
      const gCounts = {};
      for (const { category, unread } of (weekSummary?.summary || [])) {
        for (const [group, cats] of Object.entries(CATEGORY_GROUPS)) {
          if (cats && cats.includes(category)) {
            gCounts[group] = (gCounts[group] || 0) + unread;
          }
        }
      }
      if (isMounted.current) {
        setStats({ today: todayTotal, unread: unreadRes?.count || 0, critical: critCount, week: weekTotal });
        setGroupCounts(gCounts);
      }
    } catch {}
  }, [sendReq, pushToken]);

  const loadItems = useCallback(async (reset = true) => {
    if (!sendReq) { setLoading(false); return; }
    try {
      if (reset) setLoading(true);
      const filters = buildFilters();
      const res = await sendReq('notifications.history.list', {
        limit: 50,
        cursor: reset ? undefined : cursor,
        filters,
      });
      if (!isMounted.current) return;
      const newItems = res?.items || [];
      if (reset) {
        setItems(newItems);
      } else {
        setItems((prev) => [...prev, ...newItems]);
      }
      setHasMore(!!res?.nextCursor);
      setCursor(res?.nextCursor || null);
    } catch (e) {
      console.warn('[NotificationsCenter] load error:', e?.message);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [sendReq, buildFilters, cursor]);

  // Keep refs in sync so the auto-poll always calls the latest version
  useEffect(() => { loadItemsRef.current = loadItems; }, [loadItems]);
  useEffect(() => { loadStatsRef.current = loadStats; }, [loadStats]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadItems(true), loadStats()]);
    setRefreshing(false);
  }, [loadItems, loadStats]);

  // Initial load + reload on filter change
  useEffect(() => {
    loadItems(true);
    loadStats();
  }, [selectedGroups, selectedSeverities, searchText, dateRange, quickFilter]);

  // Auto-poll every 15s — uses refs to avoid stale closure
  useEffect(() => {
    pollRef.current = setInterval(() => {
      loadStatsRef.current?.();
      loadItemsRef.current?.(true);
    }, 15000);
    return () => clearInterval(pollRef.current);
  }, []);

  // Live gateway subscription
  useEffect(() => {
    if (!gateway?.subscribeEvent) return;
    const unsub = gateway.subscribeEvent('notification.created', (payload) => {
      if (!isMounted.current) return;
      setItems((prev) => [payload, ...prev]);
      setStats((s) => ({ ...s, unread: s.unread + 1, today: s.today + 1 }));
      // Show live in-page banner
      setLiveNotif(payload);
      Animated.spring(liveAnim, { toValue: 0, useNativeDriver: true, tension: 80, friction: 10 }).start();
      clearTimeout(liveTimerRef.current);
      liveTimerRef.current = setTimeout(() => {
        Animated.timing(liveAnim, { toValue: -80, duration: 250, useNativeDriver: true }).start(() => {
          if (isMounted.current) setLiveNotif(null);
        });
      }, 4000);
    });
    return () => { unsub?.(); clearTimeout(liveTimerRef.current); };
  }, [gateway]);

  const handleToggleGroup = (group) => {
    if (group === 'All') { setSelectedGroups(['All']); return; }
    setSelectedGroups((prev) => {
      const without = prev.filter((g) => g !== 'All');
      const next = without.includes(group) ? without.filter((g) => g !== group) : [...without, group];
      return next.length === 0 ? ['All'] : next;
    });
  };

  const handleToggleSeverity = (sev) => {
    setSelectedSeverities((prev) =>
      prev.includes(sev) ? prev.filter((s) => s !== sev) : [...prev, sev]
    );
  };

  const handleMarkRead = useCallback(async (item) => {
    if (!sendReq) return;
    const isRead = item.readByToken?.includes(pushToken);
    try {
      if (isRead) {
        await sendReq('notifications.history.markUnread', { ids: [item.id], token: pushToken });
      } else {
        await sendReq('notifications.history.markRead', { ids: [item.id], token: pushToken });
      }
      setItems((prev) =>
        prev.map((n) =>
          n.id !== item.id ? n : {
            ...n,
            readByToken: isRead
              ? (n.readByToken || []).filter((t) => t !== pushToken)
              : [...(n.readByToken || []), pushToken],
          }
        )
      );
      setStats((s) => ({ ...s, unread: Math.max(0, s.unread + (isRead ? 1 : -1)) }));
    } catch {}
  }, [sendReq, pushToken]);

  const handleDismiss = useCallback(async (item) => {
    if (!sendReq) return;
    try {
      await sendReq('notifications.history.dismiss', { ids: [item.id], token: pushToken });
      setItems((prev) => prev.filter((n) => n.id !== item.id));
    } catch {}
  }, [sendReq, pushToken]);

  const handleMarkAllRead = useCallback(async () => {
    if (!sendReq) return;
    try {
      await sendReq('notifications.history.markRead', { all: true, token: pushToken });
      setItems((prev) => prev.map((n) => ({ ...n, readByToken: [...(n.readByToken || []), pushToken] })));
      setStats((s) => ({ ...s, unread: 0 }));
    } catch {}
  }, [sendReq, pushToken]);

  const handleOpenDetail = useCallback((item) => {
    const nav = navigation?.getParent?.() || navigation;
    nav?.navigate?.('NotificationDetailModal', { notification: item, gateway, pushToken });
  }, [navigation, gateway, pushToken]);

  const handleOpenPreferences = useCallback(() => {
    const nav = navigation?.getParent?.() || navigation;
    nav?.navigate?.('NotificationsPrefsModal', { gateway, pushToken });
  }, [navigation, gateway, pushToken]);

  const grouped = groupByDay(items);
  const hasFilters =
    !selectedGroups.includes('All') ||
    selectedSeverities.length > 0 ||
    !!searchText ||
    dateRange !== 'all' ||
    quickFilter !== 'all';

  const categoryChips = Object.keys(CATEGORY_GROUPS).map((g) => ({
    label: g,
    value: g,
    icon: GROUP_ICONS[g],
  }));

  const severityChips = ALL_SEVERITIES.map((s) => ({
    label: s.charAt(0).toUpperCase() + s.slice(1),
    value: s,
    dot: true,
  }));

  return (
    <View style={styles.container}>
      {/* Live in-page toast */}
      {liveNotif && (() => {
        const toastSevKey = severityKeyForNotification(liveNotif);
        const toastTok = severityTokens[toastSevKey] || severityTokens.info;
        return (
          <Animated.View style={[styles.liveToast, { transform: [{ translateY: liveAnim }], borderColor: toastTok.border }]}>
            <View style={[styles.liveToastEdge, { backgroundColor: toastTok.color }]} />
            <Ionicons
              name={iconForCategory(liveNotif.category)}
              size={15}
              color={toastTok.color}
              style={{ marginHorizontal: 8 }}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.liveToastTitle} numberOfLines={1}>{preferredNotificationTitle(liveNotif)}</Text>
              <Text style={styles.liveToastBody} numberOfLines={1}>{preferredNotificationBody(liveNotif)}</Text>
            </View>
            <TouchableOpacity onPress={() => setLiveNotif(null)} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <Ionicons name="close" size={15} color={COLORS.textMuted} />
            </TouchableOpacity>
          </Animated.View>
        );
      })()}

      {/* Premium glass header — large title + unread badge + filter chip strip */}
      <View style={styles.headerBlur} pointerEvents="box-none">
        <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={[
            withAlpha(themeColors.primary, 0.20),
            withAlpha(themeColors.primary, 0.05),
            'rgba(0,0,0,0.45)',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack?.()}>
            <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <View style={styles.headerTitleRow}>
            <Text style={styles.heading}>Alerts</Text>
            {stats.unread > 0 && (
              <View style={[styles.unreadBadge, { backgroundColor: severityTokens.subagent.color, shadowColor: severityTokens.subagent.color }]}>
                <Text style={styles.unreadBadgeText}>{stats.unread > 99 ? '99+' : stats.unread}</Text>
              </View>
            )}
            <View style={{ flex: 1 }} />
            <TouchableOpacity style={styles.headerBtn} onPress={handleMarkAllRead} activeOpacity={0.75}>
              <Text style={styles.headerBtnText}>Mark all read</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.headerIconBtn} onPress={handleOpenPreferences} activeOpacity={0.75}>
              <Ionicons name="options-outline" size={17} color={COLORS.primary} />
            </TouchableOpacity>
          </View>
          {/* Quick-filter chip strip */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.quickChipRow}
            contentContainerStyle={styles.quickChipRowContent}
          >
            {[
              { key: 'all', label: 'All', icon: 'apps-outline' },
              { key: 'unread', label: 'Unread', icon: 'mail-unread-outline' },
              { key: 'errors', label: 'Errors', icon: 'alert-circle-outline', sevKey: 'error' },
              { key: 'subagents', label: 'Sub-agents', icon: 'flash-outline', sevKey: 'subagent' },
            ].map((q) => {
              const active = quickFilter === q.key;
              const sev = q.sevKey ? severityTokens[q.sevKey] : null;
              const accent = sev ? sev.color : themeColors.primary;
              return (
                <TouchableOpacity
                  key={q.key}
                  onPress={() => setQuickFilter(q.key)}
                  style={[
                    styles.quickChip,
                    active && {
                      backgroundColor: withAlpha(accent, 0.18),
                      borderColor: accent,
                    },
                  ]}
                  activeOpacity={0.8}
                >
                  <Ionicons name={q.icon} size={12} color={active ? accent : COLORS.textMuted} />
                  <Text style={[styles.quickChipText, active && { color: accent, fontWeight: '700' }]}>
                    {q.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
        <LinearGradient
          colors={['transparent', withAlpha(themeColors.primary, 0.35), 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.headerBottomLine}
        />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.primary} />}
        onScrollEndDrag={({ nativeEvent }) => {
          const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
          if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 100 && hasMore) {
            loadItems(false);
          }
        }}
        scrollEventThrottle={16}
      >
        {/* Stats strip */}
        <StatsStrip stats={stats} />

        {/* Category groups */}
        <Text style={styles.filterLabel}>Category</Text>
        <ChipRow
          items={categoryChips}
          selected={selectedGroups}
          onToggle={handleToggleGroup}
          badgeCounts={groupCounts}
          showIcons
        />

        {/* Severity filter */}
        <Text style={styles.filterLabel}>Severity</Text>
        <ChipRow
          items={severityChips}
          selected={selectedSeverities}
          onToggle={handleToggleSeverity}
        />

        {/* Search */}
        <View style={styles.searchBar}>
          <Ionicons name="search" size={14} color={COLORS.textMuted} style={{ marginRight: 7 }} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search alerts..."
            placeholderTextColor={COLORS.textMuted}
            value={searchText}
            onChangeText={setSearchText}
          />
          {searchText ? (
            <TouchableOpacity onPress={() => setSearchText('')} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <Ionicons name="close-circle" size={15} color={COLORS.textMuted} />
            </TouchableOpacity>
          ) : (
            <Ionicons name="mic-outline" size={15} color="rgba(255,255,255,0.2)" />
          )}
        </View>

        {/* Date range */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chipRowContent}>
          {DATE_RANGES.map((d) => (
            <TouchableOpacity
              key={d.value}
              onPress={() => setDateRange(d.value)}
              style={[styles.chip, dateRange === d.value && styles.chipActive]}
              activeOpacity={0.75}
            >
              <Text style={[styles.chipText, dateRange === d.value && styles.chipTextActive]}>{d.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* List */}
        {loading ? (
          <View style={styles.loadingState}>
            {[0, 1, 2, 3, 4].map((i) => <SkeletonRow key={i} index={i} />)}
          </View>
        ) : items.length === 0 ? (
          <EmptyState hasFilters={hasFilters} />
        ) : (
          grouped.map(({ label, items: sectionItems }) => (
            <View key={label}>
              <SectionHeader label={label} />
              {sectionItems.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  pushToken={pushToken}
                  onPress={handleOpenDetail}
                  onMarkRead={handleMarkRead}
                  onDismiss={handleDismiss}
                  severityTokens={severityTokens}
                />
              ))}
            </View>
          ))
        )}

        {hasMore && !loading && (
          <TouchableOpacity style={styles.loadMoreBtn} onPress={() => loadItems(false)} activeOpacity={0.75}>
            <Ionicons name="chevron-down" size={14} color={COLORS.primary} style={{ marginRight: 6 }} />
            <Text style={styles.loadMoreText}>Load more</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

export default NotificationsCenterScreen;

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 180, paddingBottom: 110 },

  // Live in-page toast
  liveToast: {
    position: 'absolute',
    top: 130,
    left: 12,
    right: 12,
    zIndex: 100,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(12,12,18,0.97)',
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    borderRadius: 14,
    overflow: 'hidden',
    paddingVertical: 10,
    paddingRight: 12,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 14,
    elevation: 12,
  },
  liveToastEdge: { width: 4, alignSelf: 'stretch' },
  liveToastTitle: { ...FONTS.small, color: COLORS.text, fontWeight: '700', fontSize: 12 },
  liveToastBody: { ...FONTS.tiny, color: COLORS.textMuted, marginTop: 1, fontSize: 11 },

  // Premium glass header
  headerBlur: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  headerBottomLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
  },
  quickChipRow: {
    marginTop: SPACING.sm,
    marginHorizontal: -SPACING.lg,
  },
  quickChipRowContent: {
    paddingHorizontal: SPACING.lg,
    gap: 6,
    flexDirection: 'row',
  },
  quickChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  quickChipText: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 11,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  backText: { ...FONTS.small, color: COLORS.primary, marginLeft: 4, fontSize: 13 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  heading: { ...FONTS.heading, color: COLORS.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
  unreadBadge: {
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: 'center',
  },
  unreadBadgeText: { ...FONTS.tiny, color: '#fff', fontWeight: '700', fontSize: 11 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 22,
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
  },
  headerBtnText: { ...FONTS.tiny, color: COLORS.primary, fontWeight: '600', fontSize: 12 },
  headerIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Stats strip
  statsStrip: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: SPACING.lg,
    marginBottom: SPACING.md,
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    gap: 5,
  },
  statIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  statValue: { ...FONTS.small, fontWeight: '800', fontSize: 20, lineHeight: 22 },
  statLabel: { ...FONTS.tiny, color: COLORS.textMuted, fontSize: 10, letterSpacing: 0.3 },

  // Filter
  filterLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    paddingHorizontal: SPACING.lg,
    marginBottom: 5,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontSize: 10,
  },
  chipRow: { marginBottom: SPACING.sm },
  chipRowContent: { paddingHorizontal: SPACING.lg, gap: 6, flexDirection: 'row' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
  },
  chipActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  chipCriticalPulse: {
    borderColor: '#dc2626',
    backgroundColor: 'rgba(220,38,38,0.08)',
  },
  chipText: { ...FONTS.tiny, color: COLORS.textMuted, fontSize: 12 },
  chipTextActive: { color: '#000', fontWeight: '700' },
  severityDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 5,
  },
  chipBadge: {
    marginLeft: 5,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  chipBadgeActive: { backgroundColor: 'rgba(0,0,0,0.18)' },
  chipBadgeText: { ...FONTS.tiny, color: COLORS.textMuted, fontSize: 10 },

  // Search
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: SPACING.lg,
    marginBottom: SPACING.sm,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  searchInput: {
    flex: 1,
    ...FONTS.small,
    color: COLORS.text,
    padding: 0,
    fontSize: 13,
  },

  // Section header with gold underline
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingTop: 10,
    paddingBottom: 5,
    gap: 10,
  },
  sectionHeaderText: {
    ...FONTS.tiny,
    color: COLORS.glowStrong,
    textTransform: 'uppercase',
    letterSpacing: 0.9,
    fontSize: 10,
    fontWeight: '700',
  },
  sectionUnderline: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.primaryLight,
  },

  // Notification row — GlassSurface handles the blur + tint + border; this
  // container just lays out the inner columns above the glass stack.
  rowWrapper: { marginHorizontal: SPACING.lg, marginBottom: 8 },
  rowTouchable: {},
  rowContainer: {
    flexDirection: 'row',
    alignItems: 'stretch',
    overflow: 'hidden',
    minHeight: 64,
  },
  rowSevEdge: { width: 3, alignSelf: 'stretch' },
  rowIconCol: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12,
    marginLeft: 10,
    borderRadius: 17,
  },
  severityPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  severityPillText: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  rowContent: { flex: 1, padding: 10, paddingLeft: 10 },
  rowTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  rowTitle: { ...FONTS.small, color: COLORS.text, fontWeight: '700', flex: 1, marginRight: 8, fontSize: 13 },
  rowTitleRead: { color: COLORS.textMuted, fontWeight: '400' },
  rowRightMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rowTime: { ...FONTS.tiny, color: COLORS.textMuted, fontSize: 10 },
  rowBody: { ...FONTS.tiny, color: COLORS.textMuted, marginTop: 3, fontSize: 11, lineHeight: 15 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 },
  sourceChip: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  sourceChipText: { ...FONTS.tiny, color: COLORS.textMuted, fontSize: 10 },
  categoryLabel: { ...FONTS.tiny, color: COLORS.primaryStrong, fontSize: 10 },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#3B82F6',
  },

  // Action bar
  actionBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(8,8,14,0.97)',
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: COLORS.primaryDim,
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    overflow: 'hidden',
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.06)',
  },
  actionBtnDanger: { borderRightWidth: 0 },
  actionBtnText: { ...FONTS.tiny, color: COLORS.primary, fontSize: 11 },

  // Loading skeleton
  loadingState: { paddingTop: 4 },

  // Empty state
  emptyCard: {
    marginHorizontal: SPACING.lg,
    marginTop: 24,
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 24,
    gap: 12,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: COLORS.primaryDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: { ...FONTS.heading, color: COLORS.text, textAlign: 'center', fontSize: 18, fontWeight: '700' },
  emptyDesc: { ...FONTS.small, color: COLORS.textMuted, textAlign: 'center', lineHeight: 20, fontSize: 13 },

  // Load more
  loadMoreBtn: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.md,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  loadMoreText: { ...FONTS.small, color: COLORS.primary, fontSize: 13 },
});
