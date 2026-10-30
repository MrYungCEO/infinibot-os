import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PACKAGE_MANIFEST } from "./format.js";
import { fixturePackageFiles } from "./package-fixtures.js";
import {
  collectPackFiles,
  packPluginDir,
  parseIgnoreFile,
  validatePluginDir,
  validatePluginZip,
} from "./pack.js";
import { scaffoldPluginFiles, writePluginScaffold } from "./scaffold.js";
import { openPluginZip } from "./zip-read.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const EXAMPLE_DIR = path.join(REPO_ROOT, "examples", "plugin-hello");

const temps: string[] = [];
function tempDir(prefix = "ib-pack-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

function writeFiles(dir: string, files: Record<string, string | Buffer>, order?: string[]) {
  for (const rel of order ?? Object.keys(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel] as string);
  }
}

describe("pack determinism", () => {
  it("produces identical bytes for identical contents, whatever the mtimes or write order", async () => {
    const files = fixturePackageFiles({
      files: { "lib/a.js": "export const a = 1;\n", "lib/b.js": "export const b = 2;\n" },
    });
    const one = path.join(tempDir(), "one");
    const two = path.join(tempDir(), "two");
    writeFiles(one, files);
    writeFiles(two, files, Object.keys(files).reverse());
    // Different timestamps and permissions on disk must not leak into the zip.
    for (const rel of Object.keys(files)) {
      fs.utimesSync(path.join(two, rel), new Date(2001, 1, 1), new Date(2031, 5, 5));
    }
    fs.chmodSync(path.join(two, "index.js"), 0o755);

    const a = await packPluginDir(one, { out: tempDir() });
    const b = await packPluginDir(two, { out: tempDir() });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.sha256).toBe(b.sha256);
    expect(fs.readFileSync(a.file).equals(fs.readFileSync(b.file))).toBe(true);
    expect(path.basename(a.file)).toBe("demo-plugin-0.1.0.ibplugin.zip");
    expect(fs.readFileSync(a.sha256File, "utf-8")).toBe(
      `${a.sha256}  demo-plugin-0.1.0.ibplugin.zip\n`,
    );

    // Packing again over an existing output folder changes nothing.
    const again = await packPluginDir(one, { out: path.dirname(a.file) });
    expect(again.ok && again.sha256).toBe(a.sha256);
  });

  it("changes the checksum when a byte changes", async () => {
    const dir = path.join(tempDir(), "p");
    writeFiles(dir, fixturePackageFiles());
    const a = await packPluginDir(dir, { out: tempDir() });
    fs.appendFileSync(path.join(dir, "index.js"), "\n// change\n");
    const b = await packPluginDir(dir, { out: tempDir() });
    expect(a.ok && b.ok && a.sha256 !== b.sha256).toBe(true);
  });

  it("the packed zip passes the installer's reader and validator", async () => {
    const dir = path.join(tempDir(), "p");
    writeFiles(dir, fixturePackageFiles());
    const res = await packPluginDir(dir, { out: tempDir() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const zip = await openPluginZip(fs.readFileSync(res.file));
    expect(zip.sha256).toBe(res.sha256);
    expect(zip.has(PACKAGE_MANIFEST)).toBe(true);
    const report = await validatePluginZip(res.file);
    expect(report).toMatchObject({ ok: true, sha256: res.sha256, files: res.files });
  });
});

describe("what gets packed", () => {
  it("skips VCS folders, node_modules, junk and earlier pack output; honours .ibpluginignore", () => {
    const dir = path.join(tempDir(), "p");
    writeFiles(dir, {
      ...fixturePackageFiles(),
      ".git/config": "x",
      "node_modules/dep/index.js": "x",
      ".DS_Store": "x",
      "old-0.0.1.ibplugin.zip": "x",
      "src/a.test.js": "x",
      "test/fixture.json": "{}",
      "notes/private.md": "x",
      ".ibpluginignore": "# comment\n*.test.js\ntest/\nnotes/private.md\n",
    });
    const packed = collectPackFiles(dir).map((f) => f.path);
    expect(packed).toContain("index.js");
    for (const gone of [
      ".git/config",
      "node_modules/dep/index.js",
      ".DS_Store",
      "old-0.0.1.ibplugin.zip",
      "src/a.test.js",
      "test/fixture.json",
      "notes/private.md",
      ".ibpluginignore",
    ]) {
      expect(packed, gone).not.toContain(gone);
    }
    expect(collectPackFiles(dir, { includeNodeModules: true }).map((f) => f.path)).toContain(
      "node_modules/dep/index.js",
    );
    expect([...packed]).toEqual([...packed].sort());
  });

  it("parseIgnoreFile matches folders, extensions, exact paths and bare names", () => {
    const ig = parseIgnoreFile("dist-old/\n*.map\ndocs/draft.md\nsecret.txt\n");
    expect(ig("dist-old", true)).toBe(true);
    expect(ig("dist-old", false)).toBe(false);
    expect(ig("a/b/x.map", false)).toBe(true);
    expect(ig("docs/draft.md", false)).toBe(true);
    expect(ig("deep/secret.txt", false)).toBe(true);
    expect(ig("index.js", false)).toBe(false);
  });

  it("refuses symlinks", async () => {
    const dir = path.join(tempDir(), "p");
    writeFiles(dir, fixturePackageFiles());
    fs.symlinkSync("/etc/hostname", path.join(dir, "host-link"));
    const report = validatePluginDir(dir);
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/symlinks can't be packed/);
    expect(await packPluginDir(dir, { out: tempDir() })).toMatchObject({ ok: false });
  });

  it("refuses credential-looking files and reports missing pieces", () => {
    const dir = path.join(tempDir(), "p");
    const files = fixturePackageFiles({
      files: { ".env": "TOKEN=1", "keys/server.pem": "x", "assets/icon.svg": null },
    });
    writeFiles(dir, files);
    const report = validatePluginDir(dir);
    expect(report.ok).toBe(false);
    const text = report.errors.join("\n");
    expect(text).toMatch(/\.env: looks like a credential file/);
    expect(text).toMatch(/keys\/server\.pem: looks like a credential file/);
    expect(text).toMatch(/listing asset "assets\/icon.svg" is missing/);
  });

  it("reports a missing manifest, bad JSON and a missing entry file", () => {
    const empty = tempDir();
    expect(validatePluginDir(empty).errors[0]).toMatch(/infinibot.plugin.json not found/);
    const bad = path.join(tempDir(), "p");
    writeFiles(bad, { ...fixturePackageFiles(), "infinibot.plugin.json": "{ nope" });
    expect(validatePluginDir(bad).errors[0]).toMatch(/not valid JSON/);
    const noEntry = path.join(tempDir(), "p");
    writeFiles(noEntry, fixturePackageFiles({ files: { "index.js": null } }));
    expect(validatePluginDir(noEntry).errors.join("\n")).toMatch(
      /entry file "index.js" is missing/,
    );
  });

  it("warns that dependencies are not installed", () => {
    const dir = path.join(tempDir(), "p");
    const files = fixturePackageFiles();
    const pkg = JSON.parse(files["package.json"] as string);
    pkg.dependencies = { "left-pad": "^1.0.0" };
    writeFiles(dir, { ...files, "package.json": JSON.stringify(pkg) });
    const report = validatePluginDir(dir);
    expect(report.ok).toBe(true);
    expect(report.warnings.join("\n")).toMatch(/installed without `npm install`/);
  });
});

describe("scaffold + example plugin", () => {
  it("scaffolds a plugin that validates and packs", async () => {
    const dir = path.join(tempDir(), "my-plugin");
    const written = writePluginScaffold(dir, { id: "my-plugin", publisher: "acme" });
    expect(written).toContain("infinibot.plugin.json");
    const report = validatePluginDir(dir);
    expect(report.errors).toEqual([]);
    expect(report.manifest).toMatchObject({
      id: "my-plugin",
      name: "My Plugin",
      publisher: "acme",
    });
    expect((await packPluginDir(dir, { out: tempDir() })).ok).toBe(true);
    expect(() => writePluginScaffold(dir, { id: "my-plugin" })).toThrow(/not empty/);
  });

  it("rejects bad ids", () => {
    expect(() => scaffoldPluginFiles({ id: "Bad Id" })).toThrow(/lowercase/);
    expect(() => scaffoldPluginFiles({ id: "plugins" })).toThrow(/reserved/);
    expect(() => scaffoldPluginFiles({ id: "ok-id", publisher: "Not Valid" })).toThrow(/publisher/);
  });

  it("examples/plugin-hello is exactly what `plugins create hello` writes", () => {
    const expected = scaffoldPluginFiles({
      id: "hello",
      name: "Hello",
      publisher: "infinibot-examples",
      description: "Hello — the example plugin the InfiniBot plugin docs walk through.",
    });
    const onDisk = collectPackFiles(EXAMPLE_DIR).map((f) => f.path);
    expect([...onDisk, ".ibpluginignore"].sort()).toEqual(Object.keys(expected).sort());
    for (const [rel, content] of Object.entries(expected)) {
      expect(fs.readFileSync(path.join(EXAMPLE_DIR, rel), "utf-8"), rel).toBe(content);
    }
  });

  it("examples/plugin-hello validates and packs (CI gate)", async () => {
    const report = validatePluginDir(EXAMPLE_DIR);
    expect(report.errors).toEqual([]);
    const res = await packPluginDir(EXAMPLE_DIR, { out: tempDir() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest).toMatchObject({ id: "hello", version: "0.1.0" });
    expect(path.basename(res.file)).toBe("hello-0.1.0.ibplugin.zip");
  });

  it("the example's plugin entry registers what its manifest declares", async () => {
    const mod = (await import(path.join(EXAMPLE_DIR, "index.js"))) as {
      default: { register: (api: unknown) => void };
    };
    const calls: Record<string, unknown[]> = { rpc: [], tool: [], http: [] };
    const handlers: Record<string, (o: unknown) => void> = {};
    mod.default.register({
      pluginConfig: { greeting: "Howdy" },
      logger: { info() {}, warn() {}, error() {} },
      registerGatewayMethod: (m: string, h: (o: unknown) => void) => {
        calls.rpc!.push(m);
        handlers[m] = h;
      },
      registerTool: (t: { name: string }) => calls.tool!.push(t.name),
      registerHttpRoute: (r: { path: string; publicAsset?: boolean }) =>
        calls.http!.push([r.path, r.publicAsset]),
    });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXAMPLE_DIR, "infinibot.plugin.json"), "utf-8"),
    );
    expect(calls.rpc).toEqual(manifest.contributes.rpc.map((r: { method: string }) => r.method));
    expect(calls.tool).toEqual(manifest.contributes.tools);
    expect(calls.http).toEqual([[manifest.ui.entry, true]]);
    let reply: unknown;
    handlers["hello.greet"]!({
      params: { name: "Ada" },
      respond: (_ok: boolean, payload: unknown) => (reply = payload),
    });
    expect(reply).toEqual({ message: "Howdy, Ada!" });
  });
});
