/**
 * PanelPicker — web "Add a panel" gallery (renderAddPanelMenu): search,
 * category chips (All · Ops · Agents · Data · Media · Voice · Work) and
 * grouped cards. Entries owned by a plugin that is off are hidden, like the
 * web hides the Canvas card without the whiteboard tab.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet, Chip, Field, SPACE, RADIUS, useUIKit } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { usePluginAvailability } from '../../components/PluginGate';
import { PANEL_CATALOG, PANEL_CATEGORIES, filterCatalog, groupCatalog } from './grid-model';

export function PanelPicker({ visible, onClose, onAdd }) {
  const { colors, type } = useUIKit();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('');
  const agency = usePluginAvailability('business-agency');
  const board = usePluginAvailability('whiteboard');
  const content = usePluginAvailability('content-studio');
  const offPlugins = useMemo(() => {
    const s = new Set();
    if (agency === 'off' || agency === 'missing') s.add('business-agency');
    if (board === 'off' || board === 'missing') s.add('whiteboard');
    if (content === 'off' || content === 'missing') s.add('content-studio');
    return s;
  }, [agency, board, content]);

  const catalog = useMemo(() => PANEL_CATALOG.filter((e) => !e.plugin || !offPlugins.has(e.plugin)), [offPlugins]);
  const groups = useMemo(() => groupCatalog(filterCatalog(catalog, query, cat)), [catalog, query, cat]);
  // 2 cards a row on a phone, more when there is room (landscape / tablet).
  const cols = width >= 1000 ? 5 : width >= 700 ? 4 : 2;
  const cardW = `${Math.floor(100 / cols) - 2}%`;

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Add a panel" subtitle={`${catalog.length} panel types`} maxHeightRatio={0.9}>
      <Field value={query} onChangeText={setQuery} placeholder="Search panels" icon="search" autoCorrect={false} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip label="All" selected={cat === ''} onPress={() => setCat('')} />
        {PANEL_CATEGORIES.map((c) => <Chip key={c} label={c} selected={cat === c} onPress={() => setCat(c)} />)}
      </ScrollView>
      {groups.length === 0 ? (
        <Text style={[type.small, { color: colors.textMuted, textAlign: 'center', padding: SPACE.lg }]}>{`No panels match "${query}".`}</Text>
      ) : groups.map((g) => (
        <View key={g.cat}>
          <Text style={[type.label, styles.groupLabel, { color: colors.textMuted }]}>{g.cat}</Text>
          <View style={styles.grid}>
            {g.items.map((e) => (
              <Pressable
                key={e.id}
                onPress={() => onAdd(e)}
                style={({ pressed }) => [styles.card, { width: cardW, borderColor: withAlpha(colors.primary, pressed ? 0.5 : 0.18), backgroundColor: withAlpha(colors.text, pressed ? 0.08 : 0.04) }]}
                accessibilityRole="button"
                accessibilityLabel={`Add ${e.title} panel`}
                accessibilityHint={e.description}
              >
                <View style={[styles.icon, { backgroundColor: withAlpha(colors.primary, 0.1), borderColor: withAlpha(colors.primary, 0.24) }]}>
                  <Ionicons name={e.icon} size={18} color={colors.primary} />
                </View>
                <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>{e.title}</Text>
                <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>{e.description}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  chips: { gap: SPACE.sm, paddingVertical: SPACE.sm },
  groupLabel: { marginTop: SPACE.md, marginBottom: SPACE.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  card: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs, minHeight: 112 },
  icon: { width: 34, height: 34, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
