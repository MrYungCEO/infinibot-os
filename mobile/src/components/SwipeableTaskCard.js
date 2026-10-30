import React, { useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Vibration } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SwipeReveal } from './SwipeReveal';
import { Ionicons } from '@expo/vector-icons';
import { GlassCard } from './GlassCard';
import { NotionCheckbox } from './NotionCheckbox';
import { COLORS, FONTS, SPACING } from '../constants/theme';

const COLUMNS = [
  { key: 'backlog', label: 'Backlog', color: COLORS.textMuted, icon: 'file-tray-outline' },
  { key: 'todo', label: 'To Do', color: COLORS.warning, icon: 'list-outline' },
  { key: 'in_progress', label: 'In Progress', color: COLORS.primary, icon: 'play-circle-outline' },
  { key: 'review', label: 'Review', color: COLORS.secondary, icon: 'eye-outline' },
  { key: 'done', label: 'Done', color: COLORS.success, icon: 'checkmark-circle-outline' },
];

const PRIORITY_COLORS = {
  critical: '#EF4444',
  high: '#F97316',
  medium: COLORS.primary,
  low: COLORS.textMuted,
};

const PRIORITY_ICONS = {
  critical: 'alert-circle',
  high: 'arrow-up-circle',
  medium: 'remove-circle',
  low: 'arrow-down-circle',
};

function getNextStatus(currentStatus) {
  const idx = COLUMNS.findIndex(c => c.key === currentStatus);
  if (idx < COLUMNS.length - 1) return COLUMNS[idx + 1];
  return null;
}

function getPrevStatus(currentStatus) {
  const idx = COLUMNS.findIndex(c => c.key === currentStatus);
  if (idx > 0) return COLUMNS[idx - 1];
  return null;
}

export function SwipeableTaskCard({
  task,
  onPress,
  onToggleDone,
  onLongPress,
  onStatusChange,
  index,
  showProject,
  projects,
  isMoving,
  isDragging,
  drag,
}) {
  const swipeableRef = useRef(null);
  const isOverdue = task.dueDate && new Date(task.dueDate) < new Date();
  const priorityColor = PRIORITY_COLORS[task.priority] || COLORS.textMuted;
  const projectName = showProject && task.projectId
    ? (projects || []).find(p => p.id === task.projectId)?.name
    : null;

  const nextStatus = getNextStatus(task.status);
  const prevStatus = getPrevStatus(task.status);

  const handleSwipeRight = useCallback(() => {
    if (prevStatus) {
      Vibration.vibrate(30);
      onStatusChange?.(task.id, prevStatus.key);
      swipeableRef.current?.close();
    }
  }, [task.id, prevStatus, onStatusChange]);

  const handleSwipeLeft = useCallback(() => {
    if (nextStatus) {
      Vibration.vibrate(30);
      onStatusChange?.(task.id, nextStatus.key);
      swipeableRef.current?.close();
    }
  }, [task.id, nextStatus, onStatusChange]);

  const handleCheckboxToggle = useCallback((newValue) => {
    onToggleDone?.(task.id, newValue);
  }, [task.id, onToggleDone]);

  const renderLeftActions = useCallback((_progress, translation) => {
    if (!prevStatus) return null;

    return (
      <TouchableOpacity onPress={handleSwipeRight} activeOpacity={0.8}>
        <SwipeReveal
          value={translation}
          inputRange={[0, 50, 100]}
          opacityRange={[0, 0.8, 1]}
          translateRange={[-20, 0, 0]}
          style={[
            styles.swipeAction,
            styles.swipeActionLeft,
            { backgroundColor: prevStatus.color + '22', borderColor: prevStatus.color },
          ]}
        >
          <Ionicons name="arrow-back" size={18} color={prevStatus.color} />
          <View style={styles.swipeActionContent}>
            <Text style={[styles.swipeActionText, { color: prevStatus.color }]}>
              {prevStatus.label}
            </Text>
            <View style={[styles.statusIndicator, { backgroundColor: prevStatus.color }]} />
          </View>
        </SwipeReveal>
      </TouchableOpacity>
    );
  }, [prevStatus, handleSwipeRight]);

  const renderRightActions = useCallback((_progress, translation) => {
    if (!nextStatus) return null;

    return (
      <TouchableOpacity onPress={handleSwipeLeft} activeOpacity={0.8}>
        <SwipeReveal
          value={translation}
          inputRange={[-100, -50, 0]}
          opacityRange={[1, 0.8, 0]}
          translateRange={[0, 0, 20]}
          style={[
            styles.swipeAction,
            styles.swipeActionRight,
            { backgroundColor: nextStatus.color + '22', borderColor: nextStatus.color },
          ]}
        >
          <View style={styles.swipeActionContent}>
            <Text style={[styles.swipeActionText, { color: nextStatus.color }]}>
              {nextStatus.label}
            </Text>
            <View style={[styles.statusIndicator, { backgroundColor: nextStatus.color }]} />
          </View>
          <Ionicons name="arrow-forward" size={18} color={nextStatus.color} />
        </SwipeReveal>
      </TouchableOpacity>
    );
  }, [nextStatus, handleSwipeLeft]);

  const cardContent = (
    <GlassCard
      style={[
        styles.taskCard,
        { borderLeftWidth: 3, borderLeftColor: priorityColor },
        isMoving && styles.taskCardMoving,
        isDragging && styles.taskCardDragging,
      ]}
      animated={!isMoving && !isDragging}
      delay={index * 40}
      glow={task.priority === 'critical' || isMoving || isDragging}
    >
      <TouchableOpacity
        onPress={() => onPress(task)}
        onLongPress={() => {
          Vibration.vibrate(50);
          if (drag) {
            drag();
          } else {
            onLongPress?.(task);
          }
        }}
        activeOpacity={0.7}
        delayLongPress={300}
        disabled={isDragging}
      >
        {isMoving && (
          <View style={styles.movingBadge}>
            <Ionicons name="move" size={12} color={COLORS.primary} />
            <Text style={styles.movingBadgeText}>Moving... tap a column</Text>
          </View>
        )}

        {isDragging && (
          <View style={styles.draggingBadge}>
            <Ionicons name="hand-left" size={12} color={COLORS.primary} />
            <Text style={styles.draggingBadgeText}>Dragging...</Text>
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
          <Ionicons
            name={PRIORITY_ICONS[task.priority] || 'remove-circle-outline'}
            size={16}
            color={priorityColor}
          />
        </View>

        {projectName && (
          <View style={styles.taskMetaRow}>
            <Ionicons name="folder-outline" size={12} color={COLORS.secondary} />
            <Text style={[styles.taskMetaText, { color: COLORS.secondary }]} numberOfLines={1}>
              {projectName}
            </Text>
          </View>
        )}

        {task.assignee && (
          <View style={styles.taskMetaRow}>
            <View style={styles.assigneeBadge}>
              <Text style={styles.assigneeInitial}>
                {task.assignee.charAt(0).toUpperCase()}
              </Text>
            </View>
            <Text style={styles.taskMetaText}>{task.assignee}</Text>
          </View>
        )}

        {task.dueDate && (
          <View style={styles.taskMetaRow}>
            <Ionicons name="calendar-outline" size={12} color={isOverdue ? COLORS.error : COLORS.textMuted} />
            <Text style={[styles.taskMetaText, isOverdue && { color: COLORS.error }]}>
              {task.dueDate}
            </Text>
          </View>
        )}

        {task.department?.length > 0 && (
          <View style={styles.tagRow}>
            {task.department.slice(0, 3).map((d, i) => (
              <View key={i} style={styles.tag}>
                <Text style={styles.tagText}>{d}</Text>
              </View>
            ))}
            {task.department.length > 3 && (
              <View style={[styles.tag, styles.tagMore]}>
                <Text style={styles.tagText}>+{task.department.length - 3}</Text>
              </View>
            )}
          </View>
        )}

        {/* Swipe hint indicator */}
        {!isMoving && !isDragging && (
          <View style={styles.swipeHint}>
            {prevStatus && <Ionicons name="chevron-back" size={10} color={COLORS.textMuted} />}
            <Ionicons name="swap-horizontal" size={12} color={COLORS.textMuted} />
            {nextStatus && <Ionicons name="chevron-forward" size={10} color={COLORS.textMuted} />}
          </View>
        )}
      </TouchableOpacity>
    </GlassCard>
  );

  // If no swipe actions available, just render the card
  if (!prevStatus && !nextStatus) {
    return cardContent;
  }

  return (
    <Swipeable
      ref={swipeableRef}
      renderLeftActions={prevStatus ? renderLeftActions : undefined}
      renderRightActions={nextStatus ? renderRightActions : undefined}
      // ReanimatedSwipeable reports the swipe direction: 'right' = left actions opened.
      onSwipeableOpen={(direction) => {
        if (direction === 'right') handleSwipeRight();
        else if (direction === 'left') handleSwipeLeft();
      }}
      leftThreshold={60}
      rightThreshold={60}
      friction={2}
      overshootLeft={false}
      overshootRight={false}
      enabled={!isDragging && !isMoving}
    >
      {cardContent}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  taskCard: {
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  taskCardMoving: {
    borderColor: COLORS.primary,
    borderWidth: 2,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  taskCardDragging: {
    borderColor: COLORS.primary,
    borderWidth: 2,
    backgroundColor: COLORS.cardBorder,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 12,
    transform: [{ scale: 1.02 }],
  },
  movingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.primary + '22',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  movingBadgeText: {
    ...FONTS.tiny,
    color: COLORS.primary,
    fontWeight: '600',
  },
  draggingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.primary + '33',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  draggingBadgeText: {
    ...FONTS.tiny,
    color: COLORS.primary,
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
    marginRight: 8,
    gap: 10,
  },
  taskTitle: {
    ...FONTS.small,
    color: COLORS.text,
    fontWeight: '600',
    flex: 1,
  },
  taskTitleDone: {
    textDecorationLine: 'line-through',
    opacity: 0.5,
  },
  taskMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  taskMetaText: {
    ...FONTS.tiny,
    color: COLORS.textSecondary,
  },
  assigneeBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: COLORS.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  assigneeInitial: {
    ...FONTS.tiny,
    color: COLORS.primary,
    fontWeight: '700',
    fontSize: 10,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    gap: 4,
  },
  tag: {
    backgroundColor: COLORS.primaryLight,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tagMore: {
    backgroundColor: COLORS.surfaceLight,
  },
  tagText: {
    ...FONTS.tiny,
    color: COLORS.primary,
    fontSize: 9,
  },
  swipeHint: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    opacity: 0.3,
  },
  swipeAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
    minWidth: 90,
    height: '85%',
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  swipeActionLeft: {
    marginLeft: SPACING.xs,
    marginRight: SPACING.xs,
  },
  swipeActionRight: {
    marginRight: SPACING.xs,
    marginLeft: SPACING.xs,
  },
  swipeActionContent: {
    alignItems: 'center',
    gap: 4,
  },
  swipeActionText: {
    ...FONTS.tiny,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statusIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});

export default SwipeableTaskCard;
