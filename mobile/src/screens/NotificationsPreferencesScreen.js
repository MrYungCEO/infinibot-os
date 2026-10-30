// NotificationsPreferencesScreen — per-category notification settings.
// Fetched from / saved to gateway via notifications.preferences.get / .set.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  TextInput,
  ActivityIndicator,
  Animated,
  SafeAreaView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassCard } from '../components/GlassCard';
import { COLORS, FONTS, SPACING } from '../constants/theme';
import { getSeverityTokens } from '../constants/severity-tokens';

// ─── Constants ────────────────────────────────────────────────

const GOLD = COLORS.primary;

const SEVERITY_LEVELS = ['info', 'success', 'warn', 'error', 'critical'];

const SEVERITY_LABELS = {
  info:     'Info',
  success:  'Success',
  warn:     'Warn',
  error:    'Error',
  critical: 'Critical',
};

// Pull severity hex from the shared tokens module so every screen in the
// Alerts family agrees on a single palette. We resolve once at module load
// against the default theme colors; status colors are palette-stable, so
// re-resolving live would only change the brand-tinted 'subagent' token,
// which the preferences screen doesn't use here.
const SEVERITY_COLORS = (() => {
  const tok = getSeverityTokens(null);
  return {
    info:     tok.info.color,
    success:  tok.success.color,
    warn:     tok.warn.color,
    error:    tok.error.color,
    critical: tok.critical.color,
  };
})();

// Human-friendly label map
const CATEGORY_LABELS = {
  'agent.completed':             'Agent Completed',
  'agent.error':                 'Agent Error',
  'agent.input_required':        'Agent Needs Input',
  'terminal.exit':               'Terminal Exit',
  'cron.fired':                  'Scheduled Task',
  'discipline.alert':            'Discipline Alert',
  'kanban.task.assigned':        'Task Assigned',
  'kanban.task.due':             'Task Due',
  'business.lead.new':           'New Lead',
  'business.income.logged':      'Income Logged',
  'federation.node.online':      'Node Online',
  'federation.node.offline':     'Node Offline',
  'system.update.available':     'System Update',
  'voice.call.incoming':         'Incoming Call',
  'voice.call.missed':           'Missed Call',
  'chat.mentions':               'Chat Message',
  'autonomy.checkpoint':         'Autonomy Checkpoint',
  'autonomy.budget.warning':     'Budget Warning',
  'autonomy.budget.hit':         'Budget Limit Hit',
  'credits.threshold':           'Credits Low',
  'manual':                      'Test / Manual',
};

// Category icon map
const CATEGORY_ICONS = {
  'agent.completed':             'checkmark-circle-outline',
  'agent.error':                 'alert-circle-outline',
  'agent.input_required':        'help-circle-outline',
  'terminal.exit':               'terminal-outline',
  'cron.fired':                  'timer-outline',
  'discipline.alert':            'fitness-outline',
  'kanban.task.assigned':        'person-add-outline',
  'kanban.task.due':             'calendar-outline',
  'business.lead.new':           'person-outline',
  'business.income.logged':      'cash-outline',
  'federation.node.online':      'cloud-done-outline',
  'federation.node.offline':     'cloud-offline-outline',
  'system.update.available':     'download-outline',
  'voice.call.incoming':         'call-outline',
  'voice.call.missed':           'call-sharp',
  'chat.mentions':               'chatbubble-outline',
  'autonomy.checkpoint':         'shield-checkmark-outline',
  'autonomy.budget.warning':     'warning-outline',
  'autonomy.budget.hit':         'ban-outline',
  'credits.threshold':           'flash-outline',
  'manual':                      'flask-outline',
};

// Category groups
const CATEGORY_GROUPS = [
  {
    key: 'ai',
    label: 'AI & Agents',
    icon: 'hardware-chip-outline',
    categories: [
      'agent.completed',
      'agent.error',
      'agent.input_required',
      'chat.mentions',
      'autonomy.checkpoint',
      'autonomy.budget.warning',
      'autonomy.budget.hit',
    ],
  },
  {
    key: 'tasks',
    label: 'Tasks & Work',
    icon: 'list-outline',
    categories: [
      'kanban.task.assigned',
      'kanban.task.due',
      'cron.fired',
      'terminal.exit',
    ],
  },
  {
    key: 'business',
    label: 'Business',
    icon: 'briefcase-outline',
    categories: [
      'business.lead.new',
      'business.income.logged',
    ],
  },
  {
    key: 'federation',
    label: 'Federation',
    icon: 'git-network-outline',
    categories: [
      'federation.node.online',
      'federation.node.offline',
    ],
  },
  {
    key: 'voice',
    label: 'Voice',
    icon: 'mic-outline',
    categories: [
      'voice.call.incoming',
      'voice.call.missed',
    ],
  },
  {
    key: 'system',
    label: 'System',
    icon: 'settings-outline',
    categories: [
      'system.update.available',
      'credits.threshold',
      'discipline.alert',
      'manual',
    ],
  },
];

// All categories, flat
const ALL_CATEGORIES = CATEGORY_GROUPS.flatMap(g => g.categories);

// Default preference entry for a category
function defaultCatPref() {
  return {
    enabled: true,
    sound: true,
    vibrate: true,
    banner: true,
    minSeverity: 'info',
  };
}

// ─── Sub-components ───────────────────────────────────────────

function SectionHeader({ label, icon }) {
  return (
    <View style={styles.sectionHeader}>
      <Ionicons name={icon} size={15} color={GOLD} />
      <Text style={styles.sectionHeaderText}>{label}</Text>
    </View>
  );
}

function CompactToggle({ value, onValueChange, tintColor }) {
  return (
    <Switch
      value={!!value}
      onValueChange={onValueChange}
      trackColor={{ false: 'rgba(255,255,255,0.1)', true: (tintColor || GOLD) + '55' }}
      thumbColor={value ? (tintColor || GOLD) : COLORS.textMuted}
      ios_backgroundColor="rgba(255,255,255,0.1)"
      style={styles.miniSwitch}
    />
  );
}

function SeverityChips({ value, onChange }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.severityChipsRow}
    >
      {SEVERITY_LEVELS.map(level => {
        const active = value === level;
        const color = SEVERITY_COLORS[level];
        return (
          <TouchableOpacity
            key={level}
            style={[
              styles.severityChip,
              active && { backgroundColor: color + '22', borderColor: color + 'AA' },
            ]}
            onPress={() => onChange(level)}
            activeOpacity={0.7}
          >
            <Text style={[styles.severityChipText, active && { color }]}>
              {SEVERITY_LABELS[level]}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

function CategoryRow({ category, prefs, onUpdate, onTest, testLoading }) {
  const pref = prefs || defaultCatPref();
  const icon = CATEGORY_ICONS[category] || 'notifications-outline';
  const label = CATEGORY_LABELS[category] || category;

  return (
    <View style={styles.catRow}>
      {/* Icon + label */}
      <View style={styles.catLabelWrap}>
        <Ionicons
          name={icon}
          size={16}
          color={pref.enabled ? GOLD : COLORS.textMuted}
          style={{ marginRight: 8 }}
        />
        <Text style={[styles.catLabel, !pref.enabled && styles.catLabelDisabled]} numberOfLines={1}>
          {label}
        </Text>
      </View>

      {/* Mini toggles */}
      <View style={styles.catToggles}>
        {/* Enabled */}
        <View style={styles.toggleCol}>
          <Text style={styles.toggleColLabel}>On</Text>
          <CompactToggle
            value={pref.enabled}
            onValueChange={v => onUpdate({ ...pref, enabled: v })}
            tintColor={GOLD}
          />
        </View>
        {/* Sound */}
        <View style={styles.toggleCol}>
          <Text style={styles.toggleColLabel}>Sound</Text>
          <CompactToggle
            value={pref.sound}
            onValueChange={v => onUpdate({ ...pref, sound: v })}
            tintColor="#60A5FA"
          />
        </View>
        {/* Vibrate */}
        <View style={styles.toggleCol}>
          <Text style={styles.toggleColLabel}>Vibe</Text>
          <CompactToggle
            value={pref.vibrate}
            onValueChange={v => onUpdate({ ...pref, vibrate: v })}
            tintColor="#A78BFA"
          />
        </View>
        {/* Banner */}
        <View style={styles.toggleCol}>
          <Text style={styles.toggleColLabel}>Banner</Text>
          <CompactToggle
            value={pref.banner}
            onValueChange={v => onUpdate({ ...pref, banner: v })}
            tintColor="#34D399"
          />
        </View>
      </View>

      {/* Min severity selector */}
      <SeverityChips
        value={pref.minSeverity || 'info'}
        onChange={v => onUpdate({ ...pref, minSeverity: v })}
      />

      {/* Test button */}
      <TouchableOpacity
        style={styles.testBtn}
        onPress={() => onTest(category)}
        activeOpacity={0.7}
        disabled={testLoading === category}
      >
        {testLoading === category ? (
          <ActivityIndicator size="small" color={GOLD} />
        ) : (
          <>
            <Ionicons name="flask-outline" size={12} color={GOLD} />
            <Text style={styles.testBtnText}>Test</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────

export function NotificationsPreferencesScreen({ navigation, route }) {
  const { gateway, pushToken } = route.params || {};

  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [testLoading, setTestLoading] = useState(null);

  // Quiet hours
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('07:00');

  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  }, []);

  // Load prefs on mount
  useEffect(() => {
    if (!gateway) { setLoading(false); return; }
    setLoading(true);
    gateway.sendReq('notifications.preferences.get', {})
      .then(res => {
        const serverPrefs = res?.prefs || res || {};
        // Hydrate all known categories with defaults
        const hydrated = {};
        for (const cat of ALL_CATEGORIES) {
          hydrated[cat] = { ...defaultCatPref(), ...(serverPrefs.categories?.[cat] || serverPrefs[cat] || {}) };
        }
        setPrefs(hydrated);

        // Quiet hours from server
        if (serverPrefs.quietHours) {
          setQuietEnabled(!!serverPrefs.quietHours.enabled);
          if (serverPrefs.quietHours.start) setQuietStart(serverPrefs.quietHours.start);
          if (serverPrefs.quietHours.end) setQuietEnd(serverPrefs.quietHours.end);
        }
      })
      .catch(err => {
        // If preferences don't exist yet, start with defaults
        const defaults = {};
        for (const cat of ALL_CATEGORIES) {
          defaults[cat] = defaultCatPref();
        }
        setPrefs(defaults);
        setError(null); // not fatal
      })
      .finally(() => setLoading(false));
  }, [gateway]);

  const updateCatPref = useCallback((category, newPref) => {
    setPrefs(prev => ({ ...prev, [category]: newPref }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!gateway) { Alert.alert('No gateway', 'Cannot save without a gateway connection.'); return; }
    setSaving(true);
    try {
      await gateway.sendReq('notifications.preferences.set', {
        prefs: {
          categories: prefs,
          quietHours: {
            enabled: quietEnabled,
            start: quietStart,
            end: quietEnd,
          },
        },
      });
      Alert.alert('Saved', 'Notification preferences saved.');
    } catch (err) {
      Alert.alert('Save failed', err?.message || String(err));
    } finally {
      setSaving(false);
    }
  }, [gateway, prefs, quietEnabled, quietStart, quietEnd]);

  const handleTest = useCallback(async (category) => {
    if (!gateway) return;
    setTestLoading(category);
    try {
      await gateway.sendReq('notifications.test', { category, severity: 'info' });
    } catch (err) {
      Alert.alert('Test failed', err?.message || String(err));
    } finally {
      setTestLoading(null);
    }
  }, [gateway]);

  const handleGlobalTest = useCallback(async () => {
    if (!gateway) return;
    setTestLoading('__global__');
    try {
      await gateway.sendReq('notifications.test', { category: 'manual', severity: 'info' });
    } catch (err) {
      Alert.alert('Test failed', err?.message || String(err));
    } finally {
      setTestLoading(null);
    }
  }, [gateway]);

  const tokenDisplay = pushToken
    ? `…${String(pushToken).slice(-10)}`
    : 'Not registered';

  return (
    <SafeAreaView style={styles.safeArea}>
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
            <Ionicons name="chevron-back" size={18} color={GOLD} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.screenTitle}>Notification Preferences</Text>
        </View>

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={GOLD} size="large" />
            <Text style={styles.loadingText}>Loading preferences…</Text>
          </View>
        ) : (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {error ? (
              <View style={styles.errorRow}>
                <Ionicons name="warning-outline" size={14} color={COLORS.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {/* ── Per-Category Settings ─────────────────────── */}
            <SectionHeader label="Per-Category Settings" icon="notifications-outline" />

            {CATEGORY_GROUPS.map(group => (
              <GlassCard key={group.key} style={styles.groupCard} animated>
                <View style={styles.groupHeader}>
                  <Ionicons name={group.icon} size={14} color={GOLD} />
                  <Text style={styles.groupLabel}>{group.label}</Text>
                </View>
                {group.categories.map((cat, idx) => (
                  <View key={cat}>
                    {idx > 0 ? <View style={styles.catDivider} /> : null}
                    <CategoryRow
                      category={cat}
                      prefs={prefs?.[cat]}
                      onUpdate={newPref => updateCatPref(cat, newPref)}
                      onTest={handleTest}
                      testLoading={testLoading}
                    />
                  </View>
                ))}
              </GlassCard>
            ))}

            {/* ── Quiet Hours ───────────────────────────────── */}
            <SectionHeader label="Quiet Hours" icon="moon-outline" />

            <GlassCard style={styles.quietCard} animated delay={80}>
              <View style={styles.quietRow}>
                <View style={styles.quietLabelWrap}>
                  <Ionicons name="moon-outline" size={16} color={GOLD} />
                  <Text style={styles.quietLabel}>Enable Quiet Hours</Text>
                </View>
                <Switch
                  value={quietEnabled}
                  onValueChange={setQuietEnabled}
                  trackColor={{ false: 'rgba(255,255,255,0.1)', true: GOLD + '55' }}
                  thumbColor={quietEnabled ? GOLD : COLORS.textMuted}
                  ios_backgroundColor="rgba(255,255,255,0.1)"
                />
              </View>
              {quietEnabled ? (
                <View style={styles.quietTimes}>
                  <View style={styles.quietTimeField}>
                    <Text style={styles.quietTimeLabel}>Start</Text>
                    <TextInput
                      style={styles.quietTimeInput}
                      value={quietStart}
                      onChangeText={setQuietStart}
                      placeholder="22:00"
                      placeholderTextColor={COLORS.textMuted}
                      keyboardType="numeric"
                      maxLength={5}
                    />
                  </View>
                  <Ionicons name="arrow-forward" size={14} color={COLORS.textMuted} style={{ marginTop: 20 }} />
                  <View style={styles.quietTimeField}>
                    <Text style={styles.quietTimeLabel}>End</Text>
                    <TextInput
                      style={styles.quietTimeInput}
                      value={quietEnd}
                      onChangeText={setQuietEnd}
                      placeholder="07:00"
                      placeholderTextColor={COLORS.textMuted}
                      keyboardType="numeric"
                      maxLength={5}
                    />
                  </View>
                </View>
              ) : null}
            </GlassCard>

            {/* ── Push Token Status ─────────────────────────── */}
            <SectionHeader label="Push Token Status" icon="key-outline" />

            <GlassCard style={styles.tokenCard} animated delay={100}>
              <View style={styles.tokenRow}>
                <View
                  style={[
                    styles.tokenDot,
                    { backgroundColor: pushToken ? '#22C55E' : COLORS.error },
                  ]}
                />
                <Text style={styles.tokenStatus}>
                  {pushToken ? 'Registered' : 'Not registered'}
                </Text>
              </View>
              <Text style={styles.tokenValue}>{tokenDisplay}</Text>
            </GlassCard>

            {/* ── Test Notifications ────────────────────────── */}
            <SectionHeader label="Test Notifications" icon="flask-outline" />

            <GlassCard style={styles.testCard} animated delay={120}>
              <Text style={styles.testNote}>
                Fire a real test notification for a specific category to verify delivery.
              </Text>
              <TouchableOpacity
                style={styles.globalTestBtn}
                onPress={handleGlobalTest}
                activeOpacity={0.8}
                disabled={testLoading !== null}
              >
                {testLoading === '__global__' ? (
                  <ActivityIndicator size="small" color="#0F0F0F" />
                ) : (
                  <>
                    <Ionicons name="send-outline" size={16} color="#0F0F0F" />
                    <Text style={styles.globalTestText}>Send Global Test</Text>
                  </>
                )}
              </TouchableOpacity>
            </GlassCard>

            {/* Bottom spacer for save button */}
            <View style={{ height: 80 }} />
          </ScrollView>
        )}

        {/* Fixed Save button */}
        {!loading ? (
          <View style={styles.saveBarWrap}>
            <TouchableOpacity
              style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
              onPress={handleSave}
              activeOpacity={0.85}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#0F0F0F" />
              ) : (
                <>
                  <Ionicons name="checkmark-done-outline" size={18} color="#0F0F0F" />
                  <Text style={styles.saveBtnText}>Save Preferences</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : null}
      </Animated.View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: 'rgba(10,10,10,0.97)',
  },
  container: {
    flex: 1,
  },

  // Header
  header: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: SPACING.xs,
  },
  backText: {
    ...FONTS.small,
    color: GOLD,
    fontWeight: '600',
  },
  screenTitle: {
    ...FONTS.heading,
    color: GOLD,
    fontSize: 22,
  },

  // Loading
  loadingWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    ...FONTS.small,
    color: COLORS.textMuted,
  },

  // Error
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: SPACING.sm,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 10,
    padding: SPACING.sm,
  },
  errorText: {
    ...FONTS.small,
    color: COLORS.error,
    flex: 1,
  },

  // Scroll
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.xs,
  },

  // Section headers
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: SPACING.lg,
    marginBottom: SPACING.sm,
  },
  sectionHeaderText: {
    ...FONTS.tiny,
    color: GOLD,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  // Group card
  groupCard: {
    marginBottom: SPACING.sm,
    padding: SPACING.md,
    backgroundColor: 'rgba(15,15,15,0.6)',
    borderColor: COLORS.cardBorder,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: SPACING.md,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primaryLight,
  },
  groupLabel: {
    ...FONTS.small,
    color: GOLD,
    fontWeight: '700',
  },

  // Category row
  catDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    marginVertical: SPACING.sm,
  },
  catRow: {
    paddingVertical: 4,
  },
  catLabelWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  catLabel: {
    ...FONTS.small,
    color: COLORS.text,
    fontWeight: '600',
    flex: 1,
  },
  catLabelDisabled: {
    color: COLORS.textMuted,
  },
  catToggles: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: SPACING.xs,
  },
  toggleCol: {
    alignItems: 'center',
    gap: 2,
    flex: 1,
  },
  toggleColLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  miniSwitch: {
    transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }],
  },
  severityChipsRow: {
    gap: 5,
    paddingVertical: 4,
  },
  severityChip: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  severityChipText: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  testBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-end',
    borderWidth: 1,
    borderColor: GOLD + '44',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 4,
    backgroundColor: COLORS.primaryDim,
  },
  testBtnText: {
    ...FONTS.tiny,
    color: GOLD,
    fontWeight: '600',
    fontSize: 10,
  },

  // Quiet hours
  quietCard: {
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    backgroundColor: 'rgba(15,15,15,0.6)',
    borderColor: COLORS.cardBorder,
  },
  quietRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  quietLabelWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  quietLabel: {
    ...FONTS.small,
    color: COLORS.text,
    fontWeight: '600',
  },
  quietTimes: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    marginTop: SPACING.md,
  },
  quietTimeField: {
    flex: 1,
  },
  quietTimeLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    marginBottom: 4,
  },
  quietTimeInput: {
    ...FONTS.small,
    color: COLORS.text,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    borderRadius: 10,
    paddingHorizontal: SPACING.md,
    paddingVertical: 8,
    textAlign: 'center',
    fontFamily: 'monospace',
  },

  // Token status
  tokenCard: {
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    backgroundColor: 'rgba(15,15,15,0.6)',
    borderColor: COLORS.cardBorder,
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  tokenDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tokenStatus: {
    ...FONTS.small,
    color: COLORS.text,
    fontWeight: '600',
  },
  tokenValue: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: COLORS.textMuted,
    letterSpacing: 1,
  },

  // Test section
  testCard: {
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    backgroundColor: 'rgba(15,15,15,0.6)',
    borderColor: COLORS.cardBorder,
  },
  testNote: {
    ...FONTS.small,
    color: COLORS.textSecondary,
    marginBottom: SPACING.md,
    lineHeight: 18,
  },
  globalTestBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: GOLD,
    borderRadius: 10,
    paddingVertical: 10,
  },
  globalTestText: {
    ...FONTS.small,
    color: '#0F0F0F',
    fontWeight: '700',
  },

  // Save bar
  saveBarWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.xl,
    paddingTop: SPACING.sm,
    backgroundColor: 'rgba(10,10,10,0.92)',
    borderTopWidth: 1,
    borderTopColor: COLORS.cardBorder,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: GOLD,
    borderRadius: 14,
    paddingVertical: 14,
    shadowColor: GOLD,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveBtnText: {
    ...FONTS.small,
    color: '#0F0F0F',
    fontWeight: '700',
    fontSize: 15,
  },
});
