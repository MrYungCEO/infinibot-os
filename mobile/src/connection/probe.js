/**
 * probeGateway — open a throwaway WebSocket, perform the `connect` handshake
 * with the given auth block, and report whether the gateway admits us. Used
 * by the connection chooser so a profile is only saved once it really works
 * (right port, right secret, reachable over LAN/Tailscale).
 */
import { PROTOCOL_VERSION, CLIENT_INFO } from '../constants/gateway';
import { classifyConnectFailure } from './connection-logic';

export function probeGateway(url, auth, { timeoutMs = 9000, WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Promise((resolve) => {
    let ws;
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch {}
      resolve(out);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: `No answer from ${url} — check the address, port and that the phone can reach it (same Wi-Fi or Tailscale).` }),
      timeoutMs,
    );
    try {
      ws = new WebSocketImpl(url);
    } catch (e) {
      finish({ ok: false, error: e?.message || 'Invalid address' });
      return;
    }
    const id = `probe-${Date.now()}`;
    let sent = false;
    const sendConnect = () => {
      if (sent || !ws || ws.readyState !== 1) return;
      sent = true;
      ws.send(JSON.stringify({
        type: 'req',
        id,
        method: 'connect',
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: CLIENT_INFO,
          caps: [],
          locale: 'en-US',
          ...(auth ? { auth } : {}),
        },
      }));
    };
    ws.onopen = () => setTimeout(sendConnect, 250);
    ws.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      if (f?.type === 'event' && f.event === 'connect.challenge') sendConnect();
      if (f?.type !== 'res' || f.id !== id) return;
      if (f.ok && f.payload?.type === 'hello-ok') {
        finish({ ok: true, server: f.payload.server || null, methods: f.payload.features?.methods || [] });
      } else {
        const msg = f.error?.message || f.payload?.error || 'The gateway refused the connection';
        const failure = classifyConnectFailure({ message: msg, code: f.error?.code, details: f.error?.details });
        const error = failure.kind === 'auth'
          ? `Wrong ${failure.authMode || 'password or token'} — the gateway rejected it (${msg}).`
          : failure.kind === 'pairing'
            ? `This device needs approval on the gateway first (${msg}).`
            : msg;
        finish({ ok: false, error, code: f.error?.code, failure });
      }
    };
    ws.onerror = () => finish({ ok: false, error: `Cannot reach ${url}.` });
    ws.onclose = (e) => {
      if (!done) finish({ ok: false, error: e?.reason ? `Connection closed: ${e.reason}` : `Connection closed by ${url}.` });
    };
  });
}
