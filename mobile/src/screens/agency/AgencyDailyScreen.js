/**
 * AgencyDailyScreen — native Agency Today / Daily Operations (web
 * /agency-daily → /ceo?view=today). One screen answers: what work is queued,
 * moving or escalated; which reviews are due; which approvals block someone;
 * what the AI workforce is doing; and whether the operating loop is running.
 *
 * Sections (1:1 with the web page):
 *   operating loop strip (Run now) · KPI cards + Needs attention ·
 *   Operations command (Delivery / Side by side / Autonomy) with the
 *   Projects & tasks board and the Live work board · Approvals waiting ·
 *   Reviews · Recurring responsibilities · Delivery pulse · AI workforce.
 * Logic: daily/useAgencyDaily.js (RPCs) + daily/daily-model.js (pure).
 */
import React from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import {
  Screen,
  AppHeader,
  Card,
  Chip,
  Button,
  SegmentedControl,
  Skeleton,
  EmptyState,
  useUIKit,
  SPACE,
} from '../../ui-kit';
import { PluginGate } from '../../components/PluginGate';
import * as M from './daily/daily-model';
import { useAgencyDaily } from './daily/useAgencyDaily';
import { Note, KpiTile } from './daily/parts';
import { WorkBoard } from './daily/WorkBoard';
import { DeliveryBoard } from './daily/DeliveryBoard';
import {
  ApprovalsPanel,
  ReviewsPanel,
  ResponsibilitiesPanel,
  DeliveryPulsePanel,
  WorkforcePanel,
} from './daily/Panels';
import { StagePrompt, ComposerSheet, WorkItemSheet, HandoffSheet, TaskDetailSheet } from './daily/Overlays';

function LoopStrip({ state, actions }) {
  const { colors, type } = useUIKit();
  const loop = state.loop;
  const health = M.loopHealth(loop);
  return (
    <Card padded={false} tint={health.tone === 'ok' ? 'success' : 'warning'} style={styles.loop}>
      <View style={styles.rowWrap}>
        <Chip size="sm" label="Operating loop" tone={health.tone === 'ok' ? 'success' : 'warning'} dot />
        {loop.runningAtMs ? <Chip size="sm" label="running now" tone="info" dot /> : null}
        {loop.lastError ? <Chip size="sm" label="last run errored" tone="danger" icon="alert-circle-outline" /> : null}
      </View>
      <Text style={[type.small, { color: colors.textSecondary }]}>
        {health.text} Last run{' '}
        <Text style={{ color: colors.primary, fontWeight: '700' }}>{M.relativeTime(loop.lastRunAtMs)}</Text>
        {loop.lastStatus ? ` (${loop.lastStatus})` : ''} · next {loop.nextRunAtMs ? M.clockTime(loop.nextRunAtMs) : '—'}
      </Text>
      {loop.lastError ? (
        <Text style={[type.caption, { color: colors.error }]} numberOfLines={3}>
          {loop.lastError}
        </Text>
      ) : null}
      <View style={styles.loopFoot}>
        {state.loopResult ? (
          <Text style={[type.caption, { color: colors.text, flex: 1 }]}>{state.loopResult}</Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Button
          size="sm"
          variant="outline"
          icon="play"
          title={state.loopRunning ? 'Running…' : 'Run now'}
          loading={state.loopRunning}
          onPress={() => actions.runLoopNow()}
          accessibilityLabel="Run the workforce operating loop now"
        />
      </View>
    </Card>
  );
}

function OpsSwitch({ state, actions }) {
  const { colors, type } = useUIKit();
  const unassigned = M.unownedOpenCount(state.tasks);
  return (
    <Card padded={false} style={styles.ops}>
      <Text style={[type.label, { color: colors.primary }]}>Operations command</Text>
      <Text style={[type.caption, { color: colors.textSecondary }]}>
        {state.projects.length} project{state.projects.length === 1 ? '' : 's'} · {state.tasks.length} task
        {state.tasks.length === 1 ? '' : 's'} ·{' '}
        <Text style={{ color: colors.text, fontWeight: '700' }}>{unassigned} open with no owner</Text> ·{' '}
        {state.employees.length} AI employee{state.employees.length === 1 ? '' : 's'} available to take them
      </Text>
      <SegmentedControl
        size="sm"
        options={M.BOARD_MODES.map((m) => ({ key: m.key, label: m.label }))}
        value={state.mode}
        onChange={(mode) => actions.setMode(mode)}
      />
    </Card>
  );
}

export function AgencyDailyScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const { width } = useWindowDimensions();
  const wide = width >= 700;
  const { state, actions, connected } = useAgencyDaily(gateway);
  const kpiCols = width >= 1000 ? 5 : width >= 640 ? 3 : 2;
  const kpiW = kpiCols === 5 ? '18.8%' : kpiCols === 3 ? '31.9%' : '48.5%';
  const attention = M.attentionCount(state.workItems, state.reviews, state.approvals);
  const firstLoad = !state.lastLoadedAt;
  const showDelivery = state.mode !== 'autonomy';
  const showAutonomy = state.mode !== 'delivery';

  const header = (
    <AppHeader
      variant="premium"
      eyebrow="Agency Today"
      title="Daily Operations"
      subtitle={`${state.agencyName || 'no agency selected'} · ${
        state.lastLoadedAt ? `synced ${M.relativeTime(state.lastLoadedAt)}` : 'not synced'
      }`}
      leftIcon="chevron-back"
      leftLabel="Back"
      onLeftPress={() => navigation?.goBack?.()}
      rightActions={[
        {
          key: 'refresh',
          icon: 'refresh',
          label: 'Refresh daily operations',
          busy: state.refreshing,
          disabled: state.refreshing || !connected,
          onPress: () => actions.refresh(),
        },
      ]}
    />
  );

  let content;
  if (!connected && firstLoad) {
    content = (
      <EmptyState
        icon="cloud-offline-outline"
        title="Not connected"
        message="Daily Operations reads the live gateway. Connect, then pull to refresh."
        actionLabel="Retry"
        onAction={() => actions.load()}
      />
    );
  } else if (firstLoad && state.error) {
    content = (
      <EmptyState
        tone="danger"
        icon="alert-circle-outline"
        title="Couldn't load daily operations"
        message={state.error}
        actionLabel="Retry"
        onAction={() => actions.load()}
      />
    );
  } else if (firstLoad) {
    content = (
      <View style={{ gap: SPACE.md }} accessibilityLabel="Loading daily operations">
        <Skeleton height={86} radius={16} />
        <View style={styles.kpis}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={92} radius={16} style={{ width: '48.5%' }} />
          ))}
        </View>
        <Skeleton height={120} radius={16} />
        <Skeleton height={320} radius={16} />
      </View>
    );
  } else if (!state.agencyId) {
    content = (
      <EmptyState
        icon="business-outline"
        title="No agency selected"
        message="Daily Operations reads one agency at a time. Pick or create one in Agency Operations and it scopes this page too."
        actionLabel="Open Agency Operations"
        onAction={() => navigation?.navigate?.('AgencyOperationsModal')}
      />
    );
  } else {
    const boards = (
      <View style={[styles.split, wide && showDelivery && showAutonomy && styles.splitWide]}>
        {showDelivery ? (
          <View style={wide && showAutonomy ? styles.half : null}>
            <DeliveryBoard state={state} actions={actions} />
          </View>
        ) : null}
        {showAutonomy ? (
          <View style={wide && showDelivery ? styles.half : null}>
            <WorkBoard state={state} actions={actions} />
          </View>
        ) : null}
      </View>
    );
    const panels = [
      <ApprovalsPanel key="ap" state={state} actions={actions} />,
      <ReviewsPanel key="rv" state={state} actions={actions} />,
      <ResponsibilitiesPanel key="rs" state={state} actions={actions} />,
      <DeliveryPulsePanel key="dp" state={state} columns={wide ? 5 : 2} />,
      <WorkforcePanel key="wf" state={state} actions={actions} />,
    ];
    content = (
      <View style={{ gap: SPACE.md }}>
        {state.agencies.length > 1 ? (
          <View style={styles.rowWrap}>
            {state.agencies.map((a) => (
              <Chip
                key={a.id}
                label={a.name}
                icon="business-outline"
                tone="primary"
                selected={a.id === state.agencyId}
                onPress={() => actions.selectAgency(a.id)}
                accessibilityLabel={`Show agency ${a.name}`}
              />
            ))}
          </View>
        ) : null}
        <LoopStrip state={state} actions={actions} />
        <View style={styles.kpis}>
          {state.kpis.map((kpi) => (
            <KpiTile
              key={kpi.id || kpi.label}
              label={kpi.label}
              value={kpi.value}
              context={kpi.context}
              dim={M.isZeroish(kpi.value)}
              style={{ width: kpiW }}
            />
          ))}
          <KpiTile
            label="Needs attention"
            value={String(attention.total)}
            context={`${attention.escalated} escalated · ${attention.overdueReviews} overdue reviews · ${attention.approvals} approvals`}
            dim={attention.total === 0}
            tone={attention.total ? 'warning' : undefined}
            style={{ width: kpiW }}
          />
        </View>
        <OpsSwitch state={state} actions={actions} />
        {boards}
        {wide ? (
          <View style={styles.grid}>
            {panels.map((p, i) => (
              <View key={i} style={styles.gridItem}>
                {p}
              </View>
            ))}
          </View>
        ) : (
          panels
        )}
      </View>
    );
  }

  const body = (
    <Screen
      header={header}
      refreshing={state.refreshing}
      onRefresh={connected ? () => actions.refresh() : undefined}
      edges={['bottom', 'left', 'right']}
      keyboardAvoiding
    >
      <View style={{ gap: SPACE.md, paddingTop: SPACE.md }}>
        {state.error && !firstLoad ? (
          <Note tone="danger" icon="alert-circle-outline" onDismiss={() => actions.dismissError()}>
            {state.error}
          </Note>
        ) : null}
        {state.failedRequests.length ? (
          <Note
            tone="warning"
            icon="warning-outline"
            title={`${state.failedRequests.length} request(s) failed — panels below may be incomplete.`}
          >
            <View style={{ gap: 2 }}>
              {state.failedRequests.map((entry) => (
                <Text key={entry} style={[type.caption, { color: colors.textSecondary }]}>
                  {entry}
                </Text>
              ))}
            </View>
          </Note>
        ) : null}
        {state.notice ? (
          <Note tone="success" icon="checkmark-circle-outline" onDismiss={() => actions.dismissNotice()} dismissLabel="Dismiss confirmation">
            {state.notice}
          </Note>
        ) : null}
        {content}
      </View>
      <StagePrompt state={state} actions={actions} />
      <ComposerSheet state={state} actions={actions} />
      <WorkItemSheet
        state={state}
        actions={actions}
        onOpenTerminals={() => navigation?.navigate?.('TerminalsModal')}
      />
      <HandoffSheet state={state} actions={actions} />
      <TaskDetailSheet
        state={state}
        actions={actions}
        onOpenProjects={(task) => {
          try {
            navigation?.navigate?.('MainTabs', { screen: 'Board', params: { taskId: task.id, projectId: task.projectId, _ts: Date.now() } });
          } catch {
            /* the Board tab may not exist in this build */
          }
        }}
      />
    </Screen>
  );

  return (
    <PluginGate pluginId="business-agency" title="Agency Today" navigation={navigation}>
      {body}
    </PluginGate>
  );
}

const styles = StyleSheet.create({
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, alignItems: 'center' },
  loop: { padding: SPACE.md, gap: SPACE.sm },
  loopFoot: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  ops: { padding: SPACE.md, gap: SPACE.sm },
  split: { gap: SPACE.md },
  splitWide: { flexDirection: 'row', alignItems: 'flex-start' },
  half: { flex: 1, minWidth: 0 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.md },
  gridItem: { width: '48.9%' },
});

export default AgencyDailyScreen;
