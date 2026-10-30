/**
 * GoalsPhasesScreen — native Goals & Phases page (registry key 'goals').
 *
 * Mirrors the web /autonomy page's first three sections 1:1:
 *   Goals      verified goal runs        (goals.*            + goal.* events)
 *   Phases     gated phase queue         (queue.*            + queue.* events)
 *   Scheduled  scheduled agent tasks     (scheduledTasks.*   + scheduledTask.changed)
 *
 * Route params (deep links infinibot://goals/<id>, phases/<id>, scheduled/<id>):
 *   { view?: 'goals'|'phases'|'scheduled', goal?, phase?, task? }
 *
 * Mounted as a root-stack modal (headerShown:false) → renders its own header.
 * The header back button first closes an open detail on phones, then leaves.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet, useWindowDimensions, BackHandler, Platform } from 'react-native';

import { useUIKit, SPACE, AppHeader, SegmentedControl } from '../../ui-kit';
import { resolveRouteParams, VIEWS, normalizeView } from './goals-model';
import { GoalsTab } from './GoalsTab';
import { PhasesTab } from './PhasesTab';
import { ScheduledTab } from './ScheduledTab';

const SUBTITLE = {
  goals: 'Runs that keep working until every check passes',
  phases: 'Verified, gated phases on any agent',
  scheduled: 'Read-only repo reviews with approvals',
};

export function GoalsPhasesScreen({ navigation, route, gateway }) {
  const { colors } = useUIKit();
  const { width } = useWindowDimensions();
  const wide = width >= 820;

  const initial = resolveRouteParams(route?.params);
  const [view, setView] = useState(initial.view);
  const [focus, setFocus] = useState({ goal: initial.goal, phase: initial.phase, task: initial.task });
  const backRef = useRef(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Deep link re-entry while mounted (params change on the same route).
  const p = route?.params || {};
  useEffect(() => {
    const r = resolveRouteParams(p);
    setView(r.view);
    setFocus({ goal: r.goal, phase: r.phase, task: r.task });
  }, [p.view, p.goal, p.phase, p.task]); // eslint-disable-line react-hooks/exhaustive-deps

  const registerBack = useCallback((fn) => { backRef.current = fn; }, []);

  const goBack = useCallback(() => {
    if (backRef.current && backRef.current()) return true;
    if (navigation?.canGoBack?.()) navigation.goBack();
    else navigation?.navigate?.('MainTabs');
    return true;
  }, [navigation]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (backRef.current && backRef.current()) return true;
      return false;
    });
    return () => sub.remove();
  }, []);

  const changeView = (v) => {
    backRef.current = null;
    setFocus({ goal: null, phase: null, task: null });
    setView(normalizeView(v));
  };

  const connected = gateway?.status === 'connected';
  const tabProps = { gateway, wide, registerBack, navigation, reloadSignal: reloadKey };

  return (
    <View style={[s.root, { backgroundColor: colors.background || '#070707' }]}>
      <AppHeader
        eyebrow="Autonomy"
        title="Goals & Phases"
        subtitle={connected ? SUBTITLE[view] : 'Connecting to the gateway…'}
        leftIcon="chevron-back"
        onLeftPress={goBack}
        leftLabel="Back"
        rightActions={[
          { key: 'refresh', icon: 'refresh', label: 'Reload', onPress: () => setReloadKey((k) => k + 1), disabled: !connected },
        ]}
      >
        <SegmentedControl
          options={VIEWS.map((v) => ({ key: v.key, label: v.label, icon: v.icon }))}
          value={view}
          onChange={changeView}
        />
      </AppHeader>
      <View style={s.body} key={view}>
        {view === 'goals' ? <GoalsTab {...tabProps} focusId={focus.goal} /> : null}
        {view === 'phases' ? <PhasesTab {...tabProps} focusId={focus.phase} /> : null}
        {view === 'scheduled' ? <ScheduledTab {...tabProps} focusId={focus.task} /> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, paddingBottom: SPACE.xs },
});

export default GoalsPhasesScreen;
