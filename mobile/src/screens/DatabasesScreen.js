/**
 * DatabasesScreen — Notion Database Management
 * Connect, browse, and manage Notion databases
 *
 * Same RPCs as the web Notion Database Manager (ui/src/ui/controllers/notion-databases.ts):
 *   notion.db.list        -> { databases: [{ id, databaseId, name, icon, schema, lastSync, pageCount }] }
 *   notion.db.discover    -> { databases: [{ id, title, icon, url }] }   (workspace search — slow)
 *   notion.db.add         { url: <notion url or database id> } -> { database }
 *   notion.db.pages.pull  { databaseId } -> { pages, count, schema }
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../constants/theme';

export function DatabasesScreen({ navigation, gateway }) {
  const [connected, setConnected] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [connecting, setConnecting] = useState(null);
  const [syncing, setSyncing] = useState(null);

  // Connected databases — a local read on the gateway, so this is the fast path
  // that decides when the screen stops showing its loading state.
  const loadConnected = useCallback(async () => {
    if (!gateway?.sendReq) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setError(null);
    try {
      const result = await gateway.sendReq('notion.db.list', {});
      setConnected(Array.isArray(result?.databases) ? result.databases : []);
    } catch (err) {
      setError(err?.message || 'Failed to load connected databases');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [gateway]);

  // Workspace discovery pages through Notion search and can take a while, so
  // it loads on its own and never blocks the connected list.
  const loadDiscovered = useCallback(async () => {
    if (!gateway?.sendReq) return;
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const result = await gateway.sendReq('notion.db.discover', {});
      setDiscovered(Array.isArray(result?.databases) ? result.databases : []);
    } catch (err) {
      setDiscoverError(err?.message || 'Could not search the Notion workspace');
    } finally {
      setDiscovering(false);
    }
  }, [gateway]);

  const loadDatabases = useCallback(() => {
    loadConnected();
    loadDiscovered();
  }, [loadConnected, loadDiscovered]);

  useEffect(() => {
    loadDatabases();
  }, [loadDatabases]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadDatabases();
  }, [loadDatabases]);

  const handleConnect = useCallback(async (db) => {
    setConnecting(db.id);
    try {
      // `notion.db.add` takes a Notion URL or a bare database id in `url`.
      const result = await gateway.sendReq('notion.db.add', { url: db.notionId });
      if (result?.database) {
        setConnected((prev) => [...prev, result.database]);
      } else {
        loadConnected();
      }
    } catch (err) {
      Alert.alert('Error', err?.message || 'Failed to connect database');
    } finally {
      setConnecting(null);
    }
  }, [gateway, loadConnected]);

  const handleSync = useCallback(async (db) => {
    setSyncing(db.id);
    try {
      const result = await gateway.sendReq('notion.db.pages.pull', { databaseId: db.notionId });
      const count = typeof result?.count === 'number' ? result.count : null;
      Alert.alert(
        'Synced',
        count === null ? `"${db.title}" synced` : `"${db.title}" synced — ${count} pages`,
      );
      loadConnected();
    } catch (err) {
      Alert.alert('Error', err?.message || 'Failed to sync database');
    } finally {
      setSyncing(null);
    }
  }, [gateway, loadConnected]);

  // One list: connected databases first, then workspace databases that are not
  // connected yet (matched on the Notion database id).
  const databases = useMemo(() => {
    const norm = (id) => String(id || '').replace(/-/g, '').toLowerCase();
    const connectedIds = new Set(connected.map((d) => norm(d.databaseId)));
    const rows = connected.map((d) => ({
      id: d.id,
      notionId: d.databaseId,
      title: d.name || d.schema?.databaseName || 'Untitled',
      icon: d.icon,
      connected: true,
      propertyCount: Object.keys(d.schema?.properties || {}).length,
      pageCount: typeof d.pageCount === 'number' ? d.pageCount : null,
      lastSync: d.lastSync || null,
    }));
    discovered.forEach((d) => {
      if (connectedIds.has(norm(d.id))) return;
      rows.push({
        id: `discovered:${d.id}`,
        notionId: d.id,
        title: d.title || 'Untitled',
        icon: d.icon,
        connected: false,
      });
    });
    return rows;
  }, [connected, discovered]);

  const filteredDatabases = databases.filter(db =>
    db.title?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Loading databases...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Search Bar */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={COLORS.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search databases..."
          placeholderTextColor={COLORS.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery ? (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <Ionicons name="close-circle" size={18} color={COLORS.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

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
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>NOTION DATABASES</Text>
          <Text style={styles.headerSubtitle}>
            Connect and manage your Notion workspace
          </Text>
        </View>

        {error ? (
          <View style={styles.noticeRow}>
            <Ionicons name="warning-outline" size={14} color="#f87171" />
            <Text style={[styles.noticeText, { color: '#f87171' }]}>{error}</Text>
            <TouchableOpacity onPress={loadConnected}>
              <Text style={styles.noticeAction}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {discovering ? (
          <View style={styles.noticeRow}>
            <ActivityIndicator size="small" color={COLORS.primary} />
            <Text style={styles.noticeText}>Searching your Notion workspace…</Text>
          </View>
        ) : discoverError ? (
          <View style={styles.noticeRow}>
            <Ionicons name="warning-outline" size={14} color={COLORS.textMuted} />
            <Text style={styles.noticeText} numberOfLines={2}>
              Workspace search failed: {discoverError}
            </Text>
            <TouchableOpacity onPress={loadDiscovered}>
              <Text style={styles.noticeAction}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Database List */}
        {filteredDatabases.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="server-outline" size={48} color={COLORS.textMuted} />
            <Text style={styles.emptyText}>
              {error ? 'Databases unavailable' : 'No databases found'}
            </Text>
            <Text style={styles.emptySubtext}>
              {searchQuery
                ? 'Try a different search term'
                : error
                  ? 'The gateway did not return your connected databases'
                  : discovering
                    ? 'Still searching your Notion workspace'
                    : 'No Notion databases are connected or shared with the integration yet'}
            </Text>
          </View>
        ) : (
          filteredDatabases.map((db) => (
            <View key={db.id} style={styles.databaseCard}>
              <LinearGradient
                colors={['rgba(10,10,10,0.9)', 'rgba(5,5,5,0.95)']}
                style={styles.cardGradient}
              >
                <View style={styles.cardHeader}>
                  <View style={styles.cardIcon}>
                    {db.icon ? (
                      <Text style={styles.cardIconText}>{db.icon}</Text>
                    ) : (
                      <Ionicons name="document-text-outline" size={18} color={COLORS.primary} />
                    )}
                  </View>
                  <View style={styles.cardInfo}>
                    <Text style={styles.cardTitle}>{db.title}</Text>
                    <Text style={styles.cardMeta}>
                      {db.connected
                        ? [
                            `${db.propertyCount} properties`,
                            db.pageCount !== null ? `${db.pageCount} pages` : null,
                            db.lastSync
                              ? `synced ${new Date(db.lastSync).toLocaleDateString()}`
                              : 'never synced',
                          ].filter(Boolean).join(' • ')
                        : 'Not connected'}
                    </Text>
                  </View>
                  <View style={[
                    styles.statusBadge,
                    db.connected ? styles.statusConnected : styles.statusDisconnected
                  ]}>
                    <Text style={styles.statusText}>
                      {db.connected ? 'CONNECTED' : 'AVAILABLE'}
                    </Text>
                  </View>
                </View>

                <View style={styles.cardActions}>
                  {db.connected ? (
                    <TouchableOpacity
                      style={styles.actionBtn}
                      onPress={() => handleSync(db)}
                      disabled={syncing === db.id}
                    >
                      {syncing === db.id ? (
                        <ActivityIndicator size="small" color={COLORS.primary} />
                      ) : (
                        <>
                          <Ionicons name="sync" size={16} color={COLORS.primary} />
                          <Text style={styles.actionText}>Sync</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.actionBtnPrimary]}
                      onPress={() => handleConnect(db)}
                      disabled={connecting === db.id}
                    >
                      {connecting === db.id ? (
                        <ActivityIndicator size="small" color="#000" />
                      ) : (
                        <>
                          <Ionicons name="link" size={16} color="#000" />
                          <Text style={[styles.actionText, { color: '#000' }]}>Connect</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              </LinearGradient>
            </View>
          ))
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  noticeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    marginBottom: 8,
  },
  noticeText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.textMuted,
  },
  noticeAction: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
  },
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
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    margin: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 14,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
    paddingTop: 0,
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
    paddingHorizontal: 40,
  },
  databaseCard: {
    marginBottom: 12,
    borderRadius: 0,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  cardGradient: {
    padding: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardIcon: {
    width: 40,
    height: 40,
    backgroundColor: COLORS.cardBorder,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardIconText: {
    fontSize: 18,
  },
  cardInfo: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  cardMeta: {
    fontSize: 10,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 0,
  },
  statusConnected: {
    backgroundColor: 'rgba(0,255,65,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,65,0.3)',
  },
  statusDisconnected: {
    backgroundColor: COLORS.cardBorder,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
  },
  statusText: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: COLORS.primary,
  },
  cardDescription: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 10,
    lineHeight: 16,
  },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.cardBorder,
    paddingTop: 12,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: COLORS.cardBorder,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
  },
  actionBtnPrimary: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  actionText: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.primary,
  },
});

export default DatabasesScreen;
