// GridScreen — native port of the web `/grid` multi-panel workspace
// (ui/src/ui/views/masonry-grid.ts + controllers/masonry-grid.ts).
//
// Every panel body is NATIVE (screens/grid/panels/*): chat sessions, group
// chat + workflow builder, kanban / projects / tasks, activity, credits, GPU,
// database, chart, knowledge graph, terminal (the app's xterm renderer),
// agency ops, and launch cards for page-sized tiles. No WebView panels.
//
// Two layouts (segmented toggle, persisted):
//   Stack   phone-first: panels stacked full-width (2 columns in landscape),
//           reorder / resize height / collapse / full screen from each header
//   Canvas  the web free canvas: drag panels by the title bar, resize from
//           the corner, pinch / pan / zoom the canvas, tile, maximize
// Workspaces 1-5 mirror the web canvases. Layout persistence matches the web:
// the web keeps its layout in localStorage (no gateway layout RPC), so the
// phone keeps the same-shaped layout in AsyncStorage (grid/grid-model.js).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal as RNModal,
  PanResponder,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { AppHeader, BottomSheet, Button, EmptyState, IconButton, ListRow, SegmentedControl, Tabs, SPACE, RADIUS, useUIKit } from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import { ALL_ORIENTATIONS } from '../ui-kit/Sheet';
import { useRotationWhileFocused } from '../infini/orientation';
import {
  LEGACY_STORAGE_KEY, MIN_PANEL_H, MIN_PANEL_W, PANEL_CATALOG, STORAGE_KEY,
  activeCanvas, addPanel, clamp, canvasTabs, clearCanvas, defaultStackHeight, emptyState, focusPanel, migrateLegacy,
  movePanel, panelIcon, patchPanel, removePanel, resizeStackPanel, sanitizeState, setMode, setView, switchToCanvasSlot,
  tileCanvas, toggleMaximize,
} from './grid/grid-model';
import { PanelBody } from './grid/PanelBody';
import { PanelPicker } from './grid/PanelPicker';

const STARTER = ['native:session', 'native:activity', 'native:kanban'];

function PanelHeader({ panel, onRefresh, onFull, onMore, onMax, onClose, onToggle, dragHandlers, compact }) {
  const { colors, type } = useUIKit();
  return (
    <View style={[styles.pHead, { borderBottomColor: withAlpha(colors.primary, 0.16), backgroundColor: withAlpha(colors.text, 0.035) }]}>
      <View style={styles.pTitleWrap} {...(dragHandlers || {})}>
        <Ionicons name={panelIcon(panel)} size={15} color={colors.primary} />
        <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{panel.title}</Text>
      </View>
      <IconButton icon="refresh" size="sm" tone={colors.textMuted} onPress={onRefresh} accessibilityLabel={`Refresh ${panel.title}`} />
      {onFull ? <IconButton icon="expand-outline" size="sm" tone={colors.textMuted} onPress={onFull} accessibilityLabel={`Full screen ${panel.title}`} /> : null}
      {onToggle && !compact ? <IconButton icon={panel.minimized ? 'chevron-down' : 'chevron-up'} size="sm" tone={colors.textMuted} onPress={onToggle} accessibilityLabel={panel.minimized ? 'Expand panel' : 'Collapse panel'} /> : null}
      {onMax ? <IconButton icon="scan-outline" size="sm" tone={colors.textMuted} onPress={onMax} accessibilityLabel={`Maximize ${panel.title}`} /> : null}
      {onMore ? <IconButton icon="ellipsis-horizontal" size="sm" tone={colors.textMuted} onPress={onMore} accessibilityLabel={`${panel.title} options`} /> : null}
      {onClose ? <IconButton icon="close" size="sm" tone={colors.textMuted} onPress={onClose} accessibilityLabel={`Close ${panel.title}`} /> : null}
    </View>
  );
}

// ── Canvas panel: drag by title bar, resize by SE handle ─────────────────────
function CanvasPanel({ panel, active, scaleRef, gateway, navigation, refreshSignal, onCommit, onFocus, onPatch, onRemove, onMaximize, onRefresh, onFull }) {
  const { colors } = useUIKit();
  const geom = useRef({ x: panel.x, y: panel.y, w: panel.width, h: panel.height });
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  useEffect(() => {
    geom.current = { x: panel.x, y: panel.y, w: panel.width, h: panel.height };
    rerender();
  }, [panel.x, panel.y, panel.width, panel.height]);
  const start = useRef(geom.current);
  const cbs = useRef({});
  cbs.current = { onCommit, onFocus };
  const commit = () => cbs.current.onCommit(panel.id, { x: geom.current.x, y: geom.current.y, width: geom.current.w, height: geom.current.h });

  const drag = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 4,
    onPanResponderGrant: () => { cbs.current.onFocus(panel.id); start.current = { ...geom.current }; },
    onPanResponderMove: (_e, g) => {
      const s = scaleRef.current || 1;
      geom.current.x = start.current.x + g.dx / s;
      geom.current.y = start.current.y + g.dy / s;
      rerender();
    },
    onPanResponderRelease: commit,
    onPanResponderTerminate: commit,
  })).current;

  const resize = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { cbs.current.onFocus(panel.id); start.current = { ...geom.current }; },
    onPanResponderMove: (_e, g) => {
      const s = scaleRef.current || 1;
      geom.current.w = Math.max(MIN_PANEL_W, start.current.w + g.dx / s);
      geom.current.h = Math.max(MIN_PANEL_H, start.current.h + g.dy / s);
      rerender();
    },
    onPanResponderRelease: commit,
    onPanResponderTerminate: commit,
  })).current;

  const { x, y, w, h } = geom.current;
  return (
    <View
      style={[styles.canvasPanel, {
        left: x, top: y, width: w, height: h, zIndex: panel.zIndex,
        borderColor: withAlpha(colors.primary, active ? 0.55 : 0.24),
        backgroundColor: withAlpha(colors.background, 0.92),
      }]}
      onTouchStart={() => !active && onFocus(panel.id)}
    >
      <PanelHeader
        panel={panel}
        compact
        dragHandlers={drag.panHandlers}
        onRefresh={() => onRefresh(panel.id)}
        onFull={() => onFull(panel.id)}
        onMax={() => onMaximize(panel.id)}
        onClose={() => onRemove(panel.id)}
      />
      <View style={styles.flex}>
        <PanelBody panel={panel} gateway={gateway} navigation={navigation} onPatch={onPatch} refreshSignal={refreshSignal} />
      </View>
      <View style={[styles.resize, { backgroundColor: withAlpha(colors.primary, 0.12) }]} {...resize.panHandlers} accessibilityLabel="Resize panel">
        <Ionicons name="resize-outline" size={14} color={colors.primary} />
      </View>
    </View>
  );
}

function usePatcher(update, id) {
  return useCallback((p) => update((s) => patchPanel(s, id, p)), [update, id]);
}

function StackItem({ panel, width, gateway, navigation, refreshSignal, update, onRefresh, onFull, onMore }) {
  const { colors } = useUIKit();
  const onPatch = usePatcher(update, panel.id);
  const h = panel.stackHeight ?? defaultStackHeight(panel.type);
  return (
    <View style={[styles.stackPanel, { width, borderColor: withAlpha(colors.primary, 0.24), backgroundColor: withAlpha(colors.background, 0.78) }]}>
      <PanelHeader
        panel={panel}
        onRefresh={() => onRefresh(panel.id)}
        onFull={() => onFull(panel.id)}
        onToggle={() => update((s) => patchPanel(s, panel.id, { minimized: !panel.minimized }))}
        onMore={() => onMore(panel.id)}
      />
      {panel.minimized ? null : (
        <View style={{ height: h }}>
          <PanelBody panel={panel} gateway={gateway} navigation={navigation} onPatch={onPatch} refreshSignal={refreshSignal} />
        </View>
      )}
    </View>
  );
}

function CanvasItem(props) {
  const onPatch = usePatcher(props.update, props.panel.id);
  return <CanvasPanel {...props} onPatch={onPatch} />;
}

export default function GridScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  useRotationWhileFocused();
  const [state, setState] = useState(emptyState);
  const [loaded, setLoaded] = useState(false);
  const [picker, setPicker] = useState(false);
  const [moreId, setMoreId] = useState(null);
  const [fullId, setFullId] = useState(null);
  const [signals, setSignals] = useState({});
  const [viewport, setViewport] = useState({ w: winW, h: winH });

  const update = useCallback((fn) => setState((s) => fn(s)), []);

  // ── load / persist ─────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) setState(sanitizeState(JSON.parse(raw)));
        else {
          const legacy = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
          const migrated = legacy ? migrateLegacy(JSON.parse(legacy)) : null;
          if (migrated) setState(migrated);
        }
      } catch { /* fresh layout */ }
      setLoaded(true);
    })();
  }, []);
  useEffect(() => {
    if (!loaded) return undefined;
    const id = setTimeout(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {}), 300);
    return () => clearTimeout(id);
  }, [state, loaded]);

  const canvas = activeCanvas(state);
  const panels = canvas.panels;
  const refresh = useCallback((id) => setSignals((m) => ({ ...m, [id]: (m[id] || 0) + 1 })), []);
  const add = useCallback((entry) => {
    update((s) => addPanel(s, entry).state);
    setPicker(false);
  }, [update]);
  const addStarter = () => update((s) => STARTER.reduce((acc, id) => addPanel(acc, PANEL_CATALOG.find((e) => e.id === id)).state, s));

  // ── canvas transform ───────────────────────────────────────────────────────
  const tf = state.view;
  const scaleRef = useRef(tf.scale);
  scaleRef.current = tf.scale;
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const gesture = useRef(null);
  const bg = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 3,
    onPanResponderGrant: (e) => { gesture.current = { tf: { ...tfRef.current }, dist: pinchDist(e) }; },
    onPanResponderMove: (e, g) => {
      const st = gesture.current;
      if (!st) return;
      if (e.nativeEvent.touches?.length >= 2 && st.dist) {
        const next = clamp(st.tf.scale * (pinchDist(e) / st.dist), 0.35, 2.5);
        setState((s) => setView(s, { ...st.tf, scale: next }));
      } else {
        setState((s) => setView(s, { ...st.tf, tx: st.tf.tx + g.dx, ty: st.tf.ty + g.dy }));
      }
    },
    onPanResponderRelease: () => { gesture.current = null; },
  })).current;
  const zoomBy = (f) => update((s) => setView(s, { ...s.view, scale: s.view.scale * f }));

  const columns = winW >= 700 ? 2 : 1;
  const stackW = columns === 2 ? (winW - insets.left - insets.right - SPACE.md * 3) / 2 : winW - insets.left - insets.right - SPACE.md * 2;
  const morePanel = panels.find((p) => p.id === moreId);
  const fullPanel = panels.find((p) => p.id === fullId);
  const fullPatch = usePatcher(update, fullId);
  const tabs = canvasTabs(state);

  const onTab = (key) => {
    if (key === '__add__') update((s) => switchToCanvasSlot(s, s.canvases.length));
    else update((s) => ({ ...s, activeCanvasId: key }));
  };

  const headerRight = (
    <View style={styles.headRight}>
      {panels.length ? <IconButton icon="trash-outline" size="sm" tone={colors.textMuted} onPress={() => update(clearCanvas)} accessibilityLabel="Clear this workspace" /> : null}
      <IconButton icon="add" variant="solid" size="sm" onPress={() => setPicker(true)} accessibilityLabel="Add a panel" />
    </View>
  );

  let content;
  if (!loaded) content = null;
  else if (panels.length === 0) {
    content = (
      <View style={styles.emptyWrap}>
        <EmptyState
          icon="grid-outline"
          title="Multi-panel grid"
          message="Put chats, boards, terminals and live feeds side by side. Stack mode lists panels for the phone; Canvas mode is the free canvas from the web."
          actionLabel="Add a panel"
          onAction={() => setPicker(true)}
          secondaryLabel="Starter layout"
          onSecondary={addStarter}
        />
      </View>
    );
  } else if (state.mode === 'stack') {
    content = (
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.stack, { paddingLeft: insets.left + SPACE.md, paddingRight: insets.right + SPACE.md, paddingBottom: insets.bottom + SPACE.xl }]}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {panels.map((p) => (
          <StackItem key={p.id} panel={p} width={stackW} gateway={gateway} navigation={navigation} refreshSignal={signals[p.id] || 0} update={update} onRefresh={refresh} onFull={setFullId} onMore={setMoreId} />
        ))}
        <Pressable onPress={() => setPicker(true)} style={[styles.addTile, { width: stackW, borderColor: withAlpha(colors.primary, 0.3) }]} accessibilityRole="button" accessibilityLabel="Add a panel">
          <Ionicons name="add" size={18} color={colors.primary} />
          <Text style={[type.smallStrong, { color: colors.primary }]}>Add panel</Text>
        </Pressable>
      </ScrollView>
    );
  } else {
    content = (
      <View style={styles.canvasClip} onLayout={(e) => setViewport({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        <View style={StyleSheet.absoluteFill} {...bg.panHandlers} />
        <View style={[StyleSheet.absoluteFill, { transform: [{ translateX: tf.tx }, { translateY: tf.ty }, { scale: tf.scale }], transformOrigin: 'top left' }]} pointerEvents="box-none">
          {panels.map((p) => (
            <CanvasItem
              key={p.id}
              panel={p}
              active={canvas.activePanel === p.id}
              scaleRef={scaleRef}
              gateway={gateway}
              navigation={navigation}
              refreshSignal={signals[p.id] || 0}
              update={update}
              onCommit={(id, g) => update((s) => patchPanel(s, id, g))}
              onFocus={(id) => update((s) => focusPanel(s, id))}
              onRemove={(id) => update((s) => removePanel(s, id))}
              onMaximize={(id) => update((s) => toggleMaximize(s, id, { ...s.view, ...viewport }))}
              onRefresh={refresh}
              onFull={setFullId}
            />
          ))}
        </View>
        <View style={[styles.zoom, { bottom: insets.bottom + SPACE.md, right: insets.right + SPACE.md }]}>
          {[
            { icon: 'add', label: 'Zoom in', fn: () => zoomBy(1.2) },
            { icon: 'remove', label: 'Zoom out', fn: () => zoomBy(0.83) },
            { icon: 'scan-outline', label: 'Reset view', fn: () => update((s) => setView(s, { tx: 0, ty: 0, scale: 1 })) },
            { icon: 'grid-outline', label: 'Tile panels', fn: () => update((s) => setView(tileCanvas(s, viewport.w, viewport.h), { tx: 0, ty: 0, scale: 1 })) },
          ].map((b) => (
            <IconButton key={b.label} icon={b.icon} variant="solid" onPress={b.fn} accessibilityLabel={b.label} style={{ backgroundColor: withAlpha(colors.background, 0.92) }} />
          ))}
        </View>
        <Text style={[type.monoSmall, styles.zoomPct, { color: colors.textMuted, bottom: insets.bottom + SPACE.md, left: insets.left + SPACE.md }]}>{`${Math.round(tf.scale * 100)}%`}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <StatusBar barStyle="light-content" />
      <AppHeader variant="nav" title="Grid" leftIcon="chevron-back" leftLabel="Back" onLeftPress={() => navigation?.goBack?.()} rightComponent={headerRight} />
      <View style={[styles.toolbar, { paddingLeft: insets.left + SPACE.sm, paddingRight: insets.right + SPACE.sm, borderBottomColor: withAlpha(colors.primary, 0.14) }]}>
        <Tabs tabs={tabs} active={state.activeCanvasId} onSelect={onTab} style={styles.flex} />
        <SegmentedControl
          size="sm"
          options={[{ key: 'stack', label: 'Stack', icon: 'albums-outline' }, { key: 'canvas', label: 'Canvas', icon: 'move-outline' }]}
          value={state.mode}
          onChange={(m) => update((s) => setMode(s, m))}
          style={styles.modeSeg}
        />
      </View>
      <View style={styles.flex}>{content}</View>

      <PanelPicker visible={picker} onClose={() => setPicker(false)} onAdd={add} />

      <BottomSheet visible={Boolean(morePanel)} onClose={() => setMoreId(null)} title={morePanel?.title} subtitle="Panel options">
        {morePanel ? (
          <>
            <ListRow icon="expand-outline" title="Full screen" onPress={() => { setFullId(morePanel.id); setMoreId(null); }} />
            <ListRow icon="arrow-up" title="Move up" disabled={panels[0]?.id === morePanel.id} onPress={() => update((s) => movePanel(s, morePanel.id, -1))} />
            <ListRow icon="arrow-down" title="Move down" disabled={panels[panels.length - 1]?.id === morePanel.id} onPress={() => update((s) => movePanel(s, morePanel.id, 1))} />
            <ListRow icon="add-circle-outline" title="Taller" onPress={() => update((s) => resizeStackPanel(s, morePanel.id, 120))} />
            <ListRow icon="remove-circle-outline" title="Shorter" onPress={() => update((s) => resizeStackPanel(s, morePanel.id, -120))} />
            <ListRow icon="trash-outline" iconTone="danger" title="Remove panel" onPress={() => { update((s) => removePanel(s, morePanel.id)); setMoreId(null); }} />
          </>
        ) : null}
      </BottomSheet>

      <RNModal visible={Boolean(fullPanel)} animationType="slide" onRequestClose={() => setFullId(null)} supportedOrientations={ALL_ORIENTATIONS}>
        {fullPanel ? (
          <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
            <PanelHeader panel={fullPanel} onRefresh={() => refresh(fullPanel.id)} onClose={() => setFullId(null)} />
            <View style={styles.flex}>
              <PanelBody panel={fullPanel} gateway={gateway} navigation={{ ...navigation, navigate: (...a) => { setFullId(null); navigation.navigate(...a); } }} onPatch={fullPatch} refreshSignal={signals[fullPanel.id] || 0} />
            </View>
          </View>
        ) : null}
      </RNModal>
    </View>
  );
}

function pinchDist(e) {
  const t = e.nativeEvent.touches;
  if (!t || t.length < 2) return 0;
  return Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  modeSeg: { width: 176 },
  stack: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.md, paddingTop: SPACE.md },
  stackPanel: { borderWidth: 1, borderRadius: RADIUS.lg, overflow: 'hidden' },
  pHead: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingRight: SPACE.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  pTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingLeft: SPACE.md, minHeight: 44 },
  addTile: { minHeight: 56, borderWidth: 1, borderStyle: 'dashed', borderRadius: RADIUS.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.sm },
  emptyWrap: { flex: 1, justifyContent: 'center', padding: SPACE.lg },
  canvasClip: { flex: 1, overflow: 'hidden' },
  canvasPanel: { position: 'absolute', borderWidth: 1, borderRadius: RADIUS.md, overflow: 'hidden' },
  resize: { position: 'absolute', right: 0, bottom: 0, width: 28, height: 28, borderTopLeftRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center' },
  zoom: { position: 'absolute', gap: SPACE.sm },
  zoomPct: { position: 'absolute' },
});
