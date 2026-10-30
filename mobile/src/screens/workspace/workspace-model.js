/**
 * workspace-model — pure data mapping for the native Workspace page.
 *
 * Mirrors the web controller (ui/src/ui/controllers/workspace.ts) so both
 * surfaces read the same gateway data the same way: the directory registry
 * → workspaces, file trees → visible rows, LCS line diff for unsaved edits,
 * unified-diff parsing for git / checkpoint diffs, runtime status labels,
 * project-mode heuristics, quick actions, linked-row matching.
 *
 * No React, no react-native — unit-tested in src/__tests__/workspace.test.js.
 */

// ── Workspaces ──────────────────────────────────────────────────────

/** `directories.list` answers with the array or `{ entries }`. */
export function normalizeWorkspaces(res) {
  const list = Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : [];
  return list
    .filter((e) => e && typeof e.id === 'string' && typeof e.path === 'string')
    .map((e) => ({
      id: e.id,
      path: e.path,
      name: e.name || leafName(e.path) || 'Workspace',
      description: e.description || '',
      projectId: e.projectId || undefined,
      agentId: e.agentId || undefined,
      tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === 'string') : [],
      gitRemote: e.gitRemote || undefined,
    }));
}

/** Last path segment ("/a/b/c/" → "c"), tolerant of Windows separators. */
export function leafName(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/** The web's session key for the workspace's coder agent chat. */
export function agentSessionKeyFor(workspaceId) {
  return workspaceId ? `agent:coder:workspace-${workspaceId}` : '';
}

/**
 * The picker's two groups: recents (newest first, still registered) and the
 * rest, both filtered by a case-insensitive name/path query.
 */
export function pickerGroups(workspaces, recentIds, filter) {
  const q = String(filter || '').trim().toLowerCase();
  const matches = (w) => !q || w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q);
  const recents = (recentIds || [])
    .map((id) => workspaces.find((w) => w.id === id))
    .filter((w) => w && matches(w));
  const recentSet = new Set(recents.map((w) => w.id));
  const rest = workspaces.filter((w) => !recentSet.has(w.id) && matches(w));
  return { recents, rest };
}

/** Push an id/path to the front of a recents list, deduped + capped. */
export function pushRecent(list, value, max = 5) {
  if (!value) return Array.isArray(list) ? list : [];
  return [value, ...(Array.isArray(list) ? list : []).filter((x) => x !== value)].slice(0, max);
}

/** Pick the workspace to open on load: the remembered one, else the first. */
export function pickInitialWorkspace(workspaces, lastId) {
  return workspaces.find((w) => w.id === lastId) || workspaces[0] || null;
}

/**
 * Auto-derive a display name from a typed folder path, but only while the
 * name is blank or still equals the previous auto-fill (never clobbers input).
 */
export function deriveWorkspaceName(prevPath, nextPath, currentName) {
  const prevAuto = leafName(prevPath);
  const name = String(currentName || '').trim();
  if (!name || name === prevAuto) return leafName(nextPath) || name;
  return currentName;
}

/** Normalised comparison for root registration checks. */
export function samePath(a, b) {
  const n = (v) => String(v || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return n(a) === n(b);
}

/** Forward-slash path of `abs` relative to `root`, or null when outside it. */
export function relativeToRoot(abs, root) {
  const a = String(abs || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!a || !r) return null;
  if (a.toLowerCase() === r.toLowerCase()) return '';
  if (!a.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return null;
  return a.slice(r.length + 1);
}

export function joinPath(root, rel) {
  return `${String(root || '').replace(/\\/g, '/').replace(/\/$/, '')}/${String(rel || '').replace(/^\/+/, '')}`;
}

// ── File tree ───────────────────────────────────────────────────────

const HIDDEN_DIRS = new Set(['.git']);

/**
 * Flatten a `files.tree` node into the rows that are currently visible: the
 * root is always open, other folders only when their path is in `expanded`.
 * Folders sort before files, both alphabetically (case-insensitive).
 */
export function flattenTree(root, expanded, { showHidden = true } = {}) {
  const rows = [];
  if (!root) return rows;
  const open = expanded instanceof Set ? expanded : new Set(expanded || []);
  const walk = (node, depth) => {
    const kids = sortTreeChildren(node.children || []);
    for (const child of kids) {
      if (!showHidden && child.name.startsWith('.')) continue;
      if (child.isDirectory && HIDDEN_DIRS.has(child.name)) continue;
      const isOpen = Boolean(child.isDirectory && open.has(child.path));
      rows.push({
        key: child.path,
        path: child.path,
        name: child.name,
        depth,
        isDirectory: Boolean(child.isDirectory),
        expanded: isOpen,
        childCount: child.isDirectory ? (child.children || []).length : 0,
        size: typeof child.size === 'number' ? child.size : null,
      });
      if (isOpen) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

export function sortTreeChildren(children) {
  return [...(children || [])].sort((a, b) => {
    if (Boolean(a.isDirectory) !== Boolean(b.isDirectory)) return a.isDirectory ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
  });
}

/** Count files/folders in a tree (for the Files header). */
export function treeStats(root) {
  let files = 0;
  let folders = 0;
  const walk = (n) => {
    for (const c of n?.children || []) {
      if (c.isDirectory) {
        folders += 1;
        walk(c);
      } else files += 1;
    }
  };
  if (root) walk(root);
  return { files, folders };
}

/** Ionicon for a file row, by extension. */
export function fileIcon(name, isDirectory, expanded) {
  if (isDirectory) return expanded ? 'folder-open-outline' : 'folder-outline';
  const ext = extOf(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(ext)) return 'image-outline';
  if (['md', 'mdx', 'markdown', 'txt'].includes(ext)) return 'document-text-outline';
  if (['json', 'yml', 'yaml', 'toml', 'lock'].includes(ext)) return 'settings-outline';
  if (['html', 'htm', 'xhtml'].includes(ext)) return 'globe-outline';
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return 'color-palette-outline';
  if (['pdf'].includes(ext)) return 'document-outline';
  if (['sh', 'bash', 'zsh'].includes(ext)) return 'terminal-outline';
  if (LANG_BY_EXT[ext]) return 'code-slash-outline';
  return 'document-outline';
}

export function extOf(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i + 1).toLowerCase() : '';
}

export function isHtmlFile(name) {
  return /\.(html?|xhtml)$/i.test(String(name || ''));
}

export function isMarkdownFile(name) {
  return /\.(md|mdx|markdown)$/i.test(String(name || ''));
}

export function isBinaryLike(name) {
  return /\.(png|jpe?g|gif|webp|ico|avif|bmp|pdf|zip|gz|tgz|mp4|mov|webm|mp3|wav|ogg|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin)$/i.test(String(name || ''));
}

// ── Open-file tabs ──────────────────────────────────────────────────

export const MAX_TABS = 12;

/** Add (or re-activate) a tab; FIFO-trims past MAX_TABS like the web. */
export function addTab(tabs, path) {
  if (tabs.some((t) => t.path === path)) return tabs;
  const next = [...tabs, { path, name: leafName(path) || path, content: '', original: '', dirty: false, loading: true, error: null }];
  return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
}

export function patchTab(tabs, path, patch) {
  return tabs.map((t) => {
    if (t.path !== path) return t;
    const merged = { ...t, ...patch };
    merged.dirty = merged.content !== merged.original;
    return merged;
  });
}

export function closeTab(tabs, activePath, path) {
  const next = tabs.filter((t) => t.path !== path);
  const active = activePath === path ? next[next.length - 1]?.path || null : activePath;
  return { tabs: next, active };
}

/** Web's snippet insert: append to the tab body with a blank-line gap. */
export function appendSnippet(content, source) {
  const body = String(content || '');
  return body.endsWith('\n') ? `${body}\n${source}\n` : `${body}\n\n${source}\n`;
}

// ── Diff: unsaved edits (LCS, 1:1 with the web) ─────────────────────

const LCS_CELL_BUDGET = 4_000_000;

/**
 * Line diff of the disk snapshot vs the edit buffer. Same LCS as the web's
 * diffLines; past ~4M table cells (phones) it trims the common prefix/suffix
 * first and, if still too big, reports the changed middle as remove+add.
 */
export function diffLines(original, modified) {
  const a = String(original ?? '').split('\n');
  const b = String(modified ?? '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const out = [];
  let oldNum = 1;
  let newNum = 1;
  for (let i = 0; i < start; i += 1) out.push({ kind: 'context', oldNum: oldNum++, newNum: newNum++, text: a[i] });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const m = midA.length;
  const n = midB.length;
  if ((m + 1) * (n + 1) > LCS_CELL_BUDGET) {
    for (const t of midA) out.push({ kind: 'remove', oldNum: oldNum++, text: t });
    for (const t of midB) out.push({ kind: 'add', newNum: newNum++, text: t });
  } else {
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        out.push({ kind: 'context', oldNum: oldNum++, newNum: newNum++, text: midA[i] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ kind: 'remove', oldNum: oldNum++, text: midA[i] });
        i += 1;
      } else {
        out.push({ kind: 'add', newNum: newNum++, text: midB[j] });
        j += 1;
      }
    }
    while (i < m) out.push({ kind: 'remove', oldNum: oldNum++, text: midA[i++] });
    while (j < n) out.push({ kind: 'add', newNum: newNum++, text: midB[j++] });
  }
  for (let k = endA; k < a.length; k += 1) out.push({ kind: 'context', oldNum: oldNum++, newNum: newNum++, text: a[k] });
  return out;
}

export function diffTotals(lines) {
  let add = 0;
  let remove = 0;
  for (const l of lines || []) {
    if (l.kind === 'add') add += 1;
    else if (l.kind === 'remove') remove += 1;
  }
  return { add, remove };
}

/**
 * Collapse long unchanged runs to `context` lines around each change, with a
 * `{ kind: 'skip', count }` marker in between — readable on a phone.
 */
export function collapseContext(lines, context = 3) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'add' || l.kind === 'remove') {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k += 1) keep[k] = true;
    }
  });
  const out = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'skip', count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped += 1;
  });
  if (skipped) out.push({ kind: 'skip', count: skipped });
  return out;
}

// ── Diff: unified patches (git.diff / workspace.version.diff) ───────

/**
 * Parse a unified diff into renderable rows:
 *   file   `diff --git a/x b/x` header (path, added/removed totals)
 *   meta   index/---/+++/mode/rename lines
 *   hunk   `@@ -a,b +c,d @@ ...`
 *   add / remove / context  with old/new line numbers
 */
export function parseUnifiedDiff(patch) {
  const rows = [];
  const files = [];
  let file = null;
  let oldNum = 0;
  let newNum = 0;
  const text = String(patch || '');
  if (!text.trim()) return { rows, files };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      file = { path: m ? m[2] : line.slice(11), add: 0, remove: 0, index: files.length };
      files.push(file);
      rows.push({ kind: 'file', file });
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      oldNum = m ? Number(m[1]) : 0;
      newNum = m ? Number(m[2]) : 0;
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!file || /^(index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |Binary files)/.test(line)) {
      if (line) rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', newNum: newNum++, text: line.slice(1) });
      file.add += 1;
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'remove', oldNum: oldNum++, text: line.slice(1) });
      file.remove += 1;
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'meta', text: line });
    } else {
      rows.push({ kind: 'context', oldNum: oldNum++, newNum: newNum++, text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  return { rows, files };
}

// ── Git status ──────────────────────────────────────────────────────

/**
 * The live gateway's `git.status` trims its porcelain output before splitting,
 * which eats the leading space of the FIRST line: " M .gitignore" arrives as
 * status "M " + path "gitignore". Repair it against the paths the diff stat /
 * patch reports (a known path one character longer that ends with it).
 */
export function repairGitStatusFiles(files, knownPaths) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const out = files.map((f) => ({ status: String(f.status || ''), path: String(f.path || '') }));
  const first = out[0];
  const known = (knownPaths || []).filter(Boolean);
  const fix = known.find((p) => p.length === first.path.length + 1 && p.endsWith(first.path));
  if (fix && first.status[1] === ' ') {
    out[0] = { status: ` ${first.status[0]}`, path: fix };
  }
  return out;
}

/** Paths named in a `git diff --stat` block. */
export function statPaths(stat) {
  return String(stat || '')
    .split('\n')
    .map((l) => /^\s*(.+?)\s+\|\s+/.exec(l)?.[1]?.trim())
    .filter(Boolean);
}

/** Human label + tone for a porcelain XY status. */
export function gitStatusMeta(xy) {
  const s = String(xy || '  ');
  if (s === '??') return { label: 'Untracked', short: 'U', tone: 'info' };
  if (s.includes('U') || s === 'AA' || s === 'DD') return { label: 'Conflict', short: '!', tone: 'danger' };
  const x = s[0];
  const y = s[1];
  const code = y !== ' ' ? y : x;
  const staged = x !== ' ' && x !== '?';
  const map = {
    M: { label: 'Modified', short: 'M', tone: 'warning' },
    A: { label: 'Added', short: 'A', tone: 'success' },
    D: { label: 'Deleted', short: 'D', tone: 'danger' },
    R: { label: 'Renamed', short: 'R', tone: 'info' },
    C: { label: 'Copied', short: 'C', tone: 'info' },
    T: { label: 'Type change', short: 'T', tone: 'warning' },
  };
  const base = map[code] || { label: 'Changed', short: code.trim() || '?', tone: 'neutral' };
  return { ...base, staged: staged && y === ' ', partlyStaged: staged && y !== ' ' };
}

export function summarizeGitStatus(st) {
  if (!st) return '';
  if (st.clean) return 'Working tree clean';
  const parts = [];
  if (st.staged) parts.push(`${st.staged} staged`);
  if (st.unstaged) parts.push(`${st.unstaged} modified`);
  if (st.untracked) parts.push(`${st.untracked} untracked`);
  return parts.join(' · ');
}

// ── Runtime (dev server) ────────────────────────────────────────────

export function runtimeStatusOf(server, loading) {
  if (loading) return 'detecting';
  return server?.status || 'stopped';
}

/** The header pill's label — same words as the web. */
export function runtimeLabel(status) {
  if (status === 'ready') return 'Ready';
  if (status === 'error') return 'Error';
  if (status === 'stopped') return 'Start';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function runtimeTone(status) {
  if (status === 'ready') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'installing' || status === 'starting' || status === 'detecting') return 'warning';
  return 'neutral';
}

export function isRuntimeActive(status) {
  return ['installing', 'starting', 'ready'].includes(status);
}

/** Web's auto-start gate: on, explicitly opened, stopped/errored, runnable. */
export function shouldAutoStartRuntime({ autoStart, explicitIds, directoryId, detection, server }) {
  return Boolean(
    autoStart &&
      (explicitIds || []).includes(directoryId) &&
      (!server || ['stopped', 'error'].includes(server.status)) &&
      detection &&
      !detection.missingDependencies &&
      detection.kind !== 'unknown',
  );
}

/** Badge shown beside the project: framework kind, or the project mode. */
export function frameworkLabel(detection, projectMode) {
  return detection?.kind && detection.kind !== 'unknown' ? detection.kind : projectMode || 'web';
}

/**
 * Preview source, same priority as the web's getPreviewUrl:
 *   1. manual dev URL override
 *   2. ready dev server (proxied under the gateway: previewPath + route)
 *   3. the active tab when it is an HTML file inside the workspace
 *      (served by /api/workspace/preview/<id>/<rel>)
 * Returns { kind: 'url'|'gateway', url } or null.
 */
export function previewTarget({ devUrl, server, route, workspace, activeTab, nonce }) {
  const bust = (url) => (nonce ? `${url}${url.includes('?') ? '&' : '?'}_n=${nonce}` : url);
  if (devUrl) return { kind: 'url', url: bust(devUrl) };
  if (server?.status === 'ready' && server.previewPath) {
    const base = server.previewPath.endsWith('/') ? server.previewPath : `${server.previewPath}/`;
    const r = String(route || '/').trim().replace(/^\/+/, '');
    return { kind: 'gateway', url: bust(`${base}${r}`) };
  }
  if (!workspace || !activeTab || !isHtmlFile(activeTab.name)) return null;
  const rel = relativeToRoot(activeTab.path, workspace.path);
  if (rel === null) return null;
  const safe = rel.split('/').map((s) => encodeURIComponent(s)).join('/');
  return { kind: 'gateway', url: bust(`/api/workspace/preview/${encodeURIComponent(workspace.id)}/${safe}`), html: true };
}

export function normalizeRoute(route) {
  const r = String(route || '').trim();
  return r.startsWith('/') ? r : `/${r}`;
}

export const DEVICE_WIDTHS = { desktop: 1280, tablet: 768, mobile: 390 };

// ── Versions (checkpoints) ──────────────────────────────────────────

export function normalizeVersions(res) {
  const list = Array.isArray(res?.versions) ? res.versions : [];
  return list
    .filter((v) => v && v.id)
    .map((v) => ({
      id: String(v.id),
      commit: String(v.commit || ''),
      description: String(v.description || 'Checkpoint'),
      createdAt: Number(v.createdAt) || 0,
      stats: String(v.stats || ''),
    }));
}

export function checkpointDescription(text) {
  return `Before agent turn: ${String(text || '').slice(0, 80)}`;
}

// ── Project mode ────────────────────────────────────────────────────

export const PROJECT_MODES = [
  { key: 'web', label: 'Web', icon: 'globe-outline' },
  { key: 'app', label: 'App', icon: 'flash-outline' },
  { key: 'document', label: 'Doc', icon: 'document-text-outline' },
  { key: 'pdf', label: 'PDF', icon: 'document-outline' },
  { key: 'presentation', label: 'Slides', icon: 'easel-outline' },
];

/** Web's detectProjectMode heuristics over the root listing (+ package.json). */
export function detectProjectMode(childNames, pkgJsonText) {
  const names = (childNames || []).map((n) => String(n).toLowerCase());
  const hasIndexHtml = names.includes('index.html');
  if (names.includes('package.json')) {
    try {
      const pkg = pkgJsonText ? JSON.parse(pkgJsonText) : {};
      const scripts = Object.keys(pkg.scripts || {});
      const isElectron = Boolean(pkg.dependencies?.electron || pkg.devDependencies?.electron);
      const hasStartOrDev = scripts.some((s) => ['start', 'dev', 'electron'].includes(s));
      return isElectron || (hasStartOrDev && !hasIndexHtml) ? 'app' : 'web';
    } catch {
      return 'web';
    }
  }
  if (names.some((n) => n.includes('slide') || n.includes('presentation') || n.includes('deck'))) return 'presentation';
  if (names.some((n) => /^readme|^docs?/i.test(n)) && !hasIndexHtml) return 'document';
  return 'web';
}

/** Quick prompts for the composer, per mode — the web's quickActionsForMode. */
export function quickActionsForMode(mode) {
  switch (mode) {
    case 'document':
      return [
        { label: 'Polish prose', prompt: 'Polish the writing in the active file — improve clarity, rhythm, and concision without changing meaning.' },
        { label: 'Add callout', prompt: 'Add a styled callout block to highlight the key insight in the current section.' },
        { label: 'Generate TOC', prompt: 'Generate a table of contents for the active markdown file and insert it after the title.' },
        { label: 'Fix headings', prompt: 'Review the heading hierarchy in this document and fix any level jumps.' },
      ];
    case 'presentation':
      return [
        { label: 'Regen slide', prompt: 'Rewrite the current slide to be more impactful — punchy title, 3-bullet body max.' },
        { label: 'Add speaker notes', prompt: 'Add speaker notes (<!-- notes: ... -->) to each slide with talking points.' },
        { label: 'Add slide', prompt: 'Insert a new slide after the current one that elaborates on the previous point.' },
        { label: 'Pick theme', prompt: 'Suggest a colour palette and font pairing for this presentation and apply it via CSS variables in a <style> slide.' },
      ];
    case 'pdf':
      return [
        { label: 'Tighten layout', prompt: 'Review the active file for PDF layout issues: orphaned headings, overly long paragraphs, missing page breaks. Suggest fixes.' },
        { label: 'Add cover page', prompt: 'Generate a styled cover page section in the markdown.' },
        { label: 'Format tables', prompt: 'Reformat all tables in the active file to look clean in print output.' },
      ];
    case 'app':
      return [
        { label: 'Run dev server', prompt: 'Check package.json and tell me the exact command to start the dev server for this app.' },
        { label: 'Fix build errors', prompt: 'Read the last build output and fix any TypeScript or bundler errors.' },
        { label: 'Add feature', prompt: "Describe this app's current entry point and suggest the next highest-value feature to add." },
      ];
    case 'web':
    default:
      return [
        { label: 'Audit HTML', prompt: 'Audit the active HTML file: accessibility issues, missing meta tags, broken image alts.' },
        { label: 'Optimise CSS', prompt: 'Review the CSS in the active file and suggest performance and maintainability improvements.' },
        { label: 'Add component', prompt: 'Based on the existing code style, scaffold a new reusable UI component in this project.' },
      ];
  }
}

/** The web composer's two standing suggestions. */
export const COMPOSER_SUGGESTIONS = ['Make the hero section more premium', 'Add a pricing section'];

/** Prefill for "Fix with agent" on a failed dev server. */
export function fixServerPrompt(server, logs) {
  const detail = server?.error || String(logs || '').slice(-1200);
  return `Fix the development server error and restore the live preview:\n\n${detail}`;
}

/** Selected-element context appended to an agent turn (web selectionContext). */
export function selectionContext(sel) {
  if (!sel) return '';
  return [
    '',
    '[Visual selection from the live preview]',
    `Selector: ${sel.selector}`,
    sel.source ? `Component/source: ${sel.source}` : 'Component/source: not exposed by the framework',
    sel.text ? `Visible text: ${sel.text}` : '',
    `Element HTML: ${sel.html}`,
    sel.screenshotPath ? `Screenshot: ${sel.screenshotPath}` : '',
    'Use this selection as the primary visual target. Preserve unrelated behavior.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Message actually sent: text + selection context unless already included. */
export function composeAgentMessage(text, sel) {
  const t = String(text || '').trim();
  if (!sel || t.includes(sel.selector)) return t;
  return `${t}${selectionContext(sel)}`;
}

// ── Slides (presentation mode) ──────────────────────────────────────

/** Split markdown into slides on `---` lines, else on level-1 headings. */
export function parseSlides(content) {
  const text = String(content || '');
  const raw = text.split(/^---\s*$/m);
  if (raw.length <= 1) {
    const byH1 = text.split(/^(?=# )/m).filter((s) => s.trim().length > 0);
    if (byH1.length > 1) return byH1;
  }
  return raw.filter((s) => s.trim().length > 0);
}

// ── Linked business rows ────────────────────────────────────────────

/**
 * Rows from the projects/tasks/notes system databases that mention this
 * workspace — by projectId inside the row values or by name in the title.
 */
export function matchLinkedRows(database, rows, workspace) {
  const projectId = String(workspace?.projectId || '').toLowerCase();
  const name = String(workspace?.name || '').toLowerCase();
  const out = [];
  for (const row of rows || []) {
    const title = String(row?.title || '');
    const valuesText = JSON.stringify(row?.values || {}).toLowerCase();
    const matches = (projectId && valuesText.includes(projectId)) || (name && title.toLowerCase().includes(name));
    if (!matches) continue;
    let status;
    for (const v of Object.values(row.values || {})) {
      if ((v?.type === 'status' || v?.type === 'select') && typeof v.optionId === 'string') {
        status = v.optionId;
        break;
      }
    }
    out.push({ databaseId: database.id, databaseName: database.name, rowId: row.id, title: title || 'Untitled', status });
  }
  return out;
}

export function relationKindForDb(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('task')) return 'task';
  if (lower.includes('note')) return 'note';
  if (lower.includes('project')) return 'project';
  if (lower.includes('client')) return 'client';
  if (lower.includes('lead')) return 'lead';
  return 'row';
}

export const RELATION_ICONS = {
  task: 'checkbox-outline',
  note: 'document-text-outline',
  project: 'folder-outline',
  client: 'person-outline',
  lead: 'locate-outline',
  row: 'list-outline',
};

export function statusForLinked(s) {
  if (!s) return undefined;
  const lower = String(s).toLowerCase();
  if (['done', 'completed', 'won'].includes(lower)) return 'done';
  if (['in_progress', 'active', 'running'].includes(lower)) return 'active';
  if (['blocked', 'lost', 'failed'].includes(lower)) return 'blocked';
  if (['paused', 'stale'].includes(lower)) return 'paused';
  if (['todo', 'draft', 'not_started', 'pending'].includes(lower)) return 'draft';
  return undefined;
}

// ── Templates ───────────────────────────────────────────────────────

export const TEMPLATE_ICONS = {
  'business-inquiry-form': 'briefcase-outline',
  'contact-form': 'mail-outline',
  'landing-hero-cta': 'rocket-outline',
  'coming-soon': 'hourglass-outline',
  'pricing-page': 'pricetags-outline',
  'newsletter-signup': 'newspaper-outline',
  'code-starter': 'extension-puzzle-outline',
};

/** The Add-Workspace modal's scaffold choices (workspace.templates.scaffold ids). */
export const SCAFFOLD_TEMPLATES = [
  { key: 'none', label: 'Existing repo' },
  { key: 'react-vite', label: 'React + Vite' },
  { key: 'next', label: 'Next.js' },
  { key: 'html', label: 'Plain HTML' },
  { key: 'astro', label: 'Astro' },
];

export function formActionUrl(bindingId) {
  return bindingId ? `/api/forms/${bindingId}/submit` : '/api/forms/REPLACE_ME/submit';
}

/** Files a template writes: absolute target + placeholder-substituted body. */
export function templateWrites(template, workspace, bindingId) {
  const action = formActionUrl(bindingId);
  return (template?.files || []).map((f) => ({
    path: joinPath(workspace.path, f.path),
    rel: f.path,
    content: String(f.content || '')
      .replace(/__FORM_ACTION__/g, action)
      .replace(/\{\{\s*workspace\s*\}\}/g, workspace.name),
  }));
}

/** The file to open after scaffolding: index.html, else the first file. */
export function templateEntryFile(template) {
  const files = template?.files || [];
  return files.find((f) => f.path === 'index.html') || files[0] || null;
}

export function bindingFieldMap(spec) {
  const map = {};
  for (const f of spec?.fields || []) map[f.formField] = f.propertyName;
  return map;
}

// ── Workflows ───────────────────────────────────────────────────────

export function normalizeWorkflows(res) {
  const list = Array.isArray(res) ? res : Array.isArray(res?.workflows) ? res.workflows : [];
  return list
    .filter((w) => w && w.id)
    .map((w) => ({ id: String(w.id), name: String(w.name || w.id), description: w.description ? String(w.description) : '', tags: Array.isArray(w.tags) ? w.tags : [] }));
}

// ── Models ──────────────────────────────────────────────────────────

export const THINK_LEVELS = [
  { key: '', label: 'Inherit' },
  { key: 'off', label: 'Off' },
  { key: 'minimal', label: 'Minimal' },
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
];

/** The models the operator allow-listed / pinned, as `provider/id` values. */
export function pickableModels(res) {
  const list = Array.isArray(res?.models) ? res.models : [];
  return list
    .filter((m) => m && (m.allowed === true || m.pinned === true))
    .map((m) => ({
      value: m.provider ? `${m.provider}/${m.id}` : m.id,
      name: m.name || m.id,
      provider: m.provider || '',
      available: m.available !== false,
      reasoning: Boolean(m.reasoning),
    }));
}

export function defaultModelLabel(defaults) {
  if (!defaults?.model) return null;
  return defaults.modelProvider ? `${defaults.modelProvider}/${defaults.model}` : defaults.model;
}

/** "ollama-cloud/gpt-oss:120b" → { provider: 'ollama-cloud', model: 'gpt-oss:120b' } */
export function splitModel(value) {
  const v = String(value || '');
  const i = v.indexOf('/');
  return i > 0 ? { provider: v.slice(0, i), model: v.slice(i + 1) } : { provider: '', model: v };
}

// ── Syntax tint (cheap, per line) ───────────────────────────────────

const LANG_BY_EXT = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  json: 'json',
  py: 'py', rb: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', yml: 'yaml', yaml: 'yaml', toml: 'yaml',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', astro: 'html',
  go: 'js', rs: 'js', java: 'js', kt: 'js', swift: 'js', c: 'js', h: 'js', cpp: 'js', cs: 'js', php: 'js', dart: 'js',
  md: 'md', mdx: 'md', markdown: 'md',
  sql: 'sql',
};

export function languageFor(name) {
  return LANG_BY_EXT[extOf(name)] || 'text';
}

const KEYWORDS = {
  js: 'import|export|from|default|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|interface|type|enum|implements|public|private|protected|readonly|static|yield|void|fn|pub|struct|impl|use|mod|package|func|go|defer|val|var',
  py: 'def|class|import|from|as|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|with|try|except|finally|raise|lambda|yield|pass|break|continue|global|async|await|self|end|do|module|require',
  sh: 'if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|export|local|echo|cd|set|unset|source',
  sql: 'select|from|where|insert|into|values|update|set|delete|create|table|alter|drop|join|left|right|inner|on|group|by|order|limit|and|or|not|null|as|primary|key',
  css: '',
  yaml: 'true|false|null|yes|no',
  json: 'true|false|null',
};

const LINE_COMMENT = { js: '//', py: '#', sh: '#', yaml: '#', sql: '--', css: null, json: null, html: null, md: null, text: null };

/**
 * Split one line into tinted spans: { t: text, k: kind } where kind is
 * 'kw' | 'str' | 'num' | 'com' | 'tag' | 'attr' | 'head' | 'plain'.
 * Cheap and line-local (block comments spanning lines are not tracked).
 */
export function tokenizeLine(line, lang) {
  const text = String(line ?? '');
  if (!text || lang === 'text') return [{ t: text, k: 'plain' }];
  if (lang === 'md') {
    if (/^\s{0,3}#{1,6}\s/.test(text)) return [{ t: text, k: 'head' }];
    if (/^\s*([-*+]|\d+\.)\s/.test(text)) {
      const m = /^(\s*(?:[-*+]|\d+\.)\s)(.*)$/.exec(text);
      return [{ t: m[1], k: 'kw' }, { t: m[2], k: 'plain' }];
    }
    if (/^\s*>/.test(text)) return [{ t: text, k: 'com' }];
    if (/^\s*```/.test(text)) return [{ t: text, k: 'str' }];
    return [{ t: text, k: 'plain' }];
  }
  if (lang === 'html') {
    const out = [];
    const re = /(<!--.*?-->)|(<\/?[A-Za-z][\w:-]*)|(\s[\w:@.-]+(?==))|("[^"]*"|'[^']*')|(\/?>)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: text.slice(last, m.index), k: 'plain' });
      const k = m[1] ? 'com' : m[2] ? 'tag' : m[3] ? 'attr' : m[4] ? 'str' : 'tag';
      out.push({ t: m[0], k });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ t: text.slice(last), k: 'plain' });
    return out;
  }
  if (lang === 'css') {
    const out = [];
    const re = (/(\/\*.*?\*\/)|("[^"]*"|'[^']*')|(#[0-9a-fA-F]{3,8}\b|-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b)|([\w-]+(?=\s*:))|(@[\w-]+)/g);
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: text.slice(last, m.index), k: 'plain' });
      const k = m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'num' : m[4] ? 'attr' : 'kw';
      out.push({ t: m[0], k });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ t: text.slice(last), k: 'plain' });
    return out;
  }
  const comment = LINE_COMMENT[lang];
  const kw = KEYWORDS[lang] || '';
  const parts = [
    comment ? `(${escapeRe(comment)}.*$)` : '(\\u0000NEVER)',
    '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)',
    '(\\b\\d+(?:\\.\\d+)?\\b)',
    kw ? `(\\b(?:${kw})\\b)` : '(\\u0000NEVER)',
  ];
  const re = new RegExp(parts.join('|'), 'g');
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) out.push({ t: text.slice(last, m.index), k: 'plain' });
    const k = m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'num' : 'kw';
    out.push({ t: m[0], k });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), k: 'plain' });
  return out.length ? out : [{ t: text, k: 'plain' }];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lines of a file for the viewer, capped so a phone never renders 100k rows. */
export const MAX_VIEW_LINES = 4000;
export function viewLines(content) {
  const all = String(content ?? '').split('\n');
  return { lines: all.slice(0, MAX_VIEW_LINES), total: all.length, truncated: all.length > MAX_VIEW_LINES };
}

// ── Formatting ──────────────────────────────────────────────────────

export function formatWhen(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Shorten a long absolute path from the left for one-line display. */
export function shortPath(path, max = 42) {
  const p = String(path || '');
  if (p.length <= max) return p;
  return `…${p.slice(p.length - max + 1)}`;
}

/** Unique-ish id for terminal spawns. */
export function terminalId(now = Date.now(), rand = Math.random) {
  return `term-${now}-${rand().toString(36).slice(2, 8)}`;
}
