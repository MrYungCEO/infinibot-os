import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, FlatList,
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

function OptionItem({ option, isSelected, onSelect, colorMode }) {
  const color = NOTION_COLORS[option.color] || NOTION_COLORS.default;
  
  return (
    <TouchableOpacity
      style={[
        styles.optionItem,
        isSelected && styles.optionItemSelected,
      ]}
      onPress={() => onSelect(option)}
      activeOpacity={0.7}
    >
      {colorMode === 'full' ? (
        <View style={[styles.optionBadgeFull, { backgroundColor: color.bg }]}>
          <Text style={[styles.optionBadgeText, { color: color.text }]}>{option.name}</Text>
        </View>
      ) : (
        <View style={styles.optionRow}>
          <View style={[styles.optionDot, { backgroundColor: color.bg }]} />
          <Text style={styles.optionName}>{option.name}</Text>
        </View>
      )}
      {isSelected && (
        <Ionicons name="checkmark-circle" size={20} color={COLORS.primary} />
      )}
    </TouchableOpacity>
  );
}

export function SelectEditor({
  value,
  onChange,
  onSave,
  schema,
  options: propOptions,
  allowCreate,
  allowClear,
  colorMode = 'dot', // 'dot' | 'full'
  disabled,
}) {
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const options = propOptions || schema?.options || [];
  
  const filteredOptions = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter(o => o.name.toLowerCase().includes(q));
  }, [options, search]);

  const selectedOption = useMemo(() => {
    if (!value) return null;
    const name = typeof value === 'string' ? value : value.name;
    return options.find(o => o.name === name) || (name ? { name, color: 'default' } : null);
  }, [value, options]);

  const handleSelect = (option) => {
    if (disabled) return;
    const newValue = option ? { name: option.name, color: option.color, id: option.id } : null;
    onChange?.(newValue);
    onSave?.(newValue);
  };

  const handleClear = () => {
    handleSelect(null);
  };

  const handleCreate = () => {
    if (!search.trim() || disabled) return;
    const newOption = { name: search.trim(), color: 'default' };
    handleSelect(newOption);
    setSearch('');
    setShowCreate(false);
  };

  const noMatch = search && filteredOptions.length === 0;

  return (
    <View style={[styles.container, disabled && styles.containerDisabled]}>
      {/* Search / filter */}
      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={16} color={COLORS.textMuted} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search options..."
          placeholderTextColor={COLORS.textMuted}
          editable={!disabled}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Current selection */}
      {selectedOption && (
        <View style={styles.selectedWrap}>
          <Text style={styles.selectedLabel}>Selected:</Text>
          <View style={[styles.selectedBadge, { backgroundColor: (NOTION_COLORS[selectedOption.color] || NOTION_COLORS.default).bg }]}>
            <Text style={[styles.selectedBadgeText, { color: (NOTION_COLORS[selectedOption.color] || NOTION_COLORS.default).text }]}>
              {selectedOption.name}
            </Text>
          </View>
          {allowClear !== false && (
            <TouchableOpacity onPress={handleClear} style={styles.clearBtn} disabled={disabled}>
              <Ionicons name="close" size={16} color={COLORS.error} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Options list */}
      <ScrollView style={styles.optionsList} nestedScrollEnabled>
        {filteredOptions.map(option => (
          <OptionItem
            key={option.id || option.name}
            option={option}
            isSelected={selectedOption?.name === option.name}
            onSelect={handleSelect}
            colorMode={colorMode}
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
            <Ionicons name="radio-button-off-outline" size={24} color={COLORS.textMuted} />
            <Text style={styles.emptyText}>No options available</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 300,
  },
  containerDisabled: {
    opacity: 0.6,
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
  selectedWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.xs,
  },
  selectedLabel: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginRight: SPACING.sm,
  },
  selectedBadge: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 4,
    borderRadius: 6,
  },
  selectedBadgeText: {
    fontSize: 13,
    fontWeight: '500',
  },
  clearBtn: {
    marginLeft: SPACING.sm,
    padding: 4,
  },
  optionsList: {
    maxHeight: 200,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: 6,
    marginBottom: 2,
  },
  optionItemSelected: {
    backgroundColor: COLORS.primaryLight + '22',
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  optionDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: SPACING.sm,
  },
  optionName: {
    fontSize: 14,
    color: COLORS.text,
  },
  optionBadgeFull: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 4,
    borderRadius: 6,
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
