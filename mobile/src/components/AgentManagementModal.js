import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassCard } from './GlassCard';
import { PulsingDot } from './PulsingDot';
import { COLORS, FONTS, SPACING, GLASS } from '../constants/theme';
import { METHOD } from '../constants/gateway';

function DetailRow({ label, value, icon }) {
  return (
    <View style={styles.detailRow}>
      {icon && <Ionicons name={icon} size={14} color={COLORS.textMuted} style={{ marginRight: 6 }} />}
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={2}>{value || '—'}</Text>
    </View>
  );
}

function SectionHeader({ title, icon }) {
  return (
    <View style={styles.sectionHeader}>
      <Ionicons name={icon} size={16} color={COLORS.primary} />
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

export function AgentManagementModal({ visible, agent, sessions, onClose, sendReq }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [agentConfig, setAgentConfig] = useState(null);
  const [modelOverride, setModelOverride] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  // Config ids are the agent `id` (agents.list[].id), not the display name.
  const agentId = agent?.id || agent?.name;

  // Load agent config when modal opens
  useEffect(() => {
    if (visible && agent && sendReq) {
      loadConfig();
    }
  }, [visible, agent?.id, agent?.name]);

  // config.get takes NO params (strict schema) and returns the whole redacted
  // snapshot { config, hash, ... }; the per-agent entry lives in
  // config.agents.list[] (src/gateway/server-methods/config.ts).
  const loadConfig = useCallback(async () => {
    if (!sendReq || !agent) return;
    setLoading(true);
    setError(null);
    setLoadError(null);
    setSuccessMsg(null);
    try {
      const snapshot = await sendReq(METHOD.CONFIG_GET, {});
      const list = Array.isArray(snapshot?.config?.agents?.list) ? snapshot.config.agents.list : [];
      const entry = list.find((a) => a?.id === agentId) || null;
      setAgentConfig({ entry, list, hash: snapshot?.hash || null });
      const entryModel = typeof entry?.model === 'string' ? entry.model : entry?.model?.primary;
      setModelOverride(entryModel || agent.model || '');
      setSystemPrompt(typeof entry?.systemPrompt === 'string' ? entry.systemPrompt : '');
    } catch (err) {
      setAgentConfig(null);
      setLoadError(err?.message || String(err));
      setModelOverride(agent.model || '');
      setSystemPrompt('');
    }
    setLoading(false);
  }, [sendReq, agent, agentId]);

  // Per-agent edits go through agents.management.update (same RPC the web
  // Agents page uses): it writes model.primary / systemPrompt onto the
  // agents.list[] entry without replacing the list or restarting the gateway.
  const saveConfig = useCallback(async () => {
    if (!sendReq || !agent) return;
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const entry = agentConfig?.entry;
      const currentModel = typeof entry?.model === 'string' ? entry.model : entry?.model?.primary;
      const currentPrompt = typeof entry?.systemPrompt === 'string' ? entry.systemPrompt : '';
      const patch = {};
      const nextModel = modelOverride.trim();
      if (nextModel && nextModel !== (currentModel || agent.model || '')) patch.model = nextModel;
      if (systemPrompt !== currentPrompt) patch.systemPrompt = systemPrompt;

      if (Object.keys(patch).length > 0) {
        const res = await sendReq('agents.management.update', { id: agentId, ...patch });
        if (res && res.ok === false) throw new Error(res.error || 'update rejected');
        setSuccessMsg('Settings saved successfully');
        setTimeout(() => setSuccessMsg(null), 3000);
        loadConfig();
      } else {
        setSuccessMsg('No changes to save');
        setTimeout(() => setSuccessMsg(null), 2000);
      }
    } catch (err) {
      setError(`Save failed: ${err.message}`);
    }
    setSaving(false);
  }, [sendReq, agent, agentId, agentConfig, modelOverride, systemPrompt, loadConfig]);

  // Changing the default agent means rewriting agents.list in the gateway
  // config (and a gateway restart). config.get returns a REDACTED snapshot, so
  // writing that list back from here could overwrite secrets — the web Setup
  // page is the place to change it. Mobile shows which agent is the default.
  const isDefault = !!agentConfig?.entry?.default;

  if (!agent) return null;

  const statusColor = agent.status === 'running' ? COLORS.success
    : agent.status === 'idle' ? COLORS.warning
    : COLORS.textMuted;

  // Filter sessions belonging to this agent
  const agentSessions = (sessions || []).filter(s => {
    const key = s.key || '';
    return key.startsWith(`${agent.name}:`) || key.startsWith(`${agent.id}:`);
  });

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalContainer}
        >
          <View style={styles.modalContent}>
            {/* Header */}
            <View style={styles.header}>
              <View style={styles.headerLeft}>
                <PulsingDot color={statusColor} size={10} />
                <View>
                  <Text style={styles.headerTitle}>{agent.name}</Text>
                  <Text style={styles.headerSubtitle}>{agent.provider} • {agent.status}</Text>
                </View>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                <Ionicons name="close" size={24} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.body}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {loading ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator color={COLORS.primary} size="large" />
                  <Text style={styles.loadingText}>Loading config...</Text>
                </View>
              ) : (
                <>
                  {/* Agent Info */}
                  <SectionHeader title="Agent Details" icon="information-circle-outline" />
                  <GlassCard style={styles.section}>
                    <DetailRow label="Name" value={agent.name} icon="person-outline" />
                    <DetailRow label="Model" value={agent.model} icon="cube-outline" />
                    <DetailRow label="Provider" value={agent.provider} icon="cloud-outline" />
                    <DetailRow label="Status" value={agent.status} icon="radio-outline" />
                    {agent.description && (
                      <DetailRow label="Description" value={agent.description} icon="document-text-outline" />
                    )}
                    {agent.type && <DetailRow label="Type" value={agent.type} icon="code-slash-outline" />}
                    {agent.metrics?.totalTasks != null && (
                      <DetailRow label="Total Tasks" value={String(agent.metrics.totalTasks)} icon="checkmark-done-outline" />
                    )}
                    {agent.metrics?.successRate != null && (
                      <DetailRow label="Success Rate" value={`${agent.metrics.successRate.toFixed(1)}%`} icon="trending-up-outline" />
                    )}
                  </GlassCard>

                  {/* Configuration */}
                  <SectionHeader title="Configuration" icon="settings-outline" />
                  <GlassCard style={styles.section}>
                    <Text style={styles.fieldLabel}>Model Override</Text>
                    <TextInput
                      style={styles.input}
                      value={modelOverride}
                      onChangeText={setModelOverride}
                      placeholder="e.g. claude-sonnet-4-20250514"
                      placeholderTextColor={COLORS.textMuted}
                    />

                    <Text style={styles.fieldLabel}>System Prompt</Text>
                    <TextInput
                      style={[styles.input, styles.multilineInput]}
                      value={systemPrompt}
                      onChangeText={setSystemPrompt}
                      placeholder="Instructions for this agent..."
                      placeholderTextColor={COLORS.textMuted}
                      multiline
                      numberOfLines={4}
                      textAlignVertical="top"
                    />

                    {loadError && (
                      <View style={styles.errorRow}>
                        <Ionicons name="warning-outline" size={14} color={COLORS.error} />
                        <Text style={styles.errorText}>Could not load config: {loadError}</Text>
                        <TouchableOpacity onPress={loadConfig}>
                          <Ionicons name="refresh" size={16} color={COLORS.primary} />
                        </TouchableOpacity>
                      </View>
                    )}

                    {error && (
                      <View style={styles.errorRow}>
                        <Ionicons name="warning-outline" size={14} color={COLORS.error} />
                        <Text style={styles.errorText}>{error}</Text>
                      </View>
                    )}

                    {successMsg && (
                      <View style={styles.successRow}>
                        <Ionicons name="checkmark-circle-outline" size={14} color={COLORS.success} />
                        <Text style={styles.successText}>{successMsg}</Text>
                      </View>
                    )}

                    <TouchableOpacity
                      style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
                      onPress={saveConfig}
                      disabled={saving}
                    >
                      {saving ? (
                        <ActivityIndicator color={COLORS.background} size="small" />
                      ) : (
                        <>
                          <Ionicons name="save-outline" size={16} color={COLORS.background} />
                          <Text style={styles.saveBtnText}>Save Changes</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </GlassCard>

                  {/* Active Sessions */}
                  <SectionHeader title={`Sessions (${agentSessions.length})`} icon="chatbubbles-outline" />
                  <GlassCard style={styles.section}>
                    {agentSessions.length === 0 ? (
                      <Text style={styles.emptyText}>No active sessions</Text>
                    ) : (
                      agentSessions.map((s, i) => (
                        <View key={s.key || i} style={styles.sessionItem}>
                          <Ionicons
                            name={s.key?.includes('subagent') ? 'git-branch-outline' : 'chatbubble-outline'}
                            size={14}
                            color={COLORS.primary}
                          />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.sessionItemTitle} numberOfLines={1}>
                              {s.derivedTitle || s.label || s.key}
                            </Text>
                            <Text style={styles.sessionItemKey} numberOfLines={1}>{s.key}</Text>
                          </View>
                          {s.messageCount != null && (
                            <Text style={styles.sessionItemCount}>{s.messageCount} msgs</Text>
                          )}
                        </View>
                      ))
                    )}
                  </GlassCard>

                  {/* Actions */}
                  <SectionHeader title="Actions" icon="flash-outline" />
                  {isDefault ? (
                    <GlassCard style={styles.section}>
                      <View style={styles.actionBtn}>
                        <Ionicons name="star" size={18} color={COLORS.primary} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.actionBtnText}>Default agent</Text>
                          <Text style={styles.actionBtnSub}>New messages are routed to this agent</Text>
                        </View>
                      </View>
                    </GlassCard>
                  ) : null}

                  <View style={{ height: 40 }} />
                </>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: COLORS.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: COLORS.cardBorder,
    maxHeight: '90%',
    minHeight: '60%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerTitle: {
    ...FONTS.heading,
    color: COLORS.primary,
    fontSize: 20,
  },
  headerSubtitle: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    marginTop: 1,
  },
  closeBtn: {
    padding: 4,
  },
  body: {
    flex: 1,
    paddingHorizontal: SPACING.md,
  },
  loadingContainer: {
    padding: 40,
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    ...FONTS.small,
    color: COLORS.textMuted,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: SPACING.lg,
    marginBottom: SPACING.xs,
    paddingHorizontal: SPACING.xs,
  },
  sectionTitle: {
    ...FONTS.small,
    color: COLORS.primary,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  section: {
    padding: SPACING.md,
    marginBottom: SPACING.xs,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  detailLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    flex: 1,
  },
  detailValue: {
    ...FONTS.tiny,
    color: COLORS.text,
    fontWeight: '500',
    flex: 1,
    textAlign: 'right',
  },
  fieldLabel: {
    ...FONTS.tiny,
    color: COLORS.textSecondary,
    fontWeight: '600',
    marginTop: SPACING.sm,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  input: {
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    color: COLORS.text,
    ...FONTS.small,
  },
  multilineInput: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  chipRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: SPACING.xs,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipActive: {
    backgroundColor: COLORS.primaryLight,
    borderColor: COLORS.primary,
  },
  chipText: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontWeight: '500',
  },
  chipTextActive: {
    color: COLORS.primary,
    fontWeight: '700',
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: SPACING.md,
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveBtnText: {
    ...FONTS.small,
    color: COLORS.background,
    fontWeight: '700',
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: SPACING.sm,
  },
  errorText: {
    ...FONTS.tiny,
    color: COLORS.error,
    flex: 1,
  },
  successRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: SPACING.sm,
  },
  successText: {
    ...FONTS.tiny,
    color: COLORS.success,
    flex: 1,
  },
  emptyText: {
    ...FONTS.small,
    color: COLORS.textMuted,
    textAlign: 'center',
    paddingVertical: SPACING.md,
  },
  sessionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderLight,
  },
  sessionItemTitle: {
    ...FONTS.tiny,
    color: COLORS.text,
    fontWeight: '500',
  },
  sessionItemKey: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 9,
  },
  sessionItemCount: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: SPACING.sm,
  },
  actionBtnText: {
    ...FONTS.small,
    color: COLORS.text,
    fontWeight: '600',
  },
  actionBtnSub: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    marginTop: 1,
  },
});
