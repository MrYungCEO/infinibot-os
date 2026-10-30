/**
 * KnowledgeGraphScreen — the web Knowledge Graph, native.
 *
 * Same graph, same code: the snapshot → scene pipeline (filters, sizing by
 * connections, hierarchy, v3 brain/lobe/family layout, grouping, signals) and
 * the three.js stage (cortex, lobes, iconic node shapes, relation-coloured
 * links + ribbons, status rings, super-nodes, labels by zoom, bloom) are the
 * web graph's own modules, bundled from ui/src (see src/kg/generated) and
 * drawn on expo-gl. The chrome around it is native and mirrors the web's
 * phone layout: toolbar + tools strip, status/layer legend, Signals HUD,
 * tap → peek card, Details panel, long-press → action sheet, bulk bar for
 * multi-selection, link / select (lasso) modes, drag onto a project = move,
 * dialogs (consolidate, sub-project consolidation, link/move pickers, tag,
 * delete, spawn agent), AI drawer, toasts with Undo.
 *
 * Touch: one finger orbits (or drags a node), two fingers pinch / pan /
 * twist, double-tap opens a node in the app's own screen. Deep links
 * (infinibot://knowledge/graph|<nodeId>, family / layer / group params) focus
 * the node. The loop pauses when the screen loses focus or the app goes to
 * the background.
 *
 * 2D / 3D: the web's renderer toggle. "2D" is the web's flat map — its own
 * 2D renderer (drawMap2d) driven by a 2D stage with the 3D stage's surface,
 * drawn through react-native-svg (KgMap2DView) — under the same controller
 * and chrome. Builds without expo-gl (an APK older than the 3D stage) run
 * the 2D map with the toggle disabled — never the web page.
 *
 * Tap card: floats beside the tapped node like the web hover card, follows
 * it while the view moves and stays on screen at the edges (KgFloatingCard).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DOCK_BOTTOM_SPACE } from '../components/FloatingDock';
import { navigateToScreen } from '../navigation/screen-registry';
import { useRotationWhileFocused } from '../infini/orientation';
import { devicePerfTier, useAppActive } from '../infini/perf-tier';
import { KgStageView, glStageAvailable } from '../kg/KgStageView';
import { KgMap2DView } from '../kg/KgMap2DView';
import { KgFloatingCard } from '../kg/KgFloatingCard';
import { useKgController } from '../kg/useKgController';
import { openTargetFor } from '../kg/kg-open';
import { deepLinkOf, deepLinkSig, projectScopeOf } from '../kg/kg-deep-link';
import { KgBanner, KgButton, KgHud, KgHudPill, KgLegend, KgModeHint, KgShapeLegend, KgToast, KgToolbar } from '../kg/KgChrome';
import { KgBulkBar, KgDetailPanel, KgGroupSheet, KgMenuSheet, KgSettings } from '../kg/KgCards';
import { KgDialog } from '../kg/KgDialogs';
import { KgAiDrawer } from '../kg/KgAiDrawer';
import { KgOverlay } from '../kg/KgOverlay';
import { KgScopeBar, KgScopeEmpty } from '../kg/KgScopeBar';
import { KG } from '../kg/kg-theme';
import { useTheme } from '../theme/ThemeProvider';
import { useSecureLane, useSecureMode } from '../secure/useSecureMode';
import { SecureBadge, SecureError, SecureToggle, secureFrameStyle } from '../secure/SecureControls';

export function KnowledgeGraphScreen(props) {
  return <KnowledgeGraphMain {...props} can3d={glStageAvailable()} />;
}

function KnowledgeGraphMain({ gateway, navigation, route, can3d }) {
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const landscape = winW > winH;
  useRotationWhileFocused();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const active = focused && appActive;
  const tier = useMemo(() => devicePerfTier(), []);

  const openNode = useCallback(
    (n) => {
      const t = openTargetFor(n);
      if (!t) return;
      const entry = t.tab === 'Board' ? { ...t, params: { ...t.params, _ts: Date.now() } } : t;
      navigateToScreen(navigation, entry, { gateway });
    },
    [navigation, gateway],
  );
  const c = useKgController(gateway, { openNode, active });
  c.can3d = can3d;

  // Secure Mode: the graph follows the gateway's secure lane (secure.graph.snapshot).
  const { colors } = useTheme();
  const secure = useSecureMode(gateway?.sendReq, gateway?.subscribeEvent, { connected: gateway?.status === 'connected' });
  const secureOn = secure.enabled;
  useEffect(() => { c.setSecure(secureOn); }, [secureOn, c]);
  useSecureLane(gateway?.subscribeEvent, ['graph'], () => { if (c.secure) void c.refresh(true); });
  const renderer = c.renderer;

  const [stage, setStage] = useState(null);
  const [glError, setGlError] = useState(null);
  const [stageKey, setStageKey] = useState(0);
  const [groupSheet, setGroupSheet] = useState(false);
  const [fps, setFps] = useState(0);
  const stageSize = useRef({ w: 0, h: 0 });
  const fitInset = useRef(0);
  const [hostSize, setHostSize] = useState({ w: 0, h: 0 });

  // 2D ⇄ 3D: the old stage unmounts; the new one attaches when it's ready.
  const lastRenderer = useRef(renderer);
  useEffect(() => {
    if (lastRenderer.current === renderer) return;
    lastRenderer.current = renderer;
    setStage(null);
    setGlError(null);
    c.attachStage(null);
  }, [renderer, c]);

  // Deep links: in the route at mount, re-applied when they change.
  const params = route?.params || null;
  const sig = deepLinkSig(params);
  const appliedSig = useRef(null);
  useEffect(() => {
    if (appliedSig.current === sig) return;
    const first = appliedSig.current === null;
    appliedSig.current = sig;
    // Project scope (KanbanScreen "Knowledge Graph" / infinibot://knowledge/graph?project=).
    const scope = projectScopeOf(params);
    if (scope) c.setProjectScope(scope);
    else if (params?.project === '' || params?.showAll) c.clearProjectScope();
    const link = deepLinkOf(params);
    if (link) c.applyDeepLink(link, !first);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Landscape is immersive: the app's floating dock steps aside (it would
  // cover a third of a 390 pt-tall stage); portrait keeps it.
  useFocusEffect(
    useCallback(() => {
      const tabs = navigation?.getParent?.();
      if (!tabs?.setOptions) return undefined;
      tabs.setOptions({ tabBarStyle: landscape ? { display: 'none' } : undefined });
      return () => tabs.setOptions({ tabBarStyle: undefined });
    }, [navigation, landscape]),
  );

  // Phone back: the topmost layer first, then leave.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => c.closeTopmost());
      return () => sub.remove();
    }, [c]),
  );

  // FPS readout for the HUD (frames the stage rendered in the last second).
  useEffect(() => {
    if (!globalThis.__kgPerf) globalThis.__kgPerf = { frames: 0, firstPaintAt: null };
    if (!c.hudOpen || !active) return undefined;
    let last = globalThis.__kgPerf.frames || 0;
    const t = setInterval(() => {
      const f = globalThis.__kgPerf?.frames || 0;
      setFps(Math.max(0, f - last));
      last = f;
    }, 1000);
    return () => clearInterval(t);
  }, [c.hudOpen, active]);

  const onStageReady = useCallback(
    (s) => {
      setGlError(null);
      s.setBottomInset?.(fitInset.current);
      setStage(s);
      c.attachStage(s);
      // Harness hook (web export verification, like the web stage's __kg3d* hooks).
      if (Platform.OS === 'web') globalThis.__kgNative = { controller: c, stage: s };
    },
    [c],
  );

  const leave = useCallback(() => {
    if (!c.closeTopmost() && navigation?.canGoBack?.()) navigation.goBack();
  }, [c, navigation]);

  // Panels over the stage that labels must avoid (stage-local rects).
  // Bottom-anchored panels are stored by their bottom offset and resolved
  // against the live stage height: onLayout reports size changes, not moves
  // (react-native-web), so a recorded y goes stale when the stage grows.
  const obstacles = useRef({});
  const obstacleList = useRef(null);
  if (!obstacleList.current) {
    obstacleList.current = {
      get current() {
        const H = stageSize.current.h;
        return Object.values(obstacles.current).map((o) => (o.bottom != null ? { x: o.x, y: H - o.bottom - o.h, w: o.w, h: o.h } : o));
      },
    };
  }
  const trackObstacle = (key, bottom) => (e) => {
    const { x, y, width, height } = e.nativeEvent.layout;
    obstacles.current[key] = bottom != null ? { x, bottom, w: width, h: height } : { x, y, w: width, h: height };
  };
  const dropObstacle = (key) => {
    delete obstacles.current[key];
  };

  const dock = landscape ? 8 + insets.bottom : DOCK_BOTTOM_SPACE + insets.bottom;
  // The flat map frames itself above the floating dock (the 3D stage ignores this).
  fitInset.current = landscape ? 0 : dock - 8;
  // The floating dock covers the stage bottom in portrait: labels / lobe tags avoid it.
  if (!landscape) obstacles.current.dock = { x: 0, bottom: 0, w: 4096, h: Math.max(0, dock - 8) };
  else delete obstacles.current.dock;
  stage?.setBottomInset?.(fitInset.current);
  const side = landscape ? { left: insets.left + 8, right: insets.right + 8 } : { left: 8, right: 8 };
  const sheetBottom = dock;
  const multi = c.selection.size > 1;
  const peek = c.peekId && !c.menu && !c.ai ? c.peekId : null;
  const detail = c.detailId && !multi && !c.ai && !c.menu ? c.detailId : null;
  const bottomBusy = !!(detail || c.menu || multi || c.settingsOpen || groupSheet || c.ai || (c.hudOpen && !landscape));
  if (!c.hudOpen) dropObstacle('hud');
  if (bottomBusy || renderer !== '3d') dropObstacle('shapes');

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingLeft: landscape ? insets.left : 0, paddingRight: landscape ? insets.right : 0 }, secureFrameStyle(colors, secureOn)]} testID="kg-native-screen">
      <KgToolbar
        c={c}
        landscape={landscape}
        can3d={can3d}
        onBack={leave}
        onGroupPress={() => setGroupSheet((v) => !v)}
        secureBadge={secureOn ? <SecureBadge compact /> : null}
        secureSlot={secure.supported ? (
          <SecureToggle
            compact
            value={secureOn}
            busy={secure.busy}
            disabled={gateway?.status !== 'connected'}
            onChange={(on) => void secure.setEnabled(on)}
          />
        ) : null}
      />
      {secure.error ? <SecureError text={secure.error} onDismiss={secure.clearError} style={{ marginHorizontal: 8, marginBottom: 4 }} /> : null}
      <KgScopeBar c={c} />
      <KgLegend c={c} landscape={landscape} />
      <View
        style={styles.stage}
        testID="kg-stage"
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          stageSize.current = { w: width, h: height };
          setHostSize({ w: width, h: height });
          c.setSize(width, height);
        }}
      >
        {renderer === '2d' ? (
          <KgMap2DView
            key="map2d"
            callbacks={c.stageCallbacks}
            reducedMotion={c.reducedMotion}
            tier={tier}
            active={active}
            onRelease={() => c.onStageRelease()}
            onReady={onStageReady}
          />
        ) : glError ? (
          <View style={styles.center}>
            <KgBanner text={`3D view unavailable: ${glError}`} err />
            <View style={{ height: 10 }} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <KgButton icon="refresh" label="Retry" primary onPress={() => { setGlError(null); setStageKey((k) => k + 1); }} />
              <KgButton icon="map-outline" label="Use 2D map" onPress={() => c.setRenderer('2d')} testID="kg-use-2d" />
            </View>
          </View>
        ) : (
          <KgStageView
            key={`gl-${stageKey}`}
            callbacks={c.stageCallbacks}
            reducedMotion={c.reducedMotion}
            tier={tier}
            active={active}
            obstaclesRef={obstacleList.current}
            onRelease={() => c.onStageRelease()}
            onReady={onStageReady}
            onError={(e) => setGlError(String(e?.message || e))}
            onUnavailable={(e) => setGlError(String(e?.message || 'expo-gl missing'))}
          />
        )}
        <KgOverlay c={c} stage={stage} />

        {/* Signals: pill or panel (landscape: a left column; portrait: a sheet above the dock). */}
        {c.hudOpen ? (
          <View
            style={landscape ? [styles.hudSide, { left: side.left, bottom: dock }] : [styles.sheet, { left: 8, right: 8, bottom: sheetBottom, maxHeight: '58%' }]}
            onLayout={trackObstacle('hud', landscape ? undefined : sheetBottom)}
          >
            <KgHud c={c} fps={fps} />
          </View>
        ) : (
          <View style={[styles.pillPos, { left: side.left }]} onLayout={trackObstacle('hud')}>
            <KgHudPill c={c} />
          </View>
        )}

        {/* The 3D node-shape key (the web shows it in 3D only). */}
        {!bottomBusy && renderer === '3d' ? (
          <View style={[styles.shapesPos, { right: side.right, bottom: dock }]} onLayout={trackObstacle('shapes', dock)}>
            <KgShapeLegend />
          </View>
        ) : null}

        <KgModeHint c={c} style={[styles.hint, { bottom: (bottomBusy ? 8 : dock + 70), alignSelf: 'center' }]} />

        {peek && stage ? (
          <KgFloatingCard
            key={peek}
            c={c}
            id={peek}
            stage={stage}
            host={hostSize}
            insets={{ bottom: landscape ? 0 : dock - 8 }}
            onRect={(r) => {
              if (r) obstacles.current.peek = r;
              else delete obstacles.current.peek;
            }}
          />
        ) : null}
        {detail ? (
          <KgDetailPanel c={c} id={detail} style={[styles.sheet, landscape ? [styles.sideCard, { top: 8 }] : { left: 8, right: 8, maxHeight: '62%' }, { bottom: sheetBottom }]} />
        ) : null}
        {multi && !c.menu && !c.ai ? <KgBulkBar c={c} style={[styles.sheet, { left: side.left, right: side.right, bottom: sheetBottom }]} /> : null}
        {c.menu ? (
          <>
            <View style={StyleSheet.absoluteFill} onStartShouldSetResponder={() => true} onResponderRelease={() => c.closeMenu()} />
            <KgMenuSheet c={c} style={[styles.sheet, landscape ? styles.sideCard : { left: 8, right: 8 }, { bottom: sheetBottom, maxHeight: landscape ? '92%' : '62%' }]} />
          </>
        ) : null}
        {c.settingsOpen ? <KgSettings c={c} style={[styles.sheet, landscape ? styles.sideCard : { left: 8, right: 8 }, { bottom: sheetBottom, maxHeight: '70%' }]} /> : null}
        {groupSheet ? (
          <>
            <View style={StyleSheet.absoluteFill} onStartShouldSetResponder={() => true} onResponderRelease={() => setGroupSheet(false)} />
            <KgGroupSheet c={c} onClose={() => setGroupSheet(false)} style={[styles.sheet, landscape ? styles.sideCard : { left: 8, right: 8 }, { bottom: sheetBottom }]} />
          </>
        ) : null}
        {c.ai ? (
          <View style={[styles.sheet, landscape ? [styles.sideCard, { top: 8 }] : { left: 8, right: 8, top: 8 }, { bottom: sheetBottom }]} pointerEvents="box-none">
            <KgAiDrawer
              c={c}
              gateway={gateway}
              onOpenChat={(sessionKey) => navigation?.navigate?.('MainTabs', { screen: 'Chat', params: { sessionKey } })}
            />
          </View>
        ) : null}

        {c.error ? <KgBanner text={c.error} err style={[styles.banner, { top: 8 }]} /> : null}
        {!c.snapshot && c.loading ? <KgBanner text="Mapping projects…" loading style={[styles.banner, { top: 8 }]} /> : null}
        <KgScopeEmpty c={c} />
        {c.snapshot && !c.nodes.length && !c.projectScope ? (
          <View style={styles.center} pointerEvents="none">
            <KgBanner text={c.search ? 'No nodes match · clear search to see all' : 'Nothing to show · enable a layer or status above'} />
          </View>
        ) : null}
        {gateway?.status !== 'connected' && !c.snapshot ? <KgBanner text="Waiting for the gateway…" style={[styles.banner, { top: 44 }]} /> : null}
        <KgToast c={c} style={[styles.toast, { left: side.left, right: side.right, top: 8 }]} />
        {c.busy ? <View style={styles.busy} pointerEvents="none" /> : null}
      </View>
      <KgDialog c={c} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: KG.bg },
  stage: { flex: 1, overflow: 'hidden', backgroundColor: KG.bg },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  sheet: { position: 'absolute' },
  sideCard: { right: 8, width: 340, maxWidth: '48%' },
  hudSide: { position: 'absolute', top: 8, bottom: 8, width: 300, maxWidth: '44%' },
  pillPos: { position: 'absolute', top: 10 },
  shapesPos: { position: 'absolute', maxWidth: '72%' },
  hint: { position: 'absolute', maxWidth: '92%' },
  banner: { position: 'absolute', alignSelf: 'center' },
  toast: { position: 'absolute' },
  busy: { position: 'absolute', left: 0, right: 0, top: 0, height: 2, backgroundColor: KG.gold, opacity: 0.8 },
});

export default KnowledgeGraphScreen;
