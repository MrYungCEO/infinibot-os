/**
 * ProactiveSection — Proactive Overhaul v2 surface (mobile).
 *
 * Mobile parity for the web <proactive-panel>. Reads the SAME `proactive.state`
 * gateway RPC and drives the same `proactive.*` mutations, so the commitment +
 * drift model is identical across devices (the whole point of the gateway).
 *
 *   1. "Where was I?" re-entry anchor (idle + while-away + resume)
 *   2. Active commitment card (timer + drift ribbon + break/complete)
 *      — or the commit flow (top-3 candidates + reject→custom)
 *   3. Drift radar (ranked focus projects, park/promote)
 *
 * Self-contained: takes only `gateway`. Styling matches the dashboard cards
 * (theme tokens, never raw hex).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, FONT_FAMILY } from '../constants/theme';
import { withAlpha } from '../theme/color-utils';
import { openDeepLink } from '../navigation/deep-link-dispatcher';

const DURATIONS = [25, 45, 90];

// ── DRIFT RADAR data model (kanban-sourced) ──────────────────────────────────
// The radar lists real kanban PROJECTS that are actively in progress, each with
// its active tasks as an expandable sub-view — NOT the proactive engine's drift
// rows (which surfaced stale/wrong "focus" entries, e.g. "2 other tasks").
// Sourced live from kanban.projects.list + kanban.tasks.list (both served
// without a gateway restart).
const RADAR_PROJECT_STATUSES = new Set(['In progress', 'Updating', 'Reviewing']);
const RADAR_TASK_STATUSES = new Set(['in_progress', 'review']);
// in_progress sorts above review inside a project.
const TASK_STATUS_ORDER = { in_progress: 0, review: 1 };

function taskStatusColor(st) {
  switch (st) {
    case 'in_progress': return COLORS.success;
    case 'review': return COLORS.warning;
    default: return COLORS.textMuted;
  }
}
function taskStatusLabel(st) {
  return st === 'in_progress' ? 'in progress' : st;
}

// Build the radar groups from raw kanban projects + tasks. Pure so it's easy to
// reason about: filter projects to the active statuses, attach their active
// tasks (in_progress + review), sort projects freshest-first.
function buildRadarGroups(projects, tasks) {
  const tasksByProject = new Map();
  for (const t of tasks || []) {
    if (!t || !RADAR_TASK_STATUSES.has(t.status)) continue;
    const pid = t.projectId;
    if (!pid) continue;
    if (!tasksByProject.has(pid)) tasksByProject.set(pid, []);
    tasksByProject.get(pid).push({ id: t.id, title: t.title || '(untitled task)', status: t.status });
  }
  const groups = [];
  for (const p of projects || []) {
    if (!p || !RADAR_PROJECT_STATUSES.has(p.status)) continue;
    const rows = (tasksByProject.get(p.id) || []).sort(
      (a, b) => (TASK_STATUS_ORDER[a.status] ?? 9) - (TASK_STATUS_ORDER[b.status] ?? 9),
    );
    groups.push({
      id: p.id,
      name: p.name || p.id,
      status: p.status,
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
      tasks: rows,
    });
  }
  groups.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

// ── Signals pipeline ─────────────────────────────────────────────────────────
// A module-level ring buffer fed by EXISTING live gateway WS events (no new RPC,
// so no gateway restart). The panel subscribes once, normalizes each event into
// a Signal, and renders the most-recent entries. Producers wired today:
//   1. subagent.complete          → a sub-agent run finished (success)
//   2. subagent.error / .timeout  → a sub-agent run failed / timed out (warn/critical)
//   3. kanban:task:completed      → a task moved to done (kanban transition)
//   4. proactive.updated/.event   → drift / commitment transitions on focus work
const SIGNALS_CAP = 50;

class SignalsStore {
  constructor() {
    this.items = [];
    this.seen = new Set();
    this.subs = new Set();
  }
  // Idempotent append; newest-first, bounded to SIGNALS_CAP.
  add(sig) {
    if (!sig || !sig.id || this.seen.has(sig.id)) return;
    this.seen.add(sig.id);
    this.items = [sig, ...this.items].slice(0, SIGNALS_CAP);
    if (this.items.length === SIGNALS_CAP) {
      // Keep `seen` from growing unbounded relative to the buffer.
      const live = new Set(this.items.map((s) => s.id));
      this.seen = live;
    }
    this.emit();
  }
  list() { return this.items; }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit() { for (const fn of this.subs) { try { fn(); } catch { /* keep others alive */ } } }
}
// Singleton so signals survive panel re-mounts (tab switches) and are shared.
const signalsStore = new SignalsStore();

function shortText(v, max = 90) {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

// Normalize a raw gateway event into a Signal (or null to ignore it). Defensive
// about payload shape — these events are shared with other consumers.
function normalizeSignal(event, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const ts = typeof p.ts === 'number' ? p.ts : Date.now();
  switch (event) {
    case 'subagent.complete': {
      const id = `sa:${p.runId || p.sessionKey || ts}:done`;
      const label = p.label || p.task || 'Sub-agent';
      return { id, ts, severity: 'success', kind: 'agent',
        title: `Sub-agent finished · ${shortText(label, 48)}`,
        detail: shortText(p.task || p.coderBackend || '') };
    }
    case 'subagent.error':
    case 'subagent.timeout': {
      const timedOut = event === 'subagent.timeout';
      const id = `sa:${p.runId || p.sessionKey || ts}:${timedOut ? 'timeout' : 'error'}`;
      const label = p.label || p.task || 'Sub-agent';
      return { id, ts, severity: timedOut ? 'warn' : 'critical', kind: 'agent',
        title: `Sub-agent ${timedOut ? 'timed out' : 'failed'} · ${shortText(label, 44)}`,
        detail: shortText(p.outcome?.error || p.error || p.task || '') };
    }
    case 'kanban:task:completed': {
      const title = p.title || p.taskTitle || p.task || 'A task';
      const id = `kb:${p.id || p.taskId || `${title}:${ts}`}`;
      return { id, ts, severity: 'info', kind: 'kanban',
        title: `Task completed · ${shortText(title, 52)}`,
        detail: shortText(p.projectName || p.project || '') };
    }
    case 'proactive.updated':
    case 'proactive.event': {
      const inner = p.event && typeof p.event === 'object' ? p.event : p;
      const kind = inner.kind || inner.type || '';
      // Overlays that point somewhere (event.link / an `open` action) are
      // always worth a row — tapping it opens the target (deep link).
      const openAction = Array.isArray(inner.actions) ? inner.actions.find((x) => x?.kind === 'open') : null;
      const link = inner.link?.deepLink || inner.deepLink || openAction?.payload?.href || openAction?.payload?.target || null;
      // Only surface drift-relevant transitions as signals; routine refreshes
      // would spam the feed.
      const drift = /drift|stale|cold|block/i.test(`${kind} ${inner.severity || ''} ${inner.title || ''}`);
      if (!drift && !link) return null;
      const id = `pa:${inner.id || kind || ts}:${ts}`;
      const sev = /hard|block|cold/i.test(kind) ? 'warn' : 'info';
      return { id, ts, severity: sev, kind: drift ? 'drift' : 'overlay', link,
        title: shortText(inner.title || `Drift signal · ${kind || 'focus'}`, 56),
        detail: shortText(inner.detail || inner.body || inner.rationale || inner.projectName || '') };
    }
    default:
      return null;
  }
}

function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function signalColor(sev) {
  switch (sev) {
    case 'success': return COLORS.success;
    case 'warn': return COLORS.warning;
    case 'critical': return COLORS.error;
    default: return COLORS.info;
  }
}

function stateColor(st) {
  switch (st) {
    case 'active': return COLORS.success;
    case 'watch': return COLORS.info;
    case 'drifting': return COLORS.warning;
    default: return COLORS.textMuted; // cold
  }
}

function fmtMin(m) {
  if (m == null) return '';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function ProactiveSection({ gateway }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [durById, setDurById] = useState({});
  const [showCustom, setShowCustom] = useState(false);
  const [customTitle, setCustomTitle] = useState('');
  const [showBreak, setShowBreak] = useState(false);
  const [breakReason, setBreakReason] = useState('');
  // Per-row: locally-hidden Rejected rows, open Schedule popovers, and the
  // `${taskId}:${action}` tag of the in-flight handler (for spinner text).
  const [rejected, setRejected] = useState({});
  const [scheduleOpen, setScheduleOpen] = useState({});
  const [pending, setPending] = useState(null);
  // Tasks just marked done via Finish (optimistic hide until next state refresh).
  const [completed, setCompleted] = useState({});
  // Transient error line for a failed kanban mutation; cleared on next action.
  const [errorMsg, setErrorMsg] = useState('');
  // DRIFT RADAR: real kanban in_progress projects + their active tasks.
  const [radarGroups, setRadarGroups] = useState([]);
  // Per-project expand state for the task sub-view (default expanded).
  const [collapsed, setCollapsed] = useState({});
  // Signals feed mirrored from the module-level store.
  const [signals, setSignals] = useState(() => signalsStore.list());

  // Commit flow only ever shows this many; the engine sends a deeper pool so a
  // dismissed/finished row refills from the backlog without dropping below it.
  const VISIBLE = 3;

  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';
  const subscribeEvent = gateway?.subscribeEvent;

  const refresh = useCallback(async () => {
    if (!sendReq || !connected) return;
    try {
      const res = await sendReq('proactive.state', { touch: true });
      if (res && typeof res === 'object' && 'whereWasI' in res) setData(res);
    } catch {
      /* RPC not served yet (gateway needs restart) — stay quiet */
    }
  }, [sendReq, connected]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!data?.active) return undefined;
    const t = setInterval(() => refresh(), 30000);
    return () => clearInterval(t);
  }, [data?.active, refresh]);

  // ── DRIFT RADAR data hook ──────────────────────────────────────────────────
  // Source the radar from the canonical kanban store (the same RPCs the
  // Projects/Clients views read), NOT from proactive.state's drift rows. This is
  // intentionally independent of the focus-engine reconcile so it always shows
  // the real in_progress projects regardless of rotation state.
  const loadRadar = useCallback(async () => {
    if (!sendReq || !connected) return;
    try {
      const [projects, tasks] = await Promise.all([
        sendReq('kanban.projects.list', {}).catch(() => []),
        sendReq('kanban.tasks.list', {}).catch(() => []),
      ]);
      const projArr = Array.isArray(projects) ? projects : (projects?.projects || []);
      const taskArr = Array.isArray(tasks) ? tasks : (tasks?.tasks || []);
      setRadarGroups(buildRadarGroups(projArr, taskArr));
    } catch {
      /* leave the last good radar in place on a transient failure */
    }
  }, [sendReq, connected]);

  useEffect(() => { loadRadar(); }, [loadRadar]);
  // Refresh the radar on a slow tick + whenever a kanban task transition fires,
  // so newly started/finished work appears without a manual reload.
  useEffect(() => {
    if (!connected) return undefined;
    const t = setInterval(() => loadRadar(), 30000);
    return () => clearInterval(t);
  }, [connected, loadRadar]);
  useEffect(() => {
    if (!subscribeEvent) return undefined;
    const unsub = subscribeEvent('kanban:task:completed', () => loadRadar());
    return () => unsub && unsub();
  }, [subscribeEvent, loadRadar]);

  // ── Signals pipeline ───────────────────────────────────────────────────────
  // Mirror the module-level store into local state so the panel re-renders when
  // a new signal lands.
  useEffect(() => signalsStore.subscribe(() => setSignals(signalsStore.list())), []);
  // Subscribe to the live producer events and feed normalized signals in. All of
  // these are already broadcast by the gateway today — no restart required.
  useEffect(() => {
    if (!subscribeEvent) return undefined;
    const EVENTS = [
      'subagent.complete', 'subagent.error', 'subagent.timeout',
      'kanban:task:completed', 'proactive.updated', 'proactive.event',
    ];
    const unsubs = EVENTS.map((ev) =>
      subscribeEvent(ev, (payload) => {
        const sig = normalizeSignal(ev, payload);
        if (sig) signalsStore.add(sig);
      }),
    );
    return () => unsubs.forEach((u) => u && u());
  }, [subscribeEvent]);

  const toggleCollapse = useCallback(
    (pid) => setCollapsed((p) => ({ ...p, [pid]: !p[pid] })),
    [],
  );

  const call = useCallback(async (method, params = {}) => {
    if (!sendReq || busy) return;
    setBusy(true);
    try {
      const res = await sendReq(method, params);
      if (res && typeof res === 'object' && 'whereWasI' in res) setData(res);
      else await refresh();
    } catch {
      /* swallow — UI stays on last good state */
    } finally {
      setBusy(false);
      setShowCustom(false); setCustomTitle('');
      setShowBreak(false); setBreakReason('');
    }
  }, [sendReq, busy, refresh]);

  const durOf = (id) => durById[id] ?? 45;
  const setDur = (id, m) => setDurById((p) => ({ ...p, [id]: m }));

  // A row handler that tags which button is in flight so we can show a spinner
  // on it while `busy` disables every sibling (call() flips busy globally).
  const rowAction = useCallback(async (tag, method, params) => {
    if (busy) return;
    setPending(tag);
    try {
      await call(method, params);
    } finally {
      setPending(null);
    }
  }, [busy, call]);

  const toggleSchedule = (id) => setScheduleOpen((p) => ({ ...p, [id]: !p[id] }));

  // Dismiss a single candidate row. When it's backed by a linked repo
  // (projectId) we park the project — the gateway's stash-safe demotion (moves
  // it to cold, never resets/discards). Otherwise just hide it locally.
  const rejectCandidate = useCallback((c) => {
    setRejected((p) => ({ ...p, [c.taskId]: true }));
    if (c.projectId) {
      void rowAction(`${c.taskId}:reject`, 'proactive.project.park', { projectId: c.projectId });
    } else {
      void refresh(); // re-derive so the next backlog item slides into the slot
    }
  }, [rowAction, refresh]);

  // Finish a candidate: flip the underlying kanban task to done via the live
  // gateway RPC (kanban.tasks.update — already served, no restart), then
  // optimistically hide it and re-pull state so the freed slot refills. On
  // failure we keep the row and surface an inline error.
  const finishCandidate = useCallback(async (c) => {
    if (!sendReq || busy) return;
    if (!c.taskId) { setErrorMsg('This item has no linked task to complete.'); return; }
    setPending(`${c.taskId}:finish`);
    setBusy(true);
    setErrorMsg('');
    try {
      await sendReq('kanban.tasks.update', { id: c.taskId, patch: { status: 'done' } });
      setCompleted((p) => ({ ...p, [c.taskId]: true }));
      await refresh();
    } catch {
      setErrorMsg("Couldn't mark that task done. It's still in your list.");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }, [sendReq, busy, refresh]);

  if (!data) return null;
  const w = data.whereWasI || {};
  const a = data.active;
  const showAnchor = w.canResume || (w.idleMin ?? 0) >= 10 || w.mostImportantChange;

  return (
    <View style={s.wrap}>
      {/* 1 · Where was I? */}
      {showAnchor ? (
        <View style={[s.card, s.anchor]}>
          <Ionicons name="arrow-undo" size={18} color={COLORS.info} style={{ marginRight: 10 }} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.anchorHead}>Where was I?</Text>
            {w.lastCommittedTitle ? (
              <Text style={s.anchorSub}>Last: “{w.lastCommittedTitle}” · idle {fmtMin(w.idleMin)}</Text>
            ) : null}
            <Text style={s.anchorWhile}>While away: {w.whileAway}</Text>
            {w.mostImportantChange ? <Text style={s.anchorKey}><Ionicons name="flag" size={12} color={COLORS.warning} /> {w.mostImportantChange}</Text> : null}
          </View>
          {w.canResume ? (
            <TouchableOpacity style={[s.btn, s.btnPrimary]} disabled={busy} onPress={() => call('proactive.resume')}>
              <Text style={s.btnPrimaryTxt}>Resume <Ionicons name="play" size={11} color={COLORS.background} /></Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {/* 2 · Active commitment OR commit flow */}
      {a ? (
        <View style={[s.card, s.nowbar, a.driftLevel === 'hard-drift' && { borderColor: withAlpha(COLORS.error, 0.6) }, a.driftLevel === 'soft-drift' && { borderColor: withAlpha(COLORS.warning, 0.55) }]}>
          {a.driftLevel === 'hard-drift' ? (
            <Text style={[s.ribbon, { color: COLORS.error, backgroundColor: withAlpha(COLORS.error, 0.16) }]}>Drifted &gt;15m — re-commit or break the block.</Text>
          ) : a.driftLevel === 'soft-drift' ? (
            <Text style={[s.ribbon, { color: COLORS.warning, backgroundColor: withAlpha(COLORS.warning, 0.14) }]}>Still on “{a.title}”? You've drifted a few minutes.</Text>
          ) : null}
          <View style={s.nowRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.nowEyebrow}>COMMITTED · LOCKED</Text>
              <Text style={s.nowTitle} numberOfLines={2}>{a.title}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.nowRemaining}>{a.remainingMin}m</Text>
              <Text style={s.nowOf}>left of {a.durationMin}m</Text>
            </View>
          </View>
          <View style={s.track}>
            <View style={[s.trackFill, { width: `${Math.min(100, Math.round((a.elapsedMin / Math.max(1, a.durationMin)) * 100))}%` }]} />
          </View>
          {showBreak ? (
            <View style={s.inlineRow}>
              <TextInput style={s.input} placeholder="Why switch? (1 sentence)" placeholderTextColor={COLORS.textMuted}
                value={breakReason} onChangeText={setBreakReason} />
              <TouchableOpacity style={s.btn} disabled={busy || !breakReason.trim()} onPress={() => call('proactive.break', { reason: breakReason })}>
                <Text style={s.btnTxt}>Break</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.inlineRow}>
              <TouchableOpacity style={[s.btn, s.btnPrimary]} disabled={busy} onPress={() => call('proactive.complete', { outcome: 'shipped' })}>
                <Text style={s.btnPrimaryTxt}>Shipped <Ionicons name="checkmark" size={13} color={COLORS.background} /></Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.btn} disabled={busy} onPress={() => call('proactive.complete', { outcome: 'blocked' })}>
                <Text style={s.btnTxt}>Blocked</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.btnGhost} onPress={() => setShowBreak(true)}>
                <Text style={s.btnGhostTxt}>Switch</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      ) : (
        <View style={[s.card]}>
          <Text style={s.sectionHead}>COMMIT TO ONE THING</Text>
          <Text style={s.sectionSub}>Pick a block — or reject all and type your own.</Text>
          {errorMsg ? <Text style={s.toast}>{errorMsg}</Text> : null}
          {(() => {
            const available = (data.candidates || []).filter(
              (c) => !rejected[c.taskId] && !completed[c.taskId],
            );
            if (available.length === 0) {
              return <Text style={s.empty}>No open tasks to commit to.</Text>;
            }
            const shown = available.slice(0, VISIBLE);
            const rows = shown.map((c) => {
              const finishTag = `${c.taskId}:finish`;
              const rejectTag = `${c.taskId}:reject`;
              const commitTag = `${c.taskId}:commit`;
              const open = !!scheduleOpen[c.taskId];
              return (
                <View key={c.taskId} style={s.cand}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.candTitle} numberOfLines={2}>
                      {c.priorityTag ? <Text style={[s.tag, { color: stateColor('drifting') }]}>{c.priorityTag} </Text> : null}
                      {c.title}
                    </Text>
                    <Text style={s.candReason}>{c.reason}</Text>
                  </View>
                  <View style={s.candCol}>
                    {/* Primary per-row actions: Finish (commit now) + Reject (dismiss). */}
                    <View style={s.candActions}>
                      <TouchableOpacity style={[s.btn, s.btnPrimary]} disabled={busy}
                        onPress={() => finishCandidate(c)}>
                        <Text style={s.btnPrimaryTxt}>{pending === finishTag ? '…' : 'Finish '}{pending === finishTag ? null : <Ionicons name="checkmark" size={13} color={COLORS.background} />}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.btn, s.btnReject]} disabled={busy}
                        onPress={() => rejectCandidate(c)}>
                        <Text style={s.btnRejectTxt}>{pending === rejectTag ? '…' : 'Reject'}</Text>
                      </TouchableOpacity>
                    </View>
                    {/* Secondary: the old [25][45][90] + Commit scheduler, collapsed. */}
                    <TouchableOpacity style={s.scheduleToggle} disabled={busy} onPress={() => toggleSchedule(c.taskId)}>
                      <Text style={s.scheduleTxt}>Schedule {open ? '▴' : '▾'}</Text>
                    </TouchableOpacity>
                    {open ? (
                      <View style={s.scheduleBody}>
                        <DurPicker value={durOf(c.taskId)} onPick={(m) => setDur(c.taskId, m)} />
                        <TouchableOpacity style={[s.btn, s.btnGhost]} disabled={busy}
                          onPress={() => rowAction(commitTag, 'proactive.commit', { taskId: c.taskId, projectId: c.projectId || undefined, title: c.title, durationMin: durOf(c.taskId) })}>
                          <Text style={s.btnGhostTxt}>{pending === commitTag ? '…' : `Commit ${durOf(c.taskId)}m`}</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                </View>
              );
            });
            // Fewer than the target left? Show the rows we have plus a calm
            // empty-state line so the panel never silently shrinks.
            if (available.length < VISIBLE) {
              rows.push(
                <Text key="__none-left" style={[s.empty, s.emptyRow]}>No more drifting tasks — nice.</Text>,
              );
            }
            return rows;
          })()}
          {showCustom ? (
            <View style={[s.inlineRow, { marginTop: 10 }]}>
              <TextInput style={s.input} placeholder="Name your own commitment…" placeholderTextColor={COLORS.textMuted}
                value={customTitle} onChangeText={setCustomTitle} />
              <TouchableOpacity style={[s.btn, s.btnPrimary]} disabled={busy || !customTitle.trim()}
                onPress={() => call('proactive.commit', { title: customTitle, durationMin: durOf('custom') })}>
                <Text style={s.btnPrimaryTxt}>Commit</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={s.reject} onPress={() => setShowCustom(true)}>
              <Text style={s.rejectTxt}>Reject all → type your own</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* 3 · Drift radar — real kanban in_progress projects → active tasks */}
      <View style={[s.card]}>
        <Text style={s.sectionHead}>DRIFT RADAR</Text>
        {/* Counter stays anchored to the proactive engine's focus summary. */}
        <Text style={s.sectionSub}>
          {data.summary?.focusedCount ?? 0}/{data.maxFocus} focused · {data.summary?.driftingCount ?? 0} drifting · {data.summary?.coldCount ?? 0} cold
        </Text>
        {radarGroups.length === 0 ? (
          <Text style={s.empty}>No projects in progress. Move one to “In progress” to track it here.</Text>
        ) : (
          radarGroups.map((g) => {
            const isCollapsed = !!collapsed[g.id];
            const active = g.tasks.filter((t) => t.status === 'in_progress').length;
            const review = g.tasks.filter((t) => t.status === 'review').length;
            return (
              <View key={g.id} style={s.group}>
                {/* Project header row — tap to expand/collapse its task sub-view. */}
                <TouchableOpacity style={s.projHead} onPress={() => toggleCollapse(g.id)} activeOpacity={0.7}>
                  <Ionicons name={isCollapsed ? 'chevron-forward' : 'chevron-down'} size={14} color={COLORS.textMuted} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.projName} numberOfLines={1}>{g.name}</Text>
                    <Text style={s.projMeta} numberOfLines={1}>
                      {active} active{review ? ` · ${review} review` : ''}{g.tasks.length === 0 ? 'no active tasks' : ''}
                    </Text>
                  </View>
                  <View style={[s.chip, { backgroundColor: withAlpha(COLORS.info, 0.16) }]}>
                    <Text style={[s.chipTxt, { color: COLORS.info }]}>{g.status}</Text>
                  </View>
                  <TouchableOpacity style={s.mini} disabled={busy} onPress={() => call('proactive.project.park', { projectId: g.id })}>
                    <Text style={s.miniTxt}>park</Text>
                  </TouchableOpacity>
                </TouchableOpacity>
                {/* Task sub-view */}
                {!isCollapsed ? (
                  g.tasks.length === 0 ? (
                    <Text style={s.subEmpty}>no active tasks</Text>
                  ) : (
                    g.tasks.map((t) => (
                      <View key={t.id} style={s.taskRow}>
                        <View style={[s.taskPill, { backgroundColor: withAlpha(taskStatusColor(t.status), 0.16) }]}>
                          <Text style={[s.taskPillTxt, { color: taskStatusColor(t.status) }]}>{taskStatusLabel(t.status)}</Text>
                        </View>
                        <Text style={s.taskTitle} numberOfLines={1}>{t.title}</Text>
                      </View>
                    ))
                  )
                ) : null}
              </View>
            );
          })
        )}
        {(data.extras || []).length ? (
          <View style={s.extras}>
            <Text style={s.extrasHead}>Extras — {data.extras.length} past the cap of {data.maxFocus}</Text>
            <View style={s.extrasRow}>
              {data.extras.slice(0, 4).map((r) => (
                <TouchableOpacity key={r.projectId} style={s.extra} disabled={busy} onPress={() => call('proactive.project.promote', { projectId: r.projectId })}>
                  <Text style={s.extraTxt} numberOfLines={1}>{r.name}</Text>
                  <Text style={s.extraPromote}>promote</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}
      </View>

      {/* 4 · Signals — live feed of agent / kanban / drift events */}
      <View style={[s.card]}>
        <Text style={s.sectionHead}>SIGNALS</Text>
        <Text style={s.sectionSub}>Live events from your agents, board and focus drift</Text>
        {signals.length === 0 ? (
          <Text style={s.empty}>No signals yet. Run a sub-agent or move a task and they’ll land here.</Text>
        ) : (
          signals.slice(0, 12).map((sig) => (
            <TouchableOpacity key={sig.id} style={s.signalRow} disabled={!sig.link} activeOpacity={0.7}
              onPress={() => sig.link && openDeepLink(sig.link)}>
              <View style={[s.signalDot, { backgroundColor: signalColor(sig.severity) }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.signalTitle} numberOfLines={1}>{sig.title}</Text>
                {sig.detail ? <Text style={s.signalDetail} numberOfLines={1}>{sig.detail}</Text> : null}
              </View>
              <Text style={s.signalTime}>{relTime(sig.ts)}</Text>
              {sig.link ? <Ionicons name="chevron-forward" size={13} color={COLORS.textMuted} /> : null}
            </TouchableOpacity>
          ))
        )}
      </View>
    </View>
  );
}

function DurPicker({ value, onPick }) {
  return (
    <View style={s.durs}>
      {DURATIONS.map((m) => (
        <TouchableOpacity key={m} style={[s.dur, value === m && s.durActive]} onPress={() => onPick(m)}>
          <Text style={[s.durTxt, value === m && s.durActiveTxt]}>{m}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: 12, marginTop: 4 },
  card: {
    backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.cardBorder,
    borderRadius: 16, padding: 14,
  },
  anchor: { flexDirection: 'row', alignItems: 'center', borderColor: withAlpha(COLORS.info, 0.4), backgroundColor: withAlpha(COLORS.info, 0.08) },
  anchorHead: { color: COLORS.text, fontWeight: '800', fontSize: 14, fontFamily: FONT_FAMILY?.bold },
  anchorSub: { color: COLORS.textMuted, fontSize: 12, marginTop: 2 },
  anchorWhile: { color: COLORS.textSecondary, fontSize: 12, marginTop: 3 },
  anchorKey: { color: COLORS.warning, fontSize: 12.5, marginTop: 5, fontWeight: '600' },

  nowbar: { borderColor: withAlpha(COLORS.success, 0.4) },
  ribbon: { fontSize: 12.5, fontWeight: '700', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 10, marginBottom: 10, overflow: 'hidden' },
  nowRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  nowEyebrow: { color: COLORS.success, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  nowTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800', marginTop: 2 },
  nowRemaining: { color: COLORS.success, fontSize: 22, fontWeight: '800' },
  nowOf: { color: COLORS.textMuted, fontSize: 11 },
  track: { height: 5, borderRadius: 4, backgroundColor: withAlpha(COLORS.text, 0.08), marginVertical: 12, overflow: 'hidden' },
  trackFill: { height: '100%', backgroundColor: COLORS.success, borderRadius: 4 },

  sectionHead: { color: COLORS.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  sectionSub: { color: COLORS.textMuted, fontSize: 11.5, marginTop: 3, marginBottom: 8 },
  empty: { color: COLORS.textMuted, fontSize: 12.5, paddingVertical: 6 },
  emptyRow: { borderWidth: 1, borderColor: COLORS.cardBorder, borderStyle: 'dashed', borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 12, textAlign: 'center', marginBottom: 8 },
  toast: { color: COLORS.error, backgroundColor: withAlpha(COLORS.error, 0.14), borderWidth: 1,
    borderColor: withAlpha(COLORS.error, 0.4), borderRadius: 8, paddingVertical: 7, paddingHorizontal: 10,
    fontSize: 11.5, fontWeight: '600', marginBottom: 8, overflow: 'hidden' },

  cand: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10,
    borderWidth: 1, borderColor: COLORS.borderSubtle || COLORS.cardBorder, borderRadius: 10, padding: 10, marginBottom: 8 },
  candTitle: { color: COLORS.text, fontWeight: '700', fontSize: 13.5 },
  candReason: { color: COLORS.textMuted, fontSize: 11.5, marginTop: 2 },
  tag: { fontWeight: '800', fontSize: 11 },

  candCol: { alignItems: 'flex-end', gap: 6 },
  candActions: { flexDirection: 'row', gap: 6 },
  btnReject: { backgroundColor: 'transparent', borderColor: withAlpha(COLORS.error, 0.5) },
  btnRejectTxt: { color: COLORS.error, fontSize: 12.5, fontWeight: '800' },
  scheduleToggle: { paddingVertical: 2, paddingHorizontal: 4 },
  scheduleTxt: { color: COLORS.textMuted, fontSize: 11 },
  scheduleBody: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  reject: { marginTop: 10, borderWidth: 1, borderColor: COLORS.cardBorder, borderStyle: 'dashed', borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  rejectTxt: { color: COLORS.textMuted, fontSize: 12.5 },

  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 150, backgroundColor: COLORS.inputBg || withAlpha(COLORS.text, 0.06),
    borderWidth: 1, borderColor: COLORS.cardBorder, borderRadius: 8, color: COLORS.text, paddingVertical: 8, paddingHorizontal: 10, fontSize: 13 },

  durs: { flexDirection: 'row', gap: 3 },
  dur: { backgroundColor: withAlpha(COLORS.text, 0.05), borderWidth: 1, borderColor: COLORS.cardBorder, borderRadius: 6, paddingVertical: 3, paddingHorizontal: 7 },
  durActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  durTxt: { color: COLORS.textMuted, fontSize: 11 },
  durActiveTxt: { color: COLORS.background, fontWeight: '700' },

  row: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: withAlpha(COLORS.text, 0.05) },
  chip: { borderRadius: 5, paddingVertical: 2, paddingHorizontal: 6, minWidth: 54, alignItems: 'center' },
  chipTxt: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },

  // ── radar: project group → task sub-view ──
  group: { borderBottomWidth: 1, borderBottomColor: withAlpha(COLORS.text, 0.05), paddingVertical: 6 },
  projHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  projName: { color: COLORS.text, fontWeight: '800', fontSize: 13.5 },
  projMeta: { color: COLORS.textMuted, fontSize: 11 },
  subEmpty: { color: COLORS.textMuted, fontSize: 11.5, fontStyle: 'italic', paddingLeft: 22, paddingVertical: 4 },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, paddingLeft: 22 },
  taskPill: { borderRadius: 4, paddingVertical: 1, paddingHorizontal: 6, minWidth: 64, alignItems: 'center' },
  taskPillTxt: { fontSize: 9.5, fontWeight: '800', textTransform: 'uppercase' },
  taskTitle: { flex: 1, minWidth: 0, color: COLORS.textSecondary, fontSize: 12.5 },

  // ── signals feed ──
  signalRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: withAlpha(COLORS.text, 0.05) },
  signalDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  signalTitle: { color: COLORS.text, fontWeight: '700', fontSize: 12.5 },
  signalDetail: { color: COLORS.textMuted, fontSize: 11, marginTop: 1 },
  signalTime: { color: COLORS.textMuted, fontSize: 10.5, flexShrink: 0 },
  rowName: { color: COLORS.text, fontWeight: '700', fontSize: 13.5 },
  rowMeta: { color: COLORS.textMuted, fontSize: 11.5 },
  driftBar: { width: 64, height: 6, borderRadius: 4, backgroundColor: withAlpha(COLORS.text, 0.08), overflow: 'hidden' },
  driftFill: { height: '100%', backgroundColor: COLORS.warning, borderRadius: 4 },

  extras: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: withAlpha(COLORS.text, 0.06) },
  extrasHead: { color: COLORS.textMuted, fontSize: 11 },
  extrasRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  extra: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: withAlpha(COLORS.text, 0.04), borderRadius: 6, paddingVertical: 3, paddingHorizontal: 8 },
  extraTxt: { color: COLORS.textSecondary, fontSize: 11.5, maxWidth: 120 },
  extraPromote: { color: COLORS.primary, fontSize: 10.5, fontWeight: '700' },

  btn: { backgroundColor: withAlpha(COLORS.text, 0.07), borderWidth: 1, borderColor: COLORS.cardBorder, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12 },
  btnTxt: { color: COLORS.text, fontSize: 12.5, fontWeight: '700' },
  btnPrimary: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  btnPrimaryTxt: { color: COLORS.background, fontSize: 12.5, fontWeight: '800' },
  btnGhost: { paddingVertical: 7, paddingHorizontal: 10 },
  btnGhostTxt: { color: COLORS.textMuted, fontSize: 12.5, fontWeight: '700' },
  mini: { borderWidth: 1, borderColor: COLORS.cardBorder, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 7 },
  miniTxt: { color: COLORS.textMuted, fontSize: 10.5 },
});

export default ProactiveSection;
