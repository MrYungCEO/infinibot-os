import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform, Linking } from 'react-native';
import { getGatewayUrl, getGatewayAuthHeaders } from '../utils/storage';

function wsUrlToHttp(wsUrl: string): string {
  return wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
}

/**
 * Request push permission, obtain the Expo push token, register it with the
 * gateway REST endpoint, and set up the foreground notification handler.
 *
 * Returns the token on success, null if running on a simulator or if the user
 * denied permission.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  // Foreground: show banner + play sound + update badge
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });

  if (!Device.isDevice) {
    return null;
  }

  // Expo Go has no remote push (Android throws since SDK 55); push needs a
  // development build.
  if (Constants.executionEnvironment === 'storeClient') {
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return null;
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  let token: string;
  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    token = tokenData.data;
  } catch (err) {
    console.warn('[push] failed to get Expo push token:', err);
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('agent-messages', {
      name: 'Agent Messages',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FFD700',
      sound: 'default',
    });
  }

  // Register token with the gateway REST endpoint
  try {
    const wsUrl = await getGatewayUrl();
    const baseUrl = wsUrlToHttp(wsUrl);
    const res = await fetch(`${baseUrl}/api/push-tokens/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getGatewayAuthHeaders()) },
      body: JSON.stringify({
        token,
        platform: Platform.OS,
        deviceLabel: Device.deviceName ?? 'Unknown Device',
      }),
    });
    if (!res.ok) {
      console.warn('[push] token registration failed, status:', res.status);
    }
  } catch (err) {
    // Gateway may be unreachable at boot; not fatal — token is already in
    // AsyncStorage via useNotifications and will re-register via WS on connect.
    console.warn('[push] token registration error (will retry via WS):', err);
  }

  return token;
}

/**
 * Returns whether push notification permission has been denied.
 * Use this to decide whether to show the "permission denied" affordance.
 */
export async function isPushPermissionDenied(): Promise<boolean> {
  const { status } = await Notifications.getPermissionsAsync();
  return status === 'denied';
}

/**
 * Open the system notification settings for this app.
 */
export function openSystemNotificationSettings(): Promise<void> {
  return Linking.openSettings();
}

/**
 * Wire up the background/killed-state tap handler.
 * Call once after navigation is ready. Returns a cleanup function.
 *
 * `handler` receives { runId, sessionKey } from the notification data so the
 * caller can navigate to the relevant screen.
 */
export function addNotificationTapHandler(
  handler: (payload: { runId?: string; sessionKey?: string; kind?: string }) => void,
): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
    handler({
      runId: data.runId as string | undefined,
      sessionKey: data.sessionKey as string | undefined,
      kind: data.kind as string | undefined,
    });
  });
  return () => sub.remove();
}
