import {
  initialReconnectState, onConnectFailure, onSocketClosed, onConnected, onUserRetry, canAutoReconnect,
} from '../connection/reconnect-policy';
import {
  classifyConnectFailure, describeAuthFailure, buildCredentialOffer, makeSelfHostedProfile, gatewayHost,
} from '../connection/connection-logic';

const authErr = (msg, details) => Object.assign(new Error(msg), { code: 'INVALID_REQUEST', ...(details ? { details } : {}) });

describe('reconnect state machine', () => {
  test('auth error → halted, no retry, no backoff', () => {
    const out = onConnectFailure(initialReconnectState(),
      authErr('unauthorized: gateway password mismatch (provide gateway auth password)'));
    expect(out.action).toBe('halt');
    expect(out.delayMs).toBeNull();
    expect(out.state.halted).toMatchObject({ kind: 'auth', authMode: 'password' });
    expect(canAutoReconnect(out.state)).toBe(false);
    // A socket close after the halt does not schedule anything either.
    expect(onSocketClosed(out.state)).toMatchObject({ action: 'halt', delayMs: null });
  });

  test('token mismatch and pairing required also halt', () => {
    expect(onConnectFailure(initialReconnectState(), authErr('unauthorized: gateway token mismatch (x)')).state.halted)
      .toMatchObject({ kind: 'auth', authMode: 'token' });
    const p = onConnectFailure(initialReconnectState(), Object.assign(new Error('pairing required'), { code: 'NOT_PAIRED' }));
    expect(p.action).toBe('halt');
    expect(p.state.halted.kind).toBe('pairing');
  });

  test('network error → exponential backoff 1s,2s,4s,8s,10s cap', () => {
    let st = initialReconnectState();
    const delays = [];
    for (let i = 0; i < 6; i++) {
      const out = onConnectFailure(st, new Error('Request timeout'));
      expect(out.action).toBe('retry');
      delays.push(out.delayMs);
      st = out.state;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
    expect(canAutoReconnect(st)).toBe(true);
  });

  test('plain socket closes back off too, and success resets', () => {
    let st = initialReconnectState();
    st = onSocketClosed(st).state;
    const second = onSocketClosed(st);
    expect(second.delayMs).toBe(2000);
    expect(onConnected()).toEqual({ attempt: 0, halted: null });
  });

  test('stale device token: clear it and retry once immediately', () => {
    const out = onConnectFailure(initialReconnectState(), authErr('unauthorized: gateway token mismatch'), { usedDeviceToken: true });
    expect(out).toMatchObject({ action: 'retry', delayMs: 0, clearDeviceToken: true });
    expect(out.state.halted).toBeNull();
  });

  test('user retry lifts the halt', () => {
    const halted = onConnectFailure(initialReconnectState(), authErr('unauthorized: gateway password mismatch')).state;
    expect(canAutoReconnect(onUserRetry(halted))).toBe(true);
  });
});

describe('classifyConnectFailure', () => {
  test('uses the gateway authMode hint in error.details', () => {
    const f = classifyConnectFailure(authErr('unauthorized', { kind: 'auth', authMode: 'token', authReason: 'token_missing' }));
    expect(f).toMatchObject({ kind: 'auth', authMode: 'token', reason: 'token_missing' });
  });
  test('network-ish messages are not auth', () => {
    expect(classifyConnectFailure(new Error('Request timeout')).kind).toBe('network');
    expect(classifyConnectFailure(new Error('protocol version mismatch')).kind).toBe('network');
    expect(classifyConnectFailure('Not connected').kind).toBe('network');
  });
  test('close reasons classify too', () => {
    expect(classifyConnectFailure({ message: 'unauthorized: gateway password mismatch (provide gateway auth password)' }).authMode).toBe('password');
  });
});

describe('auth failure copy + build credential offer', () => {
  const profile = makeSelfHostedProfile({ gatewayUrl: 'ws://my-host.tailnet.ts.net:18789', secret: 'old', authMode: 'password' });
  const failure = { kind: 'auth', authMode: 'password', reason: 'password_mismatch', message: 'unauthorized' };

  test('headline names the host and the credential type', () => {
    expect(describeAuthFailure(failure, profile)).toBe('Wrong gateway password for my-host.tailnet.ts.net');
    expect(describeAuthFailure({ ...failure, authMode: 'token', reason: 'token_missing' }, profile))
      .toBe('my-host.tailnet.ts.net needs a gateway token');
    expect(describeAuthFailure({ kind: 'pairing' }, profile)).toMatch(/needs approval/);
  });

  test('offered only when the build URL host matches and the secret differs', () => {
    const offer = buildCredentialOffer({ profile, failure, bakedUrl: 'ws://BIGCEO-MS-7E06.tailnet.ts.net:18789', bakedSecret: 'right' });
    expect(offer).toMatchObject({ id: profile.id, secret: 'right', authMode: 'password', gatewayUrl: profile.gatewayUrl });
    expect(buildCredentialOffer({ profile, failure, bakedUrl: 'ws://other-host:18789', bakedSecret: 'right' })).toBeNull();
    expect(buildCredentialOffer({ profile, failure, bakedUrl: profile.gatewayUrl, bakedSecret: 'old' })).toBeNull();
    expect(buildCredentialOffer({ profile, failure, bakedUrl: profile.gatewayUrl, bakedSecret: '' })).toBeNull();
    expect(buildCredentialOffer({ profile, failure: { kind: 'network' }, bakedUrl: profile.gatewayUrl, bakedSecret: 'right' })).toBeNull();
  });

  test('gatewayHost strips scheme and port', () => {
    expect(gatewayHost('wss://a.b.ts.net')).toBe('a.b.ts.net');
    expect(gatewayHost('192.168.1.2')).toBe('192.168.1.2');
  });
});
