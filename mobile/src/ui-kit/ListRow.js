/**
 * ListRow — the dense data row. This is the workhorse of a data-dense
 * dashboard: one row = one record.
 *
 * Layout:  [leading] title / subtitle / meta-row  [value] [trailing] [chevron]
 *
 * Row height floors at 44 so the whole row is a legal tap target. Rows inside
 * a Card should be separated with <Divider inset /> rather than each carrying
 * its own border.
 *
 * Props
 *   title       string | node
 *   subtitle    string | node
 *   meta        node        chips/badges row under the subtitle
 *   leading     node        avatar / icon container (or use `icon`)
 *   icon        Ionicons name
 *   iconTone    tone NAME ('primary'|'success'|'warning'|'danger'|'info'|
 *               'accent'|'neutral') or an explicit color, for `icon`
 *   value       string      right-aligned value, MONOSPACED (it is data)
 *   valueTone   tone name or explicit color, for `value`
 *   trailing    node        replaces the value + chevron slot
 *   chevron     boolean     show the disclosure chevron (default: !!onPress)
 *   onPress / onLongPress
 *   selected    boolean     highlighted state
 *   disabled    boolean
 *   dense       boolean     tighter vertical padding for very long lists
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS, HIT } from './tokens';
import { a11yPress } from './a11y';
import { toneColor } from './Chip';
import { withAlpha } from '../theme/color-utils';

// Tone names understood by every other kit component (StatCard, Chip, Progress-
// Bar) via toneColor(). ListRow originally took raw colors here, which made it
// the one component where passing 'danger' silently produced BLACK text — 1.05:1
// on the obsidian surface, i.e. invisible. Accepting both keeps every existing
// color-passing caller working while making the tone vocabulary uniform.
const TONE_NAMES = new Set(['primary', 'accent', 'info', 'success', 'warning', 'danger', 'neutral']);

function resolveTone(tone, colors, fallback) {
  if (!tone) return fallback;
  return TONE_NAMES.has(tone) ? toneColor(tone, colors) : tone;
}

export function ListRow({
  title,
  subtitle,
  meta,
  leading,
  icon,
  iconTone,
  value,
  valueTone,
  trailing,
  chevron,
  onPress,
  onLongPress,
  selected = false,
  disabled = false,
  dense = false,
  style,
  accessibilityLabel,
  accessibilityHint,
  testID,
}) {
  const { colors, type } = useUIKit();
  const showChevron = chevron === undefined ? !!onPress : chevron;
  const iconColor = resolveTone(iconTone, colors, colors.primary);
  const valueColor = resolveTone(valueTone, colors, colors.textSecondary);

  const body = (pressed) => (
    <View
      style={[
        styles.row,
        {
          paddingVertical: dense ? SPACE.sm : SPACE.md,
          paddingHorizontal: SPACE.md,
          backgroundColor: selected
            ? withAlpha(colors.primary, 0.1)
            : pressed
              ? withAlpha(colors.text || '#fff', 0.05)
              : 'transparent',
          borderRadius: RADIUS.sm,
        },
        disabled && styles.disabled,
        style,
      ]}
    >
      {leading
        || (icon ? (
          <View
            style={[
              styles.iconWrap,
              {
                backgroundColor: withAlpha(iconColor, 0.12),
                borderColor: withAlpha(iconColor, 0.24),
              },
            ]}
          >
            <Ionicons name={icon} size={17} color={iconColor} />
          </View>
        ) : null)}

      <View style={styles.textCol}>
        {typeof title === 'string' ? (
          <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>
            {title}
          </Text>
        ) : (
          title
        )}
        {typeof subtitle === 'string' ? (
          <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
        {meta ? <View style={styles.metaRow}>{meta}</View> : null}
      </View>

      {trailing
        || (value !== undefined && value !== null ? (
          <Text
            style={[type.mono, { color: valueColor }]}
            numberOfLines={1}
          >
            {value}
          </Text>
        ) : null)}

      {showChevron ? (
        // textTertiary (3.55:1) is below the 4.5:1 text threshold but above
        // the 3:1 non-text threshold — legal for a disclosure glyph, never text.
        <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
      ) : null}
    </View>
  );

  if (!onPress && !onLongPress) {
    return (
      <View style={styles.minH} testID={testID}>
        {body(false)}
      </View>
    );
  }

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onLongPress={disabled ? undefined : onLongPress}
      disabled={disabled}
      style={styles.minH}
      testID={testID}
      {...a11yPress({
        label: accessibilityLabel || (typeof title === 'string' ? title : undefined),
        hint: accessibilityHint || (typeof subtitle === 'string' ? subtitle : undefined),
        disabled,
        selected: selected || undefined,
      })}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  minH: { minHeight: HIT.min, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: HIT.min },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: { flex: 1, gap: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, flexWrap: 'wrap', marginTop: 2 },
  disabled: { opacity: 0.45 },
});

export default ListRow;
