import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PACKAGE_MANIFEST } from "./format.js";
import { fixturePackageFiles, fixturePackageZip, zipEntries } from "./package-fixtures.js";
import {
  normalizeSha256,
  openPluginZip,
  PackageError,
  sha256OfBuffer,
  unsafeEntryReason,
} from "./zip-read.js";
import { PACKAGE_LIMITS } from "./format.js";

const temps: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-zipread-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

async function rejects(buf: Buffer, code: string, pattern: RegExp, limits = {}) {
  let err: unknown;
  try {
    await openPluginZip(buf, limits);
  } catch (e) {
    err = e;
  }
  expect(err, `expected rejection matching ${pattern}`).toBeInstanceOf(PackageError);
  expect((err as PackageError).code).toBe(code);
  expect((err as PackageError).message).toMatch(pattern);
}

/** Rewrite the declared uncompressed size of `name` (central + local header). */
function forgeUncompressedSize(zip: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(zip);
  const nameBuf = Buffer.from(name);
  let patched = 0;
  for (let i = 0; i + 46 < out.length; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x02014b50) {
      const n = out.readUInt16LE(i + 28);
      if (out.subarray(i + 46, i + 46 + n).equals(nameBuf)) {
        out.writeUInt32LE(size, i + 24);
        patched++;
      }
    } else if (sig === 0x04034b50) {
      const n = out.readUInt16LE(i + 26);
      if (out.subarray(i + 30, i + 30 + n).equals(nameBuf)) {
        out.writeUInt32LE(size, i + 22);
        patched++;
      }
    }
  }
  if (patched < 2) throw new Error("forge: entry not found");
  return out;
}

describe("openPluginZip — valid packages", () => {
  it("opens a package with the manifest at the root", async () => {
    const buf = await fixturePackageZip();
    const zip = await openPluginZip(buf);
    expect(zip.rootPrefix).toBe("");
    expect(zip.has(PACKAGE_MANIFEST)).toBe(true);
    expect(zip.sha256).toBe(sha256OfBuffer(buf));
    expect(zip.files.map((f) => f.path)).toContain("index.js");
    const manifest = JSON.parse((await zip.read(PACKAGE_MANIFEST)).toString());
    expect(manifest.id).toBe("demo-plugin");
  });

  it("accepts exactly one top-level folder and strips it", async () => {
    const zip = await openPluginZip(await fixturePackageZip({ wrapIn: "demo-plugin-0.1.0" }));
    expect(zip.rootPrefix).toBe("demo-plugin-0.1.0/");
    expect(zip.has(PACKAGE_MANIFEST)).toBe(true);
    expect(zip.files.every((f) => !f.path.startsWith("demo-plugin-0.1.0/"))).toBe(true);
  });

  it("ignores archiver junk (__MACOSX, .DS_Store)", async () => {
    const files = fixturePackageFiles();
    const buf = await zipEntries({
      ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`plug/${k}`, v])),
      "__MACOSX/plug/._index.js": "junk",
      "plug/.DS_Store": "junk",
    });
    const zip = await openPluginZip(buf);
    expect(zip.rootPrefix).toBe("plug/");
    expect(zip.has(".DS_Store")).toBe(false);
  });

  it("extracts with plain file modes into an empty folder", async () => {
    const zip = await openPluginZip(
      await fixturePackageZip({ files: { "bin/run.sh": "#!/bin/sh\necho hi\n" } }),
    );
    const dest = path.join(tempDir(), "out");
    const written = await zip.extractTo(dest);
    expect(written).toBe(zip.unpackedBytes);
    expect(fs.existsSync(path.join(dest, PACKAGE_MANIFEST))).toBe(true);
    expect(fs.statSync(path.join(dest, "bin/run.sh")).mode & 0o777).toBe(0o644);
    await expect(zip.extractTo(dest)).rejects.toThrow(/not empty/);
  });
});

describe("openPluginZip — hostile archives", () => {
  it.each([
    ["../evil.txt", /relative path segment/],
    ["a/../../evil.txt", /relative path segment/],
    ["/etc/cron.d/evil", /absolute path/],
    ["C:/Windows/evil.dll", /drive-letter/],
    ["a\\..\\evil.txt", /backslash/],
    ["a//b.txt", /empty path segment/],
    ["./a.txt", /relative path segment/],
    ["nul\u0000byte.txt", /control character/],
  ])("rejects path traversal / unsafe name %j", async (name, pattern) => {
    const buf = await zipEntries({ ...fixturePackageFiles(), [name]: "x" });
    await rejects(buf, "unsafe-path", pattern);
  });

  it("checks the ORIGINAL entry name, not JSZip's sanitised one", async () => {
    // JSZip would load "../../outside.txt" as "outside.txt"; we must still refuse.
    const buf = await zipEntries({ ...fixturePackageFiles(), "../../outside.txt": "x" });
    await rejects(buf, "unsafe-path", /outside\.txt/);
  });

  it("rejects symlinks", async () => {
    const buf = await zipEntries(
      { ...fixturePackageFiles(), "link-to-passwd": "/etc/passwd" },
      { modes: { "link-to-passwd": 0o120777 } },
    );
    await rejects(buf, "symlink", /symlinks are not allowed/);
  });

  it("rejects other special files (fifo, device)", async () => {
    const buf = await zipEntries(
      { ...fixturePackageFiles(), pipe: "" },
      { modes: { pipe: 0o010644 } },
    );
    await rejects(buf, "symlink", /special files/);
  });

  it("rejects too many files", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i++) many[`f/${i}.txt`] = "x";
    await rejects(
      await zipEntries({ ...fixturePackageFiles(), ...many }),
      "too-large",
      /(files|entries); the limit/,
      {
        maxFiles: 20,
      },
    );
  });

  it("rejects an archive over the compressed size cap", async () => {
    await rejects(await fixturePackageZip(), "too-large", /bytes; the limit/, { maxZipBytes: 100 });
  });

  it("rejects a zip bomb by compression ratio", async () => {
    const buf = await zipEntries({
      ...fixturePackageFiles(),
      "big.bin": Buffer.alloc(8 * 1024 * 1024),
    });
    expect(buf.length).toBeLessThan(200 * 1024);
    await rejects(buf, "too-large", /compression ratio/);
  });

  it("rejects when declared unpacked size exceeds the caps", async () => {
    const buf = await zipEntries({
      ...fixturePackageFiles(),
      "big.bin": Buffer.alloc(300 * 1024, 1),
    });
    await rejects(buf, "too-large", /per-file limit/, { maxFileBytes: 100 * 1024 });
    await rejects(buf, "too-large", /unpacks to more than/, { maxUnpackedBytes: 100 * 1024 });
  });

  it("cuts off an entry that inflates past its declared size (lying header)", async () => {
    const honest = await zipEntries({
      ...fixturePackageFiles(),
      "big.bin": Buffer.alloc(2 * 1024 * 1024, 7),
    });
    const forged = forgeUncompressedSize(honest, "big.bin", 16);
    const zip = await openPluginZip(forged);
    expect(zip.files.find((f) => f.path === "big.bin")?.size).toBe(16);
    const dest = path.join(tempDir(), "out");
    await expect(zip.extractTo(dest)).rejects.toThrow(/size limit|corrupt entry/);
    const leaked = fs.existsSync(path.join(dest, "big.bin"))
      ? fs.statSync(path.join(dest, "big.bin")).size
      : 0;
    expect(leaked).toBeLessThan(1024 * 1024);
  });

  it("rejects duplicate / case-colliding paths and files nested under files", async () => {
    await rejects(
      await zipEntries({ ...fixturePackageFiles(), "Index.JS": "x" }),
      "unsafe-path",
      /case-colliding/,
    );
    await rejects(
      await zipEntries({ ...fixturePackageFiles(), "ui.js/inner.js": "x" }),
      "unsafe-path",
      /nests under a file/,
    );
  });

  it("rejects a bad layout", async () => {
    const files = fixturePackageFiles();
    const two = {
      ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`a/${k}`, v])),
      "b/other.txt": "x",
    };
    await rejects(await zipEntries(two), "layout", /exactly one top-level folder/);
    await rejects(
      await zipEntries({ "a/b/infinibot.plugin.json": "{}" }),
      "layout",
      /no infinibot.plugin.json/,
    );
    await rejects(
      await zipEntries({ "readme.txt": "hi" }),
      "layout",
      /exactly one top-level folder/,
    );
  });

  it("rejects non-zip and ZIP64 input", async () => {
    await rejects(
      Buffer.from("definitely not a zip, just text ".repeat(4)),
      "bad-zip",
      /not a zip/,
    );
    await rejects(Buffer.alloc(10), "bad-zip", /not a zip/);
    const buf = Buffer.from(await fixturePackageZip());
    // Mark the entry count as "see ZIP64 record".
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    buf.writeUInt16LE(0xffff, eocd + 10);
    await rejects(buf, "too-large", /ZIP64/);
  });

  it("bounds single-file reads", async () => {
    const zip = await openPluginZip(
      await fixturePackageZip({ files: { "CHANGELOG.md": "x".repeat(5000) } }),
    );
    await expect(zip.read("CHANGELOG.md", 100)).rejects.toThrow(/size limit/);
    await expect(zip.read("missing.txt")).rejects.toThrow(/not in the package/);
  });
});

describe("helpers", () => {
  it("unsafeEntryReason covers depth and length", () => {
    expect(unsafeEntryReason("a/b/c.txt", { ...PACKAGE_LIMITS })).toBeNull();
    expect(unsafeEntryReason("a/".repeat(20) + "x", { ...PACKAGE_LIMITS })).toMatch(/too deep/);
    expect(unsafeEntryReason("x".repeat(300), { ...PACKAGE_LIMITS })).toMatch(/too long/);
  });

  it("normalizeSha256", () => {
    const hex = "a".repeat(64);
    expect(normalizeSha256(` SHA256:${hex.toUpperCase()} `)).toBe(hex);
    expect(normalizeSha256("abc")).toBeNull();
    expect(normalizeSha256(undefined)).toBeNull();
  });
});
