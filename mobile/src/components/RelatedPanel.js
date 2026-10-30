/**
 * RelatedPanel — the mobile face of the KIS typed-relation graph (`objrel.*`).
 *
 * Given any business object `(type, id)` it loads the connected neighborhood and
 * renders the typed edges grouped by neighbor type, so you can see AND WALK
 * Client → Opportunity → Project → Task → People plus the attached Decisions /
 * Risks / Commitments / Products / Issues. That traversal is the whole point of
 * Phase 1 (spec §4/§14: create once, reference throughout).
 *
 * Two things it does that the web panel does not:
 *   · Re-roots. Tapping a neighbor pushes it onto a breadcrumb and reloads the
 *     graph around it, so you can walk the chain without leaving the sheet.
 *   · Groups by neighbor type instead of listing raw edges, because a phone
 *     can't show a wide edge table.
 *
 * What it deliberately does NOT do: invent names. `objrel.graph` returns nodes
 * as `{ type, id }` with no label, so a node shows its resolved name only when
 * the host screen can supply one via `resolveLabel(type, id)` (it has that
 * object's list loaded). Otherwise it shows the type and a monospaced short id —
 * honest rather than fabricated.
 *
 * Graceful degradation: `objrel.*` is served only after the gateway restart that
 * registers it. A rejected request renders a soft explanatory state, never a
 * crash and never a fake empty graph.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';

import {
  Card,
  ListRow,
  Divider,
  Chip,
  EmptyState,
  SkeletonRow,
  IconButton,
  useUIKit,
  SPACE,
  staggerDelay,
} from '../ui-kit';
import { useObjectRelations } from '../hooks/useObjectRelations';
import {
  OBJECT_TYPES,
  objectTypeIcon,
  objectTypeLabel,
  shortId,
} from '../kis/vocab';

/** Stable section order; any drift type the gateway introduces is appended. */
function orderedTypes(byType) {
  const known = OBJECT_TYPES.filter((t) => byType.has(t));
  const drifted = [...byType.keys()].filter((t) => !OBJECT_TYPES.includes(t)).sort();
  return [...known, ...drifted];
}

/**
 * Props
 *   sendReq       gateway.sendReq
 *   type / id     the object to root the graph at
 *   label         display name for the root (the host knows it)
 *   resolveLabel  optional fn(type, id) -> string | undefined
 *   title         panel heading (default 'Related')
 *   maxDepth      hops (default 3 — enough for Client → … → People)
 */
export function RelatedPanel({
  sendReq,
  type,
  id,
  label,
  resolveLabel,
  title = 'Related',
  maxDepth = 3,
}) {
  const { colors, type: t } = useUIKit();

  // Breadcrumb of visited roots. The first entry is the host object; tapping a
  // neighbor pushes, tapping a crumb truncates back to it.
  const [trail, setTrail] = useState([{ type, id, label }]);
  const root = trail[trail.length - 1];

  // Re-seed when the host object changes (a different row opened the sheet).
  const seed = `${type}:${id}`;
  const [seededFor, setSeededFor] = useState(seed);
  if (seededFor !== seed) {
    setSeededFor(seed);
    setTrail([{ type, id, label }]);
  }

  const { byType, count, loading, error, refresh } = useObjectRelations(
    sendReq,
    root?.type,
    root?.id,
    maxDepth,
  );

  const nameFor = useCallback(
    (node) => resolveLabel?.(node.type, node.id) || null,
    [resolveLabel],
  );

  const push = useCallback(
    (node) => {
      setTrail((prev) => {
        // Walking back to somewhere already in the trail truncates rather than
        // growing a loop — the graph is undirected when traversed.
        const existing = prev.findIndex((c) => c.type === node.type && c.id === node.id);
        if (existing >= 0) return prev.slice(0, existing + 1);
        return [...prev, { type: node.type, id: node.id, label: nameFor(node) }];
      });
    },
    [nameFor],
  );

  const truncate = useCallback((index) => {
    setTrail((prev) => prev.slice(0, index + 1));
  }, []);

  const sections = useMemo(() => orderedTypes(byType), [byType]);

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={[t.label, { color: colors.primary }]} accessibilityRole="header">
          {title}
        </Text>
        {count ? (
          <Text style={[t.monoSmall, { color: colors.textMuted }]}>{count}</Text>
        ) : null}
        <View style={styles.headSpacer} />
        <IconButton
          icon="refresh"
          size="sm"
          onPress={refresh}
          loading={loading}
          accessibilityLabel="Refresh relations"
        />
      </View>

      {trail.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.crumbs}
        >
          {trail.map((crumb, i) => (
            <Chip
              key={`${crumb.type}:${crumb.id}`}
              label={crumb.label || `${objectTypeLabel(crumb.type)} ${shortId(crumb.id)}`}
              icon={objectTypeIcon(crumb.type)}
              tone={i === trail.length - 1 ? 'primary' : 'neutral'}
              selected={i === trail.length - 1}
              onPress={i === trail.length - 1 ? undefined : () => truncate(i)}
              accessibilityLabel={
                i === trail.length - 1
                  ? `Viewing relations for ${crumb.label || objectTypeLabel(crumb.type)}`
                  : `Back to ${crumb.label || objectTypeLabel(crumb.type)}`
              }
            />
          ))}
        </ScrollView>
      ) : null}

      {error ? (
        <EmptyState
          compact
          tone="danger"
          icon="git-network-outline"
          title="Relations unavailable"
          message={`${error}\n\nThe relation graph (objrel.*) is served after the next gateway restart.`}
          actionLabel="Retry"
          onAction={refresh}
        />
      ) : loading && !count ? (
        <Card>
          <SkeletonRow />
          <Divider inset />
          <SkeletonRow />
        </Card>
      ) : !count ? (
        <EmptyState
          compact
          icon="git-network-outline"
          title="No links yet"
          message="Connect this to a client, opportunity, project, task, product, person, decision, risk or commitment and the chain shows up here."
        />
      ) : (
        sections.map((sectionType, sectionIndex) => {
          const rows = byType.get(sectionType) || [];
          return (
            <View key={sectionType} style={styles.section}>
              <View style={styles.sectionHead}>
                <Text style={[t.caption, { color: colors.textSecondary }]}>
                  {objectTypeLabel(sectionType)}
                </Text>
                <Text style={[t.monoSmall, { color: colors.textMuted }]}>{rows.length}</Text>
              </View>
              <Card animated delay={staggerDelay(sectionIndex)}>
                {rows.map((rel, i) => {
                  const resolved = nameFor(rel.node);
                  // 'out': this object <verb> the neighbor. 'in': the neighbor
                  // <verb> this object. Rendering the arrow makes the direction
                  // of a typed edge readable at a glance.
                  const subtitle =
                    rel.direction === 'out'
                      ? `→ ${rel.phrase}`
                      : `← ${rel.phrase}`;
                  return (
                    <React.Fragment key={rel.edgeId}>
                      {i > 0 && <Divider inset />}
                      <ListRow
                        icon={objectTypeIcon(rel.node.type)}
                        iconTone={rel.direction === 'out' ? 'primary' : 'info'}
                        title={resolved || objectTypeLabel(rel.node.type)}
                        subtitle={subtitle}
                        value={shortId(rel.node.id)}
                        onPress={() => push(rel.node)}
                        accessibilityLabel={`${objectTypeLabel(rel.node.type)} ${resolved || shortId(rel.node.id)}, ${subtitle}`}
                        accessibilityHint="Shows the relations around this object"
                      />
                    </React.Fragment>
                  );
                })}
              </Card>
            </View>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: SPACE.xl, gap: SPACE.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  headSpacer: { flex: 1 },
  crumbs: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.xs },
  section: { gap: SPACE.xs },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});

export default RelatedPanel;
