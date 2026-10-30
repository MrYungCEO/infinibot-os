/**
 * Shared building blocks for the native Daily Operations screen: the glass
 * panel with its header row, tone notes/banners, the option-picker sheet that
 * stands in for the web <select>s, and the compact KPI tile.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  Card,
  Button,
  Chip,
  BottomSheet,
  EmptyState,
  useUIKit,
  SPACE,
  RADIUS,
  HIT,
  a11yPress,
  toneColor,
} from '../../../ui-kit';

/** A web `.agx-panel`: title + count on the left, one action on the right. */
export function Panel({ title, count, action, children, style, tint, testID }) {
  const { colors, type, alpha } = useUIKit();
  return (
    <Card padded={false} tint={tint} style={[styles.panel, style]} testID={testID}>
      <View style={[styles.panelHead, { borderBottomColor: colors.borderSubtle || colors.border }]}>
        <View style={styles.panelTitleRow}>
          <View style={[styles.goldDot, { backgroundColor: colors.primary }]} />
          <Text style={[type.h3, { color: colors.text, flex: 1 }]} numberOfLines={2}>
            {title}
          </Text>
          {action || null}
        </View>
        {count !== undefined && count !== null && count !== '' ? (
          <View style={[styles.countPill, { borderColor: alpha(colors.primary, 0.5) }]}>
            <Text style={[type.monoSmall, { color: colors.primary }]} numberOfLines={1}>
              {count}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.panelBody}>{children}</View>
    </Card>
  );
}

/** A tone banner (`.agx-note`, `.agx-banner`, `.agx-notice`). */
export function Note({ tone = 'neutral', icon, title, children, onDismiss, dismissLabel = 'Dismiss', style }) {
  const { colors, type, alpha } = useUIKit();
  const c = tone === 'neutral' ? colors.textMuted : toneColor(tone, colors);
  const textColor = tone === 'neutral' ? colors.textSecondary : colors.text;
  return (
    <View
      style={[
        styles.note,
        { borderColor: alpha(c, 0.45), backgroundColor: alpha(c, tone === 'neutral' ? 0.06 : 0.1) },
        style,
      ]}
      accessibilityRole={tone === 'danger' ? 'alert' : 'text'}
    >
      {icon ? <Ionicons name={icon} size={16} color={c} style={{ marginTop: 1 }} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        {title ? <Text style={[type.smallStrong, { color: colors.text }]}>{title}</Text> : null}
        {typeof children === 'string' ? (
          <Text style={[type.small, { color: textColor }]}>{children}</Text>
        ) : (
          children
        )}
      </View>
      {onDismiss ? (
        <Pressable
          onPress={onDismiss}
          hitSlop={HIT.slop}
          style={styles.noteClose}
          {...a11yPress({ label: dismissLabel, role: 'button' })}
        >
          <Ionicons name="close" size={16} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A labelled row of option chips — the native stand-in for a short <select>. */
export function ChipPicker({ label, options, value, onChange, disabled }) {
  const { colors, type } = useUIKit();
  return (
    <View style={{ gap: SPACE.xs }}>
      {label ? <Text style={[type.label, { color: colors.textMuted }]}>{label}</Text> : null}
      <View style={styles.chipRow}>
        {options.map((o) => {
          const opt = typeof o === 'string' ? { key: o, label: o } : o;
          return (
            <Chip
              key={String(opt.key)}
              label={opt.label}
              tone={opt.tone || 'primary'}
              selected={Array.isArray(value) ? value.includes(opt.key) : value === opt.key}
              onPress={disabled ? undefined : () => onChange(opt.key)}
              accessibilityLabel={`${label ? `${label}: ` : ''}${opt.label}`}
            />
          );
        })}
      </View>
    </View>
  );
}

/** A tappable field that opens an OptionSheet (long <select>s: workers, projects). */
export function SelectField({ label, valueLabel, placeholder = 'Choose…', onPress, disabled }) {
  const { colors, type } = useUIKit();
  return (
    <View style={{ gap: SPACE.xs }}>
      {label ? <Text style={[type.label, { color: colors.textMuted }]}>{label}</Text> : null}
      <Pressable
        onPress={disabled ? undefined : onPress}
        style={({ pressed }) => [
          styles.select,
          {
            borderColor: colors.border,
            backgroundColor: colors.inputBg || colors.surface,
            opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
          },
        ]}
        {...a11yPress({ label: `${label || 'Select'}: ${valueLabel || placeholder}`, role: 'button', disabled })}
      >
        <Text
          style={[type.body, { color: valueLabel ? colors.text : colors.textMuted, flex: 1 }]}
          numberOfLines={1}
        >
          {valueLabel || placeholder}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

/** Generic single-choice picker sheet. options: [{key,label,sub?,icon?,tone?,disabled?}] */
export function OptionSheet({ visible, onClose, title, subtitle, options, value, onSelect, footer }) {
  const { colors, type, alpha } = useUIKit();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} subtitle={subtitle} footer={footer}>
      <View style={{ gap: SPACE.xs }}>
        {(options || []).map((opt) => {
          const on = opt.key === value;
          const tc = opt.tone ? toneColor(opt.tone, colors) : colors.primary;
          return (
            <Pressable
              key={String(opt.key)}
              disabled={opt.disabled}
              onPress={() => {
                onSelect(opt.key);
              }}
              style={({ pressed }) => [
                styles.option,
                {
                  borderColor: on ? alpha(colors.primary, 0.6) : colors.borderSubtle || colors.border,
                  backgroundColor: on ? alpha(colors.primary, 0.1) : pressed ? alpha(colors.text, 0.06) : 'transparent',
                  opacity: opt.disabled ? 0.45 : 1,
                },
              ]}
              {...a11yPress({ label: opt.label, role: 'button', selected: on, disabled: opt.disabled })}
            >
              {opt.icon ? <Ionicons name={opt.icon} size={18} color={tc} /> : null}
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={2}>
                  {opt.label}
                </Text>
                {opt.sub ? (
                  <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={3}>
                    {opt.sub}
                  </Text>
                ) : null}
              </View>
              {on ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
            </Pressable>
          );
        })}
      </View>
    </BottomSheet>
  );
}

/** The web `.agx-kpi` tile — label, mono numeral, context; zeros dim. */
export function KpiTile({ label, value, context, tone, dim, style }) {
  const { colors, type, alpha } = useUIKit();
  const c = tone ? toneColor(tone, colors) : colors.primary;
  return (
    <Card padded={false} depth={1} style={[styles.kpi, { opacity: dim ? 0.62 : 1 }, style]}>
      <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[type.metric, { color: dim ? colors.textSecondary : tone ? c : colors.text }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      {context ? (
        <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>
          {context}
        </Text>
      ) : null}
      {tone && !dim ? <View style={[styles.kpiEdge, { backgroundColor: alpha(c, 0.7) }]} /> : null}
    </Card>
  );
}

/** Compact empty state used inside panels (glyph + why + the one action). */
export function PanelEmpty({ icon, title, message, actionLabel, onAction, secondaryLabel, onSecondary }) {
  return (
    <EmptyState
      compact
      icon={icon}
      title={title}
      message={message}
      actionLabel={actionLabel}
      onAction={onAction}
      secondaryLabel={secondaryLabel}
      onSecondary={onSecondary}
    />
  );
}

/** Key/value list (`<dl>` in the web modals). */
export function DefList({ rows }) {
  const { colors, type } = useUIKit();
  return (
    <View style={{ gap: SPACE.xs }}>
      {rows
        .filter((r) => r && r.value !== undefined && r.value !== null && r.value !== '')
        .map((r) => (
          <View key={r.label} style={styles.defRow}>
            <Text style={[type.caption, { color: colors.textMuted, width: 104 }]}>{r.label}</Text>
            <Text style={[r.mono ? type.mono : type.small, { color: colors.text, flex: 1 }]}>{r.value}</Text>
          </View>
        ))}
    </View>
  );
}

export function PanelAction({ title, icon = 'add', onPress, disabled, accessibilityLabel, variant = 'outline' }) {
  return (
    <Button
      title={title}
      icon={icon}
      size="sm"
      variant={variant}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel || title}
    />
  );
}

export const styles = StyleSheet.create({
  panel: { overflow: 'hidden' },
  panelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 36 },
  panelHead: {
    gap: SPACE.xs,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  panelBody: { padding: SPACE.md, gap: SPACE.sm },
  goldDot: { width: 6, height: 6, borderRadius: 3 },
  countPill: {
    alignSelf: 'flex-start',
    marginLeft: 14,
    borderWidth: 1,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACE.sm,
    paddingVertical: 2,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACE.sm,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    padding: SPACE.md,
  },
  noteClose: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  select: {
    minHeight: HIT.min,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACE.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
  },
  option: {
    minHeight: HIT.min + 4,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.md,
  },
  kpi: { padding: SPACE.md, gap: 2, overflow: 'hidden' },
  kpiEdge: { position: 'absolute', left: 0, top: SPACE.md, bottom: SPACE.md, width: 2, borderRadius: 1 },
  defRow: { flexDirection: 'row', gap: SPACE.sm, alignItems: 'flex-start' },
});
