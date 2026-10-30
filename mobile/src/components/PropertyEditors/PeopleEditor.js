import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';

function PersonBadge({ person, onRemove, disabled }) {
  const initial = (person.name || person.email || 'U')[0].toUpperCase();
  
  return (
    <View style={styles.personBadge}>
      <View style={styles.personAvatar}>
        <Text style={styles.personInitial}>{initial}</Text>
      </View>
      <Text style={styles.personName} numberOfLines={1}>
        {person.name || person.email}
      </Text>
      {onRemove && !disabled && (
        <TouchableOpacity onPress={onRemove} style={styles.personRemoveBtn}>
          <Ionicons name="close" size={14} color={COLORS.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function PersonOption({ person, isSelected, onToggle }) {
  const initial = (person.name || person.email || 'U')[0].toUpperCase();
  
  return (
    <TouchableOpacity
      style={[styles.optionItem, isSelected && styles.optionItemSelected]}
      onPress={() => onToggle(person)}
      activeOpacity={0.7}
    >
      <Ionicons
        name={isSelected ? 'checkbox' : 'square-outline'}
        size={20}
        color={isSelected ? COLORS.primary : COLORS.textMuted}
        style={styles.checkbox}
      />
      <View style={styles.personAvatarSmall}>
        <Text style={styles.personInitialSmall}>{initial}</Text>
      </View>
      <View style={styles.personInfo}>
        <Text style={styles.personOptionName}>{person.name || 'Unknown'}</Text>
        {person.email && (
          <Text style={styles.personEmail}>{person.email}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

export function PeopleEditor({
  value,
  onChange,
  onSave,
  schema,
  users,
  loadUsers,
  multiSelect = true,
  disabled,
}) {
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [availableUsers, setAvailableUsers] = useState(users || []);

  useEffect(() => {
    if (users) {
      setAvailableUsers(users);
    } else if (loadUsers) {
      setLoading(true);
      loadUsers()
        .then(loaded => setAvailableUsers(loaded || []))
        .finally(() => setLoading(false));
    }
  }, [users, loadUsers]);

  const selectedPeople = useMemo(() => {
    if (!value) return [];
    if (!Array.isArray(value)) return [value];
    return value;
  }, [value]);

  const filteredUsers = useMemo(() => {
    if (!search) return availableUsers;
    const q = search.toLowerCase();
    return availableUsers.filter(u => 
      u.name?.toLowerCase().includes(q) || 
      u.email?.toLowerCase().includes(q)
    );
  }, [availableUsers, search]);

  const isSelected = useCallback((user) => {
    return selectedPeople.some(p => p.id === user.id);
  }, [selectedPeople]);

  const handleToggle = (user) => {
    if (disabled) return;
    
    if (!multiSelect) {
      // Single select mode
      const newValue = isSelected(user) ? [] : [{ id: user.id, name: user.name, email: user.email }];
      onChange?.(newValue);
      onSave?.(newValue);
      return;
    }
    
    let newValue;
    if (isSelected(user)) {
      newValue = selectedPeople.filter(p => p.id !== user.id);
    } else {
      newValue = [...selectedPeople, { id: user.id, name: user.name, email: user.email }];
    }
    
    onChange?.(newValue);
    onSave?.(newValue);
  };

  const handleRemove = (person) => {
    if (disabled) return;
    const newValue = selectedPeople.filter(p => p.id !== person.id);
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
      {/* Selected people */}
      {selectedPeople.length > 0 && (
        <View style={styles.selectedSection}>
          <View style={styles.selectedHeader}>
            <Text style={styles.selectedLabel}>{selectedPeople.length} assigned</Text>
            <TouchableOpacity onPress={handleClearAll} disabled={disabled}>
              <Text style={styles.clearAllText}>Clear all</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.selectedPeople}>
            {selectedPeople.map(p => (
              <PersonBadge
                key={p.id}
                person={p}
                onRemove={() => handleRemove(p)}
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
          placeholder="Search people..."
          placeholderTextColor={COLORS.textMuted}
          editable={!disabled}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Users list */}
      <ScrollView style={styles.usersList} nestedScrollEnabled>
        {loading && (
          <View style={styles.loadingState}>
            <ActivityIndicator color={COLORS.primary} />
            <Text style={styles.loadingText}>Loading users...</Text>
          </View>
        )}
        
        {!loading && filteredUsers.map(user => (
          <PersonOption
            key={user.id}
            person={user}
            isSelected={isSelected(user)}
            onToggle={handleToggle}
          />
        ))}
        
        {!loading && availableUsers.length === 0 && (
          <View style={styles.emptyState}>
            <Ionicons name="people-outline" size={24} color={COLORS.textMuted} />
            <Text style={styles.emptyText}>No users available</Text>
            <Text style={styles.emptyHint}>Users from workspace will appear here</Text>
          </View>
        )}
        
        {!loading && search && filteredUsers.length === 0 && availableUsers.length > 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No users match "{search}"</Text>
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
  selectedPeople: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  personBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    paddingLeft: 4,
    paddingRight: 8,
    paddingVertical: 4,
    borderRadius: 20,
    gap: 6,
  },
  personAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  personInitial: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  personName: {
    fontSize: 13,
    color: COLORS.text,
    maxWidth: 100,
  },
  personRemoveBtn: {
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
  usersList: {
    maxHeight: 250,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    borderRadius: 8,
    marginBottom: 4,
  },
  optionItemSelected: {
    backgroundColor: COLORS.primaryLight + '22',
  },
  checkbox: {
    marginRight: SPACING.sm,
  },
  personAvatarSmall: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.sm,
  },
  personInitialSmall: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  personInfo: {
    flex: 1,
  },
  personOptionName: {
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '500',
  },
  personEmail: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 1,
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
  emptyHint: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 4,
    opacity: 0.7,
  },
});
