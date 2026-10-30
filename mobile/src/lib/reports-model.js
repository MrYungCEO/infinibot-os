/**
 * reports-model — pure helpers behind the mobile Reports library.
 *
 * Grouping (by category or date bucket), sorting, search, the "system event"
 * noise filter and research-report detection. Research detection is a port of
 * ui/src/ui/views/research/model.ts (isResearchReport + its kind/title sets) so
 * the phone and the web Research workspace agree on what a research report is.
 *
 * No React / React Native imports: unit-tested in
 * src/__tests__/reports-model.test.js.
 */

/** Report kinds that are system noise, never research (web NOISE_KINDS). */
export const NOISE_KINDS = new Set([
  'oversight_event',
  'gateway_recovery',
  'credit_burn_alert',
  'incident',
  'ceo_hourly_insights',
  'daily_summary',
  'daily_operational',
  'work_review',
]);

/** Kinds hidden by the library's "Hide system events" toggle. */
export const SYSTEM_EVENT_KINDS = new Set(['oversight_event', 'gateway_recovery', 'credit_burn_alert', 'incident']);

export const RESEARCH_KINDS = new Set([
  'research_brief',
  'competitive_analysis',
  'market_research',
  'research',
  'company_profile',
]);

export const RESEARCH_TITLE_RE =
  /\b(research|dossier|landscape|competitor|competitive|market (?:analysis|study|map|scan)|deep[- ]dive|feasibility|due diligence|investigation|study|whitepaper|benchmark)\b/i;

/** Session prefix of research-workspace runs (web RESEARCH_SESSION_PREFIX). */
export const RESEARCH_SESSION_PREFIX = 'agent:main:research-';

export function isResearchSessionKey(key) {
  return typeof key === 'string' && key.startsWith(RESEARCH_SESSION_PREFIX);
}

export function isResearchReport(r) {
  if (!r) return false;
  const kind = String(r.kind ?? '');
  if (NOISE_KINDS.has(kind)) return false;
  if (RESEARCH_KINDS.has(kind)) return true;
  if (isResearchSessionKey(r.sourceSession ?? undefined)) return true;
  if (r.category === 'research') return true;
  return RESEARCH_TITLE_RE.test(String(r.title ?? ''));
}

export function isSystemEvent(r) {
  return !!r && SYSTEM_EVENT_KINDS.has(String(r.kind ?? ''));
}

const CATEGORY_LABELS = {
  gateway_recovery: 'Gateway Recovery',
  ceo_hourly_insights: 'CEO Hourly',
  daily_summary: '24h Summary',
  daily_operational: 'Daily',
  weekly_strategic: 'Weekly',
  credit_burn_alert: 'Credit Alert',
  incident: 'Incident',
  plan: 'Plan',
  proposal: 'Proposal',
  research: 'Research',
  custom: 'Custom',
  uncategorized: 'Uncategorized',
  manual_render: 'Manual',
  'agent-output': 'Agent Output',
  oversight_event: 'Oversight Event',
};

export function titleCase(s) {
  return String(s || '')
    .replace(/[_:-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

export function categoryLabel(c) {
  if (!c) return 'Uncategorized';
  return CATEGORY_LABELS[c] ?? titleCase(c);
}

export function categoryOf(r) {
  return (r && (r.category || r.config?.category || r.kind)) || 'uncategorized';
}

export function sourceOf(r) {
  return (r && (r.sourceAgent || r.config?.sourceAgent)) || null;
}

export function timeOf(r) {
  const t = Number(r?.createdAt ?? r?.updatedAt ?? r?.renderedAt ?? 0);
  return Number.isFinite(t) ? t : 0;
}

// ── Date buckets ────────────────────────────────────────────────────

export const DATE_BUCKETS = ['Today', 'Yesterday', 'This week', 'This month', 'Older'];

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dateBucket(ms, now = Date.now()) {
  if (!ms) return 'Older';
  const today = startOfDay(now);
  const day = 24 * 60 * 60 * 1000;
  if (ms >= today) return 'Today';
  if (ms >= today - day) return 'Yesterday';
  if (ms >= today - 6 * day) return 'This week';
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (ms >= monthStart || ms >= today - 30 * day) return 'This month';
  return 'Older';
}

// ── Search / filter / sort ──────────────────────────────────────────

export function matchesSearch(r, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [r.title, r.kind, categoryOf(r), categoryLabel(categoryOf(r)), sourceOf(r) || '', r.summaryText || '', r.description || '']
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

/**
 * Filter a report list.
 * opts: { search, category ('all'|id), status ('all'|id), hideSystem (bool), researchOnly (bool) }
 */
export function filterReports(list, opts = {}) {
  const { search = '', category = 'all', status = 'all', hideSystem = false, researchOnly = false } = opts;
  return (list || []).filter((r) => {
    if (!r) return false;
    if (hideSystem && isSystemEvent(r)) return false;
    if (researchOnly && !isResearchReport(r)) return false;
    if (category && category !== 'all' && categoryOf(r) !== category) return false;
    if (status && status !== 'all' && r.status !== status) return false;
    return matchesSearch(r, search);
  });
}

/** sort: 'date' | 'title' | 'source'; dir: -1 desc, 1 asc. Stable, non-mutating. */
export function sortReports(list, sort = 'date', dir = -1) {
  const arr = (list || []).map((r, i) => [r, i]);
  arr.sort(([a, ia], [b, ib]) => {
    let cmp;
    if (sort === 'title') cmp = String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
    else if (sort === 'source') cmp = String(sourceOf(a) ?? categoryOf(a)).localeCompare(String(sourceOf(b) ?? categoryOf(b)));
    else cmp = timeOf(a) - timeOf(b);
    if (cmp === 0) cmp = timeOf(b) - timeOf(a) || ia - ib;
    else cmp *= dir;
    return cmp;
  });
  return arr.map(([r]) => r);
}

/**
 * Group an already-sorted list into sections, preserving item order inside a
 * section. mode: 'category' | 'date' | 'none'.
 * Date sections follow DATE_BUCKETS order (reversed when sorting oldest-first);
 * category sections are ordered by size, then label.
 * Returns [{ key, title, data }].
 */
export function groupReports(list, mode = 'category', { now = Date.now(), dir = -1 } = {}) {
  const items = list || [];
  if (mode === 'none') return items.length ? [{ key: 'all', title: 'All reports', data: items.slice() }] : [];
  const map = new Map();
  for (const r of items) {
    const key = mode === 'date' ? dateBucket(timeOf(r), now) : categoryOf(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  let keys = [...map.keys()];
  if (mode === 'date') {
    keys.sort((a, b) => DATE_BUCKETS.indexOf(a) - DATE_BUCKETS.indexOf(b));
    if (dir === 1) keys.reverse();
  } else {
    keys.sort((a, b) => map.get(b).length - map.get(a).length || categoryLabel(a).localeCompare(categoryLabel(b)));
  }
  return keys.map((key) => ({
    key,
    title: mode === 'date' ? key : categoryLabel(key),
    data: map.get(key),
  }));
}

/** Distinct categories in a list (plus any known ones), sorted by label. */
export function categoriesOf(list, known = []) {
  const set = new Set(known.filter(Boolean));
  for (const r of list || []) set.add(categoryOf(r));
  return [...set].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
}

/** Merge pages / sources by id (later wins). */
export function dedupeReports(...lists) {
  const byId = new Map();
  for (const l of lists) for (const r of l || []) if (r && r.id) byId.set(r.id, { ...(byId.get(r.id) || {}), ...r });
  return [...byId.values()];
}

/** File kind of a report's rendered asset. */
export function assetKind(r) {
  const p = String(r?.filePath || '').toLowerCase();
  const fmt = String(r?.originalFormat || '').toLowerCase();
  if (p.endsWith('.html') || p.endsWith('.htm') || fmt === 'html') return 'html';
  if (p.endsWith('.pdf') || fmt === 'pdf' || (!fmt && p)) return 'pdf';
  if (!p) return 'none';
  return 'other';
}

/** Unwrap an agent.tools.invoke result into the tool's JSON payload (web toolPayload). */
export function toolPayload(res) {
  const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const r = rec(rec(res).result ?? res);
  const details = rec(r.details);
  if (Object.keys(details).length) return details;
  const text = (Array.isArray(r.content) ? r.content : []).find((c) => c && c.type === 'text')?.text;
  if (typeof text === 'string') {
    try {
      return rec(JSON.parse(text));
    } catch {
      return { text };
    }
  }
  return r;
}

export function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}

/** Normalise a research-docs store record into the report-like row shape. */
export function researchDocToRow(d) {
  return {
    id: `research-doc:${d.id}`,
    docId: String(d.id),
    isResearchDoc: true,
    kind: 'research_doc',
    title: String(d.name ?? d.id),
    status: String(d.researchStatus ?? d.status ?? 'complete'),
    category: 'research',
    summaryText: d.description || d.preview || null,
    createdAt: toMs(d.createdAt) || toMs(d.updatedAt),
    updatedAt: toMs(d.updatedAt),
    tags: Array.isArray(d.tags) ? d.tags : [],
    sourceAgent: null,
    filePath: null,
  };
}

export function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function relTime(ms, now = Date.now()) {
  if (!ms) return '';
  const d = Math.max(0, now - ms);
  const min = Math.floor(d / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** Human cron (just the common shapes the report scheduler uses). */
export function describeCron(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return cron || '';
  const [m, h, dom, mon, dow] = parts;
  const hm = /^\d+$/.test(m) && /^\d+$/.test(h) ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (hm && dom === '*' && mon === '*' && dow === '*') return `Daily at ${hm}`;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (hm && dom === '*' && mon === '*' && /^\d$/.test(dow)) return `Every ${DOW[Number(dow)]} at ${hm}`;
  if (hm && dom === '*' && mon === '*' && dow === '1-5') return `Weekdays at ${hm}`;
  if (m === '0' && h === '*') return 'Hourly';
  return cron;
}
