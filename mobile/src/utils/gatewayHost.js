// Derive HTTP endpoints from the user's saved gateway URL (Settings → Gateway).
// Nothing here is machine-specific: every host comes from that setting, so a
// fresh install never points at somebody else's LAN.

function parseGatewayUrl(wsUrl) {
  if (typeof wsUrl !== 'string') return null;
  const m = /^(wss?|https?):\/\/([^/?#]+)/i.exec(wsUrl.trim());
  if (!m) return null;
  const secure = /^(wss|https)$/i.test(m[1]);
  // Strip userinfo and port; keep bracketed IPv6 literals intact.
  const authority = m[2].replace(/^.*@/, '');
  const host = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.replace(/:\d+$/, '');
  return { secure, authority, host };
}

/** ws(s)://host:port/path → http(s)://host:port, or '' when unset/invalid. */
export function gatewayHttpOrigin(wsUrl) {
  const p = parseGatewayUrl(wsUrl);
  if (!p) return '';
  return `${p.secure ? 'https' : 'http'}://${p.authority}`;
}

/** Same host as the gateway, different port (plain http), or '' when unset. */
export function serviceUrlOnGatewayHost(wsUrl, port) {
  const p = parseGatewayUrl(wsUrl);
  if (!p || !p.host) return '';
  return `http://${p.host}:${port}`;
}

