import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  PROTOCOL_VERSION,
  CLIENT_INFO,
  FRAME,
  METHOD,
  EVENT,
  CHAT_STATE,
} from '../constants/gateway';
import {
  isHeartbeatStale,
  HEARTBEAT_ACK_TIMEOUT_MS,
} from '../lib/gateway-liveness';
import {
  getGatewayUrl,
  getAuthToken,
  getDeviceToken,
  setDeviceToken,
  clearDeviceToken,
  clearAuthData,
  getDeviceSessionKey,
  generateSessionKey,
  getChatSessions,
  getChatSession,
  saveChatSession,
  updateChatMessages,
  getActiveChatId,
  setActiveChatId,
  generateChatId,
} from '../utils/storage';
import {
  getActiveProfile,
  activeConnectAuth,
  ensureCloudGatewayUrl,
} from '../connection/profile-store';
import { describeAuthFailure, classifyConnectFailure } from '../connection/connection-logic';
import {
  initialReconnectState,
  onConnectFailure,
  onSocketClosed,
  onConnected,
  canAutoReconnect,
} from '../connection/reconnect-policy';

let reqCounter = 0;
function nextId() {
  return `mob-${Date.now()}-${++reqCounter}`;
}

function idempotencyKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Show local notification when app is in background
async function showLocalNotification(title, body, data = {}) {
  // Only show if app is not in foreground
  if (AppState.currentState !== 'active') {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body: body?.slice(0, 150) + (body?.length > 150 ? '...' : ''),
          data: {
            ...data,
            type: data.type || 'chat',
            // Include session key for deep linking
            sessionKey: data.sessionKey || 'agent:main',
          },
          sound: 'default',
        },
        trigger: null, // Immediate
      });
    } catch (err) {
      console.log('Notification error:', err);
    }
  }
}

export function useGateway() {
  const [status, setStatus] = useState('disconnected'); // disconnected | connecting | connected | error
  // Why the last attempt failed (shown by the connection banner), null when fine.
  const [lastError, setLastError] = useState(null);
  // Set when the gateway REJECTED the credential (wrong password/token,
  // pairing required). Auto-reconnect is halted until the user acts —
  // { kind, authMode, reason, message, host }.
  const [authFailure, setAuthFailure] = useState(null);
  // true while a backoff timer is waiting to reconnect (network errors only).
  const [reconnectPending, setReconnectPending] = useState(false);
  const [messages, setMessages] = useState([]);
  // true while a switchSession/loadHistory RPC is in-flight (no messages yet for new session)
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeSessionKey, setActiveSessionKey] = useState(null); // Will be set on initialization
  const [sessionsList, setSessionsList] = useState([]);
  // Local chat persistence
  const [activeChatId, setActiveChatIdState] = useState(null);
  const [localChats, setLocalChats] = useState([]);
  const [isInitialized, setIsInitialized] = useState(false);
  
  const wsRef = useRef(null);
  const pendingRef = useRef({}); // id -> { resolve, reject }
  const streamBufRef = useRef({}); // runId -> accumulated text
  // Per-session message cache: Map<sessionKey, Message[]>
  // Populated on every successful history fetch so swipe-back is instant.
  const sessionMessageCacheRef = useRef(new Map());
  const currentRunIdRef = useRef(null);
  // Generic event subscribers: eventName -> Set<handler>. Lets screens (e.g.
  // TerminalsScreen) listen for non-chat events like 'terminal.output' /
  // 'terminal.exit' without bolting them into handleEvent below.
  const eventSubsRef = useRef(new Map());
  const reconnectTimerRef = useRef(null);
  const tickTimerRef = useRef(null);
  const activeSessionRef = useRef(null); // Will be set on initialization
  const activeChatRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  // Reconnect state machine (connection/reconnect-policy.js).
  const reconnectStateRef = useRef(initialReconnectState());
  // Delay chosen by a classified handshake failure, consumed by onclose.
  const pendingRetryDelayRef = useRef(null);
  // Timestamp of the last frame received from the gateway. Any inbound frame
  // (ping ack, event, response) counts as proof the socket is alive. The
  // heartbeat watchdog (in the tick timer) treats a socket silent past
  // HEARTBEAT_ACK_TIMEOUT_MS as dead and force-reconnects — parity with the
  // web client, so a voice call on a flaky network recovers instead of hanging.
  const lastFrameAtRef = useRef(0);
  // Effective heartbeat-staleness window, derived from the gateway-advertised
  // tick interval at handshake (see connect()). MUST be >= 2× the tick/ping
  // cadence or the watchdog force-reconnects on every quiet interval — which is
  // exactly what made voice CALLS (long quiet listening/thinking periods, only
  // the 30s tick as traffic) drop in and out while CHAT (constant stream frames)
  // stayed alive. Seeded to the conservative fallback until the policy arrives.
  const heartbeatTimeoutRef = useRef(HEARTBEAT_ACK_TIMEOUT_MS);
  const isConnectingRef = useRef(false);
  const handshakeCompleteRef = useRef(false); // Track if connect handshake is done
  const persistTimerRef = useRef(null);
  const isSwitchingChatRef = useRef(false); // Prevent persist during chat switch

  // Keep refs in sync with state for use in event handlers
  useEffect(() => {
    activeSessionRef.current = activeSessionKey;
  }, [activeSessionKey]);

  useEffect(() => {
    activeChatRef.current = activeChatId;
  }, [activeChatId]);

  // Initialize local chat persistence
  useEffect(() => {
    initializePersistence();
  }, []);

  const initializePersistence = async () => {
    try {
      // NOTE: this used to call clearAuthData() here, wiping the saved gateway
      // secret on EVERY launch (a leftover from a hardcoded default password).
      // Behind the gateway's HTTP auth gate that left every HTTP call and the
      // WS handshake unauthenticated. Credentials now live in the connection
      // profile (src/connection/profile-store.js) and persist.

      // Use shared main session for cross-device sync
      const sharedSessionKey = await getDeviceSessionKey(); // Returns 'agent:main'
      setActiveSessionKey(sharedSessionKey);
      activeSessionRef.current = sharedSessionKey;
      console.log('Using shared session key:', sharedSessionKey);
      
      const chats = await getChatSessions();
      setLocalChats(chats);
      
      let activeId = await getActiveChatId();
      
      // Find or create the main shared chat
      const mainChat = chats.find(c => c.sessionKey === sharedSessionKey || c.sessionKey === 'agent:main');
      
      if (mainChat) {
        // Use existing main chat
        activeId = mainChat.id;
        console.log('Found existing main chat:', activeId);
      } else if (!activeId || !chats.find(c => c.id === activeId)) {
        // Create main shared chat
        const newId = generateChatId();
        const newChat = {
          id: newId,
          title: 'Main Chat',
          messages: [],
          sessionKey: sharedSessionKey, // Shared session key for sync
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await saveChatSession(newChat);
        setLocalChats([newChat, ...chats]);
        activeId = newId;
        console.log('Created new main chat:', activeId);
      }
      
      await setActiveChatId(activeId);
      setActiveChatIdState(activeId);
      activeChatRef.current = activeId;
      
      // Load messages from local cache initially (gateway sync happens on connect)
      const activeChat = chats.find(c => c.id === activeId);
      if (activeChat?.messages?.length > 0) {
        setMessages(activeChat.messages);
        // Pre-populate session cache from local storage so first swipe is instant
        sessionMessageCacheRef.current.set(sharedSessionKey, activeChat.messages);
        console.log('Loaded', activeChat.messages.length, 'messages from local cache');
      }
      
      setIsInitialized(true);
    } catch (err) {
      console.error('Failed to initialize persistence:', err);
      setIsInitialized(true);
    }
  };

  // Persist messages when they change (debounced)
  useEffect(() => {
    // Don't persist during initialization, chat switch, or if no active chat
    if (!isInitialized || !activeChatRef.current || isSwitchingChatRef.current) return;
    
    // Don't persist empty messages (likely during transition)
    if (messages.length === 0) return;
    
    // Clear any pending persist
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }
    
    // Capture the current chat ID at this moment
    const chatIdToSave = activeChatRef.current;
    
    // Debounce persistence to avoid excessive writes
    persistTimerRef.current = setTimeout(async () => {
      // Double-check we're still on the same chat
      if (chatIdToSave !== activeChatRef.current || isSwitchingChatRef.current) {
        console.log('Skipping persist - chat changed during debounce');
        return;
      }
      try {
        const updatedChats = await updateChatMessages(chatIdToSave, messages);
        setLocalChats(updatedChats);
      } catch (err) {
        console.error('Failed to persist messages:', err);
      }
    }, 500);
    
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
      }
    };
  }, [messages, isInitialized]);

  // Send a raw request and return the response
  const sendReq = useCallback((method, params) => {
    return new Promise((resolve, reject) => {
      const ws = wsRef.current;
      // Only allow 'connect' before handshake, all other methods require handshake complete
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }
      if (method !== 'connect' && !handshakeCompleteRef.current) {
        return reject(new Error('Not connected'));
      }
      const id = nextId();
      pendingRef.current[id] = { resolve, reject };
      const frame = { type: FRAME.REQ, id, method, params };
      ws.send(JSON.stringify(frame));

      // Timeout after 30s
      setTimeout(() => {
        if (pendingRef.current[id]) {
          delete pendingRef.current[id];
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }, []);

  // Handle incoming frames
  const handleFrame = useCallback((frame) => {
    // Any frame from the gateway is proof the socket is alive — feed the
    // heartbeat watchdog before dispatching.
    lastFrameAtRef.current = Date.now();
    if (frame.type === FRAME.RES) {
      const pending = pendingRef.current[frame.id];
      if (pending) {
        delete pendingRef.current[frame.id];
        if (frame.ok) {
          pending.resolve(frame.payload);
        } else {
          const err = new Error(frame.error?.message || 'Request failed');
          if (frame.error?.code) err.code = frame.error.code;
          if (frame.error?.details) err.details = frame.error.details;
          pending.reject(err);
        }
      }
    } else if (frame.type === FRAME.EVENT) {
      handleEvent(frame);
    }
  }, []);

  const handleEvent = useCallback((frame) => {
    const { event, payload } = frame;

    // Fan out to any screen-level subscribers first. We do this before the
    // built-in CHAT handling so generic listeners (terminal.output, etc.) get
    // notified even if a future change short-circuits chat handling.
    const subs = eventSubsRef.current.get(event);
    if (subs && subs.size > 0) {
      subs.forEach((handler) => {
        try { handler(payload, frame); }
        catch (err) { console.warn(`[gateway] event handler for ${event} threw:`, err?.message || err); }
      });
    }

    if (event === EVENT.CHAT && payload) {
      const { runId, state, message: msg, seq, sessionKey: eventSessionKey } = payload;

      // Only process chat events for the active session
      // Events may include a sessionKey — filter if present
      if (eventSessionKey && eventSessionKey !== activeSessionRef.current) {
        // Still update sessions list to show new activity
        return;
      }

      if (state === CHAT_STATE.DELTA) {
        currentRunIdRef.current = runId;
        setIsStreaming(true);

        // Extract text content from the message
        let text = '';
        if (typeof msg === 'string') {
          text = msg;
        } else if (msg && msg.content) {
          if (Array.isArray(msg.content)) {
            text = msg.content
              .filter(b => b.type === 'text')
              .map(b => b.text || '')
              .join('');
          } else if (typeof msg.content === 'string') {
            text = msg.content;
          }
        } else if (msg && typeof msg.text === 'string') {
          text = msg.text;
        }

        if (!streamBufRef.current[runId]) {
          streamBufRef.current[runId] = '';
        }
        streamBufRef.current[runId] = text;

        setMessages(prev => {
          const idx = prev.findIndex(m => m.runId === runId);
          const streamMsg = {
            id: `stream-${runId}`,
            runId,
            role: 'assistant',
            text: streamBufRef.current[runId],
            timestamp: Date.now(),
            streaming: true,
          };
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = streamMsg;
            return updated;
          }
          return [...prev, streamMsg];
        });

      } else if (state === CHAT_STATE.FINAL) {
        setIsStreaming(false);
        currentRunIdRef.current = null;

        let text = '';
        if (typeof msg === 'string') {
          text = msg;
        } else if (msg && msg.content) {
          if (Array.isArray(msg.content)) {
            text = msg.content
              .filter(b => b.type === 'text')
              .map(b => b.text || '')
              .join('');
          } else if (typeof msg.content === 'string') {
            text = msg.content;
          }
        } else if (msg && typeof msg.text === 'string') {
          text = msg.text;
        }

        if (!text && streamBufRef.current[runId]) {
          text = streamBufRef.current[runId];
        }
        delete streamBufRef.current[runId];

        // Skip empty responses, heartbeats, and NO_REPLY messages
        const trimmedText = (text || '').trim();
        const isSkippable = !trimmedText || 
          trimmedText === 'HEARTBEAT_OK' || 
          trimmedText === 'NO_REPLY' ||
          trimmedText.startsWith('HEARTBEAT_OK') ||
          trimmedText.length < 3; // Skip very short responses like "ok" from system

        if (isSkippable) {
          // Remove any streaming placeholder for this message
          setMessages(prev => prev.filter(m => m.runId !== runId));
          return;
        }

        setMessages(prev => {
          const idx = prev.findIndex(m => m.runId === runId);
          const finalMsg = {
            id: `msg-${runId}`,
            runId,
            role: 'assistant',
            text: text,
            timestamp: Date.now(),
            streaming: false,
          };
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = finalMsg;
            return updated;
          }
          return [...prev, finalMsg];
        });

        // Invalidate cache for this session so next visit gets fresh data
        const sk = activeSessionRef.current;
        if (sk) sessionMessageCacheRef.current.delete(sk);

        // OS notification when app is backgrounded (showLocalNotification is a no-op in foreground)
        showLocalNotification('New reply from InfiniBot', text, {
          type: 'chat',
          kind: 'chat_reply',
          runId,
          sessionKey: eventSessionKey || activeSessionRef.current,
        });

      } else if (state === CHAT_STATE.ERROR) {
        setIsStreaming(false);
        currentRunIdRef.current = null;
        delete streamBufRef.current[runId];

        setMessages(prev => {
          const idx = prev.findIndex(m => m.runId === runId);
          const errMsg = {
            id: `err-${runId}`,
            runId,
            role: 'system',
            text: `Error: ${payload.errorMessage || 'Unknown error'}`,
            timestamp: Date.now(),
            isError: true,
          };
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = errMsg;
            return updated;
          }
          return [...prev, errMsg];
        });

      } else if (state === CHAT_STATE.ABORTED) {
        setIsStreaming(false);
        currentRunIdRef.current = null;
        delete streamBufRef.current[runId];
      }
    }
  }, []);

  // Load sessions list (requires operator scope - may fail silently)
  const loadSessionsList = useCallback(async () => {
    try {
      // Always bounded: the store can hold thousands of sessions and derived
      // titles / last messages cost a transcript read each.
      const res = await sendReq(METHOD.SESSIONS_LIST, {
        includeGlobal: false,
        includeUnknown: false,
        includeDerivedTitles: true,
        includeLastMessage: true,
        limit: 100,
      });
      if (res && Array.isArray(res.sessions)) {
        setSessionsList(res.sessions);
      }
    } catch (err) {
      // Silently skip if we don't have the required scope
      if (err.message?.includes('scope')) {
        console.log('Sessions list: missing required scope, skipping');
      } else {
        console.log('Sessions list load skipped:', err.message);
      }
    }
  }, [sendReq]);

  // Connect to gateway
  const connect = useCallback(async () => {
    // Prevent multiple simultaneous connection attempts
    if (isConnectingRef.current) {
      console.log('Already connecting, skipping...');
      return;
    }

    // Clear any pending reconnect timer
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setReconnectPending(false);
    // An explicit connect() (Retry, a saved/switched connection, the backoff
    // timer) lifts an auth halt; the automatic paths check canAutoReconnect
    // before they call this.
    if (reconnectStateRef.current.halted) {
      reconnectStateRef.current = { ...reconnectStateRef.current, halted: null };
      setAuthFailure(null);
    }
    pendingRetryDelayRef.current = null;

    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.onclose = null; // Prevent onclose from firing
      wsRef.current.close();
      wsRef.current = null;
    }

    isConnectingRef.current = true;
    handshakeCompleteRef.current = false; // Reset handshake flag
    setStatus('connecting');

    try {
      // Cloud profiles resolve (and wake) the tenant gateway first; the
      // resolved URL is cached on the profile and mirrored into getGatewayUrl.
      const profile = await getActiveProfile();
      if (profile?.kind === 'cloud') {
        await ensureCloudGatewayUrl({ force: reconnectAttemptRef.current >= 3 });
      }
      const url = await getGatewayUrl();
      if (!url) {
        isConnectingRef.current = false;
        setLastError('No gateway address saved for this connection.');
        setStatus('error');
        return;
      }
      const authToken = await getAuthToken();
      const deviceToken = await getDeviceToken();

      console.log('Connecting to gateway:', url);
      const ws = new WebSocket(url);
      let usedDeviceToken = false;
      // A classified handshake failure: halt (auth/pairing) or pick the retry
      // delay that onclose will use. Runs synchronously before any await so a
      // close that races the rejected `connect` cannot schedule a retry.
      const handleConnectFailure = (err) => {
        const out = onConnectFailure(reconnectStateRef.current, err, { usedDeviceToken });
        reconnectStateRef.current = out.state;
        reconnectAttemptRef.current = out.state.attempt;
        isConnectingRef.current = false;
        handshakeCompleteRef.current = false;
        if (out.action === 'halt') {
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          setReconnectPending(false);
          const failure = { ...out.failure, host: url };
          setAuthFailure(failure);
          setLastError(describeAuthFailure(failure, profile || { gatewayUrl: url }));
          console.warn(`[gateway] ${out.failure.kind} failure — auto-reconnect halted: ${out.failure.message}`);
        } else {
          pendingRetryDelayRef.current = out.delayMs;
          setLastError(out.clearDeviceToken
            ? 'Saved device login expired — retrying with the connection password…'
            : `Connect handshake failed: ${out.failure.message}`);
        }
        setStatus('error');
        if (out.clearDeviceToken) clearDeviceToken().catch(() => {});
        try { ws.close(); } catch {}
      };
      wsRef.current = ws;

      ws.onopen = async () => {
        console.log('WebSocket opened, sending handshake...');
        
        // Wait for socket to be fully ready
        await new Promise(resolve => setTimeout(resolve, 300));
        
        if (ws.readyState !== WebSocket.OPEN) {
          console.log('WebSocket closed before handshake could complete');
          isConnectingRef.current = false;
          return;
        }
        
        try {
          const token = deviceToken || authToken;
          const connectParams = {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: CLIENT_INFO,
            caps: [],
            locale: 'en-US',
          };

          // The active profile builds the auth block (cloud: fresh Clerk JWT
          // as auth.token; self-hosted: token or password by the chosen mode).
          const profileAuth = await activeConnectAuth({ deviceToken });
          if (profileAuth) {
            connectParams.auth = profileAuth;
          } else if (token) {
            connectParams.auth = deviceToken
              ? { token: deviceToken }
              : { password: token };
          }
          usedDeviceToken = Boolean(deviceToken) && connectParams.auth?.token === deviceToken;

          const result = await sendReq(METHOD.CONNECT, connectParams);

          if (result?.type === 'hello-ok') {
            console.log('Handshake successful!');
            isConnectingRef.current = false;
            handshakeCompleteRef.current = true; // Mark handshake as complete
            setLastError(null);
            reconnectStateRef.current = onConnected();
            reconnectAttemptRef.current = 0; // Reset on success
            setAuthFailure(null);
            setStatus('connected');

            if (result.auth?.deviceToken) {
              await setDeviceToken(result.auth.deviceToken);
            }

            // Keepalive + heartbeat watchdog. Send a ping on the gateway's
            // tick cadence (same as the web client), then check whether the
            // socket has gone silent past the ack window. If no frame at all
            // has arrived for HEARTBEAT_ACK_TIMEOUT_MS, treat the connection
            // as dead and force-close so onclose schedules a reconnect — this
            // is what rescues a mid-call voice WS on a flaky network instead of
            // leaving it wedged "connected" with no traffic.
            const tickMs = result.policy?.tickIntervalMs || 15000;
            // Staleness window = >= 2× the tick cadence (+5s jitter margin),
            // matching the web client (client.ts: `gap > tickIntervalMs * 2`).
            // The gateway `tick` broadcast alone refreshes liveness every
            // tickMs, so the socket is only genuinely dead after ~2 missed
            // ticks. The old fixed 15s window was SMALLER than the 30s tick and
            // force-reconnected a quiet voice call roughly every interval — the
            // root cause of calls dropping in and out.
            const heartbeatTimeoutMs = Math.max(HEARTBEAT_ACK_TIMEOUT_MS, tickMs * 2 + 5000);
            heartbeatTimeoutRef.current = heartbeatTimeoutMs;
            // Seed liveness so the watchdog doesn't false-positive before the
            // first inbound frame after (re)connect.
            lastFrameAtRef.current = Date.now();
            if (tickTimerRef.current) clearInterval(tickTimerRef.current);
            tickTimerRef.current = setInterval(() => {
              if (ws.readyState !== WebSocket.OPEN) return;
              if (isHeartbeatStale(lastFrameAtRef.current, Date.now(), heartbeatTimeoutMs)) {
                console.log(
                  `[voice-call] heartbeat stale (>${Math.round(heartbeatTimeoutMs / 1000)}s silent) — force-reconnecting`,
                );
                try { ws.close(); } catch {}
                return; // onclose drives the reconnect
              }
              ws.send(JSON.stringify({
                type: FRAME.REQ,
                id: nextId(),
                method: 'ping',
                params: {},
              }));
            }, tickMs);

            // Load history for active session and sessions list (may fail if no admin scope)
            loadHistory();
            loadSessionsList();
          } else if (result?.type === 'hello-denied') {
            console.error('Gateway denied connection:', result.error || result);
            const denied = result?.error && typeof result.error === 'object' ? result.error : { message: String(result?.error || '') };
            handleConnectFailure({ ...denied, message: `unauthorized: ${denied.message || 'login refused'}` });
          } else {
            console.error('Handshake failed - unexpected response:', result);
            // Clear cached device token on any handshake failure
            await clearDeviceToken();
            isConnectingRef.current = false;
            setStatus('error');
          }
        } catch (err) {
          console.warn('Connect handshake failed:', err?.message || err);
          handleConnectFailure(err);
        }
      };

      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data);
          handleFrame(frame);
        } catch (err) {
          console.error('Failed to parse frame:', err);
        }
      };

      ws.onerror = (err) => {
        console.log('WebSocket error:', err?.message || 'unknown');
        if (reconnectStateRef.current.halted) return; // keep the auth message
        setLastError(`Can't reach the gateway at ${url}`);
        isConnectingRef.current = false;
        handshakeCompleteRef.current = false;
        setStatus('error');
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed, code:', event?.code, 'reason:', event?.reason);
        isConnectingRef.current = false;
        handshakeCompleteRef.current = false; // Reset handshake flag
        if (wsRef.current === ws) wsRef.current = null;
        
        if (tickTimerRef.current) {
          clearInterval(tickTimerRef.current);
          tickTimerRef.current = null;
        }

        // A 1008 close whose reason is an auth/pairing refusal (a gateway
        // that closed before we saw the `connect` response) halts too.
        if (!reconnectStateRef.current.halted && pendingRetryDelayRef.current == null && event?.code === 1008) {
          const f = classifyConnectFailure({ message: event.reason || '' });
          if (f.kind !== 'network') {
            reconnectStateRef.current = { ...reconnectStateRef.current, halted: f };
            setAuthFailure({ ...f, host: url });
            setLastError(describeAuthFailure(f, profile || { gatewayUrl: url }));
          }
        }

        // Wrong password / token or pairing required: retrying with the same
        // credential can never succeed — stay put until the user acts.
        if (!canAutoReconnect(reconnectStateRef.current)) {
          pendingRetryDelayRef.current = null;
          setReconnectPending(false);
          setStatus('error');
          return;
        }

        // Network errors: exponential backoff 1s, 2s, 4s, 8s, capped 10s —
        // matches the web client so a dropped call resumes within the same
        // wall-clock budget (AC#1) instead of the old slow 3s→30s ramp.
        let backoffMs = pendingRetryDelayRef.current;
        pendingRetryDelayRef.current = null;
        if (backoffMs == null) {
          const out = onSocketClosed(reconnectStateRef.current);
          reconnectStateRef.current = out.state;
          backoffMs = out.delayMs;
        }
        reconnectAttemptRef.current = reconnectStateRef.current.attempt;
        console.log(`[voice-call] reconnecting in ${Math.round(backoffMs / 1000)}s (attempt ${reconnectAttemptRef.current})`);

        // Mark the retry as scheduled BEFORE flipping status so the app-level
        // "connect when disconnected" effect does not bypass the backoff.
        setReconnectPending(true);
        setStatus('disconnected');
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (!canAutoReconnect(reconnectStateRef.current)) return;
          connect();
        }, backoffMs);
      };

    } catch (err) {
      console.error('Connection setup failed:', err);
      setLastError(`Connection setup failed: ${err?.message || err}`);
      isConnectingRef.current = false;
      setStatus('error');
    }
  }, [sendReq, handleFrame, loadSessionsList]);

  // Load chat history - ALWAYS sync from gateway for cross-device consistency
  const loadHistory = useCallback(async (forceGateway = false) => {
    const sessionKey = activeSessionRef.current;
    if (!sessionKey) {
      console.log('No active session key, skipping history load');
      return;
    }

    // Serve from per-session cache immediately so the UI is never blank
    // while the network round-trip completes. The cache is updated below.
    const cached = sessionMessageCacheRef.current.get(sessionKey);
    if (cached && cached.length > 0 && !forceGateway) {
      setMessages(cached);
      setMessagesLoading(false);
      return;
    }
    setMessagesLoading(true);

    // Always load from gateway for cross-device sync
    try {
      if (__DEV__) console.log('[session-history] loadHistory start', { sessionKey });
      const result = await sendReq(METHOD.CHAT_HISTORY, {
        sessionKey,
        limit: 200, // Increased limit for full conversation sync
      });

      if (result && Array.isArray(result.messages)) {
        const parsed = result.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map((m, i) => {
            let text = '';
            if (typeof m.content === 'string') {
              text = m.content;
            } else if (Array.isArray(m.content)) {
              text = m.content
                .filter(b => b.type === 'text')
                .map(b => b.text || '')
                .join('');
            }
            return {
              id: m.id || `hist-${i}-${Date.now()}`,
              role: m.role,
              text: text,
              timestamp: m.timestamp || Date.now(),
              streaming: false,
            };
          })
          // Filter out empty, HEARTBEAT_OK, and NO_REPLY messages
          .filter(m => {
            const trimmed = (m.text || '').trim();
            if (!trimmed || trimmed.length < 3) return false;
            if (trimmed === 'HEARTBEAT_OK' || trimmed.startsWith('HEARTBEAT_OK')) return false;
            if (trimmed === 'NO_REPLY') return false;
            return true;
          });

        if (__DEV__) console.log('[session-history] loadHistory done', { sessionKey, count: parsed.length });

        // Only commit if we're still on the same session (fast-switch guard)
        if (activeSessionRef.current === sessionKey) {
          sessionMessageCacheRef.current.set(sessionKey, parsed);
          setMessages(parsed);
          setMessagesLoading(false);
        }
        
        // Update local cache for this chat
        if (activeChatRef.current) {
          try {
            await updateChatMessages(activeChatRef.current, parsed);
          } catch (e) {
            console.log('Local cache update failed:', e.message);
          }
        }
      } else {
        // Gateway returned no messages — confirm empty state (not a load error)
        if (activeSessionRef.current === sessionKey) {
          sessionMessageCacheRef.current.set(sessionKey, []);
          setMessages([]);
          setMessagesLoading(false);
        }
      }
    } catch (err) {
      console.log('Gateway history load failed, trying local cache:', err.message);
      setMessagesLoading(false);
      // Fallback to local storage only if gateway fails
      if (activeChatRef.current && activeSessionRef.current === sessionKey) {
        const localChat = await getChatSession(activeChatRef.current);
        if (localChat?.messages?.length > 0) {
          console.log('Loading from local cache:', localChat.messages.length, 'messages');
          setMessages(localChat.messages);
        }
      }
    }
  }, [sendReq]);

  // Switch active session (used for notification deep linking and session switching)
  const switchSession = useCallback(async (newKey) => {
    if (!newKey) return;
    const prevKey = activeSessionRef.current;
    if (newKey === prevKey) {
      // Already on this session, just refresh history
      await loadHistory(true);
      return;
    }

    if (__DEV__) console.log('[session-history] switchSession', { prevKey, newKey, cacheHit: sessionMessageCacheRef.current.has(newKey) });

    // Abort any active stream
    if (currentRunIdRef.current) {
      try {
        await sendReq(METHOD.CHAT_ABORT, {
          sessionKey: prevKey,
          runId: currentRunIdRef.current,
        });
      } catch {}
    }

    // Clear streaming state
    setIsStreaming(false);
    currentRunIdRef.current = null;
    streamBufRef.current = {};

    // Update active session key BEFORE touching messages so the
    // render cycle sees the new key before any state flushes.
    setActiveSessionKey(newKey);
    activeSessionRef.current = newKey;

    // Serve cached messages immediately if available (prevents blank flash)
    const cached = sessionMessageCacheRef.current.get(newKey);
    if (cached && cached.length > 0) {
      if (__DEV__) console.log('[session-history] cache hit', { newKey, count: cached.length });
      setMessages(cached);
      setMessagesLoading(false);
    } else {
      if (__DEV__) console.log('[session-history] cache miss, showing loading', { newKey });
      // Clear stale messages from prior session; show loading until history arrives
      setMessages([]);
      setMessagesLoading(true);
    }

    // Fetch history for new session from gateway
    try {
      const result = await sendReq(METHOD.CHAT_HISTORY, {
        sessionKey: newKey,
        limit: 200,
      });

      if (result && Array.isArray(result.messages)) {
        const parsed = result.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map((m, i) => {
            let text = '';
            if (typeof m.content === 'string') {
              text = m.content;
            } else if (Array.isArray(m.content)) {
              text = m.content
                .filter(b => b.type === 'text')
                .map(b => b.text || '')
                .join('');
            }
            return {
              id: m.id || `hist-${i}-${Date.now()}`,
              role: m.role,
              text: text,
              timestamp: m.timestamp || Date.now(),
              streaming: false,
            };
          })
          .filter(m => {
            const trimmed = (m.text || '').trim();
            if (!trimmed || trimmed.length < 3) return false;
            if (trimmed === 'HEARTBEAT_OK' || trimmed.startsWith('HEARTBEAT_OK')) return false;
            if (trimmed === 'NO_REPLY') return false;
            return true;
          });

        if (__DEV__) console.log('[session-history] switchSession fetch done', { newKey, count: parsed.length });

        // Only commit if user hasn't switched away again during the fetch
        if (activeSessionRef.current === newKey) {
          sessionMessageCacheRef.current.set(newKey, parsed);
          // Clear persist guard BEFORE setMessages so the debounced persist fires
          isSwitchingChatRef.current = false;
          setMessages(parsed);
          setMessagesLoading(false);
        }
      } else {
        // Gateway confirmed zero messages — show empty state, not loading
        if (activeSessionRef.current === newKey) {
          sessionMessageCacheRef.current.set(newKey, []);
          isSwitchingChatRef.current = false;
          setMessages([]);
          setMessagesLoading(false);
        }
      }
    } catch (err) {
      console.log('[session-history] History load for session failed:', err.message);
      if (activeSessionRef.current === newKey) {
        isSwitchingChatRef.current = false;
        setMessagesLoading(false);
      }
    }
  }, [sendReq, loadHistory]);

  // Send a chat message with optional image attachment
  const sendMessage = useCallback(async (text, imageData = null) => {
    if (!text.trim() && !imageData) return;

    const userMsg = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: text.trim() || '(image)',
      timestamp: Date.now(),
      streaming: false,
      image: imageData ? imageData.uri : null,
    };
    // Optimistic update: add to messages immediately
    setMessages(prev => {
      const updated = [...prev, userMsg];
      // Invalidate cache so next fetch always gets fresh data after a send
      const sk = activeSessionRef.current;
      if (sk) sessionMessageCacheRef.current.delete(sk);
      return updated;
    });

    try {
      const params = {
        sessionKey: activeSessionRef.current,
        message: text.trim() || 'What is in this image?',
        idempotencyKey: idempotencyKey(),
      };

      // Add image as attachment if present
      if (imageData && imageData.base64) {
        params.attachments = [{
          type: 'image',
          mimeType: imageData.mimeType || 'image/jpeg',
          data: imageData.base64,
          filename: `image_${Date.now()}.jpg`,
        }];
      }

      await sendReq(METHOD.CHAT_SEND, params);
    } catch (err) {
      // Mark the optimistic message as failed rather than silently dropping
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === userMsg.id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], failed: true };
          return updated;
        }
        return [...prev, {
          id: `err-${Date.now()}`,
          role: 'system',
          text: `Failed to send: ${err.message}`,
          timestamp: Date.now(),
          isError: true,
        }];
      });
    }
  }, [sendReq]);

  // Abort current streaming
  const abort = useCallback(async () => {
    if (currentRunIdRef.current) {
      try {
        await sendReq(METHOD.CHAT_ABORT, {
          sessionKey: activeSessionRef.current,
          runId: currentRunIdRef.current,
        });
      } catch {}
    }
  }, [sendReq]);

  // Disconnect (manual - stops auto-reconnect)
  const disconnect = useCallback(() => {
    console.log('Manual disconnect requested');
    reconnectAttemptRef.current = 0;
    reconnectStateRef.current = initialReconnectState();
    setReconnectPending(false);
    setAuthFailure(null);
    isConnectingRef.current = false;
    handshakeCompleteRef.current = false;
    
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null; // Prevent auto-reconnect
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  // Foreground resume: heal the socket, THEN sync history (cross-device sync).
  //
  // Mobile OSes suspend the WebSocket and FREEZE JS timers while the app is
  // backgrounded or the screen is locked, so the exponential-backoff reconnect
  // scheduled in `onclose` frequently never fires in the background. On resume
  // the socket is often already dead (or half-open) — if we only re-sync history
  // on an OPEN socket (the old behaviour) a call that dropped while backgrounded
  // stays dead until the user manually reconnects. Proactively reconnect when the
  // socket isn't OPEN so a voice call survives a lock-screen / app-switch the way
  // a phone call would.
  //
  // This is also the practical wifi↔cellular handoff recovery path: any resume
  // after a network change re-establishes immediately instead of waiting out the
  // 15s heartbeat watchdog. (A NetInfo connectivity listener would make handoff
  // recovery instant even without a foreground event — see follow-up note.)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState !== 'active') return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        // Socket survived — refresh history for cross-device sync.
        console.log('App foregrounded, syncing history from gateway...');
        loadHistory(true); // Force gateway sync
      } else if (!isConnectingRef.current && canAutoReconnect(reconnectStateRef.current)) {
        // Socket died while backgrounded (or the backoff timer was frozen) —
        // reconnect now rather than waiting for a possibly-frozen backoff timer.
        console.log('[voice-call] app foregrounded with dead socket — reconnecting');
        reconnectAttemptRef.current = 0; // fresh, fast reconnect on user return
        connect();
      }
    });

    return () => subscription.remove();
  }, [loadHistory, connect]);

  // Create a new chat with a unique gateway session key
  const createNewChat = useCallback(async () => {
    // Set switching flag to prevent persistence during transition
    isSwitchingChatRef.current = true;
    
    // Clear any pending persist timer
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    
    // Generate unique session key for this new chat (gateway-compatible)
    const newSessionKey = generateSessionKey();
    const newId = generateChatId();
    const newChat = {
      id: newId,
      title: 'New Chat',
      messages: [],
      sessionKey: newSessionKey, // Each chat gets its own session key
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    // Update refs BEFORE changing state
    activeChatRef.current = newId;
    activeSessionRef.current = newSessionKey;
    setActiveSessionKey(newSessionKey);
    
    await saveChatSession(newChat);
    await setActiveChatId(newId);
    setActiveChatIdState(newId);
    setMessages([]);
    
    const chats = await getChatSessions();
    setLocalChats(chats);
    
    // Refresh gateway session list
    loadSessionsList();
    
    // Clear switching flag after a brief delay
    setTimeout(() => {
      isSwitchingChatRef.current = false;
    }, 100);
    
    console.log('Created new chat with session key:', newSessionKey);
    return newChat;
  }, [loadSessionsList]);

  // Switch to a different local chat
  const switchLocalChat = useCallback(async (chatId) => {
    if (chatId === activeChatRef.current) return;
    
    // Set switching flag to prevent persistence during transition
    isSwitchingChatRef.current = true;
    
    // Clear any pending persist timer
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    
    // Abort any active stream
    if (currentRunIdRef.current) {
      try {
        await sendReq(METHOD.CHAT_ABORT, {
          sessionKey: activeSessionRef.current,
          runId: currentRunIdRef.current,
        });
      } catch {}
    }
    
    setIsStreaming(false);
    currentRunIdRef.current = null;
    streamBufRef.current = {};
    
    // Update the active chat ID FIRST (before changing messages)
    await setActiveChatId(chatId);
    setActiveChatIdState(chatId);
    activeChatRef.current = chatId;
    
    // Load messages for new chat
    const chat = await getChatSession(chatId);
    const newMessages = chat?.messages || [];
    setMessages(newMessages);
    
    // Clear switching flag after a brief delay to let state settle
    setTimeout(() => {
      isSwitchingChatRef.current = false;
    }, 100);
  }, [sendReq]);

  // Reload local chats list
  const reloadLocalChats = useCallback(async () => {
    const chats = await getChatSessions();
    setLocalChats(chats);
  }, []);

  // Subscribe to a gateway event (e.g. 'terminal.output', 'terminal.exit').
  // Returns an unsubscribe function. Multiple subscribers per event are
  // supported. Designed for screens that need live event streams without
  // touching the core chat pipeline.
  const subscribeEvent = useCallback((eventName, handler) => {
    if (!eventName || typeof handler !== 'function') return () => {};
    let set = eventSubsRef.current.get(eventName);
    if (!set) {
      set = new Set();
      eventSubsRef.current.set(eventName, set);
    }
    set.add(handler);
    return () => {
      const cur = eventSubsRef.current.get(eventName);
      if (!cur) return;
      cur.delete(handler);
      if (cur.size === 0) eventSubsRef.current.delete(eventName);
    };
  }, []);

  // Imperative helpers exposed so a screen (e.g. ChatScreen) can do
  // optimistic appends or replace history loaded via a tunneled fetch
  // (e.g. federation.node.invoke -> chat.history) without re-implementing
  // the whole message pipeline.
  const appendMessage = useCallback((m) => {
    if (!m) return;
    setMessages((prev) => [...prev, m]);
  }, []);

  const replaceMessages = useCallback((msgs) => {
    if (!Array.isArray(msgs)) { setMessages([]); return; }
    // Also update the session cache when history is replaced via tunneled fetch
    const sk = activeSessionRef.current;
    if (sk) sessionMessageCacheRef.current.set(sk, msgs);
    setMessages(msgs);
    setMessagesLoading(false);
  }, []);

  return {
    status,
    lastError,
    authFailure,
    reconnectPending,
    messages,
    messagesLoading,
    isStreaming,
    activeSessionKey,
    sessionsList,
    // Local chat persistence
    activeChatId,
    localChats,
    isInitialized,
    createNewChat,
    switchLocalChat,
    reloadLocalChats,
    // Gateway actions
    connect,
    disconnect,
    sendMessage,
    sendReq,
    abort,
    switchSession,
    loadSessionsList,
    loadHistory,
    clearMessages: () => setMessages([]),
    appendMessage,
    replaceMessages,
    subscribeEvent,
    // Connection diagnostics for the voice Diagnostics panel (long-press the
    // call button). Read live from refs so the panel reflects the real socket
    // liveness without re-rendering the whole tree on every frame.
    getConnectionDiagnostics: () => {
      const last = lastFrameAtRef.current || 0;
      return {
        status,
        // ms since the last inbound frame (ping ack / event / response).
        // This IS the "last ping ack" age the heartbeat watchdog uses.
        lastFrameAgeMs: last ? Date.now() - last : null,
        heartbeatTimeoutMs: heartbeatTimeoutRef.current,
        reconnectAttempt: reconnectAttemptRef.current,
        authHalted: Boolean(reconnectStateRef.current.halted),
        wsOpen: wsRef.current?.readyState === WebSocket.OPEN,
      };
    },
    // Cache control — useful for testing and force-refresh scenarios
    invalidateSessionCache: (key) => {
      if (key) sessionMessageCacheRef.current.delete(key);
      else sessionMessageCacheRef.current.clear();
    },
  };
}
