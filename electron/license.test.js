import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const https = require('https');
const http = require('http');
const license = require('./license');

// Unsigned JWT with a "free" plan claim — enough to put a token on disk so
// refreshLicense() has something it *could* send to KinglyVault.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FAKE_JWT = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
  sub: 'u1', plan: 'free', features: [], iss: 'kinglyvault', aud: 'infinibot',
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, jti: 'j1',
})}.sig`;

let tmp;
let requests;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-license-'));
  process.env.INFINIBOT_STATE_DIR = tmp;
  delete process.env.INFINIBOT_REQUIRE_VAULT;
  requests = [];
  const fake = (url) => {
    requests.push(String(url));
    throw new Error('network disabled in test');
  };
  vi.spyOn(https, 'request').mockImplementation(fake);
  vi.spyOn(http, 'request').mockImplementation(fake);
  license.logout();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.INFINIBOT_STATE_DIR;
  delete process.env.INFINIBOT_REQUIRE_VAULT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('self-hosted (default)', () => {
  it('unlocks every feature with no sign-in', () => {
    license.init();
    expect(license.isSelfHosted()).toBe(true);
    const st = license.getState();
    expect(st.selfHosted).toBe(true);
    expect(st.signedIn).toBe(false);
    expect(st.degraded).toBe(false);
    expect(st.source).toBe('self-hosted');
    expect(st.features).toEqual(license.ALL_FEATURES);
    expect(license.hasFeature('infinibot_voice_pack')).toBe(true);
    expect(license.hasFeature('offline_only_mode')).toBe(true);
    expect(license.planAtLeast('ceo')).toBe(true);
  });

  it('never contacts KinglyVault, even with a stored token', async () => {
    license.saveLicense(FAKE_JWT);
    const st = await license.refreshLicense();
    expect(st.selfHosted).toBe(true);
    const v = await license.verifyToken(FAKE_JWT);
    expect(v.skipped).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe('INFINIBOT_REQUIRE_VAULT=1 (Vault-gated build)', () => {
  it('keeps plan gating: unsigned install is free and not signed in', () => {
    process.env.INFINIBOT_REQUIRE_VAULT = '1';
    license.init();
    const st = license.getState();
    expect(st.selfHosted).toBe(false);
    expect(st.signedIn).toBe(false);
    expect(st.plan).toBe('free');
    expect(license.hasFeature('infinibot_voice_pack')).toBe(false);
  });

  it('refreshes against KinglyVault', async () => {
    process.env.INFINIBOT_REQUIRE_VAULT = '1';
    license.saveLicense(FAKE_JWT);
    await license.refreshLicense();
    expect(requests.some((u) => u.includes('/api/license/refresh'))).toBe(true);
  });
});
