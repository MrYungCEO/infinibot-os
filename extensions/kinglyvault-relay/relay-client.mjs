#!/usr/bin/env node
// KinglyVault Connect — the InfiniBot side of the relay.
//
// Your InfiniBot opens ONE outbound HTTPS long-poll to KinglyVault's
// infinibot-relay function. No open ports, no tunnel, works behind NAT, VPNs
// and Tailscale. KinglyVault queues requests (chat, spawn a coder, navigate the
// UI); this client verifies each one and runs it against YOUR local gateway,
// under YOUR gateway's tool policy, then posts the result back.
//
// Runs two ways:
//   1. Standalone (no gateway restart):  node relay-client.mjs <command>
//   2. In-process as the kinglyvault-relay plugin service (index.ts).
//
// Commands:
//   connect <CODE> [--yes] [--scopes chat,coder.spawn] [--name "My desktop"] [--relay URL]
//   run                 keep the link open (what the service does)
//   status              local state + the link's health in KinglyVault
//   audit [--remote]    what KinglyVault asked this InfiniBot to do
//   pause | resume      local kill switch (refuse every relayed request)
//   allow-dir <path>    let KV-started coders work in this folder
//   disconnect          revoke on both sides and wipe local secrets
//
// Security (see docs/infinibot-connect/SECURITY.md in KinglyVault):
//   - You approve the pairing here, scope by scope. This client generates the
//     scoped token; KV only stores it sealed and uses it to sign envelopes.
//   - Every envelope is checked: HMAC-SHA256 signature, timestamp (±120 s),
//     one-time nonce, and that its scope is one YOU granted. Unknown actions
//     are refused. There is no shell/exec action at all.
//   - Coders run through InfiniBot's own coder tools, only in folders you
//     allowed (allow-dir), with your InfiniBot permission settings.
//   - Secrets live in ~/.infinibot/kinglyvault-relay/state.json (mode 0600).

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliSessionManager, CliSessionStore } from './cli-sessions.mjs';
import { CODER_BACKEND_PROVIDER, brainLabel, brainsDigest, collectBrains, instanceKind, resolveBrainChoice } from './brains.mjs';
import { uiHub } from './kv-ui.mjs';
import { approvalView, buildTaskText, BUILD_TOOLS, createWorkspace, fitList, TASK_STATUSES, taskView } from './kv-workspace.mjs';

export const VERSION = '0.2.0';
export const PROTOCOL = 'kvrelay.v1';
export const DEFAULT_RELAY_URL = 'https://cxwswtnpmjuftqmaqzae.supabase.co/functions/v1/infinibot-relay';
const SCOPES = [
  'chat',
  'agents.spawn',
  'coder.spawn',
  'ui.navigate',
  'kv.read',
  'kv.write',
  'kv.admin',
  // Agent C: InfiniBot work shown inside KinglyVault (kv-workspace.mjs)
  'outputs.read',
  'tasks.manage',
  'files.read',
  'approvals.manage',
  // Agent E: the KV page you have open (kv-ui.mjs)
  'ui.control',
];
const SCOPE_TEXT = {
  chat: 'Chat with your gateway agents from KinglyVault',
  'agents.spawn': 'Start InfiniBot sub-agents (KV asks you first each time)',
  'coder.spawn': 'Start Claude Code / Codex / OpenCode coders in folders you allow (KV asks first)',
  'ui.navigate': 'Open pages / highlight controls in your InfiniBot UI',
  // Agent D: kv.read also covers your learning progress and saving notes/outputs to your own "From your InfiniBot" list in KV.
  'kv.read': 'Give your agents read access to your KinglyVault data and learning progress (kv-mcp), and let them save notes/outputs to your own "From your InfiniBot" list',
  'kv.write': 'Let your agents create, edit and delete your own KinglyVault data, as you (never payments)',
  'kv.admin': 'Give your agents your KinglyVault admin tools (audit-logged; no payments, refunds or deleting users)',
  'outputs.read': 'Show what your agents made (sites, docs, images, carousels) inside KinglyVault',
  'tasks.manage': 'List your tasks and update their status, title, priority or due date from KinglyVault',
  'files.read': 'Browse and read files only inside the folders you allow for KinglyVault',
  'approvals.manage': 'See what InfiniBot is waiting on and approve or deny it from KinglyVault',
  'ui.control': 'While KinglyVault is open, let your agents use that page in front of you (never payments, sign-out, passwords or card fields)',
};
// action → scopes that authorize it (mirrors KV's RELAY_ACTIONS; checked again here).
const ACTIONS = {
  ping: ['chat', 'agents.spawn', 'coder.spawn', 'ui.navigate', 'kv.read', 'outputs.read', 'tasks.manage', 'files.read', 'approvals.manage'],
  'agents.list': ['chat', 'agents.spawn', 'coder.spawn'],
  'chat.send': ['chat'],
  'agents.spawn': ['agents.spawn'],
  'coder.spawn': ['coder.spawn'],
  'run.wait': ['agents.spawn', 'coder.spawn'],
  'ui.navigate': ['ui.navigate'],
  'kv.context': ['kv.read'],
  // Upgrade access: KV asks this device to fetch its new kv-mcp token. Any granted scope authorizes it.
  'kv.token.refresh': ['chat', 'agents.spawn', 'coder.spawn', 'ui.navigate', 'kv.read', 'kv.write'],
  // Persistent sessions (cli-sessions.mjs). The device re-checks the scope
  // against the session's kind: CLI + helper sessions need coder.spawn
  // (helpers: or agents.spawn), gateway-agent sessions need chat.
  'cli.sessions.list': ['coder.spawn', 'chat'],
  'cli.sessions.history': ['coder.spawn', 'chat', 'agents.spawn'],
  'cli.sessions.create': ['coder.spawn', 'chat'],
  'cli.sessions.send': ['coder.spawn', 'chat', 'agents.spawn'],
  'cli.sessions.stop': ['coder.spawn', 'chat', 'agents.spawn'],
  'cli.sessions.rename': ['coder.spawn', 'chat', 'agents.spawn'],
  'cli.sessions.archive': ['coder.spawn', 'chat', 'agents.spawn'],
  // ── Agent B (inference routing) ──
  // The models / providers this InfiniBot can run right now (names + availability only).
  'brains.list': ['chat', 'agents.spawn', 'coder.spawn'],
  // ── Agent C: outputs, tasks, files, approvals (kv-workspace.mjs) ──
  'outputs.list': ['outputs.read'],
  'outputs.get': ['outputs.read'],
  'outputs.fetch': ['outputs.read'],
  'outputs.build': ['agents.spawn'],
  'tasks.list': ['tasks.manage'],
  'tasks.update': ['tasks.manage'],
  'files.list': ['files.read'],
  'files.read': ['files.read'],
  'approvals.list': ['approvals.manage'],
  'approvals.resolve': ['approvals.manage'],
  // ── Agent E: the KV page channel (kv-ui.mjs) ──
  'ui.session': ['ui.control'],
  'ui.result': ['ui.control'],
  'panels.refresh': ['chat', 'ui.control'],
};
/** Advertised to KV on each pull so it only shows what this InfiniBot can do. */
export const RELAY_FEATURES = ['kv-workspace', 'kv-ui'];
const CODER_TOOLS = { 'claude-code': 'claude_coder', codex: 'codex_coder', opencode: 'opencode_coder' };
const CLOCK_SKEW_MS = 120_000;
export const INTENT_RE = /^[A-Za-z0-9_-]{24,100}$/;
const ROTATE_EVERY_MS = 12 * 3600_000;
const GATEWAY_CONNECT_TIMEOUT_MS = 30_000;
const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
// coder.backends.list probes every CLI and has taken 29 s on a busy gateway.
const CAPS_TIMEOUT_MS = 45_000;
const CAPS_REFRESH_MS = 5 * 60_000;
const CAPS_RETRY_MS = 30_000;
const CAPS_FIRST_WAIT_MS = 5_000;
const PULL_WAIT_MS = 20_000;
const PULL_TIMEOUT_MS = 30_000;
const PULL_WATCHDOG_MS = 90_000;
const PAUSED_RETRY_MAX_MS = 30_000;
const CLAUDE_MCP_TIMEOUT_MS = 30_000;

// ── paths / state ──────────────────────────────────────────────────────

export function stateDir() {
  return process.env.INFINIBOT_STATE_DIR || path.join(os.homedir(), '.infinibot');
}
export function relayDir() {
  return path.join(stateDir(), 'kinglyvault-relay');
}
const statePath = () => path.join(relayDir(), 'state.json');
const policyPath = () => path.join(relayDir(), 'policy.json');
const auditPath = () => path.join(relayDir(), 'audit.jsonl');
const healthPath = () => path.join(relayDir(), 'health.json');
const revokePendingPath = () => path.join(relayDir(), 'revoke-pending.json');
export const workspacesDir = () => path.join(relayDir(), 'workspaces');

function ensureDir() {
  fs.mkdirSync(relayDir(), { recursive: true, mode: 0o700 });
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveState(s) {
  ensureDir();
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, statePath());
}

// ── install fingerprint (one KinglyVault row per device) ───────────────
// A random id made once per install and kept across disconnects (it is not a
// secret credential: it only lets KinglyVault reuse this device's row when
// the SAME member links it again, instead of adding a duplicate). KV stores
// only a hash of it.

const fingerprintPath = () => path.join(relayDir(), 'device-id');

export function deviceFingerprint() {
  try {
    const v = fs.readFileSync(fingerprintPath(), 'utf8').trim();
    if (/^[A-Za-z0-9_-]{24,200}$/.test(v)) return v;
  } catch {
    /* first link on this install */
  }
  const v = randomBytes(32).toString('base64url');
  try {
    ensureDir();
    fs.writeFileSync(fingerprintPath(), v, { mode: 0o600 });
  } catch {
    /* read-only state dir: still link, just without reuse */
  }
  return v;
}

function wipeState() {
  try {
    fs.rmSync(statePath());
  } catch {
    /* already gone */
  }
}

// ── link health (what the UI shows as "last sync" / the plain-English error) ──
// Written by whichever process runs the link (plugin service or standalone),
// at most every 30 s while healthy. Never contains a secret.

let lastHealthWrite = 0;
export function loadHealth() {
  try {
    return JSON.parse(fs.readFileSync(healthPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function recordHealth(patch, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastHealthWrite < 30_000) return;
  lastHealthWrite = now;
  try {
    ensureDir();
    const prev = loadHealth() || {};
    fs.writeFileSync(healthPath(), JSON.stringify({ ...prev, ...patch, pid: process.pid, at: new Date(now).toISOString() }), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/** Turns relay / network failures into something a member can act on. */
export function friendlyError(e) {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
  if (e?.name === 'AbortError' || /aborted|timeout/i.test(raw)) return 'KinglyVault took too long to answer. InfiniBot keeps retrying.';
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network/i.test(raw + code)) {
    return 'Can’t reach KinglyVault. Check this computer’s internet connection; InfiniBot keeps retrying by itself.';
  }
  if (/rate_limited|Too many/i.test(raw)) return 'Too many tries in a short time. Wait a few minutes, then try again.';
  if (/relay_disabled|paused by KinglyVault/i.test(raw)) return 'KinglyVault has paused InfiniBot Connect for now. Try again later.';
  if (/not_configured/i.test(raw)) return 'KinglyVault Connect is not set up on the server yet.';
  if (/revoked/i.test(raw)) return 'This link was removed in KinglyVault. Connect again to re-link.';
  if (/server_error|HTTP 5\d\d| 5\d\d\)/i.test(raw)) return 'KinglyVault had a problem on its side. InfiniBot will try again shortly.';
  return raw || 'Something went wrong talking to KinglyVault.';
}

export function loadPolicy() {
  let p = {};
  try {
    p = JSON.parse(fs.readFileSync(policyPath(), 'utf8'));
  } catch {
    /* defaults */
  }
  const dirs = Array.isArray(p.allowedWorkdirs) ? p.allowedWorkdirs.filter((d) => typeof d === 'string') : [];
  return { allowedWorkdirs: [workspacesDir(), ...dirs.filter((d) => d !== workspacesDir())] };
}

function savePolicy(p) {
  ensureDir();
  fs.writeFileSync(policyPath(), JSON.stringify({ allowedWorkdirs: p.allowedWorkdirs.filter((d) => d !== workspacesDir()) }, null, 2), { mode: 0o600 });
}

export function localAudit(entry) {
  try {
    ensureDir();
    fs.appendFileSync(auditPath(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

// ── crypto ────────────────────────────────────────────────────────────

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function canonicalEnvelope(e) {
  return [PROTOCOL, e.id, e.nonce, String(e.ts), e.action, e.paramsSha256].join('\n');
}

export function signEnvelope(e, token) {
  return createHmac('sha256', token).update(canonicalEnvelope({ ...e, paramsSha256: sha256(e.paramsJson) })).digest('hex');
}

const seenNonces = new Map(); // nonce → expiry ms

/** Verifies an envelope from KV. Returns { ok, params } or { ok:false, reason }. */
export function verifyEnvelope(env, state, now = Date.now()) {
  if (!env || typeof env !== 'object') return { ok: false, reason: 'malformed' };
  for (const k of ['id', 'nonce', 'action', 'paramsJson', 'sig', 'scope']) {
    if (typeof env[k] !== 'string' || !env[k]) return { ok: false, reason: `missing ${k}` };
  }
  if (typeof env.ts !== 'number') return { ok: false, reason: 'missing ts' };
  const expected = Buffer.from(signEnvelope(env, state.token), 'hex');
  const got = Buffer.from(env.sig, 'hex');
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, reason: 'bad signature' };
  if (Math.abs(now - env.ts) > CLOCK_SKEW_MS) return { ok: false, reason: 'stale envelope' };
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (seenNonces.has(env.nonce)) return { ok: false, reason: 'replayed nonce' };
  seenNonces.set(env.nonce, now + 2 * CLOCK_SKEW_MS);
  const allowed = ACTIONS[env.action];
  if (!allowed) return { ok: false, reason: `unknown action ${env.action}` };
  const granted = new Set(state.grantedScopes || []);
  if (!allowed.includes(env.scope) || !granted.has(env.scope)) return { ok: false, reason: `scope ${env.scope} not granted here` };
  let params;
  try {
    params = JSON.parse(env.paramsJson);
  } catch {
    return { ok: false, reason: 'bad params' };
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, reason: 'bad params' };
  return { ok: true, params };
}

/** Resolves a requested coder folder against the local allowlist. */
export function resolveWorkdir(requested, policy = loadPolicy()) {
  const roots = policy.allowedWorkdirs.map((d) => path.resolve(d));
  if (!requested) {
    fs.mkdirSync(roots[0], { recursive: true, mode: 0o700 });
    return { ok: true, dir: roots[0] };
  }
  let real;
  try {
    real = fs.realpathSync(path.resolve(requested));
  } catch {
    return { ok: false, reason: `folder ${requested} does not exist on this InfiniBot` };
  }
  for (const r of roots) {
    let rr;
    try {
      rr = fs.realpathSync(r);
    } catch {
      continue;
    }
    if (real === rr || real.startsWith(rr + path.sep)) return { ok: true, dir: real };
  }
  return { ok: false, reason: `folder ${requested} is not allowed. Run: node relay-client.mjs allow-dir ${requested}` };
}

// ── relay HTTP ────────────────────────────────────────────────────────

export async function relayCall(url, body, bearer, { timeoutMs = 40_000, signal } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    // A body cut off by the abort must not read as an empty 200.
    if (ctl.signal.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ── local gateway (persistent WS, reuses InfiniBot's own client) ──────

function findInfinibotRoot(explicit) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, process.env.INFINIBOT_ROOT, path.resolve(here, '..', '..')].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'dist', 'gateway', 'client.js'))) return c;
  throw new Error('Could not find the InfiniBot install (set INFINIBOT_ROOT to the folder that has dist/gateway/client.js).');
}

let gatewayOverride = null;
/**
 * In-process (plugin) use: the gateway's own port + auth, so JSON5 configs,
 * custom ports and --password/--token flags work. Pass an object or a function
 * (resolved at connect time: CLI flags land in the env after plugins register).
 */
export function setGatewayConnection(o) {
  gatewayOverride = o && (typeof o === 'object' || typeof o === 'function') ? o : null;
}

function readGatewayConfig() {
  const o = typeof gatewayOverride === 'function' ? gatewayOverride() : gatewayOverride;
  if (o?.url) return { uiUrl: process.env.INFINIBOT_PUBLIC_UI_URL || null, ...o };
  const file = process.env.INFINIBOT_CONFIG_PATH || path.join(stateDir(), 'infinibot.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* JSON5 / missing: fall back to env */
  }
  return {
    url: process.env.INFINIBOT_GATEWAY_URL || `ws://127.0.0.1:${process.env.INFINIBOT_GATEWAY_PORT || cfg?.gateway?.port || 18789}`,
    token: process.env.INFINIBOT_GATEWAY_TOKEN || cfg?.gateway?.auth?.token || undefined,
    password: process.env.INFINIBOT_GATEWAY_PASSWORD || cfg?.gateway?.auth?.password || undefined,
    uiUrl: process.env.INFINIBOT_PUBLIC_UI_URL || null,
  };
}

export class LocalGateway {
  constructor({ root, log = console, connectTimeoutMs = GATEWAY_CONNECT_TIMEOUT_MS, requestTimeoutMs = GATEWAY_REQUEST_TIMEOUT_MS } = {}) {
    this.root = findInfinibotRoot(root);
    this.log = log;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.client = null;
    this.ready = null;
    this.attempt = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.listeners = new Set();
  }

  // this.ready is set before the first await: otherwise concurrent callers each
  // build a client, and all but the last keep reconnecting forever.
  connect() {
    if (this.closed) return Promise.reject(new Error('gateway link stopped'));
    if (this.ready) return this.ready;
    const attempt = {};
    this.attempt = attempt;
    const ready = this.open(attempt).catch((e) => {
      if (this.ready === ready) this.ready = null;
      throw e;
    });
    this.ready = ready;
    return ready;
  }

  async open(attempt) {
    const { GatewayClient } = await import(pathToFileURL(path.join(this.root, 'dist/gateway/client.js')).href);
    const { loadOrCreateDeviceIdentity } = await import(pathToFileURL(path.join(this.root, 'dist/infra/device-identity.js')).href);
    const { PROTOCOL_VERSION } = await import(pathToFileURL(path.join(this.root, 'dist/gateway/protocol/index.js')).href);
    if (attempt !== this.attempt) throw new Error('gateway connection replaced');
    const gw = readGatewayConfig();
    this.uiUrl = gw.uiUrl;
    return new Promise((resolve, reject) => {
      let client = null;
      const lost = (err) => {
        clearTimeout(timer);
        reject(err);
        const current = this.client === client;
        this.drop(client);
        if (current) this.reconnectForListeners();
      };
      const timer = setTimeout(() => lost(new Error('local gateway did not answer')), this.connectTimeoutMs);
      client = new GatewayClient({
        url: gw.url,
        token: gw.token,
        password: gw.password,
        instanceId: randomUUID(),
        clientName: 'gateway-client',
        clientDisplayName: 'KinglyVault Connect',
        clientVersion: VERSION,
        mode: 'backend',
        role: 'operator',
        scopes: ['operator.admin'],
        deviceIdentity: loadOrCreateDeviceIdentity(),
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        onEvent: (evt) => {
          for (const l of this.listeners) {
            try {
              l(evt);
            } catch {
              /* listener bug must not kill the socket */
            }
          }
        },
        onHelloOk: () => {
          clearTimeout(timer);
          resolve(this);
        },
        onConnectError: (e) => this.log.warn?.(`[kv-relay] gateway connect error: ${e.message}`),
        onClose: (code, reason) => {
          this.log.warn?.(`[kv-relay] gateway socket closed (${code}) ${reason || ''}`);
          lost(new Error(`gateway socket closed (${code})`));
        },
      });
      this.client = client;
      client.start();
    });
  }

  /** Forgets a client for good (GatewayClient would otherwise keep reconnecting), so the next request opens a fresh one. */
  drop(client) {
    try {
      client?.stop();
    } catch {
      /* closing */
    }
    if (client && this.client === client) {
      this.client = null;
      this.ready = null;
      this.attempt = null;
    }
  }

  // A chat turn waits for events, not a response: without a socket it would
  // only notice after 9 minutes, so reconnect without waiting for a request.
  reconnectForListeners() {
    if (this.closed || this.reconnectTimer || !this.listeners.size) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.listeners.size) this.connect().catch(() => {});
    }, 1000);
    this.reconnectTimer.unref?.();
  }

  async request(method, params, opts) {
    const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
    const call = async () => {
      await this.connect();
      if (!this.client) throw new Error('gateway not connected');
      return this.client.request(method, params, { ...opts, timeoutMs });
    };
    // Bounded here too: a standalone link can run against an older dist whose client ignores timeoutMs.
    return withTimeout(call(), timeoutMs, `gateway request ${method}`);
  }

  /** Runs a gateway tool through the gateway's own policy (same path the InfiniBot MCP bridge uses). */
  async tool(tool, args, sessionKey) {
    const res = await this.request('agent.tools.invoke', { tool, args, sessionKey, source: 'kinglyvault-relay' }, { timeoutMs: 120_000 });
    return unwrapTool(res);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Drops the socket; the next request connects again. In-flight requests reject. */
  reset() {
    this.attempt = null;
    this.ready = null;
    this.drop(this.client);
  }

  stop() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reset();
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function unwrapTool(res) {
  const r = res && typeof res === 'object' ? res : {};
  const inner = r.result && typeof r.result === 'object' ? r.result : r;
  if (inner.details !== undefined) return inner.details;
  const text = Array.isArray(inner.content) ? inner.content.find((c) => c?.type === 'text')?.text : undefined;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return inner;
}

// ── kv-mcp (the member's KinglyVault data, as them) ───────────────────

export async function kvMcpCall(state, name, args) {
  if (!state.kvMcp?.token) throw new Error('kv.read was not granted on this InfiniBot.');
  const res = await fetch(state.kvMcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${state.kvMcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.message || 'kv-mcp error');
  const r = data.result || {};
  if (r.structuredContent) return r.structuredContent;
  const text = Array.isArray(r.content) ? r.content.find((c) => c?.type === 'text')?.text : undefined;
  try {
    return text ? JSON.parse(text) : r;
  } catch {
    return { text };
  }
}

/** Every kv-mcp tool this link's token may use, optionally filtered by a word in the name or description. */
export async function kvMcpTools(state, query) {
  if (!state.kvMcp?.token) throw new Error('kv.read was not granted on this InfiniBot.');
  const res = await fetch(state.kvMcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${state.kvMcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.message || 'kv-mcp error');
  const q = String(query || '').trim().toLowerCase();
  return (data.result?.tools || [])
    .filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, readOnly: t.annotations?.readOnlyHint !== false }));
}

/**
 * Upgrade access: fetch the freshly minted kv-mcp token and apply it live.
 * Gateway agents read state.json on every call and Claude Code is re-registered
 * here, so no restart. Only kvMcp + grantedScopes change, on the newest state,
 * so a rotation in the pull loop is never overwritten.
 */
export async function refreshKvToken(state, log = console) {
  const r = await relayCall(state.relayUrl, { op: 'device.kv.refresh' }, state.deviceSecret, { timeoutMs: 30_000 });
  if (r.status !== 200 || !r.data?.kvMcp?.token) throw new Error(r.data?.message || r.data?.error || `Token refresh failed (${r.status}).`);
  const next = { ...(loadState() || state), kvMcp: r.data.kvMcp, grantedScopes: r.data.grantedScopes || state.grantedScopes };
  saveState(next);
  localAudit({ actor: 'kv', action: 'kv.token.refresh', scopes: next.grantedScopes });
  await registerClaudeMcp(next, log);
  return { refreshed: true, scopes: next.grantedScopes };
}

/** Registers kv-mcp in Claude Code (user scope) so KV-started coders can read KV data. */
function registerClaudeMcp(state, log) {
  if (!state.kvMcp?.token || process.env.KV_RELAY_SKIP_CLAUDE_MCP === '1') return Promise.resolve(false);
  const entry = JSON.stringify({ type: 'http', url: state.kvMcp.url, headers: { Authorization: `Bearer ${state.kvMcp.token}` } });
  return new Promise((resolve) => {
    execFile('claude', ['mcp', 'remove', 'kinglyvault', '-s', 'user'], { timeout: CLAUDE_MCP_TIMEOUT_MS }, () => {
      execFile('claude', ['mcp', 'add-json', 'kinglyvault', entry, '-s', 'user'], { timeout: CLAUDE_MCP_TIMEOUT_MS }, (err) => {
        if (err) log.warn?.(`[kv-relay] could not register kv-mcp with Claude Code: ${err.message.split('\n')[0]}`);
        resolve(!err);
      });
    });
  });
}

function unregisterClaudeMcp() {
  // Same switch as registering: a side/test InfiniBot on a shared machine must
  // not remove the real link's Claude Code entry.
  if (process.env.KV_RELAY_SKIP_CLAUDE_MCP === '1') return Promise.resolve();
  return new Promise((resolve) => execFile('claude', ['mcp', 'remove', 'kinglyvault', '-s', 'user'], { timeout: CLAUDE_MCP_TIMEOUT_MS }, () => resolve()));
}

// ── action handlers ───────────────────────────────────────────────────

function sessionKeyFor(state, agentId, threadId) {
  const conn = String(state.connectionId || 'kv').slice(0, 8);
  return `agent:${agentId}:kv-${conn}${threadId ? `-${String(threadId).slice(0, 24)}` : ''}`;
}

/**
 * KV-triggered tool calls run in a dedicated KV session of an agent, so they
 * follow THAT agent's tool policy (your InfiniBot permission settings) and
 * show up on the activity map as KinglyVault work. Defaults to "main".
 */
function toolSession(state, agentId) {
  return sessionKeyFor(state, agentId || process.env.KV_RELAY_TOOL_AGENT || state.toolAgent || 'main');
}

// ── brains (Agent B: inference routing) ─────────────────────────────────
// KV runs every AI feature on THIS InfiniBot with ITS models; the catalogue is
// re-read every minute (and right after a settings/models change event) and
// rides on every device.pull, so KV's picker stays current.
const BRAINS_TTL_MS = 60_000;
const BRAINS_READ_TIMEOUT_MS = 25_000;
let brainsCache = { catalog: null, at: 0, digest: '', inflight: null };

export function markBrainsStale() {
  brainsCache.at = 0;
}

/** Tests: drop the cached catalogue. */
export function resetBrainsForTests(catalog = null) {
  brainsCache = { catalog, at: catalog ? Date.now() : 0, digest: brainsDigest(catalog), inflight: null };
}

export async function currentBrains(gw, { force = false } = {}) {
  if (!force && brainsCache.catalog && Date.now() - brainsCache.at < BRAINS_TTL_MS) return brainsCache.catalog;
  if (brainsCache.inflight) return brainsCache.inflight;
  // Bounded: every caller shares this promise, so one that never settles would hang every chat.
  brainsCache.inflight = withTimeout(collectBrains(gw, { kind: isCloudMachine() ? 'cloud' : instanceKind() }), BRAINS_READ_TIMEOUT_MS, 'brains read')
    .then((catalog) => {
      if (catalog) brainsCache = { catalog, at: Date.now(), digest: brainsDigest(catalog), inflight: null };
      else brainsCache.inflight = null;
      return brainsCache.catalog;
    })
    .catch(() => {
      brainsCache.inflight = null;
      return brainsCache.catalog;
    });
  return brainsCache.inflight;
}

/**
 * Points one gateway session at the model KV asked for. Unknown / unavailable
 * models fall back to this InfiniBot's default with a notice, or fail with a
 * clear error when KV sent strictModel. Old KV clients send no model: the
 * session is left exactly as it was.
 */
export async function applySessionBrain(gw, sessionKey, params, emit = async () => {}) {
  const catalog = await currentBrains(gw).catch(() => null);
  const choice = resolveBrainChoice(catalog, params);
  if (choice.kind === 'none') return null;
  const defaultRef = catalog?.default?.ref || null;
  let reason = choice.kind === 'unavailable' ? choice.reason : null;
  if (choice.kind === 'ok') {
    try {
      await gw.request('sessions.patch', { key: sessionKey, model: choice.ref }, { timeoutMs: 20_000 });
      return { ref: choice.ref, label: brainLabel(catalog, choice.ref), fallback: false };
    } catch (e) {
      reason = `${brainLabel(catalog, choice.ref)} was refused here (${String(e?.message || e).slice(0, 160)}).`;
    }
  }
  if (reason && params.strictModel === true) throw new Error(`${reason} Pick another model, or use this InfiniBot's default.`);
  await gw.request('sessions.patch', { key: sessionKey, model: null }, { timeoutMs: 20_000 }).catch(() => {});
  if (choice.kind === 'default') return { ref: defaultRef, label: brainLabel(catalog, defaultRef), fallback: false };
  const notice = `${reason} Using ${brainLabel(catalog, defaultRef)} instead.`;
  await emit([{ type: 'progress', text: notice, data: { brainFallback: true } }]);
  return { ref: defaultRef, label: brainLabel(catalog, defaultRef), fallback: true, requested: choice.label, reason, notice };
}

/** A model for sessions_spawn ("provider/model"), or undefined = the agent's default. */
async function spawnBrain(gw, params, emit) {
  const catalog = await currentBrains(gw).catch(() => null);
  const choice = resolveBrainChoice(catalog, params);
  if (choice.kind === 'ok') return { model: choice.ref, brain: { ref: choice.ref, label: brainLabel(catalog, choice.ref), fallback: false } };
  if (choice.kind !== 'unavailable') return { model: undefined, brain: null };
  if (params.strictModel === true) throw new Error(`${choice.reason} Pick another model, or use this InfiniBot's default.`);
  const notice = `${choice.reason} Using ${brainLabel(catalog, catalog?.default?.ref)} instead.`;
  await emit([{ type: 'progress', text: notice, data: { brainFallback: true } }]);
  return { model: undefined, brain: { ref: catalog?.default?.ref || null, fallback: true, requested: choice.label, reason: choice.reason, notice } };
}

/** The coder CLI's own model flag (claude_coder `model`), validated against the backend's CLI brain. */
async function coderBrain(gw, backend, params, emit) {
  if (!params.model && !params.provider) return { model: undefined, brain: null };
  const provider = CODER_BACKEND_PROVIDER[backend];
  if (params.provider && params.provider !== provider) {
    const reason = `${params.provider} models can't drive the ${backend} coder.`;
    if (params.strictModel === true) throw new Error(reason);
    await emit([{ type: 'progress', text: `${reason} Using its default model.`, data: { brainFallback: true } }]);
    return { model: undefined, brain: { ref: null, fallback: true, requested: `${params.provider}/${params.model || 'default'}`, reason } };
  }
  const catalog = await currentBrains(gw).catch(() => null);
  const choice = resolveBrainChoice(catalog, { provider, model: params.model || 'default' });
  if (choice.kind === 'ok') return { model: choice.model === 'default' ? undefined : choice.model, brain: { ref: choice.ref, label: brainLabel(catalog, choice.ref), fallback: false } };
  if (params.strictModel === true) throw new Error(choice.reason);
  await emit([{ type: 'progress', text: `${choice.reason} Using its default model.`, data: { brainFallback: true } }]);
  return { model: undefined, brain: { ref: null, fallback: true, requested: choice.label, reason: choice.reason } };
}

/** Each list falls back to `previous`, so a slow gateway never blanks what KV shows. `complete` = both answered. */
async function readCapabilities(gw, previous = null, timeoutMs = CAPS_TIMEOUT_MS) {
  const [agents, backends, catalog] = await Promise.all([
    gw.request('agents.list', {}, { timeoutMs }).catch(() => null),
    gw.request('coder.backends.list', {}, { timeoutMs }).catch(() => null),
    // Bounded like the two above: a wedged gateway must not stall the capability refresh.
    withTimeout(currentBrains(gw), timeoutMs, 'brains read').catch(() => null),
  ]);
  return {
    complete: !!agents && !!backends,
    caps: {
      agents: agents ? (agents.agents || []).map((a) => ({ id: a.id, name: a.name || a.id, model: a.model || null, default: a.id === agents.defaultId })) : previous?.agents || [],
      coderBackends: backends ? (backends.backends || []).map((b) => ({ id: b.id, name: b.displayName || b.id, installed: !!b.install?.installed })) : previous?.coderBackends || [],
      ...(gw.uiUrl ? { uiUrl: gw.uiUrl } : {}),
      // Agent B: what this InfiniBot can run (names + availability only, no secrets).
      instanceKind: isCloudMachine() ? 'cloud' : instanceKind(),
      ...(catalog || previous?.brains ? { brains: catalog || previous.brains } : {}),
      // Agent C: tells KV this InfiniBot answers outputs / tasks / files / approvals.
      features: RELAY_FEATURES,
    },
  };
}

async function listCapabilities(gw) {
  return (await readCapabilities(gw)).caps;
}

/**
 * Runs one verified request. `emit(events, partial)` streams progress.
 * Returns the result object or throws.
 */
export async function runAction(action, params, { gw, state, emit, scope, policy = loadPolicy() }) {
  switch (action) {
    case 'ping':
      return { pong: true, version: VERSION, at: new Date().toISOString() };

    case 'agents.list':
      return listCapabilities(gw);

    case 'chat.send': {
      const sessionKey = sessionKeyFor(state, params.agentId, params.threadId);
      const brain = await applySessionBrain(gw, sessionKey, params, emit);
      const message = params.context ? `[KinglyVault context]\n${params.context}\n\n[Message]\n${params.message}` : params.message;
      const text = await gatewayChatTurn(gw, sessionKey, message, (t) => void emit([], t));
      return { agentId: params.agentId, sessionKey, text, ...(brain ? { brain } : {}) };
    }

    case 'brains.list':
      return { brains: await currentBrains(gw, { force: true }), instanceKind: isCloudMachine() ? 'cloud' : instanceKind() };

    case 'agents.spawn': {
      const { model, brain } = await spawnBrain(gw, params, emit);
      const out = await gw.tool('sessions_spawn', { task: params.task, ...(params.agentId ? { agentId: params.agentId } : {}), ...(model ? { model } : {}), label: params.label || 'KinglyVault helper' }, toolSession(state, params.agentId));
      const runId = out?.runId || out?.childRunId || null;
      sessionsFor(gw, state).recordHelper({ runId, backend: 'agent', title: params.label || 'KinglyVault helper' });
      return { runId, sessionKey: out?.childSessionKey || out?.sessionKey || null, raw: out, ...(brain ? { brain } : {}) };
    }

    case 'coder.spawn': {
      const wd = resolveWorkdir(params.workdir, policy);
      if (!wd.ok) throw new Error(wd.reason);
      const tool = CODER_TOOLS[params.backend];
      if (!tool) throw new Error('Unknown coder backend.');
      const { model: coderModel, brain } = await coderBrain(gw, params.backend, params, emit);
      const args = {
        task: params.task,
        workdir: wd.dir,
        label: params.label || 'KinglyVault coder',
        ...(tool === 'claude_coder' ? { backend: 'claude-code' } : {}),
        ...(coderModel ? { model: coderModel } : {}),
      };
      await emit([{ type: 'progress', text: `Starting ${params.backend} in ${wd.dir}` }]);
      const out = await gw.tool(tool, args, toolSession(state));
      const runId = out?.runId || out?.run_id || null;
      if (!runId) throw new Error(typeof out?.error === 'string' ? out.error : 'The coder did not start.');
      // One-off helpers (stuck tutor) are intentional; they're labeled and listed with the sessions.
      sessionsFor(gw, state).recordHelper({ runId, backend: params.backend, folder: wd.dir, title: params.label || 'KinglyVault coder' });
      return { runId, backend: params.backend, workdir: wd.dir, ...(brain ? { brain } : {}) };
    }

    case 'run.wait': {
      // verification.wait is the gateway's own verified-completion wait (same data subagents_wait returns).
      const deadline = Date.now() + Math.min(params.timeoutSec || 600, 1700) * 1000;
      let lastState = null;
      while (Date.now() < deadline) {
        const out = await gw.request('verification.wait', { runIds: [params.runId], timeoutSec: 25 }, { timeoutMs: 40_000 });
        const run = (out?.done || [])[0] || (out?.pending || [])[0] || null;
        if (!run && (out?.unknown || []).includes(params.runId)) throw new Error(`InfiniBot has no run ${params.runId}.`);
        const state = run?.state || 'running';
        if (state !== lastState) {
          lastState = state;
          await emit([{ type: 'progress', text: `status: ${state}`, data: { state } }]);
        }
        if ((out?.done || []).length) {
          const review = run.review || {};
          let result = run.result;
          try {
            result = typeof result === 'string' ? JSON.parse(result) : result;
          } catch {
            /* plain text */
          }
          sessionsFor(gw, null).helperFinished(params.runId, { status: state, summary: result && typeof result === 'object' ? result.summary : result });
          return {
            runId: params.runId,
            status: state,
            verdict: review.verdict || String(state).toUpperCase(),
            reasons: Array.isArray(review.reasons) ? review.reasons.slice(0, 8) : [],
            summary: (result && typeof result === 'object' ? result.summary : result) || null,
            label: run.label || null,
            backend: run.backend || null,
            filesChanged: Array.isArray(result?.files_changed) ? result.files_changed.slice(0, 50) : [],
            commits: Array.isArray(review.commits) ? review.commits.slice(0, 20) : [],
          };
        }
      }
      return { runId: params.runId, status: lastState || 'running', verdict: null, timedOut: true };
    }

    case 'ui.session':
      uiHub.bindGateway(gw, state.connectionId);
      return uiHub.attach(params, emit);

    case 'ui.result':
      return uiHub.receive(params);

    case 'panels.refresh':
      return gw.request('chat.panel.refresh', { kind: params.kind, query: params.query || {} });

    case 'ui.navigate': {
      const sk = toolSession(state);
      const nav = await gw.tool('ui_control', { action: 'navigate', route: params.route }, sk);
      let highlight = null;
      if (params.label) highlight = await gw.tool('ui_control', { action: 'highlight', query: params.label, text: params.label }, sk).catch((e) => ({ error: e.message }));
      return { route: params.route, nav, highlight };
    }

    case 'kv.context': {
      if (params.kind === 'whoami') return kvMcpCall(state, 'kv_whoami', {});
      // ── Agent D: current course/lesson, path, goal and progress (KV → InfiniBot shared memory).
      if (params.kind === 'learning') return kvMcpCall(state, 'kv_learning_context', {});
      if (params.kind === 'lesson') return kvMcpCall(state, 'kv_get_lesson', { id: params.id, include_quiz: false, max_chars: 6000 });
      if (params.kind === 'course') return kvMcpCall(state, 'kv_get_course', { id: params.id, max_chars: 6000 });
      return kvMcpCall(state, 'kv_get_project', { id: params.id });
    }

    // ── Agent C ──
    case 'outputs.list':
      return workspaceFor(policy).list({ kind: params.kind, limit: numOr(params.limit, 50) });
    case 'outputs.get':
      return workspaceFor(policy).get(String(params.id || ''));
    case 'outputs.fetch':
      return workspaceFor(policy).fetchFile(String(params.id || ''), { file: params.file ? String(params.file) : undefined, offset: numOr(params.offset, 0), inline: params.inline === true });
    case 'outputs.build':
      return buildOutput(params, { gw, state, emit, policy });
    case 'files.list':
      return workspaceFor(policy).listFiles(params.path ? String(params.path) : undefined);
    case 'files.read':
      return workspaceFor(policy).readFile(String(params.path || ''), { offset: numOr(params.offset, 0) });
    case 'tasks.list':
      return listTasks(gw, params);
    case 'tasks.update':
      return updateTask(gw, params);
    case 'approvals.list': {
      const out = await gw.request('approvals.list', { status: 'pending', limit: 50 });
      const list = Array.isArray(out?.approvals) ? out.approvals : [];
      const fit = fitList(list.map(approvalView));
      return { approvals: fit.items, pendingCount: list.length, truncated: fit.truncated };
    }
    case 'approvals.resolve': {
      const decision = params.decision === 'approve' ? 'approve' : params.decision === 'deny' ? 'deny' : null;
      if (!decision || !params.id) throw new Error('Approve or deny needs an approval id.');
      const res = await gw.request('approvals.resolve', {
        id: String(params.id),
        action: decision,
        ...(params.note ? { note: String(params.note).slice(0, 500) } : {}),
        by: `KinglyVault (${state.account || 'member'})`,
      });
      if (res && res.ok === false) {
        const why = res.error === 'already_resolved' ? 'This was already answered.' : res.error === 'not_found' ? 'InfiniBot no longer has this request.' : res.error === 'option_not_allowed' ? 'This one can only be approved on your InfiniBot.' : String(res.error || 'InfiniBot refused.');
        throw new Error(why);
      }
      const rec = res?.record || res;
      return { id: String(params.id), decision, status: rec?.status || (decision === 'approve' ? 'approved' : 'denied') };
    }
    case 'kv.token.refresh':
      return refreshKvToken(state);

    default:
      if (action.startsWith('cli.sessions.')) return runSessionAction(action, params, { gw, state, emit, scope, policy });
      throw new Error(`Unsupported action ${action}`);
  }
}

// ── Agent C: outputs / files / tasks ─────────────────────────────────

const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Outputs live in the relay workspace; files.* see the folders allowed for KV. */
export function workspaceFor(policy = loadPolicy()) {
  return createWorkspace({ outputsRoot: path.join(workspacesDir(), 'outputs'), roots: () => policy.allowedWorkdirs });
}

/** "Build with my InfiniBot": a new output folder + an agent run that fills it. */
async function buildOutput(params, { gw, state, emit, policy }) {
  if (!BUILD_TOOLS.includes(params.tool)) throw new Error('Unknown Create tool.');
  const title = String(params.title || '').trim().slice(0, 120) || 'Untitled';
  const spec = String(params.spec || '').slice(0, 8000);
  if (!spec.trim()) throw new Error('Describe what to build first.');
  const ws = workspaceFor(policy);
  const out = ws.createBuild({ tool: params.tool, title, spec });
  await emit([{ type: 'progress', text: `Building "${title}" on your InfiniBot` }]);
  let spawned;
  try {
    spawned = await gw.tool(
      'sessions_spawn',
      {
        task: buildTaskText({ tool: params.tool, title, spec, dir: out.dir }),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        // The member's model pick from KV ("provider/model"); the gateway validates it.
        ...(typeof params.model === 'string' && params.model ? { model: params.provider ? `${params.provider}/${params.model}` : params.model } : {}),
        label: `KinglyVault build: ${title}`.slice(0, 80),
      },
      toolSession(state, params.agentId),
    );
  } catch (e) {
    ws.updateManifest(out.id, { status: 'failed', error: String(e?.message || e).slice(0, 300) });
    throw e;
  }
  const runId = spawned?.runId || spawned?.childRunId || null;
  if (!runId) {
    ws.updateManifest(out.id, { status: 'failed', error: 'The agent did not start.' });
    throw new Error(typeof spawned?.error === 'string' ? spawned.error : 'The agent did not start.');
  }
  ws.updateManifest(out.id, { runId });
  sessionsFor(gw, state).recordHelper({ runId, backend: 'agent', title: `Build: ${title}` });
  return { outputId: out.id, runId, kind: out.manifest.kind };
}

async function listTasks(gw, params) {
  const [tasks, projects] = await Promise.all([
    gw.request('kanban.tasks.list', params.projectId ? { projectId: String(params.projectId) } : {}),
    gw.request('kanban.projects.list', {}).catch(() => null),
  ]);
  let list = Array.isArray(tasks) ? tasks : Array.isArray(tasks?.tasks) ? tasks.tasks : [];
  if (params.status) list = list.filter((t) => String(t.status).toLowerCase() === String(params.status).toLowerCase());
  // Open work first (newest first), then done.
  const isDone = (t) => String(t.status).toLowerCase() === 'done';
  list = list
    .filter((t) => t && t.id && !t.archived)
    .sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  const plist = Array.isArray(projects) ? projects : Array.isArray(projects?.projects) ? projects.projects : [];
  const limit = Math.min(Math.max(numOr(params.limit, 100), 1), 200);
  const views = list.slice(0, limit).map(taskView);
  // Only name the projects the returned tasks use; the whole result must fit KV's cap.
  const used = new Set(views.map((t) => t.projectId).filter(Boolean));
  const named = plist.filter((p) => used.has(String(p.id))).slice(0, 100).map((p) => ({ id: String(p.id), name: String(p.name || p.title || p.id).slice(0, 80) }));
  const fit = fitList(views, 48_000 - JSON.stringify(named).length);
  return { tasks: fit.items, total: list.length, truncated: fit.truncated, projects: named, statuses: TASK_STATUSES };
}

async function updateTask(gw, params) {
  if (!params.id) throw new Error('Which task?');
  const patch = {};
  if (params.status !== undefined) {
    if (!TASK_STATUSES.includes(String(params.status))) throw new Error('Unknown status.');
    patch.status = String(params.status);
  }
  if (typeof params.title === 'string' && params.title.trim()) patch.title = params.title.trim().slice(0, 300);
  if (typeof params.priority === 'string') patch.priority = params.priority;
  if (params.dueDate === null) patch.dueDate = null;
  else if (typeof params.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.dueDate)) patch.dueDate = params.dueDate;
  if (!Object.keys(patch).length) throw new Error('Nothing to change.');
  const res = await gw.request('kanban.tasks.update', { id: String(params.id), patch });
  return { task: taskView({ id: params.id, ...(res && typeof res === 'object' ? res : {}), ...patch }) };
}

// ── persistent sessions ───────────────────────────────────────────────

/** One gateway chat turn in `sessionKey`; streams the reply text through onText. */
async function gatewayChatTurn(gw, sessionKey, message, onText) {
  const idempotencyKey = randomUUID();
  let lastText = '';
  let lastEmit = 0;
  let runId = null;
  let abandon = () => {};
  const done = new Promise((resolve, reject) => {
    const off = gw.on((evt) => {
      if (evt.event !== 'chat') return;
      const p = evt.payload || {};
      if (p.sessionKey !== sessionKey && !(runId && p.runId === runId)) return;
      const text = Array.isArray(p.message?.content) ? p.message.content.filter((c) => c?.type === 'text').map((c) => c.text).join('') : '';
      if (p.state === 'delta' && text) {
        lastText = text;
        if (Date.now() - lastEmit > 400) {
          lastEmit = Date.now();
          onText(lastText);
        }
      } else if (p.state === 'final') {
        off();
        resolve(text || lastText);
      } else if (p.state === 'error') {
        off();
        reject(new Error(p.errorMessage || 'The agent hit an error.'));
      }
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error('The agent did not reply within 9 minutes.'));
    }, 9 * 60_000);
    timer.unref?.();
    abandon = () => {
      clearTimeout(timer);
      off();
    };
  });
  // Nobody awaits `done` when chat.send fails, and an unhandled rejection exits the gateway.
  done.catch(() => {});
  try {
    const sent = await gw.request('chat.send', { sessionKey, message, idempotencyKey, deliver: false }, { timeoutMs: 60_000 });
    runId = sent?.runId || null;
  } catch (e) {
    abandon();
    throw e;
  }
  return done.finally(abandon);
}

let sessionManager = null;
let sessionCtx = { gw: null, state: null };

/** The process-wide session manager (one per relay link; the store is shared on disk). */
export function sessionsFor(gw, state) {
  if (gw) sessionCtx.gw = gw;
  if (state) sessionCtx.state = state;
  if (!sessionManager) {
    sessionManager = new CliSessionManager({
      store: new CliSessionStore(),
      resolveFolder: (dir) => resolveWorkdir(dir, loadPolicy()),
      isFolderAllowed: (dir) => resolveWorkdir(dir, loadPolicy()).ok,
      agentTurn: (s, message, { onText }) =>
        gatewayChatTurn(sessionCtx.gw, sessionKeyFor(sessionCtx.state || {}, s.agentId, s.id), message, onText).then((text) => ({ text })),
      helperMessage: (s, message) => sessionCtx.gw.tool('subagent_message', { action: 'send', runId: s.runId, message }, toolSession(sessionCtx.state || {})),
    });
  }
  return sessionManager;
}

/** Tests: drop the cached manager (e.g. after switching INFINIBOT_STATE_DIR). */
export function resetSessionsForTests(manager = null) {
  sessionManager = manager;
  sessionCtx = { gw: null, state: null };
}

/** Which granted scope a session kind needs. */
export function scopesForKind(kind) {
  if (kind === 'agent') return ['chat'];
  if (kind === 'helper') return ['coder.spawn', 'agents.spawn'];
  return ['coder.spawn'];
}

function kindOfBackend(backend) {
  return backend === 'agent' ? 'agent' : 'cli';
}

/**
 * cli.sessions.* — the envelope's scope must cover the session's kind, so a
 * link that only granted "chat" can never drive a CLI coder through a session.
 */
export async function runSessionAction(action, params, { gw, state, emit, scope }) {
  const m = sessionsFor(gw, state);
  const granted = new Set(state.grantedScopes || []);
  const allowKind = (kind) => scopesForKind(kind).some((s) => granted.has(s) && (!scope || s === scope));
  const need = (s) => {
    if (!allowKind(s.kind)) throw new Error(`This ${s.kind === 'agent' ? 'agent chat' : 'CLI session'} needs the ${scopesForKind(s.kind).join(' or ')} permission.`);
    return s;
  };
  const visibleKinds = (kind) => scopesForKind(kind).some((s) => granted.has(s));
  switch (action) {
    case 'cli.sessions.list': {
      const out = m.list({ includeArchived: !!params.includeArchived });
      return { ...out, sessions: out.sessions.filter((s) => visibleKinds(s.kind)), folders: loadPolicy().allowedWorkdirs, bypass: m.bypass() };
    }
    case 'cli.sessions.history': {
      const s = m.mustGet(params.id);
      if (!visibleKinds(s.kind)) throw new Error('No such session on this InfiniBot.');
      // KV stores at most 60k chars of a result: keep the newest entries that fit.
      const out = m.history(params.id, Number(params.limit) || 200);
      let history = out.history.map((e) => (typeof e.text === 'string' && e.text.length > 6000 ? { ...e, text: `${e.text.slice(0, 6000)}…` } : e));
      while (history.length > 1 && JSON.stringify(history).length > 50_000) history = history.slice(1);
      return { ...out, history, truncated: history.length < out.history.length };
    }
    case 'cli.sessions.create': {
      const kind = kindOfBackend(params.backend);
      if (!allowKind(kind)) throw new Error(`Starting ${kind === 'agent' ? 'an agent chat' : 'a CLI session'} needs the ${scopesForKind(kind).join(' or ')} permission.`);
      const s = m.create({ backend: params.backend, folder: params.folder, title: params.title, agentId: params.agentId, origin: 'kinglyvault' });
      await emit([{ type: 'progress', text: s.kind === 'agent' ? `New chat with ${s.agentId}` : `New ${s.backend} session in ${s.folder}` }]);
      return { session: s };
    }
    case 'cli.sessions.send': {
      const s = need(m.mustGet(params.id));
      // Agent chats follow the model KV picked; CLI sessions keep their own CLI.
      const brain = s.kind === 'agent' ? await applySessionBrain(gw, sessionKeyFor(state, s.agentId, s.id), params, emit) : null;
      const message = params.context && s.kind === 'agent' ? `[KinglyVault context]\n${params.context}\n\n[Message]\n${params.message}` : params.message;
      let partial = '';
      const out = await m.send(s.id, message, {
        onText: (t) => {
          partial = t;
          void emit([], t);
        },
        onEvent: (label) => void emit([{ type: 'progress', text: label }], partial || undefined),
      });
      return { session: out.session, text: out.text, ...(brain ? { brain } : {}) };
    }
    case 'cli.sessions.stop':
      need(m.mustGet(params.id));
      return m.stop(params.id);
    case 'cli.sessions.rename':
      need(m.mustGet(params.id));
      return { session: m.rename(params.id, params.title) };
    case 'cli.sessions.archive':
      need(m.mustGet(params.id));
      return { session: m.archive(params.id, params.archived !== false) };
    default:
      throw new Error(`Unsupported action ${action}`);
  }
}

// ── pairing ───────────────────────────────────────────────────────────

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(q, r));
  rl.close();
  return a.trim();
}

/**
 * Step 1 of pairing: bind the one-time code to this InfiniBot (device.claim).
 * Returns what the owner must see before approving: the masked KV account and
 * the permissions KV asks for. Nothing is granted yet.
 */
export async function claimPairing({ code, relayUrl = DEFAULT_RELAY_URL, name }) {
  const claimNonce = randomBytes(24).toString('base64url');
  const device = deviceInfo(name);
  const claim = await relayCall(relayUrl, { op: 'device.claim', code, claimNonce, device });
  if (claim.status !== 200) throw new Error(claim.data.message || claim.data.error || `claim failed (${claim.status})`);
  return {
    code,
    claimNonce,
    relayUrl,
    device,
    account: claim.data.account,
    requested: (claim.data.requestedScopes || []).filter((s) => SCOPES.includes(s)),
    kvOrigin: claim.data.kvOrigin,
  };
}

export const isCloudMachine = () => !!(process.env.FLY_APP_NAME || process.env.FLEET_TENANT_ID);

/** Name KV shows for this InfiniBot (tenant Machines have meaningless hostnames). */
export function defaultDeviceName() {
  return isCloudMachine() ? 'InfiniBot Cloud' : os.hostname();
}

function deviceInfo(name) {
  const cloud = isCloudMachine();
  return {
    name: String(name || defaultDeviceName()).slice(0, 60),
    platform: cloud ? 'cloud' : `${process.platform}-${process.arch}`,
    version: `kv-relay ${VERSION}`,
    fingerprint: deviceFingerprint(),
  };
}

/**
 * Device-started link (the "Connect KinglyVault" button): ask KV for a link,
 * get a short code + a kinglyvault.com URL to open. The member approves there
 * (signed in), and pollDeviceLink() sees it. Nothing is granted until then.
 */
export async function startDeviceLink({ relayUrl = DEFAULT_RELAY_URL, name, scopes, intent } = {}) {
  const claimNonce = randomBytes(24).toString('base64url');
  const device = deviceInfo(name);
  // intent: the member's one-time "Connect" click in KinglyVault (deep link,
  // localhost handoff or Cloud app URL). KV approves such a link by itself.
  const withIntent = typeof intent === 'string' && INTENT_RE.test(intent) ? { intent } : {};
  const r = await relayCall(relayUrl, { op: 'device.link.start', claimNonce, device, ...withIntent, ...(scopes ? { scopes } : {}) }, null, { timeoutMs: 20_000 });
  if (r.status !== 200) throw new Error(r.data.message || r.data.error || `link start failed (HTTP ${r.status})`);
  return {
    relayUrl,
    claimNonce,
    device,
    userCode: r.data.userCode,
    deviceCode: r.data.deviceCode,
    verifyUrl: r.data.verifyUrl,
    expiresAt: r.data.expiresAt,
    intervalMs: Math.max(1000, Number(r.data.intervalMs) || 3000),
  };
}

/**
 * One poll. Returns { status } while waiting / after a "no", or
 * { status: 'approved', claim } once the member approved on KinglyVault; pass
 * that claim to approvePairing() to finish (this InfiniBot issues the token).
 */
export async function pollDeviceLink(link) {
  const r = await relayCall(link.relayUrl, { op: 'device.link.poll', deviceCode: link.deviceCode }, null, { timeoutMs: 20_000 });
  if (r.status === 404) return { status: 'expired' };
  if (r.status !== 200) throw new Error(r.data.message || r.data.error || `link poll failed (HTTP ${r.status})`);
  if (r.data.status !== 'approved') return { status: r.data.status };
  return {
    status: 'approved',
    claim: {
      code: link.userCode,
      claimNonce: link.claimNonce,
      relayUrl: link.relayUrl,
      device: link.device,
      account: r.data.account,
      requested: (r.data.requestedScopes || []).filter((x) => SCOPES.includes(x)),
      kvOrigin: r.data.kvOrigin,
    },
  };
}

/** Polls until approved / denied / expired (or `signal` aborts). Resolves with the final poll result. */
export async function waitForDeviceLink(link, { signal, onTick } = {}) {
  let failures = 0;
  while (!signal?.aborted) {
    if (Date.parse(link.expiresAt) <= Date.now()) return { status: 'expired' };
    try {
      const r = await pollDeviceLink(link);
      failures = 0;
      onTick?.(r);
      if (r.status !== 'pending') return r;
    } catch (e) {
      if (++failures >= 20) throw e;
    }
    await sleep(link.intervalMs);
  }
  return { status: 'cancelled' };
}

/** The owner said no: close the pairing on KV's side. Nothing is connected. */
export async function denyPairing(claim) {
  await relayCall(claim.relayUrl, { op: 'device.deny', code: claim.code, claimNonce: claim.claimNonce }).catch(() => {});
  localAudit({ actor: 'owner', action: 'pair.deny', account: claim.account });
}

/**
 * Step 2: the owner approved. Generate the scoped token here (KV only ever
 * stores it sealed), finish the pairing and save the link credentials. Any
 * older link on this InfiniBot is disconnected first, so there is one link.
 */
export async function approvePairing(claim, scopes, { log = console } = {}) {
  const decision = (scopes || claim.requested).filter((s) => claim.requested.includes(s));
  if (!decision.length) throw new Error('Pick at least one permission.');
  const previous = loadState();
  const token = randomBytes(32).toString('base64url');
  const res = await relayCall(claim.relayUrl, { op: 'device.approve', code: claim.code, claimNonce: claim.claimNonce, token, grantedScopes: decision, method: isCloudMachine() ? 'cloud' : 'relay' });
  if (res.status !== 200) throw new Error(res.data.message || res.data.error || `approve failed (${res.status})`);
  if (previous?.deviceSecret && previous.connectionId !== res.data.connectionId) {
    await relayCall(previous.relayUrl, { op: 'device.disconnect' }, previous.deviceSecret).catch(() => {});
    localAudit({ actor: 'owner', action: 'disconnect', reason: 'replaced by a new pairing', connectionId: previous.connectionId });
  }
  const state = {
    relayUrl: claim.relayUrl,
    kvOrigin: res.data.kvOrigin,
    account: claim.account,
    connectionId: res.data.connectionId,
    deviceSecret: res.data.deviceSecret,
    token,
    grantedScopes: res.data.grantedScopes,
    kvMcp: res.data.kvMcp || null,
    deviceName: claim.device.name,
    pairedAt: new Date().toISOString(),
    rotatedAt: new Date().toISOString(),
    paused: false,
  };
  saveState(state);
  localAudit({ actor: 'owner', action: 'pair.approve', account: claim.account, scopes: state.grantedScopes, connectionId: state.connectionId });
  if (state.kvMcp) await registerClaudeMcp(state, log);
  return state;
}

export async function pairDevice({ code, relayUrl = DEFAULT_RELAY_URL, name, approve, scopes: narrow, log = console }) {
  const claim = await claimPairing({ code, relayUrl, name });
  const offered = narrow ? claim.requested.filter((s) => narrow.includes(s)) : claim.requested;
  const decision = await approve({ account: claim.account, requested: claim.requested, offered, kvOrigin: claim.kvOrigin });
  if (!decision || !decision.length) {
    await denyPairing(claim);
    return null;
  }
  return approvePairing(claim, decision, { log });
}

/** Disconnect on both sides and wipe local secrets. Returns KV's HTTP status (0 = unreachable). */
export async function disconnectLink() {
  const s = loadState();
  if (!s) return null;
  const r = await relayCall(s.relayUrl, { op: 'device.disconnect' }, s.deviceSecret, { timeoutMs: 20_000 }).catch(() => ({ status: 0 }));
  // 410/401 = already revoked on KV's side. Anything else (offline, 5xx):
  // remember to finish the revoke, retried by retryPendingRevoke().
  const remoteDone = r.status === 200 || r.status === 410 || r.status === 401;
  if (!remoteDone) {
    try {
      ensureDir();
      fs.writeFileSync(revokePendingPath(), JSON.stringify({ relayUrl: s.relayUrl, deviceSecret: s.deviceSecret, connectionId: s.connectionId, at: new Date().toISOString() }), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }
  wipeState();
  try {
    fs.rmSync(healthPath());
  } catch {
    /* none */
  }
  await unregisterClaudeMcp();
  localAudit({ actor: 'owner', action: 'disconnect', remote: r.status, queued: !remoteDone });
  return remoteDone ? 200 : r.status;
}

/** True while a disconnect is waiting for KinglyVault to confirm the revoke. */
export function revokePending() {
  return fs.existsSync(revokePendingPath());
}

/** Finishes a disconnect that could not reach KV at the time. Returns true when nothing is left to do. */
export async function retryPendingRevoke() {
  let p;
  try {
    p = JSON.parse(fs.readFileSync(revokePendingPath(), 'utf8'));
  } catch {
    return true;
  }
  const r = await relayCall(p.relayUrl, { op: 'device.disconnect' }, p.deviceSecret, { timeoutMs: 20_000 }).catch(() => ({ status: 0 }));
  if (r.status === 200 || r.status === 410 || r.status === 401) {
    fs.rmSync(revokePendingPath(), { force: true });
    localAudit({ actor: 'infinibot', action: 'disconnect.retry', remote: r.status, connectionId: p.connectionId });
    return true;
  }
  return false;
}

export const scopeText = (s) => SCOPE_TEXT[s] || s;

// ── link lock (one link per InfiniBot) ────────────────────────────────
// The link can run as the standalone `relay-client.mjs run` service or as the
// plugin service. Whoever runs it holds link.lock (its pid), so the other
// one stays idle instead of long-polling the same connection twice.

const lockPath = () => path.join(relayDir(), 'link.lock');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** pid of a live link in ANOTHER process, else null. */
export function linkHolder() {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).pid);
    return pid !== process.pid && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function takeLinkLock() {
  ensureDir();
  fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
}

function releaseLinkLock() {
  try {
    if (Number(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).pid) === process.pid) fs.rmSync(lockPath());
  } catch {
    /* not ours / gone */
  }
}

// ── the long-running link ─────────────────────────────────────────────

export class RelayLink {
  constructor({
    root,
    log = console,
    gateway,
    pullWaitMs = PULL_WAIT_MS,
    pullTimeoutMs = PULL_TIMEOUT_MS,
    watchdogMs = PULL_WATCHDOG_MS,
    capsTimeoutMs = CAPS_TIMEOUT_MS,
    capsRefreshMs = CAPS_REFRESH_MS,
    capsFirstWaitMs = CAPS_FIRST_WAIT_MS,
  } = {}) {
    this.log = log;
    this.gw = gateway ?? new LocalGateway({ root, log });
    this.pullWaitMs = pullWaitMs;
    this.pullTimeoutMs = pullTimeoutMs;
    this.watchdogMs = watchdogMs;
    this.capsTimeoutMs = capsTimeoutMs;
    this.capsRefreshMs = capsRefreshMs;
    this.capsFirstWaitMs = capsFirstWaitMs;
    this.stopped = false;
    this.backoff = 1000;
    this.inflight = new Set();
    this.caps = null;
    this.capsAt = 0;
    this.capsRefresh = null;
    this.rotating = null;
    this.loopGen = 0;
    this.loopAbort = null;
    this.lastPullOkAt = 0;
    this.settle = null;
    this.linked = false;
  }

  stop() {
    this.stopped = true;
    this.loopAbort?.abort();
    this.gw.stop();
    this.settle?.();
  }

  async post(state, op, body, opts) {
    return relayCall(state.relayUrl, { op, ...body }, state.deviceSecret, { timeoutMs: 30_000, ...opts });
  }

  async rotate(state) {
    const newToken = randomBytes(32).toString('base64url');
    // Never tied to the loop's abort: KV applies this whether or not we read the
    // answer, and a rotated secret that is not saved here loses the link for good.
    const r = await this.post(state, 'device.rotate', { newToken });
    if (r.status !== 200) return state;
    const next = { ...state, token: newToken, deviceSecret: r.data.deviceSecret, rotatedAt: r.data.rotatedAt, kvMcp: r.data.kvMcp || state.kvMcp };
    saveState(next);
    localAudit({ actor: 'infinibot', action: 'rotate' });
    // Spawns the claude CLI: the link must not wait for it.
    if (r.data.kvMcp) void registerClaudeMcp(next, this.log);
    this.log.info?.('[kv-relay] rotated the KinglyVault link credentials');
    return next;
  }

  maybeRotate(state) {
    if (Date.now() - Date.parse(state.rotatedAt || 0) < ROTATE_EVERY_MS) return state;
    if (!this.rotating) this.rotating = this.rotate(state).finally(() => (this.rotating = null));
    return this.rotating;
  }

  /** Out-of-band and single-flight: never awaited by the pull loop, keeps the last good caps. */
  refreshCaps() {
    if (this.capsRefresh) return this.capsRefresh;
    this.capsAt = Date.now();
    const read = readCapabilities(this.gw, this.caps, this.capsTimeoutMs);
    this.capsRefresh = withTimeout(read, this.capsTimeoutMs + 1000, 'capability refresh')
      .then(({ caps, complete }) => {
        if (complete || this.caps || caps.agents.length || caps.coderBackends.length) this.caps = caps;
        if (!complete) this.capsAt = Date.now() - this.capsRefreshMs + CAPS_RETRY_MS;
      })
      .catch(() => {
        this.capsAt = Date.now() - this.capsRefreshMs + CAPS_RETRY_MS;
      })
      .finally(() => (this.capsRefresh = null));
    return this.capsRefresh;
  }

  /** Abandons the current loop wherever it is stuck and starts a fresh one on a fresh gateway socket. */
  restartLoop() {
    this.lastPullOkAt = Date.now();
    this.unhealthy = true;
    this.gw.reset();
    this.startLoop();
  }

  startLoop() {
    this.loopAbort?.abort();
    const abort = new AbortController();
    this.loopAbort = abort;
    const gen = ++this.loopGen;
    this.loop(gen, abort.signal).then(
      () => gen === this.loopGen && this.settle?.(),
      (e) => gen === this.loopGen && this.settle?.(e),
    );
  }

  /** Reconnects without touching the credentials (kvconnect.restart). */
  restart() {
    if (this.stopped || !this.settle) return false;
    this.log.info?.('[kv-relay] reconnecting on request.');
    this.backoff = 1000;
    this.restartLoop();
    return true;
  }

  checkPulse() {
    const silentMs = Date.now() - this.lastPullOkAt;
    if (this.stopped || silentMs < this.watchdogMs) return;
    this.log.warn?.(`[kv-relay] no successful pull for ${Math.round(silentMs / 1000)}s; restarting the link.`);
    recordHealth({ ok: false, error: 'InfiniBot lost touch with KinglyVault and is reconnecting by itself.', errorAt: new Date().toISOString() }, { force: true });
    this.restartLoop();
  }

  async handle(env, state) {
    const v = verifyEnvelope(env, state);
    const fresh = loadState() || state; // pause / disconnect from the CLI apply immediately
    if (!v.ok || fresh.paused) {
      const reason = fresh.paused ? 'Paused on this InfiniBot (kill switch).' : `Refused by InfiniBot: ${v.reason}`;
      localAudit({ actor: 'kv', action: env?.action, requestId: env?.id, outcome: 'refused', reason });
      if (env?.id) await this.post(state, 'device.result', { requestId: env.id, ok: false, error: reason }).catch(() => {});
      return;
    }
    localAudit({ actor: 'kv', action: env.action, scope: env.scope, requestId: env.id, outcome: 'accepted', params: summarize(v.params) });
    let lastPartial;
    const emit = async (events, partial) => {
      if (partial !== undefined) lastPartial = partial;
      const r = await this.post(state, 'device.event', { requestId: env.id, events, ...(partial !== undefined ? { partial } : {}) }).catch(() => null);
      return r?.status;
    };
    try {
      const result = await runAction(env.action, v.params, { gw: this.gw, state: fresh, emit, scope: env.scope });
      const partial = env.action === 'chat.send' || env.action === 'cli.sessions.send' ? result.text : lastPartial;
      await this.post(state, 'device.result', { requestId: env.id, ok: true, result, ...(partial !== undefined ? { partial } : {}) });
      localAudit({ actor: 'kv', action: env.action, requestId: env.id, outcome: 'ok' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.post(state, 'device.result', { requestId: env.id, ok: false, error: msg }).catch(() => {});
      localAudit({ actor: 'kv', action: env.action, requestId: env.id, outcome: 'error', error: msg.slice(0, 300) });
    }
  }

  async run() {
    let state = loadState();
    if (!state) throw new Error('Not paired. Run: node relay-client.mjs connect <CODE> (get the code in KinglyVault → InfiniBot → Connect).');
    const holder = linkHolder();
    if (holder) {
      this.log.info?.(`[kv-relay] the KinglyVault link already runs in process ${holder}; not starting a second one.`);
      return;
    }
    takeLinkLock();
    this.lastPullOkAt = Date.now();
    // Not unref'd: the standalone link must not exit just because a stuck await left nothing else running.
    const watchdog = setInterval(() => this.checkPulse(), Math.min(10_000, Math.max(this.watchdogMs / 3, 10)));
    try {
      await new Promise((resolve, reject) => {
        this.settle = (e) => (e ? reject(e) : resolve());
        this.startLoop();
      });
    } finally {
      clearInterval(watchdog);
      this.settle = null;
      releaseLinkLock();
    }
  }

  async loop(gen, signal) {
    const live = () => !this.stopped && gen === this.loopGen;
    // Settings / model / sign-in changes on this InfiniBot: re-read the brains on the next pull.
    if (!this.brainEventsBound) {
      this.brainEventsBound = true;
      this.gw.on((evt) => {
        if (/^(config|models|cliRouting|coders|agents)\b/i.test(String(evt?.event || ''))) {
          markBrainsStale();
          this.capsAt = 0;
        }
      });
    }
    // Gives the first pull real capabilities when the gateway answers, without waiting on it.
    await Promise.race([this.refreshCaps(), sleep(this.capsFirstWaitMs, signal)]);
    if (!live()) return;
    let state = loadState();
    if (state && !this.linked) {
      this.linked = true;
      this.log.info?.(`[kv-relay] linked to ${state.kvOrigin} as ${state.account} (scopes: ${state.grantedScopes.join(', ')})`);
    }
    while (live()) {
      // A restart must not race a rotation still in flight: wait for the new credentials.
      if (this.rotating) await this.rotating.catch(() => {});
      if (!live()) return;
      state = loadState();
      if (!state) {
        this.log.info?.('[kv-relay] disconnected locally; stopping.');
        return;
      }
      try {
        state = await this.maybeRotate(state);
        if (Date.now() - this.capsAt > this.capsRefreshMs) void this.refreshCaps();
        const r = await this.post(
          state,
          'device.pull',
          { waitMs: this.pullWaitMs, version: `kv-relay ${VERSION}`, ...(this.caps ? { capabilities: this.caps } : {}) },
          { timeoutMs: this.pullTimeoutMs, signal },
        );
        if (r.status === 410 || r.status === 401) {
          // A re-pair replaced the link while this poll was in flight: the old
          // connection was revoked, the new credentials on disk are fine.
          if (loadState()?.connectionId !== state.connectionId) continue;
          this.log.warn?.('[kv-relay] KinglyVault revoked this link. Wiping local credentials.');
          recordHealth({ ok: false, error: 'This link was removed in KinglyVault. Connect again to re-link.', revokedAt: new Date().toISOString() }, { force: true });
          localAudit({ actor: 'kv', action: 'revoke', outcome: 'remote' });
          wipeState();
          await unregisterClaudeMcp();
          return;
        }
        if (r.status !== 200) throw new Error(r.data.message || r.data.error || `pull failed (HTTP ${r.status})`);
        this.lastPullOkAt = Date.now();
        if (this.backoff > 1000) this.log.info?.('[kv-relay] link to KinglyVault is back.');
        this.backoff = 1000;
        recordHealth({ ok: true, lastSyncAt: new Date().toISOString(), error: null }, { force: this.unhealthy === true });
        this.unhealthy = false;
        if (r.data.paused) {
          recordHealth({ paused: true });
          await sleep(Math.min(Number(r.data.retryAfterMs) || 10_000, PAUSED_RETRY_MAX_MS), signal);
          continue;
        }
        if ((r.data.requests || []).length) recordHealth({ lastRequestAt: new Date().toISOString() }, { force: true });
        for (const env of r.data.requests || []) {
          const p = this.handle(env, state).finally(() => this.inflight.delete(p));
          this.inflight.add(p);
        }
      } catch (e) {
        if (!live()) return;
        this.log.warn?.(`[kv-relay] link error: ${e instanceof Error ? e.message : e}; retrying in ${Math.round(this.backoff / 1000)}s`);
        recordHealth({ ok: false, error: friendlyError(e), errorAt: new Date().toISOString() }, { force: !this.unhealthy });
        this.unhealthy = true;
        await sleep(this.backoff, signal);
        this.backoff = Math.min(this.backoff * 2, 60_000);
      }
    }
  }
}

/** Opens a URL in the default browser (best effort; the URL is printed too). */
export function openUrl(url) {
  if (!/^https:\/\//.test(url)) return;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    execFile(cmd, args, { timeout: 10_000 }, () => {});
  } catch {
    /* printed above */
  }
}

function summarize(p) {
  const o = {};
  for (const [k, v] of Object.entries(p || {})) o[k] = typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…` : v;
  return o;
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

// ── CLI ───────────────────────────────────────────────────────────────

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function cli(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const log = console;
  switch (cmd) {
    case 'link': {
      // Device-started: print + open the kinglyvault.com approve page, wait, finish.
      const link = await startDeviceLink({ relayUrl: flag(rest, 'relay') || process.env.KV_RELAY_URL || DEFAULT_RELAY_URL, name: flag(rest, 'name') });
      console.log(`\nOpen this page to approve (signed in to KinglyVault):\n  ${link.verifyUrl}\n\nCode: ${link.userCode}  (check it matches)\nWaiting for approval…`);
      if (!rest.includes('--no-open')) openUrl(link.verifyUrl);
      const r = await waitForDeviceLink(link);
      if (r.status !== 'approved') {
        console.log(r.status === 'denied' ? 'Not approved. Nothing was connected.' : 'The link expired. Run this again.');
        return;
      }
      const state = await approvePairing(r.claim, r.claim.requested, { log });
      console.log(`\nConnected ✓  ${state.account} · scopes: ${state.grantedScopes.join(', ')}`);
      return;
    }
    case 'connect': {
      const code = rest.find((a) => !a.startsWith('--') && /[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}/.test(a));
      if (!code) return cli(['link', ...rest]);
      const narrow = flag(rest, 'scopes')?.split(',').map((s) => s.trim());
      const yes = rest.includes('--yes');
      const state = await pairDevice({
        code,
        relayUrl: flag(rest, 'relay') || process.env.KV_RELAY_URL || DEFAULT_RELAY_URL,
        name: flag(rest, 'name'),
        scopes: narrow,
        log,
        approve: async ({ account, requested, offered, kvOrigin }) => {
          console.log(`\nKinglyVault (${kvOrigin}) wants to connect to this InfiniBot`);
          console.log(`Account: ${account}\n`);
          console.log('It asks for:');
          for (const s of requested) console.log(`  ${offered.includes(s) ? '[x]' : '[ ]'} ${s.padEnd(13)} ${SCOPE_TEXT[s] || ''}`);
          console.log('\nNo shell access is ever granted. Coders only run in folders you allow (allow-dir).');
          if (yes) return offered;
          const a = await ask('\nApprove the ticked permissions? [y/N] ');
          return /^y(es)?$/i.test(a) ? offered : null;
        },
      });
      if (!state) {
        console.log('Denied. Nothing was connected.');
        return;
      }
      console.log(`\nConnected. Connection ${state.connectionId.slice(0, 8)} · scopes: ${state.grantedScopes.join(', ')}`);
      if (state.kvMcp) console.log('kv-mcp registered for Claude Code coders (server "kinglyvault").');
      console.log('Keep the link running with:  node relay-client.mjs run   (or enable the kinglyvault-relay plugin).');
      return;
    }
    case 'run': {
      const link = new RelayLink({ root: flag(rest, 'root'), log });
      process.on('SIGINT', () => link.stop());
      process.on('SIGTERM', () => link.stop());
      await link.run();
      // Revoked / disconnected / stopped: close the gateway socket (its
      // reconnect timer would otherwise keep the process alive) and exit.
      link.stop();
      process.exit(0);
    }
    case 'status': {
      const s = loadState();
      if (!s) {
        console.log('Not connected to KinglyVault.');
        return;
      }
      const r = await relayCall(s.relayUrl, { op: 'device.status' }, s.deviceSecret).catch((e) => ({ status: 0, data: { error: e.message } }));
      console.log(JSON.stringify({
        kv: s.kvOrigin, account: s.account, connectionId: s.connectionId, scopes: s.grantedScopes, paused: !!s.paused,
        pairedAt: s.pairedAt, rotatedAt: s.rotatedAt, kvMcp: !!s.kvMcp, allowedWorkdirs: loadPolicy().allowedWorkdirs,
        remote: r.status === 200 ? { status: r.data.connection?.status, online: r.data.connection?.online, lastSeenAt: r.data.connection?.lastSeenAt, enabledScopes: r.data.connection?.enabledScopes } : { error: r.data.error || r.status },
      }, null, 2));
      return;
    }
    case 'audit': {
      if (rest.includes('--remote')) {
        const s = loadState();
        if (!s) throw new Error('Not connected.');
        const r = await relayCall(s.relayUrl, { op: 'device.audit', limit: 50 }, s.deviceSecret);
        for (const e of (r.data.entries || []).reverse()) console.log(`${e.created_at}  ${e.actor.padEnd(9)} ${String(e.action).padEnd(16)} ${e.outcome}`);
        return;
      }
      try {
        process.stdout.write(fs.readFileSync(auditPath(), 'utf8').split('\n').slice(-60).join('\n'));
      } catch {
        console.log('No local audit entries yet.');
      }
      return;
    }
    case 'pause':
    case 'resume': {
      const s = loadState();
      if (!s) throw new Error('Not connected.');
      saveState({ ...s, paused: cmd === 'pause' });
      localAudit({ actor: 'owner', action: cmd });
      console.log(cmd === 'pause' ? 'Paused: this InfiniBot refuses every KinglyVault request until you resume.' : 'Resumed.');
      return;
    }
    case 'allow-dir': {
      const dir = rest[0] && path.resolve(rest[0]);
      if (!dir) throw new Error('Usage: allow-dir <absolute path>');
      fs.mkdirSync(dir, { recursive: true });
      const p = loadPolicy();
      if (!p.allowedWorkdirs.includes(dir)) p.allowedWorkdirs.push(dir);
      savePolicy(p);
      localAudit({ actor: 'owner', action: 'allow-dir', dir });
      console.log(`KinglyVault-started coders may now work in ${dir}`);
      return;
    }
    case 'disconnect': {
      const status = await disconnectLink();
      if (status === null) {
        console.log('Not connected.');
        return;
      }
      console.log(`Disconnected${status === 200 ? ' on both sides' : ' here. KinglyVault was unreachable; InfiniBot finishes the revoke there as soon as it can'}.`);
      return;
    }
    default:
      console.log('KinglyVault Connect for InfiniBot\n\nCommands: link (opens kinglyvault.com to approve) | connect <CODE> | run | status | audit [--remote] | pause | resume | allow-dir <path> | disconnect');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((e) => {
    console.error(`kv-relay: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
