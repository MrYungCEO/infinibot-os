/**
 * Learn › Tracks — hero stats + search, Day-1 missions, Recommended next,
 * filter chips, core tracks and plugin tracks grouped under their plugin.
 * (web: renderHero / renderCatalog / renderMissionsStrip in views/learn.ts)
 */
import React from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, Card, Chip, Button, Field, SectionTitle, EmptyState } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { FILTERS, LEVEL_LABEL, LEVEL_TONE, trackStatus, trackMinutes, pluginAccent } from './learn-model';
import { Ring, Monogram } from './parts';

export function HeroCard({ stats, query, onQuery, onResume, source }) {
  const { colors, type } = useUIKit();
  const { width } = useWindowDimensions();
  const statBasis = width >= 700 ? '22%' : '47%';
  const cells = [
    [`${stats.tracksDone}/${stats.tracksTotal}`, 'tracks complete'],
    [`${stats.walkthroughsDone}/${stats.walkthroughsTotal}`, 'walkthroughs'],
    [String(stats.badges), 'badges'],
    [stats.tierLabel, 'certification'],
  ];
  return (
    <Card padded glow>
      <Text style={[type.label, { color: colors.primary }]}>Learn InfiniBot</Text>
      <Text style={[type.h2, { color: colors.text, marginTop: SPACE.xs }]}>Guided walkthroughs over the real app</Text>
      <Text style={[type.small, { color: colors.textSecondary, marginTop: SPACE.xs }]}>
        Every track opens the right page, points at the real controls and waits for you to try them. Risky actions (trades,
        transactions, sends) are explained, never performed.
      </Text>
      <View style={styles.stats} accessibilityRole="list">
        {cells.map(([v, l]) => (
          <View key={l} style={[styles.stat, { flexBasis: statBasis, borderColor: colors.border, backgroundColor: withAlpha(colors.text, 0.03) }]}>
            <Text style={[type.metricSmall, { color: colors.text }]}>{v}</Text>
            <Text style={[type.caption, { color: colors.textMuted }]}>{l}</Text>
          </View>
        ))}
      </View>
      {source === 'local' ? (
        <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.sm }]}>
          Progress is saved on this device until the gateway is updated to sync it.
        </Text>
      ) : null}
      <Field
        icon="search"
        value={query}
        onChangeText={onQuery}
        placeholder="Search tracks, walkthroughs, plugins…"
        accessibilityLabel="Search Learn"
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        rightIcon={query ? 'close-circle' : undefined}
        onRightPress={query ? () => onQuery('') : undefined}
        rightLabel="Clear search"
        style={{ marginTop: SPACE.md }}
      />
      {stats.inProgress ? (
        <Button
          title={`Resume · ${stats.inProgress.title}`}
          icon="play"
          variant="primary"
          onPress={() => onResume(stats.inProgress)}
          style={{ marginTop: SPACE.sm }}
          accessibilityLabel={`Resume ${stats.inProgress.title}`}
        />
      ) : null}
    </Card>
  );
}

export function MissionsStrip({ missions, onStart, onDismiss }) {
  const { colors, type } = useUIKit();
  if (!missions) return null;
  return (
    <Card padded tint="primary" style={{ marginTop: SPACE.lg }}>
      <View style={styles.rowBetween}>
        <View style={{ flex: 1 }}>
          <Text style={[type.h3, { color: colors.text }]}>Day 1 missions</Text>
          <Text style={[type.caption, { color: colors.textMuted }]}>{missions.subtitle}</Text>
        </View>
        <Button title="Don't show again" size="sm" variant="ghost" onPress={onDismiss} accessibilityLabel="Hide Day 1 missions for good" />
      </View>
      {missions.items.map((i, n) => (
        <View key={`${i.track.id}/${i.walkthrough.id}`} style={[styles.mission, { borderColor: colors.borderSubtle || colors.border }]}>
          <View
            style={[
              styles.num,
              i.done
                ? { backgroundColor: colors.success, borderColor: colors.success }
                : { borderColor: colors.primary },
            ]}
          >
            {i.done ? (
              <Ionicons name="checkmark" size={15} color={colors.background} />
            ) : (
              <Text style={[type.monoSmall, { color: colors.primary }]}>{n + 1}</Text>
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={2}>{i.walkthrough.title}</Text>
            <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
              {i.track.title} · ~{i.walkthrough.estMinutes} min
            </Text>
          </View>
          <Button
            title={i.done ? 'Replay' : 'Start'}
            size="sm"
            variant={i.done ? 'ghost' : 'outline'}
            onPress={() => onStart(i.track, i.walkthrough)}
            accessibilityLabel={`${i.done ? 'Replay' : 'Start'} ${i.walkthrough.title}`}
          />
        </View>
      ))}
    </Card>
  );
}

export function TrackCard({ track, plugin, progress, reco, onOpen }) {
  const { colors, type } = useUIKit();
  const s = trackStatus(track, progress);
  const accent = pluginAccent(plugin) || undefined;
  return (
    <Card
      padded
      tint={s.completed ? 'success' : 'neutral'}
      onPress={() => onOpen(track)}
      accessibilityLabel={`${track.title}, ${s.percent}% complete`}
      style={{ marginTop: SPACE.sm }}
    >
      <View style={styles.cardTop}>
        <Monogram plugin={plugin} pluginId={track.pluginId} />
        <View style={styles.tags}>
          <Chip label={track.category} size="sm" />
          <Chip label={LEVEL_LABEL[track.level]} tone={LEVEL_TONE[track.level]} size="sm" />
          {reco ? <Chip label="Recommended" tone="primary" size="sm" /> : null}
        </View>
        <Ring percent={s.percent} accent={accent} />
      </View>
      <Text style={[type.h3, { color: colors.text, marginTop: SPACE.sm }]}>{track.title}</Text>
      <Text style={[type.small, { color: colors.textSecondary, marginTop: 2 }]} numberOfLines={3}>{track.summary}</Text>
      <View style={[styles.rowBetween, { marginTop: SPACE.sm }]}>
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {track.walkthroughs.length} walkthroughs · ~{trackMinutes(track)} min
        </Text>
        {s.completed ? (
          <View style={styles.earned}>
            <Ionicons name="ribbon" size={14} color={colors.success} />
            <Text style={[type.caption, { color: colors.success }]} numberOfLines={1}>{track.badge?.label}</Text>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

export function CatalogTab({ view, progress, missions, onFilter, filter, onOpenTrack, onStartWalkthrough, onDismissMissions }) {
  const { colors, type } = useUIKit();
  return (
    <View>
      {!view.searching ? <MissionsStrip missions={missions} onStart={onStartWalkthrough} onDismiss={onDismissMissions} /> : null}
      {view.reco.length ? (
        <>
          <SectionTitle title="Recommended next" subtitle="Based on what you have and haven't used yet" />
          {view.reco.map((t) => (
            <TrackCard key={`r-${t.id}`} track={t} plugin={view.pluginsById.get(t.pluginId)} progress={progress} reco onOpen={onOpenTrack} />
          ))}
        </>
      ) : null}
      <View style={styles.filters} accessibilityRole="radiogroup" accessibilityLabel="Filter tracks">
        {FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            selected={filter === f.key}
            tone={filter === f.key ? 'primary' : 'neutral'}
            onPress={() => onFilter(f.key)}
            accessibilityLabel={`Filter: ${f.label}`}
          />
        ))}
      </View>
      {view.emptyText ? <EmptyState compact icon="school-outline" title="No tracks" message={view.emptyText} /> : null}
      {view.core.length ? (
        <>
          <SectionTitle title="Core tracks" count={view.core.length} subtitle="Everything built into InfiniBot" />
          {view.core.map((t) => (
            <TrackCard key={t.id} track={t} progress={progress} onOpen={onOpenTrack} />
          ))}
        </>
      ) : null}
      {view.pluginGroups.length ? (
        <>
          <SectionTitle title="Plugin tracks" subtitle="Shipped by your enabled plugins — they appear when a plugin is turned on" />
          {view.pluginGroups.map((g) => {
            const accent = pluginAccent(g.plugin) || colors.primary;
            return (
              <View key={g.pluginId} style={[styles.group, { borderColor: withAlpha(accent, 0.25), backgroundColor: withAlpha(accent, 0.04) }]}>
                <View style={styles.groupHead}>
                  <Monogram plugin={g.plugin} pluginId={g.pluginId} />
                  <View>
                    <Text style={[type.h3, { color: colors.text }]}>{g.name}</Text>
                    <Text style={[type.caption, { color: colors.textMuted }]}>
                      {g.tracks.length} track{g.tracks.length === 1 ? '' : 's'}
                    </Text>
                  </View>
                </View>
                {g.tracks.map((t) => (
                  <TrackCard key={t.id} track={t} plugin={g.plugin} progress={progress} onOpen={onOpenTrack} />
                ))}
              </View>
            );
          })}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.md },
  stat: { flexBasis: '47%', flexGrow: 1, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.sm },
  mission: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingVertical: SPACE.sm, borderTopWidth: StyleSheet.hairlineWidth, marginTop: SPACE.sm },
  num: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm },
  tags: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  earned: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, flexShrink: 1 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.xl },
  group: { marginTop: SPACE.md, padding: SPACE.md, borderRadius: RADIUS.lg, borderWidth: 1 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, marginBottom: SPACE.xs },
});
