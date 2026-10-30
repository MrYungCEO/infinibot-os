// NotificationDetailScreen — full detail view for a single notification entry.
// Shown as a modal stack slide-over; receives notification, gateway, pushToken
// via route.params.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { openDeepLink } from '../navigation/deep-link-dispatcher';
import { resolveDeepLink } from '../navigation/deep-links';
import { getPluginList } from '../plugins/plugin-store';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  SafeAreaView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { GlassCard } from '../components/GlassCard';
import { COLORS, FONTS, SPACING } from '../constants/theme';
import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../theme/color-utils';
import {
  getSeverityTokens,
  severityKeyForNotification,
  preferredNotificationTitle,
  preferredNotificationBody,
} from '../constants/severity-tokens';

// ─── Helpers ──────────────────────────────────────────────────

const GOLD = COLORS.primary;

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
  if (diff < 2592000000) return `${Math.floor(diff / 86400000)} days ago`;
  return `${Math.floor(diff / 2592000000)} months ago`;
}

function absoluteTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Build a SEVERITY_CONFIG-shaped object from a live theme severityTokens map
// so the existing render code below can keep working unchanged. Keeps the same
// shape (color/label/icon) the local map used to expose.
function buildSeverityConfig(tokens) {
  const map = {};
  for (const key of Object.keys(tokens)) {
    map[key] = {
      color: tokens[key].color,
      label: tokens[key].label,
      icon: tokens[key].icon,
      tint: tokens[key].tint,
      border: tokens[key].border,
    };
  }
  return map;
}

function humanCategory(cat) {
  if (!cat) return 'General';
  return cat
    .split('.')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function parseDeepLink(deepLink) {
  // e.g. "mobile://chat?sessionKey=foo"
  try {
    const schemeEnd = deepLink.indexOf('://');
    if (schemeEnd === -1) return null;
    const rest = deepLink.slice(schemeEnd + 3);
    const qIdx = rest.indexOf('?');
    const path = qIdx === -1 ? rest : rest.slice(0, qIdx);
    const queryStr = qIdx === -1 ? '' : rest.slice(qIdx + 1);
    const params = {};
    if (queryStr) {
      queryStr.split('&').forEach(pair => {
        const [k, v] = pair.split('=');
        if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
      });
    }
    return { path: path.toLowerCase(), params };
  } catch {
    return null;
  }
}

const SNOOZE_OPTIONS = [
  { label: '15 min', ms: 15 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: 'Tomorrow 8am', ms: null }, // computed at call time
];

function tomorrowAt8am() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

// ─── Sub-components ───────────────────────────────────────────

function SeverityBadge({ severity, pulse, severityConfig }) {
  const cfg = severityConfig?.[severity] || severityConfig?.info || {
    color: '#3B82F6',
    label: 'INFO',
    icon: 'information-circle-outline',
    tint: 'rgba(59,130,246,0.15)',
    border: 'rgba(59,130,246,0.45)',
  };
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!pulse) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,   duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={[
        styles.severityBadge,
        { backgroundColor: cfg.tint, borderColor: cfg.border },
        pulse && { opacity: pulseAnim },
      ]}
    >
      <Ionicons name={cfg.icon} size={12} color={cfg.color} />
      <Text style={[styles.severityText, { color: cfg.color }]}>{cfg.label}</Text>
    </Animated.View>
  );
}

function CategoryChip({ category }) {
  return (
    <View style={styles.categoryChip}>
      <Text style={styles.categoryText}>{humanCategory(category)}</Text>
    </View>
  );
}

function ActionButton({ label, icon, color, onPress, disabled }) {
  return (
    <TouchableOpacity
      style={[
        styles.actionBtn,
        { borderColor: (color || GOLD) + '55', opacity: disabled ? 0.4 : 1 },
      ]}
      onPress={disabled ? undefined : onPress}
      activeOpacity={0.7}
    >
      <Ionicons name={icon} size={14} color={disabled ? COLORS.textMuted : (color || GOLD)} />
      <Text style={[styles.actionBtnText, { color: disabled ? COLORS.textMuted : (color || GOLD) }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function RelatedRow({ item, onPress }) {
  return (
    <TouchableOpacity style={styles.relatedRow} onPress={() => onPress(item)} activeOpacity={0.7}>
      <View style={styles.relatedDot} />
      <Text style={styles.relatedTitle} numberOfLines={1}>{item.title || 'Notification'}</Text>
      <Text style={styles.relatedTime}>{relativeTime(item.ts)}</Text>
      <Ionicons name="chevron-forward" size={12} color={COLORS.textMuted} />
    </TouchableOpacity>
  );
}

// ─── Main Screen ──────────────────────────────────────────────

export function NotificationDetailScreen({ navigation, route }) {
  const { notification: notif, gateway, pushToken } = route.params || {};

  const { colors: themeColors } = useTheme();
  const severityTokens = useRef(getSeverityTokens(themeColors)).current;
  const severityConfig = useRef(buildSeverityConfig(severityTokens)).current;

  const [notification, setNotification] = useState(notif || {});
  const [payloadExpanded, setPayloadExpanded] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [related, setRelated] = useState([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);

  const payloadAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  }, []);

  // Toggle payload collapsible
  useEffect(() => {
    Animated.timing(payloadAnim, {
      toValue: payloadExpanded ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [payloadExpanded]);

  const payloadMaxHeight = payloadAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 300],
  });

  // Load related alerts if sourceId present
  useEffect(() => {
    if (!notification.sourceId || !gateway) return;
    setRelatedLoading(true);
    gateway.sendReq('notifications.history.related', { sourceId: notification.sourceId })
      .then(res => {
        const items = Array.isArray(res?.notifications) ? res.notifications
          : Array.isArray(res) ? res : [];
        // Exclude self
        setRelated(items.filter(r => r.id !== notification.id).slice(0, 5));
      })
      .catch(() => {})
      .finally(() => setRelatedLoading(false));
  }, [notification.sourceId, notification.id, gateway]);

  const sendAction = useCallback(async (method, params) => {
    if (!gateway) return;
    try {
      setActionLoading(method);
      const res = await gateway.sendReq(method, { id: notification.id, ...params });
      // Merge server-side updated notification if returned
      if (res?.notification) setNotification(res.notification);
    } catch (err) {
      Alert.alert('Action failed', err?.message || String(err));
    } finally {
      setActionLoading(null);
    }
  }, [gateway, notification.id]);

  const isRead = pushToken
    ? (notification.readByToken || []).includes(pushToken)
    : false;
  const isDismissed = pushToken
    ? (notification.dismissedByToken || []).includes(pushToken)
    : false;
  const isAcked = pushToken
    ? (notification.ackByToken || []).includes(pushToken)
    : false;

  const needsAck = notification.category &&
    ['agent.input_required', 'autonomy.budget.warning', 'autonomy.budget.hit'].some(c =>
      notification.category.includes(c)
    );

  const sevKey = severityKeyForNotification(notification);
  const sevCfg = severityConfig[sevKey] || severityConfig.info;
  const isCritical = notification.severity === 'critical';
  const displayTitle = preferredNotificationTitle(notification);
  const displayBody = preferredNotificationBody(notification);

  const hasData = notification.data &&
    typeof notification.data === 'object' &&
    Object.keys(notification.data).length > 0;

  const handleDeepLink = useCallback(() => {
    const dl = notification.deepLink;
    if (!dl) return;
    // Shared routing table (src/navigation/deep-links.js) — plugin pages,
    // runs, approvals, documents … not just the five legacy paths.
    if (resolveDeepLink(dl, { plugins: getPluginList() }).unknown) {
      Alert.alert('Deep link not recognized', dl);
      return;
    }
    openDeepLink(dl);
  }, [navigation, notification.deepLink]);

  const handleSnooze = useCallback(async (optionIndex) => {
    setSnoozeOpen(false);
    let until;
    if (optionIndex === 2) {
      until = tomorrowAt8am();
    } else {
      until = Date.now() + SNOOZE_OPTIONS[optionIndex].ms;
    }
    await sendAction('notifications.snooze', { until, pushToken });
  }, [sendAction, pushToken]);

  const handleRelatedPress = useCallback((item) => {
    navigation.push('NotificationDetail', {
      notification: item,
      gateway,
      pushToken,
    });
  }, [navigation, gateway, pushToken]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        {/* Back button */}
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={18} color={GOLD} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Header card — severity stripe (gradient) + badge + category */}
          <GlassCard
            style={[
              styles.headerCard,
              { borderColor: sevCfg.border },
            ]}
            animated
            glow={isCritical}
            tint={sevKey === 'success' ? 'success' : sevKey === 'warn' ? 'warning' : sevKey === 'error' || sevKey === 'critical' ? 'danger' : 'primary'}
          >
            <LinearGradient
              colors={[sevCfg.color, withAlpha(sevCfg.color, 0)]}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={styles.headerCardStripe}
            />
            <View style={styles.badgeRow}>
              <SeverityBadge
                severity={sevKey}
                pulse={isCritical}
                severityConfig={severityConfig}
              />
              <CategoryChip category={notification.category} />
            </View>

            <Text style={styles.notifTitle}>{displayTitle || 'Notification'}</Text>

            {displayBody && displayBody !== notification.body ? (
              <Text style={styles.notifSummary} numberOfLines={3}>
                {displayBody}
              </Text>
            ) : null}

            <Text style={styles.timestamp}>
              {relativeTime(notification.ts)}
              {notification.ts ? ` • ${absoluteTime(notification.ts)}` : ''}
            </Text>

            {notification.source ? (
              <View style={styles.sourceChip}>
                <Ionicons name="radio-outline" size={11} color={COLORS.textMuted} />
                <Text style={styles.sourceText}>
                  {notification.source}
                  {notification.sourceId ? ` • ${notification.sourceId}` : ''}
                </Text>
              </View>
            ) : null}
          </GlassCard>

          {/* Body */}
          <GlassCard style={styles.bodyCard} animated delay={60} tint="neutral">
            <Text style={styles.sectionLabel}>Message</Text>
            <Text style={styles.bodyText}>{notification.body || displayBody || '(no body)'}</Text>
          </GlassCard>

          {/* Open in App */}
          {notification.deepLink ? (
            <TouchableOpacity style={styles.deepLinkBtn} onPress={handleDeepLink} activeOpacity={0.8}>
              <Ionicons name="open-outline" size={16} color="#0F0F0F" />
              <Text style={styles.deepLinkText}>Open in App</Text>
            </TouchableOpacity>
          ) : null}

          {/* Collapsible payload data */}
          {hasData ? (
            <GlassCard style={styles.payloadCard} animated delay={80} tint="neutral">
              <TouchableOpacity
                style={styles.payloadHeader}
                onPress={() => setPayloadExpanded(v => !v)}
                activeOpacity={0.7}
              >
                <Ionicons name="code-outline" size={14} color={GOLD} />
                <Text style={styles.payloadTitle}>Payload Data</Text>
                <View style={{ flex: 1 }} />
                <Ionicons
                  name={payloadExpanded ? 'chevron-up' : 'chevron-down'}
                  size={14}
                  color={COLORS.textMuted}
                />
              </TouchableOpacity>
              <Animated.View style={{ maxHeight: payloadMaxHeight, overflow: 'hidden' }}>
                <ScrollView
                  style={styles.payloadScroll}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator
                >
                  <Text style={styles.payloadJson}>
                    {JSON.stringify(notification.data, null, 2)}
                  </Text>
                </ScrollView>
              </Animated.View>
            </GlassCard>
          ) : null}

          {/* Action buttons */}
          <GlassCard style={styles.actionsCard} animated delay={100} tint="neutral">
            <Text style={styles.sectionLabel}>Actions</Text>
            <View style={styles.actionsRow}>
              <ActionButton
                label={isRead ? 'Mark Unread' : 'Mark Read'}
                icon={isRead ? 'mail-unread-outline' : 'mail-open-outline'}
                color={COLORS.primary}
                onPress={() => sendAction(
                  isRead ? 'notifications.markUnread' : 'notifications.markRead',
                  { pushToken }
                )}
                disabled={actionLoading !== null}
              />
              <ActionButton
                label="Dismiss"
                icon="close-circle-outline"
                color={COLORS.textSecondary}
                onPress={() => sendAction('notifications.dismiss', { pushToken })}
                disabled={isDismissed || actionLoading !== null}
              />
              {needsAck && !isAcked ? (
                <ActionButton
                  label="Acknowledge"
                  icon="checkmark-done-outline"
                  color={COLORS.success || '#22C55E'}
                  onPress={() => sendAction('notifications.ack', { pushToken })}
                  disabled={actionLoading !== null}
                />
              ) : null}
            </View>
            {actionLoading ? (
              <ActivityIndicator size="small" color={GOLD} style={{ marginTop: 8 }} />
            ) : null}
          </GlassCard>

          {/* Snooze */}
          <GlassCard style={styles.snoozeCard} animated delay={120} tint="neutral">
            <TouchableOpacity
              style={styles.snoozeToggle}
              onPress={() => setSnoozeOpen(v => !v)}
              activeOpacity={0.7}
            >
              <Ionicons name="alarm-outline" size={16} color={GOLD} />
              <Text style={styles.snoozeLabel}>Snooze</Text>
              {notification.snoozeUntil && Date.now() < notification.snoozeUntil ? (
                <Text style={styles.snoozeActive}>
                  until {absoluteTime(notification.snoozeUntil)}
                </Text>
              ) : null}
              <View style={{ flex: 1 }} />
              <Ionicons
                name={snoozeOpen ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={COLORS.textMuted}
              />
            </TouchableOpacity>
            {snoozeOpen ? (
              <View style={styles.snoozeOptions}>
                {SNOOZE_OPTIONS.map((opt, i) => (
                  <TouchableOpacity
                    key={i}
                    style={styles.snoozeOption}
                    onPress={() => handleSnooze(i)}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="time-outline" size={13} color={GOLD} />
                    <Text style={styles.snoozeOptionText}>{opt.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </GlassCard>

          {/* Related alerts */}
          {notification.sourceId ? (
            <GlassCard style={styles.relatedCard} animated delay={140} tint="neutral">
              <Text style={styles.sectionLabel}>Related Alerts</Text>
              {relatedLoading ? (
                <ActivityIndicator size="small" color={GOLD} style={{ marginTop: 8 }} />
              ) : related.length === 0 ? (
                <Text style={styles.relatedEmpty}>No related alerts found.</Text>
              ) : (
                related.map((item, i) => (
                  <RelatedRow key={item.id || i} item={item} onPress={handleRelatedPress} />
                ))
              )}
            </GlassCard>
          ) : null}

          {/* Bottom spacer */}
          <View style={{ height: 40 }} />
        </ScrollView>
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
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
    gap: 4,
  },
  backText: {
    ...FONTS.small,
    color: GOLD,
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.xs,
  },

  // Header card — GlassCard provides the blur stack; we keep padding +
  // overflow:hidden so the gradient stripe doesn't escape the rounded
  // corners.
  headerCard: {
    padding: SPACING.lg,
    paddingLeft: SPACING.lg + 4,
    marginBottom: SPACING.sm,
    borderRadius: 16,
    overflow: 'hidden',
  },
  headerCardStripe: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  notifSummary: {
    ...FONTS.small,
    color: COLORS.textMuted,
    marginTop: -SPACING.xs,
    marginBottom: SPACING.sm,
    fontSize: 13,
    lineHeight: 19,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: SPACING.sm,
    flexWrap: 'wrap',
  },
  severityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  severityText: {
    ...FONTS.tiny,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontSize: 10,
  },
  categoryChip: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.primaryStrong,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: COLORS.primaryDim,
  },
  categoryText: {
    ...FONTS.tiny,
    color: GOLD,
    fontWeight: '600',
    fontSize: 10,
  },
  notifTitle: {
    ...FONTS.heading,
    color: GOLD,
    fontSize: 20,
    marginBottom: SPACING.xs,
    lineHeight: 26,
  },
  timestamp: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    marginBottom: SPACING.sm,
  },
  sourceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  sourceText: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
  },

  // Body card
  bodyCard: {
    padding: SPACING.lg,
    marginBottom: SPACING.sm,
    backgroundColor: 'rgba(15,15,15,0.6)',
    borderColor: COLORS.cardBorder,
  },
  sectionLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: SPACING.sm,
  },
  bodyText: {
    ...FONTS.regular,
    color: COLORS.text,
    lineHeight: 22,
  },

  // Deep link
  deepLinkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: GOLD,
    borderRadius: 12,
    paddingVertical: 12,
    marginBottom: SPACING.sm,
  },
  deepLinkText: {
    ...FONTS.small,
    color: '#0F0F0F',
    fontWeight: '700',
  },

  // Payload
  payloadCard: {
    marginBottom: SPACING.sm,
    backgroundColor: 'rgba(15,15,15,0.6)',
    borderColor: COLORS.cardBorder,
  },
  payloadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: SPACING.md,
  },
  payloadTitle: {
    ...FONTS.small,
    color: COLORS.text,
    fontWeight: '600',
  },
  payloadScroll: {
    maxHeight: 300,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
  },
  payloadJson: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#A3E635',
    lineHeight: 16,
  },

  // Actions
  actionsCard: {
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    backgroundColor: 'rgba(15,15,15,0.6)',
    borderColor: COLORS.cardBorder,
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  actionBtnText: {
    ...FONTS.tiny,
    fontWeight: '600',
    fontSize: 12,
  },

  // Snooze
  snoozeCard: {
    marginBottom: SPACING.sm,
    backgroundColor: 'rgba(15,15,15,0.6)',
    borderColor: COLORS.cardBorder,
  },
  snoozeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: SPACING.md,
  },
  snoozeLabel: {
    ...FONTS.small,
    color: COLORS.text,
    fontWeight: '600',
  },
  snoozeActive: {
    ...FONTS.tiny,
    color: GOLD,
    marginLeft: 4,
  },
  snoozeOptions: {
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
    gap: 6,
  },
  snoozeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: SPACING.sm,
    borderRadius: 10,
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
  },
  snoozeOptionText: {
    ...FONTS.small,
    color: GOLD,
    fontWeight: '600',
  },

  // Related
  relatedCard: {
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    backgroundColor: 'rgba(15,15,15,0.6)',
    borderColor: COLORS.cardBorder,
  },
  relatedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  relatedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: GOLD,
    opacity: 0.5,
    flexShrink: 0,
  },
  relatedTitle: {
    ...FONTS.small,
    color: COLORS.text,
    flex: 1,
  },
  relatedTime: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    flexShrink: 0,
  },
  relatedEmpty: {
    ...FONTS.small,
    color: COLORS.textMuted,
    marginTop: SPACING.sm,
  },
});
