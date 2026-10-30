/**
 * Project picker model — pure logic shared by the searchable project picker
 * (components/ProjectPicker.js), quick capture (infini/CaptureSheet.js) and the
 * idea / note / task editors.
 *
 *   normalizeProjects(raw)            kanban.projects.list payload → picker rows
 *   filterProjects(list, q, usage)    type-to-filter over ALL projects (name,
 *                                     aliases, parent, description), ranked;
 *                                     empty query → recently used first
 *   pickerRows(list, q, usage)        flat rows with section headers for a FlatList
 *   recordUsage(usage, id)            most-used / recent bookkeeping
 *   localMatchProject(text, list)     on-device fallback for project association
 *   resolveAutoProject(draft, list)   apply capture.structure's suggestion:
 *                                     preselect when confident, else only suggest
 *   suggestionLabel(s)                "Auto: KinglyVault · named it"
 */

export const AUTO_SELECT_CONFIDENCE = 0.6;
export const USAGE_KEY = '@infinibot/project-usage';
const RECENT_MAX = 6;

const STOP = new Set(
  (
    'a an and the for of to in on at by with from about into this that it its my our your is are was be ' +
    'do have has will should can need want add make new idea note task todo log project projects app site ' +
    'website page work stuff thing fix update build create remind please also just so then some more'
  ).split(' '),
);

export function normText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const compact = (s) => normText(s).replace(/ /g, '');

function recency(p) {
  const v = p?.updatedAt;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** kanban.projects.list payload (array or {projects}) → [{ id, name, parentId, parentName, description, aliases, updatedAt, status }]. */
export function normalizeProjects(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.projects) ? raw.projects : [];
  const names = new Map();
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const id = p.id != null ? String(p.id) : '';
    const name = String(p.name || p.title || '').trim();
    if (id && name) names.set(id, name);
  }
  const out = [];
  const seen = new Set();
  for (const p of list) {
    const id = p?.id != null ? String(p.id) : '';
    if (!id || seen.has(id) || !names.has(id) || p.archived === true) continue;
    seen.add(id);
    const parentId = typeof p.parentProjectId === 'string' && p.parentProjectId ? p.parentProjectId : typeof p.parentId === 'string' && p.parentId ? p.parentId : undefined;
    out.push({
      id,
      name: names.get(id),
      ...(parentId ? { parentId, parentName: names.get(parentId) } : {}),
      description: typeof p.description === 'string' ? p.description.slice(0, 240) : '',
      aliases: Array.isArray(p.aliases) ? p.aliases.filter((a) => typeof a === 'string') : [],
      updatedAt: p.updatedAt,
      status: p.status,
    });
  }
  return out;
}

/** "Parent › Child" for sub-projects. */
export function projectPath(p) {
  if (!p) return '';
  return p.parentName ? `${p.parentName} › ${p.name}` : p.name;
}

function usageScore(usage, id) {
  const u = usage?.[id];
  if (!u) return 0;
  return Math.min(12, (u.count || 0) * 2);
}

/** Search score for one project, or 0 when it doesn't match. */
export function scoreProject(p, query) {
  const q = normText(query);
  if (!q) return 1;
  const name = normText(p.name);
  const qc = q.replace(/ /g, '');
  if (name === q) return 120;
  if (name.startsWith(q)) return 100;
  if (` ${name}`.includes(` ${q}`)) return 85;
  if (name.includes(q)) return 70;
  if (qc.length >= 3 && compact(p.name).includes(qc)) return 65;
  for (const a of p.aliases || []) {
    const an = normText(a);
    if (an.startsWith(q) || ` ${an}`.includes(` ${q}`)) return 75;
    if (qc.length >= 3 && compact(a).includes(qc)) return 60;
  }
  const tokens = q.split(' ').filter(Boolean);
  const hay = `${name} ${normText((p.aliases || []).join(' '))} ${normText(p.parentName)}`;
  if (tokens.every((t) => hay.includes(t))) return 50;
  const desc = normText(p.description);
  if (desc && tokens.every((t) => desc.includes(t))) return 20;
  return 0;
}

/**
 * Filter + rank. With a query: best match first, usage as a boost, then
 * shorter names and recency. Without one: recently used first, then most
 * recently active projects, then by name.
 */
export function filterProjects(projects, query, usage = {}) {
  const list = Array.isArray(projects) ? projects : [];
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
  for (const p of list) {
    const s = scoreProject(p, q);
    if (s > 0) scored.push({ p, s: s + usageScore(usage, p.id) });
  }
  scored.sort((a, b) => b.s - a.s || a.p.name.length - b.p.name.length || recency(b.p) - recency(a.p));
  return scored.map((x) => x.p);
}

/**
 * Flat FlatList rows: [{type:'header', key, title}, {type:'project', key, project}].
 * Empty query → "Recent" (used before) then "All projects (N)"; otherwise "N matches".
 */
export function pickerRows(projects, query, usage = {}, { limit = 400 } = {}) {
  const ranked = filterProjects(projects, query, usage);
  const rows = [];
  if (!normText(query)) {
    const recent = ranked.filter((p) => usage?.[p.id]?.last).slice(0, RECENT_MAX);
    const recentIds = new Set(recent.map((p) => p.id));
    if (recent.length) {
      rows.push({ type: 'header', key: 'h-recent', title: 'Recent' });
      for (const p of recent) rows.push({ type: 'project', key: `r-${p.id}`, project: p });
    }
    const rest = ranked.filter((p) => !recentIds.has(p.id));
    rows.push({ type: 'header', key: 'h-all', title: `All projects (${projects.length})` });
    for (const p of rest.slice(0, limit)) rows.push({ type: 'project', key: `a-${p.id}`, project: p });
    return rows;
  }
  rows.push({ type: 'header', key: 'h-match', title: ranked.length === 1 ? '1 match' : `${ranked.length} matches` });
  for (const p of ranked.slice(0, limit)) rows.push({ type: 'project', key: `m-${p.id}`, project: p });
  return rows;
}

/** New usage map with `id` counted + stamped. Keeps the 200 most recent. */
export function recordUsage(usage, id, now = Date.now()) {
  if (!id) return usage || {};
  const next = { ...(usage || {}) };
  const cur = next[id] || { count: 0, last: 0 };
  next[id] = { count: (cur.count || 0) + 1, last: now };
  const ids = Object.keys(next);
  if (ids.length > 200) {
    ids.sort((a, b) => (next[b].last || 0) - (next[a].last || 0));
    for (const k of ids.slice(200)) delete next[k];
  }
  return next;
}

/**
 * On-device project association (used when the gateway can't suggest one —
 * offline, or an older gateway): an exact / spacing-variant name mention, or
 * ≥ 2 significant name words. Mirrors src/ideas/project-match.ts in spirit.
 */
export function localMatchProject(text, projects) {
  const words = normText(text).split(' ').filter(Boolean);
  if (!words.length) return null;
  const padded = ` ${words.join(' ')} `;
  const grams = new Set();
  for (let i = 0; i < words.length; i += 1) {
    let acc = '';
    for (let n = 0; n < 4 && i + n < words.length; n += 1) {
      acc += words[i + n];
      grams.add(acc);
    }
  }
  const wordSet = new Set(words);
  let best = null;
  for (const p of projects || []) {
    for (const nm of [p.name, ...(p.aliases || [])]) {
      const phrase = normText(nm);
      if (!phrase) continue;
      let c = 0;
      let reason = '';
      if (phrase.length >= 3 && padded.includes(` ${phrase} `)) {
        c = 0.9 + Math.min(0.04, phrase.length / 500);
        reason = `mentioned “${nm}”`;
      } else if (phrase.replace(/ /g, '').length >= 5 && grams.has(phrase.replace(/ /g, ''))) {
        c = 0.86;
        reason = `heard “${nm}”`;
      } else {
        const sig = phrase.split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
        const hit = sig.filter((w) => wordSet.has(w));
        if (sig.length >= 2 && hit.length === sig.length) {
          c = 0.9 + Math.min(0.04, phrase.length / 500);
          reason = `mentioned “${nm}”`;
        } else if (sig.length >= 2 && hit.length >= 2 && hit.length / sig.length >= 0.5) {
          c = 0.45 + (0.35 * hit.length) / sig.length;
          reason = `words match “${nm}”`;
        }
      }
      if (c && (!best || c > best.confidence || (c === best.confidence && p.name.length > best.name.length))) {
        best = { id: p.id, name: p.name, confidence: Math.round(c * 100) / 100, reason, source: 'match', auto: c >= AUTO_SELECT_CONFIDENCE };
      }
    }
  }
  return best;
}

/**
 * Turn capture.structure's draft into picker state. Returns
 *   { projectId, projectName, suggestion, autoSelected }
 * - a confident suggestion (auto) is preselected; a weak one is only offered;
 * - an id that isn't in the loaded project list is never selected;
 * - an older gateway (projectId but no projectSuggestion) is treated as a match;
 * - nothing from the gateway → on-device name matching on the transcript.
 */
export function resolveAutoProject(draft, projects) {
  const list = Array.isArray(projects) ? projects : [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const known = (id) => !!id && (list.length === 0 || byId.has(id));
  const nameOf = (id, fallback) => byId.get(id)?.name || fallback || id;
  let s = draft?.projectSuggestion && typeof draft.projectSuggestion === 'object' ? { ...draft.projectSuggestion } : null;
  if (s && !known(s.id)) s = null;
  if (!s && draft?.projectId && known(draft.projectId)) {
    s = { id: draft.projectId, name: nameOf(draft.projectId, draft.projectName), confidence: 0.8, reason: 'mentioned in what you said', source: 'match', auto: true };
  }
  if (!s && list.length && draft?.kind !== 'project') {
    s = localMatchProject(draft?.transcript || `${draft?.title || ''} ${draft?.body || ''}`, list);
  }
  if (!s) return { projectId: undefined, projectName: undefined, suggestion: null, autoSelected: false };
  const confidence = typeof s.confidence === 'number' ? s.confidence : 0.8;
  const auto = typeof s.auto === 'boolean' ? s.auto && confidence >= AUTO_SELECT_CONFIDENCE : confidence >= AUTO_SELECT_CONFIDENCE;
  const suggestion = { ...s, name: nameOf(s.id, s.name), confidence, auto };
  return auto
    ? { projectId: suggestion.id, projectName: suggestion.name, suggestion, autoSelected: true }
    : { projectId: undefined, projectName: undefined, suggestion, autoSelected: false };
}

/** Chip text: "Auto: KinglyVault · named it" / "Suggested: FlyPic · about filters". */
export function suggestionLabel(s, { selected = false } = {}) {
  if (!s) return '';
  const head = selected && s.auto ? 'Auto' : 'Suggested';
  return `${head}: ${s.name}${s.reason ? ` · ${s.reason}` : ''}`;
}
