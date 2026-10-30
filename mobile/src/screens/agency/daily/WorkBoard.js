/**
 * Live work board — the autonomy half of "Operations command" (web
 * `renderBoard`). On a phone the seven columns become a scrollable stage
 * strip with counts; the selected column's cards stack below it. Every card
 * keeps the web's actions: Stage for autonomous work (always through the
 * authorisation prompt), Move to… (only legal transitions), tap for detail.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card, Chip, Button, Tabs, useUIKit, SPACE, RADIUS, a11yPress } from '../../../ui-kit';
import * as M from './daily-model';
import { Panel, Note, PanelEmpty, PanelAction, OptionSheet } from './parts';

function WorkCard({ item, state, actions, employeeName, employeeModel, onMove }) {
  const { colors, type, alpha } = useUIKit();
  const view = state.executions[item.id];
  const busy = state.busyWorkItemId === item.id;
  const targets = M.WORK_ITEM_TRANSITIONS[item.status] || [];
  const outcome = M.outcomeLabel(view);
  const staged = item.status === M.AUTONOMY_STAGE;
  const canStage = targets.includes(M.AUTONOMY_STAGE);
  const lastRunOutcome = typeof view?.lastRun?.outcome === 'string' ? view.lastRun.outcome : null;
  const chip = M.stageChip(item.status);
  const running = item.status === 'in_progress';
  const meta = `${M.dueLabel(item.dueAt)}${item.waitingReason ? ` · ${item.waitingReason}` : ''}${
    lastRunOutcome ? ` · last run ${lastRunOutcome}` : ''
  }`;
  return (
    <Card
      padded={false}
      depth={1}
      tint={staged ? 'primary' : item.status === 'escalated' ? 'danger' : undefined}
      style={[styles.card, busy && { opacity: 0.6 }]}
    >
      <Pressable
        onPress={() => actions.openWorkItem(item.id)}
        style={({ pressed }) => [styles.titleRow, pressed && { opacity: 0.7 }]}
        {...a11yPress({
          label: `${item.title}. Stage ${M.STAGE_LABELS[item.status]}. Assigned to ${employeeName}. Open for full details.`,
          role: 'button',
        })}
      >
        {running ? <View style={[styles.liveDot, { backgroundColor: colors.info || colors.primary }]} /> : null}
        {item.status === 'completed' ? <Ionicons name="checkmark-circle" size={15} color={colors.success} /> : null}
        <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={3}>
          {item.title}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
      </Pressable>
      {running ? <View style={[styles.shimmer, { backgroundColor: alpha(colors.info || colors.primary, 0.35) }]} /> : null}
      <View style={styles.chips}>
        <Chip size="sm" label={chip.label} tone={chip.tone} dot />
        <Chip size="sm" label={item.priority} tone={M.priorityTone(item.priority)} />
        <Chip size="sm" label={employeeName} tone="primary" />
        <Chip size="sm" label={M.backendLabel(view, employeeModel)} />
        {view ? <Chip size="sm" label={`autonomy L${view.autonomyLevel}`} /> : null}
        {outcome ? (
          <Chip
            size="sm"
            icon="arrow-forward"
            label={String(view?.terminalStage)}
            tone={view?.terminalStage === 'completed' ? 'success' : 'info'}
          />
        ) : null}
        {item.escalationLevel ? <Chip size="sm" label={`escalation L${item.escalationLevel}`} tone="danger" /> : null}
      </View>
      <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>
        {meta}
      </Text>
      {outcome ? (
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          {staged ? 'Authorised — ' : 'If staged: '}
          {outcome}.
        </Text>
      ) : null}
      {view?.blockedReason && !M.isUnstagedOnly(view) ? (
        <Text style={[type.caption, { color: colors.warning }]}>Will not run: {view.blockedReason}</Text>
      ) : null}
      {canStage || targets.length ? (
        <View style={styles.cardActions}>
          {canStage ? (
            <Button
              size="sm"
              variant="outline"
              icon="shield-checkmark-outline"
              title="Stage for autonomous work…"
              disabled={busy}
              onPress={() => actions.openStagePrompt(item.id)}
              accessibilityLabel={`Stage ${item.title} for autonomous work — opens an authorisation review`}
            />
          ) : null}
          {targets.length ? (
            <Button
              size="sm"
              variant="ghost"
              icon="swap-horizontal"
              title="Move to…"
              disabled={busy}
              loading={busy}
              onPress={() => onMove(item)}
              accessibilityLabel={`Move ${item.title} to another stage`}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/** Stage picker for one work item — only legal targets, staged flagged. */
export function MoveSheet({ item, onClose, onPick }) {
  const targets = item ? M.WORK_ITEM_TRANSITIONS[item.status] || [] : [];
  return (
    <OptionSheet
      visible={!!item}
      onClose={onClose}
      title="Move to stage"
      subtitle={item ? `${item.title} — now ${M.STAGE_LABELS[item.status]}` : undefined}
      options={targets.map((t) => ({
        key: t,
        label: M.STAGE_LABELS[t],
        icon: t === M.AUTONOMY_STAGE ? 'warning-outline' : 'arrow-forward-circle-outline',
        tone: t === M.AUTONOMY_STAGE ? 'warning' : t === 'cancelled' || t === 'escalated' ? 'danger' : undefined,
        sub: t === M.AUTONOMY_STAGE ? 'Opens the authorisation review first.' : undefined,
      }))}
      onSelect={(key) => onPick(item, key)}
    />
  );
}

export function WorkBoard({ state, actions }) {
  const { colors, type } = useUIKit();
  const byStage = useMemo(() => M.groupWorkItems(state.workItems), [state.workItems, state.busyWorkItemId, state.lastLoadedAt]);
  const names = useMemo(() => new Map(state.employees.map((e) => [e.id, e.name])), [state.employees]);
  const models = useMemo(() => new Map(state.employees.map((e) => [e.id, e.model])), [state.employees]);
  const total = state.workItems.length;
  const stagedCount = byStage[M.AUTONOMY_STAGE]?.length ?? 0;
  const firstNonEmpty = M.BOARD_COLUMNS.find((c) => (byStage[c.key] || []).length)?.key || 'queued';
  const [picked, setPicked] = useState(null);
  const column = picked || firstNonEmpty;
  const colDef = M.BOARD_COLUMNS.find((c) => c.key === column) || M.BOARD_COLUMNS[0];
  const items = byStage[column] || [];
  const shown = items.slice(0, M.COLUMN_CARD_CAP);
  const [moving, setMoving] = useState(null);

  return (
    <Panel
      title="Live work board"
      count={`${total} item${total === 1 ? '' : 's'} · ${stagedCount} staged${
        state.liveAt ? ` · live ${M.relativeTime(state.liveAt)}` : ''
      }`}
      action={
        <PanelAction
          title="Assign"
          disabled={state.employees.length === 0}
          onPress={() => actions.openComposer('work-item')}
          accessibilityLabel="Assign a new work item to an employee"
        />
      }
    >
      {state.executorEnabled ? (
        <Note tone="primary" icon="flash-outline" title="Autonomous execution is ON.">
          Moving a card into Staged authorises the assigned AI employee to spawn its coder backend and do the work.
          Nothing in Backlog ever runs.
        </Note>
      ) : (
        <Note tone="warning" icon="pause-circle-outline" title="Autonomous execution is OFF.">
          Staging a card still records your authorisation, but nothing will run until
          cron.agencyOperatingLoop.executeWorkItems is enabled. Cards will sit in Staged.
        </Note>
      )}
      <Tabs
        tabs={M.BOARD_COLUMNS.map((c) => ({
          key: c.key,
          label: c.short || c.label,
          count: (byStage[c.key] || []).length,
          icon: c.gate ? 'shield-checkmark-outline' : undefined,
        }))}
        active={column}
        onSelect={setPicked}
      />
      <View style={[styles.colHint, { borderColor: colDef.gate ? colors.primary : colors.borderSubtle || colors.border }]}>
        <Text style={[type.label, { color: colDef.gate ? colors.primary : colors.textSecondary }]}>
          {colDef.label} · {items.length}
        </Text>
        <Text style={[type.caption, { color: colors.textMuted }]}>{colDef.hint}</Text>
      </View>
      {total === 0 ? (
        <PanelEmpty
          icon="git-branch-outline"
          title="The board is waiting for its first card"
          message="The loop turns recurring responsibilities into Backlog cards. Add one, or assign a one-off item — either way nothing runs until you stage it."
          actionLabel="Add a responsibility"
          onAction={() => actions.openComposer('responsibility')}
          secondaryLabel="Assign a one-off item"
          onSecondary={() => actions.openComposer('work-item')}
        />
      ) : shown.length === 0 ? (
        <Text style={[type.caption, styles.colEmpty, { color: colors.textMuted }]}>EMPTY</Text>
      ) : (
        <View style={{ gap: SPACE.sm }}>
          {shown.map((item) => (
            <WorkCard
              key={item.id}
              item={item}
              state={state}
              actions={actions}
              employeeName={names.get(item.workerId) ?? item.workerId}
              employeeModel={models.get(item.workerId) ?? undefined}
              onMove={setMoving}
            />
          ))}
          {items.length > shown.length ? (
            <Text style={[type.caption, styles.colEmpty, { color: colors.textMuted }]}>
              +{items.length - shown.length} more not shown
            </Text>
          ) : null}
        </View>
      )}
      <MoveSheet
        item={moving}
        onClose={() => setMoving(null)}
        onPick={(item, stage) => {
          setMoving(null);
          actions.requestStage(item.id, stage);
        }}
      />
    </Panel>
  );
}

const styles = StyleSheet.create({
  card: { padding: SPACE.md, gap: SPACE.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  shimmer: { height: 2, borderRadius: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.xs },
  colHint: { borderLeftWidth: 2, paddingLeft: SPACE.sm, gap: 2, borderRadius: RADIUS.sm },
  colEmpty: { textAlign: 'center', paddingVertical: SPACE.lg, letterSpacing: 1.2 },
});
