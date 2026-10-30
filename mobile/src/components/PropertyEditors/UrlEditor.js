import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

export function UrlEditor({
  value,
  onChange,
  onSave,
  schema,
  placeholder,
  type = 'url', // 'url' | 'email' | 'phone'
  autoFocus,
  disabled,
}) {
  const [text, setText] = useState(value || '');
  const [isFocused, setIsFocused] = useState(false);
  const [isValid, setIsValid] = useState(true);
  const inputRef = useRef(null);

  useEffect(() => {
    setText(value || '');
    validateValue(value);
  }, [value]);

  const getConfig = () => {
    switch (type) {
      case 'email':
        return {
          icon: 'mail-outline',
          placeholder: 'email@example.com',
          keyboardType: 'email-address',
          validate: (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
          linkPrefix: 'mailto:',
          actionLabel: 'Send Email',
        };
      case 'phone':
        return {
          icon: 'call-outline',
          placeholder: '+1 (555) 123-4567',
          keyboardType: 'phone-pad',
          validate: (v) => !v || /^[\d\s\-+()]+$/.test(v),
          linkPrefix: 'tel:',
          actionLabel: 'Call',
        };
      default:
        return {
          icon: 'link-outline',
          placeholder: 'https://example.com',
          keyboardType: 'url',
          validate: (v) => !v || /^https?:\/\/.+/.test(v) || /^www\..+/.test(v),
          linkPrefix: '',
          actionLabel: 'Open Link',
        };
    }
  };

  const config = getConfig();

  const validateValue = (v) => {
    setIsValid(config.validate(v));
  };

  const handleChange = (newText) => {
    setText(newText);
    validateValue(newText);
    onChange?.(newText);
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (text !== value) {
      onSave?.(text || null);
    }
  };

  const handleClear = () => {
    setText('');
    onChange?.('');
    inputRef.current?.focus();
  };

  const handleOpen = async () => {
    if (!text || !isValid) return;
    
    let url = text;
    if (type === 'url' && !url.startsWith('http')) {
      url = 'https://' + url;
    } else if (config.linkPrefix) {
      url = config.linkPrefix + url;
    }
    
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      }
    } catch (err) {
      console.warn('Failed to open URL:', err);
    }
  };

  return (
    <View style={styles.container}>
      <View style={[
        styles.inputWrap,
        isFocused && styles.inputWrapFocused,
        !isValid && text && styles.inputWrapError,
        disabled && styles.inputWrapDisabled,
      ]}>
        <Ionicons
          name={config.icon}
          size={18}
          color={!isValid && text ? COLORS.error : isFocused ? COLORS.primary : COLORS.textMuted}
          style={styles.icon}
        />
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={text}
          onChangeText={handleChange}
          onFocus={() => setIsFocused(true)}
          onBlur={handleBlur}
          placeholder={placeholder || config.placeholder}
          placeholderTextColor={COLORS.textMuted}
          keyboardType={config.keyboardType}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={autoFocus}
          editable={!disabled}
          returnKeyType="done"
        />
        {text.length > 0 && !disabled && (
          <TouchableOpacity onPress={handleClear} style={styles.clearBtn}>
            <Ionicons name="close-circle" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
        )}
      </View>
      
      {!isValid && text && (
        <View style={styles.errorRow}>
          <Ionicons name="warning-outline" size={14} color={COLORS.error} />
          <Text style={styles.errorText}>
            {type === 'email' ? 'Invalid email format' : 
             type === 'phone' ? 'Invalid phone number' : 
             'URL should start with http:// or https://'}
          </Text>
        </View>
      )}
      
      {text && isValid && (
        <TouchableOpacity style={styles.actionBtn} onPress={handleOpen} disabled={disabled}>
          <Ionicons 
            name={type === 'email' ? 'send-outline' : type === 'phone' ? 'call-outline' : 'open-outline'} 
            size={16} 
            color={COLORS.primary} 
          />
          <Text style={styles.actionBtnText}>{config.actionLabel}</Text>
        </TouchableOpacity>
      )}
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
  inputWrapError: {
    borderColor: COLORS.error,
  },
  inputWrapDisabled: {
    opacity: 0.6,
  },
  icon: {
    marginRight: SPACING.sm,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: COLORS.text,
    padding: 0,
  },
  clearBtn: {
    marginLeft: SPACING.xs,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    gap: 4,
  },
  errorText: {
    fontSize: 12,
    color: COLORS.error,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.sm,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    gap: 6,
  },
  actionBtnText: {
    fontSize: 14,
    color: COLORS.primary,
    fontWeight: '500',
  },
});
