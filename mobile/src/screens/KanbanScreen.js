import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  FlatList, RefreshControl, Modal, TextInput, ActivityIndicator,
  Animated, Dimensions, Vibration, Alert, Platform,
  useWindowDimensions, Switch, Linking,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { GlassCard } from '../components/GlassCard';
import { GlassSurface } from '../components/GlassSurface';
import { GlowButton } from '../components/GlowButton';
import { NotionCheckbox } from '../components/NotionCheckbox';
import { SwipeableTaskCard } from '../components/SwipeableTaskCard';
import { ViewToggle } from '../components/ViewToggle';
import { DOCK_BOTTOM_SPACE } from '../components/FloatingDock';
import { FONTS, SPACING, DEPTH, GLASS_TINT } from '../constants/theme';
import { useTheme } from '../theme/ThemeProvider';
import { useKanban } from '../hooks/useKanban';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';
import { withAlpha } from '../theme/color-utils';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFederation } from '../hooks/useFederation';
import BlockRenderer from '../components/BlockRenderer';
import { ProjectField } from '../components/ProjectPicker';
import { useProjectCatalog } from '../lib/useProjectCatalog';
import { ClientField } from '../components/ClientPicker';
import { DateField } from '../components/DatePicker';
import { useClientCatalog } from '../lib/useClientCatalog';
import { findClient } from '../lib/client-picker-model';
import { splitWhen } from '../lib/date-pick';
import { useSecureMode } from '../secure/useSecureMode';
import { SecureModeBar, secureFrameStyle } from '../secure/SecureControls';
import { SecureBoard } from '../secure/SecureBoard';

const PAGE_MODE_KEY = '@infinibot/kanban_page_mode';
const VIEW_MODE_KEY = (pm) => `@infinibot/kanban_view_mode.${pm || 'tasks'}`;
const VALID_VIEW_MODES = ['board', 'gallery', 'list'];
const HIDE_SUB_PROJECTS_KEY = '@infinibot/hide_sub_projects';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const COLUMN_WIDTH = SCREEN_WIDTH * 0.78;
// Two-column gallery: (screen - outer margin*2 - inter-card gap) / 2
const GALLERY_CARD_WIDTH = (SCREEN_WIDTH - SPACING.md * 2 - SPACING.sm) / 2;

function fmtRelativeShort(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 2) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

// ─── palette-aware token factories ──────────────────────────────────────────
// All visual colour tokens here come from the live `colors` map — when the
// master device pushes a new palette, every screen consumer re-renders.

function getColumns(colors) {
  return [
    { key: 'backlog',     label: 'Backlog',     color: colors.textMuted,    icon: 'file-tray-outline' },
    { key: 'todo',        label: 'To Do',       color: colors.warning,      icon: 'list-outline' },
    { key: 'in_progress', label: 'In Progress', color: colors.primary,      icon: 'play-circle-outline' },
    { key: 'review',      label: 'Review',      color: colors.secondary,    icon: 'eye-outline' },
    { key: 'done',        label: 'Done',        color: colors.success,      icon: 'checkmark-circle-outline' },
  ];
}

function getPriorityColors(colors) {
  return {
    critical: colors.error,
    high:     colors.warning,
    medium:   colors.primary,
    low:      colors.textMuted,
  };
}

function getProjectStatuses(colors) {
  return [
    { key: 'Not started', label: 'Not Started', color: colors.warning },
    { key: 'In progress', label: 'In Progress', color: colors.primary },
    { key: 'Reviewing',   label: 'Reviewing',   color: colors.secondary },
  ];
}

function getStatusGroups(colors) {
  return [
    { key: 'In progress',     label: 'In Progress',     color: colors.primary,   icon: 'play-circle-outline' },
    { key: 'Not started',     label: 'Not Started',     color: colors.warning,   icon: 'time-outline' },
    { key: 'Reviewing',       label: 'Reviewing',       color: colors.secondary, icon: 'eye-outline' },
    { key: 'Paused',          label: 'Paused',          color: colors.warning,   icon: 'pause-circle-outline' },
    { key: 'Updating',        label: 'Updating',        color: colors.info,      icon: 'refresh-outline' },
    { key: 'Awaiting Client', label: 'Awaiting Client', color: colors.warning,   icon: 'hourglass-outline' },
    { key: 'Completed',       label: 'Completed',       color: colors.success,   icon: 'checkmark-circle-outline' },
    { key: 'Cancelled',       label: 'Cancelled',       color: colors.error,     icon: 'close-circle-outline' },
  ];
}

const PRIORITY_ICONS = {
  critical: 'alert-circle',
  high:     'arrow-up-circle',
  medium:   'remove-circle',
  low:      'arrow-down-circle',
};

const PROJECT_FILTERS = [
  { key: 'all',       label: 'All' },
  { key: 'active',    label: 'Active' },
  { key: 'completed', label: 'Completed' },
  { key: 'ai',        label: 'AI Projects' },
];

const PRIORITY_FILTERS = ['All', 'Critical', 'High', 'Medium', 'Low'];
const SORT_OPTIONS    = ['Priority', 'Date', 'Name'];

// ─── small reusable glass primitives ────────────────────────────────────────

function TopHighlight({ radius = 16, opacity = 0.08 }) {
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[`rgba(255,255,255,${opacity})`, 'rgba(255,255,255,0)']}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={[StyleSheet.absoluteFill, { borderTopLeftRadius: radius, borderTopRightRadius: radius }]}
    />
  );
}

function GlassChip({ active, onPress, children, accent, depth = 1, style }) {
  const ringColor = accent || 'rgba(255,255,255,0.18)';
  const depthCfg  = DEPTH[depth];
  const blurI     = Platform.OS === 'android' ? 35 : 45;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[chipStyles.touch, depthCfg.shadow, style]}
    >
      <View style={chipStyles.clip}>
        <BlurView intensity={blurI} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: GLASS_TINT.dark }]} />
        <LinearGradient
          colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: 999,
              borderWidth: active ? 1.4 : StyleSheet.hairlineWidth,
              borderTopColor:    active ? ringColor : 'rgba(255,255,255,0.16)',
              borderLeftColor:   active ? withAlpha(ringColor, 0.7) : 'rgba(255,255,255,0.06)',
              borderRightColor:  active ? withAlpha(ringColor, 0.7) : 'rgba(255,255,255,0.06)',
              borderBottomColor: active ? withAlpha(ringColor, 0.5) : 'rgba(255,255,255,0.04)',
            },
          ]}
        />
        {active && (
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: withAlpha(ringColor, 0.18), borderRadius: 999 },
            ]}
          />
        )}
        <View style={chipStyles.row}>{children}</View>
      </View>
    </TouchableOpacity>
  );
}

const chipStyles = StyleSheet.create({
  touch: {
    borderRadius: 999,
    marginRight: 8,
  },
  clip: {
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
});

// ─── pulsing dot for empty states ───────────────────────────────────────────
function PulseIcon({ icon, color, size = 36 }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1500, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const scale   = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });
  return (
    <Animated.View style={{ transform: [{ scale }], opacity }}>
      <Ionicons name={icon} size={size} color={color} />
    </Animated.View>
  );
}

// ─── TaskCard ───────────────────────────────────────────────────────────────
function TaskCard({ task, onPress, onToggleDone, onLongPress, index, showProject, projects, isMoving }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const PRIORITY_COLORS = useMemo(() => getPriorityColors(colors), [colors]);

  const isOverdue = task.dueDate && new Date(task.dueDate) < new Date();
  const priorityColor = PRIORITY_COLORS[task.priority] || colors.textMuted;
  const projectName = showProject && task.projectId
    ? (projects || []).find(p => p.id === task.projectId)?.name
    : null;

  const handleCheckboxToggle = (newValue) => {
    onToggleDone?.(task.id, newValue);
  };

  return (
    <GlassCard
      style={[
        styles.taskCard,
        { borderLeftWidth: 3, borderLeftColor: priorityColor },
        isMoving && {
          borderColor: colors.primary,
          borderWidth: 2,
          shadowColor: colors.primary,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.55,
          shadowRadius: 14,
          elevation: 12,
        },
      ]}
      animated={!isMoving}
      delay={index * 40}
      glow={task.priority === 'critical' || isMoving}
    >
      <TopHighlight />
      <TouchableOpacity
        onPress={() => onPress(task)}
        onLongPress={() => { Vibration.vibrate(50); onLongPress?.(task); }}
        activeOpacity={0.7}
        delayLongPress={400}
      >
        {isMoving && (
          <View style={styles.movingBadge}>
            <Ionicons name="move" size={12} color={colors.primary} />
            <Text style={styles.movingBadgeText}>Moving… tap a column</Text>
          </View>
        )}
        <View style={styles.taskHeader}>
          <View style={styles.taskCheckRow}>
            <NotionCheckbox
              checked={task.done}
              onChange={handleCheckboxToggle}
              size={20}
            />
            <Text style={[styles.taskTitle, task.done && styles.taskTitleDone]} numberOfLines={2}>
              {task.title}
            </Text>
          </View>
          <View style={[styles.priorityPill, { borderColor: withAlpha(priorityColor, 0.4), backgroundColor: withAlpha(priorityColor, 0.14) }]}>
            <Ionicons
              name={PRIORITY_ICONS[task.priority] || 'remove-circle-outline'}
              size={11}
              color={priorityColor}
            />
          </View>
        </View>

        {projectName && (
          <View style={styles.taskMetaRow}>
            <Ionicons name="folder-outline" size={12} color={colors.secondary} />
            <Text style={[styles.taskMetaText, { color: colors.secondary }]} numberOfLines={1}>{projectName}</Text>
          </View>
        )}

        {task.assignee && (
          <View style={styles.taskMetaRow}>
            <Ionicons name="person-outline" size={12} color={colors.textSecondary} />
            <Text style={styles.taskMetaText}>{task.assignee}</Text>
          </View>
        )}

        {task.dueDate && (
          <View style={styles.taskMetaRow}>
            <Ionicons name="calendar-outline" size={12} color={isOverdue ? colors.error : colors.textMuted} />
            <Text style={[styles.taskMetaText, isOverdue && { color: colors.error }]}>
              {task.dueDate}
            </Text>
          </View>
        )}

        {task.department?.length > 0 && (
          <View style={styles.tagRow}>
            {task.department.map((d, i) => (
              <View key={i} style={styles.tag}>
                <Text style={styles.tagText}>{d}</Text>
              </View>
            ))}
          </View>
        )}

        {!isMoving && (
          <View style={styles.dragHint}>
            <Ionicons name="move-outline" size={12} color={colors.textMuted} />
          </View>
        )}
      </TouchableOpacity>
    </GlassCard>
  );
}

// ─── TaskEditModal ──────────────────────────────────────────────────────────
function TaskEditModal({ task, visible, onClose, onStatusChange, onPriorityChange, onToggleDone, onUpdate, onOpenAllProperties, onAddToAutonomy, projectCatalog, clientCatalog, sendReq }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const PRIORITY_COLORS = useMemo(() => getPriorityColors(colors), [colors]);
  const COLUMNS = useMemo(() => getColumns(colors), [colors]);

  const [editMode, setEditMode] = useState(false);
  const [title, setTitle] = useState('');
  const [taskProjectId, setTaskProjectId] = useState(null);
  const [taskClientId, setTaskClientId] = useState(null);
  const [taskDue, setTaskDue] = useState(null);

  useEffect(() => {
    if (task) {
      setTitle(task.title || '');
      setEditMode(false);
      setTaskProjectId(task.projectId && task.projectId !== 'default' ? task.projectId : null);
      setTaskDue(splitWhen(task.dueDate).date);
      // The client: on the row (capture / Notion "Customer"), else the relation index.
      const direct = task.clientId || findClient(clientCatalog?.clients, task.customerNotionIds?.[0])?.id || null;
      setTaskClientId(direct);
      if (!direct && sendReq) {
        let live = true;
        sendReq('relations.list', { type: 'task', id: task.id, peerType: 'client' })
          .then((res) => {
            const first = (Array.isArray(res) ? res : res?.relations || res?.items || [])[0];
            const id = first?.id || first?.peerId;
            if (live && id) setTaskClientId(id);
          })
          .catch(() => {});
        return () => {
          live = false;
        };
      }
    }
    return undefined;
  }, [task]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!task) return null;

  const handleSaveTitle = () => {
    if (title.trim() && title !== task.title) {
      onUpdate?.(task.id, { title: title.trim() });
    }
    setEditMode(false);
  };

  const blurI = Platform.OS === 'android' ? 60 : 80;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.sheetOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheetContent} onPress={() => { /* swallow */ }}>
          <View style={[styles.sheetCard, DEPTH[3].shadow]}>
            <View style={styles.sheetClip}>
              <BlurView intensity={blurI} tint="dark" style={StyleSheet.absoluteFill} />
              <View style={[StyleSheet.absoluteFill, { backgroundColor: GLASS_TINT.dark }]} />
              <LinearGradient
                colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 0.4 }}
                style={StyleSheet.absoluteFill}
              />
              <View
                pointerEvents="none"
                style={[
                  StyleSheet.absoluteFill,
                  {
                    borderTopLeftRadius:  24,
                    borderTopRightRadius: 24,
                    borderWidth: 1,
                    borderTopColor:    'rgba(255,255,255,0.14)',
                    borderLeftColor:   'rgba(255,255,255,0.05)',
                    borderRightColor:  'rgba(255,255,255,0.05)',
                    borderBottomColor: 'rgba(255,255,255,0.03)',
                  },
                ]}
              />
              <View style={styles.sheetInner}>
                {/* Drag handle */}
                <View style={styles.sheetGrabber} />

                {/* Header */}
                <View style={styles.sheetHeader}>
                  <NotionCheckbox
                    checked={task.done}
                    onChange={(val) => onToggleDone?.(task.id, val)}
                    size={24}
                  />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    {editMode ? (
                      <TextInput
                        style={styles.sheetTitleInput}
                        value={title}
                        onChangeText={setTitle}
                        onBlur={handleSaveTitle}
                        onSubmitEditing={handleSaveTitle}
                        autoFocus
                        multiline
                      />
                    ) : (
                      <TouchableOpacity onPress={() => setEditMode(true)}>
                        <Text style={[styles.sheetTitle, task.done && styles.taskTitleDone]} numberOfLines={3}>
                          {task.title}
                        </Text>
                        <Text style={styles.sheetEditHint}>Tap to edit</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                {/* Meta info */}
                <View style={styles.sheetMetaSection}>
                  {task.assignee && (
                    <View style={styles.sheetMetaRow}>
                      <Ionicons name="person-outline" size={14} color={colors.textSecondary} />
                      <Text style={styles.sheetMetaText}>{task.assignee}</Text>
                    </View>
                  )}
                </View>

                {/* Due date (calendar + quick chips) */}
                <View style={{ marginBottom: 12 }}>
                  <DateField
                    label="Due"
                    empty="No due date"
                    date={taskDue}
                    allowTime={false}
                    onChange={({ date }) => {
                      const next = date || null;
                      if (next === taskDue) return;
                      setTaskDue(next);
                      onUpdate?.(task.id, { dueDate: next });
                    }}
                    testID="task-due"
                  />
                </View>

                {/* Project (searchable picker over every project) */}
                {projectCatalog ? (
                  <View style={{ marginBottom: 12 }}>
                    <ProjectField
                      catalog={projectCatalog}
                      projectId={taskProjectId}
                      onChange={(p) => {
                        const next = p?.id || null;
                        if (next === taskProjectId) return;
                        setTaskProjectId(next);
                        onUpdate?.(task.id, { projectId: next });
                      }}
                      testID="task-project"
                    />
                  </View>
                ) : null}

                {/* CRM client (searchable picker over every client) */}
                {clientCatalog ? (
                  <View style={{ marginBottom: 12 }}>
                    <ClientField
                      catalog={clientCatalog}
                      clientId={taskClientId}
                      onChange={(c) => {
                        const next = c?.id || null;
                        if (next === taskClientId) return;
                        const previousClientId = taskClientId;
                        setTaskClientId(next);
                        onUpdate?.(task.id, { clientId: next, previousClientId });
                      }}
                      testID="task-client"
                    />
                  </View>
                ) : null}

                {/* Priority selector */}
                <Text style={styles.sheetSectionLabel}>Priority</Text>
                <View style={styles.prioritySelector}>
                  {['low', 'medium', 'high', 'critical'].map(p => {
                    const isActive = task.priority === p;
                    const pColor = PRIORITY_COLORS[p];
                    return (
                      <TouchableOpacity
                        key={p}
                        style={[
                          styles.prioritySelectorBtn,
                          isActive && { backgroundColor: withAlpha(pColor, 0.18), borderColor: pColor },
                        ]}
                        onPress={() => {
                          if (!isActive) onPriorityChange?.(task.id, p);
                        }}
                      >
                        <Ionicons name={PRIORITY_ICONS[p]} size={14} color={isActive ? pColor : colors.textMuted} />
                        <Text style={[styles.prioritySelectorText, isActive && { color: pColor, fontWeight: '700' }]}>
                          {p.charAt(0).toUpperCase() + p.slice(1)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Status selector */}
                <Text style={styles.sheetSectionLabel}>Status</Text>
                <View style={styles.sheetActions}>
                  {COLUMNS.map(col => {
                    const isCurrent = col.key === task.status;
                    return (
                      <TouchableOpacity
                        key={col.key}
                        style={[
                          styles.sheetBtn,
                          { borderColor: withAlpha(col.color, 0.28) },
                          isCurrent && { backgroundColor: withAlpha(col.color, 0.16), borderColor: col.color },
                        ]}
                        onPress={() => {
                          if (!isCurrent) onStatusChange(task.id, col.key);
                        }}
                      >
                        <Ionicons name={col.icon} size={16} color={isCurrent ? col.color : colors.textMuted} />
                        <Text style={[
                          styles.sheetBtnText,
                          isCurrent && { color: col.color, fontWeight: '700' },
                        ]}>
                          {col.label}
                        </Text>
                        {isCurrent && (
                          <Ionicons name="checkmark" size={14} color={col.color} style={{ marginLeft: 'auto' }} />
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Edit All Properties button */}
                <TouchableOpacity
                  style={styles.editAllPropertiesBtn}
                  onPress={() => {
                    onClose?.();
                    onOpenAllProperties?.(task);
                  }}
                >
                  <MaterialCommunityIcons name="database-edit-outline" size={16} color={colors.primary} />
                  <Text style={styles.editAllPropertiesText}>Edit All Properties</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                </TouchableOpacity>

                {/* Add to Autonomy button */}
                <TouchableOpacity
                  style={[styles.editAllPropertiesBtn, { borderColor: withAlpha(colors.success, 0.4), marginTop: 8 }]}
                  onPress={() => {
                    onClose?.();
                    onAddToAutonomy?.(task);
                  }}
                >
                  <Ionicons name="shield-checkmark" size={16} color={colors.success} />
                  <Text style={[styles.editAllPropertiesText, { color: colors.success }]}>Add to Autonomy Queue</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                </TouchableOpacity>

                {/* Close button */}
                <TouchableOpacity style={styles.sheetCloseBtn} onPress={onClose}>
                  <LinearGradient
                    colors={[colors.primary, withAlpha(colors.primary, 0.85)]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={StyleSheet.absoluteFill}
                  />
                  <Text style={styles.sheetCloseBtnText}>Done</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ─── Modal scaffold (used by Create modals) ─────────────────────────────────
function GlassModalScaffold({ title, children, colors }) {
  const blurI = Platform.OS === 'android' ? 60 : 80;
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.sheetCard, DEPTH[3].shadow]}>
      <View style={styles.sheetClip}>
        <BlurView intensity={blurI} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: GLASS_TINT.dark }]} />
        <LinearGradient
          colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 0.4 }}
          style={StyleSheet.absoluteFill}
        />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              borderTopLeftRadius:  24,
              borderTopRightRadius: 24,
              borderWidth: 1,
              borderTopColor:    'rgba(255,255,255,0.14)',
              borderLeftColor:   'rgba(255,255,255,0.05)',
              borderRightColor:  'rgba(255,255,255,0.05)',
              borderBottomColor: 'rgba(255,255,255,0.03)',
            },
          ]}
        />
        <View style={styles.sheetInner}>
          <View style={styles.sheetGrabber} />
          <Text style={styles.modalTitle}>{title}</Text>
          {children}
        </View>
      </View>
    </View>
  );
}

// ─── CreateTaskModal ────────────────────────────────────────────────────────
function CreateTaskModal({ visible, onClose, onCreate, projectId }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const PRIORITY_COLORS = useMemo(() => getPriorityColors(colors), [colors]);
  const COLUMNS = useMemo(() => getColumns(colors), [colors]);

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('medium');
  const [status, setStatus] = useState('todo');

  const handleCreate = () => {
    if (!title.trim()) return;
    onCreate(projectId, title.trim(), { priority, status });
    setTitle('');
    setPriority('medium');
    setStatus('todo');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => { /* swallow */ }}>
          <GlassModalScaffold title="New Task" colors={colors}>
            <TextInput
              style={styles.modalInput}
              value={title}
              onChangeText={setTitle}
              placeholder="Task title…"
              placeholderTextColor={colors.textMuted}
              autoFocus
            />

            <Text style={styles.modalLabel}>Priority</Text>
            <View style={styles.priorityRow}>
              {['low', 'medium', 'high', 'critical'].map(p => (
                <TouchableOpacity
                  key={p}
                  style={[styles.priorityBtn, priority === p && {
                    backgroundColor: withAlpha(PRIORITY_COLORS[p], 0.18),
                    borderColor: PRIORITY_COLORS[p],
                  }]}
                  onPress={() => setPriority(p)}
                >
                  <Ionicons
                    name={PRIORITY_ICONS[p]}
                    size={14}
                    color={priority === p ? PRIORITY_COLORS[p] : colors.textMuted}
                  />
                  <Text style={[styles.priorityBtnText, priority === p && { color: PRIORITY_COLORS[p] }]}>
                    {p}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.modalLabel}>Status</Text>
            <View style={styles.statusRow}>
              {COLUMNS.slice(0, 3).map(col => (
                <TouchableOpacity
                  key={col.key}
                  style={[styles.statusBtn, status === col.key && {
                    backgroundColor: withAlpha(col.color, 0.18),
                    borderColor: col.color,
                  }]}
                  onPress={() => setStatus(col.key)}
                >
                  <Ionicons name={col.icon} size={14} color={status === col.key ? col.color : colors.textMuted} />
                  <Text style={[styles.statusBtnText, status === col.key && { color: col.color }]}>
                    {col.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.modalActions}>
              <GlowButton title="Cancel" onPress={onClose} variant="ghost" size="md" />
              <GlowButton title="Create" onPress={handleCreate} variant="primary" size="md" disabled={!title.trim()} />
            </View>
          </GlassModalScaffold>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ─── CreateProjectModal ─────────────────────────────────────────────────────
function CreateProjectModal({ visible, onClose, onCreate }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const PRIORITY_COLORS = useMemo(() => getPriorityColors(colors), [colors]);
  const PROJECT_STATUSES = useMemo(() => getProjectStatuses(colors), [colors]);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [status, setStatus] = useState('Not started');
  const [active, setActive] = useState(false);

  const handleCreate = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), { priority, status, description: description.trim() || undefined, active });
    setName('');
    setDescription('');
    setPriority('medium');
    setStatus('Not started');
    setActive(false);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => { /* swallow */ }}>
          <GlassModalScaffold title="New Project" colors={colors}>
            <TextInput
              style={styles.modalInput}
              value={name}
              onChangeText={setName}
              placeholder="Project name…"
              placeholderTextColor={colors.textMuted}
              autoFocus
            />
            <TextInput
              style={[styles.modalInput, { minHeight: 60, textAlignVertical: 'top', marginTop: SPACING.sm }]}
              value={description}
              onChangeText={setDescription}
              placeholder="Description (optional)…"
              placeholderTextColor={colors.textMuted}
              multiline
            />

            <Text style={styles.modalLabel}>Priority</Text>
            <View style={styles.priorityRow}>
              {['low', 'medium', 'high', 'critical'].map(p => (
                <TouchableOpacity
                  key={p}
                  style={[styles.priorityBtn, priority === p && {
                    backgroundColor: withAlpha(PRIORITY_COLORS[p], 0.18),
                    borderColor: PRIORITY_COLORS[p],
                  }]}
                  onPress={() => setPriority(p)}
                >
                  <Ionicons
                    name={PRIORITY_ICONS[p]}
                    size={14}
                    color={priority === p ? PRIORITY_COLORS[p] : colors.textMuted}
                  />
                  <Text style={[styles.priorityBtnText, priority === p && { color: PRIORITY_COLORS[p] }]}>
                    {p}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.modalLabel}>Status</Text>
            <View style={styles.statusRow}>
              {PROJECT_STATUSES.map(s => (
                <TouchableOpacity
                  key={s.key}
                  style={[styles.statusBtn, status === s.key && {
                    backgroundColor: withAlpha(s.color, 0.18),
                    borderColor: s.color,
                  }]}
                  onPress={() => setStatus(s.key)}
                >
                  <View style={[styles.statusDot, { backgroundColor: s.color }]} />
                  <Text style={[styles.statusBtnText, status === s.key && { color: s.color }]}>
                    {s.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: SPACING.md, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: active ? COLORS.primaryStrong : 'rgba(255,255,255,0.06)', backgroundColor: active ? COLORS.primaryDim : 'transparent' }}>
              <View>
                <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>Active Client Project</Text>
                <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>Surface on Business Command Center</Text>
              </View>
              <Switch
                value={active}
                onValueChange={setActive}
                trackColor={{ false: 'rgba(255,255,255,0.10)', true: COLORS.glowStrong }}
                thumbColor={active ? COLORS.primary : colors.textMuted}
              />
            </View>

            <View style={styles.modalActions}>
              <GlowButton title="Cancel" onPress={onClose} variant="ghost" size="md" />
              <GlowButton title="Create" onPress={handleCreate} variant="primary" size="md" disabled={!name.trim()} />
            </View>
          </GlassModalScaffold>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ─── ProjectCard ────────────────────────────────────────────────────────────
function ProjectCard({ project, onSelect, onLongPress, index, isMoving }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const statusColor = project.status === 'Completed' ? colors.success :
    project.status === 'In progress' ? colors.primary :
    project.status === 'Paused' ? colors.warning :
    colors.textMuted;

  const priorityColor = project.priority === 'Urgent' ? colors.error :
    project.priority === 'High' ? colors.warning :
    project.priority === 'Medium' ? colors.primary :
    colors.textMuted;

  const isAI = project.type?.includes('AI Projects');

  return (
    <GlassCard
      style={[
        styles.projectCard,
        isMoving && {
          borderColor: colors.primary,
          borderWidth: 2,
          shadowColor: colors.primary,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.55,
          shadowRadius: 14,
          elevation: 12,
        },
      ]}
      animated={!isMoving}
      delay={index * 60}
      glow={isMoving}
    >
      <TopHighlight />
      <TouchableOpacity
        onPress={() => onSelect(project.id)}
        onLongPress={() => { Vibration.vibrate(50); onLongPress?.(project); }}
        activeOpacity={0.7}
        delayLongPress={400}
      >
        {isMoving && (
          <View style={styles.movingBadge}>
            <Ionicons name="move" size={12} color={colors.primary} />
            <Text style={styles.movingBadgeText}>Moving… tap a status column</Text>
          </View>
        )}
        <View style={styles.projectHeader}>
          <Text style={styles.projectName} numberOfLines={1}>{project.name}</Text>
          {isAI && (
            <Ionicons name="hardware-chip-outline" size={14} color={colors.secondary} style={{ marginLeft: 4 }} />
          )}
        </View>

        <View style={styles.projectBadgeRow}>
          <View style={[styles.statusBadge, { backgroundColor: withAlpha(statusColor, 0.16), borderColor: withAlpha(statusColor, 0.32) }]}>
            <View style={[styles.statusDotSmall, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusBadgeText, { color: statusColor }]}>
              {project.status}
            </Text>
          </View>
          {project.priority ? (
            <View style={[styles.priorityBadgeSmall, { backgroundColor: withAlpha(priorityColor, 0.16), borderColor: withAlpha(priorityColor, 0.32) }]}>
              <Ionicons name="flag" size={10} color={priorityColor} />
              <Text style={[styles.priorityBadgeText, { color: priorityColor }]}>
                {project.priority}
              </Text>
            </View>
          ) : null}
        </View>

        {project.description ? (
          <Text style={styles.projectDesc} numberOfLines={2}>{project.description}</Text>
        ) : null}

        <View style={styles.projectFooter}>
          <View style={styles.progressBarWrap}>
            <View style={styles.progressBar}>
              <LinearGradient
                colors={[colors.primary, withAlpha(colors.primary, 0.7)]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[styles.progressFill, { width: `${Math.min(project.progress || 0, 100)}%` }]}
              />
            </View>
            <Text style={styles.progressText}>{project.progress || 0}%</Text>
          </View>
          <View style={styles.taskCountBadge}>
            <Ionicons name="document-text-outline" size={12} color={colors.textMuted} />
            <Text style={styles.projectTaskCount}>{project.taskCount || 0}</Text>
          </View>
        </View>
      </TouchableOpacity>
    </GlassCard>
  );
}

// ─── BoardColumn ────────────────────────────────────────────────────────────
function BoardColumn({ column, tasks, onTaskPress, onToggleDone, onLongPress, onColumnPress, onStatusChange, onDragEnd, showProject, projects, movingTask, columnHeight }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const count = tasks.length;
  const isTarget = movingTask && movingTask.status !== column.key;

  const renderItem = useCallback(({ item }) => {
    return (
      <SwipeableTaskCard
        task={item}
        onPress={onTaskPress}
        onToggleDone={onToggleDone}
        onLongPress={onLongPress}
        onStatusChange={onStatusChange}
        showProject={showProject}
        projects={projects}
        isMoving={movingTask?.id === item.id}
      />
    );
  }, [onTaskPress, onToggleDone, onLongPress, onStatusChange, showProject, projects, movingTask]);

  const keyExtractor = useCallback((item) => item.id, []);

  return (
    <GlassSurface
      depth={2}
      radius={18}
      style={[
        styles.boardColumn,
        columnHeight && { height: columnHeight },
        isTarget && {
          shadowColor: colors.primary,
          shadowOpacity: 0.5,
          shadowRadius: 16,
        },
      ]}
    >
      {/* Top accent line (column colour) */}
      <LinearGradient
        colors={[withAlpha(column.color, 0.65), withAlpha(column.color, 0)]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={styles.columnAccent}
        pointerEvents="none"
      />

      {/* Frosted header strip */}
      <TouchableOpacity
        style={[styles.columnHeader, isTarget && { backgroundColor: withAlpha(colors.primary, 0.14) }]}
        onPress={() => onColumnPress?.(column.key)}
        activeOpacity={isTarget ? 0.7 : 1}
        disabled={!isTarget}
      >
        <View style={[styles.columnIndicator, { backgroundColor: column.color }]} />
        <Ionicons name={column.icon} size={16} color={column.color} style={{ marginRight: 6 }} />
        <Text style={styles.columnLabel}>{column.label}</Text>
        <View style={[styles.countBadge, { backgroundColor: withAlpha(column.color, 0.18), borderColor: withAlpha(column.color, 0.32) }]}>
          <Text style={[styles.countText, { color: column.color }]}>{count}</Text>
        </View>
        {isTarget && (
          <View style={[styles.dropHere, { backgroundColor: withAlpha(colors.primary, 0.22) }]}>
            <Ionicons name="arrow-down-circle" size={16} color={colors.primary} />
            <Text style={styles.dropHereText}>Tap</Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Empty / list */}
      {tasks.length === 0 ? (
        <View style={styles.emptyColumn}>
          <PulseIcon icon="file-tray-outline" color={colors.textMuted} size={28} />
          <Text style={styles.emptyColumnText}>No tasks</Text>
          {isTarget && <Text style={styles.emptyColumnHint}>Tap header to move here</Text>}
        </View>
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          style={styles.columnScrollView}
          contentContainerStyle={styles.columnContent}
          showsVerticalScrollIndicator
        />
      )}
    </GlassSurface>
  );
}

// ─── Main screen ────────────────────────────────────────────────────────────
/**
 * Board tab / Kanban screen. Secure Mode on → the secure board
 * (secure.kanban.*) under an accent frame; off → the normal board, unchanged.
 */
export function KanbanScreen(props) {
  const { gateway } = props;
  const { colors } = useTheme();
  const connected = gateway?.status === 'connected';
  const secure = useSecureMode(gateway?.sendReq, gateway?.subscribeEvent, { connected });
  const on = secure.enabled;
  return (
    <View style={[{ flex: 1 }, secureFrameStyle(colors, on)]} testID="kanban-screen">
      <SecureModeBar secure={secure} connected={connected} />
      {on ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: SPACING.md, paddingTop: SPACING.xs, paddingBottom: SPACING.xl }}
          keyboardShouldPersistTaps="handled"
        >
          <SecureBoard sendReq={gateway?.sendReq} subscribeEvent={gateway?.subscribeEvent} connected={connected} />
        </ScrollView>
      ) : (
        <KanbanBoardScreen {...props} extraChrome={secure.supported ? SECURE_BAR_HEIGHT : 0} />
      )}
    </View>
  );
}

const SECURE_BAR_HEIGHT = 48;

function KanbanBoardScreen({ gateway, navigation, route, extraChrome = 0 }) {
  const { sendReq, status } = gateway;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const PRIORITY_COLORS = useMemo(() => getPriorityColors(colors), [colors]);
  const COLUMNS = useMemo(() => getColumns(colors), [colors]);
  const STATUS_GROUPS = useMemo(() => getStatusGroups(colors), [colors]);

  const kanban = useKanban(sendReq);
  const projectCatalog = useProjectCatalog(gateway);
  const clientCatalog = useClientCatalog(gateway);
  const {
    projects, tasks, selectedProjectId, loading, error,
    setSelectedProjectId, loadProjects, loadTasks, loadAll,
    updateTaskStatus, updateTaskDone, updateTaskPriority, updateTask, createTask,
    createProject, updateProjectStatus,
  } = kanban;

  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets() || { top: 0, bottom: 0, left: 0, right: 0 };

  const HEADER_HEIGHT = 56;
  const FILTER_BAR_HEIGHT = 56;
  const BOARD_HEADER_HEIGHT = 60;
  const DETAIL_PANEL_HEIGHT = 44;

  const [pageMode, setPageModeRaw] = useState('tasks'); // 'tasks' | 'projects'
  const [pageModeReady, setPageModeReady] = useState(false);
  const [view, setView] = useState('projects');
  const [viewMode, setViewModeRaw] = useState('board');
  const [detailOpen, setDetailOpen] = useState(false);

  // Restore persisted page mode once
  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(PAGE_MODE_KEY);
        if (stored === 'projects' || stored === 'tasks') setPageModeRaw(stored);
      } catch {}
      setPageModeReady(true);
    })();
  }, []);

  const setPageMode = useCallback((next) => {
    setPageModeRaw(next);
    AsyncStorage.setItem(PAGE_MODE_KEY, next).catch(() => {});
  }, []);

  // Restore viewMode for the active pageMode (separate sticky setting per page).
  // Defaults to 'board' on a brand-new install or when the stored value is bogus.
  useEffect(() => {
    if (!pageModeReady) return;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(VIEW_MODE_KEY(pageMode));
        setViewModeRaw(VALID_VIEW_MODES.includes(stored) ? stored : 'board');
      } catch {
        setViewModeRaw('board');
      }
    })();
  }, [pageMode, pageModeReady]);

  const setViewMode = useCallback((next) => {
    if (!VALID_VIEW_MODES.includes(next)) return;
    setViewModeRaw(next);
    AsyncStorage.setItem(VIEW_MODE_KEY(pageMode), next).catch(() => {});
  }, [pageMode]);

  const [projectSearch, setProjectSearch] = useState('');
  const [taskSearch, setTaskSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [hideSubProjects, setHideSubProjects] = useState(false);
  const [hideSubReady, setHideSubReady] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState('All');
  const [sortBy, setSortBy] = useState('Priority');
  const [refreshing, setRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [movingTask, setMovingTask] = useState(null);
  const [movingProject, setMovingProject] = useState(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Restore persisted hide-sub-projects toggle
  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(HIDE_SUB_PROJECTS_KEY);
        if (stored === 'true') setHideSubProjects(true);
      } catch {}
      setHideSubReady(true);
    })();
  }, []);

  const toggleHideSub = useCallback((next) => {
    setHideSubProjects(next);
    AsyncStorage.setItem(HIDE_SUB_PROJECTS_KEY, next ? 'true' : 'false').catch(() => {});
  }, []);

  const columnHeight = useMemo(() => {
    const movingBannerHeight = movingTask ? 48 : 0;
    const chrome =
      HEADER_HEIGHT +
      FILTER_BAR_HEIGHT +
      movingBannerHeight +
      insets.top +
      extraChrome +
      DOCK_BOTTOM_SPACE;
    const detailH = view === 'board'
      ? DETAIL_PANEL_HEIGHT + (detailOpen ? 260 : 0)
      : 0;
    const projectViewDeduction = view === 'board' ? BOARD_HEADER_HEIGHT : 0;
    return Math.max(280, screenHeight - chrome - projectViewDeduction - detailH);
  }, [screenHeight, insets.top, extraChrome, movingTask, view, detailOpen]);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    if (status === 'connected') loadAll();
  }, [status]);

  const handleSelectProject = useCallback((projectId) => {
    setSelectedProjectId(projectId);
    setView('board');
    setDetailOpen(false);
    loadTasks(projectId);
  }, [loadTasks, setSelectedProjectId]);

  const handleBackToProjects = useCallback(() => {
    setView('projects');
    setSelectedProjectId(null);
    setDetailOpen(false);
  }, [setSelectedProjectId]);

  const handleTaskPress = useCallback((task) => {
    setSelectedTask(task);
    setShowActionSheet(true);
  }, []);

  const handleStatusChange = useCallback(async (taskId, newStatus) => {
    await updateTaskStatus(taskId, newStatus);
  }, [updateTaskStatus]);

  const handleToggleDone = useCallback(async (taskId, done) => {
    await updateTaskDone(taskId, done);
  }, [updateTaskDone]);

  const handlePriorityChange = useCallback(async (taskId, priority) => {
    await updateTaskPriority(taskId, priority);
  }, [updateTaskPriority]);

  const handleUpdateTask = useCallback(async (taskId, updates) => {
    await updateTask(taskId, updates);
  }, [updateTask]);

  const handleTaskLongPress = useCallback((task) => {
    if (movingTask?.id === task.id) {
      setMovingTask(null);
    } else {
      setMovingTask(task);
    }
  }, [movingTask]);

  const handleColumnPress = useCallback(async (columnKey) => {
    if (!movingTask) return;
    if (movingTask.status === columnKey) {
      setMovingTask(null);
      return;
    }
    await updateTaskStatus(movingTask.id, columnKey);
    Vibration.vibrate(100);
    setMovingTask(null);
  }, [movingTask, updateTaskStatus]);

  const cancelMove = useCallback(() => {
    setMovingTask(null);
    setMovingProject(null);
  }, []);

  const handleProjectLongPress = useCallback((project) => {
    if (movingProject?.id === project.id) {
      setMovingProject(null);
    } else {
      setMovingProject(project);
    }
  }, [movingProject]);

  const handleProjectStatusPress = useCallback(async (newStatus) => {
    if (!movingProject) return;
    if (movingProject.status === newStatus) {
      setMovingProject(null);
      return;
    }
    await updateProjectStatus(movingProject.id, newStatus);
    Vibration.vibrate(100);
    setMovingProject(null);
  }, [movingProject, updateProjectStatus]);

  const handleCreateTask = useCallback(async (projectId, title, opts) => {
    await createTask(projectId, title, opts);
    loadTasks(projectId);
  }, [createTask, loadTasks]);

  const handleCreateProject = useCallback(async (name, opts) => {
    await createProject(name, opts);
    loadProjects();
  }, [createProject, loadProjects]);

  const handleAddToAutonomy = useCallback(async (task) => {
    const { sendReq } = gateway || {};
    if (!sendReq) {
      Alert.alert('Error', 'Not connected to gateway');
      return;
    }

    Alert.alert(
      'Add to Autonomy',
      `Queue "${task.title}" for autonomous execution?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Auto-Execute',
          onPress: async () => {
            try {
              await sendReq('autonomy:queue.importKanban', {
                kanbanTaskId: task.id,
                kanbanProjectId: task.projectId,
                title: task.title,
                description: task.description || task.title,
                priority: task.priority || 'normal',
                requiresApproval: false,
              });
              Alert.alert('Success', 'Task added to autonomy queue - will auto-execute');
            } catch (e) {
              Alert.alert('Error', String(e));
            }
          },
        },
        {
          text: 'Require Approval',
          onPress: async () => {
            Alert.prompt(
              'Instructions (optional)',
              'Add any context or instructions for this task:',
              async (instructions) => {
                try {
                  await sendReq('autonomy:queue.importKanban', {
                    kanbanTaskId: task.id,
                    kanbanProjectId: task.projectId,
                    title: task.title,
                    description: task.description || task.title,
                    priority: task.priority || 'normal',
                    requiresApproval: true,
                    instructions: instructions?.trim() || undefined,
                  });
                  Alert.alert('Success', 'Task added - will wait for your approval');
                } catch (e) {
                  Alert.alert('Error', String(e));
                }
              },
              'plain-text'
            );
          },
        },
      ]
    );
  }, [gateway]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (view === 'projects') await loadAll();
    else await loadTasks(selectedProjectId);
    setRefreshing(false);
  }, [view, loadAll, loadTasks, selectedProjectId]);

  // ── Deep-link consumer (web ↔ mobile parity) ─────────────────────────────
  // The web subagent modal dispatches `infinibot:kanban-open-task` and kanban.ts
  // routes it; on mobile, AgentFocusSheet.handleOpenKanban and
  // TaskActivityScreen.openInKanban navigate to 'Kanban' with { taskId, projectId }.
  // We open the board for the task's project and pop its detail sheet. When only
  // taskId is given we resolve the project by scanning all tasks (same id space:
  // task.id === Notion page id === run.kanbanTaskId on the backend).
  const openDeepLinkTask = useCallback(async (taskId, projectIdHint) => {
    if (!taskId) return;
    let projectId = projectIdHint || null;
    let task = tasks.find((t) => t.id === taskId) || null;
    if (!projectId) projectId = task?.projectId || null;

    // Resolve project from the task id when not provided / not in current list.
    if (!projectId) {
      try {
        const all = await loadTasks(); // no filter → all tasks
        task = (all || []).find((t) => t.id === taskId) || task;
        projectId = task?.projectId || null;
      } catch {}
    }

    if (projectId) {
      setPageMode('tasks');
      setSelectedProjectId(projectId);
      setView('board');
      setDetailOpen(false);
      try {
        const projTasks = await loadTasks(projectId);
        const found = (projTasks || []).find((t) => t.id === taskId) || task;
        if (found) {
          setSelectedTask(found);
          setShowActionSheet(true);
          try { Vibration.vibrate(40); } catch {}
        }
      } catch {}
    } else if (task) {
      // Couldn't resolve a project but we have the task — open it anyway.
      setSelectedTask(task);
      setShowActionSheet(true);
    }
  }, [tasks, loadTasks, setPageMode, setSelectedProjectId]);

  const deepLinkSigRef = useRef(null);
  useEffect(() => {
    const params = route?.params;
    if (!params || status !== 'connected') return;
    const { taskId, projectId } = params;
    if (!taskId && !projectId) return;
    // Content+nonce signature so identical re-navigations from the same surface
    // still re-fire, while plain re-renders with the same params object do not.
    const sig = `${projectId || ''}|${taskId || ''}|${params._ts || ''}`;
    if (deepLinkSigRef.current === sig) return;
    deepLinkSigRef.current = sig;
    if (taskId) {
      openDeepLinkTask(taskId, projectId);
    } else if (projectId) {
      setPageMode('tasks');
      setSelectedProjectId(projectId);
      setView('board');
      setDetailOpen(false);
      loadTasks(projectId);
    }
  }, [route?.params, status, openDeepLinkTask, loadTasks, setPageMode, setSelectedProjectId]);

  const filteredProjects = useMemo(() => {
    let list = [...projects];
    if (projectFilter === 'active') {
      list = list.filter(p => ['In progress', 'Not started', 'Reviewing'].includes(p.status));
    } else if (projectFilter === 'completed') {
      list = list.filter(p => p.status === 'Completed');
    } else if (projectFilter === 'ai') {
      list = list.filter(p => p.type?.includes('AI Projects'));
    }
    if (projectSearch) {
      const q = projectSearch.toLowerCase();
      list = list.filter(p => p.name?.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q));
    }
    if (hideSubProjects) {
      list = list.filter(p => !p.parentProjectId);
    }
    return list;
  }, [projects, projectFilter, projectSearch, hideSubProjects]);

  const filteredTasksList = useMemo(() => {
    let list = [...tasks];
    if (priorityFilter !== 'All') list = list.filter(t => t.priority === priorityFilter.toLowerCase());
    if (taskSearch) {
      const q = taskSearch.toLowerCase();
      list = list.filter(t => t.title?.toLowerCase().includes(q) || t.assignee?.toLowerCase().includes(q));
    }
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    if (sortBy === 'Priority') list.sort((a, b) => (order[a.priority] ?? 4) - (order[b.priority] ?? 4));
    else if (sortBy === 'Date') list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    else if (sortBy === 'Name') list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    return list;
  }, [tasks, priorityFilter, taskSearch, sortBy]);

  const tasksByStatus = useMemo(() => {
    const groups = {};
    COLUMNS.forEach(col => { groups[col.key] = []; });
    filteredTasksList.forEach(t => {
      if (groups[t.status]) groups[t.status].push(t);
      else if (groups.todo) groups.todo.push(t);
    });
    return COLUMNS.map(col => ({ title: col.label, color: col.color, icon: col.icon, data: groups[col.key] || [] })).filter(g => g.data.length > 0);
  }, [filteredTasksList, COLUMNS]);

  const getColumnTasks = useCallback((columnKey) => {
    let list = tasks.filter(t => t.status === columnKey);
    if (priorityFilter !== 'All') {
      list = list.filter(t => t.priority === priorityFilter.toLowerCase());
    }
    if (sortBy === 'Priority') {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      list.sort((a, b) => (order[a.priority] ?? 4) - (order[b.priority] ?? 4));
    } else if (sortBy === 'Date') {
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } else if (sortBy === 'Name') {
      list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }
    return list;
  }, [tasks, priorityFilter, sortBy]);

  const selectedProject = projects.find(p => p.id === selectedProjectId);

  // "Knowledge Graph": the native graph scoped to this project (only what's
  // related or connected to it — graph.global.snapshot { projectId, hops }).
  const openProjectGraph = useCallback((project) => {
    if (!project?.id) return;
    navigation?.navigate?.('MainTabs', {
      screen: 'Knowledge',
      params: { screen: 'KnowledgeGraph', initial: false, params: { project: project.id, projectName: project.name, _ts: Date.now() } },
    });
  }, [navigation]);

  const allTasksFiltered = useMemo(() => {
    let list = [...tasks];
    if (priorityFilter !== 'All') list = list.filter(t => t.priority === priorityFilter.toLowerCase());
    if (taskSearch) {
      const q = taskSearch.toLowerCase();
      list = list.filter(t => t.title?.toLowerCase().includes(q) || t.assignee?.toLowerCase().includes(q));
    }
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    if (sortBy === 'Priority') list.sort((a, b) => (order[a.priority] ?? 4) - (order[b.priority] ?? 4));
    else if (sortBy === 'Date') list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    else if (sortBy === 'Name') list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    return list;
  }, [tasks, priorityFilter, taskSearch, sortBy]);

  const getAllColumnTasks = useCallback((columnKey) => {
    return allTasksFiltered.filter(t => t.status === columnKey);
  }, [allTasksFiltered]);

  const allTasksByStatus = useMemo(() => {
    const groups = {};
    COLUMNS.forEach(col => { groups[col.key] = []; });
    allTasksFiltered.forEach(t => {
      if (groups[t.status]) groups[t.status].push(t);
      else if (groups.todo) groups.todo.push(t);
    });
    return COLUMNS.map(col => ({ title: col.label, color: col.color, icon: col.icon, key: col.key, data: groups[col.key] || [] })).filter(g => g.data.length > 0);
  }, [allTasksFiltered, COLUMNS]);

  // ── Empty / not-connected state ──────────────────────────────────────────
  if (status !== 'connected') {
    return (
      <View style={styles.center}>
        <View style={styles.emptyCluster}>
          <PulseIcon icon="cloud-offline-outline" color={colors.textMuted} size={42} />
          <Text style={styles.emptyText}>Not connected to gateway</Text>
        </View>
      </View>
    );
  }

  // Wait for persisted page mode before first paint to avoid flicker
  if (!pageModeReady) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="small" />
      </View>
    );
  }

  // ─── PROJECTS PAGE MODE — dashboard mirrors WebUI projects-dashboard.ts ──
  if (pageMode === 'projects') {
    return (
      <ProjectsDashboardView
        gateway={gateway}
        navigation={navigation}
        projects={projects}
        loading={loading}
        error={error}
        refreshing={refreshing}
        onRefresh={onRefresh}
        pageMode={pageMode}
        setPageMode={setPageMode}
        colors={colors}
        styles={styles}
        fadeAnim={fadeAnim}
        hideSubProjects={hideSubProjects}
        onToggleHideSub={toggleHideSub}
        onSelectProject={(projectId) => {
          setPageMode('tasks');
          handleSelectProject(projectId);
        }}
      />
    );
  }

  // ─── Projects view ──────────────────────────────────────────────────────
  if (view === 'projects') {
    return (
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <PageModeToggle pageMode={pageMode} setPageMode={setPageMode} colors={colors} styles={styles} />
          <View style={styles.filterBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={styles.filterScrollContent}>
              {PROJECT_FILTERS.map(f => {
                const isActive = projectFilter === f.key;
                return (
                  <GlassChip
                    key={f.key}
                    active={isActive}
                    onPress={() => setProjectFilter(f.key)}
                    accent={colors.primary}
                  >
                    <Text style={[styles.filterChipText, isActive && { color: colors.primary, fontWeight: '700' }]}>
                      {f.label}
                    </Text>
                  </GlassChip>
                );
              })}
            </ScrollView>
            <ViewToggle viewMode={viewMode} setViewMode={setViewMode} accent={colors.primary} muted={colors.textMuted} />
            <FAB small onPress={() => setShowCreateProjectModal(true)} colors={colors} styles={styles} />
          </View>

          <View style={styles.hideSubRow}>
            <Text style={styles.hideSubLabel}>Hide Sub-Projects</Text>
            <Switch
              value={hideSubProjects}
              onValueChange={toggleHideSub}
              trackColor={{ false: 'rgba(255,255,255,0.10)', true: withAlpha(colors.primary, 0.4) }}
              thumbColor={hideSubProjects ? colors.primary : colors.textMuted}
            />
          </View>

          {viewMode !== 'board' && (
            <ListSearchBar
              value={projectSearch}
              onChange={setProjectSearch}
              colors={colors}
              styles={styles}
              placeholder="Search projects…"
            />
          )}

          {viewMode === 'list' ? (
            <FlatList
              data={filteredProjects}
              keyExtractor={p => p.id}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} progressBackgroundColor={colors.surface} />}
              renderItem={({ item, index }) => {
                const sc = item.status === 'Completed' ? colors.success : item.status === 'In progress' ? colors.primary : item.status === 'Paused' ? colors.warning : colors.textMuted;
                const pc = item.priority === 'Urgent' ? colors.error : item.priority === 'High' ? colors.warning : item.priority === 'Medium' ? colors.primary : colors.textMuted;
                return (
                  <TouchableOpacity onPress={() => handleSelectProject(item.id)} activeOpacity={0.7}>
                    <GlassCard style={styles.listProjectRow} animated delay={index * 30}>
                      <TopHighlight />
                      <View style={styles.listProjectMain}>
                        <Text style={styles.listProjectName} numberOfLines={1}>{item.name}</Text>
                        <View style={styles.listProjectBadges}>
                          <View style={[styles.listBadge, { backgroundColor: withAlpha(sc, 0.18), borderColor: withAlpha(sc, 0.3) }]}>
                            <View style={[styles.listDot, { backgroundColor: sc }]} />
                            <Text style={[styles.listBadgeText, { color: sc }]}>{item.status}</Text>
                          </View>
                          {item.priority ? (
                            <View style={[styles.listBadge, { backgroundColor: withAlpha(pc, 0.18), borderColor: withAlpha(pc, 0.3) }]}>
                              <Ionicons name="flag" size={9} color={pc} />
                              <Text style={[styles.listBadgeText, { color: pc }]}>{item.priority}</Text>
                            </View>
                          ) : null}
                        </View>
                      </View>
                      <View style={styles.listProjectRight}>
                        <View style={styles.listProgressWrap}>
                          <View style={styles.listProgressBar}>
                            <LinearGradient
                              colors={[colors.primary, withAlpha(colors.primary, 0.7)]}
                              start={{ x: 0, y: 0 }}
                              end={{ x: 1, y: 0 }}
                              style={[styles.listProgressFill, { width: `${item.progress || 0}%` }]}
                            />
                          </View>
                          <Text style={styles.listProgressText}>{item.progress || 0}%</Text>
                        </View>
                        <View style={styles.listTaskCount}>
                          <Ionicons name="document-text-outline" size={11} color={colors.textMuted} />
                          <Text style={styles.listTaskCountText}>{item.taskCount || 0}</Text>
                        </View>
                      </View>
                    </GlassCard>
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <EmptyState colors={colors} styles={styles} icon="folder-open-outline" title="No projects found" hint="Try a different filter or create a project" />
              }
              contentContainerStyle={{ paddingBottom: DOCK_BOTTOM_SPACE + 16 }}
            />
          ) : viewMode === 'gallery' ? (
            <FlatList
              data={filteredProjects}
              keyExtractor={p => p.id}
              numColumns={2}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} progressBackgroundColor={colors.surface} />}
              renderItem={({ item, index }) => {
                const sc = item.status === 'Completed' ? colors.success : item.status === 'In progress' ? colors.primary : item.status === 'Paused' ? colors.warning : colors.textMuted;
                const pc = item.priority === 'Urgent' ? colors.error : item.priority === 'High' ? colors.warning : item.priority === 'Medium' ? colors.primary : colors.textMuted;
                const isAI = item.type?.includes('AI Projects');
                return (
                  <TouchableOpacity
                    onPress={() => handleSelectProject(item.id)}
                    onLongPress={() => { Vibration.vibrate(50); handleProjectLongPress?.(item); }}
                    activeOpacity={0.75}
                    delayLongPress={400}
                    style={{ width: GALLERY_CARD_WIDTH }}
                  >
                    <GlassCard style={[styles.galleryProjectCard, { borderTopColor: sc }]} animated delay={index * 30}>
                      <TopHighlight />
                      <View style={styles.galleryProjectHead}>
                        <Text style={styles.galleryProjectName} numberOfLines={2}>{item.name}</Text>
                        {isAI && (
                          <Ionicons name="hardware-chip-outline" size={12} color={colors.secondary} style={{ marginLeft: 4 }} />
                        )}
                      </View>
                      <View style={styles.galleryProjectBadges}>
                        <View style={[styles.galleryStatusChip, { backgroundColor: withAlpha(sc, 0.18), borderColor: withAlpha(sc, 0.32) }]}>
                          <View style={[styles.statusDotSmall, { backgroundColor: sc }]} />
                          <Text style={[styles.galleryStatusText, { color: sc }]} numberOfLines={1}>{item.status}</Text>
                        </View>
                        {item.priority ? (
                          <View style={[styles.galleryStatusChip, { backgroundColor: withAlpha(pc, 0.18), borderColor: withAlpha(pc, 0.32) }]}>
                            <Ionicons name="flag" size={9} color={pc} />
                            <Text style={[styles.galleryStatusText, { color: pc }]} numberOfLines={1}>{item.priority}</Text>
                          </View>
                        ) : null}
                      </View>
                      <View style={styles.galleryProgressWrap}>
                        <View style={styles.galleryProgressBar}>
                          <LinearGradient
                            colors={[colors.primary, withAlpha(colors.primary, 0.7)]}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 0 }}
                            style={[styles.galleryProgressFill, { width: `${Math.min(item.progress || 0, 100)}%` }]}
                          />
                        </View>
                        <Text style={styles.galleryProgressText}>{item.progress || 0}%</Text>
                      </View>
                      <View style={styles.galleryProjectFoot}>
                        <View style={styles.galleryTaskCountBadge}>
                          <Ionicons name="document-text-outline" size={11} color={colors.textMuted} />
                          <Text style={styles.galleryTaskCountText}>{item.taskCount || 0}</Text>
                        </View>
                        {item.updatedAt ? (
                          <Text style={styles.galleryUpdated} numberOfLines={1}>
                            {fmtRelativeShort(item.updatedAt)}
                          </Text>
                        ) : null}
                      </View>
                    </GlassCard>
                  </TouchableOpacity>
                );
              }}
              columnWrapperStyle={styles.galleryRow}
              contentContainerStyle={styles.galleryGrid}
              ListHeaderComponent={loading && projects.length === 0 ? (
                <ActivityIndicator color={colors.primary} size="large" style={{ marginTop: 40 }} />
              ) : null}
              ListEmptyComponent={
                <EmptyState colors={colors} styles={styles} icon="folder-open-outline" title="No projects found" hint="Tap + to create your first project" />
              }
            />
          ) : (
            <ScrollView
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh}
                  tintColor={colors.primary} colors={[colors.primary]}
                  progressBackgroundColor={colors.surface} />
              }
              contentContainerStyle={[styles.galleryContent, { paddingBottom: DOCK_BOTTOM_SPACE + 16 }]}
            >
              {loading && projects.length === 0 && (
                <ActivityIndicator color={colors.primary} size="large" style={{ marginTop: 40 }} />
              )}
              {error && (
                <View style={styles.errorRow}>
                  <Ionicons name="warning-outline" size={14} color={colors.error} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              {(() => {
                const grouped = STATUS_GROUPS.map(group => ({
                  ...group,
                  projects: filteredProjects.filter(p => p.status === group.key),
                })).filter(g => g.projects.length > 0);

                if (grouped.length === 0 && !loading) {
                  return (
                    <EmptyState colors={colors} styles={styles} icon="folder-open-outline" title="No projects found" hint="Tap + to create your first project" />
                  );
                }

                const isMovingMode = !!movingProject;

                return (
                  <>
                    {movingProject && (
                      <MovingBanner
                        colors={colors}
                        styles={styles}
                        onPress={cancelMove}
                        label={`Moving: ${(movingProject.name || '').slice(0, 25)}${(movingProject.name || '').length > 25 ? '…' : ''}`}
                      />
                    )}
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.statusGroupsRow}
                    >
                      {grouped.map((group) => {
                        const isTarget = isMovingMode && movingProject.status !== group.key;
                        return (
                          <GlassSurface
                            key={group.key}
                            depth={2}
                            radius={18}
                            style={[styles.statusGroupColumn, isTarget && { shadowColor: colors.primary, shadowOpacity: 0.5, shadowRadius: 16 }]}
                          >
                            <LinearGradient
                              colors={[withAlpha(group.color, 0.6), withAlpha(group.color, 0)]}
                              start={{ x: 0.5, y: 0 }}
                              end={{ x: 0.5, y: 1 }}
                              style={styles.columnAccent}
                              pointerEvents="none"
                            />
                            <TouchableOpacity
                              style={[styles.statusGroupHeader, isTarget && { backgroundColor: withAlpha(colors.primary, 0.14) }]}
                              onPress={() => handleProjectStatusPress(group.key)}
                              activeOpacity={isTarget ? 0.7 : 1}
                              disabled={!isTarget}
                            >
                              <View style={[styles.statusGroupIndicator, { backgroundColor: group.color }]} />
                              <Ionicons name={group.icon} size={16} color={group.color} style={{ marginRight: 6 }} />
                              <Text style={[styles.statusGroupLabel, { color: group.color }]}>{group.label}</Text>
                              <View style={[styles.statusGroupCount, { backgroundColor: withAlpha(group.color, 0.18), borderColor: withAlpha(group.color, 0.32) }]}>
                                <Text style={[styles.statusGroupCountText, { color: group.color }]}>{group.projects.length}</Text>
                              </View>
                              {isTarget && (
                                <View style={[styles.dropHere, { backgroundColor: withAlpha(colors.primary, 0.22) }]}>
                                  <Ionicons name="arrow-down-circle" size={14} color={colors.primary} />
                                  <Text style={styles.dropHereText}>Tap</Text>
                                </View>
                              )}
                            </TouchableOpacity>
                            <ScrollView style={styles.statusGroupScroll} contentContainerStyle={styles.statusGroupScrollContent} showsVerticalScrollIndicator={false} nestedScrollEnabled>
                              {group.projects.map((p, i) => (
                                <ProjectCard
                                  key={p.id}
                                  project={p}
                                  onSelect={handleSelectProject}
                                  onLongPress={handleProjectLongPress}
                                  index={i}
                                  isMoving={movingProject?.id === p.id}
                                />
                              ))}
                            </ScrollView>
                          </GlassSurface>
                        );
                      })}
                    </ScrollView>
                  </>
                );
              })()}
            </ScrollView>
          )}
        <CreateProjectModal
          visible={showCreateProjectModal}
          onClose={() => setShowCreateProjectModal(false)}
          onCreate={handleCreateProject}
        />
      </Animated.View>
    );
  }

  // ─── Board view (single-project kanban) ────────────────────────────────
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter(t => t.status === 'done').length;

  return (
    <View style={styles.container}>
      <PageModeToggle pageMode={pageMode} setPageMode={setPageMode} colors={colors} styles={styles} />
      {/* Sticky glass board header */}
      <View style={[styles.boardHeader, DEPTH[1].shadow]}>
        <View style={styles.boardHeaderClip}>
          <BlurView intensity={Platform.OS === 'android' ? 45 : 65} tint="dark" style={StyleSheet.absoluteFill} />
          <LinearGradient
            colors={[
              withAlpha(colors.primary, 0.22),
              withAlpha(colors.primary, 0.06),
              'rgba(0,0,0,0.4)',
            ]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={['rgba(255,255,255,0.07)', 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 0.6 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={[StyleSheet.absoluteFill, { borderWidth: 1, borderRadius: 0, borderColor: withAlpha(colors.primary, 0.18) }]} />
          <View style={styles.boardHeaderRow}>
            <TouchableOpacity onPress={handleBackToProjects} style={styles.headerIconBtn}>
              <Ionicons name="chevron-back" size={18} color={colors.primary} />
              <Text style={styles.headerBackText}>Projects</Text>
            </TouchableOpacity>
            <View style={styles.boardTitleWrap}>
              <Text style={styles.boardTitle} numberOfLines={1}>
                {selectedProject?.name || 'Board'}
              </Text>
              <View style={styles.boardStatsRow}>
                <View style={[styles.boardStatsPill, { borderColor: withAlpha(colors.primary, 0.32), backgroundColor: withAlpha(colors.primary, 0.12) }]}>
                  <Ionicons name="checkmark-circle-outline" size={11} color={colors.primary} />
                  <Text style={styles.boardStatsText}>{doneTasks}/{totalTasks}</Text>
                </View>
                {selectedProject?._doneTasks != null && (
                  <Text style={styles.boardStatsHint}>
                    ({selectedProject._doneTasks}/{selectedProject._totalTasks} tracked)
                  </Text>
                )}
              </View>
            </View>
            {selectedProject ? (
              <TouchableOpacity
                onPress={() => openProjectGraph(selectedProject)}
                style={[styles.headerIconBtn, { paddingHorizontal: SPACING.sm - 1 }]}
                accessibilityRole="button"
                accessibilityLabel="Knowledge Graph"
                accessibilityHint={`Only what's connected to ${selectedProject.name}`}
                testID="project-kg-btn"
              >
                <Ionicons name="git-network-outline" size={17} color={colors.primary} />
              </TouchableOpacity>
            ) : null}
            <ViewToggle viewMode={viewMode} setViewMode={setViewMode} accent={colors.primary} muted={colors.textMuted} />
            <FAB small onPress={() => setShowCreateModal(true)} colors={colors} styles={styles} />
          </View>
        </View>
      </View>

      {viewMode !== 'board' && (
        <ListSearchBar
          value={taskSearch}
          onChange={setTaskSearch}
          colors={colors}
          styles={styles}
          placeholder="Search tasks…"
        />
      )}

      <FilterBar
        colors={colors}
        styles={styles}
        priorityFilter={priorityFilter}
        setPriorityFilter={setPriorityFilter}
        sortBy={sortBy}
        setSortBy={setSortBy}
        PRIORITY_COLORS={PRIORITY_COLORS}
        viewMode={viewMode}
        setViewMode={null}
        onCreate={null}
      />

      {error && (
        <View style={styles.errorRow}>
          <Ionicons name="warning-outline" size={14} color={colors.error} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {viewMode === 'list' ? (
        <FlatList
          data={tasksByStatus}
          keyExtractor={(item) => item.title}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} progressBackgroundColor={colors.surface} />}
          renderItem={({ item: section }) => (
            <View style={{ marginBottom: 8 }}>
              <View style={[styles.columnHeader, styles.columnHeaderInline]}>
                <View style={[styles.columnIndicator, { backgroundColor: section.color }]} />
                <Ionicons name={section.icon} size={14} color={section.color} style={{ marginRight: 4 }} />
                <Text style={[styles.columnLabel, { color: section.color }]}>{section.title}</Text>
                <View style={[styles.countBadge, { backgroundColor: withAlpha(section.color, 0.18), borderColor: withAlpha(section.color, 0.32) }]}>
                  <Text style={[styles.countText, { color: section.color }]}>{section.data.length}</Text>
                </View>
              </View>
              {section.data.map((task, i) => {
                const pc = PRIORITY_COLORS[task.priority] || colors.textMuted;
                return (
                  <TouchableOpacity key={task.id} onPress={() => handleTaskPress(task)} activeOpacity={0.7}>
                    <GlassCard style={[styles.listTaskRow, { borderLeftWidth: 3, borderLeftColor: pc }]} animated delay={i * 25}>
                      <TopHighlight />
                      <View style={styles.listTaskMain}>
                        {task.done && <Ionicons name="checkmark-circle" size={14} color={colors.success} />}
                        <Text style={[styles.listTaskTitle, task.done && { textDecorationLine: 'line-through', opacity: 0.5 }]} numberOfLines={1}>{task.title}</Text>
                      </View>
                      <View style={styles.listTaskMeta}>
                        <Ionicons name={PRIORITY_ICONS[task.priority] || 'remove-circle-outline'} size={12} color={pc} />
                        {task.assignee ? <Text style={styles.listTaskAssignee} numberOfLines={1}>{task.assignee}</Text> : null}
                        {task.dueDate ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                            <Ionicons name="calendar-outline" size={10} color={colors.textMuted} />
                            <Text style={styles.listTaskDate}>{task.dueDate}</Text>
                          </View>
                        ) : null}
                      </View>
                    </GlassCard>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          ListEmptyComponent={
            <EmptyState colors={colors} styles={styles} icon="checkbox-outline" title="No tasks yet" hint="Tap + to create your first task" />
          }
          ListFooterComponent={
            <ProjectDetailPanel
              project={selectedProject}
              onViewGraph={openProjectGraph}
              tasks={tasks}
              projects={projects}
              onSelectProject={handleSelectProject}
              gateway={gateway}
              colors={colors}
              styles={styles}
              open={detailOpen}
              onToggle={() => setDetailOpen(d => !d)}
            />
          }
          contentContainerStyle={{ paddingBottom: DOCK_BOTTOM_SPACE + 16 }}
        />
      ) : viewMode === 'gallery' ? (
        <FlatList
          data={filteredTasksList}
          keyExtractor={(t) => t.id}
          numColumns={2}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} progressBackgroundColor={colors.surface} />}
          renderItem={({ item: task, index }) => {
            const pc = PRIORITY_COLORS[task.priority] || colors.textMuted;
            const section = COLUMNS.find(c => c.key === task.status) || COLUMNS[0];
            return (
              <TouchableOpacity onPress={() => handleTaskPress(task)} activeOpacity={0.75} style={{ width: GALLERY_CARD_WIDTH }}>
                <GlassCard style={[styles.galleryTaskCard, { borderLeftColor: pc }]} animated delay={index * 20}>
                  <TopHighlight />
                  <View style={styles.galleryTaskHead}>
                    <Ionicons name={PRIORITY_ICONS[task.priority] || 'remove-circle-outline'} size={12} color={pc} />
                    <Text style={[styles.galleryTaskTitle, task.done && { textDecorationLine: 'line-through', opacity: 0.5 }]} numberOfLines={2}>
                      {task.title}
                    </Text>
                  </View>
                  <View style={[styles.galleryStatusChip, { backgroundColor: withAlpha(section.color, 0.18), borderColor: withAlpha(section.color, 0.32) }]}>
                    <View style={[styles.statusDotSmall, { backgroundColor: section.color }]} />
                    <Text style={[styles.galleryStatusText, { color: section.color }]} numberOfLines={1}>{section.label}</Text>
                  </View>
                  <View style={styles.galleryTaskFoot}>
                    {task.assignee ? <Text style={[styles.galleryTaskMeta, { color: colors.textSecondary }]} numberOfLines={1}>{task.assignee}</Text> : <View />}
                    {task.dueDate ? (
                      <View style={styles.galleryDueRow}>
                        <Ionicons name="calendar-outline" size={9} color={colors.textMuted} />
                        <Text style={styles.galleryDueText} numberOfLines={1}>{task.dueDate}</Text>
                      </View>
                    ) : null}
                  </View>
                </GlassCard>
              </TouchableOpacity>
            );
          }}
          columnWrapperStyle={styles.galleryRow}
          contentContainerStyle={styles.galleryGrid}
          ListEmptyComponent={
            <EmptyState colors={colors} styles={styles} icon="checkbox-outline" title="No tasks yet" hint="Tap + to create your first task" />
          }
          ListFooterComponent={
            <ProjectDetailPanel
              project={selectedProject}
              onViewGraph={openProjectGraph}
              tasks={tasks}
              projects={projects}
              onSelectProject={handleSelectProject}
              gateway={gateway}
              colors={colors}
              styles={styles}
              open={detailOpen}
              onToggle={() => setDetailOpen(d => !d)}
            />
          }
        />
      ) : (
        <>
        <GestureHandlerRootView style={[styles.boardScrollWrapper, { height: columnHeight }]}>
          <ScrollView
            horizontal
            pagingEnabled={false}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.boardContainer}
            directionalLockEnabled
            scrollEventThrottle={16}
            decelerationRate="fast"
            snapToInterval={COLUMN_WIDTH + SPACING.xs * 2}
            snapToAlignment="start"
            bounces
            nestedScrollEnabled
          >
            {COLUMNS.map(col => (
              <BoardColumn
                key={col.key}
                column={col}
                tasks={getColumnTasks(col.key)}
                onTaskPress={handleTaskPress}
                onToggleDone={handleToggleDone}
                onLongPress={handleTaskLongPress}
                onColumnPress={handleColumnPress}
                onStatusChange={handleStatusChange}
                projects={projects}
                movingTask={movingTask}
                columnHeight={columnHeight - 50}
              />
            ))}
          </ScrollView>
        </GestureHandlerRootView>
        <ProjectDetailPanel
          project={selectedProject}
          onViewGraph={openProjectGraph}
          tasks={tasks}
          projects={projects}
          onSelectProject={handleSelectProject}
          gateway={gateway}
          colors={colors}
          styles={styles}
          open={detailOpen}
          onToggle={() => setDetailOpen(d => !d)}
        />
        </>
      )}

      <FAB large onPress={() => setShowCreateModal(true)} colors={colors} styles={styles} insetBottom={DOCK_BOTTOM_SPACE} />

      <TaskEditModal
        task={selectedTask}
        visible={showActionSheet}
        onClose={() => { setShowActionSheet(false); setSelectedTask(null); }}
        onStatusChange={handleStatusChange}
        onPriorityChange={handlePriorityChange}
        onToggleDone={handleToggleDone}
        onUpdate={handleUpdateTask}
        onAddToAutonomy={handleAddToAutonomy}
        projectCatalog={projectCatalog}
        clientCatalog={clientCatalog}
        sendReq={sendReq}
      />

      <CreateTaskModal
        visible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreateTask}
        projectId={selectedProjectId}
      />
    </View>
  );
}

// ─── Local helper components ────────────────────────────────────────────────

function MovingBanner({ colors, styles, onPress, label }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
      <View style={[styles.movingBanner, DEPTH[1].shadow]}>
        <View style={styles.movingBannerClip}>
          <BlurView intensity={Platform.OS === 'android' ? 40 : 55} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(colors.primary, 0.12) }]} />
          <LinearGradient
            colors={['rgba(255,255,255,0.08)', 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: 14,
                borderWidth: 1,
                borderTopColor:    withAlpha(colors.primary, 0.4),
                borderLeftColor:   withAlpha(colors.primary, 0.18),
                borderRightColor:  withAlpha(colors.primary, 0.18),
                borderBottomColor: withAlpha(colors.primary, 0.12),
              },
            ]}
          />
          <View style={styles.movingBannerRow}>
            <Ionicons name="move" size={16} color={colors.primary} />
            <Text style={styles.movingBannerText} numberOfLines={1}>{label}</Text>
            <View style={[styles.movingBannerCancel, { backgroundColor: withAlpha(colors.error, 0.18), borderColor: withAlpha(colors.error, 0.32) }]}>
              <Ionicons name="close" size={12} color={colors.error} />
              <Text style={styles.movingBannerCancelText}>Cancel</Text>
            </View>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function FilterBar({ colors, styles, priorityFilter, setPriorityFilter, sortBy, setSortBy, PRIORITY_COLORS, viewMode, setViewMode, onCreate }) {
  return (
    <View style={styles.boardFilterBar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={styles.filterScrollContent}>
        {PRIORITY_FILTERS.map(p => {
          const isActive = priorityFilter === p;
          const chipColor = p === 'All' ? colors.primary : (PRIORITY_COLORS[p.toLowerCase()] || colors.textMuted);
          return (
            <GlassChip
              key={p}
              active={isActive}
              accent={chipColor}
              onPress={() => setPriorityFilter(p)}
            >
              {p !== 'All' && (
                <Ionicons name={PRIORITY_ICONS[p.toLowerCase()]} size={11} color={isActive ? chipColor : colors.textMuted} />
              )}
              <Text style={[styles.filterChipText, isActive && { color: chipColor, fontWeight: '700' }]}>
                {p}
              </Text>
            </GlassChip>
          );
        })}
        <View style={styles.sortDivider} />
        {SORT_OPTIONS.map(s => {
          const isActive = sortBy === s;
          return (
            <GlassChip
              key={s}
              active={isActive}
              accent={colors.primary}
              onPress={() => setSortBy(s)}
            >
              <Feather name={s === 'Priority' ? 'flag' : s === 'Date' ? 'clock' : 'type'} size={11} color={isActive ? colors.primary : colors.textMuted} />
              <Text style={[styles.filterChipText, isActive && { color: colors.primary, fontWeight: '700' }]}>
                {s}
              </Text>
            </GlassChip>
          );
        })}
      </ScrollView>
      {setViewMode && <ViewToggle viewMode={viewMode} setViewMode={setViewMode} accent={colors.primary} muted={colors.textMuted} />}
      {onCreate && <FAB small onPress={onCreate} colors={colors} styles={styles} />}
    </View>
  );
}

function FAB({ small, large, onPress, colors, styles, insetBottom }) {
  if (large) {
    return (
      <TouchableOpacity
        style={[styles.fab, { bottom: (insetBottom || 0) + SPACING.lg }, DEPTH[2].shadow]}
        onPress={onPress}
        activeOpacity={0.85}
      >
        <View style={styles.fabClip}>
          <BlurView intensity={Platform.OS === 'android' ? 55 : 70} tint="dark" style={StyleSheet.absoluteFill} />
          <LinearGradient
            colors={[colors.primary, withAlpha(colors.primary, 0.78)]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: 28,
                borderWidth: 1,
                borderTopColor: 'rgba(255,255,255,0.42)',
                borderLeftColor: 'rgba(255,255,255,0.18)',
                borderRightColor: 'rgba(255,255,255,0.18)',
                borderBottomColor: 'rgba(0,0,0,0.18)',
              },
            ]}
          />
          <Ionicons name="add" size={28} color={colors.background} />
        </View>
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[styles.fabSmall, DEPTH[1].shadow, { marginLeft: 8 }]}
    >
      <View style={styles.fabSmallClip}>
        <LinearGradient
          colors={[colors.primary, withAlpha(colors.primary, 0.8)]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: 16,
              borderWidth: 1,
              borderTopColor: 'rgba(255,255,255,0.4)',
              borderLeftColor: 'rgba(255,255,255,0.18)',
              borderRightColor: 'rgba(255,255,255,0.18)',
              borderBottomColor: 'rgba(0,0,0,0.2)',
            },
          ]}
        />
        <Ionicons name="add" size={20} color={colors.background} />
      </View>
    </TouchableOpacity>
  );
}

function ListSearchBar({ value, onChange, colors, styles, placeholder }) {
  return (
    <View style={[styles.listSearchBar, DEPTH[1].shadow]}>
      <View style={styles.listSearchClip}>
        <BlurView intensity={Platform.OS === 'android' ? 40 : 50} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: GLASS_TINT.dark }]} />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: 12,
              borderWidth: 1,
              borderTopColor: 'rgba(255,255,255,0.10)',
              borderLeftColor: 'rgba(255,255,255,0.04)',
              borderRightColor: 'rgba(255,255,255,0.04)',
              borderBottomColor: 'rgba(255,255,255,0.02)',
            },
          ]}
        />
        <View style={styles.listSearchRow}>
          <Ionicons name="search-outline" size={14} color={colors.textMuted} />
          <TextInput
            style={styles.listSearchInput}
            value={value}
            onChangeText={onChange}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
          />
          {value ? (
            <TouchableOpacity onPress={() => onChange('')}>
              <Ionicons name="close-circle" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function EmptyState({ colors, styles, icon, title, hint }) {
  return (
    <View style={styles.emptyState}>
      <View style={[styles.emptyCluster, DEPTH[1].shadow]}>
        <View style={styles.emptyClusterClip}>
          <BlurView intensity={Platform.OS === 'android' ? 35 : 50} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: GLASS_TINT.dark }]} />
          <LinearGradient
            colors={['rgba(255,255,255,0.07)', 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: 18,
                borderWidth: 1,
                borderTopColor: 'rgba(255,255,255,0.10)',
                borderLeftColor: 'rgba(255,255,255,0.04)',
                borderRightColor: 'rgba(255,255,255,0.04)',
                borderBottomColor: 'rgba(255,255,255,0.02)',
              },
            ]}
          />
          <View style={styles.emptyClusterInner}>
            <PulseIcon icon={icon} color={colors.textMuted} size={36} />
            <Text style={styles.emptyText}>{title}</Text>
            {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── PageModeToggle — top-level TASKS / PROJECTS pill ─────────────────────
function PageModeToggle({ pageMode, setPageMode, colors, styles }) {
  return (
    <View style={styles.pageModeBar}>
      <View style={styles.pageModeClip}>
        <BlurView intensity={Platform.OS === 'android' ? 40 : 60} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />
        <View style={[StyleSheet.absoluteFill, { borderWidth: 1, borderColor: withAlpha(colors.primary, 0.18) }]} />
        <View style={styles.pageModeRow}>
          <TouchableOpacity
            style={[styles.pageModeBtn, pageMode === 'tasks' && { backgroundColor: withAlpha(colors.primary, 0.18) }]}
            onPress={() => setPageMode('tasks')}
            activeOpacity={0.75}
          >
            <Ionicons name="checkbox-outline" size={14} color={pageMode === 'tasks' ? colors.primary : colors.textMuted} />
            <Text style={[styles.pageModeText, pageMode === 'tasks' && { color: colors.primary, fontWeight: '700' }]}>TASKS</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.pageModeBtn, pageMode === 'projects' && { backgroundColor: withAlpha(colors.primary, 0.18) }]}
            onPress={() => setPageMode('projects')}
            activeOpacity={0.75}
          >
            <Ionicons name="albums-outline" size={14} color={pageMode === 'projects' ? colors.primary : colors.textMuted} />
            <Text style={[styles.pageModeText, pageMode === 'projects' && { color: colors.primary, fontWeight: '700' }]}>PROJECTS</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── ProjectsDashboardView — mobile port of WebUI projects-dashboard ──────
// Reuses the kanban projects list from useKanban (already populated upstream).
// Cards mirror projects-dashboard.ts: name, status pill, progress bar, task
// counts, recent activity. Tap → opens per-project board in KanbanScreen.
function ProjectsDashboardView({
  gateway,
  navigation,
  projects,
  loading,
  error,
  refreshing,
  onRefresh,
  pageMode,
  setPageMode,
  colors,
  styles,
  fadeAnim,
  onSelectProject,
  hideSubProjects,
  onToggleHideSub,
}) {
  const insets = useSafeAreaInsets() || { top: 0, bottom: 0, left: 0, right: 0 };
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let list = [...projects];
    if (statusFilter === 'active') {
      list = list.filter(p => ['In progress', 'Not started', 'Reviewing'].includes(p.status));
    } else if (statusFilter === 'completed') {
      list = list.filter(p => p.status === 'Completed');
    } else if (statusFilter === 'stale') {
      const fortyEightHoursAgo = Date.now() - 48 * 3600 * 1000;
      list = list.filter(p => p.updatedAt && p.updatedAt < fortyEightHoursAgo && p.status !== 'Completed');
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.name?.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q));
    }
    if (hideSubProjects) {
      list = list.filter(p => !p.parentProjectId);
    }
    return list;
  }, [projects, statusFilter, search, hideSubProjects]);

  const stats = useMemo(() => {
    const s = { total: projects.length, running: 0, paused: 0, completed: 0, stale: 0, notStarted: 0 };
    const fortyEightHoursAgo = Date.now() - 48 * 3600 * 1000;
    projects.forEach(p => {
      if (p.status === 'Completed') s.completed++;
      else if (p.status === 'Paused') s.paused++;
      else if (p.status === 'In progress') s.running++;
      else if (p.status === 'Not started') s.notStarted++;
      if (p.status !== 'Completed' && p.updatedAt && p.updatedAt < fortyEightHoursAgo) s.stale++;
    });
    return s;
  }, [projects]);

  const handleOpen = useCallback((project) => {
    if (onSelectProject) onSelectProject(project.id);
  }, [onSelectProject]);

  const fmtRelative = (ts) => {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 2) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  };

  const statusColorFor = (s) => {
    if (s === 'Completed') return colors.success;
    if (s === 'In progress') return colors.primary;
    if (s === 'Paused') return colors.warning;
    if (s === 'Reviewing') return colors.secondary;
    if (s === 'Cancelled') return colors.error;
    return colors.textMuted;
  };

  const FILTERS = [
    { key: 'all',       label: 'All',        n: stats.total },
    { key: 'active',    label: 'Active',     n: stats.running + stats.notStarted },
    { key: 'completed', label: 'Done',       n: stats.completed },
    { key: 'stale',     label: 'Stale',      n: stats.stale },
  ];

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <PageModeToggle pageMode={pageMode} setPageMode={setPageMode} colors={colors} styles={styles} />

      {/* Stats strip */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.dashStatsRow}
      >
        {[
          { label: 'TOTAL',    value: stats.total,        color: colors.text },
          { label: 'RUNNING',  value: stats.running,      color: colors.primary },
          { label: 'PAUSED',   value: stats.paused,       color: colors.warning },
          { label: 'STALE',    value: stats.stale,        color: colors.warning },
          { label: 'DONE',     value: stats.completed,    color: colors.success },
          { label: 'NOT STARTED', value: stats.notStarted, color: colors.textMuted },
        ].map(s => (
          <View key={s.label} style={styles.dashStatCell}>
            <Text style={[styles.dashStatValue, { color: s.color }]}>{s.value}</Text>
            <Text style={styles.dashStatLabel}>{s.label}</Text>
          </View>
        ))}
      </ScrollView>

      {/* Filter chips */}
      <View style={styles.dashFilterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={styles.filterScrollContent}>
          {FILTERS.map(f => {
            const isActive = statusFilter === f.key;
            return (
              <GlassChip
                key={f.key}
                active={isActive}
                onPress={() => setStatusFilter(f.key)}
                accent={colors.primary}
              >
                <Text style={[styles.filterChipText, isActive && { color: colors.primary, fontWeight: '700' }]}>
                  {f.label}
                </Text>
                <View style={[styles.dashChipCount, isActive && { backgroundColor: withAlpha(colors.primary, 0.20), borderColor: withAlpha(colors.primary, 0.32) }]}>
                  <Text style={[styles.dashChipCountText, isActive && { color: colors.primary }]}>{f.n}</Text>
                </View>
              </GlassChip>
            );
          })}
        </ScrollView>
      </View>

      {/* Hide sub-projects toggle */}
      <View style={styles.hideSubRow}>
        <Text style={styles.hideSubLabel}>Hide Sub-Projects</Text>
        <Switch
          value={hideSubProjects}
          onValueChange={onToggleHideSub}
          trackColor={{ false: 'rgba(255,255,255,0.10)', true: withAlpha(colors.primary, 0.4) }}
          thumbColor={hideSubProjects ? colors.primary : colors.textMuted}
        />
      </View>

      {/* Search */}
      <View style={styles.dashSearchWrap}>
        <View style={styles.listSearchRow}>
          <Ionicons name="search-outline" size={14} color={colors.textMuted} />
          <TextInput
            style={styles.listSearchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search projects…"
            placeholderTextColor={colors.textMuted}
          />
          {search ? (
            <TouchableOpacity onPress={() => setSearch('')}>
              <Ionicons name="close-circle" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {error && (
        <View style={styles.errorRow}>
          <Ionicons name="warning-outline" size={14} color={colors.error} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {loading && projects.length === 0 ? (
        <ActivityIndicator color={colors.primary} size="large" style={{ marginTop: 40 }} />
      ) : filtered.length === 0 ? (
        <EmptyState
          colors={colors}
          styles={styles}
          icon="folder-open-outline"
          title="No projects"
          hint={statusFilter === 'all' ? 'Create one from the Tasks view' : `No ${statusFilter} projects right now`}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              progressBackgroundColor={colors.surface}
            />
          }
          contentContainerStyle={{ paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: DOCK_BOTTOM_SPACE + SPACING.lg, gap: SPACING.sm }}
          renderItem={({ item: p, index }) => {
            const sc = statusColorFor(p.status);
            const progress = Math.max(0, Math.min(100, Math.round(p.progress || 0)));
            const taskCount = p.taskCount || 0;
            const doneCount = p._doneTasks ?? 0;
            const totalCount = p._totalTasks ?? taskCount;
            return (
              <TouchableOpacity activeOpacity={0.75} onPress={() => handleOpen(p)}>
                <GlassCard
                  style={[styles.dashProjectCard, { borderLeftWidth: 3, borderLeftColor: sc }]}
                  animated
                  delay={Math.min(index * 25, 200)}
                >
                  <TopHighlight />

                  <View style={styles.dashCardHeader}>
                    <View style={[styles.statusBadge, { borderColor: withAlpha(sc, 0.4), backgroundColor: withAlpha(sc, 0.12) }]}>
                      <View style={[styles.statusDotSmall, { backgroundColor: sc }]} />
                      <Text style={[styles.statusBadgeText, { color: sc }]}>{p.status || 'Unknown'}</Text>
                    </View>
                    {p.nodeId || (Array.isArray(p.nodeIds) && p.nodeIds.length) ? (
                      <View style={styles.dashNodeChip}>
                        <Ionicons name="git-network-outline" size={10} color={colors.secondary} />
                        <Text style={styles.dashNodeChipText} numberOfLines={1}>
                          {p.nodeId || p.nodeIds[0]}
                        </Text>
                      </View>
                    ) : null}
                    <Text style={styles.dashCardTime}>{fmtRelative(p.updatedAt)}</Text>
                  </View>

                  <Text style={styles.dashCardName} numberOfLines={2}>{p.name || 'Untitled project'}</Text>
                  {p.description ? (
                    <Text style={styles.dashCardDesc} numberOfLines={2}>{p.description}</Text>
                  ) : null}

                  {/* Progress bar */}
                  <View style={styles.dashProgressWrap}>
                    <View style={styles.dashProgressBar}>
                      <LinearGradient
                        colors={[colors.primary, withAlpha(colors.primary, 0.6)]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={[styles.dashProgressFill, { width: `${progress}%` }]}
                      />
                    </View>
                    <Text style={styles.dashProgressText}>{progress}%</Text>
                  </View>

                  <View style={styles.dashCardFooter}>
                    <View style={styles.dashFooterItem}>
                      <Ionicons name="checkbox-outline" size={12} color={colors.textMuted} />
                      <Text style={styles.dashFooterText}>
                        {totalCount > 0 ? `${doneCount}/${totalCount}` : `${taskCount}`} tasks
                      </Text>
                    </View>
                    {p.priority ? (
                      <View style={styles.dashFooterItem}>
                        <Ionicons name="flag-outline" size={12} color={colors.textMuted} />
                        <Text style={styles.dashFooterText}>{p.priority}</Text>
                      </View>
                    ) : null}
                    <View style={styles.dashFooterItem}>
                      <Ionicons name="chevron-forward" size={14} color={colors.primary} />
                    </View>
                  </View>
                </GlassCard>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </Animated.View>
  );
}

// ─── ProjectDetailPanel ──────────────────────────────────────────────────────
// Collapsible panel appended below the per-project kanban board.
// Shows KPI stats, project description, content blocks, and file attachments.

function adaptDetailBlock(b) {
  const TYPE_MAP = {
    paragraph: 'paragraph', h1: 'heading_1', h2: 'heading_2', h3: 'heading_3',
    bullet: 'bulleted_list_item', numbered: 'numbered_list_item',
    todo: 'to_do', quote: 'quote', callout: 'callout',
    code: 'code', divider: 'divider', image: 'image',
  };
  const type = TYPE_MAP[b.type] || b.type || 'paragraph';
  const out = { id: b.id, type, text: b.text || '' };
  if (b.checked != null) out.checked = b.checked;
  if (b.language) out.language = b.language;
  if (b.src) out.url = b.src;
  if (b.icon) out.icon = b.icon;
  return out;
}

function ProjectDetailPanel({ project, tasks, gateway, colors, styles, open, onToggle, projects, onSelectProject, onViewGraph }) {
  const federation = useFederation(gateway);
  const projectNodeId = project?.nodeId ||
    (Array.isArray(project?.nodeIds) && project.nodeIds.length ? project.nodeIds[0] : undefined);

  const [blocks, setBlocks] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesLoaded, setFilesLoaded] = useState(false);

  const callRPC = useCallback(async (method, params) => {
    if (federation?.invokeOnNode && projectNodeId) {
      return federation.invokeOnNode(method, params, projectNodeId);
    }
    if (gateway?.sendReq) return gateway.sendReq(method, params);
    throw new Error('Gateway not ready');
  }, [federation, gateway, projectNodeId]);

  useEffect(() => {
    if (!open || filesLoaded || !project?.id) return;
    setFilesLoading(true);
    Promise.allSettled([
      callRPC('kanban.projects.content.getBlocks', { projectId: project.id }),
      callRPC('kanban.projects.content.get', { projectId: project.id }),
    ]).then(([blocksRes, attachmentsRes]) => {
      if (blocksRes.status === 'fulfilled') {
        const raw = Array.isArray(blocksRes.value?.blocks) ? blocksRes.value.blocks : [];
        setBlocks(raw.map(adaptDetailBlock));
      }
      if (attachmentsRes.status === 'fulfilled') {
        const raw = Array.isArray(attachmentsRes.value?.attachments) ? attachmentsRes.value.attachments : [];
        setAttachments(raw);
      }
      setFilesLoaded(true);
      setFilesLoading(false);
    });
  }, [open, filesLoaded, project?.id, callRPC]);

  useEffect(() => {
    setFilesLoaded(false);
    setBlocks([]);
    setAttachments([]);
  }, [project?.id]);

  if (!project) return null;

  const openTasks = (tasks || []).filter(t => t.status !== 'done' && t.status !== 'Done' && t.status !== 'Completed');
  const doneTasks = (tasks || []).filter(t => t.status === 'done' || t.status === 'Done' || t.status === 'Completed');
  const daysActive = project.createdAt ? Math.max(1, Math.floor((Date.now() - project.createdAt) / 86400000)) : null;
  const statusColor = project.status === 'Completed' ? colors.success
    : project.status === 'In progress' ? colors.primary
    : project.status === 'Paused' ? colors.warning
    : colors.textMuted;

  const kpiItems = [
    { label: 'OPEN', value: String(openTasks.length), color: colors.primary },
    { label: 'DONE', value: String(doneTasks.length), color: colors.success },
    { label: 'TOTAL', value: String((tasks || []).length), color: colors.text },
    ...(daysActive != null ? [{ label: 'DAYS', value: String(daysActive), color: colors.textMuted }] : []),
    ...(project.paidAmount != null ? [{ label: 'PAID', value: `$${project.paidAmount}`, color: colors.success }] : []),
    ...(project.pendingPay != null ? [{ label: 'PENDING', value: `$${project.pendingPay}`, color: colors.warning }] : []),
  ];

  return (
    <View style={styles.detailPanel}>
      <TouchableOpacity style={styles.detailPanelToggle} onPress={onToggle} activeOpacity={0.7}>
        <View style={styles.detailPanelToggleLeft}>
          <Ionicons name="information-circle-outline" size={14} color={colors.primary} />
          <Text style={styles.detailPanelToggleText}>Project Details</Text>
          <View style={[styles.detailStatPill, { backgroundColor: withAlpha(statusColor, 0.14), borderColor: withAlpha(statusColor, 0.28) }]}>
            <View style={[styles.detailStatDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.detailStatPillText, { color: statusColor }]}>{project.status || 'Unknown'}</Text>
          </View>
          <Text style={styles.detailMiniStat}>{openTasks.length} open · {doneTasks.length} done</Text>
        </View>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textMuted} />
      </TouchableOpacity>

      {open && (
        <ScrollView
          style={styles.detailPanelBody}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.detailKpiRow}>
            {kpiItems.map(s => (
              <View key={s.label} style={styles.detailKpiCell}>
                <Text style={[styles.detailKpiValue, { color: s.color }]}>{s.value}</Text>
                <Text style={styles.detailKpiLabel}>{s.label}</Text>
              </View>
            ))}
          </ScrollView>

          {onViewGraph ? (
            <TouchableOpacity
              onPress={() => onViewGraph(project)}
              style={[styles.detailGraphBtn, { borderColor: withAlpha(colors.primary, 0.45), backgroundColor: withAlpha(colors.primary, 0.08) }]}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Open this project knowledge graph"
              testID="project-view-in-graph"
            >
              <Ionicons name="git-network-outline" size={16} color={colors.primary} />
              <Text style={[styles.detailGraphBtnText, { color: colors.primary }]}>Knowledge Graph</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.primary} />
            </TouchableOpacity>
          ) : null}

          {project.description ? (
            <View style={styles.detailSection}>
              <Text style={styles.detailSectionTitle}>Description</Text>
              <Text style={styles.detailDesc}>{project.description}</Text>
            </View>
          ) : null}

          <View style={styles.detailSection}>
            <Text style={styles.detailSectionTitle}>Content & Files</Text>
            {filesLoading ? (
              <ActivityIndicator color={colors.primary} size="small" style={{ marginVertical: 8 }} />
            ) : (
              <>
                {attachments.length > 0 && (
                  <View style={styles.detailFileList}>
                    {attachments.map(a => (
                      <TouchableOpacity
                        key={a.id || a.name || a.path}
                        style={styles.detailFileRow}
                        onPress={() => {
                          const url = a.url || a.path;
                          if (url && /^https?:\/\//i.test(url)) Linking.openURL(url).catch(() => {});
                        }}
                        activeOpacity={0.7}
                      >
                        <Ionicons
                          name={a.mimeType?.startsWith('image/') ? 'image-outline' : 'document-outline'}
                          size={14}
                          color={colors.primary}
                        />
                        <Text style={styles.detailFileName} numberOfLines={1}>{a.name || a.path || 'File'}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
                {blocks.length > 0 ? (
                  <View style={styles.detailBlocks}>
                    <BlockRenderer blocks={blocks} />
                  </View>
                ) : attachments.length === 0 ? (
                  <Text style={styles.detailEmptyText}>No content yet.</Text>
                ) : null}
              </>
            )}
          </View>

          {/* Sub-projects section */}
          <View style={styles.detailSection}>
            <Text style={styles.detailSectionTitle}>Sub-Projects</Text>
            {(() => {
              const subProjects = (projects || []).filter(p => p.parentProjectId === project.id);
              if (subProjects.length === 0) {
                return <Text style={styles.detailEmptyText}>No sub-projects</Text>;
              }
              return subProjects.map(sp => {
                const sc = sp.status === 'Completed' ? colors.success
                  : sp.status === 'In progress' ? colors.primary
                  : sp.status === 'Paused' ? colors.warning
                  : colors.textMuted;
                return (
                  <TouchableOpacity
                    key={sp.id}
                    activeOpacity={0.7}
                    onPress={() => onSelectProject?.(sp.id)}
                    style={styles.subProjectRow}
                  >
                    <View style={styles.subProjectInfo}>
                      <Text style={styles.subProjectName} numberOfLines={1}>{sp.name}</Text>
                      {sp.description ? (
                        <Text style={styles.subProjectDesc} numberOfLines={1}>{sp.description}</Text>
                      ) : null}
                    </View>
                    <View style={[styles.subProjectMeta, { borderColor: withAlpha(sc, 0.28), backgroundColor: withAlpha(sc, 0.10) }]}>
                      <View style={[styles.statusDotSmall, { backgroundColor: sc }]} />
                      <Text style={[styles.subProjectMetaText, { color: sc }]}>{sp.status || '—'}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />
                  </TouchableOpacity>
                );
              });
            })()}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

// ─── Styles factory ─────────────────────────────────────────────────────────
function makeStyles(colors) {
  const overlayDark = withAlpha('#000', 0.72);
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: 'transparent' },

    center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: SPACING.xl, gap: SPACING.md },
    emptyText: { color: colors.textMuted, ...FONTS.regular, textAlign: 'center', marginTop: SPACING.sm },
    emptyHint: { color: colors.textMuted, ...FONTS.tiny, textAlign: 'center', opacity: 0.7, marginTop: SPACING.xs },
    emptyState: { alignItems: 'center', marginTop: SPACING.xl, paddingHorizontal: SPACING.lg },
    emptyCluster: { borderRadius: 18, alignSelf: 'center' },
    emptyClusterClip: { borderRadius: 18, overflow: 'hidden' },
    emptyClusterInner: {
      paddingVertical: SPACING.xl,
      paddingHorizontal: SPACING.xl + SPACING.sm,
      alignItems: 'center',
      gap: SPACING.sm,
      minWidth: 220,
    },

    errorRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm, gap: SPACING.xs },
    errorText: { color: colors.error, ...FONTS.small, flex: 1 },

    // Main tab bar (Projects / Tasks toggle) — glass strip
    // Project detail panel
    detailPanel: {
      marginHorizontal: SPACING.md,
      marginBottom: SPACING.xs,
      borderRadius: 14,
      backgroundColor: withAlpha(colors.surface, 0.85),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.primary, 0.18),
      overflow: 'hidden',
    },
    detailPanelToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: SPACING.md,
      height: 44,
    },
    detailPanelToggleLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      flex: 1,
    },
    detailPanelToggleText: {
      ...FONTS.small,
      color: colors.text,
      fontWeight: '600',
    },
    detailStatPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
    },
    detailStatDot: { width: 5, height: 5, borderRadius: 3 },
    detailStatPillText: { ...FONTS.tiny, fontWeight: '600' },
    detailMiniStat: { ...FONTS.tiny, color: colors.textMuted },
    detailPanelBody: {
      maxHeight: 260,
      paddingHorizontal: SPACING.md,
      paddingBottom: SPACING.md,
    },
    detailKpiRow: { gap: SPACING.md, paddingVertical: SPACING.sm },
    detailGraphBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, minHeight: 44, paddingHorizontal: SPACING.md, marginTop: SPACING.sm, borderWidth: 1, borderRadius: 12, alignSelf: 'flex-start' },
    detailGraphBtnText: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },
    detailKpiCell: { alignItems: 'center', minWidth: 44 },
    detailKpiValue: { ...FONTS.regular, fontWeight: '700' },
    detailKpiLabel: { ...FONTS.tiny, color: colors.textMuted, marginTop: 2 },
    detailSection: { marginTop: SPACING.sm },
    detailSectionTitle: {
      ...FONTS.tiny,
      color: colors.textMuted,
      fontWeight: '700',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      marginBottom: SPACING.xs,
    },
    detailDesc: { ...FONTS.small, color: colors.text, lineHeight: 18 },
    detailFileList: { gap: 4 },
    detailFileRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
    detailFileName: { ...FONTS.small, color: colors.text, flex: 1 },
    detailBlocks: { marginTop: SPACING.xs },
    detailEmptyText: { ...FONTS.small, color: colors.textMuted, fontStyle: 'italic' },
    subProjectRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: SPACING.sm,
      paddingHorizontal: SPACING.xs,
      marginBottom: SPACING.xs,
      borderRadius: 10,
      backgroundColor: withAlpha(colors.surface, 0.6),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.primary, 0.12),
      gap: SPACING.sm,
    },
    subProjectInfo: { flex: 1, gap: 2 },
    subProjectName: { ...FONTS.small, color: colors.text, fontWeight: '600' },
    subProjectDesc: { ...FONTS.tiny, color: colors.textSecondary },
    subProjectMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
    },
    subProjectMetaText: { ...FONTS.tiny, fontWeight: '600' },

    // Filter bar (Projects/Tasks)
    filterBar: {
      flexDirection: 'row',
      alignItems: 'center',
      maxHeight: 56,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
    },
    filterScrollContent: {
      alignItems: 'center',
      paddingRight: SPACING.sm,
    },
    boardFilterBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: SPACING.sm + SPACING.xs,
      paddingVertical: SPACING.sm,
    },
    filterChipText: {
      ...FONTS.tiny,
      color: colors.textSecondary,
      letterSpacing: 0.2,
    },
    hideSubRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.xs,
      marginHorizontal: SPACING.md,
      marginBottom: SPACING.xs,
      borderRadius: 10,
      backgroundColor: withAlpha(colors.surface, 0.5),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.primary, 0.12),
    },
    hideSubLabel: {
      ...FONTS.small,
      color: colors.text,
      fontWeight: '600',
    },
    sortDivider: {
      width: 1,
      height: 18,
      backgroundColor: withAlpha(colors.text, 0.12),
      marginHorizontal: SPACING.xs + 2,
      alignSelf: 'center',
    },

    // Status group columns (projects-by-status board)
    statusGroupsRow: {
      paddingHorizontal: SPACING.md,
      paddingTop: SPACING.sm,
      paddingBottom: SPACING.xl,
    },
    statusGroupColumn: {
      width: SCREEN_WIDTH * 0.72,
      marginHorizontal: SPACING.xs + 2,
      height: 460,
    },
    statusGroupScroll: { flex: 1 },
    statusGroupScrollContent: {
      paddingHorizontal: SPACING.sm,
      paddingTop: SPACING.xs,
      paddingBottom: SPACING.lg,
    },
    statusGroupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm + 2,
      marginTop: SPACING.xs,
      marginHorizontal: SPACING.xs,
      borderRadius: 12,
    },
    statusGroupIndicator: {
      width: 3,
      height: 18,
      borderRadius: 2,
      marginRight: SPACING.sm,
    },
    statusGroupLabel: {
      ...FONTS.mono,
      fontSize: 12,
      letterSpacing: 1,
      fontWeight: '700',
      textTransform: 'uppercase',
      flex: 1,
    },
    statusGroupCount: {
      marginLeft: SPACING.sm,
      borderRadius: 10,
      paddingHorizontal: SPACING.sm,
      paddingVertical: 2,
      borderWidth: StyleSheet.hairlineWidth,
    },
    statusGroupCountText: { ...FONTS.mono, fontSize: 11, fontWeight: '700' },

    // Project list view
    galleryContent: { paddingBottom: SPACING.xl },
    projectCard: {
      width: '100%',
      padding: SPACING.md,
      marginBottom: SPACING.sm,
      overflow: 'hidden',
    },
    projectHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.xs + 2 },
    projectName: { ...FONTS.regular, color: colors.text, fontWeight: '700', flex: 1, fontSize: 14 },
    projectBadgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, marginBottom: SPACING.xs + 2 },
    statusBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 8,
      paddingHorizontal: SPACING.xs + 2,
      paddingVertical: 2,
      gap: SPACING.xs,
      borderWidth: StyleSheet.hairlineWidth,
    },
    statusDotSmall: { width: 6, height: 6, borderRadius: 3 },
    statusBadgeText: { ...FONTS.tiny, fontWeight: '700' },
    priorityBadgeSmall: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 8,
      paddingHorizontal: SPACING.xs + 2,
      paddingVertical: 2,
      gap: 3,
      borderWidth: StyleSheet.hairlineWidth,
    },
    priorityBadgeText: { ...FONTS.tiny, fontWeight: '700' },
    projectDesc: { ...FONTS.tiny, color: colors.textSecondary, marginBottom: SPACING.sm, lineHeight: 16 },
    projectFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    progressBarWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.xs + 2 },
    progressBar: {
      flex: 1,
      height: 4,
      backgroundColor: withAlpha(colors.text, 0.08),
      borderRadius: 2,
      overflow: 'hidden',
    },
    progressFill: { height: 4, borderRadius: 2 },
    progressText: { ...FONTS.tiny, color: colors.textMuted },
    taskCountBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: SPACING.sm },
    projectTaskCount: { ...FONTS.tiny, color: colors.textMuted },

    // Board header (sticky glass at top of board view)
    boardHeader: {
      marginHorizontal: SPACING.md,
      marginTop: SPACING.sm,
      borderRadius: 18,
    },
    boardHeaderClip: {
      borderRadius: 18,
      overflow: 'hidden',
    },
    boardHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm + 2,
      gap: SPACING.sm,
    },
    headerIconBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: SPACING.sm,
      paddingVertical: SPACING.xs + 2,
      borderRadius: 12,
      backgroundColor: withAlpha(colors.primary, 0.10),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.primary, 0.22),
      gap: SPACING.xs,
    },
    headerBackText: { color: colors.primary, ...FONTS.small, fontWeight: '700' },
    boardTitleWrap: { flex: 1, alignItems: 'flex-start' },
    boardTitle: { ...FONTS.heading, color: colors.text, fontWeight: '700', fontSize: 16 },
    boardStatsRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs + 2, marginTop: 2 },
    boardStatsPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: SPACING.xs + 2,
      paddingVertical: 2,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
    },
    boardStatsText: { ...FONTS.tiny, color: colors.primary, fontWeight: '700' },
    boardStatsHint: { ...FONTS.tiny, color: colors.textMuted },

    // Moving banner
    movingBanner: {
      marginHorizontal: SPACING.md,
      marginTop: SPACING.sm,
      borderRadius: 14,
    },
    movingBannerClip: {
      borderRadius: 14,
      overflow: 'hidden',
    },
    movingBannerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm + 2,
      gap: SPACING.sm,
    },
    movingBannerText: {
      ...FONTS.small,
      color: colors.primary,
      flex: 1,
      fontWeight: '700',
    },
    movingBannerCancel: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: SPACING.sm + 2,
      paddingVertical: 4,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
    },
    movingBannerCancelText: {
      ...FONTS.tiny,
      color: colors.error,
      fontWeight: '700',
    },

    // Board horizontal scroll wrapper
    boardScrollWrapper: { flex: 1 },
    boardContainer: {
      paddingHorizontal: SPACING.sm,
      paddingBottom: SPACING.lg,
      alignItems: 'flex-start',
    },

    // Board column — glass panel
    boardColumn: {
      width: COLUMN_WIDTH,
      marginHorizontal: SPACING.xs,
    },
    columnAccent: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 32,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
    },
    columnHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm + 2,
      marginTop: SPACING.xs,
      marginHorizontal: SPACING.xs,
      marginBottom: SPACING.xs,
      borderRadius: 12,
    },
    columnHeaderInline: {
      paddingHorizontal: SPACING.lg,
      marginTop: SPACING.sm,
    },
    columnIndicator: {
      width: 3,
      height: 16,
      borderRadius: 2,
      marginRight: SPACING.sm,
    },
    columnLabel: {
      ...FONTS.small,
      color: colors.text,
      fontWeight: '700',
      flex: 1,
      letterSpacing: 0.3,
    },
    countBadge: {
      borderRadius: 10,
      paddingHorizontal: SPACING.sm,
      paddingVertical: 2,
      borderWidth: StyleSheet.hairlineWidth,
    },
    countText: { ...FONTS.tiny, fontWeight: '700' },
    columnScrollView: { flex: 1 },
    columnContent: {
      paddingHorizontal: SPACING.sm,
      paddingTop: SPACING.xs,
      paddingBottom: SPACING.lg,
      flexGrow: 1,
    },
    dropHere: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginLeft: SPACING.sm,
      paddingHorizontal: SPACING.sm,
      paddingVertical: 4,
      borderRadius: 12,
    },
    dropHereText: { ...FONTS.tiny, color: colors.primary, fontWeight: '700' },
    emptyColumn: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: SPACING.xl,
      gap: SPACING.sm,
      opacity: 0.7,
    },
    emptyColumnText: { ...FONTS.tiny, color: colors.textMuted },
    emptyColumnHint: { ...FONTS.tiny, color: colors.primary, opacity: 0.85 },

    // Task card
    taskCard: {
      padding: SPACING.md,
      marginBottom: SPACING.sm,
      overflow: 'hidden',
    },
    movingBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: withAlpha(colors.primary, 0.16),
      borderColor: withAlpha(colors.primary, 0.32),
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: SPACING.sm,
      paddingVertical: 4,
      borderRadius: 6,
      marginBottom: SPACING.sm,
      alignSelf: 'flex-start',
    },
    movingBadgeText: {
      ...FONTS.tiny,
      color: colors.primary,
      fontWeight: '700',
    },
    taskHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
    },
    taskCheckRow: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginRight: SPACING.sm,
      gap: SPACING.sm + 2,
    },
    taskTitle: { ...FONTS.small, color: colors.text, fontWeight: '600', flex: 1 },
    taskTitleDone: { textDecorationLine: 'line-through', opacity: 0.5 },
    priorityPill: {
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
    },
    dragHint: {
      position: 'absolute',
      bottom: 2,
      right: 2,
      opacity: 0.4,
    },
    taskMetaRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: SPACING.xs },
    taskMetaText: { ...FONTS.tiny, color: colors.textSecondary },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: SPACING.xs + 2, gap: SPACING.xs },
    tag: {
      backgroundColor: withAlpha(colors.primary, 0.14),
      borderColor: withAlpha(colors.primary, 0.28),
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 6,
      paddingHorizontal: SPACING.xs + 2,
      paddingVertical: 2,
    },
    tagText: { ...FONTS.tiny, color: colors.primary, fontWeight: '600' },

    // Action sheet
    sheetOverlay: { flex: 1, backgroundColor: overlayDark, justifyContent: 'flex-end' },
    sheetContent: { paddingBottom: SPACING.xl },
    sheetCard: {
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
    },
    sheetClip: {
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      overflow: 'hidden',
    },
    sheetInner: {
      paddingHorizontal: SPACING.xl,
      paddingTop: SPACING.md,
      paddingBottom: SPACING.xl + SPACING.sm,
    },
    sheetGrabber: {
      width: 42,
      height: 4,
      borderRadius: 2,
      backgroundColor: withAlpha(colors.text, 0.18),
      alignSelf: 'center',
      marginBottom: SPACING.md,
    },
    sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: SPACING.lg },
    sheetTitle: { ...FONTS.regular, color: colors.text, fontWeight: '700', flex: 1, lineHeight: 24 },
    sheetTitleInput: {
      ...FONTS.regular,
      color: colors.text,
      fontWeight: '700',
      backgroundColor: 'rgba(255,255,255,0.04)',
      borderRadius: 10,
      padding: SPACING.sm + 2,
      borderWidth: 1,
      borderTopColor: withAlpha(colors.primary, 0.45),
      borderLeftColor: withAlpha(colors.primary, 0.25),
      borderRightColor: withAlpha(colors.primary, 0.25),
      borderBottomColor: withAlpha(colors.primary, 0.18),
    },
    sheetEditHint: { ...FONTS.tiny, color: colors.textMuted, marginTop: 4 },
    sheetMetaSection: { marginBottom: SPACING.lg },
    sheetMetaRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: 6 },
    sheetMetaText: { ...FONTS.small, color: colors.textSecondary },
    sheetSectionLabel: {
      ...FONTS.mono,
      color: colors.textMuted,
      letterSpacing: 1.5,
      marginBottom: SPACING.sm,
      marginTop: SPACING.md,
      textTransform: 'uppercase',
      fontSize: 10,
    },
    sheetActions: { gap: 6 },
    sheetBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm + 2,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm + 4,
      borderRadius: 12,
      borderWidth: 1,
      backgroundColor: 'rgba(255,255,255,0.04)',
    },
    sheetBtnText: { ...FONTS.small, color: colors.textMuted, flex: 1 },
    sheetCloseBtn: {
      marginTop: SPACING.xl,
      borderRadius: 14,
      paddingVertical: SPACING.md,
      alignItems: 'center',
      overflow: 'hidden',
    },
    sheetCloseBtnText: { ...FONTS.regular, color: colors.background, fontWeight: '800', letterSpacing: 0.4 },

    prioritySelector: { flexDirection: 'row', gap: SPACING.sm },
    prioritySelectorBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingVertical: SPACING.sm + 2,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: withAlpha(colors.text, 0.08),
      backgroundColor: 'rgba(255,255,255,0.03)',
    },
    prioritySelectorText: { ...FONTS.tiny, color: colors.textMuted },

    editAllPropertiesBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
      marginTop: SPACING.md,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.md - 2,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.32),
      backgroundColor: withAlpha(colors.primary, 0.08),
    },
    editAllPropertiesText: {
      ...FONTS.small,
      color: colors.primary,
      fontWeight: '700',
      flex: 1,
    },

    // FAB (large floating)
    fab: {
      position: 'absolute',
      right: SPACING.lg,
      width: 56,
      height: 56,
      borderRadius: 28,
    },
    fabClip: {
      width: 56,
      height: 56,
      borderRadius: 28,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    },
    fabSmall: {
      width: 36,
      height: 36,
      borderRadius: 18,
    },
    fabSmallClip: {
      width: 36,
      height: 36,
      borderRadius: 18,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    },

    // Modals (Create*)
    modalOverlay: { flex: 1, backgroundColor: overlayDark, justifyContent: 'flex-end' },
    modalContent: {},
    modalTitle: {
      ...FONTS.heading,
      color: colors.primary,
      marginBottom: SPACING.md,
      letterSpacing: 0.3,
    },
    modalInput: {
      backgroundColor: 'rgba(255,255,255,0.04)',
      borderRadius: 12,
      padding: SPACING.md,
      color: colors.text,
      ...FONTS.regular,
      borderWidth: 1,
      borderTopColor: withAlpha(colors.text, 0.12),
      borderLeftColor: withAlpha(colors.text, 0.05),
      borderRightColor: withAlpha(colors.text, 0.05),
      borderBottomColor: withAlpha(colors.text, 0.03),
    },
    modalLabel: {
      ...FONTS.mono,
      color: colors.textMuted,
      marginTop: SPACING.md,
      marginBottom: SPACING.sm,
      textTransform: 'uppercase',
      letterSpacing: 1.5,
      fontSize: 10,
    },
    priorityRow: { flexDirection: 'row', gap: SPACING.sm },
    priorityBtn: {
      flex: 1,
      borderRadius: 10,
      paddingVertical: SPACING.sm,
      alignItems: 'center',
      gap: 4,
      borderWidth: 1,
      borderColor: withAlpha(colors.text, 0.08),
      backgroundColor: 'rgba(255,255,255,0.03)',
    },
    priorityBtnText: { ...FONTS.tiny, color: colors.textSecondary, textTransform: 'capitalize' },
    statusRow: { flexDirection: 'row', gap: SPACING.sm },
    statusBtn: {
      flex: 1,
      flexDirection: 'row',
      borderRadius: 10,
      paddingVertical: SPACING.sm,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      borderWidth: 1,
      borderColor: withAlpha(colors.text, 0.08),
      backgroundColor: 'rgba(255,255,255,0.03)',
    },
    statusBtnText: { ...FONTS.tiny, color: colors.textSecondary },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    modalActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: SPACING.xl,
      gap: SPACING.md,
    },

    // View toggle
    viewToggle: {
      paddingHorizontal: SPACING.sm,
      paddingVertical: SPACING.xs + 2,
      justifyContent: 'center',
    },

    // Search bar (glass)
    listSearchBar: {
      marginHorizontal: SPACING.md,
      marginTop: SPACING.xs,
      marginBottom: SPACING.xs,
      borderRadius: 12,
    },
    listSearchClip: {
      borderRadius: 12,
      overflow: 'hidden',
    },
    listSearchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.xs + 2,
      paddingHorizontal: SPACING.sm + 2,
      paddingVertical: SPACING.xs + 2,
    },
    listSearchInput: { flex: 1, color: colors.text, ...FONTS.tiny, padding: 0 },

    // Project list row (alt view)
    listProjectRow: {
      flexDirection: 'row',
      padding: SPACING.md,
      marginHorizontal: SPACING.md,
      marginTop: SPACING.xs,
      overflow: 'hidden',
    },
    listProjectMain: { flex: 1 },
    listProjectName: { ...FONTS.small, color: colors.text, fontWeight: '700', marginBottom: SPACING.xs },
    listProjectBadges: { flexDirection: 'row', gap: SPACING.xs },
    listBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      borderRadius: 6,
      paddingHorizontal: 5,
      paddingVertical: 2,
      borderWidth: StyleSheet.hairlineWidth,
    },
    listDot: { width: 5, height: 5, borderRadius: 3 },
    listBadgeText: { ...FONTS.tiny, fontWeight: '700', fontSize: 9 },
    listProjectRight: {
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: SPACING.xs,
      minWidth: 70,
    },
    listProgressWrap: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
    listProgressBar: {
      width: 44,
      height: 4,
      backgroundColor: withAlpha(colors.text, 0.08),
      borderRadius: 2,
      overflow: 'hidden',
    },
    listProgressFill: { height: 4, borderRadius: 2 },
    listProgressText: { ...FONTS.tiny, color: colors.textMuted, fontSize: 9 },
    listTaskCount: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    listTaskCountText: { ...FONTS.tiny, color: colors.textMuted },

    // Task list row (alt view)
    listTaskRow: {
      padding: SPACING.sm + 2,
      marginHorizontal: SPACING.md,
      marginTop: SPACING.xs,
      overflow: 'hidden',
    },
    listTaskMain: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs + 2 },
    listTaskTitle: { ...FONTS.small, color: colors.text, fontWeight: '500', flex: 1 },
    listTaskMeta: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: 4 },
    listTaskAssignee: { ...FONTS.tiny, color: colors.textSecondary, maxWidth: 100 },
    listTaskDate: { ...FONTS.tiny, color: colors.textMuted, fontSize: 9 },

    // ─── Gallery (2-column grid) ──────────────────────────────────────────
    galleryGrid: {
      paddingHorizontal: SPACING.md,
      paddingTop: SPACING.xs,
      paddingBottom: DOCK_BOTTOM_SPACE + 16,
    },
    galleryRow: {
      justifyContent: 'space-between',
      marginBottom: SPACING.sm,
    },
    galleryProjectCard: {
      width: '100%',
      padding: SPACING.sm + 2,
      borderTopWidth: 3,
      overflow: 'hidden',
      minHeight: 132,
    },
    galleryProjectHead: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: SPACING.xs,
    },
    galleryProjectName: {
      ...FONTS.small,
      color: colors.text,
      fontWeight: '700',
      flex: 1,
      fontSize: 13,
    },
    galleryProjectBadges: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 4,
      marginBottom: SPACING.xs + 2,
    },
    galleryProgressWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.xs,
      marginBottom: SPACING.xs + 2,
    },
    galleryProgressBar: {
      flex: 1,
      height: 3,
      backgroundColor: withAlpha(colors.text, 0.08),
      borderRadius: 2,
      overflow: 'hidden',
    },
    galleryProgressFill: { height: 3, borderRadius: 2 },
    galleryProgressText: {
      ...FONTS.tiny,
      color: colors.textMuted,
      fontSize: 9,
    },
    galleryProjectFoot: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: SPACING.xs,
    },
    galleryTaskCountBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
    },
    galleryTaskCountText: {
      ...FONTS.tiny,
      color: colors.textMuted,
      fontSize: 10,
    },
    galleryUpdated: {
      ...FONTS.tiny,
      color: colors.textMuted,
      fontSize: 9,
    },
    galleryTaskCard: {
      width: '100%',
      padding: SPACING.sm + 2,
      borderLeftWidth: 3,
      overflow: 'hidden',
      minHeight: 108,
    },
    galleryTaskHead: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: SPACING.xs,
      marginBottom: SPACING.xs + 2,
    },
    galleryTaskTitle: {
      ...FONTS.small,
      color: colors.text,
      fontWeight: '600',
      flex: 1,
      fontSize: 12,
      lineHeight: 16,
    },
    galleryStatusChip: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 3,
      borderRadius: 8,
      paddingHorizontal: SPACING.xs + 2,
      paddingVertical: 2,
      borderWidth: StyleSheet.hairlineWidth,
      marginBottom: SPACING.xs,
    },
    galleryStatusText: {
      ...FONTS.tiny,
      fontWeight: '700',
      fontSize: 9,
    },
    galleryTaskFoot: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: SPACING.xs,
      gap: SPACING.xs,
    },
    galleryTaskMeta: {
      ...FONTS.tiny,
      fontSize: 9,
      flex: 1,
    },
    galleryDueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
    },
    galleryDueText: {
      ...FONTS.tiny,
      color: colors.textMuted,
      fontSize: 9,
    },

    // ─── Page-mode toggle (TASKS / PROJECTS pill) ────────────────────────
    pageModeBar: {
      marginHorizontal: SPACING.md,
      marginTop: SPACING.sm,
      borderRadius: 14,
    },
    pageModeClip: {
      borderRadius: 14,
      overflow: 'hidden',
    },
    pageModeRow: {
      flexDirection: 'row',
      paddingHorizontal: SPACING.xs,
      paddingVertical: SPACING.xs,
    },
    pageModeBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: SPACING.sm,
      margin: 2,
      borderRadius: 10,
    },
    pageModeText: {
      ...FONTS.tiny,
      color: colors.textMuted,
      letterSpacing: 1,
      fontWeight: '600',
    },

    // ─── Projects dashboard view (PROJECTS page mode) ────────────────────
    dashStatsRow: {
      paddingHorizontal: SPACING.md,
      paddingTop: SPACING.sm,
      gap: SPACING.sm,
    },
    dashStatCell: {
      minWidth: 72,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.text, 0.10),
      backgroundColor: withAlpha(colors.text, 0.04),
      alignItems: 'center',
    },
    dashStatValue: { ...FONTS.regular, fontSize: 18, fontWeight: '700' },
    dashStatLabel: {
      ...FONTS.tiny,
      color: colors.textMuted,
      letterSpacing: 1,
      marginTop: 2,
    },

    dashFilterBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: SPACING.md,
      paddingTop: SPACING.sm,
    },
    dashChipCount: {
      marginLeft: SPACING.xs,
      borderRadius: 10,
      paddingHorizontal: 6,
      paddingVertical: 1,
      backgroundColor: withAlpha(colors.text, 0.08),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.text, 0.1),
    },
    dashChipCountText: { ...FONTS.tiny, color: colors.textMuted, fontWeight: '700' },

    dashSearchWrap: {
      paddingHorizontal: SPACING.md,
      paddingTop: SPACING.sm,
    },

    dashProjectCard: {
      padding: SPACING.md,
      overflow: 'hidden',
    },
    dashCardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.xs,
      marginBottom: SPACING.xs + 2,
    },
    dashCardTime: {
      ...FONTS.tiny,
      color: colors.textMuted,
      marginLeft: 'auto',
    },
    dashNodeChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.secondary, 0.32),
      backgroundColor: withAlpha(colors.secondary, 0.10),
      maxWidth: 110,
    },
    dashNodeChipText: { ...FONTS.tiny, color: colors.secondary, fontWeight: '700' },
    dashCardName: {
      ...FONTS.regular,
      fontSize: 15,
      fontWeight: '700',
      color: colors.text,
    },
    dashCardDesc: {
      ...FONTS.small,
      color: colors.textSecondary,
      marginTop: 2,
      lineHeight: 18,
    },
    dashProgressWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
      marginTop: SPACING.sm,
    },
    dashProgressBar: {
      flex: 1,
      height: 5,
      borderRadius: 3,
      backgroundColor: withAlpha(colors.text, 0.08),
      overflow: 'hidden',
    },
    dashProgressFill: { height: 5, borderRadius: 3 },
    dashProgressText: { ...FONTS.tiny, color: colors.textMuted, fontWeight: '700', minWidth: 30, textAlign: 'right' },

    dashCardFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.md,
      marginTop: SPACING.sm,
    },
    dashFooterItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    dashFooterText: { ...FONTS.tiny, color: colors.textMuted },
  });
}

export default KanbanScreen;
