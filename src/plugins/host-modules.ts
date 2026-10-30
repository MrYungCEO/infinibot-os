/**
 * Host dependency fallback for plugins that are not installed inside the
 * InfiniBot package tree.
 *
 * A bundled plugin (extensions/<id>) resolves host packages such as
 * `@sinclair/typebox` or `better-sqlite3` by walking up to the package's own
 * node_modules. The same plugin installed as a PACKAGE lives in
 * `<state>/extensions/<id>`, where that walk finds nothing, so a first-party
 * update from the registry would fail to load ("Cannot find module").
 *
 * This adds the host's node_modules folders to Node's module search path as a
 * LAST resort (NODE_PATH semantics): a plugin's own node_modules still wins,
 * and nothing changes for a module that already resolves.
 */

import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";

let installed: string[] | null = null;

/** node_modules folders the host itself resolves from, nearest first. */
export function hostNodeModulesDirs(fromUrl: string = import.meta.url): string[] {
  const paths = createRequire(fromUrl).resolve.paths("infinibot-host-probe") ?? [];
  return paths.filter((dir) => {
    try {
      return path.basename(dir) === "node_modules" && fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Idempotent. Returns the folders that are on the fallback path. */
export function ensureHostModuleFallback(fromUrl: string = import.meta.url): string[] {
  if (installed) return installed;
  const dirs = hostNodeModulesDirs(fromUrl);
  const current = (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean);
  const added = dirs.filter((dir) => !current.includes(dir));
  if (added.length) {
    process.env.NODE_PATH = [...current, ...added].join(path.delimiter);
    // Re-read NODE_PATH into the CJS resolver's global search paths.
    (Module as unknown as { _initPaths?: () => void })._initPaths?.();
  }
  installed = dirs;
  return dirs;
}
