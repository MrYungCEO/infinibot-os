/**
 * AgencyWorldView — 2D animated world of the agent mesh.
 *
 * Renders a WebView with the self-contained Canvas2D engine, polls the
 * gateway for federation/sessions/subagents, and pushes a normalized
 * `{nodes, agents, tasks}` snapshot to the engine every refresh tick.
 *
 * Agent taps in the world post back through onMessage and surface as
 * `onAgentSelect(sessionKey)` to the parent screen.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { AGENCY_WORLD_HTML } from './world-html';
import {
  LOCAL_NODE_ID,
  WORLD_CAMERA_EVENT,
  buildCameraMessage,
  buildZoomMessage,
  diffToWorldEvents,
  normalizeStatus,
} from './world-bridge';
import { getDeviceId, getMirrorCameraFromWeb } from '../../utils/storage';

// Optional haptics: only used if expo-haptics is installed. We require it
// lazily/defensively so the bundle never hard-fails when the dep is absent.
let Haptics = null;
try {
  // eslint-disable-next-line global-require
  Haptics = require('expo-haptics');
} catch (e) {
  Haptics = null;
}
function selectionHaptic() {
  if (!Haptics || typeof Haptics.selectionAsync !== 'function') return;
  try {
    const r = Haptics.selectionAsync();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (e) {
    // no-op
  }
}

const FALLBACK_LOCAL_NODE = {
  id: LOCAL_NODE_ID,
  name: 'Local',
  role: 'hub',
  status: 'online',
  agentCount: 0,
};

// Operator-facing display-name overrides for federation node ids. Until the
// gateway-side `pairedByNodeId` overlay in federation.nodes.list is rebuilt +
// reloaded, the raw manifest name comes through (often the satellite's
// hostname). This map renames specific ids on the fly. Mirror it in
// ui/src/ui/controllers/agency-data-bridge.ts so desktop + mobile match.
const NODE_NAME_OVERRIDES = {
  node_mqdb1ava_dteulu: 'ceo-dev',
};

function inferAgentId(key) {
  if (!key) return 'sub';
  const parts = String(key).split(':');
  return parts[1] || 'sub';
}

export function AgencyWorldView({ gateway, navigation, onAgentSelect, onNodeSelect }) {
  const webviewRef = useRef(null);
  const webviewReadyRef = useRef(false);
  const lastSyncRef = useRef(0);
  const taskIdsSentRef = useRef(new Set());
  const prevSnapshotRef = useRef(null); // baseline for diffToWorldEvents
  const baselineSentRef = useRef(false); // full {type:'sync'} posted once?
  const [, setTick] = useState(0); // triggers re-poll
  const [crashed, setCrashed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [webviewKey, setWebviewKey] = useState(0); // bump to remount on reload
  const insets = useSafeAreaInsets(); // notch + home-indicator safe areas

  // ── Auto-director ("AUTO" pill) — on by default, mirrors desktop. When the
  // user turns it off, the embed makes no automatic camera moves. ──
  const [autoDirector, setAutoDirector] = useState(true);
  const autoDirectorRef = useRef(true); // latest value for the ready handler
  // ── "Mirror camera from web" toggle, surfaced as a corner pill so the user
  // can flip it without leaving the screen (also persisted in Settings). ──
  const [mirrorOn, setMirrorOn] = useState(true);

  // ── Cross-device camera mirror (web → mobile) ──
  const mirrorEnabledRef = useRef(true); // "Mirror camera from web" setting (default ON)
  const ownPublisherIdRef = useRef(null); // this device's id, to ignore self-echo
  const [followingWeb, setFollowingWeb] = useState(false); // drives the "← following web" pill
  const followPillTimer = useRef(null);
  const followPillAnim = useRef(new Animated.Value(0)).current;

  // ── Polling: pull federation + sessions + subagents every 3s ──
  const pollOnce = useCallback(async () => {
    if (!gateway?.sendReq) return null;
    const [fedRes, sessRes, subRes, taskRes] = await Promise.allSettled([
      // federation.nodes.list returns the unified {nodes:[{id,name,status,role,
      // isLocal,...}]} roster from both master and satellite perspectives,
      // which is what the engine needs to render islands. (The older
      // federation.status RPC returns either {role,connected,nodes}— with no
      // hub/satellites fields — or just {role,state}; the old poll's
      // `fed.hub` / `fed.satellites` reads were always undefined, so
      // satellites never made it to the engine.)
      gateway.sendReq('federation.nodes.list', {}),
      gateway.sendReq('sessions.list', {
        includeGlobal: false,
        includeDerivedTitles: true,
        includeFederated: true,
        limit: 100,
      }),
      gateway.sendReq('subagents.list', {
        includeCompleted: false,
        compact: true,
        limit: 100,
      }),
      gateway.sendReq('kanban.tasks.list', {
        filter_status: 'in_progress',
        limit: 20,
      }),
    ]);

    // ── Nodes ──
    // Map the federation roster into the engine's MeshNode shape. The local
    // node is always first (hub when we're master, satellite when we're a
    // peer), then every connected satellite/peer, then any remote master.
    const nodes = [];
    const fed = fedRes.status === 'fulfilled' ? fedRes.value || {} : {};
    const fedRoster = Array.isArray(fed.nodes) ? fed.nodes : null;
    if (fedRoster && fedRoster.length > 0) {
      // Sort so the local node arrives first — the engine's addNode treats
      // the FIRST hub/local arrival as the agent-quarters owner; everything
      // after it goes onto an orbital pod with a light bridge.
      const sorted = fedRoster.slice().sort((a, b) => (b?.isLocal ? 1 : 0) - (a?.isLocal ? 1 : 0));
      sorted.forEach((n) => {
        if (!n || typeof n.id !== 'string') return;
        // Engine roles: 'hub' | 'satellite' | 'local'. Mobile always treats
        // *this device* as the hub of its map view (agent quarters wing);
        // every other federation peer — including a remote master when
        // mobile is a satellite — lands as a 'satellite' island.
        const role = n.isLocal ? 'hub' : 'satellite';
        // Engine status: 'online' | 'offline' | 'connecting'. Gateway uses
        // 'registered' for connected satellites; normalise.
        const rawStatus = typeof n.status === 'string' ? n.status : 'online';
        const status =
          rawStatus === 'online' || rawStatus === 'registered'
            ? 'online'
            : rawStatus === 'offline' || rawStatus === 'disconnected'
              ? 'offline'
              : 'connecting';
        nodes.push({
          id: n.id,
          name: NODE_NAME_OVERRIDES[n.id] || n.name || n.id,
          role,
          status,
          agentCount: 0,
        });
      });
    } else {
      // Standalone or RPC failed — at least show this device.
      nodes.push(FALLBACK_LOCAL_NODE);
    }

    // ── Subagents → primary source for activity-driven rendering ──
    const subs = subRes.status === 'fulfilled'
      ? Array.isArray(subRes.value?.subagents) ? subRes.value.subagents
        : Array.isArray(subRes.value?.items) ? subRes.value.items
        : Array.isArray(subRes.value) ? subRes.value : []
      : [];
    const subByKey = new Map();
    subs.forEach((sa) => {
      const key = sa.sessionKey || sa.childSessionKey || sa.runId;
      if (key) subByKey.set(key, sa);
    });

    // ── Sessions (merge with subagents) ──
    const sessRows = sessRes.status === 'fulfilled'
      ? (sessRes.value?.sessions || sessRes.value?.rows || [])
      : [];
    const agents = [];
    const nodeCount = new Map();
    sessRows.forEach((row) => {
      const isSub = row.kind === 'subagent' || (row.key || '').includes(':subagent:');
      if (!isSub && row.kind !== 'main') return;
      const key = row.key || row.sessionKey;
      const nodeId = row.nodeId || LOCAL_NODE_ID;
      const sa = subByKey.get(key);
      const status = normalizeStatus(sa?.status, row.active);
      const la = sa?.lastActivity || null;
      agents.push({
        sessionKey: key,
        agentId: inferAgentId(key),
        label: row.label || row.derivedTitle || sa?.label || key,
        nodeId,
        status,
        progress: Number(sa?.progress ?? row.progress ?? 0),
        currentTask: sa?.task || row.currentTask || row.derivedTitle,
        lastActivity: la ? { kind: la.kind, label: la.label, at: la.at } : undefined,
      });
      nodeCount.set(nodeId, (nodeCount.get(nodeId) || 0) + 1);
    });
    // Surface subagents missing from sessions
    subs.forEach((sa) => {
      const key = sa.sessionKey || sa.childSessionKey || sa.runId;
      if (!key) return;
      if (agents.find((a) => a.sessionKey === key)) return;
      const nodeId = sa.nodeId || LOCAL_NODE_ID;
      const la = sa.lastActivity || null;
      agents.push({
        sessionKey: key,
        agentId: sa.agentId || inferAgentId(key),
        label: sa.label || key,
        nodeId,
        status: normalizeStatus(sa.status, true),
        progress: Number(sa.progress || 0),
        currentTask: sa.task,
        lastActivity: la ? { kind: la.kind, label: la.label, at: la.at } : undefined,
      });
      nodeCount.set(nodeId, (nodeCount.get(nodeId) || 0) + 1);
    });
    nodes.forEach((n) => { n.agentCount = nodeCount.get(n.id) || 0; });

    // ── Tasks (new ones only — engine has its own dedupe but we also cap) ──
    const tasksRaw = taskRes.status === 'fulfilled'
      ? (taskRes.value?.tasks || []) : [];
    const tasks = tasksRaw
      .filter((t) => t && t.id && !taskIdsSentRef.current.has(t.id))
      .slice(0, 6)
      .map((t) => ({ id: t.id, title: t.title, nodeId: t.nodeId || LOCAL_NODE_ID }));
    tasks.forEach((t) => taskIdsSentRef.current.add(t.id));
    if (taskIdsSentRef.current.size > 200) taskIdsSentRef.current = new Set();

    return { type: 'sync', nodes, agents, tasks };
  }, [gateway]);

  // Post a snapshot to the engine. The FIRST post (or any post after a
  // reload/crash) is a full {type:'sync'} baseline; subsequent posts are
  // incremental {type:'events'} computed by diffing against the prior snapshot.
  // Returns true if anything was posted.
  const postSnapshot = useCallback((snap) => {
    if (!snap) return false;
    const wv = webviewRef.current;
    if (!webviewReadyRef.current || !wv) return false;
    if (!baselineSentRef.current) {
      wv.postMessage(JSON.stringify(snap));
      baselineSentRef.current = true;
      prevSnapshotRef.current = snap;
      lastSyncRef.current = Date.now();
      return true;
    }
    const events = diffToWorldEvents(prevSnapshotRef.current, snap);
    prevSnapshotRef.current = snap;
    if (events.length === 0) return false;
    wv.postMessage(JSON.stringify({ type: 'events', events }));
    lastSyncRef.current = Date.now();
    return true;
  }, []);

  // Polling loop
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const run = async () => {
      try {
        const snap = await pollOnce();
        if (cancelled || !snap) return;
        postSnapshot(snap);
      } catch (e) {
        // swallow — next tick will retry
      } finally {
        if (!cancelled) timer = setTimeout(run, 3000);
      }
    };
    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollOnce, postSnapshot]);

  // Force initial WebView render once
  useEffect(() => {
    const t = setTimeout(() => setTick((x) => x + 1), 350);
    return () => clearTimeout(t);
  }, []);

  // Post an arbitrary command string to the embed engine (no-op until ready).
  const postToWebView = useCallback((str) => {
    const wv = webviewRef.current;
    if (!webviewReadyRef.current || !wv) return;
    wv.postMessage(str);
  }, []);

  // On-screen zoom controls (+ / − / fit). Pinch + drag are handled natively
  // inside the embed's pixi-viewport; these mirror the web's button cluster.
  const onZoom = useCallback((action) => {
    selectionHaptic();
    postToWebView(buildZoomMessage(action));
  }, [postToWebView]);

  // Auto-director ("AUTO" pill). Tells the embed whether it may steer the
  // camera on its own (fit-to-content, spawn pulse, tap-to-fly). Pushed to the
  // engine on every toggle and re-asserted once the engine reports ready.
  const pushAutoDirector = useCallback((on) => {
    postToWebView(JSON.stringify({ type: 'autoDirector', on: !!on }));
  }, [postToWebView]);
  const toggleAutoDirector = useCallback(() => {
    selectionHaptic();
    setAutoDirector((prev) => {
      const next = !prev;
      autoDirectorRef.current = next;
      pushAutoDirector(next);
      return next;
    });
  }, [pushAutoDirector]);

  // "Mirror from web" pill — flips the live cross-device camera follow. Keeps
  // the ref (read by the world.camera subscription) and the persisted setting
  // in sync so the change survives a screen blur/restore.
  const toggleMirror = useCallback(() => {
    selectionHaptic();
    setMirrorOn((prev) => {
      const next = !prev;
      mirrorEnabledRef.current = next;
      try {
        // setMirrorCameraFromWeb is optional — persist if storage exposes it.
        // eslint-disable-next-line global-require
        const storage = require('../../utils/storage');
        if (typeof storage.setMirrorCameraFromWeb === 'function') {
          const r = storage.setMirrorCameraFromWeb(next);
          if (r && typeof r.catch === 'function') r.catch(() => {});
        }
      } catch {}
      return next;
    });
  }, []);

  // Flash the "← following web" pill for ~1.5s so the user understands why the
  // view just moved on its own.
  const flashFollowingPill = useCallback(() => {
    if (followPillTimer.current) clearTimeout(followPillTimer.current);
    setFollowingWeb(true);
    Animated.timing(followPillAnim, {
      toValue: 1,
      duration: 160,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
    followPillTimer.current = setTimeout(() => {
      Animated.timing(followPillAnim, {
        toValue: 0,
        duration: 240,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start(() => setFollowingWeb(false));
    }, 1500);
  }, [followPillAnim]);

  // Load the persisted "mirror" setting + this device's id once, and re-read
  // the setting whenever the screen regains focus (so a Settings toggle takes
  // effect without an app restart).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [enabled, devId] = await Promise.all([
          getMirrorCameraFromWeb(),
          getDeviceId(),
        ]);
        if (!alive) return;
        mirrorEnabledRef.current = enabled !== false;
        setMirrorOn(enabled !== false);
        ownPublisherIdRef.current = devId ? `mobile-${devId}` : null;
      } catch {}
    })();
    const unsubFocus =
      navigation && typeof navigation.addListener === 'function'
        ? navigation.addListener('focus', async () => {
            try {
              const enabled = await getMirrorCameraFromWeb();
              mirrorEnabledRef.current = enabled !== false;
            } catch {}
          })
        : null;
    return () => {
      alive = false;
      if (unsubFocus) unsubFocus();
      if (followPillTimer.current) clearTimeout(followPillTimer.current);
    };
  }, [navigation]);

  // Subscribe to the gateway `world.camera` topic. When the web UI (or its
  // auto-fit) moves the camera, mirror it onto our WebView engine — unless the
  // setting is off or the beat is our own echo.
  useEffect(() => {
    if (!gateway?.subscribeEvent) return undefined;
    const unsub = gateway.subscribeEvent(WORLD_CAMERA_EVENT, (payload) => {
      if (!mirrorEnabledRef.current) return;
      const p = payload || {};
      if (p.publisherId && p.publisherId === ownPublisherIdRef.current) return; // self-echo
      if (
        typeof p.zoom !== 'number' ||
        typeof p.centerX !== 'number' ||
        typeof p.centerY !== 'number'
      ) {
        return;
      }
      postToWebView(buildCameraMessage(p.zoom, p.centerX, p.centerY, p.easeMs));
      flashFollowingPill();
    });
    return unsub;
  }, [gateway, postToWebView, flashFollowingPill]);

  const onMessage = useCallback((evt) => {
    let payload;
    try { payload = JSON.parse(evt?.nativeEvent?.data || '{}'); } catch { return; }
    if (!payload?.type) return;
    if (payload.type === 'ready') {
      // PixiJS engine has finished booting and its message listener is wired.
      // Until this fires we must NOT post — early sync baselines get dropped
      // (no listener yet), and subsequent polls only emit diffs, so satellite
      // nodes never appear in the engine. See world-html.bundled.js source.
      webviewReadyRef.current = true;
      baselineSentRef.current = false;
      setLoading(false);
      // Re-assert the AUTO-director state to the freshly-booted engine (a crash
      // reload resets the embed's default back to ON).
      pushAutoDirector(autoDirectorRef.current);
      // Prime a fresh baseline now that the engine can receive it.
      (async () => {
        try {
          const snap = await pollOnce();
          if (snap) postSnapshot(snap);
        } catch {}
      })();
      return;
    }
    if (payload.type === 'agentTap' && payload.sessionKey) {
      selectionHaptic();
      // Forward sleeping/idle taps too — the host opens the agent sheet
      // regardless of `isActive` (fix #3/#4).
      if (onAgentSelect) {
        onAgentSelect(payload.sessionKey, {
          isActive: payload.isActive !== false,
          agentId: payload.agentId,
        });
      }
    } else if (payload.type === 'nodeTap' && payload.nodeId) {
      selectionHaptic();
      if (onNodeSelect) onNodeSelect(payload.nodeId);
    }
  }, [onAgentSelect, onNodeSelect, pollOnce, postSnapshot, pushAutoDirector]);

  // WebView readiness + crash recovery. A reload (key bump) means the engine
  // is empty again, so the next post must be a full {type:'sync'} baseline.
  // We DON'T flip webviewReadyRef here — the embed's PixiJS engine bootstraps
  // asynchronously and posts {type:'ready'} when its message listener is
  // attached. Posting before that drops messages (and the satellite islands
  // along with them, since subsequent polls only emit diffs). onMessage
  // handles the ready signal.
  const handleLoadEnd = useCallback(() => {
    // Don't set webviewReadyRef here — wait for the embed's 'ready' message.
  }, []);
  const handleError = useCallback(() => {
    webviewReadyRef.current = false;
    setCrashed(true);
  }, []);
  const reloadEngine = useCallback(() => {
    webviewReadyRef.current = false;
    baselineSentRef.current = false;
    prevSnapshotRef.current = null;
    taskIdsSentRef.current = new Set();
    setCrashed(false);
    // Prefer imperative reload; fall back to remount via key bump.
    if (webviewRef.current && typeof webviewRef.current.reload === 'function') {
      try { webviewRef.current.reload(); return; } catch (e) {}
    }
    setWebviewKey((k) => k + 1);
  }, []);

  // Spinning animation for the loading spinner
  const spinAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!loading) return;
    const anim = Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 700,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    anim.start();
    return () => anim.stop();
  }, [loading, spinAnim]);
  const spinInterp = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const source = useMemo(() => ({ html: AGENCY_WORLD_HTML, baseUrl: '' }), []);

  return (
    <View style={styles.container}>
      <WebView
        key={webviewKey}
        ref={webviewRef}
        source={source}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
        startInLoadingState={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        onLoadEnd={handleLoadEnd}
        onMessage={onMessage}
        onError={handleError}
        onHttpError={handleError}
        onRenderProcessGone={handleError}
        onContentProcessDidTerminate={handleError}
        style={styles.webview}
        containerStyle={styles.webviewContainer}
      />
      {/* "← following web" pill — flashes when a mirrored camera beat arrives. */}
      {followingWeb ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.followPill,
            { top: 12 + insets.top },
            {
              opacity: followPillAnim,
              transform: [
                {
                  translateY: followPillAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-8, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <Text style={styles.followPillText}>← following web</Text>
        </Animated.View>
      ) : null}

      {/*
        Single corner control cluster (bottom-right), safe-area aware so it
        never sits under the home indicator. `box-none` lets taps that miss a
        button fall through to the world so agents stay tappable even where the
        controls float. Stacked vertically so it never overflows a narrow phone.
        Top → bottom: AUTO pill · mirror toggle · zoom in · zoom out · fit.
      */}
      {!loading && !crashed ? (
        <View
          style={[
            styles.controlCluster,
            { bottom: 18 + insets.bottom, right: 12 + insets.right },
          ]}
          pointerEvents="box-none"
        >
          <TouchableOpacity
            style={[styles.pillBtn, autoDirector ? styles.pillBtnOn : styles.pillBtnOff]}
            onPress={toggleAutoDirector}
            activeOpacity={0.75}
            hitSlop={6}
          >
            <Text style={[styles.pillText, autoDirector ? styles.pillTextOn : styles.pillTextOff]}>
              AUTO
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.pillBtn, mirrorOn ? styles.pillBtnOn : styles.pillBtnOff]}
            onPress={toggleMirror}
            activeOpacity={0.75}
            hitSlop={6}
          >
            <Text style={[styles.pillText, mirrorOn ? styles.pillTextOn : styles.pillTextOff]}>
              {mirrorOn ? '⇄ WEB' : '⇄ OFF'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.zoomBtn} onPress={() => onZoom('in')} activeOpacity={0.7}>
            <Text style={styles.zoomBtnText}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.zoomBtn} onPress={() => onZoom('out')} activeOpacity={0.7}>
            <Text style={styles.zoomBtnText}>−</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.zoomBtn} onPress={() => onZoom('fit')} activeOpacity={0.7}>
            <Text style={styles.zoomBtnFitText}>⊡</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {loading && !crashed ? (
        <View style={styles.loadingOverlay}>
          <Animated.View style={[styles.loadingSpinner, { transform: [{ rotate: spinInterp }] }]} />
          <Text style={styles.loadingText}>INITIALIZING...</Text>
        </View>
      ) : null}
      {crashed ? (
        <TouchableOpacity
          style={styles.crashOverlay}
          activeOpacity={0.85}
          onPress={reloadEngine}
        >
          <Text style={styles.crashTitle}>Engine crashed</Text>
          <Text style={styles.crashSub}>Tap to reload</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// Send arbitrary control messages (fit/center/speak/message) from the parent.
export function buildWorldCommand(cmd) {
  return JSON.stringify(cmd || {});
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0e1a' },
  webviewContainer: { flex: 1, backgroundColor: '#0a0e1a' },
  webview: { flex: 1, backgroundColor: '#0a0e1a', opacity: 0.999 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0a0e1a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingSpinner: {
    width: 28,
    height: 28,
    borderWidth: 3,
    borderColor: 'rgba(212,175,55,0.25)',
    borderTopColor: '#d4af37',
    borderRadius: 14,
  },
  loadingText: {
    color: '#d4af37',
    fontSize: 11,
    marginTop: 14,
    letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  crashOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0a0e1a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  crashTitle: {
    color: '#d4af37',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  crashSub: {
    color: '#9aa2b1',
    fontSize: 12,
    marginTop: 8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  controlCluster: {
    position: 'absolute',
    // right / bottom are applied inline with safe-area insets.
    gap: 8,
    alignItems: 'center',
    zIndex: 20,
  },
  pillBtn: {
    minWidth: 56,
    height: 30,
    borderRadius: 999,
    paddingHorizontal: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillBtnOn: {
    backgroundColor: 'rgba(212,175,55,0.92)',
    borderColor: 'rgba(212,175,55,0.95)',
  },
  pillBtnOff: {
    backgroundColor: 'rgba(10,14,26,0.72)',
    borderColor: 'rgba(212,175,55,0.30)',
  },
  pillText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  pillTextOn: { color: '#1a1200' },
  pillTextOff: { color: '#9aa2b1' },
  zoomBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: 'rgba(10,14,26,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomBtnText: {
    color: '#d4af37',
    fontSize: 22,
    lineHeight: 24,
    fontWeight: '700',
  },
  zoomBtnFitText: {
    color: '#d4af37',
    fontSize: 18,
    lineHeight: 20,
    fontWeight: '700',
  },
  followPill: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(212,175,55,0.92)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    zIndex: 30,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  followPillText: {
    color: '#1a1200',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});

export default AgencyWorldView;
