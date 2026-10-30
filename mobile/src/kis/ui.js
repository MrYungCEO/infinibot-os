/**
 * Shared presentation helpers for the six KIS object screens.
 *
 * These are compositions of ui-kit primitives, not new primitives — they exist
 * so six screens render the §25 common field vocabulary (owner, priority,
 * status, next action, data quality, authority level, blocked/escalation)
 * identically, instead of each screen inventing its own layout for it.
 *
 * Everything here obeys the kit rules: no hex literals, no raw pixel gaps, no
 * text under 12px, mono for data, >=44x44 tap targets, accessibilityLabel on
 * anything interactive.
 */

import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';

import {
  Card,
  ListRow,
  Divider,
  Chip,
  StatusChip,
  PriorityChip,
  EmptyState,
  SkeletonRow,
  useUIKit,
  SPACE,
} from '../ui-kit';
import {
  AUTHORITY_LEVEL_LABELS,
  DATA_QUALITY_LABELS,
  formatAge,
  formatDate,
  isPastDue,
} from './vocab';

/**
 * The status/priority/quality chips that head every object row and detail sheet.
 * Tone mapping is owned by StatusChip/PriorityChip, never re-derived.
 *
 * Returns a FRAGMENT, not a wrapped row. `ListRow`'s `meta` slot is already a
 * `flexWrap: 'wrap'` row bounded by the row's text column; putting these chips in
 * their own View made them a single unwrappable flex item inside it, so a record
 * with four chips overflowed off the right edge instead of wrapping to a second
 * line. Standalone callers (detail sheets) wrap them in `<ChipRow>`.
 *
 * Props
 *   record   any KIS object
 *   status   override the status string (e.g. an opportunity's `stage`)
 *   extra    node — object-specific chips appended after the common ones
 *   size     'sm' | 'md'
 *   quality  boolean  show the §35 data-quality chip (default true)
 */
export function MetaChips({ record, status, extra, size = 'sm', quality = true }) {
  if (!record) return null;
  const statusValue = status !== undefined ? status : record.status;
  const dq = record.dataQuality;
  return (
    <>
      <PriorityChip priority={record.priority} size={size} />
      {statusValue ? <StatusChip status={statusValue} size={size} /> : null}
      {extra}
      {quality && dq && dq !== 'Verified' ? (
        <StatusChip status={dq} label={DATA_QUALITY_LABELS[dq] || dq} size={size} />
      ) : null}
      {record.ceoRequired ? <Chip label="CEO" tone="primary" icon="star" size={size} /> : null}
      {record.blocked ? <Chip label="Blocked" tone="danger" icon="hand-left" size={size} /> : null}
      {record.escalationRequired ? (
        <Chip label="Escalate" tone="warning" icon="arrow-up-circle" size={size} />
      ) : null}
    </>
  );
}

/**
 * A wrapping chip row for standalone chip groups (detail-sheet headers). Inside
 * a `ListRow` you do NOT need this — that slot wraps already.
 */
export function ChipRow({ children, style }) {
  return <View style={[styles.chipRow, style]}>{children}</View>;
}

/**
 * A label/value block. `rows` is `[{ label, value, tone?, icon?, mono?, onPress? }]`;
 * rows with an empty value are dropped so a sparse record doesn't render a wall
 * of blanks. Returns null when nothing survives.
 *
 * `value` goes through ListRow's right-hand slot, which is monospaced — correct
 * for ids, amounts, dates and counts. Pass `wide` for prose that needs the full
 * width (it renders as a subtitle under the label instead).
 */
export function DetailRows({ rows = [], title }) {
  const { colors, type } = useUIKit();
  const visible = rows.filter((r) => r && r.value !== undefined && r.value !== null && r.value !== '');
  if (!visible.length) return null;

  return (
    <View style={styles.block}>
      {title ? (
        <Text style={[type.label, { color: colors.textSecondary, marginBottom: SPACE.sm }]}>
          {title}
        </Text>
      ) : null}
      <Card>
        {visible.map((row, i) => (
          <React.Fragment key={row.label}>
            {i > 0 && <Divider inset />}
            {row.wide ? (
              <ListRow
                title={row.label}
                subtitle={String(row.value)}
                icon={row.icon}
                iconTone={row.tone}
                onPress={row.onPress}
                accessibilityLabel={`${row.label}: ${row.value}`}
              />
            ) : (
              <ListRow
                title={row.label}
                value={String(row.value)}
                valueTone={row.tone}
                icon={row.icon}
                iconTone={row.tone}
                onPress={row.onPress}
                accessibilityLabel={`${row.label}: ${row.value}`}
              />
            )}
          </React.Fragment>
        ))}
      </Card>
    </View>
  );
}

/**
 * The §25 common-fields block every object shares. Rendered from the record's
 * own values only — an absent field is omitted rather than defaulted, so the
 * sheet never implies data the store doesn't have.
 */
export function CommonFieldsDetail({ record }) {
  if (!record) return null;
  const nextDue = record.nextActionDate;
  return (
    <>
      <DetailRows
        title="Next action (§28)"
        rows={[
          { label: 'Next action', value: record.nextAction, wide: true, icon: 'arrow-forward-circle-outline' },
          { label: 'Action owner', value: record.nextActionOwner, icon: 'person-outline' },
          {
            label: 'Due',
            value: nextDue ? formatDate(nextDue) : '',
            tone: isPastDue(nextDue) ? 'danger' : undefined,
            icon: 'calendar-outline',
          },
        ]}
      />
      <DetailRows
        title="Ownership & governance"
        rows={[
          { label: 'Owner', value: record.owner, icon: 'shield-checkmark-outline' },
          { label: 'Supporting owner', value: record.supportingOwner, icon: 'people-outline' },
          {
            label: 'Data quality',
            value: record.dataQuality ? DATA_QUALITY_LABELS[record.dataQuality] || record.dataQuality : '',
            icon: 'ribbon-outline',
          },
          {
            label: 'Authority level',
            value: record.authorityLevel
              ? `${record.authorityLevel} · ${AUTHORITY_LEVEL_LABELS[record.authorityLevel] || ''}`.trim()
              : '',
            icon: 'lock-closed-outline',
          },
          { label: 'Blocker', value: record.blocked ? record.blocker || 'Blocked' : '', tone: 'danger', wide: true, icon: 'hand-left-outline' },
        ]}
      />
      <DetailRows
        title="Record"
        rows={[
          { label: 'ID', value: record.id, icon: 'finger-print-outline' },
          {
            label: 'Last updated',
            value: record.lastUpdated ? formatAge(record.lastUpdated) : record.updatedAt ? formatAge(record.updatedAt) : '',
            icon: 'time-outline',
          },
        ]}
      />
    </>
  );
}

/**
 * A horizontally scrolling enum picker built from filter chips — the create/edit
 * sheet equivalent of a <select>. Each chip is a Chip with onPress, so it gets
 * the kit's >=44px tap area and press feedback for free.
 *
 * Props
 *   label     string
 *   options   string[] | [{key,label}]
 *   value     current key
 *   onChange  fn(key)
 *   required  boolean — marks the label
 */
export function ChipPicker({ label, options = [], value, onChange, required = false, helper }) {
  const { colors, type } = useUIKit();
  const items = options.map((o) => (typeof o === 'string' ? { key: o, label: o } : o));

  return (
    <View style={styles.picker}>
      <Text style={[type.label, { color: colors.textSecondary }]}>
        {label}
        {required ? <Text style={{ color: colors.error }}> *</Text> : null}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pickerRow}
        keyboardShouldPersistTaps="handled"
      >
        {items.map((item) => (
          <Chip
            key={item.key}
            label={item.label}
            selected={item.key === value}
            tone={item.key === value ? 'primary' : 'neutral'}
            onPress={() => onChange?.(item.key)}
            accessibilityLabel={`${label}: ${item.label}`}
          />
        ))}
      </ScrollView>
      {helper ? <Text style={[type.caption, { color: colors.textMuted }]}>{helper}</Text> : null}
    </View>
  );
}

/**
 * The four list states every KIS screen must handle (MASTER §11): error,
 * first-load, empty, loaded. Returns a node for the first three and NULL for
 * "loaded", so the caller can write:
 *
 *   {listPlaceholder({ loading, error, count, ... }) || rows.map(...)}
 *
 * This is deliberately a PLAIN FUNCTION, not a component. As `<ListStates/>` it
 * would be a React element — always truthy — and the `||` above would swallow
 * every row while rendering an empty component. It holds no hooks of its own, so
 * calling it directly is safe.
 */
export function listPlaceholder({
  loading,
  error,
  count,
  onRetry,
  emptyIcon = 'file-tray-outline',
  emptyTitle,
  emptyMessage,
  emptyActionLabel,
  onEmptyAction,
  errorTitle,
}) {
  if (error) {
    return (
      <EmptyState
        tone="danger"
        icon="alert-circle-outline"
        title={errorTitle || "Couldn't load"}
        message={`${error}\n\nIf this reads as an unknown method, the gateway needs a restart to serve these RPCs.`}
        actionLabel="Retry"
        onAction={onRetry}
      />
    );
  }
  if (loading && !count) {
    return (
      <Card>
        <SkeletonRow />
        <Divider inset />
        <SkeletonRow />
        <Divider inset />
        <SkeletonRow />
      </Card>
    );
  }
  if (!count) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        message={emptyMessage}
        actionLabel={emptyActionLabel}
        onAction={onEmptyAction}
      />
    );
  }
  return null;
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.xs },
  block: { marginTop: SPACE.lg },
  picker: { gap: SPACE.xs, marginTop: SPACE.md },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.xs },
});

export default { MetaChips, ChipRow, DetailRows, CommonFieldsDetail, ChipPicker, listPlaceholder };
