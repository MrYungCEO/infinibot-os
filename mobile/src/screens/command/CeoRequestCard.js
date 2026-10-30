/**
 * §17 CEO REQUEST FORMAT — one queued decision, rendered so the CEO's
 * involvement is efficient.
 *
 * The format is the point. Every card answers the same six things in the same
 * order, so the CEO reads the shape rather than the prose:
 *
 *   Decision Required · Why now · Options · Operations Recommendation ·
 *   Needed by · Impact if delayed
 *
 * Fields the operator hasn't authored are DERIVED from a real signal on the
 * record (see command-shared.deriveWhyNow / deriveImpact) and rendered muted +
 * italic, so a derived line can never be mistaken for a considered one.
 *
 * The trigger chips at the top name why this reached the CEO at all (§16) —
 * they come from the gateway's own trigger evaluation, not a client guess.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import { Card, Chip, PriorityChip, SPACE, useUIKit } from '../../ui-kit';
import {
  deriveImpact,
  deriveWhyNow,
  fmtIsoDue,
  isDerived,
  isoIsPast,
  parseOptions,
  triggerLabels,
} from './command-shared';

function Field({ label, value, derived = false, children }) {
  const { colors, type } = useUIKit();
  return (
    <View style={styles.field}>
      <Text style={[type.label, { color: colors.textSecondary }]}>{label}</Text>
      {children || (
        <Text
          style={[
            type.body,
            { color: derived ? colors.textMuted : colors.text },
            derived && styles.derived,
          ]}
        >
          {value || '—'}
        </Text>
      )}
    </View>
  );
}

export function CeoRequestCard({ decision }) {
  const { colors, type } = useUIKit();
  const labels = triggerLabels(decision);
  const whyNow = deriveWhyNow(decision);
  const impact = deriveImpact(decision, labels);
  const options = parseOptions(decision?.options);
  const overdue = isoIsPast(decision?.decisionDeadline);

  return (
    <Card tint="accent" depth={2} padded={SPACE.md} style={styles.card}>
      {/* §16 — why this reached the CEO */}
      <View style={styles.chipRow}>
        {labels.length ? (
          labels.map((l) => <Chip key={l} label={l} tone="warning" size="sm" />)
        ) : (
          <Chip label="CEO review" tone="warning" size="sm" />
        )}
        <PriorityChip priority={decision?.priority} size="sm" />
      </View>

      <Text style={[type.h3, { color: colors.text, marginTop: SPACE.sm }]}>
        {decision?.title || 'Decision required'}
      </Text>

      <View style={styles.fields}>
        <Field
          label="Decision Required"
          value={decision?.decisionRequired || decision?.title || 'Not stated on the record.'}
          derived={isDerived(decision?.decisionRequired || decision?.title)}
        />
        <Field label="Why now" value={whyNow} derived={isDerived(decision?.whyNow)} />

        <Field label="Options">
          {options.length ? (
            <View style={styles.options}>
              {options.map((o) => (
                <Text key={o} style={[type.body, { color: colors.text }]}>
                  {o}
                </Text>
              ))}
            </View>
          ) : (
            <Text style={[type.body, { color: colors.textMuted }, styles.derived]}>
              Options not yet enumerated.
            </Text>
          )}
        </Field>

        <Field
          label="Operations Recommendation"
          value={decision?.recommendation || 'Operations has not recorded a recommendation.'}
          derived={isDerived(decision?.recommendation)}
        />
        <Field label="Decision Needed By">
          <Text style={[type.mono, { color: overdue ? colors.error : colors.text }]}>
            {decision?.decisionDeadline
              ? `${decision.decisionDeadline} · ${fmtIsoDue(decision.decisionDeadline)}`
              : 'Not set'}
          </Text>
        </Field>
        <Field
          label="Impact if delayed"
          value={impact}
          derived={isDerived(decision?.impactIfDelayed)}
        />
      </View>

      <View style={styles.footRow}>
        {decision?.owner ? <Chip label={`owner: ${decision.owner}`} tone="neutral" size="sm" /> : null}
        {decision?.requestedBy ? (
          <Chip label={`requested by ${decision.requestedBy}`} tone="neutral" size="sm" />
        ) : null}
        {decision?.decisionDeadline ? (
          <Chip
            label={fmtIsoDue(decision.decisionDeadline)}
            tone={overdue ? 'danger' : 'primary'}
            size="sm"
          />
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: SPACE.md },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, alignItems: 'center' },
  fields: { marginTop: SPACE.md, gap: SPACE.md },
  field: { gap: SPACE.xs },
  options: { gap: SPACE.xs },
  derived: { fontStyle: 'italic' },
  footRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.md },
});

export default CeoRequestCard;
