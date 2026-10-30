/**
 * DisciplineScreen — mobile-first port of the web Discipline view.
 *
 * Sub-views: Today | Board | List | Log | Settings
 * Stacked subscreens (via DisciplineStackScreen in App.js):
 *   DisciplineBlockDetail, DisciplineLog, DisciplineSettings
 *
 * Gateway methods consumed:
 *   discipline.state, discipline.score.day, discipline.score.week,
 *   discipline.events.list, discipline.blocks.{create,update,delete,complete,uncomplete},
 *   discipline.routine.toggle, discipline.settings.update, discipline.logs.{list,create},
 *   discipline.start_day, discipline.end_day, discipline.shift_from_now,
 *   discipline.templates.{list,apply}, discipline.notion.status
 *
 * TODO (gateway endpoints not yet available):
 *   - discipline.score.range  → analytics window > 30d (stub: uses week data)
 *   - discipline.counters.*   → separate counter objects (stub: shows event-count totals)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, FlatList,
  RefreshControl, ActivityIndicator, Alert, Animated, Dimensions,
  TextInput, Modal, Pressable,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { COLORS, FONTS, SPACING, GLASS } from '../constants/theme';
import { GlassCard } from '../components/GlassCard';
import { BlockCard } from '../components/discipline/BlockCard';
import { CounterTile } from '../components/discipline/CounterTile';
import { StreakBadge } from '../components/discipline/StreakBadge';
import { AlertBanner } from '../components/discipline/AlertBanner';
import {
  useDiscipline,
  blockStatus, minsToHHMM, humanDuration, streakCount, scoreColor,
  CATEGORY_COLORS, CATEGORY_LABELS, DISCIPLINE_CATEGORIES, todayIso,
} from '../hooks/useDiscipline';

const { width: SCREEN_W } = Dimensions.get('window');
const MISSING_RX = /method not found|unknown method|not implemented|no handler|unsupported/i;

// ── Sub-view definitions ──────────────────────────────────────────────────

const SUBVIEWS = [
  { key: 'today', label: 'Today', icon: 'today-outline' },
  { key: 'board', label: 'Board', icon: 'grid-outline' },
  { key: 'list', label: 'List', icon: 'list-outline' },
  { key: 'log', label: 'Log', icon: 'time-outline' },
];

// ── Shimmer skeleton ──────────────────────────────────────────────────────

function Shimmer({ style }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return (
    <Animated.View
      style={[
        { borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.07)', opacity: anim },
        style,
      ]}
    />
  );
}

function BlockSkeleton() {
  return (
    <View style={[skStyles.card, { gap: SPACING.sm }]}>
      <Shimmer style={{ height: 14, width: '60%' }} />
      <Shimmer style={{ height: 10, width: '40%' }} />
    </View>
  );
}

const skStyles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.primaryDim,
    backgroundColor: 'rgba(15,15,15,0.6)',
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
});

// ── Oversight header row ──────────────────────────────────────────────────

function OversightRow({
  today, week, completedSet, todayBlocks, alertCount,
  onJumpToFirst,
}) {
  const pct = today?.compliance ? Math.round(today.compliance) : 0;
  const streak = streakCount(week);
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

  const visible = todayBlocks.filter(b => {
    const s = blockStatus(b, nowMin, completedSet, todayIso());
    return s !== 'not-today' && s !== 'disabled';
  });
  const statuses = visible.map(b => ({
    block: b,
    status: blockStatus(b, nowMin, completedSet, todayIso()),
  }));
  const doneCount = statuses.filter(x => x.status === 'completed').length;
  const overCount = statuses.filter(x => x.status === 'overrunning').length;
  const missedCount = statuses.filter(x => x.status === 'missed').length;
  const leftCount = statuses.filter(
    x => x.status === 'upcoming' || x.status === 'starting-soon' || x.status === 'in-progress'
  ).length;

  const firstOverrun = statuses.find(x => x.status === 'overrunning')?.block;
  const firstActive = statuses.find(x => x.status === 'in-progress')?.block;
  const firstUpcoming = statuses.find(x => x.status === 'upcoming' || x.status === 'starting-soon')?.block;
  const firstRemaining = firstActive || firstUpcoming;
  const firstDone = statuses.find(x => x.status === 'completed')?.block;

  const stats = [
    {
      key: 'done', icon: 'checkmark-circle',
      label: 'Done', value: String(doneCount),
      color: doneCount > 0 ? '#22D3EE' : COLORS.textMuted,
      tone: scoreColor(pct),
      onPress: firstDone ? () => onJumpToFirst?.(firstDone.id) : null,
    },
    {
      key: 'left', icon: 'time-outline',
      label: 'Left', value: String(leftCount),
      color: leftCount > 0 ? COLORS.primary : COLORS.textMuted,
      onPress: firstRemaining ? () => onJumpToFirst?.(firstRemaining.id) : null,
    },
    {
      key: 'over', icon: 'alert-circle',
      label: 'Over', value: String(overCount + missedCount),
      color: (overCount > 0) ? '#F59E0B' : (missedCount > 0 ? '#EF4444' : COLORS.textMuted),
      onPress: firstOverrun ? () => onJumpToFirst?.(firstOverrun.id) : null,
    },
    {
      key: 'streak', icon: 'flame',
      label: `${pct}%`, value: `${streak}d`,
      color: streak >= 3 ? '#F59E0B' : COLORS.textMuted,
    },
  ];

  return (
    <View style={styles.oversightRow}>
      {stats.map(s => {
        const Wrapper = s.onPress ? TouchableOpacity : View;
        return (
          <Wrapper
            key={s.key}
            style={styles.oversightStat}
            onPress={s.onPress || undefined}
            activeOpacity={s.onPress ? 0.7 : 1}
            hitSlop={s.onPress ? 6 : undefined}
          >
            <Ionicons name={s.icon} size={12} color={s.color} />
            <Text style={[styles.oversightVal, { color: s.color }]}>{s.value}</Text>
            <Text style={styles.oversightLabel}>{s.label}</Text>
          </Wrapper>
        );
      })}
    </View>
  );
}

// ── Day action bar ────────────────────────────────────────────────────────

function DayActionBar({ today, dayStarted, busy, onStart, onEnd, onShift }) {
  const startedAt = today?.startedAt;
  const endedAt = today?.endedAt;

  let statusLabel = 'Day not started';
  if (dayStarted && !endedAt) {
    statusLabel = 'Day in progress';
  } else if (endedAt) {
    statusLabel = `Day ended at ${new Date(endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  return (
    <GlassCard style={styles.dayBar} cornerAccents>
      <View style={styles.dayBarContent}>
        <View style={styles.dayBarLeft}>
          <Text style={styles.dayBarStatus}>{statusLabel}</Text>
          {startedAt && !endedAt ? (
            <Text style={styles.dayBarSub}>
              Since {new Date(startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          ) : null}
        </View>
        <View style={styles.dayBarActions}>
          {!endedAt ? (
            <TouchableOpacity
              style={[styles.dayPill, dayStarted ? styles.dayPillEnd : styles.dayPillStart]}
              onPress={dayStarted ? onEnd : onStart}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator size="small" color={dayStarted ? '#fff' : '#000'} />
              ) : (
                <>
                  <Ionicons
                    name={dayStarted ? 'stop-circle' : 'play-circle'}
                    size={16}
                    color={dayStarted ? '#fff' : '#000'}
                  />
                  <Text style={[styles.dayPillText, dayStarted && { color: '#fff' }]}>
                    {dayStarted ? 'End Day' : 'Start Day'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
          {dayStarted && !endedAt ? (
            <TouchableOpacity
              style={styles.shiftBtn}
              onPress={onShift}
              disabled={busy}
            >
              <Ionicons name="time-outline" size={14} color={COLORS.primary} />
              <Text style={styles.shiftBtnText}>Shift now</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </GlassCard>
  );
}

// ── Today view ────────────────────────────────────────────────────────────

function TodayView({
  todayBlocks, completedSet, routineDoneSet, today, week, allEvents,
  eventCounts, insights, dayStart, alerts, onBlockPress, onComplete, onUncomplete, onToggleRoutine, onQuickLog,
  onBlockLayout, dayStarted, dayEnded,
}) {
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const todayStr = todayIso();
  const pct = today?.compliance ? Math.round(today.compliance) : 0;

  // Derive quick counts from auto-log events
  const totalEvents = allEvents?.length || 0;
  const manualEvents = allEvents?.filter(e => e.kind === 'manual')?.length || 0;

  // Group counters by kind for display
  const kindCounts = {};
  for (const ev of (allEvents || [])) {
    kindCounts[ev.kind] = (kindCounts[ev.kind] || 0) + 1;
  }
  const topKinds = Object.entries(kindCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6);

  return (
    <View style={{ gap: SPACING.md }}>
      {/* Alert banners */}
      {alerts?.length > 0 ? (
        <AlertBanner alerts={alerts} />
      ) : null}

      {/* Day score card */}
      {today ? (
        <GlassCard style={styles.scoreCard}>
          <View style={styles.scoreRow}>
            <View style={styles.scoreLeft}>
              <Text style={styles.cardLabel}>Today's score</Text>
              <Text style={[styles.scorePct, { color: scoreColor(pct) }]}>{pct}%</Text>
              <Text style={styles.scoreSub}>
                {today.routineCompleted || 0}/{today.routineTotal || 0} routine ·{' '}
                {today.nonNegotiableMissed || 0} non-neg missed
              </Text>
            </View>
            <View style={styles.scoreWeek}>
              {(week || []).slice(-7).map((d, i) => {
                const h = Math.max(4, Math.min(40, ((d.compliance || 0) / 100) * 40));
                return (
                  <View key={i} style={styles.barWrap}>
                    <View
                      style={[
                        styles.bar,
                        { height: h, backgroundColor: scoreColor(d.compliance || 0) + 'AA' },
                      ]}
                    />
                  </View>
                );
              })}
            </View>
          </View>
          {today.timeSavedMin > 0 ? (
            <View style={styles.savedBadge}>
              <Ionicons name="time" size={11} color="#10B981" />
              <Text style={styles.savedText}>
                {humanDuration(today.timeSavedMin)} saved today
              </Text>
            </View>
          ) : null}
        </GlassCard>
      ) : null}

      {/* Block timeline */}
      <Text style={styles.sectionHeading}>Today's blocks</Text>
      {dayStart?.startMinute != null ? (
        <Text style={styles.autoStartedNote}>
          <Ionicons name="flash-outline" size={11} color="#10B981" /> Day auto-started at {minsToHHMM(dayStart.startMinute)}
        </Text>
      ) : null}
      {dayEnded ? (
        <GlassCard style={styles.emptyCard}>
          <MaterialCommunityIcons name="moon-waning-crescent" size={32} color="#22D3EE" />
          <Text style={styles.emptyTitle}>Day wrapped</Text>
          <Text style={styles.emptyBody}>
            Today is logged. Pull to refresh, open the Log tab to review, or plan tomorrow from the Board.
          </Text>
        </GlassCard>
      ) : todayBlocks.length === 0 ? (
        <GlassCard style={styles.emptyCard}>
          <MaterialCommunityIcons
            name={dayStarted ? 'calendar-check-outline' : 'calendar-blank'}
            size={32}
            color={COLORS.textMuted}
          />
          <Text style={styles.emptyTitle}>
            {dayStarted ? 'Nothing scheduled today' : 'Start your day'}
          </Text>
          <Text style={styles.emptyBody}>
            {dayStarted
              ? 'Add blocks in the Board tab to anchor the rest of the day.'
              : 'Tap "Start Day" above to anchor your first block, or add blocks in the Board tab.'}
          </Text>
        </GlassCard>
      ) : (
        todayBlocks.map(block => {
          const status = blockStatus(block, nowMin, completedSet, todayStr);
          if (status === 'not-today' || status === 'disabled') return null;
          return (
            <View
              key={block.id}
              onLayout={onBlockLayout
                ? (e) => onBlockLayout(block.id, e.nativeEvent.layout.y)
                : undefined}
            >
              <BlockCard
                block={block}
                status={status}
                routineDoneSet={routineDoneSet}
                insight={insights?.[block.id]}
                onComplete={onComplete}
                onUncomplete={onUncomplete}
                onToggleRoutine={onToggleRoutine}
                onPress={() => onBlockPress(block)}
              />
            </View>
          );
        })
      )}

      {/* Auto-log event counts */}
      {topKinds.length > 0 ? (
        <>
          <Text style={styles.sectionHeading}>Today's activity</Text>
          <View style={styles.countersGrid}>
            {topKinds.map(([kind, count]) => (
              <View key={kind} style={{ flex: 1, minWidth: (SCREEN_W - 48) / 3 - 8 }}>
                <CounterTile
                  label={kind.replace(/_/g, ' ')}
                  value={count}
                  kind={kind}
                  compact
                />
              </View>
            ))}
          </View>
          <TouchableOpacity
            style={styles.quickLogBtn}
            onPress={() => onQuickLog && onQuickLog()}
          >
            <Ionicons name="add-circle" size={16} color={COLORS.primary} />
            <Text style={styles.quickLogText}>Quick-log manual event</Text>
          </TouchableOpacity>
        </>
      ) : null}
    </View>
  );
}

// ── Board view ────────────────────────────────────────────────────────────

function BoardView({ blocks, completedSet, routineDoneSet, onBlockPress, onComplete, onUncomplete, onNewBlock }) {
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const todayStr = todayIso();

  return (
    <View style={{ gap: SPACING.md }}>
      <TouchableOpacity style={styles.newBlockBtn} onPress={onNewBlock}>
        <Ionicons name="add" size={16} color={COLORS.primary} />
        <Text style={styles.newBlockText}>New block</Text>
      </TouchableOpacity>
      {DISCIPLINE_CATEGORIES.map(cat => {
        const catBlocks = blocks.filter(b => b.category === cat && b.enabled);
        if (catBlocks.length === 0) return null;
        const color = CATEGORY_COLORS[cat];
        return (
          <View key={cat}>
            <View style={styles.catHeader}>
              <View style={[styles.catDot, { backgroundColor: color }]} />
              <Text style={[styles.catTitle, { color }]}>{CATEGORY_LABELS[cat]}</Text>
              <Text style={styles.catCount}>{catBlocks.length}</Text>
            </View>
            {catBlocks.map(block => {
              const status = blockStatus(block, nowMin, completedSet, todayStr);
              return (
                <BlockCard
                  key={block.id}
                  block={block}
                  status={status}
                  routineDoneSet={routineDoneSet}
                  onComplete={onComplete}
                  onUncomplete={onUncomplete}
                  onPress={() => onBlockPress(block)}
                  compact
                />
              );
            })}
          </View>
        );
      })}
      {blocks.filter(b => b.enabled).length === 0 ? (
        <GlassCard style={styles.emptyCard}>
          <MaterialCommunityIcons name="calendar-plus" size={32} color={COLORS.textMuted} />
          <Text style={styles.emptyTitle}>No blocks yet</Text>
          <Text style={styles.emptyBody}>
            Tap "New block" above to build your daily schedule.
          </Text>
        </GlassCard>
      ) : null}
    </View>
  );
}

// ── List view ─────────────────────────────────────────────────────────────

function ListView({ blocks, completedSet, routineDoneSet, onBlockPress, onComplete, onUncomplete, onNewBlock }) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('time'); // time | category | status
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const todayStr = todayIso();

  const filtered = blocks
    .filter(b => !search || b.label?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortKey === 'time') return a.startMinute - b.startMinute;
      if (sortKey === 'category') return a.category?.localeCompare(b.category);
      // status: active first
      const oa = ['in-progress', 'starting-soon', 'upcoming', 'completed', 'missed', 'disabled'];
      const sa = blockStatus(a, nowMin, completedSet, todayStr);
      const sb = blockStatus(b, nowMin, completedSet, todayStr);
      return (oa.indexOf(sa) || 99) - (oa.indexOf(sb) || 99);
    });

  return (
    <View style={{ gap: SPACING.sm }}>
      {/* Controls */}
      <View style={styles.listControls}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={14} color={COLORS.textMuted} />
          <TextInput
            style={styles.listSearch}
            placeholder="Search…"
            placeholderTextColor={COLORS.textMuted}
            value={search}
            onChangeText={setSearch}
          />
        </View>
        <View style={styles.sortRow}>
          {['time', 'category', 'status'].map(k => (
            <TouchableOpacity
              key={k}
              style={[styles.sortChip, sortKey === k && styles.sortChipActive]}
              onPress={() => setSortKey(k)}
            >
              <Text style={[styles.sortChipText, sortKey === k && styles.sortChipTextActive]}>
                {k}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      <TouchableOpacity style={styles.newBlockBtn} onPress={onNewBlock}>
        <Ionicons name="add" size={16} color={COLORS.primary} />
        <Text style={styles.newBlockText}>New block</Text>
      </TouchableOpacity>
      {filtered.map(block => {
        const status = blockStatus(block, nowMin, completedSet, todayStr);
        return (
          <BlockCard
            key={block.id}
            block={block}
            status={status}
            routineDoneSet={routineDoneSet}
            onComplete={onComplete}
            onUncomplete={onUncomplete}
            onPress={() => onBlockPress(block)}
          />
        );
      })}
      {filtered.length === 0 ? (
        <Text style={styles.emptyText}>No blocks match.</Text>
      ) : null}
    </View>
  );
}

// ── Quick-log modal ───────────────────────────────────────────────────────

function QuickLogModal({ visible, blocks, onClose, onSubmit }) {
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState('personal');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!label.trim()) return;
    setBusy(true);
    try {
      await onSubmit?.({ label: label.trim(), category, note: note.trim() || undefined });
      setLabel('');
      setNote('');
      onClose?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={qlStyles.overlay}>
        <Pressable style={qlStyles.backdrop} onPress={onClose} />
        <GlassCard style={qlStyles.sheet}>
          <Text style={qlStyles.heading}>Quick Log</Text>
          <TextInput
            style={qlStyles.input}
            placeholder="Event label…"
            placeholderTextColor={COLORS.textMuted}
            value={label}
            onChangeText={setLabel}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={submit}
          />
          <TextInput
            style={qlStyles.input}
            placeholder="Note (optional)"
            placeholderTextColor={COLORS.textMuted}
            value={note}
            onChangeText={setNote}
          />
          <View style={qlStyles.catRow}>
            {DISCIPLINE_CATEGORIES.slice(0, 4).map(cat => {
              const color = CATEGORY_COLORS[cat];
              const sel = category === cat;
              return (
                <TouchableOpacity
                  key={cat}
                  style={[qlStyles.catChip, { borderColor: color + (sel ? 'FF' : '30') }, sel && { backgroundColor: color + '18' }]}
                  onPress={() => setCategory(cat)}
                >
                  <Text style={[qlStyles.catText, { color: sel ? color : COLORS.textMuted }]}>
                    {CATEGORY_LABELS[cat]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity
            style={[qlStyles.submitBtn, (!label.trim() || busy) && { opacity: 0.5 }]}
            onPress={submit}
            disabled={!label.trim() || busy}
          >
            {busy ? <ActivityIndicator size="small" color="#000" /> : (
              <Text style={qlStyles.submitText}>Log event</Text>
            )}
          </TouchableOpacity>
        </GlassCard>
      </View>
    </Modal>
  );
}

const qlStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { margin: SPACING.md, padding: SPACING.xl, gap: SPACING.sm, borderRadius: 20 },
  heading: { ...FONTS.heading, color: COLORS.text, marginBottom: 4 },
  input: {
    ...FONTS.small,
    color: COLORS.text,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    padding: SPACING.md,
  },
  catRow: { flexDirection: 'row', gap: SPACING.sm, flexWrap: 'wrap' },
  catChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99, borderWidth: 1 },
  catText: { ...FONTS.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  submitBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    padding: SPACING.md,
    alignItems: 'center',
    marginTop: 4,
  },
  submitText: { ...FONTS.small, color: '#000', fontWeight: '700' },
});

// ── Main screen ───────────────────────────────────────────────────────────

export function DisciplineScreen({ navigation, gateway }) {
  const { sendReq, subscribeEvent, status } = gateway || {};
  const insets = useSafeAreaInsets();

  const discipline = useDiscipline({ sendReq, subscribeEvent, status });
  const {
    supported, loading, refreshing, error,
    blocks, todayBlocks, logs, settings, today, week,
    completedSet, routineDoneSet, allEvents, eventCounts,
    insights, insightSummary, dayStart,
    startDay, endDay, shiftFromNow,
    markBlockComplete, unmarkBlockComplete, toggleRoutineItem,
    quickLog, refresh,
  } = discipline;

  const [subView, setSubView] = useState('today');
  const [dayBusy, setDayBusy] = useState(false);
  const [showQuickLog, setShowQuickLog] = useState(false);
  const [disciplineAlerts, setDisciplineAlerts] = useState([]);

  // Scroll plumbing for oversight strip → first matching block jump
  const contentScrollRef = useRef(null);
  const todayViewYRef = useRef(0);
  const blockPositionsRef = useRef({});
  const handleBlockLayout = useCallback((blockId, y) => {
    blockPositionsRef.current[blockId] = y;
  }, []);
  const jumpToBlock = useCallback((blockId) => {
    setSubView('today');
    // Defer one frame so the today view actually mounts if we just switched
    requestAnimationFrame(() => {
      const localY = blockPositionsRef.current[blockId] || 0;
      const baseY = todayViewYRef.current || 0;
      const target = Math.max(0, baseY + localY - 96);
      contentScrollRef.current?.scrollTo({ y: target, animated: true });
    });
  }, []);

  // Subscribe to discipline.alert notifications
  useEffect(() => {
    if (!subscribeEvent) return;
    const unsub = subscribeEvent('discipline.alert', (payload) => {
      const alert = {
        id: `alert-${Date.now()}`,
        ...payload,
        ts: Date.now(),
      };
      setDisciplineAlerts(prev => [alert, ...prev].slice(0, 10));
    });
    return unsub;
  }, [subscribeEvent]);

  const dismissAlert = useCallback((alert) => {
    setDisciplineAlerts(prev => prev.filter(a => a.id !== alert.id));
  }, []);

  // Derive day started state from today's blocks having any active logs
  const dayStarted = todayBlocks.length > 0;
  const dayEnded = !!(today?.endedAt);

  const handleStartDay = useCallback(async () => {
    setDayBusy(true);
    try {
      await startDay();
    } catch (err) {
      Alert.alert('Start Day failed', err?.message || String(err));
    } finally {
      setDayBusy(false);
    }
  }, [startDay]);

  const handleEndDay = useCallback(async () => {
    Alert.alert(
      'End the day?',
      'This will complete any active blocks and record your day score.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End Day', style: 'destructive',
          onPress: async () => {
            setDayBusy(true);
            try {
              await endDay();
            } catch (err) {
              Alert.alert('End Day failed', err?.message || String(err));
            } finally {
              setDayBusy(false);
            }
          },
        },
      ]
    );
  }, [endDay]);

  const handleShift = useCallback(async () => {
    setDayBusy(true);
    try {
      await shiftFromNow();
    } catch (err) {
      Alert.alert('Shift failed', err?.message || String(err));
    } finally {
      setDayBusy(false);
    }
  }, [shiftFromNow]);

  const handleComplete = useCallback(async (blockId) => {
    try {
      await markBlockComplete(blockId);
    } catch (err) {
      Alert.alert('Error', err?.message || String(err));
    }
  }, [markBlockComplete]);

  const handleUncomplete = useCallback(async (blockId) => {
    try {
      await unmarkBlockComplete(blockId);
    } catch (err) {
      Alert.alert('Error', err?.message || String(err));
    }
  }, [unmarkBlockComplete]);

  const openBlockDetail = useCallback((block) => {
    navigation?.navigate?.('DisciplineBlockDetail', { block, discipline, isNew: false });
  }, [navigation, discipline]);

  const openNewBlock = useCallback(() => {
    navigation?.navigate?.('DisciplineBlockDetail', { discipline, isNew: true });
  }, [navigation, discipline]);

  const openLog = useCallback(() => {
    navigation?.navigate?.('DisciplineLog', { discipline });
  }, [navigation, discipline]);

  const openSettings = useCallback(() => {
    navigation?.navigate?.('DisciplineSettings', { discipline });
  }, [navigation, discipline]);

  // ── Not supported fallback ──────────────────────────────────────────────

  if (supported === false) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack?.()}>
          <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <View style={styles.unsupportedCenter}>
          <MaterialCommunityIcons name="weight-lifter" size={56} color={COLORS.primary} />
          <Text style={styles.unsupportedTitle}>Discipline — Not Available</Text>
          <Text style={styles.unsupportedBody}>
            This gateway hasn't enabled the discipline service. Enable it from the web settings.
          </Text>
        </View>
      </View>
    );
  }

  // ── Loading skeleton ────────────────────────────────────────────────────

  if (supported === null && loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack?.()}>
            <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.heading}>Discipline</Text>
          <View style={{ width: 40 }} />
        </View>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }}>
          <Shimmer style={{ height: 64, borderRadius: 16 }} />
          <BlockSkeleton />
          <BlockSkeleton />
          <BlockSkeleton />
        </ScrollView>
      </View>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack?.()}>
          <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.heading}>Discipline</Text>
        <View style={styles.topBarRight}>
          <TouchableOpacity onPress={openLog} hitSlop={8}>
            <Ionicons name="time-outline" size={20} color={COLORS.primary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={openSettings} hitSlop={8}>
            <Ionicons name="settings-outline" size={20} color={COLORS.primary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Oversight stats */}
      <OversightRow
        today={today}
        week={week}
        completedSet={completedSet}
        todayBlocks={todayBlocks}
        alertCount={disciplineAlerts.length}
        onJumpToFirst={jumpToBlock}
      />

      {/* Day action bar */}
      <View style={{ paddingHorizontal: SPACING.lg, paddingBottom: SPACING.sm }}>
        <DayActionBar
          today={today}
          dayStarted={dayStarted}
          busy={dayBusy}
          onStart={handleStartDay}
          onEnd={handleEndDay}
          onShift={handleShift}
        />
      </View>

      {/* Sub-view tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBar}
        style={styles.tabBarOuter}
      >
        {SUBVIEWS.map(sv => (
          <TouchableOpacity
            key={sv.key}
            style={[styles.tab, subView === sv.key && styles.tabActive]}
            onPress={() => setSubView(sv.key)}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            activeOpacity={0.7}
          >
            <Ionicons
              name={sv.icon}
              size={11}
              color={subView === sv.key ? COLORS.primary : COLORS.textMuted}
            />
            <Text style={[styles.tabText, subView === sv.key && styles.tabTextActive]}>
              {sv.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Content */}
      <ScrollView
        ref={contentScrollRef}
        style={styles.content}
        contentContainerStyle={[
          styles.contentInner,
          { paddingBottom: insets.bottom + 80 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={COLORS.primary}
            colors={[COLORS.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {error ? (
          <GlassCard style={{ padding: SPACING.md }}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={refresh} style={{ marginTop: SPACING.sm }}>
              <Text style={{ color: COLORS.primary, ...FONTS.small }}>Retry</Text>
            </TouchableOpacity>
          </GlassCard>
        ) : null}

        {subView === 'today' ? (
          <View onLayout={(e) => { todayViewYRef.current = e.nativeEvent.layout.y; }}>
            <TodayView
              todayBlocks={todayBlocks}
              completedSet={completedSet}
              routineDoneSet={routineDoneSet}
              today={today}
              week={week}
              allEvents={allEvents}
              eventCounts={eventCounts}
              insights={insights}
              dayStart={dayStart}
              alerts={disciplineAlerts}
              onBlockPress={openBlockDetail}
              onComplete={handleComplete}
              onUncomplete={handleUncomplete}
              onToggleRoutine={toggleRoutineItem}
              onQuickLog={() => setShowQuickLog(true)}
              onBlockLayout={handleBlockLayout}
              dayStarted={dayStarted}
              dayEnded={dayEnded}
            />
          </View>
        ) : null}

        {subView === 'board' ? (
          <BoardView
            blocks={blocks}
            completedSet={completedSet}
            routineDoneSet={routineDoneSet}
            onBlockPress={openBlockDetail}
            onComplete={handleComplete}
            onUncomplete={handleUncomplete}
            onNewBlock={openNewBlock}
          />
        ) : null}

        {subView === 'list' ? (
          <ListView
            blocks={blocks}
            completedSet={completedSet}
            routineDoneSet={routineDoneSet}
            onBlockPress={openBlockDetail}
            onComplete={handleComplete}
            onUncomplete={handleUncomplete}
            onNewBlock={openNewBlock}
          />
        ) : null}

        {subView === 'log' ? (
          <View style={{ alignItems: 'center', paddingTop: SPACING.xl }}>
            <Ionicons name="time-outline" size={40} color={COLORS.textMuted} />
            <Text style={[styles.emptyBody, { marginTop: SPACING.sm }]}>
              Full history and heatmap
            </Text>
            <TouchableOpacity
              style={[styles.newBlockBtn, { marginTop: SPACING.md }]}
              onPress={openLog}
            >
              <Text style={styles.newBlockText}>Open Log Screen</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>

      {/* Quick-log modal */}
      <QuickLogModal
        visible={showQuickLog}
        blocks={todayBlocks}
        onClose={() => setShowQuickLog(false)}
        onSubmit={quickLog}
      />
    </View>
  );
}

export default DisciplineScreen;

// ── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { ...FONTS.small, color: COLORS.primary },
  heading: { ...FONTS.heading, color: COLORS.text, flex: 1, fontSize: 20 },
  topBarRight: { flexDirection: 'row', gap: SPACING.md, alignItems: 'center' },
  // Oversight (tight strip — taps jump to first matching block)
  oversightRow: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.xs,
    gap: SPACING.xs,
  },
  oversightStat: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  oversightVal: { ...FONTS.small, fontWeight: '700', fontSize: 12 },
  oversightLabel: { ...FONTS.tiny, color: COLORS.textMuted, fontSize: 9 },
  // Day bar
  dayBar: { padding: SPACING.md },
  dayBarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  dayBarLeft: { flex: 1, gap: 1 },
  dayBarStatus: { ...FONTS.small, color: COLORS.text, fontWeight: '600' },
  dayBarSub: { ...FONTS.tiny, color: COLORS.textMuted },
  dayBarActions: { flexDirection: 'row', gap: SPACING.sm, alignItems: 'center' },
  dayPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 99,
    minWidth: 96,
    justifyContent: 'center',
  },
  dayPillStart: { backgroundColor: COLORS.primary },
  dayPillEnd: { backgroundColor: '#EF4444' },
  dayPillText: { ...FONTS.small, color: '#000', fontWeight: '700' },
  shiftBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: COLORS.primary + '50',
  },
  shiftBtnText: { ...FONTS.tiny, color: COLORS.primary, fontWeight: '600' },
  // Tabs (slim — matches KanbanScreen project-chip density)
  tabBarOuter: { flexGrow: 0, maxHeight: 36 },
  tabBar: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.xs,
    gap: SPACING.xs,
    flexDirection: 'row',
    alignItems: 'center',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  tabActive: {
    backgroundColor: COLORS.primary + '18',
    borderColor: COLORS.primary + '60',
  },
  tabText: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontWeight: '600',
    fontSize: 10,
    letterSpacing: 0.3,
  },
  tabTextActive: { color: COLORS.primary },
  // Content
  content: { flex: 1 },
  contentInner: { padding: SPACING.lg, gap: 0 },
  // Section
  sectionHeading: {
    ...FONTS.mono,
    color: COLORS.primary,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: SPACING.sm,
    marginTop: SPACING.md,
  },
  autoStartedNote: {
    ...FONTS.tiny,
    color: '#10B981',
    fontWeight: '700',
    marginTop: -SPACING.xs,
    marginBottom: SPACING.sm,
  },
  cardLabel: {
    ...FONTS.mono,
    color: COLORS.primary,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  // Score card
  scoreCard: { padding: SPACING.md, gap: SPACING.xs },
  scoreRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md },
  scoreLeft: { flex: 1, gap: 2 },
  scorePct: { ...FONTS.heading, fontSize: 32, fontWeight: '800', lineHeight: 38 },
  scoreSub: { ...FONTS.tiny, color: COLORS.textMuted, lineHeight: 16 },
  scoreWeek: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
    height: 44,
    paddingTop: 4,
  },
  barWrap: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' },
  bar: { width: 8, borderRadius: 3, minHeight: 4 },
  savedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#10B98118',
    borderRadius: 99,
    borderWidth: 1,
    borderColor: '#10B98130',
  },
  savedText: { ...FONTS.tiny, color: '#10B981', fontWeight: '600' },
  // Counters
  countersGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  quickLogBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: SPACING.sm,
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.primary + '30',
    borderStyle: 'dashed',
    marginBottom: SPACING.sm,
  },
  quickLogText: { ...FONTS.small, color: COLORS.primary },
  // Board
  catHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: SPACING.xs,
    marginTop: SPACING.sm,
  },
  catDot: { width: 8, height: 8, borderRadius: 4 },
  catTitle: { ...FONTS.mono, fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  catCount: { ...FONTS.tiny, color: COLORS.textMuted, marginLeft: 'auto' },
  // List
  listControls: { gap: SPACING.sm, marginBottom: SPACING.sm },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingHorizontal: SPACING.sm,
  },
  listSearch: {
    flex: 1,
    ...FONTS.small,
    color: COLORS.text,
    paddingVertical: SPACING.sm,
  },
  sortRow: { flexDirection: 'row', gap: SPACING.xs },
  sortChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  sortChipActive: { backgroundColor: COLORS.primary + '18', borderColor: COLORS.primary + '60' },
  sortChipText: { ...FONTS.tiny, color: COLORS.textMuted, textTransform: 'capitalize' },
  sortChipTextActive: { color: COLORS.primary },
  // New block
  newBlockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: SPACING.sm,
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.primary + '40',
    borderStyle: 'dashed',
    marginBottom: SPACING.sm,
  },
  newBlockText: { ...FONTS.small, color: COLORS.primary, fontWeight: '600' },
  // Empty states
  emptyCard: {
    padding: SPACING.xl,
    alignItems: 'center',
    gap: SPACING.sm,
  },
  emptyTitle: { ...FONTS.heading, color: COLORS.text, fontSize: 18, textAlign: 'center' },
  emptyBody: {
    ...FONTS.small,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 300,
  },
  emptyText: {
    ...FONTS.small,
    color: COLORS.textMuted,
    textAlign: 'center',
    paddingVertical: SPACING.xl,
  },
  // Error
  errorText: { ...FONTS.small, color: COLORS.error },
  // Unsupported
  unsupportedCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
    gap: SPACING.md,
  },
  unsupportedTitle: {
    ...FONTS.heading,
    color: COLORS.text,
    fontSize: 20,
    textAlign: 'center',
  },
  unsupportedBody: {
    ...FONTS.small,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 340,
  },
});
