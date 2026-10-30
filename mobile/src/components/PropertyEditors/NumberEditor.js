import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

const FORMAT_CONFIG = {
  number: { prefix: '', suffix: '', placeholder: '0' },
  number_with_commas: { prefix: '', suffix: '', placeholder: '0' },
  percent: { prefix: '', suffix: '%', placeholder: '0' },
  dollar: { prefix: '$', suffix: '', placeholder: '0.00' },
  canadian_dollar: { prefix: 'CA$', suffix: '', placeholder: '0.00' },
  euro: { prefix: '€', suffix: '', placeholder: '0.00' },
  pound: { prefix: '£', suffix: '', placeholder: '0.00' },
  yen: { prefix: '¥', suffix: '', placeholder: '0' },
  ruble: { prefix: '₽', suffix: '', placeholder: '0' },
  rupee: { prefix: '₹', suffix: '', placeholder: '0' },
  won: { prefix: '₩', suffix: '', placeholder: '0' },
  yuan: { prefix: 'CN¥', suffix: '', placeholder: '0' },
  real: { prefix: 'R$', suffix: '', placeholder: '0.00' },
  lira: { prefix: '₺', suffix: '', placeholder: '0' },
  baht: { prefix: '฿', suffix: '', placeholder: '0' },
};

export function NumberEditor({
  value,
  onChange,
  onSave,
  schema,
  placeholder,
  autoFocus,
  disabled,
}) {
  const [text, setText] = useState(value?.toString() || '');
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef(null);

  const format = schema?.format || 'number';
  const config = FORMAT_CONFIG[format] || FORMAT_CONFIG.number;

  useEffect(() => {
    setText(value?.toString() || '');
  }, [value]);

  const parseNumber = (str) => {
    if (!str || str === '' || str === '-') return null;
    const cleaned = str.replace(/[^0-9.-]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  };

  const handleChange = (newText) => {
    // Allow digits, minus, and decimal point
    const filtered = newText.replace(/[^0-9.-]/g, '');
    setText(filtered);
    const num = parseNumber(filtered);
    onChange?.(num);
  };

  const handleBlur = () => {
    setIsFocused(false);
    const num = parseNumber(text);
    if (num !== value) {
      onSave?.(num);
    }
  };

  const handleIncrement = (delta) => {
    const current = parseNumber(text) || 0;
    const newValue = current + delta;
    setText(newValue.toString());
    onChange?.(newValue);
    onSave?.(newValue);
  };

  return (
    <View style={styles.container}>
      <View style={[
        styles.inputWrap,
        isFocused && styles.inputWrapFocused,
        disabled && styles.inputWrapDisabled,
      ]}>
        <Ionicons
          name="calculator-outline"
          size={16}
          color={isFocused ? COLORS.primary : COLORS.textMuted}
          style={styles.icon}
        />
        
        {config.prefix ? (
          <Text style={styles.affix}>{config.prefix}</Text>
        ) : null}
        
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={text}
          onChangeText={handleChange}
          onFocus={() => setIsFocused(true)}
          onBlur={handleBlur}
          placeholder={placeholder || config.placeholder}
          placeholderTextColor={COLORS.textMuted}
          keyboardType="numeric"
          autoFocus={autoFocus}
          editable={!disabled}
          returnKeyType="done"
        />
        
        {config.suffix ? (
          <Text style={styles.affix}>{config.suffix}</Text>
        ) : null}

        <View style={styles.steppers}>
          <TouchableOpacity
            onPress={() => handleIncrement(-1)}
            style={styles.stepperBtn}
            disabled={disabled}
          >
            <Ionicons name="remove" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
          <View style={styles.stepperDivider} />
          <TouchableOpacity
            onPress={() => handleIncrement(1)}
            style={styles.stepperBtn}
            disabled={disabled}
          >
            <Ionicons name="add" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.presets}>
        {[0, 10, 50, 100].map(preset => (
          <TouchableOpacity
            key={preset}
            style={styles.presetBtn}
            onPress={() => {
              setText(preset.toString());
              onChange?.(preset);
              onSave?.(preset);
            }}
            disabled={disabled}
          >
            <Text style={styles.presetText}>{config.prefix}{preset}{config.suffix}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {},
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    height: 48,
  },
  inputWrapFocused: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.background,
  },
  inputWrapDisabled: {
    opacity: 0.6,
  },
  icon: {
    marginRight: SPACING.sm,
  },
  affix: {
    fontSize: 15,
    color: COLORS.textSecondary,
    marginHorizontal: 2,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: COLORS.text,
    padding: 0,
    textAlign: 'left',
  },
  steppers: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.border + '44',
    borderRadius: 6,
    marginLeft: SPACING.sm,
    overflow: 'hidden',
  },
  stepperBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  stepperDivider: {
    width: 1,
    height: 16,
    backgroundColor: COLORS.border,
  },
  presets: {
    flexDirection: 'row',
    marginTop: SPACING.sm,
    gap: SPACING.xs,
  },
  presetBtn: {
    backgroundColor: COLORS.surface,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  presetText: {
    fontSize: 13,
    color: COLORS.textSecondary,
  },
});
