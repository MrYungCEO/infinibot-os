/**
 * Client picker model — pure logic for components/ClientPicker.js, quick
 * capture and the idea / note / task editors. The CRM twin of
 * project-picker-model.js (same ranking, usage memory and auto rules).
 *
 *   normalizeClients(raw)          capture.clients / clients.list payload → rows
 *   filterClients(list, q, usage)  search name / company / email / about; empty
 *                                  query → recently used, then recently active
 *   clientRows(list, q, usage)     flat FlatList rows with section headers
 *   resolveAutoClient(draft, list) capture.structure's clientSuggestion →
 *                                  preselect when confident, else only suggest;
 *                                  never an id that isn't in the list
 *   clientSuggestionLabel(s)       "Auto: Gengu · client of “Dino ride app”"
 */
import { AUTO_SELECT_CONFIDENCE, localMatchProject, normText, recordUsage } from './project-picker-model';

export { recordUsage };
export const CLIENT_USAGE_KEY = '@infinibot/client-usage';
const RECENT_MAX = 6;

const compact = (s) => normText(s).replace(/ /g, '');

function recency(c) {
  const v = c?.updatedAt;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/**
 * capture.clients ({clients:[{id,name,aliases,email,status,about}]}) or the
 * older clients.list / business.clients.list shapes → picker rows.
 */
export function normalizeClients(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.clients) ? raw.clients : [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const id = c.id != null ? String(c.id) : '';
    const data = c.data && typeof c.data === 'object' ? c.data : {};
    const name = String(c.name || data.Name || '').replace(/\s+/g, ' ').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const aliases = new Set(Array.isArray(c.aliases) ? c.aliases.filter((a) => typeof a === 'string' && a.trim()) : []);
    for (const v of [c.legalName, data.Company]) if (typeof v === 'string' && v.trim() && v.trim() !== name) aliases.add(v.trim());
    const email = [c.email, c.billingEmail, data.Email].find((v) => typeof v === 'string' && v.includes('@'));
    out.push({
      id,
      name,
      aliases: [...aliases],
      ...(email ? { email } : {}),
      status: c.status || c.pipelineStatusLabel || undefined,
      about: typeof c.about === 'string' ? c.about : '',
      ...(c.notionPageId || c.notion_page_id ? { notionPageId: c.notionPageId || c.notion_page_id } : {}),
      updatedAt: c.updatedAt ?? c.updated_at,
    });
  }
  return out;
}

/** Search score for one client, or 0. */
export function scoreClient(c, query) {
  const q = normText(query);
  if (!q) return 1;
  const name = normText(c.name);
  const qc = q.replace(/ /g, '');
  if (name === q) return 120;
  if (name.startsWith(q)) return 100;
  if (` ${name}`.includes(` ${q}`)) return 85;
  if (name.includes(q)) return 70;
  if (qc.length >= 3 && compact(c.name).includes(qc)) return 65;
  for (const a of c.aliases || []) {
    const an = normText(a);
    if (an.startsWith(q) || ` ${an}`.includes(` ${q}`)) return 75;
    if (qc.length >= 3 && compact(a).includes(qc)) return 60;
  }
  if (c.email && c.email.toLowerCase().includes(query.trim().toLowerCase())) return 55;
  const tokens = q.split(' ').filter(Boolean);
  const hay = `${name} ${normText((c.aliases || []).join(' '))}`;
  if (tokens.every((t) => hay.includes(t))) return 50;
  const about = normText(`${c.about || ''} ${c.status || ''}`);
  if (about && tokens.every((t) => about.includes(t))) return 20;
  return 0;
}

export function filterClients(clients, query, usage = {}) {
  const list = Array.isArray(clients) ? clients : [];
  const q = normText(query);
  if (!q) {
    return [...list].sort((a, b) => {
      const ua = usage?.[a.id]?.last || 0;
      const ub = usage?.[b.id]?.last || 0;
      if (ua !== ub) return ub - ua;
      const r = recency(b) - recency(a);
      if (r) return r;
      return a.name.localeCompare(b.name);
    });
  }
  const scored = [];
  for (const c of list) {
    const s = scoreClient(c, query);
    if (s > 0) scored.push({ c, s: s + Math.min(12, (usage?.[c.id]?.count || 0) * 2) });
  }
  scored.sort((a, b) => b.s - a.s || a.c.name.length - b.c.name.length || recency(b.c) - recency(a.c));
  return scored.map((x) => x.c);
}

export function clientRows(clients, query, usage = {}, { limit = 400 } = {}) {
  const ranked = filterClients(clients, query, usage);
  const rows = [];
  if (!normText(query)) {
    const recent = ranked.filter((c) => usage?.[c.id]?.last).slice(0, RECENT_MAX);
    const recentIds = new Set(recent.map((c) => c.id));
    if (recent.length) {
      rows.push({ type: 'header', key: 'h-recent', title: 'Recent' });
      for (const c of recent) rows.push({ type: 'client', key: `r-${c.id}`, client: c });
    }
    rows.push({ type: 'header', key: 'h-all', title: `All clients (${clients.length})` });
    for (const c of ranked.filter((x) => !recentIds.has(x.id)).slice(0, limit)) rows.push({ type: 'client', key: `a-${c.id}`, client: c });
    return rows;
  }
  rows.push({ type: 'header', key: 'h-match', title: ranked.length === 1 ? '1 match' : `${ranked.length} matches` });
  for (const c of ranked.slice(0, limit)) rows.push({ type: 'client', key: `m-${c.id}`, client: c });
  return rows;
}

/** The client a row refers to, by agency id or Notion page id (tasks' "Customer" relation). */
export function findClient(clients, ref) {
  if (!ref) return null;
  const flat = String(ref).replace(/-/g, '');
  return (clients || []).find((c) => c.id === ref || (c.notionPageId && c.notionPageId.replace(/-/g, '') === flat)) || null;
}

/**
 * capture.structure's draft → client picker state:
 *   { clientId, clientName, suggestion, autoSelected }
 * Confident (auto) → preselected; weak → offered; unknown ids → dropped;
 * nothing from the gateway → on-device name match on the transcript.
 */
export function resolveAutoClient(draft, clients) {
  const list = Array.isArray(clients) ? clients : [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const known = (id) => !!id && (list.length === 0 || byId.has(id));
  let s = draft?.clientSuggestion && typeof draft.clientSuggestion === 'object' ? { ...draft.clientSuggestion } : null;
  if (s && !known(s.id)) s = null;
  if (!s && draft?.clientId && known(draft.clientId)) {
    s = { id: draft.clientId, name: byId.get(draft.clientId)?.name || draft.clientName || draft.clientId, confidence: 0.8, reason: 'mentioned in what you said', source: 'match', auto: true };
  }
  if (!s && list.length) {
    s = localMatchProject(draft?.transcript || `${draft?.title || ''} ${draft?.body || ''}`, list);
  }
  if (!s) return { clientId: undefined, clientName: undefined, suggestion: null, autoSelected: false };
  const confidence = typeof s.confidence === 'number' ? s.confidence : 0.8;
  const auto = typeof s.auto === 'boolean' ? s.auto && confidence >= AUTO_SELECT_CONFIDENCE : confidence >= AUTO_SELECT_CONFIDENCE;
  const suggestion = { ...s, name: byId.get(s.id)?.name || s.name || s.id, confidence, auto };
  return auto
    ? { clientId: suggestion.id, clientName: suggestion.name, suggestion, autoSelected: true }
    : { clientId: undefined, clientName: undefined, suggestion, autoSelected: false };
}

/** "Auto: Gengu · named the client" / "Suggested: Alan · words match". */
export function clientSuggestionLabel(s, { selected = false } = {}) {
  if (!s) return '';
  return `${selected && s.auto ? 'Auto' : 'Suggested'}: ${s.name}${s.reason ? ` · ${s.reason}` : ''}`;
}
