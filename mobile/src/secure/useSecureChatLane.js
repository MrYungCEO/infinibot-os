/**
 * useSecureChatLane — the chat's switch between the normal and secure lanes.
 *
 * ON  → turns Secure Mode on if it is off, remembers the current normal
 *       session, then opens the remembered secure session (or a fresh one:
 *       `secure.session.new`, falling back to a locally minted
 *       agent:<id>:secure-<base36 time>-<rand6> key).
 * OFF → remembers the secure session and returns to the remembered normal one
 *       (or a new normal chat).
 * Both keys persist in AsyncStorage so the lane survives restarts.
 */
import { useCallback, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { isSecureSessionKey, newSecureSessionKey, secureErrorText } from './secure-logic';

export const SECURE_LAST_KEY = '@infinibot/secure_chat_last_secure_key';
export const NORMAL_LAST_KEY = '@infinibot/secure_chat_last_normal_key';

async function read(k) {
  try { return (await AsyncStorage.getItem(k)) || null; } catch { return null; }
}
function write(k, v) {
  if (v) AsyncStorage.setItem(k, v).catch(() => {});
  else AsyncStorage.removeItem(k).catch(() => {});
}

export async function mintSecureSessionKey(sendReq, agentId) {
  try {
    const res = await sendReq?.('secure.session.new', { agentId: agentId || 'main' });
    if (res?.sessionKey && isSecureSessionKey(res.sessionKey)) return res.sessionKey;
  } catch {
    /* older gateway / locked: mint locally (same shape as the gateway) */
  }
  return newSecureSessionKey(agentId || 'main');
}

export function useSecureChatLane({ chat, secure, sendReq }) {
  const [switching, setSwitching] = useState(false);
  const [laneError, setLaneError] = useState(null);
  const activeKey = chat?.activeKey ?? null;
  const inSecure = isSecureSessionKey(activeKey);

  const enterSecure = useCallback(async () => {
    setLaneError(null);
    setSwitching(true);
    try {
      if (!secure.enabled) {
        const ok = await secure.setEnabled(true);
        if (!ok) return false;
      }
      if (!isSecureSessionKey(chat.activeKey)) write(NORMAL_LAST_KEY, chat.activeKey);
      let key = await read(SECURE_LAST_KEY);
      if (!isSecureSessionKey(key)) {
        key = await mintSecureSessionKey(sendReq, chat.currentAgentId);
        write(SECURE_LAST_KEY, key);
      }
      chat.openSession(key);
      return true;
    } catch (err) {
      setLaneError(secureErrorText(err));
      return false;
    } finally {
      setSwitching(false);
    }
  }, [chat, secure, sendReq]);

  const leaveSecure = useCallback(async () => {
    setLaneError(null);
    if (isSecureSessionKey(chat.activeKey)) write(SECURE_LAST_KEY, chat.activeKey);
    const prev = await read(NORMAL_LAST_KEY);
    if (prev && !isSecureSessionKey(prev)) chat.openSession(prev);
    else chat.newChat();
    return true;
  }, [chat]);

  /** "New chat" while in the secure lane: a fresh secure session. */
  const newSecureChat = useCallback(async () => {
    const key = await mintSecureSessionKey(sendReq, chat.currentAgentId);
    write(SECURE_LAST_KEY, key);
    chat.openSession(key);
  }, [chat, sendReq]);

  const setLane = useCallback((on) => (on ? enterSecure() : leaveSecure()), [enterSecure, leaveSecure]);

  return { inSecure, switching, laneError: laneError || secure.error, clearError: () => { setLaneError(null); secure.clearError(); }, setLane, newSecureChat };
}
