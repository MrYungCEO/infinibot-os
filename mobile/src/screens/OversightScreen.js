/**
 * OversightScreen — the native Reviews page, one to one with the web
 * /reviews host (ui/src/ui/navigation.ts SUBVIEWS.reviews):
 *
 *   Run reviews  ui/src/ui/views/reviews/index.ts (agents.reviews.*)
 *   Oversight    ui/src/ui/views/oversight/index.ts (subagents.list/history +
 *                subagent_reviews_* + verification.decide + cron oversight jobs)
 *
 * Phone layout: a segmented control switches the two sub-tabs; the web's
 * side-by-side list + detail becomes list → full run page (in-screen state,
 * Back returns to the list). Deep links pass route.params.runId
 * (infinibot://runs/<id>, /reviews?run=<id>) and open that run's page;
 * route.params.view === 'oversight' selects the Oversight sub-tab.
 *
 * All mapping is in screens/oversight/oversight-model.js (unit-tested);
 * data + actions in hooks/useOversight.js and screens/oversight/useRunReviews.js.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { Screen, AppHeader, SegmentedControl, SPACE, DOCK_SPACE } from '../ui-kit';
import { useOversight } from '../hooks/useOversight';
import { useRunReviews } from './oversight/useRunReviews';
import { useGatewayHttp } from './oversight/ui';
import { OversightList } from './oversight/OversightList';
import { RunReviewsList } from './oversight/RunReviewsList';
import { RunDetail } from './oversight/RunDetail';
import { followUpDraft } from './oversight/oversight-model';
import { navigateToScreen } from '../navigation/screen-registry';
import { resolveDeepLink } from '../navigation/deep-links';

const TABS = [
  { key: 'reviews', label: 'Run reviews', icon: 'document-text-outline' },
  { key: 'oversight', label: 'Oversight', icon: 'eye-outline' },
];

export function OversightScreen({ navigation, route, gateway }) {
  const params = route?.params || {};
  const deepRunId = params.runId || params.run || null;
  const [tab, setTabState] = useState(params.view === 'oversight' || deepRunId ? 'oversight' : 'reviews');
  const [detail, setDetail] = useState(deepRunId ? { runId: deepRunId, from: 'deeplink' } : null);
  const ov = useOversight(gateway);
  const rr = useRunReviews(gateway);
  const http = useGatewayHttp();
  const [now, setNow] = useState(Date.now());

  // Restore the last sub-tab (unless a deep link / view param decided it).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !ov.hydrated) return;
    restored.current = true;
    if (!deepRunId && !params.view && ov.persistedTab) setTabState(ov.persistedTab);
  }, [ov.hydrated, ov.persistedTab, deepRunId, params.view]);

  // New deep link while mounted.
  const lastDeep = useRef(deepRunId);
  useEffect(() => {
    if (deepRunId && deepRunId !== lastDeep.current) {
      lastDeep.current = deepRunId;
      setDetail({ runId: deepRunId, from: 'deeplink' });
    }
  }, [deepRunId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const setTab = useCallback(
    (t) => {
      setTabState(t);
      ov.rememberTab(t);
    },
    [ov.rememberTab],
  );

  const openRun = useCallback((runId) => setDetail({ runId, from: tab }), [tab]);

  const openSession = useCallback(
    (entry) => navigateToScreen(navigation, resolveDeepLink(`infinibot://chat/${encodeURIComponent(entry.sessionKey)}`), { gateway }),
    [navigation, gateway],
  );
  const openTask = useCallback(
    (taskId) => navigateToScreen(navigation, resolveDeepLink(`infinibot://board/task/${encodeURIComponent(taskId)}`), { gateway }),
    [navigation, gateway],
  );

  // Forward actions: URLs open in the browser; a follow-up whose RPC the
  // gateway doesn't serve yet goes to the chat composer as a draft (the web
  // drops it on its event bus).
  const onForward = useCallback(
    async (review, action, index) => {
      const res = await rr.runForward(review, action, index);
      if (res?.url) {
        Linking.openURL(res.url).catch(() => {});
        return { ok: true, note: 'Opened pull request' };
      }
      if (res?.fallback === 'chat') {
        navigateToScreen(navigation, { tab: 'Chat', params: { draft: followUpDraft(review, action), draftKey: `${review.runId}:${index}` } }, { gateway });
        return { ok: true, note: 'Follow-up drafted in chat' };
      }
      return res;
    },
    [rr.runForward, navigation, gateway],
  );

  const back = () => {
    if (detail) setDetail(null);
    else navigation?.goBack();
  };

  const subtitle = detail
    ? detail.runId
    : tab === 'reviews'
      ? `${rr.reviews.length} run review${rr.reviews.length === 1 ? '' : 's'}`
      : `${ov.entries.length} runs${ov.runningCount ? ` · ${ov.runningCount} live` : ''}`;

  const header = (
    <AppHeader
      eyebrow="Agents"
      title={detail ? 'Run review' : 'Reviews'}
      subtitle={subtitle}
      leftIcon="chevron-back"
      leftLabel={detail ? 'All runs' : 'Back'}
      onLeftPress={back}
      rightActions={[
        {
          key: 'refresh',
          icon: 'refresh',
          label: 'Refresh',
          busy: detail ? ov.loading || rr.loading : tab === 'reviews' ? rr.loading : ov.loading,
          onPress: () => {
            ov.load();
            rr.load();
          },
        },
      ]}
    >
      {!detail ? <SegmentedControl options={TABS} value={tab} onChange={setTab} size="sm" style={{ marginHorizontal: SPACE.lg, marginBottom: SPACE.sm }} /> : null}
    </AppHeader>
  );

  if (detail) {
    return (
      <Screen
        header={header}
        edges={['bottom']}
        refreshing={false}
        onRefresh={() => {
          ov.load();
          rr.load();
        }}
        contentStyle={{ paddingBottom: DOCK_SPACE }}
      >
        <RunDetail
          key={detail.runId}
          runId={detail.runId}
          ov={ov}
          rr={rr}
          gateway={gateway}
          http={http}
          initialSegment={detail.from === 'reviews' ? 'review' : 'oversight'}
          onOpenSession={openSession}
          onOpenTask={openTask}
          onForward={onForward}
        />
      </Screen>
    );
  }

  return (
    <Screen header={header} edges={['bottom']} scroll={false} padded={false}>
      {tab === 'reviews' ? (
        <RunReviewsList rr={rr} onOpen={openRun} now={now} />
      ) : (
        <OversightList ov={ov} gateway={gateway} onOpen={openRun} onOpenSession={openSession} onOpenTask={openTask} />
      )}
    </Screen>
  );
}

export default OversightScreen;
