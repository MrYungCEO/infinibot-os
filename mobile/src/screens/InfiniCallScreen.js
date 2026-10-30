/**
 * InfiniCallScreen — "call InfiniBot": the friendly face of the app.
 *
 * The character is the hero, centred in both orientations (geometry in
 * infini/layout.js):
 *
 *   portrait   a light header (close · target chip · speaker · options), the
 *              face ~90% of the width centred in the free area, then status
 *              and one slim dock (transcript · mic / type / end · capture "+")
 *   landscape  the face ~86% of the height, centred; slim rails on both
 *              sides — left: close/options, target, status, talk controls;
 *              right: transcript/terminal toggles and the capture "+"
 *
 * Quick capture is a single "+" orb (<CaptureOrb>) that fans out a labelled
 * Note / Idea / Task / Project / Log menu, so the face keeps the room.
 *
 * Behind it, <InfiniBackdrop> (deep radial + nebula, drifting aurora,
 * parallax dust, a mood-tinted light pool under the face, grain, vignette);
 * controls are frosted-glass <GlassButton>s with hairline gold.
 *
 * Calls run on the LOCAL voice system by default (useInfiniCall → the
 * gateway's /api/voice/* routes, same protocol as the web Voice page). When
 * the user picks Cloud voice (Robovoice — optional, free), tapping the face opens the
 * Robovoice console instead — the only way it is reached from the phone.
 *
 * Tap the face = talk / send / interrupt; long-press = call options. Quick
 * capture buttons record a note / idea / task / project / log, have AI
 * structure it, and save it through the gateway (queued offline, retried,
 * idempotent). The transcript and the CLI terminal are slide-over panels.
 *
 * "Hey Infini" (call options, off by default): while this page is open the
 * wake listener (infini/wake) waits for the phrase; on a wake the face perks
 * up with a haptic, then the call starts listening to the currently selected
 * target — exactly like a tap — as a one-shot turn, after which the wake
 * listener takes the mic back.
 *
 * Mutes (infini/mute-machine.js, persisted per device): the MIC mute sits
 * in the dock (portrait) / left rail (landscape). While muted nothing
 * is recorded — the wake listener is held, push-to-talk and tap-to-talk are
 * suspended, a listening turn is dropped — the face wears a muted badge and
 * the status says "Muted". The SPEAKER mute (header / left rail) silences the
 * spoken replies; the transcript still shows them and the face lip-syncs
 * from the text.
 *
 * Wake diagnostics (Call options › Listening › Diagnostics, or long-press the
 * wake badge): mic level, VAD state, last clip, last STT text, match + reason.
 *
 * Landscape: only this screen may rotate (infini/orientation.js). The call
 * lives in hooks above the layout, so rotating never interrupts it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Reanimated, { Easing as REasing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';

import { useUIKit, useReducedMotion, SPACE, RADIUS } from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import { InfiniFace, haptic } from '../infini/InfiniFace';
import { InfiniBackdrop } from '../infini/InfiniBackdrop';
import { GLASS, GlassButton } from '../infini/Glass';
import { useInfiniCall } from '../infini/useInfiniCall';
import { useCallOptions } from '../infini/useCallOptions';
import { CallOptionsSheet } from '../infini/CallOptionsSheet';
import { CaptureSheet, CAPTURE_KINDS } from '../infini/CaptureSheet';
import { CaptureOrb } from '../infini/CaptureOrb';
import { createCaptureQueue } from '../infini/capture-queue';
import { faceStateFor, statusText } from '../infini/call-machine';
import { rippleGrowth, swirlScale, syntheticSpeechLevel } from '../infini/face-math';
import { devicePerfTier, effectBudget, useAppActive } from '../infini/perf-tier';
import { useAmbientPause } from '../components/AmbientBackground';
import { effectiveInsets, infiniLayout } from '../infini/layout';
import { useRotationWhileFocused } from '../infini/orientation';
import { useWakeWord } from '../infini/wake/useWakeWord';
import { wakePhrasesFor } from '../infini/wake/wake-phrase';
import { wakeAction } from '../infini/wake/wake-machine';
import { micGate, wakeHoldReason } from '../infini/mute-machine';
import { WakeDebugPanel } from '../infini/WakeDebugPanel';
import {
  CAPTURE_ICONS,
  ChatLinesIcon,
  CloseIcon,
  CloudIcon,
  EarIcon,
  KeyboardIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  SlidersIcon,
  TerminalIcon,
} from '../infini/icons';

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g, '');
}

const PHASE_LABEL = {
  idle: 'Ready',
  starting: 'Connecting',
  listening: 'Listening',
  transcribing: 'Hearing you',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Needs attention',
};

/** Small pulsing dot (UI thread). */
function PulseDot({ color, active, reduced, size = 8 }) {
  const v = useSharedValue(0);
  useEffect(() => {
    if (!active || reduced) {
      cancelAnimation(v);
      v.value = 0;
      return undefined;
    }
    v.value = withRepeat(withTiming(1, { duration: 1100, easing: REasing.out(REasing.quad) }), -1, false);
    return () => cancelAnimation(v);
  }, [active, reduced]); // eslint-disable-line react-hooks/exhaustive-deps
  const ring = useAnimatedStyle(() => ({ opacity: 0.6 * (1 - v.value), transform: [{ scale: 1 + 1.6 * v.value }] }));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Reanimated.View style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color }, ring]} />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

export function InfiniCallScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const reduced = useReducedMotion();
  const rawInsets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const focused = useIsFocused();
  // Animations run only while this page is on screen and the app is in front;
  // the app-wide backdrop under this opaque page stops breathing meanwhile.
  const appActive = useAppActive();
  const animPaused = !focused || !appActive;
  useAmbientPause(focused);
  const budget = effectBudget(devicePerfTier());
  // Lay out against the screen's real box (an app-level banner can sit above
  // it), falling back to the window until the first layout pass; a box from
  // the other orientation is stale (mid-rotation).
  const [box, setBox] = useState(null);
  const winLand = win.width > win.height;
  const useBox = box && box.width > box.height === winLand;
  const width = useBox ? box.width : win.width;
  const height = useBox ? box.height : win.height;
  const insets = effectiveInsets(rawInsets, win.height, useBox ? box.height : win.height);
  const onRootLayout = useCallback((e) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setBox((b) => (b && b.width === w && b.height === h ? b : { width: w, height: h }));
  }, []);
  useRotationWhileFocused();
  const L = infiniLayout(width, height, insets);
  const landscape = L.orientation === 'landscape';
  const options = useCallOptions(gateway);
  const micMuted = options.prefs.micMuted === true;
  const speakerMuted = options.prefs.speakerMuted === true;
  const gate = micGate({ micMuted });
  const call = useInfiniCall({ target: options.target, handsFree: options.prefs.handsFree !== false, micMuted, speakerMuted });
  const { state } = call;
  const faceState = faceStateFor(state.phase);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [capture, setCapture] = useState(null);
  const [captureMenu, setCaptureMenu] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [drawer, setDrawer] = useState(null); // null | 'transcript' | 'terminal'
  const drawerAnim = useRef({ transcript: new Animated.Value(0), terminal: new Animated.Value(0) }).current;
  const fade = useRef(new Animated.Value(1)).current;
  const lastOrientation = useRef(L.orientation);
  const pttHeld = useRef(false);
  const [terminalText, setTerminalText] = useState('');
  const [projects, setProjects] = useState([]);
  const [toast, setToast] = useState(null);
  const [queued, setQueued] = useState(0);
  const [perkKey, setPerkKey] = useState(0);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef(null);
  const connected = gateway?.status === 'connected';
  const cliMode = options.route?.mode === 'cli' && options.route?.target;
  const cloud = options.engine === 'cloud';

  // ── "Hey Infini" ───────────────────────────────────────────────────────────
  const wakePhrases = useMemo(
    () => wakePhrasesFor(options.label.title, { phrases: options.prefs.wakePhrases, agentName: options.prefs.wakeAgentName !== false }),
    [options.label.title, options.prefs.wakePhrases, options.prefs.wakeAgentName],
  );
  const micMutedRef = useRef(micMuted);
  micMutedRef.current = micMuted;
  const onWake = useCallback(
    (match) => {
      if (micMutedRef.current) return;
      haptic('medium');
      setPerkKey((k) => k + 1);
      const act = wakeAction(match);
      // Let the perk-up land, then behave exactly like a tap on the face.
      setTimeout(() => {
        if (act?.type === 'send') void call.sendText(act.text, { oneShot: true });
        else void call.start({ oneShot: true });
      }, reduced ? 120 : 420);
    },
    [call, reduced],
  );
  const wake = useWakeWord({
    enabled: options.prefs.wake === true && !cloud,
    holdReason: wakeHoldReason({ micMuted, focused, inCall: state.inCall, sheetBusy: !!capture }),
    phrases: wakePhrases,
    sensitivity: options.prefs.wakeSensitivity,
    withDebug: options.prefs.wakeDebug === true,
    onWake,
  });

  // ── offline-safe capture queue ─────────────────────────────────────────────
  const queue = useMemo(
    () =>
      createCaptureQueue({
        storage: AsyncStorage,
        save: (draft, clientRequestId) => gateway.sendReq('capture.save', { draft, clientRequestId }),
      }),
    [gateway],
  );
  const refreshQueued = useCallback(() => queue.size().then(setQueued).catch(() => {}), [queue]);
  const showToastRef = useRef(null);

  const showToast = useCallback(
    (t) => {
      setToast(t);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      Animated.timing(toastAnim, { toValue: 1, duration: reduced ? 0 : 220, useNativeDriver: true }).start();
      toastTimer.current = setTimeout(() => {
        Animated.timing(toastAnim, { toValue: 0, duration: reduced ? 0 : 160, useNativeDriver: true }).start(() => setToast(null));
      }, t.ms || 5200);
    },
    [toastAnim, reduced],
  );

  useEffect(() => {
    void refreshQueued();
    if (!connected) return undefined;
    const flush = () =>
      queue.flush().then((res) => {
        void refreshQueued();
        if (res.sent.length) showToast({ text: `Synced ${res.sent.length} offline capture${res.sent.length > 1 ? 's' : ''}`, tone: 'ok' });
      });
    void flush();
    const t = setInterval(flush, 20_000);
    return () => clearInterval(t);
  }, [connected, queue, refreshQueued, showToast]);

  // Board projects for capture's project picker.
  useEffect(() => {
    if (!connected) return;
    gateway
      .sendReq('kanban.projects.list', {})
      .then((res) => {
        const list = Array.isArray(res) ? res : res?.projects || [];
        setProjects(list.map((p) => ({ id: p.id, name: p.name || p.title || p.id })).filter((p) => p.id));
      })
      .catch(() => {});
  }, [connected, gateway]);

  // Re-layout on rotation: a short cross-fade instead of a jump.
  useEffect(() => {
    if (lastOrientation.current === L.orientation) return;
    lastOrientation.current = L.orientation;
    // The face (hold-to-talk) is re-mounted by the new layout and will never see
    // its press-out, so finish a held turn here (the call itself carries on).
    if (pttHeld.current) {
      pttHeld.current = false;
      call.pttEnd();
    }
    setDrawer(null);
    setCaptureMenu(false);
    if (reduced) return;
    fade.setValue(0.25);
    Animated.timing(fade, { toValue: 1, duration: 240, useNativeDriver: true }).start();
  }, [L.orientation, reduced, fade]); // eslint-disable-line react-hooks/exhaustive-deps

  // Side / bottom panels slide in and out.
  useEffect(() => {
    for (const k of ['transcript', 'terminal']) {
      Animated.timing(drawerAnim[k], { toValue: drawer === k ? 1 : 0, duration: reduced ? 0 : 240, useNativeDriver: true }).start();
    }
  }, [drawer, reduced, drawerAnim]);
  const toggleDrawer = useCallback((k) => setDrawer((d) => (d === k ? null : k)), []);

  const terminalVisible = drawer === 'terminal';

  // CLI mode: follow the routed session's pane (same source as the web voice terminal stream).
  useEffect(() => {
    if (!cliMode || !terminalVisible || !connected) return undefined;
    const t = options.route.target;
    const id = t.terminalId || (t.runId ? `spawn-${t.runId}` : null);
    if (!id) return undefined;
    let alive = true;
    const peek = () =>
      gateway
        .sendReq('terminal.peek', { id, maxChars: 12000, lines: 200 })
        .then((res) => {
          if (!alive) return;
          const lines = stripAnsi(res?.text).split('\n').filter((l, i, a) => l.trim() || i < a.length - 1);
          setTerminalText(lines.slice(-60).join('\n') || (res?.alive === false ? '(session is not running)' : ''));
        })
        .catch(() => {});
    void peek();
    const timer = setInterval(peek, 1500);
    const unsub = gateway.subscribeEvent?.('voice.cli.turn', () => {
      void peek();
      void options.refresh();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      unsub?.();
    };
  }, [cliMode, terminalVisible, connected, gateway, options.route]); // eslint-disable-line react-hooks/exhaustive-deps

  const openCloudConsole = useCallback(() => {
    navigation.navigate('WebSurfaceModal', { path: '/voice', title: 'Robovoice', embed: true });
  }, [navigation]);

  const onFaceTap = useCallback(() => {
    if (cloud) return openCloudConsole();
    if (!gate.tapToTalk && (state.phase === 'idle' || state.phase === 'error')) {
      haptic('warn');
      showToastRef.current?.({ text: 'The mic is muted. Unmute it to talk, or type a message.', tone: 'warn', ms: 3200 });
      return;
    }
    call.tap();
  }, [cloud, call, openCloudConsole, gate.tapToTalk, state.phase]);

  const toggleMic = useCallback(() => {
    haptic('medium');
    const next = !micMuted;
    if (next && pttHeld.current) {
      pttHeld.current = false;
      call.pttEnd();
    }
    options.savePrefs({ micMuted: next });
  }, [micMuted, options, call]);
  const toggleSpeaker = useCallback(() => {
    haptic('medium');
    options.savePrefs({ speakerMuted: !speakerMuted });
  }, [speakerMuted, options]);

  const openCapture = useCallback(
    (kind) => {
      haptic('light');
      setCaptureMenu(false);
      if (state.inCall) void call.end();
      setCapture(kind);
    },
    [state.inCall, call],
  );

  const onSaved = useCallback(
    (res, draft) => {
      void refreshQueued();
      const label = CAPTURE_KINDS.find((k) => k.kind === draft.kind)?.label || 'Item';
      if (res.status === 'queued') {
        haptic('warn');
        showToast({ text: `${label} saved offline — it syncs when the gateway is back.`, tone: 'warn' });
        return;
      }
      haptic('success');
      const open = res.result?.open;
      showToast({
        text: `${label} saved${res.result?.duplicate ? ' (already synced)' : ''}: ${res.result?.title || draft.title}`,
        tone: 'ok',
        action: open
          ? {
              label: 'Open',
              go: () => {
                if (open.kind === 'idea') navigation.navigate('MainTabs', { screen: 'Knowledge', params: { screen: 'Ideas', initial: false } });
                else if (open.kind === 'note') navigation.navigate('MainTabs', { screen: 'Knowledge', params: { screen: 'Notes', initial: false } });
                else navigation.navigate('MainTabs', { screen: 'Board' });
              },
            }
          : null,
      });
    },
    [navigation, refreshQueued, showToast],
  );

  // ── verification / demo hook (web only, opt-in via ?infiniDemo) ───────────
  const [demoWake, setDemoWake] = useState(false);
  const [demoDebug, setDemoDebug] = useState(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    if (!/[?&]infiniDemo\b/.test(window.location.search) && !__DEV__) return undefined;
    let timer = null;
    window.__infiniDemo = {
      simulate: ({ phase, level, auto, lines } = {}) => {
        if (timer) clearInterval(timer);
        timer = null;
        if (phase) {
          call.dispatch({ type: 'start' });
          if (phase !== 'starting') call.dispatch({ type: phase === 'error' ? 'fail' : phase === 'idle' ? 'end' : phase, error: 'I can’t reach your gateway right now. Tap me to retry.' });
        }
        for (const l of lines || []) call.dispatch({ type: 'line', line: { final: true, ...l } });
        if (typeof level === 'number') call.levelRef.current = level;
        if (auto) {
          const t0 = Date.now();
          timer = setInterval(() => {
            const t = (Date.now() - t0) / 1000;
            call.levelRef.current = auto === 'speech' ? syntheticSpeechLevel(t) : 0.35 + 0.35 * Math.abs(Math.sin(t * 5.3)) * Math.abs(Math.sin(t * 1.3));
          }, 40);
        }
      },
      level: (v) => {
        call.levelRef.current = v;
      },
      perk: () => setPerkKey((k) => k + 1),
      wakeBadge: (on = true) => setDemoWake(on),
      wakeDebug: (snap) => setDemoDebug(snap),
      prefs: (patch) => options.savePrefs(patch),
      openOptions: () => setOptionsOpen(true),
      capture: (kind) => setCapture(kind),
      drawer: (k) => setDrawer(k),
      captureMenu: (on = true) => setCaptureMenu(on),
    };
    return () => {
      if (timer) clearInterval(timer);
      delete window.__infiniDemo;
    };
  }, [call, options.savePrefs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  // ── pieces ─────────────────────────────────────────────────────────────────
  const lines = state.transcript.slice(-30);
  const wakeOn = options.prefs.wake === true && !cloud;
  const wakeListening = (wake.listening || demoWake) && !micMuted;
  const showDebug = options.prefs.wakeDebug === true;
  const debugSnap = demoDebug || wake.debug;

  // Push-to-talk lives on the face itself: hold → listen, release → transcribe.
  const faceHoldStart = useCallback(() => {
    if (!gate.pushToTalk) {
      showToastRef.current?.({ text: 'The mic is muted. Unmute it to talk.', tone: 'warn', ms: 2600 });
      return;
    }
    pttHeld.current = true;
    void call.pttStart();
  }, [gate.pushToTalk, call]);
  const faceHoldEnd = useCallback(() => {
    if (!pttHeld.current) return;
    pttHeld.current = false;
    call.pttEnd();
  }, [call]);

  const faceEl = (
    <InfiniFace
      state={faceState}
      levelRef={call.levelRef}
      size={L.faceSize}
      reducedMotion={reduced}
      perkKey={perkKey}
      muted={micMuted}
      paused={animPaused}
      particles={budget.particles}
      rippleGrowth={rippleGrowth(L.face.room, L.faceSize)}
      swirl={swirlScale(L.face.room, L.faceSize)}
      onPress={onFaceTap}
      onLongPress={cloud ? () => setOptionsOpen(true) : undefined}
      onHoldStart={cloud ? undefined : faceHoldStart}
      onHoldEnd={cloud ? undefined : faceHoldEnd}
      accessibilityLabel={`InfiniBot. ${statusText(state, { targetLabel: options.label.title, micMuted })}`}
      accessibilityHint={cloud ? 'Tap to open the cloud console. Long-press for call options.' : 'Tap to talk, send, or interrupt. Hold to talk and release to send.'}
    />
  );

  const iconBtn = (Icon, label, onPress, testID, extra) => (
    <GlassButton onPress={onPress} reduced={reduced} tone="ghost" style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={label} testID={testID} {...extra}>
      <Icon size={20} color={GLASS.text} />
    </GlassButton>
  );

  const targetChip = (
    <GlassButton
      onPress={() => setOptionsOpen(true)}
      reduced={reduced}
      tone="ghost"
      style={landscape ? styles.chipLand : styles.chip}
      contentStyle={styles.chipInner}
      accessibilityRole="button"
      accessibilityLabel={`Talking to ${options.label.title}. Change call options`}
      testID="infini-target"
    >
      {cloud ? <CloudIcon size={16} color={GLASS.gold} /> : cliMode ? <TerminalIcon size={16} color={GLASS.gold} /> : <PulseDot color={connected ? '#46c28a' : '#e5675c'} active={connected && state.inCall} reduced={reduced} />}
      <View style={{ flexShrink: 1 }}>
        <Text style={[type.smallStrong, styles.chipTitle]} numberOfLines={1}>
          {cloud ? 'Cloud voice (Robovoice)' : options.label.title}
        </Text>
        <Text style={[type.caption, { color: GLASS.textMuted }]} numberOfLines={1}>
          {cloud ? 'Tap the face to open the console' : `${options.label.subtitle}${options.label.subtitle ? ' · ' : ''}Local voice`}
        </Text>
      </View>
    </GlassButton>
  );

  const wakeBadge = wakeOn || demoWake ? (
    <Pressable
      onPress={() => setOptionsOpen(true)}
      onLongPress={() => {
        haptic('medium');
        options.savePrefs({ wakeDebug: !showDebug });
      }}
      delayLongPress={450}
      hitSlop={{ top: 11, bottom: 11, left: 4, right: 4 }}
      style={[styles.wakeBadge, { borderColor: wakeListening ? 'rgba(111,216,255,0.55)' : micMuted ? 'rgba(242,163,155,0.5)' : GLASS.hairline }]}
      accessibilityRole="button"
      accessibilityLabel={
        micMuted
          ? 'Hey Infini is muted. Open call options'
          : wakeListening
            ? 'Hey Infini is listening. Open call options'
            : wake.permissionDenied
              ? 'Hey Infini needs microphone access'
              : 'Hey Infini is paused'
      }
      accessibilityHint="Long-press to show or hide wake diagnostics"
      testID="infini-wake-badge"
    >
      <PulseDot color={wakeListening ? '#6fd8ff' : micMuted ? '#f2a39b' : 'rgba(244,234,210,0.35)'} active={wakeListening} reduced={reduced} size={6} />
      {micMuted ? <MicOffIcon size={14} color="#f2a39b" strokeWidth={2} /> : <EarIcon size={14} color={wakeListening ? '#bfefff' : GLASS.textMuted} strokeWidth={2} />}
      <Text style={[type.caption, { color: micMuted ? '#f6c3bb' : wakeListening ? '#d8f5ff' : GLASS.textMuted }]} numberOfLines={1}>
        {micMuted ? 'Muted' : wake.permissionDenied ? 'Mic off' : wakeListening ? 'Hey Infini' : 'Paused'}
      </Text>
    </Pressable>
  ) : null;

  const mutedPhase = micMuted && ['idle', 'listening', 'starting'].includes(state.phase);
  const eyebrowEl = (
    <View style={[styles.eyebrow, landscape && styles.eyebrowLand]}>
      <PulseDot color={state.phase === 'error' || mutedPhase ? '#f2a39b' : state.phase === 'listening' ? '#46c28a' : GLASS.gold} active={!mutedPhase && ['listening', 'thinking', 'speaking', 'starting'].includes(state.phase)} reduced={reduced} size={6} />
      <Text style={[type.label, { color: mutedPhase ? '#f6c3bb' : GLASS.gold }]} testID="infini-phase">
        {mutedPhase ? 'Muted' : PHASE_LABEL[state.phase] || 'Ready'}
      </Text>
      {wakeBadge}
    </View>
  );

  const statusEl = (
    <Text
      style={[styles.status, { fontFamily: type.display.fontFamily }, landscape && styles.statusLand, { color: state.phase === 'error' ? '#f2a39b' : GLASS.text }]}
      numberOfLines={2}
      accessibilityLiveRegion="polite"
      testID="infini-status"
    >
      {cloud && !state.inCall ? 'Cloud voice is on — tap the face to start. Long-press to switch back to local voice.' : statusText(state, { targetLabel: options.label.title, handsFree: options.prefs.handsFree !== false, micMuted })}
    </Text>
  );

  const metaEl = (
    <View style={[styles.metaRow, landscape && styles.metaRowLand]}>
      {state.lastLatencyMs != null ? <Text style={[type.monoSmall, { color: GLASS.textMuted }]}>{(state.lastLatencyMs / 1000).toFixed(1)}s to first word</Text> : null}
      {state.tools.length ? <Text style={[type.monoSmall, { color: GLASS.textMuted }]} numberOfLines={1}>tools: {state.tools.slice(0, 3).join(', ')}</Text> : null}
      {queued ? (
        <Text style={[type.caption, { color: colors.warning }]} testID="infini-queued">
          {queued} capture{queued > 1 ? 's' : ''} waiting to sync
        </Text>
      ) : null}
      {!connected ? <Text style={[type.caption, { color: '#f2a39b' }]}>Gateway offline</Text> : null}
    </View>
  );

  const micBtnEl = (
    <GlassButton
      onPress={toggleMic}
      reduced={reduced}
      hapticKind={null}
      active={micMuted}
      style={[styles.round, micMuted && styles.mutedBtn]}
      accessibilityRole="switch"
      accessibilityState={{ checked: micMuted }}
      accessibilityLabel={micMuted ? 'Microphone muted. Tap to unmute' : 'Mute microphone'}
      testID="infini-mic-mute"
    >
      {micMuted ? <MicOffIcon size={21} color="#f6c3bb" /> : <MicIcon size={21} color={GLASS.goldHi} />}
    </GlassButton>
  );
  const speakerBtnEl = (size) => (
    <GlassButton
      onPress={toggleSpeaker}
      reduced={reduced}
      hapticKind={null}
      tone={size === 'small' ? 'ghost' : 'glass'}
      active={speakerMuted}
      style={[size === 'small' ? styles.iconBtn : styles.round, speakerMuted && styles.mutedBtn]}
      accessibilityRole="switch"
      accessibilityState={{ checked: speakerMuted }}
      accessibilityLabel={speakerMuted ? 'Voice replies muted. Tap to unmute' : 'Mute voice replies'}
      testID="infini-speaker-mute"
    >
      {speakerMuted ? <SpeakerOffIcon size={20} color="#f6c3bb" /> : <SpeakerIcon size={20} color={GLASS.text} />}
    </GlassButton>
  );
  const typeBtnEl = iconBtn(KeyboardIcon, 'Type a message', () => setTyping((v) => !v), 'infini-type', { active: typing, style: styles.round });
  const endBtnEl = state.inCall ? (
    <GlassButton onPress={() => void call.end()} reduced={reduced} tone="danger" hapticKind="medium" style={styles.round} accessibilityRole="button" accessibilityLabel="End call" testID="infini-end">
      <PhoneOffIcon size={20} color="#fff" />
    </GlassButton>
  ) : null;
  const transcriptBtn = (
    <GlassButton
      onPress={() => toggleDrawer('transcript')}
      reduced={reduced}
      active={drawer === 'transcript'}
      style={styles.round}
      accessibilityRole="button"
      accessibilityState={{ expanded: drawer === 'transcript' }}
      accessibilityLabel={`Transcript, ${drawer === 'transcript' ? 'close' : 'open'}`}
      testID="infini-transcript-toggle"
    >
      <ChatLinesIcon size={20} color={GLASS.goldHi} />
      {lines.length ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{lines.length}</Text>
        </View>
      ) : null}
    </GlassButton>
  );
  const terminalBtn = cliMode ? (
    <GlassButton
      onPress={() => toggleDrawer('terminal')}
      reduced={reduced}
      active={drawer === 'terminal'}
      style={styles.round}
      accessibilityRole="button"
      accessibilityState={{ expanded: drawer === 'terminal' }}
      accessibilityLabel={`Terminal, ${drawer === 'terminal' ? 'close' : 'open'}`}
      testID="infini-terminal-toggle"
    >
      <TerminalIcon size={20} color={GLASS.goldHi} />
    </GlassButton>
  ) : null;

  const typingEl = (rect) =>
    typing ? (
      <View style={[styles.typeRow, rect]}>
        <TextInput
          value={typed}
          onChangeText={setTyped}
          placeholder={`Message ${options.label.title}…`}
          placeholderTextColor={withAlpha(GLASS.text, 0.4)}
          style={[type.body, { flex: 1, color: GLASS.text, minHeight: 44 }]}
          onSubmitEditing={() => {
            void call.sendText(typed);
            setTyped('');
          }}
          returnKeyType="send"
          accessibilityLabel="Message"
          autoFocus
          testID="infini-typed"
        />
      </View>
    ) : null;

  const captureOrb = (
    <CaptureOrb
      layout={L}
      kinds={CAPTURE_KINDS}
      open={captureMenu}
      onToggle={() => setCaptureMenu((v) => !v)}
      onClose={() => setCaptureMenu(false)}
      onPick={openCapture}
      reduced={reduced}
      textStyle={type.smallStrong}
      width={width}
      height={height}
    />
  );

  const transcriptBody = lines.length ? (
    lines.map((l) => (
      <View
        key={l.id}
        style={[
          styles.bubble,
          l.who === 'you'
            ? { alignSelf: 'flex-end', backgroundColor: withAlpha(GLASS.gold, 0.14), borderColor: withAlpha(GLASS.gold, 0.35) }
            : l.who === 'system'
              ? { alignSelf: 'center', backgroundColor: 'transparent', borderColor: 'transparent' }
              : { alignSelf: 'flex-start', backgroundColor: withAlpha('#ffffff', 0.05), borderColor: withAlpha('#ffffff', 0.08) },
        ]}
      >
        <Text style={[l.who === 'system' ? type.caption : type.small, { color: l.who === 'system' ? GLASS.textMuted : GLASS.text, opacity: l.final ? 1 : 0.8 }]}>{l.text}</Text>
      </View>
    ))
  ) : (
    <Text style={[type.small, { color: GLASS.textMuted }]}>What you say and what InfiniBot answers shows up here.</Text>
  );

  const terminalBody = (
    <Text style={[type.monoSmall, { color: '#d8d2c2' }]} selectable>
      {terminalText || 'Waiting for output…'}
    </Text>
  );

  const toastW = landscape ? Math.min(520, width - L.safe.left * 2 - 96) : null;
  const toastEl = toast ? (
    <Animated.View
      style={[
        styles.toast,
        landscape ? { left: (width - toastW) / 2, right: undefined, width: toastW } : null,
        {
          bottom: insets.bottom + SPACE.xl,
          opacity: toastAnim,
          transform: [{ translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
          borderColor: toast.tone === 'warn' ? withAlpha('#f5a524', 0.6) : withAlpha('#3fb27f', 0.6),
        },
      ]}
      accessibilityLiveRegion="polite"
      testID="infini-toast"
    >
      <Text style={[type.small, { color: GLASS.text, flex: 1 }]}>{toast.text}</Text>
      {toast.action ? (
        <Pressable onPress={toast.action.go} style={styles.toastBtn} accessibilityRole="link" accessibilityLabel="Open the saved item">
          <Text style={[type.smallStrong, { color: colors.primary }]}>{toast.action.label}</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  ) : null;

  const sheets = (
    <>
      <CallOptionsSheet
        visible={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        options={options}
        wake={wake}
        onOpenCloudConsole={() => {
          setOptionsOpen(false);
          openCloudConsole();
        }}
      />
      <CaptureSheet kind={capture || 'note'} visible={!!capture} onClose={() => setCapture(null)} gateway={gateway} queue={queue} projects={projects} onSaved={onSaved} />
    </>
  );

  const panelHead = (Icon, title, onClose, closeLabel) => (
    <View style={styles.drawerHead}>
      <Icon size={16} color={GLASS.gold} />
      <Text style={[type.label, { color: GLASS.gold, flex: 1 }]} numberOfLines={1}>
        {title}
      </Text>
      <Pressable onPress={onClose} style={styles.iconHit} accessibilityRole="button" accessibilityLabel={closeLabel}>
        <CloseIcon size={18} color={GLASS.textMuted} />
      </Pressable>
    </View>
  );

  // Panels: side drawers in landscape, bottom sheets in portrait.
  const panel = (k, testID, children) => {
    const open = drawer === k;
    const a = drawerAnim[k];
    let geo;
    if (landscape) {
      const left = k === 'transcript';
      const d = left ? L.transcriptDrawer : L.terminalPanel;
      geo = [
        left ? styles.drawerLeft : styles.drawerRight,
        {
          width: d.width,
          paddingLeft: left ? d.padLeft : 0,
          paddingRight: left ? 0 : d.padRight,
          paddingTop: L.safe.top,
          paddingBottom: height - L.safe.bottom,
          transform: [{ translateX: a.interpolate({ inputRange: [0, 1], outputRange: [left ? -d.width : d.width, 0] }) }],
        },
      ];
    } else {
      geo = [
        styles.sheetBottom,
        { height: L.sheetHeight + insets.bottom, paddingBottom: insets.bottom, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [L.sheetHeight + insets.bottom, 0] }) }] },
      ];
    }
    return (
      <Animated.View
        pointerEvents={open ? 'auto' : 'none'}
        style={[styles.drawer, ...geo, { opacity: a }]}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
        testID={testID}
      >
        {children}
      </Animated.View>
    );
  };

  const panels = (
    <>
      {panel(
        'transcript',
        'infini-transcript',
        <>
          {panelHead(ChatLinesIcon, 'Transcript', () => setDrawer(null), 'Close transcript')}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.drawerBody}>
            {transcriptBody}
          </ScrollView>
        </>,
      )}
      {cliMode
        ? panel(
            'terminal',
            'infini-terminal',
            <>
              {panelHead(TerminalIcon, `Terminal · ${options.label.title}`, () => setDrawer(null), 'Close terminal')}
              <ScrollView style={[styles.term, styles.termPanel]} nestedScrollEnabled>
                {terminalBody}
              </ScrollView>
            </>,
          )
        : null}
    </>
  );

  // ── layout ─────────────────────────────────────────────────────────────────
  const backdrop = <InfiniBackdrop width={width} height={height} cx={L.face.cx} cy={L.face.cy} faceSize={L.faceSize} clear={landscape ? [L.leftRail] : [L.header, L.info]} reduced={reduced} paused={animPaused} motion={budget.auroraMotion} lite={budget.backdropLite} mood={faceState} />;
  const mutedBadgeSize = Math.max(44, Math.round(L.faceSize * 0.16));
  const stage = (
    <View style={{ position: 'absolute', left: L.face.left, top: L.face.top, width: L.faceSize, height: L.faceSize }} testID="infini-stage">
      {faceEl}
      {micMuted ? (
        <Pressable
          onPress={toggleMic}
          style={[
            styles.faceMuted,
            { width: mutedBadgeSize, height: mutedBadgeSize, borderRadius: mutedBadgeSize / 2, left: L.faceSize * 0.82 - mutedBadgeSize / 2, top: L.faceSize * 0.82 - mutedBadgeSize / 2 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Microphone muted. Tap to unmute"
          testID="infini-face-muted"
        >
          <MicOffIcon size={Math.round(mutedBadgeSize * 0.48)} color="#f6c3bb" strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  );
  const debugPanel = showDebug ? (
    <WakeDebugPanel
      snap={debugSnap}
      wakeState={wake.state}
      enabled={wakeOn}
      micMuted={micMuted}
      tier={wake.tier}
      sensitivity={options.prefs.wakeSensitivity}
      onClose={() => options.savePrefs({ wakeDebug: false })}
      style={
        landscape
          ? { position: 'absolute', left: L.face.left + L.faceSize * 0.08, width: L.faceSize * 0.84, top: L.safe.top + 4 }
          : { position: 'absolute', left: L.header.left, width: L.header.width, top: L.header.top + L.header.height + 6 }
      }
    />
  ) : null;

  if (landscape) {
    const lr = L.leftRail;
    const rr = L.rightRail;
    return (
      <View style={styles.root} onLayout={onRootLayout} testID="infini-call-screen" dataSet={{ orientation: 'landscape' }}>
        {backdrop}
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <Animated.View style={{ flex: 1, opacity: fade }}>
            {stage}

            {/* Left rail: close / options, who, status, talk controls */}
            <View style={[styles.rail, { left: lr.left, top: lr.top, width: lr.width, height: lr.height }]} testID="infini-left-rail">
              <View style={styles.railRow}>
                {iconBtn(CloseIcon, 'Close', () => navigation.goBack(), 'infini-close')}
                {iconBtn(SlidersIcon, 'Call options', () => setOptionsOpen(true), 'infini-options')}
                {speakerBtnEl('small')}
              </View>
              {targetChip}
              <View style={styles.railInfo}>
                {eyebrowEl}
                {statusEl}
                {metaEl}
                {typingEl(styles.typeRowLand)}
              </View>
              <View style={styles.railRow}>
                {micBtnEl}
                {typeBtnEl}
                {endBtnEl}
              </View>
            </View>

            {/* Right rail: panels on top, the quick-capture orb at the bottom */}
            <View style={[styles.railRow, styles.railTopRight, { left: L.railTop.left, top: L.railTop.top, width: L.railTop.width }]}>
              {transcriptBtn}
              {terminalBtn}
            </View>
            {debugPanel}
            {captureOrb}
          </Animated.View>
        </KeyboardAvoidingView>

        {panels}
        {toastEl}
        {sheets}
      </View>
    );
  }

  // ── portrait ───────────────────────────────────────────────────────────────
  const hd = L.header;
  return (
    <View style={styles.root} onLayout={onRootLayout} testID="infini-call-screen" dataSet={{ orientation: 'portrait' }}>
      {backdrop}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Animated.View style={{ flex: 1, opacity: fade }}>
          {stage}

          <View style={[styles.header, { left: hd.left, top: hd.top, width: hd.width, height: hd.height }]} testID="infini-header">
            {iconBtn(CloseIcon, 'Close', () => navigation.goBack(), 'infini-close')}
            {targetChip}
            {terminalBtn}
            {speakerBtnEl('small')}
            {iconBtn(SlidersIcon, 'Call options', () => setOptionsOpen(true), 'infini-options')}
          </View>

          {typing ? (
            typingEl({ position: 'absolute', left: L.info.left, top: L.info.top + L.info.height - 52, width: L.info.width, height: 52 })
          ) : (
            <View style={[styles.info, { left: L.info.left, top: L.info.top, width: L.info.width, height: L.info.height }]} testID="infini-info">
              {eyebrowEl}
              {statusEl}
              {metaEl}
            </View>
          )}

          <View style={[styles.talk, { left: L.talk.left, top: L.talk.top, width: L.talk.width, height: L.talk.height }]} testID="infini-talk">
            <View style={{ position: 'absolute', left: L.dock.transcript.left - L.talk.left, top: L.dock.transcript.top - L.talk.top }}>{transcriptBtn}</View>
            {micBtnEl}
            {typeBtnEl}
            {endBtnEl}
          </View>
          {debugPanel}
          {captureOrb}
        </Animated.View>
      </KeyboardAvoidingView>

      {drawer ? <Pressable style={StyleSheet.absoluteFill} onPress={() => setDrawer(null)} accessibilityLabel="Close panel" /> : null}
      {panels}
      {toastEl}
      {sheets}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  header: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconBtn: { width: 44, height: 44 },
  iconHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  round: { width: 52, height: 52 },
  chip: { flex: 1, height: 44 },
  chipLand: { alignSelf: 'stretch', height: 48 },
  chipInner: { justifyContent: 'flex-start', gap: SPACE.sm, paddingHorizontal: SPACE.md },
  chipTitle: { color: GLASS.text, letterSpacing: 0.1 },
  info: { position: 'absolute', alignItems: 'center', justifyContent: 'flex-start', gap: SPACE.xs },
  eyebrow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.sm, minHeight: 22 },
  eyebrowLand: { justifyContent: 'flex-start', flexWrap: 'wrap' },
  wakeBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 22, paddingHorizontal: SPACE.sm, borderRadius: RADIUS.pill, borderWidth: 1, backgroundColor: 'rgba(10,20,26,0.55)', marginLeft: SPACE.xs },
  status: { textAlign: 'center', fontSize: 18, lineHeight: 23, letterSpacing: -0.2, paddingHorizontal: SPACE.lg },
  statusLand: { textAlign: 'left', fontSize: 17, lineHeight: 22, paddingHorizontal: 0 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.md, justifyContent: 'center', minHeight: 16 },
  metaRowLand: { justifyContent: 'flex-start' },
  talk: { position: 'absolute', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.md },
  mutedBtn: { borderColor: 'rgba(242,163,155,0.6)' },
  faceMuted: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(40,14,10,0.88)',
    borderWidth: 1,
    borderColor: 'rgba(242,163,155,0.65)',
  },
  typeRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: GLASS.hairline, borderRadius: RADIUS.lg, paddingHorizontal: SPACE.md, backgroundColor: 'rgba(12,10,6,0.8)' },
  typeRowLand: { alignSelf: 'stretch', marginTop: SPACE.xs },
  badge: { position: 'absolute', top: 5, right: 5, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center', backgroundColor: GLASS.gold },
  badgeText: { fontSize: 10, fontWeight: '700', color: '#120e07' },
  bubble: { maxWidth: '88%', paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.lg, borderWidth: 1 },
  term: { backgroundColor: '#050505', borderRadius: RADIUS.md, padding: SPACE.sm },
  termPanel: { flex: 1, marginHorizontal: SPACE.md, marginBottom: SPACE.sm },
  toast: {
    position: 'absolute',
    left: SPACE.lg,
    right: SPACE.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.md,
    padding: SPACE.md,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    backgroundColor: 'rgba(14,12,8,0.96)',
  },
  toastBtn: { minHeight: 44, minWidth: 56, alignItems: 'center', justifyContent: 'center' },
  // landscape rails
  rail: { position: 'absolute', gap: SPACE.sm },
  railRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  railTopRight: { position: 'absolute', justifyContent: 'flex-end', height: 44 },
  railInfo: { flex: 1, justifyContent: 'center', gap: SPACE.xs },
  // panels
  drawer: { position: 'absolute', backgroundColor: 'rgba(10,8,5,0.97)', borderColor: GLASS.hairline },
  drawerLeft: { left: 0, top: 0, bottom: 0, borderRightWidth: 1, borderTopRightRadius: RADIUS.xl, borderBottomRightRadius: RADIUS.xl },
  drawerRight: { right: 0, top: 0, bottom: 0, borderLeftWidth: 1, borderTopLeftRadius: RADIUS.xl, borderBottomLeftRadius: RADIUS.xl },
  sheetBottom: { left: 0, right: 0, bottom: 0, borderTopWidth: 1, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl, paddingTop: SPACE.xs },
  drawerHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 48, paddingLeft: SPACE.lg, paddingRight: SPACE.xs },
  drawerBody: { paddingHorizontal: SPACE.lg, paddingBottom: SPACE.md, gap: SPACE.sm },
});

export default InfiniCallScreen;
