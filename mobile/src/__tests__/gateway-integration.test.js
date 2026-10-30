/**
 * Live integration against a real gateway — skipped unless
 *   INFINIBOT_IT_GATEWAY=ws://127.0.0.1:<port>  INFINIBOT_IT_PASSWORD=<pw>
 * are set (run against an isolated SIDE gateway, never the live one).
 *
 * Proves, with the app's own modules:
 *   self-hosted: probe handshake (right / wrong secret), HTTP auth gate
 *                (401 without, 200 with the profile's headers), plugins.list →
 *                dynamic sections → deep link to an Infinitrade page;
 *   cloud:       a mock orchestrator (/fleet/resolve: 409 provisioning → 200)
 *                resolves to that same gateway with a fresh token per call.
 */
import http from 'http';
import { probeGateway } from '../connection/probe';
import {
  makeSelfHostedProfile, buildConnectAuth, buildAuthHeaders, httpOriginFromWs, resolveCloudGateway,
} from '../connection/connection-logic';
import { derivePluginSections } from '../plugins/plugin-nav';
import { resolveDeepLink } from '../navigation/deep-links';

const GW = process.env.INFINIBOT_IT_GATEWAY;
const PW = process.env.INFINIBOT_IT_PASSWORD;
const d = GW && PW ? describe : describe.skip;
jest.setTimeout(30000);

function rpc(url, auth, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'req', id: 'c', method: 'connect', params: {
      minProtocol: 3, maxProtocol: 3, client: { id: 'webchat', version: '1.0.0', platform: 'mobile', mode: 'webchat' }, caps: [], auth,
    } }));
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      if (f.type !== 'res') return;
      if (f.id === 'c') {
        if (!f.ok) { clearTimeout(t); ws.close(); reject(new Error(f.error?.message)); return; }
        ws.send(JSON.stringify({ type: 'req', id: 'm', method, params }));
      } else if (f.id === 'm') {
        clearTimeout(t); ws.close();
        f.ok ? resolve(f.payload) : reject(new Error(f.error?.message));
      }
    };
    ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
  });
}

d('live side gateway', () => {
  // Built lazily: describe bodies run even when the suite is skipped.
  let good;
  let bad;
  beforeAll(() => {
    good = makeSelfHostedProfile({ gatewayUrl: GW, secret: PW, authMode: 'password' });
    bad = makeSelfHostedProfile({ gatewayUrl: GW, secret: 'definitely-wrong', authMode: 'password' });
  });

  test('self-hosted: probe admits the right password, rejects a wrong one', async () => {
    const ok = await probeGateway(good.gatewayUrl, buildConnectAuth(good));
    expect(ok.ok).toBe(true);
    const no = await probeGateway(bad.gatewayUrl, buildConnectAuth(bad));
    expect(no.ok).toBe(false);
    console.log('[it] probe ok server=%j; wrong-pw error=%s', ok.server?.version, no.error);
  });

  test('self-hosted: HTTP auth gate — 401 without, 200 with the profile headers', async () => {
    const origin = httpOriginFromWs(good.gatewayUrl);
    const anon = await fetch(`${origin}/api/push-tokens`);
    const authed = await fetch(`${origin}/api/push-tokens`, { headers: buildAuthHeaders(good) });
    console.log('[it] /api/push-tokens anon=%d authed=%d', anon.status, authed.status);
    expect(anon.status).toBe(401);
    expect(authed.status).toBe(200);
  });

  test('self-hosted: plugins.list → plugin sections → Infinitrade deep link', async () => {
    const list = await rpc(good.gatewayUrl, buildConnectAuth(good), 'plugins.list', {});
    const sections = derivePluginSections(list);
    console.log('[it] plugin sections: %s', sections.map((s) => `${s.title}(${s.items.length})`).join(', '));
    expect(Array.isArray(list.plugins)).toBe(true);
    const it = list.plugins.find((p) => p.id === 'infinitrade');
    if (it && it.enabled && it.status === 'loaded') {
      const target = resolveDeepLink('infinibot://plugin/infinitrade/signals', { plugins: list });
      console.log('[it] deep link →', JSON.stringify(target));
      expect(target.webPath).toBe('/infinitrade/signals');
    }
  });

  test('cloud: mocked /fleet/resolve (409 → 200) resolves to the gateway with a fresh token each call', async () => {
    const seen = [];
    let n = 0;
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      n += 1;
      if (n === 1) {
        res.writeHead(409, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ status: 'provisioning', tenantId: 't-it' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', gatewayWsUrl: `${GW}/ws`, tenantId: 't-it', machineId: 'm1' }));
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    let k = 0;
    const out = await resolveCloudGateway({ orchestratorUrl: `http://127.0.0.1:${port}`, getToken: async () => `clerk-jwt-${++k}` });
    server.close();
    console.log('[it] cloud resolve → %j via %j', out, seen);
    expect(out.state).toBe('ready');
    expect(out.gatewayUrl).toBe(`${GW}/ws`);
    expect(seen).toEqual([
      'POST /fleet/resolve Bearer clerk-jwt-1',
      'POST /fleet/resolve Bearer clerk-jwt-2',
    ]);
    // The resolved URL is reachable (the fleet gateway accepts any WS path).
    const reach = await probeGateway(out.gatewayUrl, buildConnectAuth(good));
    expect(reach.ok).toBe(true);
  });
});
