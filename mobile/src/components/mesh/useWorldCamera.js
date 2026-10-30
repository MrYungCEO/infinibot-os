/**
 * useWorldCamera — pan / pinch / tap / double-tap / long-press over a world
 * drawn at camera `{ k, x, y }` (screen = world·k + (x, y)).
 *
 * Gestures run on the UI thread as a delta transform on the canvas
 * (translate + scale about the view centre) and are committed into the camera
 * state on release, so the SVG world only re-renders once per gesture.
 * Same pattern as the native Knowledge Graph.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

/** pixi-viewport 'easeInOutSine' — the web engine's cameraFlyTo easing. */
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
/** Re-render cap for eased flights (~30 fps; the SVG world re-renders per step). */
const FLY_FRAME_MS = 32;

export function useWorldCamera({ minK = 0.05, maxK = 4, onTap, onLongPress, onDoubleTap, onGestureStart, onLasso, lasso = false, onAgentDrag, dragRadius = 24 } = {}) {
  const [cam, setCam] = useState(null); // { k, x, y }
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [commitSeq, setCommitSeq] = useState(0);

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
  const minKs = useSharedValue(minK);
  const maxKs = useSharedValue(maxK);
  const halfW = useSharedValue(0);
  const halfH = useSharedValue(0);
  const lassoOn = useSharedValue(0);
  useEffect(() => { lassoOn.value = lasso ? 1 : 0; }, [lasso, lassoOn]);
  // Drag-to-assign: screen points of every agent ([x0, y0, x1, y1, …]) so the
  // pan worklet can tell "finger went down on an agent" (drag it) from "on the
  // floor" (pan) without a JS round-trip — world-interactions onHostPointerDown.
  const dragPts = useSharedValue([]);
  const dragIdx = useSharedValue(-1);
  const dragging = useSharedValue(0);
  const dragR = useSharedValue(dragRadius);
  useEffect(() => { dragR.value = dragRadius; }, [dragRadius, dragR]);
  const dragKeys = useRef([]);
  const setDragTargets = useCallback((keys, pts) => {
    dragKeys.current = keys;
    dragPts.value = pts;
  }, [dragPts]);

  useEffect(() => { camK.value = cam?.k || 1; }, [cam, camK]);
  useEffect(() => { minKs.value = minK; maxKs.value = maxK; }, [minK, maxK, minKs, maxKs]);
  useEffect(() => { halfW.value = size.w / 2; halfH.value = size.h / 2; }, [size, halfW, halfH]);
  const limits = useRef({ minK, maxK });
  limits.current = { minK, maxK };

  const camRef = useRef(cam);
  camRef.current = cam;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const cbs = useRef({});
  cbs.current = { onTap, onLongPress, onDoubleTap, onGestureStart, onLasso, onAgentDrag };

  // ── Eased flights (engine cameraFlyTo → viewport.animate) ────────────────
  const fly = useRef(null); // { from, to, t0, ms, raf, lastAt }
  const stopFly = useCallback(() => {
    const f = fly.current;
    if (f?.raf != null) cancelAnimationFrame(f.raf);
    fly.current = null;
  }, []);
  useEffect(() => stopFly, [stopFly]);


  const commit = useCallback((ddx, ddy, dds) => {
    const c = camRef.current;
    const { w, h } = sizeRef.current;
    if (!c) return;
    const cx = w / 2;
    const cy = h / 2;
    setCam({ k: c.k * dds, x: cx + ddx + dds * (c.x - cx), y: cy + ddy + dds * (c.y - cy) });
    setCommitSeq((n) => n + 1);
  }, []);

  // The new camera is on screen — drop the gesture delta in the same frame.
  useLayoutEffect(() => {
    dx.value = 0;
    dy.value = 0;
    ds.value = 1;
  }, [commitSeq, dx, dy, ds]);

  const started = useCallback((kind) => { stopFly(); cbs.current.onGestureStart?.(kind); }, [stopFly]);
  const dragged = useCallback((phase, idx, x, y) => {
    const key = dragKeys.current[idx];
    if (key) cbs.current.onAgentDrag?.(phase, key, x, y);
  }, []);
  const tapped = useCallback((x, y) => cbs.current.onTap?.(x, y), []);
  const pressed = useCallback((x, y) => cbs.current.onLongPress?.(x, y), []);
  const doubled = useCallback((x, y) => cbs.current.onDoubleTap?.(x, y), []);
  const lassoed = useCallback((phase, x0, y0, x1, y1) => cbs.current.onLasso?.(phase, x0, y0, x1, y1), []);

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .minDistance(4)
      .maxPointers(1)
      .onBegin((e) => {
        // Finger down: on an agent (and not in Director) → this drag assigns it.
        dragIdx.value = -1;
        if (lassoOn.value) return;
        const pts = dragPts.value;
        const r2 = dragR.value * dragR.value;
        let best = r2;
        for (let i = 0; i + 1 < pts.length; i += 2) {
          const ddx = pts[i] - e.x;
          const ddy = pts[i + 1] - e.y;
          const d = ddx * ddx + ddy * ddy;
          if (d <= best) { best = d; dragIdx.value = i / 2; }
        }
      })
      .onStart((e) => {
        // Director lasso: a one-finger drag paints a selection rect instead of panning.
        if (lassoOn.value) {
          runOnJS(lassoed)('start', e.x - e.translationX, e.y - e.translationY, e.x, e.y);
          return;
        }
        if (dragIdx.value >= 0) {
          dragging.value = 1;
          runOnJS(dragged)('start', dragIdx.value, e.x, e.y);
          return;
        }
        active.value += 1;
        startDx.value = dx.value;
        startDy.value = dy.value;
        runOnJS(started)('pan');
      })
      .onUpdate((e) => {
        if (lassoOn.value) {
          runOnJS(lassoed)('move', e.x - e.translationX, e.y - e.translationY, e.x, e.y);
          return;
        }
        if (dragging.value) {
          runOnJS(dragged)('move', dragIdx.value, e.x, e.y);
          return;
        }
        dx.value = startDx.value + e.translationX;
        dy.value = startDy.value + e.translationY;
      })
      .onEnd((e) => {
        if (lassoOn.value) runOnJS(lassoed)('end', e.x - e.translationX, e.y - e.translationY, e.x, e.y);
        else if (dragging.value) runOnJS(dragged)('end', dragIdx.value, e.x, e.y);
      })
      .onFinalize(() => {
        if (lassoOn.value) return;
        if (dragging.value) {
          dragging.value = 0;
          dragIdx.value = -1;
          return;
        }
        active.value = Math.max(0, active.value - 1);
        if (active.value === 0 && (dx.value !== 0 || dy.value !== 0 || ds.value !== 1)) runOnJS(commit)(dx.value, dy.value, ds.value);
      });

    const pinch = Gesture.Pinch()
      .onStart((e) => {
        active.value += 1;
        startDs.value = ds.value;
        startDx.value = dx.value;
        startDy.value = dy.value;
        qx.value = halfW.value + (e.focalX - halfW.value - dx.value) / ds.value;
        qy.value = halfH.value + (e.focalY - halfH.value - dy.value) / ds.value;
        runOnJS(started)('pinch');
      })
      .onUpdate((e) => {
        let next = startDs.value * e.scale;
        const total = camK.value * next;
        if (total > maxKs.value) next = maxKs.value / camK.value;
        if (total < minKs.value) next = minKs.value / camK.value;
        ds.value = next;
        dx.value = e.focalX - halfW.value - next * (qx.value - halfW.value);
        dy.value = e.focalY - halfH.value - next * (qy.value - halfH.value);
      })
      .onFinalize(() => {
        active.value = Math.max(0, active.value - 1);
        if (active.value === 0 && (dx.value !== 0 || dy.value !== 0 || ds.value !== 1)) runOnJS(commit)(dx.value, dy.value, ds.value);
      });

    const tap = Gesture.Tap().maxDistance(10).onEnd((e, ok) => { if (ok) runOnJS(tapped)(e.x, e.y); });
    const doubleTap = Gesture.Tap().numberOfTaps(2).maxDelay(240).maxDistance(16).onEnd((e, ok) => { if (ok) runOnJS(doubled)(e.x, e.y); });
    const longPress = Gesture.LongPress().minDuration(480).maxDistance(10).onStart((e) => { runOnJS(pressed)(e.x, e.y); });
    return Gesture.Simultaneous(pan, pinch, Gesture.Exclusive(doubleTap, longPress, tap));
  }, [commit, started, tapped, pressed, doubled, lassoed, dragged]); // eslint-disable-line react-hooks/exhaustive-deps

  const canvasStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dx.value }, { translateY: dy.value }, { scale: ds.value }],
  }));

  const clampK = useCallback((k) => Math.max(limits.current.minK, Math.min(limits.current.maxK, k)), []);

  /** Zoom by `factor` about a screen point (default: the view centre). */
  const zoomBy = useCallback((factor, sx, sy) => {
    const c = camRef.current;
    if (!c) return;
    const { w, h } = sizeRef.current;
    const px = sx ?? w / 2;
    const py = sy ?? h / 2;
    const k = clampK(c.k * factor);
    const f = k / c.k;
    stopFly();
    setCam({ k, x: px - f * (px - c.x), y: py - f * (py - c.y) });
  }, [clampK]);

  /** Centre a world point at zoom `k` (keeps the current zoom when omitted). */
  const flyTo = useCallback((wx, wy, k) => {
    const c = camRef.current;
    const { w, h } = sizeRef.current;
    const kk = clampK(k ?? c?.k ?? 1);
    stopFly();
    setCam({ k: kk, x: w / 2 - wx * kk, y: h / 2 - wy * kk });
  }, [clampK, stopFly]);

  /**
   * Eased flight that centres world (wx, wy) at zoom k over `ms` — the web
   * engine's cameraFlyTo (viewport.animate, easeInOutSine). A new flight
   * replaces the running one from wherever the camera is now, as
   * pixi-viewport's plugins.remove('animate') + animate() does.
   */
  const animateTo = useCallback((wx, wy, k, ms = 800) => {
    const c = camRef.current;
    const { w, h } = sizeRef.current;
    if (!c || !w || !h) return;
    const kk = clampK(k);
    if (fly.current?.raf != null) cancelAnimationFrame(fly.current.raf);
    const from = { cx: (w / 2 - c.x) / c.k, cy: (h / 2 - c.y) / c.k, k: c.k };
    const to = { cx: wx, cy: wy, k: kk };
    const f = { from, to, t0: Date.now(), ms: Math.max(1, ms), raf: null, lastAt: 0 };
    fly.current = f;
    const frame = () => {
      if (fly.current !== f) return;
      const now = Date.now();
      const t = Math.min(1, (now - f.t0) / f.ms);
      if (t >= 1 || now - f.lastAt >= FLY_FRAME_MS) {
        f.lastAt = now;
        const e = easeInOutSine(t);
        const zk = f.from.k + (f.to.k - f.from.k) * e;
        const cx = f.from.cx + (f.to.cx - f.from.cx) * e;
        const cy = f.from.cy + (f.to.cy - f.from.cy) * e;
        const sz = sizeRef.current;
        setCam({ k: zk, x: sz.w / 2 - cx * zk, y: sz.h / 2 - cy * zk });
      }
      if (t >= 1) { fly.current = null; return; }
      f.raf = requestAnimationFrame(frame);
    };
    f.raf = requestAnimationFrame(frame);
  }, [clampK]);

  /** Frame a world-space box with `pad` px of margin (top/bottom insets for HUD chrome). */
  const fitBox = useCallback((box, { padX = 16, padLeft, padRight, padTop = 16, padBottom = 16 } = {}) => {
    const { w, h } = sizeRef.current;
    if (!box || !w || !h) return null;
    const pl = padLeft ?? padX;
    const pr = padRight ?? padX;
    const bw = Math.max(1, box.maxX - box.minX);
    const bh = Math.max(1, box.maxY - box.minY);
    const availW = Math.max(40, w - pl - pr);
    const availH = Math.max(40, h - padTop - padBottom);
    const k = clampK(Math.min(availW / bw, availH / bh));
    stopFly();
    const cxw = (box.minX + box.maxX) / 2;
    const cyw = (box.minY + box.maxY) / 2;
    setCam({ k, x: pl + availW / 2 - cxw * k, y: padTop + availH / 2 - cyw * k });
    return k;
  }, [clampK, stopFly]);

  /** Screen point → world point under the committed camera. */
  const toWorld = useCallback((sx, sy) => {
    const c = camRef.current;
    if (!c) return null;
    return { x: (sx - c.x) / c.k, y: (sy - c.y) / c.k };
  }, []);

  const onLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
  }, []);

  return { cam, setCam, size, onLayout, gesture, canvasStyle, zoomBy, flyTo, animateTo, stopFly, fitBox, toWorld, setDragTargets, flying: () => !!fly.current };
}
