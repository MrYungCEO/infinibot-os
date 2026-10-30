/**
 * IncomeStreamsScreen — Manage Income Streams
 * View, create, and edit recurring income sources
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Modal,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../constants/theme';

const STREAM_TYPES = [
  { key: 'recurring', label: 'Recurring', icon: 'repeat' },
  { key: 'one-time', label: 'One-time', icon: 'flash' },
  { key: 'passive', label: 'Passive', icon: 'trending-up' },
  { key: 'active', label: 'Active', icon: 'construct' },
];

const STREAM_SOURCES = [
  { key: 'whop', label: 'Whop' },
  { key: 'stripe', label: 'Stripe' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'crypto', label: 'Crypto' },
  { key: 'freelance', label: 'Freelance' },
  { key: 'consulting', label: 'Consulting' },
  { key: 'other', label: 'Other' },
];

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount || 0);
}

export function IncomeStreamsScreen({ navigation, gateway }) {
  const [streams, setStreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingStream, setEditingStream] = useState(null);
  const [form, setForm] = useState({
    name: '',
    type: 'recurring',
    source: 'other',
    expectedMonthly: '',
    isActive: true,
  });

  // There is no dedicated "list streams" RPC — streams ride along on
  // `business.income.stats` as `incomeStreams` (scoped to the active business).
  const loadStreams = useCallback(async () => {
    if (!gateway?.sendReq) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setError(null);
    try {
      const result = await gateway.sendReq('business.income.stats', {});
      setStreams(Array.isArray(result?.incomeStreams) ? result.incomeStreams : []);
    } catch (err) {
      setError(err?.message || 'Failed to load income streams');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [gateway]);

  useEffect(() => {
    loadStreams();
  }, [loadStreams]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadStreams();
  }, [loadStreams]);

  const handleCreate = () => {
    setEditingStream(null);
    setForm({
      name: '',
      type: 'recurring',
      source: 'other',
      expectedMonthly: '',
      isActive: true,
    });
    setModalVisible(true);
  };

  const handleEdit = (stream) => {
    setEditingStream(stream);
    setForm({
      name: stream.name || '',
      type: stream.type || 'recurring',
      source: stream.source || 'other',
      expectedMonthly: stream.expectedMonthly?.toString() || '',
      isActive: stream.isActive !== false,
    });
    setModalVisible(true);
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      Alert.alert('Error', 'Please enter a stream name');
      return;
    }

    try {
      await gateway.sendReq?.('business.income.upsertStream', {
        // The handler matches an existing stream on `id`; anything else creates a new one.
        id: editingStream?.id,
        ...form,
        name: form.name.trim(),
        expectedMonthly: parseFloat(form.expectedMonthly) || 0,
      });
      setModalVisible(false);
      loadStreams();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save stream');
    }
  };

  const totalExpected = streams.reduce((sum, s) => sum + (s.expectedMonthly || 0), 0);
  const activeStreams = streams.filter(s => s.isActive !== false);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Loading income streams...</Text>
      </View>
    );
  }

  if (error && streams.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <Ionicons name="warning-outline" size={40} color={COLORS.textMuted} />
        <Text style={styles.loadingText}>{error}</Text>
        <TouchableOpacity
          style={[styles.addButton, { marginTop: 16, paddingHorizontal: 24 }]}
          onPress={() => {
            setLoading(true);
            loadStreams();
          }}
        >
          <Ionicons name="refresh" size={18} color="#000" />
          <Text style={styles.addButtonText}>RETRY</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.primary}
          />
        }
      >
        {/* Header Stats */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>TOTAL STREAMS</Text>
            <Text style={styles.statValue}>{streams.length}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>ACTIVE</Text>
            <Text style={[styles.statValue, { color: '#00FF41' }]}>{activeStreams.length}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>EXPECTED/MO</Text>
            <Text style={[styles.statValue, { color: COLORS.primary }]}>{formatCurrency(totalExpected)}</Text>
          </View>
        </View>

        {/* Add Stream Button */}
        <TouchableOpacity style={styles.addButton} onPress={handleCreate}>
          <Ionicons name="add" size={20} color="#000" />
          <Text style={styles.addButtonText}>ADD INCOME STREAM</Text>
        </TouchableOpacity>

        {/* Stream List */}
        {streams.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="trending-up" size={48} color={COLORS.textMuted} />
            <Text style={styles.emptyText}>No income streams yet</Text>
            <Text style={styles.emptySubtext}>Add your first income stream to start tracking</Text>
          </View>
        ) : (
          streams.map((stream) => (
            <TouchableOpacity
              key={stream.id}
              style={styles.streamCard}
              onPress={() => handleEdit(stream)}
            >
              <LinearGradient
                colors={['rgba(10,10,10,0.95)', 'rgba(5,5,5,0.98)']}
                style={styles.streamCardGradient}
              >
                <View style={[
                  styles.streamIndicator,
                  { backgroundColor: stream.isActive !== false ? '#00FF41' : COLORS.textMuted }
                ]} />
                
                <View style={styles.streamHeader}>
                  <View style={styles.streamIconWrap}>
                    <Ionicons
                      name={STREAM_TYPES.find(t => t.key === stream.type)?.icon || 'cash'}
                      size={18}
                      color={COLORS.primary}
                    />
                  </View>
                  <View style={styles.streamInfo}>
                    <Text style={styles.streamName}>{stream.name}</Text>
                    <Text style={styles.streamMeta}>
                      {stream.type} • {stream.source}
                    </Text>
                  </View>
                  <View style={styles.streamAmount}>
                    <Text style={styles.streamAmountValue}>
                      {formatCurrency(stream.expectedMonthly)}
                    </Text>
                    <Text style={styles.streamAmountLabel}>/month</Text>
                  </View>
                </View>
              </LinearGradient>
            </TouchableOpacity>
          ))
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Add/Edit Modal */}
      <Modal visible={modalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingStream ? 'EDIT STREAM' : 'ADD STREAM'}
              </Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={24} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Stream Name</Text>
            <TextInput
              style={styles.input}
              value={form.name}
              onChangeText={(text) => setForm(f => ({ ...f, name: text }))}
              placeholder="e.g., Whop Memberships"
              placeholderTextColor={COLORS.textMuted}
            />

            <Text style={styles.inputLabel}>Expected Monthly ($)</Text>
            <TextInput
              style={styles.input}
              value={form.expectedMonthly}
              onChangeText={(text) => setForm(f => ({ ...f, expectedMonthly: text }))}
              placeholder="0"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="numeric"
            />

            <Text style={styles.inputLabel}>Type</Text>
            <View style={styles.optionGrid}>
              {STREAM_TYPES.map((type) => (
                <TouchableOpacity
                  key={type.key}
                  style={[styles.optionBtn, form.type === type.key && styles.optionBtnActive]}
                  onPress={() => setForm(f => ({ ...f, type: type.key }))}
                >
                  <Ionicons
                    name={type.icon}
                    size={14}
                    color={form.type === type.key ? '#000' : COLORS.textMuted}
                  />
                  <Text style={[
                    styles.optionBtnText,
                    form.type === type.key && styles.optionBtnTextActive
                  ]}>
                    {type.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.inputLabel}>Source</Text>
            <View style={styles.optionGrid}>
              {STREAM_SOURCES.map((src) => (
                <TouchableOpacity
                  key={src.key}
                  style={[styles.optionBtn, form.source === src.key && styles.optionBtnActive]}
                  onPress={() => setForm(f => ({ ...f, source: src.key }))}
                >
                  <Text style={[
                    styles.optionBtnText,
                    form.source === src.key && styles.optionBtnTextActive
                  ]}>
                    {src.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit}>
              <LinearGradient
                colors={[COLORS.primary, '#D4AF37']}
                style={styles.submitBtnGradient}
              >
                <Text style={styles.submitBtnText}>
                  {editingStream ? 'UPDATE STREAM' : 'ADD STREAM'}
                </Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    color: COLORS.textMuted,
    fontSize: 14,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: 'rgba(10,10,10,0.9)',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    padding: 12,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: COLORS.textMuted,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    marginBottom: 16,
  },
  addButtonText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: '#000',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 16,
    color: COLORS.textMuted,
    marginTop: 12,
  },
  emptySubtext: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 4,
    textAlign: 'center',
  },
  streamCard: {
    marginBottom: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  streamCardGradient: {
    padding: 14,
  },
  streamIndicator: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
  },
  streamHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 8,
  },
  streamIconWrap: {
    width: 36,
    height: 36,
    backgroundColor: COLORS.cardBorder,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streamInfo: {
    flex: 1,
  },
  streamName: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  streamMeta: {
    fontSize: 10,
    color: COLORS.textMuted,
    marginTop: 2,
    textTransform: 'capitalize',
  },
  streamAmount: {
    alignItems: 'flex-end',
  },
  streamAmountValue: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.primary,
  },
  streamAmountLabel: {
    fontSize: 9,
    color: COLORS.textMuted,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    width: '100%',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.primary,
    padding: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 1,
  },
  inputLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: COLORS.textMuted,
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 12,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 14,
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  optionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  optionBtnActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  optionBtnText: {
    fontSize: 10,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  optionBtnTextActive: {
    color: '#000',
  },
  submitBtn: {
    marginTop: 20,
    overflow: 'hidden',
  },
  submitBtnGradient: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#000',
    letterSpacing: 1,
  },
});

export default IncomeStreamsScreen;
