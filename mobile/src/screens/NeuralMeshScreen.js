/**
 * NeuralMeshScreen — the Agent Mesh, NATIVE and 1:1 with the web /mesh.
 *
 * Same world, same data, same features as the web <agent-mesh-page> /
 * <agency-world-viz review-layer>, rebuilt in React Native:
 *   · world      the web station in the web's world coordinates — sectors,
 *                the web's own baked prop art, Gateway Concourse beds,
 *                Executive Suite + Auditor, Plugin District rooms + conduits
 *                (plugins.list), federation islands (lib/mesh/world.js);
 *   · agents     the web bridge's RPCs + live events (useAgentMesh), placed by
 *                the web's SpreadPlanner (domain → sector desks / plugin rooms),
 *                resting runs on beds, provider badges, nameplates, coder
 *                build tags, heatmap blobs;
 *   · HUD        Back · AGENT MESH n · FIT · Broadcast · Auto-focus · Spread ·
 *                Director, live stats, holding zone, active agents;
 *   · camera     the web's own BroadcastDirector + CameraDirector (compiled
 *                in) fed by the bridge's world events, flying an eased camera
 *                (cameraFlyTo), with pulses, the reticle and the LIVE caption;
 *   · assign     drag an agent onto a sector / plugin room → sessions.spawn,
 *                exactly as <world-interactions> drag-assign does;
 *   · bottom     heatmap missions, zoom controls, Recently completed;
 *   · touch      pinch / pan / double-tap zoom; tap agent → agent card (the
 *                web hover card); long-press → action sheet (web context
 *                menu + radial menu); tap the Auditor → review threads,
 *                "Screenshots · N" → gallery;
 *   · hand-offs  Details → the native agent focus sheet; Task → Board;
 *                In app → Reviews (run) or Chat (session); plugin room → its page.
 *   · deep links infinibot://mesh[?focus=<sessionKey|runId>&review=<runId>].
 *
 * The web logic it runs (layout, routing, review / card / rail / HUD maths) is
 * compiled from the web sources into lib/mesh/web-mesh.generated.js.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, BackHandler, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle, G } from 'react-native-svg';

import { useAgentMesh } from '../hooks/useAgentMesh';
import { useFederation } from '../hooks/useFederation';
import { useRotationWhileFocused } from '../infini/orientation';
import { navigateToScreen } from '../navigation/screen-registry';
import { resolveDeepLink } from '../navigation/deep-links';
import { resolveWebSurfaceConfig } from '../lib/web-surface';
import { buildDistrict, buildIslands, buildStation, worldBounds } from '../lib/mesh/world';
import { AgentPlacer, isRestingStatus } from '../lib/mesh/placement';
import { TOOL_SIGNAL_TTL_MS, buildPluginActivityIndex } from '../lib/mesh/web-mesh.generated';
import { GALACTIC } from '../lib/mesh/mesh-assets';
import { nativeHaptic } from '../lib/native-haptic';
import { useWorldCamera } from '../components/mesh/useWorldCamera';
import { AgentSprite, Auditor, HeatLayer, PacketLayer, StationLayer } from '../components/mesh/IsoWorld';
import { agentOffset, keysInRect, packetHead, stepWalk } from '../lib/mesh/motion';
import {
  AmbientDrift, DBLTAP_FLY_MS, DBLTAP_SCALE, DRAG_HIT_RADIUS, FOLLOW_FLY_MS, FOLLOW_REFLY_MS, FOLLOW_SCALE, POINTER_PAUSE_MS,
  REJECT_MS, TOAST_MS, WHEEL_PAUSE_MS, accentAt, addPulse, clampFlyScale, createDirectors, dragAssignRequest, dropZoneAt, dropZones,
  worldEventBeats,
} from '../lib/mesh/director';
import { DragAssignOverlay, FxOverlay, MeshToast } from '../components/mesh/MeshFx';
import { IsoLabels, layoutLabels } from '../components/mesh/IsoLabels';
import { MeshHud } from '../components/mesh/MeshHud';
import { MeshBottomBar } from '../components/mesh/MeshBottomBar';
import { AgentCardSheet, DecisionSheet, MeshActionSheet } from '../components/mesh/MeshSheets';
import { AuthImage, CompletedSheet, ReviewPanel, shotUrl, useCompletedEntries } from '../components/mesh/ReviewSheets';
import { AgentFocusSheet } from '../components/AgentFocusSheet';
import { BUILD_COLOR } from '../components/mesh/mesh-style';
import { Mesh3DView, mesh3dAvailable } from '../components/mesh/Mesh3DView';
import { useTheme } from '../theme/ThemeProvider';

const MIN_K = 0.12;
const MAX_K = 3.5;
const PREFS_KEY = 'infinibot.mesh.native.prefs.v1';
// Same key (and values) as the web page's 2D/3D choice; the web export shares it.
const VIEW_KEY = 'infinibot.mesh.view';
const FX_TICK_MS = 33; // the web runs renderFx() per rAF; directors are time-driven
const BG = GALACTIC.void;

const PROVIDER_OF = {
  'claude-code': { color: BUILD_COLOR['claude-code'], mono: 'CL', icon: 'sparkles-outline', label: 'Claude Code' },
  codex: { color: BUILD_COLOR.codex, mono: 'CX', icon: 'terminal-outline', label: 'Codex' },
  opencode: { color: BUILD_COLOR.opencode, mono: 'OC', icon: 'code-slash-outline', label: 'OpenCode' },
  gemini: { color: BUILD_COLOR.gemini, mono: 'GE', icon: 'star-outline', label: 'Gemini' },
};
const ASH = { color: '#FFD700', mono: 'AS', icon: 'flash-outline', label: 'InfiniBot' };

/** Deterministic starfield behind the station (the web's Starfield backdrop). */
function useStars(w, h) {
  return useMemo(() => {
    const out = [];
    let s = 1337;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 90; i++) out.push({ x: rnd() * w, y: rnd() * h, r: rnd() * 1.1 + 0.3, o: 0.25 + rnd() * 0.5 });
    return out;
  }, [w, h]);
}

function pointInPoly(pt, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i].y > pt.y) !== (poly[j].y > pt.y) && pt.x < ((poly[j].x - poly[i].x) * (pt.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) ins = !ins;
  }
  return ins;
}

function DirectorBtn({ label, onPress }) {
  return (
    <Pressable onPress={onPress} style={styles.directorBtn} accessibilityRole="button">
      <Text style={styles.directorBtnText}>{label}</Text>
    </Pressable>
  );
}

export function NeuralMeshScreen({ gateway, navigation, route }) {
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const landscape = winW > winH;
  const focused = useIsFocused();
  useRotationWhileFocused();
  // The 3D world follows the app's appearance theme (mode + primary accent).
  const { mode: themeMode, tokens: themeTokens } = useTheme();
  const meshTheme = useMemo(
    () => ({ mode: themeMode, primary: themeTokens?.primary, secondary: themeTokens?.accent }),
    [themeMode, themeTokens?.primary, themeTokens?.accent],
  );
  // HUD column: a slim opaque strip beside the map in landscape, full width
  // (wrapping toolbar) in portrait. Its measured box feeds zoomToFit's padding.
  const hudWidth = landscape ? Math.min(268, winW * 0.34) : winW - 16 - insets.left - insets.right;
  const hudBox = useRef({ x: 8, y: 8, w: 0, h: 0 });
  const [hudSig, setHudSig] = useState('');
  const federation = useFederation(gateway);

  // ── Prefs (web: localStorage toggles) ────────────────────────────────────
  const [prefs, setPrefs] = useState({ spread: true, autoFocus: true, broadcast: false, labelsHidden: false, activeOpen: false, hudDetails: null });
  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY).then((j) => { if (j) setPrefs((p) => ({ ...p, ...JSON.parse(j) })); }).catch(() => {});
  }, []);
  const setPref = useCallback((key, v) => setPrefs((p) => {
    const next = { ...p, [key]: typeof v === 'function' ? v(p[key]) : v };
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)).catch(() => {});
    return next;
  }), []);
  const [heat, setHeat] = useState(null);
  const [director, setDirector] = useState(false);
  // 2D (SVG iso map) or 3D (the web three.js world on expo-gl).
  const [view, setViewState] = useState('2d');
  const [reducedMotion, setReducedMotion] = useState(false);
  const mesh3dRef = useRef(null);
  const view3d = view === '3d' && mesh3dAvailable();
  useEffect(() => {
    AsyncStorage.getItem(VIEW_KEY).then((v) => { if (v === '3d' || v === '2d') setViewState(v); }).catch(() => {});
    AccessibilityInfo.isReduceMotionEnabled?.().then((on) => setReducedMotion(!!on)).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (on) => setReducedMotion(!!on));
    return () => sub?.remove?.();
  }, []);
  const setView = useCallback((v) => {
    setViewState(v);
    AsyncStorage.setItem(VIEW_KEY, v).catch(() => {});
  }, []);
  const [picked, setPicked] = useState(() => new Set());

  const mesh = useAgentMesh(gateway, { heatmap: heat });
  const [httpBase, setHttpBase] = useState('');
  useEffect(() => { resolveWebSurfaceConfig().then((c) => setHttpBase(c?.httpBase || '')).catch(() => {}); }, []);

  // ── World ────────────────────────────────────────────────────────────────
  const station = useMemo(() => buildStation(), []);
  const prevPlan = useRef(null);
  const district = useMemo(() => {
    const d = buildDistrict(mesh.plugins || [], prevPlan.current);
    prevPlan.current = d.plan;
    return d;
  }, [mesh.plugins]);
  const nodesKey = mesh.nodes.map((n) => `${n.id}:${n.status}:${n.agentCount}`).join('|');
  const islands = useMemo(() => buildIslands(mesh.nodes), [nodesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const bounds = useMemo(() => worldBounds(station, district, islands), [station, district, islands]);
  const pluginIndex = useMemo(() => buildPluginActivityIndex(mesh.plugins), [mesh.plugins]);

  const placer = useRef(null);
  if (!placer.current) placer.current = new AgentPlacer();
  useMemo(() => placer.current.setRooms(district.rooms), [district]);
  const roomFor = useCallback((a, tool) => {
    if (!district.rooms.length) return null;
    const fresh = !!tool && Date.now() - tool.at <= TOOL_SIGNAL_TTL_MS;
    const pid = pluginIndex.resolve({
      pluginId: a.pluginId,
      toolKind: fresh ? tool.kind : undefined,
      toolLabel: fresh ? tool.label : undefined,
      text: [a.currentTask, a.label].filter(Boolean).join(' · '),
      agentId: a.agentId,
    });
    const sid = pid ? `plugin:${pid}` : null;
    return sid && district.rooms.some((r) => r.id === sid) ? sid : null;
  }, [district, pluginIndex]);
  const positions = useMemo(
    () => placer.current.place(mesh.agents, { station, district, islands, tools: mesh.tools, roomFor, spread: prefs.spread, now: Date.now() }),
    [mesh.agents, mesh.tools, station, district, islands, roomFor, prefs.spread],
  );
  const agentByKey = useMemo(() => new Map(mesh.agents.map((a) => [a.sessionKey, a])), [mesh.agents]);
  const activeZones = useMemo(() => new Set([...positions.values()].filter((p) => p.where === 'sector').map((p) => p.sectorId)), [positions]);

  // ── Overlay state ────────────────────────────────────────────────────────
  // fxPausedUntil (agency-world-viz.ts): a touch pauses the auto-director so it
  // never fights the user; Broadcast backs off for 10 s (notePointerInteraction).
  const fxPausedUntil = useRef(0);
  const dirs = useRef(null);
  const notePointer = (ms = POINTER_PAUSE_MS) => {
    dirs.current?.broadcast.notePointerInteraction();
    fxPausedUntil.current = Math.max(fxPausedUntil.current, performance.now() + ms);
  };
  const [cardKey, setCardKey] = useState(null);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decisionInitialId, setDecisionInitialId] = useState(null);
  const [sheet, setSheet] = useState(null); // { title, items }
  const [focusAgent, setFocusAgent] = useState(null);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [panel, setPanel] = useState(null); // { mode: 'thread'|'gallery', runId }
  const [following, setFollowing] = useState(null);
  const [caption, setCaption] = useState(null);
  const labelsRef = useRef(null);
  const fitKRef = useRef(1);
  const handlers = useRef({});

  const cam = useWorldCamera({
    minK: MIN_K,
    maxK: MAX_K,
    onTap: (x, y) => handlers.current.tap?.(x, y),
    onLongPress: (x, y) => handlers.current.long?.(x, y),
    onDoubleTap: (x, y) => handlers.current.double?.(x, y),
    onGestureStart: (kind) => notePointer(kind === 'pinch' ? WHEEL_PAUSE_MS : POINTER_PAUSE_MS),
    lasso: director,
    onLasso: (phase, x0, y0, x1, y1) => handlers.current.lasso?.(phase, x0, y0, x1, y1),
    onAgentDrag: (phase, key, x, y) => handlers.current.drag?.(phase, key, x, y),
    dragRadius: DRAG_HIT_RADIUS,
  });
  const [lassoRect, setLassoRect] = useState(null);

  const hitAgent = (sx, sy, radius = 70) => {
    const w = cam.toWorld(sx, sy);
    if (!w) return null;
    let best = null;
    let bd = Infinity;
    for (const [key, p] of positions) {
      const d = Math.hypot(p.x - w.x, (p.y - 18) - w.y);
      if (d < bd) { bd = d; best = key; }
    }
    return bd <= radius ? best : null;
  };
  const roomAt = (sx, sy) => {
    const w = cam.toWorld(sx, sy);
    return w ? district.rooms.find((r) => pointInPoly(w, r.poly)) || null : null;
  };
  const openCard = (key) => {
    if (!key) return;
    nativeHaptic('selection');
    setCardKey(key);
  };
  const flyToAgent = (key, zoom = 2.6) => {
    if (view3d) { mesh3dRef.current?.flyToAgent(key); return; }
    const p = positions.get(key);
    if (p) cam.flyTo(p.x, p.y - 20, fitKRef.current * zoom);
    notePointer();
  };

  // ── Hand-offs ────────────────────────────────────────────────────────────
  const openInApp = (a) => {
    nativeHaptic('selection');
    setCardKey(null);
    if (a.runId) navigateToScreen(navigation, { screen: 'OversightScreen', params: { runId: a.runId }, title: a.label || 'Run' }, { gateway });
    else navigation?.navigate?.('MainTabs', { screen: 'Chat', params: { sessionKey: a.sessionKey } });
  };
  const openTask = (a) => {
    if (!a.kanbanTaskId) return;
    setCardKey(null);
    navigateToScreen(navigation, { tab: 'Board', params: { taskId: a.kanbanTaskId, _ts: Date.now() }, title: 'Task' }, { gateway });
  };
  const leave = () => {
    if (navigation?.canGoBack?.()) navigation.goBack();
    else navigation?.navigate?.('MainTabs');
  };

  const agentMenu = (key) => {
    const a = agentByKey.get(key);
    if (!a) return null;
    const review = mesh.reviews.get(key);
    const act = (fn) => () => fn(a).then(() => { nativeHaptic('success'); mesh.refresh(); }).catch(() => nativeHaptic('error'));
    const items = [
      { label: 'Show agent card', run: () => openCard(key) },
      { label: 'Agent details', run: () => setFocusAgent(a) },
    ];
    if (a.runId) items.push({ label: 'Review thread', run: () => setPanel({ mode: 'thread', runId: a.runId }) }, { label: 'Screenshots', run: () => setPanel({ mode: 'gallery', runId: a.runId }) });
    items.push({ label: a.runId ? 'Open run in app' : 'Chat in app', run: () => openInApp(a) });
    items.push(
      { sep: true },
      { label: 'Resume', run: act(mesh.actions.resume) },
      { label: 'Stop', danger: true, run: act(mesh.actions.pause) },
      { label: 'Respawn', run: act(mesh.actions.respawn), disabled: !a.runId },
      { label: 'Send Message', run: () => openCard(key) },
      { sep: true },
      { label: 'Spawn 3 review passes', run: act(mesh.actions.spawnReviewPasses) },
      { label: 'Force re-review', run: act(mesh.actions.forceReview) },
      review
        ? { label: 'Open review →', run: () => navigateToScreen(navigation, { screen: 'OversightScreen', params: { runId: review.runId || review.run_id || a.runId }, title: 'Run' }, { gateway }) }
        : { label: 'No review yet', disabled: true },
      { sep: true },
      { label: 'Cancel', run: () => {} },
    );
    return { title: a.label || a.sessionKey, items };
  };

  // zoomToFit, keeping the map clear of the HUD column (top in portrait,
  // left in landscape), the zoom controls and the bottom bar.
  const fitPads = () => (landscape
    ? { padLeft: (hudBox.current.w ? hudBox.current.x + hudBox.current.w : hudWidth + 8) + 12, padRight: 56, padTop: 12, padBottom: 58 + insets.bottom }
    : { padX: 10, padTop: (hudBox.current.h ? hudBox.current.y + hudBox.current.h : 176) + 8, padBottom: 64 + insets.bottom });
  const fit = () => {
    if (view3d) { mesh3dRef.current?.resetView(); return; }
    if (!cam.size.w) return;
    const kk = cam.fitBox(bounds, fitPads());
    if (kk) fitKRef.current = kk;
  };

  handlers.current = {
    // Director: drag-lasso a group (director-mode.ts), screen-space rect.
    lasso: (phase, x0, y0, x1, y1) => {
      if (phase !== 'end') { setLassoRect({ x0, y0, x1, y1 }); return; }
      setLassoRect(null);
      if (!cam.cam) return;
      const pts = new Map();
      for (const [key, p] of positions) pts.set(key, { x: p.x * cam.cam.k + cam.cam.x, y: (p.y - 18) * cam.cam.k + cam.cam.y });
      const hit = keysInRect(pts, x0, y0, x1, y1);
      if (hit.length) {
        nativeHaptic('selection');
        setPicked((prev) => new Set([...prev, ...hit]));
      }
    },
    // Drag-to-assign (world-interactions drag-assign.ts): a drag that starts on
    // an agent carries it; dropping on a sector / plugin room fires the web's
    // sessions.spawn, anywhere else flashes the reject marker.
    drag: (phase, key, x, y) => {
      const a = agentByKey.get(key);
      if (!a) return;
      const w = cam.toWorld(x, y);
      const hovered = w ? dropZoneAt(zones, w.x, w.y) : null;
      if (phase === 'start') {
        notePointer();
        nativeHaptic('medium');
        setReject(null);
        setDragState({ key, x, y, hovered, label: a.label || a.sessionKey });
        return;
      }
      if (phase === 'move') {
        setDragState((d) => (d ? { ...d, x, y, hovered } : d));
        return;
      }
      setDragState(null);
      if (hovered) {
        assign(a, hovered);
      } else {
        nativeHaptic('error');
        setReject({ x, y });
        showToast('No drop zone here', 'err');
        setTimeout(() => setReject(null), REJECT_MS);
      }
    },
    tap: (x, y) => {
      notePointer();
      const hit = labelsRef.current?.hits?.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
      if (hit?.kind === 'auditor') { nativeHaptic('selection'); setPanel({ mode: 'thread', runId: null }); return; }
      if (hit?.kind === 'screenshots') { nativeHaptic('selection'); setPanel({ mode: 'gallery', runId: null }); return; }
      if (hit?.kind === 'thumb') { nativeHaptic('selection'); setPanel({ mode: 'gallery', runId: hit.shot.runId || null }); return; }
      const key = hit?.kind === 'agent' ? hit.key : hitAgent(x, y);
      if (key) {
        if (director) {
          nativeHaptic('selection');
          setPicked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
          return;
        }
        openCard(key);
        return;
      }
      const room = roomAt(x, y);
      if (room) {
        nativeHaptic('selection');
        const entry = resolveDeepLink(`infinibot://plugin/${room.spec.pluginId}`, { plugins: mesh.pluginList });
        if (entry && !entry.unknown) navigateToScreen(navigation, entry, { gateway });
      }
    },
    long: (x, y) => {
      notePointer();
      nativeHaptic('medium');
      const key = hitAgent(x, y, 90);
      if (key) { setSheet(agentMenu(key)); return; }
      setSheet({
        title: 'Agent Mesh',
        items: [
          { label: 'Fit every agent in view', run: fit },
          { label: 'Bulk review last 5 completions', run: () => mesh.actions.bulkReview(5).then(() => nativeHaptic('success')) },
          { label: 'Review threads', run: () => setPanel({ mode: 'thread', runId: null }) },
          { label: 'Screenshot gallery', run: () => setPanel({ mode: 'gallery', runId: null }) },
          { sep: true },
          { label: 'Cancel', run: () => {} },
        ],
      });
    },
    double: (x, y) => {
      // handleFxDblClick: fly to the nearest agent (120 px) at 1.6× over 700 ms.
      const key = hitAgent(x, y, 120);
      const p = key ? agentPos(key) : null;
      if (p) cam.animateTo(p.x, p.y, clampFlyScale(DBLTAP_SCALE), DBLTAP_FLY_MS);
      else cam.zoomBy(2, x, y);
      notePointer();
    },
  };

  // Fit once the view has a size, and again when the world grows (rooms / islands) or rotates.
  const fitSig = `${cam.size.w}x${cam.size.h}|${Math.round(bounds.minX)}|${Math.round(bounds.maxX)}|${Math.round(bounds.maxY)}|${hudSig}`;
  useEffect(() => {
    if (!cam.size.w) return;
    fit();
  }, [fitSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-focus (CameraDirector), Broadcast (BroadcastDirector) and Follow ─
  // The web's two directors, unchanged, over native deps: agent positions are
  // the walked sprite positions, flyTo is the eased cameraFlyTo, the idle orbit
  // is ambientDriftStep. The FX tick below is renderFx()'s director half.
  const drift = useMemo(() => new AmbientDrift(station), [station]);
  const live = useRef({});
  live.current = { positions, agentByKey, nodes: mesh.nodes, station, cam, drift, following, view3d };
  const agentPos = (key) => shownRef.current.get(key) || positions.get(key) || null;
  const agentPosRef = useRef(agentPos);
  agentPosRef.current = agentPos;
  if (!dirs.current) {
    dirs.current = createDirectors({
      now: () => performance.now(),
      agentExists: (k) => live.current.positions.has(k),
      agentWorldPos: (k) => agentPosRef.current(k),
      flyTo: (x, y, scale, ms) => live.current.cam.animateTo(x, y, clampFlyScale(scale), ms),
      ambientDrift: () => {
        const t = live.current.drift.step();
        live.current.cam.animateTo(t.x, t.y, clampFlyScale(t.scale), t.ms);
      },
      getPausedUntil: () => fxPausedUntil.current,
      onFocus: (f) => setCaption(f && f.caption ? f.caption : null),
    });
  }
  useEffect(() => { dirs.current.camera.setEnabled(!!prefs.autoFocus); }, [prefs.autoFocus]);
  useEffect(() => { dirs.current.broadcast.setEnabled(!!prefs.broadcast); }, [prefs.broadcast]);
  useEffect(() => () => { dirs.current?.broadcast.destroy(); dirs.current?.camera.destroy(); }, []);

  const pulsesRef = useRef([]);
  const lastStatus = useRef(new Map());
  const followFlyAt = useRef(0);
  useEffect(() => {
    if (!focused || !cam.size.w) return undefined;
    const t = setInterval(() => {
      const L = live.current;
      // 3D on screen: Mesh3DView drains the bridge queue for its beams.
      if (!L.cam.cam || L.view3d) return;
      const now = performance.now();
      const events = mesh.drainWorldEvents();
      if (events.length) {
        const atrium = L.station.zones.find((z) => z.id === 'command-atrium')?.center;
        const { beats, pulses } = worldEventBeats(events, { agents: L.agentByKey, lastStatus: lastStatus.current, atrium, nodes: new Map(L.nodes.map((n) => [n.id, n])), now });
        for (const b of beats) { dirs.current.broadcast.noteEvent(b); dirs.current.camera.noteEvent(b); }
        for (const key of pulses) {
          const pos = agentPosRef.current(key);
          pulsesRef.current = addPulse(pulsesRef.current, key, pos ? accentAt(L.station, pos.x, pos.y) : '#7dd3fc', now);
        }
      }
      pulsesRef.current = pulsesRef.current.filter((p) => now - p.born < p.ttl);
      dirs.current.broadcast.tick();
      dirs.current.camera.tick();
      if (L.following) {
        if (!L.positions.has(L.following)) setFollowing(null);
        else if (now - followFlyAt.current > FOLLOW_REFLY_MS) {
          const p = agentPosRef.current(L.following);
          if (p) L.cam.animateTo(p.x, p.y, clampFlyScale(FOLLOW_SCALE), FOLLOW_FLY_MS);
          followFlyAt.current = now;
        }
      }
    }, FX_TICK_MS);
    return () => clearInterval(t);
  }, [focused, cam.size.w > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { followFlyAt.current = 0; }, [following]);
  const fx = {
    pulses: () => pulsesRef.current,
    pos: (key) => agentPosRef.current(key),
    subject: () => {
      const key = following || dirs.current?.broadcast.getCurrentSubject() || null;
      if (!key) return null;
      const p = agentPosRef.current(key);
      return { key, color: following ? '#fbbf24' : p ? accentAt(station, p.x, p.y) : '#7dd3fc' };
    },
  };

  // ── Drag-to-assign + toast ───────────────────────────────────────────────
  const zones = useMemo(() => dropZones(station, district), [station, district]);
  const [dragState, setDragState] = useState(null);
  const [reject, setReject] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = (message, kind = 'ok') => {
    setToast({ message, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  };
  useEffect(() => () => toastTimer.current && clearTimeout(toastTimer.current), []);
  const assignLog = useRef({ dryRun: false, calls: [] });
  const assign = async (a, sector) => {
    const { method, params } = dragAssignRequest(a, sector);
    showToast(`Assigning to ${sector.name}…`);
    assignLog.current.calls.push({ method, params, at: Date.now() });
    try {
      if (!assignLog.current.dryRun) await mesh.actions.rpc(method, params);
      nativeHaptic('success');
      showToast(`Spawned in ${sector.name}`, 'ok');
    } catch (e) {
      nativeHaptic('error');
      showToast(`Spawn failed: ${e?.message || 'error'}`, 'err');
    }
  };

  // ── Deep links: focus an agent / open a review ───────────────────────────
  const params = route?.params || null;
  const pending = useRef(null);
  useEffect(() => {
    if (params && (params.focus || params.review || params.sessionKey || params.runId)) pending.current = { ...params };
  }, [params?.focus, params?.review, params?.sessionKey, params?.runId, params?._ts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const p = pending.current;
    if (!p || !mesh.loaded || !cam.cam) return;
    const id = p.focus || p.sessionKey || p.runId;
    if (id) {
      const a = mesh.agents.find((x) => x.sessionKey === id || x.runId === id);
      if (a) {
        flyToAgent(a.sessionKey);
        setCardKey(a.sessionKey);
        p.focus = null;
        p.sessionKey = null;
        p.runId = null;
      }
    }
    if (p.review) {
      setPanel({ mode: 'thread', runId: p.review });
      p.review = null;
    }
    if (!p.focus && !p.sessionKey && !p.runId && !p.review) pending.current = null;
  }, [mesh.loaded, mesh.version, cam.cam]); // eslint-disable-line react-hooks/exhaustive-deps

  // Android back: close the topmost layer first, then leave.
  useFocusEffect(useCallback(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sheet) { setSheet(null); return true; }
      if (focusAgent) { setFocusAgent(null); return true; }
      if (panel) { setPanel(null); return true; }
      if (completedOpen) { setCompletedOpen(false); return true; }
      if (cardKey) { setCardKey(null); return true; }
      if (director) { setDirector(false); setPicked(new Set()); return true; }
      return false;
    });
    return () => sub.remove();
  }, [sheet, focusAgent, panel, completedOpen, cardKey, director]));

  // ── Derived for render ───────────────────────────────────────────────────
  const completedEntries = useCompletedEntries({ completed: mesh.completed, screenshots: mesh.screenshots, threads: mesh.threads, threadsVersion: mesh.threadsVersion });
  const heatBlobs = useMemo(() => {
    if (!heat) return [];
    const vals = mesh.agents.map((a) => {
      const v = heat === 'credit_burn' ? mesh.feeds.burn[a.sessionKey] || 0
        : heat === 'failure_rate' ? mesh.feeds.failure[a.sessionKey] || 0
          : ['working', 'starting', 'finishing'].includes(a.status) ? 1 : 0.25;
      return { a, v };
    });
    const max = Math.max(0, ...vals.map((x) => x.v));
    if (!max) return [];
    return vals.filter((x) => x.v > 0 && positions.get(x.a.sessionKey)).map((x, i) => ({ key: x.a.sessionKey, id: i, t: x.v / max, ...positions.get(x.a.sessionKey) }));
  }, [heat, mesh.agents, mesh.feeds, positions]);
  const reviewActive = useMemo(() => mesh.threads.list().some((t) => Date.now() - (t.summary?.lastTs || 0) < 60_000), [mesh.threadsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const labels = useMemo(() => (cam.cam ? layoutLabels({
    cam: cam.cam, station, district, islands, agents: mesh.agents, positions, auditor: station.exec.auditor,
    screenshotCount: mesh.screenshotTotal || mesh.screenshots.length, screenshots: mesh.screenshots, size: cam.size,
  }) : null), [cam.cam, cam.size, station, district, islands, mesh.agents, positions, mesh.screenshotTotal, mesh.screenshots]);
  labelsRef.current = labels;
  const stars = useStars(winW, winH);

  // Verification hook on the web export (mirrors the web mesh's window.__meshHover).
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    globalThis.__agentMesh = {
      event: (topic, payload) => mesh.injectEvent(topic, payload),
      view: (v) => { if (v) setView(v); return view3d ? '3d' : '2d'; },
      mesh3d: () => {
        const s = mesh3dRef.current?.scene;
        return s ? { stats: s.stats(), agents: s.agentKeys(), plugins: s.zoneIds('plugin'), card: cardKey } : null;
      },
      closeCard: () => setCardKey(null),
      scene3d: () => mesh3dRef.current?.scene || null,
      onMap2d: () => sortedAgents.map((a) => a.sessionKey),
      agentScreen3d: (key) => mesh3dRef.current?.scene?.agentScreen(key) || null,
      agents: () => mesh.agents.map((a) => ({ key: a.sessionKey, label: a.label, status: a.status, where: positions.get(a.sessionKey)?.where, sector: positions.get(a.sessionKey)?.sectorId })),
      rooms: () => district.rooms.map((r) => r.spec.title),
      plugins: () => mesh.plugins.length,
      card: (i = 0) => { const a = sortedAgents.filter((x) => !x.resting)[i] || sortedAgents[i]; if (a) { flyToAgent(a.sessionKey); setCardKey(a.sessionKey); } return a?.sessionKey || null; },
      sheet: (i = 0) => { const a = sortedAgents.filter((x) => !x.resting)[i] || sortedAgents[i]; if (a) setSheet(agentMenu(a.sessionKey)); return a?.sessionKey || null; },
      panel: (mode, runId) => setPanel({ mode, runId: runId || null }),
      completed: () => setCompletedOpen(true),
      fit,
      version: () => mesh.version,
      events: () => mesh.eventStats(),
      packet: (runId) => mesh.pushPacket({ runId, seq: Date.now(), kind: 'submission', to: 'reviewer', from: 'worker', title: 'verify' }),
      motion: () => [...motion.entries()].map(([k, v]) => [k.slice(-8), Math.round(v.x * 10) / 10, Math.round(v.y * 10) / 10, !!v.walking]),
      picked: () => [...picked],
      director: (on) => setDirector(!!on),
      lasso: (x0, y0, x1, y1) => handlers.current.lasso('end', x0, y0, x1, y1),
      walkTest: (key) => { const p = positions.get(key); if (p) shownRef.current.set(key, { x: p.x - 300, y: p.y + 150 }); return !!p; },
      heads: () => packetHeads.length,
      hud: () => mesh.hud,
      cam: () => cam.cam,
      fly: (x, y, kk) => { notePointer(); cam.flyTo(x, y, kk); },
      directors: () => ({
        autoFocus: dirs.current.camera.isEnabled(),
        broadcast: dirs.current.broadcast.isEnabled(),
        cameraSubject: dirs.current.camera.getCurrentSubject(),
        broadcastSubject: dirs.current.broadcast.getCurrentSubject(),
        caption,
        pulses: pulsesRef.current.length,
        flying: cam.flying(),
        pausedFor: Math.max(0, fxPausedUntil.current - performance.now()),
      }),
      zones: () => zones.map((z) => ({ id: z.id, name: z.name, kind: z.kind, screen: cam.cam ? { x: z.x * cam.cam.k + cam.cam.x, y: z.y * cam.cam.k + cam.cam.y } : null })),
      agentScreen: (key) => { const p = agentPos(key); return p && cam.cam ? { x: p.x * cam.cam.k + cam.cam.x, y: (p.y - 18) * cam.cam.k + cam.cam.y } : null; },
      assignDryRun: (on) => { assignLog.current.dryRun = !!on; return assignLog.current.dryRun; },
      assignCalls: () => assignLog.current.calls.slice(),
      toast: () => toast,
      setPref: (k, v) => setPref(k, v),
      follow: (key) => setFollowing(key || null),
      inject: (events) => mesh.injectWorldEvents(events),
      exec: () => station.exec.center,
      screen: (x, y) => { const p = positions.get(x); return p && cam.cam ? { x: p.x * cam.cam.k + cam.cam.x, y: p.y * cam.cam.k + cam.cam.y } : null; },
      tap: (x, y) => handlers.current.tap(x, y),
      long: (x, y) => handlers.current.long(x, y),
    };
    return () => { delete globalThis.__agentMesh; };
  });

  // Ambient motion + packets: an 8 fps clock re-renders only the agent layer
  // (the station layer is memoised), paused while a sheet covers the map.
  const [clock, setClock] = useState(0);
  const covered = !!(cardKey || sheet || panel || completedOpen || focusAgent);
  useEffect(() => {
    if (covered || view3d) return undefined;
    const t = setInterval(() => setClock(Date.now()), 125);
    return () => clearInterval(t);
  }, [covered, view3d]);
  // Agents walk to new desks / beds at the web's 60 px/s instead of jumping.
  const shownRef = useRef(new Map());
  const lastStep = useRef(0);
  const placedOnce = useRef(false);
  const walked = useMemo(() => {
    const now = clock || Date.now();
    const dt = lastStep.current ? (now - lastStep.current) / 1000 : 0;
    lastStep.current = now;
    const next = stepWalk(shownRef.current, positions, covered ? 10 : dt, { spawnAt: placedOnce.current ? station.concourse : null });
    if (positions.size) placedOnce.current = true;
    shownRef.current = next;
    return next;
  }, [clock, positions, covered, station]);
  const motion = useMemo(() => {
    const m = new Map();
    const tSec = (clock || Date.now()) / 1000;
    for (const a of mesh.agents) {
      const w = walked.get(a.sessionKey);
      const base = positions.get(a.sessionKey);
      const off = w?.walking ? { x: 0, y: -Math.abs(Math.sin(tSec * 9)) * 2 } : agentOffset(a, base?.where, tSec);
      m.set(a.sessionKey, w && base ? { x: w.x - base.x + off.x, y: w.y - base.y + off.y, walking: !!w.walking } : off);
    }
    return m;
  }, [clock, mesh.agents, positions, walked]);
  // Drag-to-assign hit targets: every agent's body centre on screen (the
  // walked position), handed to the pan worklet. Off in Director (lasso owns drags).
  useEffect(() => {
    const c = cam.cam;
    if (!c || director) { cam.setDragTargets([], []); return; }
    const keys = [];
    const pts = [];
    for (const [key, p] of walked) {
      keys.push(key);
      pts.push(p.x * c.k + c.x, (p.y - 18) * c.k + c.y);
    }
    cam.setDragTargets(keys, pts);
  }, [walked, cam.cam, director]); // eslint-disable-line react-hooks/exhaustive-deps
  const packetHeads = useMemo(() => {
    const now = clock || Date.now();
    const out = [];
    for (const pk of mesh.packets()) {
      const w = mesh.agents.find((a) => a.runId === pk.runId);
      const head = packetHead(pk, w ? positions.get(w.sessionKey) : null, station.exec.auditor, now);
      if (head) out.push({ id: pk.id, color: pk.color, ...head });
    }
    return out;
  }, [clock, mesh, positions, station]);

  const sortedAgents = useMemo(
    () => mesh.agents.filter((a) => positions.get(a.sessionKey)).sort((x, y) => positions.get(x.sessionKey).y - positions.get(y.sessionKey).y),
    [mesh.agents, positions],
  );
  const cardAgent = cardKey ? agentByKey.get(cardKey) || null : null;
  const cardThread = cardAgent?.runId ? mesh.threads.get(cardAgent.runId) : null;
  const cardRecord = cardAgent ? mesh.completed.find((r) => (cardAgent.runId && r.runId === cardAgent.runId) || r.childSessionKey === cardAgent.sessionKey) || null : null;
  const k = cam.cam?.k || 1;

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={[styles.fill, { paddingTop: insets.top, paddingLeft: landscape ? insets.left : 0, paddingRight: landscape ? insets.right : 0 }]} testID="mesh-screen">
        <View style={styles.fill} onLayout={cam.onLayout}>
          <Svg width={winW} height={winH} style={StyleSheet.absoluteFill} pointerEvents="none">
            {stars.map((s, i) => <Circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#e6e2d3" fillOpacity={s.o} />)}
          </Svg>
          {view3d ? (
            <Mesh3DView
              ref={mesh3dRef}
              agents={mesh.agents}
              nodes={mesh.nodes}
              plugins={mesh.plugins}
              tools={mesh.tools}
              drainWorldEvents={mesh.drainWorldEvents}
              selectedKey={cardKey}
              followKey={following}
              reducedMotion={reducedMotion}
              theme={meshTheme}
              active={focused && !covered}
              onAgentPress={(key) => {
                if (director) { nativeHaptic('selection'); setPicked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; }); return; }
                openCard(key);
              }}
              onZonePress={(id, zone) => {
                nativeHaptic('selection');
                mesh3dRef.current?.flyToZone(id);
                if (!zone?.pluginId) return;
                const entry = resolveDeepLink(`infinibot://plugin/${zone.pluginId}`, { plugins: mesh.pluginList });
                if (entry && !entry.unknown) navigateToScreen(navigation, entry, { gateway });
              }}
              onUnavailable={() => { setView('2d'); showToast('3D needs a newer app build — showing 2D', 'err'); }}
              onError={() => { setView('2d'); showToast('3D could not start on this device — showing 2D', 'err'); }}
            />
          ) : (
          <GestureDetector gesture={cam.gesture}>
            <Animated.View style={[styles.fill, cam.canvasStyle]} collapsable={false} testID="mesh-canvas">
              {cam.cam ? (
                <Svg width={cam.size.w} height={cam.size.h} style={StyleSheet.absoluteFill}>
                  <G transform={`translate(${cam.cam.x} ${cam.cam.y}) scale(${k})`}>
                    <StationLayer station={station} district={district} islands={islands} activeZones={activeZones} activeRooms={activeZones} showSigns={k >= 0.8} />
                    <HeatLayer blobs={heatBlobs} />
                    <Auditor p={station.exec.auditor} active={reviewActive} />
                    <PacketLayer heads={packetHeads} />
                    {sortedAgents.map((a) => (
                      <AgentSprite
                        key={a.sessionKey}
                        a={a}
                        p={positions.get(a.sessionKey)}
                        dx={motion.get(a.sessionKey)?.x || 0}
                        dy={motion.get(a.sessionKey)?.y || 0}
                        selected={a.sessionKey === cardKey || picked.has(a.sessionKey) || a.sessionKey === following}
                        dimmed={director && picked.size > 0 && !picked.has(a.sessionKey)}
                      />
                    ))}
                  </G>
                </Svg>
              ) : null}
              {labels?.thumbs?.map((t) => (
                <View key={t.key} pointerEvents="none" style={[styles.thumb, { left: t.x, top: t.y, width: t.w, borderColor: t.shot.verdict === 'pass' ? '#22c55e' : t.shot.verdict === 'fail' ? '#ef4444' : '#64748b' }]}>
                  <AuthImage uri={shotUrl(httpBase, t.shot.thumbUrl || t.shot.path)} style={{ width: '100%', height: t.h }} />
                  <Text style={[styles.thumbLabel, { fontSize: 9 * t.scale }]} numberOfLines={1}>{t.shot.label || t.shot.route}</Text>
                </View>
              ))}
              <IsoLabels layout={labels} size={cam.size} labelsHidden={prefs.labelsHidden} />
              <FxOverlay cam={cam.cam} size={cam.size} fx={fx} />
            </Animated.View>
          </GestureDetector>
          )}

          <View
            style={[styles.viewToggle, landscape ? { right: 10, top: 8 } : { right: 10, top: (hudBox.current.h ? hudBox.current.y + hudBox.current.h : 120) + 8 }]}
            accessibilityRole="tablist"
            testID="mesh-view-toggle"
          >
            {['2d', '3d'].map((v) => (
              <Pressable
                key={v}
                onPress={() => { nativeHaptic('selection'); setView(v); }}
                style={[styles.viewBtn, (v === '3d') === view3d && styles.viewBtnOn]}
                accessibilityRole="tab"
                accessibilityState={{ selected: (v === '3d') === view3d }}
                accessibilityLabel={v === '3d' ? '3D world view' : '2D map view'}
                testID={`mesh-view-${v}`}
              >
                <Text style={[styles.viewBtnText, (v === '3d') === view3d && styles.viewBtnTextOn]}>{v.toUpperCase()}</Text>
              </Pressable>
            ))}
          </View>

          <DragAssignOverlay drag={dragState} zones={zones} cam={cam.cam} size={cam.size} reject={reject} />

          <MeshHud
            live={mesh.connected}
            count={mesh.agents.length}
            onBack={leave}
            onFit={() => { notePointer(); setFollowing(null); fit(); }}
            broadcast={prefs.broadcast}
            onBroadcast={() => setPref('broadcast', (v) => !v)}
            autoFocus={prefs.autoFocus}
            onAutoFocus={() => setPref('autoFocus', (v) => !v)}
            spread={prefs.spread}
            onSpread={() => setPref('spread', (v) => !v)}
            director={director}
            onDirector={() => { nativeHaptic('selection'); setDirector((d) => !d); setPicked(new Set()); }}
            stats={mesh.hud}
            queue={mesh.queue}
            agents={mesh.agents}
            decisions={mesh.decisions}
            onDecisions={() => { setDecisionInitialId(null); setDecisionOpen(true); }}
            activeOpen={prefs.activeOpen}
            onToggleActive={() => setPref('activeOpen', (v) => !v)}
            onAgentPress={(key) => { flyToAgent(key); openCard(key); }}
            width={hudWidth}
            compact={landscape}
            detailsOpen={prefs.hudDetails ?? landscape}
            onToggleDetails={() => setPref('hudDetails', (v) => !(v ?? landscape))}
            onLayout={(e) => { const l = e.nativeEvent.layout; hudBox.current = { x: l.x, y: l.y, w: l.width, h: l.height }; setHudSig(`${Math.round(l.width)}x${Math.round(l.height)}`); }}
          />

          {lassoRect ? (
            <View pointerEvents="none" style={[styles.lasso, { left: Math.min(lassoRect.x0, lassoRect.x1), top: Math.min(lassoRect.y0, lassoRect.y1), width: Math.abs(lassoRect.x1 - lassoRect.x0), height: Math.abs(lassoRect.y1 - lassoRect.y0) }]} />
          ) : null}
          {director ? (
            <View style={[styles.directorBar, { bottom: insets.bottom + 60 }]} testID="mesh-director-bar">
              <Text style={styles.directorText}>{picked.size ? `${picked.size} selected` : 'Drag to lasso agents, or tap them'}</Text>
              {picked.size ? (
                <>
                  <DirectorBtn label="Stop all" onPress={() => Promise.all([...picked].map((key) => agentByKey.get(key)).filter(Boolean).map((a) => mesh.actions.stop(a).catch(() => null))).then(() => nativeHaptic('success'))} />
                  <DirectorBtn label="Resume" onPress={() => Promise.all([...picked].map((key) => agentByKey.get(key)).filter(Boolean).map((a) => mesh.actions.resume(a).catch(() => null))).then(() => nativeHaptic('success'))} />
                  <DirectorBtn label="Clear" onPress={() => setPicked(new Set())} />
                </>
              ) : null}
            </View>
          ) : null}

          <MeshBottomBar
            heat={heat}
            onHeat={(m) => { nativeHaptic('selection'); setHeat(m); }}
            completedCount={completedEntries.length}
            onCompleted={() => { nativeHaptic('selection'); setCompletedOpen(true); }}
            onZoomIn={() => { notePointer(WHEEL_PAUSE_MS); if (view3d) mesh3dRef.current?.zoomBy(0.8); else cam.zoomBy(1.25); }}
            onZoomOut={() => { notePointer(WHEEL_PAUSE_MS); if (view3d) mesh3dRef.current?.zoomBy(1.25); else cam.zoomBy(0.8); }}
            onFit={() => { notePointer(); fit(); }}
            labelsHidden={prefs.labelsHidden}
            onToggleLabels={() => setPref('labelsHidden', (v) => !v)}
            caption={caption}
            bottom={insets.bottom}
            compact={winW < 440}
          />

          <MeshToast toast={toast} bottom={insets.bottom + 64} />

          {!mesh.loaded ? (
            <View style={styles.loading} pointerEvents="none" testID="mesh-loading">
              <ActivityIndicator color={GALACTIC.gold} />
              <Text style={styles.loadingText}>{mesh.connected ? 'Mapping agents…' : 'Waiting for the gateway…'}</Text>
            </View>
          ) : null}
        </View>
      </View>

      <AgentCardSheet
        agent={cardAgent}
        node={cardAgent ? mesh.nodes.find((n) => n.id === cardAgent.nodeId) || null : null}
        agents={mesh.agents}
        review={cardAgent ? mesh.reviews.get(cardAgent.sessionKey) || null : null}
        thread={cardThread}
        record={cardRecord}
        decisions={mesh.decisions}
        following={following === cardKey}
        landscape={landscape}
        onClose={() => setCardKey(null)}
        onDetails={(a) => { setCardKey(null); setFocusAgent(a); }}
        onMessage={(a, text) => mesh.actions.message(a, text)}
        onStop={(a) => mesh.actions.stop(a)}
        onThread={(a) => { setCardKey(null); setPanel({ mode: 'thread', runId: a.runId }); }}
        onShots={(a) => { setCardKey(null); setPanel({ mode: 'gallery', runId: a.runId }); }}
        onTask={openTask}
        onFollow={(a) => { setFollowing((f) => (f === a.sessionKey ? null : a.sessionKey)); nativeHaptic('selection'); }}
        onInApp={openInApp}
        onDecision={(decision) => { setDecisionInitialId(decision.id); setDecisionOpen(true); }}
      />
      <DecisionSheet
        visible={decisionOpen}
        decisions={mesh.decisions}
        initialId={decisionInitialId}
        landscape={landscape}
        onClose={() => { setDecisionOpen(false); setDecisionInitialId(null); }}
        onResolve={async (decision, action, reply) => {
          const result = await mesh.actions.decide(decision, action, reply);
          nativeHaptic('success');
          showToast?.(result?.message || 'Decision applied');
          return result;
        }}
        onOpenLink={(decision) => {
          setDecisionOpen(false);
          setDecisionInitialId(null);
          if (decision.target?.taskId) {
            navigateToScreen(navigation, { screen: 'BoardScreen', params: { taskId: decision.target.taskId }, title: 'Task' }, { gateway });
          } else if (decision.target?.runId) {
            navigateToScreen(navigation, { screen: 'OversightScreen', params: { runId: decision.target.runId }, title: 'Run' }, { gateway });
          }
        }}
      />
      <MeshActionSheet title={sheet?.title} items={sheet?.items || null} onClose={() => setSheet(null)} landscape={landscape} />
      <CompletedSheet
        visible={completedOpen}
        entries={completedEntries}
        httpBase={httpBase}
        landscape={landscape}
        onClose={() => setCompletedOpen(false)}
        onOpen={(e) => {
          setCompletedOpen(false);
          const a = mesh.agents.find((x) => x.runId === e.runId || x.sessionKey === e.sessionKey);
          if (a) flyToAgent(a.sessionKey, 2.4);
          setPanel({ mode: 'thread', runId: e.runId });
        }}
      />
      <ReviewPanel
        panel={panel ? { ...panel, setRun: (runId) => setPanel({ mode: 'thread', runId }) } : null}
        httpBase={httpBase}
        threads={mesh.threads}
        threadsVersion={mesh.threadsVersion}
        loadThread={mesh.loadThread}
        screenshots={mesh.screenshots}
        loadScreenshots={mesh.loadScreenshots}
        landscape={landscape}
        onClose={() => setPanel(null)}
        onOpenRunInApp={(runId) => { setPanel(null); navigateToScreen(navigation, { screen: 'OversightScreen', params: { runId }, title: 'Run' }, { gateway }); }}
      />
      {focusAgent ? (
        <AgentFocusSheet
          agent={{ ...focusAgent, task: focusAgent.currentTask, createdAt: focusAgent.startedAt }}
          provider={PROVIDER_OF[focusAgent.coderBackend] || ASH}
          gateway={gateway}
          federation={federation}
          navigation={navigation}
          onClose={() => setFocusAgent(null)}
          onOpenMore={() => { const m = agentMenu(focusAgent.sessionKey); setFocusAgent(null); setSheet(m); }}
        />
      ) : null}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  viewToggle: { position: 'absolute', flexDirection: 'row', padding: 3, gap: 2, borderRadius: 12, backgroundColor: 'rgba(8,7,4,0.86)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(212,175,55,0.5)' },
  viewBtn: { minWidth: 44, minHeight: 32, paddingHorizontal: 10, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  viewBtnOn: { backgroundColor: '#d4af37' },
  viewBtnText: { color: '#e8dcc0', fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  viewBtnTextOn: { color: '#0b0904' },
  root: { flex: 1, backgroundColor: BG },
  lasso: { position: 'absolute', borderWidth: 1.5, borderColor: '#e9c46a', backgroundColor: 'rgba(233,196,106,0.12)', borderStyle: 'dashed' },
  thumb: { position: 'absolute', borderWidth: 2, borderRadius: 6, overflow: 'hidden', backgroundColor: '#0b0b0d' },
  thumbLabel: { color: '#f4f4f5', fontWeight: '700', paddingHorizontal: 4, paddingVertical: 2, backgroundColor: 'rgba(0,0,0,0.75)' },
  fill: { flex: 1 },
  loading: { position: 'absolute', alignSelf: 'center', top: '45%', alignItems: 'center', gap: 8 },
  loadingText: { color: '#99927d', fontSize: 12 },
  directorBar: { position: 'absolute', left: 8, right: 8, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(212,175,55,0.55)', backgroundColor: 'rgba(10,8,4,0.92)' },
  directorText: { flex: 1, color: '#e9c46a', fontSize: 12, fontWeight: '600' },
  directorBtn: { paddingHorizontal: 10, minHeight: 36, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', justifyContent: 'center' },
  directorBtnText: { color: '#f4f4f5', fontSize: 12, fontWeight: '600' },
});

export default NeuralMeshScreen;
