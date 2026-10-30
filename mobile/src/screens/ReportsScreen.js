/**
 * ReportsScreen — the Reports library (parity with web /reports + the
 * Research workspace's report list).
 *
 *   Library    every report in the shared store, grouped by category or date,
 *              with search, category / status filters, sort, pull-to-refresh
 *              and paging. System events (oversight "Sub-agent failed …"
 *              rows, gateway recovery, credit alerts, incidents) are hidden by
 *              default — they are >90% of the store and bury real reports.
 *   Research   research reports + research-workspace docs (same RPCs and the
 *              same isResearchReport rule as the web Research page).
 *   Schedules / Triggers   read-only views of reports.schedules / triggers.
 *
 * Tapping a report opens ReportDetail: the markitdown copy rendered natively,
 * the PDF (or original HTML) in-app, share/save, linked projects and "View in
 * graph". Generate / resend / delete stay available as secondary actions.
 *
 * Route params: { reportId } opens that report directly
 * (infinibot://reports?reportId=rpt_…).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  SectionList,
  Pressable,
  RefreshControl,
  Alert,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  useUIKit,
  SPACE,
  RADIUS,
  HIT,
  Screen,
  AppHeader,
  Tabs,
  SegmentedControl,
  Field,
  Chip,
  StatusChip,
  Button,
  IconButton,
  Card,
  EmptyState,
  SkeletonRow,
  BottomSheet,
  DOCK_SPACE,
} from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import { useReports } from '../hooks/useReports';
import { ReportDetail } from '../components/reports/ReportDetail';
import { useRotationWhileFocused } from '../infini/orientation';
import {
  filterReports,
  sortReports,
  groupReports,
  categoriesOf,
  categoryLabel,
  categoryOf,
  isSystemEvent,
  relTime,
  assetKind,
  titleCase,
  describeCron,
} from '../lib/reports-model';

const PREFS_KEY = '@moltbot/reports_prefs_v2';
const ALL_SINKS = ['ui', 'telegram', 'email'];
const STATUSES = ['ready', 'sent', 'queued', 'rendering', 'failed'];

const SORTS = [
  { key: 'date', label: 'Date' },
  { key: 'title', label: 'Title' },
  { key: 'source', label: 'Source' },
];

const CATEGORY_ICON = {
  research: 'flask-outline',
  finance: 'cash-outline',
  operations: 'construct-outline',
  insights: 'sparkles-outline',
  security: 'shield-checkmark-outline',
  'agent-output': 'hardware-chip-outline',
  general: 'document-text-outline',
};

function kindIcon(r) {
  if (r?.isResearchDoc) return 'flask-outline';
  if (r?.kind === 'oversight_event') return 'pulse-outline';
  if (r?.kind === 'gateway_recovery') return 'shield-checkmark-outline';
  if (r?.kind === 'credit_burn_alert') return 'flame-outline';
  if (r?.kind === 'incident') return 'warning-outline';
  return CATEGORY_ICON[categoryOf(r)] || 'document-text-outline';
}

// ── Row ─────────────────────────────────────────────────────────────

function ReportRow({ r, onPress, colors, type }) {
  const k = r.isResearchDoc ? 'doc' : assetKind(r);
  const failed = r.status === 'failed';
  const tone = failed ? colors.error : isSystemEvent(r) ? colors.textMuted : colors.primary;
  return (
    <Pressable
      onPress={() => onPress(r)}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: withAlpha(colors.surface || colors.text, pressed ? 0.85 : 0.6),
          borderColor: withAlpha(colors.primary, 0.16),
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Open report ${r.title}`}
    >
      <View style={[styles.rowIcon, { borderColor: withAlpha(tone, 0.4), backgroundColor: withAlpha(tone, 0.08) }]}>
        <Ionicons name={kindIcon(r)} size={18} color={tone} />
      </View>
      <View style={styles.rowBody}>
        <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={2}>
          {r.title || r.id}
        </Text>
        {r.summaryText ? (
          <Text style={[type.small, { color: colors.textMuted, marginTop: 2 }]} numberOfLines={1}>
            {r.summaryText}
          </Text>
        ) : null}
        <View style={styles.rowMeta}>
          <Text style={[type.caption, { color: colors.primary }]} numberOfLines={1}>
            {r.isResearchDoc ? 'Research doc' : categoryLabel(categoryOf(r))}
          </Text>
          <Text style={[type.monoSmall, { color: colors.textMuted }]}>· {relTime(r.createdAt)}</Text>
          {r.hasMarkdown || r.isResearchDoc ? (
            <Text style={[styles.badge, type.monoSmall, { color: colors.info, borderColor: withAlpha(colors.info, 0.35) }]}>MD</Text>
          ) : null}
          {k === 'pdf' || k === 'html' ? (
            <Text style={[styles.badge, type.monoSmall, { color: colors.primary, borderColor: withAlpha(colors.primary, 0.35) }]}>
              {k.toUpperCase()}
            </Text>
          ) : null}
        </View>
      </View>
      {failed ? <StatusChip status="failed" size="sm" /> : <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />}
    </Pressable>
  );
}

// ── Schedules / triggers rows (read-only) ───────────────────────────

function AutomationRow({ item, mode, colors, type }) {
  const on = item.enabled !== false;
  return (
    <View style={[styles.row, { backgroundColor: withAlpha(colors.surface || colors.text, 0.6), borderColor: withAlpha(colors.primary, 0.16) }]}>
      <View style={[styles.rowIcon, { borderColor: withAlpha(on ? colors.primary : colors.textMuted, 0.4) }]}>
        <Ionicons name={mode === 'schedules' ? 'time-outline' : 'flash-outline'} size={18} color={on ? colors.primary : colors.textMuted} />
      </View>
      <View style={styles.rowBody}>
        <Text style={[type.bodyStrong, { color: colors.text }]}>{titleCase(item.kind)}</Text>
        <Text style={[type.small, { color: colors.textSecondary, marginTop: 2 }]}>
          {mode === 'schedules' ? describeCron(item.cron) : `On ${titleCase(item.eventType)}`}
        </Text>
        <View style={styles.rowMeta}>
          {mode === 'schedules' ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>{item.cron}</Text> : null}
          <Text style={[type.caption, { color: colors.textMuted }]}>
            {mode === 'schedules' ? '· ' : ''}to {(item.sinks || []).join(', ') || 'ui'}
          </Text>
          {item.lastRunAt ? <Text style={[type.caption, { color: colors.textMuted }]}>· last {relTime(item.lastRunAt)}</Text> : null}
        </View>
      </View>
      <Chip label={on ? 'On' : 'Off'} tone={on ? 'success' : 'neutral'} size="sm" dot />
    </View>
  );
}

// ── Screen ──────────────────────────────────────────────────────────

export function ReportsScreen({ gateway, navigation, route }) {
  const { colors, type } = useUIKit();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const api = useReports(gateway);
  // Reports (PDFs especially) read better sideways: unlock rotation while focused.
  useRotationWhileFocused();

  const [segment, setSegment] = useState('library');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('date');
  const [dir, setDir] = useState(-1);
  const [groupBy, setGroupBy] = useState('category');
  const [hideSystem, setHideSystem] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openRow, setOpenRow] = useState(null);
  const [genOpen, setGenOpen] = useState(false);

  // Persisted view prefs (group / sort / hide-system).
  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY)
      .then((raw) => {
        const p = raw ? JSON.parse(raw) : null;
        if (!p) return;
        if (p.groupBy === 'category' || p.groupBy === 'date') setGroupBy(p.groupBy);
        if (SORTS.some((s) => s.key === p.sort)) setSort(p.sort);
        if (p.dir === 1 || p.dir === -1) setDir(p.dir);
        if (typeof p.hideSystem === 'boolean') setHideSystem(p.hideSystem);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify({ groupBy, sort, dir, hideSystem })).catch(() => {});
  }, [groupBy, sort, dir, hideSystem]);

  // Deep link: infinibot://reports?reportId=…
  const routeReportId = route?.params?.reportId;
  useEffect(() => {
    if (routeReportId) setOpenRow({ id: String(routeReportId), title: 'Report' });
  }, [routeReportId]);

  // Lazy-load the other segments the first time they're shown.
  useEffect(() => {
    if (segment === 'research' && !api.research.loaded && !api.research.loading) api.loadResearch();
    if ((segment === 'schedules' || segment === 'triggers') && !api.automation.loaded && !api.automation.loading) api.loadAutomation();
  }, [segment, api]);

  const sourceRows = segment === 'research' ? api.research.rows : api.rows;
  const systemCount = useMemo(() => api.rows.filter(isSystemEvent).length, [api.rows]);

  const filtered = useMemo(
    () =>
      sortReports(
        filterReports(sourceRows, {
          search,
          category: segment === 'research' ? 'all' : category,
          status,
          hideSystem: segment === 'library' && hideSystem,
        }),
        sort,
        dir,
      ),
    [sourceRows, search, category, status, hideSystem, sort, dir, segment],
  );

  const sections = useMemo(() => {
    if (segment === 'schedules') return api.automation.schedules.length ? [{ key: 's', title: 'Schedules', data: api.automation.schedules }] : [];
    if (segment === 'triggers') return api.automation.triggers.length ? [{ key: 't', title: 'Triggers', data: api.automation.triggers }] : [];
    return groupReports(filtered, segment === 'research' ? 'date' : groupBy, { dir });
  }, [segment, filtered, groupBy, dir, api.automation]);

  const categories = useMemo(
    () => categoriesOf(api.rows.filter((r) => !(hideSystem && isSystemEvent(r))), api.meta.categories || []),
    [api.rows, api.meta.categories, hideSystem],
  );

  const activeFilters = (category !== 'all' ? 1 : 0) + (status !== 'all' ? 1 : 0);

  const segTabs = [
    { key: 'library', label: 'Library', icon: 'library-outline', count: hideSystem ? api.rows.length - systemCount : api.rows.length },
    { key: 'research', label: 'Research', icon: 'flask-outline', count: api.research.loaded ? api.research.rows.length : undefined },
    { key: 'schedules', label: 'Schedules', icon: 'time-outline', count: api.automation.loaded ? api.automation.schedules.length : undefined },
    { key: 'triggers', label: 'Triggers', icon: 'flash-outline', count: api.automation.loaded ? api.automation.triggers.length : undefined },
  ];

  const loading = segment === 'research' ? api.research.loading : segment === 'library' ? api.loading : api.automation.loading;
  const error = segment === 'research' ? api.research.error : segment === 'library' ? api.error : api.automation.error;
  const onRefresh = segment === 'research' ? api.loadResearch : segment === 'library' ? api.refresh : api.loadAutomation;

  // ── navigation ──
  const openGraph = useCallback(
    (focus) => {
      setOpenRow(null);
      try {
        navigation?.goBack?.();
      } catch {
        /* not a modal */
      }
      setTimeout(() => {
        try {
          navigation?.navigate?.('MainTabs', {
            screen: 'Knowledge',
            params: { screen: 'KnowledgeGraph', initial: false, params: { focus } },
          });
        } catch {
          /* graph route not registered in this build */
        }
      }, 50);
    },
    [navigation],
  );

  // ── secondary actions ──
  const handleResend = useCallback(
    (r) => {
      if (!r?.id) return;
      Alert.alert('Resend report', `Send "${r.title || r.kind}" to which channel?`, [
        { text: 'Cancel', style: 'cancel' },
        ...ALL_SINKS.map((sink) => ({
          text: sink.toUpperCase(),
          onPress: async () => {
            const res = await api.resend(r.id, [sink]);
            if (res?.ok) Alert.alert('Sent', `Delivered to ${sink}.`);
            else Alert.alert('Delivery failed', `Could not deliver to ${sink}.`);
          },
        })),
      ]);
    },
    [api],
  );

  const handleDelete = useCallback(
    (r) => {
      if (!r?.id) return;
      Alert.alert('Delete report', `Delete "${r.title || r.kind}"? This removes the rendered file too.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (await api.deleteItem(r.id)) setOpenRow(null);
          },
        },
      ]);
    },
    [api],
  );

  // ── header ──
  const subtitle =
    segment === 'library'
      ? `${api.total.toLocaleString()} in store · ${hideSystem ? `${systemCount} system events hidden` : `${api.rows.length} loaded`}`
      : segment === 'research'
        ? 'Research reports and workspace docs'
        : 'Read-only — edit on the web Reports page';

  const header = (
    <AppHeader
      eyebrow="Knowledge"
      title="Reports"
      subtitle={subtitle}
      leftIcon={navigation?.canGoBack?.() ? 'chevron-back' : undefined}
      leftLabel="Back"
      onLeftPress={() => navigation?.goBack?.()}
      rightActions={[{ key: 'gen', icon: 'add-circle-outline', label: 'Generate a report', onPress: () => setGenOpen(true) }]}
    >
      <Tabs tabs={segTabs} active={segment} onSelect={setSegment} />
    </AppHeader>
  );

  const showReportControls = segment === 'library' || segment === 'research';

  const listHeader = showReportControls ? (
    <View style={styles.controls}>
      <Field
        value={search}
        onChangeText={setSearch}
        icon="search"
        placeholder={segment === 'research' ? 'Search research…' : 'Search title, category, agent…'}
        rightIcon={search ? 'close-circle' : undefined}
        rightLabel="Clear search"
        onRightPress={() => setSearch('')}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
      />
      <View style={styles.controlRow}>
        {segment === 'library' ? (
          <SegmentedControl
            size="sm"
            style={styles.groupSeg}
            options={[
              { key: 'category', label: 'Category', icon: 'folder-outline' },
              { key: 'date', label: 'Date', icon: 'calendar-outline' },
            ]}
            value={groupBy}
            onChange={setGroupBy}
          />
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <IconButton
          icon="options-outline"
          variant={filtersOpen || activeFilters ? 'solid' : 'outline'}
          badge={activeFilters || undefined}
          onPress={() => setFiltersOpen((v) => !v)}
          accessibilityLabel="Filters and sort"
        />
        <IconButton
          icon={dir === -1 ? 'arrow-down' : 'arrow-up'}
          variant="outline"
          onPress={() => setDir((d) => (d === -1 ? 1 : -1))}
          accessibilityLabel={dir === -1 ? 'Sorted newest first — tap for oldest first' : 'Sorted oldest first — tap for newest first'}
        />
      </View>
      {segment === 'library' ? (
        <View style={styles.chipLine}>
          <Chip
            label={hideSystem ? `System events hidden · ${systemCount}` : 'Showing system events'}
            icon={hideSystem ? 'eye-off-outline' : 'eye-outline'}
            selected={hideSystem}
            tone={hideSystem ? 'primary' : 'neutral'}
            onPress={() => setHideSystem((v) => !v)}
            accessibilityLabel="Toggle system events"
          />
        </View>
      ) : null}
      {filtersOpen ? (
        <Card padded depth={1} tint="primary" style={styles.filterCard}>
          <Text style={[type.label, { color: colors.textSecondary }]}>Sort by</Text>
          <View style={styles.wrapRow}>
            {SORTS.map((s) => (
              <Chip key={s.key} label={s.label} selected={sort === s.key} tone={sort === s.key ? 'primary' : 'neutral'} onPress={() => setSort(s.key)} />
            ))}
          </View>
          {segment === 'library' ? (
            <>
              <Text style={[type.label, { color: colors.textSecondary, marginTop: SPACE.md }]}>Category</Text>
              <View style={styles.wrapRow}>
                <Chip label="All" selected={category === 'all'} tone={category === 'all' ? 'primary' : 'neutral'} onPress={() => setCategory('all')} />
                {categories.map((c) => (
                  <Chip
                    key={c}
                    label={categoryLabel(c)}
                    icon={CATEGORY_ICON[c]}
                    selected={category === c}
                    tone={category === c ? 'primary' : 'neutral'}
                    onPress={() => setCategory(c)}
                  />
                ))}
              </View>
            </>
          ) : null}
          <Text style={[type.label, { color: colors.textSecondary, marginTop: SPACE.md }]}>Status</Text>
          <View style={styles.wrapRow}>
            <Chip label="Any" selected={status === 'all'} tone={status === 'all' ? 'primary' : 'neutral'} onPress={() => setStatus('all')} />
            {STATUSES.map((s) => (
              <Chip key={s} label={titleCase(s)} selected={status === s} tone={status === s ? 'primary' : 'neutral'} onPress={() => setStatus(s)} />
            ))}
          </View>
          {activeFilters ? (
            <Button
              title="Clear filters"
              variant="ghost"
              size="sm"
              icon="close"
              onPress={() => {
                setCategory('all');
                setStatus('all');
              }}
              style={{ marginTop: SPACE.md, alignSelf: 'flex-start' }}
            />
          ) : null}
        </Card>
      ) : null}
      <Text style={[type.caption, { color: colors.textMuted }]}>
        {filtered.length} {filtered.length === 1 ? 'report' : 'reports'}
        {segment === 'library' && api.hasMore ? ` · ${(api.total - api.rows.length).toLocaleString()} older not loaded` : ''}
      </Text>
    </View>
  ) : (
    <View style={styles.controls}>
      <Card padded depth={1} style={styles.filterCard}>
        <View style={{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'center' }}>
          <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
          <Text style={[type.small, { color: colors.textSecondary, flex: 1 }]}>
            {segment === 'schedules'
              ? 'Reports the gateway renders on a timer. Manage them on the web Reports page.'
              : 'Reports rendered automatically when an event fires. Manage them on the web Reports page.'}
          </Text>
        </View>
      </Card>
    </View>
  );

  const empty = loading ? (
    <View style={{ gap: SPACE.sm }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <SkeletonRow key={i} avatar />
      ))}
    </View>
  ) : error ? (
    <EmptyState icon="cloud-offline-outline" tone="danger" title="Couldn't load reports" message={error} actionLabel="Retry" onAction={onRefresh} />
  ) : segment === 'schedules' || segment === 'triggers' ? (
    <EmptyState icon={segment === 'schedules' ? 'time-outline' : 'flash-outline'} title={`No ${segment}`} message="Nothing is set up to render reports automatically yet." />
  ) : search || activeFilters ? (
    <EmptyState
      icon="search-outline"
      title="No matching reports"
      message="Try a different search, category or status."
      actionLabel="Clear filters"
      onAction={() => {
        setSearch('');
        setCategory('all');
        setStatus('all');
      }}
    />
  ) : (
    <EmptyState
      icon={segment === 'research' ? 'flask-outline' : 'document-text-outline'}
      title={segment === 'research' ? 'No research yet' : 'No reports yet'}
      message={
        segment === 'research'
          ? 'Research reports filed from the Research workspace or by agents show up here.'
          : 'Reports agents render — and every PDF saved to the reports store — appear here.'
      }
      actionLabel={segment === 'library' && hideSystem && systemCount ? 'Show system events' : undefined}
      onAction={segment === 'library' && hideSystem && systemCount ? () => setHideSystem(false) : undefined}
    />
  );

  const footer =
    segment === 'library' && api.hasMore && api.rows.length ? (
      <View style={styles.footer}>
        <Button
          title={api.loadingMore ? 'Loading…' : 'Load older reports'}
          variant="outline"
          icon="chevron-down"
          loading={api.loadingMore}
          onPress={api.loadMore}
        />
      </View>
    ) : (
      <View style={{ height: SPACE.lg }} />
    );

  return (
    // Landscape phones have ~390pt of height: the header scrolls with the list
    // there instead of pinning half the screen.
    <Screen scroll={false} padded={false} header={landscape ? null : header}>
      <SectionList
        sections={sections}
        keyExtractor={(item, i) => String(item.id || i)}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[styles.listContent, landscape && styles.listWide, { paddingBottom: DOCK_SPACE }]}
        ListHeaderComponent={
          landscape ? (
            <>
              <View style={styles.landscapeHeader}>{header}</View>
              {listHeader}
            </>
          ) : (
            listHeader
          )
        }
        ListEmptyComponent={empty}
        ListFooterComponent={sections.length ? footer : null}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={14}
        windowSize={9}
        refreshControl={<RefreshControl refreshing={!!loading && sections.length > 0} onRefresh={onRefresh} tintColor={colors.primary} />}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHead}>
            <View style={[styles.sectionDot, { backgroundColor: colors.primary }]} />
            <Text style={[type.label, { color: colors.textSecondary, flex: 1 }]} numberOfLines={1}>
              {section.title}
            </Text>
            <Text style={[type.monoSmall, { color: colors.textMuted }]}>{section.data.length}</Text>
          </View>
        )}
        renderItem={({ item }) =>
          segment === 'schedules' || segment === 'triggers' ? (
            <AutomationRow item={item} mode={segment} colors={colors} type={type} />
          ) : (
            <ReportRow r={item} onPress={setOpenRow} colors={colors} type={type} />
          )
        }
        ItemSeparatorComponent={() => <View style={{ height: SPACE.sm }} />}
      />

      <ReportDetail
        visible={!!openRow}
        row={openRow}
        api={api}
        onClose={() => setOpenRow(null)}
        onOpenGraph={openGraph}
        onResend={handleResend}
        onDelete={handleDelete}
      />

      <GenerateSheet visible={genOpen} onClose={() => setGenOpen(false)} api={api} />
    </Screen>
  );
}

// ── Generate (secondary) ────────────────────────────────────────────

function GenerateSheet({ visible, onClose, api }) {
  const { colors, type } = useUIKit();
  const kinds = api.meta.kinds || [];
  const themes = api.meta.themes || [];
  const [kind, setKind] = useState('');
  const [theme, setTheme] = useState('');
  const [sinks, setSinks] = useState(['ui']);
  useEffect(() => {
    if (!kind && kinds.length) setKind(kinds[0]);
  }, [kinds, kind]);
  const toggleSink = (s) => setSinks((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  const go = async () => {
    const res = await api.generate({ kind, theme: theme || undefined, sinks });
    if (res) {
      onClose();
      Alert.alert('Report queued', `Generating "${titleCase(kind)}" — it appears in the library as it renders.`);
    }
  };
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Generate a report"
      subtitle="Queued on the gateway's report worker"
      footer={<Button title="Generate" variant="primary" icon="sparkles-outline" onPress={go} loading={api.busy} disabled={!kind} fullWidth />}
    >
      <Text style={[type.label, { color: colors.textSecondary }]}>Kind</Text>
      <View style={styles.wrapRow}>
        {kinds.map((k) => (
          <Chip key={k} label={titleCase(k)} selected={kind === k} tone={kind === k ? 'primary' : 'neutral'} onPress={() => setKind(k)} />
        ))}
        {!kinds.length ? <ActivityIndicator color={colors.primary} /> : null}
      </View>
      <Text style={[type.label, { color: colors.textSecondary, marginTop: SPACE.md }]}>Theme</Text>
      <View style={styles.wrapRow}>
        <Chip label="Default" selected={!theme} tone={!theme ? 'primary' : 'neutral'} onPress={() => setTheme('')} />
        {themes.map((t) => {
          const id = typeof t === 'string' ? t : t.name;
          const label = typeof t === 'string' ? titleCase(t) : t.label || t.name;
          return <Chip key={id} label={label} selected={theme === id} tone={theme === id ? 'primary' : 'neutral'} onPress={() => setTheme(id)} />;
        })}
      </View>
      <Text style={[type.label, { color: colors.textSecondary, marginTop: SPACE.md }]}>Deliver to</Text>
      <View style={styles.wrapRow}>
        {ALL_SINKS.map((s) => (
          <Chip key={s} label={s.toUpperCase()} selected={sinks.includes(s)} tone={sinks.includes(s) ? 'primary' : 'neutral'} onPress={() => toggleSink(s)} />
        ))}
      </View>
      <View style={{ height: SPACE.md }} />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md },
  listWide: { maxWidth: 900, width: '100%', alignSelf: 'center' },
  landscapeHeader: { marginHorizontal: -SPACE.lg, marginTop: -SPACE.md, marginBottom: SPACE.md },
  controls: { gap: SPACE.sm, marginBottom: SPACE.sm },
  controlRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  groupSeg: { flex: 1 },
  chipLine: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  filterCard: { marginTop: SPACE.xs },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.sm },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    marginTop: SPACE.lg,
    marginBottom: SPACE.sm,
  },
  sectionDot: { width: 6, height: 6, borderRadius: 3 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.md,
    minHeight: HIT.min + SPACE.md,
    paddingVertical: SPACE.md,
    paddingHorizontal: SPACE.md,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.xs },
  rowRight: { alignItems: 'flex-end', gap: SPACE.xs },
  badges: { flexDirection: 'row', gap: SPACE.xs },
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS.sm,
    paddingHorizontal: SPACE.xs,
    overflow: 'hidden',
  },
  footer: { paddingVertical: SPACE.lg, alignItems: 'center' },
});

export default ReportsScreen;
