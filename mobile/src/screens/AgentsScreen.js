/**
 * AgentsScreen — Multi-agent management with profiles, sessions, and prompts.
 * Premium glass treatment, shared header/components with the rest of the
 * agent oversight surface.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, TextInput, Modal, Alert,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { GlassCard } from '../components/GlassCard';
import { GlassSurface } from '../components/GlassSurface';
import { PremiumHeader } from '../components/PremiumHeader';
import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../theme/color-utils';

// Agent role icons
const ROLE_ICONS = {
  main: 'person-circle',
  coder: 'code-slash',
  researcher: 'search',
  writer: 'pencil',
  analyst: 'analytics',
  assistant: 'chatbubbles',
  default: 'cube',
};

function formatTimeSince(ts) {
  if (!ts) return null;
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function AgentCard({ agent, isDefault, onPress, colors, styles }) {
  // `agents.list` returns only { id, name, model, identity }. Session count and
  // last activity are joined in from `sessions.list` when that call succeeds;
  // they stay undefined (and hidden) otherwise — never a made-up zero.
  const sColor = colors.primary;
  const icon = ROLE_ICONS[agent.id] || ROLE_ICONS.default;
  const lastActive = formatTimeSince(agent.lastActiveAt);
  const displayName = agent.name || agent.identity?.name || agent.id;

  return (
    <GlassCard
      style={styles.agentCard}
      animated
      tint="primary"
    >
      {isDefault ? (
        <View
          style={[
            styles.defaultBadge,
            {
              backgroundColor: withAlpha(colors.primary, 0.18),
              borderColor: withAlpha(colors.primary, 0.45),
            },
          ]}
        >
          <Ionicons name="star" size={9} color={colors.primary} />
          <Text style={[styles.defaultBadgeText, { color: colors.primary }]}>
            DEFAULT
          </Text>
        </View>
      ) : null}

      <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={styles.agentCardInner}>
        <View style={styles.agentCardHeader}>
          <View
            style={[
              styles.agentAvatar,
              {
                backgroundColor: withAlpha(sColor, 0.14),
                borderColor: withAlpha(sColor, 0.5),
                shadowColor: sColor,
              },
            ]}
          >
            <Ionicons name={icon} size={26} color={sColor} />
          </View>
          <View style={styles.agentHeaderText}>
            <Text style={[styles.agentName, { color: colors.text }]} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={[styles.agentRole, { color: colors.textMuted }]} numberOfLines={1}>
              @{agent.id}
            </Text>
            {lastActive ? (
              <Text style={[styles.agentLastActive, { color: colors.textMuted }]}>
                {lastActive}
              </Text>
            ) : null}
          </View>
        </View>

        {(agent.model || typeof agent.sessionCount === 'number') ? (
          <View style={styles.cardMeta}>
            {agent.model ? (
              <View
                style={[
                  styles.metaTag,
                  { backgroundColor: withAlpha('#ffffff', 0.05) },
                ]}
              >
                <MaterialCommunityIcons name="chip" size={11} color={colors.textMuted} />
                <Text style={[styles.metaText, { color: colors.textMuted }]} numberOfLines={1}>
                  {agent.model}
                </Text>
              </View>
            ) : null}
            {typeof agent.sessionCount === 'number' ? (
              <View
                style={[
                  styles.metaTag,
                  { backgroundColor: withAlpha('#ffffff', 0.05) },
                ]}
              >
                <Ionicons name="chatbubbles-outline" size={11} color={colors.textMuted} />
                <Text style={[styles.metaText, { color: colors.textMuted }]} numberOfLines={1}>
                  {agent.sessionCount} {agent.sessionCount === 1 ? 'session' : 'sessions'} this week
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.cardActions}>
          <TouchableOpacity
            style={[
              styles.actionBtn,
              styles.actionBtnPrimary,
              {
                backgroundColor: withAlpha(colors.primary, 0.15),
                borderColor: withAlpha(colors.primary, 0.4),
              },
            ]}
            onPress={onPress}
          >
            <Text style={[styles.actionBtnTextPrimary, { color: colors.primary }]}>
              Configure
            </Text>
            <Ionicons name="chevron-forward" size={14} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </GlassCard>
  );
}

function AgentDetailModal({ visible, agent, onClose, onSave, saving, colors, styles }) {
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [model, setModel] = useState('');

  useEffect(() => {
    if (agent) {
      setName(agent.name || '');
      // The gateway never returns the stored prompt, so this starts blank and
      // is only sent when the user actually types a replacement.
      setSystemPrompt('');
      setModel(agent.model || '');
    }
  }, [agent]);

  // `agents.management.update` only writes string fields it receives, so send
  // just what changed — an untouched field must not overwrite the config.
  const handleSave = () => {
    const updates = {};
    if (name.trim() && name.trim() !== (agent.name || '')) updates.name = name.trim();
    if (model.trim() && model.trim() !== (agent.model || '')) updates.model = model.trim();
    if (systemPrompt.trim()) updates.systemPrompt = systemPrompt;
    onSave(updates);
  };

  if (!agent) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <GlassSurface depth={3} radius={24} style={styles.detailModal}>
          <View
            style={[
              styles.modalHeader,
              { borderBottomColor: withAlpha(colors.primary, 0.18) },
            ]}
          >
            <View style={styles.modalHeaderLeft}>
              <View
                style={[
                  styles.agentIconLarge,
                  {
                    backgroundColor: withAlpha(colors.primary, 0.14),
                    borderColor: withAlpha(colors.primary, 0.5),
                  },
                ]}
              >
                <Ionicons name="cube" size={28} color={colors.primary} />
              </View>
              <View>
                <Text style={[styles.modalTitle, { color: colors.text }]}>
                  {agent.name || agent.identity?.name || agent.id}
                </Text>
                <Text style={[styles.modalSubtitle, { color: colors.textMuted }]}>
                  @{agent.id}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalBody}>
            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.primary }]}>
                DISPLAY NAME
              </Text>
              <TextInput
                style={[
                  styles.formInput,
                  {
                    color: colors.text,
                    backgroundColor: withAlpha('#000', 0.4),
                    borderColor: withAlpha(colors.primary, 0.22),
                  },
                ]}
                value={name}
                onChangeText={setName}
                placeholder="Agent display name"
                placeholderTextColor={colors.textMuted}
              />
            </View>

            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.primary }]}>
                MODEL
              </Text>
              <TextInput
                style={[
                  styles.formInput,
                  {
                    color: colors.text,
                    backgroundColor: withAlpha('#000', 0.4),
                    borderColor: withAlpha(colors.primary, 0.22),
                  },
                ]}
                value={model}
                onChangeText={setModel}
                placeholder="e.g., anthropic/claude-sonnet-4-20250514"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
              />
              <Text style={[styles.formHint, { color: colors.textMuted }]}>
                Provider/model id. Leave unchanged to keep the current model.
              </Text>
            </View>

            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.primary }]}>
                NEW SYSTEM PROMPT
              </Text>
              <TextInput
                style={[
                  styles.formInput,
                  styles.formTextarea,
                  {
                    color: colors.text,
                    backgroundColor: withAlpha('#000', 0.4),
                    borderColor: withAlpha(colors.primary, 0.22),
                  },
                ]}
                value={systemPrompt}
                onChangeText={setSystemPrompt}
                placeholder="Type a replacement system prompt..."
                placeholderTextColor={colors.textMuted}
                multiline
                numberOfLines={8}
                textAlignVertical="top"
              />
              <Text style={[styles.formHint, { color: colors.textMuted }]}>
                The current prompt is not shown here. Leave empty to keep it unchanged. Workspace files (SOUL.md, USER.md) are still appended.
              </Text>
            </View>

            <GlassSurface depth={1} radius={14} style={styles.infoSection}>
              <View style={styles.infoSectionInner}>
                <Text style={[styles.infoTitle, { color: colors.primary }]}>
                  AGENT INFO
                </Text>
                <View
                  style={[
                    styles.infoRow,
                    { borderBottomColor: withAlpha(colors.text || '#fff', 0.04) },
                  ]}
                >
                  <Text style={[styles.infoLabel, { color: colors.textMuted }]}>ID</Text>
                  <Text style={[styles.infoValue, { color: colors.text }]}>{agent.id}</Text>
                </View>
                {typeof agent.sessionCount === 'number' ? (
                  <View
                    style={[
                      styles.infoRow,
                      { borderBottomColor: withAlpha(colors.text || '#fff', 0.04) },
                    ]}
                  >
                    <Text style={[styles.infoLabel, { color: colors.textMuted }]}>Sessions (7 days)</Text>
                    <Text style={[styles.infoValue, { color: colors.text }]}>
                      {agent.sessionCount}
                    </Text>
                  </View>
                ) : null}
              </View>
            </GlassSurface>
          </ScrollView>

          <View
            style={[
              styles.modalFooter,
              { borderTopColor: withAlpha(colors.primary, 0.18) },
            ]}
          >
            <TouchableOpacity
              style={[
                styles.cancelBtn,
                { backgroundColor: withAlpha('#ffffff', 0.05) },
              ]}
              onPress={onClose}
            >
              <Text style={[styles.cancelBtnText, { color: colors.textMuted }]}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.saveBtn,
                { backgroundColor: colors.primary },
                saving && styles.saveBtnDisabled,
              ]}
              onPress={handleSave}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color={colors.background} />
              ) : (
                <>
                  <Text style={[styles.saveBtnText, { color: colors.background }]}>
                    Save Changes
                  </Text>
                  <Ionicons name="checkmark" size={16} color={colors.background} />
                </>
              )}
            </TouchableOpacity>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}

export function AgentsScreen({ navigation, gateway }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [agents, setAgents] = useState([]);
  const [defaultAgentId, setDefaultAgentId] = useState(null);
  // agentId -> { count, lastActiveAt }, joined from sessions.list (optional).
  const [sessionStats, setSessionStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [saving, setSaving] = useState(false);

  // Per-agent session counts. Loaded separately so a slow/denied
  // sessions.list never holds up (or fails) the agent roster itself.
  const loadSessionStats = useCallback(async () => {
    if (!gateway?.sendReq) return;
    try {
      // Bounded to the last 7 days: the store can hold thousands of sessions.
      const res = await gateway.sendReq('sessions.list', {
        includeGlobal: false,
        includeUnknown: false,
        activeMinutes: 7 * 24 * 60,
        limit: 500,
      });
      const rows = Array.isArray(res?.sessions) ? res.sessions : null;
      if (!rows) return;
      const next = {};
      rows.forEach((row) => {
        const match = /^agent:([^:]+):/.exec(row?.key || '');
        if (!match) return;
        const entry = next[match[1]] || (next[match[1]] = { count: 0, lastActiveAt: 0 });
        entry.count += 1;
        if (typeof row.updatedAt === 'number' && row.updatedAt > entry.lastActiveAt) {
          entry.lastActiveAt = row.updatedAt;
        }
      });
      setSessionStats(next);
    } catch (_) {
      // Stats are optional — leave them hidden rather than showing zeros.
      setSessionStats(null);
    }
  }, [gateway]);

  const loadAgents = useCallback(async () => {
    if (!gateway?.sendReq) return;
    setLoading(true);
    setError(null);

    try {
      // { defaultId, mainKey, scope, agents: [{ id, name?, model?, identity? }] }
      const result = await gateway.sendReq('agents.management.list', {});
      setAgents(Array.isArray(result?.agents) ? result.agents : []);
      setDefaultAgentId(result?.defaultId || null);
    } catch (err) {
      setAgents([]);
      setError(err?.message || 'Could not load agents');
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  const refresh = useCallback(() => {
    loadAgents();
    loadSessionStats();
  }, [loadAgents, loadSessionStats]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const agentRows = useMemo(
    () =>
      agents.map((agent) => {
        const stat = sessionStats ? sessionStats[agent.id] : null;
        if (!sessionStats) return agent;
        return {
          ...agent,
          sessionCount: stat ? stat.count : 0,
          lastActiveAt: stat && stat.lastActiveAt ? stat.lastActiveAt : null,
        };
      }),
    [agents, sessionStats],
  );

  const handleSaveAgent = useCallback(async (updates) => {
    if (!selectedAgent) return;
    if (!updates || Object.keys(updates).length === 0) {
      setShowDetail(false);
      return;
    }
    setSaving(true);
    try {
      await gateway.sendReq('agents.management.update', {
        id: selectedAgent.id,
        ...updates,
      });
      setShowDetail(false);
      loadAgents();
    } catch (err) {
      Alert.alert('Could not save agent', err?.message || 'Unknown error');
    } finally {
      setSaving(false);
    }
  }, [selectedAgent, gateway, loadAgents]);

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <PremiumHeader
        eyebrow="AGENTS"
        title="Multi-Agent System"
        subtitle={
          loading && agents.length === 0
            ? 'Loading…'
            : `${agents.length} configured`
        }
        rightActions={[
          {
            icon: 'refresh',
            onPress: refresh,
            busy: loading,
            color: loading ? colors.textMuted : colors.primary,
          },
        ]}
      />

      {error ? (
        <View
          style={[
            styles.errorBanner,
            {
              backgroundColor: withAlpha(colors.error, 0.1),
              borderColor: withAlpha(colors.error, 0.3),
            },
          ]}
        >
          <Ionicons name="warning-outline" size={14} color={colors.error} />
          <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
          <TouchableOpacity onPress={refresh} hitSlop={10}>
            <Text style={[styles.retryText, { color: colors.error }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.content, isTablet && styles.contentTablet]}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.primary} />
        }
      >
        {loading && agents.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.textMuted }]}>
              Loading agents...
            </Text>
          </View>
        ) : agents.length === 0 ? (
          <View style={styles.loadingContainer}>
            <Ionicons
              name={error ? 'cloud-offline-outline' : 'cube-outline'}
              size={32}
              color={colors.textMuted}
            />
            <Text style={[styles.loadingText, { color: colors.textMuted }]}>
              {error ? 'Agents could not be loaded' : 'No agents configured on this gateway'}
            </Text>
          </View>
        ) : (
          <View style={[styles.agentsGrid, isTablet && styles.agentsGridTablet]}>
            {agentRows.map(agent => (
              <View
                key={agent.id}
                style={isTablet ? styles.agentsGridItemTablet : null}
              >
                <AgentCard
                  agent={agent}
                  isDefault={agent.id === defaultAgentId}
                  onPress={() => {
                    setSelectedAgent(agent);
                    setShowDetail(true);
                  }}
                  colors={colors}
                  styles={styles}
                />
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <AgentDetailModal
        visible={showDetail}
        agent={selectedAgent}
        onClose={() => setShowDetail(false)}
        onSave={handleSaveAgent}
        saving={saving}
        colors={colors}
        styles={styles}
      />
    </SafeAreaView>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: 'transparent',
    },

    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginHorizontal: 16,
      marginTop: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 12,
      borderWidth: 1,
    },
    errorText: { fontSize: 12, flex: 1 },
    retryText: { fontSize: 12, fontWeight: '700' },

    scrollView: { flex: 1 },
    content: { padding: 16, paddingBottom: 32 },
    contentTablet: {
      padding: 24,
      maxWidth: 1000,
      alignSelf: 'center',
      width: '100%',
    },
    loadingContainer: { alignItems: 'center', paddingVertical: 60 },
    loadingText: { marginTop: 12, fontSize: 12 },

    agentsGrid: { gap: 14 },
    agentsGridTablet: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
    agentsGridItemTablet: { flexBasis: '48%', flexGrow: 1 },

    // Agent Card
    agentCard: { position: 'relative' },
    agentCardInner: { padding: 16 },
    defaultBadge: {
      position: 'absolute',
      top: 10,
      right: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 3,
      paddingHorizontal: 8,
      borderRadius: 999,
      borderWidth: 1,
      zIndex: 2,
    },
    defaultBadgeText: {
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 1,
    },

    agentCardHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
      marginBottom: 14,
    },
    agentAvatar: {
      width: 50,
      height: 50,
      borderRadius: 16,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.4,
      shadowRadius: 8,
      elevation: 4,
    },
    agentHeaderText: { flex: 1, paddingTop: 2 },
    agentName: { fontSize: 16, fontWeight: '700' },
    agentRole: { fontSize: 11, marginTop: 2 },
    agentLastActive: { fontSize: 10, marginTop: 3, opacity: 0.75 },
    agentHeaderRight: {
      alignItems: 'flex-end',
      gap: 6,
      paddingTop: 2,
    },
    statusPill: {
      borderRadius: 999,
      borderWidth: 1,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    statusPillText: {
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 0.5,
    },

    statsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-around',
      paddingTop: 12,
      paddingBottom: 4,
      borderTopWidth: 1,
      marginBottom: 12,
    },
    stat: { alignItems: 'center' },
    statValue: { fontSize: 18, fontWeight: '700' },
    statLabel: {
      fontSize: 9,
      letterSpacing: 0.5,
      marginTop: 2,
      textTransform: 'uppercase',
    },
    statDivider: { width: 1, height: 24 },

    cardMeta: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: 12,
    },
    metaTag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: 999,
    },
    metaText: { fontSize: 10, maxWidth: 140 },

    cardActions: { flexDirection: 'row', gap: 8 },
    actionBtn: {
      flex: 1,
      paddingVertical: 10,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderRadius: 12,
    },
    actionBtnPrimary: { flexDirection: 'row', gap: 4 },
    actionBtnText: { fontSize: 12, fontWeight: '600' },
    actionBtnTextPrimary: { fontSize: 12, fontWeight: '700' },

    // Add Button
    addAgentBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 14,
      marginTop: 14,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderRadius: 16,
    },
    addAgentBtnText: { fontSize: 14, fontWeight: '700', letterSpacing: 0.3 },

    // Modal
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.75)',
      justifyContent: 'flex-end',
    },
    detailModal: {
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      maxHeight: '90%',
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 16,
      paddingHorizontal: 20,
      borderBottomWidth: 1,
    },
    modalHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    agentIconLarge: {
      width: 48,
      height: 48,
      borderRadius: 14,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    modalTitle: { fontSize: 18, fontWeight: '700' },
    modalSubtitle: { fontSize: 12 },
    modalBody: { padding: 20 },

    formGroup: { marginBottom: 20 },
    formLabel: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1.5,
      marginBottom: 8,
      opacity: 0.85,
    },
    formInput: {
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
    },
    formTextarea: { minHeight: 120, textAlignVertical: 'top' },
    formHint: { fontSize: 11, marginTop: 6 },

    infoSection: { marginTop: 8 },
    infoSectionInner: { padding: 16 },
    infoTitle: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1.5,
      marginBottom: 12,
      opacity: 0.9,
    },
    infoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 6,
      borderBottomWidth: 1,
    },
    infoLabel: { fontSize: 12 },
    infoValue: { fontSize: 12, fontWeight: '500' },

    modalFooter: {
      flexDirection: 'row',
      gap: 12,
      padding: 20,
      paddingTop: 16,
      borderTopWidth: 1,
    },
    cancelBtn: { flex: 1, paddingVertical: 14, alignItems: 'center', borderRadius: 12 },
    cancelBtnText: { fontSize: 14, fontWeight: '600' },
    saveBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 14,
      borderRadius: 12,
    },
    saveBtnDisabled: { opacity: 0.6 },
    saveBtnText: { fontSize: 14, fontWeight: '700' },
  });
}

export default AgentsScreen;
