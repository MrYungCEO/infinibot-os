/**
 * ChartPanel — web <chart-grid-panel>: TradingView pairs and Solana tokens.
 *
 * The web tile embeds TradingView / DexScreener iframes; the phone draws a
 * NATIVE chart instead (react-native-svg) from the same markets' public data:
 *   · crypto pairs (BINANCE:* / COINBASE:*)  → exchange candle APIs → line chart
 *   · other TradingView symbols (FX, stocks, indices) → no free candle feed; the
 *     tile says so and opens TradingView in the browser
 *   · Solana tokens (by mint address)        → DexScreener token stats
 * Pairs / tokens / mode persist per device (same defaults as the web).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { Button, Chip, Field, IconButton, SegmentedControl, SPACE, StatCard, useUIKit } from '../../../ui-kit';
import {
  CHART_RANGES, DEFAULT_TV_PAIRS, candlesUrl, chartSourceFor, compactNumber, fmtPrice, fmtUsd, groupPairs, linePath, parseCandles,
  parseDexToken, tradingViewUrl,
} from '../grid-data';
import { PanelEmpty, PanelError, PanelLoading, withTimeout } from '../panel-kit';

const MODE_KEY = 'infinibot-chart-mode';
const PAIRS_KEY = 'infinibot-chart-tv-pairs';
const COINS_KEY = 'infinibot-chart-saved-coins';

async function getJson(url) {
  const res = await withTimeout(fetch(url), 15000, 'market data');
  if (!res.ok) throw new Error(`Market data HTTP ${res.status}`);
  return res.json();
}

export function ChartPanel({ panel, onPatch, refreshSignal }) {
  const { colors, type } = useUIKit();
  const [mode, setMode] = useState('tradingview');
  const [pairs, setPairs] = useState(DEFAULT_TV_PAIRS);
  const [coins, setCoins] = useState([]);
  const [adding, setAdding] = useState(false);
  const [inA, setInA] = useState('');
  const [inB, setInB] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [m, p, c] = await Promise.all([AsyncStorage.getItem(MODE_KEY), AsyncStorage.getItem(PAIRS_KEY), AsyncStorage.getItem(COINS_KEY)]);
        if (m === 'solana' || m === 'tradingview') setMode(m);
        const pp = p ? JSON.parse(p) : null;
        if (Array.isArray(pp) && pp.length) setPairs(pp);
        const cc = c ? JSON.parse(c) : null;
        if (Array.isArray(cc)) setCoins(cc);
      } catch { /* defaults */ }
    })();
  }, []);

  const changeMode = (m) => { setMode(m); setAdding(false); AsyncStorage.setItem(MODE_KEY, m).catch(() => {}); };
  const symbol = panel.chartSymbol || pairs[0]?.symbol || 'BINANCE:BTCUSDT';
  const address = panel.chartAddress || coins[0]?.address || '';

  const addItem = () => {
    if (mode === 'tradingview') {
      const sym = inA.trim().toUpperCase();
      if (!sym) return;
      const next = [...pairs.filter((p) => p.symbol !== sym), { symbol: sym, name: inB.trim() || sym, category: 'custom' }];
      setPairs(next);
      AsyncStorage.setItem(PAIRS_KEY, JSON.stringify(next)).catch(() => {});
      onPatch({ chartSymbol: sym });
    } else {
      const addr = inA.trim();
      if (!addr) return;
      const next = [...coins.filter((c) => c.address !== addr), { address: addr, name: inB.trim() || `${addr.slice(0, 6)}...` }];
      setCoins(next);
      AsyncStorage.setItem(COINS_KEY, JSON.stringify(next)).catch(() => {});
      onPatch({ chartAddress: addr });
    }
    setInA('');
    setInB('');
    setAdding(false);
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.pad} nestedScrollEnabled keyboardShouldPersistTaps="handled">
      <View style={styles.topRow}>
        <SegmentedControl size="sm" options={[{ key: 'tradingview', label: 'Markets' }, { key: 'solana', label: 'Solana' }]} value={mode} onChange={changeMode} style={styles.flex} />
        <IconButton icon={adding ? 'close' : 'add'} size="sm" variant="outline" onPress={() => setAdding((a) => !a)} accessibilityLabel={mode === 'tradingview' ? 'Add a pair' : 'Add a token'} />
      </View>
      {adding ? (
        <View style={styles.addBox}>
          <Field label={mode === 'tradingview' ? 'Symbol' : 'Token address'} value={inA} onChangeText={setInA} placeholder={mode === 'tradingview' ? 'BINANCE:PEPEUSDT' : 'Mint address'} mono autoCapitalize={mode === 'tradingview' ? 'characters' : 'none'} />
          <Field label="Name" value={inB} onChangeText={setInB} placeholder="Optional" />
          <Button title="Add" variant="secondary" onPress={addItem} />
        </View>
      ) : null}

      {mode === 'tradingview' ? (
        <>
          <PairChart symbol={symbol} name={pairs.find((p) => p.symbol === symbol)?.name} refreshSignal={refreshSignal} />
          {groupPairs(pairs).map((g) => (
            <View key={g.cat} style={styles.group}>
              <Text style={[type.label, { color: colors.textMuted }]}>{g.cat}</Text>
              <View style={styles.wrap}>
                {g.items.map((p) => <Chip key={p.symbol} size="sm" label={p.name} selected={p.symbol === symbol} onPress={() => onPatch({ chartSymbol: p.symbol })} />)}
              </View>
            </View>
          ))}
        </>
      ) : coins.length === 0 ? (
        <PanelEmpty icon="logo-bitcoin" title="No Solana tokens" message="Add a token by its mint address to track price and liquidity." actionLabel="Add token" onAction={() => setAdding(true)} />
      ) : (
        <>
          <TokenStats address={address} refreshSignal={refreshSignal} />
          <View style={styles.wrap}>
            {coins.map((c) => <Chip key={c.address} size="sm" label={c.name} selected={c.address === address} onPress={() => onPatch({ chartAddress: c.address })} />)}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function PairChart({ symbol, name, refreshSignal }) {
  const { colors, type } = useUIKit();
  const [range, setRange] = useState('3m');
  const [w, setW] = useState(0);
  const [state, setState] = useState({ loading: true, error: null, points: [] });
  const source = chartSourceFor(symbol);

  const load = useCallback(async () => {
    if (!source) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const json = await getJson(candlesUrl(source, range));
      setState({ loading: false, error: null, points: parseCandles(source, json) });
    } catch (err) {
      setState({ loading: false, error: String(err?.message || err), points: [] });
    }
  }, [symbol, range]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load, refreshSignal]);
  useEffect(() => {
    if (!source) return undefined;
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const H = 150;
  const lp = useMemo(() => linePath(state.points, w, H), [state.points, w]);
  const up = (lp?.changePct ?? 0) >= 0;
  const c = up ? colors.success : colors.error;

  return (
    <View style={styles.chartBox}>
      <View style={styles.chartHead}>
        <View style={styles.flex}>
          <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>{name || symbol}</Text>
          <Text style={[type.monoSmall, { color: colors.textMuted }]}>{symbol}</Text>
        </View>
        {lp ? (
          <View style={styles.priceCol}>
            <Text style={[type.metricSmall, { color: colors.text }]}>{fmtPrice(lp.last)}</Text>
            <Text style={[type.monoSmall, { color: c }]}>{`${up ? '+' : ''}${lp.changePct.toFixed(2)}%`}</Text>
          </View>
        ) : null}
      </View>
      {!source ? (
        <PanelEmpty icon="trending-up-outline" title="TradingView market" message="This market has no free price feed for a native chart. Open it on TradingView." actionLabel="Open TradingView" onAction={() => Linking.openURL(tradingViewUrl(symbol))} />
      ) : (
        <>
          <View style={{ height: H }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
            {state.loading && !lp ? <PanelLoading rows={2} /> : state.error && !lp ? <PanelError message={state.error} onRetry={load} /> : lp ? (
              <Svg width={w} height={H}>
                <Defs>
                  <LinearGradient id="gridChartFill" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor={c} stopOpacity="0.28" />
                    <Stop offset="1" stopColor={c} stopOpacity="0" />
                  </LinearGradient>
                </Defs>
                <Path d={lp.area} fill="url(#gridChartFill)" />
                <Path d={lp.d} stroke={c} strokeWidth={2} fill="none" />
                <Circle cx={lp.lastXY[0]} cy={lp.lastXY[1]} r={3.5} fill={c} />
              </Svg>
            ) : null}
          </View>
          <View style={styles.rangeRow}>
            <Text style={[type.monoSmall, { color: colors.textMuted, flex: 1 }]}>{lp ? `L ${fmtPrice(lp.min)}  H ${fmtPrice(lp.max)}` : ''}</Text>
            {CHART_RANGES.map((r) => <Chip key={r.key} size="sm" label={r.label} selected={range === r.key} onPress={() => setRange(r.key)} />)}
          </View>
        </>
      )}
    </View>
  );
}

function TokenStats({ address, refreshSignal }) {
  const { colors, type } = useUIKit();
  const [state, setState] = useState({ loading: true, error: null, t: null });
  const load = useCallback(async () => {
    if (!address) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const t = parseDexToken(await getJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`));
      setState({ loading: false, error: t ? null : 'No trading pairs found for this token.', t });
    } catch (err) {
      setState({ loading: false, error: String(err?.message || err), t: null });
    }
  }, [address]);
  useEffect(() => { load(); }, [load, refreshSignal]);
  const t = state.t;
  if (state.loading && !t) return <PanelLoading rows={3} />;
  if (!t) return <PanelError message={state.error} onRetry={load} />;
  return (
    <View style={styles.chartBox}>
      <View style={styles.chartHead}>
        <View style={styles.flex}>
          <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>{t.symbol || t.name}</Text>
          <Text style={[type.monoSmall, { color: colors.textMuted }]} numberOfLines={1}>{`${address.slice(0, 12)}...  ${t.dex}`}</Text>
        </View>
        <Text style={[type.metricSmall, { color: colors.text }]}>{`$${fmtPrice(t.priceUsd)}`}</Text>
      </View>
      <View style={styles.changes}>
        {t.changes.map((ch) => (
          <View key={ch.key} style={styles.change}>
            <Text style={[type.caption, { color: colors.textMuted }]}>{ch.label}</Text>
            <Text style={[type.monoSmall, { color: ch.pct >= 0 ? colors.success : colors.error }]}>{`${ch.pct >= 0 ? '+' : ''}${ch.pct.toFixed(1)}%`}</Text>
          </View>
        ))}
      </View>
      <View style={styles.statsRow}>
        <StatCard compact label="Liquidity" value={fmtUsd(t.liquidityUsd)} style={styles.flex} />
        <StatCard compact label="Vol 24h" value={`$${compactNumber(t.volume24h)}`} style={styles.flex} />
      </View>
      {t.url ? <Button title="Open on DexScreener" variant="ghost" icon="open-outline" size="sm" onPress={() => Linking.openURL(t.url)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  pad: { padding: SPACE.sm, gap: SPACE.sm, paddingBottom: SPACE.lg },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  addBox: { gap: SPACE.sm },
  group: { gap: SPACE.xs },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  chartBox: { gap: SPACE.sm },
  chartHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  priceCol: { alignItems: 'flex-end' },
  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  changes: { flexDirection: 'row', justifyContent: 'space-between' },
  change: { alignItems: 'center', flex: 1 },
  statsRow: { flexDirection: 'row', gap: SPACE.sm },
});
