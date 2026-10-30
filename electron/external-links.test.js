import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const xl = require('./external-links');

function fakeContents() {
  const c = new EventEmitter();
  c.setWindowOpenHandler = (fn) => { c.openHandler = fn; };
  return c;
}

function setup() {
  const opened = [];
  const lines = [];
  const shell = { openExternal: async (u) => { opened.push(u); } };
  const c = fakeContents();
  xl.guardWebContents(c, { shell, log: (l) => lines.push(l) });
  return { c, opened, lines };
}

function nav(c, event, url, isMainFrame = true) {
  let prevented = false;
  const e = { url, isMainFrame, preventDefault: () => { prevented = true; } };
  c.emit(event, e, url);
  return prevented;
}

describe('external-links (desktop: every external link opens in the default browser)', () => {
  it('classifies schemes: http/https/mailto external, infinibot passthrough, others blocked', () => {
    expect(xl.classify('https://claude.ai/login')).toBe('external');
    expect(xl.classify('mailto:a@b.c')).toBe('external');
    expect(xl.classify('infinibot://auth')).toBe('passthrough');
    expect(xl.classify('file:///etc/passwd')).toBe('block');
    expect(xl.classify('javascript:alert(1)')).toBe('block');
    expect(xl.classify('not a url')).toBe('block');
  });

  it('app origins stay in-app: loopback gateway any port, app files, origins main.js loaded', () => {
    expect(xl.isAppUrl('http://127.0.0.1:28789/setup')).toBe(true);
    expect(xl.isAppUrl('http://localhost:18790/chat')).toBe(true);
    expect(xl.isAppUrl('file:///app/resources/app.asar/wizard.html')).toBe(true);
    expect(xl.isAppUrl('https://accounts.google.com/o/oauth2')).toBe(false);
    xl.addAppOrigin('http://192.168.1.50:18789/?password=x');
    expect(xl.isAppUrl('http://192.168.1.50:18789/chat')).toBe(true);
  });

  it('window.open of a sign-in URL → denied in-app and handed to shell.openExternal', async () => {
    const { c, opened } = setup();
    expect(c.openHandler({ url: 'https://auth.openai.com/codex/device' })).toEqual({ action: 'deny' });
    await new Promise((r) => setImmediate(r));
    expect(opened).toEqual(['https://auth.openai.com/codex/device']);
  });

  it('window.open of an app page keeps opening in-app; file:/javascript: are blocked', async () => {
    const { c, opened } = setup();
    expect(c.openHandler({ url: 'http://127.0.0.1:28789/chat' })).toEqual({ action: 'allow' });
    expect(c.openHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    await new Promise((r) => setImmediate(r));
    expect(opened).toEqual([]);
  });

  it('main-frame navigation / redirect to an external site → prevented + external; app navigation untouched', async () => {
    const { c, opened } = setup();
    expect(nav(c, 'will-navigate', 'https://infinibotos.com/docs')).toBe(true);
    expect(nav(c, 'will-redirect', 'https://github.com/x')).toBe(true);
    expect(nav(c, 'will-navigate', 'http://127.0.0.1:28789/dashboard')).toBe(false);
    expect(nav(c, 'will-navigate', 'https://youtube.com/embed', false)).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(opened).toEqual(['https://infinibotos.com/docs', 'https://github.com/x']);
  });

  it('deliberate in-app browsers (KinglyVault, Cloud) and their popups keep their own behaviour', async () => {
    const { c, opened } = setup();
    xl.markInAppBrowser(c);
    expect(c.openHandler({ url: 'https://accounts.google.com/x' })).toEqual({ action: 'allow' });
    expect(nav(c, 'will-navigate', 'https://kinglyvault.com/login')).toBe(false);
    const child = fakeContents();
    c.emit('did-create-window', { webContents: child });
    expect(xl.isInAppBrowser(child)).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(opened).toEqual([]);
  });
});
