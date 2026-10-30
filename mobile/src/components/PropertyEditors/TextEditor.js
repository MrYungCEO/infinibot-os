import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Keyboard } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

export function TextEditor({
  value,
  onChange,
  onSave,
  schema,
  placeholder,
  multiline,
  autoFocus,
  disabled,
}) {
  const [text, setText] = useState(value || '');
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef(null);
  const isTitle = schema?.type === 'title';

  useEffect(() => {
    setText(value || '');
  }, [value]);

  const handleChange = (newText) => {
    setText(newText);
    onChange?.(newText);
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (text !== value) {
      onSave?.(text);
    }
  };

  const handleClear = () => {
    setText('');
    onChange?.('');
    inputRef.current?.focus();
  };

  const handleDone = () => {
    Keyboard.dismiss();
    if (text !== value) {
      onSave?.(text);
    }
  };

  return (
    <View style={styles.container}>
      <View style={[
        styles.inputWrap,
        isFocused && styles.inputWrapFocused,
        multiline && styles.inputWrapMultiline,
        disabled && styles.inputWrapDisabled,
      ]}>
        <Ionicons
          name={isTitle ? 'text-outline' : 'document-text-outline'}
          size={16}
          color={isFocused ? COLORS.primary : COLORS.textMuted}
          style={styles.icon}
        />
        <TextInput
          ref={inputRef}
          style={[
            styles.input,
            isTitle && styles.inputTitle,
            multiline && styles.inputMultiline,
          ]}
          value={text}
          onChangeText={handleChange}
          onFocus={() => setIsFocused(true)}
          onBlur={handleBlur}
          placeholder={placeholder || `Enter ${schema?.name || 'text'}...`}
          placeholderTextColor={COLORS.textMuted}
          multiline={multiline || schema?.type === 'rich_text'}
          autoFocus={autoFocus}
          editable={!disabled}
          returnKeyType={multiline ? 'default' : 'done'}
          onSubmitEditing={multiline ? undefined : handleDone}
        />
        {text.length > 0 && !disabled && (
          <TouchableOpacity onPress={handleClear} style={styles.clearBtn}>
            <Ionicons name="close-circle" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
        )}
      </View>
      
      {multiline && (
        <View style={styles.toolbar}>
          <Text style={styles.charCount}>{text.length} characters</Text>
          <TouchableOpacity onPress={handleDone} style={styles.doneBtn}>
            <Text style={styles.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {},
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  inputWrapFocused: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.background,
  },
  inputWrapMultiline: {
    minHeight: 100,
  },
  inputWrapDisabled: {
    opacity: 0.6,
    backgroundColor: COLORS.surface,
  },
  icon: {
    marginRight: SPACING.sm,
    marginTop: 2,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: COLORS.text,
    padding: 0,
    minHeight: 24,
  },
  inputTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  inputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  clearBtn: {
    marginLeft: SPACING.xs,
    marginTop: 2,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: SPACING.xs,
    paddingHorizontal: SPACING.sm,
  },
  charCount: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  doneBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  doneBtnText: {
    fontSize: 14,
    color: COLORS.primary,
    fontWeight: '600',
  },
});
