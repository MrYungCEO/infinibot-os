// LibraryScreen — knowledge hub: every document type (notes, ideas, meetings,
// research, plans, specs, …) with type filter chips, create-with-type and
// live stats. Types + the typed list come from documents.types.list /
// documents.library (same as the web Documents page); older gateways fall back
// to notes.list + ideas.list (src/lib/library-model.js).
//
// Pulls stats and recent items directly from the gateway so they stay in
// sync with whatever the desktop UI Notes/Research views see — both sides
// hit the same `notes.list` / `research:status` handlers in
// src/gateway/server-methods.
//
// Visual layer is heavy glassmorphism: every panel is a GlassSurface /
// GlassCard with a single primary tint (gold-on-charcoal at low alpha) so
// the underlying TerminalBackground / FaultyTerminal bleeds through. All
// colours come from the live theme runtime via `useTheme()` — no
// hardcoded hex.
import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  StyleSheet,
  Dimensions,
  Animated,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../theme/ThemeProvider';
import { SPACING, TYPOGRAPHY, FONTS } from '../constants/theme';
import { GlassCard } from '../components/GlassCard';
import { GlassSurface } from '../components/GlassSurface';
import { withAlpha } from '../theme/color-utils';
import { DOCK_BOTTOM_SPACE } from '../components/FloatingDock';
import {
  BUILTIN_TYPES,
  creatableTypes,
  fallbackLibrary,
  filterLibrary,
  ionIconFor,
  newTitleFor,
  routeForItem,
  typeById,
  typeChips,
} from '../lib/library-model';

function fmtRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function LibraryScreen({ navigation, gateway }) {
  const { colors } = useTheme();
  const { sendReq, status } = gateway || {};
  const isConnected = status === 'connected';

  const [notes, setNotes] = useState([]);
  const [research, setResearch] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  // null until known (gateways before the Ideas restart don't serve ideas.list).
  const [ideaCount, setIdeaCount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [types, setTypes] = useState(BUILTIN_TYPES);
  const [lib, setLib] = useState(null);
  const [typeFilter, setTypeFilter] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(null);
  const [fadeAnim] = useState(new Animated.Value(0));

  const { width } = Dimensions.get('window');
  const isTablet = width >= 768;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 280, useNativeDriver: true }).start();
  }, []);

  // Each collection loads on its own so one slow or failing RPC never blanks
  // the other two. Research is the Research Intelligence feed (`research:status`
  // -> { articles, topics, stats }); there is no `research.list` handler.
  const loadAll = useCallback(async () => {
    if (!isConnected || !sendReq) return;
    setLoading(true);
    setError(null);
    const failed = [];
    const run = (label, method, apply) =>
      sendReq(method, {})
        .then((res) => apply(res))
        .catch(() => {
          failed.push(label);
        });
    await Promise.all([
      run('notes', 'notes.list', (res) => {
        setNotes(Array.isArray(res?.notes) ? res.notes : []);
        setLoading(false);
      }),
      run('research', 'research:status', (res) => {
        setResearch(Array.isArray(res?.articles) ? res.articles : []);
      }),
      run('workflows', 'workflows.list', (res) => {
        setWorkflows(Array.isArray(res?.workflows) ? res.workflows : []);
      }),
    ]);
    // Typed library (documents + ideas + reports + research). Older gateways
    // without documents.library: notes typed by category + ideas.list.
    let ideas = [];
    try {
      const res = await sendReq('ideas.list', { limit: 1000 });
      ideas = Array.isArray(res?.ideas) ? res.ideas : [];
      setIdeaCount(Object.values(res?.counts || {}).reduce((a, b) => a + (b || 0), 0));
    } catch {
      setIdeaCount(null);
    }
    try {
      const res = await sendReq('documents.library', { limit: 3000 });
      setLib({ items: res?.items || [], total: res?.total || 0, counts: res?.counts || { all: 0, byType: {} } });
      if (Array.isArray(res?.types) && res.types.length) setTypes(res.types);
    } catch {
      try {
        const res = await sendReq('notes.list', {});
        setLib(fallbackLibrary(Array.isArray(res?.notes) ? res.notes : [], ideas));
      } catch {
        setLib(fallbackLibrary([], ideas));
      }
    }
    if (failed.length === 3) {
      setError('Could not reach the library service');
    } else if (failed.length > 0) {
      setError(`Could not load ${failed.join(' & ')}`);
    }
    setLoading(false);
  }, [sendReq, isConnected]);

  useEffect(() => {
    if (isConnected) loadAll();
  }, [isConnected, loadAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const chips = useMemo(() => typeChips(types, lib?.counts?.byType, lib?.counts?.all), [types, lib]);
  const libItems = useMemo(() => filterLibrary(lib?.items || [], typeFilter, search), [lib, typeFilter, search]);
  const activeType = typeFilter ? typeById(types, typeFilter) : null;

  const openItem = useCallback(
    (it) => {
      const [screen, params] = routeForItem(it);
      navigation.navigate(screen, params);
    },
    [navigation],
  );

  // Create-with-type: ideas → ideas.create (Ideas store); everything else a typed document.
  const createOfType = useCallback(
    async (t) => {
      if (!sendReq) return;
      setCreating(t.id);
      try {
        if (t.backing === 'ideas') {
          const res = await sendReq('ideas.create', { title: newTitleFor(t), source: 'mobile' });
          setPickerOpen(false);
          await loadAll();
          if (res?.idea?.id) navigation.navigate('Ideas', { ideaId: res.idea.id });
          return;
        }
        const res = await sendReq('documents.create', { kind: 'doc', title: newTitleFor(t), type: t.id });
        setPickerOpen(false);
        await loadAll();
        if (res?.node?.id) navigation.navigate('Notes', { docId: res.node.id });
      } catch (err) {
        setError(err?.message || String(err));
      } finally {
        setCreating(null);
      }
    },
    [sendReq, navigation, loadAll],
  );


  const stats = [
    { label: 'Documents', value: lib ? lib.counts?.all ?? lib.total : notes.length, icon: 'documents' },
    { label: 'Ideas', value: lib?.counts?.byType?.idea ?? ideaCount ?? 0, icon: 'bulb' },
    { label: 'Research', value: (lib?.counts?.byType?.research ?? 0) + research.length, icon: 'book' },
  ];

  const features = [
    {
      key: 'graph',
      title: 'Knowledge Graph',
      desc: 'Projects, notes, research and agents as one map',
      icon: 'git-network',
      screen: 'KnowledgeGraph',
      count: null,
    },
    {
      key: 'notes',
      title: 'Notes',
      desc: 'Quick capture, markdown, tags',
      icon: 'document-text',
      screen: 'Notes',
      count: notes.length,
    },
    {
      key: 'ideas',
      title: 'Ideas',
      desc: 'Captured ideas — explore, park, promote',
      icon: 'bulb',
      screen: 'Ideas',
      count: ideaCount,
    },
    {
      key: 'research',
      title: 'Research',
      desc: 'Articles from your research topics',
      icon: 'book',
      screen: 'Research',
      count: research.length,
    },
    {
      key: 'workflows',
      title: 'Workflows',
      desc: 'Markdown playbooks an agent runs',
      icon: 'layers',
      screen: 'Workflows',
      count: workflows.length,
    },
    {
      key: 'reports',
      title: 'Reports',
      desc: 'Every PDF and document, categorised, with its markdown copy',
      icon: 'reader',
      screen: 'ReportsModal',
      count: null,
    },
  ];

  const accent = colors.primary;
  const s = makeStyles(colors, accent);

  if (!isConnected) {
    return (
      <View style={[s.centered, { backgroundColor: 'transparent' }]}>
        <Ionicons name="cloud-offline-outline" size={36} color={colors.textMuted} />
        <Text style={s.emptyText}>Not connected to gateway</Text>
      </View>
    );
  }

  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
      <ScrollView
        style={s.root}
        contentContainerStyle={{ paddingBottom: DOCK_BOTTOM_SPACE + SPACING.xl }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={accent}
            colors={[accent]}
            progressBackgroundColor="transparent"
          />
        }
      >
        {/* Hero */}
        <GlassSurface tint="primary" depth={2} radius={22} style={s.hero}>
          <LinearGradient
            colors={[withAlpha(accent, 0.18), 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={s.heroGlow}
            pointerEvents="none"
          />
          <View style={s.heroBadge}>
            <View style={[s.heroDot, { backgroundColor: accent }]} />
            <Text style={s.heroBadgeText}>KNOWLEDGE</Text>
          </View>
          <Text style={s.heroTitle}>Library</Text>
          <Text style={s.heroSubtitle}>
            {loading && notes.length === 0
              ? 'Loading your knowledge…'
              : `${notes.length + research.length + workflows.length} items across notes, research & workflows`}
          </Text>
        </GlassSurface>

        {/* Search */}
        <GlassSurface tint="primary" depth={1} radius={14} style={s.searchRow}>
          <Ionicons name="search" size={16} color={colors.textMuted} />
          <TextInput
            style={s.searchInput}
            placeholder="Search every document type…"
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
          />
          {search ? (
            <TouchableOpacity
              onPress={() => setSearch('')}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="close-circle" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </GlassSurface>

        {/* Type filter chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.chipRow}
          testID="library-type-chips"
        >
          {chips.map((c) => {
            const on = typeFilter === c.id;
            const tint = c.color || accent;
            return (
              <TouchableOpacity
                key={c.id || 'all'}
                onPress={() => setTypeFilter(c.id)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${c.label}, ${c.count}`}
                testID={`library-chip-${c.id || 'all'}`}
                style={[
                  s.typeChip,
                  {
                    borderColor: on ? withAlpha(tint, 0.7) : withAlpha(tint, 0.25),
                    backgroundColor: on ? withAlpha(tint, 0.2) : withAlpha(tint, 0.07),
                  },
                ]}
              >
                <Ionicons name={c.icon} size={14} color={tint} />
                <Text style={[s.typeChipText, { color: on ? colors.text : colors.textSecondary }]}>{c.label}</Text>
                <Text style={[s.typeChipCount, { color: tint }]}>{c.count}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {error ? (
          <GlassSurface tint="danger" depth={1} radius={10} style={s.errorBanner}>
            <Ionicons name="warning-outline" size={14} color={colors.error} />
            <Text style={[s.errorText, { flex: 1 }]}>{error}</Text>
            <TouchableOpacity
              onPress={loadAll}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Text style={[s.errorText, { fontWeight: '700' }]}>Retry</Text>
            </TouchableOpacity>
          </GlassSurface>
        ) : null}

        {/* Stats */}
        <View style={s.statsRow}>
          {stats.map((stat) => (
            <GlassCard key={stat.label} tint="primary" style={s.statCard}>
              <View style={s.statCardInner}>
                <View
                  style={[
                    s.statIconWrap,
                    {
                      backgroundColor: withAlpha(accent, 0.12),
                      borderColor: withAlpha(accent, 0.22),
                    },
                  ]}
                >
                  <Ionicons name={stat.icon} size={16} color={accent} />
                </View>
                <Text style={[s.statValue, { color: accent }]}>
                  {loading && notes.length === 0 ? '…' : stat.value}
                </Text>
                <Text style={s.statLabel}>{stat.label}</Text>
              </View>
            </GlassCard>
          ))}
        </View>

        {/* Collections (feature cards) */}
        <View style={s.sectionHeader}>
          <View style={[s.sectionDot, { backgroundColor: accent }]} />
          <Text style={s.sectionTitle}>COLLECTIONS</Text>
        </View>
        <View style={[s.featureGrid, isTablet && s.featureGridTablet]}>
          {features.map((f) => (
            <GlassCard
              key={f.key}
              tint="primary"
              style={[s.featureCard, isTablet && s.featureCardTablet]}
            >
              <TouchableOpacity
                onPress={() => navigation.navigate(f.screen)}
                activeOpacity={0.8}
                style={s.featureTouch}
                accessibilityRole="button"
                accessibilityLabel={`Open ${f.title}`}
                testID={`library-${f.key}`}
              >
                <View style={[s.featureBorder, { backgroundColor: accent }]} />
                <View style={s.featureBody}>
                  <View
                    style={[
                      s.featureIcon,
                      {
                        backgroundColor: withAlpha(accent, 0.14),
                        borderColor: withAlpha(accent, 0.28),
                      },
                    ]}
                  >
                    <Ionicons name={f.icon} size={26} color={accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.featureTitle}>{f.title}</Text>
                    <Text style={s.featureDesc}>{f.desc}</Text>
                    <Text style={[s.featureCount, { color: accent }]}>
                      {loading && notes.length === 0 ? '…' : f.count == null ? 'Open' : `${f.count} items`}
                    </Text>
                  </View>
                  <View
                    style={[
                      s.featureArrow,
                      { backgroundColor: withAlpha(accent, 0.12) },
                    ]}
                  >
                    <Ionicons name="chevron-forward" size={18} color={accent} />
                  </View>
                </View>
              </TouchableOpacity>
            </GlassCard>
          ))}
        </View>

        {/* Typed library list */}
        <View style={s.sectionHeader}>
          <View style={[s.sectionDot, { backgroundColor: activeType?.color || accent }]} />
          <Text style={s.sectionTitle}>{activeType ? activeType.label.toUpperCase() : 'ALL DOCUMENTS'}</Text>
          <TouchableOpacity
            style={s.sectionLink}
            onPress={() => setPickerOpen(true)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            testID="library-new"
          >
            <Ionicons name="add" size={14} color={accent} />
            <Text style={[s.sectionLinkText, { color: accent }]}>New</Text>
          </TouchableOpacity>
        </View>

        {libItems.length === 0 ? (
          <GlassCard tint="primary" style={s.emptyCard}>
            <View style={s.emptyInner}>
              {loading && !lib ? (
                <ActivityIndicator color={accent} />
              ) : (
                <>
                  <Ionicons name={activeType ? ionIconFor(activeType.icon) : 'documents-outline'} size={28} color={colors.textMuted} />
                  <Text style={s.emptyText}>
                    {search ? 'Nothing matches this search' : activeType ? `No ${activeType.label.toLowerCase()} yet` : 'Nothing here yet'}
                  </Text>
                  {!search && (!activeType || activeType.creatable) ? (
                    <TouchableOpacity
                      style={[s.emptyCta, { backgroundColor: withAlpha(accent, 0.14), borderColor: withAlpha(accent, 0.32) }]}
                      onPress={() => (activeType ? createOfType(activeType) : setPickerOpen(true))}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="add" size={16} color={accent} />
                      <Text style={[s.emptyCtaText, { color: accent }]}>
                        {activeType ? `New ${activeType.label.split(' /')[0]}` : 'Create something'}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </>
              )}
            </View>
          </GlassCard>
        ) : (
          <GlassCard tint="primary" style={s.recentList}>
            <View style={s.recentListInner}>
              {libItems.slice(0, 40).map((it, idx, arr) => {
                const t = typeById(types, it.type);
                return (
                  <TouchableOpacity
                    key={`${it.source}:${it.id}`}
                    style={[
                      s.recentItem,
                      idx < arr.length - 1 && {
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: withAlpha(accent, 0.12),
                      },
                    ]}
                    onPress={() => openItem(it)}
                    activeOpacity={0.7}
                    testID={`library-item-${it.id}`}
                  >
                    <View style={[s.itemIcon, { backgroundColor: withAlpha(t.color, 0.14), borderColor: withAlpha(t.color, 0.32) }]}>
                      <Ionicons name={ionIconFor(t.icon)} size={15} color={t.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.recentTitle} numberOfLines={1}>
                        {it.title || '(untitled)'}
                      </Text>
                      {it.preview ? (
                        <Text style={s.recentDesc} numberOfLines={1}>
                          {it.preview}
                        </Text>
                      ) : null}
                      <View style={s.recentMeta}>
                        <Text style={s.recentMetaText}>{fmtRelative(it.updatedAt)}</Text>
                        <View style={[s.recentBadge, { backgroundColor: withAlpha(t.color, 0.12), borderColor: withAlpha(t.color, 0.3) }]}>
                          <Text style={[s.recentBadgeText, { color: t.color }]}>{t.label}</Text>
                        </View>
                        {it.category ? (
                          <View style={[s.recentBadge, { backgroundColor: withAlpha(accent, 0.08), borderColor: withAlpha(accent, 0.2) }]}>
                            <Text style={[s.recentBadgeText, { color: colors.textSecondary }]}>{it.category}</Text>
                          </View>
                        ) : null}
                        {it.source === 'idea' && it.status ? (
                          <Text style={[s.recentMetaText, { textTransform: 'capitalize' }]}>{it.status}</Text>
                        ) : null}
                      </View>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                );
              })}
            </View>
          </GlassCard>
        )}

        {/* Quick actions */}
        <View style={s.quickActions}>
          <GlassCard tint="primary" style={s.quickActionCard}>
            <TouchableOpacity
              style={s.quickActionTouch}
              onPress={() => setPickerOpen(true)}
              activeOpacity={0.75}
            >
              <Ionicons name="add-circle" size={18} color={accent} />
              <Text style={[s.quickActionText, { color: accent }]}>New…</Text>
            </TouchableOpacity>
          </GlassCard>
          <GlassCard tint="primary" style={s.quickActionCard}>
            <TouchableOpacity
              style={s.quickActionTouch}
              onPress={() => navigation.navigate('Research')}
              activeOpacity={0.75}
            >
              <Ionicons name="book" size={18} color={accent} />
              <Text style={[s.quickActionText, { color: accent }]}>Open Research</Text>
            </TouchableOpacity>
          </GlassCard>
          <GlassCard tint="primary" style={s.quickActionCard}>
            <TouchableOpacity
              style={s.quickActionTouch}
              onPress={() => navigation.navigate('Workflows')}
              activeOpacity={0.75}
            >
              <Ionicons name="layers" size={18} color={accent} />
              <Text style={[s.quickActionText, { color: accent }]}>Run a Workflow</Text>
            </TouchableOpacity>
          </GlassCard>
        </View>
      </ScrollView>

      {/* Create-with-type picker */}
      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <TouchableOpacity style={s.pickerScrim} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <GlassSurface tint="primary" depth={3} radius={22} style={s.picker}>
            <TouchableOpacity activeOpacity={1}>
              <Text style={s.pickerTitle}>Create</Text>
              <Text style={s.pickerSub}>Pick what you are making — it is filed under that type.</Text>
              <View style={s.pickerGrid} testID="library-type-picker">
                {creatableTypes(types).map((t) => (
                  <TouchableOpacity
                    key={t.id}
                    style={[s.pickerItem, { borderColor: withAlpha(t.color, 0.3), backgroundColor: withAlpha(t.color, 0.08) }]}
                    onPress={() => createOfType(t)}
                    disabled={!!creating}
                    activeOpacity={0.8}
                    testID={`library-create-${t.id}`}
                  >
                    {creating === t.id ? (
                      <ActivityIndicator size="small" color={t.color} />
                    ) : (
                      <Ionicons name={ionIconFor(t.icon)} size={20} color={t.color} />
                    )}
                    <Text style={s.pickerLabel} numberOfLines={1}>
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </TouchableOpacity>
          </GlassSurface>
        </TouchableOpacity>
      </Modal>
    </Animated.View>
  );
}

function makeStyles(colors, accent) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: 'transparent' },
    chipRow: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm, gap: 8 },
    typeChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 36,
      paddingHorizontal: 12,
      borderRadius: 999,
      borderWidth: 1,
    },
    typeChipText: { fontSize: 13, fontWeight: '600' },
    typeChipCount: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
    itemIcon: {
      width: 32,
      height: 32,
      borderRadius: 10,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
    },
    pickerScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end', padding: SPACING.md },
    picker: { padding: SPACING.lg, marginBottom: SPACING.xl },
    pickerTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
    pickerSub: { color: colors.textSecondary, fontSize: 13, marginTop: 4, marginBottom: SPACING.md },
    pickerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    pickerItem: {
      width: '30.5%',
      minHeight: 76,
      borderRadius: 16,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: 6,
    },
    pickerLabel: { color: colors.text, fontSize: 12, fontWeight: '600', textAlign: 'center' },
    centered: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: 12,
    },
    emptyText: { ...TYPOGRAPHY.body, color: colors.textMuted, textAlign: 'center' },

    hero: {
      marginHorizontal: SPACING.lg,
      marginTop: SPACING.lg,
      padding: SPACING.lg + 4,
      overflow: 'hidden',
    },
    heroGlow: {
      position: 'absolute',
      top: -40,
      right: -40,
      width: 220,
      height: 220,
      borderRadius: 110,
      opacity: 0.9,
    },
    heroBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 4,
      backgroundColor: withAlpha(accent, 0.14),
      borderRadius: 999,
      alignSelf: 'flex-start',
      borderWidth: 1,
      borderColor: withAlpha(accent, 0.28),
    },
    heroDot: { width: 6, height: 6, borderRadius: 3 },
    heroBadgeText: {
      ...TYPOGRAPHY.caption,
      color: accent,
      letterSpacing: 1.4,
      fontWeight: '700',
    },
    heroTitle: {
      ...TYPOGRAPHY.heading,
      color: colors.text,
      fontSize: 32,
      marginTop: SPACING.sm,
      letterSpacing: -0.5,
    },
    heroSubtitle: {
      ...TYPOGRAPHY.body,
      color: colors.textMuted,
      marginTop: 4,
    },

    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: SPACING.lg,
      marginTop: SPACING.lg,
      paddingHorizontal: SPACING.md,
      paddingVertical: 12,
      minHeight: 44,
    },
    searchInput: {
      flex: 1,
      color: colors.text,
      ...TYPOGRAPHY.body,
      padding: 0,
    },

    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginHorizontal: SPACING.lg,
      marginTop: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
    },
    errorText: { color: colors.error, ...TYPOGRAPHY.small, flex: 1 },

    statsRow: {
      flexDirection: 'row',
      gap: SPACING.sm,
      paddingHorizontal: SPACING.lg,
      marginTop: SPACING.lg,
    },
    statCard: {
      flex: 1,
      overflow: 'hidden',
    },
    statCardInner: { padding: SPACING.md, alignItems: 'flex-start' },
    statIconWrap: {
      width: 30,
      height: 30,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      marginBottom: SPACING.sm,
    },
    statValue: {
      ...TYPOGRAPHY.heading,
      fontSize: 22,
      lineHeight: 26,
      letterSpacing: -0.4,
    },
    statLabel: {
      ...TYPOGRAPHY.caption,
      color: colors.textMuted,
      marginTop: 2,
      letterSpacing: 1,
    },

    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: SPACING.lg,
      marginTop: SPACING.xl,
      marginBottom: SPACING.md,
    },
    sectionDot: { width: 6, height: 6, borderRadius: 3 },
    sectionTitle: {
      ...TYPOGRAPHY.caption,
      color: colors.textSecondary,
      letterSpacing: 1.5,
      fontWeight: '700',
      flex: 1,
    },
    sectionLink: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
    sectionLinkText: { ...TYPOGRAPHY.caption, fontWeight: '700' },

    featureGrid: { gap: SPACING.md, paddingHorizontal: SPACING.lg },
    featureGridTablet: { flexDirection: 'row' },
    featureCard: {
      overflow: 'hidden',
    },
    featureCardTablet: { flex: 1 },
    featureTouch: {
      minHeight: 44,
    },
    featureBorder: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
      opacity: 0.85,
    },
    featureBody: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.md,
      padding: SPACING.lg,
    },
    featureIcon: {
      width: 46,
      height: 46,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
    },
    featureTitle: {
      ...TYPOGRAPHY.heading,
      fontSize: 17,
      color: colors.text,
    },
    featureDesc: {
      ...TYPOGRAPHY.small,
      color: colors.textMuted,
      marginTop: 2,
    },
    featureCount: {
      ...TYPOGRAPHY.caption,
      marginTop: 6,
      fontWeight: '700',
      letterSpacing: 1,
    },
    featureArrow: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },

    emptyCard: {
      marginHorizontal: SPACING.lg,
      overflow: 'hidden',
    },
    emptyInner: {
      paddingVertical: SPACING.xl,
      paddingHorizontal: SPACING.lg,
      alignItems: 'center',
      gap: 10,
    },
    emptyCta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 10,
      minHeight: 44,
      borderRadius: 12,
      borderWidth: 1,
      marginTop: 6,
    },
    emptyCtaText: { ...TYPOGRAPHY.small, fontWeight: '700' },

    recentList: {
      marginHorizontal: SPACING.lg,
      overflow: 'hidden',
    },
    recentListInner: {},
    recentItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.md,
      minHeight: 44,
    },
    recentBullet: { width: 6, height: 6, borderRadius: 3, marginLeft: 2 },
    recentTitleRow: { flexDirection: 'row', alignItems: 'center' },
    recentTitle: {
      ...TYPOGRAPHY.body,
      fontWeight: '600',
      color: colors.text,
      flexShrink: 1,
    },
    recentDesc: { ...TYPOGRAPHY.small, color: colors.textMuted, marginTop: 2 },
    recentMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 4,
    },
    recentMetaText: { ...TYPOGRAPHY.caption, color: colors.textMuted },
    recentBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 6,
      borderWidth: 1,
    },
    recentBadgeText: { ...TYPOGRAPHY.caption, fontWeight: '600' },

    quickActions: {
      flexDirection: 'row',
      gap: SPACING.sm,
      marginHorizontal: SPACING.lg,
      marginTop: SPACING.lg,
    },
    quickActionCard: {
      flex: 1,
      overflow: 'hidden',
    },
    quickActionTouch: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 14,
      minHeight: 44,
    },
    quickActionText: { ...TYPOGRAPHY.body, fontWeight: '700' },
  });
}

export default LibraryScreen;
