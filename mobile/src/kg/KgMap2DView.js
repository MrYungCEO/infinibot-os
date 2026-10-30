/**
 * KgMap2DView — the web Knowledge Graph's flat 2D map, drawn natively.
 *
 * Runs the SAME 2D renderer the web graph uses in its 2D mode (drawMap2d,
 * bundled from ui/src into ./generated/kg-core.js) through a 2D stage with
 * the 3D stage's method surface (KnowledgeGraphMap2DStage), so the screen's
 * controller drives either renderer. Each frame is recorded by a
 * Canvas2D → SVG context (kg-svg-ctx) and rendered with react-native-svg:
 * the status-orbit guides, group zones, curved gradient links, radial-
 * gradient orbs + client hexagons with glow, progress rings, live pulse,
 * focus / selection bezels and collision-free Inter labels.
 *
 * The stage background is the web `.kg-stage`: an 8 px gold dot grid, a
 * centre glow and a vignette over #08060f.
 *
 * Touch goes through the shared router (kg-gestures): one finger drags a
 * node / pans, two fingers pinch-zoom around their midpoint, long-press =
 * menu, double-tap = open. The web export also zooms with the mouse wheel.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, Pattern, RadialGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';

import * as core from './generated/kg-core';
import { createTouchRouter } from './kg-gestures';
import { INTER_FAMILY, SvgCtx } from './kg-svg-ctx';

const { KnowledgeGraphMap2DStage } = core;

/** "rgba(r,g,b,a)" → [colour, opacity] for <Stop> (native Stop wants them split). */
export function splitColor(c) {
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(String(c));
  if (m) return [`rgb(${m[1]},${m[2]},${m[3]})`, Number(m[4])];
  return [String(c), 1];
}

/** Web wheel zoom (knowledge-graph.ts onWheel): exp(-deltaY × 0.0015). */
export function wheelFactor2d(deltaY) {
  return Math.exp(-deltaY * 0.0015);
}

function GradientDef({ d }) {
  const stops = d.stops.map((s, i) => {
    const [color, op] = splitColor(s.color);
    return <Stop key={i} offset={Math.max(0, Math.min(1, s.offset))} stopColor={color} stopOpacity={op} />;
  });
  const units = d.units === 'bbox' ? 'objectBoundingBox' : 'userSpaceOnUse';
  if (d.type === 'linear') {
    return (
      <LinearGradient id={d.id} gradientUnits={units} x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2}>
        {stops}
      </LinearGradient>
    );
  }
  return (
    <RadialGradient id={d.id} gradientUnits={units} cx={d.cx} cy={d.cy} rx={d.rx ?? d.r} ry={d.ry ?? d.r} fx={d.fx} fy={d.fy}>
      {stops}
    </RadialGradient>
  );
}

function Item({ it }) {
  if (it.t === 'path') {
    return (
      <Path
        d={it.d}
        fill={it.fill || 'none'}
        stroke={it.stroke}
        strokeWidth={it.sw}
        strokeLinecap={it.cap}
        strokeLinejoin={it.join}
        strokeDasharray={it.dash}
        strokeDashoffset={it.dashOff}
        opacity={it.o}
      />
    );
  }
  if (it.t === 'circle') return <Circle cx={it.cx} cy={it.cy} r={it.r} fill={it.fill} opacity={it.o} />;
  if (it.t === 'text') {
    return (
      <SvgText
        x={it.x}
        y={it.y}
        fontSize={it.fs}
        fontFamily={INTER_FAMILY[it.w >= 650 ? 700 : it.w >= 550 ? 600 : it.w >= 450 ? 500 : 400]}
        textAnchor={it.anchor}
        fill={it.fill}
        stroke={it.stroke}
        strokeWidth={it.sw}
        strokeLinejoin={it.join}
        opacity={it.o}
      >
        {it.text}
      </SvgText>
    );
  }
  return null;
}

/** The `.kg-stage` backdrop (dot grid + centre glow + vignette). */
const Backdrop = React.memo(function Backdrop({ w, h }) {
  return (
    <Svg style={StyleSheet.absoluteFill} width={w} height={h} pointerEvents="none">
      <Defs>
        <Pattern id="kgdots" width={8} height={8} patternUnits="userSpaceOnUse">
          <Circle cx={1} cy={1} r={0.7} fill="rgba(212,175,55,0.12)" />
        </Pattern>
        <RadialGradient id="kgglow" cx="50%" cy="50%" rx="50%" ry="50%">
          <Stop offset="0" stopColor="#d4af37" stopOpacity={0.08} />
          <Stop offset="0.55" stopColor="#d4af37" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="kgvig" cx="50%" cy="50%" rx="50%" ry="50%">
          <Stop offset="0.55" stopColor="#000000" stopOpacity={0} />
          <Stop offset="1" stopColor="#000000" stopOpacity={0.55} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="#08060f" />
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#kgvig)" />
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#kgglow)" />
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#kgdots)" />
    </Svg>
  );
});

export const KgMap2DView = forwardRef(function KgMap2DView(
  { callbacks, reducedMotion = false, tier = 'high', active = true, onReady, onRelease, style },
  ref,
) {
  const [frame, setFrame] = useState(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const stageRef = useRef(null);
  const routerRef = useRef(null);
  const rafRef = useRef(null);
  const hostRef = useRef(null);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const readyRef = useRef(false);

  const draw = useCallback(() => {
    rafRef.current = null;
    const s = stageRef.current;
    if (!s || !sizeRef.current.w) return;
    const ctx = new SvgCtx();
    const res = s.frame(ctx);
    if (!globalThis.__kgPerf) globalThis.__kgPerf = { frames: 0, firstPaintAt: null };
    globalThis.__kgPerf.frames = (globalThis.__kgPerf.frames || 0) + 1;
    globalThis.__kgPerf.visible2d = res.visible;
    setFrame(ctx.list());
  }, []);

  if (!stageRef.current) {
    const cb = new Proxy({}, { get: (_t, k) => (...args) => cbRef.current?.[k]?.(...args) });
    stageRef.current = new KnowledgeGraphMap2DStage(
      cb,
      {
        size: () => sizeRef.current,
        dpr: 1,
        requestDraw: () => {
          if (rafRef.current == null) rafRef.current = requestAnimationFrame(draw);
        },
      },
      // The live pulse / marching ants: ~15 fps (low tier ~10 fps) — each SVG
      // frame is a full React render, so the ambient loop stays light.
      { reducedMotion, frameInterval: tier === 'low' ? 100 : 66 },
    );
    routerRef.current = createTouchRouter(stageRef.current);
  }

  useImperativeHandle(ref, () => ({
    get stage() {
      return stageRef.current;
    },
  }));

  useEffect(() => {
    stageRef.current?.setActive(!!active);
  }, [active]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      stageRef.current?.dispose();
    },
    [],
  );

  const onLayout = useCallback(
    (e) => {
      const { width, height } = e.nativeEvent.layout;
      const next = { w: Math.max(2, Math.round(width)), h: Math.max(2, Math.round(height)) };
      const prev = sizeRef.current;
      sizeRef.current = next;
      setBox(next);
      if (!readyRef.current) {
        readyRef.current = true;
        onReady?.(stageRef.current);
      } else if (prev.w !== next.w || prev.h !== next.h) stageRef.current?.resize();
      stageRef.current?.requestRender();
    },
    [onReady],
  );

  // Web export: mouse wheel zooms around the pointer (the web map's onWheel).
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const el = hostRef.current;
    if (!el || typeof el.addEventListener !== 'function') return undefined;
    const onWheel = (ev) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      stageRef.current?.dollyBy(wheelFactor2d(ev.deltaY), ev.clientX - r.left, ev.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Touch → stage px (see KgStageView: locationX is relative to the touched child).
  const originRef = useRef({ x: 0, y: 0 });
  const local = (e) => {
    const o = originRef.current;
    return Array.from(e.nativeEvent.touches || []).map((t) => ({ id: t.identifier, x: t.pageX - o.x, y: t.pageY - o.y }));
  };
  const measureOrigin = (e) => {
    const t = e.nativeEvent;
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
    <View ref={hostRef} style={[styles.host, style]} onLayout={onLayout} testID="kg-map2d" {...responder}>
      {box.w ? <Backdrop w={box.w} h={box.h} /> : null}
      {frame && box.w ? (
        <Svg style={StyleSheet.absoluteFill} width={box.w} height={box.h} pointerEvents="none">
          <Defs>
            {frame.defs.map((d) => (
              <GradientDef key={d.id} d={d} />
            ))}
          </Defs>
          <G>
            {frame.items.map((it, i) => (
              <Item key={i} it={it} />
            ))}
          </G>
        </Svg>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  host: { flex: 1, overflow: 'hidden', backgroundColor: '#08060f' },
});
