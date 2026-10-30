/**
 * PhasesTab — native mirror of <autonomy-phases-view> (web /autonomy?tab=phases).
 *
 *   header   → queue.setPaused (dispatch switch) · queue.backends (+ re-check) · queue.metrics
 *   composer → queue.enqueue (phases with agent/model/fallback/limits/gate checks; reorder)
 *   list     → queue.list (filters; live on queue.* events + 5 s poll)
 *   detail   → queue.get / queue.logs + pause / force pause / resume / retry… /
 *              skip phase (queue.advance) / priority up-down (queue.reorder) / cancel
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS, Button, IconButton, Chip, Tabs, ProgressBar, EmptyState, Skeleton, toneColor } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import * as M from './goals-model';
import {
  Section, Collapsible, Pre, Msg, Label, TextBox, NumBox, Select, ToggleRow, Dot, MetaLine, LoadState,
  confirmAsync, usePersistentDraft, useFlash, useGatewayEvents, useInterval, targetOptions, st,
} from './shared';
import { CheckEditor } from './GoalsTab';

const DRAFT_KEY = 'infinibot.queue.phases.draft.v1';
const QUEUE_EVENTS = [
  'queue.changed',
  'queue.entry.advanced', 'queue.entry.blocked', 'queue.entry.canceled', 'queue.entry.created', 'queue.entry.dead',
  'queue.entry.done', 'queue.entry.failed', 'queue.entry.paused', 'queue.entry.reordered', 'queue.entry.resumed',
  'queue.entry.retried', 'queue.entry.started', 'queue.entry.waiting',
  'queue.phase.completed', 'queue.phase.fallback', 'queue.phase.gate', 'queue.phase.model', 'queue.phase.retrying',
  'queue.phase.settled', 'queue.phase.started', 'queue.phase.timeout',
];

async function copyText(text) {
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const Clipboard = require('expo-clipboard'); // eslint-disable-line global-require
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}

export function PhasesTab({ gateway, focusId, wide, registerBack, reloadSignal }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';

  const [entries, setEntries] = useState(null);
  const [globalPaused, setGlobalPaused] = useState(false);
  const [listErr, setListErr] = useState(null);
  const [actionErr, setActionErr] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState(focusId || null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [backends, setBackends] = useState([]);
  const [backendsBusy, setBackendsBusy] = useState(false);
  const [metrics, setMetrics] = useState([]);
  const [agents, setAgents] = useState([]);
  const [filter, setFilter] = useState('all');
  const [composerOpen, setComposerOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [retryOpen, setRetryOpen] = useState(false);
  const [retry, setRetry] = useState({ instruction: '', fresh: false, agent: '', model: '', from: -1 });
  const [logs, setLogs] = useState({});
  const [now, setNow] = useState(Date.now());
  const [notice, flash] = useFlash();
  const [draft, setDraft] = usePersistentDraft(DRAFT_KEY, M.mergePhaseDraft);

  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const logsRef = useRef(logs);
  logsRef.current = logs;
  const metricsAt = useRef(0);

  const loadLogs = useCallback(async (attemptId, silent = false) => {
    const id = selRef.current;
    if (!id || !sendReq) return;
    const prev = logsRef.current[attemptId];
    if (!silent) setLogs((l) => ({ ...l, [attemptId]: { loading: true, text: prev?.text ?? '', source: prev?.source ?? '' } }));
    try {
      const res = await sendReq('queue.logs', { id, attemptId, maxChars: 20000 });
      if (selRef.current !== id) return;
      setLogs((l) => ({ ...l, [attemptId]: { loading: false, text: res?.text ?? '', source: res?.source ?? 'none', tmuxAttach: res?.tmuxAttach } }));
    } catch (err) {
      setLogs((l) => ({ ...l, [attemptId]: { loading: false, text: '', source: 'none', error: M.errMessage(err) } }));
    }
  }, [sendReq]);

  const loadDetail = useCallback(async (id) => {
    if (!sendReq || !id) return;
    try {
      const d = await sendReq('queue.get', { id, events: 60 });
      if (selRef.current !== id) return;
      setDetail(d);
      setDetailError(null);
      for (const a of d?.attempts || []) {
        const l = logsRef.current[a.id];
        if (l && a.endedAt === null && !l.loading) loadLogs(a.id, true);
      }
    } catch (err) {
      if (M.isNotFound(err)) {
        setSelectedId(null);
        setDetail(null);
        setActionErr('That queue entry no longer exists.');
      } else {
        setDetailError(M.errMessage(err));
      }
    }
  }, [sendReq, loadLogs]);

  const loadMetrics = useCallback(async () => {
    metricsAt.current = Date.now();
    try { setMetrics((await sendReq('queue.metrics', {}))?.byAgent ?? []); } catch { /* optional */ }
  }, [sendReq]);

  const refresh = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('queue.list', { limit: 200 });
      const list = res?.entries ?? [];
      setEntries(list);
      setGlobalPaused(Boolean(res?.paused));
      setComposerOpen((o) => (o === null ? list.length === 0 : o));
      setListErr(null);
      if (selRef.current) await loadDetail(selRef.current);
    } catch (err) {
      setListErr(err);
    }
    if (Date.now() - metricsAt.current > 30000) loadMetrics();
  }, [sendReq, loadDetail, loadMetrics]);

  const loadBackends = useCallback(async (force) => {
    if (!sendReq) return;
    setBackendsBusy(Boolean(force));
    try { setBackends((await sendReq('queue.backends', force ? { refresh: true } : {}))?.backends ?? []); } catch { /* optional */ }
    setBackendsBusy(false);
  }, [sendReq]);

  const loadAgents = useCallback(async () => {
    if (!sendReq) return;
    try { setAgents(M.normalizeAgents(await sendReq('agents.list', {}))); } catch { setAgents([]); }
  }, [sendReq]);

  useEffect(() => {
    if (connected) { refresh(); loadBackends(false); loadAgents(); }
  }, [connected, refresh, loadBackends, loadAgents]);

  useEffect(() => { if (focusId) select(focusId); }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (reloadSignal) refresh(); }, [reloadSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useGatewayEvents(gateway, QUEUE_EVENTS, refresh);
  useInterval(() => {
    setNow(Date.now());
    if (connected && M.entriesHaveActive(entries)) refresh();
  }, 5000);

  function resetRetry() {
    setRetryOpen(false);
    setRetry({ instruction: '', fresh: false, agent: '', model: '', from: -1 });
  }

  function select(id) {
    if (selRef.current === id) return;
    selRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setLogs({});
    resetRetry();
    if (id) loadDetail(id);
  }

  useEffect(() => {
    registerBack?.(() => {
      if (!wide && selRef.current) { select(null); return true; }
      return false;
    });
  });

  const onPull = async () => {
    setRefreshing(true);
    await Promise.all([refresh(), loadBackends(false)]);
    setRefreshing(false);
  };

  // ── composer ──────────────────────────────────────────────────────────
  const setPhase = (i, patch) => setDraft((d) => ({ ...d, phases: d.phases.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const setPhaseCheck = (pi, ci, patch) => setDraft((d) => ({
    ...d,
    phases: d.phases.map((p, j) => (j === pi ? { ...p, checks: p.checks.map((c, k) => (k === ci ? { ...c, ...patch } : c)) } : p)),
  }));

  const enqueue = async () => {
    const built = M.buildEnqueueParams(draft);
    if (built.error) { setFormError(built.error); return; }
    setCreating(true);
    setFormError(null);
    try {
      const res = await sendReq('queue.enqueue', built.params);
      setDraft({ title: '', brief: '', phases: [M.emptyPhase()] });
      setFilter('all');
      flash(res?.deduped ? 'An identical entry already exists — selected it.' : 'Entry queued.');
      setComposerOpen(false);
      select(res?.id || null);
      await refresh();
    } catch (err) {
      setFormError(M.errMessage(err));
    } finally {
      setCreating(false);
    }
  };

  // ── controls ──────────────────────────────────────────────────────────
  const control = async (method, extra = {}, confirmText) => {
    const id = selRef.current;
    if (!id || busy) return;
    if (confirmText && !(await confirmAsync('Are you sure?', confirmText, 'Confirm'))) return;
    setBusy(method + (extra.force ? ':force' : ''));
    setDetailError(null);
    try {
      await sendReq(method, { id, ...extra });
      if (method === 'queue.retry') resetRetry();
      await refresh();
    } catch (err) {
      setDetailError(M.errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleDispatch = async () => {
    if (busy) return;
    setBusy('queue.setPaused');
    setActionErr(null);
    try {
      const res = await sendReq('queue.setPaused', { paused: !globalPaused });
      setGlobalPaused(Boolean(res?.paused ?? !globalPaused));
      await refresh();
    } catch (err) {
      setActionErr(M.errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleLogs = (attemptId) => {
    if (logsRef.current[attemptId]) {
      setLogs((l) => { const n = { ...l }; delete n[attemptId]; return n; });
    } else {
      loadLogs(attemptId);
    }
  };

  const filterCounts = useMemo(() => M.entryFilterCounts(entries || []), [entries]);
  const shown = useMemo(() => M.filterEntries(entries || [], filter), [entries, filter]);
  const statusCounts = useMemo(() => M.entryStatusCounts(entries || []), [entries]);

  // ── header card ───────────────────────────────────────────────────────
  const header = (
    <Section tint={globalPaused ? 'warning' : 'primary'}>
      <ToggleRow
        label={`Dispatch: ${globalPaused ? 'paused' : 'running'}`}
        hint={globalPaused ? 'New attempts will not start — tap to resume' : 'The queue dispatches phases — tap to pause'}
        value={!globalPaused}
        onChange={() => toggleDispatch()}
      />
      <View style={[st.row, { marginTop: SPACE.xs }]}>
        {statusCounts.map((c) => (
          <Chip key={c.status} label={`${c.count} ${c.label}`} tone={M.queueStatusTone(c.status)} size="sm" />
        ))}
        {entries && entries.length === 0 ? <Text style={[type.caption, { color: colors.textMuted }]}>Queue empty</Text> : null}
      </View>
      {backends.length ? (
        <View style={{ marginTop: SPACE.sm }}>
          <View style={[st.row, { justifyContent: 'space-between' }]}>
            <Text style={[type.label, { color: colors.textMuted }]}>CLI backends</Text>
            <Button title="Re-check" icon="refresh" variant="ghost" size="sm" loading={backendsBusy} onPress={() => loadBackends(true)} />
          </View>
          <View style={st.row}>
            {backends.map((b) => {
              const bs = M.backendState(b);
              return <Chip key={b.id} label={`${M.agentLabel(b.id)} · ${bs.label}`} tone={bs.tone} dot size="sm" />;
            })}
          </View>
          {backends.filter((b) => M.backendState(b).tone !== 'success' && (b.fix || b.reason)).map((b) => (
            <Text key={b.id} style={[type.caption, { color: colors.textMuted, marginTop: 2 }]}>
              {`${M.agentLabel(b.id)}: ${[b.reason, b.fix].filter(Boolean).join(' — ')}`}
            </Text>
          ))}
        </View>
      ) : null}
      {metrics.length ? (
        <View style={{ marginTop: SPACE.sm }}>
          <Text style={[type.label, { color: colors.textMuted, marginBottom: SPACE.xs }]}>Success rate by agent</Text>
          {metrics.slice(0, 5).map((m) => (
            <Text key={m.agent} style={[type.monoSmall, { color: colors.textSecondary }]}>
              {`${M.agentLabel(m.agent)}  ${Math.round((m.successRate ?? 0) * 100)}%  · avg ${M.fmtDuration(m.avgDurationMs)}  · ${m.passed}/${m.attempts}`}
            </Text>
          ))}
        </View>
      ) : null}
      <Msg>{actionErr}</Msg>
    </Section>
  );

  const open = composerOpen === true;
  const composer = (
    <Section
      title="New phased entry"
      right={
        <IconButton
          icon={open ? 'chevron-up' : 'chevron-down'}
          size="sm"
          onPress={() => setComposerOpen(!open)}
          accessibilityLabel={open ? 'Collapse new entry form' : 'Expand new entry form'}
        />
      }
    >
      <Text style={[type.caption, { color: colors.textMuted, marginBottom: open ? SPACE.sm : 0 }]}>Verified, gated phases</Text>
      {open ? (
        <View style={{ gap: SPACE.md }}>
          <View>
            <Label>Title</Label>
            <TextBox value={draft.title} onChangeText={(v) => setDraft({ title: v })} placeholder="e.g. Billing page v2" label="Title" />
          </View>
          <View>
            <Label>Brief</Label>
            <TextBox multiline rows={3} value={draft.brief} onChangeText={(v) => setDraft({ brief: v })} placeholder="What the whole entry should achieve. Shared with every phase." label="Brief" />
          </View>
          <View>
            <Label>Project folder</Label>
            <TextBox mono value={draft.workdir} onChangeText={(v) => setDraft({ workdir: v })} placeholder="~/Desktop/Development/my-app" label="Project folder" />
          </View>
          <View style={st.grid}>
            <Select
              label="Isolation"
              value={draft.isolation}
              options={M.ISOLATION_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
              onChange={(v) => setDraft({ isolation: v })}
            />
            <NumBox label="Priority" value={draft.priority} min={-1000} max={1000} onChange={(v) => setDraft({ priority: Math.round(v) })} />
          </View>
          <View>
            <Label>Phases</Label>
            <View style={{ gap: SPACE.sm }}>
              {draft.phases.map((p, i) => (
                <PhaseEditor
                  key={i}
                  p={p}
                  i={i}
                  n={draft.phases.length}
                  agents={agents}
                  invalid={Boolean(formError) && !p.name.trim()}
                  onChange={(patch) => setPhase(i, patch)}
                  onMove={(dir) => setDraft((d) => ({ ...d, phases: M.movePhase(d.phases, i, dir) }))}
                  onRemove={() => setDraft((d) => ({ ...d, phases: d.phases.filter((_, j) => j !== i) }))}
                  onCheck={(ci, patch) => setPhaseCheck(i, ci, patch)}
                  onAddCheck={() => setPhase(i, { checks: [...p.checks, M.emptyPhaseCheck('shell')] })}
                  onRemoveCheck={(ci) => setPhase(i, { checks: p.checks.filter((_, k) => k !== ci) })}
                />
              ))}
            </View>
            <Button
              title="Add phase"
              icon="add"
              variant="ghost"
              size="sm"
              style={{ alignSelf: 'flex-start', marginTop: SPACE.xs }}
              onPress={() => setDraft((d) => ({ ...d, phases: [...d.phases, M.emptyPhase()] }))}
            />
          </View>
          <Msg>{formError}</Msg>
          <Msg tone="success">{notice}</Msg>
          <View style={st.row}>
            <Button title="Clear" variant="ghost" onPress={() => { setDraft(M.defaultPhaseDraft()); setFormError(null); }} />
            <Button
              title={creating ? 'Queuing…' : `Queue ${draft.phases.length} phase${draft.phases.length === 1 ? '' : 's'}`}
              icon="play-forward-outline"
              loading={creating}
              disabled={!connected}
              onPress={enqueue}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : null}
    </Section>
  );

  const list = (
    <Section title="Entries">
      <Tabs
        tabs={M.PHASE_FILTERS.map((f) => ({ key: f.key, label: f.label, count: filterCounts[f.key] ?? 0 }))}
        active={filter}
        onSelect={setFilter}
        contentStyle={{ paddingBottom: SPACE.sm }}
      />
      {entries === null && !listErr ? (
        <View style={{ gap: SPACE.sm }}>
          <Skeleton height={56} />
          <Skeleton height={56} />
        </View>
      ) : listErr ? (
        <LoadState error={listErr} onRetry={refresh} unavailableTitle="The phase queue is not available on this gateway" />
      ) : shown.length === 0 ? (
        <EmptyState
          compact
          icon="layers-outline"
          title={entries.length === 0 ? 'No phased entries yet' : 'Nothing in this filter'}
          message={entries.length === 0 ? 'Open "New phased entry", split the work into phases, and queue it.' : undefined}
        />
      ) : (
        <View style={{ gap: SPACE.xs }}>
          {shown.map((e) => <EntryRow key={e.id} e={e} selected={e.id === selectedId} onPress={() => select(e.id)} now={now} />)}
        </View>
      )}
    </Section>
  );

  const detailView = selectedId ? (
    <EntryDetail
      d={detail}
      detailError={detailError}
      busy={busy}
      now={now}
      connected={connected}
      onBack={wide ? null : () => select(null)}
      onControl={control}
      retryOpen={retryOpen}
      setRetryOpen={setRetryOpen}
      retry={retry}
      setRetry={setRetry}
      logs={logs}
      onToggleLogs={toggleLogs}
      onCopy={async (text) => { if (await copyText(text)) flash('Session id copied.'); }}
      notice={notice}
    />
  ) : <HowItWorks />;

  const refreshCtl = <RefreshControl refreshing={refreshing} onRefresh={onPull} tintColor={colors.primary} />;

  if (wide) {
    return (
      <View style={s.split}>
        <ScrollView style={s.colLeft} contentContainerStyle={s.pad} refreshControl={refreshCtl} keyboardShouldPersistTaps="handled">
          {header}
          {composer}
          {list}
        </ScrollView>
        <ScrollView style={s.colRight} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
          {detailView}
        </ScrollView>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={s.pad} refreshControl={refreshCtl} keyboardShouldPersistTaps="handled">
      {selectedId ? detailView : (
        <>
          {header}
          {composer}
          {list}
          <HowItWorks />
        </>
      )}
    </ScrollView>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────

function PhaseEditor({ p, i, n, agents, invalid, onChange, onMove, onRemove, onCheck, onAddCheck, onRemoveCheck }) {
  const { colors, type } = useUIKit();
  const cli = M.CLI_OPTIONS.find((o) => o.id === p.agent);
  return (
    <View style={[s.phaseBox, { borderColor: colors.borderSubtle }]}>
      <View style={[st.row, { flexWrap: 'nowrap' }]}>
        <Text style={[type.label, { color: colors.primary, flex: 1 }]}>{`Phase ${i + 1}`}</Text>
        <IconButton icon="arrow-up" size="sm" disabled={i === 0} onPress={() => onMove(-1)} accessibilityLabel={`Move phase ${i + 1} up`} />
        <IconButton icon="arrow-down" size="sm" disabled={i === n - 1} onPress={() => onMove(1)} accessibilityLabel={`Move phase ${i + 1} down`} />
        <IconButton icon="close" size="sm" tone={colors.error} disabled={n <= 1} onPress={onRemove} accessibilityLabel={`Remove phase ${i + 1}`} />
      </View>
      <TextBox
        value={p.name}
        onChangeText={(v) => onChange({ name: v })}
        placeholder="Phase name, e.g. Implement API"
        label={`Phase ${i + 1} name`}
        style={invalid ? { borderColor: colors.error } : null}
      />
      <TextBox multiline rows={2} value={p.brief} onChangeText={(v) => onChange({ brief: v })} placeholder="What this phase must do" label={`Phase ${i + 1} brief`} />
      <View style={st.grid}>
        <Select label="Agent" value={p.agent} options={targetOptions(agents, { prefix: false, cli: M.CLI_OPTIONS })} onChange={(v) => onChange({ agent: v, model: '' })} />
        <View style={{ flex: 1, minWidth: 140 }}>
          <Text style={[type.caption, { color: colors.textMuted, marginBottom: 2 }]}>Model</Text>
          <TextBox mono value={p.model} onChangeText={(v) => onChange({ model: v })} placeholder="Backend default" label="Model" />
        </View>
      </View>
      {cli?.models?.length ? (
        <View style={st.row}>
          {cli.models.map((m) => (
            <Chip key={m} label={m} size="sm" selected={p.model === m} onPress={() => onChange({ model: p.model === m ? '' : m })} />
          ))}
        </View>
      ) : null}
      <View style={st.grid}>
        <Select label="Fallback agent" value={p.fallbackAgent} options={targetOptions(agents, { prefix: false, includeNone: true, cli: M.CLI_OPTIONS })} onChange={(v) => onChange({ fallbackAgent: v })} />
        <NumBox label="Max attempts" value={p.maxAttempts} min={1} max={20} onChange={(v) => onChange({ maxAttempts: Math.round(v) })} />
        <NumBox label="Timeout (min)" value={p.timeoutMin} min={1} max={1440} onChange={(v) => onChange({ timeoutMin: v })} />
      </View>
      <View>
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {`Gate checks${p.checks.length ? '' : ' · none (verification verdict only)'}`}
        </Text>
        <View style={{ gap: SPACE.sm, marginTop: SPACE.xs }}>
          {p.checks.map((c, ci) => (
            <CheckEditor key={ci} check={c} types={M.PHASE_CHECK_TYPES} onChange={(patch) => onCheck(ci, patch)} onRemove={() => onRemoveCheck(ci)} />
          ))}
        </View>
        <Button title="Add gate check" icon="add" variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }} onPress={onAddCheck} />
      </View>
    </View>
  );
}

function EntryRow({ e, selected, onPress, now }) {
  const { colors, type } = useUIKit();
  const sum = M.entryRowSummary(e);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.row,
        {
          borderColor: selected ? withAlpha(colors.primary, 0.55) : colors.borderSubtle,
          backgroundColor: selected ? withAlpha(colors.primary, 0.08) : withAlpha(colors.text || '#fff', 0.03),
          opacity: pressed ? 0.8 : 1,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${e.title || e.id}, ${M.QUEUE_STATUS_LABEL[e.status] || e.status}`}
      accessibilityState={{ selected }}
    >
      <View style={[st.row, { flexWrap: 'nowrap' }]}>
        <Chip label={M.QUEUE_STATUS_LABEL[e.status] || e.status} tone={M.queueStatusTone(e.status)} dot size="sm" />
        <Text style={[type.bodyStrong, { color: colors.text, flex: 1 }]} numberOfLines={2}>{e.title || e.id}</Text>
        <Text style={[type.caption, { color: colors.textMuted }]}>{M.formatAgo(e.updatedAt, now)}</Text>
      </View>
      <ProgressBar value={sum.ratio} tone={e.status === 'done' ? 'success' : M.queueStatusTone(e.status) === 'danger' ? 'danger' : 'primary'} height={3} />
      <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={1}>{`${sum.position} · ${sum.phaseName}`}</Text>
      <MetaLine items={[sum.who, sum.model]} />
    </Pressable>
  );
}

function HowItWorks() {
  const { colors, type } = useUIKit();
  const steps = [
    ['Split the work into phases', ' — each with its own brief, agent, model and gate checks.'],
    ['Any agent per phase', ': Claude Code, Codex, OpenCode, Gemini CLI, Grok Build or a gateway agent, with an optional fallback when a CLI is missing or logged out.'],
    ['A phase completes only when', ' the run is verified and every gate check passes — never just because the process exited.'],
    ['Failures block with a fix', ': failed attempts retry in the same session up to the limit, then the entry blocks with a concrete fix. The queue survives gateway restarts.'],
  ];
  return (
    <Section title="How phased entries work">
      {steps.map(([b, rest], i) => (
        <View key={b} style={[st.row, { alignItems: 'flex-start', marginBottom: SPACE.sm, flexWrap: 'nowrap' }]}>
          <Text style={[type.monoSmall, { color: colors.primary, width: 18 }]}>{i + 1}.</Text>
          <Text style={[type.small, { color: colors.textSecondary, flex: 1 }]}>
            <Text style={{ color: colors.text, fontWeight: '700' }}>{b}</Text>
            {rest}
          </Text>
        </View>
      ))}
    </Section>
  );
}

function EntryDetail({
  d, detailError, busy, now, connected, onBack, onControl, retryOpen, setRetryOpen, retry, setRetry, logs, onToggleLogs, onCopy, notice,
}) {
  const { colors, type } = useUIKit();
  if (!d) {
    return (
      <Section>
        {onBack ? <Button title="All entries" icon="chevron-back" variant="ghost" size="sm" onPress={onBack} style={{ alignSelf: 'flex-start' }} /> : null}
        {detailError ? <Msg>{detailError}</Msg> : (
          <>
            <Skeleton height={22} style={{ marginTop: SPACE.sm }} />
            <Skeleton height={90} style={{ marginTop: SPACE.md }} />
          </>
        )}
      </Section>
    );
  }
  const e = d.entry;
  const cap = M.entryCapabilities(e);
  const busyAny = busy !== null;
  const phaseName = e.phaseSpec?.[e.currentPhaseIdx]?.name ?? `phase ${e.currentPhaseIdx + 1}`;
  const worktrees = Object.entries(e.worktrees ?? {});
  const banner = M.entryBanner(e, now);
  const prog = M.phaseProgress(e);
  const key = (method, extra = {}) => method + (extra.force ? ':force' : '');
  const btn = (label, method, extra = {}, variant = 'secondary', confirmText, icon) => (
    <Button
      key={key(method, extra)}
      title={busy === key(method, extra) ? `${label}…` : label}
      icon={icon}
      variant={variant}
      size="sm"
      loading={busy === key(method, extra)}
      disabled={busyAny || !connected}
      onPress={() => onControl(method, extra, confirmText)}
    />
  );
  const from = retry.from < 0 ? e.currentPhaseIdx : retry.from;
  return (
    <>
      <Section tint="primary">
        {onBack ? <Button title="All entries" icon="chevron-back" variant="ghost" size="sm" onPress={onBack} style={{ alignSelf: 'flex-start', marginBottom: SPACE.xs }} /> : null}
        <View style={[st.row, { flexWrap: 'nowrap', alignItems: 'flex-start' }]}>
          <Chip label={M.QUEUE_STATUS_LABEL[e.status] || e.status} tone={M.queueStatusTone(e.status)} dot />
          <Text style={[type.h2, { color: colors.text, flex: 1 }]} accessibilityRole="header">{e.title || e.id}</Text>
        </View>
        <View style={{ marginTop: SPACE.sm, gap: 2 }}>
          <Text selectable style={[type.monoSmall, { color: colors.textMuted }]}>{e.id}</Text>
          <MetaLine
            items={[
              `priority ${e.priority}`,
              `${e.attempts} attempt${e.attempts === 1 ? '' : 's'}`,
              `isolation ${e.isolation}`,
              `created ${M.formatAgo(e.createdAt, now)}`,
              e.startedAt ? `${M.fmtDuration((e.finishedAt ?? now) - e.startedAt)} elapsed` : null,
            ]}
          />
          {e.workdir ? <Text selectable style={[type.monoSmall, { color: colors.textMuted }]}>{e.workdir}</Text> : null}
          {e.dependsOn?.length ? <MetaLine mono items={[`depends on ${e.dependsOn.map((x) => x.slice(0, 8)).join(', ')}`]} /> : null}
          {worktrees.map(([k, w]) => (
            <Text key={k} selectable style={[type.monoSmall, { color: colors.textMuted }]}>{`${k}: ${w.branch} · ${w.path}`}</Text>
          ))}
        </View>
        {banner ? (
          <View style={[s.banner, { borderColor: withAlpha(toneColor(banner.tone, colors), 0.5) }]}>
            <Text style={[type.smallStrong, { color: toneColor(banner.tone, colors) }]}>{banner.title}</Text>
            {banner.text ? <Text style={[type.small, { color: colors.textSecondary }]}>{banner.text}</Text> : null}
            {banner.fix ? (
              <Text style={[type.small, { color: colors.text }]}>
                <Text style={{ color: colors.primary, fontWeight: '700' }}>Fix  </Text>
                {banner.fix}
              </Text>
            ) : null}
            {banner.error ? <Pre tone="danger">{banner.error}</Pre> : null}
          </View>
        ) : null}
        <View style={[st.row, { marginTop: SPACE.sm }]}>
          {cap.pause && e.status === 'running' ? (
            <>
              {cap.pauseRequested ? <Chip label="Pause requested — parks after this attempt" tone="warning" size="sm" /> : btn('Pause', 'queue.pause', {}, 'secondary', undefined, 'pause')}
              {btn('Force pause', 'queue.pause', { force: true }, 'outline', 'Stop the running attempt now? It will not count against the attempt limit.', 'hand-left-outline')}
            </>
          ) : cap.pause ? btn('Pause', 'queue.pause', {}, 'secondary', undefined, 'pause') : null}
          {cap.resume ? btn('Resume', 'queue.resume', {}, 'primary', undefined, 'play') : null}
          {cap.retry ? (
            <Button
              title="Retry…"
              icon="refresh"
              variant={e.status === 'paused' ? 'secondary' : 'primary'}
              size="sm"
              disabled={busyAny}
              onPress={() => setRetryOpen(!retryOpen)}
            />
          ) : null}
          {cap.skip ? btn('Skip phase', 'queue.advance', { reason: 'operator skip from UI' }, 'outline', `Skip "${phaseName}" and advance to the next phase? This is recorded in the audit log.`, 'play-skip-forward-outline') : null}
          {cap.cancel ? btn('Cancel', 'queue.cancel', { reason: 'canceled from UI' }, 'danger', `Cancel "${e.title || e.id}"? The running attempt is stopped.`, 'close-circle-outline') : null}
        </View>
        {cap.reorder ? (
          <View style={[st.row, { marginTop: SPACE.sm }]} accessibilityLabel="Priority">
            <Text style={[type.caption, { color: colors.textMuted }]}>Priority</Text>
            <IconButton icon="arrow-up" size="sm" variant="solid" disabled={busyAny || e.priority >= 1000} onPress={() => onControl('queue.reorder', { priority: Math.min(1000, e.priority + 1) })} accessibilityLabel="Raise priority" />
            <Text style={[type.mono, { color: colors.text }]}>{`P${e.priority}`}</Text>
            <IconButton icon="arrow-down" size="sm" variant="solid" disabled={busyAny || e.priority <= -1000} onPress={() => onControl('queue.reorder', { priority: Math.max(-1000, e.priority - 1) })} accessibilityLabel="Lower priority" />
          </View>
        ) : null}
        {retryOpen && cap.retry ? (
          <View style={[s.retry, { borderColor: colors.borderSubtle }]}>
            <Label>Instruction for the next attempt (optional)</Label>
            <TextBox
              multiline
              rows={2}
              value={retry.instruction}
              onChangeText={(v) => setRetry({ ...retry, instruction: v })}
              placeholder="e.g. Use the existing auth helper instead of adding a new one"
              label="Retry instruction"
            />
            <View style={st.grid}>
              <Select
                label="Agent"
                value={retry.agent}
                options={[
                  { value: '', label: `Same (${e.phaseSpec?.[from]?.agent ?? 'claude-code'})` },
                  ...M.RETRY_AGENTS.map((a) => ({ value: a, label: a })),
                ]}
                onChange={(v) => setRetry({ ...retry, agent: v })}
              />
              <View style={{ flex: 1, minWidth: 140 }}>
                <Text style={[type.caption, { color: colors.textMuted, marginBottom: 2 }]}>Model</Text>
                <TextBox mono value={retry.model} onChangeText={(v) => setRetry({ ...retry, model: v })} placeholder={e.phaseSpec?.[from]?.model ?? 'default'} label="Retry model" />
              </View>
            </View>
            <Select
              label="From"
              value={from}
              options={(e.phaseSpec || []).map((p, i) => ({ value: i, label: `${i + 1}. ${p.name}` }))}
              onChange={(v) => setRetry({ ...retry, from: Number(v) })}
            />
            <ToggleRow label="Fresh session" value={retry.fresh} onChange={(v) => setRetry({ ...retry, fresh: v })} />
            <Button
              title={busy === 'queue.retry' ? 'Retrying…' : 'Retry now'}
              icon="refresh"
              loading={busy === 'queue.retry'}
              disabled={busyAny}
              onPress={() => onControl('queue.retry', M.buildRetryParams(e, retry))}
            />
          </View>
        ) : null}
        <Msg>{detailError}</Msg>
        <Msg tone="success">{notice}</Msg>
      </Section>

      {e.briefMd ? (
        <Section title="Brief">
          <Collapsible title={String(e.briefMd).split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 120) || 'Brief'}>
            <Pre>{e.briefMd}</Pre>
          </Collapsible>
        </Section>
      ) : null}

      <Section
        title="Phases"
        right={<Text style={[type.monoSmall, { color: colors.textMuted }]}>{`${prog.current}/${prog.total}`}</Text>}
      >
        {(e.phaseSpec || []).map((p, i) => (
          <PhaseCard
            key={i}
            e={e}
            p={p}
            i={i}
            attempts={(d.attempts || []).filter((a) => a.phaseIdx === i)}
            now={now}
            logs={logs}
            onToggleLogs={onToggleLogs}
            onCopy={onCopy}
            last={i === (e.phaseSpec || []).length - 1}
          />
        ))}
      </Section>

      <Section>
        <Collapsible title={`Events (${(d.events || []).length})`}>
          {(d.events || []).length ? (
            M.sortEventsDesc(d.events).map((ev) => (
              <View key={ev.seq} style={s.event}>
                <Text style={[type.monoSmall, { color: colors.textMuted }]}>
                  {`${new Date(ev.ts).toLocaleTimeString()}  ${ev.kind}${ev.phaseIdx !== null && ev.phaseIdx !== undefined ? ` · p${ev.phaseIdx + 1}` : ''}`}
                </Text>
                <Text selectable style={[type.small, { color: colors.textSecondary }]}>{ev.message}</Text>
              </View>
            ))
          ) : (
            <Text style={[type.small, { color: colors.textMuted }]}>No events.</Text>
          )}
        </Collapsible>
      </Section>
    </>
  );
}

function PhaseCard({ e, p, i, attempts, now, logs, onToggleLogs, onCopy, last }) {
  const { colors, type } = useUIKit();
  const stt = M.phaseState(e, i);
  const tone = M.phaseStateTone(stt);
  const c = toneColor(tone, colors);
  const gates = M.gateList(p.gateCriteria);
  return (
    <View style={s.phase}>
      <View style={s.rail}>
        <View style={[s.railDot, { borderColor: c, backgroundColor: stt === 'done' ? withAlpha(c, 0.2) : 'transparent' }]}>
          {stt === 'done' ? <Ionicons name="checkmark" size={13} color={c} /> : <Text style={[type.monoSmall, { color: c }]}>{i + 1}</Text>}
        </View>
        {!last ? <View style={[s.railLine, { backgroundColor: colors.borderSubtle }]} /> : null}
      </View>
      <View style={{ flex: 1, paddingBottom: SPACE.md, gap: SPACE.xs }}>
        <View style={[st.row]}>
          <Text style={[type.bodyStrong, { color: colors.text, flexShrink: 1 }]}>{p.name}</Text>
          <Chip label={M.phaseStateLabel(e, stt)} tone={tone} size="sm" />
        </View>
        <MetaLine
          items={[
            `${M.agentLabel(p.agent)}${p.model ? ` · ${p.model}` : ''}`,
            p.fallbackAgent ? `fallback ${M.agentLabel(p.fallbackAgent)}` : null,
            `max ${p.maxAttempts ?? 3}`,
            M.fmtDuration((p.timeoutSec ?? 1800) * 1000),
          ]}
        />
        {p.brief ? (
          <Collapsible title={String(p.brief).split('\n')[0].slice(0, 100)}>
            <Text selectable style={[type.small, { color: colors.textSecondary }]}>{p.brief}</Text>
          </Collapsible>
        ) : null}
        {gates.length ? (
          <View style={st.row}>
            {gates.map((g, gi) => (
              <View key={gi} style={[s.gate, { borderColor: colors.borderSubtle }]}>
                <Text style={[g.type === 'llm' ? type.caption : type.monoSmall, { color: colors.textSecondary }]} numberOfLines={3}>{M.describeGate(g)}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {attempts.length ? (
          M.sortAttemptsDesc(attempts).map((a) => (
            <AttemptRow key={a.id} a={a} now={now} log={logs[a.id]} onToggleLogs={onToggleLogs} onCopy={onCopy} />
          ))
        ) : stt === 'active' ? (
          <Text style={[type.caption, { color: colors.textMuted }]}>Waiting for the first attempt…</Text>
        ) : null}
      </View>
    </View>
  );
}

function AttemptRow({ a, now, log, onToggleLogs, onCopy }) {
  const { colors, type } = useUIKit();
  const running = a.endedAt === null;
  const dur = (a.endedAt ?? now) - a.startedAt;
  const tone = M.attemptOutcomeTone(a.outcome);
  const model = M.attemptModelLabel(a);
  const gs = M.gatePassSummary(a.gate);
  return (
    <View style={[s.attempt, { borderColor: withAlpha(toneColor(tone, colors), 0.35) }]}>
      <View style={st.row}>
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>#{a.n}</Text>
        <Chip label={M.PHASE_OUTCOME_LABEL[a.outcome] ?? a.outcome} tone={tone} size="sm" />
        <View style={{ flex: 1 }} />
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>{`${running ? 'running ' : ''}${M.fmtDuration(dur)}`}</Text>
      </View>
      <Text style={[type.caption, { color: colors.textSecondary }]}>
        {`${M.agentLabel(a.agent)}${a.backend && M.agentLabel(a.backend) !== M.agentLabel(a.agent) ? ` (${a.backend})` : ''}${model ? ` · ${model}` : ''}`}
      </Text>
      <View style={st.row}>
        {a.verdict ? <Chip label={a.verdict} tone={M.verdictTone(a.verdict)} size="sm" /> : null}
        {gs ? <Chip label={`gate ${gs.pass ? 'pass' : 'fail'} ${gs.passed}/${gs.total}`} tone={gs.pass ? 'success' : 'danger'} size="sm" /> : null}
        {a.resumedSession ? <Chip label="resumed" size="sm" /> : null}
        {a.fallbackFrom ? <Chip label={`fallback from ${M.agentLabel(a.fallbackFrom)}`} tone="warning" size="sm" /> : null}
        {!a.counted && !running ? <Chip label="not counted" size="sm" /> : null}
        {a.exitCode !== null && a.exitCode !== undefined ? <Chip label={`exit ${a.exitCode}`} size="sm" /> : null}
        {a.sessionId ? <Chip label={a.sessionId.slice(0, 8)} icon="copy-outline" size="sm" onPress={() => onCopy(a.sessionId)} /> : null}
        <Button title={log ? 'Hide logs' : 'Logs'} icon="document-text-outline" variant="ghost" size="sm" onPress={() => onToggleLogs(a.id)} />
      </View>
      {a.verdictReasons?.length ? (
        <View style={{ gap: 2 }}>
          {a.verdictReasons.map((r, i) => (
            <Text key={i} style={[type.caption, { color: colors.textSecondary }]}>{`•  ${r}`}</Text>
          ))}
        </View>
      ) : null}
      {a.gate?.results?.length ? (
        a.gate.results.map((r, i) => (
          <Collapsible
            key={r.checkId || i}
            title={
              <View style={st.row}>
                <Dot tone={r.pass ? 'success' : 'danger'} />
                <Text style={[type.caption, { color: r.pass ? colors.success : colors.error }]}>{r.pass ? 'pass' : 'fail'}</Text>
                <Text style={[type.caption, { color: colors.textSecondary, flexShrink: 1 }]}>{r.label}</Text>
              </View>
            }
          >
            <Pre tone={r.pass ? undefined : 'danger'}>{r.output || '(no output)'}</Pre>
          </Collapsible>
        ))
      ) : null}
      {a.error ? <Pre tone="danger">{a.error}</Pre> : null}
      {log ? (
        <View style={{ gap: SPACE.xs }}>
          {log.tmuxAttach ? (
            <>
              <Text style={[type.caption, { color: colors.textMuted }]}>Live terminal:</Text>
              <Pre>{log.tmuxAttach}</Pre>
            </>
          ) : null}
          {log.error ? <Msg>{log.error}</Msg> : (
            <>
              <Pre>{log.loading && !log.text ? 'Loading…' : log.text.trim() ? log.text.slice(-12000) : '(no output captured)'}</Pre>
              {log.source && !log.loading ? <Text style={[type.caption, { color: colors.textMuted }]}>{`source: ${log.source}`}</Text> : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  pad: { padding: SPACE.md, paddingBottom: SPACE.xxl * 2 },
  split: { flex: 1, flexDirection: 'row' },
  colLeft: { flex: 1, maxWidth: 520 },
  colRight: { flex: 1.3 },
  row: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.sm },
  phaseBox: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, gap: SPACE.sm },
  banner: { borderWidth: 1, borderRadius: RADIUS.sm, padding: SPACE.sm, gap: SPACE.xs, marginTop: SPACE.sm },
  retry: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, gap: SPACE.sm, marginTop: SPACE.sm },
  phase: { flexDirection: 'row', gap: SPACE.sm },
  rail: { width: 26, alignItems: 'center' },
  railDot: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  railLine: { width: 1, flex: 1, marginTop: 2 },
  gate: { borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.sm, paddingVertical: 4, maxWidth: '100%' },
  attempt: { borderWidth: 1, borderRadius: RADIUS.sm, padding: SPACE.sm, gap: SPACE.xs },
  event: { paddingVertical: SPACE.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.06)' },
});

export default PhasesTab;
