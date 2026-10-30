import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ComponentInstaller } = require('./installer');

const MANIFEST = {
  baseUrl: 'https://example.test/dl',
  components: [
    { name: 'video', title: 'Video tools', description: 'ffmpeg', asset: 'video.tar.gz', sha256: '', size: 100 },
    { name: 'image', title: 'Image gen tools', description: 'sharp', asset: 'image.tar.gz', sha256: '', size: 200 },
  ],
};

function mkBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ib-comp-'));
}

describe('ComponentInstaller', () => {
  let baseDir;
  beforeEach(() => { baseDir = mkBase(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it('list() reports all packs as not-installed initially', () => {
    const inst = new ComponentInstaller({ baseDir, manifest: MANIFEST, mock: true });
    const packs = inst.list();
    expect(packs).toHaveLength(2);
    expect(packs.every((p) => p.installed === false)).toBe(true);
    expect(packs.map((p) => p.name).sort()).toEqual(['image', 'video']);
  });

  it('install() in mock mode writes files + marks installed', async () => {
    const inst = new ComponentInstaller({ baseDir, manifest: MANIFEST, mock: true });
    const phases = [];
    await inst.install('video', (p) => phases.push(p.phase));
    expect(inst.status('video').installed).toBe(true);
    expect(phases).toContain('download');
    expect(phases).toContain('done');
    // components.json records the install
    const state = JSON.parse(fs.readFileSync(path.join(baseDir, 'components.json'), 'utf8'));
    expect(state.installed.video).toBeTruthy();
  });

  it('remove() is reversible — pack can be re-installed', async () => {
    const inst = new ComponentInstaller({ baseDir, manifest: MANIFEST, mock: true });
    await inst.install('image');
    expect(inst.status('image').installed).toBe(true);
    await inst.remove('image');
    expect(inst.status('image').installed).toBe(false);
    // re-install still works
    await inst.install('image');
    expect(inst.status('image').installed).toBe(true);
  });

  it('install() verifies sha256 and rejects a mismatch', async () => {
    const body = Buffer.from('real-payload');
    const goodHash = crypto.createHash('sha256').update(body).digest('hex');
    const manifest = {
      baseUrl: 'https://example.test/dl',
      components: [{ name: 'video', title: 'V', description: '', asset: 'v.bin', sha256: 'deadbeef', size: 1 }],
    };
    const fetchImpl = async () => ({ buffer: body, sha256: goodHash });
    const inst = new ComponentInstaller({ baseDir, manifest, mock: false, fetchImpl });
    await expect(inst.install('video')).rejects.toThrow(/Checksum mismatch/);
    expect(inst.status('video').installed).toBe(false);
  });

  it('install() accepts a matching sha256 via injected fetch', async () => {
    const body = Buffer.from('real-payload');
    const goodHash = crypto.createHash('sha256').update(body).digest('hex');
    const manifest = {
      baseUrl: 'https://example.test/dl',
      components: [{ name: 'video', title: 'V', description: '', asset: 'v.bin', sha256: goodHash, size: 1 }],
    };
    const fetchImpl = async () => ({ buffer: body, sha256: goodHash });
    const inst = new ComponentInstaller({ baseDir, manifest, mock: false, fetchImpl });
    await inst.install('video');
    expect(inst.status('video').installed).toBe(true);
  });

  it('unknown component throws', () => {
    const inst = new ComponentInstaller({ baseDir, manifest: MANIFEST, mock: true });
    expect(() => inst.status('nope')).toThrow(/Unknown component/);
  });

  it('requestedAtSetup reflects NSIS components.json selection', () => {
    fs.writeFileSync(path.join(baseDir, 'components.json'),
      JSON.stringify({ selected: { image: true, video: false } }));
    const inst = new ComponentInstaller({ baseDir, manifest: MANIFEST, mock: true });
    const packs = inst.list();
    expect(packs.find((p) => p.name === 'image').requestedAtSetup).toBe(true);
    expect(packs.find((p) => p.name === 'video').requestedAtSetup).toBe(false);
  });
});
