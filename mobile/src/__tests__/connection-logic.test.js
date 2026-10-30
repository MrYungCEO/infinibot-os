import {
  normalizeGatewayUrl, httpOriginFromWs, isTailscaleHost, makeSelfHostedProfile, makeCloudProfile,
  buildConnectAuth, buildAuthHeaders, parsePairingPayload, interpretFleetResolve, resolveCloudGateway,
} from '../connection/connection-logic';

describe('normalizeGatewayUrl', () => {
  test.each([
    ['192.168.1.120', 'ws://192.168.1.120:18789'],
    ['my-box.tail1234.ts.net', 'ws://my-box.tail1234.ts.net:18789'],
    ['http://host:8080/x?y', 'ws://host:8080'],
    ['https://gw.example.com', 'wss://gw.example.com'],
    ['wss://gw.example.com:8443/ws', 'wss://gw.example.com:8443'],
    ['ws://host', 'ws://host:18789'],
    ['  ws://user@10.0.0.5:18789/  ', 'ws://10.0.0.5:18789'],
    ['[fd00::1]', 'ws://[fd00::1]:18789'],
  ])('%s → %s', (a, b) => expect(normalizeGatewayUrl(a)).toBe(b));

  test('junk → empty', () => {
    expect(normalizeGatewayUrl('')).toBe('');
    expect(normalizeGatewayUrl('ftp://x')).toBe('');
    expect(normalizeGatewayUrl('ws://')).toBe('');
    expect(normalizeGatewayUrl('has space')).toBe('');
  });

  test('http origin + tailscale detection', () => {
    expect(httpOriginFromWs('wss://a.b')).toBe('https://a.b');
    expect(httpOriginFromWs('10.0.0.2')).toBe('http://10.0.0.2:18789');
    expect(isTailscaleHost('100.64.10.1')).toBe(true);
    expect(isTailscaleHost('box.tailabc.ts.net')).toBe(true);
    expect(isTailscaleHost('192.168.1.2')).toBe(false);
  });
});

describe('auth for WS and HTTP', () => {
  const tok = makeSelfHostedProfile({ gatewayUrl: 'h', secret: 'sekret', authMode: 'token' });
  const pw = makeSelfHostedProfile({ gatewayUrl: 'h', secret: 'pw', authMode: 'password' });
  const open = makeSelfHostedProfile({ gatewayUrl: 'h' });
  const cloud = makeCloudProfile({ orchestratorUrl: 'https://orch.example/' });

  test('self-hosted: token vs password in connect; Bearer for HTTP either way', () => {
    expect(buildConnectAuth(tok)).toEqual({ token: 'sekret' });
    expect(buildConnectAuth(pw)).toEqual({ password: 'pw' });
    expect(buildConnectAuth(open)).toBeUndefined();
    expect(buildConnectAuth(pw, { deviceToken: 'dev' })).toEqual({ token: 'dev' });
    expect(buildAuthHeaders(tok)).toEqual({ Authorization: 'Bearer sekret' });
    expect(buildAuthHeaders(pw)).toEqual({ Authorization: 'Bearer pw' });
    expect(buildAuthHeaders(open)).toEqual({});
  });

  test('cloud: the fresh Clerk token, never a stored secret', () => {
    expect(cloud.orchestratorUrl).toBe('https://orch.example');
    expect(buildConnectAuth(cloud, { clerkToken: 'jwt1', deviceToken: 'ignored' })).toEqual({ token: 'jwt1' });
    expect(buildAuthHeaders(cloud, { clerkToken: 'jwt2' })).toEqual({ Authorization: 'Bearer jwt2' });
    expect(buildAuthHeaders(cloud)).toEqual({});
    expect(() => makeCloudProfile({ orchestratorUrl: '' })).toThrow(/not configured/);
  });

  test('self-hosted profile validation', () => {
    expect(() => makeSelfHostedProfile({ gatewayUrl: '' })).toThrow(/gateway address/);
    expect(makeSelfHostedProfile({ gatewayUrl: '100.64.0.9' }).label).toBe('100.64.0.9:18789');
  });
});

describe('pairing payloads', () => {
  test('app link, web link, JSON, bare URL', () => {
    expect(parsePairingPayload('infinibot://connect?url=ws%3A%2F%2F10.0.0.2%3A18789&token=abc&name=PC'))
      .toEqual({ gatewayUrl: 'ws://10.0.0.2:18789', secret: 'abc', authMode: 'token' });
    expect(parsePairingPayload('https://h/?gateway=box.ts.net&password=pw'))
      .toEqual({ gatewayUrl: 'ws://box.ts.net:18789', secret: 'pw', authMode: 'password' });
    expect(parsePairingPayload('{"gatewayUrl":"wss://x.y","token":"t"}'))
      .toEqual({ gatewayUrl: 'wss://x.y', secret: 't', authMode: 'token' });
    expect(parsePairingPayload('192.168.1.110')).toEqual({ gatewayUrl: 'ws://192.168.1.110:18789', secret: '', authMode: 'token' });
    expect(parsePairingPayload('not a url at all')).toBeNull();
  });
});

describe('/fleet/resolve', () => {
  test('interpret each orchestrator answer', () => {
    expect(interpretFleetResolve(200, { status: 'ready', gatewayWsUrl: 'wss://t1.fly.dev/ws', tenantId: 't1' }))
      .toEqual({ state: 'ready', gatewayUrl: 'wss://t1.fly.dev/ws', tenantId: 't1' });
    expect(interpretFleetResolve(200, { status: 'serverless', mode: 'serverless' })).toEqual({ state: 'serverless' });
    expect(interpretFleetResolve(409, { status: 'provisioning' }, '3')).toEqual({ state: 'waking', retryAfterMs: 3000 });
    expect(interpretFleetResolve(401, {})).toMatchObject({ state: 'error', reauth: true });
    expect(interpretFleetResolve(403, { error: 'tenant_inactive' })).toMatchObject({ state: 'error' });
    expect(interpretFleetResolve(503, { status: 'error', error: 'wake_failed' })).toMatchObject({ state: 'error', retryable: true });
  });

  function mockFetch(responses) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const [status, body, retryAfter] = responses.shift();
      return { status, json: async () => body, headers: { get: (h) => (h === 'retry-after' ? retryAfter ?? null : null) } };
    };
    return { calls, fetchImpl };
  }

  test('polls through provisioning with a FRESH token per attempt, then connects', async () => {
    const { calls, fetchImpl } = mockFetch([[409, { status: 'provisioning' }, '1'], [200, { status: 'ready', gatewayWsUrl: 'wss://t.fly.dev/ws', tenantId: 't' }]]);
    let n = 0;
    const sleeps = [];
    const out = await resolveCloudGateway({
      orchestratorUrl: 'https://orch.test/', getToken: async () => `jwt-${++n}`, fetchImpl, sleep: async (ms) => sleeps.push(ms),
    });
    expect(out).toEqual({ state: 'ready', gatewayUrl: 'wss://t.fly.dev/ws', tenantId: 't' });
    expect(calls.map((c) => c.url)).toEqual(['https://orch.test/fleet/resolve', 'https://orch.test/fleet/resolve']);
    expect(calls.map((c) => c.init.headers.Authorization)).toEqual(['Bearer jwt-1', 'Bearer jwt-2']);
    expect(calls[0].init.method).toBe('POST');
    expect(sleeps).toEqual([1000]);
  });

  test('401 retries once with skipCache, then reports re-auth', async () => {
    const { fetchImpl } = mockFetch([[401, {}], [401, {}]]);
    const opts = [];
    const out = await resolveCloudGateway({ orchestratorUrl: 'https://o', getToken: async (o) => { opts.push(o); return 'x'; }, fetchImpl, sleep: async () => {} });
    expect(out).toMatchObject({ state: 'error', reauth: true });
    expect(opts).toEqual([undefined, { skipCache: true }]);
  });

  test('not signed in → no request', async () => {
    const { calls, fetchImpl } = mockFetch([]);
    const out = await resolveCloudGateway({ orchestratorUrl: 'https://o', getToken: async () => null, fetchImpl });
    expect(out.state).toBe('error');
    expect(calls.length).toBe(0);
  });
});
