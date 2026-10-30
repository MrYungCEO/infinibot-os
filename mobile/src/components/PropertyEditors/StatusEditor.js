import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

const STATUS_COLORS = {
  gray: { bg: '#787774', dot: '#787774' },
  brown: { bg: '#9F6B53', dot: '#9F6B53' },
  orange: { bg: '#D9730D', dot: '#D9730D' },
  yellow: { bg: '#CB912F', dot: '#CB912F' },
  green: { bg: '#448361', dot: '#448361' },
  blue: { bg: '#337EA9', dot: '#337EA9' },
  purple: { bg: '#9065B0', dot: '#9065B0' },
  pink: { bg: '#C14C8A', dot: '#C14C8A' },
  red: { bg: '#D44C47', dot: '#D44C47' },
};

const DEFAULT_COLOR = { bg: COLORS.textMuted, dot: COLORS.textMuted };

function StatusOption({ option, isSelected, onSelect }) {
  const color = STATUS_COLORS[option.color] || DEFAULT_COLOR;
  
  return (
    <TouchableOpacity
      style={[
        styles.optionItem,
        isSelected && styles.optionItemSelected,
        isSelected && { borderColor: color.bg },
      ]}
      onPress={() => onSelect(option)}
      activeOpacity={0.7}
    >
      <View style={[styles.statusDot, { backgroundColor: color.dot }]} />
      <Text style={[styles.optionName, isSelected && { color: color.bg, fontWeight: '600' }]}>
        {option.name}
      </Text>
      {isSelected && (
        <Ionicons name="checkmark" size={18} color={color.bg} style={styles.checkIcon} />
      )}
    </TouchableOpacity>
  );
}

function StatusGroup({ group, options, selectedName, onSelect }) {
  const color = STATUS_COLORS[group.color] || DEFAULT_COLOR;
  const groupOptions = options.filter(o => o.name && group.option_ids?.includes(o.id));
  
  if (groupOptions.length === 0) return null;
  
  return (
    <View style={styles.groupSection}>
      <View style={styles.groupHeader}>
        <View style={[styles.groupIndicator, { backgroundColor: color.bg }]} />
        <Text style={[styles.groupName, { color: color.bg }]}>{group.name}</Text>
      </View>
      {groupOptions.map(option => (
        <StatusOption
          key={option.id || option.name}
          option={option}
          isSelected={selectedName === option.name}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

export function StatusEditor({
  value,
  onChange,
  onSave,
  schema,
  options: propOptions,
  groups: propGroups,
  disabled,
}) {
  const options = propOptions || schema?.options || [];
  const groups = propGroups || schema?.groups || [];

  const selectedOption = useMemo(() => {
    if (!value) return null;
    const name = typeof value === 'string' ? value : value.name;
    return options.find(o => o.name === name) || (name ? { name, color: 'gray' } : null);
  }, [value, options]);

  const handleSelect = (option) => {
    if (disabled) return;
    const newValue = option ? { name: option.name, color: option.color, id: option.id } : null;
    onChange?.(newValue);
    onSave?.(newValue);
  };

  // If we have groups, render grouped view
  if (groups.length > 0) {
    return (
      <View style={[styles.container, disabled && styles.containerDisabled]}>
        <ScrollView style={styles.groupsList} nestedScrollEnabled>
          {groups.map(group => (
            <StatusGroup
              key={group.id || group.name}
              group={group}
              options={options}
              selectedName={selectedOption?.name}
              onSelect={handleSelect}
            />
          ))}
        </ScrollView>
      </View>
    );
  }

  // Simple list without groups
  return (
    <View style={[styles.container, disabled && styles.containerDisabled]}>
      <ScrollView style={styles.optionsList} nestedScrollEnabled>
        {options.map(option => (
          <StatusOption
            key={option.id || option.name}
            option={option}
            isSelected={selectedOption?.name === option.name}
            onSelect={handleSelect}
          />
        ))}
        
        {options.length === 0 && (
          <View style={styles.emptyState}>
            <Ionicons name="pulse-outline" size={24} color={COLORS.textMuted} />
            <Text style={styles.emptyText}>No status options</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 350,
  },
  containerDisabled: {
    opacity: 0.6,
  },
  optionsList: {
    maxHeight: 300,
  },
  groupsList: {
    maxHeight: 300,
  },
  groupSection: {
    marginBottom: SPACING.md,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    marginBottom: SPACING.xs,
  },
  groupIndicator: {
    width: 3,
    height: 14,
    borderRadius: 2,
    marginRight: SPACING.sm,
  },
  groupName: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    marginBottom: 4,
    marginHorizontal: SPACING.xs,
    backgroundColor: COLORS.surface + '44',
  },
  optionItemSelected: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: SPACING.sm,
  },
  optionName: {
    fontSize: 14,
    color: COLORS.text,
    flex: 1,
  },
  checkIcon: {
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
