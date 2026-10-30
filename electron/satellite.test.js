import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sat = require('./satellite.js');

const token = { satelliteId: 'abc123', permissions: { level: 'full', allowedOperations: [] }, issuedAt: 1, expiresAt: Date.now() + 600_000, signature: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const tmp = [];
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('invite decoding', () => {
  it('reads the hub bundle (Fleet › Share Invite) with every address, Tailscale first', () => {
    const d = sat.decodeFederationInvite(b64({
      v: 1,
      hubUrl: 'ws://192.168.1.13:18789/federation',
      hubUrls: [
        { url: 'ws://192.168.1.13:18789/federation' },
        { url: 'ws://172.17.0.1:18789/federation' },
        { url: 'ws://100.64.0.1:18789/federation' },
        { url: 'ws://master.tailnet.ts.net:18789/federation' },
      ],
      hubName: 'Master', satelliteName: 'CEO laptop', token, expiresAt: token.expiresAt,
    }));
    expect(d.error).toBeUndefined();
    expect(d.masterUrls).toEqual([
      'ws://master.tailnet.ts.net:18789/federation',
      'ws://100.64.0.1:18789/federation',
      'ws://192.168.1.13:18789/federation',
      'ws://172.17.0.1:18789/federation',
    ]);
    expect(d).toMatchObject({ nodeId: 'abc123', name: 'CEO laptop', hubName: 'Master' });
  });

  it('reads the CLI format and a pasted `infinibot federation join` line', () => {
    const blob = 'infinibot-invite-v1:' + b64({ v: 1, masterUrl: 'http://10.0.0.5:18789', satelliteToken: token, satelliteIdHint: 'abc123', label: 'Master', iss: 'Master', expiresAt: token.expiresAt });
    const d = sat.decodeFederationInvite(`infinibot federation join ${blob}`);
    expect(d.masterUrls).toEqual(['ws://10.0.0.5:18789/federation']);
    // The master's label is NOT used as this device's name.
    expect(d.name).toBeUndefined();
  });

  it('gives plain errors for junk and token-less invites', () => {
    expect(sat.decodeFederationInvite('hello there').error).toMatch(/not an invite/i);
    expect(sat.decodeFederationInvite(b64({ hubUrl: 'ws://x' })).error).toMatch(/missing/i);
    expect(sat.decodeFederationInvite(b64({ hubUrl: 'ws://x', token: { satelliteId: 'a' } })).error).toMatch(/damaged/i);
  });
});

describe('master probing', () => {
  it('orders reachable addresses first', async () => {
    const server = http.createServer((_q, r) => r.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const out = await sat.probeMasterUrls([`ws://127.0.0.1:1/federation`, `ws://127.0.0.1:${port}/federation`]);
      expect(out.reachable).toEqual([`ws://127.0.0.1:${port}/federation`]);
      expect(out.ordered[0]).toBe(`ws://127.0.0.1:${port}/federation`);
    } finally {
      server.close();
    }
  });
});

describe('status + errors', () => {
  const mkState = (status) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sat-st-'));
    tmp.push(dir);
    fs.mkdirSync(path.join(dir, 'federation'));
    if (status) fs.writeFileSync(path.join(dir, 'federation', 'satellite-status.json'), JSON.stringify(status));
    return dir;
  };

  it('resolves when the satellite reports connected', async () => {
    const dir = mkState({ state: 'connected', nodeName: 'Lap', latencyMs: 12, updatedAt: Date.now() });
    const r = await sat.waitForSatelliteConnected(dir, { timeoutMs: 2000, intervalMs: 50 });
    expect(r.ok).toBe(true);
    expect(sat.indicatorText(r.status)).toBe('This device: Lap · connected as satellite · 12 ms');
  });

  it('stops early on a refused join with the master\'s plain reason', async () => {
    const dir = mkState({ state: 'reconnecting', updatedAt: Date.now(), lastError: { code: 'UNAUTHORIZED', message: 'This invite has expired. Generate a new one…' } });
    const r = await sat.waitForSatelliteConnected(dir, { timeoutMs: 5000, intervalMs: 50 });
    expect(r).toMatchObject({ ok: false, fatal: true });
    expect(r.error).toMatch(/expired/);
  });

  it('explains unreachable masters and version mismatches', () => {
    expect(sat.explainSatelliteProblem({ state: 'reconnecting', masterUrl: 'ws://m.ts.net:18789/federation', lastError: { code: 'UNREACHABLE', message: 'x' } }))
      .toMatch(/Can't reach the master at m\.ts\.net:18789/);
    expect(sat.explainSatelliteProblem({ state: 'disconnected', lastError: { code: 'PROTOCOL_MISMATCH', message: 'protocol 3 vs 2' } }))
      .toMatch(/different InfiniBot versions/);
  });

  it('ignores a stale status file from a previous run', async () => {
    const dir = mkState({ state: 'connected', updatedAt: 1000 });
    const r = await sat.waitForSatelliteConnected(dir, { timeoutMs: 300, intervalMs: 50, since: Date.now() });
    expect(r.ok).toBe(false);
  });
});

describe('autostart', () => {
  it('writes and removes an XDG autostart entry on Linux', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sat-home-'));
    tmp.push(home);
    const app = { isPackaged: true };
    const r = sat.setAutostart(app, true, { platform: 'linux', env: { APPIMAGE: '/opt/InfiniBot.AppImage' }, homedir: home });
    expect(fs.readFileSync(r.file, 'utf-8')).toContain('Exec="/opt/InfiniBot.AppImage" --hidden');
    sat.setAutostart(app, false, { platform: 'linux', env: {}, homedir: home });
    expect(fs.existsSync(r.file)).toBe(false);
  });
});
