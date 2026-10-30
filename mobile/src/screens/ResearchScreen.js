/**
 * ResearchScreen — Research Intelligence feed.
 *
 * Mirrors the web Research tab: articles gathered for the configured topics,
 * served by `research:status`. Tapping an article opens its source and marks it
 * read; the bookmark toggle is persisted with `research:article.bookmark`.
 * Matches web UI gold/black HUD theme.
 */
import React, { useState, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  FlatList, ActivityIndicator, RefreshControl, Linking, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';
import { useResearch } from '../hooks/useResearch';

const IMPORTANCE_COLORS = {
  breaking: { bg: 'rgba(239,68,68,0.15)', text: '#f87171' },
  high: { bg: COLORS.primaryLight, text: COLORS.primary },
  medium: { bg: 'rgba(147,51,234,0.15)', text: '#c084fc' },
  low: { bg: 'rgba(107,114,128,0.15)', text: '#9ca3af' },
};

const SENTIMENT_ICONS = {
  bullish: { name: 'trending-up', color: '#4ade80' },
  bearish: { name: 'trending-down', color: '#f87171' },
  neutral: { name: 'remove', color: '#9ca3af' },
};

const FILTERS = [
  { key: 'all', label: 'ALL' },
  { key: 'unread', label: 'UNREAD' },
  { key: 'bookmarked', label: 'SAVED' },
];

export function ResearchScreen({ gateway, navigation }) {
  const research = useResearch(gateway);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState('all');

  const visible = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return research.articles.filter((a) => {
      if (filter === 'unread' && a.read) return false;
      if (filter === 'bookmarked' && !a.bookmarked) return false;
      if (!q) return true;
      return (
        (a.title || '').toLowerCase().includes(q) ||
        (a.summary || '').toLowerCase().includes(q) ||
        (a.source || '').toLowerCase().includes(q)
      );
    });
  }, [research.articles, searchQuery, filter]);

  const openArticle = useCallback((article) => {
    if (!article.read) research.toggleRead(article.id);
    if (article.sourceUrl) {
      Linking.openURL(article.sourceUrl).catch(() => {});
    }
  }, [research]);

  const unreadCount = research.stats?.unreadCount
    ?? research.articles.filter((a) => !a.read).length;

  const renderItem = ({ item }) => {
    const importance = IMPORTANCE_COLORS[item.importance] || IMPORTANCE_COLORS.low;
    const sentiment = SENTIMENT_ICONS[item.sentiment];
    return (
      <TouchableOpacity
        style={[styles.listItem, !item.read && styles.listItemSelected]}
        onPress={() => openArticle(item)}
        activeOpacity={0.8}
      >
        <View style={styles.listItemHeader}>
          <Text style={styles.listItemName} numberOfLines={2}>{item.title}</Text>
          <TouchableOpacity
            onPress={() => research.toggleBookmark(item.id)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons
              name={item.bookmarked ? 'bookmark' : 'bookmark-outline'}
              size={16}
              color={item.bookmarked ? COLORS.primary : COLORS.textMuted}
            />
          </TouchableOpacity>
        </View>
        {item.summary ? (
          <Text style={styles.listItemDesc} numberOfLines={3}>{item.summary}</Text>
        ) : null}
        <View style={styles.listItemFooter}>
          {item.importance ? (
            <View style={[styles.statusBadge, { backgroundColor: importance.bg }]}>
              <Text style={[styles.statusBadgeText, { color: importance.text }]}>
                {String(item.importance).toUpperCase()}
              </Text>
            </View>
          ) : null}
          {sentiment ? (
            <Ionicons name={sentiment.name} size={13} color={sentiment.color} />
          ) : null}
          {(item.topics || []).slice(0, 2).map((topic) => (
            <View key={topic} style={styles.tagBadge}>
              <Text style={styles.tagBadgeText}>{topic}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.listItemMeta}>
          {[
            item.source,
            item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : null,
            item.read ? 'read' : 'unread',
          ].filter(Boolean).join(' · ')}
        </Text>
      </TouchableOpacity>
    );
  };

  const renderEmpty = () => {
    if (research.loading && !research.loaded) {
      return (
        <View style={styles.emptyList}>
          <ActivityIndicator size="small" color={COLORS.primary} />
          <Text style={[styles.emptyListText, { marginTop: 12 }]}>LOADING...</Text>
        </View>
      );
    }
    if (research.error && !research.loaded) {
      return (
        <View style={styles.emptyList}>
          <Ionicons name="cloud-offline-outline" size={28} color={COLORS.textMuted} />
          <Text style={[styles.emptyListText, { marginTop: 12 }]}>RESEARCH UNAVAILABLE</Text>
          <TouchableOpacity style={[styles.newBtn, { marginTop: 14 }]} onPress={research.load}>
            <Text style={styles.newBtnText}>RETRY</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.emptyList}>
        <Ionicons name="newspaper-outline" size={28} color={COLORS.textMuted} />
        <Text style={[styles.emptyListText, { marginTop: 12 }]}>
          {research.articles.length > 0 ? 'NO MATCHES' : 'NO ARTICLES YET'}
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <View style={styles.sidebar}>
        <View style={styles.sidebarHeader}>
          <View style={styles.headerRow}>
            <Text style={styles.sidebarTitle}>RESEARCH</Text>
            {research.loaded ? (
              <Text style={styles.newBtnText}>
                {research.articles.length} ARTICLES · {unreadCount} UNREAD · {research.topics.length} TOPICS
              </Text>
            ) : null}
          </View>
          <TouchableOpacity
            style={styles.graphLink}
            onPress={() => navigation?.navigate?.('KnowledgeGraph', { layer: 'research', _ts: Date.now() })}
            accessibilityRole="button"
            accessibilityLabel="View research in the knowledge graph"
            testID="research-view-graph"
          >
            <Ionicons name="git-network-outline" size={14} color={COLORS.primary} />
            <Text style={styles.graphLinkText}>VIEW RESEARCH IN THE KNOWLEDGE GRAPH</Text>
            <Ionicons name="chevron-forward" size={13} color={COLORS.primary} />
          </TouchableOpacity>
          <TextInput
            style={styles.searchInput}
            placeholder="SEARCH ARTICLES..."
            placeholderTextColor={COLORS.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          <View style={styles.filterRow}>
            {FILTERS.map((f) => (
              <TouchableOpacity
                key={f.key}
                style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
                onPress={() => setFilter(f.key)}
              >
                <Text style={[styles.filterChipText, filter === f.key && styles.filterChipTextActive]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {research.error ? (
          <View style={styles.errorBar}>
            <Ionicons name="warning-outline" size={14} color="#f87171" />
            <Text style={[styles.errorText, { flex: 1, marginLeft: 6 }]}>{research.error}</Text>
            <TouchableOpacity onPress={research.load} style={{ paddingHorizontal: 8 }}>
              <Text style={[styles.errorText, { flex: 0, fontWeight: '700' }]}>RETRY</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={research.clearError}>
              <Ionicons name="close" size={16} color="#f87171" />
            </TouchableOpacity>
          </View>
        ) : null}

        <FlatList
          data={visible}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty}
          refreshControl={
            <RefreshControl
              refreshing={research.loading && research.loaded}
              onRefresh={research.load}
              tintColor={COLORS.primary}
            />
          }
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  graphLink: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, marginBottom: 8,
    borderWidth: 1, borderColor: COLORS.primary + '66', borderRadius: 12, backgroundColor: COLORS.primary + '14',
  },
  graphLinkText: { flex: 1, color: COLORS.primary, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  tabletLayout: {
    flex: 1,
    flexDirection: 'row',
  },

  // Sidebar
  sidebar: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderRightWidth: 1,
    borderRightColor: COLORS.cardBorder,
  },
  sidebarTablet: {
    flex: 0,
    width: 320,
    minWidth: 280,
  },
  sidebarHeader: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sidebarTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  newBtn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 2,
  },
  newBtnText: {
    fontSize: 10,
    color: COLORS.goldDim,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  searchInput: {
    backgroundColor: 'rgba(15,15,15,1)',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 2,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 11,
    color: COLORS.text,
    letterSpacing: 0.5,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  filterChip: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 2,
    backgroundColor: 'rgba(15,15,15,1)',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  filterChipActive: {
    backgroundColor: COLORS.cardBorder,
    borderColor: COLORS.primaryStrong,
  },
  filterChipText: {
    fontSize: 9,
    color: COLORS.textMuted,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  filterChipTextActive: {
    color: COLORS.primary,
  },

  // List
  listContent: {
    padding: 8,
  },
  listItem: {
    padding: 12,
    marginBottom: 4,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  listItemSelected: {
    backgroundColor: COLORS.primaryDim,
    borderColor: COLORS.primaryMuted,
  },
  listItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  listItemName: {
    flex: 1,
    fontSize: 12,
    fontWeight: '500',
    color: COLORS.text,
    marginRight: 8,
  },
  statusBadge: {
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 2,
  },
  statusBadgeText: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
  },
  listItemTopic: {
    fontSize: 10,
    color: COLORS.goldDim,
    marginBottom: 2,
  },
  listItemDesc: {
    fontSize: 10,
    color: COLORS.textMuted,
    marginBottom: 6,
  },
  listItemFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 4,
  },
  categoryBadge: {
    backgroundColor: COLORS.primaryDim,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  categoryBadgeText: {
    fontSize: 9,
    color: COLORS.goldDim,
    fontWeight: '600',
  },
  tagBadge: {
    backgroundColor: 'rgba(15,15,15,1)',
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 2,
  },
  tagBadgeText: {
    fontSize: 9,
    color: COLORS.textMuted,
  },
  listItemMeta: {
    fontSize: 9,
    color: '#4b5563',
    letterSpacing: 0.5,
  },
  emptyList: {
    padding: 20,
    alignItems: 'center',
  },
  emptyListText: {
    fontSize: 11,
    color: COLORS.textMuted,
  },

  // Editor
  editor: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  editorTablet: {
    borderLeftWidth: 1,
    borderLeftColor: COLORS.cardBorder,
  },
  emptyEditor: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 12,
    color: '#4b5563',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // Toolbar
  editorToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    paddingHorizontal: 16,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  toolbarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  toolbarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  backBtn: {
    padding: 4,
  },
  toolbarTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 1,
    flex: 1,
  },
  deleteBtn: {
    padding: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: 'rgba(220,38,38,0.2)',
    borderRadius: 2,
  },
  deleteBtnText: {
    fontSize: 12,
  },
  saveBtn: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    backgroundColor: COLORS.cardBorder,
    borderWidth: 1,
    borderColor: COLORS.goldDim,
    borderRadius: 2,
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 1,
  },

  // Error
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 8,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(127,29,29,0.3)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(220,38,38,0.2)',
  },
  errorText: {
    fontSize: 11,
    color: '#fca5a5',
    flex: 1,
  },
  errorDismiss: {
    fontSize: 12,
    color: '#fca5a5',
    padding: 4,
  },

  // Editor Content
  editorContent: {
    flex: 1,
  },
  editorScroll: {
    flex: 1,
  },
  metaFields: {
    padding: 12,
    paddingHorizontal: 16,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  metaRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  metaField: {
    flex: 1,
  },
  metaLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: COLORS.goldDim,
    marginBottom: 4,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  metaInput: {
    backgroundColor: 'rgba(15,15,15,1)',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 2,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 12,
    color: COLORS.text,
  },
  statusPicker: {
    flexDirection: 'row',
    gap: 4,
  },
  statusOption: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(15,15,15,1)',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 2,
  },
  statusOptionActive: {
    backgroundColor: COLORS.cardBorder,
    borderColor: COLORS.primaryStrong,
  },
  statusOptionText: {
    fontSize: 9,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  statusOptionTextActive: {
    color: COLORS.primary,
  },

  // Body
  bodySection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  bodyInput: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 2,
    padding: 12,
    fontSize: 13,
    color: COLORS.text,
    lineHeight: 22,
    minHeight: 200,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // Sources
  sourcesSection: {
    padding: 16,
    backgroundColor: COLORS.surface,
  },
  sourcesInput: {
    backgroundColor: 'rgba(15,15,15,1)',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 2,
    padding: 8,
    fontSize: 11,
    color: COLORS.text,
    minHeight: 60,
  },

  // Status Bar
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 6,
    paddingHorizontal: 16,
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.cardBorder,
  },
  statusBarText: {
    fontSize: 10,
    color: '#4b5563',
    letterSpacing: 0.5,
  },
  statusBarHint: {
    fontSize: 10,
    color: COLORS.goldDim,
    letterSpacing: 0.5,
  },
});

export default ResearchScreen;
