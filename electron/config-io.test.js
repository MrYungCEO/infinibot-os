import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const io = require('./config-io.js');

const tmp = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-config-io-'));
  tmp.push(d);
  return d;
};
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

// The patch wizard:join-federation writes on a fresh install.
const joinPatch = {
  gateway: { mode: 'local', bind: 'loopback', port: 28790, auth: { mode: 'token', token: 'tok' } },
  federation: {
    enabled: true,
    mode: 'satellite',
    masterUrl: 'ws://192.168.1.20:18789/federation',
    masters: [],
    nodeId: 'abc123',
    nodeName: 'Laptop',
    authToken: { satelliteId: 'abc123' },
  },
};

describe('satellite join with no existing config', () => {
  it('creates the missing state dir and infinibot.json (fresh install, default ~/.infinibot)', () => {
    const home = mkTmp();
    const file = io.resolveConfigPath({ env: {}, homedir: () => home });
    expect(file).toBe(path.join(home, '.infinibot', 'infinibot.json'));
    expect(fs.existsSync(path.dirname(file))).toBe(false);

    const r = io.applyConfigPatch(joinPatch, { file });
    expect(r).toEqual({ ok: true, created: true });
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(cfg.federation).toMatchObject({ enabled: true, mode: 'satellite', masterUrl: joinPatch.federation.masterUrl });
    expect(cfg.gateway).toMatchObject({ mode: 'local', port: 28790, auth: { mode: 'token', token: 'tok' } });
    // No temp files left behind by the atomic write.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['infinibot.json']);
  });

  it('creates a nested INFINIBOT_STATE_DIR that does not exist yet', () => {
    const root = mkTmp();
    const env = { INFINIBOT_STATE_DIR: path.join(root, 'a', 'b', 'state') };
    const file = io.resolveConfigPath({ env });
    expect(io.applyConfigPatch(joinPatch, { file }).ok).toBe(true);
    expect(io.readConfig(file).federation.mode).toBe('satellite');
  });

  it('works when INFINIBOT_STATE_DIR exists but is empty', () => {
    const dir = mkTmp();
    const file = io.resolveConfigPath({ env: { INFINIBOT_STATE_DIR: dir } });
    expect(io.applyConfigPatch(joinPatch, { file })).toEqual({ ok: true, created: true });
  });

  it('merges into an existing config without dropping other keys', () => {
    const dir = mkTmp();
    const file = path.join(dir, 'infinibot.json');
    fs.writeFileSync(file, JSON.stringify({ gateway: { port: 18800, auth: { mode: 'password', password: 'p' } }, agents: { list: [1] } }));
    const r = io.applyConfigPatch({ federation: joinPatch.federation }, { file });
    expect(r).toEqual({ ok: true, created: false });
    const cfg = io.readConfig(file);
    expect(cfg.gateway).toEqual({ port: 18800, auth: { mode: 'password', password: 'p' } });
    expect(cfg.agents).toEqual({ list: [1] });
    expect(cfg.federation.mode).toBe('satellite');
  });

  it('keeps an unreadable config as a .bak instead of silently replacing it', () => {
    const dir = mkTmp();
    const file = path.join(dir, 'infinibot.json');
    fs.writeFileSync(file, '{ // json5 comment\n gateway: {} }');
    expect(io.applyConfigPatch(joinPatch, { file }).ok).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('infinibot.json.unreadable-'))).toBe(true);
  });

  it('ensureConfigFile writes a minimal valid file only when missing', () => {
    const home = mkTmp();
    const file = path.join(home, 'x', 'infinibot.json');
    expect(io.ensureConfigFile(file)).toBe(true);
    expect(io.readConfig(file)).toEqual({});
    expect(io.ensureConfigFile(file)).toBe(false);
  });

  it('returns a plain-language error, never a raw ENOENT, when the folder cannot be created', () => {
    const dir = mkTmp();
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const r = io.applyConfigPatch(joinPatch, { file: path.join(blocker, 'state', 'infinibot.json') });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/InfiniBot/);
    expect(r.error).not.toMatch(/^ENOENT|ENOTDIR:|no such file or directory, open/);
  });
});

describe('Windows path resolution (path.win32)', () => {
  const win = { pathImpl: path.win32, homedir: () => 'C:\\Users\\Ash' };

  it('defaults to %USERPROFILE%\\.infinibot\\infinibot.json', () => {
    expect(io.resolveStateDir({ env: {}, ...win })).toBe('C:\\Users\\Ash\\.infinibot');
    expect(io.resolveConfigPath({ env: {}, ...win })).toBe('C:\\Users\\Ash\\.infinibot\\infinibot.json');
  });

  it('honours INFINIBOT_STATE_DIR (trimmed, ~ expanded with either separator)', () => {
    expect(io.resolveStateDir({ env: { INFINIBOT_STATE_DIR: '  D:\\IB\\state  ' }, ...win })).toBe('D:\\IB\\state');
    expect(io.resolveStateDir({ env: { INFINIBOT_STATE_DIR: '~\\.infinibot-desktop' }, ...win })).toBe('C:\\Users\\Ash\\.infinibot-desktop');
    expect(io.resolveStateDir({ env: { INFINIBOT_STATE_DIR: '~/ib' }, ...win })).toBe('C:\\Users\\Ash\\ib');
    expect(io.resolveConfigPath({ env: { INFINIBOT_STATE_DIR: 'D:/IB/state/' }, ...win })).toBe('D:\\IB\\state\\infinibot.json');
  });

  it('honours INFINIBOT_CONFIG_PATH and ignores blank overrides', () => {
    expect(io.resolveConfigPath({ env: { INFINIBOT_CONFIG_PATH: 'E:\\cfg\\ib.json' }, ...win })).toBe('E:\\cfg\\ib.json');
    expect(io.resolveConfigPath({ env: { INFINIBOT_STATE_DIR: '   ', INFINIBOT_CONFIG_PATH: '' }, ...win })).toBe('C:\\Users\\Ash\\.infinibot\\infinibot.json');
  });

  it('never produces a POSIX "/" path segment', () => {
    for (const env of [{}, { INFINIBOT_STATE_DIR: '~/x/y' }, { INFINIBOT_STATE_DIR: 'C:/a/b' }]) {
      expect(io.resolveConfigPath({ env, ...win })).not.toContain('/');
    }
  });
});

describe('describeConfigError', () => {
  it('maps common codes to plain words', () => {
    for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOSPC', 'EROFS']) {
      const msg = io.describeConfigError({ code, message: `${code}: raw` }, 'C:\\Users\\Ash\\.infinibot\\infinibot.json');
      expect(msg).not.toMatch(new RegExp(`^${code}`));
      expect(msg).toContain('C:\\Users\\Ash\\.infinibot\\infinibot.json');
    }
  });
});

describe('packaging', () => {
  it('ships config-io.js in the desktop app', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
    expect(pkg.build.files).toContain('config-io.js');
  });
});
