/**
 * LearnScreen — native /learn (guided Learn v2 + Classic & admin).
 *
 * Web source of truth: ui/src/ui/views/learn.ts (+ learn-classic.ts,
 * controllers/learn.ts, ui/src/learn/guided/catalog-store.ts).
 *
 *   Tracks         hero stats + search + Resume, Day-1 missions, Recommended
 *                  next, filter chips, core tracks, plugin tracks by plugin
 *   Track page     overview, disclaimer, badge, deep link, walkthroughs
 *                  (Start/Resume/Replay/Reset → native step list), quick check
 *   Certification  guided ladder + plugin mastery badges + certificate (SvgXml)
 *   Classic        v1 stepper tracks, notes, legacy cert, admin users/author
 *
 * RPCs: learn.guided.catalog · learn.guided.progress.update ·
 * learn.guided.quiz.submit · learn.guided.prefs.set · learn.guided.certificate ·
 * users.me (+ the learn.* v1 set in ClassicTab).
 *
 * Route params: { trackId?, walkthrough? } — infinibot://learn/<trackId>/<walkthroughId>
 * (also accepts { path: '/learn/<trackId>?walkthrough=<id>' }).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Linking, useWindowDimensions } from 'react-native';
import { SPACE, Screen, AppHeader, Tabs, Card, SkeletonRow, Divider, EmptyState } from '../../ui-kit';
import {
  normalizeCatalog, availableTracks, buildCatalogView, heroStats, missionItems, applyLocalEvent, mergeProgress,
  progressUpdateParams, nextWalkthrough, parseLearnParams, webTourPath, isUnknownMethod, errorText, isAdminFromMe,
} from './learn-model';
import { HeroCard, CatalogTab } from './CatalogTab';
import { TrackPage, MissingTrack } from './TrackPage';
import { WalkthroughSheet } from './WalkthroughSheet';
import { CertTab } from './CertTab';
import { ClassicTab } from './ClassicTab';
import { CertificateSheet, Flash } from './parts';
import { resolveDeepLink } from '../../navigation/deep-links';
import { navigateToScreen } from '../../navigation/screen-registry';

const PAGE_TABS = [
  { key: 'tracks', label: 'Tracks' },
  { key: 'cert', label: 'Certification' },
  { key: 'classic', label: 'Classic & admin' },
];

export function LearnScreen({ navigation, route, gateway }) {
  const { width } = useWindowDimensions();
  const reqRef = useRef(gateway?.sendReq);
  reqRef.current = gateway?.sendReq;
  // gateway.sendReq may be a new function every render; route calls through a
  // ref so effects/callbacks don't re-fire (and re-fetch) on each render.
  const sendReq = useCallback((m, p) => (reqRef.current ? reqRef.current(m, p) : Promise.reject(new Error('Not connected'))), []);
  const connected = gateway?.status === 'connected';

  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const [tab, setTab] = useState('tracks');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [trackId, setTrackId] = useState(null);
  const [sheet, setSheet] = useState(null); // { trackId, walkthroughId }
  const [busy, setBusy] = useState(null);
  const [certSvg, setCertSvg] = useState(null);
  const [certBusy, setCertBusy] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [flash, setFlash] = useState(null); // { text, tone }
  const autoStarted = useRef('');
  const scrollRef = useRef(null);

  const showFlash = useCallback((text, tone = 'danger') => {
    setFlash({ text, tone });
    setTimeout(() => setFlash((f) => (f && f.text === text ? null : f)), 3500);
  }, []);

  const load = useCallback(async () => {
    if (!sendReq) return;
    setLoading(true);
    try {
      const res = await sendReq('learn.guided.catalog', {});
      setCatalog(normalizeCatalog(res));
      setUnavailable(false);
      setError(null);
    } catch (e) {
      if (isUnknownMethod(e)) setUnavailable(true);
      else setError(errorText(e));
    } finally {
      setLoading(false);
    }
    try {
      setIsAdmin(isAdminFromMe(await sendReq('users.me', {})));
    } catch {
      setIsAdmin(false);
    }
  }, [sendReq]);

  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  // Coming back from the web tour (WebSurfaceModal) → progress moved there.
  useEffect(() => {
    if (typeof navigation?.addListener !== 'function') return undefined;
    return navigation.addListener('focus', () => {
      if (connected) load();
    });
  }, [navigation, connected, load]);

  // Deep link params: { trackId?, walkthrough? }.
  const params = useMemo(() => parseLearnParams(route?.params), [route?.params]);
  useEffect(() => {
    if (params.trackId) {
      setTrackId(params.trackId);
      setTab('tracks');
    }
  }, [params.trackId]);

  const tracks = useMemo(() => (catalog ? availableTracks(catalog) : []), [catalog]);
  const progress = catalog?.progress;
  const track = trackId ? tracks.find((t) => t.id === trackId) || null : null;

  useEffect(() => {
    if (!catalog || !params.trackId || !params.walkthrough) return;
    const key = `${params.trackId}/${params.walkthrough}`;
    if (autoStarted.current === key) return;
    const t = tracks.find((x) => x.id === params.trackId);
    if (t && t.walkthroughs.some((w) => w.id === params.walkthrough)) {
      autoStarted.current = key;
      setSheet({ trackId: t.id, walkthroughId: params.walkthrough });
    }
  }, [catalog, tracks, params.trackId, params.walkthrough]);

  const view = useMemo(() => buildCatalogView(tracks, catalog, { filter, query }), [tracks, catalog, filter, query]);
  const stats = useMemo(() => heroStats(tracks, progress), [tracks, progress]);
  const missions = useMemo(() => missionItems(tracks, catalog), [tracks, catalog]);

  // ── navigation helpers ────────────────────────────────────────────────
  const openWeb = useCallback(
    (path, title) => navigation?.navigate?.('WebSurfaceModal', { path, title: title || 'Learn', embed: false }),
    [navigation],
  );
  const openTrack = useCallback((t) => {
    const id = typeof t === 'string' ? t : t?.id;
    if (!id) return;
    setTrackId(id);
    setTab('tracks');
    scrollRef.current?.scrollTo?.({ y: 0, animated: false });
  }, []);
  const openWalkthrough = useCallback((t, w) => {
    const wt = w || nextWalkthrough(t, progress);
    if (wt) setSheet({ trackId: t.id, walkthroughId: wt.id });
  }, [progress]);

  // ── writes (optimistic, same RPCs as the web catalog-store) ────────────
  const sendProgress = useCallback(async (t, walkthroughId, event, stepId, done) => {
    if (!catalog) return;
    const before = catalog.progress;
    setBusy(event === 'step' ? `step:${stepId}:${done ? 1 : 0}` : event);
    setCatalog((c) => (c ? { ...c, progress: applyLocalEvent(c.progress, t, walkthroughId, event, stepId, done) } : c));
    try {
      const res = await sendReq('learn.guided.progress.update', progressUpdateParams(t.id, walkthroughId, event, stepId, done));
      setCatalog((c) => (c ? { ...c, progress: mergeProgress(c.progress, res) } : c));
      if (Array.isArray(res?.minted) && res.minted.length) {
        showFlash(`Certificate earned: ${res.minted.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(', ')}`, 'success');
      }
    } catch (e) {
      setCatalog((c) => (c ? { ...c, progress: before } : c));
      showFlash(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [catalog, sendReq, showFlash]);

  const submitQuiz = useCallback(async (t, answers) => {
    try {
      const res = await sendReq('learn.guided.quiz.submit', { trackId: t.id, answers });
      setCatalog((c) => (c ? { ...c, progress: mergeProgress(c.progress, res) } : c));
      return res;
    } catch (e) {
      showFlash(errorText(e));
      return null;
    }
  }, [sendReq, showFlash]);

  const dismissMissions = useCallback(async () => {
    setCatalog((c) => (c ? { ...c, progress: { ...c.progress, prefs: { ...c.progress.prefs, missionsDismissed: true } } } : c));
    try {
      const res = await sendReq('learn.guided.prefs.set', { key: 'missionsDismissed', value: true });
      setCatalog((c) => (c ? { ...c, progress: mergeProgress(c.progress, res) } : c));
    } catch (e) {
      showFlash(errorText(e));
    }
  }, [sendReq, showFlash]);

  const viewGuidedCert = useCallback(async (tier) => {
    setCertBusy(tier);
    try {
      const res = await sendReq('learn.guided.certificate', { tier });
      setCertSvg({ tier, svg: res?.svg, displayName: res?.certificate?.displayName });
    } catch (e) {
      showFlash(/NOT_AWARDED|not awarded/i.test(errorText(e)) ? 'That certificate is not awarded yet.' : errorText(e));
    } finally {
      setCertBusy(null);
    }
  }, [sendReq, showFlash]);

  // ── render ────────────────────────────────────────────────────────────
  const sheetTrack = sheet ? tracks.find((t) => t.id === sheet.trackId) : null;
  const sheetWt = sheetTrack ? sheetTrack.walkthroughs.find((w) => w.id === sheet.walkthroughId) : null;
  const onTrackPage = Boolean(trackId) && tab === 'tracks';
  const wide = width >= 700;

  const header = (
    <AppHeader
      eyebrow={onTrackPage ? 'Learn' : 'Guided walkthroughs'}
      title={onTrackPage ? track?.title || 'Track' : 'Learn'}
      leftIcon="chevron-back"
      leftLabel={onTrackPage ? 'All tracks' : 'Back'}
      onLeftPress={() => (onTrackPage ? setTrackId(null) : navigation?.goBack?.())}
      rightActions={[
        {
          key: 'web',
          icon: 'globe-outline',
          label: 'Open Learn on the web',
          onPress: () => openWeb(onTrackPage && trackId ? webTourPath(trackId) : '/learn', 'Learn'),
        },
      ]}
    >
      {!onTrackPage ? (
        <Tabs tabs={PAGE_TABS} active={tab} onSelect={setTab} style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }} />
      ) : null}
    </AppHeader>
  );

  let body;
  if (!connected && !catalog) {
    body = <EmptyState icon="cloud-offline-outline" title="Not connected" message="Connect to your gateway to load Learn." />;
  } else if (tab === 'classic') {
    body = (
      <ClassicTab
        gateway={gateway}
        isAdmin={isAdmin}
        onViewCert={(c) => setCertSvg(c)}
        onOpenWeb={openWeb}
        onOpenUrl={(url) => Linking.openURL(url).catch(() => {})}
      />
    );
  } else if (unavailable) {
    body = (
      <EmptyState
        icon="construct-outline"
        title="Guided Learn isn't available on this gateway"
        message="This gateway doesn't serve learn.guided.* yet. Update and restart it, or use the Classic & admin tab."
        actionLabel="Classic & admin"
        onAction={() => setTab('classic')}
        secondaryLabel="Retry"
        onSecondary={load}
      />
    );
  } else if (error && !catalog) {
    body = <EmptyState tone="danger" icon="alert-circle-outline" title="Couldn't load Learn" message={error} actionLabel="Retry" onAction={load} />;
  } else if (!catalog) {
    body = (
      <Card>
        <SkeletonRow avatar />
        <Divider inset />
        <SkeletonRow avatar />
        <Divider inset />
        <SkeletonRow avatar />
      </Card>
    );
  } else if (onTrackPage) {
    body = track ? (
      <TrackPage
        key={track.id}
        track={track}
        tracks={tracks}
        plugins={catalog.plugins}
        progress={progress}
        onOpenTrack={openTrack}
        onOpenWalkthrough={(w) => openWalkthrough(track, w)}
        onReset={(w) => sendProgress(track, w.id, 'reset')}
        onSubmitQuiz={submitQuiz}
      />
    ) : (
      <MissingTrack
        trackId={trackId}
        onAll={() => setTrackId(null)}
        onPlugins={() => navigateToScreen(navigation, resolveDeepLink('infinibot://plugins'), { gateway })}
      />
    );
  } else if (tab === 'cert') {
    body = (
      <CertTab
        tracks={tracks}
        progress={progress}
        plugins={catalog.plugins}
        source="gateway"
        onOpenTrack={openTrack}
        onViewCert={viewGuidedCert}
        busyTier={certBusy}
      />
    );
  } else {
    body = (
      <>
        <HeroCard
          stats={stats}
          query={query}
          onQuery={setQuery}
          onResume={(t) => {
            openTrack(t);
            openWalkthrough(t);
          }}
          source="gateway"
        />
        <CatalogTab
          view={view}
          progress={progress}
          missions={missions}
          filter={filter}
          onFilter={setFilter}
          onOpenTrack={openTrack}
          onStartWalkthrough={(t, w) => setSheet({ trackId: t.id, walkthroughId: w.id })}
          onDismissMissions={dismissMissions}
        />
      </>
    );
  }

  return (
    <Screen
      opaque
      edges={['bottom', 'left', 'right']}
      header={header}
      refreshing={loading && Boolean(catalog)}
      onRefresh={tab === 'classic' ? undefined : load}
      keyboardAvoiding
      ref={scrollRef}
      contentStyle={{ paddingTop: SPACE.md, paddingBottom: SPACE.xxl }}
    >
      <View style={{ width: '100%', maxWidth: wide ? 900 : undefined, alignSelf: 'center' }}>
        {flash ? <Flash text={flash.text} tone={flash.tone} /> : null}
        {body}
      </View>
      <WalkthroughSheet
        track={sheetTrack}
        walkthrough={sheetWt}
        progress={progress}
        busy={busy}
        flash={flash}
        onClose={() => setSheet(null)}
        onStep={(stepId, done) => sendProgress(sheetTrack, sheetWt.id, 'step', stepId, done)}
        onComplete={() => sendProgress(sheetTrack, sheetWt.id, 'complete')}
        onReset={() => sendProgress(sheetTrack, sheetWt.id, 'reset')}
        onRunOnWeb={() => {
          const p = webTourPath(sheetTrack.id, sheetWt.id);
          setSheet(null);
          openWeb(p, sheetWt.title);
        }}
        onOpenRoute={(path, title) => {
          setSheet(null);
          openWeb(path, title);
        }}
      />
      <CertificateSheet cert={certSvg} onClose={() => setCertSvg(null)} />
    </Screen>
  );
}

export default LearnScreen;
