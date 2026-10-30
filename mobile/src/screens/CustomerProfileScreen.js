/**
 * CustomerProfileScreen — Full customer profile management
 * Shows all Notion properties and nested page content with editing
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, useWindowDimensions, Modal,
  TextInput, Alert, Linking
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';
import { useCustomerProfile } from '../hooks/useCustomerProfile';
import { BlockRenderer } from '../components/BlockRenderer';
import { SimplePropertyEditorModal } from '../components/SimplePropertyEditor';

// Property type icons
const TYPE_ICONS = {
  title: 'text',
  rich_text: 'document-text',
  number: 'calculator',
  select: 'radio-button-on',
  multi_select: 'checkbox',
  status: 'flag',
  date: 'calendar',
  checkbox: 'checkbox',
  url: 'link',
  email: 'mail',
  phone_number: 'call',
  relation: 'git-branch',
  people: 'people',
  files: 'attach',
  created_time: 'time',
  last_edited_time: 'create',
  created_by: 'person-add',
  last_edited_by: 'person',
  formula: 'calculator-outline',
  rollup: 'layers',
};

// Status color map
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

function hashColor(str) {
  if (!str) return '#666';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 50%)`;
}

function initials(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDateShort(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Property value display component
function PropertyValue({ prop, schema, onEdit }) {
  const { type, value } = prop;
  const isEditable = schema && ![
    'created_time', 'last_edited_time', 'created_by', 'last_edited_by', 
    'formula', 'rollup', 'files', 'button'
  ].includes(type);
  
  const handlePress = () => {
    if (isEditable && onEdit) {
      onEdit();
    }
  };
  
  // Handle URL/email/phone tap
  const handleLinkPress = (url, linkType) => {
    if (linkType === 'email') {
      Linking.openURL(`mailto:${url}`);
    } else if (linkType === 'phone') {
      Linking.openURL(`tel:${url}`);
    } else if (url) {
      Linking.openURL(url.startsWith('http') ? url : `https://${url}`);
    }
  };
  
  const renderValue = () => {
    switch (type) {
      case 'title':
      case 'rich_text':
        return (
          <Text style={styles.propValue} numberOfLines={3}>
            {value || '—'}
          </Text>
        );
      
      case 'number':
        return (
          <Text style={styles.propValueNumber}>
            {value !== null && value !== undefined ? value.toLocaleString() : '—'}
          </Text>
        );
      
      case 'checkbox':
        return (
          <View style={[styles.checkbox, value && styles.checkboxChecked]}>
            {value && <Ionicons name="checkmark" size={14} color={COLORS.primary} />}
          </View>
        );
      
      case 'select':
      case 'status':
        if (!value) return <Text style={styles.propValueEmpty}>—</Text>;
        const opt = schema?.options?.find(o => o.name === value);
        const colors = STATUS_COLORS[opt?.color] || STATUS_COLORS.default;
        return (
          <View style={[styles.selectBadge, { backgroundColor: colors.bg }]}>
            <Text style={[styles.selectText, { color: colors.text }]}>{value}</Text>
          </View>
        );
      
      case 'multi_select':
        if (!value || value.length === 0) return <Text style={styles.propValueEmpty}>—</Text>;
        return (
          <View style={styles.multiSelectRow}>
            {value.slice(0, 5).map((v, i) => {
              const opt = schema?.options?.find(o => o.name === v);
              const colors = STATUS_COLORS[opt?.color] || STATUS_COLORS.default;
              return (
                <View key={i} style={[styles.selectBadge, styles.multiSelectBadge, { backgroundColor: colors.bg }]}>
                  <Text style={[styles.selectText, { color: colors.text }]}>{v}</Text>
                </View>
              );
            })}
            {value.length > 5 && (
              <Text style={styles.moreCount}>+{value.length - 5}</Text>
            )}
          </View>
        );
      
      case 'date':
        if (!value) return <Text style={styles.propValueEmpty}>—</Text>;
        const dateStr = typeof value === 'object' ? value.start : value;
        const endStr = typeof value === 'object' ? value.end : null;
        return (
          <Text style={styles.propValue}>
            {formatDateShort(dateStr)}
            {endStr && ` → ${formatDateShort(endStr)}`}
          </Text>
        );
      
      case 'url':
        if (!value) return <Text style={styles.propValueEmpty}>—</Text>;
        return (
          <TouchableOpacity onPress={() => handleLinkPress(value, 'url')}>
            <Text style={styles.propValueLink} numberOfLines={1}>{value}</Text>
          </TouchableOpacity>
        );
      
      case 'email':
        if (!value) return <Text style={styles.propValueEmpty}>—</Text>;
        return (
          <TouchableOpacity onPress={() => handleLinkPress(value, 'email')}>
            <Text style={styles.propValueLink}>{value}</Text>
          </TouchableOpacity>
        );
      
      case 'phone_number':
        if (!value) return <Text style={styles.propValueEmpty}>—</Text>;
        return (
          <TouchableOpacity onPress={() => handleLinkPress(value, 'phone')}>
            <Text style={styles.propValueLink}>{value}</Text>
          </TouchableOpacity>
        );
      
      case 'relation':
        if (!value || value.length === 0) return <Text style={styles.propValueEmpty}>—</Text>;
        return (
          <View style={styles.relationRow}>
            {value.slice(0, 3).map((r, i) => (
              <View key={i} style={styles.relationBadge}>
                <Ionicons name="link" size={10} color={COLORS.textMuted} />
                <Text style={styles.relationText} numberOfLines={1}>
                  {r.name || r.id?.slice(0, 8)}
                </Text>
              </View>
            ))}
            {value.length > 3 && (
              <Text style={styles.moreCount}>+{value.length - 3}</Text>
            )}
          </View>
        );
      
      case 'people':
        if (!value || value.length === 0) return <Text style={styles.propValueEmpty}>—</Text>;
        return (
          <View style={styles.peopleRow}>
            {value.slice(0, 4).map((p, i) => (
              <View key={i} style={[styles.personBadge, { backgroundColor: hashColor(p.name) }]}>
                <Text style={styles.personText}>{initials(p.name)}</Text>
              </View>
            ))}
            {value.length > 4 && (
              <Text style={styles.moreCount}>+{value.length - 4}</Text>
            )}
          </View>
        );
      
      case 'files':
        if (!value || value.length === 0) return <Text style={styles.propValueEmpty}>—</Text>;
        return (
          <View style={styles.filesRow}>
            {value.map((f, i) => (
              <TouchableOpacity 
                key={i} 
                style={styles.fileBadge}
                onPress={() => f.url && Linking.openURL(f.url)}
              >
                <Ionicons name="document" size={12} color={COLORS.primary} />
                <Text style={styles.fileText} numberOfLines={1}>{f.name || 'File'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        );
      
      case 'created_time':
      case 'last_edited_time':
        return <Text style={styles.propValueMuted}>{formatDate(value)}</Text>;
      
      case 'created_by':
      case 'last_edited_by':
        return <Text style={styles.propValueMuted}>{value || '—'}</Text>;
      
      case 'formula':
      case 'rollup':
        if (value === null || value === undefined) return <Text style={styles.propValueEmpty}>—</Text>;
        if (typeof value === 'object') {
          return <Text style={styles.propValueMuted}>[Computed]</Text>;
        }
        return <Text style={styles.propValue}>{String(value)}</Text>;
      
      default:
        return <Text style={styles.propValueEmpty}>—</Text>;
    }
  };
  
  return (
    <TouchableOpacity 
      style={styles.propValueContainer}
      onPress={handlePress}
      disabled={!isEditable}
      activeOpacity={isEditable ? 0.7 : 1}
    >
      {renderValue()}
      {isEditable && (
        <Ionicons name="create-outline" size={14} color={COLORS.textMuted} style={styles.editIcon} />
      )}
    </TouchableOpacity>
  );
}

// Property row component
function PropertyRow({ name, prop, schema, onEdit }) {
  const icon = TYPE_ICONS[prop.type] || 'help-circle';
  
  return (
    <View style={styles.propRow}>
      <View style={styles.propLabelRow}>
        <Ionicons name={icon} size={14} color={COLORS.textMuted} />
        <Text style={styles.propLabel} numberOfLines={1}>{name}</Text>
      </View>
      <PropertyValue prop={prop} schema={schema} onEdit={() => onEdit(name, prop, schema)} />
    </View>
  );
}

// Section component
function Section({ title, icon, children, collapsed, onToggle }) {
  const hasContent = React.Children.count(children) > 0;
  
  if (!hasContent) return null;
  
  return (
    <View style={styles.section}>
      <TouchableOpacity style={styles.sectionHeader} onPress={onToggle} activeOpacity={0.7}>
        <View style={styles.sectionTitleRow}>
          {icon && <Ionicons name={icon} size={14} color={COLORS.goldDim} />}
          <Text style={styles.sectionTitle}>{title}</Text>
        </View>
        <Ionicons 
          name={collapsed ? 'chevron-forward' : 'chevron-down'} 
          size={16} 
          color={COLORS.textMuted} 
        />
      </TouchableOpacity>
      {!collapsed && <View style={styles.sectionContent}>{children}</View>}
    </View>
  );
}

export function CustomerProfileScreen({ route, navigation, gateway }) {
  const { pageId, clientData } = route.params || {};
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  
  const profile = useCustomerProfile(gateway, pageId);
  const {
    loading, blocksLoading, saving, error, success,
    properties, propertySchema, blocks, displayName, icon,
    isEditable, groupedProperties, refresh, updateProperty,
    clearError, clearSuccess
  } = profile;
  
  // Edit modal state
  const [editingProp, setEditingProp] = useState(null);
  const [editValue, setEditValue] = useState(null);
  
  // Section collapse state
  const [collapsedSections, setCollapsedSections] = useState({});
  
  const toggleSection = useCallback((section) => {
    setCollapsedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  }, []);
  
  // Handle edit property
  const handleEdit = useCallback((name, prop, schema) => {
    setEditingProp({ name, prop, schema });
    setEditValue(prop.value);
  }, []);
  
  const handleSaveProperty = useCallback(async () => {
    if (!editingProp) return;
    
    const success = await updateProperty(editingProp.name, editValue);
    if (success) {
      setEditingProp(null);
      setEditValue(null);
    }
  }, [editingProp, editValue, updateProperty]);
  
  const handleCancelEdit = useCallback(() => {
    setEditingProp(null);
    setEditValue(null);
  }, []);
  
  // Get grouped properties
  const groups = useMemo(() => groupedProperties(), [groupedProperties]);
  
  // Avatar color
  const avatarColor = hashColor(displayName);
  
  // Render header
  const renderHeader = () => (
    <View style={styles.header}>
      <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
        {typeof icon === 'string' && icon.length <= 2 ? (
          <Text style={styles.avatarEmoji}>{icon}</Text>
        ) : (
          <Text style={styles.avatarText}>{initials(displayName)}</Text>
        )}
      </View>
      <View style={styles.headerInfo}>
        <Text style={styles.headerName}>{displayName}</Text>
        {groups.identity[0]?.value !== displayName && groups.identity[0]?.value && (
          <Text style={styles.headerSubtitle}>{groups.identity[0].value}</Text>
        )}
        
        {/* Quick status badges */}
        <View style={styles.quickBadges}>
          {groups.status.slice(0, 2).map(prop => {
            if (!prop.value) return null;
            const opt = prop.schema?.options?.find(o => o.name === prop.value);
            const colors = STATUS_COLORS[opt?.color] || STATUS_COLORS.default;
            return (
              <View key={prop.name} style={[styles.quickBadge, { backgroundColor: colors.bg }]}>
                <Text style={[styles.quickBadgeText, { color: colors.text }]}>{prop.value}</Text>
              </View>
            );
          })}
        </View>
      </View>
      
      {/* Actions */}
      <View style={styles.headerActions}>
        <TouchableOpacity style={styles.headerAction} onPress={refresh}>
          <Ionicons name="refresh" size={20} color={COLORS.textMuted} />
        </TouchableOpacity>
      </View>
    </View>
  );
  
  // Render property section
  const renderPropertySection = (title, iconName, propsArray, sectionKey) => {
    if (!propsArray || propsArray.length === 0) return null;
    
    return (
      <Section 
        title={title} 
        icon={iconName} 
        collapsed={collapsedSections[sectionKey]}
        onToggle={() => toggleSection(sectionKey)}
      >
        {propsArray.map(prop => (
          <PropertyRow
            key={prop.name}
            name={prop.name}
            prop={prop}
            schema={prop.schema}
            onEdit={handleEdit}
          />
        ))}
      </Section>
    );
  };
  
  if (loading && !profile.pageData) {
    return (
      <SafeAreaView style={styles.container} edges={['left', 'right']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={styles.loadingText}>LOADING PROFILE</Text>
        </View>
      </SafeAreaView>
    );
  }
  
  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      {/* Success/Error banners */}
      {success && (
        <View style={styles.successBar}>
          <Text style={styles.successText}><Ionicons name="checkmark-circle" size={13} color="#4ade80" /> {success}</Text>
        </View>
      )}
      {error && (
        <View style={styles.errorBar}>
          <Ionicons name="warning-outline" size={14} color="#f87171" style={{ marginRight: 6 }} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={refresh} style={{ paddingHorizontal: 10 }}>
            <Text style={[styles.errorText, { flex: 0, fontWeight: '700' }]}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={clearError}>
            <Ionicons name="close" size={18} color="#f87171" />
          </TouchableOpacity>
        </View>
      )}
      
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.content, isTablet && styles.contentTablet]}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={refresh}
            tintColor={COLORS.primary}
          />
        }
      >
        {renderHeader()}
        
        {/* Empty state — the page itself did not load */}
        {!loading && !profile.pageData && (
          <View style={styles.loadingContainer}>
            <Ionicons name="person-circle-outline" size={40} color={COLORS.textMuted} />
            <Text style={styles.loadingText}>
              {error ? 'PROFILE UNAVAILABLE' : 'NO PROFILE DATA'}
            </Text>
          </View>
        )}

        {/* Properties Panel */}
        <View style={[styles.propertiesPanel, isTablet && styles.propertiesPanelTablet]}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>◆ PROPERTIES</Text>
            <Text style={styles.panelCount}>
              {Object.keys(properties).length} fields
            </Text>
          </View>
          
          {/* Contact Section */}
          {renderPropertySection('Contact', 'call', groups.contact, 'contact')}
          
          {/* Status Section */}
          {renderPropertySection('Status & Tags', 'pricetags', groups.status, 'status')}
          
          {/* Details Section */}
          {renderPropertySection('Details', 'document-text', groups.details, 'details')}
          
          {/* Financial Section (Numbers) */}
          {groups.details.filter(p => p.type === 'number').length > 0 && (
            <Section 
              title="Financial" 
              icon="cash"
              collapsed={collapsedSections.financial}
              onToggle={() => toggleSection('financial')}
            >
              {groups.details.filter(p => p.type === 'number').map(prop => (
                <PropertyRow
                  key={prop.name}
                  name={prop.name}
                  prop={prop}
                  schema={prop.schema}
                  onEdit={handleEdit}
                />
              ))}
            </Section>
          )}
          
          {/* Relations Section */}
          {renderPropertySection('Relations', 'git-branch', groups.relations, 'relations')}
          
          {/* Files Section */}
          {renderPropertySection('Files & Media', 'folder', groups.files, 'files')}
          
          {/* Dates Section */}
          {renderPropertySection('Dates & Activity', 'time', groups.dates, 'dates')}
          
          {/* Computed Section */}
          {renderPropertySection('Computed', 'calculator', groups.computed, 'computed')}
          
          {/* Other Section */}
          {renderPropertySection('Other', 'ellipsis-horizontal', groups.other, 'other')}
        </View>
        
        {/* Page Content (Blocks) */}
        {blocks && blocks.length > 0 && (
          <View style={[styles.contentPanel, isTablet && styles.contentPanelTablet]}>
            <View style={styles.panelHeader}>
              <Text style={styles.panelTitle}>◆ PAGE CONTENT</Text>
              {blocksLoading && <ActivityIndicator size="small" color={COLORS.primary} />}
            </View>
            <View style={styles.blocksContainer}>
              <BlockRenderer blocks={blocks} />
            </View>
          </View>
        )}
        
        {/* Bottom padding */}
        <View style={{ height: 40 }} />
      </ScrollView>
      
      {/* Saving indicator */}
      {saving && (
        <View style={styles.savingOverlay}>
          <View style={styles.savingBox}>
            <ActivityIndicator size="small" color={COLORS.primary} />
            <Text style={styles.savingText}>Saving...</Text>
          </View>
        </View>
      )}
      
      {/* Edit Modal */}
      {editingProp && (
        <SimplePropertyEditorModal
          visible={!!editingProp}
          propertyName={editingProp.name}
          propertyType={editingProp.prop.type}
          schema={editingProp.schema}
          value={editValue}
          onChange={setEditValue}
          onSave={handleSaveProperty}
          onCancel={handleCancelEdit}
          saving={saving}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 12,
    color: COLORS.textMuted,
    letterSpacing: 2,
  },
  
  // Banners
  successBar: {
    padding: 10,
    backgroundColor: 'rgba(34,197,94,0.08)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(34,197,94,0.2)',
  },
  successText: {
    fontSize: 12,
    color: '#4ade80',
  },
  errorBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(239,68,68,0.2)',
  },
  errorText: {
    flex: 1,
    fontSize: 12,
    color: '#f87171',
  },
  
  // Scroll
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  contentTablet: {
    padding: 24,
    maxWidth: 900,
    alignSelf: 'center',
    width: '100%',
  },
  
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 24,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primaryDim,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fff',
  },
  avatarEmoji: {
    fontSize: 32,
  },
  headerInfo: {
    flex: 1,
  },
  headerName: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginBottom: 8,
  },
  quickBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  quickBadge: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  quickBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  headerAction: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.primaryDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  
  // Panels
  propertiesPanel: {
    backgroundColor: 'rgba(8,8,8,0.95)',
    borderWidth: 1,
    borderColor: COLORS.primaryDim,
    borderRadius: 12,
    marginBottom: 20,
    overflow: 'hidden',
  },
  propertiesPanelTablet: {
    borderRadius: 16,
  },
  contentPanel: {
    backgroundColor: 'rgba(8,8,8,0.95)',
    borderWidth: 1,
    borderColor: COLORS.primaryDim,
    borderRadius: 12,
    overflow: 'hidden',
  },
  contentPanelTablet: {
    borderRadius: 16,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primaryDim,
  },
  panelTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.goldDim,
    letterSpacing: 1.5,
  },
  panelCount: {
    fontSize: 10,
    color: COLORS.textMuted,
  },
  blocksContainer: {
    padding: 16,
  },
  
  // Section
  section: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.03)',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: COLORS.primaryDim,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.goldDim,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  sectionContent: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  
  // Property Row
  propRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.02)',
  },
  propLabelRow: {
    width: 140,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  propLabel: {
    flex: 1,
    fontSize: 12,
    color: COLORS.textMuted,
  },
  propValueContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  propValue: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
    lineHeight: 20,
  },
  propValueNumber: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.primary,
    fontVariant: ['tabular-nums'],
  },
  propValueEmpty: {
    fontSize: 13,
    color: '#3f3f46',
  },
  propValueMuted: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  propValueLink: {
    fontSize: 13,
    color: COLORS.primary,
    textDecorationLine: 'underline',
  },
  editIcon: {
    marginLeft: 8,
    opacity: 0.5,
  },
  
  // Checkbox
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 1,
    borderColor: COLORS.primaryStrong,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: COLORS.primaryLight,
    borderColor: COLORS.primary,
  },
  
  // Select/Status
  selectBadge: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 4,
  },
  multiSelectBadge: {
    marginRight: 4,
    marginBottom: 4,
  },
  selectText: {
    fontSize: 11,
    fontWeight: '600',
  },
  multiSelectRow: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  moreCount: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginLeft: 4,
  },
  
  // Relation
  relationRow: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  relationBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 4,
  },
  relationText: {
    fontSize: 11,
    color: COLORS.text,
    maxWidth: 80,
  },
  
  // People
  peopleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  personBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  personText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
  },
  
  // Files
  filesRow: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  fileBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: COLORS.primaryDim,
    borderRadius: 4,
    maxWidth: 150,
  },
  fileText: {
    fontSize: 11,
    color: COLORS.text,
    flex: 1,
  },
  
  // Saving
  savingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  savingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
  },
  savingText: {
    fontSize: 14,
    color: COLORS.text,
  },
});

export default CustomerProfileScreen;
