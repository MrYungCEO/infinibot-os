/**
 * Shared building blocks for the native Agencies page tabs: panels, KPI grids,
 * inline select (no nested modals), the generic dialog FormSheet, notices,
 * avatars and confirm-on-second-tap buttons. Theme tokens only.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  BottomSheet,
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  RADIUS,
  SPACE,
  SegmentedControl,
  StatCard,
  useUIKit,
  MONO_FAMILY,
} from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import { DateField, DatePickerPanel } from '../../../components/DatePicker';

export function useCols(min = 2, wide = 3, breakpoint = 700) {
  const { width } = useWindowDimensions();
  return width >= breakpoint ? wide : min;
}

export function Panel({ title, eyebrow, count, subtitle, right, children, style, testID }) {
  const { colors, type } = useUIKit();
  return (
    <Card padded={SPACE.md} style={[{ marginBottom: SPACE.md }, style]} testID={testID}>
      {title || right ? (
        <View style={styles.panelHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {eyebrow ? <Text style={[type.label, { color: colors.primary }]}>{eyebrow}</Text> : null}
            {title ? (
              <View style={styles.row}>
                <Text style={[type.h3, { color: colors.text, flexShrink: 1 }]} accessibilityRole="header">{title}</Text>
                {count !== undefined && count !== null ? <Chip label={String(count)} size="sm" tone="primary" /> : null}
              </View>
            ) : null}
            {subtitle ? <Text style={[type.caption, { color: colors.textMuted, marginTop: 2 }]}>{subtitle}</Text> : null}
          </View>
          {right ? <View style={styles.headRight}>{right}</View> : null}
        </View>
      ) : null}
      {children}
    </Card>
  );
}

export function KpiGrid({ items, testID }) {
  const cols = useCols(2, 3);
  return (
    <View style={styles.grid} testID={testID}>
      {items.map((k) => (
        <View key={k.label} style={{ width: `${100 / cols}%`, padding: SPACE.xs }}>
          <StatCard compact label={k.label} value={k.value} footnote={k.context} tone={k.tone || 'primary'} />
        </View>
      ))}
    </View>
  );
}

/** A label/value cell grid (finance highlights, profile dl, migration stats). */
export function StatPairs({ pairs, cols: colsProp }) {
  const { colors, type } = useUIKit();
  const auto = useCols(2, 4);
  const cols = colsProp || auto;
  return (
    <View style={styles.grid}>
      {pairs.map((p) => (
        <View key={p.label} style={{ width: `${100 / cols}%`, padding: SPACE.xs }}>
          <View style={[styles.pair, { borderColor: p.tone ? withAlpha(toneOf(p.tone, colors), 0.45) : colors.borderSubtle, backgroundColor: withAlpha(colors.text, 0.04) }]}>
            <Text style={[type.label, { color: colors.textMuted }]} numberOfLines={1}>{p.label}</Text>
            <Text style={[type.metricSmall || type.mono, { color: p.tone ? toneOf(p.tone, colors) : colors.text }]} numberOfLines={1} adjustsFontSizeToFit>{p.value}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function toneOf(tone, colors) {
  switch (tone) {
    case 'success': return colors.success;
    case 'warning': return colors.warning;
    case 'danger': return colors.error;
    case 'info': return colors.info;
    case 'neutral': return colors.textSecondary;
    default: return colors.primary;
  }
}

export function Notice({ tone = 'info', title, text, children, icon, style }) {
  const { colors, type } = useUIKit();
  const c = toneOf(tone, colors);
  const ic = icon || (tone === 'danger' ? 'alert-circle-outline' : tone === 'warning' ? 'warning-outline' : tone === 'success' ? 'checkmark-circle-outline' : 'information-circle-outline');
  return (
    <View style={[styles.notice, { borderColor: withAlpha(c, 0.4), backgroundColor: withAlpha(c, 0.08) }, style]}>
      <Ionicons name={ic} size={16} color={c} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {title ? <Text style={[type.smallStrong, { color: colors.text }]}>{title}</Text> : null}
        {text ? <Text style={[type.caption, { color: colors.textSecondary }]}>{text}</Text> : null}
        {children}
      </View>
    </View>
  );
}

export function Avatar({ name, ai = false, size = 36 }) {
  const { colors, type } = useUIKit();
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, borderColor: withAlpha(ai ? colors.info : colors.primary, 0.55), backgroundColor: withAlpha(ai ? colors.info : colors.primary, 0.1) }]}>
      <Text style={[type.smallStrong, { color: ai ? colors.info : colors.primary, fontSize: size > 44 ? 18 : 13 }]}>{String(name ?? '?').trim().slice(0, 2).toUpperCase()}</Text>
    </View>
  );
}

export function Meta({ children, style, mono = false, numberOfLines }) {
  const { colors, type } = useUIKit();
  return <Text style={[mono ? type.monoSmall : type.caption, { color: colors.textMuted }, style]} numberOfLines={numberOfLines}>{children}</Text>;
}

export function Title({ children, style, numberOfLines = 2 }) {
  const { colors, type } = useUIKit();
  return <Text style={[type.bodyStrong, { color: colors.text }, style]} numberOfLines={numberOfLines}>{children}</Text>;
}

export function Row({ children, style, wrap = false }) {
  return <View style={[styles.row, wrap && { flexWrap: 'wrap' }, style]}>{children}</View>;
}

export function Divider() {
  const { colors } = useUIKit();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.borderSubtle, marginVertical: SPACE.sm }} />;
}

/** An item tile inside a panel (a project, invoice, work item). */
export function Tile({ children, onPress, accessibilityLabel, style, accent }) {
  const { colors } = useUIKit();
  const body = (pressed) => [
    styles.tile,
    { borderColor: accent ? withAlpha(accent, 0.45) : colors.borderSubtle, backgroundColor: withAlpha(colors.text, pressed ? 0.07 : 0.035) },
    style,
  ];
  if (!onPress) return <View style={body(false)}>{children}</View>;
  return (
    <Pressable onPress={onPress} accessibilityLabel={accessibilityLabel} accessibilityHint="Opens details" style={({ pressed }) => body(pressed)}>
      {children}
    </Pressable>
  );
}

/** Small action button with two-tap confirmation for destructive actions. */
export function ActionButton({ title, onPress, variant = 'secondary', icon, confirm = false, loading, disabled, accessibilityLabel, style, size = 'sm' }) {
  const [armed, setArmed] = useState(false);
  const label = armed ? 'Tap again to confirm' : title;
  return (
    <Button
      title={label}
      icon={icon}
      size={size}
      variant={armed ? 'danger' : variant}
      loading={loading}
      disabled={disabled}
      style={style}
      accessibilityLabel={accessibilityLabel || title}
      onPress={() => {
        if (confirm && !armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return; }
        setArmed(false);
        onPress?.();
      }}
    />
  );
}

export function Actions({ children, style }) {
  return <View style={[styles.actions, style]}>{children}</View>;
}

/**
 * Inline select: a field showing the current option; tapping expands the
 * option list in place (searchable for long lists). No nested modal, so it is
 * safe inside a BottomSheet.
 */
export function SelectField({ label, value, options, onChange, searchable, placeholder = 'Choose', compact = false, testID }) {
  const { colors, type } = useUIKit();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = options.find(([v]) => String(v) === String(value ?? ''));
  const showSearch = searchable || options.length > 12;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? options.filter(([, l]) => String(l).toLowerCase().includes(q)) : options;
    return list.slice(0, 60);
  }, [options, query]);
  const shortList = !showSearch && options.length <= 5 && options.every(([, l]) => String(l).length <= 18);
  return (
    <View style={{ gap: 6, marginBottom: compact ? 0 : SPACE.sm }} testID={testID}>
      {label ? <Text style={[type.label, { color: colors.textSecondary }]}>{label}</Text> : null}
      {shortList ? (
        <View style={[styles.row, { flexWrap: 'wrap', gap: SPACE.sm }]}>
          {options.map(([v, l]) => (
            <Chip key={String(v)} label={l} selected={String(v) === String(value ?? '')} tone={String(v) === String(value ?? '') ? 'primary' : 'neutral'} onPress={() => onChange(v)} accessibilityLabel={`${label || 'Option'}: ${l}`} />
          ))}
        </View>
      ) : (
        <>
          <Pressable
            onPress={() => setOpen((o) => !o)}
            accessibilityRole="button"
            accessibilityLabel={`${label || 'Select'}: ${current ? current[1] : placeholder}`}
            style={({ pressed }) => [styles.select, { borderColor: open ? withAlpha(colors.primary, 0.55) : colors.border, backgroundColor: pressed ? withAlpha(colors.primary, 0.08) : colors.inputBg }]}
          >
            <Text style={[type.body, { color: current ? colors.text : colors.textMuted, flex: 1 }]} numberOfLines={1}>{current ? current[1] : placeholder}</Text>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
          </Pressable>
          {open ? (
            <View style={[styles.optionList, { borderColor: colors.borderSubtle, backgroundColor: withAlpha(colors.text, 0.03) }]}>
              {showSearch ? (
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search"
                  placeholderTextColor={colors.textMuted}
                  style={[type.body, styles.search, { color: colors.text, borderColor: colors.borderSubtle }]}
                  accessibilityLabel={`Search ${label || 'options'}`}
                />
              ) : null}
              {visible.map(([v, l]) => {
                const on = String(v) === String(value ?? '');
                return (
                  <Pressable
                    key={String(v)}
                    onPress={() => { onChange(v); setOpen(false); setQuery(''); }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={String(l)}
                    style={({ pressed }) => [styles.option, { backgroundColor: on ? withAlpha(colors.primary, 0.14) : pressed ? withAlpha(colors.text, 0.06) : 'transparent' }]}
                  >
                    <Text style={[type.small, { color: on ? colors.primary : colors.text, flex: 1 }]} numberOfLines={2}>{l}</Text>
                    {on ? <Ionicons name="checkmark" size={16} color={colors.primary} /> : null}
                  </Pressable>
                );
              })}
              {options.length > visible.length && !query ? <Meta style={{ padding: SPACE.sm }}>Showing 60 of {options.length}. Search to narrow.</Meta> : null}
              {!visible.length ? <Meta style={{ padding: SPACE.sm }}>No matches.</Meta> : null}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

const WEEKDAY_CHIPS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];

function WeekdaysField({ label, value, onChange }) {
  const { colors, type } = useUIKit();
  const set = new Set(String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const toggle = (d) => {
    const next = new Set(set);
    if (next.has(d)) next.delete(d); else next.add(d);
    onChange([...next].sort((a, b) => Number(a) - Number(b)).join(','));
  };
  return (
    <View style={{ gap: 6, marginBottom: SPACE.sm }}>
      <Text style={[type.label, { color: colors.textSecondary }]}>{label}</Text>
      <View style={[styles.row, { flexWrap: 'wrap', gap: SPACE.sm }]}>
        {WEEKDAY_CHIPS.map(([d, l]) => <Chip key={d} label={l} selected={set.has(d)} tone={set.has(d) ? 'primary' : 'neutral'} onPress={() => toggle(d)} accessibilityLabel={`${l} ${set.has(d) ? 'on' : 'off'}`} />)}
      </View>
    </View>
  );
}

function AutonomyField({ label, value, options, onChange }) {
  const { colors, type } = useUIKit();
  const current = options.find((o) => String(o.level) === String(value));
  return (
    <View style={{ gap: 6, marginBottom: SPACE.sm }}>
      <Text style={[type.label, { color: colors.textSecondary }]}>{label}</Text>
      {options.map((o) => {
        const on = String(o.level) === String(value);
        const c = toneOf(o.tone, colors);
        return (
          <Pressable
            key={o.level}
            onPress={() => onChange(String(o.level))}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`Level ${o.level} ${o.label}`}
            style={({ pressed }) => [styles.autonomy, { borderColor: on ? c : colors.borderSubtle, backgroundColor: on ? withAlpha(c, 0.12) : pressed ? withAlpha(colors.text, 0.05) : 'transparent' }]}
          >
            <Text style={[type.smallStrong, { color: on ? c : colors.text }]}>L{o.level} · {o.label}</Text>
            <Text style={[type.caption, { color: colors.textMuted }]}>{o.short}</Text>
          </Pressable>
        );
      })}
      <Meta>{current?.detail ?? 'Pick a level to see what it means in practice.'}</Meta>
    </View>
  );
}

function TimeField({ label, value, onChange }) {
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ''));
  return (
    <Field
      label={label}
      value={value}
      onChangeText={onChange}
      placeholder="HH:MM"
      mono
      keyboardType="numbers-and-punctuation"
      error={value && !valid ? 'Use 24-hour HH:MM' : undefined}
      style={{ marginBottom: SPACE.sm }}
    />
  );
}

/** Renders one field spec from agency-ops-forms.dialogFields. */
export function FormField({ field, value, onChange, dateOpen, setDateOpen }) {
  const { type, colors } = useUIKit();
  switch (field.type) {
    case 'note':
      return <Meta style={{ marginBottom: SPACE.sm }}>{field.text}</Meta>;
    case 'select':
      return <SelectField label={field.label} value={value} options={field.options} searchable={field.searchable} onChange={onChange} />;
    case 'weekdays':
      return <WeekdaysField label={field.label} value={value} onChange={onChange} />;
    case 'autonomy':
      return <AutonomyField label={field.label} value={value} options={field.options} onChange={onChange} />;
    case 'time':
      return <TimeField label={field.label} value={value} onChange={onChange} />;
    case 'date':
      return (
        <View style={{ marginBottom: SPACE.sm, gap: SPACE.sm }}>
          <DateField
            label={field.label}
            date={value || null}
            allowTime={false}
            onOpen={() => setDateOpen(dateOpen === field.key ? null : field.key)}
            onChange={({ date }) => onChange(date || '')}
            testID={`aops-date-${field.key}`}
          />
          {dateOpen === field.key ? (
            <View style={[styles.optionList, { borderColor: colors.borderSubtle }]}>
              <DatePickerPanel
                date={value || null}
                allowTime={false}
                onDone={({ date }) => { onChange(date || ''); setDateOpen(null); }}
                onCancel={() => setDateOpen(null)}
              />
            </View>
          ) : null}
        </View>
      );
    case 'textarea':
      return <Field label={field.label} value={value} onChangeText={onChange} placeholder={field.placeholder} multiline rows={4} style={{ marginBottom: SPACE.sm }} />;
    default:
      return (
        <Field
          label={field.label}
          value={value}
          onChangeText={onChange}
          placeholder={field.placeholder}
          icon={field.icon}
          mono={field.type === 'number'}
          keyboardType={field.type === 'number' ? 'decimal-pad' : field.type === 'email' ? 'email-address' : field.type === 'phone' ? 'phone-pad' : 'default'}
          autoCapitalize={field.type === 'email' ? 'none' : 'sentences'}
          style={{ marginBottom: SPACE.sm }}
          inputStyle={type.body}
        />
      );
  }
}

/** The generic create/edit dialog sheet. */
export function FormSheet({ visible, title, subtitle, fields, draft, onPatch, onSubmit, onClose, saving, error, valid, submitLabel, tabs, header }) {
  const [dateOpen, setDateOpen] = useState(null);
  const tab = draft?.tab;
  const shown = tabs ? fields.filter((f) => !f.tab || f.tab === tab) : fields;
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      maxHeightRatio={0.92}
      footer={(
        <View style={styles.footer}>
          <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} accessibilityLabel="Cancel" />
          <Button title={submitLabel} onPress={onSubmit} loading={saving} disabled={!valid} style={{ flex: 1 }} accessibilityLabel={submitLabel} testID="aops-form-submit" />
        </View>
      )}
    >
      {header}
      {tabs ? (
        <SegmentedControl
          options={tabs.map(([key, label]) => ({ key, label: label.split(' ')[0] }))}
          value={tab}
          onChange={(key) => onPatch({ tab: key })}
          style={{ marginBottom: SPACE.md }}
        />
      ) : null}
      {error ? <Notice tone="danger" text={error} style={{ marginBottom: SPACE.sm }} /> : null}
      {draft ? shown.map((f) => (
        <FormField key={f.key + (f.tab || '')} field={f} value={draft[f.key]} onChange={(v) => onPatch({ [f.key]: v })} dateOpen={dateOpen} setDateOpen={setDateOpen} />
      )) : null}
    </BottomSheet>
  );
}

export function Empty({ text, icon = 'file-tray-outline', actionLabel, onAction }) {
  return <EmptyState compact icon={icon} title={text} actionLabel={actionLabel} onAction={onAction} />;
}

/** "Show more" paging for long lists without virtualisation. */
export function useShowMore(step = 20) {
  const [limit, setLimit] = useState(step);
  return { limit, more: () => setLimit((l) => l + step), reset: () => setLimit(step) };
}

export function MoreButton({ shown, total, onPress, noun = 'items' }) {
  if (shown >= total) return null;
  return <Button title={`Show more (${total - shown} more ${noun})`} variant="ghost" size="sm" onPress={onPress} accessibilityLabel={`Show more ${noun}`} />;
}

export function Mono({ children, style, tone }) {
  const { colors, type } = useUIKit();
  return <Text style={[type.monoSmall, { color: tone ? toneOf(tone, colors) : colors.textSecondary, fontFamily: MONO_FAMILY }, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  panelHead: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, marginBottom: SPACE.sm },
  headRight: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, justifyContent: 'flex-end', maxWidth: '55%' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -SPACE.xs, marginBottom: SPACE.sm },
  pair: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, gap: 2 },
  notice: { flexDirection: 'row', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, marginBottom: SPACE.sm },
  avatar: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  tile: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, marginBottom: SPACE.sm, gap: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.xs },
  select: { minHeight: 44, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  optionList: { borderWidth: 1, borderRadius: RADIUS.md, overflow: 'hidden' },
  option: { minHeight: 44, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  search: { minHeight: 44, paddingHorizontal: SPACE.md, borderBottomWidth: 1 },
  autonomy: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, minHeight: 44, gap: 2 },
  footer: { flexDirection: 'row', gap: SPACE.sm },
});
