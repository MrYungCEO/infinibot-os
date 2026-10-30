/**
 * CreditsPanel — web <credit-usage-breakdown> grid tile: credit + token usage
 * for a period, split by provider and by agent backend. Same RPC as the
 * Credits page (credits.summary { period }); the token split reuses the
 * Credits screen's TokenDonut.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { SegmentedControl, SPACE, StatCard, useUIKit } from '../../../ui-kit';
import { TokenDonut } from '../../../components/credits/TokenDonut';
import { navigateToScreen } from '../../../navigation/screen-registry';
import { compactNumber, creditsModel, fmtUsd } from '../grid-data';
import { MiniLabel, PanelError, PanelLoading, PanelOpen, ShareBar, useRpc, withTimeout } from '../panel-kit';

const PERIODS = [{ key: 'day', label: 'Today' }, { key: 'week', label: 'Week' }, { key: 'month', label: 'Month' }];

export function CreditsPanel({ gateway, navigation, refreshSignal }) {
  const { colors, type } = useUIKit();
  const [period, setPeriod] = useState('day');
  const rpc = useRpc(gateway, (sendReq) => withTimeout(sendReq('credits.summary', { period }), 20000, 'credits.summary'), [period], { refreshSignal, pollMs: 60000 });
  const m = useMemo(() => (rpc.data ? creditsModel(rpc.data) : null), [rpc.data]);

  return (
    <View style={styles.root}>
      <SegmentedControl size="sm" options={PERIODS} value={period} onChange={setPeriod} style={styles.seg} />
      {!m ? (rpc.error ? <PanelError message={rpc.error} onRetry={() => rpc.reload()} /> : <PanelLoading rows={4} />) : (
        <ScrollView style={styles.flex} contentContainerStyle={styles.pad} nestedScrollEnabled>
          <View style={styles.stats}>
            <StatCard compact label="Spend" value={fmtUsd(m.totalCostUsd)} icon="wallet-outline" style={styles.flex} />
            <StatCard compact label="Requests" value={compactNumber(m.totalRequests)} icon="swap-vertical-outline" style={styles.flex} />
          </View>
          <View style={styles.donut}>
            <TokenDonut summary={rpc.data} colors={colors} />
          </View>
          <MiniLabel>{m.shareBy === 'cost' ? 'By provider - share of spend' : 'By provider - share of requests'}</MiniLabel>
          {m.providers.map((p) => (
            <View key={p.key} style={styles.prov}>
              <View style={styles.provHead}>
                <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{p.provider}{p.model ? ` / ${p.model}` : ''}</Text>
                <Text style={[type.monoSmall, { color: colors.textSecondary }]}>{m.shareBy === 'cost' ? fmtUsd(p.costUsd) : `${compactNumber(p.requests)} req`}</Text>
              </View>
              <ShareBar value={p.share} />
              <Text style={[type.monoSmall, { color: colors.textMuted }]}>{`${compactNumber(p.tokens)} tokens  ${compactNumber(p.cacheTokens)} cached`}</Text>
            </View>
          ))}
          {m.backends.length ? <MiniLabel>By agent backend</MiniLabel> : null}
          {m.backends.map((b) => (
            <View key={b.key} style={styles.provHead}>
              <Text style={[type.small, { color: colors.text, flex: 1 }]} numberOfLines={1}>{b.key}</Text>
              <Text style={[type.monoSmall, { color: colors.textSecondary }]}>{`${compactNumber(b.requests)} req  ${fmtUsd(b.costUsd)}`}</Text>
            </View>
          ))}
        </ScrollView>
      )}
      <PanelOpen label="Credits & Usage" onPress={() => navigateToScreen(navigation, { screen: 'CreditsScreen' }, { gateway })} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  seg: { margin: SPACE.sm },
  pad: { paddingHorizontal: SPACE.md, paddingBottom: SPACE.md },
  stats: { flexDirection: 'row', gap: SPACE.sm },
  donut: { marginTop: SPACE.md },
  prov: { gap: SPACE.xs, marginBottom: SPACE.sm },
  provHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 24 },
});
