// The web control UI's "Connect phone" QR (ui/src/ui/mobile-pairing.ts) must
// round-trip through the app's parsePairingPayload.
import { parsePairingPayload, buildPairingPayload } from '../connection/connection-logic';
import { buildMobilePairingPayload, pickPairingGatewayUrl } from '../../../ui/src/ui/mobile-pairing';

describe('pairing QR payload', () => {
  test('control UI payload → app (password)', () => {
    const raw = buildMobilePairingPayload({ gatewayUrl: 'ws://my-host.tailnet.ts.net:18789', password: 'pw', token: null });
    expect(JSON.parse(raw)).toEqual({ gatewayUrl: 'ws://my-host.tailnet.ts.net:18789', password: 'pw' });
    expect(parsePairingPayload(raw)).toEqual({ gatewayUrl: 'ws://my-host.tailnet.ts.net:18789', secret: 'pw', authMode: 'password' });
  });

  test('control UI payload → app (token, wss via Tailscale Serve)', () => {
    const raw = buildMobilePairingPayload({ gatewayUrl: 'wss://box.tail1.ts.net', token: 'tok' });
    expect(parsePairingPayload(raw)).toEqual({ gatewayUrl: 'wss://box.tail1.ts.net', secret: 'tok', authMode: 'token' });
  });

  test('app-side builder matches the UI builder', () => {
    const a = buildPairingPayload({ gatewayUrl: 'box.tail1.ts.net', secret: 'pw', authMode: 'password' });
    expect(parsePairingPayload(a)).toEqual({ gatewayUrl: 'ws://box.tail1.ts.net:18789', secret: 'pw', authMode: 'password' });
  });

  test('gateway URL prefers Tailscale Serve, then MagicDNS, then the suggested URL', () => {
    expect(pickPairingGatewayUrl({ serveUrl: 'https://box.tail1.ts.net', tailnetHostname: 'box.tail1.ts.net', port: 18789 })).toBe('wss://box.tail1.ts.net');
    expect(pickPairingGatewayUrl({ tailnetHostname: 'box.tail1.ts.net', tailscaleAddress: '100.1.2.3', port: 18789 })).toBe('ws://box.tail1.ts.net:18789');
    expect(pickPairingGatewayUrl({ tailscaleAddress: '100.1.2.3', port: 18789 })).toBe('ws://100.1.2.3:18789');
    expect(pickPairingGatewayUrl({ gatewayUrl: 'ws://192.168.1.5:18789', port: 18789 })).toBe('ws://192.168.1.5:18789');
    expect(pickPairingGatewayUrl({ override: 'wss://gw.example.com', tailnetHostname: 'box.tail1.ts.net' })).toBe('wss://gw.example.com');
  });
});
