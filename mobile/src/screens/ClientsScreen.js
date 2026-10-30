/**
 * ClientsScreen — CRM with grid/table/kanban views
 * Matches web UI gold/black HUD theme
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  FlatList, Modal, Alert, useWindowDimensions, ActivityIndicator, RefreshControl
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GLASS } from '../constants/theme';
import { useClients, getClientName } from '../hooks/useClients';

// Helpers
function hashColor(str) {
  if (!str) str = '?';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function initials(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

const STATUS_COLORS = {
  default: { bg: 'rgba(107,114,128,0.1)', text: '#6b7280' },
  gray: { bg: 'rgba(107,114,128,0.1)', text: '#6b7280' },
  blue: { bg: 'rgba(59,130,246,0.1)', text: '#3b82f6' },
  green: { bg: 'rgba(34,197,94,0.1)', text: '#22c55e' },
  yellow: { bg: COLORS.cardBorder, text: COLORS.primary },
  orange: { bg: 'rgba(234,88,12,0.1)', text: '#ea580c' },
  red: { bg: 'rgba(239,68,68,0.1)', text: '#ef4444' },
  purple: { bg: 'rgba(168,85,247,0.1)', text: '#a855f7' },
  pink: { bg: 'rgba(236,72,153,0.1)', text: '#ec4899' },
};

export function ClientsScreen({ navigation, gateway }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  
  const clients = useClients(gateway);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [formData, setFormData] = useState({});

  // Get groupable properties for kanban
  const groupableProps = useMemo(() => {
    if (!clients.schema) return [];
    return Object.entries(clients.schema.properties || {})
      .filter(([_, p]) => p.type === 'select' || p.type === 'status')
      .map(([name, prop]) => ({ name, ...prop }));
  }, [clients.schema]);

  // Get status options
  const statusOptions = useMemo(() => {
    if (!clients.schema || !clients.kanbanGroupBy) return [];
    const prop = clients.schema.properties?.[clients.kanbanGroupBy];
    return prop?.options || [];
  }, [clients.schema, clients.kanbanGroupBy]);

  // Set default groupBy
  React.useEffect(() => {
    if (groupableProps.length > 0 && !clients.kanbanGroupBy) {
      clients.setKanbanGroupBy(groupableProps[0].name);
    }
  }, [groupableProps]);

  const handleCreateClient = async () => {
    if (!formData.name?.trim()) {
      Alert.alert('Error', 'Please enter a name');
      return;
    }
    await clients.createClient(formData);
    setShowCreateModal(false);
    setFormData({});
  };

  const handleSelectClient = (client) => {
    // Navigate to full customer profile screen with Notion page ID
    if (client.notionId || client.id) {
      navigation.navigate('CustomerProfile', {
        pageId: client.notionId || client.id,
        clientData: client,
      });
    } else {
      // Fallback to simple modal if no Notion ID
      clients.setSelectedClient(client);
      setShowDetailModal(true);
    }
  };

  const handleDeleteClient = (client) => {
    Alert.alert(
      'Delete Client',
      `Delete "${getClientName(client, clients.schema)}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            clients.deleteClient(client.id);
            setShowDetailModal(false);
          }
        }
      ]
    );
  };

  const renderTopBar = () => (
    <View style={styles.topBar}>
      <View style={styles.topBarLeft}>
        <Text style={styles.badge}>CRM</Text>
        <Text style={styles.count}>{clients.clients.length} clients</Text>
        <View style={styles.viewToggle}>
          {['grid', 'table', 'kanban'].map(v => (
            <TouchableOpacity
              key={v}
              style={[styles.viewBtn, clients.viewMode === v && styles.viewBtnActive]}
              onPress={() => clients.setViewMode(v)}
            >
              <Ionicons
                name={v === 'grid' ? 'grid' : v === 'table' ? 'list' : 'albums'}
                size={14}
                color={clients.viewMode === v ? COLORS.primary : COLORS.textMuted}
              />
            </TouchableOpacity>
          ))}
        </View>
        {clients.viewMode === 'kanban' && groupableProps.length > 0 && (
          <TouchableOpacity style={styles.groupSelect}>
            <Text style={styles.groupSelectText}>
              Group: {clients.kanbanGroupBy || groupableProps[0]?.name}
            </Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={styles.topBarRight}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search..."
          placeholderTextColor={COLORS.textMuted}
          value={clients.searchQuery}
          onChangeText={clients.setSearchQuery}
        />
        <TouchableOpacity 
          style={styles.addBtn}
          onPress={() => {
            setFormData({});
            setShowCreateModal(true);
          }}
        >
          <Text style={styles.addBtnText}>+ ADD</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.refreshBtn} onPress={clients.loadClients}>
          <Ionicons name="refresh" size={16} color={COLORS.textMuted} />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderClientCard = ({ item: client }) => {
    const name = getClientName(client, clients.schema);
    const color = hashColor(name);
    const company = client.data?.Company || null;

    // Find status
    let statusVal = null;
    let statusColor = STATUS_COLORS.default;
    if (clients.schema) {
      for (const [pname, prop] of Object.entries(clients.schema.properties || {})) {
        if ((prop.type === 'status' || prop.type === 'select') && client.data?.[pname]) {
          statusVal = client.data[pname];
          const opt = prop.options?.find(o => o.name === statusVal);
          statusColor = STATUS_COLORS[opt?.color] || STATUS_COLORS.default;
          break;
        }
      }
    }

    // Get email/phone
    const email = Object.entries(client.data || {}).find(([k, v]) => 
      clients.schema?.properties?.[k]?.type === 'email' && v
    )?.[1];
    const phone = Object.entries(client.data || {}).find(([k, v]) => 
      clients.schema?.properties?.[k]?.type === 'phone_number' && v
    )?.[1];

    return (
      <TouchableOpacity
        style={[styles.clientCard, isTablet && styles.clientCardTablet]}
        onPress={() => handleSelectClient(client)}
      >
        <View style={styles.cardHeader}>
          <View style={[styles.avatar, { backgroundColor: color }]}>
            <Text style={styles.avatarText}>{initials(name)}</Text>
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.cardName} numberOfLines={1}>{name}</Text>
            {company && <Text style={styles.cardCompany} numberOfLines={1}>{company}</Text>}
          </View>
        </View>
        <View style={styles.cardDetails}>
          {email && (
            <View style={styles.cardDetail}>
              <Ionicons name="mail-outline" size={11} color={COLORS.textMuted} />
              <Text style={styles.detailValue} numberOfLines={1}>{email}</Text>
            </View>
          )}
          {phone && (
            <View style={styles.cardDetail}>
              <Ionicons name="call-outline" size={11} color={COLORS.textMuted} />
              <Text style={styles.detailValue}>{phone}</Text>
            </View>
          )}
        </View>
        <View style={styles.cardFooter}>
          {statusVal && (
            <View style={[styles.statusBadge, { backgroundColor: statusColor.bg }]}>
              <Text style={[styles.statusText, { color: statusColor.text }]}>{statusVal}</Text>
            </View>
          )}
          <Text style={styles.cardTime}>{timeAgo(client.updated_at)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderGridView = () => (
    <FlatList
      data={clients.clients}
      keyExtractor={item => item.id}
      renderItem={renderClientCard}
      contentContainerStyle={styles.gridContent}
      numColumns={isTablet ? 2 : 1}
      key={isTablet ? 'tablet' : 'phone'}
      columnWrapperStyle={isTablet ? styles.gridRow : undefined}
      refreshControl={
        <RefreshControl
          refreshing={clients.loading}
          onRefresh={clients.loadClients}
          tintColor={COLORS.primary}
        />
      }
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>◇</Text>
          <Text style={styles.emptyText}>NO CLIENTS YET</Text>
          <TouchableOpacity 
            style={styles.emptyBtn}
            onPress={() => setShowCreateModal(true)}
          >
            <Text style={styles.emptyBtnText}>+ ADD CLIENT</Text>
          </TouchableOpacity>
        </View>
      }
    />
  );

  const renderTableView = () => {
    // Get columns from schema
    const columns = [];
    if (clients.schema) {
      // Title first
      Object.entries(clients.schema.properties || {}).forEach(([name, prop]) => {
        if (prop.type === 'title') columns.push({ name, prop });
      });
      // Then others (limit)
      Object.entries(clients.schema.properties || {}).slice(0, 5).forEach(([name, prop]) => {
        if (prop.type !== 'title' && prop.type !== 'files') {
          columns.push({ name, prop });
        }
      });
    }

    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.table}>
          {/* Header */}
          <View style={styles.tableHeader}>
            {columns.map(col => (
              <View key={col.name} style={styles.tableHeaderCell}>
                <Text style={styles.tableHeaderText}>{col.name}</Text>
              </View>
            ))}
            <View style={styles.tableHeaderCell}>
              <Text style={styles.tableHeaderText}>Updated</Text>
            </View>
          </View>
          {/* Rows */}
          <ScrollView 
            refreshControl={
              <RefreshControl
                refreshing={clients.loading}
                onRefresh={clients.loadClients}
                tintColor={COLORS.primary}
              />
            }
          >
            {clients.clients.map(client => {
              const name = getClientName(client, clients.schema);
              const color = hashColor(name);
              
              return (
                <TouchableOpacity
                  key={client.id}
                  style={styles.tableRow}
                  onPress={() => handleSelectClient(client)}
                >
                  {columns.map(col => {
                    const val = client.data?.[col.name];
                    
                    if (col.prop.type === 'title') {
                      return (
                        <View key={col.name} style={[styles.tableCell, styles.tableCellName]}>
                          <View style={[styles.tableAvatar, { backgroundColor: color }]}>
                            <Text style={styles.tableAvatarText}>{initials(name)}</Text>
                          </View>
                          <Text style={styles.tableCellText} numberOfLines={1}>{val || '—'}</Text>
                        </View>
                      );
                    }
                    if (col.prop.type === 'select' || col.prop.type === 'status') {
                      const opt = col.prop.options?.find(o => o.name === val);
                      const statusColor = STATUS_COLORS[opt?.color] || STATUS_COLORS.default;
                      return (
                        <View key={col.name} style={styles.tableCell}>
                          {val ? (
                            <View style={[styles.statusBadge, { backgroundColor: statusColor.bg }]}>
                              <Text style={[styles.statusText, { color: statusColor.text }]}>{val}</Text>
                            </View>
                          ) : <Text style={styles.tableCellDim}>—</Text>}
                        </View>
                      );
                    }
                    return (
                      <View key={col.name} style={styles.tableCell}>
                        <Text style={styles.tableCellDim} numberOfLines={1}>{val || '—'}</Text>
                      </View>
                    );
                  })}
                  <View style={styles.tableCell}>
                    <Text style={styles.tableCellDim}>{timeAgo(client.updated_at)}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </ScrollView>
    );
  };

  const renderKanbanView = () => {
    const columnOrder = statusOptions.map(o => o.name);
    if (clients.clientsByGroup['—']?.length) columnOrder.push('—');

    return (
      <ScrollView 
        horizontal 
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.kanbanContainer}
      >
        {columnOrder.map(colName => {
          const colClients = clients.clientsByGroup[colName] || [];
          const opt = statusOptions.find(o => o.name === colName);
          const colColor = STATUS_COLORS[opt?.color]?.text || COLORS.textMuted;

          return (
            <View key={colName} style={styles.kanbanCol}>
              <View style={[styles.kanbanHeader, { borderLeftColor: colColor }]}>
                <Text style={[styles.kanbanHeaderText, { color: colColor }]}>{colName}</Text>
                <View style={styles.kanbanCount}>
                  <Text style={styles.kanbanCountText}>{colClients.length}</Text>
                </View>
              </View>
              <ScrollView style={styles.kanbanCards}>
                {colClients.map(client => {
                  const name = getClientName(client, clients.schema);
                  const company = client.data?.Company;

                  return (
                    <TouchableOpacity
                      key={client.id}
                      style={styles.kanbanCard}
                      onPress={() => handleSelectClient(client)}
                    >
                      <Text style={styles.kanbanCardName} numberOfLines={1}>{name}</Text>
                      {company && (
                        <Text style={styles.kanbanCardCompany} numberOfLines={1}>{company}</Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          );
        })}
      </ScrollView>
    );
  };

  const renderCreateModal = () => (
    <Modal
      visible={showCreateModal}
      animationType="slide"
      transparent
      onRequestClose={() => setShowCreateModal(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.createModal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>ADD CLIENT</Text>
            <TouchableOpacity onPress={() => setShowCreateModal(false)}>
              <Ionicons name="close" size={24} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody}>
            <View style={styles.formGroup}>
              <Text style={styles.formLabel}>NAME *</Text>
              <TextInput
                style={styles.formInput}
                placeholder="Client name"
                placeholderTextColor={COLORS.textMuted}
                value={formData.name || ''}
                onChangeText={v => setFormData(f => ({ ...f, name: v }))}
              />
            </View>
            <View style={styles.formGroup}>
              <Text style={styles.formLabel}>COMPANY</Text>
              <TextInput
                style={styles.formInput}
                placeholder="Company name"
                placeholderTextColor={COLORS.textMuted}
                value={formData.Company || ''}
                onChangeText={v => setFormData(f => ({ ...f, Company: v }))}
              />
            </View>
            <View style={styles.formGroup}>
              <Text style={styles.formLabel}>EMAIL</Text>
              <TextInput
                style={styles.formInput}
                placeholder="email@example.com"
                placeholderTextColor={COLORS.textMuted}
                keyboardType="email-address"
                value={formData.Email || ''}
                onChangeText={v => setFormData(f => ({ ...f, Email: v }))}
              />
            </View>
            <View style={styles.formGroup}>
              <Text style={styles.formLabel}>PHONE</Text>
              <TextInput
                style={styles.formInput}
                placeholder="+1 234 567 8900"
                placeholderTextColor={COLORS.textMuted}
                keyboardType="phone-pad"
                value={formData.Phone || ''}
                onChangeText={v => setFormData(f => ({ ...f, Phone: v }))}
              />
            </View>
          </ScrollView>
          <View style={styles.modalFooter}>
            <TouchableOpacity 
              style={styles.cancelBtn}
              onPress={() => setShowCreateModal(false)}
            >
              <Text style={styles.cancelBtnText}>CANCEL</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.createBtn}
              onPress={handleCreateClient}
            >
              <Text style={styles.createBtnText}>CREATE</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  const renderDetailModal = () => {
    const client = clients.selectedClient;
    if (!client) return null;

    const name = getClientName(client, clients.schema);
    const color = hashColor(name);
    const company = client.data?.Company;

    return (
      <Modal
        visible={showDetailModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowDetailModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.detailModal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>◆ CLIENT DETAILS</Text>
              <TouchableOpacity onPress={() => setShowDetailModal(false)}>
                <Ionicons name="close" size={24} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.detailBody}>
              <View style={[styles.detailAvatar, { backgroundColor: color }]}>
                <Text style={styles.detailAvatarText}>{initials(name)}</Text>
              </View>
              <Text style={styles.detailName}>{name}</Text>
              {company && <Text style={styles.detailCompany}>{company}</Text>}

              <View style={styles.detailSection}>
                <Text style={styles.sectionTitle}>CONTACT</Text>
                {Object.entries(client.data || {}).map(([key, val]) => {
                  const prop = clients.schema?.properties?.[key];
                  if (!val || prop?.type === 'title' || prop?.type === 'files') return null;
                  return (
                    <View key={key} style={styles.detailRow}>
                      <Text style={styles.detailLabel}>{key}</Text>
                      <Text style={styles.detailValue}>{String(val)}</Text>
                    </View>
                  );
                })}
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.sectionTitle}>SYSTEM</Text>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Created</Text>
                  <Text style={styles.detailValue}>
                    {new Date(client.created_at).toLocaleDateString()}
                  </Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Updated</Text>
                  <Text style={styles.detailValue}>{timeAgo(client.updated_at)}</Text>
                </View>
              </View>
            </ScrollView>
            <View style={styles.modalFooter}>
              <TouchableOpacity 
                style={styles.deleteClientBtn}
                onPress={() => handleDeleteClient(client)}
              >
                <Text style={styles.deleteClientBtnText}>DELETE</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.closeDetailBtn}
                onPress={() => setShowDetailModal(false)}
              >
                <Text style={styles.closeDetailBtnText}>CLOSE</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      {/* Success/Error */}
      {clients.success && (
        <View style={styles.successBar}>
          <Text style={styles.successText}>{clients.success}</Text>
        </View>
      )}
      {clients.error && (
        <View style={styles.errorBar}>
          <Ionicons name="warning-outline" size={13} color="#f87171" style={{ marginRight: 6 }} />
          <Text style={styles.errorText}>{clients.error}</Text>
          <TouchableOpacity onPress={clients.clearError}>
            <Ionicons name="close" size={18} color="#f87171" />
          </TouchableOpacity>
        </View>
      )}

      {renderTopBar()}

      {/* Content */}
      {clients.loading && clients.clients.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={styles.loadingText}>LOADING CLIENTS</Text>
        </View>
      ) : clients.viewMode === 'grid' ? (
        renderGridView()
      ) : clients.viewMode === 'table' ? (
        renderTableView()
      ) : (
        renderKanbanView()
      )}

      {renderCreateModal()}
      {renderDetailModal()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  // Top Bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primaryDim,
    flexWrap: 'wrap',
    gap: 8,
  },
  topBarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  topBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badge: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: COLORS.goldDim,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
    backgroundColor: COLORS.primaryDim,
  },
  count: {
    fontSize: 9,
    color: COLORS.textMuted,
  },
  viewToggle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 4,
    overflow: 'hidden',
  },
  viewBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRightWidth: 1,
    borderRightColor: COLORS.primaryDim,
  },
  viewBtnActive: {
    backgroundColor: COLORS.cardBorder,
  },
  groupSelect: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 4,
  },
  groupSelectText: {
    fontSize: 10,
    color: COLORS.textMuted,
  },
  searchInput: {
    backgroundColor: 'rgba(10,10,10,1)',
    borderWidth: 1,
    borderColor: COLORS.primaryDim,
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 10,
    color: COLORS.text,
    width: 140,
  },
  addBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
    backgroundColor: COLORS.primaryDim,
  },
  addBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.goldDim,
    letterSpacing: 0.5,
  },
  refreshBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },

  // Success/Error
  successBar: {
    padding: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(34,197,94,0.06)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(34,197,94,0.15)',
  },
  successText: {
    fontSize: 11,
    color: '#4ade80',
  },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(220,38,38,0.06)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(220,38,38,0.15)',
  },
  errorText: {
    flex: 1,
    fontSize: 11,
    color: '#f87171',
  },

  // Loading
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 12,
    color: COLORS.textMuted,
    letterSpacing: 1.5,
  },

  // Grid View
  gridContent: {
    padding: 12,
  },
  gridRow: {
    gap: 12,
  },
  clientCard: {
    flex: 1,
    backgroundColor: 'rgba(8,8,8,1)',
    borderWidth: 1,
    borderColor: COLORS.primaryDim,
    padding: 14,
    marginBottom: 12,
  },
  clientCardTablet: {
    maxWidth: '49%',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.5,
  },
  cardInfo: {
    flex: 1,
  },
  cardName: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.text,
  },
  cardCompany: {
    fontSize: 9,
    color: COLORS.textMuted,
    marginTop: 1,
  },
  cardDetails: {
    gap: 4,
    marginBottom: 8,
  },
  cardDetail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailIcon: {
    fontSize: 10,
    opacity: 0.5,
  },
  detailValue: {
    flex: 1,
    fontSize: 9,
    color: COLORS.textMuted,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusBadge: {
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 2,
  },
  statusText: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  cardTime: {
    fontSize: 8,
    color: '#3f3f46',
  },

  // Empty State
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 60,
  },
  emptyIcon: {
    fontSize: 40,
    opacity: 0.2,
    marginBottom: 14,
  },
  emptyText: {
    fontSize: 11,
    color: '#3f3f46',
    letterSpacing: 1.5,
    marginBottom: 16,
  },
  emptyBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: COLORS.primaryStrong,
    backgroundColor: COLORS.primaryLight,
  },
  emptyBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 0.5,
  },

  // Table View
  table: {
    minWidth: 600,
  },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primaryDim,
  },
  tableHeaderCell: {
    width: 120,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  tableHeaderText: {
    fontSize: 8,
    fontWeight: '700',
    color: COLORS.textMuted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.02)',
  },
  tableCell: {
    width: 120,
    paddingVertical: 10,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  tableCellName: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: 160,
  },
  tableAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tableAvatarText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#fff',
  },
  tableCellText: {
    fontSize: 10,
    fontWeight: '600',
    color: COLORS.text,
    flex: 1,
  },
  tableCellDim: {
    fontSize: 10,
    color: COLORS.textMuted,
  },

  // Kanban View
  kanbanContainer: {
    padding: 12,
    gap: 12,
  },
  kanbanCol: {
    width: 260,
    backgroundColor: 'rgba(6,6,6,1)',
    borderWidth: 1,
    borderColor: COLORS.primaryDim,
    borderRadius: 4,
    maxHeight: 500,
  },
  kanbanHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primaryDim,
    borderLeftWidth: 2,
  },
  kanbanHeaderText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  kanbanCount: {
    paddingVertical: 1,
    paddingHorizontal: 5,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 2,
  },
  kanbanCountText: {
    fontSize: 8,
    color: COLORS.textMuted,
  },
  kanbanCards: {
    padding: 8,
    gap: 6,
  },
  kanbanCard: {
    padding: 10,
    backgroundColor: 'rgba(10,10,10,1)',
    borderWidth: 1,
    borderColor: COLORS.primaryDim,
    marginBottom: 6,
  },
  kanbanCardName: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 3,
  },
  kanbanCardCompany: {
    fontSize: 9,
    color: COLORS.textMuted,
  },

  // Modals
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  createModal: {
    backgroundColor: '#0c0c0c',
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    width: '90%',
    maxWidth: 400,
    maxHeight: '80%',
  },
  detailModal: {
    backgroundColor: '#060606',
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    width: '90%',
    maxWidth: 400,
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primaryDim,
  },
  modalTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 1.5,
  },
  modalBody: {
    padding: 16,
  },
  modalFooter: {
    flexDirection: 'row',
    gap: 8,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.primaryDim,
  },
  formGroup: {
    marginBottom: 14,
  },
  formLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: COLORS.textMuted,
    letterSpacing: 1.5,
    marginBottom: 5,
  },
  formInput: {
    backgroundColor: 'rgba(10,10,10,1)',
    borderWidth: 1,
    borderColor: COLORS.primaryDim,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 11,
    color: COLORS.text,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  cancelBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.textMuted,
    letterSpacing: 1,
  },
  createBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: COLORS.primaryLight,
    borderWidth: 1,
    borderColor: COLORS.primaryStrong,
  },
  createBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 1,
  },

  // Detail Modal
  detailBody: {
    padding: 16,
  },
  detailAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 12,
  },
  detailAvatarText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
  },
  detailName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
    marginBottom: 2,
  },
  detailCompany: {
    fontSize: 10,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginBottom: 16,
  },
  detailSection: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 8,
    fontWeight: '700',
    color: COLORS.goldDim,
    letterSpacing: 2,
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primaryDim,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  detailLabel: {
    fontSize: 10,
    color: COLORS.textMuted,
  },
  deleteClientBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
  },
  deleteClientBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#f87171',
    letterSpacing: 1,
  },
  closeDetailBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
  },
  closeDetailBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.goldDim,
    letterSpacing: 1,
  },
});

export default ClientsScreen;
