import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Switch, TextInput, Alert, ActivityIndicator, Modal, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, FONTS, SPACING } from '../../constants/theme';
import { GlassCard } from '../../components/GlassCard';

const HOUR_OPTS = Array.from({ length: 24 }, (_, i) => i);

function SettingRow({ label, sublabel, children }) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingLeft}>
        <Text style={styles.settingLabel}>{label}</Text>
        {sublabel ? <Text style={styles.settingSub}>{sublabel}</Text> : null}
      </View>
      <View style={styles.settingRight}>{children}</View>
    </View>
  );
}

function Section({ title, children }) {
  return (
    <GlassCard style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </GlassCard>
  );
}

function HourPicker({ value, onChange, label }) {
  return (
    <TouchableOpacity
      style={styles.hourPicker}
      onPress={() => {
        Alert.alert(label, 'Enter hour (0–23)', [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'OK',
            onPress: () => {},
          },
        ]);
      }}
    >
      <Text style={styles.hourValue}>{String(value).padStart(2, '0')}:00</Text>
    </TouchableOpacity>
  );
}

export function DisciplineSettingsScreen({ navigation, route }) {
  const { discipline } = route.params || {};
  const {
    settings,
    updateSettings,
    loading,
    loadNotionStatus,
    notionStatus,
  } = discipline || {};

  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [showTelegramHelp, setShowTelegramHelp] = useState(false);
  const [telegramChatIdDraft, setTelegramChatIdDraft] = useState(settings?.telegramChatId || '');
  // Cross-platform hour picker state
  const [hourModal, setHourModal] = useState(null); // { key, label, draft }

  const s = settings || {};

  const toggle = useCallback(async (key, value) => {
    setBusy(true);
    try {
      await updateSettings?.({ [key]: value });
    } finally {
      setBusy(false);
    }
  }, [updateSettings]);

  const setHour = useCallback((key) => {
    setHourModal({ key, label: key.replace(/([A-Z])/g, ' $1').toLowerCase(), draft: String(s[key] ?? 0) });
  }, [s]);

  const commitHour = useCallback(() => {
    if (!hourModal) return;
    const n = parseInt(hourModal.draft, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 23) {
      updateSettings?.({ [hourModal.key]: n });
    }
    setHourModal(null);
  }, [hourModal, updateSettings]);

  const saveTelegramChatId = useCallback(async () => {
    setBusy(true);
    try {
      await updateSettings?.({ telegramChatId: telegramChatIdDraft.trim() });
    } finally {
      setBusy(false);
    }
  }, [updateSettings, telegramChatIdDraft]);

  const toggleTelegramEvent = useCallback(async (key, value) => {
    const updated = { ...(s.telegramEvents || {}), [key]: value };
    setBusy(true);
    try {
      await updateSettings?.({ telegramEvents: updated });
    } finally {
      setBusy(false);
    }
  }, [updateSettings, s.telegramEvents]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack?.()}>
          <Ionicons name="chevron-back" size={20} color={COLORS.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.heading}>Discipline Settings</Text>
        {busy ? <ActivityIndicator size="small" color={COLORS.primary} /> : <View style={{ width: 20 }} />}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Day boundaries */}
        <Section title="Day Boundaries">
          <SettingRow
            label="Day start"
            sublabel="Blocks scheduled before this hour are not shown on the timeline"
          >
            <TouchableOpacity
              style={styles.hourChip}
              onPress={() => setHour('dayStartHour')}
            >
              <Text style={styles.hourChipText}>{String(s.dayStartHour ?? 6).padStart(2, '0')}:00</Text>
            </TouchableOpacity>
          </SettingRow>
          <View style={styles.divider} />
          <SettingRow
            label="Day end"
            sublabel="End-of-day boundary for score computation"
          >
            <TouchableOpacity
              style={styles.hourChip}
              onPress={() => setHour('dayEndHour')}
            >
              <Text style={styles.hourChipText}>{String(s.dayEndHour ?? 23).padStart(2, '0')}:00</Text>
            </TouchableOpacity>
          </SettingRow>
        </Section>

        {/* Quiet hours */}
        <Section title="Quiet Hours">
          <Text style={styles.sectionSub}>
            Suppresses Telegram + notification nudges during these hours.
          </Text>
          <SettingRow label="Quiet from">
            <TouchableOpacity
              style={styles.hourChip}
              onPress={() => setHour('quietHoursStart')}
            >
              <Text style={styles.hourChipText}>{String(s.quietHoursStart ?? 22).padStart(2, '0')}:00</Text>
            </TouchableOpacity>
          </SettingRow>
          <View style={styles.divider} />
          <SettingRow label="Quiet until">
            <TouchableOpacity
              style={styles.hourChip}
              onPress={() => setHour('quietHoursEnd')}
            >
              <Text style={styles.hourChipText}>{String(s.quietHoursEnd ?? 6).padStart(2, '0')}:00</Text>
            </TouchableOpacity>
          </SettingRow>
        </Section>

        {/* Tracking */}
        <Section title="Tracking">
          <SettingRow
            label="Militant mode"
            sublabel="Marks blocks as missed immediately at their end time, no grace period"
          >
            <Switch
              value={!!s.militant}
              onValueChange={v => toggle('militant', v)}
              trackColor={{ false: COLORS.borderLight, true: COLORS.primary + '80' }}
              thumbColor={s.militant ? COLORS.primary : COLORS.textMuted}
            />
          </SettingRow>
          <View style={styles.divider} />
          <SettingRow
            label="Priority sort"
            sublabel="Sort blocks by linked Kanban task priority"
          >
            <Switch
              value={!!s.prioritySortEnabled}
              onValueChange={v => toggle('prioritySortEnabled', v)}
              trackColor={{ false: COLORS.borderLight, true: COLORS.primary + '80' }}
              thumbColor={s.prioritySortEnabled ? COLORS.primary : COLORS.textMuted}
            />
          </SettingRow>
          <View style={styles.divider} />
          <SettingRow
            label="Priority highlight"
            sublabel="Highlight critical-priority blocks in timeline"
          >
            <Switch
              value={!!s.priorityHighlight}
              onValueChange={v => toggle('priorityHighlight', v)}
              trackColor={{ false: COLORS.borderLight, true: COLORS.primary + '80' }}
              thumbColor={s.priorityHighlight ? COLORS.primary : COLORS.textMuted}
            />
          </SettingRow>
        </Section>

        {/* Telegram */}
        <Section title="Telegram Bridge">
          <Text style={styles.sectionSub}>
            Sends block start/end events to your Telegram chat. The bridge runs 24/7 server-side
            even when this app is closed.
          </Text>
          <SettingRow label="Enable Telegram">
            <Switch
              value={!!s.telegramEnabled}
              onValueChange={v => toggle('telegramEnabled', v)}
              trackColor={{ false: COLORS.borderLight, true: COLORS.primary + '80' }}
              thumbColor={s.telegramEnabled ? COLORS.primary : COLORS.textMuted}
            />
          </SettingRow>
          {s.telegramEnabled ? (
            <>
              <View style={styles.divider} />
              <View style={styles.chatIdRow}>
                <TextInput
                  style={styles.chatIdInput}
                  placeholder="Telegram Chat ID (leave blank for default)"
                  placeholderTextColor={COLORS.textMuted}
                  value={telegramChatIdDraft}
                  onChangeText={setTelegramChatIdDraft}
                  keyboardType="numbers-and-punctuation"
                  returnKeyType="done"
                  onSubmitEditing={saveTelegramChatId}
                />
                <TouchableOpacity style={styles.saveBtn} onPress={saveTelegramChatId}>
                  <Text style={styles.saveBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.divider} />
              <Text style={styles.eventToggleTitle}>Events to send:</Text>
              {[
                { key: 'blockStart', label: 'Block start' },
                { key: 'blockEnd', label: 'Block end' },
                { key: 'blockComplete', label: 'Block complete' },
                { key: 'abort', label: 'Aborted session' },
                { key: 'slip', label: 'Slippage warning' },
                { key: 'dailyReview', label: 'Daily review' },
              ].map(ev => (
                <SettingRow key={ev.key} label={ev.label}>
                  <Switch
                    value={!!(s.telegramEvents?.[ev.key])}
                    onValueChange={v => toggleTelegramEvent(ev.key, v)}
                    trackColor={{ false: COLORS.borderLight, true: COLORS.primary + '80' }}
                    thumbColor={s.telegramEvents?.[ev.key] ? COLORS.primary : COLORS.textMuted}
                  />
                </SettingRow>
              ))}
            </>
          ) : null}
        </Section>

        {/* Notion sync — status only */}
        <Section title="Notion Sync">
          <Text style={styles.sectionSub}>
            Sync discipline blocks and logs to a Notion database. Configure the target database
            on the web UI under Settings → Notion.
          </Text>
          <TouchableOpacity
            style={styles.refreshBtn}
            onPress={loadNotionStatus}
          >
            <Ionicons name="refresh" size={14} color={COLORS.primary} />
            <Text style={styles.refreshBtnText}>Check Notion status</Text>
          </TouchableOpacity>
          {notionStatus ? (
            <View style={styles.notionStatus}>
              <View style={[
                styles.notionDot,
                { backgroundColor: notionStatus.status === 'connected' ? '#10B981' : COLORS.textMuted }
              ]} />
              <Text style={styles.notionStatusText}>
                {notionStatus.status ?? 'unknown'}
                {notionStatus.lastSyncAt
                  ? `  ·  synced ${new Date(notionStatus.lastSyncAt).toLocaleTimeString()}`
                  : ''}
              </Text>
            </View>
          ) : null}
        </Section>

        {/* Danger zone */}
        <GlassCard style={[styles.section, { borderColor: '#EF444440' }]}>
          <Text style={[styles.sectionTitle, { color: '#EF4444' }]}>Danger Zone</Text>
          <TouchableOpacity
            style={styles.dangerBtn}
            onPress={() =>
              Alert.alert(
                'Reset today?',
                'This will clear all today\'s block completions and routine progress. It cannot be undone.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Reset', style: 'destructive',
                    onPress: async () => {
                      // TODO: discipline.reset_day endpoint not yet available
                      Alert.alert('Coming soon', 'Reset day endpoint is not yet available on this gateway version.');
                    },
                  },
                ]
              )
            }
          >
            <Ionicons name="trash-outline" size={16} color="#EF4444" />
            <Text style={styles.dangerBtnText}>Reset today's progress</Text>
          </TouchableOpacity>
        </GlassCard>
      </ScrollView>

      {/* Cross-platform hour picker modal */}
      <Modal visible={!!hourModal} transparent animationType="fade" onRequestClose={() => setHourModal(null)}>
        <View style={styles.modalOverlay}>
          <Pressable style={styles.modalBackdrop} onPress={() => setHourModal(null)} />
          <GlassCard style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Set hour (0–23)</Text>
            <Text style={styles.modalSub}>{hourModal?.label}</Text>
            <TextInput
              style={styles.modalInput}
              value={hourModal?.draft || ''}
              onChangeText={v => setHourModal(prev => prev ? { ...prev, draft: v } : null)}
              keyboardType="number-pad"
              maxLength={2}
              autoFocus
              selectTextOnFocus
              onSubmitEditing={commitHour}
              returnKeyType="done"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setHourModal(null)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirm} onPress={commitHour}>
                <Text style={styles.modalConfirmText}>Set</Text>
              </TouchableOpacity>
            </View>
          </GlassCard>
        </View>
      </Modal>
    </View>
  );
}

export default DisciplineSettingsScreen;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    gap: SPACING.sm,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { ...FONTS.small, color: COLORS.primary },
  heading: { ...FONTS.heading, color: COLORS.text, flex: 1, textAlign: 'center' },
  scroll: { flex: 1 },
  scrollContent: { padding: SPACING.lg, gap: SPACING.md },
  section: { padding: SPACING.lg, gap: 0 },
  sectionTitle: {
    ...FONTS.mono,
    color: COLORS.primary,
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: SPACING.md,
  },
  sectionSub: {
    ...FONTS.small,
    color: COLORS.textMuted,
    lineHeight: 18,
    marginBottom: SPACING.sm,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    gap: SPACING.md,
  },
  settingLeft: { flex: 1, gap: 2 },
  settingLabel: { ...FONTS.small, color: COLORS.text, fontWeight: '500' },
  settingSub: { ...FONTS.tiny, color: COLORS.textMuted, lineHeight: 16 },
  settingRight: { alignItems: 'flex-end' },
  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: 2 },
  hourChip: {
    backgroundColor: COLORS.primary + '18',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: COLORS.primary + '40',
  },
  hourChipText: { ...FONTS.small, color: COLORS.primary, fontWeight: '700' },
  chatIdRow: { flexDirection: 'row', gap: SPACING.sm, alignItems: 'center', paddingVertical: SPACING.sm },
  chatIdInput: {
    flex: 1,
    ...FONTS.small,
    color: COLORS.text,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary + '30',
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  saveBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  saveBtnText: { ...FONTS.small, color: '#000', fontWeight: '700' },
  eventToggleTitle: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: SPACING.sm,
    marginBottom: 4,
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: SPACING.xs,
  },
  refreshBtnText: { ...FONTS.small, color: COLORS.primary },
  notionStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: SPACING.sm },
  notionDot: { width: 8, height: 8, borderRadius: 4 },
  notionStatusText: { ...FONTS.small, color: COLORS.textSecondary },
  dangerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
  },
  dangerBtnText: { ...FONTS.small, color: '#EF4444', fontWeight: '600' },
  // Hour picker modal
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  modalSheet: { padding: SPACING.xl, gap: SPACING.sm, borderRadius: 20, width: 240 },
  modalTitle: { ...FONTS.heading, color: COLORS.text, fontSize: 16 },
  modalSub: { ...FONTS.tiny, color: COLORS.textMuted },
  modalInput: {
    ...FONTS.heading,
    fontSize: 32,
    color: COLORS.primary,
    borderBottomWidth: 2,
    borderBottomColor: COLORS.primary,
    textAlign: 'center',
    paddingVertical: SPACING.sm,
  },
  modalActions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.xs },
  modalCancel: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
  },
  modalCancelText: { ...FONTS.small, color: COLORS.textMuted },
  modalConfirm: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: 8,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
  },
  modalConfirmText: { ...FONTS.small, color: '#000', fontWeight: '700' },
});
