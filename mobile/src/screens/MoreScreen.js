/**
 * MoreScreen — the full index of every page, grouped like the web sidebar
 * (Home · Chat & Voice · Work · Agents · plugins · Settings), with search.
 *
 * The catalogue comes from src/navigation/screen-registry.js (+ one section
 * per enabled plugin), the same source the Launchpad uses, so the two never
 * drift. Phones get a single column of rows; tablets get a 2–3 column grid.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DOCK_BOTTOM_SPACE } from '../components/FloatingDock';
import { filterScreens, isRoutable, navigateToScreen } from '../navigation/screen-registry';
import { useScreenSections } from '../plugins/plugin-store';
import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../theme/color-utils';
import { FONT_FAMILY } from '../hooks/useFonts';
import { tap } from '../utils/haptics';

function columnsFor(width) {
  if (width >= 1100) return 3;
  if (width >= 700) return 2;
  return 1;
}

export function MoreScreen({ navigation, gateway, notifications }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');

  const allSections = useScreenSections({ includeLaunchpadOnly: false });
  const { sections, flat } = useMemo(() => filterScreens(query, allSections), [query, allSections]);

  const cols = columnsFor(width);
  const pad = 14;
  const gap = 8;
  const usable = width - insets.left - insets.right - pad * 2;
  const itemWidth = cols === 1 ? usable : Math.floor((usable - gap * (cols - 1)) / cols);

  const open = useCallback((item) => {
    tap();
    navigateToScreen(navigation.getParent(), item, {
      gateway,
      notifications,
      switchSession: gateway?.switchSession,
    });
  }, [navigation, gateway, notifications]);

  const s = useMemo(() => makeStyles(colors), [colors]);

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={{ padding: pad, paddingLeft: pad + insets.left, paddingRight: pad + insets.right, paddingBottom: DOCK_BOTTOM_SPACE + insets.bottom + 16 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <View style={s.search}>
        <Ionicons name="search" size={17} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search every page"
          placeholderTextColor={withAlpha(colors.text, 0.38)}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel="Search pages"
          style={s.searchInput}
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </Pressable>
        ) : (
          <Text style={s.count}>{flat.length}</Text>
        )}
      </View>

      {sections.length === 0 ? (
        <View style={s.empty}>
          <Ionicons name="search" size={26} color={colors.textMuted} />
          <Text style={s.emptyTitle}>No pages match “{query.trim()}”</Text>
          <Text style={s.emptyText}>Try a shorter word — search looks at names, descriptions and sections.</Text>
        </View>
      ) : null}

      {sections.map((section) => {
        const m = section;
        return (
          <View key={m?.pluginId ? `plugin:${m.pluginId}` : section.title} style={s.section}>
            <View style={s.sectionHead}>
              {m?.isPluginSection ? (
                <View style={[s.monogram, m.accent ? { borderColor: m.accent } : null]}>
                  <Text style={[s.monogramText, m.accent ? { color: m.accent } : null]}>{m.monogram}</Text>
                </View>
              ) : null}
              <Text style={s.sectionTitle} accessibilityRole="header">{section.title}</Text>
              {m?.isPluginSection ? <Text style={s.badge}>PLUGIN</Text> : null}
            </View>
            <View style={[s.grid, { gap }]}>
              {section.items.map((item) => {
                const routable = isRoutable(item);
                return (
                  <Pressable
                    key={item.key}
                    onPress={() => open(item)}
                    disabled={!routable}
                    accessibilityRole="button"
                    accessibilityLabel={item.title}
                    accessibilityHint={item.desc}
                    style={({ pressed }) => [
                      s.item,
                      { width: itemWidth, opacity: routable ? 1 : 0.4 },
                      pressed && { backgroundColor: withAlpha(colors.text, 0.08) },
                    ]}
                  >
                    {item.highlight ? <View style={s.accent} /> : null}
                    <View style={[s.icon, item.highlight && { backgroundColor: withAlpha(colors.primary, 0.14), borderColor: withAlpha(colors.primary, 0.3) }]}>
                      <Ionicons name={item.icon} size={19} color={item.highlight ? colors.primary : withAlpha(colors.text, 0.72)} />
                    </View>
                    <View style={s.info}>
                      <Text numberOfLines={1} style={s.title}>{item.title}</Text>
                      {item.desc ? <Text numberOfLines={2} style={s.desc}>{item.desc}</Text> : null}
                    </View>
                    <Ionicons
                      name={item.webPath ? 'globe-outline' : 'chevron-forward'}
                      size={item.webPath ? 14 : 15}
                      color={withAlpha(colors.text, 0.28)}
                    />
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: 'transparent' },
    search: {
      flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, paddingHorizontal: 14, marginBottom: 6,
      borderRadius: 14, borderWidth: 1, borderColor: withAlpha(colors.text, 0.1), backgroundColor: 'rgba(14,14,20,0.78)',
    },
    searchInput: { flex: 1, color: colors.text, fontFamily: FONT_FAMILY.regular, fontSize: 15, paddingVertical: 10, outlineStyle: 'none' },
    count: { color: withAlpha(colors.text, 0.35), fontSize: 12, fontVariant: ['tabular-nums'] },
    section: { marginTop: 14 },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginLeft: 4 },
    sectionTitle: { fontFamily: FONT_FAMILY.bold, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.glowStrong || colors.primary },
    monogram: { minWidth: 26, height: 22, paddingHorizontal: 4, borderRadius: 6, borderWidth: 1, borderColor: withAlpha(colors.primary, 0.4), alignItems: 'center', justifyContent: 'center' },
    monogramText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, color: colors.primary },
    badge: { fontSize: 9, fontWeight: '700', letterSpacing: 1, color: withAlpha(colors.text, 0.3) },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    item: {
      flexDirection: 'row', alignItems: 'center', minHeight: 62, paddingVertical: 11, paddingHorizontal: 13, borderRadius: 14, overflow: 'hidden',
      backgroundColor: 'rgba(14,14,20,0.78)', borderWidth: 1, borderColor: withAlpha(colors.text, 0.07),
    },
    accent: { position: 'absolute', left: 0, top: 12, bottom: 12, width: 3, borderRadius: 2, backgroundColor: colors.primary, opacity: 0.75 },
    icon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 12, borderWidth: 1, borderColor: withAlpha(colors.text, 0.07), backgroundColor: withAlpha(colors.text, 0.05) },
    info: { flex: 1, minWidth: 0, marginRight: 6 },
    title: { fontFamily: FONT_FAMILY.semiBold, fontSize: 14, color: withAlpha(colors.text, 0.94), marginBottom: 2 },
    desc: { fontSize: 11.5, lineHeight: 15, color: withAlpha(colors.text, 0.45) },
    empty: { alignItems: 'center', gap: 6, paddingTop: 48, paddingHorizontal: 24 },
    emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 4, textAlign: 'center' },
    emptyText: { color: withAlpha(colors.text, 0.5), fontSize: 13, lineHeight: 18, textAlign: 'center' },
  });
}

export default MoreScreen;
