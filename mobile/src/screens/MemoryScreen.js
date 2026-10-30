/**
 * MemoryScreen — AI Memory Management
 * View the default agent's identity/memory files.
 *
 * Backed by `agent.identity.files.list` / `agent.identity.files.read` (the same
 * RPCs the web Agent Identity view uses). The gateway has no memory.* RPCs and
 * no semantic memory search over the socket, so the search box filters the
 * file list by name only.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, TextInput, Modal,
  useWindowDimensions
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../constants/theme';

// Memory file types
const FILE_TYPES = {
  memory: { icon: 'document-text', color: '#22c55e', label: 'MEMORY' },
  soul: { icon: 'heart', color: '#ec4899', label: 'SOUL' },
  user: { icon: 'person', color: '#3b82f6', label: 'USER' },
  tools: { icon: 'construct', color: '#f59e0b', label: 'TOOLS' },
  agents: { icon: 'people', color: '#8b5cf6', label: 'AGENTS' },
  identity: { icon: 'finger-print', color: '#06b6d4', label: 'IDENTITY' },
  heartbeat: { icon: 'pulse', color: '#ef4444', label: 'HEARTBEAT' },
  daily: { icon: 'calendar', color: '#a1a1aa', label: 'DAILY' },
};

function getFileType(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes('memory')) return 'memory';
  if (lower.includes('soul')) return 'soul';
  if (lower.includes('user')) return 'user';
  if (lower.includes('tools')) return 'tools';
  if (lower.includes('agents')) return 'agents';
  if (lower.includes('identity')) return 'identity';
  if (lower.includes('heartbeat')) return 'heartbeat';
  if (/\d{4}-\d{2}-\d{2}/.test(lower)) return 'daily';
  return 'memory';
}

function MemoryFileCard({ file, onPress }) {
  const fileType = FILE_TYPES[getFileType(file.name)] || FILE_TYPES.memory;
  const sizeKb = file.size ? Math.round(file.size / 1024 * 10) / 10 : 0;
  
  return (
    <TouchableOpacity style={styles.fileCard} onPress={() => onPress(file)} activeOpacity={0.8}>
      <View style={[styles.fileIcon, { backgroundColor: fileType.color + '15' }]}>
        <Ionicons name={fileType.icon} size={22} color={fileType.color} />
      </View>
      <View style={styles.fileInfo}>
        <Text style={styles.fileName}>{file.name}</Text>
        <View style={styles.fileMeta}>
          <View style={[styles.fileTypeBadge, { backgroundColor: fileType.color + '20' }]}>
            <Text style={[styles.fileTypeText, { color: fileType.color }]}>{fileType.label}</Text>
          </View>
          <Text style={styles.fileSize}>{file.size > 0 ? `${sizeKb} KB` : 'Empty'}</Text>
          {file.modified > 0 && (
            <Text style={styles.fileModified}>
              {new Date(file.modified).toLocaleDateString()}
            </Text>
          )}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
    </TouchableOpacity>
  );
}

function FileViewerModal({ visible, file, content, loading, error, onRetry, onClose }) {
  if (!file) return null;

  const fileType = FILE_TYPES[getFileType(file.name)] || FILE_TYPES.memory;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.viewerContainer}>
        {/* Header */}
        <View style={styles.viewerHeader}>
          <TouchableOpacity onPress={onClose} style={styles.viewerClose}>
            <Ionicons name="close" size={24} color={COLORS.textMuted} />
          </TouchableOpacity>
          <View style={styles.viewerTitleRow}>
            <Ionicons name={fileType.icon} size={18} color={fileType.color} />
            <Text style={styles.viewerTitle} numberOfLines={1}>{file.name}</Text>
          </View>
          <View style={{ width: 40 }} />
        </View>

        {/* Content */}
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#22c55e" />
            <Text style={styles.loadingText}>Loading file...</Text>
          </View>
        ) : error ? (
          <View style={styles.emptyState}>
            <Ionicons name="warning-outline" size={36} color="#ef4444" />
            <Text style={styles.emptyTitle}>Could not load file</Text>
            <Text style={styles.emptyText}>{error}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={onRetry}>
              <Ionicons name="refresh" size={14} color="#22c55e" />
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : content ? (
          <ScrollView style={styles.viewerContent}>
            <Text style={styles.viewerText}>{content}</Text>
          </ScrollView>
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="document-outline" size={36} color={COLORS.textMuted} />
            <Text style={styles.emptyTitle}>Empty file</Text>
            <Text style={styles.emptyText}>This file has no content yet</Text>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

export function MemoryScreen({ navigation, gateway }) {
  const { width } = useWindowDimensions();
  
  const [files, setFiles] = useState([]);
  const [agentId, setAgentId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState(null);
  const [showViewer, setShowViewer] = useState(false);
  const readSeq = useRef(0);

  const loadMemory = useCallback(async () => {
    if (!gateway?.sendReq) return;
    setLoading(true);
    setError(null);

    try {
      // -> { agentId, workspace, files: [{ filename, exists, size, modified, readOnly }] }
      const result = await gateway.sendReq('agent.identity.files.list', {});
      const rows = Array.isArray(result?.files) ? result.files : [];
      setAgentId(result?.agentId || null);
      setFiles(
        rows
          .filter((f) => f && f.exists && f.filename)
          .map((f) => ({ name: f.filename, size: f.size || 0, modified: f.modified || 0 })),
      );
    } catch (err) {
      setFiles([]);
      setError(err?.message || 'Could not load memory files');
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  useEffect(() => {
    loadMemory();
  }, [loadMemory]);

  const handleViewFile = useCallback(async (file) => {
    if (!gateway?.sendReq) return;
    const seq = ++readSeq.current;
    setSelectedFile(file);
    setFileContent('');
    setFileError(null);
    setFileLoading(true);
    setShowViewer(true);

    try {
      // -> { agentId, content: string | null, filename, exists, size, modified }
      const params = { filename: file.name };
      if (agentId) params.agentId = agentId;
      const result = await gateway.sendReq('agent.identity.files.read', params);
      if (seq !== readSeq.current) return;
      setFileContent(typeof result?.content === 'string' ? result.content : '');
    } catch (err) {
      if (seq !== readSeq.current) return;
      setFileError(err?.message || 'Request failed');
    } finally {
      if (seq === readSeq.current) setFileLoading(false);
    }
  }, [gateway, agentId]);

  const visibleFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.name.toLowerCase().includes(q));
  }, [files, searchQuery]);

  // Group files by type
  const groupedFiles = visibleFiles.reduce((acc, file) => {
    const type = getFileType(file.name);
    if (!acc[type]) acc[type] = [];
    acc[type].push(file);
    return acc;
  }, {});
  
  // Reorder groups
  const groupOrder = ['memory', 'soul', 'user', 'identity', 'agents', 'tools', 'heartbeat', 'daily'];
  const orderedGroups = groupOrder.filter(g => groupedFiles[g]?.length > 0);
  
  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const totalSizeKb = Math.round(totalSize / 1024);
  
  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      {/* Hero Header */}
      <View style={styles.heroHeader}>
        <LinearGradient
          colors={['rgba(34,197,94,0.08)', 'transparent']}
          style={styles.heroGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        />
        
        <View style={styles.heroContent}>
          <View style={styles.heroBadge}>
            <MaterialCommunityIcons name="brain" size={14} color="#22c55e" />
            <Text style={[styles.heroBadgeText, { color: '#22c55e' }]}>MEMORY</Text>
          </View>
          <Text style={styles.heroTitle}>Agent Memory</Text>
          <Text style={styles.heroSubtitle}>
            {agentId ? `Identity and memory files for @${agentId}` : 'Long-term memory, identity, and context files'}
          </Text>
        </View>
        
        {/* Stats */}
        <View style={styles.heroStats}>
          <View style={styles.heroStat}>
            <Text style={[styles.heroStatValue, { color: '#22c55e' }]}>{files.length}</Text>
            <Text style={styles.heroStatLabel}>Files</Text>
          </View>
          <View style={styles.heroStatDivider} />
          <View style={styles.heroStat}>
            <Text style={[styles.heroStatValue, { color: '#22c55e' }]}>{totalSizeKb}</Text>
            <Text style={styles.heroStatLabel}>KB Total</Text>
          </View>
        </View>
        
        {/* Search */}
        <View style={styles.searchContainer}>
          <Ionicons name="search" size={18} color={COLORS.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Filter files by name..."
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={18} color={COLORS.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>
      
      {/* Error */}
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={14} color="#ef4444" />
          <Text style={[styles.errorText, { flex: 1 }]}>{error}</Text>
          <TouchableOpacity style={styles.retryBtnInline} onPress={loadMemory}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
      
      {/* Content */}
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadMemory} tintColor="#22c55e" />
        }
      >
        {loading && files.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#22c55e" />
            <Text style={styles.loadingText}>Loading memory files...</Text>
          </View>
        ) : (
          <View style={styles.filesList}>
            {orderedGroups.map(group => (
              <View key={group} style={styles.fileGroup}>
                <View style={styles.groupHeader}>
                  <Ionicons 
                    name={FILE_TYPES[group].icon} 
                    size={16} 
                    color={FILE_TYPES[group].color} 
                  />
                  <Text style={[styles.groupTitle, { color: FILE_TYPES[group].color }]}>
                    {FILE_TYPES[group].label}
                  </Text>
                  <View style={styles.groupCount}>
                    <Text style={styles.groupCountText}>{groupedFiles[group].length}</Text>
                  </View>
                </View>
                
                {groupedFiles[group].map((file, i) => (
                  <MemoryFileCard
                    key={`${file.name}-${i}`}
                    file={file}
                    onPress={handleViewFile}
                  />
                ))}
              </View>
            ))}
            
            {visibleFiles.length === 0 && (
              <View style={styles.emptyState}>
                <MaterialCommunityIcons name="brain" size={48} color={COLORS.textMuted} />
                <Text style={styles.emptyTitle}>
                  {error ? 'Memory unavailable' : files.length > 0 ? 'No matching files' : 'No Memory Files'}
                </Text>
                <Text style={styles.emptyText}>
                  {error
                    ? 'The gateway did not return the memory files'
                    : files.length > 0
                      ? 'No file name matches your filter'
                      : 'This agent has no identity or memory files yet'}
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
      
      {/* File Viewer */}
      <FileViewerModal
        visible={showViewer}
        file={selectedFile}
        content={fileContent}
        loading={fileLoading}
        error={fileError}
        onRetry={() => selectedFile && handleViewFile(selectedFile)}
        onClose={() => setShowViewer(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.35)',
    backgroundColor: 'rgba(34,197,94,0.1)',
  },
  retryBtnInline: {
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  retryBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#22c55e',
  },
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  
  // Hero
  heroHeader: {
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(34,197,94,0.15)',
    position: 'relative',
  },
  heroGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  heroContent: {
    marginBottom: 16,
  },
  heroBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(34,197,94,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.2)',
    borderRadius: 4,
    marginBottom: 12,
  },
  heroBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  heroSubtitle: {
    fontSize: 13,
    color: COLORS.textMuted,
  },
  heroStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    marginBottom: 16,
  },
  heroStat: {
    alignItems: 'center',
  },
  heroStatValue: {
    fontSize: 24,
    fontWeight: '700',
  },
  heroStatLabel: {
    fontSize: 10,
    color: COLORS.textMuted,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  heroStatDivider: {
    width: 1,
    height: 28,
    backgroundColor: 'rgba(34,197,94,0.2)',
  },
  
  // Search
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.15)',
    borderRadius: 10,
    paddingHorizontal: 12,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 14,
    color: COLORS.text,
  },
  
  // Error
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(239,68,68,0.2)',
  },
  errorText: {
    fontSize: 12,
    color: '#f87171',
  },
  
  // Content
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 12,
    color: COLORS.textMuted,
  },
  
  // Files
  filesList: {
    gap: 20,
  },
  fileGroup: {
    gap: 8,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  groupTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  groupCount: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  groupCountText: {
    fontSize: 10,
    color: COLORS.textMuted,
  },
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(10,10,10,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
  fileIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 4,
  },
  fileMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fileTypeBadge: {
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 4,
  },
  fileTypeText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  fileSize: {
    fontSize: 11,
    color: COLORS.textMuted,
  },
  fileModified: {
    fontSize: 11,
    color: COLORS.textMuted,
  },
  
  // Search Results
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
    marginTop: 16,
  },
  emptyText: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginTop: 4,
  },
  
  // Viewer Modal
  viewerContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  viewerClose: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  viewerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    maxWidth: 200,
  },
  viewerContent: {
    flex: 1,
    padding: 16,
  },
  viewerText: {
    fontSize: 13,
    color: COLORS.text,
    lineHeight: 22,
    fontFamily: 'monospace',
  },
});

export default MemoryScreen;
