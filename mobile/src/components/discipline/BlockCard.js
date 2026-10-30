import React, { useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { COLORS, FONTS, SPACING } from '../../constants/theme';
import {
  CATEGORY_COLORS, CATEGORY_LABELS, minsToHHMM, humanDuration,
} from '../../hooks/useDiscipline';

const STATUS_COLORS = {
  'upcoming': COLORS.primaryLight,
  'starting-soon': COLORS.primaryMuted,
  'in-progress': 'rgba(16,185,129,0.18)',
  'overrunning': 'rgba(245,158,11,0.16)',
  'completed': 'rgba(34,211,238,0.12)',
  'missed': 'rgba(239,68,68,0.12)',
  'disabled': 'rgba(100,100,100,0.1)',
  'not-today': 'rgba(100,100,100,0.08)',
};

const STATUS_ACCENT = {
  'upcoming': COLORS.primary + '40',
  'starting-soon': COLORS.primary,
  'in-progress': '#10B981',
  'overrunning': '#F59E0B',
  'completed': '#22D3EE',
  'missed': '#EF4444',
  'disabled': '#444',
  'not-today': '#444',
};

const STATUS_LABELS = {
  'upcoming': 'Upcoming',
  'starting-soon': 'Soon',
  'in-progress': 'Active',
  'overrunning': 'Overrun',
  'completed': 'Done',
  'missed': 'Missed',
  'disabled': 'Off',
  'not-today': '',
};

// Insight tone → accent color (mirrors the web view).
const INSIGHT_TONE_COLOR = {
  info: COLORS.textSecondary,
  warn: '#F59E0B',
  urgent: '#EF4444',
  success: '#10B981',
};

/** Minutes elapsed inside the block right now (active/overrunning), else null. */
function liveElapsedMin(block, status) {
  if (status !== 'in-progress' && status !== 'overrunning') return null;
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes();
  return Math.max(0, nowMin - block.startMinute);
}

// ── Active progress bar ───────────────────────────────────────────────────
// Self-animating bar that fills as real time elapses inside the block's
// window. Drives the *remaining* duration into a single Animated.timing so
// the fill stays smooth without 1s re-renders.
function startMinuteToTodayMs(minute) {
  const d = new Date();
  d.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return d.getTime();
}

function ActiveProgressBar({ block, status, accentColor }) {
  const progress = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    // Past / terminal states: snap to a fixed value, no animation
    if (status === 'completed' || status === 'missed' || status === 'overrunning') {
      progress.setValue(1);
      return undefined;
    }
    if (status === 'upcoming' || status === 'starting-soon') {
      progress.setValue(0);
      return undefined;
    }
    if (status !== 'in-progress') {
      progress.setValue(0);
      return undefined;
    }

    const startMs = startMinuteToTodayMs(block.startMinute);
    const endMs = startMinuteToTodayMs(block.endMinute);
    const total = endMs - startMs;
    if (total <= 0) {
      progress.setValue(1);
      return undefined;
    }

    const now = Date.now();
    const initial = Math.max(0, Math.min(1, (now - startMs) / total));
    progress.setValue(initial);

    const remainingMs = Math.max(0, endMs - now);
    if (remainingMs <= 0) {
      progress.setValue(1);
      return undefined;
    }
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: remainingMs,
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [status, block.startMinute, block.endMinute, progress]);

  // Pulsing soft glow for the active state only
  useEffect(() => {
    if (status !== 'in-progress') {
      glow.setValue(0.6);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 1200, useNativeDriver: false }),
        Animated.timing(glow, { toValue: 0.55, duration: 1200, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [status, glow]);

  let fillColor;
  if (status === 'in-progress') fillColor = '#10B981';
  else if (status === 'completed') fillColor = '#22D3EE';
  else if (status === 'overrunning') fillColor = '#F59E0B';
  else if (status === 'missed') fillColor = '#EF4444';
  else fillColor = (accentColor || COLORS.primary) + '60';

  const width = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={progressStyles.track}>
      <Animated.View
        style={[
          progressStyles.fill,
          {
            width,
            backgroundColor: fillColor,
            shadowColor: fillColor,
            shadowOpacity: status === 'in-progress' ? glow : 0,
            shadowRadius: 6,
          },
        ]}
      />
    </View>
  );
}

const progressStyles = StyleSheet.create({
  track: {
    height: 4,
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 2,
  },
  fill: {
    height: '100%',
    borderRadius: 3,
    shadowOffset: { width: 0, height: 0 },
  },
});

function PulseRing({ active }) {
  const anim = useRef(new Animated.Value(0.8)).current;
  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.8, duration: 1000, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [active, anim]);

  if (!active) return null;
  return (
    <Animated.View
      style={[
        styles.pulse,
        {
          borderColor: '#10B981',
          opacity: anim,
          transform: [{ scale: anim }],
        },
      ]}
    />
  );
}

export function BlockCard({
  block,
  status,
  routineDoneSet,
  onComplete,
  onUncomplete,
  onToggleRoutine,
  onPress,
  insight,
  compact = false,
}) {
  const catColor = CATEGORY_COLORS[block.category] || COLORS.primary;
  const accentColor = STATUS_ACCENT[status] || COLORS.primary;
  const bgColor = STATUS_COLORS[status] || STATUS_COLORS.upcoming;
  const statusLabel = STATUS_LABELS[status] || '';
  const duration = block.endMinute - block.startMinute;
  const isActive = status === 'in-progress';
  const isDone = status === 'completed';
  const isMissed = status === 'missed';
  const isOverrunning = status === 'overrunning';
  const showProgressBar =
    status === 'in-progress' || status === 'overrunning' ||
    status === 'completed' || status === 'missed';

  const scaleAnim = useRef(new Animated.Value(1)).current;
  const onPressIn = () => Animated.spring(scaleAnim, { toValue: 0.97, useNativeDriver: true, tension: 200 }).start();
  const onPressOut = () => Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 200 }).start();

  const completedItems = block.routineItems?.filter(item =>
    routineDoneSet?.has(`${block.id}:${item.id}`)
  ).length || 0;
  const totalItems = block.routineItems?.length || 0;
  const routineProgress = totalItems > 0 ? completedItems / totalItems : null;

  const elapsedMin = liveElapsedMin(block, status);
  const insightTone = insight
    ? (INSIGHT_TONE_COLOR[insight.tone] || INSIGHT_TONE_COLOR.info)
    : INSIGHT_TONE_COLOR.info;

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <Pressable
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={[
          styles.card,
          { backgroundColor: bgColor, borderColor: accentColor + '60' },
          isActive && styles.cardActive,
        ]}
      >
        {/* Left accent bar */}
        <View style={[styles.accentBar, { backgroundColor: catColor }]} />
        <PulseRing active={isActive} />

        <View style={styles.content}>
          {/* Top row */}
          <View style={styles.topRow}>
            <View style={styles.labelGroup}>
              <Text style={[styles.label, isDone && styles.labelDone]} numberOfLines={1}>
                {block.label}
              </Text>
              <View style={styles.metaRow}>
                <Text style={[styles.catPill, { color: catColor }]}>
                  {CATEGORY_LABELS[block.category] || block.category}
                </Text>
                <Text style={styles.timeText}>
                  {minsToHHMM(block.startMinute)} – {minsToHHMM(block.endMinute)}
                </Text>
                <Text style={styles.durText}>{humanDuration(duration)}</Text>
              </View>
            </View>

            {/* Status badge */}
            {statusLabel ? (
              <View style={[styles.statusBadge, { borderColor: accentColor }]}>
                <Text style={[styles.statusText, { color: accentColor }]}>{statusLabel}</Text>
              </View>
            ) : null}
          </View>

          {/* Proactive insight — contextual headline + action chip + live elapsed.
              Same engine as web (discipline.insights RPC). */}
          {!compact && (insight || elapsedMin != null) ? (
            <View style={[styles.insight, { borderLeftColor: insightTone }]}>
              {elapsedMin != null ? (
                <Text style={styles.insightElapsed}>
                  <Ionicons name="play" size={9} color="#10B981" /> {elapsedMin >= 60 ? `${Math.floor(elapsedMin / 60)}h ${elapsedMin % 60}m` : `${elapsedMin}m`} elapsed
                </Text>
              ) : null}
              {insight ? (
                <>
                  <Text style={[styles.insightHeadline, { color: insightTone }]} numberOfLines={3}>
                    {insight.headline}
                  </Text>
                  <View style={styles.insightRow}>
                    <View style={[styles.insightChip, { borderColor: insightTone }]}>
                      <Text style={[styles.insightChipText, { color: insightTone }]}>
                        ↳ {insight.suggestedAction}
                      </Text>
                    </View>
                    {(insight.references || []).slice(0, 2).map((r, i) => (
                      <View key={i} style={styles.insightRef}>
                        <Text style={styles.insightRefText} numberOfLines={1}>{r.label}</Text>
                      </View>
                    ))}
                  </View>
                </>
              ) : null}
            </View>
          ) : null}

          {/* Intent / notes */}
          {!compact && block.intent ? (
            <Text style={styles.intent} numberOfLines={2}>{block.intent}</Text>
          ) : null}

          {/* Time-elapsed progress bar (active / completed / overrunning / missed) */}
          {showProgressBar ? (
            <ActiveProgressBar
              block={block}
              status={status}
              accentColor={catColor}
            />
          ) : null}

          {/* Routine progress bar */}
          {!compact && routineProgress !== null ? (
            <View style={styles.routineRow}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${routineProgress * 100}%`, backgroundColor: catColor }]} />
              </View>
              <Text style={styles.routineText}>{completedItems}/{totalItems}</Text>
            </View>
          ) : null}

          {/* Bottom actions */}
          {!compact && !isDone && !isMissed ? (
            <View style={styles.actions}>
              {(status === 'in-progress' || status === 'starting-soon' || isOverrunning) ? (
                <TouchableOpacity
                  style={[
                    styles.actionBtn,
                    { borderColor: isOverrunning ? '#F59E0B' : '#10B981' },
                  ]}
                  onPress={() => onComplete?.(block.id)}
                >
                  <Ionicons
                    name="checkmark-circle-outline"
                    size={14}
                    color={isOverrunning ? '#F59E0B' : '#10B981'}
                  />
                  <Text
                    style={[
                      styles.actionText,
                      { color: isOverrunning ? '#F59E0B' : '#10B981' },
                    ]}
                  >
                    {isOverrunning ? 'Complete late' : 'Complete'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          {/* Completed actions */}
          {!compact && isDone ? (
            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.actionBtn, { borderColor: COLORS.textMuted }]}
                onPress={() => onUncomplete?.(block.id)}
              >
                <Ionicons name="close-circle-outline" size={14} color={COLORS.textMuted} />
                <Text style={[styles.actionText, { color: COLORS.textMuted }]}>Undo</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {/* Non-negotiable flag */}
          {block.nonNegotiable ? (
            <View style={styles.nnBadge}>
              <Ionicons name="lock-closed" size={9} color="#EF4444" />
              <Text style={styles.nnText}>Non-negotiable</Text>
            </View>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: SPACING.sm,
    flexDirection: 'row',
    overflow: 'hidden',
    position: 'relative',
  },
  cardActive: {
    borderColor: '#10B981',
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
  },
  accentBar: {
    width: 3,
    borderRadius: 2,
    margin: 4,
    marginRight: 0,
  },
  pulse: {
    position: 'absolute',
    inset: -1,
    borderRadius: 14,
    borderWidth: 1.5,
    pointerEvents: 'none',
  },
  content: {
    flex: 1,
    padding: SPACING.sm,
    paddingLeft: SPACING.md,
    gap: 6,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  labelGroup: { flex: 1, gap: 2 },
  label: {
    ...FONTS.regular,
    color: COLORS.text,
    fontWeight: '600',
    fontSize: 14,
  },
  labelDone: { textDecorationLine: 'line-through', color: COLORS.textMuted },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  catPill: { ...FONTS.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  timeText: { ...FONTS.tiny, color: COLORS.textMuted },
  durText: { ...FONTS.tiny, color: COLORS.textSecondary, fontWeight: '600' },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 99,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  statusText: { ...FONTS.tiny, fontWeight: '700', letterSpacing: 0.5 },
  intent: { ...FONTS.small, color: COLORS.textSecondary, lineHeight: 18 },
  insight: {
    borderLeftWidth: 2,
    paddingLeft: 8,
    paddingVertical: 4,
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 4,
  },
  insightElapsed: { ...FONTS.tiny, color: '#10B981', fontWeight: '700', fontSize: 10 },
  insightHeadline: { ...FONTS.small, fontWeight: '600', lineHeight: 17 },
  insightRow: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  insightChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 99,
    borderWidth: 1,
  },
  insightChipText: { ...FONTS.tiny, fontWeight: '700', fontSize: 10 },
  insightRef: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  insightRefText: { ...FONTS.tiny, color: COLORS.textMuted, fontSize: 10, maxWidth: 120 },
  routineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  progressTrack: {
    flex: 1,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 2 },
  routineText: { ...FONTS.tiny, color: COLORS.textMuted, minWidth: 24 },
  actions: { flexDirection: 'row', gap: SPACING.sm },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
    borderWidth: 1,
  },
  actionText: { ...FONTS.tiny, fontWeight: '700' },
  nnBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    alignSelf: 'flex-start',
  },
  nnText: { ...FONTS.tiny, color: '#EF4444', fontSize: 9 },
});
