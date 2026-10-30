'use strict';

// State dir + infinibot.json IO for the desktop shell, shared by the wizard
// flows (local setup, satellite join) and the boot path.
//
// On a fresh install there is no state dir and no infinibot.json yet, so every
// write here creates the directory first and replaces the file atomically.
// Path resolution mirrors the gateway (src/config/paths.ts): INFINIBOT_STATE_DIR
// (trimmed, ~ expanded, made absolute) or <home>/.infinibot, and
// INFINIBOT_CONFIG_PATH overriding the config file. `pathImpl` and `homedir`
// are injectable so the Windows logic can be tested with path.win32.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIRNAME = '.infinibot';
const CONFIG_FILENAME = 'infinibot.json';

function resolveUserPath(input, { homedir = os.homedir, pathImpl = path } = {}) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('~')) {
    return pathImpl.resolve(trimmed.replace(/^~(?=$|[\\/])/, homedir()));
  }
  return pathImpl.resolve(trimmed);
}

function resolveStateDir({ env = process.env, homedir = os.homedir, pathImpl = path } = {}) {
  const override = env.INFINIBOT_STATE_DIR?.trim();
  if (override) return resolveUserPath(override, { homedir, pathImpl });
  return pathImpl.join(homedir(), STATE_DIRNAME);
}

function resolveConfigPath({ env = process.env, homedir = os.homedir, pathImpl = path } = {}) {
  const override = env.INFINIBOT_CONFIG_PATH?.trim();
  if (override) return resolveUserPath(override, { homedir, pathImpl });
  return pathImpl.join(resolveStateDir({ env, homedir, pathImpl }), CONFIG_FILENAME);
}

// Parsed config, or null when the file is missing or unreadable.
function readConfig(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

// Write via a temp file + rename so a crash never leaves a half-written config.
function writeConfigAtomic(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows: rename over a file another process holds open (antivirus,
    // an editor) fails with EPERM/EBUSY. Fall back to an in-place copy.
    try {
      fs.copyFileSync(tmp, file);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch {/* ignore */}
      throw err;
    }
    try { fs.rmSync(tmp, { force: true }); } catch {/* ignore */}
  }
}

// Create the state dir and a minimal valid infinibot.json when missing.
// Returns true when the file was created.
function ensureConfigFile(file) {
  if (fs.existsSync(file)) return false;
  writeConfigAtomic(file, {});
  return true;
}

function deepMergeConfig(target, src) {
  for (const k of Object.keys(src || {})) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
      deepMergeConfig(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

// Plain-language text for a config IO failure (shown in the wizard instead of
// a raw "ENOENT: no such file or directory, open …").
function describeConfigError(err, file) {
  const where = file ? ` (${file})` : '';
  switch (err?.code) {
    case 'ENOENT':
      return `InfiniBot couldn't create its settings folder${where}. Check the folder exists and isn't blocked, then try again.`;
    case 'EACCES':
    case 'EPERM':
      return `InfiniBot isn't allowed to save its settings${where}. Check the folder's permissions, or that antivirus or another program isn't locking it, then try again.`;
    case 'ENOTDIR':
    case 'EEXIST':
      return `A file is in the way of InfiniBot's settings folder${where}. Move or rename it, then try again.`;
    case 'EBUSY':
      return `The settings file is in use by another program${where}. Close it and try again.`;
    case 'ENOSPC':
      return `The disk is full, so InfiniBot couldn't save its settings${where}. Free up some space and try again.`;
    case 'EROFS':
      return `The settings folder is read-only${where}. Choose a writable location and try again.`;
    default:
      return `InfiniBot couldn't save its settings${where}: ${err?.message || String(err)}`;
  }
}

// Merge a partial config patch into infinibot.json, creating the state dir and
// the file when missing. A file that exists but can't be parsed is kept as a
// .bak rather than silently replaced. Returns { ok, created?, error?, code? }.
function applyConfigPatch(patch, { file = resolveConfigPath() } = {}) {
  try {
    const existed = fs.existsSync(file);
    let cfg = {};
    if (existed) {
      const parsed = readConfig(file);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
      else {
        try { fs.copyFileSync(file, `${file}.unreadable-${Date.now()}.bak`); } catch {/* best effort */}
      }
    }
    deepMergeConfig(cfg, patch);
    writeConfigAtomic(file, cfg);
    return { ok: true, created: !existed };
  } catch (err) {
    return { ok: false, code: err?.code, error: describeConfigError(err, file) };
  }
}

module.exports = {
  STATE_DIRNAME,
  CONFIG_FILENAME,
  resolveUserPath,
  resolveStateDir,
  resolveConfigPath,
  readConfig,
  writeConfigAtomic,
  ensureConfigFile,
  deepMergeConfig,
  describeConfigError,
  applyConfigPatch,
};
