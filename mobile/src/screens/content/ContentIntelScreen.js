// ContentIntelScreen — mobile mirror of the control-UI Content Intelligence
// dashboard (ui/src/ui/views/content-intel.ts). Reel thumbnail grid + scores /
// tiers, a data-viz band (tier donut, top savers, score-vs-views scatter, avg
// breakdown), search / filter / sort, and a detail modal with a PLAYABLE reel
// (expo-video, served Range-capable by the gateway), the AI score grid +
// reason, the transcript, and a one-tap handoff to the CMO agent.
//
// Data comes from the SAME content.intel.* gateway RPCs the web uses, with the
// baked snapshot HTTP fallback so the screen renders before a gateway restart.
// Live scoring (Score all / Score now) streams over the content.intel.progress
// event when the scoring RPCs are registered, exactly like the web view.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGatewayAuthHeaders } from '../../utils/storage';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Image,
  Modal,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
  Linking,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import VideoPlayerView from '../../components/VideoPlayerView';
import Svg, { Circle, Line } from 'react-native-svg';
import { COLORS, FONT_FAMILY } from '../../constants/theme';
import { withAlpha, headerGradient } from '../../theme/color-utils';
import {
  fetchIntel,
  fetchReel,
  fetchCapabilities,
  scoreReel,
  scoreBatch,
  cancelBatch,
  getHttpOrigin,
  assetUrl,
  videoUrl,
  fmt,
  fmtDur,
  engagementRate,
  tierClass,
  PROGRESS_EVENT,
} from './contentIntelApi';

const FILTERS = ['all', 'scored', 'unscored', 'transcribed'];
const SORTS = [
  { key: 'views', label: 'Views' },
  { key: 'saves', label: 'Saves' },
  { key: 'overall', label: 'Score' },
  { key: 'recent', label: 'Recent' },
];

// Tier accent colors — gold-intensity ladder, NO rainbow (matches web tierStroke).
function tierColor(tier) {
  switch (tierClass(tier)) {
    case 'a': return '#f0d089';
    case 'b': return '#d8bd84';
    case 'c': return '#b39a64';
    case 'd': return 'rgba(247,247,247,0.55)';
    default:  return 'rgba(247,247,247,0.32)';
  }
}

export function ContentIntelScreen({ gateway, navigation, route }) {
  const [payload, setPayload] = useState(null);
  const [origin, setOrigin] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('views');
  const [tierFilter, setTierFilter] = useState(null);
  const [detail, setDetail] = useState(null); // reel object (may be hydrated)
  const [caps, setCaps] = useState(null);

  // Live scoring state machine, driven by content.intel.progress frames.
  const [scorePhase, setScorePhase] = useState({}); // shortcode -> queued|scoring|scored|failed
  const [batch, setBatch] = useState(null); // { total, done } while a batch runs
  const payloadRef = useRef(null);
  useEffect(() => { payloadRef.current = payload; }, [payload]);

  const load = useCallback(async () => {
    const org = await getHttpOrigin();
    setOrigin(org);
    const data = await fetchIntel(gateway);
    setPayload(data);
    setLoading(false);
    fetchCapabilities(gateway).then(setCaps);
    const openShortcode = route?.params?.openShortcode;
    if (openShortcode && data?.reels) {
      const reel = data.reels.find((r) => r.shortcode === openShortcode);
      if (reel) setDetail(reel);
    }
  }, [gateway, route]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // ── Live scoring progress subscription ──────────────────────────
  useEffect(() => {
    if (!gateway?.subscribeEvent) return undefined;
    const unsub = gateway.subscribeEvent(PROGRESS_EVENT, (p) => {
      if (!p?.phase) return;
      if (p.phase === 'batch-start') {
        setBatch({ total: p.total || 0, done: 0 });
      } else if (p.phase === 'queued' || p.phase === 'scoring') {
        setScorePhase((s) => ({ ...s, [p.shortcode]: p.phase }));
      } else if (p.phase === 'scored') {
        setScorePhase((s) => ({ ...s, [p.shortcode]: 'scored' }));
        setBatch((b) => (b ? { ...b, done: b.done + 1 } : b));
        // Merge the freshly-scored reel into the payload in place.
        setPayload((cur) => {
          if (!cur || !p.reel) return cur;
          const reels = cur.reels.map((r) => (r.shortcode === p.reel.shortcode ? { ...r, ...p.reel } : r));
          return { ...cur, reels, totals: p.totals || cur.totals, tier_distribution: p.tier_distribution || cur.tier_distribution };
        });
      } else if (p.phase === 'failed') {
        setScorePhase((s) => ({ ...s, [p.shortcode]: 'failed' }));
        setBatch((b) => (b ? { ...b, done: b.done + 1 } : b));
      } else if (p.phase === 'batch-done') {
        setBatch(null);
        setPayload((cur) => (cur ? { ...cur, totals: p.totals || cur.totals, tier_distribution: p.tier_distribution || cur.tier_distribution } : cur));
      }
    });
    return unsub;
  }, [gateway]);

  const handleScoreOne = useCallback(async (reel) => {
    setScorePhase((s) => ({ ...s, [reel.shortcode]: 'queued' }));
    try { await scoreReel(gateway, reel.shortcode); } catch { /* progress event reports failure */ }
  }, [gateway]);

  const handleScoreAll = useCallback(async () => {
    try { await scoreBatch(gateway); } catch { /* already running / no key */ }
  }, [gateway]);

  const handleCancelBatch = useCallback(async () => {
    try { await cancelBatch(gateway); } catch { /* ignore */ }
  }, [gateway]);

  // ── Filter + sort ───────────────────────────────────────────────
  const reels = useMemo(() => {
    const all = payload?.reels || [];
    const q = search.trim().toLowerCase();
    let out = all.filter((r) => {
      if (filter === 'scored' && !r.has_score) return false;
      if (filter === 'unscored' && r.has_score) return false;
      if (filter === 'transcribed' && !r.has_transcript) return false;
      if (tierFilter && (r.tier || '—') !== tierFilter) return false;
      if (q && !(r.description || '').toLowerCase().includes(q) && !(r.shortcode || '').toLowerCase().includes(q)) return false;
      return true;
    });
    out = [...out].sort((a, b) => {
      if (sort === 'overall') return (b.overall ?? -1) - (a.overall ?? -1);
      if (sort === 'saves') return (b.saves ?? 0) - (a.saves ?? 0);
      if (sort === 'recent') return String(b.publish_time || '').localeCompare(String(a.publish_time || ''));
      return (b.views ?? 0) - (a.views ?? 0);
    });
    return out;
  }, [payload, search, filter, sort, tierFilter]);

  const openDetail = useCallback(async (reel) => {
    setDetail(reel);
    // Lazy-hydrate transcript text via the live RPC (snapshot has none).
    const full = await fetchReel(gateway, reel.shortcode);
    if (full) setDetail((d) => (d && d.shortcode === full.shortcode ? { ...d, ...full } : d));
  }, [gateway]);

  const askCmo = useCallback((reel) => {
    setDetail(null);
    const seed =
      `Analyze this reel from my library and tell me why it ${(reel.overall ?? 0) >= 7 ? 'won' : 'underperformed'}: ` +
      `${reel.shortcode} — "${(reel.description || '').slice(0, 120)}" ` +
      `(${fmt(reel.views)} views, ${fmt(reel.saves)} saves${reel.has_score ? `, hook ${reel.hook}/value ${reel.value}/viral ${reel.viral}` : ''}). ` +
      `What should I do MORE of, and what's the single highest-leverage change for my next 10 reels?`;
    navigation?.navigate?.('CMOChatModal', { gateway, seed });
  }, [navigation, gateway]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['left', 'right']}>
        <Header navigation={navigation} payload={null} />
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.primary} />
          <Text style={styles.muted}>Loading content intelligence…</Text>
        </View>
      </SafeAreaView>
    );
  }

  const totals = payload?.totals;

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Header navigation={navigation} payload={payload} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
      >
        {totals ? <Kpis totals={totals} /> : null}
        <ScoreBar caps={caps} batch={batch} onScoreAll={handleScoreAll} onCancel={handleCancelBatch} />
        {payload ? <VizBand payload={payload} onPick={openDetail} /> : null}

        {/* Controls */}
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={15} color={COLORS.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search caption or shortcode…"
            placeholderTextColor={COLORS.textMuted}
            value={search}
            onChangeText={setSearch}
          />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {FILTERS.map((f) => (
            <TouchableOpacity key={f} style={[styles.chip, filter === f && styles.chipOn]} onPress={() => setFilter(f)}>
              <Text style={[styles.chipText, filter === f && styles.chipTextOn]}>{f}</Text>
            </TouchableOpacity>
          ))}
          <View style={styles.chipDivider} />
          {SORTS.map((s) => (
            <TouchableOpacity key={s.key} style={[styles.chip, sort === s.key && styles.chipOn]} onPress={() => setSort(s.key)}>
              <Text style={[styles.chipText, sort === s.key && styles.chipTextOn]}>↓ {s.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TierFilter dist={payload?.tier_distribution} active={tierFilter} onPick={setTierFilter} />

        <Text style={styles.countLine}>{reels.length} reels</Text>

        {/* Thumbnail grid */}
        <View style={styles.grid}>
          {reels.map((r) => (
            <ReelCard
              key={r.shortcode}
              reel={r}
              origin={origin}
              phase={scorePhase[r.shortcode]}
              scoringAvailable={!!caps?.scoring}
              batchRunning={!!batch}
              onPress={() => openDetail(r)}
              onScore={() => handleScoreOne(r)}
            />
          ))}
          {reels.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyChip}><Ionicons name="film-outline" size={26} color={COLORS.gold} /></View>
              <Text style={styles.muted}>No reels match.</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {detail ? (
        <DetailModal
          reel={detail}
          origin={origin}
          source={payload?.source}
          scoringAvailable={!!caps?.scoring}
          batchRunning={!!batch}
          onScore={() => handleScoreOne(detail)}
          onClose={() => setDetail(null)}
          onAskCmo={() => askCmo(detail)}
        />
      ) : null}
    </SafeAreaView>
  );
}

// ── Header ──────────────────────────────────────────────────────────
function Header({ navigation, payload }) {
  const src = payload?.source;
  return (
    <LinearGradient
      colors={headerGradient(COLORS.gold)}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.header}
    >
      <TouchableOpacity style={styles.backChip} onPress={() => navigation?.goBack?.()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
        <Ionicons name="arrow-back" size={20} color={COLORS.gold} />
      </TouchableOpacity>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={styles.title}>Content Intelligence</Text>
        <View style={styles.subRow}>
          {payload?.account ? <Text style={styles.account}>@{payload.account}</Text> : null}
          {src === 'live' ? (
            <View style={[styles.srcBadge, styles.srcLive]}><Text style={styles.srcLiveText}>● LIVE</Text></View>
          ) : src === 'snapshot' ? (
            <View style={[styles.srcBadge, styles.srcSnap]}><Text style={styles.srcSnapText}>SNAPSHOT</Text></View>
          ) : null}
        </View>
      </View>
    </LinearGradient>
  );
}

// ── KPI hero ────────────────────────────────────────────────────────
function Kpis({ totals }) {
  const pct = totals.reels ? Math.round((totals.scored / totals.reels) * 100) : 0;
  return (
    <View style={styles.kpis}>
      <Kpi label="Reels" val={fmt(totals.reels)} />
      <Kpi label="Total views" val={fmt(totals.total_views)} />
      <Kpi label="Total saves" val={fmt(totals.total_saves)} />
      <LinearGradient
        colors={[withAlpha(COLORS.gold, 0.55), withAlpha(COLORS.gold, 0.08), 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.kpiAccentWrap}
      >
        <View style={[styles.kpi, styles.kpiAccent]}>
          <Text style={styles.kpiVal}>{totals.scored}<Text style={styles.kpiOf}> / {totals.reels}</Text></Text>
          <Text style={styles.kpiLbl}>Scored</Text>
          <View style={styles.meter}>
            <LinearGradient
              colors={COLORS.goldGradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={[styles.meterFill, { width: `${pct}%` }]}
            />
          </View>
        </View>
      </LinearGradient>
    </View>
  );
}
function Kpi({ label, val }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiVal}>{val}</Text>
      <Text style={styles.kpiLbl}>{label}</Text>
    </View>
  );
}

// ── Score bar (live scoring) ────────────────────────────────────────
function ScoreBar({ caps, batch, onScoreAll, onCancel }) {
  if (!caps?.scoring) {
    return (
      <View style={styles.scoreBar}>
        <Ionicons name="flash-off-outline" size={14} color={COLORS.textMuted} />
        <Text style={styles.scoreHint}>Live scoring activates after a gateway restart.</Text>
      </View>
    );
  }
  if (batch) {
    const pct = batch.total ? Math.round((batch.done / batch.total) * 100) : 0;
    return (
      <View style={styles.scoreBar}>
        <View style={styles.pulseDot} />
        <Text style={styles.scoreHint}>Scoring {batch.done}/{batch.total}…</Text>
        <View style={styles.batchTrack}>
          <LinearGradient colors={COLORS.goldGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[styles.batchFill, { width: `${pct}%` }]} />
        </View>
        <TouchableOpacity style={styles.scoreCancel} onPress={onCancel}><Text style={styles.scoreCancelText}>Cancel</Text></TouchableOpacity>
      </View>
    );
  }
  return (
    <View style={styles.scoreBar}>
      <TouchableOpacity activeOpacity={0.85} onPress={onScoreAll}>
        <LinearGradient colors={COLORS.goldGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.scoreAllBtn}>
          <Ionicons name="flash" size={14} color={COLORS.background} />
          <Text style={styles.scoreAllText}>Score all unscored ({caps.unscored ?? 0})</Text>
        </LinearGradient>
      </TouchableOpacity>
      {!caps.hasApiKey ? <Text style={[styles.scoreHint, { color: COLORS.goldLight }]}><Ionicons name="warning-outline" size={12} color={COLORS.goldLight} /> no OpenRouter key</Text> : null}
    </View>
  );
}

// ── Tier filter chips ───────────────────────────────────────────────
function TierFilter({ dist, active, onPick }) {
  const order = ['S', 'A', 'B', 'C', 'D', '—'];
  const keys = order.filter((k) => (dist?.[k] ?? 0) > 0);
  if (keys.length === 0) return null;
  return (
    <View style={styles.tierFilter}>
      {keys.map((k) => {
        const on = active === k;
        return (
          <TouchableOpacity
            key={k}
            style={[styles.tierChip, { borderColor: tierColor(k) }, on && { backgroundColor: tierColor(k) }]}
            onPress={() => onPick(on ? null : k)}
          >
            <Text style={[styles.tierChipText, on && { color: COLORS.background }]}>{k} · {dist[k]}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ── Viz band ────────────────────────────────────────────────────────
function VizBand({ payload, onPick }) {
  return (
    <View style={styles.vizBand}>
      <Donut payload={payload} />
      <TopSavers payload={payload} onPick={onPick} />
      <Scatter payload={payload} />
      <AggBars payload={payload} />
    </View>
  );
}

function Donut({ payload }) {
  const dist = payload?.tier_distribution || {};
  const order = ['S', 'A', 'B', 'C', 'D', '—'];
  const entries = order.filter((k) => (dist[k] ?? 0) > 0).map((k) => ({ key: k, val: dist[k] }));
  const total = entries.reduce((s, e) => s + e.val, 0) || 1;
  const scored = payload?.totals?.scored ?? 0;
  const R = 46, C = 56, SW = 13, circ = 2 * Math.PI * R;
  let offset = 0;
  return (
    <View style={styles.vizCard}>
      <Text style={styles.vizTitle}>Tier distribution</Text>
      <View style={styles.donutWrap}>
        <Svg width={112} height={112} viewBox="0 0 112 112">
          <Circle cx={C} cy={C} r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={SW} />
          {entries.map((e) => {
            const len = (e.val / total) * circ;
            const el = (
              <Circle
                key={e.key}
                cx={C} cy={C} r={R} fill="none"
                stroke={tierColor(e.key)} strokeWidth={SW}
                strokeDasharray={`${len} ${circ - len}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${C} ${C})`}
              />
            );
            offset += len;
            return el;
          })}
        </Svg>
        <View style={styles.donutCenter} pointerEvents="none">
          <Text style={styles.donutNum}>{scored}</Text>
          <Text style={styles.donutLbl}>scored</Text>
        </View>
        <View style={styles.donutLegend}>
          {entries.map((e) => (
            <View key={e.key} style={styles.leg}>
              <View style={[styles.legDot, { backgroundColor: tierColor(e.key) }]} />
              <Text style={styles.legText}>{e.key} <Text style={styles.legB}>{e.val}</Text></Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function TopSavers({ payload, onPick }) {
  const top = [...(payload?.reels || [])]
    .filter((r) => (r.saves ?? 0) > 0)
    .sort((a, b) => (b.saves ?? 0) - (a.saves ?? 0))
    .slice(0, 6);
  const max = top[0]?.saves ?? 1;
  return (
    <View style={styles.vizCard}>
      <Text style={styles.vizTitle}>Top performers · saves</Text>
      {top.length === 0 ? (
        <Text style={styles.vizEmpty}>No save data.</Text>
      ) : (
        top.map((r) => {
          const w = Math.max(4, Math.round(((r.saves ?? 0) / max) * 100));
          return (
            <TouchableOpacity key={r.shortcode} style={styles.barRow} onPress={() => onPick(r)}>
              <Text style={styles.barLabel} numberOfLines={1}>{r.description || r.shortcode}</Text>
              <View style={styles.barTrack}>
                <LinearGradient colors={COLORS.goldGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[styles.barFill, { width: `${w}%` }]} />
              </View>
              <Text style={styles.barVal}>{fmt(r.saves)}</Text>
            </TouchableOpacity>
          );
        })
      )}
    </View>
  );
}

function Scatter({ payload }) {
  const scored = (payload?.reels || []).filter((r) => r.has_score && r.overall != null);
  const W = 240, H = 132, PAD_L = 26, PAD_B = 20, PAD_T = 8, PAD_R = 8;
  const views = scored.map((r) => Math.max(1, r.views ?? 1));
  const minLog = Math.log10(Math.min(...(views.length ? views : [1])));
  const maxLog = Math.log10(Math.max(...(views.length ? views : [10])));
  const span = maxLog - minLog || 1;
  const x = (v) => PAD_L + ((Math.log10(Math.max(1, v)) - minLog) / span) * (W - PAD_L - PAD_R);
  const y = (o) => PAD_T + (1 - o / 10) * (H - PAD_T - PAD_B);
  const gridY = [0, 2.5, 5, 7.5, 10];
  return (
    <View style={styles.vizCard}>
      <Text style={styles.vizTitle}>Score vs views</Text>
      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
        {gridY.map((g) => (
          <Line key={g} x1={PAD_L} y1={y(g)} x2={W - PAD_R} y2={y(g)} stroke="rgba(255,255,255,0.07)" strokeWidth={1} />
        ))}
        {scored.map((r) => (
          <Circle key={r.shortcode} cx={x(r.views ?? 1)} cy={y(r.overall ?? 0)} r={4} fill={tierColor(r.tier)} />
        ))}
      </Svg>
      <Text style={styles.scatterAxis}>views (log) →</Text>
    </View>
  );
}

function AggBars({ payload }) {
  const scored = (payload?.reels || []).filter((r) => r.has_score);
  const avg = (sel) => {
    const vals = scored.map(sel).filter((v) => v != null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  };
  const metrics = [
    { label: 'Hook', v: avg((r) => r.hook) },
    { label: 'Value', v: avg((r) => r.value) },
    { label: 'Viral', v: avg((r) => r.viral) },
    { label: 'Overall', v: avg((r) => r.overall) },
  ];
  return (
    <View style={styles.vizCard}>
      <Text style={styles.vizTitle}>Avg score breakdown</Text>
      <View style={styles.agg}>
        {metrics.map((m) => (
          <View key={m.label} style={styles.aggCol}>
            <View style={styles.aggBarWrap}>
              <LinearGradient colors={COLORS.goldGradientBright} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={[styles.aggBar, { height: `${Math.round((m.v / 10) * 100)}%` }]} />
            </View>
            <Text style={styles.aggV}>{scored.length ? m.v.toFixed(1) : '—'}</Text>
            <Text style={styles.aggL}>{m.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── Reel card ───────────────────────────────────────────────────────
const GRID_GAP = 12;
const SCREEN_W = Dimensions.get('window').width;
const CARD_W = (SCREEN_W - 16 * 2 - GRID_GAP) / 2;

function ReelCard({ reel, origin, phase, scoringAvailable, batchRunning, onPress, onScore }) {
  const thumb = assetUrl(origin, reel.thumbnail_url);
  const isWorking = phase === 'queued' || phase === 'scoring';
  const er = engagementRate(reel);
  return (
    <TouchableOpacity style={[styles.card, { width: CARD_W, borderColor: reel.has_score ? tierColor(reel.tier) : COLORS.cardBorder }]} activeOpacity={0.85} onPress={onPress}>
      <View style={styles.cardThumb}>
        {thumb ? (
          <Image source={{ uri: thumb }} style={styles.thumbImg} resizeMode="cover" />
        ) : (
          <View style={styles.thumbFallback}><Ionicons name="film-outline" size={26} color={COLORS.textMuted} /></View>
        )}
        <View style={styles.thumbShade} />

        {reel.has_score && reel.tier ? (
          <View style={[styles.tierBadge, { backgroundColor: tierColor(reel.tier) }]}><Text style={styles.tierLetter}>{reel.tier}</Text></View>
        ) : isWorking ? (
          <View style={[styles.tierBadge, styles.tierWorking]}>{phase === 'queued' ? <Text style={styles.workingLbl}>…</Text> : <Ionicons name="flash" size={11} color="#fff" />}</View>
        ) : phase === 'failed' ? (
          <View style={[styles.tierBadge, styles.tierFailed]}><Text style={styles.tierLetter}>!</Text></View>
        ) : null}

        {reel.has_score && reel.overall != null ? (
          <View style={styles.scorePill}><Text style={styles.scorePillText}>{reel.overall.toFixed(1)}</Text></View>
        ) : null}
        {reel.duration_sec ? <View style={styles.durBadge}><Text style={styles.durText}>{fmtDur(reel.duration_sec)}</Text></View> : null}

        {reel.has_transcript && !reel.has_score && scoringAvailable && !isWorking ? (
          <TouchableOpacity style={styles.scoreNowWrap} onPress={onScore} disabled={batchRunning} activeOpacity={0.85}>
            <LinearGradient colors={COLORS.goldGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.scoreNow}>
              <Text style={styles.scoreNowText}>{phase === 'failed' ? null : <Ionicons name="flash" size={11} color={COLORS.background} />}{phase === 'failed' ? 'Retry' : ' Score'}</Text>
            </LinearGradient>
          </TouchableOpacity>
        ) : null}
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardDesc} numberOfLines={2}>{reel.description || '(no caption)'}</Text>
        <View style={styles.cardFoot}>
          <Text style={styles.stat}><Text style={styles.statB}>{fmt(reel.views)}</Text> views</Text>
          <Text style={styles.stat}><Text style={styles.statB}>{fmt(reel.saves)}</Text> saves</Text>
        </View>
        {er != null ? <Text style={styles.engLine}>{er.toFixed(1)}% eng</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

// ── Detail modal (playable reel + score + transcript + Ask CMO) ─────
function DetailModal({ reel, origin, source, scoringAvailable, batchRunning, onScore, onClose, onAskCmo }) {
  // The video route is a gateway HTTP route and needs the gateway credential.
  const [authHeaders, setAuthHeaders] = useState({});
  useEffect(() => {
    let alive = true;
    getGatewayAuthHeaders().then((h) => {
      if (alive) setAuthHeaders(h);
    });
    return () => {
      alive = false;
    };
  }, []);
  const vurl = videoUrl(origin, reel);
  const thumb = assetUrl(origin, reel.thumbnail_url);
  const [playing, setPlaying] = useState(false);
  const transcript = reel.transcript || null;
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalScrim}>
        <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
          <View style={styles.modalHandle} />
          <View style={styles.modalTopBar}>
            <Text style={styles.modalTitle} numberOfLines={1}>{reel.shortcode}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={COLORS.text} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.modalScroll}>
            {/* Playable reel */}
            <View style={styles.player}>
              {playing && vurl ? (
                <VideoPlayerView
                  uri={vurl}
                  headers={authHeaders}
                  style={styles.video}
                  autoPlay
                  loop
                  onError={() => setPlaying(false)}
                />
              ) : (
                <TouchableOpacity style={styles.playerPoster} activeOpacity={0.9} onPress={() => vurl && setPlaying(true)}>
                  {thumb ? <Image source={{ uri: thumb }} style={styles.posterImg} resizeMode="cover" /> : <View style={styles.thumbFallback} />}
                  <View style={styles.playOverlay}>
                    <Ionicons name={vurl ? 'play-circle' : 'logo-instagram'} size={56} color="#fff" />
                    {!vurl ? <Text style={styles.playHint}>Open in Instagram</Text> : null}
                  </View>
                </TouchableOpacity>
              )}
            </View>

            <Text style={styles.modalDesc}>{reel.description || '(no caption)'}</Text>
            <View style={styles.modalStats}>
              {[['views', reel.views], ['reach', reel.reach], ['likes', reel.likes], ['comments', reel.comments], ['shares', reel.shares], ['saves', reel.saves]].map(([k, v]) => (
                <View key={k} style={styles.mStat}><Text style={styles.mStatV}>{fmt(v)}</Text><Text style={styles.mStatL}>{k}</Text></View>
              ))}
            </View>

            {/* AI score */}
            {reel.has_score ? (
              <>
                <View style={styles.scoreGrid}>
                  {[['Hook', reel.hook], ['Value', reel.value], ['Viral', reel.viral], ['Overall', reel.overall]].map(([k, v]) => (
                    <View key={k} style={styles.scoreCell}>
                      <Text style={styles.scoreCellV}>{v != null ? Number(v).toFixed(1) : '—'}</Text>
                      <Text style={styles.scoreCellL}>{k}</Text>
                    </View>
                  ))}
                </View>
                {reel.reason ? <Text style={styles.reason}><Text style={styles.reasonB}>Why: </Text>{reel.reason}</Text> : null}
                {reel.idea_vs_execution ? <Text style={styles.reason}><Text style={styles.reasonB}>Idea vs execution: </Text>{reel.idea_vs_execution}</Text> : null}
              </>
            ) : reel.has_transcript && scoringAvailable ? (
              <TouchableOpacity onPress={onScore} disabled={batchRunning} activeOpacity={0.85}>
                <LinearGradient colors={COLORS.goldGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.scoreBigBtn}>
                  <Ionicons name="flash" size={16} color={COLORS.background} />
                  <Text style={styles.scoreAllText}>Score this reel</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : null}

            {/* Ask CMO handoff */}
            <TouchableOpacity style={styles.cmoBtn} onPress={onAskCmo}>
              <Ionicons name="chatbubbles" size={16} color={COLORS.primary} />
              <Text style={styles.cmoBtnText}>Ask the CMO about this reel</Text>
            </TouchableOpacity>

            {/* Transcript */}
            <Text style={styles.transcriptLabel}>Transcript {reel.transcript_engine ? `(${reel.transcript_engine})` : ''}</Text>
            {transcript ? (
              <Text style={styles.transcript}>{transcript}</Text>
            ) : reel.has_transcript ? (
              <Text style={styles.transcriptMuted}>{source === 'snapshot' ? 'Transcript text is only available with the live RPC (restart the gateway).' : 'Loading transcript…'}</Text>
            ) : (
              <Text style={styles.transcriptMuted}>No transcript for this reel yet.</Text>
            )}

            <TouchableOpacity style={styles.openLink} onPress={() => reel.url && Linking.openURL(reel.url)}>
              <Text style={styles.openLinkText}>Open reel on Instagram ↗</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  muted: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 13, textAlign: 'center' },
  emptyState: { width: '100%', alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 40 },
  emptyChip: {
    width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.gold, 0.1), borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.25),
  },
  scroll: { padding: 16, paddingBottom: 60 },

  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: withAlpha(COLORS.gold, 0.15),
  },
  backChip: {
    width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(14,13,18,0.6)', borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.25),
  },
  title: { color: COLORS.text, fontFamily: FONT_FAMILY.bold, fontSize: 19, letterSpacing: 0.4 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  account: { color: COLORS.gold, fontFamily: FONT_FAMILY.semiBold, fontSize: 12 },
  srcBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  srcLive: { borderColor: withAlpha(COLORS.gold, 0.4), backgroundColor: withAlpha(COLORS.gold, 0.12) },
  srcLiveText: { color: COLORS.goldLight, fontFamily: FONT_FAMILY.bold, fontSize: 9, letterSpacing: 0.6 },
  srcSnap: { borderColor: withAlpha(COLORS.gold, 0.3), backgroundColor: withAlpha(COLORS.gold, 0.08) },
  srcSnapText: { color: COLORS.gold, fontFamily: FONT_FAMILY.bold, fontSize: 9, letterSpacing: 0.6 },

  // KPIs
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  kpi: {
    flexGrow: 1, flexBasis: '46%', padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(14,13,18,0.6)', borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.18),
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 14, elevation: 6,
  },
  kpiAccentWrap: { flexGrow: 1, flexBasis: '46%', borderRadius: 18, padding: 1 },
  kpiAccent: {
    flexGrow: 0, flexBasis: 'auto', borderRadius: 17, borderWidth: 0,
    backgroundColor: 'rgba(10,10,14,0.72)',
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.28, shadowRadius: 16, elevation: 8,
  },
  kpiVal: { color: COLORS.text, fontFamily: FONT_FAMILY.extraBold, fontSize: 24, letterSpacing: -0.3 },
  kpiOf: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.semiBold, fontSize: 15 },
  kpiLbl: { color: COLORS.gold, fontFamily: FONT_FAMILY.semiBold, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginTop: 6 },
  meter: { marginTop: 8, height: 5, borderRadius: 999, backgroundColor: withAlpha(COLORS.gold, 0.1), overflow: 'hidden' },
  meterFill: { height: '100%', borderRadius: 999, backgroundColor: COLORS.gold },

  // Score bar
  scoreBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, padding: 12, borderRadius: 16,
    borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.18), backgroundColor: 'rgba(14,13,18,0.6)',
  },
  scoreHint: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 12, flexShrink: 1 },
  scoreAllBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999,
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 6,
  },
  scoreAllText: { color: COLORS.background, fontFamily: FONT_FAMILY.bold, fontSize: 13 },
  pulseDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: COLORS.gold, shadowColor: COLORS.gold, shadowOpacity: 0.6, shadowRadius: 6 },
  batchTrack: { flex: 1, height: 6, borderRadius: 999, backgroundColor: withAlpha(COLORS.gold, 0.1), overflow: 'hidden' },
  batchFill: { height: '100%', borderRadius: 999, backgroundColor: COLORS.gold },
  scoreCancel: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.4), backgroundColor: 'rgba(20,20,28,0.55)' },
  scoreCancelText: { color: COLORS.text, fontFamily: FONT_FAMILY.semiBold, fontSize: 12 },

  // Viz band
  vizBand: { marginTop: 16, gap: 12 },
  vizCard: {
    padding: 14, borderRadius: 18, borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.18),
    backgroundColor: 'rgba(14,13,18,0.6)',
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 14, elevation: 5,
  },
  vizTitle: { color: COLORS.gold, fontFamily: FONT_FAMILY.semiBold, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  vizEmpty: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 12, paddingVertical: 16, textAlign: 'center' },
  donutWrap: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  donutCenter: { position: 'absolute', left: 0, width: 112, height: 112, alignItems: 'center', justifyContent: 'center' },
  donutNum: { color: COLORS.text, fontFamily: FONT_FAMILY.extraBold, fontSize: 24 },
  donutLbl: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.8 },
  donutLegend: { flex: 1, gap: 5 },
  leg: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legDot: { width: 9, height: 9, borderRadius: 3 },
  legText: { color: COLORS.textSecondary, fontFamily: FONT_FAMILY.regular, fontSize: 12 },
  legB: { color: COLORS.text, fontFamily: FONT_FAMILY.bold },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 9 },
  barLabel: { flex: 1, color: COLORS.textSecondary, fontFamily: FONT_FAMILY.regular, fontSize: 11 },
  barTrack: { width: 80, height: 8, borderRadius: 999, backgroundColor: withAlpha(COLORS.gold, 0.1), overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 999, backgroundColor: COLORS.gold },
  barVal: { width: 44, textAlign: 'right', color: COLORS.gold, fontFamily: FONT_FAMILY.bold, fontSize: 11 },
  scatterAxis: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 9, textAlign: 'center', marginTop: 2 },
  agg: { flexDirection: 'row', gap: 10, alignItems: 'flex-end', height: 120 },
  aggCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' },
  aggBarWrap: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'flex-end' },
  aggBar: { width: '55%', minHeight: 4, borderTopLeftRadius: 6, borderTopRightRadius: 6, backgroundColor: COLORS.gold },
  aggV: { color: COLORS.text, fontFamily: FONT_FAMILY.extraBold, fontSize: 14, marginTop: 6 },
  aggL: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 2 },

  // Controls
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, paddingHorizontal: 14, height: 44, borderRadius: 14,
    borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.2), backgroundColor: 'rgba(20,20,28,0.55)',
  },
  searchInput: { flex: 1, color: COLORS.text, fontFamily: FONT_FAMILY.regular, fontSize: 14, padding: 0 },
  chipRow: { gap: 8, paddingVertical: 12, alignItems: 'center' },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.18), backgroundColor: 'rgba(14,13,18,0.6)' },
  chipOn: { backgroundColor: withAlpha(COLORS.gold, 0.18), borderColor: withAlpha(COLORS.gold, 0.5) },
  chipText: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.semiBold, fontSize: 12, textTransform: 'capitalize' },
  chipTextOn: { color: COLORS.gold },
  chipDivider: { width: 1, height: 20, backgroundColor: withAlpha(COLORS.gold, 0.2), marginHorizontal: 2 },
  tierFilter: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
  tierChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, backgroundColor: 'rgba(14,13,18,0.6)' },
  tierChipText: { color: COLORS.text, fontFamily: FONT_FAMILY.semiBold, fontSize: 12 },
  countLine: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 12, marginTop: 8, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.8 },

  // Grid
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  card: {
    borderRadius: 16, borderWidth: 1, backgroundColor: 'rgba(14,13,18,0.6)', overflow: 'hidden',
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 14, elevation: 6,
  },
  cardThumb: { aspectRatio: 0.86, backgroundColor: '#0c0c12', position: 'relative' },
  thumbImg: { width: '100%', height: '100%' },
  thumbFallback: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0c0c12' },
  thumbShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent' },
  tierBadge: {
    position: 'absolute', top: 7, left: 7, minWidth: 22, height: 22, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5,
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.5, shadowRadius: 6, elevation: 4,
  },
  tierLetter: { color: '#1a1408', fontFamily: FONT_FAMILY.extraBold, fontSize: 12 },
  tierWorking: { backgroundColor: withAlpha(COLORS.gold, 0.4) },
  tierFailed: { backgroundColor: 'rgba(220,90,90,0.85)' },
  workingLbl: { color: '#fff', fontFamily: FONT_FAMILY.bold, fontSize: 11 },
  scorePill: {
    position: 'absolute', top: 7, right: 7, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    backgroundColor: 'rgba(10,10,14,0.72)', borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.4),
  },
  scorePillText: { color: COLORS.gold, fontFamily: FONT_FAMILY.bold, fontSize: 12 },
  durBadge: { position: 'absolute', bottom: 7, right: 7, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(10,10,14,0.72)', borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.18) },
  durText: { color: '#fff', fontFamily: FONT_FAMILY.medium, fontSize: 10 },
  scoreNowWrap: {
    position: 'absolute', bottom: 7, left: 7, borderRadius: 999, overflow: 'hidden',
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.5, shadowRadius: 8, elevation: 5,
  },
  scoreNow: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  scoreNowText: { color: COLORS.background, fontFamily: FONT_FAMILY.bold, fontSize: 11 },
  cardBody: { padding: 10 },
  cardDesc: { color: COLORS.text, fontFamily: FONT_FAMILY.regular, fontSize: 12, lineHeight: 16, minHeight: 32 },
  cardFoot: { flexDirection: 'row', gap: 12, marginTop: 7 },
  stat: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 11 },
  statB: { color: COLORS.text, fontFamily: FONT_FAMILY.bold },
  engLine: { color: COLORS.gold, fontFamily: FONT_FAMILY.semiBold, fontSize: 10, marginTop: 4 },

  // Detail modal
  modalScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  modal: { maxHeight: '92%', backgroundColor: 'rgba(10,10,14,0.96)', borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.2) },
  modalHandle: { alignSelf: 'center', width: 44, height: 4, borderRadius: 2, backgroundColor: withAlpha(COLORS.gold, 0.4), marginTop: 10 },
  modalTopBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: withAlpha(COLORS.gold, 0.12) },
  modalTitle: { flex: 1, color: COLORS.gold, fontFamily: FONT_FAMILY.bold, fontSize: 15, letterSpacing: 0.3 },
  modalScroll: { padding: 18, paddingTop: 14, paddingBottom: 30 },
  player: { width: '100%', aspectRatio: 0.62, maxHeight: 420, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000', borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.18) },
  video: { width: '100%', height: '100%' },
  playerPoster: { width: '100%', height: '100%' },
  posterImg: { width: '100%', height: '100%' },
  playOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)', gap: 6 },
  playHint: { color: '#fff', fontFamily: FONT_FAMILY.semiBold, fontSize: 12 },
  modalDesc: { color: COLORS.text, fontFamily: FONT_FAMILY.regular, fontSize: 14, lineHeight: 20, marginTop: 14 },
  modalStats: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 14, padding: 14, borderRadius: 16,
    borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.18), backgroundColor: 'rgba(14,13,18,0.6)',
  },
  mStat: { minWidth: 64 },
  mStatV: { color: COLORS.text, fontFamily: FONT_FAMILY.bold, fontSize: 16 },
  mStatL: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 },
  scoreGrid: { flexDirection: 'row', gap: 10, marginTop: 16 },
  scoreCell: {
    flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: 14, borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.2), backgroundColor: 'rgba(14,13,18,0.6)',
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.15, shadowRadius: 10, elevation: 4,
  },
  scoreCellV: { color: COLORS.gold, fontFamily: FONT_FAMILY.extraBold, fontSize: 18 },
  scoreCellL: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 3 },
  reason: { color: COLORS.textSecondary, fontFamily: FONT_FAMILY.regular, fontSize: 13, lineHeight: 19, marginTop: 12 },
  reasonB: { color: COLORS.gold, fontFamily: FONT_FAMILY.bold },
  scoreBigBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16, paddingVertical: 14, borderRadius: 14,
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 14, elevation: 6,
  },
  cmoBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 14, paddingVertical: 13, borderRadius: 14,
    borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.4), backgroundColor: withAlpha(COLORS.gold, 0.08),
  },
  cmoBtnText: { color: COLORS.gold, fontFamily: FONT_FAMILY.bold, fontSize: 13 },
  transcriptLabel: { color: COLORS.gold, fontFamily: FONT_FAMILY.semiBold, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginTop: 22, marginBottom: 8 },
  transcript: { color: COLORS.textSecondary, fontFamily: FONT_FAMILY.regular, fontSize: 13, lineHeight: 20 },
  transcriptMuted: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 12, fontStyle: 'italic' },
  openLink: { marginTop: 20, alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.4), backgroundColor: 'rgba(20,20,28,0.55)' },
  openLinkText: { color: COLORS.gold, fontFamily: FONT_FAMILY.semiBold, fontSize: 13 },
});

export default ContentIntelScreen;
