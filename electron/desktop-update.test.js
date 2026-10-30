import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const du = require('./desktop-update');

describe('desktop-update (main process)', () => {
  it('compareVersions orders calendar versions numerically', () => {
    expect(du.compareVersions('2026.10.18', '2026.10.9')).toBe(1);
    expect(du.compareVersions('2026.10.7', '2026.10.9')).toBe(-1);
    expect(du.compareVersions('v2026.10.18', '2026.10.18')).toBe(0);
    expect(du.compareVersions('2026.10.18', '2026.10.18-beta.1')).toBe(1);
    expect(du.compareVersions('nope', '2026.10.9')).toBe(0);
  });

  it('package type decides self-update and the download link', () => {
    const t = (platform, env = {}, isPackaged = true) => du.desktopPackageType({ platform, env, isPackaged });
    expect(t('win32')).toBe('nsis');
    expect(t('linux', { APPIMAGE: '/home/u/InfiniBot-x86_64.AppImage' })).toBe('appimage');
    expect(t('linux', {})).toBe('deb');
    expect(t('linux', {}, false)).toBe('dev');
    expect(du.canSelfUpdate('nsis')).toBe(true);
    expect(du.canSelfUpdate('appimage')).toBe(true);
    expect(du.canSelfUpdate('deb')).toBe(false);
    expect(du.desktopDownloadUrl('nsis')).toBe('https://infinibotos.com/download/windows');
    expect(du.desktopDownloadUrl('appimage')).toBe('https://infinibotos.com/download/linux');
    expect(du.desktopDownloadUrl('deb')).toMatch(/infinibot-desktop-releases\/releases\/latest\/download\/infinibot_amd64\.deb$/);
  });

  it('reads the version from the platform feed', async () => {
    const seen = [];
    const v = await du.fetchLatestDesktopVersion({
      platform: 'linux',
      fetchImpl: async (url) => {
        seen.push(url);
        return { ok: true, status: 200, text: async () => "version: 2026.10.18\npath: InfiniBot-x86_64.AppImage\n" };
      },
    });
    expect(v).toBe('2026.10.18');
    expect(seen[0]).toBe('https://github.com/MrYungCEO/infinibot-desktop-releases/releases/latest/download/latest-linux.yml');
    expect(du.feedUrlFor('win32')).toMatch(/latest\.yml$/);
    await expect(du.fetchLatestDesktopVersion({ fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) }))
      .rejects.toThrow('feed HTTP 404');
  });

  it('is packaged (main.js requires it at startup)', () => {
    expect(require('./package.json').build.files).toContain('desktop-update.js');
  });

  it('release build config drops publisherName (unsigned installers must still self-update)', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-stage-'));
    fs.mkdirSync(path.join(stage, 'dist'));
    fs.writeFileSync(path.join(stage, 'dist', 'entry.js'), '');
    process.env.IB_DESKTOP_STAGE = stage;
    try {
      const cfg = require('./electron-builder.release.cjs');
      expect(cfg.win.publisherName).toBeNull();
      expect(cfg.publish[0]).toMatchObject({ provider: 'github', owner: 'MrYungCEO', repo: 'infinibot-desktop-releases' });
    } finally {
      delete process.env.IB_DESKTOP_STAGE;
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
});
