// HandwritingEditor — GoodNotes-style handwriting + diagram canvas for mobile.
//
// Full-screen modal editor that layers on top of NotesScreen. Ink is drawn with
// perfect-freehand + react-native-svg (no native module required). Apple Pencil
// pressure is read from the raw touch `force`; palm rejection is done by locking
// a stroke to the first pointer and ignoring multi-touch while drawing. Each
// page is captured (white bg / dark ink offscreen SVG) and sent to the gateway
// `notes.ocr` route, which returns markdown (diagrams → mermaid). The whole doc
// (strokes + shapes + pages) is embedded in the note body via canvasFormat so it
// round-trips through the existing notes.* RPCs and survives restart.
//
// Design language: black/gold glassmorphism, matching the rest of the app.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  PanResponder,
  Modal,
  TextInput,
  ScrollView,
  Platform,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import Svg, {
  Path,
  Rect,
  Ellipse,
  Line,
  Polygon,
  G,
  Text as SvgText,
} from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { withAlpha } from '../../theme/color-utils';
import {
  emptyCanvasDoc,
  emptyPage,
  makeId,
  encodeNoteBody,
  normalizeDoc,
  docHasInk,
  CANVAS_CATEGORY,
} from './canvasFormat';
import {
  pointsToSvgPath,
  strokeBBox,
  shapeBBox,
  pointInBox,
  distToStroke,
  eraseFromStroke,
} from './freehand';

const GRID = 16;
const TOOLS = ['pen', 'highlighter', 'eraser', 'select'];
const SHAPES = [
  { type: 'rect', icon: 'square-outline' },
  { type: 'ellipse', icon: 'ellipse-outline' },
  { type: 'line', icon: 'remove-outline' },
  { type: 'arrow', icon: 'arrow-forward-outline' },
  { type: 'triangle', icon: 'triangle-outline' },
  { type: 'diamond', icon: 'diamond-outline' },
  { type: 'process', icon: 'git-commit-outline' }, // flowchart process box
  { type: 'text', icon: 'text-outline' },
];
const PALETTE = ['#F5C451', '#FFFFFF', '#7FD1FF', '#8CE0A6', '#FF8FA3', '#C79BFF', '#141414'];
const WIDTHS = [2, 4, 7, 12];

const OCR_PROMPT_FALLBACK =
  'OCR this handwritten notebook page into GitHub-Flavored Markdown. Transcribe ' +
  'prose, lists and tables faithfully, and convert any flowchart / node-and-arrow ' +
  'diagram into a ```mermaid``` block. Return only the markdown.';

function snap(v) {
  return Math.round(v / GRID) * GRID;
}

// ── SVG element renderers ─────────────────────────────────────────────────

function inkColor(el, forCapture) {
  if (!forCapture) return el.color;
  // For OCR we render dark ink on white; keep highlighter yellow-ish but darker.
  if (el.tool === 'highlighter') return '#B8860B';
  return '#141414';
}

function renderStroke(stroke, forCapture) {
  const d = pointsToSvgPath(stroke.points, stroke.tool, stroke.size);
  if (!d) return null;
  const isHi = stroke.tool === 'highlighter';
  return (
    <Path
      key={stroke.id}
      d={d}
      fill={inkColor(stroke, forCapture)}
      opacity={isHi ? (forCapture ? 0.45 : 0.32) : 1}
    />
  );
}

function shapePoints(shape) {
  const { x, y, w, h } = shape;
  const cx = x + w / 2;
  if (shape.type === 'triangle') return `${cx},${y} ${x + w},${y + h} ${x},${y + h}`;
  if (shape.type === 'diamond')
    return `${cx},${y} ${x + w},${y + h / 2} ${cx},${y + h} ${x},${y + h / 2}`;
  return '';
}

function renderShape(shape, forCapture) {
  const stroke = inkColor(shape, forCapture);
  const sw = shape.size || 3;
  const common = { key: shape.id, stroke, strokeWidth: sw, fill: 'none' };
  const { x, y, w, h } = shape;
  switch (shape.type) {
    case 'rect':
    case 'process':
      return <Rect {...common} x={x} y={y} width={w} height={h} rx={shape.type === 'process' ? 10 : 4} />;
    case 'ellipse':
      return <Ellipse {...common} cx={x + w / 2} cy={y + h / 2} rx={Math.abs(w / 2)} ry={Math.abs(h / 2)} />;
    case 'line':
      return <Line {...common} x1={x} y1={y} x2={x + w} y2={y + h} strokeLinecap="round" />;
    case 'triangle':
    case 'diamond':
      return <Polygon {...common} points={shapePoints(shape)} strokeLinejoin="round" />;
    case 'arrow': {
      const x2 = x + w;
      const y2 = y + h;
      const ang = Math.atan2(h, w);
      const head = 16 + sw * 2;
      const a1 = ang + Math.PI - 0.4;
      const a2 = ang + Math.PI + 0.4;
      return (
        <G key={shape.id}>
          <Line stroke={stroke} strokeWidth={sw} strokeLinecap="round" x1={x} y1={y} x2={x2} y2={y2} />
          <Polygon
            fill={stroke}
            points={`${x2},${y2} ${x2 + head * Math.cos(a1)},${y2 + head * Math.sin(a1)} ${x2 + head * Math.cos(a2)},${y2 + head * Math.sin(a2)}`}
          />
        </G>
      );
    }
    case 'text':
      return (
        <SvgText
          key={shape.id}
          x={x}
          y={y + (shape.fontSize || 34)}
          fill={forCapture ? '#141414' : shape.color}
          fontSize={shape.fontSize || 34}
          fontWeight="500"
        >
          {shape.text || ''}
        </SvgText>
      );
    default:
      return null;
  }
}

// Capture a react-native-svg <Svg> ref into a base64 PNG.
function svgToDataUrl(ref, width, height) {
  return new Promise((resolve, reject) => {
    if (!ref || typeof ref.toDataURL !== 'function') {
      reject(new Error('SVG capture not supported on this platform'));
      return;
    }
    try {
      ref.toDataURL(
        (b64) => {
          if (!b64) reject(new Error('Empty capture'));
          else resolve(`data:image/png;base64,${b64}`);
        },
        { width, height },
      );
    } catch (e) {
      reject(e);
    }
  });
}

export default function HandwritingEditor({
  visible,
  note,
  initialDoc,
  initialName,
  colors,
  sendReq,
  onClose,
  onSaved,
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const mdStyles = useMemo(() => makeMdStyles(colors), [colors]);

  const [doc, setDoc] = useState(() => normalizeDoc(initialDoc) || emptyCanvasDoc());
  const [pageIndex, setPageIndex] = useState(0);
  const [name, setName] = useState(initialName || '');
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState(PALETTE[0]);
  const [size, setSize] = useState(WIDTHS[1]);
  const [snapEnabled, setSnapEnabled] = useState(true);

  const [live, setLive] = useState(null); // in-progress stroke path
  const [draftShape, setDraftShape] = useState(null); // in-progress shape
  const [selection, setSelection] = useState({ ids: [], box: null });
  const [rubber, setRubber] = useState(null); // rubber-band box while selecting

  const [ocrMarkdown, setOcrMarkdown] = useState('');
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrRaw, setOcrRaw] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(null);

  const [textEditor, setTextEditor] = useState(null); // { shapeId, value }
  const [captureTarget, setCaptureTarget] = useState(null); // page index being captured

  // Reset when opened for a different note.
  useEffect(() => {
    if (!visible) return;
    setDoc(normalizeDoc(initialDoc) || emptyCanvasDoc());
    setName(initialName || '');
    setPageIndex(0);
    setSelection({ ids: [], box: null });
    setOcrMarkdown(note?._ocrMarkdown || '');
    setOcrOpen(!!note?._ocrMarkdown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, note?.id]);

  const pageW = doc.pageSize.width;
  const pageH = doc.pageSize.height;

  // Layout: fit the whole page inside the available canvas area.
  const [area, setArea] = useState({ w: Dimensions.get('window').width, h: 400 });
  const scale = Math.min(area.w / pageW, area.h / pageH) || 0.2;
  const dispW = pageW * scale;
  const dispH = pageH * scale;

  // ── History (undo / redo) over the pages array ──────────────────────────
  const historyRef = useRef({ past: [], future: [] });
  const snapshotPages = useCallback(() => JSON.stringify(doc.pages), [doc.pages]);
  const pushHistory = useCallback(() => {
    const h = historyRef.current;
    h.past.push(snapshotPages());
    if (h.past.length > 40) h.past.shift();
    h.future = [];
  }, [snapshotPages]);
  const applyPages = useCallback((pagesJson) => {
    setDoc((d) => ({ ...d, pages: JSON.parse(pagesJson) }));
  }, []);
  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.past.length) return;
    h.future.push(snapshotPages());
    applyPages(h.past.pop());
    setSelection({ ids: [], box: null });
  }, [snapshotPages, applyPages]);
  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.future.length) return;
    h.past.push(snapshotPages());
    applyPages(h.future.pop());
    setSelection({ ids: [], box: null });
  }, [snapshotPages, applyPages]);

  const curPage = doc.pages[pageIndex] || emptyPage('p1');

  // Mutate the current page immutably.
  const mutatePage = useCallback(
    (fn) => {
      setDoc((d) => {
        const pages = d.pages.slice();
        const p = pages[pageIndex] || emptyPage('p1');
        pages[pageIndex] = fn({ ...p, strokes: p.strokes.slice(), shapes: p.shapes.slice() });
        return { ...d, pages };
      });
    },
    [pageIndex],
  );

  // ── Interaction state kept in a ref so PanResponder sees fresh values ────
  const ix = useRef({}).current;
  ix.tool = tool;
  ix.color = color;
  ix.size = size;
  ix.scale = scale;
  ix.snapEnabled = snapEnabled;
  ix.curPage = curPage;
  ix.selection = selection;

  const toCanvas = (e) => {
    const { locationX, locationY } = e.nativeEvent;
    return [locationX / ix.scale, locationY / ix.scale];
  };

  const rafRef = useRef(0);
  const scheduleLive = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const s = ix.stroke;
      if (s) setLive({ d: pointsToSvgPath(s.points, s.tool, s.size), tool: s.tool, color: s.color });
    });
  }, [ix]);

  const commitStroke = useCallback(() => {
    const s = ix.stroke;
    ix.stroke = null;
    setLive(null);
    if (!s || s.points.length < 2) return;
    pushHistory();
    mutatePage((p) => {
      p.strokes.push(s);
      return p;
    });
  }, [ix, pushHistory, mutatePage]);

  const doErase = useCallback(
    (x, y) => {
      const radius = 14 / ix.scale + ix.size;
      mutatePage((p) => {
        const next = [];
        let changed = false;
        for (const st of p.strokes) {
          if (distToStroke(x, y, st) <= radius) {
            changed = true;
            const remains = eraseFromStroke(st, x, y, radius);
            for (const r of remains) next.push(r);
          } else {
            next.push(st);
          }
        }
        if (changed) {
          if (!ix.erased) {
            ix.erased = true;
          }
          p.strokes = next;
        }
        return p;
      });
    },
    [ix, mutatePage],
  );

  const hitTest = useCallback(
    (x, y) => {
      const p = ix.curPage;
      for (let i = p.shapes.length - 1; i >= 0; i--) {
        if (pointInBox(x, y, shapeBBox(p.shapes[i]), 10 / ix.scale)) {
          return { kind: 'shape', id: p.shapes[i].id };
        }
      }
      for (let i = p.strokes.length - 1; i >= 0; i--) {
        if (distToStroke(x, y, p.strokes[i]) <= 12 / ix.scale) {
          return { kind: 'stroke', id: p.strokes[i].id };
        }
      }
      return null;
    },
    [ix],
  );

  const translateSelection = useCallback(
    (ids, dx, dy) => {
      mutatePage((p) => {
        const set = new Set(ids);
        p.strokes = p.strokes.map((st) =>
          set.has(st.id)
            ? { ...st, points: st.points.map(([px, py, pr]) => [px + dx, py + dy, pr]) }
            : st,
        );
        p.shapes = p.shapes.map((sh) =>
          set.has(sh.id) ? { ...sh, x: sh.x + dx, y: sh.y + dy } : sh,
        );
        return p;
      });
    },
    [mutatePage],
  );

  // Single PanResponder. Its config is created ONCE (useRef) but every handler
  // only delegates to `ix.*` methods that are reassigned on each render below —
  // this avoids the classic stale-closure bug where the gesture would keep
  // pointing at first-render state (e.g. always mutating page 0).
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => ix.onGrant && ix.onGrant(e),
      onPanResponderMove: (e) => ix.onMove && ix.onMove(e),
      onPanResponderRelease: () => ix.onRelease && ix.onRelease(),
      onPanResponderTerminate: () => ix.onRelease && ix.onRelease(),
    }),
  ).current;

  // (Re)wire the live gesture handlers every render so they see fresh closures.
  ix.onGrant = (e) => {
    // Palm rejection: ignore multi-touch while a gesture is active.
    if (e.nativeEvent.touches && e.nativeEvent.touches.length > 1) {
      ix.rejected = true;
      return;
    }
    ix.rejected = false;
    const x = e.nativeEvent.locationX / ix.scale;
    const y = e.nativeEvent.locationY / ix.scale;
    ix.last = [x, y];
    const force = typeof e.nativeEvent.force === 'number' && e.nativeEvent.force > 0 ? e.nativeEvent.force : 0.5;

    if (ix.tool === 'pen' || ix.tool === 'highlighter') {
      ix.stroke = {
        id: makeId('st'),
        tool: ix.tool,
        color: ix.color,
        size: ix.size,
        points: [[x, y, Math.min(1, force)]],
      };
      scheduleLive();
    } else if (ix.tool === 'eraser') {
      ix.erased = false;
      pushHistory();
      doErase(x, y);
    } else if (ix.shapeTool) {
      if (ix.shapeTool === 'text') {
        // Text is placed on tap; open the inline editor.
        ix.draft = null;
        const id = makeId('tx');
        pushHistory();
        mutatePage((p) => {
          p.shapes.push({ id, type: 'text', x: snapMaybe(x), y: snapMaybe(y), w: 240, h: 48, color: ix.color, fontSize: 34, text: '' });
          return p;
        });
        setTextEditor({ shapeId: id, value: '' });
        setShapeTool(null);
        ix.shapeTool = null;
        setTool('select');
      } else {
        ix.draft = { type: ix.shapeTool, x, y, w: 0, h: 0, color: ix.color, size: ix.size };
        setDraftShape(ix.draft);
      }
    } else if (ix.tool === 'select') {
      const sel = ix.selection;
      if (sel.ids.length && sel.box && pointInBox(x, y, sel.box, 8 / ix.scale)) {
        ix.moving = { ids: sel.ids };
      } else {
        const hit = hitTest(x, y);
        if (hit) {
          ix.moving = { ids: [hit.id] };
          setSelection({ ids: [hit.id], box: null });
        } else {
          ix.moving = null;
          ix.rubberStart = [x, y];
          setRubber({ minX: x, minY: y, maxX: x, maxY: y });
        }
      }
    }
  };

  ix.onMove = (e) => {
    if (ix.rejected) return;
    const x = e.nativeEvent.locationX / ix.scale;
    const y = e.nativeEvent.locationY / ix.scale;
    if (ix.stroke) {
      const force = typeof e.nativeEvent.force === 'number' && e.nativeEvent.force > 0 ? e.nativeEvent.force : 0.5;
      ix.stroke.points.push([x, y, Math.min(1, force)]);
      scheduleLive();
    } else if (ix.tool === 'eraser') {
      doErase(x, y);
    } else if (ix.draft) {
      ix.draft = { ...ix.draft, w: x - ix.draft.x, h: y - ix.draft.y };
      setDraftShape(ix.draft);
    } else if (ix.moving) {
      const [lx, ly] = ix.last;
      translateSelection(ix.moving.ids, x - lx, y - ly);
    } else if (ix.rubberStart) {
      const [sx, sy] = ix.rubberStart;
      setRubber({ minX: Math.min(sx, x), minY: Math.min(sy, y), maxX: Math.max(sx, x), maxY: Math.max(sy, y) });
    }
    ix.last = [x, y];
  };

  ix.onRelease = () => finishGesture();

  // Wire the parts of the gesture that need React setters/refs.
  ix.setTextEditor = setTextEditor;
  ix.setShapeTool = (v) => { ix.shapeTool = v; setShapeTool(v); };
  ix.setTool = setTool;
  ix.setSelection = setSelection;

  function snapMaybe(v) {
    return ix.snapEnabled ? snap(v) : v;
  }

  const finishGesture = useCallback(() => {
    if (ix.rejected) {
      ix.rejected = false;
      return;
    }
    if (ix.stroke) {
      commitStroke();
    } else if (ix.tool === 'eraser') {
      if (!ix.erased) {
        // No stroke was hit — drop the pre-emptive history entry.
        historyRef.current.past.pop();
      }
      ix.erased = false;
    } else if (ix.draft) {
      const d = ix.draft;
      ix.draft = null;
      setDraftShape(null);
      // Ignore accidental taps that produced a zero-size shape.
      if (Math.abs(d.w) < 6 && Math.abs(d.h) < 6) {
        setShapeTool(null);
        setTool('select');
        return;
      }
      // Normalize so w/h are positive, then snap.
      let { x, y, w, h } = d;
      if (d.type !== 'line' && d.type !== 'arrow') {
        if (w < 0) { x += w; w = -w; }
        if (h < 0) { y += h; h = -h; }
      }
      if (ix.snapEnabled) { x = snap(x); y = snap(y); w = snap(w); h = snap(h); }
      pushHistory();
      const shape = { ...d, id: makeId('sh'), x, y, w, h };
      mutatePage((p) => { p.shapes.push(shape); return p; });
      setShapeTool(null);
      setTool('select');
      setSelection({ ids: [shape.id], box: null });
    } else if (ix.moving) {
      ix.moving = null;
      recomputeSelectionBox();
    } else if (ix.rubberStart) {
      const box = rubberRef.current;
      ix.rubberStart = null;
      setRubber(null);
      if (box) {
        const ids = elementsInBox(ix.curPage, box);
        setSelection({ ids, box: ids.length ? unionBox(ix.curPage, ids) : null });
      }
    }
  }, [ix, commitStroke, pushHistory, mutatePage]);

  // Keep a ref of the rubber box so release can read the final value.
  const rubberRef = useRef(null);
  useEffect(() => { rubberRef.current = rubber; }, [rubber]);

  const recomputeSelectionBox = useCallback(() => {
    setSelection((s) => (s.ids.length ? { ids: s.ids, box: unionBox(ix.curPage, s.ids) } : s));
  }, [ix]);

  const [shapeTool, setShapeTool] = useState(null);
  ix.shapeTool = shapeTool;

  const selectTool = (t) => {
    setTool(t);
    setShapeTool(null);
    ix.shapeTool = null;
    setSelection({ ids: [], box: null });
  };
  const selectShape = (t) => {
    setShapeTool(t);
    ix.shapeTool = t;
    setTool('shape');
    setSelection({ ids: [], box: null });
  };

  const deleteSelection = useCallback(() => {
    if (!selection.ids.length) return;
    pushHistory();
    const set = new Set(selection.ids);
    mutatePage((p) => {
      p.strokes = p.strokes.filter((s) => !set.has(s.id));
      p.shapes = p.shapes.filter((s) => !set.has(s.id));
      return p;
    });
    setSelection({ ids: [], box: null });
  }, [selection.ids, pushHistory, mutatePage]);

  const clearPage = useCallback(() => {
    pushHistory();
    mutatePage((p) => { p.strokes = []; p.shapes = []; return p; });
    setSelection({ ids: [], box: null });
  }, [pushHistory, mutatePage]);

  // ── Pages ────────────────────────────────────────────────────────────────
  const addPage = () => {
    setDoc((d) => ({ ...d, pages: [...d.pages, emptyPage(makeId('pg'))] }));
    setPageIndex(doc.pages.length);
    historyRef.current = { past: [], future: [] };
  };
  const goPage = (i) => {
    if (i < 0 || i >= doc.pages.length) return;
    setPageIndex(i);
    setSelection({ ids: [], box: null });
    historyRef.current = { past: [], future: [] };
  };
  const deletePage = () => {
    if (doc.pages.length <= 1) { clearPage(); return; }
    setDoc((d) => {
      const pages = d.pages.filter((_, i) => i !== pageIndex);
      return { ...d, pages };
    });
    setPageIndex((i) => Math.max(0, i - 1));
    historyRef.current = { past: [], future: [] };
  };

  // ── Text editor commit ───────────────────────────────────────────────────
  const commitText = () => {
    if (!textEditor) return;
    const { shapeId, value } = textEditor;
    mutatePage((p) => {
      p.shapes = p.shapes
        .map((s) => (s.id === shapeId ? { ...s, text: value } : s))
        .filter((s) => s.type !== 'text' || (s.text && s.text.length));
      return p;
    });
    setTextEditor(null);
  };

  // ── OCR ────────────────────────────────────────────────────────────────
  const captureSvgRef = useRef(null);
  const runOcrForPage = useCallback(
    (idx) =>
      new Promise((resolve, reject) => {
        setCaptureTarget(idx);
        // Give the offscreen capture SVG a frame to mount, then rasterize.
        setTimeout(async () => {
          try {
            const dataUrl = await svgToDataUrl(captureSvgRef.current, pageW, pageH);
            let markdown = '';
            try {
              const res = await sendReq('notes.ocr', { imageDataUrl: dataUrl });
              markdown = res?.markdown ?? '';
            } catch {
              // Fallback for gateways not yet restarted with notes.ocr.
              const b64 = dataUrl.replace(/^data:[^,]+,/, '');
              const res = await sendReq('vision.analyze', {
                imageBase64: b64,
                backend: 'claude',
                urgency: 'quality',
                prompt: OCR_PROMPT_FALLBACK,
              });
              markdown = res?.description ?? '';
            }
            resolve(markdown);
          } catch (err) {
            reject(err);
          } finally {
            setCaptureTarget(null);
          }
        }, 220);
      }),
    [sendReq, pageW, pageH],
  );

  const ocrCurrentPage = async () => {
    if (ocrBusy) return;
    if (!docHasInk({ ...doc, pages: [curPage] })) {
      setBanner({ kind: 'info', text: 'Nothing on this page to transcribe yet.' });
      return;
    }
    setOcrBusy(true);
    setOcrOpen(true);
    setOcrStatus(`Transcribing page ${pageIndex + 1}…`);
    try {
      const md = await runOcrForPage(pageIndex);
      const heading = doc.pages.length > 1 ? `## Page ${pageIndex + 1}\n\n` : '';
      const section = `${heading}${(md || '_No text detected._').trim()}`;
      setOcrMarkdown((prev) => mergePageSection(prev, pageIndex, section, doc.pages.length));
    } catch (err) {
      setBanner({ kind: 'error', text: `OCR failed: ${String(err?.message || err)}` });
    } finally {
      setOcrBusy(false);
      setOcrStatus('');
    }
  };

  const ocrAllPages = async () => {
    if (ocrBusy) return;
    setOcrBusy(true);
    setOcrOpen(true);
    const parts = [];
    try {
      for (let i = 0; i < doc.pages.length; i++) {
        if (!docHasInk({ ...doc, pages: [doc.pages[i]] })) continue;
        setOcrStatus(`Transcribing page ${i + 1} of ${doc.pages.length}…`);
        const md = await runOcrForPage(i);
        const heading = doc.pages.length > 1 ? `## Page ${i + 1}\n\n` : '';
        parts.push(`${heading}${(md || '_No text detected._').trim()}`);
      }
      setOcrMarkdown(parts.join('\n\n---\n\n'));
    } catch (err) {
      setBanner({ kind: 'error', text: `OCR failed: ${String(err?.message || err)}` });
    } finally {
      setOcrBusy(false);
      setOcrStatus('');
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────
  const handleSave = async () => {
    const title = name.trim() || 'Handwritten note';
    setSaving(true);
    try {
      const body = encodeNoteBody(ocrMarkdown, doc);
      if (note?.id) {
        await sendReq('notes.update', { id: note.id, name: title, body, category: CANVAS_CATEGORY });
      } else {
        await sendReq('notes.create', { name: title, body, category: CANVAS_CATEGORY });
      }
      onSaved && onSaved();
      onClose && onClose();
    } catch (err) {
      setBanner({ kind: 'error', text: `Save failed: ${String(err?.message || err)}` });
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  const isDrawing = tool === 'pen' || tool === 'highlighter';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={12}>
            <Text style={styles.hCancel}>Close</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.title}
            value={name}
            onChangeText={setName}
            placeholder="Handwritten note"
            placeholderTextColor={colors.textMuted}
          />
          <TouchableOpacity onPress={handleSave} disabled={saving} hitSlop={12}>
            <Text style={[styles.hSave, saving && { opacity: 0.4 }]}>{saving ? '…' : 'Save'}</Text>
          </TouchableOpacity>
        </View>

        {banner ? (
          <TouchableOpacity
            style={[styles.banner, banner.kind === 'error' ? styles.bannerErr : styles.bannerInfo]}
            onPress={() => setBanner(null)}
          >
            <Ionicons
              name={banner.kind === 'error' ? 'warning-outline' : 'information-circle-outline'}
              size={14}
              color={banner.kind === 'error' ? colors.error : colors.primary}
            />
            <Text style={[styles.bannerText, { color: banner.kind === 'error' ? colors.error : colors.primary }]}>
              {banner.text}
            </Text>
          </TouchableOpacity>
        ) : null}

        {/* Toolbar: tools */}
        <View style={styles.toolbar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolRow}>
            {TOOLS.map((t) => (
              <ToolBtn
                key={t}
                active={tool === t}
                colors={colors}
                icon={
                  t === 'pen' ? 'pencil' : t === 'highlighter' ? 'brush' : t === 'eraser' ? 'backspace-outline' : 'scan-outline'
                }
                onPress={() => selectTool(t)}
              />
            ))}
            <View style={styles.sep} />
            {SHAPES.map((s) => (
              <ToolBtn
                key={s.type}
                active={shapeTool === s.type}
                colors={colors}
                icon={s.icon}
                onPress={() => selectShape(s.type)}
              />
            ))}
            <View style={styles.sep} />
            <ToolBtn colors={colors} icon="arrow-undo-outline" onPress={undo} />
            <ToolBtn colors={colors} icon="arrow-redo-outline" onPress={redo} />
            <ToolBtn colors={colors} icon="trash-outline" onPress={clearPage} />
            {selection.ids.length ? (
              <ToolBtn colors={colors} icon="cut-outline" onPress={deleteSelection} active />
            ) : null}
            <ToolBtn
              colors={colors}
              icon={snapEnabled ? 'grid' : 'grid-outline'}
              active={snapEnabled}
              onPress={() => setSnapEnabled((v) => !v)}
            />
          </ScrollView>
        </View>

        {/* Palette + widths */}
        <View style={styles.paletteRow}>
          {PALETTE.map((c) => (
            <TouchableOpacity
              key={c}
              style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchActive]}
              onPress={() => setColor(c)}
            />
          ))}
          <View style={styles.sep} />
          {WIDTHS.map((w) => (
            <TouchableOpacity key={w} style={[styles.widthBtn, size === w && styles.widthActive]} onPress={() => setSize(w)}>
              <View style={{ width: w + 6, height: w + 6, borderRadius: 99, backgroundColor: color }} />
            </TouchableOpacity>
          ))}
        </View>

        {/* Canvas area */}
        <View
          style={styles.canvasArea}
          onLayout={(e) => setArea({ w: e.nativeEvent.layout.width - 16, h: e.nativeEvent.layout.height - 16 })}
        >
          <View style={[styles.canvasFrame, { width: dispW, height: dispH }]}>
            <Svg width={dispW} height={dispH} viewBox={`0 0 ${pageW} ${pageH}`}>
              {/* Faint dot grid — visible only, never captured for OCR */}
              {snapEnabled ? renderGrid(pageW, pageH, colors) : null}
              {curPage.shapes.map((s) => renderShape(s, false))}
              {curPage.strokes.map((s) => renderStroke(s, false))}
              {draftShape ? renderShape({ ...draftShape, id: 'draft' }, false) : null}
              {live && live.d ? (
                <Path d={live.d} fill={live.color} opacity={live.tool === 'highlighter' ? 0.32 : 1} />
              ) : null}
            </Svg>

            {/* Selection + rubber-band overlays (RN views, not captured) */}
            {selection.box ? (
              <View
                pointerEvents="none"
                style={[
                  styles.selBox,
                  {
                    left: selection.box.minX * scale,
                    top: selection.box.minY * scale,
                    width: (selection.box.maxX - selection.box.minX) * scale,
                    height: (selection.box.maxY - selection.box.minY) * scale,
                    borderColor: colors.primary,
                  },
                ]}
              />
            ) : null}
            {rubber ? (
              <View
                pointerEvents="none"
                style={[
                  styles.rubber,
                  {
                    left: rubber.minX * scale,
                    top: rubber.minY * scale,
                    width: (rubber.maxX - rubber.minX) * scale,
                    height: (rubber.maxY - rubber.minY) * scale,
                    borderColor: colors.primary,
                    backgroundColor: withAlpha(colors.primary, 0.08),
                  },
                ]}
              />
            ) : null}

            {/* Touch surface */}
            <View style={StyleSheet.absoluteFill} {...responder.panHandlers} />
          </View>

          {/* Page controls */}
          <View style={styles.pageBar}>
            <TouchableOpacity onPress={() => goPage(pageIndex - 1)} disabled={pageIndex === 0} hitSlop={8}>
              <Ionicons name="chevron-back" size={20} color={pageIndex === 0 ? colors.textMuted : colors.text} />
            </TouchableOpacity>
            <Text style={styles.pageLabel}>{`Page ${pageIndex + 1} / ${doc.pages.length}`}</Text>
            <TouchableOpacity onPress={() => goPage(pageIndex + 1)} disabled={pageIndex >= doc.pages.length - 1} hitSlop={8}>
              <Ionicons name="chevron-forward" size={20} color={pageIndex >= doc.pages.length - 1 ? colors.textMuted : colors.text} />
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={addPage} style={styles.pageBtn}>
              <Ionicons name="add" size={16} color={colors.primary} />
              <Text style={styles.pageBtnText}>Page</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={deletePage} style={styles.pageBtn}>
              <Ionicons name="remove-circle-outline" size={16} color={colors.error} />
            </TouchableOpacity>
          </View>
        </View>

        {/* OCR paired panel */}
        <View style={[styles.ocrPanel, ocrOpen && styles.ocrPanelOpen]}>
          <BlurView intensity={Platform.OS === 'android' ? 40 : 55} tint="dark" style={StyleSheet.absoluteFill} />
          <LinearGradient
            colors={[withAlpha(colors.primary, 0.16), 'rgba(0,0,0,0.5)']}
            style={StyleSheet.absoluteFill}
          />
          <TouchableOpacity style={styles.ocrHeader} activeOpacity={0.8} onPress={() => setOcrOpen((v) => !v)}>
            <Ionicons name="sparkles-outline" size={16} color={colors.primary} />
            <Text style={styles.ocrTitle}>AI Transcript</Text>
            {ocrBusy ? <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 8 }} /> : null}
            <Text style={styles.ocrStatus} numberOfLines={1}>{ocrStatus}</Text>
            <View style={{ flex: 1 }} />
            {ocrMarkdown ? (
              <TouchableOpacity onPress={() => setOcrRaw((v) => !v)} style={styles.ocrToggle} hitSlop={8}>
                <Text style={styles.ocrToggleText}>{ocrRaw ? 'Rendered' : 'Raw'}</Text>
              </TouchableOpacity>
            ) : null}
            <Ionicons name={ocrOpen ? 'chevron-down' : 'chevron-up'} size={18} color={colors.text} />
          </TouchableOpacity>

          {ocrOpen ? (
            <View style={styles.ocrBody}>
              <View style={styles.ocrActions}>
                <TouchableOpacity style={styles.ocrBtn} onPress={ocrCurrentPage} disabled={ocrBusy}>
                  <Ionicons name="scan-outline" size={14} color={colors.primary} />
                  <Text style={styles.ocrBtnText}>OCR page</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.ocrBtn} onPress={ocrAllPages} disabled={ocrBusy}>
                  <Ionicons name="albums-outline" size={14} color={colors.primary} />
                  <Text style={styles.ocrBtnText}>OCR all</Text>
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.ocrScroll} contentContainerStyle={{ padding: 12, paddingBottom: 28 }}>
                {ocrMarkdown ? (
                  ocrRaw ? (
                    <Text selectable style={styles.ocrRawText}>{ocrMarkdown}</Text>
                  ) : (
                    <Markdown style={mdStyles}>{ocrMarkdown}</Markdown>
                  )
                ) : (
                  <Text style={styles.ocrEmpty}>
                    Write or diagram on the canvas, then tap “OCR page” to convert your handwriting
                    and diagrams into markdown.
                  </Text>
                )}
              </ScrollView>
            </View>
          ) : null}
        </View>

        {/* Offscreen capture SVG for OCR (white bg, dark ink) */}
        {captureTarget != null ? (
          <View style={[styles.offscreen, { width: pageW, height: pageH }]} pointerEvents="none">
            <Svg
              ref={captureSvgRef}
              width={pageW}
              height={pageH}
              viewBox={`0 0 ${pageW} ${pageH}`}
            >
              <Rect x={0} y={0} width={pageW} height={pageH} fill="#FFFFFF" />
              {(doc.pages[captureTarget]?.shapes || []).map((s) => renderShape(s, true))}
              {(doc.pages[captureTarget]?.strokes || []).map((s) => renderStroke(s, true))}
            </Svg>
          </View>
        ) : null}

        {/* Inline text-box editor */}
        <Modal visible={!!textEditor} transparent animationType="fade" onRequestClose={commitText}>
          <View style={styles.textModalWrap}>
            <View style={styles.textModal}>
              <Text style={styles.textModalLabel}>Text box</Text>
              <TextInput
                style={styles.textModalInput}
                value={textEditor?.value || ''}
                onChangeText={(v) => setTextEditor((t) => ({ ...t, value: v }))}
                placeholder="Type text…"
                placeholderTextColor={colors.textMuted}
                autoFocus
                multiline
              />
              <TouchableOpacity style={styles.textModalBtn} onPress={commitText}>
                <Text style={styles.textModalBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </View>
    </Modal>
  );
}

// ── selection geometry helpers ─────────────────────────────────────────────
function elementsInBox(page, box) {
  const ids = [];
  for (const st of page.strokes) {
    const b = strokeBBox(st);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    if (pointInBox(cx, cy, box)) ids.push(st.id);
  }
  for (const sh of page.shapes) {
    const b = shapeBBox(sh);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    if (pointInBox(cx, cy, box)) ids.push(sh.id);
  }
  return ids;
}

function unionBox(page, ids) {
  const set = new Set(ids);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consume = (b) => {
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  };
  for (const st of page.strokes) if (set.has(st.id)) consume(strokeBBox(st));
  for (const sh of page.shapes) if (set.has(sh.id)) consume(shapeBBox(sh));
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

function renderGrid(w, h, colors) {
  const els = [];
  const step = 80;
  for (let x = step; x < w; x += step) {
    els.push(<Line key={`gx${x}`} x1={x} y1={0} x2={x} y2={h} stroke={withAlpha(colors.primary, 0.05)} strokeWidth={1} />);
  }
  for (let y = step; y < h; y += step) {
    els.push(<Line key={`gy${y}`} x1={0} y1={y} x2={w} y2={y} stroke={withAlpha(colors.primary, 0.05)} strokeWidth={1} />);
  }
  return <G>{els}</G>;
}

// Replace/insert a page's markdown section inside the combined transcript.
function mergePageSection(prev, idx, section, total) {
  if (total <= 1) return section;
  const parts = (prev || '').split(/\n\n---\n\n/).filter(Boolean);
  const want = `## Page ${idx + 1}`;
  const cleaned = parts.filter((p) => !p.trim().startsWith(want));
  cleaned.push(section);
  cleaned.sort((a, b) => pageNum(a) - pageNum(b));
  return cleaned.join('\n\n---\n\n');
}
function pageNum(s) {
  const m = s.match(/## Page (\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function ToolBtn({ icon, active, onPress, colors }) {
  return (
    <TouchableOpacity
      style={[
        styles0.tb,
        {
          backgroundColor: active ? withAlpha(colors.primary, 0.22) : withAlpha('#000', 0.3),
          borderColor: active ? colors.primary : withAlpha(colors.primary, 0.18),
        },
      ]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Ionicons name={icon} size={18} color={active ? colors.primary : colors.text} />
    </TouchableOpacity>
  );
}

const styles0 = StyleSheet.create({
  tb: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginRight: 8,
  },
});

function makeStyles(colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: Platform.OS === 'ios' ? 52 : 14,
      paddingBottom: 12,
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: withAlpha(colors.primary, 0.14),
    },
    hCancel: { color: colors.textSecondary, fontSize: 15 },
    hSave: { color: colors.primary, fontSize: 15, fontWeight: '700' },
    title: { flex: 1, textAlign: 'center', color: colors.text, fontSize: 16, fontWeight: '600', marginHorizontal: 12 },

    banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginTop: 8, padding: 8, borderRadius: 10, borderWidth: 1 },
    bannerErr: { backgroundColor: withAlpha(colors.error, 0.12), borderColor: withAlpha(colors.error, 0.35) },
    bannerInfo: { backgroundColor: withAlpha(colors.primary, 0.1), borderColor: withAlpha(colors.primary, 0.3) },
    bannerText: { flex: 1, fontSize: 12 },

    toolbar: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: withAlpha(colors.primary, 0.08) },
    toolRow: { paddingHorizontal: 12, alignItems: 'center' },
    sep: { width: 1, height: 26, backgroundColor: withAlpha(colors.primary, 0.2), marginRight: 8 },

    paletteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 8,
      borderBottomWidth: 1,
      borderBottomColor: withAlpha(colors.primary, 0.08),
      flexWrap: 'wrap',
    },
    swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'rgba(255,255,255,0.15)' },
    swatchActive: { borderColor: colors.primary, transform: [{ scale: 1.15 }] },
    widthBtn: {
      width: 34,
      height: 34,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.18),
    },
    widthActive: { borderColor: colors.primary, backgroundColor: withAlpha(colors.primary, 0.15) },

    canvasArea: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8 },
    canvasFrame: {
      backgroundColor: '#0b0b0d',
      borderRadius: 12,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.22),
    },
    selBox: { position: 'absolute', borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 4 },
    rubber: { position: 'absolute', borderWidth: 1, borderStyle: 'dashed' },

    pageBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 8 },
    pageLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
    pageBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: withAlpha(colors.primary, 0.2), marginLeft: 6 },
    pageBtnText: { color: colors.primary, fontSize: 12, fontWeight: '700' },

    ocrPanel: { height: 46, overflow: 'hidden', borderTopWidth: 1, borderTopColor: withAlpha(colors.primary, 0.2) },
    ocrPanelOpen: { height: 300 },
    ocrHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, height: 46 },
    ocrTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
    ocrStatus: { color: colors.textMuted, fontSize: 11, marginLeft: 8, maxWidth: 160 },
    ocrToggle: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: withAlpha(colors.primary, 0.35), marginRight: 8 },
    ocrToggleText: { color: colors.primary, fontSize: 11, fontWeight: '700' },
    ocrBody: { flex: 1 },
    ocrActions: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 4 },
    ocrBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: withAlpha(colors.primary, 0.3), backgroundColor: withAlpha(colors.primary, 0.08) },
    ocrBtnText: { color: colors.primary, fontSize: 12, fontWeight: '700' },
    ocrScroll: { flex: 1 },
    ocrRawText: { color: colors.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 18 },
    ocrEmpty: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },

    // Rendered fully off-screen (not display:none / not opacity:0) so
    // react-native-svg's toDataURL still composites the layer for capture.
    offscreen: { position: 'absolute', left: -100000, top: 0 },

    textModalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 },
    textModal: { width: '100%', backgroundColor: colors.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: withAlpha(colors.primary, 0.3) },
    textModalLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 8 },
    textModalInput: { color: colors.text, fontSize: 16, minHeight: 80, borderWidth: 1, borderColor: withAlpha(colors.primary, 0.2), borderRadius: 10, padding: 10, textAlignVertical: 'top' },
    textModalBtn: { marginTop: 12, alignSelf: 'flex-end', backgroundColor: colors.primary, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 10 },
    textModalBtnText: { color: colors.bg || '#000', fontWeight: '700' },
  });
}

function makeMdStyles(colors) {
  return {
    body: { color: colors.text, fontSize: 14, lineHeight: 21 },
    heading1: { color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 8, marginBottom: 6 },
    heading2: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 10, marginBottom: 4 },
    strong: { color: colors.text, fontWeight: '700' },
    link: { color: colors.primary },
    bullet_list_icon: { color: colors.primary },
    ordered_list_icon: { color: colors.primary },
    code_inline: { backgroundColor: withAlpha(colors.primary, 0.12), color: colors.primary, borderRadius: 4, paddingHorizontal: 4 },
    fence: { backgroundColor: withAlpha('#000', 0.5), color: colors.text, borderColor: withAlpha(colors.primary, 0.25), borderWidth: 1, borderRadius: 10, padding: 10 },
    code_block: { backgroundColor: withAlpha('#000', 0.5), color: colors.text, borderRadius: 10, padding: 10 },
    hr: { backgroundColor: withAlpha(colors.primary, 0.25), height: 1, marginVertical: 12 },
    table: { borderColor: withAlpha(colors.primary, 0.22), borderWidth: 1, borderRadius: 8 },
    th: { padding: 6, color: colors.text, fontWeight: '700' },
    td: { padding: 6, color: colors.text },
  };
}
