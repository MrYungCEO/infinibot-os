/**
 * In-memory plugin package builders for tests and the local mock registry.
 * Not used by the gateway at runtime.
 */

import JSZip from "jszip";

import { scaffoldPluginFiles } from "./scaffold.js";

export type FixtureOptions = {
  id?: string;
  name?: string;
  version?: string;
  publisher?: string;
  minHostVersion?: string;
  permissions?: Record<string, unknown>;
  /** Shallow-merged into the manifest last (use to break it on purpose). */
  manifest?: Record<string, unknown>;
  /** Extra files (path → content); `null` removes a scaffold file. */
  files?: Record<string, string | Buffer | null>;
  /** Wrap everything in one top-level folder. */
  wrapIn?: string;
  changelog?: string;
};

/** Files of a valid package (the scaffold, with overrides). */
export function fixturePackageFiles(opts: FixtureOptions = {}): Record<string, string | Buffer> {
  const id = opts.id ?? "demo-plugin";
  const base = scaffoldPluginFiles({
    id,
    name: opts.name ?? "Demo Plugin",
    publisher: opts.publisher ?? "acme",
  });
  const manifest = JSON.parse(base["infinibot.plugin.json"] as string) as Record<string, unknown>;
  if (opts.version) manifest.version = opts.version;
  if (opts.minHostVersion) manifest.minHostVersion = opts.minHostVersion;
  if (opts.permissions) manifest.permissions = opts.permissions;
  Object.assign(manifest, opts.manifest ?? {});
  for (const [k, v] of Object.entries(manifest)) if (v === undefined) delete manifest[k];
  const files: Record<string, string | Buffer> = {
    ...base,
    "infinibot.plugin.json": `${JSON.stringify(manifest, null, 2)}\n`,
  };
  delete files[".ibpluginignore"];
  if (opts.changelog) files["CHANGELOG.md"] = opts.changelog;
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    if (content === null) delete files[rel];
    else files[rel] = content;
  }
  return files;
}

/** Zip arbitrary entries exactly as given (names are NOT sanitised). */
export async function zipEntries(
  entries: Record<string, string | Buffer>,
  opts: { modes?: Record<string, number>; store?: boolean } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content, {
      date: new Date(Date.UTC(1980, 0, 1)),
      unixPermissions: opts.modes?.[name] ?? 0o644,
      createFolders: false,
    });
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: opts.store ? "STORE" : "DEFLATE",
    platform: "UNIX",
  });
}

/** A valid package zip (or a deliberately broken one via `opts`). */
export async function fixturePackageZip(opts: FixtureOptions = {}): Promise<Buffer> {
  const files = fixturePackageFiles(opts);
  const prefix = opts.wrapIn ? `${opts.wrapIn}/` : "";
  return zipEntries(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [`${prefix}${k}`, v])),
  );
}
