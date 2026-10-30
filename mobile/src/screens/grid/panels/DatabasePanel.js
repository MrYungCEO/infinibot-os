/**
 * DatabasePanel — web grid Database tile (views/grid-panels/database-panel.ts
 * → renderDatabases). Same db.* RPCs as ui/src/ui/controllers/databases.ts:
 *   db.list → database picker; db.get { id } → properties; db.rows.list { databaseId } → rows.
 * The chosen database persists on the panel as `databaseId`. Rows show the
 * first visible properties; tap a row for every property value.
 */
import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet, ListRow, SPACE, RADIUS, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import { databaseRows, dbRowDetail, dbRowPreview, relTime } from '../grid-data';
import { PanelEmpty, PanelError, PanelLoading, useRpc, withTimeout } from '../panel-kit';

export function DatabasePanel({ panel, gateway, onPatch, refreshSignal }) {
  const { colors, type } = useUIKit();
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(null);
  const list = useRpc(gateway, (sendReq) => withTimeout(sendReq('db.list', {}), 20000, 'db.list'), [], { refreshSignal });
  const dbs = useMemo(() => databaseRows(list.data), [list.data]);
  const dbId = panel.databaseId || dbs[0]?.id || null;
  const db = dbs.find((d) => d.id === dbId);

  const rows = useRpc(gateway, async (sendReq) => {
    if (!dbId) return null;
    const [meta, r] = await Promise.all([
      withTimeout(sendReq('db.get', { id: dbId }), 20000, 'db.get'),
      withTimeout(sendReq('db.rows.list', { databaseId: dbId }), 30000, 'db.rows.list'),
    ]);
    return { properties: meta?.properties || [], rows: r?.rows || [] };
  }, [dbId], { refreshSignal, enabled: Boolean(dbId) });

  const previews = useMemo(() => {
    const q = query.trim().toLowerCase();
    const props = rows.data?.properties || [];
    return (rows.data?.rows || [])
      .map((r) => ({ raw: r, ...dbRowPreview(r, props, 2) }))
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.chips.some((c) => c.value.toLowerCase().includes(q)))
      .slice(0, 300);
  }, [rows.data, query]);

  if (list.loading && !list.data) return <PanelLoading rows={5} />;
  if (list.error && !list.data) return <PanelError message={list.error} onRetry={() => list.reload()} />;
  if (!dbs.length) return <PanelEmpty icon="server-outline" title="No databases" message="Create one on the web Databases page." />;

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Pressable onPress={() => setPicker(true)} style={[styles.select, { borderColor: colors.border, backgroundColor: withAlpha(colors.text, 0.05) }]} accessibilityRole="button" accessibilityLabel="Choose database">
          <Ionicons name="server-outline" size={15} color={colors.primary} />
          <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{db?.name || 'Database'}</Text>
          <Text style={[type.monoSmall, { color: colors.textMuted }]}>{rows.data ? rows.data.rows.length : ''}</Text>
          <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
        </Pressable>
      </View>
      <View style={[styles.search, { borderColor: colors.borderSubtle, backgroundColor: withAlpha(colors.text, 0.05) }]}>
        <Ionicons name="search" size={14} color={colors.textMuted} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Search rows" placeholderTextColor={colors.textMuted} style={[type.small, styles.searchInput, { color: colors.text }]} accessibilityLabel="Search rows" />
      </View>
      {rows.loading && !rows.data ? <PanelLoading rows={5} /> : rows.error && !rows.data ? <PanelError message={rows.error} onRetry={() => rows.reload()} /> : (
        <FlatList
          style={styles.flex}
          data={previews}
          keyExtractor={(r) => r.id}
          nestedScrollEnabled
          ListEmptyComponent={<PanelEmpty icon="document-outline" title={query ? 'No matching rows' : 'No rows yet'} />}
          renderItem={({ item: r }) => (
            <Pressable onPress={() => setSel(r)} style={({ pressed }) => [styles.row, { borderBottomColor: colors.borderSubtle, backgroundColor: pressed ? withAlpha(colors.text, 0.05) : 'transparent' }]} accessibilityRole="button" accessibilityLabel={`Row ${r.title}`}>
              <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>{r.title}</Text>
              <View style={styles.chips}>
                {r.chips.map((c) => (
                  <Text key={c.label} style={[type.caption, { color: colors.textSecondary, flexShrink: 1 }]} numberOfLines={1}>
                    <Text style={{ color: colors.textMuted }}>{`${c.label} `}</Text>{c.value}
                  </Text>
                ))}
              </View>
            </Pressable>
          )}
        />
      )}

      <BottomSheet visible={picker} onClose={() => setPicker(false)} title="Databases">
        {dbs.map((d) => (
          <ListRow key={d.id} dense icon="server-outline" title={d.name} subtitle={d.description} selected={d.id === dbId} onPress={() => { onPatch({ databaseId: d.id }); setPicker(false); setQuery(''); }} accessibilityLabel={`Open ${d.name}`} />
        ))}
      </BottomSheet>
      <BottomSheet visible={Boolean(sel)} onClose={() => setSel(null)} title={sel?.title} subtitle={sel ? `Updated ${relTime(sel.updatedAt)}` : ''}>
        <ScrollView nestedScrollEnabled>
          {sel ? dbRowDetail(sel.raw, rows.data?.properties).map((d) => (
            <View key={d.id} style={[styles.detail, { borderBottomColor: colors.borderSubtle }]}>
              <Text style={[type.label, { color: colors.textMuted }]}>{d.label}</Text>
              <Text style={[type.small, { color: colors.text }]} selectable>{d.value}</Text>
            </View>
          )) : null}
          {sel?.raw?.body ? <Text style={[type.small, { color: colors.textSecondary, marginTop: SPACE.md }]} selectable>{String(sel.raw.body).slice(0, 2000)}</Text> : null}
        </ScrollView>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  bar: { padding: SPACE.sm, paddingBottom: 0 },
  select: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 40, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  search: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, margin: SPACE.sm, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1, minHeight: 40 },
  searchInput: { flex: 1, minHeight: 38 },
  row: { paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48, justifyContent: 'center', gap: 2 },
  chips: { gap: 0 },
  detail: { paddingVertical: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
});
