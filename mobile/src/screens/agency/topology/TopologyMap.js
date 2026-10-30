/**
 * TopologyMap — the react-native-svg map for Agency Topology.
 *
 * The SVG is drawn in WORLD space under one committed camera transform, so
 * strokes and text are re-rasterised crisp after every gesture. During a
 * pinch / pan, Reanimated transforms the whole canvas on the UI thread (no
 * React renders); on release the delta is folded into the camera
 * (commitGesture) and the SVG redraws once — the same model as the native
 * Knowledge Graph.
 *
 * Gestures: one-finger pan, pinch zoom (focal point stays put), double-tap to
 * zoom in, tap a node (or its label) → onSelect(node), tap empty space →
 * onSelect(null). Imperative handle: fit(), zoomBy(f), centerOn(nodeId).
 */
import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path, Rect, Text as SvgText } from 'react-native-svg';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { MONO_FAMILY, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  centerOnNode,
  commitGesture,
  fitCamera,
  hitTest,
  initialCamera,
  shapeHalfWidth,
  shapePath,
  truncate,
  zoomAt,
} from './topology-model';

export function toneOf(colors, tone) {
  switch (tone) {
    case 'primary': return colors.primary;
    case 'success': return colors.success;
    case 'info': return colors.info;
    case 'warning': return colors.warning;
    case 'danger': return colors.error;
    default: return colors.textMuted;
  }
}

const NodeMark = memo(function NodeMark({ node, colors, dim, hit, selected, showLabel, font }) {
  const fill = toneOf(colors, node.tone);
  const accent = node.accent ? toneOf(colors, node.accent) : withAlpha(fill, 0.55);
  const half = shapeHalfWidth(node);
  const d = shapePath(node.shape, node.x, node.y, node.size);
  const body = node.faint
    ? { fill: withAlpha(fill, 0.22), stroke: fill, strokeWidth: 1.4 }
    : { fill: withAlpha(fill, 0.9), stroke: accent, strokeWidth: node.accent ? 2 : 1.5 };
  const halo = { stroke: withAlpha(colors.background, 0.85), strokeWidth: 3, paintOrder: 'stroke' };
  const right = node.labelPlacement === 'right';
  const below = node.labelPlacement === 'below';
  const sub = node.showSub && node.sublabel ? truncate(node.sublabel, node.labelMax) : null;
  return (
    <G opacity={dim ? 0.22 : 1}>
      {selected ? <Circle cx={node.x} cy={node.y} r={half + 7} fill="none" stroke={colors.primary} strokeWidth={2.2} /> : null}
      {hit && !selected ? <Circle cx={node.x} cy={node.y} r={half + 6} fill="none" stroke={colors.text} strokeWidth={1.4} strokeDasharray="3 3" /> : null}
      {d ? <Path d={d} {...body} /> : <Circle cx={node.x} cy={node.y} r={node.size} {...body} />}
      {showLabel && right ? (
        <>
          <SvgText x={node.x + half + 7} y={sub ? node.y - 1 : node.y + 4} fill={selected ? colors.primary : withAlpha(colors.text, 0.92)} fontSize={12} fontFamily={font} {...halo}>
            {truncate(node.name, node.labelMax)}
          </SvgText>
          {sub ? (
            <SvgText x={node.x + half + 7} y={node.y + 13} fill={colors.textMuted} fontSize={12} fontFamily={font} {...halo}>
              {sub}
            </SvgText>
          ) : null}
        </>
      ) : null}
      {showLabel && below ? (
        <SvgText x={node.x} y={node.y + (node.shape === 'roundedRect' ? node.size * 0.8 : node.size) + 15} fill={selected ? colors.primary : withAlpha(colors.text, 0.9)} fontSize={12} fontFamily={font} textAnchor="middle" {...halo}>
          {truncate(node.name, node.labelMax)}
        </SvgText>
      ) : null}
    </G>
  );
});

const Scene = memo(function Scene({ layout, colors, selectedId, matches, dense, showLabels }) {
  const edgeStyle = (kind) => {
    if (kind === 'reports') return { stroke: withAlpha(colors.primary, 0.7), strokeWidth: 1.6 };
    if (kind === 'root') return { stroke: withAlpha(colors.primary, 0.42), strokeWidth: 1.4, strokeDasharray: '4 4' };
    if (kind === 'assigned') return { stroke: withAlpha(colors.info, 0.55), strokeWidth: 1.4 };
    return { stroke: withAlpha(colors.textMuted, dense ? 0.22 : 0.5), strokeWidth: 1.2 };
  };
  return (
    <>
      {layout.regions.map((r) => {
        const c = toneOf(colors, r.tone);
        return (
          <G key={r.id}>
            <Rect x={r.x} y={r.y} width={r.width} height={r.height} rx={10} fill={withAlpha(c, r.nested ? 0.05 : 0.03)} stroke={withAlpha(c, r.nested ? 0.3 : 0.2)} strokeWidth={1} strokeDasharray={r.nested ? '4 4' : undefined} />
            <SvgText x={r.x + 10} y={r.y + 18} fill={withAlpha(c, 0.75)} fontSize={12} fontFamily={MONO_FAMILY} letterSpacing={1}>
              {truncate(r.label, Math.floor((r.width - 20) / 8.4))}
            </SvgText>
          </G>
        );
      })}
      {layout.edges.map((e) => (
        <Path key={e.id} d={e.d} fill="none" {...edgeStyle(e.kind)} />
      ))}
      {layout.nodes.map((n) => (
        <NodeMark
          key={n.id}
          node={n}
          colors={colors}
          font={MONO_FAMILY}
          selected={n.id === selectedId}
          hit={Boolean(matches && matches.has(n.id))}
          dim={Boolean(matches && !matches.has(n.id))}
          showLabel={showLabels || n.kind === 'agency'}
        />
      ))}
    </>
  );
});

export const TopologyMap = forwardRef(function TopologyMap(
  { layout, selectedId, matches, dense, onSelect, onSize, signature, testID },
  ref,
) {
  const { colors } = useUIKit();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cam, setCam] = useState(null);
  const [commitSeq, setCommitSeq] = useState(0);

  const camRef = useRef(cam);
  camRef.current = cam;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // New drawing (scope / layer / focus / orientation changed) → re-open the camera.
  useEffect(() => {
    if (!layout || !size.w || !size.h) return;
    setCam(initialCamera(layout.bounds, size.w, size.h));
  }, [signature, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const dx = useSharedValue(0);
  const dy = useSharedValue(0);
  const ds = useSharedValue(1);
  const startDx = useSharedValue(0);
  const startDy = useSharedValue(0);
  const startDs = useSharedValue(1);
  const qx = useSharedValue(0);
  const qy = useSharedValue(0);
  const active = useSharedValue(0);
  const camK = useSharedValue(1);
  const halfW = useSharedValue(0);
  const halfH = useSharedValue(0);

  useEffect(() => { camK.value = cam?.k || 1; }, [cam, camK]);
  useEffect(() => { halfW.value = size.w / 2; halfH.value = size.h / 2; }, [size, halfW, halfH]);

  const commit = useCallback((ddx, ddy, dds) => {
    const c = camRef.current;
    const { w, h } = sizeRef.current;
    if (!c) return;
    setCam(commitGesture(c, w, h, ddx, ddy, dds));
    setCommitSeq((n) => n + 1);
  }, []);

  // The new camera is on screen — drop the gesture delta in the same frame.
  useLayoutEffect(() => {
    dx.value = 0;
    dy.value = 0;
    ds.value = 1;
  }, [commitSeq, dx, dy, ds]);

  const handleTap = useCallback((x, y) => {
    const c = camRef.current;
    const l = layoutRef.current;
    if (!c || !l) return;
    onSelectRef.current?.(hitTest(l.nodes, c, x, y));
  }, []);

  const handleDouble = useCallback((x, y) => {
    const c = camRef.current;
    if (c) setCam(zoomAt(c, x, y, 1.8));
  }, []);

  const gesture = useMemo(() => {
    const finish = () => {
      'worklet';
      active.value = Math.max(0, active.value - 1);
      if (active.value === 0 && (dx.value !== 0 || dy.value !== 0 || ds.value !== 1)) runOnJS(commit)(dx.value, dy.value, ds.value);
    };
    const pan = Gesture.Pan()
      .minDistance(4)
      .maxPointers(1)
      .onStart(() => {
        active.value += 1;
        startDx.value = dx.value;
        startDy.value = dy.value;
      })
      .onUpdate((e) => {
        dx.value = startDx.value + e.translationX;
        dy.value = startDy.value + e.translationY;
      })
      .onFinalize(finish);
    const pinch = Gesture.Pinch()
      .onStart((e) => {
        active.value += 1;
        startDs.value = ds.value;
        startDx.value = dx.value;
        startDy.value = dy.value;
        qx.value = halfW.value + (e.focalX - halfW.value - dx.value) / ds.value;
        qy.value = halfH.value + (e.focalY - halfH.value - dy.value) / ds.value;
      })
      .onUpdate((e) => {
        let next = startDs.value * e.scale;
        const total = camK.value * next;
        if (total > MAX_ZOOM) next = MAX_ZOOM / camK.value;
        if (total < MIN_ZOOM) next = MIN_ZOOM / camK.value;
        ds.value = next;
        dx.value = e.focalX - halfW.value - next * (qx.value - halfW.value);
        dy.value = e.focalY - halfH.value - next * (qy.value - halfH.value);
      })
      .onFinalize(finish);
    const tap = Gesture.Tap().maxDistance(10).onEnd((e, ok) => { if (ok) runOnJS(handleTap)(e.x, e.y); });
    const doubleTap = Gesture.Tap().numberOfTaps(2).maxDelay(240).maxDistance(16).onEnd((e, ok) => { if (ok) runOnJS(handleDouble)(e.x, e.y); });
    return Gesture.Simultaneous(pan, pinch, Gesture.Exclusive(doubleTap, tap));
  }, [commit, handleTap, handleDouble]); // eslint-disable-line react-hooks/exhaustive-deps

  const canvasStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dx.value }, { translateY: dy.value }, { scale: ds.value }],
  }));

  useImperativeHandle(
    ref,
    () => ({
      fit() {
        const l = layoutRef.current;
        const { w, h } = sizeRef.current;
        if (l && w && h) setCam(fitCamera(l.bounds, w, h));
      },
      reset() {
        const l = layoutRef.current;
        const { w, h } = sizeRef.current;
        if (l && w && h) setCam(initialCamera(l.bounds, w, h));
      },
      zoomBy(factor) {
        const c = camRef.current;
        const { w, h } = sizeRef.current;
        if (c) setCam(zoomAt(c, w / 2, h / 2, factor));
      },
      centerOn(nodeId) {
        const c = camRef.current;
        const node = layoutRef.current?.nodes.find((n) => n.id === nodeId);
        const { w, h } = sizeRef.current;
        if (c && node) setCam(centerOnNode(node, c, w, h));
      },
      zoom() {
        return camRef.current?.k ?? 1;
      },
    }),
    [],
  );

  const showLabels = (cam?.k ?? 1) >= 0.5;

  return (
    <GestureHandlerRootView style={styles.fill}>
      <View
        style={[styles.fill, styles.clip]}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          const next = { w: Math.round(width), h: Math.round(height) };
          if (next.w !== sizeRef.current.w || next.h !== sizeRef.current.h) {
            setSize(next);
            onSize?.(next);
          }
        }}
        testID={testID}
      >
        <GestureDetector gesture={gesture}>
          <View style={styles.fill} collapsable={false}>
            <Animated.View style={[styles.fill, canvasStyle]}>
              {layout && cam && size.w > 0 ? (
                <Svg width={size.w} height={size.h}>
                  <G transform={`translate(${cam.x} ${cam.y}) scale(${cam.k})`}>
                    <Scene layout={layout} colors={colors} selectedId={selectedId} matches={matches} dense={dense} showLabels={showLabels} />
                  </G>
                </Svg>
              ) : null}
            </Animated.View>
          </View>
        </GestureDetector>
      </View>
    </GestureHandlerRootView>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  clip: { overflow: 'hidden' },
});

export default TopologyMap;
