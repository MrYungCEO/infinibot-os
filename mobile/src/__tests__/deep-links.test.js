import { normalizeDeepLink, parseDeepLink, resolveDeepLink, buildDeepLink, deepLinkFromNotificationData } from '../navigation/deep-links';
import { navigateToScreen, isRoutable } from '../navigation/screen-registry';
import { PLUGINS } from './fixtures-plugins';

describe('normalizeDeepLink', () => {
  test.each([
    ['infinibot://plugin/infinitrade/positions', 'plugin/infinitrade/positions'],
    ['https://infinibot-cloud.netlify.app/m/runs/r1', 'runs/r1'],
    ['http://100.64.10.7:18789/m/approvals/a1?x=1', 'approvals/a1?x=1'],
    ['mobile://chat?sessionKey=agent%3Amain%3Ax', 'chat/agent%3Amain%3Ax'],
    ['/solatrix/alerts', 'web/solatrix/alerts'],
    ['#/kanban?task=1', 'web/kanban?task=1'],
    ['https://gw.example.com/infinitrade?section=signals', 'web/infinitrade?section=signals'],
  ])('%s', (input, out) => expect(normalizeDeepLink(input)).toBe(out));

  test('rejects junk and protocol-relative paths', () => {
    expect(normalizeDeepLink('')).toBeNull();
    expect(normalizeDeepLink('javascript:alert(1)')).toBeNull();
    expect(normalizeDeepLink('//evil.com/x')).toBeNull();
  });

  test('parse splits segments + query', () => {
    expect(parseDeepLink('infinibot://plugin/infinitrade/signals?signal=abc')).toMatchObject({
      segments: ['plugin', 'infinitrade', 'signals'], params: { signal: 'abc' },
    });
  });
});

describe('resolveDeepLink routing table', () => {
  const r = (u) => resolveDeepLink(u, { plugins: PLUGINS });

  test('core destinations', () => {
    expect(r('infinibot://')).toMatchObject({ tab: 'Dashboard' });
    expect(r('infinibot://board/task/t9')).toMatchObject({ tab: 'Board', params: { taskId: 't9' } });
    expect(r('infinibot://chat/agent%3Amain%3Amobile')).toMatchObject({ tab: 'Chat', sessionKey: 'agent:main:mobile' });
    expect(r('infinibot://activity/session/agent%3Amain')).toMatchObject({ tab: 'Chat', sessionKey: 'agent:main' });
    expect(r('infinibot://documents/doc-42')).toMatchObject({ screen: 'DocumentsScreen', params: { docId: 'doc-42' } });
    expect(r('infinibot://runs/run-7')).toMatchObject({ screen: 'OversightScreen', params: { runId: 'run-7' } });
    expect(r('infinibot://approvals/ap-1')).toMatchObject({ screen: 'ApprovalsScreen', params: { approvalId: 'ap-1' } });
    expect(r('infinibot://goals/g1')).toMatchObject({ screen: 'GoalsPhasesScreen', params: { view: 'goals', goal: 'g1' } });
    expect(r('infinibot://learn')).toMatchObject({ screen: 'LearnScreen', title: 'Learn' });
    expect(r('infinibot://learn/infinitrade')).toMatchObject({ screen: 'LearnScreen', params: { trackId: 'infinitrade' } });
    expect(r('infinibot://learn/goals/first-goal')).toMatchObject({ screen: 'LearnScreen', params: { trackId: 'goals', walkthrough: 'first-goal' } });
    expect(r('infinibot://phases/p1')).toMatchObject({ screen: 'GoalsPhasesScreen', params: { view: 'phases', phase: 'p1' } });
    expect(r('infinibot://settings')).toMatchObject({ screen: 'SettingsScreen' });
    expect(r('infinibot://plugins/solatrix')).toMatchObject({ screen: 'PluginsScreen', params: { pluginId: 'solatrix' } });
    expect(r('infinibot://connect?url=ws%3A%2F%2Fh%3A18789&token=t')).toMatchObject({ connect: { url: 'ws://h:18789', token: 't' } });
  });

  test('plugin routes: web page, native page, unknown sub-page, disabled', () => {
    expect(r('infinibot://plugin/infinitrade/signals?signal=s1')).toMatchObject({ webPath: '/infinitrade/signals?signal=s1', embed: true, pluginId: 'infinitrade' });
    expect(r('infinibot://plugin/infinitrade/positions')).toMatchObject({ webPath: '/infinitrade?section=positions' });
    expect(r('infinibot://plugin/discipline')).toMatchObject({ screen: 'DisciplineScreen' });
    expect(r('infinibot://discipline')).toMatchObject({ screen: 'DisciplineScreen' }); // legacy alert link
    expect(r('infinibot://plugin/business-agency/opportunities')).toMatchObject({ businessScreen: 'Opportunities' });
    expect(r('infinibot://plugin/solatrix/alerts')).toMatchObject({ screen: 'PluginsScreen', params: { pluginId: 'solatrix', reason: 'disabled' } });
    expect(r('infinibot://plugin/ghost')).toMatchObject({ screen: 'PluginsScreen', params: { reason: 'unknown' } });
  });

  test('relative web paths from plugin alerts land on the owning plugin page', () => {
    expect(r('/infinitrade/signals?signal=1')).toMatchObject({ webPath: '/infinitrade/signals?signal=1', pluginId: 'infinitrade' });
    expect(r('/solatrix/alerts')).toMatchObject({ screen: 'PluginsScreen', params: { reason: 'disabled' } });
    expect(r('/reviews')).toMatchObject({ screen: 'OversightScreen' });
    expect(r('/reviews?run=r9')).toMatchObject({ screen: 'OversightScreen', params: { runId: 'r9' } });
    expect(r('/workspace')).toMatchObject({ screen: 'WorkspaceScreen' });
    expect(r('/grid')).toMatchObject({ screen: 'GridScreen' });
    expect(r('/agency-daily')).toMatchObject({ screen: 'AgencyDailyScreen', pluginId: 'business-agency' });
    expect(r('infinibot://agency-daily')).toMatchObject({ screen: 'AgencyDailyScreen' });
    expect(r('infinibot://runs/r1')).not.toHaveProperty('webFallback');
  });

  test('formerly web-routed pages open their native screens', () => {
    expect(r('infinibot://scheduled/t1')).toMatchObject({ screen: 'GoalsPhasesScreen', params: { view: 'scheduled', task: 't1' } });
    expect(r('infinibot://inbox')).toMatchObject({ screen: 'InboxScreen' });
    expect(r('infinibot://comms')).toMatchObject({ screen: 'CommsScreen' });
    expect(r('infinibot://vault')).toMatchObject({ screen: 'VaultScreen' });
    expect(r('infinibot://notes')).toMatchObject({ screen: 'DocumentsScreen' });
    // Shared web URLs / relative web paths land natively too.
    expect(r('/learn')).toMatchObject({ screen: 'LearnScreen' });
    expect(r('/inbox?view=replies')).toMatchObject({ screen: 'InboxScreen', params: { view: 'replies' } });
    expect(r('/reply-inbox')).toMatchObject({ screen: 'InboxScreen', params: { view: 'replies' } });
    expect(r('/comms')).toMatchObject({ screen: 'CommsScreen', params: { view: 'inbox' } });
    expect(r('/channels/telegram')).toMatchObject({ screen: 'CommsScreen', params: { channel: 'telegram' } });
    expect(r('https://gw.example/notes/doc-9')).toMatchObject({ screen: 'DocumentsScreen', params: { docId: 'doc-9' } });
    expect(r('/vault')).toMatchObject({ screen: 'VaultScreen' });
    expect(r('/autonomy?view=goals&goal=g2')).toMatchObject({ screen: 'GoalsPhasesScreen', params: { view: 'goals', goal: 'g2' } });
    // The plain Autonomy board is not part of Goals & Phases: stays as before.
    expect(r('/autonomy')).not.toMatchObject({ screen: 'GoalsPhasesScreen' });
  });

  test('plugin link before the plugin list is known is "pending" (cold start)', () => {
    expect(resolveDeepLink('infinibot://plugin/infinitrade/signals')).toMatchObject({ pending: true, pluginId: 'infinitrade' });
  });

  test('every resolved destination is routable by navigateToScreen', () => {
    const links = ['infinibot://', 'infinibot://runs/1', 'infinibot://approvals/2', 'infinibot://plugin/infinitrade/signals',
      'infinibot://plugin/discipline', 'infinibot://plugin/business-agency/opportunities', 'infinibot://documents/x', 'infinibot://plugins',
      'infinibot://learn/getting-started', 'infinibot://inbox', 'infinibot://comms', 'infinibot://vault', 'infinibot://goals/g1',
      'infinibot://phases', 'infinibot://scheduled', '/notes', '/autonomy?view=phases'];
    for (const l of links) {
      const e = r(l);
      expect(isRoutable(e)).toBe(true);
      const calls = [];
      const nav = { navigate: (...a) => calls.push(a) };
      expect(navigateToScreen(nav, e, {})).toBe(true);
      expect(calls.length).toBe(1);
    }
  });

  test('navigate: plugin web page opens chromeless WebSurface; business route nests params', () => {
    const calls = [];
    const nav = { navigate: (...a) => calls.push(a) };
    navigateToScreen(nav, r('infinibot://plugin/infinitrade/signals'), {});
    expect(calls[0]).toEqual(['WebSurfaceModal', expect.objectContaining({ path: '/infinitrade/signals', embed: true, pluginId: 'infinitrade' })]);
    navigateToScreen(nav, r('infinibot://approvals/ap-1'), {});
    expect(calls[1]).toEqual(['ApprovalsModal', expect.objectContaining({ approvalId: 'ap-1' })]);
    let switched = null;
    navigateToScreen(nav, r('infinibot://chat/s1'), { switchSession: (k) => { switched = k; } });
    expect(switched).toBe('s1');
  });
});

describe('notification payloads', () => {
  test('explicit deepLink wins; legacy types still route', () => {
    expect(deepLinkFromNotificationData({ deepLink: 'infinibot://runs/1', type: 'chat' })).toBe('infinibot://runs/1');
    expect(deepLinkFromNotificationData({ link: { deepLink: 'infinibot://approvals/9' } })).toBe('infinibot://approvals/9');
    expect(deepLinkFromNotificationData({ type: 'kanban.task.due' })).toBe('infinibot://board');
    expect(deepLinkFromNotificationData({ type: 'chat', sessionKey: 'agent:main' })).toBe('infinibot://chat/agent%3Amain');
    expect(deepLinkFromNotificationData({ kind: 'agent_start' })).toBe('infinibot://autonomy');
    expect(buildDeepLink('plugin/infinitrade/signals', { signal: 'a b' })).toBe('infinibot://plugin/infinitrade/signals?signal=a%20b');
  });
});
