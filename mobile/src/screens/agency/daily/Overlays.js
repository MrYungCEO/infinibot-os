/**
 * The dialogs of Daily Operations, native:
 *   StagePrompt      — "Authorise autonomous work" (web renderStagePrompt)
 *   ComposerSheet    — create/act composer, five kinds (web renderComposer)
 *   WorkItemSheet    — full work-item record + run result (renderWorkItemModal)
 *   HandoffSheet     — Send to autonomy (renderHandoffDialog)
 *   TaskDetailSheet  — delivery task record + quick actions (renderDeliveryTaskModal)
 */

import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  BottomSheet,
  Modal,
  Button,
  Chip,
  Field,
  ProgressBar,
  useUIKit,
  SPACE,
  RADIUS,
  MONO_FAMILY,
  a11yPress,
} from '../../../ui-kit';
import * as M from './daily-model';
import { Note, ChipPicker, DefList } from './parts';

/** Let one RN modal finish dismissing before the next presents (iOS). */
const HANDOVER_MS = Platform.OS === 'ios' ? 380 : 60;

function Label({ children }) {
  const { colors, type } = useUIKit();
  return <Text style={[type.label, { color: colors.textMuted }]}>{children}</Text>;
}

function Footer({ children }) {
  return <View style={styles.footer}>{children}</View>;
}

// ── Stage prompt ───────────────────────────────────────────────────────────

export function StagePrompt({ state, actions }) {
  const { colors, type } = useUIKit();
  const prompt = state.stagePrompt;
  const view = prompt?.view ?? null;
  const outcome = M.outcomeLabel(view ?? undefined);
  return (
    <Modal
      visible={!!prompt}
      onClose={() => actions.closeStagePrompt()}
      title="Authorise autonomous work"
      footer={
        <Footer>
          <Button
            variant="ghost"
            title="Cancel"
            onPress={() => actions.closeStagePrompt()}
            accessibilityLabel="Cancel — do not stage this work item"
          />
          <Button
            variant="primary"
            icon="shield-checkmark"
            title={prompt?.submitting ? 'Staging…' : 'Authorise & stage'}
            loading={prompt?.submitting}
            onPress={() => actions.confirmStagePrompt()}
            accessibilityLabel={`Authorise and stage ${prompt?.title ?? 'this work item'} for autonomous work`}
          />
        </Footer>
      }
    >
      {prompt ? (
        <View style={{ gap: SPACE.sm }}>
          <Text style={[type.small, { color: colors.textSecondary }]}>
            Staging <Text style={{ color: colors.text, fontWeight: '700' }}>{prompt.title}</Text> moves it out of the
            backlog and makes it eligible for an AI employee to execute without further approval.
          </Text>
          {prompt.loading ? <Note icon="hourglass-outline">Checking execution readiness…</Note> : null}
          {prompt.error ? <Note tone="warning">{prompt.error}</Note> : null}
          {view ? (
            <DefList
              rows={[
                { label: 'Employee', value: view.workerName },
                { label: 'Backend', value: view.backend ?? 'none resolved', mono: true },
                { label: 'Autonomy', value: `level ${view.autonomyLevel}` },
                {
                  label: 'On success',
                  value:
                    view.terminalStage === 'completed'
                      ? 'completes automatically — no further human step'
                      : view.terminalStage === 'review'
                        ? 'stops in Review for you to sign off'
                        : 'would not run',
                },
              ]}
            />
          ) : null}
          {!state.executorEnabled ? (
            <Note tone="warning">
              Autonomous execution is switched off (cron.agencyOperatingLoop.executeWorkItems). Your authorisation is
              recorded and the card moves to Staged, but nothing will run until it is enabled.
            </Note>
          ) : view?.blockedReason && !M.isUnstagedOnly(view) ? (
            <Note tone="warning">{`This card will not run: ${view.blockedReason}`}</Note>
          ) : outcome ? (
            <Note tone="success">
              {`On the next loop tick, ${view?.workerName} ${outcome} using ${view?.backend ?? 'its backend'}.`}
            </Note>
          ) : null}
        </View>
      ) : null}
    </Modal>
  );
}

// ── Composer ───────────────────────────────────────────────────────────────

function NumberField({ label, value, onChange, min = 0, helper }) {
  return (
    <Field
      label={label}
      helper={helper}
      value={String(value)}
      keyboardType="number-pad"
      mono
      onChangeText={(t) => {
        const n = Number(String(t).replace(/[^0-9]/g, ''));
        onChange(Number.isFinite(n) ? Math.max(min, n) : min);
      }}
    />
  );
}

export function ComposerSheet({ state, actions }) {
  const { colors, type } = useUIKit();
  const c = state.composer;
  const employees = state.employees;
  const workerOptions = employees.map((e) => ({ key: e.id, label: e.name }));
  const workerName = employees.find((e) => e.id === c?.workerId)?.name ?? 'the worker';
  const set = (patch) => actions.updateComposer(patch);
  const workerRole = (id) => employees.find((e) => e.id === id)?.role;

  const workerPicker = (label, key) => (
    <View style={{ gap: SPACE.xs }}>
      <ChipPicker label={label} options={workerOptions} value={c[key]} onChange={(v) => set({ [key]: v })} />
      {workerRole(c[key]) ? (
        <Text style={[type.caption, { color: colors.textMuted }]}>{workerRole(c[key])}</Text>
      ) : null}
    </View>
  );
  const priority = (
    <ChipPicker label="Priority" options={M.PRIORITIES} value={c?.priority} onChange={(v) => set({ priority: v })} />
  );

  let fields = null;
  if (c) {
    switch (c.kind) {
      case 'work-item':
        fields = (
          <>
            <Field label="What needs doing" value={c.title} onChangeText={(v) => set({ title: v })} placeholder="Draft the Q3 renewal proposal" />
            {workerPicker('Assign to', 'workerId')}
            {priority}
            <NumberField label="Due in (days)" value={c.dueInDays} onChange={(v) => set({ dueInDays: v })} helper="0 means no due date" />
            <Field
              label="Instructions (optional)"
              value={c.instructions}
              onChangeText={(v) => set({ instructions: v })}
              placeholder="Anything the worker needs in order to start."
              multiline
              rows={4}
            />
            <Note icon="information-circle-outline">
              Lands in Backlog. Nothing runs until you stage it — staging is still the only authorisation for autonomous work.
            </Note>
          </>
        );
        break;
      case 'responsibility':
        fields = (
          <>
            <Field label="Responsibility" value={c.title} onChangeText={(v) => set({ title: v })} placeholder="Review overnight support tickets" />
            {workerPicker('Owner', 'workerId')}
            <ChipPicker label="Cadence" options={M.CADENCES} value={c.cadence} onChange={(v) => set({ cadence: v })} />
            <Field label="Runs at" value={c.runAt} onChangeText={(v) => set({ runAt: v })} placeholder="09:00" mono helper="24h, HH:MM" />
            {priority}
            <NumberField label="SLA (minutes)" value={c.slaMinutes} min={1} onChange={(v) => set({ slaMinutes: v || 1440 })} />
            <Field
              label="Instructions (optional)"
              value={c.instructions}
              onChangeText={(v) => set({ instructions: v })}
              placeholder="What the worker does each time it comes round."
              multiline
              rows={3}
            />
            <Note icon="information-circle-outline">
              The operating loop turns this into a Backlog card every time it comes round. It never skips the staging gate.
            </Note>
          </>
        );
        break;
      case 'review':
        fields = (
          <>
            {workerPicker('Reviewing', 'workerId')}
            {workerPicker('Reviewed by', 'managerWorkerId')}
            <NumberField label="Every (days)" value={c.cadenceDays} min={1} onChange={(v) => set({ cadenceDays: v || 7 })} />
            <Note icon="information-circle-outline">
              {`The first review falls due in ${c.cadenceDays} day${c.cadenceDays === 1 ? '' : 's'} and the loop marks it overdue if it is not signed off.`}
            </Note>
          </>
        );
        break;
      case 'review-complete':
        fields = (
          <>
            <Text style={[type.small, { color: colors.textSecondary }]}>
              Closing the current review cycle for <Text style={{ color: colors.text, fontWeight: '700' }}>{workerName}</Text>.
            </Text>
            <Field
              label="Outcome"
              value={c.outcome}
              onChangeText={(v) => set({ outcome: v })}
              placeholder="What did the review conclude, and what changes as a result?"
              multiline
              rows={4}
            />
            <Note icon="information-circle-outline">Signing off closes this cycle and schedules the next one on its cadence.</Note>
          </>
        );
        break;
      case 'schedule':
        fields = (
          <>
            {workerPicker('Worker', 'workerId')}
            <View style={styles.twoUp}>
              <View style={{ flex: 1 }}>
                <Field label="Shift starts" value={c.shiftStart} onChangeText={(v) => set({ shiftStart: v })} placeholder="09:00" mono />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Shift ends" value={c.shiftEnd} onChangeText={(v) => set({ shiftEnd: v })} placeholder="17:00" mono />
              </View>
            </View>
            <ChipPicker
              label="Working days"
              options={M.WEEKDAYS.map((d) => ({ key: d.value, label: d.label }))}
              value={c.weekdays}
              onChange={(day) =>
                set({ weekdays: c.weekdays.includes(day) ? c.weekdays.filter((d) => d !== day) : [...c.weekdays, day] })
              }
            />
            <Note icon="information-circle-outline">{`Recorded in ${c.timezone}, effective from today.`}</Note>
          </>
        );
        break;
      default:
        fields = null;
    }
  }

  return (
    <BottomSheet
      visible={!!c}
      onClose={() => actions.closeComposer()}
      title={c ? M.COMPOSER_TITLES[c.kind] : ''}
      subtitle={state.agencyName || undefined}
      footer={
        <Footer>
          <Button variant="ghost" title="Cancel" onPress={() => actions.closeComposer()} accessibilityLabel="Cancel without saving" />
          <Button
            variant="primary"
            icon="checkmark"
            title={c?.submitting ? 'Saving…' : 'Save'}
            loading={c?.submitting}
            onPress={() => actions.submitComposer()}
          />
        </Footer>
      }
    >
      <View style={{ gap: SPACE.md }}>
        {fields}
        {c?.error ? <Note tone="danger" icon="alert-circle-outline">{c.error}</Note> : null}
      </View>
    </BottomSheet>
  );
}

// ── Work item detail ───────────────────────────────────────────────────────

function RunResult({ item, view }) {
  const { colors, type, alpha } = useUIKit();
  const r = M.describeRunResult(item, view);
  if (r.kind === 'none') {
    return (
      <View style={[styles.result, { borderColor: colors.borderSubtle || colors.border }]}>
        <View style={styles.resultHead}>
          <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]}>Deliverable</Text>
          <Chip size="sm" label="not run yet" />
        </View>
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {`This work item has no recorded run. Once ${r.workerName} executes it, the final result and any files it changed appear here.`}
        </Text>
      </View>
    );
  }
  const edge = r.kind === 'live' ? colors.info || colors.primary : r.kind === 'done' ? colors.success : colors.border;
  return (
    <View style={[styles.result, { borderColor: alpha(edge, 0.6) }]}>
      <View style={styles.resultHead}>
        <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]}>{r.title}</Text>
        {r.outcome ? <Chip size="sm" label={r.outcome} tone={r.outcomeTone} dot /> : r.running ? <Chip size="sm" label="running" tone="info" dot /> : null}
      </View>
      <View style={styles.rowWrap}>
        {r.backend ? <Chip size="sm" label={`backend ${r.backend}`} /> : null}
        {r.duration ? <Chip size="sm" label={`ran ${r.duration}`} /> : null}
        {r.attempts !== null ? <Chip size="sm" label={`${r.attempts} attempt${r.attempts === 1 ? '' : 's'}`} /> : null}
        {r.exitCode !== null ? <Chip size="sm" label={`exit ${r.exitCode}`} /> : null}
      </View>
      {r.timeline.length ? (
        <View style={{ gap: SPACE.xs }}>
          {r.timeline.map((e, i) => (
            <View key={`${e.label}-${i}`} style={styles.tlRow}>
              <Ionicons name="ellipse" size={8} color={e.tone === 'neutral' ? colors.textMuted : colors[e.tone] || colors.primary} />
              <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]}>{e.label}</Text>
              <Text style={[type.monoSmall, { color: colors.textMuted }]}>{e.at ? M.relativeTime(e.at) : 'in progress'}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <Label>{`Final result${r.done ? '' : r.running ? ' (live output pending)' : ''}`}</Label>
      {r.output || r.error ? (
        <View style={[styles.pre, { backgroundColor: colors.surfaceDeep || colors.inputBg || colors.surface }]}>
          <Text selectable style={[type.monoSmall, { color: r.output ? colors.text : colors.error, fontFamily: MONO_FAMILY }]}>
            {r.output || r.error}
          </Text>
        </View>
      ) : (
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {r.running
            ? 'The agent is still executing — its closing summary will land here on completion.'
            : 'This run recorded no closing summary. Open the session to read the full transcript.'}
        </Text>
      )}
      <Label>Artifacts — files changed</Label>
      <Text style={[type.caption, { color: colors.textMuted }]}>
        {`Structured file-change artifacts are not reported by this run. ${
          r.sessionId
            ? 'Open the session below for the full transcript and any files it touched.'
            : 'For review, QA and research work the result above is the deliverable — no files are expected.'
        }`}
      </Text>
      {r.sessionId ? (
        <>
          <Label>Session</Label>
          <Text selectable style={[type.monoSmall, { color: colors.text }]}>{`id ${r.sessionId}`}</Text>
        </>
      ) : null}
    </View>
  );
}

export function WorkItemSheet({ state, actions, onOpenTerminals }) {
  const { colors, type } = useUIKit();
  const id = state.workItemDetailId;
  const item = id ? state.workItems.find((e) => e.id === id) : null;
  const view = item ? state.executions[item.id] : undefined;
  const employee = item ? state.employees.find((e) => e.id === item.workerId) : undefined;
  const targets = item ? M.WORK_ITEM_TRANSITIONS[item.status] || [] : [];
  const canStage = targets.includes(M.AUTONOMY_STAGE);
  const outcome = M.outcomeLabel(view);
  const busy = item ? state.busyWorkItemId === item.id : false;
  const lastRunOutcome = typeof view?.lastRun?.outcome === 'string' ? view.lastRun.outcome : null;
  const live = !item
    ? ''
    : item.status === 'in_progress'
      ? 'Running now'
      : item.status === 'completed'
        ? 'Completed'
        : item.status === M.AUTONOMY_STAGE
          ? 'Staged — authorised, awaiting the executor'
          : item.status === 'queued'
            ? 'Queued in backlog'
            : M.STAGE_LABELS[item.status];
  const sessionId = typeof view?.lastRun?.sessionId === 'string' ? view.lastRun.sessionId : null;
  return (
    <>
      <BottomSheet
        visible={!!item}
        onClose={() => actions.closeWorkItem()}
        title={item?.title || ''}
        subtitle={item ? M.STAGE_LABELS[item.status] : undefined}
        maxHeightRatio={0.92}
        footer={
          <Footer>
            {sessionId && onOpenTerminals ? (
              <Button
                variant="ghost"
                icon="terminal-outline"
                title="Open terminal session"
                onPress={() => {
                  actions.closeWorkItem();
                  onOpenTerminals();
                }}
              />
            ) : null}
            <Button variant="secondary" title="Close" onPress={() => actions.closeWorkItem()} accessibilityLabel="Close the work item details" />
          </Footer>
        }
      >
        {item ? (
          <View style={{ gap: SPACE.md }}>
            <DefList
              rows={[
                { label: 'Assigned to', value: `${employee?.name ?? item.workerId}${employee?.role ? ` — ${employee.role}` : ''}` },
                { label: 'Live status', value: live },
                { label: 'Stage', value: M.STAGE_LABELS[item.status] },
                { label: 'Priority', value: item.priority },
                { label: 'Due', value: M.dueLabel(item.dueAt) },
                { label: 'Backend', value: M.backendLabel(view, employee?.model), mono: true },
                view ? { label: 'Autonomy', value: `level ${view.autonomyLevel}` } : null,
                outcome ? { label: 'On success', value: `${view?.terminalStage} — ${outcome}` } : null,
                item.escalationLevel ? { label: 'Escalation', value: `level ${item.escalationLevel}` } : null,
                item.waitingReason ? { label: 'Waiting on', value: item.waitingReason } : null,
                lastRunOutcome ? { label: 'Last run', value: lastRunOutcome } : null,
              ]}
            />
            <Label>Instructions</Label>
            <View style={[styles.pre, { backgroundColor: colors.surfaceDeep || colors.inputBg || colors.surface }]}>
              <Text selectable style={[type.small, { color: item.instructions ? colors.text : colors.textMuted }]}>
                {item.instructions || 'No instructions recorded for this work item.'}
              </Text>
            </View>
            <RunResult item={item} view={view} />
            {view?.blockedReason && !M.isUnstagedOnly(view) ? (
              <Note tone="warning">{`Will not run: ${view.blockedReason}`}</Note>
            ) : null}
            {canStage ? (
              <View style={{ gap: SPACE.xs }}>
                <Label>Authorise autonomous work</Label>
                <Button
                  variant="outline"
                  icon="shield-checkmark-outline"
                  title="Stage for autonomous work…"
                  disabled={busy}
                  onPress={() => {
                    const wid = item.id;
                    actions.closeWorkItem();
                    setTimeout(() => actions.openStagePrompt(wid), HANDOVER_MS);
                  }}
                />
              </View>
            ) : null}
            {targets.length ? (
              <View style={{ gap: SPACE.xs }}>
                <Label>Move to stage</Label>
                <View style={styles.rowWrap}>
                  {targets.map((t) => (
                    <Chip
                      key={t}
                      label={M.STAGE_LABELS[t]}
                      icon={t === M.AUTONOMY_STAGE ? 'warning-outline' : 'arrow-forward'}
                      tone={t === M.AUTONOMY_STAGE ? 'warning' : t === 'cancelled' || t === 'escalated' ? 'danger' : 'primary'}
                      onPress={
                        busy
                          ? undefined
                          : () => {
                              const wid = item.id;
                              actions.closeWorkItem();
                              if (t === M.AUTONOMY_STAGE) setTimeout(() => actions.requestStage(wid, t), HANDOVER_MS);
                              else actions.requestStage(wid, t);
                            }
                      }
                      accessibilityLabel={`Move ${item.title} to ${M.STAGE_LABELS[t]}`}
                    />
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        ) : null}
      </BottomSheet>
    </>
  );
}

// ── Handoff ────────────────────────────────────────────────────────────────

function Candidate({ employee, recommendation, picked, top, openItems, showScore, onPick }) {
  const { colors, type, alpha } = useUIKit();
  const chip = M.autonomyChipInfo(employee);
  const why = M.candidateWhy(employee, recommendation, showScore);
  return (
    <Pressable
      onPress={onPick}
      style={({ pressed }) => [
        styles.cand,
        {
          borderColor: picked ? alpha(colors.primary, 0.7) : colors.borderSubtle || colors.border,
          backgroundColor: picked ? alpha(colors.primary, 0.1) : pressed ? alpha(colors.text, 0.05) : 'transparent',
        },
      ]}
      {...a11yPress({ label: `${employee.name}, ${employee.role}`, role: 'radio', selected: picked })}
    >
      <Ionicons name={picked ? 'radio-button-on' : 'radio-button-off'} size={20} color={picked ? colors.primary : colors.textMuted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>
          {employee.name} <Text style={{ color: colors.textMuted, fontWeight: '400' }}>{employee.role}</Text>
        </Text>
        <View style={styles.rowWrap}>
          <Chip size="sm" label={chip.label} tone={chip.tone} />
          {chip.sub ? <Text style={[type.caption, { color: colors.textMuted }]}>{chip.sub}</Text> : null}
        </View>
        <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={3}>
          {`${employee.modelBinding ?? employee.model ?? 'no backend resolved'} · ${openItems} open item${openItems === 1 ? '' : 's'} · ${Math.round(
            employee.utilizationPercent || 0,
          )}% of ${employee.capacityHours}h · ${why}`}
        </Text>
      </View>
      <Text style={[type.monoSmall, { color: top ? colors.primary : colors.textMuted }]}>
        {recommendation && showScore ? `${top ? 'best ' : ''}${recommendation.score}` : `${openItems} open`}
      </Text>
    </Pressable>
  );
}

function RoutingPreview({ state, actions, scope }) {
  const { colors, type } = useUIKit();
  const routing = state.routing;
  const names = new Map(state.employees.map((e) => [e.id, e.name]));
  const set = scope ? new Set(scope) : null;
  const rows = set ? routing.decisions.filter((d) => d.taskId && set.has(d.taskId)) : routing.decisions;
  const counts = routing.counts;
  let body;
  if (routing.status === 'unavailable') {
    body = 'This gateway build does not serve a routing engine, so there is no automatic plan to preview. Pick the employee yourself — the handoff works exactly the same.';
  } else if (routing.status === 'loading' || routing.status === 'idle') {
    body = 'Asking the engine what it would do…';
  } else if (routing.status === 'failed') {
    body = `The routing preview failed: ${routing.error}. Choosing an employee by hand is unaffected.`;
  } else {
    body = `${routing.enabled === false ? 'The engine is switched OFF for this agency — this is what it would do if enabled. ' : ''}Over the whole agency it would assign ${
      counts?.assigned ?? 0
    } of ${counts?.candidates ?? 0} candidate tasks, leave ${counts?.unmatched ?? 0} unmatched and flag ${counts?.needsHuman ?? 0} for a human.${
      counts?.autoStaged ? ` ${counts.autoStaged} would be auto-staged (mode ${routing.mode ?? 'unknown'}).` : ''
    } Nothing has been written.`;
  }
  return (
    <View style={[styles.result, { borderColor: colors.borderSubtle || colors.border }]}>
      <View style={styles.resultHead}>
        <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]}>Routing engine — dry run</Text>
        {routing.status === 'ready' || routing.status === 'failed' ? (
          <Button size="sm" variant="ghost" icon="refresh" title="Re-run" onPress={() => actions.loadRoutingPreview()} />
        ) : null}
      </View>
      {routing.method ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>{routing.method}</Text> : null}
      <Text style={[type.caption, { color: colors.textSecondary }]}>{body}</Text>
      {routing.status === 'ready' ? (
        rows.length === 0 ? (
          <Text style={[type.caption, { color: colors.textMuted }]}>
            {scope
              ? 'The engine proposed nothing for the tasks in this batch — it has no opinion here, so the pick above is yours alone.'
              : 'The engine proposed no assignments at all in this pass.'}
          </Text>
        ) : (
          <View style={{ gap: SPACE.sm }}>
            {rows.slice(0, 40).map((d, i) => (
              <View key={`${d.taskId}-${i}`} style={{ gap: 2 }}>
                <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={2}>
                  {d.taskTitle ?? d.taskId ?? 'task'}
                </Text>
                <Text style={[type.caption, { color: colors.primary }]}>
                  {d.workerName ?? (d.workerId ? names.get(d.workerId) : null) ?? 'no worker — needs a human'}
                </Text>
                <Text style={[type.caption, { color: colors.textMuted }]}>
                  {`${d.rationale ?? 'no rationale reported'}${d.confidence !== null ? ` (${Math.round(d.confidence * 100)}% confidence)` : ''}`}
                </Text>
              </View>
            ))}
            {rows.length > 40 ? (
              <Text style={[type.caption, { color: colors.textMuted }]}>{`+${rows.length - 40} more decisions not shown.`}</Text>
            ) : null}
          </View>
        )
      ) : null}
    </View>
  );
}

export function HandoffSheet({ state, actions }) {
  const { colors, type } = useUIKit();
  const h = state.handoff;
  if (!h) return <BottomSheet visible={false} onClose={() => actions.closeHandoff()} />;
  const tasks = h.taskIds.map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean);
  const employee = state.employees.find((e) => e.id === h.workerId);
  const load = M.openWorkloadByWorker(state.workItems);
  const rank = M.rankCandidates(state.employees, h.recommendations, load);
  const count = h.taskIds.length;
  const progress = h.progress;
  const consequence = M.handoffConsequence({
    employee,
    authorizeNow: h.authorizeNow,
    executionsLoaded: state.executionsLoaded,
    executorEnabled: state.executorEnabled,
  });
  return (
    <BottomSheet
      visible
      onClose={() => {
        if (!h.submitting) actions.closeHandoff();
      }}
      dismissible={!h.submitting}
      title="Send to autonomy"
      subtitle={`${count} delivery task${count === 1 ? '' : 's'}${h.projectName ? ` from ${h.projectName}` : ''}`}
      maxHeightRatio={0.94}
      footer={
        <Footer>
          <Button variant="ghost" title="Cancel" disabled={h.submitting} onPress={() => actions.closeHandoff()} />
          <Button
            variant="primary"
            icon="paper-plane"
            title={h.submitting ? 'Sending…' : h.authorizeNow ? `Send & authorise ${count}` : `Send ${count} to backlog`}
            loading={h.submitting}
            disabled={!h.workerId}
            onPress={() => actions.submitHandoff()}
            accessibilityLabel={`Send ${count} tasks to ${employee?.name ?? 'the selected employee'}`}
          />
        </Footer>
      }
    >
      <View style={{ gap: SPACE.md }}>
        <Text style={[type.small, { color: colors.textSecondary }]}>
          Handing {count} delivery task{count === 1 ? '' : 's'}
          {h.projectName ? ` from ${h.projectName}` : ''} to an AI employee. Each becomes one work item, and the delivery
          task records its new owner.
        </Text>
        <View style={styles.rowWrap}>
          {tasks.slice(0, 8).map((t) => (
            <Chip key={t.id} size="sm" label={t.title} style={{ maxWidth: '100%' }} />
          ))}
          {tasks.length > 8 ? <Chip size="sm" label={`+${tasks.length - 8} more`} /> : null}
        </View>
        <Label>
          {`Who takes it on${
            h.recommendationsLoading ? ' — ranking employees…' : rank.discriminating ? ' — ranked by suitability, capacity and current load' : ''
          }`}
        </Label>
        {!h.recommendationsLoading && h.recommendations.length > 1 && !rank.discriminating ? (
          <Note icon="information-circle-outline">
            {`Suitability scored every employee identically (${rank.flatScore}/100): these delivery tasks carry no skill or capability requirements to score against, and nobody is near capacity. Ranked by open workload instead — this is not a recommendation, pick on role and autonomy level.`}
          </Note>
        ) : null}
        {h.recommendationsError ? <Note tone="warning">{h.recommendationsError}</Note> : null}
        {rank.ordered.length === 0 ? (
          <Note tone="warning">No active AI employees to hand work to. Hire one in Agency Operations first.</Note>
        ) : (
          <View style={{ gap: SPACE.sm }}>
            {rank.ordered.map((e) => (
              <Candidate
                key={e.id}
                employee={e}
                recommendation={rank.byScore.get(e.id)}
                picked={e.id === h.workerId}
                top={e.id === rank.topId && rank.byScore.has(e.id)}
                openItems={load.get(e.id) ?? 0}
                showScore={rank.discriminating}
                onPick={() => actions.updateHandoff({ workerId: e.id })}
              />
            ))}
          </View>
        )}
        <ChipPicker label="Priority" options={M.PRIORITIES} value={h.priority} onChange={(v) => actions.updateHandoff({ priority: v })} />
        <View style={{ gap: SPACE.xs }}>
          <Label>Authorisation</Label>
          <View style={styles.rowWrap}>
            <Chip
              label="Queue in backlog only"
              icon="file-tray-outline"
              tone="primary"
              selected={!h.authorizeNow}
              onPress={() => actions.updateHandoff({ authorizeNow: false })}
            />
            <Chip
              label="Stage & authorise now"
              icon="shield-checkmark-outline"
              tone="warning"
              selected={h.authorizeNow}
              onPress={() => actions.updateHandoff({ authorizeNow: true })}
            />
          </View>
        </View>
        <Field
          label="Instructions (optional)"
          value={h.instructions}
          onChangeText={(v) => actions.updateHandoff({ instructions: v })}
          placeholder="Applied to every task in this batch. Leave blank to use the task's own project context."
          multiline
          rows={3}
        />
        <Note tone={consequence.tone} icon={consequence.tone === 'success' ? 'flash-outline' : 'information-circle-outline'}>
          {consequence.text}
        </Note>
        <RoutingPreview state={state} actions={actions} scope={h.taskIds} />
        {progress ? (
          <ProgressBar
            value={(progress.done + progress.failed) / Math.max(1, progress.total)}
            label={`${progress.done + progress.failed} / ${progress.total}${progress.failed ? ` · ${progress.failed} failed` : ''}`}
            showValue
          />
        ) : null}
        {h.error ? <Note tone="warning">{h.error}</Note> : null}
      </View>
    </BottomSheet>
  );
}

// ── Delivery task detail ───────────────────────────────────────────────────

export function TaskDetailSheet({ state, actions, onOpenProjects }) {
  const { colors, type } = useUIKit();
  const [note, setNote] = useState('');
  const id = state.taskDetailId;
  const task = id ? state.tasks.find((t) => t.id === id) : null;
  const raw = id ? state.rawTasks[id] : null;
  const project = task ? state.projects.find((p) => p.id === task.projectId) : null;
  const rawProject = task ? state.rawProjects[task.projectId] : null;
  const owner = task?.assigneeId ? state.employees.find((e) => e.id === task.assigneeId)?.name ?? task.assigneeId : null;
  const sendable = task ? M.HANDOFF_ELIGIBLE_STATUSES.has(task.status) : false;
  const busy = state.taskDetailBusy;
  const siblings = task ? state.tasks.filter((t) => t.projectId === task.projectId && t.id !== task.id).length : 0;
  return (
    <BottomSheet
      visible={!!task}
      onClose={() => {
        if (!busy) {
          setNote('');
          actions.closeTaskDetail();
        }
      }}
      title={task?.title || ''}
      subtitle={project?.name ?? 'Unlinked project'}
      maxHeightRatio={0.92}
      footer={
        <Footer>
          <Button variant="secondary" title="Close" disabled={busy} onPress={() => { setNote(''); actions.closeTaskDetail(); }} />
        </Footer>
      }
    >
      {task ? (
        <View style={{ gap: SPACE.md }}>
          <DefList
            rows={[
              { label: 'Project', value: project?.name ?? 'Unlinked project' },
              { label: 'Status', value: M.deliveryStatusLabel(task.status) },
              { label: 'Priority', value: task.priority },
              { label: 'Due', value: M.dueLabel(task.dueAt) },
              { label: 'Owner', value: owner ?? 'no owner' },
              raw?.tags?.length ? { label: 'Tags', value: raw.tags.join(', ') } : null,
              rawProject && typeof rawProject.progress === 'number'
                ? {
                    label: 'Project progress',
                    value: `${rawProject.progress}%${siblings ? ` · ${siblings} sibling task${siblings === 1 ? '' : 's'}` : ''}`,
                  }
                : null,
              rawProject?.businessId ? { label: 'Client link', value: rawProject.businessId, mono: true } : null,
            ]}
          />
          <View style={[styles.pre, { backgroundColor: colors.surfaceDeep || colors.inputBg || colors.surface }]}>
            <Text selectable style={[type.small, { color: raw?.description ? colors.text : colors.textMuted }]}>
              {raw?.description || 'No description recorded for this task.'}
            </Text>
          </View>
          <View style={{ gap: SPACE.xs }}>
            <Label>Assignment</Label>
            <View style={styles.rowWrap}>
              <Button
                size="sm"
                variant="outline"
                icon="paper-plane-outline"
                title={owner ? 'Reassign to an employee…' : 'Assign to an employee…'}
                disabled={!sendable || busy}
                onPress={() => {
                  const tid = task.id;
                  actions.closeTaskDetail();
                  setTimeout(() => actions.openHandoff([tid]), HANDOVER_MS);
                }}
              />
              {onOpenProjects ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="open-outline"
                  title="Open in projects"
                  onPress={() => {
                    actions.closeTaskDetail();
                    onOpenProjects(task);
                  }}
                />
              ) : null}
            </View>
          </View>
          <View style={{ gap: SPACE.xs }}>
            <Label>Change status</Label>
            <View style={styles.rowWrap}>
              {M.DELIVERY_COLUMNS.map((col) => (
                <Chip
                  key={col.key}
                  label={col.label}
                  tone={M.deliveryStatusTone(col.key) === 'neutral' ? 'primary' : M.deliveryStatusTone(col.key)}
                  selected={col.key === task.status}
                  onPress={busy ? undefined : () => actions.setDeliveryTaskStatus(task.id, col.key)}
                  accessibilityLabel={`Move ${task.title} to ${col.label}`}
                />
              ))}
            </View>
          </View>
          <Field
            label="Add a note"
            value={note}
            onChangeText={setNote}
            placeholder="Context, a decision, a blocker — folded into the task description."
            multiline
            rows={3}
            disabled={busy}
          />
          <View style={styles.rowWrap}>
            <Button
              size="sm"
              variant="outline"
              icon="add"
              title="Add note"
              loading={busy}
              disabled={!note.trim()}
              onPress={async () => {
                const ok = await actions.addDeliveryTaskNote(task.id, note);
                if (ok) setNote('');
              }}
            />
          </View>
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: SPACE.sm },
  twoUp: { flexDirection: 'row', gap: SPACE.sm },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, alignItems: 'center' },
  result: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.sm },
  resultHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  tlRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  pre: { borderRadius: RADIUS.sm, padding: SPACE.md },
  cand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.md,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    padding: SPACE.md,
    minHeight: 56,
  },
});
