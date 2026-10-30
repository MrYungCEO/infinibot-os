import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, FlatList,
  TextInput, RefreshControl, ActivityIndicator, Modal, KeyboardAvoidingView,
  Platform, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, FONTS, SPACING } from '../../constants/theme';
import { GlassCard } from '../../components/GlassCard';
import {
  CATEGORY_COLORS, CATEGORY_LABELS, DISCIPLINE_CATEGORIES, humanDuration,
} from '../../hooks/useDiscipline';

const RANGE_OPTS = [
  { label: 'Today', days: 0 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

function formatTs(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function isoToMs(iso) {
  return new Date(iso + 'T00:00:00').getTime();
}

// Heatmap cell: intensity 0–4
function HeatCell({ intensity }) {
  const LEVELS = [
    'rgba(255,255,255,0.04)',
    COLORS.primaryLight,
    COLORS.primaryStrong,
    COLORS.glowStrong,
    COLORS.glowStrong,
  ];
  return <View style={[styles.heatCell, { backgroundColor: LEVELS[Math.min(4, intensity)] }]} />;
}

function Heatmap({ week }) {
  // Build last 12 weeks of grid data
  const today = new Date();
  const cells = [];
  for (let i = 83; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const day = week?.find(w => w.date === iso);
    const pct = day?.compliance || 0;
    const intensity = pct >= 80 ? 4 : pct >= 60 ? 3 : pct >= 40 ? 2 : pct >= 10 ? 1 : 0;
    cells.push({ iso, intensity, pct });
  }

  // Group into weeks (columns of 7)
  const cols = [];
  for (let i = 0; i < cells.length; i += 7) {
    cols.push(cells.slice(i, i + 7));
  }

  return (
    <View style={styles.heatmap}>
      <View style={styles.heatGrid}>
        {cols.map((col, ci) => (
          <View key={ci} style={styles.heatCol}>
            {col.map((cell, ri) => (
              <HeatCell key={cell.iso} intensity={cell.intensity} />
            ))}
          </View>
        ))}
      </View>
      <View style={styles.heatLegend}>
        <Text style={styles.heatLegendLabel}>Less</Text>
        {[0, 1, 2, 3, 4].map(l => <HeatCell key={l} intensity={l} />)}
        <Text style={styles.heatLegendLabel}>More</Text>
      </View>
    </View>
  );
}

function LogEntry({ entry, blocks }) {
  const block = blocks?.find(b => b.id === entry.blockId);
  const catColor = CATEGORY_COLORS[entry.category] || COLORS.textMuted;
  const durationMs = entry.endMs ? entry.endMs - entry.startMs : null;
  const durationMins = durationMs ? Math.round(durationMs / 60000) : null;

  const SOURCE_ICONS = {
    planned: 'calendar',
    probe: 'radio-button-on',
    manual: 'hand-right',
    abort: 'close-circle',
  };

  return (
    <View style={styles.logRow}>
      <View style={[styles.logDot, { backgroundColor: catColor }]} />
      <View style={styles.logBody}>
        <Text style={styles.logLabel} numberOfLines={1}>{entry.label}</Text>
        {block ? (
          <Text style={[styles.logBlock, { color: catColor }]} numberOfLines={1}>
            {block.label}
          </Text>
        ) : null}
      </View>
      <View style={styles.logMeta}>
        {durationMins ? (
          <Text style={styles.logDur}>{humanDuration(durationMins)}</Text>
        ) : null}
        <Text style={styles.logTs}>{formatTs(entry.startMs)}</Text>
        <Ionicons
          name={SOURCE_ICONS[entry.source] || 'ellipse'}
          size={10}
          color={COLORS.textMuted}
        />
      </View>
    </View>
  );
}

export function DisciplineLogScreen({ navigation, route }) {
  const { discipline } = route.params || {};
  const {
    logs, week, blocks, loadHistory, loading, quickLog, todayBlocks, nowMin,
  } = discipline || {};

  const insets = useSafeAreaInsets();
  const [range, setRange] = useState(RANGE_OPTS[0]);
  const [historyLogs, setHistoryLogs] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [search, setSearch] = useState('');

  // Quick-log sheet state. The sheet's "active block" default is computed when
  // the sheet opens so the typical case ("I just spent 15 min on the current
  // block") is two taps: + → Save. Category seeds from the active block too.
  const [logSheet, setLogSheet] = useState({
    open: false,
    label: '',
    category: 'personal',
    blockId: null,
    note: '',
    saving: false,
  });
  const labelInputRef = useRef(null);

  // Best-guess "currently active block" from the day's schedule so the FAB can
  // pre-fill the sheet without requiring a server round-trip. Falls back to
  // null off-hours, which leaves the sheet's category at "personal".
  const activeBlock = React.useMemo(() => {
    if (!Array.isArray(todayBlocks) || typeof nowMin !== 'number') return null;
    return (
      todayBlocks.find(
        (b) => b?.enabled !== false && b.startMinute <= nowMin && b.endMinute > nowMin,
      ) || null
    );
  }, [todayBlocks, nowMin]);

  const openLogSheet = useCallback(() => {
    setLogSheet({
      open: true,
      label: '',
      category: activeBlock?.category || 'personal',
      blockId: activeBlock?.id || null,
      note: '',
      saving: false,
    });
    // Defer focus so the modal mounts before we grab the input.
    setTimeout(() => labelInputRef.current?.focus?.(), 120);
  }, [activeBlock]);

  const closeLogSheet = useCallback(() => {
    setLogSheet((s) => ({ ...s, open: false }));
  }, []);

  const submitLogSheet = useCallback(async () => {
    const label = logSheet.label.trim();
    if (!label) {
      Alert.alert('Add a label', 'Tell future-you what just happened.');
      return;
    }
    if (typeof quickLog !== 'function') {
      Alert.alert('Not connected', 'Reconnect to the gateway to log events.');
      return;
    }
    setLogSheet((s) => ({ ...s, saving: true }));
    try {
      await quickLog({
        label,
        category: logSheet.category,
        blockId: logSheet.blockId || undefined,
        note: logSheet.note.trim() || undefined,
      });
      setLogSheet((s) => ({ ...s, open: false, saving: false }));
      // Refresh the current range so the new entry shows immediately when the
      // user is looking at "Today" (the hook's `logs` updates optimistically
      // already, but multi-day ranges read from `historyLogs`).
      if (range.days !== 0) {
        await loadRange();
      }
    } catch (e) {
      setLogSheet((s) => ({ ...s, saving: false }));
      Alert.alert('Failed to log', String(e?.message || e));
    }
  }, [logSheet, quickLog, range.days]);

  const loadRange = useCallback(async () => {
    if (!loadHistory) return;
    setHistoryLoading(true);
    try {
      const now = Date.now();
      const sinceMs = range.days === 0
        ? isoToMs(new Date().toISOString().slice(0, 10))
        : now - range.days * 86_400_000;
      const entries = await loadHistory({ sinceMs, untilMs: now, limit: 500 });
      setHistoryLogs(entries);
    } finally {
      setHistoryLoading(false);
    }
  }, [loadHistory, range]);

  useEffect(() => { loadRange(); }, [loadRange]);

  const displayLogs = (range.days === 0 ? (logs || []) : historyLogs)
    .filter(e => {
      if (!search) return true;
      const q = search.toLowerCase();
      return e.label?.toLowerCase().includes(q) || e.note?.toLowerCase().includes(q);
    });

  // Group by date for multi-day ranges
  const grouped = React.useMemo(() => {
    if (range.days === 0) return null; // single-day: flat list
    const map = new Map();
    for (const entry of displayLogs) {
      const dateKey = new Date(entry.startMs).toISOString().slice(0, 10);
      if (!map.has(dateKey)) map.set(dateKey, []);
      map.get(dateKey).push(entry);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a));
  }, [displayLogs, range.days]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack?.()}>
          <Ionicons name="chevron-back" size={20} color={COLORS.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.heading}>Activity Log</Text>
        {(historyLoading || loading) ? (
          <ActivityIndicator size="small" color={COLORS.primary} />
        ) : (
          <TouchableOpacity onPress={loadRange} hitSlop={8}>
            <Ionicons name="refresh" size={18} color={COLORS.primary} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Heatmap */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardLabel}>12-week compliance</Text>
          <Heatmap week={week} />
        </GlassCard>

        {/* Range filter */}
        <View style={styles.rangeRow}>
          {RANGE_OPTS.map(opt => (
            <TouchableOpacity
              key={opt.label}
              style={[styles.rangeChip, range.label === opt.label && styles.rangeChipActive]}
              onPress={() => setRange(opt)}
            >
              <Text style={[styles.rangeChipText, range.label === opt.label && styles.rangeChipTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Search */}
        <View style={styles.searchRow}>
          <Ionicons name="search" size={16} color={COLORS.textMuted} style={{ marginLeft: SPACING.sm }} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search events…"
            placeholderTextColor={COLORS.textMuted}
            value={search}
            onChangeText={setSearch}
          />
          {search ? (
            <TouchableOpacity onPress={() => setSearch('')} hitSlop={8} style={{ marginRight: SPACING.sm }}>
              <Ionicons name="close-circle" size={16} color={COLORS.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Log list */}
        {historyLoading ? (
          <ActivityIndicator color={COLORS.primary} style={{ marginTop: SPACING.xl }} />
        ) : displayLogs.length === 0 ? (
          <Text style={styles.emptyText}>No events for this period.</Text>
        ) : grouped ? (
          grouped.map(([date, entries]) => (
            <GlassCard key={date} style={styles.card}>
              <Text style={styles.dateHeader}>
                {new Date(date + 'T00:00:00').toLocaleDateString([], {
                  weekday: 'short', month: 'short', day: 'numeric',
                })}
                <Text style={styles.dateCount}> · {entries.length} events</Text>
              </Text>
              {entries.map((entry, i) => (
                <LogEntry key={entry.id || i} entry={entry} blocks={blocks} />
              ))}
            </GlassCard>
          ))
        ) : (
          <GlassCard style={styles.card}>
            {displayLogs.length === 0 ? (
              <View style={{ alignItems: 'center', gap: SPACING.sm }}>
                <Text style={styles.emptyText}>No events logged today yet.</Text>
                <TouchableOpacity
                  onPress={openLogSheet}
                  style={styles.emptyCta}
                  hitSlop={8}
                >
                  <Ionicons name="add-circle" size={16} color={COLORS.primary} />
                  <Text style={styles.emptyCtaText}>Log your first event</Text>
                </TouchableOpacity>
              </View>
            ) : (
              displayLogs.map((entry, i) => (
                <LogEntry key={entry.id || i} entry={entry} blocks={blocks} />
              ))
            )}
          </GlassCard>
        )}
      </ScrollView>

      {/* Floating action button — primary entry point for logging on mobile.
          Pinned bottom-right so it's always thumb-reachable while scrolling
          the history. Pulls active-block context into the sheet defaults. */}
      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 20 }]}
        onPress={openLogSheet}
        activeOpacity={0.85}
        accessibilityLabel="Log discipline event"
      >
        <Ionicons name="add" size={28} color="#000" />
      </TouchableOpacity>

      {/* Quick-log sheet. Single screen, minimal fields, defaults wired to
          active block so the common case is: tap FAB → type → tap Save. */}
      <Modal
        visible={logSheet.open}
        animationType="slide"
        transparent
        onRequestClose={closeLogSheet}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetBackdrop}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={closeLogSheet}
          />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.lg }]}>
            <View style={styles.sheetGrabber} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Log event</Text>
              <TouchableOpacity onPress={closeLogSheet} hitSlop={8}>
                <Ionicons name="close" size={22} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>

            {activeBlock ? (
              <View style={styles.sheetActiveHint}>
                <View
                  style={[
                    styles.sheetActiveDot,
                    { backgroundColor: CATEGORY_COLORS[activeBlock.category] || COLORS.primary },
                  ]}
                />
                <Text style={styles.sheetActiveText} numberOfLines={1}>
                  Active block: {activeBlock.label}
                </Text>
              </View>
            ) : null}

            <Text style={styles.sheetFieldLabel}>What happened?</Text>
            <TextInput
              ref={labelInputRef}
              value={logSheet.label}
              onChangeText={(v) => setLogSheet((s) => ({ ...s, label: v }))}
              placeholder={
                activeBlock
                  ? `e.g. Drafted PR for ${activeBlock.label}`
                  : 'Short description…'
              }
              placeholderTextColor={COLORS.textMuted}
              style={styles.sheetInput}
              returnKeyType="done"
              onSubmitEditing={submitLogSheet}
              autoCorrect
              maxLength={200}
            />

            <Text style={styles.sheetFieldLabel}>Category</Text>
            <View style={styles.catRow}>
              {DISCIPLINE_CATEGORIES.map((c) => {
                const selected = c === logSheet.category;
                const color = CATEGORY_COLORS[c] || COLORS.textMuted;
                return (
                  <TouchableOpacity
                    key={c}
                    onPress={() => setLogSheet((s) => ({ ...s, category: c }))}
                    style={[
                      styles.catChip,
                      selected && { borderColor: color, backgroundColor: color + '24' },
                    ]}
                  >
                    <View style={[styles.catChipDot, { backgroundColor: color }]} />
                    <Text
                      style={[
                        styles.catChipText,
                        selected && { color: color, fontWeight: '700' },
                      ]}
                    >
                      {CATEGORY_LABELS[c]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.sheetFieldLabel}>Note (optional)</Text>
            <TextInput
              value={logSheet.note}
              onChangeText={(v) => setLogSheet((s) => ({ ...s, note: v }))}
              placeholder="Anything to remember about it?"
              placeholderTextColor={COLORS.textMuted}
              style={[styles.sheetInput, { minHeight: 60 }]}
              multiline
              maxLength={500}
            />

            <TouchableOpacity
              onPress={submitLogSheet}
              disabled={logSheet.saving || !logSheet.label.trim()}
              style={[
                styles.sheetSave,
                (logSheet.saving || !logSheet.label.trim()) && styles.sheetSaveDisabled,
              ]}
              activeOpacity={0.85}
            >
              {logSheet.saving ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Text style={styles.sheetSaveText}>Save</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

export default DisciplineLogScreen;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { ...FONTS.small, color: COLORS.primary },
  heading: { ...FONTS.heading, color: COLORS.text, flex: 1, textAlign: 'center' },
  scrollContent: { padding: SPACING.lg, gap: SPACING.md },
  card: { padding: SPACING.lg, gap: SPACING.sm },
  cardLabel: {
    ...FONTS.mono,
    color: COLORS.primary,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: SPACING.xs,
  },
  rangeRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  rangeChip: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    alignItems: 'center',
  },
  rangeChipActive: {
    backgroundColor: COLORS.primary + '18',
    borderColor: COLORS.primary,
  },
  rangeChipText: { ...FONTS.small, color: COLORS.textMuted, fontWeight: '600' },
  rangeChipTextActive: { color: COLORS.primary },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    overflow: 'hidden',
  },
  searchInput: {
    flex: 1,
    ...FONTS.small,
    color: COLORS.text,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
  },
  emptyText: {
    ...FONTS.small,
    color: COLORS.textMuted,
    textAlign: 'center',
    paddingVertical: SPACING.xl,
  },
  logRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
    gap: SPACING.sm,
  },
  logDot: { width: 6, height: 6, borderRadius: 3, marginTop: 6 },
  logBody: { flex: 1, gap: 1 },
  logLabel: { ...FONTS.small, color: COLORS.text, lineHeight: 18 },
  logBlock: { ...FONTS.tiny, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  logMeta: { alignItems: 'flex-end', gap: 2 },
  logDur: { ...FONTS.tiny, color: COLORS.primary, fontWeight: '600' },
  logTs: { ...FONTS.tiny, color: COLORS.textMuted },
  dateHeader: { ...FONTS.small, color: COLORS.text, fontWeight: '700', marginBottom: SPACING.xs },
  dateCount: { ...FONTS.tiny, color: COLORS.textMuted, fontWeight: '400' },
  // Heatmap
  heatmap: { gap: SPACING.xs },
  heatGrid: { flexDirection: 'row', gap: 3 },
  heatCol: { gap: 3 },
  heatCell: { width: 12, height: 12, borderRadius: 2 },
  heatLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    alignSelf: 'flex-end',
    marginTop: 4,
  },
  heatLegendLabel: { ...FONTS.tiny, color: COLORS.textMuted, fontSize: 9 },

  // Empty-state CTA
  emptyCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary + '55',
    backgroundColor: COLORS.primary + '12',
  },
  emptyCtaText: { ...FONTS.small, color: COLORS.primary, fontWeight: '700' },

  // FAB
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },

  // Sheet
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0f0f12',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: SPACING.lg,
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: SPACING.sm,
  },
  sheetGrabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginBottom: SPACING.sm,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: { ...FONTS.heading, color: COLORS.text },
  sheetActiveHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  sheetActiveDot: { width: 8, height: 8, borderRadius: 4 },
  sheetActiveText: { ...FONTS.tiny, color: COLORS.textMuted, flex: 1 },
  sheetFieldLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: SPACING.xs,
  },
  sheetInput: {
    ...FONTS.body,
    color: COLORS.text,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  catRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  catChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  catChipDot: { width: 7, height: 7, borderRadius: 3.5 },
  catChipText: { ...FONTS.tiny, color: COLORS.textMuted },
  sheetSave: {
    marginTop: SPACING.md,
    backgroundColor: COLORS.primary,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  sheetSaveDisabled: { opacity: 0.5 },
  sheetSaveText: { ...FONTS.body, color: '#000', fontWeight: '700' },
});
