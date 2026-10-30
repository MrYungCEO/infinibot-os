/**
 * CronScreen — Scheduled Jobs & Reminders Management
 * Premium glass treatment that matches Activity / Agents.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Switch, Modal, TextInput, Alert,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { GlassCard } from '../components/GlassCard';
import { GlassSurface } from '../components/GlassSurface';
import { PremiumHeader } from '../components/PremiumHeader';
import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../theme/color-utils';

// Format time remaining
function formatTimeRemaining(ms) {
  if (!ms || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// Format cron schedule
function formatSchedule(schedule) {
  if (!schedule) return 'Unknown';

  switch (schedule.kind) {
    case 'at':
      return `Once at ${new Date(schedule.atMs).toLocaleString()}`;
    case 'every': {
      const everyMs = schedule.everyMs;
      if (everyMs >= 86400000) return `Every ${Math.floor(everyMs / 86400000)} day(s)`;
      if (everyMs >= 3600000) return `Every ${Math.floor(everyMs / 3600000)} hour(s)`;
      if (everyMs >= 60000) return `Every ${Math.floor(everyMs / 60000)} minute(s)`;
      return `Every ${Math.floor(everyMs / 1000)} second(s)`;
    }
    case 'cron':
      return schedule.expr;
    default:
      return 'Unknown schedule';
  }
}

function JobCard({ job, onToggle, onRun, onDelete, colors, styles }) {
  const isEnabled = job.enabled !== false;
  const nextRun = job.nextRunAtMs ? job.nextRunAtMs - Date.now() : null;
  const accent = isEnabled
    ? (job.payload?.kind === 'agentTurn' ? (colors.info || colors.cyan || '#22D3EE') : colors.primary)
    : colors.textMuted;
  const lastRunColor = job.lastRunOutcome === 'error' ? colors.error : colors.success;

  return (
    <GlassCard
      style={[
        styles.jobCard,
        { borderLeftWidth: 3, borderLeftColor: accent },
        !isEnabled && { opacity: 0.7 },
      ]}
      animated
      glow={isEnabled && job.lastRunOutcome !== 'error'}
    >
      <View style={styles.jobCardInner}>
        <View style={styles.jobHeader}>
          <View
            style={[
              styles.jobIcon,
              {
                backgroundColor: withAlpha(accent, 0.14),
                borderColor: withAlpha(accent, 0.4),
              },
            ]}
          >
            <Ionicons
              name={job.payload?.kind === 'agentTurn' ? 'chatbubbles' : 'notifications'}
              size={16}
              color={accent}
            />
          </View>
          <View style={styles.jobInfo}>
            <Text
              style={[
                styles.jobName,
                { color: isEnabled ? colors.text : colors.textMuted },
              ]}
              numberOfLines={1}
            >
              {job.name || 'Unnamed Job'}
            </Text>
            <Text
              style={[styles.jobSchedule, { color: colors.textMuted }]}
              numberOfLines={1}
            >
              {formatSchedule(job.schedule)}
            </Text>
          </View>
          <Switch
            value={isEnabled}
            onValueChange={(val) => onToggle(job.id, val)}
            trackColor={{
              false: withAlpha(colors.text || '#fff', 0.15),
              true: withAlpha(colors.primary, 0.5),
            }}
            thumbColor={isEnabled ? colors.primary : withAlpha(colors.text || '#fff', 0.5)}
          />
        </View>

        {job.payload ? (
          <View
            style={[
              styles.payloadBox,
              {
                backgroundColor: withAlpha(colors.primary, 0.06),
                borderColor: withAlpha(colors.primary, 0.18),
              },
            ]}
          >
            <Text style={[styles.payloadLabel, { color: colors.primary }]}>
              {job.payload.kind === 'systemEvent' ? 'SYSTEM EVENT' : 'AGENT TURN'}
            </Text>
            <Text
              style={[styles.payloadText, { color: colors.text }]}
              numberOfLines={2}
            >
              {job.payload.text || job.payload.message || 'No message'}
            </Text>
          </View>
        ) : null}

        <View
          style={[
            styles.jobFooter,
            { borderTopColor: withAlpha(colors.text || '#fff', 0.06) },
          ]}
        >
          <View style={styles.jobMeta}>
            {nextRun && nextRun > 0 ? (
              <View
                style={[
                  styles.nextRunBadge,
                  {
                    backgroundColor: withAlpha(colors.success, 0.12),
                    borderColor: withAlpha(colors.success, 0.32),
                  },
                ]}
              >
                <Ionicons name="time-outline" size={11} color={colors.success} />
                <Text style={[styles.nextRunText, { color: colors.success }]}>
                  Next: {formatTimeRemaining(nextRun)}
                </Text>
              </View>
            ) : (
              <Text style={[styles.nextRunPast, { color: colors.textMuted }]}>
                No upcoming run
              </Text>
            )}

            {job.lastRunAtMs ? (
              <View
                style={[
                  styles.lastRunBadge,
                  {
                    backgroundColor: withAlpha(lastRunColor, 0.1),
                    borderColor: withAlpha(lastRunColor, 0.3),
                  },
                ]}
              >
                <View
                  style={[styles.lastRunDot, { backgroundColor: lastRunColor }]}
                />
                <Text
                  style={[styles.lastRunText, { color: lastRunColor }]}
                  numberOfLines={1}
                >
                  Last: {formatTimeRemaining(Date.now() - job.lastRunAtMs)} ago
                </Text>
              </View>
            ) : null}

            {job.sessionTarget ? (
              <Text
                style={[
                  styles.sessionTarget,
                  {
                    color: colors.textMuted,
                    backgroundColor: withAlpha('#ffffff', 0.05),
                  },
                ]}
              >
                {job.sessionTarget}
              </Text>
            ) : null}
          </View>

          <View style={styles.jobActions}>
            <TouchableOpacity
              style={[
                styles.jobActionBtn,
                {
                  backgroundColor: withAlpha(colors.primary, 0.12),
                  borderColor: withAlpha(colors.primary, 0.32),
                },
              ]}
              onPress={() => onRun(job.id)}
              hitSlop={6}
            >
              <Ionicons name="play" size={14} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.jobActionBtn,
                {
                  backgroundColor: withAlpha(colors.error, 0.1),
                  borderColor: withAlpha(colors.error, 0.32),
                },
              ]}
              onPress={() => onDelete(job.id)}
              hitSlop={6}
            >
              <Ionicons name="trash-outline" size={14} color={colors.error} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </GlassCard>
  );
}

function CreateJobModal({ visible, onClose, onCreate, colors, styles }) {
  const [name, setName] = useState('');
  const [scheduleType, setScheduleType] = useState('every');
  const [intervalMinutes, setIntervalMinutes] = useState('30');
  const [atTime, setAtTime] = useState('');
  const [cronExpr, setCronExpr] = useState('');
  const [payloadKind, setPayloadKind] = useState('systemEvent');
  const [message, setMessage] = useState('');
  const [sessionTarget, setSessionTarget] = useState('main');

  const handleCreate = () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Job name is required');
      return;
    }
    if (!message.trim()) {
      Alert.alert('Error', 'Message is required');
      return;
    }

    let schedule = {};
    switch (scheduleType) {
      case 'at':
        if (!atTime) {
          Alert.alert('Error', 'Time is required for one-time jobs');
          return;
        }
        schedule = { kind: 'at', atMs: new Date(atTime).getTime() };
        break;
      case 'every':
        schedule = { kind: 'every', everyMs: parseInt(intervalMinutes) * 60000 };
        break;
      case 'cron':
        if (!cronExpr.trim()) {
          Alert.alert('Error', 'Cron expression is required');
          return;
        }
        schedule = { kind: 'cron', expr: cronExpr.trim() };
        break;
    }

    const job = {
      name: name.trim(),
      schedule,
      payload: payloadKind === 'systemEvent'
        ? { kind: 'systemEvent', text: message }
        : { kind: 'agentTurn', message },
      sessionTarget: sessionTarget === 'main' ? 'main' : 'isolated',
      enabled: true,
    };

    onCreate(job);
  };

  const renderSegmented = (current, setter, options) => (
    <View
      style={[
        styles.segmentedControl,
        { backgroundColor: withAlpha('#000', 0.32) },
      ]}
    >
      {options.map((opt) => {
        const active = current === opt.key;
        return (
          <TouchableOpacity
            key={opt.key}
            style={[
              styles.segmentBtn,
              active && {
                backgroundColor: withAlpha(colors.primary, 0.2),
                borderColor: withAlpha(colors.primary, 0.45),
                borderWidth: 1,
              },
            ]}
            onPress={() => setter(opt.key)}
          >
            <Text
              style={[
                styles.segmentText,
                {
                  color: active ? colors.primary : colors.textMuted,
                  fontWeight: active ? '700' : '600',
                },
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <GlassSurface depth={3} radius={24} style={styles.createModal}>
          <View
            style={[
              styles.modalHeader,
              { borderBottomColor: withAlpha(colors.primary, 0.18) },
            ]}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View
                style={[
                  styles.modalIconWrap,
                  {
                    backgroundColor: withAlpha(colors.primary, 0.14),
                    borderColor: withAlpha(colors.primary, 0.45),
                  },
                ]}
              >
                <Ionicons name="timer-outline" size={20} color={colors.primary} />
              </View>
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                Create Scheduled Job
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalBody}>
            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.primary }]}>JOB NAME</Text>
              <TextInput
                style={[
                  styles.formInput,
                  {
                    color: colors.text,
                    backgroundColor: withAlpha('#000', 0.4),
                    borderColor: withAlpha(colors.primary, 0.22),
                  },
                ]}
                value={name}
                onChangeText={setName}
                placeholder="e.g., Morning Reminder"
                placeholderTextColor={colors.textMuted}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.primary }]}>SCHEDULE TYPE</Text>
              {renderSegmented(scheduleType, setScheduleType, [
                { key: 'every', label: 'Interval' },
                { key: 'at', label: 'One-time' },
                { key: 'cron', label: 'Cron' },
              ])}
            </View>

            {scheduleType === 'every' && (
              <View style={styles.formGroup}>
                <Text style={[styles.formLabel, { color: colors.primary }]}>
                  INTERVAL (MINUTES)
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      backgroundColor: withAlpha('#000', 0.4),
                      borderColor: withAlpha(colors.primary, 0.22),
                    },
                  ]}
                  value={intervalMinutes}
                  onChangeText={setIntervalMinutes}
                  placeholder="30"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="numeric"
                />
              </View>
            )}

            {scheduleType === 'at' && (
              <View style={styles.formGroup}>
                <Text style={[styles.formLabel, { color: colors.primary }]}>
                  DATE & TIME (ISO)
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      backgroundColor: withAlpha('#000', 0.4),
                      borderColor: withAlpha(colors.primary, 0.22),
                    },
                  ]}
                  value={atTime}
                  onChangeText={setAtTime}
                  placeholder="2026-02-17T14:00:00"
                  placeholderTextColor={colors.textMuted}
                />
                <Text style={[styles.formHint, { color: colors.textMuted }]}>
                  ISO format: YYYY-MM-DDTHH:mm:ss
                </Text>
              </View>
            )}

            {scheduleType === 'cron' && (
              <View style={styles.formGroup}>
                <Text style={[styles.formLabel, { color: colors.primary }]}>
                  CRON EXPRESSION
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      backgroundColor: withAlpha('#000', 0.4),
                      borderColor: withAlpha(colors.primary, 0.22),
                    },
                  ]}
                  value={cronExpr}
                  onChangeText={setCronExpr}
                  placeholder="0 9 * * 1"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                />
                <Text style={[styles.formHint, { color: colors.textMuted }]}>
                  e.g., "0 9 * * 1" = 9am every Monday
                </Text>
              </View>
            )}

            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.primary }]}>PAYLOAD TYPE</Text>
              {renderSegmented(payloadKind, setPayloadKind, [
                { key: 'systemEvent', label: 'System Event' },
                { key: 'agentTurn', label: 'Agent Turn' },
              ])}
              <Text style={[styles.formHint, { color: colors.textMuted }]}>
                {payloadKind === 'systemEvent'
                  ? 'Inject message into current session'
                  : 'Run agent with message (isolated)'}
              </Text>
            </View>

            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.primary }]}>MESSAGE</Text>
              <TextInput
                style={[
                  styles.formInput,
                  styles.formTextarea,
                  {
                    color: colors.text,
                    backgroundColor: withAlpha('#000', 0.4),
                    borderColor: withAlpha(colors.primary, 0.22),
                  },
                ]}
                value={message}
                onChangeText={setMessage}
                placeholder="Reminder: Check your calendar"
                placeholderTextColor={colors.textMuted}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.primary }]}>SESSION TARGET</Text>
              {renderSegmented(sessionTarget, setSessionTarget, [
                { key: 'main', label: 'Main' },
                { key: 'isolated', label: 'Isolated' },
              ])}
            </View>
          </ScrollView>

          <View
            style={[
              styles.modalFooter,
              { borderTopColor: withAlpha(colors.primary, 0.18) },
            ]}
          >
            <TouchableOpacity
              style={[
                styles.cancelBtn,
                { backgroundColor: withAlpha('#ffffff', 0.05) },
              ]}
              onPress={onClose}
            >
              <Text style={[styles.cancelBtnText, { color: colors.textMuted }]}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.createBtn, { backgroundColor: colors.primary }]}
              onPress={handleCreate}
            >
              <Ionicons name="add" size={18} color={colors.background} />
              <Text style={[styles.createBtnText, { color: colors.background }]}>
                Create Job
              </Text>
            </TouchableOpacity>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}

export function CronScreen({ navigation, gateway }) {
  const { width } = useWindowDimensions();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [status, setStatus] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const loadCron = useCallback(async () => {
    if (!gateway?.sendReq) return;
    setLoading(true);
    setError(null);

    try {
      const result = await gateway.sendReq('cron.status', {});
      if (result) {
        setStatus(result);
      }

      const listResult = await gateway.sendReq('cron.list', {});
      if (listResult?.jobs) {
        setJobs(listResult.jobs);
      }
    } catch (err) {
      setError(err.message);
      // Mock data fallback so the screen is useful when the RPC isn't wired.
      setJobs([
        {
          id: 'job-1',
          name: 'Morning Check-in',
          schedule: { kind: 'cron', expr: '0 9 * * *' },
          payload: { kind: 'systemEvent', text: 'Good morning! Check calendar and emails.' },
          sessionTarget: 'main',
          enabled: true,
          nextRunAtMs: Date.now() + 3600000,
        },
        {
          id: 'job-2',
          name: 'Heartbeat',
          schedule: { kind: 'every', everyMs: 1800000 },
          payload: { kind: 'systemEvent', text: 'Heartbeat check' },
          sessionTarget: 'main',
          enabled: true,
          nextRunAtMs: Date.now() + 600000,
        },
        {
          id: 'job-3',
          name: 'Weekly Report',
          schedule: { kind: 'cron', expr: '0 17 * * 5' },
          payload: { kind: 'agentTurn', message: 'Generate weekly summary report' },
          sessionTarget: 'isolated',
          enabled: false,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  useEffect(() => {
    loadCron();
  }, [loadCron]);

  const handleToggle = useCallback(async (jobId, enabled) => {
    try {
      await gateway.sendReq('cron.update', { jobId, patch: { enabled } });
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, enabled } : j));
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  }, [gateway]);

  const handleRun = useCallback(async (jobId) => {
    try {
      await gateway.sendReq('cron.run', { jobId });
      Alert.alert('Success', 'Job triggered');
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  }, [gateway]);

  const handleDelete = useCallback(async (jobId) => {
    Alert.alert(
      'Delete Job',
      'Are you sure you want to delete this job?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await gateway.sendReq('cron.remove', { jobId });
              setJobs(prev => prev.filter(j => j.id !== jobId));
            } catch (err) {
              Alert.alert('Error', err.message);
            }
          },
        },
      ],
    );
  }, [gateway]);

  const handleCreate = useCallback(async (job) => {
    try {
      const result = await gateway.sendReq('cron.add', { job });
      if (result?.job) {
        setJobs(prev => [result.job, ...prev]);
      }
      setShowCreate(false);
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  }, [gateway]);

  const enabledCount = jobs.filter(j => j.enabled !== false).length;
  const nextWakeMs = status?.nextWakeAtMs ? status.nextWakeAtMs - Date.now() : null;
  const subtitle = nextWakeMs && nextWakeMs > 0
    ? `${jobs.length} scheduled · next in ${formatTimeRemaining(nextWakeMs)}`
    : `${jobs.length} scheduled · ${enabledCount} enabled`;

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <PremiumHeader
        eyebrow="CRON"
        title="Scheduled Jobs"
        subtitle={subtitle}
        statusPill={
          enabledCount > 0
            ? { label: `${enabledCount} on`, color: colors.success }
            : null
        }
        rightActions={[
          {
            icon: 'add',
            onPress: () => setShowCreate(true),
            color: colors.primary,
          },
          {
            icon: 'refresh',
            onPress: loadCron,
            busy: loading,
            color: loading ? colors.textMuted : colors.primary,
          },
        ]}
      />

      {error ? (
        <View
          style={[
            styles.errorBanner,
            {
              backgroundColor: withAlpha(colors.error, 0.1),
              borderColor: withAlpha(colors.error, 0.3),
            },
          ]}
        >
          <Ionicons name="warning-outline" size={14} color={colors.error} />
          <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      ) : null}

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadCron} tintColor={colors.primary} />
        }
      >
        {loading && jobs.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.textMuted }]}>
              Loading jobs...
            </Text>
          </View>
        ) : (
          <View style={styles.jobsList}>
            {jobs.map(job => (
              <JobCard
                key={job.id}
                job={job}
                onToggle={handleToggle}
                onRun={handleRun}
                onDelete={handleDelete}
                colors={colors}
                styles={styles}
              />
            ))}

            {jobs.length === 0 ? (
              <GlassSurface depth={1} radius={18} style={styles.emptyPlate}>
                <View style={styles.emptyInner}>
                  <View
                    style={[
                      styles.emptyIconWrap,
                      {
                        backgroundColor: withAlpha(colors.primary, 0.1),
                        borderColor: withAlpha(colors.primary, 0.3),
                      },
                    ]}
                  >
                    <Ionicons name="timer-outline" size={36} color={colors.primary} />
                  </View>
                  <Text style={[styles.emptyTitle, { color: colors.text }]}>
                    No Scheduled Jobs
                  </Text>
                  <Text style={[styles.emptyText, { color: colors.textMuted }]}>
                    Create a job to automate tasks
                  </Text>
                  <TouchableOpacity
                    style={[
                      styles.emptyBtn,
                      {
                        backgroundColor: withAlpha(colors.primary, 0.15),
                        borderColor: withAlpha(colors.primary, 0.45),
                      },
                    ]}
                    onPress={() => setShowCreate(true)}
                  >
                    <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
                    <Text style={[styles.emptyBtnText, { color: colors.primary }]}>
                      Create Job
                    </Text>
                  </TouchableOpacity>
                </View>
              </GlassSurface>
            ) : null}
          </View>
        )}
      </ScrollView>

      <CreateJobModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
        colors={colors}
        styles={styles}
      />
    </SafeAreaView>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: 'transparent',
    },

    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginHorizontal: 16,
      marginTop: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 12,
      borderWidth: 1,
    },
    errorText: { fontSize: 12, flex: 1 },

    scrollView: { flex: 1 },
    content: { padding: 16, paddingBottom: 32 },
    loadingContainer: { alignItems: 'center', paddingVertical: 60 },
    loadingText: { marginTop: 12, fontSize: 12 },

    jobsList: { gap: 12 },

    // Job Card
    jobCard: {},
    jobCardInner: { padding: 14 },
    jobHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 12,
    },
    jobIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    jobInfo: { flex: 1 },
    jobName: { fontSize: 15, fontWeight: '700' },
    jobSchedule: {
      fontSize: 11,
      marginTop: 2,
      fontFamily: 'monospace',
      letterSpacing: 0.3,
    },

    payloadBox: {
      borderRadius: 12,
      padding: 10,
      marginBottom: 12,
      borderWidth: 1,
    },
    payloadLabel: {
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 1,
      marginBottom: 4,
      opacity: 0.9,
    },
    payloadText: { fontSize: 12, lineHeight: 17 },

    jobFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 10,
      borderTopWidth: 1,
      flexWrap: 'wrap',
      gap: 8,
    },
    jobMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flex: 1,
      flexWrap: 'wrap',
    },
    nextRunBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 3,
      paddingHorizontal: 8,
      borderRadius: 999,
      borderWidth: 1,
    },
    nextRunText: { fontSize: 10, fontWeight: '700' },
    nextRunPast: { fontSize: 10 },

    lastRunBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 3,
      paddingHorizontal: 8,
      borderRadius: 999,
      borderWidth: 1,
    },
    lastRunDot: { width: 6, height: 6, borderRadius: 3 },
    lastRunText: { fontSize: 10, fontWeight: '600' },

    sessionTarget: {
      fontSize: 9,
      paddingVertical: 3,
      paddingHorizontal: 8,
      borderRadius: 999,
      fontFamily: 'monospace',
      letterSpacing: 0.3,
    },

    jobActions: { flexDirection: 'row', gap: 6 },
    jobActionBtn: {
      width: 34,
      height: 34,
      borderRadius: 10,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // Empty State
    emptyPlate: {},
    emptyInner: {
      alignItems: 'center',
      paddingVertical: 44,
      paddingHorizontal: 24,
    },
    emptyIconWrap: {
      width: 72,
      height: 72,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 14,
      borderWidth: 1,
    },
    emptyTitle: { fontSize: 16, fontWeight: '700', marginTop: 4 },
    emptyText: { fontSize: 13, marginTop: 4 },
    emptyBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 20,
      paddingVertical: 10,
      paddingHorizontal: 18,
      borderWidth: 1,
      borderRadius: 999,
    },
    emptyBtnText: { fontSize: 13, fontWeight: '700' },

    // Modal
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.75)',
      justifyContent: 'flex-end',
    },
    createModal: {
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      maxHeight: '90%',
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 20,
      borderBottomWidth: 1,
    },
    modalIconWrap: {
      width: 36,
      height: 36,
      borderRadius: 12,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    modalTitle: { fontSize: 18, fontWeight: '700' },
    modalBody: { padding: 20 },

    formGroup: { marginBottom: 20 },
    formLabel: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1.5,
      marginBottom: 8,
      opacity: 0.85,
    },
    formInput: {
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
    },
    formTextarea: { minHeight: 80, textAlignVertical: 'top' },
    formHint: { fontSize: 11, marginTop: 6 },

    segmentedControl: {
      flexDirection: 'row',
      borderRadius: 12,
      padding: 4,
      gap: 4,
    },
    segmentBtn: {
      flex: 1,
      paddingVertical: 10,
      alignItems: 'center',
      borderRadius: 10,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    segmentText: { fontSize: 12 },

    modalFooter: {
      flexDirection: 'row',
      gap: 12,
      padding: 20,
      borderTopWidth: 1,
    },
    cancelBtn: { flex: 1, paddingVertical: 14, alignItems: 'center', borderRadius: 12 },
    cancelBtnText: { fontSize: 14, fontWeight: '600' },
    createBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 14,
      borderRadius: 12,
    },
    createBtnText: { fontSize: 14, fontWeight: '700' },
  });
}

export default CronScreen;
