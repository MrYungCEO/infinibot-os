import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyHttpRoute } from "./http-auth.js";
import { resolvePluginAsset } from "./plugin-assets-http.js";
import { parseListing } from "../plugins/listing.js";

describe("plugin listing asset route", () => {
  let base = "";
  let root = "";
  let plugins: Parameters<typeof resolvePluginAsset>[1] = [];

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-assets-"));
    root = path.join(base, "demo");
    fs.mkdirSync(path.join(root, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "assets", "cover.svg"),
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
    );
    fs.writeFileSync(path.join(root, "assets", "undeclared.png"), "x");
    fs.writeFileSync(path.join(root, "index.ts"), "export default 1");
    fs.writeFileSync(path.join(base, "secret.png"), "top secret");
    // A declared screenshot that is a symlink pointing OUTSIDE the plugin.
    fs.symlinkSync(path.join(base, "secret.png"), path.join(root, "assets", "escape.png"));
    const { listing } = parseListing({
      cover: "assets/cover.svg",
      screenshots: ["assets/escape.png", "assets/missing.png"],
    });
    plugins = [{ id: "demo", rootDir: root, listing }];
  });

  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it("is a protected route (gateway credential required)", () => {
    expect(classifyHttpRoute("GET", "/api/plugin-assets/demo/assets/cover.svg")).toBe("protected");
    expect(classifyHttpRoute("HEAD", "/api/plugin-assets/demo/assets/cover.svg")).toBe("protected");
  });

  it("serves a declared asset with its image type", () => {
    const r = resolvePluginAsset("demo/assets/cover.svg", plugins);
    expect(r).toMatchObject({ ok: true, contentType: "image/svg+xml" });
  });

  it.each([
    ["demo/../secret.png"],
    ["demo/assets/../../secret.png"],
    ["demo/..%2Fsecret.png"],
    ["demo/assets%2F..%2F..%2Fsecret.png"],
    ["demo/%2E%2E/secret.png"],
    ["demo//etc/passwd"],
    ["demo/assets\\..\\..\\secret.png"],
    ["demo/%00.png"],
    ["demo/assets/cover.svg%"],
  ])("rejects traversal %s", (tail) => {
    const r = resolvePluginAsset(tail, plugins);
    expect(r.ok).toBe(false);
  });

  it("only serves files the listing declares", () => {
    expect(resolvePluginAsset("demo/assets/undeclared.png", plugins)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(resolvePluginAsset("demo/index.ts", plugins)).toMatchObject({ ok: false, status: 400 });
    expect(resolvePluginAsset("demo/assets/missing.png", plugins)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses a declared symlink that escapes the plugin folder", () => {
    expect(resolvePluginAsset("demo/assets/escape.png", plugins)).toMatchObject({
      ok: false,
      status: 404,
      reason: "outside the plugin folder",
    });
  });

  it("unknown plugin / malformed tail", () => {
    expect(resolvePluginAsset("nope/assets/cover.svg", plugins)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(resolvePluginAsset("demo", plugins)).toMatchObject({ ok: false, status: 400 });
  });
});
