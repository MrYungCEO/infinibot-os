/**
 * Mesh3DView — the web Agent Mesh's 3D world, drawn on expo-gl.
 *
 * Runs the SAME MeshWorldModel + MeshWorldScene the web <mesh-world-3d> uses
 * (bundled from ui/src into lib/mesh/generated/mesh3d.js): station sectors,
 * Plugin District buildings, federation islands, instanced agents with live
 * status, delegation / federation beams. The model is fed from useAgentMesh's
 * snapshot (loadSnapshot) plus the bridge's WorldEvent queue (beams, sparks),
 * so the 2D and 3D views count the same agents and plugins.
 *
 * Native pieces: touches go through mesh3d-gestures, name tags render in an
 * RN overlay where there is no 2D canvas (the web export keeps the in-GL
 * atlas), the loop pauses when `active` is false. A build without expo-gl
 * reports `onUnavailable` instead of crashing.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { PixelRatio, Platform, StyleSheet, Text, View } from 'react-native';

import { glSurfaceFor, probeHalfFloat } from '../../kg/kg-gl-surface';
import { createMesh3DTouchRouter } from '../../lib/mesh/mesh3d-gestures';

let GLView = null;
let mesh3d = null;
let loadError = null;
try {
  // eslint-disable-next-line global-require
  GLView = require('expo-gl').GLView;
  // eslint-disable-next-line global-require
  mesh3d = require('../../lib/mesh/generated/mesh3d');
} catch (e) {
  loadError = e;
}

/** True when this build can draw the 3D world. */
export function mesh3dAvailable() {
  return !!(GLView && mesh3d);
}

const STATE_DOT = { working: '#fbbf24', waiting: '#a78bfa', error: '#ef4444', done: '#22c55e', idle: '#94a3b8' };
const LABEL_MS = 100;

export const Mesh3DView = forwardRef(function Mesh3DView(
  { agents, nodes, plugins, tools, drainWorldEvents, selectedKey, followKey, reducedMotion = false, active = true, theme, onAgentPress, onZonePress, onReady, onError, onUnavailable, onStats, style },
  ref,
) {
  const [size, setSize] = useState(null);
  const [anchors, setAnchors] = useState([]);
  const sizeRef = useRef(null);
  const sceneRef = useRef(null);
  const modelRef = useRef(null);
  const surfaceRef = useRef(null);
  const routerRef = useRef(null);
  const lastFx = useRef(0);
  const hostRef = useRef(null);
  const cbRef = useRef({ onAgentPress, onZonePress, onStats });
  cbRef.current = { onAgentPress, onZonePress, onStats };
  const nativeLabels = Platform.OS !== 'web';

  useImperativeHandle(ref, () => ({
    get scene() {
      return sceneRef.current;
    },
    get model() {
      return modelRef.current;
    },
    zoomBy: (f) => sceneRef.current?.zoomBy(f),
    resetView: () => sceneRef.current?.resetView(),
    flyToAgent: (key) => sceneRef.current?.flyToAgent(key),
    flyToZone: (id) => sceneRef.current?.flyToZone(id),
    zone: (id) => modelRef.current?.layout().zones.find((z) => z.id === id) || null,
  }));

  useEffect(() => {
    if (!mesh3dAvailable()) onUnavailable?.(loadError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Model → scene: snapshot on every data change, bridge events for beams.
  const sync = useCallback(() => {
    const m = modelRef.current;
    const scene = sceneRef.current;
    if (!m) return;
    const events = drainWorldEvents?.() || [];
    if (events.length) m.apply(events);
    m.loadSnapshot({ agents, nodes, plugins, tools });
    if (!scene) return;
    scene.setLayout(m.layout());
    const fx = m.effectsSince(lastFx.current);
    if (fx.length) {
      lastFx.current = fx[fx.length - 1].id;
      scene.playEffects(fx);
    }
  }, [agents, nodes, plugins, tools, drainWorldEvents]);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  useEffect(() => { sync(); }, [sync]);
  // Beams arrive between snapshots: drain the bridge queue a few times a second.
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => syncRef.current(), 400);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => { sceneRef.current?.setActive(!!active); }, [active]);
  useEffect(() => { sceneRef.current?.select(selectedKey || null); }, [selectedKey]);
  useEffect(() => { sceneRef.current?.setFollow(followKey || null); }, [followKey]);
  useEffect(() => { sceneRef.current?.setReducedMotion(!!reducedMotion); }, [reducedMotion]);
  // Appearance theme → the world palette (one accent, obsidian / porcelain).
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const themeKey = theme ? `${theme.mode}|${theme.primary}|${theme.secondary}` : '';
  useEffect(() => { if (theme) sceneRef.current?.setTheme(theme); }, [themeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Name tags (native only) + HUD stats, ~10 Hz.
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => {
      const scene = sceneRef.current;
      if (!scene) return;
      // (anchors carry the agent panels on every platform; tags + signs only natively)
      const all = scene.labelAnchors();
      setAnchors(nativeLabels ? all : all.filter((a) => a.kind === 'panel'));
      cbRef.current.onStats?.(scene.stats());
    }, LABEL_MS);
    return () => clearInterval(t);
  }, [active, nativeLabels]);
  const pal = sceneRef.current?.palette;
  const accent = pal ? hexCss(pal.accent) : '#d4af37';
  const lightMode = pal?.mode === 'light';

  useEffect(() => () => {
    try {
      sceneRef.current?.dispose();
    } catch {
      /* already gone */
    }
    // Drop every handle: RN-web keeps layout handlers on the host node, so a
    // lingering node must not pin the scene or model.
    sceneRef.current = null;
    routerRef.current = null;
    surfaceRef.current = null;
    modelRef.current = null;
  }, []);

  const onLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    const next = { w: Math.max(2, Math.round(width)), h: Math.max(2, Math.round(height)) };
    const prev = sizeRef.current;
    sizeRef.current = next;
    if (!prev) setSize(next);
    else if (prev.w !== next.w || prev.h !== next.h) {
      surfaceRef.current?.setSize(next.w, next.h);
      sceneRef.current?.resize();
    }
  }, []);

  const onContextCreate = useCallback((gl) => {
    try {
      const { MeshWorldModel, MeshWorldScene } = mesh3d;
      if (Platform.OS !== 'web' && globalThis.devicePixelRatio == null) globalThis.devicePixelRatio = PixelRatio.get();
      const half = probeHalfFloat(gl);
      const surface = glSurfaceFor(gl, { size: () => sizeRef.current || { w: 2, h: 2 }, halfFloat: half, bloom: half, bloomDivisor: 2 });
      surfaceRef.current = surface;
      if (!modelRef.current) modelRef.current = new MeshWorldModel();
      const scene = new MeshWorldScene(
        { surface, mobile: true, reducedMotion, quality: 'auto', labels: !nativeLabels, theme: themeRef.current || undefined, reflections: half },
        {
          onAgentClick: (key) => cbRef.current.onAgentPress?.(key),
          onZoneClick: (id) => cbRef.current.onZonePress?.(id, modelRef.current?.layout().zones.find((z) => z.id === id) || null),
        },
      );
      sceneRef.current = scene;
      // Agent panels are drawn by this view (RN), at a phone-sized box.
      scene.setPanelBox({ w: PANEL.w, h: PANEL.h, ew: PANEL.w, eh: PANEL.h });
      routerRef.current = createMesh3DTouchRouter(scene);
      syncRef.current();
      scene.select(selectedKey || null);
      scene.resetView(0);
      scene.setActive(!!active);
      onReady?.(scene);
    } catch (e) {
      onError?.(e);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Web export: mouse wheel zoom.
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const el = hostRef.current;
    if (!el || typeof el.addEventListener !== 'function') return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      sceneRef.current?.zoomBy(Math.pow(1.0015, Math.max(-200, Math.min(200, e.deltaY))), 0);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [size]);

  const originRef = useRef({ x: 0, y: 0 });
  const local = (e) => {
    const o = originRef.current;
    return Array.from(e.nativeEvent.touches || []).map((t) => ({ id: t.identifier, x: t.pageX - o.x, y: t.pageY - o.y }));
  };
  const lifted = (e) => {
    const o = originRef.current;
    const ch = e.nativeEvent.changedTouches?.[0] || e.nativeEvent;
    return ch && ch.pageX != null ? { x: ch.pageX - o.x, y: ch.pageY - o.y } : null;
  };
  const responder = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e) => {
      const t = e.nativeEvent;
      if (t.pageX != null && t.locationX != null) originRef.current = { x: t.pageX - t.locationX, y: t.pageY - t.locationY };
      routerRef.current?.start(local(e));
    },
    onResponderStart: (e) => routerRef.current?.start(local(e)),
    onResponderMove: (e) => routerRef.current?.move(local(e)),
    onResponderEnd: (e) => {
      if (!(e.nativeEvent.touches || []).length) return;
      routerRef.current?.end(local(e), lifted(e));
    },
    onResponderRelease: (e) => routerRef.current?.end([], lifted(e)),
    onResponderTerminate: () => routerRef.current?.cancel(),
  };

  return (
    <View ref={hostRef} style={[styles.host, style]} onLayout={onLayout} testID="mesh3d-native" {...responder}>
      {size && GLView ? <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} pointerEvents="none" /> : null}
      {anchors.length ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {anchors.map((a) =>
            a.kind === 'panel' ? (
              <AgentPanel key={`p:${a.id}`} a={a} accent={accent} light={lightMode} tone={pal ? hexCss(pal.state[a.state] ?? pal.accent) : STATE_DOT[a.state] || STATE_DOT.idle} />
            ) : a.kind === 'zone' ? (
              <View key={`z:${a.id}`} style={[styles.zone, { left: a.x - 80, top: a.y - 38, opacity: a.alpha }]}>
                <View style={styles.zoneCard}>
                  <Text style={styles.zoneText} numberOfLines={1}>{a.name}</Text>
                  {a.sub ? <Text style={styles.zoneSub} numberOfLines={1}>{a.sub}</Text> : null}
                </View>
              </View>
            ) : (
              <View key={`a:${a.id}`} style={[styles.tag, a.pinned && styles.tagPinned, { left: a.x - 70, top: a.y - 30, opacity: a.alpha }]}>
                <View style={[styles.tagPill, a.pinned && styles.tagPillPinned]}>
                  <View style={[styles.chip, { backgroundColor: STATE_DOT[a.state] || STATE_DOT.idle }]}>
                    <Text style={styles.chipGlyph}>{ACTIVITY_GLYPH[a.activity] || '·'}</Text>
                  </View>
                  <Text style={styles.tagText} numberOfLines={1}>{a.name}</Text>
                </View>
              </View>
            ),
          )}
        </View>
      ) : null}
    </View>
  );
});

const PANEL = { w: 184, h: 84 };
const hexCss = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const ACTIVITY_LABEL = { type: 'Typing', think: 'Thinking', talk: 'Talking', wait: 'Waiting', error: 'Error', rest: 'Resting', idle: 'Idle', walk: 'Walking' };
const STATE_LABEL = { working: 'Working', waiting: 'Waiting', error: 'Error', done: 'Done', idle: 'Idle' };

function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Floating glass HUD card above a working agent (the web's 3D overlay panel,
 * phone-sized): name, status, task, live tool line, progress, elapsed.
 * Bottom-anchored just above the agent's head; tapping the agent opens the
 * agent sheet (same as 2D).
 */
function AgentPanel({ a, accent, tone, light }) {
  const s = a.scale || 1;
  const pct = typeof a.progress === 'number' && a.progress > 0 ? Math.min(100, a.progress <= 1 ? a.progress * 100 : a.progress) : null;
  const elapsed = a.startedAt ? fmtElapsed(Date.now() - a.startedAt) : '';
  return (
    <View
      testID="mesh3d-native-panel"
      style={[
        styles.panel,
        light && styles.panelLight,
        { borderColor: accent + (a.pinned ? 'cc' : '66'), left: a.x - PANEL.w / 2, top: a.y - PANEL.h / 2 - (PANEL.h / 2) * s - 4, opacity: a.alpha, transform: [{ scale: s }] },
      ]}
    >
      <View style={styles.panelHead}>
        <View style={[styles.panelRing, { borderColor: tone }]}><View style={[styles.panelDot, { backgroundColor: tone }]} /></View>
        <Text style={[styles.panelName, light && styles.inkLight]} numberOfLines={1}>{a.name}</Text>
        {elapsed ? <Text style={[styles.panelTime, light && styles.dimLight]}>{elapsed}</Text> : null}
      </View>
      <Text style={[styles.panelState, light && styles.dimLight]} numberOfLines={1}>
        <Text style={{ color: tone, fontWeight: '800' }}>{STATE_LABEL[a.state] || 'Idle'}</Text>
        {a.activity ? ` · ${ACTIVITY_LABEL[a.activity] || ''}` : ''}
      </Text>
      <Text style={[styles.panelTask, light && styles.inkLight]} numberOfLines={1}>{a.task || a.sub || 'No task reported'}</Text>
      {a.tool ? <Text style={[styles.panelTool, { color: accent }]} numberOfLines={1}>{`›_ ${a.tool}`}</Text> : null}
      <View style={styles.panelBar}><View style={[styles.panelFill, { backgroundColor: accent, width: pct == null ? '36%' : `${pct}%`, opacity: pct == null ? 0.5 : 1 }]} /></View>
    </View>
  );
}

/** Status-chip glyph per activity (same states the in-GL web tags draw). */
const ACTIVITY_GLYPH = { type: '>_', think: '…', talk: '“', wait: '⧖', error: '!', rest: '✓', idle: 'z', walk: '→' };

const styles = StyleSheet.create({
  host: { flex: 1, overflow: 'hidden', backgroundColor: '#050508' },
  tag: { position: 'absolute', width: 140, alignItems: 'center' },
  tagPinned: { zIndex: 2 },
  tagPill: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 140, backgroundColor: 'rgba(9,9,13,0.9)', borderColor: 'rgba(212,175,55,0.55)', borderWidth: 1, borderRadius: 12, paddingLeft: 2, paddingRight: 8, paddingVertical: 2 },
  tagPillPinned: { borderColor: '#f5d77a', borderWidth: 1.5 },
  chip: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  chipGlyph: { color: '#121216', fontSize: 9, fontWeight: '800', lineHeight: 11 },
  tagText: { flexShrink: 1, color: '#f6f1e4', fontSize: 11, fontWeight: '600' },
  zone: { position: 'absolute', width: 160, alignItems: 'center' },
  zoneCard: { maxWidth: 160, backgroundColor: 'rgba(8,8,12,0.88)', borderColor: 'rgba(212,175,55,0.38)', borderWidth: 1, borderLeftWidth: 3, borderLeftColor: '#d4af37', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  zoneText: { color: '#f7e7b4', fontSize: 10, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  zoneSub: { color: 'rgba(236,231,218,0.9)', fontSize: 9, fontWeight: '500', marginTop: 1 },
  panel: { position: 'absolute', width: PANEL.w, height: PANEL.h, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 11, borderWidth: 1, backgroundColor: 'rgba(9,9,12,0.84)', overflow: 'hidden' },
  panelLight: { backgroundColor: 'rgba(250,249,245,0.9)' },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  panelRing: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  panelDot: { width: 5, height: 5, borderRadius: 3 },
  panelName: { flex: 1, color: '#f2ecdd', fontSize: 11.5, fontWeight: '700' },
  panelTime: { color: 'rgba(236,230,214,0.6)', fontSize: 9.5, fontVariant: ['tabular-nums'] },
  panelState: { color: 'rgba(236,230,214,0.6)', fontSize: 8.5, letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 2, marginLeft: 18 },
  panelTask: { color: '#f2ecdd', fontSize: 10.5, marginTop: 3 },
  panelTool: { fontSize: 9, marginTop: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  panelBar: { height: 2.5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.1)', marginTop: 5, overflow: 'hidden' },
  panelFill: { height: '100%' },
  inkLight: { color: '#22201c' },
  dimLight: { color: 'rgba(40,38,34,0.62)' },
});
