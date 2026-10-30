/**
 * WorldTerminalPanel — a floating, draggable + resizable CLI terminal that
 * lives over the fullscreen agent neural map ("world-terminal").
 *
 * It drives ONE persistent gateway session per device (the "World Manager"),
 * so the operator can spawn / redirect / stop sub-agents while watching the
 * map. The session id is generated once and stored under the AsyncStorage key
 * `world-terminal:sessionId` (UUID v4) — every load reuses the same session,
 * giving full conversation continuity.
 *
 * Transport: it reuses the EXACT gateway client the rest of the app uses —
 *   • input  → gateway.sendReq('chat.send', { sessionKey, message, ... })
 *              (the WS equivalent of infinibot_sessions_send)
 *   • output → gateway.subscribeEvent('chat', …) filtered to our sessionKey
 *              (the same EVENT.CHAT stream the dashboard already consumes)
 * No new transport is invented.
 *
 * Provider selector (Claude Code / Codex / OpenCode / Gemini) is sourced from
 * `coder.backends.list` (whichever are installed/enabled in infinibot.json).
 * Switching providers keeps the SAME session row — the choice is persisted and
 * sent as a routing hint on each message.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  PanResponder,
  ActivityIndicator,
  Platform,
  Dimensions,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS, FONTS } from '../constants/theme';

// AsyncStorage keys (string-literal, mirroring the task contract).
const SESSION_ID_KEY = 'world-terminal:sessionId';
const PROVIDER_KEY = 'world-terminal:provider';
const BOUNDS_KEY = 'world-terminal:bounds';
const SPAWNED_KEY = 'world-terminal:spawned';

const SYSTEM_PROMPT =
  'You are the World Manager. You observe and orchestrate the agent neural ' +
  'map. You can spawn, redirect, and stop sub-agents via infinibot_* tools. ' +
  'Keep responses terse — the operator is watching the map.';

// RFC4122 v4 UUID without relying on crypto.randomUUID (not guaranteed on
// Hermes). Device-local id only, so Math.random entropy is acceptable.
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// The four CLI providers the world-terminal can route to. `backendId` matches
// the ids returned by `coder.backends.list`; gemini is included optimistically
// (it is a registered backend but may be absent from older gateways).
const PROVIDER_DEFS = [
  { id: 'claude', label: 'Claude Code', backendId: 'claude-code', icon: 'sparkles-outline' },
  { id: 'codex', label: 'Codex', backendId: 'codex', icon: 'terminal-outline' },
  { id: 'opencode', label: 'OpenCode', backendId: 'opencode', icon: 'code-slash-outline' },
  { id: 'gemini', label: 'Gemini', backendId: 'gemini', icon: 'star-outline' },
  { id: 'grok', label: 'Grok Build', backendId: 'grok', icon: 'flash-outline' },
];

function extractText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('');
  }
  if (typeof msg.content === 'string') return msg.content;
  if (typeof msg.text === 'string') return msg.text;
  return '';
}

const MIN_W = 240;
const MIN_H = 220;
const DEFAULT_BOUNDS = { x: 24, y: 120, w: 320, h: 360 };

export function WorldTerminalPanel({ gateway, visible, onClose, insets, dock }) {
  const [bounds, setBounds] = useState(DEFAULT_BOUNDS);
  const [boundsLoaded, setBoundsLoaded] = useState(false);
  const [sessionKey, setSessionKey] = useState(null);
  const [provider, setProvider] = useState('claude');
  const [availableProviders, setAvailableProviders] = useState(PROVIDER_DEFS);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [messages, setMessages] = useState([]); // { id, role, text, streaming }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // ── Right-dock mode (mobile split view) ──────────────────────────────────
  // A full-height panel that slides in from the right edge over the map and
  // can be swiped away (or closed) to reveal the full world again.
  const dockW = useMemo(
    () => Math.min(380, Math.round(Dimensions.get('window').width * 0.82)),
    [],
  );
  const dockAnim = useRef(new Animated.Value(dockW)).current; // offscreen right
  const [dockMounted, setDockMounted] = useState(false);

  const scrollRef = useRef(null);
  const streamBufRef = useRef({}); // runId -> text
  const sessionKeyRef = useRef(null);
  const providerRef = useRef('claude');
  const boundsRef = useRef(DEFAULT_BOUNDS);

  useEffect(() => { sessionKeyRef.current = sessionKey; }, [sessionKey]);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { boundsRef.current = bounds; }, [bounds]);

  // Slide the docked panel in on open / out on close. Keep it mounted through
  // the exit animation so the collapse is visible, then unmount.
  useEffect(() => {
    if (dock !== 'right') return undefined;
    if (visible) {
      setDockMounted(true);
      Animated.timing(dockAnim, {
        toValue: 0,
        duration: 240,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(dockAnim, {
        toValue: dockW,
        duration: 200,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setDockMounted(false);
      });
    }
    return undefined;
  }, [visible, dock, dockAnim, dockW]);

  // ── Persisted bounds + provider + the one stable session id ──────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rawBounds, rawProvider, rawSession] = await Promise.all([
          AsyncStorage.getItem(BOUNDS_KEY),
          AsyncStorage.getItem(PROVIDER_KEY),
          AsyncStorage.getItem(SESSION_ID_KEY),
        ]);
        if (cancelled) return;
        if (rawBounds) {
          try {
            const b = JSON.parse(rawBounds);
            if (b && typeof b.x === 'number') setBounds(b);
          } catch {}
        }
        if (rawProvider) setProvider(rawProvider);

        // One persistent session id per device — generate once, reuse forever.
        let id = rawSession;
        if (!id) {
          id = uuidv4();
          await AsyncStorage.setItem(SESSION_ID_KEY, id);
        }
        // agent:main:* routes to the primary agent (which holds infinibot_*
        // tools), giving the World Manager real orchestration ability.
        setSessionKey(`agent:main:world-terminal-${id}`);
      } catch {
        if (!cancelled) setSessionKey(`agent:main:world-terminal-${uuidv4()}`);
      } finally {
        if (!cancelled) setBoundsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Discover enabled CLI providers from infinibot.json (via gateway) ──────
  useEffect(() => {
    if (!gateway?.sendReq) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await gateway.sendReq('coder.backends.list', {});
        if (cancelled) return;
        const list = Array.isArray(res?.backends) ? res.backends : [];
        if (list.length === 0) return; // keep optimistic defaults
        const knownIds = new Set(list.map((b) => b.id));
        const installedIds = new Set(
          list.filter((b) => b?.install?.installed !== false).map((b) => b.id),
        );
        // Keep a provider if the gateway reports it installed, OR if the gateway
        // doesn't know about that backend at all (e.g. gemini is a real backend
        // but absent from `coder.backends.list`) — don't silently drop it.
        const filtered = PROVIDER_DEFS.filter(
          (p) => installedIds.has(p.backendId) || !knownIds.has(p.backendId),
        );
        // Always keep at least the defaults so the selector is never empty.
        setAvailableProviders(filtered.length ? filtered : PROVIDER_DEFS);
        // If the persisted provider is no longer available, fall back.
        if (filtered.length && !filtered.some((p) => p.id === providerRef.current)) {
          setProvider(filtered[0].id);
        }
      } catch {
        // Offline / older gateway — defaults already shown.
      }
    })();
    return () => { cancelled = true; };
  }, [gateway]);

  // ── Subscribe to the live chat stream, filtered to OUR session ───────────
  useEffect(() => {
    if (!gateway?.subscribeEvent || !sessionKey) return undefined;
    const unsub = gateway.subscribeEvent('chat', (payload) => {
      if (!payload) return;
      const { runId, state, message: msg, sessionKey: evKey } = payload;
      // Only our World Manager session — never leak the main chat in here.
      if (evKey && evKey !== sessionKey) return;

      if (state === 'delta') {
        const text = extractText(msg);
        streamBufRef.current[runId] = text;
        setBusy(true);
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.runId === runId);
          const m = { id: `s-${runId}`, runId, role: 'assistant', text, streaming: true };
          if (idx >= 0) { const u = [...prev]; u[idx] = m; return u; }
          return [...prev, m];
        });
      } else if (state === 'final') {
        let text = extractText(msg) || streamBufRef.current[runId] || '';
        delete streamBufRef.current[runId];
        setBusy(false);
        const trimmed = text.trim();
        setMessages((prev) => {
          const without = prev.filter((m) => m.runId !== runId);
          if (!trimmed || trimmed === 'NO_REPLY' || trimmed.startsWith('HEARTBEAT_OK')) {
            return without;
          }
          return [...without, { id: `f-${runId}`, runId, role: 'assistant', text, streaming: false }];
        });
      } else if (state === 'error') {
        delete streamBufRef.current[runId];
        setBusy(false);
        setMessages((prev) => [
          ...prev.filter((m) => m.runId !== runId),
          { id: `e-${runId}`, runId, role: 'system', text: `Error: ${payload.errorMessage || 'unknown'}`, isError: true },
        ]);
      } else if (state === 'aborted') {
        delete streamBufRef.current[runId];
        setBusy(false);
      }
    });
    return unsub;
  }, [gateway, sessionKey]);

  // ── On first open: restore history, then auto-spawn if brand new ─────────
  const openedRef = useRef(false);
  useEffect(() => {
    if (!visible || !sessionKey || !gateway?.sendReq || openedRef.current) return;
    openedRef.current = true;
    (async () => {
      // Restore transcript so reopening shows conversation continuity.
      try {
        const res = await gateway.sendReq('chat.history', { sessionKey, limit: 100 });
        const hist = Array.isArray(res?.messages) ? res.messages : [];
        const parsed = hist
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m, i) => ({ id: m.id || `h-${i}`, role: m.role, text: extractText(m), streaming: false }))
          .filter((m) => {
            const t = (m.text || '').trim();
            return t && t !== 'NO_REPLY' && !t.startsWith('HEARTBEAT_OK') && !t.startsWith(SYSTEM_PROMPT);
          });
        if (parsed.length) setMessages(parsed);
      } catch {}

      // Auto-spawn the World Manager once per device (prime with system prompt).
      try {
        const spawned = await AsyncStorage.getItem(SPAWNED_KEY);
        if (!spawned) {
          await AsyncStorage.setItem(SPAWNED_KEY, '1');
          const backend = PROVIDER_DEFS.find((p) => p.id === providerRef.current)?.backendId;
          await gateway.sendReq('chat.send', {
            sessionKey,
            message:
              `${SYSTEM_PROMPT}\n\nPreferred CLI backend for any sub-agents you ` +
              `spawn: ${backend || 'claude-code'}.\n\nYou are now online. ` +
              `Acknowledge in one short line.`,
            idempotencyKey: `${Date.now()}-spawn`,
          });
          setBusy(true);
        }
      } catch {}
    })();
  }, [visible, sessionKey, gateway]);

  // Keep the panel on-screen (clamp size to viewport, position within bounds).
  const clampBounds = useCallback((b) => {
    const { width: sw, height: sh } = Dimensions.get('window');
    const top = (insets?.top || 0) + 8;
    const w = Math.max(MIN_W, Math.min(b.w, sw - 8));
    const h = Math.max(MIN_H, Math.min(b.h, sh - top - 8));
    const x = Math.max(4, Math.min(b.x, sw - w - 4));
    const y = Math.max(top, Math.min(b.y, sh - h - 8));
    return { x, y, w, h };
  }, [insets]);

  const persistBounds = useCallback(
    (b) => {
      const c = clampBounds(b);
      boundsRef.current = c;
      setBounds(c);
      AsyncStorage.setItem(BOUNDS_KEY, JSON.stringify(c)).catch(() => {});
    },
    [clampBounds],
  );

  const selectProvider = useCallback((id) => {
    const prev = providerRef.current;
    setProvider(id);
    setProviderMenuOpen(false);
    AsyncStorage.setItem(PROVIDER_KEY, id).catch(() => {});
    // Keep the SAME session row — just steer the backend for future spawns by
    // telling the World Manager. (chat.send is additionalProperties:false, so a
    // backend param can't ride along; an in-band directive is the clean route.)
    if (id !== prev && gateway?.sendReq && sessionKeyRef.current) {
      const backend = PROVIDER_DEFS.find((p) => p.id === id)?.backendId || id;
      gateway
        .sendReq('chat.send', {
          sessionKey: sessionKeyRef.current,
          message: `Switch preferred CLI backend to ${backend} for any sub-agents you spawn from now on. Reply with just "ok".`,
          idempotencyKey: `${Date.now()}-prov`,
        })
        .catch(() => {});
    }
  }, [gateway]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !gateway?.sendReq || !sessionKeyRef.current) return;
    setInput('');
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', text, streaming: false }]);
    setBusy(true);
    try {
      await gateway.sendReq('chat.send', {
        sessionKey: sessionKeyRef.current,
        message: text,
        idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    } catch (err) {
      setBusy(false);
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'system', text: `Failed: ${err?.message || err}`, isError: true },
      ]);
    }
  }, [input, gateway]);

  useEffect(() => {
    if (messages.length) {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd?.({ animated: true }));
    }
  }, [messages]);

  // ── Drag (header) ────────────────────────────────────────────────────────
  // Drag uses absolute dx/dy from grant, so re-anchor on every grant.
  const dragStart = useRef(DEFAULT_BOUNDS);
  const dragResponderStable = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3,
        onPanResponderGrant: () => { dragStart.current = { ...boundsRef.current }; },
        onPanResponderMove: (_e, g) => {
          const s = dragStart.current;
          setBounds({ ...boundsRef.current, x: s.x + g.dx, y: s.y + g.dy });
        },
        onPanResponderRelease: () => persistBounds(boundsRef.current),
      }),
    [persistBounds],
  );

  // ── Resize (bottom-right handle) ─────────────────────────────────────────
  const resizeStart = useRef(DEFAULT_BOUNDS);
  const resizeResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => { resizeStart.current = { ...boundsRef.current }; },
        onPanResponderMove: (_e, g) => {
          const s = resizeStart.current;
          setBounds({
            ...boundsRef.current,
            w: Math.max(MIN_W, s.w + g.dx),
            h: Math.max(MIN_H, s.h + g.dy),
          });
        },
        onPanResponderRelease: () => persistBounds(boundsRef.current),
      }),
    [persistBounds],
  );

  // ── Swipe-to-collapse gesture for the docked panel ───────────────────────
  const dockSwipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          g.dx > 8 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (_e, g) => {
          if (g.dx > 0) dockAnim.setValue(g.dx);
        },
        onPanResponderRelease: (_e, g) => {
          if (g.dx > dockW * 0.33 || g.vx > 0.5) {
            Animated.timing(dockAnim, {
              toValue: dockW,
              duration: 180,
              useNativeDriver: true,
            }).start(() => onClose?.());
          } else {
            Animated.spring(dockAnim, {
              toValue: 0,
              bounciness: 4,
              useNativeDriver: true,
            }).start();
          }
        },
      }),
    [dockAnim, dockW, onClose],
  );

  const activeProvider =
    availableProviders.find((p) => p.id === provider) ||
    PROVIDER_DEFS.find((p) => p.id === provider) ||
    PROVIDER_DEFS[0];
  const topClamp = (insets?.top || 0) + 8;

  // Shared inner chrome — reused by both the floating and docked layouts.
  const headerRow = (handlers) => (
    <View style={styles.header} {...(handlers || {})}>
      <Ionicons name="reorder-three-outline" size={16} color={COLORS.textMuted} />
      <TouchableOpacity
        style={styles.providerBtn}
        onPress={() => setProviderMenuOpen((v) => !v)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={`Coder backend: ${activeProvider.label}`}
        accessibilityHint="Switches provider without starting a new session"
      >
        <Ionicons name={activeProvider.icon} size={13} color={COLORS.primary} />
        <Text style={styles.providerText} numberOfLines={1}>{activeProvider.label}</Text>
        <Ionicons name="chevron-down" size={12} color={COLORS.textMuted} />
      </TouchableOpacity>
      <View style={{ flex: 1 }} />
      {/* Closing this panel DETACHES the view — it never ends the session.
          The World Manager runs against one persistent sessionKey held in
          AsyncStorage (SESSION_ID_KEY), so the conversation and any agents it
          spawned survive; re-opening reattaches to the same session with its
          transcript intact. Same semantics as detaching a duplicated terminal
          panel in TerminalsScreen — the view goes away, the work does not. */}
      <TouchableOpacity
        onPress={onClose}
        hitSlop={10}
        style={styles.closeBtn}
        accessibilityRole="button"
        accessibilityLabel="Detach world terminal"
        accessibilityHint="Hides this panel; the World Manager session keeps running"
      >
        <Ionicons name="close" size={16} color={COLORS.textMuted} />
      </TouchableOpacity>
    </View>
  );

  const dropdown = providerMenuOpen && (
    <View style={styles.providerMenu}>
      {availableProviders.map((p) => (
        <TouchableOpacity
          key={p.id}
          style={[styles.providerItem, p.id === provider && styles.providerItemActive]}
          onPress={() => selectProvider(p.id)}
          activeOpacity={0.8}
        >
          <Ionicons name={p.icon} size={13} color={p.id === provider ? COLORS.primary : COLORS.textMuted} />
          <Text style={[styles.providerItemText, p.id === provider && { color: COLORS.primary }]}>
            {p.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const transcript = (
    <ScrollView
      ref={scrollRef}
      style={styles.log}
      contentContainerStyle={styles.logContent}
      keyboardShouldPersistTaps="handled"
    >
      {messages.length === 0 ? (
        <Text style={styles.hint}>World Manager online. Try “list agents”.</Text>
      ) : (
        messages.map((m) => (
          <View key={m.id} style={styles.msgRow}>
            <Text
              style={[
                styles.msgRole,
                m.role === 'user' && { color: COLORS.primary },
                m.isError && { color: '#EF4444' },
              ]}
            >
              {m.role === 'user' ? '›' : m.isError ? <Ionicons name="close" size={12} color="#EF4444" /> : '◆'}
            </Text>
            <Text style={[styles.msgText, m.isError && { color: '#EF4444' }]}>
              {m.text}
              {m.streaming ? ' ▌' : ''}
            </Text>
          </View>
        ))
      )}
    </ScrollView>
  );

  const composer = (
    <View style={styles.composer}>
      {busy ? <ActivityIndicator size="small" color={COLORS.primary} style={{ marginRight: 6 }} /> : null}
      <TextInput
        style={styles.input}
        value={input}
        onChangeText={setInput}
        placeholder="message world manager…"
        placeholderTextColor={COLORS.textMuted}
        onSubmitEditing={send}
        returnKeyType="send"
        blurOnSubmit={false}
      />
      <TouchableOpacity onPress={send} style={styles.sendBtn} disabled={!input.trim()}>
        <Ionicons name="arrow-up" size={16} color={input.trim() ? '#020207' : COLORS.textMuted} />
      </TouchableOpacity>
    </View>
  );

  // ── Right-dock (mobile split view): slides in from the right, swipe away ──
  if (dock === 'right') {
    if (!boundsLoaded || !dockMounted) return null;
    return (
      <Animated.View
        style={[
          styles.dockPanel,
          { width: dockW, top: topClamp, transform: [{ translateX: dockAnim }] },
        ]}
      >
        {/* Left-edge grab strip — swipe right here (or on the header) to collapse */}
        <View style={styles.dockGrip} {...dockSwipe.panHandlers}>
          <View style={styles.dockGripBar} />
        </View>
        <View style={styles.dockBody}>
          {headerRow(dockSwipe.panHandlers)}
          {dropdown}
          {transcript}
          {composer}
        </View>
      </Animated.View>
    );
  }

  // ── Floating (legacy draggable box) ──────────────────────────────────────
  if (!visible || !boundsLoaded) return null;
  return (
    <View
      style={[
        styles.panel,
        {
          left: Math.max(4, bounds.x),
          top: Math.max(topClamp, bounds.y),
          width: bounds.w,
          height: bounds.h,
        },
      ]}
    >
      {headerRow(dragResponderStable.panHandlers)}
      {dropdown}
      {transcript}
      {composer}
      {/* Resize handle */}
      <View style={styles.resizeHandle} {...resizeResponder.panHandlers}>
        <Ionicons name="resize-outline" size={14} color={COLORS.textMuted} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    backgroundColor: 'rgba(8,8,14,0.94)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.4)',
    overflow: 'hidden',
    zIndex: 80,
    elevation: 80,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } },
      android: {},
    }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.07)',
    backgroundColor: 'rgba(212,175,55,0.06)',
  },
  providerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.25)',
    maxWidth: 150,
  },
  providerText: {
    ...FONTS.tiny,
    color: COLORS.text,
    fontSize: 11,
    letterSpacing: 0.4,
  },
  closeBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  providerMenu: {
    position: 'absolute',
    top: 44,
    left: 28,
    zIndex: 90,
    elevation: 90,
    backgroundColor: 'rgba(14,14,22,0.98)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingVertical: 4,
    minWidth: 150,
  },
  providerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  providerItemActive: {
    backgroundColor: 'rgba(212,175,55,0.12)',
  },
  providerItemText: {
    ...FONTS.small,
    color: COLORS.textMuted,
    fontSize: 12,
  },
  log: {
    flex: 1,
  },
  logContent: {
    padding: 10,
    gap: 8,
  },
  hint: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontStyle: 'italic',
  },
  msgRow: {
    flexDirection: 'row',
    gap: 6,
  },
  msgRole: {
    color: COLORS.textMuted,
    fontSize: 12,
    lineHeight: 17,
    width: 12,
  },
  msgText: {
    flex: 1,
    color: COLORS.text,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.07)',
    gap: 6,
  },
  input: {
    flex: 1,
    color: COLORS.text,
    fontSize: 13,
    paddingVertical: Platform.OS === 'ios' ? 6 : 2,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
  },
  sendBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
  },
  resizeHandle: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // ── Right-docked split-view panel ────────────────────────────────────────
  dockPanel: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    backgroundColor: 'rgba(8,8,14,0.96)',
    borderLeftWidth: 1,
    borderColor: 'rgba(212,175,55,0.4)',
    zIndex: 80,
    elevation: 80,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: -6, height: 0 } },
      android: {},
    }),
  },
  dockGrip: {
    width: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,175,55,0.06)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.06)',
  },
  dockGripBar: {
    width: 4,
    height: 46,
    borderRadius: 2,
    backgroundColor: 'rgba(212,175,55,0.55)',
  },
  dockBody: {
    flex: 1,
  },
});

export default WorldTerminalPanel;
