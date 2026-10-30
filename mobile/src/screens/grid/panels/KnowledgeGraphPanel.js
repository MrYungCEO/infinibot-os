/**
 * KnowledgeGraphPanel — web grid Knowledge Graph tile, drawn natively.
 *
 * Read-only reuse of the native graph stack behind KnowledgeGraphNativeScreen:
 * useKnowledgeGraph (graph.global.snapshot, same prefs) → kg-model
 * buildGraphView (filter → cluster → layout) → a fitted react-native-svg mini
 * map (cluster discs + coloured nodes + biggest cluster titles). Tap the map
 * or "Open" for the full interactive graph.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';

import { Chip, SPACE, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import { useKnowledgeGraph } from '../../../hooks/useKnowledgeGraph';
import { KIND_LABEL, buildGraphView, colorFor, fitCamera, visualKind } from '../../../lib/kg-model';
import { navigateToScreen } from '../../../navigation/screen-registry';
import { PanelEmpty, PanelError, PanelLoading, PanelOpen } from '../panel-kit';

export function KnowledgeGraphPanel({ gateway, navigation, refreshSignal }) {
  const { colors, type } = useUIKit();
  const kg = useKnowledgeGraph(gateway);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const lastSignal = React.useRef(refreshSignal);
  React.useEffect(() => {
    if (refreshSignal !== lastSignal.current) { lastSignal.current = refreshSignal; kg.load({ refresh: true }); }
  }, [refreshSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => {
    if (!kg.snapshot || !size.w) return null;
    return buildGraphView(kg.snapshot, { kinds: kg.prefs.kinds, statuses: kg.prefs.statuses, mode: kg.prefs.mode, expanded: new Set(), aspect: size.w / Math.max(1, size.h) });
  }, [kg.snapshot, kg.prefs.kinds, kg.prefs.statuses, kg.prefs.mode, size.w, size.h]);

  const drawing = useMemo(() => {
    if (!view || !size.w) return null;
    const cam = fitCamera(view.bounds, size.w, size.h, 14);
    const S = (x, y) => [cam.k * x + cam.x, cam.k * y + cam.y];
    const pos = new Map();
    const dots = new Map();
    for (const it of view.items) {
      const [sx, sy] = S(it.x, it.y);
      pos.set(it.id, [sx, sy]);
      const col = it.superKind ? colors.primary : colorFor(it.node);
      const r = Math.max(1.4, Math.min(6, it.r * cam.k));
      dots.set(col, (dots.get(col) || '') + `M${(sx - r).toFixed(1)} ${sy.toFixed(1)}a${r.toFixed(1)} ${r.toFixed(1)} 0 1 0 ${(2 * r).toFixed(1)} 0a${r.toFixed(1)} ${r.toFixed(1)} 0 1 0 ${(-2 * r).toFixed(1)} 0`);
    }
    let edges = '';
    let n = 0;
    for (const e of view.edges) {
      if (n > 1500) break;
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      edges += `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
      n++;
    }
    const groups = view.groups.map((g) => {
      const [sx, sy] = S(g.x, g.y);
      return { key: g.key, sx, sy, R: g.R * cam.k, title: g.title, size: g.size };
    });
    const titled = [...groups].sort((a, b) => b.R - a.R).slice(0, 5).filter((g) => g.R > 22);
    return { dots, edges, groups, titled };
  }, [view, size, colors.primary]);

  const kindCounts = useMemo(() => {
    const m = new Map();
    for (const it of view?.items || []) {
      const k = it.superKind ? it.kind : visualKind(it.node);
      m.set(k, (m.get(k) || 0) + (it.superKind ? it.count || 1 : 1));
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [view]);

  const open = () => navigateToScreen(navigation, { tab: 'Knowledge', params: { screen: 'KnowledgeGraph' } }, { gateway });

  let body;
  if (kg.error && !kg.snapshot) body = <PanelError message={kg.error} onRetry={() => kg.load({ refresh: true })} />;
  else if (!kg.snapshot) body = <PanelLoading rows={4} />;
  else if (view && view.items.length === 0) body = <PanelEmpty icon="share-social-outline" title="Empty graph" message="No nodes match the graph's current layers." />;
  else {
    body = drawing ? (
      <Svg width={size.w} height={size.h}>
        <Path d={drawing.edges} stroke={withAlpha(colors.primary, 0.14)} strokeWidth={0.6} fill="none" />
        {drawing.groups.map((g) => (
          <Circle key={g.key} cx={g.sx} cy={g.sy} r={g.R} fill={withAlpha(colors.primary, 0.03)} stroke={withAlpha(colors.primary, 0.18)} strokeWidth={0.8} />
        ))}
        <G>
          {[...drawing.dots.entries()].map(([col, d]) => <Path key={col} d={d} fill={col} />)}
        </G>
        {drawing.titled.map((g) => (
          <SvgText key={`t-${g.key}`} x={g.sx} y={Math.max(14, g.sy - g.R + 14)} fill={colors.textSecondary} fontSize={12} fontWeight="600" textAnchor="middle">
            {`${String(g.title || '').slice(0, 18).toUpperCase()} ${g.size}`}
          </SvgText>
        ))}
      </Svg>
    ) : null;
  }

  return (
    <View style={styles.root}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} nestedScrollEnabled style={styles.chipBar}>
        <Text style={[type.monoSmall, { color: colors.textMuted, alignSelf: 'center' }]}>{view ? `${view.nodeCount} nodes` : ''}</Text>
        {kindCounts.map(([k, c]) => <Chip key={k} size="sm" label={`${KIND_LABEL[k] || k} ${c}`} />)}
      </ScrollView>
      <Pressable style={styles.map} onPress={open} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })} accessibilityRole="button" accessibilityLabel="Open the knowledge graph">
        {body}
      </Pressable>
      <PanelOpen label="Knowledge Graph" onPress={open} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  chipBar: { flexGrow: 0 },
  chips: { gap: SPACE.xs, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, alignItems: 'center' },
  map: { flex: 1, overflow: 'hidden' },
});
