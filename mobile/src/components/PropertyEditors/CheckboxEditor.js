import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

export function CheckboxEditor({
  value,
  onChange,
  onSave,
  schema,
  label,
  disabled,
}) {
  const isChecked = Boolean(value);

  const handleToggle = () => {
    if (disabled) return;
    const newValue = !isChecked;
    onChange?.(newValue);
    onSave?.(newValue);
  };

  return (
    <TouchableOpacity
      style={[styles.container, disabled && styles.containerDisabled]}
      onPress={handleToggle}
      activeOpacity={0.7}
      disabled={disabled}
    >
      <View style={[
        styles.checkbox,
        isChecked && styles.checkboxChecked,
      ]}>
        {isChecked && (
          <Ionicons name="checkmark" size={16} color="#FFFFFF" />
        )}
      </View>
      
      <View style={styles.content}>
        <Text style={[styles.label, isChecked && styles.labelChecked]}>
          {label || schema?.name || 'Checkbox'}
        </Text>
        <Text style={styles.hint}>
          {isChecked ? 'Checked' : 'Unchecked'} — tap to toggle
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// Compact inline version for rows
export function CheckboxInline({
  value,
  onChange,
  onSave,
  disabled,
  size = 20,
}) {
  const isChecked = Boolean(value);

  const handleToggle = () => {
    if (disabled) return;
    const newValue = !isChecked;
    onChange?.(newValue);
    onSave?.(newValue);
  };

  return (
    <TouchableOpacity
      onPress={handleToggle}
      activeOpacity={0.7}
      disabled={disabled}
      style={[styles.inlineContainer, disabled && styles.containerDisabled]}
    >
      <View style={[
        styles.inlineCheckbox,
        { width: size, height: size, borderRadius: size / 4 },
        isChecked && styles.checkboxChecked,
      ]}>
        {isChecked && (
          <Ionicons name="checkmark" size={size * 0.7} color="#FFFFFF" />
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    backgroundColor: COLORS.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  containerDisabled: {
    opacity: 0.5,
  },
  checkbox: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.md,
  },
  checkboxChecked: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  content: {
    flex: 1,
  },
  label: {
    fontSize: 15,
    color: COLORS.text,
    fontWeight: '500',
  },
  labelChecked: {
    color: COLORS.primary,
  },
  hint: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  inlineContainer: {
    padding: 4,
  },
  inlineCheckbox: {
    borderWidth: 2,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
