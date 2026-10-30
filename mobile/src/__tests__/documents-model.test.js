import {
  BUILTIN_TYPES,
  assignableTypes,
  assetFileName,
  buildTreeIndex,
  canUndoJob,
  categoryParams,
  categoryRows,
  clientLibrary,
  createTypedParams,
  crossTypeHits,
  docRefIds,
  docTypeOf,
  exportFileName,
  exportMarkdown,
  folderStats,
  folderTrail,
  folderViewMode,
  formatBytes,
  formatProp,
  isInside,
  isUnknownMethod,
  jobProgress,
  jobStatusText,
  libraryAction,
  libraryView,
  linkifyWiki,
  moveInOrder,
  moveTargets,
  newTypeParams,
  nextTableSort,
  nodeIcon,
  normalizeLibrary,
  notionImportParams,
  notionJobLabel,
  obsidianImportParams,
  parsePropInput,
  pickedAlreadyImported,
  previewKind,
  pushRecent,
  readRouteParams,
  renameParams,
  renderTemplate,
  resolveLink,
  sortRows,
  tableColumns,
  uploadQuery,
} from '../screens/documents/documents-model';

const NODES = [
  { id: 'f1', kind: 'folder', title: 'Clients', parentId: null, sortOrder: 2, updatedAt: '2026-10-01', path: 'Clients' },
  { id: 'f2', kind: 'folder', title: 'Acme', parentId: 'f1', sortOrder: 1, updatedAt: '2026-10-02', path: 'Clients / Acme' },
  { id: 'd1', kind: 'doc', title: 'Brief', parentId: 'f2', type: 'brief', category: 'client', favorite: true, updatedAt: '2026-10-05', createdAt: '2026-10-01' },
  { id: 'd2', kind: 'doc', title: 'alpha', parentId: null, sortOrder: 1, updatedAt: '2026-10-03', createdAt: '2026-10-03' },
  { id: 'x1', kind: 'file', title: 'scan.pdf', parentId: 'gone', updatedAt: '2026-10-04', file: { mime: 'application/pdf', size: 2048, ext: '.pdf', extractStatus: 'ok' } },
];

describe('documents model — tree', () => {
  const idx = buildTreeIndex(NODES, 'manual');
  it('folders first, orphans at root, manual order', () => {
    expect(idx.children.get(null).map((n) => n.id)).toEqual(['f1', 'd2', 'x1']);
    expect(buildTreeIndex(NODES, 'updated').children.get(null).map((n) => n.id)).toEqual(['f1', 'x1', 'd2']);
    expect(buildTreeIndex(NODES, 'name').children.get(null).map((n) => n.id)).toEqual(['f1', 'd2', 'x1']);
  });
  it('trail, inside, move targets', () => {
    expect(folderTrail(idx, 'f2').map((c) => c.title)).toEqual(['Clients', 'Acme']);
    expect(isInside(idx, 'f1', 'f2')).toBe(true);
    expect(isInside(idx, 'f2', 'f1')).toBe(false);
    expect(moveTargets(idx, 'f1').map((t) => t.id)).toEqual([]);
    const t = moveTargets(idx, 'd1');
    expect(t.map((x) => x.id)).toEqual(['f1', 'f2']);
    expect(t.find((x) => x.id === 'f2').current).toBe(true);
  });
  it('stats, recent, icons, bytes, preview kinds', () => {
    expect(folderStats(NODES)).toEqual({ docs: 2, folders: 2, files: 1, favorites: 1 });
    expect(pushRecent(['a', 'b', 'c'], 'b', 2)).toEqual(['b', 'a']);
    expect(nodeIcon(NODES[0], BUILTIN_TYPES).icon).toBe('folder-outline');
    expect(nodeIcon(NODES[2], BUILTIN_TYPES).icon).toBe('briefcase-outline');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(previewKind(NODES[4].file)).toBe('pdf');
    expect(previewKind({ mime: 'text/plain', extractStatus: 'ok' })).toBe('text');
    expect(docTypeOf({ kind: 'doc', source: { type: 'notion' } })).toBe('document');
    expect(docTypeOf({ kind: 'doc' })).toBe('note');
  });
});

describe('documents model — properties / table', () => {
  it('doc refs + formatting + parse back to the original shape', () => {
    expect(docRefIds(['doc:abc', 'x', 'doc:d-2'])).toEqual(['abc', 'd-2']);
    expect(formatProp(['doc:abc', 'z'], (id) => (id === 'abc' ? 'Acme' : undefined))).toBe('Acme, z');
    expect(formatProp(true)).toBe('Yes');
    expect(parsePropInput(3, '7')).toBe(7);
    expect(parsePropInput(['a'], 'a, b ,')).toEqual(['a', 'b']);
    expect(parsePropInput(false, 'yes')).toBe(true);
    expect(parsePropInput('s', 'new')).toBe('new');
  });
  it('columns, sort, view mode', () => {
    const rows = [
      { id: 'a', title: 'B', updatedAt: '2', properties: { Stage: 'Won', Value: 10 } },
      { id: 'b', title: 'A', updatedAt: '1', properties: { Stage: 'Lead' } },
    ];
    expect(tableColumns(undefined, rows).map((c) => c.key)).toEqual(['Stage', 'Value']);
    expect(tableColumns({ schema: [{ key: 't', type: 'title' }, { key: 's', name: 'S', type: 'select' }] }, rows).map((c) => c.key)).toEqual(['s']);
    expect(sortRows(rows, '__title').map((r) => r.id)).toEqual(['b', 'a']);
    expect(sortRows(rows, 'Stage', 'desc').map((r) => r.id)).toEqual(['a', 'b']);
    expect(nextTableSort({ by: 'x', dir: 'asc' }, 'x')).toEqual({ by: 'x', dir: 'desc' });
    expect(nextTableSort({ by: 'x', dir: 'asc' }, 'y')).toEqual({ by: 'y', dir: 'asc' });
    expect(folderViewMode({ schema: [{}] }, null)).toBe('table');
    expect(folderViewMode({ view: { mode: 'grid' } }, null)).toBe('grid');
    expect(folderViewMode(null, 'list')).toBe('list');
  });
});

describe('documents model — types + library', () => {
  it('assignable excludes ideas/report backings; categories sorted; reorder; template', () => {
    const ids = assignableTypes(BUILTIN_TYPES).map((t) => t.id);
    expect(ids).not.toContain('idea');
    expect(ids).not.toContain('report');
    expect(categoryRows({ b: 1, a: 3, c: 1 }).map((c) => c.category)).toEqual(['a', 'b', 'c']);
    expect(moveInOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveInOrder(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
    expect(renderTemplate('## {{ date }}', new Date('2026-10-14T00:00:00Z'))).toBe('## 2026-10-14');
    expect(newTypeParams({ label: '  ' })).toBeNull();
    expect(newTypeParams({ label: 'Recipe', icon: 'flame', color: '#fff', template: '' })).toEqual({ label: 'Recipe', icon: 'flame', color: '#fff' });
  });
  it('createTypedParams sends a template body only when types are not live', () => {
    const meeting = { id: 'meeting', label: 'Meeting notes', template: '## {{date}}' };
    const now = new Date('2026-10-14T00:00:00Z');
    expect(createTypedParams(meeting, 'f1', { typesLive: true, now })).toEqual({ kind: 'doc', title: 'Meeting · 2026-10-14', parentId: 'f1', type: 'meeting' });
    expect(createTypedParams(meeting, null, { typesLive: false, now }).body).toBe('## 2026-10-14');
  });
  it('fallback library merges docs + ideas; view filters/sorts; actions route', () => {
    const lib = clientLibrary(NODES, [{ id: 'i1', title: 'Voice CRM', body: 'crm', tags: [], status: 'new', updatedAt: '2026-10-06' }]);
    expect(lib.items.map((i) => i.id)).toEqual(['i1', 'd1', 'x1', 'd2']);
    expect(lib.counts.byType).toEqual({ idea: 1, brief: 1, document: 1, note: 1 });
    expect(lib.counts.byCategory).toEqual({ client: 1 });
    expect(libraryView(lib.items, { category: 'client' }).map((i) => i.id)).toEqual(['d1']);
    expect(libraryView(lib.items, { sort: 'name' }).map((i) => i.title)).toEqual(['alpha', 'Brief', 'scan.pdf', 'Voice CRM']);
    expect(libraryView(lib.items, { type: 'idea' }).map((i) => i.id)).toEqual(['i1']);
    expect(crossTypeHits(lib.items, 'crm').map((i) => i.id)).toEqual(['i1']);
    expect(libraryAction({ source: 'doc', id: 'd1' })).toEqual({ kind: 'doc', id: 'd1' });
    expect(libraryAction({ source: 'idea', id: 'i1' })).toEqual({ kind: 'idea', id: 'i1' });
    expect(libraryAction({ source: 'report', id: 'r' }).route).toBe('ReportsModal');
    expect(libraryAction({ source: 'research', id: 'r' }).params.params.screen).toBe('Research');
    expect(normalizeLibrary({ items: [{ id: 1 }], counts: { byType: { a: 1 } } }).counts).toEqual({ all: 1, byType: { a: 1 }, byCategory: {} });
    expect(normalizeLibrary(null)).toBeNull();
  });
});

describe('documents model — editing / links / export', () => {
  it('rename + category params', () => {
    expect(renameParams({ id: 'a', title: 'X' }, ' X ')).toBeNull();
    expect(renameParams({ id: 'a', title: 'X' }, 'Y')).toEqual({ id: 'a', title: 'Y' });
    expect(categoryParams({ id: 'a', category: 'c' }, 'c')).toBeNull();
    expect(categoryParams({ id: 'a' }, ' new ')).toEqual({ id: 'a', category: 'new' });
  });
  it('links resolve to docs, urls or missing; wiki links become tappable', () => {
    const idx = buildTreeIndex(NODES);
    expect(resolveLink(idx, NODES, 'doc:d1')).toEqual({ kind: 'doc', id: 'd1' });
    expect(resolveLink(idx, NODES, 'brief')).toEqual({ kind: 'doc', id: 'd1' });
    expect(resolveLink(idx, NODES, 'https://x.io').kind).toBe('url');
    expect(resolveLink(idx, NODES, 'Nope')).toEqual({ kind: 'missing', title: 'Nope' });
    expect(linkifyWiki('see [[Brief]] and [[Acme Plan|plan]]')).toBe('see [Brief](wiki:Brief) and [plan](wiki:Acme%20Plan)');
  });
  it('export', () => {
    expect(exportFileName('a/b: c')).toBe('a b c.md');
    expect(exportMarkdown({ title: 'T' }, 'body')).toBe('# T\n\nbody');
    expect(exportMarkdown({ title: 'T' }, '# Own')).toBe('# Own');
  });
});

describe('documents model — imports, routing, http', () => {
  it('job status / progress / undo', () => {
    const running = { status: 'running', progress: { phase: 'import', done: 5, total: 10 } };
    expect(jobStatusText(running)).toBe('Importing');
    expect(jobStatusText({ ...running, cancelRequested: true })).toBe('Cancelling…');
    expect(jobProgress(running)).toBe(0.5);
    expect(jobProgress({ status: 'queued', progress: { total: 0 } })).toBeNull();
    expect(canUndoJob({ status: 'done', undoable: 3 })).toBe(true);
    expect(canUndoJob({ status: 'done', undoable: 3, undoneAt: 'x' })).toBe(false);
  });
  it('notion + obsidian params', () => {
    expect(pickedAlreadyImported([{ source: { type: 'notion', id: 'folder:ab-cd' } }], ['abcd'])).toBe(true);
    expect(pickedAlreadyImported([], ['abcd'])).toBe(false);
    expect(notionJobLabel([{ id: 'a', title: 'Home' }, { id: 'b', title: 'X' }], ['a', 'b'])).toBe('Home + 1 more');
    expect(notionImportParams(['a'], null, { mode: 'changes', token: ' ' })).toEqual({ ids: ['a'], parentId: null, mode: 'changes' });
    expect(notionImportParams(['a'], 'f', { force: true, token: 't', label: 'L' })).toEqual({ ids: ['a'], parentId: 'f', mode: 'full', force: true, token: 't', label: 'L' });
    expect(obsidianImportParams({ source: 'git', value: 'http://x' }, null)).toBeNull();
    expect(obsidianImportParams({ source: 'git', value: 'https://g/v.git', createTasks: true }, 'f')).toEqual({ source: 'git', url: 'https://g/v.git', parentId: 'f', createTasks: true });
    expect(obsidianImportParams({ source: 'folder', value: '~/Vault', vaultName: 'V' }, null)).toEqual({ source: 'folder', path: '~/Vault', parentId: null, createTasks: false, vaultName: 'V' });
  });
  it('route params, unknown-method detection, upload helpers', () => {
    expect(readRouteParams(undefined)).toEqual({ docId: null, view: 'documents', type: null, ideaId: null });
    expect(readRouteParams({ docId: 'd', view: 'ideas', type: 'idea' })).toEqual({ docId: 'd', view: 'ideas', type: 'idea', ideaId: null });
    expect(isUnknownMethod(new Error('unknown method: documents.library'))).toBe(true);
    expect(isUnknownMethod(new Error('Document not found'))).toBe(false);
    expect(uploadQuery({ name: 'a b.jpg', ticket: 't', parentId: 'f' })).toBe('name=a%20b.jpg&t=t&parentId=f');
    expect(assetFileName({ fileName: 'x.png' })).toBe('x.png');
    expect(assetFileName({ uri: 'file:///c/IMG_1.JPG' })).toBe('IMG_1.JPG');
    expect(assetFileName({ uri: 'data:abc', mimeType: 'image/png' }, new Date('2026-10-14T00:00:00Z'))).toBe('upload-2026-10-14T00-00-00-000Z.png');
  });
});

describe('ocrStatusLine (local auto-OCR)', () => {
  const { ocrStatusLine } = require('../screens/documents/documents-model');
  it('describes each status', () => {
    expect(ocrStatusLine(null)).toBe('');
    expect(ocrStatusLine({ entry: { status: 'queued' } })).toBe('Local OCR queued');
    expect(ocrStatusLine({ entry: { status: 'processing', progress: { done: 2, total: 5 } } })).toBe('Local OCR reading page 2/5');
    expect(ocrStatusLine({ entry: { status: 'failed', error: 'boom' } })).toBe('Local OCR failed: boom');
    expect(ocrStatusLine({ entry: { status: 'done' }, sidecar: { confidence: 0.973, engines: { vl: 'qwen-vl' } } })).toBe(
      'Local OCR done · 97% confidence · described by qwen-vl',
    );
  });
});
