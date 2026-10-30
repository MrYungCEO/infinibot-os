import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

const NOTION_COLORS = {
  default: { bg: COLORS.surface, text: COLORS.text },
  gray: { bg: '#787774', text: '#FFFFFF' },
  brown: { bg: '#9F6B53', text: '#FFFFFF' },
  orange: { bg: '#D9730D', text: '#FFFFFF' },
  yellow: { bg: '#CB912F', text: '#FFFFFF' },
  green: { bg: '#448361', text: '#FFFFFF' },
  blue: { bg: '#337EA9', text: '#FFFFFF' },
  purple: { bg: '#9065B0', text: '#FFFFFF' },
  pink: { bg: '#C14C8A', text: '#FFFFFF' },
  red: { bg: '#D44C47', text: '#FFFFFF' },
};

function TagBadge({ option, onRemove, size = 'normal' }) {
  const color = NOTION_COLORS[option.color] || NOTION_COLORS.default;
  const isSmall = size === 'small';
  
  return (
    <View style={[
      styles.tagBadge,
      { backgroundColor: color.bg + 'CC' },
      isSmall && styles.tagBadgeSmall,
    ]}>
      <Text style={[
        styles.tagBadgeText,
        { color: color.text },
        isSmall && styles.tagBadgeTextSmall,
      ]}>
        {option.name}
      </Text>
      {onRemove && (
        <TouchableOpacity onPress={onRemove} style={styles.tagRemoveBtn}>
          <Ionicons name="close" size={isSmall ? 12 : 14} color={color.text} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function OptionCheckItem({ option, isSelected, onToggle }) {
  const color = NOTION_COLORS[option.color] || NOTION_COLORS.default;
  
  return (
    <TouchableOpacity
      style={[styles.optionItem, isSelected && styles.optionItemSelected]}
      onPress={() => onToggle(option)}
      activeOpacity={0.7}
    >
      <Ionicons
        name={isSelected ? 'checkbox' : 'square-outline'}
        size={20}
        color={isSelected ? COLORS.primary : COLORS.textMuted}
        style={styles.checkbox}
      />
      <View style={[styles.optionBadge, { backgroundColor: color.bg }]}>
        <Text style={[styles.optionBadgeText, { color: color.text }]}>{option.name}</Text>
      </View>
    </TouchableOpacity>
  );
}

export function MultiSelectEditor({
  value,
  onChange,
  onSave,
  schema,
  options: propOptions,
  allowCreate,
  disabled,
}) {
  const [search, setSearch] = useState('');

  const options = propOptions || schema?.options || [];
  
  const selectedValues = useMemo(() => {
    if (!value || !Array.isArray(value)) return [];
    return value.map(v => {
      const name = typeof v === 'string' ? v : v.name;
      const found = options.find(o => o.name === name);
      return found || { name, color: 'default' };
    });
  }, [value, options]);

  const filteredOptions = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter(o => o.name.toLowerCase().includes(q));
  }, [options, search]);

  const isSelected = (option) => {
    return selectedValues.some(v => v.name === option.name);
  };

  const handleToggle = (option) => {
    if (disabled) return;
    
    let newValues;
    if (isSelected(option)) {
      newValues = selectedValues.filter(v => v.name !== option.name);
    } else {
      newValues = [...selectedValues, { name: option.name, color: option.color, id: option.id }];
    }
    
    onChange?.(newValues);
    onSave?.(newValues);
  };

  const handleRemove = (option) => {
    if (disabled) return;
    const newValues = selectedValues.filter(v => v.name !== option.name);
    onChange?.(newValues);
    onSave?.(newValues);
  };

  const handleCreate = () => {
    if (!search.trim() || disabled) return;
    const newOption = { name: search.trim(), color: 'default' };
    const newValues = [...selectedValues, newOption];
    onChange?.(newValues);
    onSave?.(newValues);
    setSearch('');
  };

  const handleClearAll = () => {
    if (disabled) return;
    onChange?.([]);
    onSave?.([]);
  };

  const noMatch = search && filteredOptions.length === 0;

  return (
    <View style={[styles.container, disabled && styles.containerDisabled]}>
      {/* Selected tags */}
      {selectedValues.length > 0 && (
        <View style={styles.selectedSection}>
          <View style={styles.selectedHeader}>
            <Text style={styles.selectedLabel}>{selectedValues.length} selected</Text>
            <TouchableOpacity onPress={handleClearAll} disabled={disabled}>
              <Text style={styles.clearAllText}>Clear all</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.selectedTags}>
            {selectedValues.map(v => (
              <TagBadge
                key={v.name}
                option={v}
                onRemove={disabled ? null : () => handleRemove(v)}
              />
            ))}
          </View>
        </View>
      )}

      {/* Search / filter */}
      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={16} color={COLORS.textMuted} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search or add options..."
          placeholderTextColor={COLORS.textMuted}
          editable={!disabled}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Options list */}
      <ScrollView style={styles.optionsList} nestedScrollEnabled>
        {filteredOptions.map(option => (
          <OptionCheckItem
            key={option.id || option.name}
            option={option}
            isSelected={isSelected(option)}
            onToggle={handleToggle}
          />
        ))}
        
        {noMatch && allowCreate !== false && (
          <TouchableOpacity style={styles.createOption} onPress={handleCreate} disabled={disabled}>
            <Ionicons name="add-circle-outline" size={18} color={COLORS.primary} />
            <Text style={styles.createOptionText}>Create "{search}"</Text>
          </TouchableOpacity>
        )}
        
        {options.length === 0 && !search && (
          <View style={styles.emptyState}>
            <Ionicons name="checkbox-outline" size={24} color={COLORS.textMuted} />
            <Text style={styles.emptyText}>No options available</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 400,
  },
  containerDisabled: {
    opacity: 0.6,
  },
  selectedSection: {
    marginBottom: SPACING.md,
    padding: SPACING.sm,
    backgroundColor: COLORS.surface + '88',
    borderRadius: 8,
  },
  selectedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  selectedLabel: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  clearAllText: {
    fontSize: 12,
    color: COLORS.error,
  },
  selectedTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tagBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: SPACING.sm,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: 6,
  },
  tagBadgeSmall: {
    paddingLeft: 6,
    paddingRight: 2,
    paddingVertical: 2,
  },
  tagBadgeText: {
    fontSize: 13,
    fontWeight: '500',
  },
  tagBadgeTextSmall: {
    fontSize: 11,
  },
  tagRemoveBtn: {
    marginLeft: 4,
    padding: 2,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    height: 42,
    marginBottom: SPACING.sm,
  },
  searchIcon: {
    marginRight: SPACING.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: COLORS.text,
    padding: 0,
  },
  optionsList: {
    maxHeight: 250,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    borderRadius: 6,
    marginBottom: 2,
  },
  optionItemSelected: {
    backgroundColor: COLORS.primaryLight + '22',
  },
  checkbox: {
    marginRight: SPACING.sm,
  },
  optionBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
    borderRadius: 5,
  },
  optionBadgeText: {
    fontSize: 13,
    fontWeight: '500',
  },
  createOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.border + '44',
    marginTop: SPACING.xs,
  },
  createOptionText: {
    fontSize: 14,
    color: COLORS.primary,
    marginLeft: SPACING.sm,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: SPACING.xl,
  },
  emptyText: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginTop: SPACING.sm,
  },
});
