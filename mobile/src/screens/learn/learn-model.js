/**
 * learn-model — pure data logic for the native Learn screen (no react-native
 * imports, unit-tested in src/__tests__/learn-model.test.js).
 *
 * Mirrors the web page 1:1:
 *   · ui/src/ui/views/learn.ts          guided Learn v2 (catalog, track page,
 *                                       quiz, certification path)
 *   · ui/src/learn/guided/catalog-store derived views (availableTracks, statusOf…)
 *   · src/learn/guided/{types,status}   trackStatus / badges / cert ladder /
 *                                       recommendTracks (ported verbatim)
 *   · ui/src/learn/guided/conditions    isListable (catalog `requires` guards)
 *   · ui/src/ui/views/learn-classic.ts  the "Classic & admin" tab (v1 stepper
 *                                       tracks, notes, legacy cert, admin)
 */

export const QUIZ_PASS_RATIO = 0.7;
export const CERT_TIERS = ['apprentice', 'practitioner', 'master'];
export const TIER_TITLE = { apprentice: 'Apprentice', practitioner: 'Practitioner', master: 'Master' };
export const TIER_BLURB = {
  apprentice: 'Every beginner core track.',
  practitioner: 'Apprentice + every intermediate core track.',
  master: 'Practitioner + every advanced core track + one plugin mastery badge.',
};
export const LEVEL_LABEL = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
export const LEVEL_TONE = { beginner: 'success', intermediate: 'info', advanced: 'warning' };
export const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'core', label: 'Core' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'progress', label: 'In progress' },
  { key: 'done', label: 'Completed' },
];
/** Prefs the gateway accepts on learn.guided.prefs.set. */
export const PREF_KEYS = ['missionsDismissed', 'touched', 'session', 'lastTrack', 'autoPopped'];

const RANK = { beginner: 1, intermediate: 2, advanced: 3 };
const TIER_RANK = { apprentice: 1, practitioner: 2, master: 3 };

export function cap(s) {
  const str = String(s || '');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function walkthroughRef(trackId, walkthroughId) {
  return `${trackId}/${walkthroughId}`;
}

/** Gateway "this build doesn't serve it" errors. */
export function isUnknownMethod(err) {
  const msg = typeof err === 'string' ? err : err?.message || '';
  return /unknown method|method not found|no handler|not implemented/i.test(msg);
}

export function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

// ── route params ──────────────────────────────────────────────────────────

/**
 * Route params → { trackId, walkthrough }. Accepts the native params and the
 * web path forms (`/learn/<trackId>?walkthrough=<id>`, `learn/<t>/<w>`) so a
 * coordinator can forward either.
 */
export function parseLearnParams(params) {
  const p = params || {};
  let trackId = typeof p.trackId === 'string' && p.trackId.trim() ? p.trackId.trim() : null;
  let walkthrough = typeof p.walkthrough === 'string' && p.walkthrough.trim() ? p.walkthrough.trim() : null;
  const path = typeof p.path === 'string' ? p.path : null;
  if (!trackId && path) {
    const [pathname, qs = ''] = path.split('?');
    const m = /(?:^|\/)learn\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?/i.exec(pathname);
    if (m) {
      trackId = m[1];
      if (!walkthrough && m[2]) walkthrough = m[2];
    }
    if (!walkthrough) {
      const wm = /(?:^|&)walkthrough=([^&]+)/.exec(qs);
      if (wm) walkthrough = decodeURIComponent(wm[1]);
    }
  }
  return { trackId, walkthrough: trackId ? walkthrough : null };
}

// ── progress ──────────────────────────────────────────────────────────────

export function emptyProgress() {
  return { userId: '_owner', walkthroughs: {}, quizzes: {}, prefs: {}, session: null };
}

export function normalizeProgress(p) {
  const src = p && typeof p === 'object' ? p : {};
  return {
    userId: src.userId || '_owner',
    walkthroughs: src.walkthroughs && typeof src.walkthroughs === 'object' ? src.walkthroughs : {},
    quizzes: src.quizzes && typeof src.quizzes === 'object' ? src.quizzes : {},
    prefs: src.prefs && typeof src.prefs === 'object' ? src.prefs : {},
    session: src.session || null,
  };
}

/** learn.guided.catalog payload → normalized catalog. */
export function normalizeCatalog(res) {
  const r = res && typeof res === 'object' ? res : {};
  const tracks = (Array.isArray(r.tracks) ? r.tracks : [])
    .filter((t) => t && typeof t.id === 'string')
    .map((t) => ({
      ...t,
      title: t.title || t.id,
      summary: t.summary || '',
      overview: t.overview || '',
      category: t.category || 'General',
      level: RANK[t.level] ? t.level : 'beginner',
      walkthroughs: (Array.isArray(t.walkthroughs) ? t.walkthroughs : []).map((w) => ({
        ...w,
        summary: w.summary || '',
        estMinutes: Number(w.estMinutes) || 0,
        steps: Array.isArray(w.steps) ? w.steps : [],
      })),
      quiz: Array.isArray(t.quiz) ? t.quiz : [],
      badge: t.badge && typeof t.badge === 'object' ? t.badge : { id: t.id, label: t.title || t.id },
    }));
  return {
    tracks,
    plugins: Array.isArray(r.plugins) ? r.plugins : [],
    missions: Array.isArray(r.missions) ? r.missions : [],
    progress: normalizeProgress(r.progress),
  };
}

/** Merge a write response ({progress}) back into state; keeps the local session. */
export function mergeProgress(current, res) {
  if (!res || !res.progress) return current;
  const next = normalizeProgress(res.progress);
  return { ...next, session: next.session ?? current?.session ?? null };
}

/** Optimistic local mirror of catalog-store localStep / recordComplete / reset. */
export function applyLocalEvent(progress, track, walkthroughId, event, stepId, done, now = Date.now()) {
  const p = normalizeProgress(progress);
  const ref = walkthroughRef(track.id, walkthroughId);
  const walkthroughs = { ...p.walkthroughs };
  const cur = walkthroughs[ref];
  if (event === 'reset') {
    delete walkthroughs[ref];
  } else if (event === 'complete') {
    const all = (track.walkthroughs.find((w) => w.id === walkthroughId)?.steps || []).map((s) => s.id);
    walkthroughs[ref] = {
      status: 'completed',
      stepId: null,
      completedSteps: [...new Set([...(cur?.completedSteps || []), ...all])],
      updatedAt: now,
      completedAt: cur?.completedAt ?? now,
    };
  } else {
    const completed = new Set(cur?.completedSteps || []);
    if (done) completed.add(stepId);
    walkthroughs[ref] = {
      status: cur?.status === 'completed' ? 'completed' : 'in_progress',
      stepId,
      completedSteps: [...completed],
      updatedAt: now,
      completedAt: cur?.completedAt ?? null,
    };
  }
  return { ...p, walkthroughs };
}

/** learn.guided.progress.update params (gateway schema). */
export function progressUpdateParams(trackId, walkthroughId, event, stepId, done) {
  const out = { trackId, walkthroughId, event };
  if (event === 'step') {
    out.stepId = stepId;
    out.done = done === true;
  }
  return out;
}

// ── status / badges / certification (ported from src/learn/guided) ────────

export function trackStatus(track, progress) {
  const core = track.walkthroughs.filter((w) => !w.requires);
  const counted = core.length > 0 ? core : track.walkthroughs;
  const total = counted.length;
  const done = counted.filter(
    (w) => progress?.walkthroughs?.[walkthroughRef(track.id, w.id)]?.status === 'completed',
  ).length;
  const hasQuiz = (track.quiz || []).length > 0;
  const quizPassed = hasQuiz ? Boolean(progress?.quizzes?.[track.id]?.passed) : true;
  const units = total + (hasQuiz ? 1 : 0);
  const got = done + (hasQuiz && quizPassed ? 1 : 0);
  return {
    trackId: track.id,
    walkthroughsDone: done,
    walkthroughsTotal: total,
    quizPassed,
    percent: units === 0 ? 0 : Math.round((got / units) * 100),
    completed: units > 0 && got === units,
  };
}

export function computeBadges(tracks, progress) {
  const out = [];
  for (const t of tracks) {
    if (!trackStatus(t, progress).completed) continue;
    out.push({
      id: t.badge?.id ?? t.id,
      label: t.badge?.label ?? t.title,
      trackId: t.id,
      ...(t.pluginId ? { pluginId: t.pluginId } : {}),
      mastery: Boolean(t.pluginId),
    });
  }
  return out;
}

export function computeCertLadder(tracks, progress) {
  const core = tracks.filter((t) => !t.pluginId && t.certRequired);
  const pluginTracks = tracks.filter((t) => t.pluginId);
  const completed = new Set(tracks.filter((t) => trackStatus(t, progress).completed).map((t) => t.id));
  const hasMastery = pluginTracks.some((t) => completed.has(t.id));
  return CERT_TIERS.map((tier) => {
    const required = core.filter((t) => (RANK[t.level] || 1) <= TIER_RANK[tier]).map((t) => t.id);
    const done = required.filter((id) => completed.has(id));
    const missing = required.filter((id) => !completed.has(id));
    const needsPluginMastery = tier === 'master' && pluginTracks.length > 0;
    const units = required.length + (needsPluginMastery ? 1 : 0);
    const got = done.length + (needsPluginMastery && hasMastery ? 1 : 0);
    return {
      tier,
      required,
      done,
      missing,
      needsPluginMastery,
      hasPluginMastery: hasMastery,
      percent: units === 0 ? 0 : Math.round((got / units) * 100),
      eligible: units > 0 && got === units,
    };
  });
}

export function recommendTracks(tracks, progress, touched, limit = 3) {
  const statuses = new Map(tracks.map((t) => [t.id, trackStatus(t, progress)]));
  const completed = (id) => statuses.get(id)?.completed ?? false;
  const incomplete = tracks.filter((t) => !completed(t.id));
  const ready = (t) => (t.prerequisites || []).every((p) => completed(p) || !statuses.has(p));
  const used = new Set(touched || []);
  const score = (t) => {
    const st = statuses.get(t.id);
    let s = 0;
    const started =
      st.percent > 0 ||
      t.walkthroughs.some((w) => progress?.walkthroughs?.[`${t.id}/${w.id}`]?.status === 'in_progress');
    if (started) s += 1000;
    const signals = t.signals || [];
    if (signals.length > 0 && signals.every((sig) => !used.has(sig))) s += 300;
    if (ready(t)) s += 200;
    s += (4 - (RANK[t.level] || 1)) * 40;
    s -= Math.min(t.order ?? 500, 999) / 10;
    return s;
  };
  return [...incomplete].sort((a, b) => score(b) - score(a)).slice(0, limit).map((t) => t.id);
}

// ── listing guards (ui/src/learn/guided/conditions.ts isListable) ─────────

export function isListable(cond, env) {
  if (!cond) return true;
  switch (cond.kind) {
    case 'pluginEnabled':
      return env.pluginEnabled(cond.plugin);
    case 'method':
      return env.hasMethod(cond.method);
    case 'surface':
      return env.hasSurface(cond.surface);
    case 'completed':
      return true;
    case 'not':
      return ['pluginEnabled', 'method', 'surface'].includes(cond.condition?.kind)
        ? !isListable(cond.condition, env)
        : true;
    case 'all':
      return (cond.conditions || []).every((c) => isListable(c, env));
    case 'any':
      return (cond.conditions || []).some((c) => isListable(c, env));
    default:
      return true;
  }
}

/**
 * The listing environment natively: the gateway catalog only carries tracks of
 * ENABLED plugins, so a plugin is "enabled" when it appears in catalog.plugins.
 * Methods / UI surfaces can't be probed from the app — treated as present
 * (the web build the tours run on is served by this same gateway).
 */
export function listEnvFor(catalog, extra = {}) {
  const ids = new Set((catalog?.plugins || []).map((p) => p.id));
  for (const id of extra.enabledPlugins || []) ids.add(id);
  return {
    pluginEnabled: (id) => ids.has(id),
    hasMethod: extra.hasMethod || (() => true),
    hasSurface: () => true,
    completed: () => true,
  };
}

/** catalog-store availableTracks(): requires-guards evaluated, empty tracks dropped. */
export function availableTracks(catalog, env = listEnvFor(catalog)) {
  return (catalog?.tracks || [])
    .filter((t) => isListable(t.requires, env))
    .map((t) => ({ ...t, walkthroughs: t.walkthroughs.filter((w) => isListable(w.requires, env)) }))
    .filter((t) => t.walkthroughs.length > 0);
}

export function trackMinutes(t) {
  if (Number(t?.estMinutes) > 0) return Number(t.estMinutes);
  const sum = (t?.walkthroughs || []).reduce((n, w) => n + (Number(w.estMinutes) || 0), 0);
  return sum > 0 ? sum : 5;
}

// ── catalog view ──────────────────────────────────────────────────────────

export function matchesQuery(t, q, plugin) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return true;
  const hay = [
    t.title, t.summary, t.category, plugin?.name || '',
    ...t.walkthroughs.flatMap((w) => [w.title, w.summary]),
  ].join(' ').toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export function passesFilter(t, filter, progress) {
  const s = trackStatus(t, progress);
  switch (filter) {
    case 'core': return !t.pluginId;
    case 'plugins': return Boolean(t.pluginId);
    case 'progress': return s.percent > 0 && !s.completed;
    case 'done': return s.completed;
    default: return true;
  }
}

/** Everything the Tracks tab renders. */
export function buildCatalogView(tracks, catalog, { filter = 'all', query = '' } = {}) {
  const progress = catalog?.progress || emptyProgress();
  const pluginsById = new Map((catalog?.plugins || []).map((p) => [p.id, p]));
  const visible = tracks.filter(
    (t) => passesFilter(t, filter, progress) && matchesQuery(t, query, t.pluginId ? pluginsById.get(t.pluginId) : undefined),
  );
  const core = visible.filter((t) => !t.pluginId);
  const groupsMap = new Map();
  for (const t of visible.filter((x) => x.pluginId)) {
    if (!groupsMap.has(t.pluginId)) groupsMap.set(t.pluginId, []);
    groupsMap.get(t.pluginId).push(t);
  }
  const pluginGroups = [...groupsMap.entries()].map(([pluginId, list]) => ({
    pluginId,
    plugin: pluginsById.get(pluginId) || null,
    name: pluginsById.get(pluginId)?.name || pluginId,
    tracks: list,
  }));
  const touched = Array.isArray(progress.prefs?.touched) ? progress.prefs.touched : [];
  const reco = recommendTracks(tracks, progress, touched, 3)
    .map((id) => tracks.find((t) => t.id === id))
    .filter(Boolean);
  const searching = String(query).trim().length > 0 || filter !== 'all';
  let emptyText = null;
  if (visible.length === 0) {
    if (String(query).trim()) emptyText = `No tracks match "${query}". Try a feature name like "goals" or a plugin like "Infinitrade".`;
    else if (tracks.length === 0) emptyText = 'No tracks yet. They appear as soon as the catalog loads.';
    else emptyText = 'Nothing here yet. Try another filter.';
  }
  return { visible, core, pluginGroups, reco: searching ? [] : reco, searching, emptyText, pluginsById };
}

export function heroStats(tracks, progress) {
  const statuses = tracks.map((t) => trackStatus(t, progress));
  const ladder = computeCertLadder(tracks, progress);
  const tier = [...ladder].reverse().find((r) => r.eligible)?.tier || null;
  const inProgress = tracks.find((t) => {
    const s = trackStatus(t, progress);
    return s.percent > 0 && !s.completed;
  }) || null;
  return {
    tracksDone: statuses.filter((s) => s.completed).length,
    tracksTotal: tracks.length,
    walkthroughsDone: statuses.reduce((n, s) => n + s.walkthroughsDone, 0),
    walkthroughsTotal: statuses.reduce((n, s) => n + s.walkthroughsTotal, 0),
    badges: computeBadges(tracks, progress).length,
    tier,
    tierLabel: tier ? TIER_TITLE[tier] : '—',
    inProgress,
  };
}

/** Day-1 missions strip (starter missions only); null when hidden / empty. */
export function missionItems(tracks, catalog) {
  const progress = catalog?.progress || emptyProgress();
  if (progress.prefs?.missionsDismissed) return null;
  const items = (catalog?.missions || [])
    .filter((m) => m && m.starter && typeof m.walkthrough === 'string')
    .map((m) => {
      const [tid, wid] = m.walkthrough.split('/');
      const t = tracks.find((x) => x.id === tid);
      const w = t?.walkthroughs.find((x) => x.id === wid);
      if (!t || !w) return null;
      return { track: t, walkthrough: w, done: progress.walkthroughs[walkthroughRef(t.id, w.id)]?.status === 'completed' };
    })
    .filter(Boolean);
  if (!items.length) return null;
  const left = items.filter((i) => !i.done).length;
  return {
    items,
    left,
    subtitle: left ? `${left} of ${items.length} left — a few minutes each` : 'All done. Nice work.',
  };
}

export function monogramText(plugin, fallbackId) {
  if (plugin?.monogram) return String(plugin.monogram).slice(0, 3);
  return String(plugin?.name || fallbackId || '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Plugin accent color from the catalog (dark palette), or null → theme primary. */
export function pluginAccent(plugin) {
  const a = plugin?.accent;
  if (!a) return null;
  if (typeof a === 'string') return a;
  return a.dark || a.light || null;
}

// ── track page ────────────────────────────────────────────────────────────

export function trackCta(status) {
  return status.completed ? 'Replay' : status.percent > 0 ? 'Continue' : 'Start track';
}

/** The walkthrough "Start track" opens: first unfinished (prereq order), else the first. */
export function nextWalkthrough(track, progress) {
  const list = track.walkthroughs;
  const inProg = list.find((w) => progress?.walkthroughs?.[walkthroughRef(track.id, w.id)]?.status === 'in_progress');
  if (inProg) return inProg;
  const todo = list.find((w) => progress?.walkthroughs?.[walkthroughRef(track.id, w.id)]?.status !== 'completed');
  return todo || list[0] || null;
}

export function prerequisiteTracks(track, tracks) {
  return (track.prerequisites || []).map((id) => tracks.find((t) => t.id === id)).filter(Boolean);
}

export function badgeCaption(track, status) {
  if (status.completed) return 'Earned';
  return `Finish ${track.walkthroughs.length} walkthroughs${track.quiz.length ? ' + the check' : ''}`;
}

export function walkthroughRow(track, w, progress) {
  const p = progress?.walkthroughs?.[walkthroughRef(track.id, w.id)];
  const done = p?.status === 'completed';
  const started = p?.status === 'in_progress';
  const prereqMissing = (w.prerequisites || []).filter((ref) => {
    const full = ref.includes('/') ? ref : walkthroughRef(track.id, ref);
    return progress?.walkthroughs?.[full]?.status !== 'completed';
  });
  return {
    id: w.id,
    done,
    started,
    stepId: p?.stepId || null,
    completedSteps: p?.completedSteps || [],
    risky: w.steps.some((s) => s.practice),
    bonus: Boolean(w.requires),
    prereqMissing,
    ctaLabel: done ? 'Replay' : started ? 'Resume' : 'Start',
    canReset: done || started,
  };
}

function describeTarget(target) {
  return target ? 'highlights a control on the page' : null;
}

/** What a step's action asks the user to do on the web. */
export function describeAction(action) {
  if (!action) return null;
  switch (action.kind) {
    case 'click': return 'click the highlighted control';
    case 'input': return action.match ? `type something containing "${action.match}"` : 'type into the highlighted field';
    case 'toggle': return 'flip the highlighted toggle';
    case 'navigate': return `open ${action.path}`;
    default: return null;
  }
}

/**
 * How a guided step maps to the phone. Tours spotlight web DOM elements, so
 * any step with a target / action / live check only fully runs in the web app
 * (parity gap — native shows it as a readable step and lets you mark it done).
 */
export function stepParity(step) {
  const parts = [];
  if (step.route) parts.push(`opens ${step.route}`);
  const tgt = describeTarget(step.target);
  if (tgt) parts.push(tgt);
  const act = describeAction(step.action);
  if (act) parts.push(`waits for you to ${act}`);
  if (step.check) parts.push(step.checkHint ? `checks: ${step.checkHint.replace(/…$/, '')}` : 'checks the app state before moving on');
  const webOnly = Boolean(step.target || step.action || step.check);
  return {
    webOnly,
    note: parts.length ? `On the web this step ${parts.join(', ')}.` : null,
    parityNote: webOnly ? 'Interactive on the web app only — read it here, try it on the web, then mark it done.' : null,
  };
}

/** Steps of a walkthrough with done / current flags for the native step list. */
export function walkthroughSteps(track, w, progress) {
  const p = progress?.walkthroughs?.[walkthroughRef(track.id, w.id)];
  const done = new Set(p?.completedSteps || []);
  const allDone = p?.status === 'completed';
  const current = allDone ? null : p?.stepId || w.steps.find((s) => !done.has(s.id))?.id || w.steps[0]?.id || null;
  return w.steps.map((s, i) => ({
    ...s,
    index: i,
    done: allDone || done.has(s.id),
    current: s.id === current,
    ...stepParity(s),
  }));
}

/** Web route that runs the real interactive tour for a walkthrough. */
export function webTourPath(trackId, walkthroughId) {
  return `/learn/${encodeURIComponent(trackId)}${walkthroughId ? `?walkthrough=${encodeURIComponent(walkthroughId)}` : ''}`;
}

export function deepLinkFor(trackId, walkthroughId) {
  return `infinibot://learn/${trackId}${walkthroughId ? `/${walkthroughId}` : ''}`;
}

// ── quiz ──────────────────────────────────────────────────────────────────

export function quizAllAnswered(track, answers) {
  return track.quiz.length > 0 && track.quiz.every((_, i) => typeof (answers || [])[i] === 'number');
}

export function quizHeader(track, best) {
  if (best) return `Best: ${best.score}/${best.total}${best.passed ? ' · passed' : ''}`;
  return `${track.quiz.length} questions · 70% to pass`;
}

export function quizResultLine(result) {
  if (!result) return null;
  return `${result.score}/${result.total} — ${result.passed ? 'passed' : '70% needed, try again'}`;
}

export function setAnswer(answers, qi, oi) {
  const next = [...(answers || [])];
  next[qi] = oi;
  return next;
}

// ── certification tab ─────────────────────────────────────────────────────

export function certView(tracks, progress, source) {
  const ladder = computeCertLadder(tracks, progress);
  const earned = computeBadges(tracks, progress);
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const rungs = ladder.map((r) => ({
    ...r,
    title: TIER_TITLE[r.tier],
    blurb: TIER_BLURB[r.tier],
    items: [
      ...r.required.map((id) => ({ id, title: byId.get(id)?.title || id, done: r.done.includes(id), trackId: id })),
      ...(r.needsPluginMastery ? [{ id: '_mastery', title: 'Any plugin mastery badge', done: r.hasPluginMastery, trackId: null }] : []),
    ],
    canView: r.eligible && source === 'gateway',
  }));
  const mastery = tracks
    .filter((t) => t.pluginId)
    .map((t) => ({ track: t, earned: earned.some((b) => b.trackId === t.id) }));
  return { rungs, mastery };
}

/**
 * Prepare the gateway certificate SVG for react-native-svg's SvgXml: drop the
 * fixed width/height so it scales to the container, and collapse CSS font
 * stacks (RN-svg passes font-family verbatim to the platform) to one family.
 */
export function prepareCertSvg(svg) {
  if (typeof svg !== 'string' || !svg.includes('<svg')) return null;
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<svg\b[^>]*?)\s+width="[^"]*"/, '$1')
    .replace(/(<svg\b[^>]*?)\s+height="[^"]*"/, '$1')
    .replace(/font-family="([^"]*)"/g, (_m, stack) => {
      const s = stack.toLowerCase();
      const fam = s.includes('mono') ? 'monospace' : s.includes('serif') && !s.includes('sans-serif') ? 'serif' : 'sans-serif';
      return `font-family="${fam}"`;
    });
}

export function certFileName(tier, displayName) {
  return `infinibot-${tier}-${String(displayName || 'infinibot-operator').replace(/[^a-zA-Z0-9]/g, '_')}.svg`;
}

// ── Classic & admin tab (learn.* v1) ──────────────────────────────────────

export const CLASSIC_TABS = [
  { key: 'my-tracks', label: 'My Tracks' },
  { key: 'library', label: 'Library' },
  { key: 'certification', label: 'Certification' },
  { key: 'admin-users', label: 'All Users', admin: true },
  { key: 'author', label: 'Author', admin: true },
];

export function classicTabs(isAdmin) {
  return CLASSIC_TABS.filter((t) => !t.admin || isAdmin);
}

/** users.me → admin (implicit admin while no users exist). */
export function isAdminFromMe(me) {
  if (!me) return false;
  if (me.implicitAdmin) return true;
  return me.user?.role === 'admin';
}

export function classicMyTracks(tracks) {
  return (tracks || [])
    .filter((t) => t.progress != null)
    .slice()
    .sort((a, b) => (a.percent === 100 ? 1 : 0) - (b.percent === 100 ? 1 : 0) || (a.order ?? 0) - (b.order ?? 0));
}

export function classicLibrary(tracks) {
  const byCat = new Map();
  for (const t of tracks || []) {
    const cat = t.category || 'General';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(t);
  }
  return [...byCat.entries()].map(([category, list]) => ({ category, tracks: list }));
}

/** The classic stepper for an opened track. */
export function classicStepper(track, progress, currentStepId) {
  const steps = track?.steps || [];
  const step = steps.find((s) => s.id === currentStepId) || steps[0] || null;
  const idx = step ? steps.findIndex((s) => s.id === step.id) : -1;
  const completed = new Set(progress?.completedSteps || []);
  const isStepComplete = step ? completed.has(step.id) : false;
  const isLast = idx === steps.length - 1;
  return {
    step,
    idx,
    isFirst: idx <= 0,
    isLast,
    prevId: idx > 0 ? steps[idx - 1].id : null,
    nextId: idx >= 0 && idx < steps.length - 1 ? steps[idx + 1].id : null,
    completeLabel: isStepComplete ? 'Re-mark complete' : isLast ? 'Finish' : 'Mark complete',
    rail: steps.map((s, i) => ({ id: s.id, title: s.title, n: i + 1, estMinutes: s.estMinutes, done: completed.has(s.id), active: s.id === step?.id })),
    footer: progress?.completedAt
      ? 'Track complete'
      : progress
        ? `${(progress.completedSteps || []).length}/${steps.length} done`
        : 'Mark a step complete to start',
    trackComplete: Boolean(progress?.completedAt),
  };
}

/** A classic step CTA → where it goes in the app. */
export function stepCtaTarget(cta) {
  if (!cta) return null;
  if (cta.tab) return { kind: 'web', path: `/${String(cta.tab).replace(/^\/+/, '')}`, label: cta.label };
  if (cta.url) {
    if (/^https?:\/\//i.test(cta.url)) return { kind: 'url', url: cta.url, label: cta.label };
    return { kind: 'web', path: cta.url.startsWith('/') ? cta.url : `/${cta.url}`, label: cta.label };
  }
  return null;
}

export function classicEligibilityPill(e) {
  if (e.awarded) return { label: 'Awarded', tone: 'success' };
  if (e.percent === 100) return { label: 'Ready to mint', tone: 'success' };
  return { label: `${e.percent}%`, tone: 'neutral' };
}

export function newTrackTemplate() {
  return {
    id: 'my-track',
    title: 'My new track',
    description: 'What this track teaches',
    audience: 'all',
    order: 100,
    category: 'Custom',
    steps: [{ id: 'step-1', title: 'First step', body: 'Markdown body here.', estMinutes: 1 }],
  };
}

/** Author tab: pretty JSON for a classic track (summary fields stripped). */
export function authorDraftFor(track) {
  if (!track) return '';
  const { progress: _p, totalSteps: _t, completedCount: _c, percent: _pc, ...rest } = track;
  return JSON.stringify(rest, null, 2);
}

/** Validate the Author JSON like the web: needs { id, steps[] }. */
export function parseAuthorDraft(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch (e) {
    return { ok: false, error: e?.message || 'Invalid JSON' };
  }
  if (!parsed || typeof parsed.id !== 'string' || !parsed.id || !Array.isArray(parsed.steps)) {
    return { ok: false, error: 'Track JSON needs at least { id, steps[] }' };
  }
  return { ok: true, track: parsed };
}

export function fmtDate(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return '';
  }
}
