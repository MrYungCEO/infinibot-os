import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput,
  Switch, Alert, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, FONTS, SPACING } from '../../constants/theme';
import { GlassCard } from '../../components/GlassCard';
import {
  CATEGORY_COLORS, CATEGORY_LABELS, DISCIPLINE_CATEGORIES,
  minsToHHMM, humanDuration, blockStatus, nowMinutes, todayIso,
} from '../../hooks/useDiscipline';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function TimeInput({ value, onChange, label }) {
  const [draft, setDraft] = useState(minsToHHMM(value));

  const commit = () => {
    const match = draft.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      setDraft(minsToHHMM(value));
      return;
    }
    const mins = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    if (mins >= 0 && mins <= 1440) onChange(mins);
  };

  return (
    <View style={styles.timeInputWrap}>
      <Text style={styles.timeInputLabel}>{label}</Text>
      <TextInput
        style={styles.timeInput}
        value={draft}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        keyboardType="numbers-and-punctuation"
        placeholder="HH:MM"
        placeholderTextColor={COLORS.textMuted}
      />
    </View>
  );
}

function CategoryPicker({ value, onChange }) {
  return (
    <View style={styles.catGrid}>
      {DISCIPLINE_CATEGORIES.map(cat => {
        const color = CATEGORY_COLORS[cat];
        const selected = value === cat;
        return (
          <TouchableOpacity
            key={cat}
            style={[
              styles.catChip,
              { borderColor: color + (selected ? 'FF' : '40') },
              selected && { backgroundColor: color + '18' },
            ]}
            onPress={() => onChange(cat)}
          >
            <Text style={[styles.catChipText, { color: selected ? color : COLORS.textMuted }]}>
              {CATEGORY_LABELS[cat]}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function DayPicker({ value, onChange }) {
  const toggle = (d) => {
    const next = value.includes(d)
      ? value.filter(x => x !== d)
      : [...value, d];
    onChange(next);
  };
  return (
    <View style={styles.dayRow}>
      {DAYS.map((day, i) => {
        const selected = value.includes(i);
        return (
          <TouchableOpacity
            key={day}
            style={[styles.dayChip, selected && styles.dayChipSelected]}
            onPress={() => toggle(i)}
          >
            <Text style={[styles.dayChipText, selected && styles.dayChipTextSelected]}>
              {day[0]}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function RoutineEditor({ items, onChange }) {
  const [newLabel, setNewLabel] = useState('');

  const addItem = () => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    const id = `ri_${Date.now().toString(36)}`;
    onChange([...items, { id, label: trimmed, order: items.length }]);
    setNewLabel('');
  };

  const removeItem = (id) => onChange(items.filter(i => i.id !== id));

  return (
    <View style={styles.routineEditor}>
      {items.map((item, idx) => (
        <View key={item.id} style={styles.routineItem}>
          <Ionicons name="reorder-three" size={16} color={COLORS.textMuted} />
          <Text style={styles.routineItemLabel} numberOfLines={1}>{item.label}</Text>
          <TouchableOpacity onPress={() => removeItem(item.id)} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
        </View>
      ))}
      <View style={styles.addRoutineRow}>
        <TextInput
          style={styles.routineInput}
          placeholder="Add step…"
          placeholderTextColor={COLORS.textMuted}
          value={newLabel}
          onChangeText={setNewLabel}
          onSubmitEditing={addItem}
          returnKeyType="done"
        />
        <TouchableOpacity style={styles.addRoutineBtn} onPress={addItem}>
          <Ionicons name="add" size={18} color={COLORS.primary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function DisciplineBlockDetailScreen({ navigation, route }) {
  const { block: initial, discipline, isNew = false } = route.params || {};
  const { createBlock, updateBlock, deleteBlock, markBlockComplete, unmarkBlockComplete, completedSet } = discipline || {};

  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    label: initial?.label || '',
    category: initial?.category || 'deep-work',
    intent: initial?.intent || '',
    startMinute: initial?.startMinute ?? 9 * 60,
    endMinute: initial?.endMinute ?? 10 * 60,
    days: initial?.days ?? [1, 2, 3, 4, 5],
    hard: initial?.hard ?? false,
    enabled: initial?.enabled !== false,
    nonNegotiable: initial?.nonNegotiable ?? false,
    routineItems: initial?.routineItems || [],
  });

  const set = useCallback((key, value) => setDraft(prev => ({ ...prev, [key]: value })), []);

  const isDone = !isNew && completedSet?.has(initial?.id);
  const status = !isNew && initial
    ? blockStatus(initial, nowMinutes(), completedSet || new Set(), todayIso())
    : null;

  const duration = draft.endMinute - draft.startMinute;

  const save = useCallback(async () => {
    if (!draft.label.trim()) {
      Alert.alert('Validation', 'Block name is required.');
      return;
    }
    if (draft.endMinute <= draft.startMinute) {
      Alert.alert('Validation', 'End time must be after start time.');
      return;
    }
    setBusy(true);
    try {
      if (isNew) {
        await createBlock?.(draft);
      } else {
        await updateBlock?.(initial.id, draft);
      }
      navigation?.goBack?.();
    } catch (err) {
      Alert.alert('Save failed', err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [draft, isNew, createBlock, updateBlock, initial?.id, navigation]);

  const remove = useCallback(() => {
    Alert.alert(
      'Delete block?',
      `"${initial?.label}" will be permanently deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await deleteBlock?.(initial.id);
              navigation?.goBack?.();
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  }, [initial?.id, initial?.label, deleteBlock, navigation]);

  const startFromNow = useCallback(() => {
    const nowMin = nowMinutes();
    const dur = Math.max(30, draft.endMinute - draft.startMinute);
    set('startMinute', nowMin);
    set('endMinute', Math.min(1440, nowMin + dur));
  }, [draft.endMinute, draft.startMinute, set]);

  const catColor = CATEGORY_COLORS[draft.category] || COLORS.primary;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack?.()}>
          <Ionicons name="chevron-back" size={20} color={COLORS.primary} />
          <Text style={styles.backText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.heading}>{isNew ? 'New Block' : 'Edit Block'}</Text>
        <TouchableOpacity
          style={[styles.saveBtn, busy && { opacity: 0.5 }]}
          onPress={save}
          disabled={busy}
        >
          {busy
            ? <ActivityIndicator size="small" color="#000" />
            : <Text style={styles.saveBtnText}>Save</Text>
          }
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Status / quick actions (edit only) */}
        {!isNew && status && status !== 'not-today' && status !== 'disabled' ? (
          <GlassCard style={styles.card}>
            <View style={styles.statusRow}>
              <Text style={styles.cardLabel}>Today's status</Text>
              <Text style={[styles.statusVal, { color: catColor }]}>
                {status.replace('-', ' ').toUpperCase()}
              </Text>
            </View>
            <View style={styles.quickActions}>
              <TouchableOpacity style={styles.quickBtn} onPress={startFromNow}>
                <Ionicons name="time-outline" size={14} color={COLORS.primary} />
                <Text style={styles.quickBtnText}>Start from now</Text>
              </TouchableOpacity>
              {isDone ? (
                <TouchableOpacity
                  style={[styles.quickBtn, { borderColor: COLORS.textMuted }]}
                  onPress={() => unmarkBlockComplete?.(initial.id)}
                >
                  <Ionicons name="close-circle-outline" size={14} color={COLORS.textMuted} />
                  <Text style={[styles.quickBtnText, { color: COLORS.textMuted }]}>Undo complete</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.quickBtn, { borderColor: '#10B981' }]}
                  onPress={() => markBlockComplete?.(initial.id)}
                >
                  <Ionicons name="checkmark-circle-outline" size={14} color="#10B981" />
                  <Text style={[styles.quickBtnText, { color: '#10B981' }]}>Mark complete</Text>
                </TouchableOpacity>
              )}
            </View>
          </GlassCard>
        ) : null}

        {/* Name */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardLabel}>Block name *</Text>
          <TextInput
            style={styles.textInput}
            placeholder="e.g. Morning Deep Work"
            placeholderTextColor={COLORS.textMuted}
            value={draft.label}
            onChangeText={v => set('label', v)}
            returnKeyType="next"
          />
        </GlassCard>

        {/* Category */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardLabel}>Category</Text>
          <CategoryPicker value={draft.category} onChange={v => set('category', v)} />
        </GlassCard>

        {/* Time */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardLabel}>Time</Text>
          <View style={styles.timeRow}>
            <TimeInput
              label="Start"
              value={draft.startMinute}
              onChange={v => set('startMinute', v)}
            />
            <Ionicons name="arrow-forward" size={16} color={COLORS.textMuted} style={{ marginTop: 22 }} />
            <TimeInput
              label="End"
              value={draft.endMinute}
              onChange={v => set('endMinute', v)}
            />
            {duration > 0 ? (
              <View style={styles.durBadge}>
                <Text style={styles.durText}>{humanDuration(duration)}</Text>
              </View>
            ) : null}
          </View>
        </GlassCard>

        {/* Repeat days */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardLabel}>Repeat on</Text>
          <DayPicker value={draft.days} onChange={v => set('days', v)} />
          {draft.days.length === 0 ? (
            <Text style={styles.helpText}>One-off block (today only)</Text>
          ) : null}
        </GlassCard>

        {/* Intent */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardLabel}>Intent / notes</Text>
          <TextInput
            style={[styles.textInput, { minHeight: 60 }]}
            placeholder="What's the goal of this block?"
            placeholderTextColor={COLORS.textMuted}
            value={draft.intent}
            onChangeText={v => set('intent', v)}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
        </GlassCard>

        {/* Flags */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardLabel}>Flags</Text>
          <View style={styles.flagRow}>
            <Text style={styles.flagLabel}>Enabled</Text>
            <Switch
              value={!!draft.enabled}
              onValueChange={v => set('enabled', v)}
              trackColor={{ false: COLORS.borderLight, true: COLORS.primary + '80' }}
              thumbColor={draft.enabled ? COLORS.primary : COLORS.textMuted}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.flagRow}>
            <View>
              <Text style={styles.flagLabel}>Hard block</Text>
              <Text style={styles.flagSub}>Block cannot be skipped or rescheduled</Text>
            </View>
            <Switch
              value={!!draft.hard}
              onValueChange={v => set('hard', v)}
              trackColor={{ false: COLORS.borderLight, true: '#EF444480' }}
              thumbColor={draft.hard ? '#EF4444' : COLORS.textMuted}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.flagRow}>
            <View>
              <Text style={styles.flagLabel}>Non-negotiable</Text>
              <Text style={styles.flagSub}>Counts as a daily compliance failure if missed</Text>
            </View>
            <Switch
              value={!!draft.nonNegotiable}
              onValueChange={v => set('nonNegotiable', v)}
              trackColor={{ false: COLORS.borderLight, true: '#EF444480' }}
              thumbColor={draft.nonNegotiable ? '#EF4444' : COLORS.textMuted}
            />
          </View>
        </GlassCard>

        {/* Routine steps */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardLabel}>Routine steps</Text>
          <Text style={styles.helpText}>
            Optional checklist that must be completed within this block.
          </Text>
          <RoutineEditor
            items={draft.routineItems}
            onChange={v => set('routineItems', v)}
          />
        </GlassCard>

        {/* Delete */}
        {!isNew ? (
          <TouchableOpacity style={styles.deleteBtn} onPress={remove}>
            <Ionicons name="trash-outline" size={16} color="#EF4444" />
            <Text style={styles.deleteBtnText}>Delete block</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </View>
  );
}

export default DisciplineBlockDetailScreen;

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
  saveBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    minWidth: 56,
    alignItems: 'center',
  },
  saveBtnText: { ...FONTS.small, color: '#000', fontWeight: '700' },
  scrollContent: { padding: SPACING.lg, gap: SPACING.md },
  card: { padding: SPACING.lg, gap: SPACING.sm },
  cardLabel: {
    ...FONTS.mono,
    color: COLORS.primary,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  textInput: {
    ...FONTS.small,
    color: COLORS.text,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: SPACING.md,
  },
  timeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.sm },
  timeInputWrap: { flex: 1, gap: 4 },
  timeInputLabel: { ...FONTS.tiny, color: COLORS.textMuted },
  timeInput: {
    ...FONTS.regular,
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 18,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary + '40',
    backgroundColor: COLORS.primary + '08',
    padding: SPACING.sm,
    textAlign: 'center',
  },
  durBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: COLORS.primary + '12',
    borderRadius: 99,
    marginBottom: 4,
  },
  durText: { ...FONTS.tiny, color: COLORS.primary, fontWeight: '700' },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  catChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 99,
    borderWidth: 1,
  },
  catChipText: { ...FONTS.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  dayRow: { flexDirection: 'row', gap: SPACING.sm },
  dayChip: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  dayChipSelected: {
    backgroundColor: COLORS.primary + '20',
    borderColor: COLORS.primary,
  },
  dayChipText: { ...FONTS.small, color: COLORS.textMuted, fontWeight: '600' },
  dayChipTextSelected: { color: COLORS.primary },
  helpText: { ...FONTS.tiny, color: COLORS.textMuted, lineHeight: 16 },
  flagRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: SPACING.xs },
  flagLabel: { ...FONTS.small, color: COLORS.text, fontWeight: '500' },
  flagSub: { ...FONTS.tiny, color: COLORS.textMuted, marginTop: 1 },
  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: 4 },
  routineEditor: { gap: SPACING.xs },
  routineItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  routineItemLabel: { ...FONTS.small, color: COLORS.text, flex: 1 },
  addRoutineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  routineInput: {
    flex: 1,
    ...FONTS.small,
    color: COLORS.text,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  addRoutineBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary + '18',
    borderWidth: 1,
    borderColor: COLORS.primary + '40',
  },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusVal: { ...FONTS.mono, fontWeight: '700', letterSpacing: 1 },
  quickActions: { flexDirection: 'row', gap: SPACING.sm, flexWrap: 'wrap' },
  quickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: COLORS.primary + '50',
  },
  quickBtnText: { ...FONTS.tiny, color: COLORS.primary, fontWeight: '700' },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    justifyContent: 'center',
    paddingVertical: SPACING.md,
  },
  deleteBtnText: { ...FONTS.small, color: '#EF4444', fontWeight: '600' },
});
