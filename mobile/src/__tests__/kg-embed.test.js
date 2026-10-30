import {
  KG_BRIDGE_SOURCE,
  KG_HOST_SOURCE,
  buildKgEmbedPath,
  buildKgEmbedUrl,
  deepLinkFromParams,
  hostCommand,
  hostCommandMessage,
  hostCommandScript,
  originOf,
  paramsSignature,
  parseBridgeMessage,
} from '../lib/kg-embed';
import { buildBeforeContentJS, wsToHttp } from '../lib/web-auth-seed';
import { resolveDeepLink } from '../navigation/deep-links';

const msg = (o) => JSON.stringify({ source: KG_BRIDGE_SOURCE, ...o });

describe('embed URL', () => {
  test('plain graph', () => {
    expect(buildKgEmbedPath()).toBe('/knowledge-graph?embed=mobile');
    expect(buildKgEmbedUrl('http://my-host.tailnet.ts.net:18789/', {})).toBe(
      'http://my-host.tailnet.ts.net:18789/knowledge-graph?embed=mobile',
    );
  });

  test('from the active ws:// gateway (Tailscale) and wss://', () => {
    expect(buildKgEmbedUrl(wsToHttp('ws://my-host.tailnet.ts.net:18789'), {})).toBe(
      'http://my-host.tailnet.ts.net:18789/knowledge-graph?embed=mobile',
    );
    expect(buildKgEmbedUrl(wsToHttp('wss://gw.ts.net'), {})).toBe('https://gw.ts.net/knowledge-graph?embed=mobile');
    expect(buildKgEmbedUrl('', {})).toBeNull();
    expect(buildKgEmbedUrl('javascript:alert(1)', {})).toBeNull();
  });

  test('focus / family / project / layer / group are encoded', () => {
    expect(buildKgEmbedPath({ focus: 'project:abc 1', family: true })).toBe('/knowledge-graph?embed=mobile&focus=project%3Aabc%201&family=1');
    expect(buildKgEmbedPath({ project: 'p1' })).toBe('/knowledge-graph?embed=mobile&focus=project%3Ap1');
    expect(buildKgEmbedPath({ layer: 'report', group: 'type' })).toBe('/knowledge-graph?embed=mobile&layer=report&group=type');
  });

  test('phone-only layers map to the web layer that holds them; junk is dropped', () => {
    expect(deepLinkFromParams({ layer: 'research' })).toEqual({ focus: null, family: false, layer: 'note', group: 'type' });
    expect(deepLinkFromParams({ layer: 'bogus', group: 'nope' })).toEqual({ focus: null, family: false, layer: null, group: null });
    expect(deepLinkFromParams({ family: '1' }).family).toBe(true);
  });

  test('every graph deep link resolves to params the embed URL understands', () => {
    const entry = resolveDeepLink('infinibot://knowledge/project:abc?family=1');
    const p = entry.params.params;
    expect(buildKgEmbedPath(p)).toBe('/knowledge-graph?embed=mobile&focus=project%3Aabc&family=1');
    const g = resolveDeepLink('infinibot://knowledge/graph');
    expect(buildKgEmbedPath(g.params.params)).toBe('/knowledge-graph?embed=mobile');
  });

  test('signature changes with the target and with _ts', () => {
    expect(paramsSignature({ focus: 'a' })).not.toBe(paramsSignature({ focus: 'b' }));
    expect(paramsSignature({ focus: 'a', _ts: 1 })).not.toBe(paramsSignature({ focus: 'a', _ts: 2 }));
    expect(paramsSignature(null)).toBe(paramsSignature({}));
  });
});

describe('page → app messages', () => {
  test('ready / haptic / back', () => {
    expect(parseBridgeMessage(msg({ type: 'ready', nodes: 512, mode: '3d' }))).toEqual({ type: 'ready', nodes: 512, mode: '3d' });
    expect(parseBridgeMessage(msg({ type: 'haptic', style: 'selection' }))).toEqual({ type: 'haptic', style: 'selection' });
    expect(parseBridgeMessage(msg({ type: 'haptic', style: 'boom' }))).toBeNull();
    expect(parseBridgeMessage({ source: KG_BRIDGE_SOURCE, type: 'back' })).toEqual({ type: 'back' });
  });

  test('open carries the node; only app-relative paths survive', () => {
    const m = parseBridgeMessage(msg({ type: 'open', node: { id: 'project:p1', kind: 'project', label: 'InfinibotOS', meta: { projectId: 'p1' } }, path: '/projects/p1' }));
    expect(m).toEqual({ type: 'open', node: { id: 'project:p1', kind: 'project', label: 'InfinibotOS', meta: { projectId: 'p1' } }, path: '/projects/p1' });
    expect(parseBridgeMessage(msg({ type: 'open', node: { id: 'n', kind: 'note', label: 'x' }, path: 'https://evil.example' })).path).toBeNull();
    expect(parseBridgeMessage(msg({ type: 'open', node: { kind: 'note' } }))).toBeNull();
    expect(parseBridgeMessage(msg({ type: 'open', node: { id: 'n', kind: 'note', meta: [1] } })).node.meta).toEqual({});
  });

  test('ignores other sources, garbage and unknown types', () => {
    expect(parseBridgeMessage('{"type":"ready"}')).toBeNull();
    expect(parseBridgeMessage('not json')).toBeNull();
    expect(parseBridgeMessage(null)).toBeNull();
    expect(parseBridgeMessage(msg({ type: 'eval', code: '1' }))).toBeNull();
  });
});

describe('app → page commands', () => {
  test('injected script calls __kgEmbed with JSON-encoded args', () => {
    const s = hostCommandScript(hostCommand('focus', { id: 'note:"x");alert(1);//', family: true }));
    expect(s).toContain('k.focus("note:\\"x\\");alert(1);//",{family:true})');
    expect(s.startsWith('(function(){try{var k=window.__kgEmbed;')).toBe(true);
    expect(s.trim().endsWith('true;')).toBe(true);
    expect(hostCommandScript(hostCommand('back'))).toContain('k.back()');
    expect(hostCommandScript(hostCommand('fit'))).toContain('k.fit()');
    expect(hostCommandScript(null)).toBe('true;');
  });

  test('apply normalises params; focus needs an id', () => {
    expect(hostCommand('apply', { project: 'p1', layer: 'research' })).toEqual({ cmd: 'apply', focus: 'project:p1', family: false, layer: 'note', group: 'type' });
    expect(hostCommand('focus', {})).toBeNull();
    expect(hostCommand('nope')).toBeNull();
  });

  test('iframe message is tagged for the page listener', () => {
    expect(JSON.parse(hostCommandMessage(hostCommand('fit')))).toEqual({ source: KG_HOST_SOURCE, cmd: 'fit' });
    expect(hostCommandMessage(null)).toBeNull();
  });

  test('originOf', () => {
    expect(originOf('http://Host.ts.net:18789/knowledge-graph?embed=mobile')).toBe('http://host.ts.net:18789');
    expect(originOf('ws://x')).toBeNull();
  });
});

describe('auth hand-off (no login screen)', () => {
  test('password profile seeds the control UI password and skips the profile gate', () => {
    const js = buildBeforeContentJS('ws://gw:18789', 'pw"1', 'password');
    expect(js).toContain("infinibot.control.settings.v1");
    expect(js).toContain("infinibot.profiles.gateEnabled.v1','0'");
    const seeded = JSON.parse(JSON.parse(/setItem\('infinibot\.control\.settings\.v1', (".*?")\);/.exec(js)[1]));
    expect(seeded).toEqual({ password: 'pw"1', gatewayUrl: 'ws://gw:18789', token: '' });
  });

  test('token profile (cloud) seeds only the token', () => {
    const js = buildBeforeContentJS('wss://cloud', 'tok', 'token');
    const seeded = JSON.parse(JSON.parse(/setItem\('infinibot\.control\.settings\.v1', (".*?")\);/.exec(js)[1]));
    expect(seeded).toEqual({ password: '', gatewayUrl: 'wss://cloud', token: 'tok' });
  });
});
