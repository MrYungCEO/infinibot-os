/**
 * Products catalog — pure data model for the native /products page.
 *
 * Mirrors extensions/products/ui/catalog-controller.ts + the helpers at the
 * bottom of extensions/products/ui/catalog.ts so the phone shows exactly the
 * numbers, labels and filters the web catalog shows. No React / RN imports:
 * unit-tested in src/__tests__/product-catalog-model.test.js.
 */

export const DEFAULT_BUSINESS_ID = 'default';

export const PRODUCT_TYPES = ['digital', 'physical', 'service', 'bundle', 'subscription'];
export const PRODUCT_STATUSES = ['active', 'draft', 'out_of_stock', 'archived'];

/** Ionicons stand-ins for the web's inline type glyphs (floppy, carton, bell, gift, cycle, record). */
export const TYPE_ICONS = {
  digital: 'save-outline',
  physical: 'cube-outline',
  service: 'notifications-outline',
  bundle: 'gift-outline',
  subscription: 'repeat-outline',
  default: 'document-text-outline',
};

/**
 * The web paints each type in a fixed hue (purple/emerald/blue/amber/pink).
 * The design system forbids hex literals, so the phone maps each type onto a
 * theme tone instead — the hue follows the live palette.
 */
export const TYPE_TONES = {
  digital: 'accent',
  physical: 'success',
  service: 'info',
  bundle: 'warning',
  subscription: 'danger',
};

/** Accent swatches offered in the context menu / detail palette (theme tones, not hexes). */
export const ACCENT_TONES = ['primary', 'warning', 'danger', 'accent', 'info', 'success', 'neutral'];
export const ACCENT_STORAGE_PREFIX = 'infinibot-product-accent:';

export const SORTS = [
  { key: 'default', label: 'Catalog order' },
  { key: 'recent', label: 'Recently updated' },
  { key: 'name', label: 'Name A–Z' },
  { key: 'price_desc', label: 'Price high–low' },
  { key: 'price_asc', label: 'Price low–high' },
  { key: 'stock_asc', label: 'Stock low–high' },
];

export function typeIcon(type) {
  return TYPE_ICONS[type] || TYPE_ICONS.default;
}

export function typeTone(type) {
  return TYPE_TONES[type] || 'neutral';
}

/** Accent tone = per-product override, else the type's tone (web: productAccent). */
export function productAccentTone(product, overrides) {
  const o = overrides && product ? overrides[product.id] : null;
  if (o && ACCENT_TONES.includes(o)) return o;
  return typeTone(product?.type);
}

/** Status → kit tone. Known enum first; free-form Notion statuses fall through to toneForStatus. */
export function statusTone(status) {
  switch (status) {
    case 'active': return 'success';
    case 'draft': return 'neutral';
    case 'out_of_stock': return 'warning';
    case 'archived': return 'neutral';
    default: return null;
  }
}

// ── normalisation ───────────────────────────────────────────────────

function str(v) {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function strArr(v) {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x) => typeof x === 'string' && x.trim());
  return out;
}

/** Defensive copy of a products.* DTO — tolerant of missing / mistyped fields. */
export function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    id: String(raw.id),
    name: str(raw.name) || '(untitled)',
    sku: str(raw.sku),
    type: str(raw.type),
    status: str(raw.status),
    price: num(raw.price),
    cost: num(raw.cost),
    inventory: num(raw.inventory),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    image: str(raw.image),
    gallery: strArr(raw.gallery),
    category: str(raw.category),
    tags: strArr(raw.tags),
    vendor: str(raw.vendor),
    weight: num(raw.weight),
    dimensions: str(raw.dimensions),
    downloadUrl: str(raw.downloadUrl),
    licenseKeyPattern: str(raw.licenseKeyPattern),
    stripeProductId: str(raw.stripeProductId),
    externalUrl: str(raw.externalUrl),
    lastSynced: str(raw.lastSynced),
    businessId: str(raw.businessId) || DEFAULT_BUSINESS_ID,
    createdAt: str(raw.createdAt) || '',
    updatedAt: str(raw.updatedAt) || '',
  };
}

export function selectProducts(res) {
  const list = Array.isArray(res?.products) ? res.products : Array.isArray(res) ? res : [];
  return list.map(normalizeProduct).filter(Boolean);
}

/** business.list → [{id,label}] with the web's "default" scope first. */
export function businessOptions(res) {
  const out = [{ id: DEFAULT_BUSINESS_ID, label: 'Default' }];
  const list = Array.isArray(res?.businesses) ? res.businesses : [];
  for (const b of list) {
    if (b && b.id && b.id !== DEFAULT_BUSINESS_ID) out.push({ id: String(b.id), label: str(b.name) || String(b.id) });
  }
  return out;
}

// ── filter / sort / stats ───────────────────────────────────────────

export const EMPTY_FILTERS = { query: '', type: 'all', status: 'all', category: 'all' };

export function hasActiveFilter(f) {
  return !!(f && ((f.query || '').trim() || f.type !== 'all' || f.status !== 'all' || f.category !== 'all'));
}

/** Same predicate as the web's filterProducts (name / SKU / description / tags). */
export function filterProducts(products, filters = EMPTY_FILTERS) {
  const q = (filters.query || '').trim().toLowerCase();
  return (products || []).filter((p) => {
    if (filters.type && filters.type !== 'all' && p.type !== filters.type) return false;
    if (filters.status && filters.status !== 'all' && p.status !== filters.status) return false;
    if (filters.category && filters.category !== 'all' && p.category !== filters.category) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q) ||
      (p.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  });
}

function ts(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
}

/** Native extra: sort the filtered list. 'recent' keeps gateway order when timestamps tie. */
export function sortProducts(products, sortKey = 'default') {
  const arr = (products || []).map((p, i) => ({ p, i }));
  // Numeric sorts: rows without the value always sink to the bottom.
  const byNum = (key, dir) => (a, b) => {
    const x = a.p[key];
    const y = b.p[key];
    const hx = typeof x === 'number';
    const hy = typeof y === 'number';
    if (hx && hy) return dir * (x - y);
    if (hx) return -1;
    if (hy) return 1;
    return 0;
  };
  const cmp = {
    recent: (a, b) => ts(b.p.updatedAt) - ts(a.p.updatedAt),
    name: (a, b) => a.p.name.localeCompare(b.p.name),
    price_desc: byNum('price', -1),
    price_asc: byNum('price', 1),
    stock_asc: byNum('inventory', 1),
  }[sortKey];
  if (!cmp) return products || [];
  arr.sort((a, b) => cmp(a, b) || a.i - b.i);
  return arr.map((x) => x.p);
}

/** Identical maths to the web's computeProductStats. */
export function computeProductStats(products) {
  const stats = {
    total: (products || []).length,
    active: 0,
    drafts: 0,
    outOfStock: 0,
    totalValue: 0,
    byType: { digital: 0, physical: 0, service: 0, bundle: 0, subscription: 0 },
  };
  for (const p of products || []) {
    if (p.status === 'active') stats.active++;
    else if (p.status === 'draft') stats.drafts++;
    else if (p.status === 'out_of_stock') stats.outOfStock++;
    if (typeof p.price === 'number') {
      const qty = typeof p.inventory === 'number' ? p.inventory : 1;
      stats.totalValue += p.price * qty;
    }
    if (p.type) stats.byType[p.type] = (stats.byType[p.type] || 0) + 1;
  }
  return stats;
}

/**
 * Filter option lists: the web's fixed enums plus any free-form values the
 * data actually carries (Notion-imported rows use statuses like "GR Posted"),
 * so every row stays reachable by a filter.
 */
export function filterOptions(products) {
  const extraTypes = new Set();
  const extraStatuses = new Set();
  const categories = new Set();
  for (const p of products || []) {
    if (p.type && !PRODUCT_TYPES.includes(p.type)) extraTypes.add(p.type);
    if (p.status && !PRODUCT_STATUSES.includes(p.status)) extraStatuses.add(p.status);
    if (p.category) categories.add(p.category);
  }
  const sorted = (s) => Array.from(s).sort((a, b) => a.localeCompare(b));
  return {
    types: [...PRODUCT_TYPES, ...sorted(extraTypes)],
    statuses: [...PRODUCT_STATUSES, ...sorted(extraStatuses)],
    categories: sorted(categories),
  };
}

// ── per-product derived values ──────────────────────────────────────

/** Gross margin % — web: round((price-cost)/price*100) when price > 0. */
export function productMargin(p) {
  if (typeof p?.price === 'number' && typeof p?.cost === 'number' && p.price > 0) {
    return Math.round(((p.price - p.cost) / p.price) * 100);
  }
  return null;
}

export function formatMargin(m) {
  if (m === null || m === undefined) return '';
  return `${m > 0 ? '+' : ''}${m}%`;
}

/** Physical stock bar: 0 = empty, >= 20 = full (web card inventory bar). */
export function inventoryPct(p) {
  if (p?.type === 'physical' && typeof p.inventory === 'number') {
    return Math.max(0, Math.min(100, (p.inventory / 20) * 100));
  }
  return null;
}

/** Inventory adjustment (stepper / quick +/-): integer, never below zero. */
export function adjustInventory(current, delta) {
  const base = typeof current === 'number' && Number.isFinite(current) ? current : 0;
  const d = Number(delta);
  return Math.max(0, Math.round(base + (Number.isFinite(d) ? d : 0)));
}

export function formatCurrency(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const neg = n < 0;
  const abs = Math.abs(n);
  const fixed = Number.isInteger(abs) ? abs.toFixed(2) : (Math.round(abs * 100) / 100).toFixed(2);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${grouped}.${frac}`;
}

/** Compact currency for KPI tiles ($11.2K). */
export function formatCurrencyCompact(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  return formatCurrency(n);
}

export function formatType(type) {
  if (!type) return '—';
  return type[0].toUpperCase() + type.slice(1);
}

export function formatStatus(status) {
  if (!status) return '—';
  if (status === 'out_of_stock') return 'Out of stock';
  return status[0].toUpperCase() + status.slice(1);
}

export function formatRelativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const diff = now - t;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 30 * 86400000) return `${Math.floor(diff / 86400000)}d ago`;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export function formatDate(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export function hashStr(s) {
  let h = 0;
  const v = String(s || '');
  for (let i = 0; i < v.length; i++) h = ((h << 5) - h + v.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Up-to-2-letter initials for the placeholder (web: productInitials). */
export function productInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic secondary tone for the placeholder gradient. */
export function placeholderComplement(product) {
  const h = hashStr(product?.id || product?.name || 'x');
  return ACCENT_TONES[h % ACCENT_TONES.length];
}

// ── gallery files ───────────────────────────────────────────────────

const KIND_ICONS = {
  image: 'image-outline',
  video: 'play-circle-outline',
  pdf: 'document-outline',
  json: 'code-slash-outline',
  html: 'code-slash-outline',
  code: 'code-slash-outline',
  doc: 'document-text-outline',
  audio: 'musical-notes-outline',
  archive: 'archive-outline',
  other: 'attach-outline',
};

export function kindIcon(kind) {
  return KIND_ICONS[kind] || KIND_ICONS.other;
}

/** Same classification as the web's galleryKindOf. */
export function galleryKindOf(url) {
  let ext = '';
  let name = String(url || '');
  const m0 = name.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)/i);
  if (m0) {
    const host = m0[1].toLowerCase();
    const path = m0[2] || '';
    let last = path.split('/').pop() || host;
    try { last = decodeURIComponent(last); } catch { /* keep raw */ }
    name = last || host;
    const m = name.match(/\.([a-z0-9]+)$/i);
    ext = m ? m[1].toLowerCase() : '';
    if (host.includes('loom.com')) return { kind: 'video', ext: 'loom', name };
    if (host.includes('youtube.com') || host.includes('youtu.be')) return { kind: 'video', ext: 'yt', name };
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'].includes(ext)) return { kind: 'image', ext, name };
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'ogg'].includes(ext)) return { kind: 'video', ext, name };
  if (ext === 'pdf') return { kind: 'pdf', ext, name };
  if (ext === 'json') return { kind: 'json', ext, name };
  if (['html', 'htm'].includes(ext)) return { kind: 'html', ext, name };
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'c', 'cpp', 'java', 'css', 'scss'].includes(ext)) return { kind: 'code', ext, name };
  if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) return { kind: 'doc', ext, name };
  if (['mp3', 'wav', 'flac', 'm4a', 'aac'].includes(ext)) return { kind: 'audio', ext, name };
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return { kind: 'archive', ext, name };
  return { kind: 'other', ext, name };
}

export function galleryItems(product, max = 18) {
  const all = (product?.gallery || []).filter((u) => typeof u === 'string' && u.trim());
  return {
    total: all.length,
    items: all.slice(0, max).map((url) => ({ url, ...galleryKindOf(url) })),
    more: Math.max(0, all.length - max),
  };
}

export function textPreviewable(item) {
  return !!item && (['json', 'code', 'html', 'doc'].includes(item.kind) || item.ext === 'txt' || item.ext === 'md');
}

export function prettyText(item, text) {
  if (item?.kind === 'json') {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* raw */ }
  }
  const s = String(text ?? '');
  return s.length > 200000 ? `${s.slice(0, 200000)}\n\n… (preview truncated — download for full file)` : s;
}

// ── editor form ─────────────────────────────────────────────────────

/** Editable field set, in the web inspector's order, with the type gates it applies. */
export const EDIT_FIELDS = [
  { key: 'name', label: 'Name', kind: 'text', required: true },
  { key: 'sku', label: 'SKU', kind: 'text', mono: true },
  { key: 'type', label: 'Type', kind: 'select' },
  { key: 'status', label: 'Status', kind: 'select' },
  { key: 'price', label: 'Price ($)', kind: 'number' },
  { key: 'cost', label: 'Cost ($)', kind: 'number' },
  { key: 'inventory', label: 'Inventory', kind: 'number', when: ['physical'] },
  { key: 'weight', label: 'Weight (kg)', kind: 'number', when: ['physical'] },
  { key: 'dimensions', label: 'Dimensions (L×W×H)', kind: 'text', when: ['physical'] },
  { key: 'vendor', label: 'Vendor', kind: 'text', when: ['physical'] },
  { key: 'downloadUrl', label: 'Download URL', kind: 'url', when: ['digital', 'subscription'] },
  { key: 'licenseKeyPattern', label: 'License key pattern', kind: 'text', mono: true, when: ['digital', 'subscription'] },
  { key: 'image', label: 'Image URL', kind: 'url' },
  { key: 'category', label: 'Category', kind: 'text' },
  { key: 'tags', label: 'Tags (comma-separated)', kind: 'tags' },
  { key: 'stripeProductId', label: 'Stripe product id', kind: 'text', mono: true },
  { key: 'externalUrl', label: 'External URL', kind: 'url' },
  { key: 'description', label: 'Description', kind: 'multiline' },
];

/** Fields the web create dialog asks for. */
export const CREATE_FIELD_KEYS = ['name', 'sku', 'type', 'price', 'description'];

export function visibleEditFields(type, keys) {
  return EDIT_FIELDS.filter((f) => (!keys || keys.includes(f.key)) && (!f.when || f.when.includes(type)));
}

export function parseTags(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Product → string form (what the TextInputs hold). */
export function productToForm(p) {
  const f = {};
  for (const field of EDIT_FIELDS) {
    const v = p ? p[field.key] : undefined;
    if (field.kind === 'tags') f[field.key] = Array.isArray(v) ? v.join(', ') : '';
    else if (field.kind === 'number') f[field.key] = typeof v === 'number' ? String(v) : '';
    else f[field.key] = v == null ? '' : String(v);
  }
  return f;
}

export function emptyCreateForm() {
  return { ...productToForm(null), type: 'digital', status: 'active' };
}

/** Parse a number box: '' → null (clear), garbage → NaN marker. */
export function parseNumberInput(text) {
  const t = String(text ?? '').trim().replace(/[$,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

export function validateForm(form) {
  const errors = {};
  if (!String(form?.name || '').trim()) errors.name = 'Name is required';
  for (const f of EDIT_FIELDS) {
    if (f.kind === 'number' && Number.isNaN(parseNumberInput(form?.[f.key]))) errors[f.key] = 'Enter a number';
  }
  return errors;
}

function formValue(field, text) {
  if (field.kind === 'number') {
    const n = parseNumberInput(text);
    return n === null ? undefined : n;
  }
  if (field.kind === 'tags') return parseTags(text);
  if (field.kind === 'multiline') return String(text ?? '');
  const s = String(text ?? '').trim();
  return s;
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : [];
    const y = Array.isArray(b) ? b : [];
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  const norm = (v) => (v === undefined || v === null ? '' : v);
  return norm(a) === norm(b);
}

/**
 * Diff a form against the original product → the PATCH sent to
 * products.update (only changed keys, like the web's per-field blur saves).
 * A cleared number becomes null-ish: the bridge stores {type:number,value:null}
 * when we send `null`, so cleared numbers are sent as null.
 */
export function formToPatch(form, original) {
  const patch = {};
  for (const field of EDIT_FIELDS) {
    if (!(field.key in (form || {}))) continue;
    const text = form[field.key];
    let next = formValue(field, text);
    const prev = original ? original[field.key] : undefined;
    if (field.kind === 'number' && next === undefined) {
      if (prev !== undefined && prev !== null) patch[field.key] = null;
      continue;
    }
    if (field.key === 'name' && !next) continue; // never blank the name
    if (!original) {
      if (field.kind === 'tags' ? next.length : next !== '' && next !== undefined) patch[field.key] = next;
      continue;
    }
    if (!sameValue(next, prev)) patch[field.key] = next;
  }
  return patch;
}

/** Create payload — the web create dialog's draft (only filled fields). */
export function formToCreate(form, keys = CREATE_FIELD_KEYS) {
  const subset = {};
  for (const k of keys) subset[k] = form?.[k];
  if (form?.status) subset.status = form.status;
  const out = formToPatch(subset, null);
  if (!out.status) out.status = 'active';
  return out;
}

/** Context-menu Duplicate (web: same fields, "(copy)", draft). */
export function duplicatePayload(p) {
  const out = {
    name: `${p.name} (copy)`,
    type: p.type,
    status: 'draft',
    price: p.price,
    cost: p.cost,
    description: p.description,
    image: p.image,
    category: p.category,
    tags: p.tags,
    inventory: p.inventory,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Local list reducer for write results (mirrors catalog-controller's state updates). */
export function applyProductResult(list, action) {
  const arr = list || [];
  switch (action?.type) {
    case 'created': {
      const p = normalizeProduct(action.product);
      return p ? [p, ...arr.filter((x) => x.id !== p.id)] : arr;
    }
    case 'updated': {
      const p = normalizeProduct(action.product);
      return p ? arr.map((x) => (x.id === p.id ? p : x)) : arr;
    }
    case 'patched':
      return arr.map((x) => (x.id === action.id ? { ...x, ...action.patch } : x));
    case 'deleted':
      return arr.filter((x) => x.id !== action.id);
    default:
      return arr;
  }
}

// ── Notion ──────────────────────────────────────────────────────────

export function extractNotionDbId(input) {
  const m = String(input || '').trim().match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return m ? m[1] : null;
}

/** Whether a Notion binding feeds this page (web hides "Pull from Notion" otherwise). */
export function hasProductsBinding(res, businessId) {
  const all = Array.isArray(res?.bindings) ? res.bindings : [];
  return all.some((b) => b && b.role === 'products' && (!businessId || !b.businessId || b.businessId === businessId));
}

export function summarizePull(res) {
  const refreshed = Array.isArray(res?.refreshed) ? res.refreshed : [];
  const titles = refreshed.map((r) => r.title || String(r.dbId || '').slice(0, 8)).slice(0, 3).join(', ');
  if (refreshed.length === 1) return `Pulled ${titles}`;
  return `Pulled ${refreshed.length} DB${refreshed.length === 1 ? '' : 's'}${titles ? ` (${titles}${refreshed.length > 3 ? '…' : ''})` : ''}`;
}

/** Friendly hint for notion.import.listDatabases failures (same mapping as web). */
export function notionErrorHint(err) {
  const code = err?.code || err?.cause?.code || '';
  const msg = err?.message || String(err || '');
  if (code === 'NOT_CONFIGURED') return `${msg} — Notion isn't configured. Set NOTION_API_KEY or finish the Notion wizard.`;
  if (code === 'NOTION_AUTH_FAILED' || /401/.test(msg)) return `${msg} — Notion rejected the API key.`;
  if (code === 'NOTION_FORBIDDEN' || /403/.test(msg)) return `${msg} — integration has no shared databases. Share at least one in Notion (DB, then Connections).`;
  return msg;
}

/** One commit result → plain log lines (no glyphs), condensed from the web import log. */
export function importLogLines(label, dbId, result, error) {
  if (error) return [`${label}: failed — ${error?.message || String(error)}`];
  const lines = [`${label}: binding committed`];
  const pull = result?.initialPull;
  if (pull?.skipped) lines.push('Initial pull was skipped — Notion may not be configured server-side');
  else if (Array.isArray(pull?.productsDebug)) {
    if (pull.productsDebug.length === 0) lines.push('No products binding found in pull pass');
    for (const d of pull.productsDebug) {
      if (d?.dbId !== dbId) continue;
      lines.push(d.skippedReason ? String(d.skippedReason) : `Pulled ${d.added} of ${d.pages} Notion page${d.pages === 1 ? '' : 's'}`);
    }
  } else if (typeof pull?.products === 'number') lines.push(`${pull.products} products added`);
  return lines;
}

/** Loom / YouTube links → embeddable URL (file focus preview). */
export function embedUrl(url) {
  const u = String(url || '');
  if (/loom\.com/i.test(u)) return u.replace(/\/share\//, '/embed/');
  const yt = u.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]+)/);
  if (/youtube\.com|youtu\.be/i.test(u) && yt) return `https://www.youtube.com/embed/${yt[1]}`;
  return null;
}
