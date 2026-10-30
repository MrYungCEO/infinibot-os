import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ensureHostModuleFallback, hostNodeModulesDirs } from "./host-modules.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ib-host-modules-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("host module fallback for installed plugin packages", () => {
  it("finds the host's own node_modules", () => {
    const dirs = hostNodeModulesDirs();
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.some((d) => fs.existsSync(path.join(d, "@sinclair", "typebox")))).toBe(true);
  });

  it("a plugin outside the package tree resolves a host dependency, and its own copy still wins", () => {
    const pluginDir = path.join(tmp, "extensions", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const entry = path.join(pluginDir, "index.js");
    fs.writeFileSync(entry, "");
    const fromPlugin = createRequire(entry);

    const first = ensureHostModuleFallback();
    expect(ensureHostModuleFallback()).toBe(first); // idempotent
    const resolved = fromPlugin.resolve("@sinclair/typebox");
    expect(resolved).toContain(`${path.sep}node_modules${path.sep}`);
    expect(resolved.startsWith(tmp)).toBe(false);

    // The plugin's own node_modules is searched first.
    const own = path.join(pluginDir, "node_modules", "@sinclair", "typebox");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ name: "@sinclair/typebox", main: "index.js" }));
    fs.writeFileSync(path.join(own, "index.js"), "module.exports = { own: true };");
    expect(createRequire(entry).resolve("@sinclair/typebox")).toBe(fs.realpathSync(path.join(own, "index.js")));
    // A module nobody has still fails.
    expect(() => fromPlugin.resolve("definitely-not-installed-anywhere")).toThrow();
  });
});
