/**
 * GoalsTab — native mirror of <autonomy-goals-view> (web /autonomy?tab=goals).
 *
 *   composer → goals.create (draft persisted like the web's localStorage draft)
 *   list     → goals.list  (filters All/Active/Done/Failed; live on goal.* events + 5 s poll)
 *   detail   → goals.get / goals.log + pause/resume/recheck/retry/cancel/delete/continue
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  useUIKit, SPACE, RADIUS, Button, IconButton, Chip, Tabs, ProgressBar, EmptyState, Skeleton, ListRow, toneColor,
} from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import * as M from './goals-model';
import {
  Section, Collapsible, Pre, Msg, Label, TextBox, NumBox, Select, ToggleRow, Dot, MetaLine, LoadState,
  confirmAsync, usePersistentDraft, useFlash, useGatewayEvents, useInterval, targetOptions, st,
} from './shared';

const DRAFT_KEY = 'infinibot.goals.draft.v1';

export function GoalsTab({ gateway, focusId, wide, registerBack, navigation, reloadSignal }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';

  const [goals, setGoals] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState(focusId || null);
  const [detail, setDetail] = useState(null);
  const [liveLog, setLiveLog] = useState(null);
  const [openIteration, setOpenIteration] = useState(null);
  const [agents, setAgents] = useState([]);
  const [filter, setFilter] = useState('all');
  const [composerOpen, setComposerOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [now, setNow] = useState(Date.now());
  const [notice, flash] = useFlash();
  const [draft, setDraft] = usePersistentDraft(DRAFT_KEY, M.mergeGoalDraft);
  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const openItRef = useRef(openIteration);
  openItRef.current = openIteration;

  useEffect(() => { if (focusId) select(focusId); }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDetail = useCallback(async (id) => {
    if (!sendReq || !id) return;
    try {
      const d = await sendReq('goals.get', { id });
      if (selRef.current !== id) return;
      setDetail(d);
      const its = d?.run?.iterations || [];
      const last = its[its.length - 1];
      if (last && (last.endedAt === null || openItRef.current === null)) {
        const log = await sendReq('goals.log', { id });
        if (selRef.current === id) setLiveLog(log);
      }
    } catch (err) {
      if (M.isNotFound(err)) {
        setSelectedId(null);
        setDetail(null);
        setError('That goal run no longer exists.');
      }
    }
  }, [sendReq]);

  const refresh = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('goals.list', { limit: 200 });
      setGoals(res?.goals ?? []);
      setLoadErr(null);
      if (selRef.current) await loadDetail(selRef.current);
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

  useEffect(() => { if (reloadSignal) refresh(); }, [reloadSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useGatewayEvents(gateway, ['goal.changed', 'goal.checked', 'goal.created', 'goal.updated', 'goal.iteration', 'goal.completed', 'goal.failed'], refresh);
  useInterval(() => {
    setNow(Date.now());
    if (connected && M.goalsHaveActive(goals)) refresh();
  }, 5000);

  const onPull = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  function select(id) {
    if (selRef.current === id) return;
    selRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setLiveLog(null);
    setOpenIteration(null);
    setInstruction('');
    setError(null);
    if (id) loadDetail(id);
  }

  // Header back closes the detail on phones.
  useEffect(() => {
    registerBack?.(() => {
      if (!wide && selRef.current) { select(null); return true; }
      return false;
    });
  }); // every render: keeps closure fresh

  // ── composer ──────────────────────────────────────────────────────────
  const setCheck = (i, patch) => setDraft((d) => ({ ...d, checks: d.checks.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  const create = async () => {
    const built = M.buildGoalCreateParams(draft);
    if (built.error) { setError(built.error); return; }
    setCreating(true);
    setError(null);
    try {
      const res = await sendReq('goals.create', built.params);
      setDraft({ goal: '', title: '', checks: [M.emptyGoalCheck('shell')] });
      setFilter('all');
      flash('Goal started.');
      setComposerOpen(false);
      select(res?.id || null);
      await refresh();
    } catch (err) {
      setError(M.errMessage(err));
    } finally {
      setCreating(false);
    }
  };

  // ── controls ──────────────────────────────────────────────────────────
  const control = async (key, extra = {}) => {
    const meta = M.GOAL_CONTROL_META[key];
    const method = meta ? meta.method : key;
    const id = selRef.current;
    if (!id) return;
    if (meta?.confirm && !(await confirmAsync(meta.label, meta.confirm, meta.label))) return;
    setBusy(method);
    setError(null);
    try {
      const res = await sendReq(method, { id, ...extra });
      if (method === 'goals.recheck') flash(res?.allPass ? 'All checks pass.' : 'Some checks still fail.');
      if (method === 'goals.continue') setInstruction('');
      if (method === 'goals.delete') { select(null); flash('Goal run deleted.'); }
      await refresh();
    } catch (err) {
      setError(M.errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const openIterationLog = async (it, open) => {
    setOpenIteration(open ? -1 : it.index);
    if (!open && selRef.current) {
      try { setLiveLog(await sendReq('goals.log', { id: selRef.current, iteration: it.index })); } catch { /* ignore */ }
    }
  };

  const counts = useMemo(() => M.goalCounts(goals || []), [goals]);
  const shown = useMemo(() => M.filterGoals(goals || [], filter), [goals, filter]);

  // ── renderers ─────────────────────────────────────────────────────────
  const isAgent = String(draft.target).startsWith('agent:');
  const cli = M.CLI_OPTIONS.find((o) => `cli:${o.id}` === draft.target);
  const modelOptions = [{ value: '', label: isAgent ? 'Agent default' : 'Backend default' }, ...(cli?.models || []).map((m) => ({ value: m, label: m }))];

  const composer = (
    <Section
      tint="primary"
      title="New goal"
      right={
        <IconButton
          icon={composerOpen ? 'chevron-up' : 'chevron-down'}
          size="sm"
          onPress={() => setComposerOpen(!composerOpen)}
          accessibilityLabel={composerOpen ? 'Collapse new goal form' : 'Expand new goal form'}
        />
      }
    >
      <Text style={[type.caption, { color: colors.textMuted, marginBottom: composerOpen ? SPACE.sm : 0 }]}>Runs until every check passes</Text>
      {composerOpen ? (
        <View style={{ gap: SPACE.md }}>
          <View>
            <Label required>Goal</Label>
            <TextBox
              multiline
              rows={3}
              value={draft.goal}
              onChangeText={(v) => setDraft({ goal: v })}
              placeholder="e.g. Make the settings page load in under 1s and keep all tests green"
              label="Goal"
            />
          </View>
          <View>
            <Label>Title (optional)</Label>
            <TextBox value={draft.title} onChangeText={(v) => setDraft({ title: v })} placeholder="Short name shown in the list" label="Title" />
          </View>
          <View>
            <Label required>Done when</Label>
            <View style={{ gap: SPACE.sm }}>
              {draft.checks.map((c, i) => (
                <CheckEditor
                  key={i}
                  check={c}
                  types={M.GOAL_CHECK_TYPES}
                  onChange={(patch) => setCheck(i, patch)}
                  onRemove={draft.checks.length > 1 ? () => setDraft((d) => ({ ...d, checks: d.checks.filter((_, j) => j !== i) })) : null}
                />
              ))}
            </View>
            <Button
              title="Add check"
              icon="add"
              variant="ghost"
              size="sm"
              onPress={() => setDraft((d) => ({ ...d, checks: [...d.checks, M.emptyGoalCheck('shell')] }))}
              style={{ alignSelf: 'flex-start', marginTop: SPACE.xs }}
            />
          </View>
          <View style={st.grid}>
            <Select
              label="Agent"
              value={draft.target}
              options={targetOptions(agents, { cli: M.CLI_OPTIONS })}
              onChange={(v) => setDraft({ target: v, model: '' })}
            />
            <View style={{ flex: 1, minWidth: 140 }}>
              <Text style={[type.caption, { color: colors.textMuted, marginBottom: 2 }]}>Model</Text>
              <TextBox value={draft.model} onChangeText={(v) => setDraft({ model: v })} placeholder={isAgent ? 'Agent default' : 'Backend default'} mono label="Model" />
            </View>
          </View>
          {cli?.models?.length ? (
            <View style={st.row}>
              {modelOptions.slice(1).map((o) => (
                <Chip key={o.value} label={o.label} size="sm" selected={draft.model === o.value} onPress={() => setDraft({ model: draft.model === o.value ? '' : o.value })} />
              ))}
            </View>
          ) : null}
          <View>
            <Label>Project folder</Label>
            <TextBox value={draft.workdir} onChangeText={(v) => setDraft({ workdir: v })} placeholder="~/Desktop/Development/my-app" mono label="Project folder" />
          </View>
          <Collapsible title="Advanced limits">
            <View style={st.grid}>
              {M.GOAL_LIMIT_FIELDS.map((f) => (
                <NumBox key={f.key} label={f.label} value={draft[f.key]} min={f.min} max={f.max} onChange={(v) => setDraft({ [f.key]: v })} />
              ))}
            </View>
            <ToggleRow label="Notify on finish" value={draft.notify} onChange={(v) => setDraft({ notify: v })} />
          </Collapsible>
          {!selectedId || wide ? <Msg>{error}</Msg> : null}
          <Msg tone="success">{notice}</Msg>
          <Button title={creating ? 'Starting…' : 'Start goal'} icon="rocket-outline" loading={creating} disabled={!connected} onPress={create} fullWidth />
        </View>
      ) : null}
    </Section>
  );

  const list = (
    <Section title="Goal runs" padded>
      <Tabs
        tabs={M.GOAL_FILTERS.map((f) => ({ key: f.key, label: f.label, count: counts[f.key] ?? 0 }))}
        active={filter}
        onSelect={setFilter}
        contentStyle={{ paddingBottom: SPACE.sm }}
      />
      {goals === null && !loadErr ? (
        <View style={{ gap: SPACE.sm }}>
          <Skeleton height={56} />
          <Skeleton height={56} />
          <Skeleton height={56} />
        </View>
      ) : loadErr ? (
        <LoadState error={loadErr} onRetry={refresh} unavailableTitle="Goal runs are not available on this gateway" />
      ) : shown.length === 0 ? (
        <EmptyState
          compact
          icon="flag-outline"
          title={goals.length === 0 ? 'No goal runs yet' : 'Nothing in this filter'}
          message={goals.length === 0 ? 'Describe a goal above, add a check like `pnpm test`, and start it.' : undefined}
        />
      ) : (
        <View style={{ gap: SPACE.xs }}>
          {shown.map((g) => (
            <GoalRow key={g.id} g={g} selected={g.id === selectedId} onPress={() => select(g.id)} now={now} />
          ))}
        </View>
      )}
    </Section>
  );

  const detailView = selectedId ? (
    <GoalDetail
      detail={detail}
      liveLog={liveLog}
      openIteration={openIteration}
      onToggleIteration={openIterationLog}
      now={now}
      busy={busy}
      error={error}
      notice={notice}
      instruction={instruction}
      setInstruction={setInstruction}
      onControl={control}
      onBack={wide ? null : () => select(null)}
      navigation={navigation}
    />
  ) : (
    <HowItWorks />
  );

  const refreshCtl = <RefreshControl refreshing={refreshing} onRefresh={onPull} tintColor={colors.primary} />;

  if (wide) {
    return (
      <View style={s.split}>
        <ScrollView style={s.colLeft} contentContainerStyle={s.pad} refreshControl={refreshCtl} keyboardShouldPersistTaps="handled">
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
          {composer}
          {list}
          <HowItWorks />
        </>
      )}
    </ScrollView>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────

export function CheckEditor({ check: c, types, onChange, onRemove }) {
  const { colors } = useUIKit();
  return (
    <View style={[s.checkRow, { borderColor: colors.borderSubtle }]}>
      <View style={st.row}>
        <Select
          compact
          value={c.type}
          options={types.map((t) => ({ value: t.id, label: t.label, hint: t.hint }))}
          onChange={(v) => onChange({ type: v })}
          label={undefined}
        />
        <IconButton
          icon="close"
          size="sm"
          tone={colors.error}
          disabled={!onRemove}
          onPress={onRemove || undefined}
          accessibilityLabel="Remove check"
        />
      </View>
      {c.type === 'shell' ? (
        <TextBox mono value={c.command} onChangeText={(v) => onChange({ command: v })} placeholder="pnpm test  ·  curl -f http://localhost:3000" />
      ) : null}
      {c.type === 'file' ? (
        <>
          <TextBox mono value={c.path} onChangeText={(v) => onChange({ path: v })} placeholder="dist/index.html" />
          <ToggleRow label="Must be absent" value={Boolean(c.negate)} onChange={(v) => onChange({ negate: v })} />
        </>
      ) : null}
      {c.type === 'grep' ? (
        <>
          <TextBox mono value={c.path} onChangeText={(v) => onChange({ path: v })} placeholder="README.md" />
          <TextBox mono value={c.pattern} onChangeText={(v) => onChange({ pattern: v })} placeholder="## Setup" />
        </>
      ) : null}
      {c.type === 'visual' ? (
        <>
          <TextBox mono value={c.routes || ''} onChangeText={(v) => onChange({ routes: v })} placeholder="/chat, /agents" />
          <TextBox multiline rows={2} value={c.criterion} onChangeText={(v) => onChange({ criterion: v })} placeholder="What the screenshots must show (desktop + mobile)" />
        </>
      ) : null}
      {c.type === 'llm' ? (
        <TextBox multiline rows={2} value={c.criterion} onChangeText={(v) => onChange({ criterion: v })} placeholder="The settings page shows the new billing section" />
      ) : null}
    </View>
  );
}

function GoalRow({ g, selected, onPress, now }) {
  const { colors, type } = useUIKit();
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
      accessibilityLabel={`${g.title}, ${M.GOAL_STATUS_LABEL[g.status] || g.status}`}
      accessibilityState={{ selected }}
    >
      <View style={st.row}>
        <Chip label={M.GOAL_STATUS_LABEL[g.status] || g.status} tone={M.goalStatusTone(g.status)} dot size="sm" />
        <Text style={[type.bodyStrong, { color: colors.text, flex: 1 }]} numberOfLines={2}>{g.title}</Text>
      </View>
      <ProgressBar value={M.checksPassingRatio(g)} tone={g.checksPassing === g.checksTotal && g.checksTotal ? 'success' : 'primary'} height={3} />
      <MetaLine
        items={[
          M.goalTargetLabel(g.target),
          `${g.checksPassing}/${g.checksTotal} checks`,
          `iter ${g.iterations}/${g.maxIterations}`,
          M.formatAgo(g.updatedAt, now),
        ]}
      />
    </Pressable>
  );
}

function HowItWorks() {
  const { colors, type } = useUIKit();
  const steps = [
    ['Describe the goal', " and how to verify it: a command that must exit 0, a file that must exist or contain text, or a criterion an AI reviewer checks against the agent's output and diff."],
    ['Pick any agent', ' — Claude Code, Codex, OpenCode, Gemini, Grok Build, or one of your gateway agents.'],
    ['The run keeps going', ': when the agent stops, every check runs. Failing output is fed back and the same session resumes until all checks pass or a limit is hit.'],
    ['Failures are visible', ': crashes, hangs, timeouts and "said it was done but wasn\'t" are detected and shown per iteration. Runs survive gateway restarts.'],
  ];
  return (
    <Section title="How goal runs work">
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

function GoalDetail({
  detail, liveLog, openIteration, onToggleIteration, now, busy, error, notice, instruction, setInstruction, onControl, onBack, navigation,
}) {
  const { colors, type } = useUIKit();
  if (!detail) {
    return (
      <Section>
        {onBack ? <Button title="All goals" icon="chevron-back" variant="ghost" size="sm" onPress={onBack} style={{ alignSelf: 'flex-start' }} /> : null}
        <Skeleton height={22} style={{ marginTop: SPACE.sm }} />
        <Skeleton height={14} style={{ marginTop: SPACE.sm }} />
        <Skeleton height={90} style={{ marginTop: SPACE.md }} />
        <Msg>{error}</Msg>
      </Section>
    );
  }
  const r = detail.run;
  const terminal = M.GOAL_TERMINAL.has(r.status);
  const elapsed = M.goalElapsed(r, now);
  const isBusy = (m) => busy === m;
  const controls = M.goalControls(r.status);
  const iterations = [...(r.iterations || [])].reverse();
  return (
    <>
      <Section tint="primary">
        {onBack ? (
          <Button title="All goals" icon="chevron-back" variant="ghost" size="sm" onPress={onBack} style={{ alignSelf: 'flex-start', marginBottom: SPACE.xs }} />
        ) : null}
        <View style={[st.row, { flexWrap: 'nowrap', alignItems: 'flex-start' }]}>
          <Chip label={M.GOAL_STATUS_LABEL[r.status] || r.status} tone={M.goalStatusTone(r.status)} dot />
          <Text style={[type.h2, { color: colors.text, flex: 1 }]} accessibilityRole="header">{r.title}</Text>
        </View>
        <View style={{ marginTop: SPACE.sm, gap: 2 }}>
          <MetaLine items={[M.goalTargetLabel(r.target), `iteration ${(r.iterations || []).length}/${r.limits?.maxIterations ?? '—'}`]} />
          <MetaLine items={[`${M.fmtDuration(elapsed)} of ${M.fmtDuration((r.limits?.maxWallClockSec || 0) * 1000)}`, `created ${M.formatAgo(r.createdAt, now)}`]} />
          {r.workdir ? <Text selectable style={[type.monoSmall, { color: colors.textMuted }]}>{r.workdir}</Text> : null}
          <Text selectable style={[type.monoSmall, { color: colors.textMuted }]}>{r.id}</Text>
        </View>
        {r.reason ? <Msg tone={r.status === 'completed' ? 'success' : terminal ? 'danger' : 'warning'}>{r.reason}</Msg> : null}
        {r.pendingInstruction ? <Msg tone="info">{`Queued instruction: ${r.pendingInstruction}`}</Msg> : null}
        <View style={[st.row, { marginTop: SPACE.sm }]}>
          {controls.map((k) => {
            const m = M.GOAL_CONTROL_META[k];
            return (
              <Button
                key={k}
                title={isBusy(m.method) && m.busyLabel ? m.busyLabel : m.label}
                icon={m.icon}
                variant={m.variant}
                size="sm"
                loading={isBusy(m.method)}
                disabled={Boolean(busy) && !isBusy(m.method)}
                onPress={() => onControl(k)}
              />
            );
          })}
        </View>
        <Msg>{error}</Msg>
        <Msg tone="success">{notice}</Msg>
      </Section>

      <Section title="Goal">
        <Collapsible title={String(r.goal || '').split('\n')[0].slice(0, 120) || 'Goal text'} defaultOpen={false}>
          <Pre>{r.goal}</Pre>
        </Collapsible>
      </Section>

      <Section
        title="Checks"
        right={<Text style={[type.caption, { color: colors.textMuted }]}>{r.lastCheckAt ? `last run ${M.formatAgo(r.lastCheckAt, now)}` : 'not run yet'}</Text>}
      >
        {(r.checks || []).map((c, i) => (
          <CheckResultRow key={c.id || i} check={c} run={r} history={detail.history} now={now} />
        ))}
      </Section>

      <Section title="Iterations">
        {iterations.length === 0 ? (
          <Text style={[type.small, { color: colors.textMuted }]}>Waiting to start…</Text>
        ) : (
          iterations.map((it) => (
            <IterationRow
              key={it.index}
              it={it}
              run={r}
              now={now}
              open={openIteration === it.index || ((it.endedAt === null) && openIteration === null)}
              log={liveLog && liveLog.iteration === it.index ? liveLog.output : it.outputTail}
              onToggle={onToggleIteration}
              navigation={navigation}
            />
          ))
        )}
      </Section>

      <Section title={terminal ? 'Continue with an instruction' : 'Add an instruction'}>
        <TextBox
          multiline
          rows={2}
          value={instruction}
          onChangeText={setInstruction}
          placeholder={terminal ? 'Reopen this run with extra guidance, e.g. "use the existing auth helper"' : 'Interrupt and resume the agent with extra guidance'}
          label="Instruction"
        />
        <Button
          title={terminal ? 'Continue' : 'Send'}
          icon="send"
          variant="secondary"
          size="sm"
          style={{ alignSelf: 'flex-end', marginTop: SPACE.sm }}
          disabled={!instruction.trim() || Boolean(busy)}
          loading={isBusy('goals.continue')}
          onPress={() => onControl('goals.continue', { instruction })}
        />
      </Section>
    </>
  );
}

function CheckResultRow({ check, run, history, now }) {
  const { colors, type } = useUIKit();
  const { last, hist, state } = M.checkResultState(check, run, history);
  const tone = state === 'pass' ? 'success' : state === 'fail' ? 'danger' : 'neutral';
  return (
    <View style={[s.checkResult, { borderColor: colors.borderSubtle }]}>
      <View style={[st.row, { flexWrap: 'nowrap', alignItems: 'flex-start' }]}>
        <View style={{ paddingTop: 5 }}><Dot tone={tone} /></View>
        <View style={{ flex: 1 }}>
          <Text style={[type.caption, { color: colors.textMuted }]}>{M.checkTypeLabel(check.type)}</Text>
          <Text selectable style={[check.type === 'llm' ? type.small : type.monoSmall, { color: colors.text }]}>{M.describeGoalCheck(check)}</Text>
        </View>
      </View>
      {hist.length ? (
        <View style={s.spark} accessibilityLabel={`History: ${hist.map((h) => (h.pass ? 'pass' : 'fail')).join(', ')}`}>
          {hist.map((h, i) => (
            <View key={i} style={[s.sparkBar, { backgroundColor: h.pass ? colors.success : colors.error }]} />
          ))}
        </View>
      ) : null}
      {last ? (
        <Collapsible title={`${last.pass ? 'Passed' : 'Failed'} · iteration ${last.iteration}, ${M.TRIGGER_LABEL[last.trigger] ?? last.trigger} · ${M.formatAgo(last.at, now)}`}>
          <Pre tone={last.pass ? undefined : 'danger'}>{last.output || '(no output)'}</Pre>
        </Collapsible>
      ) : null}
    </View>
  );
}

function IterationRow({ it, run, now, open, log, onToggle, navigation }) {
  const { colors, type } = useUIKit();
  const running = it.endedAt === null;
  const dur = (it.endedAt ?? now) - it.startedAt;
  const tone = M.iterationTone(it, run.status);
  const c = toneColor(tone, colors);
  const durable = run.target?.kind === 'cli' && it.runId;
  return (
    <View style={[s.iter, { borderLeftColor: c }]}>
      <Pressable
        onPress={() => onToggle(it, open)}
        style={({ pressed }) => [st.row, { minHeight: 44, opacity: pressed ? 0.8 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={`Iteration ${it.index}, ${M.GOAL_OUTCOME_LABEL[it.outcome] ?? it.outcome}. ${open ? 'Collapse' : 'Expand'}`}
      >
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>#{it.index}</Text>
        <Text style={[type.smallStrong, { color: c }]}>{M.GOAL_OUTCOME_LABEL[it.outcome] ?? it.outcome}</Text>
        {it.resumed ? <Chip label="resumed" size="sm" /> : null}
        {it.exitCode !== null && it.exitCode !== undefined ? <Chip label={`exit ${it.exitCode}`} size="sm" /> : null}
        <View style={{ flex: 1 }} />
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>{M.fmtDuration(dur)}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={15} color={colors.textMuted} />
      </Pressable>
      {it.note ? <Text style={[type.caption, { color: colors.textMuted }]}>{it.note}</Text> : null}
      {open ? (
        <View style={{ gap: SPACE.xs, marginTop: SPACE.xs }}>
          {running && durable ? (
            <View style={{ gap: SPACE.xs }}>
              <Text style={[type.caption, { color: colors.textMuted }]}>Live terminal:</Text>
              <Pre>{`tmux -L infinibot attach -t infinibot_spawn_${it.runId}`}</Pre>
              {navigation ? (
                <Button
                  title="Open Terminals"
                  icon="terminal-outline"
                  variant="ghost"
                  size="sm"
                  style={{ alignSelf: 'flex-start' }}
                  onPress={() => { try { navigation.navigate('TerminalsModal'); } catch { /* route may not exist */ } }}
                />
              ) : null}
            </View>
          ) : null}
          {it.prompt ? (
            <Collapsible title="Prompt sent">
              <Pre>{it.prompt}</Pre>
            </Collapsible>
          ) : null}
          <Text style={[type.caption, { color: colors.textMuted }]}>{running ? 'Agent output (live)' : 'Agent output'}</Text>
          <Pre>{log && String(log).trim() ? String(log).slice(-8000) : '(no output yet)'}</Pre>
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
  checkRow: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, gap: SPACE.sm },
  checkResult: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: SPACE.sm, gap: SPACE.xs },
  spark: { flexDirection: 'row', gap: 2, alignItems: 'flex-end', height: 12, marginLeft: 16 },
  sparkBar: { width: 6, height: 12, borderRadius: 2 },
  iter: { borderLeftWidth: 2, paddingLeft: SPACE.sm, marginBottom: SPACE.sm },
});

export default GoalsTab;
