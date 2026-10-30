/**
 * Satellite mode helpers for the desktop app.
 *
 * "Connect to another InfiniBot" makes THIS computer a real federation node:
 * a local satellite gateway runs in the background, joins the master with the
 * invite token, registers its capabilities and stays connected. This module
 * holds the pieces main.js needs around that:
 *   - decode an invite and rank/probe the master addresses it carries
 *   - read the satellite's live status (written by the gateway to
 *     <state>/federation/satellite-status.json) and wait for "connected"
 *   - turn failures into plain, actionable messages
 *   - autostart on login
 *
 * Pure functions are exported for tests (satellite.test.js).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

// ── Invite decoding ─────────────────────────────────────────────────────────

/** Parse base64/base64url JSON, or `infinibot-invite-v1:` prefixed blobs. */
function decodeInviteBlob(raw) {
  let s = String(raw || '').trim();
  // Users paste the whole CLI line: `infinibot federation join <code>`.
  const m = s.match(/(?:federation\s+join\s+)?(\S+)\s*$/);
  if (m) s = m[1];
  s = s.replace(/^infinibot-invite-v\d+:/, '');
  for (const variant of [s, s.replace(/-/g, '+').replace(/_/g, '/')]) {
    try {
      const pad = variant.length % 4 === 0 ? '' : '='.repeat(4 - (variant.length % 4));
      const obj = JSON.parse(Buffer.from(variant + pad, 'base64').toString('utf-8'));
      if (obj && typeof obj === 'object') return obj;
    } catch {/* try next */}
  }
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object') return obj;
  } catch {/* not JSON */}
  return null;
}

/**
 * Decode a federation invite (hub bundle from Setup › Federation, or the CLI
 * `infinibot federation invite` format) into what a satellite needs.
 * Returns { masterUrls[], token, nodeId, name, hubName, expiresAt } or
 * { error } with a plain message.
 */
function decodeFederationInvite(raw) {
  const obj = decodeInviteBlob(raw);
  if (!obj) {
    return { error: 'That is not an invite code. On the master open Fleet › Share Invite and copy the whole code.' };
  }
  let urls = [];
  let token = null;
  let nodeId;
  let name;
  let hubName;
  if (typeof obj.masterUrl === 'string' && obj.satelliteToken) {
    urls = [obj.masterUrl];
    token = obj.satelliteToken;
    nodeId = typeof obj.satelliteIdHint === 'string' ? obj.satelliteIdHint : token.satelliteId;
    name = obj.satelliteName;
    hubName = obj.label || obj.iss;
  } else if ((obj.hubUrl || Array.isArray(obj.hubUrls)) && obj.token) {
    urls = [
      ...(Array.isArray(obj.hubUrls) ? obj.hubUrls.map((u) => (typeof u === 'string' ? u : u && u.url)) : []),
      obj.hubUrl,
    ];
    token = obj.token;
    nodeId = token.satelliteId;
    name = obj.satelliteName;
    hubName = obj.hubName;
  } else {
    return { error: 'This invite is missing the master address or its token. Generate a new invite on the master.' };
  }
  if (!token || typeof token.satelliteId !== 'string' || typeof token.signature !== 'string') {
    return { error: 'This invite is damaged (no valid token). Copy the whole code again from the master.' };
  }
  const expiresAt = Number(obj.expiresAt || token.expiresAt || 0) || null;
  const masterUrls = rankMasterUrls(urls.filter((u) => typeof u === 'string' && u.trim()));
  if (masterUrls.length === 0) return { error: 'This invite has no master address. Generate a new invite on the master.' };
  return { masterUrls, token, nodeId, name, hubName, expiresAt };
}

/** ws/wss + /federation, like the gateway's formatMasterUrl. */
function formatMasterUrl(input) {
  let u = String(input || '').trim();
  if (u.startsWith('http://')) u = 'ws://' + u.slice(7);
  else if (u.startsWith('https://')) u = 'wss://' + u.slice(8);
  else if (!/^wss?:\/\//.test(u)) u = 'ws://' + u;
  try {
    const url = new URL(u);
    if (!url.pathname || url.pathname === '/') url.pathname = '/federation';
    return url.toString();
  } catch {
    return u;
  }
}

function urlRank(u) {
  let host = '';
  try { host = new URL(u).hostname; } catch { return 9; }
  if (/\.ts\.net$/i.test(host)) return 0; // Tailscale MagicDNS: works anywhere, secure-context friendly
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 1; // Tailscale CGNAT IP
  if (/^192\.168\./.test(host) || /^10\./.test(host)) return 2; // home/office LAN
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 4; // usually Docker bridges — last resort
  if (host === 'localhost' || host.startsWith('127.')) return 5;
  return 3; // public DNS name
}

/** Normalise, dedupe and order: Tailscale DNS, Tailscale IP, LAN, public, docker, loopback. */
function rankMasterUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    const u = formatMasterUrl(raw);
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out.map((u, i) => ({ u, i, r: urlRank(u) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.u);
}

/** http(s) origin of a ws(s) federation URL. */
function httpOriginOf(masterUrl) {
  const u = new URL(formatMasterUrl(masterUrl));
  return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
}

/** GET <origin>/health. Resolves { ok, ms, error }. */
function probeMaster(masterUrl, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let origin;
    try { origin = httpOriginOf(masterUrl); } catch (err) { resolve({ ok: false, error: String(err.message || err) }); return; }
    const started = Date.now();
    const lib = origin.startsWith('https:') ? https : http;
    const req = lib.get(`${origin}/health`, { timeout: timeoutMs }, (res) => {
      res.resume();
      // Any HTTP answer means a gateway is listening there.
      resolve({ ok: res.statusCode < 500, ms: Date.now() - started, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', (err) => resolve({ ok: false, ms: Date.now() - started, error: err.code || err.message }));
  });
}

/** Probe all addresses in parallel; return them reachable-first (rank order kept). */
async function probeMasterUrls(masterUrls, probe = probeMaster) {
  const results = await Promise.all(masterUrls.map(async (u) => ({ url: u, ...(await probe(u)) })));
  const reachable = results.filter((r) => r.ok).map((r) => r.url);
  const unreachable = results.filter((r) => !r.ok).map((r) => r.url);
  return { results, ordered: [...reachable, ...unreachable], reachable };
}

// ── Live status ─────────────────────────────────────────────────────────────

function statusFilePath(stateDir) {
  return path.join(stateDir, 'federation', 'satellite-status.json');
}

function readSatelliteStatus(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(statusFilePath(stateDir), 'utf-8'));
  } catch {
    return null;
  }
}

/** Plain, actionable sentence for a satellite status that is not connected. */
function explainSatelliteProblem(status, { masterUrl } = {}) {
  const host = (() => { try { return new URL(status?.masterUrl || masterUrl).host; } catch { return 'the master'; } })();
  const err = status?.lastError;
  if (!status) return 'The satellite service has not started yet.';
  if (err?.code === 'UNAUTHORIZED') return err.message;
  if (err?.code === 'PROTOCOL_MISMATCH') {
    return `This app and the master run different InfiniBot versions (${err.message}). Update both to the same version, then reconnect.`;
  }
  if (err?.code === 'UNREACHABLE' || err?.code === 'STALE') {
    return `Can't reach the master at ${host}. Check the master is running, and that both computers are on the same network or both signed in to Tailscale.`;
  }
  if (err?.message) return err.message;
  if (status.state === 'connecting' || status.state === 'reconnecting' || status.state === 'registering') {
    return `Connecting to the master at ${host}…`;
  }
  return `Not connected to the master at ${host}.`;
}

/**
 * Poll the status file until the satellite is connected, a definite failure
 * is reported (bad/expired invite, version mismatch), or the timeout passes.
 * `since` ignores a stale file left by a previous run.
 */
async function waitForSatelliteConnected(stateDir, { timeoutMs = 60_000, since = 0, intervalMs = 750, onStatus } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const st = readSatelliteStatus(stateDir);
    if (st && (st.updatedAt || 0) >= since) {
      last = st;
      onStatus?.(st);
      if (st.state === 'connected') return { ok: true, status: st };
      const code = st.lastError?.code;
      if (code === 'UNAUTHORIZED' || code === 'PROTOCOL_MISMATCH') {
        return { ok: false, status: st, error: explainSatelliteProblem(st), fatal: true };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, status: last, error: explainSatelliteProblem(last) };
}

function indicatorText(status, fallbackName) {
  const name = status?.nodeName || fallbackName || os.hostname();
  if (!status) return `This device: ${name} · satellite · starting…`;
  if (status.state === 'connected') {
    const ms = typeof status.latencyMs === 'number' ? ` · ${status.latencyMs} ms` : '';
    return `This device: ${name} · connected as satellite${ms}`;
  }
  if (status.state === 'reconnecting' || status.state === 'connecting' || status.state === 'registering') {
    return `This device: ${name} · satellite · reconnecting…`;
  }
  return `This device: ${name} · satellite · offline`;
}

// ── Autostart ───────────────────────────────────────────────────────────────

/**
 * Start the app hidden at login so the satellite stays reachable after a
 * reboot. Windows/macOS use the OS login items; Linux writes an XDG autostart
 * entry (AppImage: the stable $APPIMAGE path).
 */
function setAutostart(app, enabled, { platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === 'linux') {
    const dir = path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'autostart');
    const file = path.join(dir, 'infinibot-satellite.desktop');
    if (!enabled) {
      try { fs.rmSync(file, { force: true }); } catch {/* gone */}
      return { ok: true, file };
    }
    const exe = env.APPIMAGE || process.execPath;
    const exec = app.isPackaged ? `"${exe}" --hidden` : `"${process.execPath}" "${path.resolve(process.argv[1] || '.')}" --hidden`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      ['[Desktop Entry]', 'Type=Application', 'Name=InfiniBot (satellite)', `Exec=${exec}`, 'X-GNOME-Autostart-enabled=true', 'NoDisplay=true', 'Terminal=false', ''].join('\n'),
      'utf-8',
    );
    return { ok: true, file };
  }
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true, args: ['--hidden'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

module.exports = {
  decodeInviteBlob,
  decodeFederationInvite,
  formatMasterUrl,
  rankMasterUrls,
  httpOriginOf,
  probeMaster,
  probeMasterUrls,
  statusFilePath,
  readSatelliteStatus,
  explainSatelliteProblem,
  waitForSatelliteConnected,
  indicatorText,
  setAutostart,
};
