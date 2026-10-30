/**
 * "Connect phone" pairing payload for the Mobile page QR.
 *
 * The app scans it with parsePairingPayload (mobile/src/connection/
 * connection-logic.js), which accepts JSON {gatewayUrl, password|token}.
 * mobile/src/__tests__/pairing-qr.test.js round-trips this module through that
 * parser, so keep this file dependency-free.
 *
 * Why the real secret and not a short-lived code: the gateway's invite tokens
 * (src/gateway/pairing-invites.ts) are single-use for ONE WebSocket connect,
 * and the app has no device identity to turn that into a lasting login, so it
 * would stop working on the first reconnect. The QR therefore carries the
 * gateway password/token and stays hidden until the user clicks Reveal.
 */

export const GATEWAY_DEFAULT_PORT = 18789;

export type PairingUrlInputs = {
  /** Explicit Mobile-page override (gatewayUrlOverride). */
  override?: string | null;
  /** Tailscale Serve https URL proxying this gateway at "/" (→ wss). */
  serveUrl?: string | null;
  tailnetHostname?: string | null;
  tailscaleAddress?: string | null;
  /** The gateway's own best guess (mobile.config.get suggested.gatewayUrl). */
  gatewayUrl?: string | null;
  port?: number | null;
};

function toWs(raw: string, port: number): string {
  let v = raw.trim();
  if (!v) return "";
  const secure = /^(wss|https):\/\//i.test(v);
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
  if (!v) return "";
  const hasPort = /:\d+$/.test(v);
  if (!hasPort && !secure) v = `${v}:${port}`;
  return `${secure ? "wss" : "ws"}://${v}`;
}

/**
 * The URL a phone should use: an explicit override, else Tailscale Serve
 * (wss, port 443), else the MagicDNS name on the gateway port, else the
 * Tailscale IP, else the gateway's suggestion.
 */
export function pickPairingGatewayUrl(i: PairingUrlInputs): string {
  const port = i.port && i.port > 0 ? i.port : GATEWAY_DEFAULT_PORT;
  if (i.override?.trim()) return toWs(i.override, port);
  if (i.serveUrl?.trim()) return toWs(i.serveUrl, port);
  if (i.tailnetHostname?.trim()) return toWs(i.tailnetHostname, port);
  if (i.tailscaleAddress?.trim()) return toWs(i.tailscaleAddress, port);
  if (i.gatewayUrl?.trim()) return toWs(i.gatewayUrl, port);
  return "";
}

/** JSON payload for the QR. A password wins over a token (the gateway's auth mode). */
export function buildMobilePairingPayload(opts: {
  gatewayUrl: string;
  password?: string | null;
  token?: string | null;
}): string {
  const out: { gatewayUrl: string; password?: string; token?: string } = { gatewayUrl: opts.gatewayUrl };
  if (opts.password) out.password = opts.password;
  else if (opts.token) out.token = opts.token;
  return JSON.stringify(out);
}
