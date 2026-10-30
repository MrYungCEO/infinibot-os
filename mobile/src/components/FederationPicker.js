/**
 * FederationPicker — Compact dropdown to select the active federation node.
 *
 * Designed to fit inside the chat header. Tapping it opens a modal sheet
 * listing all known nodes with status indicators. Selecting a node calls
 * federation.selectNode() which persists + broadcasts to the gateway.
 */
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { TERMINAL_COLORS as C, TERMINAL_FONTS as F, TERMINAL_SPACING as S } from '../constants/terminal-theme';

function StatusDot({ status, isLocal }) {
  const isOnline = status === 'online' || status === 'registered' || status === 'connected';
  const color = isOnline ? C.ok : (status === 'error' ? C.danger : C.textDim);
  return (
    <View style={[styles.statusDot, { backgroundColor: color }, isOnline && styles.statusDotGlow]}>
      {isLocal && <View style={styles.localRing} />}
    </View>
  );
}

export function FederationPicker({ federation, compact = false }) {
  const [open, setOpen] = useState(false);
  const { nodes, selectedNode, selectNode, refreshNodes, loading } = federation;

  const handleSelect = useCallback((nodeId) => {
    selectNode(nodeId);
    setOpen(false);
  }, [selectNode]);

  // Open without firing a refresh — the parent hook polls every 15s and
  // refetches on connection. Refreshing on every open caused a state churn
  // during the Modal's fade-in that could prematurely dismiss the sheet on
  // slower devices. Users can still hit the refresh icon in the header.
  const onOpen = useCallback(() => {
    setOpen(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <TouchableOpacity
        style={[styles.trigger, compact && styles.triggerCompact]}
        onPress={onOpen}
        activeOpacity={0.7}
      >
        <Ionicons name="git-network" size={12} color={C.gold} />
        <Text style={styles.triggerText} numberOfLines={1}>
          {selectedNode?.name || 'Local'}
        </Text>
        <StatusDot status={selectedNode?.status} isLocal={selectedNode?.isLocal} />
        <Ionicons name="chevron-down" size={12} color={C.textMuted} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.backdrop} onPress={close}>
          {/* Sheet container claims every touch start so taps inside the
              sheet (padding, gaps between rows, ScrollView background) can't
              fall through to the backdrop Pressable and dismiss the modal.
              The `Pressable + e.stopPropagation()` pattern was unreliable on
              RN — onStartShouldSetResponder is the canonical fix. */}
          <View
            style={styles.sheet}
            onStartShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
          >
            <View style={styles.sheetHeader}>
              <View style={styles.sheetHeaderLeft}>
                <Ionicons name="git-network" size={14} color={C.gold} />
                <Text style={styles.sheetTitle}>FEDERATION</Text>
              </View>
              <TouchableOpacity onPress={refreshNodes} hitSlop={10}>
                {loading ? (
                  <ActivityIndicator size="small" color={C.gold} />
                ) : (
                  <Ionicons name="refresh" size={16} color={C.gold} />
                )}
              </TouchableOpacity>
            </View>
            <Text style={styles.sheetSubtitle}>
              {nodes.length} node{nodes.length === 1 ? '' : 's'} · select where chat routes
            </Text>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {nodes.map((node) => {
                const isSelected = node.id === selectedNode?.id;
                return (
                  <TouchableOpacity
                    key={node.id}
                    style={[styles.row, isSelected && styles.rowSelected]}
                    onPress={() => handleSelect(node.id)}
                    activeOpacity={0.7}
                  >
                    <StatusDot status={node.status} isLocal={node.isLocal} />
                    <View style={styles.rowText}>
                      <View style={styles.rowTitleLine}>
                        <Text style={[styles.rowName, isSelected && styles.rowNameActive]} numberOfLines={1}>
                          {node.name}
                        </Text>
                        {node.role && (
                          <Text style={styles.rowRole}>{String(node.role).toUpperCase()}</Text>
                        )}
                      </View>
                      <Text style={styles.rowMeta} numberOfLines={1}>
                        {node.isLocal ? 'this device' : (node.platform || node.id)}
                        {typeof node.activeSessions === 'number' && ` · ${node.activeSessions} sessions`}
                      </Text>
                    </View>
                    {isSelected && <Ionicons name="checkmark" size={16} color={C.gold} />}
                  </TouchableOpacity>
                );
              })}
              {/* Show a loading hint while a refresh is in flight so users
                  don't read a thin list as "broken." */}
              {loading && nodes.length <= 1 && (
                <View style={styles.loadingRow}>
                  <ActivityIndicator size="small" color={C.gold} />
                  <Text style={styles.loadingText}>SEARCHING MESH…</Text>
                </View>
              )}
              {nodes.length === 0 && !loading && (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>NO FEDERATION NODES</Text>
                  <Text style={styles.emptyHint}>Connect a satellite to extend the mesh.</Text>
                </View>
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.goldBorder,
    backgroundColor: C.goldSubtle,
    maxWidth: 160,
  },
  triggerCompact: {
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  triggerText: {
    ...F.small,
    color: C.gold,
    flexShrink: 1,
  },

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: C.textDim,
  },
  statusDotGlow: {
    shadowColor: C.ok,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
    elevation: 2,
  },
  localRing: {
    position: 'absolute',
    top: -2,
    left: -2,
    right: -2,
    bottom: -2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.gold,
  },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: S.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '70%',
    backgroundColor: C.bg1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.goldBorder,
    overflow: 'hidden',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: S.md,
    paddingTop: S.md,
    paddingBottom: 4,
  },
  sheetHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sheetTitle: {
    ...F.panelTitle,
    color: C.gold,
    letterSpacing: 1.5,
  },
  sheetSubtitle: {
    ...F.small,
    color: C.textDim,
    paddingHorizontal: S.md,
    paddingBottom: S.sm,
  },

  list: {
    maxHeight: 400,
  },
  listContent: {
    paddingHorizontal: S.sm,
    paddingBottom: S.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    borderRadius: 8,
    marginVertical: 2,
  },
  rowSelected: {
    backgroundColor: C.goldSubtle,
    borderWidth: 1,
    borderColor: C.goldBorder,
  },
  rowText: {
    flex: 1,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowName: {
    ...F.body,
    color: C.text,
    flexShrink: 1,
  },
  rowNameActive: {
    color: C.gold,
  },
  rowRole: {
    ...F.small,
    fontSize: 9,
    color: C.textDim,
    letterSpacing: 1,
    backgroundColor: C.goldSubtle,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  rowMeta: {
    ...F.small,
    color: C.textDim,
    marginTop: 2,
  },

  emptyBox: {
    alignItems: 'center',
    paddingVertical: S.lg,
    gap: 6,
  },
  emptyText: {
    ...F.panelTitle,
    color: C.textMuted,
  },
  emptyHint: {
    ...F.small,
    color: C.textDim,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: S.md,
  },
  loadingText: {
    ...F.small,
    color: C.textDim,
    letterSpacing: 1.5,
  },
});

export default FederationPicker;
