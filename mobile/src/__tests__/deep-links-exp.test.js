import { resolveDeepLink, normalizeDeepLink } from '../navigation/deep-links';

describe('Expo Go exp:// links', () => {
  test('connect link after /--/ opens pairing with the decoded password', () => {
    const t = resolveDeepLink('exp://192.168.1.13:8082/--/connect?gateway=box.ts.net&password=Khalifa888%24');
    expect(t.connect).toEqual({ gateway: 'box.ts.net', password: 'Khalifa888$' });
  });
  test('a bare exp:// launch URL is not a deep link', () => {
    expect(normalizeDeepLink('exp://192.168.1.13:8082')).toBeNull();
  });
});
