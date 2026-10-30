/**
 * Voice opens the InfiniBot call page (local voice by default). The Robovoice
 * console is the cloud option: infinibot://robovoice, or Voice engine › Cloud
 * on the call page.
 */
import { resolveDeepLink } from '../navigation/deep-links';
import {
  SCREEN_SECTIONS,
  SCREEN_ROUTES,
  VOICE_ENTRY,
  navigateToScreen,
  openVoice,
  isRoutable,
} from '../navigation/screen-registry';

function recorder() {
  const calls = [];
  return { calls, nav: { navigate: (...a) => calls.push(a) } };
}

describe('voice routes to the InfiniBot call page', () => {
  test.each(['infinibot://voice', 'infinibot://call'])('%s -> InfiniCallModal', (link) => {
    const r = resolveDeepLink(link);
    expect(r.screen).toBe('InfiniCallScreen');
    const { calls, nav } = recorder();
    expect(navigateToScreen(nav, r)).toBe(true);
    expect(calls).toEqual([['InfiniCallModal', expect.any(Object)]]);
  });

  test('infinibot://robovoice still opens the Robovoice console (cloud option)', () => {
    const r = resolveDeepLink('infinibot://robovoice?tab=calls');
    expect(r).toMatchObject({ webPath: '/voice?tab=calls', embed: true });
  });

  test('infinibot://ideas opens Knowledge › Ideas', () => {
    expect(resolveDeepLink('infinibot://ideas')).toMatchObject({ tab: 'Knowledge', params: { screen: 'Ideas' } });
  });

  test('catalogue has exactly one voice item and it is the call page', () => {
    const items = SCREEN_SECTIONS.flatMap((s) => s.items);
    const voice = items.filter((e) => e.key === 'voice');
    expect(voice).toEqual([VOICE_ENTRY]);
    expect(VOICE_ENTRY.screen).toBe('InfiniCallScreen');
    expect(SCREEN_ROUTES.InfiniCallScreen).toBe('InfiniCallModal');
    expect(isRoutable(VOICE_ENTRY)).toBe(true);
    expect(items.some((e) => e.webPath === '/voice')).toBe(false);
    expect(items.find((e) => e.key === 'ideas')).toMatchObject({ tab: 'Knowledge', params: { screen: 'Ideas' } });
  });

  test('openVoice() (dock / terminal / chat / glasses buttons) opens the call page', () => {
    const { calls, nav } = recorder();
    expect(openVoice(nav)).toBe(true);
    expect(calls).toEqual([['InfiniCallModal', { gateway: undefined }]]);
  });

  test('a legacy VoiceCallScreen entry is not routable', () => {
    const { calls, nav } = recorder();
    expect(isRoutable({ screen: 'VoiceCallScreen' })).toBe(false);
    expect(navigateToScreen(nav, { screen: 'VoiceCallScreen' })).toBe(false);
    expect(calls).toEqual([]);
  });
});
