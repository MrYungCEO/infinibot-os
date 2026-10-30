/**
 * screen-registry — the catalogue behind More and the Launchpad. Guards the
 * things that rot: dead routes, duplicate entries, unroutable items.
 */
import fs from 'fs';
import path from 'path';

import {
  BUSINESS_STACK_SCREENS,
  MORE_SECTIONS,
  SCREEN_ROUTES,
  SCREEN_SECTIONS,
  filterScreens,
  flattenScreens,
  isRoutable,
  navigateToScreen,
} from '../navigation/screen-registry';

const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'App.js'), 'utf8');
const registeredRoutes = new Set([...appSource.matchAll(/name="([A-Za-z]+)"/g)].map((m) => m[1]));
const all = flattenScreens();

describe('catalogue integrity', () => {
  test('keys are unique', () => {
    const keys = all.map((e) => e.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  test('every entry is routable and has a title, icon and description', () => {
    for (const e of all) {
      expect({ key: e.key, routable: isRoutable(e) }).toEqual({ key: e.key, routable: true });
      expect(typeof e.title === 'string' && e.title.length > 0).toBe(true);
      expect(typeof e.icon === 'string' && e.icon.length > 0).toBe(true);
      expect(typeof e.desc === 'string' && e.desc.length > 0).toBe(true);
    }
  });

  test('exactly one routing key per entry', () => {
    for (const e of all) {
      const kinds = ['tab', 'screen', 'businessScreen', 'webPath'].filter((k) => e[k]);
      expect({ key: e.key, kinds }).toEqual({ key: e.key, kinds: [kinds[0]] });
    }
  });

  test('no destination is listed twice', () => {
    const dest = (e) => e.webPath || e.businessScreen || e.screen || `${e.tab}/${e.params?.screen || ''}`;
    const seen = new Map();
    const dupes = [];
    for (const e of all) {
      const d = dest(e);
      if (seen.has(d)) dupes.push(`${seen.get(d)} + ${e.key} → ${d}`);
      seen.set(d, e.key);
    }
    expect(dupes).toEqual([]);
  });

  test('every `screen` maps to a route that App.js registers', () => {
    for (const e of all.filter((x) => x.screen)) {
      const route = SCREEN_ROUTES[e.screen] || BUSINESS_STACK_SCREENS[e.screen];
      expect({ key: e.key, route: Boolean(route) }).toEqual({ key: e.key, route: true });
      expect({ key: e.key, registered: registeredRoutes.has(route) }).toEqual({ key: e.key, registered: true });
    }
  });

  test('SCREEN_ROUTES has no route App.js does not register', () => {
    const dead = Object.entries({ ...SCREEN_ROUTES, ...BUSINESS_STACK_SCREENS }).filter(([, r]) => !registeredRoutes.has(r));
    expect(dead).toEqual([]);
  });

  test('business + tab-nested screens exist in their stacks', () => {
    for (const e of all) {
      if (e.businessScreen) expect({ key: e.key, ok: registeredRoutes.has(e.businessScreen) }).toEqual({ key: e.key, ok: true });
      if (e.tab) expect({ key: e.key, ok: registeredRoutes.has(e.tab) }).toEqual({ key: e.key, ok: true });
      if (e.tab && e.params?.screen) expect({ key: e.key, ok: registeredRoutes.has(e.params.screen) }).toEqual({ key: e.key, ok: true });
    }
  });

  test('web paths are app-relative', () => {
    for (const e of all.filter((x) => x.webPath)) expect(e.webPath).toMatch(/^\/[a-z]/);
  });

  test('no emoji in titles or descriptions', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const e of all) expect({ key: e.key, emoji: emoji.test(`${e.title} ${e.desc}`) }).toEqual({ key: e.key, emoji: false });
  });
});

describe('sections', () => {
  test('mirror the web sidebar groups, in order', () => {
    expect(MORE_SECTIONS.map((s) => s.title)).toEqual([
      'Home', 'Chat & Voice', 'Work', 'Agents', 'Business & Agency', 'Content', 'Plugins', 'Settings',
    ]);
  });

  test('More omits the tab destinations; the Launchpad keeps them', () => {
    expect(flattenScreens(MORE_SECTIONS).some((e) => e.key.startsWith('tab'))).toBe(false);
    expect(SCREEN_SECTIONS[0].launchpadOnly).toBe(true);
    expect(SCREEN_SECTIONS[0].items.map((e) => e.tab)).toEqual(['Chat', 'Board', 'Dashboard', 'Business', 'Knowledge', 'More']);
  });
});

describe('search', () => {
  test('matches title, description, section and tolerates typos in the title', () => {
    const keys = (q) => filterScreens(q, MORE_SECTIONS).flat.map((e) => e.key);
    expect(keys('terminal')).toContain('terminals');
    expect(keys('shells')).toContain('terminals'); // description
    expect(keys('settings')).toEqual(expect.arrayContaining(['settings', 'connections', 'plugins', 'credits'])); // section
    expect(keys('ntfc')).toContain('notifications'); // subsequence on the title
    expect(keys('zzzz')).toEqual([]);
    expect(keys('  ')).toHaveLength(flattenScreens(MORE_SECTIONS).length);
  });

  test('filtering keeps a plugin section\'s own fields', () => {
    const plugin = { title: 'Solatrix', pluginId: 'solatrix', isPluginSection: true, monogram: 'SX', items: [{ key: 'p', title: 'Portfolio', desc: 'Holdings', icon: 'wallet-outline', webPath: '/solatrix/portfolio' }] };
    const { sections } = filterScreens('portfolio', [plugin]);
    expect(sections[0]).toMatchObject({ pluginId: 'solatrix', isPluginSection: true, monogram: 'SX' });
  });

  test('empty sections are dropped from results', () => {
    const { sections } = filterScreens('robovoice', MORE_SECTIONS);
    expect(sections.map((s) => s.title)).toEqual(['Chat & Voice']);
  });
});

describe('navigateToScreen', () => {
  const nav = () => {
    const calls = [];
    return { calls, navigate: (...a) => calls.push(a) };
  };
  const byKey = (k) => all.find((e) => e.key === k);

  test('a tab-nested screen keeps the tab home underneath (Back works)', () => {
    const n = nav();
    expect(navigateToScreen(n, byKey('notes'))).toBe(true);
    expect(n.calls).toEqual([['MainTabs', { screen: 'Knowledge', params: { initial: false, screen: 'Notes' } }, { pop: true }]]);
  });

  test('a chat deep link opens the session, then the Chat tab', () => {
    const n = nav();
    const opened = [];
    navigateToScreen(n, { tab: 'Chat', sessionKey: 'agent:main:webchat-abc', params: { sessionKey: 'agent:main:webchat-abc' } }, { switchSession: (k) => opened.push(k) });
    expect(opened).toEqual(['agent:main:webchat-abc']);
    expect(n.calls[0][0]).toBe('MainTabs');
  });

  test('business screens stay inside the Business tab', () => {
    const n = nav();
    navigateToScreen(n, byKey('kisrisks'));
    expect(n.calls).toEqual([['MainTabs', { screen: 'Business', params: { screen: 'Risks', initial: false, params: undefined } }, { pop: true }]]);
  });

  test('tab destinations pop back to the existing tabs instead of stacking a second copy', () => {
    for (const e of all.filter((x) => x.tab || x.businessScreen)) {
      const n = nav();
      navigateToScreen(n, e);
      expect({ key: e.key, route: n.calls[0][0], opts: n.calls[0][2] }).toEqual({ key: e.key, route: 'MainTabs', opts: { pop: true } });
    }
  });

  test('a native screen this build lacks falls back to its web page', () => {
    const n = nav();
    expect(navigateToScreen(n, { screen: 'NoSuchScreen', webFallback: '/reviews', title: 'Reviews' })).toBe(true);
    expect(n.calls).toEqual([['WebSurfaceModal', { path: '/reviews', title: 'Reviews', embed: true }]]);
    expect(navigateToScreen(nav(), { screen: 'NoSuchScreen' })).toBe(false);
  });
});
