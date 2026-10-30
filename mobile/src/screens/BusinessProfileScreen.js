/**
 * BusinessProfileScreen — Business Profile Management
 * Edit business details, Notion integration, and settings
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Switch,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../constants/theme';

export function BusinessProfileScreen({ navigation, gateway, route }) {
  const businessId = route?.params?.businessId;
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [businesses, setBusinesses] = useState([]);
  const [activeBusiness, setActiveBusiness] = useState(null);
  const [form, setForm] = useState({
    name: '',
    industry: '',
    context: '',
    planNotionUrl: '',
  });
  const [notionConnected, setNotionConnected] = useState(false);

  const applyBusiness = useCallback((business) => {
    setActiveBusiness(business || null);
    setForm({
      name: business?.name || '',
      industry: business?.industry || '',
      context: business?.context || '',
      planNotionUrl: business?.planNotionUrl || '',
    });
    setNotionConnected(!!business?.notionDatabaseId);
  }, []);

  const loadBusinesses = useCallback(async () => {
    if (!gateway?.sendReq) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      // -> { businesses: BusinessProfile[], activeId: string | null }
      const result = await gateway.sendReq('business.list', {});
      const list = Array.isArray(result?.businesses) ? result.businesses : [];
      setBusinesses(list);
      const wantedId = businessId || result?.activeId;
      applyBusiness(list.find((b) => b.id === wantedId) || list[0] || null);
    } catch (err) {
      setError(err?.message || 'Failed to load business profile');
    } finally {
      setLoading(false);
    }
  }, [gateway, businessId, applyBusiness]);

  useEffect(() => {
    loadBusinesses();
  }, [loadBusinesses]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // `business.save` updates the business named by `id` (falling back to the
      // active one, and creating the first business when none exists yet).
      const params = { ...form };
      if (activeBusiness?.id) params.id = activeBusiness.id;
      const result = await gateway.sendReq('business.save', params);
      if (result?.profile) {
        const saved = result.profile;
        setActiveBusiness(saved);
        setBusinesses((prev) =>
          prev.some((b) => b.id === saved.id)
            ? prev.map((b) => (b.id === saved.id ? saved : b))
            : [...prev, saved],
        );
      }
      Alert.alert('Saved', 'Business profile updated successfully');
    } catch (err) {
      Alert.alert('Error', err?.message || 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  const createBusiness = async (name) => {
    try {
      // -> { profile, businesses }; the new business becomes the active one.
      const result = await gateway.sendReq('business.create', { name });
      if (Array.isArray(result?.businesses)) setBusinesses(result.businesses);
      if (result?.profile) applyBusiness(result.profile);
      else loadBusinesses();
    } catch (err) {
      Alert.alert('Error', err?.message || 'Failed to create business');
    }
  };

  const handleCreateBusiness = () => {
    // Alert.prompt only exists on iOS. Elsewhere create it with a default name
    // and let the user rename it in the form above.
    if (Platform.OS !== 'ios' || typeof Alert.prompt !== 'function') {
      createBusiness('New Business');
      return;
    }
    Alert.prompt(
      'New Business',
      'Enter business name:',
      (name) => {
        if (name?.trim()) createBusiness(name.trim());
      },
      'plain-text'
    );
  };

  const handleDeleteBusiness = () => {
    if (!activeBusiness) return;
    Alert.alert(
      'Delete Business',
      `Are you sure you want to delete "${activeBusiness.name}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              // -> { businesses, activeId }
              const result = await gateway.sendReq('business.delete', { id: activeBusiness.id });
              const list = Array.isArray(result?.businesses) ? result.businesses : [];
              setBusinesses(list);
              applyBusiness(list.find((b) => b.id === result?.activeId) || list[0] || null);
            } catch (err) {
              Alert.alert('Error', err?.message || 'Failed to delete business');
            }
          },
        },
      ]
    );
  };

  const handleSwitchBusiness = async (business) => {
    try {
      await gateway.sendReq('business.setActive', { id: business.id });
      applyBusiness(business);
    } catch (err) {
      Alert.alert('Error', err?.message || 'Failed to switch business');
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Loading business profile...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.loadingContainer}>
        <Ionicons name="warning-outline" size={40} color={COLORS.textMuted} />
        <Text style={[styles.loadingText, { textAlign: 'center', paddingHorizontal: 32 }]}>{error}</Text>
        <TouchableOpacity
          style={[styles.actionBtn, { flex: 0, marginTop: 16, paddingHorizontal: 24 }]}
          onPress={() => {
            setLoading(true);
            loadBusinesses();
          }}
        >
          <Ionicons name="refresh" size={16} color={COLORS.primary} />
          <Text style={styles.actionBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>BUSINESS PROFILE</Text>
          <Text style={styles.headerSubtitle}>
            {businesses.length === 0
              ? 'No business yet — fill in the details and save to create one'
              : 'Manage your business details and integrations'}
          </Text>
        </View>

        {/* Business Selector */}
        {businesses.length > 1 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>SELECT BUSINESS</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.businessTabs}>
                {businesses.map((biz) => (
                  <TouchableOpacity
                    key={biz.id}
                    style={[
                      styles.businessTab,
                      activeBusiness?.id === biz.id && styles.businessTabActive,
                    ]}
                    onPress={() => handleSwitchBusiness(biz)}
                  >
                    <Text
                      style={[
                        styles.businessTabText,
                        activeBusiness?.id === biz.id && styles.businessTabTextActive,
                      ]}
                    >
                      {biz.name || 'Unnamed'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>
        )}

        {/* Profile Form */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>PROFILE DETAILS</Text>
          <LinearGradient
            colors={['rgba(10,10,10,0.9)', 'rgba(5,5,5,0.95)']}
            style={styles.formCard}
          >
            <View style={styles.formGroup}>
              <Text style={styles.label}>Business Name</Text>
              <TextInput
                style={styles.input}
                value={form.name}
                onChangeText={(text) => setForm((f) => ({ ...f, name: text }))}
                placeholder="Enter business name"
                placeholderTextColor={COLORS.textMuted}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Industry</Text>
              <TextInput
                style={styles.input}
                value={form.industry}
                onChangeText={(text) => setForm((f) => ({ ...f, industry: text }))}
                placeholder="e.g., Technology, Finance, Consulting"
                placeholderTextColor={COLORS.textMuted}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Business Context</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                value={form.context}
                onChangeText={(text) => setForm((f) => ({ ...f, context: text }))}
                placeholder="Goals, team size, market position..."
                placeholderTextColor={COLORS.textMuted}
                multiline
                numberOfLines={4}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Notion Plan URL</Text>
              <TextInput
                style={styles.input}
                value={form.planNotionUrl}
                onChangeText={(text) => setForm((f) => ({ ...f, planNotionUrl: text }))}
                placeholder="https://notion.so/..."
                placeholderTextColor={COLORS.textMuted}
                autoCapitalize="none"
              />
            </View>
          </LinearGradient>
        </View>

        {/* Notion Integration */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>NOTION INTEGRATION</Text>
          <View style={styles.integrationCard}>
            <View style={styles.integrationHeader}>
              <View style={[styles.statusIcon, notionConnected && styles.statusIconConnected]}>
                <Ionicons
                  name={notionConnected ? 'link' : 'unlink'}
                  size={16}
                  color={notionConnected ? '#00FF41' : COLORS.textMuted}
                />
              </View>
              <View style={styles.integrationInfo}>
                <Text style={styles.integrationTitle}>
                  {notionConnected ? 'Connected to Notion' : 'Not Connected'}
                </Text>
                <Text style={styles.integrationDesc}>
                  {notionConnected
                    ? 'Data syncing with your Notion workspace'
                    : 'Connect to sync clients, tasks, and data'}
                </Text>
              </View>
            </View>
            <TouchableOpacity
              style={styles.integrationBtn}
              onPress={() => navigation.navigate('Databases')}
            >
              <Ionicons name="settings-outline" size={16} color={COLORS.primary} />
              <Text style={styles.integrationBtnText}>
                {notionConnected ? 'Manage' : 'Connect'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ACTIONS</Text>
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.actionBtnPrimary]}
              onPress={handleSave}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <>
                  <Ionicons name="save" size={16} color="#000" />
                  <Text style={[styles.actionBtnText, { color: '#000' }]}>Save</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionBtn} onPress={handleCreateBusiness}>
              <Ionicons name="add" size={16} color={COLORS.primary} />
              <Text style={styles.actionBtnText}>New Business</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionBtn, styles.actionBtnDanger]}
              onPress={handleDeleteBusiness}
              disabled={!activeBusiness}
            >
              <Ionicons name="trash" size={16} color="#FF4136" />
              <Text style={[styles.actionBtnText, { color: '#FF4136' }]}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
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
  header: {
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: COLORS.primary,
  },
  headerSubtitle: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 4,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    color: COLORS.textMuted,
    marginBottom: 10,
  },
  businessTabs: {
    flexDirection: 'row',
    gap: 8,
  },
  businessTab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  businessTabActive: {
    backgroundColor: COLORS.primaryLight,
    borderColor: COLORS.primary,
  },
  businessTabText: {
    fontSize: 11,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  businessTabTextActive: {
    color: COLORS.primary,
  },
  formCard: {
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  formGroup: {
    marginBottom: 14,
  },
  label: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: COLORS.textMuted,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 13,
  },
  textarea: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  integrationCard: {
    backgroundColor: 'rgba(10,10,10,0.9)',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  integrationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  statusIcon: {
    width: 32,
    height: 32,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusIconConnected: {
    backgroundColor: 'rgba(0,255,65,0.1)',
    borderColor: 'rgba(0,255,65,0.3)',
  },
  integrationInfo: {
    flex: 1,
  },
  integrationTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.text,
  },
  integrationDesc: {
    fontSize: 10,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  integrationBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: COLORS.cardBorder,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
  },
  integrationBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.primary,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    backgroundColor: COLORS.cardBorder,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
  },
  actionBtnPrimary: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  actionBtnDanger: {
    backgroundColor: 'rgba(255,65,54,0.1)',
    borderColor: 'rgba(255,65,54,0.2)',
  },
  actionBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primary,
  },
});

export default BusinessProfileScreen;
