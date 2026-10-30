/**
 * WhiteboardScreen — native Whiteboard (web /whiteboard, plugin `whiteboard`).
 *
 * One-to-one with the web page's live Excalidraw canvas:
 *   toolbar      Boards · Templates · Save to Boards · Clear canvas · status
 *   canvas       native SVG renderer + gestures (WhiteboardCanvas)
 *   tools        select / pan / rectangle / diamond / ellipse / arrow / line /
 *                draw / text / eraser, tool lock, style panel, undo / redo,
 *                zoom - / % / + / fit
 *   Canvas Architect  sessions.spawn { agentId: 'canvas' } + transcript poll
 *
 * Data: whiteboard.boards.{list,get,save,rename,delete},
 * whiteboard.templates.{list,get,save}, whiteboard.canvas.{update,clear}
 * (broadcast on board/template load + clear, exactly like the web), and the
 * gateway's `canvas.update` / `canvas.clear` / `canvas.view` events so agent
 * (excalidraw_*) and other-device edits land here live. An open board
 * auto-saves (debounced) after local edits, with the web's "never blank a
 * loaded board" guard.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';

import { AppHeader, IconButton, Button, Chip, useUIKit, SPACE, RADIUS, HIT } from '../../ui-kit';
import { PluginGate } from '../../components/PluginGate';
import { withAlpha } from '../../theme/color-utils';
import { WhiteboardCanvas } from './WhiteboardCanvas';
import { BoardsSheet, TemplatesSheet, StyleSheetPanel, ArchitectSheet, MoreSheet, PromptModal, ConfirmModal } from './WhiteboardPanels';
import { renderColor, sceneBounds, fitCamera, zoomAround, centerOn, elementBounds, boundsCenter, clampZoom } from './whiteboard-geometry';
import {
  TOOLS,
  DRAW_TOOLS,
  DEFAULT_STYLE,
  PAPER_COLOR,
  BUILTIN_TEMPLATES,
  createHistory,
  pushHistory,
  undo as undoH,
  redo as redoH,
  canUndo,
  canRedo,
  normalizeElements,
  sceneFromBoardData,
  boardDataFromScene,
  sceneSignature,
  shouldAutosave,
  createElement,
  setText,
  setContainerLabel,
  containerLabel,
  deleteElements,
  duplicateElements,
  updateStyle,
  reorder,
  templateElements,
  mergeTemplates,
  normalizeBoards,
  slugifyBoardName,
  isValidBoardId,
  uniqueBoardId,
  architectSpawnParams,
  architectReply,
  sceneSummary,
  newElementId,
} from './whiteboard-model';

const AUTOSAVE_MS = 1200;
const RPC_TIMEOUT = 15000;

function withTimeout(p, ms = RPC_TIMEOUT) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Request timed out')), ms))]);
}

const errText = (e) => (e && e.message ? e.message : String(e || 'Unknown error'));

export function WhiteboardScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const landscape = winW > winH;
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected' || gateway?.connected === true;

  // ── scene state ──
  const [history, setHistory] = useState(() => createHistory([]));
  const elements = history.present;
  const [selected, setSelected] = useState([]);
  const [tool, setTool] = useState('select');
  const [toolLocked, setToolLocked] = useState(false);
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [dark, setDark] = useState(true);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  // ── board + persistence ──
  const [board, setBoard] = useState(null); // { id, data, loadedCount }
  const [saveState, setSaveState] = useState('idle'); // idle | pending | saving | saved | error
  const [saveError, setSaveError] = useState(null);
  const [boards, setBoards] = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [boardsError, setBoardsError] = useState(null);
  const [templates, setTemplates] = useState(BUILTIN_TEMPLATES);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [liveAt, setLiveAt] = useState(0);
  const [toast, setToast] = useState(null);

  // ── overlays ──
  const [sheet, setSheet] = useState(null); // boards | templates | style | architect | more
  const [prompt, setPromptRaw] = useState(null);
  const setPrompt = useCallback((p) => setPromptRaw(p ? { ...p, openedAt: Date.now() } : null), []);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  // ── canvas architect ──
  const [archMessages, setArchMessages] = useState([]);
  const [archBusy, setArchBusy] = useState(false);

  const mounted = useRef(true);
  const lastBroadcastSig = useRef(null);
  const saveTimer = useRef(null);
  const latest = useRef({});
  latest.current = { elements, board, sendReq, viewport };
  const explicitClear = useRef(false);
  const fittedOnce = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const flash = useCallback((msg, tone = 'success') => {
    setToast({ msg, tone, at: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => mounted.current && setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // ── camera helpers ──
  const fitTo = useCallback((els) => {
    const vp = latest.current.viewport;
    if (!vp.width) return;
    const b = sceneBounds(els || latest.current.elements);
    setCamera(b ? fitCamera(b, vp.width, vp.height, 40, 1) : { x: vp.width / 2 - 200, y: vp.height / 2 - 200, zoom: 1 });
  }, []);

  useEffect(() => {
    if (viewport.width && !fittedOnce.current) {
      fittedOnce.current = true;
      setCamera({ x: SPACE.lg, y: SPACE.lg, zoom: 1 });
    }
  }, [viewport.width]);

  const zoomBy = (f) => {
    setCamera((c) => zoomAround(c, clampZoom(c.zoom * f), viewport.width / 2, viewport.height / 2));
  };

  // ── persistence ──
  const doSave = useCallback(async (id, els, opts = {}) => {
    const req = latest.current.sendReq;
    if (!req || !id) return false;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    setSaveState('saving');
    setSaveError(null);
    try {
      const data = boardDataFromScene(els, latest.current.board && latest.current.board.data);
      await withTimeout(req('whiteboard.boards.save', { id, data }));
      if (!mounted.current) return true;
      setSaveState('saved');
      setBoard((b) => (b && b.id === id ? { ...b, data, loadedCount: els.length } : opts.open ? { id, data, loadedCount: els.length } : b));
      explicitClear.current = false;
      setBoards((rows) => {
        const now = Date.now();
        const has = rows.some((r) => r.id === id);
        const next = has ? rows.map((r) => (r.id === id ? { ...r, updatedAt: now } : r)) : [{ id, name: id.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), createdAt: now, updatedAt: now }, ...rows];
        return [...next].sort((a, b) => b.updatedAt - a.updatedAt);
      });
      return true;
    } catch (e) {
      if (mounted.current) {
        setSaveState('error');
        setSaveError(errText(e));
      }
      return false;
    }
  }, []);

  const scheduleSave = useCallback(() => {
    const { board: b } = latest.current;
    if (!b) return;
    setSaveState('pending');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const { elements: els, board: cur } = latest.current;
      if (!cur) return;
      if (!shouldAutosave({ boardId: cur.id, elementCount: els.length, loadedCount: cur.loadedCount, explicitClear: explicitClear.current })) {
        setSaveState('idle');
        return;
      }
      doSave(cur.id, els);
    }, AUTOSAVE_MS);
  }, [doSave]);

  // Flush a pending autosave when leaving the screen.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        const { elements: els, board: cur, sendReq: req } = latest.current;
        if (cur && req && shouldAutosave({ boardId: cur.id, elementCount: els.length, loadedCount: cur.loadedCount, explicitClear: explicitClear.current })) {
          req('whiteboard.boards.save', { id: cur.id, data: boardDataFromScene(els, cur.data) }).catch(() => {});
        }
      }
    },
    [],
  );

  // ── edits ──
  const commit = useCallback(
    (next, selectIds) => {
      if (!next.length) explicitClear.current = true;
      setHistory((h) => pushHistory(h, next));
      if (selectIds) setSelected(selectIds);
      else setSelected((sel) => sel.filter((id) => next.some((e) => e.id === id)));
      scheduleSave();
    },
    [scheduleSave],
  );

  const doUndo = () => {
    setHistory((h) => undoH(h));
    setSelected([]);
    scheduleSave();
  };
  const doRedo = () => {
    setHistory((h) => redoH(h));
    setSelected([]);
    scheduleSave();
  };

  const broadcast = useCallback(async (els) => {
    const req = latest.current.sendReq;
    if (!req) return;
    lastBroadcastSig.current = sceneSignature(els);
    try {
      await withTimeout(req('whiteboard.canvas.update', { elements: els }), 8000);
    } catch {
      /* best effort — the web does the same */
    }
  }, []);

  // ── boards / templates loading ──
  const loadBoards = useCallback(async () => {
    if (!sendReq) return;
    setBoardsLoading(true);
    setBoardsError(null);
    try {
      const res = await withTimeout(sendReq('whiteboard.boards.list', {}));
      if (mounted.current) setBoards(normalizeBoards(res));
    } catch (e) {
      if (mounted.current) setBoardsError(errText(e));
    } finally {
      if (mounted.current) setBoardsLoading(false);
    }
  }, [sendReq]);

  const loadTemplates = useCallback(async () => {
    if (!sendReq) return;
    setTemplatesLoading(true);
    try {
      const res = await withTimeout(sendReq('whiteboard.templates.list', {}));
      const rows = Array.isArray(res && res.templates) ? res.templates : [];
      const got = await Promise.allSettled(rows.map((r) => withTimeout(sendReq('whiteboard.templates.get', { id: r.id })).then((x) => ({ ...r, data: x && x.data }))));
      if (mounted.current) setTemplates(mergeTemplates(got.filter((g) => g.status === 'fulfilled').map((g) => g.value)));
    } catch {
      if (mounted.current) setTemplates(BUILTIN_TEMPLATES);
    } finally {
      if (mounted.current) setTemplatesLoading(false);
    }
  }, [sendReq]);

  useEffect(() => {
    if (!connected) return;
    Promise.allSettled([loadBoards(), loadTemplates()]);
  }, [connected, loadBoards, loadTemplates]);

  // ── live canvas events (agents / other surfaces) ──
  useEffect(() => {
    const sub = gateway?.subscribeEvent;
    if (!sub) return undefined;
    const offUpdate = sub('canvas.update', (payload) => {
      const raw = payload && payload.elements;
      if (!Array.isArray(raw)) return;
      if (lastBroadcastSig.current && sceneSignature(raw) === lastBroadcastSig.current) return; // our own echo
      const next = normalizeElements(raw);
      const wasEmpty = latest.current.elements.length === 0;
      setHistory((h) => pushHistory(h, next));
      setSelected((sel) => sel.filter((id) => next.some((e) => e.id === id)));
      setLiveAt(Date.now());
      if (wasEmpty && next.length) fitTo(next);
    });
    const offClear = sub('canvas.clear', () => {
      setHistory((h) => (h.present.length ? pushHistory(h, []) : h));
      setSelected([]);
      setLiveAt(Date.now());
    });
    const offView = sub('canvas.view', (p) => {
      const vp = latest.current.viewport;
      if (!p || !vp.width) return;
      if (p.scrollToElementId) {
        const el = latest.current.elements.find((e) => e.id === p.scrollToElementId);
        if (el) {
          const [cx, cy] = boundsCenter(elementBounds(el));
          setCamera((c) => centerOn(c, cx, cy, vp.width, vp.height, typeof p.zoom === 'number' ? p.zoom : undefined));
          return;
        }
      }
      if (p.fitToContent) {
        fitTo();
        return;
      }
      if (typeof p.zoom === 'number') setCamera((c) => zoomAround(c, p.zoom, vp.width / 2, vp.height / 2));
    });
    return () => {
      offUpdate && offUpdate();
      offClear && offClear();
      offView && offView();
    };
  }, [gateway?.subscribeEvent, fitTo]);

  // ── actions ──
  const openBoard = useCallback(
    async (id) => {
      if (!sendReq) return;
      setBusy(true);
      try {
        if (saveTimer.current && latest.current.board) await doSave(latest.current.board.id, latest.current.elements);
        const res = await withTimeout(sendReq('whiteboard.boards.get', { id }));
        const els = sceneFromBoardData(res && res.data);
        setHistory(createHistory(els));
        setSelected([]);
        setBoard({ id, data: res && res.data, loadedCount: els.length });
        setSaveState('saved');
        explicitClear.current = false;
        setSheet(null);
        fitTo(els);
        if (els.length) broadcast(els);
      } catch (e) {
        flash(`Couldn't open board: ${errText(e)}`, 'danger');
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [sendReq, doSave, broadcast, fitTo, flash],
  );

  const loadTemplate = (t) => {
    const els = templateElements(t);
    commit(els, []);
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    setBoard(null);
    setSaveState('idle');
    setSheet(null);
    fitTo(els);
    broadcast(els);
    flash(`${t.name} loaded`);
  };

  const newBoardFromTemplate = (t) => {
    const id = uniqueBoardId(`${t.name}`, boards);
    setPrompt({
      title: 'New board from template',
      subtitle: t.name,
      label: 'Board name',
      initial: id,
      confirmLabel: 'Create',
      hint: 'Saved as a lowercase-hyphen id',
      onConfirm: async (name) => {
        const bid = slugifyBoardName(name);
        const els = templateElements(t, true);
        setBusy(true);
        const ok = await doSave(bid, els, { open: true });
        setBusy(false);
        if (!ok) return flash("Couldn't create the board", 'danger');
        setHistory(createHistory(els));
        setSelected([]);
        setBoard({ id: bid, data: boardDataFromScene(els), loadedCount: els.length });
        setPrompt(null);
        setSheet(null);
        fitTo(els);
        broadcast(els);
        flash(`Board "${bid}" created`);
      },
    });
  };

  const validateNewId = (name) => {
    const id = slugifyBoardName(name);
    if (!String(name).trim()) return null;
    if (!isValidBoardId(id)) return 'Use letters, numbers and spaces';
    return null;
  };

  const saveCanvasAs = () => {
    setPrompt({
      title: 'Save canvas as',
      label: 'Board name',
      initial: board ? board.id : 'my-drawing',
      confirmLabel: 'Save',
      validate: validateNewId,
      hint: 'Same name overwrites that board',
      onConfirm: async (name) => {
        const id = slugifyBoardName(name);
        setBusy(true);
        const ok = await doSave(id, elements, { open: true });
        setBusy(false);
        if (!ok) return flash("Couldn't save the board", 'danger');
        setBoard({ id, data: boardDataFromScene(elements), loadedCount: elements.length });
        setPrompt(null);
        flash(`Saved as "${name.trim()}"`);
      },
    });
  };

  const onSavePress = async () => {
    if (!board) return saveCanvasAs();
    const ok = await doSave(board.id, elements);
    flash(ok ? `Saved "${board.id}"` : "Couldn't save the board", ok ? 'success' : 'danger');
  };

  const newBoard = () => {
    setPrompt({
      title: 'New board',
      label: 'Board name',
      initial: '',
      placeholder: 'Product roadmap',
      confirmLabel: 'Create',
      validate: (n) => validateNewId(n) || (boards.some((b) => b.id === slugifyBoardName(n)) ? 'A board with that name exists' : null),
      onConfirm: async (name) => {
        const id = slugifyBoardName(name);
        setBusy(true);
        const ok = await doSave(id, [], { open: true });
        setBusy(false);
        if (!ok) return flash("Couldn't create the board", 'danger');
        setHistory(createHistory([]));
        setSelected([]);
        setBoard({ id, data: boardDataFromScene([]), loadedCount: 0 });
        setPrompt(null);
        setSheet(null);
        flash(`Board "${id}" created`);
      },
    });
  };

  const renameBoard = (b) => {
    setPrompt({
      title: 'Rename board',
      label: 'New name',
      initial: b.name,
      confirmLabel: 'Rename',
      validate: (n) => validateNewId(n) || (slugifyBoardName(n) !== b.id && boards.some((x) => x.id === slugifyBoardName(n)) ? 'A board with that name exists' : null),
      onConfirm: async (name) => {
        const newId = slugifyBoardName(name);
        if (newId === b.id) return setPrompt(null);
        setBusy(true);
        try {
          await withTimeout(sendReq('whiteboard.boards.rename', { id: b.id, newId }));
          if (board && board.id === b.id) setBoard((cur) => (cur ? { ...cur, id: newId } : cur));
          setPrompt(null);
          flash(`Renamed to "${newId}"`);
          loadBoards();
        } catch (e) {
          flash(`Rename failed: ${errText(e)}`, 'danger');
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const deleteBoard = (b) => {
    setConfirm({
      title: `Delete "${b.id}"?`,
      message: 'The board file is removed from the plugin data folder. The live canvas is not changed.',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        setBusy(true);
        try {
          await withTimeout(sendReq('whiteboard.boards.delete', { id: b.id }));
          setBoards((rows) => rows.filter((r) => r.id !== b.id));
          if (board && board.id === b.id) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
            setBoard(null);
            setSaveState('idle');
          }
          setConfirm(null);
          flash('Board deleted');
        } catch (e) {
          flash(`Delete failed: ${errText(e)}`, 'danger');
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const clearCanvas = () => {
    setConfirm({
      title: 'Clear the entire canvas?',
      message: 'Empties the live canvas here, on the web whiteboard and for agents. Saved boards are kept.',
      confirmLabel: 'Clear canvas',
      onConfirm: async () => {
        setConfirm(null);
        setHistory((h) => pushHistory(h, []));
        setSelected([]);
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        setBoard(null);
        setSaveState('idle');
        lastBroadcastSig.current = sceneSignature([]);
        try {
          await withTimeout(sendReq('whiteboard.canvas.clear', {}), 8000);
        } catch {
          /* best effort */
        }
      },
    });
  };

  const saveAsTemplate = () => {
    setPrompt({
      title: 'Save as template',
      label: 'Template name',
      initial: board ? board.id : '',
      confirmLabel: 'Save template',
      validate: validateNewId,
      onConfirm: async (name) => {
        setBusy(true);
        try {
          await withTimeout(sendReq('whiteboard.templates.save', { id: slugifyBoardName(name), data: boardDataFromScene(elements, board && board.data) }));
          setPrompt(null);
          flash('Template saved');
          loadTemplates();
        } catch (e) {
          flash(`Template save failed: ${errText(e)}`, 'danger');
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const copyScene = async () => {
    const pick = selected.length ? elements.filter((e) => selected.includes(e.id) || (e.containerId && selected.includes(e.containerId))) : elements;
    try {
      await Clipboard.setStringAsync(JSON.stringify({ type: 'excalidraw/clipboard', elements: pick, files: {} }, null, 2));
      flash(`Copied ${pick.length} element${pick.length === 1 ? '' : 's'}`);
    } catch (e) {
      flash(`Copy failed: ${errText(e)}`, 'danger');
    }
  };

  const pasteScene = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (!text) return flash('Clipboard is empty', 'warning');
      const data = JSON.parse(text);
      if (data.type !== 'excalidraw' && data.type !== 'excalidraw/clipboard' && !data.elements) return flash("Clipboard doesn't contain Excalidraw data", 'warning');
      const idMap = new Map();
      const incoming = normalizeElements(data.elements || []).map((el) => {
        const id = newElementId();
        idMap.set(el.id, id);
        return { ...el, id, x: el.x + 50, y: el.y + 50, version: 1 };
      });
      const fixed = incoming.map((el) => (el.containerId && idMap.has(el.containerId) ? { ...el, containerId: idMap.get(el.containerId) } : el));
      commit([...elements, ...fixed], fixed.filter((e) => !e.containerId).map((e) => e.id));
      flash(`Pasted ${fixed.length} element${fixed.length === 1 ? '' : 's'}`);
    } catch {
      flash("Clipboard doesn't contain valid JSON", 'warning');
    }
  };

  // ── text entry ──
  const requestText = ({ x, y }) => {
    setPrompt({
      title: 'Add text',
      label: 'Text',
      initial: '',
      multiline: true,
      confirmLabel: 'Add',
      onConfirm: (value) => {
        const el = setText(createElement('text', x, y, style), value);
        commit([...latest.current.elements, el], [el.id]);
        setPrompt(null);
        if (!toolLocked) setTool('select');
      },
    });
  };

  const editText = (id) => {
    const el = elements.find((e) => e.id === id);
    if (!el) return;
    const current = el.type === 'text' ? el.text : (containerLabel(elements, el) || {}).element?.text ?? (containerLabel(elements, el) || {}).text ?? '';
    if (el.type === 'freedraw') return;
    setPrompt({
      title: el.type === 'text' ? 'Edit text' : 'Label',
      label: el.type === 'text' ? 'Text' : 'Label text',
      initial: current || '',
      multiline: true,
      confirmLabel: 'Done',
      onConfirm: (value) => {
        const els = latest.current.elements;
        const next = el.type === 'text' ? els.map((e) => (e.id === id ? setText(e, value) : e)) : setContainerLabel(els, id, value);
        commit(next, [id]);
        setPrompt(null);
      },
    });
  };

  // ── style ──
  const selectionStyle = useMemo(() => {
    const first = elements.find((e) => selected.includes(e.id));
    if (!first) return style;
    const bound = elements.find((e) => e.type === 'text' && e.containerId === first.id);
    return { ...style, ...first, fontSize: first.fontSize || (bound && bound.fontSize) || style.fontSize };
  }, [elements, selected, style]);

  const applyStyle = (patch) => {
    setStyle((s) => ({ ...s, ...patch }));
    if (selected.length) commit(updateStyle(elements, selected, patch), selected);
  };

  const selectionHasText = elements.some((e) => selected.includes(e.id) && (e.type === 'text' || elements.some((t) => t.containerId === e.id)));

  // ── canvas architect ──
  const pollRef = useRef(0);
  const sendArchitect = async (text) => {
    if (!sendReq) return;
    setArchMessages((m) => [...m, { role: 'user', content: text }]);
    setArchBusy(true);
    try {
      const res = await withTimeout(sendReq('sessions.spawn', architectSpawnParams(text)), 30000);
      if (res && res.status === 'accepted' && res.runId) {
        setArchMessages((m) => [...m, { role: 'assistant', loading: true }]);
        const token = ++pollRef.current;
        const key = res.childSessionKey;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          if (!mounted.current || token !== pollRef.current) return;
          try {
            const tr = await sendReq('sessions.transcript', { sessionKey: key, limit: 5 });
            const reply = architectReply(tr);
            if (reply) {
              setArchMessages((m) => [...m.slice(0, -1), { role: 'assistant', content: reply }]);
              return;
            }
          } catch {
            /* session not ready yet */
          }
        }
        setArchMessages((m) => [...m.slice(0, -1), { role: 'assistant', content: 'Canvas Architect is still working. Check the canvas — your diagram may already be there.' }]);
      } else {
        const reply = (res && ((res.result && res.result.reply) || res.reply)) || 'Request sent to Canvas Architect. The diagram will appear on the canvas shortly.';
        setArchMessages((m) => [...m, { role: 'assistant', content: reply }]);
      }
    } catch (e) {
      setArchMessages((m) => [...m, { role: 'assistant', tone: 'error', content: `Canvas Agent unavailable: ${errText(e)}\n\nTry asking Infini in the main chat instead.` }]);
    } finally {
      if (mounted.current) setArchBusy(false);
    }
  };
  useEffect(() => () => void (pollRef.current += 1), []);

  // ── render ──
  const paper = renderColor(PAPER_COLOR, dark);
  const summary = sceneSummary(elements);
  const side = landscape;
  const saveLabel =
    !board
      ? 'Not saved to a board'
      : saveState === 'saving'
        ? 'Saving...'
        : saveState === 'pending'
          ? 'Unsaved changes'
          : saveState === 'error'
            ? 'Save failed'
            : 'Saved';
  const saveTone = !board ? 'neutral' : saveState === 'error' ? 'danger' : saveState === 'saved' ? 'success' : 'warning';
  const live = liveAt && Date.now() - liveAt < 8000;

  const headerRight = (
    <View style={styles.headerActions}>
      <IconButton icon="folder-open-outline" onPress={() => { setSheet('boards'); loadBoards(); }} accessibilityLabel="Boards" />
      <IconButton icon="grid-outline" onPress={() => setSheet('templates')} accessibilityLabel="Templates" />
      <IconButton icon="save-outline" tone={colors.success} onPress={onSavePress} loading={saveState === 'saving'} accessibilityLabel={board ? 'Save board' : 'Save to Boards'} />
      <IconButton icon="ellipsis-horizontal" onPress={() => setSheet('more')} accessibilityLabel="More canvas actions" />
    </View>
  );

  const statusInner = (
    <>
        <View style={[styles.dot, { backgroundColor: connected ? colors.success : colors.error }]} />
        <Text style={[type.caption, { color: colors.textSecondary }]}>{connected ? 'Connected' : 'Offline'}</Text>
        <Pressable onPress={() => { setSheet('boards'); loadBoards(); }} accessibilityRole="button" accessibilityLabel="Current board" style={styles.boardName} hitSlop={8}>
          <Ionicons name="easel-outline" size={14} color={colors.primary} />
          <Text style={[type.monoSmall, { color: board ? colors.primary : colors.textMuted, flexShrink: 1 }]} numberOfLines={1}>
            {board ? board.id : 'live canvas'}
          </Text>
        </Pressable>
        <View style={styles.flex} />
        {live ? <Chip label="Live" tone="info" dot size="sm" /> : null}
        <Chip label={saveLabel} tone={saveTone} size="sm" />
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>{summary.count}</Text>
    </>
  );

  const dock = (
      <View style={landscape ? [styles.rail, { paddingBottom: Math.max(insets.bottom, SPACE.xs), paddingLeft: Math.max(insets.left, SPACE.xs), borderRightColor: colors.borderSubtle, backgroundColor: withAlpha(colors.background, 0.96) }] : [styles.dock, { paddingBottom: Math.max(insets.bottom, SPACE.sm), borderTopColor: colors.borderSubtle, backgroundColor: withAlpha(colors.background, 0.96) }]}>
        <ScrollView horizontal={!landscape} style={styles.flex} showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={landscape} persistentScrollbar={landscape} contentContainerStyle={landscape ? styles.railCol : styles.dockRow}>
          <Pressable
            onPress={() => setToolLocked((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={toolLocked ? 'Unlock tool' : 'Keep selected tool active after drawing'}
            accessibilityState={{ selected: toolLocked }}
            style={[styles.toolBtn, { borderColor: toolLocked ? colors.primary : 'transparent' }]}
          >
            <Ionicons name={toolLocked ? 'lock-closed' : 'lock-open-outline'} size={18} color={toolLocked ? colors.primary : colors.textSecondary} />
          </Pressable>
          <View style={[landscape ? styles.hsep : styles.vsep, { backgroundColor: colors.borderSubtle }]} />
          {TOOLS.map((t) => {
            const active = tool === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => {
                  setTool(t.key);
                  if (t.key !== 'select') setSelected([]);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${t.label} tool`}
                accessibilityState={{ selected: active }}
                style={[styles.toolBtn, { borderColor: active ? colors.primary : 'transparent', backgroundColor: active ? withAlpha(colors.primary, 0.14) : 'transparent' }]}
              >
                <Ionicons name={t.icon} size={20} color={active ? colors.primary : colors.textSecondary} />
              </Pressable>
            );
          })}
        </ScrollView>
        <View style={landscape ? [styles.railFixed, { borderTopColor: colors.borderSubtle }] : [styles.dockFixed, { borderLeftColor: colors.borderSubtle }]}>
          <Pressable onPress={() => setSheet('style')} accessibilityRole="button" accessibilityLabel="Colour and stroke" style={[styles.toolBtn, { borderColor: 'transparent' }]}>
            <View style={[styles.styleDot, { borderColor: renderColor(selectionStyle.strokeColor, dark), backgroundColor: selectionStyle.backgroundColor && selectionStyle.backgroundColor !== 'transparent' ? renderColor(selectionStyle.backgroundColor, dark) : 'transparent' }]} />
          </Pressable>
        </View>
      </View>
  );

  const body = (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <AppHeader variant="nav" title="Whiteboard" leftIcon="chevron-back" leftLabel="Back" onLeftPress={() => navigation?.goBack?.()} rightComponent={headerRight} />

      {!landscape ? <View style={[styles.status, { borderBottomColor: colors.borderSubtle }]}>{statusInner}</View> : null}

      <View style={landscape ? styles.row : styles.flex}>
      {landscape ? dock : null}
      <View style={styles.canvasWrap}>
        <WhiteboardCanvas
          elements={elements}
          selectedIds={selected}
          camera={camera}
          onCamera={setCamera}
          tool={tool}
          style={style}
          dark={dark}
          paper={paper}
          accent={colors.primary}
          handleFill={paper}
          onSelect={setSelected}
          onCommit={commit}
          onTextRequest={requestText}
          onEditText={editText}
          onToolDone={() => !toolLocked && setTool('select')}
          onLayoutSize={setViewport}
        />

        {landscape ? (
          <View style={[styles.statusPill, { backgroundColor: withAlpha(colors.background, 0.9), borderColor: colors.borderSubtle }]}>{statusInner}</View>
        ) : null}

        {/* empty-canvas hint */}
        {!elements.length ? (
          <View pointerEvents="box-none" style={[styles.emptyWrap, landscape && styles.emptyWrapLandscape]}>
            <View style={[styles.emptyCard, landscape && styles.emptyCardCompact, { backgroundColor: withAlpha(colors.background, 0.82), borderColor: withAlpha(colors.primary, 0.25) }]}>
              {landscape ? null : <Ionicons name="brush-outline" size={26} color={colors.primary} />}
              <Text style={[type.h3, { color: colors.text, textAlign: 'center' }]}>Live canvas</Text>
              <Text style={[type.small, { color: colors.textSecondary, textAlign: 'center' }]}>
                {landscape
                  ? 'Draw with the tools on the left, or open a board or template.'
                  : 'Draw with the tools below, open a saved board, or start from a template. Agent drawings appear here live.'}
              </Text>
              <View style={styles.emptyActions}>
                <Button title="Boards" icon="folder-open-outline" variant="outline" size="sm" onPress={() => { setSheet('boards'); loadBoards(); }} accessibilityLabel="Open boards" />
                <Button title="Templates" icon="grid-outline" variant="outline" size="sm" onPress={() => setSheet('templates')} accessibilityLabel="Open templates" />
              </View>
            </View>
          </View>
        ) : null}

        {/* selection action bar */}
        {selected.length ? (
          <View style={[styles.selBar, { backgroundColor: withAlpha(colors.background, 0.9), borderColor: withAlpha(colors.primary, 0.3) }]}>
            <Text style={[type.monoSmall, { color: colors.primary, paddingHorizontal: SPACE.xs }]}>{selected.length}</Text>
            <IconButton icon="color-palette-outline" size="sm" onPress={() => setSheet('style')} accessibilityLabel="Style selection" />
            <IconButton icon="text-outline" size="sm" onPress={() => editText(selected[0])} accessibilityLabel="Edit text or label" />
            <IconButton
              icon="copy-outline"
              size="sm"
              onPress={() => {
                const r = duplicateElements(elements, selected);
                commit(r.elements, r.ids);
              }}
              accessibilityLabel="Duplicate selection"
            />
            <IconButton icon="arrow-up-outline" size="sm" onPress={() => commit(reorder(elements, selected, 'front'), selected)} accessibilityLabel="Bring to front" />
            <IconButton icon="trash-outline" size="sm" tone={colors.error} onPress={() => commit(deleteElements(elements, selected), [])} accessibilityLabel="Delete selection" />
            <IconButton icon="close" size="sm" onPress={() => setSelected([])} accessibilityLabel="Clear selection" />
          </View>
        ) : null}

        {/* zoom + history (bottom-left, like the web) */}
        <View style={[styles.zoomBar, { backgroundColor: withAlpha(colors.background, 0.88), borderColor: colors.border }]}>
          <IconButton icon="remove" size="sm" onPress={() => zoomBy(1 / 1.25)} accessibilityLabel="Zoom out" />
          <Pressable onPress={() => setCamera((c) => zoomAround(c, 1, viewport.width / 2, viewport.height / 2))} accessibilityRole="button" accessibilityLabel="Reset zoom to 100 percent" style={styles.zoomPct}>
            <Text style={[type.monoSmall, { color: colors.text }]}>{Math.round(camera.zoom * 100)}%</Text>
          </Pressable>
          <IconButton icon="add" size="sm" onPress={() => zoomBy(1.25)} accessibilityLabel="Zoom in" />
          <IconButton icon="scan-outline" size="sm" onPress={() => fitTo()} accessibilityLabel="Zoom to fit" />
          <View style={[styles.vsep, { backgroundColor: colors.borderSubtle }]} />
          <IconButton icon="arrow-undo-outline" size="sm" onPress={doUndo} disabled={!canUndo(history)} accessibilityLabel="Undo" />
          <IconButton icon="arrow-redo-outline" size="sm" onPress={doRedo} disabled={!canRedo(history)} accessibilityLabel="Redo" />
        </View>

        {/* canvas architect */}
        <Pressable
          onPress={() => setSheet('architect')}
          accessibilityRole="button"
          accessibilityLabel="Open Canvas Architect"
          style={({ pressed }) => [styles.fab, { borderColor: withAlpha(colors.primary, 0.5), backgroundColor: withAlpha(colors.background, 0.92) }, pressed && { opacity: 0.8 }]}
        >
          <Ionicons name="sparkles-outline" size={22} color={colors.primary} />
          {archBusy ? <View style={[styles.fabDot, { backgroundColor: colors.primary }]} /> : null}
        </Pressable>

        {toast ? (
          <View pointerEvents="none" style={[styles.toast, { backgroundColor: withAlpha(colors.background, 0.94), borderColor: toast.tone === 'danger' ? colors.error : toast.tone === 'warning' ? colors.warning : colors.success }]}>
            <Text style={[type.small, { color: colors.text }]} numberOfLines={2}>
              {toast.msg}
            </Text>
          </View>
        ) : null}
        {!connected ? (
          <View pointerEvents="none" style={[styles.offline, { backgroundColor: withAlpha(colors.background, 0.92), borderColor: colors.error }]}>
            <Ionicons name="cloud-offline-outline" size={14} color={colors.error} />
            <Text style={[type.caption, { color: colors.textSecondary }]}>Gateway offline — edits stay on this phone until it reconnects</Text>
          </View>
        ) : null}
      </View>

      </View>
      {!landscape ? dock : null}

      <BoardsSheet
        visible={sheet === 'boards'}
        onClose={() => setSheet(null)}
        side={side}
        boards={boards}
        loading={boardsLoading}
        error={boardsError}
        currentId={board && board.id}
        onRefresh={loadBoards}
        onOpen={openBoard}
        onNew={newBoard}
        onSaveAs={saveCanvasAs}
        onRename={renameBoard}
        onDelete={deleteBoard}
      />
      <TemplatesSheet visible={sheet === 'templates'} onClose={() => setSheet(null)} side={side} width={side ? 420 : winW} templates={templates} loading={templatesLoading} onLoad={loadTemplate} onNewBoard={newBoardFromTemplate} onRefresh={loadTemplates} />
      <StyleSheetPanel
        visible={sheet === 'style'}
        onClose={() => setSheet(null)}
        side={side}
        dark={dark}
        value={selectionStyle}
        onChange={applyStyle}
        hasSelection={selected.length > 0}
        hasText={selectionHasText}
        onEditText={() => {
          setSheet(null);
          editText(selected[0]);
        }}
        onDuplicate={() => {
          const r = duplicateElements(elements, selected);
          commit(r.elements, r.ids);
        }}
        onFront={() => commit(reorder(elements, selected, 'front'), selected)}
        onBack={() => commit(reorder(elements, selected, 'back'), selected)}
        onDelete={() => {
          commit(deleteElements(elements, selected), []);
          setSheet(null);
        }}
      />
      <ArchitectSheet visible={sheet === 'architect'} onClose={() => setSheet(null)} side={side} messages={archMessages} busy={archBusy} onSend={sendArchitect} />
      <MoreSheet
        visible={sheet === 'more'}
        onClose={() => setSheet(null)}
        side={side}
        dark={dark}
        hasBoard={!!board}
        onTogglePaper={() => setDark((d) => !d)}
        onClear={clearCanvas}
        onCopy={copyScene}
        onPaste={pasteScene}
        onSelectAll={() => {
          setTool('select');
          setSelected(elements.filter((e) => !(e.type === 'text' && e.containerId)).map((e) => e.id));
        }}
        onSaveTemplate={saveAsTemplate}
        onFit={() => fitTo()}
      />
      <PromptModal
        visible={!!prompt}
        {...(prompt || {})}
        busy={busy}
        onCancel={() => {
          // A canvas tap that opens the prompt is followed (on web) by a
          // synthesized click on the new scrim — ignore closes in that window.
          if (prompt && Date.now() - (prompt.openedAt || 0) < 500) return;
          setPrompt(null);
        }}
        onConfirm={(v) => prompt && prompt.onConfirm(v)}
      />
      <ConfirmModal visible={!!confirm} {...(confirm || {})} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => confirm && confirm.onConfirm()} />
    </View>
  );

  return (
    <PluginGate pluginId="whiteboard" title="Whiteboard" navigation={navigation}>
      {body}
    </PluginGate>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, minHeight: 36, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4 },
  boardName: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, flexShrink: 1, minHeight: 32 },
  canvasWrap: { flex: 1, position: 'relative' },
  emptyWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl },
  // Landscape: sit in the band between the status pill and the zoom bar.
  emptyWrapLandscape: { justifyContent: 'flex-start', paddingTop: 52, paddingBottom: 64 },
  emptyCardCompact: { maxWidth: 380, padding: SPACE.md, gap: SPACE.xs },
  emptyCard: { maxWidth: 340, alignItems: 'center', gap: SPACE.sm, padding: SPACE.lg, borderRadius: RADIUS.lg, borderWidth: 1 },
  emptyActions: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.xs },
  selBar: { position: 'absolute', top: SPACE.sm, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', borderRadius: RADIUS.md, borderWidth: 1, paddingHorizontal: SPACE.xs },
  zoomBar: { position: 'absolute', left: SPACE.sm, bottom: SPACE.sm, flexDirection: 'row', alignItems: 'center', borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: SPACE.xs },
  zoomPct: { minWidth: 48, minHeight: HIT.min, alignItems: 'center', justifyContent: 'center' },
  vsep: { width: StyleSheet.hairlineWidth, height: 24, marginHorizontal: SPACE.xs },
  fab: { position: 'absolute', right: SPACE.md, bottom: SPACE.sm, width: 52, height: 52, borderRadius: RADIUS.md, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  fabDot: { position: 'absolute', top: 8, right: 8, width: 8, height: 8, borderRadius: 4 },
  toast: { position: 'absolute', top: 64, alignSelf: 'center', maxWidth: '86%', borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
  offline: { position: 'absolute', top: SPACE.sm, left: SPACE.sm, right: SPACE.sm, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, borderWidth: 1, borderRadius: RADIUS.sm, padding: SPACE.sm },
  dock: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.xs },
  row: { flex: 1, flexDirection: 'row' },
  rail: { borderRightWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.xs, paddingRight: SPACE.xs },
  railCol: { alignItems: 'center', gap: 2, paddingVertical: SPACE.xs },
  railFixed: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.xs, alignItems: 'center' },
  hsep: { height: StyleSheet.hairlineWidth, width: 24, marginVertical: SPACE.xs },
  statusPill: { position: 'absolute', top: SPACE.sm, right: SPACE.sm, maxWidth: '62%', flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, paddingHorizontal: SPACE.sm, minHeight: 36 },
  dockFixed: { borderLeftWidth: StyleSheet.hairlineWidth, paddingHorizontal: SPACE.xs },
  dockRow: { alignItems: 'center', paddingHorizontal: SPACE.sm, gap: 2 },
  toolBtn: { width: HIT.min, height: HIT.min, borderRadius: RADIUS.sm, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  styleDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 3 },
});

export default WhiteboardScreen;
