import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { GlassCard } from '../GlassCard';
import { GlowButton } from '../GlowButton';
import { COLORS, SPACING } from '../../constants/theme';
import { PropertyEditor } from './PropertyEditor';
import { PropertyRow } from './PropertyRow';
import { extractPropertyValue, buildPropertyUpdate } from '../../hooks/useNotionSchema';

const TYPE_ICONS = {
  title: 'text-outline',
  rich_text: 'document-text-outline',
  number: 'calculator-outline',
  select: 'radio-button-on-outline',
  multi_select: 'checkbox-outline',
  status: 'pulse-outline',
  date: 'calendar-outline',
  people: 'people-outline',
  checkbox: 'checkbox-outline',
  url: 'link-outline',
  email: 'mail-outline',
  phone_number: 'call-outline',
  relation: 'git-branch-outline',
  rollup: 'analytics-outline',
  formula: 'code-outline',
  files: 'attach-outline',
};

/**
 * Full-screen modal for editing all properties of a page
 */
export function PropertyEditorModal({
  visible,
  onClose,
  onSave,
  pageId,
  properties, // Raw Notion properties object
  schema, // Parsed database schema from useNotionSchema
  title,
  // Data loaders
  loadUsers,
  loadRelatedItems,
  // State
  loading,
  saving,
}) {
  const [editingProperty, setEditingProperty] = useState(null);
  const [pendingChanges, setPendingChanges] = useState({});
  const [localProperties, setLocalProperties] = useState({});

  // Initialize local properties from Notion properties
  useEffect(() => {
    if (properties && schema) {
      const extracted = {};
      for (const [name, propConfig] of Object.entries(properties)) {
        extracted[name] = extractPropertyValue(propConfig);
      }
      setLocalProperties(extracted);
      setPendingChanges({});
    }
  }, [properties, schema]);

  // Get sorted property list from schema
  const propertyList = useMemo(() => {
    if (!schema?.propertyList) return [];
    return schema.propertyList;
  }, [schema]);

  // Get current value for a property (pending change or local)
  const getValue = useCallback((propertyName) => {
    if (pendingChanges[propertyName] !== undefined) {
      return pendingChanges[propertyName];
    }
    return localProperties[propertyName];
  }, [pendingChanges, localProperties]);

  // Handle property value change (pending, not saved yet)
  const handleChange = useCallback((propertyName, value) => {
    setPendingChanges(prev => ({
      ...prev,
      [propertyName]: value,
    }));
  }, []);

  // Handle immediate save for a single property
  const handlePropertySave = useCallback(async (propertyName, value) => {
    if (!onSave || !schema) return;
    
    const propSchema = schema.properties[propertyName];
    if (!propSchema) return;
    
    const update = buildPropertyUpdate(propSchema.type, value);
    if (!update) return;
    
    // Update local state immediately
    setLocalProperties(prev => ({
      ...prev,
      [propertyName]: value,
    }));
    
    // Clear from pending
    setPendingChanges(prev => {
      const next = { ...prev };
      delete next[propertyName];
      return next;
    });
    
    // Save to Notion
    try {
      await onSave(pageId, { [propertyName]: update });
    } catch (err) {
      console.error('Failed to save property:', err);
      // Revert local state on error
    }
  }, [onSave, pageId, schema]);

  // Save all pending changes
  const handleSaveAll = useCallback(async () => {
    if (!onSave || !schema || Object.keys(pendingChanges).length === 0) return;
    
    const updates = {};
    for (const [name, value] of Object.entries(pendingChanges)) {
      const propSchema = schema.properties[name];
      if (!propSchema) continue;
      
      const update = buildPropertyUpdate(propSchema.type, value);
      if (update) {
        updates[name] = update;
      }
    }
    
    if (Object.keys(updates).length === 0) return;
    
    try {
      await onSave(pageId, updates);
      
      // Update local state
      setLocalProperties(prev => ({
        ...prev,
        ...pendingChanges,
      }));
      setPendingChanges({});
    } catch (err) {
      console.error('Failed to save properties:', err);
    }
  }, [onSave, pageId, schema, pendingChanges]);

  // Handle close with pending changes check
  const handleClose = useCallback(() => {
    if (Object.keys(pendingChanges).length > 0) {
      // Could show a confirmation dialog here
      // For now, just discard changes
    }
    setEditingProperty(null);
    setPendingChanges({});
    onClose?.();
  }, [pendingChanges, onClose]);

  // Render property row or editor
  const renderProperty = (prop, index) => {
    const isEditing = editingProperty === prop.name;
    const value = getValue(prop.name);
    const hasChange = pendingChanges[prop.name] !== undefined;
    
    if (isEditing) {
      return (
        <View key={prop.name} style={styles.editingSection}>
          <View style={styles.editingHeader}>
            <Ionicons 
              name={TYPE_ICONS[prop.type] || 'help-circle-outline'} 
              size={16} 
              color={COLORS.primary} 
            />
            <Text style={styles.editingLabel}>{prop.name}</Text>
            <TouchableOpacity onPress={() => setEditingProperty(null)}>
              <Ionicons name="close" size={20} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>
          
          <PropertyEditor
            schema={prop}
            value={value}
            onChange={(v) => handleChange(prop.name, v)}
            onSave={(v) => handlePropertySave(prop.name, v)}
            loadUsers={loadUsers}
            loadRelatedItems={loadRelatedItems}
            autoFocus
          />
        </View>
      );
    }
    
    return (
      <PropertyRow
        key={prop.name}
        schema={prop}
        value={value}
        onPress={prop.editable ? () => setEditingProperty(prop.name) : null}
      />
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
            <Ionicons name="close" size={24} color={COLORS.text} />
          </TouchableOpacity>
          
          <View style={styles.headerCenter}>
            <MaterialCommunityIcons name="database-edit-outline" size={18} color={COLORS.primary} />
            <Text style={styles.headerTitle} numberOfLines={1}>
              {title || 'Edit Properties'}
            </Text>
          </View>
          
          {Object.keys(pendingChanges).length > 0 ? (
            <TouchableOpacity onPress={handleSaveAll} style={styles.saveBtn} disabled={saving}>
              {saving ? (
                <ActivityIndicator size="small" color={COLORS.primary} />
              ) : (
                <Text style={styles.saveBtnText}>Save All</Text>
              )}
            </TouchableOpacity>
          ) : (
            <View style={styles.headerPlaceholder} />
          )}
        </View>

        {/* Pending changes indicator */}
        {Object.keys(pendingChanges).length > 0 && (
          <View style={styles.pendingBanner}>
            <Ionicons name="cloud-upload-outline" size={14} color={COLORS.warning} />
            <Text style={styles.pendingText}>
              {Object.keys(pendingChanges).length} unsaved change{Object.keys(pendingChanges).length > 1 ? 's' : ''}
            </Text>
          </View>
        )}

        {/* Content */}
        {loading ? (
          <View style={styles.loadingState}>
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={styles.loadingText}>Loading properties...</Text>
          </View>
        ) : (
          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.contentContainer}
            keyboardShouldPersistTaps="handled"
          >
            {/* Editable properties */}
            {propertyList.filter(p => p.editable).length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>EDITABLE</Text>
                <GlassCard style={styles.propertiesCard}>
                  {propertyList.filter(p => p.editable).map(renderProperty)}
                </GlassCard>
              </View>
            )}

            {/* Read-only properties */}
            {propertyList.filter(p => p.readonly).length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>READ-ONLY</Text>
                <GlassCard style={styles.propertiesCard}>
                  {propertyList.filter(p => p.readonly).map(renderProperty)}
                </GlassCard>
              </View>
            )}

            {/* Empty state */}
            {propertyList.length === 0 && (
              <View style={styles.emptyState}>
                <MaterialCommunityIcons name="database-off-outline" size={48} color={COLORS.textMuted} />
                <Text style={styles.emptyText}>No properties available</Text>
                <Text style={styles.emptyHint}>Schema could not be loaded</Text>
              </View>
            )}
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  closeBtn: {
    padding: 8,
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    flex: 1,
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: COLORS.text,
    maxWidth: 200,
  },
  headerPlaceholder: {
    width: 60,
  },
  saveBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 8,
  },
  saveBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.primary,
  },
  pendingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.xs,
    backgroundColor: COLORS.warning + '22',
  },
  pendingText: {
    fontSize: 12,
    color: COLORS.warning,
    fontWeight: '500',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: SPACING.md,
    paddingBottom: SPACING.xxl,
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
  },
  loadingText: {
    fontSize: 14,
    color: COLORS.textMuted,
  },
  section: {
    marginBottom: SPACING.lg,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.textMuted,
    letterSpacing: 1,
    marginBottom: SPACING.sm,
    marginLeft: SPACING.sm,
  },
  propertiesCard: {
    padding: 0,
    overflow: 'hidden',
  },
  editingSection: {
    backgroundColor: COLORS.primaryLight + '11',
    padding: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border + '44',
  },
  editingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  editingLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.primary,
    flex: 1,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: SPACING.xxl,
  },
  emptyText: {
    fontSize: 16,
    color: COLORS.textMuted,
    marginTop: SPACING.md,
  },
  emptyHint: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginTop: SPACING.xs,
    opacity: 0.7,
  },
});
