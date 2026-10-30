import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createKvBrowserFlow } = require('./kv-browser-flow');

const LOGIN = 'https://kinglyvault.com/login?return=infinibot%3A%2F%2Fcallback';
const UPGRADE = 'https://infinibotos.com/upgrade?plan=ceo&return=infinibot%3A%2F%2Flicense-refreshed';

function setup(opts = {}) {
  const shell = { openExternal: vi.fn(async () => {}) };
  const flow = createKvBrowserFlow({ shell, ...opts });
  return { shell, flow };
}

describe('kv-browser-flow', () => {
  it('opens licence sign-in in the default browser and resolves on infinibot://callback', async () => {
    const { shell, flow } = setup();
    const p = flow.open(LOGIN, { match: (h) => h === 'callback' });
    await Promise.resolve();
    expect(shell.openExternal).toHaveBeenCalledWith(LOGIN);
    expect(flow.isWaiting()).toBe(true);
    expect(flow.deliver('infinibot://license-refreshed')).toBe(false);
    expect(flow.deliver('infinibot://callback?token=abc')).toBe(true);
    await expect(p).resolves.toEqual({ url: 'infinibot://callback?token=abc', reachable: true });
    expect(flow.isWaiting()).toBe(false);
  });

  it('opens checkout in the default browser and resolves on infinibot://license-refreshed', async () => {
    const { shell, flow } = setup();
    const p = flow.open(UPGRADE, { match: (h) => h === 'license-refreshed' });
    flow.deliver('infinibot://license-refreshed?intent=eyJ9');
    await expect(p).resolves.toEqual({ url: 'infinibot://license-refreshed?intent=eyJ9', reachable: true });
    expect(shell.openExternal).toHaveBeenCalledWith(UPGRADE);
  });

  it('reports unreachable when the browser cannot be opened', async () => {
    const shell = { openExternal: vi.fn(async () => { throw new Error('no browser'); }) };
    const flow = createKvBrowserFlow({ shell });
    await expect(flow.open(LOGIN)).resolves.toEqual({ url: null, reachable: false });
  });

  it('never hands non-web schemes to the OS', async () => {
    const { shell, flow } = setup();
    await expect(flow.open('file:///etc/passwd')).resolves.toEqual({ url: null, reachable: false });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('times out with no url', async () => {
    vi.useFakeTimers();
    try {
      const { flow } = setup({ timeoutMs: 1000 });
      const p = flow.open(LOGIN);
      await vi.advanceTimersByTimeAsync(1001);
      await expect(p).resolves.toEqual({ url: null, reachable: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new flow supersedes the waiting one', async () => {
    const { flow } = setup();
    const first = flow.open(LOGIN);
    const second = flow.open(UPGRADE);
    await expect(first).resolves.toEqual({ url: null, reachable: true });
    flow.deliver('infinibot://callback?token=t');
    await expect(second).resolves.toEqual({ url: 'infinibot://callback?token=t', reachable: true });
  });

  it('ignores non-infinibot URLs and deliveries with nothing waiting', () => {
    const { flow } = setup();
    expect(flow.deliver('infinibot://callback?token=t')).toBe(false);
    flow.open(LOGIN);
    expect(flow.deliver('https://kinglyvault.com/callback')).toBe(false);
    expect(flow.isWaiting()).toBe(true);
  });
});

describe('main.js licence flows', () => {
  it('no longer opens licence sign-in or checkout in an Electron window', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/openKvFlow/);
    const signIn = src.slice(src.indexOf("ipcMain.handle('license:sign-in'"), src.indexOf("ipcMain.handle('auth:status'"));
    expect(signIn).toMatch(/kvBrowserFlow\.open\(/);
    expect(signIn).not.toMatch(/new BrowserWindow/);
    const upgrade = src.slice(src.indexOf("ipcMain.handle('wizard:openUpgrade'"), src.indexOf("ipcMain.handle('wizard:set-license-debug'"));
    expect(upgrade).toMatch(/kvBrowserFlow\.open\(/);
    expect(upgrade).not.toMatch(/new BrowserWindow/);
    expect(src).toMatch(/kvBrowserFlow\.deliver\(rawUrl\)/);
  });
});

describe('packaging', () => {
  it('ships kv-browser-flow.js in the desktop app', async () => {
    const fs = await import('node:fs');
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    expect(pkg.build.files).toContain('kv-browser-flow.js');
  });
});
