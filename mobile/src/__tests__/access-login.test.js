import { buildAuthHeaders, buildConnectAuth, isUserSessionToken, makeSelfHostedProfile } from '../connection/connection-logic';
import { loginWorkspaceUser } from '../connection/access-login';

const okFetch = (status, body) => jest.fn(async () => ({ ok: status < 400, status, json: async () => body }));

describe('workspace-user profiles', () => {
  test('user mode keeps the session token and username', () => {
    const p = makeSelfHostedProfile({ gatewayUrl: '10.0.0.5', secret: 'ibus_abc', authMode: 'user', username: 'dana' });
    expect(p.authMode).toBe('user');
    expect(p.username).toBe('dana');
    expect(isUserSessionToken(p.secret)).toBe(true);
  });

  test('a stored owner device token never replaces the user session', () => {
    const p = makeSelfHostedProfile({ gatewayUrl: '10.0.0.5', secret: 'ibus_abc', authMode: 'user', username: 'dana' });
    expect(buildConnectAuth(p, { deviceToken: 'owner-device-token' })).toEqual({ token: 'ibus_abc' });
    expect(buildAuthHeaders(p)).toEqual({});
  });

  test('owner password/token profiles are unchanged', () => {
    const pw = makeSelfHostedProfile({ gatewayUrl: '10.0.0.5', secret: 's3cret', authMode: 'password' });
    expect(buildConnectAuth(pw)).toEqual({ password: 's3cret' });
    expect(buildConnectAuth(pw, { deviceToken: 'dev' })).toEqual({ token: 'dev' });
    expect(pw.username).toBeUndefined();
  });
});

describe('loginWorkspaceUser', () => {
  test('posts to /api/access/login and returns the token', async () => {
    const fetchImpl = okFetch(200, { token: 'ibus_t', expiresAt: 5, user: { id: 'u' } });
    const r = await loginWorkspaceUser({ gatewayUrl: 'ws://10.0.0.5:18789', username: ' dana ', password: 'pw', fetchImpl });
    expect(r).toEqual({ ok: true, token: 'ibus_t', expiresAt: 5, user: { id: 'u' } });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://10.0.0.5:18789/api/access/login');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ login: 'dana', password: 'pw' });
  });

  test('asks for a 2FA code when required', async () => {
    const r = await loginWorkspaceUser({ gatewayUrl: '10.0.0.5', username: 'dana', password: 'pw', fetchImpl: okFetch(401, { error: 'totp_required' }) });
    expect(r.ok).toBe(false);
    expect(r.needsCode).toBe(true);
  });

  test('maps bad credentials and rate limits', async () => {
    expect((await loginWorkspaceUser({ gatewayUrl: '10.0.0.5', username: 'd', password: 'x', fetchImpl: okFetch(401, { error: 'invalid_credentials' }) })).error).toMatch(/Wrong username/);
    expect((await loginWorkspaceUser({ gatewayUrl: '10.0.0.5', username: 'd', password: 'x', fetchImpl: okFetch(429, {}) })).error).toMatch(/Too many/);
  });
});
