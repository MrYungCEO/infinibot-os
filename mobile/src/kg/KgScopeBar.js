/**
 * Project scope bar — the web graph's `.kg-scope` strip (knowledge-graph.ts
 * renderScopeBar) for the native screen: "Project: <name>" chip, "N of M
 * nodes", hop depth 1–4 and "Show all". Plus the sparse-project empty card
 * (renderScopeEmpty). Shown only while the controller is project-scoped.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { KG, kgSheet } from './kg-theme';
import { rgba } from './kg-colors';
import { KgButton } from './KgChrome';

export function KgScopeBar({ c }) {
  const m = c.scopeModel();
  if (!m) return null;
  // Two rows (the web's phone layout): project + count, then depth + Show all.
  return (
    <View style={styles.bar} testID="kg-scope">
      <View style={styles.row}>
        <View style={styles.chip} accessibilityLabel={`Project: ${m.name}`}>
          <Ionicons name="folder-outline" size={13} color={KG.goldText} />
          <Text style={styles.k}>PROJECT</Text>
          <Text style={styles.name} numberOfLines={1}>{m.name}</Text>
        </View>
        <Text style={styles.count} numberOfLines={1} testID="kg-scope-count">{m.countText}</Text>
      </View>
      <View style={styles.row}>
        <View style={styles.hops} accessibilityRole="radiogroup" accessibilityLabel="Hop depth">
          <Text style={[styles.k, { marginHorizontal: 4 }]}>DEPTH</Text>
          {m.hopChoices.map((h) => (
            <Pressable
              key={h}
              onPress={() => c.setScopeHops(h)}
              style={[styles.hop, m.hops === h && styles.hopOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: m.hops === h }}
              testID={`kg-scope-hops-${h}`}
              hitSlop={4}
            >
              <Text style={[styles.hopText, m.hops === h && styles.hopTextOn]}>{h}</Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flex: 1 }} />
        <KgButton icon="git-network-outline" label="Show all" compact onPress={() => c.clearProjectScope()} testID="kg-scope-clear" />
      </View>
    </View>
  );
}

export function KgScopeEmpty({ c }) {
  const m = c.scopeModel();
  if (!m || !m.sparse) return null;
  const deeper = m.found && m.hops < 4;
  return (
    <View style={styles.emptyWrap} pointerEvents="box-none">
      <View style={styles.empty} testID="kg-scope-empty">
        <Ionicons name="git-network-outline" size={26} color={KG.gold} />
        <Text style={styles.emptyT}>{m.found ? `Not much is connected to ${m.name} yet` : 'Project not found in the graph'}</Text>
        <Text style={styles.emptyD}>
          {m.found
            ? 'Link tasks, notes, files, reports or clients to this project and they show up here.'
            : 'It may be archived, in another workspace, or only in the secure lane.'}
        </Text>
        <View style={styles.emptyA}>
          {deeper ? <KgButton label={`Depth ${m.hops + 1}`} compact onPress={() => c.setScopeHops(m.hops + 1)} /> : null}
          <KgButton label="Show all" compact onPress={() => c.clearProjectScope()} />
        </View>
      </View>
    </View>
  );
}

const styles = kgSheet({
  bar: { gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: rgba(KG.gold, 0.18), backgroundColor: rgba(KG.gold, 0.06) },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0,
    paddingLeft: 8, paddingRight: 10, paddingVertical: 4, borderRadius: 999,
    borderWidth: 1, borderColor: rgba(KG.gold, 0.55), backgroundColor: rgba(KG.gold, 0.14),
  },
  k: { fontSize: 8.5, letterSpacing: 2, color: rgba(KG.gold, 0.8) },
  name: { fontSize: 12, fontWeight: '700', color: KG.goldText, flexShrink: 1 },
  count: { marginLeft: 'auto', fontSize: 11, color: KG.dim, fontVariant: ['tabular-nums'] },
  hops: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 2, borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', backgroundColor: 'rgba(0,0,0,0.25)' },
  hop: { minWidth: 30, height: 30, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  hopOn: { backgroundColor: KG.cyan },
  hopText: { fontSize: 11, color: KG.dim },
  hopTextOn: { color: '#061216', fontWeight: '700' },
  emptyWrap: { position: 'absolute', left: 0, right: 0, top: 56, alignItems: 'center' },
  empty: {
    width: 340, maxWidth: '92%', alignItems: 'center', paddingVertical: 18, paddingHorizontal: 20, borderRadius: 14,
    borderWidth: 1, borderColor: rgba(KG.gold, 0.3), backgroundColor: 'rgba(8,8,10,0.86)',
  },
  emptyT: { marginTop: 6, fontSize: 13, fontWeight: '700', color: KG.goldText, textAlign: 'center' },
  emptyD: { marginTop: 6, fontSize: 11.5, lineHeight: 17, color: KG.dim, textAlign: 'center' },
  emptyA: { marginTop: 12, flexDirection: 'row', gap: 8 },
});
