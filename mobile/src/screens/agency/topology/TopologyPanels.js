/**
 * TopologyPanels — the non-map pieces of Agency Topology: legend, "agency at a
 * glance" summary, node detail (with related records) and the list view.
 * Each mirrors a renderer in ui/src/ui/views/agency-topology.ts.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';

import {
  Button,
  Card,
  Chip,
  EmptyState,
  ListRow,
  MONO_FAMILY,
  ProgressBar,
  SectionTitle,
  Skeleton,
  StatCard,
  SPACE,
  RADIUS,
  useUIKit,
} from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import { money, relationsSummary, shapePath, statusLabel } from './topology-model';
import { toneOf } from './TopologyMap';

// ── Legend ─────────────────────────────────────────────────────────────────

function Mark({ shape, tone, colors }) {
  const c = toneOf(colors, tone);
  const common = { fill: withAlpha(c, 0.9), stroke: withAlpha(c, 0.5), strokeWidth: 1.5 };
  const d = shape === 'circle' ? null : shapePath(shape, 9, 9, shape === 'pill' ? 5 : shape === 'roundedRect' ? 5.5 : 7);
  return (
    <Svg width={18} height={18}>
      {d ? <Path d={d} {...common} /> : <Circle cx={9} cy={9} r={6.5} {...common} />}
    </Svg>
  );
}

function Swatch({ tone, colors }) {
  return (
    <Svg width={14} height={14}>
      <Rect x={0} y={3} width={14} height={8} rx={2} fill={toneOf(colors, tone)} opacity={0.9} />
    </Svg>
  );
}

const ENTITY = [
  ['hexagon', 'primary', 'Agency'],
  ['circle', 'success', 'Client'],
  ['roundedRect', 'info', 'Project'],
  ['diamond', 'primary', 'AI worker'],
  ['circle', 'info', 'Human worker'],
  ['pill', 'neutral', 'Group'],
];
const HEALTH = [
  ['success', 'active'],
  ['info', 'in flight'],
  ['warning', 'on hold / near capacity'],
  ['danger', 'past target / over capacity'],
  ['neutral', 'dormant'],
];

export function TopologyLegend({ weightBasis, dense }) {
  const { colors, type } = useUIKit();
  const item = (key, mark, label) => (
    <View key={key} style={styles.legendItem}>
      {mark}
      <Text style={[type.caption, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
  const group = (title, children) => (
    <View style={styles.legendGroup}>
      <Text style={[type.label, { color: colors.primary }]}>{title}</Text>
      <View style={styles.legendItems}>{children}</View>
    </View>
  );
  return (
    <View testID="topology-legend">
      {group('SHAPE = WHAT IT IS', ENTITY.map(([s, t, l]) => item(l, <Mark shape={s} tone={t} colors={colors} />, l)))}
      {group('COLOUR = HEALTH', HEALTH.map(([t, l]) => item(l, <Swatch tone={t} colors={colors} />, l)))}
      {group('SIZE & LINES', [
        item('r', <Ionicons name="ellipse-outline" size={14} color={colors.textMuted} />, `client radius = ${weightBasis === 'revenue' ? 'revenue' : 'project count (no revenue recorded)'}`),
        item('s', <Ionicons name="resize-outline" size={14} color={colors.textMuted} />, 'worker size = seniority'),
        item('g', <View style={[styles.line, { backgroundColor: withAlpha(colors.primary, 0.75) }]} />, 'gold elbow = reports to'),
        item('d', <View style={[styles.line, { backgroundColor: withAlpha(colors.textMuted, 0.6) }]} />, 'grey line = delivers'),
        item('a', <View style={[styles.line, { backgroundColor: withAlpha(colors.info, 0.6) }]} />, 'blue arc = assigned work'),
      ])}
      {dense ? (
        <Text style={[type.caption, { color: colors.warning, marginTop: SPACE.xs }]}>
          Dense scope: labels are hidden. Tap a node, or use the list view.
        </Text>
      ) : null}
    </View>
  );
}

// ── Summary ("Agency at a glance") ─────────────────────────────────────────

export function TopologySummary({ summary, onSelectClient, compact }) {
  const { colors, type } = useUIKit();
  const meterTone = summary.utilisation >= 100 ? 'danger' : summary.utilisation >= 85 ? 'warning' : 'success';
  return (
    <View style={{ gap: SPACE.sm }} testID="topology-summary">
      <View style={compact ? styles.statRow : null}>
        <StatCard compact={compact} style={compact ? styles.statCell : styles.statFull} label="BOOK" value={summary.book.value} unit={summary.book.unit} tone={summary.book.tone} icon="cash-outline" footnote={summary.book.context} />
        <StatCard compact={compact} style={compact ? styles.statCell : styles.statFull} label="DELIVERY" value={summary.delivery.value} tone={summary.delivery.tone} icon="rocket-outline" footnote={summary.delivery.context} />
        <StatCard compact={compact} style={compact ? styles.statCell : styles.statFull} label="WORKFORCE" value={summary.workforce.value} tone={summary.workforce.tone} icon="people-outline" footnote={summary.workforce.context} />
      </View>
      <ProgressBar value={Math.max(2, Math.min(100, summary.utilisation))} tone={meterTone} label="Average utilisation" showValue />
      {summary.topClients.length ? (
        <View>
          <SectionTitle title="Largest accounts" />
          {summary.topClients.map((c) => (
            <ListRow
              key={c.id}
              dense
              icon="business-outline"
              iconTone="success"
              title={c.name}
              value={c.meta}
              onPress={onSelectClient ? () => onSelectClient(c.id) : undefined}
              accessibilityLabel={`${c.name}, ${c.meta}`}
            />
          ))}
        </View>
      ) : null}
      <Text style={[type.caption, { color: colors.textMuted }]}>
        Pick any node on the map, or a row in the list view, to see who owns it, what it is worth and who reports to whom.
      </Text>
    </View>
  );
}

// ── Detail ─────────────────────────────────────────────────────────────────

function RelatedRecords({ relations, selection, onSelect, onRetry }) {
  const { colors, type } = useUIKit();
  if (!relations || relations.key !== `${selection.kind}:${selection.id}`) return null;
  if (relations.loading) {
    return (
      <View style={{ gap: SPACE.xs, marginTop: SPACE.md }} testID="topology-relations-loading">
        <SectionTitle title="Related records" />
        <Skeleton height={14} width="70%" />
        <Skeleton height={44} />
        <Skeleton height={44} />
      </View>
    );
  }
  if (relations.error) {
    return (
      <EmptyState compact tone="danger" icon="alert-circle-outline" title="Related records unavailable" message={relations.error} actionLabel="Retry" onAction={onRetry} />
    );
  }
  const projects = relations.projects || [];
  return (
    <View style={{ marginTop: SPACE.md }} testID="topology-relations">
      <SectionTitle title="Related records" />
      <Text style={[type.caption, { color: colors.textSecondary, marginBottom: SPACE.xs, fontFamily: MONO_FAMILY }]}>{relationsSummary(relations)}</Text>
      {relations.clientId && selection.kind === 'project' ? (
        <ListRow dense icon="arrow-up-outline" iconTone="success" title={relations.clientName || 'Client'} value="client" onPress={() => onSelect({ kind: 'client', id: relations.clientId })} accessibilityLabel={`Open client ${relations.clientName || ''}`} />
      ) : null}
      {projects.slice(0, 12).map((p) => (
        <ListRow key={p.id} dense icon="arrow-forward-outline" iconTone="info" title={p.name} value={statusLabel(p.status)} onPress={() => onSelect({ kind: 'project', id: p.id })} accessibilityLabel={`Open project ${p.name}`} />
      ))}
      {projects.length > 12 ? <Text style={[type.caption, { color: colors.textMuted }]}>+{projects.length - 12} more projects</Text> : null}
    </View>
  );
}

export function TopologyDetail({ detail, selection, focused, focusable, relations, onSelect, onFocus, onShowOnMap, onRetryRelations, onOpenOperations }) {
  const { colors, type } = useUIKit();
  if (!detail) {
    return <EmptyState compact icon="help-circle-outline" title="Not on this map any more" message="The record was removed or is outside the loaded agency. Refresh to re-read it." />;
  }
  const meter = detail.meter;
  const meterTone = meter ? (meter.percent >= 100 ? 'danger' : meter.percent >= 85 ? 'warning' : 'success') : null;
  return (
    <View testID="topology-detail">
      <View style={styles.chipRow}>
        {detail.status ? <Chip label={detail.status} tone={detail.tone} dot size="sm" /> : <Chip label={detail.kind} tone={detail.tone} dot size="sm" />}
      </View>
      {meter ? (
        <Card padded depth={0} tint={meterTone === 'success' ? 'success' : 'warning'} style={{ marginTop: SPACE.sm }}>
          <Text style={[type.label, { color: colors.textSecondary }]}>{meter.label.toUpperCase()}</Text>
          <Text style={[type.h2, { color: colors.text, fontFamily: MONO_FAMILY }]}>{Math.round(meter.percent)}%</Text>
          <ProgressBar value={Math.max(2, Math.min(100, meter.percent))} tone={meterTone} style={{ marginTop: SPACE.xs }} />
        </Card>
      ) : null}
      <View style={styles.actions}>
        {focusable ? (
          <Button size="sm" variant={focused ? 'secondary' : 'outline'} icon={focused ? 'scan-outline' : 'locate-outline'} title={focused ? 'Unfocus' : 'Focus'} onPress={onFocus} accessibilityLabel={focused ? 'Show the whole map again' : `Show only ${detail.title} and its neighbourhood`} />
        ) : null}
        {onShowOnMap ? <Button size="sm" variant="ghost" icon="map-outline" title="Show on map" onPress={onShowOnMap} accessibilityLabel={`Centre the map on ${detail.title}`} /> : null}
        {selection.kind === 'aggregate' && selection.id === 'unlinked' && onOpenOperations ? (
          <Button size="sm" variant="ghost" icon="briefcase-outline" title="Agency Operations" onPress={onOpenOperations} accessibilityLabel="Open Agency Operations to attach projects to clients" />
        ) : null}
      </View>
      <View style={[styles.rows, { borderColor: colors.borderSubtle }]}>
        {detail.rows.map(([label, value]) => (
          <View key={label} style={[styles.kv, { borderBottomColor: colors.borderSubtle }]}>
            <Text style={[type.caption, styles.kvLabel, { color: colors.textMuted }]}>{label}</Text>
            <Text style={[type.small, styles.kvValue, { color: colors.text }]} selectable>{value}</Text>
          </View>
        ))}
      </View>
      {detail.managerId ? (
        <ListRow dense icon="arrow-up-outline" iconTone="primary" title="Manager" subtitle={detail.rows.find((r) => r[0] === 'Manager')?.[1]} onPress={() => onSelect({ kind: 'worker', id: detail.managerId })} accessibilityLabel="Open manager" style={{ marginTop: SPACE.sm }} />
      ) : null}
      {detail.reports?.length ? (
        <View style={{ marginTop: SPACE.sm }}>
          <SectionTitle title="Direct reports" />
          {detail.reports.map((r) => (
            <ListRow key={r.id} dense icon="arrow-down-outline" iconTone="primary" title={r.name} subtitle={r.role} onPress={() => onSelect({ kind: 'worker', id: r.id })} accessibilityLabel={`Open ${r.name}`} />
          ))}
        </View>
      ) : null}
      {detail.projects?.length ? (
        <View style={{ marginTop: SPACE.sm }}>
          <SectionTitle title="Unassigned projects" />
          {detail.projects.slice(0, 30).map((p) => (
            <ListRow key={p.id} dense icon="cube-outline" iconTone="warning" title={p.name} value={statusLabel(p.status)} onPress={() => onSelect({ kind: 'project', id: p.id })} accessibilityLabel={`Open project ${p.name}`} />
          ))}
        </View>
      ) : null}
      {selection.kind === 'client' || selection.kind === 'project' ? (
        <RelatedRecords relations={relations} selection={selection} onSelect={onSelect} onRetry={onRetryRelations} />
      ) : null}
    </View>
  );
}

// ── List view ──────────────────────────────────────────────────────────────

const tagTone = (tone) => (tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : tone === 'success' ? 'success' : 'info');

export function TopologyList({ list, selectedKey, totalClients, totalWorkers, scopeLabel, search, onSelect }) {
  const { colors, type } = useUIKit();
  return (
    <View style={{ gap: SPACE.md }} testID="topology-list">
      <Card padded>
        <View style={styles.panelHead}>
          <Text style={[type.h3, { color: colors.text }]}>Clients & delivery</Text>
          <Text style={[type.caption, { color: colors.textMuted, fontFamily: MONO_FAMILY }]}>{list.clients.length} shown</Text>
        </View>
        {list.clients.length === 0 ? (
          <EmptyState
            compact
            icon="business-outline"
            title="No clients in this scope"
            message={totalClients ? `The book has ${totalClients} clients but none match “${search.trim() || scopeLabel}”. Widen the scope or clear the search.` : 'Add your first client in Agency Operations, Clients to populate the map.'}
          />
        ) : (
          list.clients.map(({ client, projects }) => (
            <View key={client.id}>
              <ListRow
                dense
                icon="business-outline"
                iconTone={client.status === 'active' ? 'success' : client.status === 'prospect' ? 'info' : 'neutral'}
                title={client.name}
                subtitle={`${client.projectCount} projects · ${money(client.mrrCents)} MRR · ${money(client.outstandingCents)} outstanding`}
                meta={<Chip label={client.pipelineStatusLabel || client.status} tone={client.status === 'active' ? 'success' : 'neutral'} size="sm" />}
                selected={selectedKey === `client:${client.id}`}
                onPress={() => onSelect({ kind: 'client', id: client.id })}
                accessibilityLabel={`Client ${client.name}`}
              />
              {projects.map(({ project, tone, health }) => (
                <ListRow
                  key={project.id}
                  dense
                  style={styles.indent1}
                  icon="cube-outline"
                  iconTone={tagTone(tone)}
                  title={project.name}
                  meta={<Chip label={health} tone={tagTone(tone)} size="sm" />}
                  selected={selectedKey === `project:${project.id}`}
                  onPress={() => onSelect({ kind: 'project', id: project.id })}
                  accessibilityLabel={`Project ${project.name}, ${health}`}
                />
              ))}
            </View>
          ))
        )}
        {list.unlinked.length ? (
          <View style={{ marginTop: SPACE.sm }}>
            <Text style={[type.caption, { color: colors.textSecondary, marginBottom: SPACE.xs }]}>
              {list.unlinked.length} projects are not linked to a client. They hang off the agency:
            </Text>
            {list.unlinked.map(({ project }) => (
              <ListRow
                key={project.id}
                dense
                icon="cube-outline"
                iconTone="warning"
                title={project.name}
                subtitle={statusLabel(project.status)}
                meta={<Chip label="unlinked" tone="warning" size="sm" />}
                selected={selectedKey === `project:${project.id}`}
                onPress={() => onSelect({ kind: 'project', id: project.id })}
                accessibilityLabel={`Unlinked project ${project.name}`}
              />
            ))}
          </View>
        ) : null}
      </Card>

      <Card padded>
        <View style={styles.panelHead}>
          <Text style={[type.h3, { color: colors.text }]}>Reporting lines</Text>
          <Text style={[type.caption, { color: colors.textMuted, fontFamily: MONO_FAMILY }]}>{list.workers.length} workers</Text>
        </View>
        {list.workers.length === 0 ? (
          <EmptyState
            compact
            icon="people-outline"
            title="No workforce in view"
            message={totalWorkers ? 'The workforce layer is hidden or focused. Clear the focus to see everyone.' : 'Hire a human or AI worker in Agency Operations, Employees; managers set there become the reporting lines drawn here.'}
          />
        ) : (
          list.workers.map(({ worker, depth, tone, dim }) => (
            <View key={worker.id} style={[{ marginLeft: Math.min(depth, 4) * SPACE.lg, opacity: dim ? 0.4 : 1 }, depth ? styles.treeLine : null, depth ? { borderLeftColor: withAlpha(colors.primary, 0.35) } : null]}>
              <ListRow
                dense
                icon={worker.kind === 'ai' ? 'sparkles-outline' : 'person-outline'}
                iconTone={worker.kind === 'ai' ? 'primary' : 'info'}
                title={worker.name}
                subtitle={`${worker.role} · ${worker.department}`}
                value={`${Math.round(worker.utilizationPercent)}%`}
                valueTone={tagTone(tone === 'neutral' ? 'success' : tone)}
                selected={selectedKey === `worker:${worker.id}`}
                onPress={() => onSelect({ kind: 'worker', id: worker.id })}
                accessibilityLabel={`${worker.kind === 'ai' ? 'AI' : 'Human'} worker ${worker.name}, ${Math.round(worker.utilizationPercent)} percent utilised`}
              />
            </View>
          ))
        )}
      </Card>
    </View>
  );
}

// ── Small shared bits ──────────────────────────────────────────────────────

export function FailureBanner({ failures, expanded, onToggle }) {
  const { colors, type } = useUIKit();
  if (!failures.length) return null;
  return (
    <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel={`${failures.length} requests failed, this map is incomplete. Tap for details`} style={[styles.banner, { borderColor: withAlpha(colors.warning, 0.45), backgroundColor: withAlpha(colors.warning, 0.08) }]} testID="topology-failures">
      <View style={styles.bannerHead}>
        <Ionicons name="warning-outline" size={16} color={colors.warning} />
        <Text style={[type.smallStrong, { color: colors.warning, flex: 1 }]}>{failures.length} request{failures.length === 1 ? '' : 's'} failed. This map is incomplete.</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.warning} />
      </View>
      {expanded ? failures.map((f) => <Text key={f} style={[type.caption, { color: colors.textSecondary, fontFamily: MONO_FAMILY, marginTop: 4 }]}>{f}</Text>) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  legendGroup: { marginBottom: SPACE.sm },
  legendItems: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.md, rowGap: 4, marginTop: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 20 },
  line: { width: 16, height: 2, borderRadius: 1 },
  statRow: { flexDirection: 'row', gap: SPACE.sm },
  statCell: { flex: 1, minWidth: 0 },
  statFull: { marginBottom: SPACE.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.md },
  rows: { marginTop: SPACE.md, borderTopWidth: StyleSheet.hairlineWidth },
  kv: { flexDirection: 'row', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: SPACE.md },
  kvLabel: { width: 104 },
  kvValue: { flex: 1 },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACE.sm },
  indent1: { marginLeft: SPACE.xl },
  treeLine: { borderLeftWidth: 1, paddingLeft: SPACE.xs },
  banner: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, minHeight: 44 },
  bannerHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
});
