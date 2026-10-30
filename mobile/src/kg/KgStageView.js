/**
 * KgStageView — the web Knowledge Graph's three.js stage, drawn natively.
 *
 * Runs the SAME KnowledgeGraph3DStage + glow3d layers the web graph uses
 * (bundled from ui/src into ./generated/kg-stage.js) on an expo-gl context:
 * brain cortex, lobes, iconic instanced node shapes, relation-coloured links
 * and ribbons, status rings, super-nodes, nebula/starfield/grid, bloom where
 * the GPU can render half-float targets (post chain + ACES either way).
 *
 * The stage's DOM pieces are replaced by native ones: labels + leader lines
 * render in an RN overlay (KgLabelLayer), touches go through kg-gestures, the
 * render loop pauses when the screen loses focus / the app backgrounds.
 *
 * expo-gl ships in Expo Go and (from this build on) the APK. A build without
 * it reports `onUnavailable` instead of crashing.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { PixelRatio, Platform, StyleSheet, View } from 'react-native';

import { KgLabelLayer } from './KgLabelLayer';
import { createTouchRouter, wheelRatio } from './kg-gestures';
import { effectsFor, glSurfaceFor, probeHalfFloat } from './kg-gl-surface';

let GLView = null;
let stageModule = null;
let loadError = null;
try {
  // eslint-disable-next-line global-require
  GLView = require('expo-gl').GLView;
  // eslint-disable-next-line global-require
  stageModule = require('./generated/kg-stage');
} catch (e) {
  loadError = e;
}

/** True when this build can draw the 3D stage. */
export function glStageAvailable() {
  return !!(GLView && stageModule);
}

export const KgStageView = forwardRef(function KgStageView(
  { callbacks, reducedMotion = false, tier = 'high', active = true, obstaclesRef, onReady, onError, onUnavailable, onRelease, style },
  ref,
) {
  const [size, setSize] = useState(null);
  const sizeRef = useRef(null);
  const stageRef = useRef(null);
  const surfaceRef = useRef(null);
  const pauseRef = useRef(null);
  const routerRef = useRef(null);
  const labelsRef = useRef(null);
  const hostRef = useRef(null);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  useImperativeHandle(ref, () => ({
    get stage() {
      return stageRef.current;
    },
  }));

  useEffect(() => {
    if (!glStageAvailable()) onUnavailable?.(loadError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pause the loop when the screen is unfocused / the app is in the background.
  useEffect(() => {
    pauseRef.current?.set(!!active);
  }, [active]);

  useEffect(() => () => {
    try {
      stageRef.current?.dispose();
    } catch {
      /* already gone */
    }
    stageRef.current = null;
  }, []);

  const onLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    const next = { w: Math.max(2, Math.round(width)), h: Math.max(2, Math.round(height)) };
    const prev = sizeRef.current;
    sizeRef.current = next;
    if (!prev) setSize(next);
    else if (prev.w !== next.w || prev.h !== next.h) {
      surfaceRef.current?.setSize(next.w, next.h);
      stageRef.current?.resize();
    }
  }, []);

  const onContextCreate = useCallback((gl) => {
    try {
      const { KnowledgeGraph3DStage, manualPause } = stageModule;
      // The glow layers size points by window.devicePixelRatio (RN: window === global).
      if (Platform.OS !== 'web' && globalThis.devicePixelRatio == null) globalThis.devicePixelRatio = PixelRatio.get();
      const pause = manualPause(!!active);
      pauseRef.current = pause;
      const half = probeHalfFloat(gl);
      const fx = effectsFor(half, tier);
      const surface = glSurfaceFor(gl, {
        size: () => sizeRef.current || { w: 2, h: 2 },
        halfFloat: half,
        // Bloom everywhere: half-float + half res where the GPU can, the 8-bit
        // quarter-res fallback otherwise (and on the low tier).
        bloom: fx.bloom,
        bloomDivisor: fx.bloomDivisor,
        pause,
        writeLabels: (labels, leaders) => labelsRef.current?.set(labels, leaders),
        obstacles: () => obstaclesRef?.current || [],
      });
      surfaceRef.current = surface;
      // Fixed callbacks object: the stage keeps it; the screen's latest handlers are read through the ref.
      const cb = new Proxy({}, { get: (_t, k) => (...args) => cbRef.current?.[k]?.(...args) });
      const stage = new KnowledgeGraph3DStage(null, cb, { reducedMotion, mobile: true, surface });
      stageRef.current = stage;
      routerRef.current = createTouchRouter(stage);
      onReady?.(stage);
    } catch (e) {
      onError?.(e);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Web export: mouse wheel zoom (pinch has no mouse equivalent).
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const el = hostRef.current;
    if (!el || typeof el.addEventListener !== 'function') return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      stageRef.current?.dollyBy(wheelRatio(e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [size]);

  // locationX/Y of each touch is relative to the view the touch STARTED on;
  // derive stage-local points from page coordinates and the host's offset.
  const originRef = useRef({ x: 0, y: 0 });
  const local = (e) => {
    const o = originRef.current;
    return Array.from(e.nativeEvent.touches || []).map((t) => ({ id: t.identifier, x: t.pageX - o.x, y: t.pageY - o.y }));
  };
  const measureOrigin = (e) => {
    const t = e.nativeEvent;
    // pageX - locationX = the host's page offset (the touch landed on the host or a child at 0,0 of it).
    if (t.pageX != null && t.locationX != null) originRef.current = { x: t.pageX - t.locationX, y: t.pageY - t.locationY };
  };

  const responder = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e) => {
      measureOrigin(e);
      routerRef.current?.start(local(e));
    },
    onResponderStart: (e) => routerRef.current?.start(local(e)),
    onResponderMove: (e) => routerRef.current?.move(local(e)),
    onResponderEnd: (e) => {
      // The last finger is handled by onResponderRelease.
      if (!(e.nativeEvent.touches || []).length) return;
      const o = originRef.current;
      const ch = e.nativeEvent.changedTouches?.[0];
      routerRef.current?.end(local(e), ch ? { x: ch.pageX - o.x, y: ch.pageY - o.y } : null);
    },
    onResponderRelease: (e) => {
      const o = originRef.current;
      const ch = e.nativeEvent.changedTouches?.[0] || e.nativeEvent;
      routerRef.current?.end([], ch && ch.pageX != null ? { x: ch.pageX - o.x, y: ch.pageY - o.y } : null);
      onRelease?.();
    },
    onResponderTerminate: () => {
      routerRef.current?.cancel();
      onRelease?.();
    },
  };

  return (
    <View ref={hostRef} style={[styles.host, style]} onLayout={onLayout} {...responder}>
      {size && GLView ? (
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} pointerEvents="none" />
      ) : null}
      <KgLabelLayer ref={labelsRef} />
    </View>
  );
});

export const KG_STAGE_DPR = PixelRatio.get();

const styles = StyleSheet.create({
  host: { flex: 1, overflow: 'hidden', backgroundColor: '#030207' },
});
