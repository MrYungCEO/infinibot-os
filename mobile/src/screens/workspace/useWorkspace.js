/**
 * useWorkspace — state + gateway actions for the native Workspace page.
 *
 * A port of the web controller (ui/src/ui/controllers/workspace.ts): same
 * RPCs, same order, same persistence semantics (AsyncStorage instead of
 * localStorage, same key names). Pure mapping lives in workspace-model.js.
 *
 * RPCs: directories.list/create, files.roots.list/add, files.tree/read/write,
 * workspace.dev.detect/status/logs/start/stop/restart,
 * workspace.version.create/list/diff/revert, workspace.templates.scaffold,
 * git.status/diff, db.system.defaults, db.rows.list, db.list,
 * db.system.resolve, db.create, forms.bindings.create, workflows.list,
 * workflows.run.start, models.list, sessions.list, sessions.patch,
 * terminal.create, terminal.agent.invoke, verification.visual.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  addTab,
  agentSessionKeyFor,
  appendSnippet,
  bindingFieldMap,
  checkpointDescription,
  closeTab as closeTabModel,
  defaultModelLabel,
  detectProjectMode,
  normalizeVersions,
  normalizeWorkflows,
  normalizeWorkspaces,
  matchLinkedRows,
  parseUnifiedDiff,
  patchTab,
  pickableModels,
  pickInitialWorkspace,
  pushRecent,
  repairGitStatusFiles,
  samePath,
  shouldAutoStartRuntime,
  statPaths,
  templateEntryFile,
  templateWrites,
  terminalId,
  joinPath,
} from './workspace-model';

const KEY = '@infinibot/workspace.';
const RPC_TIMEOUT_MS = 20000;

function withTimeout(promise, ms = RPC_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The gateway took too long to answer.')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readJson(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {});
}

function errMsg(err) {
  return String(err?.message || err || 'Something went wrong');
}

export function useWorkspace(gateway) {
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';
  const call = useCallback(
    (method, params = {}, ms) => {
      if (typeof sendReq !== 'function') return Promise.reject(new Error('Not connected to a gateway'));
      return withTimeout(sendReq(method, params), ms);
    },
    [sendReq],
  );

  // ── registry ──
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [recentIds, setRecentIds] = useState([]);
  const [recentFolders, setRecentFolders] = useState([]);
  const [notice, setNotice] = useState(null); // { tone, text }

  // ── per-workspace ──
  const [tree, setTree] = useState(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [tabs, setTabs] = useState([]);
  const [activePath, setActivePath] = useState(null);
  const [projectMode, setProjectModeState] = useState('web');
  const [devUrl, setDevUrlState] = useState('');
  const [previewRoute, setPreviewRouteState] = useState('/');
  const [previewNonce, setPreviewNonce] = useState(0);
  const [previewDevice, setPreviewDevice] = useState('mobile');
  const [selectedElement, setSelectedElement] = useState(null);
  const [slideIndex, setSlideIndex] = useState(0);

  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [detection, setDetection] = useState(null);
  const [server, setServer] = useState(null);
  const [runtimeLogs, setRuntimeLogs] = useState('');
  const [autoStart, setAutoStartState] = useState(true);
  const explicitIdsRef = useRef([]);
  const pollTokenRef = useRef(0);
  const logCursorRef = useRef(0);

  const [versions, setVersions] = useState([]);
  const [versionDiff, setVersionDiff] = useState(null); // { versionId, text }

  const [git, setGit] = useState({ loading: false, status: null, stat: '', patch: '', error: null, staged: false });
  const [fileDiff, setFileDiff] = useState(null); // { path, loading, patch, error }

  const [linked, setLinked] = useState([]);
  const [linkedLoading, setLinkedLoading] = useState(false);

  const [models, setModels] = useState([]);
  const [agentDefaultModel, setAgentDefaultModel] = useState(null);
  const [agentModel, setAgentModel] = useState(null);
  const [thinkingLevel, setThinkingLevel] = useState(null);

  const [workflows, setWorkflows] = useState({ loading: false, list: [], error: null });
  const [activity, setActivity] = useState([]); // workflow/system notices (web coderMessages)
  const [visualVerify, setVisualVerify] = useState({ running: false, screenshots: [], error: null });

  const selected = useMemo(() => workspaces.find((w) => w.id === selectedId) || null, [workspaces, selectedId]);
  const activeTab = useMemo(() => tabs.find((t) => t.path === activePath) || null, [tabs, activePath]);
  const sessionKey = agentSessionKeyFor(selectedId);

  const selectedRef = useRef(null);
  selectedRef.current = selected;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; pollTokenRef.current += 1; }, []);

  const flash = useCallback((text, tone = 'info') => {
    setNotice({ text, tone, at: Date.now() });
  }, []);

  // ── prefs ──
  useEffect(() => {
    (async () => {
      const [r, f, a] = await Promise.all([
        readJson(`${KEY}recents`, []),
        readJson(`${KEY}recentFolders`, []),
        readJson(`${KEY}autoStart`, true),
      ]);
      setRecentIds(Array.isArray(r) ? r : []);
      setRecentFolders(Array.isArray(f) ? f : []);
      setAutoStartState(a !== false);
    })();
  }, []);

  const savePrefs = useCallback(async (id, patch) => {
    if (!id) return;
    const cur = await readJson(`${KEY}${id}`, {});
    writeJson(`${KEY}${id}`, { ...cur, ...patch });
  }, []);

  // ── tree ──
  const loadTree = useCallback(async (entry = selectedRef.current, { quiet = false } = {}) => {
    if (!entry) return;
    if (!quiet) setTreeLoading(true);
    try {
      const res = await call('files.tree', { path: entry.path, depth: 6 }, 30000);
      if (selectedRef.current?.id !== entry.id) return;
      setTree(res || null);
      setTreeError(null);
    } catch (err) {
      if (selectedRef.current?.id === entry.id) setTreeError(errMsg(err));
    } finally {
      if (mountedRef.current && !quiet) setTreeLoading(false);
    }
  }, [call]);

  const toggleExpand = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  // ── tabs ──
  const persistTabs = useCallback((nextTabs, nextActive) => {
    const id = selectedRef.current?.id;
    if (!id) return;
    savePrefs(id, { openTabs: nextTabs.map((t) => t.path), activeTabPath: nextActive });
  }, [savePrefs]);

  const openFile = useCallback(async (path, { activate = true } = {}) => {
    const existing = tabsRef.current.find((t) => t.path === path);
    if (existing) {
      if (activate) {
        setActivePath(path);
        persistTabs(tabsRef.current, path);
      }
      return;
    }
    const next = addTab(tabsRef.current, path);
    tabsRef.current = next;
    setTabs(next);
    if (activate) setActivePath(path);
    try {
      const res = await call('files.read', { path });
      const content = typeof res?.content === 'string' ? res.content : '';
      setTabs((prev) => patchTab(prev, path, { content, original: content, loading: false, error: null }));
    } catch (err) {
      setTabs((prev) => patchTab(prev, path, { loading: false, error: errMsg(err) }));
    }
    persistTabs(tabsRef.current, activate ? path : activePath);
  }, [call, persistTabs, activePath]);

  const updateTabContent = useCallback((path, content) => {
    setTabs((prev) => patchTab(prev, path, { content }));
  }, []);

  const reloadTab = useCallback(async (path) => {
    setTabs((prev) => patchTab(prev, path, { loading: true }));
    try {
      const res = await call('files.read', { path });
      const content = typeof res?.content === 'string' ? res.content : '';
      setTabs((prev) => patchTab(prev, path, { content, original: content, loading: false, error: null }));
    } catch (err) {
      setTabs((prev) => patchTab(prev, path, { loading: false, error: errMsg(err) }));
    }
  }, [call]);

  const saveTab = useCallback(async (path) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || !tab.dirty) return true;
    try {
      await call('files.write', { path, content: tab.content });
      setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, original: tab.content, dirty: t.content !== tab.content, error: null } : t)));
      setPreviewNonce(Date.now());
      return true;
    } catch (err) {
      setTabs((prev) => patchTab(prev, path, { error: errMsg(err) }));
      return false;
    }
  }, [call]);

  const saveAll = useCallback(async () => {
    const dirty = tabsRef.current.filter((t) => t.dirty);
    const results = await Promise.all(dirty.map((t) => saveTab(t.path)));
    const failed = results.filter((ok) => !ok).length;
    if (dirty.length) flash(failed ? `${failed} file(s) failed to save` : `Saved ${dirty.length} file${dirty.length === 1 ? '' : 's'}`, failed ? 'danger' : 'success');
  }, [saveTab, flash]);

  const closeTab = useCallback((path) => {
    const { tabs: next, active } = closeTabModel(tabsRef.current, activePath, path);
    tabsRef.current = next;
    setTabs(next);
    setActivePath(active);
    persistTabs(next, active);
  }, [activePath, persistTabs]);

  const activateTab = useCallback((path) => {
    setActivePath(path);
    persistTabs(tabsRef.current, path);
  }, [persistTabs]);

  // ── versions ──
  const loadVersions = useCallback(async (id = selectedRef.current?.id) => {
    if (!id) return;
    try {
      const res = await call('workspace.version.list', { directoryId: id });
      if (selectedRef.current?.id === id) setVersions(normalizeVersions(res));
    } catch {
      if (selectedRef.current?.id === id) setVersions([]);
    }
  }, [call]);

  const showVersionDiff = useCallback(async (versionId) => {
    const id = selectedRef.current?.id;
    if (!id) return;
    setVersionDiff({ versionId, text: null, loading: true });
    try {
      const res = await call('workspace.version.diff', { directoryId: id, versionId });
      setVersionDiff({ versionId, text: res?.diff || 'No changes in this checkpoint.', loading: false });
    } catch (err) {
      setVersionDiff({ versionId, text: errMsg(err), loading: false, error: true });
    }
  }, [call]);

  const revertVersion = useCallback(async (versionId) => {
    const id = selectedRef.current?.id;
    if (!id) return;
    try {
      await call('workspace.version.revert', { directoryId: id, versionId }, 60000);
      await Promise.all([loadTree(undefined, { quiet: true }), ...tabsRef.current.map((t) => reloadTab(t.path))]);
      setPreviewNonce(Date.now());
      flash('Reverted to the checkpoint', 'success');
    } catch (err) {
      flash(errMsg(err), 'danger');
    }
  }, [call, loadTree, reloadTab, flash]);

  const createCheckpoint = useCallback(async (text) => {
    const id = selectedRef.current?.id;
    if (!id) return;
    try {
      await call('workspace.version.create', { directoryId: id, description: checkpointDescription(text) }, 30000);
      await loadVersions(id);
    } catch {
      /* non-git directories still get the agent turn */
    }
  }, [call, loadVersions]);

  // ── runtime ──
  const pollRuntime = useCallback(async (id, token) => {
    if (!mountedRef.current || pollTokenRef.current !== token || selectedRef.current?.id !== id) return;
    let status = null;
    try {
      const s = await call('workspace.dev.status', { directoryId: id });
      const logs = await call('workspace.dev.logs', { directoryId: id, cursor: logCursorRef.current });
      if (pollTokenRef.current !== token) return;
      setServer(s || null);
      status = s?.status;
      if (logs?.text) setRuntimeLogs((prev) => `${prev}${logs.text}`.slice(-120000));
      if (typeof logs?.cursor === 'number') logCursorRef.current = logs.cursor;
    } catch (err) {
      setError(errMsg(err));
    }
    if (pollTokenRef.current === token && ['installing', 'starting', 'ready'].includes(status)) {
      setTimeout(() => pollRuntime(id, token), status === 'ready' ? 2500 : 900);
    }
  }, [call]);

  const startServer = useCallback(async (install = false) => {
    const id = selectedRef.current?.id;
    if (!id) return;
    setRuntimeLoading(true);
    try {
      const res = await call('workspace.dev.start', { directoryId: id, appPath: detection?.appPath, install }, 60000);
      setServer(res?.record || null);
      if (res?.detection) setDetection(res.detection);
      setRuntimeLogs('');
      logCursorRef.current = 0;
      const token = ++pollTokenRef.current;
      pollRuntime(id, token);
    } catch (err) {
      flash(errMsg(err), 'danger');
    } finally {
      if (mountedRef.current) setRuntimeLoading(false);
    }
  }, [call, detection, pollRuntime, flash]);

  const stopServer = useCallback(async () => {
    const id = selectedRef.current?.id;
    if (!id) return;
    pollTokenRef.current += 1;
    try {
      const res = await call('workspace.dev.stop', { directoryId: id });
      setServer(res || null);
    } catch (err) {
      flash(errMsg(err), 'danger');
    }
  }, [call, flash]);

  const restartServer = useCallback(async () => {
    const id = selectedRef.current?.id;
    if (!id) return;
    setRuntimeLoading(true);
    try {
      const res = await call('workspace.dev.restart', { directoryId: id, appPath: detection?.appPath }, 60000);
      setServer(res?.record || null);
      setRuntimeLogs('');
      logCursorRef.current = 0;
      const token = ++pollTokenRef.current;
      pollRuntime(id, token);
    } catch (err) {
      flash(errMsg(err), 'danger');
    } finally {
      if (mountedRef.current) setRuntimeLoading(false);
    }
  }, [call, detection, pollRuntime, flash]);

  /** Pull the dev-server logs once (the Logs sheet calls this while open). */
  const refreshLogs = useCallback(async () => {
    const id = selectedRef.current?.id;
    if (!id) return;
    try {
      const [s, logs] = await Promise.all([
        call('workspace.dev.status', { directoryId: id }),
        call('workspace.dev.logs', { directoryId: id, cursor: logCursorRef.current }),
      ]);
      setServer(s || null);
      if (logs?.text) setRuntimeLogs((prev) => `${prev}${logs.text}`.slice(-120000));
      if (typeof logs?.cursor === 'number') logCursorRef.current = logs.cursor;
    } catch {
      /* keep what we have */
    }
  }, [call]);

  const loadRuntime = useCallback(async (entry, { autoStartEnabled } = {}) => {
    if (!entry) return;
    const token = pollTokenRef.current;
    setRuntimeLoading(true);
    try {
      const [det, srv] = await Promise.all([
        call('workspace.dev.detect', { directoryId: entry.id }, 30000),
        call('workspace.dev.status', { directoryId: entry.id }),
      ]);
      if (selectedRef.current?.id !== entry.id || pollTokenRef.current !== token) return;
      setDetection(det || null);
      setServer(srv || null);
      loadVersions(entry.id);
      // First log page, so an errored server shows its output straight away.
      call('workspace.dev.logs', { directoryId: entry.id, cursor: 0 })
        .then((logs) => {
          if (selectedRef.current?.id !== entry.id) return;
          if (logs?.text) setRuntimeLogs(String(logs.text).slice(-120000));
          if (typeof logs?.cursor === 'number') logCursorRef.current = logs.cursor;
        })
        .catch(() => {});
      if (shouldAutoStartRuntime({ autoStart: autoStartEnabled, explicitIds: explicitIdsRef.current, directoryId: entry.id, detection: det, server: srv })) {
        setRuntimeLoading(false);
        await startServer(false);
      } else if (srv && ['installing', 'starting', 'ready'].includes(srv.status)) {
        pollRuntime(entry.id, token);
      }
    } catch (err) {
      if (selectedRef.current?.id === entry.id) setError(errMsg(err));
    } finally {
      if (mountedRef.current) setRuntimeLoading(false);
    }
  }, [call, loadVersions, pollRuntime, startServer]);

  const setAutoStart = useCallback((on) => {
    setAutoStartState(on);
    writeJson(`${KEY}autoStart`, on);
  }, []);

  // ── git ──
  const loadGit = useCallback(async (entry = selectedRef.current, { staged = false } = {}) => {
    if (!entry) return;
    setGit((g) => ({ ...g, loading: true, error: null, staged }));
    try {
      const [st, diff] = await Promise.all([
        call('git.status', { cwd: entry.path }),
        call('git.diff', { cwd: entry.path, patch: true, ...(staged ? { staged: true } : {}) }, 30000),
      ]);
      if (selectedRef.current?.id !== entry.id) return;
      const known = [...statPaths(diff?.stat), ...parseUnifiedDiff(diff?.patch).files.map((f) => f.path)];
      const status = st ? { ...st, files: repairGitStatusFiles(st.files, known) } : null;
      setGit({ loading: false, status, stat: diff?.stat || '', patch: diff?.patch || '', error: null, staged });
    } catch (err) {
      if (selectedRef.current?.id === entry.id) setGit({ loading: false, status: null, stat: '', patch: '', error: errMsg(err), staged });
    }
  }, [call]);

  const loadFileDiff = useCallback(async (relPath, { staged = false } = {}) => {
    const entry = selectedRef.current;
    if (!entry) return;
    setFileDiff({ path: relPath, loading: true, patch: '', error: null });
    try {
      const res = await call('git.diff', { cwd: entry.path, patch: true, path: relPath, ...(staged ? { staged: true } : {}) }, 30000);
      setFileDiff({ path: relPath, loading: false, patch: res?.patch || '', stat: res?.stat || '', error: null });
    } catch (err) {
      setFileDiff({ path: relPath, loading: false, patch: '', error: errMsg(err) });
    }
  }, [call]);

  // ── linked business rows ──
  const loadLinked = useCallback(async (entry = selectedRef.current) => {
    if (!entry) return;
    setLinkedLoading(true);
    try {
      const defaults = await call('db.system.defaults', {});
      const out = [];
      for (const d of defaults?.defaults || []) {
        if (!d?.database || !['projects', 'tasks', 'notes'].includes(d.role)) continue;
        try {
          const res = await call('db.rows.list', { databaseId: d.database.id }, 30000);
          out.push(...matchLinkedRows(d.database, res?.rows, entry));
        } catch {
          /* skip a failing database */
        }
      }
      if (selectedRef.current?.id === entry.id) setLinked(out.slice(0, 20));
    } catch {
      /* best-effort strip */
    } finally {
      if (mountedRef.current) setLinkedLoading(false);
    }
  }, [call]);

  // ── project mode ──
  const setProjectMode = useCallback((mode) => {
    setProjectModeState(mode);
    setSlideIndex(0);
    savePrefs(selectedRef.current?.id, { projectMode: mode });
  }, [savePrefs]);

  const runModeDetection = useCallback(async (entry) => {
    try {
      const root = await call('files.tree', { path: entry.path, depth: 1 });
      const names = (root?.children || []).map((c) => c.name);
      let pkg = null;
      if (names.map((n) => n.toLowerCase()).includes('package.json')) {
        try {
          pkg = (await call('files.read', { path: joinPath(entry.path, 'package.json') }))?.content || null;
        } catch {
          pkg = null;
        }
      }
      if (selectedRef.current?.id === entry.id) setProjectModeState(detectProjectMode(names, pkg));
    } catch {
      if (selectedRef.current?.id === entry.id) setProjectModeState('web');
    }
  }, [call]);

  const setDevUrl = useCallback((url) => {
    const v = String(url || '').trim();
    setDevUrlState(v);
    savePrefs(selectedRef.current?.id, { devUrl: v });
  }, [savePrefs]);

  const setPreviewRoute = useCallback((route) => {
    const r = String(route || '').trim();
    setPreviewRouteState(r.startsWith('/') ? r : `/${r}`);
  }, []);

  const reloadPreview = useCallback(() => setPreviewNonce(Date.now()), []);

  // ── select ──
  const ensureRoot = useCallback(async (entry) => {
    try {
      const listed = await call('files.roots.list', {});
      if (!(listed?.roots || []).some((r) => samePath(r.path, entry.path))) {
        await call('files.roots.add', { path: entry.path, name: entry.name });
      }
    } catch {
      /* tree load surfaces a real access error */
    }
  }, [call]);

  const selectWorkspace = useCallback(async (id, { explicit = false, list } = {}) => {
    const all = list || workspaces;
    const entry = all.find((w) => w.id === id);
    if (!entry) return;
    if (explicit && !explicitIdsRef.current.includes(id)) explicitIdsRef.current = [...explicitIdsRef.current, id];
    pollTokenRef.current += 1;
    selectedRef.current = entry;
    setSelectedId(id);
    setTree(null);
    setTreeError(null);
    setExpanded(new Set());
    tabsRef.current = [];
    setTabs([]);
    setActivePath(null);
    setDetection(null);
    setServer(null);
    setRuntimeLogs('');
    logCursorRef.current = 0;
    setVersions([]);
    setVersionDiff(null);
    setGit({ loading: false, status: null, stat: '', patch: '', error: null, staged: false });
    setFileDiff(null);
    setLinked([]);
    setSelectedElement(null);
    setPreviewRouteState('/');
    setSlideIndex(0);
    setAgentModel(null);
    setThinkingLevel(null);
    setActivity([]);
    writeJson(`${KEY}lastSelected`, id);
    setRecentIds((prev) => {
      const next = pushRecent(prev, id, 5);
      writeJson(`${KEY}recents`, next);
      return next;
    });

    const prefs = await readJson(`${KEY}${id}`, {});
    setDevUrlState(prefs.devUrl || '');
    if (prefs.projectMode) setProjectModeState(prefs.projectMode);
    const autoStartPref = await readJson(`${KEY}autoStart`, true);

    await ensureRoot(entry);
    await Promise.all([
      loadTree(entry),
      prefs.projectMode ? Promise.resolve() : runModeDetection(entry),
      loadRuntime(entry, { autoStartEnabled: autoStartPref !== false }),
      loadGit(entry),
    ]);
    if (Array.isArray(prefs.openTabs)) {
      for (const p of prefs.openTabs.slice(-6)) {
        if (selectedRef.current?.id !== id) return;
        await openFile(p, { activate: false });
      }
      if (prefs.activeTabPath && selectedRef.current?.id === id) setActivePath(prefs.activeTabPath);
    }
  }, [workspaces, ensureRoot, loadTree, runModeDetection, loadRuntime, loadGit, openFile]);

  /** Picking the already-active (restored) project makes it explicitly opened. */
  const openActiveExplicitly = useCallback(async () => {
    const entry = selectedRef.current;
    if (!entry || explicitIdsRef.current.includes(entry.id)) return;
    explicitIdsRef.current = [...explicitIdsRef.current, entry.id];
    await loadRuntime(entry, { autoStartEnabled: autoStart });
  }, [loadRuntime, autoStart]);

  const loadWorkspaces = useCallback(async ({ keepSelection = false } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const res = await call('directories.list', { active: true });
      const list = normalizeWorkspaces(res);
      setWorkspaces(list);
      if (keepSelection && selectedRef.current && list.some((w) => w.id === selectedRef.current.id)) {
        return list;
      }
      const lastId = await readJson(`${KEY}lastSelected`, null);
      const target = pickInitialWorkspace(list, lastId);
      if (target && target.id !== selectedRef.current?.id) {
        selectWorkspace(target.id, { explicit: false, list });
      }
      return list;
    } catch (err) {
      setError(errMsg(err));
      return null;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [call, selectWorkspace]);

  useEffect(() => {
    if (connected) loadWorkspaces({ keepSelection: true });
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Web parity: refresh the tree every 15 s while a workspace is open.
  useEffect(() => {
    if (!connected || !selectedId) return undefined;
    const t = setInterval(() => loadTree(undefined, { quiet: true }), 15000);
    return () => clearInterval(t);
  }, [connected, selectedId, loadTree]);

  const refreshAll = useCallback(async () => {
    const entry = selectedRef.current;
    await loadWorkspaces({ keepSelection: true });
    if (entry) {
      await Promise.all([loadTree(entry), loadRuntime(entry, { autoStartEnabled: false }), loadGit(entry, { staged: git.staged })]);
    }
  }, [loadWorkspaces, loadTree, loadRuntime, loadGit, git.staged]);

  // ── create workspace ──
  const createWorkspace = useCallback(async ({ path, name, mode, template }) => {
    const p = String(path || '').trim();
    if (!p) return { ok: false, error: 'Folder path is required' };
    const display = String(name || '').trim() || p.split(/[\\/]/).filter(Boolean).pop() || 'Workspace';
    try {
      const res = await call('directories.create', { path: p, name: display, active: true }, 30000);
      setRecentFolders((prev) => {
        const next = pushRecent(prev, p, 6);
        writeJson(`${KEY}recentFolders`, next);
        return next;
      });
      const list = await loadWorkspaces({ keepSelection: true });
      if (res?.id) {
        if (template && template !== 'none') {
          await call('workspace.templates.scaffold', { directoryId: res.id, templateId: template }, 120000);
        }
        await selectWorkspace(res.id, { explicit: true, list: list || undefined });
        if (mode) {
          setProjectModeState(mode);
          savePrefs(res.id, { projectMode: mode });
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }, [call, loadWorkspaces, selectWorkspace, savePrefs]);

  // ── templates / bindings / snippets ──
  const [applyingTemplate, setApplyingTemplate] = useState(false);

  const applyTemplate = useCallback(async (template, bindingId = null) => {
    const entry = selectedRef.current;
    if (!entry || !template) return false;
    setApplyingTemplate(true);
    try {
      for (const f of templateWrites(template, entry, bindingId)) {
        await call('files.write', { path: f.path, content: f.content });
      }
      await loadTree(entry, { quiet: true });
      const main = templateEntryFile(template);
      if (main) await openFile(joinPath(entry.path, main.path));
      flash(`Scaffolded ${template.name}`, 'success');
      return true;
    } catch (err) {
      flash(errMsg(err), 'danger');
      return false;
    } finally {
      if (mountedRef.current) setApplyingTemplate(false);
    }
  }, [call, loadTree, openFile, flash]);

  const insertSnippet = useCallback((snippet, bindingId = null) => {
    const tab = tabsRef.current.find((t) => t.path === activePath);
    if (!tab) {
      flash('Open a file first, then insert the snippet.', 'warning');
      return false;
    }
    const source = String(snippet.source || '').replace(/__FORM_ACTION__/g, bindingId ? `/api/forms/${bindingId}/submit` : '/api/forms/REPLACE_ME/submit');
    setTabs((prev) => patchTab(prev, tab.path, { content: appendSnippet(tab.content, source) }));
    flash(`Inserted into ${tab.name} — save to write it`, 'success');
    return true;
  }, [activePath, flash]);

  /** Databases for the bind dialog + the spec's default-role preselection. */
  const loadBindChoices = useCallback(async (spec) => {
    const res = await call('db.list', {});
    const choices = (res?.databases || []).map((d) => ({ id: d.id, name: d.name, slug: d.slug }));
    let preselect = '';
    if (spec?.defaultRole) {
      try {
        const def = await call('db.system.resolve', { role: spec.defaultRole });
        preselect = def?.resolved?.database?.id || '';
      } catch {
        /* role unset */
      }
    }
    return { choices, preselect: preselect || choices[0]?.id || '' };
  }, [call]);

  /** Bind & apply — existing database or a new one seeded with the spec's properties. */
  const confirmBind = useCallback(async ({ spec, mode, databaseId, newName, template, snippet }) => {
    try {
      let dbId = databaseId;
      if (mode === 'new') {
        const name = String(newName || '').trim();
        if (!name) return { ok: false, error: 'Database name required' };
        const created = await call('db.create', { name, properties: spec.newDatabaseProperties || [] }, 30000);
        dbId = created?.database?.id || '';
      }
      if (!dbId) return { ok: false, error: 'Pick a database or create a new one' };
      const entry = selectedRef.current;
      const bindingRes = await call('forms.bindings.create', {
        name: `${entry?.name || 'Workspace'} — ${spec.label}`,
        databaseId: dbId,
        fieldMap: bindingFieldMap(spec),
        titleTemplate: spec.titleTemplate,
        meta: { workspaceId: entry?.id, templateId: template?.id, snippetId: snippet?.id },
      });
      const bindingId = bindingRes?.binding?.id || '';
      if (!bindingId) return { ok: false, error: 'Failed to create form binding' };
      if (template) await applyTemplate(template, bindingId);
      else if (snippet) insertSnippet(snippet, bindingId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }, [call, applyTemplate, insertSnippet]);

  // ── workflows ──
  const loadWorkflows = useCallback(async () => {
    setWorkflows((w) => ({ ...w, loading: true, error: null }));
    try {
      const res = await call('workflows.list', {});
      setWorkflows({ loading: false, list: normalizeWorkflows(res), error: null });
    } catch (err) {
      setWorkflows({ loading: false, list: [], error: errMsg(err) });
    }
  }, [call]);

  const runWorkflow = useCallback(async (wf) => {
    const entry = selectedRef.current;
    if (!entry || !wf) return;
    const id = `wf_${Date.now()}`;
    setActivity((a) => [...a, { id, text: `Running workflow "${wf.name}"…`, pending: true, ts: Date.now() }]);
    try {
      const res = await call('workflows.run.start', {
        id: wf.id,
        inputs: { workdir: entry.path, projectId: entry.projectId, workspaceName: entry.name, mode: projectMode, activeFile: activePath },
      }, 60000);
      const text = typeof res?.result === 'string' && res.result ? res.result : `Workflow "${wf.name}" started.`;
      setActivity((a) => a.map((m) => (m.id === id ? { ...m, text, pending: false, runId: res?.runId } : m)));
    } catch (err) {
      setActivity((a) => a.map((m) => (m.id === id ? { ...m, text: `Workflow error: ${errMsg(err)}`, pending: false, error: true } : m)));
    }
  }, [call, projectMode, activePath]);

  const dismissActivity = useCallback((id) => setActivity((a) => a.filter((m) => m.id !== id)), []);

  // ── model / thinking ──
  const loadModels = useCallback(async () => {
    try {
      const [res, sess] = await Promise.all([
        call('models.list', {}, 30000),
        sessionKey ? call('sessions.list', { search: sessionKey, limit: 1 }).catch(() => null) : null,
      ]);
      setModels(pickableModels(res));
      const def = defaultModelLabel(sess?.defaults);
      if (def) setAgentDefaultModel(def);
      const row = (sess?.sessions || []).find((s) => s.key === sessionKey);
      if (row?.model) setAgentModel(row.modelProvider ? `${row.modelProvider}/${row.model}` : row.model);
      if (row?.thinkingLevel) setThinkingLevel(row.thinkingLevel);
    } catch {
      /* picker shows what it has */
    }
  }, [call, sessionKey]);

  useEffect(() => {
    if (connected && sessionKey) loadModels();
  }, [connected, sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const setModel = useCallback(async (model) => {
    if (!sessionKey) return;
    try {
      await call('sessions.patch', { key: sessionKey, model });
      setAgentModel(model);
    } catch (err) {
      flash(errMsg(err), 'danger');
    }
  }, [call, sessionKey, flash]);

  const setThinking = useCallback(async (level) => {
    if (!sessionKey) return;
    try {
      await call('sessions.patch', { key: sessionKey, thinkingLevel: level || null });
      setThinkingLevel(level || null);
    } catch (err) {
      flash(errMsg(err), 'danger');
    }
  }, [call, sessionKey, flash]);

  // ── terminal (Claude CLI in the workspace dir) ──
  const spawnClaudeTerminal = useCallback(async () => {
    const entry = selectedRef.current;
    if (!entry) return false;
    try {
      const list = await call('terminal.list', {});
      const existing = (list?.terminals || []).find((t) => samePath(t.cwd, entry.path) && (t.cli === 'claude' || /claude/i.test(String(t.title || ''))));
      if (existing) return true;
      const id = terminalId();
      await call('terminal.create', { id, cwd: entry.path, cols: 80, rows: 24, name: `Claude · ${entry.name}` }, 30000);
      await call('terminal.agent.invoke', { id, cli: 'claude', options: {} }, 30000).catch(() => {});
      return true;
    } catch (err) {
      flash(errMsg(err), 'danger');
      return false;
    }
  }, [call, flash]);

  // ── visual verify ──
  const runVisualVerify = useCallback(async ({ baseUrl, gatewayPort, route }) => {
    setVisualVerify({ running: true, screenshots: [], error: null });
    try {
      const res = await call('verification.visual', {
        baseUrl,
        gatewayPort,
        routes: [route],
        expectation: 'The workspace preview renders successfully without an error overlay, clipping, or broken responsive layout.',
        viewports: [{ width: 1440, height: 900 }, { width: 390, height: 844 }],
        themes: ['dark', 'light'],
      }, 300000);
      setVisualVerify({ running: false, screenshots: res?.screenshots || [], error: null });
    } catch (err) {
      setVisualVerify({ running: false, screenshots: [], error: errMsg(err) });
    }
  }, [call]);

  return {
    connected,
    // registry
    workspaces, loading, error, selected, selectedId, recentIds, recentFolders,
    loadWorkspaces, selectWorkspace, openActiveExplicitly, createWorkspace, refreshAll,
    notice, flash, clearNotice: () => setNotice(null),
    // files
    tree, treeLoading, treeError, expanded, toggleExpand, collapseAll, loadTree,
    tabs, activeTab, activePath, openFile, activateTab, closeTab, updateTabContent, saveTab, saveAll, reloadTab,
    // preview / mode
    projectMode, setProjectMode, devUrl, setDevUrl, previewRoute, setPreviewRoute, previewNonce, reloadPreview,
    previewDevice, setPreviewDevice, selectedElement, setSelectedElement, slideIndex, setSlideIndex,
    // runtime
    detection, server, runtimeLoading, runtimeLogs, autoStart, setAutoStart,
    startServer, stopServer, restartServer, refreshLogs,
    // versions
    versions, versionDiff, setVersionDiff, loadVersions, showVersionDiff, revertVersion, createCheckpoint,
    // git
    git, loadGit, fileDiff, setFileDiff, loadFileDiff,
    // linked
    linked, linkedLoading, loadLinked,
    // templates
    applyingTemplate, applyTemplate, insertSnippet, loadBindChoices, confirmBind,
    // workflows
    workflows, loadWorkflows, runWorkflow, activity, dismissActivity,
    // agent
    sessionKey, models, agentModel, agentDefaultModel, thinkingLevel, loadModels, setModel, setThinking,
    // misc
    spawnClaudeTerminal, visualVerify, runVisualVerify,
  };
}

export default useWorkspace;
