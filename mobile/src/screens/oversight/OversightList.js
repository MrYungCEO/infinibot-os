/**
 * OversightList — the "Oversight" sub-tab list (parity with the web rail +
 * header + list in views/oversight/index.ts). On a phone the left rail
 * becomes a Filters sheet; rows expand inline exactly like the web's
 * accordion, with "Open full page" leading to RunDetail.
 */
import React, { memo, useCallback, useState } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, RefreshControl, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  useUIKit,
  SPACE,
  RADIUS,
  toneColor,
  Chip,
  Button,
  Field,
  BottomSheet,
  EmptyState,
  SkeletonRow,
  DOCK_SPACE,
} from '../../ui-kit';
import {
  OVERSIGHT_STATUSES,
  DECISION_FILTERS,
  TIME_FILTERS,
  statusMeta,
  decisionTone,
  verdictTone,
  fmtDuration,
  timeAgo,
  finishedAt,
  fmtClock,
} from './oversight-model';
import { ProactivePanel } from './ProactivePanel';
import { ToggleRow } from './ui';
import {
  SummarySection,
  ExitSection,
  BlockersSection,
  NextStepsSection,
  TimelineSection,
  FilesSection,
  MetaSection,
  LinkButtons,
} from './sections';

export function OversightList({ ov, gateway, onOpen, onOpenSession, onOpenTask, contentPad }) {
  const { colors, type } = useUIKit();
  const [sheet, setSheet] = useState(false);
  const f = ov.filters;

  const renderItem = useCallback(
    ({ item }) => (
      <OversightRow
        entry={item}
        now={ov.now}
        expanded={ov.expanded.has(item.runId)}
        onToggle={ov.toggleExpanded}
        onOpen={onOpen}
        acked={ov.acked[item.runId]}
        onToggleAck={ov.toggleAck}
        forcing={ov.forcing.has(item.runId)}
        onForce={ov.forceReview}
        onOpenSession={onOpenSession}
        onOpenTask={onOpenTask}
      />
    ),
    [ov.now, ov.expanded, ov.toggleExpanded, onOpen, ov.acked, ov.toggleAck, ov.forcing, ov.forceReview, onOpenSession, onOpenTask],
  );

  const header = (
    <View style={{ paddingTop: SPACE.md }}>
      <View style={styles.searchRow}>
        <View style={{ flex: 1 }}>
          <Field
            value={f.search}
            onChangeText={(v) => ov.setFilter('search', v)}
            placeholder="Search label, task, runId…"
            icon="search-outline"
            rightIcon={f.search ? 'close-circle' : undefined}
            onRightPress={() => ov.setFilter('search', '')}
            rightLabel="Clear search"
            accessibilityLabel="Search runs"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <Button
          title={ov.activeFilterCount ? `Filters ${ov.activeFilterCount}` : 'Filters'}
          icon="options-outline"
          variant={ov.activeFilterCount ? 'secondary' : 'outline'}
          onPress={() => setSheet(true)}
          accessibilityLabel="Open filters"
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quick}>
        {OVERSIGHT_STATUSES.map((s) => (
          <Chip
            key={s}
            label={s === 'all' ? 'All statuses' : statusMeta(s).label}
            tone={s === 'all' ? 'primary' : statusMeta(s).tone}
            selected={f.status === s}
            onPress={() => ov.setFilter('status', s)}
            size="sm"
          />
        ))}
      </ScrollView>
      <View style={styles.countRow}>
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>
          {ov.loading && !ov.entries.length ? 'Loading…' : `${ov.filtered.length} run${ov.filtered.length === 1 ? '' : 's'}`}
        </Text>
        {ov.runningCount > 0 ? (
          <Text style={[type.monoSmall, { color: colors.info }]}>· {ov.runningCount} live</Text>
        ) : null}
        {f.decision !== 'all' ? (
          <Chip label={DECISION_FILTERS.find((d) => d.key === f.decision)?.label} tone={decisionTone(f.decision)} size="sm" onPress={() => ov.setFilter('decision', 'all')} icon="close" />
        ) : null}
        {f.time !== 'all' ? (
          <Chip label={TIME_FILTERS.find((t) => t.key === f.time)?.label} size="sm" onPress={() => ov.setFilter('time', 'all')} icon="close" />
        ) : null}
        {f.hasBlockers ? <Chip label="Needs attention" tone="danger" size="sm" onPress={() => ov.setFilter('hasBlockers', false)} icon="close" /> : null}
      </View>
      <ProactivePanel gateway={gateway} />
      {ov.error && ov.entries.length ? (
        <Text style={[type.caption, { color: colors.error, marginBottom: SPACE.sm }]}>{ov.error}</Text>
      ) : null}
    </View>
  );

  let empty = null;
  if (!ov.entries.length && (ov.loading || !ov.loaded)) {
    empty = (
      <View style={{ gap: SPACE.sm }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonRow key={i} />
        ))}
      </View>
    );
  } else if (ov.error && !ov.entries.length) {
    empty = <EmptyState tone="danger" icon="cloud-offline-outline" title="Error loading runs" message={ov.error} actionLabel="Retry" onAction={ov.load} />;
  } else if (!ov.entries.length) {
    empty = (
      <EmptyState
        icon="document-text-outline"
        title="No sub-agent runs yet"
        message="Runs appear here automatically as soon as an agent is spawned, and stay for review when they finish."
      />
    );
  } else {
    empty = <EmptyState icon="search-outline" title="No runs match your filters" actionLabel="Clear filters" onAction={ov.clearFilters} compact />;
  }

  return (
    <>
      <FlatList
        data={ov.filtered}
        keyExtractor={(e) => e.runId}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentContainerStyle={[{ paddingHorizontal: SPACE.lg, paddingBottom: DOCK_SPACE }, contentPad]}
        ItemSeparatorComponent={Sep}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={9}
        refreshControl={
          <RefreshControl refreshing={ov.loading && ov.loaded} onRefresh={ov.load} tintColor={colors.primary} colors={[colors.primary]} />
        }
      />
      <FilterSheet visible={sheet} onClose={() => setSheet(false)} ov={ov} />
    </>
  );
}

function Sep() {
  return <View style={{ height: SPACE.sm }} />;
}

export const OversightRow = memo(function OversightRow({
  entry: r,
  now,
  expanded,
  onToggle,
  onOpen,
  acked,
  onToggleAck,
  forcing,
  onForce,
  onOpenSession,
  onOpenTask,
}) {
  const { colors, type, alpha } = useUIKit();
  const sm = statusMeta(r.status);
  const c = toneColor(sm.tone, colors);
  const summary = r.review?.summary || r.task;
  const completion = r.review?.completion;
  const badge = r.remote && r.nodeName ? r.nodeName : r.coderBackend;
  const blockers = r.review?.blockers?.length || 0;

  return (
    <View
      style={[
        styles.row,
        {
          borderColor: expanded ? alpha(c, 0.55) : colors.border,
          backgroundColor: expanded ? alpha(c, 0.06) : alpha(colors.text, 0.035),
        },
      ]}
    >
      <View style={[styles.bar, { backgroundColor: c }]} />
      <Pressable
        onPress={() => onToggle(r.runId)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${r.label}, ${sm.label}`}
        style={({ pressed }) => [styles.rowMain, { opacity: pressed ? 0.85 : 1 }]}
      >
        <View style={styles.rowTop}>
          {r.status === 'running' ? <View style={[styles.liveDot, { backgroundColor: colors.info }]} /> : null}
          <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={2}>
            {r.label}
          </Text>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textTertiary} />
        </View>
        <View style={styles.rowChips}>
          <Chip label={sm.label} tone={sm.tone} size="sm" dot />
          {completion ? (
            <Chip
              label={completion.verdict}
              tone={verdictTone(completion.state)}
              size="sm"
              icon="shield-checkmark-outline"
              accessibilityLabel={`Verdict ${completion.verdict}`}
            />
          ) : null}
          {r.review?.decision && r.review.decision !== 'pending' ? (
            <Chip label={r.review.decision === 'approved' ? 'Approved' : 'Sent back'} tone={decisionTone(r.review.decision)} size="sm" />
          ) : null}
          {r.review?.drift ? <Chip label="Drift" tone="warning" size="sm" icon="warning-outline" /> : null}
          {badge ? <Chip label={badge} size="sm" /> : null}
        </View>
        <Text style={[type.caption, { color: summary ? colors.textSecondary : colors.textMuted }]} numberOfLines={2}>
          {summary || 'no brief'}
        </Text>
        <View style={styles.rowMeta}>
          {r.filesTouchedCount > 0 ? (
            <Meta icon="document-outline" text={String(r.filesTouchedCount)} label={`${r.filesTouchedCount} files touched`} />
          ) : null}
          <Meta icon="time-outline" text={fmtDuration(r.durationMs)} label="Duration" />
          {r.exitReason ? (
            <Meta icon="alert-circle" text="exit" tone="danger" label={r.exitReason} />
          ) : blockers ? (
            <Meta icon="alert-circle" text={String(blockers)} tone="danger" label={`${blockers} blockers`} />
          ) : null}
          <View style={{ flex: 1 }} />
          <Text style={[type.monoSmall, { color: colors.textMuted }]} accessibilityLabel={fmtClock(finishedAt(r))}>
            {timeAgo(finishedAt(r), now)}
          </Text>
        </View>
      </Pressable>
      {expanded ? (
        <View style={[styles.inline, { borderTopColor: colors.borderSubtle }]}>
          <View style={styles.inlineActions}>
            <Button title="Open full page" iconRight="arrow-forward" size="sm" variant="primary" onPress={() => onOpen(r.runId)} />
            <LinkButtons entry={r} onOpenSession={onOpenSession} onOpenTask={onOpenTask} onForce={onForce} forcing={forcing} />
          </View>
          <SummarySection entry={r} />
          <ExitSection entry={r} />
          <BlockersSection review={r.review} />
          <NextStepsSection review={r.review} acked={acked} onToggle={(i) => onToggleAck(r.runId, i)} />
          <TimelineSection entry={r} now={now} />
          <FilesSection files={r.review?.filesTouched} />
          <MetaSection entry={r} />
        </View>
      ) : null}
    </View>
  );
});

function Meta({ icon, text, tone, label }) {
  const { colors, type } = useUIKit();
  const c = tone ? toneColor(tone, colors) : colors.textMuted;
  return (
    <View style={styles.meta} accessibilityLabel={label}>
      <Ionicons name={icon} size={12} color={c} />
      <Text style={[type.monoSmall, { color: c }]}>{text}</Text>
    </View>
  );
}

function FilterSheet({ visible, onClose, ov }) {
  const { colors, type } = useUIKit();
  const f = ov.filters;
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Filters"
      subtitle={`${ov.filtered.length} of ${ov.entries.length} runs`}
      footer={
        <View style={styles.sheetFooter}>
          <Button title="Reset" variant="ghost" onPress={ov.resetAllFilters} />
          <Button title="Done" variant="primary" onPress={onClose} />
        </View>
      }
    >
      <Text style={[type.label, styles.sheetLabel, { color: colors.textMuted }]}>Status</Text>
      <View style={styles.wrap}>
        {OVERSIGHT_STATUSES.map((s) => (
          <Chip
            key={s}
            label={s === 'all' ? 'All statuses' : statusMeta(s).label}
            tone={s === 'all' ? 'primary' : statusMeta(s).tone}
            selected={f.status === s}
            onPress={() => ov.setFilter('status', s)}
          />
        ))}
      </View>

      <Text style={[type.label, styles.sheetLabel, { color: colors.textMuted }]}>Oversight</Text>
      <View style={styles.wrap}>
        {DECISION_FILTERS.map((d) => (
          <Chip
            key={d.key}
            label={d.label}
            tone={d.key === 'all' ? 'primary' : decisionTone(d.key)}
            selected={f.decision === d.key}
            onPress={() => ov.setFilter('decision', d.key)}
          />
        ))}
      </View>
      <Button
        title={ov.samplerRunning ? 'Sampling…' : 'Run sampler'}
        icon="refresh-outline"
        variant="outline"
        size="sm"
        loading={ov.samplerRunning}
        disabled={ov.samplerRunning}
        onPress={ov.runSampler}
        accessibilityHint="Re-sample recently-closed runs and flag drift"
        style={{ alignSelf: 'flex-start', marginTop: SPACE.sm }}
      />
      {ov.samplerLastRunAt ? (
        <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]}>Last sampled {timeAgo(ov.samplerLastRunAt, ov.now)}</Text>
      ) : null}

      <Text style={[type.label, styles.sheetLabel, { color: colors.textMuted }]}>Time range</Text>
      <View style={styles.wrap}>
        {TIME_FILTERS.map((t) => (
          <Chip key={t.key} label={t.label} tone="primary" selected={f.time === t.key} onPress={() => ov.setFilter('time', t.key)} />
        ))}
      </View>

      <Text style={[type.label, styles.sheetLabel, { color: colors.textMuted }]}>Refinements</Text>
      <ToggleRow label="Needs attention" value={f.hasBlockers} onChange={(v) => ov.setFilter('hasBlockers', v)} />

      <Text style={[type.label, styles.sheetLabel, { color: colors.textMuted }]}>Project / Task</Text>
      <Field
        value={f.project}
        onChangeText={(v) => ov.setFilter('project', v)}
        placeholder="Filter by kanban task…"
        icon="folder-outline"
        mono
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Filter by project or task"
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm },
  quick: { gap: SPACE.sm, paddingVertical: SPACE.sm },
  countRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.sm, marginBottom: SPACE.sm, minHeight: 28 },
  row: { borderWidth: 1, borderRadius: RADIUS.md, overflow: 'hidden' },
  bar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  rowMain: { paddingVertical: SPACE.sm + 2, paddingLeft: SPACE.md + 2, paddingRight: SPACE.md, gap: SPACE.xs + 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  rowChips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs + 2 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  inline: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: SPACE.md + 2, paddingBottom: SPACE.md, paddingTop: SPACE.sm },
  inlineActions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.xs },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  sheetLabel: { marginTop: SPACE.lg, marginBottom: SPACE.sm },
  sheetFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm },
});

export default OversightList;
