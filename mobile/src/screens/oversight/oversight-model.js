/**
 * oversight-model — pure data mapping for the native Reviews page.
 *
 * Mirrors, one to one, the logic the web /reviews host runs:
 *   - "Run reviews" sub-tab   ui/src/ui/views/reviews/index.ts
 *                             + ui/src/ui/components/agent-run-review.ts
 *   - "Oversight" sub-tab     ui/src/ui/views/oversight/index.ts
 *                             + history-merge.ts + persistence.ts
 *   - verdict card            ui/src/ui/components/completion-verdict.ts
 *   - review thread           ui/src/ui/components/review-thread-view.ts
 *                             + ui/src/ui/lib/review-mesh/model.ts
 *   - proactive panel         ui/src/ui/components/proactive-oversight-panel.ts
 *
 * No React, no react-native: everything here is unit-tested in
 * src/__tests__/oversight-model.test.js. Colors are expressed as kit TONE
 * names ('success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral' |
 * 'primary') and resolved against the live theme by the screen.
 */

// ── Time ranges ────────────────────────────────────────────────────────────

export const TIME_MS = { all: 0, '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };
export const TIME_FILTERS = [
  { key: 'all', label: 'All time' },
  { key: '1h', label: 'Last hour' },
  { key: '24h', label: 'Last 24h' },
  { key: '7d', label: 'Last 7 days' },
];

export function sinceFor(time, now = Date.now()) {
  const ms = TIME_MS[time];
  return ms ? now - ms : undefined;
}

// ── Formatters ─────────────────────────────────────────────────────────────

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '—';
  const d = Math.max(0, now - ts);
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtCost(usd) {
  if (usd == null || !Number.isFinite(Number(usd))) return '';
  const n = Number(usd);
  if (n <= 0) return '';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(3)}`;
}

export function fmtClock(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '—';
  }
}

export function fmtTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  OVERSIGHT  (run spine + review overlay)
// ══════════════════════════════════════════════════════════════════════════

export const OVERSIGHT_STATUSES = ['all', 'running', 'completed', 'blocked', 'errored', 'aborted'];

export const STATUS_META = {
  running: { label: 'Running', tone: 'info', icon: 'radio-button-on' },
  completed: { label: 'Completed', tone: 'success', icon: 'checkmark-circle' },
  blocked: { label: 'Blocked', tone: 'warning', icon: 'hand-left' },
  errored: { label: 'Errored', tone: 'danger', icon: 'alert-circle' },
  aborted: { label: 'Aborted', tone: 'neutral', icon: 'stop-circle' },
};

export function statusMeta(s) {
  return STATUS_META[s] || { label: String(s || 'unknown'), tone: 'neutral', icon: 'ellipse' };
}

export const DECISION_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'sent_back', label: 'Sent back' },
  { key: 'drift', label: 'Drift detected' },
];

export function decisionTone(d) {
  switch (d) {
    case 'approved':
      return 'success';
    case 'sent_back':
      return 'danger';
    case 'drift':
      return 'warning';
    case 'pending':
      return 'warning';
    default:
      return 'accent';
  }
}

export function decisionLabel(d) {
  return d === 'approved' ? 'Approved' : d === 'sent_back' ? 'Sent back' : 'Pending';
}

export function confidenceTone(c) {
  if (c >= 0.8) return 'success';
  if (c >= 0.5) return 'warning';
  return 'danger';
}

// The server's AgentReview sends confidence as "high" | "medium" | "low" and
// filesTouched as {path, action, …} objects; the page renders 0–1 + strings.
const CONFIDENCE = { high: 0.9, medium: 0.6, low: 0.3 };

export function normalizeReviewShape(r) {
  if (!r || typeof r !== 'object') return null;
  const confidence =
    typeof r.confidence === 'number'
      ? r.confidence
      : CONFIDENCE[String(r.confidence ?? '').toLowerCase()] ?? 0.5;
  const filesTouched = Array.isArray(r.filesTouched)
    ? r.filesTouched
        .map((f) => (typeof f === 'string' ? f : f && typeof f === 'object' ? String(f.path ?? '') : ''))
        .filter(Boolean)
    : [];
  return {
    ...r,
    confidence,
    filesTouched,
    blockers: Array.isArray(r.blockers) ? r.blockers.filter((b) => typeof b === 'string') : [],
    nextSteps: Array.isArray(r.nextSteps) ? r.nextSteps.filter((b) => typeof b === 'string') : [],
    testsRun: Array.isArray(r.testsRun) ? r.testsRun : undefined,
    completion: normalizeCompletion(r.completion),
  };
}

export function normalizeCompletion(c) {
  if (!c || typeof c !== 'object') return undefined;
  const arr = (x) => (Array.isArray(x) ? x : []);
  return {
    verdict: String(c.verdict || 'UNVERIFIED'),
    state: String(c.state || ''),
    reasons: arr(c.reasons).map((x) => stripAnsi(String(x))),
    attempts: Number(c.attempts) || 0,
    screenshots: arr(c.screenshots).filter((s) => typeof s === 'string'),
    visualFiles: arr(c.visualFiles).filter((s) => typeof s === 'string'),
    evidence: arr(c.evidence)
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        kind: String(e.kind || ''),
        ref: stripAnsi(String(e.ref || '')),
        status: String(e.status || ''),
        detail: stripAnsi(String(e.detail || '')),
      })),
    resultSummary: typeof c.resultSummary === 'string' ? c.resultSummary : undefined,
    reviewedAt: Number(c.reviewedAt) || 0,
  };
}

const ERROR_STATES = new Set(['errored', 'error', 'failed', 'failure', 'timeout']);
const ABORT_STATES = new Set(['aborted', 'cancelled', 'canceled', 'killed']);
const DONE_STATES = new Set(['completed', 'complete', 'done', 'finished']);

export function normalizeStatus(rawStatus, outcome, endedAt) {
  const s = String(rawStatus || '').toLowerCase();
  const o = String(outcome?.status || '').toLowerCase();
  if (ERROR_STATES.has(o) || ERROR_STATES.has(s)) return 'errored';
  if (ABORT_STATES.has(o) || ABORT_STATES.has(s)) return 'aborted';
  if (s === 'blocked') return 'blocked';
  if (o === 'ok' || o === 'success' || DONE_STATES.has(s)) return 'completed';
  if (endedAt && endedAt > 0) return 'completed';
  return 'running';
}

// ── history-merge.ts ──

const HISTORY_STATUS = { complete: 'completed', error: 'error', timeout: 'timeout' };

export function historyRowToSubagent(h) {
  if (!h || typeof h !== 'object') return null;
  const runId = typeof h.runId === 'string' ? h.runId : '';
  const endedAt = typeof h.endedAt === 'number' ? h.endedAt : 0;
  if (!runId || !endedAt) return null;
  const startedAt = typeof h.startedAt === 'number' ? h.startedAt : undefined;
  const rawStatus = typeof h.status === 'string' ? h.status : '';
  const outcome =
    h.outcome && typeof h.outcome === 'object'
      ? h.outcome
      : typeof h.error === 'string'
        ? { status: 'error', error: h.error }
        : undefined;
  return {
    runId,
    sessionKey: typeof h.childSessionKey === 'string' ? h.childSessionKey : '',
    label: typeof h.label === 'string' ? h.label : undefined,
    task: typeof h.task === 'string' ? h.task : '',
    status: HISTORY_STATUS[rawStatus] ?? rawStatus,
    progress: rawStatus === 'complete' ? 100 : 0,
    createdAt: startedAt ?? endedAt,
    startedAt,
    endedAt,
    lastUpdateAt: endedAt,
    outcome,
    recentUpdates: [],
    filesTouchedCount: typeof h.filesTouchedCount === 'number' ? h.filesTouchedCount : undefined,
    coderBackend: typeof h.coderBackend === 'string' ? h.coderBackend : undefined,
    kanbanTaskId: typeof h.kanbanTaskId === 'string' ? h.kanbanTaskId : undefined,
    archived: true,
  };
}

/** Live rows first; archive rows appended when their runId isn't live. Newest first. */
export function mergeLiveAndHistory(live, history) {
  const liveArr = Array.isArray(live) ? live : [];
  const seen = new Set(liveArr.map((s) => s && s.runId).filter((id) => typeof id === 'string'));
  const out = [...liveArr];
  for (const h of Array.isArray(history) ? history : []) {
    const row = historyRowToSubagent(h);
    if (!row || seen.has(row.runId)) continue;
    seen.add(row.runId);
    out.push(row);
  }
  const ts = (s) =>
    (typeof s.lastUpdateAt === 'number' && s.lastUpdateAt) ||
    (typeof s.endedAt === 'number' && s.endedAt) ||
    (typeof s.createdAt === 'number' && s.createdAt) ||
    0;
  return out.sort((a, b) => ts(b) - ts(a));
}

/** subagents.list item → oversight entry. `review` is the overlay (may be undefined). */
export function projectSubagent(sub, review, now = Date.now()) {
  if (!sub || typeof sub !== 'object') return null;
  const runId = typeof sub.runId === 'string' ? sub.runId : '';
  if (!runId) return null;
  const rawStatus = typeof sub.status === 'string' ? sub.status : '';
  const outcome = sub.outcome && typeof sub.outcome === 'object' ? sub.outcome : undefined;
  const createdAt = typeof sub.createdAt === 'number' ? sub.createdAt : 0;
  const startedAt = typeof sub.startedAt === 'number' ? sub.startedAt : undefined;
  const endedAt = typeof sub.endedAt === 'number' ? sub.endedAt : undefined;
  const lastUpdateAt = typeof sub.lastUpdateAt === 'number' ? sub.lastUpdateAt : createdAt;
  const status = normalizeStatus(rawStatus, outcome, endedAt);
  const startRef = startedAt || createdAt;
  const durationMs = endedAt && startRef ? endedAt - startRef : startRef ? now - startRef : 0;
  const exitReason =
    (typeof outcome?.error === 'string' && outcome.error.trim()) ||
    (status === 'errored' || status === 'aborted' ? outcome?.status || rawStatus || undefined : undefined);
  const recentUpdates = (Array.isArray(sub.recentUpdates) ? sub.recentUpdates : []).map((u) => ({
    status: typeof u?.status === 'string' ? u.status : '',
    message: typeof u?.message === 'string' ? u.message : '',
    progress: typeof u?.progress === 'number' ? u.progress : undefined,
    timestamp: typeof u?.timestamp === 'number' ? u.timestamp : 0,
  }));
  return {
    runId,
    sessionKey: typeof sub.sessionKey === 'string' ? sub.sessionKey : '',
    label: String(sub.label || sub.task || runId),
    task: typeof sub.task === 'string' ? sub.task : '',
    status,
    rawStatus,
    progress: typeof sub.progress === 'number' ? sub.progress : status === 'completed' ? 100 : 0,
    createdAt,
    startedAt,
    endedAt,
    lastUpdateAt,
    durationMs: Math.max(0, durationMs),
    exitReason: exitReason || undefined,
    filesTouchedCount:
      typeof sub.filesTouchedCount === 'number' ? sub.filesTouchedCount : review?.filesTouched?.length ?? 0,
    coderBackend: typeof sub.coderBackend === 'string' ? sub.coderBackend : undefined,
    kanbanTaskId: typeof sub.kanbanTaskId === 'string' ? sub.kanbanTaskId : undefined,
    remote: sub.remote === true,
    nodeName: typeof sub.nodeName === 'string' ? sub.nodeName : undefined,
    archived: sub.archived === true,
    recentUpdates,
    review: review || undefined,
  };
}

/**
 * A run that only exists as a review record (aged out of both the live
 * registry and the archive) still gets a detail page — built from the review.
 */
export function entryFromReview(review) {
  if (!review || !review.runId) return null;
  const endedAt = review.completedAt || undefined;
  const status =
    review.status === 'errored' ? 'errored' : review.status === 'aborted' ? 'aborted' : 'completed';
  return {
    runId: review.runId,
    sessionKey: review.sessionKey || '',
    label: review.label || review.runId,
    task: '',
    status,
    rawStatus: review.status || '',
    progress: 100,
    createdAt: endedAt ? endedAt - (review.durationMs || 0) : 0,
    startedAt: endedAt ? endedAt - (review.durationMs || 0) : undefined,
    endedAt,
    lastUpdateAt: endedAt || 0,
    durationMs: review.durationMs || 0,
    exitReason: undefined,
    filesTouchedCount: review.filesTouched?.length ?? 0,
    coderBackend: undefined,
    kanbanTaskId: undefined,
    remote: false,
    nodeName: undefined,
    archived: true,
    recentUpdates: [],
    review,
  };
}

export function finishedAt(e) {
  return e.endedAt || e.lastUpdateAt || e.createdAt || 0;
}

/**
 * Rebuild the runId → review overlay map from a fresh server list, keeping an
 * operator's local approve/send-back when the server hasn't caught up (the
 * web's "decision keeps resetting" guard). `inflight` = runIds mid-decide.
 */
export function rebuildOverlay(prevMap, serverReviews, inflight = new Set()) {
  const localDecided = new Map();
  for (const [runId, prev] of prevMap || new Map()) {
    if ((prev.decision === 'approved' || prev.decision === 'sent_back') && prev.decidedAt) {
      localDecided.set(runId, prev);
    }
  }
  const next = new Map();
  for (const raw of serverReviews || []) {
    const r = normalizeReviewShape(raw);
    if (!r || !r.runId) continue;
    const local = localDecided.get(r.runId);
    const merged =
      local && (r.decision !== local.decision || (r.decidedAt ?? 0) < (local.decidedAt ?? 0))
        ? { ...r, decision: local.decision, decidedAt: local.decidedAt, decisionNote: local.decisionNote ?? r.decisionNote }
        : r;
    next.set(r.runId, merged);
    localDecided.delete(r.runId);
  }
  for (const [runId, prev] of localDecided) {
    if (inflight.has(runId)) next.set(runId, prev);
  }
  return next;
}

export function buildEntries(live, history, overlay, time = 'all', now = Date.now()) {
  const subs = mergeLiveAndHistory(live, history);
  let entries = subs.map((s) => projectSubagent(s, overlay?.get(s.runId), now)).filter(Boolean);
  if (time !== 'all') {
    const cutoff = now - (TIME_MS[time] || 0);
    entries = entries.filter((e) => finishedAt(e) >= cutoff);
  }
  return entries;
}

export const DEFAULT_OVERSIGHT_FILTERS = {
  status: 'all',
  decision: 'all',
  time: 'all',
  search: '',
  project: '',
  hasBlockers: false,
};

export function applyOversightFilters(entries, f = DEFAULT_OVERSIGHT_FILTERS) {
  const q = String(f.search || '').trim().toLowerCase();
  const proj = String(f.project || '').trim().toLowerCase();
  return (entries || [])
    .filter((e) => {
      if (f.status && f.status !== 'all' && e.status !== f.status) return false;
      if (f.decision && f.decision !== 'all') {
        if (f.decision === 'drift') {
          if (!e.review?.drift) return false;
        } else {
          const d = e.review?.decision ?? (e.review ? 'pending' : undefined);
          if (d !== f.decision) return false;
        }
      }
      if (
        f.hasBlockers &&
        !(e.review && e.review.blockers.length > 0) &&
        e.status !== 'errored' &&
        e.status !== 'blocked'
      )
        return false;
      if (proj) {
        const hay = `${e.kanbanTaskId ?? ''} ${e.review?.projectId ?? ''}`.toLowerCase();
        if (!hay.includes(proj)) return false;
      }
      if (q) {
        const hay = [e.label, e.task, e.review?.summary ?? '', e.runId, e.sessionKey, e.coderBackend ?? '']
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ar = a.status === 'running' ? 1 : 0;
      const br = b.status === 'running' ? 1 : 0;
      if (ar !== br) return br - ar;
      return finishedAt(b) - finishedAt(a);
    });
}

export function countActiveOversightFilters(f) {
  let n = 0;
  if (f.status !== 'all') n++;
  if (f.decision !== 'all') n++;
  if (f.time !== 'all') n++;
  if (f.hasBlockers) n++;
  if (String(f.project || '').trim()) n++;
  return n;
}

/** Clear the filters the web's "Clear filters" button clears (not time/decision). */
export function clearedOversightFilters(f) {
  return { ...f, search: '', status: 'all', hasBlockers: false, project: '' };
}

// ── persistence.ts (AsyncStorage on mobile, same snapshot shape) ──

export const PERSIST_KEY = 'oversight:v1';
const DECISION_KEYS = new Set(DECISION_FILTERS.map((d) => d.key));

export function defaultPersisted() {
  return {
    v: 1,
    filterStatus: 'all',
    filterTime: 'all',
    filterProject: '',
    filterSearch: '',
    filterHasBlockers: false,
    filterDecision: 'all',
    expandedIds: [],
    acked: [],
    lastViewedAt: 0,
    tab: 'reviews',
  };
}

export function parsePersisted(raw) {
  const base = defaultPersisted();
  let p = raw;
  try {
    if (typeof raw === 'string') p = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!p || typeof p !== 'object' || p.v !== 1) return base;
  return {
    v: 1,
    filterStatus: typeof p.filterStatus === 'string' && OVERSIGHT_STATUSES.includes(p.filterStatus) ? p.filterStatus : base.filterStatus,
    filterTime: typeof p.filterTime === 'string' && p.filterTime in TIME_MS ? p.filterTime : base.filterTime,
    filterProject: typeof p.filterProject === 'string' ? p.filterProject : '',
    filterSearch: typeof p.filterSearch === 'string' ? p.filterSearch : '',
    filterHasBlockers: typeof p.filterHasBlockers === 'boolean' ? p.filterHasBlockers : false,
    filterDecision: typeof p.filterDecision === 'string' && DECISION_KEYS.has(p.filterDecision) ? p.filterDecision : 'all',
    expandedIds: Array.isArray(p.expandedIds) ? p.expandedIds.filter((x) => typeof x === 'string') : [],
    acked: Array.isArray(p.acked)
      ? p.acked.filter(
          (pair) =>
            Array.isArray(pair) && typeof pair[0] === 'string' && Array.isArray(pair[1]) && pair[1].every((n) => typeof n === 'number'),
        )
      : [],
    lastViewedAt: typeof p.lastViewedAt === 'number' ? p.lastViewedAt : 0,
    tab: p.tab === 'oversight' || p.tab === 'reviews' ? p.tab : 'reviews',
  };
}

export function filtersFromPersisted(p) {
  return {
    status: p.filterStatus,
    decision: p.filterDecision,
    time: p.filterTime,
    search: p.filterSearch,
    project: p.filterProject,
    hasBlockers: p.filterHasBlockers,
  };
}

export function toPersisted(filters, acked, expandedIds, tab, now = Date.now()) {
  return {
    v: 1,
    filterStatus: filters.status,
    filterTime: filters.time,
    filterProject: filters.project,
    filterSearch: filters.search,
    filterHasBlockers: filters.hasBlockers,
    filterDecision: filters.decision,
    expandedIds: [...(expandedIds || [])],
    acked: Object.entries(acked || {}).map(([runId, idxs]) => [runId, [...idxs]]),
    lastViewedAt: now,
    tab,
  };
}

export function ackedFromPersisted(p) {
  const out = {};
  for (const [runId, idxs] of p.acked || []) out[runId] = idxs.slice();
  return out;
}

export function toggleAck(acked, runId, index) {
  const cur = new Set(acked?.[runId] || []);
  if (cur.has(index)) cur.delete(index);
  else cur.add(index);
  return { ...(acked || {}), [runId]: [...cur].sort((a, b) => a - b) };
}

/** Result of subagent_review_force / _decide → the updated review, or null. */
export function reviewFromResult(res) {
  if (!res || typeof res !== 'object' || Array.isArray(res)) return null;
  if (res.ok === false) return null;
  if (res.review && typeof res.review === 'object') return normalizeReviewShape(res.review);
  if (typeof res.runId === 'string') return normalizeReviewShape(res);
  return null;
}

export function rpcFailure(res, fallback) {
  if (res && typeof res === 'object' && res.ok === false) return String(res.error || fallback);
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
//  VERDICT  (completion-verdict.ts)
// ══════════════════════════════════════════════════════════════════════════

export const VERDICT_STATE_LABEL = {
  verified: 'Verified',
  unverified: 'Unverified',
  failed: 'Failed',
  stalled: 'Stalled',
  blocked: 'Blocked',
  needs_input: 'Needs input',
  needs_owner: 'Needs owner',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

/** ok → success, warn → warning, bad → danger, muted → neutral. */
export function verdictTone(stateOrVerdict) {
  switch (String(stateOrVerdict ?? '').toLowerCase()) {
    case 'verified':
    case 'accepted':
      return 'success';
    case 'failed':
    case 'rejected':
      return 'danger';
    case 'unverified':
    case 'stalled':
    case 'blocked':
    case 'needs_input':
    case 'needs_owner':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function verdictBadgeTone(verdict) {
  return verdictTone(verdict === 'VERIFIED' ? 'verified' : verdict === 'FAILED' ? 'failed' : 'unverified');
}

export function verdictSettled(c) {
  return !!c && (c.state === 'verified' || c.state === 'accepted' || c.state === 'rejected');
}

export function visibleEvidence(c) {
  return (c?.evidence || []).filter((e) => e.status !== 'skipped');
}

export function evidenceTone(status) {
  return status === 'pass' ? 'success' : status === 'fail' ? 'danger' : 'warning';
}

export function evidenceIcon(status) {
  return status === 'pass' ? 'checkmark' : status === 'fail' ? 'close' : status === 'warn' ? 'alert' : 'ellipse-outline';
}

export const VERDICT_ACTIONS = [
  { key: 'continue', label: 'Continue', busy: 'Continuing', icon: 'play-forward-outline', hint: 'Resume the same session and close the gaps', confirm: true },
  { key: 'retry', label: 'Retry', busy: 'Retrying', icon: 'refresh-outline', hint: 'Start again with the review as feedback', confirm: true },
  { key: 'accept', label: 'Accept', busy: 'Accepting', icon: 'checkmark-done-outline', hint: 'Accept as-is (operator override)', confirm: false },
  { key: 'reject', label: 'Reject', busy: 'Rejecting', icon: 'close-circle-outline', hint: 'Reject this run', confirm: false },
];

/** /api/verification/file URL (thumb=1 → cached WebP thumbnail). */
export function verificationFileUrl(origin, p, thumb = false) {
  if (/^(https?:|data:|blob:)/i.test(p)) return p;
  if (!origin) return '';
  return `${origin}/api/verification/file?path=${encodeURIComponent(p)}${thumb ? '&thumb=1' : ''}`;
}

export function baseName(p) {
  return String(p || '').split('/').pop() || String(p || '');
}

// ── review thread (review-mesh/model.ts) ──

export const THREAD_KIND_LABEL = {
  submission: 'Submission',
  challenge: 'Challenge',
  response: 'Response',
  verdict: 'Verdict',
  action: 'Reviewer action',
};

export function threadVerdictLabel(v) {
  switch (v) {
    case 'VERIFIED':
      return 'Verified';
    case 'FAILED':
      return 'Failed';
    case 'changes_needed':
      return 'Changes needed';
    case 'escalate':
      return 'Owner decision';
    default:
      return 'In review';
  }
}

export function threadVerdictTone(v) {
  switch (v) {
    case 'VERIFIED':
      return 'success';
    case 'FAILED':
    case 'changes_needed':
      return 'danger';
    case 'escalate':
      return 'accent';
    default:
      return 'neutral';
  }
}

export function messageListsFailures(m) {
  return !!(m?.evidence?.some((e) => e.status === 'fail') || m?.actions?.some((a) => a.status === 'fail'));
}

export function packetTone(m) {
  switch (m?.kind) {
    case 'submission':
      return 'primary';
    case 'challenge':
      return messageListsFailures(m) ? 'danger' : 'warning';
    case 'response':
      return 'info';
    case 'verdict':
      return threadVerdictTone(m.verdict ?? null);
    case 'action':
      return 'accent';
    default:
      return 'neutral';
  }
}

export function needsOwner(s) {
  if (!s) return false;
  return Boolean(s.escalated) || s.verdict === 'escalate' || s.state === 'needs_owner';
}

const REVIEWER_ID = 'reviewer';

export function agentDisplayName(agentId, label) {
  if (agentId === REVIEWER_ID) return 'Auditor';
  if (label) return label.length > 28 ? `${label.slice(0, 27)}…` : label;
  const parts = String(agentId || '').split(':');
  const tail = parts[parts.length - 1] || String(agentId || '');
  return tail.length > 18 ? `${tail.slice(0, 17)}…` : tail;
}

export function messageRoute(m, label) {
  const from = m.from === 'reviewer' ? 'Auditor' : agentDisplayName(m.fromAgent, label);
  const to = m.kind === 'action' ? 'self' : m.to === 'reviewer' ? 'Auditor' : agentDisplayName(m.toAgent, label);
  return { from, to };
}

export function messageChipLabel(m) {
  if (m.kind === 'verdict' && m.verdict) return threadVerdictLabel(m.verdict);
  return THREAD_KIND_LABEL[m.kind] ?? String(m.kind || 'message');
}

// Terminal colour codes leak into captured command output ("\u001b[32m").
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u009b[0-9;?]*[A-Za-z]/g;
export function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI_RE, '') : s;
}

function cleanRow(r) {
  if (!r || typeof r !== 'object') return r;
  return { ...r, ref: stripAnsi(r.ref), detail: stripAnsi(r.detail) };
}

/** review.thread.get → { summary, messages } or null; pins the latest escalation. */
export function normalizeThread(t) {
  if (!t || typeof t !== 'object' || !t.summary) return null;
  const messages = (Array.isArray(t.messages) ? t.messages : []).map((m, i) => ({
    ...m,
    id: m.id ?? `m${m.seq ?? i}`,
    title: stripAnsi(String(m.title || '')),
    text: typeof m.text === 'string' ? stripAnsi(m.text) : '',
    items: Array.isArray(m.items) ? m.items.map((x) => stripAnsi(String(x))) : [],
    evidence: Array.isArray(m.evidence) ? m.evidence.map(cleanRow) : [],
    actions: Array.isArray(m.actions) ? m.actions.map(cleanRow) : [],
    screenshots: Array.isArray(m.screenshots) ? m.screenshots.filter((s) => typeof s === 'string') : [],
  }));
  let pinned = t.summary.escalation ?? null;
  for (let i = messages.length - 1; i >= 0 && !pinned; i--) pinned = messages[i].escalation ?? null;
  return { summary: t.summary, messages, pinned };
}

export function threadHeadline(summary) {
  if (summary?.verdict) return threadVerdictLabel(summary.verdict);
  return needsOwner(summary) ? 'Owner decision' : 'In review';
}

export function threadHeadTone(summary) {
  if (summary?.verdict) return threadVerdictTone(summary.verdict);
  return needsOwner(summary) ? 'accent' : 'neutral';
}

// ══════════════════════════════════════════════════════════════════════════
//  RUN REVIEWS  (agents.reviews.* + agent-run-review.ts)
// ══════════════════════════════════════════════════════════════════════════

export const RUN_REVIEW_STATUSES = ['all', 'built', 'not_built', 'partial', 'failed', 'in_progress'];

export const RUN_STATUS_META = {
  built: { label: 'Built', tone: 'success', icon: 'checkmark-circle' },
  not_built: { label: 'Not built', tone: 'warning', icon: 'ellipse-outline' },
  partial: { label: 'Partial', tone: 'warning', icon: 'contrast-outline' },
  failed: { label: 'Failed', tone: 'danger', icon: 'close-circle' },
  in_progress: { label: 'Running', tone: 'info', icon: 'time-outline' },
};

export function runStatusMeta(s) {
  return RUN_STATUS_META[s] || { label: String(s || 'unknown'), tone: 'accent', icon: 'ellipse' };
}

export function runStatusFilterLabel(s) {
  return s === 'all' ? 'All' : runStatusMeta(s).label;
}

export function coerceRunReview(x) {
  if (!x || typeof x !== 'object') return null;
  if (!x.id && !x.runId) return null;
  return {
    id: String(x.id ?? x.runId),
    runId: String(x.runId ?? x.id),
    taskId: x.taskId,
    projectId: x.projectId,
    title: String(x.title ?? x.runId ?? 'Agent run'),
    agentKind: String(x.agentKind ?? 'agent'),
    backend: x.backend,
    model: x.model,
    status: x.status ?? (x.built ? 'built' : 'partial'),
    startedAt: Number(x.startedAt ?? 0),
    finishedAt: x.finishedAt != null ? Number(x.finishedAt) : undefined,
    durationMs: x.durationMs != null ? Number(x.durationMs) : undefined,
    summaryMarkdown: String(x.summaryMarkdown ?? ''),
    filesTouched: Array.isArray(x.filesTouched) ? x.filesTouched.filter((f) => f && typeof f === 'object') : [],
    actions: Array.isArray(x.actions) ? x.actions.filter((a) => a && typeof a === 'object') : [],
    issues: Array.isArray(x.issues) ? x.issues.filter((i) => i && typeof i === 'object') : [],
    built: x.built === true,
    buildEvidence: x.buildEvidence,
    forwardActions: Array.isArray(x.forwardActions) ? x.forwardActions.filter((a) => a && typeof a === 'object') : [],
    tokensUsed: x.tokensUsed != null ? Number(x.tokensUsed) : undefined,
    cost: x.cost != null ? Number(x.cost) : undefined,
  };
}

/** agents.reviews.list → reviews[]. */
export function runReviewsFromList(res) {
  const raw = Array.isArray(res) ? res : Array.isArray(res?.reviews) ? res.reviews : [];
  return raw.map(coerceRunReview).filter(Boolean);
}

/** agents.reviews.get / regenerateSummary → review | null. */
export function runReviewFromResult(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.ok === false) return null;
  const payload = 'review' in res ? res.review : res;
  return coerceRunReview(payload);
}

export const DEFAULT_RUN_REVIEW_FILTERS = { status: 'all', time: 'all', search: '', project: '' };

export function applyRunReviewFilters(list, f = DEFAULT_RUN_REVIEW_FILTERS, now = Date.now()) {
  const q = String(f.search || '').trim().toLowerCase();
  const proj = String(f.project || '').trim().toLowerCase();
  const cutoff = f.time === 'all' || !f.time ? 0 : now - (TIME_MS[f.time] || 0);
  return (list || [])
    .filter((r) => {
      if (f.status && f.status !== 'all' && r.status !== f.status) return false;
      if (cutoff && (r.finishedAt ?? r.startedAt ?? 0) < cutoff) return false;
      if (proj && !String(r.projectId ?? '').toLowerCase().includes(proj)) return false;
      if (q) {
        const hay = `${r.title} ${r.runId} ${r.agentKind} ${r.backend ?? ''} ${r.summaryMarkdown}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0));
}

export function severityTone(sev) {
  switch (String(sev).toLowerCase()) {
    case 'critical':
      return 'danger';
    case 'high':
    case 'medium':
    case 'warning':
      return 'warning';
    case 'low':
      return 'info';
    default:
      return 'neutral';
  }
}

export function changeKindMeta(kind) {
  switch (String(kind).toLowerCase()) {
    case 'add':
    case 'added':
    case 'create':
    case 'created':
      return { glyph: 'A', tone: 'success' };
    case 'delete':
    case 'deleted':
    case 'remove':
    case 'removed':
      return { glyph: 'D', tone: 'danger' };
    case 'rename':
    case 'renamed':
      return { glyph: 'R', tone: 'accent' };
    default:
      return { glyph: 'M', tone: 'warning' };
  }
}

/** A file row from agents.reviews: changeKind (web contract) or action (server). */
export function runFileRow(f) {
  return {
    path: String(f.path ?? ''),
    kind: changeKindMeta(f.changeKind ?? f.action ?? 'modify'),
    added: typeof f.linesAdded === 'number' && f.linesAdded > 0 ? f.linesAdded : null,
    removed: typeof f.linesRemoved === 'number' && f.linesRemoved > 0 ? f.linesRemoved : null,
  };
}

export function sortedActions(actions) {
  return [...(actions || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

/**
 * Forward action → how to dispatch it (dispatchForwardAction on web).
 *   { type: 'url', url }                      open the PR URL
 *   { type: 'rpc', method, params, missingOk } call the gateway
 *   { type: 'none' }                          unknown kind with no method
 * `fallback: 'chat'` marks kinds whose RPC is not on the gateway yet: the web
 * falls back to its event bus; mobile hands the follow-up to chat instead.
 */
export function forwardActionPlan(review, action) {
  const kind = String(action?.kind || '').toLowerCase();
  const payload = { runId: review.runId, id: review.id, ...(action?.payload || {}) };
  if ((kind === 'open_pr' || kind === 'openpr') && typeof action?.payload?.url === 'string') {
    return { type: 'url', url: action.payload.url };
  }
  const explicit = typeof action?.payload?.method === 'string' ? action.payload.method : null;
  let method = explicit;
  if (!method) {
    switch (kind) {
      case 'respawn':
        method = 'subagents.respawn';
        break;
      case 'verify':
        method = 'subagent_review_force';
        break;
      case 'open_pr':
      case 'openpr':
        method = 'agents.reviews.openPr';
        break;
      case 'followup':
      case 'follow_up':
        method = 'agents.reviews.followUp';
        break;
      default:
        method = null;
    }
  }
  if (!method) return { type: 'none' };
  const followup = kind === 'followup' || kind === 'follow_up';
  return {
    type: 'rpc',
    method,
    params: payload,
    // respawn re-runs the agent; follow-up starts new work — confirm first.
    confirm: kind === 'respawn' || followup,
    fallback: followup ? 'chat' : null,
  };
}

export function followUpDraft(review, action) {
  const text = typeof action?.payload?.text === 'string' ? action.payload.text : action?.label || '';
  return `Follow up on run ${review.runId} (${review.title}): ${text}`.trim();
}

export function isUnknownMethodError(err) {
  return /unknown method/i.test(String(err?.message || err || ''));
}

// ══════════════════════════════════════════════════════════════════════════
//  PROACTIVE OVERSIGHT PANEL  (cron jobs)
// ══════════════════════════════════════════════════════════════════════════

export const JOB_GROUP_ORDER = ['daily', 'weekly', 'monthly', 'continuous'];
export const JOB_GROUP_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', continuous: 'Continuous' };

export function isOversightJob(j) {
  return String(j?.category ?? '').startsWith('oversight:') || String(j?.name ?? '').startsWith('oversight-');
}

export function jobGroup(j) {
  const cat = String(j?.category ?? '').split(':')[1];
  if (cat) return cat;
  const s = j?.schedule || {};
  if (s.kind === 'every') return 'continuous';
  if (s.kind === 'cron' && s.expr) {
    const parts = String(s.expr).trim().split(/\s+/);
    if ((parts[2] ?? '*') !== '*') return 'monthly';
    if ((parts[4] ?? '*') !== '*') return 'weekly';
    return 'daily';
  }
  return 'other';
}

export function fmtSchedule(s) {
  if (!s) return '';
  if (s.kind === 'cron' && s.expr) return s.expr;
  if (s.kind === 'every' && s.everyMs) {
    const m = Math.round(s.everyMs / 60000);
    return m >= 60 ? `every ${Math.round(m / 60)}h` : `every ${m}m`;
  }
  return String(s.kind || '');
}

export function fmtWhen(ts, now = Date.now()) {
  if (!ts) return '—';
  const d = ts - now;
  const mins = Math.round(Math.abs(d) / 60000);
  const txt = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return d < 0 ? `${txt} ago` : `in ${txt}`;
}

export function groupOversightJobs(jobs) {
  const by = new Map();
  for (const j of jobs || []) {
    const g = jobGroup(j);
    if (!by.has(g)) by.set(g, []);
    by.get(g).push(j);
  }
  const order = [...JOB_GROUP_ORDER.filter((g) => by.has(g)), ...[...by.keys()].filter((g) => !JOB_GROUP_ORDER.includes(g))];
  return order.map((g) => ({ key: g, label: JOB_GROUP_LABEL[g] ?? g, jobs: by.get(g) }));
}

export function jobDisplayName(j) {
  return String(j?.name || '').replace(/^oversight-/, '');
}
