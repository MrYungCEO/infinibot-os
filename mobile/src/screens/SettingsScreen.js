import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, RefreshControl, Animated, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassCard } from '../components/GlassCard';
import { GlowButton } from '../components/GlowButton';
import { PulsingDot } from '../components/PulsingDot';
import { NotificationSettings } from '../components/NotificationSettings';
import { COLORS, FONTS, SPACING } from '../constants/theme';
import { getGatewayUrl, setGatewayUrl, getAuthToken, setAuthToken, getMirrorCameraFromWeb, setMirrorCameraFromWeb } from '../utils/storage';
import { DEFAULT_GATEWAY_URL } from '../constants/gateway';
import { useTheme } from '../theme/ThemeProvider';
import { BACKGROUND_OPTIONS } from '../theme/palettes';

function CronJobCard({ job, index }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <GlassCard style={styles.cronCard} animated delay={index * 50}>
      <TouchableOpacity onPress={() => setExpanded(!expanded)} activeOpacity={0.7}>
        <View style={styles.cronHeader}>
          <Ionicons
            name={job.enabled === false ? 'pause-circle-outline' : 'timer-outline'}
            size={20}
            color={job.enabled === false ? COLORS.textMuted : COLORS.warning}
            style={{ marginRight: 10 }}
          />
          <View style={styles.cronInfo}>
            <Text style={styles.cronLabel} numberOfLines={1}>
              {job.label || job.id || 'Unnamed Job'}
            </Text>
            <Text style={styles.cronSchedule}>
              {job.cron || (typeof job.schedule === 'string' ? job.schedule : job.schedule?.expr || (job.schedule?.everyMs ? `Every ${Math.round(job.schedule.everyMs / 60000)}m` : job.schedule?.kind || '')) || job.interval || 'No schedule'}
            </Text>
          </View>
          <PulsingDot
            color={job.enabled === false ? COLORS.textMuted : COLORS.success}
            size={8}
          />
        </View>
        {expanded && (
          <View style={styles.cronDetails}>
            {job.task && <DetailRow label="Task" value={job.task} />}
            {job.channel && <DetailRow label="Channel" value={job.channel} />}
            {job.model && <DetailRow label="Model" value={job.model} />}
            {job.lastRun && <DetailRow label="Last Run" value={new Date(job.lastRun).toLocaleString()} />}
            {job.nextRun && <DetailRow label="Next Run" value={new Date(job.nextRun).toLocaleString()} />}
          </View>
        )}
      </TouchableOpacity>
    </GlassCard>
  );
}

function DetailRow({ label, value }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={3}>{value}</Text>
    </View>
  );
}

function ThemePanel() {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const activeMode = theme.syncEnabled ? (theme.masterTheme?.mode || theme.mode) : (theme.localOverride?.mode || theme.mode);
  const activePalette = theme.syncEnabled ? (theme.masterTheme?.paletteId || theme.palette) : (theme.localOverride?.paletteId || theme.palette);
  const activeBackground = theme.syncEnabled ? (theme.masterTheme?.background || theme.background) : (theme.localOverride?.background || theme.background);

  const applyToMasterOrLocal = useCallback(
    async (patch) => {
      setBusy(true);
      try {
        if (theme.syncEnabled) {
          await theme.pushThemeToMaster(patch);
        } else {
          const next = {
            mode: theme.localOverride?.mode ?? theme.mode,
            paletteId: theme.localOverride?.paletteId ?? theme.palette,
            background: theme.localOverride?.background ?? theme.background,
            tokens: theme.localOverride?.tokens ?? {},
            ...patch,
          };
          await theme.setLocalOverride(next);
        }
      } catch (err) {
        console.log('[theme] apply failed:', err?.message || err);
      } finally {
        setBusy(false);
      }
    },
    [theme],
  );

  return (
    <GlassCard style={{ padding: SPACING.lg, marginBottom: SPACING.md }} animated>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.md }}>
        <View style={{ flex: 1 }}>
          <Text style={{ ...FONTS.heading, color: COLORS.text, fontSize: 15 }}>Sync from master</Text>
          <Text style={{ ...FONTS.tiny, color: COLORS.textMuted, marginTop: 2 }}>
            {theme.syncEnabled ? 'Mobile follows the master device' : 'Local override active'}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => theme.setSyncEnabled(!theme.syncEnabled)}
          style={{
            width: 48,
            height: 28,
            borderRadius: 14,
            backgroundColor: theme.syncEnabled ? COLORS.primary : COLORS.surface,
            borderWidth: 1,
            borderColor: theme.syncEnabled ? COLORS.primary : COLORS.border,
            padding: 2,
            justifyContent: 'center',
          }}
          activeOpacity={0.85}
        >
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: theme.syncEnabled ? '#000' : COLORS.textMuted,
              transform: [{ translateX: theme.syncEnabled ? 20 : 0 }],
            }}
          />
        </TouchableOpacity>
      </View>

      <Text style={{ ...FONTS.mono, color: COLORS.textMuted, marginBottom: 6, letterSpacing: 1.5, textTransform: 'uppercase' }}>Mode</Text>
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: SPACING.md, flexWrap: 'wrap' }}>
        {['system', 'dark', 'light', 'hud'].map((m) => {
          const selected = activeMode === m;
          return (
            <TouchableOpacity
              key={m}
              disabled={busy}
              onPress={() => applyToMasterOrLocal({ mode: m })}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: selected ? COLORS.primary : COLORS.border,
                backgroundColor: selected ? COLORS.primaryDim : 'transparent',
              }}
            >
              <Text style={{ ...FONTS.small, color: selected ? COLORS.primary : COLORS.textSecondary }}>
                {m}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={{ ...FONTS.mono, color: COLORS.textMuted, marginBottom: 6, letterSpacing: 1.5, textTransform: 'uppercase' }}>Palette</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: SPACING.md }}>
        {theme.palettes.map((p) => {
          const selected = activePalette === p.id;
          const swatch = p.tokens?.primary || '#888';
          return (
            <TouchableOpacity
              key={p.id}
              disabled={busy}
              onPress={() => applyToMasterOrLocal({ paletteId: p.id })}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: selected ? COLORS.primary : COLORS.border,
                backgroundColor: selected ? COLORS.primaryDim : 'transparent',
              }}
            >
              <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: swatch }} />
              <Text style={{ ...FONTS.small, color: selected ? COLORS.primary : COLORS.text }}>
                {p.name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={{ ...FONTS.mono, color: COLORS.textMuted, marginBottom: 6, letterSpacing: 1.5, textTransform: 'uppercase' }}>Background</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {BACKGROUND_OPTIONS.map((b) => {
          const selected = activeBackground === b;
          return (
            <TouchableOpacity
              key={b}
              disabled={busy}
              onPress={() => applyToMasterOrLocal({ background: b })}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: selected ? COLORS.primary : COLORS.border,
                backgroundColor: selected ? COLORS.primaryDim : 'transparent',
              }}
            >
              <Text style={{ ...FONTS.tiny, color: selected ? COLORS.primary : COLORS.textSecondary }}>
                {b}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {busy && (
        <ActivityIndicator color={COLORS.primary} size="small" style={{ marginTop: SPACING.sm }} />
      )}
    </GlassCard>
  );
}

export function SettingsScreen({ gateway, notifications }) {
  const { sendReq, status } = gateway;
  const {
    settings: notifSettings,
    saveSettings: saveNotifSettings,
    permissionStatus,
    expoPushToken,
    scheduleLocalNotification,
  } = notifications || {};
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [cronJobs, setCronJobs] = useState([]);
  const [cronLoading, setCronLoading] = useState(false);
  const [cronError, setCronError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mirrorCamera, setMirrorCamera] = useState(true);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    loadSettings();
    Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
  }, []);

  const toggleMirrorCamera = useCallback(async (next) => {
    setMirrorCamera(next);
    await setMirrorCameraFromWeb(next);
  }, []);

  useEffect(() => { if (status === 'connected') loadCron(); }, [status]);

  async function loadSettings() {
    const storedUrl = await getGatewayUrl();
    const storedToken = await getAuthToken();
    setUrl(storedUrl);
    setToken(storedToken || '');
    try {
      const mirror = await getMirrorCameraFromWeb();
      setMirrorCamera(mirror !== false);
    } catch {}
  }

  const loadCron = useCallback(async () => {
    if (!sendReq || status !== 'connected') return;
    setCronLoading(true); setCronError(null);
    try {
      const res = await sendReq('cron.list', {});
      const jobs = res?.jobs || res || [];
      setCronJobs(Array.isArray(jobs) ? jobs : []);
    } catch (err) { setCronError(err.message); }
    finally { setCronLoading(false); }
  }, [sendReq, status]);

  async function handleSave() {
    const cleanUrl = url.trim() || DEFAULT_GATEWAY_URL;
    await setGatewayUrl(cleanUrl);
    await setAuthToken(token.trim() || null);
    setUrl(cleanUrl);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleReconnect() {
    gateway.disconnect();
    setTimeout(() => gateway.connect(), 500);
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await loadCron(); setRefreshing(false);
  }, [loadCron]);

  const statusColor = status === 'connected' ? COLORS.success :
    status === 'error' ? COLORS.error : COLORS.textMuted;

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh}
            tintColor={COLORS.primary} colors={[COLORS.primary]}
            progressBackgroundColor={COLORS.surface} />
        }
      >
        <GlassCard style={styles.statusCard} cornerAccents glow={status === 'connected'} animated>
          <View style={styles.statusRow}>
            <PulsingDot color={statusColor} size={10} />
            <View style={styles.statusInfo}>
              <Text style={[styles.statusLabel, { color: statusColor }]}>
                {status.toUpperCase()}
              </Text>
              <Text style={styles.statusSub}>Protocol v3 • webchat (mobile)</Text>
            </View>
          </View>
        </GlassCard>

        <Text style={styles.sectionTitle}>Gateway Connection</Text>

        <GlassCard style={styles.formCard} animated delay={100}>
          <Text style={styles.label}>WebSocket URL</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder={DEFAULT_GATEWAY_URL}
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={styles.label}>Gateway Password</Text>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder="Gateway password"
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />

          <GlowButton
            icon={saved ? 'checkmark' : undefined}
            title={saved ? 'Saved!' : 'Save Settings'}
            onPress={handleSave}
            variant="primary"
            size="lg"
            style={{ marginTop: SPACING.lg }}
          />

          <GlowButton
            title="Reconnect to Gateway"
            onPress={handleReconnect}
            variant="outline"
            size="lg"
            style={{ marginTop: SPACING.sm }}
          />
        </GlassCard>

        <View style={styles.divider} />

        {/* Notifications Section */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: SPACING.md, marginTop: SPACING.md }}>
          <Ionicons name="notifications-outline" size={18} color={COLORS.text} />
          <Text style={[styles.sectionTitle, { marginBottom: 0, marginTop: 0 }]}>Push Notifications</Text>
        </View>
        
        {notifications && (
          <NotificationSettings
            settings={notifSettings || {}}
            onSettingsChange={saveNotifSettings}
            permissionStatus={permissionStatus}
            pushToken={expoPushToken}
            onTestNotification={() => {
              scheduleLocalNotification?.({
                title: 'Test Notification',
                body: 'Push notifications are working',
                data: { type: 'test' },
              });
            }}
          />
        )}

        <View style={styles.divider} />

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: SPACING.md, marginTop: SPACING.md }}>
          <Ionicons name="color-palette-outline" size={18} color={COLORS.text} />
          <Text style={[styles.sectionTitle, { marginBottom: 0, marginTop: 0 }]}>Theme</Text>
        </View>
        <ThemePanel />

        <View style={styles.divider} />

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: SPACING.md, marginTop: SPACING.md }}>
          <Ionicons name="planet-outline" size={18} color={COLORS.text} />
          <Text style={[styles.sectionTitle, { marginBottom: 0, marginTop: 0 }]}>World Map</Text>
        </View>
        <GlassCard style={{ padding: SPACING.md }} animated>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1, paddingRight: SPACING.md }}>
              <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '600' }}>
                Mirror camera from web
              </Text>
              <Text style={{ color: COLORS.muted, fontSize: 12, marginTop: 4 }}>
                Follow the desktop UI's zoom &amp; pan in real time. A "← following web" pill flashes when the view syncs.
              </Text>
            </View>
            <Switch
              value={mirrorCamera}
              onValueChange={toggleMirrorCamera}
              trackColor={{ false: COLORS.border, true: COLORS.goldDim || COLORS.primary }}
              thumbColor={mirrorCamera ? (COLORS.gold || COLORS.primary) : COLORS.muted}
              ios_backgroundColor={COLORS.border}
            />
          </View>
        </GlassCard>

        <View style={styles.divider} />

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: SPACING.md, marginTop: SPACING.md }}>
          <Ionicons name="timer-outline" size={18} color={COLORS.text} />
          <Text style={[styles.sectionTitle, { marginBottom: 0, marginTop: 0 }]}>Scheduled Jobs</Text>
        </View>
        {cronError && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 }}>
            <Ionicons name="warning-outline" size={14} color={COLORS.error} />
            <Text style={styles.errorText}>{cronError}</Text>
          </View>
        )}
        {cronLoading && cronJobs.length === 0 && (
          <ActivityIndicator color={COLORS.primary} size="small" style={{ marginVertical: 10 }} />
        )}
        {cronJobs.length > 0 ? (
          cronJobs.map((job, i) => <CronJobCard key={job.id || i} job={job} index={i} />)
        ) : !cronLoading ? (
          <Text style={styles.emptyText}>No scheduled jobs</Text>
        ) : null}

        <View style={styles.divider} />

        <GlassCard style={styles.tipsCard} animated delay={200}>
          <Text style={styles.tipsTitle}>Tips</Text>
          <Text style={styles.tipText}>
            • For local dev, use ws://YOUR_IP:18789{'\n'}
            • Phone must be on same WiFi{'\n'}
            • Use wss:// for remote/secure connections
          </Text>
        </GlassCard>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Infinibot Mobile v2.0.0</Text>
          <Text style={styles.footerText}>Expo SDK 54 • Gold Edition</Text>
        </View>
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: SPACING.lg, paddingBottom: 60 },

  statusCard: { padding: SPACING.lg, marginBottom: SPACING.lg },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusInfo: { flex: 1 },
  statusLabel: { ...FONTS.mono, letterSpacing: 2, fontSize: 12 },
  statusSub: { ...FONTS.tiny, color: COLORS.textMuted, marginTop: 2 },

  sectionTitle: {
    ...FONTS.heading, color: COLORS.text, marginBottom: SPACING.md, marginTop: SPACING.md,
    fontSize: 16, letterSpacing: 0.5,
  },

  formCard: { padding: SPACING.lg },
  label: {
    ...FONTS.mono, color: COLORS.textMuted, marginBottom: SPACING.xs,
    marginTop: SPACING.md, textTransform: 'uppercase', letterSpacing: 1.5,
  },
  input: {
    backgroundColor: COLORS.inputBg, borderRadius: 12, paddingHorizontal: SPACING.lg,
    paddingVertical: 12, ...FONTS.regular, color: COLORS.text,
    borderWidth: 1, borderColor: COLORS.border,
  },

  divider: { height: 1, backgroundColor: COLORS.border, marginVertical: SPACING.xl },

  errorText: { color: COLORS.error, ...FONTS.small, marginBottom: 8 },
  emptyText: { color: COLORS.textMuted, ...FONTS.small, textAlign: 'center', marginVertical: 10 },

  cronCard: { padding: SPACING.md, marginBottom: SPACING.sm },
  cronHeader: { flexDirection: 'row', alignItems: 'center' },
  cronInfo: { flex: 1 },
  cronLabel: { ...FONTS.regular, color: COLORS.text, fontWeight: '600' },
  cronSchedule: { ...FONTS.tiny, color: COLORS.textMuted, marginTop: 1 },
  cronDetails: { marginTop: 10 },
  detailRow: {
    flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3,
    borderBottomWidth: 1, borderBottomColor: COLORS.borderLight,
  },
  detailLabel: { ...FONTS.small, color: COLORS.textMuted, marginRight: 8 },
  detailValue: { ...FONTS.small, color: COLORS.text, flex: 1, textAlign: 'right' },

  tipsCard: { padding: SPACING.lg },
  tipsTitle: { ...FONTS.small, color: COLORS.primary, fontWeight: '600', marginBottom: 6 },
  tipText: { ...FONTS.small, color: COLORS.textSecondary, lineHeight: 22 },

  footer: { marginTop: SPACING.xl * 2, alignItems: 'center' },
  footerText: { ...FONTS.tiny, color: COLORS.textMuted, marginVertical: 2, opacity: 0.5 },
});
