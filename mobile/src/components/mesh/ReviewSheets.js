/**
 * ReviewSheets — the web mesh's review surfaces as native sheets:
 *   · CompletedSheet — "Recently completed" rail (mesh-completed-rail.ts):
 *     All / Verified / Needs attention / Failed, search, 24h·6h·1h window,
 *     cards with verdict badge, summary, time · duration · files · commits ·
 *     deploy · thread, screenshot thumb. Built by the web's own
 *     buildCompletedEntries / filterCompleted.
 *   · ReviewPanel — the worker ↔ Auditor review thread (review-thread-view.ts)
 *     and the screenshot gallery (review-mesh-panel.ts, verdict / run filters).
 * Screenshot images are gateway HTTP routes, fetched with the app's credential.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';

import { getGatewayAuthHeaders } from '../../utils/storage';
import { DEPLOY_TEXT, KIND_LABEL, agentDisplayName, TONE_CSS, VERDICT_TEXT, VERDICT_TONE, buildCompletedEntries, clockTime, filterCompleted, formatDuration, packetTone, relativeTime, verdictLabel, verdictTone } from '../../lib/mesh/web-mesh.generated';
import { MeshSheet } from './MeshSheets';
import { GOLD, GOLD_LT, MONO } from './mesh-style';

const WINDOWS = [['24h', 24 * 3_600_000], ['6h', 6 * 3_600_000], ['1h', 3_600_000]];
const DEPLOY_TONE = { live: TONE_CSS.green, merged: TONE_CSS.cyan, restart_pending: TONE_CSS.amber, not_deployed: TONE_CSS.slate };

/** `/api/verification/file?path=…` for a screenshot path (feed.ts screenshotThumbUrl / FullUrl). */
export function shotUrl(httpBase, pathOrUrl, thumb = true) {
  if (!pathOrUrl) return null;
  if (/^(https?:|data:|blob:)/i.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith('/api/')) return `${httpBase}${pathOrUrl}`;
  return `${httpBase}/api/verification/file?path=${encodeURIComponent(pathOrUrl)}${thumb ? '&thumb=1' : ''}`;
}

let headersPromise = null;
function authHeaders() {
  if (!headersPromise) headersPromise = getGatewayAuthHeaders().catch(() => ({}));
  return headersPromise;
}

/** An <Image> for an authed gateway route (headers on native; a blob URL on the web export). */
export function AuthImage({ uri, style, resizeMode = 'cover', testID }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let alive = true;
    let objectUrl = null;
    if (!uri) return undefined;
    authHeaders().then(async (headers) => {
      if (!alive) return;
      if (Platform.OS !== 'web') {
        setSrc({ uri, headers });
        return;
      }
      try {
        const res = await fetch(uri, { headers });
        if (!res.ok) return;
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (alive) setSrc({ uri: objectUrl });
      } catch { /* offline */ }
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [uri]);
  return src ? <Image source={src} style={style} resizeMode={resizeMode} testID={testID} /> : <View style={[style, { backgroundColor: '#14120c' }]} />;
}

function Chip({ label, on, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function useCompletedEntries({ completed, screenshots, threads, threadsVersion }) {
  return useMemo(() => {
    const now = Date.now();
    const t = new Map((threads?.list?.() || []).map((th) => [th.summary.runId, th.summary]));
    return buildCompletedEntries(completed || [], { now, screenshots: screenshots || [], threads: t });
  }, [completed, screenshots, threads, threadsVersion]);
}

export function CompletedSheet({ visible, entries, httpBase, onClose, onOpen, landscape }) {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [win, setWin] = useState('24h');
  const now = Date.now();
  const list = useMemo(() => filterCompleted(entries, { filter, q, windowMs: WINDOWS.find(([k]) => k === win)[1], now }), [entries, filter, q, win]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <MeshSheet visible={visible} onClose={onClose} testID="mesh-completed-sheet" maxHeight={0.82} landscape={landscape}>
      <View style={styles.headRow}>
        <Text style={styles.title}>RECENTLY COMPLETED</Text>
        <Text style={styles.count}>{list.length}</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={onClose} style={styles.x} accessibilityRole="button" accessibilityLabel="Close"><Text style={styles.xText}>✕</Text></Pressable>
      </View>
      <View style={styles.chips}>
        <Chip label="All" on={filter === 'all'} onPress={() => setFilter('all')} />
        <Chip label="Verified" on={filter === 'verified'} onPress={() => setFilter('verified')} />
        <Chip label="Needs attention" on={filter === 'attention'} onPress={() => setFilter('attention')} />
        <Chip label="Failed" on={filter === 'failed'} onPress={() => setFilter('failed')} />
      </View>
      <View style={styles.searchRow}>
        <TextInput value={q} onChangeText={setQ} placeholder="Search completed…" placeholderTextColor="#7a7466" style={styles.search} accessibilityLabel="Search completed agents" />
        {WINDOWS.map(([k]) => <Chip key={k} label={k} on={win === k} onPress={() => setWin(k)} />)}
      </View>
      <FlatList
        style={{ flexGrow: 0 }}
        data={list}
        keyExtractor={(e) => e.runId}
        ListEmptyComponent={<Text style={styles.empty}>{entries.length ? 'Nothing matches these filters.' : 'No agents finished in this window yet.'}</Text>}
        renderItem={({ item: e }) => {
          const tone = TONE_CSS[VERDICT_TONE[e.verdict]];
          return (
            <Pressable onPress={() => onOpen(e)} style={[styles.card, { borderLeftColor: tone }]} accessibilityRole="button" accessibilityLabel={`${e.label}: ${VERDICT_TEXT[e.verdict]}. Open its review`} testID={`mesh-completed-${e.runId}`}>
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <View style={styles.cTop}>
                  <Text style={styles.cLabel} numberOfLines={1}>{e.label}</Text>
                  <View style={[styles.badge, { borderColor: tone }]}><Text style={[styles.badgeText, { color: tone }]}>{VERDICT_TEXT[e.verdict]}</Text></View>
                </View>
                {e.summary ? <Text style={styles.cSum} numberOfLines={2}>{e.summary}</Text> : null}
                <Text style={styles.cMeta} numberOfLines={1}>
                  {`🕑 ${relativeTime(e.finishedAt, now)}   ${formatDuration(e.durationMs)}   📄 ${e.files}   ✓ ${e.commits}`}
                  {e.deploy ? <Text style={{ color: DEPLOY_TONE[e.deploy] }}>{`   🚀 ${DEPLOY_TEXT[e.deploy]}`}</Text> : null}
                  {e.hasThread ? '   🛡' : ''}
                </Text>
              </View>
              {e.thumbUrl ? <AuthImage uri={shotUrl(httpBase, e.thumbUrl)} style={styles.thumb} /> : null}
            </Pressable>
          );
        }}
      />
    </MeshSheet>
  );
}

function MessageRow({ m, httpBase, onShot }) {
  const tone = TONE_CSS[packetTone(m)] || GOLD;
  return (
    <View style={[styles.msg, { borderLeftColor: tone }]}>
      <View style={styles.msgHead}>
        <Text style={[styles.msgKind, { color: tone }]}>{m.kind === 'verdict' && m.verdict ? verdictLabel(m.verdict) : KIND_LABEL[m.kind] || m.kind}</Text>
        <Text style={styles.msgMeta}>{m.from} → {m.to} · R{m.round} · {clockTime(m.ts)}</Text>
      </View>
      {m.title ? <Text style={styles.msgTitle}>{m.title}</Text> : null}
      {m.text ? <Text style={styles.msgText}>{m.text}</Text> : null}
      {Array.isArray(m.items) && m.items.length ? m.items.slice(0, 8).map((it, i) => <Text key={i} style={styles.msgItem}>• {it}</Text>) : null}
      {Array.isArray(m.screenshots) && m.screenshots.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {m.screenshots.slice(0, 8).map((p) => (
            <Pressable key={p} onPress={() => onShot(shotUrl(httpBase, p, false))}><AuthImage uri={shotUrl(httpBase, p)} style={styles.msgShot} /></Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

export function ReviewPanel({ panel, httpBase, threads, threadsVersion, loadThread, screenshots, loadScreenshots, onClose, onOpenRunInApp, landscape }) {
  const { width } = useWindowDimensions();
  const [full, setFull] = useState(null);
  const [runShots, setRunShots] = useState(null);
  const [verdict, setVerdict] = useState('all');
  const runId = panel?.runId || null;
  useEffect(() => {
    if (panel?.mode === 'thread' && runId) loadThread(runId);
    if (panel?.mode === 'gallery') {
      setRunShots(null);
      if (runId) loadScreenshots({ runId }).then((r) => setRunShots(r.items));
    }
  }, [panel?.mode, runId]); // eslint-disable-line react-hooks/exhaustive-deps
  const thread = runId ? threads.get(runId) : null;
  const summaries = useMemo(() => threads.list().map((t) => t.summary).sort((a, b) => b.lastTs - a.lastTs), [threads, threadsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const shots = (runShots || screenshots || []).filter((s) => verdict === 'all' || s.verdict === verdict);
  const cols = landscape ? 4 : width > 500 ? 3 : 2;
  return (
    <>
      <MeshSheet visible={!!panel} onClose={onClose} testID={panel?.mode === 'gallery' ? 'mesh-gallery' : 'mesh-review-thread'} maxHeight={0.86} landscape={landscape}>
        <View style={styles.headRow}>
          <Text style={styles.title} numberOfLines={1}>{panel?.mode === 'gallery' ? `SCREENSHOTS${runId ? ' · RUN' : ''}` : 'REVIEW THREAD'}</Text>
          <View style={{ flex: 1 }} />
          {runId ? <Pressable onPress={() => onOpenRunInApp(runId)} style={styles.inApp} accessibilityRole="button" accessibilityLabel="Open this run in the app"><Text style={styles.inAppText}>Open run ↗</Text></Pressable> : null}
          <Pressable onPress={onClose} style={styles.x} accessibilityRole="button" accessibilityLabel="Close"><Text style={styles.xText}>✕</Text></Pressable>
        </View>
        {panel?.mode === 'thread' ? (
          runId ? (
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
              {thread?.summary ? (
                <View style={styles.sum}>
                  <Text style={styles.sumLabel} numberOfLines={2}>{thread.summary.label}</Text>
                  <Text style={styles.sumMeta}>{agentDisplayName(thread.summary.workerAgent || thread.summary.childSessionKey || 'worker')} ↔ Auditor · {thread.summary.rounds} round{thread.summary.rounds === 1 ? '' : 's'} · {thread.summary.messageCount} messages</Text>
                  {thread.summary.verdict ? <Text style={[styles.sumVerdict, { color: TONE_CSS[verdictTone(thread.summary.verdict)] }]}>{verdictLabel(thread.summary.verdict)}</Text> : null}
                </View>
              ) : null}
              {(thread?.messages || []).map((m) => <MessageRow key={m.id || m.seq} m={m} httpBase={httpBase} onShot={setFull} />)}
              {!thread?.messages?.length ? <Text style={styles.empty}>No review messages for this run yet.</Text> : null}
            </ScrollView>
          ) : (
            <ScrollView style={{ flexGrow: 0 }}>
              {summaries.length ? summaries.map((s) => (
                <Pressable key={s.runId} onPress={() => loadThread(s.runId) && panel.setRun?.(s.runId)} style={styles.threadRow}>
                  <Text style={styles.cLabel} numberOfLines={1}>{s.label}</Text>
                  <Text style={styles.cMeta} numberOfLines={1}>{s.lastKind ? `${KIND_LABEL[s.lastKind] || s.lastKind} · ` : ''}{s.lastTitle}</Text>
                </Pressable>
              )) : <Text style={styles.empty}>No review threads yet.</Text>}
            </ScrollView>
          )
        ) : (
          <>
            <View style={styles.chips}>
              {['all', 'pass', 'fail'].map((v) => <Chip key={v} label={v === 'all' ? 'All' : v === 'pass' ? 'Pass' : 'Fail'} on={verdict === v} onPress={() => setVerdict(v)} />)}
            </View>
            <FlatList
              key={cols}
              style={{ flexGrow: 0 }}
              data={shots}
              numColumns={cols}
              keyExtractor={(s) => s.id || s.path}
              columnWrapperStyle={{ gap: 8 }}
              contentContainerStyle={{ gap: 8 }}
              ListEmptyComponent={<Text style={styles.empty}>{runShots === null && runId ? 'Loading screenshots…' : 'No screenshots yet.'}</Text>}
              renderItem={({ item: s }) => (
                <Pressable onPress={() => setFull(shotUrl(httpBase, s.url || s.path, false))} style={[styles.shot, { borderColor: s.verdict === 'pass' ? '#22c55e' : s.verdict === 'fail' ? '#ef4444' : '#64748b', flex: 1 / cols }]} accessibilityRole="imagebutton" accessibilityLabel={`${s.label}${s.route ? ` ${s.route}` : ''}`}>
                  <AuthImage uri={shotUrl(httpBase, s.thumbUrl || s.path)} style={styles.shotImg} />
                  <Text style={styles.shotLabel} numberOfLines={1}>{s.route || s.label}</Text>
                  <Text style={styles.shotMeta} numberOfLines={1}>{s.viewport || ''}{s.viewport ? ' · ' : ''}{relativeTime(s.ts, Date.now())}</Text>
                </Pressable>
              )}
            />
          </>
        )}
      </MeshSheet>
      <Modal visible={!!full} transparent animationType="fade" onRequestClose={() => setFull(null)} supportedOrientations={['portrait', 'landscape']}>
        <Pressable style={styles.full} onPress={() => setFull(null)} accessibilityLabel="Close image">
          {full ? <AuthImage uri={full} style={{ width: '100%', height: '100%' }} resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 8 },
  title: { color: GOLD_LT, fontSize: 11, letterSpacing: 1.6, fontWeight: '700', fontFamily: MONO },
  count: { color: GOLD_LT, fontSize: 11, fontFamily: MONO },
  x: { width: 34, height: 34, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' },
  xText: { color: '#d4d4d8' },
  inApp: { paddingHorizontal: 10, minHeight: 34, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(212,175,55,0.5)', justifyContent: 'center' },
  inAppText: { color: GOLD_LT, fontSize: 11, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 8 },
  chip: { paddingHorizontal: 10, minHeight: 32, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', justifyContent: 'center' },
  chipOn: { borderColor: GOLD, backgroundColor: 'rgba(212,175,55,0.16)' },
  chipText: { color: '#d4d4d8', fontSize: 11.5 },
  chipTextOn: { color: GOLD_LT, fontWeight: '700' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 8 },
  search: { flex: 1, minHeight: 36, borderRadius: 9, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', paddingHorizontal: 10, color: '#f4f4f5' },
  card: { flexDirection: 'row', gap: 10, padding: 10, marginBottom: 8, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', borderLeftWidth: 3, backgroundColor: 'rgba(255,255,255,0.03)' },
  cTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cLabel: { flex: 1, color: '#f4f4f5', fontSize: 12.5, fontWeight: '700' },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1 },
  badgeText: { fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6 },
  cSum: { color: '#a1a1aa', fontSize: 11 },
  cMeta: { color: '#8b8778', fontSize: 10.5 },
  thumb: { width: 64, height: 44, borderRadius: 6 },
  empty: { color: '#8b8778', fontSize: 12, textAlign: 'center', paddingVertical: 24 },
  sum: { gap: 3, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  sumLabel: { color: '#f4f4f5', fontSize: 14, fontWeight: '700' },
  sumMeta: { color: '#a1a1aa', fontSize: 11 },
  sumVerdict: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  msg: { borderLeftWidth: 3, borderRadius: 8, padding: 10, gap: 4, backgroundColor: 'rgba(255,255,255,0.035)' },
  msgHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  msgKind: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8 },
  msgMeta: { color: '#71717a', fontSize: 10, fontFamily: MONO },
  msgTitle: { color: '#f4f4f5', fontSize: 12.5, fontWeight: '700' },
  msgText: { color: '#d4d4d8', fontSize: 12, lineHeight: 17 },
  msgItem: { color: '#a1a1aa', fontSize: 11.5 },
  msgShot: { width: 92, height: 54, borderRadius: 6 },
  threadRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.1)', gap: 3 },
  shot: { borderWidth: 2, borderRadius: 8, overflow: 'hidden', backgroundColor: '#0b0b0d' },
  shotImg: { width: '100%', aspectRatio: 16 / 10 },
  shotLabel: { color: '#e8e6e3', fontSize: 11, fontWeight: '600', paddingHorizontal: 6, paddingTop: 4 },
  shotMeta: { color: '#8b8778', fontSize: 10, paddingHorizontal: 6, paddingBottom: 5 },
  full: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', padding: 12 },
});
