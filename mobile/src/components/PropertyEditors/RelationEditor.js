import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

function RelationBadge({ item, onRemove, disabled }) {
  return (
    <View style={styles.relationBadge}>
      <MaterialCommunityIcons name="file-document-outline" size={14} color={COLORS.text} />
      <Text style={styles.relationName} numberOfLines={1}>{item.name || item.title || 'Untitled'}</Text>
      {onRemove && !disabled && (
        <TouchableOpacity onPress={onRemove} style={styles.relationRemoveBtn}>
          <Ionicons name="close" size={14} color={COLORS.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function RelationOption({ item, isSelected, onToggle }) {
  return (
    <TouchableOpacity
      style={[styles.optionItem, isSelected && styles.optionItemSelected]}
      onPress={() => onToggle(item)}
      activeOpacity={0.7}
    >
      <Ionicons
        name={isSelected ? 'checkbox' : 'square-outline'}
        size={20}
        color={isSelected ? COLORS.primary : COLORS.textMuted}
        style={styles.checkbox}
      />
      <MaterialCommunityIcons name="file-document-outline" size={18} color={COLORS.textSecondary} />
      <Text style={styles.optionName} numberOfLines={1}>{item.name || item.title || 'Untitled'}</Text>
    </TouchableOpacity>
  );
}

export function RelationEditor({
  value,
  onChange,
  onSave,
  schema,
  relatedItems,
  loadRelatedItems,
  relatedDatabaseName,
  multiSelect = true,
  disabled,
}) {
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [availableItems, setAvailableItems] = useState(relatedItems || []);

  const dbName = relatedDatabaseName || schema?.relatedDatabaseName || 'Related Items';

  useEffect(() => {
    if (relatedItems) {
      setAvailableItems(relatedItems);
    } else if (loadRelatedItems) {
      setLoading(true);
      loadRelatedItems(schema?.relatedDatabaseId)
        .then(loaded => setAvailableItems(loaded || []))
        .finally(() => setLoading(false));
    }
  }, [relatedItems, loadRelatedItems, schema?.relatedDatabaseId]);

  const selectedItems = useMemo(() => {
    if (!value) return [];
    if (!Array.isArray(value)) return [value];
    return value.map(v => {
      if (typeof v === 'string' || !v.name) {
        // Just an ID, need to find the name from available items
        const id = typeof v === 'string' ? v : v.id;
        const found = availableItems.find(i => i.id === id);
        return found || { id };
      }
      return v;
    });
  }, [value, availableItems]);

  const filteredItems = useMemo(() => {
    if (!search) return availableItems;
    const q = search.toLowerCase();
    return availableItems.filter(i => 
      (i.name || i.title || '')?.toLowerCase().includes(q)
    );
  }, [availableItems, search]);

  const isSelected = useCallback((item) => {
    return selectedItems.some(s => s.id === item.id);
  }, [selectedItems]);

  const handleToggle = (item) => {
    if (disabled) return;
    
    if (!multiSelect) {
      const newValue = isSelected(item) ? [] : [{ id: item.id, name: item.name || item.title }];
      onChange?.(newValue);
      onSave?.(newValue);
      return;
    }
    
    let newValue;
    if (isSelected(item)) {
      newValue = selectedItems.filter(s => s.id !== item.id);
    } else {
      newValue = [...selectedItems, { id: item.id, name: item.name || item.title }];
    }
    
    onChange?.(newValue);
    onSave?.(newValue);
  };

  const handleRemove = (item) => {
    if (disabled) return;
    const newValue = selectedItems.filter(s => s.id !== item.id);
    onChange?.(newValue);
    onSave?.(newValue);
  };

  const handleClearAll = () => {
    if (disabled) return;
    onChange?.([]);
    onSave?.([]);
  };

  return (
    <View style={[styles.container, disabled && styles.containerDisabled]}>
      {/* Header with database name */}
      <View style={styles.header}>
        <MaterialCommunityIcons name="database-outline" size={16} color={COLORS.textSecondary} />
        <Text style={styles.headerText}>Link to {dbName}</Text>
      </View>

      {/* Selected items */}
      {selectedItems.length > 0 && (
        <View style={styles.selectedSection}>
          <View style={styles.selectedHeader}>
            <Text style={styles.selectedLabel}>{selectedItems.length} linked</Text>
            <TouchableOpacity onPress={handleClearAll} disabled={disabled}>
              <Text style={styles.clearAllText}>Clear all</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.selectedItems}>
            {selectedItems.map(item => (
              <RelationBadge
                key={item.id}
                item={item}
                onRemove={() => handleRemove(item)}
                disabled={disabled}
              />
            ))}
          </View>
        </View>
      )}

      {/* Search */}
      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={16} color={COLORS.textMuted} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder={`Search ${dbName.toLowerCase()}...`}
          placeholderTextColor={COLORS.textMuted}
          editable={!disabled}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Items list */}
      <ScrollView style={styles.itemsList} nestedScrollEnabled>
        {loading && (
          <View style={styles.loadingState}>
            <ActivityIndicator color={COLORS.primary} />
            <Text style={styles.loadingText}>Loading {dbName.toLowerCase()}...</Text>
          </View>
        )}
        
        {!loading && filteredItems.map(item => (
          <RelationOption
            key={item.id}
            item={item}
            isSelected={isSelected(item)}
            onToggle={handleToggle}
          />
        ))}
        
        {!loading && availableItems.length === 0 && (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons name="database-off-outline" size={24} color={COLORS.textMuted} />
            <Text style={styles.emptyText}>No items in {dbName}</Text>
          </View>
        )}
        
        {!loading && search && filteredItems.length === 0 && availableItems.length > 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No items match "{search}"</Text>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.xs,
  },
  headerText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontWeight: '500',
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
  selectedItems: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  relationBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    borderRadius: 6,
    gap: 6,
    maxWidth: '100%',
  },
  relationName: {
    fontSize: 13,
    color: COLORS.text,
    flex: 1,
    maxWidth: 150,
  },
  relationRemoveBtn: {
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
  itemsList: {
    maxHeight: 250,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    borderRadius: 8,
    marginBottom: 4,
    gap: SPACING.sm,
  },
  optionItemSelected: {
    backgroundColor: COLORS.primaryLight + '22',
  },
  checkbox: {
    marginRight: 0,
  },
  optionName: {
    fontSize: 14,
    color: COLORS.text,
    flex: 1,
  },
  loadingState: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  loadingText: {
    fontSize: 13,
    color: COLORS.textMuted,
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
