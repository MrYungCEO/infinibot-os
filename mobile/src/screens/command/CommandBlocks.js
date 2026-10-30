/**
 * The four layout primitives the Command Centers compose from.
 *
 * These are NOT new design vocabulary — every one is a thin arrangement of
 * ui-kit components (Card / Chip / Divider / SectionTitle / StatCard). They
 * exist because §15 and §18 repeat the same three shapes twenty-odd times each,
 * and hand-inlining them would be where the hex literals and raw pixel gaps
 * creep back in.
 *
 *   <Band>      a §15/§18 band header — SectionTitle with a count
 *   <Panel>     a titled Card holding several blocks
 *   <Block>     a labelled sub-group inside a Panel: chip + count + rows
 *   <Rows>      the divider-separated row list, with an honest truncation line
 *   <StatGrid>  a wrapping 2-up (or 3-up) grid of StatCards
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import {
  Card,
  Chip,
  Divider,
  SectionTitle,
  SPACE,
  useUIKit,
} from '../../ui-kit';

// ═══════════════════════════════════════════════════════════════════

/** A §15/§18 band header. Owns its own top margin (SectionTitle does). */
export function Band({ title, subtitle, count }) {
  return <SectionTitle title={title} subtitle={subtitle} count={count} />;
}

/**
 * A titled panel. `count` renders as a chip in the header so a panel's weight
 * is legible before you read a single row.
 */
export function Panel({ title, subtitle, count, countTone = 'primary', accent = false, children }) {
  const { colors, type } = useUIKit();
  return (
    <Card
      tint={accent ? 'accent' : 'primary'}
      depth={accent ? 2 : 1}
      padded={SPACE.md}
      style={styles.panel}
    >
      <View style={styles.panelHead}>
        <View style={styles.panelHeadText}>
          <Text style={[type.h3, { color: colors.text }]} accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {count !== undefined && count !== null ? (
          <Chip label={String(count)} tone={countTone} size="sm" />
        ) : null}
      </View>
      {children}
    </Card>
  );
}

/**
 * A labelled sub-group. The chip carries the label + count; the body is either
 * rows or a single muted line saying what would be here.
 */
export function Block({ title, count, tone = 'neutral', children }) {
  return (
    <View style={styles.block}>
      <View style={styles.blockHead}>
        <Chip label={title} tone={tone} size="sm" count={count} dot={!!count} />
      </View>
      {children}
    </View>
  );
}

/**
 * A divider-separated list, capped at `limit`.
 *
 * The cap is never silent: when items are held back the component says how
 * many, so a panel showing five rows can't be mistaken for the whole set.
 */
export function Rows({ items, render, empty, limit = 5, keyOf }) {
  const { colors, type } = useUIKit();
  const list = Array.isArray(items) ? items : [];

  if (!list.length) {
    return (
      <Text style={[type.caption, { color: colors.textMuted, paddingHorizontal: SPACE.md }]}>
        {empty}
      </Text>
    );
  }

  const shown = list.slice(0, limit);
  const held = list.length - shown.length;

  return (
    <View>
      {shown.map((item, i) => (
        <React.Fragment key={keyOf ? keyOf(item, i) : (item?.id ?? i)}>
          {i > 0 ? <Divider inset /> : null}
          {render(item, i)}
        </React.Fragment>
      ))}
      {held > 0 ? (
        <Text
          style={[type.caption, { color: colors.textMuted, paddingHorizontal: SPACE.md, paddingTop: SPACE.xs }]}
        >
          +{held} more not shown
        </Text>
      ) : null}
    </View>
  );
}

/** A wrapping grid of StatCards. Two up by default; three when `columns={3}`. */
export function StatGrid({ children, columns = 2 }) {
  const kids = React.Children.toArray(children);
  const basis = columns >= 3 ? '30%' : '46%';
  return (
    <View style={styles.grid}>
      {kids.map((kid, i) => (
        <View key={i} style={{ flexGrow: 1, flexBasis: basis }}>
          {kid}
        </View>
      ))}
    </View>
  );
}

/**
 * The one-line provenance footer every command surface carries: when the data
 * was derived and from what. Keeps "empty because clean" distinguishable from
 * "empty because stale" without a modal.
 */
export function Provenance({ text }) {
  const { colors, type } = useUIKit();
  return (
    <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xl, marginBottom: SPACE.md }]}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  panel: { marginBottom: SPACE.md },
  panelHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACE.sm,
    marginBottom: SPACE.xs,
  },
  panelHeadText: { flex: 1, gap: SPACE.xs },
  block: { marginTop: SPACE.md },
  blockHead: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACE.xs },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.md },
});
