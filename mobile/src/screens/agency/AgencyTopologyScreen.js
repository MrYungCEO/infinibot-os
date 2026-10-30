/**
 * AgencyTopologyScreen — native Agency Topology (web /agency-topology, live at
 * /ceo?view=topology). The org + delivery map of the agency: who it serves,
 * what is being delivered, and who reports to whom.
 *
 * Same data as the web page (agency.ops.agencies / clients / projects /
 * employees / assignments .list, employee.detail per worker for reporting
 * lines, relations.client / relations.project for the detail panel) and the
 * same controls: client scope, Projects / Workforce layers, find-and-highlight,
 * Graph / List views, focus a node's neighbourhood, fit, refresh, legend and
 * "agency at a glance". The map is react-native-svg with pinch / pan / tap
 * (topology/TopologyMap.js); the layout and every derivation live in the pure,
 * tested topology/topology-model.js.
 *
 * Portrait: controls on top, map fills the rest, glance strip at the foot.
 * Landscape: a controls column on the left, the map (bands side by side) right.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import {
  AppHeader,
  BottomSheet,
  Button,
  Chip,
  EmptyState,
  Field,
  IconButton,
  MONO_FAMILY,
  SegmentedControl,
  Skeleton,
  SPACE,
  RADIUS,
  useUIKit,
} from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { PluginGate } from '../../components/PluginGate';
import { useRotationWhileFocused } from '../../infini/orientation';
import { TopologyMap } from './topology/TopologyMap';
import { FailureBanner, TopologyDetail, TopologyLegend, TopologyList, TopologySummary } from './topology/TopologyPanels';
import { useAgencyTopology } from './topology/useAgencyTopology';
import {
  SCOPE_LABELS,
  SCOPE_OPTIONS,
  MAX_GRAPH_NODES,
  buildList,
  buildTopology,
  detailFor,
  focusLabel,
  isFocusable,
  layoutTopology,
  money,
  relativeTime,
  scopeNote,
  searchMatches,
  selectionKey,
  summarize,
  toggleFocus,
} from './topology/topology-model';

function TopologyBody({ navigation, gateway }) {
  useRotationWhileFocused();
  const { colors, type } = useUIKit();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const landscape = winW > winH;

  const topo = useAgencyTopology(gateway);
  const { data, loading, refreshing, error } = topo;

  // View prefs (the web controller's scope / layers / focus / search / mode).
  const [clientScope, setClientScope] = useState('active');
  const [showProjects, setShowProjects] = useState(true);
  const [showWorkforce, setShowWorkforce] = useState(true);
  const [focus, setFocus] = useState(null);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState('graph');
  const [selection, setSelection] = useState(null);
  const [sheet, setSheet] = useState(null); // 'detail' | 'glance' | 'legend' | 'agency'
  const [failuresOpen, setFailuresOpen] = useState(false);
  const [mapSize, setMapSize] = useState({ w: 0, h: 0 });
  const mapRef = useRef(null);
  const [, setTick] = useState(0);

  // "synced 3m ago" stays honest.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const state = useMemo(
    () => ({ ...data, clientScope, showProjects, showWorkforce, focus, search }),
    [data, clientScope, showProjects, showWorkforce, focus, search],
  );
  const now = useMemo(() => Date.now(), [data.lastLoadedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // Search does not change what is drawn — only what is highlighted.
  const model = useMemo(
    () => buildTopology({ ...data, clientScope, showProjects, showWorkforce, focus, search: '' }, now),
    [data, clientScope, showProjects, showWorkforce, focus, now],
  );
  const layout = useMemo(
    () => (mapSize.w ? layoutTopology(model, { width: mapSize.w, height: mapSize.h, stacked: !landscape }) : null),
    [model, mapSize.w, mapSize.h, landscape],
  );
  const signature = useMemo(
    () => `${model.nodes.map((n) => n.id).join(',')}|${model.edges.length}|${landscape ? 'L' : 'P'}`,
    [model, landscape],
  );
  const matches = useMemo(() => (layout ? searchMatches(layout.nodes, search) : null), [layout, search]);
  const summary = useMemo(() => summarize(data, model, now), [data, model, now]);
  const list = useMemo(() => (viewMode === 'list' ? buildList(state, model, now) : null), [viewMode, state, model, now]);
  const detail = useMemo(() => detailFor(state, selection, now), [state, selection, now]);

  // Scope / layer changes clear selection + focus, like the web.
  const resetSelection = () => {
    setSelection(null);
    setFocus(null);
    if (sheet === 'detail') setSheet(null);
  };
  const onScope = (key) => {
    setClientScope(key);
    resetSelection();
  };
  const toggleLayer = (layer) => {
    if (layer === 'projects') setShowProjects((v) => !v);
    else setShowWorkforce((v) => !v);
    resetSelection();
  };

  const select = useCallback(
    (next) => {
      setSelection(next);
      if (next) {
        setSheet('detail');
        topo.loadRelations(next);
      } else {
        setSheet((s) => (s === 'detail' ? null : s));
      }
    },
    [topo.loadRelations], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onMapSelect = useCallback(
    (node) => {
      if (!node) {
        setSelection(null);
        return;
      }
      const index = node.id.indexOf(':');
      select({ kind: node.id.slice(0, index), id: node.id.slice(index + 1) });
    },
    [select],
  );

  const onFocusToggle = () => {
    if (!selection) return;
    setFocus((current) => toggleFocus(current, selection));
    setSheet(null);
  };

  const showOnMap = () => {
    if (!selection) return;
    const key = selectionKey(selection);
    setViewMode('graph');
    setSheet(null);
    setTimeout(() => mapRef.current?.centerOn(key), 250);
  };

  const refresh = () => topo.load({ background: true });
  const selectedKey = selectionKey(selection);
  const synced = data.lastLoadedAt ? `synced ${relativeTime(data.lastLoadedAt)}` : 'not synced';
  const hitCount = matches ? matches.size : null;

  const header = (
    <AppHeader
      variant="nav"
      title="Agency Topology"
      leftIcon="chevron-back"
      leftLabel="Back"
      onLeftPress={() => navigation?.goBack?.()}
      rightComponent={
        <IconButton
          icon={refreshing ? 'sync-outline' : 'refresh-outline'}
          onPress={refresh}
          disabled={refreshing || loading}
          accessibilityLabel={refreshing ? 'Refreshing the agency topology' : 'Refresh the agency topology'}
          testID="topology-refresh"
        />
      }
    />
  );

  // ── Loading / error / no agency ──
  if (loading && !data.lastLoadedAt) {
    return (
      <View style={styles.fill}>
        {header}
        <View style={{ padding: SPACE.lg, gap: SPACE.md }} testID="topology-loading">
          <Skeleton height={18} width="45%" />
          <Skeleton height={44} />
          <Skeleton height={44} width="80%" />
          <Skeleton height={360} radius={RADIUS.lg} />
        </View>
      </View>
    );
  }
  if (error && !data.lastLoadedAt) {
    return (
      <View style={styles.fill}>
        {header}
        <EmptyState tone="danger" icon="cloud-offline-outline" title="Topology unavailable" message={error} actionLabel="Retry" onAction={() => topo.load()} testID="topology-error" />
      </View>
    );
  }
  if (!data.agencyId) {
    return (
      <View style={styles.fill}>
        {header}
        <FailureBanner failures={data.failedRequests} expanded={failuresOpen} onToggle={() => setFailuresOpen((v) => !v)} />
        <EmptyState
          icon="git-network-outline"
          title="No agency to map"
          message="Create an agency in Agency Operations first; every client, project and worker on this map hangs off it."
          actionLabel="Open Agency Operations"
          onAction={() => navigation?.navigate?.('AgencyOperationsModal')}
          secondaryLabel="Refresh"
          onSecondary={refresh}
          testID="topology-no-agency"
        />
      </View>
    );
  }

  // ── Controls ──
  const subtitle = (
    <View style={styles.subRow}>
      <Chip
        label={data.agencyName || 'Agency'}
        icon="business-outline"
        tone="primary"
        size="sm"
        onPress={data.agencies.length > 1 ? () => setSheet('agency') : undefined}
        accessibilityLabel={data.agencies.length > 1 ? `Agency ${data.agencyName}. Tap to switch agency` : `Agency ${data.agencyName}`}
        testID="topology-agency"
      />
      <Text style={[type.caption, { color: colors.textMuted, fontFamily: MONO_FAMILY }]} numberOfLines={1}>
        {refreshing ? 'refreshing…' : synced}
      </Text>
    </View>
  );

  const chips = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow} style={landscape ? null : styles.chipScroll}>
      {SCOPE_OPTIONS.map((o) => (
        <Chip key={o.key} label={o.label} selected={clientScope === o.key} onPress={() => onScope(o.key)} accessibilityLabel={`Client scope: ${SCOPE_LABELS[o.key]}`} testID={`topology-scope-${o.key}`} />
      ))}
      <View style={[styles.vrule, { backgroundColor: colors.borderSubtle }]} />
      <Chip label="Projects" icon={showProjects ? 'checkmark' : 'add'} selected={showProjects} onPress={() => toggleLayer('projects')} accessibilityLabel={`${showProjects ? 'Hide' : 'Show'} the project layer`} testID="topology-layer-projects" />
      <Chip label="Workforce" icon={showWorkforce ? 'checkmark' : 'add'} selected={showWorkforce} onPress={() => toggleLayer('workforce')} accessibilityLabel={`${showWorkforce ? 'Hide' : 'Show'} the workforce layer`} testID="topology-layer-workforce" />
    </ScrollView>
  );

  const landscapeChips = (
    <View style={styles.wrapChips}>
      {SCOPE_OPTIONS.map((o) => (
        <Chip key={o.key} size="sm" label={o.label} selected={clientScope === o.key} onPress={() => onScope(o.key)} accessibilityLabel={`Client scope: ${SCOPE_LABELS[o.key]}`} />
      ))}
      <Chip size="sm" label="Projects" icon={showProjects ? 'checkmark' : 'add'} selected={showProjects} onPress={() => toggleLayer('projects')} accessibilityLabel={`${showProjects ? 'Hide' : 'Show'} the project layer`} />
      <Chip size="sm" label="Workforce" icon={showWorkforce ? 'checkmark' : 'add'} selected={showWorkforce} onPress={() => toggleLayer('workforce')} accessibilityLabel={`${showWorkforce ? 'Hide' : 'Show'} the workforce layer`} />
    </View>
  );

  const searchRow = (
    <View style={styles.searchRow}>
      <Field
        value={search}
        onChangeText={setSearch}
        icon="search-outline"
        placeholder="client, project or person"
        rightIcon={search ? 'close-circle' : undefined}
        onRightPress={() => setSearch('')}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={styles.searchField}
        accessibilityLabel="Highlight nodes whose name matches"
        testID="topology-search"
      />
      {landscape ? null : (
        <SegmentedControl
          size="sm"
          options={[{ key: 'graph', label: 'Graph', icon: 'git-network-outline' }, { key: 'list', label: 'List', icon: 'list-outline' }]}
          value={viewMode}
          onChange={setViewMode}
          style={styles.modeSeg}
          testID="topology-mode"
        />
      )}
    </View>
  );

  const note = (
    <Text style={[type.caption, { color: colors.textSecondary }]} testID="topology-scope-note">
      {scopeNote(state, model)}
      {search.trim() ? (
        <Text style={{ color: hitCount ? colors.primary : colors.warning, fontFamily: MONO_FAMILY }}>{`  ${hitCount ?? 0} match${hitCount === 1 ? '' : 'es'}`}</Text>
      ) : null}
      {model.truncated > 0 ? (
        <Text style={{ color: colors.warning }}>{` ${model.truncated} nodes were dropped at the ${MAX_GRAPH_NODES}-node ceiling; use the list view for the full set.`}</Text>
      ) : null}
    </Text>
  );

  const focusBar = focus ? (
    <View style={[styles.focusBar, { borderColor: withAlpha(colors.primary, 0.4), backgroundColor: withAlpha(colors.primary, 0.08) }]} testID="topology-focus-bar">
      <Ionicons name="locate-outline" size={16} color={colors.primary} />
      <Text style={[type.caption, { color: colors.text, flex: 1 }]} numberOfLines={2}>
        Focused on <Text style={{ color: colors.primary }}>{focusLabel(state)}</Text>, showing only its {focus.kind === 'worker' ? 'reporting line' : 'directly related nodes'}.
      </Text>
      <Button size="sm" variant="outline" title="Show all" onPress={() => setFocus(null)} accessibilityLabel="Show everything" />
    </View>
  ) : null;

  const banners = (
    <>
      {error ? (
        <View style={[styles.focusBar, { borderColor: withAlpha(colors.error, 0.45), backgroundColor: withAlpha(colors.error, 0.08) }]}>
          <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
          <Text style={[type.caption, { color: colors.error, flex: 1 }]}>{error}</Text>
          <Button size="sm" variant="outline" title="Retry" onPress={refresh} accessibilityLabel="Retry loading the topology" />
        </View>
      ) : null}
      <FailureBanner failures={data.failedRequests} expanded={failuresOpen} onToggle={() => setFailuresOpen((v) => !v)} />
    </>
  );

  // ── Map stage ──
  const mapControls = (
    <View style={styles.mapControls}>
      <IconButton icon="add" onPress={() => mapRef.current?.zoomBy(1.35)} accessibilityLabel="Zoom in" testID="topology-zoom-in" />
      <IconButton icon="remove" onPress={() => mapRef.current?.zoomBy(1 / 1.35)} accessibilityLabel="Zoom out" testID="topology-zoom-out" />
      <IconButton icon="scan-outline" onPress={() => mapRef.current?.fit()} accessibilityLabel="Zoom the map to fit every node" testID="topology-fit" />
      <IconButton icon="information-circle-outline" onPress={() => setSheet('legend')} accessibilityLabel="How to read this map" testID="topology-legend-btn" />
      <IconButton icon="stats-chart-outline" onPress={() => setSheet('glance')} accessibilityLabel="Agency at a glance" testID="topology-glance-btn" />
    </View>
  );

  const mapStage = (
    <View style={[styles.stage, { borderColor: withAlpha(colors.primary, 0.22), backgroundColor: withAlpha(colors.background, 0.35) }]} testID="topology-stage">
      <View style={styles.stageHead}>
        <View style={[styles.dot, { backgroundColor: colors.primary }]} />
        <View style={styles.fill} accessible accessibilityLabel={`Topology map, ${layout ? layout.nodes.length : model.nodes.length} nodes. Pinch to zoom, drag to pan, tap a node for details`}>
          <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>Topology map</Text>
          <Text style={[type.caption, { color: colors.textMuted, fontFamily: MONO_FAMILY }]} numberOfLines={1}>
            {`${layout ? layout.nodes.length : model.nodes.length} nodes`}
          </Text>
        </View>
        {mapControls}
      </View>
      <View style={styles.fill}>
        <TopologyMap
          ref={mapRef}
          layout={layout}
          signature={signature}
          selectedId={selectedKey}
          matches={matches}
          dense={model.dense}
          onSelect={onMapSelect}
          onSize={setMapSize}
          testID="topology-map"
        />
      </View>
    </View>
  );

  const glanceStrip = (
    <View style={styles.strip} testID="topology-strip">
      {[
        ['BOOK', `${money(summary.mrrCents)}/mo`, summary.book.tone, 'cash-outline'],
        ['IN FLIGHT', `${summary.inFlight}`, summary.delivery.tone, 'rocket-outline'],
        ['UTILISED', `${Math.round(summary.utilisation)}%`, summary.workforce.tone, 'people-outline'],
      ].map(([label, value, tone, icon]) => (
        <Chip key={label} label={`${label}  ${value}`} icon={icon} tone={tone} onPress={() => setSheet('glance')} accessibilityLabel={`${label} ${value}. Open agency at a glance`} style={styles.stripChip} />
      ))}
    </View>
  );

  const listBody = list ? (
    <TopologyList
      list={list}
      selectedKey={selectedKey}
      totalClients={data.clients.length}
      totalWorkers={data.workers.length}
      scopeLabel={SCOPE_LABELS[clientScope]}
      search={search}
      onSelect={select}
    />
  ) : null;

  let content;
  if (landscape) {
    content = (
      <View style={[styles.row, { paddingLeft: Math.max(insets.left, SPACE.sm), paddingRight: Math.max(insets.right, SPACE.sm) }]}>
        <ScrollView
          style={styles.sideCol}
          contentContainerStyle={{ gap: SPACE.sm, paddingBottom: SPACE.lg }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
        >
          {subtitle}
          <SegmentedControl
            size="sm"
            options={[{ key: 'graph', label: 'Graph', icon: 'git-network-outline' }, { key: 'list', label: 'List', icon: 'list-outline' }]}
            value={viewMode}
            onChange={setViewMode}
            testID="topology-mode"
          />
          {landscapeChips}
          {searchRow}
          {note}
          {focusBar}
          {banners}
        </ScrollView>
        <View style={styles.fill}>
          {viewMode === 'graph' ? (
            mapStage
          ) : (
            <ScrollView contentContainerStyle={{ paddingBottom: SPACE.xl, gap: SPACE.md }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}>
              {listBody}
            </ScrollView>
          )}
        </View>
      </View>
    );
  } else if (viewMode === 'graph') {
    content = (
      <View style={[styles.fill, { paddingHorizontal: SPACE.md, paddingBottom: Math.max(insets.bottom, SPACE.sm) }]}>
        <View style={{ gap: SPACE.sm, paddingTop: SPACE.sm }}>
          {subtitle}
          {chips}
          {searchRow}
          {note}
          {focusBar}
          {banners}
        </View>
        <View style={[styles.fill, { marginTop: SPACE.sm }]}>{mapStage}</View>
        {glanceStrip}
      </View>
    );
  } else {
    content = (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={{ paddingHorizontal: SPACE.md, paddingTop: SPACE.sm, paddingBottom: insets.bottom + SPACE.xl, gap: SPACE.sm }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
        keyboardShouldPersistTaps="handled"
      >
        {subtitle}
        {chips}
        {searchRow}
        {note}
        {focusBar}
        {banners}
        {listBody}
      </ScrollView>
    );
  }

  const sheetSide = landscape;
  return (
    <View style={styles.fill}>
      {header}
      {content}

      <BottomSheet
        visible={sheet === 'detail' && Boolean(selection)}
        onClose={() => setSheet(null)}
        title={detail?.title || 'Details'}
        subtitle={detail?.kind}
        side={sheetSide}
        testID="topology-detail-sheet"
      >
        {selection ? (
          <TopologyDetail
            detail={detail}
            selection={selection}
            focusable={isFocusable(selection)}
            focused={Boolean(focus && focus.kind === selection.kind && focus.id === selection.id)}
            relations={topo.relations}
            onSelect={select}
            onFocus={onFocusToggle}
            onShowOnMap={viewMode === 'list' || landscape ? showOnMap : () => { setSheet(null); setTimeout(() => mapRef.current?.centerOn(selectedKey), 250); }}
            onRetryRelations={() => topo.loadRelations(selection)}
            onOpenOperations={() => { setSheet(null); navigation?.navigate?.('AgencyOperationsModal'); }}
          />
        ) : null}
      </BottomSheet>

      <BottomSheet visible={sheet === 'glance'} onClose={() => setSheet(null)} title="Agency at a glance" subtitle={`${model.nodes.length} nodes drawn`} side={sheetSide} testID="topology-glance-sheet">
        <TopologySummary summary={summary} onSelectClient={(id) => select({ kind: 'client', id })} />
      </BottomSheet>

      <BottomSheet visible={sheet === 'legend'} onClose={() => setSheet(null)} title="How to read this map" subtitle="Shape is what it is, colour is health, size is weight" side={sheetSide} testID="topology-legend-sheet">
        <TopologyLegend weightBasis={model.weightBasis} dense={model.dense} />
      </BottomSheet>

      <BottomSheet visible={sheet === 'agency'} onClose={() => setSheet(null)} title="Switch agency" side={sheetSide} testID="topology-agency-sheet">
        {data.agencies.map((a) => (
          <Chip
            key={a.id}
            label={`${a.name} · ${a.role}`}
            icon={a.id === data.agencyId ? 'checkmark-circle' : 'business-outline'}
            selected={a.id === data.agencyId}
            onPress={() => {
              setSheet(null);
              setSelection(null);
              setFocus(null);
              topo.load({ agencyId: a.id, background: true });
            }}
            accessibilityLabel={`Map agency ${a.name}`}
            style={{ marginBottom: SPACE.sm, alignSelf: 'flex-start' }}
          />
        ))}
      </BottomSheet>
    </View>
  );
}

export function AgencyTopologyScreen({ navigation, route, gateway }) {
  return (
    <PluginGate pluginId="business-agency" title="Agency Topology" navigation={navigation}>
      <TopologyBody navigation={navigation} route={route} gateway={gateway} />
    </PluginGate>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flex: 1, flexDirection: 'row', gap: SPACE.md, paddingTop: SPACE.sm, paddingBottom: SPACE.sm },
  sideCol: { width: 280, flexGrow: 0 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, justifyContent: 'space-between' },
  chipScroll: { flexGrow: 0, marginHorizontal: -SPACE.md },
  chipRow: { gap: SPACE.sm, paddingHorizontal: SPACE.md, alignItems: 'center' },
  wrapChips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  vrule: { width: 1, height: 24, marginHorizontal: SPACE.xs },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  searchField: { flex: 1, minWidth: 0, marginBottom: 0 },
  modeSeg: { width: 150, flexGrow: 0, flexShrink: 0 },
  focusBar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs, minHeight: 44 },
  stage: { flex: 1, borderWidth: 1, borderRadius: RADIUS.lg, overflow: 'hidden' },
  stageHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingLeft: SPACE.md, paddingRight: SPACE.xs, paddingVertical: 2 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  mapControls: { flexDirection: 'row', alignItems: 'center' },
  strip: { flexDirection: 'row', gap: SPACE.xs, paddingTop: SPACE.sm, justifyContent: 'space-between' },
  stripChip: { flexShrink: 1 },
});

export default AgencyTopologyScreen;
