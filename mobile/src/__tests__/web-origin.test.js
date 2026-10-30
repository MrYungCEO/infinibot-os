import { CONTROL_UI_SETTINGS_KEY, originGatewayUrl, readControlUiCredential, servedByGateway, suggestWebConnection } from '../connection/web-origin';

const loc = (href) => {
  const u = new URL(href);
  return { protocol: u.protocol, host: u.host, pathname: u.pathname };
};
const store = (obj) => ({ getItem: (k) => (k in obj ? obj[k] : null) });

describe('web export connection', () => {
  test('served by the gateway over Tailscale Serve (https) → same-origin wss', () => {
    const l = loc('https://my-host.tailnet.ts.net/mobile-web/index.html');
    expect(servedByGateway(l)).toBe(true);
    expect(originGatewayUrl(l)).toBe('wss://my-host.tailnet.ts.net');
  });

  test('served by the gateway on its own port (http) → ws with the port', () => {
    const l = loc('http://127.0.0.1:18789/mobile-web/');
    expect(suggestWebConnection({ location: l, storage: store({}) })).toEqual({
      gatewayUrl: 'ws://127.0.0.1:18789',
      secret: '',
      authMode: 'password',
      source: 'origin',
      credentialFrom: null,
    });
  });

  test("reuses the control UI's saved password on the same origin (password mode)", () => {
    const s = store({ [CONTROL_UI_SETTINGS_KEY]: JSON.stringify({ gatewayUrl: 'wss://x', password: ' pw ', token: '' }) });
    expect(readControlUiCredential(s)).toEqual({ secret: 'pw', authMode: 'password' });
    const sug = suggestWebConnection({ location: loc('https://gw.ts.net/mobile-web/'), storage: s });
    expect(sug).toMatchObject({ gatewayUrl: 'wss://gw.ts.net', secret: 'pw', authMode: 'password', credentialFrom: 'control-ui' });
  });

  test('token mode and unreadable settings', () => {
    expect(readControlUiCredential(store({ [CONTROL_UI_SETTINGS_KEY]: JSON.stringify({ token: 't' }) }))).toEqual({ secret: 't', authMode: 'token' });
    expect(readControlUiCredential(store({ [CONTROL_UI_SETTINGS_KEY]: '{bad' }))).toBeNull();
    expect(readControlUiCredential(null)).toBeNull();
  });

  test('not served by a gateway (Expo dev server / other host) → baked env URL, never a secret', () => {
    const sug = suggestWebConnection({ location: loc('http://localhost:8082/'), storage: store({}), bakedUrl: 'ws://my-host.tailnet.ts.net:18789' });
    expect(sug).toEqual({ gatewayUrl: 'ws://my-host.tailnet.ts.net:18789', secret: '', authMode: 'password', source: 'env', credentialFrom: null });
    expect(suggestWebConnection({ location: loc('http://localhost:8082/'), storage: store({}) }).source).toBe('none');
    expect(servedByGateway(loc('http://localhost:8082/mobile-webby'))).toBe(false);
  });
});
