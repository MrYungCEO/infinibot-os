/**
 * NotificationBanner — glass-morphism in-app toast overlay.
 *
 * Mounted once at the App root (above NavigationContainer). Subscribes to
 * gateway `notification.created` events and renders up to 3 stacked banners.
 *
 * Suppression rules (applied before showing anything):
 *   voice_state / voice.connecting / voice.connected /
 *   voice.reconnecting / voice.disconnected  →  never shown (the call page shows it)
 *   chat / chat_reply (when app is foreground)  →  suppressed; user is already reading
 *   task_complete / agent_complete / agent.completed  →  always shown
 *   everything else  →  shown when app is active
 *
 * Accepts an `extraItems` prop so the useNotifications hook can push
 * programmatic notifications (e.g. agent-complete fired via notify()) into
 * the same banner stack.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  AppState,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { withAlpha, glassGradient, innerTopHighlight } from '../theme/color-utils';
import { TERMINAL_COLORS } from '../constants/terminal-theme';
import { pickDisplayTitle, titleLooksRaw } from '../utils/subagent-label';
import { openDeepLink } from '../navigation/deep-link-dispatcher';

const MAX_STACK = 3;
const DEDUP_WINDOW_MS = 30_000;

// Categories that are always suppressed (voice state is shown on the call page)
const VOICE_STATE_CATEGORIES = new Set([
  'voice.connecting',
  'voice.connected',
  'voice.reconnecting',
  'voice.disconnected',
  'voice_state',
]);

// Categories suppressed when the app is in the foreground
const FOREGROUND_SUPPRESS_CATEGORIES = new Set([
  'chat',
  'chat_reply',
  'chat.typing',
  'chat.streaming',
]);

function shouldSuppressBanner(payload) {
  const cat = payload?.category || payload?.kind || '';
  // Always suppress voice state changes
  if (VOICE_STATE_CATEGORIES.has(cat)) return true;
  // Suppress chat replies while user is looking at the screen
  if (FOREGROUND_SUPPRESS_CATEGORIES.has(cat) && AppState.currentState === 'active') return true;
  return false;
}

function severityTintColor(severity, primaryColor) {
  switch (severity) {
    case 'critical':
    case 'error':  return TERMINAL_COLORS.danger;
    case 'warn':   return TERMINAL_COLORS.warning;
    case 'success': return TERMINAL_COLORS.ok;
    default:       return primaryColor;
  }
}

const CATEGORY_ICONS = {
  'agent.completed':        'flash',
  'agent_complete':         'flash',
  'task_complete':          'checkmark-circle',
  'agent.error':            'warning',
  'agent.input_required':   'hand-right',
  'terminal.exit':          'terminal',
  'cron.fired':             'time',
  'discipline.alert':       'medal',
  'kanban.task.assigned':   'list',
  'kanban.task.completed':  'checkmark-done',
  'kanban.task.due':        'alarm',
  'business.lead.new':      'person-add',
  'business.income.logged': 'cash',
  'federation.node.online': 'radio',
  'federation.node.offline':'radio-outline',
  'system.update.available':'cloud-download',
  'voice.call.incoming':    'call',
  'voice.call.missed':      'call-outline',
  'chat.mentions':          'chatbubble',
  'autonomy.checkpoint':    'shield-checkmark',
  'autonomy.budget.warning':'alert-circle',
  'autonomy.budget.hit':    'ban',
  'credits.threshold':      'card',
  'manual':                 'flask',
};

function autoDismissMs(severity) {
  if (severity === 'critical' || severity === 'error') return null; // sticky
  if (severity === 'warn') return 8_000;
  return 4_000; // info / success
}

let _idSeq = 0;
function nextId() { return `nb-${Date.now()}-${++_idSeq}`; }

// ── Single Banner Item (glass morphism) ───────────────────────────────────────

function BannerItem({ item, onDismiss, onTap, primaryColor }) {
  const slideAnim = useRef(new Animated.Value(-110)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);

  const sevColor = severityTintColor(item.severity, primaryColor);
  const icon = CATEGORY_ICONS[item.category] || CATEGORY_ICONS[item.kind] || 'notifications';
  const blurIntensity = Platform.OS === 'android' ? 45 : 55;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 90,
        friction: 13,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();

    const delay = autoDismissMs(item.severity);
    if (delay != null) {
      timerRef.current = setTimeout(dismiss, delay);
    }
    return () => clearTimeout(timerRef.current);
  }, []);

  const dismiss = useCallback(() => {
    clearTimeout(timerRef.current);
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: -110,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(() => onDismiss(item._bannerId));
  }, [item._bannerId, onDismiss]);

  return (
    <Animated.View
      style={[
        styles.shadow,
        {
          shadowColor: sevColor,
          transform: [{ translateY: slideAnim }],
          opacity: opacityAnim,
        },
      ]}
    >
      {/* Glass layers */}
      <View style={styles.clip}>
        <BlurView intensity={blurIntensity} tint="dark" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={glassGradient(sevColor, { top: 0.13, mid: 0.03, floor: 0.5 })}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={innerTopHighlight}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
        {/* Hairline border */}
        <View style={[StyleSheet.absoluteFill, styles.border, { borderColor: withAlpha(sevColor, 0.28) }]} />
        {/* Left severity edge */}
        <View style={[styles.sevEdge, { backgroundColor: sevColor }]} />
      </View>

      {/* Content */}
      <TouchableOpacity
        style={styles.content}
        activeOpacity={0.88}
        onPress={() => { clearTimeout(timerRef.current); onTap(item); dismiss(); }}
      >
        <View style={[styles.iconWrap, { backgroundColor: withAlpha(sevColor, 0.15) }]}>
          <Ionicons name={icon} size={17} color={sevColor} />
        </View>

        <View style={styles.textBlock}>
          {item.agent ? (
            <Text style={styles.agentLabel} numberOfLines={1}>{item.agent}</Text>
          ) : null}
          <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
          {!!item.body && (
            <Text style={styles.body} numberOfLines={2}>{item.body}</Text>
          )}
        </View>

        <TouchableOpacity
          hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
          onPress={dismiss}
        >
          <Ionicons name="close" size={15} color="rgba(255,255,255,0.35)" />
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function NotificationBanner({ gateway, navigationRef, extraItems = [], onExtraItemsConsumed }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [banners, setBanners] = useState([]);
  const dedupRef = useRef(new Map()); // dedupKey → timestamp

  const addBanner = useCallback((payload) => {
    if (shouldSuppressBanner(payload)) return;

    // Defense-in-depth: prefer the server-provided humanized `displayTitle`,
    // and only fall back to local humanization when the incoming `title`
    // still looks like a raw runId / sessionKey. New gateways already send a
    // humanized `title`, so this is a no-op for them.
    const friendlyTitle =
      payload?.displayTitle ||
      (titleLooksRaw(payload?.title) ? pickDisplayTitle(payload) : payload?.title) ||
      payload?.title ||
      '';

    const dedupKey = `${friendlyTitle}|${payload?.body || ''}`;
    const lastSent = dedupRef.current.get(dedupKey) || 0;
    if (Date.now() - lastSent < DEDUP_WINDOW_MS) return;
    dedupRef.current.set(dedupKey, Date.now());

    const item = { ...payload, title: friendlyTitle, _bannerId: nextId() };
    setBanners((prev) => [item, ...prev].slice(0, MAX_STACK));
  }, []);

  const removeBanner = useCallback((bannerId) => {
    setBanners((prev) => prev.filter((b) => b._bannerId !== bannerId));
  }, []);

  const handleTap = useCallback((item) => {
    const nav = navigationRef?.current;
    if (!nav) return;
    const deepLink = item.deepLink;
    if (!deepLink) { nav.navigate('NotificationsModal', {}); return; }
    // One routing table for every alert surface (src/navigation/deep-links.js).
    openDeepLink(deepLink);
  }, [navigationRef]);

  // Subscribe to gateway notification.created events
  useEffect(() => {
    if (!gateway?.subscribeEvent) return;
    const unsub = gateway.subscribeEvent('notification.created', addBanner);
    return unsub;
  }, [gateway, addBanner]);

  // Consume extra items pushed via the notify() API, then clear the queue
  useEffect(() => {
    if (!extraItems?.length) return;
    extraItems.forEach(addBanner);
    onExtraItemsConsumed?.();
  }, [extraItems]);

  if (banners.length === 0) return null;

  return (
    <View
      style={[styles.container, { top: insets.top + 8 }]}
      pointerEvents="box-none"
    >
      {banners.map((item) => (
        <BannerItem
          key={item._bannerId}
          item={item}
          onDismiss={removeBanner}
          onTap={handleTap}
          primaryColor={colors.primary}
        />
      ))}
    </View>
  );
}

export default NotificationBanner;

const RADIUS = 16;

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 9999,
    gap: 8,
    pointerEvents: 'box-none',
  },
  shadow: {
    borderRadius: RADIUS,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 14,
    position: 'relative',
  },
  clip: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: RADIUS,
    overflow: 'hidden',
  },
  border: {
    borderRadius: RADIUS,
    borderWidth: 1,
  },
  sevEdge: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    borderTopLeftRadius: RADIUS,
    borderBottomLeftRadius: RADIUS,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 12,
    gap: 10,
    minHeight: 58,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textBlock: {
    flex: 1,
    gap: 1,
  },
  agentLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.45)',
    marginBottom: 1,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: '#F5F5F5',
    lineHeight: 17,
  },
  body: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.52)',
    lineHeight: 15,
    marginTop: 1,
  },
});
