/**
 * FederationDirectoryScreen — Browse the federation file system + registered directories.
 *
 * Two segments, one screen:
 *   • EXPLORE    — peer-aware file explorer. Pick a federation peer (chips,
 *                  local first), then lazily browse its file system through
 *                  `federation.files.list { peerId, path }`. Roots come from
 *                  `federation.files.roots.list`. Long-press a folder to
 *                  register it via the "Save to InfiniBot" sheet.
 *   • REGISTERED — the original federated-directory list, pulled from
 *                  `federation.resources.directories` (local + remote with
 *                  sync metadata). Unchanged behaviour.
 *
 * Peer reach is surfaced on the chips (green/grey dot + dimmed when offline)
 * and the last-known listing per (peerId, path) is cached so a peer dropping
 * mid-session shows a "stale" pill instead of blanking.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  StyleSheet,
  RefreshControl,
  Alert,
  Modal,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  TERMINAL_COLORS as C,
  TERMINAL_FONTS as F,
  TERMINAL_SPACING as S,
  TERMINAL_PROMPTS,
  TERMINAL_SHADOWS,
} from '../constants/terminal-theme';
import { useFederation } from '../hooks/useFederation';
import { COLORS } from '../constants/theme';

const LOCAL_NODE_ID = 'local';

// Node states that count as "reachable". Reach signal is derived from the
// `status` field returned by `federation.nodes.list` (surfaced through the
// useFederation hook) — there is no dedicated reachability RPC yet.
// TODO: wire reach — swap this for a real reachability ping if the backend adds one.
const ONLINE_STATES = ['online', 'connected', 'registered', 'ready'];

function timeAgo(ts) {
  if (!ts) return 'unknown';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function isReachable(node) {
  if (!node) return false;
  if (node.isLocal || node.id === LOCAL_NODE_ID) return true;
  if (!node.status) return true; // default to online when status is unknown
  return ONLINE_STATES.includes(String(node.status).toLowerCase());
}

function basename(p) {
  if (!p) return '~';
  const parts = String(p).split('/').filter(Boolean);
  return parts[parts.length - 1] || String(p);
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

function fileIconName(entry) {
  if (entry.isDirectory || entry.type === 'folder') return 'folder';
  switch (entry.type) {
    case 'code': return 'code-slash';
    case 'image': return 'image';
    case 'video': return 'film';
    case 'audio': return 'musical-notes';
    case 'archive': return 'archive';
    case 'document': return 'document-text';
    default: return 'document-outline';
  }
}

function NodeFilterChips({ nodeNames, value, onChange }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipBar}
      contentContainerStyle={styles.chipBarContent}
    >
      <TouchableOpacity
        style={[styles.chip, value === 'all' && styles.chipActive]}
        onPress={() => onChange('all')}
      >
        <Text style={[styles.chipText, value === 'all' && styles.chipTextActive]}>ALL</Text>
      </TouchableOpacity>
      {nodeNames.map((n) => (
        <TouchableOpacity
          key={n.id}
          style={[styles.chip, value === n.id && styles.chipActive]}
          onPress={() => onChange(n.id)}
        >
          <Text style={[styles.chipText, value === n.id && styles.chipTextActive]} numberOfLines={1}>
            {n.label}
          </Text>
          <Text style={styles.chipCount}>{n.count}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function DirectoryRow({ entry, onAction }) {
  const isStale = entry.syncStatus === 'stale';
  return (
    <View style={styles.row}>
      <View style={[styles.rowIconWrap, isStale && styles.rowIconStale]}>
        {entry.icon ? (
          <Text style={styles.rowIcon}>{entry.icon}</Text>
        ) : (
          <Ionicons name="folder-outline" size={18} color={COLORS.primary} />
        )}
      </View>
      <View style={styles.rowText}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowName} numberOfLines={1}>{entry.name}</Text>
          {entry.agentId && (
            <Text style={styles.rowTag}>{String(entry.agentId).toUpperCase()}</Text>
          )}
        </View>
        <Text style={styles.rowPath} numberOfLines={1}>{entry.path}</Text>
        <View style={styles.rowMetaLine}>
          <Ionicons name={entry.sourceNode === 'local' ? 'home' : 'git-network'} size={11} color={C.textDim} />
          <Text style={styles.rowMeta}>{entry.nodeName}</Text>
          <Text style={styles.rowMetaSep}>·</Text>
          <Text style={[styles.rowMeta, isStale && { color: C.warning }]}>
            {isStale ? 'stale' : 'synced'} {timeAgo(entry.lastSync)}
          </Text>
        </View>
        {entry.tags?.length ? (
          <View style={styles.tagRow}>
            {entry.tags.slice(0, 4).map((t) => (
              <View key={t} style={styles.tagPill}>
                <Text style={styles.tagText}>{t}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
      <TouchableOpacity
        style={styles.rowAction}
        onPress={() => onAction(entry)}
        hitSlop={8}
      >
        <Ionicons name="ellipsis-vertical" size={16} color={C.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

// ── Explorer: segment toggle ─────────────────────────────────

function SegmentToggle({ value, onChange }) {
  const segs = [
    { id: 'explore', label: 'EXPLORE', icon: 'compass-outline' },
    { id: 'registered', label: 'REGISTERED', icon: 'bookmark-outline' },
  ];
  return (
    <View style={x.segmentRow}>
      {segs.map((s) => {
        const active = value === s.id;
        return (
          <TouchableOpacity
            key={s.id}
            style={[x.segment, active && x.segmentActive]}
            onPress={() => onChange(s.id)}
            activeOpacity={0.8}
          >
            <Ionicons name={s.icon} size={13} color={active ? C.gold : C.textDim} />
            <Text style={[x.segmentText, active && x.segmentTextActive]}>{s.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ── Explorer: peer chips ─────────────────────────────────────

function PeerChips({ peers, activePeerId, onSelect }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipBar}
      contentContainerStyle={styles.chipBarContent}
    >
      {peers.map((p) => {
        const active = p.id === activePeerId;
        const reachable = isReachable(p);
        const local = p.isLocal || p.id === LOCAL_NODE_ID;
        return (
          <TouchableOpacity
            key={p.id}
            style={[styles.chip, active && styles.chipActive, !reachable && x.chipOffline]}
            onPress={() => onSelect(p.id)}
            activeOpacity={0.8}
          >
            <View style={[x.reachDot, { backgroundColor: reachable ? C.ok : C.textDim }]} />
            <Ionicons
              name={local ? 'home' : 'cloud'}
              size={11}
              color={active ? C.gold : C.textDim}
            />
            <Text
              style={[styles.chipText, active && styles.chipTextActive]}
              numberOfLines={1}
            >
              {p.name || p.label || p.id}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ── Explorer: roots quick-jump + breadcrumb ──────────────────

function RootsBar({ roots, currentPath, onJump }) {
  if (!roots || roots.length <= 1) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={x.rootsBar}
      contentContainerStyle={x.rootsBarContent}
    >
      {roots.map((r) => {
        const active = (r.path || '') === (currentPath || '');
        return (
          <TouchableOpacity
            key={r.id || r.path}
            style={[x.rootChip, active && x.rootChipActive]}
            onPress={() => onJump(r)}
            activeOpacity={0.8}
          >
            <Ionicons name="server-outline" size={10} color={active ? C.gold : C.textDim} />
            <Text style={[x.rootChipText, active && { color: C.gold }]} numberOfLines={1}>
              {r.name || basename(r.path)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

function Breadcrumb({ trail, onCrumb, onUp }) {
  return (
    <View style={x.crumbRow}>
      <TouchableOpacity
        onPress={onUp}
        disabled={trail.length <= 1}
        style={[x.upBtn, trail.length <= 1 && { opacity: 0.35 }]}
        hitSlop={8}
      >
        <Ionicons name="arrow-up" size={14} color={C.gold} />
      </TouchableOpacity>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={x.crumbContent}
      >
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <View key={`${c.path}-${i}`} style={x.crumbItem}>
              {i > 0 && <Ionicons name="chevron-forward" size={11} color={C.textDim} />}
              <TouchableOpacity onPress={() => onCrumb(i)} disabled={last} hitSlop={6}>
                <Text style={[x.crumbText, last && x.crumbTextActive]} numberOfLines={1}>
                  {c.name}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ── Explorer: file/folder row ────────────────────────────────

function FileRow({ entry, onOpen, onLongPress }) {
  const isDir = entry.isDirectory || entry.type === 'folder';
  return (
    <TouchableOpacity
      style={x.fileRow}
      onPress={() => onOpen(entry)}
      onLongPress={isDir ? () => onLongPress(entry) : undefined}
      delayLongPress={350}
      activeOpacity={0.75}
    >
      <View style={[x.fileIconWrap, isDir && x.fileIconWrapDir]}>
        <Ionicons name={fileIconName(entry)} size={16} color={isDir ? C.gold : C.textMuted} />
      </View>
      <View style={x.fileMain}>
        <Text style={x.fileName} numberOfLines={1}>{entry.name}</Text>
        <Text style={x.fileSub} numberOfLines={1}>
          {isDir ? 'folder' : (formatSize(entry.size) || entry.type || 'file')}
          {entry.modified ? `  ·  ${timeAgo(entry.modified)}` : ''}
        </Text>
      </View>
      {isDir ? (
        <Ionicons name="chevron-forward" size={16} color={C.textDim} />
      ) : (
        <Ionicons name="eye-outline" size={15} color={C.textSubtle} />
      )}
    </TouchableOpacity>
  );
}

// ── Explorer: "Save to InfiniBot" bottom sheet ───────────────

function SaveSheet({ visible, folder, peerLabel, submitting, onClose, onSubmit }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [projectId, setProjectId] = useState('');
  const [agentId, setAgentId] = useState('');

  useEffect(() => {
    if (visible && folder) {
      setName(basename(folder.path));
      setDescription('');
      setTags('');
      setProjectId('');
      setAgentId('');
    }
  }, [visible, folder]);

  const submit = () => {
    onSubmit({ name, description, tags, projectId, agentId });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={x.backdrop} onPress={onClose}>
        <Pressable style={x.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={x.sheetHeader}>
            <Ionicons name="bookmark" size={16} color={C.gold} />
            <Text style={x.sheetTitle}>SAVE TO INFINIBOT</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={18} color={C.textMuted} />
            </TouchableOpacity>
          </View>

          {folder && (
            <View style={x.sheetPathRow}>
              <Ionicons name="folder" size={12} color={C.gold} />
              <Text style={x.sheetPath} numberOfLines={1}>{folder.path || '~'}</Text>
              {!!peerLabel && (
                <View style={x.sheetPeerPill}>
                  <Text style={x.sheetPeerText} numberOfLines={1}>{peerLabel}</Text>
                </View>
              )}
            </View>
          )}

          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 360 }}>
            <Text style={x.label}>NAME</Text>
            <TextInput
              style={x.input}
              value={name}
              onChangeText={setName}
              placeholder="directory name"
              placeholderTextColor={C.textDim}
              autoCapitalize="none"
            />

            <Text style={x.label}>DESCRIPTION</Text>
            <TextInput
              style={[x.input, { height: 64, textAlignVertical: 'top' }]}
              value={description}
              onChangeText={setDescription}
              placeholder="what is this directory for?"
              placeholderTextColor={C.textDim}
              multiline
            />

            <Text style={x.label}>TAGS (comma separated)</Text>
            <TextInput
              style={x.input}
              value={tags}
              onChangeText={setTags}
              placeholder="e.g. frontend, infra, docs"
              placeholderTextColor={C.textDim}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={x.twoCol}>
              <View style={x.col}>
                <Text style={x.label}>PROJECT ID</Text>
                <TextInput
                  style={x.input}
                  value={projectId}
                  onChangeText={setProjectId}
                  placeholder="optional"
                  placeholderTextColor={C.textDim}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={x.col}>
                <Text style={x.label}>AGENT ID</Text>
                <TextInput
                  style={x.input}
                  value={agentId}
                  onChangeText={setAgentId}
                  placeholder="optional"
                  placeholderTextColor={C.textDim}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>
          </ScrollView>

          <View style={x.sheetActions}>
            <TouchableOpacity onPress={onClose} style={x.btnSecondary} disabled={submitting}>
              <Text style={x.btnSecondaryText}>CANCEL</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={submit}
              style={[x.btnPrimary, submitting && { opacity: 0.6 }]}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={C.bg0} />
              ) : (
                <Ionicons name="cloud-upload" size={14} color={C.bg0} />
              )}
              <Text style={x.btnPrimaryText}>{submitting ? 'SAVING' : 'SAVE'}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function FederationDirectoryScreen({ navigation, gateway }) {
  const federation = useFederation(gateway);
  const { nodes, directories, dirsLoading, refreshDirs, selectNode } = federation;

  // ── Segment ──
  const [segment, setSegment] = useState('explore');

  // ── Registered tab (original behaviour) ──
  const [query, setQuery] = useState('');
  const [filterNode, setFilterNode] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  // ── Explorer tab ──
  const [activePeerId, setActivePeerId] = useState(null);
  const [trailByPeer, setTrailByPeer] = useState({}); // peerId -> [{ path, name }]
  const [rootsByPeer, setRootsByPeer] = useState({}); // peerId -> [{ id, path, name }]
  const [entries, setEntries] = useState([]);
  const [listing, setListing] = useState(false);
  const [expRefreshing, setExpRefreshing] = useState(false);
  const [listError, setListError] = useState(null);
  const [servingStale, setServingStale] = useState(false);
  const listCacheRef = useRef({}); // `${peerId}|${path}` -> { items, ts }

  // ── Save sheet + toast ──
  const [saveFolder, setSaveFolder] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  useEffect(() => {
    refreshDirs();
  }, [refreshDirs]);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  // Peers: local first, then the rest in roster order.
  const peers = useMemo(() => {
    const arr = [...nodes];
    arr.sort((a, b) => {
      const al = a.isLocal || a.id === LOCAL_NODE_ID ? 0 : 1;
      const bl = b.isLocal || b.id === LOCAL_NODE_ID ? 0 : 1;
      return al - bl;
    });
    return arr;
  }, [nodes]);

  // Anchor the active peer to the first (local) peer once the roster loads.
  useEffect(() => {
    if (!activePeerId && peers.length) setActivePeerId(peers[0].id);
  }, [peers, activePeerId]);

  const activePeer = useMemo(
    () => peers.find((p) => p.id === activePeerId) || null,
    [peers, activePeerId],
  );

  const trail = trailByPeer[activePeerId] || [{ path: '', name: '~' }];
  const currentPath = trail[trail.length - 1]?.path ?? '';

  const setTrailForPeer = useCallback((peerId, next) => {
    setTrailByPeer((prev) => {
      const cur = prev[peerId] || [{ path: '', name: '~' }];
      const resolved = typeof next === 'function' ? next(cur) : next;
      return { ...prev, [peerId]: resolved };
    });
  }, []);

  // ── Load roots when a peer is first activated (cache per peer) ──
  const loadRoots = useCallback(async (peerId) => {
    if (!gateway?.sendReq || !peerId) return;
    try {
      const res = await gateway.sendReq('federation.files.roots.list', { peerId });
      const roots = [];
      // mainRoot is the canonical infinibot files root — browse it via the
      // empty path so `files.list` resolves it to FILES_ROOT server-side.
      if (res?.mainRoot) roots.push({ id: 'main', path: '', name: res.mainRoot.name || 'infinibot' });
      if (Array.isArray(res?.roots)) {
        for (const r of res.roots) roots.push({ id: r.id, path: r.path, name: r.name });
      }
      setRootsByPeer((prev) => ({ ...prev, [peerId]: roots }));
    } catch {
      setRootsByPeer((prev) => ({ ...prev, [peerId]: [] }));
    }
  }, [gateway]);

  // ── Load a directory listing for (peerId, path) ──
  const loadList = useCallback(async (peerId, path, { refresh = false } = {}) => {
    if (!gateway?.sendReq || !peerId) return;
    const key = `${peerId}|${path || ''}`;
    if (refresh) setExpRefreshing(true); else setListing(true);
    setListError(null);
    try {
      const res = await gateway.sendReq('federation.files.list', { peerId, path: path || '' });
      const items = Array.isArray(res?.items) ? res.items : [];
      listCacheRef.current[key] = { items, ts: Date.now() };
      setEntries(items);
      setServingStale(false);
    } catch (err) {
      // Peer may have dropped — fall back to the last-known listing so the
      // screen doesn't blank, and flag it as stale.
      const cached = listCacheRef.current[key];
      if (cached) {
        setEntries(cached.items);
        setServingStale(true);
      } else {
        setEntries([]);
        setServingStale(false);
      }
      setListError(err?.message || String(err));
    } finally {
      setListing(false);
      setExpRefreshing(false);
    }
  }, [gateway]);

  // Roots: load once per peer.
  useEffect(() => {
    if (segment !== 'explore' || !activePeerId) return;
    if (rootsByPeer[activePeerId]) return;
    loadRoots(activePeerId);
  }, [segment, activePeerId, rootsByPeer, loadRoots]);

  // Listing: (re)load whenever the active peer or its current path changes.
  useEffect(() => {
    if (segment !== 'explore' || !activePeerId) return;
    loadList(activePeerId, currentPath);
  }, [segment, activePeerId, currentPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Explorer navigation ──
  const enterFolder = useCallback((entry) => {
    setTrailForPeer(activePeerId, (t) => [...t, { path: entry.path, name: entry.name }]);
  }, [activePeerId, setTrailForPeer]);

  const onCrumb = useCallback((i) => {
    setTrailForPeer(activePeerId, (t) => t.slice(0, i + 1));
  }, [activePeerId, setTrailForPeer]);

  const goUp = useCallback(() => {
    setTrailForPeer(activePeerId, (t) => (t.length > 1 ? t.slice(0, -1) : t));
  }, [activePeerId, setTrailForPeer]);

  const jumpToRoot = useCallback((root) => {
    setTrailForPeer(activePeerId, [{ path: root.path || '', name: root.name || '~' }]);
  }, [activePeerId, setTrailForPeer]);

  const onOpenEntry = useCallback(async (entry) => {
    const isDir = entry.isDirectory || entry.type === 'folder';
    if (isDir) {
      enterFolder(entry);
      return;
    }
    // File preview is out of scope for large files — surface the backend
    // >5MB error as an alert; otherwise show a short text preview.
    try {
      const res = await gateway.sendReq('federation.files.read', { peerId: activePeerId, path: entry.path });
      const content = String(res?.content ?? '');
      Alert.alert(
        entry.name,
        content.length ? content.slice(0, 800) + (content.length > 800 ? '\n\n…(truncated)' : '') : '(empty file)',
      );
    } catch (err) {
      Alert.alert('Cannot open file', err?.message || 'Failed to read file');
    }
  }, [gateway, activePeerId, enterFolder]);

  const onLongPressFolder = useCallback((entry) => {
    setSaveFolder(entry);
  }, []);

  const handleSave = useCallback(async (form) => {
    if (!saveFolder) return;
    const name = (form.name || '').trim() || basename(saveFolder.path);
    setSaving(true);
    try {
      await gateway.sendReq('directories.create', {
        path: saveFolder.path,
        name,
        peerId: activePeerId,
        peerLabel: activePeer?.name || activePeer?.label || activePeerId,
        description: form.description?.trim() || undefined,
        tags: (form.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
        projectId: form.projectId?.trim() || undefined,
        agentId: form.agentId?.trim() || undefined,
        icon: '📁',
      });
      setSaveFolder(null);
      showToast(`Saved “${name}” to InfiniBot`);
      refreshDirs();
    } catch (err) {
      Alert.alert('Save failed', err?.message || 'Could not register directory');
    } finally {
      setSaving(false);
    }
  }, [gateway, saveFolder, activePeerId, activePeer, showToast, refreshDirs]);

  // ── Registered tab data ──
  const nodeNames = useMemo(() => {
    const map = new Map();
    for (const d of directories) {
      const key = d.sourceNode || 'unknown';
      const existing = map.get(key);
      if (existing) {
        existing.count++;
      } else {
        map.set(key, { id: key, label: d.nodeName || key, count: 1 });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [directories]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return directories.filter((d) => {
      if (filterNode !== 'all' && d.sourceNode !== filterNode) return false;
      if (!q) return true;
      const haystack = [
        d.name, d.path, d.description, d.agentId, d.projectId,
        ...(d.tags || []),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [directories, query, filterNode]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshDirs();
    setRefreshing(false);
  }, [refreshDirs]);

  const handleAction = useCallback((entry) => {
    Alert.alert(
      entry.name,
      `${entry.path}\n\nSource: ${entry.nodeName} (${entry.sourceNode})`,
      [
        {
          text: 'Route chat here',
          onPress: () => {
            selectNode(entry.sourceNode || 'local');
            navigation?.goBack?.();
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [selectNode, navigation]);

  const onHeaderRefresh = useCallback(() => {
    if (segment === 'explore') {
      if (activePeerId) loadList(activePeerId, currentPath, { refresh: true });
    } else {
      refreshDirs();
    }
  }, [segment, activePeerId, currentPath, loadList, refreshDirs]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation?.goBack?.()} style={styles.headerBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={20} color={C.textMuted} />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Ionicons name="folder-open" size={14} color={C.gold} />
          <Text style={styles.headerTitleText}>FEDERATION FILES</Text>
        </View>
        <TouchableOpacity onPress={onHeaderRefresh} style={styles.headerBtn} hitSlop={8}>
          <Ionicons
            name="refresh"
            size={18}
            color={(segment === 'explore' ? listing : dirsLoading) ? C.textDim : C.gold}
          />
        </TouchableOpacity>
      </View>

      <SegmentToggle value={segment} onChange={setSegment} />

      {segment === 'explore' ? (
        <>
          <PeerChips peers={peers} activePeerId={activePeerId} onSelect={setActivePeerId} />
          <RootsBar roots={rootsByPeer[activePeerId]} currentPath={currentPath} onJump={jumpToRoot} />
          <Breadcrumb trail={trail} onCrumb={onCrumb} onUp={goUp} />

          {servingStale && (
            <View style={x.staleRow}>
              <Ionicons name="cloud-offline-outline" size={12} color={C.warning} />
              <Text style={x.staleText}>
                {activePeer?.name || activePeerId} unreachable — showing cached listing
              </Text>
            </View>
          )}
          {!servingStale && listError && (
            <View style={x.errorRow}>
              <Ionicons name="warning-outline" size={12} color={C.danger} />
              <Text style={x.errorText} numberOfLines={2}>{listError}</Text>
            </View>
          )}

          <FlatList
            data={entries}
            keyExtractor={(item) => `${activePeerId}:${item.path}`}
            renderItem={({ item }) => (
              <FileRow entry={item} onOpen={onOpenEntry} onLongPress={onLongPressFolder} />
            )}
            contentContainerStyle={x.fileListContent}
            refreshControl={
              <RefreshControl
                refreshing={expRefreshing}
                onRefresh={() => activePeerId && loadList(activePeerId, currentPath, { refresh: true })}
                tintColor={C.gold}
                colors={[C.gold]}
                progressBackgroundColor={C.bg1}
              />
            }
            ListEmptyComponent={
              listing ? (
                <View style={x.fileEmpty}>
                  <ActivityIndicator color={C.gold} />
                </View>
              ) : (
                <View style={x.fileEmpty}>
                  <Text style={styles.emptyPrompt}>{TERMINAL_PROMPTS.assistant}</Text>
                  <Text style={styles.emptyText}>EMPTY DIRECTORY</Text>
                  <Text style={styles.emptyHint}>
                    Long-press a folder to save it to InfiniBot.
                  </Text>
                </View>
              )
            }
          />
        </>
      ) : (
        <>
          {/* Search */}
          <View style={styles.searchRow}>
            <Ionicons name="search" size={14} color={C.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="search name / path / tag"
              placeholderTextColor={C.textDim}
              autoCorrect={false}
              autoCapitalize="none"
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                <Ionicons name="close-circle" size={14} color={C.textMuted} />
              </TouchableOpacity>
            )}
          </View>

          {/* Filter chips */}
          <NodeFilterChips
            nodeNames={nodeNames}
            value={filterNode}
            onChange={setFilterNode}
          />

          {/* Stats line */}
          <View style={styles.statsLine}>
            <Text style={styles.statsText}>
              {filtered.length} of {directories.length} entries
              {filterNode !== 'all' && ` · ${nodeNames.find((n) => n.id === filterNode)?.label || filterNode}`}
            </Text>
          </View>

          {/* List */}
          <FlatList
            data={filtered}
            keyExtractor={(d) => d.id || `${d.sourceNode}:${d.path}`}
            renderItem={({ item }) => <DirectoryRow entry={item} onAction={handleAction} />}
            contentContainerStyle={styles.listContent}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={C.gold}
                colors={[C.gold]}
                progressBackgroundColor={C.bg1}
              />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyPrompt}>{TERMINAL_PROMPTS.assistant}</Text>
                <Text style={styles.emptyText}>NO DIRECTORIES</Text>
                <Text style={styles.emptyHint}>
                  Register a directory on the desktop to see it here. The list syncs automatically across nodes.
                </Text>
              </View>
            }
          />
        </>
      )}

      <SaveSheet
        visible={!!saveFolder}
        folder={saveFolder}
        peerLabel={activePeer?.name || activePeer?.label || activePeerId}
        submitting={saving}
        onClose={() => { setSaving(false); setSaveFolder(null); }}
        onSubmit={handleSave}
      />

      {!!toast && (
        <View style={x.toast} pointerEvents="none">
          <Ionicons name="checkmark-circle" size={15} color={C.ok} />
          <Text style={x.toastText} numberOfLines={2}>{toast}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg0,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    borderBottomWidth: 1,
    borderBottomColor: C.goldBorder,
    backgroundColor: C.bg1,
    gap: S.sm,
  },
  headerBtn: {
    padding: S.xs,
  },
  headerTitle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.sm,
  },
  headerTitleText: {
    ...F.panelTitle,
    color: C.textMuted,
    letterSpacing: 1.5,
  },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    backgroundColor: C.bg1,
    borderBottomWidth: 1,
    borderBottomColor: C.goldBorder,
  },
  searchInput: {
    flex: 1,
    color: C.text,
    ...F.body,
    padding: 0,
  },

  chipBar: {
    maxHeight: 44,
    backgroundColor: C.bg1,
    borderBottomWidth: 1,
    borderBottomColor: C.goldBorder,
  },
  chipBarContent: {
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: C.goldBorder,
    marginRight: 4,
  },
  chipActive: {
    backgroundColor: COLORS.primaryLight,
    borderColor: C.gold,
  },
  chipText: {
    ...F.status,
    color: C.textMuted,
    maxWidth: 120,
  },
  chipTextActive: {
    color: C.gold,
  },
  chipCount: {
    ...F.status,
    color: C.textDim,
    backgroundColor: COLORS.primaryDim,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },

  statsLine: {
    paddingHorizontal: S.md,
    paddingVertical: 6,
    backgroundColor: C.bg1,
  },
  statsText: {
    ...F.small,
    color: C.textDim,
  },

  listContent: {
    padding: S.md,
    flexGrow: 1,
    gap: 8,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: C.bg1,
    borderWidth: 1,
    borderColor: C.goldBorder,
    borderRadius: 8,
    padding: S.md,
  },
  rowIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: COLORS.primaryDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowIconStale: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
  },
  rowIcon: {
    fontSize: 18,
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
    fontWeight: '600',
  },
  rowTag: {
    ...F.status,
    fontSize: 9,
    color: C.gold,
    backgroundColor: COLORS.cardBorder,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  rowPath: {
    ...F.code,
    fontSize: 11,
    color: C.textMuted,
    marginTop: 2,
  },
  rowMetaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
  },
  rowMeta: {
    ...F.small,
    color: C.textDim,
    fontSize: 11,
  },
  rowMetaSep: {
    color: C.textDim,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 6,
  },
  tagPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: COLORS.primaryDim,
    borderRadius: 3,
  },
  tagText: {
    ...F.small,
    fontSize: 10,
    color: C.textDim,
  },
  rowAction: {
    padding: 6,
  },

  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 60,
  },
  emptyPrompt: {
    ...F.heading,
    fontSize: 32,
    color: C.gold,
    textShadowColor: C.goldGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 20,
  },
  emptyText: {
    ...F.panelTitle,
    color: C.textMuted,
  },
  emptyHint: {
    ...F.small,
    color: C.textDim,
    textAlign: 'center',
    maxWidth: 280,
  },
});

// ── Explorer / sheet / toast styles ──────────────────────────

const x = StyleSheet.create({
  segmentRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    backgroundColor: C.bg1,
    borderBottomWidth: 1,
    borderBottomColor: C.goldBorder,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
  },
  segmentActive: {
    backgroundColor: C.goldSubtle,
    borderColor: C.gold,
  },
  segmentText: {
    ...F.status,
    color: C.textDim,
  },
  segmentTextActive: {
    color: C.gold,
  },

  chipOffline: {
    opacity: 0.5,
  },
  reachDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },

  rootsBar: {
    maxHeight: 38,
    backgroundColor: C.bg1,
  },
  rootsBarContent: {
    paddingHorizontal: S.md,
    paddingVertical: 5,
    gap: 6,
  },
  rootChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    marginRight: 4,
  },
  rootChipActive: {
    borderColor: C.gold,
    backgroundColor: C.goldSubtle,
  },
  rootChipText: {
    ...F.small,
    fontSize: 11,
    color: C.textMuted,
    maxWidth: 140,
  },

  crumbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: S.md,
    paddingVertical: 7,
    backgroundColor: C.bg1,
    borderBottomWidth: 1,
    borderBottomColor: C.goldBorder,
  },
  upBtn: {
    width: 26,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.goldSubtle,
    borderWidth: 1,
    borderColor: C.goldBorder,
  },
  crumbContent: {
    alignItems: 'center',
    gap: 4,
  },
  crumbItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  crumbText: {
    ...F.code,
    fontSize: 12,
    color: C.textMuted,
    maxWidth: 160,
  },
  crumbTextActive: {
    color: C.gold,
    fontWeight: '700',
  },

  staleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: S.md,
    marginTop: S.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(245,158,11,0.10)',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.30)',
  },
  staleText: {
    ...F.small,
    fontSize: 11,
    color: C.warning,
    flex: 1,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: S.md,
    marginTop: S.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.20)',
  },
  errorText: {
    ...F.small,
    fontSize: 11,
    color: C.danger,
    flex: 1,
  },

  fileListContent: {
    padding: S.md,
    flexGrow: 1,
    gap: 6,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: C.bg1,
    borderWidth: 1,
    borderColor: C.goldBorder,
    borderRadius: 8,
    paddingHorizontal: S.md,
    paddingVertical: 10,
  },
  fileIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 7,
    backgroundColor: C.bg2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileIconWrapDir: {
    backgroundColor: COLORS.primaryDim,
  },
  fileMain: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    ...F.body,
    fontSize: 13,
    color: C.text,
    fontWeight: '600',
  },
  fileSub: {
    ...F.small,
    fontSize: 11,
    color: C.textDim,
    marginTop: 2,
  },
  fileEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 60,
  },

  // ── Save sheet ──
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: C.bg1,
    borderTopWidth: 1,
    borderTopColor: C.gold,
    paddingHorizontal: S.lg,
    paddingTop: S.lg,
    paddingBottom: S.xl,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    ...TERMINAL_SHADOWS.panelActive,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: S.md,
  },
  sheetTitle: {
    ...F.panelTitle,
    color: C.gold,
    flex: 1,
    letterSpacing: 1.5,
  },
  sheetPathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: S.md,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: C.bg2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
  },
  sheetPath: {
    ...F.code,
    fontSize: 11,
    color: C.textMuted,
    flex: 1,
  },
  sheetPeerPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: C.goldSubtle,
    borderWidth: 1,
    borderColor: C.goldBorder,
    maxWidth: 120,
  },
  sheetPeerText: {
    ...F.status,
    fontSize: 9,
    color: C.gold,
  },
  label: {
    ...F.status,
    color: C.textDim,
    marginBottom: 6,
    marginTop: S.sm,
  },
  input: {
    ...F.code,
    color: C.text,
    backgroundColor: C.inputBg,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  twoCol: {
    flexDirection: 'row',
    gap: S.sm,
  },
  col: {
    flex: 1,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: S.sm,
    marginTop: S.lg,
    justifyContent: 'flex-end',
  },
  btnSecondary: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
  },
  btnSecondaryText: { ...F.status, color: C.textMuted },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: C.gold,
    borderRadius: 6,
    ...TERMINAL_SHADOWS.glow,
  },
  btnPrimaryText: { ...F.status, color: C.bg0, fontWeight: '800' },

  // ── Toast ──
  toast: {
    position: 'absolute',
    left: S.md,
    right: S.md,
    bottom: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: C.bg2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.goldBorder,
    ...TERMINAL_SHADOWS.panelActive,
  },
  toastText: {
    ...F.small,
    color: C.text,
    flex: 1,
  },
});

export default FederationDirectoryScreen;
