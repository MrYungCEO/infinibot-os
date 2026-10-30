/**
 * ScheduledTab — native mirror of <autonomy-scheduled-view> (web /autonomy?tab=scheduled).
 *
 *   list    → scheduledTasks.list (+ New task form)
 *   detail  → scheduledTasks.get (runs) + scheduledTasks.items.list (work items)
 *             item stage log → scheduledTasks.items.get
 *   actions → scheduledTasks.runNow / update (pause-enable, edit) / delete / create
 *             scheduledTasks.approvals.decide (per item + approve all low-risk)
 *   live    → scheduledTask.changed / goal.changed + 8 s poll while anything is in flight
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS, Button, IconButton, Chip, EmptyState, Skeleton, toneColor } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import * as M from './goals-model';
import {
  Section, Collapsible, Pre, Msg, Label, TextBox, Select, ToggleRow, MetaLine, LoadState,
  confirmAsync, useFlash, useGatewayEvents, useInterval, targetOptions, st,
} from './shared';

export function ScheduledTab({ gateway, focusId, wide, registerBack, navigation, reloadSignal }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';

  const [tasks, setTasks] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState(focusId || null);
  const [mobileDetail, setMobileDetail] = useState(Boolean(focusId));
  const [runs, setRuns] = useState([]);
  const [items, setItems] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [agents, setAgents] = useState([]);
  const [draft, setDraftState] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, flash, setNotice] = useFlash(4000);
  const [openItem, setOpenItem] = useState(null);
  const [itemEvents, setItemEvents] = useState({});
  const [instructionFor, setInstructionFor] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [now, setNow] = useState(Date.now());

  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const openRef = useRef(openItem);
  openRef.current = openItem;

  const loadEvents = useCallback(async (itemId) => {
    try {
      const r = await sendReq('scheduledTasks.items.get', { itemId });
      setItemEvents((m) => ({ ...m, [itemId]: r?.events ?? [] }));
    } catch { /* item gone */ }
  }, [sendReq]);

  const loadDetail = useCallback(async (id) => {
    if (!sendReq || !id) return;
    setDetailLoading(true);
    try {
      const [d, it] = await Promise.all([
        sendReq('scheduledTasks.get', { id }),
        sendReq('scheduledTasks.items.list', { taskId: id, limit: 200 }),
      ]);
      if (selRef.current !== id) return;
      setRuns(d?.runs ?? []);
      setItems(it?.items ?? []);
      if (openRef.current) loadEvents(openRef.current);
    } catch (err) {
      setError(M.errMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }, [sendReq, loadEvents]);

  const refresh = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('scheduledTasks.list', {});
      const list = res?.tasks ?? [];
      setTasks(list);
      setLoadErr(null);
      let sel = selRef.current;
      if (sel && !list.some((t) => t.id === sel)) sel = null;
      if (!sel && list.length) sel = list[0].id;
      if (sel !== selRef.current) { selRef.current = sel; setSelectedId(sel); }
      if (sel) await loadDetail(sel);
    } catch (err) {
      setLoadErr(err);
    }
  }, [sendReq, loadDetail]);

  const loadAgents = useCallback(async () => {
    if (!sendReq) return;
    try { setAgents(M.normalizeAgents(await sendReq('agents.list', {}))); } catch { setAgents([]); }
  }, [sendReq]);

  useEffect(() => {
    if (connected) { refresh(); loadAgents(); }
  }, [connected, refresh, loadAgents]);

  useEffect(() => { if (focusId) selectTask(focusId); }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (reloadSignal) refresh(); }, [reloadSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useGatewayEvents(gateway, ['scheduledTask.changed', 'goal.changed'], refresh);
  useInterval(() => {
    setNow(Date.now());
    if (connected && M.scheduledHasInFlight(items, runs)) refresh();
  }, 8000);

  function selectTask(id) {
    selRef.current = id;
    setSelectedId(id);
    setOpenItem(null);
    setInstructionFor(null);
    setMobileDetail(true);
    setDraftState(null);
    setRuns([]);
    setItems([]);
    loadDetail(id);
  }

  const closeDetail = () => { setMobileDetail(false); setDraftState(null); };

  useEffect(() => {
    registerBack?.(() => {
      if (!wide && (mobileDetail || draft)) { closeDetail(); return true; }
      if (wide && draft) { setDraftState(null); return true; }
      return false;
    });
  });

  const onPull = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const act = async (key, fn, ok) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (ok) flash(ok);
      await refresh();
    } catch (err) {
      setError(M.errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // ── decisions ─────────────────────────────────────────────────────────
  const decide = (item, action) => {
    if (M.actionNeedsInstruction(action)) {
      setInstructionFor({ id: item.id, action });
      setInstruction('');
      setOpenItem(item.id);
      loadEvents(item.id);
      return;
    }
    act(`${item.id}:${action}`, () => sendReq('scheduledTasks.approvals.decide', { itemId: item.id, action }), `${item.item.title}: ${M.ACTION_LABEL[action].toLowerCase()}`);
  };

  const submitInstruction = (item) => {
    const text = instruction.trim();
    const pending = instructionFor;
    if (!text || !pending) return;
    act(
      `${item.id}:${pending.action}`,
      async () => {
        await sendReq('scheduledTasks.approvals.decide', { itemId: item.id, action: pending.action, instruction: text });
        setInstructionFor(null);
        setInstruction('');
      },
      pending.action === 'modify' ? 'Approved with your changes' : 'Sent to the agent',
    );
  };

  const approveLowRisk = (runId, n) => act(
    `lowrisk:${runId}`,
    () => sendReq('scheduledTasks.approvals.decide', { runId, action: 'approve_low_risk' }),
    `Approved ${n} low-risk item(s)`,
  );

  // ── form ──────────────────────────────────────────────────────────────
  const setDraft = (patch) => setDraftState((d) => (d ? { ...d, ...patch } : d));
  const setRepo = (i, patch) => setDraftState((d) => (d ? { ...d, repos: d.repos.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : d));
  const newTask = () => { setDraftState(M.emptyTaskDraft()); setMobileDetail(true); setError(null); };
  const editTask = (t) => { setDraftState(M.taskToDraft(t)); setMobileDetail(true); setError(null); };

  const saveDraft = async (runNow = false) => {
    const d = draft;
    if (!d) return;
    const built = M.buildTaskBody(d);
    if (built.error) { setError(built.error); return; }
    await act(
      'save',
      async () => {
        let id = d.id;
        if (d.id) {
          await sendReq('scheduledTasks.update', { id: d.id, patch: built.body });
          if (runNow) await sendReq('scheduledTasks.runNow', { id: d.id });
        } else {
          const res = await sendReq('scheduledTasks.create', { ...built.body, runNow });
          id = res?.id || null;
        }
        selRef.current = id;
        setSelectedId(id);
        setDraftState(null);
      },
      M.saveNotice(d, runNow),
    );
  };

  const task = (tasks || []).find((t) => t.id === selectedId) || null;
  const waiting = M.totalAwaiting(tasks || []);

  // ── list ──────────────────────────────────────────────────────────────
  const list = (
    <Section
      title="Scheduled"
      right={<Button title="New task" icon="add" size="sm" onPress={newTask} disabled={!connected} />}
    >
      <Text style={[type.caption, { color: colors.textMuted, marginBottom: SPACE.sm }]}>
        {`${(tasks || []).length} task${(tasks || []).length === 1 ? '' : 's'}`}
        {waiting ? <Text style={{ color: colors.warning }}>{`  ·  ${waiting} waiting for you`}</Text> : null}
      </Text>
      {tasks === null && !loadErr ? (
        <View style={{ gap: SPACE.sm }}>
          <Skeleton height={70} />
          <Skeleton height={70} />
        </View>
      ) : loadErr ? (
        <LoadState error={loadErr} onRetry={refresh} unavailableTitle="Scheduled tasks are not available on this gateway" />
      ) : tasks.length === 0 ? (
        <EmptyState compact icon="calendar-outline" title="No scheduled tasks yet" actionLabel="New scheduled task" onAction={newTask} />
      ) : (
        <View style={{ gap: SPACE.xs }}>
          {tasks.map((t) => (
            <TaskRow key={t.id} t={t} selected={t.id === selectedId && !draft} onPress={() => selectTask(t.id)} now={now} />
          ))}
        </View>
      )}
    </Section>
  );

  const backBtn = !wide ? (
    <Button title="All scheduled tasks" icon="chevron-back" variant="ghost" size="sm" onPress={closeDetail} style={{ alignSelf: 'flex-start', marginBottom: SPACE.sm }} />
  ) : null;

  const messages = (
    <>
      <Msg>{error}</Msg>
      <Msg tone="success" onPress={() => setNotice(null)}>{notice}</Msg>
    </>
  );

  let right;
  if (draft) {
    right = (
      <>
        {backBtn}
        {messages}
        <TaskForm
          d={draft}
          agents={agents}
          busy={busy === 'save'}
          setDraft={setDraft}
          setRepo={setRepo}
          onCancel={() => { setDraftState(null); if (!wide) setMobileDetail(false); }}
          onSave={saveDraft}
        />
      </>
    );
  } else if (task) {
    right = (
      <>
        {backBtn}
        {messages}
        <TaskDetail
          t={task}
          runs={runs}
          items={items}
          loading={detailLoading && !items.length && !runs.length}
          busy={busy}
          now={now}
          onRunNow={() => act('run', () => sendReq('scheduledTasks.runNow', { id: task.id }), 'Review started')}
          onToggle={() => act('toggle', () => sendReq('scheduledTasks.update', { id: task.id, patch: { enabled: !task.enabled } }), task.enabled ? 'Paused' : 'Enabled')}
          onEdit={() => editTask(task)}
          onDelete={async () => {
            if (await confirmAsync('Delete task', `Delete "${task.name}" and its history?`, 'Delete')) {
              act('delete', () => sendReq('scheduledTasks.delete', { id: task.id }), 'Deleted');
              if (!wide) setMobileDetail(false);
            }
          }}
          onLowRisk={approveLowRisk}
          openItem={openItem}
          onToggleItem={(id) => {
            const open = openItem === id;
            setOpenItem(open ? null : id);
            if (!open) loadEvents(id);
          }}
          itemEvents={itemEvents}
          instructionFor={instructionFor}
          instruction={instruction}
          setInstruction={setInstruction}
          onCancelInstruction={() => setInstructionFor(null)}
          onSubmitInstruction={submitInstruction}
          onDecide={decide}
          navigation={navigation}
        />
      </>
    );
  } else {
    right = (
      <>
        {messages}
        <Intro onNew={newTask} />
      </>
    );
  }

  const refreshCtl = <RefreshControl refreshing={refreshing} onRefresh={onPull} tintColor={colors.primary} />;

  if (wide) {
    return (
      <View style={s.split}>
        <ScrollView style={s.colLeft} contentContainerStyle={s.pad} refreshControl={refreshCtl}>
          {list}
        </ScrollView>
        <ScrollView style={s.colRight} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
          {right}
        </ScrollView>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={s.pad} refreshControl={refreshCtl} keyboardShouldPersistTaps="handled">
      {mobileDetail || draft ? right : (
        <>
          {messages}
          {list}
          {tasks && tasks.length === 0 ? <Intro onNew={newTask} /> : null}
        </>
      )}
    </ScrollView>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────

function Intro({ onNew }) {
  const { colors, type } = useUIKit();
  return (
    <Section title="Scheduled agent tasks" tint="primary">
      <Text style={[type.h3, { color: colors.text, marginBottom: SPACE.xs }]}>Let an agent review your repos on a schedule</Text>
      <Text style={[type.small, { color: colors.textSecondary, marginBottom: SPACE.md }]}>
        Each run is read-only: the agent checks repo health and suggests work items with a dev plan, verification checks and a
        deploy plan. You approve items here or in Telegram. Approved items are built by a verified goal run in their own git
        worktree, then wait for your deploy approval.
      </Text>
      <Button title="New scheduled task" icon="add" onPress={onNew} />
    </Section>
  );
}

function TaskRow({ t, selected, onPress, now }) {
  const { colors, type } = useUIKit();
  const last = t.lastRun;
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
      accessibilityLabel={`${t.name}, ${t.enabled ? 'on' : 'paused'}`}
      accessibilityState={{ selected }}
    >
      <View style={[st.row, { flexWrap: 'nowrap' }]}>
        <Text style={[type.bodyStrong, { color: colors.text, flex: 1 }]} numberOfLines={2}>{t.name}</Text>
        <Chip label={t.enabled ? 'On' : 'Paused'} tone={t.enabled ? 'success' : 'neutral'} dot size="sm" />
      </View>
      <MetaLine items={[t.scheduleText, M.scheduledTargetLabel(t.assignee)]} />
      <Text style={[type.caption, { color: colors.textMuted }]}>
        {`Next: ${t.enabled ? M.whenText(t.nextRunAt, t.timezone) : '—'}  ·  `}
        {last ? (
          <Text style={{ color: last.status === 'failed' ? colors.error : colors.textMuted }}>
            {`Last: ${last.status}${last.items !== null && last.items !== undefined ? ` · ${last.items} items` : ''} · ${M.formatAgo(last.createdAt, now)}`}
          </Text>
        ) : 'Never run'}
      </Text>
      {t.counts?.awaitingDecision || t.counts?.inFlight ? (
        <View style={st.row}>
          {t.counts.awaitingDecision ? <Chip label={`${t.counts.awaitingDecision} need you`} tone="warning" size="sm" /> : null}
          {t.counts.inFlight ? <Chip label={`${t.counts.inFlight} in flight`} tone="primary" size="sm" /> : null}
          {t.counts.deployed ? <Chip label={`${t.counts.deployed} deployed`} tone="success" size="sm" /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function TaskDetail({
  t, runs, items, loading, busy, now, onRunNow, onToggle, onEdit, onDelete, onLowRisk, openItem, onToggleItem, itemEvents,
  instructionFor, instruction, setInstruction, onCancelInstruction, onSubmitInstruction, onDecide, navigation,
}) {
  const { colors, type } = useUIKit();
  const { needs, flight, done } = useMemo(() => M.groupItems(items), [items]);
  const running = M.runningRun(runs);
  const low = M.lowRiskBatch(needs);
  const [showAllNeeds, setShowAllNeeds] = useState(false);
  const NEEDS_PAGE = 20;
  const needsShown = showAllNeeds ? needs : needs.slice(0, NEEDS_PAGE);
  const itemProps = { t, busy, openItem, onToggleItem, itemEvents, instructionFor, instruction, setInstruction, onCancelInstruction, onSubmitInstruction, onDecide };
  return (
    <>
      <Section tint="primary">
        <Text style={[type.label, { color: colors.primary }]}>{t.scheduleText}</Text>
        <Text style={[type.h2, { color: colors.text, marginTop: 2 }]} accessibilityRole="header">{t.name}</Text>
        <View style={{ marginTop: SPACE.xs, gap: 2 }}>
          <MetaLine items={[M.scheduledTargetLabel(t.assignee), `Next: ${t.enabled ? M.whenText(t.nextRunAt, t.timezone) : 'paused'}`]} />
          <MetaLine items={[`Delivery: ${(t.delivery || []).join(' + ')}`, t.approval?.requireDeployApproval ? 'Deploy needs approval' : 'Auto-deploy after checks']} />
          {t.deployCommand ? <Text selectable style={[type.monoSmall, { color: colors.textMuted }]}>{`$ ${t.deployCommand}`}</Text> : null}
        </View>
        <View style={[st.row, { marginTop: SPACE.sm }]}>
          <Button title={running ? 'Reviewing…' : 'Run now'} icon="play" size="sm" disabled={Boolean(running) || busy === 'run'} loading={busy === 'run'} onPress={onRunNow} />
          <Button title={t.enabled ? 'Pause' : 'Enable'} icon={t.enabled ? 'pause' : 'power'} variant="secondary" size="sm" loading={busy === 'toggle'} onPress={onToggle} />
          <Button title="Edit" icon="create-outline" variant="outline" size="sm" onPress={onEdit} />
          <Button title="Delete" icon="trash-outline" variant="danger" size="sm" loading={busy === 'delete'} onPress={onDelete} />
        </View>
        {t.repos?.length ? (
          <View style={[st.row, { marginTop: SPACE.sm }]}>
            {t.repos.map((r) => (
              <View key={r.path} style={[s.repo, { borderColor: colors.borderSubtle }]}>
                <Text style={[type.smallStrong, { color: colors.text }]}>{r.label || r.path}</Text>
                {r.branch ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>{r.branch}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}
        {t.instructions ? (
          <Collapsible title="Review focus">
            <Text selectable style={[type.small, { color: colors.textSecondary }]}>{t.instructions}</Text>
          </Collapsible>
        ) : null}
      </Section>

      {running ? (
        <Section tint="primary">
          <View style={[st.row, { flexWrap: 'nowrap', alignItems: 'flex-start' }]}>
            <Ionicons name="pulse" size={18} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={[type.smallStrong, { color: colors.text }]}>Review in progress</Text>
              <Text style={[type.caption, { color: colors.textMuted }]}>
                {`Read-only run ${running.id}${running.goalId ? ` · goal ${running.goalId}` : ''} · started ${M.formatAgo(running.createdAt, now)}. The report arrives here${(t.delivery || []).includes('telegram') ? ' and in Telegram' : ''}.`}
              </Text>
            </View>
          </View>
        </Section>
      ) : null}

      <Section
        title={`Needs you  ${needs.length}`}
        right={low ? (
          <Button title={`Approve all low-risk (${low.n})`} size="sm" variant="secondary" loading={busy === `lowrisk:${low.runId}`} onPress={() => onLowRisk(low.runId, low.n)} />
        ) : null}
      >
        {loading ? <Skeleton height={80} /> : needs.length ? (
          <View style={{ gap: SPACE.sm }}>
            {needsShown.map((i) => <WorkItem key={i.id} i={i} {...itemProps} />)}
            {needs.length > NEEDS_PAGE && !showAllNeeds ? (
              <Button title={`Show all ${needs.length}`} variant="ghost" size="sm" onPress={() => setShowAllNeeds(true)} />
            ) : null}
          </View>
        ) : (
          <Text style={[type.small, { color: colors.textMuted }]}>Nothing waiting for a decision.</Text>
        )}
      </Section>

      {flight.length ? (
        <Section title={`In flight  ${flight.length}`}>
          <View style={{ gap: SPACE.sm }}>{flight.map((i) => <WorkItem key={i.id} i={i} {...itemProps} />)}</View>
        </Section>
      ) : null}

      <Section title={`Run history  ${runs.length}`}>
        {runs.length ? runs.map((r) => <RunRow key={r.id} r={r} now={now} navigation={navigation} />) : (
          <Text style={[type.small, { color: colors.textMuted }]}>No runs yet — use Run now to try it.</Text>
        )}
      </Section>

      {done.length ? (
        <Section title={`Closed & snoozed  ${done.length}`}>
          <Collapsible title={`Show ${done.length} closed item${done.length === 1 ? '' : 's'}`}>
            <View style={{ gap: SPACE.sm }}>{done.map((i) => <WorkItem key={i.id} i={i} {...itemProps} />)}</View>
          </Collapsible>
        </Section>
      ) : null}
    </>
  );
}

function Stepper({ stage, label }) {
  const { colors, type } = useUIKit();
  const steps = M.stepperStates(stage);
  return (
    <View style={s.stepper} accessibilityLabel={`Pipeline stage: ${label}`}>
      {steps.map((stp, idx) => {
        const c = stp.state === 'done' ? colors.success : stp.state === 'now' ? colors.primary : stp.state === 'fail' ? colors.error : stp.state === 'off' ? colors.textMuted : withAlpha(colors.text || '#fff', 0.2);
        const on = stp.state !== 'todo';
        return (
          <View key={stp.label} style={s.step}>
            <View style={[s.stepBar, { backgroundColor: c }]} />
            {on && (stp.state !== 'done' || idx === steps.length - 1 || steps[idx + 1]?.state === 'todo') ? (
              <Text style={[type.caption, { color: c }]} numberOfLines={1}>{stp.label}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function WorkItem({
  i, t, busy, openItem, onToggleItem, itemEvents, instructionFor, instruction, setInstruction, onCancelInstruction, onSubmitInstruction, onDecide,
}) {
  const { colors, type } = useUIKit();
  const w = i.item || {};
  const open = openItem === i.id;
  const events = itemEvents[i.id];
  const asking = instructionFor?.id === i.id ? instructionFor : null;
  return (
    <View style={[s.item, { borderColor: withAlpha(toneColor(M.stageTone(i.stage), colors), 0.35) }]}>
      <Pressable
        onPress={() => onToggleItem(i.id)}
        style={({ pressed }) => [st.row, { flexWrap: 'nowrap', alignItems: 'flex-start', minHeight: 44, opacity: pressed ? 0.8 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={`${w.title}. ${open ? 'Collapse' : 'Expand'} details`}
      >
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={16} color={colors.textMuted} style={{ marginTop: 2 }} />
        <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]}>{w.title}</Text>
        <Chip label={i.stageLabel || i.stage} tone={M.stageTone(i.stage)} size="sm" />
      </Pressable>
      <View style={st.row}>
        {w.priority ? <Chip label={w.priority} tone="primary" size="sm" /> : null}
        {w.effort ? <Chip label={`Effort ${w.effort}`} size="sm" /> : null}
        {w.risk ? <Chip label={`${w.risk} risk`} tone={M.riskTone(w.risk)} size="sm" /> : null}
        {w.repo ? <Chip label={w.repo} size="sm" /> : null}
        {i.snoozeUntil ? <Chip label={`until ${M.whenText(i.snoozeUntil, t.timezone)}`} size="sm" /> : null}
      </View>
      {w.why ? <Text style={[type.small, { color: colors.textSecondary }]} numberOfLines={open ? undefined : 4}>{w.why}</Text> : null}
      <Stepper stage={i.stage} label={i.stageLabel} />
      {i.lastError && (i.stage === 'build_failed' || i.stage === 'deploy_failed') ? <Msg>{i.lastError}</Msg> : null}
      {i.stage === 'awaiting_deploy' ? (
        <View style={{ gap: SPACE.xs }}>
          <Text style={[type.label, { color: colors.textMuted }]}>Checks passed</Text>
          <Pre>{i.testEvidence ?? ''}</Pre>
          <Text style={[type.label, { color: colors.textMuted }]}>{`What changed · ${i.branch ?? ''}`}</Text>
          <Pre>{i.diffSummary ?? ''}</Pre>
        </View>
      ) : null}
      {open ? <ItemDetail i={i} events={events} /> : null}
      {asking ? (
        <View style={{ gap: SPACE.sm }}>
          <Label>{asking.action === 'modify' ? 'How should this item change? It will be approved with your changes.' : 'Instruction for the agent'}</Label>
          <TextBox multiline rows={3} value={instruction} onChangeText={setInstruction} label="Instruction" />
          <View style={st.row}>
            <Button title="Cancel" variant="ghost" size="sm" onPress={onCancelInstruction} />
            <Button
              title={asking.action === 'modify' ? 'Approve with changes' : 'Send'}
              size="sm"
              disabled={!instruction.trim()}
              loading={busy === `${i.id}:${asking.action}`}
              onPress={() => onSubmitInstruction(i)}
            />
          </View>
        </View>
      ) : i.actions?.length ? (
        <View style={st.row}>
          {i.actions.map((a) => (
            <Button
              key={a}
              title={M.ACTION_LABEL[a] || a}
              size="sm"
              variant={M.actionVariant(a)}
              loading={busy === `${i.id}:${a}`}
              disabled={Boolean(busy) && busy !== `${i.id}:${a}`}
              onPress={() => onDecide(i, a)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ItemDetail({ i, events }) {
  const { colors, type } = useUIKit();
  const w = i.item || {};
  const H = ({ children }) => <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.sm, marginBottom: 2 }]}>{children}</Text>;
  const Ol = ({ list }) => (list || []).map((x, n) => (
    <Text key={n} style={[type.small, { color: colors.textSecondary }]}>{`${n + 1}. ${x}`}</Text>
  ));
  return (
    <View>
      <H>Dev plan</H>
      <Ol list={w.dev?.steps} />
      {w.files?.length ? <Text selectable style={[type.monoSmall, { color: colors.textMuted, marginTop: 2 }]}>{w.files.join(' · ')}</Text> : null}
      <H>Verification (gates the build)</H>
      {(w.checks || []).map((c, n) => (
        <Text key={n} selectable style={[type.small, { color: colors.textSecondary }]}>
          <Text style={[type.monoSmall, { color: colors.primary }]}>{`${c.type}  `}</Text>
          {M.scheduledCheckText(c)}
        </Text>
      ))}
      <H>Deploy plan</H>
      <Ol list={w.deploy?.steps} />
      {w.deploy?.rollback ? <Text style={[type.caption, { color: colors.textMuted }]}>{`Rollback: ${w.deploy.rollback}`}</Text> : null}
      {w.deploy?.command ? <Text selectable style={[type.monoSmall, { color: colors.textMuted }]}>{`$ ${w.deploy.command}`}</Text> : null}
      {i.instructions?.length ? (
        <>
          <H>Your instructions</H>
          {i.instructions.map((x, n) => <Text key={n} style={[type.small, { color: colors.textSecondary }]}>{`•  ${x}`}</Text>)}
        </>
      ) : null}
      {i.worktreePath ? (
        <Text selectable style={[type.monoSmall, { color: colors.textMuted, marginTop: SPACE.sm }]}>
          {`Worktree ${i.worktreePath}${i.devGoalId ? ` · dev goal ${i.devGoalId}` : ''}${i.deployGoalId ? ` · deploy goal ${i.deployGoalId}` : ''}`}
        </Text>
      ) : null}
      {i.deployOutput ? (
        <>
          <H>Deploy output</H>
          <Pre>{i.deployOutput}</Pre>
        </>
      ) : null}
      <H>Stage log</H>
      {events ? events.map((e) => (
        <View key={e.seq} style={{ marginBottom: 4 }}>
          <Text style={[type.monoSmall, { color: colors.textMuted }]}>{new Date(e.at).toLocaleString()}</Text>
          <Text style={[type.small, { color: colors.text }]}>
            <Text style={{ fontWeight: '700' }}>{`${e.from ? `${e.from} → ` : ''}${e.to}`}</Text>
            <Text style={{ color: colors.textMuted }}>{`  ${e.actor}${e.note ? ` · ${e.note}` : ''}`}</Text>
          </Text>
        </View>
      )) : <Text style={[type.caption, { color: colors.textMuted }]}>Loading…</Text>}
    </View>
  );
}

function RunRow({ r, now, navigation }) {
  const { colors, type } = useUIKit();
  return (
    <View style={[s.run, { borderTopColor: colors.borderSubtle }]}>
      <View style={st.row}>
        <Chip label={r.status} tone={M.runStatusTone(r.status)} dot size="sm" />
        <Text style={[type.caption, { color: colors.textMuted }]}>{`${r.trigger} · ${M.formatAgo(r.createdAt, now)}`}</Text>
        {r.items !== null && r.items !== undefined ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>{`${r.items} items`}</Text> : null}
        {r.reportId && navigation ? (
          <Button
            title="PDF in Reports"
            icon="document-outline"
            variant="ghost"
            size="sm"
            onPress={() => { try { navigation.navigate('ReportsModal', { reportId: r.reportId }); } catch { /* route may not exist */ } }}
          />
        ) : null}
      </View>
      {r.summary ? (
        <Collapsible title={r.summary.slice(0, 140) + (r.summary.length > 140 ? '…' : '')}>
          <Text selectable style={[type.small, { color: colors.textSecondary }]}>{r.summary}</Text>
        </Collapsible>
      ) : null}
      {r.error ? <Msg>{r.error}</Msg> : null}
      {r.readOnlyViolations?.length ? <Msg tone="warning">{`Read-only violation: ${r.readOnlyViolations.join('; ')}`}</Msg> : null}
      {r.deliveryError ? <Msg tone="warning">{`Telegram delivery: ${r.deliveryError}`}</Msg> : null}
    </View>
  );
}

function TaskForm({ d, agents, busy, setDraft, setRepo, onCancel, onSave }) {
  const { colors, type } = useUIKit();
  return (
    <Section title={d.id ? 'Edit scheduled task' : 'New scheduled task'} tint="primary">
      <View style={{ gap: SPACE.md }}>
        <View>
          <Label required>Name</Label>
          <TextBox value={d.name} onChangeText={(v) => setDraft({ name: v })} placeholder="Nightly repo review" label="Name" />
        </View>
        <View>
          <Label>Schedule</Label>
          <View style={st.row}>
            {M.SCHEDULE_PRESETS.map((p) => (
              <Chip key={p.cron} label={p.label} selected={d.cron === p.cron} onPress={() => setDraft({ cron: p.cron })} />
            ))}
          </View>
          <View style={[st.grid, { marginTop: SPACE.sm }]}>
            <View style={{ flex: 1, minWidth: 140 }}>
              <Text style={[type.caption, { color: colors.textMuted, marginBottom: 2 }]}>Cron expression</Text>
              <TextBox mono value={d.cron} onChangeText={(v) => setDraft({ cron: v })} label="Cron expression" />
            </View>
            <View style={{ flex: 1, minWidth: 140 }}>
              <Text style={[type.caption, { color: colors.textMuted, marginBottom: 2 }]}>Timezone</Text>
              <TextBox value={d.timezone} onChangeText={(v) => setDraft({ timezone: v })} placeholder="Asia/Bangkok" label="Timezone" />
            </View>
          </View>
        </View>
        <View style={st.grid}>
          <Select
            label="Assignee"
            value={d.target}
            options={[
              ...M.CLI_TARGETS.map((c) => ({ value: c.id, label: c.label, group: 'Coding CLIs' })),
              ...agents.map((a) => ({ value: `agent:${a.id}`, label: a.name, group: 'Gateway agents' })),
            ]}
            onChange={(v) => setDraft({ target: v })}
          />
          <View style={{ flex: 1, minWidth: 140 }}>
            <Text style={[type.caption, { color: colors.textMuted, marginBottom: 2 }]}>Model (optional)</Text>
            <TextBox mono value={d.model} onChangeText={(v) => setDraft({ model: v })} placeholder="default" label="Model" />
          </View>
        </View>
        <View>
          <Label>Repositories</Label>
          <Text style={[type.caption, { color: colors.textMuted, marginBottom: SPACE.xs }]}>Reviewed read-only; approved work happens in a new worktree.</Text>
          <View style={{ gap: SPACE.sm }}>
            {d.repos.map((r, i) => (
              <View key={i} style={[s.repoEdit, { borderColor: colors.borderSubtle }]}>
                <View style={[st.row, { flexWrap: 'nowrap' }]}>
                  <TextBox value={r.label} onChangeText={(v) => setRepo(i, { label: v })} placeholder="label" label="Repository label" style={{ flex: 1 }} />
                  <IconButton icon="close" size="sm" tone={colors.error} disabled={d.repos.length === 1} onPress={() => setDraft({ repos: d.repos.filter((_, j) => j !== i) })} accessibilityLabel="Remove repository" />
                </View>
                <TextBox mono value={r.path} onChangeText={(v) => setRepo(i, { path: v })} placeholder="/abs/path/to/repo" label="Repository path" />
                <TextBox mono value={r.branch} onChangeText={(v) => setRepo(i, { branch: v })} placeholder="branch (optional)" label="Branch" />
              </View>
            ))}
          </View>
          <Button title="Add repository" icon="add" variant="ghost" size="sm" style={{ alignSelf: 'flex-start', marginTop: SPACE.xs }} onPress={() => setDraft({ repos: [...d.repos, { label: '', path: '', branch: '' }] })} />
        </View>
        <View>
          <Label>What should the review focus on?</Label>
          <TextBox multiline rows={4} value={d.instructions} onChangeText={(v) => setDraft({ instructions: v })} placeholder="e.g. failing CI, security of auth routes, deploy drift vs production" label="Review focus" />
        </View>
        <View>
          <ToggleRow label="Send to Telegram" value={d.telegram} onChange={(v) => setDraft({ telegram: v })} />
          <ToggleRow label="Show here" value={d.ui} onChange={(v) => setDraft({ ui: v })} />
          <ToggleRow label="Start building on approve" value={d.autoContinueOnApprove} onChange={(v) => setDraft({ autoContinueOnApprove: v })} />
          <ToggleRow label="Ask before every deploy" value={d.requireDeployApproval} onChange={(v) => setDraft({ requireDeployApproval: v })} />
          <ToggleRow label="Enabled" value={d.enabled} onChange={(v) => setDraft({ enabled: v })} />
        </View>
        <View>
          <Label>Deploy command (optional)</Label>
          <Text style={[type.caption, { color: colors.textMuted, marginBottom: SPACE.xs }]}>Overrides the agent's proposed deploy commands.</Text>
          <TextBox mono value={d.deployCommand} onChangeText={(v) => setDraft({ deployCommand: v })} placeholder="e.g. pnpm deploy:staging" label="Deploy command" />
        </View>
        <View style={st.row}>
          <Button title="Cancel" variant="ghost" size="sm" onPress={onCancel} />
          <Button title={d.id ? 'Save & run now' : 'Create & run now'} variant="secondary" size="sm" disabled={busy} onPress={() => onSave(true)} />
          <Button title={d.id ? 'Save' : 'Create'} size="sm" loading={busy} onPress={() => onSave(false)} />
        </View>
      </View>
    </Section>
  );
}

const s = StyleSheet.create({
  pad: { padding: SPACE.md, paddingBottom: SPACE.xxl * 2 },
  split: { flex: 1, flexDirection: 'row' },
  colLeft: { flex: 1, maxWidth: 460 },
  colRight: { flex: 1.4 },
  row: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
  repo: { borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.sm, paddingVertical: 4 },
  repoEdit: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, gap: SPACE.sm },
  item: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, gap: SPACE.sm },
  stepper: { flexDirection: 'row', gap: 3 },
  step: { flex: 1, gap: 2 },
  stepBar: { height: 3, borderRadius: 2 },
  run: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: SPACE.sm, gap: SPACE.xs },
});

export default ScheduledTab;
