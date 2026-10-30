/**
 * WhiteboardCanvas — native Excalidraw scene renderer + gesture engine.
 *
 * Renders the same scene elements the web canvas does (rectangle, ellipse,
 * diamond, arrow, line, freedraw, text — stroke / fill / fillStyle / opacity /
 * roughness / strokeStyle / rotation) with react-native-svg, and turns touches
 * into scene edits:
 *   · two fingers, any tool  → pinch zoom + pan
 *   · hand tool / empty drag → pan
 *   · select                 → tap to select, drag to move, corner handles
 *                              resize, top handle rotates, double tap edits text
 *   · shapes / arrow / line  → drag out (tap drops a default-size one)
 *   · pen                    → perfect-freehand ink
 *   · text                   → tap to place (asks the screen for the text)
 *   · eraser                 → scrub over elements
 *
 * A PanResponder (works in Expo Go and on web, no GestureHandlerRootView
 * needed). In-progress edits live in local state and are handed to
 * `onCommit(nextElements, selectIds)` once per gesture — that is one undo step.
 */
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { View, PanResponder, Platform, StyleSheet } from 'react-native';
import Svg, { G, Path, Rect, Circle, Line, Polygon, Defs, Pattern, Text as SvgText } from 'react-native-svg';

import {
  elementGeometry,
  elementMatrix,
  matrixString,
  renderColor,
  isTransparent,
  dashArray,
  layoutText,
  hitTest,
  hitTestScene,
  screenToScene,
  sceneToScreen,
  selectionFrame,
  angleFromHandle,
  boundsCenter,
  elementBounds,
  HANDLES,
} from './whiteboard-geometry';
import {
  createElement,
  boxFromDrag,
  withPointExtents,
  moveElements,
  resizeRotated,
  rotateElements,
  eraseAt,
  deleteElements,
  expandToGroups,
  bindArrowEnds,
  syncBoundText,
  replaceElement,
  STROKE_PALETTE,
} from './whiteboard-model';

const INK = STROKE_PALETTE[0];

// On web, stop the browser from treating canvas pinches/drags as page zoom/scroll.
const WEB_NO_TOUCH = Platform.OS === 'web' ? { touchAction: 'none', userSelect: 'none' } : null;

const TAP_PX = 8;
const TAP_MS = 350;
const DOUBLE_TAP_MS = 320;
const HANDLE_R = 7;
const HANDLE_HIT = 24;

const HAND_FONT = Platform.select({ ios: 'Chalkboard SE', android: 'casual', default: '"Comic Sans MS", "Comic Neue", cursive' });
const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' });
const SANS_FONT = Platform.select({ ios: 'Helvetica', android: 'sans-serif', default: 'Helvetica, Arial, sans-serif' });

function fontFor(family) {
  if (family === 3 || family === 8) return MONO_FONT;
  if (family === 2 || family === 6) return SANS_FONT;
  return HAND_FONT;
}

// ── element rendering ─────────────────────────────────────────────────────

function TextLines({ el, container, dark, colorOverride }) {
  const layout = layoutText(el, container);
  const fill = renderColor(colorOverride || el.strokeColor || INK, dark);
  return layout.lines.map((ln, i) => (
    <SvgText
      key={i}
      x={ln.x}
      y={ln.y}
      fill={fill}
      fontSize={layout.fontSize}
      fontFamily={fontFor(el.fontFamily)}
      textAnchor={layout.anchor}
    >
      {ln.text || ' '}
    </SvgText>
  ));
}

const ElementView = memo(function ElementView({ el, container, dark }) {
  const opacity = Math.max(0, Math.min(100, el.opacity ?? 100)) / 100;
  if (el.type === 'text') {
    // Bound text is laid out by its container's geometry (scene space); the
    // container's rotation is applied around the container's centre.
    if (container) {
      const angle = container.type === 'arrow' || container.type === 'line' ? 0 : container.angle || 0;
      const [cx, cy] = boundsCenter(elementBounds(container));
      const tf = angle ? `rotate(${(angle * 180) / Math.PI} ${cx} ${cy})` : undefined;
      return (
        <G opacity={opacity} transform={tf}>
          <TextLines el={el} container={container} dark={dark} />
        </G>
      );
    }
    const m = elementMatrix(el);
    const local = { ...el, x: 0, y: 0 };
    return (
      <G opacity={opacity} transform={matrixString(m)}>
        <TextLines el={local} dark={dark} />
      </G>
    );
  }

  const geo = elementGeometry(el);
  const stroke = renderColor(el.strokeColor || INK, dark);
  const sw = el.strokeWidth ?? 2;
  const dash = dashArray(el.strokeStyle, sw);
  const bg = el.backgroundColor;
  const pid = `wbp-${el.id}`;
  let fill = 'none';
  let pattern = null;
  if (geo.fillable && !isTransparent(bg)) {
    const fc = renderColor(bg, dark);
    const style = el.fillStyle || 'solid';
    if (style === 'solid') fill = fc;
    else {
      const gap = Math.max(6, sw * 4);
      pattern = (
        <Defs>
          <Pattern id={pid} patternUnits="userSpaceOnUse" width={gap} height={gap} patternTransform="rotate(-45)">
            <Line x1={0} y1={0} x2={0} y2={gap} stroke={fc} strokeWidth={Math.max(1, sw / 2)} />
            {style === 'cross-hatch' ? <Line x1={0} y1={0} x2={gap} y2={0} stroke={fc} strokeWidth={Math.max(1, sw / 2)} /> : null}
          </Pattern>
        </Defs>
      );
      fill = `url(#${pid})`;
    }
  }
  const tf = matrixString(elementMatrix(el));

  if (geo.kind === 'ink') {
    return (
      <G opacity={opacity} transform={tf}>
        <Path d={geo.d} fill={stroke} />
      </G>
    );
  }

  const inlineLabel = typeof el.text === 'string' && el.text && el.type !== 'text';
  return (
    <G opacity={opacity}>
      {pattern}
      <G transform={tf}>
        <Path d={geo.d} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" />
        {geo.sketch ? (
          <Path d={geo.sketch} fill="none" stroke={stroke} strokeWidth={sw} strokeOpacity={0.55} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" />
        ) : null}
        {(geo.heads || []).map((h, i) =>
          h.r ? (
            <Circle key={i} cx={h.cx} cy={h.cy} r={h.r} fill={h.filled ? stroke : 'none'} stroke={stroke} strokeWidth={sw} />
          ) : (
            <Path key={i} d={h.path} fill={h.filled ? stroke : 'none'} stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
          ),
        )}
      </G>
      {inlineLabel ? (
        <G transform={el.angle && geo.kind !== 'line' ? `rotate(${(el.angle * 180) / Math.PI} ${boundsCenter(elementBounds(el)).join(' ')})` : undefined}>
          <TextLines
            el={{ ...el, type: 'text', textAlign: el.textAlign || 'center', verticalAlign: el.verticalAlign || 'middle', fontSize: el.fontSize || 18 }}
            container={el}
            dark={dark}
          />
        </G>
      ) : null}
    </G>
  );
});

// ── canvas ────────────────────────────────────────────────────────────────

export function WhiteboardCanvas({
  elements,
  selectedIds,
  camera,
  onCamera,
  tool,
  style,
  dark,
  paper,
  accent,
  handleFill,
  onSelect,
  onCommit,
  onTextRequest,
  onEditText,
  onToolDone,
  onLayoutSize,
}) {
  const [working, setWorking] = useState(null); // edited copy of elements mid-gesture
  const [draft, setDraft] = useState(null); // element being drawn
  const origin = useRef({ x: 0, y: 0 });
  const viewRef = useRef(null);
  const ix = useRef({ mode: null }).current;
  ix.props = { elements, selectedIds, camera, tool, style, onCamera, onSelect, onCommit, onTextRequest, onEditText, onToolDone };

  const measure = useCallback(() => {
    const node = viewRef.current;
    if (node && node.measureInWindow) {
      node.measureInWindow((x, y) => {
        if (Number.isFinite(x) && Number.isFinite(y)) origin.current = { x, y };
      });
    }
  }, []);

  const touchesOf = (e) => {
    const ne = e.nativeEvent || {};
    const list = ne.touches && ne.touches.length ? Array.from(ne.touches) : null;
    if (list) return list.map((t) => [t.pageX - origin.current.x, t.pageY - origin.current.y]);
    if (Number.isFinite(ne.pageX)) return [[ne.pageX - origin.current.x, ne.pageY - origin.current.y]];
    return [];
  };

  const startPinch = (pts) => {
    const [a, b] = pts;
    ix.mode = 'pinch';
    ix.cam0 = ix.props.camera;
    ix.dist0 = Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]));
    ix.mid0 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    ix.anchor = screenToScene(ix.cam0, ix.mid0[0], ix.mid0[1]);
  };

  const setW = (next) => {
    ix.working = next;
    setWorking(next);
  };

  const cancelSingle = () => {
    setW(null);
    setDraft(null);
  };

  const startSingle = (p) => {
    const { elements: els, selectedIds: sel, camera: cam, tool: t, style: st } = ix.props;
    const [sx, sy] = screenToScene(cam, p[0], p[1]);
    ix.start = p;
    ix.startScene = [sx, sy];
    ix.t0 = Date.now();
    ix.cam0 = cam;
    ix.base = els;
    ix.last = p;
    if (t === 'hand') {
      ix.mode = 'pan';
      return;
    }
    if (t === 'select') {
      const frame = sel && sel.length ? selectionFrame(els, sel) : null;
      if (frame) {
        if (frame.rotateHandle) {
          const [rx, ry] = sceneToScreen(cam, frame.rotateHandle[0], frame.rotateHandle[1]);
          if (Math.hypot(p[0] - rx, p[1] - ry) <= HANDLE_HIT) {
            ix.mode = 'rotate';
            ix.ids = sel;
            ix.center = frame.center;
            return;
          }
        }
        if (frame.single) {
          for (const h of HANDLES) {
            const [hx, hy] = sceneToScreen(cam, frame.corners[h][0], frame.corners[h][1]);
            if (Math.hypot(p[0] - hx, p[1] - hy) <= HANDLE_HIT) {
              ix.mode = 'resize';
              ix.handle = h;
              ix.id = sel[0];
              return;
            }
          }
        }
      }
      const hit = hitTestScene(els, sx, sy, 10 / cam.zoom);
      if (hit) {
        const ids = sel && sel.includes(hit) ? sel : expandToGroups(els, [hit]);
        if (!(sel && sel.includes(hit))) ix.props.onSelect(ids);
        ix.mode = 'move';
        ix.ids = ids;
        ix.hit = hit;
        return;
      }
      ix.mode = 'pan';
      return;
    }
    if (t === 'eraser') {
      ix.mode = 'erase';
      const ids = eraseAt(els, sx, sy, 8 / cam.zoom, hitTest);
      if (ids.length) setW(deleteElements(els, ids));
      ix.erased = ids.length > 0;
      return;
    }
    if (t === 'text') {
      ix.mode = 'text';
      return;
    }
    ix.mode = 'draw';
    const el = createElement(t, sx, sy, st);
    ix.draft = el;
    setDraft(el);
  };

  const moveSingle = (p) => {
    const { camera: cam, tool: t, onCamera: setCam } = ix.props;
    ix.last = p;
    const [sx, sy] = screenToScene(cam, p[0], p[1]);
    const [x0, y0] = ix.startScene;
    switch (ix.mode) {
      case 'pan':
        setCam({ ...ix.cam0, x: ix.cam0.x + p[0] - ix.start[0], y: ix.cam0.y + p[1] - ix.start[1] });
        break;
      case 'move':
        setW(moveElements(ix.base, ix.ids, sx - x0, sy - y0));
        break;
      case 'resize': {
        const el = ix.base.find((e) => e.id === ix.id);
        if (el) setW(replaceElement(ix.base, resizeRotated(el, ix.handle, sx, sy)));
        break;
      }
      case 'rotate':
        setW(rotateElements(ix.base, ix.ids, angleFromHandle(ix.center[0], ix.center[1], sx, sy)));
        break;
      case 'erase': {
        const cur = ix.working || ix.base;
        const ids = eraseAt(cur, sx, sy, 8 / cam.zoom, hitTest);
        if (ids.length) {
          const next = deleteElements(cur, ids);
          ix.erased = true;
          setW(next);
        }
        break;
      }
      case 'draw': {
        const d = ix.draft;
        if (!d) break;
        let next;
        if (t === 'freedraw') {
          const lp = d.points[d.points.length - 1];
          const rx = sx - d.x;
          const ry = sy - d.y;
          if (Math.hypot(rx - lp[0], ry - lp[1]) * cam.zoom < 1.5) break;
          next = withPointExtents({ ...d, points: [...d.points, [rx, ry]] });
        } else if (t === 'arrow' || t === 'line') {
          next = withPointExtents({ ...d, points: [[0, 0], [sx - x0, sy - y0]] });
        } else {
          next = { ...d, ...boxFromDrag(x0, y0, sx, sy) };
        }
        ix.draft = next;
        setDraft(next);
        break;
      }
      default:
        break;
    }
  };

  const endSingle = () => {
    const { tool: t, onCommit: commit, onSelect: select, onTextRequest: askText, onEditText: editText, onToolDone: toolDone, camera: cam } = ix.props;
    const p = ix.last || ix.start;
    const moved = p && ix.start ? Math.hypot(p[0] - ix.start[0], p[1] - ix.start[1]) : 0;
    const isTap = moved < TAP_PX && Date.now() - ix.t0 < TAP_MS;
    const mode = ix.mode;
    ix.mode = null;
    const [x0, y0] = ix.startScene || [0, 0];
    if (mode === 'pan') {
      if (isTap && t === 'select') select([]);
    } else if (mode === 'move') {
      if (isTap) {
        const now = Date.now();
        if (ix.lastTapId === ix.hit && now - (ix.lastTapAt || 0) < DOUBLE_TAP_MS) {
          ix.lastTapAt = 0;
          editText(ix.hit);
        } else {
          ix.lastTapId = ix.hit;
          ix.lastTapAt = now;
        }
        setW(null);
      } else {
        const w = ix.working;
        setW(null);
        if (w) commit(syncBoundText(w), ix.ids);
      }
    } else if (mode === 'resize' || mode === 'rotate') {
      const w = ix.working;
      setW(null);
      if (w) commit(syncBoundText(w), null);
    } else if (mode === 'erase') {
      const next = ix.working;
      setW(null);
      if (ix.erased && next) commit(next, []);
    } else if (mode === 'text') {
      if (isTap) askText({ x: x0, y: y0 });
    } else if (mode === 'draw') {
      let d = ix.draft;
      ix.draft = null;
      setDraft(null);
      if (!d) return;
      const z = cam.zoom || 1;
      if (t === 'freedraw') {
        if (d.points.length === 1) d = withPointExtents({ ...d, points: [[0, 0], [0.5, 0.5]] });
        commit([...ix.base, d], null);
        return;
      }
      if (t === 'arrow' || t === 'line') {
        const [, end] = d.points;
        if (Math.hypot(end[0], end[1]) * z < TAP_PX) d = withPointExtents({ ...d, points: [[0, 0], [120, 0]] });
        let next = [...ix.base, d];
        if (t === 'arrow') next = bindArrowEnds(next, d.id, hitTest);
        commit(next, [d.id]);
        toolDone();
        return;
      }
      if (d.width * z < TAP_PX && d.height * z < TAP_PX) d = { ...d, x: x0 - 70, y: y0 - 40, width: 140, height: 80 };
      commit([...ix.base, d], [d.id]);
      toolDone();
    }
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (e) => {
          const pts = touchesOf(e);
          ix.working = null;
          if (pts.length >= 2) startPinch(pts);
          else if (pts.length === 1) startSingle(pts[0]);
        },
        onPanResponderMove: (e) => {
          const pts = touchesOf(e);
          if (pts.length >= 2) {
            if (ix.mode !== 'pinch') {
              cancelSingle();
              ix.draft = null;
              startPinch(pts);
              return;
            }
            const [a, b] = pts;
            const dist = Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]));
            const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            const zoom = Math.min(8, Math.max(0.1, ix.cam0.zoom * (dist / ix.dist0)));
            ix.props.onCamera({ x: mid[0] - ix.anchor[0] * zoom, y: mid[1] - ix.anchor[1] * zoom, zoom });
            return;
          }
          if (ix.mode === 'pinch' || !pts.length) return;
          moveSingle(pts[0]);
        },
        onPanResponderRelease: () => {
          if (ix.mode === 'pinch') {
            ix.mode = null;
            return;
          }
          endSingle();
        },
        onPanResponderTerminate: () => {
          ix.mode = null;
          cancelSingle();
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const shown = working || elements;
  const byId = useMemo(() => new Map(shown.map((e) => [e.id, e])), [shown]);
  const frame = useMemo(() => (selectedIds && selectedIds.length ? selectionFrame(shown, selectedIds) : null), [shown, selectedIds]);
  const camTf = `matrix(${camera.zoom} 0 0 ${camera.zoom} ${camera.x} ${camera.y})`;
  const toScreen = (pt) => sceneToScreen(camera, pt[0], pt[1]);

  return (
    <View
      ref={viewRef}
      style={[styles.fill, WEB_NO_TOUCH, { backgroundColor: paper }]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        onLayoutSize && onLayoutSize({ width, height });
        measure();
      }}
      accessibilityLabel="Whiteboard canvas"
      {...responder.panHandlers}
    >
      <Svg width="100%" height="100%" pointerEvents="none">
        <G transform={camTf}>
          {shown.map((el) =>
            el.isDeleted ? null : (
              <ElementView key={el.id} el={el} dark={dark} container={el.type === 'text' && el.containerId ? byId.get(el.containerId) : undefined} />
            ),
          )}
          {draft ? <ElementView el={draft} dark={dark} /> : null}
        </G>
        {frame ? (
          <G>
            <Polygon
              points={['nw', 'ne', 'se', 'sw'].map((k) => toScreen(frame.corners[k]).join(',')).join(' ')}
              fill="none"
              stroke={accent}
              strokeWidth={1.5}
              strokeDasharray={frame.single ? undefined : [6, 4]}
            />
            {frame.single
              ? HANDLES.map((h) => {
                  const [hx, hy] = toScreen(frame.corners[h]);
                  return <Rect key={h} x={hx - HANDLE_R} y={hy - HANDLE_R} width={HANDLE_R * 2} height={HANDLE_R * 2} rx={3} fill={handleFill} stroke={accent} strokeWidth={1.5} />;
                })
              : null}
            {frame.rotateHandle
              ? (() => {
                  const [rx, ry] = toScreen(frame.rotateHandle);
                  const nw = toScreen(frame.corners.nw);
                  const ne = toScreen(frame.corners.ne);
                  return (
                    <G>
                      <Line x1={(nw[0] + ne[0]) / 2} y1={(nw[1] + ne[1]) / 2} x2={rx} y2={ry} stroke={accent} strokeWidth={1} />
                      <Circle cx={rx} cy={ry} r={HANDLE_R} fill={handleFill} stroke={accent} strokeWidth={1.5} />
                    </G>
                  );
                })()
              : null}
          </G>
        ) : null}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
});

export default WhiteboardCanvas;
