'use strict';
/**
 * InfiniBot optional-component installer.
 *
 * Single source of truth for the download-on-demand packs that are kept OUT of
 * the base installer (see electron/package.json build.extraResources excludes
 * and electron/build/installer.nsh). The same module backs both the NSIS
 * install-time selection and the Settings -> Components tab.
 *
 * Designed to run in the Electron main process, but takes all of its
 * environment via the constructor so it can be unit-tested under plain Node /
 * vitest with no Electron and no network (mock mode).
 *
 * API: list(), status(name), install(name, onProgress), remove(name)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const DEFAULT_MANIFEST_PATH = path.join(__dirname, 'manifest.json');

class ComponentInstaller {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir            userData dir (holds components.json + components/)
   * @param {object} [opts.manifest]         parsed manifest; defaults to manifest.json
   * @param {Function} [opts.fetchImpl]      (url, {onData,onError,onEnd}) downloader; injectable for tests
   * @param {boolean} [opts.mock]            if true, "download" writes a synthetic file (no network)
   */
  constructor(opts = {}) {
    this.baseDir = opts.baseDir || process.cwd();
    this.manifest = opts.manifest || JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8'));
    this.mock = opts.mock != null ? !!opts.mock : process.env.INFINIBOT_COMPONENTS_MOCK === '1';
    this.fetchImpl = opts.fetchImpl || null;
    this.componentsDir = path.join(this.baseDir, 'components');
    this.statePath = path.join(this.baseDir, 'components.json');
  }

  _def(name) {
    return (this.manifest.components || []).find((c) => c.name === name) || null;
  }

  _assetUrl(def) {
    if (def.url) return def.url;
    const base = (this.manifest.baseUrl || '').replace(/\/+$/, '');
    return `${base}/${def.asset}`;
  }

  _installRoot(name) {
    return path.join(this.componentsDir, name);
  }

  // ---- state (components.json) ----
  _readState() {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  async _writeState(state) {
    await fsp.mkdir(this.baseDir, { recursive: true });
    await fsp.writeFile(this.statePath, JSON.stringify(state, null, 2));
  }

  /** Is the pack present on disk (installed marker + files)? */
  _isInstalled(name) {
    try {
      return fs.existsSync(path.join(this._installRoot(name), '.installed'));
    } catch {
      return false;
    }
  }

  /** list() -> array of pack descriptors with live install state */
  list() {
    const state = this._readState();
    const selected = (state.selected || {});
    return (this.manifest.components || []).map((c) => ({
      name: c.name,
      title: c.title,
      description: c.description,
      size: c.size || 0,
      enablesFeatures: c.enablesFeatures || [],
      installed: this._isInstalled(c.name),
      requestedAtSetup: selected[c.name] === true,
    }));
  }

  /** status(name) -> { name, installed, installing, version } */
  status(name) {
    const def = this._def(name);
    if (!def) throw new Error(`Unknown component: ${name}`);
    return {
      name,
      installed: this._isInstalled(name),
      title: def.title,
      size: def.size || 0,
    };
  }

  _download(url, onProgress) {
    if (this.fetchImpl) return this.fetchImpl(url, onProgress);
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('http://') ? http : https;
      const req = lib.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          this._download(res.headers.location, onProgress).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        const hash = crypto.createHash('sha256');
        const chunks = [];
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          hash.update(chunk);
          chunks.push(chunk);
          if (onProgress && total) onProgress({ received, total, percent: received / total });
        });
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), sha256: hash.digest('hex') }));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  /**
   * install(name, onProgress) — download, verify sha256, unpack marker.
   * onProgress receives { phase, percent, received, total, name }.
   */
  async install(name, onProgress = () => {}) {
    const def = this._def(name);
    if (!def) throw new Error(`Unknown component: ${name}`);
    if (this._isInstalled(name)) {
      onProgress({ phase: 'done', percent: 1, name });
      return this.status(name);
    }

    const root = this._installRoot(name);
    await fsp.mkdir(root, { recursive: true });
    const emit = (p) => { try { onProgress({ ...p, name }); } catch { /* ignore */ } };

    let result;
    if (this.mock) {
      // Local verification path: synthesize the asset, no network.
      emit({ phase: 'download', percent: 0.5, received: 1, total: 2 });
      const buffer = Buffer.from(`mock-component:${name}:${def.asset}`);
      result = { buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
      emit({ phase: 'download', percent: 1, received: 2, total: 2 });
    } else {
      emit({ phase: 'download', percent: 0 });
      result = await this._download(this._assetUrl(def), (p) =>
        emit({ phase: 'download', percent: p.percent, received: p.received, total: p.total }));
    }

    // Integrity check (only when manifest pins a sha256).
    emit({ phase: 'verify', percent: 1 });
    if (def.sha256 && def.sha256.length > 0 && def.sha256 !== result.sha256) {
      await fsp.rm(root, { recursive: true, force: true });
      throw new Error(`Checksum mismatch for ${name}: expected ${def.sha256}, got ${result.sha256}`);
    }

    // Persist the asset + an .installed marker. (Real packs would untar here.)
    await fsp.writeFile(path.join(root, def.asset || `${name}.bin`), result.buffer);
    await fsp.writeFile(path.join(root, '.installed'), JSON.stringify({
      name,
      asset: def.asset,
      sha256: result.sha256,
      bytes: result.buffer.length,
    }, null, 2));

    const state = this._readState();
    state.installed = state.installed || {};
    state.installed[name] = { sha256: result.sha256, bytes: result.buffer.length };
    await this._writeState(state);

    emit({ phase: 'done', percent: 1 });
    return this.status(name);
  }

  /** remove(name) — reversible; deletes files + clears installed flag (selection preserved). */
  async remove(name) {
    const def = this._def(name);
    if (!def) throw new Error(`Unknown component: ${name}`);
    await fsp.rm(this._installRoot(name), { recursive: true, force: true });
    const state = this._readState();
    if (state.installed) delete state.installed[name];
    await this._writeState(state);
    return this.status(name);
  }
}

module.exports = { ComponentInstaller, DEFAULT_MANIFEST_PATH };
