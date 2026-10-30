/**
 * Per-plugin data directory: size, export, import and clear.
 *
 * Every plugin's own data lives under `<stateDir>/plugin-data/<id>/`
 * (resolveStateDir() is tenant-namespaced in SaaS). Host services (Phase 0B
 * `api.storage.*`) write there; Setup › Plugins › Data reports its size and
 * can export it to a JSON bundle, restore a bundle, or clear it.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

export const PLUGIN_DATA_BUNDLE_FORMAT = "infinibot-plugin-data@1";
/** Export/import cap so a bundle fits one WS frame comfortably. */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function resolvePluginDataRoot(): string {
  return path.join(resolveStateDir(), "plugin-data");
}

export function resolvePluginDataDir(pluginId: string): string {
  if (!ID_RE.test(pluginId)) throw new Error(`invalid plugin id "${pluginId}"`);
  return path.join(resolvePluginDataRoot(), pluginId);
}

type FileEntry = { rel: string; abs: string; size: number };

function walk(root: string): FileEntry[] {
  const out: FileEntry[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile()) {
        out.push({
          rel: path.relative(root, abs).split(path.sep).join("/"),
          abs,
          size: fs.statSync(abs).size,
        });
      }
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function pluginDataSummary(pluginId: string): {
  dir: string;
  exists: boolean;
  bytes: number;
  files: number;
} {
  const dir = resolvePluginDataDir(pluginId);
  const files = walk(dir);
  return {
    dir,
    exists: fs.existsSync(dir),
    bytes: files.reduce((n, f) => n + f.size, 0),
    files: files.length,
  };
}

export type PluginDataBundle = {
  format: typeof PLUGIN_DATA_BUNDLE_FORMAT;
  pluginId: string;
  exportedAt: string;
  files: { path: string; size: number; base64: string }[];
};

export function exportPluginData(pluginId: string): PluginDataBundle {
  const dir = resolvePluginDataDir(pluginId);
  const files = walk(dir);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_BUNDLE_BYTES) {
    throw new Error(`plugin data is ${total} bytes; export is capped at ${MAX_BUNDLE_BYTES}`);
  }
  return {
    format: PLUGIN_DATA_BUNDLE_FORMAT,
    pluginId,
    exportedAt: new Date().toISOString(),
    files: files.map((f) => ({
      path: f.rel,
      size: f.size,
      base64: fs.readFileSync(f.abs).toString("base64"),
    })),
  };
}

/** Restore a bundle into the plugin's data dir. `replace` clears it first. */
export function importPluginData(
  pluginId: string,
  bundle: unknown,
  mode: "merge" | "replace" = "merge",
): { written: number; bytes: number } {
  const b = bundle as Partial<PluginDataBundle> | null;
  if (!b || b.format !== PLUGIN_DATA_BUNDLE_FORMAT || !Array.isArray(b.files)) {
    throw new Error(`not a ${PLUGIN_DATA_BUNDLE_FORMAT} bundle`);
  }
  if (b.pluginId !== pluginId) {
    throw new Error(`bundle belongs to "${String(b.pluginId)}", not "${pluginId}"`);
  }
  const dir = resolvePluginDataDir(pluginId);
  const decoded: { abs: string; data: Buffer }[] = [];
  let bytes = 0;
  for (const f of b.files) {
    if (!f || typeof f.path !== "string" || typeof f.base64 !== "string")
      throw new Error("malformed bundle entry");
    const abs = path.resolve(dir, f.path);
    if (!abs.startsWith(dir + path.sep))
      throw new Error(`bundle path escapes the data dir: ${f.path}`);
    const data = Buffer.from(f.base64, "base64");
    bytes += data.length;
    if (bytes > MAX_BUNDLE_BYTES) throw new Error("bundle too large");
    decoded.push({ abs, data });
  }
  if (mode === "replace") fs.rmSync(dir, { recursive: true, force: true });
  for (const { abs, data } of decoded) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
  return { written: decoded.length, bytes };
}

export function clearPluginData(pluginId: string): { removed: boolean; bytes: number } {
  const summary = pluginDataSummary(pluginId);
  fs.rmSync(summary.dir, { recursive: true, force: true });
  return { removed: summary.exists, bytes: summary.bytes };
}
