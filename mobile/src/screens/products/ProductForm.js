/**
 * ProductForm — the create dialog and the full property editor
 * (web: renderCreateDialog + the focus modal's inspector fields).
 * Pure presentational: the parent owns the form object and the save call.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Field, Chip, useUIKit, SPACE } from '../../ui-kit';
import {
  visibleEditFields,
  PRODUCT_TYPES,
  PRODUCT_STATUSES,
  formatType,
  formatStatus,
  typeIcon,
  typeTone,
} from './catalog-model';
import { statusChipTone } from './ProductVisuals';

function SelectChips({ label, value, options, onChange, render }) {
  const { colors, type } = useUIKit();
  // Keep a free-form value (e.g. a Notion status "GR Posted") selectable so
  // editing other fields never silently rewrites it.
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <View style={styles.selectWrap}>
      <Text style={[type.label, { color: colors.textMuted }]}>{label}</Text>
      <View style={styles.chipRow}>
        {opts.map((o) => {
          const r = render(o);
          return (
            <Chip
              key={o}
              label={r.label}
              icon={r.icon}
              dot={r.dot}
              tone={r.tone}
              selected={value === o}
              onPress={() => onChange(value === o ? '' : o)}
              accessibilityLabel={`${label} ${r.label}${value === o ? ', selected' : ''}`}
            />
          );
        })}
      </View>
    </View>
  );
}

export function ProductForm({ form, onChange, errors = {}, keys, compactRows }) {
  const fields = visibleEditFields(form.type, keys);
  const set = (k) => (v) => onChange({ ...form, [k]: v });
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.kind === 'select') {
      if (f.key === 'type') {
        out.push(
          <SelectChips
            key="type"
            label="Type"
            value={form.type}
            options={PRODUCT_TYPES}
            onChange={set('type')}
            render={(o) => ({ label: formatType(o), icon: typeIcon(o), tone: typeTone(o) })}
          />,
        );
      } else {
        out.push(
          <SelectChips
            key="status"
            label="Status"
            value={form.status}
            options={PRODUCT_STATUSES}
            onChange={set('status')}
            render={(o) => ({ label: formatStatus(o), dot: true, tone: statusChipTone(o) })}
          />,
        );
      }
      continue;
    }
    // Pair short numeric fields two-up (price/cost, inventory/weight).
    const next = fields[i + 1];
    if (f.kind === 'number' && next && next.kind === 'number' && !compactRows) {
      out.push(
        <View key={f.key} style={styles.pair}>
          <NumField f={f} form={form} set={set} errors={errors} />
          <NumField f={next} form={form} set={set} errors={errors} />
        </View>,
      );
      i++;
      continue;
    }
    if (f.kind === 'number') {
      out.push(<NumField key={f.key} f={f} form={form} set={set} errors={errors} />);
      continue;
    }
    out.push(
      <Field
        key={f.key}
        label={f.label}
        required={f.required}
        value={form[f.key] ?? ''}
        onChangeText={set(f.key)}
        error={errors[f.key]}
        mono={!!f.mono || f.kind === 'url'}
        multiline={f.kind === 'multiline'}
        rows={f.kind === 'multiline' ? 6 : undefined}
        autoCapitalize={f.kind === 'url' || f.mono ? 'none' : 'sentences'}
        autoCorrect={f.kind !== 'url' && !f.mono}
        keyboardType={f.kind === 'url' ? 'url' : 'default'}
        placeholder={
          f.key === 'name' ? 'e.g. Funnel Builder Course'
            : f.key === 'sku' ? 'e.g. FBC-001'
              : f.key === 'description' ? 'What does this product do? Who is it for? (Markdown supported)'
                : f.kind === 'url' ? 'https://…' : undefined
        }
      />,
    );
  }
  return <View style={styles.form}>{out}</View>;
}

function NumField({ f, form, set, errors }) {
  return (
    <Field
      style={{ flex: 1 }}
      label={f.label}
      value={form[f.key] ?? ''}
      onChangeText={set(f.key)}
      error={errors[f.key]}
      mono
      keyboardType="decimal-pad"
      placeholder="0.00"
    />
  );
}

const styles = StyleSheet.create({
  form: { gap: SPACE.md },
  pair: { flexDirection: 'row', gap: SPACE.sm },
  selectWrap: { gap: SPACE.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
});
