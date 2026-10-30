import {
  gatewayHttpOrigin,
  serviceUrlOnGatewayHost,
} from '../utils/gatewayHost';

describe('gatewayHost', () => {
  test('ws → http origin, path dropped', () => {
    expect(gatewayHttpOrigin('ws://10.0.0.5:18789/ws')).toBe('http://10.0.0.5:18789');
    expect(gatewayHttpOrigin('wss://gw.example.com')).toBe('https://gw.example.com');
    expect(gatewayHttpOrigin('https://gw.example.com:8443/x?y=1')).toBe('https://gw.example.com:8443');
  });

  test('unset or invalid URL → empty string (no hardcoded fallback)', () => {
    expect(gatewayHttpOrigin('')).toBe('');
    expect(gatewayHttpOrigin(undefined)).toBe('');
    expect(gatewayHttpOrigin('not a url')).toBe('');
    expect(serviceUrlOnGatewayHost('', 9000)).toBe('');
  });

  test('service on gateway host swaps the port', () => {
    expect(serviceUrlOnGatewayHost('ws://10.0.0.5:18789', 9000)).toBe('http://10.0.0.5:9000');
    expect(serviceUrlOnGatewayHost('wss://user@gw.example.com:443/path', 9000)).toBe('http://gw.example.com:9000');
    expect(serviceUrlOnGatewayHost('ws://[fd00::1]:18789', 9000)).toBe('http://[fd00::1]:9000');
  });
});
