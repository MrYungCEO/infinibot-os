/**
 * RunReviewsList — the "Run reviews" sub-tab list (parity with
 * ui/src/ui/views/reviews/index.ts renderFilters + renderList): search,
 * status chips (All / Built / Not built / Partial / Failed / Running), time
 * range chips, project filter, rows with status badge, agent kind, files,
 * issues and time ago.
 */
import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, RefreshControl, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, toneColor, Chip, Field, EmptyState, SkeletonRow, DOCK_SPACE } from '../../ui-kit';
import { RUN_REVIEW_STATUSES, TIME_FILTERS, runStatusMeta, runStatusFilterLabel, timeAgo } from './oversight-model';

export function RunReviewsList({ rr, onOpen, now, contentPad }) {
  const { colors, type } = useUIKit();
  const f = rr.filters;

  const renderItem = useCallback(({ item }) => <RunReviewRow review={item} now={now} onOpen={onOpen} />, [now, onOpen]);

  const header = (
    <View style={{ paddingTop: SPACE.md }}>
      <Field
        value={f.search}
        onChangeText={(v) => rr.setFilter('search', v)}
        placeholder="Search title, run, summary…"
        icon="search-outline"
        rightIcon={f.search ? 'close-circle' : undefined}
        onRightPress={() => rr.setFilter('search', '')}
        rightLabel="Clear search"
        accessibilityLabel="Search reviews"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {RUN_REVIEW_STATUSES.map((s) => (
          <Chip
            key={s}
            label={runStatusFilterLabel(s)}
            tone={s === 'all' ? 'primary' : runStatusMeta(s).tone}
            selected={f.status === s}
            onPress={() => rr.setFilter('status', s)}
            size="sm"
          />
        ))}
      </ScrollView>
      <View style={styles.timeRow}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsTight} style={{ flexGrow: 0, flexShrink: 1 }}>
          {TIME_FILTERS.map((t) => (
            <Chip
              key={t.key}
              label={t.key === 'all' ? 'All time' : t.key}
              tone="primary"
              selected={f.time === t.key}
              onPress={() => rr.setFilter('time', t.key)}
              size="sm"
            />
          ))}
        </ScrollView>
      </View>
      <Field
        value={f.project}
        onChangeText={(v) => rr.setFilter('project', v)}
        placeholder="Project…"
        icon="folder-outline"
        mono
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Filter by project"
      />
      <Text style={[type.monoSmall, { color: colors.textMuted, marginVertical: SPACE.sm }]}>
        {rr.loading && !rr.reviews.length ? 'Loading…' : `${rr.filtered.length} review${rr.filtered.length === 1 ? '' : 's'}`}
      </Text>
    </View>
  );

  let empty;
  if (!rr.reviews.length && (rr.loading || !rr.loaded)) {
    empty = (
      <View style={{ gap: SPACE.sm }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <SkeletonRow key={i} />
        ))}
      </View>
    );
  } else if (!rr.reviews.length) {
    empty = (
      <EmptyState
        icon="document-text-outline"
        title="No agent reviews yet"
        message={
          rr.backendMissing
            ? 'This gateway does not serve agents.reviews yet — reviews appear after a gateway update.'
            : "A review is generated for every agent run — they'll show up here as soon as runs complete."
        }
        actionLabel="Reload"
        onAction={rr.load}
      />
    );
  } else {
    empty = <EmptyState icon="search-outline" title="No reviews match your filters" actionLabel="Clear filters" onAction={rr.clearFilters} compact />;
  }

  return (
    <FlatList
      data={rr.filtered}
      keyExtractor={(r) => r.id}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ItemSeparatorComponent={Sep}
      contentContainerStyle={[{ paddingHorizontal: SPACE.lg, paddingBottom: DOCK_SPACE }, contentPad]}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={14}
      windowSize={9}
      refreshControl={<RefreshControl refreshing={rr.loading && rr.loaded} onRefresh={rr.load} tintColor={colors.primary} colors={[colors.primary]} />}
    />
  );
}

function Sep() {
  return <View style={{ height: SPACE.sm }} />;
}

export const RunReviewRow = memo(function RunReviewRow({ review: r, now, onOpen }) {
  const { colors, type, alpha } = useUIKit();
  const sm = runStatusMeta(r.status);
  const c = toneColor(sm.tone, colors);
  return (
    <Pressable
      onPress={() => onOpen(r.runId)}
      accessibilityRole="button"
      accessibilityLabel={`${r.title}, ${sm.label}`}
      style={({ pressed }) => [
        styles.row,
        { borderColor: colors.border, backgroundColor: alpha(colors.text, 0.035), opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <View style={[styles.bar, { backgroundColor: c }]} />
      <View style={{ flex: 1, gap: SPACE.xs + 2 }}>
        <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={2}>
          {r.title}
        </Text>
        <View style={styles.meta}>
          <Chip label={sm.label} tone={sm.tone} size="sm" dot />
          <Text style={[type.caption, { color: colors.textMuted }]}>{r.agentKind}</Text>
          {r.filesTouched.length ? (
            <Text style={[type.monoSmall, { color: colors.textMuted }]}>
              {r.filesTouched.length} file{r.filesTouched.length === 1 ? '' : 's'}
            </Text>
          ) : null}
          {r.issues.length ? (
            <Text style={[type.monoSmall, { color: colors.warning }]}>
              {r.issues.length} issue{r.issues.length === 1 ? '' : 's'}
            </Text>
          ) : null}
          <View style={{ flex: 1 }} />
          <Text style={[type.monoSmall, { color: colors.textMuted }]}>{timeAgo(r.finishedAt ?? r.startedAt, now)}</Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  chips: { gap: SPACE.sm, paddingVertical: SPACE.sm },
  chipsTight: { gap: SPACE.sm, paddingBottom: SPACE.sm },
  timeRow: { flexDirection: 'row', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingVertical: SPACE.sm + 2, paddingLeft: SPACE.md + 2, paddingRight: SPACE.sm, overflow: 'hidden', minHeight: 64 },
  bar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.sm },
});

export default RunReviewsList;
