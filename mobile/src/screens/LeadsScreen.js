/**
 * LeadsScreen — Lead generation dashboard
 * Matches web UI gold/black HUD theme
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  FlatList, Modal, Alert, useWindowDimensions, ActivityIndicator, Linking, RefreshControl
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GLASS } from '../constants/theme';
import { useLeads } from '../hooks/useLeads';

const QUALITY_COLORS = {
  hot: '#ef4444',
  warm: '#f59e0b',
  cold: '#3b82f6',
  unknown: '#71717a',
};

const LEAD_TYPES = [
  { value: 'business', label: 'Local Business' },
  { value: 'b2b', label: 'B2B Company' },
  { value: 'agency', label: 'Agency' },
  { value: 'ecommerce', label: 'E-commerce' },
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'realestate', label: 'Real Estate' },
  { value: 'tech', label: 'Tech/Startup' },
];

export function LeadsScreen({ gateway }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  
  const leads = useLeads(gateway);
  const [showTypeModal, setShowTypeModal] = useState(false);

  const handleCallLead = (phone) => {
    if (phone) Linking.openURL(`tel:${phone}`);
  };

  const handleEmailLead = (email) => {
    if (email) Linking.openURL(`mailto:${email}`);
  };

  const handleOpenWebsite = (url) => {
    if (url) Linking.openURL(url);
  };

  const renderSourceStatus = () => {
    if (leads.sources.length === 0) return null;
    
    return (
      <View style={styles.sourcesBar}>
        <Text style={styles.sourcesTitle}>Available Sources</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sourcesList}>
          {leads.sources.map(s => (
            <View key={s.source} style={[styles.sourceChip, s.hasApiKey && styles.sourceChipActive]}>
              <View style={[styles.sourceIndicator, s.hasApiKey && styles.sourceIndicatorActive]} />
              <Text style={styles.sourceName}>{s.source.replace('_', ' ')}</Text>
            </View>
          ))}
        </ScrollView>
      </View>
    );
  };

  const renderSearchForm = () => (
    <View style={styles.searchForm}>
      <View style={styles.searchRow}>
        <View style={[styles.searchField, { flex: 2 }]}>
          <Text style={styles.fieldLabel}>SEARCH QUERY</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="e.g., restaurants, agencies..."
            placeholderTextColor={COLORS.textMuted}
            value={leads.searchQuery}
            onChangeText={leads.setSearchQuery}
            onSubmitEditing={leads.searchLeads}
          />
        </View>
        <View style={[styles.searchField, { flex: 1 }]}>
          <Text style={styles.fieldLabel}>LOCATION</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Bangkok, TH"
            placeholderTextColor={COLORS.textMuted}
            value={leads.searchLocation}
            onChangeText={leads.setSearchLocation}
          />
        </View>
      </View>

      <View style={styles.searchRow}>
        <View style={styles.searchField}>
          <Text style={styles.fieldLabel}>TYPE</Text>
          <TouchableOpacity style={styles.selectBtn} onPress={() => setShowTypeModal(true)}>
            <Text style={styles.selectBtnText}>
              {LEAD_TYPES.find(t => t.value === leads.searchType)?.label || 'Business'}
            </Text>
            <Ionicons name="chevron-down" size={14} color={COLORS.textMuted} />
          </TouchableOpacity>
        </View>
        <View style={styles.filterOptions}>
          <TouchableOpacity
            style={[styles.filterChip, leads.filterHasEmail && styles.filterChipActive]}
            onPress={() => leads.setFilterHasEmail(!leads.filterHasEmail)}
          >
            <Text style={[styles.filterChipText, leads.filterHasEmail && styles.filterChipTextActive]}>
              Has Email
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterChip, leads.filterHasPhone && styles.filterChipActive]}
            onPress={() => leads.setFilterHasPhone(!leads.filterHasPhone)}
          >
            <Text style={[styles.filterChipText, leads.filterHasPhone && styles.filterChipTextActive]}>
              Has Phone
            </Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[styles.searchBtn, (leads.searching || !leads.searchQuery.trim()) && styles.searchBtnDisabled]}
          onPress={leads.searchLeads}
          disabled={leads.searching || !leads.searchQuery.trim()}
        >
          {leads.searching ? (
            <ActivityIndicator size="small" color={COLORS.background} />
          ) : (
            <>
              <Ionicons name="search" size={16} color={COLORS.background} />
              <Text style={styles.searchBtnText}>Search</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderResultsHeader = () => {
    if (leads.leads.length === 0) return null;

    const allSelected = leads.selectedLeads.size === leads.leads.length;
    const hotCount = leads.leads.filter(l => l.quality === 'hot').length;

    return (
      <View style={styles.resultsHeader}>
        <View style={styles.resultsInfo}>
          <Text style={styles.resultsCount}>{leads.lastSearchTotal} results</Text>
          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{hotCount}</Text>
              <Text style={styles.statLabel}>Hot</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{leads.selectedLeads.size}</Text>
              <Text style={styles.statLabel}>Selected</Text>
            </View>
          </View>
        </View>
        <View style={styles.resultsActions}>
          <TouchableOpacity style={styles.selectAllBtn} onPress={leads.selectAllLeads}>
            <Text style={styles.selectAllBtnText}>
              {allSelected ? 'Deselect All' : 'Select All'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.crmBtn, (leads.selectedLeads.size === 0 || leads.savingToCRM) && styles.crmBtnDisabled]}
            onPress={leads.bulkSaveToCRM}
            disabled={leads.selectedLeads.size === 0 || leads.savingToCRM}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {!leads.savingToCRM && <Ionicons name="save-outline" size={13} color={COLORS.primary} />}
              <Text style={styles.crmBtnText}>
                {leads.savingToCRM ? 'Saving...' : `Save to CRM (${leads.selectedLeads.size})`}
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderLeadCard = ({ item: lead }) => {
    const isSelected = leads.selectedLeads.has(lead.id);
    const qualityColor = QUALITY_COLORS[lead.quality] || QUALITY_COLORS.unknown;

    return (
      <TouchableOpacity
        style={[styles.leadCard, isSelected && styles.leadCardSelected]}
        onPress={() => leads.toggleSelectLead(lead.id)}
        activeOpacity={0.8}
      >
        <View style={styles.leadCardHeader}>
          <TouchableOpacity
            style={[styles.checkbox, isSelected && styles.checkboxSelected]}
            onPress={() => leads.toggleSelectLead(lead.id)}
          >
            {isSelected && <Ionicons name="checkmark" size={14} color={COLORS.primary} />}
          </TouchableOpacity>
          <Text style={styles.leadName} numberOfLines={1}>{lead.companyName}</Text>
          <View style={[styles.qualityBadge, { backgroundColor: qualityColor }]}>
            <Text style={styles.qualityText}>{lead.quality?.toUpperCase()}</Text>
          </View>
        </View>

        {lead.industry && (
          <Text style={styles.leadIndustry}>{lead.industry}</Text>
        )}

        <View style={styles.leadDetails}>
          {(lead.email || lead.contactEmail) && (
            <TouchableOpacity 
              style={styles.leadDetail}
              onPress={() => handleEmailLead(lead.email || lead.contactEmail)}
            >
              <Ionicons name="mail-outline" size={12} color={COLORS.textMuted} style={styles.leadDetailIcon} />
              <Text style={styles.leadDetailValue} numberOfLines={1}>
                {lead.email || lead.contactEmail}
              </Text>
            </TouchableOpacity>
          )}
          {(lead.phone || lead.contactPhone) && (
            <TouchableOpacity 
              style={styles.leadDetail}
              onPress={() => handleCallLead(lead.phone || lead.contactPhone)}
            >
              <Ionicons name="call-outline" size={12} color={COLORS.textMuted} style={styles.leadDetailIcon} />
              <Text style={styles.leadDetailValue}>{lead.phone || lead.contactPhone}</Text>
            </TouchableOpacity>
          )}
          {lead.website && (
            <TouchableOpacity 
              style={styles.leadDetail}
              onPress={() => handleOpenWebsite(lead.website)}
            >
              <Ionicons name="globe-outline" size={12} color={COLORS.textMuted} style={styles.leadDetailIcon} />
              <Text style={styles.leadDetailValue} numberOfLines={1}>
                {new URL(lead.website).hostname}
              </Text>
            </TouchableOpacity>
          )}
          {lead.address && (
            <View style={styles.leadDetail}>
              <Ionicons name="location-outline" size={12} color={COLORS.textMuted} style={styles.leadDetailIcon} />
              <Text style={styles.leadDetailValue} numberOfLines={1}>{lead.address}</Text>
            </View>
          )}
          {lead.rating && (
            <View style={styles.leadDetail}>
              <Ionicons name="star" size={12} color={COLORS.primary} style={styles.leadDetailIcon} />
              <Text style={styles.leadDetailValue}>
                {lead.rating.toFixed(1)} ({lead.reviewCount || 0} reviews)
              </Text>
            </View>
          )}
          {lead.contactName && (
            <View style={styles.leadDetail}>
              <Ionicons name="person-outline" size={12} color={COLORS.textMuted} style={styles.leadDetailIcon} />
              <Text style={styles.leadDetailValue}>
                {lead.contactName}{lead.contactTitle ? ` - ${lead.contactTitle}` : ''}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.leadCardFooter}>
          <View style={styles.leadMeta}>
            <View style={styles.sourceBadge}>
              <Text style={styles.sourceBadgeText}>{lead.source?.replace('_', ' ')}</Text>
            </View>
            {lead.notionPageId && (
              <View style={styles.crmBadge}>
                <Text style={styles.crmBadgeText}>In CRM</Text>
              </View>
            )}
          </View>
          {!lead.notionPageId && (
            <TouchableOpacity
              style={styles.saveBtn}
              onPress={() => leads.saveToCRM(lead.id)}
              disabled={leads.savingToCRM}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="save-outline" size={12} color={COLORS.primary} />
                <Text style={styles.saveBtnText}>Save</Text>
              </View>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <Ionicons name="locate-outline" size={48} color={COLORS.textMuted} style={styles.emptyIcon} />
      <Text style={styles.emptyText}>
        Search for leads using the form above.{'\n'}Results will appear here.
      </Text>
    </View>
  );

  const renderTypeModal = () => (
    <Modal
      visible={showTypeModal}
      transparent
      animationType="fade"
      onRequestClose={() => setShowTypeModal(false)}
    >
      <TouchableOpacity 
        style={styles.modalOverlay}
        activeOpacity={1}
        onPress={() => setShowTypeModal(false)}
      >
        <View style={styles.typeModal}>
          <Text style={styles.typeModalTitle}>Lead Type</Text>
          {LEAD_TYPES.map(type => (
            <TouchableOpacity
              key={type.value}
              style={[styles.typeOption, leads.searchType === type.value && styles.typeOptionActive]}
              onPress={() => {
                leads.setSearchType(type.value);
                setShowTypeModal(false);
              }}
            >
              <Text style={[
                styles.typeOptionText,
                leads.searchType === type.value && styles.typeOptionTextActive
              ]}>
                {type.label}
              </Text>
              {leads.searchType === type.value && (
                <Ionicons name="checkmark" size={18} color={COLORS.primary} />
              )}
            </TouchableOpacity>
          ))}
        </View>
      </TouchableOpacity>
    </Modal>
  );

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="locate-outline" size={28} color={COLORS.primary} />
          <View>
            <Text style={styles.headerTitle}>Lead Generation</Text>
            <Text style={styles.headerSub}>Find and qualify business leads</Text>
          </View>
        </View>
        <TouchableOpacity 
          style={styles.settingsBtn}
          onPress={() => leads.setShowSettings(!leads.showSettings)}
        >
          <Ionicons name="settings-outline" size={20} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      {/* Error */}
      {leads.error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{leads.error}</Text>
          <TouchableOpacity onPress={leads.clearError}>
            <Ionicons name="close" size={18} color="#fca5a5" />
          </TouchableOpacity>
        </View>
      )}

      {renderSourceStatus()}
      {renderSearchForm()}
      {renderResultsHeader()}

      {/* Results */}
      <FlatList
        data={leads.leads}
        keyExtractor={item => item.id}
        renderItem={renderLeadCard}
        contentContainerStyle={styles.listContent}
        numColumns={isTablet ? 2 : 1}
        key={isTablet ? 'tablet' : 'phone'}
        columnWrapperStyle={isTablet ? styles.gridRow : undefined}
        ListEmptyComponent={renderEmptyState}
        refreshControl={
          <RefreshControl
            refreshing={leads.searching}
            onRefresh={leads.searchLeads}
            tintColor={COLORS.primary}
          />
        }
      />

      {renderTypeModal()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerIcon: {
    fontSize: 28,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
  },
  headerSub: {
    fontSize: 11,
    color: COLORS.textMuted,
  },
  settingsBtn: {
    padding: 8,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    borderRadius: 8,
  },

  // Error
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(239,68,68,0.2)',
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: '#fca5a5',
  },

  // Sources
  sourcesBar: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.03)',
  },
  sourcesTitle: {
    fontSize: 9,
    fontWeight: '700',
    color: COLORS.textMuted,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  sourcesList: {
    gap: 8,
  },
  sourceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 4,
    opacity: 0.5,
  },
  sourceChipActive: {
    opacity: 1,
  },
  sourceIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#ef4444',
  },
  sourceIndicatorActive: {
    backgroundColor: '#22c55e',
  },
  sourceName: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.text,
    textTransform: 'capitalize',
  },

  // Search Form
  searchForm: {
    padding: 12,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(10,10,10,0.8)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  searchRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  searchField: {
    minWidth: 120,
  },
  fieldLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: COLORS.textMuted,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  searchInput: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: COLORS.text,
  },
  selectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minWidth: 140,
  },
  selectBtnText: {
    fontSize: 14,
    color: COLORS.text,
  },
  // Sized to its chips (never shrunk under the Search button); the row wraps
  // on narrow phones and the button takes the next line.
  filterOptions: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    flexShrink: 0,
  },
  filterChip: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 6,
  },
  filterChipActive: {
    backgroundColor: COLORS.cardBorder,
    borderColor: COLORS.primaryStrong,
  },
  filterChipText: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  filterChipTextActive: {
    color: COLORS.primary,
  },
  searchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-end',
    flexGrow: 1,
    minHeight: 44,
    gap: 6,
    backgroundColor: COLORS.primary,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 6,
  },
  searchBtnDisabled: {
    opacity: 0.5,
  },
  searchBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.background,
  },

  // Results Header
  resultsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
    flexWrap: 'wrap',
    gap: 10,
  },
  resultsInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  resultsCount: {
    fontSize: 13,
    color: COLORS.textMuted,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  stat: {
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 6,
  },
  statValue: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.primary,
  },
  statLabel: {
    fontSize: 9,
    color: COLORS.textMuted,
    textTransform: 'uppercase',
  },
  resultsActions: {
    flexDirection: 'row',
    gap: 8,
  },
  selectAllBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 6,
  },
  selectAllBtnText: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  crmBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: COLORS.cardBorder,
    borderWidth: 1,
    borderColor: COLORS.primaryStrong,
    borderRadius: 6,
  },
  crmBtnDisabled: {
    opacity: 0.5,
  },
  crmBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.primary,
  },

  // List
  listContent: {
    padding: 16,
  },
  gridRow: {
    gap: 12,
  },

  // Lead Card
  leadCard: {
    flex: 1,
    backgroundColor: 'rgba(10,10,10,0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
  },
  leadCardSelected: {
    borderColor: COLORS.primaryStrong,
    backgroundColor: COLORS.primaryDim,
  },
  leadCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.cardBorder,
  },
  leadName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
  },
  qualityBadge: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  qualityText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.5,
  },
  leadIndustry: {
    fontSize: 11,
    color: '#a78bfa',
    marginBottom: 10,
    textTransform: 'capitalize',
  },
  leadDetails: {
    gap: 6,
    marginBottom: 12,
  },
  leadDetail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  leadDetailIcon: {
    fontSize: 12,
    width: 18,
    textAlign: 'center',
  },
  leadDetailValue: {
    flex: 1,
    fontSize: 12,
    color: COLORS.textMuted,
  },
  leadCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  leadMeta: {
    flexDirection: 'row',
    gap: 6,
  },
  sourceBadge: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(139,92,246,0.15)',
    borderRadius: 4,
  },
  sourceBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#a78bfa',
    textTransform: 'uppercase',
  },
  crmBadge: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(34,197,94,0.15)',
    borderRadius: 4,
  },
  crmBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#22c55e',
    textTransform: 'uppercase',
  },
  saveBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    borderRadius: 4,
  },
  saveBtnText: {
    fontSize: 11,
    color: COLORS.primary,
  },

  // Empty State
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 60,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
    opacity: 0.3,
  },
  emptyText: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },

  // Type Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  typeModal: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    borderRadius: 12,
    padding: 16,
    width: '80%',
    maxWidth: 300,
  },
  typeModalTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  typeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  typeOptionActive: {
    backgroundColor: COLORS.cardBorder,
  },
  typeOptionText: {
    fontSize: 14,
    color: COLORS.text,
  },
  typeOptionTextActive: {
    color: COLORS.primary,
    fontWeight: '600',
  },
});

export default LeadsScreen;
