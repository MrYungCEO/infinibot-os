import { describe, expect, it } from "vitest";

import {
  isAllowedPackageUrl,
  newPermissionKeys,
  parseUpdateBlock,
  permissionKeysOf,
  resolvePackageEntries,
  validateDistributionManifest,
} from "./format.js";
import { fixturePackageFiles } from "./package-fixtures.js";

function manifest(overrides: Record<string, unknown> = {}) {
  const raw = JSON.parse(fixturePackageFiles()["infinibot.plugin.json"] as string) as Record<
    string,
    unknown
  >;
  return { ...raw, ...overrides };
}

describe("distribution manifest", () => {
  it("accepts the scaffold manifest", () => {
    const res = validateDistributionManifest(manifest());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest).toMatchObject({
      id: "demo-plugin",
      version: "0.1.0",
      publisher: "acme",
      pluginApiRange: "^2.0.0",
    });
  });

  it.each([
    ["id", undefined, /id is required/],
    ["id", "Bad_ID", /lowercase letters/],
    ["id", "plugins", /reserved/],
    ["name", "", /name is required/],
    ["version", "1.0", /must be semver/],
    ["version", undefined, /version is required/],
    ["publisher", undefined, /publisher is required/],
    ["publisher", "Acme Inc", /publisher id/],
    ["manifestVersion", 1, /manifestVersion must be 2/],
    ["minHostVersion", undefined, /minHostVersion is required/],
    ["minHostVersion", "latest", /minHostVersion .* must be semver/],
    ["configSchema", undefined, /configSchema is required/],
    ["permissions", undefined, /permissions is required/],
    ["listing", undefined, /listing is required/],
    ["listing", { tagline: "x" }, /listing.description is required/],
    ["listing", { tagline: "x", description: "y", cover: "../../etc/passwd" }, /listing.cover/],
    ["update", { registryUrl: "ftp://x" }, /update.registryUrl/],
    ["update", { nope: 1 }, /unknown field/],
    ["engines", {}, /infinibot-plugin-api/],
  ])("rejects %s = %j", (field, value, pattern) => {
    const res = validateDistributionManifest(manifest({ [field]: value }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toMatch(pattern);
  });

  it("runs the v2 contract (undeclared namespaces fail)", () => {
    const res = validateDistributionManifest(
      manifest({ contributes: { rpc: [{ method: "other.thing", scope: "read" }] } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toMatch(/must be namespaced "demo-plugin\.\*"/);
  });

  it("is not an object → one clear error", () => {
    expect(validateDistributionManifest("nope")).toMatchObject({ ok: false });
    expect(validateDistributionManifest(null)).toMatchObject({ ok: false });
  });

  it("lists permission keys and finds new ones", () => {
    const keys = permissionKeysOf({
      network: ["api.example.com"],
      exec: true,
      gated: [{ id: "orders", label: "Place orders" }],
    });
    expect(keys).toEqual(["exec", "gated:orders", "network:api.example.com"]);
    expect(newPermissionKeys(keys, ["network:api.example.com"])).toEqual(["exec", "gated:orders"]);
    expect(newPermissionKeys(keys, keys)).toEqual([]);
  });

  it("parses the update block", () => {
    expect(parseUpdateBlock(undefined)).toBeUndefined();
    expect(
      parseUpdateBlock({
        registryUrl: "https://plugins.example.com/",
        changelog: "docs/CHANGES.md",
      }),
    ).toEqual({
      registryUrl: "https://plugins.example.com",
      changelog: "docs/CHANGES.md",
    });
    expect(parseUpdateBlock({ changelog: "../x" })).toMatch(/inside the package/);
    expect(parseUpdateBlock([])).toMatch(/must be an object/);
  });

  it("allows https and loopback http only", () => {
    expect(isAllowedPackageUrl("https://example.com/a.zip")).toBe(true);
    expect(isAllowedPackageUrl("http://127.0.0.1:9/a.zip")).toBe(true);
    expect(isAllowedPackageUrl("http://localhost/a.zip")).toBe(true);
    expect(isAllowedPackageUrl("http://example.com/a.zip")).toBe(false);
    expect(isAllowedPackageUrl("https://user:pw@example.com/a.zip")).toBe(false);
    expect(isAllowedPackageUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedPackageUrl("not a url")).toBe(false);
  });

  it("resolves entry files and keeps them inside the package", () => {
    const has = (files: string[]) => (rel: string) => files.includes(rel);
    expect(resolvePackageEntries(undefined, has(["index.js"]))).toEqual(["index.js"]);
    expect(
      resolvePackageEntries(
        { infinibot: { extensions: ["./dist/main.js"] } },
        has(["dist/main.js"]),
      ),
    ).toEqual(["dist/main.js"]);
    expect(resolvePackageEntries(undefined, has(["readme.md"]))).toMatch(/no entry file/);
    expect(resolvePackageEntries({ infinibot: { extensions: ["../x.js"] } }, has([]))).toMatch(
      /inside the package/,
    );
    expect(resolvePackageEntries({ infinibot: { extensions: ["gone.js"] } }, has([]))).toMatch(
      /missing/,
    );
    expect(resolvePackageEntries({ infinibot: { extensions: [] } }, has([]))).toMatch(/non-empty/);
  });
});
