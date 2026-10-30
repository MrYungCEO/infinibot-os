/**
 * Divider — a hairline separator.
 *
 * Uses the palette's `borderSubtle` (derived from the foreground, not gold):
 * gold hairlines are reserved for the *outer* edge of a surface. Interior
 * separators must recede.
 *
 * Props: inset (indent past a 34px leading icon), spacing, vertical, style
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';

import { useUIKit, SPACE } from './tokens';

export function Divider({ inset = false, spacing = 0, vertical = false, style }) {
  const { colors } = useUIKit();
  if (vertical) {
    return (
      <View
        style={[
          { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', backgroundColor: colors.borderSubtle, marginHorizontal: spacing },
          style,
        ]}
      />
    );
  }
  return (
    <View
      style={[
        {
          height: StyleSheet.hairlineWidth,
          backgroundColor: colors.borderSubtle,
          marginVertical: spacing,
          marginLeft: inset ? 34 + SPACE.md * 2 : 0,
        },
        style,
      ]}
    />
  );
}

export default Divider;
