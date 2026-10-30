// Test doubles for the relay link: a KinglyVault relay over real HTTP, and a
// stand-in InfiniBot install so LocalGateway can run without a build.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const waitFor = async (check, { timeoutMs = 4000, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

export const silentLog = () => {
  const lines = [];
  const add = (m) => lines.push(String(m));
  return { lines, info: add, warn: add, error: add };
};

/** `handlers[op]` returns { status, body }, or null to never answer. Default: an empty pull. */
export async function startRelayStub(handlers = {}) {
  const stub = { calls: [], handlers, closedEarly: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      stub.calls.push({ op: body.op, body, bearer: req.headers.authorization, at: Date.now() });
      const h = stub.handlers[body.op];
      const out = h ? await h(body) : { status: 200, body: { requests: [], paused: false } };
      if (!out) {
        res.on('close', () => stub.closedEarly++);
        return;
      }
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  stub.url = `http://127.0.0.1:${server.address().port}/`;
  stub.pulls = () => stub.calls.filter((c) => c.op === 'device.pull');
  stub.close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  };
  return stub;
}

export const pairedState = (relayUrl, over = {}) => ({
  relayUrl,
  kvOrigin: 'https://kv.test',
  account: 't***@example.com',
  connectionId: 'conn-test',
  deviceSecret: 'device-secret-old',
  token: 'token-old',
  grantedScopes: ['chat'],
  kvMcp: null,
  pairedAt: new Date().toISOString(),
  rotatedAt: new Date().toISOString(),
  paused: false,
  ...over,
});

export function writeState(state) {
  const dir = path.join(process.env.INFINIBOT_STATE_DIR, 'kinglyvault-relay');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
}

/**
 * A fake install root. Its GatewayClient records itself on globalThis.__kvGw and
 * never answers a method unless the test sets a handler, like a wedged gateway.
 */
export function makeStubRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-root-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('dist/infra/device-identity.js', 'export const loadOrCreateDeviceIdentity = () => ({});\n');
  write('dist/gateway/protocol/index.js', 'export const PROTOCOL_VERSION = 3;\n');
  write(
    'dist/gateway/client.js',
    `const b = (globalThis.__kvGw ??= { clients: [], calls: [], handlers: {}, silent: false });
export class GatewayClient {
  constructor(opts) { this.opts = opts; this.stopped = false; b.clients.push(this); }
  start() { if (!b.silent) setTimeout(() => this.opts.onHelloOk?.({}), 0); }
  stop() { this.stopped = true; }
  request(method, params) {
    b.calls.push(method);
    return b.handlers[method] ? b.handlers[method](params) : new Promise(() => {});
  }
}
`,
  );
  return root;
}

export const stubGateway = () => (globalThis.__kvGw ??= { clients: [], calls: [], handlers: {}, silent: false });
