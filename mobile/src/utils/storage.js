import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_GATEWAY_URL } from '../constants/gateway';

const KEYS = {
  GATEWAY_URL: '@moltbot/gateway_url',
  AUTH_TOKEN: '@moltbot/auth_token',
  DEVICE_TOKEN: '@moltbot/device_token',
  DEVICE_ID: '@moltbot/device_id',  // Unique device identifier for session isolation
  CHAT_SESSIONS: '@moltbot/chat_sessions',
  ACTIVE_CHAT: '@moltbot/active_chat',
  SCROLL_POSITIONS: '@moltbot/scroll_positions',
  NOTION_API_KEY: '@moltbot/notion_api_key',
  DASHBOARD_PRESET: '@moltbot/dashboard_preset',
  DASHBOARD_REC_SNOOZE: '@moltbot/dashboard_rec_snooze',
  DASHBOARD_REC_DISMISS: '@moltbot/dashboard_rec_dismiss',
  MIRROR_CAMERA_FROM_WEB: '@moltbot/mirror_camera_from_web',
};

export async function getGatewayUrl() {
  try {
    const url = await AsyncStorage.getItem(KEYS.GATEWAY_URL);
    return url || DEFAULT_GATEWAY_URL;
  } catch {
    return DEFAULT_GATEWAY_URL;
  }
}

export async function setGatewayUrl(url) {
  await AsyncStorage.setItem(KEYS.GATEWAY_URL, url);
}

export async function getAuthToken() {
  try {
    const stored = await AsyncStorage.getItem(KEYS.AUTH_TOKEN);
    return stored || null;
  } catch {
    return null;
  }
}

/**
 * Headers for the gateway's HTTP routes (/api/hardware/*,
 * /api/push-tokens/*, …). The gateway requires its credential on every HTTP
 * route; the stored auth token is the same shared secret the WebSocket uses.
 */
export async function getGatewayAuthHeaders() {
  // The active connection profile decides (InfiniBot Cloud → a FRESH Clerk
  // session token per call; self-hosted → the gateway secret). Installs from
  // before connection profiles fall back to the legacy stored secret.
  try {
    const { activeAuthHeaders } = require('../connection/profile-store');
    const h = await activeAuthHeaders();
    if (h) return h;
  } catch {
    /* profile store unavailable — legacy path below */
  }
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function setAuthToken(token) {
  if (token) {
    await AsyncStorage.setItem(KEYS.AUTH_TOKEN, token);
  } else {
    await AsyncStorage.removeItem(KEYS.AUTH_TOKEN);
  }
}

export async function getDeviceToken() {
  try {
    return await AsyncStorage.getItem(KEYS.DEVICE_TOKEN);
  } catch {
    return null;
  }
}

export async function setDeviceToken(token) {
  if (token) {
    await AsyncStorage.setItem(KEYS.DEVICE_TOKEN, token);
  } else {
    await AsyncStorage.removeItem(KEYS.DEVICE_TOKEN);
  }
}

// Clear cached device token to force re-authentication with password
export async function clearDeviceToken() {
  try {
    await AsyncStorage.removeItem(KEYS.DEVICE_TOKEN);
    console.log('Device token cleared');
  } catch (err) {
    console.error('Failed to clear device token:', err);
  }
}

// Clear all auth data and reset to defaults
export async function clearAuthData() {
  try {
    await AsyncStorage.removeItem(KEYS.DEVICE_TOKEN);
    await AsyncStorage.removeItem(KEYS.AUTH_TOKEN);
    console.log('Auth data cleared, will use default password');
  } catch (err) {
    console.error('Failed to clear auth data:', err);
  }
}

// ============ Notion API Key ============

export async function getNotionApiKey() {
  try {
    const stored = await AsyncStorage.getItem(KEYS.NOTION_API_KEY);
    return stored || null;
  } catch {
    return null;
  }
}

export async function setNotionApiKey(key) {
  if (key) {
    await AsyncStorage.setItem(KEYS.NOTION_API_KEY, key);
  } else {
    await AsyncStorage.removeItem(KEYS.NOTION_API_KEY);
  }
}

// ============ Dashboard preset (web parity) ============

// Mirrors the web dashboard's localStorage key `infinibot.dashboard.preset`.
// One of 'hyperfocus' | 'operator' | 'executive' | 'full'. Defaults to 'full'.
export async function getDashboardPreset() {
  try {
    const p = await AsyncStorage.getItem(KEYS.DASHBOARD_PRESET);
    return p || 'full';
  } catch {
    return 'full';
  }
}

export async function setDashboardPreset(preset) {
  try {
    await AsyncStorage.setItem(KEYS.DASHBOARD_PRESET, preset || 'full');
  } catch (err) {
    console.error('Failed to save dashboard preset:', err);
  }
}

// ── World map: mirror the camera from the web UI in real time (default ON) ──
export async function getMirrorCameraFromWeb() {
  try {
    const v = await AsyncStorage.getItem(KEYS.MIRROR_CAMERA_FROM_WEB);
    return v == null ? true : JSON.parse(v);
  } catch {
    return true;
  }
}

export async function setMirrorCameraFromWeb(enabled) {
  try {
    await AsyncStorage.setItem(KEYS.MIRROR_CAMERA_FROM_WEB, JSON.stringify(!!enabled));
  } catch (err) {
    console.error('Failed to save mirror-camera setting:', err);
  }
}

// ── AI Recommendation snooze map: { [recId]: epochMsUntil } ──
export async function getRecSnoozes() {
  try {
    const data = await AsyncStorage.getItem(KEYS.DASHBOARD_REC_SNOOZE);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

export async function setRecSnoozes(map) {
  try {
    await AsyncStorage.setItem(KEYS.DASHBOARD_REC_SNOOZE, JSON.stringify(map || {}));
  } catch (err) {
    console.error('Failed to save rec snoozes:', err);
  }
}

// ── AI Recommendation soft-dismiss set: [recId, ...] ──
export async function getRecDismissed() {
  try {
    const data = await AsyncStorage.getItem(KEYS.DASHBOARD_REC_DISMISS);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export async function setRecDismissed(ids) {
  try {
    await AsyncStorage.setItem(KEYS.DASHBOARD_REC_DISMISS, JSON.stringify(ids || []));
  } catch (err) {
    console.error('Failed to save dismissed recs:', err);
  }
}

// ============ Device ID (for session isolation) ============

/**
 * Generates a short unique device ID.
 * Format: 8 character alphanumeric string
 */
function generateDeviceId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Gets or creates a unique device ID for this device.
 * Used to create device-specific session keys.
 */
export async function getDeviceId() {
  try {
    let deviceId = await AsyncStorage.getItem(KEYS.DEVICE_ID);
    if (!deviceId) {
      deviceId = generateDeviceId();
      await AsyncStorage.setItem(KEYS.DEVICE_ID, deviceId);
      console.log('Generated new device ID:', deviceId);
    }
    return deviceId;
  } catch (err) {
    console.error('Failed to get/create device ID:', err);
    // Fallback to a random ID (won't persist but won't break the app)
    return generateDeviceId();
  }
}

/**
 * Gets the shared main session key.
 * Returns 'agent:main' to sync with web UI and other devices.
 * This enables seamless conversation pickup across all devices.
 */
export async function getDeviceSessionKey() {
  // Use the shared main session for cross-device sync
  return 'agent:main';
}

/**
 * Gets a device-specific session key (for isolated mobile chats if needed).
 * Format: agent:main:mobile-{deviceId}
 */
export async function getIsolatedSessionKey() {
  const deviceId = await getDeviceId();
  return `agent:main:mobile-${deviceId}`;
}

/**
 * Generates a new session key for a new chat thread.
 * Format: agent:main:mobile-{timestamp}
 */
export function generateSessionKey() {
  return `agent:main:mobile-${Date.now().toString(36)}`;
}

// ============ Chat Persistence ============

/**
 * Chat session structure:
 * {
 *   id: string,           // unique session id
 *   title: string,        // display title (first message or "New Chat")
 *   messages: Message[],  // array of messages
 *   createdAt: number,    // timestamp
 *   updatedAt: number,    // last activity timestamp
 *   sessionKey: string,   // gateway session key (e.g., 'webchat', 'webchat:abc123')
 * }
 */

export async function getChatSessions() {
  try {
    const data = await AsyncStorage.getItem(KEYS.CHAT_SESSIONS);
    return data ? JSON.parse(data) : [];
  } catch (err) {
    console.error('Failed to load chat sessions:', err);
    return [];
  }
}

export async function saveChatSessions(sessions) {
  try {
    await AsyncStorage.setItem(KEYS.CHAT_SESSIONS, JSON.stringify(sessions));
  } catch (err) {
    console.error('Failed to save chat sessions:', err);
  }
}

export async function getChatSession(sessionId) {
  const sessions = await getChatSessions();
  return sessions.find(s => s.id === sessionId) || null;
}

export async function saveChatSession(session) {
  const sessions = await getChatSessions();
  const idx = sessions.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ...session, updatedAt: Date.now() };
  } else {
    sessions.unshift({ ...session, createdAt: Date.now(), updatedAt: Date.now() });
  }
  // Keep only last 100 sessions
  const trimmed = sessions.slice(0, 100);
  await saveChatSessions(trimmed);
  return trimmed;
}

export async function deleteChatSession(sessionId) {
  const sessions = await getChatSessions();
  const filtered = sessions.filter(s => s.id !== sessionId);
  await saveChatSessions(filtered);
  return filtered;
}

export async function updateChatMessages(sessionId, messages) {
  const sessions = await getChatSessions();
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx >= 0) {
    sessions[idx].messages = messages;
    sessions[idx].updatedAt = Date.now();
    // Update title from first user message if still "New Chat"
    if (sessions[idx].title === 'New Chat' && messages.length > 0) {
      const firstUserMsg = messages.find(m => m.role === 'user');
      if (firstUserMsg?.text) {
        sessions[idx].title = firstUserMsg.text.slice(0, 50) + (firstUserMsg.text.length > 50 ? '...' : '');
      }
    }
    await saveChatSessions(sessions);
  }
  return sessions;
}

export async function getActiveChatId() {
  try {
    return await AsyncStorage.getItem(KEYS.ACTIVE_CHAT);
  } catch {
    return null;
  }
}

export async function setActiveChatId(chatId) {
  if (chatId) {
    await AsyncStorage.setItem(KEYS.ACTIVE_CHAT, chatId);
  } else {
    await AsyncStorage.removeItem(KEYS.ACTIVE_CHAT);
  }
}

export async function getScrollPosition(sessionId) {
  try {
    const data = await AsyncStorage.getItem(KEYS.SCROLL_POSITIONS);
    const positions = data ? JSON.parse(data) : {};
    return positions[sessionId] || 0;
  } catch {
    return 0;
  }
}

export async function saveScrollPosition(sessionId, offset) {
  try {
    const data = await AsyncStorage.getItem(KEYS.SCROLL_POSITIONS);
    const positions = data ? JSON.parse(data) : {};
    positions[sessionId] = offset;
    await AsyncStorage.setItem(KEYS.SCROLL_POSITIONS, JSON.stringify(positions));
  } catch (err) {
    console.error('Failed to save scroll position:', err);
  }
}

export function generateChatId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Rename a chat session's title
 */
export async function renameChatSession(sessionId, newTitle) {
  const sessions = await getChatSessions();
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx >= 0) {
    sessions[idx].title = newTitle;
    sessions[idx].updatedAt = Date.now();
    await saveChatSessions(sessions);
    return sessions[idx];
  }
  return null;
}
