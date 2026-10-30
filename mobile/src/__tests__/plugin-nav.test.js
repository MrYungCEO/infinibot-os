import {
  derivePluginSections, mergeCatalogue, resolvePluginPage, pluginPageForWebPath, ioniconFor,
} from '../plugins/plugin-nav';
import { SCREEN_SECTIONS } from '../navigation/screen-registry';
import { PLUGINS } from './fixtures-plugins';

describe('derivePluginSections', () => {
  const sections = derivePluginSections(PLUGINS);

  test('one section per loaded v2 plugin, sorted by navSection order', () => {
    expect(sections.map((s) => s.pluginId)).toEqual(['business-agency', 'infinitrade', 'discipline']);
  });

  test('disabled plugins and v1 plugins get no section', () => {
    expect(sections.find((s) => s.pluginId === 'solatrix')).toBeUndefined();
    expect(sections.find((s) => s.pluginId === 'legacy-v1')).toBeUndefined();
  });

  test('navSection items, labels, owner-hidden pages dropped', () => {
    const it = sections.find((s) => s.pluginId === 'infinitrade');
    expect(it.items.map((i) => i.title)).toEqual(['Dashboard', 'Signals']);
    expect(it.monogram).toBe('IT');
    expect(it.accent).toBe('#22c55e');
    expect(it.items[1]).toMatchObject({ webPath: '/infinitrade/signals', embed: true, pluginId: 'infinitrade' });
  });

  test('native screens win where the app has them, web route kept as fallback', () => {
    const ds = sections.find((s) => s.pluginId === 'discipline');
    expect(ds.items[0]).toMatchObject({ screen: 'DisciplineScreen', webFallback: '/discipline' });
    expect(ds.items[1]).toMatchObject({ webPath: '/focus' });
    const ba = sections.find((s) => s.pluginId === 'business-agency');
    // no navSection.items → every page in manifest order
    expect(ba.items[0]).toMatchObject({ businessScreen: 'Opportunities' });
    expect(ba.items[1]).toMatchObject({ screen: 'AgencyDailyScreen' });
  });

  test('icon mapping falls back to a puzzle piece', () => {
    expect(ioniconFor('radar')).toBe('radio-outline');
    expect(ioniconFor('nope-xyz')).toBe('extension-puzzle-outline');
  });
});

describe('mergeCatalogue', () => {
  test('unknown plugin list → static catalogue untouched (offline fallback)', () => {
    expect(mergeCatalogue(SCREEN_SECTIONS, null)).toBe(SCREEN_SECTIONS);
  });

  test('known list → plugin-owned core entries removed, plugin sections appended', () => {
    const merged = mergeCatalogue(SCREEN_SECTIONS, derivePluginSections(PLUGINS));
    const keys = merged.flatMap((s) => s.items.map((i) => i.key));
    expect(keys).not.toContain('discipline'); // core entry tagged plugin:'discipline'
    expect(keys).not.toContain('whiteboard'); // whiteboard plugin absent → page gone
    expect(keys).toContain('plugin:discipline:discipline');
    expect(keys).toContain('plugins'); // the Plugins screen is core
    expect(merged.filter((s) => s.isPluginSection).map((s) => s.pluginId)).toEqual(['business-agency', 'infinitrade', 'discipline']);
    // a core section emptied by the filter disappears: only the plugin's own
    // "Business & Agency" section is left, never a second one beside it
    expect(merged.filter((s) => !s.isPluginSection).map((s) => s.title)).toEqual(['Main', 'Home', 'Chat & Voice', 'Work', 'Agents', 'Content', 'Settings']);
    expect(keys).toContain('opsagents'); // core, lives under Agents
  });
});

describe('resolvePluginPage', () => {
  test('page by tab, by <id>-<page>, by route suffix', () => {
    expect(resolvePluginPage(PLUGINS, 'infinitrade', 'infinitrade-signals').entry.webPath).toBe('/infinitrade/signals');
    expect(resolvePluginPage(PLUGINS, 'infinitrade', 'signals').entry.webPath).toBe('/infinitrade/signals');
    expect(resolvePluginPage(PLUGINS, 'discipline', 'focus').entry.webPath).toBe('/focus');
  });

  test('query passes through', () => {
    expect(resolvePluginPage(PLUGINS, 'infinitrade', 'signals', 'signal=abc').entry.webPath).toBe('/infinitrade/signals?signal=abc');
  });

  test('unknown sub-page → main page with ?section=', () => {
    expect(resolvePluginPage(PLUGINS, 'infinitrade', 'positions').entry.webPath).toBe('/infinitrade?section=positions');
  });

  test('no page → main page; native when available', () => {
    expect(resolvePluginPage(PLUGINS, 'discipline', null).entry.screen).toBe('DisciplineScreen');
  });

  test('disabled / unknown plugins are reported', () => {
    expect(resolvePluginPage(PLUGINS, 'solatrix', 'alerts').disabled.id).toBe('solatrix');
    expect(resolvePluginPage(PLUGINS, 'nope', null).unknown).toBe(true);
  });
});

describe('pluginPageForWebPath', () => {
  test('longest route prefix wins; exact flag', () => {
    expect(pluginPageForWebPath(PLUGINS, '/infinitrade/signals')).toMatchObject({ pluginId: 'infinitrade', exact: true });
    expect(pluginPageForWebPath(PLUGINS, '/infinitrade/signals/x')).toMatchObject({ pluginId: 'infinitrade', exact: false });
    expect(pluginPageForWebPath(PLUGINS, '/solatrix/alerts')).toMatchObject({ pluginId: 'solatrix', exact: true });
    expect(pluginPageForWebPath(PLUGINS, '/dashboard')).toBeNull();
  });
});
