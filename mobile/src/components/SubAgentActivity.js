/**
 * SubAgentActivity — Real-time sub-agent activity panel
 * Shows running sub-agents with status, progress, and task info
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Animated,
  RefreshControl,
  Modal,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  TERMINAL_COLORS as C,
  TERMINAL_FONTS as F,
  TERMINAL_SPACING as S,
  TERMINAL_RADIUS as R,
  TERMINAL_SHADOWS,
} from '../constants/terminal-theme';
import { useTheme } from '../theme/ThemeProvider';

// Status → Ionicons glyph mapping
const STATUS_ICON = {
  running: 'rocket-outline',
  processing: 'cog-outline',
  completed: 'checkmark-circle',
  done: 'checkmark-circle',
  error: 'warning-outline',
  failed: 'warning-outline',
  stopped: 'flag-outline',
  aborted: 'flag-outline',
  pending: 'hourglass-outline',
  queued: 'clipboard-outline',
};

// Status → Color mapping
const STATUS_COLOR = {
  running: C.gold,
  processing: C.gold,
  completed: C.ok,
  done: C.ok,
  error: C.danger,
  failed: C.danger,
  stopped: C.textMuted,
  aborted: C.textMuted,
  pending: C.info,
  queued: C.info,
};

// Animated progress bar component
function AnimatedProgressBar({ progress = 0, color = C.gold }) {
  const animWidth = useRef(new Animated.Value(0)).current;
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(animWidth, {
      toValue: progress,
      duration: 500,
      useNativeDriver: false,
    }).start();
  }, [progress]);

  // Shimmer effect for active progress
  useEffect(() => {
    if (progress > 0 && progress < 100) {
      const shimmerLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(shimmer, {
            toValue: 1,
            duration: 1500,
            useNativeDriver: true,
          }),
          Animated.timing(shimmer, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ])
      );
      shimmerLoop.start();
      return () => shimmerLoop.stop();
    }
  }, [progress]);

  const shimmerOpacity = shimmer.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.3, 0.8, 0.3],
  });

  return (
    <View style={styles.progressContainer}>
      <Animated.View
        style={[
          styles.progressFill,
          {
            backgroundColor: color,
            width: animWidth.interpolate({
              inputRange: [0, 100],
              outputRange: ['0%', '100%'],
            }),
          },
        ]}
      />
      {progress > 0 && progress < 100 && (
        <Animated.View
          style={[
            styles.progressShimmer,
            {
              opacity: shimmerOpacity,
              backgroundColor: C.textStrong,
            },
          ]}
        />
      )}
      <Text style={styles.progressText}>{Math.round(progress)}%</Text>
    </View>
  );
}

// Format runtime duration
function formatDuration(startTime) {
  if (!startTime) return '--:--';
  
  const start = typeof startTime === 'number' ? startTime : new Date(startTime).getTime();
  const now = Date.now();
  const diffSec = Math.floor((now - start) / 1000);
  
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) {
    const min = Math.floor(diffSec / 60);
    const sec = diffSec % 60;
    return `${min}m ${sec}s`;
  }
  const hrs = Math.floor(diffSec / 3600);
  const min = Math.floor((diffSec % 3600) / 60);
  return `${hrs}h ${min}m`;
}

// Truncate task text
function truncateTask(text, maxLen = 80) {
  if (!text) return 'No task description';
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}

// Single sub-agent card
function SubAgentCard({ agent, onPress }) {
  const { runId, label, status, progress, task, lastUpdateAt, createdAt } = agent;
  
  const iconName = STATUS_ICON[status?.toLowerCase()] || 'help-circle-outline';
  const color = STATUS_COLOR[status?.toLowerCase()] || C.textMuted;
  const isActive = ['running', 'processing', 'pending'].includes(status?.toLowerCase());
  
  // Pulsing animation for active agents
  const pulse = useRef(new Animated.Value(1)).current;
  
  useEffect(() => {
    if (isActive) {
      const pulseLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 0.6, duration: 800, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      );
      pulseLoop.start();
      return () => pulseLoop.stop();
    }
  }, [isActive]);

  return (
    <TouchableOpacity
      style={[styles.card, isActive && styles.cardActive]}
      onPress={() => onPress?.(agent)}
      activeOpacity={0.8}
    >
      {/* Header row: status icon + label + runtime */}
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderLeft}>
          <Animated.View style={isActive && { opacity: pulse }}>
            <Ionicons name={iconName} size={18} color={color} />
          </Animated.View>
          <Text style={[styles.label, { color }]} numberOfLines={1}>
            {label || `Agent ${runId?.slice(0, 8) || 'unknown'}`}
          </Text>
        </View>
        <View style={styles.cardHeaderRight}>
          <Ionicons name="time-outline" size={12} color={C.textDim} />
          <Text style={styles.runtime}>
            {formatDuration(createdAt || lastUpdateAt)}
          </Text>
        </View>
      </View>

      {/* Progress bar */}
      <AnimatedProgressBar progress={progress || 0} color={color} />

      {/* Task snippet */}
      <Text style={styles.task} numberOfLines={2}>
        {truncateTask(task)}
      </Text>

      {/* Status badge */}
      <View style={styles.cardFooter}>
        <View style={[styles.statusBadge, { borderColor: color }]}>
          <Text style={[styles.statusText, { color }]}>
            {(status || 'unknown').toUpperCase()}
          </Text>
        </View>
        <Text style={styles.runId}>
          {runId?.slice(0, 12) || ''}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── Helpers ──────────────────────────────────────────────────

function withAlpha(color, alpha) {
  if (!color) return `rgba(255,255,255,${alpha})`;
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const num = parseInt(hex, 16);
    return `rgba(${(num >> 16) & 0xff},${(num >> 8) & 0xff},${num & 0xff},${alpha})`;
  }
  const m = color.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b] = m[1].split(',').map(p => p.trim());
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── AgentDetailModal — per-agent drill-in ──────────────────

function DetailActivityItem({ item, colors, isLast }) {
  const isSystem = item.role === 'system' || Boolean(item.actionType);
  const isUser = item.role === 'user';

  if (isSystem) {
    return (
      <View style={[
        detailStyles.sysItem,
        isLast && detailStyles.itemLast,
        { borderBottomColor: withAlpha(colors.text || '#fff', 0.05) },
      ]}>
        <View style={[detailStyles.sysIcon, { backgroundColor: withAlpha(colors.primary, 0.1) }]}>
          <Ionicons name="cog-outline" size={12} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[detailStyles.sysText, { color: colors.textSecondary || colors.textMuted }]}>
            {typeof item.content === 'string' ? item.content : ''}
          </Text>
          {item.timestamp ? (
            <Text style={[detailStyles.sysTime, { color: colors.textMuted }]}>{fmtTime(item.timestamp)}</Text>
          ) : null}
        </View>
      </View>
    );
  }

  const roleColor = isUser ? (colors.accent || colors.primary) : colors.primary;
  const rawContent = item.content;
  const displayContent = Array.isArray(rawContent)
    ? rawContent.filter(b => b.type === 'text').map(b => b.text).join('')
    : (rawContent || '');

  return (
    <View style={[
      detailStyles.msgItem,
      isLast && detailStyles.itemLast,
      { backgroundColor: withAlpha(roleColor, 0.04), borderBottomColor: withAlpha(colors.text || '#fff', 0.05) },
    ]}>
      <View style={detailStyles.msgHeader}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name={isUser ? 'person-outline' : 'hardware-chip-outline'} size={11} color={roleColor} />
          <Text style={[detailStyles.msgRole, { color: roleColor }]}>
            {isUser ? 'You' : 'Agent'}
          </Text>
        </View>
        {item.timestamp ? (
          <Text style={[detailStyles.msgTime, { color: colors.textMuted }]}>{fmtTime(item.timestamp)}</Text>
        ) : null}
      </View>
      <Text style={[detailStyles.msgText, { color: colors.text }]}>{displayContent}</Text>
    </View>
  );
}

function AgentDetailModal({ agent, gateway, visible, onClose }) {
  const { colors } = useTheme();
  const { sendReq, status: connStatus, subscribeEvent } = gateway || {};
  const connected = connStatus === 'connected';

  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef(null);
  const pollRef = useRef(null);

  const sessionKey = agent?.sessionKey || agent?.runId || null;
  const runId = agent?.runId || null;

  const load = useCallback(async () => {
    if (!visible || !connected || !sendReq || !agent) return;
    try {
      const items = [];

      // Transcript from sessions.preview (same endpoint FocusModal uses)
      if (sessionKey) {
        try {
          const previewRes = await sendReq('sessions.preview', {
            keys: [sessionKey],
            limit: 80,
            maxChars: 8000,
          });
          const previewItems = previewRes?.previews?.[0]?.items ?? [];
          for (const m of previewItems) {
            items.push({ ...m, timestamp: m.timestamp || m.ts || Date.now() });
          }
        } catch {}
      }

      // Progress updates + checkpoints from subagents.status
      if (runId) {
        try {
          const statusRes = await sendReq('subagents.status', { runId });
          const updates = Array.isArray(statusRes?.subagent?.updates) ? statusRes.subagent.updates : [];
          for (const u of updates) {
            items.push({
              role: 'system',
              actionType: 'progress',
              content: `${(u.status || 'update').toUpperCase()} · ${u.message ?? ''}${u.checkpoint ? ` (${u.checkpoint})` : ''}${typeof u.progress === 'number' ? ` — ${Math.round(u.progress)}%` : ''}`,
              timestamp: u.timestamp || Date.now(),
            });
          }
          const lastActivity = statusRes?.subagent?.lastActivity;
          if (lastActivity?.label) {
            items.push({
              role: 'system',
              actionType: 'activity',
              content: `Now: ${lastActivity.label}`,
              timestamp: lastActivity.at || Date.now(),
            });
          }
        } catch {}
      }

      items.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      setActivity(items);
    } catch {}
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [visible, connected, sendReq, agent, sessionKey, runId]);

  // Mount / unmount polling
  useEffect(() => {
    if (!visible) return undefined;
    setLoading(true);
    setActivity([]);
    load();
    pollRef.current = setInterval(load, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [visible, agent?.runId, load]);

  // Live event subscription for this session
  useEffect(() => {
    if (!visible || !subscribeEvent || !sessionKey) return undefined;
    let timer = null;
    const handler = (payload) => {
      // `chat` streams a delta per token — only settle states are worth a reload.
      if (payload?.state === 'delta') return;
      const key = payload?.sessionKey || payload?.session?.key;
      if (!key || key === sessionKey) {
        if (timer) return;
        timer = setTimeout(() => { timer = null; load(); }, 200);
      }
    };
    const unsubs = [];
    // The gateway has no `sessions.update` event; session transcript changes
    // arrive on `chat` ({ sessionKey, state }).
    try { unsubs.push(subscribeEvent('chat', handler)); } catch {}
    try { unsubs.push(subscribeEvent('subagents.update', handler)); } catch {}
    return () => {
      if (timer) clearTimeout(timer);
      unsubs.forEach(u => { try { u?.(); } catch {} });
    };
  }, [visible, sessionKey, subscribeEvent, load]);

  // Scroll to bottom when new items arrive
  useEffect(() => {
    if (activity.length > 0 && scrollRef.current) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [activity.length]);

  if (!agent) return null;

  const statusIcon = STATUS_ICON[agent.status?.toLowerCase()] || 'help-circle-outline';
  const sColor = STATUS_COLOR[agent.status?.toLowerCase()] || (colors.textMuted || '#a1a1aa');
  const isActive = ['running', 'processing', 'pending'].includes((agent.status || '').toLowerCase());

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[detailStyles.root, { backgroundColor: colors.background || '#050505' }]}>
        {/* Header */}
        <View style={[
          detailStyles.header,
          {
            paddingTop: Platform.OS === 'ios' ? 52 : 24,
            backgroundColor: withAlpha(colors.background || '#050505', 0.98),
            borderBottomColor: withAlpha(colors.primary || '#f59e0b', 0.15),
          },
        ]}>
          <TouchableOpacity onPress={onClose} style={detailStyles.backBtn} hitSlop={10}>
            <Ionicons name="chevron-down" size={22} color={colors.primary || C.gold} />
          </TouchableOpacity>

          <View style={detailStyles.headerContent}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name={statusIcon} size={16} color={sColor} />
              <Text style={[detailStyles.headerTitle, { color: colors.text || C.text, flex: 1 }]} numberOfLines={1}>
                {agent.label || `Agent ${String(agent.runId || '').slice(0, 8)}`}
              </Text>
            </View>
            <Text style={[detailStyles.headerSub, { color: colors.textMuted || C.textMuted }]} numberOfLines={1}>
              {agent.runId ? String(agent.runId).slice(0, 20) : '—'}
            </Text>
          </View>

          <View style={[
            detailStyles.statusBadge,
            { borderColor: withAlpha(sColor, 0.5), backgroundColor: withAlpha(sColor, 0.12) },
          ]}>
            <Text style={[detailStyles.statusText, { color: sColor }]}>
              {(agent.status || 'unknown').toUpperCase()}
            </Text>
          </View>
        </View>

        {/* Progress bar */}
        {typeof agent.progress === 'number' ? (
          <View style={[
            detailStyles.progressWrap,
            { borderBottomColor: withAlpha(colors.primary || C.gold, 0.1) },
          ]}>
            <View style={[
              detailStyles.progressTrack,
              { backgroundColor: withAlpha(colors.primary || C.gold, 0.08) },
            ]}>
              <View style={[
                detailStyles.progressFill,
                { width: `${Math.max(2, Math.min(100, agent.progress))}%`, backgroundColor: sColor },
              ]} />
            </View>
            <Text style={[detailStyles.progressPct, { color: sColor }]}>
              {Math.round(agent.progress)}%
            </Text>
          </View>
        ) : null}

        {/* Task */}
        {agent.task ? (
          <View style={[
            detailStyles.taskWrap,
            { borderBottomColor: withAlpha(colors.primary || C.gold, 0.1) },
          ]}>
            <Text style={[detailStyles.taskLabel, { color: colors.textMuted || C.textMuted }]}>TASK</Text>
            <Text style={[detailStyles.taskText, { color: colors.text || C.text }]} numberOfLines={4}>
              {agent.task}
            </Text>
          </View>
        ) : null}

        {/* Activity feed */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={detailStyles.feedContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={colors.primary || C.gold}
            />
          }
        >
          {loading ? (
            <View style={detailStyles.centerWrap}>
              <ActivityIndicator size="large" color={colors.primary || C.gold} />
              <Text style={[detailStyles.loadingText, { color: colors.textMuted || C.textMuted }]}>
                Loading activity…
              </Text>
            </View>
          ) : activity.length === 0 ? (
            <View style={detailStyles.centerWrap}>
              <Ionicons name="pulse-outline" size={36} color={colors.textMuted || C.textMuted} />
              <Text style={[detailStyles.emptyText, { color: colors.textSecondary || C.textMuted }]}>
                No activity yet
              </Text>
              <Text style={[detailStyles.emptyHint, { color: colors.textMuted || C.textDim }]}>
                {isActive
                  ? 'Events will appear as the agent runs.'
                  : 'This run has no recorded events.'}
              </Text>
            </View>
          ) : (
            activity.map((item, idx) => (
              <DetailActivityItem
                key={`${item.timestamp || idx}-${idx}`}
                item={item}
                colors={colors}
                isLast={idx === activity.length - 1}
              />
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const detailStyles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingBottom: 12, paddingHorizontal: 16, gap: 12,
    borderBottomWidth: 1,
  },
  backBtn: { padding: 4 },
  headerContent: { flex: 1, gap: 3 },
  headerTitle: { fontSize: 15, fontWeight: '700' },
  headerSub: {
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderRadius: 999 },
  statusText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },

  progressWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, borderBottomWidth: 1,
  },
  progressTrack: { flex: 1, height: 5, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 5, borderRadius: 3 },
  progressPct: { fontSize: 11, fontWeight: '700', minWidth: 36, textAlign: 'right' },

  taskWrap: { padding: 12, borderBottomWidth: 1 },
  taskLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  taskText: { fontSize: 12, lineHeight: 18 },

  feedContent: { padding: 12, paddingBottom: 48 },
  centerWrap: { paddingTop: 60, alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 13 },
  emptyText: { fontSize: 14, fontWeight: '600', marginTop: 8 },
  emptyHint: { fontSize: 12, textAlign: 'center', opacity: 0.75, marginHorizontal: 24 },

  sysItem: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sysIcon: {
    width: 24, height: 24, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  sysText: { fontSize: 11, lineHeight: 17 },
  sysTime: { fontSize: 9, marginTop: 3 },

  msgItem: {
    paddingVertical: 10, paddingHorizontal: 10,
    borderRadius: 8, marginBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  msgHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 5,
  },
  msgRole: { fontSize: 10, fontWeight: '700' },
  msgTime: { fontSize: 9 },
  msgText: { fontSize: 12, lineHeight: 18 },

  itemLast: { borderBottomWidth: 0 },
});

// Main component
export function SubAgentActivity({ gateway, onAgentPress, style, compact = false }) {
  const { sendReq, status: connStatus } = gateway || {};
  const [subagents, setSubagents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(true);
  const pollTimer = useRef(null);

  // Built-in per-agent drill-in — opened when onAgentPress is not provided
  const [detailAgent, setDetailAgent] = useState(null);

  // Fetch sub-agents
  const fetchSubagents = useCallback(async () => {
    if (!sendReq || connStatus !== 'connected') return;
    
    try {
      setError(null);
      const result = await sendReq('subagents.list', { includeCompleted: true, limit: 50 });
      
      if (result?.ok !== false && Array.isArray(result?.subagents)) {
        setSubagents(result.subagents);
      } else if (result?.subagents) {
        setSubagents(result.subagents);
      }
    } catch (err) {
      // Don't show error for missing method - just means no sub-agents API
      if (!err.message?.includes('method') && !err.message?.includes('scope')) {
        setError(err.message);
      }
      setSubagents([]);
    }
  }, [sendReq, connStatus]);

  // Initial fetch + polling
  useEffect(() => {
    fetchSubagents();
    
    // Poll every 5 seconds when connected
    pollTimer.current = setInterval(() => {
      if (connStatus === 'connected') {
        fetchSubagents();
      }
    }, 5000);

    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
      }
    };
  }, [connStatus, fetchSubagents]);

  // Manual refresh
  const onRefresh = useCallback(async () => {
    setLoading(true);
    await fetchSubagents();
    setLoading(false);
  }, [fetchSubagents]);

  // Count active agents
  const activeCount = subagents.filter(a => 
    ['running', 'processing', 'pending'].includes(a.status?.toLowerCase())
  ).length;

  // Compact mode - just show count badge
  if (compact) {
    if (activeCount === 0) return null;
    
    return (
      <TouchableOpacity 
        style={styles.compactBadge}
        onPress={() => setExpanded(!expanded)}
      >
        <Ionicons name="rocket-outline" size={12} color={C.gold} />
        <Text style={styles.compactCount}>{activeCount}</Text>
      </TouchableOpacity>
    );
  }

  // No sub-agents and no error - show nothing or minimal state
  if (subagents.length === 0 && !error) {
    return (
      <View style={[styles.container, styles.containerEmpty, style]}>
        <View style={styles.headerRow}>
          <Ionicons name="git-branch-outline" size={14} color={C.textDim} />
          <Text style={styles.headerTitle}>SUB-AGENTS</Text>
          <Text style={styles.headerCount}>0 active</Text>
        </View>
        <Text style={styles.emptyText}>No sub-agents running</Text>
        <AgentDetailModal
          agent={detailAgent}
          gateway={gateway}
          visible={Boolean(detailAgent)}
          onClose={() => setDetailAgent(null)}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, style]}>
      {/* Header */}
      <TouchableOpacity 
        style={styles.headerRow}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <Ionicons name="git-branch-outline" size={14} color={C.gold} />
        <Text style={styles.headerTitle}>SUB-AGENTS</Text>
        <Text style={styles.headerCount}>
          {activeCount > 0 ? `${activeCount} active` : `${subagents.length} total`}
        </Text>
        <Ionicons 
          name={expanded ? 'chevron-up' : 'chevron-down'} 
          size={16} 
          color={C.textMuted} 
        />
      </TouchableOpacity>

      {error && (
        <View style={styles.errorRow}>
          <Ionicons name="warning" size={12} color={C.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {expanded && (
        <FlatList
          data={subagents}
          keyExtractor={(item) => item.runId || `agent-${Math.random()}`}
          renderItem={({ item }) => (
            <SubAgentCard
              agent={item}
              onPress={(agent) => {
                if (onAgentPress) {
                  onAgentPress(agent);
                } else {
                  setDetailAgent(agent);
                }
              }}
            />
          )}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={onRefresh}
              tintColor={C.gold}
              colors={[C.gold]}
              progressBackgroundColor={C.bg1}
            />
          }
          ListEmptyComponent={
            <Text style={styles.emptyText}>No sub-agents found</Text>
          }
        />
      )}

      {/* Per-agent drill-in modal — opens on card tap when no onAgentPress handler provided */}
      <AgentDetailModal
        agent={detailAgent}
        gateway={gateway}
        visible={Boolean(detailAgent)}
        onClose={() => setDetailAgent(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: C.bg1,
    borderRadius: R.panel,
    borderWidth: 1,
    borderColor: C.goldBorder,
    overflow: 'hidden',
    maxHeight: 400,
  },
  containerEmpty: {
    paddingBottom: S.md,
  },

  // Header
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    backgroundColor: C.panelHeader,
    borderBottomWidth: 1,
    borderBottomColor: C.goldBorder,
    gap: S.sm,
  },
  headerTitle: {
    ...F.panelTitle,
    color: C.textMuted,
    flex: 1,
  },
  headerCount: {
    ...F.tiny,
    color: C.gold,
  },

  // Error
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.md,
    paddingVertical: S.xs,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    gap: S.xs,
  },
  errorText: {
    ...F.small,
    color: C.danger,
  },

  // List
  list: {
    flex: 1,
  },
  listContent: {
    padding: S.sm,
    gap: S.sm,
  },

  // Card
  card: {
    backgroundColor: C.bg2,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.border,
    padding: S.md,
    gap: S.sm,
  },
  cardActive: {
    borderColor: C.goldBorder,
    ...TERMINAL_SHADOWS.glow,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.sm,
    flex: 1,
  },
  cardHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  emoji: {
    fontSize: 18,
  },
  label: {
    ...F.body,
    fontWeight: '600',
    flex: 1,
  },
  runtime: {
    ...F.tiny,
    color: C.textDim,
  },

  // Progress
  progressContainer: {
    height: 16,
    backgroundColor: C.bg0,
    borderRadius: R.xs,
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
  },
  progressFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: R.xs,
  },
  progressShimmer: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    right: 0,
    borderRadius: R.xs,
  },
  progressText: {
    ...F.tiny,
    color: C.textStrong,
    textAlign: 'center',
    zIndex: 1,
  },

  // Task
  task: {
    ...F.small,
    color: C.textMuted,
    lineHeight: 18,
  },

  // Footer
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: S.xs,
  },
  statusBadge: {
    paddingHorizontal: S.sm,
    paddingVertical: 2,
    borderRadius: R.xs,
    borderWidth: 1,
  },
  statusText: {
    ...F.status,
    fontSize: 8,
  },
  runId: {
    ...F.code,
    fontSize: 10,
    color: C.textDim,
  },

  // Empty
  emptyText: {
    ...F.small,
    color: C.textDim,
    textAlign: 'center',
    paddingVertical: S.lg,
  },

  // Compact badge
  compactBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.goldSubtle,
    paddingHorizontal: S.sm,
    paddingVertical: S.xs,
    borderRadius: R.sm,
    gap: 4,
  },
  compactEmoji: {
    fontSize: 12,
  },
  compactCount: {
    ...F.tiny,
    color: C.gold,
  },
});

export default SubAgentActivity;
