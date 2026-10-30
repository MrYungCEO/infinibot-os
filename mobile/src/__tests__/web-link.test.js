import { nativeEntryForWebPath, openWebPath } from '../navigation/web-link';
import { PLUGINS } from './fixtures-plugins';

const nav = () => {
  const calls = [];
  return { calls, navigate: (...a) => calls.push(a) };
};

describe('web-link: chat links open native screens when one exists', () => {
  test('core pages with native screens', () => {
    expect(nativeEntryForWebPath('/reviews', { plugins: PLUGINS })).toMatchObject({ screen: 'OversightScreen' });
    expect(nativeEntryForWebPath('/workspace', { plugins: PLUGINS })).toMatchObject({ screen: 'WorkspaceScreen' });
    expect(nativeEntryForWebPath('/grid', { plugins: PLUGINS })).toMatchObject({ screen: 'GridScreen' });
  });

  test('plugin pages with native screens', () => {
    expect(nativeEntryForWebPath('/agency-daily', { plugins: PLUGINS })).toMatchObject({ screen: 'AgencyDailyScreen' });
  });

  test('pages without a native screen fall back to the web host', () => {
    expect(nativeEntryForWebPath('/inbox-never-native-xyz', { plugins: PLUGINS })).toBeNull();
    const n = nav();
    openWebPath(n, '/inbox-never-native-xyz', 'X', { plugins: PLUGINS });
    expect(n.calls[0][0]).toBe('WebSurfaceModal');
    expect(n.calls[0][1]).toMatchObject({ path: '/inbox-never-native-xyz', embed: true });
  });

  test('a native path navigates to its modal, not the web host', () => {
    const n = nav();
    expect(openWebPath(n, '/reviews?run=r7', 'Reviews', { plugins: PLUGINS })).toBe(true);
    expect(n.calls[0][0]).toBe('OversightModal');
    expect(n.calls[0][1]).toMatchObject({ runId: 'r7' });
  });

  test('non-paths are ignored', () => {
    expect(nativeEntryForWebPath('https://x.y/z', { plugins: PLUGINS })).toBeNull();
    expect(openWebPath(null, '/reviews')).toBe(false);
  });
});
