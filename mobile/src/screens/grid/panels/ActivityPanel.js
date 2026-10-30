/**
 * ActivityPanel — the web grid's compact Activity feed
 * (views/grid-panels/activity-panel.ts → agent activity dashboard).
 * Same sources as the Activity page: subagents.list (running + recently
 * finished runs with their live updates) and sessions.list (recent sessions).
 * Polls every 10 s; "Open Activity" goes to the full native page.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { BottomSheet, ListRow, ProgressBar, SPACE, StatCard, StatusChip, useUIKit } from '../../../ui-kit';
import { navigateToScreen } from '../../../navigation/screen-registry';
import { activityModel, relTime } from '../grid-data';
import { MiniLabel, PanelEmpty, PanelError, PanelLoading, PanelOpen, useRpc, withTimeout } from '../panel-kit';

export function ActivityPanel({ gateway, navigation, refreshSignal }) {
  const { colors, type } = useUIKit();
  const [sel, setSel] = useState(null);
  const rpc = useRpc(gateway, async (sendReq) => {
    const [subs, sess] = await Promise.allSettled([
      withTimeout(sendReq('subagents.list', {}), 15000, 'subagents.list'),
      withTimeout(sendReq('sessions.list', { limit: 30, includeDerivedTitles: true }), 15000, 'sessions.list'),
    ]);
    if (subs.status === 'rejected' && sess.status === 'rejected') throw subs.reason;
    return { subs: subs.status === 'fulfilled' ? subs.value : null, sess: sess.status === 'fulfilled' ? sess.value : null };
  }, [], { refreshSignal, pollMs: 10000 });
  const m = useMemo(() => (rpc.data ? activityModel(rpc.data.subs, rpc.data.sess) : null), [rpc.data]);
  const open = () => navigateToScreen(navigation, { screen: 'ActivityScreen' }, { gateway });

  if (!m) return rpc.error ? <PanelError message={rpc.error} onRetry={() => rpc.reload()} /> : <PanelLoading rows={5} />;

  const row = (r) => (
    <ListRow
      key={r.id}
      dense
      icon={r.running ? 'flash-outline' : 'checkmark-done-outline'}
      iconTone={r.running ? 'primary' : 'neutral'}
      title={r.label}
      subtitle={r.lastMessage || relTime(r.updatedAt)}
      trailing={<StatusChip size="sm" status={r.status} />}
      onPress={() => setSel(r)}
      accessibilityLabel={`Run ${r.label}`}
    />
  );

  return (
    <View style={styles.root}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.pad} nestedScrollEnabled>
        <View style={styles.stats}>
          <StatCard compact label="Running" value={m.running.length} icon="flash-outline" style={styles.flex} />
          <StatCard compact label="Live sessions" value={m.liveSessions} icon="radio-outline" style={styles.flex} />
        </View>
        <MiniLabel>Running now</MiniLabel>
        {m.running.length ? m.running.map(row) : <Text style={[type.caption, { color: colors.textMuted }]}>No sub-agents running.</Text>}
        <MiniLabel>Recently finished</MiniLabel>
        {m.finished.length ? m.finished.map(row) : <Text style={[type.caption, { color: colors.textMuted }]}>Nothing finished recently.</Text>}
        <MiniLabel>Sessions</MiniLabel>
        {m.sessions.length ? m.sessions.map((s) => (
          <ListRow key={s.key} dense icon={s.live ? 'radio-outline' : 'chatbubble-outline'} iconTone={s.live ? 'success' : 'neutral'} title={s.title} value={relTime(s.updatedAt)} />
        )) : <PanelEmpty icon="pulse-outline" title="No sessions" />}
      </ScrollView>
      <PanelOpen label="Activity" onPress={open} />

      <BottomSheet visible={Boolean(sel)} onClose={() => setSel(null)} title={sel?.label} subtitle={sel ? `${sel.status}  ${relTime(sel.updatedAt)}` : ''}>
        {sel?.progress ? <ProgressBar value={sel.progress} showValue label="Progress" style={{ marginBottom: SPACE.md }} /> : null}
        {(sel?.updates || []).map((u, i) => (
          <ListRow key={`${u.ts}-${i}`} dense title={u.text || u.status} value={relTime(u.ts)} />
        ))}
        {sel && !sel.updates.length ? <Text style={[type.caption, { color: colors.textMuted }]}>No updates recorded.</Text> : null}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  pad: { padding: SPACE.md, paddingTop: SPACE.sm },
  stats: { flexDirection: 'row', gap: SPACE.sm },
});
