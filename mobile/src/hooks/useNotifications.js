import { useState, useEffect, useRef, useCallback } from 'react';
import { Platform, AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS } from '../constants/theme';
import { pickDisplayTitle, titleLooksRaw } from '../utils/subagent-label';

// ── Suppression helpers ────────────────────────────────────────────────────────

// Kinds that should never produce any notification (voice state lives on the call page)
const SUPPRESS_ALWAYS = new Set(['voice_state']);

// Kinds that are silenced when the app is in the foreground
const SUPPRESS_WHEN_FOREGROUND = new Set(['chat_reply']);

// Map notify() kind → Android channel id
const KIND_TO_CHANNEL = {
  task_complete:    'task-updates',
  agent_complete:   'agent-messages',
  agent_critical:   'agent-critical',
  chat_reply:       'agent-messages',
  system:           'system',
  discipline:       'discipline',
  default:          'default',
};

// Map notify() kind → Android notification importance for OS delivery
function channelForKind(kind) {
  return KIND_TO_CHANNEL[kind] || KIND_TO_CHANNEL.default;
}

// Configure notification handling — suppress foreground OS alerts for chat_reply.
// Task/agent completions still alert even in foreground (they fall through here
// only if explicitly scheduled; gateway push stays unaffected).
Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const kind = n?.request?.content?.data?.kind;
    const isChatReply = kind === 'chat_reply' || n?.request?.content?.data?.type === 'chat';
    const isForeground = AppState.currentState === 'active';
    if (isChatReply && isForeground) {
      return {
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      };
    }
    return {
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    };
  },
});

const PUSH_TOKEN_KEY = '@infinibot/pushToken';
const NOTIFICATION_CACHE_KEY = '@infinibot/notificationCache';
const NOTIFICATION_SETTINGS_KEY = '@infinibot/notificationSettings';

const ANDROID_CHANNELS = [
  {
    id: 'default',
    name: 'Default',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: COLORS.primary,
    sound: 'default',
  },
  {
    id: 'agent-messages',
    name: 'Agent Messages',
    description: 'Messages from AI agents',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: COLORS.primary,
    sound: 'default',
  },
  {
    id: 'task-updates',
    name: 'Task Updates',
    description: 'Kanban task and project updates',
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: '#3B82F6',
  },
  {
    id: 'system',
    name: 'System Alerts',
    description: 'Gateway and system notifications',
    importance: Notifications.AndroidImportance.HIGH,
    lightColor: '#EF4444',
  },
  {
    id: 'voice',
    name: 'Voice Calls',
    description: 'Incoming and missed voice calls',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
  },
  {
    id: 'business',
    name: 'Business',
    description: 'Business and income notifications',
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: '#22c55e',
  },
  {
    id: 'federation',
    name: 'Federation',
    description: 'Federated node status changes',
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: '#a855f7',
  },
  {
    id: 'discipline',
    name: 'Discipline Alerts',
    description: 'Routine blocks, streaks, and daily check-ins',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#8B5CF6',
    sound: 'default',
  },
  {
    id: 'agent-critical',
    name: 'Critical Agent Alerts',
    description: 'High-priority agent errors and required input',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 500, 250, 500],
    lightColor: '#EF4444',
    sound: 'default',
    bypassDnd: true,
  },
];

const MAX_CACHE = 200;

export function useNotifications({ sendToGateway, subscribeEvent, onNotificationReceived, onNotificationTapped, onInAppNotify }) {
  const [expoPushToken, setExpoPushToken] = useState(null);
  const [notification, setNotification] = useState(null);
  const [history, setHistory] = useState([]); // backwards-compat ring buffer
  const [notifications, setNotifications] = useState([]); // gateway-backed list
  const [unreadCount, setUnreadCount] = useState(0);
  const [preferences, setPreferencesState] = useState(null);
  const [settings, setSettings] = useState({
    enabled: true,
    agentMessages: true,
    taskUpdates: true,
    systemAlerts: true,
    sound: true,
    vibration: true,
  });
  const [permissionStatus, setPermissionStatus] = useState(null);
  const [filters, setFiltersState] = useState({});

  const notificationListener = useRef();
  const responseListener = useRef();
  const appState = useRef(AppState.currentState);
  const isMounted = useRef(true);
  const cursorRef = useRef(null);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // Load settings
  useEffect(() => {
    loadSettings();
    loadCachedNotifications();
  }, []);

  const loadSettings = async () => {
    try {
      const saved = await AsyncStorage.getItem(NOTIFICATION_SETTINGS_KEY);
      if (saved && isMounted.current) setSettings(JSON.parse(saved));
    } catch {}
  };

  const saveSettings = async (newSettings) => {
    try {
      await AsyncStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(newSettings));
      if (isMounted.current) setSettings(newSettings);
    } catch {}
  };

  const loadCachedNotifications = async () => {
    try {
      const cached = await AsyncStorage.getItem(NOTIFICATION_CACHE_KEY);
      if (cached && isMounted.current) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          setNotifications(parsed);
          setHistory(parsed.slice(0, 100)); // back-compat
        }
      }
    } catch {}
  };

  const persistCache = async (items) => {
    try {
      await AsyncStorage.setItem(NOTIFICATION_CACHE_KEY, JSON.stringify(items.slice(0, MAX_CACHE)));
    } catch {}
  };

  // Register for push notifications
  const registerForPushNotifications = useCallback(async () => {
    if (!Device.isDevice) return null;
    // Expo Go has no remote push (Android throws since SDK 55). Local
    // notifications and the in-app center still work; push needs a dev build.
    if (Constants.executionEnvironment === 'storeClient') return null;
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;
      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (isMounted.current) setPermissionStatus(finalStatus);
      if (finalStatus !== 'granted') return null;

      const projectId = Constants.expoConfig?.extra?.eas?.projectId;
      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
      const token = tokenData.data;
      await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
      if (isMounted.current) setExpoPushToken(token);

      if (Platform.OS === 'android') {
        for (const ch of ANDROID_CHANNELS) {
          await Notifications.setNotificationChannelAsync(ch.id, ch);
        }
      }
      return token;
    } catch (error) {
      console.error('Error registering for push notifications:', error);
      return null;
    }
  }, []);

  // Register token with gateway
  const registerTokenWithGateway = useCallback(async (token, retryCount = 0) => {
    if (!token || !sendToGateway) return;
    try {
      await sendToGateway('device.registerPush', {
        token,
        platform: Platform.OS,
        deviceName: Device.deviceName || 'Unknown Device',
        settings,
      });
    } catch (error) {
      if (error.message === 'Not connected' && retryCount < 5) {
        setTimeout(() => registerTokenWithGateway(token, retryCount + 1), (retryCount + 1) * 2000);
      }
    }
  }, [sendToGateway, settings]);

  // Load initial notifications from gateway.
  // Uses '_default_' token when no Expo push token is available so history
  // loads in simulators and when push permission is denied.
  const loadFromGateway = useCallback(async (reset = true) => {
    if (!sendToGateway) return;
    try {
      const token = expoPushToken || '_default_';
      const res = await sendToGateway('notifications.history.list', {
        limit: 50,
        cursor: reset ? undefined : cursorRef.current,
        filters: { token, ...filters },
      });
      if (!isMounted.current) return;
      const newItems = res?.items || [];
      // Use functional setState to avoid capturing stale `notifications` in deps
      if (reset) {
        setNotifications(newItems);
        setHistory(newItems.slice(0, 100));
        persistCache(newItems);
      } else {
        setNotifications((prev) => {
          const merged = [...prev, ...newItems].slice(0, MAX_CACHE);
          persistCache(merged);
          return merged;
        });
        setHistory((prev) => [...prev, ...newItems].slice(0, 100));
      }
      cursorRef.current = res?.nextCursor || null;

      // Update unread count
      const unreadRes = await sendToGateway('notifications.history.unreadCount', { token });
      if (isMounted.current) setUnreadCount(unreadRes?.count || 0);
    } catch {}
  }, [sendToGateway, expoPushToken, filters]); // `notifications` removed from deps

  const loadMore = useCallback(() => {
    if (cursorRef.current) loadFromGateway(false);
  }, [loadFromGateway]);

  const refresh = useCallback(() => loadFromGateway(true), [loadFromGateway]);

  // Mark read
  const markRead = useCallback(async (ids) => {
    if (!sendToGateway) return;
    const token = expoPushToken || '_default_';
    try {
      await sendToGateway('notifications.history.markRead', { ids, token });
      const idsSet = new Set(ids);
      setNotifications((prev) =>
        prev.map((n) => idsSet.has(n.id) ? { ...n, readByToken: [...(n.readByToken || []), token] } : n)
      );
      setUnreadCount((c) => Math.max(0, c - ids.length));
    } catch {}
  }, [sendToGateway, expoPushToken]);

  const markUnread = useCallback(async (ids) => {
    if (!sendToGateway) return;
    const token = expoPushToken || '_default_';
    try {
      await sendToGateway('notifications.history.markUnread', { ids, token });
      const idsSet = new Set(ids);
      setNotifications((prev) =>
        prev.map((n) => idsSet.has(n.id) ? { ...n, readByToken: (n.readByToken || []).filter((t) => t !== token) } : n)
      );
      setUnreadCount((c) => c + ids.length);
    } catch {}
  }, [sendToGateway, expoPushToken]);

  const dismiss = useCallback(async (ids) => {
    if (!sendToGateway) return;
    const token = expoPushToken || '_default_';
    try {
      await sendToGateway('notifications.history.dismiss', { ids, token });
      const idsSet = new Set(ids);
      setNotifications((prev) => prev.filter((n) => !idsSet.has(n.id)));
    } catch {}
  }, [sendToGateway, expoPushToken]);

  const ack = useCallback(async (ids) => {
    if (!sendToGateway) return;
    const token = expoPushToken || '_default_';
    try {
      await sendToGateway('notifications.history.ack', { ids, token });
      const idsSet = new Set(ids);
      setNotifications((prev) =>
        prev.map((n) => idsSet.has(n.id) ? { ...n, ackByToken: [...(n.ackByToken || []), token] } : n)
      );
    } catch {}
  }, [sendToGateway, expoPushToken]);

  const setFilters = useCallback((f) => setFiltersState(f), []);

  // Preferences
  const loadPreferences = useCallback(async () => {
    if (!sendToGateway) return;
    try {
      const prefs = await sendToGateway('notifications.preferences.get', {});
      if (isMounted.current && prefs) setPreferencesState(prefs);
    } catch {}
  }, [sendToGateway]);

  const updatePreferences = useCallback(async (prefs) => {
    if (!sendToGateway) return;
    try {
      await sendToGateway('notifications.preferences.set', { prefs });
      if (isMounted.current) setPreferencesState(prefs);
    } catch {}
  }, [sendToGateway]);

  // Initialize notifications on mount
  useEffect(() => {
    if (!settings.enabled) return;
    registerForPushNotifications().then((token) => {
      if (token) registerTokenWithGateway(token);
    });

    notificationListener.current = Notifications.addNotificationReceivedListener((n) => {
      setNotification(n);
      try {
        const content = n?.request?.content || {};
        // Defense-in-depth: humanize sub-agent titles client-side if the
        // server didn't already (older gateway, or a path that bypasses
        // mobile-push.ts). When the server fixed it, pickDisplayTitle just
        // returns the existing humanized title verbatim.
        const humanizedTitle = pickDisplayTitle({
          title: content.title,
          displayTitle: content.data?.displayTitle,
          data: content.data,
        });
        const entry = {
          id: n?.request?.identifier || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: humanizedTitle || content.title || '',
          body: content.body || '',
          data: content.data || {},
          ts: Date.now(),
          category: content.data?.category || 'manual',
          severity: content.data?.severity || 'info',
          source: content.data?.source || 'push',
          readByToken: [],
          dismissedByToken: [],
          ackByToken: [],
        };
        setHistory((prev) => [entry, ...prev].slice(0, 100));
        setNotifications((prev) => {
          const updated = [entry, ...prev.filter((p) => p.id !== entry.id)].slice(0, MAX_CACHE);
          persistCache(updated);
          return updated;
        });
        setUnreadCount((c) => c + 1);
      } catch {}
      onNotificationReceived?.(n);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      onNotificationTapped?.(data, response);
    });

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        registerForPushNotifications();
        loadFromGateway(true);
      }
      appState.current = nextAppState;
    });

    return () => {
      notificationListener.current?.remove();
      responseListener.current?.remove();
      subscription.remove();
    };
  }, [settings.enabled]);

  // Load from gateway as soon as connected — no push token required.
  // Uses '_default_' token when expoPushToken is absent.
  useEffect(() => {
    if (sendToGateway) {
      loadFromGateway(true);
      loadPreferences();
    }
  }, [sendToGateway]);

  // Re-load when push token becomes available (may upgrade from _default_ reads)
  useEffect(() => {
    if (expoPushToken && sendToGateway) {
      loadFromGateway(true);
      registerTokenWithGateway(expoPushToken);
    }
  }, [expoPushToken]);

  // Re-load when filters change
  useEffect(() => {
    if (sendToGateway) loadFromGateway(true);
  }, [filters]);

  // Subscribe to live `notification.created` gateway events so state updates
  // in real time without depending on Expo push delivery.
  useEffect(() => {
    if (!subscribeEvent) return;
    const unsub = subscribeEvent('notification.created', (payload) => {
      if (!isMounted.current) return;
      // Same defense-in-depth as the Expo push listener: humanize sub-agent
      // titles client-side when the server didn't, so cached entries created
      // before the server fix shipped don't keep showing raw runIds.
      const humanizedTitle = titleLooksRaw(payload?.title)
        ? pickDisplayTitle(payload)
        : (payload?.displayTitle || payload?.title || '');
      const entry = {
        ...payload,
        title: humanizedTitle || payload?.title || '',
        readByToken: [],
        dismissedByToken: [],
        ackByToken: [],
      };
      setNotifications((prev) => {
        const updated = [entry, ...prev.filter((p) => p.id !== entry.id)].slice(0, MAX_CACHE);
        persistCache(updated);
        return updated;
      });
      setHistory((prev) => [entry, ...prev].slice(0, 100));
      setUnreadCount((c) => c + 1);
    });
    return unsub;
  }, [subscribeEvent]);

  // Re-register when settings change
  useEffect(() => {
    if (expoPushToken && sendToGateway) registerTokenWithGateway(expoPushToken);
  }, [settings]);

  // Update badge count when unread changes
  useEffect(() => {
    Notifications.setBadgeCountAsync(unreadCount).catch(() => {});
  }, [unreadCount]);

  // Helpers (legacy)
  const scheduleLocalNotification = useCallback(async ({ title, body, data, channelId = 'default', seconds = 1 }) => {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data,
        sound: settings.sound ? 'default' : null,
        ...(Platform.OS === 'android' && { channelId }),
      },
      trigger: { seconds },
    });
  }, [settings.sound]);

  const clearAllNotifications = useCallback(async () => {
    await Notifications.dismissAllNotificationsAsync();
    await Notifications.setBadgeCountAsync(0);
  }, []);

  const getBadgeCount = useCallback(async () => Notifications.getBadgeCountAsync(), []);
  const setBadgeCount = useCallback(async (count) => Notifications.setBadgeCountAsync(count), []);
  const clearHistory = useCallback(() => { setHistory([]); setNotifications([]); }, []);

  // ── notify() — the single programmatic notification API ─────────────────────
  //
  // Usage: notify({ kind, title, body, agent?, severity? })
  //
  //   kind         one of: task_complete | agent_complete | chat_reply |
  //                        voice_state | system | discipline | manual
  //   title        short plain-English label shown to the user
  //   body         (optional) detail line
  //   agent        (optional) agent name / avatar label
  //   severity     (optional) info | success | warn | error | critical
  //
  // Routing logic:
  //   voice_state            → suppressed entirely (the call page shows it)
  //   chat_reply (foreground) → suppressed (user is already reading)
  //   chat_reply (background) → OS notification only
  //   task_complete /
  //   agent_complete (foreground) → in-app glass banner via onInAppNotify
  //   task_complete /
  //   agent_complete (background) → OS notification
  //   system / others        → in-app when foreground, OS when background
  const notify = useCallback(({ kind = 'system', title, body = '', agent, severity = 'info' } = {}) => {
    if (!title) return;

    // Suppress voice state entirely
    if (SUPPRESS_ALWAYS.has(kind)) return;

    const isForeground = AppState.currentState === 'active';

    // Suppress chat_reply when user is looking at the screen
    if (SUPPRESS_WHEN_FOREGROUND.has(kind) && isForeground) return;

    if (isForeground) {
      // Show in-app glass banner
      onInAppNotify?.({
        kind,
        title,
        body,
        agent,
        severity,
        category: kind,
        ts: Date.now(),
      });
    } else {
      // Fire OS notification — always include the kind so the
      // setNotificationHandler can make suppress decisions too.
      Notifications.scheduleNotificationAsync({
        content: {
          title,
          body: body?.slice(0, 200) + (body?.length > 200 ? '…' : ''),
          data: { kind, agent, severity },
          sound: settings.sound ? 'default' : null,
          ...(Platform.OS === 'android' && { channelId: channelForKind(kind) }),
        },
        trigger: null,
      }).catch(() => {});
    }
  }, [settings.sound, onInAppNotify]);

  return {
    // State
    expoPushToken,
    notification,
    settings,
    permissionStatus,
    history,           // legacy: in-memory ring buffer (100 items)
    notifications,     // full gateway-backed list
    unreadCount,
    preferences,

    // Actions
    registerForPushNotifications,
    saveSettings,
    notify,
    scheduleLocalNotification,
    clearAllNotifications,
    getBadgeCount,
    setBadgeCount,
    clearHistory,

    // Gateway-backed actions
    markRead,
    markUnread,
    dismiss,
    ack,
    loadMore,
    refresh,
    setFilters,
    updatePreferences,
  };
}

export default useNotifications;
