// CampaignsScreen — wraps the in-flight `campaigns.*` gateway methods.
// If the master device hasn't deployed the campaigns service yet, the
// screen renders a "Coming soon" affordance instead of erroring out.

import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, StyleSheet, Alert } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, FONTS, SPACING } from '../constants/theme';
import { GlassCard } from '../components/GlassCard';
import { useCampaigns } from '../hooks/useCampaigns';

function statusColor(status) {
  switch ((status || '').toLowerCase()) {
    case 'active':
    case 'running':
      return COLORS.success;
    case 'paused':
      return COLORS.warning;
    case 'archived':
      return COLORS.textMuted;
    case 'failed':
    case 'error':
      return COLORS.error;
    default:
      return COLORS.primary;
  }
}

export function CampaignsScreen({ navigation, gateway }) {
  const { campaigns, supported, loading, error, refresh, create, update, remove } = useCampaigns(gateway);
  const [busy, setBusy] = useState(false);

  if (supported === false) {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack?.()}>
          <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <View style={styles.comingSoon}>
          <MaterialCommunityIcons name="rocket-launch-outline" size={64} color={COLORS.primary} />
          <Text style={styles.csTitle}>Campaigns — Coming Soon</Text>
          <Text style={styles.csBody}>
            The master device hasn't deployed the campaigns service yet. As soon as the
            `campaigns.*` gateway methods are available you'll see your outreach pipeline
            here without an app update.
          </Text>
        </View>
      </View>
    );
  }

  const handleCreate = async () => {
    setBusy(true);
    try {
      await create({ name: 'New Campaign', status: 'draft' });
    } catch (err) {
      Alert.alert('Create failed', err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (c) => {
    const next = c.status === 'active' ? 'paused' : 'active';
    setBusy(true);
    try {
      await update(c.id, { status: next });
    } catch (err) {
      Alert.alert('Update failed', err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (c) => {
    Alert.alert('Delete campaign?', c.name || c.id, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await remove(c.id);
          } catch (err) {
            Alert.alert('Delete failed', err?.message || String(err));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack?.()}>
          <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.createBtn} onPress={handleCreate} disabled={busy}>
          <Ionicons name="add" size={16} color="#000" />
          <Text style={styles.createBtnText}>New</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.heading}>Campaigns</Text>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={COLORS.primary} colors={[COLORS.primary]} />
        }
      >
        {loading && campaigns.length === 0 ? (
          <ActivityIndicator color={COLORS.primary} style={{ marginVertical: 30 }} />
        ) : campaigns.length === 0 ? (
          <Text style={styles.empty}>No campaigns yet. Tap "New" to create one.</Text>
        ) : (
          campaigns.map((c) => (
            <GlassCard key={c.id} style={styles.card} animated>
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardName}>{c.name || 'Untitled'}</Text>
                  <Text style={styles.cardMeta}>
                    {c.channel ? `${c.channel} · ` : ''}
                    {c.audienceSize != null ? `${c.audienceSize} leads` : ''}
                  </Text>
                </View>
                <View style={[styles.statusChip, { borderColor: statusColor(c.status) }]}>
                  <Text style={[styles.statusText, { color: statusColor(c.status) }]}>
                    {(c.status || 'draft').toUpperCase()}
                  </Text>
                </View>
              </View>
              <View style={styles.cardActions}>
                <TouchableOpacity style={styles.actionBtn} onPress={() => handleToggle(c)} disabled={busy}>
                  <Ionicons name={c.status === 'active' ? 'pause' : 'play'} size={14} color={COLORS.primary} />
                  <Text style={styles.actionText}>{c.status === 'active' ? 'Pause' : 'Activate'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={() => handleDelete(c)} disabled={busy}>
                  <Ionicons name="trash-outline" size={14} color={COLORS.error} />
                  <Text style={[styles.actionText, { color: COLORS.error }]}>Delete</Text>
                </TouchableOpacity>
              </View>
            </GlassCard>
          ))
        )}
      </ScrollView>
    </View>
  );
}

export default CampaignsScreen;

const styles = StyleSheet.create({
  container: { flex: 1, padding: SPACING.lg, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  backBtn: { flexDirection: 'row', alignItems: 'center' },
  backText: { ...FONTS.small, color: COLORS.primary, marginLeft: 4 },
  createBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: COLORS.primary,
  },
  createBtnText: { ...FONTS.small, color: '#000', fontWeight: '700' },
  heading: { ...FONTS.heading, color: COLORS.text, fontSize: 22, marginBottom: SPACING.md },
  scrollContent: { paddingBottom: 80 },
  card: { padding: SPACING.lg, marginBottom: SPACING.md },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  cardName: { ...FONTS.regular, color: COLORS.text, fontWeight: '700', fontSize: 16 },
  cardMeta: { ...FONTS.tiny, color: COLORS.textMuted, marginTop: 2 },
  statusChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  statusText: { ...FONTS.tiny, letterSpacing: 1.5 },
  cardActions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
    borderWidth: 1, borderColor: COLORS.border,
  },
  actionText: { ...FONTS.small, color: COLORS.primary, fontWeight: '600' },
  empty: { ...FONTS.small, color: COLORS.textMuted, textAlign: 'center', paddingVertical: 30 },
  errorText: { ...FONTS.small, color: COLORS.error, marginBottom: 8 },
  comingSoon: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: SPACING.xl },
  csTitle: { ...FONTS.heading, color: COLORS.text, fontSize: 22, textAlign: 'center' },
  csBody: { ...FONTS.small, color: COLORS.textSecondary, textAlign: 'center', lineHeight: 22, maxWidth: 360 },
});
