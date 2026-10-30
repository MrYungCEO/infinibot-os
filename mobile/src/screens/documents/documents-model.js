// documents-model — pure logic for the native Documents workspace (web
// /notes = ui/src/ui/views/documents/{workspace,model,doc-types}.ts).
//
// No React / react-native imports: unit-tested in
// src/__tests__/documents-model.test.js. Type registry + library helpers are
// shared with the Library tab (src/lib/library-model.js) and re-exported here
// so the two screens can never drift.

import {
  BUILTIN_TYPES,
  creatableTypes,
  filterLibrary,
  ionIconFor,
  newTitleFor,
  typeById,
  typeChips,
  visibleTypes,
} from '../../lib/library-model';

export { BUILTIN_TYPES, creatableTypes, filterLibrary, ionIconFor, newTitleFor, typeById, typeChips, visibleTypes };

// ── Errors ───────────────────────────────────────────────────

/** True when the gateway predates an RPC (graceful "not on this gateway"). */
export function isUnknownMethod(err) {
  const msg = String((err && (err.message || err.code)) || err || '');
  return /unknown method|method not found|no handler|not implemented|METHOD_NOT_FOUND/i.test(msg);
}

export function errorText(err) {
  if (!err) return '';
  return String(err.message || err);
}

// ── Types ────────────────────────────────────────────────────

/** Types a document can be switched to (editor type chip): documents-backed only. */
export function assignableTypes(types) {
  return visibleTypes(types).filter((t) => t.backing === 'documents');
}

/** Category rows, most used first. */
export function categoryRows(counts) {
  return Object.entries(counts || {})
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Move `id` one step up/down in an ordered id list (manage-types reorder). */
export function moveInOrder(ids, id, dir) {
  const list = [...(ids || [])];
  const i = list.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}

/** `{{date}}` → today (same as the gateway's renderTemplate). */
export function renderTemplate(tpl, now = new Date()) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{\s*date\s*\}\}/g, now.toISOString().slice(0, 10));
}

/** Icon names offered when creating / re-iconing a type (web icon ids; Ionicons via ionIconFor). */
export const TYPE_ICON_CHOICES = [
  'fileText', 'penLine', 'lightbulb', 'users', 'book', 'barChart', 'clipboard', 'fileCode', 'briefcase', 'calendar',
  'target', 'layers', 'terminal', 'tag', 'star', 'flame', 'rocket', 'crown', 'globe', 'mail',
  'dollarSign', 'shield', 'database', 'image', 'video', 'mic', 'brain', 'sparkles', 'house', 'wrench',
];

export const TYPE_COLOR_CHOICES = [
  '#d9b45f', '#f3c623', '#e08a5f', '#e06a6a', '#c98fb8', '#9f8cf0', '#5fb3d9', '#4fc1c9', '#7cc68d', '#a3c95f', '#c9c3b6', '#8fa3b8',
];

/** documents.types.create params from the new-type form (null when invalid). */
export function newTypeParams(form) {
  const label = String((form && form.label) || '').trim();
  if (!label) return null;
  const out = { label, icon: form.icon || 'tag', color: form.color || TYPE_COLOR_CHOICES[0] };
  const tpl = String(form.template || '');
  if (tpl.trim()) out.template = tpl;
  return out;
}

/** A node's type id: stored, else a light inference (older gateways send no `type`). */
export function docTypeOf(n) {
  if (!n || n.kind === 'folder') return null;
  if (n.type) return n.type;
  const src = n.source && n.source.type;
  if (src === 'notion' || src === 'notion-zip' || n.kind === 'file') return 'document';
  return 'note';
}

// ── Tree ─────────────────────────────────────────────────────

export const TREE_SORTS = [
  { key: 'manual', label: 'Manual' },
  { key: 'name', label: 'Name' },
  { key: 'updated', label: 'Updated' },
];

export function comparator(sort) {
  return (a, b) => {
    if (a.kind === 'folder' && b.kind !== 'folder') return -1;
    if (b.kind === 'folder' && a.kind !== 'folder') return 1;
    if (sort === 'name') return String(a.title).localeCompare(String(b.title), undefined, { numeric: true });
    if (sort === 'updated') return String(b.updatedAt).localeCompare(String(a.updatedAt));
    const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return sa !== sb ? sa - sb : String(a.title).localeCompare(String(b.title));
  };
}

/** { byId: Map, children: Map<parentId|null, node[]> } — orphans surface at the root. */
export function buildTreeIndex(nodes, sort = 'manual') {
  const list = (nodes || []).filter((n) => n && !n.deletedAt);
  const byId = new Map(list.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of list) {
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    const arr = children.get(key) || [];
    arr.push(n);
    children.set(key, arr);
  }
  const cmp = comparator(sort);
  for (const arr of children.values()) arr.sort(cmp);
  return { byId, children };
}

export function childrenOf(index, parentId) {
  return (index && index.children.get(parentId || null)) || [];
}

/** Ancestor ids (root first). */
export function ancestorsOf(index, id) {
  const out = [];
  let cur = index.byId.get(id);
  let guard = 0;
  while (cur && cur.parentId && guard++ < 256) {
    if (!index.byId.has(cur.parentId)) break;
    out.unshift(cur.parentId);
    cur = index.byId.get(cur.parentId);
  }
  return out;
}

/** Folder breadcrumb trail ({id,title}[]) ending at `folderId` (inclusive). */
export function folderTrail(index, folderId) {
  if (!folderId || !index.byId.has(folderId)) return [];
  return [...ancestorsOf(index, folderId), folderId].map((id) => ({ id, title: index.byId.get(id).title }));
}

/** True when `target` is `id` or inside it (a folder can't move into itself). */
export function isInside(index, id, target) {
  let cur = target;
  let guard = 0;
  while (cur && guard++ < 256) {
    if (cur === id) return true;
    const n = index.byId.get(cur);
    cur = n ? n.parentId : null;
  }
  return false;
}

/** Folders a node may move into (never itself / its descendants / current parent), by path. */
export function moveTargets(index, id) {
  const moving = index.byId.get(id);
  const out = [];
  for (const n of index.byId.values()) {
    if (n.kind !== 'folder') continue;
    if (isInside(index, id, n.id)) continue;
    out.push({ id: n.id, title: n.title, path: n.path || n.title, current: moving ? moving.parentId === n.id : false });
  }
  out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return out;
}

export function folderStats(nodes) {
  const live = (nodes || []).filter((n) => !n.deletedAt);
  return {
    docs: live.filter((n) => n.kind === 'doc').length,
    folders: live.filter((n) => n.kind === 'folder').length,
    files: live.filter((n) => n.kind === 'file').length,
    favorites: live.filter((n) => n.favorite).length,
  };
}

export function favoritesOf(nodes) {
  return (nodes || []).filter((n) => n.favorite && !n.deletedAt);
}

/** Most-recent-first id list, capped (web keeps 12). */
export function pushRecent(recent, id, max = 12) {
  return [id, ...(recent || []).filter((x) => x !== id)].slice(0, max);
}

// ── Files / icons ────────────────────────────────────────────

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function previewKind(file) {
  if (!file) return 'none';
  const m = String(file.mime || '');
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (file.extractStatus === 'ok') return 'text';
  return 'none';
}

/** Ionicon + colour for a tree / list node (type icon for docs). */
export function nodeIcon(n, types) {
  if (!n) return { icon: 'document-outline', color: null };
  if (n.kind === 'folder') return { icon: n.schema && n.schema.length ? 'server-outline' : 'folder-outline', color: null };
  if (n.kind === 'file') {
    const k = previewKind(n.file);
    const icon = k === 'image' ? 'image-outline' : k === 'video' ? 'film-outline' : k === 'audio' ? 'musical-notes-outline' : k === 'pdf' ? 'document-text-outline' : 'attach-outline';
    return { icon, color: null };
  }
  const t = typeById(types, docTypeOf(n));
  return { icon: ionIconFor(t.icon), color: t.color || null };
}

export function extractStatusText(f) {
  if (!f) return '';
  if (f.extractStatus === 'ok') return `${Number(f.extractedChars || 0).toLocaleString()} chars of text extracted`;
  if (f.extractStatus === 'none') return 'No text layer (media / scanned image)';
  if (f.extractStatus === 'pending') return 'Extracting text…';
  return `Text extraction failed: ${f.extractError || 'unknown error'}`;
}

/** One-line local auto-OCR status (files.context.get result). */
export function ocrStatusLine(ctx) {
  const e = ctx && ctx.entry;
  if (!e) return '';
  const sc = ctx.sidecar;
  if (e.status === 'queued') return 'Local OCR queued';
  if (e.status === 'processing') {
    const p = e.progress;
    return p && p.total ? `Local OCR reading page ${p.done}/${p.total}` : 'Local OCR reading…';
  }
  if (e.status === 'failed') return `Local OCR failed: ${e.error || 'unknown error'}`;
  const conf = sc && typeof sc.confidence === 'number' ? ` · ${Math.round(sc.confidence * 100)}% confidence` : '';
  const vl = sc && sc.engines && sc.engines.vl ? ` · described by ${sc.engines.vl}` : '';
  return `Local OCR done${conf}${vl}`;
}

/** Subtitle for a list row (file size, folder child count or preview). */
export function nodeSubtitle(n, index) {
  if (!n) return '';
  if (n.kind === 'file') {
    const ext = String((n.file && n.file.ext) || '').replace('.', '').toUpperCase() || 'FILE';
    return `${ext} · ${formatBytes(n.file ? n.file.size : 0)}`;
  }
  if (n.kind === 'folder') {
    const c = index ? childrenOf(index, n.id).length : 0;
    return `${c} item${c === 1 ? '' : 's'}`;
  }
  return n.preview || '';
}

// ── Properties / table ───────────────────────────────────────

export const DOC_REF_RE = /^doc:([a-zA-Z0-9_-]+)$/;

export function docRefIds(v) {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  const out = [];
  for (const x of list) {
    const m = typeof x === 'string' ? DOC_REF_RE.exec(x.trim()) : null;
    if (m) out.push(m[1]);
  }
  return out;
}

export function formatProp(v, titleOf) {
  if (v == null) return '';
  const show = (x) => {
    const m = typeof x === 'string' ? DOC_REF_RE.exec(x.trim()) : null;
    return m && titleOf ? titleOf(m[1]) || String(x) : String(x);
  };
  if (Array.isArray(v)) return v.map(show).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : '';
  return show(v);
}

/** Parse an edited property back to the previous value's shape (web renderProperties). */
export function parsePropInput(prev, raw) {
  const s = String(raw == null ? '' : raw);
  if (typeof prev === 'number' && s.trim() !== '' && Number.isFinite(Number(s))) return Number(s);
  if (Array.isArray(prev)) return s.split(',').map((x) => x.trim()).filter(Boolean);
  if (typeof prev === 'boolean') return /^(true|yes|1|✓)$/i.test(s.trim());
  return s;
}

export function tableColumns(folder, rows) {
  if (folder && folder.schema && folder.schema.length) return folder.schema.filter((c) => c.type !== 'title');
  const keys = new Set();
  for (const r of rows || []) for (const k of Object.keys(r.properties || {})) keys.add(k);
  return [...keys].map((k) => ({ key: k, name: k, type: 'text' }));
}

export function sortRows(rows, by, dir = 'asc') {
  if (!by) return rows || [];
  const sign = dir === 'desc' ? -1 : 1;
  const val = (r) => (by === '__title' ? String(r.title) : by === '__updated' ? String(r.updatedAt) : formatProp(r.properties && r.properties[by]));
  return [...(rows || [])].sort((a, b) => sign * val(a).localeCompare(val(b), undefined, { numeric: true }));
}

/** Click on a table header: same column flips direction, a new one starts ascending. */
export function nextTableSort(cur, key) {
  if (cur && cur.by === key) return { by: key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { by: key, dir: 'asc' };
}

/** Folder view mode: explicit choice, else the folder's saved view, else table for databases. */
export function folderViewMode(folder, override) {
  if (override) return override;
  if (folder && folder.view && folder.view.mode) return folder.view.mode;
  return folder && folder.schema && folder.schema.length ? 'table' : 'list';
}

// ── Library ──────────────────────────────────────────────────

/** Client-side cross-type match (title / preview / tags / category), every word must hit. */
export function matchesQuery(item, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = `${item.title}\n${item.preview || ''}\n${(item.tags || []).join(' ')}\n${item.category || ''}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export const LIBRARY_SORTS = [
  { key: 'updated', label: 'Recent' },
  { key: 'name', label: 'Name' },
  { key: 'created', label: 'Created' },
];

/** The library list for a type / category / query / sort selection. */
export function libraryView(items, { type = null, category = null, query = '', sort = 'updated' } = {}) {
  let out = filterLibrary(items || [], type, query);
  if (category) out = out.filter((i) => i.category === category);
  if (sort === 'name') out = [...out].sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
  else if (sort === 'created') out = [...out].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  else out = [...out].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

/** Library heading + subline for the current selection (web renderLibrary). */
export function libraryHeading(types, type, category) {
  const t = type ? typeById(types, type) : null;
  if (t) return { eyebrow: 'Type', title: t.label, sub: t.description || '', type: t };
  if (category) return { eyebrow: 'Category', title: category, sub: 'Everything filed under this category.', type: null };
  return { eyebrow: 'Library', title: 'All documents', sub: 'Every note, idea, document, meeting, plan, report and research item — one library, filtered by type.', type: null };
}

/**
 * Fallback library (gateway without documents.library): tree nodes + ideas,
 * typed with docTypeOf. Same shape as documents.library.
 */
export function clientLibrary(nodes, ideas) {
  const items = [];
  for (const n of nodes || []) {
    if (!n || n.kind === 'folder' || n.deletedAt) continue;
    items.push({
      id: n.id,
      source: 'doc',
      kind: n.kind,
      type: docTypeOf(n),
      inferred: !n.type,
      category: n.category,
      title: n.title || '(untitled)',
      preview: n.preview || '',
      tags: n.tags || [],
      updatedAt: n.updatedAt || '',
      createdAt: n.createdAt || '',
      parentId: n.parentId,
      path: n.path,
    });
  }
  for (const i of ideas || []) {
    items.push({
      id: i.id,
      source: 'idea',
      type: 'idea',
      title: i.title,
      preview: String(i.body || '').slice(0, 140),
      tags: i.tags || [],
      status: i.status,
      updatedAt: i.updatedAt || '',
      createdAt: i.createdAt || '',
    });
  }
  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const byType = {};
  const byCategory = {};
  for (const it of items) {
    byType[it.type] = (byType[it.type] || 0) + 1;
    if (it.category) byCategory[it.category] = (byCategory[it.category] || 0) + 1;
  }
  return { items, total: items.length, counts: { all: items.length, byType, byCategory } };
}

/** Normalise a documents.library payload (or null). */
export function normalizeLibrary(res) {
  if (!res || !Array.isArray(res.items)) return null;
  const counts = res.counts || {};
  return {
    items: res.items,
    total: typeof res.total === 'number' ? res.total : res.items.length,
    counts: { all: counts.all ?? res.items.length, byType: counts.byType || {}, byCategory: counts.byCategory || {} },
  };
}

/**
 * What tapping a library item does:
 *   { kind: 'doc', id } — open in this screen
 *   { kind: 'idea', id } — the Ideas section, focused
 *   { kind: 'nav', route, params } — another screen (reports / research)
 */
export function libraryAction(it) {
  if (!it) return null;
  if (it.source === 'idea') return { kind: 'idea', id: it.id };
  if (it.source === 'report') return { kind: 'nav', route: 'ReportsModal', params: {} };
  if (it.source === 'research') return { kind: 'nav', route: 'MainTabs', params: { screen: 'Knowledge', params: { screen: 'Research', initial: false } } };
  return { kind: 'doc', id: it.id };
}

/** Library items that are not documents and match a search (shown next to documents.search hits). */
export function crossTypeHits(items, query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  return (items || []).filter((i) => i.source !== 'doc' && matchesQuery(i, q)).slice(0, limit);
}

/** documents.create params for a typed item (template body only when types aren't live). */
export function createTypedParams(type, parentId, { typesLive = true, now = new Date() } = {}) {
  const out = { kind: 'doc', title: newTitleFor(type, now), parentId: parentId || null, type: type.id };
  if (!typesLive) {
    const body = renderTemplate(type.template, now);
    if (body) out.body = body;
  }
  return out;
}

// ── Editing ──────────────────────────────────────────────────

export const SAVE_DEBOUNCE_MS = 1200;

export function saveStateLabel(s) {
  if (s === 'saving') return 'Saving…';
  if (s === 'dirty') return 'Editing…';
  if (s === 'error') return 'Save failed';
  return 'Saved';
}

/** documents.update params for a title rename (null when nothing to do). */
export function renameParams(node, title) {
  const t = String(title || '').trim();
  if (!node || !t || t === node.title) return null;
  return { id: node.id, title: t };
}

/** documents.update params for a category edit (null when unchanged). */
export function categoryParams(node, raw) {
  const category = String(raw || '').trim();
  if (!node || category === (node.category || '')) return null;
  return { id: node.id, category };
}

/** Markdown export filename. */
export function exportFileName(title, ext = 'md') {
  const base = String(title || 'document').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
  return `${base}.${ext}`;
}

/** A doc's markdown with its title as H1 (what Export .MD produces). */
export function exportMarkdown(node, body) {
  const b = String(body || '');
  const title = String((node && node.title) || '').trim();
  if (!title || /^#\s/.test(b.trimStart())) return b;
  return `# ${title}\n\n${b}`;
}

/** Resolve an in-body link: `doc:<id>`, a [[wiki]] title, or an external url. */
export function resolveLink(index, nodes, target) {
  const t = String(target || '').trim();
  if (!t) return null;
  if (/^(https?:|mailto:|tel:)/i.test(t)) return { kind: 'url', url: t };
  const m = /^doc:([a-zA-Z0-9_-]+)$/.exec(t);
  if (m && index.byId.has(m[1])) return { kind: 'doc', id: m[1] };
  const hit = (nodes || []).find((n) => String(n.title).toLowerCase() === t.replace(/^\[\[|\]\]$/g, '').toLowerCase());
  if (hit) return { kind: 'doc', id: hit.id };
  return { kind: 'missing', title: t.replace(/^\[\[|\]\]$/g, '') };
}

/** [[Wiki links]] → markdown links the renderer can tap (`doc:` scheme resolved in-app). */
export function linkifyWiki(md) {
  return String(md || '').replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_, target, label) => {
    const t = String(target).trim();
    return `[${(label || t).trim()}](wiki:${encodeURIComponent(t)})`;
  });
}

// ── Revisions ────────────────────────────────────────────────

export function revisionLabel(r) {
  const at = r && r.at ? new Date(r.at) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleString() : '';
  const parts = [];
  if (r && r.author) parts.push(r.author);
  parts.push(`${Number((r && r.bodyLength) || 0).toLocaleString()} chars`);
  return { title: when, subtitle: parts.join(' · ') };
}

// ── Imports ──────────────────────────────────────────────────

export function isJobActive(job) {
  return !!job && (job.status === 'queued' || job.status === 'running');
}

export function jobStatusText(job) {
  if (!job) return '';
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'running') {
    if (job.cancelRequested) return 'Cancelling…';
    return job.progress && job.progress.phase === 'scan' ? 'Scanning' : 'Importing';
  }
  if (job.status === 'done') return 'Done';
  if (job.status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

/** 0..1 progress, or null (indeterminate) while the total is still unknown. */
export function jobProgress(job) {
  if (!job) return 0;
  const p = job.progress || {};
  if (!isJobActive(job)) return 1;
  if (!p.total) return null;
  return Math.min(1, Math.max(0, (p.done || 0) / p.total));
}

export function jobKindLabel(job) {
  if (!job) return '';
  if (job.kind === 'obsidian') return 'Obsidian';
  if (job.kind === 'notion-zip') return 'Notion ZIP';
  if (job.kind === 'map') return 'Mapping';
  return 'Notion';
}

export function jobCounts(job) {
  const r = (job && job.report) || {};
  const out = [];
  out.push(`${r.created || 0} new`);
  out.push(`${r.updated || 0} updated`);
  out.push(`${r.unchanged || 0} unchanged`);
  if (r.skipped) out.push(`${r.skipped} skipped (in trash)`);
  if (job && job.errorCount) out.push(`${job.errorCount} error${job.errorCount === 1 ? '' : 's'}`);
  return out;
}

export function canUndoJob(job) {
  return !!job && !isJobActive(job) && (job.undoable || 0) > 0 && !job.undoneAt;
}

/** True when any picked Notion id was imported before (offers "Sync changes"). */
export function pickedAlreadyImported(nodes, picked) {
  const norm = (s) => String(s || '').replace(/^folder:/, '').replace(/-/g, '');
  const imported = new Set(
    (nodes || []).filter((n) => n.source && n.source.type === 'notion' && n.source.id).map((n) => norm(n.source.id)),
  );
  return [...(picked || [])].some((id) => imported.has(norm(id)));
}

/** Job label for a Notion pick ("Title" / "Title + 2 more"). */
export function notionJobLabel(results, picked) {
  const set = new Set(picked || []);
  const chosen = (results || []).filter((r) => set.has(r.id));
  const first = (chosen[0] && chosen[0].title) || 'Untitled';
  return set.size <= 1 ? first : `${first} + ${set.size - 1} more`;
}

/** documents.notion.import params (web DocumentsApi.notionImport). */
export function notionImportParams(ids, parentId, { mode = 'full', force = false, token = '', label = '' } = {}) {
  const out = { ids: [...ids], parentId: parentId || null, mode };
  if (force) out.force = true;
  if (String(token || '').trim()) out.token = String(token).trim();
  if (String(label || '').trim()) out.label = String(label).trim();
  return out;
}

/** documents.obsidian.import params from the phone form (git URL or a folder path on the gateway host). */
export function obsidianImportParams(form, parentId) {
  const source = form && form.source === 'folder' ? 'folder' : 'git';
  const value = String((form && form.value) || '').trim();
  if (!value) return null;
  if (source === 'git' && !/^https:\/\//i.test(value)) return null;
  const out = { source, parentId: parentId || null, createTasks: !!(form && form.createTasks) };
  if (source === 'git') out.url = value;
  else out.path = value;
  const name = String((form && form.vaultName) || '').trim();
  if (name) out.vaultName = name;
  return out;
}

export function isHttpUrl(s) {
  return /^https?:\/\/\S+$/i.test(String(s || '').trim());
}

export const MAPPING_ROLES = [
  { key: 'projects', label: 'Projects' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'clients', label: 'Clients' },
];

// ── Time ─────────────────────────────────────────────────────

export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

// ── Routing ──────────────────────────────────────────────────

/** Normalise route params ({ docId?, view?, type? }). */
export function readRouteParams(params) {
  const p = params || {};
  const view = p.view === 'ideas' ? 'ideas' : 'documents';
  return {
    docId: typeof p.docId === 'string' && p.docId ? p.docId : null,
    view,
    type: typeof p.type === 'string' && p.type ? p.type : null,
    ideaId: typeof p.ideaId === 'string' && p.ideaId ? p.ideaId : null,
  };
}

/** Upload query string for /api/documents/upload. */
export function uploadQuery({ name, ticket, parentId, mode }) {
  const parts = [`name=${encodeURIComponent(name)}`, `t=${encodeURIComponent(ticket)}`];
  if (parentId) parts.push(`parentId=${encodeURIComponent(parentId)}`);
  if (mode) parts.push(`mode=${encodeURIComponent(mode)}`);
  return parts.join('&');
}

export function fileUrl(httpBase, id, ticket, download = false) {
  return `${httpBase}/api/documents/file/${encodeURIComponent(id)}?t=${encodeURIComponent(ticket)}${download ? '&download=1' : ''}`;
}

/** File name for an image-picker asset. */
export function assetFileName(asset, now = new Date()) {
  if (asset && asset.fileName) return asset.fileName;
  const uri = String((asset && asset.uri) || '');
  const tail = uri.split(/[/?#]/).filter(Boolean).pop() || '';
  if (/\.[a-z0-9]{2,5}$/i.test(tail) && !/^data:/i.test(uri)) return tail;
  const mime = String((asset && asset.mimeType) || '');
  const ext = mime.includes('png') ? 'png' : mime.includes('mp4') ? 'mp4' : mime.includes('quicktime') ? 'mov' : (asset && asset.type) === 'video' ? 'mp4' : 'jpg';
  return `upload-${now.toISOString().replace(/[:.]/g, '-')}.${ext}`;
}
