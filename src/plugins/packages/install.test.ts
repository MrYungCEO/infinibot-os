import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../../config/config.js";
import { validateConfigObject } from "../../config/config.js";
import { normalizePluginsConfig, resolveEnableState } from "../config-state.js";
import { supersededPluginRoots } from "../loader.js";
import { loadPluginManifest } from "../manifest.js";
import {
  commitPluginPackage,
  inspectPluginPackage,
  rollbackPluginPackage,
  tenantInstallRefusal,
  type ExistingPlugin,
  type PackageSource,
} from "./install.js";
import {
  fixturePackageFiles,
  fixturePackageZip,
  zipEntries,
  type FixtureOptions,
} from "./package-fixtures.js";
import { resolvePackagePaths, type PackagePaths } from "./store.js";
import { PackageError, sha256OfBuffer } from "./zip-read.js";

const temps: string[] = [];
function sandbox(): PackagePaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-pkg-install-"));
  temps.push(dir);
  return resolvePackagePaths(dir);
}
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

const ZIP: PackageSource = { kind: "zip", fileName: "demo.zip" };
const HOST = "2026.6.30";
const NO_ENV = {} as NodeJS.ProcessEnv;

/** What discovery would report for an id, from the sandbox + optional extras. */
function existingFrom(paths: PackagePaths, extra: ExistingPlugin[] = []) {
  return (id: string): ExistingPlugin[] => {
    const out = [...extra];
    const dir = path.join(paths.extensionsDir, id);
    const m = fs.existsSync(dir) ? loadPluginManifest(dir) : null;
    if (m?.ok) out.unshift({ origin: "global", version: m.manifest.version, rootDir: dir });
    return out;
  };
}

async function inspect(
  paths: PackagePaths,
  config: InfinibotConfig,
  fixture: FixtureOptions | Buffer,
  more: Partial<Parameters<typeof inspectPluginPackage>[0]> & { extra?: ExistingPlugin[] } = {},
) {
  const { extra, ...rest } = more;
  return inspectPluginPackage({
    buffer: Buffer.isBuffer(fixture) ? fixture : await fixturePackageZip(fixture),
    source: ZIP,
    config,
    hostVersion: HOST,
    env: NO_ENV,
    paths,
    resolveExisting: existingFrom(paths, extra),
    ...rest,
  });
}

/** Inspect + commit accepting everything; returns the new config. */
async function install(paths: PackagePaths, config: InfinibotConfig, fixture: FixtureOptions) {
  const inspection = await inspect(paths, config, fixture);
  return commitPluginPackage(inspection, {
    config,
    acceptedPermissions: inspection.permissionKeys,
    paths,
  });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(PackageError);
    return (err as PackageError).code;
  }
  throw new Error("expected a PackageError");
}

describe("zip import", () => {
  it("installs into extensions/<id>, records the install, and leaves the plugin OFF", async () => {
    const paths = sandbox();
    const buffer = await fixturePackageZip({ permissions: { network: ["api.example.com"] } });
    const inspection = await inspect(paths, {}, buffer);
    expect(inspection).toMatchObject({
      action: "install",
      sha256: sha256OfBuffer(buffer),
      permissionKeys: ["network:api.example.com"],
      newPermissions: ["network:api.example.com"],
      needsOverrideConfirmation: false,
    });
    // Inspecting writes nothing.
    expect(fs.existsSync(paths.extensionsDir)).toBe(false);

    const res = await commitPluginPackage(inspection, {
      config: {},
      acceptedPermissions: ["network:api.example.com"],
      paths,
      now: () => new Date("2026-10-02T10:00:00Z"),
    });
    const target = path.join(paths.extensionsDir, "demo-plugin");
    expect(res.targetDir).toBe(target);
    expect(fs.existsSync(path.join(target, "index.js"))).toBe(true);
    expect(fs.readdirSync(paths.stagingDir)).toEqual([]);
    expect(res.config.plugins?.installs?.["demo-plugin"]).toEqual({
      source: "zip",
      installPath: target,
      version: "0.1.0",
      installedAt: "2026-10-02T10:00:00.000Z",
      sha256: sha256OfBuffer(buffer),
      sizeBytes: buffer.length,
      reviewedPermissions: ["network:api.example.com"],
    });
    // The record is valid config.
    expect(validateConfigObject(res.config).ok).toBe(true);
    // Never auto-enabled: no entry is written, and the loader treats a package
    // install without an explicit "on" as off.
    expect(res.config.plugins?.entries?.["demo-plugin"]).toBeUndefined();
    expect(
      resolveEnableState("demo-plugin", "global", normalizePluginsConfig(res.config.plugins)),
    ).toEqual({ enabled: false, reason: "installed (not turned on yet)" });
    // …while a hand-placed (non-package) global plugin keeps today's behaviour.
    expect(
      resolveEnableState("other", "global", normalizePluginsConfig(res.config.plugins)).enabled,
    ).toBe(true);
  });

  it("accepts a package wrapped in one top-level folder", async () => {
    const paths = sandbox();
    const res = await install(paths, {}, { wrapIn: "demo-plugin-0.1.0" });
    expect(fs.existsSync(path.join(res.targetDir, "infinibot.plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(res.targetDir, "demo-plugin-0.1.0"))).toBe(false);
  });

  it("does not inherit a leftover 'on' switch or old grants on a fresh install", async () => {
    const paths = sandbox();
    const config: InfinibotConfig = {
      plugins: {
        entries: {
          "demo-plugin": {
            enabled: true,
            config: { greeting: "Hi" },
            permissions: { granted: ["gated:orders"] },
          },
        },
      },
    };
    const res = await install(paths, config, {
      permissions: { gated: [{ id: "orders", label: "Orders" }] },
    });
    expect(res.config.plugins?.entries?.["demo-plugin"]).toEqual({
      enabled: false,
      config: { greeting: "Hi" },
    });
  });

  it("verifies sha256 when supplied", async () => {
    const paths = sandbox();
    const buffer = await fixturePackageZip();
    await expect(
      inspect(paths, {}, buffer, { expectedSha256: `sha256:${sha256OfBuffer(buffer)}` }),
    ).resolves.toBeTruthy();
    expect(await codeOf(inspect(paths, {}, buffer, { expectedSha256: "0".repeat(64) }))).toBe(
      "checksum",
    );
    expect(await codeOf(inspect(paths, {}, buffer, { expectedSha256: "not-a-hash" }))).toBe(
      "checksum",
    );
    expect(fs.existsSync(paths.extensionsDir)).toBe(false);
  });

  it("validates the manifest before extracting anything", async () => {
    const paths = sandbox();
    expect(await codeOf(inspect(paths, {}, { manifest: { version: "1.0" } }))).toBe("manifest");
    expect(await codeOf(inspect(paths, {}, { manifest: { publisher: undefined } }))).toBe(
      "manifest",
    );
    expect(await codeOf(inspect(paths, {}, { manifest: { id: "plugins" } }))).toBe("manifest");
    expect(await codeOf(inspect(paths, {}, { files: { "index.js": null } }))).toBe("manifest");
    expect(await codeOf(inspect(paths, {}, { files: { "infinibot.plugin.json": "{ nope" } }))).toBe(
      "manifest",
    );
    expect(await codeOf(inspect(paths, {}, {}, { expectedId: "something-else" }))).toBe("manifest");
    expect(fs.existsSync(paths.extensionsDir)).toBe(false);
    expect(fs.existsSync(paths.stagingDir)).toBe(false);
  });

  it("rejects hostile zips before touching the disk", async () => {
    const paths = sandbox();
    const slip = await zipEntries({ ...fixturePackageFiles(), "../../escape.txt": "x" });
    expect(await codeOf(inspect(paths, {}, slip))).toBe("unsafe-path");
    const link = await zipEntries(
      { ...fixturePackageFiles(), l: "/etc/passwd" },
      { modes: { l: 0o120777 } },
    );
    expect(await codeOf(inspect(paths, {}, link))).toBe("symlink");
    expect(fs.existsSync(paths.extensionsDir)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(paths.extensionsDir), "..", "escape.txt"))).toBe(
      false,
    );
  });

  it("gates on minHostVersion and the plugin API range", async () => {
    const paths = sandbox();
    expect(await codeOf(inspect(paths, {}, { minHostVersion: "2027.1.0" }))).toBe("host");
    expect(
      await codeOf(
        inspect(paths, {}, { manifest: { engines: { "infinibot-plugin-api": "^9.0.0" } } }),
      ),
    ).toBe("host");
    await expect(inspect(paths, {}, { minHostVersion: "2026.6.30" })).resolves.toBeTruthy();
  });

  it("requires the permission review to be accepted", async () => {
    const paths = sandbox();
    const inspection = await inspect(
      paths,
      {},
      { permissions: { exec: true, network: ["a.example"] } },
    );
    expect(
      await codeOf(
        commitPluginPackage(inspection, { config: {}, acceptedPermissions: ["exec"], paths }),
      ),
    ).toBe("permissions");
    // A refused commit leaves nothing behind.
    expect(fs.existsSync(path.join(paths.extensionsDir, "demo-plugin"))).toBe(false);
    const ok = await commitPluginPackage(inspection, {
      config: {},
      acceptedPermissions: ["exec", "network:a.example"],
      paths,
    });
    expect(ok.action).toBe("install");
  });

  it("never grants gated permissions", async () => {
    const paths = sandbox();
    const inspection = await inspect(
      paths,
      {},
      { permissions: { gated: [{ id: "orders", label: "Place orders" }] } },
    );
    expect(inspection.gatedPermissions).toEqual(["gated:orders"]);
    const res = await commitPluginPackage(inspection, {
      config: {},
      acceptedPermissions: ["gated:orders"],
      paths,
    });
    // Accepting the review is not a grant.
    expect(res.config.plugins?.entries?.["demo-plugin"]?.permissions).toBeUndefined();
  });

  it("honours the denylist", async () => {
    const paths = sandbox();
    expect(await codeOf(inspect(paths, { plugins: { deny: ["demo-plugin"] } }, {}))).toBe("policy");
  });
});

describe("id collision rules", () => {
  it("refuses an id already loaded from a workspace or a config path", async () => {
    const paths = sandbox();
    expect(
      await codeOf(
        inspect(
          paths,
          {},
          {},
          { extra: [{ origin: "workspace", version: "9.9.9", rootDir: "/ws/demo" }] },
        ),
      ),
    ).toBe("collision");
  });

  it("refuses to overwrite a folder that was not installed as a package", async () => {
    const paths = sandbox();
    const dir = path.join(paths.extensionsDir, "demo-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hand-made.txt"), "mine");
    expect(await codeOf(inspect(paths, {}, {}))).toBe("collision");
    expect(fs.readFileSync(path.join(dir, "hand-made.txt"), "utf-8")).toBe("mine");
  });

  it("same version = reinstall, older = downgrade: both need an explicit flag", async () => {
    const paths = sandbox();
    const first = await install(paths, {}, { version: "1.1.0" });
    // The very same file again: nothing to install (the UI offers "Enable").
    const identical = await inspect(paths, first.config, { version: "1.1.0" });
    expect(identical).toMatchObject({ action: "already-installed", existingOrigin: "package" });
    expect(
      await codeOf(
        commitPluginPackage(identical, { config: first.config, acceptedPermissions: [], paths }),
      ),
    ).toBe("collision");
    // Same version, different bytes: a repair reinstall, behind a flag.
    const same = await inspect(paths, first.config, {
      version: "1.1.0",
      files: { "NOTES.md": "rebuilt" },
    });
    expect(same.action).toBe("reinstall");
    expect(
      await codeOf(
        commitPluginPackage(same, { config: first.config, acceptedPermissions: [], paths }),
      ),
    ).toBe("collision");
    const older = await inspect(paths, first.config, { version: "1.0.0" });
    expect(older.action).toBe("downgrade");
    expect(
      await codeOf(
        commitPluginPackage(older, { config: first.config, acceptedPermissions: [], paths }),
      ),
    ).toBe("collision");
    const forced = await commitPluginPackage(older, {
      config: first.config,
      acceptedPermissions: [],
      allowDowngrade: true,
      paths,
    });
    expect(forced.version).toBe("1.0.0");
  });

  it("importing a bundled plugin at the same or an older version is not an error: it is already here", async () => {
    const paths = sandbox();
    const bundled: ExistingPlugin = {
      origin: "bundled",
      version: "2026.9.28",
      rootDir: "/app/extensions/demo-plugin",
    };
    for (const version of ["2026.9.28", "2026.1.1"]) {
      const same = await inspect(paths, {}, { version }, { extra: [bundled] });
      expect(same).toMatchObject({
        action: "already-installed",
        existingOrigin: "bundled",
        currentVersion: "2026.9.28",
        newPermissions: [],
        needsOverrideConfirmation: false,
      });
      // Nothing is written: commit refuses, and the extensions dir stays empty.
      expect(
        await codeOf(commitPluginPackage(same, { config: {}, acceptedPermissions: [], paths })),
      ).toBe("collision");
      expect(fs.existsSync(path.join(paths.extensionsDir, "demo-plugin"))).toBe(false);
    }
  });

  it("a package may replace a bundled plugin only with a NEWER version and explicit confirmation", async () => {
    const paths = sandbox();
    const bundled: ExistingPlugin = {
      origin: "bundled",
      version: "2026.9.28",
      rootDir: "/app/extensions/demo-plugin",
    };

    const newer = await inspect(paths, {}, { version: "2026.10.1" }, { extra: [bundled] });
    expect(newer).toMatchObject({
      action: "override-bundled",
      currentVersion: "2026.9.28",
      needsOverrideConfirmation: true,
    });
    expect(newer.warnings.join(" ")).toMatch(/replaces the Demo Plugin that ships with InfiniBot/);
    expect(
      await codeOf(commitPluginPackage(newer, { config: {}, acceptedPermissions: [], paths })),
    ).toBe("collision");

    const res = await commitPluginPackage(newer, {
      config: {},
      acceptedPermissions: [],
      overrideBundled: true,
      paths,
    });
    expect(res.record).toMatchObject({
      overridesBundled: true,
      previous: { version: "2026.9.28", bundled: true },
    });
  });

  it("a first-party registry entry with a verified checksum overrides a bundled plugin without the prompt", async () => {
    const paths = sandbox();
    const buffer = await fixturePackageZip({ version: "2026.10.1" });
    const bundled: ExistingPlugin = {
      origin: "bundled",
      version: "2026.9.28",
      rootDir: "/app/extensions/demo-plugin",
    };
    const source: PackageSource = {
      kind: "registry",
      registryUrl: "https://r.example",
      firstParty: true,
    };
    const vouched = await inspect(paths, {}, buffer, {
      extra: [bundled],
      source,
      expectedSha256: sha256OfBuffer(buffer),
    });
    expect(vouched.needsOverrideConfirmation).toBe(false);
    // …but not when the entry is third-party, or the checksum was not checked.
    const third = await inspect(paths, {}, buffer, {
      extra: [bundled],
      source: { ...source, firstParty: false },
      expectedSha256: sha256OfBuffer(buffer),
    });
    expect(third.needsOverrideConfirmation).toBe(true);
    const unchecked = await inspect(paths, {}, buffer, { extra: [bundled], source });
    expect(unchecked.needsOverrideConfirmation).toBe(true);
  });

  it("the loader prefers whichever of installed/bundled is newer", () => {
    const rec = (origin: "global" | "bundled", version: string, rootDir: string) => ({
      id: "p",
      origin,
      version,
      rootDir,
    });
    // Installed package newer than the bundle → package wins (nothing superseded).
    expect(
      supersededPluginRoots([rec("global", "2.0.0", "/g"), rec("bundled", "1.0.0", "/b")]).size,
    ).toBe(0);
    // Same version → installed wins.
    expect(
      supersededPluginRoots([rec("global", "1.0.0", "/g"), rec("bundled", "1.0.0", "/b")]).size,
    ).toBe(0);
    // A host upgrade shipped a newer bundle → the stale package steps aside.
    const map = supersededPluginRoots([
      rec("global", "1.0.0", "/g"),
      rec("bundled", "1.5.0", "/b"),
    ]);
    expect(map.get("/g")).toMatch(/newer bundled version 1.5.0/);
  });
});

describe("update, permission re-prompt, rollback", () => {
  it("keeps data, the on/off switch, settings and grants; keeps the previous version for rollback", async () => {
    const paths = sandbox();
    const v1 = await install(
      paths,
      {},
      {
        version: "1.0.0",
        permissions: { network: ["a.example"], gated: [{ id: "orders", label: "Orders" }] },
      },
    );
    // The owner turned it on, configured it and granted the gated permission.
    const configured: InfinibotConfig = {
      ...v1.config,
      plugins: {
        ...v1.config.plugins,
        entries: {
          "demo-plugin": {
            enabled: true,
            config: { greeting: "Yo" },
            permissions: { granted: ["gated:orders"], revoked: ["network:a.example"] },
            autoUpdate: true,
          },
        },
      },
    };
    fs.writeFileSync(path.join(v1.targetDir, "v1-marker.txt"), "v1");
    const dataDir = path.join(path.dirname(paths.extensionsDir), "plugin-data", "demo-plugin");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "state.json"), "{}");

    const inspection = await inspect(paths, configured, {
      version: "1.1.0",
      permissions: { network: ["a.example"], gated: [{ id: "orders", label: "Orders" }] },
    });
    expect(inspection).toMatchObject({
      action: "update",
      currentVersion: "1.0.0",
      newPermissions: [],
    });
    // Same permissions → no re-prompt: an empty acceptance is enough.
    const v2 = await commitPluginPackage(inspection, {
      config: configured,
      acceptedPermissions: [],
      paths,
    });
    expect(v2).toMatchObject({ action: "update", version: "1.1.0", previousVersion: "1.0.0" });
    expect(v2.config.plugins?.entries?.["demo-plugin"]).toEqual(
      configured.plugins?.entries?.["demo-plugin"],
    );
    expect(fs.existsSync(path.join(dataDir, "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(v2.targetDir, "v1-marker.txt"))).toBe(false);
    const prev = v2.record.previous;
    expect(prev).toMatchObject({ version: "1.0.0", sha256: v1.record.sha256 });
    expect(fs.existsSync(path.join(prev!.path!, "v1-marker.txt"))).toBe(true);
    expect(loadPluginManifest(v2.targetDir)).toMatchObject({
      ok: true,
      manifest: { version: "1.1.0" },
    });
  });

  it("re-prompts only for NEW permissions", async () => {
    const paths = sandbox();
    const v1 = await install(
      paths,
      {},
      { version: "1.0.0", permissions: { network: ["a.example"] } },
    );
    const inspection = await inspect(paths, v1.config, {
      version: "1.1.0",
      permissions: { network: ["a.example", "b.example"], exec: true },
    });
    expect(inspection.newPermissions).toEqual(["exec", "network:b.example"]);
    expect(
      await codeOf(
        commitPluginPackage(inspection, { config: v1.config, acceptedPermissions: [], paths }),
      ),
    ).toBe("permissions");
    // Refused → still on 1.0.0, nothing staged.
    expect(loadPluginManifest(v1.targetDir)).toMatchObject({
      ok: true,
      manifest: { version: "1.0.0" },
    });
    expect(fs.readdirSync(paths.stagingDir)).toEqual([]);
    const v2 = await commitPluginPackage(inspection, {
      config: v1.config,
      acceptedPermissions: ["exec", "network:b.example"],
      paths,
    });
    expect(v2.record.reviewedPermissions).toEqual([
      "exec",
      "network:a.example",
      "network:b.example",
    ]);
    // A later version dropping and re-adding a seen permission does not re-prompt.
    const v3 = await inspect(paths, v2.config, { version: "1.2.0", permissions: { exec: true } });
    expect(v3.newPermissions).toEqual([]);
  });

  it("rolls back one step, and the rollback can itself be undone", async () => {
    const paths = sandbox();
    const v1 = await install(paths, {}, { version: "1.0.0" });
    const v2 = await install(paths, v1.config, { version: "2.0.0" });
    const back = rollbackPluginPackage({ id: "demo-plugin", config: v2.config, paths });
    expect(back).toMatchObject({ version: "1.0.0", from: "2.0.0", restored: "previous-package" });
    expect(loadPluginManifest(v2.targetDir)).toMatchObject({
      ok: true,
      manifest: { version: "1.0.0" },
    });
    const rec = back.config.plugins?.installs?.["demo-plugin"];
    expect(rec).toMatchObject({
      version: "1.0.0",
      sha256: v1.record.sha256,
      previous: { version: "2.0.0", sha256: v2.record.sha256 },
    });
    // Only one previous version is kept.
    expect(fs.readdirSync(path.join(paths.versionsDir, "demo-plugin"))).toHaveLength(1);
    const forward = rollbackPluginPackage({ id: "demo-plugin", config: back.config, paths });
    expect(forward.version).toBe("2.0.0");
    expect(loadPluginManifest(v2.targetDir)).toMatchObject({
      ok: true,
      manifest: { version: "2.0.0" },
    });
  });

  it("keeps only ONE previous version across successive updates", async () => {
    const paths = sandbox();
    let cur = await install(paths, {}, { version: "1.0.0" });
    for (const version of ["1.1.0", "1.2.0", "1.3.0"])
      cur = await install(paths, cur.config, { version });
    expect(fs.readdirSync(path.join(paths.versionsDir, "demo-plugin"))).toHaveLength(1);
    expect(cur.record.previous?.version).toBe("1.2.0");
  });

  it("rolling back an override returns to the bundled plugin", async () => {
    const paths = sandbox();
    const bundled: ExistingPlugin = {
      origin: "bundled",
      version: "1.0.0",
      rootDir: "/app/extensions/demo-plugin",
    };
    const inspection = await inspect(paths, {}, { version: "1.5.0" }, { extra: [bundled] });
    const res = await commitPluginPackage(inspection, {
      config: {},
      acceptedPermissions: [],
      overrideBundled: true,
      paths,
    });
    const back = rollbackPluginPackage({ id: "demo-plugin", config: res.config, paths });
    expect(back).toMatchObject({ restored: "bundled", version: "1.0.0", from: "1.5.0" });
    expect(fs.existsSync(res.targetDir)).toBe(false);
    expect(back.config.plugins?.installs?.["demo-plugin"]).toBeUndefined();
  });

  it("refuses rollback when there is nothing to go back to", async () => {
    const paths = sandbox();
    const v1 = await install(paths, {}, { version: "1.0.0" });
    expect(() => rollbackPluginPackage({ id: "demo-plugin", config: v1.config, paths })).toThrow(
      /no previous version/,
    );
    expect(() => rollbackPluginPackage({ id: "nope", config: v1.config, paths })).toThrow(
      /not installed as a package/,
    );
    const v2 = await install(paths, v1.config, { version: "2.0.0" });
    fs.rmSync(v2.record.previous!.path!, { recursive: true });
    expect(() => rollbackPluginPackage({ id: "demo-plugin", config: v2.config, paths })).toThrow(
      /no longer on disk/,
    );
  });
});

describe("failure rollback", () => {
  it("a failed extraction leaves the installed version untouched and no staging behind", async () => {
    const paths = sandbox();
    const v1 = await install(paths, {}, { version: "1.0.0" });
    const inspection = await inspect(paths, v1.config, { version: "2.0.0" });
    // Simulate a disk/zip failure mid-extract.
    inspection.zip.extractTo = async (dest: string) => {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "half-written"), "x");
      throw new Error("disk full");
    };
    await expect(
      commitPluginPackage(inspection, { config: v1.config, acceptedPermissions: [], paths }),
    ).rejects.toThrow(/disk full/);
    expect(loadPluginManifest(v1.targetDir)).toMatchObject({
      ok: true,
      manifest: { version: "1.0.0" },
    });
    expect(fs.readdirSync(paths.stagingDir)).toEqual([]);
    expect(fs.existsSync(path.join(paths.versionsDir, "demo-plugin"))).toBe(false);
  });

  it("refuses when what was extracted is not what was reviewed", async () => {
    const paths = sandbox();
    const inspection = await inspect(paths, {}, { version: "1.0.0" });
    const real = inspection.zip.extractTo.bind(inspection.zip);
    inspection.zip.extractTo = async (dest: string) => {
      const n = await real(dest);
      const file = path.join(dest, "infinibot.plugin.json");
      const m = JSON.parse(fs.readFileSync(file, "utf-8"));
      fs.writeFileSync(file, JSON.stringify({ ...m, version: "6.6.6" }));
      return n;
    };
    expect(
      await codeOf(commitPluginPackage(inspection, { config: {}, acceptedPermissions: [], paths })),
    ).toBe("manifest");
    expect(fs.existsSync(path.join(paths.extensionsDir, "demo-plugin"))).toBe(false);
    expect(fs.readdirSync(paths.stagingDir)).toEqual([]);
  });

  it("undo() restores the previous version when saving config fails afterwards", async () => {
    const paths = sandbox();
    const v1 = await install(paths, {}, { version: "1.0.0" });
    const v2 = await install(paths, v1.config, { version: "2.0.0" });
    v2.undo();
    expect(loadPluginManifest(v1.targetDir)).toMatchObject({
      ok: true,
      manifest: { version: "1.0.0" },
    });
    const fresh = sandbox();
    const only = await install(fresh, {}, { version: "1.0.0" });
    only.undo();
    expect(fs.existsSync(only.targetDir)).toBe(false);
  });

  it("refuses to replace a symlinked install folder", async () => {
    const paths = sandbox();
    const v1 = await install(paths, {}, { version: "1.0.0" });
    const real = `${v1.targetDir}-real`;
    fs.renameSync(v1.targetDir, real);
    fs.symlinkSync(real, v1.targetDir);
    const inspection = await inspect(paths, v1.config, { version: "2.0.0" });
    expect(
      await codeOf(
        commitPluginPackage(inspection, { config: v1.config, acceptedPermissions: [], paths }),
      ),
    ).toBe("collision");
    expect(loadPluginManifest(real)).toMatchObject({ ok: true, manifest: { version: "1.0.0" } });
  });
});

describe("cloud tenant policy", () => {
  const FLEET = { SAAS_MODE: "1", FLEET_TENANT_ID: "t_1" } as NodeJS.ProcessEnv;
  const registry = (firstParty: boolean): PackageSource => ({
    kind: "registry",
    registryUrl: "https://r.example",
    firstParty,
  });

  it("does not apply off-fleet", () => {
    expect(tenantInstallRefusal("anything", ZIP, NO_ENV)).toBeNull();
  });

  it("refuses third-party plugins, uploads and URLs on a tenant Machine", () => {
    expect(tenantInstallRefusal("some-third-party", registry(false), FLEET)).toMatch(
      /Third-party plugins are not available/,
    );
    expect(tenantInstallRefusal("discipline", ZIP, FLEET)).toMatch(/marketplace only/);
    expect(
      tenantInstallRefusal("discipline", { kind: "url", url: "https://x/y.zip" }, FLEET),
    ).toMatch(/marketplace only/);
    expect(tenantInstallRefusal("discipline", registry(false), FLEET)).toMatch(/marketplace only/);
  });

  it("applies cloud availability and the tenant's plan", () => {
    expect(tenantInstallRefusal("discipline", registry(true), FLEET)).toBeNull();
    expect(tenantInstallRefusal("droid-swarm", registry(true), FLEET)).toMatch(/self-hosted/);
    expect(tenantInstallRefusal("robovoice", registry(true), FLEET)).toMatch(/Coming soon/);
    // infinitrade is cloud-available but not in the starter plan.
    expect(tenantInstallRefusal("infinitrade", registry(true), FLEET)).toMatch(
      /Not included in your plan/,
    );
    const pro = { ...FLEET, FLEET_PLUGIN_POLICY: JSON.stringify({ plan: "pro", allowed: "all" }) };
    expect(tenantInstallRefusal("infinitrade", registry(true), pro)).toBeNull();
  });

  it("inspect enforces the policy before anything else is offered", async () => {
    const paths = sandbox();
    expect(await codeOf(inspect(paths, {}, {}, { env: FLEET }))).toBe("policy");
    expect(await codeOf(inspect(paths, {}, { id: "discipline" }, { env: FLEET }))).toBe("policy");
  });
});
