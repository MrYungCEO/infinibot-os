// AutonomyScreen — glass-morphism revamp.
//
// Mirrors the section hierarchy of the WebUI counterpart (ui/src/ui/views/autonomy.ts):
//   header status pill · 4-up stat row · CURRENT TASK · SYSTEM STATUS ·
//   PENDING TASKS · RECENTLY COMPLETED · AUDIT LOG
//
// Every panel sits inside a GlassCard so the ambient background bleeds
// through. Single accent (theme primary / gold) is reserved for active
// states and primary CTAs.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, SPACING, FONTS } from '../constants/theme';
import { GlassCard } from '../components/GlassCard';
import { withAlpha } from '../theme/color-utils';

// ─── Color helpers ────────────────────────────────────────────────────────────

function getPriorityColor(priority) {
  switch (priority) {
    case 'critical': return '#ef4444';
    case 'high':     return '#f97316';
    case 'normal':   return COLORS.primary;
    case 'low':      return COLORS.textMuted;
    default:         return COLORS.textTertiary;
  }
}

function loadColor(pct) {
  if (!Number.isFinite(pct)) return COLORS.textMuted;
  if (pct >= 85) return COLORS.error;
  if (pct >= 70) return COLORS.warning;
  return COLORS.success;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms) return '0s';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function formatAuditTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60000) return 'just now';
  if (diffMs < 3600000) return `${Math.round(diffMs / 60000)}m`;
  if (diffMs < 86400000) return `${Math.round(diffMs / 3600000)}h`;
  return date.toLocaleDateString();
}

const AUDIT_LABELS = {
  task_started: 'Task Started',
  task_completed: 'Task Done',
  task_failed: 'Task Failed',
  task_queued: 'Task Queued',
  file_read: 'File Read',
  file_write: 'File Write',
  exec_command: 'Command',
  api_call: 'API Call',
  notification_sent: 'Notification',
  pause_activated: 'Paused',
  pause_deactivated: 'Resumed',
  cage_interference_detected: 'Cage Alert',
  autonomous_action: 'Auto Action',
  hardware_check: 'Hardware Check',
  system_event: 'System Event',
};

const AUDIT_ICONS = {
  task_started: 'play-circle-outline',
  task_completed: 'checkmark-circle-outline',
  task_failed: 'close-circle-outline',
  task_queued: 'list-outline',
  file_read: 'document-text-outline',
  file_write: 'create-outline',
  exec_command: 'terminal-outline',
  api_call: 'globe-outline',
  notification_sent: 'notifications-outline',
  pause_activated: 'pause-circle-outline',
  pause_deactivated: 'play-circle-outline',
  cage_interference_detected: 'warning-outline',
  autonomous_action: 'flash-outline',
  hardware_check: 'hardware-chip-outline',
  system_event: 'settings-outline',
};

function formatAuditAction(actionType) {
  return AUDIT_LABELS[actionType] || actionType;
}

function getAuditIcon(actionType) {
  return AUDIT_ICONS[actionType] || 'ellipse-outline';
}

function auditColor(outcome) {
  if (outcome === 'failure') return COLORS.error;
  if (outcome === 'warning') return COLORS.warning;
  return COLORS.success;
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function SectionHeader({ glyph, label, right }) {
  return (
    <View style={styles.sectionHeaderRow}>
      <Text style={styles.sectionHeaderText}>
        {glyph ? <Text style={styles.sectionGlyph}>{glyph}  </Text> : null}
        {label}
      </Text>
      {right ? <View style={styles.sectionHeaderRight}>{right}</View> : null}
    </View>
  );
}

function ProgressBar({ pct, color, style }) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const fill = color || loadColor(clamped);
  return (
    <View style={[styles.barTrack, style]}>
      <View style={[styles.barFill, { width: `${clamped}%`, backgroundColor: fill }]} />
    </View>
  );
}

function Led({ color, glow = true, size = 8 }) {
  return (
    <View
      style={[
        styles.led,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          ...(glow
            ? {
                shadowColor: color,
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: 0.7,
                shadowRadius: 5,
                elevation: 4,
              }
            : null),
        },
      ]}
    />
  );
}

function PulsingLed({ color }) {
  const opacity = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[
        styles.led,
        {
          width: 9,
          height: 9,
          borderRadius: 5,
          backgroundColor: color,
          opacity,
          shadowColor: color,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.8,
          shadowRadius: 6,
          elevation: 5,
        },
      ]}
    />
  );
}

// Press-scale wrapper — gives every interactive card the same soft press feel.
function PressableScale({ onPress, disabled, children, style }) {
  const scale = useRef(new Animated.Value(1)).current;
  const onIn = () => Animated.spring(scale, { toValue: 0.98, useNativeDriver: true, speed: 30, bounciness: 4 }).start();
  const onOut = () => Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 4 }).start();
  return (
    <TouchableOpacity
      onPress={onPress}
      onPressIn={onIn}
      onPressOut={onOut}
      activeOpacity={0.9}
      disabled={disabled}
    >
      <Animated.View style={[{ transform: [{ scale }] }, style]}>
        {children}
      </Animated.View>
    </TouchableOpacity>
  );
}

// ─── Stat / Activity / Tag sub-components ─────────────────────────────────────

function StatCard({ icon, iconColor, label, value, subtext, accent }) {
  return (
    <View style={styles.statCard}>
      <View
        style={[
          styles.statIconWrap,
          {
            backgroundColor: withAlpha(iconColor || COLORS.primary, 0.14),
            borderColor: withAlpha(iconColor || COLORS.primary, 0.28),
          },
        ]}
      >
        <Ionicons name={icon} size={16} color={iconColor || COLORS.primary} />
      </View>
      <Text style={[styles.statValue, accent ? { color: accent } : null]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
      {subtext ? <Text style={styles.statSubtext} numberOfLines={1}>{subtext}</Text> : null}
    </View>
  );
}

function ActivityProgressRow({ label, pct, suffix }) {
  const has = Number.isFinite(pct);
  const color = has ? loadColor(pct) : COLORS.textMuted;
  return (
    <View style={styles.actProgressRow}>
      <Text style={styles.actProgressLabel}>{label}</Text>
      <View style={styles.actProgressBarWrap}>
        <ProgressBar pct={has ? pct : 0} color={color} />
      </View>
      <Text style={[styles.actProgressVal, { color }]}>
        {has ? `${pct.toFixed(0)}%` : '—'}
        {suffix ? <Text style={styles.actProgressSuffix}>  {suffix}</Text> : null}
      </Text>
    </View>
  );
}

function ActivityKeyValueRow({ label, value, valueColor, leftIcon, leftIconColor }) {
  return (
    <View style={styles.actKvRow}>
      <View style={styles.actKvLeft}>
        {leftIcon ? (
          <Ionicons name={leftIcon} size={12} color={leftIconColor || COLORS.textMuted} style={{ marginRight: 6 }} />
        ) : null}
        <Text style={styles.actProgressLabel}>{label}</Text>
      </View>
      <Text style={[styles.actKvVal, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

function PriorityChip({ priority }) {
  if (!priority) return null;
  const color = getPriorityColor(priority);
  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: withAlpha(color, 0.14),
          borderColor: withAlpha(color, 0.35),
        },
      ]}
    >
      <Text style={[styles.chipText, { color }]} numberOfLines={1}>
        {String(priority).toUpperCase()}
      </Text>
    </View>
  );
}

function Tag({ icon, label, color }) {
  const tint = color || COLORS.textMuted;
  return (
    <View
      style={[
        styles.tag,
        {
          backgroundColor: withAlpha(tint, 0.10),
          borderColor: withAlpha(tint, 0.25),
        },
      ]}
    >
      {icon ? (
        <Ionicons name={icon} size={10} color={tint} style={{ marginRight: 4 }} />
      ) : null}
      <Text style={[styles.tagText, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function AutonomyScreen({ gateway, navigation }) {
  const insets = useSafeAreaInsets();
  const { status: connStatus, sendReq } = gateway || {};
  const connected = connStatus === 'connected';
  const sendRequest = sendReq;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const loadStatus = useCallback(async () => {
    if (!connected) return;
    try {
      const result = await sendRequest('autonomy:status', {});
      setStatus(result);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [connected, sendRequest]);

  useEffect(() => {
    if (connected) {
      loadStatus();
      const interval = setInterval(loadStatus, 30000);
      return () => clearInterval(interval);
    }
  }, [connected, loadStatus]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadStatus();
  }, [loadStatus]);

  // ── Handlers (preserved verbatim) ──────────────────────────────────────────

  const handlePause = async () => {
    Alert.prompt(
      'Pause Autonomy',
      'Enter reason (optional):',
      async (reason) => {
        try {
          await sendRequest('autonomy:pause', { reason });
          loadStatus();
        } catch (e) {
          Alert.alert('Error', String(e));
        }
      },
      'plain-text'
    );
  };

  const handleResume = async () => {
    try {
      await sendRequest('autonomy:resume', {});
      loadStatus();
    } catch (e) {
      Alert.alert('Error', String(e));
    }
  };

  const handleTestNotification = async () => {
    try {
      await sendRequest('autonomy:notify.send', {
        level: 'info',
        title: 'Test from Mobile',
        message: 'This is a test notification from the Infinibot mobile app.',
      });
      Alert.alert('Success', 'Test notification sent.');
    } catch (e) {
      Alert.alert('Error', String(e));
    }
  };

  const handleAddTask = async () => {
    Alert.prompt(
      'Add Autonomous Task',
      'Enter task title:',
      async (title) => {
        if (!title?.trim()) return;
        Alert.prompt(
          'Task Description',
          'Enter description or instructions:',
          async (description) => {
            Alert.alert(
              'Approval Required?',
              'Should this task require your approval before execution?',
              [
                {
                  text: 'No (Auto-execute)',
                  onPress: async () => {
                    try {
                      await sendRequest('autonomy:queue.add', {
                        title: title.trim(),
                        description: description?.trim() || title.trim(),
                        requiresApproval: false,
                        prefireRequired: false,
                        priority: 'normal',
                      });
                      Alert.alert('Success', 'Task added to autonomous queue');
                      loadStatus();
                    } catch (e) {
                      Alert.alert('Error', String(e));
                    }
                  },
                },
                {
                  text: 'Yes (Require Approval)',
                  onPress: async () => {
                    try {
                      await sendRequest('autonomy:queue.add', {
                        title: title.trim(),
                        description: description?.trim() || title.trim(),
                        requiresApproval: true,
                        prefireRequired: false,
                        priority: 'normal',
                      });
                      Alert.alert('Success', 'Task added - will wait for your approval');
                      loadStatus();
                    } catch (e) {
                      Alert.alert('Error', String(e));
                    }
                  },
                },
              ]
            );
          },
          'plain-text'
        );
      },
      'plain-text'
    );
  };

  const handleApproveTask = async (taskId, taskTitle) => {
    Alert.alert(
      'Approve Task',
      `Allow Ash to execute: "${taskTitle}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          onPress: async () => {
            try {
              await sendRequest('autonomy:queue.approve', { taskId });
              Alert.alert('Approved', 'Task will be executed when conditions are met');
              loadStatus();
            } catch (e) {
              Alert.alert('Error', String(e));
            }
          },
        },
      ]
    );
  };

  const handleCancelTask = async (taskId, taskTitle) => {
    Alert.alert(
      'Cancel Task',
      `Remove "${taskTitle}" from queue?`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel Task',
          style: 'destructive',
          onPress: async () => {
            try {
              await sendRequest('autonomy:queue.cancel', { taskId });
              loadStatus();
            } catch (e) {
              Alert.alert('Error', String(e));
            }
          },
        },
      ]
    );
  };

  const handleStartTask = async (taskId, taskTitle) => {
    Alert.alert(
      'Start Task Now',
      `Execute "${taskTitle}" immediately?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start Now',
          onPress: async () => {
            try {
              await sendRequest('autonomy:queue.start', { taskId });
              Alert.alert('Started', 'Task execution has begun');
              loadStatus();
            } catch (e) {
              Alert.alert('Error', String(e));
            }
          },
        },
      ]
    );
  };

  // Floating back button — this screen is a header-less modal, so it needs
  // its own dismiss affordance on every state (connected, loading, error, ready).
  const BackBtn = () => (
    <TouchableOpacity
      onPress={() => navigation?.goBack?.()}
      style={[styles.modalBackBtn, { top: Math.max(insets.top, 10) + 4 }]}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityRole="button"
      accessibilityLabel="Back"
    >
      <Ionicons name="chevron-back" size={22} color={COLORS.primary} />
    </TouchableOpacity>
  );

  // ── Early-out states ───────────────────────────────────────────────────────

  if (!connected) {
    return (
      <View style={styles.center}>
        <BackBtn />
        <GlassCard style={styles.fullStateCard} tint="neutral" cornerAccents>
          <View style={styles.fullStateInner}>
            <Ionicons name="cloud-offline-outline" size={42} color={COLORS.textMuted} />
            <Text style={styles.fullStateTitle}>Not Connected</Text>
            <Text style={styles.fullStateHint}>Gateway status: {connStatus || 'unknown'}</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => gateway?.connect?.()}>
              <Text style={styles.primaryBtnText}>Retry Connection</Text>
            </TouchableOpacity>
          </View>
        </GlassCard>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <BackBtn />
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Loading autonomy status…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <BackBtn />
        <GlassCard style={styles.fullStateCard} tint="danger" cornerAccents>
          <View style={styles.fullStateInner}>
            <Ionicons name="alert-circle-outline" size={42} color={COLORS.error} />
            <Text style={styles.fullStateTitle}>Couldn’t Load</Text>
            <Text style={styles.fullStateHint} numberOfLines={4}>{error}</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={loadStatus}>
              <Text style={styles.primaryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        </GlassCard>
      </View>
    );
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  const { state, queue, audit, apiUsage } = status || {};
  const isPaused = !!state?.pauseState?.isPaused;
  const pauseReason = state?.pauseState?.reason;
  const accent = isPaused ? COLORS.warning : COLORS.success;

  return (
    <View style={{ flex: 1 }}>
    <BackBtn />
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 10) + 52 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={COLORS.primary}
          colors={[COLORS.primary]}
        />
      }
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <GlassCard
        style={styles.headerCard}
        tint={isPaused ? 'warning' : 'primary'}
        cornerAccents
        animated
        glow
      >
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <View
              style={[
                styles.headerIconWrap,
                {
                  backgroundColor: withAlpha(COLORS.primary, 0.16),
                  borderColor: withAlpha(COLORS.primary, 0.3),
                },
              ]}
            >
              <MaterialCommunityIcons name="robot-outline" size={22} color={COLORS.primary} />
            </View>
            <View style={{ flex: 1, marginLeft: SPACING.md }}>
              <Text style={styles.titleText}>Autonomy</Text>
              <View style={styles.headerStatusRow}>
                {isPaused ? <Led color={COLORS.warning} /> : <PulsingLed color={COLORS.success} />}
                <Text style={[styles.headerStatusText, { color: accent }]}>
                  {isPaused ? 'PAUSED' : 'ACTIVE'}
                </Text>
                {pauseReason ? (
                  <Text style={styles.headerStatusReason} numberOfLines={1}>
                    · {pauseReason}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>

          <TouchableOpacity
            style={[
              styles.headerActionBtn,
              {
                backgroundColor: withAlpha(accent, 0.18),
                borderColor: withAlpha(accent, 0.45),
              },
            ]}
            onPress={isPaused ? handleResume : handlePause}
            activeOpacity={0.75}
          >
            <Ionicons
              name={isPaused ? 'play' : 'pause'}
              size={14}
              color={accent}
              style={{ marginRight: 5 }}
            />
            <Text style={[styles.headerActionText, { color: accent }]}>
              {isPaused ? 'RESUME' : 'PAUSE'}
            </Text>
          </TouchableOpacity>
        </View>
      </GlassCard>

      {/* ── Stats row ───────────────────────────────────────────────────── */}
      <View style={styles.statsRow}>
        <StatCard
          icon="list-outline"
          iconColor={COLORS.primary}
          label="QUEUED"
          value={String(queue?.pending?.length || 0)}
          subtext={queue?.running ? '1 executing' : 'idle'}
        />
        <StatCard
          icon="checkmark-done-outline"
          iconColor={COLORS.success}
          label="COMPLETED"
          value={String(queue?.recentCompleted?.length || 0)}
          subtext="recent"
          accent={COLORS.success}
        />
        <StatCard
          icon="shield-checkmark-outline"
          iconColor={COLORS.primary}
          label="AUDIT"
          value={String(audit?.stats?.totalEntries || 0)}
          subtext={
            audit?.stats?.cageInterferences > 0
              ? `${audit.stats.cageInterferences} alert${audit.stats.cageInterferences === 1 ? '' : 's'}`
              : 'clean'
          }
        />
        <StatCard
          icon="cash-outline"
          iconColor={COLORS.warning}
          label="API COST"
          value={`$${(apiUsage?.today?.totalCost || 0).toFixed(3)}`}
          subtext={`${(apiUsage?.today?.autonomousPercent || 0).toFixed(0)}% auto`}
        />
      </View>

      {/* ── Current task ────────────────────────────────────────────────── */}
      <GlassCard
        style={styles.sectionCard}
        tint={queue?.running ? 'success' : 'primary'}
        glow={!!queue?.running}
        animated
      >
        <SectionHeader
          glyph="◉"
          label="CURRENT TASK"
          right={
            queue?.running ? (
              <TouchableOpacity
                onPress={() =>
                  navigation?.navigate('TaskActivity', { task: queue.running })
                }
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                style={styles.linkBtn}
              >
                <Text style={styles.linkText}>Activity</Text>
                <Ionicons name="chevron-forward" size={12} color={COLORS.primary} />
              </TouchableOpacity>
            ) : null
          }
        />

        {queue?.running ? (
          <PressableScale
            onPress={() => navigation?.navigate('TaskActivity', { task: queue.running })}
            style={styles.currentTaskBody}
          >
            <View style={styles.runningBadgeRow}>
              <PulsingLed color={COLORS.success} />
              <Text style={styles.runningBadgeText}>EXECUTING</Text>
              <View style={{ flex: 1 }} />
              <Text style={styles.runningDuration}>
                {formatDuration(
                  Date.now() - (queue.running.executedAt || queue.running.createdAt)
                )}
              </Text>
            </View>
            <Text style={styles.taskTitle} numberOfLines={2}>
              {queue.running.title}
            </Text>
            {queue.running.description &&
            queue.running.description !== queue.running.title ? (
              <Text style={styles.taskDescription} numberOfLines={3}>
                {queue.running.description}
              </Text>
            ) : null}
            <View style={styles.taskMetaRow}>
              <PriorityChip priority={queue.running.priority} />
              {queue.running.kanbanTaskId ? (
                <Tag icon="link-outline" label="KANBAN" color={COLORS.primary} />
              ) : null}
            </View>
            {queue.running.context?.instructions ? (
              <View style={styles.instructionsBlock}>
                <Text style={styles.instructionsLabel}>INSTRUCTIONS</Text>
                <Text style={styles.instructionsText} numberOfLines={4}>
                  {queue.running.context.instructions}
                </Text>
              </View>
            ) : null}
          </PressableScale>
        ) : (
          <View style={styles.emptyInner}>
            <Ionicons
              name="pause-circle-outline"
              size={32}
              color={COLORS.textTertiary}
            />
            <Text style={styles.emptyTitle}>No task running</Text>
            <Text style={styles.emptyHint}>
              {queue?.pending?.length > 0
                ? `${queue.pending.length} task${queue.pending.length > 1 ? 's' : ''} waiting`
                : 'Queue is empty'}
            </Text>
          </View>
        )}
      </GlassCard>

      {/* ── System status ───────────────────────────────────────────────── */}
      <GlassCard style={styles.sectionCard} animated>
        <SectionHeader glyph="◈" label="SYSTEM STATUS" />
        {state?.activityState ? (
          <View style={styles.sectionBody}>
            <ActivityKeyValueRow
              label="USER"
              leftIcon={state.activityState.isUserActive ? 'person' : 'moon-outline'}
              leftIconColor={
                state.activityState.isUserActive ? COLORS.success : COLORS.warning
              }
              value={
                state.activityState.isUserActive
                  ? 'ACTIVE'
                  : `IDLE · ${formatDuration(state.activityState.idleTimeMs)}`
              }
              valueColor={
                state.activityState.isUserActive ? COLORS.success : COLORS.warning
              }
            />
            <View style={styles.softDivider} />
            <ActivityProgressRow
              label="CPU"
              pct={state.activityState.cpuUsagePercent}
            />
            <View style={{ height: SPACING.sm }} />
            <ActivityProgressRow
              label="RAM"
              pct={state.activityState.memoryUsagePercent}
            />
            {state.activityState.gpuMemoryUsedMb !== undefined &&
            state.activityState.gpuMemoryTotalMb ? (
              <>
                <View style={{ height: SPACING.sm }} />
                <ActivityProgressRow
                  label="VRAM"
                  pct={
                    (state.activityState.gpuMemoryUsedMb /
                      state.activityState.gpuMemoryTotalMb) *
                    100
                  }
                  suffix={`${state.activityState.gpuMemoryUsedMb} / ${state.activityState.gpuMemoryTotalMb}MB`}
                />
              </>
            ) : null}
          </View>
        ) : (
          <View style={styles.emptyInner}>
            <Ionicons name="analytics-outline" size={28} color={COLORS.textTertiary} />
            <Text style={styles.emptyHint}>No activity data</Text>
          </View>
        )}
      </GlassCard>

      {/* ── Pending tasks ───────────────────────────────────────────────── */}
      <GlassCard style={styles.sectionCard} animated>
        <SectionHeader
          glyph="◇"
          label={`PENDING · ${queue?.pending?.length || 0}`}
          right={
            <TouchableOpacity
              onPress={handleAddTask}
              style={[
                styles.addPill,
                {
                  backgroundColor: withAlpha(COLORS.primary, 0.15),
                  borderColor: withAlpha(COLORS.primary, 0.4),
                },
              ]}
              activeOpacity={0.75}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons name="add" size={14} color={COLORS.primary} />
              <Text style={styles.addPillText}>ADD</Text>
            </TouchableOpacity>
          }
        />
        {queue?.pending?.length > 0 ? (
          <View style={styles.taskList}>
            {queue.pending.slice(0, 10).map((task, idx) => (
              <View
                key={task.id || idx}
                style={[styles.taskRow, idx > 0 && styles.taskRowDivider]}
              >
                <View style={styles.taskRowHeader}>
                  <View style={{ flex: 1, paddingRight: SPACING.sm }}>
                    <Text style={styles.taskRowTitle} numberOfLines={2}>
                      {task.title}
                    </Text>
                    <View style={styles.taskMetaRow}>
                      <PriorityChip priority={task.priority} />
                      {task.hardwareIntensive ? (
                        <Tag
                          icon="hardware-chip-outline"
                          label="HARDWARE"
                          color={COLORS.warning}
                        />
                      ) : null}
                      {task.requiresApproval ? (
                        <Tag
                          icon="shield-outline"
                          label="APPROVAL"
                          color={COLORS.primary}
                        />
                      ) : null}
                      {task.status === 'approved' ? (
                        <Tag
                          icon="checkmark-outline"
                          label="APPROVED"
                          color={COLORS.success}
                        />
                      ) : null}
                    </View>
                  </View>
                  <View style={styles.taskActions}>
                    {(task.status === 'pending' || task.status === 'approved') && (
                      <TouchableOpacity
                        style={[
                          styles.iconBtn,
                          {
                            backgroundColor: withAlpha('#3b82f6', 0.15),
                            borderColor: withAlpha('#3b82f6', 0.4),
                          },
                        ]}
                        onPress={() => handleStartTask(task.id, task.title)}
                        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                      >
                        <Ionicons name="play" size={13} color="#3b82f6" />
                      </TouchableOpacity>
                    )}
                    {task.requiresApproval && task.status === 'pending' && (
                      <TouchableOpacity
                        style={[
                          styles.iconBtn,
                          {
                            backgroundColor: withAlpha(COLORS.success, 0.15),
                            borderColor: withAlpha(COLORS.success, 0.4),
                          },
                        ]}
                        onPress={() => handleApproveTask(task.id, task.title)}
                        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                      >
                        <Ionicons name="checkmark" size={14} color={COLORS.success} />
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[
                        styles.iconBtn,
                        {
                          backgroundColor: withAlpha(COLORS.error, 0.12),
                          borderColor: withAlpha(COLORS.error, 0.35),
                        },
                      ]}
                      onPress={() => handleCancelTask(task.id, task.title)}
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                    >
                      <Ionicons name="close" size={14} color={COLORS.error} />
                    </TouchableOpacity>
                  </View>
                </View>
                {task.context?.instructions ? (
                  <Text style={styles.taskInstructions} numberOfLines={2}>
                    {task.context.instructions}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.emptyInner}>
            <Ionicons name="checkmark-done-circle-outline" size={32} color={COLORS.textTertiary} />
            <Text style={styles.emptyTitle}>Queue is clear</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={handleAddTask}>
              <Ionicons name="add" size={14} color={COLORS.background} style={{ marginRight: 4 }} />
              <Text style={styles.primaryBtnText}>Add Task</Text>
            </TouchableOpacity>
          </View>
        )}
      </GlassCard>

      {/* ── Recently completed ─────────────────────────────────────────── */}
      {queue?.recentCompleted?.length > 0 ? (
        <GlassCard style={styles.sectionCard} tint="success" animated>
          <SectionHeader glyph="◆" label="RECENTLY COMPLETED" />
          <View style={styles.taskList}>
            {queue.recentCompleted.slice(0, 3).map((task, idx) => (
              <View
                key={task.id || idx}
                style={[styles.completedRow, idx > 0 && styles.taskRowDivider]}
              >
                <View
                  style={[
                    styles.iconBtn,
                    {
                      backgroundColor: withAlpha(COLORS.success, 0.14),
                      borderColor: withAlpha(COLORS.success, 0.35),
                    },
                  ]}
                >
                  <Ionicons name="checkmark" size={14} color={COLORS.success} />
                </View>
                <View style={{ flex: 1, marginLeft: SPACING.sm }}>
                  <Text style={styles.taskRowTitle} numberOfLines={1}>
                    {task.title}
                  </Text>
                  <Text style={styles.completedTime}>
                    {formatDuration(Date.now() - task.completedAt)} ago
                    {task.outcome ? ` · ${task.outcome}` : ''}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </GlassCard>
      ) : null}

      {/* ── Audit log ──────────────────────────────────────────────────── */}
      <GlassCard style={styles.sectionCard} animated>
        <SectionHeader
          glyph="◆"
          label="AUDIT LOG"
          right={
            <View
              style={[
                styles.chainBadge,
                {
                  backgroundColor: withAlpha(
                    audit?.chainValid ? COLORS.success : COLORS.error,
                    0.14
                  ),
                  borderColor: withAlpha(
                    audit?.chainValid ? COLORS.success : COLORS.error,
                    0.35
                  ),
                },
              ]}
            >
              <Ionicons
                name={audit?.chainValid ? 'lock-closed' : 'warning'}
                size={11}
                color={audit?.chainValid ? COLORS.success : COLORS.error}
              />
              <Text
                style={[
                  styles.chainBadgeText,
                  { color: audit?.chainValid ? COLORS.success : COLORS.error },
                ]}
              >
                {audit?.chainValid ? 'CHAIN OK' : 'CHAIN ISSUE'}
              </Text>
            </View>
          }
        />
        {audit?.recentEntries?.length > 0 ? (
          <View style={styles.taskList}>
            {audit.recentEntries.slice(0, 10).map((entry, idx) => {
              const oColor =
                entry.outcome && entry.outcome !== 'success'
                  ? auditColor(entry.outcome)
                  : COLORS.textMuted;
              return (
                <View
                  key={entry.id || idx}
                  style={[styles.auditRow, idx > 0 && styles.taskRowDivider]}
                >
                  <View
                    style={[
                      styles.auditIconWrap,
                      {
                        backgroundColor: withAlpha(oColor, 0.12),
                        borderColor: withAlpha(oColor, 0.25),
                      },
                    ]}
                  >
                    <Ionicons name={getAuditIcon(entry.actionType)} size={12} color={oColor} />
                  </View>
                  <View style={{ flex: 1, marginLeft: SPACING.sm }}>
                    <View style={styles.auditHeaderRow}>
                      <Text style={styles.auditAction} numberOfLines={1}>
                        {formatAuditAction(entry.actionType)}
                      </Text>
                      <Text style={styles.auditTime}>{formatAuditTime(entry.timestamp)}</Text>
                    </View>
                    {entry.description ? (
                      <Text style={styles.auditDesc} numberOfLines={2}>
                        {entry.description}
                      </Text>
                    ) : null}
                    {entry.outcome && entry.outcome !== 'success' ? (
                      <Text style={[styles.auditOutcome, { color: oColor }]}>
                        {String(entry.outcome).toUpperCase()}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.emptyInner}>
            <Ionicons name="document-text-outline" size={28} color={COLORS.textTertiary} />
            <Text style={styles.emptyHint}>No audit entries yet</Text>
          </View>
        )}
        {audit?.stats ? (
          <Text style={styles.auditFooter}>
            {audit.stats.totalEntries} entries
            {audit.stats.cageInterferences
              ? ` · ${audit.stats.cageInterferences} cage alert${audit.stats.cageInterferences === 1 ? '' : 's'}`
              : ''}
          </Text>
        ) : null}
      </GlassCard>

      {/* ── Test notification ──────────────────────────────────────────── */}
      <TouchableOpacity
        style={[
          styles.testBtn,
          {
            backgroundColor: withAlpha(COLORS.primary, 0.12),
            borderColor: withAlpha(COLORS.primary, 0.35),
          },
        ]}
        onPress={handleTestNotification}
        activeOpacity={0.8}
      >
        <Ionicons name="notifications-outline" size={16} color={COLORS.primary} />
        <Text style={styles.testBtnText}>Send Test Notification</Text>
      </TouchableOpacity>

      <View style={{ height: 48 }} />
    </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: SPACING.md, paddingBottom: 88 },
  modalBackBtn: {
    position: 'absolute',
    left: SPACING.md,
    zIndex: 30,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: withAlpha(COLORS.primary, 0.14),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.primary, 0.3),
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Centered full-screen states
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
  },
  fullStateCard: { width: '100%', maxWidth: 360, padding: SPACING.xl },
  fullStateInner: { alignItems: 'center', gap: SPACING.sm },
  fullStateTitle: { ...FONTS.heading, color: COLORS.textStrong, fontSize: 17, marginTop: SPACING.sm },
  fullStateHint: { ...FONTS.small, color: COLORS.textMuted, textAlign: 'center' },
  loadingText: { ...FONTS.small, color: COLORS.textMuted, marginTop: SPACING.md },

  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 4,
  },
  primaryBtnText: { color: COLORS.background, fontWeight: '700', letterSpacing: 0.5 },

  // ── Header ─────────────────────────────────────────────────────────
  headerCard: { padding: SPACING.lg, marginBottom: SPACING.md },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  headerIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleText: {
    ...FONTS.heading,
    color: COLORS.textStrong,
    fontSize: 22,
    letterSpacing: 0.2,
  },
  headerStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 6,
  },
  headerStatusText: {
    ...FONTS.tiny,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.8,
  },
  headerStatusReason: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    flexShrink: 1,
  },
  headerActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: 8,
    borderRadius: 99,
    borderWidth: 1,
  },
  headerActionText: {
    ...FONTS.tiny,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
  },

  // ── Stat cards row ────────────────────────────────────────────────
  statsRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  statCard: {
    flex: 1,
    backgroundColor: withAlpha(COLORS.surfaceTint || '#000', 0.32),
    borderColor: withAlpha(COLORS.primary, 0.16),
    borderWidth: 1,
    borderRadius: 14,
    padding: SPACING.sm,
    alignItems: 'flex-start',
    minHeight: 96,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  statIconWrap: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  statValue: {
    ...FONTS.heading,
    color: COLORS.textStrong,
    fontSize: 17,
    fontWeight: '800',
    marginTop: 2,
  },
  statLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 9,
    letterSpacing: 1.4,
    marginTop: 1,
  },
  statSubtext: {
    ...FONTS.tiny,
    color: COLORS.textTertiary,
    fontSize: 9,
    marginTop: 2,
  },

  // ── Section card / header ─────────────────────────────────────────
  sectionCard: { padding: 0, marginBottom: SPACING.md, overflow: 'hidden' },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(COLORS.primary, 0.10),
  },
  sectionHeaderText: {
    ...FONTS.tiny,
    fontSize: 11,
    color: COLORS.textMuted,
    fontWeight: '700',
    letterSpacing: 1.6,
    flex: 1,
  },
  sectionGlyph: {
    color: COLORS.primary,
    fontWeight: '800',
  },
  sectionHeaderRight: { flexDirection: 'row', alignItems: 'center' },
  sectionBody: { padding: SPACING.md },

  linkBtn: { flexDirection: 'row', alignItems: 'center' },
  linkText: {
    ...FONTS.tiny,
    color: COLORS.primary,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 1,
    marginRight: 2,
  },

  // ── Current task body ─────────────────────────────────────────────
  currentTaskBody: { padding: SPACING.md },
  runningBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: SPACING.sm,
  },
  runningBadgeText: {
    ...FONTS.tiny,
    fontSize: 10,
    color: COLORS.success,
    fontWeight: '800',
    letterSpacing: 1.8,
  },
  runningDuration: {
    ...FONTS.tiny,
    fontSize: 11,
    color: COLORS.textMuted,
    fontFamily: 'monospace',
  },
  taskTitle: {
    ...FONTS.heading,
    color: COLORS.textStrong,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  taskDescription: {
    ...FONTS.small,
    color: COLORS.textMuted,
    lineHeight: 19,
    marginBottom: SPACING.sm,
  },
  taskMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  instructionsBlock: {
    marginTop: SPACING.md,
    padding: SPACING.sm + 2,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderLeftWidth: 2,
    borderLeftColor: withAlpha(COLORS.primary, 0.45),
  },
  instructionsLabel: {
    ...FONTS.tiny,
    fontSize: 9,
    color: COLORS.textMuted,
    letterSpacing: 1.4,
    marginBottom: 4,
  },
  instructionsText: {
    ...FONTS.small,
    color: COLORS.text,
    fontSize: 12,
    lineHeight: 17,
  },

  // ── Empty state inside section ────────────────────────────────────
  emptyInner: {
    alignItems: 'center',
    paddingVertical: SPACING.lg,
    gap: 6,
  },
  emptyTitle: {
    ...FONTS.small,
    color: COLORS.text,
    fontWeight: '600',
  },
  emptyHint: {
    ...FONTS.small,
    color: COLORS.textTertiary,
    fontSize: 12,
  },

  // ── System status rows ────────────────────────────────────────────
  actProgressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  actProgressLabel: {
    ...FONTS.tiny,
    fontSize: 10,
    color: COLORS.textMuted,
    letterSpacing: 1.4,
    width: 46,
  },
  actProgressBarWrap: { flex: 1 },
  actProgressVal: {
    ...FONTS.small,
    fontSize: 12,
    fontWeight: '700',
    minWidth: 50,
    textAlign: 'right',
  },
  actProgressSuffix: {
    ...FONTS.tiny,
    color: COLORS.textTertiary,
    fontWeight: '500',
  },
  actKvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actKvLeft: { flexDirection: 'row', alignItems: 'center' },
  actKvVal: {
    ...FONTS.small,
    fontSize: 12,
    color: COLORS.text,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  softDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    marginVertical: SPACING.sm,
  },

  // ── Progress bar ──────────────────────────────────────────────────
  barTrack: {
    height: 5,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 4 },

  // ── LED ───────────────────────────────────────────────────────────
  led: {},

  // ── Chips / tags ──────────────────────────────────────────────────
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  chipText: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  tagText: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
  },

  // ── Section add pill ──────────────────────────────────────────────
  addPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm + 2,
    paddingVertical: 3,
    borderRadius: 99,
    borderWidth: 1,
  },
  addPillText: {
    ...FONTS.tiny,
    color: COLORS.primary,
    fontWeight: '800',
    fontSize: 10,
    letterSpacing: 1.4,
    marginLeft: 3,
  },

  // ── Pending task list ─────────────────────────────────────────────
  taskList: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  taskRow: { paddingVertical: SPACING.md },
  taskRowDivider: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  taskRowHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  taskRowTitle: {
    ...FONTS.small,
    color: COLORS.textStrong,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 5,
  },
  taskInstructions: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 11,
    marginTop: SPACING.sm,
    fontStyle: 'italic',
    lineHeight: 16,
  },
  taskActions: {
    flexDirection: 'row',
    gap: 6,
  },
  iconBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Completed row ─────────────────────────────────────────────────
  completedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm + 2,
  },
  completedTime: {
    ...FONTS.tiny,
    fontSize: 10,
    color: COLORS.textMuted,
    marginTop: 2,
  },

  // ── Audit ─────────────────────────────────────────────────────────
  chainBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 99,
    borderWidth: 1,
  },
  chainBadgeText: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  auditRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: SPACING.sm + 2,
  },
  auditIconWrap: {
    width: 26,
    height: 26,
    borderRadius: 7,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  auditHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  auditAction: {
    ...FONTS.small,
    fontSize: 12,
    color: COLORS.text,
    fontWeight: '700',
    flex: 1,
  },
  auditTime: {
    ...FONTS.tiny,
    fontSize: 10,
    color: COLORS.textTertiary,
    marginLeft: SPACING.sm,
    fontFamily: 'monospace',
  },
  auditDesc: {
    ...FONTS.tiny,
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 2,
    lineHeight: 15,
  },
  auditOutcome: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.3,
    marginTop: 4,
  },
  auditFooter: {
    ...FONTS.tiny,
    fontSize: 10,
    color: COLORS.textTertiary,
    textAlign: 'center',
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.04)',
    letterSpacing: 0.6,
  },

  // ── Test notification button ──────────────────────────────────────
  testBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: SPACING.xs,
    paddingVertical: SPACING.md,
    borderRadius: 12,
    borderWidth: 1,
  },
  testBtnText: {
    ...FONTS.small,
    color: COLORS.primary,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
});
