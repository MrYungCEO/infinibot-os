/**
 * DocumentsScreen — native Documents workspace (web /notes: Documents | Ideas).
 *
 * Documents section = the web <ib-documents-workspace>:
 *   Library  — every type (notes, ideas, meetings, research, reports…) with
 *              type chips + counts, categories, search, sort; custom types
 *              (create / edit / hide / archive / reorder).
 *   Folders  — the tree: breadcrumbs, favourites, recent, sort, list / grid /
 *              table views, workspace stats, row actions (rename, favourite,
 *              move, trash), trash with restore / purge.
 *   Search   — documents.search full-text hits (titles, text, PDFs) plus
 *              idea / report / research matches from the library.
 *   Open     — DocView (markdown render + edit with autosave, type chip,
 *              category, properties, history + restore, export, file preview).
 *   New / Upload (photos + videos via expo-image-picker) / Import sheet.
 * Ideas section = the native IdeasScreen board, embedded.
 *
 * Live: `notes:changed` (documents + types) and `documents.import.progress`.
 * Route params: { docId?, view?: 'documents' | 'ideas', type?, ideaId? }.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { AppHeader, Button, Chip, EmptyState, IconButton, ListRow, SegmentedControl, SkeletonRow, StatCard, SPACE, RADIUS, useUIKit } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import IdeasScreen from '../IdeasScreen';
import {
  BUILTIN_TYPES,
  LIBRARY_SORTS,
  TREE_SORTS,
  buildTreeIndex,
  categoryRows,
  childrenOf,
  clientLibrary,
  createTypedParams,
  crossTypeHits,
  errorText,
  favoritesOf,
  folderStats,
  folderTrail,
  folderViewMode,
  isJobActive,
  isUnknownMethod,
  jobStatusText,
  libraryAction,
  libraryHeading,
  libraryView,
  moveTargets,
  nextTableSort,
  nodeSubtitle,
  normalizeLibrary,
  pushRecent,
  readRouteParams,
  relTime,
  renameParams,
  sortRows,
  tableColumns,
  formatProp,
  typeById,
  typeChips,
  assetFileName,
} from './documents-model';
import {
  ConfirmModal,
  FilterSheet,
  MoveSheet,
  NewSheet,
  NodeActionsSheet,
  NodeGlyph,
  PromptModal,
  TrashSheet,
  TypeGlyph,
  TypesSheet,
  makeMarkdownStyles,
} from './DocumentsSheets';
import { ImportSheet } from './ImportSheet';
import { DocView } from './DocView';
import { uploadAsset } from './documents-http';

const LS_RECENT = '@infinibot/documents/recent';
const LS_PREFS = '@infinibot/documents/prefs';

export function DocumentsScreen({ navigation, route, gateway }) {
  const { colors, type } = useUIKit();
  const { width } = useWindowDimensions();
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';
  const params = readRouteParams(route?.params);
  const mdStyles = useMemo(() => makeMarkdownStyles(colors, type), [colors, type]);

  // ── State ──
  const [section, setSection] = useState(params.view);
  const [ideaFocus, setIdeaFocus] = useState(params.ideaId);
  const [mode, setMode] = useState('library'); // 'library' | 'folders'
  const [nodes, setNodes] = useState([]);
  const [types, setTypes] = useState(BUILTIN_TYPES);
  const [typesLive, setTypesLive] = useState(false);
  const [lib, setLib] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null); // { unavailable?, message }
  const [libType, setLibType] = useState(params.type);
  const [libCategory, setLibCategory] = useState(null);
  const [libSort, setLibSort] = useState('updated');
  const [treeSort, setTreeSort] = useState('manual');
  const [folderId, setFolderId] = useState(null);
  const [folderMode, setFolderMode] = useState(null);
  const [tableSort, setTableSort] = useState({ by: undefined, dir: 'asc' });
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(null);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState([]);
  const [openId, setOpenId] = useState(params.docId);
  const [openEditing, setOpenEditing] = useState(false);
  const [remote, setRemote] = useState(null);
  const [job, setJob] = useState(null);
  const [toast, setToast] = useState(null);
  // Overlays.
  const [newFor, setNewFor] = useState(undefined); // parentId (null = top) | undefined = closed
  const [actionsNode, setActionsNode] = useState(null);
  const [renameNode, setRenameNode] = useState(null);
  const [moveNode, setMoveNode] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [typesOpen, setTypesOpen] = useState(false);
  const [trash, setTrash] = useState(null); // null closed | { nodes, loading }
  const [importOpen, setImportOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [uploading, setUploading] = useState(null);

  const index = useMemo(() => buildTreeIndex(nodes, treeSort), [nodes, treeSort]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const toastTimer = useRef(null);
  const flash = useCallback((msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);
  useEffect(() => () => toastTimer.current && clearTimeout(toastTimer.current), []);

  // ── Persisted prefs (sort, recent) ──
  useEffect(() => {
    AsyncStorage.getItem(LS_RECENT).then((v) => v && setRecent(JSON.parse(v) || [])).catch(() => {});
    AsyncStorage.getItem(LS_PREFS)
      .then((v) => {
        const p = v ? JSON.parse(v) : null;
        if (p?.treeSort) setTreeSort(p.treeSort);
        if (p?.libSort) setLibSort(p.libSort);
        if (p?.mode && !params.type) setMode(p.mode);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const savePrefs = useCallback((patch) => {
    AsyncStorage.getItem(LS_PREFS)
      .then((v) => AsyncStorage.setItem(LS_PREFS, JSON.stringify({ ...(v ? JSON.parse(v) : {}), ...patch })))
      .catch(() => {});
  }, []);

  // ── Route params (deep links) ──
  useEffect(() => {
    const p = readRouteParams(route?.params);
    if (p.view) setSection(p.view);
    if (p.ideaId) setIdeaFocus(p.ideaId);
    if (p.docId) {
      setSection('documents');
      setOpenId(p.docId);
    }
    if (p.type) {
      setMode('library');
      setLibType(p.type);
      setLibCategory(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.params?.docId, route?.params?.view, route?.params?.type, route?.params?.ideaId]);

  // ── Data ──
  const loadTree = useCallback(async () => {
    const r = await sendReq('documents.tree', {});
    const list = Array.isArray(r?.nodes) ? r.nodes : [];
    setNodes(list);
    return list;
  }, [sendReq]);

  const loadTypes = useCallback(async () => {
    try {
      const r = await sendReq('documents.types.list', {});
      if (Array.isArray(r?.types) && r.types.length) setTypes(r.types);
      setTypesLive(true);
    } catch {
      setTypesLive(false);
    }
  }, [sendReq]);

  const loadLibrary = useCallback(
    async (treeNodes) => {
      try {
        const r = await sendReq('documents.library', { limit: 5000 });
        const norm = normalizeLibrary(r);
        if (norm) {
          setLib(norm);
          if (Array.isArray(r.types) && r.types.length) {
            setTypes(r.types);
            setTypesLive(true);
          }
          return;
        }
      } catch {
        /* older gateway — merge below */
      }
      let ideas = [];
      try {
        ideas = (await sendReq('ideas.list', { limit: 1000 }))?.ideas || [];
      } catch {
        ideas = [];
      }
      setLib(clientLibrary(treeNodes || nodesRef.current, ideas));
    },
    [sendReq],
  );
  const loadAll = useCallback(async () => {
    if (!connected || !sendReq) return;
    try {
      const list = await loadTree();
      setError(null);
      await Promise.all([loadTypes(), loadLibrary(list)]);
    } catch (e) {
      setError(isUnknownMethod(e) ? { unavailable: true, message: 'Documents are not available on this gateway.' } : { message: errorText(e) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [connected, sendReq, loadTree, loadTypes, loadLibrary]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Debounced reload after local writes / remote change events.
  const reloadTimer = useRef(null);
  const scheduleReload = useCallback(
    (withTypes = false) => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(async () => {
        try {
          const list = await loadTree();
          if (withTypes) await loadTypes();
          await loadLibrary(list);
        } catch {
          /* transient */
        }
      }, 350);
    },
    [loadTree, loadTypes, loadLibrary],
  );
  useEffect(() => () => reloadTimer.current && clearTimeout(reloadTimer.current), []);

  const remoteSeq = useRef(0);
  useEffect(() => {
    if (typeof gateway?.subscribeEvent !== 'function') return undefined;
    const a = gateway.subscribeEvent('notes:changed', (payload) => {
      const p = payload || {};
      scheduleReload(String(p.id || '').startsWith('type:'));
      remoteSeq.current += 1;
      setRemote({ seq: remoteSeq.current, id: p.id || null, op: p.op || null });
      setTrash((t) => (t ? { ...t, stale: true } : t));
    });
    const b = gateway.subscribeEvent('documents.import.progress', (payload) => {
      const j = payload?.job || payload;
      if (j && j.id) setJob((cur) => (!cur || cur.id === j.id || !isJobActive(cur) ? j : cur));
      if (j && (j.status === 'done' || j.status === 'failed')) scheduleReload(false);
    });
    const c = gateway.subscribeEvent('ideas.changed', () => scheduleReload(false));
    return () => {
      a?.();
      b?.();
      c?.();
    };
  }, [gateway, scheduleReload]);

  // Reattach to a running import + poll it while active.
  useEffect(() => {
    if (!connected || !sendReq) return;
    sendReq('documents.notion.jobs.list', { active: true, limit: 5 })
      .then((r) => {
        const active = (r?.jobs || []).find(isJobActive);
        if (active) setJob(active);
      })
      .catch(() => {});
  }, [connected, sendReq]);
  const jobId = job?.id;
  const jobActive = isJobActive(job);
  useEffect(() => {
    if (!jobActive || !jobId) return undefined;
    const t = setInterval(() => {
      sendReq('documents.notion.jobs.get', { jobId })
        .then((r) => {
          if (r?.job) {
            setJob(r.job);
            if (!isJobActive(r.job)) scheduleReload(false);
          }
        })
        .catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [jobActive, jobId, sendReq, scheduleReload]);

  // Trash reload when stale and open.
  const loadTrash = useCallback(async () => {
    setTrash((t) => ({ nodes: t?.nodes || null, loading: true }));
    try {
      const r = await sendReq('documents.trash', {});
      setTrash({ nodes: r?.nodes || [], loading: false });
    } catch (e) {
      setTrash({ nodes: [], loading: false });
      flash(errorText(e));
    }
  }, [sendReq, flash]);
  useEffect(() => {
    if (trash?.stale) void loadTrash();
  }, [trash?.stale, loadTrash]);

  // Full-text search (documents.search) — debounced.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return undefined;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await sendReq('documents.search', { query: q, limit: 60 });
        setHits(r?.hits || []);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [query, sendReq]);

  const onRefresh = () => {
    setRefreshing(true);
    void loadAll();
  };

  // ── Actions ──
  const run = async (fn, ok) => {
    try {
      const r = await fn();
      if (ok) flash(typeof ok === 'function' ? ok(r) : ok);
      return r;
    } catch (e) {
      flash(errorText(e));
      return null;
    }
  };

  const openDoc = useCallback(
    (id, opts = {}) => {
      const n = index.byId.get(id);
      if (n && n.kind === 'folder') {
        setMode('folders');
        setFolderId(id);
        setFolderMode(null);
        setOpenId(null);
        return;
      }
      setOpenEditing(!!opts.edit);
      setOpenId(id);
      setRecent((r) => {
        const next = pushRecent(r, id);
        AsyncStorage.setItem(LS_RECENT, JSON.stringify(next)).catch(() => {});
        return next;
      });
    },
    [index],
  );

  const openLibraryItem = (it) => {
    const a = libraryAction(it);
    if (!a) return;
    if (a.kind === 'doc') openDoc(a.id);
    else if (a.kind === 'idea') {
      setIdeaFocus(a.id);
      setSection('ideas');
    } else navigation?.navigate?.(a.route, a.params);
  };

  const currentParent = () => (openId ? index.byId.get(openId)?.parentId || null : mode === 'folders' ? folderId : null);

  const createTyped = async (t, parentId) => {
    setNewFor(undefined);
    if (t.backing === 'ideas') {
      const r = await run(() => sendReq('ideas.create', { title: 'New idea', source: 'mobile' }), 'Idea captured — opening it in Ideas');
      scheduleReload(false);
      if (r?.idea?.id) {
        setIdeaFocus(r.idea.id);
        setSection('ideas');
      }
      return;
    }
    if (!t.creatable) return;
    const r = await run(() => sendReq('documents.create', createTypedParams(t, parentId, { typesLive })));
    if (r?.node) {
      await loadTree().catch(() => {});
      scheduleReload(false);
      openDoc(r.node.id, { edit: true });
    }
  };

  const createFolder = async (parentId) => {
    setNewFor(undefined);
    const r = await run(() => sendReq('documents.create', { kind: 'folder', title: 'New folder', parentId: parentId || null }));
    if (r?.node) {
      await loadTree().catch(() => {});
      setRenameNode(r.node);
    }
  };

  const rename = async (node, title) => {
    setRenameNode(null);
    const p = renameParams(node, title);
    if (!p) return;
    await run(() => sendReq('documents.update', p));
    scheduleReload(false);
  };

  const toggleFavorite = async (node) => {
    setActionsNode(null);
    await run(() => sendReq('documents.update', { id: node.id, favorite: !node.favorite }), node.favorite ? 'Removed from favourites' : 'Added to favourites');
    scheduleReload(false);
  };

  const askTrash = (node) => {
    setActionsNode(null);
    const what = node.kind === 'folder' ? `folder "${node.title}" and everything in it` : `"${node.title}"`;
    setConfirm({
      title: 'Move to trash?',
      message: `Move ${what} to trash? You can restore it from Trash.`,
      confirmLabel: 'Move to trash',
      danger: true,
      onConfirm: async () => {
        const r = await run(() => sendReq('documents.delete', { id: node.id }), 'Moved to trash');
        if (r == null) return;
        if (openId && (openId === node.id || index.byId.get(openId)?.parentId === node.id)) setOpenId(null);
        if (folderId && (folderId === node.id || folderTrail(index, folderId).some((c) => c.id === node.id))) setFolderId(node.parentId || null);
        scheduleReload(false);
        if (trash) void loadTrash();
      },
    });
  };

  const doMove = async (parentId) => {
    const node = moveNode;
    setMoveNode(null);
    if (!node) return;
    await run(() => sendReq('documents.move', { id: node.id, parentId }), 'Moved');
    scheduleReload(false);
    if (openId === node.id) setRemote({ seq: ++remoteSeq.current, id: node.id, op: 'move' });
  };

  const restoreNode = async (n) => {
    await run(() => sendReq('documents.restore', { id: n.id }), `Restored "${n.title}"`);
    scheduleReload(false);
    void loadTrash();
  };
  const purgeNode = (n) =>
    setConfirm({
      title: 'Delete forever?',
      message: `Permanently delete "${n.title}"? This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        await run(() => sendReq('documents.purge', { id: n.id }), 'Deleted');
        void loadTrash();
      },
    });

  const typeAction = async (fn, ok) => {
    if (!typesLive) {
      flash('Custom types need the gateway restart that turns document types on.');
      return false;
    }
    const r = await run(fn, ok);
    if (r?.types) setTypes(r.types);
    scheduleReload(false);
    return !!r;
  };

  const upload = async (parentId) => {
    setNewFor(undefined);
    let ImagePicker;
    try {
      ImagePicker = require('expo-image-picker');
    } catch {
      flash('Uploads need the image picker, which this build does not include.');
      return;
    }
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm && perm.granted === false) {
        flash('Photo library access is off — enable it in Settings to upload.');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, quality: 1 });
      if (res.canceled || !res.assets?.length) return;
      let maxBytes = null;
      try {
        const st = await sendReq('documents.notion.status', {});
        maxBytes = typeof st?.limits?.maxUploadBytes === 'number' ? st.limits.maxUploadBytes : null;
      } catch {
        maxBytes = null;
      }
      let done = 0;
      let lastId = null;
      for (const asset of res.assets) {
        setUploading(`Uploading ${done + 1} of ${res.assets.length}…`);
        try {
          const r = await uploadAsset(sendReq, asset, { parentId, name: assetFileName(asset), maxBytes });
          done += 1;
          lastId = r?.node?.id || lastId;
        } catch (e) {
          flash(`Upload failed: ${errorText(e)}`);
        }
      }
      setUploading(null);
      if (done) {
        flash(`Uploaded ${done} file${done === 1 ? '' : 's'}`);
        scheduleReload(false);
        if (done === 1 && lastId) openDoc(lastId);
      }
    } catch (e) {
      setUploading(null);
      flash(errorText(e));
    }
  };

  // ── Derived ──
  const counts = lib?.counts?.byType || {};
  const chips = useMemo(() => typeChips(types, counts, lib?.counts?.all || 0), [types, counts, lib]);
  const cats = useMemo(() => categoryRows(lib?.counts?.byCategory), [lib]);
  const libItems = useMemo(() => libraryView(lib?.items, { type: libType, category: libCategory, sort: libSort }), [lib, libType, libCategory, libSort]);
  const heading = libraryHeading(types, libType, libCategory);
  const extraHits = useMemo(() => crossTypeHits(lib?.items, query), [lib, query]);
  const folderNode = folderId ? index.byId.get(folderId) : null;
  const kids = childrenOf(index, folderNode ? folderId : null);
  const viewMode = folderViewMode(folderNode, folderMode);
  const trail = folderTrail(index, folderNode ? folderId : null);
  const stats = useMemo(() => folderStats(nodes), [nodes]);
  const favs = useMemo(() => favoritesOf(nodes), [nodes]);
  const recentNodes = recent.map((id) => index.byId.get(id)).filter(Boolean).slice(0, 6);
  const parentLabel = (pid) => (pid ? index.byId.get(pid)?.title || 'this folder' : 'top level');
  const gridCols = width >= 700 ? 3 : 2;

  // ── Render: Ideas section ──
  const header = (
    <AppHeader
      title={section === 'ideas' ? 'Ideas' : 'Documents'}
      eyebrow="Knowledge"
      leftIcon="chevron-back"
      leftLabel="Back"
      onLeftPress={() => navigation?.goBack?.()}
      rightActions={
        section === 'documents'
          ? [
              { key: 'import', icon: 'download-outline', onPress: () => setImportOpen(true), label: 'Import', busy: isJobActive(job) },
              { key: 'trash', icon: 'trash-outline', onPress: () => { setTrash({ nodes: null, loading: true }); void loadTrash(); }, label: 'Trash' },
              { key: 'new', icon: 'add', onPress: () => setNewFor(currentParent()), label: 'New' },
            ]
          : []
      }
      testID="documents-header"
    >
      <SegmentedControl
        size="sm"
        options={[
          { key: 'documents', label: 'Documents', icon: 'document-text-outline' },
          { key: 'ideas', label: 'Ideas', icon: 'bulb-outline' },
        ]}
        value={section}
        onChange={(k) => {
          setSection(k);
          navigation?.setParams?.({ view: k });
        }}
        style={{ marginTop: SPACE.sm }}
        testID="documents-sections"
      />
    </AppHeader>
  );

  if (openId && section === 'documents') {
    return (
      <View style={s.flex} testID="documents-screen">
        <DocView
          key={openId}
          id={openId}
          sendReq={sendReq}
          types={types}
          typesLive={typesLive}
          index={index}
          nodes={nodes}
          remote={remote}
          mdStyles={mdStyles}
          startEditing={openEditing}
          flash={flash}
          onBack={() => {
            setOpenId(null);
            setOpenEditing(false);
            if (route?.params?.docId) navigation?.setParams?.({ docId: undefined });
          }}
          onOpen={(id) => openDoc(id)}
          onChanged={() => scheduleReload(false)}
          onMove={(n) => setMoveNode(n)}
          onTrash={askTrash}
          onNewType={() => setTypesOpen(true)}
        />
        {renderOverlays()}
      </View>
    );
  }

  function renderOverlays() {
    return (
      <>
        <NewSheet
          visible={newFor !== undefined}
          onClose={() => setNewFor(undefined)}
          types={types}
          target={newFor ? parentLabel(newFor) : null}
          onCreate={(t) => createTyped(t, newFor || null)}
          onFolder={() => createFolder(newFor || null)}
          onUpload={() => upload(newFor || null)}
          onImport={() => {
            setNewFor(undefined);
            setImportOpen(true);
          }}
          onNewType={() => {
            setNewFor(undefined);
            setTypesOpen(true);
          }}
        />
        <NodeActionsSheet
          node={actionsNode}
          types={types}
          onClose={() => setActionsNode(null)}
          onOpen={(n) => {
            setActionsNode(null);
            openDoc(n.id);
          }}
          onNewInside={(n) => {
            setActionsNode(null);
            setNewFor(n.id);
          }}
          onRename={(n) => {
            setActionsNode(null);
            setRenameNode(n);
          }}
          onFavorite={toggleFavorite}
          onMove={(n) => {
            setActionsNode(null);
            setMoveNode(n);
          }}
          onTrash={askTrash}
        />
        <PromptModal visible={!!renameNode} title="Rename" initial={renameNode?.title} onClose={() => setRenameNode(null)} onSubmit={(v) => rename(renameNode, v)} />
        <MoveSheet node={moveNode} targets={moveNode ? moveTargets(index, moveNode.id) : []} onClose={() => setMoveNode(null)} onMove={doMove} />
        <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
        <TypesSheet
          visible={typesOpen}
          onClose={() => setTypesOpen(false)}
          types={types}
          counts={counts}
          typesLive={typesLive}
          onReorder={(ids) => typeAction(() => sendReq('documents.types.reorder', { ids }))}
          onUpdate={(patch, ok) => typeAction(() => sendReq('documents.types.update', patch), ok)}
          onCreate={(p) => typeAction(() => sendReq('documents.types.create', p), `Type "${p.label}" created`)}
        />
        <TrashSheet visible={!!trash} onClose={() => setTrash(null)} nodes={trash?.nodes} loading={!!trash?.loading} types={types} onRestore={restoreNode} onPurge={purgeNode} />
        <ImportSheet
          visible={importOpen}
          onClose={() => setImportOpen(false)}
          sendReq={sendReq}
          nodes={nodes}
          parentId={currentParent()}
          targetLabel={parentLabel(currentParent())}
          job={job}
          onJob={setJob}
          flash={flash}
          onImported={() => scheduleReload(false)}
          onOpenDoc={(id) => {
            setImportOpen(false);
            openDoc(id);
          }}
        />
        <FilterSheet
          visible={filterOpen}
          onClose={() => setFilterOpen(false)}
          title={mode === 'library' ? 'Sort & filter' : 'Sort folders'}
          sorts={mode === 'library' ? LIBRARY_SORTS : TREE_SORTS}
          sort={mode === 'library' ? libSort : treeSort}
          onSort={(k) => {
            if (mode === 'library') {
              setLibSort(k);
              savePrefs({ libSort: k });
            } else {
              setTreeSort(k);
              savePrefs({ treeSort: k });
            }
          }}
          categories={mode === 'library' ? cats : null}
          category={libCategory}
          onCategory={(c) => {
            setLibCategory(c);
            setFilterOpen(false);
          }}
        />
        {toast ? (
          <View pointerEvents="none" style={[s.toast, { backgroundColor: colors.surfaceDeep || colors.surface, borderColor: withAlpha(colors.primary, 0.4) }]}>
            <Text style={[type.small, { color: colors.text }]}>{toast}</Text>
          </View>
        ) : null}
      </>
    );
  }

  if (section === 'ideas') {
    return (
      <View style={s.flex} testID="documents-screen">
        {header}
        <IdeasScreen gateway={gateway} navigation={navigation} route={{ params: { ideaId: ideaFocus || undefined } }} />
      </View>
    );
  }

  // ── Render: Documents section ──
  const searchBar = (
    <View style={[s.search, { borderColor: withAlpha(colors.primary, 0.25), backgroundColor: withAlpha(colors.text, 0.04) }]}>
      <Ionicons name="search-outline" size={16} color={colors.textMuted} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search titles, text, PDFs…"
        placeholderTextColor={colors.textMuted}
        style={[type.body, s.searchInput, { color: colors.text }]}
        returnKeyType="search"
        accessibilityLabel="Search documents"
        testID="documents-search"
      />
      {searching ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      {query ? <IconButton icon="close-circle" size="sm" onPress={() => setQuery('')} accessibilityLabel="Clear search" /> : null}
    </View>
  );

  const modeBar = (
    <View style={s.modeRow}>
      <SegmentedControl
        size="sm"
        style={{ flex: 1 }}
        options={[
          { key: 'library', label: 'Library', icon: 'list-outline' },
          { key: 'folders', label: 'Folders', icon: 'folder-outline' },
        ]}
        value={mode}
        onChange={(k) => {
          setMode(k);
          savePrefs({ mode: k });
        }}
        testID="documents-mode"
      />
      <IconButton icon="options-outline" onPress={() => setFilterOpen(true)} accessibilityLabel="Sort and filter" badge={mode === 'library' && libCategory ? 1 : undefined} />
      {mode === 'library' ? <IconButton icon="color-palette-outline" onPress={() => setTypesOpen(true)} accessibilityLabel="Manage types" testID="documents-manage-types" /> : null}
    </View>
  );

  const jobChip =
    job && isJobActive(job) ? (
      <Chip icon="sync-outline" label={`Import · ${jobStatusText(job)} · ${job.progress?.done || 0}/${job.progress?.total || '…'}`} onPress={() => setImportOpen(true)} style={{ alignSelf: 'flex-start', marginTop: SPACE.sm }} accessibilityLabel="Show import progress" />
    ) : null;

  const row = (n, extra = {}) => (
    <ListRow
      key={extra.key || n.id}
      leading={<NodeGlyph node={n} types={types} />}
      title={n.title}
      subtitle={extra.subtitle != null ? extra.subtitle : nodeSubtitle(n, index)}
      value={extra.value != null ? extra.value : relTime(n.updatedAt)}
      onPress={() => openDoc(n.id)}
      onLongPress={() => setActionsNode(n)}
      chevron={n.kind === 'folder'}
      accessibilityLabel={n.title}
      accessibilityHint="Long-press for actions"
    />
  );

  let body;
  if (loading && !nodes.length) {
    body = (
      <View style={s.pad}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <SkeletonRow key={i} />
        ))}
      </View>
    );
  } else if (error) {
    body = error.unavailable ? (
      <EmptyState icon="cloud-offline-outline" title="Not available on this gateway" message={error.message} actionLabel="Retry" onAction={loadAll} />
    ) : (
      <EmptyState icon="alert-circle-outline" tone="danger" title="Couldn't load documents" message={error.message} actionLabel="Retry" onAction={loadAll} />
    );
  } else if (query.trim()) {
    const docHits = hits || [];
    body = (
      <FlatList
        data={docHits}
        keyExtractor={(h) => h.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={s.listPad}
        ListHeaderComponent={
          <View>
            {extraHits.length ? (
              <View>
                <Text style={[type.label, s.sectionLabel, { color: colors.textMuted }]}>
                  {extraHits.length} idea / report / research match{extraHits.length === 1 ? '' : 'es'}
                </Text>
                {extraHits.map((it) => {
                  const t = typeById(types, it.type);
                  return (
                    <ListRow key={`x-${it.source}-${it.id}`} leading={<TypeGlyph type={t} />} title={it.title} subtitle={`${t.label}${it.status ? ` · ${it.status}` : ''}`} onPress={() => openLibraryItem(it)} accessibilityLabel={it.title} />
                  );
                })}
              </View>
            ) : null}
            <Text style={[type.label, s.sectionLabel, { color: colors.textMuted }]}>
              {hits ? `${docHits.length} document result${docHits.length === 1 ? '' : 's'}` : 'Searching…'}
            </Text>
          </View>
        }
        renderItem={({ item: h }) => {
          const n = index.byId.get(h.id) || { id: h.id, kind: h.kind, title: h.title };
          return row(n, { subtitle: h.snippet || h.path, value: '' });
        }}
        ListEmptyComponent={hits && !extraHits.length ? <EmptyState compact icon="search-outline" title="No matches" message="Try other words — search covers titles, text and extracted PDF text." /> : null}
      />
    );
  } else if (mode === 'library') {
    const canCreate = !heading.type || heading.type.creatable;
    body = (
      <FlatList
        data={libItems.slice(0, 600)}
        keyExtractor={(it) => `${it.source}-${it.id}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        contentContainerStyle={s.listPad}
        ListHeaderComponent={
          <View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips} testID="documents-type-chips">
              {chips.map((c) => (
                <Chip
                  key={c.id || 'all'}
                  icon={c.icon}
                  label={c.label}
                  count={c.count}
                  color={c.color || undefined}
                  selected={(libType || null) === c.id && !libCategory}
                  onPress={() => {
                    setLibType(c.id);
                    setLibCategory(null);
                  }}
                  accessibilityLabel={`${c.label}, ${c.count}`}
                  testID={`documents-type-${c.id || 'all'}`}
                />
              ))}
            </ScrollView>
            {cats.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
                {cats.map((c) => (
                  <Chip
                    key={c.category}
                    icon="pricetag-outline"
                    size="sm"
                    label={c.category}
                    count={c.count}
                    selected={libCategory === c.category}
                    onPress={() => {
                      setLibCategory(libCategory === c.category ? null : c.category);
                      setLibType(null);
                    }}
                    accessibilityLabel={`Category ${c.category}`}
                  />
                ))}
              </ScrollView>
            ) : null}
            <View style={s.libHead}>
              {heading.type ? <TypeGlyph type={heading.type} size={20} /> : null}
              <View style={{ flex: 1 }}>
                <Text style={[type.label, { color: colors.primary }]}>{heading.eyebrow}</Text>
                <Text style={[type.h2, { color: colors.text }]}>{heading.title}</Text>
              </View>
              {heading.type?.id === 'idea' ? (
                <Button title="Ideas board" size="sm" variant="ghost" icon="bulb-outline" onPress={() => setSection('ideas')} />
              ) : canCreate ? (
                <Button
                  title={heading.type ? `New ${heading.type.label.split(' /')[0]}` : 'New…'}
                  size="sm"
                  variant="primary"
                  icon="add"
                  onPress={() => (heading.type ? createTyped(heading.type, null) : setNewFor(null))}
                  testID="documents-new-lib"
                />
              ) : (
                <Text style={[type.caption, { color: colors.textMuted }]}>Read-only — in Reports</Text>
              )}
            </View>
            {heading.sub ? <Text style={[type.small, { color: colors.textSecondary }]}>{heading.sub}</Text> : null}
            {!typesLive ? (
              <Text style={[type.caption, s.banner, { color: colors.warning, borderColor: withAlpha(colors.warning, 0.4) }]}>
                Showing built-in types with inferred categories. Saving types and custom types turn on after the gateway restart.
              </Text>
            ) : null}
            {jobChip}
            <Text style={[type.caption, s.sectionLabel, { color: colors.textMuted }]}>
              {libItems.length} item{libItems.length === 1 ? '' : 's'}
              {libCategory ? ` · ${libCategory}` : ''} · {LIBRARY_SORTS.find((x) => x.key === libSort)?.label}
            </Text>
          </View>
        }
        renderItem={({ item: it }) => {
          const t = typeById(types, it.type);
          return (
            <ListRow
              leading={<TypeGlyph type={t} />}
              title={it.title}
              subtitle={it.preview || it.path || undefined}
              value={relTime(it.updatedAt)}
              meta={
                <View style={s.metaRow}>
                  {!libType ? <Chip size="sm" label={t.label} color={t.color} /> : null}
                  {it.category ? <Chip size="sm" icon="pricetag-outline" label={it.category} /> : null}
                  {it.source === 'idea' && it.status ? <Chip size="sm" label={it.status} tone="info" /> : null}
                  {it.readOnly ? <Chip size="sm" label="Read-only" /> : null}
                </View>
              }
              onPress={() => openLibraryItem(it)}
              onLongPress={it.source === 'doc' && index.byId.get(it.id) ? () => setActionsNode(index.byId.get(it.id)) : undefined}
              accessibilityLabel={`${it.title}, ${t.label}`}
              testID={`documents-lib-row-${it.id}`}
            />
          );
        }}
        ListEmptyComponent={
          !lib ? (
            <ActivityIndicator color={colors.primary} style={{ margin: SPACE.xl }} />
          ) : (
            <EmptyState
              icon={heading.type ? undefined : 'documents-outline'}
              title={`No ${heading.type ? heading.type.label.toLowerCase() : libCategory ? 'items in this category' : 'documents'} yet`}
              message={
                heading.type?.id === 'idea'
                  ? 'Capture one here, by voice, or ask an agent — ideas show up in this list and in Ideas.'
                  : heading.type && !heading.type.creatable
                    ? 'Rendered reports appear here automatically.'
                    : "Create one, or change an existing document's type from its type chip."
              }
              actionLabel={heading.type && heading.type.creatable ? `New ${heading.type.label.split(' /')[0]}` : !heading.type ? 'New document' : undefined}
              onAction={heading.type && heading.type.creatable ? () => createTyped(heading.type, null) : !heading.type ? () => setNewFor(null) : undefined}
            />
          )
        }
      />
    );
  } else {
    // Folders
    const cols = tableColumns(folderNode, kids);
    const rows = sortRows(kids, tableSort.by, tableSort.dir);
    const folderHeader = (
      <View>
        {trail.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.crumbs}>
            <Pressable onPress={() => setFolderId(null)} style={s.crumbHit} accessibilityRole="button" accessibilityLabel="All folders">
              <Text style={[type.small, { color: colors.primary }]}>All folders</Text>
            </Pressable>
            {trail.map((c, i) => (
              <View key={c.id} style={s.crumbItem}>
                <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
                <Pressable onPress={() => setFolderId(c.id)} style={s.crumbHit} accessibilityRole="button" accessibilityLabel={c.title}>
                  <Text style={[type.small, { color: i === trail.length - 1 ? colors.text : colors.primary }]} numberOfLines={1}>
                    {c.title}
                  </Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        {!folderNode ? (
          <View>
            <View style={s.stats}>
              <StatCard compact label="Docs" value={stats.docs} style={s.stat} />
              <StatCard compact label="Folders" value={stats.folders} style={s.stat} />
              <StatCard compact label="Files" value={stats.files} style={s.stat} />
              <StatCard compact label="Favs" value={stats.favorites} style={s.stat} />
            </View>
            {favs.length ? (
              <View>
                <Text style={[type.label, s.sectionLabel, { color: colors.textMuted }]}>Favourites</Text>
                {favs.slice(0, 8).map((n) => row(n, { key: `fav-${n.id}` }))}
              </View>
            ) : null}
            {recentNodes.length ? (
              <View>
                <Text style={[type.label, s.sectionLabel, { color: colors.textMuted }]}>Recent</Text>
                {recentNodes.map((n) => row(n, { key: `rec-${n.id}` }))}
              </View>
            ) : null}
          </View>
        ) : (
          <View style={s.libHead}>
            <NodeGlyph node={folderNode} types={types} size={20} />
            <View style={{ flex: 1 }}>
              <Text style={[type.label, { color: colors.primary }]}>{folderNode.schema?.length ? 'Database' : 'Folder'}</Text>
              <Pressable onPress={() => setRenameNode(folderNode)} accessibilityRole="button" accessibilityLabel="Rename folder">
                <Text style={[type.h2, { color: colors.text }]}>{folderNode.title}</Text>
              </Pressable>
            </View>
            <IconButton icon="ellipsis-horizontal" onPress={() => setActionsNode(folderNode)} accessibilityLabel="Folder actions" />
          </View>
        )}
        {jobChip}
        <View style={s.folderBar}>
          <Text style={[type.caption, { color: colors.textMuted, flex: 1 }]}>
            {folderNode ? `${kids.length} item${kids.length === 1 ? '' : 's'}${folderNode.schema?.length ? ' · Notion database' : ''}` : 'Folders'} · {TREE_SORTS.find((x) => x.key === treeSort)?.label}
          </Text>
          <SegmentedControl
            size="sm"
            style={{ width: 168 }}
            options={[
              { key: 'list', label: 'List' },
              { key: 'grid', label: 'Grid' },
              { key: 'table', label: 'Table' },
            ]}
            value={viewMode}
            onChange={(m) => {
              setFolderMode(m);
              if (folderNode) void sendReq('documents.update', { id: folderNode.id, view: { ...(folderNode.view || {}), mode: m } }).catch(() => {});
            }}
            testID="documents-view-modes"
          />
        </View>
        <View style={s.folderActions}>
          <Button title="New…" icon="add" size="sm" variant="secondary" onPress={() => setNewFor(folderNode ? folderNode.id : null)} />
          <Button title="Folder" icon="folder-outline" size="sm" variant="ghost" onPress={() => createFolder(folderNode ? folderNode.id : null)} />
          <Button title={uploading || 'Upload'} icon="cloud-upload-outline" size="sm" variant="ghost" loading={!!uploading} onPress={() => upload(folderNode ? folderNode.id : null)} />
        </View>
      </View>
    );
    const empty = (
      <EmptyState
        icon="document-text-outline"
        title={folderNode ? 'This folder is empty' : 'Start your knowledge base'}
        message="Create a doc, upload photos or videos, or import from Notion."
        actionLabel="New document"
        onAction={() => setNewFor(folderNode ? folderNode.id : null)}
        secondaryLabel="Import"
        onSecondary={() => setImportOpen(true)}
      />
    );
    const refresh = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />;
    if (viewMode === 'table' && rows.length) {
      const colW = 140;
      const head = (key, label, w = colW) => (
        <Pressable key={key} onPress={() => setTableSort(nextTableSort(tableSort, key))} style={[s.th, { width: w, borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel={`Sort by ${label}`}>
          <Text style={[type.label, { color: tableSort.by === key ? colors.primary : colors.textMuted }]} numberOfLines={1}>
            {label}
            {tableSort.by === key ? (tableSort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
          </Text>
        </Pressable>
      );
      body = (
        <ScrollView refreshControl={refresh} contentContainerStyle={s.listPad}>
          {folderHeader}
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View>
              <View style={s.tr}>
                {head('__title', 'Name', 200)}
                {cols.map((c) => head(c.key, c.name))}
                {head('__updated', 'Updated', 110)}
              </View>
              {rows.map((r) => (
                <Pressable key={r.id} onPress={() => openDoc(r.id)} onLongPress={() => setActionsNode(r)} style={[s.tr, { borderColor: colors.borderSubtle || colors.border }]} accessibilityRole="button" accessibilityLabel={r.title}>
                  <View style={[s.td, { width: 200, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs }]}>
                    <NodeGlyph node={r} types={types} size={14} />
                    <Text style={[type.small, { color: colors.text, flex: 1 }]} numberOfLines={2}>
                      {r.title}
                    </Text>
                  </View>
                  {cols.map((c) => (
                    <View key={c.key} style={[s.td, { width: colW }]}>
                      <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={2}>
                        {formatProp(r.properties?.[c.key], (id) => index.byId.get(id)?.title)}
                      </Text>
                    </View>
                  ))}
                  <View style={[s.td, { width: 110 }]}>
                    <Text style={[type.caption, { color: colors.textMuted }]}>{relTime(r.updatedAt)}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </ScrollView>
      );
    } else if (viewMode === 'grid' && rows.length) {
      body = (
        <FlatList
          key={`grid-${gridCols}`}
          data={rows}
          numColumns={gridCols}
          keyExtractor={(n) => n.id}
          refreshControl={refresh}
          contentContainerStyle={s.listPad}
          columnWrapperStyle={{ gap: SPACE.sm }}
          ListHeaderComponent={folderHeader}
          renderItem={({ item: n }) => (
            <Pressable
              onPress={() => openDoc(n.id)}
              onLongPress={() => setActionsNode(n)}
              style={[s.card, { borderColor: withAlpha(colors.primary, 0.22), backgroundColor: withAlpha(colors.text, 0.03) }]}
              accessibilityRole="button"
              accessibilityLabel={n.title}
            >
              <NodeGlyph node={n} types={types} />
              <Text style={[type.bodyStrong, { color: colors.text, marginTop: SPACE.sm }]} numberOfLines={2}>
                {n.title}
              </Text>
              <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={3}>
                {nodeSubtitle(n, index)}
              </Text>
            </Pressable>
          )}
        />
      );
    } else {
      body = (
        <FlatList
          key="list"
          data={rows}
          keyExtractor={(n) => n.id}
          refreshControl={refresh}
          contentContainerStyle={s.listPad}
          ListHeaderComponent={folderHeader}
          renderItem={({ item: n }) => row(n)}
          ListEmptyComponent={empty}
        />
      );
    }
  }

  return (
    <View style={s.flex} testID="documents-screen">
      {header}
      <View style={s.top}>
        {searchBar}
        {!query.trim() && !error ? modeBar : null}
      </View>
      <View style={s.flex}>{body}</View>
      {renderOverlays()}
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  pad: { padding: SPACE.lg },
  top: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, gap: SPACE.sm },
  search: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingLeft: SPACE.md, minHeight: 44 },
  searchInput: { flex: 1, minHeight: 44, paddingVertical: 0 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  listPad: { paddingHorizontal: SPACE.lg, paddingBottom: 120 },
  chips: { gap: SPACE.sm, paddingVertical: SPACE.sm },
  libHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, marginTop: SPACE.sm },
  banner: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.sm },
  sectionLabel: { marginTop: SPACE.lg, marginBottom: SPACE.xs },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, marginTop: SPACE.xs },
  crumbs: { alignItems: 'center', paddingVertical: SPACE.xs },
  crumbItem: { flexDirection: 'row', alignItems: 'center' },
  crumbHit: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.xs, maxWidth: 180 },
  stats: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.sm },
  stat: { flex: 1 },
  folderBar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.md },
  folderActions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.sm, marginBottom: SPACE.sm },
  card: { flex: 1, borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.sm, minHeight: 120 },
  tr: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 44 },
  th: { paddingHorizontal: SPACE.sm, justifyContent: 'center', minHeight: 44 },
  td: { paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, justifyContent: 'center' },
  toast: { position: 'absolute', left: SPACE.lg, right: SPACE.lg, bottom: 32, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md },
});

export default DocumentsScreen;
