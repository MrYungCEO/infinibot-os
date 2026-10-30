/**
 * Field / Input — labelled text input with error + helper text.
 *
 * The input box is 44px tall minimum, has a visible focus ring in the theme
 * primary, and an explicit error state (red border + message + a11y invalid).
 * `mono` switches the entry face to monospace — use it for IDs, keys, URLs,
 * ports and anything the user will visually compare character by character.
 *
 * Props
 *   label / helper / error   strings
 *   value / onChangeText     controlled input
 *   icon / rightIcon         Ionicons names; rightIcon takes onRightPress
 *   mono                     monospaced entry
 *   multiline / rows
 *   required                 renders a marker + sets a11y required
 *   disabled
 *   ...rest                  forwarded to TextInput (placeholder, keyboardType,
 *                            autoCapitalize, secureTextEntry, returnKeyType…)
 */

import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS, HIT, MONO_FAMILY } from './tokens';
import { IconButton } from './Button';
import { withAlpha } from '../theme/color-utils';

export function Field({
  label,
  helper,
  error,
  value,
  onChangeText,
  icon,
  rightIcon,
  onRightPress,
  rightLabel,
  mono = false,
  multiline = false,
  rows = 4,
  required = false,
  disabled = false,
  style,
  inputStyle,
  testID,
  ...rest
}) {
  const { colors, type } = useUIKit();
  const [focused, setFocused] = useState(false);

  const borderColor = error
    ? colors.error
    : focused
      ? withAlpha(colors.primary, 0.55)
      : colors.border;

  return (
    <View style={[styles.wrap, style]} testID={testID}>
      {label ? (
        <View style={styles.labelRow}>
          <Text style={[type.label, { color: colors.textSecondary }]} numberOfLines={1}>
            {label}
          </Text>
          {required ? <Text style={[type.label, { color: colors.error }]}>*</Text> : null}
        </View>
      ) : null}

      <View
        style={[
          styles.box,
          {
            borderColor,
            backgroundColor: colors.inputBg,
            minHeight: multiline ? rows * 20 + SPACE.lg : HIT.min,
            alignItems: multiline ? 'flex-start' : 'center',
          },
          focused && !error && styles.focusRing,
          focused && !error && { shadowColor: colors.primary },
          disabled && styles.disabled,
        ]}
      >
        {icon ? (
          <Ionicons
            name={icon}
            size={17}
            color={focused ? colors.primary : colors.textMuted}
            style={multiline ? { marginTop: 2 } : null}
          />
        ) : null}

        <TextInput
          value={value}
          onChangeText={onChangeText}
          editable={!disabled}
          multiline={multiline}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.primary}
          style={[
            styles.input,
            mono ? type.mono : type.body,
            mono ? { fontFamily: MONO_FAMILY } : null,
            { color: colors.text },
            multiline && { textAlignVertical: 'top', paddingTop: 2 },
            inputStyle,
          ]}
          accessibilityLabel={label}
          accessibilityHint={helper}
          accessibilityState={{ disabled }}
          {...rest}
        />

        {rightIcon ? (
          <IconButton
            icon={rightIcon}
            onPress={onRightPress}
            size="sm"
            accessibilityLabel={rightLabel || rightIcon}
            tone={colors.textMuted}
          />
        ) : null}
      </View>

      {error ? (
        <View style={styles.msgRow}>
          <Ionicons name="alert-circle" size={13} color={colors.error} />
          <Text style={[type.caption, { color: colors.error, flex: 1 }]}>{error}</Text>
        </View>
      ) : helper ? (
        <Text style={[type.caption, { color: colors.textMuted }]}>{helper}</Text>
      ) : null}
    </View>
  );
}

export const Input = Field;

const styles = StyleSheet.create({
  wrap: { gap: SPACE.xs },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  box: {
    flexDirection: 'row',
    gap: SPACE.sm,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderWidth: 1,
    borderRadius: RADIUS.md,
  },
  focusRing: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  input: { flex: 1, padding: 0, margin: 0 },
  disabled: { opacity: 0.5 },
  msgRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
});

export default Field;
