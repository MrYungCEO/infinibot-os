/**
 * SimplePropertyEditor — Lightweight property editor for CustomerProfileScreen
 * Handles all editable Notion property types
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput,
  ScrollView, KeyboardAvoidingView, Platform, Switch
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';

// Status colors
const STATUS_COLORS = {
  default: { bg: 'rgba(107,114,128,0.15)', text: '#9ca3af' },
  gray: { bg: 'rgba(107,114,128,0.15)', text: '#9ca3af' },
  blue: { bg: 'rgba(59,130,246,0.15)', text: '#60a5fa' },
  green: { bg: 'rgba(34,197,94,0.15)', text: '#4ade80' },
  yellow: { bg: COLORS.primaryLight, text: COLORS.primary },
  orange: { bg: 'rgba(234,88,12,0.15)', text: '#fb923c' },
  red: { bg: 'rgba(239,68,68,0.15)', text: '#f87171' },
  purple: { bg: 'rgba(168,85,247,0.15)', text: '#c084fc' },
  pink: { bg: 'rgba(236,72,153,0.15)', text: '#f472b6' },
  brown: { bg: 'rgba(161,98,7,0.15)', text: '#d97706' },
};

// Text editor (for title, rich_text)
function TextEditor({ value, onChange, multiline = false, placeholder }) {
  return (
    <TextInput
      style={[styles.textInput, multiline && styles.textInputMultiline]}
      value={value || ''}
      onChangeText={onChange}
      placeholder={placeholder || 'Enter text...'}
      placeholderTextColor={COLORS.textMuted}
      multiline={multiline}
      numberOfLines={multiline ? 4 : 1}
      autoFocus
    />
  );
}

// Number editor
function NumberEditor({ value, onChange }) {
  const handleChange = (text) => {
    // Allow empty, numbers, decimals, and negatives
    if (text === '' || text === '-' || /^-?\d*\.?\d*$/.test(text)) {
      onChange(text === '' ? null : text);
    }
  };
  
  return (
    <TextInput
      style={styles.textInput}
      value={value !== null && value !== undefined ? String(value) : ''}
      onChangeText={handleChange}
      placeholder="0"
      placeholderTextColor={COLORS.textMuted}
      keyboardType="decimal-pad"
      autoFocus
    />
  );
}

// Checkbox editor
function CheckboxEditor({ value, onChange }) {
  return (
    <View style={styles.checkboxContainer}>
      <Switch
        value={!!value}
        onValueChange={onChange}
        trackColor={{ false: '#3f3f46', true: COLORS.primaryStrong }}
        thumbColor={value ? COLORS.primary : '#f4f3f4'}
      />
      <Text style={styles.checkboxLabel}>{value ? 'Checked' : 'Unchecked'}</Text>
    </View>
  );
}

// Select/Status editor
function SelectEditor({ value, onChange, options = [] }) {
  return (
    <ScrollView style={styles.optionsList}>
      {/* None option */}
      <TouchableOpacity
        style={[styles.optionItem, !value && styles.optionItemSelected]}
        onPress={() => onChange(null)}
      >
        <Text style={[styles.optionText, !value && styles.optionTextSelected]}>
          — None —
        </Text>
        {!value && <Ionicons name="checkmark" size={18} color={COLORS.primary} />}
      </TouchableOpacity>
      
      {options.map((opt) => {
        const isSelected = value === opt.name;
        const colors = STATUS_COLORS[opt.color] || STATUS_COLORS.default;
        
        return (
          <TouchableOpacity
            key={opt.name}
            style={[styles.optionItem, isSelected && styles.optionItemSelected]}
            onPress={() => onChange(opt.name)}
          >
            <View style={[styles.optionBadge, { backgroundColor: colors.bg }]}>
              <Text style={[styles.optionBadgeText, { color: colors.text }]}>
                {opt.name}
              </Text>
            </View>
            {isSelected && <Ionicons name="checkmark" size={18} color={COLORS.primary} />}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// Multi-select editor
function MultiSelectEditor({ value = [], onChange, options = [] }) {
  const toggleOption = (optName) => {
    const current = Array.isArray(value) ? value : [];
    const isSelected = current.includes(optName);
    
    if (isSelected) {
      onChange(current.filter(v => v !== optName));
    } else {
      onChange([...current, optName]);
    }
  };
  
  const currentValues = Array.isArray(value) ? value : [];
  
  return (
    <ScrollView style={styles.optionsList}>
      {options.map((opt) => {
        const isSelected = currentValues.includes(opt.name);
        const colors = STATUS_COLORS[opt.color] || STATUS_COLORS.default;
        
        return (
          <TouchableOpacity
            key={opt.name}
            style={[styles.optionItem, isSelected && styles.optionItemSelected]}
            onPress={() => toggleOption(opt.name)}
          >
            <View style={[styles.checkbox, isSelected && styles.checkboxActive]}>
              {isSelected && <Ionicons name="checkmark" size={12} color={COLORS.primary} />}
            </View>
            <View style={[styles.optionBadge, { backgroundColor: colors.bg }]}>
              <Text style={[styles.optionBadgeText, { color: colors.text }]}>
                {opt.name}
              </Text>
            </View>
          </TouchableOpacity>
        );
      })}
      
      {options.length === 0 && (
        <Text style={styles.emptyOptions}>No options available</Text>
      )}
    </ScrollView>
  );
}

// Date editor
function DateEditor({ value, onChange }) {
  const dateValue = typeof value === 'object' ? value : { start: value };
  const [startDate, setStartDate] = useState(dateValue?.start || '');
  const [endDate, setEndDate] = useState(dateValue?.end || '');
  
  const handleStartChange = (text) => {
    setStartDate(text);
    if (text && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
      onChange({ start: text, end: endDate || null });
    } else if (!text) {
      onChange(null);
    }
  };
  
  const handleEndChange = (text) => {
    setEndDate(text);
    if (startDate) {
      onChange({ start: startDate, end: text || null });
    }
  };
  
  return (
    <View style={styles.dateContainer}>
      <View style={styles.dateField}>
        <Text style={styles.dateLabel}>Start Date</Text>
        <TextInput
          style={styles.textInput}
          value={startDate}
          onChangeText={handleStartChange}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={COLORS.textMuted}
          autoFocus
        />
      </View>
      <View style={styles.dateField}>
        <Text style={styles.dateLabel}>End Date (optional)</Text>
        <TextInput
          style={styles.textInput}
          value={endDate}
          onChangeText={handleEndChange}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={COLORS.textMuted}
        />
      </View>
    </View>
  );
}

// URL/Email/Phone editor
function LinkEditor({ value, onChange, type }) {
  const getPlaceholder = () => {
    switch (type) {
      case 'url': return 'https://example.com';
      case 'email': return 'email@example.com';
      case 'phone_number': return '+1 234 567 8900';
      default: return 'Enter value...';
    }
  };
  
  const getKeyboard = () => {
    switch (type) {
      case 'email': return 'email-address';
      case 'phone_number': return 'phone-pad';
      default: return 'url';
    }
  };
  
  return (
    <TextInput
      style={styles.textInput}
      value={value || ''}
      onChangeText={onChange}
      placeholder={getPlaceholder()}
      placeholderTextColor={COLORS.textMuted}
      keyboardType={getKeyboard()}
      autoCapitalize="none"
      autoCorrect={false}
      autoFocus
    />
  );
}

// Main modal component
export function SimplePropertyEditorModal({
  visible,
  propertyName,
  propertyType,
  schema,
  value,
  onChange,
  onSave,
  onCancel,
  saving,
}) {
  const renderEditor = () => {
    switch (propertyType) {
      case 'title':
        return <TextEditor value={value} onChange={onChange} placeholder="Enter name..." />;
      
      case 'rich_text':
        return <TextEditor value={value} onChange={onChange} multiline placeholder="Enter text..." />;
      
      case 'number':
        return <NumberEditor value={value} onChange={onChange} />;
      
      case 'checkbox':
        return <CheckboxEditor value={value} onChange={onChange} />;
      
      case 'select':
      case 'status':
        return <SelectEditor value={value} onChange={onChange} options={schema?.options || []} />;
      
      case 'multi_select':
        return <MultiSelectEditor value={value} onChange={onChange} options={schema?.options || []} />;
      
      case 'date':
        return <DateEditor value={value} onChange={onChange} />;
      
      case 'url':
        return <LinkEditor value={value} onChange={onChange} type="url" />;
      
      case 'email':
        return <LinkEditor value={value} onChange={onChange} type="email" />;
      
      case 'phone_number':
        return <LinkEditor value={value} onChange={onChange} type="phone_number" />;
      
      default:
        return (
          <View style={styles.unsupportedContainer}>
            <Text style={styles.unsupportedText}>
              Editing {propertyType} properties is not supported yet
            </Text>
          </View>
        );
    }
  };
  
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.modalContainer}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={onCancel} style={styles.closeBtn}>
              <Ionicons name="close" size={24} color={COLORS.textMuted} />
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle} numberOfLines={1}>Edit {propertyName}</Text>
              <Text style={styles.headerType}>{propertyType}</Text>
            </View>
            <TouchableOpacity onPress={onSave} style={styles.saveBtn} disabled={saving}>
              <Text style={[styles.saveBtnText, saving && styles.saveBtnTextDisabled]}>
                {saving ? 'Saving...' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>
          
          {/* Editor content */}
          <View style={styles.content}>
            {renderEditor()}
          </View>
          
          {/* Actions */}
          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.confirmBtn, saving && styles.confirmBtnDisabled]} 
              onPress={onSave}
              disabled={saving}
            >
              <Text style={styles.confirmBtnText}>{saving ? 'Saving...' : 'Save Changes'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: '#0a0a0a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
    maxHeight: '80%',
  },
  
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primaryDim,
  },
  closeBtn: {
    padding: 4,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
  },
  headerType: {
    fontSize: 10,
    color: COLORS.textMuted,
    letterSpacing: 1,
    marginTop: 2,
    textTransform: 'uppercase',
  },
  saveBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  saveBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.primary,
  },
  saveBtnTextDisabled: {
    opacity: 0.5,
  },
  
  // Content
  content: {
    padding: 16,
    minHeight: 120,
  },
  
  // Text input
  textInput: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: COLORS.text,
  },
  textInputMultiline: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  
  // Checkbox
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 8,
  },
  checkboxLabel: {
    fontSize: 15,
    color: COLORS.text,
  },
  
  // Options list (select/multi-select)
  optionsList: {
    maxHeight: 300,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.03)',
  },
  optionItemSelected: {
    backgroundColor: COLORS.primaryDim,
  },
  optionText: {
    fontSize: 14,
    color: COLORS.textMuted,
  },
  optionTextSelected: {
    color: COLORS.primary,
  },
  optionBadge: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 4,
  },
  optionBadgeText: {
    fontSize: 13,
    fontWeight: '600',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  checkboxActive: {
    backgroundColor: COLORS.primaryLight,
    borderColor: COLORS.primary,
  },
  emptyOptions: {
    fontSize: 13,
    color: COLORS.textMuted,
    textAlign: 'center',
    paddingVertical: 20,
  },
  
  // Date
  dateContainer: {
    gap: 16,
  },
  dateField: {
    gap: 8,
  },
  dateLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.textMuted,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  
  // Unsupported
  unsupportedContainer: {
    alignItems: 'center',
    paddingVertical: 30,
  },
  unsupportedText: {
    fontSize: 13,
    color: COLORS.textMuted,
    textAlign: 'center',
  },
  
  // Footer
  footer: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.primaryDim,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: COLORS.primaryLight,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.primaryStrong,
  },
  confirmBtnDisabled: {
    opacity: 0.5,
  },
  confirmBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.primary,
  },
});

export default SimplePropertyEditorModal;
