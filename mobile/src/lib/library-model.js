// Library model — document types + the typed library list for the phone.
//
// Mirrors the gateway's documents.types.list / documents.library payloads
// (src/documents/doc-types-shared.ts + library.ts). When the gateway predates
// those RPCs, the screen falls back to notes.list + ideas.list and types the
// notes from their legacy category here. Pure: no React, unit-tested.

export const BUILTIN_TYPES = [
  { id: 'note', label: 'Note', icon: 'penLine', color: '#d9b45f', backing: 'documents', creatable: true },
  { id: 'idea', label: 'Idea', icon: 'lightbulb', color: '#f3c623', backing: 'ideas', creatable: true },
  { id: 'document', label: 'Document', icon: 'fileText', color: '#c9c3b6', backing: 'documents', creatable: true },
  { id: 'meeting', label: 'Meeting notes', icon: 'users', color: '#5fb3d9', backing: 'documents', creatable: true },
  { id: 'research', label: 'Research', icon: 'book', color: '#7cc68d', backing: 'documents', creatable: true },
  { id: 'report', label: 'Report', icon: 'barChart', color: '#e08a5f', backing: 'reports', creatable: false },
  { id: 'sop', label: 'SOP / How-to', icon: 'clipboard', color: '#9f8cf0', backing: 'documents', creatable: true },
  { id: 'spec', label: 'Spec / PRD', icon: 'fileCode', color: '#4fc1c9', backing: 'documents', creatable: true },
  { id: 'brief', label: 'Brief', icon: 'briefcase', color: '#e0b25f', backing: 'documents', creatable: true },
  { id: 'journal', label: 'Journal / Log', icon: 'calendar', color: '#c98fb8', backing: 'documents', creatable: true },
  { id: 'plan', label: 'Plan', icon: 'target', color: '#e06a6a', backing: 'documents', creatable: true },
  { id: 'template', label: 'Template', icon: 'layers', color: '#8fa3b8', backing: 'documents', creatable: true },
  { id: 'snippet', label: 'Snippet / Prompt', icon: 'terminal', color: '#a3c95f', backing: 'documents', creatable: true },
].map((t, order) => ({ ...t, builtin: true, order }));

// Web icon names (ui/src/ui/icons.ts) → Ionicons used across the app.
const ION = {
  penLine: 'create-outline',
  lightbulb: 'bulb-outline',
  fileText: 'document-text-outline',
  users: 'people-outline',
  book: 'book-outline',
  barChart: 'bar-chart-outline',
  clipboard: 'clipboard-outline',
  fileCode: 'code-slash-outline',
  briefcase: 'briefcase-outline',
  calendar: 'calendar-outline',
  target: 'flag-outline',
  layers: 'layers-outline',
  terminal: 'terminal-outline',
  tag: 'pricetag-outline',
  star: 'star-outline',
  flame: 'flame-outline',
  rocket: 'rocket-outline',
  crown: 'ribbon-outline',
  globe: 'globe-outline',
  mail: 'mail-outline',
  dollarSign: 'cash-outline',
  shield: 'shield-outline',
  database: 'server-outline',
  image: 'image-outline',
  video: 'videocam-outline',
  mic: 'mic-outline',
  brain: 'school-outline',
  sparkles: 'sparkles-outline',
  house: 'home-outline',
  wrench: 'build-outline',
};

export function ionIconFor(iconName) {
  return ION[iconName] || 'document-outline';
}

export function typeById(types, id) {
  const hit = (types || []).find((t) => t.id === id);
  if (hit) return hit;
  return { id: id || 'note', label: id ? String(id).replace(/^c-/, '').replace(/-/g, ' ') : 'Note', icon: 'fileText', color: '#8a8478', backing: 'documents', creatable: false };
}

export function visibleTypes(types) {
  return (types || []).filter((t) => !t.hidden && !t.archived);
}

export function creatableTypes(types) {
  return visibleTypes(types).filter((t) => t.creatable);
}

/** Filter chips: All + every visible type (and hidden ones that still hold items), with counts. */
export function typeChips(types, counts, total) {
  const c = counts || {};
  const rows = (types || [])
    .filter((t) => (!t.hidden && !t.archived) || (c[t.id] || 0) > 0)
    .map((t) => ({ id: t.id, label: t.label, icon: ionIconFor(t.icon), color: t.color, count: c[t.id] || 0 }));
  return [{ id: null, label: 'All', icon: 'apps-outline', color: null, count: total || 0 }, ...rows];
}

const CATEGORY_TO_TYPE = {
  log: 'journal',
  journal: 'journal',
  meeting: 'meeting',
  research: 'research',
  plan: 'plan',
  spec: 'spec',
  sop: 'sop',
  brief: 'brief',
  template: 'template',
  snippet: 'snippet',
  prompt: 'snippet',
  idea: 'document',
  'voice-note': 'note',
};

/** Fallback library (no documents.library): notes typed by legacy category + ideas. */
export function fallbackLibrary(notes, ideas) {
  const items = [];
  for (const n of notes || []) {
    const cat = typeof n.category === 'string' ? n.category.toLowerCase() : '';
    items.push({
      id: n.id,
      source: 'doc',
      noteId: n.id,
      type: CATEGORY_TO_TYPE[cat] || 'note',
      title: n.name || '(untitled)',
      preview: n.description || n.preview || '',
      tags: n.tags || [],
      updatedAt: n.updatedAt || '',
    });
  }
  for (const i of ideas || []) {
    items.push({
      id: i.id,
      source: 'idea',
      type: 'idea',
      title: i.title,
      preview: (i.body || '').slice(0, 140),
      tags: i.tags || [],
      status: i.status,
      updatedAt: i.updatedAt || '',
    });
  }
  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const byType = {};
  for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
  return { items, total: items.length, counts: { all: items.length, byType, byCategory: {} } };
}

export function filterLibrary(items, type, query) {
  const q = String(query || '').trim().toLowerCase();
  return (items || []).filter((it) => {
    if (type && it.type !== type) return false;
    if (!q) return true;
    const hay = `${it.title}\n${it.preview || ''}\n${(it.tags || []).join(' ')}\n${it.category || ''}`.toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}

/** Where tapping an item goes: [screenName, params]. */
export function routeForItem(it) {
  if (it.source === 'idea') return ['Ideas', { ideaId: it.id }];
  if (it.source === 'report') return ['ReportsModal', {}];
  if (it.source === 'research') return ['Research', {}];
  if (it.noteId) return ['Notes', { noteId: it.noteId }];
  return ['Notes', { docId: it.id }];
}

export function newTitleFor(type, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (type.id === 'journal') return `Journal · ${day}`;
  if (type.id === 'meeting') return `Meeting · ${day}`;
  if (type.id === 'idea') return 'New idea';
  return `Untitled ${String(type.label).split(' /')[0].toLowerCase()}`;
}
